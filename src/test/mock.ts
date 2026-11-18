// `node:test`'s `mock` -- `MockTracker`, `MockFunctionContext`,
// `MockPropertyContext` and `MockTimers`, after
// `lib/internal/test_runner/mock/{mock,mock_timers}.js` of Node v25.
//
// Engine notes:
//   * Node builds a mock function as a `Proxy` over the original, with
//     `apply`/`construct`/`get` traps. A `Proxy` whose target is a function
//     is not callable in this engine, so the mock is an ordinary wrapper
//     function carrying a `mock` property. `new mockFn()` is told apart from
//     a call by `this instanceof mockFn` (there is no `new.target`), and the
//     construct path builds the instance with `Reflect.construct`.
//   * Mocked timers reach the bundle's bare `setTimeout(...)` calls through
//     `__timerMock.hooks` in src/timers/timers.ts; `globalThis.*` and the
//     `node:timers` / `node:timers/promises` objects are replaced as Node
//     does. `globalThis.Date` is replaced too, but a bare `Date` in a bundle
//     is the engine's intrinsic and cannot be redirected.

// ---------------------------------------------------------------------------
// MockFunctionContext
// ---------------------------------------------------------------------------

class MockFunctionContext {
  _calls: any;
  _mocks: any;
  _implementation: any;
  _restore: any;
  _times: any;
  constructor(implementation: any, restore: any, times: any) {
    this._calls = [];
    this._mocks = {};
    this._implementation = implementation;
    this._restore = restore;
    this._times = times;
  }
  get calls(): any {
    return this._calls.slice(0);
  }
  callCount(): number {
    return Number(this._calls.length);
  }
  mockImplementation(implementation: any): void {
    __ntValidateFunction(implementation, "implementation");
    this._implementation = implementation;
  }
  mockImplementationOnce(implementation: any, onCall?: any): void {
    __ntValidateFunction(implementation, "implementation");
    const nextCall = Number(this._calls.length);
    const call: any = onCall === undefined || onCall === null ? nextCall : onCall;
    __ntMockValidateInteger(call, "onCall", nextCall);
    this._mocks[String(call)] = implementation;
  }
  restore(): void {
    const r: any = this._restore;
    if (typeof r.methodName === "string" || typeof r.methodName === "symbol") {
      Object.defineProperty(r.object, r.methodName, r.descriptor);
    } else {
      this._implementation = r.original;
    }
  }
  resetCalls(): void {
    this._calls = [];
  }
}

function __ntMockValidateInteger(value: any, name: string, min: number): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  const n = Number(value);
  if (n !== Math.floor(n)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  if (n < min || n > 9007199254740991) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + String(min) + " && <= 9007199254740991", value);
  }
}

function __ntMockValidateTimes(value: any, name: string): void {
  if (value === Infinity) return;
  __ntMockValidateInteger(value, name, 1);
}

function __ntMockNextImpl(ctx: any): any {
  const nextCall = Number(ctx._calls.length);
  const key = String(nextCall);
  const once: any = ctx._mocks[key];
  const impl: any = once !== undefined ? once : ctx._implementation;
  if (nextCall + 1 === Number(ctx._times)) ctx.restore();
  if (once !== undefined) delete ctx._mocks[key];
  return impl;
}

// The call record's argument-list key, spelled so that the engine's textual
// scan for that word does not fire (https://github.com/UrubuCode/zun/issues/40).
const __NT_ARGS_KEY: string = "argu" + "ments";

function __ntMockSetup(tracker: any, ctx: any, original: any): any {
  const mock: any = function (this: any, ...argList: any[]): any {
    const isConstruct = this !== undefined && this !== null && typeof this === "object" && this instanceof mock;
    const fn: any = __ntMockNextImpl(ctx);
    const record: any = {
      error: undefined,
      result: undefined,
      stack: new Error(),
      target: undefined,
      this: isConstruct ? undefined : this,
    };
    record[__NT_ARGS_KEY] = argList;
    try {
      if (isConstruct) {
        let real: any = fn;
        const inner: any = fn !== null && fn !== undefined ? fn["__boxedFn"] : undefined;
        if (inner !== undefined) real = inner;
        record.result = Reflect.construct(real, argList);
        record.target = mock;
        record.this = record.result;
      } else {
        record.result = __ntCall(fn, this, argList);
      }
    } catch (err) {
      record.error = err;
      ctx._calls.push(record);
      throw err;
    }
    ctx._calls.push(record);
    return record.result;
  };
  // The mock goes out as a boxed function record (`__evBox`, see
  // tools/harness/common.ts): a bare function returned from `t.mock.fn()` --
  // a dynamic method call -- can still be called, but reading any property
  // of it (`fn.mock`) panics the interpreter
  // (https://github.com/UrubuCode/zun/issues/139). The record survives that
  // lane, stays callable and constructible, and carries `mock` itself.
  const boxed: any = __evBox(mock);
  boxed.mock = ctx;
  tracker._mocks.push(ctx);
  return boxed;
}

// ---------------------------------------------------------------------------
// MockPropertyContext
// ---------------------------------------------------------------------------

class MockPropertyContext {
  _object: any;
  _propertyName: any;
  _value: any;
  _originalValue: any;
  _descriptor: any;
  _accesses: any;
  _onceValues: any;
  constructor(object: any, propertyName: any, value: any) {
    this._onceValues = {};
    this._accesses = [];
    this._object = object;
    this._propertyName = propertyName;
    this._originalValue = object[propertyName];
    this._value = value;
    this._descriptor = Object.getOwnPropertyDescriptor(object, propertyName);
    if (this._descriptor === undefined) {
      throw new ERR_INVALID_ARG_VALUE("propertyName", propertyName, "is not a property of the object");
    }
    const self: any = this;
    Object.defineProperty(object, propertyName, {
      configurable: this._descriptor.configurable === true,
      enumerable: this._descriptor.enumerable === true,
      get(): any {
        const nextIndex = Number(self._accesses.length);
        let accessValue: any;
        const key = String(nextIndex);
        if (Object.prototype.hasOwnProperty.call(self._onceValues, key)) {
          accessValue = self._onceValues[key];
          delete self._onceValues[key];
        } else {
          accessValue = self._value;
        }
        self._accesses.push({ type: "get", value: accessValue, stack: new Error() });
        return accessValue;
      },
      set(v: any): void {
        const nextIndex = Number(self._accesses.length);
        const key = String(nextIndex);
        let accessValue: any = v;
        if (Object.prototype.hasOwnProperty.call(self._onceValues, key)) {
          accessValue = self._onceValues[key];
          delete self._onceValues[key];
        }
        self._accesses.push({ type: "set", value: accessValue, stack: new Error() });
        self._value = accessValue;
      },
    });
  }
  get accesses(): any {
    return this._accesses.slice(0);
  }
  accessCount(): number {
    return Number(this._accesses.length);
  }
  mockImplementation(value: any): void {
    this._value = value;
  }
  mockImplementationOnce(value: any, onAccess?: any): void {
    const nextAccess = Number(this._accesses.length);
    const call: any = onAccess === undefined || onAccess === null ? nextAccess : onAccess;
    __ntMockValidateInteger(call, "onAccess", nextAccess);
    this._onceValues[String(call)] = value;
  }
  resetAccesses(): void {
    this._accesses = [];
  }
  restore(): void {
    Object.defineProperty(this._object, this._propertyName, Object.assign({}, this._descriptor, {
      value: this._originalValue,
    }));
  }
}

// ---------------------------------------------------------------------------
// MockTracker
// ---------------------------------------------------------------------------

const __NT_kDefaultFunction: any = { marker: "kDefaultFunction" };

function __ntFindMethodOnPrototypeChain(instance: any, methodName: any): any {
  let host: any = instance;
  let descriptor: any;
  while (host !== null && host !== undefined) {
    descriptor = Object.getOwnPropertyDescriptor(host, methodName);
    if (descriptor !== undefined) break;
    host = Object.getPrototypeOf(host);
  }
  return descriptor;
}

// An object literal rather than a class: a class method called through an
// `any` receiver loses a returned function value
// (https://github.com/UrubuCode/zun/issues/138), and `fn()`/`method()`
// return the mock function.
function __ntNewMockTracker(): any {
  const tracker: any = {
  _mocks: [],
  _timers: undefined,
  get timers(): any {
    if (tracker._timers === undefined) tracker._timers = new MockTimers();
    return tracker._timers;
  },
  fn(original?: any, implementation?: any, options?: any): any {
    let orig: any = original;
    let impl: any = implementation;
    let opts: any = options;
    if (orig === undefined) orig = function (...args: any[]): any { return undefined; };
    if (orig !== null && typeof orig === "object" && orig["__boxedFn"] === undefined) {
      opts = orig;
      orig = function (...args: any[]): any { return undefined; };
      impl = orig;
    } else if (impl !== null && impl !== undefined && typeof impl === "object" && impl["__boxedFn"] === undefined) {
      opts = impl;
      impl = orig;
    }
    if (impl === undefined) impl = orig;
    if (opts === undefined) opts = {};
    __ntValidateFunction(orig, "original");
    __ntValidateFunction(impl, "implementation");
    __ntValidateObject(opts, "options");
    const times: any = opts.times === undefined ? Infinity : opts.times;
    __ntMockValidateTimes(times, "options.times");
    const ctx = new MockFunctionContext(impl, { original: orig }, times);
    return __ntMockSetup(tracker, ctx, orig);
  },
  method(objectOrFunction: any, methodName: any, implementation?: any, options?: any): any {
    if (typeof methodName !== "string" && typeof methodName !== "symbol") {
      throw new ERR_INVALID_ARG_TYPE("methodName", ["string", "symbol"], methodName);
    }
    if (typeof objectOrFunction !== "function") __ntValidateObject(objectOrFunction, "object");
    let impl: any = implementation === undefined ? __NT_kDefaultFunction : implementation;
    let opts: any = options === undefined ? {} : options;
    if (impl !== null && typeof impl === "object" && impl !== __NT_kDefaultFunction && impl["__boxedFn"] === undefined) {
      opts = impl;
      impl = __NT_kDefaultFunction;
    }
    if (impl !== __NT_kDefaultFunction) __ntValidateFunction(impl, "implementation");
    __ntValidateObject(opts, "options");
    const getter: any = opts.getter === undefined ? false : opts.getter;
    const setter: any = opts.setter === undefined ? false : opts.setter;
    const times: any = opts.times === undefined ? Infinity : opts.times;
    if (typeof getter !== "boolean") throw new ERR_INVALID_ARG_TYPE("options.getter", "boolean", getter);
    if (typeof setter !== "boolean") throw new ERR_INVALID_ARG_TYPE("options.setter", "boolean", setter);
    __ntMockValidateTimes(times, "options.times");
    if (setter && getter) {
      throw new ERR_INVALID_ARG_VALUE("options.setter", setter, "cannot be used with 'options.getter'");
    }
    const descriptor: any = __ntFindMethodOnPrototypeChain(objectOrFunction, methodName);
    let original: any;
    if (descriptor !== undefined) {
      if (getter) original = descriptor.get;
      else if (setter) original = descriptor.set;
      else original = descriptor.value;
    }
    if (!__ntIsFn(original)) {
      throw new ERR_INVALID_ARG_VALUE("methodName", original, "must be a method");
    }
    const restore: any = { descriptor: descriptor, object: objectOrFunction, methodName: methodName };
    const realImpl: any = impl === __NT_kDefaultFunction ? original : impl;
    const ctx = new MockFunctionContext(realImpl, restore, times);
    const mock: any = __ntMockSetup(tracker, ctx, original);
    const mockDescriptor: any = {
      configurable: descriptor.configurable === true,
      enumerable: descriptor.enumerable === true,
    };
    if (getter) {
      mockDescriptor.get = mock;
      mockDescriptor.set = descriptor.set;
    } else if (setter) {
      mockDescriptor.get = descriptor.get;
      mockDescriptor.set = mock;
    } else {
      mockDescriptor.writable = descriptor.writable === true;
      mockDescriptor.value = mock;
    }
    Object.defineProperty(objectOrFunction, methodName, mockDescriptor);
    return mock;
  },
  getter(object: any, methodName: any, implementation?: any, options?: any): any {
    let impl: any = implementation;
    let opts: any = options === undefined ? {} : options;
    if (impl !== null && impl !== undefined && typeof impl === "object" && impl["__boxedFn"] === undefined) {
      opts = impl;
      impl = undefined;
    } else {
      __ntValidateObject(opts, "options");
    }
    const getter: any = opts.getter === undefined ? true : opts.getter;
    if (getter === false) throw new ERR_INVALID_ARG_VALUE("options.getter", getter, "cannot be false");
    return tracker.method(object, methodName, impl, Object.assign({}, opts, { getter: getter }));
  },
  setter(object: any, methodName: any, implementation?: any, options?: any): any {
    let impl: any = implementation;
    let opts: any = options === undefined ? {} : options;
    if (impl !== null && impl !== undefined && typeof impl === "object" && impl["__boxedFn"] === undefined) {
      opts = impl;
      impl = undefined;
    } else {
      __ntValidateObject(opts, "options");
    }
    const setter: any = opts.setter === undefined ? true : opts.setter;
    if (setter === false) throw new ERR_INVALID_ARG_VALUE("options.setter", setter, "cannot be false");
    return tracker.method(object, methodName, impl, Object.assign({}, opts, { setter: setter }));
  },
  property(object: any, propertyName: any, value?: any): any {
    __ntValidateObject(object, "object");
    if (typeof propertyName !== "string" && typeof propertyName !== "symbol") {
      throw new ERR_INVALID_ARG_TYPE("propertyName", ["string", "symbol"], propertyName);
    }
    const ctx: any = new MockPropertyContext(object, propertyName, value);
    tracker._mocks.push(ctx);
    return new Proxy(object, {
      get(target: any, prop: any, receiver: any): any {
        if (prop === "mock") return ctx;
        return target[prop];
      },
    });
  },
  module(specifier: any, options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("mock.module()");
  },
  reset(): void {
    tracker.restoreAll();
    if (tracker._timers !== undefined) tracker._timers.reset();
    tracker._mocks = [];
  },
  restoreAll(): void {
    const list: any[] = tracker._mocks;
    const n = Number(list.length);
    for (let i = 0; i < n; i++) list[i].restore();
  },
  };
  return tracker;
}


// ---------------------------------------------------------------------------
// MockTimers
// ---------------------------------------------------------------------------

const __NT_SUPPORTED_TIMER_APIS: string[] = ["setTimeout", "setInterval", "setImmediate", "Date", "scheduler.wait"];

// `validateAbortSignal`: an object with the AbortSignal surface.
function __ntMockIsAbortSignal(signal: any): boolean {
  if (signal === null || typeof signal !== "object") return false;
  return typeof signal.aborted === "boolean" && __ntIsFn(signal.addEventListener);
}

class __NtMockTimeout {
  id: any;
  callback: any;
  runAt: any;
  interval: any;
  args: any;
  queued: boolean;
  _ref: boolean;
  constructor(id: any, callback: any, runAt: any, interval: any, args: any[]) {
    this.id = id;
    this.callback = callback;
    this.runAt = runAt;
    this.interval = interval;
    this.args = args;
    this.queued = true;
    this._ref = true;
  }
  hasRef(): boolean {
    return this._ref;
  }
  ref(): any {
    this._ref = true;
    return this;
  }
  unref(): any {
    this._ref = false;
    return this;
  }
  refresh(): any {
    return this;
  }
}

function __ntCreateMockDate(self: any): any {
  const NativeDate: any = self._nativeDate;
  if (NativeDate !== undefined && NativeDate !== null && NativeDate.isMock === true) {
    throw new NodeError("ERR_INVALID_STATE", "Invalid state: Date is already being mocked!");
  }
  const MockDate: any = function (this: any, ...args: any[]): any {
    const isNew = this !== undefined && this !== null && typeof this === "object" && this instanceof MockDate;
    if (!isNew) return String(new NativeDate(self._now));
    const n = Number(args.length);
    if (n === 0) return new NativeDate(self._now);
    if (n === 1) return new NativeDate(args[0]);
    if (n === 2) return new NativeDate(args[0], args[1]);
    if (n === 3) return new NativeDate(args[0], args[1], args[2]);
    if (n === 4) return new NativeDate(args[0], args[1], args[2], args[3]);
    if (n === 5) return new NativeDate(args[0], args[1], args[2], args[3], args[4]);
    if (n === 6) return new NativeDate(args[0], args[1], args[2], args[3], args[4], args[5]);
    return new NativeDate(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
  };
  MockDate.now = function (...a: any[]): any {
    return self._now;
  };
  MockDate.toString = function (...a: any[]): any {
    return "function Date() { [native code] }";
  };
  MockDate.isMock = true;
  try {
    MockDate.prototype = NativeDate.prototype;
  } catch (e) {}
  MockDate.parse = NativeDate.parse;
  MockDate.UTC = NativeDate.UTC;
  return MockDate;
}

class MockTimers {
  _enabled: boolean;
  _apis: any;
  _now: number;
  _current: number;
  _queue: any;
  _saved: any;
  _nativeDate: any;
  constructor() {
    this._enabled = false;
    this._apis = [];
    this._now = 0;
    this._current = 1;
    this._queue = [];
    this._saved = {};
    this._nativeDate = undefined;
  }

  _insert(timer: any): void {
    const q: any[] = this._queue;
    let i = Number(q.length);
    while (i > 0) {
      const prev: any = q[i - 1];
      if (Number(prev.runAt) < Number(timer.runAt) ||
        (Number(prev.runAt) === Number(timer.runAt) && Number(prev.id) < Number(timer.id))) break;
      i--;
    }
    q.splice(i, 0, timer);
    timer.queued = true;
  }

  _remove(timer: any): void {
    const q: any[] = this._queue;
    const i = q.indexOf(timer);
    if (i !== -1) q.splice(i, 1);
    timer.queued = false;
  }

  _createTimer(isInterval: boolean, callback: any, delay: any, args: any[]): any {
    let d: number = Number(delay);
    if (d !== d) d = 0;
    if (d > 2147483647) d = 1;
    const id = this._current;
    this._current = id + 1;
    const timer: any = new __NtMockTimeout(id, callback, this._now + d, isInterval ? d : undefined, args);
    this._insert(timer);
    return timer;
  }

  _clearTimer(timer: any): void {
    if (timer === null || timer === undefined || typeof timer !== "object") return;
    if (timer.queued === true) {
      this._remove(timer);
      timer.interval = undefined;
    }
  }

  _assertEnabled(): void {
    if (!this._enabled) {
      throw new NodeError("ERR_INVALID_STATE", "Invalid state: You should enable MockTimers first by calling the .enable function");
    }
  }

  _assertTimeArg(time: any): void {
    if (Number(time) < 0) throw new ERR_INVALID_ARG_VALUE("time", "positive integer", String(time));
  }

  _promisify(isImmediate: boolean, ms: any, result: any, options: any): any {
    const self: any = this;
    return new Promise((resolve: any, reject: any) => {
      const signal: any = options !== undefined && options !== null ? options.signal : undefined;
      if (signal !== undefined && signal !== null) {
        if (!__ntMockIsAbortSignal(signal)) {
          reject(new ERR_INVALID_ARG_TYPE("options.signal", "AbortSignal", signal));
          return;
        }
        if (signal.aborted) {
          reject(new AbortError(undefined, { cause: signal.reason }));
          return;
        }
      }
      const timer: any = self._createTimer(false, (...a: any[]) => resolve(result), isImmediate ? -1 : ms, []);
      if (signal !== undefined && signal !== null) {
        signal.addEventListener("abort", () => {
          self._clearTimer(timer);
          reject(new AbortError(undefined, { cause: signal.reason }));
        });
      }
    });
  }


  _toggle(activate: boolean): void {
    const self: any = this;
    const g: any = globalThis;
    const timersObj: any = __node_timers;
    const promisesObj: any = __node_timers_promises;
    const hooks: any = activate ? (__timerMock.hooks === null ? {} : __timerMock.hooks) : __timerMock.hooks;
    for (const api of this._apis) {
      const name = String(api);
      if (activate) {
        if (name === "setTimeout") {
          const st: any = (cb: any, ms?: any, ...args: any[]): any => self._createTimer(false, cb, ms, args);
          const ct: any = (t?: any): void => { self._clearTimer(t); };
          this._saved.setTimeout = [g.setTimeout, g.clearTimeout, timersObj.setTimeout, timersObj.clearTimeout, promisesObj.setTimeout];
          g.setTimeout = st;
          g.clearTimeout = ct;
          timersObj.setTimeout = st;
          timersObj.clearTimeout = ct;
          promisesObj.setTimeout = (ms?: any, result?: any, options?: any): any => self._promisify(false, ms, result, options);
          hooks.setTimeout = st;
          hooks.clearTimeout = ct;
        } else if (name === "setInterval") {
          const si: any = (cb: any, ms?: any, ...args: any[]): any => self._createTimer(true, cb, ms, args);
          const ci: any = (t?: any): void => { self._clearTimer(t); };
          this._saved.setInterval = [g.setInterval, g.clearInterval, timersObj.setInterval, timersObj.clearInterval, promisesObj.setInterval];
          g.setInterval = si;
          g.clearInterval = ci;
          timersObj.setInterval = si;
          timersObj.clearInterval = ci;
          promisesObj.setInterval = (ms?: any, result?: any, options?: any): any => self._intervalIterator(ms, result, options);
          hooks.setInterval = si;
          hooks.clearInterval = ci;
        } else if (name === "setImmediate") {
          const sm: any = (cb: any, ...args: any[]): any => self._createTimer(false, cb, -1, args);
          const cm: any = (t?: any): void => { self._clearTimer(t); };
          this._saved.setImmediate = [g.setImmediate, g.clearImmediate, timersObj.setImmediate, timersObj.clearImmediate, promisesObj.setImmediate];
          g.setImmediate = sm;
          g.clearImmediate = cm;
          timersObj.setImmediate = sm;
          timersObj.clearImmediate = cm;
          promisesObj.setImmediate = (result?: any, options?: any): any => self._promisify(true, -1, result, options);
          hooks.setImmediate = sm;
          hooks.clearImmediate = cm;
        } else if (name === "scheduler.wait") {
          this._saved.schedulerWait = promisesObj.scheduler.wait;
          promisesObj.scheduler.wait = (delay?: any, options?: any): any => self._promisify(false, delay, undefined, options);
        } else if (name === "Date") {
          this._nativeDate = g.Date;
          g.Date = __ntCreateMockDate(this);
        }
      } else {
        if (name === "setTimeout") {
          const s: any[] = this._saved.setTimeout;
          g.setTimeout = s[0];
          g.clearTimeout = s[1];
          timersObj.setTimeout = s[2];
          timersObj.clearTimeout = s[3];
          promisesObj.setTimeout = s[4];
          if (hooks !== null) {
            delete hooks.setTimeout;
            delete hooks.clearTimeout;
          }
        } else if (name === "setInterval") {
          const s: any[] = this._saved.setInterval;
          g.setInterval = s[0];
          g.clearInterval = s[1];
          timersObj.setInterval = s[2];
          timersObj.clearInterval = s[3];
          promisesObj.setInterval = s[4];
          if (hooks !== null) {
            delete hooks.setInterval;
            delete hooks.clearInterval;
          }
        } else if (name === "setImmediate") {
          const s: any[] = this._saved.setImmediate;
          g.setImmediate = s[0];
          g.clearImmediate = s[1];
          timersObj.setImmediate = s[2];
          timersObj.clearImmediate = s[3];
          promisesObj.setImmediate = s[4];
          if (hooks !== null) {
            delete hooks.setImmediate;
            delete hooks.clearImmediate;
          }
        } else if (name === "scheduler.wait") {
          promisesObj.scheduler.wait = this._saved.schedulerWait;
        } else if (name === "Date") {
          g.Date = this._nativeDate;
        }
      }
    }
    if (activate) {
      __timerMock.hooks = hooks;
    } else if (hooks !== null && Number(Object.keys(hooks).length) === 0) {
      __timerMock.hooks = null;
    }
    this._enabled = activate;
  }

  _intervalIterator(ms: any, result: any, options: any): any {
    const self: any = this;
    const state: any = { pending: 0, waiters: [], done: false, error: undefined };
    const signal: any = options !== undefined && options !== null ? options.signal : undefined;
    const timer: any = self._createTimer(true, (...a: any[]) => {
      if (Number(state.waiters.length) > 0) {
        const w: any = state.waiters.shift();
        w.resolve({ value: result, done: false });
      } else {
        state.pending = Number(state.pending) + 1;
      }
    }, ms, []);
    const fail = (err: any): void => {
      state.error = err;
      state.done = true;
      self._clearTimer(timer);
      while (Number(state.waiters.length) > 0) state.waiters.shift().reject(err);
    };
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) fail(new AbortError(undefined, { cause: signal.reason }));
      else signal.addEventListener("abort", () => fail(new AbortError(undefined, { cause: signal.reason })));
    }
    const iterator: any = {
      next(): any {
        if (state.error !== undefined) {
          const err: any = state.error;
          state.error = undefined;
          return Promise.reject(err);
        }
        if (state.done) return Promise.resolve({ value: undefined, done: true });
        if (Number(state.pending) > 0) {
          state.pending = Number(state.pending) - 1;
          return Promise.resolve({ value: result, done: false });
        }
        return new Promise((resolve: any, reject: any) => {
          state.waiters.push({ resolve: resolve, reject: reject });
        });
      },
      return(): any {
        state.done = true;
        self._clearTimer(timer);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    iterator[Symbol.asyncIterator] = function (...a: any[]): any {
      return iterator;
    };
    return iterator;
  }

  tick(time?: any): void {
    const t: any = time === undefined ? 1 : time;
    this._assertEnabled();
    this._assertTimeArg(t);
    this._now = this._now + Number(t);
    let timer: any = this._queue[0];
    while (timer !== undefined) {
      if (Number(timer.runAt) > this._now) break;
      __ntCall(timer.callback, undefined, timer.args);
      const after: any = this._queue[0];
      if (after !== undefined && after === timer) {
        this._queue.shift();
        timer.queued = false;
      }
      if (timer.interval !== undefined) {
        timer.runAt = Number(timer.runAt) + Number(timer.interval);
        this._insert(timer);
      }
      timer = this._queue[0];
    }
  }

  enable(options?: any): void {
    const opts: any = options === undefined || options === null ? {} : Object.assign({}, options);
    if (this._enabled) {
      throw new NodeError("ERR_INVALID_STATE", "Invalid state: MockTimers is already enabled!");
    }
    if (typeof opts.now === "number" && opts.now !== opts.now) {
      throw new ERR_INVALID_ARG_VALUE("now", opts.now, "epoch must be a positive integer received " + String(opts.now));
    }
    if (!opts.now) opts.now = 0;
    if (!opts.apis) opts.apis = __NT_SUPPORTED_TIMER_APIS;
    if (!Array.isArray(opts.apis)) throw new ERR_INVALID_ARG_TYPE("options.apis", "Array", opts.apis);
    const apis: any[] = opts.apis;
    for (let i = 0; i < Number(apis.length); i++) {
      if (typeof apis[i] !== "string") {
        throw new ERR_INVALID_ARG_TYPE("options.apis[" + String(i) + "]", "string", apis[i]);
      }
    }
    for (const api of apis) {
      if (__NT_SUPPORTED_TIMER_APIS.indexOf(String(api)) === -1) {
        throw new ERR_INVALID_ARG_VALUE("options.apis", api, "option " + String(api) + " is not supported");
      }
    }
    this._apis = apis.slice(0);
    const now: any = opts.now;
    if (now !== null && typeof now === "object" && typeof now.getTime === "function") {
      this._now = Number(now.getTime());
    } else {
      if (typeof now !== "number") throw new ERR_INVALID_ARG_TYPE("initialTime", "number", now);
      this._assertTimeArg(now);
      this._now = Number(now);
    }
    this._toggle(true);
  }

  setTime(time?: any): void {
    const t: any = time === undefined ? 0 : time;
    if (typeof t !== "number") throw new ERR_INVALID_ARG_TYPE("time", "number", t);
    this._assertTimeArg(t);
    this._assertEnabled();
    this._now = Number(t);
  }

  reset(): void {
    if (!this._enabled) return;
    this._toggle(false);
    this._apis = [];
    this._now = 0;
    this._queue = [];
  }

  runAll(): void {
    this._assertEnabled();
    const q: any[] = this._queue;
    if (Number(q.length) === 0) return;
    let longest: any = q[0];
    for (const t of q) if (Number(t.runAt) >= Number(longest.runAt)) longest = t;
    this.tick(Number(longest.runAt) - this._now);
  }
}

try {
  const dispose: any = (Symbol as any).dispose;
  if (dispose !== undefined) {
    (MockTimers.prototype as any)[dispose] = function (this: any, ...a: any[]): any {
      this.reset();
      return undefined;
    };
  }
} catch (e) {}

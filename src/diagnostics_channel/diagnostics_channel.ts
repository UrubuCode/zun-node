// node:diagnostics_channel — named publish/subscribe channels and tracing
// channels, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module follows the algorithms in
// Node's `lib/diagnostics_channel.js` (MIT, Copyright Joyent, Inc. and other
// Node contributors), because the observable details — the copy-on-write
// subscriber list, the "reaching zero subscribers does not delete the channel"
// rule, the order in which `bindStore` transforms nest, the exact publish order
// of a `TracingChannel`'s five sub-channels, and the fact that a throwing
// subscriber is re-raised as an *uncaught exception on the next tick* rather
// than propagated to the publisher — are not derivable from the documentation.
//
// It is pure computation (PLAN.md principle 2): channels are a map, a list and
// a few calls, with no syscall anywhere, so it is Zun TypeScript rather than a
// `zun_abi` extension. Its one dependency outside this library's own `events`
// and `process` is `AsyncLocalStorage`, which `bindStore`/`runStores` are
// defined in terms of; the slice of `node:async_hooks` that provides it lives in
// ../async_hooks/async_hooks.ts (PLAN.md principle 4) and documents the
// async-propagation gap it has.
//
// ---------------------------------------------------------------------------
// Shapes that differ from Node's source, and why
// ---------------------------------------------------------------------------
//
// * **No prototype swap.** Node keeps two classes, `Channel` and
//   `ActiveChannel`, and moves an instance between them with
//   `ObjectSetPrototypeOf` so that an unsubscribed channel's `publish` is an
//   empty function on a "fast prototype". This engine has no
//   function-constructor/prototype model to move an object between
//   (https://github.com/UrubuCode/zun/issues/25), so there is one `Channel`
//   class whose methods branch on `_subscribers === undefined` — which is
//   exactly the predicate the prototype swap encodes. `markActive` and
//   `maybeMarkInactive` are kept as the same two functions over that field
//   pair, so the state machine reads the same as Node's. The observable
//   consequences are identical, `hasSubscribers` included: an *active* channel
//   answers `true` even when its only registration is a bound store, which is
//   what `TracingChannel.traceSync` relies on.
//
// * **`Symbol.hasInstance` is not needed.** Node defines it on `Channel` so
//   that an instance whose prototype was swapped to `ActiveChannel` still
//   answers `instanceof Channel`. With one class, the built-in `instanceof`
//   already answers `true` for every channel — and the corpus checks exactly
//   that (`test-diagnostics-channel-pub-sub.js` asserts it before *and* after
//   subscribing).
//
// * **Weak channel references, pruned on access rather than by a finalizer.**
//   Node's channel map holds a `WeakReference` per channel plus a refcount that
//   makes the reference strong while the channel has subscribers or bound
//   stores, and a `FinalizationRegistry` deletes the map entry once the channel
//   is collected. Both halves exist here, with one substitution: `WeakRef`
//   keeps its methods only through a **declared, typed field** (the same
//   reference read back out of an `any` slot has no `deref` — the zun#7 family
//   of bug), so it is held inside `__DcWeakRef`; and
//   `FinalizationRegistry.register` resolves only where the receiver's static
//   type is known at the call site, which a module-level `const` stops being as
//   soon as the call moves inside a function, so there is no finalizer. A dead
//   entry is therefore dropped the next time the map is asked about that name,
//   which is observationally the same thing — Node's own comment says only GC
//   is a valid time to clean up the map, and nothing can observe an entry whose
//   channel has already been collected.
//
// Engine notes (https://github.com/UrubuCode/zun/issues):
//   * `this` is **not** threaded into a subscriber, a traced function or a
//     `runStores` callback. `apply`, `call` and `bind` all fail to bind a
//     receiver on a function *value* and additionally shift the argument list
//     (`f.apply(recv, [a, b])` arrives as `f(recv, a)`) — zun#1 — so every call
//     here goes through `__evCall`, which is `fn(...args)`. Node's
//     `runStores(data, fn, thisArg, ...args)` and the three `trace*` methods all
//     promise `thisArg` as the receiver; that promise cannot be kept, and it is
//     the single blocker behind six of Node's own tests for this module (see
//     ../../test/diagnostics_channel/README.md). The `thisArg` parameter is
//     still accepted and still positional, so argument forwarding is correct.
//   * every callable that is stored — a subscriber in the subscriber list, a
//     `bindStore` transform in the store map, the wrapper a `trace*` method
//     hands to `runStores` — is routed through `__evBox` first, because a bare
//     function loses its identity to `indexOf` and its own properties on the
//     way into an array (zun#17). `__evSame` compares through the box, which is
//     what makes `unsubscribe(fn)` find the subscriber `subscribe(fn)` stored.
//   * `Number(x.length)` throughout: `.length` is typed `u64` at the type level
//     (zun#3).
//   * the errors are `events`' declared `NodeTypeError` subclasses, never a
//     plain error with `code` attached through an `any` alias (zun#37).

// ---------------------------------------------------------------------------
// The channel map
// ---------------------------------------------------------------------------

// A `WeakRef` whose methods survive, because the reference itself lives in a
// field with a declared `WeakRef` type. Read through an `any` alias the same
// object's `deref` reads back `undefined`, so every weak read in this file goes
// through this wrapper's method.
class __DcWeakRef {
  target: WeakRef;
  constructor(target: any) {
    this.target = new WeakRef(target);
  }
  get(): any {
    return this.target.deref();
  }
}

// One entry of the channel map: the weak reference, the refcount Node's
// `WeakReference` carries, and the strong reference that refcount implies.
class __DcChannelEntry {
  weak: any = undefined;
  strong: any = undefined;
  refs: number = 0;
  constructor(channel: any) {
    this.weak = new __DcWeakRef(channel);
  }
}

const __dcChannels: any = new Map();

// `channels.get(name)`, with Node's finalizer replaced by a prune-on-read: an
// entry whose channel has been collected is deleted here instead of from a
// `FinalizationRegistry` callback.
function __dcChannelsGet(name: any): any {
  const entry: any = __dcChannels.get(name);
  if (entry === undefined || entry === null) return undefined;
  if (entry.strong !== undefined && entry.strong !== null) return entry.strong;
  const alive: any = entry.weak.get();
  if (alive === undefined || alive === null) {
    __dcChannels.delete(name);
    return undefined;
  }
  return alive;
}

function __dcChannelsSet(name: any, created: any): void {
  __dcChannels.set(name, new __DcChannelEntry(created));
}

// `incRef`/`decRef`. A channel with at least one subscriber or bound store is
// held strongly, so it cannot be collected while something is listening; back at
// zero the strong reference is dropped but the *entry* stays, which is the rule
// Node spells out — another `subscribe` on the same name must find the same
// channel object while that object is still alive.
function __dcChannelsIncRef(name: any): void {
  const entry: any = __dcChannels.get(name);
  if (entry === undefined || entry === null) return;
  entry.refs = Number(entry.refs) + 1;
  if (entry.strong === undefined || entry.strong === null) {
    entry.strong = entry.weak.get();
  }
}

function __dcChannelsDecRef(name: any): void {
  const entry: any = __dcChannels.get(name);
  if (entry === undefined || entry === null) return;
  entry.refs = Number(entry.refs) - 1;
  if (Number(entry.refs) <= 0) {
    entry.refs = 0;
    entry.strong = undefined;
  }
}

// ---------------------------------------------------------------------------
// A throwing subscriber
// ---------------------------------------------------------------------------

// Node contains the error and re-raises it as an uncaught exception on the next
// tick (`triggerUncaughtException(err, false)`), so one bad subscriber neither
// stops the publish nor reaches the publisher. `process.nextTick` is the same
// deferral; the raise itself is `process.on('uncaughtException')` when a handler
// is installed, and otherwise the report Node prints before exiting non-zero.
function __dcDeferUncaught(error: any): void {
  process.nextTick(__dcTriggerUncaught, error);
}

function __dcTriggerUncaught(error: any): void {
  if (Number(process.listenerCount("uncaughtException")) > 0) {
    process.emit("uncaughtException", error);
    return;
  }
  const described: string =
    error !== null && error !== undefined && typeof error === "object"
      ? String(error.stack === undefined ? error.message : error.stack)
      : String(error);
  process.stderr.write("Uncaught " + described + "\n");
  process.exitCode = 1;
}

// `if (err)` and friends. `!x` on an `any` holding an empty string is
// unreliable (https://github.com/UrubuCode/zun/issues/13), so truthiness is
// spelled out.
function __dcTruthy(value: any): boolean {
  if (value === undefined || value === null) return false;
  if (value === false) return false;
  if (value === 0) return false;
  if (value === "") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

// Node's `markActive`: the channel gains a subscriber list and a store map.
function __dcMarkActive(target: any): void {
  target._subscribers = [];
  target._stores = new Map();
}

// Node's `maybeMarkInactive`: with nothing subscribed and nothing bound, the
// channel goes back to its inactive shape, which is what makes `hasSubscribers`
// answer `false` and `publish` a no-op again.
function __dcMaybeMarkInactive(target: any): void {
  if (
    Number(target._subscribers.length) === 0 &&
    Number(target._stores.size) === 0
  ) {
    target._subscribers = undefined;
    target._stores = undefined;
  }
}

class Channel {
  name: any = undefined;
  _subscribers: any = undefined;
  _stores: any = undefined;

  constructor(name: any) {
    this.name = name;
    __dcChannelsSet(name, this);
  }

  get hasSubscribers(): boolean {
    return this._subscribers !== undefined;
  }

  // Node validates *after* the prototype swap, so a rejected subscription
  // leaves the channel active; the order is kept.
  subscribe(subscription: any): void {
    if (this._subscribers === undefined) __dcMarkActive(this);
    if (!__evIsFn(subscription)) {
      throw new ERR_INVALID_ARG_TYPE("subscription", "function", subscription);
    }
    // Copy-on-write, as in Node: a publish in progress iterates the array it
    // captured, so subscribing or unsubscribing from inside a subscriber cannot
    // change the list that publish is walking.
    const next: any[] = [];
    const current: any = this._subscribers;
    const count = Number(current.length);
    for (let i = 0; i < count; i++) next.push(current[i]);
    next.push(__evBox(subscription));
    this._subscribers = next;
    __dcChannelsIncRef(this.name);
  }

  unsubscribe(subscription: any): boolean {
    if (this._subscribers === undefined) return false;
    const current: any = this._subscribers;
    const count = Number(current.length);
    let index = -1;
    for (let i = 0; i < count; i++) {
      if (__evSame(current[i], subscription)) {
        index = i;
        break;
      }
    }
    if (index === -1) return false;
    const next: any[] = [];
    for (let i = 0; i < count; i++) {
      if (i !== index) next.push(current[i]);
    }
    this._subscribers = next;
    __dcChannelsDecRef(this.name);
    __dcMaybeMarkInactive(this);
    return true;
  }

  bindStore(store: any, transform?: any): void {
    if (this._subscribers === undefined) __dcMarkActive(this);
    const replacing: boolean = this._stores.has(store) === true;
    if (!replacing) __dcChannelsIncRef(this.name);
    this._stores.set(
      store,
      transform === undefined || transform === null ? undefined : __evBox(transform),
    );
  }

  unbindStore(store: any): boolean {
    if (this._stores === undefined) return false;
    if (this._stores.has(store) !== true) return false;
    this._stores.delete(store);
    __dcChannelsDecRef(this.name);
    __dcMaybeMarkInactive(this);
    return true;
  }

  publish(data?: any): void {
    const subscribers: any = this._subscribers;
    if (subscribers === undefined) return;
    const count = Number(subscribers.length);
    for (let i = 0; i < count; i++) {
      try {
        __evCall(subscribers[i], [data, this.name]);
      } catch (error) {
        __dcDeferUncaught(error);
      }
    }
  }

  // `runStores(data, fn, thisArg, ...args)`: publish `data` and call `fn` with
  // every bound store entered. `thisArg` is accepted positionally and ignored as
  // a receiver (zun#1); the arguments after it are forwarded exactly.
  runStores(data: any, fn: any, thisArg?: any, ...args: any[]): any {
    const passed: any[] = __alsSpread(args);
    if (this._stores === undefined) return __evCall(fn, passed);
    const self: any = this;
    // The innermost run: publish inside every store, then the callback — so a
    // subscriber sees the stores already set, which is what
    // `test-diagnostics-channel-bind-store.js` asserts.
    let run: any = __evBox(function (): any {
      self.publish(data);
      return __evCall(fn, passed);
    });
    for (const entry of self._stores.entries()) {
      run = __dcWrapStoreRun(entry[0], data, run, entry[1]);
    }
    return __evCall(run, []);
  }
}

// Node's `wrapStoreRun`: one store's `run()` around the rest of the chain. A
// transform that throws is contained and reported on the next tick, and the
// chain continues *without* entering that store.
function __dcWrapStoreRun(store: any, data: any, next: any, transform: any): any {
  return __evBox(function (): any {
    let context: any = data;
    if (transform !== undefined && transform !== null) {
      let transformed: boolean = true;
      try {
        context = __evCall(transform, [data]);
      } catch (error) {
        __dcDeferUncaught(error);
        transformed = false;
      }
      if (!transformed) return __evCall(next, []);
    }
    return store.run(context, next);
  });
}

// ---------------------------------------------------------------------------
// Module statics
// ---------------------------------------------------------------------------

function __dcChannel(name: any): any {
  const existing: any = __dcChannelsGet(name);
  if (existing !== undefined && existing !== null) return existing;
  if (typeof name !== "string" && typeof name !== "symbol") {
    throw new ERR_INVALID_ARG_TYPE("channel", ["string", "symbol"], name);
  }
  return new Channel(name);
}

function __dcSubscribe(name: any, subscription: any): void {
  __dcChannel(name).subscribe(subscription);
}

function __dcUnsubscribe(name: any, subscription: any): boolean {
  return __dcChannel(name).unsubscribe(subscription) === true;
}

function __dcHasSubscribers(name: any): boolean {
  const found: any = __dcChannelsGet(name);
  if (found === undefined || found === null) return false;
  return found.hasSubscribers === true;
}

// ---------------------------------------------------------------------------
// TracingChannel
// ---------------------------------------------------------------------------

const __dcTraceEvents: string[] = ["start", "end", "asyncStart", "asyncEnd", "error"];

// Node's `assertChannel`. The `undefined`/`null` case is split out because
// Node reaches it through `ObjectGetPrototypeOf(instance)` inside
// `Channel[Symbol.hasInstance]`, which is where the
// "Cannot convert undefined or null to object" `TypeError` that
// `test-diagnostics-channel-tracing-channel-args-types.js` expects comes from.
function __dcAssertChannel(value: any, name: string): void {
  if (value === undefined || value === null) {
    throw new TypeError("Cannot convert undefined or null to object");
  }
  if (!(value instanceof Channel)) {
    throw new ERR_INVALID_ARG_TYPE(name, ["Channel"], value);
  }
}

function __dcTracingChannelFrom(nameOrChannels: any, name: string): any {
  if (typeof nameOrChannels === "string") {
    return __dcChannel("tracing:" + nameOrChannels + ":" + name);
  }
  if (typeof nameOrChannels === "object" && nameOrChannels !== null) {
    const found: any = nameOrChannels[name];
    __dcAssertChannel(found, "nameOrChannels." + name);
    return found;
  }
  throw new ERR_INVALID_ARG_TYPE(
    "nameOrChannels",
    ["string", "object", "TracingChannel"],
    nameOrChannels,
  );
}

// Node spells this as the default parameter `context = {}`, which applies to
// `undefined` only. It is a function here, and it answers `{}` for `null` as
// well as for `undefined`, because of an engine bug: an optional parameter that
// the caller omitted arrives as **`null`** rather than `undefined` in a method
// that also declares a rest parameter, so `traceSync(fn)` would otherwise run
// with `context === null` and abort the process on the first member write
// (`expected object, found Null`). The standalone repro is in
// ../../test/diagnostics_channel/README.md.
function __dcContext(context: any): any {
  if (context === undefined || context === null) return {};
  return context;
}

class TracingChannel {
  start: any = undefined;
  end: any = undefined;
  asyncStart: any = undefined;
  asyncEnd: any = undefined;
  error: any = undefined;

  // Node defines the five as own properties with `ObjectDefineProperty`;
  // `Object.defineProperty` cannot redefine a declared field on a class
  // instance in this engine ("Cannot redefine property"), so they are declared
  // fields assigned in order. The order matters: it is what makes
  // `tracingChannel({})` fail on `nameOrChannels.start`.
  constructor(nameOrChannels: any) {
    this.start = __dcTracingChannelFrom(nameOrChannels, "start");
    this.end = __dcTracingChannelFrom(nameOrChannels, "end");
    this.asyncStart = __dcTracingChannelFrom(nameOrChannels, "asyncStart");
    this.asyncEnd = __dcTracingChannelFrom(nameOrChannels, "asyncEnd");
    this.error = __dcTracingChannelFrom(nameOrChannels, "error");
  }

  get hasSubscribers(): boolean {
    if (this.start !== undefined && this.start.hasSubscribers === true) return true;
    if (this.end !== undefined && this.end.hasSubscribers === true) return true;
    if (this.asyncStart !== undefined && this.asyncStart.hasSubscribers === true) return true;
    if (this.asyncEnd !== undefined && this.asyncEnd.hasSubscribers === true) return true;
    if (this.error !== undefined && this.error.hasSubscribers === true) return true;
    return false;
  }

  subscribe(handlers: any): void {
    for (const name of __dcTraceEvents) {
      const handler: any = handlers[name];
      if (!__dcTruthy(handler)) continue;
      const target: any = this[name];
      if (target === undefined || target === null) continue;
      target.subscribe(handler);
    }
  }

  unsubscribe(handlers: any): boolean {
    let done: boolean = true;
    for (const name of __dcTraceEvents) {
      const handler: any = handlers[name];
      if (!__dcTruthy(handler)) continue;
      const target: any = this[name];
      if (target === undefined || target === null) {
        done = false;
        continue;
      }
      if (target.unsubscribe(handler) !== true) done = false;
    }
    return done;
  }

  traceSync(fn: any, context?: any, thisArg?: any, ...args: any[]): any {
    const passed: any[] = __alsSpread(args);
    if (!this.hasSubscribers) return __evCall(fn, passed);
    const ctx: any = __dcContext(context);
    const start: any = this.start;
    const end: any = this.end;
    const error: any = this.error;
    return start.runStores(
      ctx,
      __evBox(function (): any {
        try {
          const result: any = __evCall(fn, passed);
          ctx.result = result;
          return result;
        } catch (err) {
          ctx.error = err;
          error.publish(ctx);
          throw err;
        } finally {
          end.publish(ctx);
        }
      }),
    );
  }

  tracePromise(fn: any, context?: any, thisArg?: any, ...args: any[]): any {
    const passed: any[] = __alsSpread(args);
    if (!this.hasSubscribers) return __evCall(fn, passed);
    const ctx: any = __dcContext(context);
    const start: any = this.start;
    const end: any = this.end;
    const asyncStart: any = this.asyncStart;
    const asyncEnd: any = this.asyncEnd;
    const error: any = this.error;

    // Node's `resolve`/`reject` continuations. `asyncEnd` fires immediately
    // after `asyncStart` because a promise has no "after the continuation"
    // point to hook — Node's own source carries that TODO.
    const onResolve: any = function (result: any): any {
      ctx.result = result;
      asyncStart.publish(ctx);
      asyncEnd.publish(ctx);
      return result;
    };
    const onReject: any = function (err: any): any {
      ctx.error = err;
      error.publish(ctx);
      asyncStart.publish(ctx);
      asyncEnd.publish(ctx);
      return Promise.reject(err);
    };

    return start.runStores(
      ctx,
      __evBox(function (): any {
        try {
          let promise: any = __evCall(fn, passed);
          if (!__dcIsPromise(promise)) promise = Promise.resolve(promise);
          return promise.then(onResolve, onReject);
        } catch (err) {
          ctx.error = err;
          error.publish(ctx);
          throw err;
        } finally {
          end.publish(ctx);
        }
      }),
    );
  }

  traceCallback(fn: any, position?: any, context?: any, thisArg?: any, ...args: any[]): any {
    const passed: any[] = __alsSpread(args);
    if (!this.hasSubscribers) return __evCall(fn, passed);
    const ctx: any = __dcContext(context);
    const start: any = this.start;
    const end: any = this.end;
    const asyncStart: any = this.asyncStart;
    const asyncEnd: any = this.asyncEnd;
    const error: any = this.error;

    const at: number = position === undefined || position === null ? -1 : Number(position);
    const index: number = at < 0 ? Number(passed.length) + at : at;
    const callback: any = index < 0 ? undefined : passed[index];
    if (!__evIsFn(callback)) {
      throw new ERR_INVALID_ARG_TYPE("callback", "function", callback);
    }

    // Node splices the wrapper in over the callback. `splice` loses a bare
    // function argument in this engine (the slot reads back `undefined`), and
    // an index assignment is the same operation for a one-for-one replacement,
    // so the boxed wrapper is written in place.
    passed[index] = __evBox(function (): any {
      const forwarded: any[] = [];
      const count = Number(arguments.length);
      for (let i = 0; i < count; i++) forwarded.push(arguments[i]);
      const err: any = forwarded[0];
      if (__dcTruthy(err)) {
        ctx.error = err;
        error.publish(ctx);
      } else {
        ctx.result = forwarded[1];
      }
      // `runStores` here is what lets a subscriber recover the context for the
      // continuation, which is the whole point of `asyncStart`.
      return asyncStart.runStores(
        ctx,
        __evBox(function (): any {
          try {
            return __evCall(callback, forwarded);
          } finally {
            asyncEnd.publish(ctx);
          }
        }),
      );
    });

    return start.runStores(
      ctx,
      __evBox(function (): any {
        try {
          return __evCall(fn, passed);
        } catch (err) {
          ctx.error = err;
          error.publish(ctx);
          throw err;
        } finally {
          end.publish(ctx);
        }
      }),
    );
  }
}

// `instanceof Promise` is unreliable for a thenable, and Node's test is only
// "is this already a promise": a `then` method is what every thenable has, and
// `Promise.resolve` is idempotent for a real promise anyway.
function __dcIsPromise(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Promise) return true;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return __evIsFn(value["then"]);
}

function __dcTracingChannel(nameOrChannels: any): any {
  return new TracingChannel(nameOrChannels);
}

// `node:diagnostics_channel` module object for the bundler's `require`
// rewriting. `Channel` and `TracingChannel` are also top-level classes, so
// `new Channel(...)` compiles in a test body.
const __node_diagnostics_channel: any = {
  channel: __dcChannel,
  hasSubscribers: __dcHasSubscribers,
  subscribe: __dcSubscribe,
  unsubscribe: __dcUnsubscribe,
  tracingChannel: __dcTracingChannel,
  Channel: Channel,
  TracingChannel: TracingChannel,
};

// `node:console` publishes every `log`/`info`/`debug`/`warn`/`error` call to a
// `console.<level>` channel. Node wires that up from the console side, by
// requiring this module; here the hook runs the other way, because `console` is
// in every bundle and this module is not — see the note on
// `__consoleChannelHook` in ../console/console.ts.
__consoleChannelHook.channel = __dcChannel;

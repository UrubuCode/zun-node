// node:events — the whole `EventEmitter` surface plus the module statics, in
// Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-event-emitter-*.js` and
// `test/parallel/test-events-*.js` files (see ../../test/events/). The listener
// bookkeeping, the `error`/`errorMonitor` ordering, the one-listener fast path
// that stores a bare function in `_events[type]`, the LIFO order of
// `removeAllListeners`, the `newListener`-before-insert rule and the
// MaxListenersExceededWarning text all follow Node's `lib/events.js` (MIT,
// Copyright Joyent, Inc. and other Node contributors), because those are
// observable through the corpus rather than derivable from any general rule.
//
// Like `path`, `events` is pure computation — no syscalls — so it is written in
// the language the platform compiles rather than behind the `zun_abi` boundary
// (PLAN.md principle 2). It is also the reason `events` was taken before `os`:
// Node's `process` is an `EventEmitter`, and the test harness needs
// `process.on('exit')`, `process.on('warning')` and `process.nextTick` to
// verify `common.mustCall` counts at all.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `__evUnbox` / `__evSame` / `__evIsFn` — a function stored in an array
//     arrives as a `functionBox` record, so `arr[0] === fn` is false and
//     `typeof arr[0]` is `"object"` (zun#17). The record's `__boxedFn` slot is
//     readable, so every identity test and every callability test in this file
//     goes through those three helpers.
//   * `__evCall` — a listener is invoked as `fn(...args)` and never as
//     `fn.apply(this, args)`: `apply`/`call` do not thread a receiver at all in
//     this engine, so `this` inside a listener is always `undefined` (the
//     `functionApply` intrinsic prepends `thisArg` as a positional argument
//     instead; zun#1). That is the single biggest gap of this module — see
//     ../../test/events/README.md.
//   * symbol-keyed slots hold an **array** even for a single listener: assigning
//     a function value under a symbol key on a dynamic object silently stores
//     nothing (`o[sym] = fn; o[sym] === undefined`), while an array value
//     round-trips. String-keyed slots keep Node's exact shape.
//   * `__evTypes` — a function-valued property is invisible to `Object.keys`
//     and `Object.hasOwn`, so `eventNames()` cannot read the key set back out of
//     `_events`; the insertion order is tracked alongside it.
//   * `__kRejection` / `errorMonitor` are module-level symbol constants:
//     `Symbol.for(key)` does not return the same symbol twice in this engine, so
//     a registry round-trip cannot be used to recover them.
//   * `Number(x.length)` throughout, because `.length` is a u64 (zun#3).
//   * numeric class fields carry an explicit initializer: a `number`-typed field
//     declared without one panics the interpreter when the instance is built.

// ---------------------------------------------------------------------------
// Well-known symbols
// ---------------------------------------------------------------------------

// `events.errorMonitor`: a listener installed under this key sees every 'error'
// event without consuming it.
const errorMonitor: any = Symbol("events.errorMonitor");

// `events.captureRejectionSymbol` — Node spells it `Symbol.for('nodejs.rejection')`.
const captureRejectionSymbol: any = Symbol("nodejs.rejection");

// Internal flags Node keeps on the instance behind symbols. They are plain
// string keys here, prefixed so they cannot collide with an event name.
const __kCaptureKey: string = "__zunEventsCapture";

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

// Unwrap a `functionBox` record back to its callable (zun#17). A box reports
// `typeof === "object"` and an empty `Object.keys`, but its `__boxedFn` slot
// reads back the original function with identity intact.
function __evUnbox(value: any): any {
  if (value !== null && value !== undefined && typeof value === "object") {
    const inner: any = value["__boxedFn"];
    if (inner !== undefined) return inner;
  }
  return value;
}

// Strict equality that sees through function boxing.
function __evSame(a: any, b: any): boolean {
  return __evUnbox(a) === __evUnbox(b);
}

function __evIsFn(value: any): boolean {
  return typeof __evUnbox(value) === "function";
}

// Wrap a callable in a `functionBox` record *deliberately*.
//
// Boxing is normally something this engine does to a function on its way into
// an array; routing a function through a one-element array is therefore the way
// to obtain the box, and the box is far more useful than the bare callable
// here, because it is an object:
//   * it survives being returned from an object-literal method or a class
//     method, which a function value does not (both answer `null`/`undefined`);
//   * it can be stored under a symbol key, which a function value cannot (the
//     assignment is silently dropped);
//   * it keeps a stable identity when it enters another array, where a bare
//     function is re-boxed and stops comparing equal to itself;
//   * it can carry properties, which is how a once-wrapper exposes `.listener`.
// It stays callable through an `any` binding, with the exact argument count.
function __evBox(fn: any): any {
  if (fn !== null && fn !== undefined && typeof fn === "object") return fn;
  const holder: any[] = [fn];
  return holder[0];
}

// Is this value one of those records (as opposed to a bare callable)?
function __evIsBox(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  return value["__boxedFn"] !== undefined;
}

function __evLen(value: any): number {
  return Number(value.length);
}

// Invoke a listener. `fn(...args)` is the only spelling that reaches the
// callable with the right `arguments.length`; `apply`/`call` cannot bind a
// receiver in this engine, so no `this` is threaded (zun#1).
function __evCall(listener: any, args: any[]): any {
  const fn: any = __evUnbox(listener);
  return fn(...args);
}

function __evIsSymbol(value: any): boolean {
  return typeof value === "symbol";
}

// The identity of an event name, for the bookkeeping in `__evTypes`.
//
// A symbol never compares equal to itself in this engine (`s === s` is `false`,
// and so is `Symbol.for(k) === Symbol.for(k)`), while a dynamic object keys a
// symbol-valued property by its description — so a description-derived id is
// both the only workable key and exactly consistent with how `_events[sym]`
// already behaves here.
function __evKeyId(type: any): string {
  if (__evIsSymbol(type)) return "@@sym:" + String(type);
  return "str:" + String(type);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// The ` Received ...` suffix Node appends to an ERR_INVALID_ARG_TYPE message.
function __evReceived(value: any): string {
  if (value === null) return " Received null";
  if (value === undefined) return " Received undefined";
  const kind = typeof value;
  if (kind === "function") {
    const name: any = value.name;
    return " Received function " + (typeof name === "string" ? name : "");
  }
  if (kind === "object") {
    if (Array.isArray(value)) return " Received an instance of Array";
    if (__evIsFn(value)) return " Received function ";
    const ctor: any = value.constructor;
    const name: any = ctor === undefined || ctor === null ? undefined : ctor.name;
    return " Received an instance of " + (typeof name === "string" && name !== "" ? name : "Object");
  }
  // Node formats the received value with `util.inspect`, not `JSON.stringify`:
  // a string comes out single-quoted (`'foo'`), which `JSON.stringify` cannot
  // produce. A differential run of `os` against Node caught the difference in
  // every `ERR_INVALID_ARG_TYPE` whose argument was a string.
  let shown = kind === "string" ? __evInspect(value) : String(value);
  if (Number(shown.length) > 28) shown = shown.slice(0, 25) + "...";
  return " Received type " + kind + " (" + shown + ")";
}

class ERR_INVALID_ARG_TYPE extends Error {
  code: string;
  constructor(name: string, expected: any, actual: any) {
    super(
      'The "' +
        name +
        '" argument must be ' +
        (Array.isArray(expected)
          ? "one of type " + (expected as any[]).join(", ")
          : "of type " + String(expected)) +
        "." +
        __evReceived(actual),
    );
    this.code = "ERR_INVALID_ARG_TYPE";
  }
  get name(): string {
    return "TypeError";
  }
}

class ERR_INVALID_ARG_VALUE extends Error {
  code: string;
  constructor(name: string, value: any, reason: string) {
    super('The ' + name + " argument " + reason + ". Received " + __evInspect(value));
    this.code = "ERR_INVALID_ARG_VALUE";
  }
  get name(): string {
    return "TypeError";
  }
}

class ERR_OUT_OF_RANGE extends Error {
  code: string;
  constructor(name: string, range: string, actual: any) {
    super(
      'The value of "' + name + '" is out of range. It must be ' + range + ". Received " +
        __evInspect(actual),
    );
    this.code = "ERR_OUT_OF_RANGE";
  }
  get name(): string {
    return "RangeError";
  }
}

class ERR_UNHANDLED_ERROR extends Error {
  code: string;
  context: any;
  constructor(detail: any) {
    super(detail === undefined ? "Unhandled error." : "Unhandled error. (" + String(detail) + ")");
    this.code = "ERR_UNHANDLED_ERROR";
    this.context = undefined;
  }
}

class AbortError extends Error {
  code: string;
  cause: any;
  constructor(message?: string, options?: any) {
    super(message === undefined ? "This operation was aborted" : message);
    this.code = "ABORT_ERR";
    this.cause = options === undefined || options === null ? undefined : options.cause;
  }
  get name(): string {
    return "AbortError";
  }
}

// `util.inspect` comes from src/util/util.ts, which the bundle places first. The
// indirection keeps this module usable even if that slice is absent.
function __evInspect(value: any, options?: any): string {
  return inspect(value, options);
}

// ---------------------------------------------------------------------------
// Validators (lib/internal/validators.js, reduced to what events uses)
// ---------------------------------------------------------------------------

const __MAX_SAFE: number = 9007199254740991;

function __evValidateNumber(value: any, name: string, min: number): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (Number.isNaN(value) || value < min || value > __MAX_SAFE) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + String(min) + " && <= " + String(__MAX_SAFE), value);
  }
}

function __evValidateInteger(value: any, name: string, min: number): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < min || value > __MAX_SAFE) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + String(min) + " && <= " + String(__MAX_SAFE), value);
  }
}

function __evValidateBoolean(value: any, name: string): void {
  if (typeof value !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
  }
}

// `validateObject(value, name)` — an array, a function and every primitive are
// rejected; `null` is rejected too.
function __evValidateObject(value: any, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "object", value);
  }
}

// `validateAbortSignal(signal, name)` — `undefined` passes (the option is
// optional); anything else must look like an AbortSignal.
function __evValidateAbortSignal(signal: any, name: string): void {
  if (signal === undefined) return;
  // signal.addEventListener is not readable as a value, so the shape test is
  // the `aborted` flag plus the EventTarget check.
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    !__eventsIsEventTargetLike(signal)
  ) {
    throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
  }
}

function __evCheckListener(listener: any): void {
  if (!__evIsFn(listener)) {
    throw new ERR_INVALID_ARG_TYPE("listener", "function", listener);
  }
}

// ---------------------------------------------------------------------------
// defaultMaxListeners
// ---------------------------------------------------------------------------

let __evDefaultMaxListeners: number = 10;

function __evGetDefaultMaxListeners(): number {
  return __evDefaultMaxListeners;
}

function __evSetDefaultMaxListeners(value: any): void {
  __evValidateNumber(value, "defaultMaxListeners", 0);
  __evDefaultMaxListeners = value;
}

// `process.emitWarning` lives in src/process/process.ts, which the bundle places
// after this file, so the warning route is installed by that module rather than
// referenced directly. Until it is, a warning goes to stderr.
// Held in an object rather than a `let`, because assigning a function value to
// a module-level `let x: any` leaves the variable `undefined` in this engine.
const __evWarningRoute: any = { sink: undefined };

function __evSetWarningSink(sink: any): void {
  __evRawSet(__evWarningRoute, "sink", sink);
}

function __evEmitWarning(warning: any): void {
  if (__evWarningRoute.sink !== undefined) {
    __evCall(__evWarningRoute.sink, [warning]);
    return;
  }
  console.error(String(warning.name) + ": " + String(warning.message));
}

class MaxListenersExceededWarning extends Error {
  emitter: any;
  type: any;
  count: number = 0;
  constructor(message: string, emitter: any, type: any, count: number) {
    super(message);
    this.emitter = emitter;
    this.type = type;
    this.count = count;
  }
  get name(): string {
    return "MaxListenersExceededWarning";
  }
}

// ---------------------------------------------------------------------------
// Listener storage
//
// `_events` keeps Node's shape for string keys: the slot holds the listener
// itself while there is exactly one, and an array from the second on. Symbol
// keys always hold an array, because a function assigned under a symbol key on a
// dynamic object is dropped by this engine. `__evTypes` records the key
// insertion order, because a function-valued property is invisible to
// `Object.keys`.
// ---------------------------------------------------------------------------

// Write a slot, clearing whatever was there first.
//
// A dynamic object keeps function values in a slot of their own, so assigning a
// function over a key that currently holds an object can leave the old object
// value shadowing the new function. Deleting the key first makes the write
// unconditional.
function __evRawSet(events: any, type: any, value: any): void {
  // `delete obj[sym]` throws in this engine, and a symbol slot only ever holds
  // an array here, so the shadowing it guards against cannot arise for one.
  if (!__evIsSymbol(type)) delete events[type];
  events[type] = value;
}

// Clear a slot. A symbol-keyed property cannot be deleted (the `delete`
// intrinsic throws for a symbol key), so it is blanked instead; `__evSlotGet`
// reports `undefined` either way, and `eventNames()` reads `__evTypes`.
function __evRawDelete(events: any, type: any): void {
  // `delete obj[sym]` throws, and `delete` does not clear a *function*-valued
  // property at all (the function lives in a slot of its own, which the delete
  // leaves in place and then re-exposes). Writing `undefined` is the only clear
  // that works for both; it costs a key that lingers in `Object.keys(_events)`,
  // which `eventNames()` does not read.
  const current: any = events[type];
  if (__evIsSymbol(type) || __evIsFn(current)) {
    events[type] = undefined;
    return;
  }
  delete events[type];
}

function __evSlotGet(target: any, type: any): any {
  const events: any = target._events;
  if (events === undefined || events === null) return undefined;
  return events[type];
}

function __evSlotSet(target: any, type: any, value: any): void {
  const events: any = target._events;
  if (events === undefined || events === null) return;
  // A bare function assigned under a symbol key is dropped by this engine, so a
  // symbol slot holds the boxed form of the same callable.
  if (__evIsSymbol(type) && __evIsFn(value)) {
    __evRawSet(events, type, __evBox(value));
  } else {
    __evRawSet(events, type, value);
  }
  __evTrackType(target, type);
}

function __evSlotDelete(target: any, type: any): void {
  const events: any = target._events;
  if (events === undefined || events === null) return;
  __evRawDelete(events, type);
  const types: any = target.__evTypes;
  if (types === undefined) return;
  const wanted = __evKeyId(type);
  const n = __evLen(types);
  for (let i = 0; i < n; i++) {
    if (__evKeyId(types[i]) === wanted) {
      types.splice(i, 1);
      return;
    }
  }
}

function __evTrackType(target: any, type: any): void {
  let types: any = target.__evTypes;
  if (types === undefined) {
    types = [];
    target.__evTypes = types;
  }
  const wanted = __evKeyId(type);
  const n = __evLen(types);
  for (let i = 0; i < n; i++) {
    if (__evKeyId(types[i]) === wanted) return;
  }
  types.push(type);
}

// The live listener list for a type, as an array, or `undefined` when there is
// none. A single string-keyed listener is reported as a one-element array by the
// callers that want a list; `__evSlotGet` is the raw view.
function __evListOf(target: any, type: any): any {
  const slot: any = __evSlotGet(target, type);
  if (slot === undefined) return undefined;
  if (Array.isArray(slot)) return slot;
  return [slot];
}

function __evCountOf(target: any, type: any): number {
  const slot: any = __evSlotGet(target, type);
  if (slot === undefined) return 0;
  if (Array.isArray(slot)) return __evLen(slot);
  return 1;
}

// Is this slot "one listener" rather than "a list"?
function __evSlotIsSingle(type: any, slot: any): boolean {
  if (Array.isArray(slot)) return false;
  return __evIsFn(slot);
}

// The value to store when a slot holds exactly one listener: the bare callable
// under a string key (so `_events.foo === listener` holds, as in Node), and the
// boxed form under a symbol key (where a bare callable would be dropped).
function __evSingleFor(type: any, listener: any): any {
  if (__evIsSymbol(type)) return __evBox(listener);
  if (__evIsBox(listener) && listener.listener !== undefined) {
    // A once-wrapper: keep the box, it is what carries `.listener`.
    return listener;
  }
  return __evUnbox(listener);
}

// `events.defaultMaxListeners` resolution for a target.
function __evMaxListenersOf(target: any): number {
  const own: any = target._maxListeners;
  if (own === undefined) return __evDefaultMaxListeners;
  return own;
}

function __evEnsureEvents(target: any): any {
  let events: any = target._events;
  if (events === undefined || events === null) {
    events = Object.create(null);
    target._events = events;
    target._eventsCount = 0;
    target.__evTypes = [];
  }
  if (target.__evTypes === undefined) target.__evTypes = [];
  return events;
}

// ---------------------------------------------------------------------------
// _addListener / _onceWrap
// ---------------------------------------------------------------------------

function __evAddListener(target: any, type: any, listener: any, prepend: boolean): any {
  __evCheckListener(listener);

  let events: any = target._events;
  if (events === undefined || events === null) {
    events = __evEnsureEvents(target);
  } else {
    if (target.__evTypes === undefined) target.__evTypes = [];
    // Emit 'newListener' before inserting, so a handler cannot recurse into the
    // listener it is about to see.
    if (__evSlotGet(target, "newListener") !== undefined) {
      const original: any =
        listener === undefined || listener === null ? undefined : listener.listener;
      __evEmit(target, "newListener", [type, original === undefined ? listener : original]);
      // A 'newListener' handler may have replaced `_events` wholesale.
      events = target._events;
      if (events === undefined || events === null) events = __evEnsureEvents(target);
    }
  }

  const existing: any = __evSlotGet(target, type);

  if (existing === undefined) {
    __evSlotSet(target, type, listener);
    target._eventsCount = Number(target._eventsCount) + 1;
    return target;
  }

  let list: any;
  if (__evSlotIsSingle(type, existing)) {
    const single: any = existing;
    list = prepend ? [listener, single] : [single, listener];
    // Assign the array directly: `__evSlotSet` would re-wrap a single callable.
    const store: any = target._events;
    __evRawSet(store, type, list);
    __evTrackType(target, type);
  } else {
    list = existing;
    if (prepend) {
      // `Array.prototype.unshift` rejects a function argument in this engine,
      // so a prepend rebuilds the list; the `warned` flag rides along.
      const next: any = [listener];
      const existingCount = __evLen(list);
      for (let i = 0; i < existingCount; i++) next.push(list[i]);
      if (list.warned === true) next.warned = true;
      const store: any = target._events;
      __evRawSet(store, type, next);
      list = next;
    } else {
      list.push(listener);
    }
  }

  // Leak check.
  const max = __evMaxListenersOf(target);
  const count = __evLen(list);
  if (max > 0 && count > max && list.warned !== true) {
    list.warned = true;
    const warning = new MaxListenersExceededWarning(
      "Possible EventEmitter memory leak detected. " +
        String(count) +
        " " +
        String(type) +
        " listeners added to " +
        __evInspect(target, { depth: -1 }) +
        ". MaxListeners is " +
        String(max) +
        ". Use emitter.setMaxListeners() to increase limit",
      target,
      type,
      count,
    );
    __evEmitWarning(warning);
  }

  return target;
}

// The one-shot wrapper. `wrapped.listener` is the original, which `listeners()`
// unwraps and `rawListeners()` exposes.
function __evOnceWrap(target: any, type: any, listener: any): any {
  const state: any = { fired: false };
  const wrapped: any = function (): any {
    if (state.fired === true) return undefined;
    state.fired = true;
    const passed: any[] = [];
    const count = Number(arguments.length);
    for (let i = 0; i < count; i++) passed.push(arguments[i]);
    __evRemoveListener(target, type, state.wrapFn);
    return __evCall(listener, passed);
  };
  // The wrapper is handed out boxed, so that it survives being returned, keeps
  // one identity, and can carry `.listener` the way Node's does.
  const box: any = __evBox(wrapped);
  box.listener = __evUnbox(listener);
  __evRawSet(state, "wrapFn", box);
  return box;
}

// ---------------------------------------------------------------------------
// removeListener / removeAllListeners
// ---------------------------------------------------------------------------

function __evRemoveListener(target: any, type: any, listener: any): any {
  __evCheckListener(listener);

  const events: any = target._events;
  if (events === undefined || events === null) return target;

  const slot: any = __evSlotGet(target, type);
  if (slot === undefined) return target;

  if (__evSlotIsSingle(type, slot)) {
    const single: any = slot;
    const wrappedOriginal: any =
      single === undefined || single === null ? undefined : single.listener;
    if (__evSame(single, listener) || __evSame(wrappedOriginal, listener)) {
      target._eventsCount = Number(target._eventsCount) - 1;
      __evSlotDelete(target, type);
      if (__evSlotGet(target, "removeListener") !== undefined) {
        __evEmit(target, "removeListener", [
          type,
          wrappedOriginal === undefined ? single : wrappedOriginal,
        ]);
      }
    }
    return target;
  }

  const list: any = slot;
  let position = -1;
  let removed: any = undefined;
  for (let i = __evLen(list) - 1; i >= 0; i--) {
    const candidate: any = list[i];
    const wrappedOriginal: any =
      candidate === undefined || candidate === null ? undefined : candidate.listener;
    if (__evSame(candidate, listener) || __evSame(wrappedOriginal, listener)) {
      removed = wrappedOriginal === undefined ? candidate : wrappedOriginal;
      position = i;
      break;
    }
  }
  if (position < 0) return target;

  list.splice(position, 1);
  if (__evLen(list) === 1) {
    // Back to Node's one-listener fast path.
    const store: any = target._events;
    __evRawSet(store, type, __evSingleFor(type, list[0]));
  }
  if (__evLen(list) === 0) {
    target._eventsCount = Number(target._eventsCount) - 1;
    __evSlotDelete(target, type);
  }

  if (__evSlotGet(target, "removeListener") !== undefined) {
    __evEmit(target, "removeListener", [type, removed]);
  }
  return target;
}

function __evRemoveAllListeners(target: any, type: any, hasType: boolean): any {
  const events: any = target._events;
  if (events === undefined || events === null) return target;

  // Without a 'removeListener' listener there is nothing to report; drop
  // everything at once.
  if (__evSlotGet(target, "removeListener") === undefined) {
    if (!hasType) {
      target._events = Object.create(null);
      target._eventsCount = 0;
      target.__evTypes = [];
    } else if (__evSlotGet(target, type) !== undefined) {
      target._eventsCount = Number(target._eventsCount) - 1;
      __evSlotDelete(target, type);
      if (Number(target._eventsCount) === 0) {
        target._events = Object.create(null);
        target.__evTypes = [];
      }
    }
    return target;
  }

  if (!hasType) {
    // Insertion order over the event names, with 'removeListener' cleared last;
    // the LIFO order Node documents is the order *within* one event's list.
    const names: any[] = __evEventNames(target);
    const total = __evLen(names);
    for (let i = 0; i < total; i++) {
      const name: any = names[i];
      if (typeof name === "string" && name === "removeListener") continue;
      __evRemoveAllListeners(target, name, true);
    }
    __evRemoveAllListeners(target, "removeListener", true);
    target._events = Object.create(null);
    target._eventsCount = 0;
    target.__evTypes = [];
    return target;
  }

  const slot: any = __evSlotGet(target, type);
  if (slot === undefined) return target;

  if (__evSlotIsSingle(type, slot)) {
    __evRemoveListener(target, type, slot);
    return target;
  }

  const list: any = slot;
  for (let i = __evLen(list) - 1; i >= 0; i--) {
    __evRemoveListener(target, type, list[i]);
  }
  return target;
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

function __evEmit(target: any, type: any, args: any[]): boolean {
  let doError = type === "error";

  const events: any = target._events;
  if (events !== undefined && events !== null) {
    if (doError && __evSlotGet(target, errorMonitor) !== undefined) {
      __evEmit(target, errorMonitor, args);
    }
    if (doError) doError = __evSlotGet(target, "error") === undefined;
  } else if (!doError) {
    return false;
  }

  if (doError) {
    let er: any = undefined;
    if (__evLen(args) > 0) er = args[0];
    if (er !== null && er !== undefined && typeof er === "object" && er instanceof Error) {
      throw er; // Unhandled 'error' event
    }
    let stringified: any = undefined;
    try {
      stringified = __evInspect(er);
    } catch (ignored) {
      stringified = String(er);
    }
    const err = new ERR_UNHANDLED_ERROR(stringified);
    err.context = er;
    throw err; // Unhandled 'error' event
  }

  const slot: any = __evSlotGet(target, type);
  if (slot === undefined) return false;

  if (__evSlotIsSingle(type, slot)) {
    const single: any = slot;
    const result: any = __evCall(single, args);
    if (result !== undefined && result !== null) __evAddCatch(target, result, type, args);
    return true;
  }

  // Node snapshots the list, so a listener added during the dispatch is not
  // called and a listener removed during it still is.
  const live: any = slot;
  const snapshot: any[] = [];
  const count = __evLen(live);
  for (let i = 0; i < count; i++) snapshot.push(live[i]);
  for (let i = 0; i < count; i++) {
    const result: any = __evCall(snapshot[i], args);
    if (result !== undefined && result !== null) __evAddCatch(target, result, type, args);
  }
  return true;
}

// `captureRejections`: a listener that returns a promise has its rejection
// routed to `[captureRejectionSymbol]` if present, else to the 'error' event.
function __evAddCatch(target: any, promise: any, type: any, args: any[]): void {
  if (target[__kCaptureKey] !== true) return;
  try {
    const onRejected: any = function (err: any): void {
      __evEmitUnhandledRejectionOrErr(target, err, type, args);
    };
    // A native Promise's `then` is not readable as a value either, so the
    // concrete class is tried first.
    if (promise instanceof Promise) {
      promise.then(undefined, onRejected);
    } else if (__evDuck(promise, "then")) {
      const callable: any = __evUnbox(promise.then);
      callable(undefined, onRejected);
    }
  } catch (caught) {
    __evEmit(target, "error", [caught]);
  }
}

function __evEmitUnhandledRejectionOrErr(ee: any, err: any, type: any, args: any[]): void {
  const handler: any = ee[captureRejectionSymbol];
  if (__evIsFn(handler)) {
    const rejectionArgs: any[] = [err, type];
    for (const arg of args) rejectionArgs.push(arg);
    __evCall(handler, rejectionArgs);
    return;
  }
  const previous: any = ee[__kCaptureKey];
  try {
    ee[__kCaptureKey] = false;
    __evEmit(ee, "error", [err]);
  } finally {
    ee[__kCaptureKey] = previous;
  }
}

// ---------------------------------------------------------------------------
// listeners / eventNames
// ---------------------------------------------------------------------------

// `unwrap` true → `listeners()` (once-wrappers replaced by the original);
// false → `rawListeners()`.
function __evListeners(target: any, type: any, unwrap: boolean): any[] {
  const out: any[] = [];
  const slot: any = __evSlotGet(target, type);
  if (slot === undefined) return out;
  const list: any = Array.isArray(slot) ? slot : [slot];
  const count = __evLen(list);
  for (let i = 0; i < count; i++) {
    const stored: any = list[i];
    const original: any =
      stored === undefined || stored === null ? undefined : stored.listener;
    if (unwrap) {
      out.push(__evIsFn(original) ? __evUnbox(original) : __evUnbox(stored));
    } else if (__evIsFn(original)) {
      // A once-wrapper: hand back the record, which is what exposes `.listener`.
      out.push(stored);
    } else {
      out.push(__evUnbox(stored));
    }
  }
  return out;
}

// `Reflect.ownKeys(_events)` order: integer-like string keys ascending, then the
// remaining string keys in insertion order, then symbols in insertion order.
function __evEventNames(target: any): any[] {
  if (Number(target._eventsCount) === 0) return [];
  const types: any = target.__evTypes;
  if (types === undefined) return [];
  const integers: any[] = [];
  const strings: any[] = [];
  const symbols: any[] = [];
  for (const type of types) {
    if (__evSlotGet(target, type) === undefined) continue;
    if (__evIsSymbol(type)) {
      symbols.push(type);
      continue;
    }
    const text = String(type);
    if (__evIsIndexKey(text)) {
      integers.push(text);
    } else {
      strings.push(type);
    }
  }
  integers.sort(function (a: any, b: any): number {
    return Number(a) - Number(b);
  });
  const out: any[] = [];
  for (const key of integers) out.push(key);
  for (const key of strings) out.push(key);
  for (const key of symbols) out.push(key);
  return out;
}

function __evIsIndexKey(text: string): boolean {
  const n = Number(text.length);
  if (n === 0 || n > 10) return false;
  for (let i = 0; i < n; i++) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  if (n > 1 && text.charCodeAt(0) === 48) return false;
  return true;
}

// ---------------------------------------------------------------------------
// EventEmitter
// ---------------------------------------------------------------------------

class EventEmitter {
  _events: any;
  _eventsCount: number = 0;
  _maxListeners: any;
  __evTypes: any[] = [];

  constructor(options?: any) {
    this._events = Object.create(null);
    this._eventsCount = 0;
    this._maxListeners = undefined;
    this.__evTypes = [];
    const self: any = this;
    if (options !== undefined && options !== null && options.captureRejections !== undefined) {
      __evValidateBoolean(options.captureRejections, "options.captureRejections");
      self[__kCaptureKey] = options.captureRejections === true;
    } else {
      self[__kCaptureKey] = false;
    }
  }

  // `EventEmitter.init.call(this)` is not expressible (no receiver threading),
  // so the instance method is the supported spelling.
  init(options?: any): void {
    const self: any = this;
    if (self._events === undefined || self._events === null) {
      self._events = Object.create(null);
      self._eventsCount = 0;
      self.__evTypes = [];
    }
    if (options !== undefined && options !== null && options.captureRejections !== undefined) {
      __evValidateBoolean(options.captureRejections, "options.captureRejections");
      self[__kCaptureKey] = options.captureRejections === true;
    }
  }

  addListener(type: any, listener: any): any {
    return __evAddListener(this, type, listener, false);
  }

  on(type: any, listener: any): any {
    return __evAddListener(this, type, listener, false);
  }

  prependListener(type: any, listener: any): any {
    return __evAddListener(this, type, listener, true);
  }

  once(type: any, listener: any): any {
    __evCheckListener(listener);
    return __evAddListener(this, type, __evOnceWrap(this, type, listener), false);
  }

  prependOnceListener(type: any, listener: any): any {
    __evCheckListener(listener);
    return __evAddListener(this, type, __evOnceWrap(this, type, listener), true);
  }

  removeListener(type: any, listener: any): any {
    return __evRemoveListener(this, type, listener);
  }

  off(type: any, listener: any): any {
    return __evRemoveListener(this, type, listener);
  }

  removeAllListeners(type?: any): any {
    return __evRemoveAllListeners(this, type, type !== undefined);
  }

  // `emit(type, ...args)` is spelled with explicit optional slots, because a
  // class method's rest parameter is not materialised as an array in this
  // engine (with no rest arguments it is `undefined`, with one it is the bare
  // value, and `.length` then panics the interpreter) and `arguments` is not
  // available inside a class method either. The trailing `undefined` slots are
  // trimmed, so `emit('x', undefined)` is reported as a zero-argument emit —
  // the one observable deviation this costs.
  emit(
    type: any,
    a0?: any,
    a1?: any,
    a2?: any,
    a3?: any,
    a4?: any,
    a5?: any,
    a6?: any,
    a7?: any,
    a8?: any,
    a9?: any,
  ): boolean {
    const slots: any[] = [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9];
    let count = 10;
    while (count > 0 && slots[count - 1] === undefined) count = count - 1;
    const passed: any[] = [];
    for (let i = 0; i < count; i++) passed.push(slots[i]);
    return __evEmit(this, type, passed);
  }

  listeners(type?: any): any[] {
    return __evListeners(this, type, true);
  }

  rawListeners(type?: any): any[] {
    return __evListeners(this, type, false);
  }

  // Node has `listenerCount` on the instance *and* as a module/class static.
  // A class here may not carry a static and an instance method of the same name
  // ("instance method `listenerCount` must be called through an object"), so the
  // instance form wins and the static is reachable only through the module
  // object (`__node_events.listenerCount`).
  listenerCount(type: any, listener?: any): number {
    if (listener === undefined) return __evCountOf(this, type);
    __evCheckListener(listener);
    const list: any = __evListOf(this, type);
    if (list === undefined) return 0;
    let total = 0;
    const count = __evLen(list);
    for (let i = 0; i < count; i++) {
      const stored: any = list[i];
      const original: any =
        stored === undefined || stored === null ? undefined : stored.listener;
      if (__evSame(stored, listener) || __evSame(original, listener)) total = total + 1;
    }
    return total;
  }

  eventNames(): any[] {
    return __evEventNames(this);
  }

  setMaxListeners(n: any): any {
    __evValidateNumber(n, "setMaxListeners", 0);
    this._maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return __evMaxListenersOf(this);
  }

  // ---- module statics, reachable as `EventEmitter.<name>(...)` --------------
  //
  // A class static *field* reads back as `undefined` in this engine and
  // assigning a property to a class panics the interpreter, so the value-shaped
  // statics (`EventEmitter.defaultMaxListeners`, `EventEmitter.errorMonitor`,
  // `EventEmitter.captureRejectionSymbol`, `EventEmitter.prototype`) are only
  // available through the module object. Static *methods* work, so the callable
  // statics live here as well as there.

  static addAbortListener(signal: any, listener: any): any {
    return __eventsAddAbortListener(signal, listener);
  }
}

// ---------------------------------------------------------------------------
// Module statics
// ---------------------------------------------------------------------------

function __eventsListenerCount(emitter: any, type: any): number {
  if (__eventsIsEmitterLike(emitter)) {
    return Number(emitter.listenerCount(type));
  }
  return __evCountOf(emitter, type);
}

// A method defined by a class -- ours or a host built-in such as EventTarget --
// cannot be *read* as a value in this engine (et.addEventListener is undefined
// while et.addEventListener(...) works), so Node's duck typing has to be backed
// by instanceof checks. The duck test is kept as well, for a plain object that
// had the methods assigned to it.
function __evDuck(value: any, name: string): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return __evIsFn(value[name]);
}

function __eventsIsEmitterLike(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  if (value instanceof EventEmitter) return true;
  return __evDuck(value, "on") && __evDuck(value, "listeners");
}

function __eventsIsEventTargetLike(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  if (value instanceof EventTarget) return true;
  // An AbortSignal is an EventTarget, but `signal instanceof EventTarget` is
  // false in this engine, so the concrete class is checked too.
  if (value instanceof AbortSignal) return true;
  return __evDuck(value, "addEventListener") && __evDuck(value, "dispatchEvent");
}

function __eventsGetEventListeners(emitterOrTarget: any, type: any): any[] {
  if (emitterOrTarget !== null && emitterOrTarget !== undefined) {
    if (__eventsIsEmitterLike(emitterOrTarget)) {
      return emitterOrTarget.listeners(type);
    }
    if (__eventsIsEventTargetLike(emitterOrTarget)) {
      // The engine's EventTarget keeps its handler list internal and exposes no
      // reader, so there is nothing to enumerate; an empty list is the honest
      // answer rather than a wrong one.
      const tracked: any = __evTableGet(__eventsTargetListeners, emitterOrTarget);
      if (tracked === undefined) return [];
      const forType: any = tracked[String(type)];
      if (forType === undefined) return [];
      const out: any[] = [];
      for (const entry of forType) out.push(entry);
      return out;
    }
  }
  throw new ERR_INVALID_ARG_TYPE("emitter", ["EventEmitter", "EventTarget"], emitterOrTarget);
}

// Side tables keyed by object identity.
//
// A `WeakMap` would be the right structure, but it accepts only object values
// here (`wm.set(key, 5)` fails with "call did not resolve to a method",
// https://github.com/UrubuCode/zun/issues/28), and a `Map` read through an `any`
// binding throws (https://github.com/UrubuCode/zun/issues/7), so these are two
// parallel arrays with a linear scan. Object identity survives array storage —
// only *functions* and *symbols* are re-boxed — so the scan is exact. The
// tables are small (one entry per EventTarget a program touches) and, unlike a
// WeakMap, they keep their keys alive; that is a leak this trades for working
// lookups.
function __evTableNew(): any {
  return { keys: [], values: [] };
}

function __evTableIndex(table: any, key: any): number {
  const keys: any = table.keys;
  const count = __evLen(keys);
  for (let i = 0; i < count; i++) {
    if (keys[i] === key) return i;
  }
  return -1;
}

function __evTableGet(table: any, key: any): any {
  const at = __evTableIndex(table, key);
  if (at < 0) return undefined;
  return table.values[at];
}

function __evTableSet(table: any, key: any, value: any): void {
  const at = __evTableIndex(table, key);
  if (at < 0) {
    table.keys.push(key);
    table.values.push(value);
    return;
  }
  table.values[at] = value;
}

// EventTarget listeners added through this module are tracked so
// `getEventListeners` can answer for them (the host EventTarget has no reader).
const __eventsTargetListeners: any = __evTableNew();

function __eventsTrackTargetListener(target: any, type: any, listener: any, add: boolean): void {
  let byType: any = __evTableGet(__eventsTargetListeners, target);
  if (byType === undefined) {
    if (!add) return;
    byType = Object.create(null);
    __evTableSet(__eventsTargetListeners, target, byType);
  }
  const key = String(type);
  let list: any = byType[key];
  if (list === undefined) {
    if (!add) return;
    list = [];
    byType[key] = list;
  }
  if (add) {
    list.push(listener);
    return;
  }
  for (let i = __evLen(list) - 1; i >= 0; i--) {
    if (__evSame(list[i], listener)) {
      list.splice(i, 1);
      return;
    }
  }
}

const __kMaxEventTargetListeners: any = __evTableNew();

function __eventsGetMaxListeners(emitterOrTarget: any): number {
  if (emitterOrTarget !== null && emitterOrTarget !== undefined) {
    if (__eventsIsEmitterLike(emitterOrTarget)) {
      return Number(emitterOrTarget.getMaxListeners());
    }
    const stored: any = __evTableGet(__kMaxEventTargetListeners, emitterOrTarget);
    if (typeof stored === "number") return stored;
    // An AbortSignal opts out of the max-listeners warning entirely, so Node
    // reports 0 (unlimited) for one that has not been given a limit.
    if (emitterOrTarget instanceof AbortSignal) return 0;
    if (__eventsIsEventTargetLike(emitterOrTarget)) return __evDefaultMaxListeners;
  }
  throw new ERR_INVALID_ARG_TYPE("emitter", ["EventEmitter", "EventTarget"], emitterOrTarget);
}

function __eventsSetMaxListeners(n: any, targets: any[]): void {
  const value = n === undefined ? __evDefaultMaxListeners : n;
  __evValidateNumber(value, "setMaxListeners", 0);
  if (targets === undefined || __evLen(targets) === 0) {
    __evDefaultMaxListeners = value;
    return;
  }
  for (const target of targets) {
    if (__eventsIsEventTargetLike(target)) {
      __evTableSet(__kMaxEventTargetListeners, target, value);
    } else if (__eventsIsEmitterLike(target)) {
      target.setMaxListeners(value);
    } else {
      throw new ERR_INVALID_ARG_TYPE("eventTargets", ["EventEmitter", "EventTarget"], target);
    }
  }
}

// `eventTargetAgnostic{Add,Remove}Listener`.
function __eventsAgnosticAdd(emitter: any, name: any, listener: any, once: boolean): void {
  if (__eventsIsEmitterLike(emitter)) {
    if (once) {
      emitter.once(name, listener);
    } else {
      emitter.on(name, listener);
    }
    return;
  }
  if (__eventsIsEventTargetLike(emitter)) {
    emitter.addEventListener(name, listener, once ? { once: true } : undefined);
    __eventsTrackTargetListener(emitter, name, listener, true);
    return;
  }
  throw new ERR_INVALID_ARG_TYPE("emitter", "EventEmitter", emitter);
}

function __eventsAgnosticRemove(emitter: any, name: any, listener: any): void {
  if (__eventsIsEmitterLike(emitter)) {
    emitter.removeListener(name, listener);
    return;
  }
  if (__eventsIsEventTargetLike(emitter)) {
    emitter.removeEventListener(name, listener);
    __eventsTrackTargetListener(emitter, name, listener, false);
    return;
  }
  throw new ERR_INVALID_ARG_TYPE("emitter", "EventEmitter", emitter);
}

// `events.once(emitter, name[, options])` → Promise of the event's arguments.
function __eventsOnce(emitter: any, name: any, options?: any): any {
  const opts: any = options === undefined ? {} : options;
  return new Promise(function (resolve: any, reject: any): void {
    let signal: any = undefined;
    try {
      __evValidateObject(opts, "options");
      signal = opts.signal;
      __evValidateAbortSignal(signal, "options.signal");
      if (!__eventsIsEmitterLike(emitter) && !__eventsIsEventTargetLike(emitter)) {
        throw new ERR_INVALID_ARG_TYPE("emitter", ["EventEmitter", "EventTarget"], emitter);
      }
      if (signal !== undefined && signal !== null && signal.aborted === true) {
        throw new AbortError(undefined, { cause: signal.reason });
      }
    } catch (invalid) {
      reject(invalid);
      return;
    }

    const state: any = {};

    const cleanupSignal: any = function (): void {
      if (signal !== undefined && signal !== null && state.abortListener !== undefined) {
        __eventsAgnosticRemove(signal, "abort", state.abortListener);
      }
    };

    const errorListener: any = function (err: any): void {
      __eventsAgnosticRemove(emitter, name, state.resolver);
      cleanupSignal();
      reject(err);
    };

    const resolver: any = function (): any {
      const passed: any[] = [];
      const count = Number(arguments.length);
      for (let i = 0; i < count; i++) passed.push(arguments[i]);
      if (__eventsIsEmitterLike(emitter)) {
        emitter.removeListener("error", state.errorListener);
      }
      cleanupSignal();
      resolve(passed);
      return undefined;
    };

    __evRawSet(state, "resolver", resolver);
    __evRawSet(state, "errorListener", errorListener);

    __eventsAgnosticAdd(emitter, name, resolver, true);
    if (!(typeof name === "string" && name === "error") && __eventsIsEmitterLike(emitter)) {
      emitter.once("error", errorListener);
    }

    if (signal !== undefined && signal !== null) {
      const abortListener: any = function (): void {
        __eventsAgnosticRemove(emitter, name, state.resolver);
        if (__eventsIsEmitterLike(emitter)) {
          emitter.removeListener("error", state.errorListener);
        }
        cleanupSignal();
        reject(new AbortError(undefined, { cause: signal.reason }));
      };
      __evRawSet(state, "abortListener", abortListener);
      __eventsAgnosticAdd(signal, "abort", abortListener, true);
    }
  });
}

// `events.on(emitter, event[, options])` → async iterator over the events.
function __eventsOn(emitter: any, event: any, options?: any): any {
  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");
  const signal: any = opts.signal;
  __evValidateAbortSignal(signal, "options.signal");
  if (signal !== undefined && signal !== null && signal.aborted === true) {
    throw new AbortError(undefined, { cause: signal.reason });
  }
  let highWatermark: any = opts.highWaterMark;
  if (highWatermark === undefined) highWatermark = opts.highWatermark;
  if (highWatermark === undefined) highWatermark = __MAX_SAFE;
  __evValidateInteger(highWatermark, "options.highWaterMark", 1);
  let lowWatermark: any = opts.lowWaterMark;
  if (lowWatermark === undefined) lowWatermark = opts.lowWatermark;
  if (lowWatermark === undefined) lowWatermark = 1;
  __evValidateInteger(lowWatermark, "options.lowWaterMark", 1);

  const state: any = {
    events: [],
    promises: [],
    finished: false,
    error: null,
    paused: false,
    size: 0,
    attached: [],
    abortDisposable: undefined,
  };

  const removeAll: any = function (): void {
    while (__evLen(state.attached) > 0) {
      const entry: any = state.attached.pop();
      __eventsAgnosticRemove(entry[0], entry[1], entry[2]);
    }
  };

  const closeHandler: any = function (): any {
    if (state.abortDisposable !== undefined) {
      const dispose: any = state.abortDisposable.dispose;
      if (__evIsFn(dispose)) __evCall(dispose, []);
      state.abortDisposable = undefined;
    }
    removeAll();
    state.finished = true;
    const done: any = { value: undefined, done: true };
    while (__evLen(state.promises) > 0) {
      const pending: any = state.promises.shift();
      __evCall(pending.resolve, [done]);
    }
    return Promise.resolve(done);
  };

  const errorHandler: any = function (err: any): void {
    if (__evLen(state.promises) === 0) {
      state.error = err;
    } else {
      const pending: any = state.promises.shift();
      __evCall(pending.reject, [err]);
    }
    closeHandler();
  };

  const eventHandler: any = function (value: any): void {
    if (__evLen(state.promises) === 0) {
      state.size = Number(state.size) + 1;
      if (!state.paused && Number(state.size) > Number(highWatermark)) {
        state.paused = true;
        if (__evDuck(emitter, "pause")) emitter.pause();
      }
      state.events.push(value);
    } else {
      const pending: any = state.promises.shift();
      __evCall(pending.resolve, [{ value: value, done: false }]);
    }
  };

  const addTracked: any = function (source: any, name: any, handler: any): void {
    __eventsAgnosticAdd(source, name, handler, false);
    state.attached.push([source, name, handler]);
  };

  const collector: any = function (): void {
    const passed: any[] = [];
    const count = Number(arguments.length);
    for (let i = 0; i < count; i++) passed.push(arguments[i]);
    eventHandler(passed);
  };

  if (!__eventsIsEmitterLike(emitter) && !__eventsIsEventTargetLike(emitter)) {
    throw new ERR_INVALID_ARG_TYPE("emitter", ["EventEmitter", "EventTarget"], emitter);
  }

  addTracked(emitter, event, collector);
  if (!(typeof event === "string" && event === "error") && __eventsIsEmitterLike(emitter)) {
    addTracked(emitter, "error", errorHandler);
  }
  const closeEvents: any = opts.close;
  if (closeEvents !== undefined && closeEvents !== null && __evLen(closeEvents) > 0) {
    for (const closeEvent of closeEvents) addTracked(emitter, closeEvent, closeHandler);
  }

  if (signal !== undefined && signal !== null) {
    state.abortDisposable = __eventsAddAbortListener(signal, function (): void {
      errorHandler(new AbortError(undefined, { cause: signal.reason }));
    });
  }

  const iterator: any = {
    next(): any {
      if (Number(state.size) > 0) {
        const value: any = state.events.shift();
        state.size = Number(state.size) - 1;
        if (state.paused && Number(state.size) < Number(lowWatermark)) {
          if (__evDuck(emitter, "resume")) emitter.resume();
          state.paused = false;
        }
        return Promise.resolve({ value: value, done: false });
      }
      if (state.error !== null && state.error !== undefined) {
        const rejected: any = Promise.reject(state.error);
        state.error = null;
        return rejected;
      }
      if (state.finished) return closeHandler();
      return new Promise(function (resolve: any, reject: any): void {
        state.promises.push({ resolve: resolve, reject: reject });
      });
    },
    return(): any {
      return closeHandler();
    },
    throw(err: any): void {
      if (err === undefined || err === null || !(err instanceof Error)) {
        throw new ERR_INVALID_ARG_TYPE("EventEmitter.AsyncIterator", "Error", err);
      }
      errorHandler(err);
    },
    [Symbol.asyncIterator](): any {
      return this;
    },
  };
  return iterator;
}

// `events.addAbortListener(signal, listener)` → a disposable.
//
// Node returns an object carrying `[Symbol.dispose]`. This engine has no
// `Symbol.dispose`, so the returned object carries a plain `dispose()` as well;
// the symbol-keyed entry is added when the engine grows one.
function __eventsAddAbortListener(signal: any, listener: any): any {
  if (signal === undefined) {
    throw new ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  }
  __evValidateAbortSignal(signal, "signal");
  if (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  }
  __evCheckListener(listener);

  if (signal.aborted === true) {
    // Already aborted: run now, synchronously, like Node.
    __evCall(listener, []);
    return __eventsMakeDisposable(function (): void {});
  }

  const wrapper: any = function (event: any): void {
    __evCall(listener, [event]);
  };
  signal.addEventListener("abort", wrapper, { once: true });
  __eventsTrackTargetListener(signal, "abort", wrapper, true);
  return __eventsMakeDisposable(function (): void {
    signal.removeEventListener("abort", wrapper);
    __eventsTrackTargetListener(signal, "abort", wrapper, false);
  });
}

function __eventsMakeDisposable(dispose: any): any {
  const disposable: any = {};
  __evRawSet(disposable, "dispose", dispose);
  // Only attach the well-known key when the engine has one.
  const key: any = Symbol.dispose;
  if (key !== undefined) disposable[key] = dispose;
  return disposable;
}

// ---------------------------------------------------------------------------
// Module object
//
// `tools/bundle_node_test.sh` rewrites `require('events')` / `require('node:events')`
// to this object. `EventEmitter` itself must stay a class declaration, because
// `new <identifier>()` only compiles for a statically known class.
// ---------------------------------------------------------------------------

const __node_events: any = {
  EventEmitter,
  errorMonitor,
  captureRejectionSymbol,
  captureRejections: false,
  usingDomains: false,
  once: __eventsOnce,
  on: __eventsOn,
  listenerCount: __eventsListenerCount,
  getEventListeners: __eventsGetEventListeners,
  getMaxListeners: __eventsGetMaxListeners,
  setMaxListeners(n?: any, ...targets: any[]): void {
    __eventsSetMaxListeners(n, targets);
  },
  addAbortListener: __eventsAddAbortListener,
  get defaultMaxListeners(): number {
    return __evGetDefaultMaxListeners();
  },
  set defaultMaxListeners(value: number) {
    __evSetDefaultMaxListeners(value);
  },
};

// `require('events').EventEmitter.EventEmitter` and `events.default` are the two
// other spellings the ecosystem uses for the same constructor.
__node_events.EventEmitter = EventEmitter;

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
//   * `__evUnbox` / `__evIsBox` / `__evIsFn` — a function stored in an array
//     still arrives as a `functionBox` record, and `arr.indexOf(fn)` answers -1
//     for a bare one (zun#17). Identity holds (`arr[0] === fn`) and `typeof` a
//     box now says `"function"` rather than `"object"` — which is *why* the
//     unwrap helpers probe both: guarding on `"object"` alone left every boxed
//     callable unopened. `__evBox` is still needed where a listener has to
//     carry a property (a once-wrapper's `.listener`), because a **bare**
//     function loses its own properties on the way into an array.
//   * `__evCall` — a listener is invoked as `fn(...args)` and never as
//     `fn.apply(this, args)`: `apply` threads no receiver into a plain function
//     value, so `this` inside a listener is always `undefined`, and the
//     argument-shifting half of zun#1 is **not** fixed for one either —
//     `f.apply(recv, [a, b])` reaches `f` as `f(recv, a)`. Only an
//     object-literal **method** gets both right. That is the single biggest gap
//     of this module — see ../../test/events/README.md.
//   * `__evRawGet` — a computed read with a *variable* key resolves
//     `Object.prototype`'s members even on a null-prototype object, so
//     `_events[type]` answers `Object.prototype.toString` for the event name
//     `toString`. Every slot read asks `in` first (a new engine regression).
//   * `__evRawSet` — `events.__proto__ = value` sets the *prototype* of a
//     null-prototype object instead of creating an own property, except when
//     the value is a bare callable. `Object.defineProperty` is exact for every
//     other value and is what the helper uses (a new engine regression).
//   * `__evTypes` — the key insertion order is tracked alongside `_events`,
//     because a **symbol** key is invisible to `Object.getOwnPropertySymbols`
//     and `sym in obj` throws (zun#32's remaining half), so `eventNames()`
//     cannot read the full key set back out. String keys *are* visible to
//     `Object.keys`/`getOwnPropertyNames`/`Reflect.ownKeys`/`for-in` in
//     insertion order now, function-valued ones included.
//   * `__evRawDelete` — `delete obj[sym]` is rejected by the checker outright
//     ("`delete obj[k]` requires a string key"), so a symbol slot is blanked
//     with `undefined` instead. A *string* key needs no special case any more:
//     `delete` clears a function-valued property (zun#32).
//   * `splice`'s start index must be an integer, which only an `any`-typed array
//     receiver accepts; array-held flags such as `warned` likewise need an `any`
//     receiver.
//   * the EventTarget side tables keep their keys alive, because `WeakMap` loses
//     its methods through an `any` binding and rejects a non-object value
//     (zun#28). They are real `Map`s again, now that a `Map` survives an `any`
//     binding (zun#7).
//   * `errorMonitor` is a module-level `Symbol` constant, as in Node;
//     `captureRejectionSymbol` is `Symbol.for('nodejs.rejection')`, also as in
//     Node, now that the registry round-trips (zun#23).
//   * `EventEmitter` declares `__zunEventsCapture` rather than attaching it:
//     an undeclared key written onto a typed instance through an `any` alias
//     poisons every later statically typed read of that instance (zun#37).
//   * `Number(x.length)` throughout: the *arithmetic* on `.length` was widened,
//     so `len - 1` and descending loops are correct now, but the checker still
//     types `.length` as `u64`, so it can be neither assigned to nor passed as a
//     `number` (zun#3).
//
// Workarounds this file used to carry and no longer does, because the engine
// fixed what forced them: `emit` is spelled `emit(type, ...args)` again rather
// than ten optional slots, and a rest parameter is a real array through an
// `any` binding and on an `any` receiver too, so zun#11 is closed;
// `prependListener` uses `Array.prototype.unshift`, which accepts a function
// argument again (zun#17); `EventEmitter.defaultMaxListeners`, `.errorMonitor`
// and `.captureRejectionSymbol` are real class statics (zun#20, partly); the
// event-name bookkeeping compares symbols by identity instead of by description
// (zun#23); a class field may be declared without an initializer again
// (zun#27) — the explicit initializers stay because they are what the code
// means, not because the engine demands them; a **symbol**-keyed slot holds
// Node's own shape, the bare listener while there is one, because a function
// value under a symbol key round-trips now, and a function written over a slot
// that holds an object is no longer swallowed, so `__evRawSet` stopped deleting
// first (all three zun#32).

// ---------------------------------------------------------------------------
// Well-known symbols
// ---------------------------------------------------------------------------

// `events.errorMonitor`: a listener installed under this key sees every 'error'
// event without consuming it.
const errorMonitor: any = Symbol("events.errorMonitor");

// `events.captureRejectionSymbol`, spelled as Node spells it. The registry
// round-trip works again (https://github.com/UrubuCode/zun/issues/23), so a
// caller that writes `Symbol.for('nodejs.rejection')` gets *this* symbol; it
// used to be a plain `Symbol`, because `Symbol.for` handed back a fresh symbol
// every time and the two could never meet.
const captureRejectionSymbol: any = Symbol.for("nodejs.rejection");

// Internal flags Node keeps on the instance behind symbols. They are plain
// string keys here, prefixed so they cannot collide with an event name.
//
// `EventEmitter` **declares** a field of this exact name. That is not
// decoration: writing a key a class did not declare onto one of its instances
// through an `any` alias poisons the instance, and every later statically typed
// read of any of its fields throws `Cannot read private member from an object
// whose class did not declare it`
// (https://github.com/UrubuCode/zun/issues/37). `new EventEmitter()` used to do
// exactly that for the rejection flag, which made `ee._events` unreadable from
// a test. Declaring the field keeps the write off the expando path; the dynamic
// spelling `target[__kCaptureKey]` still works, and is what the EventTarget-like
// and plain-object receivers below use.
const __kCaptureKey: string = "__zunEventsCapture";

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

// Unwrap a `functionBox` record back to its callable (zun#17). A box reports
// `typeof === "function"` now (it used to say `"object"`), so the `__boxedFn`
// slot has to be probed for both kinds; the slot reads back the original
// function with identity intact.
function __evUnbox(value: any): any {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return value;
  const inner: any = value["__boxedFn"];
  if (inner !== undefined) return inner;
  return value;
}

// Strict equality that sees through function boxing.
function __evSame(a: any, b: any): boolean {
  return __evUnbox(a) === __evUnbox(b);
}

function __evIsFn(value: any): boolean {
  return typeof __evUnbox(value) === "function";
}

// A bare callable, as opposed to a `functionBox` record holding one. The two
// are indistinguishable by `typeof` now, and the storage layer has to tell them
// apart for the `__proto__` key (see `__evRawSet`).
function __evIsBareFn(value: any): boolean {
  return typeof value === "function" && !__evIsBox(value);
}

// Wrap a callable in a `functionBox` record *deliberately*.
//
// Boxing is normally something this engine does to a function on its way into
// an array; routing a function through a one-element array is therefore the way
// to obtain the box, and the box is still more useful than the bare callable
// for a once-wrapper, because it is a real object:
//   * it survives being returned from an object-literal method, which a
//     function value does not (the return degrades to an opaque object that no
//     longer compares equal to the original);
//   * it keeps the properties written onto it when it enters an array, where a
//     bare function loses every one of them — that is how a once-wrapper
//     carries `.listener`;
//   * it is found by `indexOf`/`includes`, which answer -1/`false` for a bare
//     function (zun#17).
// Two reasons this helper used to exist are gone: a function value assigned
// under a **symbol** key now round-trips, and a function written over a slot
// holding an object is no longer swallowed (zun#32).
// Re-boxing a box is identity-preserving (`[box][0] === box`).
function __evBox(fn: any): any {
  if (__evIsBox(fn)) return fn;
  if (fn !== null && fn !== undefined && typeof fn === "object") return fn;
  const holder: any[] = [fn];
  return holder[0];
}

// Is this value one of those records (as opposed to a bare callable)? A box
// reports `typeof === "function"` now, so both kinds are probed.
function __evIsBox(value: any): boolean {
  if (value === null || value === undefined) return false;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return false;
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

// An event name as a *property key*.
//
// Node stores listeners on a plain object, so an event name that is not a
// symbol goes through the ordinary ToPropertyKey coercion: `ee.on(123, fn)`
// occupies the slot `"123"`, `ee.emit(123)` finds it, and `ee.eventNames()`
// answers `["123"]`. This engine keeps a numeric computed key on a dynamic
// object in a different place from the string of the same digits — the write
// lands somewhere `in`, `Object.keys` and the string-keyed read cannot see it,
// so `ee.on(123, fn)` followed by `ee.listenerCount(123)` answered 0. Every
// slot key and every `__evTypes` entry therefore passes through here, which is
// the coercion Node gets from the object model for free.
function __evKeyOf(type: any): any {
  if (__evIsSymbol(type)) return type;
  return String(type);
}

// `__evTypes` used to be keyed by a *description-derived* id, because a symbol
// never compared equal to itself (`s === s` was `false`) and a dynamic object
// keyed a symbol-valued property by its description. Both are fixed
// (https://github.com/UrubuCode/zun/issues/23): `s === s` holds, two symbols
// with the same description stay distinct, `Symbol.for(k) === Symbol.for(k)`,
// and `_events[sym]` is keyed by identity. A symbol also survives array
// storage with its identity intact, so `indexOf` locates it. The event-name
// bookkeeping below is therefore plain identity, which is both simpler and
// correct for two listeners registered under `Symbol('x')` and `Symbol('x')` —
// the description-derived id merged those two.

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

// ---------------------------------------------------------------------------
// The library's Node error base classes
// ---------------------------------------------------------------------------
//
// Node's coded errors are real `Error` subclasses: `ERR_INVALID_ARG_TYPE` is a
// `TypeError` (so `err instanceof TypeError` holds and `err.name` is
// `"TypeError"`) that additionally carries a `code`. These three bases say that
// in the engine's own terms, and every coded error in this library — here, in
// `path.ts` and in `os.ts` — is built from one of them.
//
// The `code` is a **declared field**, which is the whole point. The spelling the
// library used before — `const e: any = new TypeError(msg); e.code = 'ERR_X';`
// — writes a key the class never declared onto a typed instance through an
// `any` alias, and that poisons the instance: every later statically typed read
// of one of its own members throws `Cannot read private member from an object
// whose class did not declare it`
// (https://github.com/UrubuCode/zun/issues/37). `err.name` is exactly such a
// read, and `assert.throws(fn, { code, name })` — which Node's `test-path.js`
// uses for all 160 of its expectations — performs it. Declaring the field keeps
// the construction off the expando path entirely, so there is no workaround to
// carry: this is simply the correct shape.
//
// `name` is not overridden: a subclass of `TypeError` already reports
// `"TypeError"`, which is what Node reports too. `toString()` **is**
// overridden, on all three, because Node overrides it: every error built by
// `lib/internal/errors.js`' `E()` carries
//
//     toString() { return `${this.name} [${code}]: ${this.message}`; }
//
// so a coded error prints `TypeError [ERR_INVALID_ARG_TYPE]: <message>`
// although `err.name` stays `"TypeError"`. That is not cosmetic -
// `assert.throws(fn, /ERR_SOMETHING/)` matches the regular expression against
// `String(err)`, which is how a large part of Node's corpus spells "this must
// be that error": eleven files in the `stream` corpus alone, and
// `test-diagnostics-channel-symbol-named.js` and
// `test-process-setsourcemapsenabled.js` each do nothing else.
class NodeTypeError extends TypeError {
  code: string = "";
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
  toString(): string {
    return this.name + " [" + this.code + "]: " + this.message;
  }
}

class NodeRangeError extends RangeError {
  code: string = "";
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
  toString(): string {
    return this.name + " [" + this.code + "]: " + this.message;
  }
}

class NodeError extends Error {
  code: string = "";
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
  toString(): string {
    return this.name + " [" + this.code + "]: " + this.message;
  }
}

// `lib/internal/errors.js`' `formatList(array, 'or')`.
function __evFormatList(items: string[], conjunction: string): string {
  const n = Number(items.length);
  if (n === 0) return "";
  if (n === 1) return items[0];
  if (n === 2) return items[0] + " " + conjunction + " " + items[1];
  if (n === 3) {
    return items[0] + ", " + items[1] + ", " + conjunction + " " + items[2];
  }
  return items.slice(0, n - 1).join(", ") + ", " + conjunction + " " + items[n - 1];
}

// The nine type names `internal/errors` treats as *types* rather than classes;
// each is lowercased in the message, which is why `validateFunction`'s
// `'Function'` reads back as "of type function".
const __EV_KTYPES: string[] = [
  "string", "function", "number", "object",
  "Function", "Object", "boolean", "bigint", "symbol",
];

function __evIsKType(value: string): boolean {
  for (const known of __EV_KTYPES) {
    if (known === value) return true;
  }
  return false;
}

// `ERR_INVALID_ARG_TYPE`'s message, assembled exactly as `internal/errors` does
// it: `"name"` becomes `property` rather than `argument` when it contains a dot,
// a name already ending in ` argument` is used verbatim, the nine primitive type
// names are lowercased into an "of type …" clause, a capitalised name becomes an
// "an instance of …" clause, and anything else is emitted as written (with an
// `an ` prefix when it is not all lower case). Node decides the
// instance-versus-other split with a regular expression over the *stringified
// class*; the first-character test is the same decision for every type name the
// library actually passes, and it keeps the classification out of the regex
// engine.
class ERR_INVALID_ARG_TYPE extends NodeTypeError {
  constructor(name: string, expected: any, actual: any) {
    super("ERR_INVALID_ARG_TYPE", __evInvalidArgTypeMessage(name, expected, actual));
  }
}

function __evInvalidArgTypeMessage(name: string, expected: any, actual: any): string {
  const wanted: any[] = Array.isArray(expected) ? expected : [expected];
  let msg = "The ";
  const suffix = " argument";
  if (
    Number(name.length) > Number(suffix.length) &&
    name.slice(Number(name.length) - Number(suffix.length)) === suffix
  ) {
    msg = msg + name + " ";
  } else {
    msg = msg + '"' + name + '" ' + (Number(name.indexOf(".")) !== -1 ? "property" : "argument") + " ";
  }
  msg = msg + "must be ";

  const types: string[] = [];
  const instances: string[] = [];
  const other: string[] = [];
  for (const entry of wanted) {
    const value = String(entry);
    if (__evIsKType(value)) {
      types.push(value.toLowerCase());
    } else if (value !== "" && value.charAt(0) >= "A" && value.charAt(0) <= "Z") {
      instances.push(value);
    } else {
      other.push(value);
    }
  }
  // `object` is folded into the instance list when real classes are also
  // allowed, so the message distinguishes them.
  if (Number(instances.length) > 0) {
    const pos = Number(types.indexOf("object"));
    if (pos !== -1) {
      // `splice`'s start index is only accepted through an `any`-typed array
      // receiver: on a typed one the checker demands an integer literal.
      const mutable: any = types;
      mutable.splice(pos, 1);
      instances.push("Object");
    }
  }

  if (Number(types.length) > 0) {
    msg = msg + (Number(types.length) > 1 ? "one of type " : "of type ") + __evFormatList(types, "or");
    if (Number(instances.length) > 0 || Number(other.length) > 0) msg = msg + " or ";
  }
  if (Number(instances.length) > 0) {
    msg = msg + "an instance of " + __evFormatList(instances, "or");
    if (Number(other.length) > 0) msg = msg + " or ";
  }
  if (Number(other.length) > 0) {
    if (Number(other.length) > 1) {
      msg = msg + "one of " + __evFormatList(other, "or");
    } else {
      if (other[0].toLowerCase() !== other[0]) msg = msg + "an ";
      msg = msg + other[0];
    }
  }
  return msg + "." + __evReceived(actual);
}

// `The ${argument|property} '${name}' ${reason}. Received ${inspect(value)}`,
// with the inspected value truncated at 128 characters, as in `internal/errors`.
class ERR_INVALID_ARG_VALUE extends NodeTypeError {
  constructor(name: string, value: any, reason: string) {
    super("ERR_INVALID_ARG_VALUE", __evInvalidArgValueMessage(name, value, reason));
  }
}

function __evInvalidArgValueMessage(name: string, value: any, reason: string): string {
  let inspected = __evInspect(value);
  if (Number(inspected.length) > 128) inspected = inspected.slice(0, 128) + "...";
  const kind = Number(name.indexOf(".")) !== -1 ? "property" : "argument";
  return "The " + kind + " '" + name + "' " + reason + ". Received " + inspected;
}

class ERR_OUT_OF_RANGE extends NodeRangeError {
  constructor(name: string, range: string, actual: any) {
    super(
      "ERR_OUT_OF_RANGE",
      'The value of "' + name + '" is out of range. It must be ' + range + ". Received " +
        __evInspect(actual),
    );
  }
}

class ERR_UNHANDLED_ERROR extends NodeError {
  context: any;
  constructor(detail: any) {
    super(
      "ERR_UNHANDLED_ERROR",
      detail === undefined ? "Unhandled error." : "Unhandled error. (" + String(detail) + ")",
    );
    this.context = undefined;
  }
}

// `ERR_METHOD_NOT_IMPLEMENTED` lives here, with the error bases, because two
// *conditional* modules raise it -- `fs` for the calls it declares as gaps
// (`createReadStream`, `watch`, `glob`, ...) and `stream` for the hooks a
// subclass has to supply (`_read`, `_write`, `_transform`). Both are inlined
// together whenever a test requires both (six files in the `stream` corpus and
// five in `fs`'s do), and two top-level declarations of one name are a compile
// error in a single Zun program, so the class belongs to neither of them.
class ERR_METHOD_NOT_IMPLEMENTED extends NodeError {
  constructor(name: string) {
    super("ERR_METHOD_NOT_IMPLEMENTED", "The " + name + " method is not implemented");
  }
}

class AbortError extends NodeError {
  cause: any;
  constructor(message?: string, options?: any) {
    super("ABORT_ERR", message === undefined ? "This operation was aborted" : message);
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

// The value lives in `EventEmitter.defaultMaxListeners`, the static field, so
// that Node's two spellings — `EventEmitter.defaultMaxListeners` and
// `events.defaultMaxListeners` — are one storage location rather than two that
// can drift. Static fields read back and can be assigned since
// https://github.com/UrubuCode/zun/issues/20 was partly fixed; before that this
// was a module-level `let` and the class spelling was simply unreachable.
function __evGetDefaultMaxListeners(): number {
  return EventEmitter.defaultMaxListeners;
}

function __evSetDefaultMaxListeners(value: any): void {
  __evValidateNumber(value, "defaultMaxListeners", 0);
  EventEmitter.defaultMaxListeners = value;
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

// ---------------------------------------------------------------------------
// The `node:domain` integration slot
// ---------------------------------------------------------------------------
//
// Node's `lib/domain.js` installs itself by *monkey-patching*: it replaces
// `EventEmitter.init` and `EventEmitter.prototype.emit`, and it registers
// async_hooks callbacks so that every scheduled callback re-enters the domain
// that created it. Neither half is expressible here — this engine has no
// function-constructor/prototype model
// (https://github.com/UrubuCode/zun/issues/25), a class method cannot be read
// as a value (zun#19), and there is no async_hooks tier at all. So each place
// `domain` has to be consulted holds one slot in this record, every slot is
// `null` unless `src/domain/domain.ts` is in the bundle, and that file is the
// record's only writer (through `__evInstallDomainHooks`). Function slots hold
// boxed callables invoked with `__evCall`, for the same reason
// `__evWarningRoute` does.
//
// With no `domain` in the bundle every slot stays `null`, so the whole cost to
// every other module is one null check per `emit`, per constructed emitter,
// per `process.nextTick` drain and per timer fire.
const __domainHooks: any = {
  // The active domain, or `null`. `src/process/process.ts` (`nextTick`) and
  // `src/timers/timers.ts` read it to pair a callback with the domain that
  // scheduled it; `src/domain/domain.ts` is the only writer.
  active: null,
  // `(emitter) => void` — Node's patched `EventEmitter.init`: make a freshly
  // constructed emitter a member of the active domain by filling its declared
  // `domain` field.
  init: null,
  // `(emitter, type, args) => boolean` — Node's patched
  // `EventEmitter.prototype.emit`, which routes an unhandled 'error' to the
  // emitter's domain and runs every other emit inside it.
  emit: null,
  // `(domain, fn, args) => void` — run one domain-paired callback: enter the
  // domain, call `fn`, route a throw to that domain, exit. The hook owns the
  // whole invocation, because the routing has to happen while the domain is
  // still on the stack.
  callback: null,
  // `() => never` — throw ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE:
  // `domain` claims `process.setUncaughtExceptionCaptureCallback` for itself.
  blockCapture: null,
};

function __evInstallDomainHooks(hooks: any): void {
  __domainHooks.init = hooks.init;
  __domainHooks.emit = hooks.emit;
  __domainHooks.callback = hooks.callback;
  __domainHooks.blockCapture = hooks.blockCapture;
}

// Called from the `EventEmitter` constructor and from `init()`, so that each
// call site stays one line.
function __evDomainInit(target: any): void {
  const hook: any = __domainHooks.init;
  if (hook === null || hook === undefined) return;
  __evCall(hook, [target]);
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

// `_events` is `Object.create(null)`, exactly as in Node, so that an event
// named `toString` or `__proto__` is an ordinary key rather than a collision
// with `Object.prototype`. Two engine faults make the plain
// `events[type] = value` / `events[type]` pair wrong on such a name, and the
// three raw helpers below are the whole of the compensation.

// Read a slot. A computed read with a **variable** key resolves
// `Object.prototype`'s members even on a null-prototype object: for the event
// name "toString", `events[type]` answers `Object.prototype.toString` instead
// of `undefined`, so `on('toString', fn)` saw a listener already in the slot
// and stored a two-element list. (The same read spelled with a literal key —
// `events["toString"]` — is correct, so this is the dynamic-key path alone.)
// `in` reports the truth, including for a function-valued property, so every
// slot read asks it first. `sym in obj` throws ("Cannot convert a Symbol value
// to a string"), and a symbol can never collide with an `Object.prototype`
// member, so a symbol key skips the question.
function __evRawGet(events: any, rawType: any): any {
  const type: any = __evKeyOf(rawType);
  if (!__evIsSymbol(type) && !(type in events)) return undefined;
  return events[type];
}

// Write a slot.
//
// `events.__proto__ = value` sets the **prototype** of a null-prototype object
// rather than creating an own property, so the slot for an event named
// `__proto__` is simply lost: the engine applies its `__proto__` rule without
// asking whether `Object.prototype`'s accessor is on the chain at all, which is
// the only thing that makes `__proto__` special. A **bare callable** happens to
// take the ordinary path and land correctly; every other value — an array of
// listeners, or a `functionBox` once-wrapper, which is a record object however
// much `typeof` now calls it a function — has to be installed with
// `Object.defineProperty`, which is exact. The two paths cannot be merged in
// either direction: `defineProperty` with a bare callable stores nothing
// readable, and assignment with anything else loses the slot.
//
// Two reasons this helper used to carry more are gone (zun#32): a function
// written over a slot that holds an object is no longer swallowed, so the
// unconditional `delete` first is unnecessary, and a function value under a
// symbol key round-trips.
function __evRawSet(events: any, rawType: any, value: any): void {
  const type: any = __evKeyOf(rawType);
  if (!__evIsSymbol(type) && type === "__proto__" && !__evIsBareFn(value)) {
    Object.defineProperty(events, type, {
      value: value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }
  events[type] = value;
}

// Clear a slot. `delete obj[sym]` is rejected by the checker outright
// ("`delete obj[k]` requires a string key"), so a symbol slot is blanked
// instead; `__evRawGet` reports `undefined` either way and `eventNames()` reads
// `__evTypes`, so the key that lingers costs nothing. `delete` does clear a
// function-valued property now (zun#32), so a string key needs no special case.
function __evRawDelete(events: any, rawType: any): void {
  const type: any = __evKeyOf(rawType);
  if (__evIsSymbol(type)) {
    events[type] = undefined;
    return;
  }
  delete events[type];
}

function __evSlotGet(target: any, type: any): any {
  const events: any = target._events;
  if (events === undefined || events === null) return undefined;
  return __evRawGet(events, type);
}

function __evSlotSet(target: any, type: any, value: any): void {
  const events: any = target._events;
  if (events === undefined || events === null) return;
  // A symbol-keyed slot used to hold the *boxed* form of a callable, because a
  // bare function assigned under a symbol key was silently dropped (zun#32).
  // It round-trips now, so a symbol slot keeps Node's shape like every other.
  __evRawSet(events, type, value);
  __evTrackType(target, type);
}

function __evSlotDelete(target: any, type: any): void {
  const events: any = target._events;
  if (events === undefined || events === null) return;
  __evRawDelete(events, type);
  const types: any = target.__evTypes;
  if (types === undefined) return;
  const at = Number(types.indexOf(__evKeyOf(type)));
  if (at >= 0) types.splice(at, 1);
}

function __evTrackType(target: any, rawType: any): void {
  const type: any = __evKeyOf(rawType);
  let types: any = target.__evTypes;
  if (types === undefined) {
    types = [];
    target.__evTypes = types;
  }
  if (Number(types.indexOf(type)) >= 0) return;
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

// The value to store when a slot holds exactly one listener: the bare callable,
// so that `_events.foo === listener` holds as in Node. A symbol key used to
// need the boxed form here, because a bare callable under a symbol key was
// dropped; it round-trips now (zun#32).
function __evSingleFor(type: any, listener: any): any {
  if (__evIsBox(listener) && listener.listener !== undefined) {
    // A once-wrapper: keep the box, it is what carries `.listener`.
    return listener;
  }
  return __evUnbox(listener);
}

// `events.defaultMaxListeners` resolution for a target.
function __evMaxListenersOf(target: any): number {
  const own: any = target._maxListeners;
  if (own === undefined) return __evGetDefaultMaxListeners();
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
      // `Array.prototype.unshift` accepts a function argument again, so a
      // prepend mutates the list in place as in Node. It used to rebuild the
      // list and copy the `warned` flag across
      // (https://github.com/UrubuCode/zun/issues/17).
      (list as any).unshift(listener);
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
  // A **rest parameter**, not the implicit call-arguments object. The
  // parser looks for that word textually anywhere inside a function's
  // source span and, where it finds it, injects a synthetic trailing rest
  // parameter into the *enclosing* function too
  // (https://github.com/UrubuCode/zun/issues/40); a dynamic call through an
  // `any` receiver -- which `events.once(...)` and `events.on(...)` are, as
  // the module object is the only lane to them -- then leaves that synthetic
  // parameter unbound and the injected spread aborts with "spread: value is
  // not iterable". The listener is invoked as `fn(...args)` by `__evCall`,
  // so a real rest parameter sees exactly the same list.
  const wrapped: any = function (...passed: any[]): any {
    if (state.fired === true) return undefined;
    state.fired = true;
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

// `listenerCount` for one target, shared by the instance method and the
// prototype method so the two spellings cannot drift. The optional `listener`
// argument counts only the matching registrations, and a once-wrapper is
// matched through its `.listener` slot, as Node does.
function __evListenerCountOf(target: any, type: any, listener: any): number {
  if (listener === undefined) return __evCountOf(target, type);
  __evCheckListener(listener);
  const list: any = __evListOf(target, type);
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
  // The `captureRejections` flag, declared rather than attached: see
  // `__kCaptureKey` above and https://github.com/UrubuCode/zun/issues/37.
  __zunEventsCapture: boolean = false;
  // `node:domain`'s property, which `lib/domain.js` installs from its patched
  // `EventEmitter.init` on every emitter — `null` outside a domain, the active
  // domain inside one. It is a **declared** field rather than a property added
  // from the outside for two reasons: Node's own domain tests read it off a
  // statically typed emitter (`e.domain`, which is a compile error for a field
  // no class declares), and a property added to a class instance afterwards
  // poisons every later typed read of that instance's own fields
  // (https://github.com/UrubuCode/zun/issues/37). The one cost is that it is
  // enumerable where Node's is not, which is already true of `__evTypes` and
  // `__zunEventsCapture`. With no `domain` in the bundle it simply stays
  // `null`, which is what Node answers too.
  domain: any = null;

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
    // `node:domain`'s patched `EventEmitter.init`: a no-op unless
    // `src/domain/domain.ts` is in the bundle. See `__domainHooks`.
    __evDomainInit(self);
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
    __evDomainInit(self);
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

  // A class method's rest parameter is a real array again, so `emit` is spelled
  // the way Node spells it. It used to be ten explicit optional slots with the
  // trailing `undefined`s trimmed, because the rest parameter was `undefined`
  // with no rest arguments and the bare value with one
  // (https://github.com/UrubuCode/zun/issues/11, now closed: a rest parameter
  // is a real array through an `any` binding and on an `any` receiver too).
  // That cost two observable deviations which are now gone:
  // `emit('x', undefined)` is a one-argument emit again, and an emit may carry
  // more than ten arguments.
  emit(type: any, ...args: any[]): boolean {
    // `node:domain` replaces `EventEmitter.prototype.emit` in Node; here it
    // fills one slot instead and the routing runs ahead of the real dispatch,
    // which it reaches by calling `__evEmit` itself. `process.emit` calls
    // `__evEmit` directly, which is exactly Node's `this === process`
    // exclusion. See `__domainHooks`.
    const route: any = __domainHooks.emit;
    if (route !== null && route !== undefined) {
      return __evCall(route, [this, type, args]) === true;
    }
    return __evEmit(this, type, args);
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
  // instance form wins and the static is reachable through the module object
  // (`__node_events.listenerCount`) -- which is the same function in Node, and
  // which is why `tools/bundle_node_test.sh` routes `EventEmitter.listenerCount(`
  // there. The body is `__evListenerCountOf` so that this method and
  // `EventEmitter.prototype.listenerCount` cannot drift apart.
  listenerCount(type: any, listener?: any): number {
    return __evListenerCountOf(this, type, listener);
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

  // ---- module statics, reachable as `EventEmitter.<name>` ------------------
  //
  // A class static *field* now reads back and can be assigned
  // (https://github.com/UrubuCode/zun/issues/20), so the three value-shaped
  // statics Node's corpus reaches for are here, as Node has them.
  // `defaultMaxListeners` is the single source of truth: the emitter resolves a
  // target's limit through `__evGetDefaultMaxListeners`, which reads *this*
  // field, and the module object's accessor pair writes it. So
  // `EventEmitter.defaultMaxListeners = 3` and `events.defaultMaxListeners = 3`
  // are the same assignment, exactly as in Node. The direct field write skips
  // `validateNumber`, which the accessor on the module object still applies.
  //
  // Two parts of #20 are still open and shape what can live here: a static may
  // not share a name with an instance method ("duplicate method"), which keeps
  // `EventEmitter.once`, `EventEmitter.listenerCount`, `EventEmitter.on`,
  // `EventEmitter.getMaxListeners` and `EventEmitter.setMaxListeners` on the
  // module object alone; and reading a static through an `any`-typed *class
  // value* panics the interpreter, so nothing here may be reached that way.
  static defaultMaxListeners: number = 10;
  static errorMonitor: any = errorMonitor;
  static captureRejectionSymbol: any = captureRejectionSymbol;
  static usingDomains: boolean = false;

  static addAbortListener(signal: any, listener: any): any {
    return __eventsAddAbortListener(signal, listener);
  }
}

// ---------------------------------------------------------------------------
// EventEmitter.prototype
// ---------------------------------------------------------------------------
//
// `EventEmitter.prototype` is a documented, reachable object in Node, and three
// spellings in Node's own corpus go through it:
// `EventEmitter.prototype.on.call(recv, type, listener)` (an emitter method
// applied to a plain object), `EventEmitter.prototype.emit.apply(ee, args)` (the
// variadic-emit exercise) and `EventEmitter.prototype.constructor.name`.
//
// This engine's class prototype object carries neither `constructor` nor the
// class's methods (https://github.com/UrubuCode/zun/issues/51), and a class
// method may not be read as a value (https://github.com/UrubuCode/zun/issues/19)
// — but the prototype object itself is real, stable and writable, so Node's
// shape is installed onto it here.
//
// The **shape of each entry matters**, and only one shape works. A plain
// function value threads no receiver: `f.call(recv, a, b)` and
// `f.apply(recv, [a, b])` both deliver the arguments correctly on this build but
// leave `this` undefined (https://github.com/UrubuCode/zun/issues/1). An
// **object-literal method** is the one callable the engine does thread a
// receiver into — `m.call(recv, a, b)` and `m.apply(recv, [a, b])` bind `this`
// to `recv` *and* pass the arguments through, and it keeps doing so after being
// read out of the literal and stored in a property. So every prototype entry
// below is an object-literal method whose body forwards `this` to the same free
// function the class method calls; the class and the prototype are therefore two
// spellings of one implementation, never two implementations.
//
// Each method value also carries its own `name`, because a function's `name` is
// otherwise unavailable here (https://github.com/UrubuCode/zun/issues/25) and
// `test-event-emitter-method-names.js` asserts `E[name].name === name` for
// every function on the prototype. `on` and `off` are *aliases* of the
// `addListener` and `removeListener` values, exactly as `lib/events.js` writes
// them — which is why `E.on === E.addListener` holds and why `E.on.name` is
// `"addListener"` in Node too.
const __evProtoMethods: any = {
  setMaxListeners(n: any): any {
    const self: any = this;
    __evValidateNumber(n, "setMaxListeners", 0);
    self._maxListeners = n;
    return self;
  },
  getMaxListeners(): number {
    return __evMaxListenersOf(this);
  },
  emit(type: any, ...args: any[]): boolean {
    return __evEmit(this, type, args);
  },
  addListener(type: any, listener: any): any {
    return __evAddListener(this, type, listener, false);
  },
  prependListener(type: any, listener: any): any {
    return __evAddListener(this, type, listener, true);
  },
  once(type: any, listener: any): any {
    const self: any = this;
    __evCheckListener(listener);
    return __evAddListener(self, type, __evOnceWrap(self, type, listener), false);
  },
  prependOnceListener(type: any, listener: any): any {
    const self: any = this;
    __evCheckListener(listener);
    return __evAddListener(self, type, __evOnceWrap(self, type, listener), true);
  },
  removeListener(type: any, listener: any): any {
    return __evRemoveListener(this, type, listener);
  },
  removeAllListeners(type?: any): any {
    return __evRemoveAllListeners(this, type, type !== undefined);
  },
  listeners(type?: any): any[] {
    return __evListeners(this, type, true);
  },
  rawListeners(type?: any): any[] {
    return __evListeners(this, type, false);
  },
  listenerCount(type: any, listener?: any): number {
    return __evListenerCountOf(this, type, listener);
  },
  eventNames(): any[] {
    return __evEventNames(this);
  },
};

// Install one method under its own name. The `name` write is what makes the
// value self-describing; it has to happen before the value is aliased, so an
// alias reports the name of the function it aliases (Node's behaviour).
function __evInstallProtoMethod(proto: any, name: string, method: any): void {
  const callable: any = method;
  callable.name = name;
  proto[name] = callable;
}

const __evPrototype: any = EventEmitter.prototype;

__evPrototype.constructor = EventEmitter;
// `lib/events.js` puts the three bookkeeping slots on the prototype as the
// defaults an emitter that skipped `init()` inherits.
__evPrototype._events = undefined;
__evPrototype._eventsCount = 0;
__evPrototype._maxListeners = undefined;

__evInstallProtoMethod(__evPrototype, "setMaxListeners", __evProtoMethods.setMaxListeners);
__evInstallProtoMethod(__evPrototype, "getMaxListeners", __evProtoMethods.getMaxListeners);
__evInstallProtoMethod(__evPrototype, "emit", __evProtoMethods.emit);
__evInstallProtoMethod(__evPrototype, "addListener", __evProtoMethods.addListener);
__evInstallProtoMethod(__evPrototype, "prependListener", __evProtoMethods.prependListener);
__evInstallProtoMethod(__evPrototype, "once", __evProtoMethods.once);
__evInstallProtoMethod(
  __evPrototype,
  "prependOnceListener",
  __evProtoMethods.prependOnceListener,
);
__evInstallProtoMethod(__evPrototype, "removeListener", __evProtoMethods.removeListener);
__evInstallProtoMethod(
  __evPrototype,
  "removeAllListeners",
  __evProtoMethods.removeAllListeners,
);
__evInstallProtoMethod(__evPrototype, "listeners", __evProtoMethods.listeners);
__evInstallProtoMethod(__evPrototype, "rawListeners", __evProtoMethods.rawListeners);
__evInstallProtoMethod(__evPrototype, "listenerCount", __evProtoMethods.listenerCount);
__evInstallProtoMethod(__evPrototype, "eventNames", __evProtoMethods.eventNames);
// `on` is `addListener` and `off` is `removeListener` — the same value under a
// second key, as `lib/events.js` assigns them.
__evPrototype.on = __evPrototype.addListener;
__evPrototype.off = __evPrototype.removeListener;

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
// A `Map` again, now that a `Map` read through an `any` binding keeps its
// methods (https://github.com/UrubuCode/zun/issues/7). These used to be two
// parallel arrays with a linear scan, which is what the `__evTable*` shape is
// left over from; the three accessors stay so the call sites read the same
// either way.
//
// A `WeakMap` is still the structurally right answer and is still unusable, and
// worse than before: `new WeakMap().set(key, 1)` now aborts the VM outright
// with "call did not resolve to a method", which no `try`/`catch` can contain
// (https://github.com/UrubuCode/zun/issues/28). So these tables keep their keys
// alive, which is a leak traded for working lookups — one entry per EventTarget
// a program touches.
function __evTableNew(): any {
  return new Map();
}

function __evTableGet(table: any, key: any): any {
  return table.get(key);
}

function __evTableSet(table: any, key: any, value: any): void {
  table.set(key, value);
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
    if (__eventsIsEventTargetLike(emitterOrTarget)) return __evGetDefaultMaxListeners();
  }
  throw new ERR_INVALID_ARG_TYPE("emitter", ["EventEmitter", "EventTarget"], emitterOrTarget);
}

function __eventsSetMaxListeners(n: any, targets: any[]): void {
  const value = n === undefined ? __evGetDefaultMaxListeners() : n;
  __evValidateNumber(value, "setMaxListeners", 0);
  if (targets === undefined || __evLen(targets) === 0) {
    EventEmitter.defaultMaxListeners = value;
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

    // A rest parameter, for the reason given above `__evOnceWrap`'s wrapper
    // (https://github.com/UrubuCode/zun/issues/40).
    const resolver: any = function (...passed: any[]): any {
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

  // A rest parameter, for the reason given above `__evOnceWrap`'s wrapper
  // (https://github.com/UrubuCode/zun/issues/40).
  const collector: any = function (...passed: any[]): void {
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

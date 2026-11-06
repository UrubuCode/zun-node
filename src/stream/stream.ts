// node:stream — Stream, Readable, Writable, Duplex, Transform, PassThrough,
// pipeline, finished, compose and the async operators, in Zun TypeScript.
//
// Behavior is defined by Node.js 25. The state machines here follow Node's own
// `lib/internal/streams/*.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) instruction for instruction — `readable.js`, `writable.js`,
// `duplex.js`, `transform.js`, `passthrough.js`, `legacy.js`, `destroy.js`,
// `end-of-stream.js`, `pipeline.js`, `operators.js`, `from.js`,
// `add-abort-signal.js`, `state.js`, `utils.js` and `lib/stream.js` — because
// the observable contract of a Node stream *is* that code: which of 'end',
// 'finish', 'close' and 'error' fires, in which tick, relative to
// `process.nextTick` and the microtask queue, is pinned by the corpus and is
// not derivable from any general rule. Node 25 stores the two states in bit
// fields; the fields are plain properties here, because a test reads
// `_readableState.needReadable` and `_writableState.pendingcb` directly and the
// bit packing is an optimization, not part of the contract.
//
// Like `path`, `events` and `url`, `stream` is pure computation — no syscalls —
// so it is written in the language the platform compiles rather than behind the
// `zun_abi` boundary (PLAN.md principle 2). It stands on `events`
// (EventEmitter and the `ERR_*`/`AbortError` bases), `process` (`nextTick`),
// `buffer` (encoding names and `ERR_UNKNOWN_ENCODING`) and `string_decoder`
// (`setEncoding`), which is exactly the dependency set `lib/internal/streams`
// has.
//
// ---------------------------------------------------------------------------
// The two shapes this engine forces, and why they are not arbitrary
// ---------------------------------------------------------------------------
//
// 1. **State objects are plain objects, not classes.** A function assigned to
//    a *class field* is unreachable afterwards: `typeof` answers `"object"`
//    and calling it throws `is not a function` (a new engine bug, reported
//    with this work). `WritableState.onwrite` is exactly such a field, and the
//    option callbacks (`read`, `write`, `writev`, `final`, `destroy`,
//    `construct`, `transform`, `flush`) are the same shape. A **plain object**
//    property holds a callable correctly, threads a receiver through
//    `fn.call(stream, ...)`, and lets the states carry the arbitrary field set
//    Node's tests read. So `_readableState` / `_writableState` are built by
//    `__sNewReadableState` / `__sNewWritableState` rather than by a
//    constructor, and the option callbacks live in `state.fns`.
//
// 2. **`_read`/`_write`/`_final`/`_writev`/`_construct`/`_destroy` are real
//    class methods that consult `state.fns`.** Subclassing is how streams are
//    used (`class MyReadable extends Readable { _read() {} }`), and virtual
//    dispatch works: a free function that calls `stream._read(n)` reaches the
//    subclass's override with `this` bound. Node decides whether to run the
//    `_final` / `_writev` / `_construct` machinery with
//    `typeof stream._final === 'function'`, which cannot be asked here — a
//    class method is not readable as a value (zun#19), and a class prototype
//    carries no methods to reflect over (zun#51). So the *base* implementation
//    of each optional hook throws the module-private sentinel `__S_NO_IMPL`
//    when neither an option nor an override supplied one, and the caller
//    catches that sentinel to take Node's "hook absent" branch. The throw is
//    synchronous and happens before any user code could run, so the state the
//    caller had already set is simply rolled back.
//
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues):
//   * `__sCall` — a callback is invoked through `__evUnbox` and then
//     `fn.call(receiver, ...)`. `apply` threads no receiver and shifts its
//     arguments (zun#1), but `call` on an *unboxed* callable does thread one,
//     which is what lets `new Readable({ read() { this.push(...) } })` work.
//     Explicit arities, because `.call` miscounts `arguments.length` by one.
//   * `__sIsFn` / `__evUnbox` — a function held in an array or crossing the
//     `Any` lane arrives as a `functionBox` record (zun#17, zun#50).
//   * `Number(x.length)` throughout: `.length` is typed `u64` at the type
//     level (zun#3).
//   * byte-mode string chunks stay **strings** rather than becoming Buffers.
//     `Buffer.from(chunk)` does not compile when `chunk` is an `any`
//     (zun#58), a byte view read back through an `any` has no `length`,
//     no index and no `toString` (zun#38), and the GC frees a live view's
//     backing store (zun#55) — so a Buffer built here would be both
//     unreachable to the test and unsafe. The accounting still uses Node's
//     numbers: `__sChunkLen` charges a string its **UTF-8 byte length**, which
//     is what Node's `Buffer.byteLength` would have charged. A chunk that
//     arrives *as* a Buffer or `Uint8Array` is passed through untouched and
//     measured through the typed `Buffer` lane (`__sViewLen`), which does work.
//     This is the module's one deliberate deviation and it lives in one place.
//   * `__sTryConstruct` runs `_construct` synchronously from the constructor
//     instead of on the next tick, because presence can only be discovered by
//     calling it (see 2 above). The completion callback still defers through
//     `process.nextTick`, so only the *start* of construction moves one tick
//     earlier.
//   * a class setter reached through an `any` receiver panics the interpreter
//     (a new engine bug, reported with this work), so nothing here assigns to
//     an accessor through an `any` alias; the state field is written directly.

// ---------------------------------------------------------------------------
// Sentinels
// ---------------------------------------------------------------------------

// Thrown by a base-class hook that has no implementation behind it. See note 2.
const __S_NO_IMPL: any = { zunStreamNoImpl: true };

// `kEmpty` / `kEof` from `lib/internal/streams/operators.js`.
const __S_EMPTY: any = { zunStreamEmpty: true };
const __S_EOF: any = { zunStreamEof: true };

// ---------------------------------------------------------------------------
// Errors
//
// `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE`, `ERR_OUT_OF_RANGE` and
// `AbortError` come from ../events/events.ts, `ERR_MISSING_ARGS` and
// `ERR_INVALID_RETURN_VALUE` from ../util/util.ts and `ERR_UNKNOWN_ENCODING`
// from ../buffer/buffer.ts — the same sharing Node's `internal/errors` gives
// its modules.
// ---------------------------------------------------------------------------

class ERR_METHOD_NOT_IMPLEMENTED extends NodeError {
  constructor(name: string) {
    super("ERR_METHOD_NOT_IMPLEMENTED", "The " + name + " method is not implemented");
  }
}

class ERR_STREAM_PUSH_AFTER_EOF extends NodeError {
  constructor() {
    super("ERR_STREAM_PUSH_AFTER_EOF", "stream.push() after EOF");
  }
}

class ERR_STREAM_UNSHIFT_AFTER_END_EVENT extends NodeError {
  constructor() {
    super("ERR_STREAM_UNSHIFT_AFTER_END_EVENT", "stream.unshift() after end event");
  }
}

class ERR_STREAM_WRITE_AFTER_END extends NodeError {
  constructor() {
    super("ERR_STREAM_WRITE_AFTER_END", "write after end");
  }
}

class ERR_STREAM_ALREADY_FINISHED extends NodeError {
  constructor(name: string) {
    super("ERR_STREAM_ALREADY_FINISHED", "Cannot call " + name + " after a stream was finished");
  }
}

class ERR_STREAM_DESTROYED extends NodeError {
  constructor(name: string) {
    super("ERR_STREAM_DESTROYED", "Cannot call " + name + " after a stream was destroyed");
  }
}

class ERR_STREAM_NULL_VALUES extends NodeTypeError {
  constructor() {
    super("ERR_STREAM_NULL_VALUES", "May not write null values to stream");
  }
}

class ERR_STREAM_CANNOT_PIPE extends NodeError {
  constructor() {
    super("ERR_STREAM_CANNOT_PIPE", "Cannot pipe, not readable");
  }
}

class ERR_STREAM_PREMATURE_CLOSE extends NodeError {
  constructor() {
    super("ERR_STREAM_PREMATURE_CLOSE", "Premature close");
  }
}

class ERR_STREAM_UNABLE_TO_PIPE extends NodeError {
  constructor() {
    super("ERR_STREAM_UNABLE_TO_PIPE", "Cannot pipe to a closed or destroyed stream");
  }
}

class ERR_MULTIPLE_CALLBACK extends NodeError {
  constructor() {
    super("ERR_MULTIPLE_CALLBACK", "Callback called multiple times");
  }
}

class ERR_ILLEGAL_CONSTRUCTOR extends NodeTypeError {
  constructor() {
    super("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
  }
}

// `lib/internal/streams/operators.js`' ReduceAwareErrMissingArgs: an
// `ERR_MISSING_ARGS` whose message is specific to `reduce`.
class ERR_STREAM_REDUCE_MISSING_ARGS extends NodeTypeError {
  constructor() {
    super("ERR_MISSING_ARGS", "Reduce of an empty stream requires an initial value");
  }
}

// `aggregateTwoErrors` from `lib/internal/errors.js`, without a real
// `AggregateError` (the engine has no such constructor): the earlier error
// keeps its code and message and carries both on `.errors`, which is what the
// corpus observes.
class __SAggregateError extends NodeError {
  errors: any[] = [];
  constructor(code: string, message: string, errors: any[]) {
    super(code, message);
    this.errors = errors;
  }
}

function __sAggregateTwoErrors(err: any, previous: any): any {
  if (previous !== undefined && previous !== null && err !== previous) {
    if (err === undefined || err === null) return previous;
    const existing: any = previous.errors;
    if (Array.isArray(existing)) {
      existing.push(err);
      return previous;
    }
    const code: any = previous.code;
    return new __SAggregateError(
      typeof code === "string" && code !== "" ? code : "ERR_STREAM_DESTROYED",
      String(previous.message),
      [previous, err],
    );
  }
  return err === undefined || err === null ? previous : err;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

function __sIsFn(value: any): boolean {
  return __evIsFn(value);
}

function __sIsObj(value: any): boolean {
  return value !== null && value !== undefined && typeof value === "object";
}

function __sLen(value: any): number {
  return Number(value.length);
}

// Invoke `fn` with `self` as its receiver.
//
// `__evUnbox` first: a callable that reached here through an array or an `any`
// lane is a `functionBox` record (zun#17/#50), and the record itself carries no
// `call`. The unboxed callable *does* thread a receiver through `.call`, which
// is the only spelling in this engine that does — `apply` threads none and
// shifts (zun#1). Explicit arities, because `.call` reports
// `arguments.length` one too high when it pads.
function __sCall(fn: any, self: any, args: any[]): any {
  const target: any = __evUnbox(fn);
  if (self === undefined || self === null) return target(...args);
  const n = Number(args.length);
  if (n === 0) return target.call(self);
  if (n === 1) return target.call(self, args[0]);
  if (n === 2) return target.call(self, args[0], args[1]);
  if (n === 3) return target.call(self, args[0], args[1], args[2]);
  return target.call(self, args[0], args[1], args[2], args[3]);
}

// A callback with no receiver of its own, which is every `cb(err)` here.
function __sInvoke(fn: any, args: any[]): any {
  const target: any = __evUnbox(fn);
  return target(...args);
}

function __sNop(a?: any, b?: any): void {}

// `once(fn)` from `lib/internal/util.js`: the wrapper runs its target at most
// once. The flag lives in a one-field object so the two closures share it.
function __sOnce(fn: any): any {
  const guard: any = { called: false, target: fn };
  return function (a: any, b: any): any {
    if (guard.called) return undefined;
    guard.called = true;
    return __sInvoke(guard.target, [a, b]);
  };
}

// `process.nextTick` with up to three extra arguments. `__processNextTick` is
// ../process/process.ts' FIFO queue, which is what the harness watches to
// decide the loop has gone quiet.
// The arity branches matter: a callback reached through `process.nextTick` must
// see the exact argument count Node gives it, because `common.mustCall`
// forwards what it receives and several tests assert on it.
function __sTick(fn: any, a?: any, b?: any, c?: any): void {
  if (c !== undefined) {
    __processNextTick(fn, a, b, c);
  } else if (b !== undefined) {
    __processNextTick(fn, a, b);
  } else if (a !== undefined) {
    __processNextTick(fn, a);
  } else {
    __processNextTick(fn);
  }
}

// `process.nextTick(cb, err)` where `err` may legitimately be `null` — the
// branching form above would drop a `null`, which is the argument Node's
// `write(chunk, cb)` callback is given on success.
function __sTick1(fn: any, a: any): void {
  __processNextTick(fn, a);
}

// ---------------------------------------------------------------------------
// Chunk measurement
//
// The one place the Buffer deviation described in the header lives.
// ---------------------------------------------------------------------------

// The length of a byte view, through the typed `Buffer` lane — the only lane on
// which a view is not opaque (zun#38).
function __sViewLen(view: Buffer): number {
  return Number(view.length);
}

function __sIsView(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  return Buffer.isBuffer(value) === true;
}

// The UTF-8 byte length of a string: what `Buffer.byteLength(s, 'utf8')` would
// answer, computed here so the accounting matches Node even though the chunk
// stays a string.
function __sUtf8Len(text: string): number {
  let total = 0;
  const count = Number(text.length);
  let i = 0;
  while (i < count) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      total = total + 1;
    } else if (code < 0x800) {
      total = total + 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < count) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        total = total + 4;
        i = i + 2;
        continue;
      }
      total = total + 3;
    } else {
      total = total + 3;
    }
    i = i + 1;
  }
  return total;
}

// The number `state.length` is charged for one chunk.
function __sChunkLen(state: any, chunk: any): number {
  if (state.objectMode === true) return 1;
  if (typeof chunk === "string") {
    // With a decoder installed the buffer holds decoded strings and Node
    // charges `chunk.length` (code units), not bytes.
    return state.decoder !== null && state.decoder !== undefined
      ? Number(chunk.length)
      : __sUtf8Len(chunk);
  }
  if (__sIsView(chunk)) return __sViewLen(chunk);
  if (chunk === null || chunk === undefined) return 0;
  const reported: any = chunk.length;
  return typeof reported === "number" ? Number(reported) : 0;
}

function __sViewSlice(view: Buffer, from: number, to: number): Buffer {
  return view.slice(from, to);
}

// `chunk.slice(from, to)` for both a string and a byte view.
function __sChunkSlice(chunk: any, from: number, to: number): any {
  if (typeof chunk === "string") return chunk.slice(from, to);
  if (__sIsView(chunk)) return __sViewSlice(chunk, from, to);
  return chunk;
}

function __sViewConcat(list: any[]): Buffer {
  return Buffer.concat(list);
}

function __sViewToString(view: Buffer, encoding: string): string {
  return view.toString(encoding);
}

function __sChunkToString(chunk: any, encoding: string): string {
  if (typeof chunk === "string") return chunk;
  if (__sIsView(chunk)) return __sViewToString(chunk, encoding);
  return String(chunk);
}

// Join the chunks of a byte-mode buffer list. Strings concatenate; views go
// through `Buffer.concat`; a mixed list is joined as strings, which only
// happens when a test pushes both kinds into one non-object-mode stream.
function __sJoinChunks(list: any[]): any {
  const count = Number(list.length);
  if (count === 0) return "";
  if (count === 1) return list[0];
  let allViews = true;
  for (const item of list) {
    if (!__sIsView(item)) {
      allViews = false;
      break;
    }
  }
  if (allViews) return __sViewConcat(list);
  let text = "";
  for (const item of list) text = text + __sChunkToString(item, "utf8");
  return text;
}

// ---------------------------------------------------------------------------
// Validators (`lib/internal/validators.js`)
// ---------------------------------------------------------------------------

function __sValidateFunction(value: any, name: string): void {
  if (!__sIsFn(value)) throw new ERR_INVALID_ARG_TYPE(name, "function", value);
}

function __sValidateObject(value: any, name: string): void {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
  }
}

function __sValidateBoolean(value: any, name: string): void {
  if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
}

function __sValidateAbortSignal(signal: any, name: string): void {
  if (signal === undefined || signal === null) return;
  if (typeof signal !== "object" || signal.aborted === undefined) {
    throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
  }
}

function __sValidateInteger(value: any, name: string, min: number): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  if (Number(value) < min) throw new ERR_OUT_OF_RANGE(name, ">= " + String(min), value);
}

// `lib/internal/streams/operators.js`' toIntegerOrInfinity.
function __sToIntegerOrInfinity(value: any): number {
  const n = Number(value);
  if (Number.isNaN(n)) return 0;
  if (n < 0) throw new ERR_OUT_OF_RANGE("number", ">= 0", value);
  return n;
}

// ---------------------------------------------------------------------------
// High water marks (`lib/internal/streams/state.js`)
// ---------------------------------------------------------------------------

// Node's own comment on the byte default: "For some reason Windows CI fails
// with bigger hwm".
const __sDefaultHwm: any = {
  bytes: process.platform === "win32" ? 16 * 1024 : 64 * 1024,
  objectMode: 16,
};

function __sGetDefaultHighWaterMark(objectMode?: any): number {
  return objectMode === true ? Number(__sDefaultHwm.objectMode) : Number(__sDefaultHwm.bytes);
}

function __sSetDefaultHighWaterMark(objectMode: any, value: any): void {
  __sValidateInteger(value, "value", 0);
  if (objectMode === true) {
    __sDefaultHwm.objectMode = Number(value);
  } else {
    __sDefaultHwm.bytes = Number(value);
  }
}

function __sHighWaterMarkFrom(options: any, isDuplex: boolean, duplexKey: string): any {
  const direct: any = options.highWaterMark;
  if (direct !== undefined && direct !== null) return direct;
  if (isDuplex) {
    const scoped: any = options[duplexKey];
    return scoped === undefined ? null : scoped;
  }
  return null;
}

function __sGetHighWaterMark(state: any, options: any, duplexKey: string, isDuplex: boolean): number {
  const hwm: any = __sHighWaterMarkFrom(options, isDuplex, duplexKey);
  if (hwm !== undefined && hwm !== null) {
    if (!Number.isInteger(hwm) || Number(hwm) < 0) {
      const name = isDuplex ? "options." + duplexKey : "options.highWaterMark";
      throw new ERR_INVALID_ARG_VALUE(name, hwm, "is invalid");
    }
    return Math.floor(Number(hwm));
  }
  return __sGetDefaultHighWaterMark(state.objectMode === true);
}

// ---------------------------------------------------------------------------
// The option-callback store
//
// `state.fns` holds the hooks the options object supplied. A plain object
// property is the only place a callable survives here (see note 1 in the
// header), and it is also what makes `fn.call(stream, ...)` thread the stream
// as the receiver.
// ---------------------------------------------------------------------------

function __sStateOf(stream: any): any {
  const w: any = stream._writableState;
  if (w !== undefined && w !== null) return w;
  return stream._readableState;
}

// The store is shared between the two sides of a Duplex, because Node assigns
// both `this._write = options.write` and `this._read = options.read` onto the
// one instance.
function __sFns(stream: any): any {
  const r: any = stream._readableState;
  if (r !== undefined && r !== null) return r.fns;
  const w: any = stream._writableState;
  return w === undefined || w === null ? null : w.fns;
}

function __sOptFn(stream: any, name: string): any {
  const fns: any = __sFns(stream);
  if (fns === null || fns === undefined) return undefined;
  const found: any = fns[name];
  return __sIsFn(found) ? found : undefined;
}

function __sSetOptFn(stream: any, name: string, fn: any): void {
  const fns: any = __sFns(stream);
  if (fns === null || fns === undefined) return;
  fns[name] = fn;
}

// Collect the hooks an options object supplies. Node writes them onto the
// instance; they go in the store here.
function __sAdoptOptions(fns: any, options: any): void {
  if (!__sIsObj(options)) return;
  for (const name of [
    "read",
    "write",
    "writev",
    "final",
    "destroy",
    "construct",
    "transform",
    "flush",
  ]) {
    const candidate: any = options[name];
    if (__sIsFn(candidate)) fns[name] = candidate;
  }
}

// ---------------------------------------------------------------------------
// ReadableState / WritableState (`readable.js`, `writable.js`)
// ---------------------------------------------------------------------------

function __sNewReadableState(options: any, stream: any, isDuplex: boolean): any {
  const opts: any = options === undefined || options === null ? {} : options;
  const state: any = {
    objectMode: false,
    highWaterMark: 0,
    buffer: [],
    length: 0,
    pipes: [],
    flowing: null,
    ended: false,
    endEmitted: false,
    reading: false,
    constructed: true,
    sync: true,
    needReadable: false,
    emittedReadable: false,
    readableListening: false,
    resumeScheduled: false,
    errorEmitted: false,
    emitClose: true,
    autoDestroy: true,
    destroyed: false,
    closed: false,
    closeEmitted: false,
    multiAwaitDrain: false,
    readingMore: false,
    dataEmitted: false,
    dataListening: false,
    decoder: null,
    encoding: null,
    defaultEncoding: "utf8",
    awaitDrainWriters: null,
    errored: null,
    // Node 25 defines no `readable` on ReadableState at all, so it reads back
    // `undefined` until a Duplex built with `readable: false` sets it; the
    // corpus asserts exactly that. Every test here is `!== false`.
    readable: undefined,
    paused: false,
    hasPaused: false,
    fns: {},
  };
  if (opts.objectMode === true) state.objectMode = true;
  if (isDuplex && opts.readableObjectMode === true) state.objectMode = true;
  state.highWaterMark =
    options === undefined || options === null
      ? __sGetDefaultHighWaterMark(false)
      : __sGetHighWaterMark(state, opts, "readableHighWaterMark", isDuplex);
  if (opts.emitClose === false) state.emitClose = false;
  if (opts.autoDestroy === false) state.autoDestroy = false;
  const defaultEncoding: any = opts.defaultEncoding;
  if (
    defaultEncoding === undefined ||
    defaultEncoding === null ||
    defaultEncoding === "utf8" ||
    defaultEncoding === "utf-8"
  ) {
    state.defaultEncoding = "utf8";
  } else if (__bufNormalizeEncoding(defaultEncoding) !== undefined) {
    state.defaultEncoding = defaultEncoding;
  } else {
    throw new ERR_UNKNOWN_ENCODING(defaultEncoding);
  }
  if (opts.encoding !== undefined && opts.encoding !== null) {
    const decoder: any = new StringDecoder(opts.encoding);
    state.decoder = decoder;
    state.encoding = decoder.encoding;
  }
  // `pipesCount`, the legacy alias Node keeps on ReadableState.prototype.
  Object.defineProperty(state, "pipesCount", {
    get: function (): number {
      return Number(state.pipes.length);
    },
    enumerable: false,
    configurable: true,
  });
  return state;
}

function __sNewWritableState(options: any, stream: any, isDuplex: boolean): any {
  const opts: any = options === undefined || options === null ? {} : options;
  const state: any = {
    objectMode: false,
    highWaterMark: 0,
    decodeStrings: true,
    defaultEncoding: "utf8",
    length: 0,
    writing: false,
    corked: 0,
    sync: true,
    bufferProcessing: false,
    onwrite: null,
    writecb: null,
    writelen: 0,
    afterWriteTickInfo: null,
    buffered: null,
    bufferedIndex: 0,
    allBuffers: true,
    allNoop: true,
    pendingcb: 0,
    constructed: true,
    prefinished: false,
    finalCalled: false,
    errorEmitted: false,
    emitClose: true,
    autoDestroy: true,
    needDrain: false,
    ending: false,
    ended: false,
    finished: false,
    destroyed: false,
    closed: false,
    closeEmitted: false,
    afterWritePending: false,
    expectWriteCb: false,
    errored: null,
    // `undefined` until something sets it, as in Node: the bitfield accessor
    // answers `undefined` while the `hasWritable` bit is clear, and
    // `test-stream-writable-ended-state.js` asserts that.
    writable: undefined,
    onfinishCallbacks: null,
    fns: {},
  };
  if (opts.objectMode === true) state.objectMode = true;
  if (isDuplex && opts.writableObjectMode === true) state.objectMode = true;
  state.highWaterMark =
    options === undefined || options === null
      ? __sGetDefaultHighWaterMark(false)
      : __sGetHighWaterMark(state, opts, "writableHighWaterMark", isDuplex);
  if (opts.decodeStrings === false) state.decodeStrings = false;
  if (opts.emitClose === false) state.emitClose = false;
  if (opts.autoDestroy === false) state.autoDestroy = false;
  const defaultEncoding: any = opts.defaultEncoding;
  if (
    defaultEncoding === undefined ||
    defaultEncoding === null ||
    defaultEncoding === "utf8" ||
    defaultEncoding === "utf-8"
  ) {
    state.defaultEncoding = "utf8";
  } else if (__bufNormalizeEncoding(defaultEncoding) !== undefined) {
    state.defaultEncoding = defaultEncoding;
  } else {
    throw new ERR_UNKNOWN_ENCODING(defaultEncoding);
  }
  // `getBuffer()` and `bufferedRequestCount`, both read straight off the state
  // by the corpus.
  state.getBuffer = function (): any[] {
    const list: any = state.buffered;
    if (list === null || list === undefined) return [];
    return list.slice(Number(state.bufferedIndex));
  };
  Object.defineProperty(state, "bufferedRequestCount", {
    get: function (): number {
      const list: any = state.buffered;
      if (list === null || list === undefined) return 0;
      return Number(list.length) - Number(state.bufferedIndex);
    },
    enumerable: false,
    configurable: true,
  });
  // Node binds `onwrite` to the stream and hands the bound function to
  // `_write` as its callback. A closure in a plain-object property is the
  // equivalent here.
  state.onwrite = function (er: any): void {
    __sOnwrite(stream, er);
  };
  return state;
}

// Node seeds `this._events` with the events each kind of stream is about to
// care about, so `eventNames()` reports them in that order rather than in
// registration order — which is exactly what `test-stream-event-names.js`
// pins. `events.ts` tracks key order in `__evTypes` and `eventNames()` skips a
// slot with no listeners, so seeding the names there reproduces it.
function __sSeedEvents(stream: any, names: string[]): void {
  const types: any = stream.__evTypes;
  if (types === undefined || types === null) return;
  for (const name of names) types.push(name);
}

const __S_READABLE_EVENTS: string[] = ["close", "error", "data", "end", "readable"];
const __S_WRITABLE_EVENTS: string[] = ["close", "error", "prefinish", "finish", "drain"];
const __S_DUPLEX_EVENTS: string[] = [
  "close",
  "error",
  "prefinish",
  "finish",
  "drain",
  "data",
  "end",
  "readable",
];

function __sResetBuffer(state: any): void {
  state.buffered = null;
  state.bufferedIndex = 0;
  state.allBuffers = true;
  state.allNoop = true;
}

// ---------------------------------------------------------------------------
// The hook dispatcher
//
// Node resolves `_read`/`_write`/`_writev`/`_final`/`_destroy`/`_construct`/
// `_transform`/`_flush` through the prototype chain, with three layers of
// precedence: an own property (which is what `this._read = options.read` and a
// test writing `r._read = fn` both create), then a subclass prototype method,
// then the base class default. All three are expressible here, but not as one
// class member:
//
//   * a function assigned to a class **field** is destroyed by the assignment
//     (`typeof` becomes `"object"` and the value is not callable — a new engine
//     bug, reported with this work), so the own-property layer cannot be a
//     field. It is `state.fns`, a plain object, written through an **accessor
//     pair** named exactly `_read` & co., so `r._read = fn` is the ordinary
//     assignment a test writes and the callable survives.
//   * a subclass method of the same name shadows that accessor, and a dynamic
//     call reaches it with its arguments and `this` intact.
//   * when neither exists, the dynamic call lands on the accessor and the
//     engine answers `TypeError: _read is not a function`. That is the "no
//     implementation" signal, and it is what `__sHookMissing` recognises —
//     a class method cannot be read as a value (zun#19) and a class prototype
//     carries no methods to reflect over (zun#51), so there is no way to ask
//     the question without making the call.
//
// The base-class defaults therefore live in these dispatchers rather than in
// class methods, keyed on the hierarchy.
// ---------------------------------------------------------------------------

function __sHookMissing(err: any, name: string): boolean {
  if (err === null || err === undefined) return false;
  if (err === __S_NO_IMPL) return true;
  return String(err.message) === name + " is not a function";
}

function __sHookRead(stream: any, n: any): any {
  const stored: any = __sOptFn(stream, "read");
  if (stored !== undefined) return __sCall(stored, stream, [n]);
  try {
    return stream._read(n);
  } catch (err: any) {
    if (!__sHookMissing(err, "_read")) throw err;
  }
  // `Transform` implements `_read`: it releases the write callback it parked
  // while the readable side was above its high water mark.
  if (stream instanceof Transform) {
    // The parked write callback lives on the readable state, not on a class
    // field: a function assigned to a class field is destroyed by the
    // assignment (see note 1 in the header).
    const state: any = stream._readableState;
    const pending: any = state.transformCallback;
    if (pending !== null && pending !== undefined) {
      state.transformCallback = null;
      __sInvoke(pending, []);
    }
    return undefined;
  }
  throw __S_NO_IMPL;
}

function __sHookWrite(stream: any, chunk: any, encoding: any, cb: any): any {
  const stored: any = __sOptFn(stream, "write");
  if (stored !== undefined) return __sCall(stored, stream, [chunk, encoding, cb]);
  try {
    return stream._write(chunk, encoding, cb);
  } catch (err: any) {
    if (!__sHookMissing(err, "_write")) throw err;
  }
  if (stream instanceof Transform) return __sTransformWrite(stream, chunk, encoding, cb);
  // `Writable.prototype._write` forwards to `_writev` when one exists.
  return __sHookWritev(stream, [{ chunk: chunk, encoding: encoding }], cb);
}

function __sHookWritev(stream: any, chunks: any, cb: any): any {
  const stored: any = __sOptFn(stream, "writev");
  if (stored !== undefined) return __sCall(stored, stream, [chunks, cb]);
  try {
    return stream._writev(chunks, cb);
  } catch (err: any) {
    if (!__sHookMissing(err, "_writev")) throw err;
  }
  throw __S_NO_IMPL;
}

function __sHookFinal(stream: any, cb: any): any {
  const stored: any = __sOptFn(stream, "final");
  if (stored !== undefined) return __sCall(stored, stream, [cb]);
  try {
    return stream._final(cb);
  } catch (err: any) {
    if (!__sHookMissing(err, "_final")) throw err;
  }
  // `Transform.prototype._final` is the flush-driven one.
  if (stream instanceof Transform) return __sTransformFinal(stream, cb);
  throw __S_NO_IMPL;
}

function __sHookDestroy(stream: any, err: any, cb: any): any {
  const stored: any = __sOptFn(stream, "destroy");
  if (stored !== undefined) return __sCall(stored, stream, [err, cb]);
  try {
    return stream._destroy(err, cb);
  } catch (caught: any) {
    if (!__sHookMissing(caught, "_destroy")) throw caught;
  }
  // The default `_destroy` just reports back.
  __sInvoke(cb, [err]);
  return undefined;
}

function __sHookConstruct(stream: any, cb: any): any {
  const stored: any = __sOptFn(stream, "construct");
  if (stored !== undefined) return __sCall(stored, stream, [cb]);
  try {
    return stream._construct(cb);
  } catch (err: any) {
    if (!__sHookMissing(err, "_construct")) throw err;
  }
  throw __S_NO_IMPL;
}

function __sHookTransform(stream: any, chunk: any, encoding: any, cb: any): any {
  const stored: any = __sOptFn(stream, "transform");
  if (stored !== undefined) return __sCall(stored, stream, [chunk, encoding, cb]);
  try {
    return stream._transform(chunk, encoding, cb);
  } catch (err: any) {
    if (!__sHookMissing(err, "_transform")) throw err;
  }
  // `PassThrough.prototype._transform` hands the chunk straight through.
  if (stream instanceof PassThrough) {
    __sInvoke(cb, [null, chunk]);
    return undefined;
  }
  throw new ERR_METHOD_NOT_IMPLEMENTED("_transform()");
}

function __sHookFlush(stream: any, cb: any): any {
  const stored: any = __sOptFn(stream, "flush");
  if (stored !== undefined) return __sCall(stored, stream, [cb]);
  try {
    return stream._flush(cb);
  } catch (err: any) {
    if (!__sHookMissing(err, "_flush")) throw err;
  }
  throw __S_NO_IMPL;
}

// ---------------------------------------------------------------------------
// Stream predicates (`lib/internal/streams/utils.js`)
//
// Every one of these is a duck-type test in Node too: they have to answer for
// a legacy stream and for an object that merely looks like one, which several
// tests in the corpus pass deliberately. `__sDuck` asks whether a member is
// callable without tripping over the fact that a class method reads back as
// `undefined` through an `any` receiver (zun#19) — for a real stream from this
// module the two state objects answer first, so the duck test is only reached
// for foreign objects, where the members are plain properties.
// ---------------------------------------------------------------------------

function __sDuck(value: any, name: string): boolean {
  if (!__sIsObj(value) && typeof value !== "function") return false;
  // This module's own classes first: a class method reads back as `undefined`
  // through an `any` receiver (zun#19), so a real `Readable` would answer
  // `false` for `pipe`. The hierarchy is the authority for those names.
  if (value instanceof Readable) {
    if (
      name === "pipe" ||
      name === "on" ||
      name === "pause" ||
      name === "resume" ||
      name === "read" ||
      name === "destroy" ||
      name === "removeListener" ||
      name === "prependListener" ||
      name === "emit"
    ) {
      return true;
    }
    if (value instanceof Duplex) {
      if (name === "write" || name === "end") return true;
    }
  } else if (value instanceof Writable) {
    if (
      name === "write" ||
      name === "end" ||
      name === "on" ||
      name === "pipe" ||
      name === "destroy" ||
      name === "removeListener" ||
      name === "prependListener" ||
      name === "emit"
    ) {
      return true;
    }
  } else if (value instanceof Stream) {
    if (
      name === "pipe" ||
      name === "on" ||
      name === "removeListener" ||
      name === "prependListener" ||
      name === "emit"
    ) {
      return true;
    }
  }
  return __sIsFn(value[name]);
}

function __sIsNodeStream(obj: any): boolean {
  if (!__sIsObj(obj)) return false;
  if (obj instanceof Stream) return true;
  if (obj._readableState !== undefined && obj._readableState !== null) return true;
  if (obj._writableState !== undefined && obj._writableState !== null) return true;
  if (__sDuck(obj, "write") && __sDuck(obj, "on")) return true;
  if (__sDuck(obj, "pipe") && __sDuck(obj, "on")) return true;
  return false;
}

function __sIsReadableNodeStream(obj: any, strict?: any): boolean {
  if (!__sIsObj(obj)) return false;
  const r: any = obj._readableState;
  const w: any = obj._writableState;
  if (r === undefined || r === null) {
    // A legacy stream: `pipe` + `on` and, in strict mode, pause/resume.
    if (!(__sDuck(obj, "pipe") && __sDuck(obj, "on"))) return false;
    if (strict === true && !(__sDuck(obj, "pause") && __sDuck(obj, "resume"))) return false;
    return w === undefined || w === null;
  }
  if (w !== undefined && w !== null && r.readable === false) return false;
  return true;
}

function __sIsWritableNodeStream(obj: any): boolean {
  if (!__sIsObj(obj)) return false;
  const w: any = obj._writableState;
  const r: any = obj._readableState;
  if (w === undefined || w === null) {
    return __sDuck(obj, "write") && __sDuck(obj, "on");
  }
  if (r !== undefined && r !== null && w.writable === false) return false;
  return true;
}

function __sIsDuplexNodeStream(obj: any): boolean {
  if (!__sIsObj(obj)) return false;
  if (obj instanceof Duplex) return true;
  const r: any = obj._readableState;
  if (r === undefined || r === null) return false;
  return __sDuck(obj, "pipe") && __sDuck(obj, "on") && __sDuck(obj, "write");
}

// The WHATWG shapes. The engine has no `ReadableStream`/`WritableStream`
// prelude global (checked against crates/zun_prelude/builtin), so these only
// ever answer `true` for an object a test built itself; they are kept because
// `pipeline` and `finished` branch on them in Node.
function __sIsReadableStream(obj: any): boolean {
  if (!__sIsObj(obj) || __sIsNodeStream(obj)) return false;
  return __sDuck(obj, "pipeThrough") && __sDuck(obj, "getReader") && __sDuck(obj, "cancel");
}

function __sIsWritableStream(obj: any): boolean {
  if (!__sIsObj(obj) || __sIsNodeStream(obj)) return false;
  return __sDuck(obj, "getWriter") && __sDuck(obj, "abort");
}

function __sIsTransformStream(obj: any): boolean {
  if (!__sIsObj(obj) || __sIsNodeStream(obj)) return false;
  return __sIsObj(obj.readable) && __sIsObj(obj.writable);
}

function __sIsWebStream(obj: any): boolean {
  return __sIsReadableStream(obj) || __sIsWritableStream(obj) || __sIsTransformStream(obj);
}

function __sIsIterable(obj: any, isAsync?: any): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj === "string") return isAsync !== true;
  const asyncIt: any = obj[Symbol.asyncIterator];
  const syncIt: any = obj[Symbol.iterator];
  if (isAsync === true) return __sIsFn(asyncIt);
  // A **generator object** exposes no `Symbol.iterator` in this engine
  // (`g[Symbol.iterator]` is `undefined`, although `for (… of g)` works), so
  // the duck test has to accept a callable `next` as well — otherwise
  // `Readable.from(generatorFn())` is rejected as not iterable. An async
  // generator object does carry `Symbol.asyncIterator`, so only the sync side
  // needs the extra arm.
  if (isAsync === false) return __sIsFn(syncIt) || __sIsFn(obj.next);
  return __sIsFn(asyncIt) || __sIsFn(syncIt) || __sIsFn(obj.next);
}

// Iterate anything `for`/`for await` can walk, as a generator object.
//
// Calling `iterable[Symbol.iterator]()` — the spelling Node uses — aborts the
// process here: a built-in method read as a value carries method RID 0 and the
// interpreter computes `rid - 1`, which underflows
// (`attempt to subtract with overflow` at crates/zun_interp/src/lib.rs:357;
// zun#17 in its most violent form). `for (… of x)` lowers to the iteration
// protocol internally and is unaffected, so the loop does the work and the
// generator object is what the rest of the module holds.
function* __sSyncIterate(iterable: any): any {
  for (const value of iterable) yield value;
}

async function* __sAsyncIterate(iterable: any): any {
  for await (const value of iterable) yield value;
}

// The iterator `Readable.from` and `pipeline` drive. An object that already is
// an iterator is used directly, so `throw`/`return` reach the real one.
function __sGetIterator(iterable: any, isAsync: boolean): any {
  if (__sIsFn(iterable.next)) return iterable;
  return isAsync ? __sAsyncIterate(iterable) : __sSyncIterate(iterable);
}

function __sIsDestroyed(stream: any): any {
  if (!__sIsNodeStream(stream)) return null;
  const w: any = stream._writableState;
  const r: any = stream._readableState;
  const state: any = w !== undefined && w !== null ? w : r;
  if (stream.destroyed === true) return true;
  if (stream.__sForcedDestroyed === true) return true;
  return __sIsObj(state) && state.destroyed === true;
}

function __sIsWritableEnded(stream: any): any {
  if (!__sIsWritableNodeStream(stream)) return null;
  if (stream.writableEnded === true) return true;
  const w: any = stream._writableState;
  if (!__sIsObj(w)) return null;
  if (w.errored !== null && w.errored !== undefined) return false;
  if (typeof w.ended !== "boolean") return null;
  return w.ended === true;
}

function __sIsWritableFinished(stream: any, strict?: any): any {
  if (!__sIsWritableNodeStream(stream)) return null;
  if (stream.writableFinished === true) return true;
  const w: any = stream._writableState;
  if (!__sIsObj(w)) return null;
  if (w.errored !== null && w.errored !== undefined) return false;
  if (typeof w.finished !== "boolean") return null;
  if (w.finished === true) return true;
  return strict === false && w.ended === true && Number(w.length) === 0;
}

function __sIsReadableEnded(stream: any): any {
  if (!__sIsReadableNodeStream(stream)) return null;
  if (stream.readableEnded === true) return true;
  const r: any = stream._readableState;
  if (!__sIsObj(r)) return false;
  if (r.errored !== null && r.errored !== undefined) return false;
  if (typeof r.ended !== "boolean") return null;
  return r.ended === true;
}

function __sIsReadableFinished(stream: any, strict?: any): any {
  if (!__sIsReadableNodeStream(stream)) return null;
  const r: any = stream._readableState;
  if (!__sIsObj(r)) return null;
  if (r.errored !== null && r.errored !== undefined) return false;
  if (typeof r.endEmitted !== "boolean") return null;
  if (r.endEmitted === true) return true;
  return strict === false && r.ended === true && Number(r.length) === 0;
}

function __sIsReadable(stream: any): any {
  if (!__sIsObj(stream)) return null;
  if (typeof stream.readable !== "boolean") return null;
  if (__sIsDestroyed(stream) === true) return false;
  return (
    __sIsReadableNodeStream(stream) &&
    stream.readable === true &&
    __sIsReadableFinished(stream) !== true
  );
}

function __sIsWritable(stream: any): any {
  if (!__sIsObj(stream)) return null;
  if (typeof stream.writable !== "boolean") return null;
  if (__sIsDestroyed(stream) === true) return false;
  return (
    __sIsWritableNodeStream(stream) &&
    stream.writable === true &&
    __sIsWritableEnded(stream) !== true
  );
}

function __sIsFinished(stream: any, opts?: any): any {
  if (!__sIsNodeStream(stream)) return null;
  if (__sIsDestroyed(stream) === true) return true;
  const wantReadable: boolean = !__sIsObj(opts) || opts.readable !== false;
  const wantWritable: boolean = !__sIsObj(opts) || opts.writable !== false;
  if (wantReadable && __sIsReadable(stream) === true) return false;
  if (wantWritable && __sIsWritable(stream) === true) return false;
  return true;
}

function __sIsWritableErrored(stream: any): any {
  if (!__sIsNodeStream(stream)) return null;
  const direct: any = stream.writableErrored;
  if (direct !== undefined && direct !== null) return direct;
  const w: any = stream._writableState;
  if (!__sIsObj(w)) return null;
  return w.errored === undefined ? null : w.errored;
}

function __sIsReadableErrored(stream: any): any {
  if (!__sIsNodeStream(stream)) return null;
  const direct: any = stream.readableErrored;
  if (direct !== undefined && direct !== null) return direct;
  const r: any = stream._readableState;
  if (!__sIsObj(r)) return null;
  return r.errored === undefined ? null : r.errored;
}

function __sIsClosed(stream: any): any {
  if (!__sIsNodeStream(stream)) return null;
  if (typeof stream.closed === "boolean") return stream.closed;
  const w: any = stream._writableState;
  const r: any = stream._readableState;
  const wClosed: any = __sIsObj(w) ? w.closed : undefined;
  const rClosed: any = __sIsObj(r) ? r.closed : undefined;
  if (typeof wClosed === "boolean" || typeof rClosed === "boolean") {
    return wClosed === true || rClosed === true;
  }
  return null;
}

function __sWillEmitClose(stream: any): any {
  if (!__sIsNodeStream(stream)) return null;
  const w: any = stream._writableState;
  const r: any = stream._readableState;
  const state: any = w !== undefined && w !== null ? w : r;
  if (!__sIsObj(state)) return false;
  return state.autoDestroy === true && state.emitClose === true && state.closed === false;
}

function __sIsDisturbed(stream: any): boolean {
  if (!__sIsObj(stream)) return false;
  if (stream.__sForcedDisturbed === true) return true;
  return stream.readableDidRead === true || stream.readableAborted === true;
}

function __sIsErrored(stream: any): boolean {
  if (!__sIsObj(stream)) return false;
  const r: any = stream._readableState;
  const w: any = stream._writableState;
  if (stream.readableErrored !== undefined && stream.readableErrored !== null) return true;
  if (stream.writableErrored !== undefined && stream.writableErrored !== null) return true;
  if (__sIsObj(r)) {
    if (r.errorEmitted === true) return true;
    if (r.errored !== null && r.errored !== undefined) return true;
  }
  if (__sIsObj(w)) {
    if (w.errorEmitted === true) return true;
    if (w.errored !== null && w.errored !== undefined) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// destroy (`lib/internal/streams/destroy.js`)
// ---------------------------------------------------------------------------

function __sCheckError(err: any, w: any, r: any): void {
  if (err === undefined || err === null) return;
  if (__sIsObj(w) && (w.errored === null || w.errored === undefined)) w.errored = err;
  if (__sIsObj(r) && (r.errored === null || r.errored === undefined)) r.errored = err;
}

function __sDestroy(stream: any, err: any, cb: any): any {
  const r: any = stream._readableState;
  const w: any = stream._writableState;

  if ((__sIsObj(w) && w.destroyed === true) || (__sIsObj(r) && r.destroyed === true)) {
    if (__sIsFn(cb)) __sInvoke(cb, []);
    return stream;
  }

  __sCheckError(err, w, r);

  if (__sIsObj(w)) w.destroyed = true;
  if (__sIsObj(r)) r.destroyed = true;

  const s: any = __sIsObj(w) ? w : r;
  if (s.constructed !== true) {
    // Still constructing: defer `_destroy` until construction settles. Node
    // parks it on a symbol-keyed event; a pending slot on the state is the
    // same thing with one less moving part.
    s.pendingDestroy = { err: err, cb: cb };
    return stream;
  }

  __sDestroyNow(stream, err, cb);
  return stream;
}

function __sDestroyNow(self: any, err: any, cb: any): void {
  const guard: any = { called: false };
  const onDestroy: any = function (er: any): void {
    if (guard.called) return;
    guard.called = true;
    const r: any = self._readableState;
    const w: any = self._writableState;
    __sCheckError(er, w, r);
    if (__sIsObj(w)) w.closed = true;
    if (__sIsObj(r)) r.closed = true;
    if (__sIsFn(cb)) __sInvoke(cb, [er]);
    if (er !== undefined && er !== null) {
      __sTick(__sEmitErrorCloseNT, self, er);
    } else {
      __sTick(__sEmitCloseNT, self);
    }
  };
  try {
    __sHookDestroy(self, err === undefined ? null : err, onDestroy);
  } catch (caught: any) {
    if (caught === __S_NO_IMPL) {
      __sInvoke(onDestroy, [err === undefined ? null : err]);
    } else {
      __sInvoke(onDestroy, [caught]);
    }
  }
}

function __sEmitErrorCloseNT(self: any, err: any): void {
  __sEmitErrorNT(self, err);
  __sEmitCloseNT(self);
}

function __sEmitCloseNT(self: any): void {
  const r: any = self._readableState;
  const w: any = self._writableState;
  if (__sIsObj(w)) w.closeEmitted = true;
  if (__sIsObj(r)) r.closeEmitted = true;
  if ((__sIsObj(w) && w.emitClose === true) || (__sIsObj(r) && r.emitClose === true)) {
    __evEmit(self, "close", []);
  }
}

function __sEmitErrorNT(self: any, err: any): void {
  const r: any = self._readableState;
  const w: any = self._writableState;
  if ((__sIsObj(w) && w.errorEmitted === true) || (__sIsObj(r) && r.errorEmitted === true)) {
    return;
  }
  if (__sIsObj(w)) w.errorEmitted = true;
  if (__sIsObj(r)) r.errorEmitted = true;
  __evEmit(self, "error", [err]);
}

function __sUndestroy(stream: any): void {
  const r: any = stream._readableState;
  const w: any = stream._writableState;
  if (__sIsObj(r)) {
    r.constructed = true;
    r.closed = false;
    r.closeEmitted = false;
    r.destroyed = false;
    r.errored = null;
    r.errorEmitted = false;
    r.reading = false;
    r.ended = r.readable === false;
    r.endEmitted = r.readable === false;
  }
  if (__sIsObj(w)) {
    w.constructed = true;
    w.destroyed = false;
    w.closed = false;
    w.closeEmitted = false;
    w.errored = null;
    w.errorEmitted = false;
    w.finalCalled = false;
    w.prefinished = false;
    w.ended = w.writable === false;
    w.ending = w.writable === false;
    w.finished = w.writable === false;
  }
}

function __sErrorOrDestroy(stream: any, err: any, sync?: any): void {
  const r: any = stream._readableState;
  const w: any = stream._writableState;

  if ((__sIsObj(w) && w.destroyed === true) || (__sIsObj(r) && r.destroyed === true)) {
    return;
  }

  if ((__sIsObj(r) && r.autoDestroy === true) || (__sIsObj(w) && w.autoDestroy === true)) {
    stream.destroy(err);
    return;
  }

  if (err === undefined || err === null) return;
  if (__sIsObj(w) && (w.errored === null || w.errored === undefined)) w.errored = err;
  if (__sIsObj(r) && (r.errored === null || r.errored === undefined)) r.errored = err;
  if (sync === true) {
    __sTick(__sEmitErrorNT, stream, err);
  } else {
    __sEmitErrorNT(stream, err);
  }
}

// `destroyImpl.construct`, inverted: see note 2 in the header. Node discovers
// `typeof stream._construct === 'function'` and only then flips `constructed`
// off; presence can only be discovered here by calling the hook, so the hook is
// called and the sentinel it throws when absent restores the state.
function __sTryConstruct(stream: any): void {
  const r: any = stream._readableState;
  const w: any = stream._writableState;
  if (__sIsObj(r)) r.constructed = false;
  if (__sIsObj(w)) w.constructed = false;

  const guard: any = { called: false };
  const onConstruct: any = function (err: any): void {
    if (guard.called) {
      __sErrorOrDestroy(stream, err === undefined || err === null ? new ERR_MULTIPLE_CALLBACK() : err);
      return;
    }
    guard.called = true;
    __sTick(__sConstructSettled, stream, err === undefined ? null : err);
  };

  let absent = false;
  try {
    __sHookConstruct(stream, onConstruct);
  } catch (caught: any) {
    if (caught === __S_NO_IMPL) {
      absent = true;
    } else {
      guard.called = true;
      if (__sIsObj(r)) r.constructed = true;
      if (__sIsObj(w)) w.constructed = true;
      __sTick(__sErrorOrDestroy, stream, caught);
      return;
    }
  }
  if (absent) {
    if (__sIsObj(r)) r.constructed = true;
    if (__sIsObj(w)) w.constructed = true;
  }
}

function __sConstructSettled(stream: any, err: any): void {
  const r: any = stream._readableState;
  const w: any = stream._writableState;
  const s: any = __sIsObj(w) ? w : r;
  if (__sIsObj(r)) r.constructed = true;
  if (__sIsObj(w)) w.constructed = true;

  const pending: any = s.pendingDestroy;
  if (pending !== undefined && pending !== null) {
    s.pendingDestroy = null;
    __sDestroyNow(stream, __sAggregateTwoErrors(err, pending.err), pending.cb);
    return;
  }
  if (err !== undefined && err !== null) {
    __sErrorOrDestroy(stream, err, true);
    return;
  }
  // Node emits an internal 'construct' event here; the two states take over
  // directly instead.
  if (__sIsObj(w)) {
    if (w.writing !== true) __sClearBuffer(stream, w);
    if (w.ending === true) __sFinishMaybe(stream, w, true);
  }
  if (__sIsObj(r) && r.needReadable === true) {
    __sMaybeReadMore(stream, r);
  }
}

// `destroyImpl.destroyer`: normalize destroy for a stream this module does not
// own (a legacy stream, or a plain object a test passes to `pipeline`).
function __sDestroyer(stream: any, err: any): void {
  if (!__sIsObj(stream) || __sIsDestroyed(stream) === true) return;
  let error: any = err;
  if ((error === undefined || error === null) && __sIsFinished(stream) !== true) {
    error = new AbortError();
  }
  if (__sDuck(stream, "destroy")) {
    stream.destroy(error);
  } else if (__sDuck(stream, "close")) {
    stream.close();
  } else if (error !== undefined && error !== null) {
    __sTick(__sEmitErrorCloseLegacy, stream, error);
  } else {
    __sTick(__sEmitCloseLegacy, stream);
  }
  if (stream.destroyed !== true) stream.__sForcedDestroyed = true;
}

function __sEmitCloseLegacy(stream: any): void {
  __evEmit(stream, "close", []);
}

function __sEmitErrorCloseLegacy(stream: any, err: any): void {
  __evEmit(stream, "error", [err]);
  __sTick(__sEmitCloseLegacy, stream);
}

// ---------------------------------------------------------------------------
// Stream (`lib/internal/streams/legacy.js`)
//
// The legacy base: an EventEmitter with the old `pipe`. `Readable` overrides
// `pipe` with the modern one; a bare `Stream` keeps this.
// ---------------------------------------------------------------------------

class Stream extends EventEmitter {
  // Node does not declare these on the legacy Stream, but `__sIsNodeStream`
  // and every free function below reach for them on any stream, and an
  // undeclared key written onto a typed instance through an `any` alias
  // poisons every later typed read of that instance
  // (https://github.com/UrubuCode/zun/issues/37). Declaring them here is what
  // keeps `r._readableState` readable from a test.
  _readableState: any = null;
  _writableState: any = null;
  allowHalfOpen: any = true;
  __sForcedDestroyed: boolean = false;
  __sForcedDisturbed: boolean = false;
  __sIsStdio: boolean = false;
  // Declared rather than attached: an undeclared key written onto a typed
  // instance through an `any` alias poisons every later typed read of that
  // instance (zun#37).
  __sDuplexPumping: boolean = false;

  constructor(options?: any) {
    super(options);
  }

  pipe(dest: any, options?: any): any {
    return __sLegacyPipe(this, dest, options);
  }
}

function __sPrependListener(emitter: any, event: string, fn: any): void {
  if (__sDuck(emitter, "prependListener")) {
    emitter.prependListener(event, fn);
    return;
  }
  __evAddListener(emitter, event, fn, true);
}

function __sLegacyPipe(source: any, dest: any, options?: any): any {
  // `cleanup` and `onerror` reference each other, so both live on one holder
  // object rather than being two mutually recursive `const` closures.
  const shared: any = { didOnEnd: false, cleanup: null, onerror: null };

  const ondata: any = function (chunk: any): void {
    if (dest.writable === true && dest.write(chunk) === false && __sDuck(source, "pause")) {
      source.pause();
    }
  };
  source.on("data", ondata);

  const ondrain: any = function (): void {
    if (source.readable === true && __sDuck(source, "resume")) source.resume();
  };
  dest.on("drain", ondrain);

  const onend: any = function (): void {
    if (shared.didOnEnd) return;
    shared.didOnEnd = true;
    dest.end();
  };
  const onclose: any = function (): void {
    if (shared.didOnEnd) return;
    shared.didOnEnd = true;
    if (__sDuck(dest, "destroy")) dest.destroy();
  };

  if (dest.__sIsStdio !== true && (!__sIsObj(options) || options.end !== false)) {
    source.on("end", onend);
    source.on("close", onclose);
  }

  const cleanup: any = function (): void {
    source.removeListener("data", ondata);
    dest.removeListener("drain", ondrain);
    source.removeListener("end", onend);
    source.removeListener("close", onclose);
    source.removeListener("error", shared.onerror);
    dest.removeListener("error", shared.onerror);
    source.removeListener("end", shared.cleanup);
    source.removeListener("close", shared.cleanup);
    dest.removeListener("close", shared.cleanup);
  };
  shared.cleanup = cleanup;

  const onerror: any = function (er: any): void {
    __sInvoke(shared.cleanup, []);
    if (Number(__eventsListenerCount(dest, "error")) === 0) {
      __evEmit(dest, "error", [er]);
    }
  };
  shared.onerror = onerror;

  __sPrependListener(source, "error", onerror);
  __sPrependListener(dest, "error", onerror);

  source.on("end", cleanup);
  source.on("close", cleanup);
  dest.on("close", cleanup);
  __evEmit(dest, "pipe", [source]);

  return dest;
}

// ---------------------------------------------------------------------------
// Readable (`lib/internal/streams/readable.js`)
//
// Node 25 stores a `bufferIndex` alongside `buffer` so a consumed chunk can be
// nulled out instead of shifted. The list is a plain array here and consumed
// from the front: `readableBuffer` then reports exactly the chunks still
// pending, which is what the corpus reads it for.
// ---------------------------------------------------------------------------

// Do not raise the hwm past 1GiB (`computeNewHighWaterMark`).
const __S_MAX_HWM: number = 0x40000000;

function __sComputeNewHighWaterMark(n: number): number {
  if (n > __S_MAX_HWM) throw new ERR_OUT_OF_RANGE("size", "<= 1GiB", n);
  let v = n - 1;
  v = v | (v >>> 1);
  v = v | (v >>> 2);
  v = v | (v >>> 4);
  v = v | (v >>> 8);
  v = v | (v >>> 16);
  return v + 1;
}

function __sCanPushMore(state: any): boolean {
  return (
    state.ended !== true &&
    (Number(state.length) < Number(state.highWaterMark) || Number(state.length) === 0)
  );
}

// `readableAddChunk`, split the way Node 25 splits it: push/unshift x
// byte/object mode.
function __sPushByteMode(stream: any, state: any, chunk: any, encoding: any): boolean {
  if (chunk === null) {
    state.reading = false;
    __sOnEofChunk(stream, state);
    return false;
  }

  let value: any = chunk;
  let enc: any = encoding;
  if (typeof value === "string") {
    if (enc === undefined || enc === null || enc === "") enc = state.defaultEncoding;
    // Node converts the string to a Buffer here unless the stored encoding
    // already matches. The engine cannot build a usable Buffer from an `any`
    // string (see the Buffer note in the header), so the string is kept and
    // `__sChunkLen` charges its UTF-8 byte length.
    if (state.encoding !== enc) enc = "";
  } else if (__sIsView(value)) {
    enc = "";
  } else if (value !== undefined) {
    __sErrorOrDestroy(
      stream,
      new ERR_INVALID_ARG_TYPE("chunk", ["string", "Buffer", "TypedArray", "DataView"], value),
    );
    return false;
  }

  if (value === undefined || __sChunkLen(state, value) <= 0) {
    state.reading = false;
    __sMaybeReadMore(stream, state);
    return __sCanPushMore(state);
  }

  if (state.ended === true) {
    __sErrorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF());
    return false;
  }

  if (state.destroyed === true || (state.errored !== null && state.errored !== undefined)) {
    return false;
  }

  state.reading = false;
  if (state.decoder !== null && state.decoder !== undefined && (enc === "" || enc === undefined)) {
    value = state.decoder.write(value);
    if (Number(value.length) === 0) {
      __sMaybeReadMore(stream, state);
      return __sCanPushMore(state);
    }
  }

  __sAddChunk(stream, state, value, false);
  return __sCanPushMore(state);
}

function __sPushObjectMode(stream: any, state: any, chunk: any, encoding: any): boolean {
  if (chunk === null) {
    state.reading = false;
    __sOnEofChunk(stream, state);
    return false;
  }
  if (state.ended === true) {
    __sErrorOrDestroy(stream, new ERR_STREAM_PUSH_AFTER_EOF());
    return false;
  }
  if (state.destroyed === true || (state.errored !== null && state.errored !== undefined)) {
    return false;
  }
  state.reading = false;
  let value: any = chunk;
  if (
    state.decoder !== null &&
    state.decoder !== undefined &&
    (encoding === undefined || encoding === null || encoding === "")
  ) {
    value = state.decoder.write(value);
  }
  __sAddChunk(stream, state, value, false);
  return __sCanPushMore(state);
}

function __sUnshiftValue(stream: any, state: any, chunk: any): boolean {
  if (state.endEmitted === true) {
    __sErrorOrDestroy(stream, new ERR_STREAM_UNSHIFT_AFTER_END_EVENT());
  } else if (state.destroyed === true || (state.errored !== null && state.errored !== undefined)) {
    return false;
  } else {
    __sAddChunk(stream, state, chunk, true);
  }
  return __sCanPushMore(state);
}

function __sUnshiftByteMode(stream: any, state: any, chunk: any, encoding: any): boolean {
  if (chunk === null) {
    state.reading = false;
    __sOnEofChunk(stream, state);
    return false;
  }
  let value: any = chunk;
  if (typeof value === "string") {
    const enc: any = encoding === undefined || encoding === null || encoding === "" ? state.defaultEncoding : encoding;
    // See the Buffer note: the string stays a string, so an encoding
    // round-trip is a no-op rather than `Buffer.from(chunk, enc).toString(...)`.
    if (state.encoding !== enc && state.encoding !== null && state.encoding !== undefined) {
      value = String(value);
    }
  } else if (!__sIsView(value) && value !== undefined) {
    __sErrorOrDestroy(
      stream,
      new ERR_INVALID_ARG_TYPE("chunk", ["string", "Buffer", "TypedArray", "DataView"], value),
    );
    return false;
  }
  if (value === undefined || __sChunkLen(state, value) <= 0) {
    return __sCanPushMore(state);
  }
  return __sUnshiftValue(stream, state, value);
}

function __sUnshiftObjectMode(stream: any, state: any, chunk: any): boolean {
  if (chunk === null) {
    state.reading = false;
    __sOnEofChunk(stream, state);
    return false;
  }
  return __sUnshiftValue(stream, state, chunk);
}

function __sAddChunk(stream: any, state: any, chunk: any, addToFront: boolean): void {
  if (
    state.flowing === true &&
    state.sync !== true &&
    state.dataListening === true &&
    Number(state.length) === 0
  ) {
    if (state.multiAwaitDrain === true) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
    }
    state.dataEmitted = true;
    __evEmit(stream, "data", [chunk]);
  } else {
    state.length = Number(state.length) + __sChunkLen(state, chunk);
    const list: any = state.buffer;
    if (addToFront) {
      list.unshift(chunk);
    } else {
      list.push(chunk);
    }
    if (state.needReadable === true) __sEmitReadable(stream);
  }
  __sMaybeReadMore(stream, state);
}

function __sOnEofChunk(stream: any, state: any): void {
  if (state.ended === true) return;
  const decoder: any = state.decoder;
  if (decoder !== null && decoder !== undefined) {
    const tail: any = decoder.end();
    if (tail !== undefined && tail !== null && Number(tail.length) > 0) {
      state.buffer.push(tail);
      state.length = Number(state.length) + __sChunkLen(state, tail);
    }
  }
  state.ended = true;

  if (state.sync === true) {
    __sEmitReadable(stream);
  } else {
    state.needReadable = false;
    state.emittedReadable = true;
    __sEmitReadableNow(stream);
  }
}

function __sEmitReadable(stream: any): void {
  const state: any = stream._readableState;
  state.needReadable = false;
  if (state.emittedReadable !== true) {
    state.emittedReadable = true;
    __sTick(__sEmitReadableNow, stream);
  }
}

function __sEmitReadableNow(stream: any): void {
  const state: any = stream._readableState;
  if (
    state.destroyed !== true &&
    (state.errored === null || state.errored === undefined) &&
    (Number(state.length) > 0 || state.ended === true)
  ) {
    __evEmit(stream, "readable", []);
    state.emittedReadable = false;
  }
  if (
    state.flowing !== true &&
    state.ended !== true &&
    Number(state.length) <= Number(state.highWaterMark)
  ) {
    state.needReadable = true;
  }
  __sFlow(stream);
}

function __sMaybeReadMore(stream: any, state: any): void {
  if (state.readingMore !== true && state.constructed === true) {
    state.readingMore = true;
    __sTick(__sMaybeReadMoreNow, stream, state);
  }
}

function __sMaybeReadMoreNow(stream: any, state: any): void {
  while (
    state.reading !== true &&
    state.ended !== true &&
    (Number(state.length) < Number(state.highWaterMark) ||
      (state.flowing === true && Number(state.length) === 0))
  ) {
    const before = Number(state.length);
    stream.read(0);
    if (before === Number(state.length)) break;
  }
  state.readingMore = false;
}

function __sHowMuchToRead(n: any, state: any): number {
  if (Number(n) <= 0 || (Number(state.length) === 0 && state.ended === true)) return 0;
  if (state.objectMode === true) return 1;
  if (Number.isNaN(n)) {
    if (state.flowing === true && Number(state.length) > 0) {
      return __sChunkLen(state, state.buffer[0]);
    }
    return Number(state.length);
  }
  if (Number(n) <= Number(state.length)) return Number(n);
  return state.ended === true ? Number(state.length) : 0;
}

// `fromList(n, state)`: pluck `n` units off the front of the buffer list.
function __sFromList(n: any, state: any): any {
  if (Number(state.length) === 0) return null;
  const list: any = state.buffer;
  const count = Number(list.length);

  if (state.objectMode === true) return list.shift();

  const want = Number(n);
  if (want === 0 || want >= Number(state.length)) {
    const all: any[] = [];
    for (let i = 0; i < count; i++) all.push(list[i]);
    list.length = 0;
    if (state.decoder !== null && state.decoder !== undefined) {
      let text = "";
      for (const piece of all) text = text + String(piece);
      return text;
    }
    return __sJoinChunks(all);
  }

  const head: any = list[0];
  const headLen = __sChunkLen(state, head);
  if (want < headLen) {
    const taken: any = __sChunkSlice(head, 0, want);
    list[0] = __sChunkSlice(head, want, headLen);
    return taken;
  }
  if (want === headLen) return list.shift();

  const parts: any[] = [];
  let remaining = want;
  while (remaining > 0 && Number(list.length) > 0) {
    const piece: any = list[0];
    const pieceLen = __sChunkLen(state, piece);
    if (remaining >= pieceLen) {
      parts.push(list.shift());
      remaining = remaining - pieceLen;
    } else {
      parts.push(__sChunkSlice(piece, 0, remaining));
      list[0] = __sChunkSlice(piece, remaining, pieceLen);
      remaining = 0;
    }
  }
  if (state.decoder !== null && state.decoder !== undefined) {
    let text = "";
    for (const piece of parts) text = text + String(piece);
    return text;
  }
  return __sJoinChunks(parts);
}

function __sReadableRead(stream: any, requested: any): any {
  let n: any = requested;
  if (n === undefined) {
    n = NaN;
  } else if (!Number.isInteger(n)) {
    n = parseInt(String(n), 10);
  }
  const state: any = stream._readableState;
  const nOrig: any = n;

  if (Number(n) > Number(state.highWaterMark)) {
    state.highWaterMark = __sComputeNewHighWaterMark(Number(n));
  }

  if (Number(n) !== 0) state.emittedReadable = false;

  if (
    Number(n) === 0 &&
    state.needReadable === true &&
    ((Number(state.highWaterMark) !== 0
      ? Number(state.length) >= Number(state.highWaterMark)
      : Number(state.length) > 0) ||
      state.ended === true)
  ) {
    if (Number(state.length) === 0 && state.ended === true) {
      __sEndReadable(stream);
    } else {
      __sEmitReadable(stream);
    }
    return null;
  }

  n = __sHowMuchToRead(n, state);

  if (Number(n) === 0 && state.ended === true) {
    if (Number(state.length) === 0) __sEndReadable(stream);
    return null;
  }

  let doRead: boolean = state.needReadable === true;
  if (Number(state.length) === 0 || Number(state.length) - Number(n) < Number(state.highWaterMark)) {
    doRead = true;
  }

  if (
    state.reading === true ||
    state.ended === true ||
    state.destroyed === true ||
    (state.errored !== null && state.errored !== undefined) ||
    state.constructed !== true
  ) {
    doRead = false;
  } else if (doRead) {
    state.reading = true;
    state.sync = true;
    if (Number(state.length) === 0) state.needReadable = true;
    try {
      __sHookRead(stream, Number(state.highWaterMark));
    } catch (err: any) {
      // Node's base `_read` throws ERR_METHOD_NOT_IMPLEMENTED and this catch
      // routes it to `errorOrDestroy`; the sentinel stands in for "no hook".
      __sErrorOrDestroy(
        stream,
        err === __S_NO_IMPL ? new ERR_METHOD_NOT_IMPLEMENTED("_read()") : err,
      );
    }
    state.sync = false;
    if (state.reading !== true) n = __sHowMuchToRead(nOrig, state);
  }

  let ret: any = null;
  if (Number(n) > 0) {
    ret = __sFromList(n, state);
  }

  if (ret === null) {
    if (Number(state.length) <= Number(state.highWaterMark)) state.needReadable = true;
    n = 0;
  } else {
    state.length = Number(state.length) - Number(n);
    if (state.multiAwaitDrain === true) {
      state.awaitDrainWriters.clear();
    } else {
      state.awaitDrainWriters = null;
    }
  }

  if (Number(state.length) === 0) {
    if (state.ended !== true) state.needReadable = true;
    if (Number(nOrig) !== Number(n) && state.ended === true) __sEndReadable(stream);
  }

  if (ret !== null && state.errorEmitted !== true && state.closeEmitted !== true) {
    state.dataEmitted = true;
    __evEmit(stream, "data", [ret]);
  }

  return ret;
}

function __sFlow(stream: any): void {
  const state: any = stream._readableState;
  while (state.flowing === true && stream.read() !== null) {
    // `read()` emits 'data' for each chunk; the loop stops when it answers null.
  }
}

function __sResumeScheduled(stream: any, state: any): void {
  if (state.resumeScheduled !== true) {
    state.resumeScheduled = true;
    __sTick(__sResumeNow, stream, state);
  }
}

function __sResumeNow(stream: any, state: any): void {
  if (state.reading !== true) stream.read(0);
  state.resumeScheduled = false;
  __evEmit(stream, "resume", []);
  __sFlow(stream);
  if (state.flowing === true && state.reading !== true) stream.read(0);
}

function __sNReadingNextTick(self: any): void {
  self.read(0);
}

function __sUpdateReadableListening(self: any): void {
  const state: any = self._readableState;
  state.readableListening = Number(__eventsListenerCount(self, "readable")) > 0;
  if (state.hasPaused === true && state.paused !== true && state.resumeScheduled === true) {
    state.flowing = true;
  } else if (state.dataListening === true) {
    self.resume();
  } else if (state.readableListening !== true) {
    state.flowing = null;
  }
}

function __sEndReadable(stream: any): void {
  const state: any = stream._readableState;
  if (state.endEmitted !== true) {
    state.ended = true;
    __sTick(__sEndReadableNT, state, stream);
  }
}

function __sEndReadableNT(state: any, stream: any): void {
  if (
    (state.errored === null || state.errored === undefined) &&
    state.closeEmitted !== true &&
    state.endEmitted !== true &&
    Number(state.length) === 0
  ) {
    state.endEmitted = true;
    __evEmit(stream, "end", []);

    if (stream.writable === true && stream.allowHalfOpen === false) {
      __sTick(__sEndWritableNT, stream);
    } else if (state.autoDestroy === true) {
      const w: any = stream._writableState;
      const auto: boolean =
        !__sIsObj(w) || (w.autoDestroy === true && (w.finished === true || w.writable === false));
      if (auto) stream.destroy();
    }
  }
}

function __sEndWritableNT(stream: any): void {
  if (stream.writable === true && stream.writableEnded !== true && stream.destroyed !== true) {
    stream.end();
  }
}

function __sSetEncoding(stream: any, enc: any): any {
  const state: any = stream._readableState;
  const decoder: any = new StringDecoder(enc);
  state.decoder = decoder;
  state.encoding = decoder.encoding;

  // Convert whatever is already buffered.
  const list: any = state.buffer;
  const count = Number(list.length);
  let content = "";
  for (let i = 0; i < count; i++) content = content + String(decoder.write(list[i]));
  list.length = 0;
  if (content !== "") list.push(content);
  state.length = Number(content.length);
  return stream;
}

// `Readable.prototype.pipe`.
function __sPipe(src: any, dest: any, pipeOpts: any): any {
  const state: any = src._readableState;

  if (Number(state.pipes.length) === 1) {
    if (state.multiAwaitDrain !== true) {
      state.multiAwaitDrain = true;
      const existing: any = state.awaitDrainWriters;
      const set: any = new Set();
      if (existing !== null && existing !== undefined) set.add(existing);
      state.awaitDrainWriters = set;
    }
  }

  state.pipes.push(dest);

  const doEnd: boolean =
    (!__sIsObj(pipeOpts) || pipeOpts.end !== false) &&
    dest !== process.stdout &&
    dest !== process.stderr;

  // Every closure below needs the others, so they share one holder.
  const share: any = {
    cleanedUp: false,
    ondrain: null,
    cleanup: null,
    unpipe: null,
    onend: null,
    onclose: null,
    onfinish: null,
    onerror: null,
    onunpipe: null,
    ondata: null,
    pause: null,
  };

  const unpipe: any = function (): void {
    src.unpipe(dest);
  };
  share.unpipe = unpipe;

  const onend: any = function (): void {
    dest.end();
  };
  share.onend = onend;

  const cleanup: any = function (): void {
    dest.removeListener("close", share.onclose);
    dest.removeListener("finish", share.onfinish);
    if (share.ondrain !== null) dest.removeListener("drain", share.ondrain);
    dest.removeListener("error", share.onerror);
    dest.removeListener("unpipe", share.onunpipe);
    src.removeListener("end", share.onend);
    src.removeListener("end", share.unpipe);
    src.removeListener("data", share.ondata);
    share.cleanedUp = true;
    if (
      share.ondrain !== null &&
      state.awaitDrainWriters !== null &&
      state.awaitDrainWriters !== undefined &&
      (!__sIsObj(dest._writableState) || dest._writableState.needDrain === true)
    ) {
      __sInvoke(share.ondrain, []);
    }
  };
  share.cleanup = cleanup;

  const pause: any = function (): void {
    if (!share.cleanedUp) {
      if (Number(state.pipes.length) === 1 && state.pipes[0] === dest) {
        state.awaitDrainWriters = dest;
        state.multiAwaitDrain = false;
      } else if (Number(state.pipes.length) > 1 && state.pipes.includes(dest)) {
        state.awaitDrainWriters.add(dest);
      }
      src.pause();
    }
    if (share.ondrain === null) {
      const ondrain: any = function (): void {
        if (state.awaitDrainWriters === dest) {
          state.awaitDrainWriters = null;
        } else if (state.multiAwaitDrain === true) {
          state.awaitDrainWriters.delete(dest);
        }
        const writers: any = state.awaitDrainWriters;
        const empty: boolean =
          writers === null || writers === undefined || Number(writers.size) === 0;
        if (empty && state.dataListening === true) src.resume();
      };
      share.ondrain = ondrain;
      dest.on("drain", ondrain);
    }
  };
  share.pause = pause;

  const onunpipe: any = function (readable: any, unpipeInfo: any): void {
    if (readable === src) {
      if (__sIsObj(unpipeInfo) && unpipeInfo.hasUnpiped === false) {
        unpipeInfo.hasUnpiped = true;
        __sInvoke(share.cleanup, []);
      }
    }
  };
  share.onunpipe = onunpipe;
  dest.on("unpipe", onunpipe);

  const ondata: any = function (chunk: any): void {
    try {
      const ret: any = dest.write(chunk);
      if (ret === false) __sInvoke(share.pause, []);
    } catch (error: any) {
      dest.destroy(error);
    }
  };
  share.ondata = ondata;

  const onerror: any = function (er: any): void {
    __sInvoke(share.unpipe, []);
    dest.removeListener("error", share.onerror);
    if (Number(__eventsListenerCount(dest, "error")) === 0) {
      const s: any = __sIsObj(dest._writableState) ? dest._writableState : dest._readableState;
      if (__sIsObj(s) && s.errorEmitted !== true) {
        __sErrorOrDestroy(dest, er);
      } else {
        __evEmit(dest, "error", [er]);
      }
    }
  };
  share.onerror = onerror;

  const onclose: any = function (): void {
    dest.removeListener("finish", share.onfinish);
    __sInvoke(share.unpipe, []);
  };
  share.onclose = onclose;

  const onfinish: any = function (): void {
    dest.removeListener("close", share.onclose);
    __sInvoke(share.unpipe, []);
  };
  share.onfinish = onfinish;

  const endFn: any = doEnd ? onend : unpipe;
  if (state.endEmitted === true) {
    __sTick(endFn);
  } else {
    src.once("end", endFn);
  }

  src.on("data", ondata);
  __sPrependListener(dest, "error", onerror);
  dest.once("close", onclose);
  dest.once("finish", onfinish);

  __evEmit(dest, "pipe", [src]);

  if (dest.writableNeedDrain === true) {
    __sInvoke(pause, []);
  } else if (state.flowing !== true) {
    src.resume();
  }

  return dest;
}

function __sUnpipe(src: any, dest: any): any {
  const state: any = src._readableState;
  if (Number(state.pipes.length) === 0) return src;

  if (dest === undefined || dest === null) {
    const dests: any[] = state.pipes;
    state.pipes = [];
    src.pause();
    const count = Number(dests.length);
    for (let i = 0; i < count; i++) {
      __evEmit(dests[i], "unpipe", [src, { hasUnpiped: false }]);
    }
    return src;
  }

  const index = Number(state.pipes.indexOf(dest));
  if (index === -1) return src;
  const pipes: any = state.pipes;
  pipes.splice(index, 1);
  if (Number(state.pipes.length) === 0) src.pause();
  __evEmit(dest, "unpipe", [src, { hasUnpiped: false }]);
  return src;
}

// `events`' own once-wrapper removes the listener by calling
// `__evRemoveListener` directly, which bypasses `Readable.prototype
// .removeListener` — and that override is the step that schedules
// `updateReadableListening`, which is what hands a stream back to flowing mode
// after a `once('readable')` cycle. Node gets this for free because its
// `_onceWrap` calls `this.removeListener(...)`. So `once` here wraps with a
// local copy that removes through the stream.
function __sOnceWrap(stream: any, type: any, listener: any): any {
  const state: any = { fired: false };
  const wrapped: any = function (): any {
    if (state.fired === true) return undefined;
    state.fired = true;
    const passed: any[] = [];
    const count = Number(arguments.length);
    for (let i = 0; i < count; i++) passed.push(arguments[i]);
    __sReadableOff(stream, type, state.wrapFn);
    return __evCall(listener, passed);
  };
  // Boxed, so it survives being returned, keeps one identity and can carry
  // `.listener` the way Node's wrapper does.
  const box: any = __evBox(wrapped);
  box.listener = __evUnbox(listener);
  __evRawSet(state, "wrapFn", box);
  return box;
}

// `Readable.prototype.on`, which Node overrides to arm flowing mode.
function __sReadableOn(stream: any, ev: any, fn: any, once: boolean): any {
  let listener: any = fn;
  if (once) {
    __evCheckListener(fn);
    listener = __sOnceWrap(stream, ev, fn);
  }
  const res: any = __evAddListener(stream, ev, listener, false);
  const state: any = stream._readableState;

  if (ev === "data") {
    state.dataListening = true;
    if (Number(__eventsListenerCount(stream, "readable")) > 0) state.readableListening = true;
    if (state.flowing !== false) stream.resume();
  } else if (ev === "readable") {
    if (state.endEmitted !== true && state.readableListening !== true) {
      state.readableListening = true;
      state.needReadable = true;
      state.flowing = false;
      state.emittedReadable = false;
      if (Number(state.length) > 0) {
        __sEmitReadable(stream);
      } else if (state.reading !== true) {
        __sTick(__sNReadingNextTick, stream);
      }
    }
  }
  return res;
}

function __sReadableOff(stream: any, ev: any, fn: any): any {
  const state: any = stream._readableState;
  const res: any = __evRemoveListener(stream, ev, fn);
  if (ev === "readable") {
    __sTick(__sUpdateReadableListening, stream);
  } else if (ev === "data" && Number(__eventsListenerCount(stream, "data")) === 0) {
    state.dataListening = false;
  }
  return res;
}

// ---------------------------------------------------------------------------
// The Readable class
// ---------------------------------------------------------------------------

class Readable extends Stream {
  constructor(options?: any) {
    super(options);
    __sSeedEvents(this, __S_READABLE_EVENTS);
    this._readableState = __sNewReadableState(options, this, false);
    __sAdoptOptions(this._readableState.fns, options);
    if (__sIsObj(options) && options.signal !== undefined && options.signal !== null) {
      __sAddAbortSignal(options.signal, this);
    }
    __sTryConstruct(this);
  }

  // ---- the overridable hooks ----------------------------------------------
  //
  // Accessor pairs rather than methods: see the hook dispatcher above for why
  // `r._read = fn` has to be an assignment into `state.fns` and how a
  // subclass method of the same name still wins.

  get _read(): any {
    return __sOptFn(this, "read");
  }
  set _read(fn: any) {
    __sSetOptFn(this, "read", fn);
  }

  get _destroy(): any {
    return __sOptFn(this, "destroy");
  }
  set _destroy(fn: any) {
    __sSetOptFn(this, "destroy", fn);
  }

  get _construct(): any {
    return __sOptFn(this, "construct");
  }
  set _construct(fn: any) {
    __sSetOptFn(this, "construct", fn);
  }

  _undestroy(): void {
    __sUndestroy(this);
  }

  // ---- the public surface -------------------------------------------------

  push(chunk?: any, encoding?: any): boolean {
    const state: any = this._readableState;
    return state.objectMode !== true
      ? __sPushByteMode(this, state, chunk === undefined ? undefined : chunk, encoding)
      : __sPushObjectMode(this, state, chunk === undefined ? undefined : chunk, encoding);
  }

  unshift(chunk?: any, encoding?: any): boolean {
    const state: any = this._readableState;
    return state.objectMode !== true
      ? __sUnshiftByteMode(this, state, chunk === undefined ? undefined : chunk, encoding)
      : __sUnshiftObjectMode(this, state, chunk === undefined ? undefined : chunk);
  }

  read(n?: any): any {
    return __sReadableRead(this, n);
  }

  isPaused(): boolean {
    const state: any = this._readableState;
    return state.paused === true || state.flowing === false;
  }

  setEncoding(enc?: any): any {
    return __sSetEncoding(this, enc);
  }

  pipe(dest: any, options?: any): any {
    return __sPipe(this, dest, options);
  }

  unpipe(dest?: any): any {
    return __sUnpipe(this, dest);
  }

  resume(): any {
    const state: any = this._readableState;
    if (state.flowing !== true) {
      state.flowing = state.readableListening !== true;
      __sResumeScheduled(this, state);
    }
    state.hasPaused = true;
    state.paused = false;
    return this;
  }

  pause(): any {
    const state: any = this._readableState;
    if (state.flowing !== false) {
      state.flowing = false;
      __evEmit(this, "pause", []);
    }
    state.hasPaused = true;
    state.paused = true;
    return this;
  }

  destroy(err?: any, cb?: any): any {
    return __sDestroy(this, err, cb);
  }

  // Node overrides `on`/`addListener` only, and `EventEmitter.prototype.once`
  // routes through `on`, so `once` arms flowing mode while `prependListener`
  // and `prependOnceListener` deliberately do not.
  on(ev: any, fn: any): any {
    return __sReadableOn(this, ev, fn, false);
  }

  addListener(ev: any, fn: any): any {
    return __sReadableOn(this, ev, fn, false);
  }

  once(ev: any, fn: any): any {
    return __sReadableOn(this, ev, fn, true);
  }

  prependListener(ev: any, fn: any): any {
    return __evAddListener(this, ev, fn, true);
  }

  prependOnceListener(ev: any, fn: any): any {
    __evCheckListener(fn);
    return __evAddListener(this, ev, __sOnceWrap(this, ev, fn), true);
  }

  removeListener(ev: any, fn: any): any {
    return __sReadableOff(this, ev, fn);
  }

  off(ev: any, fn: any): any {
    return __sReadableOff(this, ev, fn);
  }

  removeAllListeners(ev?: any): any {
    const res: any = __evRemoveAllListeners(this, ev, ev !== undefined);
    if (ev === "readable" || ev === undefined) {
      __sTick(__sUpdateReadableListening, this);
    }
    return res;
  }

  // `Readable.prototype.wrap`: adopt an old-style stream as the data source.
  wrap(stream: any): any {
    return __sReadableWrapInto(this, stream);
  }

  iterator(options?: any): any {
    if (options !== undefined) __sValidateObject(options, "options");
    return __sStreamAsyncIterator(this, options);
  }

  [Symbol.asyncIterator](): any {
    return __sStreamAsyncIterator(this, undefined);
  }

  // ---- the async operators (`lib/stream.js` installs these on the
  // prototype from `internal/streams/operators.js`) -------------------------

  map(fn: any, options?: any): any {
    return Readable.from(__sOpMap(this, fn, options));
  }

  filter(fn: any, options?: any): any {
    return Readable.from(__sOpFilter(this, fn, options));
  }

  flatMap(fn: any, options?: any): any {
    return Readable.from(__sOpFlatMap(this, fn, options));
  }

  drop(number: any, options?: any): any {
    return Readable.from(__sOpDrop(this, number, options));
  }

  take(number: any, options?: any): any {
    return Readable.from(__sOpTake(this, number, options));
  }

  compose(stream: any, options?: any): any {
    return __sComposeMethod(this, stream, options);
  }

  forEach(fn: any, options?: any): any {
    return __sOpForEach(this, fn, options);
  }

  toArray(options?: any): any {
    return __sOpToArray(this, options);
  }

  some(fn: any, options?: any): any {
    return __sOpSome(this, fn, options);
  }

  find(fn: any, options?: any): any {
    return __sOpFind(this, fn, options);
  }

  every(fn: any, options?: any): any {
    return __sOpEvery(this, fn, options);
  }

  // `hasInitialValue` is `arguments.length > 1` in Node. A class method has no
  // `arguments` object here, and the mere word injects a synthetic rest
  // parameter into the enclosing function (zun#40), so the presence test is
  // `initialValue !== undefined` — which differs from Node only for an
  // explicit `reduce(fn, undefined)`.
  reduce(reducer: any, initialValue?: any, options?: any): any {
    return __sOpReduce(this, reducer, initialValue, options, initialValue !== undefined);
  }

  // ---- accessors ----------------------------------------------------------

  get readable(): any {
    return __sGetReadable(this);
  }
  set readable(value: any) {
    const r: any = this._readableState;
    if (__sIsObj(r)) r.readable = value === true;
  }

  get readableDidRead(): any {
    return this._readableState.dataEmitted === true;
  }

  get readableAborted(): any {
    const r: any = this._readableState;
    return (
      r.readable !== false &&
      (r.destroyed === true || (r.errored !== null && r.errored !== undefined)) &&
      r.endEmitted !== true
    );
  }

  get readableHighWaterMark(): any {
    return Number(this._readableState.highWaterMark);
  }

  get readableBuffer(): any {
    return this._readableState.buffer;
  }

  get readableFlowing(): any {
    return this._readableState.flowing;
  }
  set readableFlowing(value: any) {
    const r: any = this._readableState;
    if (__sIsObj(r)) r.flowing = value;
  }

  get readableLength(): any {
    return Number(this._readableState.length);
  }

  get readableObjectMode(): any {
    return this._readableState.objectMode === true;
  }

  get readableEncoding(): any {
    return this._readableState.encoding;
  }

  get readableEnded(): any {
    return this._readableState.endEmitted === true;
  }

  get errored(): any {
    return __sGetErrored(this);
  }

  get closed(): any {
    return __sGetClosed(this);
  }

  get destroyed(): any {
    return __sGetDestroyed(this);
  }
  set destroyed(value: any) {
    const r: any = this._readableState;
    const w: any = this._writableState;
    if (__sIsObj(w)) w.destroyed = value;
    if (__sIsObj(r)) r.destroyed = value;
  }

  // ---- statics ------------------------------------------------------------
  //
  // `Readable.wrap` is absent: a class may not carry a static and an instance
  // method of one name here (zun#20), and the instance `wrap` is the one the
  // corpus calls. `__sReadableWrap` is the internal equivalent, and the module
  // object carries no second spelling of it either.

  static from(iterable: any, opts?: any): any {
    return __sReadableFrom(iterable, opts);
  }

  static fromWeb(readableStream: any, options?: any): any {
    return __sReadableFromWeb(readableStream, options);
  }

  static toWeb(streamReadable: any, options?: any): any {
    return __sReadableToWeb(streamReadable, options);
  }
}

function __sGetReadable(stream: any): boolean {
  const r: any = stream._readableState;
  if (!__sIsObj(r)) return false;
  return (
    r.readable !== false && r.destroyed !== true && r.errorEmitted !== true && r.endEmitted !== true
  );
}

function __sGetErrored(stream: any): any {
  const w: any = stream._writableState;
  if (__sIsObj(w) && w.errored !== null && w.errored !== undefined) return w.errored;
  const r: any = stream._readableState;
  if (__sIsObj(r) && r.errored !== null && r.errored !== undefined) return r.errored;
  return null;
}

function __sGetClosed(stream: any): boolean {
  const w: any = stream._writableState;
  if (__sIsObj(w)) return w.closed === true;
  const r: any = stream._readableState;
  return __sIsObj(r) && r.closed === true;
}

function __sGetDestroyed(stream: any): boolean {
  const w: any = stream._writableState;
  if (__sIsObj(w)) return w.destroyed === true;
  const r: any = stream._readableState;
  return __sIsObj(r) && r.destroyed === true;
}

// `Readable.prototype.wrap` — the `_read` override goes into the hook store
// rather than onto the instance, because a function assigned to a class field
// is unreachable afterwards (see note 1 in the header).
function __sReadableWrapInto(target: any, source: any): any {
  const shared: any = { paused: false };

  source.on("data", function (chunk: any): void {
    if (target.push(chunk) === false && __sDuck(source, "pause")) {
      shared.paused = true;
      source.pause();
    }
  });
  source.on("end", function (): void {
    target.push(null);
  });
  source.on("error", function (err: any): void {
    __sErrorOrDestroy(target, err);
  });
  source.on("close", function (): void {
    target.destroy();
  });
  source.on("destroy", function (): void {
    target.destroy();
  });

  __sSetOptFn(target, "read", function (): void {
    if (shared.paused && __sDuck(source, "resume")) {
      shared.paused = false;
      source.resume();
    }
  });

  return target;
}

function __sReadableWrap(src: any, options?: any): any {
  const objectMode: any =
    src.readableObjectMode !== undefined && src.readableObjectMode !== null
      ? src.readableObjectMode
      : src.objectMode !== undefined && src.objectMode !== null
        ? src.objectMode
        : true;
  const opts: any = { objectMode: objectMode };
  if (__sIsObj(options)) {
    for (const key of Object.keys(options)) opts[key] = options[key];
  }
  opts.destroy = function (err: any, callback: any): void {
    __sDestroyer(src, err);
    __sInvoke(callback, [err]);
  };
  const wrapper: any = new Readable(opts);
  return __sReadableWrapInto(wrapper, src);
}

// ---------------------------------------------------------------------------
// Writable (`lib/internal/streams/writable.js`)
// ---------------------------------------------------------------------------

function __sWriteImpl(stream: any, chunk: any, encoding: any, cb: any): any {
  const state: any = stream._writableState;
  let callback: any = cb;
  if (!__sIsFn(callback)) callback = undefined;

  if (chunk === null) throw new ERR_STREAM_NULL_VALUES();

  let value: any = chunk;
  let enc: any = encoding;
  if (state.objectMode !== true) {
    if (enc === undefined || enc === null || enc === "") {
      enc = state.defaultEncoding;
    } else if (enc !== "buffer" && __bufNormalizeEncoding(enc) === undefined) {
      throw new ERR_UNKNOWN_ENCODING(enc);
    }
    if (typeof value === "string") {
      // Node turns the string into a Buffer when `decodeStrings` is on; the
      // string is kept here (see the Buffer note in the header) and the
      // encoding tag still becomes 'buffer' so `_writev` reports `allBuffers`
      // the way Node does.
      if (state.decodeStrings !== false) enc = "buffer";
    } else if (__sIsView(value)) {
      enc = "buffer";
    } else {
      throw new ERR_INVALID_ARG_TYPE(
        "chunk",
        ["string", "Buffer", "TypedArray", "DataView"],
        value,
      );
    }
  }

  let err: any = undefined;
  if (state.ending === true) {
    err = new ERR_STREAM_WRITE_AFTER_END();
  } else if (state.destroyed === true) {
    err = new ERR_STREAM_DESTROYED("write");
  }

  if (err !== undefined) {
    if (callback !== undefined) __sTick1(callback, err);
    __sErrorOrDestroy(stream, err, true);
    return err;
  }

  state.pendingcb = Number(state.pendingcb) + 1;
  return __sWriteOrBuffer(stream, state, value, enc, callback);
}

function __sWriteOrBuffer(stream: any, state: any, chunk: any, encoding: any, callback: any): boolean {
  const len = state.objectMode === true ? 1 : __sChunkLen(state, chunk);
  state.length = Number(state.length) + len;

  if (
    state.writing === true ||
    (state.errored !== null && state.errored !== undefined) ||
    Number(state.corked) > 0 ||
    state.constructed !== true
  ) {
    if (state.buffered === null || state.buffered === undefined) state.buffered = [];
    state.buffered.push({ chunk: chunk, encoding: encoding, callback: callback });
    if (state.allBuffers === true && encoding !== "buffer") state.allBuffers = false;
    if (state.allNoop === true && callback !== undefined) state.allNoop = false;
  } else {
    state.writelen = len;
    state.writecb = callback;
    state.writing = true;
    state.sync = true;
    state.expectWriteCb = true;
    __sDoWriteCall(stream, state, false, chunk, encoding);
    state.sync = false;
  }

  const ret: boolean =
    Number(state.length) < Number(state.highWaterMark) || Number(state.length) === 0;
  if (!ret) state.needDrain = true;

  return (
    ret && state.destroyed !== true && (state.errored === null || state.errored === undefined)
  );
}

// `stream._write(chunk, encoding, state.onwrite)`, with the sentinel standing
// in for "no `_write` and no `_writev`".
function __sDoWriteCall(stream: any, state: any, writev: boolean, chunk: any, encoding: any): void {
  try {
    if (writev) {
      __sHookWritev(stream, chunk, state.onwrite);
    } else {
      __sHookWrite(stream, chunk, encoding, state.onwrite);
    }
  } catch (err: any) {
    if (err === __S_NO_IMPL) {
      // Node's `Writable.prototype._write` *throws* when there is no `_writev`
      // behind it, and `writeOrBuffer` does not catch, so the error comes out
      // of `write()` rather than through the 'error' event.
      throw new ERR_METHOD_NOT_IMPLEMENTED(writev ? "_writev()" : "_write()");
    }
    // A synchronous throw out of `_write` is an error on the write, which is
    // what `onwrite` reports; Node gets there through the same path because
    // `_write` is expected to report through the callback.
    throw err;
  }
}

function __sDoWrite(stream: any, state: any, writev: boolean, len: number, chunk: any, encoding: any, cb: any): void {
  state.writelen = len;
  state.writecb = cb;
  state.writing = true;
  state.sync = true;
  state.expectWriteCb = true;
  if (state.destroyed === true) {
    __sInvoke(state.onwrite, [new ERR_STREAM_DESTROYED("write")]);
  } else {
    __sDoWriteCall(stream, state, writev, chunk, encoding);
  }
  state.sync = false;
}

function __sOnwriteErrorNT(info: any): void {
  __sOnwriteError(info.stream, info.state, info.er, info.cb);
}

function __sAfterWriteNT(info: any): void {
  __sAfterWrite(info.stream, info.state, Number(info.count), info.cb);
}

function __sOnwriteError(stream: any, state: any, er: any, cb: any): void {
  state.pendingcb = Number(state.pendingcb) - 1;
  if (cb !== undefined && cb !== null) __sInvoke(cb, [er]);
  __sErrorBuffer(state);
  __sErrorOrDestroy(stream, er);
}

function __sOnwrite(stream: any, er: any): void {
  const state: any = stream._writableState;

  if (state.expectWriteCb !== true) {
    __sErrorOrDestroy(stream, new ERR_MULTIPLE_CALLBACK());
    return;
  }

  const sync: boolean = state.sync === true;
  const cb: any = state.writecb;

  state.writecb = null;
  state.writing = false;
  state.expectWriteCb = false;
  state.length = Number(state.length) - Number(state.writelen);
  state.writelen = 0;

  if (er !== undefined && er !== null) {
    if (state.errored === null || state.errored === undefined) state.errored = er;
    const r: any = stream._readableState;
    if (__sIsObj(r) && (r.errored === null || r.errored === undefined)) r.errored = er;
    if (sync) {
      // One record rather than four forwarded arguments: `nextTick` with four
      // of them does not survive the call (see `__sTick`).
      __sTick(__sOnwriteErrorNT, { stream: stream, state: state, er: er, cb: cb });
    } else {
      __sOnwriteError(stream, state, er, cb);
    }
    return;
  }

  if (state.buffered !== null && state.buffered !== undefined) {
    __sClearBuffer(stream, state);
  }

  if (sync) {
    const needDrain: boolean = state.needDrain === true && Number(state.length) === 0;
    // Node compares the callback against its module-level `nop`; an absent
    // callback is `undefined` or `null` here, which is the same thing.
    const hasCb: boolean = cb !== null && cb !== undefined;
    const needTick: boolean = needDrain || state.destroyed === true || hasCb;
    if (cb === null || cb === undefined) {
      if (state.afterWritePending !== true && needTick) {
        __sTick(__sAfterWriteNT, { stream: stream, state: state, count: 1, cb: cb });
        state.afterWritePending = true;
      } else {
        state.pendingcb = Number(state.pendingcb) - 1;
        if (state.ending === true) __sFinishMaybe(stream, state, true);
      }
    } else if (
      state.afterWriteTickInfo !== null &&
      state.afterWriteTickInfo !== undefined &&
      state.afterWriteTickInfo.cb === cb
    ) {
      state.afterWriteTickInfo.count = Number(state.afterWriteTickInfo.count) + 1;
    } else if (needTick) {
      state.afterWriteTickInfo = { count: 1, cb: cb, stream: stream, state: state };
      __sTick(__sAfterWriteTick, state.afterWriteTickInfo);
      state.afterWritePending = true;
    } else {
      state.pendingcb = Number(state.pendingcb) - 1;
      if (state.ending === true) __sFinishMaybe(stream, state, true);
    }
  } else {
    __sAfterWrite(stream, state, 1, cb);
  }
}

function __sAfterWriteTick(info: any): void {
  const state: any = info.state;
  state.afterWriteTickInfo = null;
  __sAfterWrite(info.stream, state, Number(info.count), info.cb);
}

function __sAfterWrite(stream: any, state: any, count: any, cb: any): void {
  state.afterWritePending = false;

  const needDrain: boolean =
    state.ending !== true &&
    state.needDrain === true &&
    state.destroyed !== true &&
    Number(state.length) === 0;
  if (needDrain) {
    state.needDrain = false;
    __evEmit(stream, "drain", []);
  }

  let remaining = Number(count);
  while (remaining > 0) {
    remaining = remaining - 1;
    state.pendingcb = Number(state.pendingcb) - 1;
    if (cb !== null && cb !== undefined) __sInvoke(cb, [null]);
  }

  if (state.destroyed === true) __sErrorBuffer(state);

  if (state.ending === true) __sFinishMaybe(stream, state, true);
}

function __sErrorBuffer(state: any): void {
  if (state.writing === true) return;

  const list: any = state.buffered;
  if (list !== null && list !== undefined) {
    const count = Number(list.length);
    for (let n = Number(state.bufferedIndex); n < count; n++) {
      const entry: any = list[n];
      if (entry === null || entry === undefined) continue;
      const len = state.objectMode === true ? 1 : __sChunkLen(state, entry.chunk);
      state.length = Number(state.length) - len;
      const failure: any =
        state.errored !== null && state.errored !== undefined
          ? state.errored
          : new ERR_STREAM_DESTROYED("write");
      if (entry.callback !== undefined && entry.callback !== null) {
        __sInvoke(entry.callback, [failure]);
      }
    }
  }

  __sCallFinishedCallbacks(
    state,
    state.errored !== null && state.errored !== undefined
      ? state.errored
      : new ERR_STREAM_DESTROYED("end"),
  );

  __sResetBuffer(state);
}

function __sClearBuffer(stream: any, state: any): void {
  if (
    state.destroyed === true ||
    state.bufferProcessing === true ||
    Number(state.corked) > 0 ||
    state.buffered === null ||
    state.buffered === undefined ||
    state.constructed !== true
  ) {
    return;
  }

  const objectMode: boolean = state.objectMode === true;
  const buffered: any = state.buffered;
  const bufferedIndex = Number(state.bufferedIndex);
  const bufferedLength = Number(buffered.length) - bufferedIndex;
  if (bufferedLength <= 0) return;

  let i = bufferedIndex;
  state.bufferProcessing = true;

  if (bufferedLength > 1) {
    // Try the vectored path first. The base `_writev` throws the sentinel when
    // neither an option nor an override supplied one, which is how "no
    // `_writev`" is discovered here; the throw is synchronous and precedes any
    // user code, so the state set below is simply rolled back.
    const allNoop: boolean = state.allNoop === true;
    const chunks: any[] = allNoop && i === 0 ? buffered : buffered.slice(i);
    // Node tags the batch with `chunks.allBuffers`; an array cannot carry a
    // property here ("type Array has no fields"), and the flag is only read by
    // `_writev` implementations inside Node core, never by a test.
    const batchCb: any = allNoop
      ? undefined
      : function (err: any): void {
          const total = Number(buffered.length);
          for (let n = i; n < total; n++) {
            const entry: any = buffered[n];
            if (entry !== null && entry !== undefined && entry.callback !== undefined) {
              __sInvoke(entry.callback, [err]);
            }
          }
        };

    const savedPending = Number(state.pendingcb);
    state.pendingcb = savedPending - (bufferedLength - 1);
    state.writelen = Number(state.length);
    state.writecb = batchCb === undefined ? null : batchCb;
    state.writing = true;
    state.sync = true;
    state.expectWriteCb = true;
    let noWritev = false;
    if (state.destroyed === true) {
      __sInvoke(state.onwrite, [new ERR_STREAM_DESTROYED("write")]);
    } else {
      try {
        __sHookWritev(stream, chunks, state.onwrite);
      } catch (err: any) {
        if (err === __S_NO_IMPL) {
          noWritev = true;
        } else {
          state.sync = false;
          state.bufferProcessing = false;
          throw err;
        }
      }
    }
    state.sync = false;

    if (!noWritev) {
      __sResetBuffer(state);
      state.bufferProcessing = false;
      return;
    }

    // Roll back: there is no `_writev`, so fall through to one write per chunk.
    state.pendingcb = savedPending;
    state.writelen = 0;
    state.writecb = null;
    state.writing = false;
    state.expectWriteCb = false;
  }

  let guard = true;
  while (guard) {
    const entry: any = buffered[i];
    buffered[i] = null;
    i = i + 1;
    const len = objectMode === true ? 1 : __sChunkLen(state, entry.chunk);
    __sDoWrite(stream, state, false, len, entry.chunk, entry.encoding, entry.callback);
    guard = i < Number(buffered.length) && state.writing !== true;
  }

  if (i === Number(buffered.length)) {
    __sResetBuffer(state);
  } else {
    state.bufferedIndex = i;
  }
  state.bufferProcessing = false;
}

function __sNeedFinish(state: any): boolean {
  return (
    state.ending === true &&
    state.constructed === true &&
    state.destroyed !== true &&
    state.finished !== true &&
    state.writing !== true &&
    state.errorEmitted !== true &&
    state.closeEmitted !== true &&
    (state.errored === null || state.errored === undefined) &&
    (state.buffered === null || state.buffered === undefined) &&
    Number(state.length) === 0
  );
}

function __sOnFinishHook(stream: any, state: any, err: any): void {
  if (state.prefinished === true) {
    __sErrorOrDestroy(
      stream,
      err === undefined || err === null ? new ERR_MULTIPLE_CALLBACK() : err,
    );
    return;
  }
  state.pendingcb = Number(state.pendingcb) - 1;
  if (err !== undefined && err !== null) {
    __sCallFinishedCallbacks(state, err);
    __sErrorOrDestroy(stream, err, state.sync === true);
  } else if (__sNeedFinish(state)) {
    state.prefinished = true;
    __evEmit(stream, "prefinish", []);
    state.pendingcb = Number(state.pendingcb) + 1;
    __sTick(__sFinish, stream, state);
  }
}

function __sPrefinish(stream: any, state: any): void {
  if (state.prefinished === true || state.finalCalled === true) return;

  if (state.destroyed !== true) {
    state.finalCalled = true;
    state.sync = true;
    state.pendingcb = Number(state.pendingcb) + 1;
    let absent = false;
    const onFinal: any = function (err: any): void {
      __sOnFinishHook(stream, state, err);
    };
    try {
      __sHookFinal(stream, onFinal);
    } catch (err: any) {
      if (err === __S_NO_IMPL) {
        absent = true;
      } else {
        __sOnFinishHook(stream, state, err);
      }
    }
    state.sync = false;
    if (absent) {
      state.pendingcb = Number(state.pendingcb) - 1;
      state.prefinished = true;
      __evEmit(stream, "prefinish", []);
    }
    return;
  }

  state.finalCalled = true;
  state.prefinished = true;
  __evEmit(stream, "prefinish", []);
}

function __sFinishMaybe(stream: any, state: any, sync?: any): void {
  if (!__sNeedFinish(state)) return;
  __sPrefinish(stream, state);
  if (Number(state.pendingcb) === 0) {
    if (sync === true) {
      state.pendingcb = Number(state.pendingcb) + 1;
      __sTick(__sFinishMaybeNT, stream, state);
    } else if (__sNeedFinish(state)) {
      state.pendingcb = Number(state.pendingcb) + 1;
      __sFinish(stream, state);
    }
  }
}

function __sFinishMaybeNT(stream: any, state: any): void {
  if (__sNeedFinish(state)) {
    __sFinish(stream, state);
  } else {
    state.pendingcb = Number(state.pendingcb) - 1;
  }
}

function __sFinish(stream: any, state: any): void {
  state.pendingcb = Number(state.pendingcb) - 1;
  state.finished = true;

  __sCallFinishedCallbacks(state, null);
  __evEmit(stream, "finish", []);

  if (state.autoDestroy === true) {
    const r: any = stream._readableState;
    const auto: boolean =
      !__sIsObj(r) || (r.autoDestroy === true && (r.endEmitted === true || r.readable === false));
    if (auto) stream.destroy();
  }
}

function __sCallFinishedCallbacks(state: any, err: any): void {
  const callbacks: any = state.onfinishCallbacks;
  if (callbacks === null || callbacks === undefined) return;
  state.onfinishCallbacks = null;
  const count = Number(callbacks.length);
  for (let i = 0; i < count; i++) __sInvoke(callbacks[i], [err]);
}

function __sWritableEnd(stream: any, chunk: any, encoding: any, cb: any): any {
  const state: any = stream._writableState;
  let data: any = chunk;
  let enc: any = encoding;
  let callback: any = cb;

  if (__sIsFn(data)) {
    callback = data;
    data = null;
    enc = null;
  } else if (__sIsFn(enc)) {
    callback = enc;
    enc = null;
  }

  let err: any = undefined;
  if (data !== undefined && data !== null) {
    const ret: any = __sWriteImpl(stream, data, enc, undefined);
    if (ret instanceof Error) err = ret;
  }

  if (Number(state.corked) > 0) {
    state.corked = 1;
    stream.uncork();
  }

  if (err !== undefined) {
    // Nothing: `_write` already reported it.
  } else if (state.ending !== true && (state.errored === null || state.errored === undefined)) {
    state.ending = true;
    __sFinishMaybe(stream, state, true);
    state.ended = true;
  } else if (state.finished === true) {
    err = new ERR_STREAM_ALREADY_FINISHED("end");
  } else if (state.destroyed === true) {
    err = new ERR_STREAM_DESTROYED("end");
  }

  if (__sIsFn(callback)) {
    if (err !== undefined) {
      __sTick1(callback, err);
    } else if (state.errored !== null && state.errored !== undefined) {
      __sTick1(callback, state.errored);
    } else if (state.finished === true) {
      __sTick1(callback, null);
    } else {
      if (state.onfinishCallbacks === null || state.onfinishCallbacks === undefined) {
        state.onfinishCallbacks = [];
      }
      state.onfinishCallbacks.push(callback);
    }
  }

  return stream;
}

// ---------------------------------------------------------------------------
// The Writable class
//
// Node builds Duplex by copying `Writable.prototype`'s own keys onto
// `Duplex.prototype`. There is no prototype surgery here, so the writable
// *surface* is spelled twice — once on `Writable`, once on `Duplex` — while
// every line of behaviour stays in the free functions above, which both
// spellings call. `instanceof Writable` is therefore `false` for a Duplex: the
// `Symbol.hasInstance` hook Node installs cannot be expressed (zun#31).
// ---------------------------------------------------------------------------

class Writable extends Stream {
  constructor(options?: any) {
    super(options);
    __sSeedEvents(this, __S_WRITABLE_EVENTS);
    this._writableState = __sNewWritableState(options, this, false);
    __sAdoptOptions(this._writableState.fns, options);
    if (__sIsObj(options) && options.signal !== undefined && options.signal !== null) {
      __sAddAbortSignal(options.signal, this);
    }
    __sTryConstruct(this);
  }

  // ---- the overridable hooks (accessor pairs; see the hook dispatcher) ----

  get _write(): any {
    return __sOptFn(this, "write");
  }
  set _write(fn: any) {
    __sSetOptFn(this, "write", fn);
  }

  get _writev(): any {
    return __sOptFn(this, "writev");
  }
  set _writev(fn: any) {
    __sSetOptFn(this, "writev", fn);
  }

  get _final(): any {
    return __sOptFn(this, "final");
  }
  set _final(fn: any) {
    __sSetOptFn(this, "final", fn);
  }

  get _destroy(): any {
    return __sOptFn(this, "destroy");
  }
  set _destroy(fn: any) {
    __sSetOptFn(this, "destroy", fn);
  }

  get _construct(): any {
    return __sOptFn(this, "construct");
  }
  set _construct(fn: any) {
    __sSetOptFn(this, "construct", fn);
  }

  _undestroy(): void {
    __sUndestroy(this);
  }

  // ---- the public surface -------------------------------------------------

  write(chunk?: any, encoding?: any, cb?: any): boolean {
    let enc: any = encoding;
    let callback: any = cb;
    if (enc !== undefined && enc !== null && __sIsFn(enc)) {
      callback = enc;
      enc = null;
    }
    return __sWriteImpl(this, chunk, enc, callback) === true;
  }

  end(chunk?: any, encoding?: any, cb?: any): any {
    return __sWritableEnd(this, chunk, encoding, cb);
  }

  cork(): void {
    const state: any = this._writableState;
    state.corked = Number(state.corked) + 1;
  }

  uncork(): void {
    const state: any = this._writableState;
    if (Number(state.corked) > 0) {
      state.corked = Number(state.corked) - 1;
      if (state.writing !== true) __sClearBuffer(this, state);
    }
  }

  setDefaultEncoding(encoding: any): any {
    let enc: any = encoding;
    if (typeof enc === "string") enc = enc.toLowerCase();
    if (__bufNormalizeEncoding(enc) === undefined) throw new ERR_UNKNOWN_ENCODING(encoding);
    this._writableState.defaultEncoding = enc;
    return this;
  }

  // "Otherwise people can pipe Writable streams, which is just wrong."
  pipe(dest?: any, options?: any): any {
    __sErrorOrDestroy(this, new ERR_STREAM_CANNOT_PIPE());
    return undefined;
  }

  destroy(err?: any, cb?: any): any {
    const state: any = this._writableState;
    if (
      (state.buffered !== null && state.buffered !== undefined) ||
      (state.onfinishCallbacks !== null && state.onfinishCallbacks !== undefined)
    ) {
      if (state.destroyed !== true) __sTick(__sErrorBuffer, state);
    }
    __sDestroy(this, err, cb);
    return this;
  }

  // ---- accessors ----------------------------------------------------------

  get writable(): any {
    return __sGetWritable(this);
  }
  set writable(value: any) {
    const w: any = this._writableState;
    if (__sIsObj(w)) w.writable = value === true;
  }

  get writableFinished(): any {
    return this._writableState.finished === true;
  }

  get writableObjectMode(): any {
    return this._writableState.objectMode === true;
  }

  get writableBuffer(): any {
    return this._writableState.getBuffer();
  }

  get writableEnded(): any {
    return this._writableState.ending === true;
  }

  get writableNeedDrain(): any {
    const state: any = this._writableState;
    return state.destroyed !== true && state.ending !== true && state.needDrain === true;
  }

  get writableHighWaterMark(): any {
    return Number(this._writableState.highWaterMark);
  }

  get writableCorked(): any {
    return Number(this._writableState.corked);
  }

  get writableLength(): any {
    return Number(this._writableState.length);
  }

  get writableAborted(): any {
    return __sGetWritableAborted(this);
  }

  get errored(): any {
    return __sGetErrored(this);
  }

  get closed(): any {
    return __sGetClosed(this);
  }

  get destroyed(): any {
    return __sGetDestroyed(this);
  }
  set destroyed(value: any) {
    const w: any = this._writableState;
    if (__sIsObj(w)) w.destroyed = value;
  }

  static fromWeb(writableStream: any, options?: any): any {
    return __sWritableFromWeb(writableStream, options);
  }

  static toWeb(streamWritable: any): any {
    return __sWritableToWeb(streamWritable);
  }
}

function __sGetWritable(stream: any): boolean {
  const w: any = stream._writableState;
  if (!__sIsObj(w)) return false;
  return (
    w.writable !== false &&
    w.ending !== true &&
    w.ended !== true &&
    w.destroyed !== true &&
    (w.errored === null || w.errored === undefined)
  );
}

function __sGetWritableAborted(stream: any): boolean {
  const state: any = stream._writableState;
  if (!__sIsObj(state)) return false;
  return (
    state.writable !== false &&
    (state.destroyed === true || (state.errored !== null && state.errored !== undefined)) &&
    state.finished !== true
  );
}

// ---------------------------------------------------------------------------
// Duplex (`lib/internal/streams/duplex.js`)
// ---------------------------------------------------------------------------

class Duplex extends Readable {
  constructor(options?: any) {
    super(undefined);
    // `Readable` seeded its own event order; a Duplex cares about both sides,
    // so the list is replaced rather than appended to.
    this.__evTypes = [];
    __sSeedEvents(this, __S_DUPLEX_EVENTS);
    // The readable side was built by `Readable` with no options so that its
    // construct probe does not run twice; both states are rebuilt here with
    // `isDuplex` true, which is what makes `readableObjectMode` /
    // `writableObjectMode` and the split high water marks work.
    this._readableState = __sNewReadableState(options, this, true);
    this._writableState = __sNewWritableState(options, this, true);
    const fns: any = this._readableState.fns;
    this._writableState.fns = fns;
    __sAdoptOptions(fns, options);

    if (__sIsObj(options)) {
      this.allowHalfOpen = options.allowHalfOpen !== false;
      if (options.readable === false) {
        this._readableState.readable = false;
        this._readableState.ended = true;
        this._readableState.endEmitted = true;
      }
      if (options.writable === false) {
        this._writableState.writable = false;
        this._writableState.ending = true;
        this._writableState.ended = true;
        this._writableState.finished = true;
      }
      if (options.signal !== undefined && options.signal !== null) {
        __sAddAbortSignal(options.signal, this);
      }
    }
    __sTryConstruct(this);
  }

  // ---- the writable hooks and surface, spelled again -----------------------

  get _write(): any {
    return __sOptFn(this, "write");
  }
  set _write(fn: any) {
    __sSetOptFn(this, "write", fn);
  }

  get _writev(): any {
    return __sOptFn(this, "writev");
  }
  set _writev(fn: any) {
    __sSetOptFn(this, "writev", fn);
  }

  get _final(): any {
    return __sOptFn(this, "final");
  }
  set _final(fn: any) {
    __sSetOptFn(this, "final", fn);
  }

  write(chunk?: any, encoding?: any, cb?: any): boolean {
    let enc: any = encoding;
    let callback: any = cb;
    if (enc !== undefined && enc !== null && __sIsFn(enc)) {
      callback = enc;
      enc = null;
    }
    return __sWriteImpl(this, chunk, enc, callback) === true;
  }

  end(chunk?: any, encoding?: any, cb?: any): any {
    return __sWritableEnd(this, chunk, encoding, cb);
  }

  cork(): void {
    const state: any = this._writableState;
    state.corked = Number(state.corked) + 1;
  }

  uncork(): void {
    const state: any = this._writableState;
    if (Number(state.corked) > 0) {
      state.corked = Number(state.corked) - 1;
      if (state.writing !== true) __sClearBuffer(this, state);
    }
  }

  setDefaultEncoding(encoding: any): any {
    let enc: any = encoding;
    if (typeof enc === "string") enc = enc.toLowerCase();
    if (__bufNormalizeEncoding(enc) === undefined) throw new ERR_UNKNOWN_ENCODING(encoding);
    this._writableState.defaultEncoding = enc;
    return this;
  }

  // `Duplex.prototype.destroy` is `Writable.prototype.destroy` in Node.
  destroy(err?: any, cb?: any): any {
    const state: any = this._writableState;
    if (
      (state.buffered !== null && state.buffered !== undefined) ||
      (state.onfinishCallbacks !== null && state.onfinishCallbacks !== undefined)
    ) {
      if (state.destroyed !== true) __sTick(__sErrorBuffer, state);
    }
    __sDestroy(this, err, cb);
    return this;
  }

  get writable(): any {
    return __sGetWritable(this);
  }
  set writable(value: any) {
    const w: any = this._writableState;
    if (__sIsObj(w)) w.writable = value === true;
  }

  get writableFinished(): any {
    return this._writableState.finished === true;
  }

  get writableObjectMode(): any {
    return this._writableState.objectMode === true;
  }

  get writableBuffer(): any {
    return this._writableState.getBuffer();
  }

  get writableEnded(): any {
    return this._writableState.ending === true;
  }

  get writableNeedDrain(): any {
    const state: any = this._writableState;
    return state.destroyed !== true && state.ending !== true && state.needDrain === true;
  }

  get writableHighWaterMark(): any {
    return Number(this._writableState.highWaterMark);
  }

  get writableCorked(): any {
    return Number(this._writableState.corked);
  }

  get writableLength(): any {
    return Number(this._writableState.length);
  }

  get writableAborted(): any {
    return __sGetWritableAborted(this);
  }

  static from(body: any): any {
    return __sDuplexFrom(body);
  }

  static fromWeb(pair: any, options?: any): any {
    return __sDuplexFromWeb(pair, options);
  }

  static toWeb(duplex: any): any {
    return __sDuplexToWeb(duplex);
  }
}

// ---------------------------------------------------------------------------
// Transform (`lib/internal/streams/transform.js`)
// ---------------------------------------------------------------------------

class Transform extends Duplex {
  constructor(options?: any) {
    super(__sTransformOptions(options));
    // Node unsets the readable sync guard right after `Duplex.call`, because
    // `_read` is implemented here.
    this._readableState.sync = false;
    this._readableState.transformCallback = null;
    // A listener is invoked as `fn(...args)` with no receiver (zun#1), so the
    // stream is captured rather than read off `this`.
    const self: any = this;
    this.on("prefinish", function (): void {
      __sTransformPrefinish(self);
    });
  }

  get _transform(): any {
    return __sOptFn(this, "transform");
  }
  set _transform(fn: any) {
    __sSetOptFn(this, "transform", fn);
  }

  get _flush(): any {
    return __sOptFn(this, "flush");
  }
  set _flush(fn: any) {
    __sSetOptFn(this, "flush", fn);
  }
}

// A Transform buffers hwm elements on the readable side only, so a
// `readableHighWaterMark` of 0 disables buffering on the writable side too.
function __sTransformOptions(options: any): any {
  if (!__sIsObj(options)) return options;
  const probe: any = { objectMode: options.objectMode === true };
  const readableHighWaterMark: any = __sGetHighWaterMark(
    probe,
    options,
    "readableHighWaterMark",
    true,
  );
  if (Number(readableHighWaterMark) !== 0) return options;
  const copy: any = {};
  for (const key of Object.keys(options)) copy[key] = options[key];
  copy.highWaterMark = null;
  copy.readableHighWaterMark = 0;
  copy.writableHighWaterMark =
    options.writableHighWaterMark === undefined || options.writableHighWaterMark === null
      ? 0
      : options.writableHighWaterMark;
  return copy;
}

// `Transform`'s 'prefinish' listener. Node compares `this._final !== final` to
// decide whether the flush still has to run; the equivalent test here is
// whether the user supplied a `final` of their own, because that is the only
// way `_final` can be something other than the flush-driven one.
function __sTransformPrefinish(self: any): void {
  if (__sOptFn(self, "final") !== undefined) __sTransformFinal(self, undefined);
}

function __sTransformFinal(stream: any, cb: any): any {
  if (stream.destroyed !== true) {
    const onFlushed: any = function (er: any, data: any): void {
      if (er !== undefined && er !== null) {
        if (cb !== undefined && cb !== null) {
          __sInvoke(cb, [er]);
        } else {
          stream.destroy(er);
        }
        return;
      }
      if (data !== undefined && data !== null) stream.push(data);
      stream.push(null);
      if (cb !== undefined && cb !== null) __sInvoke(cb, []);
    };
    try {
      return __sHookFlush(stream, onFlushed);
    } catch (err: any) {
      if (err !== __S_NO_IMPL) {
        if (cb !== undefined && cb !== null) {
          __sInvoke(cb, [err]);
          return undefined;
        }
        stream.destroy(err);
        return undefined;
      }
    }
  }
  stream.push(null);
  if (cb !== undefined && cb !== null) __sInvoke(cb, []);
  return undefined;
}

function __sTransformWrite(stream: any, chunk: any, encoding: any, callback: any): any {
  const rState: any = stream._readableState;
  const wState: any = stream._writableState;
  const length = Number(rState.length);

  const afterTransform: any = function (err: any, val: any): void {
    if (err !== undefined && err !== null) {
      __sInvoke(callback, [err]);
      return;
    }
    if (val !== undefined && val !== null) stream.push(val);

    if (rState.ended === true) {
      // `push(null)` happened inside the transform: let the new state settle.
      __sTick(callback);
    } else if (
      wState.ended === true ||
      length === Number(rState.length) ||
      Number(rState.length) < Number(rState.highWaterMark)
    ) {
      __sInvoke(callback, []);
    } else {
      rState.transformCallback = callback;
    }
  };

  return __sHookTransform(stream, chunk, encoding, afterTransform);
}

// ---------------------------------------------------------------------------
// PassThrough (`lib/internal/streams/passthrough.js`)
// ---------------------------------------------------------------------------

class PassThrough extends Transform {
  constructor(options?: any) {
    super(options);
  }
}

// ---------------------------------------------------------------------------
// addAbortSignal (`lib/internal/streams/add-abort-signal.js`)
// ---------------------------------------------------------------------------

function __sAddAbortSignal(signal: any, stream: any): any {
  if (typeof signal !== "object" || signal === null || signal.aborted === undefined) {
    throw new ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  }
  if (!__sIsNodeStream(stream) && !__sIsWebStream(stream)) {
    throw new ERR_INVALID_ARG_TYPE(
      "stream",
      ["ReadableStream", "WritableStream", "Stream"],
      stream,
    );
  }
  return __sAddAbortSignalNoValidate(signal, stream);
}

function __sAddAbortSignalNoValidate(signal: any, stream: any): any {
  if (typeof signal !== "object" || signal === null || signal.aborted === undefined) {
    return stream;
  }
  const onAbort: any = function (): void {
    stream.destroy(new AbortError(undefined, { cause: signal.reason }));
  };
  if (signal.aborted === true) {
    __sInvoke(onAbort, []);
  } else {
    signal.addEventListener("abort", onAbort);
    const detach: any = function (): void {
      signal.removeEventListener("abort", onAbort);
    };
    __sEos(stream, undefined, detach);
  }
  return stream;
}

// ---------------------------------------------------------------------------
// end-of-stream (`lib/internal/streams/end-of-stream.js`)
//
// `eos(stream, options, callback)` answers once, with an error or without, and
// hands back a cleanup function. The whole state of the walk lives on one
// holder object, because the listeners refer to each other and to the shared
// `callback` slot.
// ---------------------------------------------------------------------------

function __sEos(stream: any, options: any, callback: any): any {
  let opts: any = options;
  let cb: any = callback;
  if (cb === undefined) {
    cb = opts;
    opts = {};
  } else if (opts === undefined || opts === null) {
    opts = {};
  } else {
    __sValidateObject(opts, "options");
  }
  __sValidateFunction(cb, "callback");
  __sValidateAbortSignal(opts.signal, "options.signal");

  if (__sIsReadableStream(stream) || __sIsWritableStream(stream)) {
    return __sEosWeb(stream, opts, __sOnce(cb));
  }

  if (!__sIsNodeStream(stream)) {
    throw new ERR_INVALID_ARG_TYPE(
      "stream",
      ["ReadableStream", "WritableStream", "Stream"],
      stream,
    );
  }

  const readable: boolean =
    opts.readable !== undefined && opts.readable !== null
      ? opts.readable === true
      : __sIsReadableNodeStream(stream);
  const writable: boolean =
    opts.writable !== undefined && opts.writable !== null
      ? opts.writable === true
      : __sIsWritableNodeStream(stream);

  const wState: any = stream._writableState;
  const rState: any = stream._readableState;

  const h: any = {
    callback: __sOnce(cb),
    willEmitClose:
      __sWillEmitClose(stream) === true &&
      __sIsReadableNodeStream(stream) === readable &&
      __sIsWritableNodeStream(stream) === writable,
    writableFinished: __sIsWritableFinished(stream, false) === true,
    readableFinished: __sIsReadableFinished(stream, false) === true,
    closed: __sIsClosed(stream) === true,
    onlegacyfinish: null,
    onfinish: null,
    onend: null,
    onerror: null,
    onclose: null,
    onclosed: null,
  };

  const done: any = function (err: any): void {
    __sInvoke(h.callback, [err]);
  };

  const onfinish: any = function (): void {
    h.writableFinished = true;
    if (stream.destroyed === true) h.willEmitClose = false;
    if (h.willEmitClose && (stream.readable !== true || readable)) return;
    if (!readable || h.readableFinished) __sInvoke(done, [undefined]);
  };
  h.onfinish = onfinish;

  const onlegacyfinish: any = function (): void {
    if (stream.writable !== true) __sInvoke(h.onfinish, []);
  };
  h.onlegacyfinish = onlegacyfinish;

  const onend: any = function (): void {
    h.readableFinished = true;
    if (stream.destroyed === true) h.willEmitClose = false;
    if (h.willEmitClose && (stream.writable !== true || writable)) return;
    if (!writable || h.writableFinished) __sInvoke(done, [undefined]);
  };
  h.onend = onend;

  const onerror: any = function (err: any): void {
    __sInvoke(done, [err]);
  };
  h.onerror = onerror;

  const onclose: any = function (): void {
    h.closed = true;
    const errored: any =
      __sIsWritableErrored(stream) !== null && __sIsWritableErrored(stream) !== undefined
        ? __sIsWritableErrored(stream)
        : __sIsReadableErrored(stream);
    if (errored !== null && errored !== undefined && typeof errored !== "boolean") {
      __sInvoke(done, [errored]);
      return;
    }
    if (readable && !h.readableFinished && __sIsReadableNodeStream(stream, true)) {
      if (__sIsReadableFinished(stream, false) !== true) {
        __sInvoke(done, [new ERR_STREAM_PREMATURE_CLOSE()]);
        return;
      }
    }
    if (writable && !h.writableFinished) {
      if (__sIsWritableFinished(stream, false) !== true) {
        __sInvoke(done, [new ERR_STREAM_PREMATURE_CLOSE()]);
        return;
      }
    }
    __sInvoke(done, [undefined]);
  };
  h.onclose = onclose;

  const onclosed: any = function (): void {
    h.closed = true;
    const errored: any =
      __sIsWritableErrored(stream) !== null && __sIsWritableErrored(stream) !== undefined
        ? __sIsWritableErrored(stream)
        : __sIsReadableErrored(stream);
    if (errored !== null && errored !== undefined && typeof errored !== "boolean") {
      __sInvoke(done, [errored]);
      return;
    }
    __sInvoke(done, [undefined]);
  };
  h.onclosed = onclosed;

  if (writable && !__sIsObj(wState)) {
    // A legacy stream with no writable state.
    stream.on("end", onlegacyfinish);
    stream.on("close", onlegacyfinish);
  }

  stream.on("end", onend);
  stream.on("finish", onfinish);
  if (opts.error !== false) stream.on("error", onerror);
  stream.on("close", onclose);

  if (h.closed) {
    __sTick(onclose);
  } else if (
    (__sIsObj(wState) && wState.errorEmitted === true) ||
    (__sIsObj(rState) && rState.errorEmitted === true)
  ) {
    if (!h.willEmitClose) __sTick(onclosed);
  } else if (
    !readable &&
    (!h.willEmitClose || __sIsReadable(stream) === true) &&
    (h.writableFinished || __sIsWritable(stream) === false) &&
    (!__sIsObj(wState) || wState.pendingcb === undefined || Number(wState.pendingcb) === 0)
  ) {
    __sTick(onclosed);
  } else if (
    !writable &&
    (!h.willEmitClose || __sIsWritable(stream) === true) &&
    (h.readableFinished || __sIsReadable(stream) === false)
  ) {
    __sTick(onclosed);
  }

  const cleanup: any = function (): void {
    h.callback = __sNop;
    stream.removeListener("end", h.onlegacyfinish);
    stream.removeListener("close", h.onlegacyfinish);
    stream.removeListener("finish", h.onfinish);
    stream.removeListener("end", h.onend);
    stream.removeListener("error", h.onerror);
    stream.removeListener("close", h.onclose);
  };

  if (opts.signal !== undefined && opts.signal !== null && !h.closed) {
    const signal: any = opts.signal;
    const abort: any = function (): void {
      const endCallback: any = h.callback;
      __sInvoke(cleanup, []);
      __sInvoke(endCallback, [new AbortError(undefined, { cause: signal.reason })]);
    };
    if (signal.aborted === true) {
      __sTick(abort);
    } else {
      signal.addEventListener("abort", abort);
      const previous: any = h.callback;
      h.callback = __sOnce(function (err: any): void {
        signal.removeEventListener("abort", abort);
        __sInvoke(previous, [err]);
      });
    }
  }

  return cleanup;
}

// A WHATWG stream has a closed promise; without the prelude globals this is
// only reachable for an object a test built itself.
function __sEosWeb(stream: any, options: any, callback: any): any {
  const closed: any = stream.closed;
  if (closed !== undefined && closed !== null && __sDuck(closed, "then")) {
    closed.then(
      function (): void {
        __sTick(callback);
      },
      function (err: any): void {
        __sTick1(callback, err);
      },
    );
  } else {
    __sTick(callback);
  }
  return __sNop;
}

function __sFinishedPromise(stream: any, opts?: any): any {
  let options: any = opts === null ? {} : opts;
  const autoCleanup: boolean = __sIsObj(options) && options.cleanup === true;
  if (__sIsObj(options) && options.cleanup !== undefined) {
    __sValidateBoolean(options.cleanup, "cleanup");
  }
  return new Promise(function (resolve: any, reject: any): void {
    const holder: any = { cleanup: null };
    holder.cleanup = __sEos(stream, options, function (err: any): void {
      if (autoCleanup && holder.cleanup !== null) __sInvoke(holder.cleanup, []);
      if (err !== undefined && err !== null) {
        reject(err);
      } else {
        resolve(undefined);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Readable.from (`lib/internal/streams/from.js`)
// ---------------------------------------------------------------------------

function __sReadableFrom(iterable: any, opts?: any): any {
  if (typeof iterable === "string" || __sIsView(iterable)) {
    const options: any = { objectMode: true };
    if (__sIsObj(opts)) {
      for (const key of Object.keys(opts)) options[key] = opts[key];
    }
    options.read = function (): void {
      const self: any = this;
      self.push(iterable);
      self.push(null);
    };
    return new Readable(options);
  }

  if (!__sIsIterable(iterable)) {
    throw new ERR_INVALID_ARG_TYPE("iterable", ["Iterable"], iterable);
  }
  const isAsync: boolean = __sIsIterable(iterable, true);
  const iterator: any = __sGetIterator(iterable, isAsync);

  const options: any = { objectMode: true, highWaterMark: 1 };
  if (__sIsObj(opts)) {
    for (const key of Object.keys(opts)) options[key] = opts[key];
  }

  const shared: any = { reading: false, readable: null, iterator: iterator, isAsync: isAsync };

  options.read = function (): void {
    if (shared.reading) return;
    shared.reading = true;
    __sFromPump(shared);
  };
  options.destroy = function (error: any, cb: any): void {
    const self: any = this;
    __sFromClose(shared, error).then(
      function (): void {
        __sTick1(cb, error);
      },
      function (e: any): void {
        __sTick1(cb, e === undefined || e === null ? error : e);
      },
    );
  };

  const readable: any = new Readable(options);
  shared.readable = readable;
  return readable;
}

async function __sFromClose(shared: any, error: any): Promise<void> {
  const iterator: any = shared.iterator;
  const hadError: boolean = error !== undefined && error !== null;
  const thrower: any = iterator.throw;
  if (hadError && __sIsFn(thrower)) {
    const outcome: any = await __sCall(thrower, iterator, [error]);
    if (__sIsObj(outcome)) {
      await outcome.value;
      if (outcome.done === true) return;
    }
  }
  const returner: any = iterator.return;
  if (__sIsFn(returner)) {
    const outcome: any = await __sCall(returner, iterator, []);
    if (__sIsObj(outcome)) await outcome.value;
  }
}

// Node splits this into four loops to avoid `await` where it is not needed;
// one `async` loop covers both kinds here, at the cost of a microtask per
// chunk for a purely synchronous iterable.
async function __sFromPump(shared: any): Promise<void> {
  const readable: any = shared.readable;
  const iterator: any = shared.iterator;
  let running = true;
  while (running) {
    try {
      const step: any = shared.isAsync ? await iterator.next() : iterator.next();
      if (step.done === true) {
        readable.push(null);
        return;
      }
      let value: any = step.value;
      if (__sIsObj(value) && __sDuck(value, "then")) value = await value;
      if (value === null) {
        shared.reading = false;
        throw new ERR_STREAM_NULL_VALUES();
      }
      if (readable.push(value) === true) continue;
      shared.reading = false;
    } catch (err: any) {
      readable.destroy(err);
    }
    running = false;
  }
}

// ---------------------------------------------------------------------------
// The async iterator (`createAsyncIterator` in readable.js)
// ---------------------------------------------------------------------------

function __sStreamAsyncIterator(stream: any, options: any): any {
  let source: any = stream;
  if (!__sDuck(source, "read") && !(source instanceof Readable)) {
    source = __sReadableWrap(source, { objectMode: true });
  }
  // Node hangs the stream off the iterator (`iter.stream = stream`); writing
  // an undeclared key onto an engine object poisons every later typed read of
  // it (zun#37), and nothing in the corpus reads it back, so it is left off.
  return __sCreateAsyncIterator(source, options);
}

async function* __sCreateAsyncIterator(stream: any, options: any): any {
  const h: any = { callback: __sNop, error: undefined };

  const next: any = function (resolve: any): void {
    h.callback = resolve;
  };

  const wake: any = function (): void {
    const pending: any = h.callback;
    h.callback = __sNop;
    __sInvoke(pending, []);
  };

  const onReadable: any = function (): void {
    __sInvoke(wake, []);
  };
  stream.on("readable", onReadable);

  const cleanup: any = __sEos(stream, { writable: false }, function (err: any): void {
    h.error = err !== undefined && err !== null ? __sAggregateTwoErrors(h.error, err) : null;
    __sInvoke(wake, []);
  });

  try {
    let running = true;
    while (running) {
      const chunk: any = stream.destroyed === true ? null : stream.read();
      if (chunk !== null) {
        yield chunk;
      } else if (h.error !== undefined && h.error !== null) {
        throw h.error;
      } else if (h.error === null) {
        running = false;
      } else {
        await new Promise(next);
      }
    }
  } catch (err: any) {
    h.error = __sAggregateTwoErrors(h.error, err);
    throw h.error;
  } finally {
    const destroyOnReturn: boolean = !__sIsObj(options) || options.destroyOnReturn !== false;
    const hadError: boolean = h.error !== undefined && h.error !== null;
    if (
      (hadError || destroyOnReturn) &&
      (h.error === undefined || stream._readableState.autoDestroy === true)
    ) {
      __sDestroyer(stream, null);
    } else {
      stream.off("readable", onReadable);
      __sInvoke(cleanup, []);
    }
  }
}

// ---------------------------------------------------------------------------
// pipeline (`lib/internal/streams/pipeline.js`)
// ---------------------------------------------------------------------------

function __sPipelineDestroyer(stream: any, reading: boolean, writing: boolean): any {
  const h: any = { finished: false };
  const cleanup: any = __sEos(stream, { readable: reading, writable: writing }, function (err: any): void {
    h.finished = err === undefined || err === null;
  });
  return {
    destroy: function (err: any): void {
      if (h.finished) return;
      h.finished = true;
      __sDestroyer(stream, err === undefined || err === null ? new ERR_STREAM_DESTROYED("pipe") : err);
    },
    cleanup: cleanup,
  };
}

async function* __sFromReadable(val: any): any {
  const iter: any = __sStreamAsyncIterator(val, undefined);
  for await (const chunk of iter) yield chunk;
}

function __sMakeAsyncIterable(val: any): any {
  if (__sIsIterable(val, true)) return val;
  // A *sync* iterable is walked through the async wrapper, so every consumer
  // below only ever has to spell `for await`.
  if (__sIsIterable(val)) return __sAsyncIterate(__sSyncIterate(val));
  if (__sIsReadableNodeStream(val)) return __sFromReadable(val);
  throw new ERR_INVALID_ARG_TYPE("val", ["Readable", "Iterable", "AsyncIterable"], val);
}

async function __sPumpToNode(iterable: any, writable: any, finish: any, end: boolean): Promise<void> {
  const h: any = { error: undefined, onresolve: null };

  const resume: any = function (err: any): void {
    if (err !== undefined && err !== null) h.error = err;
    if (h.onresolve !== null) {
      const callback: any = h.onresolve;
      h.onresolve = null;
      __sInvoke(callback, []);
    }
  };

  const wait: any = function (): any {
    return new Promise(function (resolve: any, reject: any): void {
      if (h.error !== undefined && h.error !== null) {
        reject(h.error);
      } else {
        h.onresolve = function (): void {
          if (h.error !== undefined && h.error !== null) {
            reject(h.error);
          } else {
            resolve(undefined);
          }
        };
      }
    });
  };

  writable.on("drain", resume);
  const cleanup: any = __sEos(writable, { readable: false }, resume);

  try {
    if (writable.writableNeedDrain === true) await __sInvoke(wait, []);
    for await (const chunk of iterable) {
      if (writable.write(chunk) === false) await __sInvoke(wait, []);
    }
    if (end) {
      writable.end();
      await __sInvoke(wait, []);
    }
    __sInvoke(finish, []);
  } catch (err: any) {
    __sInvoke(finish, [h.error !== err ? __sAggregateTwoErrors(err, h.error) : err]);
  } finally {
    __sInvoke(cleanup, []);
    writable.off("drain", resume);
  }
}

function __sPipeStreams(src: any, dst: any, finish: any, finishOnlyHandleError: any, end: boolean): any {
  const h: any = { ended: false };

  dst.on("close", function (): void {
    if (!h.ended) __sInvoke(finishOnlyHandleError, [new ERR_STREAM_PREMATURE_CLOSE()]);
  });

  src.pipe(dst, { end: false });

  if (end) {
    const endFn: any = function (): void {
      h.ended = true;
      dst.end();
    };
    if (__sIsReadableFinished(src) === true) {
      __sTick(endFn);
    } else {
      src.once("end", endFn);
    }
  } else {
    __sInvoke(finish, []);
  }

  __sEos(src, { readable: true, writable: false }, function (err: any): void {
    const rState: any = src._readableState;
    if (
      err !== undefined &&
      err !== null &&
      err.code === "ERR_STREAM_PREMATURE_CLOSE" &&
      __sIsObj(rState) &&
      rState.ended === true &&
      (rState.errored === null || rState.errored === undefined) &&
      rState.errorEmitted !== true
    ) {
      src.once("end", finish);
      src.once("error", finish);
    } else {
      __sInvoke(finish, [err]);
    }
  });

  return __sEos(dst, { readable: false, writable: true }, finish);
}

function __sPipelineImpl(streams: any[], callback: any, opts: any): any {
  let list: any[] = streams;
  if (Number(list.length) === 1 && Array.isArray(list[0])) list = list[0];
  if (Number(list.length) < 2) throw new ERR_MISSING_ARGS("streams");

  const ac: any = new AbortController();
  const signal: any = ac.signal;
  const outerSignal: any = __sIsObj(opts) ? opts.signal : undefined;
  __sValidateAbortSignal(outerSignal, "options.signal");

  const h: any = {
    error: undefined,
    value: undefined,
    destroys: [],
    lastStreamCleanup: [],
    finishCount: 0,
  };

  const finishImpl: any = function (err: any, final: boolean): void {
    if (
      err !== undefined &&
      err !== null &&
      (h.error === undefined || h.error === null || h.error.code === "ERR_STREAM_PREMATURE_CLOSE")
    ) {
      h.error = err;
    }
    if ((h.error === undefined || h.error === null) && !final) return;

    while (Number(h.destroys.length) > 0) {
      const destroy: any = h.destroys.shift();
      __sInvoke(destroy, [h.error]);
    }
    if (outerSignal !== undefined && outerSignal !== null) {
      outerSignal.removeEventListener("abort", abort);
    }
    ac.abort();

    if (final) {
      if (h.error === undefined || h.error === null) {
        for (const fn of h.lastStreamCleanup) __sInvoke(fn, []);
      }
      __sTick(callback, h.error, h.value);
    }
  };

  const finish: any = function (err: any): void {
    h.finishCount = Number(h.finishCount) - 1;
    __sInvoke(finishImpl, [err, Number(h.finishCount) === 0]);
  };

  const finishOnlyHandleError: any = function (err: any): void {
    __sInvoke(finishImpl, [err, false]);
  };

  const abort: any = function (): void {
    __sInvoke(finishImpl, [
      new AbortError(undefined, {
        cause: outerSignal === undefined || outerSignal === null ? undefined : outerSignal.reason,
      }),
      false,
    ]);
  };
  if (outerSignal !== undefined && outerSignal !== null) {
    outerSignal.addEventListener("abort", abort);
  }

  let ret: any = undefined;
  const total = Number(list.length);
  for (let i = 0; i < total; i++) {
    const stream: any = list[i];
    const reading: boolean = i < total - 1;
    const writing: boolean = i > 0;
    const next: any = i + 1 < total ? list[i + 1] : null;
    const end: boolean = reading || !__sIsObj(opts) || opts.end !== false;
    const isLastStream: boolean = i === total - 1;

    if (__sIsNodeStream(stream)) {
      if (next !== null && (next.closed === true || next.destroyed === true)) {
        throw new ERR_STREAM_UNABLE_TO_PIPE();
      }
      if (end) {
        const pair: any = __sPipelineDestroyer(stream, reading, writing);
        h.destroys.push(pair.destroy);
        if (__sIsReadable(stream) === true && isLastStream) {
          h.lastStreamCleanup.push(pair.cleanup);
        }
      }
      const onError: any = function (err: any): void {
        if (
          err !== undefined &&
          err !== null &&
          err.name !== "AbortError" &&
          err.code !== "ERR_STREAM_PREMATURE_CLOSE"
        ) {
          __sInvoke(finishOnlyHandleError, [err]);
        }
      };
      stream.on("error", onError);
      if (__sIsReadable(stream) === true && isLastStream) {
        h.lastStreamCleanup.push(function (): void {
          stream.removeListener("error", onError);
        });
      }
    }

    if (i === 0) {
      if (__sIsFn(stream)) {
        ret = __sInvoke(stream, [{ signal: signal }]);
        if (!__sIsIterable(ret)) {
          throw new ERR_INVALID_RETURN_VALUE("Iterable, AsyncIterable or Stream", "source", ret);
        }
      } else if (
        __sIsIterable(stream) ||
        __sIsReadableNodeStream(stream) ||
        __sIsTransformStream(stream)
      ) {
        ret = stream;
      } else {
        ret = __sDuplexFrom(stream);
      }
    } else if (__sIsFn(stream)) {
      const source: any = __sIsTransformStream(ret)
        ? __sMakeAsyncIterable(ret.readable)
        : __sMakeAsyncIterable(ret);
      ret = __sInvoke(stream, [source, { signal: signal }]);

      if (reading) {
        if (!__sIsIterable(ret, true)) {
          throw new ERR_INVALID_RETURN_VALUE("AsyncIterable", "transform[" + String(i - 1) + "]", ret);
        }
      } else {
        const pt: any = new PassThrough({ objectMode: true });
        const then: any = ret === null || ret === undefined ? undefined : ret.then;
        if (__sIsFn(then)) {
          h.finishCount = Number(h.finishCount) + 1;
          __sCall(then, ret, [
            function (val: any): void {
              h.value = val;
              if (val !== undefined && val !== null) pt.write(val);
              if (end) pt.end();
              __sTick(finish);
            },
            function (err: any): void {
              pt.destroy(err);
              __sTick1(finish, err);
            },
          ]);
        } else if (__sIsIterable(ret, true)) {
          h.finishCount = Number(h.finishCount) + 1;
          __sPumpToNode(ret, pt, finish, end);
        } else {
          throw new ERR_INVALID_RETURN_VALUE("AsyncIterable or Promise", "destination", ret);
        }
        ret = pt;
        const pair: any = __sPipelineDestroyer(ret, false, true);
        h.destroys.push(pair.destroy);
        if (isLastStream) h.lastStreamCleanup.push(pair.cleanup);
      }
    } else if (__sIsNodeStream(stream)) {
      if (__sIsReadableNodeStream(ret)) {
        h.finishCount = Number(h.finishCount) + 2;
        const cleanup: any = __sPipeStreams(ret, stream, finish, finishOnlyHandleError, end);
        if (__sIsReadable(stream) === true && isLastStream) {
          h.lastStreamCleanup.push(cleanup);
        }
      } else if (__sIsIterable(ret)) {
        h.finishCount = Number(h.finishCount) + 1;
        __sPumpToNode(ret, stream, finish, end);
      } else {
        throw new ERR_INVALID_ARG_TYPE(
          "val",
          ["Readable", "Iterable", "AsyncIterable", "ReadableStream", "TransformStream"],
          ret,
        );
      }
      ret = stream;
    } else {
      ret = __sDuplexFrom(stream);
    }
  }

  if (signal.aborted === true || (__sIsObj(outerSignal) && outerSignal.aborted === true)) {
    __sTick(abort);
  }

  return ret;
}

function __sPipeline(...streams: any[]): any {
  const list: any[] = [];
  const count = Number(streams.length);
  for (let i = 0; i < count; i++) list.push(streams[i]);
  const last: any = list[Number(list.length) - 1];
  __sValidateFunction(last, "streams[stream.length - 1]");
  list.pop();
  return __sPipelineImpl(list, __sOnce(last), undefined);
}

function __sPipelinePromise(...streams: any[]): any {
  const list: any[] = [];
  const count = Number(streams.length);
  for (let i = 0; i < count; i++) list.push(streams[i]);
  return new Promise(function (resolve: any, reject: any): void {
    let signal: any = undefined;
    let end: any = undefined;
    const lastArg: any = list[Number(list.length) - 1];
    if (
      __sIsObj(lastArg) &&
      !__sIsNodeStream(lastArg) &&
      !__sIsIterable(lastArg) &&
      !__sIsWebStream(lastArg)
    ) {
      const options: any = list.pop();
      signal = options.signal;
      end = options.end;
    }
    __sPipelineImpl(
      list,
      function (err: any, value: any): void {
        if (err !== undefined && err !== null) {
          reject(err);
        } else {
          resolve(value);
        }
      },
      { signal: signal, end: end },
    );
  });
}

// ---------------------------------------------------------------------------
// Duplex.from / duplexify (`lib/internal/streams/duplexify.js`), reduced to the
// shapes the corpus builds: a Duplex, a { readable, writable } pair, a
// Readable, a Writable, an async generator function, an iterable and a promise.
// ---------------------------------------------------------------------------

function __sDuplexFrom(body: any): any {
  if (__sIsDuplexNodeStream(body)) return body;
  if (__sIsReadableNodeStream(body)) return __sDuplexifyReadable(body);
  if (__sIsWritableNodeStream(body)) return __sDuplexifyWritable(body);
  if (__sIsFn(body)) return __sDuplexifyFunction(body);
  if (__sIsObj(body)) {
    const readableSide: any = body.readable;
    const writableSide: any = body.writable;
    if (readableSide !== undefined && writableSide !== undefined) {
      return __sDuplexifyPair(readableSide, writableSide);
    }
    if (__sDuck(body, "then")) {
      return __sDuplexifyPromise(body);
    }
    if (__sIsIterable(body)) {
      return __sReadableFromAsDuplex(body);
    }
  }
  if (typeof body === "string" || __sIsView(body) || __sIsIterable(body)) {
    return __sReadableFromAsDuplex(body);
  }
  throw new ERR_INVALID_ARG_TYPE(
    "body",
    ["Blob", "ReadableStream", "WritableStream", "Stream", "Iterable", "AsyncIterable", "Function", "{ readable, writable } pair", "Promise"],
    body,
  );
}

function __sReadableFromAsDuplex(body: any): any {
  const readable: any = __sReadableFrom(body);
  return __sDuplexifyReadable(readable);
}

function __sDuplexifyReadable(readable: any): any {
  const d: any = new Duplex({
    objectMode: true,
    writable: false,
    readable: true,
    read: function (): void {
      const self: any = this;
      __sDuplexPumpRead(self, readable);
    },
    destroy: function (err: any, cb: any): void {
      __sDestroyer(readable, err);
      __sInvoke(cb, [err]);
    },
  });
  return d;
}

function __sDuplexPumpRead(target: any, source: any): void {
  const holder: any = target.__sDuplexPumping;
  if (holder === true) return;
  target.__sDuplexPumping = true;
  source.on("data", function (chunk: any): void {
    if (target.push(chunk) === false) source.pause();
  });
  source.on("end", function (): void {
    target.push(null);
  });
  source.on("error", function (err: any): void {
    __sErrorOrDestroy(target, err);
  });
  target.on("resume", function (): void {
    source.resume();
  });
  source.resume();
}

function __sDuplexifyWritable(writable: any): any {
  return new Duplex({
    objectMode: true,
    readable: false,
    writable: true,
    write: function (chunk: any, encoding: any, cb: any): void {
      if (writable.write(chunk, encoding) === false) {
        writable.once("drain", function (): void {
          __sInvoke(cb, []);
        });
      } else {
        __sInvoke(cb, []);
      }
    },
    final: function (cb: any): void {
      writable.end();
      __sInvoke(cb, []);
    },
    destroy: function (err: any, cb: any): void {
      __sDestroyer(writable, err);
      __sInvoke(cb, [err]);
    },
  });
}

function __sDuplexifyPair(readableSide: any, writableSide: any): any {
  const rd: any = __sIsReadableNodeStream(readableSide)
    ? readableSide
    : __sReadableFrom(readableSide);
  const wr: any = writableSide;
  const d: any = new Duplex({
    objectMode: true,
    write: function (chunk: any, encoding: any, cb: any): void {
      if (wr.write(chunk, encoding) === false) {
        wr.once("drain", function (): void {
          __sInvoke(cb, []);
        });
      } else {
        __sInvoke(cb, []);
      }
    },
    final: function (cb: any): void {
      wr.end();
      __sInvoke(cb, []);
    },
    read: function (): void {
      const self: any = this;
      __sDuplexPumpRead(self, rd);
    },
    destroy: function (err: any, cb: any): void {
      __sDestroyer(wr, err);
      __sDestroyer(rd, err);
      __sInvoke(cb, [err]);
    },
  });
  return d;
}

function __sDuplexifyPromise(promise: any): any {
  const d: any = new Duplex({
    objectMode: true,
    readable: true,
    writable: false,
    read: function (): void {
      const self: any = this;
      if (self.__sDuplexPumping === true) return;
      self.__sDuplexPumping = true;
      promise.then(
        function (value: any): void {
          if (value !== undefined && value !== null) self.push(value);
          self.push(null);
        },
        function (err: any): void {
          __sErrorOrDestroy(self, err);
        },
      );
    },
  });
  return d;
}

// `Duplex.from(asyncGeneratorFunction)`: the function is called with the
// duplex's own written data as its source.
function __sDuplexifyFunction(fn: any): any {
  const d: any = new Duplex({
    objectMode: true,
    read: function (): void {
      const self: any = this;
      if (self.__sDuplexPumping === true) return;
      self.__sDuplexPumping = true;
      const produced: any = __sInvoke(fn, [__sStreamAsyncIterator(self, undefined)]);
      if (__sIsIterable(produced)) {
        const inner: any = __sReadableFrom(produced);
        __sDuplexPumpReadInto(self, inner);
      } else if (__sIsObj(produced) && __sDuck(produced, "then")) {
        produced.then(
          function (value: any): void {
            if (value !== undefined && value !== null) self.push(value);
            self.push(null);
          },
          function (err: any): void {
            __sErrorOrDestroy(self, err);
          },
        );
      }
    },
    write: function (chunk: any, encoding: any, cb: any): void {
      __sInvoke(cb, []);
    },
  });
  return d;
}

function __sDuplexPumpReadInto(target: any, source: any): void {
  source.on("data", function (chunk: any): void {
    target.push(chunk);
  });
  source.on("end", function (): void {
    target.push(null);
  });
  source.on("error", function (err: any): void {
    __sErrorOrDestroy(target, err);
  });
}

// `duplexPair()` — two Duplexes whose writable side feeds the other's readable
// side (`lib/internal/streams/duplexpair.js`).
function __sDuplexPair(options?: any): any[] {
  const link: any = { a: null, b: null };
  const make: any = function (name: string): any {
    const opts: any = {};
    if (__sIsObj(options)) {
      for (const key of Object.keys(options)) opts[key] = options[key];
    }
    opts.read = function (): void {};
    opts.write = function (chunk: any, encoding: any, cb: any): void {
      const other: any = name === "a" ? link.b : link.a;
      other.push(chunk);
      __sInvoke(cb, []);
    };
    opts.final = function (cb: any): void {
      const other: any = name === "a" ? link.b : link.a;
      other.push(null);
      __sInvoke(cb, []);
    };
    return new Duplex(opts);
  };
  link.a = __sInvoke(make, ["a"]);
  link.b = __sInvoke(make, ["b"]);
  return [link.a, link.b];
}

// ---------------------------------------------------------------------------
// compose (`lib/internal/streams/compose.js`), reduced to the Node-stream and
// function cases the corpus exercises.
// ---------------------------------------------------------------------------

function __sStaticCompose(...streams: any[]): any {
  const list: any[] = [];
  const count = Number(streams.length);
  for (let i = 0; i < count; i++) list.push(streams[i]);
  if (Number(list.length) === 0) throw new ERR_MISSING_ARGS("streams");
  if (Number(list.length) === 1) return __sDuplexFrom(list[0]);

  const orgStreams: any[] = [];
  for (const entry of list) orgStreams.push(entry);

  const first: any = __sDuplexFrom(list[0]);
  const last: any = __sDuplexFrom(list[Number(list.length) - 1]);

  const d: any = new Duplex({
    objectMode: true,
    writableObjectMode: true,
    readableObjectMode: true,
    write: function (chunk: any, encoding: any, cb: any): void {
      if (first.write(chunk, encoding) === false) {
        first.once("drain", function (): void {
          __sInvoke(cb, []);
        });
      } else {
        __sInvoke(cb, []);
      }
    },
    final: function (cb: any): void {
      first.end();
      __sInvoke(cb, []);
    },
    read: function (): void {
      const self: any = this;
      if (self.__sDuplexPumping === true) return;
      self.__sDuplexPumping = true;
      __sDuplexPumpReadInto(self, last);
      last.resume();
    },
    destroy: function (err: any, cb: any): void {
      for (const entry of orgStreams) __sDestroyer(entry, err);
      __sInvoke(cb, [err]);
    },
  });

  // Wire the stages together. Node composes them with `pipelineImpl` and
  // forwards the first error to the composed duplex.
  __sPipelineImpl(
    list,
    function (err: any): void {
      if (err !== undefined && err !== null) __sErrorOrDestroy(d, err);
    },
    undefined,
  );

  return d;
}

function __sComposeMethod(stream: any, other: any, options?: any): any {
  if (options !== undefined && options !== null) __sValidateObject(options, "options");
  if (__sIsObj(options) && options.signal !== undefined && options.signal !== null) {
    __sValidateAbortSignal(options.signal, "options.signal");
  }
  if (__sIsNodeStream(other) && __sIsWritable(other) !== true) {
    throw new ERR_INVALID_ARG_VALUE("stream", other, "must be writable");
  }
  const composed: any = __sStaticCompose(stream, other);
  if (__sIsObj(options) && options.signal !== undefined && options.signal !== null) {
    __sAddAbortSignalNoValidate(options.signal, composed);
  }
  return composed;
}

// ---------------------------------------------------------------------------
// The async operators (`lib/internal/streams/operators.js`)
//
// Node runs `map` with a configurable concurrency and a queue of pending
// promises. The queue is kept, but the pump and the consumer are one loop here:
// without `AbortSignal.any` and with no way to express Node`s resume/next
// handshake cheaply, a single ordered loop is both correct and simpler. The
// observable difference is that `concurrency > 1` does not actually overlap
// calls, which only changes throughput — the yielded order is the same, because
// Node yields in queue order too.
// ---------------------------------------------------------------------------

function __sOpSignalOf(options: any): any {
  return __sIsObj(options) ? options.signal : undefined;
}

function __sOpAborted(options: any): boolean {
  const signal: any = __sOpSignalOf(options);
  return __sIsObj(signal) && signal.aborted === true;
}

function __sOpValidate(fn: any, options: any): void {
  __sValidateFunction(fn, "fn");
  if (options !== undefined && options !== null) __sValidateObject(options, "options");
  const signal: any = __sOpSignalOf(options);
  if (signal !== undefined && signal !== null) __sValidateAbortSignal(signal, "options.signal");
}

async function* __sOpMap(stream: any, fn: any, options?: any): any {
  __sOpValidate(fn, options);
  let concurrency = 1;
  if (__sIsObj(options) && options.concurrency !== undefined && options.concurrency !== null) {
    concurrency = Math.floor(Number(options.concurrency));
  }
  let highWaterMark = concurrency - 1;
  if (__sIsObj(options) && options.highWaterMark !== undefined && options.highWaterMark !== null) {
    highWaterMark = Math.floor(Number(options.highWaterMark));
  }
  __sValidateInteger(concurrency, "options.concurrency", 1);
  __sValidateInteger(highWaterMark, "options.highWaterMark", 0);

  const signalOpt: any = { signal: __sOpSignalOf(options) };
  for await (const value of __sStreamAsyncIterator(stream, undefined)) {
    if (__sOpAborted(options)) throw new AbortError();
    const mapped: any = await __sInvoke(fn, [value, signalOpt]);
    if (mapped === __S_EMPTY) continue;
    yield mapped;
  }
}

async function* __sOpFilter(stream: any, fn: any, options?: any): any {
  __sOpValidate(fn, options);
  const signalOpt: any = { signal: __sOpSignalOf(options) };
  for await (const value of __sStreamAsyncIterator(stream, undefined)) {
    if (__sOpAborted(options)) throw new AbortError();
    const keep: any = await __sInvoke(fn, [value, signalOpt]);
    if (keep) yield value;
  }
}

async function* __sOpFlatMap(stream: any, fn: any, options?: any): any {
  for await (const value of __sOpMap(stream, fn, options)) {
    if (typeof value === "string" || __sIsIterable(value)) {
      for await (const inner of __sIterate(value)) yield inner;
    } else {
      yield value;
    }
  }
}

async function* __sIterate(value: any): any {
  if (__sIsIterable(value, true)) {
    for await (const item of value) yield item;
    return;
  }
  for (const item of value) yield item;
}

async function* __sOpDrop(stream: any, number: any, options?: any): any {
  if (options !== undefined && options !== null) __sValidateObject(options, "options");
  const signal: any = __sOpSignalOf(options);
  if (signal !== undefined && signal !== null) __sValidateAbortSignal(signal, "options.signal");
  let remaining = __sToIntegerOrInfinity(number);
  if (__sOpAborted(options)) throw new AbortError();
  for await (const value of __sStreamAsyncIterator(stream, undefined)) {
    if (__sOpAborted(options)) throw new AbortError();
    if (remaining <= 0) {
      yield value;
    } else {
      remaining = remaining - 1;
    }
  }
}

async function* __sOpTake(stream: any, number: any, options?: any): any {
  if (options !== undefined && options !== null) __sValidateObject(options, "options");
  const signal: any = __sOpSignalOf(options);
  if (signal !== undefined && signal !== null) __sValidateAbortSignal(signal, "options.signal");
  let remaining = __sToIntegerOrInfinity(number);
  if (__sOpAborted(options)) throw new AbortError();
  if (remaining <= 0) return;
  for await (const value of __sStreamAsyncIterator(stream, undefined)) {
    if (__sOpAborted(options)) throw new AbortError();
    remaining = remaining - 1;
    yield value;
    if (remaining <= 0) return;
  }
}

async function __sOpForEach(stream: any, fn: any, options?: any): Promise<any> {
  __sOpValidate(fn, options);
  const signalOpt: any = { signal: __sOpSignalOf(options) };
  for await (const value of __sStreamAsyncIterator(stream, undefined)) {
    if (__sOpAborted(options)) throw new AbortError();
    await __sInvoke(fn, [value, signalOpt]);
  }
  return undefined;
}

async function __sOpToArray(stream: any, options?: any): Promise<any[]> {
  if (options !== undefined && options !== null) __sValidateObject(options, "options");
  const signal: any = __sOpSignalOf(options);
  if (signal !== undefined && signal !== null) __sValidateAbortSignal(signal, "options.signal");
  const result: any[] = [];
  for await (const value of __sStreamAsyncIterator(stream, undefined)) {
    if (__sOpAborted(options)) {
      throw new AbortError(undefined, { cause: __sIsObj(signal) ? signal.reason : undefined });
    }
    result.push(value);
  }
  return result;
}

async function __sOpSome(stream: any, fn: any, options?: any): Promise<boolean> {
  for await (const unused of __sOpFilter(stream, fn, options)) {
    return true;
  }
  return false;
}

async function __sOpFind(stream: any, fn: any, options?: any): Promise<any> {
  for await (const value of __sOpFilter(stream, fn, options)) {
    return value;
  }
  return undefined;
}

async function __sOpEvery(stream: any, fn: any, options?: any): Promise<boolean> {
  __sValidateFunction(fn, "fn");
  // De Morgan, as in Node: every(fn) is !some(!fn).
  const negated: any = async function (value: any, opts: any): Promise<boolean> {
    const outcome: any = await __sInvoke(fn, [value, opts]);
    return outcome ? false : true;
  };
  const found: boolean = await __sOpSome(stream, negated, options);
  return found ? false : true;
}

async function __sOpReduce(stream: any, reducer: any, initialValue: any, options: any, hasInitialValue: boolean): Promise<any> {
  __sValidateFunction(reducer, "reducer");
  if (options !== undefined && options !== null) __sValidateObject(options, "options");
  const outerSignal: any = __sOpSignalOf(options);
  if (outerSignal !== undefined && outerSignal !== null) {
    __sValidateAbortSignal(outerSignal, "options.signal");
  }

  let has: boolean = hasInitialValue;
  let accumulator: any = initialValue;

  if (__sIsObj(outerSignal) && outerSignal.aborted === true) {
    const err: any = new AbortError(undefined, { cause: outerSignal.reason });
    stream.once("error", __sNop);
    await __sFinishedPromise(stream.destroy(err));
    throw err;
  }

  const ac: any = new AbortController();
  const signal: any = ac.signal;
  if (__sIsObj(outerSignal)) {
    outerSignal.addEventListener("abort", function (): void {
      ac.abort();
    });
  }

  let gotAnyItem = false;
  try {
    for await (const value of __sStreamAsyncIterator(stream, undefined)) {
      gotAnyItem = true;
      if (__sIsObj(outerSignal) && outerSignal.aborted === true) throw new AbortError();
      if (!has) {
        accumulator = value;
        has = true;
      } else {
        accumulator = await __sInvoke(reducer, [accumulator, value, { signal: signal }]);
      }
    }
    if (!gotAnyItem && !has) throw new ERR_STREAM_REDUCE_MISSING_ARGS();
  } finally {
    ac.abort();
  }
  return accumulator;
}

// ---------------------------------------------------------------------------
// The web-stream adapters
//
// `Readable.toWeb`/`fromWeb`, `Writable.toWeb`/`fromWeb` and
// `Duplex.toWeb`/`fromWeb` need `ReadableStream`/`WritableStream`/
// `TransformStream`, and this engine has no such prelude global (checked
// against crates/zun_prelude/builtin). They throw rather than half-working, so
// a test that needs them reports a missing capability instead of a wrong
// answer — the same choice `tools/harness/common.ts` makes for `vm`.
// ---------------------------------------------------------------------------

function __sNoWebStreams(name: string): any {
  throw new ERR_METHOD_NOT_IMPLEMENTED(name + " (no WHATWG stream globals in this runtime)");
}

function __sReadableFromWeb(readableStream: any, options?: any): any {
  return __sNoWebStreams("Readable.fromWeb()");
}

function __sReadableToWeb(streamReadable: any, options?: any): any {
  return __sNoWebStreams("Readable.toWeb()");
}

function __sWritableFromWeb(writableStream: any, options?: any): any {
  return __sNoWebStreams("Writable.fromWeb()");
}

function __sWritableToWeb(streamWritable: any): any {
  return __sNoWebStreams("Writable.toWeb()");
}

function __sDuplexFromWeb(pair: any, options?: any): any {
  return __sNoWebStreams("Duplex.fromWeb()");
}

function __sDuplexToWeb(duplex: any): any {
  return __sNoWebStreams("Duplex.toWeb()");
}

// ---------------------------------------------------------------------------
// The module objects
//
// `Stream`, `Readable`, `Writable`, `Duplex`, `Transform` and `PassThrough` are
// the bundler's canonical bindings for this module, the way `EventEmitter` is
// `events`' and `Buffer` is `buffer`'s: `new <identifier>()` only compiles when
// the identifier is a statically known class, so a test that spells
// `const { Readable } = require('stream')` must keep the name bound to the
// class itself (see tools/bundle_node_test.sh).
// ---------------------------------------------------------------------------

const __node_stream_promises: any = {
  pipeline(...streams: any[]): any {
    return __sPipelinePromise(...streams);
  },
  finished(stream: any, opts?: any): any {
    return __sFinishedPromise(stream, opts);
  },
};

// `stream/web`: the WHATWG classes Node re-exports from `node:stream/web`. The
// engine has none of them, so the module object exists (a test may require it)
// with every member absent, which is the honest report.
const __node_stream_web: any = {
  ReadableStream: undefined,
  ReadableStreamDefaultReader: undefined,
  ReadableStreamBYOBReader: undefined,
  ReadableStreamDefaultController: undefined,
  ReadableByteStreamController: undefined,
  ReadableStreamBYOBRequest: undefined,
  WritableStream: undefined,
  WritableStreamDefaultWriter: undefined,
  WritableStreamDefaultController: undefined,
  TransformStream: undefined,
  TransformStreamDefaultController: undefined,
  ByteLengthQueuingStrategy: undefined,
  CountQueuingStrategy: undefined,
  TextEncoderStream: undefined,
  TextDecoderStream: undefined,
  CompressionStream: undefined,
  DecompressionStream: undefined,
};

// `stream/consumers`: the little promise helpers over a readable.
const __node_stream_consumers: any = {
  async arrayBuffer(stream: any): Promise<any> {
    return __sNoWebStreams("stream/consumers.arrayBuffer()");
  },
  async blob(stream: any): Promise<any> {
    return __sNoWebStreams("stream/consumers.blob()");
  },
  async buffer(stream: any): Promise<any> {
    const chunks: any[] = await __sOpToArray(stream, undefined);
    return __sJoinChunks(chunks);
  },
  async text(stream: any): Promise<any> {
    const chunks: any[] = await __sOpToArray(stream, undefined);
    let out = "";
    for (const chunk of chunks) out = out + __sChunkToString(chunk, "utf8");
    return out;
  },
  async json(stream: any): Promise<any> {
    const chunks: any[] = await __sOpToArray(stream, undefined);
    let out = "";
    for (const chunk of chunks) out = out + __sChunkToString(chunk, "utf8");
    return JSON.parse(out);
  },
};

// `internal/streams/add-abort-signal`, which `test-stream-add-abort-signal.js`
// requires directly — the same relationship `internal/util` has with `util`.
const __node_internal_streams_add_abort_signal: any = {
  addAbortSignal(signal: any, stream: any): any {
    return __sAddAbortSignal(signal, stream);
  },
  addAbortSignalNoValidate(signal: any, stream: any): any {
    return __sAddAbortSignalNoValidate(signal, stream);
  },
};

const __node_stream: any = {
  Stream: Stream,
  Readable: Readable,
  Writable: Writable,
  Duplex: Duplex,
  Transform: Transform,
  PassThrough: PassThrough,

  pipeline(...streams: any[]): any {
    return __sPipeline(...streams);
  },
  finished(stream: any, options?: any, callback?: any): any {
    return __sEos(stream, options, callback);
  },
  addAbortSignal(signal: any, stream: any): any {
    return __sAddAbortSignal(signal, stream);
  },
  destroy(stream: any, err?: any): void {
    __sDestroyer(stream, err);
  },
  compose(...streams: any[]): any {
    return __sStaticCompose(...streams);
  },
  duplexPair(options?: any): any[] {
    return __sDuplexPair(options);
  },
  isDestroyed(stream: any): any {
    return __sIsDestroyed(stream);
  },
  isDisturbed(stream: any): any {
    return __sIsDisturbed(stream);
  },
  isErrored(stream: any): any {
    return __sIsErrored(stream);
  },
  isReadable(stream: any): any {
    return __sIsReadable(stream);
  },
  isWritable(stream: any): any {
    return __sIsWritable(stream);
  },
  getDefaultHighWaterMark(objectMode?: any): number {
    return __sGetDefaultHighWaterMark(objectMode);
  },
  setDefaultHighWaterMark(objectMode: any, value: any): void {
    __sSetDefaultHighWaterMark(objectMode, value);
  },
  promises: __node_stream_promises,
  // `Stream._isArrayBufferView` / `_isUint8Array` / `_uint8ArrayToBuffer`:
  // Node exposes these three off the module object and `readable.js` uses them
  // to normalise a pushed view. There is nothing to normalise here — a view is
  // kept as it arrives (see the Buffer note in the header) — so the converter
  // is the identity. `Stream.Stream` is the `Stream` entry above, which is how
  // Node keeps its node-0.4 alias.
  _isArrayBufferView(value: any): boolean {
    return __sIsView(value);
  },
  _isUint8Array(value: any): boolean {
    return __sIsView(value);
  },
  _uint8ArrayToBuffer(chunk: any): any {
    return chunk;
  },
};

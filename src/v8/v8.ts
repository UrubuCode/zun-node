// node:v8 — V8's value-serialization wire format, the heap statistics surface
// and the profiler / snapshot shells, in Zun TypeScript.
//
// Behavior is defined by Node.js 25. Two upstream sources are followed:
//
//   * Node's `lib/v8.js` (MIT, Copyright Joyent, Inc. and other Node
//     contributors, and StrongLoop Inc.) for the *module*: the
//     `DefaultSerializer`/`DefaultDeserializer` pair that treats every
//     `ArrayBufferView` as a host object, the view-type index table, the
//     `getHeapStatistics` key set, `GCProfiler`, `startCpuProfile` and the
//     `startupSnapshot` namespace.
//   * V8's `src/objects/value-serializer.cc` for the *bytes*: the version-15
//     header, the one-byte tag alphabet, zigzag varints, the two-byte-string
//     padding rule, the dense/sparse array split and the object-reference
//     numbering. The wire format is the contract — a buffer this file writes
//     is byte-identical to the one Node writes for the same value, and the
//     round-trip tests in ../../test/v8/ compare hex against output captured
//     from `node -e "v8.serialize(...)"`.
//
// ---------------------------------------------------------------------------
// What is honest here, and what the engine will not let this module see
// ---------------------------------------------------------------------------
//
// `node:v8` is a window onto a *V8 isolate*. Zun is not V8: there is no
// generational heap with named spaces, no sampling profiler, no GC event
// stream and no heap graph. Every such reading below is therefore either
// 0 or the closest number the host surface actually reports, never an
// invention; the resolution table is:
//
//   | value                                 | what this module answers        |
//   | ------------------------------------- | ------------------------------- |
//   | `getHeapStatistics().used_heap_size`  | `process.memoryUsage().heapUsed`|
//   | `getHeapStatistics().total_heap_size` | `process.memoryUsage().heapTotal`|
//   | `getHeapStatistics().external_memory` | `process.memoryUsage().external`|
//   | every other `getHeapStatistics` key   | `0`                             |
//   | `getHeapCodeStatistics()`             | four zeros                      |
//   | `getHeapSpaceStatistics()`            | V8's thirteen space *names*,    |
//   |                                       | every size `0`                  |
//   | `getCppHeapStatistics()`              | the shape, with zero totals     |
//   | `cachedDataVersionTag()`              | a hash of the engine version    |
//   |                                       | and the flags set so far        |
//   | `setFlagsFromString(s)`               | validated, remembered, no-op    |
//   | `startCpuProfile().stop()`            | a well-formed `.cpuprofile`     |
//   |                                       | with one `(root)` node and no   |
//   |                                       | samples                         |
//   | `GCProfiler.stop()`                   | a profile with no statistics    |
//   | `getHeapSnapshot()`                   | a well-formed, empty heap graph |
//   | `takeCoverage()` / `stopCoverage()`   | accepted, no-op                 |
//
// Those are all *shape-true and content-empty*: the keys, types and formats
// are Node's, and the numbers are what this runtime can observe. The three
// rows that come from `process.memoryUsage()` are the honest *route* rather
// than a non-zero answer — `heapTotal`, `heapUsed` and `external` are
// themselves zero and documented in `src/process/process.ts`, because the
// host surface exposes no heap figures either — and they are wired up so that
// `getHeapStatistics()` starts reporting the moment that changes.
//
// Three entry points cannot be answered that way at all, because an empty
// answer would be a *false* one rather than an empty one, so each throws with
// its reason named: `queryObjects` (a count of live instances cannot be 0
// while instances exist), `writeHeapSnapshot` (it needs both a heap graph and
// `fs`) and `promiseHooks` (a hook that never fires is worse than no hook).
// `setHeapSnapshotNearHeapLimit` is pure bookkeeping, so it validates and
// remembers instead.
//
// ---------------------------------------------------------------------------
// The one real gap in the serializer, and why it is the engine's
// ---------------------------------------------------------------------------
//
// `serialize()` must know *which* `ArrayBufferView` it was handed: the wire
// format carries a view-type index, and the bytes come from the view's own
// `buffer`/`byteOffset`/`byteLength`. In this engine a view reached through an
// `any` parameter — which is what `serialize(value)` is — exposes none of
// that. Measured (see ../../test/v8/README.md for the standalone repro):
//
//     const v: any = new Int16Array([1, 2]);
//     v.constructor              // undefined
//     v.BYTES_PER_ELEMENT        // undefined
//     v.byteLength               // undefined
//     v.length                   // undefined
//     v[0]                       // undefined
//     Object.getPrototypeOf(v)   // null
//     v instanceof Int16Array    // false
//     Object.prototype.toString.call(v)   // "[object Object]"
//     ArrayBuffer.isView(v)      // true    <- the only signal
//     Buffer.isBuffer(v)         // false   <- true only for the U8 family
//     Object.values(v)           // [1, 2]  <- the elements, but not their width
//
// So exactly two facts are observable: *that* it is a view, and whether it is
// a `Uint8Array`/`Buffer` (one runtime type in this engine). Re-typing an
// `any` to the concrete view class works when it matches
// (`function f(v: any): Int16Array { return v; }`) and is an uncatchable
// runtime error when it does not, so the kind cannot be probed either.
//
// Consequently: a `Buffer`/`Uint8Array` serializes exactly as Node does it
// (view-type index 10, `FastBuffer`), and every other view raises a data clone
// error naming this gap rather than guessing a width. The *deserializer* has
// no such limit — it constructs the views itself — so a buffer written by Node
// deserializes into the right `Int16Array`/`Float64Array`/`DataView`/… here.
// `ArrayBuffer` is the same story one step further: an `ArrayBuffer` through
// `any` is indistinguishable from `{}` (no `byteLength`, not a view), so it is
// read back correctly and rejected on write.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * **The serializer's state is a plain object, not class fields.** A
//     function assigned onto a *class instance* — `ser._writeHostObject = fn`,
//     which is how Node's own `test-v8-serdes.js` installs the host-object
//     hooks — reads back `undefined` here, whether the field is declared
//     `any` or left as an expando, while the same assignment onto an object
//     literal works (zun#19/#37, repro in ../../test/v8/README.md). So
//     `Serializer` and `Deserializer` are classes (Node's tests spell
//     `new v8.DefaultSerializer()`, and `new` only reaches a statically known
//     class — zun#18/#25) whose every method delegates to a top-level
//     `__v8*` function over one plain-object state in `this.s`, and the two
//     hooks are dispatched as **method calls** (`owner._writeHostObject(v)`),
//     which does find a subclass override. Installing a hook by assignment
//     is the one spelling that cannot work; subclassing is the one that does.
//   * `Number(x.length)` throughout: `.length` is typed `u64`/`i32` at the
//     type level, so it is neither assignable nor passable as a `number`
//     (zun#3).
//   * `__v8Cc(s, i)` rather than `s.charCodeAt(i)`: a `charCodeAt` past the
//     end throws instead of answering `NaN` (zun#2).
//   * `__v8AsBuffer(value)` re-types an `any` known to hold a `Uint8Array`
//     before reading its bytes: without the declared type `value.length`
//     answers `undefined` and `value[i]` is opaque (zun#38).
//   * The module's functions are **object-literal methods** delegating to
//     top-level `__v8*` functions, because a bare function value does not
//     survive every path through `any` (zun#17) while a method does.
//   * `Float16Array`, `BigInt64Array` and `BigUint64Array` are not
//     constructible with their element values in this engine
//     (`Float16Array` is not defined at all; `new BigInt64Array([42n])`
//     answers `0` for element 0), so the deserializer rejects those three
//     view-type indices with the reason named instead of returning a view
//     full of zeros.

// ===========================================================================
// Byte-level primitives
// ===========================================================================

// The wire format version this module writes. V8 has written 15 since
// mid-2021 and Node 25 still does — `test-v8-serdes.js` asserts the exact
// header bytes `ff 0f` and calls a change to them semver-major.
const __V8_FORMAT_VERSION: number = 15;

// V8 `SerializationTag`, one byte each (src/objects/value-serializer.cc). The
// values are ASCII characters in V8's source; they are spelled here as the
// numbers that go on the wire so that nothing has to be re-derived.
const __V8_TAG_PADDING: number = 0x00; // '\0'
const __V8_TAG_VERIFY_OBJECT_COUNT: number = 0x3f; // '?'
const __V8_TAG_THE_HOLE: number = 0x2d; // '-'
const __V8_TAG_UNDEFINED: number = 0x5f; // '_'
const __V8_TAG_NULL: number = 0x30; // '0'
const __V8_TAG_TRUE: number = 0x54; // 'T'
const __V8_TAG_FALSE: number = 0x46; // 'F'
const __V8_TAG_INT32: number = 0x49; // 'I'
const __V8_TAG_UINT32: number = 0x55; // 'U'
const __V8_TAG_DOUBLE: number = 0x4e; // 'N'
const __V8_TAG_BIGINT: number = 0x5a; // 'Z'
const __V8_TAG_UTF8_STRING: number = 0x53; // 'S'
const __V8_TAG_ONE_BYTE_STRING: number = 0x22; // '"'
const __V8_TAG_TWO_BYTE_STRING: number = 0x63; // 'c'
const __V8_TAG_OBJECT_REFERENCE: number = 0x5e; // '^'
const __V8_TAG_BEGIN_JS_OBJECT: number = 0x6f; // 'o'
const __V8_TAG_END_JS_OBJECT: number = 0x7b; // '{'
const __V8_TAG_BEGIN_SPARSE_JS_ARRAY: number = 0x61; // 'a'
const __V8_TAG_END_SPARSE_JS_ARRAY: number = 0x40; // '@'
const __V8_TAG_BEGIN_DENSE_JS_ARRAY: number = 0x41; // 'A'
const __V8_TAG_END_DENSE_JS_ARRAY: number = 0x24; // '$'
const __V8_TAG_DATE: number = 0x44; // 'D'
const __V8_TAG_TRUE_OBJECT: number = 0x79; // 'y'
const __V8_TAG_FALSE_OBJECT: number = 0x78; // 'x'
const __V8_TAG_NUMBER_OBJECT: number = 0x6e; // 'n'
const __V8_TAG_BIGINT_OBJECT: number = 0x7a; // 'z'
const __V8_TAG_STRING_OBJECT: number = 0x73; // 's'
const __V8_TAG_REGEXP: number = 0x52; // 'R'
const __V8_TAG_BEGIN_JS_MAP: number = 0x3b; // ';'
const __V8_TAG_END_JS_MAP: number = 0x3a; // ':'
const __V8_TAG_BEGIN_JS_SET: number = 0x27; // '\''
const __V8_TAG_END_JS_SET: number = 0x2c; // ','
const __V8_TAG_ARRAY_BUFFER: number = 0x42; // 'B'
const __V8_TAG_RESIZABLE_ARRAY_BUFFER: number = 0x7e; // '~'
const __V8_TAG_ARRAY_BUFFER_TRANSFER: number = 0x74; // 't'
const __V8_TAG_ARRAY_BUFFER_VIEW: number = 0x56; // 'V'
const __V8_TAG_SHARED_ARRAY_BUFFER: number = 0x75; // 'u'
const __V8_TAG_HOST_OBJECT: number = 0x5c; // '\\'
const __V8_TAG_ERROR: number = 0x72; // 'r'

// V8 `ErrorTag`, the sub-alphabet that follows `kError`.
const __V8_ERR_EVAL_PROTOTYPE: number = 0x45; // 'E'
const __V8_ERR_RANGE_PROTOTYPE: number = 0x52; // 'R'
const __V8_ERR_REFERENCE_PROTOTYPE: number = 0x46; // 'F'
const __V8_ERR_SYNTAX_PROTOTYPE: number = 0x53; // 'S'
const __V8_ERR_TYPE_PROTOTYPE: number = 0x54; // 'T'
const __V8_ERR_URI_PROTOTYPE: number = 0x55; // 'U'
const __V8_ERR_MESSAGE: number = 0x6d; // 'm'
const __V8_ERR_CAUSE: number = 0x63; // 'c'
const __V8_ERR_STACK: number = 0x73; // 's'
const __V8_ERR_END: number = 0x2e; // '.'

// `JSRegExp::Flags`, the bit set `kRegExp` carries as a varint.
const __V8_RE_GLOBAL: number = 1;
const __V8_RE_IGNORE_CASE: number = 2;
const __V8_RE_MULTILINE: number = 4;
const __V8_RE_STICKY: number = 8;
const __V8_RE_UNICODE: number = 16;
const __V8_RE_DOT_ALL: number = 32;
const __V8_RE_LINEAR: number = 64;
const __V8_RE_HAS_INDICES: number = 128;
const __V8_RE_UNICODE_SETS: number = 256;

// `lib/v8.js`' view-type index table. Index 10 is Node's `FastBuffer`, which
// is what a `Buffer` serializes as; the gap at 10 in V8's own ordering is why
// the BigInt and Float16 views start at 11.
const __V8_VIEW_INT8: number = 0;
const __V8_VIEW_UINT8: number = 1;
const __V8_VIEW_UINT8_CLAMPED: number = 2;
const __V8_VIEW_INT16: number = 3;
const __V8_VIEW_UINT16: number = 4;
const __V8_VIEW_INT32: number = 5;
const __V8_VIEW_UINT32: number = 6;
const __V8_VIEW_FLOAT32: number = 7;
const __V8_VIEW_FLOAT64: number = 8;
const __V8_VIEW_DATA_VIEW: number = 9;
const __V8_VIEW_FAST_BUFFER: number = 10;
const __V8_VIEW_BIGINT64: number = 11;
const __V8_VIEW_BIGUINT64: number = 12;
const __V8_VIEW_FLOAT16: number = 13;

// Smi bounds. Node is built *without* V8 pointer compression, so a Smi on a
// 64-bit host is a full 32-bit signed integer — which is why `2**31 - 1`
// serializes as `kInt32` while `2**31` serializes as `kDouble`.
const __V8_INT32_MIN: number = -2147483648;
const __V8_INT32_MAX: number = 2147483647;
const __V8_UINT32_MAX: number = 4294967295;

// One scratch `DataView` for every IEEE-754 conversion in both directions.
// `DataView` is the only byte-exact float codec this engine exposes, and its
// little-endian flag is honoured, which is what the wire format needs.
//
// It is reached through `__v8ScratchView()` rather than by name, and that is an
// engine workaround rather than a style choice: a module-level
// `const x: DataView` is *not* a `DataView` when read from inside a function
// here -- `x.setFloat64(...)` answers "setFloat64 is not a function" -- while
// the same value handed back by a function with a declared `DataView` return
// type is. Repro in ../../test/v8/README.md.
const __v8ScratchStore: DataView = new DataView(new ArrayBuffer(8));

function __v8ScratchView(): DataView {
  return __v8ScratchStore;
}

// `charCodeAt` past the end throws here instead of answering NaN (zun#2).
function __v8Cc(text: string, index: number): number {
  if (index < 0 || index >= Number(text.length)) return 0;
  return Number(text.charCodeAt(index));
}

// Re-type an `any` known to hold a `Uint8Array`/`Buffer` (zun#38). Not style:
// without the declared return type `value.length` answers `undefined` and
// `value[i]` is opaque.
function __v8AsBuffer(value: any): Buffer {
  return value;
}

// Is this value a byte view this module can *read*? `Buffer.isBuffer` answers
// `true` for the whole `Uint8Array` family (one runtime type in this engine)
// and `false` for every other view, for a string, a number and a plain
// object — so it is both the test and the only one available.
function __v8IsReadableView(value: any): boolean {
  if (value === null || value === undefined) return false;
  return Buffer.isBuffer(value);
}

// Is this value *some* `ArrayBufferView`? True for every typed array and for
// a `DataView`; false for an `ArrayBuffer`, an array and a plain object.
function __v8IsView(value: any): boolean {
  if (value === null || value === undefined) return false;
  return ArrayBuffer.isView(value) === true;
}

// ===========================================================================
// The serializer
// ===========================================================================

// One serializer's whole state. A plain object rather than class fields: see
// the header — a function assigned onto a class instance is lost, so the
// hooks and the buffer both live here and the classes are thin.
function __v8NewSerState(): any {
  return {
    bytes: [],
    // Index = object id. V8 numbers every `JSReceiver` it writes, in the
    // order it first writes them, and emits `kObjectReference` + that id on
    // every later sighting. A linear identity scan is the whole map: there is
    // no identity-keyed dictionary to lean on and a payload is small.
    ids: [],
    treatViewsAsHostObjects: false,
    // `transferArrayBuffer(id, arrayBuffer)`: two parallel lists, because the
    // key is an object identity.
    transferKeys: [],
    transferIds: [],
  };
}

function __v8PushByte(state: any, byte: number): void {
  state.bytes.push(byte & 0xff);
}

// How many bytes a varint of this value occupies. Needed ahead of the write
// for the two-byte-string alignment rule.
function __v8VarintLen(value: number): number {
  let v: number = value;
  let n: number = 1;
  while (v >= 128) {
    v = Math.floor(v / 128);
    n = n + 1;
  }
  return n;
}

// LEB128, over a `number` (exact below 2^53, which covers every length, id
// and flag set on the wire).
function __v8WriteVarint(state: any, value: number): void {
  let v: number = value;
  const out: any[] = state.bytes;
  while (true) {
    const byte: number = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) {
      out.push(byte + 128);
    } else {
      out.push(byte);
      return;
    }
  }
}

// LEB128 over a `bigint`, for `writeUint64` — a 64-bit value does not fit a
// `number` exactly.
function __v8WriteVarintBig(state: any, value: bigint): void {
  let v: bigint = value;
  const out: any[] = state.bytes;
  while (true) {
    const byte: number = Number(v & 127n);
    v = v >> 7n;
    if (v > 0n) {
      out.push(byte + 128);
    } else {
      out.push(byte);
      return;
    }
  }
}

// Zigzag, spelled with arithmetic rather than shifts so that `-2**31` maps to
// `4294967295` without relying on 32-bit wrap-around through `number`.
function __v8WriteZigZag(state: any, value: number): void {
  const zz: number = value < 0 ? -value * 2 - 1 : value * 2;
  __v8WriteVarint(state, zz);
}

function __v8WriteDoubleBytes(state: any, value: number): void {
  const scratch: DataView = __v8ScratchView();
  scratch.setFloat64(0, value, true);
  const out: any[] = state.bytes;
  for (let i = 0; i < 8; i++) out.push(Number(scratch.getUint8(i)));
}

// Does every code unit fit one byte? That is what decides `kOneByteString`
// versus `kTwoByteString`, and it is also the whole of
// `isStringOneByteRepresentation`.
function __v8IsOneByte(text: string): boolean {
  const n: number = Number(text.length);
  for (let i = 0; i < n; i++) {
    if (__v8Cc(text, i) > 0xff) return false;
  }
  return true;
}

// `ValueSerializer::WriteString`. The padding byte before a two-byte string is
// not decoration: V8's reader hands out a `uc16` view straight into the
// buffer, so the payload has to start at an even offset, and V8 inserts
// `kPadding` when the tag plus its length varint would leave it odd.
function __v8WriteString(state: any, text: string): void {
  const n: number = Number(text.length);
  const out: any[] = state.bytes;
  if (__v8IsOneByte(text)) {
    out.push(__V8_TAG_ONE_BYTE_STRING);
    __v8WriteVarint(state, n);
    for (let i = 0; i < n; i++) out.push(__v8Cc(text, i) & 0xff);
    return;
  }
  const byteLength: number = n * 2;
  const ahead: number = Number(out.length) + 1 + __v8VarintLen(byteLength);
  if (ahead % 2 === 1) out.push(__V8_TAG_PADDING);
  out.push(__V8_TAG_TWO_BYTE_STRING);
  __v8WriteVarint(state, byteLength);
  for (let i = 0; i < n; i++) {
    const code: number = __v8Cc(text, i);
    out.push(code & 0xff);
    out.push(Math.floor(code / 256) & 0xff);
  }
}

// `ValueSerializer::WriteSmi` / `WriteHeapNumber`: an integer inside the Smi
// range is a zigzag `kInt32`, everything else — including `-0`, which is a
// heap number in V8 — is a `kDouble`.
function __v8WriteNumber(state: any, value: number): void {
  const isNegativeZero: boolean = value === 0 && 1 / value < 0;
  if (
    !isNegativeZero && Number.isInteger(value) &&
    value >= __V8_INT32_MIN && value <= __V8_INT32_MAX
  ) {
    __v8PushByte(state, __V8_TAG_INT32);
    __v8WriteZigZag(state, value);
    return;
  }
  __v8PushByte(state, __V8_TAG_DOUBLE);
  __v8WriteDoubleBytes(state, value);
}

// The `kBigInt` payload: a bitfield varint — `sign | (byteLength << 1)` —
// followed by `byteLength / 8` little-endian 64-bit digits, themselves
// little-endian. Zero has no digits at all.
function __v8WriteBigIntPayload(state: any, value: bigint): void {
  const negative: boolean = value < 0n;
  let magnitude: bigint = negative ? -value : value;
  const digits: any[] = [];
  while (magnitude > 0n) {
    digits.push(magnitude & 0xffffffffffffffffn);
    magnitude = magnitude >> 64n;
  }
  const digitCount: number = Number(digits.length);
  const byteLength: number = digitCount * 8;
  __v8WriteVarint(state, (negative ? 1 : 0) + byteLength * 2);
  const out: any[] = state.bytes;
  for (let i = 0; i < digitCount; i++) {
    let digit: bigint = digits[i];
    for (let b = 0; b < 8; b++) {
      out.push(Number(digit & 0xffn));
      digit = digit >> 8n;
    }
  }
}

// A property key. V8's key accumulator hands back element indices as Smis and
// everything else as a string, so `{ 1: 2 }` puts a `kInt32` on the wire where
// `{ a: 2 }` puts a `kOneByteString`.
function __v8WriteKey(state: any, key: string): void {
  if (__utilIsIndexKey(key)) {
    const index: number = Number(key);
    if (index <= __V8_UINT32_MAX) {
      __v8WriteNumber(state, index);
      return;
    }
  }
  __v8WriteString(state, key);
}

// `_getDataCloneError` on the owner, which Node's tests replace to assert the
// message. Dispatched as a method call, the one spelling a subclass override
// is visible through (see the header).
function __v8CloneError(owner: any, message: string): any {
  if (owner === undefined || owner === null) return new Error(message);
  return owner._getDataCloneError(message);
}

function __v8WriteValue(state: any, value: any, owner: any): void {
  if (value === undefined) {
    __v8PushByte(state, __V8_TAG_UNDEFINED);
    return;
  }
  if (value === null) {
    __v8PushByte(state, __V8_TAG_NULL);
    return;
  }
  const kind: string = typeof value;
  if (kind === "boolean") {
    __v8PushByte(state, value === true ? __V8_TAG_TRUE : __V8_TAG_FALSE);
    return;
  }
  if (kind === "number") {
    __v8WriteNumber(state, Number(value));
    return;
  }
  if (kind === "bigint") {
    __v8PushByte(state, __V8_TAG_BIGINT);
    const big: bigint = value;
    __v8WriteBigIntPayload(state, big);
    return;
  }
  if (kind === "string") {
    __v8WriteString(state, String(value));
    return;
  }
  if (kind === "symbol") {
    throw __v8CloneError(owner, String(value) + " could not be cloned.");
  }
  if (kind === "function") {
    throw __v8CloneError(owner, __v8Describe(value) + " could not be cloned.");
  }
  __v8WriteReceiver(state, value, owner);
}

// Every object, array, map, set, date, regexp and host object goes through
// here, so that the id map is consulted exactly once per value.
function __v8WriteReceiver(state: any, value: any, owner: any): void {
  const ids: any[] = state.ids;
  const count: number = Number(ids.length);
  for (let i = 0; i < count; i++) {
    if (ids[i] === value) {
      __v8PushByte(state, __V8_TAG_OBJECT_REFERENCE);
      __v8WriteVarint(state, i);
      return;
    }
  }
  // V8 allocates the id *before* writing the contents, which is what makes a
  // self-referential object come out as `kObjectReference` of its own id.
  ids.push(value);

  if (__v8IsView(value)) {
    if (state.treatViewsAsHostObjects !== true) {
      // The base `Serializer` would serialize the view over its own
      // `ArrayBuffer` here (`kArrayBufferView` after `kArrayBuffer`); neither
      // the buffer nor the offsets are reachable through `any` in this engine
      // (see the header), so the reason is named rather than guessed.
      throw __v8CloneError(
        owner,
        "ArrayBufferView serialization without " +
          "_setTreatArrayBufferViewsAsHostObjects(true) needs the view's " +
          "ArrayBuffer, which is not reachable in this engine " +
          "(https://github.com/UrubuCode/zun/issues/38)",
      );
    }
    __v8PushByte(state, __V8_TAG_HOST_OBJECT);
    owner._writeHostObject(value);
    return;
  }
  if (value instanceof Date) {
    __v8PushByte(state, __V8_TAG_DATE);
    __v8WriteDoubleBytes(state, Number(value.getTime()));
    return;
  }
  const tag: string = __utilTag(value);
  if (tag === "[object RegExp]") {
    __v8PushByte(state, __V8_TAG_REGEXP);
    __v8WriteString(state, String(value.source));
    __v8WriteVarint(state, __v8RegExpFlagBits(value));
    return;
  }
  if (tag === "[object Map]") {
    __v8WriteMap(state, value, owner);
    return;
  }
  if (tag === "[object Set]") {
    __v8WriteSet(state, value, owner);
    return;
  }
  if (value instanceof Error) {
    __v8WriteError(state, value, owner);
    return;
  }
  if (Array.isArray(value)) {
    __v8WriteArray(state, value, owner);
    return;
  }
  __v8WriteObject(state, value, owner);
}

function __v8RegExpFlagBits(re: any): number {
  let bits: number = 0;
  if (re.global === true) bits = bits + __V8_RE_GLOBAL;
  if (re.ignoreCase === true) bits = bits + __V8_RE_IGNORE_CASE;
  if (re.multiline === true) bits = bits + __V8_RE_MULTILINE;
  if (re.sticky === true) bits = bits + __V8_RE_STICKY;
  if (re.unicode === true) bits = bits + __V8_RE_UNICODE;
  if (re.dotAll === true) bits = bits + __V8_RE_DOT_ALL;
  if (re.hasIndices === true) bits = bits + __V8_RE_HAS_INDICES;
  if (re.unicodeSets === true) bits = bits + __V8_RE_UNICODE_SETS;
  return bits;
}

function __v8WriteMap(state: any, map: any, owner: any): void {
  __v8PushByte(state, __V8_TAG_BEGIN_JS_MAP);
  let written: number = 0;
  for (const entry of map) {
    __v8WriteValue(state, entry[0], owner);
    __v8WriteValue(state, entry[1], owner);
    written = written + 2;
  }
  __v8PushByte(state, __V8_TAG_END_JS_MAP);
  __v8WriteVarint(state, written);
}

function __v8WriteSet(state: any, set: any, owner: any): void {
  __v8PushByte(state, __V8_TAG_BEGIN_JS_SET);
  let written: number = 0;
  for (const value of set) {
    __v8WriteValue(state, value, owner);
    written = written + 1;
  }
  __v8PushByte(state, __V8_TAG_END_JS_SET);
  __v8WriteVarint(state, written);
}

// `ValueSerializer::WriteJSArray`. V8 picks the dense encoding for an array
// whose elements are in a fast *packed* kind and the sparse one otherwise; an
// array's own index keys are always below its length and never repeat, so
// "every index present" is exactly "as many index keys as the length".
function __v8WriteArray(state: any, array: any, owner: any): void {
  const length: number = Number(array.length);
  const keys: any[] = Object.keys(array);
  const keyCount: number = Number(keys.length);
  let indexKeys: number = 0;
  for (let i = 0; i < keyCount; i++) {
    if (__utilIsIndexKey(String(keys[i]))) indexKeys = indexKeys + 1;
  }
  if (indexKeys === length) {
    __v8PushByte(state, __V8_TAG_BEGIN_DENSE_JS_ARRAY);
    __v8WriteVarint(state, length);
    for (let i = 0; i < length; i++) __v8WriteValue(state, array[i], owner);
    let properties: number = 0;
    for (let i = 0; i < keyCount; i++) {
      const key: string = String(keys[i]);
      if (__utilIsIndexKey(key)) continue;
      __v8WriteKey(state, key);
      __v8WriteValue(state, array[key], owner);
      properties = properties + 1;
    }
    __v8PushByte(state, __V8_TAG_END_DENSE_JS_ARRAY);
    __v8WriteVarint(state, properties);
    __v8WriteVarint(state, length);
    return;
  }
  __v8PushByte(state, __V8_TAG_BEGIN_SPARSE_JS_ARRAY);
  __v8WriteVarint(state, length);
  let properties: number = 0;
  for (let i = 0; i < keyCount; i++) {
    const key: string = String(keys[i]);
    __v8WriteKey(state, key);
    __v8WriteValue(state, array[key], owner);
    properties = properties + 1;
  }
  __v8PushByte(state, __V8_TAG_END_SPARSE_JS_ARRAY);
  __v8WriteVarint(state, properties);
  __v8WriteVarint(state, length);
}

function __v8WriteObject(state: any, object: any, owner: any): void {
  __v8PushByte(state, __V8_TAG_BEGIN_JS_OBJECT);
  const keys: any[] = Object.keys(object);
  const keyCount: number = Number(keys.length);
  for (let i = 0; i < keyCount; i++) {
    const key: string = String(keys[i]);
    __v8WriteKey(state, key);
    __v8WriteValue(state, object[key], owner);
  }
  __v8PushByte(state, __V8_TAG_END_JS_OBJECT);
  __v8WriteVarint(state, keyCount);
}

// `ValueSerializer::WriteJSError`: the prototype tag (absent for a plain
// `Error`), then the message, the stack, an optional cause, then `kEnd`.
function __v8WriteError(state: any, error: any, owner: any): void {
  __v8PushByte(state, __V8_TAG_ERROR);
  const name: string = String(error.name);
  if (name === "EvalError") __v8PushByte(state, __V8_ERR_EVAL_PROTOTYPE);
  else if (name === "RangeError") __v8PushByte(state, __V8_ERR_RANGE_PROTOTYPE);
  else if (name === "ReferenceError") {
    __v8PushByte(state, __V8_ERR_REFERENCE_PROTOTYPE);
  } else if (name === "SyntaxError") {
    __v8PushByte(state, __V8_ERR_SYNTAX_PROTOTYPE);
  } else if (name === "TypeError") __v8PushByte(state, __V8_ERR_TYPE_PROTOTYPE);
  else if (name === "URIError") __v8PushByte(state, __V8_ERR_URI_PROTOTYPE);

  const message: any = error.message;
  // V8 writes the message only when the error carries one. An `Error` built
  // with no argument has none; this engine reports that as the empty string,
  // so the empty string is what is treated as "absent".
  if (message !== undefined && message !== null && String(message) !== "") {
    __v8PushByte(state, __V8_ERR_MESSAGE);
    __v8WriteString(state, String(message));
  }
  __v8PushByte(state, __V8_ERR_STACK);
  const stack: any = error.stack;
  __v8WriteString(
    state,
    stack === undefined || stack === null ? "" : String(stack),
  );
  const cause: any = error.cause;
  if (cause !== undefined) {
    __v8PushByte(state, __V8_ERR_CAUSE);
    __v8WriteValue(state, cause, owner);
  }
  __v8PushByte(state, __V8_ERR_END);
}

// `util.inspect` is in the bundle as `__evInspect` (events' copy of the
// formatter); the host-object error messages are the only place this module
// needs it.
function __v8Describe(value: any): string {
  return __evInspect(value);
}

function __v8WriteHeader(state: any): void {
  __v8PushByte(state, 0xff);
  __v8WriteVarint(state, __V8_FORMAT_VERSION);
}

function __v8ReleaseBuffer(state: any): Buffer {
  const bytes: any[] = state.bytes;
  state.bytes = [];
  state.ids = [];
  return Buffer.from(bytes);
}

// `Serializer.prototype.writeRawBytes(source)`. Node accepts a `TypedArray` or
// a `DataView`; only the `Uint8Array` family is readable here, so a view of
// another kind is reported with its reason instead of silently writing zeros.
function __v8WriteRawBytes(state: any, source: any): void {
  if (!__v8IsView(source)) {
    throw new TypeError("source must be a TypedArray or a DataView");
  }
  if (!__v8IsReadableView(source)) {
    throw new Error(
      "writeRawBytes() of a non-Uint8Array view: the view's bytes are not " +
        "reachable in this engine " +
        "(https://github.com/UrubuCode/zun/issues/38)",
    );
  }
  const bytes: Buffer = __v8AsBuffer(source);
  const length: number = Number(bytes.length);
  const out: any[] = state.bytes;
  for (let i = 0; i < length; i++) out.push(Number(bytes[i]) & 0xff);
}

// `DefaultSerializer.prototype._writeHostObject`. Node writes the view-type
// index, the byte length and the raw bytes — deliberately *not* the view's
// `ArrayBuffer`, because `Buffer` is pool-allocated there and the pool would
// come along with it.
function __v8DefaultWriteHostObject(state: any, view: any, owner: any): void {
  if (!__v8IsView(view)) {
    throw __v8CloneError(
      owner,
      "Unserializable host object: " + __v8Describe(view),
    );
  }
  if (!__v8IsReadableView(view)) {
    throw __v8CloneError(
      owner,
      "Unserializable host object: an ArrayBufferView whose element type " +
        "this engine does not report. Only Uint8Array/Buffer views can be " +
        "serialized here; see the header of src/v8/v8.ts and " +
        "https://github.com/UrubuCode/zun/issues/38",
    );
  }
  // `Buffer` and `Uint8Array` are one runtime type in this engine, so the two
  // cannot be told apart; index 10 (`FastBuffer`) is the one that makes a
  // `Buffer` — by far the common case, and the only one Node's own corpus
  // round-trips — byte-identical to Node.
  const bytes: Buffer = __v8AsBuffer(view);
  const length: number = Number(bytes.length);
  __v8WriteVarint(state, __V8_VIEW_FAST_BUFFER);
  __v8WriteVarint(state, length);
  const out: any[] = state.bytes;
  for (let i = 0; i < length; i++) out.push(Number(bytes[i]) & 0xff);
}

// ===========================================================================
// The deserializer
// ===========================================================================

function __v8NewDesState(buffer: any): any {
  if (!__v8IsView(buffer)) {
    throw new TypeError("buffer must be a TypedArray or a DataView");
  }
  if (!__v8IsReadableView(buffer)) {
    throw new Error(
      "new Deserializer() of a non-Uint8Array view: the view's bytes are " +
        "not reachable in this engine " +
        "(https://github.com/UrubuCode/zun/issues/38)",
    );
  }
  const bytes: Buffer = __v8AsBuffer(buffer);
  return {
    buf: bytes,
    length: Number(bytes.length),
    pos: 0,
    version: 0,
    // Index = object id, exactly as on the write side.
    ids: [],
    transferKeys: [],
    transferIds: [],
  };
}

function __v8ReadByte(state: any): number {
  const pos: number = Number(state.pos);
  if (pos >= Number(state.length)) {
    throw new Error("Unexpected end of buffer");
  }
  state.pos = pos + 1;
  const bytes: Buffer = state.buf;
  return Number(bytes[pos]) & 0xff;
}

function __v8PeekByte(state: any): number {
  const pos: number = Number(state.pos);
  if (pos >= Number(state.length)) return -1;
  const bytes: Buffer = state.buf;
  return Number(bytes[pos]) & 0xff;
}

function __v8ReadVarint(state: any): number {
  let result: number = 0;
  let scale: number = 1;
  while (true) {
    const byte: number = __v8ReadByte(state);
    result = result + (byte % 128) * scale;
    if (byte < 128) return result;
    scale = scale * 128;
  }
}

function __v8ReadVarintBig(state: any): bigint {
  let result: bigint = 0n;
  let shift: bigint = 0n;
  while (true) {
    const byte: number = __v8ReadByte(state);
    result = result | (BigInt(byte % 128) << shift);
    if (byte < 128) return result;
    shift = shift + 7n;
  }
}

function __v8ReadZigZag(state: any): number {
  const zz: number = __v8ReadVarint(state);
  if (zz % 2 === 0) return zz / 2;
  return -((zz + 1) / 2);
}

function __v8ReadDoubleBytes(state: any): number {
  if (Number(state.pos) + 8 > Number(state.length)) {
    // The message Node's regression test for nodejs/node#37978 matches.
    throw new Error("ReadDouble() failed");
  }
  const bytes: Buffer = state.buf;
  const base: number = Number(state.pos);
  const scratch: DataView = __v8ScratchView();
  for (let i = 0; i < 8; i++) {
    scratch.setUint8(i, (Number(bytes[base + i]) & 0xff) as u8);
  }
  state.pos = base + 8;
  return Number(scratch.getFloat64(0, true));
}

function __v8ReadRawBytes(state: any, length: number): Buffer {
  const base: number = Number(state.pos);
  if (base + length > Number(state.length)) {
    throw new Error("Unexpected end of buffer");
  }
  state.pos = base + length;
  const bytes: Buffer = state.buf;
  // `as u64` on both bounds: `subarray` takes machine integers and the checker
  // rejects a `number` there outright (zun#3). The bounds were range-checked
  // above, which the unchecked cast relies on.
  return bytes.subarray(base as u64, (base + length) as u64);
}

function __v8ReadOneByteString(state: any, byteLength: number): string {
  const bytes: Buffer = __v8ReadRawBytes(state, byteLength);
  let out: string = "";
  for (let i = 0; i < byteLength; i++) {
    out = out + String.fromCharCode(Number(bytes[i]) & 0xff);
  }
  return out;
}

function __v8ReadTwoByteString(state: any, byteLength: number): string {
  const bytes: Buffer = __v8ReadRawBytes(state, byteLength);
  const units: number = Math.floor(byteLength / 2);
  let out: string = "";
  for (let i = 0; i < units; i++) {
    const low: number = Number(bytes[i * 2]) & 0xff;
    const high: number = Number(bytes[i * 2 + 1]) & 0xff;
    out = out + String.fromCharCode(low + high * 256);
  }
  return out;
}

function __v8ReadUtf8String(state: any, byteLength: number): string {
  const bytes: Buffer = __v8ReadRawBytes(state, byteLength);
  return bytes.toString("utf8");
}

function __v8ReadBigIntPayload(state: any): bigint {
  const bitfield: number = __v8ReadVarint(state);
  const negative: boolean = bitfield % 2 === 1;
  const byteLength: number = Math.floor(bitfield / 2);
  const bytes: Buffer = __v8ReadRawBytes(state, byteLength);
  let magnitude: bigint = 0n;
  for (let i = byteLength - 1; i >= 0; i--) {
    magnitude = (magnitude << 8n) | BigInt(Number(bytes[i]) & 0xff);
  }
  return negative ? -magnitude : magnitude;
}

function __v8ReadHeader(state: any): void {
  if (__v8PeekByte(state) === 0xff) {
    state.pos = Number(state.pos) + 1;
    state.version = __v8ReadVarint(state);
    return;
  }
  // A buffer with no version header is treated as version 0, which is what
  // V8's `ReadHeader` does.
  state.version = 0;
}

// Build the regexp back from its source and flag bits. `new RegExp(source,
// flags)` is the only route; the `linear` bit has no JavaScript spelling, so
// it is dropped (V8 only ever sets it under `--enable-experimental-regexp-
// engine`).
function __v8RegExpFromBits(source: string, bits: number): any {
  let flags: string = "";
  if (bits % (__V8_RE_HAS_INDICES * 2) >= __V8_RE_HAS_INDICES) flags = flags + "d";
  if (bits % (__V8_RE_GLOBAL * 2) >= __V8_RE_GLOBAL) flags = flags + "g";
  if (bits % (__V8_RE_IGNORE_CASE * 2) >= __V8_RE_IGNORE_CASE) flags = flags + "i";
  if (bits % (__V8_RE_MULTILINE * 2) >= __V8_RE_MULTILINE) flags = flags + "m";
  if (bits % (__V8_RE_DOT_ALL * 2) >= __V8_RE_DOT_ALL) flags = flags + "s";
  if (bits % (__V8_RE_UNICODE * 2) >= __V8_RE_UNICODE) flags = flags + "u";
  if (bits % (__V8_RE_UNICODE_SETS * 2) >= __V8_RE_UNICODE_SETS) flags = flags + "v";
  if (bits % (__V8_RE_STICKY * 2) >= __V8_RE_STICKY) flags = flags + "y";
  return new RegExp(source, flags);
}

function __v8ReadValue(state: any, owner: any): any {
  const tag: number = __v8ReadByte(state);
  if (tag === __V8_TAG_PADDING) return __v8ReadValue(state, owner);
  if (tag === __V8_TAG_VERIFY_OBJECT_COUNT) {
    __v8ReadVarint(state);
    return __v8ReadValue(state, owner);
  }
  if (tag === __V8_TAG_UNDEFINED) return undefined;
  if (tag === __V8_TAG_NULL) return null;
  if (tag === __V8_TAG_TRUE) return true;
  if (tag === __V8_TAG_FALSE) return false;
  if (tag === __V8_TAG_THE_HOLE) return undefined;
  if (tag === __V8_TAG_INT32) return __v8ReadZigZag(state);
  if (tag === __V8_TAG_UINT32) return __v8ReadVarint(state);
  if (tag === __V8_TAG_DOUBLE) return __v8ReadDoubleBytes(state);
  if (tag === __V8_TAG_BIGINT) return __v8ReadBigIntPayload(state);
  if (tag === __V8_TAG_ONE_BYTE_STRING) {
    return __v8ReadOneByteString(state, __v8ReadVarint(state));
  }
  if (tag === __V8_TAG_TWO_BYTE_STRING) {
    return __v8ReadTwoByteString(state, __v8ReadVarint(state));
  }
  if (tag === __V8_TAG_UTF8_STRING) {
    return __v8ReadUtf8String(state, __v8ReadVarint(state));
  }
  if (tag === __V8_TAG_OBJECT_REFERENCE) {
    const id: number = __v8ReadVarint(state);
    const ids: any[] = state.ids;
    if (id >= Number(ids.length)) throw new Error("Invalid object reference");
    return ids[id];
  }
  if (tag === __V8_TAG_DATE) {
    const date: any = new Date(__v8ReadDoubleBytes(state));
    state.ids.push(date);
    return date;
  }
  if (tag === __V8_TAG_TRUE_OBJECT || tag === __V8_TAG_FALSE_OBJECT) {
    // A boxed primitive. There is no `new Boolean(...)` wrapper object in
    // this engine, so the primitive is handed back and the distinction is
    // lost; documented in ../../test/v8/README.md.
    const boxed: any = tag === __V8_TAG_TRUE_OBJECT;
    state.ids.push(boxed);
    return boxed;
  }
  if (tag === __V8_TAG_NUMBER_OBJECT) {
    const boxed: any = __v8ReadDoubleBytes(state);
    state.ids.push(boxed);
    return boxed;
  }
  if (tag === __V8_TAG_BIGINT_OBJECT) {
    const boxed: any = __v8ReadBigIntPayload(state);
    state.ids.push(boxed);
    return boxed;
  }
  if (tag === __V8_TAG_STRING_OBJECT) {
    const boxed: any = __v8ReadValue(state, owner);
    state.ids.push(boxed);
    return boxed;
  }
  if (tag === __V8_TAG_REGEXP) {
    const source: any = __v8ReadValue(state, owner);
    const bits: number = __v8ReadVarint(state);
    const re: any = __v8RegExpFromBits(String(source), bits);
    state.ids.push(re);
    return re;
  }
  if (tag === __V8_TAG_BEGIN_JS_OBJECT) return __v8ReadObject(state, owner);
  if (tag === __V8_TAG_BEGIN_DENSE_JS_ARRAY) {
    return __v8ReadDenseArray(state, owner);
  }
  if (tag === __V8_TAG_BEGIN_SPARSE_JS_ARRAY) {
    return __v8ReadSparseArray(state, owner);
  }
  if (tag === __V8_TAG_BEGIN_JS_MAP) return __v8ReadMap(state, owner);
  if (tag === __V8_TAG_BEGIN_JS_SET) return __v8ReadSet(state, owner);
  if (tag === __V8_TAG_ERROR) return __v8ReadError(state, owner);
  if (tag === __V8_TAG_HOST_OBJECT) {
    const host: any = owner._readHostObject();
    state.ids.push(host);
    return host;
  }
  if (tag === __V8_TAG_ARRAY_BUFFER || tag === __V8_TAG_SHARED_ARRAY_BUFFER) {
    const byteLength: number = __v8ReadVarint(state);
    __v8ReadRawBytes(state, byteLength);
    throw new Error(
      "ArrayBuffer deserialization needs an ArrayBuffer whose bytes can be " +
        "written, which is not reachable in this engine " +
        "(https://github.com/UrubuCode/zun/issues/38)",
    );
  }
  if (tag === __V8_TAG_ARRAY_BUFFER_TRANSFER) {
    __v8ReadVarint(state);
    throw new Error("transferred ArrayBuffers are not supported here");
  }
  throw new Error("Unable to deserialize cloned data: tag " + String(tag));
}

function __v8ReadObject(state: any, owner: any): any {
  const object: any = {};
  state.ids.push(object);
  let read: number = 0;
  while (true) {
    if (__v8PeekByte(state) === __V8_TAG_END_JS_OBJECT) {
      state.pos = Number(state.pos) + 1;
      const expected: number = __v8ReadVarint(state);
      if (expected !== read) {
        throw new Error("Unexpected number of properties");
      }
      return object;
    }
    const key: any = __v8ReadValue(state, owner);
    const value: any = __v8ReadValue(state, owner);
    object[String(key)] = value;
    read = read + 1;
  }
}

// A JavaScript array of `length` slots. The engine has no way to *create* a
// hole, so an unwritten slot reads back as `undefined` rather than being
// absent; `Object.keys` therefore reports it, which is the one observable
// difference from Node for a sparse array (documented in
// ../../test/v8/README.md).
function __v8NewArray(length: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < length; i++) out.push(undefined);
  return out;
}

function __v8ReadDenseArray(state: any, owner: any): any {
  const length: number = __v8ReadVarint(state);
  const array: any = __v8NewArray(length);
  state.ids.push(array);
  for (let i = 0; i < length; i++) {
    array[i] = __v8ReadValue(state, owner);
  }
  let properties: number = 0;
  while (true) {
    if (__v8PeekByte(state) === __V8_TAG_END_DENSE_JS_ARRAY) {
      state.pos = Number(state.pos) + 1;
      const expectedProperties: number = __v8ReadVarint(state);
      const expectedLength: number = __v8ReadVarint(state);
      if (expectedProperties !== properties || expectedLength !== length) {
        throw new Error("Unexpected number of properties");
      }
      return array;
    }
    const key: any = __v8ReadValue(state, owner);
    const value: any = __v8ReadValue(state, owner);
    array[String(key)] = value;
    properties = properties + 1;
  }
}

function __v8ReadSparseArray(state: any, owner: any): any {
  const length: number = __v8ReadVarint(state);
  const array: any = __v8NewArray(length);
  state.ids.push(array);
  let properties: number = 0;
  while (true) {
    if (__v8PeekByte(state) === __V8_TAG_END_SPARSE_JS_ARRAY) {
      state.pos = Number(state.pos) + 1;
      const expectedProperties: number = __v8ReadVarint(state);
      const expectedLength: number = __v8ReadVarint(state);
      if (expectedProperties !== properties || expectedLength !== length) {
        throw new Error("Unexpected number of properties");
      }
      return array;
    }
    const key: any = __v8ReadValue(state, owner);
    const value: any = __v8ReadValue(state, owner);
    array[String(key)] = value;
    properties = properties + 1;
  }
}

function __v8ReadMap(state: any, owner: any): any {
  const map: any = new Map();
  state.ids.push(map);
  let read: number = 0;
  while (true) {
    if (__v8PeekByte(state) === __V8_TAG_END_JS_MAP) {
      state.pos = Number(state.pos) + 1;
      const expected: number = __v8ReadVarint(state);
      if (expected !== read) throw new Error("Unexpected number of entries");
      return map;
    }
    const key: any = __v8ReadValue(state, owner);
    const value: any = __v8ReadValue(state, owner);
    map.set(key, value);
    read = read + 2;
  }
}

function __v8ReadSet(state: any, owner: any): any {
  const set: any = new Set();
  state.ids.push(set);
  let read: number = 0;
  while (true) {
    if (__v8PeekByte(state) === __V8_TAG_END_JS_SET) {
      state.pos = Number(state.pos) + 1;
      const expected: number = __v8ReadVarint(state);
      if (expected !== read) throw new Error("Unexpected number of entries");
      return set;
    }
    set.add(__v8ReadValue(state, owner));
    read = read + 1;
  }
}

function __v8ReadError(state: any, owner: any): any {
  let kind: string = "Error";
  let message: any = undefined;
  let stack: any = undefined;
  let cause: any = undefined;
  let hasCause: boolean = false;
  while (true) {
    const tag: number = __v8ReadByte(state);
    if (tag === __V8_ERR_END) break;
    if (tag === __V8_ERR_EVAL_PROTOTYPE) kind = "EvalError";
    else if (tag === __V8_ERR_RANGE_PROTOTYPE) kind = "RangeError";
    else if (tag === __V8_ERR_REFERENCE_PROTOTYPE) kind = "ReferenceError";
    else if (tag === __V8_ERR_SYNTAX_PROTOTYPE) kind = "SyntaxError";
    else if (tag === __V8_ERR_TYPE_PROTOTYPE) kind = "TypeError";
    else if (tag === __V8_ERR_URI_PROTOTYPE) kind = "URIError";
    else if (tag === __V8_ERR_MESSAGE) message = __v8ReadValue(state, owner);
    else if (tag === __V8_ERR_STACK) stack = __v8ReadValue(state, owner);
    else if (tag === __V8_ERR_CAUSE) {
      cause = __v8ReadValue(state, owner);
      hasCause = true;
    } else throw new Error("Unable to deserialize cloned error");
  }
  const text: string = message === undefined ? "" : String(message);
  let error: any = new Error(text);
  if (kind === "EvalError") error = new EvalError(text);
  else if (kind === "RangeError") error = new RangeError(text);
  else if (kind === "ReferenceError") error = new ReferenceError(text);
  else if (kind === "SyntaxError") error = new SyntaxError(text);
  else if (kind === "TypeError") error = new TypeError(text);
  else if (kind === "URIError") error = new URIError(text);
  if (stack !== undefined) error.stack = String(stack);
  if (hasCause) error.cause = cause;
  state.ids.push(error);
  return error;
}

// `DefaultDeserializer.prototype._readHostObject`: the view-type index, the
// byte length and the bytes, turned back into a view of that type. The
// deserializer *constructs* the views, so unlike the write side it serves
// every kind the engine has.
function __v8DefaultReadHostObject(state: any): any {
  const typeIndex: number = __v8ReadVarint(state);
  const byteLength: number = __v8ReadVarint(state);
  const bytes: Buffer = __v8ReadRawBytes(state, byteLength);
  if (typeIndex === __V8_VIEW_FAST_BUFFER || typeIndex === __V8_VIEW_UINT8) {
    return Buffer.from(bytes.toString("base64"), "base64");
  }
  if (typeIndex === __V8_VIEW_DATA_VIEW) {
    // `as u64` for the same reason the `Buffer` sizes need it (zun#3).
    const view: DataView = new DataView(new ArrayBuffer(byteLength as u64));
    for (let i = 0; i < byteLength; i++) {
      view.setUint8(i, (Number(bytes[i]) & 0xff) as u8);
    }
    return view;
  }
  if (typeIndex === __V8_VIEW_INT8) {
    return new Int8Array(__v8DecodeElements(bytes, byteLength, 1, "i"));
  }
  if (typeIndex === __V8_VIEW_UINT8_CLAMPED) {
    return new Uint8ClampedArray(__v8DecodeElements(bytes, byteLength, 1, "u"));
  }
  if (typeIndex === __V8_VIEW_INT16) {
    return new Int16Array(__v8DecodeElements(bytes, byteLength, 2, "i"));
  }
  if (typeIndex === __V8_VIEW_UINT16) {
    return new Uint16Array(__v8DecodeElements(bytes, byteLength, 2, "u"));
  }
  if (typeIndex === __V8_VIEW_INT32) {
    return new Int32Array(__v8DecodeElements(bytes, byteLength, 4, "i"));
  }
  if (typeIndex === __V8_VIEW_UINT32) {
    return new Uint32Array(__v8DecodeElements(bytes, byteLength, 4, "u"));
  }
  if (typeIndex === __V8_VIEW_FLOAT32) {
    return new Float32Array(__v8DecodeElements(bytes, byteLength, 4, "f"));
  }
  if (typeIndex === __V8_VIEW_FLOAT64) {
    return new Float64Array(__v8DecodeElements(bytes, byteLength, 8, "f"));
  }
  if (
    typeIndex === __V8_VIEW_BIGINT64 || typeIndex === __V8_VIEW_BIGUINT64
  ) {
    throw new Error(
      "BigInt64Array/BigUint64Array cannot be built with their element " +
        "values in this engine (new BigInt64Array([42n])[0] answers 0), so " +
        "view type " + String(typeIndex) + " is rejected rather than " +
        "returned full of zeros",
    );
  }
  if (typeIndex === __V8_VIEW_FLOAT16) {
    throw new Error("Float16Array is not defined in this engine");
  }
  throw new Error("Unknown ArrayBufferView type index " + String(typeIndex));
}

// Decode `byteLength` bytes into element values of the given width and
// signedness, through the scratch `DataView` — the only byte-exact float and
// integer codec available.
function __v8DecodeElements(
  bytes: Buffer,
  byteLength: number,
  width: number,
  kind: string,
): number[] {
  const count: number = Math.floor(byteLength / width);
  const out: number[] = [];
  const scratch: DataView = __v8ScratchView();
  for (let i = 0; i < count; i++) {
    for (let b = 0; b < width; b++) {
      scratch.setUint8(b, (Number(bytes[i * width + b]) & 0xff) as u8);
    }
    if (kind === "f") {
      out.push(
        width === 4
          ? Number(scratch.getFloat32(0, true))
          : Number(scratch.getFloat64(0, true)),
      );
      continue;
    }
    if (kind === "i") {
      if (width === 1) out.push(Number(scratch.getInt8(0)));
      else if (width === 2) out.push(Number(scratch.getInt16(0, true)));
      else out.push(Number(scratch.getInt32(0, true)));
      continue;
    }
    if (width === 1) out.push(Number(scratch.getUint8(0)));
    else if (width === 2) out.push(Number(scratch.getUint16(0, true)));
    else out.push(Number(scratch.getUint32(0, true)));
  }
  return out;
}

// ===========================================================================
// Serializer / Deserializer, and the two Default* subclasses
// ===========================================================================
//
// Every method is a one-line delegation to a `__v8*` function over
// `this.s`, the plain-object state. `this` is only ever read as a known class
// type here, which is the lane that threads a receiver
// (https://github.com/UrubuCode/zun/issues/1), and the two host-object hooks
// are *called* rather than read, so a subclass override is found.

class Serializer {
  s: any;
  constructor() {
    this.s = __v8NewSerState();
  }

  writeHeader(): void {
    __v8WriteHeader(this.s);
  }

  writeValue(value: any): boolean {
    __v8WriteValue(this.s, value, this);
    return true;
  }

  releaseBuffer(): Buffer {
    return __v8ReleaseBuffer(this.s);
  }

  writeUint32(value: any): void {
    __v8WriteVarint(this.s, __v8ValidateUint32(value, "value"));
  }

  // Node's binding takes the 64-bit value as a (hi, lo) pair of uint32s and
  // puts one varint of `hi * 2**32 + lo` on the wire.
  writeUint64(hi: any, lo: any): void {
    const high: number = __v8ValidateUint32(hi, "hi");
    const low: number = __v8ValidateUint32(lo, "lo");
    __v8WriteVarintBig(this.s, (BigInt(high) << 32n) | BigInt(low));
  }

  writeDouble(value: any): void {
    __v8WriteDoubleBytes(this.s, Number(value));
  }

  writeRawBytes(source: any): void {
    __v8WriteRawBytes(this.s, source);
  }

  // `transferArrayBuffer(id, arrayBuffer)` registers the buffer so that a
  // later `writeValue` of it emits `kArrayBufferTransfer` + id instead of its
  // contents. The registration is kept, and that is as far as it can go: an
  // `ArrayBuffer` reached through an `any` is indistinguishable from `{}` in
  // this engine (see the header), so `writeValue` never recognizes one and the
  // table is never consulted. Dropping the method would be worse — a consumer
  // would get "not a function" instead of a value that simply never arrives.
  transferArrayBuffer(id: any, arrayBuffer: any): void {
    const state: any = this.s;
    state.transferKeys.push(arrayBuffer);
    state.transferIds.push(__v8ValidateUint32(id, "id"));
  }

  _setTreatArrayBufferViewsAsHostObjects(value: any): void {
    this.s.treatViewsAsHostObjects = value === true;
  }

  // The base serializer has no host-object delegate, which is exactly what
  // V8's `ValueSerializer` reports when none is installed.
  _writeHostObject(object: any): void {
    throw __v8CloneError(
      this,
      __v8Describe(object) + " could not be cloned.",
    );
  }

  _getDataCloneError(message: any): any {
    return new Error(String(message));
  }
}

class Deserializer {
  s: any;
  constructor(buffer: any) {
    this.s = __v8NewDesState(buffer);
  }

  readHeader(): boolean {
    __v8ReadHeader(this.s);
    return true;
  }

  readValue(): any {
    return __v8ReadValue(this.s, this);
  }

  getWireFormatVersion(): number {
    return Number(this.s.version);
  }

  readUint32(): number {
    return __v8ReadVarint(this.s);
  }

  // The (hi, lo) pair, the inverse of `writeUint64`.
  readUint64(): number[] {
    const value: bigint = __v8ReadVarintBig(this.s);
    return [Number(value >> 32n), Number(value & 0xffffffffn)];
  }

  readDouble(): number {
    return __v8ReadDoubleBytes(this.s);
  }

  readRawBytes(length: any): Buffer {
    return __v8ReadRawBytes(this.s, Number(length));
  }

  // Node's `_readRawBytes` answers the *offset* of the bytes inside the
  // deserializer's buffer and advances past them; `DefaultDeserializer` uses
  // it to build a view without copying.
  _readRawBytes(length: any): number {
    const state: any = this.s;
    const offset: number = Number(state.pos);
    __v8ReadRawBytes(state, Number(length));
    return offset;
  }

  // The read side of the same registration, and the same limit: `readValue`
  // rejects `kArrayBufferTransfer` because there is no writable `ArrayBuffer`
  // to hand back (see the header).
  transferArrayBuffer(id: any, arrayBuffer: any): void {
    const state: any = this.s;
    state.transferKeys.push(arrayBuffer);
    state.transferIds.push(__v8ValidateUint32(id, "id"));
  }

  readHostObject(): any {
    return this._readHostObject();
  }

  _readHostObject(): any {
    throw new Error("Unable to deserialize cloned data: no host object hook");
  }
}

class DefaultSerializer extends Serializer {
  constructor() {
    super();
    this._setTreatArrayBufferViewsAsHostObjects(true);
  }

  _writeHostObject(view: any): void {
    __v8DefaultWriteHostObject(this.s, view, this);
  }
}

class DefaultDeserializer extends Deserializer {
  _readHostObject(): any {
    return __v8DefaultReadHostObject(this.s);
  }
}

function __v8Serialize(value: any): Buffer {
  const ser: DefaultSerializer = new DefaultSerializer();
  ser.writeHeader();
  ser.writeValue(value);
  return ser.releaseBuffer();
}

function __v8Deserialize(buffer: any): any {
  const des: DefaultDeserializer = new DefaultDeserializer(buffer);
  des.readHeader();
  return des.readValue();
}

// ===========================================================================
// Validators
// ===========================================================================

function __v8ValidateUint32(value: any, name: string): number {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  const n: number = Number(value);
  if (!Number.isInteger(n)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (n < 0 || n > __V8_UINT32_MAX) {
    throw new ERR_OUT_OF_RANGE(name, ">= 0 && <= 4294967295", value);
  }
  return n;
}

// ===========================================================================
// cachedDataVersionTag / setFlagsFromString
// ===========================================================================
//
// V8 derives the tag from its own version, the active command-line flags and
// the detected CPU features; `test-v8-version-tag.js` asserts only that it is
// a stable number which *changes* when a flag is toggled. The honest
// equivalent here is a hash of the engine version and the flag text seen so
// far: stable between calls, different after `setFlagsFromString`, and derived
// from nothing this module made up.

const __v8FlagState: any = { flags: "", tag: 0, dirty: true };

function __v8FnvHash(text: string): number {
  // FNV-1a, 32-bit, in float arithmetic (the engine has no uint32 multiply
  // that stays exact), folded back into a uint32 after every step.
  let hash: number = 2166136261;
  const n: number = Number(text.length);
  for (let i = 0; i < n; i++) {
    hash = hash ^ __v8Cc(text, i);
    // 16777619 = 0x01000193, split so that the product stays exact.
    const low: number = (hash * 403) % 4294967296;
    const high: number = (hash * 16777216) % 4294967296;
    hash = (low + high) % 4294967296;
    if (hash < 0) hash = hash + 4294967296;
  }
  return hash;
}

function __v8CachedDataVersionTag(): number {
  if (__v8FlagState.dirty === true) {
    const versions: any = process.versions;
    const engine: string = String(versions.zun) + "/" + String(versions.node);
    __v8FlagState.tag = __v8FnvHash(engine + "\u0000" + String(__v8FlagState.flags));
    __v8FlagState.dirty = false;
  }
  return Number(__v8FlagState.tag);
}

// Accepted, validated, remembered, and otherwise a no-op: there is no V8 here
// to flip a flag on. The flag text is folded into `cachedDataVersionTag()`,
// which is the only observable V8 behaviour that depends on it.
function __v8SetFlagsFromString(flags: any): void {
  if (typeof flags !== "string") {
    throw new ERR_INVALID_ARG_TYPE("flags", "string", flags);
  }
  __v8FlagState.flags = String(__v8FlagState.flags) + " " + String(flags);
  __v8FlagState.dirty = true;
}

function __v8IsStringOneByteRepresentation(content: any): boolean {
  if (typeof content !== "string") {
    throw new ERR_INVALID_ARG_TYPE("content", "string", content);
  }
  return __v8IsOneByte(String(content));
}

// ===========================================================================
// Heap statistics
// ===========================================================================

// `lib/v8.js`' `getHeapStatistics` keys, in the order it builds them. Three
// of the fourteen are answerable from `process.memoryUsage()`; the rest are
// V8 internals with no counterpart here and are zero (see the header table).
function __v8GetHeapStatistics(): any {
  const usage: any = __processMemoryUsage();
  return {
    total_heap_size: Number(usage.heapTotal),
    total_heap_size_executable: 0,
    total_physical_size: 0,
    total_available_size: 0,
    used_heap_size: Number(usage.heapUsed),
    heap_size_limit: 0,
    malloced_memory: 0,
    peak_malloced_memory: 0,
    does_zap_garbage: 0,
    number_of_native_contexts: 0,
    number_of_detached_contexts: 0,
    total_global_handles_size: 0,
    used_global_handles_size: 0,
    external_memory: Number(usage.external),
  };
}

// V8's heap space names at Node 25, which is what `test-v8-stats.js` asserts
// the set of. Zun's heap is not divided into spaces, so every size is zero —
// the shape is V8's, the numbers are this runtime's.
const __V8_HEAP_SPACES: string[] = [
  "read_only_space",
  "new_space",
  "old_space",
  "code_space",
  "shared_space",
  "trusted_space",
  "new_large_object_space",
  "large_object_space",
  "code_large_object_space",
  "shared_large_object_space",
  "trusted_large_object_space",
  "shared_trusted_space",
  "shared_trusted_large_object_space",
];

function __v8GetHeapSpaceStatistics(): any[] {
  const out: any[] = [];
  const count: number = Number(__V8_HEAP_SPACES.length);
  for (let i = 0; i < count; i++) {
    out.push({
      space_name: __V8_HEAP_SPACES[i],
      space_size: 0,
      space_used_size: 0,
      space_available_size: 0,
      physical_space_size: 0,
    });
  }
  return out;
}

function __v8GetHeapCodeStatistics(): any {
  return {
    code_and_metadata_size: 0,
    bytecode_and_metadata_size: 0,
    external_script_source_size: 0,
    cpu_profiler_metadata_size: 0,
  };
}

// `getCppHeapStatistics(detailLevel)`. Node's `detailLevel` is `'brief'` or
// `'detailed'`; the brief shape is the totals alone, the detailed one adds the
// per-space breakdown. There is no Oilpan heap here, so both are zero.
function __v8GetCppHeapStatistics(detailLevel?: any): any {
  let detail: string = "detailed";
  if (detailLevel !== undefined && detailLevel !== null) {
    detail = String(detailLevel);
    if (detail !== "brief" && detail !== "detailed") {
      throw new ERR_INVALID_ARG_VALUE(
        "detailLevel",
        detailLevel,
        "must be one of: 'brief', 'detailed'",
      );
    }
  }
  const stats: any = {
    committed_size_bytes: 0,
    resident_size_bytes: 0,
    used_size_bytes: 0,
    space_statistics: [],
    type_names: [],
    detail_level: detail,
  };
  return stats;
}

// `setHeapSnapshotNearHeapLimit(limit)` tells V8 how many snapshots to write
// as the heap limit approaches. Nothing approaches a limit here, so the limit
// is validated and remembered and no snapshot is ever written.
const __v8SnapshotLimit: any = { limit: 0 };

function __v8SetHeapSnapshotNearHeapLimit(limit: any): void {
  __v8SnapshotLimit.limit = __v8ValidateUint32(limit, "limit");
}

// ===========================================================================
// Heap snapshots
// ===========================================================================

// A well-formed `.heapsnapshot` with an empty graph. The `meta` block is the
// schema a consumer (Chrome DevTools, `heapsnapshot-parser`) needs in order to
// read the arrays; the arrays are empty because this runtime exposes no heap
// graph to walk. An empty-but-valid snapshot is the same answer the zeros in
// `getHeapStatistics` are, in a different format.
function __v8EmptyHeapSnapshot(): string {
  const meta: any = {
    node_fields: [
      "type", "name", "id", "self_size", "edge_count", "trace_node_id",
      "detachedness",
    ],
    node_types: [
      [
        "hidden", "array", "string", "object", "code", "closure", "regexp",
        "number", "native", "synthetic", "concatenated string",
        "sliced string", "symbol", "bigint", "object shape",
      ],
      "string", "number", "number", "number", "number", "number",
    ],
    edge_fields: ["type", "name_or_index", "to_node"],
    edge_types: [
      [
        "context", "element", "property", "internal", "hidden", "shortcut",
        "weak",
      ],
      "string_or_number", "node",
    ],
    trace_function_info_fields: [
      "function_id", "name", "script_name", "script_id", "line", "column",
    ],
    trace_node_fields: ["id", "function_info_index", "count", "size", "children"],
    sample_fields: ["timestamp_us", "last_assigned_id"],
    location_fields: ["object_index", "script_id", "line", "column"],
  };
  return JSON.stringify({
    snapshot: {
      meta: meta,
      node_count: 0,
      edge_count: 0,
      trace_function_count: 0,
    },
    nodes: [],
    edges: [],
    trace_function_infos: [],
    trace_tree: [],
    samples: [],
    locations: [],
    strings: [],
  });
}

// `getHeapSnapshot([options])` answers a `Readable` of the snapshot JSON.
// Node's options are `{ exposeInternals, exposeNumericValues }`; neither can
// change an empty graph, so they are validated and ignored.
function __v8GetHeapSnapshot(options?: any): any {
  if (options !== undefined && options !== null) {
    if (typeof options !== "object") {
      throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
    }
  }
  const stream: any = new Readable({ read(): void {} });
  stream.push(__v8EmptyHeapSnapshot());
  stream.push(null);
  return stream;
}

// `writeHeapSnapshot([filename][,options])` needs two things this module does
// not have: a heap graph (see above) and `fs`, which is a native extension
// here and is not in a `node:v8` bundle. Throwing names both; returning a
// path to a file that was never written would be worse.
function __v8WriteHeapSnapshot(filename?: any, options?: any): string {
  if (filename !== undefined && filename !== null && typeof filename !== "string") {
    throw new ERR_INVALID_ARG_TYPE("path", "string", filename);
  }
  throw new Error(
    "v8.writeHeapSnapshot() is not available in zun-node: it needs a heap " +
      "graph, which this runtime does not expose, and `fs`, which is a " +
      "native extension that a node:v8 bundle does not load. " +
      "v8.getHeapSnapshot() answers the (empty) snapshot as a stream.",
  );
}

// `queryObjects(ctor[, options])` counts the live objects whose prototype
// chain passes through `ctor.prototype`. The validation is Node's; the count
// itself needs a heap walk, and answering `0` while instances exist would be
// a false negative rather than an empty one, so the reason is thrown.
function __v8QueryObjects(ctor: any, options?: any): any {
  if (typeof ctor !== "function") {
    throw new ERR_INVALID_ARG_TYPE("constructor", "Function", ctor);
  }
  let format: string = "count";
  if (options !== undefined) {
    if (options === null || typeof options !== "object") {
      throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
    }
    if (options.format !== undefined) {
      format = String(options.format);
      if (format !== "count" && format !== "summary") {
        throw new ERR_INVALID_ARG_VALUE(
          "options.format",
          options.format,
          "must be one of: 'count', 'summary'",
        );
      }
    }
  }
  process.emitWarning(
    "v8.queryObjects() is an experimental feature and might change at any time",
    "ExperimentalWarning",
  );
  throw new Error(
    "v8.queryObjects() is not available in zun-node: counting live " +
      "instances needs a heap walk, and this runtime exposes no heap graph. " +
      "Returning 0 would be a wrong answer rather than an empty one.",
  );
}

// ===========================================================================
// Profilers
// ===========================================================================

// `startCpuProfile()` answers a handle whose `stop()` returns the profile as
// a `.cpuprofile` JSON string once and `undefined` on every later call.
// There is no sampling profiler here, so the profile is well-formed and
// sample-free: one `(root)` node, no samples, no deltas.
class SyncCPUProfileHandle {
  s: any;
  constructor(startedAt: number) {
    this.s = { startedAt: startedAt, stopped: false };
  }

  stop(): any {
    const state: any = this.s;
    if (state.stopped === true) return undefined;
    state.stopped = true;
    return JSON.stringify({
      nodes: [
        {
          id: 1,
          callFrame: {
            functionName: "(root)",
            scriptId: "0",
            url: "",
            lineNumber: -1,
            columnNumber: -1,
          },
          hitCount: 0,
          children: [],
        },
      ],
      startTime: Number(state.startedAt),
      endTime: __v8NowMicros(),
      samples: [],
      timeDeltas: [],
    });
  }
}

// Microseconds, which is the unit a `.cpuprofile` and a GC profile use.
// `process.hrtime` is the clock `src/process/process.ts` already answers.
function __v8NowMicros(): number {
  const parts: any[] = process.hrtime();
  return Number(parts[0]) * 1000000 + Math.floor(Number(parts[1]) / 1000);
}

function __v8StartCpuProfile(): any {
  return new SyncCPUProfileHandle(__v8NowMicros());
}

// `GCProfiler`. `start()` arms it, `stop()` answers the profile and disarms
// it, a second `stop()` answers `undefined`. The statistics list is empty
// because this runtime emits no GC events — `test-v8-collect-gc-profile.js`
// asserts entries and is listed as a gap in ../../test/v8/README.md.
class GCProfiler {
  s: any;
  constructor() {
    this.s = { running: false, startTime: 0 };
  }

  start(): void {
    const state: any = this.s;
    if (state.running === true) return;
    state.running = true;
    state.startTime = __v8NowMicros();
  }

  stop(): any {
    const state: any = this.s;
    if (state.running !== true) return undefined;
    state.running = false;
    return {
      version: 1,
      startTime: Number(state.startTime),
      endTime: __v8NowMicros(),
      statistics: [],
    };
  }
}

// `takeCoverage()` / `stopCoverage()`. Node's come from the inspector
// profiler and write to `NODE_V8_COVERAGE`; with no inspector and no
// coverage collection running, Node's own behaviour is a no-op too — which is
// precisely what `test-v8-take-coverage-noop.js` asserts of a process started
// without `NODE_V8_COVERAGE`. There is no inspector here at all, so both are
// always that no-op.
function __v8TakeCoverage(): void {}

function __v8StopCoverage(): void {}

// ===========================================================================
// promiseHooks
// ===========================================================================
//
// `v8.promiseHooks` installs V8-level `init`/`before`/`after`/`settled`
// callbacks on every promise. There is no such hook point in this engine, and
// a `createHook` that returned a stop function while never firing would make
// a consumer believe it was observing promises. Each entry therefore throws
// with the reason named.

function __v8PromiseHookUnavailable(): any {
  throw new Error(
    "v8.promiseHooks is not available in zun-node: the engine exposes no " +
      "promise lifecycle hook point, and a hook that never fires would be " +
      "worse than none.",
  );
}

const __node_v8_promise_hooks: any = {
  onInit(): any {
    return __v8PromiseHookUnavailable();
  },
  onBefore(): any {
    return __v8PromiseHookUnavailable();
  },
  onAfter(): any {
    return __v8PromiseHookUnavailable();
  },
  onSettled(): any {
    return __v8PromiseHookUnavailable();
  },
  createHook(): any {
    return __v8PromiseHookUnavailable();
  },
};

// ===========================================================================
// startupSnapshot
// ===========================================================================
//
// `lib/internal/v8/startup_snapshot.js`. The whole namespace is only usable
// while `node --build-snapshot` is building one; outside that,
// `isBuildingSnapshot()` is `false` and the three registration functions
// throw `ERR_NOT_BUILDING_SNAPSHOT`. zun-node never builds a snapshot, so
// that outside branch is the only one — which is exactly what
// `test-v8-startup-snapshot-api.js` asserts.

class ERR_NOT_BUILDING_SNAPSHOT extends NodeError {
  constructor() {
    super(
      "ERR_NOT_BUILDING_SNAPSHOT",
      "Operation not supported when not building startup snapshot",
    );
  }
}

function __v8NotBuildingSnapshot(): any {
  throw new ERR_NOT_BUILDING_SNAPSHOT();
}

const __node_v8_startup_snapshot: any = {
  isBuildingSnapshot(): boolean {
    return false;
  },
  addSerializeCallback(): any {
    return __v8NotBuildingSnapshot();
  },
  addDeserializeCallback(): any {
    return __v8NotBuildingSnapshot();
  },
  setDeserializeMainFunction(): any {
    return __v8NotBuildingSnapshot();
  },
};

// ===========================================================================
// The module object
// ===========================================================================
//
// Object-literal methods delegating to the top-level `__v8*` functions, for
// the reason in the header: a bare function value does not survive every path
// through `any` (zun#17) while a method does. The five classes are carried as
// values so that `v8.Serializer` and friends read back, and the bundler's
// canonical-binding column keeps the same names bound to the classes
// themselves, which is what `new v8.DefaultSerializer()` needs.

const __node_v8: any = {
  Serializer: Serializer,
  Deserializer: Deserializer,
  DefaultSerializer: DefaultSerializer,
  DefaultDeserializer: DefaultDeserializer,
  GCProfiler: GCProfiler,

  serialize(value: any): Buffer {
    return __v8Serialize(value);
  },
  deserialize(buffer: any): any {
    return __v8Deserialize(buffer);
  },

  cachedDataVersionTag(): number {
    return __v8CachedDataVersionTag();
  },
  setFlagsFromString(flags: any): void {
    __v8SetFlagsFromString(flags);
  },
  isStringOneByteRepresentation(content: any): boolean {
    return __v8IsStringOneByteRepresentation(content);
  },

  getHeapStatistics(): any {
    return __v8GetHeapStatistics();
  },
  getHeapSpaceStatistics(): any[] {
    return __v8GetHeapSpaceStatistics();
  },
  getHeapCodeStatistics(): any {
    return __v8GetHeapCodeStatistics();
  },
  getCppHeapStatistics(detailLevel?: any): any {
    return __v8GetCppHeapStatistics(detailLevel);
  },
  setHeapSnapshotNearHeapLimit(limit: any): void {
    __v8SetHeapSnapshotNearHeapLimit(limit);
  },

  getHeapSnapshot(options?: any): any {
    return __v8GetHeapSnapshot(options);
  },
  writeHeapSnapshot(filename?: any, options?: any): string {
    return __v8WriteHeapSnapshot(filename, options);
  },
  queryObjects(ctor: any, options?: any): any {
    return __v8QueryObjects(ctor, options);
  },

  startCpuProfile(): any {
    return __v8StartCpuProfile();
  },
  takeCoverage(): void {
    __v8TakeCoverage();
  },
  stopCoverage(): void {
    __v8StopCoverage();
  },

  promiseHooks: __node_v8_promise_hooks,
  startupSnapshot: __node_v8_startup_snapshot,
};

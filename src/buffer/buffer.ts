// node:buffer — the module surface around the engine's global `Buffer`, in Zun
// TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-buffer*.js` files (see
// ../../test/buffer/). The module shaping follows Node's `lib/buffer.js` (MIT,
// Copyright Joyent, Inc. and other Node contributors) — the `constants` object,
// the `INSPECT_MAX_BYTES` accessor, the `atob`/`btoa` status codes, the
// `isUtf8`/`isAscii` argument contract and the `transcode` normalization — and
// `lib/internal/blob.js` for `Blob`. `normalizeEncoding`'s alias table comes
// from `lib/internal/util.js`.
//
// ---------------------------------------------------------------------------
// Why this module is thin, and what it deliberately does NOT do
// ---------------------------------------------------------------------------
//
// `Buffer` is not a zun-node class. It is a **realm global of the engine**: a
// nominal alias for the `Uint8Array` byte-view floor, with its statics
// recognized by receiver name in the checker and its instance methods lowered
// to the `nodeBuffer` intrinsic group (NUCLEUS #21,
// `crates/zun_natives/src/node_buffer.rs`). Node's own `buffer.Buffer` and
// `globalThis.Buffer` are the same object, so the rule here is the same rule
// `events` follows for `EventEmitter`: **the module never introduces a second
// Buffer.** `require('buffer').Buffer` resolves to the engine global through
// the bundler's canonical binding (`tools/bundle_node_test.sh`), and the
// object below carries that same value under `Buffer` so a `buffer.Buffer`
// member read answers it too.
//
// The consequence is that everything the engine's `Buffer` is missing —
// `compare`, `toJSON`, `entries`/`keys`/`values`, `allocUnsafeSlow`,
// `isEncoding`, `of`, `poolSize`, the `buffer`/`byteOffset`/`parent`
// properties, a `RangeError`-shaped out-of-bounds, `alloc(size, fill,
// encoding)`, `write(string, offset, length, encoding)` — cannot be added from
// here. A missing method on a `BufferView(U8)` receiver is a **compile error**
// in the checker ("type BufferView(U8) has no methods"), not a missing
// property, so there is no prototype to extend and no `any` lane to route
// around it: a byte view read through `any` is completely opaque in this engine
// (`buf.length` answers `undefined`). Those are engine gaps, each reduced to a
// minimal repro in ../../test/buffer/README.md. What *is* implementable here is
// exactly the module surface — the constants, the encoders, the scanners, the
// transcoder and `Blob`/`File` — and that is what this file is.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `x as u64` / `x as u8` on every Buffer size, offset and fill byte: the
//     `nodeBuffer` intrinsics take machine integers, and the checker rejects a
//     `number` there outright ("Buffer size must be an integer", zun#3). The
//     cast is the only coercion that lands, and it is *unchecked* — a negative
//     size wraps and panics the interpreter (see `__bufValidateSize`, which is
//     therefore not optional).
//   * `Number(x.length)` throughout: `.length` is typed `u64`, so it can be
//     neither assigned to nor passed as a `number` (zun#3).
//   * `__bufCc(s, i)` instead of `s.charCodeAt(i)` past the end: a
//     `charCodeAt` out of range throws rather than answering `NaN` (zun#2).
//   * the module's functions are **object-literal methods** delegating to
//     top-level `__buf*` functions, because a bare function value does not
//     survive every path through `any` (zun#17), while a method does.
//   * `INSPECT_MAX_BYTES` is a plain data property, not the accessor pair Node
//     defines: there is no `Object.defineProperty` getter/setter on a dynamic
//     object in this engine, so the `validateNumber` Node runs on assignment
//     cannot run anywhere. Reading and writing it works, which is what every
//     consumer does; the rejected-assignment half is noted in
//     ../../test/buffer/README.md rather than written here unreachable.
//   * `Blob`'s async surface returns `Promise.resolve(...)` of an
//     already-materialized value rather than a real stream: `node:stream` does
//     not exist here yet, so `blob.stream()` is absent rather than faked.
//
// One Node 25 removal to note, because it is the opposite of a gap: there is no
// `SlowBuffer` export. Node removed the deprecated `SlowBuffer` (DEP0030) in
// v25 — `lib/buffer.js`'s `module.exports` no longer lists it, and
// `test/parallel/test-buffer-slow.js` at v25.0.0 tests
// `Buffer.allocUnsafeSlow` instead. Exporting one here would be inventing API
// the oracle does not have.

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

// `buffer.kMaxLength` / `constants.MAX_LENGTH`. Node reads this from
// `internalBinding('buffer')`, where it is `2 ** 53 - 1` on a 64-bit pointer
// (and `2 ** 31 - 1` on a 32-bit one). The Zun engine is 64-bit only, so the
// 64-bit row is the whole table.
const __BUF_MAX_LENGTH: number = 9007199254740991;

// `buffer.kStringMaxLength` / `constants.MAX_STRING_LENGTH`: V8's
// `String::kMaxLength`, `(1 << 29) - 24` on a 64-bit build.
const __BUF_MAX_STRING_LENGTH: number = 536870888;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// The `ERR_*` classes live in `src/events/events.ts` (bundled ahead of this
// file) because that is where the `NodeTypeError`/`NodeRangeError` carriers
// with a **declared** `code` field live; writing `code` onto a plain
// `TypeError` through an `any` alias poisons the instance (zun#37).
//
// `atob`/`btoa` are the exception: they throw a `DOMException`, not a Node
// error. `DOMException` is not an engine global, so the one shape the corpus
// observes — `name === 'InvalidCharacterError'` with a message — is declared
// here. `name` is a virtual getter on `Error` in this engine, so a subclass
// overriding it is the supported spelling (NUCLEUS #22).
class __BufDOMException extends Error {
  get name(): string {
    return "InvalidCharacterError";
  }
}

// `ERR_UNKNOWN_ENCODING` is not in `src/events/events.ts`' error set, because
// nothing before `buffer` raised it. It is declared here rather than there so
// the shared file stays untouched; `src/string_decoder/string_decoder.ts`
// reaches it because the bundler inlines this file ahead of it (see
// `CONDITIONAL_FILES` in `tools/bundle_node_test.sh`).
class ERR_UNKNOWN_ENCODING extends NodeTypeError {
  constructor(encoding: any) {
    super("ERR_UNKNOWN_ENCODING", "Unknown encoding: " + String(encoding));
  }
}

// ---------------------------------------------------------------------------
// Small helpers the engine forces
// ---------------------------------------------------------------------------

// `charCodeAt` past the end throws here instead of answering `NaN` (zun#2).
function __bufCc(s: string, i: number): number {
  return i >= 0 && i < Number(s.length) ? s.charCodeAt(i) : -1;
}

// `validateNumber(size, 'size', 0, kMaxLength)`, as every `Buffer.alloc*` in
// `lib/buffer.js` runs it. This is not a nicety: the engine's allocators take a
// machine `u64` and the `as u64` cast is unchecked, so `Buffer.alloc(-1)`
// wraps to 2^64-1 and **panics the interpreter** with a `raw_vec` capacity
// overflow. Everything in this file that allocates goes through here first.
function __bufValidateSize(size: any, name: string): number {
  if (typeof size !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", size);
  }
  const n: number = size;
  // `NaN` fails every comparison, so the range test below rejects it; Node
  // reports it as out of range rather than as a wrong type.
  if (!(n >= 0) || !(n <= __BUF_MAX_LENGTH)) {
    throw new ERR_OUT_OF_RANGE(name, ">= 0 and <= " + __BUF_MAX_LENGTH, size);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Encoding names
// ---------------------------------------------------------------------------
//
// `lib/internal/util.js`' `normalizeEncoding`: the canonical spelling of an
// encoding name, or `undefined` for one Node does not know. The alias table is
// Node's, including the `utf-8`/`utf8`, `ucs2`/`ucs-2`/`utf16le`/`utf-16le`
// and `latin1`/`binary` groups, and the case-insensitive second pass Node
// performs only after the exact-match pass fails.
function __bufNormalizeEncoding(encoding: any): string {
  if (encoding === undefined) return "utf8";
  if (typeof encoding !== "string") return "";
  const enc: string = encoding;
  if (enc === "") return "";
  const exact = __bufSlowNormalize(enc);
  if (exact !== "") return exact;
  return __bufSlowNormalize(enc.toLowerCase());
}

function __bufSlowNormalize(enc: string): string {
  if (enc === "utf8" || enc === "utf-8") return "utf8";
  if (enc === "ucs2" || enc === "ucs-2" || enc === "utf16le" || enc === "utf-16le") {
    return "utf16le";
  }
  if (enc === "latin1" || enc === "binary") return "latin1";
  if (enc === "base64") return "base64";
  if (enc === "base64url") return "base64url";
  if (enc === "hex") return "hex";
  if (enc === "ascii") return "ascii";
  return "";
}

// ---------------------------------------------------------------------------
// base64: `btoa` / `atob`
// ---------------------------------------------------------------------------
//
// The engine has global `atob`/`btoa`, but they are lenient where Node's are
// strict: `atob('a')` answers `''` instead of throwing, and `btoa('Ā')`
// answers `'AA=='` instead of throwing. Node's are the oracle, and Node's are
// specified by WHATWG "forgiving-base64", so they are written out here. The
// status values Node's `lib/buffer.js` switches on (-1 single trailing
// character, -2 invalid character) are the two failures this reproduces.

const __BUF_B64_ALPHABET: string =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// `btoa(input)`: every code point must fit in one byte; the bytes are then
// standard-alphabet base64 with `=` padding.
function __bufBtoa(input: any): string {
  const s: string = String(input);
  const len = Number(s.length);
  let out = "";
  let i = 0;
  while (i < len) {
    const c0 = __bufCc(s, i);
    const c1 = i + 1 < len ? __bufCc(s, i + 1) : -1;
    const c2 = i + 2 < len ? __bufCc(s, i + 2) : -1;
    if (c0 > 255 || c1 > 255 || c2 > 255) {
      throw new __BufDOMException("Invalid character");
    }
    const b0 = c0;
    const b1 = c1 === -1 ? 0 : c1;
    const b2 = c2 === -1 ? 0 : c2;
    out = out + __BUF_B64_ALPHABET.charAt((b0 >> 2) & 63);
    out = out + __BUF_B64_ALPHABET.charAt(((b0 << 4) | (b1 >> 4)) & 63);
    out = out + (c1 === -1 ? "=" : __BUF_B64_ALPHABET.charAt(((b1 << 2) | (b2 >> 6)) & 63));
    out = out + (c2 === -1 ? "=" : __BUF_B64_ALPHABET.charAt(b2 & 63));
    i = i + 3;
  }
  return out;
}

// The value of one base64 character, or -1. The `+`/`/` pair only; `atob` is
// not the URL-safe decoder.
function __bufB64Value(code: number): number {
  if (code >= 65 && code <= 90) return code - 65; // A-Z
  if (code >= 97 && code <= 122) return code - 97 + 26; // a-z
  if (code >= 48 && code <= 57) return code - 48 + 52; // 0-9
  if (code === 43) return 62; // +
  if (code === 47) return 63; // /
  return -1;
}

// `atob(input)`: base64 decode with Node's two failures — its `-2` ("Invalid
// character") and its `-1` ("The string to be decoded is not correctly
// encoded"). ASCII whitespace is stripped first, as WHATWG forgiving-base64
// requires.
//
// Which failure a given input gets is **Node's** split, not the plain WHATWG
// one, and it is observable: `atob('a')` is the `-1` case while `atob('YQ=')`
// and `atob('aGVsbG8==')` are the `-2` case. The padding rule that produces
// that split is "the `=` run must bring the data length up to a multiple of
// four, and there can be at most two of them":
//
//     'YQ=='      data 2, pad 2 -> 2 + 2 == 4   decodes to 'a'
//     'YQ='       data 2, pad 1 -> 2 + 1 != 4   Invalid character
//     'aGVsbG8==' data 7, pad 2 -> 3 + 2 != 4   Invalid character
//     '===='      pad 4 > 2                     Invalid character
//     'a'         no pad, length % 4 == 1       not correctly encoded
function __bufAtob(input: any): string {
  const raw: string = String(input);
  let s = "";
  const rawLen = Number(raw.length);
  for (let i = 0; i < rawLen; i++) {
    const c = __bufCc(raw, i);
    // ASCII whitespace: tab, LF, FF, CR, space.
    if (c === 9 || c === 10 || c === 12 || c === 13 || c === 32) continue;
    s = s + raw.charAt(i);
  }
  const total = Number(s.length);
  let len = total;
  let pad = 0;
  while (len > 0 && __bufCc(s, len - 1) === 61) {
    len = len - 1;
    pad = pad + 1;
  }
  if (pad > 2) {
    throw new __BufDOMException("Invalid character");
  }
  if (pad > 0 && (len % 4) + pad !== 4) {
    throw new __BufDOMException("Invalid character");
  }
  if (pad === 0 && total % 4 === 1) {
    throw new __BufDOMException("The string to be decoded is not correctly encoded.");
  }
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    const v = __bufB64Value(__bufCc(s, i));
    if (v < 0) {
      throw new __BufDOMException("Invalid character");
    }
    acc = (acc << 6) | v;
    bits = bits + 6;
    if (bits >= 8) {
      bits = bits - 8;
      out = out + String.fromCharCode((acc >> bits) & 255);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// `isUtf8` / `isAscii`
// ---------------------------------------------------------------------------
//
// Node's are `simdutf::validate_utf8` / `validate_ascii` over the view's
// bytes. Byte scans, so they are plain TypeScript here. The argument contract
// is Node's: a TypedArray or an ArrayBuffer, anything else is
// `ERR_INVALID_ARG_TYPE`.
//
// The `input` parameter is `any` and is funnelled into a `Buffer`-typed
// function, because a byte view read *through* `any` is opaque in this engine
// while the same value passed *into* a typed parameter is not.

function __bufIsUtf8(input: any): boolean {
  if (!ArrayBuffer.isView(input)) {
    throw new ERR_INVALID_ARG_TYPE("input", ["ArrayBuffer", "Buffer", "TypedArray"], input);
  }
  return __bufScanUtf8(input);
}

function __bufScanUtf8(bytes: Buffer): boolean {
  const n = Number(bytes.length);
  let i = 0;
  while (i < n) {
    // `bytes[i]` is typed `u8`; an `Int(u8)` can be neither assigned to a
    // `number` nor mixed with one in a bitwise expression (zun#3), so every
    // byte read here is widened on the spot.
    const b: number = Number(bytes[i]);
    if (b <= 0x7f) {
      i = i + 1;
      continue;
    }
    let need = 0;
    let min = 0;
    let cp = 0;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
      cp = b & 0x0f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
      cp = b & 0x07;
    } else {
      // 0x80..0xC1 (stray continuation or overlong two-byte head) and
      // 0xF5..0xFF (beyond U+10FFFF) are never valid lead bytes.
      return false;
    }
    // The continuation bytes are `i + 1 .. i + need`, so the sequence is
    // truncated unless `i + need` is still an index.
    if (i + need >= n) return false;
    for (let k = 1; k <= need; k++) {
      const c: number = Number(bytes[i + k]);
      if ((c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min) return false;
    if (cp > 0x10ffff) return false;
    // Surrogate halves are not scalar values.
    if (cp >= 0xd800 && cp <= 0xdfff) return false;
    i = i + need + 1;
  }
  return true;
}

function __bufIsAscii(input: any): boolean {
  if (!ArrayBuffer.isView(input)) {
    throw new ERR_INVALID_ARG_TYPE("input", ["ArrayBuffer", "Buffer", "TypedArray"], input);
  }
  return __bufScanAscii(input);
}

function __bufScanAscii(bytes: Buffer): boolean {
  const n = Number(bytes.length);
  for (let i = 0; i < n; i++) {
    if (Number(bytes[i]) > 0x7f) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// `transcode`
// ---------------------------------------------------------------------------
//
// Node's goes through ICU; here it is a decode in `fromEncoding` followed by an
// encode in `toEncoding`, which is the same function for every pair the
// engine's codec table covers. The normalization and the empty-input shortcut
// are Node's.
function __bufTranscode(source: any, fromEncoding: any, toEncoding: any): any {
  if (!ArrayBuffer.isView(source)) {
    throw new ERR_INVALID_ARG_TYPE("source", ["Buffer", "Uint8Array"], source);
  }
  const from = __bufNormalizeEncoding(fromEncoding);
  const to = __bufNormalizeEncoding(toEncoding);
  if (from === "" || to === "") {
    throw new ERR_UNKNOWN_ENCODING(from === "" ? fromEncoding : toEncoding);
  }
  return __bufTranscodeView(source, from, to);
}

function __bufTranscodeView(source: Buffer, from: string, to: string): Buffer {
  const n = Number(source.length);
  if (n === 0) return Buffer.alloc(0);
  return Buffer.from(source.toString(from, 0, source.length), to);
}

// ---------------------------------------------------------------------------
// `Blob` and `File`
// ---------------------------------------------------------------------------
//
// `lib/internal/blob.js` / `lib/internal/file.js`, reduced to the synchronous
// core: the parts that need `node:stream` (`stream()`) or a real object-URL
// registry (`URL.createObjectURL`) are absent rather than faked, and
// `resolveObjectURL` therefore always answers `undefined` — which is also what
// Node answers for an id that was never registered.
//
// `type` is normalized the way the spec requires: a value containing a code
// point outside U+0020..U+007E is dropped, and the rest is lowercased.

function __bufNormalizeBlobType(type: any): string {
  if (type === undefined) return "";
  const s: string = String(type);
  const n = Number(s.length);
  for (let i = 0; i < n; i++) {
    const c = __bufCc(s, i);
    if (c < 0x20 || c > 0x7e) return "";
  }
  return s.toLowerCase();
}

// Flatten a `BlobPart[]` into one Buffer. A part is a string (UTF-8 encoded), a
// byte view, or anything else (stringified), exactly as the spec's
// "process blob parts" does for the subset reachable here.
function __bufBlobBytes(sources: any): Buffer {
  if (sources === undefined) return Buffer.alloc(0);
  if (!Array.isArray(sources)) {
    throw new ERR_INVALID_ARG_TYPE("sources", "Iterable", sources);
  }
  const parts: any[] = [];
  for (const part of sources) {
    if (typeof part === "string") {
      parts.push(Buffer.from(part, "utf8"));
    } else if (ArrayBuffer.isView(part)) {
      parts.push(__bufCopyOf(part));
    } else {
      parts.push(Buffer.from(String(part), "utf8"));
    }
  }
  return Buffer.concat(parts);
}

// Every allocation in this file goes through here, so that
// `__bufValidateSize`'s range check stands between a computed length and the
// unchecked `as u64` cast (`Buffer.alloc(-1 as u64)` panics the interpreter —
// see ../../test/buffer/README.md). The sizes below are all derived from a
// view's own length and so always in range; the guard is what makes that a
// fact rather than an assumption.
function __bufAlloc(size: number, name: string): Buffer {
  const n = __bufValidateSize(size, name);
  return Buffer.alloc(n as u64);
}

// A Buffer holding a fresh copy of a view's bytes. `Buffer.from(buffer)` — the
// copying overload — is not in this engine (`Buffer.from` takes a string, an
// array or an ArrayBuffer), so the copy is spelled out.
function __bufCopyOf(view: Buffer): Buffer {
  const n = Number(view.length);
  const out = __bufAlloc(n, "length");
  view.copy(out, 0, 0, n);
  return out;
}

class Blob {
  // The whole blob, materialized. Node keeps a list of handles and reads them
  // lazily; there is no file-backed blob here, so one Buffer is the same thing.
  __bytes: Buffer = Buffer.alloc(0);
  __type: string = "";

  constructor(sources: any, options?: any) {
    this.__bytes = __bufBlobBytes(sources);
    this.__type = __bufNormalizeBlobType(
      options === undefined || options === null ? undefined : options.type,
    );
  }

  get size(): number {
    return Number(this.__bytes.length);
  }

  get type(): string {
    return this.__type;
  }

  slice(start?: any, end?: any, contentType?: any): any {
    const n = Number(this.__bytes.length);
    let from = start === undefined ? 0 : Number(start);
    let to = end === undefined ? n : Number(end);
    if (from < 0) from = n + from < 0 ? 0 : n + from;
    if (from > n) from = n;
    if (to < 0) to = n + to < 0 ? 0 : n + to;
    if (to > n) to = n;
    if (to < from) to = from;
    const out = new Blob([], undefined);
    out.__bytes = __bufSliceCopy(this.__bytes, from, to);
    out.__type = __bufNormalizeBlobType(contentType);
    return out;
  }

  bytes(): any {
    return Promise.resolve(__bufCopyOf(this.__bytes));
  }

  arrayBuffer(): any {
    return Promise.resolve(__bufCopyOf(this.__bytes).buffer());
  }

  text(): any {
    const n = this.__bytes.length;
    return Promise.resolve(this.__bytes.toString("utf8", 0, n));
  }
}

function __bufSliceCopy(view: Buffer, from: number, to: number): Buffer {
  const len = to - from;
  const out = __bufAlloc(len, "length");
  if (len > 0) view.copy(out, 0, from, to);
  return out;
}

// `File` is a `Blob` with a name and a modification time. `extends Blob` is a
// local class extending a local class, which the engine supports (zun#21 is
// about `extends ns.Base`, a member expression, which this is not).
class File extends Blob {
  __name: string = "";
  __lastModified: number = 0;

  constructor(sources: any, fileName: any, options?: any) {
    super(sources, options);
    if (fileName === undefined) {
      throw new ERR_INVALID_ARG_TYPE("fileName", "string", fileName);
    }
    this.__name = String(fileName);
    const lm =
      options === undefined || options === null ? undefined : options.lastModified;
    this.__lastModified = lm === undefined ? Date.now() : Number(lm);
  }

  get name(): string {
    return this.__name;
  }

  get lastModified(): number {
    return this.__lastModified;
  }
}

// `buffer.resolveObjectURL(id)`. There is no `URL.createObjectURL` registry in
// this engine, so every id is an unregistered one — for which Node also
// answers `undefined`. Node validates nothing here: `lib/internal/blob.js`
// stringifies the argument and answers `undefined` for anything it cannot
// resolve, so `resolveObjectURL(1)` is `undefined` rather than a throw.
function __bufResolveObjectURL(id: any): any {
  // Node's coercion, kept because it is observable for an argument with a
  // throwing `toString`; the string itself has nothing to resolve against.
  String(id);
  return undefined;
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------
//
// `Buffer` is the engine's realm global, carried here as a value so a
// `buffer.Buffer` member read answers it. A *call* through that value
// (`buffer.Buffer.from(...)`) does not reach the statics, which the checker
// resolves by receiver name — which is why `tools/bundle_node_test.sh` lists
// `Buffer` as this module's canonical binding and leaves the name bound to the
// global instead of to this property.
const __bufGlobalBuffer: any = Buffer;

const __node_buffer: any = {
  Buffer: __bufGlobalBuffer,

  // Legacy aliases of `constants.*`, as Node still exports them.
  kMaxLength: __BUF_MAX_LENGTH,
  kStringMaxLength: __BUF_MAX_STRING_LENGTH,

  constants: {
    MAX_LENGTH: __BUF_MAX_LENGTH,
    MAX_STRING_LENGTH: __BUF_MAX_STRING_LENGTH,
  },

  // Node defines this as an accessor pair on `module.exports` whose setter runs
  // `validateNumber`, so `buffer.INSPECT_MAX_BYTES = 'foo'` throws. There is no
  // getter/setter on a dynamic object in this engine, so it is a plain data
  // property: reading and writing it work, which is what every consumer does,
  // and the rejected-assignment half is an engine gap rather than a validation
  // written here and never reached. See ../../test/buffer/README.md.
  INSPECT_MAX_BYTES: 50,

  atob(input: any): string {
    return __bufAtob(input);
  },
  btoa(input: any): string {
    return __bufBtoa(input);
  },
  isUtf8(input: any): boolean {
    return __bufIsUtf8(input);
  },
  isAscii(input: any): boolean {
    return __bufIsAscii(input);
  },
  transcode(source: any, fromEncoding: any, toEncoding: any): any {
    return __bufTranscode(source, fromEncoding, toEncoding);
  },
  resolveObjectURL(id: any): any {
    return __bufResolveObjectURL(id);
  },

  Blob: Blob,
  File: File,
};

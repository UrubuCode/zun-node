// node:buffer — the module surface around the engine's global `Buffer`, in Zun
// TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-buffer*.js` files (see
// ../../test/buffer/). The module shaping follows Node's `lib/buffer.js` (MIT,
// Copyright Joyent, Inc. and other Node contributors) — the `constants` object,
// the `INSPECT_MAX_BYTES` accessor, the `atob`/`btoa` status codes, the
// `isUtf8`/`isAscii` argument contract and the full ICU matrix `transcode`
// reproduces — and `lib/internal/blob.js` for `Blob`. `normalizeEncoding`'s
// alias table comes from `lib/internal/util.js`. The inspected form of a byte
// view belongs to `lib/buffer.js` too, and lives in `src/util/util.ts`
// (`__utilFormatByteView`), because `util` is inlined into every bundle while
// this file is conditional.
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
// (`buf.length` answers `undefined`, and no method on it resolves). Those are
// engine gaps, each reduced to a minimal repro in ../../test/buffer/README.md,
// which also records why declaring a `class Buffer` here — the one escape hatch
// the checker leaves open — is not the answer. What *is* implementable is
// exactly the module surface: the constants, the encoders, the scanners, the
// transcoder, the inspected form and `Blob`/`File`.
//
// Two facts about a value *do* survive the `any` boundary, and this file leans
// on both: `Buffer.isBuffer` (true for a `U8` byte view and nothing else — not
// a `Uint16Array`, not a `DataView`, not a plain object) and
// `ArrayBuffer.isView`. They let the module recognise a byte view it cannot
// read; the bytes themselves come from passing the same value *into* a
// `Buffer`-typed parameter.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `x as u64` / `x as u8` on every Buffer size, offset and fill byte: the
//     `nodeBuffer` intrinsics take machine integers, and the checker rejects a
//     `number` there outright ("Buffer size must be an integer", zun#3). The
//     cast is the only coercion that lands, and it is *unchecked* — a negative
//     size wraps and **panics the interpreter** with a `raw_vec` capacity
//     overflow. Nothing here hands an allocator a size that did not come from a
//     byte sequence this file already holds: the only `Buffer.alloc` left takes
//     the literal `0`, and every other allocation goes through
//     `Buffer.from(<string | array>)`, which derives its own length.
//   * `Number(x.length)` throughout: `.length` is typed `u64`, so it can be
//     neither assigned to nor passed as a `number` (zun#3).
//   * `__bufCc(s, i)` instead of `s.charCodeAt(i)` past the end: a
//     `charCodeAt` out of range throws rather than answering `NaN` (zun#2).
//   * the module's functions are **object-literal methods** delegating to
//     top-level `__buf*` functions, because a bare function value does not
//     survive every path through `any` (zun#17), while a method does.
//   * `INSPECT_MAX_BYTES` is the accessor pair Node defines, spelled as
//     `get`/`set` members of the module's object literal (the engine supports
//     those) rather than through `Object.defineProperties`. The number it
//     guards lives in `src/util/util.ts`, because the inspector that reads it
//     is there and `util` is inlined into every bundle while this file is
//     conditional.
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

// Two divergences live here, both because a value held in an `any` does not
// report its class in this engine (zun#38) — neither can be fixed from the
// library side, and neither is reachable from Node's own `buffer` corpus:
//
//   * Node accepts an `ArrayBuffer`/`SharedArrayBuffer` as well as a view.
//     Through `any` an `ArrayBuffer` is indistinguishable from `{}`
//     (`ArrayBuffer.isView` is false, `Object.prototype.toString` answers
//     `[object Object]`), so accepting one would mean accepting every object.
//     It is rejected with Node's `ERR_INVALID_ARG_TYPE` instead.
//   * Node rejects a `DataView` and accepts every *typed* array, validating the
//     view's bytes. `ArrayBuffer.isView` is true for both and nothing separates
//     them, while reading a `DataView` through the typed-array accessors is an
//     **uncatchable** engine error ("call did not resolve to a method"). So
//     only a `U8` view — which `Buffer.isBuffer` does recognise — is scanned,
//     and any other view is reported as the wrong type. That is Node's answer
//     for a `DataView` and a divergence for a `Uint16Array`.
//
// Node also throws `ERR_INVALID_STATE` for a detached `ArrayBuffer`; there is
// no way to detach one here (`structuredClone` takes a single argument), and no
// way to observe detachment if there were.
function __bufIsUtf8(input: any): boolean {
  __bufValidateScanInput(input);
  return __bufScanUtf8(input);
}

function __bufValidateScanInput(input: any): void {
  if (!Buffer.isBuffer(input)) {
    throw new ERR_INVALID_ARG_TYPE("input", ["ArrayBuffer", "Buffer", "TypedArray"], input);
  }
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
  __bufValidateScanInput(input);
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
// Node's `transcode` is ICU, reached through `internalBinding('icu')`, and ICU
// is not a decode-then-encode over the engine's codec table: it has four
// encodings (`ascii`, `latin1`, `utf8`, `ucs2` and their aliases — `hex`,
// `base64` and `base64url` are *not* ICU charsets and are rejected), it
// substitutes rather than guesses, and `node_i18n.cc` routes six of the sixteen
// pairs through specialized converters instead of the generic one. The whole
// matrix was read off `node` — 4 source encodings x 4 target encodings x 34 byte
// sequences, 544 cases, and this file reproduces it exactly:
//
//   * **generic**, `{ascii,latin1,utf8}` -> `{ascii,latin1,utf8}`: decode with
//     substitution (an `ascii` byte >= 0x80 and every malformed UTF-8 maximal
//     subpart become U+FFFD; `latin1` is one byte per code point), then encode
//     with substitution — a code point the single-byte target cannot hold
//     becomes `?` (0x3F), and a surrogate pair counts as **one** code point, so
//     it is one `?`.
//   * `{ascii,latin1}` -> `ucs2`: `TranscodeLatin1ToUcs2`, a plain widening of
//     every byte to a code unit. This is the one place where `ascii` does *not*
//     substitute: `transcode(<80>, 'ascii', 'ucs2')` is U+0080, while
//     `transcode(<80>, 'ascii', 'utf8')` is U+FFFD.
//   * `utf8` -> `ucs2`: `u_strFromUTF8`, which is **strict** — any malformed
//     UTF-8 (including a surrogate encoded as three bytes, and `f4 90 80 80`)
//     raises `U_INVALID_CHAR_FOUND` instead of substituting.
//   * `ucs2` -> `utf8`: `u_strToUTF8` over `byteLength / 2` code units, so a
//     trailing odd byte is dropped — but an unpaired surrogate, or an input of
//     fewer than two bytes, raises `U_INVALID_CHAR_FOUND`.
//   * `ucs2` -> `{ascii,latin1}`: `byteLength / 2` code units again, trailing
//     odd byte dropped and no error; an unpaired surrogate is unmappable, so it
//     is one `?`.
//   * `ucs2` -> `ucs2`: the generic converter, which *keeps* the trailing odd
//     byte as U+FFFD and turns an unpaired surrogate into U+FFFD.
//
// The error is Node's `genericNodeError`: a plain `Error` carrying `code` and
// `errno`, not one of the `ERR_*` classes, and an unknown encoding name reaches
// ICU verbatim (`normalizeEncoding(e) || e`) and fails there — so it is
// `U_ILLEGAL_ARGUMENT_ERROR`, never `ERR_UNKNOWN_ENCODING`.
function __bufTranscode(source: any, fromEncoding: any, toEncoding: any): any {
  // `isUint8Array(source)`: an `ArrayBuffer` and a `Uint16Array` are both
  // rejected by Node, and `Buffer.isBuffer` is the engine predicate that says
  // `U8` view and nothing else.
  if (!Buffer.isBuffer(source)) {
    throw new ERR_INVALID_ARG_TYPE("source", ["Buffer", "Uint8Array"], source);
  }
  if (__bufViewLength(source) === 0) return Buffer.alloc(0);
  const from = __bufIcuCharset(fromEncoding);
  const to = __bufIcuCharset(toEncoding);
  if (from === "" || to === "") {
    throw new __BufTranscodeError("U_ILLEGAL_ARGUMENT_ERROR", 1);
  }
  return __bufTranscodeView(source, from, to);
}

// The four charsets ICU is handed. `normalizeEncoding` maps the aliases; a name
// it does not know, and the three byte-codec names it does, are not charsets.
function __bufIcuCharset(encoding: any): string {
  const normalized = __bufNormalizeEncoding(encoding);
  if (
    normalized === "utf8" || normalized === "latin1" ||
    normalized === "ascii" || normalized === "utf16le"
  ) {
    return normalized;
  }
  return "";
}

// `genericNodeError(`Unable to transcode Buffer [${code}]`, { code, errno })`.
// A plain `Error` with two own properties — declared fields rather than
// expando writes through an `any`, which poison the instance (zun#37).
class __BufTranscodeError extends Error {
  code: string = "";
  errno: number = 0;
  constructor(code: string, errno: number) {
    super("Unable to transcode Buffer [" + code + "]");
    this.code = code;
    this.errno = errno;
  }
}

function __bufViewLength(view: Buffer): number {
  return Number(view.length);
}

function __bufTranscodeView(source: Buffer, from: string, to: string): Buffer {
  const units = __bufTranscodeDecode(source, from, to);
  return Buffer.from(__bufTranscodeEncode(units, to));
}

// Decode to UTF-16 code units. `to` is part of the signature because ICU's
// routing makes the decoder depend on the target: see the table above.
function __bufTranscodeDecode(source: Buffer, from: string, to: string): number[] {
  const n = __bufViewLength(source);
  const units: number[] = [];

  if (from === "utf16le") {
    const complete = (n - (n % 2)) / 2;
    if (to === "utf8") {
      // `u_strToUTF8`: fewer than one whole code unit, or any unpaired
      // surrogate, is `U_INVALID_CHAR_FOUND`.
      if (complete === 0) throw new __BufTranscodeError("U_INVALID_CHAR_FOUND", 10);
      for (let i = 0; i < complete; i++) {
        units.push(Number(source[i * 2]) | (Number(source[i * 2 + 1]) << 8));
      }
      if (!__bufUnitsArePaired(units)) {
        throw new __BufTranscodeError("U_INVALID_CHAR_FOUND", 10);
      }
      return units;
    }
    for (let i = 0; i < complete; i++) {
      units.push(Number(source[i * 2]) | (Number(source[i * 2 + 1]) << 8));
    }
    if (to === "utf16le") {
      // The generic converter: an unpaired surrogate and a trailing odd byte
      // both come out as U+FFFD — with one join. A *high* surrogate as the last
      // complete unit leaves the converter waiting for its low half, so a
      // trailing odd byte is absorbed into that one error rather than reported
      // as a second: `<3d d8 61>` is one U+FFFD, while `<4d dc 61>` (a low
      // surrogate) and `<61 00 62>` are two.
      const replaced: number[] = [];
      let i = 0;
      const count = Number(units.length);
      let pendingHigh = false;
      while (i < count) {
        const unit = units[i];
        pendingHigh = false;
        if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < count) {
          const next = units[i + 1];
          if (next >= 0xdc00 && next <= 0xdfff) {
            replaced.push(unit);
            replaced.push(next);
            i = i + 2;
            continue;
          }
        }
        if (unit >= 0xd800 && unit <= 0xdfff) {
          replaced.push(0xfffd);
          pendingHigh = unit <= 0xdbff && i === count - 1;
        } else {
          replaced.push(unit);
        }
        i = i + 1;
      }
      if (n % 2 === 1 && !pendingHigh) replaced.push(0xfffd);
      return replaced;
    }
    // `ucs2` -> `{ascii,latin1}`: the units are handed to the encoder as they
    // are, and an unpaired surrogate is simply unmappable there.
    return units;
  }

  if (from === "utf8") {
    if (to === "utf16le" && !__bufScanUtf8(source)) {
      // `u_strFromUTF8` is strict.
      throw new __BufTranscodeError("U_INVALID_CHAR_FOUND", 10);
    }
    // The engine's own lossy UTF-8 decode is V8's, which is the substitution
    // ICU performs: one U+FFFD per maximal subpart of an ill-formed sequence.
    const text = source.toString("utf8", 0 as u64, n as u64);
    const chars = Number(text.length);
    for (let i = 0; i < chars; i++) units.push(__bufCc(text, i));
    return units;
  }

  // `latin1`, and `ascii` when the target is `ucs2` (the widening path).
  const substitute = from === "ascii" && to !== "utf16le";
  for (let i = 0; i < n; i++) {
    const byte = Number(source[i]);
    units.push(substitute && byte > 0x7f ? 0xfffd : byte);
  }
  return units;
}

function __bufUnitsArePaired(units: number[]): boolean {
  const count = Number(units.length);
  let i = 0;
  while (i < count) {
    const unit = units[i];
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (i + 1 >= count) return false;
      const next = units[i + 1];
      if (next < 0xdc00 || next > 0xdfff) return false;
      i = i + 2;
      continue;
    }
    i = i + 1;
  }
  return true;
}

// Encode UTF-16 code units. A single-byte target substitutes `?` once per code
// *point*, so a surrogate pair is one `?` rather than two.
function __bufTranscodeEncode(units: number[], to: string): number[] {
  const out: number[] = [];
  const count = Number(units.length);

  if (to === "utf16le") {
    for (let i = 0; i < count; i++) {
      const unit = units[i];
      out.push(unit & 0xff);
      out.push((unit >> 8) & 0xff);
    }
    return out;
  }

  const max = to === "ascii" ? 0x7f : 0xff;
  let i = 0;
  while (i < count) {
    let cp = units[i];
    let width = 1;
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < count) {
      const next = units[i + 1];
      if (next >= 0xdc00 && next <= 0xdfff) {
        cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
        width = 2;
      }
    }
    i = i + width;
    if (to !== "utf8") {
      out.push(cp <= max ? cp : 0x3f);
      continue;
    }
    if (cp <= 0x7f) {
      out.push(cp);
    } else if (cp <= 0x7ff) {
      out.push(0xc0 | (cp >> 6));
      out.push(0x80 | (cp & 0x3f));
    } else if (cp <= 0xffff) {
      out.push(0xe0 | (cp >> 12));
      out.push(0x80 | ((cp >> 6) & 0x3f));
      out.push(0x80 | (cp & 0x3f));
    } else {
      out.push(0xf0 | (cp >> 18));
      out.push(0x80 | ((cp >> 12) & 0x3f));
      out.push(0x80 | ((cp >> 6) & 0x3f));
      out.push(0x80 | (cp & 0x3f));
    }
  }
  return out;
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
// The concatenated sources, as a **latin1 string** rather than a Buffer: see
// `class Blob` for why that is the storage, and `__bufLatin1Of` /
// `__bufBytesOfLatin1` for the round trip.
//
// Node's `new Blob()` with no argument is `new Blob([])`, so `undefined` is the
// empty blob and only a non-iterable argument is `ERR_INVALID_ARG_TYPE`. A
// `Blob` part contributes its own bytes; anything that is not a string, a view
// or a blob is stringified, which is the spec's `USVString` branch.
//
// Divergence: Node also takes an `ArrayBuffer`/`SharedArrayBuffer` part. One
// held in an `any` is indistinguishable from a plain object in this engine
// (zun#38), so it falls into the stringify branch and contributes
// `"[object Object]"`. There is no predicate that would separate it.
function __bufBlobBytes(sources: any): string {
  if (sources === undefined) return "";
  if (!Array.isArray(sources)) {
    throw new ERR_INVALID_ARG_TYPE("sources", "a sequence", sources);
  }
  let out = "";
  for (const part of sources) {
    if (typeof part === "string") {
      out = out + __bufLatin1Of(Buffer.from(part, "utf8"));
    } else if (part instanceof Blob) {
      const blob: Blob = part;
      out = out + blob.__latin1;
    } else if (Buffer.isBuffer(part)) {
      out = out + __bufLatin1Of(part);
    } else {
      out = out + __bufLatin1Of(Buffer.from(String(part), "utf8"));
    }
  }
  return out;
}

// A byte string and back. `latin1` is one byte per code point in both
// directions, which the transcode matrix in this file verifies against Node for
// every byte value, so this round trip is exact.
function __bufLatin1Of(view: Buffer): string {
  return view.toString("latin1", 0 as u64, view.length);
}

function __bufBytesOfLatin1(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

class Blob {
  // The whole blob, materialized. Node keeps a list of handles and reads them
  // lazily; there is no file-backed blob here, so one byte sequence is the same
  // thing.
  //
  // It is held as a **latin1 string, not as a Buffer**, and that is not a
  // stylistic choice: the GC does not trace the `ArrayBuffer` behind a byte
  // view (zun#55), and a view stored in a class instance field has its bytes
  // freed under it at the first young collection — reproducibly once ~256
  // further objects have been allocated. The failure is worse than a crash: in
  // a dynamically dispatched call the resulting engine error is swallowed and
  // `blob.size` simply answers `NaN`, so a long-running program would see a
  // blob quietly empty itself. A string is traced, and latin1 round-trips bytes
  // one for one. `src/string_decoder/string_decoder.ts` keeps its pending bytes
  // out of a Buffer for exactly the same reason.
  __latin1: string = "";
  __type: string = "";

  constructor(sources: any, options?: any) {
    this.__latin1 = __bufBlobBytes(sources);
    this.__type = __bufNormalizeBlobType(
      options === undefined || options === null ? undefined : options.type,
    );
  }

  get size(): number {
    return Number(this.__latin1.length);
  }

  get type(): string {
    return this.__type;
  }

  slice(start?: any, end?: any, contentType?: any): any {
    const n = Number(this.__latin1.length);
    let from = start === undefined ? 0 : Number(start);
    let to = end === undefined ? n : Number(end);
    if (from < 0) from = n + from < 0 ? 0 : n + from;
    if (from > n) from = n;
    if (to < 0) to = n + to < 0 ? 0 : n + to;
    if (to > n) to = n;
    if (to < from) to = from;
    const out = new Blob([], undefined);
    out.__latin1 = this.__latin1.slice(from, to);
    out.__type = __bufNormalizeBlobType(contentType);
    return out;
  }

  bytes(): any {
    return Promise.resolve(__bufBytesOfLatin1(this.__latin1));
  }

  arrayBuffer(): any {
    return Promise.resolve(__bufBytesOfLatin1(this.__latin1).buffer());
  }

  text(): any {
    const bytes = __bufBytesOfLatin1(this.__latin1);
    return Promise.resolve(bytes.toString("utf8", 0 as u64, bytes.length));
  }
}

// `File` is a `Blob` with a name and a modification time. `extends Blob` is a
// local class extending a local class, which the engine supports (zun#21 is
// about `extends ns.Base`, a member expression, which this is not).
class File extends Blob {
  __name: string = "";
  __lastModified: number = 0;

  constructor(sources: any, fileName: any, options?: any) {
    super(sources, options);
    // `lib/internal/file.js` keys this on the argument count, which is not
    // observable here, so `undefined` stands in for "not passed": passing
    // `undefined` explicitly as the second argument is the one input where the
    // two differ.
    if (fileName === undefined) {
      throw new ERR_MISSING_ARGS("fileBits", "fileName");
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

// `validateNumber(value, 'INSPECT_MAX_BYTES', 0)` from
// `lib/internal/validators.js`, which is what Node's `INSPECT_MAX_BYTES` setter
// runs: anything that is not a `number` is an `ERR_INVALID_ARG_TYPE`, and a
// number below the minimum — or `NaN`, because a minimum is given — is an
// `ERR_OUT_OF_RANGE` whose range reads `>= 0`.
function __bufValidateInspectMaxBytes(value: any): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE("INSPECT_MAX_BYTES", "number", value);
  }
  if (Number(value) < 0 || Number.isNaN(Number(value))) {
    throw new ERR_OUT_OF_RANGE("INSPECT_MAX_BYTES", ">= 0", value);
  }
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
  // `validateNumber(val, 'INSPECT_MAX_BYTES', 0)`, so
  // `buffer.INSPECT_MAX_BYTES = 'foo'` throws `ERR_INVALID_ARG_TYPE` and
  // `= -1` / `= NaN` throw `ERR_OUT_OF_RANGE`. The engine supports accessors in
  // an object literal, so that is exactly what this is.
  //
  // The number itself lives in `src/util/util.ts`
  // (`__utilGet/SetInspectMaxBytes`), because the inspector that reads it is
  // there and `util` is inlined into every bundle while this file is
  // conditional — the same split Node has between `lib/buffer.js`'s accessor
  // and the `INSPECT_MAX_BYTES` its custom inspector closes over.
  get INSPECT_MAX_BYTES(): number {
    return __utilGetInspectMaxBytes();
  },
  set INSPECT_MAX_BYTES(value: any) {
    __bufValidateInspectMaxBytes(value);
    __utilSetInspectMaxBytes(Number(value));
  },

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

// node:string_decoder — `StringDecoder`, in Zun TypeScript over the engine's
// global `Buffer`.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-string-decoder*.js` files (see
// ../../test/string_decoder/).
//
// ---------------------------------------------------------------------------
// Which Node implementation this follows, and why
// ---------------------------------------------------------------------------
//
// Node 25's `lib/string_decoder.js` is a thin wrapper over a C++ decoder
// (`internalBinding('string_decoder')`), which keeps its whole state in a
// 7-byte Buffer and exposes `lastChar`/`lastNeed`/`lastTotal` as views into it.
// There is no `internalBinding` here, so the algorithm is Node's **own
// pure-JavaScript decoder** — `lib/string_decoder.js` as it stood through
// v8.x (MIT, Copyright Joyent, Inc. and other Node contributors): the
// `utf8CheckByte` / `utf8CheckIncomplete` / `utf8CheckExtraBytes` /
// `utf8FillLast` / `utf8Text` chain, `utf16Text`/`utf16End`,
// `base64Text`/`base64End` and the single-byte `simpleWrite`/`simpleEnd`.
// `lastChar`, `lastNeed` and `lastTotal` are that implementation's real state,
// so the undocumented surface Node still exposes is the natural shape here
// rather than a reconstruction.
//
// One deliberate divergence from the v8.x code, because the C++ decoder (and
// therefore Node 25, and therefore the oracle) changed it:
// `utf8CheckExtraBytes` emits **one U+FFFD per buffered byte** that the new
// input has just invalidated, not a single one. That is the fix for
// https://github.com/nodejs/node/issues/22626, which
// `test/parallel/test-string-decoder.js` pins:
//
//     write('f69b') === ''   then  write('d1') === two U+FFFD
//     write('f4')   === ''   then  write('bde5') === two U+FFFD
//
// The v8.x code answers a single U+FFFD for both. `__sdCheckExtraBytes` below
// therefore repeats the replacement character once per byte already held in
// `lastChar`.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * every method that touches a caller-supplied buffer takes it as `any`,
//     tests it with `Buffer.isBuffer`, and then hands it to a **top-level
//     function with a `Buffer`-typed parameter**. A byte view is completely
//     opaque when read through `any` in this engine — `buf.length` answers
//     `undefined` and `buf.toString(...)` throws — while the same `any` value
//     passed *into* a `Buffer` parameter works. That asymmetry is the single
//     shape this whole file is built around. The predicate used to be
//     `ArrayBuffer.isView`, which also admits a `Uint16Array` and a
//     `DataView` — whose bytes the typed-array accessors cannot reach, so the
//     program died on an uncatchable engine error; see `__sdValidateView`.
//   * `__sdUtf16Decode` replaces `buf.toString('utf16le', ...)`: the engine's
//     UTF-16 decoder turns an unpaired surrogate into U+FFFD where V8 keeps
//     it, and an unpaired surrogate is exactly what a UTF-16 stream decoder
//     exists to carry across a chunk boundary. `String.fromCharCode` does keep
//     one, so the decode is spelled out over the bytes.
//   * `x as u64` on every Buffer size/offset, and `Number(...)` on every byte
//     and every `.length`: the `nodeBuffer` intrinsics take machine integers
//     and the checker rejects a `number` there, while a `u8` element read can
//     be neither assigned to a `number` nor mixed with one (zun#3).
//   * `this.lastChar` is a declared field holding a real Buffer, never written
//     through an `any` alias: an undeclared key written onto a typed instance
//     through `any` poisons every later typed read of that instance (zun#37).
//   * the module's `StringDecoder` is a real class, and the module object
//     carries it as a value. Node's is a function with a `prototype`; there is
//     no function/prototype model in this engine (zun#25), so
//     `StringDecoder.call(obj)` and `new StringDecoder('utf8').__proto__.write`
//     — both of which `test-string-decoder.js` exercises — are not reachable.
//     See ../../test/string_decoder/README.md.

// ---------------------------------------------------------------------------
// Byte-level decoding helpers
// ---------------------------------------------------------------------------

// `utf8CheckByte`: 0 for ASCII, 2/3/4 for a lead byte of that width, -1 for a
// continuation byte, -2 for a byte that can be neither.
function __sdCheckByte(byte: number): number {
  if (byte <= 0x7f) return 0;
  if (byte >> 5 === 0x06) return 2;
  if (byte >> 4 === 0x0e) return 3;
  if (byte >> 3 === 0x1e) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
}

// UTF-16LE decode, byte pair by byte pair, keeping unpaired surrogates.
//
// `buf.toString('utf16le', ...)` cannot be used for this: the engine's UTF-16
// decoder replaces an unpaired surrogate with U+FFFD, where V8 — and therefore
// Node — preserves it. Carrying an unpaired high surrogate across a chunk
// boundary is the whole substance of UTF-16 stream decoding: `write('3dd8')`
// has to answer the empty string and remember the high surrogate, and `end()`
// after it has to answer that lone surrogate. `String.fromCharCode` does keep
// one, so this does the decode over the bytes.
function __sdUtf16Decode(buf: Buffer, start: number, end: number): string {
  let out = "";
  let i = start;
  while (i + 2 <= end) {
    out = out + String.fromCharCode(Number(buf[i]) | (Number(buf[i + 1]) << 8));
    i = i + 2;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pending-bytes store
// ---------------------------------------------------------------------------
//
// Node keeps the incomplete character in a Buffer (`lastChar`, or the C++
// decoder's 7-byte state block) and exposes it as a property. It cannot be a
// Buffer **field** here: a typed-array view held in a class instance field has
// its backing ArrayBuffer collected out from under it by the GC, because the
// view object is allocated with type RID 0 and the mark phase traces only
// `reference_slots(type_rid)`, which is empty for RID 0. Reading that field
// after the first young collection fails with
// `call did not resolve to a method`, reproducibly on the 256th instance:
//
//     class Holder { b: Buffer = Buffer.alloc(4); }
//     let n = 0;
//     for (let i = 0; i < 256; i++) { const h = new Holder(); n += Number(h.b.length); }
//
// A `StringDecoder` per chunk sequence is exactly that loop, so the four
// pending bytes live in four `number` fields and a Buffer is materialized only
// when one is actually needed -- for `toString`, and for the `lastChar`
// property Node exposes. See ../../test/string_decoder/README.md.

// Byte `i` (0..3) of the pending character.
function __sdLcGet(self: StringDecoder, i: number): number {
  if (i === 0) return self.__lc0;
  if (i === 1) return self.__lc1;
  if (i === 2) return self.__lc2;
  return self.__lc3;
}

function __sdLcSet(self: StringDecoder, i: number, value: number): void {
  if (i === 0) self.__lc0 = value;
  else if (i === 1) self.__lc1 = value;
  else if (i === 2) self.__lc2 = value;
  else self.__lc3 = value;
}

// `buf.copy(lastChar, destStart, sourceStart, sourceEnd)`.
function __sdLcCopyFrom(
  self: StringDecoder,
  buf: Buffer,
  destStart: number,
  sourceStart: number,
  sourceEnd: number,
): void {
  let d = destStart;
  for (let k = sourceStart; k < sourceEnd; k++) {
    if (d > 3) break;
    __sdLcSet(self, d, Number(buf[k]));
    d = d + 1;
  }
}

// A fresh 4-byte Buffer holding the pending bytes, for the one operation that
// needs a real view: `toString(encoding, 0, total)`. It never outlives the
// expression that uses it, so the GC bug above cannot reach it.
function __sdLcBuffer(self: StringDecoder): Buffer {
  const out = Buffer.alloc(4);
  out[0] = self.__lc0 as u8;
  out[1] = self.__lc1 as u8;
  out[2] = self.__lc2 as u8;
  out[3] = self.__lc3 as u8;
  return out;
}

// `__sdUtf16Decode` over the pending bytes instead of a view.
function __sdLcUtf16Decode(self: StringDecoder, start: number, end: number): string {
  let out = "";
  let i = start;
  while (i + 2 <= end) {
    out = out + String.fromCharCode(__sdLcGet(self, i) | (__sdLcGet(self, i + 1) << 8));
    i = i + 2;
  }
  return out;
}

// ASCII decode: Node's `ascii` codec is one byte per character with the **high
// bit masked off** (`buf.toString('ascii')` of `e2 80` is a `b` and a NUL).
// The engine's `toString('ascii')` instead runs the bytes through the UTF-8
// decoder, so `e2 80` comes back as a single U+FFFD. The masking is one line,
// so `ascii` is decoded here rather than reported as a divergence; the engine
// gap is in ../../test/string_decoder/README.md.
function __sdAsciiDecode(buf: Buffer, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) {
    out = out + String.fromCharCode(Number(buf[i]) & 0x7f);
  }
  return out;
}

// The sentinel `__sdFillLast` answers in place of Node's `undefined` ("the
// character is still incomplete"). A `string`-returning function cannot answer
// `undefined` here, and no real decoder output can be this value, because every
// path that produces text goes through `toString` or `fromCharCode`.
const __SD_INCOMPLETE: string = "\u0000__sd_incomplete__";

// ---------------------------------------------------------------------------
// StringDecoder
// ---------------------------------------------------------------------------

class StringDecoder {
  encoding: string = "utf8";
  lastNeed: number = 0;
  lastTotal: number = 0;
  // The pending character's bytes. Node's v8.x decoder sizes its `lastChar`
  // Buffer 4 for utf8/utf16le and 3 for base64, and leaves it absent for the
  // single-byte encodings; four bytes cover every case and keep `lastChar`
  // readable for all of them, which is what the corpus observes
  // (`decoder.lastChar.equals(new Uint8Array([0xe1, 0, 0, 0]))` for utf8).
  __lc0: number = 0;
  __lc1: number = 0;
  __lc2: number = 0;
  __lc3: number = 0;

  constructor(encoding?: any) {
    const normalized = __bufNormalizeEncoding(encoding);
    if (normalized === "") {
      throw new ERR_UNKNOWN_ENCODING(encoding);
    }
    this.encoding = normalized;
    this.lastNeed = 0;
    this.lastTotal = 0;
    this.__lc0 = 0;
    this.__lc1 = 0;
    this.__lc2 = 0;
    this.__lc3 = 0;
  }

  // `lastChar`, the undocumented property Node exposes. Node's is a live
  // subarray of the decoder's state block; this is a copy, materialized per
  // read for the reason given above `__sdLcBuffer`.
  get lastChar(): Buffer {
    return __sdLcBuffer(this);
  }

  // `StringDecoder.prototype.write`: the complete characters in `buf`, with any
  // trailing partial character held back.
  write(buf: any): string {
    if (typeof buf === "string") return buf;
    __sdValidateView(buf);
    return __sdWrite(this, buf);
  }

  // `StringDecoder.prototype.end`: whatever `write` would answer, plus the
  // flush of any partial character still buffered.
  end(buf?: any): string {
    if (buf === undefined || buf === null) return __sdEnd(this, "");
    return __sdEnd(this, this.write(buf));
  }

  // `StringDecoder.prototype.text(buf, offset)` — undocumented legacy. Node 25
  // clears the buffered state and re-enters `write` on `buf.slice(offset)`.
  text(buf: any, offset?: any): string {
    this.lastNeed = 0;
    this.lastTotal = 0;
    if (typeof buf === "string") {
      const s: string = buf;
      return s.slice(offset === undefined ? 0 : Number(offset));
    }
    __sdValidateView(buf);
    return __sdTextFrom(this, buf, offset === undefined ? 0 : Number(offset));
  }
}

// Node accepts a `Buffer`, any other `TypedArray` and a `DataView` here, and
// decodes the view's bytes. `Buffer.isBuffer` is the only engine predicate that
// recognises a view *and* guarantees its bytes can be read: a view held in an
// `any` does not report its class (zun#38), and handing a `DataView` to the
// typed-array accessors is an **uncatchable** engine error that stops the
// program. So a non-`U8` view is reported as the wrong type instead — Node's
// answer for the shapes it rejects, and a divergence for a `Uint16Array`, but
// never a crash. The same trade-off is made in `src/buffer/buffer.ts`'s
// `isUtf8`/`isAscii`.
function __sdValidateView(buf: any): void {
  if (!Buffer.isBuffer(buf)) {
    throw new ERR_INVALID_ARG_TYPE("buf", ["Buffer", "TypedArray", "DataView"], buf);
  }
}

// `buf.slice(offset)` then `write`, with the slice done on a typed receiver.
function __sdTextFrom(self: StringDecoder, buf: Buffer, offset: number): string {
  const n = Number(buf.length);
  const from = offset < 0 ? 0 : offset > n ? n : offset;
  return __sdWrite(self, buf.slice(from, n));
}

// `StringDecoder.prototype.write`'s body, on a typed receiver.
function __sdWrite(self: StringDecoder, buf: Buffer): string {
  const len = Number(buf.length);
  if (len === 0) return "";
  let r = "";
  let i = 0;
  if (self.lastNeed > 0) {
    const filled = __sdFillLast(self, buf);
    if (filled === __SD_INCOMPLETE) return "";
    r = filled;
    // `__sdCheckExtraBytes` may already have lowered `lastNeed` to the number
    // of bytes the aborted character did consume, which is where the rest of
    // this chunk starts.
    i = self.lastNeed;
    self.lastNeed = 0;
  }
  if (i < len) return r + __sdText(self, buf, i);
  return r;
}

// `StringDecoder.prototype.end`'s body: the per-encoding flush of the partial
// character still in `lastChar`.
function __sdEnd(self: StringDecoder, written: string): string {
  if (self.lastNeed === 0) return written;
  const enc = self.encoding;
  if (enc === "utf8") {
    self.lastNeed = 0;
    self.lastTotal = 0;
    return written + "�";
  }
  if (enc === "utf16le") {
    // Node adds no replacement character here: it hands the bytes it has to
    // the UTF-16 decoder and lets the lone surrogate through.
    const end = self.lastTotal - self.lastNeed;
    self.lastNeed = 0;
    self.lastTotal = 0;
    return written + __sdLcUtf16Decode(self, 0, end);
  }
  if (enc === "base64" || enc === "base64url") {
    const end = 3 - self.lastNeed;
    self.lastNeed = 0;
    self.lastTotal = 0;
    return written + __sdLcBuffer(self).toString(enc, 0, end as u64);
  }
  // Single-byte encodings never buffer, so this is unreachable; resetting is
  // still the right thing if it ever is reached.
  self.lastNeed = 0;
  self.lastTotal = 0;
  return written;
}

// ---------------------------------------------------------------------------
// The per-encoding `text`
// ---------------------------------------------------------------------------

function __sdText(self: StringDecoder, buf: Buffer, i: number): string {
  const enc = self.encoding;
  if (enc === "utf8") return __sdUtf8Text(self, buf, i);
  if (enc === "utf16le") return __sdUtf16Text(self, buf, i);
  if (enc === "base64" || enc === "base64url") return __sdBase64Text(self, buf, i);
  // `simpleWrite`: a single-byte encoding passes the bytes straight through.
  // `write` only reaches here with `i === 0`, because these never buffer.
  if (enc === "ascii") return __sdAsciiDecode(buf, i, Number(buf.length));
  return buf.toString(enc, i as u64, buf.length);
}

// `utf8CheckIncomplete`: look at the last up-to-three bytes for the head of an
// incomplete multi-byte character, and set `lastNeed` to how many bytes are
// still missing. Answers the character's total width.
function __sdUtf8CheckIncomplete(self: StringDecoder, buf: Buffer, i: number): number {
  let j = Number(buf.length) - 1;
  if (j < i) return 0;
  let nb = __sdCheckByte(Number(buf[j]));
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  j = j - 1;
  if (j < i || nb === -2) return 0;
  nb = __sdCheckByte(Number(buf[j]));
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  j = j - 1;
  if (j < i || nb === -2) return 0;
  nb = __sdCheckByte(Number(buf[j]));
  if (nb >= 0) {
    if (nb > 0) {
      // A two-byte head three bytes from the end is already complete.
      if (nb === 2) nb = 0;
      else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

// `utf8Text`: every complete character from `i`, with a trailing partial one
// copied into `lastChar`.
function __sdUtf8Text(self: StringDecoder, buf: Buffer, i: number): string {
  const total = __sdUtf8CheckIncomplete(self, buf, i);
  if (self.lastNeed === 0) return buf.toString("utf8", i as u64, buf.length);
  self.lastTotal = total;
  const len = Number(buf.length);
  const end = len - (total - self.lastNeed);
  __sdLcCopyFrom(self, buf, 0, end, len);
  return buf.toString("utf8", i as u64, end as u64);
}

// `utf16Text`: UTF-16LE needs whole code units, and a trailing high surrogate
// has to wait for its pair.
function __sdUtf16Text(self: StringDecoder, buf: Buffer, i: number): string {
  const len = Number(buf.length);
  if ((len - i) % 2 === 0) {
    // The trailing code unit is read from the bytes rather than from the
    // decoded string, because the engine would already have replaced a lone
    // surrogate with U+FFFD by then.
    if (len - i >= 2) {
      const last = Number(buf[len - 2]) | (Number(buf[len - 1]) << 8);
      if (last >= 0xd800 && last <= 0xdbff) {
        self.lastNeed = 2;
        self.lastTotal = 4;
        __sdLcSet(self, 0, Number(buf[len - 2]));
        __sdLcSet(self, 1, Number(buf[len - 1]));
        return __sdUtf16Decode(buf, i, len - 2);
      }
    }
    return __sdUtf16Decode(buf, i, len);
  }
  self.lastNeed = 1;
  self.lastTotal = 2;
  __sdLcSet(self, 0, Number(buf[len - 1]));
  return __sdUtf16Decode(buf, i, len - 1);
}

// `base64Text`: base64 consumes three bytes per four characters, so a
// remainder of one or two bytes waits.
function __sdBase64Text(self: StringDecoder, buf: Buffer, i: number): string {
  const len = Number(buf.length);
  const n = (len - i) % 3;
  if (n === 0) return buf.toString(self.encoding, i as u64, buf.length);
  self.lastNeed = 3 - n;
  self.lastTotal = 3;
  if (n === 1) {
    __sdLcSet(self, 0, Number(buf[len - 1]));
  } else {
    __sdLcSet(self, 0, Number(buf[len - 2]));
    __sdLcSet(self, 1, Number(buf[len - 1]));
  }
  return buf.toString(self.encoding, i as u64, (len - n) as u64);
}

// ---------------------------------------------------------------------------
// Completing a buffered character
// ---------------------------------------------------------------------------

// `utf8CheckExtraBytes`: the continuation bytes the new chunk is supposed to
// supply are validated, and the first byte that is not a continuation ends the
// buffered character early.
//
// How many U+FFFD that produces is **not** one, and not one per byte either —
// it is one per *maximal subpart* of the ill-formed sequence, Unicode's
// recommended practice, which is what V8 does and therefore what Node answers:
//
//     f6 9b | d1    -> two  (f6 is not a legal lead at all, 9b is then stray)
//     f4 bd | e5    -> two  (bd is out of range for an f4 lead)
//     f0 b8 | 41    -> one  (f0 b8 is a legal prefix, so it is one subpart)
//     e2 b8 | cc b8 -> one  (likewise)
//
// Reimplementing that classification would be reimplementing a UTF-8 decoder.
// The engine already has one, and it agrees with V8 byte for byte on every
// vector `test-string-decoder.js` uses, so the aborted bytes are simply handed
// to it: the continuation bytes the chunk *did* supply are appended to
// `lastChar` and the whole prefix is decoded with `toString('utf8')`, whose
// lossy replacement is the right count by construction.
//
// Answers the empty string when every byte checked so far is a valid
// continuation.
function __sdCheckExtraBytes(self: StringDecoder, buf: Buffer, p: number): string {
  if ((Number(buf[0]) & 0xc0) !== 0x80) {
    self.lastNeed = 0;
    return __sdAbort(self, buf, p, 0);
  }
  const len = Number(buf.length);
  if (self.lastNeed > 1 && len > 1) {
    if ((Number(buf[1]) & 0xc0) !== 0x80) {
      self.lastNeed = 1;
      return __sdAbort(self, buf, p, 1);
    }
    if (self.lastNeed > 2 && len > 2) {
      if ((Number(buf[2]) & 0xc0) !== 0x80) {
        self.lastNeed = 2;
        return __sdAbort(self, buf, p, 2);
      }
    }
  }
  return "";
}

// The replacement text for an aborted multi-byte character: the `p` bytes
// already in `lastChar` plus the `taken` continuation bytes from the head of
// this chunk, decoded lossily.
function __sdAbort(self: StringDecoder, buf: Buffer, p: number, taken: number): string {
  if (taken > 0) __sdLcCopyFrom(self, buf, p, 0, taken);
  const total = p + taken;
  return __sdLcBuffer(self).toString("utf8", 0, total as u64);
}

// `fillLast` / `utf8FillLast`.
function __sdFillLast(self: StringDecoder, buf: Buffer): string {
  const len = Number(buf.length);
  const p = self.lastTotal - self.lastNeed;
  if (self.encoding === "utf8") {
    const r = __sdCheckExtraBytes(self, buf, p);
    if (r !== "") return r;
    if (self.lastNeed <= len) {
      __sdLcCopyFrom(self, buf, p, 0, self.lastNeed);
      return __sdLcBuffer(self).toString("utf8", 0, self.lastTotal as u64);
    }
    __sdLcCopyFrom(self, buf, p, 0, len);
    self.lastNeed = self.lastNeed - len;
    return __SD_INCOMPLETE;
  }
  // Non-UTF-8: no continuation-byte structure to validate, just accumulate.
  if (self.lastNeed <= len) {
    __sdLcCopyFrom(self, buf, p, 0, self.lastNeed);
    if (self.encoding === "utf16le") {
      return __sdLcUtf16Decode(self, 0, self.lastTotal);
    }
    return __sdLcBuffer(self).toString(self.encoding, 0, self.lastTotal as u64);
  }
  __sdLcCopyFrom(self, buf, p, 0, len);
  self.lastNeed = self.lastNeed - len;
  return __SD_INCOMPLETE;
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------
//
// `StringDecoder` is the canonical binding of this module in
// `tools/bundle_node_test.sh`, because `new <identifier>()` only compiles here
// when the identifier is a statically known class — never a member expression
// (zun#18) — so `require('string_decoder').StringDecoder` has to leave the name
// bound to the class itself. The property is carried anyway, so a
// `string_decoder.StringDecoder` member read answers it.
const __node_string_decoder: any = {
  StringDecoder: StringDecoder,
};

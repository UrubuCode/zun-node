// The WHATWG URL Standard — `URL` and `URLSearchParams` — in Zun TypeScript.
//
// This file is the *specification* implementation: the basic URL parser, host
// parsing (opaque hosts, IPv4, IPv6, IDNA), the percent-encode sets, the
// serializers, every getter and every setter, `URL.canParse`/`URL.parse`, and
// `URLSearchParams` in full. It follows https://url.spec.whatwg.org/ step for
// step; where Node adds something on top of the standard (the `ERR_*` codes,
// `ERR_INVALID_THIS` on a detached method, `URL.createObjectURL`) that comes
// from `lib/internal/url.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors).
//
// The compatibility bar is Node.js 25's own `test/parallel/test-url*.js` and
// `test/parallel/test-whatwg-url-*.js` (see ../../test/url/).
//
// ---------------------------------------------------------------------------
// Why the classes are called `NodeURL` / `NodeURLSearchParams`
// ---------------------------------------------------------------------------
//
// `URL` and `URLSearchParams` are **prelude class names** in this engine
// (`crates/zun_prelude/builtin/url.zun`, `url_search_params.zun`), and a user
// class of the same name is rejected outright with "duplicate class" — so the
// spec implementation cannot be *called* `URL`, however much it would like to
// be. It is therefore declared as `NodeURL`/`NodeURLSearchParams`, exported as
// `url.URL`/`url.URLSearchParams` (which is the spelling Node's own tests
// reach for: `const { URL } = require('url')`), and the three constructor-ish
// spellings a test body can use — `new URL(...)`, `URL.<static>` and
// `x instanceof URL` — are rewritten to the second name by
// `tools/bundle_node_test.sh`, exactly as `console`, `performance` and
// `crypto` are rewritten there and for the same reason. Every other
// appearance of the word `URL` in a test body (a string, `ERR_INVALID_URL`,
// `globalThis.URL`) is left as written.
//
// The prelude classes stay reachable and untouched; nothing here shadows them.
//
// ---------------------------------------------------------------------------
// Engine gaps this file lives with
// ---------------------------------------------------------------------------
//
//   * `__wuUnits()` — `charCodeAt(index)` and `slice(from, to)` are O(n) in the
//     string's length (https://github.com/UrubuCode/zun/issues/12), so every
//     scan runs over the code-unit array `split("")` produces, as in
//     `querystring.ts` and `url.ts`. `charCodeAt` also throws out of range
//     (https://github.com/UrubuCode/zun/issues/2), which the array form cannot.
//   * `__wuLen()`/`__wuALen()` — the checker types `.length` as `u64`
//     (https://github.com/UrubuCode/zun/issues/3).
//   * No regular expressions anywhere: a RegExp loses its methods through an
//     `any` (https://github.com/UrubuCode/zun/issues/7), and a URL parser is
//     the last place that should own a backtracking engine.
//   * `Symbol.toStringTag`, `Symbol.iterator` and reading a class method as a
//     value (https://github.com/UrubuCode/zun/issues/19) are not available, so
//     `URLSearchParams` exposes `entries()`/`keys()`/`values()` as objects with
//     a `next()` **and** an `items` array (which is what `for (... of ...)`
//     reaches for here), rather than as real ECMAScript iterators.
//   * **IDNA is punycode, not full UTS#46.** There is no ICU in this runtime;
//     `common.hasIntl` is `false` and Node's own IDNA-dependent tests are
//     written `{ skip: !hasIntl }`. `__wuDomainToASCII` therefore does the
//     RFC 3492 encoding plus the standard's forbidden-code-point and
//     empty-label checks, and skips the mapping/normalization steps ICU owns.
//
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function __wuLen(value: string): number {
  return Number(value.length);
}

function __wuALen(value: any): number {
  return Number(value.length);
}

// The code units of `s`, as one-character strings. See the header note on #12.
function __wuUnits(s: string): any {
  return s.split("");
}

function __wuCode(unit: any): number {
  return Number((unit as string).charCodeAt(0));
}

// The code unit at `index`, or -1 for "past the end" (the parser's EOF).
function __wuAt(units: any, index: number, n: number): number {
  if (index < 0 || index >= n) return -1;
  return __wuCode(units[index]);
}

function __wuSub(units: any, from: number, to: number): string {
  if (to <= from) return "";
  const piece: any = units.slice(from, to);
  return piece.join("");
}

const __WU_HEX_DIGITS: string = "0123456789ABCDEF";

function __wuBuildHexTable(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 256; i++) {
    out.push(
      "%" +
        (__WU_HEX_DIGITS.slice(Math.floor(i / 16), Math.floor(i / 16) + 1) as string) +
        (__WU_HEX_DIGITS.slice(i % 16, (i % 16) + 1) as string),
    );
  }
  return out;
}

const __wuHexTable: string[] = __wuBuildHexTable();

function __wuIsAsciiDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function __wuIsAsciiUpper(c: number): boolean {
  return c >= 0x41 && c <= 0x5a;
}

function __wuIsAsciiLower(c: number): boolean {
  return c >= 0x61 && c <= 0x7a;
}

function __wuIsAsciiAlpha(c: number): boolean {
  return __wuIsAsciiUpper(c) || __wuIsAsciiLower(c);
}

function __wuIsAsciiAlphanumeric(c: number): boolean {
  return __wuIsAsciiAlpha(c) || __wuIsAsciiDigit(c);
}

function __wuIsAsciiHexDigit(c: number): boolean {
  if (__wuIsAsciiDigit(c)) return true;
  if (c >= 0x41 && c <= 0x46) return true;
  return c >= 0x61 && c <= 0x66;
}

function __wuHexValue(c: number): number {
  if (__wuIsAsciiDigit(c)) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return c - 0x61 + 10;
}

// An ASCII tab or newline, which the parser strips from the whole input and
// refuses inside a host.
function __wuIsTabOrNewline(c: number): boolean {
  return c === 0x09 || c === 0x0a || c === 0x0d;
}

// A C0 control or space, which the parser strips from both ends of the input.
function __wuIsC0OrSpace(c: number): boolean {
  return c <= 0x20;
}

// ---------------------------------------------------------------------------
// Percent-encode sets (https://url.spec.whatwg.org/#percent-encoded-bytes)
//
// Each set is a *superset* of the one above it, so the predicates are written
// as a chain rather than as eight tables.
// ---------------------------------------------------------------------------

const __WU_SET_C0 = 0;
const __WU_SET_FRAGMENT = 1;
const __WU_SET_QUERY = 2;
const __WU_SET_SPECIAL_QUERY = 3;
const __WU_SET_PATH = 4;
const __WU_SET_USERINFO = 5;
const __WU_SET_COMPONENT = 6;
const __WU_SET_URLENCODED = 7;

// The C0 control percent-encode set: C0 controls and everything above U+007E.
function __wuInC0Set(c: number): boolean {
  return c < 0x20 || c > 0x7e;
}

// + U+0020 SPACE, U+0022 ("), U+003C (<), U+003E (>), U+0060 (`)
function __wuInFragmentSet(c: number): boolean {
  if (__wuInC0Set(c)) return true;
  return c === 0x20 || c === 0x22 || c === 0x3c || c === 0x3e || c === 0x60;
}

// The query set is the C0 set + SPACE, ("), (#), (<), (>) — note it does *not*
// contain the backtick, which is why it is not layered on the fragment set.
function __wuInQuerySet(c: number): boolean {
  if (__wuInC0Set(c)) return true;
  return c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c || c === 0x3e;
}

// + U+0027 (')
function __wuInSpecialQuerySet(c: number): boolean {
  return __wuInQuerySet(c) || c === 0x27;
}

// The path set is the query set + (?), (`), ({), (}).
function __wuInPathSet(c: number): boolean {
  if (__wuInQuerySet(c)) return true;
  return c === 0x3f || c === 0x60 || c === 0x7b || c === 0x7d;
}

// + (/), (:), (;), (=), (@), ([) to (^), (|)
function __wuInUserinfoSet(c: number): boolean {
  if (__wuInPathSet(c)) return true;
  if (c === 0x2f || c === 0x3a || c === 0x3b || c === 0x3d || c === 0x40) return true;
  if (c >= 0x5b && c <= 0x5e) return true;
  return c === 0x7c;
}

// + ($) to (&), (+), (,)
function __wuInComponentSet(c: number): boolean {
  if (__wuInUserinfoSet(c)) return true;
  if (c >= 0x24 && c <= 0x26) return true;
  return c === 0x2b || c === 0x2c;
}

// + (!), (') to ()), (~)
function __wuInUrlencodedSet(c: number): boolean {
  if (__wuInComponentSet(c)) return true;
  if (c === 0x21) return true;
  if (c >= 0x27 && c <= 0x29) return true;
  return c === 0x7e;
}

function __wuInSet(set: number, c: number): boolean {
  if (set === __WU_SET_C0) return __wuInC0Set(c);
  if (set === __WU_SET_FRAGMENT) return __wuInFragmentSet(c);
  if (set === __WU_SET_QUERY) return __wuInQuerySet(c);
  if (set === __WU_SET_SPECIAL_QUERY) return __wuInSpecialQuerySet(c);
  if (set === __WU_SET_PATH) return __wuInPathSet(c);
  if (set === __WU_SET_USERINFO) return __wuInUserinfoSet(c);
  if (set === __WU_SET_COMPONENT) return __wuInComponentSet(c);
  return __wuInUrlencodedSet(c);
}

// UTF-8 percent-encode of one *code point* against `set`, appending to `out`.
// A lone surrogate is encoded as U+FFFD, as the UTF-8 encoder the standard
// refers to does.
function __wuEncodeCodePoint(out: string[], cp: number, set: number): void {
  if (!__wuInSet(set, cp)) {
    out.push(__wuFromCodePoint(cp));
    return;
  }
  if (cp < 0x80) {
    out.push(__wuHexTable[cp]);
    return;
  }
  let c = cp;
  if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
  if (c < 0x800) {
    out.push(__wuHexTable[0xc0 | Math.floor(c / 64)]);
    out.push(__wuHexTable[0x80 | (c & 0x3f)]);
    return;
  }
  if (c < 0x10000) {
    out.push(__wuHexTable[0xe0 | Math.floor(c / 4096)]);
    out.push(__wuHexTable[0x80 | (Math.floor(c / 64) & 0x3f)]);
    out.push(__wuHexTable[0x80 | (c & 0x3f)]);
    return;
  }
  out.push(__wuHexTable[0xf0 | Math.floor(c / 262144)]);
  out.push(__wuHexTable[0x80 | (Math.floor(c / 4096) & 0x3f)]);
  out.push(__wuHexTable[0x80 | (Math.floor(c / 64) & 0x3f)]);
  out.push(__wuHexTable[0x80 | (c & 0x3f)]);
}

// `String.fromCodePoint`, written out: the engine has `String.fromCharCode`.
function __wuFromCodePoint(cp: number): string {
  if (cp < 0x10000) return String.fromCharCode(cp);
  const rest = cp - 0x10000;
  return (
    String.fromCharCode(0xd800 + Math.floor(rest / 1024)) +
    String.fromCharCode(0xdc00 + (rest % 1024))
  );
}

// Percent-encode `text` against `set`, walking *code points* (so a surrogate
// pair becomes one four-byte sequence).
function __wuPercentEncode(text: string, set: number): string {
  const units: any = __wuUnits(text);
  const n = __wuALen(units);
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let cp = __wuCode(units[i]);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
      const low = __wuCode(units[i + 1]);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + (cp - 0xd800) * 1024 + (low - 0xdc00);
        i = i + 1;
      }
    }
    __wuEncodeCodePoint(out, cp, set);
    i = i + 1;
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Percent-decoding
// ---------------------------------------------------------------------------

// Percent-decode `text` into a byte array (the standard's "percent-decode a
// byte sequence"), taking the UTF-8 of the input for the bytes that are not
// escapes.
function __wuPercentDecodeBytes(text: string): any {
  const units: any = __wuUnits(text);
  const n = __wuALen(units);
  const bytes: number[] = [];
  let i = 0;
  while (i < n) {
    const c = __wuCode(units[i]);
    if (c === 0x25 && i + 2 < n) {
      const h1 = __wuCode(units[i + 1]);
      const h2 = __wuCode(units[i + 2]);
      if (__wuIsAsciiHexDigit(h1) && __wuIsAsciiHexDigit(h2)) {
        bytes.push(__wuHexValue(h1) * 16 + __wuHexValue(h2));
        i = i + 3;
        continue;
      }
    }
    // Not an escape: the code point's own UTF-8.
    let cp = c;
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
      const low = __wuCode(units[i + 1]);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + (cp - 0xd800) * 1024 + (low - 0xdc00);
        i = i + 1;
      }
    }
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | Math.floor(cp / 64));
      bytes.push(0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | Math.floor(cp / 4096));
      bytes.push(0x80 | (Math.floor(cp / 64) & 0x3f));
      bytes.push(0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | Math.floor(cp / 262144));
      bytes.push(0x80 | (Math.floor(cp / 4096) & 0x3f));
      bytes.push(0x80 | (Math.floor(cp / 64) & 0x3f));
      bytes.push(0x80 | (cp & 0x3f));
    }
    i = i + 1;
  }
  return bytes;
}

function __wuIsCont(bytes: any, index: number): boolean {
  const b = Number(bytes[index]);
  return b >= 0x80 && b <= 0xbf;
}

// UTF-8 decode with replacement, the same routine `querystring.ts` carries.
function __wuDecodeUtf8(bytes: any): string {
  const count = __wuALen(bytes);
  const out: string[] = [];
  let i = 0;
  while (i < count) {
    const b0 = Number(bytes[i]);
    if (b0 < 0x80) {
      out.push(String.fromCharCode(b0));
      i = i + 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf && i + 1 < count && __wuIsCont(bytes, i + 1)) {
      out.push(String.fromCharCode(((b0 & 0x1f) * 64) + (Number(bytes[i + 1]) & 0x3f)));
      i = i + 2;
    } else if (
      b0 >= 0xe0 && b0 <= 0xef && i + 2 < count &&
      __wuIsCont(bytes, i + 1) && __wuIsCont(bytes, i + 2)
    ) {
      const cp =
        ((b0 & 0x0f) * 4096) +
        ((Number(bytes[i + 1]) & 0x3f) * 64) +
        (Number(bytes[i + 2]) & 0x3f);
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) {
        out.push("�");
        i = i + 1;
      } else {
        out.push(String.fromCharCode(cp));
        i = i + 3;
      }
    } else if (
      b0 >= 0xf0 && b0 <= 0xf4 && i + 3 < count &&
      __wuIsCont(bytes, i + 1) && __wuIsCont(bytes, i + 2) && __wuIsCont(bytes, i + 3)
    ) {
      const cp =
        ((b0 & 0x07) * 262144) +
        ((Number(bytes[i + 1]) & 0x3f) * 4096) +
        ((Number(bytes[i + 2]) & 0x3f) * 64) +
        (Number(bytes[i + 3]) & 0x3f);
      if (cp < 0x10000 || cp > 0x10ffff) {
        out.push("�");
        i = i + 1;
      } else {
        out.push(__wuFromCodePoint(cp));
        i = i + 4;
      }
    } else {
      out.push("�");
      i = i + 1;
    }
  }
  return out.join("");
}

function __wuPercentDecode(text: string): string {
  return __wuDecodeUtf8(__wuPercentDecodeBytes(text));
}

// ---------------------------------------------------------------------------
// Special schemes (https://url.spec.whatwg.org/#special-scheme)
// ---------------------------------------------------------------------------

function __wuIsSpecial(scheme: string): boolean {
  if (scheme === "http" || scheme === "https") return true;
  if (scheme === "ws" || scheme === "wss") return true;
  return scheme === "ftp" || scheme === "file";
}

// The default port, or -1 for "no default" (`file:` and every non-special
// scheme).
function __wuDefaultPort(scheme: string): number {
  if (scheme === "http" || scheme === "ws") return 80;
  if (scheme === "https" || scheme === "wss") return 443;
  if (scheme === "ftp") return 21;
  return -1;
}

// ---------------------------------------------------------------------------
// Forbidden code points
// (https://url.spec.whatwg.org/#forbidden-host-code-point)
// ---------------------------------------------------------------------------

function __wuIsForbiddenHostCodePoint(c: number): boolean {
  if (c === 0x00 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20) return true;
  if (c === 0x23 || c === 0x2f || c === 0x3a || c === 0x3c || c === 0x3e) return true;
  if (c === 0x3f || c === 0x40 || c === 0x5b || c === 0x5c || c === 0x5d) return true;
  return c === 0x5e || c === 0x7c;
}

// The forbidden *domain* code point set: the host set, plus C0 controls,
// U+0025 (%) and U+007F DELETE.
function __wuIsForbiddenDomainCodePoint(c: number): boolean {
  if (__wuIsForbiddenHostCodePoint(c)) return true;
  return c <= 0x1f || c === 0x25 || c === 0x7f;
}

// ---------------------------------------------------------------------------
// IPv4 (https://url.spec.whatwg.org/#concept-ipv4-parser)
//
// Numbers are accumulated as plain doubles: the largest value the parser can
// legitimately produce is 2^32 - 1, which is exact in a double, and anything
// above that is a parse failure. The accumulation saturates so a pathological
// digit run cannot lose precision silently.
// ---------------------------------------------------------------------------

// `__wuParseIPv4Number(input)` answers the value, or -1 for failure. The
// standard's "validationError" flag is not observable through `URL`, so it is
// not threaded out.
function __wuParseIPv4Number(input: string): number {
  if (input === "") return -1;
  let text = input;
  let radix = 10;
  let n = __wuLen(text);
  if (n >= 2) {
    const head = text.slice(0, 2);
    if (head === "0x" || head === "0X") {
      text = text.slice(2);
      radix = 16;
    }
  }
  if (radix === 10 && n >= 2 && text.slice(0, 1) === "0") {
    text = text.slice(1);
    radix = 8;
  }
  if (text === "") return 0;
  const units: any = __wuUnits(text);
  n = __wuALen(units);
  let value = 0;
  for (let i = 0; i < n; i++) {
    const c = __wuCode(units[i]);
    let digit = -1;
    if (radix === 16) {
      if (__wuIsAsciiHexDigit(c)) digit = __wuHexValue(c);
    } else if (radix === 8) {
      if (c >= 0x30 && c <= 0x37) digit = c - 0x30;
    } else if (__wuIsAsciiDigit(c)) {
      digit = c - 0x30;
    }
    if (digit < 0) return -1;
    value = value * radix + digit;
    // 2^32 is the first value that can never be a valid IPv4 address; stop
    // there rather than letting the accumulator run away.
    if (value > 4294967295) return 4294967296;
  }
  return value;
}

// "ends in a number": the last (non-empty-trailing) label is all digits, or is
// a valid hexadecimal/octal/decimal number.
function __wuEndsInNumber(input: string): boolean {
  const parts: any = input.split(".");
  let count = __wuALen(parts);
  if (count === 0) return false;
  if ((parts[count - 1] as string) === "") {
    if (count === 1) return false;
    count = count - 1;
  }
  const last: string = parts[count - 1] as string;
  if (last === "") return false;
  const units: any = __wuUnits(last);
  const n = __wuALen(units);
  let allDigits = true;
  for (let i = 0; i < n; i++) {
    if (!__wuIsAsciiDigit(__wuCode(units[i]))) {
      allDigits = false;
      break;
    }
  }
  if (allDigits) return true;
  // "If parsing last as an IPv4 number does not return failure, return true."
  // An out-of-range value is *not* a parse failure at this step — it makes the
  // whole host a failure one step later, in `__wuParseIPv4`, which is why
  // `http://0x100000000/` is an invalid URL rather than a domain.
  return __wuParseIPv4Number(last) >= 0;
}

// The IPv4 parser: answers the 32-bit address, or -1 for failure. A host that
// merely is not an IPv4 address (so is a domain) is filtered out by
// `__wuEndsInNumber` before this is reached.
function __wuParseIPv4(input: string): number {
  const parts: any = input.split(".");
  let count = __wuALen(parts);
  if (count > 1 && (parts[count - 1] as string) === "") count = count - 1;
  if (count > 4) return -1;
  const numbers: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = __wuParseIPv4Number(parts[i] as string);
    if (value < 0 || value > 4294967295) return -1;
    numbers.push(value);
  }
  for (let i = 0; i < count - 1; i++) {
    if (numbers[i] > 255) return -1;
  }
  const last = numbers[count - 1];
  let limit = 1;
  for (let i = 0; i < 4 - (count - 1); i++) limit = limit * 256;
  if (last >= limit) return -1;
  let ipv4 = last;
  for (let i = 0; i < count - 1; i++) {
    let shift = 1;
    for (let k = 0; k < 3 - i; k++) shift = shift * 256;
    ipv4 = ipv4 + numbers[i] * shift;
  }
  return ipv4;
}

function __wuSerializeIPv4(address: number): string {
  const pieces: string[] = [];
  let n = address;
  for (let i = 0; i < 4; i++) {
    pieces.push(String(n % 256));
    n = Math.floor(n / 256);
  }
  // The loop produced the pieces least-significant first.
  return (
    (pieces[3] as string) + "." + (pieces[2] as string) + "." +
    (pieces[1] as string) + "." + (pieces[0] as string)
  );
}

// ---------------------------------------------------------------------------
// IPv6 (https://url.spec.whatwg.org/#concept-ipv6-parser)
//
// Answers the eight 16-bit pieces, or `null` for failure.
// ---------------------------------------------------------------------------

function __wuParseIPv6(input: string): any {
  const address: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  let pieceIndex = 0;
  let compress = -1;
  const units: any = __wuUnits(input);
  const n = __wuALen(units);
  let pointer = 0;
  let c = __wuAt(units, pointer, n);

  if (c === 0x3a) {
    if (__wuAt(units, pointer + 1, n) !== 0x3a) return null;
    pointer = pointer + 2;
    pieceIndex = pieceIndex + 1;
    compress = pieceIndex;
  }
  while (__wuAt(units, pointer, n) !== -1) {
    if (pieceIndex === 8) return null;
    c = __wuAt(units, pointer, n);
    if (c === 0x3a) {
      if (compress >= 0) return null;
      pointer = pointer + 1;
      pieceIndex = pieceIndex + 1;
      compress = pieceIndex;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && __wuIsAsciiHexDigit(__wuAt(units, pointer, n))) {
      value = value * 16 + __wuHexValue(__wuAt(units, pointer, n));
      pointer = pointer + 1;
      length = length + 1;
    }
    c = __wuAt(units, pointer, n);
    if (c === 0x2e) {
      if (length === 0) return null;
      pointer = pointer - length;
      if (pieceIndex > 6) return null;
      let numbersSeen = 0;
      while (__wuAt(units, pointer, n) !== -1) {
        let ipv4Piece = -1;
        if (numbersSeen > 0) {
          if (__wuAt(units, pointer, n) === 0x2e && numbersSeen < 4) {
            pointer = pointer + 1;
          } else {
            return null;
          }
        }
        if (!__wuIsAsciiDigit(__wuAt(units, pointer, n))) return null;
        while (__wuIsAsciiDigit(__wuAt(units, pointer, n))) {
          const digit = __wuAt(units, pointer, n) - 0x30;
          if (ipv4Piece < 0) {
            ipv4Piece = digit;
          } else if (ipv4Piece === 0) {
            return null;
          } else {
            ipv4Piece = ipv4Piece * 10 + digit;
          }
          if (ipv4Piece > 255) return null;
          pointer = pointer + 1;
        }
        address[pieceIndex] = address[pieceIndex] * 256 + ipv4Piece;
        numbersSeen = numbersSeen + 1;
        if (numbersSeen === 2 || numbersSeen === 4) pieceIndex = pieceIndex + 1;
      }
      if (numbersSeen !== 4) return null;
      break;
    }
    if (c === 0x3a) {
      pointer = pointer + 1;
      if (__wuAt(units, pointer, n) === -1) return null;
    } else if (c !== -1) {
      return null;
    }
    address[pieceIndex] = value;
    pieceIndex = pieceIndex + 1;
  }
  if (compress >= 0) {
    let swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      const tmp = address[pieceIndex];
      address[pieceIndex] = address[compress + swaps - 1];
      address[compress + swaps - 1] = tmp;
      pieceIndex = pieceIndex - 1;
      swaps = swaps - 1;
    }
  } else if (pieceIndex !== 8) {
    return null;
  }
  return address;
}

function __wuHex(value: number): string {
  if (value === 0) return "0";
  const digits = "0123456789abcdef";
  let out = "";
  let n = value;
  while (n > 0) {
    out = (digits.slice(n % 16, (n % 16) + 1) as string) + out;
    n = Math.floor(n / 16);
  }
  return out;
}

function __wuSerializeIPv6(address: any): string {
  // The longest run of two or more consecutive zero pieces is compressed.
  let compress = -1;
  let longest = 1;
  let index = 0;
  while (index < 8) {
    if (Number(address[index]) === 0) {
      let run = 0;
      let k = index;
      while (k < 8 && Number(address[k]) === 0) {
        run = run + 1;
        k = k + 1;
      }
      if (run > longest) {
        longest = run;
        compress = index;
      }
      index = k;
    } else {
      index = index + 1;
    }
  }
  let out = "";
  let ignore0 = false;
  for (let i = 0; i < 8; i++) {
    if (ignore0) {
      if (Number(address[i]) === 0) continue;
      ignore0 = false;
    }
    if (compress === i) {
      out = out + (i === 0 ? "::" : ":");
      ignore0 = true;
      continue;
    }
    out = out + __wuHex(Number(address[i]));
    if (i !== 7) out = out + ":";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Host parsing (https://url.spec.whatwg.org/#host-parsing)
//
// A host travels through this file as its **serialization**: a domain or an
// IPv4 address as itself, an IPv6 address bracketed (`[::1]`), an empty host
// as `""`, and "no host" as `null`. That is exactly what `url.hostname`
// answers, and it keeps the record comparable field by field — which is what
// `assert.deepStrictEqual` over two `URL`s reduces to.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UTS#46, the part a runtime without ICU can carry
// ---------------------------------------------------------------------------
//
// Node calls into ICU for the whole of UTS#46. This runtime has no ICU
// (`common.hasIntl` is `false`, and Node's own IDNA tests are written
// `{ skip: !hasIntl }` for exactly such a build), so what is implemented here
// is the RFC 3492 encoding — `punycode.toASCII`, from
// `src/punycode/punycode.ts` — plus the three parts of UTS#46 processing that
// are a finite table rather than the whole Unicode database:
//
//   * the **ignored** code points, which are removed (soft hyphen, zero-width
//     space, word joiner, BOM, the combining grapheme joiner, the Mongolian
//     free variation selectors and the variation selectors);
//   * the **disallowed** code points, which make the host a parse failure
//     (U+FFFD REPLACEMENT CHARACTER — which is also what an invalid UTF-8
//     percent-escape decodes to — and every Unicode noncharacter);
//   * the **mapped** code points this file can map exactly: the fullwidth
//     forms U+FF01..U+FF5E, which fold onto ASCII (so `http://％４１.com`
//     reaches the `%` that the forbidden-domain check then rejects), and the
//     space-like code points that UTS#46 maps onto U+0020 (itself forbidden in
//     a domain).
//
// What is *not* here is the rest of the mapping and normalization tables: a
// label such as `xn--pokxncvks`, whose punycode decodes to code points that
// UTS#46 would have mapped away, is accepted here and rejected by ICU. That is
// one of seven residual divergences from Node over the 869-case WPT
// `urltestdata.json` corpus, all seven of them in this one table; see
// ../../test/url/README.md.

// IDNA status "ignored": removed from the domain.
function __wuIsIgnoredCodePoint(cp: number): boolean {
  if (cp === 0x00ad || cp === 0x034f || cp === 0x200b) return true;
  if (cp === 0x2060 || cp === 0xfeff) return true;
  if (cp >= 0x180b && cp <= 0x180d) return true;
  return cp >= 0xfe00 && cp <= 0xfe0f;
}

// IDNA status "disallowed", for the code points that are a closed set: the
// replacement character and every noncharacter.
function __wuIsDisallowedCodePoint(cp: number): boolean {
  if (cp === 0xfffd) return true;
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  return (cp & 0xfffe) === 0xfffe;
}

// The code points UTS#46 maps onto U+0020, which is a forbidden domain code
// point — so the mapping is what turns them into a parse failure.
function __wuIsSpaceMappedCodePoint(cp: number): boolean {
  if (cp === 0x00a0 || cp === 0x1680 || cp === 0x3000) return true;
  if (cp >= 0x2000 && cp <= 0x200a) return true;
  return cp === 0x202f || cp === 0x205f;
}

// UTS#46 mapping over `domain`: answers the mapped string, or `null` when a
// disallowed code point is present.
function __wuMapDomain(domain: string): any {
  const units: any = __wuUnits(domain);
  const n = __wuALen(units);
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let cp = __wuCode(units[i]);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
      const low = __wuCode(units[i + 1]);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + (cp - 0xd800) * 1024 + (low - 0xdc00);
        i = i + 1;
      }
    }
    i = i + 1;
    if (__wuIsIgnoredCodePoint(cp)) continue;
    if (__wuIsDisallowedCodePoint(cp)) return null;
    if (cp >= 0xff01 && cp <= 0xff5e) {
      out.push(String.fromCharCode(cp - 0xfee0));
      continue;
    }
    if (__wuIsSpaceMappedCodePoint(cp)) {
      out.push(" ");
      continue;
    }
    out.push(__wuFromCodePoint(cp));
  }
  return out.join("");
}

// A label already written in `xn--` form has to be ASCII and has to
// punycode-decode to something: `xn--`, `xn--iñvalid` and a label whose
// payload is not valid Bootstring are all failures, not domains. UTS#46 step
// 4.1 ("attempt to convert the rest of the label to Unicode"); the check runs
// on both the mapped input and the encoder's output, so it catches a label
// that arrived in `xn--` form *and* an empty one this file produced.
function __wuXnLabelsOk(domain: string): boolean {
  const labels: any = domain.split(".");
  for (let k = 0; k < __wuALen(labels); k++) {
    const label: string = labels[k] as string;
    if (__wuLen(label) < 4 || label.slice(0, 4).toLowerCase() !== "xn--") continue;
    const units: any = __wuUnits(label);
    for (let i = 0; i < __wuALen(units); i++) {
      if (__wuCode(units[i]) > 0x7f) return false;
    }
    let decoded = "";
    try {
      decoded = __pcDecode(label.slice(4));
    } catch (e: any) {
      return false;
    }
    if (decoded === "") return false;
  }
  return true;
}

function __wuDomainToASCII(domain: string, beStrict: boolean): any {
  const mapped = __wuMapDomain(domain);
  if (mapped === null) return null;
  const lowered: string = (mapped as string).toLowerCase();
  if (!__wuXnLabelsOk(lowered)) return null;
  // `__pcToASCII` never throws: a malformed label comes back as written, and
  // the checks below are what reject it.
  const ascii: string = __pcToASCII(lowered);
  if (ascii === "") return null;
  if (!__wuXnLabelsOk(ascii)) return null;
  const units: any = __wuUnits(ascii);
  const n = __wuALen(units);
  for (let i = 0; i < n; i++) {
    const c = __wuCode(units[i]);
    if (__wuIsForbiddenDomainCodePoint(c)) return null;
    if (beStrict && c > 0x7f) return null;
  }
  return ascii.toLowerCase();
}

// "opaque-host parsing": a forbidden host code point is a failure, and the
// rest is C0-percent-encoded.
function __wuParseOpaqueHost(input: string): any {
  const units: any = __wuUnits(input);
  const n = __wuALen(units);
  for (let i = 0; i < n; i++) {
    if (__wuIsForbiddenHostCodePoint(__wuCode(units[i]))) return null;
  }
  return __wuPercentEncode(input, __WU_SET_C0);
}

// The host parser. Answers the serialized host, or `null` for failure.
function __wuParseHost(input: string, isOpaque: boolean): any {
  const units: any = __wuUnits(input);
  const n = __wuALen(units);
  if (n > 0 && __wuCode(units[0]) === 0x5b) {
    if (__wuCode(units[n - 1]) !== 0x5d) return null;
    const address = __wuParseIPv6(__wuSub(units, 1, n - 1));
    if (address === null) return null;
    return "[" + __wuSerializeIPv6(address) + "]";
  }
  if (isOpaque) return __wuParseOpaqueHost(input);
  if (input === "") return null;
  const ascii = __wuDomainToASCII(__wuPercentDecode(input), false);
  if (ascii === null) return null;
  const asciiText: string = ascii as string;
  if (__wuEndsInNumber(asciiText)) {
    const address = __wuParseIPv4(asciiText);
    if (address < 0) return null;
    return __wuSerializeIPv4(address);
  }
  return asciiText;
}

// ---------------------------------------------------------------------------
// The URL record (https://url.spec.whatwg.org/#concept-url)
//
// A record is a plain class so that `assert.deepStrictEqual` over two `URL`
// objects reduces to a field-by-field comparison of two records, which is what
// `test-whatwg-url-custom-deepequal.js` asks for. `opaque` holds the path when
// the URL has an opaque path (`mailto:a@b`), and `path` holds the segment list
// otherwise; exactly one of the two is ever in use.
// ---------------------------------------------------------------------------

class __WUrlRecord {
  scheme: string = "";
  username: string = "";
  password: string = "";
  host: any = null;
  port: any = null;
  path: any = [];
  opaque: any = null;
  query: any = null;
  fragment: any = null;
}

function __wuHasOpaquePath(rec: any): boolean {
  return rec.opaque !== null;
}

function __wuIncludesCredentials(rec: any): boolean {
  return rec.username !== "" || rec.password !== "";
}

// "cannot have a username/password/port"
function __wuCannotHaveCredentials(rec: any): boolean {
  return rec.host === null || rec.host === "" || rec.scheme === "file";
}

// ---------------------------------------------------------------------------
// Windows drive letters and dot segments
// ---------------------------------------------------------------------------

function __wuIsWindowsDriveLetterAt(units: any, i: number, n: number): boolean {
  if (i + 1 >= n) return false;
  if (!__wuIsAsciiAlpha(__wuCode(units[i]))) return false;
  const second = __wuCode(units[i + 1]);
  return second === 0x3a || second === 0x7c;
}

function __wuIsWindowsDriveLetter(text: string): boolean {
  const units: any = __wuUnits(text);
  if (__wuALen(units) !== 2) return false;
  return __wuIsWindowsDriveLetterAt(units, 0, 2);
}

function __wuIsNormalizedWindowsDriveLetter(text: string): boolean {
  const units: any = __wuUnits(text);
  if (__wuALen(units) !== 2) return false;
  return __wuIsAsciiAlpha(__wuCode(units[0])) && __wuCode(units[1]) === 0x3a;
}

// "starts with a Windows drive letter": two code points that are a drive
// letter, and then either the end of the string or one of `/ \ ? #`.
function __wuStartsWithWindowsDriveLetter(units: any, i: number, n: number): boolean {
  if (!__wuIsWindowsDriveLetterAt(units, i, n)) return false;
  if (i + 2 === n) return true;
  const third = __wuCode(units[i + 2]);
  return third === 0x2f || third === 0x5c || third === 0x3f || third === 0x23;
}

function __wuIsSingleDotSegment(buffer: string): boolean {
  if (buffer === ".") return true;
  return buffer.toLowerCase() === "%2e";
}

function __wuIsDoubleDotSegment(buffer: string): boolean {
  if (buffer === "..") return true;
  const low = buffer.toLowerCase();
  return low === ".%2e" || low === "%2e." || low === "%2e%2e";
}

// "potentially strip trailing C0 control or space from an opaque path": only
// an opaque path with neither a query nor a fragment, and only at the end —
// the trailing spaces of `data:space ?query` become observable the moment the
// query is removed.
function __wuStripTrailingC0(rec: any): void {
  if (!__wuHasOpaquePath(rec)) return;
  if (rec.fragment !== null || rec.query !== null) return;
  const units: any = __wuUnits(rec.opaque as string);
  let n = __wuALen(units);
  while (n > 0 && __wuIsC0OrSpace(__wuCode(units[n - 1]))) n = n - 1;
  rec.opaque = __wuSub(units, 0, n);
}

// "shorten a URL's path"
function __wuShortenPath(rec: any): void {
  const size = __wuALen(rec.path);
  if (size === 0) return;
  if (
    rec.scheme === "file" && size === 1 &&
    __wuIsNormalizedWindowsDriveLetter(rec.path[0] as string)
  ) {
    return;
  }
  rec.path = rec.path.slice(0, size - 1);
}

// ---------------------------------------------------------------------------
// The basic URL parser (https://url.spec.whatwg.org/#concept-basic-url-parser)
//
// `stateOverride` is 0 for a normal parse and one of the `__WU_S_*` constants
// for a setter. Answers the record on success and `null` on failure, which is
// what every caller turns into Node's `ERR_INVALID_URL`.
// ---------------------------------------------------------------------------

const __WU_S_SCHEME_START = 1;
const __WU_S_SCHEME = 2;
const __WU_S_NO_SCHEME = 3;
const __WU_S_SPECIAL_RELATIVE_OR_AUTHORITY = 4;
const __WU_S_PATH_OR_AUTHORITY = 5;
const __WU_S_RELATIVE = 6;
const __WU_S_RELATIVE_SLASH = 7;
const __WU_S_SPECIAL_AUTHORITY_SLASHES = 8;
const __WU_S_SPECIAL_AUTHORITY_IGNORE_SLASHES = 9;
const __WU_S_AUTHORITY = 10;
const __WU_S_HOST = 11;
const __WU_S_HOSTNAME = 12;
const __WU_S_PORT = 13;
const __WU_S_FILE = 14;
const __WU_S_FILE_SLASH = 15;
const __WU_S_FILE_HOST = 16;
const __WU_S_PATH_START = 17;
const __WU_S_PATH = 18;
const __WU_S_OPAQUE_PATH = 19;
const __WU_S_QUERY = 20;
const __WU_S_FRAGMENT = 21;

// Strip leading and trailing C0 controls or spaces, then remove every ASCII
// tab or newline. Both are the parser's own first two steps.
function __wuSanitizeInput(input: string, trimEnds: boolean): string {
  const units: any = __wuUnits(input);
  let n = __wuALen(units);
  let start = 0;
  if (trimEnds) {
    while (start < n && __wuIsC0OrSpace(__wuCode(units[start]))) start = start + 1;
    while (n > start && __wuIsC0OrSpace(__wuCode(units[n - 1]))) n = n - 1;
  }
  const out: string[] = [];
  for (let i = start; i < n; i++) {
    if (__wuIsTabOrNewline(__wuCode(units[i]))) continue;
    out.push(units[i] as string);
  }
  return out.join("");
}

function __wuBasicParse(rawInput: string, base: any, stateOverride: number, recIn: any): any {
  let rec: any = recIn;
  const fresh = rec === null;
  if (fresh) rec = new __WUrlRecord();
  const input = __wuSanitizeInput(rawInput, fresh);
  const units: any = __wuUnits(input);
  const n = __wuALen(units);

  let state = stateOverride !== 0 ? stateOverride : __WU_S_SCHEME_START;
  let buffer = "";
  let atSignSeen = false;
  let insideBrackets = false;
  let passwordTokenSeen = false;
  let pointer = 0;
  let done = false;

  while (!done) {
    const c = __wuAt(units, pointer, n);
    const special = __wuIsSpecial(rec.scheme);

    if (state === __WU_S_SCHEME_START) {
      if (__wuIsAsciiAlpha(c)) {
        buffer = buffer + String.fromCharCode(__wuIsAsciiUpper(c) ? c + 32 : c);
        state = __WU_S_SCHEME;
      } else if (stateOverride === 0) {
        state = __WU_S_NO_SCHEME;
        pointer = pointer - 1;
      } else {
        return null;
      }
    } else if (state === __WU_S_SCHEME) {
      if (__wuIsAsciiAlphanumeric(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
        buffer = buffer + String.fromCharCode(__wuIsAsciiUpper(c) ? c + 32 : c);
      } else if (c === 0x3a) {
        if (stateOverride !== 0) {
          if (special && !__wuIsSpecial(buffer)) return rec;
          if (!special && __wuIsSpecial(buffer)) return rec;
          if ((__wuIncludesCredentials(rec) || rec.port !== null) && buffer === "file") return rec;
          if (rec.scheme === "file" && rec.host === "") return rec;
        }
        rec.scheme = buffer;
        if (stateOverride !== 0) {
          if (rec.port !== null && rec.port === __wuDefaultPort(rec.scheme)) rec.port = null;
          return rec;
        }
        buffer = "";
        if (rec.scheme === "file") {
          state = __WU_S_FILE;
        } else if (
          __wuIsSpecial(rec.scheme) && base !== null && base.scheme === rec.scheme
        ) {
          state = __WU_S_SPECIAL_RELATIVE_OR_AUTHORITY;
        } else if (__wuIsSpecial(rec.scheme)) {
          state = __WU_S_SPECIAL_AUTHORITY_SLASHES;
        } else if (__wuAt(units, pointer + 1, n) === 0x2f) {
          state = __WU_S_PATH_OR_AUTHORITY;
          pointer = pointer + 1;
        } else {
          rec.opaque = "";
          state = __WU_S_OPAQUE_PATH;
        }
      } else if (stateOverride === 0) {
        buffer = "";
        state = __WU_S_NO_SCHEME;
        pointer = -1;
      } else {
        return null;
      }
    } else if (state === __WU_S_NO_SCHEME) {
      if (base === null || (__wuHasOpaquePath(base) && c !== 0x23)) return null;
      if (__wuHasOpaquePath(base) && c === 0x23) {
        rec.scheme = base.scheme;
        rec.opaque = base.opaque;
        rec.path = [];
        rec.query = base.query;
        rec.fragment = "";
        state = __WU_S_FRAGMENT;
      } else if (base.scheme !== "file") {
        state = __WU_S_RELATIVE;
        pointer = pointer - 1;
      } else {
        state = __WU_S_FILE;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_SPECIAL_RELATIVE_OR_AUTHORITY) {
      if (c === 0x2f && __wuAt(units, pointer + 1, n) === 0x2f) {
        state = __WU_S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
        pointer = pointer + 1;
      } else {
        state = __WU_S_RELATIVE;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_PATH_OR_AUTHORITY) {
      if (c === 0x2f) {
        state = __WU_S_AUTHORITY;
      } else {
        state = __WU_S_PATH;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_RELATIVE) {
      rec.scheme = base.scheme;
      if (c === 0x2f || (__wuIsSpecial(rec.scheme) && c === 0x5c)) {
        state = __WU_S_RELATIVE_SLASH;
      } else {
        rec.username = base.username;
        rec.password = base.password;
        rec.host = base.host;
        rec.port = base.port;
        rec.opaque = base.opaque;
        const copy: string[] = [];
        for (let i = 0; i < __wuALen(base.path); i++) copy.push(base.path[i] as string);
        rec.path = copy;
        rec.query = base.query;
        if (c === 0x3f) {
          rec.query = "";
          state = __WU_S_QUERY;
        } else if (c === 0x23) {
          rec.fragment = "";
          state = __WU_S_FRAGMENT;
        } else if (c !== -1) {
          rec.query = null;
          __wuShortenPath(rec);
          state = __WU_S_PATH;
          pointer = pointer - 1;
        }
      }
    } else if (state === __WU_S_RELATIVE_SLASH) {
      if (__wuIsSpecial(rec.scheme) && (c === 0x2f || c === 0x5c)) {
        state = __WU_S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
      } else if (c === 0x2f) {
        state = __WU_S_AUTHORITY;
      } else {
        rec.username = base.username;
        rec.password = base.password;
        rec.host = base.host;
        rec.port = base.port;
        state = __WU_S_PATH;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_SPECIAL_AUTHORITY_SLASHES) {
      if (c === 0x2f && __wuAt(units, pointer + 1, n) === 0x2f) {
        state = __WU_S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
        pointer = pointer + 1;
      } else {
        state = __WU_S_SPECIAL_AUTHORITY_IGNORE_SLASHES;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_SPECIAL_AUTHORITY_IGNORE_SLASHES) {
      if (c !== 0x2f && c !== 0x5c) {
        state = __WU_S_AUTHORITY;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_AUTHORITY) {
      if (c === 0x40) {
        if (atSignSeen) buffer = "%40" + buffer;
        atSignSeen = true;
        const bufUnits: any = __wuUnits(buffer);
        const bufLen = __wuALen(bufUnits);
        let bi = 0;
        while (bi < bufLen) {
          const code = __wuCode(bufUnits[bi]);
          if (code === 0x3a && !passwordTokenSeen) {
            passwordTokenSeen = true;
            bi = bi + 1;
            continue;
          }
          // One code *point* at a time, so a surrogate pair is taken whole.
          let piece: string = bufUnits[bi] as string;
          if (code >= 0xd800 && code <= 0xdbff && bi + 1 < bufLen) {
            const low = __wuCode(bufUnits[bi + 1]);
            if (low >= 0xdc00 && low <= 0xdfff) {
              piece = piece + (bufUnits[bi + 1] as string);
              bi = bi + 1;
            }
          }
          const encoded = __wuPercentEncode(piece, __WU_SET_USERINFO);
          if (passwordTokenSeen) rec.password = rec.password + encoded;
          else rec.username = rec.username + encoded;
          bi = bi + 1;
        }
        buffer = "";
      } else if (
        c === -1 || c === 0x2f || c === 0x3f || c === 0x23 ||
        (__wuIsSpecial(rec.scheme) && c === 0x5c)
      ) {
        if (atSignSeen && buffer === "") return null;
        pointer = pointer - (__wuLen(buffer) + 1);
        buffer = "";
        state = __WU_S_HOST;
      } else {
        buffer = buffer + String.fromCharCode(c);
      }
    } else if (state === __WU_S_HOST || state === __WU_S_HOSTNAME) {
      if (stateOverride !== 0 && rec.scheme === "file") {
        pointer = pointer - 1;
        state = __WU_S_FILE_HOST;
      } else if (c === 0x3a && !insideBrackets) {
        if (buffer === "") return null;
        if (stateOverride === __WU_S_HOSTNAME) return rec;
        const hostValue = __wuParseHost(buffer, !__wuIsSpecial(rec.scheme));
        if (hostValue === null) return null;
        rec.host = hostValue;
        buffer = "";
        state = __WU_S_PORT;
      } else if (
        c === -1 || c === 0x2f || c === 0x3f || c === 0x23 ||
        (__wuIsSpecial(rec.scheme) && c === 0x5c)
      ) {
        pointer = pointer - 1;
        if (__wuIsSpecial(rec.scheme) && buffer === "") {
          return null;
        } else if (
          stateOverride !== 0 && buffer === "" &&
          (__wuIncludesCredentials(rec) || rec.port !== null)
        ) {
          return rec;
        }
        const hostValue = __wuParseHost(buffer, !__wuIsSpecial(rec.scheme));
        if (hostValue === null) return null;
        rec.host = hostValue;
        buffer = "";
        state = __WU_S_PATH_START;
        if (stateOverride !== 0) return rec;
      } else {
        if (c === 0x5b) insideBrackets = true;
        if (c === 0x5d) insideBrackets = false;
        buffer = buffer + String.fromCharCode(c);
      }
    } else if (state === __WU_S_PORT) {
      if (__wuIsAsciiDigit(c)) {
        buffer = buffer + String.fromCharCode(c);
      } else if (
        c === -1 || c === 0x2f || c === 0x3f || c === 0x23 ||
        (__wuIsSpecial(rec.scheme) && c === 0x5c) || stateOverride !== 0
      ) {
        if (buffer !== "") {
          const bufUnits: any = __wuUnits(buffer);
          let port = 0;
          for (let i = 0; i < __wuALen(bufUnits); i++) {
            port = port * 10 + (__wuCode(bufUnits[i]) - 0x30);
            if (port > 65535) return null;
          }
          rec.port = port === __wuDefaultPort(rec.scheme) ? null : port;
          buffer = "";
        }
        if (stateOverride !== 0) return rec;
        state = __WU_S_PATH_START;
        pointer = pointer - 1;
      } else {
        return null;
      }
    } else if (state === __WU_S_FILE) {
      rec.scheme = "file";
      rec.host = "";
      if (c === 0x2f || c === 0x5c) {
        state = __WU_S_FILE_SLASH;
      } else if (base !== null && base.scheme === "file") {
        rec.host = base.host;
        const copy: string[] = [];
        for (let i = 0; i < __wuALen(base.path); i++) copy.push(base.path[i] as string);
        rec.path = copy;
        rec.query = base.query;
        if (c === 0x3f) {
          rec.query = "";
          state = __WU_S_QUERY;
        } else if (c === 0x23) {
          rec.fragment = "";
          state = __WU_S_FRAGMENT;
        } else if (c !== -1) {
          rec.query = null;
          if (!__wuStartsWithWindowsDriveLetter(units, pointer, n)) {
            __wuShortenPath(rec);
          } else {
            rec.path = [];
          }
          state = __WU_S_PATH;
          pointer = pointer - 1;
        }
      } else {
        state = __WU_S_PATH;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_FILE_SLASH) {
      if (c === 0x2f || c === 0x5c) {
        state = __WU_S_FILE_HOST;
      } else {
        if (base !== null && base.scheme === "file") {
          rec.host = base.host;
          if (
            !__wuStartsWithWindowsDriveLetter(units, pointer, n) &&
            __wuALen(base.path) > 0 &&
            __wuIsNormalizedWindowsDriveLetter(base.path[0] as string)
          ) {
            rec.path.push(base.path[0] as string);
          }
        }
        state = __WU_S_PATH;
        pointer = pointer - 1;
      }
    } else if (state === __WU_S_FILE_HOST) {
      if (c === -1 || c === 0x2f || c === 0x5c || c === 0x3f || c === 0x23) {
        pointer = pointer - 1;
        if (stateOverride === 0 && __wuIsWindowsDriveLetter(buffer)) {
          state = __WU_S_PATH;
        } else if (buffer === "") {
          rec.host = "";
          if (stateOverride !== 0) return rec;
          state = __WU_S_PATH_START;
        } else {
          let hostValue = __wuParseHost(buffer, !__wuIsSpecial(rec.scheme));
          if (hostValue === null) return null;
          if (hostValue === "localhost") hostValue = "";
          rec.host = hostValue;
          if (stateOverride !== 0) return rec;
          buffer = "";
          state = __WU_S_PATH_START;
        }
      } else {
        buffer = buffer + String.fromCharCode(c);
      }
    } else if (state === __WU_S_PATH_START) {
      if (__wuIsSpecial(rec.scheme)) {
        state = __WU_S_PATH;
        if (c !== 0x2f && c !== 0x5c) pointer = pointer - 1;
      } else if (stateOverride === 0 && c === 0x3f) {
        rec.query = "";
        state = __WU_S_QUERY;
      } else if (stateOverride === 0 && c === 0x23) {
        rec.fragment = "";
        state = __WU_S_FRAGMENT;
      } else if (c !== -1) {
        state = __WU_S_PATH;
        if (c !== 0x2f) pointer = pointer - 1;
      } else if (stateOverride !== 0 && rec.host === null) {
        rec.path.push("");
      }
    } else if (state === __WU_S_PATH) {
      const isSlashEnd = c === 0x2f || (__wuIsSpecial(rec.scheme) && c === 0x5c);
      if (
        c === -1 || isSlashEnd ||
        (stateOverride === 0 && (c === 0x3f || c === 0x23))
      ) {
        if (__wuIsDoubleDotSegment(buffer)) {
          __wuShortenPath(rec);
          if (!isSlashEnd) rec.path.push("");
        } else if (__wuIsSingleDotSegment(buffer)) {
          if (!isSlashEnd) rec.path.push("");
        } else {
          let segment = buffer;
          if (
            rec.scheme === "file" && __wuALen(rec.path) === 0 &&
            __wuIsWindowsDriveLetter(segment)
          ) {
            segment = segment.slice(0, 1) + ":";
          }
          rec.path.push(segment);
        }
        buffer = "";
        if (c === 0x3f) {
          rec.query = "";
          state = __WU_S_QUERY;
        } else if (c === 0x23) {
          rec.fragment = "";
          state = __WU_S_FRAGMENT;
        }
      } else {
        let piece = String.fromCharCode(c);
        if (c >= 0xd800 && c <= 0xdbff) {
          const low = __wuAt(units, pointer + 1, n);
          if (low >= 0xdc00 && low <= 0xdfff) {
            piece = piece + String.fromCharCode(low);
            pointer = pointer + 1;
          }
        }
        buffer = buffer + __wuPercentEncode(piece, __WU_SET_PATH);
      }
    } else if (state === __WU_S_OPAQUE_PATH) {
      if (c === 0x3f) {
        rec.query = "";
        state = __WU_S_QUERY;
      } else if (c === 0x23) {
        rec.fragment = "";
        state = __WU_S_FRAGMENT;
      } else if (c !== -1) {
        let piece = String.fromCharCode(c);
        if (c >= 0xd800 && c <= 0xdbff) {
          const low = __wuAt(units, pointer + 1, n);
          if (low >= 0xdc00 && low <= 0xdfff) {
            piece = piece + String.fromCharCode(low);
            pointer = pointer + 1;
          }
        }
        rec.opaque = (rec.opaque as string) + __wuPercentEncode(piece, __WU_SET_C0);
      }
    } else if (state === __WU_S_QUERY) {
      if (stateOverride === 0 && c === 0x23) {
        rec.fragment = "";
        state = __WU_S_FRAGMENT;
      } else if (c !== -1) {
        let piece = String.fromCharCode(c);
        if (c >= 0xd800 && c <= 0xdbff) {
          const low = __wuAt(units, pointer + 1, n);
          if (low >= 0xdc00 && low <= 0xdfff) {
            piece = piece + String.fromCharCode(low);
            pointer = pointer + 1;
          }
        }
        const set = __wuIsSpecial(rec.scheme) ? __WU_SET_SPECIAL_QUERY : __WU_SET_QUERY;
        const soFar: string = rec.query === null ? "" : (rec.query as string);
        rec.query = soFar + __wuPercentEncode(piece, set);
      }
    } else if (state === __WU_S_FRAGMENT) {
      if (c !== -1) {
        let piece = String.fromCharCode(c);
        if (c >= 0xd800 && c <= 0xdbff) {
          const low = __wuAt(units, pointer + 1, n);
          if (low >= 0xdc00 && low <= 0xdfff) {
            piece = piece + String.fromCharCode(low);
            pointer = pointer + 1;
          }
        }
        rec.fragment =
          (rec.fragment === null ? "" : (rec.fragment as string)) +
          __wuPercentEncode(piece, __WU_SET_FRAGMENT);
      }
    }

    if (pointer >= n) {
      done = true;
    } else {
      pointer = pointer + 1;
    }
  }
  return rec;
}

// ---------------------------------------------------------------------------
// Serialization (https://url.spec.whatwg.org/#url-serializing)
// ---------------------------------------------------------------------------

function __wuSerializePath(rec: any): string {
  if (__wuHasOpaquePath(rec)) return rec.opaque as string;
  const out: string[] = [];
  for (let i = 0; i < __wuALen(rec.path); i++) {
    out.push("/");
    out.push(rec.path[i] as string);
  }
  return out.join("");
}

function __wuSerializeURL(rec: any, excludeFragment: boolean): string {
  let out = rec.scheme + ":";
  if (rec.host !== null) {
    out = out + "//";
    if (__wuIncludesCredentials(rec)) {
      out = out + rec.username;
      if (rec.password !== "") out = out + ":" + rec.password;
      out = out + "@";
    }
    out = out + (rec.host as string);
    if (rec.port !== null) out = out + ":" + String(rec.port);
  } else if (
    rec.host === null && !__wuHasOpaquePath(rec) &&
    __wuALen(rec.path) > 1 && (rec.path[0] as string) === ""
  ) {
    // Without this a path starting with an empty segment would re-parse as an
    // authority: `/.//p` must not become `//p`.
    out = out + "/.";
  }
  out = out + __wuSerializePath(rec);
  if (rec.query !== null) out = out + "?" + (rec.query as string);
  if (!excludeFragment && rec.fragment !== null) out = out + "#" + (rec.fragment as string);
  return out;
}

function __wuSerializeHostPort(rec: any): string {
  let out = rec.host === null ? "" : (rec.host as string);
  if (rec.port !== null) out = out + ":" + String(rec.port);
  return out;
}

// The origin (https://url.spec.whatwg.org/#concept-url-origin): a tuple for
// the five special non-`file` schemes, the inner URL's origin for `blob:`, and
// the opaque origin — serialized as the string "null" — for everything else.
function __wuSerializeOrigin(rec: any): string {
  const scheme = rec.scheme;
  if (scheme === "blob") {
    if (__wuHasOpaquePath(rec)) {
      const inner = __wuBasicParse(rec.opaque as string, null, 0, null);
      if (inner !== null) {
        const innerScheme = inner.scheme;
        if (innerScheme === "http" || innerScheme === "https" || innerScheme === "file") {
          return __wuSerializeOrigin(inner);
        }
      }
    }
    return "null";
  }
  if (
    scheme === "ftp" || scheme === "http" || scheme === "https" ||
    scheme === "ws" || scheme === "wss"
  ) {
    return scheme + "://" + __wuSerializeHostPort(rec);
  }
  return "null";
}

// ---------------------------------------------------------------------------
// application/x-www-form-urlencoded
// (https://url.spec.whatwg.org/#application-x-www-form-urlencoded)
// ---------------------------------------------------------------------------

// The urlencoded serializer: the urlencoded percent-encode set, with U+0020
// written as `+` rather than `%20`.
function __wuUrlencodedSerializeString(text: string): string {
  const units: any = __wuUnits(text);
  const n = __wuALen(units);
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let cp = __wuCode(units[i]);
    if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
      const low = __wuCode(units[i + 1]);
      if (low >= 0xdc00 && low <= 0xdfff) {
        cp = 0x10000 + (cp - 0xd800) * 1024 + (low - 0xdc00);
        i = i + 1;
      }
    }
    if (cp === 0x20) {
      out.push("+");
    } else {
      __wuEncodeCodePoint(out, cp, __WU_SET_URLENCODED);
    }
    i = i + 1;
  }
  return out.join("");
}

// The urlencoded parser, over a string: `+` becomes a space, then each half is
// percent-decoded and UTF-8 decoded.
function __wuUrlencodedParse(input: string): any {
  const pairs: any = [];
  const sequences: any = input.split("&");
  for (let i = 0; i < __wuALen(sequences); i++) {
    const bytes: string = sequences[i] as string;
    if (bytes === "") continue;
    let name = bytes;
    let value = "";
    const eq = Number(bytes.indexOf("="));
    if (eq >= 0) {
      name = bytes.slice(0, eq);
      value = bytes.slice(eq + 1);
    }
    pairs.push([
      __wuPercentDecode(__wuReplacePlus(name)),
      __wuPercentDecode(__wuReplacePlus(value)),
    ]);
  }
  return pairs;
}

function __wuReplacePlus(text: string): string {
  if (Number(text.indexOf("+")) < 0) return text;
  const parts: any = text.split("+");
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Node's `ERR_INVALID_THIS`
// ---------------------------------------------------------------------------

class ERR_INVALID_THIS extends NodeTypeError {
  constructor(type: string) {
    super("ERR_INVALID_THIS", 'Value of "this" must be of type ' + type);
  }
}

// `ToUSVString`-ish argument conversion. Node converts every
// `URLSearchParams` argument with `String(x)`, and a symbol legitimately
// throws rather than answering `Symbol(x)` — which `String(aSymbol)` would, so
// the rejection is written out rather than delegated (the same note
// `querystring.ts`' `__qsToString` carries).
// Engine workaround (https://github.com/UrubuCode/zun/issues/17): a function
// that travelled through an array — which is what a rest parameter is — comes
// back boxed, and calling it directly answers "call did not resolve to a
// method". The same unboxing `url.ts`' `__urlCall` does.
function __wuCall3(fn: any, a: any, b: any, c: any): any {
  let callable: any = fn;
  if (fn !== null && fn !== undefined && typeof fn === "object") {
    const inner: any = fn["__boxedFn"];
    if (inner !== undefined) callable = inner;
  }
  return callable(a, b, c);
}

function __wuToString(value: any): string {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  if (typeof value === "string") return value;
  return String(value);
}

// ---------------------------------------------------------------------------
// URLSearchParams
//
// The list is an array of two-element arrays, which is what the standard's
// "list of name-value tuples" is. `owner` is the `URL` whose `search` this
// list backs, or `null` for a free-standing `URLSearchParams`; every mutating
// method writes the serialization back through it, which is what makes
// `url.searchParams.append(...)` change `url.href`.
// ---------------------------------------------------------------------------

class NodeURLSearchParams {
  list: any = [];
  owner: any = null;

  constructor(init?: any) {
    if (init === undefined || init === null) return;
    if (typeof init === "string") {
      let text = init;
      if (__wuLen(text) > 0 && text.slice(0, 1) === "?") text = text.slice(1);
      this.list = __wuUrlencodedParse(text);
      return;
    }
    if (typeof init === "object") {
      // A `URLSearchParams` is copied as a sequence of its own pairs.
      if (init instanceof NodeURLSearchParams) {
        const other: any = init;
        const copy: any = [];
        for (let i = 0; i < __wuALen(other.list); i++) {
          copy.push([other.list[i][0] as string, other.list[i][1] as string]);
        }
        this.list = copy;
        return;
      }
      if (Array.isArray(init)) {
        const seq: any = init;
        const built: any = [];
        for (let i = 0; i < __wuALen(seq); i++) {
          const pair: any = seq[i];
          if (pair === null || pair === undefined || !Array.isArray(pair) || __wuALen(pair) !== 2) {
            throw new NodeTypeError(
              "ERR_INVALID_TUPLE",
              "Each query pair must be an iterable [name, value] tuple",
            );
          }
          built.push([__wuToString(pair[0]), __wuToString(pair[1])]);
        }
        this.list = built;
        return;
      }
      // A record: every own enumerable key, in insertion order.
      const keys: any = Object.keys(init);
      const built: any = [];
      for (let i = 0; i < __wuALen(keys); i++) {
        const key: string = keys[i] as string;
        built.push([__wuToString(key), __wuToString(init[key])]);
      }
      this.list = built;
      return;
    }
    // A primitive that is not a string is stringified, as Node does.
    const text = __wuToString(init);
    this.list = __wuUrlencodedParse(
      __wuLen(text) > 0 && text.slice(0, 1) === "?" ? text.slice(1) : text,
    );
  }

  // Every method takes a rest parameter rather than optional parameters: the
  // checker counts `name?: any, value?: any, ...rest: any[]` as two *required*
  // parameters and rejects `params.has("a")` at compile time ("`has` expects
  // at least 2 argument(s)"), and Node's own tests call each of these with
  // fewer arguments than it declares, on purpose, to see the
  // `ERR_MISSING_ARGS` it answers.
  append(...args: any[]): void {
    if (__wuALen(args) < 2) throw new ERR_MISSING_ARGS("name", "value");
    this.list.push([__wuToString(args[0]), __wuToString(args[1])]);
    this.update();
  }

  delete(...args: any[]): void {
    if (__wuALen(args) < 1) throw new ERR_MISSING_ARGS("name");
    const key = __wuToString(args[0]);
    const hasValue = __wuALen(args) > 1 && args[1] !== undefined;
    const target = hasValue ? __wuToString(args[1]) : "";
    const keep: any = [];
    for (let i = 0; i < __wuALen(this.list); i++) {
      const pair: any = this.list[i];
      if ((pair[0] as string) === key) {
        if (!hasValue) continue;
        if ((pair[1] as string) === target) continue;
      }
      keep.push(pair);
    }
    this.list = keep;
    this.update();
  }

  get(...args: any[]): any {
    if (__wuALen(args) < 1) throw new ERR_MISSING_ARGS("name");
    const key = __wuToString(args[0]);
    for (let i = 0; i < __wuALen(this.list); i++) {
      if ((this.list[i][0] as string) === key) return this.list[i][1] as string;
    }
    return null;
  }

  getAll(...args: any[]): any {
    if (__wuALen(args) < 1) throw new ERR_MISSING_ARGS("name");
    const key = __wuToString(args[0]);
    const out: string[] = [];
    for (let i = 0; i < __wuALen(this.list); i++) {
      if ((this.list[i][0] as string) === key) out.push(this.list[i][1] as string);
    }
    return out;
  }

  has(...args: any[]): boolean {
    if (__wuALen(args) < 1) throw new ERR_MISSING_ARGS("name");
    const key = __wuToString(args[0]);
    const hasValue = __wuALen(args) > 1 && args[1] !== undefined;
    const target = hasValue ? __wuToString(args[1]) : "";
    for (let i = 0; i < __wuALen(this.list); i++) {
      const pair: any = this.list[i];
      if ((pair[0] as string) !== key) continue;
      if (!hasValue) return true;
      if ((pair[1] as string) === target) return true;
    }
    return false;
  }

  set(...args: any[]): void {
    if (__wuALen(args) < 2) throw new ERR_MISSING_ARGS("name", "value");
    const key = __wuToString(args[0]);
    const text = __wuToString(args[1]);
    const out: any = [];
    let written = false;
    for (let i = 0; i < __wuALen(this.list); i++) {
      const pair: any = this.list[i];
      if ((pair[0] as string) !== key) {
        out.push(pair);
        continue;
      }
      if (written) continue;
      out.push([key, text]);
      written = true;
    }
    if (!written) out.push([key, text]);
    this.list = out;
    this.update();
  }

  // A **stable** sort by code unit, as the standard requires. `Array.sort` is
  // not specified to be stable here, so the comparison falls back to the
  // original index.
  sort(): void {
    const n = __wuALen(this.list);
    const tagged: any = [];
    for (let i = 0; i < n; i++) tagged.push([this.list[i], i]);
    const cmp: any = function (a: any, b: any): number {
      const an: string = a[0][0] as string;
      const bn: string = b[0][0] as string;
      if (an < bn) return -1;
      if (an > bn) return 1;
      return Number(a[1]) - Number(b[1]);
    };
    tagged.sort(cmp);
    const out: any = [];
    for (let i = 0; i < n; i++) out.push(tagged[i][0]);
    this.list = out;
    this.update();
  }

  // `callback` is a *named* parameter where every other method here takes a
  // rest parameter, and it has to be: passing a function value into a
  // rest-only parameter list fails at the call site on this engine with "call
  // did not resolve to a method" — for a function expression written inline
  // just as much as for an `any` holding one. A named leading parameter
  // followed by a rest parameter is fine. Reported with this work; the cost is
  // that `params.forEach()` with no argument is a compile error here rather
  // than the `ERR_MISSING_ARGS` Node answers.
  forEach(callback: any, ...rest: any[]): void {
    if (callback === undefined) throw new ERR_MISSING_ARGS("callback");
    // The list is re-read on every step, as the standard's iteration does, so
    // a callback that appends is observed.
    let i = 0;
    while (i < __wuALen(this.list)) {
      const pair: any = this.list[i];
      __wuCall3(callback, pair[1] as string, pair[0] as string, this);
      i = i + 1;
    }
  }

  keys(): any {
    const out: string[] = [];
    for (let i = 0; i < __wuALen(this.list); i++) out.push(this.list[i][0] as string);
    return __wuMakeIterator(out, "URLSearchParams Iterator");
  }

  values(): any {
    const out: string[] = [];
    for (let i = 0; i < __wuALen(this.list); i++) out.push(this.list[i][1] as string);
    return __wuMakeIterator(out, "URLSearchParams Iterator");
  }

  entries(): any {
    const out: any = [];
    for (let i = 0; i < __wuALen(this.list); i++) {
      out.push([this.list[i][0] as string, this.list[i][1] as string]);
    }
    return __wuMakeIterator(out, "URLSearchParams Iterator");
  }

  get size(): number {
    return __wuALen(this.list);
  }

  toString(): string {
    const out: string[] = [];
    for (let i = 0; i < __wuALen(this.list); i++) {
      if (i > 0) out.push("&");
      out.push(__wuUrlencodedSerializeString(this.list[i][0] as string));
      out.push("=");
      out.push(__wuUrlencodedSerializeString(this.list[i][1] as string));
    }
    return out.join("");
  }

  // Write the serialization back into the URL this list backs. An empty list
  // makes the URL's query `null`, which is what drops the `?` from `href`.
  update(): void {
    if (this.owner === null) return;
    const owner: any = this.owner;
    const text = this.toString();
    owner.rec.query = text === "" ? null : text;
  }
}

// An iterator-ish object: `next()`, an `items` array (which is what a `for
// (... of ...)` over it reaches for on this engine) and a `length`. A real
// ECMAScript iterator would need `Symbol.iterator`, which is not available
// here (see the header note).
function __wuMakeIterator(items: any, tag: string): any {
  let index = 0;
  const it: any = {
    items: items,
    length: __wuALen(items),
    tag: tag,
    next: function (...rest: any[]): any {
      if (index >= __wuALen(items)) {
        return { value: undefined, done: true };
      }
      const value: any = items[index];
      index = index + 1;
      return { value: value, done: false };
    },
  };
  return it;
}

// ---------------------------------------------------------------------------
// URL
//
// `rec` is the URL record and `sp` the lazily built `URLSearchParams` bound to
// it. `sp` stays `null` until something asks for `searchParams`, which is both
// what Node does and what makes `assert.deepStrictEqual(urlA, urlB)` reduce to
// a comparison of two records (`test-whatwg-url-custom-deepequal.js`).
// ---------------------------------------------------------------------------

// A marker only this file can produce, so the constructor can also be used to
// wrap an already-parsed record without re-parsing its serialization.
const __WU_WRAP: any = { wrap: true };

function __wuBaseRecord(base: any): any {
  if (base === undefined || base === null) return null;
  if (base instanceof NodeURL) return (base as any).rec;
  return __wuBasicParse(__wuToString(base), null, 0, null);
}

// Parse `input` against `base`, answering the record or `null`. A base that
// does not parse is a failure of the whole operation, as the standard says.
function __wuParseFrom(input: any, base: any): any {
  let baseRec: any = null;
  if (base !== undefined && base !== null) {
    baseRec = __wuBaseRecord(base);
    if (baseRec === null) return null;
  }
  return __wuBasicParse(__wuToString(input), baseRec, 0, null);
}

class NodeURL {
  rec: any = null;
  sp: any = null;

  constructor(...args: any[]) {
    if (__wuALen(args) === 3 && args[0] === __WU_WRAP) {
      this.rec = args[1];
      return;
    }
    if (__wuALen(args) < 1) throw new ERR_MISSING_ARGS("url");
    const parsed = __wuParseFrom(args[0], args[1]);
    if (parsed === null) throw new ERR_INVALID_URL(__wuToString(args[0]));
    this.rec = parsed;
  }

  // Re-point the bound `URLSearchParams` (if one was ever handed out) at the
  // record's current query. Every operation that rewrites the query wholesale
  // — the `href` and `search` setters — ends with this.
  resync(): void {
    if (this.sp === null) return;
    const params: any = this.sp;
    params.list = this.rec.query === null ? [] : __wuUrlencodedParse(this.rec.query as string);
  }

  get href(): string {
    return __wuSerializeURL(this.rec, false);
  }

  set href(value: any) {
    const parsed = __wuBasicParse(__wuToString(value), null, 0, null);
    if (parsed === null) throw new ERR_INVALID_URL(__wuToString(value));
    this.rec = parsed;
    this.resync();
  }

  get origin(): string {
    return __wuSerializeOrigin(this.rec);
  }

  get protocol(): string {
    return this.rec.scheme + ":";
  }

  set protocol(value: any) {
    __wuBasicParse(__wuToString(value) + ":", null, __WU_S_SCHEME_START, this.rec);
  }

  get username(): string {
    return this.rec.username as string;
  }

  set username(value: any) {
    if (__wuCannotHaveCredentials(this.rec)) return;
    this.rec.username = __wuPercentEncode(__wuToString(value), __WU_SET_USERINFO);
  }

  get password(): string {
    return this.rec.password as string;
  }

  set password(value: any) {
    if (__wuCannotHaveCredentials(this.rec)) return;
    this.rec.password = __wuPercentEncode(__wuToString(value), __WU_SET_USERINFO);
  }

  get host(): string {
    return __wuSerializeHostPort(this.rec);
  }

  set host(value: any) {
    if (__wuHasOpaquePath(this.rec)) return;
    __wuBasicParse(__wuToString(value), null, __WU_S_HOST, this.rec);
  }

  get hostname(): string {
    return this.rec.host === null ? "" : (this.rec.host as string);
  }

  set hostname(value: any) {
    if (__wuHasOpaquePath(this.rec)) return;
    __wuBasicParse(__wuToString(value), null, __WU_S_HOSTNAME, this.rec);
  }

  get port(): string {
    return this.rec.port === null ? "" : String(this.rec.port);
  }

  set port(value: any) {
    if (__wuCannotHaveCredentials(this.rec)) return;
    const text = __wuToString(value);
    if (text === "") {
      this.rec.port = null;
      return;
    }
    __wuBasicParse(text, null, __WU_S_PORT, this.rec);
  }

  get pathname(): string {
    return __wuSerializePath(this.rec);
  }

  set pathname(value: any) {
    if (__wuHasOpaquePath(this.rec)) return;
    this.rec.path = [];
    __wuBasicParse(__wuToString(value), null, __WU_S_PATH_START, this.rec);
  }

  get search(): string {
    if (this.rec.query === null || this.rec.query === "") return "";
    return "?" + (this.rec.query as string);
  }

  set search(value: any) {
    const text = __wuToString(value);
    if (text === "") {
      this.rec.query = null;
      this.resync();
      __wuStripTrailingC0(this.rec);
      return;
    }
    const input = text.slice(0, 1) === "?" ? text.slice(1) : text;
    this.rec.query = "";
    __wuBasicParse(input, null, __WU_S_QUERY, this.rec);
    this.resync();
  }

  get searchParams(): any {
    if (this.sp === null) {
      const text: string = this.rec.query === null ? "" : (this.rec.query as string);
      const params: any = new NodeURLSearchParams(text);
      params.owner = this;
      this.sp = params;
    }
    return this.sp;
  }

  get hash(): string {
    if (this.rec.fragment === null || this.rec.fragment === "") return "";
    return "#" + (this.rec.fragment as string);
  }

  set hash(value: any) {
    const text = __wuToString(value);
    if (text === "") {
      this.rec.fragment = null;
      __wuStripTrailingC0(this.rec);
      return;
    }
    const input = text.slice(0, 1) === "#" ? text.slice(1) : text;
    this.rec.fragment = "";
    __wuBasicParse(input, null, __WU_S_FRAGMENT, this.rec);
  }

  toString(): string {
    return __wuSerializeURL(this.rec, false);
  }

  toJSON(): string {
    return __wuSerializeURL(this.rec, false);
  }

  // The statics take **optional parameters**, not a rest parameter: a `static`
  // declared `(...args: any[])` is typed as taking one *array* argument by the
  // checker, so `URL.canParse('https://example.org')` is rejected with
  // "argument type String does not match Array". The instance methods above
  // have the opposite constraint; both are engine quirks, reported with this
  // work.
  static canParse(input?: any, base?: any): boolean {
    if (input === undefined) throw new ERR_MISSING_ARGS("url");
    return __wuParseFrom(input, base) !== null;
  }

  static parse(input?: any, base?: any): any {
    if (input === undefined) throw new ERR_MISSING_ARGS("url");
    const parsed = __wuParseFrom(input, base);
    if (parsed === null) return null;
    return new NodeURL(__WU_WRAP, parsed, null);
  }

  // Node installs these two onto `URL` at bootstrap, over `node:buffer`'s
  // `Blob`. `Blob` is not implemented here, so the argument check — which is
  // the whole of what Node's own `test-url-revokeobjecturl.js` asserts — is
  // reproduced and the operation itself is the declared gap.
  static createObjectURL(blob?: any): string {
    if (blob === undefined) throw new ERR_MISSING_ARGS("blob");
    throw new ERR_INVALID_ARG_TYPE("blob", "Blob", blob);
  }

  static revokeObjectURL(id?: any): void {
    if (id === undefined) throw new ERR_MISSING_ARGS("url");
  }
}

// Wrap a record in a `URL` without re-parsing it. `pathToFileURL` and
// `fileURLToPath` build records directly and hand them out as genuine `URL`
// instances this way.
function __wuWrapRecord(rec: any): any {
  return new NodeURL(__WU_WRAP, rec, null);
}

// Build a record from components, for the file-URL helpers. `pathname` is
// already percent-encoded by its caller and goes in as the opaque-free path
// segment list, split on `/`.
function __wuRecordFrom(
  scheme: string,
  username: string,
  password: string,
  hostValue: any,
  port: any,
  pathname: string,
  query: any,
  fragment: any,
): any {
  const rec = new __WUrlRecord();
  rec.scheme = scheme;
  rec.username = username;
  rec.password = password;
  rec.host = hostValue;
  rec.port = port;
  rec.query = query;
  rec.fragment = fragment;
  const segments: any = pathname.split("/");
  const path: string[] = [];
  // A pathname always starts with `/` here, and that leading empty piece is
  // the separator the serializer re-inserts, not a segment.
  for (let i = 1; i < __wuALen(segments); i++) path.push(segments[i] as string);
  rec.path = path;
  return rec;
}

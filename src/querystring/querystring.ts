// node:querystring — the legacy `application/x-www-form-urlencoded` surface, in
// Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes 100%
// of Node's own `test/parallel/test-querystring*.js` files (see
// ../../test/querystring/). `parse`, `stringify`, `escape`, `unescape` and
// `unescapeBuffer` follow Node's `lib/querystring.js` and
// `lib/internal/querystring.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) instruction for instruction, because every observable edge case
// here — which empty segment consumes a `maxKeys` slot, that `parse('a=b', [])`
// drops the value, that `escape` surrogate handling throws `ERR_INVALID_URI`
// rather than producing replacement bytes — is defined by that code and pinned
// by those tests, not by any general rule.
//
// Like `path` (and unlike `fs`), `querystring` is pure string computation, so it
// is written in the language the platform compiles: no `--ext` library, no
// syscalls. See ../../PLAN.md.
//
// ---------------------------------------------------------------------------
// Security posture
// ---------------------------------------------------------------------------
//
// `querystring` has no CVEs of its own in Node's history, and the reason is
// structural: the parser is a hand-written character scanner with no regular
// expression anywhere near the hot path, so no input can drive it into
// catastrophic backtracking. That property is preserved here deliberately —
// nothing in this file builds or runs a RegExp, not even for the `+`-to-space
// substitution (which is `split("+").join(" ")`-free too: the scanner handles
// `+` inline, exactly as Node's does).
//
// The second structural guard is the **null-prototype result object**. `parse`
// returns `{ __proto__: null }`, so a query string of `?__proto__[x]=1` or
// `?constructor=…` can never reach `Object.prototype` and can never be mistaken
// for an inherited member by a caller that reads `result.toString`. Node keeps
// that shape and so does this module; `test-querystring.js` asserts it with
// `assert(!(actual instanceof Object))` and with an explicit `__proto__=1` case.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// ---------------------------------------------------------------------------
//
//   * **The scanner runs over a code-unit array, not over the string.**
//     `charCodeAt(index)` and `slice(from, to)` are O(n) in the string's length
//     (https://github.com/UrubuCode/zun/issues/12), which makes Node's
//     single-pass `for (i = 0; i < qs.length; i++) qs.charCodeAt(i)` loop O(n²):
//     measured on this engine, scanning 16 000 characters that way takes 23
//     seconds and 100 000 characters is minutes. `split("")` is linear and
//     cheap (47 ms for 100 000 units), and indexing the resulting array is
//     O(1), so every scanner here first takes `__qsUnits(s)` and then compares
//     one-character strings. The algorithm is unchanged — the same positions are
//     visited in the same order and the same substrings are produced
//     (`__qsSub`, an array `slice().join("")`) — only the addressing is
//     different. `test-querystring-maxKeys-non-finite.js` parses a 98 kB query
//     four times and is the test that makes this mandatory.
//   * `__qsLen()` instead of `.length` — the checker types `.length` as `u64`, so
//     it can be neither assigned to nor passed as a `number`
//     (https://github.com/UrubuCode/zun/issues/3).
//   * `__qsBox()` / `__qsCall()` — a function value cannot be returned out of an
//     object-literal method (the caller receives `null`), so the module's own
//     `escape`/`unescape` are stored as boxed records, which `parse` and
//     `stringify` read back by identity exactly as Node reads
//     `QueryString.unescape` (this is what makes the "override .unescape" case
//     in `test-querystring.js` work).
//   * `__qsSetKey()` uses `Object.defineProperty` for the single key
//     `"__proto__"`: a plain `obj["__proto__"] = value` assignment is treated by
//     the engine as a prototype *set* even on a null-prototype object, so the
//     own property is silently lost
//     (https://github.com/UrubuCode/zun/issues/47 — Node creates an own
//     property there, because a null-prototype object has no inherited
//     `__proto__` setter). `defineProperty` creates it correctly. Every other
//     key takes the plain assignment.
//   * `__qsToString()` instead of `String(value)`. Two reasons, and `escape` is
//     specified in terms of exactly this conversion, so it is spelled out here.
//     First, ToPrimitive does not fall back from a non-callable `toString` to
//     `valueOf`: `String({ toString: 5, valueOf: () => "x" })` answers
//     `"[object Object]"` instead of `"x"`, and `String({ toString: 5 })`
//     answers `"[object Object]"` instead of throwing (new bug, reported with
//     this work). Second, Node's `escape` converts a non-object with
//     `str += ''`, which **throws** for a symbol, while `String(aSymbol)`
//     legitimately answers `"Symbol(x)"` — so the symbol rejection has to be
//     written out rather than delegated to `String`.
//   * `truthy()` instead of `!value` — the unary negation of an `any`-typed
//     empty string reports it as truthy
//     (https://github.com/UrubuCode/zun/issues/13).
//
// `unescapeBuffer` returns a **byte view**, not a `Buffer`: `node:buffer` is not
// implemented yet (it is its own module in PLAN.md's roadmap), so the value
// handed back is the closest honest thing — an array-like object carrying one
// byte per index, a `length`, and a `toString()` that decodes the bytes as
// UTF-8. That is precisely the surface Node's own tests use on it
// (`b[0] … b[19]` and `.toString()`), and it is documented as a gap rather than
// pretending to be a Buffer: it has no `slice`, no `write`, no encodings.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// `.length` as a JS Number. See issue #3. (Prefixed, because `path.ts` declares
// its own `slen` in the same bundle.)
function __qsLen(value: string): number {
  return Number(value.length);
}

function __qsALen(value: any): number {
  return Number(value.length);
}

// JavaScript truthiness of an `any`. See issue #13.
function __qsTruthy(value: any): boolean {
  return value ? true : false;
}

// The code units of `s`, as one-character strings. See the header note on #12.
function __qsUnits(s: string): any {
  return s.split("");
}

// The code of a one-character string.
function __qsCode(unit: any): number {
  return Number((unit as string).charCodeAt(0));
}

// `units.slice(from, to).join("")` — the substring of the scanned string that
// Node spells `StringPrototypeSlice(qs, from, to)`.
function __qsSub(units: any, from: number, to: number): string {
  if (to <= from) return "";
  const piece: any = units.slice(from, to);
  return piece.join("");
}

function __qsSubTail(units: any, from: number): string {
  return __qsSub(units, from, __qsALen(units));
}

// A function value survives a return only as a record; see the header note.
function __qsBox(fn: any): any {
  if (fn !== null && fn !== undefined && typeof fn === "object") return fn;
  const holder: any[] = [fn];
  return holder[0];
}

function __qsUnbox(value: any): any {
  if (value !== null && value !== undefined && typeof value === "object") {
    const inner: any = value["__boxedFn"];
    if (inner !== undefined) return inner;
  }
  return value;
}

function __qsCall(fn: any, args: any[]): any {
  const callable: any = __qsUnbox(fn);
  return callable(...args);
}

// Is this value callable — a bare function or one of the boxed records above?
function __qsIsFn(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "function") return true;
  if (typeof value === "object") return value["__boxedFn"] !== undefined;
  return false;
}

// ---------------------------------------------------------------------------
// ERR_INVALID_URI
//
// Node raises a `URIError` that additionally carries `code: 'ERR_INVALID_URI'`.
// `code` is a **declared field** on a real `URIError` subclass, never an expando
// written through an `any` alias — that spelling poisons the instance and makes
// every later typed read of its own members (`err.name` included) throw
// (https://github.com/UrubuCode/zun/issues/37), and
// `test-querystring-escape.js` reads exactly `{ code, name, message }`.
// ---------------------------------------------------------------------------

class QsURIError extends URIError {
  code: string = "";
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function __qsInvalidURI(): any {
  return new QsURIError("ERR_INVALID_URI", "URI malformed");
}

// ---------------------------------------------------------------------------
// Tables
//
// `lib/internal/querystring.js`' `hexTable` and `isHexTable`, and
// `lib/querystring.js`' `unhexTable` and `noEscape`, built once at load.
// ---------------------------------------------------------------------------

const __QS_HEX_DIGITS: string = "0123456789ABCDEF";

function __qsBuildHexTable(): string[] {
  const table: string[] = [];
  for (let i = 0; i < 256; i++) {
    const hi = Math.floor(i / 16);
    const lo = i % 16;
    table.push("%" + __QS_HEX_DIGITS.charAt(hi) + __QS_HEX_DIGITS.charAt(lo));
  }
  return table;
}

const __qsHexTable: string[] = __qsBuildHexTable();

// 1 for the 22 characters that are hexadecimal digits, 0 otherwise.
function __qsBuildIsHexTable(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) table.push(0);
  for (let c = 48; c <= 57; c++) table[c] = 1; // 0-9
  for (let c = 65; c <= 70; c++) table[c] = 1; // A-F
  for (let c = 97; c <= 102; c++) table[c] = 1; // a-f
  return table;
}

const __qsIsHexTable: number[] = __qsBuildIsHexTable();

// The value of a hexadecimal digit, or -1.
function __qsBuildUnhexTable(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) table.push(-1);
  for (let c = 48; c <= 57; c++) table[c] = c - 48;
  for (let c = 65; c <= 70; c++) table[c] = c - 55;
  for (let c = 97; c <= 102; c++) table[c] = c - 87;
  return table;
}

const __qsUnhexTable: number[] = __qsBuildUnhexTable();

// `noEscape`: the characters a query string does not need to escape —
// `!`, `'`, `(`, `)`, `*`, `-`, `.`, `_`, `~`, digits and both alphabets.
function __qsBuildNoEscapeTable(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 128; i++) table.push(0);
  const literal: string = "!'()*-._~";
  for (let i = 0; i < __qsLen(literal); i++) table[Number(literal.charCodeAt(i))] = 1;
  for (let c = 48; c <= 57; c++) table[c] = 1; // 0-9
  for (let c = 65; c <= 90; c++) table[c] = 1; // A-Z
  for (let c = 97; c <= 122; c++) table[c] = 1; // a-z
  return table;
}

const __qsNoEscape: number[] = __qsBuildNoEscapeTable();

// ---------------------------------------------------------------------------
// The byte view `unescapeBuffer` answers. See the header note.
// ---------------------------------------------------------------------------

// Decode `count` UTF-8 bytes. A malformed sequence yields U+FFFD, one
// replacement per bad byte, which is what `Buffer#toString('utf8')` does.
function __qsDecodeUtf8(bytes: any, count: number): string {
  const out: string[] = [];
  let i = 0;
  while (i < count) {
    const b0 = Number(bytes[i]);
    if (b0 < 0x80) {
      out.push(String.fromCharCode(b0));
      i = i + 1;
    } else if (b0 >= 0xc2 && b0 <= 0xdf && i + 1 < count && __qsIsCont(bytes, i + 1)) {
      out.push(String.fromCharCode(((b0 & 0x1f) * 64) + (Number(bytes[i + 1]) & 0x3f)));
      i = i + 2;
    } else if (
      b0 >= 0xe0 && b0 <= 0xef && i + 2 < count &&
      __qsIsCont(bytes, i + 1) && __qsIsCont(bytes, i + 2)
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
      __qsIsCont(bytes, i + 1) && __qsIsCont(bytes, i + 2) && __qsIsCont(bytes, i + 3)
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
        const rest = cp - 0x10000;
        out.push(String.fromCharCode(0xd800 + Math.floor(rest / 1024)));
        out.push(String.fromCharCode(0xdc00 + (rest % 1024)));
        i = i + 4;
      }
    } else {
      out.push("�");
      i = i + 1;
    }
  }
  return out.join("");
}

function __qsIsCont(bytes: any, index: number): boolean {
  const b = Number(bytes[index]);
  return b >= 0x80 && b <= 0xbf;
}

// An array-like view over `count` bytes, with `toString()`. `toString` is a
// function *expression* assigned to a property rather than a shorthand method,
// because a shorthand method cannot see the enclosing locals it needs.
function __qsByteView(bytes: any, count: number): any {
  const view: any = {
    length: count,
    toString: function (...rest: any[]): string {
      return __qsDecodeUtf8(bytes, count);
    },
  };
  for (let i = 0; i < count; i++) view[i] = bytes[i];
  return view;
}

// ---------------------------------------------------------------------------
// querystring.unescapeBuffer / querystring.unescape
// ---------------------------------------------------------------------------

// `lib/querystring.js`' `unescapeBuffer(s, decodeSpaces)`: a percent-decoder
// that never throws. Malformed escapes are emitted literally.
function __qsUnescapeBuffer(s: any, decodeSpaces?: any): any {
  const text: string = typeof s === "string" ? s : String(s);
  const units: any = __qsUnits(text);
  const len = __qsALen(units);
  const bytes: number[] = [];
  const spaces = decodeSpaces === true;
  const maxLength = len - 2;
  let index = 0;
  let outIndex = 0;
  let hasHex = false;
  while (index < len) {
    let currentChar = __qsCode(units[index]);
    if (currentChar === 43 /* + */ && spaces) {
      bytes.push(32);
      outIndex = outIndex + 1;
      index = index + 1;
      continue;
    }
    if (currentChar === 37 /* % */ && index < maxLength) {
      index = index + 1;
      currentChar = __qsCode(units[index]);
      const hexHigh = __qsUnhexTable[currentChar & 0xff];
      if (hexHigh < 0) {
        bytes.push(37);
        outIndex = outIndex + 1;
        continue;
      }
      index = index + 1;
      const nextChar = __qsCode(units[index]);
      const hexLow = __qsUnhexTable[nextChar & 0xff];
      if (hexLow < 0) {
        bytes.push(37);
        outIndex = outIndex + 1;
        index = index - 1;
        continue;
      }
      hasHex = true;
      currentChar = hexHigh * 16 + hexLow;
    }
    // Node writes `out[outIndex++] = currentChar` into a Buffer, so a code unit
    // above 0xFF is truncated to its low byte. Reproduced exactly.
    bytes.push(currentChar & 0xff);
    outIndex = outIndex + 1;
    index = index + 1;
  }
  return __qsByteView(bytes, outIndex);
}

// `qsUnescape(s, decodeSpaces)`: `decodeURIComponent`, falling back to the
// byte decoder when the input is not valid percent-encoding.
function __qsUnescape(s: any, decodeSpaces?: any): string {
  try {
    return decodeURIComponent(typeof s === "string" ? s : String(s));
  } catch (ignored) {
    const view: any = __qsUnescapeBuffer(s, decodeSpaces);
    return view.toString();
  }
}

// ---------------------------------------------------------------------------
// querystring.escape
// ---------------------------------------------------------------------------

// ToString as the specification defines it for `escape`'s argument. The engine's
// own `String()` does not fall back from a non-callable `toString` to `valueOf`
// and does not reject a symbol; see the header note.
function __qsToString(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return String(value);

  // OrdinaryToPrimitive(value, "string"): `toString` then `valueOf`, each only
  // if callable, each only if it answers a primitive.
  const toPrimitive: any = value[Symbol.toPrimitive];
  if (__qsIsFn(toPrimitive)) {
    const primitive: any = __qsCall(toPrimitive, ["string"]);
    if (typeof primitive !== "object" || primitive === null) {
      return __qsToString(primitive);
    }
    throw new TypeError("Cannot convert object to primitive value");
  }
  const asString: any = value["toString"];
  const asValue: any = value["valueOf"];
  if (__qsIsFn(asString)) {
    const produced: any = __qsCall(asString, []);
    if (typeof produced !== "object" || produced === null) return __qsToString(produced);
  }
  if (__qsIsFn(asValue)) {
    const produced: any = __qsCall(asValue, []);
    if (typeof produced !== "object" || produced === null) return __qsToString(produced);
  }
  // Neither hook is callable *as an own member*. When neither is even present,
  // the object carries only the inherited `Object.prototype` pair, which a
  // dynamic member read cannot see in this engine (it answers `undefined`)
  // although `String(value)` does apply it — so defer to `String` there, and
  // that is the ordinary `"[object Object]"` case. When one of them *is*
  // present but is not callable (`{ toString: 5 }`), OrdinaryToPrimitive has
  // skipped both hooks and the specification throws.
  if (asString === undefined && asValue === undefined) return String(value);
  throw new TypeError("Cannot convert object to primitive value");
}

// `lib/internal/querystring.js`' `encodeStr(str, noEscapeTable, hexTable)`,
// instruction for instruction, over the code-unit array.
function __qsEncodeStr(str: string, noEscapeTable: number[]): string {
  const units: any = __qsUnits(str);
  const len = __qsALen(units);
  if (len === 0) return "";

  const out: string[] = [];
  let lastPos = 0;
  let i = 0;
  let outer = true;
  while (outer && i < len) {
    let c = __qsCode(units[i]);

    // ASCII
    let broke = false;
    while (c < 0x80) {
      if (noEscapeTable[c] !== 1) {
        if (lastPos < i) out.push(__qsSub(units, lastPos, i));
        lastPos = i + 1;
        out.push(__qsHexTable[c]);
      }
      i = i + 1;
      if (i === len) {
        broke = true;
        outer = false;
        break;
      }
      c = __qsCode(units[i]);
    }
    if (broke) break;

    if (lastPos < i) out.push(__qsSub(units, lastPos, i));

    // Multi-byte characters.
    if (c < 0x800) {
      lastPos = i + 1;
      out.push(__qsHexTable[0xc0 | Math.floor(c / 64)]);
      out.push(__qsHexTable[0x80 | (c & 0x3f)]);
      i = i + 1;
      continue;
    }
    if (c < 0xd800 || c >= 0xe000) {
      lastPos = i + 1;
      out.push(__qsHexTable[0xe0 | Math.floor(c / 4096)]);
      out.push(__qsHexTable[0x80 | (Math.floor(c / 64) & 0x3f)]);
      out.push(__qsHexTable[0x80 | (c & 0x3f)]);
      i = i + 1;
      continue;
    }
    // Surrogate pair. Node consumes the next code unit unconditionally and
    // masks it with 0x3FF, which is why `escape("\uD801test")` answers
    // `%F0%90%91%B4est` rather than rejecting the unpaired high surrogate; a
    // high surrogate at the very end is the one case that throws.
    i = i + 1;
    if (i >= len) throw __qsInvalidURI();
    const c2 = __qsCode(units[i]) & 0x3ff;
    lastPos = i + 1;
    const cp = 0x10000 + (((c & 0x3ff) * 1024) | c2);
    out.push(__qsHexTable[0xf0 | Math.floor(cp / 262144)]);
    out.push(__qsHexTable[0x80 | (Math.floor(cp / 4096) & 0x3f)]);
    out.push(__qsHexTable[0x80 | (Math.floor(cp / 64) & 0x3f)]);
    out.push(__qsHexTable[0x80 | (cp & 0x3f)]);
    i = i + 1;
  }
  if (lastPos === 0) return str;
  if (lastPos < len) {
    out.push(__qsSubTail(units, lastPos));
    return out.join("");
  }
  return out.join("");
}

function __qsEscape(str: any): string {
  let text: any = str;
  if (typeof text !== "string") {
    // Node: objects go through `String(str)`, everything else through `str += ''`.
    // Both are ToString; `__qsToString` is the spec-correct conversion here.
    text = __qsToString(text);
  }
  return __qsEncodeStr(text, __qsNoEscape);
}

// ---------------------------------------------------------------------------
// querystring.stringify
// ---------------------------------------------------------------------------

function __qsStringifyPrimitive(v: any): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return "" + String(v);
  if (typeof v === "bigint") return "" + String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}

function __qsEncodeStringified(v: any, encode: any): string {
  if (typeof v === "string") return __qsLen(v) > 0 ? __qsCall(encode, [v]) : "";
  if (typeof v === "number" && Number.isFinite(v)) {
    // Values >= 1e21 switch to scientific notation, whose `+` has to be escaped.
    const text = "" + String(v);
    return Math.abs(v) < 1e21 ? text : __qsCall(encode, [text]);
  }
  if (typeof v === "bigint") return "" + String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return "";
}

function __qsEncodeStringifiedCustom(v: any, encode: any): string {
  return __qsCall(encode, [__qsStringifyPrimitive(v)]);
}

function __qsConvert(v: any, encode: any, custom: boolean): string {
  return custom
    ? __qsEncodeStringifiedCustom(v, encode)
    : __qsEncodeStringified(v, encode);
}

function __qsStringify(obj?: any, sep?: any, eq?: any, options?: any): string {
  const sepText: string = __qsTruthy(sep) ? __qsToString(sep) : "&";
  const eqText: string = __qsTruthy(eq) ? __qsToString(eq) : "=";

  // `QueryString.escape` is read through the module object, so a caller that
  // replaced it is honoured — exactly as in Node.
  let encode: any = __node_querystring.escape;
  let custom = false;
  if (options !== undefined && options !== null) {
    const supplied: any = options.encodeURIComponent;
    if (__qsIsFn(supplied)) {
      encode = supplied;
      custom = true;
    }
  }
  // Node decides `convert` by comparing the encoder with `qsEscape` itself, so a
  // caller who passes the module's own `escape` back in still takes the fast
  // path. Identity against the boxed default is the same test.
  if (custom && __qsUnbox(encode) === __qsUnbox(__qsDefaultEscape)) custom = false;

  if (obj !== null && obj !== undefined && typeof obj === "object") {
    const keys: any = Object.keys(obj);
    const len = __qsALen(keys);
    let fields = "";
    for (let i = 0; i < len; i++) {
      const k: any = keys[i];
      const v: any = obj[k];
      const ks: string = __qsConvert(k, encode, custom) + eqText;

      if (Array.isArray(v)) {
        const vlen = __qsALen(v);
        if (vlen === 0) continue;
        if (__qsLen(fields) > 0) fields = fields + sepText;
        for (let j = 0; j < vlen; j++) {
          if (j > 0) fields = fields + sepText;
          fields = fields + ks + __qsConvert(v[j], encode, custom);
        }
      } else {
        if (__qsLen(fields) > 0) fields = fields + sepText;
        fields = fields + ks + __qsConvert(v, encode, custom);
      }
    }
    return fields;
  }
  return "";
}

// ---------------------------------------------------------------------------
// querystring.parse
// ---------------------------------------------------------------------------

// Set `key` on the null-prototype result. Only `"__proto__"` needs
// `defineProperty`; see the header note.
function __qsSetKey(obj: any, key: string, value: any): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value: value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    return;
  }
  obj[key] = value;
}

function __qsGetKey(obj: any, key: string): any {
  if (key === "__proto__") {
    const descriptor: any = Object.getOwnPropertyDescriptor(obj, key);
    return descriptor === undefined || descriptor === null ? undefined : descriptor.value;
  }
  return obj[key];
}

function __qsDecodeStr(s: string, decoder: any): string {
  try {
    return __qsCall(decoder, [s]);
  } catch (ignored) {
    return __qsUnescape(s, true);
  }
}

function __qsAddKeyVal(
  obj: any,
  key: string,
  value: string,
  keyEncoded: boolean,
  valEncoded: boolean,
  decode: any,
): void {
  let k = key;
  let v = value;
  if (__qsLen(k) > 0 && keyEncoded) k = __qsDecodeStr(k, decode);
  if (__qsLen(v) > 0 && valEncoded) v = __qsDecodeStr(v, decode);

  const current: any = __qsGetKey(obj, k);
  if (current === undefined) {
    __qsSetKey(obj, k, v);
    return;
  }
  // An Array-specific check is enough to tell a list apart from a string here,
  // because every value stored is one this function produced.
  if (Array.isArray(current)) {
    current.push(v);
    return;
  }
  __qsSetKey(obj, k, [current, v]);
}

// `lib/querystring.js`' `parse(qs, sep, eq, options)`, over the code-unit array.
function __qsParse(qs?: any, sep?: any, eq?: any, options?: any): any {
  const obj: any = { __proto__: null };

  if (typeof qs !== "string" || __qsLen(qs) === 0) return obj;

  const sepUnits: any = __qsTruthy(sep) ? __qsUnits(__qsToString(sep)) : __qsUnits("&");
  const eqUnits: any = __qsTruthy(eq) ? __qsUnits(__qsToString(eq)) : __qsUnits("=");
  const sepLen = __qsALen(sepUnits);
  const eqLen = __qsALen(eqUnits);

  // -1 stands in for "unlimited", as in Node: `pairs` is only ever decremented
  // and compared with 0, so a negative start never terminates the scan. Node
  // uses it rather than Infinity for speed; the observable effect is identical,
  // and it is what makes `maxKeys: Infinity` and `maxKeys: NaN` mean "no limit"
  // while the *string* `'Infinity'` leaves the 1000 default in place.
  let pairs = 1000;
  if (options !== undefined && options !== null && typeof options.maxKeys === "number") {
    pairs = options.maxKeys > 0 ? Number(options.maxKeys) : -1;
  }

  let decode: any = __node_querystring.unescape;
  if (options !== undefined && options !== null) {
    const supplied: any = options.decodeURIComponent;
    if (__qsIsFn(supplied)) decode = supplied;
  }
  const customDecode = __qsUnbox(decode) !== __qsUnbox(__qsDefaultUnescape);

  const units: any = __qsUnits(qs);
  const len = __qsALen(units);

  let lastPos = 0;
  let sepIdx = 0;
  let eqIdx = 0;
  let key = "";
  let value = "";
  let keyEncoded = customDecode;
  let valEncoded = customDecode;
  const plusChar: string = customDecode ? "%20" : " ";
  let encodeCheck = 0;

  for (let i = 0; i < len; i++) {
    const unit: any = units[i];

    // Try matching the key/value pair separator (e.g. "&").
    if (sepIdx < sepLen && unit === sepUnits[sepIdx]) {
      sepIdx = sepIdx + 1;
      if (sepIdx === sepLen) {
        const end = i - sepIdx + 1;
        if (eqIdx < eqLen) {
          // The (entire) key/value separator was never found.
          if (lastPos < end) {
            // Treat the substring as part of the key instead of the value.
            key = key + __qsSub(units, lastPos, end);
          } else if (__qsLen(key) === 0) {
            // An empty substring between separators.
            pairs = pairs - 1;
            if (pairs === 0) return obj;
            lastPos = i + 1;
            sepIdx = 0;
            eqIdx = 0;
            continue;
          }
        } else if (lastPos < end) {
          value = value + __qsSub(units, lastPos, end);
        }

        __qsAddKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

        pairs = pairs - 1;
        if (pairs === 0) return obj;
        keyEncoded = customDecode;
        valEncoded = customDecode;
        key = "";
        value = "";
        encodeCheck = 0;
        lastPos = i + 1;
        sepIdx = 0;
        eqIdx = 0;
      }
      continue;
    }

    sepIdx = 0;
    const code = __qsCode(unit);
    // Try matching the key/value separator (e.g. "=") if we have not already.
    //
    // There is no `continue` at the end of this block, deliberately: Node lets a
    // character that is none of the key cases fall through into the *value*
    // encode-detection below, which is how `valEncoded` can be set while the
    // scanner is still inside the key (`a%41%42=x`). That is observable through
    // a custom decoder, so the fall-through is reproduced rather than tidied.
    if (eqIdx < eqLen) {
      if (unit === eqUnits[eqIdx]) {
        eqIdx = eqIdx + 1;
        if (eqIdx === eqLen) {
          const end = i - eqIdx + 1;
          if (lastPos < end) key = key + __qsSub(units, lastPos, end);
          encodeCheck = 0;
          lastPos = i + 1;
        }
        continue;
      }
      eqIdx = 0;
      if (!keyEncoded) {
        // Match one valid encoded byte before deciding the key needs decoding.
        if (code === 37 /* % */) {
          encodeCheck = 1;
          continue;
        } else if (encodeCheck > 0) {
          if (__qsIsHexTable[code & 0xff] === 1) {
            encodeCheck = encodeCheck + 1;
            if (encodeCheck === 3) keyEncoded = true;
            continue;
          } else {
            encodeCheck = 0;
          }
        }
      }
      if (code === 43 /* + */) {
        if (lastPos < i) key = key + __qsSub(units, lastPos, i);
        key = key + plusChar;
        lastPos = i + 1;
        continue;
      }
    }

    if (code === 43 /* + */) {
      if (lastPos < i) value = value + __qsSub(units, lastPos, i);
      value = value + plusChar;
      lastPos = i + 1;
    } else if (!valEncoded) {
      if (code === 37 /* % */) {
        encodeCheck = 1;
      } else if (encodeCheck > 0) {
        if (__qsIsHexTable[code & 0xff] === 1) {
          encodeCheck = encodeCheck + 1;
          if (encodeCheck === 3) valEncoded = true;
        } else {
          encodeCheck = 0;
        }
      }
    }
  }

  // Any leftover key or value data.
  if (lastPos < len) {
    if (eqIdx < eqLen) {
      key = key + __qsSubTail(units, lastPos);
    } else if (sepIdx < sepLen) {
      value = value + __qsSubTail(units, lastPos);
    }
  } else if (eqIdx === 0 && __qsLen(key) === 0) {
    // The string ended on an empty substring.
    return obj;
  }

  __qsAddKeyVal(obj, key, value, keyEncoded, valEncoded, decode);

  return obj;
}

// ---------------------------------------------------------------------------
// The module object
//
// `escape`, `unescape` and `unescapeBuffer` are **function expressions assigned
// to properties**, not shorthand methods. Three things have to be true of them
// at once and only that spelling delivers all three: they are callable as
// `qs.escape(x)`; they read back out of the object as values, because `parse`
// and `stringify` fetch `QueryString.unescape` / `QueryString.escape` from it so
// that a caller's replacement takes effect; and they keep one identity across
// reads, because those two compare the fetched function with the default to
// decide whether a custom coder is in play. A shorthand method satisfies only
// the first (read as a value it answers `null`), and a boxed record only the
// last two (it is an object, so `qs.escape(x)` does not resolve to a method).
// ---------------------------------------------------------------------------

const __qsDefaultEscape: any = function (...rest: any[]): string {
  return __qsEscape(rest[0]);
};
const __qsDefaultUnescape: any = function (...rest: any[]): string {
  return __qsUnescape(rest[0], rest[1]);
};
const __qsDefaultUnescapeBuffer: any = function (...rest: any[]): any {
  return __qsUnescapeBuffer(rest[0], rest[1]);
};

const querystring: any = {
  escape: __qsDefaultEscape,
  unescape: __qsDefaultUnescape,
  unescapeBuffer: __qsDefaultUnescapeBuffer,

  stringify(obj?: any, sep?: any, eq?: any, options?: any): string {
    return __qsStringify(obj, sep, eq, options);
  },
  encode(obj?: any, sep?: any, eq?: any, options?: any): string {
    return __qsStringify(obj, sep, eq, options);
  },
  parse(qs?: any, sep?: any, eq?: any, options?: any): any {
    return __qsParse(qs, sep, eq, options);
  },
  decode(qs?: any, sep?: any, eq?: any, options?: any): any {
    return __qsParse(qs, sep, eq, options);
  },
};

// `node:querystring` module object for the bundler's `require` rewriting.
const __node_querystring: any = querystring;

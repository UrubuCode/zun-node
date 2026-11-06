// node:url — the legacy `url.parse`/`format`/`resolve` API, the `Url` class, the
// WHATWG re-exports and the file-URL / http-options utilities, in Zun
// TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-url*.js` files (see ../../test/url/).
// `Url.prototype.parse`, `Url.prototype.format`, `Url.prototype.resolveObject`,
// `autoEscapeStr` and the file-URL helpers follow Node's `lib/url.js` and
// `lib/internal/url.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) instruction for instruction. There is no general rule to appeal
// to here: `url.parse` is explicitly *not* standardized (that is what DEP0169
// says), so its behaviour simply **is** that code, down to which `@` wins when
// there are two, why `//foo/bar` cuts to the protocol, and the exact order in
// which dot segments are removed.
//
// Like `path` and `querystring` (and unlike `fs`), `url` is pure computation, so
// it is written in the language the platform compiles: no `--ext` library, no
// syscalls. It stands on `events` (the `ERR_*` bases), `path` (`fileURLToPath`
// and `pathToFileURL`, both platforms), `querystring` (`parseQueryString`) and
// `punycode` (`domainToASCII`/`domainToUnicode`). See ../../PLAN.md.
//
// ---------------------------------------------------------------------------
// Security posture
// ---------------------------------------------------------------------------
//
// `url.parse` is the one function in this library with a CVE history, and every
// guard Node grew for it is reproduced here rather than simplified away:
//
//   * **CVE-2018-12123** (`url.parse` hostname spoofing through a mixed-case
//     scheme). The protocol is lower-cased *before* any of the
//     `slashedProtocol` / `hostlessProtocol` / `unsafeProtocol` decisions are
//     taken (`lowerProto`), so `HTTP://` and `http://` take the same branch and
//     a capitalised scheme can no longer smuggle a different host parse. The
//     literal `proto` (not `lowerProto`) is still what
//     `slashedProtocol.has(proto)` is asked in the host-detection condition,
//     because that asymmetry is Node's and is observable.
//   * **Forbidden host characters.** After IDNA conversion the hostname is
//     re-checked against the forbidden set — `\0 \t \n \r SPACE # % / : < > ? @
//     [ \ ] ^ |`, with `[`, `]` and `:` permitted for an IPv6 literal — and an
//     offender raises `ERR_INVALID_URL` instead of being silently moved into
//     the path. NUL is in that set, which is the
//     `http://[127.0.0.1\x00c8763]:8000/` case (the CVE-2026-48930 class:
//     a NUL in a host must not be accepted and must not be truncated away).
//     The check runs *after* `toASCII` precisely because `toASCII` is what can
//     reintroduce such a character.
//   * **An empty hostname after IDNA** also raises `ERR_INVALID_URL`: it can
//     only have become empty inside `toASCII`, and an empty host is exactly
//     what a spoof needs.
//   * **Hostnames longer than 255 characters** are dropped to `''` before that
//     check, as in Node.
//   * **No regular expressions.** Node uses eight here
//     (`protocolPattern`, `portPattern`, `hostPattern`, `simplePathPattern`,
//     `forbiddenHostChars`, `forbiddenHostCharsIpv6`, `/^file:?$/` and the
//     slash replacement in `getPathFromURLWin32`). Each is a hand-written scan
//     in this file, both because a RegExp loses its methods through an `any`
//     (https://github.com/UrubuCode/zun/issues/7) and because a URL parser is
//     the last place that should own a backtracking engine.
//   * **Null-prototype query objects.** `parse(url, true)` hands the query to
//     `querystring.parse`, which answers a `{ __proto__: null }` object, and the
//     "no query string but `parseQueryString` requested" branch builds one
//     directly. A `?__proto__=x` query therefore cannot reach
//     `Object.prototype`.
//
// ---------------------------------------------------------------------------
// Engine gaps this module has to live with (all documented, none worked around
// by weakening behaviour)
// ---------------------------------------------------------------------------
//
//   * **`URL` and `URLSearchParams` are the engine's prelude classes**, re-
//     exported here because that is what `node:url` exports in Node (the module
//     and the global are the same object). The prelude's WHATWG support is
//     partial by its own documentation (`crates/zun_prelude/builtin/url.zun`):
//     no `base` argument, no setters, no `URL.canParse`/`URL.parse`, no IDNA, no
//     dot-segment or percent-encoding normalization, no `file:` URL with an
//     empty host (`new URL("file:///x")` throws), and a `URLSearchParams` whose
//     `get` answers `""` rather than `null` and which has no
//     `forEach`/`sort`/`size`/iterator. A second `URL` cannot be declared here
//     either — the name is a prelude class, and a user class of the same name is
//     rejected with "duplicate class" — so this module does not shadow it.
//     What it *can* do, and does, is build **genuine prelude `URL` instances**
//     from components: a Zun class has no constructor body, so `new URL(href,
//     true, scheme, userinfo, host, port, path, query, fragment, params)` fills
//     the fields positionally with `loaded` already true, which makes the lazy
//     parser short-circuit and every getter answer what we put there. That is
//     how `pathToFileURL` returns a real `URL` for `file:///C:/foo` although the
//     prelude could not have parsed it, and how `fileURLToPath` turns a `file:`
//     string into one. The resulting object is `instanceof URL`, which is what
//     `test-url-invalid-file-url-path-input.js` checks.
//   * **`URLPattern` is not implemented.** It is a separate WHATWG
//     specification that Node implements in C++ (ada's `url_pattern`), and it is
//     unreachable from a test here in any case: the files destructure it out of
//     the module object and `new` on a non-class binding does not compile
//     (https://github.com/UrubuCode/zun/issues/18). The export is `undefined`
//     and the gap is declared rather than faked.
//   * **`domainToASCII`/`domainToUnicode` are punycode, not full UTS#46
//     IDNA.** Node calls into ICU. `punycode.toASCII`/`toUnicode` agree with it
//     for every ASCII label (so for every hostname `url.parse` meets in the
//     corpus) and for a label that is already `xn--`-encoded, and differ on the
//     mapping/normalization steps ICU performs for raw Unicode. Node's own
//     `test-url-domain-ascii-unicode.js` is written `{ skip: !hasIntl }`, i.e.
//     it does not run on an ICU-less build, which is the honest category this
//     runtime is in.
//   * **`fileURLToPathBuffer` is absent**, because `node:buffer` is not
//     implemented yet (its own module in PLAN.md's roadmap).
//   * `__urlUnits()` — `charCodeAt(index)` and `slice(from, to)` are O(n) in the
//     string's length (https://github.com/UrubuCode/zun/issues/12), so every
//     scan here runs over the code-unit array `split("")` produces, as in
//     `querystring.ts`.
//   * `__urlCopyInto()` instead of `Object.assign(target, source)` — assigning
//     one class instance onto another copies nothing on this engine (the target
//     keeps its defaults; verified with a probe), and `resolveObject` is built
//     on exactly that operation, so the twelve fields are copied by name.
//   * `__urlTruthy()` instead of `!value` — the unary negation of an `any`-typed
//     empty string reports it as truthy
//     (https://github.com/UrubuCode/zun/issues/13), and `url.parse` is full of
//     `this.hostname || ''`-shaped tests on exactly such values.
//   * `__urlLen()` instead of `.length` — the checker types `.length` as `u64`
//     (https://github.com/UrubuCode/zun/issues/3).

// ---------------------------------------------------------------------------
// Character codes (Node's `internal/constants`)
// ---------------------------------------------------------------------------

const __URL_CHAR_TAB = 9;
const __URL_CHAR_LINE_FEED = 10;
const __URL_CHAR_CARRIAGE_RETURN = 13;
const __URL_CHAR_SPACE = 32;
const __URL_CHAR_DOUBLE_QUOTE = 34;
const __URL_CHAR_HASH = 35;
const __URL_CHAR_PERCENT = 37;
const __URL_CHAR_SINGLE_QUOTE = 39;
const __URL_CHAR_FORWARD_SLASH = 47;
const __URL_CHAR_COLON = 58;
const __URL_CHAR_SEMICOLON = 59;
const __URL_CHAR_LEFT_ANGLE_BRACKET = 60;
const __URL_CHAR_RIGHT_ANGLE_BRACKET = 62;
const __URL_CHAR_QUESTION_MARK = 63;
const __URL_CHAR_AT = 64;
const __URL_CHAR_LEFT_SQUARE_BRACKET = 91;
const __URL_CHAR_BACKWARD_SLASH = 92;
const __URL_CHAR_RIGHT_SQUARE_BRACKET = 93;
const __URL_CHAR_CIRCUMFLEX_ACCENT = 94;
const __URL_CHAR_GRAVE_ACCENT = 96;
const __URL_CHAR_LEFT_CURLY_BRACKET = 123;
const __URL_CHAR_VERTICAL_LINE = 124;
const __URL_CHAR_RIGHT_CURLY_BRACKET = 125;
const __URL_CHAR_NO_BREAK_SPACE = 160;
const __URL_CHAR_ZERO_WIDTH_NOBREAK_SPACE = 65279; // 0xFEFF

const __URL_HOSTNAME_MAX_LEN = 255;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function __urlLen(value: string): number {
  return Number(value.length);
}

function __urlALen(value: any): number {
  return Number(value.length);
}

function __urlTruthy(value: any): boolean {
  return value ? true : false;
}

// The code units of `s`, as one-character strings. See the header note on #12.
function __urlUnits(s: string): any {
  return s.split("");
}

function __urlCode(unit: any): number {
  return Number((unit as string).charCodeAt(0));
}

function __urlSub(units: any, from: number, to: number): string {
  if (to <= from) return "";
  const piece: any = units.slice(from, to);
  return piece.join("");
}

function __urlSubTail(units: any, from: number): string {
  return __urlSub(units, from, __urlALen(units));
}

function __urlIsFn(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "function") return true;
  if (typeof value === "object") return value["__boxedFn"] !== undefined;
  return false;
}

function __urlCall(fn: any, args: any[]): any {
  let callable: any = fn;
  if (fn !== null && fn !== undefined && typeof fn === "object") {
    const inner: any = fn["__boxedFn"];
    if (inner !== undefined) callable = inner;
  }
  return callable(...args);
}

// `\s` as JavaScript's regular-expression engine defines it, used by the
// `simplePathPattern` scan.
function __urlIsRegexSpace(code: number): boolean {
  if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13) return true;
  if (code === 32 || code === 160 || code === 0x1680) return true;
  if (code >= 0x2000 && code <= 0x200a) return true;
  if (code === 0x2028 || code === 0x2029 || code === 0x202f) return true;
  return code === 0x205f || code === 0x3000 || code === 0xfeff;
}

// ---------------------------------------------------------------------------
// Errors
//
// Every one is a real `TypeError`/`Error` subclass with `code` — and, where
// Node carries one, `input` — as **declared** fields. The expando spelling
// (`const e: any = new TypeError(m); e.code = "…"`) poisons the instance and
// makes every later typed read of its own members throw
// (https://github.com/UrubuCode/zun/issues/37), and
// `test-url-invalid-file-url-path-input.js` reads `err.input.href` on exactly
// such an error.
// ---------------------------------------------------------------------------

class ERR_INVALID_URL extends NodeTypeError {
  input: any = undefined;
  constructor(input: any) {
    super("ERR_INVALID_URL", "Invalid URL");
    this.input = input;
  }
}

class ERR_INVALID_URL_SCHEME extends NodeTypeError {
  constructor(expected: string) {
    super("ERR_INVALID_URL_SCHEME", "The URL must be of scheme " + expected);
  }
}

class ERR_INVALID_FILE_URL_HOST extends NodeTypeError {
  constructor(platform: string) {
    super(
      "ERR_INVALID_FILE_URL_HOST",
      'File URL host must be "localhost" or empty on ' + platform,
    );
  }
}

class ERR_INVALID_FILE_URL_PATH extends NodeTypeError {
  input: any = undefined;
  constructor(reason: string, input: any) {
    super("ERR_INVALID_FILE_URL_PATH", "File URL path " + reason);
    this.input = input;
  }
}

// `ERR_MISSING_ARGS` is not declared here: `util.ts` already declares it in the
// same bundle, and it is the same error class.

function __urlValidateString(value: any, name: string): void {
  if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
}

function __urlValidateObject(value: any, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
  }
}

// ---------------------------------------------------------------------------
// The three protocol sets of `lib/internal/url.js`
//
// They are spelled as predicates rather than `Set`s because a `Set`'s methods
// are lost through an `any` (https://github.com/UrubuCode/zun/issues/7) and the
// membership lists are closed and tiny. Both the bare and the colon-suffixed
// spelling are members, exactly as in Node — `parse` asks with a colon and
// `format` asks without one.
// ---------------------------------------------------------------------------

// Protocols that may carry "unsafe" and "unwise" characters.
function __urlIsUnsafeProtocol(p: any): boolean {
  return p === "javascript" || p === "javascript:";
}

// Protocols that never have a hostname.
function __urlIsHostlessProtocol(p: any): boolean {
  return p === "javascript" || p === "javascript:";
}

// Protocols that always carry a `//`.
function __urlIsSlashedProtocol(p: any): boolean {
  if (typeof p !== "string") return false;
  return (
    p === "http" || p === "http:" ||
    p === "https" || p === "https:" ||
    p === "ftp" || p === "ftp:" ||
    p === "gopher" || p === "gopher:" ||
    p === "file" || p === "file:" ||
    p === "ws" || p === "ws:" ||
    p === "wss" || p === "wss:"
  );
}

// Node's `/^file:?$/.test(protocol)`.
function __urlIsFileProtocol(p: any): boolean {
  return p === "file" || p === "file:";
}

// ---------------------------------------------------------------------------
// The scans that stand in for Node's regular expressions
// ---------------------------------------------------------------------------

// `protocolPattern = /^[a-z0-9.+-]+:/i` — the matched text, or "".
function __urlProtocolPrefix(units: any): string {
  const n = __urlALen(units);
  let i = 0;
  while (i < n) {
    const code = __urlCode(units[i]);
    const ok =
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      code === 46 /* . */ ||
      code === 43 /* + */ ||
      code === 45 /* - */;
    if (!ok) break;
    i = i + 1;
  }
  if (i === 0) return "";
  if (i >= n || __urlCode(units[i]) !== __URL_CHAR_COLON) return "";
  return __urlSub(units, 0, i + 1);
}

// `portPattern = /:[0-9]*$/` — the matched text, or "".
function __urlPortSuffix(hostText: string): string {
  const units: any = __urlUnits(hostText);
  const n = __urlALen(units);
  let i = n;
  while (i > 0) {
    const code = __urlCode(units[i - 1]);
    if (code < 48 || code > 57) break;
    i = i - 1;
  }
  if (i === 0) return "";
  if (__urlCode(units[i - 1]) !== __URL_CHAR_COLON) return "";
  return __urlSubTail(units, i - 1);
}

// `hostPattern = /^\/\/[^@/]+@[^@/]+/`.
function __urlHasHostPattern(units: any): boolean {
  const n = __urlALen(units);
  if (n < 2) return false;
  if (__urlCode(units[0]) !== __URL_CHAR_FORWARD_SLASH) return false;
  if (__urlCode(units[1]) !== __URL_CHAR_FORWARD_SLASH) return false;
  let i = 2;
  let before = 0;
  while (i < n) {
    const code = __urlCode(units[i]);
    if (code === __URL_CHAR_AT || code === __URL_CHAR_FORWARD_SLASH) break;
    before = before + 1;
    i = i + 1;
  }
  if (before === 0) return false;
  if (i >= n || __urlCode(units[i]) !== __URL_CHAR_AT) return false;
  i = i + 1;
  let after = 0;
  while (i < n) {
    const code = __urlCode(units[i]);
    if (code === __URL_CHAR_AT || code === __URL_CHAR_FORWARD_SLASH) break;
    after = after + 1;
    i = i + 1;
  }
  return after > 0;
}

// `simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/`. Answers
// `[group1, group2]` (group2 may be ""), or `null` when the pattern does not
// match the whole string.
function __urlSimplePath(units: any): any {
  const n = __urlALen(units);
  if (n === 0) return null;
  if (__urlCode(units[0]) !== __URL_CHAR_FORWARD_SLASH) return null;

  // `\/\/?(?!\/)`: one slash, optionally a second, then not a third. When the
  // second *and* third characters are both slashes neither alternative can
  // satisfy the lookahead, which is why `///x` does not match at all.
  let i = 1;
  if (i < n && __urlCode(units[i]) === __URL_CHAR_FORWARD_SLASH) {
    if (i + 1 < n && __urlCode(units[i + 1]) === __URL_CHAR_FORWARD_SLASH) return null;
    i = 2;
  }

  // `[^?\s]*`
  while (i < n) {
    const code = __urlCode(units[i]);
    if (code === __URL_CHAR_QUESTION_MARK || __urlIsRegexSpace(code)) break;
    i = i + 1;
  }
  const group1 = __urlSub(units, 0, i);

  if (i === n) return [group1, ""];
  if (__urlCode(units[i]) !== __URL_CHAR_QUESTION_MARK) return null;

  // `(\?[^\s]*)` then `$`: a space inside the query makes the anchor fail, and
  // `[^\s]*` can only shrink, so there is nothing to backtrack into.
  let j = i + 1;
  while (j < n) {
    if (__urlIsRegexSpace(__urlCode(units[j]))) return null;
    j = j + 1;
  }
  return [group1, __urlSub(units, i, j)];
}

// `forbiddenHostChars = /[\0\t\n\r #%/:<>?@[\\\]^|]/`.
function __urlIsForbiddenHostChar(code: number): boolean {
  return (
    code === 0 ||
    code === __URL_CHAR_TAB ||
    code === __URL_CHAR_LINE_FEED ||
    code === __URL_CHAR_CARRIAGE_RETURN ||
    code === __URL_CHAR_SPACE ||
    code === __URL_CHAR_HASH ||
    code === __URL_CHAR_PERCENT ||
    code === __URL_CHAR_FORWARD_SLASH ||
    code === __URL_CHAR_COLON ||
    code === __URL_CHAR_LEFT_ANGLE_BRACKET ||
    code === __URL_CHAR_RIGHT_ANGLE_BRACKET ||
    code === __URL_CHAR_QUESTION_MARK ||
    code === __URL_CHAR_AT ||
    code === __URL_CHAR_LEFT_SQUARE_BRACKET ||
    code === __URL_CHAR_BACKWARD_SLASH ||
    code === __URL_CHAR_RIGHT_SQUARE_BRACKET ||
    code === __URL_CHAR_CIRCUMFLEX_ACCENT ||
    code === __URL_CHAR_VERTICAL_LINE
  );
}

// `forbiddenHostCharsIpv6 = /[\0\t\n\r #%/<>?@\\^|]/` — `[`, `]` and `:` are
// permitted, because an IPv6 literal is made of them.
function __urlIsForbiddenHostCharIpv6(code: number): boolean {
  return (
    code === 0 ||
    code === __URL_CHAR_TAB ||
    code === __URL_CHAR_LINE_FEED ||
    code === __URL_CHAR_CARRIAGE_RETURN ||
    code === __URL_CHAR_SPACE ||
    code === __URL_CHAR_HASH ||
    code === __URL_CHAR_PERCENT ||
    code === __URL_CHAR_FORWARD_SLASH ||
    code === __URL_CHAR_LEFT_ANGLE_BRACKET ||
    code === __URL_CHAR_RIGHT_ANGLE_BRACKET ||
    code === __URL_CHAR_QUESTION_MARK ||
    code === __URL_CHAR_AT ||
    code === __URL_CHAR_BACKWARD_SLASH ||
    code === __URL_CHAR_CIRCUMFLEX_ACCENT ||
    code === __URL_CHAR_VERTICAL_LINE
  );
}

function __urlHasForbiddenHostChar(hostname: string, ipv6: boolean): boolean {
  const units: any = __urlUnits(hostname);
  const n = __urlALen(units);
  for (let i = 0; i < n; i++) {
    const code = __urlCode(units[i]);
    if (ipv6 ? __urlIsForbiddenHostCharIpv6(code) : __urlIsForbiddenHostChar(code)) {
      return true;
    }
  }
  return false;
}

function __urlIsIpv6Hostname(hostname: string): boolean {
  const n = __urlLen(hostname);
  if (n === 0) return false;
  const units: any = __urlUnits(hostname);
  return (
    __urlCode(units[0]) === __URL_CHAR_LEFT_SQUARE_BRACKET &&
    __urlCode(units[n - 1]) === __URL_CHAR_RIGHT_SQUARE_BRACKET
  );
}

// ---------------------------------------------------------------------------
// autoEscapeStr
//
// Node's `escapedCodes` table: every delimiter and "unwise" character of RFC
// 2396, plus the single quote (against an XSS vector).
// ---------------------------------------------------------------------------

function __urlBuildEscapedCodes(): string[] {
  const table: string[] = [];
  for (let i = 0; i < 128; i++) table.push("");
  table[9] = "%09";
  table[10] = "%0A";
  table[13] = "%0D";
  table[32] = "%20";
  table[34] = "%22";
  table[39] = "%27";
  table[60] = "%3C";
  table[62] = "%3E";
  table[92] = "%5C";
  table[94] = "%5E";
  table[96] = "%60";
  table[123] = "%7B";
  table[124] = "%7C";
  table[125] = "%7D";
  return table;
}

const __urlEscapedCodes: string[] = __urlBuildEscapedCodes();

function __urlAutoEscapeStr(rest: string): string {
  const units: any = __urlUnits(rest);
  const len = __urlALen(units);
  const out: string[] = [];
  let lastEscapedPos = 0;
  for (let i = 0; i < len; i++) {
    const code = __urlCode(units[i]);
    const escapedChar: string = code < 128 ? __urlEscapedCodes[code] : "";
    if (escapedChar !== "") {
      if (i > lastEscapedPos) out.push(__urlSub(units, lastEscapedPos, i));
      out.push(escapedChar);
      lastEscapedPos = i + 1;
    }
  }
  if (lastEscapedPos === 0) return rest; // Nothing was escaped.
  if (lastEscapedPos < len) out.push(__urlSubTail(units, lastEscapedPos));
  return out.join("");
}

// `noEscapeAuth`: `! - . _ ~ ' ( ) * :`, digits and both alphabets. Used with
// `querystring`'s `encodeStr`, exactly as `lib/url.js` imports it.
function __urlBuildNoEscapeAuth(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 128; i++) table.push(0);
  const literal: string = "!'()*-._~:";
  for (let i = 0; i < __urlLen(literal); i++) {
    table[Number(literal.charCodeAt(i))] = 1;
  }
  for (let c = 48; c <= 57; c++) table[c] = 1;
  for (let c = 65; c <= 90; c++) table[c] = 1;
  for (let c = 97; c <= 122; c++) table[c] = 1;
  return table;
}

const __urlNoEscapeAuth: number[] = __urlBuildNoEscapeAuth();

// ---------------------------------------------------------------------------
// The `Url` class
//
// Twelve declared fields and five methods. The fields are declared (and so are
// what `Object.keys` reports, in Node's order) because `assert.deepStrictEqual`
// of two parse results compares exactly those; the methods are on the class, so
// they are not own properties and do not enter that comparison. Each method is a
// one-line forward to a free function taking the object explicitly, because
// `url.format(plainObject)` is specified as
// `Url.prototype.format.call(plainObject)` and `call` threads no receiver on
// this engine (https://github.com/UrubuCode/zun/issues/1).
// ---------------------------------------------------------------------------

class Url {
  protocol: any = null;
  slashes: any = null;
  auth: any = null;
  host: any = null;
  port: any = null;
  hostname: any = null;
  hash: any = null;
  search: any = null;
  query: any = null;
  pathname: any = null;
  path: any = null;
  href: any = null;

  parse(url: any, parseQueryString?: any, slashesDenoteHost?: any): any {
    return __urlParseInto(this, url, parseQueryString, slashesDenoteHost);
  }
  format(): string {
    return __urlFormatObject(this);
  }
  resolve(relative: any): string {
    return __urlFormatObject(__urlResolveObjectFrom(this, relative));
  }
  resolveObject(relative: any): any {
    return __urlResolveObjectFrom(this, relative);
  }
  parseHost(): void {
    __urlParseHost(this);
  }
}

const __URL_FIELDS: string[] = [
  "protocol", "slashes", "auth", "host", "port", "hostname",
  "hash", "search", "query", "pathname", "path", "href",
];

// `Object.assign(target, source)` copies nothing between two class instances on
// this engine, so the twelve fields are copied by name. See the header note.
function __urlCopyInto(target: any, source: any, skipProtocol: boolean): void {
  for (const field of __URL_FIELDS) {
    if (skipProtocol && field === "protocol") continue;
    target[field] = source[field];
  }
}

// `host` cannot be a local name in this engine: it is the `zun:core` host
// namespace (`host.stderrWrite`), so the checker resolves it to that and reports
// "namespace `host` has no member `slice`". Hence `hostText` here and
// `hostPart`/`hostValue` below.
function __urlParseHost(self: any): void {
  let hostText: any = self.host;
  if (typeof hostText !== "string") return;
  const port = __urlPortSuffix(hostText);
  if (port !== "") {
    if (port !== ":") self.port = port.slice(1);
    hostText = hostText.slice(0, __urlLen(hostText) - __urlLen(port));
  }
  if (__urlTruthy(hostText)) self.hostname = hostText;
}

// ---------------------------------------------------------------------------
// Url.prototype.parse
// ---------------------------------------------------------------------------

function __urlGetHostname(self: any, rest: string, hostname: string, url: string): string {
  const units: any = __urlUnits(hostname);
  const n = __urlALen(units);
  for (let i = 0; i < n; i++) {
    const code = __urlCode(units[i]);
    const isValid =
      code !== __URL_CHAR_FORWARD_SLASH &&
      code !== __URL_CHAR_BACKWARD_SLASH &&
      code !== __URL_CHAR_HASH &&
      code !== __URL_CHAR_QUESTION_MARK &&
      code !== __URL_CHAR_COLON;
    if (!isValid) {
      // Leftover starting with `:` is an invalid port, not a path.
      if (code === __URL_CHAR_COLON) {
        throw new ERR_INVALID_ARG_VALUE("url", url, "Invalid port in url");
      }
      self.hostname = __urlSub(units, 0, i);
      return "/" + __urlSubTail(units, i) + rest;
    }
  }
  return rest;
}

function __urlParseInto(
  self: any,
  url: any,
  parseQueryString?: any,
  slashesDenoteHost?: any,
): any {
  __urlValidateString(url, "url");

  // Copy the chrome/IE/opera backslash handling: a backslash before the query
  // string becomes a forward slash.
  // https://code.google.com/p/chromium/issues/detail?id=25916
  const srcUnits: any = __urlUnits(url);
  const srcLen = __urlALen(srcUnits);
  let hasHash = false;
  let hasAt = false;
  let start = -1;
  let end = -1;
  let rest = "";
  let lastPos = 0;
  let inWs = false;
  let split = false;
  for (let i = 0; i < srcLen; i++) {
    const code = __urlCode(srcUnits[i]);

    // The first and last non-whitespace positions, for trimming.
    const isWs =
      code < 33 ||
      code === __URL_CHAR_NO_BREAK_SPACE ||
      code === __URL_CHAR_ZERO_WIDTH_NOBREAK_SPACE;
    if (start === -1) {
      if (isWs) continue;
      start = i;
      lastPos = i;
    } else if (inWs) {
      if (!isWs) {
        end = -1;
        inWs = false;
      }
    } else if (isWs) {
      end = i;
      inWs = true;
    }

    // Backslashes are only converted until a split character is seen.
    if (!split) {
      if (code === __URL_CHAR_AT) {
        hasAt = true;
      } else if (code === __URL_CHAR_HASH) {
        hasHash = true;
        split = true;
      } else if (code === __URL_CHAR_QUESTION_MARK) {
        split = true;
      } else if (code === __URL_CHAR_BACKWARD_SLASH) {
        if (i - lastPos > 0) rest = rest + __urlSub(srcUnits, lastPos, i);
        rest = rest + "/";
        lastPos = i + 1;
      }
    } else if (!hasHash && code === __URL_CHAR_HASH) {
      hasHash = true;
    }
  }

  // Was the string non-empty (whitespace-only counts)?
  if (start !== -1) {
    if (lastPos === start) {
      // No backslashes were converted.
      if (end === -1) {
        rest = start === 0 ? url : __urlSubTail(srcUnits, start);
      } else {
        rest = __urlSub(srcUnits, start, end);
      }
    } else if (end === -1 && lastPos < srcLen) {
      rest = rest + __urlSubTail(srcUnits, lastPos);
    } else if (end !== -1 && lastPos < end) {
      rest = rest + __urlSub(srcUnits, lastPos, end);
    }
  }

  if (!__urlTruthy(slashesDenoteHost) && !hasHash && !hasAt) {
    // The fast path for a simple path URL.
    const simplePath: any = __urlSimplePath(__urlUnits(rest));
    if (simplePath !== null) {
      self.path = rest;
      self.href = rest;
      self.pathname = simplePath[0];
      if (__urlTruthy(simplePath[1])) {
        self.search = simplePath[1];
        if (__urlTruthy(parseQueryString)) {
          self.query = __node_querystring.parse(String(self.search).slice(1));
        } else {
          self.query = String(self.search).slice(1);
        }
      } else if (__urlTruthy(parseQueryString)) {
        self.search = null;
        self.query = { __proto__: null };
      }
      return self;
    }
  }

  let restUnits: any = __urlUnits(rest);
  let proto: string = __urlProtocolPrefix(restUnits);
  let lowerProto: any = undefined;
  if (proto !== "") {
    lowerProto = proto.toLowerCase();
    // CVE-2018-12123: the lower-cased scheme is what every later branch reads.
    self.protocol = lowerProto;
    rest = __urlSubTail(restUnits, __urlLen(proto));
    restUnits = __urlUnits(rest);
  }

  // Does it have a host? `user@server` is *always* read as a hostname, and
  // `//foo/bar` resolves to host=foo path=/bar because that is what a browser
  // does with a relative URL.
  let slashes = false;
  if (__urlTruthy(slashesDenoteHost) || proto !== "" || __urlHasHostPattern(restUnits)) {
    const n = __urlALen(restUnits);
    slashes =
      n >= 2 &&
      __urlCode(restUnits[0]) === __URL_CHAR_FORWARD_SLASH &&
      __urlCode(restUnits[1]) === __URL_CHAR_FORWARD_SLASH;
    if (slashes && !(proto !== "" && __urlIsHostlessProtocol(lowerProto))) {
      rest = __urlSubTail(restUnits, 2);
      restUnits = __urlUnits(rest);
      self.slashes = true;
    }
  }

  if (
    !__urlIsHostlessProtocol(lowerProto) &&
    (slashes || (proto !== "" && !__urlIsSlashedProtocol(proto)))
  ) {
    // There is a hostname. The first `/`, `?`, `;` or `#` ends it.
    //
    // When the hostname holds an `@`, non-host characters *are* allowed to the
    // left of the last `@`, unless a host-ending character comes before it:
    //
    //   http://a@b@c/  => user:a@b host:c
    //   http://a@b?@c  => user:a host:b path:/?@c
    let hostEnd = -1;
    let atSign = -1;
    let nonHost = -1;
    for (let i = 0; i < __urlALen(restUnits); i++) {
      const code = __urlCode(restUnits[i]);
      if (
        code === __URL_CHAR_TAB ||
        code === __URL_CHAR_LINE_FEED ||
        code === __URL_CHAR_CARRIAGE_RETURN
      ) {
        // WHATWG URL removes tabs, newlines and carriage returns; so do we.
        rest = __urlSub(restUnits, 0, i) + __urlSubTail(restUnits, i + 1);
        restUnits = __urlUnits(rest);
        i = i - 1;
      } else if (
        code === __URL_CHAR_SPACE ||
        code === __URL_CHAR_DOUBLE_QUOTE ||
        code === __URL_CHAR_PERCENT ||
        code === __URL_CHAR_SINGLE_QUOTE ||
        code === __URL_CHAR_SEMICOLON ||
        code === __URL_CHAR_LEFT_ANGLE_BRACKET ||
        code === __URL_CHAR_RIGHT_ANGLE_BRACKET ||
        code === __URL_CHAR_BACKWARD_SLASH ||
        code === __URL_CHAR_CIRCUMFLEX_ACCENT ||
        code === __URL_CHAR_GRAVE_ACCENT ||
        code === __URL_CHAR_LEFT_CURLY_BRACKET ||
        code === __URL_CHAR_VERTICAL_LINE ||
        code === __URL_CHAR_RIGHT_CURLY_BRACKET
      ) {
        // Characters RFC 2396 never allows in a hostname.
        if (nonHost === -1) nonHost = i;
      } else if (
        code === __URL_CHAR_HASH ||
        code === __URL_CHAR_FORWARD_SLASH ||
        code === __URL_CHAR_QUESTION_MARK
      ) {
        // The first host-ending character.
        if (nonHost === -1) nonHost = i;
        hostEnd = i;
      } else if (code === __URL_CHAR_AT) {
        // Either we already have an explicit limit for the auth portion, or the
        // last `@` decides.
        atSign = i;
        nonHost = -1;
      }
      if (hostEnd !== -1) break;
    }
    start = 0;
    if (atSign !== -1) {
      self.auth = decodeURIComponent(__urlSub(restUnits, 0, atSign));
      start = atSign + 1;
    }
    if (nonHost === -1) {
      self.host = __urlSubTail(restUnits, start);
      rest = "";
    } else {
      self.host = __urlSub(restUnits, start, nonHost);
      rest = __urlSubTail(restUnits, nonHost);
    }
    restUnits = __urlUnits(rest);

    // Pull out the port.
    __urlParseHost(self);

    // A hostname was indicated, so even an empty one has to be present.
    if (typeof self.hostname !== "string") self.hostname = "";

    const hostname: string = String(self.hostname);

    // A hostname that begins with `[` and ends with `]` is taken for IPv6.
    const ipv6Hostname = __urlIsIpv6Hostname(hostname);

    if (!ipv6Hostname) {
      rest = __urlGetHostname(self, rest, hostname, String(url));
      restUnits = __urlUnits(rest);
    }

    if (__urlLen(String(self.hostname)) > __URL_HOSTNAME_MAX_LEN) {
      self.hostname = "";
    } else {
      // Hostnames are always lower case.
      self.hostname = String(self.hostname).toLowerCase();
    }

    if (String(self.hostname) !== "") {
      if (ipv6Hostname) {
        if (__urlHasForbiddenHostChar(String(self.hostname), true)) {
          throw new ERR_INVALID_URL(url);
        }
      } else {
        // IDNA: a punycoded representation of the domain. Only the labels with
        // non-ASCII characters change, so calling it on an ASCII-only domain is
        // the identity.
        self.hostname = __pcToASCII(String(self.hostname));

        // Two routes of hostname spoofing are closed here. An empty hostname
        // can only have become empty inside `toASCII` (it was non-empty just
        // above), and a forbidden character can only have got in the same way
        // (`__urlGetHostname` would have moved it into the path otherwise).
        // Rather than correcting that, this throws, which is the severity the
        // situation deserves.
        if (
          String(self.hostname) === "" ||
          __urlHasForbiddenHostChar(String(self.hostname), false)
        ) {
          throw new ERR_INVALID_URL(url);
        }
      }
    }

    const p: string = __urlTruthy(self.port) ? ":" + String(self.port) : "";
    const h: string = __urlTruthy(self.hostname) ? String(self.hostname) : "";
    self.host = h + p;

    // Strip `[` and `]` from the hostname; `host` keeps them.
    if (ipv6Hostname) {
      const hn: string = String(self.hostname);
      self.hostname = hn.slice(1, __urlLen(hn) - 1);
      if (__urlALen(restUnits) === 0 || __urlCode(restUnits[0]) !== __URL_CHAR_FORWARD_SLASH) {
        rest = "/" + rest;
        restUnits = __urlUnits(rest);
      }
    }
  }

  // `rest` is now the post-host part. Chop off any delimiter characters.
  if (!__urlIsUnsafeProtocol(lowerProto)) {
    // Make absolutely sure every "autoEscape" character is escaped, even where
    // `encodeURIComponent` would not bother.
    rest = __urlAutoEscapeStr(rest);
    restUnits = __urlUnits(rest);
  }

  let questionIdx = -1;
  let hashIdx = -1;
  for (let i = 0; i < __urlALen(restUnits); i++) {
    const code = __urlCode(restUnits[i]);
    if (code === __URL_CHAR_HASH) {
      self.hash = __urlSubTail(restUnits, i);
      hashIdx = i;
      break;
    } else if (code === __URL_CHAR_QUESTION_MARK && questionIdx === -1) {
      questionIdx = i;
    }
  }

  if (questionIdx !== -1) {
    if (hashIdx === -1) {
      self.search = __urlSubTail(restUnits, questionIdx);
      self.query = __urlSubTail(restUnits, questionIdx + 1);
    } else {
      self.search = __urlSub(restUnits, questionIdx, hashIdx);
      self.query = __urlSub(restUnits, questionIdx + 1, hashIdx);
    }
    if (__urlTruthy(parseQueryString)) {
      self.query = __node_querystring.parse(self.query);
    }
  } else if (__urlTruthy(parseQueryString)) {
    // No query string, but `parseQueryString` was still requested.
    self.search = null;
    self.query = { __proto__: null };
  }

  const useQuestionIdx =
    questionIdx !== -1 && (hashIdx === -1 || questionIdx < hashIdx);
  const firstIdx = useQuestionIdx ? questionIdx : hashIdx;
  if (firstIdx === -1) {
    if (__urlALen(restUnits) > 0) self.pathname = rest;
  } else if (firstIdx > 0) {
    self.pathname = __urlSub(restUnits, 0, firstIdx);
  }
  if (
    __urlIsSlashedProtocol(lowerProto) &&
    __urlTruthy(self.hostname) &&
    !__urlTruthy(self.pathname)
  ) {
    self.pathname = "/";
  }

  // To support `http.request`.
  if (__urlTruthy(self.pathname) || __urlTruthy(self.search)) {
    const pp: string = __urlTruthy(self.pathname) ? String(self.pathname) : "";
    const ss: string = __urlTruthy(self.search) ? String(self.search) : "";
    self.path = pp + ss;
  }

  // Finally, rebuild `href` from what has been validated.
  self.href = __urlFormatObject(self);
  return self;
}

// ---------------------------------------------------------------------------
// Url.prototype.format
// ---------------------------------------------------------------------------

function __urlFormatObject(self: any): string {
  let auth: string = __urlTruthy(self.auth) ? String(self.auth) : "";
  if (auth !== "") {
    auth = __qsEncodeStr(auth, __urlNoEscapeAuth);
    auth = auth + "@";
  }

  let protocol: string = __urlTruthy(self.protocol) ? String(self.protocol) : "";
  if (protocol !== "") {
    const pu: any = __urlUnits(protocol);
    if (__urlCode(pu[__urlALen(pu) - 1]) !== __URL_CHAR_COLON) protocol = protocol + ":";
  }

  let pathname: string = __urlTruthy(self.pathname) ? String(self.pathname) : "";
  let hash: string = __urlTruthy(self.hash) ? String(self.hash) : "";
  let hostPart = "";
  let query = "";

  if (__urlTruthy(self.host)) {
    hostPart = auth + String(self.host);
  } else if (__urlTruthy(self.hostname)) {
    const hostname: string = String(self.hostname);
    hostPart =
      auth +
      (Number(hostname.indexOf(":")) !== -1 && !__urlIsIpv6Hostname(hostname)
        ? "[" + hostname + "]"
        : hostname);
    if (__urlTruthy(self.port)) hostPart = hostPart + ":" + String(self.port);
  }

  if (self.query !== null && self.query !== undefined && typeof self.query === "object") {
    query = __node_querystring.stringify(self.query);
  }
  let search: string = __urlTruthy(self.search)
    ? String(self.search)
    : query !== ""
      ? "?" + query
      : "";

  if (Number(pathname.indexOf("#")) !== -1 || Number(pathname.indexOf("?")) !== -1) {
    const pnUnits: any = __urlUnits(pathname);
    const len = __urlALen(pnUnits);
    const rebuilt: string[] = [];
    let lastPos = 0;
    for (let i = 0; i < len; i++) {
      const code = __urlCode(pnUnits[i]);
      if (code === __URL_CHAR_HASH || code === __URL_CHAR_QUESTION_MARK) {
        if (i > lastPos) rebuilt.push(__urlSub(pnUnits, lastPos, i));
        rebuilt.push(code === __URL_CHAR_HASH ? "%23" : "%3F");
        lastPos = i + 1;
      }
    }
    if (lastPos < len) rebuilt.push(__urlSubTail(pnUnits, lastPos));
    pathname = rebuilt.join("");
  }

  // Only the slashed protocols get the `//`; not `mailto:`, `xmpp:` and friends,
  // unless they had it to begin with.
  if (__urlTruthy(self.slashes) || __urlIsSlashedProtocol(protocol)) {
    if (__urlTruthy(self.slashes) || hostPart !== "") {
      if (pathname !== "") {
        const pu2: any = __urlUnits(pathname);
        if (__urlCode(pu2[0]) !== __URL_CHAR_FORWARD_SLASH) pathname = "/" + pathname;
      }
      hostPart = "//" + hostPart;
    } else if (__urlLen(protocol) >= 4 && protocol.slice(0, 4) === "file") {
      hostPart = "//";
    }
  }

  // Escape `#` in the search.
  if (Number(search.indexOf("#")) !== -1) {
    const su: any = search.split("#");
    search = su.join("%23");
  }

  if (hash !== "") {
    const hu: any = __urlUnits(hash);
    if (__urlCode(hu[0]) !== __URL_CHAR_HASH) hash = "#" + hash;
  }
  if (search !== "") {
    const su2: any = __urlUnits(search);
    if (__urlCode(su2[0]) !== __URL_CHAR_QUESTION_MARK) search = "?" + search;
  }

  return protocol + hostPart + pathname + search + hash;
}

// ---------------------------------------------------------------------------
// Url.prototype.resolveObject
// ---------------------------------------------------------------------------

function __urlShift(list: any): any {
  if (__urlALen(list) === 0) return undefined;
  const removed: any = list.splice(0, 1);
  return removed[0];
}

function __urlCharAt0(value: any): string {
  return typeof value === "string" && __urlLen(value) > 0 ? value.slice(0, 1) : "";
}

function __urlResolveObjectFrom(source: any, relativeIn: any): any {
  // The `typeof` test names `relativeIn`, not `relative`, on purpose: narrowing
  // a variable with `typeof x === "string"` and then assigning an object to that
  // same variable makes every later member read on it compile as a *string*
  // member access, and the interpreter aborts with "expected object, found
  // Str(…)". New bug, reported with this work; narrowing a different binding is
  // unaffected, so the two names are the whole workaround.
  let relative: any = relativeIn;
  if (typeof relativeIn === "string") {
    const rel: any = new Url();
    __urlParseInto(rel, relativeIn, false, true);
    relative = rel;
  }

  const result: any = new Url();
  __urlCopyInto(result, source, false);

  // The hash is always overridden, whatever it is — even `href=""` removes it.
  result.hash = relative.hash;

  // An empty relative URL leaves nothing to do.
  if (relative.href === "") {
    result.href = __urlFormatObject(result);
    return result;
  }

  // An href like `//foo/bar` always cuts to the protocol.
  if (__urlTruthy(relative.slashes) && !__urlTruthy(relative.protocol)) {
    __urlCopyInto(result, relative, true);

    // `parse` appends a trailing `/` to urls like `http://www.example.com`.
    if (
      __urlIsSlashedProtocol(result.protocol) &&
      __urlTruthy(result.hostname) &&
      !__urlTruthy(result.pathname)
    ) {
      result.pathname = "/";
      result.path = "/";
    }

    result.href = __urlFormatObject(result);
    return result;
  }

  if (__urlTruthy(relative.protocol) && relative.protocol !== result.protocol) {
    // Changing the protocol does strange things when it is a known one: unless
    // it is `file:` we MUST have a host, and if there was a path to begin with
    // we MUST have a path. `file:` drops the host, because it is known to be
    // hostless. Anything else is assumed absolute.
    if (!__urlIsSlashedProtocol(relative.protocol)) {
      __urlCopyInto(result, relative, false);
      result.href = __urlFormatObject(result);
      return result;
    }

    result.protocol = relative.protocol;
    if (
      !__urlTruthy(relative.host) &&
      !__urlIsFileProtocol(relative.protocol) &&
      !__urlIsHostlessProtocol(relative.protocol)
    ) {
      const relPath: any = (__urlTruthy(relative.pathname)
        ? String(relative.pathname)
        : ""
      ).split("/");
      while (__urlALen(relPath) > 0) {
        relative.host = __urlShift(relPath);
        if (__urlTruthy(relative.host)) break;
      }
      if (!__urlTruthy(relative.host)) relative.host = "";
      if (!__urlTruthy(relative.hostname)) relative.hostname = "";
      if (relPath[0] !== "") relPath.splice(0, 0, "");
      if (__urlALen(relPath) < 2) relPath.splice(0, 0, "");
      result.pathname = relPath.join("/");
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = __urlTruthy(relative.host) ? relative.host : "";
    result.auth = relative.auth;
    result.hostname = __urlTruthy(relative.hostname) ? relative.hostname : relative.host;
    result.port = relative.port;
    // To support `http.request`.
    if (__urlTruthy(result.pathname) || __urlTruthy(result.search)) {
      const pp: string = __urlTruthy(result.pathname) ? String(result.pathname) : "";
      const ss: string = __urlTruthy(result.search) ? String(result.search) : "";
      result.path = pp + ss;
    }
    if (!__urlTruthy(result.slashes)) result.slashes = relative.slashes;
    result.href = __urlFormatObject(result);
    return result;
  }

  const isSourceAbs = __urlTruthy(result.pathname) && __urlCharAt0(result.pathname) === "/";
  const isRelAbs =
    __urlTruthy(relative.host) ||
    (__urlTruthy(relative.pathname) && __urlCharAt0(relative.pathname) === "/");
  let mustEndAbs =
    isRelAbs || isSourceAbs || (__urlTruthy(result.host) && __urlTruthy(relative.pathname));
  const removeAllDots = mustEndAbs;
  let srcPath: any = __urlTruthy(result.pathname) ? String(result.pathname).split("/") : [];
  const relPath: any = __urlTruthy(relative.pathname)
    ? String(relative.pathname).split("/")
    : [];
  const noLeadingSlashes =
    __urlTruthy(result.protocol) && !__urlIsSlashedProtocol(result.protocol);

  // In a non-slashed URL, relative links like `../..` are allowed to crawl up
  // to the hostname as well. This is strange, and it is what Node does: the
  // first path part is put into the host field further down.
  if (noLeadingSlashes) {
    result.hostname = "";
    result.port = null;
    if (__urlTruthy(result.host)) {
      if (srcPath[0] === "") srcPath[0] = result.host;
      else srcPath.splice(0, 0, result.host);
    }
    result.host = "";
    if (__urlTruthy(relative.protocol)) {
      relative.hostname = null;
      relative.port = null;
      result.auth = null;
      if (__urlTruthy(relative.host)) {
        if (relPath[0] === "") relPath[0] = relative.host;
        else relPath.splice(0, 0, relative.host);
      }
      relative.host = null;
    }
    if (mustEndAbs) mustEndAbs = relPath[0] === "" || srcPath[0] === "";
  }

  if (isRelAbs) {
    // It is absolute.
    if (__urlTruthy(relative.host) || relative.host === "") {
      if (result.host !== relative.host) result.auth = null;
      result.host = relative.host;
      result.port = relative.port;
    }
    if (__urlTruthy(relative.hostname) || relative.hostname === "") {
      if (result.hostname !== relative.hostname) result.auth = null;
      result.hostname = relative.hostname;
    }
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // Fall through to the dot handling below.
  } else if (__urlALen(relPath) > 0) {
    // It is relative: throw away the existing file and take the new path.
    srcPath.splice(__urlALen(srcPath) - 1, 1);
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (relative.search !== null && relative.search !== undefined) {
    // Just pull out the search, as in `href='?foo'`. This comes after the other
    // two cases because it simplifies the booleans.
    if (noLeadingSlashes) {
      result.hostname = __urlShift(srcPath);
      result.host = result.hostname;
      // The auth occasionally gets stuck in the host alone, especially in cases
      // like `url.resolveObject('mailto:local1@domain1', 'local2@domain2')`.
      if (__urlTruthy(result.host) && Number(String(result.host).indexOf("@")) > 0) {
        const authInHost: any = String(result.host).split("@");
        result.auth = __urlShift(authInHost);
        result.host = __urlShift(authInHost);
        result.hostname = result.host;
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    // To support `http.request`.
    if (result.pathname !== null || result.search !== null) {
      result.path =
        (__urlTruthy(result.pathname) ? String(result.pathname) : "") +
        (__urlTruthy(result.search) ? String(result.search) : "");
    }
    result.href = __urlFormatObject(result);
    return result;
  }

  if (__urlALen(srcPath) === 0) {
    // No path at all; everything else was handled above.
    result.pathname = null;
    // To support `http.request`.
    if (__urlTruthy(result.search)) {
      result.path = "/" + String(result.search);
    } else {
      result.path = null;
    }
    result.href = __urlFormatObject(result);
    return result;
  }

  // A URL ending in `.` or `..` must get a trailing slash; one ending in
  // anything else non-slashy must NOT.
  let last: any = srcPath[__urlALen(srcPath) - 1];
  const hasTrailingSlash =
    ((__urlTruthy(result.host) || __urlTruthy(relative.host) || __urlALen(srcPath) > 1) &&
      (last === "." || last === "..")) ||
    last === "";

  // Strip single dots and resolve double dots to the parent. When the path tries
  // to go above the root, `up` ends up greater than 0.
  let up = 0;
  for (let i = __urlALen(srcPath) - 1; i >= 0; i--) {
    last = srcPath[i];
    if (last === ".") {
      srcPath.splice(i, 1);
    } else if (last === "..") {
      srcPath.splice(i, 1);
      up = up + 1;
    } else if (up > 0) {
      srcPath.splice(i, 1);
      up = up - 1;
    }
  }

  // Where the path may go above the root, restore the leading `..`s.
  if (!mustEndAbs && !removeAllDots) {
    while (up > 0) {
      srcPath.splice(0, 0, "..");
      up = up - 1;
    }
  }

  if (
    mustEndAbs &&
    srcPath[0] !== "" &&
    (!__urlTruthy(srcPath[0]) || __urlCharAt0(srcPath[0]) !== "/")
  ) {
    srcPath.splice(0, 0, "");
  }

  if (hasTrailingSlash) {
    const joined: string = srcPath.join("/");
    if (__urlLen(joined) === 0 || joined.slice(__urlLen(joined) - 1) !== "/") {
      srcPath.push("");
    }
  }

  const isAbsolute =
    srcPath[0] === "" || (__urlTruthy(srcPath[0]) && __urlCharAt0(srcPath[0]) === "/");

  // Put the host back.
  if (noLeadingSlashes) {
    result.hostname = isAbsolute ? "" : __urlALen(srcPath) > 0 ? __urlShift(srcPath) : "";
    result.host = result.hostname;
    if (__urlTruthy(result.host) && Number(String(result.host).indexOf("@")) > 0) {
      const authInHost: any = String(result.host).split("@");
      result.auth = __urlShift(authInHost);
      result.host = __urlShift(authInHost);
      result.hostname = result.host;
    }
  }

  if (!mustEndAbs) {
    mustEndAbs = __urlTruthy(result.host) && __urlALen(srcPath) > 0;
  }

  if (mustEndAbs && !isAbsolute) srcPath.splice(0, 0, "");

  if (__urlALen(srcPath) === 0) {
    result.pathname = null;
    result.path = null;
  } else {
    result.pathname = srcPath.join("/");
  }

  // To support `http.request`.
  if (result.pathname !== null || result.search !== null) {
    result.path =
      (__urlTruthy(result.pathname) ? String(result.pathname) : "") +
      (__urlTruthy(result.search) ? String(result.search) : "");
  }
  result.auth = __urlTruthy(relative.auth) ? relative.auth : result.auth;
  if (!__urlTruthy(result.slashes)) result.slashes = relative.slashes;
  result.href = __urlFormatObject(result);
  return result;
}

// ---------------------------------------------------------------------------
// url.parse / url.format / url.resolve / url.resolveObject
// ---------------------------------------------------------------------------

const __urlParseWarned: any = { done: false };

function __urlParse(url: any, parseQueryString?: any, slashesDenoteHost?: any): any {
  if (__urlParseWarned.done !== true) {
    __urlParseWarned.done = true;
    process.emitWarning(
      "`url.parse()` behavior is not standardized and prone to errors that have " +
        "security implications. Use the WHATWG URL API instead. CVEs are not issued " +
        "for `url.parse()` vulnerabilities.",
      "DeprecationWarning",
      "DEP0169",
    );
  }

  if (url instanceof Url) return url;

  const urlObject: any = new Url();
  __urlParseInto(urlObject, url, parseQueryString, slashesDenoteHost);
  return urlObject;
}

function __urlFormat(urlObject: any, options?: any): string {
  // A string is cleaned up by parsing it first; an object is used as it is.
  if (typeof urlObject === "string") {
    return __urlFormatObject(__urlParse(urlObject));
  }
  if (typeof urlObject !== "object" || urlObject === null) {
    throw new ERR_INVALID_ARG_TYPE("urlObject", ["Object", "string"], urlObject);
  }
  if (urlObject instanceof URL) {
    let fragment = true;
    let unicode = false;
    let search = true;
    let auth = true;

    if (__urlTruthy(options)) {
      __urlValidateObject(options, "options");
      if (options.fragment !== undefined && options.fragment !== null) {
        fragment = __urlTruthy(options.fragment);
      }
      if (options.unicode !== undefined && options.unicode !== null) {
        unicode = __urlTruthy(options.unicode);
      }
      if (options.search !== undefined && options.search !== null) {
        search = __urlTruthy(options.search);
      }
      if (options.auth !== undefined && options.auth !== null) {
        auth = __urlTruthy(options.auth);
      }
    }

    return __urlFormatWhatwg(urlObject, fragment, unicode, search, auth);
  }

  return __urlFormatObject(urlObject);
}

// Node delegates this to `bindingUrl.format(href, fragment, unicode, search,
// auth)`, which re-serializes ada's parsed URL with four components switched on
// or off. Rebuilt here from the prelude URL's own getters.
function __urlFormatWhatwg(
  instance: any,
  fragment: boolean,
  unicode: boolean,
  search: boolean,
  auth: boolean,
): string {
  const protocol: string = String(instance.protocol);
  const hostname: string = String(instance.hostname);
  const port: string = String(instance.port);
  const username: string = String(instance.username);
  const password: string = String(instance.password);

  let out = protocol;
  const hostValue: string = unicode ? __pcToUnicode(hostname) : hostname;
  if (hostValue !== "" || protocol === "file:") {
    out = out + "//";
    if (auth && (username !== "" || password !== "")) {
      out = out + username;
      if (password !== "") out = out + ":" + password;
      out = out + "@";
    }
    out = out + hostValue;
    if (port !== "") out = out + ":" + port;
  }
  out = out + String(instance.pathname);
  if (search) out = out + String(instance.search);
  if (fragment) out = out + String(instance.hash);
  return out;
}

function __urlResolve(source: any, relative: any): string {
  const parsed: any = __urlParse(source, false, true);
  return __urlFormatObject(__urlResolveObjectFrom(parsed, relative));
}

function __urlResolveObject(source: any, relative: any): any {
  if (!__urlTruthy(source)) return relative;
  return __urlResolveObjectFrom(__urlParse(source, false, true), relative);
}

// ---------------------------------------------------------------------------
// The WHATWG side: building and reading prelude `URL` instances
// ---------------------------------------------------------------------------

// `isURL(value)`.
//
// Node duck-types it — `self?.href && self.protocol && self.auth === undefined
// && self.path === undefined` — because its `URL` keeps everything in getters on
// the prototype and the test has to accept a URL from another realm. Neither
// applies here, and the duck-type would give the *wrong* answer: the prelude
// `URL` carries an internal field literally called `path`, so
// `self.path === undefined` is false for a genuine URL. Identity against the
// class is both correct and what the duck-type stands in for; a legacy `Url` and
// a plain object both answer false, which is exactly what
// `test-url-is-url-internal.js` asserts.
function __urlIsURL(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  return value instanceof URL;
}

// Build a genuine prelude `URL` from components. A Zun class has no constructor
// body, so `new URL(...)` fills the declared fields in order — `input`,
// `loaded`, `scheme`, `userinfo`, `hostName`, `portText`, `path`, `query`,
// `fragment`, `params` — and passing `loaded` as `true` makes the lazy parser
// short-circuit, so every getter answers what we put there. See the header note.
function __urlMakeURL(
  scheme: string,
  userinfo: string,
  hostValue: string,
  port: string,
  pathname: string,
  query: string,
  fragment: string,
): any {
  const params: any = new URLSearchParams(query);
  const href: string =
    scheme + "://" + (userinfo === "" ? "" : userinfo + "@") +
    hostValue + (port === "" ? "" : ":" + port) + pathname + query + fragment;
  return new URL(
    href, true, scheme, userinfo, hostValue, port, pathname, query, fragment, params,
  );
}

// The percent-encode set `pathToFileURL` applies to a file path, taken from the
// outputs Node's own `test-url-pathtofileurl.js` pins: every code unit at or
// below U+0020, DEL, and `" # % < > ? [ \ ] ^ { | } ~` and the backtick. `!`,
// `$`, `&`, `'`, `(`, `)`, `*`, `+`, `,`, `-`, `.`, `/`, `:`, `;`, `=`, `@`,
// `_`, the digits and both alphabets go through untouched.
function __urlFilePathNeedsEncoding(code: number): boolean {
  if (code <= 0x20 || code === 0x7f) return true;
  return (
    code === 0x22 /* " */ ||
    code === 0x23 /* # */ ||
    code === 0x25 /* % */ ||
    code === 0x3c /* < */ ||
    code === 0x3e /* > */ ||
    code === 0x3f /* ? */ ||
    code === 0x5b /* [ */ ||
    code === 0x5c /* \ */ ||
    code === 0x5d /* ] */ ||
    code === 0x5e /* ^ */ ||
    code === 0x60 /* ` */ ||
    code === 0x7b /* { */ ||
    code === 0x7c /* | */ ||
    code === 0x7d /* } */ ||
    code === 0x7e /* ~ */
  );
}

const __URL_HEX: string = "0123456789ABCDEF";

function __urlPercentByte(byte: number): string {
  return "%" + __URL_HEX.charAt(Math.floor(byte / 16)) + __URL_HEX.charAt(byte % 16);
}

// Percent-encode a file path's UTF-8 bytes under the set above.
function __urlEncodeFilePath(pathname: string): string {
  const units: any = __urlUnits(pathname);
  const n = __urlALen(units);
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let code = __urlCode(units[i]);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      const next = __urlCode(units[i + 1]);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) * 1024) + (next - 0xdc00);
        i = i + 1;
      }
    }
    if (code < 0x80) {
      out.push(
        __urlFilePathNeedsEncoding(code) ? __urlPercentByte(code) : (units[i] as string),
      );
    } else if (code < 0x800) {
      out.push(__urlPercentByte(0xc0 | Math.floor(code / 64)));
      out.push(__urlPercentByte(0x80 | (code & 0x3f)));
    } else if (code < 0x10000) {
      out.push(__urlPercentByte(0xe0 | Math.floor(code / 4096)));
      out.push(__urlPercentByte(0x80 | (Math.floor(code / 64) & 0x3f)));
      out.push(__urlPercentByte(0x80 | (code & 0x3f)));
    } else {
      out.push(__urlPercentByte(0xf0 | Math.floor(code / 262144)));
      out.push(__urlPercentByte(0x80 | (Math.floor(code / 4096) & 0x3f)));
      out.push(__urlPercentByte(0x80 | (Math.floor(code / 64) & 0x3f)));
      out.push(__urlPercentByte(0x80 | (code & 0x3f)));
    }
    i = i + 1;
  }
  return out.join("");
}

// A WHATWG parse of a `file:` URL string, answering a prelude `URL`.
//
// The prelude's own parser cannot do this one: it requires a non-empty
// authority, so `new URL("file:///C:/foo")` throws there. Only what
// `fileURLToPath` needs is implemented — leading/trailing C0-and-space trim,
// removal of embedded tab/newline/carriage return, the host, the path with its
// dot segments removed, the query and the fragment — and the result is a
// genuine `URL` built from those components.
function __urlParseFileURL(input: string): any {
  // Trim leading and trailing C0 controls and spaces.
  const raw: any = __urlUnits(input);
  let from = 0;
  let to = __urlALen(raw);
  while (from < to && __urlCode(raw[from]) <= 0x20) from = from + 1;
  while (to > from && __urlCode(raw[to - 1]) <= 0x20) to = to - 1;
  const kept: string[] = [];
  for (let i = from; i < to; i++) {
    const code = __urlCode(raw[i]);
    if (code === 9 || code === 10 || code === 13) continue;
    kept.push(raw[i] as string);
  }
  let rest: string = kept.join("");

  // The scheme.
  const colon = Number(rest.indexOf(":"));
  if (colon < 0) throw new ERR_INVALID_URL(input);
  const scheme: string = rest.slice(0, colon).toLowerCase();
  rest = rest.slice(colon + 1);

  // The fragment, then the query.
  let fragment = "";
  const hashAt = Number(rest.indexOf("#"));
  if (hashAt >= 0) {
    fragment = "#" + rest.slice(hashAt + 1);
    if (fragment === "#") fragment = "";
    rest = rest.slice(0, hashAt);
  }
  let query = "";
  const qAt = Number(rest.indexOf("?"));
  if (qAt >= 0) {
    query = "?" + rest.slice(qAt + 1);
    if (query === "?") query = "";
    rest = rest.slice(0, qAt);
  }

  // The authority, when the remainder opens with `//`.
  let hostValue = "";
  let pathname = rest;
  if (__urlLen(rest) >= 2 && rest.slice(0, 2) === "//") {
    const afterSlashes: string = rest.slice(2);
    const slashAt = Number(afterSlashes.indexOf("/"));
    if (slashAt < 0) {
      hostValue = afterSlashes;
      pathname = "";
    } else {
      hostValue = afterSlashes.slice(0, slashAt);
      pathname = afterSlashes.slice(slashAt);
    }
    // `file://localhost/x` is `file:///x`.
    if (hostValue.toLowerCase() === "localhost") hostValue = "";
    hostValue = hostValue.toLowerCase();
  }

  if (pathname === "") pathname = "/";
  pathname = __urlRemoveDotSegments(pathname);

  return __urlMakeURL(scheme, "", hostValue, "", pathname, query, fragment);
}

// WHATWG "shorten"/dot-segment removal over an absolute path.
function __urlRemoveDotSegments(pathname: string): string {
  if (__urlLen(pathname) === 0) return pathname;
  const parts: any = pathname.split("/");
  // `any`-typed, because the checker demands an integer literal for the start
  // index of a *typed* array's `splice` (same family as issue #3).
  const outParts: any = [];
  const n = __urlALen(parts);
  for (let i = 0; i < n; i++) {
    const segment: string = parts[i] as string;
    if (segment === "." || segment.toLowerCase() === "%2e") {
      if (i === n - 1) outParts.push("");
      continue;
    }
    if (segment === "..") {
      if (__urlALen(outParts) > 1) outParts.splice(__urlALen(outParts) - 1, 1);
      if (i === n - 1) outParts.push("");
      continue;
    }
    outParts.push(segment);
  }
  const joined: string = outParts.join("/");
  return __urlLen(joined) === 0 ? "/" : joined;
}

// ---------------------------------------------------------------------------
// fileURLToPath
// ---------------------------------------------------------------------------

function __urlThirdLowered(units: any, n: number, index: number): number {
  if (index >= n) return 0;
  return __urlCode(units[index]) | 0x20;
}

function __urlPathFromURLWin32(url: any): string {
  const hostname: string = String(url.hostname);
  let pathname: string = String(url.pathname);
  const units: any = __urlUnits(pathname);
  const n = __urlALen(units);
  for (let k = 0; k < n; k++) {
    if (__urlCode(units[k]) === __URL_CHAR_PERCENT) {
      const third = __urlThirdLowered(units, n, k + 2);
      const second: string = k + 1 < n ? (units[k + 1] as string) : "";
      if ((second === "2" && third === 102) || (second === "5" && third === 99)) {
        // 2f/2F `/` and 5c/5C `\`
        throw new ERR_INVALID_FILE_URL_PATH(
          "must not include encoded \\ or / characters",
          url,
        );
      }
    }
  }
  const slashed: any = pathname.split("/");
  pathname = slashed.join("\\");
  pathname = decodeURIComponent(pathname);
  if (hostname !== "") {
    // A hostname means a UNC path. The hostname goes through `domainToUnicode`
    // in case it is an IDN in punycode form; percent-encoding is already gone,
    // because the URL parser took care of it.
    return "\\\\" + __urlDomainToUnicode(hostname) + pathname;
  }
  // Otherwise it is a local path, which needs a drive letter.
  const decoded: any = __urlUnits(pathname);
  const dn = __urlALen(decoded);
  const letter = dn > 1 ? __urlCode(decoded[1]) | 0x20 : 0x20;
  const sep: string = dn > 2 ? (decoded[2] as string) : "";
  if (letter < 97 || letter > 122 || sep !== ":") {
    throw new ERR_INVALID_FILE_URL_PATH("must be absolute", url);
  }
  return pathname.slice(1);
}

function __urlPathFromURLPosix(url: any): string {
  if (String(url.hostname) !== "") {
    throw new ERR_INVALID_FILE_URL_HOST(String(process.platform));
  }
  const pathname: string = String(url.pathname);
  const units: any = __urlUnits(pathname);
  const n = __urlALen(units);
  for (let k = 0; k < n; k++) {
    if (__urlCode(units[k]) === __URL_CHAR_PERCENT) {
      const third = __urlThirdLowered(units, n, k + 2);
      const second: string = k + 1 < n ? (units[k + 1] as string) : "";
      if (second === "2" && third === 102) {
        throw new ERR_INVALID_FILE_URL_PATH("must not include encoded / characters", url);
      }
    }
  }
  return decodeURIComponent(pathname);
}

function __urlFileURLToPath(input: any, options?: any): string {
  // `typeof input`, not `typeof target` — see the note in
  // `__urlResolveObjectFrom`.
  let target: any = input;
  if (typeof input === "string") {
    target = __urlParseFileURL(input);
  } else if (!__urlIsURL(input)) {
    throw new ERR_INVALID_ARG_TYPE("path", ["string", "URL"], input);
  }
  if (String(target.protocol) !== "file:") throw new ERR_INVALID_URL_SCHEME("file");

  let windows: any = undefined;
  if (options !== undefined && options !== null) windows = options.windows;
  const useWindows: boolean =
    windows === undefined || windows === null
      ? process.platform === "win32"
      : __urlTruthy(windows);
  return useWindows ? __urlPathFromURLWin32(target) : __urlPathFromURLPosix(target);
}

// ---------------------------------------------------------------------------
// pathToFileURL
// ---------------------------------------------------------------------------

// `path.posix.resolve` is O(n²) in the path's length on this engine
// (https://github.com/UrubuCode/zun/issues/12 — measured: 11 seconds for a
// 10 000-character path), and `pathToFileURL` is handed paths of arbitrary
// length: Node's own test passes one 32 767 characters long. For an *absolute*
// posix path every segment of which is non-empty and is neither "." nor "..",
// `resolve` has nothing to normalize and no trailing separator to strip, so it
// is the identity — and that is decided here in one linear pass. Anything else
// still goes to `path.posix.resolve`. Windows paths are always handed to
// `path.win32.resolve`, because the drive/UNC rules are its business and no
// long Windows path reaches here.
function __urlResolvePosixFast(filepath: string): string {
  const parts: any = filepath.split("/");
  const n = __urlALen(parts);
  if (n < 2) return __node_path.posix.resolve(filepath);
  if ((parts[0] as string) !== "") return __node_path.posix.resolve(filepath);
  for (let i = 1; i < n; i++) {
    const segment: string = parts[i] as string;
    if (segment === "" || segment === "." || segment === "..") {
      return __node_path.posix.resolve(filepath);
    }
  }
  return filepath;
}

function __urlPathToFileURL(filepath: any, options?: any): any {
  __urlValidateString(filepath, "path");

  let windowsOption: any = undefined;
  if (options !== undefined && options !== null) windowsOption = options.windows;
  const windows: boolean =
    windowsOption === undefined || windowsOption === null
      ? process.platform === "win32"
      : __urlTruthy(windowsOption);

  const text: string = String(filepath);

  // `\\?\C:\…` is the Win32 *local device* prefix, not a UNC name, even though
  // it opens with two backslashes. Node hands the whole string to ada's
  // `from_windows_path`, which strips the prefix and treats the remainder as an
  // ordinary drive path (`file:///C:/…`); only `\\?\UNC\server\share` keeps
  // going through the UNC branch below, where its 8-character prefix is what
  // recognises it.
  const hasLocalDevicePrefix: boolean =
    windows &&
    __urlLen(text) >= 4 &&
    text.slice(0, 4) === "\\\\?\\" &&
    !(__urlLen(text) >= 8 && text.slice(0, 8).toUpperCase() === "\\\\?\\UNC\\");

  const isUNC: boolean =
    windows &&
    !hasLocalDevicePrefix &&
    __urlLen(text) >= 2 &&
    text.slice(0, 2) === "\\\\";
  let resolved: string = hasLocalDevicePrefix
    ? __node_path.win32.resolve(text.slice(4))
    : isUNC
      ? text
      : windows
        ? __node_path.win32.resolve(text)
        : __urlResolvePosixFast(text);

  if (isUNC || (windows && __urlLen(resolved) >= 2 && resolved.slice(0, 2) === "\\\\")) {
    // UNC path format: `\\server\share\resource`. The extended prefix
    // `\\?\UNC\` is ignored.
    // https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation
    const isExtendedUNC: boolean =
      __urlLen(resolved) >= 8 && resolved.slice(0, 8) === "\\\\?\\UNC\\";
    const prefixLength = isExtendedUNC ? 8 : 2;
    const hostnameEndIndex = Number(resolved.indexOf("\\", prefixLength));
    if (hostnameEndIndex === -1) {
      throw new ERR_INVALID_ARG_VALUE("path", resolved, "Missing UNC resource path");
    }
    if (hostnameEndIndex === 2) {
      throw new ERR_INVALID_ARG_VALUE("path", resolved, "Empty UNC servername");
    }
    const hostname: string = resolved.slice(prefixLength, hostnameEndIndex);
    const tail: any = resolved.slice(hostnameEndIndex).split("\\");
    return __urlMakeURL(
      "file",
      "",
      __pcToASCII(hostname).toLowerCase(),
      "",
      __urlEncodeFilePath(tail.join("/")),
      "",
      "",
    );
  }

  // `path.resolve` strips trailing separators, so they are put back.
  const lastCode: number =
    __urlLen(text) === 0 ? -1 : __urlCode(__urlUnits(text)[__urlLen(text) - 1]);
  const sep: string = windows ? "\\" : "/";
  if (
    (lastCode === __URL_CHAR_FORWARD_SLASH ||
      (windows && lastCode === __URL_CHAR_BACKWARD_SLASH)) &&
    (__urlLen(resolved) === 0 || resolved.slice(__urlLen(resolved) - 1) !== sep)
  ) {
    resolved = resolved + "/";
  }

  // A Windows path's separators become `/` before encoding; a posix path's
  // backslashes are ordinary characters and get percent-encoded.
  let pathname: string = resolved;
  if (windows) {
    const segments: any = resolved.split("\\");
    pathname = segments.join("/");
  }
  if (__urlLen(pathname) === 0 || pathname.slice(0, 1) !== "/") pathname = "/" + pathname;

  return __urlMakeURL("file", "", "", "", __urlEncodeFilePath(pathname), "", "");
}

// ---------------------------------------------------------------------------
// urlToHttpOptions
// ---------------------------------------------------------------------------

function __urlToHttpOptions(url: any): any {
  __urlValidateObject(url, "url");

  // Read the components first: the prelude URL parses lazily, so this is what
  // populates the fields the copy below picks up.
  const hostname: any = url.hostname;
  const pathname: any = url.pathname;
  const port: any = url.port;
  const username: any = url.username;
  const password: any = url.password;
  const search: any = url.search;

  const options: any = { __proto__: null };
  // Node spreads `...url` here, in case the object was extended by the user.
  for (const key of Object.keys(url)) options[key] = url[key];

  options.protocol = url.protocol;
  options.hostname =
    typeof hostname === "string" && __urlLen(hostname) > 0 && hostname.slice(0, 1) === "["
      ? hostname.slice(1, __urlLen(hostname) - 1)
      : hostname;
  options.hash = url.hash;
  options.search = search;
  options.pathname = pathname;
  options.path =
    (__urlTruthy(pathname) ? String(pathname) : "") +
    (__urlTruthy(search) ? String(search) : "");
  options.href = url.href;

  if (port !== "") options.port = Number(port);
  if (__urlTruthy(username) || __urlTruthy(password)) {
    options.auth =
      decodeURIComponent(String(username)) + ":" + decodeURIComponent(String(password));
  }
  return options;
}

// ---------------------------------------------------------------------------
// domainToASCII / domainToUnicode
// ---------------------------------------------------------------------------

function __urlDomainToASCII(domain: any): string {
  return __pcToASCII(String(domain));
}

function __urlDomainToUnicode(domain: any): string {
  return __pcToUnicode(String(domain));
}

// ---------------------------------------------------------------------------
// The module object
//
// The functions are property-assigned function expressions rather than
// shorthand methods, for the reason spelled out in `querystring.ts`: that is
// the spelling that is callable through the module object *and* reads back out
// of it as a value, which Node's tests do constantly
// (`const { urlToHttpOptions } = require('url')`).
// ---------------------------------------------------------------------------

const url: any = {
  // The original API.
  Url: Url,
  parse: function (...rest: any[]): any {
    return __urlParse(rest[0], rest[1], rest[2]);
  },
  resolve: function (...rest: any[]): string {
    return __urlResolve(rest[0], rest[1]);
  },
  resolveObject: function (...rest: any[]): any {
    return __urlResolveObject(rest[0], rest[1]);
  },
  format: function (...rest: any[]): string {
    return __urlFormat(rest[0], rest[1]);
  },

  // The WHATWG API. `URL` and `URLSearchParams` are the engine's prelude
  // classes, which is the same relationship `node:url` has with the globals in
  // Node. `URLPattern` is a declared gap; see the header note.
  URL: URL,
  URLSearchParams: URLSearchParams,
  URLPattern: undefined,
  domainToASCII: function (...rest: any[]): string {
    if (__urlALen(rest) < 1) throw new ERR_MISSING_ARGS("domain");
    return __urlDomainToASCII(rest[0]);
  },
  domainToUnicode: function (...rest: any[]): string {
    if (__urlALen(rest) < 1) throw new ERR_MISSING_ARGS("domain");
    return __urlDomainToUnicode(rest[0]);
  },

  // Utilities.
  pathToFileURL: function (...rest: any[]): any {
    return __urlPathToFileURL(rest[0], rest[1]);
  },
  fileURLToPath: function (...rest: any[]): string {
    return __urlFileURLToPath(rest[0], rest[1]);
  },
  urlToHttpOptions: function (...rest: any[]): any {
    return __urlToHttpOptions(rest[0]);
  },
};

// `node:url` module object for the bundler's `require` rewriting.
const __node_url: any = url;

// `internal/url` is `url`'s own implementation surface, not a separate module —
// the same relationship `internal/util` has with `util`, and the reason
// `test-url-is-url-internal.js` can ask for `isURL` under
// `--expose-internals`.
const __node_internal_url: any = {
  URL: URL,
  URLSearchParams: URLSearchParams,
  URLPattern: undefined,
  isURL: function (...rest: any[]): boolean {
    return __urlIsURL(rest[0]);
  },
  domainToASCII: function (...rest: any[]): string {
    return __urlDomainToASCII(rest[0]);
  },
  domainToUnicode: function (...rest: any[]): string {
    return __urlDomainToUnicode(rest[0]);
  },
  fileURLToPath: function (...rest: any[]): string {
    return __urlFileURLToPath(rest[0], rest[1]);
  },
  pathToFileURL: function (...rest: any[]): any {
    return __urlPathToFileURL(rest[0], rest[1]);
  },
  urlToHttpOptions: function (...rest: any[]): any {
    return __urlToHttpOptions(rest[0]);
  },
  unsafeProtocol: function (...rest: any[]): boolean {
    return __urlIsUnsafeProtocol(rest[0]);
  },
  hostlessProtocol: function (...rest: any[]): boolean {
    return __urlIsHostlessProtocol(rest[0]);
  },
  slashedProtocol: function (...rest: any[]): boolean {
    return __urlIsSlashedProtocol(rest[0]);
  },
};

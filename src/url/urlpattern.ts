// The WHATWG URL Pattern Standard — `URLPattern` — in Zun TypeScript.
//
// This file follows https://urlpattern.spec.whatwg.org/ step for step: the
// tokenizer (strict and lenient policies), the pattern parser and its part
// list, the regular-expression and pattern-string generators, the constructor
// string parser, "process a URLPatternInit", the per-component canonicalizers
// and `exec`/`test`. Node implements the class in C++ over ada's
// `url_pattern`; the argument validation and its `ERR_*` codes come from
// `src/node_url_pattern.cc` (MIT, Copyright Node.js contributors).
//
// It stands on `src/url/whatwg.ts`, which is inlined before it: the
// canonicalizers run the *basic URL parser* with a state override over a
// dummy URL record (`__wuBasicParse`), exactly as the standard specifies,
// instead of going through `URL` setters, which swallow failures.
//
// ---------------------------------------------------------------------------
// Engine gaps this file lives with
// ---------------------------------------------------------------------------
//
//   * **`new.target` is always `undefined`**, even under `new`
//     (zun#131). Node answers a call without `new` with
//     `ERR_CONSTRUCT_CALL_REQUIRED`, and a class called without `new` throws a
//     plain `TypeError` here, so the exported `URLPattern` is a constructor
//     *function* that tells the two calls apart by its receiver and returns a
//     `NodeURLPattern` instance; its `prototype` is the class prototype, so
//     `instanceof URLPattern` holds.
//   * Class accessors and methods run on any receiver, so every accessor,
//     `exec` and `test` performs the brand check itself and answers
//     "Illegal invocation" as V8 does for a C++-backed class.
//   * `__wuUnits()`/`__wuALen()` from `whatwg.ts` for the same reasons as
//     there (https://github.com/UrubuCode/zun/issues/12,
//     https://github.com/UrubuCode/zun/issues/3).
//   * The encoding callbacks are an integer kind rather than a function value,
//     because a function that travels through a record or an array comes back
//     boxed (https://github.com/UrubuCode/zun/issues/17).
//
// The generated regular expressions use the `v` flag, as the standard does.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ERR_URLPATTERN_ARG_TYPE extends NodeTypeError {
  constructor(message: string) {
    super("ERR_INVALID_ARG_TYPE", message);
  }
}

class ERR_CONSTRUCT_CALL_REQUIRED extends NodeTypeError {
  constructor() {
    super("ERR_CONSTRUCT_CALL_REQUIRED", "Class constructor URLPattern cannot be invoked without 'new'");
  }
}

function __upFail(what: string): any {
  throw new TypeError("Failed to construct 'URLPattern': " + what);
}

// ---------------------------------------------------------------------------
// Tokenizer (https://urlpattern.spec.whatwg.org/#tokenizing)
// ---------------------------------------------------------------------------

const __UP_T_OPEN = 0;
const __UP_T_CLOSE = 1;
const __UP_T_REGEXP = 2;
const __UP_T_NAME = 3;
const __UP_T_CHAR = 4;
const __UP_T_ESCAPED = 5;
const __UP_T_OTHER_MODIFIER = 6;
const __UP_T_ASTERISK = 7;
const __UP_T_END = 8;
const __UP_T_INVALID = 9;

class __UPToken {
  type: number = 0;
  index: number = 0;
  value: string = "";
}

const __upIdStartRe: any = new RegExp("^\\p{ID_Start}$", "u");
const __upIdPartRe: any = new RegExp("^\\p{ID_Continue}$", "u");

// "is a valid name code point". `ch` is one code point as a string.
function __upIsNameCodePoint(ch: string, first: boolean): boolean {
  if (ch === "") return false;
  const c = __wuCode(ch);
  if (c === 0x24 || c === 0x5f) return true;
  if (__wuIsAsciiAlpha(c)) return true;
  if (c < 0x80) return !first && __wuIsAsciiDigit(c);
  if (!first && (c === 0x200c || c === 0x200d)) return true;
  return first ? __upIdStartRe.test(ch) : __upIdPartRe.test(ch);
}

// Length in code units of the code point at `i`.
function __upCpLen(units: any, i: number, n: number): number {
  const c = __wuCode(units[i]);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < n) {
    const d = __wuCode(units[i + 1]);
    if (d >= 0xdc00 && d <= 0xdfff) return 2;
  }
  return 1;
}

function __upPush(tokens: any, type: number, index: number, value: string): void {
  const t = new __UPToken();
  t.type = type;
  t.index = index;
  t.value = value;
  tokens.push(t);
}

function __upTokenize(input: string, strict: boolean): any {
  const u: any = __wuUnits(input);
  const n = __wuALen(u);
  const tokens: any = [];
  let index = 0;
  while (index < n) {
    const len = __upCpLen(u, index, n);
    const c = __wuCode(u[index]);
    if (c === 0x2a) {
      __upPush(tokens, __UP_T_ASTERISK, index, "*");
      index = index + 1;
      continue;
    }
    if (c === 0x2b || c === 0x3f) {
      __upPush(tokens, __UP_T_OTHER_MODIFIER, index, u[index] as string);
      index = index + 1;
      continue;
    }
    if (c === 0x5c) {
      if (index === n - 1) {
        if (strict) __upFail("trailing backslash");
        __upPush(tokens, __UP_T_INVALID, index, "\\");
        index = index + 1;
        continue;
      }
      const el = __upCpLen(u, index + 1, n);
      __upPush(tokens, __UP_T_ESCAPED, index, __wuSub(u, index + 1, index + 1 + el));
      index = index + 1 + el;
      continue;
    }
    if (c === 0x7b) {
      __upPush(tokens, __UP_T_OPEN, index, "{");
      index = index + 1;
      continue;
    }
    if (c === 0x7d) {
      __upPush(tokens, __UP_T_CLOSE, index, "}");
      index = index + 1;
      continue;
    }
    if (c === 0x3a) {
      const nameStart = index + 1;
      let pos = nameStart;
      while (pos < n) {
        const cl = __upCpLen(u, pos, n);
        if (!__upIsNameCodePoint(__wuSub(u, pos, pos + cl), pos === nameStart)) break;
        pos = pos + cl;
      }
      if (pos <= nameStart) {
        if (strict) __upFail("missing parameter name");
        __upPush(tokens, __UP_T_INVALID, index, ":");
        index = nameStart;
        continue;
      }
      __upPush(tokens, __UP_T_NAME, index, __wuSub(u, nameStart, pos));
      index = pos;
      continue;
    }
    if (c === 0x28) {
      let depth = 1;
      const start = index + 1;
      let pos = start;
      let error = false;
      while (pos < n) {
        const rc = __wuCode(u[pos]);
        if (rc > 0x7f) { error = true; break; }
        if (pos === start && rc === 0x3f) { error = true; break; }
        if (rc === 0x5c) {
          if (pos === n - 1) { error = true; break; }
          if (__wuCode(u[pos + 1]) > 0x7f) { error = true; break; }
          pos = pos + 2;
          continue;
        }
        if (rc === 0x29) {
          depth = depth - 1;
          if (depth === 0) { pos = pos + 1; break; }
        } else if (rc === 0x28) {
          depth = depth + 1;
          if (pos === n - 1) { error = true; break; }
          if (__wuCode(u[pos + 1]) !== 0x3f) { error = true; break; }
        }
        pos = pos + 1;
      }
      if (!error && depth !== 0) error = true;
      const rlen = pos - start - 1;
      if (!error && rlen <= 0) error = true;
      if (error) {
        if (strict) __upFail("invalid regular expression group");
        __upPush(tokens, __UP_T_INVALID, index, "(");
        index = start;
        continue;
      }
      __upPush(tokens, __UP_T_REGEXP, index, __wuSub(u, start, start + rlen));
      index = pos;
      continue;
    }
    __upPush(tokens, __UP_T_CHAR, index, __wuSub(u, index, index + len));
    index = index + len;
  }
  __upPush(tokens, __UP_T_END, n, "");
  return tokens;
}

// ---------------------------------------------------------------------------
// Parts and the pattern parser (https://urlpattern.spec.whatwg.org/#parsing)
// ---------------------------------------------------------------------------

const __UP_P_FIXED = 0;
const __UP_P_REGEXP = 1;
const __UP_P_SEGMENT = 2;
const __UP_P_FULL = 3;

const __UP_M_NONE = 0;
const __UP_M_OPTIONAL = 1;
const __UP_M_ZERO_OR_MORE = 2;
const __UP_M_ONE_OR_MORE = 3;

class __UPPart {
  type: number = 0;
  value: string = "";
  modifier: number = 0;
  name: string = "";
  prefix: string = "";
  suffix: string = "";
}

class __UPOptions {
  delimiter: string = "";
  prefix: string = "";
  ignoreCase: boolean = false;
}

function __upOptions(delimiter: string, prefix: string, ignoreCase: boolean): __UPOptions {
  const o = new __UPOptions();
  o.delimiter = delimiter;
  o.prefix = prefix;
  o.ignoreCase = ignoreCase;
  return o;
}

// Encoding callbacks, as kinds.
const __UP_E_PROTOCOL = 0;
const __UP_E_USERNAME = 1;
const __UP_E_PASSWORD = 2;
const __UP_E_HOSTNAME = 3;
const __UP_E_IPV6_HOSTNAME = 4;
const __UP_E_PORT = 5;
const __UP_E_PATHNAME = 6;
const __UP_E_OPAQUE_PATHNAME = 7;
const __UP_E_SEARCH = 8;
const __UP_E_HASH = 9;

function __upEncode(kind: number, value: string): string {
  if (kind === __UP_E_PROTOCOL) return __upCanonProtocol(value);
  if (kind === __UP_E_USERNAME) return __upCanonUserinfo(value);
  if (kind === __UP_E_PASSWORD) return __upCanonUserinfo(value);
  if (kind === __UP_E_HOSTNAME) return __upCanonHostname(value, "");
  if (kind === __UP_E_IPV6_HOSTNAME) return __upCanonIPv6Hostname(value);
  if (kind === __UP_E_PORT) return __upCanonPort(value, "");
  if (kind === __UP_E_PATHNAME) return __upCanonPathname(value);
  if (kind === __UP_E_OPAQUE_PATHNAME) return __upCanonOpaquePathname(value);
  if (kind === __UP_E_SEARCH) return __upCanonSearch(value);
  return __upCanonHash(value);
}

function __upEscapeRegexp(text: string): string {
  const u: any = __wuUnits(text);
  const out: string[] = [];
  for (let i = 0; i < __wuALen(u); i++) {
    const ch = u[i] as string;
    if (".+*?^${}()[]|/\\".indexOf(ch) !== -1) out.push("\\");
    out.push(ch);
  }
  return out.join("");
}

function __upEscapePattern(text: string): string {
  const u: any = __wuUnits(text);
  const out: string[] = [];
  for (let i = 0; i < __wuALen(u); i++) {
    const ch = u[i] as string;
    if ("+*?:{}()\\".indexOf(ch) !== -1) out.push("\\");
    out.push(ch);
  }
  return out.join("");
}

function __upSegmentWildcard(options: __UPOptions): string {
  return "[^" + __upEscapeRegexp(options.delimiter) + "]+?";
}

function __upModifierString(m: number): string {
  if (m === __UP_M_OPTIONAL) return "?";
  if (m === __UP_M_ZERO_OR_MORE) return "*";
  if (m === __UP_M_ONE_OR_MORE) return "+";
  return "";
}

class __UPPatternParser {
  tokens: any = [];
  encoding: number = 0;
  segmentWildcard: string = "";
  parts: any = [];
  pending: string = "";
  index: number = 0;
  nextNumericName: number = 0;
}

function __upTryConsume(p: __UPPatternParser, type: number): any {
  const t: any = p.tokens[p.index];
  if (t.type !== type) return null;
  p.index = p.index + 1;
  return t;
}

function __upTryConsumeModifier(p: __UPPatternParser): any {
  const t: any = __upTryConsume(p, __UP_T_OTHER_MODIFIER);
  if (t !== null) return t;
  return __upTryConsume(p, __UP_T_ASTERISK);
}

function __upTryConsumeRegexpOrWildcard(p: __UPPatternParser, nameToken: any): any {
  const t: any = __upTryConsume(p, __UP_T_REGEXP);
  if (nameToken === null && t === null) return __upTryConsume(p, __UP_T_ASTERISK);
  return t;
}

function __upConsumeRequired(p: __UPPatternParser, type: number): any {
  const t: any = __upTryConsume(p, type);
  if (t === null) __upFail("unexpected token in pattern");
  return t;
}

function __upConsumeText(p: __UPPatternParser): string {
  let out = "";
  while (true) {
    let t: any = __upTryConsume(p, __UP_T_CHAR);
    if (t === null) t = __upTryConsume(p, __UP_T_ESCAPED);
    if (t === null) break;
    out = out + (t.value as string);
  }
  return out;
}

function __upNewPart(type: number, value: string, modifier: number, name: string, prefix: string, suffix: string): __UPPart {
  const part = new __UPPart();
  part.type = type;
  part.value = value;
  part.modifier = modifier;
  part.name = name;
  part.prefix = prefix;
  part.suffix = suffix;
  return part;
}

function __upFlushPending(p: __UPPatternParser): void {
  if (p.pending === "") return;
  const encoded = __upEncode(p.encoding, p.pending);
  p.pending = "";
  p.parts.push(__upNewPart(__UP_P_FIXED, encoded, __UP_M_NONE, "", "", ""));
}

function __upAddPart(p: __UPPatternParser, prefix: string, nameToken: any, regexpToken: any, suffix: string, modifierToken: any): void {
  let modifier = __UP_M_NONE;
  if (modifierToken !== null) {
    const mv = modifierToken.value as string;
    if (mv === "?") modifier = __UP_M_OPTIONAL;
    else if (mv === "*") modifier = __UP_M_ZERO_OR_MORE;
    else if (mv === "+") modifier = __UP_M_ONE_OR_MORE;
  }
  if (nameToken === null && regexpToken === null && modifier === __UP_M_NONE) {
    p.pending = p.pending + prefix;
    return;
  }
  __upFlushPending(p);
  if (nameToken === null && regexpToken === null) {
    if (prefix === "") return;
    p.parts.push(__upNewPart(__UP_P_FIXED, __upEncode(p.encoding, prefix), modifier, "", "", ""));
    return;
  }
  let regexpValue = "";
  if (regexpToken === null) regexpValue = p.segmentWildcard;
  else if (regexpToken.type === __UP_T_ASTERISK) regexpValue = ".*";
  else regexpValue = regexpToken.value as string;
  let type = __UP_P_REGEXP;
  if (regexpValue === p.segmentWildcard) {
    type = __UP_P_SEGMENT;
    regexpValue = "";
  } else if (regexpValue === ".*") {
    type = __UP_P_FULL;
    regexpValue = "";
  }
  let name = "";
  if (nameToken !== null) {
    name = nameToken.value as string;
  } else {
    name = String(p.nextNumericName);
    p.nextNumericName = p.nextNumericName + 1;
  }
  for (let i = 0; i < __wuALen(p.parts); i++) {
    if ((p.parts[i].name as string) === name) __upFail("duplicate group name '" + name + "'");
  }
  const encodedPrefix = __upEncode(p.encoding, prefix);
  const encodedSuffix = __upEncode(p.encoding, suffix);
  p.parts.push(__upNewPart(type, regexpValue, modifier, name, encodedPrefix, encodedSuffix));
}

function __upParsePattern(input: string, options: __UPOptions, encoding: number): any {
  const p = new __UPPatternParser();
  p.tokens = __upTokenize(input, true);
  p.encoding = encoding;
  p.segmentWildcard = __upSegmentWildcard(options);
  const count = __wuALen(p.tokens);
  while (p.index < count) {
    const charToken: any = __upTryConsume(p, __UP_T_CHAR);
    let nameToken: any = __upTryConsume(p, __UP_T_NAME);
    let regexpToken: any = __upTryConsumeRegexpOrWildcard(p, nameToken);
    if (nameToken !== null || regexpToken !== null) {
      let prefix = "";
      if (charToken !== null) prefix = charToken.value as string;
      if (prefix !== "" && prefix !== options.prefix) {
        p.pending = p.pending + prefix;
        prefix = "";
      }
      __upFlushPending(p);
      const modifierToken: any = __upTryConsumeModifier(p);
      __upAddPart(p, prefix, nameToken, regexpToken, "", modifierToken);
      continue;
    }
    let fixedToken: any = charToken;
    if (fixedToken === null) fixedToken = __upTryConsume(p, __UP_T_ESCAPED);
    if (fixedToken !== null) {
      p.pending = p.pending + (fixedToken.value as string);
      continue;
    }
    const openToken: any = __upTryConsume(p, __UP_T_OPEN);
    if (openToken !== null) {
      const prefix = __upConsumeText(p);
      nameToken = __upTryConsume(p, __UP_T_NAME);
      regexpToken = __upTryConsumeRegexpOrWildcard(p, nameToken);
      const suffix = __upConsumeText(p);
      __upConsumeRequired(p, __UP_T_CLOSE);
      const modifierToken: any = __upTryConsumeModifier(p);
      __upAddPart(p, prefix, nameToken, regexpToken, suffix, modifierToken);
      continue;
    }
    __upFlushPending(p);
    __upConsumeRequired(p, __UP_T_END);
  }
  return p.parts;
}

// ---------------------------------------------------------------------------
// Generators (https://urlpattern.spec.whatwg.org/#generate-a-regular-expression-and-name-list)
// ---------------------------------------------------------------------------

function __upGenerateRegexp(parts: any, options: __UPOptions, names: any): string {
  let out = "^";
  for (let i = 0; i < __wuALen(parts); i++) {
    const part: any = parts[i];
    const type = part.type as number;
    const modifier = part.modifier as number;
    const ms = __upModifierString(modifier);
    if (type === __UP_P_FIXED) {
      if (modifier === __UP_M_NONE) out = out + __upEscapeRegexp(part.value as string);
      else out = out + "(?:" + __upEscapeRegexp(part.value as string) + ")" + ms;
      continue;
    }
    names.push(part.name as string);
    let value = part.value as string;
    if (type === __UP_P_SEGMENT) value = __upSegmentWildcard(options);
    else if (type === __UP_P_FULL) value = ".*";
    const prefix = part.prefix as string;
    const suffix = part.suffix as string;
    if (prefix === "" && suffix === "") {
      if (modifier === __UP_M_NONE || modifier === __UP_M_OPTIONAL) out = out + "(" + value + ")" + ms;
      else out = out + "((?:" + value + ")" + ms + ")";
      continue;
    }
    const ep = __upEscapeRegexp(prefix);
    const es = __upEscapeRegexp(suffix);
    if (modifier === __UP_M_NONE || modifier === __UP_M_OPTIONAL) {
      out = out + "(?:" + ep + "(" + value + ")" + es + ")" + ms;
      continue;
    }
    out = out + "(?:" + ep + "((?:" + value + ")(?:" + es + ep + "(?:" + value + "))*)" + es + ")";
    if (modifier === __UP_M_ZERO_OR_MORE) out = out + "?";
  }
  return out + "$";
}

function __upFirstUnit(text: string): string {
  if (text === "") return "";
  const u: any = __wuUnits(text);
  return __wuSub(u, 0, __upCpLen(u, 0, __wuALen(u)));
}

function __upLastUnit(text: string): string {
  if (text === "") return "";
  const u: any = __wuUnits(text);
  return u[__wuALen(u) - 1] as string;
}

function __upStartsWithDigit(text: string): boolean {
  if (text === "") return false;
  return __wuIsAsciiDigit(__wuCode(__wuUnits(text)[0]));
}

function __upGeneratePatternString(parts: any, options: __UPOptions): string {
  let out = "";
  const count = __wuALen(parts);
  for (let i = 0; i < count; i++) {
    const part: any = parts[i];
    const prev: any = i > 0 ? parts[i - 1] : null;
    const next: any = i < count - 1 ? parts[i + 1] : null;
    const type = part.type as number;
    const modifier = part.modifier as number;
    if (type === __UP_P_FIXED) {
      if (modifier === __UP_M_NONE) {
        out = out + __upEscapePattern(part.value as string);
        continue;
      }
      out = out + "{" + __upEscapePattern(part.value as string) + "}" + __upModifierString(modifier);
      continue;
    }
    const name = part.name as string;
    const prefix = part.prefix as string;
    const suffix = part.suffix as string;
    const customName = !__upStartsWithDigit(name);
    let needsGrouping = suffix !== "" || (prefix !== "" && prefix !== options.prefix);
    if (
      !needsGrouping && customName && type === __UP_P_SEGMENT && modifier === __UP_M_NONE &&
      next !== null && (next.prefix as string) === "" && (next.suffix as string) === ""
    ) {
      if ((next.type as number) === __UP_P_FIXED) {
        needsGrouping = __upIsNameCodePoint(__upFirstUnit(next.value as string), false);
      } else {
        needsGrouping = __upStartsWithDigit(next.name as string);
      }
    }
    if (
      !needsGrouping && prefix === "" && prev !== null && (prev.type as number) === __UP_P_FIXED &&
      options.prefix !== "" && __upLastUnit(prev.value as string) === options.prefix
    ) {
      needsGrouping = true;
    }
    if (needsGrouping) out = out + "{";
    out = out + __upEscapePattern(prefix);
    if (customName) out = out + ":" + name;
    if (type === __UP_P_REGEXP) {
      out = out + "(" + (part.value as string) + ")";
    } else if (type === __UP_P_SEGMENT && !customName) {
      out = out + "(" + __upSegmentWildcard(options) + ")";
    } else if (type === __UP_P_FULL) {
      if (
        !customName &&
        (prev === null || (prev.type as number) === __UP_P_FIXED || (prev.modifier as number) !== __UP_M_NONE ||
          needsGrouping || prefix !== "")
      ) {
        out = out + "*";
      } else {
        out = out + "(.*)";
      }
    }
    if (type === __UP_P_SEGMENT && customName && suffix !== "" && __upIsNameCodePoint(__upFirstUnit(suffix), false)) {
      out = out + "\\";
    }
    out = out + __upEscapePattern(suffix);
    if (needsGrouping) out = out + "}";
    out = out + __upModifierString(modifier);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Components (https://urlpattern.spec.whatwg.org/#compile-a-component)
// ---------------------------------------------------------------------------

class __UPComponent {
  patternString: string = "";
  regexp: any = null;
  names: any = [];
  hasRegexpGroups: boolean = false;
}

function __upCompile(input: string, encoding: number, options: __UPOptions): __UPComponent {
  const parts: any = __upParsePattern(input, options, encoding);
  const names: any = [];
  const source = __upGenerateRegexp(parts, options, names);
  const flags = options.ignoreCase ? "vi" : "v";
  let regexp: any = null;
  try {
    regexp = new RegExp(source, flags);
  } catch (e) {
    __upFail("invalid regular expression");
  }
  const c = new __UPComponent();
  c.regexp = regexp;
  c.names = names;
  c.patternString = __upGeneratePatternString(parts, options);
  let groups = false;
  for (let i = 0; i < __wuALen(parts); i++) {
    if ((parts[i].type as number) === __UP_P_REGEXP) groups = true;
  }
  c.hasRegexpGroups = groups;
  return c;
}

const __UP_SPECIAL_SCHEMES: string[] = ["ftp", "file", "http", "https", "ws", "wss"];

function __upMatchesSpecialScheme(c: __UPComponent): boolean {
  for (let i = 0; i < 6; i++) {
    if (c.regexp.test(__UP_SPECIAL_SCHEMES[i])) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Canonicalization (https://urlpattern.spec.whatwg.org/#canon-encoding-callbacks)
// ---------------------------------------------------------------------------

function __upCanonProtocol(value: string): string {
  if (value === "") return value;
  // The scheme states of the basic parser, written out: run with a state
  // override over a fresh (non-special) dummy URL, the parser's
  // special/non-special guard would silently refuse every special scheme.
  const u: any = __wuUnits(value);
  for (let i = 0; i < __wuALen(u); i++) {
    const c = __wuCode(u[i]);
    const ok = i === 0
      ? __wuIsAsciiAlpha(c)
      : __wuIsAsciiAlphanumeric(c) || c === 0x2b || c === 0x2d || c === 0x2e;
    if (!ok) __upFail("invalid protocol '" + value + "'");
  }
  return value.toLowerCase();
}

function __upCanonUserinfo(value: string): string {
  if (value === "") return value;
  return __wuPercentEncode(value, __WU_SET_USERINFO);
}

function __upCanonHostname(value: string, protocol: string): string {
  if (value === "") return value;
  const u: any = __wuUnits(value);
  for (let i = 0; i < __wuALen(u); i++) {
    const c = __wuCode(u[i]);
    if (
      c === 0x09 || c === 0x0a || c === 0x0d || c === 0x20 || c === 0x23 || c === 0x25 ||
      c === 0x2f || c === 0x3a || c === 0x3c || c === 0x3e || c === 0x3f || c === 0x40 ||
      c === 0x5b || c === 0x5c || c === 0x5d || c === 0x5e || c === 0x7c
    ) {
      __upFail("invalid hostname '" + value + "'");
    }
  }
  const rec: any = new __WUrlRecord();
  rec.scheme = protocol === "" || __wuIsSpecial(protocol) ? "https" : protocol;
  const r: any = __wuBasicParse(value, null, __WU_S_HOSTNAME, rec);
  if (r === null) __upFail("invalid hostname '" + value + "'");
  return rec.host === null ? "" : (rec.host as string);
}

function __upCanonIPv6Hostname(value: string): string {
  const u: any = __wuUnits(value);
  const out: string[] = [];
  for (let i = 0; i < __wuALen(u); i++) {
    const c = __wuCode(u[i]);
    if (!__wuIsAsciiHexDigit(c) && c !== 0x5b && c !== 0x5d && c !== 0x3a) {
      __upFail("invalid IPv6 hostname '" + value + "'");
    }
    out.push((u[i] as string).toLowerCase());
  }
  return out.join("");
}

function __upCanonPort(value: string, protocol: string): string {
  if (value === "") return value;
  const u: any = __wuUnits(value);
  for (let i = 0; i < __wuALen(u); i++) {
    if (!__wuIsAsciiDigit(__wuCode(u[i]))) __upFail("invalid port '" + value + "'");
  }
  const rec: any = new __WUrlRecord();
  rec.scheme = protocol;
  const r: any = __wuBasicParse(value, null, __WU_S_PORT, rec);
  if (r === null) __upFail("invalid port '" + value + "'");
  return rec.port === null ? "" : String(rec.port);
}

function __upCanonPathname(value: string): string {
  if (value === "") return value;
  const leadingSlash = __upFirstUnit(value) === "/";
  const modified = leadingSlash ? value : "/-" + value;
  const rec: any = new __WUrlRecord();
  const r: any = __wuBasicParse(modified, null, __WU_S_PATH_START, rec);
  if (r === null) __upFail("invalid pathname '" + value + "'");
  const out = __wuSerializePath(rec);
  if (leadingSlash) return out;
  const ou: any = __wuUnits(out);
  return __wuSub(ou, 2, __wuALen(ou));
}

function __upCanonOpaquePathname(value: string): string {
  if (value === "") return value;
  const rec: any = new __WUrlRecord();
  rec.opaque = "";
  const r: any = __wuBasicParse(value, null, __WU_S_OPAQUE_PATH, rec);
  if (r === null) __upFail("invalid pathname '" + value + "'");
  return __wuSerializePath(rec);
}

function __upCanonSearch(value: string): string {
  if (value === "") return value;
  const rec: any = new __WUrlRecord();
  rec.query = "";
  const r: any = __wuBasicParse(value, null, __WU_S_QUERY, rec);
  if (r === null) __upFail("invalid search '" + value + "'");
  return rec.query as string;
}

function __upCanonHash(value: string): string {
  if (value === "") return value;
  const rec: any = new __WUrlRecord();
  rec.fragment = "";
  const r: any = __wuBasicParse(value, null, __WU_S_FRAGMENT, rec);
  if (r === null) __upFail("invalid hash '" + value + "'");
  return rec.fragment as string;
}

// ---------------------------------------------------------------------------
// The constructor string parser
// (https://urlpattern.spec.whatwg.org/#constructor-string-parsing)
// ---------------------------------------------------------------------------

const __UP_S_INIT = 0;
const __UP_S_PROTOCOL = 1;
const __UP_S_AUTHORITY = 2;
const __UP_S_USERNAME = 3;
const __UP_S_PASSWORD = 4;
const __UP_S_HOSTNAME = 5;
const __UP_S_PORT = 6;
const __UP_S_PATHNAME = 7;
const __UP_S_SEARCH = 8;
const __UP_S_HASH = 9;
const __UP_S_DONE = 10;

const __UP_STATE_KEYS: string[] = [
  "", "protocol", "", "username", "password", "hostname", "port", "pathname", "search", "hash", "",
];

class __UPCtorParser {
  units: any = [];
  tokens: any = [];
  result: any = null;
  componentStart: number = 0;
  tokenIndex: number = 0;
  tokenIncrement: number = 1;
  groupDepth: number = 0;
  ipv6Depth: number = 0;
  special: boolean = false;
  state: number = 0;
}

function __upSafeToken(p: __UPCtorParser, index: number): any {
  const n = __wuALen(p.tokens);
  if (index < n) return p.tokens[index];
  return p.tokens[n - 1];
}

function __upIsNonSpecial(p: __UPCtorParser, index: number, value: string): boolean {
  const t: any = __upSafeToken(p, index);
  if ((t.value as string) !== value) return false;
  const type = t.type as number;
  return type === __UP_T_CHAR || type === __UP_T_ESCAPED || type === __UP_T_INVALID;
}

function __upIsSearchPrefix(p: __UPCtorParser): boolean {
  if (__upIsNonSpecial(p, p.tokenIndex, "?")) return true;
  if ((p.tokens[p.tokenIndex].value as string) !== "?") return false;
  const prev = p.tokenIndex - 1;
  if (prev < 0) return true;
  const t = __upSafeToken(p, prev).type as number;
  return !(t === __UP_T_NAME || t === __UP_T_REGEXP || t === __UP_T_CLOSE || t === __UP_T_ASTERISK);
}

function __upComponentString(p: __UPCtorParser): string {
  const t: any = p.tokens[p.tokenIndex];
  const start: any = __upSafeToken(p, p.componentStart);
  return __wuSub(p.units, start.index as number, t.index as number);
}

function __upHas(obj: any, key: string): boolean {
  return obj[key] !== undefined;
}

function __upChangeState(p: __UPCtorParser, next: number, skip: number): void {
  const s = p.state;
  if (s !== __UP_S_INIT && s !== __UP_S_AUTHORITY && s !== __UP_S_DONE) {
    p.result[__UP_STATE_KEYS[s]] = __upComponentString(p);
  }
  if (s !== __UP_S_INIT && next !== __UP_S_DONE) {
    const early = s === __UP_S_PROTOCOL || s === __UP_S_AUTHORITY || s === __UP_S_USERNAME || s === __UP_S_PASSWORD;
    if (
      early && (next === __UP_S_PORT || next === __UP_S_PATHNAME || next === __UP_S_SEARCH || next === __UP_S_HASH) &&
      !__upHas(p.result, "hostname")
    ) {
      p.result.hostname = "";
    }
    if (
      (early || s === __UP_S_HOSTNAME || s === __UP_S_PORT) &&
      (next === __UP_S_SEARCH || next === __UP_S_HASH) && !__upHas(p.result, "pathname")
    ) {
      p.result.pathname = p.special ? "/" : "";
    }
    if (
      (early || s === __UP_S_HOSTNAME || s === __UP_S_PORT || s === __UP_S_PATHNAME) &&
      next === __UP_S_HASH && !__upHas(p.result, "search")
    ) {
      p.result.search = "";
    }
  }
  p.state = next;
  p.tokenIndex = p.tokenIndex + skip;
  p.componentStart = p.tokenIndex;
  p.tokenIncrement = 0;
}

// The state goes through a parameter: storing a top-level `const` straight into
// a class field aborts the interpreter (https://github.com/UrubuCode/zun/issues/130).
function __upSetState(p: __UPCtorParser, state: any): void {
  p.state = Number(state);
}

function __upRewind(p: __UPCtorParser): void {
  p.tokenIndex = p.componentStart;
  p.tokenIncrement = 0;
}

function __upParseConstructorString(input: string): any {
  const p = new __UPCtorParser();
  p.units = __wuUnits(input);
  p.tokens = __upTokenize(input, false);
  p.result = {};
  const n = __wuALen(p.tokens);
  while (p.tokenIndex < n) {
    p.tokenIncrement = 1;
    const tok: any = p.tokens[p.tokenIndex];
    const type = tok.type as number;
    if (type === __UP_T_END) {
      if (p.state === __UP_S_INIT) {
        __upRewind(p);
        if (__upIsNonSpecial(p, p.tokenIndex, "#")) __upChangeState(p, __UP_S_HASH, 1);
        else if (__upIsSearchPrefix(p)) __upChangeState(p, __UP_S_SEARCH, 1);
        else __upChangeState(p, __UP_S_PATHNAME, 0);
        p.tokenIndex = p.tokenIndex + p.tokenIncrement;
        continue;
      }
      if (p.state === __UP_S_AUTHORITY) {
        __upRewind(p);
        __upSetState(p, __UP_S_HOSTNAME);
        p.tokenIndex = p.tokenIndex + p.tokenIncrement;
        continue;
      }
      __upChangeState(p, __UP_S_DONE, 0);
      break;
    }
    if (type === __UP_T_OPEN) {
      p.groupDepth = p.groupDepth + 1;
      p.tokenIndex = p.tokenIndex + p.tokenIncrement;
      continue;
    }
    if (p.groupDepth > 0) {
      if (type === __UP_T_CLOSE) {
        p.groupDepth = p.groupDepth - 1;
      } else {
        p.tokenIndex = p.tokenIndex + p.tokenIncrement;
        continue;
      }
    }
    const ti = p.tokenIndex;
    const s = p.state;
    if (s === __UP_S_INIT) {
      if (__upIsNonSpecial(p, ti, ":")) {
        __upRewind(p);
        __upSetState(p, __UP_S_PROTOCOL);
      }
    } else if (s === __UP_S_PROTOCOL) {
      if (__upIsNonSpecial(p, ti, ":")) {
        const protocolComponent = __upCompile(__upComponentString(p), __UP_E_PROTOCOL, __upOptions("", "", false));
        if (__upMatchesSpecialScheme(protocolComponent)) p.special = true;
        let next = __UP_S_PATHNAME;
        let skip = 1;
        if (__upIsNonSpecial(p, ti + 1, "/") && __upIsNonSpecial(p, ti + 2, "/")) {
          next = __UP_S_AUTHORITY;
          skip = 3;
        } else if (p.special) {
          next = __UP_S_AUTHORITY;
        }
        __upChangeState(p, next, skip);
      }
    } else if (s === __UP_S_AUTHORITY) {
      if (__upIsNonSpecial(p, ti, "@")) {
        __upRewind(p);
        __upSetState(p, __UP_S_USERNAME);
      } else if (__upIsNonSpecial(p, ti, "/") || __upIsSearchPrefix(p) || __upIsNonSpecial(p, ti, "#")) {
        __upRewind(p);
        __upSetState(p, __UP_S_HOSTNAME);
      }
    } else if (s === __UP_S_USERNAME) {
      if (__upIsNonSpecial(p, ti, ":")) __upChangeState(p, __UP_S_PASSWORD, 1);
      else if (__upIsNonSpecial(p, ti, "@")) __upChangeState(p, __UP_S_HOSTNAME, 1);
    } else if (s === __UP_S_PASSWORD) {
      if (__upIsNonSpecial(p, ti, "@")) __upChangeState(p, __UP_S_HOSTNAME, 1);
    } else if (s === __UP_S_HOSTNAME) {
      if (__upIsNonSpecial(p, ti, "[")) p.ipv6Depth = p.ipv6Depth + 1;
      else if (__upIsNonSpecial(p, ti, "]")) p.ipv6Depth = p.ipv6Depth - 1;
      else if (__upIsNonSpecial(p, ti, ":") && p.ipv6Depth === 0) __upChangeState(p, __UP_S_PORT, 1);
      else if (__upIsNonSpecial(p, ti, "/")) __upChangeState(p, __UP_S_PATHNAME, 0);
      else if (__upIsSearchPrefix(p)) __upChangeState(p, __UP_S_SEARCH, 1);
      else if (__upIsNonSpecial(p, ti, "#")) __upChangeState(p, __UP_S_HASH, 1);
    } else if (s === __UP_S_PORT) {
      if (__upIsNonSpecial(p, ti, "/")) __upChangeState(p, __UP_S_PATHNAME, 0);
      else if (__upIsSearchPrefix(p)) __upChangeState(p, __UP_S_SEARCH, 1);
      else if (__upIsNonSpecial(p, ti, "#")) __upChangeState(p, __UP_S_HASH, 1);
    } else if (s === __UP_S_PATHNAME) {
      if (__upIsSearchPrefix(p)) __upChangeState(p, __UP_S_SEARCH, 1);
      else if (__upIsNonSpecial(p, ti, "#")) __upChangeState(p, __UP_S_HASH, 1);
    } else if (s === __UP_S_SEARCH) {
      if (__upIsNonSpecial(p, ti, "#")) __upChangeState(p, __UP_S_HASH, 1);
    }
    p.tokenIndex = p.tokenIndex + p.tokenIncrement;
  }
  if (__upHas(p.result, "hostname") && !__upHas(p.result, "port")) p.result.port = "";
  return p.result;
}

// ---------------------------------------------------------------------------
// "process a URLPatternInit" (https://urlpattern.spec.whatwg.org/#process-a-urlpatterninit)
// ---------------------------------------------------------------------------

const __UP_KEYS: string[] = ["protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"];

function __upStripPrefix(value: string, ch: string): string {
  if (__upFirstUnit(value) !== ch) return value;
  const u: any = __wuUnits(value);
  return __wuSub(u, 1, __wuALen(u));
}

function __upBaseString(value: string, isPattern: boolean): string {
  return isPattern ? __upEscapePattern(value) : value;
}

function __upIsAbsolutePathname(value: string, isPattern: boolean): boolean {
  if (value === "") return false;
  const u: any = __wuUnits(value);
  const c0 = u[0] as string;
  if (c0 === "/") return true;
  if (!isPattern) return false;
  if (__wuALen(u) < 2) return false;
  const c1 = u[1] as string;
  return (c0 === "\\" || c0 === "{") && c1 === "/";
}

// The record view of a parsed URL, for the base URL and for `exec`.
function __upParseURL(input: string, base: any): any {
  return __wuBasicParse(input, base, 0, null);
}

function __upHostString(rec: any): string {
  return rec.host === null ? "" : (rec.host as string);
}

// `init` holds only string values for the keys it has (the argument
// conversion guarantees that); `type` is true for "pattern", false for "url".
function __upProcessInit(init: any, isPattern: boolean, preset: any): any {
  const result: any = {};
  for (let i = 0; i < 8; i++) {
    const key = __UP_KEYS[i];
    if (preset !== null) result[key] = preset[key];
  }
  let base: any = null;
  if (__upHas(init, "baseURL")) {
    base = __upParseURL(init.baseURL as string, null);
    if (base === null) __upFail("invalid baseURL '" + (init.baseURL as string) + "'");
    const hasProtocol = __upHas(init, "protocol");
    const hasHostname = __upHas(init, "hostname");
    const hasPort = __upHas(init, "port");
    const hasUsername = __upHas(init, "username");
    const hasPassword = __upHas(init, "password");
    const hasPathname = __upHas(init, "pathname");
    const hasSearch = __upHas(init, "search");
    const hasHash = __upHas(init, "hash");
    if (!hasProtocol) result.protocol = __upBaseString(base.scheme as string, isPattern);
    if (!isPattern && !hasProtocol && !hasHostname && !hasPort && !hasUsername) {
      result.username = __upBaseString(base.username as string, isPattern);
    }
    if (!isPattern && !hasProtocol && !hasHostname && !hasPort && !hasUsername && !hasPassword) {
      result.password = __upBaseString(base.password as string, isPattern);
    }
    if (!hasProtocol && !hasHostname) {
      result.hostname = __upBaseString(__upHostString(base), isPattern);
    }
    if (!hasProtocol && !hasHostname && !hasPort) {
      result.port = base.port === null ? "" : String(base.port);
    }
    if (!hasProtocol && !hasHostname && !hasPort && !hasPathname) {
      result.pathname = __upBaseString(__wuSerializePath(base), isPattern);
    }
    if (!hasProtocol && !hasHostname && !hasPort && !hasPathname && !hasSearch) {
      result.search = __upBaseString(base.query === null ? "" : (base.query as string), isPattern);
    }
    if (!hasProtocol && !hasHostname && !hasPort && !hasPathname && !hasSearch && !hasHash) {
      result.hash = __upBaseString(base.fragment === null ? "" : (base.fragment as string), isPattern);
    }
  }
  if (__upHas(init, "protocol")) {
    let v = init.protocol as string;
    const vu: any = __wuUnits(v);
    if (__wuALen(vu) > 0 && (vu[__wuALen(vu) - 1] as string) === ":") v = __wuSub(vu, 0, __wuALen(vu) - 1);
    result.protocol = isPattern ? v : __upCanonProtocol(v);
  }
  if (__upHas(init, "username")) {
    result.username = isPattern ? (init.username as string) : __upCanonUserinfo(init.username as string);
  }
  if (__upHas(init, "password")) {
    result.password = isPattern ? (init.password as string) : __upCanonUserinfo(init.password as string);
  }
  const protocolValue: string = result.protocol === undefined ? "" : (result.protocol as string);
  if (__upHas(init, "hostname")) {
    result.hostname = isPattern ? (init.hostname as string) : __upCanonHostname(init.hostname as string, protocolValue);
  }
  if (__upHas(init, "port")) {
    result.port = isPattern ? (init.port as string) : __upCanonPort(init.port as string, protocolValue);
  }
  if (__upHas(init, "pathname")) {
    let pathname = init.pathname as string;
    if (base !== null && base.opaque === null && !__upIsAbsolutePathname(pathname, isPattern)) {
      const basePath = __upBaseString(__wuSerializePath(base), isPattern);
      const slash = basePath.lastIndexOf("/");
      if (slash !== -1) {
        const bu: any = __wuUnits(basePath);
        pathname = __wuSub(bu, 0, Number(slash) + 1) + pathname;
      }
    }
    if (!isPattern) {
      if (protocolValue === "" || __wuIsSpecial(protocolValue)) pathname = __upCanonPathname(pathname);
      else pathname = __upCanonOpaquePathname(pathname);
    }
    result.pathname = pathname;
  }
  if (__upHas(init, "search")) {
    const v = __upStripPrefix(init.search as string, "?");
    result.search = isPattern ? v : __upCanonSearch(v);
  }
  if (__upHas(init, "hash")) {
    const v = __upStripPrefix(init.hash as string, "#");
    result.hash = isPattern ? v : __upCanonHash(v);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Argument conversion (WebIDL `URLPatternInit`, Node's type checks)
// ---------------------------------------------------------------------------

function __upIsObject(value: any): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

// Read the dictionary members in WebIDL order (lexicographic), so a throwing
// getter propagates exactly where the platform's would.
const __UP_INIT_MEMBERS: string[] = [
  "baseURL", "hash", "hostname", "password", "pathname", "port", "protocol", "search", "username",
];

function __upConvertInit(value: any): any {
  const out: any = {};
  if (value === undefined || value === null) return out;
  for (let i = 0; i < 9; i++) {
    const key = __UP_INIT_MEMBERS[i];
    const v: any = value[key];
    if (v === undefined) continue;
    if (typeof v === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
    out[key] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The class
// ---------------------------------------------------------------------------

function __upBrand(value: any): void {
  if (!(value instanceof NodeURLPattern)) throw new TypeError("Illegal invocation");
}

class NodeURLPattern {
  _components: any = [];

  constructor(input: any, baseURL: any, options: any) {
    let init: any = null;
    if (typeof input === "string") {
      init = __upParseConstructorString(input as string);
      if (baseURL === null && !__upHas(init, "protocol")) {
        __upFail("relative constructor string requires a baseURL");
      }
      if (baseURL !== null) init.baseURL = baseURL as string;
    } else {
      if (baseURL !== null) __upFail("a baseURL is not allowed with a URLPatternInit");
      init = input;
    }
    const processed: any = __upProcessInit(init, true, null);
    for (let i = 0; i < 8; i++) {
      const key = __UP_KEYS[i];
      if (processed[key] === undefined) processed[key] = "*";
    }
    const protocol = processed.protocol as string;
    if (__wuIsSpecial(protocol) && String(__wuDefaultPort(protocol)) === (processed.port as string)) {
      processed.port = "";
    }
    const ignoreCase: boolean = options === true;
    const defaults = __upOptions("", "", false);
    const comps: any = [];
    comps.push(__upCompile(protocol, __UP_E_PROTOCOL, defaults));
    comps.push(__upCompile(processed.username as string, __UP_E_USERNAME, defaults));
    comps.push(__upCompile(processed.password as string, __UP_E_PASSWORD, defaults));
    const hostname = processed.hostname as string;
    const hu: any = __wuUnits(hostname);
    let ipv6 = false;
    if (__wuALen(hu) >= 2) {
      const h0 = hu[0] as string;
      const h1 = hu[1] as string;
      ipv6 = h0 === "[" || ((h0 === "{" || h0 === "\\") && h1 === "[");
    }
    comps.push(__upCompile(hostname, ipv6 ? __UP_E_IPV6_HOSTNAME : __UP_E_HOSTNAME, __upOptions(".", "", false)));
    comps.push(__upCompile(processed.port as string, __UP_E_PORT, defaults));
    const compileOptions = __upOptions("", "", ignoreCase);
    if (__upMatchesSpecialScheme(comps[0] as __UPComponent)) {
      comps.push(__upCompile(processed.pathname as string, __UP_E_PATHNAME, __upOptions("/", "/", ignoreCase)));
    } else {
      comps.push(__upCompile(processed.pathname as string, __UP_E_OPAQUE_PATHNAME, compileOptions));
    }
    comps.push(__upCompile(processed.search as string, __UP_E_SEARCH, compileOptions));
    comps.push(__upCompile(processed.hash as string, __UP_E_HASH, compileOptions));
    this._components = comps;
  }

  get protocol(): string { const self: any = this; __upBrand(self); return self._components[0].patternString as string; }
  get username(): string { const self: any = this; __upBrand(self); return self._components[1].patternString as string; }
  get password(): string { const self: any = this; __upBrand(self); return self._components[2].patternString as string; }
  get hostname(): string { const self: any = this; __upBrand(self); return self._components[3].patternString as string; }
  get port(): string { const self: any = this; __upBrand(self); return self._components[4].patternString as string; }
  get pathname(): string { const self: any = this; __upBrand(self); return self._components[5].patternString as string; }
  get search(): string { const self: any = this; __upBrand(self); return self._components[6].patternString as string; }
  get hash(): string { const self: any = this; __upBrand(self); return self._components[7].patternString as string; }

  get hasRegExpGroups(): boolean {
    const self: any = this;
    __upBrand(self);
    for (let i = 0; i < 8; i++) {
      if (this._components[i].hasRegexpGroups as boolean) return true;
    }
    return false;
  }

  exec(...rest: any[]): any {
    const self: any = this;
    __upBrand(self);
    const args = __upExecArgs(rest);
    return __upMatch(this, args[0], args[1], false);
  }

  test(...rest: any[]): boolean {
    const self: any = this;
    __upBrand(self);
    const args = __upExecArgs(rest);
    return __upMatch(this, args[0], args[1], true) === true;
  }
}

// Node's `exec`/`test` argument checks. Answers `[input, baseURL-or-null]`
// with `input` already converted (a string, or a converted init record).
function __upExecArgs(rest: any): any {
  const input: any = __wuALen(rest) > 0 ? rest[0] : undefined;
  const base: any = __wuALen(rest) > 1 ? rest[1] : undefined;
  let converted: any = null;
  if (input === undefined) converted = {};
  else if (typeof input === "string") converted = input;
  else if (__upIsObject(input)) converted = __upConvertInit(input);
  else throw new ERR_URLPATTERN_ARG_TYPE("Input must be an object or a string");
  let baseValue: any = null;
  if (base !== undefined) {
    if (typeof base !== "string") throw new ERR_URLPATTERN_ARG_TYPE("Base URL must be a string");
    baseValue = base;
  }
  return [converted, baseValue];
}

// "match" (https://urlpattern.spec.whatwg.org/#url-pattern-match). With
// `testOnly` it answers a boolean instead of building the result.
function __upMatch(pattern: any, input: any, baseURL: any, testOnly: boolean): any {
  const values: string[] = ["", "", "", "", "", "", "", ""];
  const inputs: any = [];
  if (typeof input === "string") {
    inputs.push(input);
    let base: any = null;
    if (baseURL !== null) {
      base = __upParseURL(baseURL as string, null);
      if (base === null) return testOnly ? false : null;
      inputs.push(baseURL);
    }
    const url: any = __upParseURL(input as string, base);
    if (url === null) return testOnly ? false : null;
    values[0] = url.scheme as string;
    values[1] = url.username as string;
    values[2] = url.password as string;
    values[3] = __upHostString(url);
    values[4] = url.port === null ? "" : String(url.port);
    values[5] = __wuSerializePath(url);
    values[6] = url.query === null ? "" : (url.query as string);
    values[7] = url.fragment === null ? "" : (url.fragment as string);
  } else {
    if (baseURL !== null) __upFail("a baseURL is not allowed with a URLPatternInit");
    inputs.push(input);
    let applied: any = null;
    try {
      applied = __upProcessInit(input, false, { protocol: "", username: "", password: "", hostname: "", port: "", pathname: "", search: "", hash: "" });
    } catch (e) {
      return testOnly ? false : null;
    }
    for (let i = 0; i < 8; i++) {
      const v: any = applied[__UP_KEYS[i]];
      values[i] = v === undefined ? "" : (v as string);
    }
  }
  const execs: any = [];
  for (let i = 0; i < 8; i++) {
    const m: any = pattern._components[i].regexp.exec(values[i]);
    if (m === null) return testOnly ? false : null;
    execs.push(m);
  }
  if (testOnly) return true;
  const result: any = { inputs: inputs };
  for (let i = 0; i < 8; i++) {
    const comp: any = pattern._components[i];
    const m: any = execs[i];
    const groups: any = {};
    const names: any = comp.names;
    for (let j = 1; j < __wuALen(m); j++) {
      groups[names[j - 1] as string] = m[j];
    }
    result[__UP_KEYS[i]] = { input: values[i], groups: groups };
  }
  return result;
}

// The exported constructor. See the header: it is a function so that a call
// without `new` can answer `ERR_CONSTRUCT_CALL_REQUIRED`, and it performs
// Node's argument checks before the standard's algorithm runs.
function __urlPatternCtor(this: any, ...rest: any[]): any {
  const self: any = this;
  if (self === undefined || self === null || self === globalThis) throw new ERR_CONSTRUCT_CALL_REQUIRED();
  const argc = __wuALen(rest);
  const input: any = argc > 0 ? rest[0] : undefined;
  let converted: any = null;
  if (input === undefined) converted = {};
  else if (typeof input === "string") converted = input;
  else if (__upIsObject(input)) converted = __upConvertInit(input);
  else throw new ERR_URLPATTERN_ARG_TYPE("Input must be an object or a string");
  let baseURL: any = null;
  let options: any = undefined;
  if (argc > 1) {
    const second: any = rest[1];
    if (typeof second === "string") {
      baseURL = second;
      if (argc > 2) options = rest[2];
    } else if (__upIsObject(second)) {
      options = second;
    } else if (second !== undefined) {
      throw new ERR_URLPATTERN_ARG_TYPE("Second argument must be a string or an object");
    }
  }
  let ignoreCase = false;
  if (options !== undefined) {
    if (!__upIsObject(options)) throw new ERR_URLPATTERN_ARG_TYPE("Options must be an object");
    const ic: any = options.ignoreCase;
    if (ic !== undefined) {
      if (typeof ic !== "boolean") throw new ERR_URLPATTERN_ARG_TYPE("options.ignoreCase must be a boolean");
      ignoreCase = ic === true;
    }
  }
  return new NodeURLPattern(converted, baseURL, ignoreCase);
}

const URLPattern: any = __urlPatternCtor;
URLPattern.prototype = NodeURLPattern.prototype;
Object.defineProperty(NodeURLPattern.prototype, Symbol.toStringTag, {
  value: "URLPattern",
  configurable: true,
});
(globalThis as any).URLPattern = URLPattern;

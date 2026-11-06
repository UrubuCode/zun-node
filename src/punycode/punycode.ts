// node:punycode — the RFC 3492 Bootstring codec, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes 100%
// of Node's own `test/parallel/test-punycode*.js` files (see
// ../../test/punycode/). The algorithms follow Node's `lib/punycode.js` (MIT,
// Copyright Mathias Bynens; vendored into Node) line for line, because
// Bootstring's bias adaptation, its overflow checks and the exact points at
// which it raises `RangeError` are defined by that code and pinned by the RFC's
// own test vectors, which `test-punycode.js` runs in full.
//
// `punycode` is **deprecated** in Node (DEP0040) and still shipped. The
// deprecation warning is not emitted from this file: it belongs to the act of
// requiring the module, so it lives in `deprecation.ts`, which the bundler
// inlines only for a test that actually requires `punycode` — see the
// CONDITIONAL_FILES note in `tools/bundle_node_test.sh`. The algorithms
// themselves are always inlined, because `src/url/url.ts` stands on them for
// `domainToASCII`/`domainToUnicode`, and `require('node:url')` does not emit a
// `punycode` warning in Node either.
//
// Engine workarounds in this file, each tied to an open zun issue:
//   * **No regular expressions.** Node's `lib/punycode.js` uses four
//     (`/^xn--/`, `/[^\0-\x7F]/`, the separator class, and the `g` flag on it);
//     a RegExp loses its methods when it flows through an `any`
//     (https://github.com/UrubuCode/zun/issues/7), and all four are
//     single-character classes or a literal prefix, so each is a scan here.
//     That also keeps the module free of any backtracking surface, which is the
//     same posture `querystring.ts` takes.
//   * `__pcLen()` instead of `.length` — the checker types `.length` as `u64`
//     (https://github.com/UrubuCode/zun/issues/3).
//   * `__pcUnits()` — `charCodeAt(index)` is O(n) in the string's length
//     (https://github.com/UrubuCode/zun/issues/12), so every scan runs over the
//     code-unit array `split("")` produces, exactly as in `querystring.ts`.
//   * `String.fromCodePoint(...codePoints)` is spelled as a per-element loop:
//     Node's `ucs2encode` spreads the whole array into the built-in, and a
//     spread into a built-in is not something to rely on here when a fold is
//     identical.
//   * Boolean-as-number arithmetic (`75 * (digit < 26)`, `(flag != 0) << 5`) is
//     written out as conditionals.

// ---------------------------------------------------------------------------
// Bootstring parameters (RFC 3492 section 5)
// ---------------------------------------------------------------------------

const __PC_MAX_INT: number = 2147483647; // 0x7FFFFFFF
const __PC_BASE: number = 36;
const __PC_T_MIN: number = 1;
const __PC_T_MAX: number = 26;
const __PC_SKEW: number = 38;
const __PC_DAMP: number = 700;
const __PC_INITIAL_BIAS: number = 72;
const __PC_INITIAL_N: number = 128; // 0x80
const __PC_DELIMITER = "-";
const __PC_BASE_MINUS_T_MIN: number = __PC_BASE - __PC_T_MIN;

const __PC_ERR_OVERFLOW = "Overflow: input needs wider integers to process";
const __PC_ERR_NOT_BASIC = "Illegal input >= 0x80 (not a basic code point)";
const __PC_ERR_INVALID = "Invalid input";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function __pcLen(value: string): number {
  return Number(value.length);
}

function __pcALen(value: any): number {
  return Number(value.length);
}

// The code units of `s`, as one-character strings. See the header note on #12.
function __pcUnits(s: string): any {
  return s.split("");
}

function __pcCode(unit: any): number {
  return Number((unit as string).charCodeAt(0));
}

// `String.fromCodePoint(...codePoints)`, as a fold.
function __pcFromCodePoints(codePoints: any): string {
  const out: string[] = [];
  const n = __pcALen(codePoints);
  for (let i = 0; i < n; i++) out.push(String.fromCodePoint(Number(codePoints[i])));
  return out.join("");
}

// `punycode.ucs2.decode`: the code points of a UCS-2 string, pairing surrogates.
function __pcUcs2Decode(input: any): any[] {
  const text: string = typeof input === "string" ? input : String(input);
  const units: any = __pcUnits(text);
  const length = __pcALen(units);
  const output: any[] = [];
  let counter: number = 0;
  while (counter < length) {
    const value: number = __pcCode(units[counter]);
    counter = counter + 1;
    if (value >= 0xd800 && value <= 0xdbff && counter < length) {
      // A high surrogate, and there is a next code unit.
      const extra: number = __pcCode(units[counter]);
      counter = counter + 1;
      if ((extra & 0xfc00) === 0xdc00) {
        output.push(((value & 0x3ff) * 1024) + (extra & 0x3ff) + 0x10000);
      } else {
        // An unmatched surrogate: append this unit alone, in case the next one
        // is itself the high half of a pair.
        output.push(value);
        counter = counter - 1;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

function __pcUcs2Encode(codePoints: any): string {
  return __pcFromCodePoints(codePoints);
}

// The numeric value of a basic code point used as a digit, or `base` when it is
// not one.
function __pcBasicToDigit(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint < 0x3a) return 26 + (codePoint - 0x30);
  if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41;
  if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61;
  return __PC_BASE;
}

// The basic code point whose digit value is `digit`; uppercase when `flag`.
function __pcDigitToBasic(digit: number, flag: number): number {
  let value: number = digit + 22;
  if (digit < 26) value = value + 75;
  if (flag !== 0) value = value - 32;
  return value;
}

// Bias adaptation, RFC 3492 section 3.4.
function __pcAdapt(deltaIn: number, numPoints: number, firstTime: boolean): number {
  let k: number = 0;
  let delta: number = firstTime ? Math.floor(deltaIn / __PC_DAMP) : Math.floor(deltaIn / 2);
  delta = delta + Math.floor(delta / numPoints);
  // Node's `baseMinusTMin * tMax >> 1`, which is 455.
  const threshold: number = Math.floor((__PC_BASE_MINUS_T_MIN * __PC_T_MAX) / 2);
  while (delta > threshold) {
    delta = Math.floor(delta / __PC_BASE_MINUS_T_MIN);
    k = k + __PC_BASE;
  }
  return Math.floor(k + ((__PC_BASE_MINUS_T_MIN + 1) * delta) / (delta + __PC_SKEW));
}

// ---------------------------------------------------------------------------
// punycode.decode
// ---------------------------------------------------------------------------

function __pcDecode(input: any): string {
  const text: string = typeof input === "string" ? input : String(input);
  const units: any = __pcUnits(text);
  const inputLength = __pcALen(units);
  const output: any = [];
  let i: number = 0;
  let n: number = __PC_INITIAL_N;
  let bias: number = __PC_INITIAL_BIAS;

  // `basic` is the number of input code points before the last delimiter, or 0.
  let basic: number = Number(text.lastIndexOf(__PC_DELIMITER));
  if (basic < 0) basic = 0;

  for (let j = 0; j < basic; j++) {
    if (__pcCode(units[j]) >= 0x80) throw new RangeError(__PC_ERR_NOT_BASIC);
    output.push(__pcCode(units[j]));
  }

  let index: number = basic > 0 ? basic + 1 : 0;
  while (index < inputLength) {
    // Decode a generalized variable-length integer into `delta`, which is added
    // to `i`. The overflow checking is easier by growing `i` as we go and
    // subtracting its starting value at the end.
    const oldi: number = i;
    let w: number = 1;
    let k: number = __PC_BASE;
    let running = true;
    while (running) {
      if (index >= inputLength) throw new RangeError(__PC_ERR_INVALID);
      const digit: number = __pcBasicToDigit(__pcCode(units[index]));
      index = index + 1;
      if (digit >= __PC_BASE) throw new RangeError(__PC_ERR_INVALID);
      if (digit > Math.floor((__PC_MAX_INT - i) / w)) {
        throw new RangeError(__PC_ERR_OVERFLOW);
      }
      i = i + digit * w;
      const t: number = k <= bias ? __PC_T_MIN : k >= bias + __PC_T_MAX ? __PC_T_MAX : k - bias;
      if (digit < t) {
        running = false;
      } else {
        const baseMinusT: number = __PC_BASE - t;
        if (w > Math.floor(__PC_MAX_INT / baseMinusT)) {
          throw new RangeError(__PC_ERR_OVERFLOW);
        }
        w = w * baseMinusT;
        k = k + __PC_BASE;
      }
    }

    const out: number = __pcALen(output) + 1;
    bias = __pcAdapt(i - oldi, out, oldi === 0);

    // `i` was meant to wrap from `out` to 0, incrementing `n` each time.
    if (Math.floor(i / out) > __PC_MAX_INT - n) {
      throw new RangeError(__PC_ERR_OVERFLOW);
    }
    n = n + Math.floor(i / out);
    i = i % out;

    // Insert `n` at position `i` of the output.
    output.splice(i, 0, n);
    i = i + 1;
  }

  return __pcFromCodePoints(output);
}

// ---------------------------------------------------------------------------
// punycode.encode
// ---------------------------------------------------------------------------

function __pcEncode(input: any): string {
  const output: string[] = [];
  const points: any[] = __pcUcs2Decode(input);
  const inputLength = __pcALen(points);

  let n: number = __PC_INITIAL_N;
  let delta: number = 0;
  let bias: number = __PC_INITIAL_BIAS;

  // The basic code points.
  for (let idx = 0; idx < inputLength; idx++) {
    const currentValue: number = Number(points[idx]);
    if (currentValue < 0x80) output.push(String.fromCharCode(currentValue));
  }

  const basicLength: number = __pcALen(output);
  let handledCPCount: number = basicLength;

  // Finish the basic string with a delimiter unless it is empty.
  if (basicLength > 0) output.push(__PC_DELIMITER);

  while (handledCPCount < inputLength) {
    // Every non-basic code point below `n` is handled; find the next larger one.
    let m: number = __PC_MAX_INT;
    for (let idx = 0; idx < inputLength; idx++) {
      const currentValue: number = Number(points[idx]);
      if (currentValue >= n && currentValue < m) m = currentValue;
    }

    // Advance the decoder's <n,i> state to <m,0>, guarding against overflow.
    const handledCPCountPlusOne: number = handledCPCount + 1;
    if (m - n > Math.floor((__PC_MAX_INT - delta) / handledCPCountPlusOne)) {
      throw new RangeError(__PC_ERR_OVERFLOW);
    }
    delta = delta + (m - n) * handledCPCountPlusOne;
    n = m;

    for (let idx = 0; idx < inputLength; idx++) {
      const currentValue: number = Number(points[idx]);
      if (currentValue < n) {
        delta = delta + 1;
        if (delta > __PC_MAX_INT) throw new RangeError(__PC_ERR_OVERFLOW);
      }
      if (currentValue === n) {
        // Represent `delta` as a generalized variable-length integer.
        let q: number = delta;
        let k: number = __PC_BASE;
        let running = true;
        while (running) {
          const t: number =
            k <= bias ? __PC_T_MIN : k >= bias + __PC_T_MAX ? __PC_T_MAX : k - bias;
          if (q < t) {
            running = false;
          } else {
            const qMinusT: number = q - t;
            const baseMinusT: number = __PC_BASE - t;
            output.push(
              String.fromCharCode(__pcDigitToBasic(t + (qMinusT % baseMinusT), 0)),
            );
            q = Math.floor(qMinusT / baseMinusT);
            k = k + __PC_BASE;
          }
        }
        output.push(String.fromCharCode(__pcDigitToBasic(q, 0)));
        bias = __pcAdapt(delta, handledCPCountPlusOne, handledCPCount === basicLength);
        delta = 0;
        handledCPCount = handledCPCount + 1;
      }
    }

    delta = delta + 1;
    n = n + 1;
  }

  return output.join("");
}

// ---------------------------------------------------------------------------
// punycode.toASCII / punycode.toUnicode
// ---------------------------------------------------------------------------

// The four RFC 3490 label separators, normalized to `.`: FULL STOP,
// IDEOGRAPHIC FULL STOP, FULLWIDTH FULL STOP, HALFWIDTH IDEOGRAPHIC FULL STOP.
// Node spells this `domain.replace(/[\x2E。．｡]/g, '\x2E')`.
function __pcIsSeparator(code: number): boolean {
  return code === 0x2e || code === 0x3002 || code === 0xff0e || code === 0xff61;
}

function __pcNormalizeSeparators(domain: string): string {
  const units: any = __pcUnits(domain);
  const n = __pcALen(units);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(__pcIsSeparator(__pcCode(units[i])) ? "." : (units[i] as string));
  }
  return out.join("");
}

// Does `s` hold a code unit outside `\0-\x7F`? Node's `/[^\0-\x7F]/.test(s)`.
function __pcHasNonASCII(s: string): boolean {
  const units: any = __pcUnits(s);
  const n = __pcALen(units);
  for (let i = 0; i < n; i++) {
    if (__pcCode(units[i]) > 0x7f) return true;
  }
  return false;
}

// Node's `/^xn--/.test(s)` — case sensitive, as written there.
function __pcIsPunycodePrefixed(s: string): boolean {
  return __pcLen(s) >= 4 && s.slice(0, 4) === "xn--";
}

// `mapDomain(domain, callback)`: in an email address only the domain part is
// converted, so everything up to the first `@` is left intact.
function __pcMapDomain(input: any, toAscii: boolean): string {
  const text: string = typeof input === "string" ? input : String(input);
  const parts: any = text.split("@");
  let result = "";
  let domain = text;
  if (__pcALen(parts) > 1) {
    result = (parts[0] as string) + "@";
    const rest: string[] = [];
    for (let i = 1; i < __pcALen(parts); i++) rest.push(parts[i] as string);
    domain = rest.join("@");
  }
  domain = __pcNormalizeSeparators(domain);
  const labels: any = domain.split(".");
  const encoded: string[] = [];
  for (let i = 0; i < __pcALen(labels); i++) {
    const label: string = labels[i] as string;
    if (toAscii) {
      encoded.push(__pcHasNonASCII(label) ? "xn--" + __pcEncode(label) : label);
    } else {
      encoded.push(
        __pcIsPunycodePrefixed(label) ? __pcDecode(label.slice(4).toLowerCase()) : label,
      );
    }
  }
  return result + encoded.join(".");
}

function __pcToASCII(input: any): string {
  return __pcMapDomain(input, true);
}

function __pcToUnicode(input: any): string {
  return __pcMapDomain(input, false);
}

// ---------------------------------------------------------------------------
// The module object
//
// Every entry is a function *expression* assigned to a property rather than a
// shorthand method, for the reason spelled out in `querystring.ts`: that is the
// only spelling that is callable as `punycode.encode(x)` and still reads back
// out of the object as a value — which `test-punycode.js` needs, because it
// drives the whole RFC 3492 vector table through `testBattery[key](testCase)`.
// ---------------------------------------------------------------------------

const __pcUcs2: any = {
  decode: function (...rest: any[]): any {
    return __pcUcs2Decode(rest[0]);
  },
  encode: function (...rest: any[]): string {
    return __pcUcs2Encode(rest[0]);
  },
};

const punycode: any = {
  version: "2.1.0",
  ucs2: __pcUcs2,
  decode: function (...rest: any[]): string {
    return __pcDecode(rest[0]);
  },
  encode: function (...rest: any[]): string {
    return __pcEncode(rest[0]);
  },
  toASCII: function (...rest: any[]): string {
    return __pcToASCII(rest[0]);
  },
  toUnicode: function (...rest: any[]): string {
    return __pcToUnicode(rest[0]);
  },
};

// `node:punycode` module object for the bundler's `require` rewriting.
const __node_punycode: any = punycode;

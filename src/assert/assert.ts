// node:assert — the strict-mode surface Node's own test files use.
//
// This exists because Node's test suite is zun-node's compatibility oracle (see
// ../../PLAN.md): every `test/parallel/test-*.js` starts with
// `const assert = require('assert')`. Implementing the module is therefore part
// of implementing any other module, per PLAN.md principle 4.
//
// Surface: ok, equal, notEqual, strictEqual, notStrictEqual, deepStrictEqual,
// notDeepStrictEqual, throws, doesNotThrow, match, doesNotMatch, fail,
// AssertionError. Errors carry Node's `code`, `actual`, `expected` and
// `operator` fields.

class AssertionError extends Error {
  code: string;
  actual: any;
  expected: any;
  operator: string;
  generatedMessage: boolean;

  constructor(options: any) {
    super(String(options.message));
    this.code = "ERR_ASSERTION";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = String(options.operator);
    this.generatedMessage = options.generatedMessage === true;
  }

  get name(): string {
    return "AssertionError";
  }
}

// A compact `util.inspect` stand-in, enough for assertion messages.
function __inspect(value: any): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const kind = typeof value;
  if (kind === "string") return JSON.stringify(value);
  if (kind === "number" || kind === "boolean" || kind === "bigint") {
    return String(value);
  }
  if (kind === "function") return "[Function]";
  if (kind === "symbol") return String(value);
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) parts.push(__inspect(item));
    return "[ " + parts.join(", ") + " ]";
  }
  if (kind === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const parts: string[] = [];
    for (const key of keys) parts.push(key + ": " + __inspect(value[key]));
    return "{ " + parts.join(", ") + " }";
  }
  return String(value);
}

function __fail(
  actual: any,
  expected: any,
  message: any,
  operator: string,
): void {
  // An uncaught error prints only its address today
  // (https://github.com/UrubuCode/zun/issues/8), so report the failure here
  // where the detail is still in hand. The throw below still decides the exit
  // code.
  console.error(
    "AssertionError [" +
      operator +
      "]: " +
      (message === undefined || message === null
        ? __inspect(actual) + " !== " + __inspect(expected)
        : String(message)),
  );
  if (message !== undefined && message !== null) {
    if (typeof message === "object" && message instanceof Error) throw message;
    throw new AssertionError({
      message: String(message),
      actual,
      expected,
      operator,
      generatedMessage: false,
    });
  }
  throw new AssertionError({
    message:
      "Expected values to be " +
      operator +
      ":\n\n" +
      __inspect(actual) +
      " !== " +
      __inspect(expected) +
      "\n",
    actual,
    expected,
    operator,
    generatedMessage: true,
  });
}

// A RegExp loses its methods when it flows through `any`, so a regex received as
// an argument cannot answer `.test` directly; rebuild a statically-typed one from
// its stringification (https://github.com/UrubuCode/zun/issues/7).
function __regexTest(value: any, subject: string): boolean {
  const text = String(value);
  let end = Number(text.length) - 1;
  while (end > 0 && text.charCodeAt(end) !== 47) {
    end = end - 1;
  }
  const re = new RegExp(text.slice(1, end), text.slice(end + 1));
  return re.test(subject);
}

function __isDeepStrictEqual(a: any, b: any): boolean {
  if (a === b) return true;
  // -0 / +0 are distinct under deepStrictEqual, NaN equals NaN.
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  if (ta === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    return a === b;
  }
  if (a === null || b === null) return false;
  if (ta !== "object") return false;
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray) {
    if (Number(a.length) !== Number(b.length)) return false;
    const n = Number(a.length);
    for (let i = 0; i < n; i++) {
      if (!__isDeepStrictEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (Number(aKeys.length) !== Number(bKeys.length)) return false;
  for (const key of aKeys) {
    // `Object.prototype.hasOwnProperty.call` is unavailable
    // (https://github.com/UrubuCode/zun/issues/5); the instance method works.
    if (!b.hasOwnProperty(key)) return false;
    if (!__isDeepStrictEqual(a[key], b[key])) return false;
  }
  return true;
}

// `assert.throws(fn, expected?, message?)`: `expected` may be a RegExp, a
// constructor, a validation object (`{ code, name, message }`) or a predicate.
function __expectationMatches(error: any, expected: any): boolean {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) {
    return __regexTest(
      expected,
      String(error && error.message ? error.message : error),
    );
  }
  const kind = typeof expected;
  if (kind === "function") {
    // A constructor (checked with instanceof) or a predicate returning true.
    const asPredicate = expected(error);
    return asPredicate === true;
  }
  if (kind === "object" && expected !== null) {
    for (const key of Object.keys(expected)) {
      const want = expected[key];
      const got = error === null || error === undefined ? undefined : error[key];
      if (want instanceof RegExp) {
        if (!__regexTest(want, String(got))) return false;
      } else if (!__isDeepStrictEqual(got, want)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

const assert: any = {
  AssertionError,

  ok(value: any, message?: any): void {
    if (!value) __fail(value, true, message, "==");
  },

  equal(actual: any, expected: any, message?: any): void {
    if (actual != expected) __fail(actual, expected, message, "==");
  },

  notEqual(actual: any, expected: any, message?: any): void {
    if (actual == expected) __fail(actual, expected, message, "!=");
  },

  strictEqual(actual: any, expected: any, message?: any): void {
    if (actual !== expected) {
      if (
        typeof actual === "number" &&
        typeof expected === "number" &&
        Number.isNaN(actual) &&
        Number.isNaN(expected)
      ) {
        return;
      }
      __fail(actual, expected, message, "strictEqual");
    }
  },

  notStrictEqual(actual: any, expected: any, message?: any): void {
    if (actual === expected) __fail(actual, expected, message, "notStrictEqual");
  },

  deepStrictEqual(actual: any, expected: any, message?: any): void {
    if (!__isDeepStrictEqual(actual, expected)) {
      __fail(actual, expected, message, "deepStrictEqual");
    }
  },

  notDeepStrictEqual(actual: any, expected: any, message?: any): void {
    if (__isDeepStrictEqual(actual, expected)) {
      __fail(actual, expected, message, "notDeepStrictEqual");
    }
  },

  throws(fn: any, expected?: any, message?: any): void {
    let threw = false;
    let error: any = undefined;
    try {
      fn();
    } catch (caught) {
      threw = true;
      error = caught;
    }
    if (!threw) {
      __fail(
        undefined,
        expected,
        message === undefined ? "Missing expected exception." : message,
        "throws",
      );
      return;
    }
    if (!__expectationMatches(error, expected)) {
      const detail =
        "The error does not match the expectation.\n  actual: " +
        __inspect(error === null || error === undefined ? error : {
          name: error.name,
          message: error.message,
          code: error.code,
        }) +
        "\n  expected: " +
        __inspect(expected);
      __fail(error, expected, message === undefined ? detail : message, "throws");
    }
  },

  doesNotThrow(fn: any, message?: any): void {
    try {
      fn();
    } catch (caught) {
      const error: any = caught;
      __fail(
        error,
        undefined,
        message === undefined
          ? "Got unwanted exception: " + String(error && error.message)
          : message,
        "doesNotThrow",
      );
    }
  },

  match(value: any, regexp: any, message?: any): void {
    if (!__regexTest(regexp, String(value))) {
      __fail(
        value,
        regexp,
        message === undefined
          ? "The input did not match the regular expression " +
              String(regexp) +
              ". Input:\n\n" +
              __inspect(value) +
              "\n"
          : message,
        "match",
      );
    }
  },

  doesNotMatch(value: any, regexp: any, message?: any): void {
    if (__regexTest(regexp, String(value))) {
      __fail(value, regexp, message, "doesNotMatch");
    }
  },

  fail(message?: any): void {
    __fail(
      undefined,
      undefined,
      message === undefined ? "Failed" : message,
      "fail",
    );
  },
};

assert.strict = assert;
assert.deepEqual = assert.deepStrictEqual;
assert.notDeepEqual = assert.notDeepStrictEqual;

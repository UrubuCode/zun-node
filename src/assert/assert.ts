// node:assert — the strict-mode surface Node's own test files use.
//
// This exists because Node's test suite is zun-node's compatibility oracle (see
// ../../PLAN.md): every `test/parallel/test-*.js` starts with
// `const assert = require('assert')`. Implementing the module is therefore part
// of implementing any other module, per PLAN.md principle 4.
//
// Surface: ok, equal, notEqual, strictEqual, notStrictEqual, deepStrictEqual,
// notDeepStrictEqual, throws, doesNotThrow, rejects, doesNotReject, ifError,
// match, doesNotMatch, fail, AssertionError. Errors carry Node's `code`,
// `actual`, `expected` and `operator` fields.
//
// Engine note: every identity comparison goes through `__sameValue`, because a
// function stored in an array arrives as a `functionBox` record rather than the
// callable (https://github.com/UrubuCode/zun/issues/17) — `[fn][0] === fn` is
// `false`, and `typeof [fn][0]` is `"object"`. The record's `__boxedFn` slot
// reads the original function back with its identity intact, so unwrapping both
// sides restores JavaScript's `===` for functions. Without it every
// `deepStrictEqual(ee.listeners('x'), [listener])` in Node's events corpus
// would fail for a reason that has nothing to do with the module under test.

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

// Unwrap a `functionBox` record back to its callable. See the header note.
function __unboxFn(value: any): any {
  if (value !== null && value !== undefined && typeof value === "object") {
    const inner: any = value["__boxedFn"];
    if (inner !== undefined) return inner;
  }
  return value;
}

// `===` that sees through function boxing.
function __sameValue(a: any, b: any): boolean {
  if (a === b) return true;
  return __unboxFn(a) === __unboxFn(b);
}

function __isDeepStrictEqual(a: any, b: any): boolean {
  if (__sameValue(a, b)) return true;
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
  // One side may be a boxed function and the other the bare callable.
  if (typeof __unboxFn(a) === "function" || typeof __unboxFn(b) === "function") {
    return __unboxFn(a) === __unboxFn(b);
  }
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
    // `Object.prototype.hasOwnProperty.call(b, key)` works again
    // (https://github.com/UrubuCode/zun/issues/5 is fixed apart from
    // `Object.hasOwn`, which is still missing); the instance method is kept
    // because it is the shorter spelling of the same check and `b` is always a
    // plain object here.
    if (!b.hasOwnProperty(key)) return false;
    if (!__isDeepStrictEqual(a[key], b[key])) return false;
  }
  return true;
}

// Is `error` an instance of `expected`, when `expected` is one of the standard
// error constructors? `undefined` means "`expected` is not one of them", which
// is what tells `__expectationMatches` to fall through to the predicate form.
//
// Every `instanceof` below names its class literally, because that is the only
// spelling the engine resolves; the identity test in front of it is what makes
// the dispatch work at all. `AssertionError` is this module's own class and is
// included so `assert.throws(fn, assert.AssertionError)` behaves.
function __matchesErrorConstructor(error: any, expected: any): any {
  if (expected === Error) return error instanceof Error;
  if (expected === TypeError) return error instanceof TypeError;
  if (expected === RangeError) return error instanceof RangeError;
  if (expected === SyntaxError) return error instanceof SyntaxError;
  if (expected === ReferenceError) return error instanceof ReferenceError;
  if (expected === EvalError) return error instanceof EvalError;
  if (expected === URIError) return error instanceof URIError;
  if (expected === AssertionError) return error instanceof AssertionError;
  return undefined;
}

// `assert.throws(fn, expected?, message?)`: `expected` may be a RegExp, a
// constructor, a validation object (`{ code, name, message }`) or a predicate.
function __expectationMatches(error: any, boxedExpected: any): boolean {
  // A predicate produced by `common.expectsError` arrives as a `functionBox`
  // record, which reports `typeof === "object"`; unwrap before dispatching.
  const expected: any = __unboxFn(boxedExpected);
  if (expected === undefined) return true;
  if (expected instanceof RegExp) {
    return __regexTest(
      expected,
      String(error && error.message ? error.message : error),
    );
  }
  const kind = typeof expected;
  if (kind === "function") {
    // `assert.throws(fn, Ctor)` — Node checks `error instanceof Ctor`.
    //
    // A constructor cannot be told apart from a predicate by inspection here:
    // `.name` on a function value reads back `undefined`, and
    // `error instanceof ctorValue` aborts with "call did not resolve to a
    // method" whenever the right-hand side is an `any`-typed value rather than
    // a class the checker can see
    // (https://github.com/UrubuCode/zun/issues/17). What *does* work now is
    // identity: `expected === TypeError` is true for the real constructor
    // (https://github.com/UrubuCode/zun/issues/23's cousin — builtin
    // constructors read as values keep their identity), and the right-hand side
    // of the `instanceof` is then a literal the checker resolves. So the eight
    // standard error constructors are matched by identity and the `instanceof`
    // is spelled statically; anything else is applied as a predicate.
    const byCtor = __matchesErrorConstructor(error, expected);
    if (byCtor !== undefined) return byCtor === true;
    try {
      const asPredicate = expected(error);
      return asPredicate === true;
    } catch (ignored) {
      return false;
    }
  }
  if (expected instanceof Error) {
    // `assert.throws(fn, theError)` — the very error object is expected.
    return __sameValue(error, expected);
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
    if (!__sameValue(actual, expected)) {
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
    if (__sameValue(actual, expected)) {
      __fail(actual, expected, message, "notStrictEqual");
    }
  },

  // `assert.ifError(value)` — anything but `null`/`undefined` is a failure.
  ifError(value: any): void {
    if (value === null || value === undefined) return;
    __fail(value, null, "ifError got unwanted exception: " + __inspect(value), "ifError");
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

  // `assert.rejects(promiseOrFn, expected?, message?)` -> a Promise that settles
  // once the rejection has been checked. The awaited value is produced by
  // calling `fn()` when a function is passed, exactly as in Node.
  //
  // Every callback below is declared `: any` and ends in an explicit
  // `return undefined`: a `void` closure that calls an `any`-typed callback
  // leaves the call result on the stack and the bytecode verifier rejects the
  // method (`BadReturnHeight`).
  rejects(promiseOrFn: any, expected?: any, message?: any): any {
    return new Promise(function (resolve: any, reject: any): any {
      let subject: any = promiseOrFn;
      if (typeof promiseOrFn === "function") {
        try {
          subject = promiseOrFn();
        } catch (caught) {
          reject(caught);
          return undefined;
        }
      }
      const onFulfilled: any = function (): any {
        try {
          __fail(
            undefined,
            expected,
            message === undefined ? "Missing expected rejection." : message,
            "rejects",
          );
        } catch (failure) {
          reject(failure);
        }
        return undefined;
      };
      const onRejected: any = function (error: any): any {
        if (__expectationMatches(error, expected)) {
          resolve(undefined);
          return undefined;
        }
        try {
          __fail(
            error,
            expected,
            message === undefined ? "The rejection does not match the expectation." : message,
            "rejects",
          );
        } catch (failure) {
          reject(failure);
        }
        return undefined;
      };
      if (subject instanceof Promise) {
        subject.then(onFulfilled, onRejected);
        return undefined;
      }
      try {
        __fail(subject, expected, message, "rejects");
      } catch (failure) {
        reject(failure);
      }
      return undefined;
    });
  },

  doesNotReject(promiseOrFn: any, message?: any): any {
    return new Promise(function (resolve: any, reject: any): any {
      let subject: any = promiseOrFn;
      if (typeof promiseOrFn === "function") {
        try {
          subject = promiseOrFn();
        } catch (caught) {
          reject(caught);
          return undefined;
        }
      }
      if (subject instanceof Promise) {
        const onOk: any = function (): any {
          resolve(undefined);
          return undefined;
        };
        const onBad: any = function (error: any): any {
          try {
            __fail(error, undefined, message, "doesNotReject");
          } catch (failure) {
            reject(failure);
          }
          return undefined;
        };
        subject.then(onOk, onBad);
        return undefined;
      }
      resolve(undefined);
      return undefined;
    });
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
assert.ok = assert.ok;
assert.equal = assert.equal;

// `node:assert` module object for the bundler's `require` rewriting.
const __node_assert: any = assert;

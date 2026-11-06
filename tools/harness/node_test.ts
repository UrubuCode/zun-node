// `node:test`, reduced to what Node's own `test/parallel` files use when they
// are written against the built-in test runner rather than bare `assert`.
//
// This is **harness** code, not library code: `node:test` is not a module
// zun-node implements, it is a module several of Node's test files are written
// in. Without it `test/parallel/test-util-stripvtcontrolcharacters.js` and
// `test-util-text-decoder.js` cannot even be bundled, and the thing they
// actually exercise (`util.stripVTControlCharacters`, the `TextDecoder` global)
// never gets measured. It lives next to `common.ts` for exactly that reason.
//
// What it does: `test(name, options?, fn)` runs `fn` immediately and
// synchronously, in declaration order, which is the observable behaviour for a
// file of independent top-level tests. A test that throws is reported on stderr
// and sets `process.exitCode = 1`, so the tracker scores the file as a failure —
// the same outcome Node's runner produces through its TAP output and exit code.
// `options.skip` and `options.todo` are honoured. A test function that returns a
// promise is awaited through the harness settle loop: the rejection handler
// records the failure, so an async failure still fails the run.
//
// What it does not do: concurrency, `--test-only`, reporters, hooks beyond
// `before`/`after`/`beforeEach`/`afterEach`, mocking, snapshots. Those are the
// test runner's own surface, and no file in the corpora measured here uses them.
//
// Engine notes:
//   * `test` is a top-level **function declaration**, because the bundler needs
//     a canonical binding that is callable: Node's files spell both
//     `const test = require('node:test')` (the module object *is* the function)
//     and `const { test } = require('node:test')`. A callable object with
//     methods is not expressible here (zun#14), so the function carries
//     `describe`/`it`/`before`/… as attached properties instead.
//   * Every nested closure takes a rest parameter rather than the implicit
//     arg-uments object: see the note in ../../src/util/util.ts.

const __testState: any = { depth: 0, failures: 0 };

function test(name?: any, options?: any, fn?: any): any {
  return __testRun(name, options, fn, undefined);
}

function __testRun(name: any, options: any, fn: any, parent: any): any {
  // Node's three signatures: (fn), (name, fn), (name, options, fn).
  let label: any = name;
  let opts: any = options;
  let body: any = fn;
  if (__testIsFn(label)) {
    body = label;
    opts = undefined;
    label = "<anonymous>";
  } else if (__testIsFn(opts) && body === undefined) {
    body = opts;
    opts = undefined;
  }
  if (opts === undefined || opts === null) opts = {};

  if (opts.skip === true || typeof opts.skip === "string") {
    console.log("# SKIP " + String(label));
    return undefined;
  }
  if (opts.todo === true || typeof opts.todo === "string") {
    console.log("# TODO " + String(label));
    return undefined;
  }
  if (!__testIsFn(body)) {
    console.log("# " + String(label));
    return undefined;
  }

  const context: any = __testContext(String(label));
  __testState.depth = Number(__testState.depth) + 1;
  try {
    const produced: any = __testCall(body, [context]);
    if (produced !== null && produced !== undefined && __testIsFn(produced.then)) {
      // A promise-returning test: a rejection is a failure, and the harness
      // settle loop keeps the program alive long enough to see it.
      const onRejected: any = function (...args: any[]): any {
        __testFail(String(label), args[0]);
        return undefined;
      };
      produced.then(undefined, __testBox(onRejected));
    }
  } catch (error) {
    __testFail(String(label), error);
  }
  __testState.depth = Number(__testState.depth) - 1;
  return undefined;
}

function __testFail(label: string, error: any): void {
  __testState.failures = Number(__testState.failures) + 1;
  const message: any =
    error === null || error === undefined ? String(error) : error.message;
  host.stderrWrite("not ok - " + label + ": " + String(message) + "\n");
  process.exitCode = 1;
}

// The `TestContext` a test body receives. `t.assert` is the module's own
// `assert` object, which is exactly what Node binds there.
function __testContext(label: string): any {
  return {
    name: label,
    assert: assert,
    diagnostic(message: any): void {
      console.log("# " + String(message));
    },
    skip(message?: any): void {
      console.log("# SKIP " + label + (message === undefined ? "" : " " + String(message)));
    },
    todo(message?: any): void {
      console.log("# TODO " + label + (message === undefined ? "" : " " + String(message)));
    },
    plan(count: any): void {},
    runOnly(): void {},
    test(name?: any, options?: any, fn?: any): any {
      return __testRun(name, options, fn, label);
    },
  };
}

function __testIsFn(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "function") return true;
  if (typeof value === "object") return value["__boxedFn"] !== undefined;
  return false;
}

function __testBox(fn: any): any {
  if (fn !== null && fn !== undefined && typeof fn === "object") return fn;
  const holder: any[] = [fn];
  return holder[0];
}

// A `functionBox` record reports `typeof === "function"` now rather than
// `"object"`, so the `__boxedFn` slot is probed for both kinds; guarding on
// `"object"` alone left a boxed callable unopened and uncallable.
function __testCall(fn: any, args: any[]): any {
  let callable: any = fn;
  if (fn !== null && fn !== undefined) {
    const kind = typeof fn;
    if (kind === "object" || kind === "function") {
      const inner: any = fn["__boxedFn"];
      if (inner !== undefined) callable = inner;
    }
  }
  return callable(...args);
}

// `describe`/`it` are the suite spelling of the same thing; the hooks run their
// callback immediately, which is correct for a file that only uses them to
// group top-level tests.
function __testDescribe(name?: any, options?: any, fn?: any): any {
  return __testRun(name, options, fn, undefined);
}

function __testHook(fn?: any): any {
  if (__testIsFn(fn)) __testCall(fn, []);
  return undefined;
}

(test as any).test = __testBox(test);
(test as any).describe = __testBox(__testDescribe);
(test as any).suite = __testBox(__testDescribe);
(test as any).it = __testBox(test);
(test as any).before = __testBox(__testHook);
(test as any).after = __testBox(__testHook);
(test as any).beforeEach = __testBox(__testHook);
(test as any).afterEach = __testBox(__testHook);

// The module object. `test` itself is the canonical binding, so a file that
// writes `const test = require('node:test')` keeps the callable and a file that
// destructures gets the same function plus the names above.
const __node_test: any = {
  test: __testBox(test),
  it: __testBox(test),
  describe: __testBox(__testDescribe),
  suite: __testBox(__testDescribe),
  before: __testBox(__testHook),
  after: __testBox(__testHook),
  beforeEach: __testBox(__testHook),
  afterEach: __testBox(__testHook),
};

// `node:tty`. The runtime has no TTY facility, so `WriteStream`/`ReadStream` are
// absent and `common.getTTYfd()` answers -1 — which is a legitimate outcome in
// Node's own `common` too (it returns -1 when it cannot open `/dev/tty`), so a
// test that needs a real TTY takes its `common.skip` branch rather than a
// fabricated one.
const __node_tty: any = {
  WriteStream: undefined,
  ReadStream: undefined,
  isatty(): boolean {
    return false;
  },
};

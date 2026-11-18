// `node:test` -- Node's built-in test runner, written against
// `lib/internal/test_runner/{test,harness,reporter/*,mock/*}.js` of Node v25.
//
// What is here:
//   * the test tree: a root, `test`/`it` (Test) and `describe`/`suite`
//     (Suite) nodes, with Node's execution order -- suites are built
//     synchronously when declared, tests run after the file's synchronous
//     part, one at a time unless `concurrency` says otherwise, a test waits
//     for the subtests it started, and a parent with a failing subtest fails
//     with `N subtest(s) failed`;
//   * hooks: `before`/`after`/`beforeEach`/`afterEach` at the top level, on a
//     suite and on a `TestContext`, with Node's inheritance (outer
//     `beforeEach` first, inner `afterEach` first, `before` once per parent);
//   * `TestContext` (`name`, `fullName`, `signal`, `filePath`, `passed`,
//     `error`, `attempt`, `diagnostic`, `plan`, `skip`, `todo`, `runOnly`,
//     `test`, the four hooks, `waitFor`, `assert`, `mock`) and `SuiteContext`;
//   * the options `skip`, `todo`, `only` (honoured under `--test-only`),
//     `timeout`, `concurrency`, `plan`, `signal`, with Node's validation;
//   * the `spec` (default), `tap` and `dot` reporters on stdout, the summary
//     diagnostics, and `process.exitCode = 1` when anything failed;
//   * `run()` (src/test/run.ts, inlined when a test uses it), `mock`
//     (src/test/mock.ts) and `assert.register`.
//
// Engine notes:
//   * `test` is a top-level **function declaration** because the bundler's
//     canonical binding for `node:test` has to be callable: Node's files spell
//     both `const test = require('node:test')` and `const { test } = ...`.
//     `test.test === test`, `test.describe === test.suite` and the
//     `.skip`/`.todo`/`.only` shorthands are properties attached to it.
//   * a test function is invoked through `.apply`, which also unwraps a
//     boxed callable (see `__ntCall`).
//   * the runner's own timers are `__timerRealSetTimeout` & co. from
//     src/timers/timers.ts, never the hooked globals, so a test that enables
//     `mock.timers` does not freeze its own runner.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const __NT_TIMEOUT_MAX: number = 2147483647;

function __ntIsFn(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "function") return true;
  if (typeof value === "object") return value["__boxedFn"] !== undefined;
  return false;
}

function __ntCall(fn: any, thisArg: any, args: any[]): any {
  let callable: any = fn;
  if (fn !== null && fn !== undefined) {
    const kind = typeof fn;
    if (kind === "object" || kind === "function") {
      const inner: any = fn["__boxedFn"];
      if (inner !== undefined) callable = inner;
    }
  }
  return callable.apply(thisArg, args);
}

function __ntIsPromise(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (value instanceof Promise) return true;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return false;
  // A native promise's `then` reads as `undefined` through `any` in this
  // engine, so the `instanceof` test above carries real promises; this one
  // carries user thenables.
  return __ntIsFn(value.then);
}

function __ntNow(): number {
  const perf: any = (globalThis as any).performance;
  if (perf !== undefined && perf !== null && typeof perf.now === "function") {
    return Number(perf.now());
  }
  return Number(Date.now());
}

function __ntDeferred(): any {
  const d: any = { promise: undefined, resolve: undefined, reject: undefined, settled: false };
  d.promise = new Promise((resolve: any, reject: any) => {
    d.resolve = resolve;
    d.reject = reject;
  });
  return d;
}

// One macrotask turn, through the unhooked `setImmediate`.
function __ntTick(): any {
  return new Promise((resolve: any) => {
    __timerRealSetImmediate(() => resolve(undefined));
  });
}

function __ntInspect(value: any): string {
  try {
    return String(__node_util.inspect(value, { breakLength: Infinity }));
  } catch (e) {
    return String(value);
  }
}

function __ntTypeName(value: any): string {
  return typeof value;
}

function __ntValidateNumber(value: any, name: string, min: number, max: number): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  const n = Number(value);
  if (n !== n || n < min || n > max) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + String(min) + " && <= " + String(max), value);
  }
}

function __ntValidateUint32(value: any, name: string, positive: boolean): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  const n = Number(value);
  const min = positive ? 1 : 0;
  if (n !== Math.floor(n) || n !== n) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (n < min || n > 4294967295) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + String(min) + " && <= 4294967295", value);
  }
}

function __ntValidateObject(value: any, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
  }
}

function __ntValidateFunction(value: any, name: string): void {
  if (!__ntIsFn(value)) throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
}

// ---------------------------------------------------------------------------
// ERR_TEST_FAILURE
// ---------------------------------------------------------------------------

const __NT_kTestCodeFailure = "testCodeFailure";
const __NT_kHookFailure = "hookFailed";
const __NT_kSubtestsFailed = "subtestsFailed";
const __NT_kTestTimeoutFailure = "testTimeoutFailure";
const __NT_kCancelledByParent = "cancelledByParent";
const __NT_kAborted = "testAborted";
const __NT_kCallbackAndPromisePresent = "callbackAndPromisePresent";
const __NT_kMultipleCallbackInvocations = "multipleCallbackInvocations";
const __NT_kParentAlreadyFinished = "parentAlreadyFinished";

class ERR_TEST_FAILURE extends Error {
  code: string = "ERR_TEST_FAILURE";
  failureType: any;
  cause: any;
  constructor(error: any, failureType: any) {
    super(__ntFailureMessage(error));
    this.code = "ERR_TEST_FAILURE";
    this.failureType = failureType;
    this.cause = error;
  }
  toString(): string {
    return "Error [ERR_TEST_FAILURE]: " + this.message;
  }
}

function __ntFailureMessage(error: any): string {
  if (error !== null && error !== undefined && typeof error === "object" && error.message !== undefined) {
    return String(error.message);
  }
  if (typeof error === "string") return error;
  return __ntInspect(error);
}

function __ntIsTestFailure(err: any): boolean {
  return err !== null && err !== undefined && typeof err === "object" &&
    err.code === "ERR_TEST_FAILURE" && err.failureType !== undefined;
}

// ---------------------------------------------------------------------------
// Runner state
// ---------------------------------------------------------------------------

const __ntState: any = {
  root: null,
  current: null,
  bootstrapped: false,
  rootScheduled: false,
  finished: false,
  // Event sinks: the default reporter, or a run() stream.
  sinks: [],
  reporterInstalled: false,
  counters: null,
  only: false,
  namePatterns: null,
  skipPatterns: null,
  customAsserts: [],
  snapshotSerializers: null,
  snapshotResolver: null,
  file: undefined,
  startTime: 0,
  forceExit: false,
};

function __ntNewCounters(): any {
  return {
    tests: 0, suites: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0,
    topLevel: 0, all: 0,
  };
}

function __ntArgvHas(flag: string): boolean {
  try {
    const execArgv: any = process.execArgv;
    if (execArgv !== undefined && execArgv !== null) {
      for (const a of execArgv) if (String(a) === flag) return true;
    }
    const opts: any = process.env.NODE_OPTIONS;
    if (opts !== undefined && opts !== null && String(opts).indexOf(flag) !== -1) return true;
  } catch (e) {}
  return false;
}

function __ntArgvValues(prefix: string): string[] {
  const out: string[] = [];
  try {
    const execArgv: any = process.execArgv;
    if (execArgv !== undefined && execArgv !== null) {
      const n = Number(execArgv.length);
      for (let i = 0; i < n; i++) {
        const a = String(execArgv[i]);
        if (a.indexOf(prefix + "=") === 0) out.push(a.slice(prefix.length + 1));
        else if (a === prefix && i + 1 < n) out.push(String(execArgv[i + 1]));
      }
    }
  } catch (e) {}
  return out;
}

function __ntRoot(): any {
  if (__ntState.root === null) {
    const root: any = __ntNewNode("root", "<root>", {}, undefined, null);
    root.nesting = -1;
    root.concurrency = 1;
    __ntState.root = root;
    __ntState.counters = __ntNewCounters();
    // lib/internal/test_runner/harness.js: `only` filtering is always on in a
    // plain run (and under --test-isolation=none, which is one), and follows
    // --test-only in a child of the test runner.
    const context: any = process.env.NODE_TEST_CONTEXT;
    const isChild = context !== undefined && context !== null && String(context) !== "";
    __ntState.only = isChild ? __ntArgvHas("--test-only") : true;
    const patterns = __ntArgvValues("--test-name-pattern");
    if (Number(patterns.length) > 0) {
      __ntState.namePatterns = patterns.map((p: any) => __ntStringToRegExp(String(p), "--test-name-pattern"));
    }
    const skips = __ntArgvValues("--test-skip-pattern");
    if (Number(skips.length) > 0) {
      __ntState.skipPatterns = skips.map((p: any) => __ntStringToRegExp(String(p), "--test-skip-pattern"));
    }
    try {
      __ntState.file = process.argv[1];
    } catch (e) {}
    __ntState.startTime = __ntNow();
  }
  return __ntState.root;
}

// `internal/test_runner/utils`' `convertStringToRegExp`.
function __ntStringToRegExp(str: string, name: string): any {
  const match: any = /^\/(.*)\/([a-z]*)$/s.exec(str);
  const pattern: string = match === null ? str : String(match[1]);
  const flags: string = match === null ? "" : String(match[2]);
  // V8 reports a bad flag string with this exact text; it is checked here so
  // the message does not depend on the engine's own wording.
  for (let i = 0; i < flags.length; i++) {
    const f = flags.charAt(i);
    if ("dgimsuvy".indexOf(f) === -1 || flags.indexOf(f) !== i) {
      throw new ERR_INVALID_ARG_VALUE(
        name, str,
        "is an invalid regular expression. Invalid flags supplied to RegExp constructor '" + flags + "'",
      );
    }
  }
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    const msg = err !== null && err !== undefined && (err as any).message !== undefined ? String((err as any).message) : String(err);
    throw new ERR_INVALID_ARG_VALUE(name, str, "is an invalid regular expression. " + msg);
  }
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function __ntNewNode(kind: string, name: any, options: any, fn: any, parent: any): any {
  const node: any = {
    kind: kind,
    name: name,
    fn: fn,
    parent: parent,
    nesting: parent === null ? -1 : Number(parent.nesting) + 1,
    options: options,
    children: [],
    queue: [],
    active: 0,
    concurrency: 1,
    hooks: { before: [], after: [], beforeEach: [], afterEach: [] },
    beforeRan: false,
    beforePromise: null,
    skipped: false,
    skipMessage: undefined,
    isTodo: false,
    todoMessage: undefined,
    only: undefined,
    runOnlySubtests: false,
    timeout: Infinity,
    plan: null,
    error: null,
    passed: false,
    cancelled: false,
    started: false,
    finished: false,
    reportedStart: false,
    reported: false,
    reportedChildren: 0,
    failedSubtests: 0,
    startTime: 0,
    endTime: 0,
    diagnostics: [],
    ctx: null,
    mock: null,
    abortController: null,
    signal: null,
    done: __ntDeferred(),
    subtestsPending: 0,
    subtestsDone: null,
    buildSuite: null,
    loc: undefined,
    attempt: 0,
    filtered: false,
    hookType: undefined,
  };
  return node;
}

function __ntParseArgs(args: any[]): any {
  // Node's three signatures: (fn), (name, fn), (name, options, fn), plus
  // (options), (options, fn) and (name, options).
  let name: any = args[0];
  let options: any = args[1];
  let fn: any = args[2];
  if (__ntIsFn(name)) {
    fn = name;
    options = undefined;
    name = undefined;
  } else if (name !== null && typeof name === "object") {
    fn = options;
    options = name;
    name = undefined;
  }
  if (__ntIsFn(options)) {
    fn = options;
    options = undefined;
  }
  if (options === null || options === undefined) options = {};
  if (name === undefined || name === null || name === "") {
    if (fn !== undefined && fn !== null && __ntIsFn(fn)) {
      const fnName: any = fn.name;
      name = fnName !== undefined && fnName !== null && String(fnName) !== "" ? String(fnName) : "<anonymous>";
    } else {
      name = "<anonymous>";
    }
  } else if (typeof name !== "string") {
    name = String(name);
  }
  return { name: name, options: options, fn: fn };
}

function __ntApplyOptions(node: any, options: any): void {
  const parent: any = node.parent;
  const timeout: any = options.timeout;
  if (timeout === null || timeout === undefined) {
    node.timeout = parent !== null && parent.kind !== "root" ? parent.timeout : __ntDefaultTimeout();
  } else {
    if (typeof timeout !== "number") throw new ERR_INVALID_ARG_TYPE("options.timeout", "number", timeout);
    if (timeout !== Infinity) __ntValidateNumber(timeout, "options.timeout", 0, __NT_TIMEOUT_MAX);
    node.timeout = Number(timeout);
  }

  const concurrency: any = options.concurrency;
  if (concurrency === null || concurrency === undefined) {
    node.concurrency = parent !== null && parent.kind === "suite" ? parent.concurrency : 1;
  } else if (typeof concurrency === "boolean") {
    node.concurrency = concurrency ? Infinity : 1;
  } else if (typeof concurrency === "number") {
    __ntValidateUint32(concurrency, "options.concurrency", true);
    node.concurrency = Number(concurrency);
  } else {
    throw new ERR_INVALID_ARG_TYPE("options.concurrency", ["boolean", "number"], concurrency);
  }

  const signal: any = options.signal;
  if (signal !== undefined && signal !== null) {
    if (typeof signal !== "object" || signal.aborted === undefined) {
      throw new ERR_INVALID_ARG_TYPE("options.signal", "AbortSignal", signal);
    }
  }

  const plan: any = options.plan;
  if (plan !== undefined && plan !== null) {
    __ntValidateUint32(plan, "options.plan", false);
    node.expectedAssertions = Number(plan);
  }

  // Node's own tests: `skip !== undefined && skip !== false` (so `''` and
  // `null` both skip), and a todo parent makes every descendant todo.
  const skip: any = options.skip;
  if (skip !== undefined && skip !== false) {
    node.skipped = true;
    node.skipMessage = typeof skip === "string" && skip !== "" ? skip : undefined;
  }
  const todo: any = options.todo;
  if (todo !== undefined && todo !== false) {
    node.isTodo = true;
    node.todoMessage = typeof todo === "string" && todo !== "" ? todo : undefined;
  } else if (parent !== null && parent.kind !== "root" && parent.isTodo) {
    node.isTodo = true;
  }
  if (options.only === true) node.only = true;
  else if (options.only === false) node.only = false;

  // A skipped node with a todo flag reports as skipped (Node's
  // `if (skip) { ... } else if (todo)` order).
  if (node.skipped) node.isTodo = false;

  // Filtering, as in Node's Test constructor: a name-pattern match unfilters
  // every ancestor; an `only` test makes its parent run only `only`
  // subtests and marks the not-yet-started ancestors as having some. The
  // decision itself is `__ntApplyFilters`, taken when the node starts.
  if (parent !== null && node.kind !== "hook") {
    if (__ntState.namePatterns !== null || __ntState.skipPatterns !== null) {
      node.filteredByName = __ntWillBeFilteredByName(node);
      if (!node.filteredByName) {
        for (let t: any = parent; t !== null && t.filteredByName === true; t = t.parent) t.filteredByName = false;
      }
    }
    if (__ntState.only) {
      if (node.only === true) {
        parent.runOnlySubtests = true;
        if (parent.kind === "root" || !parent.started) {
          for (let t: any = parent; t !== null && t.hasOnlyTests !== true; t = t.parent) t.hasOnlyTests = true;
        }
      } else if (node.only === false) {
        node.fn = undefined;
      }
    } else if (options.only === true || parent.runOnlySubtests) {
      node.diagnostics.push("'only' and 'runOnly' require the --test-only command-line option.");
    }
  }

  const ac: any = new AbortController();
  node.abortController = ac;
  node.signal = ac.signal;
  if (signal !== undefined && signal !== null) {
    if (signal.aborted) {
      ac.abort(signal.reason);
    } else {
      signal.addEventListener("abort", () => {
        ac.abort(signal.reason);
      });
    }
  }
}

// `--test-timeout`: the timeout of a top-level test that sets none.
function __ntDefaultTimeout(): number {
  const values = __ntArgvValues("--test-timeout");
  if (Number(values.length) === 0) return Infinity;
  const n = Number(values[Number(values.length) - 1]);
  return n > 0 ? n : Infinity;
}

function __ntApplyFilters(node: any): void {
  if (node.error !== null) return;
  if (node.filteredByName === true) {
    node.filtered = true;
    return;
  }
  const parent: any = node.parent;
  if (__ntState.only && node.only !== true && node.hasOnlyTests !== true && parent !== null) {
    if (parent.runOnlySubtests || parent.hasOnlyTests === true || node.only === false) node.filtered = true;
  }
}

function __ntWillBeFilteredByName(node: any): boolean {
  if (__ntState.namePatterns !== null && !__ntMatchesPatterns(node, __ntState.namePatterns)) return true;
  if (__ntState.skipPatterns !== null && __ntMatchesPatterns(node, __ntState.skipPatterns)) return true;
  return false;
}

function __ntNameWithAncestors(node: any): string {
  if (node === null || node.parent === null) return "";
  return __ntNameWithAncestors(node.parent) + " " + String(node.name);
}

// `internal/test_runner/utils`' `testMatchesPattern`.
function __ntMatchesPatterns(node: any, patterns: any[]): boolean {
  for (const re of patterns) {
    re.lastIndex = 0;
    if (re.exec(String(node.name)) !== null) return true;
  }
  if (node.parent !== null && node.parent.kind !== "root" && __ntMatchesPatterns(node.parent, patterns)) return true;
  const full = __ntNameWithAncestors(node).trim();
  for (const re of patterns) {
    re.lastIndex = 0;
    if (re.exec(full) !== null) return true;
  }
  return false;
}

function __ntFullName(node: any): string {
  if (node.kind === "root") return "<root>";
  const parts: string[] = [];
  let cur: any = node;
  while (cur !== null && cur.kind !== "root") {
    parts.unshift(String(cur.name));
    cur = cur.parent;
  }
  return parts.join(" > ");
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------

class TestContext {
  _node: any;
  _assert: any;
  constructor(node: any) {
    this._node = node;
    this._assert = undefined;
  }
  get signal(): any {
    return this._node.signal;
  }
  get name(): any {
    return this._node.name;
  }
  get filePath(): any {
    return __ntState.file;
  }
  get fullName(): any {
    return __ntFullName(this._node);
  }
  get error(): any {
    return this._node.error === null ? null : this._node.error;
  }
  get passed(): any {
    return this._node.passed;
  }
  get attempt(): any {
    return this._node.attempt;
  }
  diagnostic(message: any): void {
    this._node.diagnostics.push(String(message));
  }
  plan(count: any, options?: any): void {
    if (this._node.plan !== null) {
      throw new ERR_TEST_FAILURE("cannot set plan more than once", __NT_kTestCodeFailure);
    }
    this._node.plan = __ntNewPlan(count, options === undefined ? {} : options);
  }
  get assert(): any {
    if (this._assert === undefined) this._assert = __ntBuildAssert(this);
    return this._assert;
  }
  get mock(): any {
    if (this._node.mock === null) this._node.mock = __ntNewMockTracker();
    return this._node.mock;
  }
  runOnly(value: any): void {
    this._node.runOnlySubtests = !!value;
  }
  skip(message?: any): void {
    this._node.skipped = true;
    this._node.skipMessage = message === undefined ? undefined : String(message);
  }
  todo(message?: any): void {
    this._node.isTodo = true;
    this._node.todoMessage = message === undefined ? undefined : String(message);
  }
  test(name?: any, options?: any, fn?: any): any {
    const node: any = this._node;
    if (node.plan !== null) __ntPlanCount(node.plan);
    return __ntCreateTest(node, [name, options, fn], "test");
  }
  before(fn: any, options?: any): void {
    __ntCreateHook(this._node, "before", fn, options);
  }
  after(fn: any, options?: any): void {
    __ntCreateHook(this._node, "after", fn, options);
  }
  beforeEach(fn: any, options?: any): void {
    __ntCreateHook(this._node, "beforeEach", fn, options);
  }
  afterEach(fn: any, options?: any): void {
    __ntCreateHook(this._node, "afterEach", fn, options);
  }
  waitFor(condition: any, options?: any): any {
    return __ntWaitFor(condition, options);
  }
}

class SuiteContext {
  _node: any;
  constructor(node: any) {
    this._node = node;
  }
  get signal(): any {
    return this._node.signal;
  }
  get name(): any {
    return this._node.name;
  }
  get filePath(): any {
    return __ntState.file;
  }
  get fullName(): any {
    return __ntFullName(this._node);
  }
}

function __ntContextOf(node: any): any {
  if (node.ctx === null) {
    node.ctx = node.kind === "suite" ? new SuiteContext(node) : new TestContext(node);
  }
  return node.ctx;
}

// `t.assert`: every `node:assert` export except the four Node leaves out,
// plus `snapshot`/`fileSnapshot` and whatever `assert.register` added, each
// counting towards the test's plan and called with `this` = the context.
const __NT_UNCOPIED_ASSERT_KEYS: string[] = ["AssertionError", "strict", "Assert", "options", "CallTracker"];

function __ntAssertMap(): any {
  const map: any = {};
  const names: string[] = [];
  const keys: any[] = Object.keys(__node_assert);
  for (const key of keys) {
    const k = String(key);
    if (__NT_UNCOPIED_ASSERT_KEYS.indexOf(k) !== -1) continue;
    const v: any = (__node_assert as any)[k];
    if (!__ntIsFn(v)) continue;
    if (names.indexOf(k) === -1) names.push(k);
    map[k] = v;
  }
  for (const extra of ["snapshot", "fileSnapshot"]) {
    if (names.indexOf(extra) === -1) names.push(extra);
    map[extra] = extra === "snapshot" ? __ntSnapshotAssert : __ntFileSnapshotAssert;
  }
  for (const entry of __ntState.customAsserts) {
    const k = String(entry.name);
    if (names.indexOf(k) === -1) names.push(k);
    map[k] = entry.fn;
  }
  return { map: map, names: names };
}

function __ntBuildAssert(ctx: any): any {
  const built: any = __ntAssertMap();
  const out: any = {};
  for (const name of built.names) {
    const method: any = built.map[name];
    out[name] = function (...args: any[]): any {
      const plan: any = ctx._node.plan;
      if (plan !== null) __ntPlanCount(plan);
      return __ntCall(method, ctx, args);
    };
  }
  return out;
}

function __ntSnapshotAssert(value?: any, options?: any): any {
  throw new ERR_METHOD_NOT_IMPLEMENTED("t.assert.snapshot()");
}

function __ntFileSnapshotAssert(value?: any, path?: any, options?: any): any {
  throw new ERR_METHOD_NOT_IMPLEMENTED("t.assert.fileSnapshot()");
}

const __node_test_assert: any = {
  register(name: any, fn: any): void {
    if (typeof name !== "string") throw new ERR_INVALID_ARG_TYPE("name", "string", name);
    __ntValidateFunction(fn, "fn");
    const list: any[] = __ntState.customAsserts;
    const n = Number(list.length);
    for (let i = 0; i < n; i++) {
      if (String(list[i].name) === name) {
        list[i].fn = fn;
        return;
      }
    }
    list.push({ name: name, fn: fn });
  },
};

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

function __ntNewPlan(count: any, options: any): any {
  __ntValidateUint32(count, "count", false);
  __ntValidateObject(options, "options");
  const plan: any = { expected: Number(count), actual: 0, wait: undefined, waitForever: false, pending: null, timer: null };
  const wait: any = options.wait;
  if (typeof wait === "boolean") {
    plan.wait = wait;
    plan.waitForever = wait;
  } else if (typeof wait === "number") {
    __ntValidateNumber(wait, "options.wait", 0, __NT_TIMEOUT_MAX);
    plan.wait = wait;
  } else if (wait !== undefined) {
    throw new ERR_INVALID_ARG_TYPE("options.wait", ["boolean", "number"], wait);
  }
  return plan;
}

function __ntPlanCount(plan: any): void {
  plan.actual = Number(plan.actual) + 1;
  if (plan.pending !== null) __ntPlanCheck(plan);
}

function __ntPlanCheck(plan: any): any {
  if (Number(plan.actual) === Number(plan.expected)) {
    if (plan.timer !== null) {
      __timerRealClearTimeout(plan.timer);
      plan.timer = null;
    }
    if (plan.pending !== null) {
      const resolve: any = plan.pending.resolve;
      plan.pending = null;
      resolve(undefined);
    }
    return undefined;
  }
  const shouldWait = plan.wait !== undefined && plan.wait !== false;
  if (!shouldWait) {
    throw new ERR_TEST_FAILURE(
      "plan expected " + String(plan.expected) + " assertions but received " + String(plan.actual),
      __NT_kTestCodeFailure,
    );
  }
  if (plan.pending === null) {
    plan.pending = __ntDeferred();
    if (!plan.waitForever) {
      const pending: any = plan.pending;
      plan.timer = __timerRealSetTimeout(() => {
        pending.reject(new ERR_TEST_FAILURE(
          "plan timed out after " + String(plan.wait) + "ms with " + String(plan.actual) +
            " assertions when expecting " + String(plan.expected),
          __NT_kTestTimeoutFailure,
        ));
      }, plan.wait);
    }
  }
  return plan.pending.promise;
}

// ---------------------------------------------------------------------------
// waitFor
// ---------------------------------------------------------------------------

function __ntWaitFor(condition: any, options?: any): any {
  __ntValidateFunction(condition, "condition");
  const opts: any = options === undefined ? {} : options;
  __ntValidateObject(opts, "options");
  const interval: any = opts.interval === undefined ? 50 : opts.interval;
  const timeout: any = opts.timeout === undefined ? 1000 : opts.timeout;
  __ntValidateNumber(interval, "options.interval", 0, __NT_TIMEOUT_MAX);
  __ntValidateNumber(timeout, "options.timeout", 0, __NT_TIMEOUT_MAX);

  const d: any = __ntDeferred();
  const state: any = { cause: undefined, hasCause: false, poller: null, timer: null, done: false };
  const finish = (err: any, isError: boolean, result: any): void => {
    if (state.done) return;
    state.done = true;
    if (state.poller !== null) __timerRealClearTimeout(state.poller);
    if (state.timer !== null) __timerRealClearTimeout(state.timer);
    if (isError) d.reject(err);
    else d.resolve(result);
  };
  state.timer = __timerRealSetTimeout(() => {
    const err: any = new Error("waitFor() timed out");
    if (state.hasCause) err.cause = state.cause;
    finish(err, true, undefined);
  }, timeout);
  const poll = async (): Promise<any> => {
    try {
      const result: any = await __ntCall(condition, undefined, []);
      finish(undefined, false, result);
    } catch (err) {
      state.cause = err;
      state.hasCause = true;
      if (!state.done) state.poller = __timerRealSetTimeout(() => { poll(); }, interval);
    }
  };
  poll();
  return d.promise;
}

// ---------------------------------------------------------------------------
// Creating tests, suites and hooks
// ---------------------------------------------------------------------------

function __ntCurrentParent(): any {
  const current: any = __ntState.current;
  if (current !== null && current !== undefined) return current;
  return __ntRoot();
}

function __ntCreateTest(parent: any, args: any[], kind: string): any {
  const parsed: any = __ntParseArgs(args);
  const node: any = __ntNewNode(kind, parsed.name, parsed.options, parsed.fn, parent);
  __ntApplyOptions(node, parsed.options);
  if (kind === "suite") {
    __ntBuildSuite(node);
  }
  if (parent.finished && parent.kind !== "root") {
    // Node: a subtest created after its parent finished fails at once.
    node.error = new ERR_TEST_FAILURE(
      "test could not be started because its parent finished",
      __NT_kParentAlreadyFinished,
    );
  }
  parent.children.push(node);
  return __ntEnqueue(parent, node);
}

function __ntBuildSuite(node: any): void {
  if (node.skipped || !__ntIsFn(node.fn)) {
    node.buildSuite = Promise.resolve(undefined);
    return;
  }
  const saved: any = __ntState.current;
  __ntState.current = node;
  try {
    const sctx: any = __ntContextOf(node);
    const ret: any = __ntCall(node.fn, sctx, [sctx]);
    if (__ntIsPromise(ret)) {
      node.buildSuite = Promise.resolve(ret).then(
        (v: any) => undefined,
        (err: any) => {
          node.error = new ERR_TEST_FAILURE(err, __NT_kTestCodeFailure);
          return undefined;
        },
      );
    } else {
      node.buildSuite = Promise.resolve(undefined);
    }
  } catch (err) {
    node.error = new ERR_TEST_FAILURE(err, __NT_kTestCodeFailure);
    node.buildSuite = Promise.resolve(undefined);
  }
  __ntState.current = saved;
}

function __ntCreateHook(parent: any, hookType: string, fn: any, options: any): void {
  __ntValidateFunction(fn, "fn");
  const opts: any = options === undefined || options === null ? {} : options;
  const hook: any = __ntNewNode("hook", "<" + hookType + ">", opts, fn, parent);
  hook.hookType = hookType;
  hook.nesting = parent.nesting;
  __ntApplyOptions(hook, opts);
  hook.skipped = false;
  hook.isTodo = false;
  hook.filtered = false;
  hook.ran = false;
  if (hookType === "before" && parent.started && parent.kind !== "root" && parent.kind !== "suite") {
    // `t.before()` registered from inside a running test applies to its
    // subtests; nothing to do now.
  }
  parent.hooks[hookType].push(hook);
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

function __ntEnqueue(parent: any, node: any): any {
  parent.queue.push(node);
  if (parent.kind === "test" || parent.kind === "root") {
    parent.subtestsPending = Number(parent.subtestsPending) + 1;
  }
  if (parent.kind === "root") {
    __ntScheduleRoot();
  } else if (parent.kind === "test" && parent.started) {
    __ntPump(parent);
  }
  return node.done.promise;
}

function __ntPump(parent: any): void {
  while (Number(parent.queue.length) > 0 && Number(parent.active) < Number(parent.concurrency)) {
    const next: any = parent.queue.shift();
    parent.active = Number(parent.active) + 1;
    __ntStart(parent, next);
  }
}

function __ntStart(parent: any, node: any): void {
  const run: any = node.kind === "suite" ? __ntRunSuite(node) : __ntRunTest(node);
  run.then(
    (v: any) => __ntAfterChild(parent, node),
    (err: any) => {
      if (node.error === null) node.error = new ERR_TEST_FAILURE(err, __NT_kTestCodeFailure);
      __ntAfterChild(parent, node);
    },
  );
}

function __ntAfterChild(parent: any, node: any): void {
  parent.active = Number(parent.active) - 1;
  if (parent.kind === "test" || parent.kind === "root") {
    parent.subtestsPending = Number(parent.subtestsPending) - 1;
  }
  node.done.resolve(undefined);
  __ntPump(parent);
  if (Number(parent.subtestsPending) === 0 && parent.subtestsDone !== null) {
    const d: any = parent.subtestsDone;
    parent.subtestsDone = null;
    d.resolve(undefined);
  }
  if (parent.kind === "root") __ntMaybeFinishRoot();
}

function __ntScheduleRoot(): void {
  if (__ntState.rootScheduled) return;
  __ntState.rootScheduled = true;
  __ntInstallReporter();
  // Node bootstraps the harness asynchronously, so a file's synchronous part
  // (every top-level `test()` call) runs before the first test body.
  __timerRealSetImmediate(() => {
    const root: any = __ntRoot();
    root.started = true;
    root.startTime = __ntNow();
    __ntPump(root);
    __ntMaybeFinishRoot();
  });
}

function __ntMaybeFinishRoot(): void {
  const root: any = __ntRoot();
  if (__ntState.finished || __ntState.finishing) return;
  if (Number(root.active) > 0 || Number(root.queue.length) > 0) return;
  __ntState.finishing = true;
  // One more turn, so a test registered from a callback still gets to run.
  __ntTick().then((v: any) => {
    __ntState.finishing = false;
    if (Number(root.active) > 0 || Number(root.queue.length) > 0) {
      __ntPump(root);
      return;
    }
    __ntFinishRoot();
  });
}

async function __ntFinishRoot(): Promise<any> {
  const root: any = __ntRoot();
  if (__ntState.finished) return;
  __ntState.finished = true;
  try {
    await __ntRunHooks(root, "after", root);
  } catch (err) {
    root.error = err;
  }
  root.finished = true;
  __ntReportRoot(root);
  // `--test-force-exit`: once every known test and hook has finished, exit
  // regardless of ref'd handles (and of timers that would fail later).
  if (__ntArgvHas("--test-force-exit")) process.exit();
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function __ntRunHooks(owner: any, hookType: string, target: any): Promise<any> {
  const list: any[] = owner.hooks[hookType];
  const n = Number(list.length);
  for (let i = 0; i < n; i++) {
    const hook: any = list[i];
    await __ntRunHook(hook, target);
  }
}

async function __ntRunHook(hook: any, target: any): Promise<any> {
  const ctx: any = __ntContextOf(target);
  const fn: any = hook.fn;
  try {
    let ret: any;
    if (Number(fn.length) >= 2) {
      const cb: any = __ntDeferred();
      ret = __ntCall(fn, ctx, [ctx, (err: any) => {
        if (err !== undefined && err !== null) cb.reject(err);
        else cb.resolve(undefined);
      }]);
      await __ntWithTimeout(cb.promise, hook.timeout);
    } else {
      ret = __ntCall(fn, ctx, [ctx]);
      if (__ntIsPromise(ret)) await __ntWithTimeout(ret, hook.timeout);
    }
  } catch (err) {
    if (__ntIsTestFailure(err) && (err as any).failureType === __NT_kTestTimeoutFailure) throw err;
    throw new ERR_TEST_FAILURE(err, __NT_kHookFailure);
  }
}

// `parent.runHook('before')` happens once per parent, no matter how many
// children ask for it.
async function __ntRunBeforeOnce(parent: any): Promise<any> {
  if (Number(parent.hooks.before.length) === 0) return;
  if (parent.beforePromise === null) {
    parent.beforePromise = __ntRunHooks(parent, "before", parent);
  }
  await parent.beforePromise;
}

function __ntInheritedHooks(node: any, hookType: string): any[] {
  // beforeEach: outermost first; afterEach: innermost first.
  const chain: any[] = [];
  let cur: any = node.parent;
  while (cur !== null) {
    chain.push(cur);
    cur = cur.parent;
  }
  const out: any[] = [];
  if (hookType === "beforeEach") {
    for (let i = Number(chain.length) - 1; i >= 0; i--) {
      for (const h of chain[i].hooks.beforeEach) out.push(h);
    }
  } else {
    for (let i = 0; i < Number(chain.length); i++) {
      for (const h of chain[i].hooks.afterEach) out.push(h);
    }
  }
  return out;
}

function __ntWithTimeout(promise: any, timeout: any): any {
  const ms = Number(timeout);
  if (ms === Infinity || ms !== ms) return promise;
  return new Promise((resolve: any, reject: any) => {
    const timer: any = __timerRealSetTimeout(() => {
      reject(new ERR_TEST_FAILURE("test timed out after " + String(ms) + "ms", __NT_kTestTimeoutFailure));
    }, ms);
    Promise.resolve(promise).then(
      (v: any) => {
        __timerRealClearTimeout(timer);
        resolve(v);
      },
      (e: any) => {
        __timerRealClearTimeout(timer);
        reject(e);
      },
    );
  });
}

function __ntShouldAbort(node: any): boolean {
  if (node.signal !== null && node.signal.aborted) {
    if (node.error === null) {
      node.error = new ERR_TEST_FAILURE("This operation was aborted", __NT_kAborted);
      node.cancelled = true;
    }
    return true;
  }
  return false;
}

async function __ntRunTest(node: any): Promise<any> {
  const parent: any = node.parent;
  __ntApplyFilters(node);
  node.started = true;
  node.startTime = __ntNow();
  __ntEmitStart(node);

  if (node.error !== null || node.filtered) {
    node.finished = true;
    node.endTime = __ntNow();
    __ntReport(node);
    return;
  }

  if (__ntShouldAbort(node)) {
    node.finished = true;
    node.endTime = __ntNow();
    __ntReport(node);
    return;
  }

  const ctx: any = __ntContextOf(node);
  if (node.plan === null && node.expectedAssertions !== undefined) ctx.plan(node.expectedAssertions);

  let afterEachRan = false;
  const runAfterEach = async (): Promise<any> => {
    if (afterEachRan) return;
    afterEachRan = true;
    if (node.skipped) return;
    for (const h of __ntInheritedHooks(node, "afterEach")) await __ntRunHook(h, node);
  };
  const runAfter = async (): Promise<any> => {
    await __ntRunHooks(node, "after", node);
  };

  try {
    await __ntRunBeforeOnce(parent);
    if (!node.skipped) {
      for (const h of __ntInheritedHooks(node, "beforeEach")) await __ntRunHook(h, node);
    }

    if (!node.skipped && __ntIsFn(node.fn)) {
      const saved: any = __ntState.current;
      __ntState.current = node;
      let produced: any;
      try {
        if (Number(node.fn.length) >= 2) {
          // Error-first callback style.
          const cb: any = __ntDeferred();
          let calls = 0;
          const done = (err?: any): void => {
            calls = calls + 1;
            if (calls > 1) {
              node.extraCallbackError = new ERR_TEST_FAILURE(
                "callback invoked multiple times",
                __NT_kMultipleCallbackInvocations,
              );
              return;
            }
            if (err !== undefined && err !== null) cb.reject(err);
            else cb.resolve(undefined);
          };
          const ret: any = __ntCall(node.fn, ctx, [ctx, done]);
          if (__ntIsPromise(ret)) {
            Promise.resolve(ret).then(undefined, (e: any) => undefined);
            throw new ERR_TEST_FAILURE("passed a callback but also returned a Promise", __NT_kCallbackAndPromisePresent);
          }
          produced = cb.promise;
        } else {
          produced = __ntCall(node.fn, ctx, [ctx]);
        }
      } finally {
        __ntState.current = saved;
      }
      // Subtests started synchronously by the body may now run.
      __ntPump(node);
      if (__ntIsPromise(produced)) {
        await __ntWithTimeout(produced, node.timeout);
      } else {
        await null;
      }
    } else {
      __ntPump(node);
    }

    __ntShouldAbort(node);
    if (node.error !== null) throw node.error;

    // Wait for the subtests this test started.
    if (Number(node.subtestsPending) > 0) {
      node.subtestsDone = __ntDeferred();
      __ntPump(node);
      await __ntWithTimeout(node.subtestsDone.promise, node.timeout);
    }

    if (node.plan !== null) {
      const planPromise: any = __ntPlanCheck(node.plan);
      if (planPromise !== undefined) await __ntWithTimeout(planPromise, node.timeout);
    }
    if (node.extraCallbackError !== undefined) throw node.extraCallbackError;

    node.passed = true;
    await runAfterEach();
    await runAfter();
  } catch (err) {
    node.passed = false;
    if (__ntIsTestFailure(err)) {
      node.error = err;
      if ((err as any).failureType === __NT_kTestTimeoutFailure) node.cancelled = true;
    } else {
      node.error = new ERR_TEST_FAILURE(err, __NT_kTestCodeFailure);
    }
    try { await runAfterEach(); } catch (e) {}
    try { await runAfter(); } catch (e) {}
  }
  node.abortController.abort();
  if (node.mock !== null) {
    try { node.mock.reset(); } catch (e) {}
  }
  node.finished = true;
  node.endTime = __ntNow();

  // A test that did not wait for its subtests: cancel those still queued.
  __ntCancelPending(node);
  __ntReport(node);
}

function __ntCancelPending(node: any): void {
  while (Number(node.queue.length) > 0) {
    const child: any = node.queue.shift();
    child.error = new ERR_TEST_FAILURE("test did not finish before its parent and was cancelled", __NT_kCancelledByParent);
    child.cancelled = true;
    child.started = true;
    child.finished = true;
    __ntEmitStart(child);
    __ntReport(child);
    node.subtestsPending = Number(node.subtestsPending) - 1;
    child.done.resolve(undefined);
  }
}

async function __ntRunSuite(node: any): Promise<any> {
  const parent: any = node.parent;
  node.started = true;
  await node.buildSuite;
  __ntApplyFilters(node);
  if (node.filtered) {
    node.queue = [];
    node.finished = true;
    __ntReport(node);
    return;
  }
  node.startTime = __ntNow();
  __ntEmitStart(node);

  if (__ntShouldAbort(node)) {
    node.queue = [];
    node.finished = true;
    __ntReport(node);
    return;
  }

  try {
    await __ntRunBeforeOnce(parent);
    if (node.error !== null) throw node.error;
    await __ntRunBeforeOnce(node);
    if (!node.skipped) {
      const all: any[] = [];
      for (const child of node.queue) all.push(child.done.promise);
      __ntPump(node);
      await __ntWithTimeout(Promise.all(all), node.timeout);
      // Children declared while the suite was running.
      while (Number(node.queue.length) > 0 || Number(node.active) > 0) {
        const more: any[] = [];
        for (const child of node.queue) more.push(child.done.promise);
        __ntPump(node);
        if (Number(more.length) === 0) await __ntTick();
        else await Promise.all(more);
      }
    } else {
      node.queue = [];
    }
    await __ntRunHooks(node, "after", node);
    node.passed = true;
  } catch (err) {
    try { await __ntRunHooks(node, "after", node); } catch (e) {}
    node.passed = false;
    node.error = __ntIsTestFailure(err) ? err : new ERR_TEST_FAILURE(err, __NT_kTestCodeFailure);
  }
  node.finished = true;
  node.endTime = __ntNow();
  __ntReport(node);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function __ntEmit(type: string, data: any): void {
  const sinks: any[] = __ntState.sinks;
  for (const sink of sinks) {
    try {
      sink(type, data);
    } catch (e) {}
  }
}

function __ntLoc(node: any, data: any): void {
  if (__ntState.file !== undefined) data.file = __ntState.file;
}

// Reports go out in declaration order whatever the concurrency, as in Node
// (`Test#isClearToSend` / `readySubtests`): a node may emit its `test:start`
// only once its parent has, and its result only once every earlier sibling
// has reported; until then a finished node waits (`pendingReport`).
function __ntCanSend(node: any): boolean {
  const parent: any = node.parent;
  if (parent === null) return true;
  if (parent.kind !== "root" && !parent.reportedStart) return false;
  for (const sibling of parent.children) {
    if (sibling === node) return true;
    if (!sibling.reported) return false;
  }
  return true;
}

function __ntEmitStart(node: any): void {
  if (node.reportedStart) return;
  if (!__ntCanSend(node)) return;
  node.reportedStart = true;
  if (!node.filtered) {
    const data: any = { name: node.name, nesting: node.nesting };
    __ntLoc(node, data);
    __ntEmit("test:start", data);
  }
  __ntFlushChildren(node);
}

// Report the leading run of `parent`'s children that are ready, and start
// the first one still running.
function __ntFlushChildren(parent: any): void {
  if (parent.kind !== "root" && !parent.reportedStart) return;
  for (const child of parent.children) {
    if (child.reported) continue;
    if (child.pendingReport) {
      __ntReport(child);
      if (!child.reported) return;
      continue;
    }
    if (child.started) __ntEmitStart(child);
    return;
  }
}

function __ntDuration(node: any): number {
  const end = Number(node.endTime) > 0 ? Number(node.endTime) : __ntNow();
  const d = end - Number(node.startTime);
  return Math.max(0, Math.round(d * 1000000) / 1000000);
}

function __ntReport(node: any): void {
  if (node.reported) return;
  if (!__ntCanSend(node)) {
    node.pendingReport = true;
    return;
  }
  // Starting the report also reports the children that were waiting on it.
  __ntEmitStart(node);
  node.reported = true;
  node.pendingReport = false;
  const parent: any = node.parent;

  // A failed subtest makes its parent fail with `N subtest(s) failed`.
  if (node.error === null && node.kind !== "hook") {
    let failed = 0;
    for (const child of node.children) {
      if (!child.passed && !child.skipped && !child.isTodo && child.finished && !child.filtered) failed++;
    }
    if (failed > 0) {
      node.passed = false;
      node.error = new ERR_TEST_FAILURE(
        String(failed) + " subtest" + (failed > 1 ? "s" : "") + " failed",
        __NT_kSubtestsFailed,
      );
    }
  }
  if (node.error !== null) node.passed = false;
  else if (node.kind !== "hook") node.passed = true;

  if (node.filtered) {
    __ntFlushChildren(parent);
    return;
  }

  const counters: any = __ntState.counters;
  const reportedType = node.kind === "suite" ? "suite" : "test";
  if (reportedType === "suite") {
    counters.suites = Number(counters.suites) + 1;
    if (!node.passed) __ntState.success = false;
  } else {
    if (node.nesting === 0) counters.topLevel = Number(counters.topLevel) + 1;
    if (node.skipped) counters.skipped = Number(counters.skipped) + 1;
    else if (node.isTodo) counters.todo = Number(counters.todo) + 1;
    else if (node.cancelled) counters.cancelled = Number(counters.cancelled) + 1;
    else if (!node.passed) counters.failed = Number(counters.failed) + 1;
    else counters.passed = Number(counters.passed) + 1;
    counters.tests = Number(counters.tests) + 1;
  }
  if (node.nesting === 0) counters.all = Number(counters.all) + 1;

  // The plan line of a node with reported children comes before its result.
  if (Number(node.reportedChildren) > 0) {
    __ntEmit("test:plan", { nesting: Number(node.nesting) + 1, count: node.reportedChildren, file: __ntState.file });
  }

  parent.reportedChildren = Number(parent.reportedChildren) + 1;
  const details: any = { passed: node.passed, duration_ms: __ntDuration(node), type: reportedType };
  if (node.error !== null) details.error = node.error;
  const data: any = {
    name: node.name,
    nesting: node.nesting,
    testNumber: parent.reportedChildren,
    details: details,
  };
  if (node.skipped) data.skip = node.skipMessage === undefined ? true : node.skipMessage;
  else if (node.isTodo) data.todo = node.todoMessage === undefined ? true : node.todoMessage;
  __ntLoc(node, data);
  __ntEmit(node.passed ? "test:pass" : "test:fail", data);
  __ntEmit("test:complete", Object.assign({}, data, { passed: node.passed }));
  for (const message of node.diagnostics) {
    __ntEmit("test:diagnostic", { nesting: node.nesting, message: message, file: __ntState.file });
  }
  // The next sibling may have been waiting on this one.
  __ntFlushChildren(parent);
}

function __ntReportRoot(root: any): void {
  const counters: any = __ntState.counters;
  const duration = __ntNow() - Number(__ntState.startTime);
  let success = Number(counters.failed) === 0 && Number(counters.cancelled) === 0 && __ntState.success !== false;
  if (root.error !== null) success = false;
  if (root.error !== null) {
    __ntEmit("test:diagnostic", { nesting: 0, message: "Error: " + __ntFailureMessage(root.error), level: "error" });
  }
  __ntEmit("test:plan", { nesting: 0, count: root.reportedChildren, file: __ntState.file });
  const lines: any[] = [
    ["tests", counters.tests], ["suites", counters.suites], ["pass", counters.passed],
    ["fail", counters.failed], ["cancelled", counters.cancelled], ["skipped", counters.skipped],
    ["todo", counters.todo], ["duration_ms", Math.round(duration * 1000) / 1000],
  ];
  for (const pair of lines) {
    __ntEmit("test:diagnostic", { nesting: 0, message: String(pair[0]) + " " + String(pair[1]), level: "info" });
  }
  __ntEmit("test:summary", {
    success: success,
    counts: {
      tests: counters.tests, suites: counters.suites, passed: counters.passed, failed: counters.failed,
      cancelled: counters.cancelled, skipped: counters.skipped, todo: counters.todo, topLevel: counters.topLevel,
    },
    duration_ms: duration,
    file: undefined,
  });
  __ntEmit("__end", {});
  if (!success) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Reporters
// ---------------------------------------------------------------------------

function __ntWrite(text: string): void {
  if (text === "") return;
  process.stdout.write(text);
}

function __ntReporterName(): string {
  const env: any = process.env.NODE_TEST_CONTEXT;
  if (env !== undefined && env !== null && String(env) !== "") return "__child";
  const names = __ntArgvValues("--test-reporter");
  if (Number(names.length) > 0) return String(names[0]);
  return "spec";
}

function __ntInstallReporter(): void {
  if (__ntState.reporterInstalled) return;
  __ntState.reporterInstalled = true;
  if (__ntState.suppressDefaultReporter) return;
  const name = __ntReporterName();
  __ntState.sinks.push(__ntMakeReporter(name, __ntWrite));
}

function __ntMakeReporter(name: string, write: any): any {
  if (name === "tap") return __ntTapReporter(write);
  if (name === "dot") return __ntDotReporter(write);
  if (name === "__child") return __ntChildReporter(write);
  return __ntSpecReporter(write);
}

function __ntIndent(n: number, unit: string): string {
  let s = "";
  for (let i = 0; i < n; i++) s = s + unit;
  return s;
}

function __ntTapEscape(input: string): string {
  let result = input.split("\\").join("\\\\");
  result = result.split("\b").join("\\b");
  result = result.split("\f").join("\\f");
  result = result.split("\t").join("\\t");
  result = result.split("\n").join("\\n");
  result = result.split("\r").join("\\r");
  result = result.split("\v").join("\\v");
  result = result.split("#").join("\\#");
  return result;
}

function __ntYamlString(value: string): string {
  if (value.indexOf("\n") !== -1 || value.indexOf("'") !== -1 || value.indexOf(":") !== -1 || value.indexOf("#") !== -1) {
    return "'" + value.split("'").join("''") + "'";
  }
  return "'" + value + "'";
}

function __ntTapDetails(nesting: number, details: any, location: any): string {
  const ind = __ntIndent(nesting, "    ");
  let out = ind + "  ---\n";
  if (details !== undefined && details !== null) {
    if (details.duration_ms !== undefined) out = out + ind + "  duration_ms: " + String(details.duration_ms) + "\n";
    if (details.type !== undefined) out = out + ind + "  type: '" + String(details.type) + "'\n";
    if (location !== null) out = out + ind + "  location: " + __ntYamlString(String(location)) + "\n";
    const error: any = details.error;
    if (error !== undefined && error !== null) {
      const cause: any = error.code === "ERR_TEST_FAILURE" && error.cause !== undefined ? error.cause : error;
      if (error.failureType !== undefined) out = out + ind + "  failureType: '" + String(error.failureType) + "'\n";
      const msg = cause !== null && cause !== undefined && typeof cause === "object" && cause.message !== undefined
        ? String(cause.message) : __ntFailureMessage(cause);
      const lines = msg.split("\n");
      if (Number(lines.length) > 1) {
        out = out + ind + "  error: |-\n";
        for (const l of lines) out = out + ind + "    " + l + "\n";
      } else {
        out = out + ind + "  error: " + __ntYamlString(msg) + "\n";
      }
      if (cause !== null && cause !== undefined && typeof cause === "object") {
        const code: any = cause.code !== undefined ? cause.code : error.code;
        if (code !== undefined) out = out + ind + "  code: '" + String(code) + "'\n";
        if (cause.name !== undefined && cause.name !== "Error") out = out + ind + "  name: '" + String(cause.name) + "'\n";
        if (cause.expected !== undefined) out = out + ind + "  expected: " + __ntInspect(cause.expected) + "\n";
        if (cause.actual !== undefined) out = out + ind + "  actual: " + __ntInspect(cause.actual) + "\n";
        if (cause.operator !== undefined) out = out + ind + "  operator: '" + String(cause.operator) + "'\n";
        const stack: any = cause.stack;
        if (typeof stack === "string") {
          const frames: string[] = [];
          for (const l of stack.split("\n")) {
            if (/^\s+at /.test(l)) frames.push(l.replace(/^\s+at /, ""));
          }
          if (Number(frames.length) > 0) {
            out = out + ind + "  stack: |-\n";
            for (const f of frames) out = out + ind + "    " + f + "\n";
          }
        }
      } else {
        out = out + ind + "  code: 'ERR_TEST_FAILURE'\n";
      }
    }
  }
  out = out + ind + "  ...\n";
  return out;
}

function __ntTapReporter(write: any): any {
  write("TAP version 13\n");
  return (type: string, data: any): void => {
    if (type === "test:start") {
      write(__ntIndent(Number(data.nesting), "    ") + "# Subtest: " + __ntTapEscape(String(data.name)) + "\n");
    } else if (type === "test:pass" || type === "test:fail") {
      let line = __ntIndent(Number(data.nesting), "    ") + (type === "test:pass" ? "ok " : "not ok ") + String(data.testNumber);
      if (data.name !== undefined && data.name !== "") line = line + " " + __ntTapEscape("- " + String(data.name));
      if (data.skip !== undefined) {
        line = line + " # SKIP" + (typeof data.skip === "string" && data.skip.length > 0 ? " " + __ntTapEscape(data.skip) : "");
      } else if (data.todo !== undefined) {
        line = line + " # TODO" + (typeof data.todo === "string" && data.todo.length > 0 ? " " + __ntTapEscape(data.todo) : "");
      }
      write(line + "\n");
      const location: any = type === "test:fail" && data.file !== undefined && data.line !== undefined
        ? String(data.file) + ":" + String(data.line) + ":" + String(data.column) : null;
      write(__ntTapDetails(Number(data.nesting), data.details, location));
    } else if (type === "test:plan") {
      write(__ntIndent(Number(data.nesting), "    ") + "1.." + String(data.count) + "\n");
    } else if (type === "test:diagnostic") {
      write(__ntIndent(Number(data.nesting), "    ") + "# " + __ntTapEscape(String(data.message)) + "\n");
    } else if (type === "test:stdout" || type === "test:stderr") {
      for (const l of String(data.message).split(/\r?\n/)) {
        if (l.length === 0) continue;
        write("# " + __ntTapEscape(l) + "\n");
      }
    }
  };
}

function __ntFormatError(error: any, indent: string): string {
  if (error === undefined || error === null) return "";
  const err: any = error.code === "ERR_TEST_FAILURE" && error.cause !== undefined ? error.cause : error;
  const message = __ntInspect(err).split(/\r?\n/).join("\n" + indent + "  ");
  return "\n" + indent + "  " + message + "\n";
}

function __ntFormatTestReport(type: string, data: any, prefix: string, indent: string, hasChildren: boolean, showErrorDetails: boolean): string {
  let symbol = type === "test:fail" ? "✖ " : type === "test:pass" ? "✔ " : " ";
  const details: any = data.details;
  const duration = details !== undefined && details !== null && details.duration_ms ? " (" + String(details.duration_ms) + "ms)" : "";
  let title = String(data.name) + duration;
  const skip: any = data.skip;
  const todo: any = data.todo;
  if (skip !== undefined) {
    title = title + " # " + (typeof skip === "string" && skip.length > 0 ? skip : "SKIP");
  } else if (todo !== undefined) {
    title = title + " # " + (typeof todo === "string" && todo.length > 0 ? todo : "TODO");
  }
  const errObj: any = details !== undefined && details !== null ? details.error : undefined;
  const error = showErrorDetails ? __ntFormatError(errObj, indent) : "";
  let err = error;
  if (hasChildren) {
    err = error === "" || (errObj !== undefined && errObj !== null && errObj.failureType === __NT_kSubtestsFailed) ? "" : "\n" + error;
  }
  if (skip !== undefined) symbol = "﹣ ";
  return prefix + indent + symbol + title + err;
}

function __ntSpecReporter(write: any): any {
  const state: any = { stack: [], reported: [], failed: [] };
  const handleReport = (type: string, data: any): string => {
    state.stack.shift();
    let prefix = "";
    while (Number(state.stack.length) > 0) {
      const parent: any = state.stack.pop();
      state.reported.unshift(parent);
      prefix = prefix + __ntIndent(Number(parent.nesting), "  ") + "▶ " + String(parent.name) + "\n";
    }
    let hasChildren = false;
    const first: any = state.reported[0];
    if (first !== undefined && Number(first.nesting) === Number(data.nesting) && String(first.name) === String(data.name)) {
      state.reported.shift();
      hasChildren = true;
    }
    return __ntFormatTestReport(type, data, prefix, __ntIndent(Number(data.nesting), "  "), hasChildren, false) + "\n";
  };
  const failingList = (): string => {
    if (Number(state.failed.length) === 0) return "";
    const results: string[] = ["\n✖ failing tests:\n"];
    for (const t of state.failed) {
      if (t.file !== undefined && t.line !== undefined) {
        results.push("test at " + String(t.file) + ":" + String(t.line) + ":" + String(t.column));
      }
      results.push(__ntFormatTestReport("test:fail", t, "", "", false, true));
    }
    state.failed = [];
    return results.join("\n");
  };
  return (type: string, data: any): void => {
    if (type === "test:fail") {
      const e: any = data.details !== undefined ? data.details.error : undefined;
      if (e === undefined || e === null || e.failureType !== __NT_kSubtestsFailed) state.failed.push(data);
      write(handleReport(type, data));
    } else if (type === "test:pass") {
      write(handleReport(type, data));
    } else if (type === "test:start") {
      state.stack.unshift({ name: data.name, nesting: data.nesting });
    } else if (type === "test:stdout" || type === "test:stderr") {
      write(String(data.message));
    } else if (type === "test:diagnostic") {
      write(__ntIndent(Number(data.nesting), "  ") + "ℹ " + String(data.message) + "\n");
    } else if (type === "test:summary") {
      if (data.file === undefined) write(failingList());
    }
  };
}

function __ntDotReporter(write: any): any {
  const state: any = { count: 0, failed: [] };
  const columns = (): number => {
    let c: any = undefined;
    try {
      c = process.stdout.columns;
    } catch (e) {}
    return Math.max(c === undefined || c === null ? 20 : Number(c), 20);
  };
  state.columns = columns();
  return (type: string, data: any): void => {
    if (type === "test:pass") write(".");
    if (type === "test:fail") {
      write("X");
      state.failed.push(data);
    }
    if (type === "test:pass" || type === "test:fail") {
      state.count = Number(state.count) + 1;
      if (Number(state.count) === Number(state.columns)) {
        write("\n");
        state.columns = columns();
        state.count = 0;
      }
    }
    if (type === "__end") {
      write("\n");
      if (Number(state.failed.length) > 0) {
        write("\nFailed tests:\n\n");
        for (const t of state.failed) write(__ntFormatTestReport("test:fail", t, "", "", false, true));
      }
    }
  };
}

// The reporter a child spawned by `run()` uses: one JSON event per line,
// prefixed so the parent can tell it apart from the file's own stdout. It
// stands in for Node's v8-serialized `child-v8` reporter stream.
const __NT_CHILD_PREFIX = "##zun-node-test## ";

function __ntSerializeError(err: any): any {
  if (err === null || err === undefined || typeof err !== "object") return { __primitive: true, value: String(err) };
  const out: any = {
    message: err.message === undefined ? undefined : String(err.message),
    name: err.name === undefined ? undefined : String(err.name),
    code: err.code,
    failureType: err.failureType,
    stack: typeof err.stack === "string" ? err.stack : undefined,
  };
  if (err.cause !== undefined && err.cause !== err) out.cause = __ntSerializeError(err.cause);
  if (err.expected !== undefined) out.expected = __ntSafeJson(err.expected);
  if (err.actual !== undefined) out.actual = __ntSafeJson(err.actual);
  if (err.operator !== undefined) out.operator = err.operator;
  return out;
}

function __ntSafeJson(v: any): any {
  try {
    JSON.stringify(v);
    return v;
  } catch (e) {
    return __ntInspect(v);
  }
}

function __ntChildReporter(write: any): any {
  return (type: string, data: any): void => {
    if (type === "__end") return;
    const copy: any = Object.assign({}, data);
    if (copy.details !== undefined && copy.details !== null) {
      copy.details = Object.assign({}, copy.details);
      if (copy.details.error !== undefined) copy.details.error = __ntSerializeError(copy.details.error);
    }
    let text = "";
    try {
      text = JSON.stringify({ type: type, data: copy });
    } catch (e) {
      return;
    }
    write(__NT_CHILD_PREFIX + text + "\n");
  };
}

// ---------------------------------------------------------------------------
// The public functions
// ---------------------------------------------------------------------------

// The public entry points take three optional parameters rather than a rest
// parameter: a top-level function with a rest parameter, called through an
// `any` value (`const { describe } = require('node:test')`), does not get
// its rest array packed (https://github.com/UrubuCode/zun/issues/11).
function test(name?: any, options?: any, fn?: any): any {
  return __ntCreateTest(__ntCurrentParent(), [name, options, fn], "test");
}

function __ntDescribe(name?: any, options?: any, fn?: any): any {
  return __ntCreateTest(__ntCurrentParent(), [name, options, fn], "suite");
}

function __ntWithOverride(args: any[], key: string): any[] {
  const parsed: any = __ntParseArgs(args);
  const opts: any = Object.assign({}, parsed.options);
  opts[key] = true;
  return [parsed.name, opts, parsed.fn];
}

function __ntShorthand(kind: string, key: string, name: any, options: any, fn: any): any {
  return __ntCreateTest(__ntCurrentParent(), __ntWithOverride([name, options, fn], key), kind);
}

function __ntTestSkip(name?: any, options?: any, fn?: any): any { return __ntShorthand("test", "skip", name, options, fn); }
function __ntTestTodo(name?: any, options?: any, fn?: any): any { return __ntShorthand("test", "todo", name, options, fn); }
function __ntTestOnly(name?: any, options?: any, fn?: any): any { return __ntShorthand("test", "only", name, options, fn); }
function __ntDescribeSkip(name?: any, options?: any, fn?: any): any { return __ntShorthand("suite", "skip", name, options, fn); }
function __ntDescribeTodo(name?: any, options?: any, fn?: any): any { return __ntShorthand("suite", "todo", name, options, fn); }
function __ntDescribeOnly(name?: any, options?: any, fn?: any): any { return __ntShorthand("suite", "only", name, options, fn); }

function __ntHookFn(hookType: string): any {
  return (fn: any, options?: any): void => {
    const parent: any = __ntCurrentParent();
    __ntCreateHook(parent, hookType, fn, options);
    if (parent.kind === "root") __ntScheduleRoot();
  };
}

const __ntBefore: any = __ntHookFn("before");
const __ntAfter: any = __ntHookFn("after");
const __ntBeforeEach: any = __ntHookFn("beforeEach");
const __ntAfterEach: any = __ntHookFn("afterEach");

// `run()` is filled in by src/test/run.ts when a test uses it.
const __ntRunImpl: any = {
  run(options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("run()");
  },
};

function __ntRunApi(options?: any): any {
  return __ntRunImpl.run(options);
}

const __ntSnapshot: any = {
  setDefaultSnapshotSerializers(serializers: any): void {
    if (!Array.isArray(serializers)) throw new ERR_INVALID_ARG_TYPE("serializers", "Array", serializers);
    for (let i = 0; i < Number(serializers.length); i++) {
      __ntValidateFunction(serializers[i], "serializers[" + String(i) + "]");
    }
    __ntState.snapshotSerializers = serializers;
  },
  setResolveSnapshotPath(fn: any): void {
    __ntValidateFunction(fn, "fn");
    __ntState.snapshotResolver = fn;
  },
};

(test as any).skip = __ntTestSkip;
(test as any).todo = __ntTestTodo;
(test as any).only = __ntTestOnly;
(__ntDescribe as any).skip = __ntDescribeSkip;
(__ntDescribe as any).todo = __ntDescribeTodo;
(__ntDescribe as any).only = __ntDescribeOnly;

const __ntMock: any = __ntNewMockTracker();

(test as any).test = test;
(test as any).it = test;
(test as any).describe = __ntDescribe;
(test as any).suite = __ntDescribe;
(test as any).before = __ntBefore;
(test as any).after = __ntAfter;
(test as any).beforeEach = __ntBeforeEach;
(test as any).afterEach = __ntAfterEach;
(test as any).run = __ntRunApi;
(test as any).mock = __ntMock;
(test as any).assert = __node_test_assert;
(test as any).snapshot = __ntSnapshot;

// The module object *is* `test`, as in Node (`require('node:test') === test`):
// a nested `const test = require('node:test')` -- which the bundler rewrites
// to `const test = __node_test` rather than deleting -- must stay callable.
const __node_test: any = test;

// `node:test/reporters`: the built-in reporters, as functions over an event
// source. Each takes an async iterable of `{ type, data }` events (a run()
// stream) and returns an async iterable of output chunks.
function __ntReporterGenerator(name: string): any {
  return function (source: any): any {
    const chunks: string[] = [];
    const reporter: any = __ntMakeReporter(name, (s: string) => { chunks.push(s); });
    const out: any = {};
    out[Symbol.asyncIterator] = async function* (): any {
      for (const c of chunks.splice(0)) yield c;
      for await (const event of source) {
        reporter(event.type, event.data);
        for (const c of chunks.splice(0)) yield c;
      }
      reporter("__end", {});
      for (const c of chunks.splice(0)) yield c;
    };
    return out;
  };
}

const __node_test_reporters: any = {
  spec: __ntReporterGenerator("spec"),
  tap: __ntReporterGenerator("tap"),
  dot: __ntReporterGenerator("dot"),
};

// `internal/test_runner/utils`, reduced to what Node's tests import from it.
const __node_internal_test_runner_utils: any = {
  convertStringToRegExp(str: any, name: any): any {
    return __ntStringToRegExp(String(str), String(name));
  },
};

// `--test-isolation=none` (src/bin/zun-node-run.rs concatenates the files
// into one program): a file that declares no test is reported as one passing
// test named after the file, as Node reports it.
function __ntFileMark(): number {
  return Number(__ntRoot().children.length);
}

function __ntFileDone(name: any, mark: any): void {
  const root: any = __ntRoot();
  if (Number(root.children.length) === Number(mark)) {
    test(String(name));
  }
}

// ---------------------------------------------------------------------------
// The `node --test` command line (shared by src/test/run.ts' `__ntCli` and
// the `--test-isolation=none` program src/bin/zun-node-run.rs writes)
// ---------------------------------------------------------------------------

function __ntCliFlag(flags: string[], name: string): any {
  // The last occurrence wins, as with Node's option parser; a flag spelled
  // `--name value` or `--name=value`. `true` for a bare boolean flag.
  let value: any = undefined;
  const n = Number(flags.length);
  for (let i = 0; i < n; i++) {
    const f = String(flags[i]);
    if (f === name) {
      if (i + 1 < n && String(flags[i + 1]).charAt(0) !== "-") {
        value = String(flags[i + 1]);
        i++;
      } else {
        value = true;
      }
    } else if (f.indexOf(name + "=") === 0) {
      value = f.slice(name.length + 1);
    }
  }
  return value;
}

function __ntCliFlagAll(flags: string[], name: string): string[] {
  const out: string[] = [];
  const n = Number(flags.length);
  for (let i = 0; i < n; i++) {
    const f = String(flags[i]);
    if (f === name && i + 1 < n) {
      out.push(String(flags[i + 1]));
      i++;
    } else if (f.indexOf(name + "=") === 0) {
      out.push(f.slice(name.length + 1));
    }
  }
  return out;
}

// `NODE_DEBUG=test_runner`: the configuration line
// lib/internal/main/test_runner.js logs before it starts.
function __ntCliDebug(flags: string[], files: string[]): void {
  const isolationFlag: any = __ntCliFlag(flags, "--test-isolation");
  const isolation: string = isolationFlag === undefined || isolationFlag === true ? "process" : String(isolationFlag);
  const concurrencyFlag: any = __ntCliFlag(flags, "--test-concurrency");
  let concurrency: any = concurrencyFlag === undefined || concurrencyFlag === true ? true : Number(concurrencyFlag);
  if (isolation === "none") concurrency = 1;
  const timeoutFlag: any = __ntCliFlag(flags, "--test-timeout");
  const timeout: any = timeoutFlag === undefined || timeoutFlag === true || Number(timeoutFlag) === 0 ? Infinity : Number(timeoutFlag);
  const reporters: string[] = __ntCliFlagAll(flags, "--test-reporter");
  const destinations: string[] = __ntCliFlagAll(flags, "--test-reporter-destination");
  const namePatterns: string[] = __ntCliFlagAll(flags, "--test-name-pattern");
  const skipPatterns: string[] = __ntCliFlagAll(flags, "--test-skip-pattern");
  const options: any = {
    isTestRunner: true,
    concurrency: concurrency,
    coverage: false,
    coverageExcludeGlobs: undefined,
    coverageIncludeGlobs: undefined,
    destinations: Number(destinations.length) > 0 ? destinations : ["stdout"],
    forceExit: __ntCliFlag(flags, "--test-force-exit") === true,
    isolation: isolation,
    only: __ntCliFlag(flags, "--test-only") === true && isolation === "none",
    reporters: Number(reporters.length) > 0 ? reporters : ["spec"],
    shard: undefined,
    sourceMaps: false,
    testNamePatterns: Number(namePatterns.length) > 0 ? namePatterns : null,
    testSkipPatterns: Number(skipPatterns.length) > 0 ? skipPatterns : null,
    timeout: timeout,
    updateSnapshots: false,
    watch: false,
    globPatterns: files,
  };
  try {
    const debug: any = __node_util.debuglog("test_runner");
    debug("test runner configuration:", options);
  } catch (e) {}
}

// A list handed over in the environment by src/bin/zun-node-run.rs, as a
// JSON array of strings.
function __ntCliEnvList(name: string): string[] {
  const raw: any = process.env[name];
  if (raw === undefined || raw === null || String(raw) === "") return [];
  try {
    const parsed: any = JSON.parse(String(raw));
    const out: string[] = [];
    for (const v of parsed) out.push(String(v));
    return out;
  } catch (e) {
    return [];
  }
}

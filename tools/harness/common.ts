// The `test/common` harness Node's own test files require, reduced to what the
// corpus actually uses — but with the call-count verification real, not stubbed.
//
// `common` and `fixtures` keep Node's names so the bundler can simply delete the
// `require` lines and let these bindings take over.
//
// ---------------------------------------------------------------------------
// How the counts are verified: the exit mechanism
// ---------------------------------------------------------------------------
//
// Node's `test/common/index.js` registers `process.on('exit', runCallChecks)` at
// load time, so every `mustCall` wrapper is checked once the event loop has
// drained. Reproducing that needs three things this harness now has:
//
//   1. `process` is an EventEmitter (../../src/process/process.ts), so
//      `process.on('exit')` and `process.emit('exit')` exist at all.
//   2. The harness registers its own 'exit' listener here, at load time — ahead
//      of any listener the test body adds, exactly as in Node.
//   3. Something has to decide that the loop is empty and emit 'exit'. The VM
//      drains its unified loop (timers + microtasks) after the main script
//      returns, but exposes no "about to exit" hook, so the bundler appends one
//      statement — `__zunHarnessFinish();` — as the last line of the program.
//      That starts a *settle loop*: a chain of engine timer turns, each of which
//      yields to the VM's timer and microtask queues. A turn counts as idle when
//      `process.nextTick` has nothing pending **and** `node:timers` has no
//      ref'd timer armed; after `__IDLE_ROUNDS` consecutive idle turns (or
//      `__MAX_ROUNDS` turns in all, the guard against a test that never settles)
//      the chain emits 'exit' and, if a check failed, exits non-zero.
//
// Pending timers used to be invisible to the loop, which made the exit decision
// a heuristic. They are not any more: `src/timers/timers.ts` owns every Node
// timer, so it can report how many ref'd ones are still armed
// (`__timerPendingRefs()`) and how long until the earliest is due
// (`__timerNextDelay()`). The loop uses the first to stay awake and the second
// to pick its own next delay, so a pending `setTimeout(fn, 1000)` neither ends
// the run early nor spends a thousand turns getting there — the VM's virtual
// clock jumps straight to the due time. What remains outside the loop's view is
// an `unref()`'d timer, which is exactly what Node also declines to wait for.
//
// The loop arms its own turn through the `zun:core` `timers` namespace rather
// than the global `setTimeout`, for two reasons: a harness turn is not Node
// work and must not count as a pending ref, and the global is
// `src/timers/timers.ts`' Node-shaped function, which would allocate a
// `Timeout` object per turn.

// ---------------------------------------------------------------------------
// Why every helper here hands back a *boxed* function
// ---------------------------------------------------------------------------
//
// A function value cannot be returned out of an object-literal method or a
// class method in this engine: the caller receives `null` (object literal) or
// `undefined` (class method). `common.mustCall(fn)` is exactly that shape, so
// the wrapper is handed back through `__evBox` (../../src/events/events.ts),
// which routes it through a one-element array and yields the `functionBox`
// record the engine itself uses on that lane. The record is an object, so it
// returns intact; it stays callable with the exact argument count; it keeps one
// identity even inside another array; and `events`, `assert` and `process` all
// unwrap it, so `ee.on('x', common.mustCall())` and
// `assert.strictEqual(listener, hello)` behave as written.

const __IDLE_ROUNDS: number = 24;
const __MAX_ROUNDS: number = 1024;

// Registered wrappers, checked when 'exit' fires.
const __mustCallChecks: any[] = [];
const __harnessState: any = { skipped: false, warningExpectations: [], failures: [] };

function __harnessFail(message: string): void {
  __harnessState.failures.push(message);
  host.stderrWrite("Mismatched function call: " + message + "\n");
  process.exitCode = 1;
}

// `common.mustCall` / `common.mustCallAtLeast` share this wrapper.
function __mustCallInner(fn: any, criteria: any, field: string): any {
  let target: any = fn;
  let expected: any = criteria;
  if (typeof fn === "number") {
    expected = fn;
    target = undefined;
  }
  if (expected === undefined) expected = 1;
  if (typeof expected !== "number") {
    throw new TypeError('Invalid ' + field + ' value: ' + String(expected));
  }

  const record: any = { actual: 0, expected: expected, field: field, name: "<anonymous>" };
  if (target !== undefined && target !== null) {
    const named: any = target.name;
    if (typeof named === "string" && named !== "") record.name = named;
  }
  __mustCallChecks.push(record);

  // A function expression (not a declaration) with no declared parameters, so
  // `arguments` is available and the forwarded arity is exact.
  const wrapper: any = function (): any {
    record.actual = Number(record.actual) + 1;
    if (target === undefined || target === null) return undefined;
    const passed: any[] = [];
    const count = Number(arguments.length);
    for (let i = 0; i < count; i++) passed.push(arguments[i]);
    return __evCall(target, passed);
  };
  return __evBox(wrapper);
}

function __runCallChecks(): void {
  if (__harnessState.skipped) return;
  for (const record of __mustCallChecks) {
    const actual = Number(record.actual);
    const expected = Number(record.expected);
    const ok =
      record.field === "minimum" ? actual >= expected : actual === expected;
    if (!ok) {
      __harnessFail(
        record.name +
          " called " +
          String(actual) +
          " times, expected " +
          (record.field === "minimum" ? "at least " : "exactly ") +
          String(expected),
      );
    }
  }
  for (const expectation of __harnessState.warningExpectations) {
    if (!expectation.seen) {
      __harnessFail("expected warning " + String(expectation.name) + " was never emitted");
    }
  }
}

// Registered at load time, so it runs ahead of any 'exit' listener the test adds
// — the same ordering Node's `test/common` gets from being required first.
process.on("exit", __runCallChecks);

// The VM's own macrotask tier, reached by namespace so the harness turn is not
// one of Node's timers. See the note at the top of this file.
import { timers as __harnessTimers } from "zun:core";

// Started by the single statement the bundler appends after the test body.
//
// `__zunHarnessStep` is a top-level function declaration rather than a closure,
// because the checker only accepts a statically known function as a
// `setTimeout` callback — an `any`-typed binding holding a function is rejected
// with "`setTimeout` expects a function callback", so the loop state lives in a
// module-level object instead of being captured.
const __harnessLoop: any = { idle: 0, rounds: 0 };

function __zunHarnessStep(): void {
  __harnessLoop.rounds = Number(__harnessLoop.rounds) + 1;
  if (__processPendingTicks() > 0 || __timerPendingRefs() > 0) {
    __harnessLoop.idle = 0;
  } else {
    __harnessLoop.idle = Number(__harnessLoop.idle) + 1;
  }
  if (
    Number(__harnessLoop.idle) >= __IDLE_ROUNDS ||
    Number(__harnessLoop.rounds) >= __MAX_ROUNDS
  ) {
    if (
      Number(__harnessLoop.rounds) < __MAX_ROUNDS &&
      __zunHarnessBeforeExit()
    ) {
      __harnessLoop.idle = 0;
      __zunHarnessArm();
      return;
    }
    __zunHarnessExit();
    return;
  }
  __zunHarnessArm();
}

// Node's `process` 'beforeExit', which fires when the loop has nothing left to
// do. A listener may schedule more work, and then the loop runs again and
// 'beforeExit' fires once more — so this returns whether that happened. Work
// that is only `unref()`'d does not count, which is exactly what
// `test-timers-unrefed-in-beforeexit.js` checks. The round budget is the guard
// against a listener that schedules forever, the same one Node lacks.
function __zunHarnessBeforeExit(): boolean {
  if (Number(process.listenerCount("beforeExit")) === 0) return false;
  const code: any = process.exitCode;
  process.emit("beforeExit", code === undefined || code === null ? 0 : Number(code));
  return __processPendingTicks() > 0 || __timerPendingRefs() > 0;
}

// One settle turn, armed for whenever the next Node timer is due (1ms when none
// is). The VM fast-forwards its virtual clock to the earliest due time between
// macrotasks, so this is what keeps a long delay from costing a turn per
// millisecond.
function __zunHarnessArm(): void {
  const next: number = __timerNextDelay();
  __harnessTimers.setTimeout(__zunHarnessStep, next > 1 ? next : 1);
}

function __zunHarnessFinish(): void {
  __zunHarnessArm();
}

function __zunHarnessExit(): void {
  __processRunExit(undefined);
  // The 'exit' listeners have run, so the state they inspect is settled; now
  // drop whatever is still armed. An `unref()`'d interval is work Node would
  // have abandoned at this point, but the VM's timer heap keeps re-arming it,
  // which would hang the run.
  __timerShutdown();
  const code: any = process.exitCode;
  if (code !== undefined && code !== null && Number(code) !== 0) {
    host.exitProcess(Number(code));
  }
}

const common: any = {
  isWindows: process.platform === "win32",
  isLinux: process.platform === "linux",
  isMacOS: process.platform === "darwin",
  isAIX: false,
  isIBMi: false,
  isSunOS: false,
  isFreeBSD: false,
  isOpenBSD: false,
  hasCrypto: false,
  hasIntl: false,
  isDumbTerminal: true,

  // A skipped test is a pass in Node's TAP output; exit 0 so the runner agrees.
  // The pending call counts are abandoned, because the test never ran.
  skip(message: string): void {
    __harnessState.skipped = true;
    console.log("1..0 # Skipped: " + message);
    process.exit(0);
  },

  printSkipMessage(message: string): void {
    console.log("1..0 # Skipped: " + message);
  },

  // Mirrors test/common/index.js: the suffix of an ERR_INVALID_ARG_TYPE message
  // describing what was received.
  invalidArgTypeHelper(input: any): string {
    if (input === null) return " Received null";
    if (input === undefined) return " Received undefined";
    if (typeof input === "function") {
      const name = input.name === undefined ? "" : String(input.name);
      return " Received function " + name;
    }
    if (typeof input === "object") {
      if (Array.isArray(input)) return " Received an instance of Array";
      const ctor: any = input.constructor;
      const name: any = ctor === undefined || ctor === null ? undefined : ctor.name;
      return (
        " Received an instance of " +
        (typeof name === "string" && name !== "" ? name : "Object")
      );
    }
    // `inspect`, not `JSON.stringify`: Node's own helper inspects, so a string
    // is reported in single quotes (`Received type string ('')`) and that is
    // the text the corpus compares an `ERR_INVALID_ARG_TYPE` message against.
    // The 28/25 truncation is Node's too.
    let inspected: string = inspect(input, { colors: false });
    if (Number(inspected.length) > 28) {
      inspected = inspected.slice(0, 25) + "...";
    }
    return " Received type " + typeof input + " (" + inspected + ")";
  },

  // `common.mustCall(fn?, exact = 1)` — verified when 'exit' fires.
  mustCall(fn?: any, exact?: any): any {
    return __mustCallInner(fn, exact, "exact");
  },

  // `common.mustCallAtLeast(fn?, minimum = 1)`.
  mustCallAtLeast(fn?: any, minimum?: any): any {
    return __mustCallInner(fn, minimum, "minimum");
  },

  mustNotCall(message?: any): any {
    const label: string =
      message === undefined || message === null
        ? "function should not have been called"
        : String(message);
    const wrapper: any = function (): any {
      __harnessFail(label);
      throw new Error(label);
    };
    return __evBox(wrapper);
  },

  mustNotMutateObjectDeep(value: any): any {
    return value;
  },

  // `common.mustSucceed(fn?, exact?)` — a callback that asserts `err` is falsy
  // and then forwards the remaining arguments.
  mustSucceed(fn?: any, exact?: any): any {
    const inner: any = function (): any {
      const err: any = arguments[0];
      if (err !== undefined && err !== null) {
        __harnessFail("mustSucceed received an error: " + String(err.message));
        throw err;
      }
      if (fn === undefined || fn === null) return undefined;
      const passed: any[] = [];
      const count = Number(arguments.length);
      for (let i = 1; i < count; i++) passed.push(arguments[i]);
      return __evCall(fn, passed);
    };
    return __mustCallInner(inner, exact, "exact");
  },

  // `common.expectsError(validator)` — a predicate for `assert.throws`, which
  // checks the fields of the thrown error and answers `true`.
  expectsError(validator: any, exact?: any): any {
    const predicate: any = function (error: any): any {
      if (validator === undefined || validator === null) return true;
      if (typeof validator === "function") {
        return __evCall(validator, [error]) === true;
      }
      for (const key of Object.keys(validator)) {
        const want: any = validator[key];
        const got: any = error === null || error === undefined ? undefined : error[key];
        if (want instanceof RegExp) {
          if (!__regexTest(want, String(got))) return false;
        } else if (!__isDeepStrictEqual(got, want)) {
          return false;
        }
      }
      return true;
    };
    return __evBox(predicate);
  },

  // `common.expectWarning(name, expected, code?)`. Accepts Node's three shapes:
  // a single (name, message), a map of name -> message, and an array of
  // messages for one name.
  expectWarning(name: any, expected?: any, code?: any): void {
    const wanted: any[] = [];
    if (typeof name === "object" && name !== null) {
      for (const key of Object.keys(name)) {
        const value: any = name[key];
        if (Array.isArray(value)) {
          for (const entry of value) wanted.push({ name: key, message: entry });
        } else {
          wanted.push({ name: key, message: value });
        }
      }
    } else if (Array.isArray(expected)) {
      for (const entry of expected) {
        if (Array.isArray(entry)) {
          wanted.push({ name: name, message: entry[0], code: entry[1] });
        } else {
          wanted.push({ name: name, message: entry });
        }
      }
    } else {
      wanted.push({ name: name, message: expected, code: code });
    }
    for (const entry of wanted) {
      entry.seen = false;
      __harnessState.warningExpectations.push(entry);
    }
    if (Number(__harnessState.warningExpectations.length) === Number(wanted.length)) {
      process.on("warning", __checkWarning);
    }
  },

  platformTimeout(ms: number): number {
    return ms;
  },

  // `test/common/index.js`' `pwdCommand`: the `[file, args]` pair that prints
  // the working directory on this platform, which ten `child_process` tests
  // spread into `spawnSync(...common.pwdCommand, { cwd })`.
  pwdCommand: process.platform === "win32" ? ["cmd.exe", ["/d", "/c", "cd"]] : ["pwd", []],

  // `test/common/index.js`' `escapePOSIXShell`, a tagged template that builds a
  // `[command, options]` pair safe to hand to a shell. On Windows the
  // substitutions go in literally (a Windows path cannot contain a `"`); on
  // POSIX each one is passed through an `ESCAPED_<n>` environment variable, so
  // nothing in it is ever re-parsed by the shell.
  escapePOSIXShell(parts: any, ...args: any[]): any[] {
    const count: number = Number(args.length);
    if (process.platform === "win32") {
      let command: string = String(parts[0]);
      for (let i = 0; i < count; i++) {
        command = command + String(args[i]) + String(parts[i + 1]);
      }
      return [command];
    }
    const env: any = {};
    const keys: any[] = Object.keys(process.env);
    const keyCount: number = Number(keys.length);
    for (let i = 0; i < keyCount; i++) {
      const key: string = String(keys[i]);
      env[key] = process.env[key];
    }
    let command: string = String(parts[0]);
    for (let i = 0; i < count; i++) {
      const name: string = "ESCAPED_" + String(i);
      env[name] = String(args[i]);
      command = command + "${" + name + "}" + String(parts[i + 1]);
    }
    return [command, { env: env }];
  },

  // Node's `common.getTTYfd()` finds a tty among fds 0/1/2/4/5 and otherwise
  // opens `/dev/tty`, returning -1 when neither works. There is no way to
  // *open* `/dev/tty` here, so the search is over fds 0/1/2 with the real
  // predicate from `src/tty/tty.ts`' `isatty` — which answers `false` for all
  // three under the test runner, where the three standard streams are pipes.
  // -1 is then the same answer Node's own `common` gives when it cannot open
  // `/dev/tty`, and a test that needs a real TTY takes its `common.skip`
  // branch rather than a fabricated one.
  getTTYfd(): number {
    for (const fd of [0, 1, 2]) {
      if (__processIsTty(fd) === true) return fd;
    }
    return -1;
  },

  allowGlobals(): void {},

  // `common.canCreateSymLink()`. On POSIX anyone may create a symlink; on
  // Windows it needs the SeCreateSymbolicLinkPrivilege (an elevated shell or
  // Developer Mode), which Node detects by shelling out to `whoami`. There is
  // no `child_process` here, so the answer is `true` and the `fs` corpus's
  // symlink tests fail on an unprivileged Windows with the `EPERM` the
  // extension reports — which is also what Node does when its own detection is
  // wrong. On Linux (where CI runs) the answer is simply correct.
  canCreateSymLink(): boolean {
    return process.platform !== "win32";
  },

  // `common.hasFipsCrypto` and friends are read as plain flags by a few tests.
  hasFipsCrypto: false,
  hasOpenSSL3: false,
  rootDir: process.platform === "win32" ? "C:\\" : "/",
};

function __checkWarning(warning: any): void {
  const warningName: any = warning.name;
  const warningMessage: any = warning.message;
  for (const expectation of __harnessState.warningExpectations) {
    if (expectation.seen === true) continue;
    if (String(expectation.name) !== String(warningName)) continue;
    if (
      expectation.message !== undefined &&
      String(expectation.message) !== String(warningMessage)
    ) {
      continue;
    }
    expectation.seen = true;
    return;
  }
  __harnessFail(
    "unexpected warning " + String(warningName) + ": " + String(warningMessage),
  );
}

// `test/common/fixtures`.
//
// The directory is `<test file's directory>/../fixtures`, which is exactly what
// Node's own test/common/fixtures.js computes (`path.join(__dirname, "..",
// "fixtures")`) and is the only base that can be right for both kinds of
// consumer: the `path` and `util` tests only ever *compute* over the string,
// but an `fs` test opens the file, so the base has to be the directory the
// runner actually downloaded the fixtures into.
// `tools/run_node_tests.sh` populates it from
// `test/<module>/NODE_FIXTURES.txt` beside the downloaded test file; see
// ../../test/fs/README.md.
//
// It is computed **per call**, not once into a `const`: `__dirname` is emitted
// by the bundler *after* every harness file (it is the test's own location), and
// a top-level `const` initialized from it runs before that declaration and
// throws.
function __fixturesDir(): string {
  return path.join(__dirname, "..", "fixtures");
}

function __fixturesJoin(segments: any[]): string {
  // Built with repeated two-argument joins, for two reasons that both still
  // hold. `apply` is unusable: on an object-literal method it threads the
  // receiver correctly, but on any other function value it *shifts* —
  // `f.apply(recv, [a, b])` arrives as `f(recv, a)`
  // (https://github.com/UrubuCode/zun/issues/1). And a call on an `any`
  // receiver still fails to compile past six arguments
  // (https://github.com/UrubuCode/zun/issues/10), which a fixtures path can
  // easily exceed. The fold has no such ceiling.
  let result: string = __fixturesDir();
  for (const segment of segments) result = path.join(result, String(segment));
  return result;
}

const fixtures: any = {
  path(...segments: any[]): string {
    return __fixturesJoin(segments);
  },

  // Node returns a `URL`; this returns the three members every consumer here
  // reads off one (`href`, `pathname`, `protocol`), which is also what `fs`'s
  // `getValidatedPath` needs to turn one back into a path.
  fileURL(...segments: any[]): any {
    let pathname: string = __fixturesJoin(segments).split("\\").join("/");
    if (pathname.charAt(0) !== "/") pathname = "/" + pathname;
    return { href: "file://" + pathname, pathname: pathname, protocol: "file:" };
  },

  // Not `__node_fs.readFileSync`: this file is inlined into every bundle,
  // including the `path`/`events`/`util` ones that do not inline `node:fs` and
  // must keep compiling without `--ext`. A test that reads a fixture requires
  // `fs` itself.
  readSync(): string {
    throw new Error("fixtures.readSync is not available in the zun harness");
  },
};

// `fixtures.fixturesDir` is a getter for the same reason `__fixturesDir` is a
// function: its value is not knowable until `__dirname` exists.
Object.defineProperty(fixtures, "fixturesDir", {
  configurable: true,
  enumerable: true,
  get(): string {
    return __fixturesDir();
  },
});

// `child_process` used to be stubbed here, for `test-path-resolve.js`'s
// Windows-only tail. It is a real module now
// (`src/child_process/child_process.ts`), inlined by the bundler for any test
// that requires it — so the stub is gone rather than shadowing it. The one cost
// is that the real module imports its natives, so a bundle that requires
// `child_process` now needs `--ext`; a `path` or `util` bundle that does so
// fails to compile without one, where before it compiled and threw.

// `node:domain` is required by `test-event-emitter-no-error-provided-to-error-event.js`.
// Domains are a deprecated, async-hooks-backed facility; there is nothing here to
// implement them on, so the stub throws rather than silently passing a test.
const __node_domain: any = {
  create(): any {
    throw new Error("domain is not available in the zun harness");
  },
};

// `node:tty` used to be stubbed here. It is a real module now
// (`src/tty/tty.ts`), inlined by the bundler for any test that requires it —
// so the stub is gone rather than shadowing it.

// `node:worker_threads`. This runtime has one thread and no `Worker`, so
// `isMainThread` is `true` and `threadId` is `0` — which is the honest answer,
// and the same one Node gives on its own main thread. Nineteen files in the
// `process` corpus require this module for `isMainThread` alone, to take a
// `common.skip` branch inside a worker; with no binding at all they failed to
// *bundle*, which hid whatever their real blocker was. `Worker` is absent
// rather than stubbed, so a test that tries to spawn one fails on the missing
// constructor instead of on a fabricated one that does nothing.
const __node_worker_threads: any = {
  isMainThread: true,
  threadId: 0,
  Worker: undefined,
  parentPort: null,
  workerData: null,
  resourceLimits: {},
  SHARE_ENV: undefined,
};

// `node:vm` is required by `test-querystring.js`, which uses
// `vm.runInNewContext('({"foo": ["bar", "baz"]})')` to obtain a plain object
// from *another realm* and check that `querystring.stringify` handles it. A
// second realm is a VM facility, not something a library can synthesize, so the
// stub throws rather than handing back a same-realm object and quietly turning
// a cross-realm test into a tautology.
const __node_vm: any = {
  runInNewContext(): any {
    throw new Error("vm is not available in the zun harness");
  },
  runInThisContext(): any {
    throw new Error("vm is not available in the zun harness");
  },
  createContext(): any {
    throw new Error("vm is not available in the zun harness");
  },
};

// `node:crypto` is required by `test-assert-deep.js` and
// `test-assert-partial-deep-equal.js`, both of which guard every use with
// `common.hasCrypto` — which is `false` here. That is a shape Node itself has:
// a `--without-ssl` build reports `hasCrypto === false` and `require('crypto')`
// throws "Node.js is not compiled with OpenSSL support". The stub says the same
// thing, so the guarded blocks are skipped exactly as they are in that build
// and the bundler, whose unresolved-`require` check is textual, stops failing
// the whole file over a branch that never runs.
const __node_crypto: any = {
  createSecretKey(): any {
    throw new Error("crypto is not available in the zun harness");
  },
  KeyObject: undefined,
};

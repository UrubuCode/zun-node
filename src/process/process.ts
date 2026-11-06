// node:process — Node's `process` object, in Zun TypeScript over the native
// `node:process` extension.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-process-*` files (see
// ../../test/process/). The API shaping follows Node's
// `lib/internal/process/per_thread.js`, `lib/internal/process/warning.js` and
// `lib/internal/bootstrap/node.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) — the `exit` ordering, the `exitCode` coercion ladder, `kill`'s
// signal resolution through `_kill`, `cpuUsage`'s validation order, `hrtime`'s
// borrow arithmetic, the `emitWarning` option grammar and the
// `NodeEnvironmentFlagsSet` shape — because every one of those is observable
// through the corpus rather than derivable.
//
// ---------------------------------------------------------------------------
// Why this module is split in THREE files
// ---------------------------------------------------------------------------
//
// `os`, `fs` and `child_process` are each two files: a Rust extension and a
// Node-shaped `.ts` that imports it. `process` cannot be, and the reason is
// the whole design:
//
//   > **every** bundle in this library inlines this file, and most of them run
//   > without `--ext`.
//
// `path`, `events`, `util`, `assert`, `url`, `querystring`, `punycode` and
// `timers` are pure computation; their tests run as `zun run <bundle.ts>` with
// no extension at all. If this file said `import * as native from
// "node:process"`, every one of those bundles would fail to *compile* for want
// of a cdylib it does not need — exactly the coupling PLAN.md's principle 2
// keeps out of a pure-computation module.
//
// So the import lives in a third file. `src/process/native.ts` is nothing but
//
//     import * as __procNative from "node:process";
//     __processInstallNative({ /* one method per native */ });
//
// and `tools/bundle_node_test.sh` inlines it only when the bundle will be run
// with `--ext` (the `ZUN_NODE_EXT` gate, which `tools/run_node_tests.sh` sets
// for its `zun-ts+ext` kinds). All the logic is here; `native.ts` carries none.
// Every native-backed value therefore has two paths:
//
//   * **with the extension** — the real syscall, through `__procOps()`.
//   * **without it** — a documented fallback. Each one is marked `NO-EXT:` at
//     its use site, and the complete list is:
//
//     | value                          | without the extension                |
//     |--------------------------------|--------------------------------------|
//     | `pid`, `ppid`                  | `0` (the host surface reports none)  |
//     | `platform`                     | derived from the shape of `cwd()`    |
//     | `arch`                         | `"x64"`                              |
//     | `execPath`, `argv[0]`          | the raw `argv[0]` the host was given |
//     | `title`                        | the basename of `argv[0]`            |
//     | `env`                          | a snapshot of a fixed name list      |
//     | `hrtime`, `uptime`             | `Date.now()`, millisecond resolution |
//     | `cpuUsage`, `threadCpuUsage`   | zeros                                |
//     | `memoryUsage`, `resourceUsage` | zeros                                |
//     | `availableMemory`/`constrained` | `0`                                 |
//     | `umask`                        | the platform default, remembered     |
//     | `chdir`, `kill`                | `ERR_METHOD_NOT_IMPLEMENTED`         |
//     | `abort`                        | exit with 128 + SIGABRT              |
//     | `getuid` and the other four    | absent, as on Windows                |
//     | `stdout.isTTY`                 | the host's single `isTty()` flag     |
//
// `src/os/os.ts` used to patch `process.pid` from its own native, because this
// file had none. That line is gone: the pid comes from `procFacts` now, and a
// bundle that has `os` has `--ext` and therefore has `native.ts` too.
//
// ---------------------------------------------------------------------------
// The shape of `process` itself
// ---------------------------------------------------------------------------
//
// `process` stays an **object literal** rather than becoming an `EventEmitter`
// subclass, for the reason it always has: an object-literal method is the only
// shape in which a method can carry a rest parameter and `arguments` at the
// same time in this engine, and `process.emit(type, ...args)` needs both. The
// emitter side is delegated to one `EventEmitter` instance.
//
// The consequence is the one deliberate gap in this module's *shape*:
// `Object.getPrototypeOf(process)` is `Object.prototype`, not an
// `EventEmitter`-derived prototype with a `constructor` descriptor on it, which
// is what `test-process-prototype.js` reads. A class would fix that and break
// `emit`; the emitter semantics are worth more than the prototype chain.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `Number(x.length)` throughout: the checker still types `.length` as
//     `u64`, so it can be neither assigned to nor passed as a `number` (zun#3).
//   * a callable stored where an `any` can reach it is wrapped with `__evBox`
//     (../events/events.ts), because a bare function value does not survive
//     every path through `any` (zun#17) while the box — a real object that is
//     still callable and still carries its own properties — does. That is how
//     `process.hrtime.bigint` and `process.memoryUsage.rss` exist at all:
//     Node hangs a property off a function, and a box is the only function
//     value here that keeps one.
//   * `__evCall(fn, args)` rather than `fn.apply(...)`: `call`/`apply` do not
//     thread a receiver (zun#1).
//   * `process.env` is a plain object whose entries are **accessor**
//     properties, not a `Proxy`. The `get`/`set`/`has`/`deleteProperty`/
//     `defineProperty` traps all work now, but `ownKeys` never fires, so
//     `Object.keys(process.env)` over a Proxy comes back empty
//     (https://github.com/UrubuCode/zun/issues/6) — and `Object.keys`,
//     `{ ...process.env }` and `structuredClone(process.env)` are read by
//     `node:child_process`, by the harness and by Node's own corpus. Accessors
//     keep enumeration exact *and* make a write to an existing variable a real
//     `setenv`; what they cannot give is interception of a **new** name, which
//     is what the three `test-process-env-{delete,deprecation,
//     ignore-getter-setter}.js` files measure. See ../../test/process/README.md.
//   * `process.config` is frozen and `process.exitCode` is a non-configurable
//     accessor, and both rely on this engine throwing a `TypeError` for a write
//     to a frozen object and for a `delete` of a non-configurable property even
//     outside strict mode — which it does, and which is what Node's own tests
//     expect from the strict-mode module they run in.
//   * `process.allowedNodeEnvironmentFlags` is written as Node writes it — a
//     frozen `Set` subclass whose iteration comes from an internal array — and
//     is still only half-observable here: `Set.prototype.add` reads
//     `undefined`, so `Set.prototype.add.call(flags, 'foo')` throws instead of
//     being the no-op the test needs (zun#25, no function-prototype model).
//   * `Error.captureStackTrace` does not exist in this engine, which is what
//     blocks `test-process-emitwarning.js`: the test's own `CustomWarning`
//     constructor calls it. Nothing in this file can work around a gap in the
//     test's own code; it is recorded in ../../test/process/README.md.

import { host } from "zun:core";

// ---------------------------------------------------------------------------
// The native bridge
// ---------------------------------------------------------------------------

// The methods `src/process/native.ts` installs, or `undefined` when this bundle
// was built without the extension. One object with one method per native, for
// the reason every module surface here is object-literal methods: a method
// survives every path through `any`, a bare function value does not (zun#17).
const __processNativeState: any = { ops: undefined };

// `undefined` when there is no extension. Every caller must handle that.
function __procOps(): any {
  return __processNativeState.ops;
}

// Record and unit separators of the native carrier, and the failure marker.
// The grammar is documented in src/process/mod.rs and is the mirror image of
// `__procRecords` below:
//
//     result  := "+" payload | "-"        payload := record (RS record)*
//     record  := field (US field)*        RS = U+001E     US = U+001F
const __PROC_RS: string = String.fromCharCode(30);
const __PROC_US: string = String.fromCharCode(31);
const __PROC_FAILED: string = "-";
const __PROC_MAX_SAFE: number = 9007199254740991;

// Did the last native call fail? Then raise what Node raises.
function __procFailed(payload: any): boolean {
  return payload === __PROC_FAILED;
}

// Split a successful payload into records of fields.
function __procRecords(payload: string): string[][] {
  const body: string = payload.slice(1);
  if (body === "") return [];
  const rows: string[][] = [];
  for (const record of body.split(__PROC_RS)) {
    rows.push(record.split(__PROC_US));
  }
  return rows;
}

// The one record of a single-record payload.
function __procFields(payload: string): string[] {
  const rows: string[][] = __procRecords(payload);
  if (Number(rows.length) === 0) return [];
  return rows[0];
}

// The whole payload of a single-field result, byte for byte.
function __procPayload(payload: string): string {
  return payload.slice(1);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// Node's `uvException`/`errnoException`: the error a failed libuv call becomes
// outside `os`. `message` is `"<code>: <description>, <syscall> '<path>'"` with
// `" -> '<dest>'"` appended when the call carried two paths — which `chdir`
// does and nothing else here does — or the bare `"<syscall> <code>"` of
// `errnoException`, which is what `process.kill` raises.
//
// Every field is **declared**, as in every error class in this library: an
// undeclared key written onto a typed instance through an `any` alias poisons
// every later statically typed read of that instance
// (https://github.com/UrubuCode/zun/issues/37).
class ProcessSystemError extends NodeError {
  errno: number = 0;
  syscall: string = "";
  path: any = undefined;
  dest: any = undefined;
  constructor(code: string, message: string) {
    super(code, message);
  }
}

// Node's `errnoException`, whose message is `"<syscall> <code>"` and no more.
function __procErrnoException(syscall: string): any {
  const ops: any = __procOps();
  const code: string = String(ops.errorCode());
  const error: any = new ProcessSystemError(code, syscall + " " + code);
  error.errno = Number(ops.errorErrno());
  error.syscall = syscall;
  return error;
}

// Node's `uvException` for the one call here that carries paths.
function __procUvException(): any {
  const ops: any = __procOps();
  const code: string = String(ops.errorCode());
  const syscall: string = String(ops.errorSyscall());
  const description: string = String(ops.errorMessage());
  const path: string = String(ops.errorPath());
  const dest: string = String(ops.errorDest());
  let message: string = code + ": " + description + ", " + syscall;
  if (path !== "") message = message + " '" + path + "'";
  if (dest !== "") message = message + " -> '" + dest + "'";
  const error: any = new ProcessSystemError(code, message);
  error.errno = Number(ops.errorErrno());
  error.syscall = syscall;
  if (path !== "") error.path = path;
  if (dest !== "") error.dest = dest;
  return error;
}

// `ERR_INVALID_ARG_VALUE` with a `RangeError` name, which is Node's
// `ERR_INVALID_ARG_VALUE.RangeError` — the shape `cpuUsage` raises for a
// previous value that is a number but not a usable one.
class ERR_INVALID_ARG_VALUE_RANGE extends NodeRangeError {
  constructor(name: string, value: any) {
    super(
      "ERR_INVALID_ARG_VALUE",
      "The property '" + name + "' is invalid. Received " + inspect(value),
    );
  }
}

// `ERR_METHOD_NOT_IMPLEMENTED` is Node's own error for an entry point this
// build does not have, with Node's own message, and in `process` it is what a
// native-backed *action* raises when the bundle has no extension: a
// native-backed *value* can fall back to a documented substitute, while
// `chdir` and `kill` cannot, so they say so rather than lie.
//
// It is **not declared here**. Four files in this library raise it -- this one,
// `src/fs/fs.ts` (`fs.glob`, `fs.watch`, `fs.createReadStream`, ...),
// `src/stream/stream.ts` (`_read`, `_write`, `_transform`) and
// `src/child_process/child_process.ts` -- and two top-level declarations of one
// name are a compile error in a single Zun program, which a bundle of `fs` plus
// `stream` is. The one home that cannot collide is therefore the error bases
// themselves: it is declared in `src/events/events.ts`, which every bundle
// inlines ahead of this file.

// `ERR_UNKNOWN_SIGNAL`, on the other hand, *is* declared here rather than in
// `src/child_process/child_process.ts`, which resolves the same signal names
// for `killSignal` -- this file is in every bundle and that one is
// conditional, so here is where the single declaration lands. Node's message is
// `'Unknown signal: %s'`, and `%s` on a string is the string itself — so an
// unknown signal *name* is reported bare, and only a non-string is inspected.
class ERR_UNKNOWN_SIGNAL extends NodeTypeError {
  constructor(signal: any) {
    super(
      "ERR_UNKNOWN_SIGNAL",
      "Unknown signal: " + (typeof signal === "string" ? signal : inspect(signal)),
    );
  }
}

// `process.execve` exists on every platform in Node 25 and is usable on none
// but POSIX; this is what it raises elsewhere.
class ERR_FEATURE_UNAVAILABLE_ON_PLATFORM extends NodeTypeError {
  constructor(feature: string) {
    super(
      "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
      "The feature " +
        feature +
        " is unavailable on this platform, which is being used to run Node.js",
    );
  }
}

class ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET extends NodeError {
  constructor() {
    super(
      "ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET",
      "`process.setupUncaughtExceptionCapture()` was called while a capture callback was already active",
    );
  }
}

class ERR_DLOPEN_FAILED extends NodeError {
  constructor(message: string) {
    super("ERR_DLOPEN_FAILED", message);
  }
}

// ---------------------------------------------------------------------------
// Validators (lib/internal/validators.js, reduced to what `process` uses)
// ---------------------------------------------------------------------------

function __procValidateString(value: any, name: string): void {
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }
}

// `validateNumber(value, name)` with neither bound — a *type* check only, which
// is what `cpuUsage` needs: an `Infinity` previous value must reach the
// `ERR_INVALID_ARG_VALUE` branch rather than being rejected as out of range.
function __procValidateNumberType(value: any, name: string): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
}

function __procValidateUint32(value: any, name: string): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
    throw new ERR_OUT_OF_RANGE(name, ">= 0 && <= 4294967295", value);
  }
}

// `parseFileMode(value, name)`: a uint32, or a string of octal digits.
function __procParseFileMode(value: any, name: string): number {
  let parsed: any = value;
  if (typeof value === "string") {
    if (!__procIsOctalDigits(value)) {
      throw new ERR_INVALID_ARG_VALUE(
        name,
        value,
        "must be a 32-bit unsigned integer or an octal string",
      );
    }
    parsed = parseInt(value, 8);
  }
  __procValidateUint32(parsed, name);
  return Number(parsed);
}

// `/^[0-7]+$/`, spelled with `charCodeAt` over a bounded index because a
// `charCodeAt` past the end throws here (zun#2).
function __procIsOctalDigits(text: string): boolean {
  const count: number = Number(text.length);
  if (count === 0) return false;
  for (let i = 0; i < count; i++) {
    const code: number = text.charCodeAt(i);
    if (code < 48 || code > 55) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Platform, architecture and the executable
// ---------------------------------------------------------------------------

function __processCwd(): string {
  return host.cwd();
}

// NO-EXT: with no native to ask, the platform is derived from the shape of
// `cwd()` — a `X:\...` drive-rooted working directory means Windows. The
// extension replaces this with `procFacts`' answer, which is the compile-time
// target rather than a guess.
function __looksWindows(): boolean {
  const cwd = __processCwd();
  if (cwd.length < 3) return false;
  const drive = cwd.charCodeAt(0);
  const isLetter =
    (drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122);
  if (!isLetter) return false;
  if (cwd.charCodeAt(1) !== 58) return false; // ':'
  const third = cwd.charCodeAt(2);
  return third === 92 || third === 47; // '\' or '/'
}

const __isWindowsHost: boolean = __looksWindows();

// The raw argument vector the host was started with. For the `zun` CLI that is
// `[<zun binary>, "run", <engine options...>, <script>, <script arguments...>]`,
// which is not Node's `argv` — Node's is
// `[execPath, <main script>, <script arguments...>]`, with the interpreter's own
// options split off into `execArgv`. `__processSplitArgv` does that split.
function __processRawArgv(): string[] {
  const out: string[] = [];
  const count = Number(host.argCount());
  for (let i = 0; i < count; i++) {
    out.push(host.argAt(i));
  }
  return out;
}

// The engine options that take a separate value argument, so the scan below
// does not mistake one for the script path.
const __PROC_VALUE_OPTIONS: string[] = ["--ext", "-e", "--eval"];

// Split the raw vector into `argv0`, `execArgv`, the script and its arguments.
//
// The rule is the `zun` CLI's own shape: element 0 is the binary, element 1 is
// the subcommand (`run`), and from there every element that begins with `-` is
// an engine option — plus the following element when the option is one that
// takes a value. The first element that is neither is the script, and
// everything after it belongs to the script. A vector with no subcommand at all
// (the engine embedded elsewhere) degrades to "no script, no arguments", which
// is what Node reports for a REPL.
function __processSplitArgv(): any {
  const raw: string[] = __processRawArgv();
  const count: number = Number(raw.length);
  const split: any = {
    argv0: count > 0 ? raw[0] : "",
    execArgv: [],
    script: undefined,
    rest: [],
  };
  let index: number = count > 1 ? 2 : count;
  while (index < count) {
    const entry: string = raw[index];
    if (entry === "" || entry.charAt(0) !== "-") break;
    split.execArgv.push(entry);
    if (Number(__PROC_VALUE_OPTIONS.indexOf(entry)) !== -1 && index + 1 < count) {
      split.execArgv.push(raw[index + 1]);
      index = index + 2;
      continue;
    }
    index = index + 1;
  }
  if (index < count) {
    split.script = raw[index];
    for (let i = index + 1; i < count; i++) split.rest.push(raw[i]);
  }
  return split;
}

const __processArgvSplit: any = __processSplitArgv();

// `process.argv`: the executable, the main script, then the script's own
// arguments. NO-EXT: `execPath` is the raw `argv[0]` until the native reports
// the resolved one.
function __processBuildArgv(execPath: string): string[] {
  const argv: string[] = [execPath];
  const script: any = __processArgvSplit.script;
  if (script !== undefined) argv.push(String(script));
  for (const entry of __processArgvSplit.rest) argv.push(String(entry));
  return argv;
}

// The basename of a path, for the no-extension `process.title`.
function __processBasename(value: string): string {
  let start: number = 0;
  const count: number = Number(value.length);
  for (let i = 0; i < count; i++) {
    const code: number = value.charCodeAt(i);
    if (code === 47 || code === 92) start = i + 1;
  }
  return value.slice(start);
}

// ---------------------------------------------------------------------------
// process.env
// ---------------------------------------------------------------------------

// The backing store every `process.env` accessor reads and writes, so a write
// through the accessor and a write through `procSetEnv` cannot drift.
const __processEnvState: any = { values: {} };

function __processEnvGet(name: string): any {
  if (!host.envHas(name)) return undefined;
  return host.envGet(name);
}

// NO-EXT: `zun:core` can read a variable by name but cannot enumerate the
// environment block, so without the extension `process.env` is a snapshot over
// a fixed list of names — the ones Node's own tests touch, plus the per-drive
// `=X:` cwd variables `win32.resolve` consults. `envLookup` stays available for
// a name outside the list. With the extension, `procEnviron` reports the whole
// block and this list is not used at all.
const __envNames: string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "USERNAME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "OS",
  "OSTYPE",
  "ComSpec",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "PWD",
  "CD",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TEST_NO_COLORS",
  "NO_COLOR",
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "TZ",
];

// One `process.env` entry: an accessor over `__processEnvState.values`, so a
// read is live, a write reaches the real environment, and the property is still
// an own enumerable key — which is what makes `Object.keys(process.env)`,
// `{ ...process.env }` and `structuredClone(process.env)` correct. See the note
// on the Proxy in the header.
function __processDefineEnvEntry(env: any, name: string, value: string): void {
  __processEnvState.values[name] = value;
  Object.defineProperty(env, name, {
    configurable: true,
    enumerable: true,
    get(): any {
      return __processEnvState.values[name];
    },
    set(assigned: any): void {
      __processEnvAssign(name, assigned);
    },
  });
}

// `process.env.NAME = value`. Node coerces the value to a string (so
// `env.X = undefined` reads back as the nine characters `undefined`) and
// refuses a symbol, because a symbol has no string form.
function __processEnvAssign(name: string, value: any): void {
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  const text: string = String(value);
  __processEnvState.values[name] = text;
  const ops: any = __procOps();
  if (ops !== undefined) ops.setEnv(name, text, false);
}

// The no-extension environment: the fixed name list, as accessors.
function __processBuildEnv(): any {
  const env: any = {};
  for (const name of __envNames) {
    if (host.envHas(name)) __processDefineEnvEntry(env, name, String(host.envGet(name)));
  }
  // The cmd.exe per-drive current directories: `=C:`, `=D:`, ...
  for (let letter = 65; letter <= 90; letter++) {
    const name = "=" + String.fromCharCode(letter) + ":";
    if (host.envHas(name)) __processDefineEnvEntry(env, name, String(host.envGet(name)));
  }
  return env;
}

const __processEnv: any = __processBuildEnv();

// Replace the snapshot with the real environment block, which only the
// extension can enumerate. Called once from `__processInstallNative`.
function __processRebuildEnv(ops: any): void {
  const payload: string = String(ops.environ());
  if (__procFailed(payload)) return;
  const fresh: any = {};
  __processEnvState.values = {};
  for (const record of __procRecords(payload)) {
    if (Number(record.length) < 1) continue;
    const name: string = record[0];
    if (name === "") continue;
    __processDefineEnvEntry(fresh, name, Number(record.length) > 1 ? record[1] : "");
  }
  process.env = fresh;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------
//
// One table per platform, which `process.kill` resolves a signal *name*
// through. It lives here rather than in `src/os/os.ts` on purpose: this file is
// in every bundle and `os` is not, and in Node both `os.constants.signals` and
// `process.kill` read the one table the `constants` binding publishes — so
// `src/os/os.ts` takes `signals` from here instead of carrying a second copy.
const __processSignalsWin32: any = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGABRT: 22,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGTERM: 15,
  SIGBREAK: 21,
  SIGWINCH: 28,
};

const __processSignalsPosix: any = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGIOT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGCHLD: 17,
  SIGSTKFLT: 16,
  SIGCONT: 18,
  SIGSTOP: 19,
  SIGTSTP: 20,
  SIGTTIN: 21,
  SIGTTOU: 22,
  SIGURG: 23,
  SIGXCPU: 24,
  SIGXFSZ: 25,
  SIGVTALRM: 26,
  SIGPROF: 27,
  SIGWINCH: 28,
  SIGIO: 29,
  SIGPOLL: 29,
  SIGPWR: 30,
  SIGSYS: 31,
};

function __processSignalTable(): any {
  return process.platform === "win32" ? __processSignalsWin32 : __processSignalsPosix;
}

// ---------------------------------------------------------------------------
// The process emitter
// ---------------------------------------------------------------------------

const __processEmitter: any = new EventEmitter();
// Node's `process` has no max-listeners warning for its own events.
__processEmitter.setMaxListeners(0);

// ---------------------------------------------------------------------------
// process.nextTick
//
// One FIFO queue drained by a single `queueMicrotask` pass; callbacks queued
// during the drain are picked up by the same pass, which is what Node does.
// `__processPendingTicks()` is what the harness epilogue watches to decide the
// loop has gone quiet.
//
// Node drains its own nextTick queue ahead of promise reactions; here the two
// share one queue, so a `nextTick` scheduled from inside a promise reaction
// runs after it rather than before. The relative order *within* the queue is
// FIFO, as in Node.
// ---------------------------------------------------------------------------

const __tickQueue: any = { items: [], scheduled: false };

// Process-wide state `process`'s own methods read and write.
const __processState: any = {
  umask: __isWindowsHost ? 0 : 0o022,
  title: undefined,
  sourceMaps: false,
  config: undefined,
  features: undefined,
  flags: undefined,
  execveWarned: false,
  loadedAt: Number(Date.now()),
};

function __processPendingTicks(): number {
  return Number(__tickQueue.items.length);
}

function __drainTicks(): void {
  __tickQueue.scheduled = false;
  while (Number(__tickQueue.items.length) > 0) {
    const entry: any = __tickQueue.items.shift();
    // A throw out of a tick callback is an uncaught exception in Node, not a
    // rejected microtask: it reaches `process.on('uncaughtException')` and, with
    // no listener, ends the process. That is what `test-process-next-tick.js`
    // measures, and the reason each callback runs inside a `try`.
    try {
      __evCall(entry.fn, entry.args);
    } catch (error) {
      __processReportUncaught(error);
    }
  }
}

function __processNextTick(fn: any, ...args: any[]): void {
  if (!__evIsFn(fn)) {
    throw new ERR_INVALID_ARG_TYPE("callback", "function", fn);
  }
  const passed: any[] = [];
  if (args !== undefined && args !== null) {
    const count = Number(args.length);
    for (let i = 0; i < count; i++) passed.push(args[i]);
  }
  const entry: any = { args: passed, fn: fn };
  __tickQueue.items.push(entry);
  if (!__tickQueue.scheduled) {
    __tickQueue.scheduled = true;
    queueMicrotask(__drainTicks);
  }
}

// ---------------------------------------------------------------------------
// Uncaught exceptions
// ---------------------------------------------------------------------------
//
// The engine has no "uncaught exception" hook: an error that escapes the main
// script ends the program before any JavaScript sees it. What *can* be routed
// here is every throw this library itself catches on a callback boundary — a
// `process.nextTick` callback and a timer callback — which is where Node's own
// corpus raises them. `src/timers/timers.ts` delegates to this function for
// exactly that reason, so the capture callback and the monitor event behave the
// same whichever boundary the throw crossed.
//
// `setUncaughtExceptionCaptureCallback` is therefore **best effort** and
// documented as such: it sees what this library catches, not what the engine
// swallows. `test-process-exception-capture.js` and
// `…-should-abort-on-uncaught.js` throw from the top level of the test and are
// out of reach; `…-errors.js`, which only exercises the validation, is not.
const __processUncaught: any = { callback: undefined };

function __processReportUncaught(error: any): void {
  if (Number(__processEmitter.listenerCount("uncaughtExceptionMonitor")) > 0) {
    __evEmit(__processEmitter, "uncaughtExceptionMonitor", [error, "uncaughtException"]);
  }
  const callback: any = __processUncaught.callback;
  if (callback !== undefined && callback !== null) {
    __evCall(callback, [error]);
    return;
  }
  if (Number(__processEmitter.listenerCount("uncaughtException")) > 0) {
    __evEmit(__processEmitter, "uncaughtException", [error]);
    return;
  }
  // Unhandled: Node prints the error and exits with code 1 (after running
  // 'exit' listeners). Rethrowing is not enough here — an exception that
  // escapes a macrotask is printed by the engine but the run still exits 0,
  // which made tests whose assertions live in a timer or observer callback
  // pass spuriously. So the crash is performed explicitly.
  let text = "";
  try {
    const stack: any = error !== null && error !== undefined ? error.stack : undefined;
    text = typeof stack === "string" && stack !== "" ? stack : String(error);
  } catch (ignored) {
    text = "Uncaught exception";
  }
  host.stderrWrite(text + "\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// process.emitWarning
// ---------------------------------------------------------------------------

// The warning a string `process.emitWarning(message, ...)` becomes. Node builds
// a plain `Error` and then assigns `name`, `code` and `detail` onto it; here
// every one of the three is a **declared field**, because writing an undeclared
// key onto a typed instance through an `any` alias poisons the instance and
// every later statically typed read of its own members — `warning.name`
// included, which is what a `process.on('warning')` listener reads
// (https://github.com/UrubuCode/zun/issues/37). `name` is a getter over
// `warningName` because `name` on an `Error` subclass cannot be assigned.
class ProcessWarning extends Error {
  code: string = "";
  detail: any = undefined;
  warningName: string = "Warning";
  constructor(message: string) {
    super(message);
  }
  get name(): string {
    return this.warningName;
  }
}

// `process.emitWarning(warning[, type[, code]][, ctor])`, with Node's full
// option grammar (`lib/internal/process/warning.js`):
//
//   * an object second argument carries `{ type, code, detail }`;
//   * a *function* second or third argument is the `ctor` stack-trace anchor,
//     which this runtime has no `captureStackTrace` to honour — it is accepted
//     and ignored, which is the whole of its observable contract here;
//   * `type` and `code`, when present and not a function, must be strings;
//   * a non-string, non-`Error` warning is `ERR_INVALID_ARG_TYPE`.
//
// `noDeprecation` and `throwDeprecation` are consulted **synchronously**, as in
// Node, so `process.noDeprecation = true` around an `emitWarning` call
// suppresses it even though the delivery itself is deferred.
function __processEmitWarning(warning: any, type?: any, code?: any, ctor?: any): void {
  let resolvedType: any = type;
  let resolvedCode: any = code;
  let detail: any = undefined;
  const _anchor: any = ctor;

  if (
    resolvedType !== null &&
    resolvedType !== undefined &&
    typeof resolvedType === "object" &&
    !Array.isArray(resolvedType)
  ) {
    resolvedCode = resolvedType.code;
    if (typeof resolvedType.detail === "string") detail = resolvedType.detail;
    const named: any = resolvedType.type;
    resolvedType = named === undefined || named === null || named === "" ? "Warning" : named;
  } else if (__evIsFn(resolvedType)) {
    resolvedCode = undefined;
    resolvedType = "Warning";
  }
  if (resolvedType !== undefined) __procValidateString(resolvedType, "type");
  if (__evIsFn(resolvedCode)) {
    resolvedCode = undefined;
  } else if (resolvedCode !== undefined) {
    __procValidateString(resolvedCode, "code");
  }

  let built: any = warning;
  if (typeof warning === "string") {
    const made = new ProcessWarning(warning);
    if (resolvedType !== undefined && resolvedType !== null) {
      made.warningName = String(resolvedType);
    }
    if (resolvedCode !== undefined && resolvedCode !== null) made.code = String(resolvedCode);
    if (detail !== undefined) made.detail = detail;
    built = made;
  } else if (!(warning instanceof Error)) {
    throw new ERR_INVALID_ARG_TYPE("warning", ["Error", "string"], warning);
  }

  const warningName: any = built.name;
  if (warningName === "DeprecationWarning") {
    if (process.noDeprecation === true) return;
    if (process.throwDeprecation === true) {
      __processNextTick(__processThrowWarning, built);
      return;
    }
  }
  // A warning is delivered on the next tick in Node; the tests observe it
  // through `process.on('warning')`, so the same deferral is kept.
  __processNextTick(__deliverWarning, built);
}

function __processThrowWarning(warning: any): void {
  throw warning;
}

function __deliverWarning(warning: any): void {
  if (Number(__processEmitter.listenerCount("warning")) > 0) {
    __evEmit(__processEmitter, "warning", [warning]);
    return;
  }
  const label: any = warning.name;
  host.stderrWrite(
    "(zun-node) " +
      (typeof label === "string" && label !== "" ? label : "Warning") +
      ": " +
      String(warning.message) +
      "\n",
  );
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

// `code` is `undefined` until something sets it, which is what `process.exit()`
// with no argument and `reallyExit` both resolve through `|| 0`.
const __exitState: any = { emitted: false, code: undefined };

function __processResolvedExitCode(): number {
  const code: any = __exitState.code;
  if (code === undefined || code === null) return 0;
  return Number(code);
}

// `process.exitCode = code`, with Node's coercion ladder: an integral numeric
// *string* becomes the number, and anything else must already be an integer.
function __processSetExitCode(code: any): void {
  if (code === undefined || code === null) {
    __exitState.code = undefined;
    return;
  }
  let value: any = code;
  if (typeof code === "string" && code !== "") {
    const parsed: number = Number(code);
    if (Number.isInteger(parsed)) value = parsed;
  }
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE("code", "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE("code", "an integer", value);
  }
  __exitState.code = value;
}

// Emit `process` 'exit' exactly once, with the resolved exit code, and answer
// the code to hand the host — read *after* the listeners have run, because an
// 'exit' listener may set `process.exitCode` and Node honours that (which is
// the whole of `test-process-exit-recursive.js`).
function __processRunExit(code?: any): number {
  if (code !== undefined && code !== null) __processSetExitCode(code);
  if (!__exitState.emitted) {
    __exitState.emitted = true;
    process._exiting = true;
    __evEmit(__processEmitter, "exit", [__processResolvedExitCode()]);
  }
  return __processResolvedExitCode();
}

// ---------------------------------------------------------------------------
// Native-backed values
// ---------------------------------------------------------------------------

// `process.hrtime()` / `process.hrtime.bigint()`.
//
// The native answers a decimal nanosecond count as *text*, so neither form
// loses a digit: the tuple is the text split at the last nine characters and
// the bigint is `BigInt` over the whole of it. A `Number` round trip would be
// exact only below 2^53 nanoseconds.
function __processHrtimeDigits(): string {
  const ops: any = __procOps();
  if (ops === undefined) {
    // NO-EXT: `Date.now()` is the only clock the host surface exposes, so the
    // resolution is a millisecond and the epoch is this module's load.
    const elapsed: number = Number(Date.now()) - Number(__processState.loadedAt);
    return String(elapsed >= 0 ? elapsed : 0) + "000000";
  }
  const payload: string = String(ops.hrtime());
  if (__procFailed(payload)) return "0";
  return __procPayload(payload);
}

function __processHrtime(time?: any): number[] {
  const digits: string = __processHrtimeDigits();
  const count: number = Number(digits.length);
  const seconds: number = count > 9 ? Number(digits.slice(0, count - 9)) : 0;
  const nanos: number = count > 9 ? Number(digits.slice(count - 9)) : Number(digits);
  if (time === undefined) return [seconds, nanos];
  if (!Array.isArray(time)) {
    throw new ERR_INVALID_ARG_TYPE("time", "Array", time);
  }
  if (Number(time.length) !== 2) {
    throw new ERR_OUT_OF_RANGE("time", "2", Number(time.length));
  }
  const diffSeconds: number = seconds - Number(time[0]);
  const diffNanos: number = nanos - Number(time[1]);
  // Node's borrow step, which is what keeps `hrtime([0, 1e9 - 1])[1] >= 0`.
  if (diffNanos < 0) return [diffSeconds - 1, diffNanos + 1000000000];
  return [diffSeconds, diffNanos];
}

function __processHrtimeBigInt(): any {
  return BigInt(__processHrtimeDigits());
}

function __processUptime(): number {
  const ops: any = __procOps();
  if (ops === undefined) {
    // NO-EXT: seconds since this module was loaded, which is the closest thing
    // to a process start time the host surface can answer.
    return (Number(Date.now()) - Number(__processState.loadedAt)) / 1000;
  }
  const payload: string = String(ops.uptime());
  if (__procFailed(payload)) return 0;
  return Number(__procPayload(payload));
}

// `process.cpuUsage([prevValue])` and `process.threadCpuUsage([prevValue])`
// share one body: the same validation, the same subtraction, a different
// native. Node's validation *order* is reproduced exactly — the `user`
// property's type and then its value, then `system`'s — because the corpus
// compares the message of each.
function __processCpuUsageOf(which: string, prev?: any): any {
  const given: boolean = __processIsGivenPrev(prev);
  if (given) {
    if (!__processPrevIsValid(prev, "user")) {
      __evValidateObject(prev, "prevValue");
      __procValidateNumberType(prev.user, "prevValue.user");
      throw new ERR_INVALID_ARG_VALUE_RANGE("prevValue.user", prev.user);
    }
    if (!__processPrevIsValid(prev, "system")) {
      __procValidateNumberType(prev.system, "prevValue.system");
      throw new ERR_INVALID_ARG_VALUE_RANGE("prevValue.system", prev.system);
    }
  }
  const ops: any = __procOps();
  let user: number = 0;
  let system: number = 0;
  if (ops !== undefined) {
    const payload: string = String(which === "thread" ? ops.threadCpuUsage() : ops.cpuUsage());
    if (!__procFailed(payload)) {
      const row: string[] = __procFields(payload);
      if (Number(row.length) === 2) {
        user = Number(row[0]);
        system = Number(row[1]);
      }
    }
  }
  if (given) {
    return { user: user - Number(prev.user), system: system - Number(prev.system) };
  }
  return { user: user, system: system };
}

// Node's `if (prevValue)`, spelled out: a falsy previous value is simply not
// one. The comparisons are explicit because `!x` on an `any` holding an empty
// string is unreliable here (zun#13).
function __processIsGivenPrev(prev: any): boolean {
  if (prev === undefined || prev === null) return false;
  if (prev === false || prev === 0 || prev === "") return false;
  return true;
}

// Node's `previousValueIsValid`: a non-negative number no larger than
// `Number.MAX_SAFE_INTEGER`. Reading the property off a non-object answers
// `undefined`, which is invalid, which is what routes `cpuUsage(1)` into the
// `validateObject` branch.
function __processPrevIsValid(prev: any, field: string): boolean {
  const value: any = field === "user" ? prev.user : prev.system;
  if (typeof value !== "number") return false;
  return value >= 0 && value <= __PROC_MAX_SAFE;
}

function __processMemoryUsage(): any {
  return {
    rss: __processRss(),
    heapTotal: 0,
    heapUsed: 0,
    external: 0,
    arrayBuffers: 0,
  };
}

// `process.memoryUsage().rss` and `process.memoryUsage.rss()` read the same
// native. The four heap figures are **zero and documented**: Node takes them
// from V8's heap statistics and this runtime's host surface exposes none, so a
// made-up number would be worse than an obvious one.
function __processRss(): number {
  const ops: any = __procOps();
  if (ops === undefined) return 0;
  const payload: string = String(ops.memoryUsage());
  if (__procFailed(payload)) return 0;
  return Number(__procPayload(payload));
}

// Node's `resourceUsage()` keys, in the order the native reports them.
const __PROC_RUSAGE_KEYS: string[] = [
  "userCPUTime",
  "systemCPUTime",
  "maxRSS",
  "sharedMemorySize",
  "unsharedDataSize",
  "unsharedStackSize",
  "minorPageFault",
  "majorPageFault",
  "swappedOut",
  "fsRead",
  "fsWrite",
  "ipcSent",
  "ipcReceived",
  "signalsCount",
  "voluntaryContextSwitches",
  "involuntaryContextSwitches",
];

function __processResourceUsage(): any {
  const usage: any = {};
  for (const key of __PROC_RUSAGE_KEYS) usage[key] = 0;
  const ops: any = __procOps();
  if (ops === undefined) return usage;
  const payload: string = String(ops.resourceUsage());
  if (__procFailed(payload)) return usage;
  const row: string[] = __procFields(payload);
  const count: number = Number(row.length);
  const keyCount: number = Number(__PROC_RUSAGE_KEYS.length);
  for (let i = 0; i < count && i < keyCount; i++) {
    usage[__PROC_RUSAGE_KEYS[i]] = Number(row[i]);
  }
  return usage;
}

function __processAvailableMemory(): number {
  const ops: any = __procOps();
  if (ops === undefined) return 0;
  return Number(ops.availableMemory());
}

function __processConstrainedMemory(): number {
  const ops: any = __procOps();
  if (ops === undefined) return 0;
  return Number(ops.constrainedMemory());
}

// `process.umask([mask])`.
//
// With the extension this is the real mask, read by the set-and-restore
// sequence libuv uses (POSIX `umask` has no reading form). NO-EXT: the value is
// the platform's own default — 0 on Windows, where there is no umask and Node
// reports 0, and 0o022 on POSIX, which is what every mainstream distribution
// and CI image sets — and a program that *changes* it is remembered, so
// `umask(m)` followed by `umask()` is consistent either way.
function __processUmask(mask?: any): number {
  if (mask === undefined || mask === null) {
    const ops: any = __procOps();
    if (ops === undefined) return Number(__processState.umask);
    const payload: string = String(ops.umask(0, false));
    if (__procFailed(payload)) throw __procErrnoException("umask");
    return Number(__procPayload(payload));
  }
  const parsed: number = __procParseFileMode(mask, "mask");
  const ops: any = __procOps();
  if (ops === undefined) {
    const previous: number = Number(__processState.umask);
    __processState.umask = parsed;
    return previous;
  }
  const payload: string = String(ops.umask(parsed, true));
  if (__procFailed(payload)) throw __procErrnoException("umask");
  return Number(__procPayload(payload));
}

function __processChdir(directory: any): void {
  __procValidateString(directory, "directory");
  const ops: any = __procOps();
  if (ops === undefined) throw new ERR_METHOD_NOT_IMPLEMENTED("process.chdir");
  const payload: string = String(ops.chdir(directory));
  if (__procFailed(payload)) throw __procUvException();
}

// `process.kill(pid[, signal])`, Node's own algorithm: validate the pid, map a
// signal *name* through the platform table, and hand the pair to
// `process._kill` — which is read as a property rather than closed over,
// precisely because `test-process-kill-pid.js` monkey-patches it.
function __processKill(pid: any, signal?: any): boolean {
  // Node's test is `pid != +pid`, which accepts a numeric string but rejects
  // `null`, `undefined`, a boolean, a non-numeric string and a non-finite
  // number.
  const coerced: number = Number(pid);
  if (
    pid === null ||
    pid === undefined ||
    typeof pid === "boolean" ||
    Number.isNaN(coerced) ||
    !Number.isFinite(coerced)
  ) {
    throw new ERR_INVALID_ARG_TYPE("pid", "number", pid);
  }
  const table: any = __processSignalTable();
  let resolved: any = undefined;
  if (signal === undefined) {
    resolved = Number(table.SIGTERM);
  } else if (typeof signal === "string") {
    const found: any = table[signal];
    if (found === undefined) throw new ERR_UNKNOWN_SIGNAL(signal);
    resolved = Number(found);
  } else if (typeof signal === "number") {
    resolved = signal;
  } else {
    throw new ERR_INVALID_ARG_TYPE("signal", ["string", "number"], signal);
  }
  const killer: any = process._kill;
  const failure: any = __evCall(killer, [pid, resolved]);
  if (failure !== undefined && failure !== null && failure !== 0 && failure !== false) {
    throw failure;
  }
  return true;
}

// `process._kill(pid, signal)` — the binding half, which is what a test
// replaces. It *answers* the error rather than throwing it, so the thrower
// stays in `process.kill` where Node has it.
function __processRawKill(pid: any, signal: any): any {
  const ops: any = __procOps();
  if (ops === undefined) return new ERR_METHOD_NOT_IMPLEMENTED("process.kill");
  const payload: string = String(ops.kill(Number(pid), Number(signal)));
  if (__procFailed(payload)) return __procErrnoException("kill");
  return undefined;
}

function __processAbort(): void {
  const ops: any = __procOps();
  if (ops !== undefined) {
    ops.abort();
    return;
  }
  // NO-EXT: there is no way to raise SIGABRT from the host surface, so the
  // conventional shell status for it (128 + SIGABRT) is the closest answer.
  host.exitProcess(134);
}

// The five POSIX credential getters. Each reads the whole record, because the
// native answers all of them in one call and a program that asks for one
// usually asks for the next.
function __processCredentialField(index: number): any {
  const ops: any = __procOps();
  if (ops === undefined) return undefined;
  const payload: string = String(ops.credentials());
  if (__procFailed(payload)) return undefined;
  const row: string[] = __procFields(payload);
  if (Number(row.length) <= index) return undefined;
  return row[index];
}

function __processGetuid(): number {
  return Number(__processCredentialField(0));
}

function __processGetgid(): number {
  return Number(__processCredentialField(1));
}

function __processGeteuid(): number {
  return Number(__processCredentialField(2));
}

function __processGetegid(): number {
  return Number(__processCredentialField(3));
}

function __processGetgroups(): number[] {
  const field: any = __processCredentialField(4);
  const groups: number[] = [];
  if (field === undefined || String(field) === "") return groups;
  for (const entry of String(field).split(",")) {
    if (entry !== "") groups.push(Number(entry));
  }
  return groups;
}

function __procValidateArray(value: any, name: string): void {
  if (!Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
  }
}

// `process.execve(execPath[, args[, env]])`.
//
// Node 25 defines it everywhere and implements it only on POSIX: on Windows and
// IBM i it raises `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, which is what
// `test-process-execve-validation.js`' else-branch asserts. The validation is
// Node's, argument for argument — a string `execPath`, an `args` array whose
// every element is a string without a NUL, and an `env` object whose every key
// and value is a string without a NUL.
//
// Replacing the process image itself is **not** implemented: `execve(2)` has no
// Windows equivalent at all, and on POSIX it would replace this runtime with
// another program mid-run, which an extension function cannot do without the
// host's cooperation (the engine would be executing JavaScript on a stack that
// no longer exists). So a call that passes validation raises
// `ERR_METHOD_NOT_IMPLEMENTED` — after the validation, so every error Node's
// own test expects is the error it gets.
function __processExecve(execPath?: any, args?: any, env?: any): void {
  if (!__processState.execveWarned) {
    __processState.execveWarned = true;
    __processEmitWarning(
      "process.execve is an experimental feature and might change at any time",
      "ExperimentalWarning",
    );
  }
  if (process.platform === "win32") {
    throw new ERR_FEATURE_UNAVAILABLE_ON_PLATFORM("process.execve");
  }
  __procValidateString(execPath, "execPath");
  const argv: any = args === undefined ? [] : args;
  __procValidateArray(argv, "args");
  const count: number = Number(argv.length);
  for (let i = 0; i < count; i++) {
    if (!__processIsCleanString(argv[i])) {
      throw new ERR_INVALID_ARG_VALUE(
        "args[" + String(i) + "]",
        argv[i],
        "must be a string without null bytes",
      );
    }
  }
  const block: any = env === undefined ? process.env : env;
  __evValidateObject(block, "env");
  for (const key of Object.keys(block)) {
    if (!__processIsCleanString(key) || !__processIsCleanString(block[key])) {
      throw new ERR_INVALID_ARG_VALUE(
        "env",
        block,
        "must be an object with string keys and values without null bytes",
      );
    }
  }
  throw new ERR_METHOD_NOT_IMPLEMENTED("process.execve");
}

// A string with no NUL in it, which is what `execve(2)`'s argument and
// environment vectors require. `indexOf` is used rather than `charCodeAt` over
// the whole string because a NUL cannot appear in a path on either platform and
// this is the cheap test for the rest.
function __processIsCleanString(value: any): boolean {
  if (typeof value !== "string") return false;
  return Number(value.indexOf(String.fromCharCode(0))) === -1;
}

// `process.title`.
function __processTitleGet(): string {
  const remembered: any = __processState.title;
  if (remembered !== undefined) return String(remembered);
  const ops: any = __procOps();
  if (ops === undefined) {
    // NO-EXT: the basename of `argv[0]`, which is what libuv reports when it
    // has no console title to read either.
    return __processBasename(String(__processArgvSplit.argv0));
  }
  const payload: string = String(ops.title());
  if (__procFailed(payload)) return __processBasename(String(__processArgvSplit.argv0));
  return __procPayload(payload);
}

// The value is remembered here as well as pushed to the OS, because what the
// platform can actually rewrite differs (the console title on Windows, the
// thread name on Linux) while `process.title` must round-trip exactly. See
// `src/process/sys/*.rs`.
function __processTitleSet(value: any): void {
  const text: string = String(value);
  __processState.title = text;
  const ops: any = __procOps();
  if (ops !== undefined) ops.setTitle(text);
}

function __processIsTty(fd: number): boolean {
  const ops: any = __procOps();
  if (ops === undefined) {
    // NO-EXT: the host surface has one `isTty()` flag, for its own stdout.
    return fd === 1 ? host.isTty() : false;
  }
  return ops.isTty(fd) === true;
}

// ---------------------------------------------------------------------------
// process.config, process.features
// ---------------------------------------------------------------------------

// `process.config` is Node's `config.gypi` as an object. This runtime is not
// built by GYP, so the values describe **this** build rather than pretending to
// be a Node one: there is no shared library, no OpenSSL, no ICU and no addon
// ABI, and the architecture is the one the engine reports. It is frozen, as
// Node freezes it — `process.config.variables = 42` must throw.
function __processBuildConfig(): any {
  const variables: any = {
    host_arch: process.arch,
    target_arch: process.arch,
    node_shared: false,
    node_use_openssl: false,
    node_module_version: 0,
    napi_build_version: "0",
    v8_enable_i18n_support: 0,
    asan: 0,
  };
  const defaults: any = {
    cflags: [],
    default_configuration: "Release",
    defines: [],
    include_dirs: [],
    libraries: [],
  };
  Object.freeze(variables);
  Object.freeze(defaults);
  return Object.freeze({ target_defaults: defaults, variables: variables });
}

// `process.features`, with Node 25's exact key set and an honest value for
// each. Nothing here is aspirational: this runtime has no inspector, is not a
// debug build, does not embed libuv, has no TLS stack at all, and *compiles*
// TypeScript rather than stripping types from it — which is what `"transform"`
// means in Node's own spelling of this flag.
function __processBuildFeatures(): any {
  return {
    inspector: false,
    debug: false,
    uv: false,
    ipv6: true,
    openssl_is_boringssl: false,
    quic: false,
    tls_alpn: false,
    tls_sni: false,
    tls_ocsp: false,
    tls: false,
    cached_builtins: true,
    require_module: false,
    typescript: "transform",
  };
}

// ---------------------------------------------------------------------------
// process.allowedNodeEnvironmentFlags
// ---------------------------------------------------------------------------

// Node's `NodeEnvironmentFlagsSet`, shape for shape (`lib/internal/process/
// per_thread.js`): a `Set` subclass whose membership, size and iteration all
// come from an internal array rather than from the `Set` backing, so `add`,
// `delete` and `clear` can be no-ops and still leave the set self-consistent.
// `has` normalizes `_` to `-` and supplies the leading dashes, which is why
// `allowedNodeEnvironmentFlags.has('no-deprecation')` is true.
//
// The membership is the set of flags **this runtime honours** in
// `NODE_OPTIONS`, which is the contract of the property — not Node's own flag
// list, which this runtime does not implement and would be a lie to advertise.
class NodeEnvironmentFlagsSet extends Set {
  flagList: string[] = [];
  constructor(flags: string[]) {
    super();
    this.flagList = flags;
  }
  add(): any {
    return this;
  }
  delete(): boolean {
    return false;
  }
  clear(): void {}
  get size(): number {
    return Number(this.flagList.length);
  }
  has(key: any): boolean {
    if (typeof key !== "string") return false;
    const normalized: string = key.split("_").join("-");
    const cut: number = Number(normalized.indexOf("="));
    const bare: string = cut === -1 ? normalized : normalized.slice(0, cut);
    if (bare.charAt(0) === "-") {
      return Number(this.flagList.indexOf(bare)) !== -1;
    }
    return (
      Number(this.flagList.indexOf("--" + bare)) !== -1 ||
      Number(this.flagList.indexOf("-" + bare)) !== -1
    );
  }
  forEach(fn: any, thisArg?: any): void {
    const _receiver: any = thisArg;
    for (const flag of this.flagList) __evCall(fn, [flag, flag, this]);
  }
  values(): any {
    return this.flagList[Symbol.iterator]();
  }
  keys(): any {
    return this.flagList[Symbol.iterator]();
  }
  entries(): any {
    const pairs: any[] = [];
    for (const flag of this.flagList) pairs.push([flag, flag]);
    return pairs[Symbol.iterator]();
  }
  [Symbol.iterator](): any {
    return this.flagList[Symbol.iterator]();
  }
}

// The Node-style options this library actually honours, which is what
// `process.allowedNodeEnvironmentFlags` is for. Each one is read out of
// `NODE_OPTIONS` at load (see `__processApplyNodeOptions`).
const __PROC_ALLOWED_FLAGS: string[] = [
  "--no-deprecation",
  "--no-warnings",
  "--pending-deprecation",
  "--throw-deprecation",
  "--title",
  "--trace-deprecation",
];

// `NODE_OPTIONS`, reduced to the flags above. Node parses the variable itself;
// this runtime's CLI does not, so the parse happens here — which is the only
// way `process.noDeprecation` can be true for a program that asked for it. The
// engine's own option vector is scanned too, which is how a `--title=foo`
// reaches a program the CLI started.
function __processApplyNodeOptions(): void {
  const words: string[] = [];
  const raw: any = __processEnvGet("NODE_OPTIONS");
  if (typeof raw === "string" && raw !== "") {
    for (const word of raw.split(" ")) {
      if (word !== "") words.push(word);
    }
  }
  for (const word of __processArgvSplit.execArgv) words.push(String(word));
  for (const word of words) {
    if (word === "--no-deprecation") {
      process.noDeprecation = true;
    } else if (word === "--throw-deprecation") {
      process.throwDeprecation = true;
    } else if (word === "--trace-deprecation") {
      process.traceDeprecation = true;
    } else if (word.slice(0, 8) === "--title=") {
      __processTitleSet(word.slice(8));
    }
  }
}

// ---------------------------------------------------------------------------
// process.binding
// ---------------------------------------------------------------------------

// The sixteen predicates Node's `util` binding publishes, which are the same
// functions `util.types` exposes — in Node literally so: `util.types` *is* that
// binding's surface. So `process.binding('util')` is a projection of
// `util.types` rather than a second implementation.
const __PROC_UTIL_BINDING_KEYS: string[] = [
  "isAnyArrayBuffer",
  "isArrayBuffer",
  "isArrayBufferView",
  "isAsyncFunction",
  "isDataView",
  "isDate",
  "isExternal",
  "isMap",
  "isMapIterator",
  "isNativeError",
  "isPromise",
  "isRegExp",
  "isSet",
  "isSetIterator",
  "isTypedArray",
  "isUint8Array",
];

// `process.binding(name)`.
//
// Node 25 still has it, deprecated, over an allowlist of internal bindings.
// This runtime has exactly one of those surfaces — the `util` predicates — and
// no way to fabricate the rest, so every other name is the `No such module`
// error Node raises for a name outside its own list. Nothing is stubbed into
// existence: a program that asks for `fs_event_wrap` is told there is none.
function __processBinding(name: any): any {
  __procValidateString(name, "name");
  if (name === "util") {
    const binding: any = {};
    for (const key of __PROC_UTIL_BINDING_KEYS) {
      binding[key] = __node_util_types[key];
    }
    return binding;
  }
  throw new Error("No such module: " + String(name));
}

// ---------------------------------------------------------------------------
// The standard streams
// ---------------------------------------------------------------------------
//
// Minimal writable/readable shims, not `node:stream` objects: `node:stream` is
// its own library in the roadmap and is being built separately, so these are
// written to be *replaceable* rather than to pretend. What they do have is the
// part every consumer here actually touches — `write`, `fd`, `isTTY`,
// `columns`/`rows` and an inert `EventEmitter` surface — and `process.stdout`
// stays an assignable property, so the stream module can hand over a real
// `WriteStream` the day it exists.
//
// `columns` and `rows` are `undefined` unless the descriptor is a character
// device, which is what Node reports for a redirected stdout. A real console
// size would need one more native and no test in the corpus reads it.
const __processStdout: any = {
  fd: 1,
  writable: true,
  readable: false,
  isTTY: false,
  columns: undefined,
  rows: undefined,
  write(text: any): boolean {
    host.stdoutWrite(String(text));
    return true;
  },
  end(text?: any): any {
    if (text !== undefined && text !== null) host.stdoutWrite(String(text));
    return __processStdout;
  },
  cork(): void {},
  uncork(): void {},
  destroy(): any {
    return __processStdout;
  },
  on(): any {
    return __processStdout;
  },
  once(): any {
    return __processStdout;
  },
  off(): any {
    return __processStdout;
  },
  removeListener(): any {
    return __processStdout;
  },
  emit(): boolean {
    return false;
  },
  setEncoding(): any {
    return __processStdout;
  },
  ref(): any {
    return __processStdout;
  },
  unref(): any {
    return __processStdout;
  },
};

const __processStderr: any = {
  fd: 2,
  writable: true,
  readable: false,
  isTTY: false,
  columns: undefined,
  rows: undefined,
  write(text: any): boolean {
    host.stderrWrite(String(text));
    return true;
  },
  end(text?: any): any {
    if (text !== undefined && text !== null) host.stderrWrite(String(text));
    return __processStderr;
  },
  cork(): void {},
  uncork(): void {},
  destroy(): any {
    return __processStderr;
  },
  on(): any {
    return __processStderr;
  },
  once(): any {
    return __processStderr;
  },
  off(): any {
    return __processStderr;
  },
  removeListener(): any {
    return __processStderr;
  },
  emit(): boolean {
    return false;
  },
  setEncoding(): any {
    return __processStderr;
  },
  ref(): any {
    return __processStderr;
  },
  unref(): any {
    return __processStderr;
  },
};

// `process.stdin`. `host.stdinLine()` is the one input primitive the runtime
// exposes, so `read()` answers a line at a time and the event interface is
// inert rather than fabricated — which is the honest shape until `node:stream`
// lands.
const __processStdin: any = {
  fd: 0,
  writable: false,
  readable: true,
  isTTY: false,
  read(): any {
    const line: string = host.stdinLine();
    return line === "" ? null : line + "\n";
  },
  resume(): any {
    return __processStdin;
  },
  pause(): any {
    return __processStdin;
  },
  isPaused(): boolean {
    return true;
  },
  setEncoding(): any {
    return __processStdin;
  },
  setRawMode(): any {
    return __processStdin;
  },
  destroy(): any {
    return __processStdin;
  },
  on(): any {
    return __processStdin;
  },
  once(): any {
    return __processStdin;
  },
  off(): any {
    return __processStdin;
  },
  removeListener(): any {
    return __processStdin;
  },
  emit(): boolean {
    return false;
  },
  ref(): any {
    return __processStdin;
  },
  unref(): any {
    return __processStdin;
  },
};

// ---------------------------------------------------------------------------
// process
// ---------------------------------------------------------------------------

const process: any = {
  // NO-EXT: both are derived rather than reported; `__processInstallNative`
  // replaces them with the compile-time truth.
  platform: __isWindowsHost ? "win32" : "linux",
  arch: "x64",
  // NO-EXT: `zun:core` reports no pid, and this file must keep compiling with
  // no extension loaded. `0` is the documented placeholder; the extension
  // installs the real pid (and the parent's) from `procFacts`.
  pid: 0,
  ppid: 0,
  execPath: String(__processArgvSplit.argv0),
  argv0: String(__processArgvSplit.argv0),
  argv: __processBuildArgv(String(__processArgvSplit.argv0)),
  execArgv: __processArgvSplit.execArgv,
  version: "v25.0.0",
  // Honest, and deliberately short: this runtime embeds no V8, no libuv, no
  // OpenSSL and no ICU, so advertising their versions would be a lie. `node` is
  // the Node release whose behaviour this library targets, which is what every
  // consumer of `process.versions.node` is asking about; `zun` is the engine
  // underneath. An absent key is the honest answer for an absent component —
  // `process.versions.icu` is `undefined`, and the corpus's
  // `if (process.versions.icu)` branches take the right path because of it.
  versions: { node: "25.0.0", zun: "0.0.0" },
  release: { name: "node", sourceUrl: "", headersUrl: "" },
  env: __processEnv,
  // The deprecation flags, which Node exposes as plain writable properties and
  // `emitWarning` reads synchronously.
  noDeprecation: false,
  throwDeprecation: false,
  traceDeprecation: false,
  // Set once `process.exit` or the harness has begun exiting, as in Node.
  _exiting: false,

  cwd(): string {
    return __processCwd();
  },
  chdir(directory?: any): void {
    __processChdir(directory);
  },
  // Escape hatch for a variable outside the no-extension snapshot list.
  envLookup(name: string): any {
    return __processEnvGet(name);
  },

  // ---- exit --------------------------------------------------------------

  // Node's `process.exit`: set the code if one was given, emit 'exit' once, and
  // then hand the *current* code to `reallyExit` — so an 'exit' listener that
  // calls `process.exit(0)` wins over the `process.exit(1)` that started it,
  // and a second `process.exit` from inside the listener does not re-emit.
  exit(code?: any): void {
    const resolved: number = __processRunExit(code);
    const exiter: any = process.reallyExit;
    __evCall(exiter, [resolved]);
  },
  // The binding half, which Node also exposes and tests replace.
  reallyExit(code?: any): void {
    host.exitProcess(code === undefined || code === null ? 0 : Number(code));
  },
  abort(): void {
    __processAbort();
  },
  execve(execPath?: any, args?: any, env?: any): void {
    __processExecve(execPath, args, env);
  },

  // ---- EventEmitter surface, delegated to `__processEmitter` --------------

  on(type: any, listener: any): any {
    __processEmitter.on(type, listener);
    return process;
  },
  addListener(type: any, listener: any): any {
    __processEmitter.on(type, listener);
    return process;
  },
  once(type: any, listener: any): any {
    __processEmitter.once(type, listener);
    return process;
  },
  prependListener(type: any, listener: any): any {
    __processEmitter.prependListener(type, listener);
    return process;
  },
  prependOnceListener(type: any, listener: any): any {
    __processEmitter.prependOnceListener(type, listener);
    return process;
  },
  off(type: any, listener: any): any {
    __processEmitter.off(type, listener);
    return process;
  },
  removeListener(type: any, listener: any): any {
    __processEmitter.removeListener(type, listener);
    return process;
  },
  removeAllListeners(type?: any): any {
    if (type === undefined) {
      __processEmitter.removeAllListeners();
    } else {
      __processEmitter.removeAllListeners(type);
    }
    return process;
  },
  // An object-literal method can carry a rest parameter (a class method cannot),
  // so `process.emit` forwards the full argument list.
  emit(type: any, ...args: any[]): boolean {
    const passed: any[] = [];
    if (args !== undefined && args !== null) {
      const count = Number(args.length);
      for (let i = 0; i < count; i++) passed.push(args[i]);
    }
    return __evEmit(__processEmitter, type, passed);
  },
  listeners(type?: any): any[] {
    return __processEmitter.listeners(type);
  },
  rawListeners(type?: any): any[] {
    return __processEmitter.rawListeners(type);
  },
  listenerCount(type: any, listener?: any): number {
    if (listener === undefined) return Number(__processEmitter.listenerCount(type));
    return Number(__processEmitter.listenerCount(type, listener));
  },
  eventNames(): any[] {
    return __processEmitter.eventNames();
  },
  setMaxListeners(n: any): any {
    __processEmitter.setMaxListeners(n);
    return process;
  },
  getMaxListeners(): number {
    return Number(__processEmitter.getMaxListeners());
  },

  // ---- scheduling and diagnostics ----------------------------------------

  nextTick(fn: any, ...args: any[]): void {
    const passed: any[] = [];
    if (args !== undefined && args !== null) {
      const count = Number(args.length);
      for (let i = 0; i < count; i++) passed.push(args[i]);
    }
    __processNextTick(fn, ...passed);
  },
  emitWarning(warning: any, type?: any, code?: any, ctor?: any): void {
    __processEmitWarning(warning, type, code, ctor);
  },
  umask(mask?: any): number {
    return __processUmask(mask);
  },
  uptime(): number {
    return __processUptime();
  },
  cpuUsage(prev?: any): any {
    return __processCpuUsageOf("process", prev);
  },
  threadCpuUsage(prev?: any): any {
    return __processCpuUsageOf("thread", prev);
  },
  resourceUsage(): any {
    return __processResourceUsage();
  },
  availableMemory(): number {
    return __processAvailableMemory();
  },
  constrainedMemory(): number {
    return __processConstrainedMemory();
  },
  kill(pid: any, signal?: any): boolean {
    return __processKill(pid, signal);
  },
  _kill(pid: any, signal: any): any {
    return __processRawKill(pid, signal);
  },
  _rawDebug(...args: any[]): void {
    const parts: string[] = [];
    const count: number = Number(args.length);
    for (let i = 0; i < count; i++) parts.push(String(args[i]));
    host.stderrWrite(parts.join(" ") + "\n");
  },
  binding(name?: any): any {
    return __processBinding(name);
  },
  // `process.dlopen` loads a native addon, which this runtime cannot do: an
  // addon is built against Node's own C++ ABI. The error says so rather than
  // failing somewhere further in.
  dlopen(module?: any, filename?: any): void {
    __evValidateObject(module, "module");
    const _path: any = filename;
    throw new ERR_DLOPEN_FAILED(
      "process.dlopen cannot load a native addon: this runtime has no Node addon ABI",
    );
  },
  setSourceMapsEnabled(value?: any): void {
    __evValidateBoolean(value, "val");
    __processState.sourceMaps = value;
  },
  getSourceMapsSupport(): any {
    return {
      enabled: __processState.sourceMaps === true,
      nodeModules: false,
      generatedCode: false,
    };
  },
  setUncaughtExceptionCaptureCallback(fn?: any): void {
    if (fn === null) {
      __processUncaught.callback = undefined;
      return;
    }
    if (!__evIsFn(fn)) {
      throw new ERR_INVALID_ARG_TYPE("fn", ["function", "null"], fn);
    }
    if (__processUncaught.callback !== undefined) {
      throw new ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET();
    }
    __processUncaught.callback = fn;
  },
  hasUncaughtExceptionCaptureCallback(): boolean {
    return __processUncaught.callback !== undefined;
  },
  // `process.getActiveResourcesInfo()` — the provider names of everything
  // keeping the loop alive. Timers are the only kind of handle this runtime
  // has, and `src/timers/timers.ts` reports them.
  getActiveResourcesInfo(): string[] {
    return __timerActiveResources();
  },
  _getActiveHandles(): any[] {
    return [];
  },
  _getActiveRequests(): any[] {
    return [];
  },
  // `process.ref` / `process.unref`: Node 25's generic refcount hooks, which
  // accept either the `nodejs.ref` symbol protocol or the legacy
  // `ref()`/`unref()` pair.
  ref(maybe?: any): void {
    __processRefOrUnref(maybe, true);
  },
  unref(maybe?: any): void {
    __processRefOrUnref(maybe, false);
  },

  stdout: __processStdout,
  stderr: __processStderr,
  stdin: __processStdin,
};

// `process.ref(x)` / `process.unref(x)`.
function __processRefOrUnref(maybe: any, wantRef: boolean): void {
  if (maybe === null || maybe === undefined || typeof maybe !== "object") {
    throw new ERR_INVALID_ARG_TYPE("maybeRefable", "object", maybe);
  }
  const key: any = wantRef ? Symbol.for("nodejs.ref") : Symbol.for("nodejs.unref");
  const hook: any = maybe[key];
  if (__evIsFn(hook)) {
    __evCall(hook, []);
    return;
  }
  const legacy: any = wantRef ? maybe.ref : maybe.unref;
  if (__evIsFn(legacy)) {
    if (wantRef) {
      maybe.ref();
    } else {
      maybe.unref();
    }
    return;
  }
  throw new ERR_INVALID_ARG_TYPE("maybeRefable", "object", maybe);
}

// ---------------------------------------------------------------------------
// The accessors and the function-valued properties
// ---------------------------------------------------------------------------

// `process.exitCode`, with Node's validation on the way in. It is deliberately
// **not configurable**: `delete process.exitCode` must fail, which is what
// `test-process-exit-code-validation.js` checks, and this engine raises a
// `TypeError` for a `delete` of a non-configurable property.
Object.defineProperty(process, "exitCode", {
  configurable: false,
  enumerable: true,
  get(): any {
    return __exitState.code;
  },
  set(code: any): void {
    __processSetExitCode(code);
  },
});

Object.defineProperty(process, "title", {
  configurable: true,
  enumerable: true,
  get(): string {
    return __processTitleGet();
  },
  set(value: any): void {
    __processTitleSet(value);
  },
});

// `config`, `features` and `allowedNodeEnvironmentFlags` are plain **data**
// properties rather than the lazy getters they would naturally be, because an
// accessor property is invisible to `Object.hasOwn` and `hasOwnProperty` in this
// engine — `Object.keys`, `in` and `Object.getOwnPropertyNames` all see it, and
// those two answer `false`. `test-process-config.js` opens with
// `assert(Object.hasOwn(process, 'config'))`, so a getter fails it on the first
// line. Minimal repro:
//
//     const o = {};
//     Object.defineProperty(o, 'g', { enumerable: true, get() { return 1; } });
//     Object.hasOwn(o, 'g');            // false in zun, true in node
//     Object.keys(o);                   // ["g"] in both
//
// `config` reads `process.arch`, which the extension replaces, so
// `__processInstallNative` rebuilds it; the other two depend on nothing.
process.config = __processBuildConfig();
process.features = __processBuildFeatures();
process.allowedNodeEnvironmentFlags = Object.freeze(
  new NodeEnvironmentFlagsSet(__PROC_ALLOWED_FLAGS),
);

// `process.hrtime` and `process.memoryUsage` are the two places Node hangs a
// property off a function (`hrtime.bigint`, `memoryUsage.rss`), so neither can
// be an ordinary object-literal method: a method is callable but there is no
// handle on it to hang anything from.
//
// The spelling that works is a **plain assignment of a top-level function**,
// followed by a plain assignment of the second function onto the first.
// Measured on this engine, of the five shapes a callable property can take,
// three behave and two do not:
//
//   * `obj.f = <top-level function>`; `obj.f()`              — works
//   * `obj.f = function () {...}`; `obj.f.g = ...`; `obj.f.g()` — works
//   * an object-literal method, and a property written onto it — works
//   * `__evBox(fn)` stored on a property: `typeof` says `"function"` but
//     `obj.f()` throws `f is not a function` — the box is callable only
//     through a bare identifier
//   * `Object.defineProperty(obj, 'f', { value: fn })`: same throw
//
// So these four assignments are deliberately plain, and must stay plain.
process.hrtime = __processHrtime;
process.hrtime.bigint = __processHrtimeBigInt;
process.memoryUsage = __processMemoryUsage;
process.memoryUsage.rss = __processRss;

// ---------------------------------------------------------------------------
// Installing the natives
// ---------------------------------------------------------------------------

// Called once, from `src/process/native.ts`, which is the only file that names
// the `node:process` extension. Everything that can only be learned from a
// syscall is replaced here; everything else was already right.
function __processInstallNative(ops: any): void {
  __processNativeState.ops = ops;

  const payload: string = String(ops.facts());
  if (!__procFailed(payload)) {
    const row: string[] = __procFields(payload);
    if (Number(row.length) >= 5) {
      process.pid = Number(row[0]);
      process.ppid = Number(row[1]);
      process.platform = String(row[2]);
      process.arch = String(row[3]);
      process.execPath = String(row[4]);
      process.argv = __processBuildArgv(String(row[4]));
    }
  }

  __processRebuildEnv(ops);

  // `process.config` names the architecture, which was a guess until now.
  process.config = __processBuildConfig();

  // The five POSIX credential getters exist only where the platform has them,
  // which is exactly how Node behaves: on `win32`, `process.getuid` and friends
  // are *absent*, not throwing. They are installed here rather than declared in
  // the object literal so that a bundle with no extension — which cannot answer
  // them either — does not advertise them.
  const credentials: string = String(ops.credentials());
  if (!__procFailed(credentials)) {
    process.getuid = __processGetuid;
    process.getgid = __processGetgid;
    process.geteuid = __processGeteuid;
    process.getegid = __processGetegid;
    process.getgroups = __processGetgroups;
  }

  // `isTTY` is a plain property in Node and the answer cannot change, so it is
  // read once per descriptor rather than on every access.
  process.stdin.isTTY = __processIsTty(0);
  process.stdout.isTTY = __processIsTty(1);
  process.stderr.isTTY = __processIsTty(2);

  // `NODE_OPTIONS` is parsed only now, because the whole environment block is
  // only readable through the extension.
  __processApplyNodeOptions();
}

// NO-EXT: the TTY flags still have to exist, and the host surface has one flag.
process.stdin.isTTY = __processIsTty(0);
process.stdout.isTTY = __processIsTty(1);
process.stderr.isTTY = __processIsTty(2);

// Route the events module's MaxListenersExceededWarning through
// `process.emitWarning`, so `process.on('warning')` sees it.
__evSetWarningSink(__processEmitWarning);

// `node:process` module object for the bundler's `require` rewriting.
const __node_process: any = process;

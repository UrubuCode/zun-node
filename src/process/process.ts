// node:process — the slice of `process` that the rest of this library needs.
//
// Written in Zun TypeScript over the `zun:core` host surface. This is NOT the
// finished `node:process` module (see ../../PLAN.md for the library order): it is
// the "implement just the piece that unblocks the module in hand" case from
// PLAN.md principle 4, grown twice.
//
//   * `node:path` needed `cwd()`, per-drive cwd lookups through `env`, and
//     `platform`.
//   * `node:events` needs `process` to **be an EventEmitter** — Node's is one,
//     and its tests reach for `process.on('exit')`, `process.on('warning')`,
//     `process.emitWarning()` and `process.nextTick()`. That is also why `events`
//     was taken ahead of `os`: without those four, `common.mustCall` cannot
//     verify a single call count.
//
// The EventEmitter side is delegated to one `EventEmitter` instance from
// ../events/events.ts, which the bundle places before this file. `process`
// itself stays an object literal rather than becoming a subclass, because an
// object literal is the only shape in which a method can carry a rest parameter
// and `arguments` at the same time in this engine (a class method supports
// neither).
//
// Engine notes (https://github.com/UrubuCode/zun/issues):
//   * `host.cwd()` / `host.envGet` / `host.envHas` come from `zun:core`.
//   * There is no host native reporting the OS, so `platform` is derived from the
//     shape of `cwd()`: a `X:\...` drive-rooted cwd means Windows.
//   * `nextTick` is layered on `queueMicrotask`, the only microtask primitive the
//     host exposes. Node drains its own nextTick queue ahead of promise
//     reactions; here the two share one queue, so a `nextTick` scheduled from
//     inside a promise reaction runs after it rather than before. The relative
//     order *within* the nextTick queue is FIFO, as in Node.
//   * a function stored into an object property is now written plainly: both
//     halves of the swallowed-write bug are fixed (a function written over a
//     property holding `undefined` *or* an object lands —
//     https://github.com/UrubuCode/zun/issues/32), so the delete-then-assign
//     detour this file used to take through `__evRawSet` is gone.
//   * `process.emitWarning` builds a `ProcessWarning`, a declared class, rather
//     than attaching `name`/`code`/`detail` to a plain `Error`: an undeclared
//     key written onto a typed instance through an `any` alias poisons every
//     later statically typed read of that instance, `warning.name` included
//     (https://github.com/UrubuCode/zun/issues/37).

import { host } from "zun:core";

function __processCwd(): string {
  return host.cwd();
}

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

function __processEnvGet(name: string): any {
  if (!host.envHas(name)) return undefined;
  return host.envGet(name);
}

// `process.env`.
//
// A live `Proxy` lookup would be the right shape, since `zun:core` can read a
// variable by name but cannot enumerate the environment block, and
// https://github.com/UrubuCode/zun/issues/6 has come most of the way: the
// `get`, `set`, `has` and `deleteProperty` traps all fire through an `any`-typed
// receiver, and `get`/`set` now reach the trap for a **variable** key as well as
// a literal one — `env[name]`, which is precisely how `path.ts` reads it. One
// trap is still missing: `ownKeys` never runs, so `Object.keys(process.env)`
// over a Proxy comes back empty, and Node's own `os` and `path` tests read it.
// Measured on this engine that is still a net loss, so the snapshot stays — but
// it is one trap away from being the better shape.
//
// `env` is a snapshot over a fixed list of names: the variables Node's own tests
// touch, plus the per-drive `=X:` cwd variables `win32.resolve` consults.
// `envLookup` stays available for a name outside the list, which is what makes
// the live-read advantage of a Proxy mostly moot.
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
  "LANG",
  "LC_ALL",
  "TZ",
];

function __buildEnv(): any {
  const env: any = {};
  for (const name of __envNames) {
    if (host.envHas(name)) env[name] = host.envGet(name);
  }
  // The cmd.exe per-drive current directories: `=C:`, `=D:`, ...
  for (let letter = 65; letter <= 90; letter++) {
    const name = "=" + String.fromCharCode(letter) + ":";
    if (host.envHas(name)) env[name] = host.envGet(name);
  }
  return env;
}

const __processEnv: any = __buildEnv();

function __processArgv(): string[] {
  const out: string[] = [];
  const count = Number(host.argCount());
  for (let i = 0; i < count; i++) {
    out.push(host.argAt(i));
  }
  return out;
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
// ---------------------------------------------------------------------------

const __tickQueue: any = { items: [], scheduled: false };

function __processPendingTicks(): number {
  return Number(__tickQueue.items.length);
}

function __drainTicks(): void {
  __tickQueue.scheduled = false;
  while (Number(__tickQueue.items.length) > 0) {
    const entry: any = __tickQueue.items.shift();
    __evCall(entry.fn, entry.args);
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
  // `{ args: passed, fn: fn }` outright: a function written onto a property
  // that currently holds something else is no longer swallowed (zun#32), so the
  // `__evRawSet` detour this used to take is gone.
  const entry: any = { args: passed, fn: fn };
  __tickQueue.items.push(entry);
  if (!__tickQueue.scheduled) {
    __tickQueue.scheduled = true;
    queueMicrotask(__drainTicks);
  }
}

// ---------------------------------------------------------------------------
// process.emitWarning
// ---------------------------------------------------------------------------

// The warning a string `process.emitWarning(message, ...)` becomes. Node builds
// a plain `Error` and then assigns `name`, `code` and `detail` onto it; here
// every one of the three is a **declared field**, because writing an undeclared
// key onto a typed instance through an `any` alias poisons the instance and
// every later statically typed read of its own members — `warning.name`
// included, which is what a `process.on('warning')` listener reads — throws
// `Cannot read private member from an object whose class did not declare it`
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

function __processEmitWarning(warning: any, type?: any, code?: any): void {
  let built: any = warning;
  if (typeof warning === "string") {
    const made = new ProcessWarning(warning);
    if (type !== undefined && type !== null) {
      if (typeof type === "object") {
        if (type.type !== undefined) made.warningName = String(type.type);
        if (type.code !== undefined) made.code = String(type.code);
        if (type.detail !== undefined) made.detail = type.detail;
      } else {
        made.warningName = String(type);
      }
    }
    if (code !== undefined && code !== null) made.code = String(code);
    built = made;
  }
  // A warning is delivered on the next tick in Node; the tests observe it
  // through `process.on('warning')`, so the same deferral is kept.
  __processNextTick(__deliverWarning, built);
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

const __exitState: any = { emitted: false, code: 0 };

// Emit `process` 'exit' exactly once, with the resolved exit code. Returns the
// code so a caller can hand it to the host.
function __processRunExit(code?: any): number {
  if (__exitState.emitted) return Number(__exitState.code);
  __exitState.emitted = true;
  let resolved = 0;
  if (code !== undefined && code !== null) {
    resolved = Number(code);
  } else if (process.exitCode !== undefined && process.exitCode !== null) {
    resolved = Number(process.exitCode);
  }
  __exitState.code = resolved;
  __evEmit(__processEmitter, "exit", [resolved]);
  return Number(__exitState.code);
}

// ---------------------------------------------------------------------------
// process
// ---------------------------------------------------------------------------

const process: any = {
  platform: __isWindowsHost ? "win32" : "linux",
  arch: "x64",
  version: "v25.0.0",
  versions: { node: "25.0.0" },
  // A placeholder: `zun:core` reports no pid, and this module must keep
  // compiling with no extension loaded (the `path` and `events` bundles run
  // without `--ext`). `src/os/os.ts` overwrites it with the real pid from its
  // own native whenever `os` is in the bundle, and the field moves here the
  // moment `process` has a native of its own.
  pid: 1,
  exitCode: undefined,
  cwd(): string {
    return __processCwd();
  },
  env: __processEnv,
  // Escape hatch for a variable outside the snapshot list above.
  envLookup(name: string): any {
    return __processEnvGet(name);
  },
  argv: __processArgv(),
  exit(code?: number): void {
    const resolved = __processRunExit(code);
    host.exitProcess(resolved);
  },
  stdout: {
    write(text: string): boolean {
      host.stdoutWrite(text);
      return true;
    },
  },
  stderr: {
    write(text: string): boolean {
      host.stderrWrite(text);
      return true;
    },
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
  emitWarning(warning: any, type?: any, code?: any): void {
    __processEmitWarning(warning, type, code);
  },
  hrtime(): any[] {
    return [0, 0];
  },
  uptime(): number {
    return 0;
  },
  memoryUsage(): any {
    return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0 };
  },
};

// Route the events module's MaxListenersExceededWarning through
// `process.emitWarning`, so `process.on('warning')` sees it.
__evSetWarningSink(__processEmitWarning);

// `node:process` module object for the bundler's `require` rewriting.
const __node_process: any = process;

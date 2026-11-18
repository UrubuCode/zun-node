// node:child_process — the synchronous half, Node-shaped, over the natives in
// `src/child_process/*.rs`.
//
// This is the `os`/`fs` kind of module: `src/child_process/mod.rs` runs one
// child to completion and reports what happened, and this file is everything
// Node wraps around that — `normalizeSpawnArguments`, the shell rules, the
// `stdio` grammar, `encoding`, the result object with its `output` array, and
// the `ERR_*` / `Command failed:` errors. It reaches the natives with
// `import * as native from "node:child_process"`, so its tests are bundled like
// a TypeScript module **and** run with `--ext`.
//
// Node's `lib/child_process.js` and `lib/internal/child_process.js` (MIT) are
// followed instruction for instruction for the observable parts: the argument
// shuffling each of the three entry points performs, the validation order, the
// `cmd.exe /d /s /c "<command>"` and `/bin/sh -c <command>` shells, the
// null-byte rejection, and `checkExecSyncError`'s two kinds of throw.
//
// ---------------------------------------------------------------------------
// What is here and what is not
// ---------------------------------------------------------------------------
//
// **Here, synchronous:** `spawnSync`, `execSync`, `execFileSync` — the whole
// surface, with `cwd`, `env`, `input`, `encoding`, `shell`, `timeout`,
// `killSignal`, `maxBuffer`, `stdio`, `windowsHide`, `argv0`, `uid`/`gid` and
// `detached`. One call runs the child to completion (`spawn.rs`).
//
// **Here, asynchronous:** `ChildProcess`, `spawn`, `exec`, `execFile` — the
// second half of this file. A child runs while the program does; its pipes and
// its exit reach this file through the shared I/O loop (`src/io/`), over the
// natives in `asyncp.rs`. See the header of that section.
//
// **Not here:** `fork()` and the IPC channel (`send`, `disconnect`, `'message'`,
// `advanced` serialization). They need a duplex channel to a *Zun* child and
// throw `ERR_METHOD_NOT_IMPLEMENTED`.
//
// ---------------------------------------------------------------------------
// `process.execPath` and Node's self-re-execution pattern
// ---------------------------------------------------------------------------
//
// A great many of Node's `child_process` tests are shaped like
// `spawnSync(process.execPath, [__filename, 'child'])`: the test re-runs *itself*
// in a child process. `zun run` cannot run a CommonJS file (the engine has no
// `require`, https://github.com/UrubuCode/zun/issues/4) and takes no script
// arguments, so under the test runner `process.execPath` is a launcher —
// `zun-node-run`, `src/bin/zun-node-run.rs` — that bundles the script and runs
// it with `zun run --ext`. `cpExecPath()` answers the launcher when
// `ZUN_NODE_SHIM` names one and the `zun` binary otherwise. The decision, and
// what it cost, is written up in `test/child_process/README.md`.

import * as __cpNative from "node:child_process";

// U+001F / U+001E, the request and reply separators (`src/child_process/mod.rs`).
const __CP_US: string = "\u001f";
const __CP_RS: string = "\u001e";

// `lib/child_process.js`' `MAX_BUFFER`: 1 MiB.
const __CP_MAX_BUFFER: number = 1024 * 1024;

const __cpIsWindows: boolean = process.platform === "win32";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `genericNodeError(msg, { status, signal, output, pid, stdout, stderr })` —
// `checkExecSyncError`'s throw for a child that ran but failed. Node builds an
// ordinary `Error` and assigns the whole result onto it; the fields are declared
// here rather than written through an `any` alias, because an undeclared key on
// a typed instance poisons every later typed read of it
// (https://github.com/UrubuCode/zun/issues/37).
class ChildProcessError extends Error {
  code: any;
  errno: any;
  syscall: any;
  path: any;
  spawnargs: any;
  status: any;
  signal: any;
  output: any;
  pid: any;
  stdout: any;
  stderr: any;
  killed: boolean;
  cmd: any;
  constructor(message: string) {
    super(message);
    this.code = undefined;
    this.errno = undefined;
    this.syscall = undefined;
    this.path = undefined;
    this.spawnargs = undefined;
    this.status = undefined;
    this.signal = undefined;
    this.output = undefined;
    this.pid = undefined;
    this.stdout = undefined;
    this.stderr = undefined;
    this.killed = false;
    this.cmd = undefined;
  }
}

// `ERR_METHOD_NOT_IMPLEMENTED` is built from `NodeError` directly rather than
// declared as a class of its own: the class is declared once, with the error
// bases in `src/events/events.ts`, because `fs`, `stream`, `process` and this
// module all raise it and a bundle that inlines two of them would otherwise
// have two top-level declarations of one name, which a single Zun program
// cannot have. This helper *returns* the error rather than throwing it, which
// is why it stays a function here.
function __cpNotImplemented(name: string): any {
  return new NodeError(
    "ERR_METHOD_NOT_IMPLEMENTED",
    "The " + name + " method is not implemented",
  );
}

// `validateString`, `validateObject` & co. live in `src/events/events.ts`; the
// two this module needs that are not there are below.
function __cpValidateString(value: any, name: string): void {
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }
}

function __cpValidateInt32(value: any, name: string): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < -2147483648 || value > 2147483647) {
    throw new ERR_OUT_OF_RANGE(name, ">= -2147483648 && <= 2147483647", value);
  }
}

function __cpValidateInteger(value: any, name: string, min: number): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < min) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + String(min), value);
  }
}

// `validateArgumentNullCheck` — a NUL in any string that reaches `execvp` is a
// truncation hazard, which is why Node rejects it rather than passing it on.
function __cpValidateNullBytes(value: any, name: string): void {
  if (typeof value === "string" && Number(value.indexOf("\u0000")) !== -1) {
    throw new ERR_INVALID_ARG_VALUE(name, value, "must be a string without null bytes");
  }
}

function __cpValidateArgsNullBytes(args: any[], name: string): void {
  const count: number = Number(args.length);
  for (let i = 0; i < count; i++) {
    __cpValidateNullBytes(args[i], name + "[" + String(i) + "]");
  }
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

// `convertToValidSignal`: a name is checked against the signal table, a number
// is mapped back to its name, and anything else is `ERR_UNKNOWN_SIGNAL`.
const __CP_SIGNAL_NAMES: string[] = [
  "SIGHUP", "SIGINT", "SIGQUIT", "SIGILL", "SIGTRAP", "SIGABRT", "SIGIOT",
  "SIGBUS", "SIGFPE", "SIGKILL", "SIGUSR1", "SIGSEGV", "SIGUSR2", "SIGPIPE",
  "SIGALRM", "SIGTERM", "SIGCHLD", "SIGSTKFLT", "SIGCONT", "SIGSTOP",
  "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGURG", "SIGXCPU", "SIGXFSZ",
  "SIGVTALRM", "SIGPROF", "SIGWINCH", "SIGIO", "SIGPOLL", "SIGLOST",
  "SIGPWR", "SIGINFO", "SIGSYS", "SIGUNUSED", "SIGBREAK",
];

const __CP_SIGNAL_NUMBERS: number[] = [
  1, 2, 3, 4, 5, 6, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 16, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 29, 29, 30, 29, 31, 31, 21,
];

// `ERR_UNKNOWN_SIGNAL` used to be declared here, with an `inspect`ed signal in
// its message. It is in `src/process/process.ts` now — `process.kill` resolves
// signal names in every bundle, while this file is in only some of them, and
// two top-level declarations of one name are a compile error in a single Zun
// program. The message moved to Node's own `%s` formatting at the same time, so
// an unknown signal *name* is reported bare (`Unknown signal: SIGNOTREAL`)
// rather than quoted, which is what Node prints.

function __cpSignalIndexOfName(name: string): number {
  const count: number = Number(__CP_SIGNAL_NAMES.length);
  for (let i = 0; i < count; i++) {
    if (__CP_SIGNAL_NAMES[i] === name) return i;
  }
  return -1;
}

function __cpConvertToValidSignal(signal: any): string {
  if (typeof signal === "string") {
    // Node looks the name up *upper-cased*, so `'sigterm'` is accepted.
    const upper: string = String(signal).toUpperCase();
    if (__cpSignalIndexOfName(upper) !== -1) return upper;
    throw new ERR_UNKNOWN_SIGNAL(signal);
  }
  if (typeof signal === "number") {
    const wanted: number = Number(signal);
    const count: number = Number(__CP_SIGNAL_NUMBERS.length);
    for (let i = 0; i < count; i++) {
      if (Number(__CP_SIGNAL_NUMBERS[i]) === wanted) return __CP_SIGNAL_NAMES[i];
    }
    throw new ERR_UNKNOWN_SIGNAL(signal);
  }
  throw new ERR_UNKNOWN_SIGNAL(signal);
}

// `sanitizeKillSignal`: `undefined`/`null` keep the default, a string or number
// is converted, anything else is a type error.
function __cpSanitizeKillSignal(killSignal: any): string {
  if (killSignal === undefined || killSignal === null) return "SIGTERM";
  if (typeof killSignal === "string" || typeof killSignal === "number") {
    return __cpConvertToValidSignal(killSignal);
  }
  throw new ERR_INVALID_ARG_TYPE("options.killSignal", ["string", "number"], killSignal);
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

// `getValidStdio(stdio, sync)` reduced to the three things a *synchronous*
// child can do with a descriptor. Node's full grammar also accepts 'ipc', a
// `Stream` and a raw fd, all of which need machinery this module does not have;
// each is rejected with the same `ERR_INVALID_ARG_VALUE` Node raises for an
// unknown entry, rather than silently treated as a pipe.
function __cpNormalizeStdio(stdio: any): string[] {
  let list: any[] = [];
  if (stdio === undefined || stdio === null) {
    list = ["pipe", "pipe", "pipe"];
  } else if (typeof stdio === "string") {
    if (stdio === "ignore" || stdio === "pipe" || stdio === "inherit") {
      list = [stdio, stdio, stdio];
    } else if (stdio === "overlapped") {
      list = ["pipe", "pipe", "pipe"];
    } else {
      throw new ERR_INVALID_ARG_VALUE("stdio", stdio, "must be one of 'pipe', 'overlapped', 'ignore' or 'inherit'");
    }
  } else if (Array.isArray(stdio)) {
    const count: number = Number(stdio.length);
    for (let i = 0; i < count; i++) list.push(stdio[i]);
  } else {
    throw new ERR_INVALID_ARG_VALUE("stdio", stdio, "must be a string or an array");
  }
  while (Number(list.length) < 3) list.push("pipe");

  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const entry: any = list[i];
    if (entry === undefined || entry === null || entry === "pipe" || entry === "overlapped") {
      out.push("pipe");
    } else if (entry === "ignore") {
      out.push("ignore");
    } else if (entry === "inherit") {
      out.push("inherit");
    } else {
      throw new ERR_INVALID_ARG_VALUE("stdio[" + String(i) + "]", entry, "must be one of 'pipe', 'overlapped', 'ignore' or 'inherit'");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// normalizeSpawnArguments
// ---------------------------------------------------------------------------

// The shape `lib/child_process.js` passes to the binding: argv (argv[0] first),
// the environment as `KEY=VALUE` pairs, and the validated options. Returned as a
// plain record rather than a class, because the caller only reads it.
function __cpNormalizeSpawn(fileArg: any, argsArg: any, optionsArg: any): any {
  let file: any = fileArg;
  let args: any = argsArg;
  let options: any = optionsArg;

  __cpValidateString(file, "file");
  __cpValidateNullBytes(file, "file");
  if (Number(file.length) === 0) {
    throw new ERR_INVALID_ARG_VALUE("file", file, "cannot be empty");
  }

  if (Array.isArray(args)) {
    const copy: any[] = [];
    const count: number = Number(args.length);
    for (let i = 0; i < count; i++) copy.push(args[i]);
    args = copy;
  } else if (args === undefined || args === null) {
    args = [];
  } else if (typeof args !== "object") {
    throw new ERR_INVALID_ARG_TYPE("args", "object", args);
  } else {
    options = args;
    args = [];
  }

  __cpValidateArgsNullBytes(args, "args");

  if (options === undefined) {
    options = {};
  } else {
    __evValidateObject(options, "options");
  }

  let cwd: any = options.cwd;
  if (cwd !== undefined && cwd !== null) {
    // `getValidatedPath` accepts a string or a file: URL; `node:url`'s
    // `fileURLToPath` is in the bundle, so both spellings work here.
    if (typeof cwd === "object" && cwd !== null && typeof cwd.protocol === "string") {
      cwd = __node_url.fileURLToPath(cwd);
    }
    __cpValidateString(cwd, "options.cwd");
    __cpValidateNullBytes(cwd, "options.cwd");
  }

  if (options.detached !== undefined && options.detached !== null) {
    __evValidateBoolean(options.detached, "options.detached");
  }
  if (options.uid !== undefined && options.uid !== null) {
    __cpValidateInt32(options.uid, "options.uid");
  }
  if (options.gid !== undefined && options.gid !== null) {
    __cpValidateInt32(options.gid, "options.gid");
  }

  const shell: any = options.shell;
  if (
    shell !== undefined &&
    shell !== null &&
    typeof shell !== "boolean" &&
    typeof shell !== "string"
  ) {
    throw new ERR_INVALID_ARG_TYPE("options.shell", ["boolean", "string"], shell);
  }

  if (options.argv0 !== undefined && options.argv0 !== null) {
    __cpValidateString(options.argv0, "options.argv0");
    __cpValidateNullBytes(options.argv0, "options.argv0");
  }
  if (options.windowsHide !== undefined && options.windowsHide !== null) {
    __evValidateBoolean(options.windowsHide, "options.windowsHide");
  }
  let windowsVerbatim: any = options.windowsVerbatimArguments;
  if (windowsVerbatim !== undefined && windowsVerbatim !== null) {
    __evValidateBoolean(windowsVerbatim, "options.windowsVerbatimArguments");
  }

  // Does the command line run `process.execPath`? Only then does the child
  // need the re-execution variables (see below).
  let mentionsExec: boolean = String(file).indexOf(String(process.execPath)) !== -1;
  for (let i = 0; i < Number(args.length); i++) {
    if (String(args[i]).indexOf(String(process.execPath)) !== -1) mentionsExec = true;
  }

  if (shell !== undefined && shell !== null && shell !== false) {
    __cpValidateNullBytes(shell, "options.shell");
    if (Number(args.length) > 0 && !__cpState.warnedShellArgs) {
      __cpState.warnedShellArgs = true;
      // DEP0190.
      process.emitWarning(
        "Passing args to a child process with shell option true can lead to security " +
          "vulnerabilities, as the arguments are not escaped, only concatenated.",
        "DeprecationWarning",
        "DEP0190",
      );
    }
    const command: string =
      Number(args.length) > 0 ? String(file) + " " + args.join(" ") : String(file);
    if (__cpIsWindows) {
      file = typeof shell === "string" ? shell : __cpComspec();
      if (__cpIsCmdExe(String(file))) {
        // '/d /s /c' is only right for cmd.exe, and the command is quoted as one
        // argument because cmd.exe re-parses its own command line.
        args = ["/d", "/s", "/c", '"' + command + '"'];
        windowsVerbatim = true;
      } else {
        args = ["-c", command];
      }
    } else {
      file = typeof shell === "string" ? shell : "/bin/sh";
      args = ["-c", command];
    }
  }

  const argv: string[] = [];
  if (typeof options.argv0 === "string") {
    argv.push(String(options.argv0));
  } else {
    argv.push(String(file));
  }
  const argCount: number = Number(args.length);
  for (let i = 0; i < argCount; i++) argv.push(String(args[i]));

  // The environment block. `options.env` replaces `process.env` wholesale, which
  // is what Node does — and it always sends a complete block, so the native
  // clears the inherited environment whenever one is given.
  const sourceEnv: any = options.env === undefined || options.env === null ? process.env : options.env;
  const pairs: string[] = [];
  // Prototype values are intentionally included, as in Node (`for (key in env)`).
  let keys: any[] = [];
  for (const key in sourceEnv) keys.push(key);
  if (__cpIsWindows) {
    // Environment names are case-insensitive on Windows, so a duplicate that
    // differs only in case would create two entries for one variable. Node sorts
    // the names and keeps the first of each case-folded group.
    keys = keys.sort();
  }
  const keyCount: number = Number(keys.length);
  const seen: any = {};
  for (let i = 0; i < keyCount; i++) {
    const key: string = String(keys[i]);
    const value: any = sourceEnv[key];
    if (value === undefined) continue;
    const folded: string = __cpIsWindows ? key.toUpperCase() : key;
    if (seen[folded] === true) continue;
    seen[folded] = true;
    pairs.push(key + "=" + String(value));
  }

  // The re-execution launcher (`src/bin/zun-node-run.rs`) is configured by
  // `ZUN_NODE_*` variables; a test that replaces the environment would strip
  // them, so they travel with every spawn of `process.execPath`.
  if (mentionsExec) {
    for (const name of ["ZUN_NODE_ZUN", "ZUN_NODE_EXT", "ZUN_NODE_BUNDLER", "ZUN_NODE_BASH", "ZUN_NODE_SHIM", "PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "HOME"]) {
      const folded: string = __cpIsWindows ? name.toUpperCase() : name;
      if (seen[folded] === true) continue;
      const value: any = process.env[name];
      if (value === undefined || value === null) continue;
      seen[folded] = true;
      pairs.push(name + "=" + String(value));
    }
  }

  return {
    file: String(file),
    args: args,
    argv: argv,
    envPairs: pairs,
    options: options,
    cwd: cwd === undefined || cwd === null ? "" : String(cwd),
    windowsVerbatimArguments: windowsVerbatim === true,
  };
}

const __cpState: any = { warnedShellArgs: false };

// `process.env.comspec || 'cmd.exe'`. `process.env` is a snapshot here, so the
// lookup also goes through `process.envLookup` for a variable outside it.
function __cpComspec(): string {
  const direct: any = process.env.comspec;
  if (typeof direct === "string" && direct !== "") return direct;
  const upper: any = process.envLookup("COMSPEC");
  if (typeof upper === "string" && upper !== "") return upper;
  const lower: any = process.envLookup("comspec");
  if (typeof lower === "string" && lower !== "") return lower;
  return "cmd.exe";
}

// Node's `/^(?:.*\\)?cmd(?:\.exe)?$/i`, spelled as a scan: the basename, case
// folded, is `cmd` or `cmd.exe`.
function __cpIsCmdExe(file: string): boolean {
  let start: number = 0;
  const length: number = Number(file.length);
  for (let i = 0; i < length; i++) {
    if (file.charAt(i) === "\\") start = i + 1;
  }
  const base: string = file.slice(start).toLowerCase();
  return base === "cmd" || base === "cmd.exe";
}

// ---------------------------------------------------------------------------
// The native call
// ---------------------------------------------------------------------------

// The bytes to write to the child's stdin, base64-encoded for the carrier. Node
// accepts a string (in `options.encoding`), a Buffer or any typed array, and
// rejects everything else.
function __cpInputToBase64(input: any, encoding: any): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") {
    const name: string = encoding === undefined || encoding === null || encoding === "buffer"
      ? "utf8"
      : String(encoding);
    const encoded: Buffer = Buffer.from(input, name);
    return encoded.toString("base64");
  }
  if (typeof input === "object") {
    const maybe: any = input;
    if (typeof maybe.toString === "function" || maybe.length !== undefined) {
      const bytes: Buffer = maybe;
      return bytes.toString("base64");
    }
  }
  throw new ERR_INVALID_ARG_TYPE(
    "options.stdio[0]",
    ["Buffer", "TypedArray", "DataView", "string"],
    input,
  );
}

function __cpJoin(fields: any[], separator: string): string {
  let out: string = "";
  const count: number = Number(fields.length);
  for (let i = 0; i < count; i++) {
    if (i > 0) out = out + separator;
    out = out + String(fields[i]);
  }
  return out;
}

// Build the request string the native parses (grammar in
// `src/child_process/mod.rs`) and split its reply into fields.
function __cpRunSync(normalized: any, settings: any): any {
  const header: any[] = [
    normalized.cwd,
    String(settings.timeout),
    settings.killSignal,
    settings.maxBuffer === Infinity ? "Infinity" : String(settings.maxBuffer),
    settings.stdio[0],
    settings.stdio[1],
    settings.stdio[2],
    settings.windowsHide ? "1" : "0",
    settings.detached ? "1" : "0",
    settings.useEnv ? "1" : "0",
    settings.uid === undefined ? "" : String(settings.uid),
    settings.gid === undefined ? "" : String(settings.gid),
    settings.windowsVerbatimArguments ? "1" : "0",
  ];
  const request: string =
    __cpJoin(header, __CP_US) +
    __CP_RS +
    __cpJoin(normalized.argv, __CP_US) +
    __CP_RS +
    __cpJoin(normalized.envPairs, __CP_US) +
    __CP_RS +
    settings.inputBase64;

  const reply: string = __cpNative.cpSpawnSync(request);
  if (reply === "-" || Number(reply.length) === 0) {
    throw new NodeError("ERR_INVALID_ARG_VALUE", "spawnSync: malformed request");
  }
  return reply.slice(1).split(__CP_US);
}

// ---------------------------------------------------------------------------
// spawnSync
// ---------------------------------------------------------------------------

// The `uvException`-shaped error `spawnSync` reports in `result.error`: the
// message is `"<code>: <description>, spawnSync <file>"` and `path`/`spawnargs`
// name what was attempted, exactly as Node's does.
function __cpSystemError(
  code: string,
  description: string,
  syscall: string,
  errno: number,
  file: string,
  args: any[],
): any {
  const error = new ChildProcessError(code + ": " + description + ", " + syscall);
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  error.path = file;
  error.spawnargs = args;
  return error;
}

function spawnSync(file?: any, args?: any, options?: any): any {
  const normalized: any = __cpNormalizeSpawn(file, args, options);
  const opts: any = normalized.options;

  const timeout: any = opts.timeout;
  if (timeout !== undefined && timeout !== null) {
    __cpValidateInteger(timeout, "timeout", 0);
  }
  let maxBuffer: any = opts.maxBuffer;
  if (maxBuffer !== undefined && maxBuffer !== null) {
    if (typeof maxBuffer !== "number") {
      throw new ERR_INVALID_ARG_TYPE("options.maxBuffer", "number", maxBuffer);
    }
    // `validateNumber(maxBuffer, 'options.maxBuffer', 0)`: with a bound given,
    // `NaN` is out of range too — it is neither `>= 0` nor `< 0`, so the test
    // has to be explicit.
    if (Number.isNaN(Number(maxBuffer)) || Number(maxBuffer) < 0) {
      throw new ERR_OUT_OF_RANGE("options.maxBuffer", ">= 0", maxBuffer);
    }
  } else {
    maxBuffer = __CP_MAX_BUFFER;
  }
  const killSignal: string = __cpSanitizeKillSignal(opts.killSignal);
  const stdio: string[] = __cpNormalizeStdio(opts.stdio);
  const encoding: any = opts.encoding;
  const inputBase64: string = __cpInputToBase64(opts.input, encoding);

  const settings: any = {
    timeout: timeout === undefined || timeout === null ? 0 : Number(timeout),
    killSignal: killSignal,
    maxBuffer: maxBuffer,
    stdio: stdio,
    windowsHide: opts.windowsHide === true,
    detached: opts.detached === true,
    useEnv: true,
    uid: opts.uid === undefined || opts.uid === null ? undefined : Number(opts.uid),
    gid: opts.gid === undefined || opts.gid === null ? undefined : Number(opts.gid),
    inputBase64: inputBase64,
    // Set by `normalizeSpawnArguments` for a `cmd.exe` shell command, or asked
    // for explicitly through the option of the same name.
    windowsVerbatimArguments:
      normalized.windowsVerbatimArguments === true || opts.windowsVerbatimArguments === true,
  };

  const fields: any[] = __cpRunSync(normalized, settings);
  return __cpBuildResult(fields, normalized, encoding);
}

// Decode one reply into Node's result object. `output` is the array of the three
// descriptors — `output[0]` is always null, because `spawnSync` never reports
// what it wrote to the child's stdin — and `stdout`/`stderr` are aliases of
// `output[1]`/`output[2]`.
function __cpBuildResult(fields: any[], normalized: any, encoding: any): any {
  const statusField: string = String(fields[0]);
  const signalField: string = String(fields[1]);
  const pid: number = Number(fields[2]);
  const stdoutPiped: boolean = String(fields[5]) === "1";
  const stderrPiped: boolean = String(fields[6]) === "1";
  const errorCode: string = String(fields[7]);

  const wantString: boolean =
    encoding !== undefined && encoding !== null && encoding !== "buffer";
  const name: string = wantString ? String(encoding) : "buffer";

  let stdout: any = null;
  let stderr: any = null;
  if (stdoutPiped) stdout = __cpDecode(String(fields[3]), wantString, name);
  if (stderrPiped) stderr = __cpDecode(String(fields[4]), wantString, name);

  const result: any = {
    pid: pid,
    output: [null, stdout, stderr],
    stdout: stdout,
    stderr: stderr,
    status: statusField === "" ? null : Number(statusField),
    signal: signalField === "" ? null : signalField,
  };
  if (errorCode !== "") {
    result.error = __cpSystemError(
      errorCode,
      String(fields[8]),
      String(fields[9]),
      Number(fields[10]),
      normalized.file,
      normalized.args,
    );
  }
  return result;
}

function __cpDecode(base64: string, wantString: boolean, encoding: string): any {
  const bytes: Buffer = Buffer.from(base64, "base64");
  if (!wantString) return bytes;
  return bytes.toString(encoding);
}

// ---------------------------------------------------------------------------
// execSync / execFileSync
// ---------------------------------------------------------------------------

// `checkExecSyncError(ret, args, cmd)`: a result that carries an `error` throws
// that error with the result assigned onto it; a non-zero status throws
// `Command failed: <cmd>` with the child's stderr appended.
function __cpCheckExecSyncError(result: any, args: any, cmd: any): any {
  if (result.error !== undefined && result.error !== null) {
    const error: any = result.error;
    error.status = result.status;
    error.signal = result.signal;
    error.output = result.output;
    error.pid = result.pid;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    return error;
  }
  const status: any = result.status;
  if (status !== null && Number(status) !== 0) {
    let message: string = "Command failed: ";
    message = message + (cmd !== undefined && cmd !== null ? String(cmd) : args.join(" "));
    const stderr: any = result.stderr;
    if (stderr !== undefined && stderr !== null && Number(stderr.length) > 0) {
      message = message + "\n" + String(stderr.toString());
    }
    const error = new ChildProcessError(message);
    error.status = result.status;
    error.signal = result.signal;
    error.output = result.output;
    error.pid = result.pid;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    return error;
  }
  return undefined;
}

// `normalizeExecFileArgs(file, args, options, callback)`.
function __cpNormalizeExecFileArgs(file: any, argsArg: any, optionsArg: any, callbackArg: any): any {
  let args: any = argsArg;
  let options: any = optionsArg;
  let callback: any = callbackArg;

  if (Array.isArray(args)) {
    const copy: any[] = [];
    const count: number = Number(args.length);
    for (let i = 0; i < count; i++) copy.push(args[i]);
    args = copy;
  } else if (args !== undefined && args !== null && typeof args === "object") {
    callback = options;
    options = args;
    args = null;
  } else if (__evIsFn(args)) {
    callback = args;
    options = null;
    args = null;
  }
  if (args === undefined || args === null) args = [];

  if (__evIsFn(options)) {
    callback = options;
    options = null;
  } else if (options !== undefined && options !== null) {
    __evValidateObject(options, "options");
  }
  if (options === undefined || options === null) options = {};
  if (callback !== undefined && callback !== null && !__evIsFn(callback)) {
    throw new ERR_INVALID_ARG_TYPE("callback", "Function", callback);
  }
  return { file: file, args: args, options: options, callback: callback };
}

// `normalizeExecArgs(command, options, callback)`: `exec`/`execSync` always run
// through a shell, which is the single difference from `execFile`.
function __cpNormalizeExecArgs(command: any, optionsArg: any, callbackArg: any): any {
  __cpValidateString(command, "command");
  __cpValidateNullBytes(command, "command");
  let options: any = optionsArg;
  let callback: any = callbackArg;
  if (__evIsFn(options)) {
    callback = options;
    options = undefined;
  }
  const copy: any = {};
  if (options !== undefined && options !== null) {
    const keys: any[] = Object.keys(options);
    const count: number = Number(keys.length);
    for (let i = 0; i < count; i++) {
      const key: string = String(keys[i]);
      copy[key] = options[key];
    }
  }
  copy.shell = typeof copy.shell === "string" ? copy.shell : true;
  return { file: command, options: copy, callback: callback };
}

function execFileSync(file?: any, args?: any, options?: any): any {
  const normalized: any = __cpNormalizeExecFileArgs(file, args, options, undefined);
  const opts: any = normalized.options;
  // With no explicit `stdio`, Node forwards the child's stderr to the parent's
  // *after* the fact, which is observably different from 'inherit'.
  const inheritStderr: boolean = opts.stdio === undefined || opts.stdio === null;
  const result: any = spawnSync(normalized.file, normalized.args, opts);
  if (inheritStderr && result.stderr !== undefined && result.stderr !== null) {
    process.stderr.write(String(result.stderr.toString()));
  }
  const errArgs: any[] = [];
  errArgs.push(opts.argv0 !== undefined && opts.argv0 !== null ? opts.argv0 : normalized.file);
  const count: number = Number(normalized.args.length);
  for (let i = 0; i < count; i++) errArgs.push(normalized.args[i]);
  const error: any = __cpCheckExecSyncError(result, errArgs, undefined);
  if (error !== undefined) throw error;
  return result.stdout;
}

function execSync(command?: any, options?: any): any {
  const normalized: any = __cpNormalizeExecArgs(command, options, undefined);
  const opts: any = normalized.options;
  const inheritStderr: boolean = opts.stdio === undefined || opts.stdio === null;
  const result: any = spawnSync(normalized.file, [], opts);
  if (inheritStderr && result.stderr !== undefined && result.stderr !== null) {
    process.stderr.write(String(result.stderr.toString()));
  }
  const error: any = __cpCheckExecSyncError(result, undefined, command);
  if (error !== undefined) throw error;
  return result.stdout;
}

// ---------------------------------------------------------------------------
// The asynchronous half: ChildProcess, spawn, exec, execFile
// ---------------------------------------------------------------------------
//
// A child runs *while* the program does. The natives (`src/child_process/
// asyncp.rs`) start it with piped stdio and publish three kinds of handle
// numbers from the shared I/O loop's own counter: the child's stdin, its
// stdout/stderr pipes and the process itself. This file registers the pipes and
// the process with `src/io/io.ts` — the loop `net` runs on — and everything
// above that is Node's `lib/internal/child_process.js`: `ChildProcess` as an
// `EventEmitter` with `stdin`/`stdout`/`stderr` streams, the `'spawn'`,
// `'exit'`, `'close'` and `'error'` events in Node's order, `kill`, `ref`/
// `unref`, and `exec`/`execFile` built on `spawn` exactly as `lib/child_process.js`
// builds them.
//
// Documented deviations:
//   * the three stdio streams are `Readable`/`Writable` objects, not
//     `net.Socket`s (Node's are sockets over a pipe handle): `child.stdout
//     instanceof net.Socket` is false, and the socket-only surface
//     (`setTimeout`, `address()`, ...) is absent.
//   * `stdio` accepts 'pipe', 'overlapped', 'ignore', 'inherit' and a number or
//     an object with a numeric `fd` in 0..2 (the parent's own stdio). Entries past
//     the third are ignored; 'ipc' and an arbitrary stream are rejected.
//   * `fork()` and the IPC channel (`send`, `disconnect`, `'message'`) are not
//     implemented: they need a duplex channel to a *Zun* child, which also
//     needs the re-execution entry point described at the top of this file.
//   * `detached`, `uid` and `gid` are POSIX-only, as in Node.

// The loop's native namespace, or null when the bundle has no extension.
function __cpLoopOps(): any {
  return __ioOps();
}

function __cpAsyncAvailable(): boolean {
  return __ioAvailable();
}

// `ErrnoException(err, syscall)`: `"<syscall> <code>"`, with `errno`, `code` and
// `syscall` set. `spawnargs`/`path` are added by the caller.
function __cpErrno(code: string, errno: number, syscall: string): any {
  const error = new ChildProcessError(syscall + " " + code);
  error.code = code;
  error.errno = errno;
  error.syscall = syscall;
  return error;
}

// `ERR_CHILD_PROCESS_STDIO_MAXBUFFER`.
function __cpMaxBufferError(stream: string): any {
  return new NodeRangeError(
    "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    stream + " maxBuffer length exceeded",
  );
}

// ---- stdio streams -------------------------------------------------------

// A child's stdout or stderr.
//
// `_pipe` is the stream's own record: `{ id, eof, ref }`. The stream asks the
// loop for read interest in `_read` and withdraws it when `push` says stop, so
// a reader that falls behind makes the child block on a full pipe — the same
// backpressure `socket.pause()` has over TCP.
class __CpReadable extends Readable {
  _pipe: any = null;
  _child: any = null;

  constructor() {
    super({});
    this._pipe = { id: 0, eof: false, wanted: false };
    const self: any = this;
    __sSetOptFn(self, "read", function (): void {
      __cpPipeWant(self, true);
    });
    __sSetOptFn(self, "destroy", function (err: any, cb: any): void {
      __cpPipeClose(self);
      __evCall(cb, [err]);
    });
  }
}

// A child's stdin.
class __CpWritable extends Writable {
  _pipe: any = null;
  _child: any = null;
  // Node's stdin is a `net.Socket` whose readable side is switched off.
  readable: any = false;

  constructor() {
    super({});
    this._pipe = { id: 0, closed: false };
    const self: any = this;
    __sSetOptFn(self, "write", function (chunk: any, encoding: any, cb: any): void {
      __cpStdinWrite(self, chunk, encoding, cb);
    });
    __sSetOptFn(self, "final", function (cb: any): void {
      __cpStdinClose(self);
      __evCall(cb, [null]);
    });
    __sSetOptFn(self, "destroy", function (err: any, cb: any): void {
      __cpStdinClose(self);
      __evCall(cb, [err]);
    });
  }
}

// Declare or withdraw read interest on a child's pipe. A pipe is ref'd in the
// loop only while someone is reading it: a stdout nobody consumes must not keep
// the program alive (Node's pipe handle is not active until `readStart`).
function __cpPipeWant(self: any, on: boolean): void {
  const pipe: any = self._pipe;
  const id: number = Number(pipe.id);
  if (id === 0 || pipe.eof === true) return;
  pipe.wanted = on;
  if (!__ioHas(id)) return;
  if (on) {
    __ioWant(id, 1);
    const child: any = self._child;
    if (child === null || child._cp.unreffed !== true) __ioRef(id);
  } else {
    __ioUnwant(id, 1);
    __ioUnref(id);
  }
}

// The loop says the pipe has data or has ended: drain it.
function __cpPipeReadable(self: any): void {
  const pipe: any = self._pipe;
  const ops: any = __cpLoopOps();
  if (ops === null || ops === undefined) return;
  while (true) {
    const id: number = Number(pipe.id);
    if (id === 0 || pipe.eof === true) return;
    const payload: any = __cpNative.cpRead(id, 0);
    const text: string = String(payload);
    if (text === "-") {
      __cpPipeClose(self);
      return;
    }
    const marker: string = text.charAt(1);
    if (marker === "A") return;
    if (marker === "E") {
      pipe.eof = true;
      __ioUnregister(id);
      pipe.id = 0;
      self.push(null);
      return;
    }
    const chunk: Buffer = Buffer.from(text.slice(2), "base64");
    if (self.push(chunk) !== true) {
      // Backpressure: stop declaring interest until `_read` is called again.
      pipe.wanted = false;
      __ioUnwant(id, 1);
      __ioUnref(id);
      return;
    }
  }
}

// Release the pipe's loop handle (idempotent).
function __cpPipeClose(self: any): void {
  const pipe: any = self._pipe;
  const id: number = Number(pipe.id);
  if (id === 0) return;
  pipe.id = 0;
  __ioUnregister(id);
}

// `_write` on stdin: hand the bytes to the writer thread.
function __cpStdinWrite(self: any, chunk: any, encoding: any, cb: any): void {
  const pipe: any = self._pipe;
  const ops: any = __cpLoopOps();
  if (Number(pipe.id) === 0 || pipe.closed === true || ops === null || ops === undefined) {
    __evCall(cb, [__cpErrno("EPIPE", __cpIsWindows ? -4047 : -32, "write")]);
    return;
  }
  let encoded: string = "";
  if (typeof chunk === "string") {
    const text: string = chunk;
    let name: string = encoding === undefined || encoding === null ? "utf8" : String(encoding);
    if (name === "" || name === "buffer") name = "utf8";
    const bytes: Buffer = Buffer.from(text, name);
    encoded = bytes.toString("base64");
  } else {
    const view: Buffer = chunk;
    encoded = view.toString("base64");
  }
  const reply: string = String(__cpNative.cpWrite(Number(pipe.id), encoded));
  if (reply === "-") {
    __evCall(cb, [__cpErrno("EPIPE", __cpIsWindows ? -4047 : -32, "write")]);
    return;
  }
  __evCall(cb, [null]);
}

// Close the child's stdin once everything queued has been written.
function __cpStdinClose(self: any): void {
  const pipe: any = self._pipe;
  const id: number = Number(pipe.id);
  if (id === 0 || pipe.closed === true) return;
  pipe.closed = true;
  const ops: any = __cpLoopOps();
  if (ops !== null && ops !== undefined) __cpNative.cpCloseStdin(id);
  pipe.id = 0;
}

// ---- ChildProcess --------------------------------------------------------

class ChildProcess extends EventEmitter {
  // Node's own names. `_handle` is non-null from a successful spawn until the
  // child exits, which is what `kill()` and the `AbortSignal` path test.
  _handle: any = null;
  _cp: any = null;
  pid: any = undefined;
  exitCode: any = null;
  signalCode: any = null;
  spawnfile: any = undefined;
  spawnargs: any = [];
  killed: any = false;
  connected: any = false;
  stdin: any = null;
  stdout: any = null;
  stderr: any = null;
  stdio: any = [null, null, null];
  _closesNeeded: any = 1;
  _closesGot: any = 0;
  killSignal: any = "SIGTERM";

  constructor() {
    super();
    // The native handle numbers and the ref bookkeeping; see `__cpSpawnInto`.
    this._cp = { proc: 0, unreffed: false, flushed: false };
  }

  // `ChildProcess.prototype.spawn(options)`: the low-level entry point
  // `child_process.spawn` calls with a normalized options object
  // (`file`, `args` including argv[0], `envPairs`, `cwd`, `stdio`, ...).
  spawn(options?: any): any {
    return __cpChildSpawn(this, options);
  }

  kill(sig?: any): boolean {
    return __cpKill(this, sig);
  }

  ref(): void {
    __cpSetRef(this, true);
  }

  unref(): void {
    __cpSetRef(this, false);
  }

  // The IPC channel is not implemented (see the header).
  get channel(): any {
    return undefined;
  }

  send(message?: any, handle?: any, options?: any, callback?: any): boolean {
    const _ignored: any = [message, handle, options, callback];
    throw __cpNotImplemented("ChildProcess.send (there is no IPC channel)");
  }

  disconnect(): void {
    throw __cpNotImplemented("ChildProcess.disconnect (there is no IPC channel)");
  }
}

// `child.kill(sig)`.
function __cpKill(child: any, sig: any): boolean {
  const signal: string =
    sig === 0
      ? "0"
      : __cpConvertToValidSignal(sig === undefined ? child.killSignal : sig);
  const state: any = child._cp;
  const ops: any = __cpLoopOps();
  if (child._handle !== null && Number(state.proc) !== 0 && ops !== null && ops !== undefined) {
    const code: string = String(__cpNative.cpKill(Number(state.proc), signal)).slice(1);
    if (code === "") {
      child.killed = true;
      return true;
    }
    if (code === "ESRCH") {
      // Already dead.
    } else if (code === "EINVAL" || code === "ENOSYS") {
      throw __cpErrno(code, code === "EINVAL" ? (__cpIsWindows ? -4071 : -22) : (__cpIsWindows ? -4054 : -38), "kill");
    } else {
      child.emit("error", __cpErrno(code, -1, "kill"));
    }
  }
  return false;
}

// `ref()`/`unref()`: the process handle and every pipe still registered.
function __cpSetRef(child: any, on: boolean): void {
  const state: any = child._cp;
  state.unreffed = !on;
  if (Number(state.proc) !== 0) {
    if (on) __ioRef(Number(state.proc));
    else __ioUnref(Number(state.proc));
  }
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null || stream === undefined) continue;
    const pipe: any = stream._pipe;
    if (pipe === null || pipe === undefined || Number(pipe.id) === 0) continue;
    if (on) {
      if (pipe.wanted === true) __ioRef(Number(pipe.id));
    } else {
      __ioUnref(Number(pipe.id));
    }
  }
}

// `maybeClose`: 'close' fires once the process and every piped output stream
// are done, with the final exit code and signal.
function __cpMaybeClose(child: any): void {
  child._closesGot = Number(child._closesGot) + 1;
  if (Number(child._closesGot) === Number(child._closesNeeded)) {
    child.emit("close", child.exitCode, child.signalCode);
  }
}

// `flushStdio`: an output stream nobody is reading would never end, and so
// would never let 'close' fire.
function __cpFlushStdio(child: any): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (stream === null || stream === undefined) continue;
    if (stream.readable !== true) continue;
    stream.resume();
  }
}

// `ChildProcess`'s `onexit(exitCode, signalCode)`.
function __cpOnExit(child: any, exitCode: any, signalCode: any): void {
  if (signalCode !== null && signalCode !== undefined && signalCode !== "") {
    child.signalCode = signalCode;
  } else {
    child.exitCode = exitCode;
  }
  if (child.stdin !== null && child.stdin !== undefined) child.stdin.destroy();
  child._handle = null;
  const state: any = child._cp;
  if (Number(state.proc) !== 0) {
    const id: number = Number(state.proc);
    state.proc = 0;
    __ioUnregister(id);
  }
  if (exitCode !== null && exitCode !== undefined && Number(exitCode) < 0) {
    const syscall: string =
      child.spawnfile !== undefined && child.spawnfile !== null
        ? "spawn " + String(child.spawnfile)
        : "spawn";
    const error: any = __cpErrno(
      state.errorCode === undefined ? "UNKNOWN" : String(state.errorCode),
      Number(exitCode),
      syscall,
    );
    if (child.spawnfile !== undefined && child.spawnfile !== null) {
      error.path = child.spawnfile;
    }
    const spawnargs: any[] = [];
    const count: number = Number(child.spawnargs.length);
    for (let i = 1; i < count; i++) spawnargs.push(child.spawnargs[i]);
    error.spawnargs = spawnargs;
    child.emit("error", error);
  } else {
    child.emit("exit", child.exitCode, child.signalCode);
  }
  process.nextTick(__cpFlushStdio, child);
  __cpMaybeClose(child);
}

// The loop says the process handle is ready: the child has exited.
function __cpProcReady(child: any): void {
  const state: any = child._cp;
  const ops: any = __cpLoopOps();
  if (ops === null || ops === undefined || Number(state.proc) === 0) return;
  const reply: string = String(__cpNative.cpExit(Number(state.proc)));
  if (reply === "-" || reply.charAt(1) === "A") return;
  const fields: string[] = reply.slice(1).split(__CP_US);
  const codeText: string = String(fields[0]);
  const signalText: string = Number(fields.length) > 1 ? String(fields[1]) : "";
  __cpOnExit(
    child,
    codeText === "" ? null : Number(codeText),
    signalText === "" ? null : signalText,
  );
}

// `onErrorNT` for a spawn that failed.
function __cpSpawnFailed(child: any): void {
  const errno: number = Number(child._cp.errno);
  __cpOnExit(child, errno, null);
}

function __cpOnSpawn(child: any): void {
  child.emit("spawn");
}

// Build the pipe-side objects for one stdio slot that is a pipe.
function __cpMakeReadable(child: any, id: number): any {
  const stream: any = new __CpReadable();
  stream._child = child;
  stream._pipe.id = id;
  if (id !== 0) {
    __ioRegister(id, {
      readable(): void {
        __cpPipeReadable(stream);
      },
      writable(): void {},
      failed(): void {},
    });
    // Not a reason to stay alive until someone reads it.
    __ioUnref(id);
    stream.on("close", function (): void {
      __cpMaybeClose(child);
    });
  }
  return stream;
}

// `stdio: ['pipe'|…]` for the async half.
function __cpAsyncStdio(stdio: any): string[] {
  let list: any[] = [];
  if (stdio === undefined || stdio === null) {
    list = ["pipe", "pipe", "pipe"];
  } else if (typeof stdio === "string") {
    if (stdio === "ignore" || stdio === "pipe" || stdio === "inherit" || stdio === "overlapped") {
      list = [stdio, stdio, stdio];
    } else {
      throw new ERR_INVALID_ARG_VALUE("stdio", stdio, "must be one of 'pipe', 'overlapped', 'ignore' or 'inherit'");
    }
  } else if (Array.isArray(stdio)) {
    const count: number = Number(stdio.length);
    for (let i = 0; i < count; i++) list.push(stdio[i]);
  } else {
    throw new ERR_INVALID_ARG_VALUE("stdio", stdio, "must be a string or an array");
  }
  while (Number(list.length) < 3) list.push("pipe");

  let ipcCount: number = 0;
  for (let i = 0; i < Number(list.length); i++) {
    if (list[i] === "ipc") ipcCount = ipcCount + 1;
  }
  if (ipcCount > 1) {
    throw new NodeError("ERR_IPC_ONE_PIPE", "Child process can have only one IPC pipe");
  }
  if (ipcCount === 1) {
    throw __cpNotImplemented("the 'ipc' stdio entry (there is no IPC channel)");
  }

  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    const entry: any = list[i];
    if (entry === undefined || entry === null || entry === "pipe" || entry === "overlapped") {
      out.push("pipe");
    } else if (entry === "ignore") {
      out.push("ignore");
    } else if (entry === "inherit") {
      out.push("inherit");
    } else if (typeof entry === "number" && Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= 2) {
      out.push("fd" + String(entry));
    } else if (
      typeof entry === "object" &&
      typeof entry.fd === "number" &&
      Number(entry.fd) >= 0 &&
      Number(entry.fd) <= 2
    ) {
      out.push("fd" + String(entry.fd));
    } else {
      throw new ERR_INVALID_ARG_VALUE(
        "stdio[" + String(i) + "]",
        entry,
        "is not supported by this runtime (use 'pipe', 'ignore', 'inherit' or 0, 1, 2)",
      );
    }
  }
  return out;
}

// `ChildProcess.prototype.spawn(options)`: validate Node's low-level options
// object, then start the child.
function __cpChildSpawn(child: any, options: any): any {
  __evValidateObject(options, "options");
  if (options.envPairs !== undefined && !Array.isArray(options.envPairs)) {
    throw new ERR_INVALID_ARG_TYPE("options.envPairs", "Array", options.envPairs);
  }
  if (typeof options.file !== "string") {
    throw new ERR_INVALID_ARG_TYPE("options.file", "string", options.file);
  }
  if (options.args !== undefined && !Array.isArray(options.args)) {
    throw new ERR_INVALID_ARG_TYPE("options.args", "Array", options.args);
  }
  const killSignal: string = __cpSanitizeKillSignal(options.killSignal);
  __cpSpawnInto(child, options, killSignal);
  return undefined;
}

function __cpSpawnInto(child: any, o: any, killSignal: string): void {
  const stdio: string[] = __cpAsyncStdio(o.stdio);
  const ops: any = __cpLoopOps();
  if (ops === null || ops === undefined) {
    throw __cpNotImplemented("child_process.spawn (this bundle has no extension)");
  }

  const spawnargs: any[] = [];
  if (o.args !== undefined) {
    for (let i = 0; i < Number(o.args.length); i++) spawnargs.push(o.args[i]);
  }
  child.killSignal = killSignal;
  child.spawnfile = o.file;
  child.spawnargs = spawnargs;

  // The program is `file`; `args[0]` is only argv[0] and is not executed.
  const argv: string[] = [String(o.file)];
  for (let i = 1; i < Number(spawnargs.length); i++) argv.push(String(spawnargs[i]));
  const envPairs: any[] = o.envPairs === undefined ? [] : o.envPairs;

  const header: any[] = [
    o.cwd === undefined || o.cwd === null ? "" : String(o.cwd),
    "0",
    killSignal,
    "Infinity",
    stdio[0],
    stdio[1],
    stdio[2],
    o.windowsHide === true ? "1" : "0",
    o.detached === true ? "1" : "0",
    "1",
    o.uid === undefined || o.uid === null ? "" : String(o.uid),
    o.gid === undefined || o.gid === null ? "" : String(o.gid),
    o.windowsVerbatimArguments === true ? "1" : "0",
  ];
  const request: string =
    __cpJoin(header, __CP_US) +
    __CP_RS +
    __cpJoin(argv, __CP_US) +
    __CP_RS +
    __cpJoin(envPairs, __CP_US) +
    __CP_RS;

  const reply: string = String(__cpNative.cpSpawn(request));
  if (reply === "-" || Number(reply.length) === 0) {
    throw new NodeError("ERR_INVALID_ARG_VALUE", "spawn: malformed request");
  }
  const fields: string[] = reply.slice(1).split(__CP_US);
  const state: any = child._cp;

  if (String(fields[0]) === "err") {
    // A run-time failure is an 'error' event, not a throw — on the next tick,
    // after the caller had the chance to attach a listener.
    state.errorCode = String(fields[1]);
    state.errno = Number(fields[3]);
    child.stdin = stdio[0] === "pipe" ? new __CpWritable() : null;
    child.stdout = stdio[1] === "pipe" ? __cpMakeReadable(child, 0) : null;
    child.stderr = stdio[2] === "pipe" ? __cpMakeReadable(child, 0) : null;
    child.stdio = [child.stdin, child.stdout, child.stderr];
    for (const stream of [child.stdout, child.stderr]) {
      if (stream !== null) process.nextTick(__cpEndDead, stream);
    }
    process.nextTick(__cpSpawnFailed, child);
    return;
  }

  child.pid = Number(fields[1]);
  const procId: number = Number(fields[2]);
  const stdinId: number = Number(fields[3]);
  const outId: number = Number(fields[4]);
  const errId: number = Number(fields[5]);
  state.proc = procId;
  child._handle = { id: procId };

  if (stdinId !== 0) {
    const sink: any = new __CpWritable();
    sink._child = child;
    sink._pipe.id = stdinId;
    child.stdin = sink;
  }
  if (outId !== 0) {
    child.stdout = __cpMakeReadable(child, outId);
    child._closesNeeded = Number(child._closesNeeded) + 1;
  }
  if (errId !== 0) {
    child.stderr = __cpMakeReadable(child, errId);
    child._closesNeeded = Number(child._closesNeeded) + 1;
  }
  child.stdio = [child.stdin, child.stdout, child.stderr];

  __ioRegister(procId, {
    readable(): void {
      __cpProcReady(child);
    },
    writable(): void {},
    failed(): void {},
  });
  __ioWant(procId, 1);
  process.nextTick(__cpOnSpawn, child);
}

// A stream that belongs to a child that never started: it ends at once.
function __cpEndDead(stream: any): void {
  stream.push(null);
}

// `child_process.spawn(file, args, options)`.
function spawn(file?: any, args?: any, options?: any): any {
  const normalized: any = __cpNormalizeSpawn(file, args, options);
  const opts: any = normalized.options;
  if (opts.timeout !== undefined && opts.timeout !== null) {
    __cpValidateInteger(opts.timeout, "timeout", 0);
  }
  const killSignal: string = __cpSanitizeKillSignal(opts.killSignal);
  if (opts.signal !== undefined) __evValidateAbortSignal(opts.signal, "options.signal");

  const child: any = new ChildProcess();
  // Node passes the normalized options straight to `ChildProcess.spawn`.
  const low: any = {};
  const given: any = normalized.options;
  const givenKeys: any[] = Object.keys(given);
  for (let i = 0; i < Number(givenKeys.length); i++) {
    low[String(givenKeys[i])] = given[String(givenKeys[i])];
  }
  low.args = normalized.argv;
  low.cwd = normalized.cwd === "" ? undefined : normalized.cwd;
  low.envPairs = normalized.envPairs;
  low.file = normalized.file;
  low.windowsVerbatimArguments = normalized.windowsVerbatimArguments === true;
  low.killSignal = killSignal;
  child.spawn(low);

  if (opts.timeout !== undefined && opts.timeout !== null && Number(opts.timeout) > 0) {
    const timer: any = { id: null };
    timer.id = setTimeout(function (): void {
      if (timer.id !== null) {
        timer.id = null;
        try {
          child.kill(killSignal);
        } catch (err: any) {
          child.emit("error", err);
        }
      }
    }, Number(opts.timeout));
    child.once("exit", function (): void {
      if (timer.id !== null) {
        clearTimeout(timer.id);
        timer.id = null;
      }
    });
  }

  if (opts.signal !== undefined && opts.signal !== null) {
    const signal: any = opts.signal;
    const onAbort: any = function (): void {
      if (child._handle === null) return;
      if (child.kill(killSignal)) {
        child.emit("error", new AbortError(undefined, { cause: signal.reason }));
      }
    };
    if (signal.aborted === true) {
      process.nextTick(onAbort);
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
      child.once("exit", function (): void {
        signal.removeEventListener("abort", onAbort);
      });
    }
  }
  return child;
}

// ---------------------------------------------------------------------------
// execFile / exec
// ---------------------------------------------------------------------------

function __cpIsEncoding(value: any): boolean {
  if (typeof value !== "string") return false;
  const name: string = String(value).toLowerCase();
  const known: string[] = [
    "utf8", "utf-8", "hex", "base64", "base64url", "ascii", "latin1", "binary",
    "ucs2", "ucs-2", "utf16le", "utf-16le",
  ];
  return Number(known.indexOf(name)) !== -1;
}

// `lib/child_process.js`' `execFile`.
function execFile(file?: any, args?: any, options?: any, callback?: any): any {
  const normalized: any = __cpNormalizeExecFileArgs(file, args, options, callback);
  const given: any = normalized.options;
  const opts: any = {
    encoding: "utf8",
    timeout: 0,
    maxBuffer: __CP_MAX_BUFFER,
    killSignal: "SIGTERM",
    cwd: null,
    env: null,
    shell: false,
  };
  const keys: any[] = Object.keys(given);
  for (let i = 0; i < Number(keys.length); i++) opts[String(keys[i])] = given[String(keys[i])];

  if (opts.timeout !== undefined && opts.timeout !== null) {
    __cpValidateInteger(opts.timeout, "timeout", 0);
  }
  if (typeof opts.maxBuffer !== "number") {
    throw new ERR_INVALID_ARG_TYPE("options.maxBuffer", "number", opts.maxBuffer);
  }
  if (Number.isNaN(Number(opts.maxBuffer)) || Number(opts.maxBuffer) < 0) {
    throw new ERR_OUT_OF_RANGE("options.maxBuffer", ">= 0", opts.maxBuffer);
  }
  opts.killSignal = __cpSanitizeKillSignal(opts.killSignal);

  const childOptions: any = {
    cwd: opts.cwd,
    env: opts.env,
    gid: opts.gid,
    shell: opts.shell,
    signal: opts.signal,
    uid: opts.uid,
    windowsHide: opts.windowsHide === true,
    windowsVerbatimArguments: opts.windowsVerbatimArguments === true,
  };
  const execArgs: any[] = normalized.args;
  const child: any = spawn(normalized.file, execArgs, childOptions);
  const done: any = normalized.callback;

  let encoding: any = null;
  if (opts.encoding !== "buffer" && __cpIsEncoding(opts.encoding)) encoding = opts.encoding;

  const state: any = {
    stdout: [],
    stderr: [],
    stdoutLen: 0,
    stderrLen: 0,
    killed: false,
    exited: false,
    timer: null,
    ex: null,
    cmd: String(normalized.file),
  };

  const join = function (parts: any[]): any {
    if (encoding !== null || (child.stdout !== null && child.stdout.readableEncoding)) {
      return parts.join("");
    }
    const buffers: Buffer[] = [];
    for (const part of parts) {
      const view: Buffer = part;
      buffers.push(view);
    }
    return Buffer.concat(buffers);
  };

  const exitHandler = function (code?: any, signal?: any): void {
    if (state.exited === true) return;
    state.exited = true;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (done === undefined || done === null) return;
    const stdout: any = join(state.stdout);
    const stderr: any = join(state.stderr);
    const sig: any = signal === undefined ? null : signal;
    if (state.ex === null && code === 0 && sig === null) {
      __evCall(done, [null, stdout, stderr]);
      return;
    }
    let cmd: string = state.cmd;
    if (execArgs !== undefined && execArgs !== null && Number(execArgs.length) > 0) {
      cmd = cmd + " " + execArgs.join(" ");
    }
    if (state.ex === null) {
      const failure = new ChildProcessError("Command failed: " + cmd + "\n" + String(stderr));
      failure.code =
        code !== undefined && code !== null && Number(code) < 0 ? __node_util.getSystemErrorName(Number(code)) : code;
      failure.killed = child.killed === true || state.killed === true;
      failure.signal = sig;
      state.ex = failure;
    }
    state.ex.cmd = cmd;
    __evCall(done, [state.ex, stdout, stderr]);
  };

  const destroyOutputs = function (): void {
    if (child.stdout !== null && child.stdout !== undefined) child.stdout.destroy();
    if (child.stderr !== null && child.stderr !== undefined) child.stderr.destroy();
  };

  const killChild = function (): void {
    destroyOutputs();
    state.killed = true;
    try {
      child.kill(opts.killSignal);
    } catch (err: any) {
      state.ex = err;
      exitHandler();
    }
  };

  if (Number(opts.timeout) > 0) {
    state.timer = setTimeout(function (): void {
      killChild();
      state.timer = null;
    }, Number(opts.timeout));
  }

  const collect = function (stream: any, name: string): void {
    if (stream === null || stream === undefined) return;
    if (encoding !== null) stream.setEncoding(encoding);
    const lenKey: string = name + "Len";
    stream.on("data", function (chunk: any): void {
      const enc: any = stream.readableEncoding;
      let length: number = 0;
      if (enc) {
        const text: string = String(chunk);
        length = Number(Buffer.byteLength(text, String(enc)));
      } else {
        const view: Buffer = chunk;
        length = Number(view.length);
      }
      state[lenKey] = Number(state[lenKey]) + length;
      if (Number(state[lenKey]) > Number(opts.maxBuffer)) {
        const truncated: number = Number(opts.maxBuffer) - (Number(state[lenKey]) - length);
        if (enc) {
          state[name].push(String(chunk).slice(0, truncated));
        } else {
          const view: Buffer = chunk;
          state[name].push(view.slice(0, truncated));
        }
        state.ex = __cpMaxBufferError(name);
        killChild();
      } else {
        state[name].push(chunk);
      }
    });
  };
  collect(child.stdout, "stdout");
  collect(child.stderr, "stderr");

  child.addListener("close", exitHandler);
  child.addListener("error", function (err: any): void {
    state.ex = err;
    destroyOutputs();
    exitHandler();
  });
  return child;
}

// `exec(command, options, callback)`: `execFile` through a shell.
function exec(command?: any, options?: any, callback?: any): any {
  const normalized: any = __cpNormalizeExecArgs(command, options, callback);
  return execFile(normalized.file, normalized.options, normalized.callback);
}

function fork(modulePath?: any, args?: any, options?: any): any {
  const _ignored: any = [modulePath, args, options];
  throw __cpNotImplemented("child_process.fork (there is no IPC channel)");
}

// `util.promisify(exec)` / `util.promisify(execFile)`: resolves
// `{ stdout, stderr }`, rejects with `stdout`/`stderr` on the error, and carries
// the `ChildProcess` as `promise.child`.
function __cpExecPromisified(command?: any, options?: any): any {
  let child: any = null;
  const promise: any = new Promise(function (resolve: any, reject: any): void {
    child = exec(command, options === undefined ? {} : options, function (error: any, stdout: any, stderr: any): void {
      if (error !== null && error !== undefined) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: stdout, stderr: stderr });
    });
  });
  promise.child = child;
  return promise;
}

function __cpExecFilePromisified(file?: any, args?: any, options?: any): any {
  let child: any = null;
  const promise: any = new Promise(function (resolve: any, reject: any): void {
    child = execFile(file, args === undefined ? [] : args, options === undefined ? {} : options, function (error: any, stdout: any, stderr: any): void {
      if (error !== null && error !== undefined) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout: stdout, stderr: stderr });
    });
  });
  promise.child = child;
  return promise;
}

// `getValidStdio(stdio, sync)` from `lib/internal/child_process.js`, returning
// `{ stdio, ipc, ipcFd }` where every entry is a descriptor record. The async half
// only starts children whose stdio is 'pipe', 'ignore', 'inherit' or a parent fd,
// so the records are the three Node shapes for those (`pipe`, `ignore`, `fd`) and
// an `ipc` entry is reported as the error Node reports for a *second* one or for
// a synchronous child.
function __cpGetValidStdio(stdioArg: any, sync?: any): any {
  let stdio: any = stdioArg;
  if (typeof stdio === "string") {
    if (stdio === "ignore" || stdio === "pipe" || stdio === "inherit" || stdio === "overlapped") {
      stdio = [stdio, stdio, stdio];
    } else {
      throw new ERR_INVALID_ARG_VALUE("stdio", stdio, "is invalid");
    }
  } else if (!Array.isArray(stdio)) {
    throw new ERR_INVALID_ARG_VALUE("stdio", stdio, "is invalid");
  }
  // Node fills the caller's array up to three entries in place.
  while (Number(stdio.length) < 3) stdio.push(undefined);

  const result: any[] = [];
  let ipc: any = undefined;
  let ipcFd: any = undefined;
  for (let i = 0; i < Number(stdio.length); i++) {
    const entry: any = stdio[i];
    if (entry === null || entry === undefined) {
      result.push(i < 3 ? { type: "pipe", readable: i === 0, writable: i !== 0 } : { type: "ignore" });
    } else if (entry === "ignore") {
      result.push({ type: "ignore" });
    } else if (entry === "pipe" || entry === "overlapped") {
      result.push({ type: "pipe", readable: i === 0, writable: i !== 0 });
    } else if (entry === "ipc") {
      if (sync === true) throw new NodeError("ERR_IPC_SYNC_FORK", "IPC cannot be used with synchronous forks");
      if (ipc !== undefined) throw new NodeError("ERR_IPC_ONE_PIPE", "Child process can have only one IPC pipe");
      ipc = {};
      ipcFd = i;
      result.push({ type: "pipe", handle: ipc, ipc: true });
    } else if (entry === "inherit") {
      result.push({ type: "inherit", fd: i });
    } else if (typeof entry === "number") {
      result.push({ type: "fd", fd: entry });
    } else if (typeof entry === "object" && typeof entry.fd === "number") {
      result.push({ type: "fd", fd: entry.fd });
    } else if (typeof entry === "string") {
      if (sync !== true) {
        throw new NodeTypeError("ERR_INVALID_SYNC_FORK_INPUT", "Asynchronous forks do not support Buffer, TypedArray, DataView or string input: " + String(entry));
      }
      result.push({ type: "pipe" });
    } else {
      throw new ERR_INVALID_ARG_VALUE("stdio", entry, "is invalid");
    }
  }
  return { stdio: result, ipc: ipc, ipcFd: ipcFd };
}

// `require('internal/child_process')`: the pieces Node's own tests reach for.
const __node_internal_child_process: any = {
  ChildProcess: ChildProcess,
  getValidStdio(stdio?: any, sync?: any): any {
    return __cpGetValidStdio(stdio, sync);
  },
};

// `node:child_process` module object for the bundler's `require` rewriting.
const __node_child_process: any = {
  spawnSync: spawnSync,
  execSync: execSync,
  execFileSync: execFileSync,
  exec: exec,
  execFile: execFile,
  spawn: spawn,
  fork: fork,
  ChildProcess: ChildProcess,
  _forkChild(): void {
    throw __cpNotImplemented("child_process._forkChild");
  },
};

// `process.execPath` — the running interpreter. `process.ts` has no extension of
// its own and has to keep compiling without `--ext`, so the field is filled in
// here, the way `os.ts` fills in `process.pid`: whenever `child_process` is in
// the bundle, the real path is available.
process.execPath = __cpNative.cpExecPath();
{
  const custom: any = Symbol.for("nodejs.util.promisify.custom");
  const execFn: any = __node_child_process.exec;
  execFn[custom] = __cpExecPromisified;
  const execFileFn: any = __node_child_process.execFile;
  execFileFn[custom] = __cpExecFilePromisified;
}
// Node reports the same path as `argv[0]`; tests spawn `process.argv[0]` as often as
// `process.execPath`.
process.argv[0] = process.execPath;

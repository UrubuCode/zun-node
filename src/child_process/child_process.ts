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
// **Here:** `spawnSync`, `execSync`, `execFileSync` — the whole synchronous
// surface, with `cwd`, `env`, `input`, `encoding`, `shell`, `timeout`,
// `killSignal`, `maxBuffer`, `stdio`, `windowsHide`, `argv0`, `uid`/`gid` and
// `detached`.
//
// **Not here:** a real `ChildProcess`. Node's is an `EventEmitter` whose
// `stdin`/`stdout`/`stderr` are `node:stream` objects, and `node:stream` does
// not exist in this library yet, so there is nothing for `spawn()` to return and
// nothing for `fork()` to open an IPC channel over. `spawn` and `fork`
// therefore throw `ERR_METHOD_NOT_IMPLEMENTED` rather than pretending.
//
// **Here, with a stated deviation:** `exec` and `execFile`. Their *callback*
// contract — `(error, stdout, stderr)`, delivered on a later tick, with
// `error.code` the exit status and `error.killed`/`error.signal` set — is
// reproducible without streams, so it is reproduced: the child runs through the
// synchronous native and the callback is delivered through
// `process.nextTick`. What is *not* reproduced is the concurrency: the child
// runs to completion before `exec` returns, so two `exec` calls do not overlap
// and the returned object carries no `stdout`/`stderr` streams and no 'close'
// event. A test that only reads the callback behaves as in Node; one that
// touches `child.stdout` does not, and that is the line `node:stream` moves.
//
// ---------------------------------------------------------------------------
// `process.execPath` and Node's self-re-execution pattern
// ---------------------------------------------------------------------------
//
// A great many of Node's `child_process` tests are shaped like
// `spawnSync(process.execPath, [__filename, 'child'])`: the test re-runs *itself*
// in a child process to observe a different environment. `process.execPath` is
// real here — `cpExecPath()` is the host's own executable, i.e. the `zun`
// binary — but the pattern still cannot work, because the child would be handed
// a raw CommonJS test file and the engine has no `require`
// (https://github.com/UrubuCode/zun/issues/4): the file would have to be put
// through `tools/bundle_node_test.sh` first. That is a property of the harness,
// not of this module, and it is the single largest reason this corpus scores
// low. See `test/child_process/README.md` for the count.

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
// declared as a class of its own: `src/fs/fs.ts` already declares a class of
// that name, and a bundle that requires both modules would then have two
// top-level declarations of one name, which a single Zun program cannot have.
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

class ERR_UNKNOWN_SIGNAL extends NodeTypeError {
  constructor(signal: any) {
    super("ERR_UNKNOWN_SIGNAL", "Unknown signal: " + inspect(signal));
  }
}

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

  if (options === undefined || options === null) {
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
  const keys: any[] = Object.keys(sourceEnv);
  const keyCount: number = Number(keys.length);
  const seen: any = {};
  for (let i = 0; i < keyCount; i++) {
    const key: string = String(keys[i]);
    const value: any = sourceEnv[key];
    if (value === undefined) continue;
    // Windows environment names are case-insensitive, so a duplicate that
    // differs only in case would create two entries for one variable.
    const folded: string = __cpIsWindows ? key.toUpperCase() : key;
    if (seen[folded] === true) continue;
    seen[folded] = true;
    pairs.push(key + "=" + String(value));
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
// exec / execFile — the callback contract without the streams
// ---------------------------------------------------------------------------
//
// See the header: the child runs synchronously and only the *callback* is
// deferred, so a test that reads `(error, stdout, stderr)` sees Node's
// behaviour while one that reads `child.stdout` does not. The returned handle is
// deliberately thin and says so, rather than impersonating a `ChildProcess`.
const __cpPending: any = { records: {}, next: 1 };

function __cpDeliver(key: any): void {
  const slot: string = String(key);
  const record: any = __cpPending.records[slot];
  if (record === undefined || record === null) return;
  const records: any = __cpPending.records;
  delete records[slot];
  __evCall(record.callback, [record.error, record.stdout, record.stderr]);
}

// `exec`'s error for a child that failed: `code` is the exit status (not a
// string), `killed`/`signal` describe a kill, and `cmd` is the command line.
function __cpExecError(result: any, cmd: string, stdout: any, stderr: any): any {
  if (result.error !== undefined && result.error !== null) {
    const existing: any = result.error;
    existing.cmd = cmd;
    existing.killed = false;
    return existing;
  }
  const status: any = result.status;
  const signal: any = result.signal;
  if ((status === null || Number(status) === 0) && (signal === null || signal === undefined)) {
    return null;
  }
  let message: string = "Command failed: " + cmd + "\n";
  if (stderr !== undefined && stderr !== null) message = message + String(stderr.toString());
  const error = new ChildProcessError(message);
  error.code = status === null ? null : Number(status);
  error.killed = signal !== null && signal !== undefined;
  error.signal = signal === undefined ? null : signal;
  error.cmd = cmd;
  return error;
}

function __cpRunDeferred(file: any, args: any, options: any, callback: any, cmd: string): any {
  // `exec`/`execFile` default to utf8 strings, not Buffers.
  const opts: any = {};
  if (options !== undefined && options !== null) {
    const keys: any[] = Object.keys(options);
    const count: number = Number(keys.length);
    for (let i = 0; i < count; i++) {
      const key: string = String(keys[i]);
      opts[key] = options[key];
    }
  }
  if (opts.encoding === undefined || opts.encoding === null) opts.encoding = "utf8";
  const result: any = spawnSync(file, args, opts);
  const stdout: any = result.stdout === null ? "" : result.stdout;
  const stderr: any = result.stderr === null ? "" : result.stderr;
  const error: any = __cpExecError(result, cmd, stdout, stderr);

  const handle: any = {
    pid: result.pid,
    exitCode: result.status,
    signalCode: result.signal,
    killed: false,
    spawnfile: file,
    stdin: null,
    stdout: null,
    stderr: null,
    stdio: [null, null, null],
    kill(signal?: any): boolean {
      // The child has already exited by the time this object exists.
      const _ignored: any = signal;
      return false;
    },
    unref(): void {},
    ref(): void {},
  };

  if (callback !== undefined && callback !== null) {
    const key: number = Number(__cpPending.next);
    __cpPending.next = key + 1;
    __cpPending.records[String(key)] = {
      callback: callback,
      error: error,
      stdout: stdout,
      stderr: stderr,
    };
    // Node delivers the callback from the event loop, never synchronously.
    process.nextTick(__cpDeliver, key);
  }
  return handle;
}

function exec(command?: any, options?: any, callback?: any): any {
  const normalized: any = __cpNormalizeExecArgs(command, options, callback);
  return __cpRunDeferred(
    normalized.file,
    [],
    normalized.options,
    normalized.callback,
    String(command),
  );
}

function execFile(file?: any, args?: any, options?: any, callback?: any): any {
  const normalized: any = __cpNormalizeExecFileArgs(file, args, options, callback);
  const cmd: string =
    Number(normalized.args.length) > 0
      ? String(normalized.file) + " " + normalized.args.join(" ")
      : String(normalized.file);
  return __cpRunDeferred(
    normalized.file,
    normalized.args,
    normalized.options,
    normalized.callback,
    cmd,
  );
}

// ---------------------------------------------------------------------------
// The asynchronous half, which needs node:stream
// ---------------------------------------------------------------------------

function spawn(file?: any, args?: any, options?: any): any {
  const _ignored: any = [file, args, options];
  throw __cpNotImplemented(
    "child_process.spawn (a ChildProcess needs node:stream for its stdio)",
  );
}

function fork(modulePath?: any, args?: any, options?: any): any {
  const _ignored: any = [modulePath, args, options];
  throw __cpNotImplemented("child_process.fork (an IPC channel needs node:stream)");
}

// `node:child_process` module object for the bundler's `require` rewriting.
const __node_child_process: any = {
  spawnSync: spawnSync,
  execSync: execSync,
  execFileSync: execFileSync,
  exec: exec,
  execFile: execFile,
  spawn: spawn,
  fork: fork,
};

// `process.execPath` — the running interpreter. `process.ts` has no extension of
// its own and has to keep compiling without `--ext`, so the field is filled in
// here, the way `os.ts` fills in `process.pid`: whenever `child_process` is in
// the bundle, the real path is available.
process.execPath = __cpNative.cpExecPath();

// node:tty — `isatty`, the two terminal streams and the colour-depth
// detection table, in Zun TypeScript.
//
// Behavior is defined by Node.js 25. Two files are followed:
// `lib/tty.js` for the module (the `fd` validation, the `ReadStream` /
// `WriteStream` shapes, `getWindowSize`, and the four backwards-compatible
// cursor methods that delegate to `readline`) and `lib/internal/tty.js` for
// `getColorDepth` / `hasColors` — both MIT, Copyright Joyent, Inc. and other
// Node contributors, with `lib/internal/tty.js`'s table itself derived from
// Sindre Sorhus' `supports-color` (MIT) and from `dircolors`.
//
// This replaces the `__node_tty` stub that used to live in
// `tools/harness/common.ts`: `isatty` is a real question this runtime can
// answer (`src/process/process.ts`' `__processIsTty`, which reads the
// `node:process` extension's `isTty(fd)` or the `zun:core` host's single
// `isTty()` flag), and `getColorDepth` is pure computation over
// `process.env`.
//
// ---------------------------------------------------------------------------
// Where the seam is, and what is honestly missing
// ---------------------------------------------------------------------------
//
// A TTY in Node is a libuv handle: `uv_tty_init` on a file descriptor, then
// `setBlocking`, `getWindowSize` and `uv_tty_set_mode` on it. This runtime has
// none of those. What it does have is the three standard streams and the
// `isTty(fd)` predicate, so the seam is drawn there:
//
//   | member                      | what this module answers                 |
//   | --------------------------- | ---------------------------------------- |
//   | `isatty(fd)`                | the real predicate, for any fd           |
//   | `new WriteStream(fd)`       | a `Duplex` over fd 1 / 2 when that fd is |
//   |                             | a terminal; `ERR_TTY_INIT_FAILED`        |
//   |                             | otherwise — which is what Node throws    |
//   |                             | for a non-terminal fd too                |
//   | `new ReadStream(fd)`        | the same, over fd 0                      |
//   | `getColorDepth` / `hasColors` | Node's full environment table          |
//   | `columns` / `rows`          | `undefined` — there is no                |
//   |                             | `getWindowSize` capability (see below)   |
//   | `cursorTo` / `moveCursor` / | `readline`'s own functions, reached      |
//   | `clearLine` / `clearScreenDown` | through the module object, exactly   |
//   |                             | as `lib/tty.js` reaches them             |
//   | `setRawMode(flag)`          | records the flag; the terminal mode is   |
//   |                             | not changed (see below)                  |
//
// Two of those are gaps rather than seams, and both are named at their use
// site below:
//
//   * **window size.** Node reads it from the libuv handle. There is no
//     native for it here, so `columns` and `rows` stay `undefined` and
//     `getWindowSize()` answers `[undefined, undefined]` — which is the same
//     shape Node reports when `uv_tty_get_winsize` fails, and the same thing
//     `process.stdout.columns` already answers in this library.
//   * **the Windows branch of `getColorDepth`.** Node refines 16 colours to
//     256 (build >= 10586) or 16m (build >= 14931) by reading
//     `os.release()`. `node:os` is a native extension here, and a `node:tty`
//     bundle is run without one (`node:tty` is required by `console`'s own
//     corpus, which is `zun-ts`), so the release is unknown and the Windows
//     answer is Node's own pre-Windows-10 fallback, `COLORS_16`.
//     `__ttyOSReleaseParts()` is the single place that would change if a
//     release ever became readable without an extension.
//   * **raw mode.** `uv_tty_set_mode` has no counterpart in this runtime.
//     `setRawMode` therefore records `isRaw` and leaves the terminal alone —
//     the same no-op `process.stdin.setRawMode` already is in
//     `src/process/process.ts`. A consumer that *depends* on raw mode (a key
//     reader) will see cooked input; nothing here claims otherwise.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `Number(x.length)` on every string length (zun#3).
//   * `__ttyCc(s, i)` rather than `s.charCodeAt(i)` (zun#2).
//   * The module's functions are **object-literal methods** delegating to
//     top-level `__tty*` functions (zun#17).
//   * The `fd` validation and the writable sink are built by a top-level
//     function that runs *inside the `super(...)` argument*, because a
//     statement cannot precede `super` and the `Duplex` options have to carry
//     the sink closure.

// ===========================================================================
// Errors
// ===========================================================================

class ERR_INVALID_FD extends NodeRangeError {
  constructor(value: any) {
    super(
      "ERR_INVALID_FD",
      '"fd" must be a positive integer: ' + String(value),
    );
  }
}

// Node's `ERR_TTY_INIT_FAILED` is a `SystemError`, which carries an `info`
// object and reports `name === 'SystemError'`. There is no `SystemError` base
// in this library, so the code, the message and `info` are reproduced and the
// name stays `Error`; the divergence is recorded in ../../test/tty/README.md.
class ERR_TTY_INIT_FAILED extends NodeError {
  info: any;
  constructor(info: any) {
    super(
      "ERR_TTY_INIT_FAILED",
      "TTY initialization failed: uv_tty_init returned " +
        String(info.code) + " (" + String(info.message) + ")",
    );
    this.info = info;
  }
}

// libuv's two errors for `uv_tty_init` on a descriptor that is not a
// terminal: `EBADF` on Windows, `EINVAL` elsewhere. The numbers are libuv's
// `UV_EBADF` / `UV_EINVAL`, which is what Node's own
// `test-ttywrap-invalid-fd.js` compares against.
function __ttyInitFailure(): any {
  if (process.platform === "win32") {
    return {
      code: "EBADF",
      message: "bad file descriptor",
      errno: -4083,
      syscall: "uv_tty_init",
    };
  }
  return {
    code: "EINVAL",
    message: "invalid argument",
    errno: -22,
    syscall: "uv_tty_init",
  };
}

// ===========================================================================
// isatty
// ===========================================================================

// `charCodeAt` past the end throws here instead of answering NaN (zun#2).
function __ttyCc(text: string, index: number): number {
  if (index < 0 || index >= Number(text.length)) return 0;
  return Number(text.charCodeAt(index));
}

// `lib/tty.js`' `isatty`: an integer in `[0, 2**31)` that the platform calls a
// terminal. `__processIsTty` is `src/process/process.ts`' one predicate, which
// reads the `node:process` extension when one is loaded and the `zun:core`
// host's single stdout flag when none is.
function __ttyIsatty(fd: any): boolean {
  if (typeof fd !== "number") return false;
  const n: number = Number(fd);
  if (!Number.isInteger(n)) return false;
  if (n < 0 || n > 2147483647) return false;
  return __processIsTty(n) === true;
}

// ===========================================================================
// getColorDepth / hasColors
// ===========================================================================
//
// `lib/internal/tty.js`, followed statement for statement: the order of the
// tests is the whole behaviour, and `test/pseudo-tty/test-tty-get-color-depth.js`
// walks it case by case.

const __TTY_COLORS_2: number = 1;
const __TTY_COLORS_16: number = 4;
const __TTY_COLORS_256: number = 8;
const __TTY_COLORS_16M: number = 24;

// `TERM` values known to support 16 colours, plus the handful that support
// 24-bit. Taken from `lib/internal/tty.js`, where the 16-colour rows come from
// `dircolors` (Copyright (C) 1996-2016 Free Software Foundation, Inc.).
const __TTY_TERM_ENVS: any = {
  "eterm": __TTY_COLORS_16,
  "cons25": __TTY_COLORS_16,
  "console": __TTY_COLORS_16,
  "cygwin": __TTY_COLORS_16,
  "dtterm": __TTY_COLORS_16,
  "gnome": __TTY_COLORS_16,
  "hurd": __TTY_COLORS_16,
  "jfbterm": __TTY_COLORS_16,
  "konsole": __TTY_COLORS_16,
  "kterm": __TTY_COLORS_16,
  "mlterm": __TTY_COLORS_16,
  "mosh": __TTY_COLORS_16M,
  "putty": __TTY_COLORS_16,
  "st": __TTY_COLORS_16,
  "rxvt-unicode-24bit": __TTY_COLORS_16M,
  "terminator": __TTY_COLORS_16M,
  "xterm-kitty": __TTY_COLORS_16M,
};

// The CI vendors, in the order `lib/internal/tty.js` lists them — the order
// matters, because the first environment variable present wins.
const __TTY_CI_NAMES: string[] = [
  "APPVEYOR",
  "BUILDKITE",
  "CIRCLECI",
  "DRONE",
  "GITEA_ACTIONS",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "TRAVIS",
];

const __TTY_CI_COLORS: number[] = [
  __TTY_COLORS_256,
  __TTY_COLORS_256,
  __TTY_COLORS_16M,
  __TTY_COLORS_256,
  __TTY_COLORS_16M,
  __TTY_COLORS_16M,
  __TTY_COLORS_256,
  __TTY_COLORS_256,
];

// `lib/internal/tty.js`' `TERM_ENVS_REG_EXP`, as a function of inline literals
// rather than an array of `RegExp` values. That is an engine workaround: a
// `RegExp` read out of an array (or out of a module-level `const`) has lost
// its methods by the time it is used -- `re.exec(s)` answers "exec is not a
// function" (zun#7, zun#17) -- while a literal written where it is matched
// keeps its static type and works. Same move `src/readline/readline.ts` makes
// for its key-sequence patterns.
function __ttyTermMatchesAnsiFamily(term: string): boolean {
  if (/ansi/.exec(term) !== null) return true;
  if (/color/.exec(term) !== null) return true;
  if (/linux/.exec(term) !== null) return true;
  if (/direct/.exec(term) !== null) return true;
  if (/^con[0-9]*x[0-9]/.exec(term) !== null) return true;
  if (/^rxvt/.exec(term) !== null) return true;
  if (/^screen/.exec(term) !== null) return true;
  if (/^xterm/.exec(term) !== null) return true;
  if (/^vt100/.exec(term) !== null) return true;
  if (/^vt220/.exec(term) !== null) return true;
  return false;
}

// `FORCE_COLOR` overrides `NO_COLOR` / `NODE_DISABLE_COLORS`, and Node warns
// once that it did. The flag is module-level because Node's is too.
const __ttyWarnState: any = { warned: false };

function __ttyWarnOnDeactivatedColors(env: any): void {
  if (__ttyWarnState.warned === true) return;
  let name: string = "";
  const disabled: any = env.NODE_DISABLE_COLORS;
  if (disabled !== undefined && String(disabled) !== "") {
    name = "NODE_DISABLE_COLORS";
  }
  const noColor: any = env.NO_COLOR;
  if (noColor !== undefined && String(noColor) !== "") {
    if (name !== "") name = name + "' and '";
    name = name + "NO_COLOR";
  }
  if (name !== "") {
    process.emitWarning(
      "The '" + name +
        "' env is ignored due to the 'FORCE_COLOR' env being set.",
      "Warning",
    );
    __ttyWarnState.warned = true;
  }
}

function __ttyHasOwn(env: any, name: string): boolean {
  if (env === null || env === undefined) return false;
  return Object.prototype.hasOwnProperty.call(env, name) === true;
}

// The Windows release as `[major, minor, build]`. Empty here: see the header
// — `os.release()` lives behind the native extension and a `node:tty` bundle
// runs without one, so the Windows branch takes Node's own pre-Windows-10
// fallback. This is the single place to change if the release ever becomes
// readable without an extension.
function __ttyOSReleaseParts(): string[] {
  return [];
}

function __ttyGetColorDepth(env?: any): number {
  const environment: any = env === undefined || env === null
    ? process.env
    : env;

  const force: any = environment.FORCE_COLOR;
  if (force !== undefined) {
    const value: string = String(force);
    if (value === "" || value === "1" || value === "true") {
      __ttyWarnOnDeactivatedColors(environment);
      return __TTY_COLORS_16;
    }
    if (value === "2") {
      __ttyWarnOnDeactivatedColors(environment);
      return __TTY_COLORS_256;
    }
    if (value === "3") {
      __ttyWarnOnDeactivatedColors(environment);
      return __TTY_COLORS_16M;
    }
    return __TTY_COLORS_2;
  }

  const disabled: any = environment.NODE_DISABLE_COLORS;
  const noColor: any = environment.NO_COLOR;
  if (
    (disabled !== undefined && String(disabled) !== "") ||
    (noColor !== undefined && String(noColor) !== "") ||
    // The "dumb" terminal of terminfo has no ANSI colour control codes.
    environment.TERM === "dumb"
  ) {
    return __TTY_COLORS_2;
  }

  if (process.platform === "win32") {
    const release: string[] = __ttyOSReleaseParts();
    if (Number(release.length) >= 3 && Number(release[0]) >= 10) {
      const build: number = Number(release[2]);
      if (build >= 14931) return __TTY_COLORS_16M;
      if (build >= 10586) return __TTY_COLORS_256;
    }
    return __TTY_COLORS_16;
  }

  if (environment.TMUX) return __TTY_COLORS_16M;

  // Azure DevOps.
  if (__ttyHasOwn(environment, "TF_BUILD") && __ttyHasOwn(environment, "AGENT_NAME")) {
    return __TTY_COLORS_16;
  }

  if (__ttyHasOwn(environment, "CI")) {
    const count: number = Number(__TTY_CI_NAMES.length);
    for (let i = 0; i < count; i++) {
      if (__ttyHasOwn(environment, __TTY_CI_NAMES[i])) {
        return __TTY_CI_COLORS[i];
      }
    }
    if (environment.CI_NAME === "codeship") return __TTY_COLORS_256;
    return __TTY_COLORS_2;
  }

  if (__ttyHasOwn(environment, "TEAMCITY_VERSION")) {
    const version: string = String(environment.TEAMCITY_VERSION);
    return /^(9\.(0*[1-9]\d*)\.|\d{2,}\.)/.exec(version) !== null
      ? __TTY_COLORS_16
      : __TTY_COLORS_2;
  }

  const program: any = environment.TERM_PROGRAM;
  if (program === "iTerm.app") {
    const version: any = environment.TERM_PROGRAM_VERSION;
    if (
      version === undefined || String(version) === "" ||
      /^[0-2]\./.exec(String(version)) !== null
    ) {
      return __TTY_COLORS_256;
    }
    return __TTY_COLORS_16M;
  }
  if (program === "HyperTerm" || program === "MacTerm") return __TTY_COLORS_16M;
  if (program === "Apple_Terminal") return __TTY_COLORS_256;

  if (
    environment.COLORTERM === "truecolor" || environment.COLORTERM === "24bit"
  ) {
    return __TTY_COLORS_16M;
  }

  if (environment.TERM) {
    const term: string = String(environment.TERM);
    if (/truecolor/.exec(term) !== null) return __TTY_COLORS_16M;
    if (/^xterm-256/.exec(term) !== null) return __TTY_COLORS_256;
    const lower: string = term.toLowerCase();
    const known: any = __TTY_TERM_ENVS[lower];
    if (known !== undefined && Number(known) > 0) return Number(known);
    if (__ttyTermMatchesAnsiFamily(lower)) return __TTY_COLORS_16;
  }

  // 16-colour COLORTERM is checked after 16m and 256, so that a
  // `COLORTERM=truecolor` is not shadowed by it.
  if (environment.COLORTERM) return __TTY_COLORS_16;
  return __TTY_COLORS_2;
}

// `hasColors([count][, env])`. The two arguments are overloaded exactly as in
// `lib/internal/tty.js`: a single object argument is the environment, and a
// single number is the colour count.
function __ttyHasColors(count?: any, env?: any): boolean {
  let colors: any = count;
  let environment: any = env;
  if (
    environment === undefined &&
    (colors === undefined || (typeof colors === "object" && colors !== null))
  ) {
    environment = colors;
    colors = 16;
  } else {
    if (typeof colors !== "number" || !Number.isInteger(Number(colors))) {
      throw new ERR_INVALID_ARG_TYPE("count", "integer", count);
    }
    if (Number(colors) < 2) {
      throw new ERR_OUT_OF_RANGE("count", ">= 2", count);
    }
  }
  return Number(colors) <= Math.pow(2, __ttyGetColorDepth(environment));
}

// ===========================================================================
// ReadStream / WriteStream
// ===========================================================================

// `lib/tty.js` validates the descriptor with `fd >> 0 !== fd || fd < 0`,
// which rejects a non-integer, a negative and anything outside int32.
function __ttyValidateFd(fd: any): number {
  if (typeof fd !== "number" || !Number.isInteger(Number(fd))) {
    throw new ERR_INVALID_FD(fd);
  }
  const n: number = Number(fd);
  if (n < 0 || n > 2147483647) throw new ERR_INVALID_FD(fd);
  return n;
}

// Write `text` to the descriptor. Only 1 and 2 have a sink in this runtime
// (`process.stdout` / `process.stderr`, which reach the `zun:core` host); an
// arbitrary terminal descriptor cannot be opened, which is why
// `__ttyStreamOptions` refuses one before a stream over it is ever built.
function __ttyWriteToFd(fd: number, text: string): void {
  if (fd === 2) {
    process.stderr.write(text);
    return;
  }
  process.stdout.write(text);
}

// The `Duplex` options for a terminal stream over `fd`, and the whole of the
// `uv_tty_init` equivalent: the descriptor is validated, it has to *be* a
// terminal, and it has to be one of the three this runtime can reach. A
// failure is `ERR_TTY_INIT_FAILED`, which is what Node throws for a
// descriptor `uv_tty_init` rejects.
//
// This runs inside the `super(...)` argument of both classes below, because
// no statement may precede `super` and the sink closure has to travel in the
// options.
function __ttyStreamOptions(fd: any, writable: boolean): any {
  const descriptor: number = __ttyValidateFd(fd);
  if (!__ttyIsatty(descriptor) || descriptor > 2) {
    throw new ERR_TTY_INIT_FAILED(__ttyInitFailure());
  }
  if (!writable) {
    return { readableHighWaterMark: 0 };
  }
  return {
    readableHighWaterMark: 0,
    write(chunk: any, encoding: any, callback: any): void {
      const text: string = typeof chunk === "string"
        ? chunk
        : String(chunk.toString("utf8"));
      __ttyWriteToFd(descriptor, text);
      if (callback !== undefined && callback !== null) callback();
    },
  };
}

class WriteStream extends Duplex {
  fd: number;
  isTTY: boolean;
  columns: any;
  rows: any;
  constructor(fd: any) {
    super(__ttyStreamOptions(fd, true));
    this.fd = __ttyValidateFd(fd);
    this.isTTY = true;
    // See the header: there is no `getWindowSize` capability here, and Node
    // leaves these `undefined` as well when `uv_tty_get_winsize` fails.
    this.columns = undefined;
    this.rows = undefined;
  }

  getColorDepth(env?: any): number {
    return __ttyGetColorDepth(env);
  }

  hasColors(count?: any, env?: any): boolean {
    return __ttyHasColors(count, env);
  }

  getWindowSize(): any[] {
    return [this.columns, this.rows];
  }

  // Node re-reads the handle and emits `'resize'` when it changed. The size is
  // unobservable here, so it cannot change; emitting `'resize'` or an
  // `'error'` would both be inventions.
  _refreshSize(): void {}

  // `lib/tty.js`' four backwards-compatible methods, which are `readline`'s
  // own functions reached **through the module object** — not the top-level
  // ones — because that indirection is observable: Node's own
  // `test-tty-backwards-api.js` replaces `readline.cursorTo` and asserts that
  // the stream calls the replacement.
  cursorTo(x?: any, y?: any, callback?: any): any {
    return __node_readline.cursorTo(this, x, y, callback);
  }

  moveCursor(dx?: any, dy?: any, callback?: any): any {
    return __node_readline.moveCursor(this, dx, dy, callback);
  }

  clearLine(dir?: any, callback?: any): any {
    return __node_readline.clearLine(this, dir, callback);
  }

  clearScreenDown(callback?: any): any {
    return __node_readline.clearScreenDown(this, callback);
  }
}

class ReadStream extends Duplex {
  fd: number;
  isTTY: boolean;
  isRaw: boolean;
  constructor(fd: any) {
    super(__ttyStreamOptions(fd, false));
    this.fd = __ttyValidateFd(fd);
    this.isTTY = true;
    this.isRaw = false;
  }

  // See the header: `uv_tty_set_mode` has no counterpart here, so the flag is
  // recorded and the terminal is left alone — the same no-op
  // `process.stdin.setRawMode` already is.
  setRawMode(flag?: any): any {
    this.isRaw = flag === true;
    return this;
  }
}

// ===========================================================================
// The module object
// ===========================================================================

const __node_tty: any = {
  ReadStream: ReadStream,
  WriteStream: WriteStream,
  isatty(fd: any): boolean {
    return __ttyIsatty(fd);
  },
};

// `internal/tty`, the surface `lib/tty.js` itself imports the two colour
// functions from. A few of Node's tests reach for it under
// `--expose-internals`.
const __node_internal_tty: any = {
  getColorDepth(env?: any): number {
    return __ttyGetColorDepth(env);
  },
  hasColors(count?: any, env?: any): boolean {
    return __ttyHasColors(count, env);
  },
};

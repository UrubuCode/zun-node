// node:fs — the Node-shaped `fs` module, in Zun TypeScript over the native
// `node:fs` extension.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-fs-*.js` files (see ../../test/fs/).
// The API shaping follows Node's `lib/fs.js`, `lib/internal/fs/utils.js` and
// `lib/internal/fs/promises.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) — `stringToFlags`, `getOptions`, `getValidatedPath`,
// `toUnixTimestamp`, the `Stats`/`BigIntStats`/`Dirent` shapes, the
// `copyFile`/`cp` option handling and the `FileHandle` surface — because those
// are observable through the corpus rather than derivable.
//
// ---------------------------------------------------------------------------
// Why this module is split in two
// ---------------------------------------------------------------------------
//
// `fs` is a TS-over-natives module, the shape `node:os` established, and the
// line is PLAN.md principle 2:
//
//   * `src/fs/mod.rs` answers what needs the kernel. Nothing else.
//   * this file is everything that is shape rather than syscall — the option
//     objects, the flag strings, `Stats`/`Dirent`/`StatFs`/`Dir`,
//     `fs.constants`, the validation and the `ERR_*` errors, the recursive
//     `cp`, the callback API and `fs.promises`.
//
// Nothing structured can cross ABI v1, whose carrier is one scalar word. So the
// natives hand this file **status-prefixed, separator-delimited records** and
// this file parses them; the grammar is documented in `src/fs/mod.rs` and is
// the mirror image of `__fsRecords` below:
//
//     result  := "+" payload | "-"        payload := record (RS record)*
//     record  := field (US field)*        RS = U+001E     US = U+001F
//
// A leading "-" means the call failed, and six error slots then hold exactly
// what Node's filesystem errors report (`errno`, `code`, `syscall`, `message`,
// `path`, `dest`), which is why a failed `readFileSync` here raises an error
// whose `code`, `errno`, `syscall` and `path` match Node's rather than a
// generic host error. The natives never fail through the ABI's own status,
// because a thrown extension error escapes `try`/`catch` in this engine
// (https://github.com/UrubuCode/zun/issues/33) — and `fs` is the module whose
// whole error surface programs catch.
//
// ---------------------------------------------------------------------------
// Bytes: how a Buffer crosses the ABI
// ---------------------------------------------------------------------------
//
// The `Str` carrier is a NUL-terminated C string, so it cannot carry a file's
// bytes: a file with a NUL byte would be truncated, and arbitrary bytes are
// not UTF-8. Byte payloads therefore cross **base64**, and this file turns
// them into the engine's prelude `Buffer` (NUCLEUS #21) with
// `Buffer.from(text, "base64")`, and back with `buf.toString("base64")`. That
// is what makes `readFileSync(p)` with no encoding return a real `Buffer`
// rather than a lossy string.
//
// base64 over hex: 4/3 rather than 2x the byte count, and the engine's
// `Buffer` implements both codecs natively so neither side hand-rolls one.
// base64 over a latin1 passthrough: latin1 cannot carry NUL.
//
// ---------------------------------------------------------------------------
// Not implemented yet, and why
// ---------------------------------------------------------------------------
//
//   * `createReadStream` / `createWriteStream` / `ReadStream` / `WriteStream`
//     need `node:stream`, which is its own module in PLAN.md's order.
//   * `watch` / `watchFile` / `unwatchFile` need a filesystem-event source in
//     the VM's loop (libuv's `uv_fs_event_t`); there is no loop hook to attach
//     one to yet.
//   * `glob` / `globSync` need `node:path`'s matcher, which is not written.
//   * `openAsBlob` needs `node:buffer`'s `Blob`.
//
// Each throws `ERR_METHOD_NOT_IMPLEMENTED` rather than being absent, so a test
// that reaches one fails with a named gap instead of a `undefined is not a
// function`.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `Number(x.length)` throughout: the checker types `.length` as `u64`, so
//     it can be neither assigned to nor passed as a `number` (zun#3).
//   * the module's functions are **object-literal methods** delegating to
//     top-level `__fs*` functions, because a bare function value does not
//     survive every path through `any` (zun#17), while a method does.
//   * every callback is invoked through `__evCall` (../events/events.ts),
//     which unwraps the boxed function records `common.mustCall` hands out and
//     is the only spelling that reaches a callable with the right
//     `arguments.length` (zun#1).
//   * errors carry their `code` as a **declared field** on a subclass of
//     `NodeError`/`NodeTypeError`, never an expando write through `any`
//     (zun#37).

import * as __fsNative from "node:fs";

// ---------------------------------------------------------------------------
// The native carrier: separators, decoding, and the errors it raises
// ---------------------------------------------------------------------------

// Record and unit separators — C0 control characters, so no path, file name or
// encoded payload can contain one. See src/fs/mod.rs.
const __FS_RS: string = String.fromCharCode(30);
const __FS_US: string = String.fromCharCode(31);
const __FS_FAILED: string = "-";

// Node's filesystem errors are `uvException`s, not `SystemError`s: the message
// is `"<code>: <description>, <syscall> '<path>'"`, `name` stays `"Error"`, and
// `errno`/`code`/`syscall`/`path`/`dest` are own properties. `code` comes from
// `NodeError`, the rest are declared here for the same reason (zun#37).
class __FsUvError extends NodeError {
  errno: number = 0;
  syscall: string = "";
  path: any = undefined;
  dest: any = undefined;
  constructor(
    code: string,
    errno: number,
    syscall: string,
    description: string,
    path: any,
    dest: any,
  ) {
    super(code, __fsUvMessage(code, description, syscall, path, dest));
    this.errno = errno;
    this.syscall = syscall;
    if (path !== undefined) this.path = path;
    if (dest !== undefined) this.dest = dest;
  }
}

function __fsUvMessage(
  code: string,
  description: string,
  syscall: string,
  path: any,
  dest: any,
): string {
  let message: string = code + ": " + description + ", " + syscall;
  if (path !== undefined && path !== null) message = message + " '" + String(path) + "'";
  if (dest !== undefined && dest !== null) message = message + " -> '" + String(dest) + "'";
  return message;
}

// `ERR_FS_EISDIR` — the one filesystem error Node raises itself rather than
// forwarding from libuv (`rmSync` on a directory without `recursive`).
class ERR_FS_EISDIR extends NodeError {
  errno: number = 0;
  syscall: string = "";
  path: any = undefined;
  constructor(path: any) {
    super(
      "ERR_FS_EISDIR",
      "Path is a directory: rm returned EISDIR (is a directory) " + String(path),
    );
    this.path = path;
  }
}

class ERR_FS_INVALID_SYMLINK_TYPE extends NodeError {
  constructor(type: any) {
    super(
      "ERR_FS_INVALID_SYMLINK_TYPE",
      'Symlink type must be one of "dir", "file", or "junction". Received ' +
        inspect(type),
    );
  }
}

class ERR_FS_CP_EINVAL extends NodeError {
  path: any = undefined;
  constructor(message: string, path: any) {
    super("ERR_FS_CP_EINVAL", message);
    this.path = path;
  }
}

class ERR_FS_CP_EEXIST extends NodeError {
  path: any = undefined;
  constructor(message: string, path: any) {
    super("ERR_FS_CP_EEXIST", message);
    this.path = path;
  }
}

class ERR_FS_CP_DIR_TO_NON_DIR extends NodeError {
  constructor(message: string) {
    super("ERR_FS_CP_DIR_TO_NON_DIR", message);
  }
}

class ERR_FS_CP_NON_DIR_TO_DIR extends NodeError {
  constructor(message: string) {
    super("ERR_FS_CP_NON_DIR_TO_DIR", message);
  }
}

// `ERR_METHOD_NOT_IMPLEMENTED` used to be declared here. It lives with the
// error bases in `src/events/events.ts` now, because four files raise it and
// three of them are *conditional*: this one (`fs.glob`, `fs.watch`,
// `fs.createReadStream`, ...), `src/stream/stream.ts` (`_read`, `_write`,
// `_transform`) and `src/child_process/child_process.ts`, while
// `src/process/process.ts` (`process.chdir`, `process.kill`) is inlined into
// every bundle. `events.ts` is inlined into every bundle too, and ahead of
// all of them, so it is the one home that cannot collide: two top-level
// declarations of one name are a compile error in a single Zun program, and a
// test that requires both `fs` and `stream` is exactly such a program.

class ERR_INVALID_FILE_URL_SCHEME extends NodeTypeError {
  constructor() {
    super(
      "ERR_INVALID_FILE_URL_SCHEME",
      "The URL must be of scheme file",
    );
  }
}

// ---------------------------------------------------------------------------
// The two tables of entry points this file does not itself implement
// ---------------------------------------------------------------------------
//
// `fs.createReadStream`/`createWriteStream` live in `src/fs/streams.ts`, which
// stands on `node:stream`; `fs.watch`/`watchFile`/`unwatchFile` live in
// `src/fs/watchers.ts`. Both are appended only when a bundle actually gets
// them (tools/bundle_node_test.sh's CONDITIONAL_FILES), because this file is
// inlined for `../common/tmpdir` as well — 160 of the `fs` corpus' files reach
// it that way — and a `path` or `events` bundle must not grow a stream module
// it never uses.
//
// Until a file overwrites its slots, each one throws
// `ERR_METHOD_NOT_IMPLEMENTED` with the name Node gives it, so a test that
// reaches an absent half fails with a named gap rather than
// "undefined is not a function".
const __fsStreamHooks: any = {
  createReadStream(path: any, options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.createReadStream");
  },
  createWriteStream(path: any, options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.createWriteStream");
  },
  handleReadStream(handle: any, options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("filehandle.createReadStream");
  },
  handleWriteStream(handle: any, options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("filehandle.createWriteStream");
  },
};

const __fsWatchHooks: any = {
  watch(path: any, options?: any, listener?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.watch");
  },
  watchFile(path: any, options?: any, listener?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.watchFile");
  },
  unwatchFile(path: any, listener?: any): void {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.unwatchFile");
  },
  promisesWatch(path: any, options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fsPromises.watch");
  },
};

// Raise the failure the last native call left in the error slots. Every
// fallible native funnels through here, so the shape of an `fs` error is
// defined in exactly one place.
function __fsFail(): void {
  throw new __FsUvError(
    __fsNative.lastErrorCode(),
    Number(__fsNative.lastErrorErrno()),
    __fsNative.lastErrorSyscall(),
    __fsNative.lastErrorMessage(),
    __fsPathOrUndefined(__fsNative.lastErrorPath()),
    __fsPathOrUndefined(__fsNative.lastErrorDest()),
  );
}

// An empty slot means "this error has no such path", which is how the native
// reports absence over a carrier with no null.
function __fsPathOrUndefined(value: string): any {
  return value === "" ? undefined : value;
}

// The error the last native call left, as a value, for the paths that have to
// inspect the code before deciding (`statSync({ throwIfNoEntry: false })`,
// `rm({ force: true })`).
function __fsLastCode(): string {
  return __fsNative.lastErrorCode();
}

// A status-prefixed result as records of fields. An empty payload is an empty
// list, not a failure — that is the whole point of the prefix.
function __fsRecords(raw: string): string[][] {
  if (raw === __FS_FAILED) __fsFail();
  const payload: string = raw.slice(1);
  const out: string[][] = [];
  if (payload === "") return out;
  const records: string[] = payload.split(__FS_RS);
  const count = Number(records.length);
  for (let i = 0; i < count; i++) out.push(records[i].split(__FS_US));
  return out;
}

// A status-prefixed result known to carry exactly one record.
function __fsFields(raw: string): string[] {
  if (raw === __FS_FAILED) __fsFail();
  return raw.slice(1).split(__FS_US);
}

// A status-prefixed result known to carry exactly one field, returned byte for
// byte (never split, so a path containing a separator survives).
function __fsOne(raw: string): string {
  if (raw === __FS_FAILED) __fsFail();
  return raw.slice(1);
}

// A status-prefixed result with nothing to report but success.
function __fsVoid(raw: string): void {
  if (raw === __FS_FAILED) __fsFail();
}

// ---------------------------------------------------------------------------
// fs.constants
//
// The platform's own numbers, read from the extension rather than hard-coded
// here: the `flags` a program passes to `open` are these very values, and the
// extension is what has to decode them, so one table crosses once (see
// src/fs/consts.rs). The object has a **null prototype**, which Node's own
// test-fs-constants.js asserts.
// ---------------------------------------------------------------------------

function __fsBuildConstants(): any {
  const table: any = Object.create(null);
  const records: string[][] = __fsRecords(__fsNative.fsConstants());
  const count = Number(records.length);
  for (let i = 0; i < count; i++) {
    table[records[i][0]] = Number(records[i][1]);
  }
  return table;
}

const __fsConstants: any = __fsBuildConstants();

function __fsConst(name: string): number {
  const value: any = __fsConstants[name];
  return value === undefined ? 0 : Number(value);
}

const __FS_O_RDONLY: number = __fsConst("O_RDONLY");
const __FS_O_WRONLY: number = __fsConst("O_WRONLY");
const __FS_O_RDWR: number = __fsConst("O_RDWR");
const __FS_O_CREAT: number = __fsConst("O_CREAT");
const __FS_O_EXCL: number = __fsConst("O_EXCL");
const __FS_O_TRUNC: number = __fsConst("O_TRUNC");
const __FS_O_APPEND: number = __fsConst("O_APPEND");
const __FS_O_SYNC: number = __fsConst("O_SYNC");
const __FS_F_OK: number = __fsConst("F_OK");
const __FS_S_IFMT: number = __fsConst("S_IFMT");
const __FS_S_IFREG: number = __fsConst("S_IFREG");
const __FS_S_IFDIR: number = __fsConst("S_IFDIR");
const __FS_S_IFCHR: number = __fsConst("S_IFCHR");
const __FS_S_IFBLK: number = __fsConst("S_IFBLK");
const __FS_S_IFIFO: number = __fsConst("S_IFIFO");
const __FS_S_IFLNK: number = __fsConst("S_IFLNK");
const __FS_S_IFSOCK: number = __fsConst("S_IFSOCK");
const __FS_UV_FS_SYMLINK_DIR: number = __fsConst("UV_FS_SYMLINK_DIR");
const __FS_UV_FS_SYMLINK_JUNCTION: number = __fsConst("UV_FS_SYMLINK_JUNCTION");

const __FS_IS_WINDOWS: boolean = process.platform === "win32";

// ---------------------------------------------------------------------------
// Validation (Node's internal/validators + internal/fs/utils)
// ---------------------------------------------------------------------------

const __FS_INT32_MAX: number = 2147483647;
const __FS_UINT32_MAX: number = 4294967295;
// Node's `kMaxUserId`.
const __FS_MAX_UID: number = 4294967295;

function __fsIsDate(value: any): boolean {
  if (value === null || value === undefined || typeof value !== "object") return false;
  return value instanceof Date;
}

function __fsValidateFunction(value: any, name: string): void {
  if (!__evIsFn(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
  }
}

function __fsValidateObject(value: any, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
  }
}

function __fsValidateInteger(value: any, name: string, min: number, max: number): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(min) + " && <= " + String(max),
      value,
    );
  }
}

// `validateInt32`, which is what `fd` and `mode` go through.
function __fsValidateInt32(value: any, name: string, min: number, max: number): void {
  __fsValidateInteger(value, name, min, max);
}

function __fsValidateBoolean(value: any, name: string): void {
  if (typeof value !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
  }
}

// `getValidatedFd` — Node's own range is `[0, 2^31 - 1]`.
function __fsGetValidatedFd(fd: any, name?: string): number {
  const label: string = name === undefined ? "fd" : name;
  __fsValidateInt32(fd, label, 0, __FS_INT32_MAX);
  return Number(fd);
}

// A `file:` URL as a path, which is the third thing every `fs` path accepts.
function __fsUrlToPath(url: any): string {
  const protocol: any = url.protocol;
  if (protocol !== "file:") throw new ERR_INVALID_FILE_URL_SCHEME();
  let pathname: string = String(url.pathname);
  // Percent-decoding, which `pathToFileURL` applied on the way in.
  pathname = decodeURIComponent(pathname);
  if (__FS_IS_WINDOWS) {
    // `/C:/x` -> `C:\x`; a UNC host becomes `\\host\share`.
    const host: any = url.hostname;
    if (host !== undefined && host !== null && String(host) !== "") {
      return "\\\\" + String(host) + pathname.split("/").join("\\");
    }
    let windows: string = pathname.slice(1).split("/").join("\\");
    return windows;
  }
  return pathname;
}

function __fsIsUrl(value: any): boolean {
  if (value === null || value === undefined || typeof value !== "object") return false;
  return value.protocol !== undefined && value.pathname !== undefined;
}

// `getValidatedPath` — a string, a `Uint8Array`/`Buffer` or a `file:` URL, and
// never one containing a NUL byte (which would end the path early in every
// syscall this reaches).
function __fsGetValidatedPath(value: any, name?: string): string {
  const label: string = name === undefined ? "path" : name;
  let text: any = value;
  if (__fsIsUrl(value)) {
    text = __fsUrlToPath(value);
  } else if (Buffer.isBuffer(value)) {
    text = value.toString("utf8");
  } else if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(label, ["string", "Buffer", "URL"], value);
  }
  const path: string = String(text);
  if (Number(path.indexOf("\u0000")) !== -1) {
    throw new ERR_INVALID_ARG_VALUE(
      label,
      value,
      "must be a string, Uint8Array, or URL without null bytes",
    );
  }
  return path;
}

const __FS_ENCODINGS: string[] = [
  "ascii", "utf8", "utf-8", "utf16le", "utf-16le", "ucs2", "ucs-2",
  "base64", "base64url", "latin1", "binary", "hex", "buffer",
];

function __fsIsEncoding(value: any): boolean {
  if (typeof value !== "string") return false;
  const lowered: string = value.toLowerCase();
  for (const known of __FS_ENCODINGS) {
    if (known === lowered) return true;
  }
  return false;
}

function __fsAssertEncoding(encoding: any): void {
  if (encoding === undefined || encoding === null) return;
  if (!__fsIsEncoding(encoding)) {
    // Node's reason is the two words "is invalid encoding", not "is invalid":
    // `test-fs-internal-assertencoding.js` exists only to pin that message
    // (the arguments used to be the other way round in Node itself).
    throw new ERR_INVALID_ARG_VALUE("encoding", encoding, "is invalid encoding");
  }
}

// `getOptions(options, defaults)` — a string is an encoding, an object is
// merged over the defaults, and anything else is a type error.
function __fsGetOptions(options: any, defaults: any): any {
  if (options === undefined || options === null || __evIsFn(options)) {
    return defaults;
  }
  if (typeof options === "string") {
    const merged: any = { ...defaults };
    merged.encoding = options;
    __fsAssertEncoding(options);
    return merged;
  }
  if (typeof options !== "object") {
    throw new ERR_INVALID_ARG_TYPE("options", ["string", "Object"], options);
  }
  const merged: any = { ...defaults, ...options };
  if (merged.encoding !== undefined && merged.encoding !== null) {
    __fsAssertEncoding(merged.encoding);
  }
  return merged;
}

// `parseFileMode` — a number or an octal-ish string, in `[0, 2^32 - 1]`.
function __fsParseFileMode(value: any, name: string, fallback?: any): number {
  const given: any = value === undefined || value === null ? fallback : value;
  // A separate binding for the parsed form: assigning the `parseInt` result
  // back into `given` is rejected, because the `typeof` test has already
  // narrowed it to a string.
  let mode: any = given;
  if (typeof given === "string") {
    if (!__regexTest(/^[0-7]+$/, given)) {
      throw new ERR_INVALID_ARG_VALUE(
        name,
        value,
        "must be a 32-bit unsigned integer or an octal string",
      );
    }
    mode = parseInt(given, 8);
  }
  __fsValidateInteger(mode, name, 0, __FS_UINT32_MAX);
  return Number(mode);
}

// `stringToFlags` — Node's own table, built from the platform's `O_*`.
function __fsStringToFlags(value: any, name?: string): number {
  const label: string = name === undefined ? "flags" : name;
  if (typeof value === "number") {
    __fsValidateInt32(value, label, -2147483648, __FS_INT32_MAX);
    return Number(value);
  }
  if (value === undefined || value === null) return __FS_O_RDONLY;
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(label, ["string", "number"], value);
  }
  switch (value) {
    case "r": return __FS_O_RDONLY;
    case "rs":
    case "sr": return __FS_O_RDONLY | __FS_O_SYNC;
    case "r+": return __FS_O_RDWR;
    case "rs+":
    case "sr+": return __FS_O_RDWR | __FS_O_SYNC;
    case "w": return __FS_O_TRUNC | __FS_O_CREAT | __FS_O_WRONLY;
    case "wx":
    case "xw": return __FS_O_TRUNC | __FS_O_CREAT | __FS_O_WRONLY | __FS_O_EXCL;
    case "w+": return __FS_O_TRUNC | __FS_O_CREAT | __FS_O_RDWR;
    case "wx+":
    case "xw+": return __FS_O_TRUNC | __FS_O_CREAT | __FS_O_RDWR | __FS_O_EXCL;
    case "a": return __FS_O_APPEND | __FS_O_CREAT | __FS_O_WRONLY;
    case "ax":
    case "xa": return __FS_O_APPEND | __FS_O_CREAT | __FS_O_WRONLY | __FS_O_EXCL;
    case "as":
    case "sa": return __FS_O_APPEND | __FS_O_CREAT | __FS_O_WRONLY | __FS_O_SYNC;
    case "a+": return __FS_O_APPEND | __FS_O_CREAT | __FS_O_RDWR;
    case "ax+":
    case "xa+": return __FS_O_APPEND | __FS_O_CREAT | __FS_O_RDWR | __FS_O_EXCL;
    case "as+":
    case "sa+": return __FS_O_APPEND | __FS_O_CREAT | __FS_O_RDWR | __FS_O_SYNC;
    default: break;
  }
  throw new ERR_INVALID_ARG_VALUE(label, value, "is invalid");
}

// `toUnixTimestamp` — `utimes`' time argument: a numeric string, a finite
// number (a negative one meaning "now"), or a `Date`.
// The parameter is deliberately not called `time`: `time` is a `zun:core`
// namespace, and a member read through a parameter of that name resolves to the
// namespace instead of the value (`time.getTime` is then "no member").
function __fsToUnixTimestamp(when: any, name?: string): number {
  const label: string = name === undefined ? "time" : name;
  if (typeof when === "string" && when !== "" && Number(when) === Number(when)) {
    return Number(when);
  }
  if (typeof when === "number" && Number.isFinite(when)) {
    if (when < 0) return Date.now() / 1000;
    return when;
  }
  if (__fsIsDate(when)) return Number(when.getTime()) / 1000;
  throw new ERR_INVALID_ARG_TYPE(label, ["Date", "Time in seconds"], when);
}

// ---------------------------------------------------------------------------
// Stats, BigIntStats, StatFs, Dirent, Dir
// ---------------------------------------------------------------------------

// `(mode & S_IFMT) === want`, over a `mode` that is a number on `Stats` and a
// BigInt on `BigIntStats`. `Number()` is exact for every mode (it is at most
// 17 bits), so one predicate serves both.
function __fsCheckMode(mode: any, want: number): boolean {
  if (mode === undefined || mode === null) return false;
  return (Number(mode) & __FS_S_IFMT) === want;
}

class Stats {
  dev: any = 0;
  mode: any = 0;
  nlink: any = 0;
  uid: any = 0;
  gid: any = 0;
  rdev: any = 0;
  blksize: any = 0;
  ino: any = 0;
  size: any = 0;
  blocks: any = 0;
  atimeMs: any = 0;
  mtimeMs: any = 0;
  ctimeMs: any = 0;
  birthtimeMs: any = 0;
  atime: any = undefined;
  mtime: any = undefined;
  ctime: any = undefined;
  birthtime: any = undefined;

  // Node's `Stats` is a function-constructor taking the fourteen fields
  // positionally, and two of its own tests build the object they expect that
  // way: `test-fs-watchfile.js` and `test-fs-watchfile-bigint.js` compare a
  // hand-built all-zero `Stats` with what a `watchFile` on a missing path
  // reports. Every parameter is optional because this module's own
  // `__fsStatsFromFields` constructs an empty one and fills it in field by
  // field; `dev` standing in for "was anything passed at all" is what keeps
  // that path from overwriting itself with `undefined`.
  //
  // The four `Date`s are own fields here rather than Node's memoising lazy
  // accessors, so they are computed with the rest. Node rounds the
  // millisecond value before handing it to `Date` (nodejs/node#43714).
  constructor(
    dev?: any,
    mode?: any,
    nlink?: any,
    uid?: any,
    gid?: any,
    rdev?: any,
    blksize?: any,
    ino?: any,
    size?: any,
    blocks?: any,
    atimeMs?: any,
    mtimeMs?: any,
    ctimeMs?: any,
    birthtimeMs?: any,
  ) {
    if (dev === undefined) return;
    this.dev = dev;
    this.mode = mode;
    this.nlink = nlink;
    this.uid = uid;
    this.gid = gid;
    this.rdev = rdev;
    this.blksize = blksize;
    this.ino = ino;
    this.size = size;
    this.blocks = blocks;
    this.atimeMs = atimeMs;
    this.mtimeMs = mtimeMs;
    this.ctimeMs = ctimeMs;
    this.birthtimeMs = birthtimeMs;
    this.atime = new Date(Math.round(Number(atimeMs)));
    this.mtime = new Date(Math.round(Number(mtimeMs)));
    this.ctime = new Date(Math.round(Number(ctimeMs)));
    this.birthtime = new Date(Math.round(Number(birthtimeMs)));
  }

  isDirectory(): boolean {
    return __fsCheckMode(this.mode, __FS_S_IFDIR);
  }
  isFile(): boolean {
    return __fsCheckMode(this.mode, __FS_S_IFREG);
  }
  isBlockDevice(): boolean {
    return __fsCheckMode(this.mode, __FS_S_IFBLK);
  }
  isCharacterDevice(): boolean {
    return __fsCheckMode(this.mode, __FS_S_IFCHR);
  }
  isSymbolicLink(): boolean {
    return __fsCheckMode(this.mode, __FS_S_IFLNK);
  }
  isFIFO(): boolean {
    return __fsCheckMode(this.mode, __FS_S_IFIFO);
  }
  isSocket(): boolean {
    return __fsCheckMode(this.mode, __FS_S_IFSOCK);
  }
}

// `BigIntStats` reports every number as a BigInt and adds the exact
// nanosecond fields, which is the only reason the natives hand over
// `(seconds, nanoseconds)` pairs instead of milliseconds (see src/fs/meta.rs).
class BigIntStats extends Stats {
  atimeNs: any = 0;
  mtimeNs: any = 0;
  ctimeNs: any = 0;
  birthtimeNs: any = 0;

  // Node's signature takes the *nanosecond* fields in the last four slots and
  // derives the millisecond ones from them, which is why a hand-built
  // `BigIntStats` in a test is written with `0n` throughout.
  constructor(
    dev?: any,
    mode?: any,
    nlink?: any,
    uid?: any,
    gid?: any,
    rdev?: any,
    blksize?: any,
    ino?: any,
    size?: any,
    blocks?: any,
    atimeNs?: any,
    mtimeNs?: any,
    ctimeNs?: any,
    birthtimeNs?: any,
  ) {
    super(
      dev,
      mode,
      nlink,
      uid,
      gid,
      rdev,
      blksize,
      ino,
      size,
      blocks,
      __fsNsToMs(atimeNs),
      __fsNsToMs(mtimeNs),
      __fsNsToMs(ctimeNs),
      __fsNsToMs(birthtimeNs),
    );
    if (dev === undefined) return;
    this.atimeNs = atimeNs;
    this.mtimeNs = mtimeNs;
    this.ctimeNs = ctimeNs;
    this.birthtimeNs = birthtimeNs;
  }
}

// `atimeNs / kNsPerMsBigInt` — Node's is exact BigInt division.
//
// BigInt `/` cannot be used here: it **panics the interpreter** when the
// operands are `bigint`-narrowed out of an `any` ("expected float, found
// Object", crates/zun_interp/src/value.rs:157) and raises an unhandled
// exception when they are plain `any`s holding BigInts —
//
//     const a: any = BigInt(5000000); const b: any = BigInt(1000000);
//     String(a / b);   // zun: runtime error: unhandled exception
//
// — so the division goes through a float, exactly as `__fsStatsFromFields`
// already does for the same four fields. A nanosecond count is ~1.8e18, which
// a double cannot hold exactly, but the *quotient* (~1.8e12 ms) is well inside
// 2^53, so the result is off by under a millisecond rather than rounded.
function __fsNsToMs(nanoseconds: any): any {
  if (nanoseconds === undefined || nanoseconds === null) return nanoseconds;
  if (typeof nanoseconds === "bigint") {
    return BigInt(Math.trunc(Number(String(nanoseconds)) / __FS_STAT_NS_PER_MS));
  }
  return Math.trunc(Number(nanoseconds) / __FS_STAT_NS_PER_MS);
}

const __FS_STAT_NS_PER_MS: number = 1000000;

// `Date` from the `(seconds, nanoseconds)` pair, through milliseconds.
function __fsMillisOf(seconds: number, nanoseconds: number): number {
  return seconds * 1000 + nanoseconds / __FS_STAT_NS_PER_MS;
}

// The 18 fields `fsStat`/`fsFstat` hand over, as a `Stats` or a `BigIntStats`.
function __fsStatsFromFields(fields: string[], bigint: boolean): any {
  const atimeMs: number = __fsMillisOf(Number(fields[10]), Number(fields[11]));
  const mtimeMs: number = __fsMillisOf(Number(fields[12]), Number(fields[13]));
  const ctimeMs: number = __fsMillisOf(Number(fields[14]), Number(fields[15]));
  const birthtimeMs: number = __fsMillisOf(Number(fields[16]), Number(fields[17]));

  if (bigint) {
    const stats: any = new BigIntStats();
    stats.dev = BigInt(String(fields[0]));
    stats.mode = BigInt(String(fields[1]));
    stats.nlink = BigInt(String(fields[2]));
    stats.uid = BigInt(String(fields[3]));
    stats.gid = BigInt(String(fields[4]));
    stats.rdev = BigInt(String(fields[5]));
    stats.blksize = BigInt(String(fields[6]));
    stats.ino = BigInt(String(fields[7]));
    stats.size = BigInt(String(fields[8]));
    stats.blocks = BigInt(String(fields[9]));
    stats.atimeMs = BigInt(Math.trunc(atimeMs));
    stats.mtimeMs = BigInt(Math.trunc(mtimeMs));
    stats.ctimeMs = BigInt(Math.trunc(ctimeMs));
    stats.birthtimeMs = BigInt(Math.trunc(birthtimeMs));
    stats.atimeNs = __fsNanosOf(fields[10], fields[11]);
    stats.mtimeNs = __fsNanosOf(fields[12], fields[13]);
    stats.ctimeNs = __fsNanosOf(fields[14], fields[15]);
    stats.birthtimeNs = __fsNanosOf(fields[16], fields[17]);
    stats.atime = new Date(atimeMs);
    stats.mtime = new Date(mtimeMs);
    stats.ctime = new Date(ctimeMs);
    stats.birthtime = new Date(birthtimeMs);
    return stats;
  }

  const stats: any = new Stats();
  stats.dev = Number(fields[0]);
  stats.mode = Number(fields[1]);
  stats.nlink = Number(fields[2]);
  stats.uid = Number(fields[3]);
  stats.gid = Number(fields[4]);
  stats.rdev = Number(fields[5]);
  stats.blksize = Number(fields[6]);
  stats.ino = Number(fields[7]);
  stats.size = Number(fields[8]);
  stats.blocks = Number(fields[9]);
  stats.atimeMs = atimeMs;
  stats.mtimeMs = mtimeMs;
  stats.ctimeMs = ctimeMs;
  stats.birthtimeMs = birthtimeMs;
  stats.atime = new Date(atimeMs);
  stats.mtime = new Date(mtimeMs);
  stats.ctime = new Date(ctimeMs);
  stats.birthtime = new Date(birthtimeMs);
  return stats;
}

// `seconds * 1e9 + nanoseconds`, in BigInt so no precision is lost — which is
// the whole point of `BigIntStats`.
function __fsNanosOf(seconds: any, nanoseconds: any): any {
  return (
    BigInt(String(seconds)) * BigInt(1000000000) + BigInt(String(nanoseconds))
  );
}

class StatsFs {
  type: any = 0;
  bsize: any = 0;
  blocks: any = 0;
  bfree: any = 0;
  bavail: any = 0;
  files: any = 0;
  ffree: any = 0;
}

function __fsStatFsFromFields(fields: string[], bigint: boolean): any {
  const stats: any = new StatsFs();
  if (bigint) {
    stats.type = BigInt(String(fields[0]));
    stats.bsize = BigInt(String(fields[1]));
    stats.blocks = BigInt(String(fields[2]));
    stats.bfree = BigInt(String(fields[3]));
    stats.bavail = BigInt(String(fields[4]));
    stats.files = BigInt(String(fields[5]));
    stats.ffree = BigInt(String(fields[6]));
    return stats;
  }
  stats.type = Number(fields[0]);
  stats.bsize = Number(fields[1]);
  stats.blocks = Number(fields[2]);
  stats.bfree = Number(fields[3]);
  stats.bavail = Number(fields[4]);
  stats.files = Number(fields[5]);
  stats.ffree = Number(fields[6]);
  return stats;
}

// The `UV_DIRENT_*` tags `fsReaddir` reports per entry.
const __FS_DIRENT_UNKNOWN: number = 0;
const __FS_DIRENT_FILE: number = 1;
const __FS_DIRENT_DIR: number = 2;
const __FS_DIRENT_LINK: number = 3;
const __FS_DIRENT_FIFO: number = 4;
const __FS_DIRENT_SOCKET: number = 5;
const __FS_DIRENT_CHAR: number = 6;
const __FS_DIRENT_BLOCK: number = 7;

class Dirent {
  name: any = "";
  parentPath: any = "";
  type: number = 0;
  constructor(name: any, type: number, parentPath: any) {
    this.name = name;
    this.type = type;
    this.parentPath = parentPath;
  }
  // Node 25 renamed `Dirent.path` to `parentPath` and kept the old name as a
  // deprecated alias, which several tests still read.
  get path(): any {
    return this.parentPath;
  }
  isFile(): boolean {
    return this.type === __FS_DIRENT_FILE;
  }
  isDirectory(): boolean {
    return this.type === __FS_DIRENT_DIR;
  }
  isSymbolicLink(): boolean {
    return this.type === __FS_DIRENT_LINK;
  }
  isFIFO(): boolean {
    return this.type === __FS_DIRENT_FIFO;
  }
  isSocket(): boolean {
    return this.type === __FS_DIRENT_SOCKET;
  }
  isCharacterDevice(): boolean {
    return this.type === __FS_DIRENT_CHAR;
  }
  isBlockDevice(): boolean {
    return this.type === __FS_DIRENT_BLOCK;
  }
}

// `fs.Dir` — an open directory handle. Node's is a streaming `uv_fs_opendir`
// cursor; this one reads the whole listing at `opendir` time and serves it,
// which is observably the same for everything except a directory changing
// mid-iteration.
class Dir {
  path: any = "";
  entries: any[] = [];
  index: number = 0;
  closed: boolean = false;
  // Both parameters are optional so that `new fs.Dir()` compiles: Node's own
  // test-fs-read.js asserts that the no-argument form throws
  // `ERR_MISSING_ARGS` at **run time**, and a required parameter makes it a
  // compile error in this engine instead.
  constructor(path?: any, entries?: any[]) {
    if (path === undefined) throw new ERR_MISSING_ARGS("handle");
    this.path = path;
    this.entries = entries === undefined ? [] : entries;
  }
  readSync(): any {
    if (this.index >= Number(this.entries.length)) return null;
    const entry: any = this.entries[this.index];
    this.index = this.index + 1;
    return entry;
  }
  closeSync(): void {
    this.closed = true;
  }
  read(callback?: any): any {
    const entry: any = this.readSync();
    if (callback === undefined || callback === null) {
      return Promise.resolve(entry);
    }
    __fsDeliver(callback, [null, entry]);
    return undefined;
  }
  close(callback?: any): any {
    this.closeSync();
    if (callback === undefined || callback === null) {
      return Promise.resolve(undefined);
    }
    __fsDeliver(callback, [null]);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Bytes in and out
//
// Every `Buffer` in this file lives in a **statically typed** `Buffer` binding,
// parameter or return, and an `any` holding one is put back through
// `__fsAsBuffer` before anything is read off it. That is not style: a typed
// array - `Buffer` included - is *opaque* through `any` in this engine
// (https://github.com/UrubuCode/zun/issues/38), with no `length`, no indexing
// and no methods, so `buf.toString("utf8")` on an `any` throws
// "toString is not a function" and `buf.length` reads `undefined`. The value is
// intact; only the member read through `any` is lost, so re-typing it restores
// the whole surface.
//
// The same bug is why a `Buffer` this module *returns* is of limited use to a
// caller written in plain JavaScript, where every binding is `any`:
// `fs.readFileSync(p).equals(...)` cannot work until zun#38 is fixed. Reads
// with an `encoding` return strings and are unaffected, which is why they are
// the surface most of the corpus exercises today. See ../../test/fs/README.md.
// ---------------------------------------------------------------------------

// Re-type an `any` known to hold a byte view. See the note above (zun#38).
function __fsAsBuffer(value: any): Buffer {
  return value;
}

// A base64 payload as a `Buffer` (the engine's prelude Buffer, NUCLEUS #21).
function __fsBufferOf(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

// Is this a byte view this module can read? `Buffer.isBuffer` answers `true`
// for every `Uint8Array`-family view (they share one runtime type), and
// `false` for a string, a number, `null` and a plain object - so it is both the
// test and the only one available, since a view's own `byteLength` is
// unreadable through `any`.
function __fsIsUint8Array(value: any): boolean {
  if (value === null || value === undefined) return false;
  return Buffer.isBuffer(value);
}

// The data argument of a write as base64, accepting everything Node accepts: a
// string (in the given encoding), a `Buffer`, or any typed array / DataView.
function __fsDataToBase64(data: any, encoding: any): string {
  if (typeof data === "string") {
    const name: any = encoding === undefined || encoding === null ? "utf8" : encoding;
    const encoded: Buffer = Buffer.from(data, String(name));
    return encoded.toString("base64");
  }
  if (__fsIsUint8Array(data)) {
    // A non-byte view (an `Int32Array`, a `DataView`) would need its element
    // width honored; every view the corpus writes is a byte view, and
    // re-typing one of those is exact.
    const bytes: Buffer = __fsAsBuffer(data);
    return bytes.toString("base64");
  }
  throw new ERR_INVALID_ARG_TYPE(
    "data",
    ["string", "Buffer", "TypedArray", "DataView"],
    data,
  );
}

// The result of a read, decoded for the requested encoding: the `Buffer` itself
// when there is none (or it is `"buffer"`), a string otherwise.
function __fsDecode(buffer: Buffer, encoding: any): any {
  if (encoding === undefined || encoding === null || encoding === "buffer") return buffer;
  return buffer.toString(String(encoding));
}

// A file name for `readdir`, which answers `Buffer`s under
// `{ encoding: "buffer" }` and strings otherwise.
function __fsName(name: string, encoding: any): any {
  if (encoding === "buffer") return Buffer.from(name, "utf8");
  if (encoding === undefined || encoding === null || encoding === "utf8" || encoding === "utf-8") {
    return name;
  }
  const bytes: Buffer = Buffer.from(name, "utf8");
  return bytes.toString(String(encoding));
}

// `[offset, offset + length)` of a byte view, as a `Buffer`.
function __fsSliceOfView(value: any, offset: number, length: number): Buffer {
  const bytes: Buffer = __fsAsBuffer(value);
  const total = Number(bytes.length);
  const start = offset < 0 ? 0 : offset;
  let end = start + length;
  if (end > total) end = total;
  return bytes.slice(start, end);
}

// ---------------------------------------------------------------------------
// The synchronous surface
// ---------------------------------------------------------------------------

function __fsExistsSync(path: any): boolean {
  // Node's `existsSync` swallows *every* error, a bad argument type included.
  try {
    const resolved: string = __fsGetValidatedPath(path);
    return __fsNative.fsExists(resolved);
  } catch (error) {
    return false;
  }
}

function __fsAccessSync(path: any, mode?: any): void {
  const resolved: string = __fsGetValidatedPath(path);
  const resolvedMode: number = mode === undefined ? __FS_F_OK : Number(mode);
  __fsValidateInteger(resolvedMode, "mode", 0, 7);
  __fsVoid(__fsNative.fsAccess(resolved, resolvedMode));
}

function __fsReadFileSync(path: any, options?: any): any {
  const resolved: any = __fsGetOptions(options, { encoding: null, flag: "r" });
  const encoding: any = resolved.encoding;

  // `readFileSync` also takes an already-open descriptor.
  if (typeof path === "number") {
    const fd: number = __fsGetValidatedFd(path);
    return __fsDecode(__fsReadAllFromFd(fd), encoding);
  }
  const target: string = __fsGetValidatedPath(path);
  // The flag is validated even though a plain read ignores everything but the
  // access mode, because Node validates it.
  __fsStringToFlags(resolved.flag, "flag");
  const buffer: Buffer = __fsBufferOf(__fsOne(__fsNative.fsReadFile(target)));
  return __fsDecode(buffer, encoding);
}

// Everything left in `fd` from its current offset, which is what
// `readFileSync(fd)` reads.
function __fsReadAllFromFd(fd: number): Buffer {
  const chunks: Buffer[] = [];
  for (;;) {
    const piece: Buffer = __fsBufferOf(__fsOne(__fsNative.fsRead(fd, 65536, -1)));
    if (Number(piece.length) === 0) break;
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function __fsWriteFileSync(file: any, data: any, options?: any): void {
  const resolved: any = __fsGetOptions(options, {
    encoding: "utf8",
    mode: 0o666,
    flag: "w",
    flush: false,
  });
  // `flush` is a boolean or nothing, and the check precedes every other piece
  // of work: `test-fs-write-file-flush.js` and `test-fs-append-file-flush.js`
  // pass a string, a number, an array, an object and a symbol and want
  // `ERR_INVALID_ARG_TYPE` from each.
  const flush: any = resolved.flush;
  if (flush !== undefined && flush !== null) {
    __fsValidateBoolean(flush, "options.flush");
  }
  const base64: string = __fsDataToBase64(data, resolved.encoding);
  const mode: number = __fsParseFileMode(resolved.mode, "mode", 0o666);

  if (typeof file === "number") {
    const fd: number = __fsGetValidatedFd(file);
    __fsOne(__fsNative.fsWrite(fd, base64, -1));
    // A descriptor the caller owns is flushed but never closed.
    if (flush === true) __fsFsyncSync(fd);
    return;
  }
  const target: string = __fsGetValidatedPath(file);
  const flags: number = __fsStringToFlags(resolved.flag, "flag");
  if (flush === true) {
    // Node opens, writes, `fsync`s and closes; the native does the first two
    // in one call, so the flush needs its own descriptor over the same path.
    __fsVoid(__fsNative.fsWriteFile(target, base64, flags, mode));
    const handle: number = __fsOpenSync(target, "r+", mode);
    try {
      __fsFsyncSync(handle);
    } finally {
      __fsCloseSync(handle);
    }
    return;
  }
  __fsVoid(__fsNative.fsWriteFile(target, base64, flags, mode));
}

function __fsAppendFileSync(file: any, data: any, options?: any): void {
  const resolved: any = __fsGetOptions(options, {
    encoding: "utf8",
    mode: 0o666,
    flag: "a",
    flush: false,
  });
  if (resolved.flag === undefined || resolved.flag === null) resolved.flag = "a";
  __fsWriteFileSync(file, data, resolved);
}

function __fsTruncateSync(path: any, len?: any): void {
  if (typeof path === "number") {
    __fsFtruncateSync(path, len);
    return;
  }
  const resolved: string = __fsGetValidatedPath(path);
  const length: number = len === undefined || len === null ? 0 : Number(len);
  __fsValidateInteger(length, "len", -9007199254740991, 9007199254740991);
  __fsVoid(__fsNative.fsTruncate(resolved, length));
}

function __fsFtruncateSync(fd: any, len?: any): void {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  const length: number = len === undefined || len === null ? 0 : Number(len);
  __fsValidateInteger(length, "len", -9007199254740991, 9007199254740991);
  __fsVoid(__fsNative.fsFtruncate(resolvedFd, length));
}

function __fsOpenSync(path: any, flags?: any, mode?: any): number {
  const resolved: string = __fsGetValidatedPath(path);
  const resolvedFlags: number = __fsStringToFlags(flags === undefined ? "r" : flags);
  const resolvedMode: number = __fsParseFileMode(mode, "mode", 0o666);
  return Number(__fsOne(__fsNative.fsOpen(resolved, resolvedFlags, resolvedMode)));
}

function __fsCloseSync(fd: any): void {
  const resolved: number = __fsGetValidatedFd(fd);
  __fsVoid(__fsNative.fsClose(resolved));
}

// `readSync(fd, buffer, offset, length, position)` and the
// `readSync(fd, buffer, { offset, length, position })` shorthand. The bytes are
// copied into the caller's buffer, which is Node's contract, and the return is
// the count.
function __fsReadSync(fd: any, buffer: any, offset?: any, length?: any, position?: any): number {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  if (!__fsIsUint8Array(buffer)) {
    throw new ERR_INVALID_ARG_TYPE("buffer", ["Buffer", "TypedArray", "DataView"], buffer);
  }
  let resolvedOffset: any = offset;
  let resolvedLength: any = length;
  let resolvedPosition: any = position;
  if (offset !== undefined && offset !== null && typeof offset === "object") {
    resolvedOffset = offset.offset;
    resolvedLength = offset.length;
    resolvedPosition = offset.position;
  }
  if (resolvedOffset === undefined || resolvedOffset === null) resolvedOffset = 0;
  if (resolvedLength === undefined || resolvedLength === null) {
    // zun#38: `buffer.length` through an `any` is `undefined`, so the view is
    // re-typed before its room is measured.
    resolvedLength = Number(__fsAsBuffer(buffer).length) - Number(resolvedOffset);
  }
  if (resolvedPosition === undefined || resolvedPosition === null) resolvedPosition = -1;
  if (typeof resolvedPosition === "bigint") resolvedPosition = Number(resolvedPosition);

  const count: number = Number(resolvedLength);
  if (count === 0) return 0;
  const piece: Buffer = __fsBufferOf(
    __fsOne(__fsNative.fsRead(resolvedFd, count, Number(resolvedPosition))),
  );
  const read = Number(piece.length);
  const base = Number(resolvedOffset);
  // zun#38: the destination arrives as an `any`, so it has to be re-typed
  // before it can be indexed at all.
  const target: Buffer = __fsAsBuffer(buffer);
  for (let i = 0; i < read; i++) target[base + i] = Number(piece[i]);
  return read;
}

// `writeSync(fd, buffer, offset, length, position)` and
// `writeSync(fd, string, position, encoding)` — Node distinguishes them by the
// type of the second argument.
function __fsWriteSync(fd: any, data: any, a?: any, b?: any, c?: any): number {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  if (typeof data === "string") {
    let position: any = a;
    const encoding: any = b === undefined || b === null ? "utf8" : b;
    if (position !== undefined && position !== null && typeof position === "object") {
      position = position.position;
    }
    if (position === undefined || position === null) position = -1;
    const base64: string = __fsDataToBase64(data, encoding);
    return Number(__fsOne(__fsNative.fsWrite(resolvedFd, base64, Number(position))));
  }
  if (!__fsIsUint8Array(data)) {
    throw new ERR_INVALID_ARG_TYPE(
      "buffer",
      ["Buffer", "TypedArray", "DataView", "string"],
      data,
    );
  }
  let offset: any = a;
  let length: any = b;
  let position: any = c;
  if (offset !== undefined && offset !== null && typeof offset === "object") {
    length = offset.length;
    position = offset.position;
    offset = offset.offset;
  }
  if (offset === undefined || offset === null) offset = 0;
  if (length === undefined || length === null) {
    // zun#38, as in `__fsReadSync`.
    length = Number(__fsAsBuffer(data).length) - Number(offset);
  }
  if (position === undefined || position === null) position = -1;
  const slice: Buffer = __fsSliceOfView(data, Number(offset), Number(length));
  return Number(
    __fsOne(__fsNative.fsWrite(resolvedFd, slice.toString("base64"), Number(position))),
  );
}

function __fsFstatSync(fd: any, options?: any): any {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  const resolved: any = options === undefined || options === null ? {} : options;
  return __fsStatsFromFields(
    __fsFields(__fsNative.fsFstat(resolvedFd)),
    resolved.bigint === true,
  );
}

function __fsFsyncSync(fd: any): void {
  __fsVoid(__fsNative.fsFsync(__fsGetValidatedFd(fd), false));
}

function __fsFdatasyncSync(fd: any): void {
  __fsVoid(__fsNative.fsFsync(__fsGetValidatedFd(fd), true));
}

function __fsFutimesSync(fd: any, atime: any, mtime: any): void {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  const a: number = __fsToUnixTimestamp(atime, "atime") * 1000;
  const m: number = __fsToUnixTimestamp(mtime, "mtime") * 1000;
  __fsVoid(__fsNative.fsFutimes(resolvedFd, a, m));
}

function __fsFchmodSync(fd: any, mode: any): void {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  __fsVoid(__fsNative.fsFchmod(resolvedFd, __fsParseFileMode(mode, "mode")));
}

function __fsFchownSync(fd: any, uid: any, gid: any): void {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  __fsValidateInteger(uid, "uid", -1, __FS_MAX_UID);
  __fsValidateInteger(gid, "gid", -1, __FS_MAX_UID);
  __fsVoid(__fsNative.fsFchown(resolvedFd, Number(uid), Number(gid)));
}

function __fsStatSync(path: any, options?: any): any {
  return __fsStatImpl(path, options, true, "statSync");
}

function __fsLstatSync(path: any, options?: any): any {
  return __fsStatImpl(path, options, false, "lstatSync");
}

function __fsStatImpl(path: any, options: any, follow: boolean, _name: string): any {
  const resolved: string = __fsGetValidatedPath(path);
  const settings: any = options === undefined || options === null ? {} : options;
  const bigint: boolean = settings.bigint === true;
  const throwIfNoEntry: boolean =
    settings.throwIfNoEntry === undefined ? true : settings.throwIfNoEntry === true;

  const raw: string = __fsNative.fsStat(resolved, follow);
  if (raw === __FS_FAILED) {
    // `{ throwIfNoEntry: false }` turns the *absence* of the entry — and only
    // that — into `undefined`; every other error still throws.
    const code: string = __fsLastCode();
    if (!throwIfNoEntry && (code === "ENOENT" || code === "ENOTDIR")) return undefined;
    __fsFail();
  }
  return __fsStatsFromFields(__fsFields(raw), bigint);
}

function __fsStatfsSync(path: any, options?: any): any {
  const resolved: string = __fsGetValidatedPath(path);
  const settings: any = options === undefined || options === null ? {} : options;
  return __fsStatFsFromFields(
    __fsFields(__fsNative.fsStatfs(resolved)),
    settings.bigint === true,
  );
}

function __fsChmodSync(path: any, mode: any): void {
  const resolved: string = __fsGetValidatedPath(path);
  __fsVoid(__fsNative.fsChmod(resolved, __fsParseFileMode(mode, "mode")));
}

function __fsChownSync(path: any, uid: any, gid: any, follow: boolean): void {
  const resolved: string = __fsGetValidatedPath(path);
  __fsValidateInteger(uid, "uid", -1, __FS_MAX_UID);
  __fsValidateInteger(gid, "gid", -1, __FS_MAX_UID);
  __fsVoid(__fsNative.fsChown(resolved, Number(uid), Number(gid), follow));
}

function __fsUtimesSync(path: any, atime: any, mtime: any, follow: boolean): void {
  const resolved: string = __fsGetValidatedPath(path);
  const a: number = __fsToUnixTimestamp(atime, "atime") * 1000;
  const m: number = __fsToUnixTimestamp(mtime, "mtime") * 1000;
  __fsVoid(__fsNative.fsUtimes(resolved, a, m, follow));
}

function __fsMkdirSync(path: any, options?: any): any {
  const resolved: string = __fsGetValidatedPath(path);
  let recursive = false;
  let mode: any = 0o777;
  if (options !== undefined && options !== null) {
    if (typeof options === "object") {
      if (options.recursive !== undefined && options.recursive !== null) {
        __fsValidateBoolean(options.recursive, "options.recursive");
        recursive = options.recursive === true;
      }
      if (options.mode !== undefined && options.mode !== null) mode = options.mode;
    } else {
      mode = options;
    }
  }
  const resolvedMode: number = __fsParseFileMode(mode, "mode", 0o777);
  const created: string = __fsOne(__fsNative.fsMkdir(resolved, recursive, resolvedMode));
  // Node's recursive form returns the first directory it created, or
  // `undefined` when everything already existed; the non-recursive form always
  // returns `undefined`.
  if (!recursive) return undefined;
  return created === "" ? undefined : created;
}

function __fsRmdirSync(path: any, options?: any): void {
  const resolved: string = __fsGetValidatedPath(path);
  if (options !== undefined && options !== null) __fsValidateObject(options, "options");
  __fsVoid(__fsNative.fsRmdir(resolved));
}

function __fsUnlinkSync(path: any): void {
  const resolved: string = __fsGetValidatedPath(path);
  __fsVoid(__fsNative.fsUnlink(resolved));
}

function __fsRmSync(path: any, options?: any): void {
  const resolved: string = __fsGetValidatedPath(path);
  const settings: any = __fsValidateRmOptions(options);
  const raw: string = __fsNative.fsRm(resolved, settings.recursive, settings.force);
  if (raw === __FS_FAILED) {
    const code: string = __fsLastCode();
    // `rm` without `recursive` on a directory is Node's own error, not libuv's.
    if (code === "EISDIR") throw new ERR_FS_EISDIR(resolved);
    if (settings.force && code === "ENOENT") return;
    __fsFail();
  }
}

function __fsValidateRmOptions(options: any): any {
  const settings: any = { force: false, maxRetries: 0, recursive: false, retryDelay: 100 };
  if (options === undefined || options === null) return settings;
  __fsValidateObject(options, "options");
  if (options.force !== undefined && options.force !== null) {
    __fsValidateBoolean(options.force, "options.force");
    settings.force = options.force === true;
  }
  if (options.recursive !== undefined && options.recursive !== null) {
    __fsValidateBoolean(options.recursive, "options.recursive");
    settings.recursive = options.recursive === true;
  }
  if (options.maxRetries !== undefined && options.maxRetries !== null) {
    __fsValidateInteger(options.maxRetries, "options.maxRetries", 0, __FS_INT32_MAX);
    settings.maxRetries = Number(options.maxRetries);
  }
  if (options.retryDelay !== undefined && options.retryDelay !== null) {
    __fsValidateInteger(options.retryDelay, "options.retryDelay", 0, __FS_INT32_MAX);
    settings.retryDelay = Number(options.retryDelay);
  }
  return settings;
}

function __fsReaddirSync(path: any, options?: any): any[] {
  const resolved: string = __fsGetValidatedPath(path);
  const settings: any = __fsGetOptions(options, {
    encoding: "utf8",
    withFileTypes: false,
    recursive: false,
  });
  if (settings.withFileTypes !== undefined && settings.withFileTypes !== null) {
    __fsValidateBoolean(settings.withFileTypes, "options.withFileTypes");
  }
  if (settings.recursive !== undefined && settings.recursive !== null) {
    __fsValidateBoolean(settings.recursive, "options.recursive");
  }
  const withFileTypes: boolean = settings.withFileTypes === true;
  const recursive: boolean = settings.recursive === true;
  const encoding: any = settings.encoding;

  const out: any[] = [];
  __fsReaddirInto(resolved, "", recursive, withFileTypes, encoding, out);
  return out;
}

// One directory level, and — under `recursive` — every directory below it. The
// names a recursive listing reports are *relative to the starting directory*,
// which is what Node does.
function __fsReaddirInto(
  root: string,
  prefix: string,
  recursive: boolean,
  withFileTypes: boolean,
  encoding: any,
  out: any[],
): void {
  const directory: string = prefix === "" ? root : path.join(root, prefix);
  const records: string[][] = __fsRecords(__fsNative.fsReaddir(directory));
  const count = Number(records.length);
  for (let i = 0; i < count; i++) {
    const name: string = records[i][0];
    const type: number = Number(records[i][1]);
    const relative: string = prefix === "" ? name : prefix + path.sep + name;
    if (withFileTypes) {
      out.push(new Dirent(__fsName(name, encoding), type, directory));
    } else {
      out.push(__fsName(relative, encoding));
    }
    if (recursive && type === __FS_DIRENT_DIR) {
      __fsReaddirInto(root, relative, recursive, withFileTypes, encoding, out);
    }
  }
}

function __fsMkdtempSync(prefix: any, options?: any): any {
  if (typeof prefix !== "string") {
    throw new ERR_INVALID_ARG_TYPE("prefix", "string", prefix);
  }
  if (Number(prefix.indexOf("\u0000")) !== -1) {
    throw new ERR_INVALID_ARG_VALUE(
      "prefix",
      prefix,
      "must be a string, Uint8Array, or URL without null bytes",
    );
  }
  const settings: any = __fsGetOptions(options, { encoding: "utf8" });
  const created: string = __fsOne(__fsNative.fsMkdtemp(prefix));
  return __fsName(created, settings.encoding);
}

function __fsRealpathSync(path: any, options?: any): any {
  const resolved: string = __fsGetValidatedPath(path);
  const settings: any = __fsGetOptions(options, { encoding: "utf8" });
  return __fsName(__fsOne(__fsNative.fsRealpath(resolved)), settings.encoding);
}

function __fsReadlinkSync(path: any, options?: any): any {
  const resolved: string = __fsGetValidatedPath(path);
  const settings: any = __fsGetOptions(options, { encoding: "utf8" });
  return __fsName(__fsOne(__fsNative.fsReadlink(resolved)), settings.encoding);
}

function __fsRenameSync(from: any, to: any): void {
  const source: string = __fsGetValidatedPath(from, "oldPath");
  const target: string = __fsGetValidatedPath(to, "newPath");
  __fsVoid(__fsNative.fsRename(source, target));
}

function __fsCopyFileSync(src: any, dest: any, mode?: any): void {
  const source: string = __fsGetValidatedPath(src, "src");
  const target: string = __fsGetValidatedPath(dest, "dest");
  const resolvedMode: number = mode === undefined || mode === null ? 0 : Number(mode);
  __fsValidateInteger(resolvedMode, "mode", 0, 7);
  __fsVoid(__fsNative.fsCopyFile(source, target, resolvedMode));
}

function __fsLinkSync(existing: any, target: any): void {
  const from: string = __fsGetValidatedPath(existing, "existingPath");
  const to: string = __fsGetValidatedPath(target, "newPath");
  __fsVoid(__fsNative.fsLink(from, to));
}

// `symlinkSync(target, path, type)`. The `type` argument matters only on
// Windows; Node's rule is that an omitted type is resolved by `stat`ing the
// target there and defaults to a file link if that fails.
function __fsSymlinkSync(target: any, linkPath: any, type?: any): void {
  const resolvedTarget: string = __fsGetValidatedPath(target, "target");
  const resolvedPath: string = __fsGetValidatedPath(linkPath, "path");
  __fsVoid(__fsNative.fsSymlink(resolvedTarget, resolvedPath, __fsSymlinkFlags(resolvedTarget, type)));
}

function __fsSymlinkFlags(target: string, type: any): number {
  if (type !== undefined && type !== null) {
    if (type === "dir") return __FS_UV_FS_SYMLINK_DIR;
    if (type === "junction") return __FS_UV_FS_SYMLINK_JUNCTION;
    if (type === "file") return 0;
    throw new ERR_FS_INVALID_SYMLINK_TYPE(type);
  }
  if (!__FS_IS_WINDOWS) return 0;
  // No explicit type: a directory target gets a directory link, which is what
  // `fs.symlink` does on Windows when `type` is omitted.
  const raw: string = __fsNative.fsStat(target, true);
  if (raw === __FS_FAILED) return 0;
  const fields: string[] = raw.slice(1).split(__FS_US);
  return (Number(fields[1]) & __FS_S_IFMT) === __FS_S_IFDIR ? __FS_UV_FS_SYMLINK_DIR : 0;
}

function __fsOpendirSync(path: any, options?: any): any {
  const resolved: string = __fsGetValidatedPath(path);
  const settings: any = __fsGetOptions(options, { encoding: "utf8" });
  const entries: any[] = __fsReaddirSync(resolved, {
    encoding: settings.encoding,
    withFileTypes: true,
    recursive: settings.recursive === true,
  });
  return new Dir(resolved, entries);
}

// `readvSync(fd, buffers, position)` / `writevSync(fd, buffers, position)` —
// one scatter/gather call in Node, a loop here, which is observably the same
// for a regular file.
function __fsReadvSync(fd: any, buffers: any, position?: any): number {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  if (!Array.isArray(buffers)) {
    throw new ERR_INVALID_ARG_TYPE("buffers", "ArrayBufferView[]", buffers);
  }
  let at: any = position === undefined || position === null ? -1 : Number(position);
  let total = 0;
  const count = Number(buffers.length);
  for (let i = 0; i < count; i++) {
    // zun#38: each element arrives as an `any`, so it is re-typed before its
    // length is read.
    const room = Number(__fsAsBuffer(buffers[i]).length);
    const read: number = __fsReadSync(resolvedFd, buffers[i], 0, room, at);
    total += read;
    if (at !== -1) at = Number(at) + read;
    if (read < room) break;
  }
  return total;
}

function __fsWritevSync(fd: any, buffers: any, position?: any): number {
  const resolvedFd: number = __fsGetValidatedFd(fd);
  if (!Array.isArray(buffers)) {
    throw new ERR_INVALID_ARG_TYPE("buffers", "ArrayBufferView[]", buffers);
  }
  let at: any = position === undefined || position === null ? -1 : Number(position);
  let total = 0;
  const count = Number(buffers.length);
  for (let i = 0; i < count; i++) {
    const written: number = __fsWriteSync(
      resolvedFd,
      buffers[i],
      0,
      Number(__fsAsBuffer(buffers[i]).length),
      at,
    );
    total += written;
    if (at !== -1) at = Number(at) + written;
  }
  return total;
}

// ---------------------------------------------------------------------------
// cpSync — Node's recursive copy, which is JavaScript in Node too
// (`lib/internal/fs/cp/cp-sync.js`), so it is JavaScript here.
// ---------------------------------------------------------------------------

function __fsCpOptions(options: any): any {
  const settings: any = {
    dereference: false,
    errorOnExist: false,
    force: true,
    preserveTimestamps: false,
    recursive: false,
    verbatimSymlinks: false,
    filter: undefined,
  };
  if (options === undefined || options === null) return settings;
  __fsValidateObject(options, "options");
  for (const key of Object.keys(settings)) {
    const value: any = options[key];
    if (value === undefined || value === null) continue;
    if (key === "filter") {
      __fsValidateFunction(value, "options.filter");
      settings.filter = value;
      continue;
    }
    __fsValidateBoolean(value, "options." + key);
    settings[key] = value === true;
  }
  if (options.mode !== undefined && options.mode !== null) {
    settings.mode = Number(options.mode);
  }
  return settings;
}

function __fsCpSync(src: any, dest: any, options?: any): void {
  const source: string = __fsGetValidatedPath(src, "src");
  const target: string = __fsGetValidatedPath(dest, "dest");
  const settings: any = __fsCpOptions(options);
  __fsCpEntry(source, target, settings);
}

function __fsCpEntry(source: string, target: string, settings: any): void {
  if (settings.filter !== undefined && settings.filter !== null) {
    if (__evCall(settings.filter, [source, target]) !== true) return;
  }
  const sourceStats: any = settings.dereference
    ? __fsStatSync(source)
    : __fsLstatSync(source);

  if (sourceStats.isDirectory() && !settings.recursive) {
    throw new ERR_FS_CP_EINVAL(
      "Recursive option not enabled, current size of " + source + " is a directory",
      source,
    );
  }

  const targetStats: any = __fsStatImpl(target, { throwIfNoEntry: false }, settings.dereference, "cp");

  if (targetStats !== undefined) {
    if (sourceStats.isDirectory() && !targetStats.isDirectory()) {
      throw new ERR_FS_CP_DIR_TO_NON_DIR(
        "Cannot overwrite non-directory " + target + " with directory " + source,
      );
    }
    if (!sourceStats.isDirectory() && targetStats.isDirectory()) {
      throw new ERR_FS_CP_NON_DIR_TO_DIR(
        "Cannot overwrite directory " + target + " with non-directory " + source,
      );
    }
    if (!sourceStats.isDirectory()) {
      if (settings.errorOnExist) {
        throw new ERR_FS_CP_EEXIST("" + target + " already exists", target);
      }
      if (!settings.force) return;
    }
  }

  if (sourceStats.isDirectory()) {
    if (targetStats === undefined) __fsMkdirSync(target, { recursive: true });
    const entries: any[] = __fsReaddirSync(source);
    const count = Number(entries.length);
    for (let i = 0; i < count; i++) {
      __fsCpEntry(
        path.join(source, String(entries[i])),
        path.join(target, String(entries[i])),
        settings,
      );
    }
    return;
  }

  if (sourceStats.isSymbolicLink()) {
    const linkTarget: string = __fsReadlinkSync(source);
    if (targetStats !== undefined) __fsUnlinkSync(target);
    __fsSymlinkSync(linkTarget, target);
    return;
  }

  __fsCopyFileSync(source, target, settings.mode === undefined ? 0 : settings.mode);
  if (settings.preserveTimestamps) {
    __fsUtimesSync(target, sourceStats.atimeMs / 1000, sourceStats.mtimeMs / 1000, true);
  }
}

// ---------------------------------------------------------------------------
// The callback surface
//
// Node runs the work on the threadpool and delivers the result on a later
// turn. There is no threadpool here (nor a loop to post to), so each call runs
// the *sync* path and delivers on the next tick — which preserves the one
// property programs depend on: the callback never runs before the call
// returns. The syscall itself is synchronous, so a long read blocks where Node
// would not; that is the honest cost of having no threadpool, and it is
// invisible to every test that does not measure concurrency.
// ---------------------------------------------------------------------------

// `makeCallback` — a non-function callback is a synchronous type error, which
// is what every `test-fs-*-type-check.js` asserts.
function __fsMakeCallback(callback: any): any {
  if (!__evIsFn(callback)) {
    throw new ERR_INVALID_ARG_TYPE("cb", "Function", callback);
  }
  return callback;
}

// Deliver `args` to `callback` on a later turn.
//
// The pair travels through this module's own FIFO rather than as
// `__processNextTick(fn, callback, args)`, and the tick carries no arguments at
// all: `process.nextTick` is a rest-parameter function, and a call that hands
// one both a function value *and* further arguments is resolved
// inconsistently — it works from some call sites and aborts with "call did not
// resolve to a method" from others (the rest-parameter family of
// https://github.com/UrubuCode/zun/issues/11 and
// https://github.com/UrubuCode/zun/issues/17). One tick per delivery, each
// draining one entry, keeps FIFO order *and* keeps the work visible to
// `__processPendingTicks()`, which is what the harness watches to decide the
// loop has gone quiet.
const __fsOutbox: any[] = [];

function __fsDeliver(callback: any, args: any[]): void {
  const entry: any = { args: args };
  // `__evRawSet` so the callable lands in the slot the rest of the object model
  // can read back (zun#32).
  __evRawSet(entry, "fn", callback);
  __fsOutbox.push(entry);
  __processNextTick(__fsDrainOutbox);
}

function __fsDrainOutbox(): void {
  if (Number(__fsOutbox.length) === 0) return;
  const entry: any = __fsOutbox.shift();
  __evCall(entry.fn, entry.args);
}

// Which failures reach the callback, and which are thrown at the call site.
//
// Node draws this line sharply, and every `test-fs-*-type-check.js` file in the
// corpus asserts it: a bad *argument* is a synchronous `throw`
// (`assert.throws(() => fs.rmdir(1, cb))` expects nothing to be delivered),
// while a failed *operation* is delivered to the callback. The two are told
// apart by the code: a libuv code (`ENOENT`, `EACCES`, ...) or one of the
// `ERR_FS_*` operation errors is delivered; `ERR_INVALID_ARG_TYPE`,
// `ERR_OUT_OF_RANGE` and `ERR_INVALID_ARG_VALUE` are thrown.
function __fsIsOperationError(error: any): boolean {
  if (error === null || error === undefined) return false;
  const code: any = error.code;
  if (typeof code !== "string") return false;
  const text: string = code;
  if (text.slice(0, 7) === "ERR_FS_") return true;
  return text.charAt(0) === "E" && text.slice(0, 4) !== "ERR_";
}

// Run `work` (a zero-argument function returning the callback's value) and
// deliver either `(null, value)` or `(error)`. `work` runs *synchronously*, so
// an argument error leaves this function by throwing, exactly as in Node; only
// the delivery of the outcome is deferred to a later tick.
function __fsRunAsync(callback: any, work: any): void {
  const target: any = __fsMakeCallback(callback);
  let value: any = undefined;
  let failure: any = undefined;
  try {
    value = __evCall(work, []);
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) {
    if (!__fsIsOperationError(failure)) throw failure;
    __fsDeliver(target, [failure]);
    return;
  }
  if (value === undefined) {
    __fsDeliver(target, [null]);
    return;
  }
  __fsDeliver(target, [null, value]);
}

// The options/callback tail every `fs` callback function accepts: the last
// argument is the callback, and the one before it may be options.
function __fsTail(options: any, callback: any): any[] {
  if (__evIsFn(options) && (callback === undefined || callback === null)) {
    return [undefined, options];
  }
  return [options, callback];
}

// ---------------------------------------------------------------------------
// The module object
//
// Every entry is an object-literal method delegating to the `__fs*` function
// above, rather than the bare function value Node exports: a method survives
// being read, destructured and called through an `any`, where a function value
// does not (zun#17).
// ---------------------------------------------------------------------------

const fs: any = {
  // ---- sync ---------------------------------------------------------------
  accessSync(path: any, mode?: any): void {
    __fsAccessSync(path, mode);
  },
  appendFileSync(file: any, data: any, options?: any): void {
    __fsAppendFileSync(file, data, options);
  },
  chmodSync(path: any, mode: any): void {
    __fsChmodSync(path, mode);
  },
  chownSync(path: any, uid: any, gid: any): void {
    __fsChownSync(path, uid, gid, true);
  },
  closeSync(fd: any): void {
    __fsCloseSync(fd);
  },
  copyFileSync(src: any, dest: any, mode?: any): void {
    __fsCopyFileSync(src, dest, mode);
  },
  cpSync(src: any, dest: any, options?: any): void {
    __fsCpSync(src, dest, options);
  },
  existsSync(path: any): boolean {
    return __fsExistsSync(path);
  },
  fchmodSync(fd: any, mode: any): void {
    __fsFchmodSync(fd, mode);
  },
  fchownSync(fd: any, uid: any, gid: any): void {
    __fsFchownSync(fd, uid, gid);
  },
  fdatasyncSync(fd: any): void {
    __fsFdatasyncSync(fd);
  },
  fstatSync(fd: any, options?: any): any {
    return __fsFstatSync(fd, options);
  },
  fsyncSync(fd: any): void {
    __fsFsyncSync(fd);
  },
  ftruncateSync(fd: any, len?: any): void {
    __fsFtruncateSync(fd, len);
  },
  futimesSync(fd: any, atime: any, mtime: any): void {
    __fsFutimesSync(fd, atime, mtime);
  },
  lchmodSync(path: any, mode: any): void {
    // POSIX has no `lchmod` on Linux and libuv reports ENOSYS; Node only
    // defines `lchmod` where it exists, so the honest answer is the error.
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.lchmodSync");
  },
  lchownSync(path: any, uid: any, gid: any): void {
    __fsChownSync(path, uid, gid, false);
  },
  linkSync(existing: any, target: any): void {
    __fsLinkSync(existing, target);
  },
  lstatSync(path: any, options?: any): any {
    return __fsLstatSync(path, options);
  },
  lutimesSync(path: any, atime: any, mtime: any): void {
    __fsUtimesSync(path, atime, mtime, false);
  },
  mkdirSync(path: any, options?: any): any {
    return __fsMkdirSync(path, options);
  },
  mkdtempSync(prefix: any, options?: any): any {
    return __fsMkdtempSync(prefix, options);
  },
  openSync(path: any, flags?: any, mode?: any): number {
    return __fsOpenSync(path, flags, mode);
  },
  opendirSync(path: any, options?: any): any {
    return __fsOpendirSync(path, options);
  },
  readSync(fd: any, buffer: any, offset?: any, length?: any, position?: any): number {
    return __fsReadSync(fd, buffer, offset, length, position);
  },
  readdirSync(path: any, options?: any): any[] {
    return __fsReaddirSync(path, options);
  },
  readFileSync(path: any, options?: any): any {
    return __fsReadFileSync(path, options);
  },
  readlinkSync(path: any, options?: any): any {
    return __fsReadlinkSync(path, options);
  },
  readvSync(fd: any, buffers: any, position?: any): number {
    return __fsReadvSync(fd, buffers, position);
  },
  realpathSync(path: any, options?: any): any {
    return __fsRealpathSync(path, options);
  },
  renameSync(from: any, to: any): void {
    __fsRenameSync(from, to);
  },
  rmSync(path: any, options?: any): void {
    __fsRmSync(path, options);
  },
  rmdirSync(path: any, options?: any): void {
    __fsRmdirSync(path, options);
  },
  statSync(path: any, options?: any): any {
    return __fsStatSync(path, options);
  },
  statfsSync(path: any, options?: any): any {
    return __fsStatfsSync(path, options);
  },
  symlinkSync(target: any, linkPath: any, type?: any): void {
    __fsSymlinkSync(target, linkPath, type);
  },
  truncateSync(path: any, len?: any): void {
    __fsTruncateSync(path, len);
  },
  unlinkSync(path: any): void {
    __fsUnlinkSync(path);
  },
  utimesSync(path: any, atime: any, mtime: any): void {
    __fsUtimesSync(path, atime, mtime, true);
  },
  writeSync(fd: any, data: any, a?: any, b?: any, c?: any): number {
    return __fsWriteSync(fd, data, a, b, c);
  },
  writeFileSync(file: any, data: any, options?: any): void {
    __fsWriteFileSync(file, data, options);
  },
  writevSync(fd: any, buffers: any, position?: any): number {
    return __fsWritevSync(fd, buffers, position);
  },
  globSync(pattern: any, options?: any): any[] {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.globSync");
  },

  // ---- callbacks ----------------------------------------------------------
  access(path: any, mode?: any, callback?: any): void {
    const tail: any[] = __fsTail(mode, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsAccessSync(path, tail[0]);
      return undefined;
    });
  },
  appendFile(file: any, data: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsAppendFileSync(file, data, tail[0]);
      return undefined;
    });
  },
  chmod(path: any, mode: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsChmodSync(path, mode);
      return undefined;
    });
  },
  chown(path: any, uid: any, gid: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsChownSync(path, uid, gid, true);
      return undefined;
    });
  },
  // `fs.close(fd[, callback])`: only an *absent* callback makes this
  // synchronous. `null` is not absent — Node's own test-fs-close-errors.js
  // asserts that `fs.close(fd, null)` is an `ERR_INVALID_ARG_TYPE`.
  close(fd: any, callback?: any): void {
    if (callback === undefined) {
      __fsCloseSync(fd);
      return;
    }
    __fsRunAsync(callback, function (): any {
      __fsCloseSync(fd);
      return undefined;
    });
  },
  copyFile(src: any, dest: any, mode?: any, callback?: any): void {
    const tail: any[] = __fsTail(mode, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsCopyFileSync(src, dest, tail[0]);
      return undefined;
    });
  },
  cp(src: any, dest: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsCpSync(src, dest, tail[0]);
      return undefined;
    });
  },
  // `fs.exists` is the one callback in `fs` whose callback takes no error.
  exists(path: any, callback?: any): void {
    const target: any = __fsMakeCallback(callback);
    const answer: boolean = __fsExistsSync(path);
    __fsDeliver(target, [answer]);
  },
  // `fchmod`/`fchown` validate `fd` and the rest **before** the callback, and
  // the order is observable: `fs.fchmod(1, '123x')` is an
  // `ERR_INVALID_ARG_VALUE` about the mode in Node, not an
  // `ERR_INVALID_ARG_TYPE` about the missing callback
  // (`test-fs-fchmod.js`, `test-fs-fchown.js`).
  fchmod(fd: any, mode: any, callback?: any): void {
    __fsGetValidatedFd(fd);
    __fsParseFileMode(mode, "mode");
    __fsRunAsync(callback, function (): any {
      __fsFchmodSync(fd, mode);
      return undefined;
    });
  },
  fchown(fd: any, uid: any, gid: any, callback?: any): void {
    __fsGetValidatedFd(fd);
    __fsValidateInteger(uid, "uid", -1, __FS_UINT32_MAX);
    __fsValidateInteger(gid, "gid", -1, __FS_UINT32_MAX);
    __fsRunAsync(callback, function (): any {
      __fsFchownSync(fd, uid, gid);
      return undefined;
    });
  },
  fdatasync(fd: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsFdatasyncSync(fd);
      return undefined;
    });
  },
  fstat(fd: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsFstatSync(fd, tail[0]);
    });
  },
  fsync(fd: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsFsyncSync(fd);
      return undefined;
    });
  },
  ftruncate(fd: any, len?: any, callback?: any): void {
    const tail: any[] = __fsTail(len, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsFtruncateSync(fd, tail[0]);
      return undefined;
    });
  },
  futimes(fd: any, atime: any, mtime: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsFutimesSync(fd, atime, mtime);
      return undefined;
    });
  },
  lchmod(path: any, mode: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      throw new ERR_METHOD_NOT_IMPLEMENTED("fs.lchmod");
    });
  },
  lchown(path: any, uid: any, gid: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsChownSync(path, uid, gid, false);
      return undefined;
    });
  },
  link(existing: any, target: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsLinkSync(existing, target);
      return undefined;
    });
  },
  lstat(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsLstatSync(path, tail[0]);
    });
  },
  lutimes(path: any, atime: any, mtime: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsUtimesSync(path, atime, mtime, false);
      return undefined;
    });
  },
  mkdir(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsMkdirSync(path, tail[0]);
    });
  },
  mkdtemp(prefix: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsMkdtempSync(prefix, tail[0]);
    });
  },
  open(path: any, flags?: any, mode?: any, callback?: any): void {
    let resolvedFlags: any = flags;
    let resolvedMode: any = mode;
    let target: any = callback;
    if (__evIsFn(flags)) {
      target = flags;
      resolvedFlags = undefined;
      resolvedMode = undefined;
    } else if (__evIsFn(mode)) {
      target = mode;
      resolvedMode = undefined;
    }
    __fsRunAsync(target, function (): any {
      return __fsOpenSync(path, resolvedFlags, resolvedMode);
    });
  },
  opendir(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsOpendirSync(path, tail[0]);
    });
  },
  read(fd: any, buffer?: any, offset?: any, length?: any, position?: any, callback?: any): void {
    // Node accepts `(fd, buffer, offset, length, position, cb)`,
    // `(fd, buffer, options, cb)`, `(fd, options, cb)` and `(fd, cb)`.
    let target: any = callback;
    let resolvedBuffer: any = buffer;
    let resolvedOffset: any = offset;
    let resolvedLength: any = length;
    let resolvedPosition: any = position;
    if (__evIsFn(buffer)) {
      target = buffer;
      resolvedBuffer = Buffer.alloc(16384);
      resolvedOffset = 0;
      resolvedLength = 16384;
      resolvedPosition = null;
    } else if (__evIsFn(offset)) {
      target = offset;
      if (!__fsIsUint8Array(buffer)) {
        // `(fd, options, cb)`.
        const settings: any = buffer === undefined || buffer === null ? {} : buffer;
        resolvedBuffer =
          settings.buffer === undefined || settings.buffer === null
            ? Buffer.alloc(16384)
            : settings.buffer;
        resolvedOffset = settings.offset;
        resolvedLength = settings.length;
        resolvedPosition = settings.position;
      } else {
        resolvedOffset = 0;
        resolvedLength = Number(__fsAsBuffer(buffer).length);
        resolvedPosition = null;
      }
    } else if (__evIsFn(length)) {
      target = length;
      const settings: any = offset === undefined || offset === null ? {} : offset;
      resolvedOffset = settings.offset;
      resolvedLength = settings.length;
      resolvedPosition = settings.position;
    } else if (__evIsFn(position)) {
      target = position;
      resolvedPosition = null;
    }
    const finalBuffer: any = resolvedBuffer;
    const outerTarget: any = __fsMakeCallback(target);
    let read: any = 0;
    let failure: any = undefined;
    try {
      read = __fsReadSync(fd, finalBuffer, resolvedOffset, resolvedLength, resolvedPosition);
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      if (!__fsIsOperationError(failure)) throw failure;
      __fsDeliver(outerTarget, [failure]);
      return;
    }
    __fsDeliver(outerTarget, [null, read, finalBuffer]);
  },
  readdir(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsReaddirSync(path, tail[0]);
    });
  },
  readFile(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsReadFileSync(path, tail[0]);
    });
  },
  readlink(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsReadlinkSync(path, tail[0]);
    });
  },
  readv(fd: any, buffers: any, position?: any, callback?: any): void {
    const tail: any[] = __fsTail(position, callback);
    const outerTarget: any = __fsMakeCallback(tail[1]);
    let read: any = 0;
    let failure: any = undefined;
    try {
      read = __fsReadvSync(fd, buffers, tail[0]);
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      if (!__fsIsOperationError(failure)) throw failure;
      __fsDeliver(outerTarget, [failure]);
      return;
    }
    __fsDeliver(outerTarget, [null, read, buffers]);
  },
  realpath(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsRealpathSync(path, tail[0]);
    });
  },
  rename(from: any, to: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsRenameSync(from, to);
      return undefined;
    });
  },
  rm(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsRmSync(path, tail[0]);
      return undefined;
    });
  },
  rmdir(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsRmdirSync(path, tail[0]);
      return undefined;
    });
  },
  stat(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsStatSync(path, tail[0]);
    });
  },
  statfs(path: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      return __fsStatfsSync(path, tail[0]);
    });
  },
  symlink(target: any, linkPath: any, type?: any, callback?: any): void {
    const tail: any[] = __fsTail(type, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsSymlinkSync(target, linkPath, tail[0]);
      return undefined;
    });
  },
  truncate(path: any, len?: any, callback?: any): void {
    const tail: any[] = __fsTail(len, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsTruncateSync(path, tail[0]);
      return undefined;
    });
  },
  unlink(path: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsUnlinkSync(path);
      return undefined;
    });
  },
  utimes(path: any, atime: any, mtime: any, callback?: any): void {
    __fsRunAsync(callback, function (): any {
      __fsUtimesSync(path, atime, mtime, true);
      return undefined;
    });
  },
  write(fd: any, data: any, a?: any, b?: any, c?: any, d?: any): void {
    // The callback is whichever of the trailing arguments is a function.
    let target: any = undefined;
    let p1: any = a;
    let p2: any = b;
    let p3: any = c;
    if (__evIsFn(a)) {
      target = a;
      p1 = undefined;
      p2 = undefined;
      p3 = undefined;
    } else if (__evIsFn(b)) {
      target = b;
      p2 = undefined;
      p3 = undefined;
    } else if (__evIsFn(c)) {
      target = c;
      p3 = undefined;
    } else {
      target = d;
    }
    const outerTarget: any = __fsMakeCallback(target);
    let written: any = 0;
    let failure: any = undefined;
    try {
      written = __fsWriteSync(fd, data, p1, p2, p3);
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      if (!__fsIsOperationError(failure)) throw failure;
      __fsDeliver(outerTarget, [failure]);
      return;
    }
    __fsDeliver(outerTarget, [null, written, data]);
  },
  writeFile(file: any, data: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      __fsWriteFileSync(file, data, tail[0]);
      return undefined;
    });
  },
  writev(fd: any, buffers: any, position?: any, callback?: any): void {
    const tail: any[] = __fsTail(position, callback);
    const outerTarget: any = __fsMakeCallback(tail[1]);
    let written: any = 0;
    let failure: any = undefined;
    try {
      written = __fsWritevSync(fd, buffers, tail[0]);
    } catch (error) {
      failure = error;
    }
    if (failure !== undefined) {
      if (!__fsIsOperationError(failure)) throw failure;
      __fsDeliver(outerTarget, [failure]);
      return;
    }
    __fsDeliver(outerTarget, [null, written, buffers]);
  },
  glob(pattern: any, options?: any, callback?: any): void {
    const tail: any[] = __fsTail(options, callback);
    __fsRunAsync(tail[1], function (): any {
      throw new ERR_METHOD_NOT_IMPLEMENTED("fs.glob");
    });
  },

  // ---- the two streams, which live in src/fs/streams.ts -------------------
  //
  // `fs.ReadStream`/`fs.WriteStream` stand on `node:stream`, and this file has
  // to keep compiling in a bundle with no stream module in it (160 of the
  // corpus' files pull `fs` in only through `../common/tmpdir`). So the
  // classes are a second file, appended after `src/stream/stream.ts`, and the
  // two entry points go through the hook table that file overwrites.
  createReadStream(path: any, options?: any): any {
    return __evCall(__fsStreamHooks.createReadStream, [path, options]);
  },
  createWriteStream(path: any, options?: any): any {
    return __evCall(__fsStreamHooks.createWriteStream, [path, options]);
  },

  // ---- the watchers, src/fs/watchers.ts ------------------------------------
  watch(path: any, options?: any, listener?: any): any {
    return __evCall(__fsWatchHooks.watch, [path, options, listener]);
  },
  watchFile(path: any, options?: any, listener?: any): any {
    return __evCall(__fsWatchHooks.watchFile, [path, options, listener]);
  },
  unwatchFile(path: any, listener?: any): void {
    __evCall(__fsWatchHooks.unwatchFile, [path, listener]);
  },

  // ---- the gaps, named rather than absent --------------------------------
  openAsBlob(path: any, options?: any): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("fs.openAsBlob");
  },

  // `fs._toUnixTimestamp` is internal, and Node's own
  // test-fs-timestamp-parsing-error.js reads it off the module.
  _toUnixTimestamp(time: any, name?: any): number {
    return __fsToUnixTimestamp(time, name);
  },
};

// `realpathSync.native` and `realpath.native` are separate entry points in
// Node (the libuv one, with no JavaScript symlink walk). This implementation
// *is* the libuv one, so both names are the same call.
fs.realpathSync.native = function (path: any, options?: any): any {
  return __fsRealpathSync(path, options);
};
fs.realpath.native = function (path: any, options?: any, callback?: any): void {
  const tail: any[] = __fsTail(options, callback);
  __fsRunAsync(tail[1], function (): any {
    return __fsRealpathSync(path, tail[0]);
  });
};

// The classes Node exports off the module, which tests use for `instanceof`.
fs.Stats = Stats;
fs.Dirent = Dirent;
fs.Dir = Dir;
fs.StatsFs = StatsFs;
fs.ReadStream = undefined;
fs.WriteStream = undefined;

// `constants` is not writable or configurable in Node, and
// `Object.getPrototypeOf(fs.constants)` is `null` — both of which Node's own
// test-fs-constants.js checks.
Object.defineProperties(fs, {
  constants: {
    configurable: false,
    enumerable: true,
    value: __fsConstants,
  },
  F_OK: { enumerable: true, writable: false, value: __fsConst("F_OK") },
  R_OK: { enumerable: true, writable: false, value: __fsConst("R_OK") },
  W_OK: { enumerable: true, writable: false, value: __fsConst("W_OK") },
  X_OK: { enumerable: true, writable: false, value: __fsConst("X_OK") },
});

// ---------------------------------------------------------------------------
// fs.promises
//
// A promise API over the same sync calls. "Asynchronous" here means the
// promise settles on a later turn, never in the same one — which is the
// property programs actually depend on, and the one a `Promise` gives for free
// (`then` reactions are microtasks).
// ---------------------------------------------------------------------------

// `Promise.resolve(value)` for the success path, `Promise.reject(error)` for
// the failure one, from a synchronous thunk.
function __fsPromise(work: any): any {
  let value: any = undefined;
  let failure: any = undefined;
  try {
    value = __evCall(work, []);
  } catch (error) {
    failure = error;
  }
  if (failure !== undefined) return Promise.reject(failure);
  return Promise.resolve(value);
}

// `FileHandle` — `fs.promises.open`'s resolution. Node's is an object wrapping
// the descriptor with a `Symbol.asyncDispose`; this is the same, over the same
// descriptor table.
class FileHandle {
  fd: number = -1;
  constructor(fd: number) {
    this.fd = fd;
  }
  close(): any {
    const fd: number = this.fd;
    this.fd = -1;
    return __fsPromise(function (): any {
      if (fd < 0) return undefined;
      __fsCloseSync(fd);
      return undefined;
    });
  }
  read(buffer?: any, offset?: any, length?: any, position?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      let target: any = buffer;
      let at: any = offset;
      let count: any = length;
      let where: any = position;
      if (target === undefined || target === null) {
        target = Buffer.alloc(16384);
        at = 0;
        count = 16384;
        where = null;
      } else if (!__fsIsUint8Array(target)) {
        const settings: any = target;
        target =
          settings.buffer === undefined || settings.buffer === null
            ? Buffer.alloc(16384)
            : settings.buffer;
        at = settings.offset;
        count = settings.length;
        where = settings.position;
      }
      const read: number = __fsReadSync(fd, target, at, count, where);
      return { bytesRead: read, buffer: target };
    });
  }
  write(data?: any, a?: any, b?: any, c?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      const written: number = __fsWriteSync(fd, data, a, b, c);
      return { bytesWritten: written, buffer: data };
    });
  }
  writev(buffers: any, position?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      const written: number = __fsWritevSync(fd, buffers, position);
      return { bytesWritten: written, buffers: buffers };
    });
  }
  readv(buffers: any, position?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      const read: number = __fsReadvSync(fd, buffers, position);
      return { bytesRead: read, buffers: buffers };
    });
  }
  stat(options?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      return __fsFstatSync(fd, options);
    });
  }
  truncate(len?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsFtruncateSync(fd, len);
      return undefined;
    });
  }
  sync(): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsFsyncSync(fd);
      return undefined;
    });
  }
  datasync(): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsFdatasyncSync(fd);
      return undefined;
    });
  }
  chmod(mode: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsFchmodSync(fd, mode);
      return undefined;
    });
  }
  chown(uid: any, gid: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsFchownSync(fd, uid, gid);
      return undefined;
    });
  }
  utimes(atime: any, mtime: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsFutimesSync(fd, atime, mtime);
      return undefined;
    });
  }
  readFile(options?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      return __fsReadFileSync(fd, options);
    });
  }
  writeFile(data: any, options?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsWriteFileSync(fd, data, options);
      return undefined;
    });
  }
  appendFile(data: any, options?: any): any {
    const fd: number = this.fd;
    return __fsPromise(function (): any {
      __fsAppendFileSync(fd, data, options);
      return undefined;
    });
  }
  createReadStream(options?: any): any {
    return __evCall(__fsStreamHooks.handleReadStream, [this, options]);
  }
  createWriteStream(options?: any): any {
    return __evCall(__fsStreamHooks.handleWriteStream, [this, options]);
  }
}

const __fsPromises: any = {
  access(path: any, mode?: any): any {
    return __fsPromise(function (): any {
      __fsAccessSync(path, mode);
      return undefined;
    });
  },
  appendFile(file: any, data: any, options?: any): any {
    return __fsPromise(function (): any {
      __fsAppendFileSync(file, data, options);
      return undefined;
    });
  },
  chmod(path: any, mode: any): any {
    return __fsPromise(function (): any {
      __fsChmodSync(path, mode);
      return undefined;
    });
  },
  chown(path: any, uid: any, gid: any): any {
    return __fsPromise(function (): any {
      __fsChownSync(path, uid, gid, true);
      return undefined;
    });
  },
  copyFile(src: any, dest: any, mode?: any): any {
    return __fsPromise(function (): any {
      __fsCopyFileSync(src, dest, mode);
      return undefined;
    });
  },
  cp(src: any, dest: any, options?: any): any {
    return __fsPromise(function (): any {
      __fsCpSync(src, dest, options);
      return undefined;
    });
  },
  lchmod(path: any, mode: any): any {
    return __fsPromise(function (): any {
      throw new ERR_METHOD_NOT_IMPLEMENTED("fsPromises.lchmod");
    });
  },
  lchown(path: any, uid: any, gid: any): any {
    return __fsPromise(function (): any {
      __fsChownSync(path, uid, gid, false);
      return undefined;
    });
  },
  link(existing: any, target: any): any {
    return __fsPromise(function (): any {
      __fsLinkSync(existing, target);
      return undefined;
    });
  },
  lstat(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsLstatSync(path, options);
    });
  },
  lutimes(path: any, atime: any, mtime: any): any {
    return __fsPromise(function (): any {
      __fsUtimesSync(path, atime, mtime, false);
      return undefined;
    });
  },
  mkdir(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsMkdirSync(path, options);
    });
  },
  mkdtemp(prefix: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsMkdtempSync(prefix, options);
    });
  },
  open(path: any, flags?: any, mode?: any): any {
    return __fsPromise(function (): any {
      return new FileHandle(__fsOpenSync(path, flags === undefined ? "r" : flags, mode));
    });
  },
  opendir(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsOpendirSync(path, options);
    });
  },
  readdir(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsReaddirSync(path, options);
    });
  },
  readFile(path: any, options?: any): any {
    return __fsPromise(function (): any {
      const handle: any = path;
      if (handle !== null && handle !== undefined && typeof handle === "object" && handle.fd !== undefined) {
        return __fsReadFileSync(Number(handle.fd), options);
      }
      return __fsReadFileSync(path, options);
    });
  },
  readlink(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsReadlinkSync(path, options);
    });
  },
  realpath(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsRealpathSync(path, options);
    });
  },
  rename(from: any, to: any): any {
    return __fsPromise(function (): any {
      __fsRenameSync(from, to);
      return undefined;
    });
  },
  rm(path: any, options?: any): any {
    return __fsPromise(function (): any {
      __fsRmSync(path, options);
      return undefined;
    });
  },
  rmdir(path: any, options?: any): any {
    return __fsPromise(function (): any {
      __fsRmdirSync(path, options);
      return undefined;
    });
  },
  stat(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsStatSync(path, options);
    });
  },
  statfs(path: any, options?: any): any {
    return __fsPromise(function (): any {
      return __fsStatfsSync(path, options);
    });
  },
  symlink(target: any, linkPath: any, type?: any): any {
    return __fsPromise(function (): any {
      __fsSymlinkSync(target, linkPath, type);
      return undefined;
    });
  },
  truncate(path: any, len?: any): any {
    return __fsPromise(function (): any {
      __fsTruncateSync(path, len);
      return undefined;
    });
  },
  unlink(path: any): any {
    return __fsPromise(function (): any {
      __fsUnlinkSync(path);
      return undefined;
    });
  },
  utimes(path: any, atime: any, mtime: any): any {
    return __fsPromise(function (): any {
      __fsUtimesSync(path, atime, mtime, true);
      return undefined;
    });
  },
  writeFile(file: any, data: any, options?: any): any {
    return __fsPromise(function (): any {
      __fsWriteFileSync(file, data, options);
      return undefined;
    });
  },
  glob(pattern: any, options?: any): any {
    return __fsPromise(function (): any {
      throw new ERR_METHOD_NOT_IMPLEMENTED("fsPromises.glob");
    });
  },
  watch(path: any, options?: any): any {
    return __evCall(__fsWatchHooks.promisesWatch, [path, options]);
  },
};

Object.defineProperties(__fsPromises, {
  constants: {
    configurable: false,
    enumerable: true,
    value: __fsConstants,
  },
});
__fsPromises.FileHandle = FileHandle;

fs.promises = __fsPromises;

// `process.pid`, which is not part of Node's `fs` surface at all.
//
// It is corrected from here for the same reason `src/os/os.ts` corrects it:
// `zun:core`'s host surface reports no pid, so `src/process/process.ts` — which
// has no extension of its own, and must keep compiling without `--ext` for the
// `path` and `events` bundles — falls back to a placeholder. Whenever `fs` is
// loaded the real pid is available, and here it is load-bearing rather than
// cosmetic: `tools/harness/tmpdir.ts` names the scratch directory after it, so
// two test processes that both report pid 1 would delete each other's files.
// The line moves into `process` the moment `process` has a native of its own.
process.pid = Number(__fsNative.fsPid());

// `node:fs` and `node:fs/promises` module objects for the bundler's `require`
// rewriting (one object per inlined module, named `__node_<module>`).
const __node_fs: any = fs;
const __node_fs_promises: any = __fsPromises;

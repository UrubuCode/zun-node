// node:path — the full POSIX and Windows path surface, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes 100%
// of Node's own `test/parallel/test-path*.js` files (see ../../test/path/).
// Root parsing, normalize, join, resolve and the Windows hardening passes are
// written against that corpus; the character-scanning routines for relative,
// dirname, basename, extname, parse and format follow Node's `lib/path.js`
// (MIT, Copyright Joyent, Inc. and other Node contributors) because their edge
// cases are defined by that code.
//
// Unlike `src/fs/` (a Rust `zun_abi` extension, because it needs syscalls), `path`
// is pure string computation, so it is written in the language the platform
// compiles. See ../../PLAN.md.
//
// Engine workarounds in this file, each tied to an open zun issue:
//   * `slen()` instead of `.length` in arithmetic — `.length` is u64, so
//     `len - 1` underflows and `i >= 0` compares unsigned
//     (https://github.com/UrubuCode/zun/issues/3).
//   * `cc()` instead of `.charCodeAt()` — an out-of-range index throws instead of
//     returning NaN (https://github.com/UrubuCode/zun/issues/2).
//   * a RegExp is built and used inside one function, never passed through `any`
//     (https://github.com/UrubuCode/zun/issues/7).

// ---------------------------------------------------------------------------
// Character codes and small helpers
// ---------------------------------------------------------------------------

const CODE_SLASH = 47; // /
const CODE_BACKSLASH = 92; // \
const CODE_DOT = 46; // .
const CODE_COLON = 58; // :
const CODE_QUESTION = 63; // ?

// `.length` as a JS Number. See issue #3.
function slen(value: string): number {
  return Number(value.length);
}

function alen(value: any[]): number {
  return Number(value.length);
}

// `charCodeAt` that answers -1 out of range instead of throwing. -1 can never
// equal a real code unit, so every comparison below behaves like NaN would.
// See issue #2.
function cc(value: string, index: number): number {
  if (index < 0 || index >= slen(value)) return -1;
  return value.charCodeAt(index);
}

function isPosixSep(code: number): boolean {
  return code === CODE_SLASH;
}

function isWin32Sep(code: number): boolean {
  return code === CODE_SLASH || code === CODE_BACKSLASH;
}

function isSep(code: number, win: boolean): boolean {
  return win ? isWin32Sep(code) : isPosixSep(code);
}

// A-Z or a-z, i.e. a possible Windows drive letter.
function isDriveLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function last(parts: string[]): string {
  const n = alen(parts);
  return n === 0 ? "" : parts[n - 1];
}

// ---------------------------------------------------------------------------
// Host hooks
//
// These read the ambient process the way Node's own `lib/path.js` does. They
// come from `src/process/process.ts`, which the bundle places before this file.
// ---------------------------------------------------------------------------

function pathPlatformIsWindows(): boolean {
  return process.platform === "win32";
}

function processCwdWin32(): string {
  return process.cwd();
}

// `path.posix.resolve` on a Windows host drops the drive indicator and switches
// to forward slashes, so a POSIX result never carries a Windows root.
function processCwdPosix(): string {
  const cwd = process.cwd();
  if (!pathPlatformIsWindows()) return cwd;
  const slashed = toSlashes(cwd);
  const firstSlash = slashed.indexOf("/");
  return firstSlash < 0 ? slashed : slashed.slice(firstSlash);
}

function processEnvGet(name: string): any {
  const direct = process.env[name];
  if (direct !== undefined) return direct;
  return process.envLookup(name);
}

// ---------------------------------------------------------------------------
// Argument validation — Node's ERR_INVALID_ARG_TYPE
// ---------------------------------------------------------------------------

function describeReceived(value: any): string {
  if (value === null) return " Received null";
  if (value === undefined) return " Received undefined";
  const kind = typeof value;
  if (kind === "function") {
    const name = value.name === undefined ? "" : String(value.name);
    return " Received function " + name;
  }
  if (kind === "object") {
    if (Array.isArray(value)) return " Received an instance of Array";
    return " Received an instance of Object";
  }
  let text = kind === "string" ? JSON.stringify(value) : String(value);
  if (slen(text) > 25) text = text.slice(0, 25) + "...";
  return " Received type " + kind + " (" + text + ")";
}

function invalidArgType(name: string, value: any): any {
  const error: any = new TypeError(
    'The "' +
      name +
      '" argument must be of type string.' +
      describeReceived(value),
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function validateString(value: any, name: string): void {
  if (typeof value !== "string") throw invalidArgType(name, value);
}

// ---------------------------------------------------------------------------
// Root parsing
//
// A path splits into a prefix (never ending in a separator), a flag saying
// whether what follows the prefix is rooted, and the remainder:
//
//   posix  "/a/b"                 -> prefix ""                 absolute rest "a/b"
//   win32  "C:\\a"                -> prefix "C:"               absolute rest "a"
//   win32  "C:a"                  -> prefix "C:"      relative rest "a"
//   win32  "\\a"                  -> prefix ""                 absolute rest "a"
//   win32  "\\\\srv\\shr\\a"      -> prefix "\\\\srv\\shr"     absolute rest "a"
//   win32  "\\\\?\\a"             -> prefix "\\\\?"            absolute rest "a"
// ---------------------------------------------------------------------------

class PathRoot {
  prefix: string;
  absolute: boolean;
  rest: string;

  constructor(prefix: string, absolute: boolean, rest: string) {
    this.prefix = prefix;
    this.absolute = absolute;
    this.rest = rest;
  }
}

function parseRootPosix(path: string): PathRoot {
  if (isPosixSep(cc(path, 0))) return new PathRoot("", true, path.slice(1));
  return new PathRoot("", false, path);
}

function parseRootWin32(path: string): PathRoot {
  const n = slen(path);
  const first = cc(path, 0);

  if (n >= 2 && isWin32Sep(first) && isWin32Sep(cc(path, 1))) {
    const third = cc(path, 2);
    // `\\?\` and `\\.\` device namespaces.
    if ((third === CODE_QUESTION || third === CODE_DOT) && isWin32Sep(cc(path, 3))) {
      const marker = third === CODE_QUESTION ? "?" : ".";
      return new PathRoot("\\\\" + marker, true, path.slice(4));
    }
    // UNC: `\\server\share\...`. The server and the share are whatever the
    // first two components are, even when a component is `..`.
    let i = 2;
    while (i < n && !isWin32Sep(cc(path, i))) i++;
    const server = path.slice(2, i);
    if (server.length === 0) {
      // Three or more leading separators: not UNC, just a rooted path.
      let j = 0;
      while (j < n && isWin32Sep(cc(path, j))) j++;
      return new PathRoot("", true, path.slice(j));
    }
    while (i < n && isWin32Sep(cc(path, i))) i++;
    const shareStart = i;
    while (i < n && !isWin32Sep(cc(path, i))) i++;
    const share = path.slice(shareStart, i);
    if (share.length === 0) {
      return new PathRoot("\\\\" + server, true, "");
    }
    while (i < n && isWin32Sep(cc(path, i))) i++;
    return new PathRoot("\\\\" + server + "\\" + share, true, path.slice(i));
  }

  if (isDriveLetter(first) && cc(path, 1) === CODE_COLON) {
    const drive = path.slice(0, 2);
    if (isWin32Sep(cc(path, 2))) {
      let i = 2;
      while (i < n && isWin32Sep(cc(path, i))) i++;
      return new PathRoot(drive, true, path.slice(i));
    }
    return new PathRoot(drive, false, path.slice(2));
  }

  if (isWin32Sep(first)) {
    let i = 0;
    while (i < n && isWin32Sep(cc(path, i))) i++;
    return new PathRoot("", true, path.slice(i));
  }

  return new PathRoot("", false, path);
}

function parseRoot(path: string, win: boolean): PathRoot {
  return win ? parseRootWin32(path) : parseRootPosix(path);
}

// ---------------------------------------------------------------------------
// Segment normalization
// ---------------------------------------------------------------------------

// Split on separators, then resolve `.` and `..`. A `..` that would climb past
// the start is dropped when the path is rooted and kept otherwise.
function normalizeSegments(
  rest: string,
  absolute: boolean,
  win: boolean,
): string[] {
  const out: string[] = [];
  const n = slen(rest);
  let start = 0;
  for (let i = 0; i <= n; i++) {
    if (i === n || isSep(cc(rest, i), win)) {
      if (i > start) {
        const segment = rest.slice(start, i);
        if (segment === ".") {
          // current directory: drop
        } else if (segment === "..") {
          const tail = last(out);
          if (alen(out) > 0 && tail !== "..") out.pop();
          else if (!absolute) out.push("..");
        } else {
          out.push(segment);
        }
      }
      start = i + 1;
    }
  }
  return out;
}

function hasTrailingSep(path: string, win: boolean): boolean {
  const n = slen(path);
  return n > 0 && isSep(cc(path, n - 1), win);
}

// ---------------------------------------------------------------------------
// Windows safety passes
// ---------------------------------------------------------------------------

// A relative result whose first segment would be read as a root (a drive
// specifier, or the `?`/`??` device escapes) is prefixed with `.\` so that path
// traversal cannot change the root. Refs CVE-2024-36139.
function looksLikeRoot(segment: string): boolean {
  if (segment === "?" || segment === "??") return true;
  return isDriveLetter(cc(segment, 0)) && cc(segment, 1) === CODE_COLON;
}

// The reserved DOS device names. A first component naming one of these followed
// by a colon is neutralized (`CON:` becomes `.\CON:`), because Windows would
// otherwise open the device rather than a file.
const RESERVED_DEVICE_NAMES: string[] = [
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "COM\u00b9",
  "COM\u00b2",
  "COM\u00b3",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
  "LPT\u00b9",
  "LPT\u00b2",
  "LPT\u00b3",
];

function isReservedDeviceName(name: string): boolean {
  const upper = name.toUpperCase();
  for (const reserved of RESERVED_DEVICE_NAMES) {
    if (upper === reserved.toUpperCase()) return true;
  }
  return false;
}

// `CON:rest` splits into the device name and whatever follows the colon.
function deviceNameLength(path: string): number {
  const n = slen(path);
  let i = 0;
  while (i < n && cc(path, i) !== CODE_COLON && !isWin32Sep(cc(path, i))) i++;
  if (i >= n || cc(path, i) !== CODE_COLON) return -1;
  if (!isReservedDeviceName(path.slice(0, i))) return -1;
  return i;
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

function normalizeImpl(path: string, win: boolean): string {
  validateString(path, "path");
  if (slen(path) === 0) return ".";

  const sep = win ? "\\" : "/";
  const root = parseRoot(path, win);

  // Windows reserved device names: keep the `NAME:` head verbatim, normalize
  // what follows it as a relative path, and mark the whole thing relative with
  // a leading `.\` so it cannot be read as a device.
  if (win && root.prefix.length === 0 && !root.absolute) {
    const deviceLen = deviceNameLength(path);
    if (deviceLen >= 0) {
      const head = path.slice(0, deviceLen + 1); // includes the colon
      const tail = path.slice(deviceLen + 1);
      const segments = normalizeSegments(tail, false, true);
      let body = segments.join("\\");
      if (body.length === 0 && slen(tail) > 0 && !hasTrailingSep(tail, true)) {
        body = ".";
      }
      if (slen(tail) === 0) body = ".";
      if (hasTrailingSep(tail, true) && slen(tail) > 0) body = body + "\\";
      return ".\\" + head + body;
    }
  }

  const segments = normalizeSegments(root.rest, root.absolute, win);
  const trailing = hasTrailingSep(path, win) && alen(segments) > 0;

  // `test/../C:/Windows` must not normalize to a drive-rooted path.
  if (
    win &&
    !root.absolute &&
    root.prefix.length === 0 &&
    alen(segments) > 0 &&
    looksLikeRoot(segments[0]) &&
    !looksLikeRoot(path.slice(0, slen(path) < 2 ? slen(path) : 2))
  ) {
    const body = segments.join(sep);
    return ".\\" + body + (trailing ? sep : "");
  }

  let body = segments.join(sep);
  if (trailing) body = body + sep;

  if (root.absolute) {
    if (body.length === 0) return root.prefix + sep;
    return root.prefix + sep + body;
  }
  if (root.prefix.length > 0) {
    // Drive-relative: `C:` with nothing left is `C:.`
    if (body.length === 0) return root.prefix + ".";
    return root.prefix + body;
  }
  if (body.length === 0) return hasTrailingSep(path, win) ? "." + sep : ".";
  return body;
}

// ---------------------------------------------------------------------------
// isAbsolute
// ---------------------------------------------------------------------------

function isAbsoluteImpl(path: string, win: boolean): boolean {
  validateString(path, "path");
  if (slen(path) === 0) return false;
  if (!win) return isPosixSep(cc(path, 0));
  if (isWin32Sep(cc(path, 0))) return true;
  if (isDriveLetter(cc(path, 0)) && cc(path, 1) === CODE_COLON) {
    return isWin32Sep(cc(path, 2));
  }
  return false;
}

// ---------------------------------------------------------------------------
// join
// ---------------------------------------------------------------------------

function joinPosix(parts: any[]): string {
  const n = alen(parts);
  if (n === 0) return ".";
  let joined = "";
  for (let i = 0; i < n; i++) {
    const part = parts[i];
    validateString(part, "path");
    if (slen(part) > 0) {
      joined = joined.length === 0 ? part : joined + "/" + part;
    }
  }
  if (joined.length === 0) return ".";
  return normalizeImpl(joined, false);
}

function joinWin32(parts: any[]): string {
  const n = alen(parts);
  if (n === 0) return ".";
  let joined = "";
  let firstPart = "";
  for (let i = 0; i < n; i++) {
    const part = parts[i];
    validateString(part, "path");
    if (slen(part) > 0) {
      if (joined.length === 0) {
        joined = part;
        firstPart = part;
      } else {
        joined = joined + "\\" + part;
      }
    }
  }
  if (joined.length === 0) return ".";

  // Joining must not invent a UNC path: `join("\\", "foo")` is `\foo`, not
  // `\\foo`. Two or more leading separators collapse to one unless the first
  // argument was itself a UNC path.
  let needsReplace = true;
  let slashCount = 0;
  if (isWin32Sep(cc(firstPart, 0))) {
    slashCount++;
    const firstLen = slen(firstPart);
    if (firstLen > 1 && isWin32Sep(cc(firstPart, 1))) {
      slashCount++;
      if (firstLen > 2) {
        if (isWin32Sep(cc(firstPart, 2))) slashCount++;
        else needsReplace = false; // a real UNC path in the first argument
      }
    }
  }
  if (needsReplace) {
    const joinedLen = slen(joined);
    while (slashCount < joinedLen && isWin32Sep(cc(joined, slashCount))) {
      slashCount++;
    }
    if (slashCount >= 2) joined = "\\" + joined.slice(slashCount);
  }
  return normalizeImpl(joined, true);
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

function resolvePosix(parts: any[]): string {
  let resolved = "";
  let absolute = false;
  for (let i = alen(parts) - 1; i >= 0 && !absolute; i--) {
    const part = parts[i];
    validateString(part, "paths[" + i + "]");
    if (slen(part) === 0) continue;
    resolved = part + "/" + resolved;
    absolute = isPosixSep(cc(part, 0));
  }
  if (!absolute) {
    const cwd = processCwdPosix();
    resolved = cwd + "/" + resolved;
    absolute = isPosixSep(cc(cwd, 0));
  }
  const segments = normalizeSegments(resolved, absolute, false);
  const body = segments.join("/");
  if (absolute) return "/" + body;
  return body.length > 0 ? body : ".";
}

// The per-drive current directory Windows keeps for each drive letter, falling
// back to the drive root.
function driveCwd(drive: string): string {
  const fromEnv = processEnvGet("=" + drive);
  if (typeof fromEnv === "string" && slen(fromEnv) > 0) {
    const head = fromEnv.slice(0, 2).toLowerCase();
    if (head === drive.toLowerCase()) return fromEnv;
  }
  const cwd = processCwdWin32();
  if (cwd.slice(0, 2).toLowerCase() === drive.toLowerCase()) return cwd;
  return drive + "\\";
}

function resolveWin32(parts: any[]): string {
  let resolvedDevice = "";
  let resolvedTail = "";
  let absolute = false;

  for (let i = alen(parts) - 1; i >= -1; i--) {
    let path = "";
    if (i >= 0) {
      const part = parts[i];
      validateString(part, "paths[" + i + "]");
      if (slen(part) === 0) continue;
      path = part;
    } else if (resolvedDevice.length === 0) {
      path = processCwdWin32();
    } else {
      path = driveCwd(resolvedDevice);
    }

    const root = parseRootWin32(path);
    const device = root.prefix;
    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
      } else {
        resolvedDevice = device;
      }
    }

    if (absolute) {
      if (resolvedDevice.length > 0) break;
    } else {
      resolvedTail = root.rest + "\\" + resolvedTail;
      absolute = root.absolute;
      if (absolute && resolvedDevice.length > 0) break;
    }
  }

  const segments = normalizeSegments(resolvedTail, absolute, true);
  const body = segments.join("\\");
  if (absolute) return resolvedDevice + "\\" + body;
  const relative = resolvedDevice + body;
  return relative.length > 0 ? relative : ".";
}

// ---------------------------------------------------------------------------
// relative
//
// The scanning algorithms from here through `format` follow Node.js
// `lib/path.js` (MIT, Copyright Joyent, Inc. and other Node contributors),
// because their observable edge cases (`dirname("//a") === "//"`,
// `extname("...") === "."`, UNC-aware `relative`) are defined by that code and
// pinned by Node's tests.
// ---------------------------------------------------------------------------

function relativePosix(from: any, to: any): string {
  validateString(from, "from");
  validateString(to, "to");
  if (from === to) return "";

  const fromPath = resolvePosix([from]);
  const toPath = resolvePosix([to]);
  if (fromPath === toPath) return "";

  const fromStart = 1;
  const fromEnd = slen(fromPath);
  const fromLen = fromEnd - fromStart;
  const toStart = 1;
  const toLen = slen(toPath) - toStart;

  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = cc(fromPath, fromStart + i);
    if (fromCode !== cc(toPath, toStart + i)) break;
    else if (fromCode === CODE_SLASH) lastCommonSep = i;
  }
  if (i === length) {
    if (toLen > length) {
      if (cc(toPath, toStart + i) === CODE_SLASH) {
        // `from` is the exact base path of `to`: '/foo/bar' -> '/foo/bar/baz'
        return toPath.slice(toStart + i + 1);
      }
      if (i === 0) {
        // `from` is the root: '/' -> '/foo'
        return toPath.slice(toStart + i);
      }
    } else if (fromLen > length) {
      if (cc(fromPath, fromStart + i) === CODE_SLASH) {
        // `to` is the exact base path of `from`: '/foo/bar/baz' -> '/foo/bar'
        lastCommonSep = i;
      } else if (i === 0) {
        // `to` is the root: '/foo' -> '/'
        lastCommonSep = 0;
      }
    }
  }

  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; i++) {
    if (i === fromEnd || cc(fromPath, i) === CODE_SLASH) {
      out = out + (out.length === 0 ? ".." : "/..");
    }
  }
  return out + toPath.slice(toStart + lastCommonSep);
}

function relativeWin32(from: any, to: any): string {
  validateString(from, "from");
  validateString(to, "to");
  if (from === to) return "";

  const fromOrig = resolveWin32([from]);
  const toOrig = resolveWin32([to]);
  if (fromOrig === toOrig) return "";

  const fromLower = fromOrig.toLowerCase();
  const toLower = toOrig.toLowerCase();
  if (fromLower === toLower) return "";

  // Lower-casing changed the length (non-ASCII case mapping), so offsets into the
  // lowered strings no longer line up with the originals: compare by component.
  if (slen(fromOrig) !== slen(fromLower) || slen(toOrig) !== slen(toLower)) {
    const fromSplit = fromOrig.split("\\");
    const toSplit = toOrig.split("\\");
    if (last(fromSplit) === "") fromSplit.pop();
    if (last(toSplit) === "") toSplit.pop();
    const fromCount = alen(fromSplit);
    const toCount = alen(toSplit);
    const shared = fromCount < toCount ? fromCount : toCount;
    let k = 0;
    for (; k < shared; k++) {
      if (fromSplit[k].toLowerCase() !== toSplit[k].toLowerCase()) break;
    }
    if (k === 0) return toOrig;
    if (k === shared) {
      if (toCount > shared) return toSplit.slice(k).join("\\");
      if (fromCount > shared) return "..\\".repeat(fromCount - 1 - k) + "..";
      return "";
    }
    return "..\\".repeat(fromCount - k) + toSplit.slice(k).join("\\");
  }

  // Trim leading and trailing backslashes.
  let fromStart = 0;
  while (fromStart < slen(fromLower) && cc(fromLower, fromStart) === CODE_BACKSLASH) {
    fromStart++;
  }
  let fromEnd = slen(fromLower);
  while (fromEnd - 1 > fromStart && cc(fromLower, fromEnd - 1) === CODE_BACKSLASH) {
    fromEnd--;
  }
  const fromLen = fromEnd - fromStart;

  let toStart = 0;
  while (toStart < slen(toLower) && cc(toLower, toStart) === CODE_BACKSLASH) {
    toStart++;
  }
  let toEnd = slen(toLower);
  while (toEnd - 1 > toStart && cc(toLower, toEnd - 1) === CODE_BACKSLASH) {
    toEnd--;
  }
  const toLen = toEnd - toStart;

  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = cc(fromLower, fromStart + i);
    if (fromCode !== cc(toLower, toStart + i)) break;
    else if (fromCode === CODE_BACKSLASH) lastCommonSep = i;
  }

  if (i !== length) {
    // Nothing in common, not even the drive: no relative path exists.
    if (lastCommonSep === -1) return toOrig;
  } else {
    if (toLen > length) {
      if (cc(toLower, toStart + i) === CODE_BACKSLASH) {
        // 'C:\\foo\\bar' -> 'C:\\foo\\bar\\baz'
        return toOrig.slice(toStart + i + 1);
      }
      if (i === 2) {
        // 'C:\\' -> 'C:\\foo'
        return toOrig.slice(toStart + i);
      }
    }
    if (fromLen > length) {
      if (cc(fromLower, fromStart + i) === CODE_BACKSLASH) {
        // 'C:\\foo\\bar' -> 'C:\\foo'
        lastCommonSep = i;
      } else if (i === 2) {
        // 'C:\\foo' -> 'C:\\'
        lastCommonSep = 3;
      }
    }
    if (lastCommonSep === -1) lastCommonSep = 0;
  }

  let out = "";
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; i++) {
    if (i === fromEnd || cc(fromLower, i) === CODE_BACKSLASH) {
      out = out + (out.length === 0 ? ".." : "\\..");
    }
  }

  toStart += lastCommonSep;
  if (out.length > 0) return out + toOrig.slice(toStart, toEnd);
  if (cc(toOrig, toStart) === CODE_BACKSLASH) toStart++;
  return toOrig.slice(toStart, toEnd);
}

function relativeImpl(from: any, to: any, win: boolean): string {
  return win ? relativeWin32(from, to) : relativePosix(from, to);
}

// ---------------------------------------------------------------------------
// dirname / basename / extname
// ---------------------------------------------------------------------------

function dirnamePosix(path: any): string {
  validateString(path, "path");
  const n = slen(path);
  if (n === 0) return ".";
  const hasRoot = cc(path, 0) === CODE_SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = n - 1; i >= 1; i--) {
    if (cc(path, i) === CODE_SLASH) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      // A non-separator: the next separator ends the dirname.
      matchedSlash = false;
    }
  }
  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  return path.slice(0, end);
}

// Length of the UNC root `\\server\share` (plus its separator) at the start of
// `path`, the whole length when the path is only a UNC root, or -1 when `path`
// does not start with one. Shared by dirname and parse.
function uncRootEnd(path: string, includeTrailing: boolean): number {
  const n = slen(path);
  let j = 2;
  let lastIndex = j;
  while (j < n && !isWin32Sep(cc(path, j))) j++;
  if (j < n && j !== lastIndex) {
    lastIndex = j;
    while (j < n && isWin32Sep(cc(path, j))) j++;
    if (j < n && j !== lastIndex) {
      lastIndex = j;
      while (j < n && !isWin32Sep(cc(path, j))) j++;
      if (j === n) return n;
      if (j !== lastIndex) return includeTrailing ? j + 1 : j;
    }
  }
  return -1;
}

function dirnameWin32(path: any): string {
  validateString(path, "path");
  const n = slen(path);
  if (n === 0) return ".";
  let rootEnd = -1;
  let offset = 0;
  const code = cc(path, 0);

  if (n === 1) {
    // `path` holds one character: a separator is its own root, else it is a
    // relative name.
    return isWin32Sep(code) ? path : ".";
  }

  if (isWin32Sep(code)) {
    rootEnd = 1;
    offset = 1;
    if (isWin32Sep(cc(path, 1))) {
      const unc = uncRootEnd(path, true);
      if (unc === n) return path; // only a UNC root
      if (unc > 0) {
        rootEnd = unc;
        offset = unc;
      }
    }
  } else if (isDriveLetter(code) && cc(path, 1) === CODE_COLON) {
    rootEnd = n > 2 && isWin32Sep(cc(path, 2)) ? 3 : 2;
    offset = rootEnd;
  }

  let end = -1;
  let matchedSlash = true;
  for (let i = n - 1; i >= offset; i--) {
    if (isWin32Sep(cc(path, i))) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }

  if (end === -1) {
    if (rootEnd === -1) return ".";
    end = rootEnd;
  }
  return path.slice(0, end);
}

function dirnameImpl(path: any, win: boolean): string {
  return win ? dirnameWin32(path) : dirnamePosix(path);
}

function basenameImpl(path: any, suffix: any, win: boolean): string {
  validateString(path, "path");
  if (suffix !== undefined) validateString(suffix, "suffix");
  const n = slen(path);
  let start = 0;
  let end = -1;
  let matchedSlash = true;

  // A drive specifier is never part of the base name; any other root is just
  // separators, which the scan already skips.
  if (win && n >= 2 && isDriveLetter(cc(path, 0)) && cc(path, 1) === CODE_COLON) {
    start = 2;
  }
  const floor = start;

  if (suffix !== undefined && slen(suffix) > 0 && slen(suffix) <= n) {
    if (suffix === path) return "";
    let extIdx = slen(suffix) - 1;
    let firstNonSlashEnd = -1;
    for (let i = n - 1; i >= floor; i--) {
      const code = cc(path, i);
      if (isSep(code, win)) {
        // A separator after something else ends the base name.
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          // The first non-separator: the base name ends here unless the suffix
          // match moves it.
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          // Match the suffix backwards, character by character.
          if (code === cc(suffix, extIdx)) {
            extIdx--;
            if (extIdx === -1) end = i;
          } else {
            // A mismatch: the suffix does not apply.
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = n;
    return path.slice(start, end);
  }

  for (let i = n - 1; i >= floor; i--) {
    if (isSep(cc(path, i), win)) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }
  if (end === -1) return "";
  return path.slice(start, end);
}

function extnameImpl(path: any, win: boolean): string {
  validateString(path, "path");
  const n = slen(path);
  let start = 0;
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // How the characters before the first dot look: 0 = nothing seen,
  // 1 = only dots, -1 = something else.
  let preDotState = 0;

  if (win && n >= 2 && cc(path, 1) === CODE_COLON && isDriveLetter(cc(path, 0))) {
    start = 2;
    startPart = 2;
  }

  for (let i = n - 1; i >= start; i--) {
    const code = cc(path, i);
    if (isSep(code, win)) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CODE_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }

  if (
    startDot === -1 ||
    end === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return "";
  }
  return path.slice(startDot, end);
}

// ---------------------------------------------------------------------------
// parse / format
// ---------------------------------------------------------------------------

function fillNameAndExt(
  result: any,
  path: string,
  startPart: number,
  startDot: number,
  end: number,
  preDotState: number,
  nameStart: number,
): void {
  if (end === -1) return;
  if (
    startDot === -1 ||
    preDotState === 0 ||
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    result.base = path.slice(nameStart, end);
    result.name = result.base;
  } else {
    result.name = path.slice(nameStart, startDot);
    result.base = path.slice(nameStart, end);
    result.ext = path.slice(startDot, end);
  }
}

function parsePosix(path: any): any {
  validateString(path, "path");
  const result: any = { root: "", dir: "", base: "", ext: "", name: "" };
  const n = slen(path);
  if (n === 0) return result;

  const isAbsolute = cc(path, 0) === CODE_SLASH;
  let start = 0;
  if (isAbsolute) {
    result.root = "/";
    start = 1;
  }
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;

  for (let i = n - 1; i >= start; i--) {
    const code = cc(path, i);
    if (code === CODE_SLASH) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CODE_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }

  const nameStart = startPart === 0 && isAbsolute ? 1 : startPart;
  fillNameAndExt(result, path, startPart, startDot, end, preDotState, nameStart);

  if (startPart > 0) result.dir = path.slice(0, startPart - 1);
  else if (isAbsolute) result.dir = "/";
  return result;
}

function parseWin32(path: any): any {
  validateString(path, "path");
  const result: any = { root: "", dir: "", base: "", ext: "", name: "" };
  const n = slen(path);
  if (n === 0) return result;

  let rootEnd = 0;
  const first = cc(path, 0);

  if (n === 1) {
    if (isWin32Sep(first)) {
      result.root = path;
      result.dir = path;
      return result;
    }
    result.base = path;
    result.name = path;
    return result;
  }

  if (isWin32Sep(first)) {
    rootEnd = 1;
    if (isWin32Sep(cc(path, 1))) {
      const unc = uncRootEnd(path, true);
      if (unc > 0) rootEnd = unc;
    }
  } else if (isDriveLetter(first) && cc(path, 1) === CODE_COLON) {
    if (n <= 2) {
      result.root = path;
      result.dir = path;
      return result;
    }
    rootEnd = 2;
    if (isWin32Sep(cc(path, 2))) {
      if (n === 3) {
        result.root = path;
        result.dir = path;
        return result;
      }
      rootEnd = 3;
    }
  }
  if (rootEnd > 0) result.root = path.slice(0, rootEnd);

  let startDot = -1;
  let startPart = rootEnd;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;

  for (let i = n - 1; i >= rootEnd; i--) {
    const code = cc(path, i);
    if (isWin32Sep(code)) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === CODE_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }

  fillNameAndExt(result, path, startPart, startDot, end, preDotState, startPart);

  if (startPart > 0 && startPart !== rootEnd) result.dir = path.slice(0, startPart - 1);
  else result.dir = result.root;
  return result;
}

function parseImpl(path: any, win: boolean): any {
  return win ? parseWin32(path) : parsePosix(path);
}

function formatExt(ext: any): string {
  if (!ext) return "";
  const text = String(ext);
  return cc(text, 0) === CODE_DOT ? text : "." + text;
}

function formatImpl(parsed: any, win: boolean): string {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error: any = new TypeError(
      'The "pathObject" argument must be of type object.' +
        describeReceived(parsed),
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  const sep = win ? "\\" : "/";
  const dir: any = parsed.dir || parsed.root;
  const base: any =
    parsed.base || String(parsed.name || "") + formatExt(parsed.ext);
  if (!dir) return String(base);
  return dir === parsed.root
    ? String(dir) + String(base)
    : String(dir) + sep + String(base);
}

// ---------------------------------------------------------------------------
// toNamespacedPath
// ---------------------------------------------------------------------------

function toNamespacedPathWin32(path: any): any {
  if (typeof path !== "string" || slen(path) === 0) return path;
  const resolved = resolveWin32([path]);
  if (slen(resolved) <= 2) return path;

  if (cc(resolved, 0) === CODE_BACKSLASH) {
    if (cc(resolved, 1) === CODE_BACKSLASH) {
      const third = cc(resolved, 2);
      if (third !== CODE_QUESTION && third !== CODE_DOT) {
        // A UNC path becomes `\\?\UNC\server\share\...`
        return "\\\\?\\UNC\\" + resolved.slice(2);
      }
      // Already device-namespaced: hand back the normalized form.
      return resolved;
    }
  } else if (
    isDriveLetter(cc(resolved, 0)) &&
    cc(resolved, 1) === CODE_COLON &&
    cc(resolved, 2) === CODE_BACKSLASH
  ) {
    return "\\\\?\\" + resolved;
  }
  return path;
}

// ---------------------------------------------------------------------------
// matchesGlob
// ---------------------------------------------------------------------------

function escapeRegExpChar(ch: string): string {
  const code = cc(ch, 0);
  const isWord =
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95;
  return isWord ? ch : "\\" + ch;
}

// Translate a glob into a regular-expression source matching one whole path.
// `**` crosses separators, `*` and `?` do not, `[...]` is a character class
// where a leading `!` or `^` negates.
function globToRegExpSource(glob: string): string {
  const n = slen(glob);
  let out = "";
  let i = 0;
  while (i < n) {
    const code = cc(glob, i);
    if (code === CODE_SLASH) {
      out = out + "/";
      i++;
    } else if (code === 42) {
      // '*'
      let stars = 0;
      while (i < n && cc(glob, i) === 42) {
        stars++;
        i++;
      }
      if (stars >= 2) {
        // `**` spans whole components; `foo/**` also matches `foo` itself.
        if (cc(glob, i) === CODE_SLASH) {
          out = out + "(?:.*/)?";
          i++;
        } else {
          out = out + ".*";
        }
      } else {
        out = out + "[^/]*";
      }
    } else if (code === CODE_QUESTION) {
      out = out + "[^/]";
      i++;
    } else if (code === 91) {
      // '['
      let j = i + 1;
      let negated = false;
      if (cc(glob, j) === 33 || cc(glob, j) === 94) {
        negated = true;
        j++;
      }
      let body = "";
      let closed = false;
      while (j < n) {
        const inner = cc(glob, j);
        if (inner === 93 && body.length > 0) {
          closed = true;
          break;
        }
        if (inner === 92) {
          body = body + "\\\\";
        } else if (inner === 93) {
          body = body + "\\]";
        } else if (inner === 45) {
          body = body + "-";
        } else if (inner === 94) {
          body = body + "\\^";
        } else {
          body = body + glob.slice(j, j + 1);
        }
        j++;
      }
      if (!closed) {
        // An unterminated class is a literal `[`.
        out = out + "\\[";
        i++;
      } else {
        out = out + "[" + (negated ? "^" : "") + body + "]";
        i = j + 1;
      }
    } else {
      out = out + escapeRegExpChar(glob.slice(i, i + 1));
      i++;
    }
  }
  return out;
}

function toSlashes(path: string): string {
  let out = "";
  const n = slen(path);
  for (let i = 0; i < n; i++) {
    out = out + (cc(path, i) === CODE_BACKSLASH ? "/" : path.slice(i, i + 1));
  }
  return out;
}

function matchesGlobImpl(path: any, glob: any, win: boolean): boolean {
  validateString(path, "path");
  validateString(glob, "pattern");
  const subject = win ? toSlashes(normalizeImpl(path, win)) : normalizeImpl(path, win);
  const pattern = win ? toSlashes(glob) : glob;
  // The RegExp is built and consumed here: a regex cannot travel through `any`
  // (https://github.com/UrubuCode/zun/issues/7).
  const matcher = new RegExp("^" + globToRegExpSource(pattern) + "$");
  return matcher.test(subject);
}

// ---------------------------------------------------------------------------
// The two namespaces
// ---------------------------------------------------------------------------

const posix: any = {
  sep: "/",
  delimiter: ":",

  normalize(path: any): string {
    return normalizeImpl(path, false);
  },
  isAbsolute(path: any): boolean {
    return isAbsoluteImpl(path, false);
  },
  join(...parts: any[]): string {
    return joinPosix(parts);
  },
  resolve(...parts: any[]): string {
    return resolvePosix(parts);
  },
  relative(from: any, to: any): string {
    return relativeImpl(from, to, false);
  },
  dirname(path: any): string {
    return dirnameImpl(path, false);
  },
  basename(path: any, suffix?: any): string {
    return basenameImpl(path, suffix, false);
  },
  extname(path: any): string {
    return extnameImpl(path, false);
  },
  parse(path: any): any {
    return parseImpl(path, false);
  },
  format(parsed: any): string {
    return formatImpl(parsed, false);
  },
  toNamespacedPath(path?: any): any {
    return path;
  },
  matchesGlob(path: any, glob: any): boolean {
    return matchesGlobImpl(path, glob, false);
  },
};

const win32: any = {
  sep: "\\",
  delimiter: ";",

  normalize(path: any): string {
    return normalizeImpl(path, true);
  },
  isAbsolute(path: any): boolean {
    return isAbsoluteImpl(path, true);
  },
  join(...parts: any[]): string {
    return joinWin32(parts);
  },
  resolve(...parts: any[]): string {
    return resolveWin32(parts);
  },
  relative(from: any, to: any): string {
    return relativeImpl(from, to, true);
  },
  dirname(path: any): string {
    return dirnameImpl(path, true);
  },
  basename(path: any, suffix?: any): string {
    return basenameImpl(path, suffix, true);
  },
  extname(path: any): string {
    return extnameImpl(path, true);
  },
  parse(path: any): any {
    return parseImpl(path, true);
  },
  format(parsed: any): string {
    return formatImpl(parsed, true);
  },
  toNamespacedPath(path?: any): any {
    return toNamespacedPathWin32(path);
  },
  matchesGlob(path: any, glob: any): boolean {
    return matchesGlobImpl(path, glob, true);
  },
};

posix.posix = posix;
posix.win32 = win32;
win32.posix = posix;
win32.win32 = win32;

// `path` is the namespace for the host platform, exactly as Node exposes it.
const path: any = pathPlatformIsWindows() ? win32 : posix;

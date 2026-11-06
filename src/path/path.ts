// node:path — the full POSIX and Windows path surface, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes 100%
// of Node's own `test/parallel/test-path*.js` files (see ../../test/path/).
// Root matching, normalize, join, resolve, the Windows hardening passes and the
// character-scanning routines for relative, dirname, basename, extname, parse
// and format all follow Node's `lib/path.js` (MIT, Copyright Joyent, Inc. and
// other Node contributors), because their observable edge cases — which colon
// makes a root, when a reserved device name suppresses normalization,
// `dirname("//a") === "//"`, `extname("...") === "."` — are defined by that
// code and pinned by those tests rather than by any general rule.
//
// Unlike `src/fs/` (a Rust `zun_abi` extension, because it needs syscalls), `path`
// is pure string computation, so it is written in the language the platform
// compiles. See ../../PLAN.md.
//
// Engine workarounds in this file, each tied to an open zun issue:
//   * `slen()` instead of `.length` — the engine has since widened the
//     *arithmetic*, so `len - 1` no longer underflows and the descending
//     `for (let i = len - 1; i >= 0; i--)` loop terminates, but the checker
//     still types `.length` as `u64`, so it can be neither assigned to nor
//     passed as a `number` (https://github.com/UrubuCode/zun/issues/3).
//   * `cc()` instead of `.charCodeAt()` — an out-of-range index throws instead of
//     returning NaN (https://github.com/UrubuCode/zun/issues/2).
//   * a RegExp is built and used inside one function, never passed through `any`
//     (https://github.com/UrubuCode/zun/issues/7).
//   * `indexOfChar()` — `indexOf` answers an i32 that cannot mix with Number
//     arithmetic (same family as issue #3).
//   * `truthy()` instead of `!value` / `Boolean(value)` on an `any` — the unary
//     negation of a boxed value reports the empty string as truthy, while `if`,
//     `?:` and `||` get it right (https://github.com/UrubuCode/zun/issues/13).
//     Beware of probing this one with `const x: any = ""`: that initializer is
//     constant-folded to a static string and `!x` then answers correctly. The
//     bug shows as soon as the value arrives from a property read, a parameter
//     or another `any` binding — which is every use site in this file.
//
// Security note: the `.\` prefix that keeps traversal from changing the root
// (CVE-2025-23084 — Node's comments call it CVE-2024-36139 — and the reserved
// device names of CVE-2025-27210) is applied by `normalize` and `join` only. As in
// Node, `resolve`, `relative`, `dirname`, `basename`, `extname`, `parse`,
// `isAbsolute` and `toNamespacedPath` are not guards; that is intended parity, not
// a bug to "fix".

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

// JavaScript truthiness of a value whose static type is `any`. Written as a
// conditional expression because `!value` and `Boolean(value)` mis-report a
// boxed empty string as truthy. See issue #13.
function truthy(value: any): boolean {
  return value ? true : false;
}

// `indexOf` answers an i32, which cannot mix with Number arithmetic. See issue #3.
function indexOfChar(value: string, needle: string, from: number): number {
  return Number(value.indexOf(needle, from));
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

// The ` Received ...` suffix of ERR_INVALID_ARG_TYPE, shared with every other
// module so the wording (util.inspect for strings, `an instance of <Ctor>`)
// cannot drift from Node's internal/errors.
function describeReceived(value: any): string {
  return __evReceived(value);
}

// `ERR_INVALID_ARG_TYPE` as Node raises it: a real `TypeError` (so
// `instanceof TypeError` holds and `name` is `"TypeError"`) carrying the Node
// error `code` as a **declared** field. `NodeTypeError` comes from
// ../events/events.ts, which the bundle places ahead of this file; the message
// text stays here because `describeReceived` is `path`'s own wording, pinned by
// its differential run against Node.
//
// The declared field is not decoration. The spelling this used before —
// `const e: any = new TypeError(msg); e.code = 'ERR_INVALID_ARG_TYPE';` — writes
// a key the class never declared onto a typed instance through an `any` alias,
// which poisons the instance: every later statically typed read of one of its
// own members, `e.name` included, throws `Cannot read private member from an
// object whose class did not declare it`
// (https://github.com/UrubuCode/zun/issues/37). `test-path.js` asserts
// `assert.throws(fn, { code: 'ERR_INVALID_ARG_TYPE', name: 'TypeError' })` for
// all 160 of its expectations, so it performs exactly that read.
function invalidArgType(name: string, value: any): any {
  return new NodeTypeError(
    "ERR_INVALID_ARG_TYPE",
    'The "' +
      name +
      '" argument must be of type string.' +
      describeReceived(value),
  );
}

function validateString(value: any, name: string): void {
  if (typeof value !== "string") throw invalidArgType(name, value);
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

// ---------------------------------------------------------------------------
// Windows safety passes
// ---------------------------------------------------------------------------

// The reserved DOS device names. A component naming one of these would make
// Windows open the device rather than a file, so normalize neutralizes a
// leading one with `.\` (`CON:` becomes `.\CON:.`) and join refuses to
// normalize a path that contains one at all.
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

// Whether what precedes `colonIndex` in `value` names a reserved device.
// `colonIndex` is the index of the first colon, so a path with no colon at all
// passes -1, and the check then runs on everything but the last character:
// that is what makes `COM9.` (a trailing dot Windows strips) reserved while
// `CON` and `CON.TXT` are not. The negative index is spelled out because it
// comes from `indexOf`, exactly as in Node's `lib/path.js`.
function isWindowsReservedName(value: string, colonIndex: number): boolean {
  const n = slen(value);
  let end = colonIndex < 0 ? n + colonIndex : colonIndex;
  if (end < 0) end = 0;
  if (end > n) end = n;
  const upper = value.slice(0, end).toUpperCase();
  for (const reserved of RESERVED_DEVICE_NAMES) {
    if (upper === reserved) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// normalize
// ---------------------------------------------------------------------------

function normalizePosix(path: string): string {
  const n = slen(path);
  if (n === 0) return ".";
  const absolute = isPosixSep(cc(path, 0));
  const trailing = isPosixSep(cc(path, n - 1));

  const body = normalizeSegments(path, absolute, false).join("/");
  if (body.length === 0) {
    if (absolute) return "/";
    return trailing ? "./" : ".";
  }
  const tail = trailing ? body + "/" : body;
  return absolute ? "/" + tail : tail;
}

// A port of Node's `win32.normalize`. The root match has to happen here rather
// than in a shared root matcher because normalize recognizes two roots resolve
// does not: a reserved device name used as a drive (`CON:`) and the same name
// inside the `\\?\` namespace (`\\?\COM1:`). The hardening at the end — the
// `.\` prefix for a relative result that could be read as a root or as a
// device — is CVE-2024-36139 and its follow-ups.
function normalizeWin32(path: string): string {
  const n = slen(path);
  if (n === 0) return ".";

  let rootEnd = 0;
  let device = "";
  let hasDevice = false;
  let absolute = false;
  const first = cc(path, 0);

  if (n === 1) {
    // One character: a forward slash becomes the root, anything else (a
    // backslash included) is returned as it stands.
    return isPosixSep(first) ? "\\" : path;
  }

  if (isWin32Sep(first)) {
    // A leading separator always means some kind of absolute path.
    absolute = true;
    if (isWin32Sep(cc(path, 1))) {
      // Two leading separators: a UNC or device root may follow.
      let j = 2;
      let anchor = j;
      while (j < n && !isWin32Sep(cc(path, j))) j++;
      if (j < n && j !== anchor) {
        const firstPart = path.slice(anchor, j);
        anchor = j;
        while (j < n && isWin32Sep(cc(path, j))) j++;
        if (j < n && j !== anchor) {
          anchor = j;
          while (j < n && !isWin32Sep(cc(path, j))) j++;
          if (j === n || j !== anchor) {
            if (firstPart === "." || firstPart === "?") {
              // A device namespace, e.g. `\\.\PHYSICALDRIVE0`.
              device = "\\\\" + firstPart;
              hasDevice = true;
              rootEnd = 4;
              const colonIndex = indexOfChar(path, ":", 0);
              // `\\?\COM1:` and friends: the reserved name belongs to the root.
              const possibleDevice = path.slice(4, colonIndex + 1);
              if (isWindowsReservedName(possibleDevice, slen(possibleDevice) - 1)) {
                device = "\\\\?\\" + possibleDevice;
                rootEnd = 4 + slen(possibleDevice);
              }
            } else if (j === n) {
              // A UNC root and nothing else: it is already normalized.
              return "\\\\" + firstPart + "\\" + path.slice(anchor) + "\\";
            } else {
              device = "\\\\" + firstPart + "\\" + path.slice(anchor, j);
              hasDevice = true;
              rootEnd = j;
            }
          }
        }
      }
    } else {
      rootEnd = 1;
    }
  } else {
    const colonIndex = indexOfChar(path, ":", 0);
    if (colonIndex > 0) {
      if (isDriveLetter(first) && colonIndex === 1) {
        device = path.slice(0, 2);
        hasDevice = true;
        rootEnd = 2;
        if (n > 2 && isWin32Sep(cc(path, 2))) {
          absolute = true;
          rootEnd = 3;
        }
      } else if (isWindowsReservedName(path, colonIndex)) {
        // A reserved device name stands in for a drive: `CON:a\..\b` keeps
        // `CON:` as its root, so `..` can never climb past it.
        device = path.slice(0, colonIndex + 1);
        hasDevice = true;
        rootEnd = colonIndex + 1;
      }
    }
  }

  let tail =
    rootEnd < n
      ? normalizeSegments(path.slice(rootEnd), absolute, true).join("\\")
      : "";
  if (slen(tail) === 0 && !absolute) tail = ".";
  if (slen(tail) > 0 && isWin32Sep(cc(path, n - 1))) tail = tail + "\\";

  if (!absolute && !hasDevice && indexOfChar(path, ":", 0) >= 0) {
    // The path was relative and no root was matched, so `tail` must not end up
    // looking absolute to Windows. See CVE-2024-36139.
    if (slen(tail) >= 2 && isDriveLetter(cc(tail, 0)) && cc(tail, 1) === CODE_COLON) {
      return ".\\" + tail;
    }
    // A colon that ends the path or precedes a separator would be read as a
    // drive or stream specifier.
    let index = indexOfChar(path, ":", 0);
    while (index !== -1) {
      if (index === n - 1 || isWin32Sep(cc(path, index + 1))) {
        return ".\\" + tail;
      }
      index = indexOfChar(path, ":", index + 1);
    }
  }

  // A path that starts with a reserved device name is marked relative, whatever
  // root was matched: `CON:` is `.\CON:.`, `\\?\COM1:...` keeps its namespace.
  if (isWindowsReservedName(path, indexOfChar(path, ":", 0))) {
    return ".\\" + device + tail;
  }
  if (!hasDevice) {
    return absolute ? "\\" + tail : tail;
  }
  return absolute ? device + "\\" + tail : device + tail;
}

function normalizeImpl(path: string, win: boolean): string {
  validateString(path, "path");
  return win ? normalizeWin32(path) : normalizePosix(path);
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

  // A reserved device name anywhere in the joined path suppresses
  // normalization: `join("\\server\\share", "COM1:")` keeps the `COM1:`
  // component and the `..` segments that follow it, so that normalize's `.\`
  // hardening cannot turn a share-relative path into a device path. Only
  // backslashes split components here, exactly as in Node's `lib/path.js`.
  const total = slen(joined);
  let component = "";
  let reserved = false;
  for (let i = 0; i < total && !reserved; i++) {
    if (cc(joined, i) === CODE_BACKSLASH) {
      reserved = isReservedComponent(component);
      component = "";
      while (i + 1 < total && cc(joined, i + 1) === CODE_BACKSLASH) i++;
    } else {
      component = component + joined.slice(i, i + 1);
    }
  }
  if (!reserved) reserved = isReservedComponent(component);
  // Only the separators are canonicalized.
  if (reserved) return toBackslashes(joined);

  return normalizeImpl(joined, true);
}

// One joined component names a reserved device when it holds a colon and what
// precedes the first colon is a reserved name.
function isReservedComponent(component: string): boolean {
  const colonIndex = indexOfChar(component, ":", 0);
  return colonIndex !== -1 && isWindowsReservedName(component, colonIndex);
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

// `resolve()`, `resolve("")` and `resolve(".")` are the current directory, and
// an absolute cwd is already its own answer — returned verbatim, so a cwd
// Node would not have produced is not silently rewritten.
function resolvesToCwd(parts: any[]): boolean {
  const n = alen(parts);
  if (n === 0) return true;
  if (n !== 1) return false;
  const only = parts[0];
  return only === "" || only === ".";
}

function resolvePosix(parts: any[]): string {
  if (resolvesToCwd(parts)) {
    const cwd = processCwdPosix();
    if (isPosixSep(cc(cwd, 0))) return cwd;
  }
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

// Windows keeps a current directory per drive letter, exported into the
// environment as `=C:`. With none recorded, the process cwd stands in, unless
// it names a different drive, in which case the drive's root does.
function driveCwd(drive: string): string {
  const fromEnv = processEnvGet("=" + drive);
  let path =
    typeof fromEnv === "string" && slen(fromEnv) > 0
      ? fromEnv
      : processCwdWin32();
  if (
    path.slice(0, 2).toLowerCase() !== drive.toLowerCase() &&
    cc(path, 2) === CODE_BACKSLASH
  ) {
    path = drive + "\\";
  }
  return path;
}

// `path.replace(/\//g, "\\")` without a RegExp. See issue #7.
function toBackslashes(path: string): string {
  let out = "";
  const n = slen(path);
  for (let i = 0; i < n; i++) {
    out = out + (cc(path, i) === CODE_SLASH ? "\\" : path.slice(i, i + 1));
  }
  return out;
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
      // A cwd that is already the answer is handed back untouched.
      if (
        alen(parts) === 0 ||
        (resolvesToCwd(parts) && isWin32Sep(cc(path, 0)))
      ) {
        return pathPlatformIsWindows() ? path : toBackslashes(path);
      }
    } else {
      // The device is known to be a drive, never a UNC share, because a UNC
      // path is always absolute and would have ended the loop already.
      path = driveCwd(resolvedDevice);
    }

    // Root matching. This is normalize's matcher minus the two roots only
    // normalize knows (a reserved device name, and one inside `\\?\`), because
    // resolve has to leave those in the tail for the `..` pass to see.
    const n = slen(path);
    let rootEnd = 0;
    let device = "";
    let pathAbsolute = false;
    const first = cc(path, 0);

    if (n === 1) {
      if (isWin32Sep(first)) {
        rootEnd = 1;
        pathAbsolute = true;
      }
    } else if (isWin32Sep(first)) {
      pathAbsolute = true;
      if (isWin32Sep(cc(path, 1))) {
        let j = 2;
        let anchor = j;
        while (j < n && !isWin32Sep(cc(path, j))) j++;
        if (j < n && j !== anchor) {
          const firstPart = path.slice(anchor, j);
          anchor = j;
          while (j < n && isWin32Sep(cc(path, j))) j++;
          if (j < n && j !== anchor) {
            anchor = j;
            while (j < n && !isWin32Sep(cc(path, j))) j++;
            if (j === n || j !== anchor) {
              if (firstPart !== "." && firstPart !== "?") {
                device = "\\\\" + firstPart + "\\" + path.slice(anchor, j);
                rootEnd = j;
              } else {
                // A device root, e.g. `\\.\PHYSICALDRIVE0`.
                device = "\\\\" + firstPart;
                rootEnd = 4;
              }
            }
          }
        }
        // `\\dir` (no share) matched nothing: the leading separators stay in
        // the tail, where the segment pass drops them.
      } else {
        rootEnd = 1;
      }
    } else if (isDriveLetter(first) && cc(path, 1) === CODE_COLON) {
      device = path.slice(0, 2);
      rootEnd = 2;
      if (n > 2 && isWin32Sep(cc(path, 2))) {
        // A separator after the drive makes the path absolute.
        pathAbsolute = true;
        rootEnd = 3;
      }
    }

    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        // Another device: this argument does not apply.
        if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
      } else {
        resolvedDevice = device;
      }
    }

    if (absolute) {
      if (resolvedDevice.length > 0) break;
    } else {
      resolvedTail = path.slice(rootEnd) + "\\" + resolvedTail;
      absolute = pathAbsolute;
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
  if (!truthy(ext)) return "";
  const text = String(ext);
  return cc(text, 0) === CODE_DOT ? text : "." + text;
}

function formatImpl(parsed: any, win: boolean): string {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new NodeTypeError(
      "ERR_INVALID_ARG_TYPE",
      'The "pathObject" argument must be of type object.' +
        describeReceived(parsed),
    );
  }
  const sep = win ? "\\" : "/";
  const dir: any = parsed.dir || parsed.root;
  const base: any =
    parsed.base || String(parsed.name || "") + formatExt(parsed.ext);
  if (!truthy(dir)) return String(base);
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

// `node:path` module object for the bundler's `require` rewriting.
const __node_path: any = path;

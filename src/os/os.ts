// node:os — the Node-shaped `os` module, in Zun TypeScript over the native
// `node:os` extension.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-os*.js` files (see ../../test/os/).
// The API shaping follows Node's `lib/os.js` (MIT, Copyright Joyent, Inc. and
// other Node contributors) — the flat-array-to-object reshaping of `cpus()`
// and `networkInterfaces()`, the `tmpdir()` environment rules, the
// `setPriority(priority)` one-argument form, the `Symbol.toPrimitive` on each
// getter and the `ObjectDefineProperties` block for `constants`/`EOL`/`devNull`
// — because those are observable through the corpus rather than derivable.
// `getCIDR` and `countBinaryOnes` follow Node's `lib/internal/util.js`.
//
// ---------------------------------------------------------------------------
// Why this module is split in two
// ---------------------------------------------------------------------------
//
// `os` is the first module here that is an extension *and* Zun TypeScript, and
// the line between them is PLAN.md principle 2 applied honestly:
//
//   * `src/os/mod.rs` answers what needs the kernel. Nothing else.
//   * this file is everything that is shape rather than syscall — the objects
//     and arrays, the `constants` tables, `EOL`, `devNull`, the argument
//     validation, the `ERR_*` errors, the environment rules of `tmpdir()`, the
//     CIDR arithmetic.
//
// Nothing structured can cross ABI v1, whose carrier is one scalar word. So the
// natives hand this file **status-prefixed, separator-delimited records** and
// this file parses them; the grammar is documented in `src/os/mod.rs` and is
// the mirror image of `__osRecords` below:
//
//     result  := "+" payload | "-"        payload := record (RS record)*
//     record  := field (US field)*        RS = U+001E     US = U+001F
//
// A leading "-" means the call failed, and the four error slots
// (`errorSyscall`, `errorCode`, `errorErrno`, `errorMessage`) then hold exactly
// what Node's `SystemError` reports — which is why a failed `os.getPriority()`
// here raises the same `ERR_SYSTEM_ERROR` it raises in Node, rather than a
// generic host error. The natives never fail through the ABI's own status,
// because a thrown extension error escapes `try`/`catch` in this engine
// (https://github.com/UrubuCode/zun/issues/33).
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `Number(x.length)` throughout: the *arithmetic* on `.length` was widened,
//     so `len - 1` and descending loops are correct now, but the checker still
//     types `.length` as `u64`, so it can be neither assigned to nor passed as
//     a `number` (zun#3).
//   * `charAt(i)` instead of `s[i]` in `__osGetCIDR`, and no `charCodeAt` past
//     the end (zun#2).
//   * the module's functions are **object-literal methods** delegating to
//     top-level `__os*` functions, because a bare function value does not
//     survive every path through `any` (zun#17), while a method does.
//   * the `Symbol.toPrimitive` block near the bottom is written exactly as
//     Node writes it and is still a **no-op in this engine**, though for only
//     one reason now rather than two: the symbol-keyed assignment onto a
//     function value *does* land (`fn[sym] = v; fn[sym] === v` holds), but
//     `${fn}` / `+fn` still ignore a function's own `Symbol.toPrimitive`,
//     `toString` and `valueOf` (https://github.com/UrubuCode/zun/issues/36).
//     It is kept because it is the correct code, it costs nothing, and
//     `${os.hostname}` starts working the day the engine threads ToPrimitive
//     through a function. See ../../test/os/README.md.
//
// One constraint this file was written around is gone: a `Map` keeps its
// methods through an `any` binding again (zun#7), so `Map`/`Set` are available
// here. The netmask-to-prefix lookup stays arithmetic rather than becoming the
// `Map` Node's own test writes, because the arithmetic is exact over all 33
// netmasks and a table would only re-state it; `events.ts`'s side tables, which
// genuinely needed identity keys, are `Map`s again.
//   * `userInfo({ encoding: 'buffer' })` cannot return a `Buffer`, because
//     `node:buffer` does not exist yet. It returns the byte view built by
//     `__osByteView` — the real UTF-8 bytes, indexable, with a working
//     `toString(encoding)` — and nothing pretends it is a `Buffer`.

import * as __osNative from "node:os";

// ---------------------------------------------------------------------------
// The native carrier: separators, decoding, and the error it raises
// ---------------------------------------------------------------------------

// Record and unit separators, and the "no login shell" marker — all C0 control
// characters, so none can occur in a payload. See src/os/mod.rs.
const __OS_RS: string = String.fromCharCode(30);
const __OS_US: string = String.fromCharCode(31);
const __OS_NO_SHELL: string = String.fromCharCode(29);
const __OS_FAILED: string = "-";

// `ERR_SYSTEM_ERROR` — Node's `SystemError`, whose message it composes from the
// libuv context rather than receiving pre-made. The four fields come from the
// extension's error slots.
// It extends `NodeError` from ../events/events.ts (the bundle places that file
// ahead of this one), so `code` is a declared field rather than an expando —
// see the note on those base classes and
// https://github.com/UrubuCode/zun/issues/37.
class ERR_SYSTEM_ERROR extends NodeError {
  errno: number = 0;
  syscall: string = "";
  info: any = undefined;
  constructor(syscall: string, errorCode: string, errno: number, description: string) {
    super(
      "ERR_SYSTEM_ERROR",
      "A system error occurred: " +
        syscall +
        " returned " +
        errorCode +
        " (" +
        description +
        ")",
    );
    this.errno = errno;
    this.syscall = syscall;
    this.info = {
      errno: errno,
      code: errorCode,
      message: description,
      syscall: syscall,
    };
  }
  get name(): string {
    return "SystemError";
  }
}

// Raise the failure the last native call left in the error slots.
function __osFail(): void {
  throw new ERR_SYSTEM_ERROR(
    __osNative.errorSyscall(),
    __osNative.errorCode(),
    Number(__osNative.errorErrno()),
    __osNative.errorMessage(),
  );
}

// A status-prefixed result as records of fields. An empty payload is an empty
// list, not a failure — that is the whole point of the prefix.
function __osRecords(raw: string): string[][] {
  if (raw === __OS_FAILED) __osFail();
  const payload: string = raw.slice(1);
  const out: string[][] = [];
  if (payload === "") return out;
  const records: string[] = payload.split(__OS_RS);
  const count = Number(records.length);
  for (let i = 0; i < count; i++) {
    out.push(records[i].split(__OS_US));
  }
  return out;
}

// A status-prefixed result known to carry exactly one record.
function __osFields(raw: string): string[] {
  if (raw === __OS_FAILED) __osFail();
  return raw.slice(1).split(__OS_US);
}

// A status-prefixed result known to carry exactly one field. Not split, so a
// payload is returned byte for byte.
function __osOne(raw: string): string {
  if (raw === __OS_FAILED) __osFail();
  return raw.slice(1);
}

// ---------------------------------------------------------------------------
// Argument validation (Node's internal/validators)
// ---------------------------------------------------------------------------

const __OS_INT32_MIN: number = -2147483648;
const __OS_INT32_MAX: number = 2147483647;

// `validateInt32(value, name, min, max)`. The three failure modes and their
// messages are Node's, and the corpus matches on them.
function __osValidateInt32(value: any, name: string, min: number, max: number): void {
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

// ---------------------------------------------------------------------------
// The facts read once at load
//
// `uname` cannot change while a process runs, so Node reads all four fields
// from a single `getOSInformation()` when the module is created and serves
// `type()`, `version()`, `release()` and `machine()` from that snapshot. Same
// here, from one native call.
// ---------------------------------------------------------------------------

const __osUname: string[] = __osFields(__osNative.osInfo());
const __osType: string = __osUname[0];
const __osVersion: string = __osUname[1];
const __osRelease: string = __osUname[2];
const __osMachine: string = __osUname[3];

const __osPlatform: string = __osNative.platform();
const __osArch: string = __osNative.arch();
const __osIsWindows: boolean = __osPlatform === "win32";
const __osEndianness: string = __osNative.isBigEndian() ? "BE" : "LE";

// ---------------------------------------------------------------------------
// os.constants
//
// These are the values Node reports *on each platform*, which is what makes
// them data rather than computation: `errno` and `signals` are the platform's
// own `<errno.h>`/`<signal.h>` numbers, `dlopen` the platform's `RTLD_*`
// (absent on Windows, which has no dlopen), and `priority` libuv's own nice
// scale, identical everywhere. Verified against `require('os').constants` on
// both platforms at Node v25 — and, on Linux, found byte-identical to v22, so
// the table is not version-sensitive.
// ---------------------------------------------------------------------------

const __osConstantsWin32: any = {
    UV_UDP_REUSEADDR: 4,
    dlopen: {},
    errno: {
      E2BIG: 7,
      EACCES: 13,
      EADDRINUSE: 100,
      EADDRNOTAVAIL: 101,
      EAFNOSUPPORT: 102,
      EAGAIN: 11,
      EALREADY: 103,
      EBADF: 9,
      EBADMSG: 104,
      EBUSY: 16,
      ECANCELED: 105,
      ECHILD: 10,
      ECONNABORTED: 106,
      ECONNREFUSED: 107,
      ECONNRESET: 108,
      EDEADLK: 36,
      EDESTADDRREQ: 109,
      EDOM: 33,
      EEXIST: 17,
      EFAULT: 14,
      EFBIG: 27,
      EHOSTUNREACH: 110,
      EIDRM: 111,
      EILSEQ: 42,
      EINPROGRESS: 112,
      EINTR: 4,
      EINVAL: 22,
      EIO: 5,
      EISCONN: 113,
      EISDIR: 21,
      ELOOP: 114,
      EMFILE: 24,
      EMLINK: 31,
      EMSGSIZE: 115,
      ENAMETOOLONG: 38,
      ENETDOWN: 116,
      ENETRESET: 117,
      ENETUNREACH: 118,
      ENFILE: 23,
      ENOBUFS: 119,
      ENODATA: 120,
      ENODEV: 19,
      ENOENT: 2,
      ENOEXEC: 8,
      ENOLCK: 39,
      ENOLINK: 121,
      ENOMEM: 12,
      ENOMSG: 122,
      ENOPROTOOPT: 123,
      ENOSPC: 28,
      ENOSR: 124,
      ENOSTR: 125,
      ENOSYS: 40,
      ENOTCONN: 126,
      ENOTDIR: 20,
      ENOTEMPTY: 41,
      ENOTSOCK: 128,
      ENOTSUP: 129,
      ENOTTY: 25,
      ENXIO: 6,
      EOPNOTSUPP: 130,
      EOVERFLOW: 132,
      EPERM: 1,
      EPIPE: 32,
      EPROTO: 134,
      EPROTONOSUPPORT: 135,
      EPROTOTYPE: 136,
      ERANGE: 34,
      EROFS: 30,
      ESPIPE: 29,
      ESRCH: 3,
      ETIME: 137,
      ETIMEDOUT: 138,
      ETXTBSY: 139,
      EWOULDBLOCK: 140,
      EXDEV: 18,
      WSAEINTR: 10004,
      WSAEBADF: 10009,
      WSAEACCES: 10013,
      WSAEFAULT: 10014,
      WSAEINVAL: 10022,
      WSAEMFILE: 10024,
      WSAEWOULDBLOCK: 10035,
      WSAEINPROGRESS: 10036,
      WSAEALREADY: 10037,
      WSAENOTSOCK: 10038,
      WSAEDESTADDRREQ: 10039,
      WSAEMSGSIZE: 10040,
      WSAEPROTOTYPE: 10041,
      WSAENOPROTOOPT: 10042,
      WSAEPROTONOSUPPORT: 10043,
      WSAESOCKTNOSUPPORT: 10044,
      WSAEOPNOTSUPP: 10045,
      WSAEPFNOSUPPORT: 10046,
      WSAEAFNOSUPPORT: 10047,
      WSAEADDRINUSE: 10048,
      WSAEADDRNOTAVAIL: 10049,
      WSAENETDOWN: 10050,
      WSAENETUNREACH: 10051,
      WSAENETRESET: 10052,
      WSAECONNABORTED: 10053,
      WSAECONNRESET: 10054,
      WSAENOBUFS: 10055,
      WSAEISCONN: 10056,
      WSAENOTCONN: 10057,
      WSAESHUTDOWN: 10058,
      WSAETOOMANYREFS: 10059,
      WSAETIMEDOUT: 10060,
      WSAECONNREFUSED: 10061,
      WSAELOOP: 10062,
      WSAENAMETOOLONG: 10063,
      WSAEHOSTDOWN: 10064,
      WSAEHOSTUNREACH: 10065,
      WSAENOTEMPTY: 10066,
      WSAEPROCLIM: 10067,
      WSAEUSERS: 10068,
      WSAEDQUOT: 10069,
      WSAESTALE: 10070,
      WSAEREMOTE: 10071,
      WSASYSNOTREADY: 10091,
      WSAVERNOTSUPPORTED: 10092,
      WSANOTINITIALISED: 10093,
      WSAEDISCON: 10101,
      WSAENOMORE: 10102,
      WSAECANCELLED: 10103,
      WSAEINVALIDPROCTABLE: 10104,
      WSAEINVALIDPROVIDER: 10105,
      WSAEPROVIDERFAILEDINIT: 10106,
      WSASYSCALLFAILURE: 10107,
      WSASERVICE_NOT_FOUND: 10108,
      WSATYPE_NOT_FOUND: 10109,
      WSA_E_NO_MORE: 10110,
      WSA_E_CANCELLED: 10111,
      WSAEREFUSED: 10112,
    },
    signals: {
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
    },
    priority: {
      PRIORITY_LOW: 19,
      PRIORITY_BELOW_NORMAL: 10,
      PRIORITY_NORMAL: 0,
      PRIORITY_ABOVE_NORMAL: -7,
      PRIORITY_HIGH: -14,
      PRIORITY_HIGHEST: -20,
    },
  };

const __osConstantsPosix: any = {
    UV_UDP_REUSEADDR: 4,
    dlopen: {
      RTLD_LAZY: 1,
      RTLD_NOW: 2,
      RTLD_GLOBAL: 256,
      RTLD_LOCAL: 0,
      RTLD_DEEPBIND: 8,
    },
    errno: {
      E2BIG: 7,
      EACCES: 13,
      EADDRINUSE: 98,
      EADDRNOTAVAIL: 99,
      EAFNOSUPPORT: 97,
      EAGAIN: 11,
      EALREADY: 114,
      EBADF: 9,
      EBADMSG: 74,
      EBUSY: 16,
      ECANCELED: 125,
      ECHILD: 10,
      ECONNABORTED: 103,
      ECONNREFUSED: 111,
      ECONNRESET: 104,
      EDEADLK: 35,
      EDESTADDRREQ: 89,
      EDOM: 33,
      EDQUOT: 122,
      EEXIST: 17,
      EFAULT: 14,
      EFBIG: 27,
      EHOSTUNREACH: 113,
      EIDRM: 43,
      EILSEQ: 84,
      EINPROGRESS: 115,
      EINTR: 4,
      EINVAL: 22,
      EIO: 5,
      EISCONN: 106,
      EISDIR: 21,
      ELOOP: 40,
      EMFILE: 24,
      EMLINK: 31,
      EMSGSIZE: 90,
      EMULTIHOP: 72,
      ENAMETOOLONG: 36,
      ENETDOWN: 100,
      ENETRESET: 102,
      ENETUNREACH: 101,
      ENFILE: 23,
      ENOBUFS: 105,
      ENODATA: 61,
      ENODEV: 19,
      ENOENT: 2,
      ENOEXEC: 8,
      ENOLCK: 37,
      ENOLINK: 67,
      ENOMEM: 12,
      ENOMSG: 42,
      ENOPROTOOPT: 92,
      ENOSPC: 28,
      ENOSR: 63,
      ENOSTR: 60,
      ENOSYS: 38,
      ENOTCONN: 107,
      ENOTDIR: 20,
      ENOTEMPTY: 39,
      ENOTSOCK: 88,
      ENOTSUP: 95,
      ENOTTY: 25,
      ENXIO: 6,
      EOPNOTSUPP: 95,
      EOVERFLOW: 75,
      EPERM: 1,
      EPIPE: 32,
      EPROTO: 71,
      EPROTONOSUPPORT: 93,
      EPROTOTYPE: 91,
      ERANGE: 34,
      EROFS: 30,
      ESPIPE: 29,
      ESRCH: 3,
      ESTALE: 116,
      ETIME: 62,
      ETIMEDOUT: 110,
      ETXTBSY: 26,
      EWOULDBLOCK: 11,
      EXDEV: 18,
    },
    signals: {
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
    },
    priority: {
      PRIORITY_LOW: 19,
      PRIORITY_BELOW_NORMAL: 10,
      PRIORITY_NORMAL: 0,
      PRIORITY_ABOVE_NORMAL: -7,
      PRIORITY_HIGH: -14,
      PRIORITY_HIGHEST: -20,
    },
  };

const __osConstants: any = __osIsWindows ? __osConstantsWin32 : __osConstantsPosix;

// ---------------------------------------------------------------------------
// CIDR suffixes (Node's internal/util getCIDR)
// ---------------------------------------------------------------------------

// Population count of a 32-bit word, in parallel rather than by looping, as
// Node's `countBinaryOnes` does.
function __osCountBinaryOnes(n: number): number {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// `${address}/${ones}`, or null when the netmask is not a run of ones followed
// by a run of zeros. The group radix and width differ between families: IPv4
// netmask groups are decimal octets, IPv6 groups hexadecimal 16-bit words.
function __osGetCIDR(address: string, netmask: string, family: string): any {
  let ones = 0;
  let separator: string = ".";
  let radix = 10;
  let groupLength = 8;
  let hasZeros = false;
  let lastPos = 0;

  if (family === "IPv6") {
    separator = ":";
    radix = 16;
    groupLength = 16;
  }

  const length = Number(netmask.length);
  for (let i = 0; i < length; i++) {
    if (netmask.charAt(i) !== separator) {
      if (i + 1 < length) {
        continue;
      }
      i++;
    }
    const part: string = netmask.slice(lastPos, i);
    lastPos = i + 1;
    if (part !== "") {
      if (hasZeros) {
        if (part !== "0") {
          return null;
        }
      } else {
        const binary = parseInt(part, radix);
        const binaryOnes = __osCountBinaryOnes(binary);
        ones += binaryOnes;
        if (binaryOnes !== groupLength) {
          if (binary.toString(2).includes("01")) {
            return null;
          }
          hasZeros = true;
        }
      }
    }
  }

  return address + "/" + String(ones);
}

// ---------------------------------------------------------------------------
// The byte view behind userInfo({ encoding: 'buffer' })
//
// Node returns `Buffer`s here. `node:buffer` does not exist yet (it is later in
// PLAN.md's order), so rather than fake one, this returns an honest byte
// container: the real UTF-8 bytes, readable by index, with `length`,
// `byteLength` and a `toString(encoding)` that decodes them. It is not a
// `Buffer`: there is no `instanceof Buffer`, no `Uint8Array` surface, and no
// `slice`/`write`. When `node:buffer` lands, this is the one function that
// changes.
// ---------------------------------------------------------------------------

// A string's UTF-8 bytes, surrogate pairs included.
function __osUtf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  const length = Number(text.length);
  let i = 0;
  while (i < length) {
    let code = text.charCodeAt(i);
    i++;
    // A high surrogate followed by a low surrogate is one code point.
    if (code >= 0xd800 && code <= 0xdbff && i < length) {
      const low = text.charCodeAt(i);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >>> 6));
      bytes.push(0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >>> 12));
      bytes.push(0x80 | ((code >>> 6) & 0x3f));
      bytes.push(0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >>> 18));
      bytes.push(0x80 | ((code >>> 12) & 0x3f));
      bytes.push(0x80 | ((code >>> 6) & 0x3f));
      bytes.push(0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

const __OS_BASE64: string =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const __OS_HEX: string = "0123456789abcdef";

function __osDecodeBytes(text: string, bytes: number[], encoding: any): string {
  const name: string = encoding === undefined || encoding === null ? "utf8" : String(encoding);
  if (name === "utf8" || name === "utf-8" || name === "buffer") {
    // The bytes were produced from `text`, so this is exact by construction.
    return text;
  }
  const count = Number(bytes.length);
  if (name === "hex") {
    let out = "";
    for (let i = 0; i < count; i++) {
      out += __OS_HEX.charAt((bytes[i] >>> 4) & 0xf) + __OS_HEX.charAt(bytes[i] & 0xf);
    }
    return out;
  }
  if (name === "latin1" || name === "binary") {
    let out = "";
    for (let i = 0; i < count; i++) out += String.fromCharCode(bytes[i]);
    return out;
  }
  if (name === "ascii") {
    let out = "";
    for (let i = 0; i < count; i++) out += String.fromCharCode(bytes[i] & 0x7f);
    return out;
  }
  if (name === "base64") {
    let out = "";
    let i = 0;
    while (i + 2 < count) {
      const word = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out +=
        __OS_BASE64.charAt((word >>> 18) & 0x3f) +
        __OS_BASE64.charAt((word >>> 12) & 0x3f) +
        __OS_BASE64.charAt((word >>> 6) & 0x3f) +
        __OS_BASE64.charAt(word & 0x3f);
      i += 3;
    }
    const left = count - i;
    if (left === 1) {
      const word = bytes[i] << 16;
      out +=
        __OS_BASE64.charAt((word >>> 18) & 0x3f) +
        __OS_BASE64.charAt((word >>> 12) & 0x3f) +
        "==";
    } else if (left === 2) {
      const word = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out +=
        __OS_BASE64.charAt((word >>> 18) & 0x3f) +
        __OS_BASE64.charAt((word >>> 12) & 0x3f) +
        __OS_BASE64.charAt((word >>> 6) & 0x3f) +
        "=";
    }
    return out;
  }
  throw new ERR_INVALID_ARG_VALUE("encoding", encoding, "is not a known encoding");
}

function __osByteView(text: string): any {
  const bytes: number[] = __osUtf8Bytes(text);
  const count = Number(bytes.length);
  const view: any = {
    length: count,
    byteLength: count,
    toString(encoding?: any): string {
      return __osDecodeBytes(text, bytes, encoding);
    },
  };
  for (let i = 0; i < count; i++) view[i] = bytes[i];
  return view;
}

// ---------------------------------------------------------------------------
// The functions
// ---------------------------------------------------------------------------

function __osHostname(): string {
  return __osOne(__osNative.hostname());
}

function __osHomedir(): string {
  return __osOne(__osNative.homedir());
}

function __osUptime(): number {
  return Number(__osOne(__osNative.uptime()));
}

function __osLoadavg(): number[] {
  const fields: string[] = __osFields(__osNative.loadavg());
  return [Number(fields[0]), Number(fields[1]), Number(fields[2])];
}

// One object per logical CPU, from the seven-field records the native builds in
// one syscall. Node assembles the same objects from a flat array of the same
// seven values per CPU.
function __osCpus(): any[] {
  const records: string[][] = __osRecords(__osNative.cpus());
  const out: any[] = [];
  const count = Number(records.length);
  for (let i = 0; i < count; i++) {
    const fields: string[] = records[i];
    out.push({
      model: fields[0],
      speed: Number(fields[1]),
      times: {
        user: Number(fields[2]),
        nice: Number(fields[3]),
        sys: Number(fields[4]),
        idle: Number(fields[5]),
        irq: Number(fields[6]),
      },
    });
  }
  return out;
}

// The interface records grouped by name, with the CIDR computed here and
// `scopeid` present only for IPv6 — the native's `-1` is Node's own "absent"
// sentinel.
function __osNetworkInterfaces(): any {
  const records: string[][] = __osRecords(__osNative.networkInterfaces());
  const result: any = {};
  const count = Number(records.length);
  for (let i = 0; i < count; i++) {
    const fields: string[] = records[i];
    const name: string = fields[0];
    const address: string = fields[1];
    const netmask: string = fields[2];
    const family: string = fields[3];
    const entry: any = {
      address: address,
      netmask: netmask,
      family: family,
      mac: fields[4],
      internal: fields[5] === "1",
      cidr: __osGetCIDR(address, netmask, family),
    };
    const scopeid = Number(fields[6]);
    if (scopeid !== -1) entry.scopeid = scopeid;

    const existing: any = result[name];
    if (existing !== undefined && existing !== null) {
      existing.push(entry);
    } else {
      result[name] = [entry];
    }
  }
  return result;
}

// `os.tmpdir()`. Entirely an environment rule, on both platforms, which is why
// it lives here and not in the native: it has to see `process.env` as the
// program sees it, including a variable the program has just changed.
//
// Windows: TEMP, then TMP, then `(SystemRoot || windir) + '\temp'`; one
// trailing backslash is dropped unless it is a drive root (`C:\`).
// POSIX: TMPDIR, then TMP, then TEMP, each only when non-empty, then `/tmp`;
// one trailing forward slash is dropped unless the path is just `/`.
function __osTmpdir(): string {
  if (__osIsWindows) {
    const path: string =
      process.env.TEMP ||
      process.env.TMP ||
      (process.env.SystemRoot || process.env.windir) + "\\temp";
    const length = Number(path.length);
    if (
      length > 1 &&
      path.charAt(length - 1) === "\\" &&
      path.charAt(length - 2) !== ":"
    ) {
      return path.slice(0, -1);
    }
    return path;
  }

  const found: any = process.env.TMPDIR || process.env.TMP || process.env.TEMP;
  if (found === undefined || found === null || found === "") return "/tmp";
  const path: string = String(found);
  const length = Number(path.length);
  if (length > 1 && path.charAt(length - 1) === "/") {
    return path.slice(0, -1);
  }
  return path;
}

// `os.setPriority([pid, ]priority)`.
function __osSetPriority(pid?: any, priority?: any): void {
  let resolvedPid: any = pid;
  let resolvedPriority: any = priority;
  if (resolvedPriority === undefined) {
    resolvedPriority = resolvedPid;
    resolvedPid = 0;
  }
  __osValidateInt32(resolvedPid, "pid", __OS_INT32_MIN, __OS_INT32_MAX);
  __osValidateInt32(resolvedPriority, "priority", -20, 19);
  const raw: string = __osNative.setPriority(resolvedPid, resolvedPriority);
  if (raw === __OS_FAILED) __osFail();
}

// `os.getPriority([pid])`. An absent pid means this process and is *not*
// validated, which is Node's own asymmetry.
function __osGetPriority(pid?: any): number {
  let resolved: any = pid;
  if (resolved === undefined) {
    resolved = 0;
  } else {
    __osValidateInt32(resolved, "pid", __OS_INT32_MIN, __OS_INT32_MAX);
  }
  return Number(__osOne(__osNative.getPriority(resolved)));
}

// `os.userInfo([options])`.
//
// `options.encoding` is read before the syscall, and deliberately so: Node's
// own test asserts that a throwing `encoding` getter propagates out of
// `userInfo` instead of crashing.
function __osUserInfo(options?: any): any {
  let resolved: any = options;
  if (typeof resolved !== "object") resolved = null;

  let encoding: any = undefined;
  if (resolved !== null && resolved !== undefined) {
    encoding = resolved.encoding;
  }

  const fields: string[] = __osFields(__osNative.userInfo());
  const uid = Number(fields[0]);
  const gid = Number(fields[1]);
  const username: string = fields[2];
  const homedir: string = fields[3];
  const rawShell: string = fields[4];
  // A platform with no login shell reports the marker; a passwd entry with a
  // blank shell field reports the empty string, and the two stay distinct.
  const shell: any = rawShell === __OS_NO_SHELL ? null : rawShell;

  if (encoding === "buffer") {
    return {
      uid: uid,
      gid: gid,
      username: __osByteView(username),
      homedir: __osByteView(homedir),
      shell: shell === null ? null : __osByteView(shell),
    };
  }

  return {
    uid: uid,
    gid: gid,
    username: username,
    homedir: homedir,
    shell: shell,
  };
}

// ---------------------------------------------------------------------------
// The module object
//
// Every entry is an object-literal method delegating to the `__os*` function
// above, rather than the bare function value Node exports: a method survives
// being read, destructured and called through an `any`, where a function value
// does not (zun#17).
// ---------------------------------------------------------------------------

const os: any = {
  arch(): string {
    return __osArch;
  },
  availableParallelism(): number {
    return Number(__osNative.availableParallelism());
  },
  cpus(): any[] {
    return __osCpus();
  },
  endianness(): string {
    return __osEndianness;
  },
  freemem(): number {
    return Number(__osNative.freemem());
  },
  getPriority(pid?: any): number {
    return __osGetPriority(pid);
  },
  homedir(): string {
    return __osHomedir();
  },
  hostname(): string {
    return __osHostname();
  },
  loadavg(): number[] {
    return __osLoadavg();
  },
  machine(): string {
    return __osMachine;
  },
  networkInterfaces(): any {
    return __osNetworkInterfaces();
  },
  platform(): string {
    return __osPlatform;
  },
  release(): string {
    return __osRelease;
  },
  setPriority(pid?: any, priority?: any): void {
    __osSetPriority(pid, priority);
  },
  tmpdir(): string {
    return __osTmpdir();
  },
  totalmem(): number {
    return Number(__osNative.totalmem());
  },
  type(): string {
    return __osType;
  },
  uptime(): number {
    return __osUptime();
  },
  userInfo(options?: any): any {
    return __osUserInfo(options);
  },
  version(): string {
    return __osVersion;
  },
};

// `constants`, `EOL` and `devNull` are data, not functions, and Node defines
// them with the attributes its own `test-os-eol.js` checks: `EOL` is
// non-writable but configurable, so assigning to it throws in strict mode while
// `Object.defineProperties` may still replace it; `constants` is not even
// configurable.
Object.defineProperties(os, {
  constants: {
    configurable: false,
    enumerable: true,
    value: __osConstants,
  },
  EOL: {
    configurable: true,
    enumerable: true,
    writable: false,
    value: __osIsWindows ? "\r\n" : "\n",
  },
  devNull: {
    configurable: true,
    enumerable: true,
    writable: false,
    value: __osIsWindows ? "\\\\.\\nul" : "/dev/null",
  },
});

// Node makes every zero-argument getter coercible, so `${os.hostname}` is
// `os.hostname()` and `+os.totalmem` is `os.totalmem()`. This is that code.
// It does nothing in this engine yet — a symbol-keyed assignment onto a
// function is dropped, and `${fn}` consults none of the function's own
// properties — and is kept because it is correct and free. See the header.
function __osInstallToPrimitive(target: any, produce: any): void {
  if (target === undefined || target === null) return;
  target[Symbol.toPrimitive] = produce;
}

__osInstallToPrimitive(os.arch, function (): string {
  return __osArch;
});
__osInstallToPrimitive(os.availableParallelism, function (): number {
  return Number(__osNative.availableParallelism());
});
__osInstallToPrimitive(os.endianness, function (): string {
  return __osEndianness;
});
__osInstallToPrimitive(os.freemem, function (): number {
  return Number(__osNative.freemem());
});
__osInstallToPrimitive(os.homedir, function (): string {
  return __osHomedir();
});
__osInstallToPrimitive(os.hostname, function (): string {
  return __osHostname();
});
__osInstallToPrimitive(os.machine, function (): string {
  return __osMachine;
});
__osInstallToPrimitive(os.platform, function (): string {
  return __osPlatform;
});
__osInstallToPrimitive(os.release, function (): string {
  return __osRelease;
});
__osInstallToPrimitive(os.tmpdir, function (): string {
  return __osTmpdir();
});
__osInstallToPrimitive(os.totalmem, function (): number {
  return Number(__osNative.totalmem());
});
__osInstallToPrimitive(os.type, function (): string {
  return __osType;
});
__osInstallToPrimitive(os.uptime, function (): number {
  return __osUptime();
});
__osInstallToPrimitive(os.version, function (): string {
  return __osVersion;
});

// `process.pid`, which is not part of Node's `os` surface at all.
//
// It is corrected from here because this is the only module in the library with
// a native that can answer it: `zun:core`'s host surface reports no pid, so
// `src/process/process.ts` — which has no extension of its own and must keep
// compiling without `--ext`, for the `path` and `events` bundles — falls back
// to a placeholder. Whenever `os` is loaded the real pid is available, and a
// wrong `process.pid` is not something to leave standing: Node's
// `test-os-process-priority.js` sets and reads the priority of
// `process.pid` itself. The line moves into `process` the moment `process` has
// a native of its own.
process.pid = Number(__osNative.pid());

// `node:os` module object for the bundler's `require` rewriting.
const __node_os: any = os;

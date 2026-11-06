// node:net — the Node-shaped `net` module, in Zun TypeScript over the shared
// asynchronous-I/O readiness loop.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-net-*.js` files (see ../../test/net/).
// The API shaping follows Node's `lib/net.js`, `lib/internal/net.js` and
// `lib/internal/blocklist.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors): the `connect` argument cascade and `_normalizeArgs`, the
// `listen` grammar, `readyState`, the `allowHalfOpen` rule, the
// `exceptionWithHostPort` message format and the `BlockList` rule set. None of
// that is derivable — it is observable through the corpus.
//
// ---------------------------------------------------------------------------
// Where this module is split, and why it is split there
// ---------------------------------------------------------------------------
//
// `net` is the first module in this library that needs *asynchronous* I/O, and
// the first thing it needed was therefore not `net` at all. The seam is in
// three layers rather than the usual two:
//
//   * `src/io/mod.rs` — the syscalls. A table of non-blocking handles, the
//     operations on one, and one `ioPoll(timeoutMs)` native that waits for any
//     of them to become ready. Nothing in it is `net`-shaped.
//   * `src/io/io.ts` — the loop. Which handle wants which event, which handles
//     keep the process alive (`ref`/`unref`), when to pump, and who to call.
//     Also nothing `net`-shaped: `dgram`, `child_process`' pipes, `fs`' streams
//     and `http` are meant to register with this same loop rather than start a
//     second one, and both files are written to be read that way.
//   * this file — `net`. `Socket` is a `stream.Duplex` whose `_read`, `_write`,
//     `_final` and `_destroy` are the loop's events; `Server` is an
//     `EventEmitter` over one listening handle; and the rest is shape:
//     `isIP`, `BlockList`, `SocketAddress`, the argument cascades, `readyState`
//     and Node's error messages.
//
// That is PLAN.md principle 2 applied twice, and the middle layer is the part
// worth keeping: it is the piece of infrastructure zun-node did not have.
//
// There is deliberately **no `src/net/*.rs`**. Every syscall `net` makes is one
// of the loop's eleven verbs, and putting a copy of them here under a second
// module key would be the duplication the loop exists to prevent — the Rust
// tests for them are `src/io/tests.rs`, thirteen of them, driving the module
// below the ABI. If `net` ever needs a syscall that is *its own* rather than
// the loop's, that is where it goes.
//
// ---------------------------------------------------------------------------
// What a readiness loop changes about Node's semantics
// ---------------------------------------------------------------------------
//
// libuv's model is *completion*: a read is submitted and a callback fires with
// the bytes. ABI v1 cannot express that (an extension has no way to complete a
// call later), so `src/io/` is a *readiness* loop instead: the loop learns that
// a socket has data and this file then reads it. The two models agree on
// everything the corpus observes but differ in one pleasant way — `pause()` is
// real here. A paused socket simply stops declaring read interest, so the peer's
// data stays in the kernel's receive buffer and the window closes; Node has to
// stop a read it already submitted. `test-net-pause-resume-*.js` sees the same
// events either way.
//
// Two differences are *not* pleasant and are documented at their use sites:
//
//   * **Name resolution blocks.** `ioLookup` is `getaddrinfo`, called
//     synchronously, with the answer delivered through `process.nextTick` — the
//     "synchronous natives, asynchronous API" pattern `src/dns/dns.ts`
//     documents. A `lookup` callback therefore still runs on a later tick than
//     its caller, and `options.lookup` is still honoured, but two concurrent
//     connects resolve one after the other.
//   * **No pipes.** A Unix domain socket / Windows named pipe handle is a
//     different kernel object with a different readiness story, and the loop
//     has only the TCP half today. `listen(path)` and `connect(path)` raise
//     `ERR_INVALID_ARG_VALUE`-shaped `ENOTSUP` rather than pretending; the
//     twenty-odd pipe files in the corpus are named in ../../test/net/README.md.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `Number(x.length)` throughout: `.length` is typed `u64` at the type
//     level, so it can be neither compared nor arithmetic'd as is (zun#3).
//   * `__netCc(s, i)` instead of `s.charCodeAt(i)` in the two address parsers:
//     `charCodeAt` past the end throws here instead of answering `NaN`
//     (zun#2).
//   * the stream hooks are installed with `__sSetOptFn` rather than by
//     assigning `this._read = …`: those names are *accessors* on `Duplex`, and
//     assigning to an accessor through an `any` receiver panics the
//     interpreter (see `src/zlib/zlib.ts`' header note).
//   * every handler the I/O loop receives is an **object with three methods**,
//     not three function values: an object-literal method survives every path
//     through an `any` while a bare function value does not (zun#17).
//   * a chunk that arrives from the stream machinery through an `any` is
//     re-typed into a declared `Buffer` local before anything is read off it
//     (zun#38), and `Buffer.from` of an `any` does not compile at all, so the
//     string case goes through a declared `string` local first (zun#58).
//   * the module object's functions are object-literal methods delegating to
//     top-level `__net*` functions (zun#17 again).
//   * `x ? true : false` rather than `!x` wherever `x` is an `any` that may be
//     the empty string (zun#13).
//   * the error classes declare `errno`/`syscall`/`address`/`port` as fields:
//     an undeclared key written onto a typed instance through an `any` alias
//     poisons every later typed read of that instance (zun#37).

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// `s.charCodeAt(i)`, which throws past the end of the string in this engine
// instead of answering `NaN` (zun#2). -1 is a code point no character has.
function __netCc(text: string, index: number): number {
  if (index < 0 || index >= Number(text.length)) return -1;
  return Number(text.charCodeAt(index));
}

// `process.nextTick`, through `src/process/process.ts`' FIFO — which is also
// what the harness watches to decide the loop has gone quiet.
function __netTick(fn: any, a?: any, b?: any): void {
  if (fn === undefined || fn === null) return;
  if (b !== undefined) {
    __processNextTick(fn, a, b);
  } else if (a !== undefined) {
    __processNextTick(fn, a);
  } else {
    __processNextTick(fn);
  }
}

// Invoke a callback that has no receiver of its own, unboxing it first: a
// callable that crossed the `any` lane arrives as a `functionBox` record
// (zun#17) which carries no `call` of its own.
function __netInvoke(fn: any, args: any[]): any {
  if (fn === undefined || fn === null) return undefined;
  return __evCall(fn, args);
}

function __netIsFn(value: any): boolean {
  return __evIsFn(value);
}

function __netIsObj(value: any): boolean {
  return value !== null && typeof value === "object";
}

// An options *object*, as opposed to a callback.
//
// `__netIsObj` is not enough on its own: a callable that crossed the `any` lane
// arrives as a `functionBox` record (zun#17), which **is** an object. So
// `server.listen(cb)` was read as `listen(options)` and rejected for having
// neither `port` nor `path`. Every argument cascade therefore asks this, which
// puts the function test first.
function __netIsOptionsObj(value: any): boolean {
  if (!__netIsObj(value)) return false;
  if (Array.isArray(value)) return false;
  return !__netIsFn(value);
}

// `value ? true : false`, never `!value`: `!x` on an `any` holding the empty
// string answers the wrong thing here (zun#13), and constant folding hides the
// gap unless the value arrives through a parameter -- which it does.
function __netTruthy(value: any): boolean {
  if (value === undefined || value === null) return false;
  return value ? true : false;
}

// A chunk as base64, accepting everything a write can deliver.
function __netToBase64(chunk: any, encoding: any): string {
  if (typeof chunk === "string") {
    // The local has a declared type because `Buffer.from` of an `any` does not
    // compile (zun#58).
    const text: string = chunk;
    let name: string = encoding === undefined || encoding === null ? "utf8" : String(encoding);
    if (name === "" || name === "buffer") name = "utf8";
    const bytes: Buffer = Buffer.from(text, name);
    return bytes.toString("base64");
  }
  // A byte view is opaque through `any` (zun#38), so it is re-typed first.
  const view: Buffer = chunk;
  return view.toString("base64");
}

// base64 back to the engine's prelude `Buffer`, which is what a `'data'`
// listener receives.
function __netFromBase64(text: any): Buffer {
  const encoded: string = String(text);
  return Buffer.from(encoded, "base64");
}

// The byte length of a chunk, which is what `bytesWritten` counts in.
function __netByteLen(chunk: any, encoding: any): number {
  if (typeof chunk === "string") {
    const text: string = chunk;
    let name: string = encoding === undefined || encoding === null ? "utf8" : String(encoding);
    if (name === "" || name === "buffer") name = "utf8";
    return Number(Buffer.byteLength(text, name));
  }
  const view: Buffer = chunk;
  return Number(view.length);
}

// ---------------------------------------------------------------------------
// isIP / isIPv4 / isIPv6 (`lib/internal/net.js`)
// ---------------------------------------------------------------------------
//
// Node matches two regular expressions. This is the same grammar written out,
// for two reasons: a `RegExp` loses its methods through an `any` lane (zun#7),
// and the parsers are needed in both directions anyway — `BlockList` and
// `SocketAddress` compare *numeric* addresses, so the digits have to be parsed
// rather than only validated.

// Parse a dotted-quad into its four octets, or `null`.
//
// The rules are Node's `IPv4Reg`: exactly four parts, each 1-3 digits with no
// leading zero unless the part *is* `0`, each at most 255.
function __netParseIPv4(text: string): any {
  const parts: string[] = text.split(".");
  if (Number(parts.length) !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    const length: number = Number(part.length);
    if (length < 1 || length > 3) return null;
    if (length > 1 && part.charAt(0) === "0") return null;
    let value = 0;
    for (let i = 0; i < length; i++) {
      const code: number = __netCc(part, i);
      if (code < 48 || code > 57) return null;
      value = value * 10 + (code - 48);
    }
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

// Parse an IPv6 address into its eight 16-bit groups, or `null`.
//
// Node's `IPv6Reg` accepts the full grammar: eight groups, one `::` elision
// anywhere, an embedded dotted-quad in the last 32 bits, and a `%zone` suffix
// of any characters but `%`. The zone is validated and discarded — it is not
// part of the address Node compares.
function __netParseIPv6(text: string): any {
  let body: string = text;
  const percent: number = Number(body.indexOf("%"));
  if (percent !== -1) {
    const zone: string = body.slice(percent + 1);
    // `fe80::2008%eth0@1` is rejected by Node, `fe80::2008%eth0.0` accepted:
    // the zone may not be empty and may not contain a second `%`.
    if (zone === "" || Number(zone.indexOf("%")) !== -1) return null;
    if (Number(zone.indexOf("@")) !== -1) return null;
    body = body.slice(0, percent);
  }

  // At most one elision, and `:::` is never one.
  const elision: number = Number(body.indexOf("::"));
  if (elision !== -1 && Number(body.indexOf("::", elision + 1)) !== -1) return null;

  let head: string = body;
  let tail: string = "";
  if (elision !== -1) {
    head = body.slice(0, elision);
    tail = body.slice(elision + 2);
  }
  // A single leading or trailing `:` that is not part of the elision is
  // invalid (`:2001:252::1` and `2001:252::1:`).
  if (head !== "" && head.charAt(Number(head.length) - 1) === ":") return null;
  if (tail !== "" && tail.charAt(0) === ":") return null;
  if (elision === -1 && (body.charAt(0) === ":" || body.charAt(Number(body.length) - 1) === ":")) {
    return null;
  }

  // An embedded dotted-quad stands for the address's last 32 bits, so it is
  // legal only in the side that *ends* the address: the tail when there is an
  // elision, the head when there is none. Without that distinction
  // `1.2.3.4::5555` and `1.2.3.4::` were accepted, which
  // `test-net-isipv6.js` rejects.
  const front: any = __netIPv6Groups(head, elision === -1);
  if (front === null) return null;
  const back: any = __netIPv6Groups(tail, true);
  if (back === null) return null;
  const total: number = Number(front.length) + Number(back.length);
  if (elision === -1) {
    if (total !== 8) return null;
  } else if (total > 7) {
    // `::` stands for at least one zero group, so eight explicit groups plus
    // an elision is `0000:…:0000::0000`, which Node rejects.
    return null;
  }

  const groups: number[] = [];
  for (const group of front) groups.push(Number(group));
  while (Number(groups.length) + Number(back.length) < 8) groups.push(0);
  for (const group of back) groups.push(Number(group));
  return groups;
}

// One side of an IPv6 address: colon-separated hex groups, with an optional
// dotted-quad as the final one (which stands for two groups).
function __netIPv6Groups(text: string, dottedAllowed: boolean): any {
  if (text === "") return [];
  const parts: string[] = text.split(":");
  const groups: number[] = [];
  const count: number = Number(parts.length);
  for (let index = 0; index < count; index++) {
    const part: string = parts[index];
    if (part === "") return null;
    if (Number(part.indexOf(".")) !== -1) {
      // An embedded IPv4 address is only legal as the very last group of the
      // side that ends the address.
      if (!dottedAllowed) return null;
      if (index !== count - 1) return null;
      const octets: any = __netParseIPv4(part);
      if (octets === null) return null;
      groups.push(Number(octets[0]) * 256 + Number(octets[1]));
      groups.push(Number(octets[2]) * 256 + Number(octets[3]));
      continue;
    }
    const length: number = Number(part.length);
    if (length > 4) return null;
    let value = 0;
    for (let i = 0; i < length; i++) {
      const code: number = __netCc(part, i);
      let digit = -1;
      if (code >= 48 && code <= 57) digit = code - 48;
      else if (code >= 97 && code <= 102) digit = code - 87;
      else if (code >= 65 && code <= 70) digit = code - 55;
      if (digit < 0) return null;
      value = value * 16 + digit;
    }
    groups.push(value);
  }
  return groups;
}

// `net.isIPv4(input)`. Node coerces with `String(input)`, which is why
// `{ toString: () => '127.0.0.1' }` answers `true`.
function __netIsIPv4(input?: any): boolean {
  if (input === undefined || input === null) return false;
  return __netParseIPv4(String(input)) !== null;
}

function __netIsIPv6(input?: any): boolean {
  if (input === undefined || input === null) return false;
  return __netParseIPv6(String(input)) !== null;
}

// `net.isIP(input)` — 4, 6 or 0.
function __netIsIP(input?: any): number {
  if (__netIsIPv4(input)) return 4;
  if (__netIsIPv6(input)) return 6;
  return 0;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// A libuv-shaped socket error, with the four own properties Node's
// `uvExceptionWithHostPort` installs. The fields are declared for the reason
// every error class in this library declares its `code` (zun#37).
class __NetSystemError extends NodeError {
  errno: any = 0;
  syscall: any = "";
  address: any = "";
  port: any = undefined;
  // `hostname` is only on a `getaddrinfo` failure, but it is declared here all
  // the same: an undeclared key written onto a typed instance through an `any`
  // alias poisons every later typed read of that instance (zun#37).
  hostname: any = undefined;
  constructor(code: string, message: string) {
    super(code, message);
  }
}

class ERR_SOCKET_CLOSED extends NodeError {
  constructor() {
    super("ERR_SOCKET_CLOSED", "Socket is closed");
  }
}

class ERR_SOCKET_CLOSED_BEFORE_CONNECTION extends NodeError {
  constructor() {
    super("ERR_SOCKET_CLOSED_BEFORE_CONNECTION", "Socket closed before the connection was established");
  }
}

class ERR_SOCKET_CONNECTION_TIMEOUT extends NodeError {
  constructor() {
    super(
      "ERR_SOCKET_CONNECTION_TIMEOUT",
      "Socket connection timeout",
    );
  }
}

class ERR_SERVER_NOT_RUNNING extends NodeError {
  constructor() {
    super("ERR_SERVER_NOT_RUNNING", "Server is not running.");
  }
}

class ERR_SERVER_ALREADY_LISTEN extends NodeError {
  constructor() {
    super(
      "ERR_SERVER_ALREADY_LISTEN",
      "Listen method has been called more than once without closing.",
    );
  }
}

// `ERR_SOCKET_BAD_PORT` and `ERR_INVALID_IP_ADDRESS` are **not** the class
// names here, although they are the error codes.
//
// `src/dns/dns.ts` already declares classes by those names, and a bundle that
// requires both `dns` and `net` — six files in this corpus do, four of them
// through `internal/test/binding` — would then have two top-level declarations
// of one name, which is a compile error in a single Zun program. The private
// names cost nothing observable: Node's own error *name* is the base class's
// (`RangeError`, `TypeError`), and the identity a test asserts on is `code`.
class __NetBadPort extends NodeRangeError {
  constructor(name: string, port: any, allowZero: boolean) {
    super("ERR_SOCKET_BAD_PORT", __netBadPortMessage(name, port, allowZero));
  }
}

// `lib/internal/errors.js`. ERR_SOCKET_BAD_PORT wording, which three files in
// the corpus compare against literally.
function __netBadPortMessage(name: string, port: any, allowZero: boolean): string {
  const operator: string = allowZero ? ">=" : ">";
  return (
    name +
    " should be " +
    operator +
    " 0 and < 65536. Received " +
    __evInspect(port) +
    "."
  );
}

class __NetInvalidIpAddress extends NodeTypeError {
  constructor(address: any) {
    super("ERR_INVALID_IP_ADDRESS", "Invalid IP address: " + String(address));
  }
}

class ERR_INVALID_ADDRESS_FAMILY extends NodeRangeError {
  host: any = "";
  port: any = 0;
  constructor(addressType: any, host: any, port: any) {
    super(
      "ERR_INVALID_ADDRESS_FAMILY",
      "Invalid address family: " + String(addressType) + " " + String(host) + ":" + String(port),
    );
    this.host = host;
    this.port = port;
  }
}

// `ERR_MISSING_ARGS` is not declared here: `src/util/util.ts` already does,
// and two top-level declarations of one name are a compile error in a single
// Zun program. Every bundle inlines `util`, so the name is always in scope.

// Turn the I/O loop's last error record into the error Node raises.
//
// Node composes **two** shapes from the same libuv facts, and `lib/net.js` uses
// one for `connect` and the other for `listen`:
//
//   * `exceptionWithHostPort` — `connect ECONNREFUSED 127.0.0.1:8080`. Syscall,
//     code, address. No description.
//   * `uvExceptionWithHostPort` — `listen EADDRINUSE: address already in use
//     0.0.0.0:8080`. Syscall, code, a colon, libuv's description, address.
//
// `described` picks the second, which is why the native side reports the
// description separately instead of pre-composing a message. An error with no
// address at all (a failed `read`, say) keeps just `read ECONNRESET`.
function __netSystemError(info: any, syscall?: any, where?: any, described?: any): any {
  const code: string = String(info.code);
  const name: string = syscall === undefined ? String(info.syscall) : String(syscall);
  // `where` overrides the address the native reported: a refused `connect`
  // learns nothing from `SO_ERROR` about *what* it failed to reach, and Node
  // names the address it was asked for.
  const address: string =
    where === undefined || where === null || String(where) === ""
      ? String(info.address)
      : String(where);
  let message: string =
    described === true
      ? name + " " + code + ": " + String(info.message)
      : name + " " + code;
  let host: any = "";
  let port: any = undefined;
  if (address !== "") {
    const colon: number = Number(address.lastIndexOf(":"));
    if (colon !== -1) {
      host = address.slice(0, colon);
      const parsed: number = Number(address.slice(colon + 1));
      if (!Number.isNaN(parsed)) port = parsed;
    } else {
      host = address;
    }
    message = message + " " + host + (port === undefined ? "" : ":" + String(port));
  }
  const error: any = new __NetSystemError(code, message);
  error.errno = Number(info.errno);
  error.syscall = name;
  if (address !== "") {
    error.address = host;
    if (port !== undefined) error.port = port;
  }
  return error;
}

// ---------------------------------------------------------------------------
// Port and address validation (`lib/internal/validators.js`)
// ---------------------------------------------------------------------------

// `validatePort`. Node accepts a number or a numeric string, rejects anything
// else, and `allowZero: false` additionally rejects 0 — which is what
// `socket.connect(0)` runs into while `server.listen(0)` does not.
function __netValidatePort(port: any, name: string, allowZero?: any): number {
  const zeroAllowed: boolean = allowZero === undefined ? true : allowZero === true;
  const label: string = name === undefined || name === "" ? "Port" : name;
  if (typeof port !== "number" && typeof port !== "string") {
    throw new __NetBadPort(label, port, zeroAllowed);
  }
  if (typeof port === "string" && String(port).trim() === "") {
    throw new __NetBadPort(label, port, zeroAllowed);
  }
  const value: number = Number(port);
  if (
    Number.isNaN(value) ||
    value !== Math.floor(value) ||
    value < 0 ||
    value > 65535 ||
    (!zeroAllowed && value === 0)
  ) {
    throw new __NetBadPort(label, port, zeroAllowed);
  }
  return value;
}

// The `connect` options Node rejects before it does anything, in Node's own
// order. Each one is asserted by a file in this corpus.
function __netValidateConnectOptions(options: any): void {
  if (options.host !== undefined && options.host !== null && typeof options.host !== "string") {
    throw new ERR_INVALID_ARG_TYPE("options.host", "string", options.host);
  }
  if (options.localAddress !== undefined && options.localAddress !== null) {
    if (typeof options.localAddress !== "string" || __netIsIP(options.localAddress) === 0) {
      throw new __NetInvalidIpAddress(options.localAddress);
    }
  }
  if (options.localPort !== undefined && options.localPort !== null) {
    // Not `validatePort`: Node checks the *type* here, so a non-numeric
    // `localPort` is `ERR_INVALID_ARG_TYPE` rather than `ERR_SOCKET_BAD_PORT`.
    if (typeof options.localPort !== "number") {
      throw new ERR_INVALID_ARG_TYPE("options.localPort", "number", options.localPort);
    }
  }
  if (options.autoSelectFamily !== undefined && options.autoSelectFamily !== null) {
    if (typeof options.autoSelectFamily !== "boolean") {
      throw new ERR_INVALID_ARG_TYPE("options.autoSelectFamily", "boolean", options.autoSelectFamily);
    }
  }
  if (
    options.autoSelectFamilyAttemptTimeout !== undefined &&
    options.autoSelectFamilyAttemptTimeout !== null
  ) {
    __netCheckAttemptTimeout(options.autoSelectFamilyAttemptTimeout);
  }
}

// ---------------------------------------------------------------------------
// The loop's handle, as this module uses it
// ---------------------------------------------------------------------------

// The native namespace, or `null` in a bundle with no extension.
function __netOps(): any {
  return __ioOps();
}

// Raise the honest error when a bundle has no extension, rather than hanging.
function __netRequireIo(): any {
  const ops: any = __netOps();
  if (ops === null || ops === undefined) {
    throw new NodeError(
      "ERR_METHOD_NOT_IMPLEMENTED",
      "node:net needs the zun-node native extension (run with --ext)",
    );
  }
  return ops;
}

// ---------------------------------------------------------------------------
// The default `lookup`
// ---------------------------------------------------------------------------

// `net`'s default `lookup` is `dns.lookup`, and it is reachable *as an option*:
// several files in the corpus pass their own. So the default is a function of
// the same shape rather than an inlined call — the native resolver, with the
// answer delivered on a later tick (see the header).
function __netDefaultLookup(hostname: any, options: any, callback: any): void {
  const family: number =
    options === undefined || options === null || options.family === undefined
      ? 0
      : Number(options.family);
  const all: boolean = __netIsObj(options) && options.all === true;
  __netTick(function (): void {
    const ops: any = __netOps();
    if (ops === null || ops === undefined) {
      __netInvoke(callback, [new NodeError("ENOSYS", "no resolver"), undefined]);
      return;
    }
    const payload: any = ops.lookup(String(hostname), family);
    if (__ioFailed(payload)) {
      const info: any = __ioLastError();
      const error: any = new __NetSystemError(
        "ENOTFOUND",
        "getaddrinfo ENOTFOUND " + String(hostname),
      );
      error.errno = Number(info.errno);
      error.syscall = "getaddrinfo";
      error.hostname = String(hostname);
      __netInvoke(callback, [error, undefined]);
      return;
    }
    const records: any[] = __ioRecords(payload);
    if (all) {
      const list: any[] = [];
      for (const record of records) {
        list.push({ address: String(record[0]), family: Number(record[1]) });
      }
      __netInvoke(callback, [null, list]);
      return;
    }
    const first: any = records[0];
    __netInvoke(callback, [null, String(first[0]), Number(first[1])]);
  });
}

// ---------------------------------------------------------------------------
// autoSelectFamily
// ---------------------------------------------------------------------------
//
// Node 20 turned Happy Eyeballs on by default: a connect to a name that
// resolves to both families races the two. The loop here resolves names
// synchronously and connects one address at a time, so the *flags* are
// honoured and reported while the racing is not — `__netState.autoSelectFamily`
// decides whether an AAAA answer is tried before an A one, which is the part
// `test-net-autoselectfamily-ipv4first.js` observes.
const __netState: any = {
  autoSelectFamily: true,
  autoSelectFamilyAttemptTimeout: 250,
};

function __netGetDefaultAutoSelectFamily(): boolean {
  return __netState.autoSelectFamily === true;
}

function __netSetDefaultAutoSelectFamily(value: any): void {
  if (typeof value !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE("value", "boolean", value);
  }
  __netState.autoSelectFamily = value;
}

function __netGetDefaultAutoSelectFamilyAttemptTimeout(): number {
  return Number(__netState.autoSelectFamilyAttemptTimeout);
}

// `validateInt32(value, 'value', 1)` plus Node's floor of 10: a timeout below
// ten milliseconds is raised rather than refused, which
// `test-net-socket-connect-invalid-autoselectfamilyattempttimeout.js` checks
// for 1 and 9.
function __netCheckAttemptTimeout(value: any): number {
  const parsed: number = Number(value);
  if (
    typeof value !== "number" ||
    Number.isNaN(parsed) ||
    parsed !== Math.floor(parsed) ||
    parsed <= 0
  ) {
    throw new ERR_OUT_OF_RANGE("value", ">= 1 && <= 2147483647", value);
  }
  return parsed < 10 ? 10 : parsed;
}

function __netSetDefaultAutoSelectFamilyAttemptTimeout(value: any): void {
  __netState.autoSelectFamilyAttemptTimeout = __netCheckAttemptTimeout(value);
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------
//
// A `Socket` is a `stream.Duplex` whose two sides are one I/O handle:
//
//   * `_read` declares read interest. The loop's `readable()` then drains the
//     handle with `ioRead` and `push()`es what it got; a `push` that answers
//     `false` withdraws the interest, which is backpressure all the way down to
//     the TCP window.
//   * `_write` queues the chunk and offers it to `ioWrite`, which takes as much
//     as the kernel will accept. A partial write leaves the remainder queued
//     and declares write interest; the loop's `writable()` offers it again.
//   * `_final` is `shutdown(SHUT_WR)`, once the queue has drained — which is
//     what makes `socket.end()` a half-close rather than a close.
//   * `_destroy` closes the handle and unregisters it.
//
// The hooks go into `src/stream/stream.ts`' option store rather than being
// assigned to `this._read` & co., for the reason that file's header gives.
class Socket extends Duplex {
  // Every field is declared: an undeclared write on a class instance is a
  // compile error here, and Node's own tests read most of these directly.
  //
  // They are `any` rather than `number`/`boolean` for the reason
  // `src/zlib/zlib.ts`' `ZlibBase` documents: the free functions below take the
  // socket as `any` (a class method is unreachable as a value, zun#19), and a
  // declared-`number` field read back through an `any` receiver trips the
  // interpreter's unboxing. Every read site funnels through `Number(...)`
  // anyway (zun#3).
  _handle: any = null;
  _server: any = null;
  _parent: any = null;
  _host: any = null;
  _pendingData: any = null;
  _pendingEncoding: any = "";
  // Node's own name for the connecting flag is the `kConnecting` symbol with a
  // `connecting` accessor over it; a user symbol cannot key a class member
  // here, so the field is the plain name and the accessor is `pending`.
  connecting: any = false;
  _connectQueue: any = null;
  _sockState: any = null;
  // `allowHalfOpen` is read off the instance by `Duplex` itself.
  allowHalfOpen: any = false;

  constructor(options?: any) {
    super(__netSocketOptions(options));

    // The per-socket side table. A plain object rather than a set of class
    // fields, because a *function* assigned to a class field is unreachable
    // afterwards (see `src/stream/stream.ts`' header note 1) and this holds the
    // timeout callback and the write queue's callbacks.
    this._sockState = {
      // The I/O handle, or 0 when there is none.
      handle: 0,
      // Bytes handed to the kernel and taken off it.
      bytesWritten: 0,
      bytesRead: 0,
      // The write queue: `{ buf, offset, callback }` records, head first.
      queue: [],
      // Bytes still queued, which is `bufferSize`'s own contribution.
      queued: 0,
      // Set once `_final` ran with a non-empty queue: the shutdown is owed.
      shutdownPending: false,
      // `noDelay`/`keepAlive` as the constructor options asked for them. Node
      // applies both from `afterConnect` for a socket that is still
      // connecting, which is where `__netAfterConnect` reads them.
      optNoDelay: false,
      optKeepAlive: false,
      optKeepAliveDelay: 0,
      // `setTimeout`'s timer and its listener.
      timeout: 0,
      timer: null,
      // The addresses, cached the way Node caches `_sockname`/`_peername`.
      local: null,
      peer: null,
      // Set while a `connect` is in flight, for the error a close then raises.
      connectPending: false,
      // Node's `_requestedPort`/`_requestedHost`, which the error messages use.
      requestedPort: 0,
      requestedHost: "",
      // The addresses an `autoSelectFamily` connect tried, which is what
      // `socket.autoSelectFamilyAttemptedAddresses` reports.
      attempted: [],
      // The resolved candidates of the connect in flight, and which one is
      // being tried: a name with both an A and an AAAA record gets a second
      // chance (see `__netConnectFailed`).
      candidates: null,
      candidateIndex: 0,
      connectOptions: null,
      // True once the readable side has seen end of file.
      eof: false,
      // True when read interest is withdrawn because `push` said stop.
      readPaused: false,
      destroySoon: false,
    };

    const self: any = this;
    __sSetOptFn(self, "read", function (): void {
      __netReadHook(self);
    });
    __sSetOptFn(self, "write", function (chunk: any, encoding: any, cb: any): void {
      __netWriteHook(self, chunk, encoding, cb);
    });
    __sSetOptFn(self, "final", function (cb: any): void {
      __netFinalHook(self, cb);
    });
    __sSetOptFn(self, "destroy", function (err: any, cb: any): void {
      __netDestroyHook(self, err, cb);
    });

    // Node destroys a socket once *both* of its sides are done, and `'finish'`
    // is the later of the two signals. `_final` runs *before* it, so
    // `writableFinished` is still false there and the end-of-file path alone
    // cannot make the decision — without this listener a socket whose peer
    // ended never emitted `'close'`. The listener closes over the socket
    // because a listener is invoked with no receiver of its own (zun#1).
    self.on("finish", function (): void {
      __netAfterFinish(self);
    });

    if (__netIsObj(options)) {
      if (options.handle !== undefined && options.handle !== null) {
        // `new net.Socket({ handle })` adopts a handle the loop already has,
        // which is how `Server` builds the socket it emits.
        __netAdopt(self, Number(options.handle), options);
      } else if (options.fd !== undefined && options.fd !== null) {
        // A raw fd is a different kernel object story (a pipe, a tty or a
        // socket, decided by `fstat`), and the loop has only the socket half.
        throw new ERR_INVALID_ARG_VALUE(
          "options.fd",
          options.fd,
          "is not supported by node:net on this runtime",
        );
      }
      if (options.timeout !== undefined && options.timeout !== null) {
        __netSetTimeout(self, options.timeout, undefined);
      }
      // Node applies these two with *truthiness* rather than `=== true`
      // (`test-net-connect-nodelay.js` passes `1`, `'true'`, `{}` and `[]`),
      // and it applies them from `afterConnect` for a socket that is still
      // connecting -- which is where `__netAfterConnect` picks them up.
      this._sockState.optNoDelay = __netTruthy(options.noDelay);
      this._sockState.optKeepAlive = __netTruthy(options.keepAlive);
      this._sockState.optKeepAliveDelay = options.keepAliveInitialDelay;
      if (this._sockState.optNoDelay === true) __netSetNoDelay(self, true);
      if (this._sockState.optKeepAlive === true) {
        __netSetKeepAlive(self, true, options.keepAliveInitialDelay);
      }
    }
  }

  // ---- the connection surface ---------------------------------------------

  // Four explicit optional parameters rather than `...args`, which is the
  // widest shape Node's `connect` has (`port, host, cb` / `options, cb` /
  // `path, cb`). The spelling is forced: a function argument handed to a class
  // method with a **rest** parameter is not reachable from the rest array in
  // this engine — `server.listen(0, () => {})` silently never called back,
  // while `server.getConnections(cb)` (a plain parameter) worked. See the note
  // above `__netNormalizeArgs`; this is the second half of the same gap.
  connect(a?: any, b?: any, c?: any, d?: any): any {
    return __netSocketConnect(this, a, b, c, d);
  }

  // ---- readable-side overrides -------------------------------------------
  //
  // `pause()` and `resume()` are `Readable`'s, plus the one thing a socket adds:
  // the kernel-level interest. A paused socket declares no read interest, so the
  // peer's data stays in the receive buffer.

  pause(): any {
    const result: any = super.pause();
    __netUpdateReadInterest(this);
    return result;
  }

  resume(): any {
    const result: any = super.resume();
    __netUpdateReadInterest(this);
    return result;
  }

  // ---- the socket surface -------------------------------------------------

  setTimeout(msecs: any, callback?: any): any {
    __netSetTimeout(this, msecs, callback);
    return this;
  }

  setNoDelay(enable?: any): any {
    __netSetNoDelay(this, enable === undefined ? true : enable === true);
    return this;
  }

  setKeepAlive(enable?: any, initialDelay?: any): any {
    __netSetKeepAlive(this, enable === undefined ? true : enable === true, initialDelay);
    return this;
  }

  address(): any {
    return __netSockName(this);
  }

  ref(): any {
    const state: any = this._sockState;
    if (Number(state.handle) !== 0) __ioRef(Number(state.handle));
    return this;
  }

  unref(): any {
    const state: any = this._sockState;
    if (Number(state.handle) !== 0) __ioUnref(Number(state.handle));
    return this;
  }

  // `socket.resetAndDestroy()` — an abortive close (RST rather than FIN). The
  // loop has no SO_LINGER knob, so this closes the handle without the orderly
  // shutdown `end()` would do, which is the observable half: the peer sees the
  // connection go away without a FIN-then-close handshake.
  resetAndDestroy(): any {
    const state: any = this._sockState;
    if (Number(state.handle) === 0) {
      this.destroy(new ERR_SOCKET_CLOSED());
      return this;
    }
    // `SO_LINGER { on, 0 }` before the close, which is what turns the close
    // into an RST instead of a FIN: `test-net-server-reset.js` asserts that
    // the peer sees `ECONNRESET`.
    const ops: any = __netOps();
    if (ops !== null && ops !== undefined) ops.reset(Number(state.handle));
    this.destroy();
    return this;
  }

  // `socket.destroySoon()` — end the writable side and destroy once it is
  // finished, which is what `http` uses and one `net` file checks.
  destroySoon(): any {
    const state: any = this._sockState;
    if (this.writable === true) this.end();
    if (this.writableFinished === true) {
      this.destroy();
    } else {
      // The constructor's `'finish'` listener does the destroying; this flag
      // is what tells it to do so unconditionally.
      state.destroySoon = true;
    }
    return this;
  }

  // ---- the readings -------------------------------------------------------

  get bytesRead(): any {
    return Number(this._sockState.bytesRead);
  }

  get bytesWritten(): any {
    // Node counts the bytes *queued*, not the bytes flushed, so a write that
    // has not reached the kernel is already included.
    const state: any = this._sockState;
    return Number(state.bytesWritten);
  }

  get bufferSize(): any {
    const state: any = this._sockState;
    if (Number(state.handle) === 0) return undefined;
    return Number(state.queued) + Number(this.writableLength);
  }

  get pending(): any {
    return Number(this._sockState.handle) === 0 || this.connecting === true;
  }

  get readyState(): any {
    if (this.connecting === true) return "opening";
    if (this.readable === true && this.writable === true) return "open";
    if (this.readable === true && this.writable !== true) return "readOnly";
    if (this.readable !== true && this.writable === true) return "writeOnly";
    return "closed";
  }

  get remoteAddress(): any {
    const peer: any = __netPeerName(this);
    return peer === null ? undefined : peer.address;
  }

  get remoteFamily(): any {
    const peer: any = __netPeerName(this);
    return peer === null ? undefined : peer.family;
  }

  get remotePort(): any {
    const peer: any = __netPeerName(this);
    return peer === null ? undefined : peer.port;
  }

  get localAddress(): any {
    const local: any = __netSockName(this);
    return local === null ? undefined : local.address;
  }

  get localFamily(): any {
    const local: any = __netSockName(this);
    return local === null ? undefined : local.family;
  }

  get localPort(): any {
    const local: any = __netSockName(this);
    return local === null ? undefined : local.port;
  }

  get timeout(): any {
    const value: number = Number(this._sockState.timeout);
    return value === 0 ? undefined : value;
  }

  get autoSelectFamilyAttemptedAddresses(): any {
    return this._sockState.attempted;
  }

  // Node keeps `socket._handle` as the libuv wrap object; a test only ever
  // checks it against `null` to see whether the socket still has one.
  get _connecting(): any {
    return this.connecting === true;
  }
}

// `new Socket(options)`' option translation.
//
// Two of Node's defaults differ from `Duplex`'s: `allowHalfOpen` is false (a
// socket whose peer ends also ends), and the readable side must not be
// auto-destroyed, because a half-open socket is still writable after its
// readable side ended.
function __netSocketOptions(options: any): any {
  if (__netIsObj(options)) {
    // Node refuses the three object-mode knobs outright: a socket is a byte
    // stream, and accepting them would produce a stream whose chunks are not
    // buffers. The wording is `lib/net.js`' own.
    for (const key of ["objectMode", "readableObjectMode", "writableObjectMode"]) {
      if (options[key] !== undefined) {
        throw new ERR_INVALID_ARG_VALUE(
          "options." + key,
          options[key],
          "is not supported",
        );
      }
    }
  }
  const settings: any = {
    allowHalfOpen: __netIsObj(options) && options.allowHalfOpen === true,
    autoDestroy: false,
    emitClose: false,
    decodeStrings: false,
  };
  if (__netIsObj(options)) {
    if (options.highWaterMark !== undefined) settings.highWaterMark = options.highWaterMark;
    if (options.signal !== undefined) settings.signal = options.signal;
    if (options.readable === false) settings.readable = false;
    if (options.writable === false) settings.writable = false;
    if (options.objectMode === true) settings.objectMode = true;
  }
  return settings;
}

// Adopt an I/O handle into a socket: register it with the loop and record both
// ends' addresses. Used by `Server`'s accept path and by
// `new net.Socket({ handle })`.
function __netAdopt(self: any, handle: number, options: any): void {
  const state: any = self._sockState;
  state.handle = handle;
  self._handle = __netHandleWrap(self, handle);
  self.connecting = false;
  if (__netIsObj(options)) {
    if (options.remote !== undefined && options.remote !== null) state.peer = options.remote;
    if (options.local !== undefined && options.local !== null) state.local = options.local;
  }
  __ioRegister(handle, {
    readable(): void {
      __netOnReadable(self);
    },
    writable(): void {
      __netOnWritable(self);
    },
    failed(): void {
      __netOnFailed(self);
    },
  });
  __netUpdateReadInterest(self);
}

// ---------------------------------------------------------------------------
// Socket: the readable side
// ---------------------------------------------------------------------------

// `_read()` — the stream wants more. The answer is not to read now (there may
// be nothing there) but to declare interest; the loop calls back when there is.
function __netReadHook(self: any): void {
  const state: any = self._sockState;
  state.readPaused = false;
  __netUpdateReadInterest(self);
}

// Declare or withdraw read interest, from the one place that knows all three
// reasons to want it: the stream asked, the socket is not paused, and there is
// a handle that has not ended.
function __netUpdateReadInterest(self: any): void {
  const state: any = self._sockState;
  const handle: number = Number(state.handle);
  if (handle === 0) return;
  if (self.connecting === true) return;
  const wanted: boolean =
    state.eof !== true && state.readPaused !== true && self.isPaused() !== true;
  if (wanted) {
    __ioWant(handle, 1);
  } else {
    __ioUnwant(handle, 1);
  }
}

// The loop says this handle is readable: drain it.
//
// The loop is `while` rather than one read, because readiness is edge-shaped in
// practice — a single `select` wake may stand for many kernel buffers' worth —
// and because `push()` answering `false` is the signal to stop, which a single
// read could not observe.
function __netOnReadable(self: any): void {
  const state: any = self._sockState;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return;
  if (self.connecting === true) {
    // Readiness on a connecting socket settles the attempt; on Windows a
    // refused connect arrives this way rather than as writable.
    __netSettleConnect(self);
    return;
  }
  while (true) {
    const handle: number = Number(state.handle);
    if (handle === 0 || state.eof === true) return;
    const payload: any = ops.read(handle, 0);
    if (__ioFailed(payload)) {
      const info: any = __ioLastError();
      // A reset is the peer's abortive close. Node reports it as an
      // `ECONNRESET` error on the socket and then destroys it.
      __netDestroyWith(self, __netSystemError(info, "read"));
      return;
    }
    const text: string = String(payload);
    const marker: string = text.charAt(1);
    if (marker === "A") {
      // Nothing more right now; the interest stays and the loop calls again.
      return;
    }
    if (marker === "E") {
      __netOnEnd(self);
      return;
    }
    const chunk: Buffer = __netFromBase64(text.slice(2));
    state.bytesRead = Number(state.bytesRead) + Number(chunk.length);
    __netResetTimeout(self);
    if (self.push(chunk) !== true) {
      // Backpressure: stop declaring read interest until `_read` is called.
      state.readPaused = true;
      __netUpdateReadInterest(self);
      return;
    }
  }
}

// End of file on the readable side: `push(null)`, and then Node's
// `allowHalfOpen` rule.
function __netOnEnd(self: any): void {
  const state: any = self._sockState;
  if (state.eof === true) return;
  state.eof = true;
  __netUpdateReadInterest(self);
  self.push(null);
  if (self.allowHalfOpen !== true) {
    // Node ends the writable side as well, which is what makes a plain
    // `socket.pipe(socket)` echo server shut down cleanly.
    if (self.writable === true) {
      self.end();
    } else {
      __netMaybeDestroy(self);
    }
  } else {
    __netMaybeDestroy(self);
  }
}

// ---------------------------------------------------------------------------
// Socket: the writable side
// ---------------------------------------------------------------------------

// `_write(chunk, encoding, cb)` — queue the chunk and offer it to the kernel.
function __netWriteHook(self: any, chunk: any, encoding: any, cb: any): void {
  const state: any = self._sockState;
  if (Number(state.handle) === 0) {
    if (self.connecting === true) {
      // A write before the connection is up is queued, which is what makes
      // `net.connect(port).write(data)` work.
      __netQueueBeforeConnect(self, chunk, encoding, cb);
      return;
    }
    __netInvoke(cb, [new ERR_SOCKET_CLOSED()]);
    return;
  }
  if (self.connecting === true) {
    __netQueueBeforeConnect(self, chunk, encoding, cb);
    return;
  }
  const length: number = __netByteLen(chunk, encoding);
  state.bytesWritten = Number(state.bytesWritten) + length;
  if (length === 0) {
    __netInvoke(cb, [null]);
    return;
  }
  const bytes: Buffer = Buffer.from(__netToBase64(chunk, encoding), "base64");
  state.queue.push({ buf: bytes, offset: 0, callback: cb });
  state.queued = Number(state.queued) + length;
  __netResetTimeout(self);
  __netFlush(self);
}

// A write that arrived before the connection was up. Node keeps a
// `_connectQueue` of them and replays it from `afterConnect`.
function __netQueueBeforeConnect(self: any, chunk: any, encoding: any, cb: any): void {
  if (self._connectQueue === null) self._connectQueue = [];
  self._connectQueue.push({ chunk: chunk, encoding: encoding, callback: cb });
  const state: any = self._sockState;
  state.bytesWritten = Number(state.bytesWritten) + __netByteLen(chunk, encoding);
}

// Offer the queue to the kernel until it stops taking, then either finish or
// declare write interest.
function __netFlush(self: any): void {
  const state: any = self._sockState;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return;
  while (Number(state.queue.length) > 0) {
    const handle: number = Number(state.handle);
    if (handle === 0) return;
    const entry: any = state.queue[0];
    const view: Buffer = entry.buf;
    const offset: number = Number(entry.offset);
    const remaining: string = view.slice(offset).toString("base64");
    const payload: any = ops.write(handle, remaining);
    if (__ioFailed(payload)) {
      const info: any = __ioLastError();
      const error: any = __netSystemError(info, "write");
      const callback: any = entry.callback;
      state.queue.shift();
      __netInvoke(callback, [error]);
      __netDestroyWith(self, error);
      return;
    }
    const text: string = String(payload);
    if (text.charAt(1) === "A") {
      // The send buffer is full: wait for writability and offer again.
      __ioWant(handle, 2);
      return;
    }
    const written: number = Number(__ioFields(text)[0]);
    entry.offset = offset + written;
    state.queued = Number(state.queued) - written;
    if (Number(entry.offset) >= Number(view.length)) {
      state.queue.shift();
      __netInvoke(entry.callback, [null]);
    } else {
      __ioWant(handle, 2);
      return;
    }
  }
  // Drained. Stop asking about writability, and honour an owed shutdown.
  const handle: number = Number(state.handle);
  if (handle !== 0) __ioUnwant(handle, 2);
  if (state.shutdownPending === true) {
    state.shutdownPending = false;
    __netShutdown(self);
  }
}

// `_final(cb)` — the writable side has ended. Half-close once the queue is
// empty; if it is not, remember that the shutdown is owed.
function __netFinalHook(self: any, cb: any): void {
  const state: any = self._sockState;
  if (self.connecting === true) {
    // `socket.end()` before the connection is up: the shutdown happens from
    // `afterConnect`, which is what Node's `kAfterConnectQueue` does.
    state.shutdownPending = true;
    __netInvoke(cb, [null]);
    return;
  }
  if (Number(state.queue.length) > 0) {
    state.shutdownPending = true;
  } else {
    __netShutdown(self);
  }
  __netInvoke(cb, [null]);
}

// `shutdown(SHUT_WR)`, which is the FIN a half-close sends.
function __netShutdown(self: any): void {
  const state: any = self._sockState;
  const handle: number = Number(state.handle);
  if (handle === 0) return;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return;
  const payload: any = ops.shutdown(handle);
  if (__ioFailed(payload)) {
    const info: any = __ioLastError();
    // `ENOTCONN` on shutdown means the peer is already gone, which is not an
    // error worth raising — Node ignores it too.
    if (String(info.code) !== "ENOTCONN") {
      __netDestroyWith(self, __netSystemError(info, "shutdown"));
      return;
    }
  }
  __netMaybeDestroy(self);
}

// The loop says this handle is writable.
function __netOnWritable(self: any): void {
  if (self.connecting === true) {
    __netSettleConnect(self);
    return;
  }
  __netFlush(self);
}

// The loop says this handle has an error or hangup.
function __netOnFailed(self: any): void {
  if (self.connecting === true) {
    __netSettleConnect(self);
    return;
  }
  const state: any = self._sockState;
  const handle: number = Number(state.handle);
  if (handle === 0) return;
  // Readiness alone does not say what went wrong; a read does.
  __netOnReadable(self);
}

// Both sides done: Node destroys the socket, which is what emits `'close'`.
//
// The condition does not depend on `allowHalfOpen`, and that is the point —
// `allowHalfOpen` does not change *when* a finished socket is destroyed, it
// changes whether the readable side's end of file ends the writable side as
// well, which is `__netOnEnd`'s decision.
function __netMaybeDestroy(self: any): void {
  const state: any = self._sockState;
  if (state.eof === true && self.writableFinished === true) {
    __netTick(__netDestroyNow, self);
  }
}

function __netDestroyNow(self: any): void {
  if (self.destroyed === true) return;
  self.destroy();
}

// The writable side has finished: destroy if the socket has nothing left to do.
function __netAfterFinish(self: any): void {
  const state: any = self._sockState;
  if (state.destroySoon === true) {
    state.destroySoon = false;
    __netTick(__netDestroyNow, self);
    return;
  }
  __netMaybeDestroy(self);
}

// `_destroy(err, cb)` — close the handle, then let the stream emit `'close'`.
function __netDestroyHook(self: any, err: any, cb: any): void {
  const state: any = self._sockState;
  const handle: number = Number(state.handle);
  if (handle !== 0) {
    state.handle = 0;
    self._handle = null;
    __ioUnregister(handle);
  }
  __netClearTimeout(self);
  // Every queued write that never reached the kernel is failed, the way Node
  // fails the pending writes of a destroyed socket.
  const pending: any[] = state.queue;
  state.queue = [];
  state.queued = 0;
  for (const entry of pending) {
    __netInvoke(entry.callback, [err === undefined || err === null ? new ERR_SOCKET_CLOSED() : err]);
  }
  const server: any = self._server;
  if (server !== null && server !== undefined) {
    self._server = null;
    __netServerConnectionClosed(server);
  }
  __netInvoke(cb, [err === undefined ? null : err]);
  // `emitClose: false` above, because the socket has to emit `'close'` with
  // Node's `hadError` argument rather than the stream's own no-argument form.
  const hadError: boolean = err !== undefined && err !== null;
  __netTick(__netEmitClose, self, hadError);
}

function __netEmitClose(self: any, hadError: any): void {
  self.emit("close", hadError === true);
}

// Raise `err` on the socket and destroy it, which is Node's
// `socket.destroy(err)` seen from the inside.
function __netDestroyWith(self: any, err: any): void {
  if (self.destroyed === true) return;
  self.destroy(err);
}

// ---------------------------------------------------------------------------
// Socket: connect
// ---------------------------------------------------------------------------

// `socket.connect(...)`, with Node's three argument shapes.
function __netSocketConnect(self: any, a: any, b: any, c: any, d: any): any {
  // `socket.connect(net._normalizeArgs([...]))` — the one shape where the
  // argument *is* an already-normalized pair. An array without the marker is
  // not an argument list at all, which is what Node answers with
  // `ERR_MISSING_ARGS`.
  if (Array.isArray(a)) {
    if (a[__netNormalizedArgs] !== true) {
      throw new NodeTypeError(
        "ERR_MISSING_ARGS",
        'The "options" or "port" or "path" argument must be specified',
      );
    }
    const callback: any = a[1];
    if (__netIsFn(callback)) self.once("connect", callback);
    return __netSocketConnectOptions(self, a[0]);
  }
  __netAttachListener(self, "connect", a, b, c, d);
  return __netSocketConnectOptions(self, __netNormalizeOptions(a, b));
}

// `connect`, once the arguments have been reduced to one options object and the
// callback has already been registered.
function __netSocketConnectOptions(self: any, options: any): any {
  if (self.destroyed === true) {
    // Node re-arms the streams rather than refusing, which is what lets a
    // socket be reconnected after `destroy()`.
    self._undestroy();
    const state: any = self._sockState;
    state.eof = false;
    state.destroySoon = false;
  }

  // `connect()` / `connect({})` with nothing to connect *to*. Node's own
  // message names all three accepted forms, which the standard
  // `ERR_MISSING_ARGS(…names)` spelling cannot produce (it joins with "and",
  // and `lib/net.js` passes an *array*, which `internal/errors.js` joins with
  // "or"), so the one message is written out here.
  const hasPort: boolean = options.port !== undefined && options.port !== null;
  const hasPath: boolean = options.path !== undefined && options.path !== null;
  if (!hasPort && !hasPath) {
    throw new NodeTypeError(
      "ERR_MISSING_ARGS",
      'The "options" or "port" or "path" argument must be specified',
    );
  }
  // `localAddress`/`localPort` are judged **before** the port, which is what
  // `test-net-localerror.js` observes: `connect({ port: 0, localAddress:
  // 'foobar' })` is `ERR_INVALID_IP_ADDRESS`, not a port complaint. And port 0
  // is legal for `connect` here, as it is in Node — `validatePort`'s
  // `allowZero` defaults to true.
  __netValidateConnectOptions(options);
  const port: number = hasPort ? __netValidatePort(options.port, "options.port", true) : 0;
  if (hasPath) {
    // See the header: pipes are a different kernel object and the loop has
    // only the socket half.
    throw new ERR_INVALID_ARG_VALUE(
      "options.path",
      options.path,
      "is not supported by node:net on this runtime (no pipe support)",
    );
  }

  const state: any = self._sockState;
  const host: string =
    options.host === undefined || options.host === null ? "localhost" : String(options.host);
  state.requestedPort = port;
  state.requestedHost = host;
  self._host = host;
  self.connecting = true;
  // Node's `Socket.prototype.connect` creates `this._handle` here, at the top,
  // *before* the address lookup -- so `socket._handle` is non-null the instant
  // `connect()` returns, and four files in this corpus replace a method on it
  // right there. `ioSocket()` reserves the row (libuv's uninitialized
  // `uv_tcp_t`); `ioConnect` opens the real socket into it once the family is
  // known, and again for each further candidate address.
  if (Number(state.handle) === 0) {
    const ops: any = __netRequireIo();
    const reserved: any = ops.socket();
    if (__ioFailed(reserved)) {
      self.connecting = false;
      __netDestroyWith(self, __netSystemError(__ioLastError(), "socket"));
      return self;
    }
    const handle: number = Number(__ioFields(reserved)[0]);
    state.handle = handle;
    self._handle = __netHandleWrap(self, handle);
    __ioRegister(handle, {
      readable(): void {
        __netOnReadable(self);
      },
      writable(): void {
        __netOnWritable(self);
      },
      failed(): void {
        __netOnFailed(self);
      },
    });
  }
  state.connectPending = true;
  state.attempted = [];
  // Node's `connect` re-arms the writable side here. It is *not* done by
  // assignment: `writable` is an accessor on `Duplex`, and assigning to an
  // accessor through an `any` receiver panics the interpreter (see
  // `src/zlib/zlib.ts`' header note). `_undestroy()` above already restored
  // both sides for the reconnect case, which is the only case that needs it.

  const family: number = options.family === undefined ? 0 : Number(options.family);
  state.connectOptions = options;
  const literal: number = __netIsIP(host);
  if (literal !== 0) {
    // An IP literal needs no resolver, but the connect still has to be
    // asynchronous — Node never calls back on the same tick.
    __netTick(__netBeginConnect, self, [{ address: host, family: literal }]);
    return self;
  }

  const lookup: any =
    options.lookup === undefined || options.lookup === null
      ? undefined
      : options.lookup;
  if (lookup !== undefined && !__netIsFn(lookup)) {
    throw new ERR_INVALID_ARG_TYPE("options.lookup", "Function", lookup);
  }
  const hints: any = options.hints;
  const resolver: any = lookup === undefined ? undefined : lookup;
  const request: any = { socket: self, host: host };
  const onLookup: any = function (err: any, address: any, addressFamily: any): void {
    __netAfterLookup(request, err, address, addressFamily);
  };
  // `all: true` is asked for whenever the family is open, so that a name with
  // both an A and an AAAA record has a second candidate to fall back on — the
  // observable half of `autoSelectFamily` (see `__netState`). A caller's own
  // `lookup` is called the way Node calls it, one address, because that is the
  // contract the corpus's replacement functions are written against.
  if (resolver === undefined) {
    __netDefaultLookup(
      host,
      { family: family, hints: hints, all: family === 0 && __netState.autoSelectFamily === true },
      onLookup,
    );
  } else {
    __netInvoke(resolver, [host, { family: family, hints: hints }, __evBox(onLookup)]);
  }
  return self;
}

// The `lookup` callback. Node emits `'lookup'` with exactly these arguments
// before it does anything with the answer, and three files in the corpus check
// it.
//
// The second argument is either one address (Node's own shape, and what a
// caller-supplied `lookup` answers) or the whole list, when `all: true` was
// asked for above.
function __netAfterLookup(request: any, err: any, address: any, family: any): void {
  const self: any = request.socket;
  if (self.destroyed === true) return;
  const candidates: any[] = [];
  if (Array.isArray(address)) {
    for (const entry of address) {
      candidates.push({ address: String(entry.address), family: Number(entry.family) });
    }
  } else if (address !== undefined && address !== null) {
    candidates.push({
      address: String(address),
      family: family === undefined ? __netIsIP(address) : Number(family),
    });
  }
  const first: any = Number(candidates.length) > 0 ? candidates[0] : undefined;
  self.emit(
    "lookup",
    err === undefined ? null : err,
    first === undefined ? address : first.address,
    first === undefined ? family : first.family,
    request.host,
  );
  if (err !== null && err !== undefined) {
    self.connecting = false;
    __netDestroyWith(self, err);
    return;
  }
  if (Number(candidates.length) === 0) {
    self.connecting = false;
    __netDestroyWith(self, new __NetInvalidIpAddress(address));
    return;
  }
  __netBeginConnect(self, candidates);
}

// Start working through the candidate addresses, in the order the resolver
// gave them.
function __netBeginConnect(self: any, candidates: any): void {
  if (self.destroyed === true) return;
  const state: any = self._sockState;
  state.candidates = candidates;
  state.candidateIndex = 0;
  __netTryCandidate(self);
}

// A connect to the current candidate failed. Node's `autoSelectFamily` tries
// the next address rather than giving up, which is the whole point of resolving
// `all: true` above; the last failure is the one that reaches the program.
function __netConnectFailed(self: any, error: any): void {
  const state: any = self._sockState;
  const candidates: any = state.candidates;
  const next: number = Number(state.candidateIndex) + 1;
  if (candidates !== null && candidates !== undefined && next < Number(candidates.length)) {
    // The row stays: `ioConnect` closes the failed socket and opens a fresh
    // one in it, which is what keeps `socket._handle` stable across the
    // attempts.
    state.candidateIndex = next;
    __ioUnwant(Number(state.handle), 3);
    __netTryCandidate(self);
    return;
  }
  self.connecting = false;
  state.connectPending = false;
  __netDestroyWith(self, error);
}

// Open the socket and start the connection to the current candidate.
function __netTryCandidate(self: any): void {
  if (self.destroyed === true) return;
  const state: any = self._sockState;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) {
    self.connecting = false;
    __netDestroyWith(
      self,
      new NodeError(
        "ERR_METHOD_NOT_IMPLEMENTED",
        "node:net needs the zun-node native extension (run with --ext)",
      ),
    );
    return;
  }
  const options: any = state.connectOptions === null ? {} : state.connectOptions;
  const target: any = state.candidates[Number(state.candidateIndex)];
  const localAddress: string =
    options.localAddress === undefined || options.localAddress === null
      ? ""
      : String(options.localAddress);
  const localPort: number =
    options.localPort === undefined || options.localPort === null
      ? 0
      : __netValidatePort(options.localPort, "options.localPort", true);
  if (localAddress !== "" && __netIsIP(localAddress) === 0) {
    self.connecting = false;
    __netDestroyWith(self, new __NetInvalidIpAddress(localAddress));
    return;
  }

  state.attempted.push(String(target.address) + ":" + String(state.requestedPort));
  const handle: number = Number(state.handle);
  const payload: any = ops.connect(
    handle,
    String(target.address),
    Number(state.requestedPort),
    localAddress,
    localPort,
  );
  if (__ioFailed(payload)) {
    const info: any = __ioLastError();
    __netConnectFailed(self, __netSystemError(info, "connect"));
    return;
  }
  const connected: boolean = Number(__ioFields(payload)[1]) === 1;
  if (connected) {
    // The loopback case: the kernel completed the connect inside the call.
    // The `'connect'` event still has to be asynchronous.
    __netTick(__netSettleConnect, self);
  } else {
    __ioWant(handle, 2);
  }
}

// A connecting socket became ready: ask `SO_ERROR` whether it worked.
function __netSettleConnect(self: any): void {
  if (self.connecting !== true) return;
  const state: any = self._sockState;
  const handle: number = Number(state.handle);
  if (handle === 0) return;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return;
  const payload: any = ops.connectError(handle);
  if (__ioFailed(payload)) {
    const info: any = __ioLastError();
    self.connecting = false;
    state.connectPending = false;
    // `SO_ERROR` says *what* went wrong and nothing about what was being
    // reached, so the address Node names in the message is the one the connect
    // was asked for — the last entry of `attempted`.
    const tried: any = state.attempted;
    const where: string =
      Number(tried.length) > 0 ? String(tried[Number(tried.length) - 1]) : "";
    __netConnectFailed(self, __netSystemError(info, "connect", where));
    return;
  }
  self.connecting = false;
  state.connectPending = false;
  state.peer = __netTriple(__ioFields(payload));
  __ioUnwant(handle, 2);
  __netAfterConnect(self);
}

// Node's `afterConnect`: emit `'connect'`, replay the queued writes, emit
// `'ready'`, and start reading.
function __netAfterConnect(self: any): void {
  const state: any = self._sockState;
  self.emit("connect");
  const queued: any = self._connectQueue;
  self._connectQueue = null;
  if (queued !== null && queued !== undefined) {
    for (const entry of queued) {
      const length: number = __netByteLen(entry.chunk, entry.encoding);
      if (length === 0) {
        __netInvoke(entry.callback, [null]);
        continue;
      }
      const bytes: Buffer = Buffer.from(__netToBase64(entry.chunk, entry.encoding), "base64");
      state.queue.push({ buf: bytes, offset: 0, callback: entry.callback });
      state.queued = Number(state.queued) + length;
    }
  }
  // Node's `afterConnect` applies the two socket options here, through the
  // handle wrap -- which is what a test that replaced `_handle.setNoDelay`
  // observes.
  if (state.optNoDelay === true) __netSetNoDelay(self, true);
  if (state.optKeepAlive === true) {
    __netSetKeepAlive(self, true, state.optKeepAliveDelay);
  }
  self.emit("ready");
  __netResetTimeout(self);
  __netUpdateReadInterest(self);
  __netFlush(self);
}

// ---------------------------------------------------------------------------
// Socket: timeouts and options
// ---------------------------------------------------------------------------

function __netSetTimeout(self: any, msecs: any, callback: any): void {
  const state: any = self._sockState;
  const value: number = Number(msecs);
  if (Number.isNaN(value) || value < 0) {
    throw new ERR_OUT_OF_RANGE("msecs", "a non-negative finite number", msecs);
  }
  __netClearTimeout(self);
  state.timeout = value;
  if (callback !== undefined && callback !== null) {
    if (!__netIsFn(callback)) {
      throw new ERR_INVALID_ARG_TYPE("callback", "Function", callback);
    }
    if (value === 0) {
      self.removeListener("timeout", callback);
    } else {
      self.once("timeout", callback);
    }
  }
  if (value > 0) __netArmTimeout(self);
}

// The idle timer. `setTimeout` here is `src/timers/timers.ts`' Node-shaped
// function, which shadows the engine intrinsic program-wide — so it accepts
// this `any`-typed callback where the intrinsic would reject it (zun#29).
function __netArmTimeout(self: any): void {
  const state: any = self._sockState;
  const value: number = Number(state.timeout);
  if (value <= 0) return;
  state.timer = setTimeout(function (): void {
    __netOnTimeout(self);
  }, value);
}

function __netClearTimeout(self: any): void {
  const state: any = self._sockState;
  if (state.timer !== null && state.timer !== undefined) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

// Every byte read or written restarts the clock, which is what makes
// `setTimeout` an *idle* timeout.
function __netResetTimeout(self: any): void {
  const state: any = self._sockState;
  if (Number(state.timeout) <= 0) return;
  __netClearTimeout(self);
  __netArmTimeout(self);
}

function __netOnTimeout(self: any): void {
  const state: any = self._sockState;
  state.timer = null;
  if (self.destroyed === true) return;
  self.emit("timeout");
  // Node does not destroy on timeout; the listener decides. The clock is not
  // re-armed either — Node re-arms from the next read or write.
}

// ---------------------------------------------------------------------------
// `socket._handle`
// ---------------------------------------------------------------------------
//
// In Node `_handle` is the libuv `TCP` wrap, and it is **observable**: four
// files in this corpus *replace* one of its methods
// (`client._handle.setNoDelay = common.mustCall(...)`) to check that the socket
// reaches the kernel through it, and `test-net-persistent-ref-unref.js`
// replaces `ref`/`unref`. So `_handle` here is an object of the same shape over
// the loop's numeric handle rather than the number itself, and every socket
// option goes *through* it — which is what makes a replaced method get called.
//
// It is an object literal because an object-literal method survives every path
// through an `any` while a bare function value does not (zun#17).
function __netHandleWrap(self: any, id: number): any {
  return {
    // Node's `fd`, which is the real descriptor on POSIX and -1 on Windows.
    // The loop's handle number is the honest answer here (see src/io/mod.rs on
    // why the published number is the table's own).
    fd: id,
    setNoDelay(enable?: any): void {
      __netSockOpt(id, "noDelay", enable === undefined ? true : enable === true, 0);
    },
    setKeepAlive(enable?: any, initialDelay?: any): void {
      __netSockOpt(
        id,
        "keepAlive",
        enable === undefined ? true : enable === true,
        initialDelay === undefined || initialDelay === null ? 0 : Number(initialDelay),
      );
    },
    ref(): void {
      __ioRef(id);
    },
    unref(): void {
      __ioUnref(id);
    },
    readStart(): void {
      __ioWant(id, 1);
    },
    readStop(): void {
      __ioUnwant(id, 1);
    },
  };
}

function __netSockOpt(id: number, name: string, on: boolean, value: number): void {
  if (id === 0) return;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return;
  ops.sockOpt(id, name, on ? 1 : 0, value);
}

function __netSetNoDelay(self: any, enable: boolean): void {
  const wrap: any = self._handle;
  if (wrap === null || wrap === undefined) return;
  const fn: any = wrap.setNoDelay;
  if (__netIsFn(fn)) __netInvoke(fn, [enable]);
}

function __netSetKeepAlive(self: any, enable: boolean, initialDelay: any): void {
  const wrap: any = self._handle;
  if (wrap === null || wrap === undefined) return;
  const fn: any = wrap.setKeepAlive;
  if (__netIsFn(fn)) __netInvoke(fn, [enable, initialDelay]);
}

// ---------------------------------------------------------------------------
// Socket: addresses
// ---------------------------------------------------------------------------

// The `{ address, family, port }` an address-bearing native result decodes to.
function __netTriple(parts: any): any {
  return {
    address: String(parts[0]),
    family: String(parts[2]),
    port: Number(parts[1]),
  };
}

// `socket.address()` / `localAddress` & co., cached the way Node caches
// `_sockname`.
function __netSockName(self: any): any {
  const state: any = self._sockState;
  if (state.local !== null && state.local !== undefined) return state.local;
  const handle: number = Number(state.handle);
  if (handle === 0) return null;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return null;
  const payload: any = ops.sockName(handle);
  if (__ioFailed(payload)) return null;
  state.local = __netTriple(__ioFields(payload));
  return state.local;
}

function __netPeerName(self: any): any {
  const state: any = self._sockState;
  if (state.peer !== null && state.peer !== undefined) return state.peer;
  const handle: number = Number(state.handle);
  if (handle === 0) return null;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return null;
  const payload: any = ops.peerName(handle);
  if (__ioFailed(payload)) return null;
  state.peer = __netTriple(__ioFields(payload));
  return state.peer;
}

// ---------------------------------------------------------------------------
// _normalizeArgs (`lib/net.js`)
// ---------------------------------------------------------------------------
//
// Node's own helper, and part of the public-ish surface: two files in the
// corpus call `net._normalizeArgs` directly. It turns every `connect` /
// `listen` argument shape into `[options, callback]`.
// ---------------------------------------------------------------------------
// Why the callback does not travel with the options
// ---------------------------------------------------------------------------
//
// Node's `_normalizeArgs` answers `[options, callback]`, and the first version
// of this module did the same — with the result that
// `server.listen(0, () => {})` silently never called back while
// `server.on('listening', fn)` worked. A function put into an **array literal
// that is then returned** does not come back as a callable here
// (zun#17: a function value only survives the `any` lane inside the
// `functionBox` record `__evBox` makes). `common.mustCall()` *is* such a
// record, which is why every probe written with the harness passed and every
// probe written with a bare function hung.
//
// So the two facts are read out of the argument list separately and neither
// ever enters a new array: `__netNormalizeOptions` answers the options object,
// and `__netAttachListener` registers the callback straight from the argument
// list onto the emitter. `__netNormalizeArgs` below still exists, because
// `net._normalizeArgs` is reached by two files in the corpus, and it is the one
// place that pays the cost.
// Node's `normalizedArgsSymbol`, which `_normalizeArgs` stamps onto the array
// it answers and `Socket.prototype.connect` looks for: an *unstamped* array is
// not a valid argument list, and `socket.connect([{ port }, fn])` is
// `ERR_MISSING_ARGS`. `test-net-normalize-args.js` requires the symbol through
// `internal/net`, which the bundler serves from this module object.
const __netNormalizedArgs: any = Symbol("normalizedArgs");

function __netNormalizeArgs(args: any): any[] {
  const count: number = args === undefined || args === null ? 0 : Number(args.length);
  const a0: any = count > 0 ? args[0] : undefined;
  const a1: any = count > 1 ? args[1] : undefined;
  const a2: any = count > 2 ? args[2] : undefined;
  const a3: any = count > 3 ? args[3] : undefined;
  const options: any = __netNormalizeOptions(a0, a1);
  const last: any = count === 0 ? undefined : __netLastFn(a0, a1, a2, a3);
  const result: any = [options, last === undefined ? null : last];
  result[__netNormalizedArgs] = true;
  return result;
}

// Register the trailing callback of a `connect`/`listen` argument list as a
// one-shot listener for `event`. See the note above for why it is done here
// rather than by handing the function back, and `Socket.prototype.connect` for
// why the arguments arrive one by one.
function __netAttachListener(self: any, event: string, a: any, b: any, c: any, d: any): void {
  if (__netIsFn(d)) {
    self.once(event, d);
    return;
  }
  if (__netIsFn(c)) {
    self.once(event, c);
    return;
  }
  if (__netIsFn(b)) {
    self.once(event, b);
    return;
  }
  if (__netIsFn(a)) self.once(event, a);
}

// Which of the four arguments is the trailing callback, for the one caller
// (`net._normalizeArgs`) that has to hand it back rather than register it.
function __netLastFn(a: any, b: any, c: any, d: any): any {
  if (__netIsFn(d)) return d;
  if (__netIsFn(c)) return c;
  if (__netIsFn(b)) return b;
  if (__netIsFn(a)) return a;
  return undefined;
}

// The options object a `connect`/`listen` argument list describes.
function __netNormalizeOptions(first: any, second: any): any {
  const options: any = {};
  if (first === undefined) {
    return options;
  }
  if (__netIsFn(first)) {
    // `listen(cb)`: no port at all, which Node reads as port 0. This test comes
    // *first*, because a boxed callable is also an object (see
    // `__netIsOptionsObj`).
    return options;
  }
  if (__netIsOptionsObj(first)) {
    // `connect(options[, cb])` — the caller's own object, as Node uses it.
    return first;
  }
  if (__netIsPipeName(first)) {
    options.path = first;
    return options;
  }
  options.port = first;
  if (typeof second === "string") {
    options.host = second;
  }
  return options;
}

// Node's `isPipeName`: a string that is not a number is a pipe path.
function __netIsPipeName(value: any): boolean {
  if (typeof value !== "string") return false;
  const text: string = value;
  if (text === "") return true;
  return Number.isNaN(Number(text));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

class Server extends EventEmitter {
  // Node's own enumerable fields, several of which the corpus reads.
  _connections: any = 0;
  maxConnections: any = Infinity;
  allowHalfOpen: any = false;
  pauseOnConnect: any = false;
  noDelay: any = false;
  keepAlive: any = false;
  keepAliveInitialDelay: any = 0;
  highWaterMark: any = undefined;
  _handle: any = null;
  _srvState: any = null;

  constructor(options?: any, connectionListener?: any) {
    super();

    let settings: any = options;
    let listener: any = connectionListener;
    if (__netIsFn(settings)) {
      listener = settings;
      settings = {};
    } else if (settings === undefined || settings === null) {
      settings = {};
    } else if (!__netIsObj(settings)) {
      throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
    }

    this._srvState = {
      // The listening handle, or 0.
      handle: 0,
      listening: false,
      // The sockets this server accepted and that are still open — the set
      // `close()` waits for and `getConnections` counts.
      sockets: [],
      // Set by `close()`: stop accepting and emit `'close'` when empty.
      closing: false,
      closeCallbacks: [],
      // The address the handle is bound to, cached like Node's `_sockname`.
      address: null,
      // `server.unref()` asked for before the handle exists.
      //
      // `listen()` binds on a later tick, and `test-net-server-unref.js` calls
      // `s.listen(0); s.unref();` back to back -- so the `unref` arrives with
      // no handle to apply it to and has to be remembered, which is what
      // Node's own `_unref` flag does.
      unrefPending: false,
    };

    this.allowHalfOpen = settings.allowHalfOpen === true;
    this.pauseOnConnect = settings.pauseOnConnect === true;
    this.noDelay = settings.noDelay === true;
    this.keepAlive = settings.keepAlive === true;
    this.keepAliveInitialDelay =
      settings.keepAliveInitialDelay === undefined
        ? 0
        : Number(settings.keepAliveInitialDelay);
    if (settings.highWaterMark !== undefined) this.highWaterMark = settings.highWaterMark;
    if (settings.maxConnections !== undefined) {
      this.maxConnections = Number(settings.maxConnections);
    }

    if (listener !== undefined && listener !== null) {
      if (!__netIsFn(listener)) {
        throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
      }
      this.on("connection", listener);
    }
  }

  // Four explicit optional parameters rather than `...args`; see
  // `Socket.prototype.connect` for why.
  listen(a?: any, b?: any, c?: any, d?: any): any {
    return __netServerListen(this, a, b, c, d);
  }

  close(callback?: any): any {
    return __netServerClose(this, callback);
  }

  address(): any {
    return __netServerAddress(this);
  }

  getConnections(callback: any): any {
    const self: any = this;
    __netTick(function (): void {
      __netInvoke(callback, [null, Number(self._srvState.sockets.length)]);
    });
    return this;
  }

  ref(): any {
    const state: any = this._srvState;
    state.unrefPending = false;
    if (Number(state.handle) !== 0) __ioRef(Number(state.handle));
    return this;
  }

  unref(): any {
    const state: any = this._srvState;
    if (Number(state.handle) === 0) {
      state.unrefPending = true;
      return this;
    }
    __ioUnref(Number(state.handle));
    return this;
  }

  get listening(): any {
    return this._srvState.listening === true;
  }

  // Node's deprecated `server.connections`, which a few files still read.
  get connections(): any {
    return Number(this._srvState.sockets.length);
  }

  set connections(value: any) {
    this._connections = value;
  }
}

// `listen`'s first argument, judged the way Node judges it.
//
// Node answers `ERR_INVALID_ARG_VALUE` in two wordings and
// `test-net-server-listen-options.js` asserts both: an *object* with neither
// `port` nor `path` "must have the property "port" or "path"", and anything
// else unusable "is invalid". A number, a numeric string, `null`, `undefined`
// and a callback are all fine and fall through to the port path (where a
// genuinely out-of-range port becomes `ERR_SOCKET_BAD_PORT` instead).
function __netValidateListenArgument(first: any): void {
  if (first === undefined || first === null) return;
  if (typeof first === "boolean") {
    throw new ERR_INVALID_ARG_VALUE("options", first, "is invalid");
  }
  if (!__netIsOptionsObj(first)) return;
  const hasPort: boolean = "port" in first && first.port !== undefined;
  const hasPath: boolean = "path" in first && first.path !== undefined;
  if (!hasPort && !hasPath) {
    throw new ERR_INVALID_ARG_VALUE(
      "options",
      first,
      'must have the property "port" or "path"',
    );
  }
  if (typeof first.port === "boolean") {
    throw new ERR_INVALID_ARG_VALUE("options", first, "is invalid");
  }
  // The port takes precedence over the path, so a bad *path* is only reported
  // when there is no port to complain about first — which is what makes
  // `listen({ port: -1, path })` an `ERR_SOCKET_BAD_PORT`.
  if (!hasPort && typeof first.path !== "string") {
    throw new ERR_INVALID_ARG_VALUE("options", first, "is invalid");
  }
}

// `server.listen(...)`, with Node's five argument shapes reduced to the two
// this runtime can serve.
function __netServerListen(self: any, a: any, b: any, c: any, d: any): any {
  const state: any = self._srvState;
  if (state.listening === true || Number(state.handle) !== 0) {
    throw new ERR_SERVER_ALREADY_LISTEN();
  }
  __netAttachListener(self, "listening", a, b, c, d);
  __netValidateListenArgument(a);
  const options: any = __netNormalizeOptions(a, b);

  // The port is validated **before** the path is looked at: in
  // `listen(options, cb)` Node gives the port precedence, so
  // `listen({ port: -1, path })` is `ERR_SOCKET_BAD_PORT` rather than anything
  // about the path. `test-net-server-listen-options.js` asserts exactly that.
  const port: number =
    options.port === undefined || options.port === null
      ? 0
      : __netValidatePort(options.port, "options.port", true);

  if (options.path !== undefined && options.path !== null) {
    throw new ERR_INVALID_ARG_VALUE(
      "options.path",
      options.path,
      "is not supported by node:net on this runtime (no pipe support)",
    );
  }
  if (options.fd !== undefined && options.fd !== null) {
    throw new ERR_INVALID_ARG_VALUE(
      "options.fd",
      options.fd,
      "is not supported by node:net on this runtime",
    );
  }

  // A backlog may ride either the options or the second positional argument.
  let backlog: number = 511;
  if (options.backlog !== undefined && options.backlog !== null) {
    backlog = Number(options.backlog);
  } else if (typeof b === "number") {
    // `listen(port, backlog[, cb])`
    backlog = Number(b);
  } else if (typeof c === "number") {
    // `listen(port, host, backlog[, cb])`
    backlog = Number(c);
  }
  if (Number.isNaN(backlog) || backlog < 0) backlog = 511;

  const host: any = options.host;
  const exclusive: boolean = options.exclusive === true;
  const ipv6Only: boolean = options.ipv6Only === true;

  if (options.signal !== undefined && options.signal !== null) {
    __netListenSignal(self, options.signal);
  }

  if (host === undefined || host === null) {
    // Node binds the IPv6 wildcard when it can and falls back to IPv4; the
    // native side's dual-stack `::` is the same reachability, and `ipv6Only`
    // is the documented opt-out.
    __netTick(__netBindNow, self, {
      address: ipv6Only ? "6" : "",
      port: port,
      backlog: backlog,
      exclusive: exclusive,
      ipv6Only: ipv6Only,
    });
    return self;
  }

  const name: string = String(host);
  if (__netIsIP(name) !== 0) {
    __netTick(__netBindNow, self, {
      address: name,
      port: port,
      backlog: backlog,
      exclusive: exclusive,
      ipv6Only: ipv6Only,
    });
    return self;
  }

  const request: any = {
    server: self,
    port: port,
    backlog: backlog,
    exclusive: exclusive,
    ipv6Only: ipv6Only,
  };
  __netDefaultLookup(name, { family: 0 }, __evBox(function (err: any, address: any): void {
    if (err !== null && err !== undefined) {
      self.emit("error", err);
      return;
    }
    __netBindNow(self, {
      address: String(address),
      port: Number(request.port),
      backlog: Number(request.backlog),
      exclusive: request.exclusive,
      ipv6Only: request.ipv6Only,
    });
  }));
  return self;
}

// `AbortSignal` support for `listen({ signal })`.
//
// The type check is not decoration: reading `.aborted` off a *string* panics
// the interpreter here rather than answering `undefined`
// (https://github.com/UrubuCode/zun/issues/76), and
// `test-net-server-listen-options-signal.js` opens by passing
// `signal: 'INVALID_SIGNAL'` and expecting `ERR_INVALID_ARG_TYPE`.
function __netListenSignal(self: any, signal: any): void {
  if (!__netIsObj(signal) || !__netIsFn(signal.addEventListener)) {
    throw new ERR_INVALID_ARG_TYPE("options.signal", "AbortSignal", signal);
  }
  if (signal.aborted === true) {
    __netTick(function (): void {
      __netServerClose(self, undefined);
    });
    return;
  }
  signal.addEventListener(
    "abort",
    __evBox(function (): void {
      __netServerClose(self, undefined);
    }),
    { once: true },
  );
}

// Bind, listen and register the handle.
function __netBindNow(self: any, request: any): void {
  const state: any = self._srvState;
  if (state.closing === true) return;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) {
    self.emit(
      "error",
      new NodeError(
        "ERR_METHOD_NOT_IMPLEMENTED",
        "node:net needs the zun-node native extension (run with --ext)",
      ),
    );
    return;
  }
  let flags = 0;
  if (request.ipv6Only === true) flags = flags | 1;
  if (request.exclusive === true) flags = flags | 2;
  const payload: any = ops.listen(
    String(request.address),
    Number(request.port),
    Number(request.backlog),
    flags,
  );
  if (__ioFailed(payload)) {
    const info: any = __ioLastError();
    // A `listen` failure is Node's *described* shape:
    // `listen EADDRINUSE: address already in use 0.0.0.0:8080`. The syscall is
    // named `listen` even when it was `bind` that failed, because `lib/net.js`
    // composes the error with that name either way --
    // `test-net-better-error-messages-listen.js` asserts
    // `e.syscall === 'listen'` for a bind that could not get the address.
    self.emit("error", __netSystemError(info, "listen", undefined, true));
    return;
  }
  const parts: any[] = __ioFields(payload);
  const handle: number = Number(parts[0]);
  state.handle = handle;
  self._handle = handle;
  state.address = {
    address: String(parts[1]),
    family: String(parts[3]),
    port: Number(parts[2]),
  };
  state.listening = true;
  __ioRegister(handle, {
    readable(): void {
      __netOnConnection(self);
    },
    writable(): void {},
    failed(): void {},
  });
  __ioWant(handle, 1);
  // An `unref()` that arrived before the bind did; see `unrefPending`.
  if (state.unrefPending === true) {
    state.unrefPending = false;
    __ioUnref(handle);
  }
  self.emit("listening");
}

// The listening handle is readable: accept everything pending.
function __netOnConnection(self: any): void {
  const state: any = self._srvState;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return;
  while (true) {
    const handle: number = Number(state.handle);
    if (handle === 0) return;
    const payload: any = ops.accept(handle);
    if (__ioFailed(payload)) {
      const info: any = __ioLastError();
      // `ECONNABORTED` is a connection the peer gave up on before it was
      // accepted, which libuv swallows rather than reporting.
      if (String(info.code) !== "ECONNABORTED") {
        self.emit("error", __netSystemError(info));
      }
      return;
    }
    const text: string = String(payload);
    if (text === "+A" || text === "+") return;
    const parts: any[] = __ioFields(text);
    const accepted: number = Number(parts[0]);
    const remote: any = {
      address: String(parts[1]),
      family: String(parts[3]),
      port: Number(parts[2]),
    };
    const local: any = {
      address: String(parts[4]),
      family: String(parts[3]),
      port: Number(parts[5]),
    };
    if (Number(state.sockets.length) >= Number(self.maxConnections)) {
      // Node closes the connection and emits `'drop'` with what it knows
      // about it, which is exactly this triple.
      __ioRegister(accepted, {
        readable(): void {},
        writable(): void {},
        failed(): void {},
      });
      __ioUnregister(accepted);
      self.emit("drop", {
        localAddress: local.address,
        localPort: local.port,
        localFamily: local.family,
        remoteAddress: remote.address,
        remotePort: remote.port,
        remoteFamily: remote.family,
      });
      continue;
    }
    __netAcceptSocket(self, accepted, remote, local);
  }
}

// Build the `Socket` for an accepted connection and emit `'connection'`.
function __netAcceptSocket(self: any, handle: number, remote: any, local: any): void {
  const state: any = self._srvState;
  const options: any = {
    handle: handle,
    allowHalfOpen: self.allowHalfOpen === true,
    remote: remote,
    local: local,
  };
  if (self.highWaterMark !== undefined) options.highWaterMark = self.highWaterMark;
  const socket: any = new Socket(options);
  socket._server = self;
  state.sockets.push(socket);
  self._connections = Number(state.sockets.length);
  if (self.noDelay === true) __netSetNoDelay(socket, true);
  if (self.keepAlive === true) {
    __netSetKeepAlive(socket, true, self.keepAliveInitialDelay);
  }
  if (self.pauseOnConnect === true) socket.pause();
  self.emit("connection", socket);
}

// One of this server's sockets closed: drop it, and finish a pending `close()`.
function __netServerConnectionClosed(self: any): void {
  const state: any = self._srvState;
  const remaining: any[] = [];
  for (const socket of state.sockets) {
    if (socket.destroyed !== true) remaining.push(socket);
  }
  state.sockets = remaining;
  self._connections = Number(remaining.length);
  if (state.closing === true && Number(remaining.length) === 0) {
    __netServerEmitClose(self);
  }
}

// `server.close([cb])` — stop accepting, then emit `'close'` once every
// accepted socket is gone. Node calls the callback with `ERR_SERVER_NOT_RUNNING`
// when the server was not listening, and the error is *not* emitted.
function __netServerClose(self: any, callback: any): any {
  const state: any = self._srvState;
  if (callback !== undefined && callback !== null) {
    if (state.listening !== true && Number(state.handle) === 0) {
      __netTick(function (): void {
        __netInvoke(callback, [new ERR_SERVER_NOT_RUNNING()]);
      });
    } else {
      state.closeCallbacks.push(callback);
    }
  }
  const handle: number = Number(state.handle);
  if (handle !== 0) {
    state.handle = 0;
    self._handle = null;
    state.listening = false;
    __ioUnregister(handle);
  }
  state.closing = true;
  if (Number(state.sockets.length) === 0) {
    __netTick(__netServerEmitClose, self);
  }
  return self;
}

function __netServerEmitClose(self: any): void {
  const state: any = self._srvState;
  if (state.closing !== true) return;
  state.closing = false;
  state.listening = false;
  const callbacks: any[] = state.closeCallbacks;
  state.closeCallbacks = [];
  self.emit("close");
  for (const callback of callbacks) __netInvoke(callback, [null]);
}

// `server.address()`. Node answers `null` before `listen` and after `close`.
function __netServerAddress(self: any): any {
  const state: any = self._srvState;
  if (state.listening !== true) return null;
  if (state.address !== null && state.address !== undefined) return state.address;
  const handle: number = Number(state.handle);
  if (handle === 0) return null;
  const ops: any = __netOps();
  if (ops === null || ops === undefined) return null;
  const payload: any = ops.sockName(handle);
  if (__ioFailed(payload)) return null;
  const parts: any[] = __ioFields(payload);
  state.address = {
    address: String(parts[0]),
    family: String(parts[2]),
    port: Number(parts[1]),
  };
  return state.address;
}

// ---------------------------------------------------------------------------
// BlockList (`lib/internal/blocklist.js`)
// ---------------------------------------------------------------------------
//
// Pure computation: a list of rules and a membership test. The addresses are
// compared numerically, which is why the parsers above return digits rather
// than only a verdict.

// An address as a list of big-endian bytes — four for IPv4, sixteen for IPv6 —
// so one comparison routine serves both families.
function __netAddressBytes(address: any, family: any): any {
  const name: string = family === undefined || family === null ? "" : String(family).toLowerCase();
  if (name === "" || name === "ipv4") {
    const octets: any = __netParseIPv4(String(address));
    if (octets !== null) return { bytes: octets, family: "ipv4" };
    if (name === "ipv4") return null;
  }
  if (name === "" || name === "ipv6") {
    const groups: any = __netParseIPv6(String(address));
    if (groups === null) return null;
    const bytes: number[] = [];
    for (const group of groups) {
      bytes.push((Number(group) >> 8) & 0xff);
      bytes.push(Number(group) & 0xff);
    }
    return { bytes: bytes, family: "ipv6" };
  }
  return null;
}

// -1, 0 or 1, lexicographic over the bytes — which for a big-endian address is
// numeric order.
function __netCompareBytes(left: any, right: any): number {
  const count: number = Number(left.length);
  for (let i = 0; i < count; i++) {
    const a: number = Number(left[i]);
    const b: number = Number(right[i]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

// Do `left` and `right` agree on their first `prefix` bits?
function __netSamePrefix(left: any, right: any, prefix: number): boolean {
  let remaining: number = prefix;
  let index = 0;
  while (remaining >= 8) {
    if (Number(left[index]) !== Number(right[index])) return false;
    index = index + 1;
    remaining = remaining - 8;
  }
  if (remaining === 0) return true;
  const mask: number = (0xff << (8 - remaining)) & 0xff;
  return (Number(left[index]) & mask) === (Number(right[index]) & mask);
}

class BlockList {
  rules: any = null;

  constructor() {
    this.rules = [];
  }

  addAddress(address: any, family?: any): void {
    const parsed: any = __netBlockAddress(address, family, "address");
    this.rules.push({ kind: "address", family: parsed.family, bytes: parsed.bytes });
  }

  addRange(start: any, end: any, family?: any): void {
    const first: any = __netBlockAddress(start, family, "start");
    const last: any = __netBlockAddress(end, family, "end");
    if (__netCompareBytes(last.bytes, first.bytes) < 0) {
      throw new ERR_INVALID_ARG_VALUE("start", start, "must come before end");
    }
    this.rules.push({
      kind: "range",
      family: first.family,
      bytes: first.bytes,
      end: last.bytes,
    });
  }

  addSubnet(network: any, prefix: any, family?: any): void {
    const parsed: any = __netBlockAddress(network, family, "network");
    const bits: number = Number(prefix);
    const limit: number = parsed.family === "ipv4" ? 32 : 128;
    if (Number.isNaN(bits) || bits !== Math.floor(bits) || bits < 0 || bits > limit) {
      throw new ERR_OUT_OF_RANGE("prefix", ">= 0 && <= " + String(limit), prefix);
    }
    this.rules.push({
      kind: "subnet",
      family: parsed.family,
      bytes: parsed.bytes,
      prefix: bits,
    });
  }

  check(address: any, family?: any): boolean {
    let probe: any = null;
    if (__netIsObj(address) && address.address !== undefined) {
      // A `SocketAddress` is accepted wherever an address string is.
      probe = __netAddressBytes(address.address, address.family);
    } else {
      probe = __netAddressBytes(address, family);
    }
    if (probe === null) return false;
    for (const rule of this.rules) {
      if (String(rule.family) !== String(probe.family)) continue;
      if (rule.kind === "address") {
        if (__netCompareBytes(rule.bytes, probe.bytes) === 0) return true;
      } else if (rule.kind === "range") {
        if (
          __netCompareBytes(probe.bytes, rule.bytes) >= 0 &&
          __netCompareBytes(probe.bytes, rule.end) <= 0
        ) {
          return true;
        }
      } else if (__netSamePrefix(rule.bytes, probe.bytes, Number(rule.prefix))) {
        return true;
      }
    }
    return false;
  }

  // Node's inspection surface: one line per rule, in the wording
  // `test-net-blocklist.js` compares against.
  get rulesList(): any {
    const list: any[] = [];
    for (const rule of this.rules) {
      const family: string = String(rule.family);
      if (rule.kind === "address") {
        list.push("Address: " + family.toUpperCase() + " " + __netFormatBytes(rule.bytes, family));
      } else if (rule.kind === "range") {
        list.push(
          "Range: " +
            family.toUpperCase() +
            " " +
            __netFormatBytes(rule.bytes, family) +
            "-" +
            __netFormatBytes(rule.end, family),
        );
      } else {
        list.push(
          "Subnet: " +
            family.toUpperCase() +
            " " +
            __netFormatBytes(rule.bytes, family) +
            "/" +
            String(rule.prefix),
        );
      }
    }
    return list;
  }
}

// One address argument of a `BlockList` method, validated the way Node
// validates it.
function __netBlockAddress(address: any, family: any, name: string): any {
  if (__netIsObj(address) && address.address !== undefined) {
    const parsed: any = __netAddressBytes(address.address, address.family);
    if (parsed === null) throw new ERR_INVALID_ARG_VALUE(name, address, "must be a valid address");
    return parsed;
  }
  if (typeof address !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, ["string", "SocketAddress"], address);
  }
  if (family !== undefined && family !== null) {
    const name2: string = String(family).toLowerCase();
    if (name2 !== "ipv4" && name2 !== "ipv6") {
      throw new ERR_INVALID_ARG_VALUE("family", family, "must be one of: ipv4, ipv6");
    }
  }
  const parsed: any = __netAddressBytes(address, family);
  if (parsed === null) throw new __NetInvalidIpAddress(address);
  return parsed;
}

// The canonical text of an address held as bytes.
function __netFormatBytes(bytes: any, family: string): string {
  if (family === "ipv4") {
    return (
      String(Number(bytes[0])) +
      "." +
      String(Number(bytes[1])) +
      "." +
      String(Number(bytes[2])) +
      "." +
      String(Number(bytes[3]))
    );
  }
  const groups: string[] = [];
  for (let i = 0; i < 16; i = i + 2) {
    groups.push((Number(bytes[i]) * 256 + Number(bytes[i + 1])).toString(16));
  }
  return groups.join(":");
}

// ---------------------------------------------------------------------------
// SocketAddress (`lib/internal/socketaddress.js`)
// ---------------------------------------------------------------------------

class SocketAddress {
  address: any = "";
  family: any = "ipv4";
  port: any = 0;
  flowlabel: any = 0;

  constructor(options?: any) {
    const settings: any = options === undefined || options === null ? {} : options;
    if (!__netIsObj(settings)) {
      throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
    }
    let family: string =
      settings.family === undefined || settings.family === null
        ? "ipv4"
        : String(settings.family).toLowerCase();
    if (family !== "ipv4" && family !== "ipv6") {
      throw new ERR_INVALID_ARG_VALUE("options.family", settings.family, "must be one of: ipv4, ipv6");
    }
    const fallback: string = family === "ipv4" ? "127.0.0.1" : "::";
    const address: string =
      settings.address === undefined || settings.address === null
        ? fallback
        : String(settings.address);
    if (family === "ipv4" ? !__netIsIPv4(address) : !__netIsIPv6(address)) {
      throw new ERR_INVALID_ARG_VALUE("options.address", settings.address, "must be a valid address");
    }
    const port: number =
      settings.port === undefined || settings.port === null ? 0 : Number(settings.port);
    if (Number.isNaN(port) || port !== Math.floor(port) || port < 0 || port > 65535) {
      throw new ERR_OUT_OF_RANGE("options.port", ">= 0 && <= 65535", settings.port);
    }
    const flowlabel: number =
      settings.flowlabel === undefined || settings.flowlabel === null
        ? 0
        : Number(settings.flowlabel);
    if (Number.isNaN(flowlabel) || flowlabel < 0) {
      throw new ERR_OUT_OF_RANGE("options.flowlabel", ">= 0", settings.flowlabel);
    }
    this.address = address;
    this.family = family;
    this.port = port;
    this.flowlabel = flowlabel;
  }

  toJSON(): any {
    return {
      address: this.address,
      family: this.family,
      port: this.port,
      flowlabel: this.flowlabel,
    };
  }

  // `SocketAddress.parse('1.2.3.4:1234')`, Node 22's addition.
  static parse(input: any): any {
    const text: string = String(input);
    if (text.charAt(0) === "[") {
      const end: number = Number(text.indexOf("]"));
      if (end === -1) return undefined;
      const address: string = text.slice(1, end);
      const rest: string = text.slice(end + 1);
      const port: number = rest.charAt(0) === ":" ? Number(rest.slice(1)) : 0;
      if (!__netIsIPv6(address) || Number.isNaN(port)) return undefined;
      return new SocketAddress({ address: address, family: "ipv6", port: port });
    }
    const colon: number = Number(text.lastIndexOf(":"));
    const address: string = colon === -1 ? text : text.slice(0, colon);
    const port: number = colon === -1 ? 0 : Number(text.slice(colon + 1));
    if (!__netIsIPv4(address) || Number.isNaN(port)) return undefined;
    return new SocketAddress({ address: address, family: "ipv4", port: port });
  }
}

// ---------------------------------------------------------------------------
// The module factories
// ---------------------------------------------------------------------------

function __netCreateServer(options?: any, connectionListener?: any): any {
  return new Server(options, connectionListener);
}

function __netConnect(a: any, b: any, c: any, d: any): any {
  const options: any = __netNormalizeOptions(a, b);
  const socket: any = new Socket(options);
  if (options.timeout !== undefined && options.timeout !== null) {
    __netSetTimeout(socket, options.timeout, undefined);
  }
  // The callback is registered straight from the caller's arguments; see the
  // note above `__netNormalizeArgs`.
  __netAttachListener(socket, "connect", a, b, c, d);
  return __netSocketConnectOptions(socket, options);
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------
//
// Object-literal methods delegating to the top-level functions above: a bare
// function value does not survive every path through `any` while a method does
// (zun#17).
const __node_net: any = {
  Socket: Socket,
  Server: Server,
  // `net.Stream` is Node's historical alias for `Socket`, still exported and
  // still used by four files in the corpus.
  Stream: Socket,
  BlockList: BlockList,
  SocketAddress: SocketAddress,

  createServer(options?: any, connectionListener?: any): any {
    return __netCreateServer(options, connectionListener);
  },

  // Four explicit optional parameters rather than `...args`, for the reason
  // `Socket.prototype.connect` documents.
  createConnection(a?: any, b?: any, c?: any, d?: any): any {
    return __netConnect(a, b, c, d);
  },

  connect(a?: any, b?: any, c?: any, d?: any): any {
    return __netConnect(a, b, c, d);
  },

  isIP(input?: any): number {
    return __netIsIP(input);
  },

  isIPv4(input?: any): boolean {
    return __netIsIPv4(input);
  },

  isIPv6(input?: any): boolean {
    return __netIsIPv6(input);
  },

  getDefaultAutoSelectFamily(): boolean {
    return __netGetDefaultAutoSelectFamily();
  },

  setDefaultAutoSelectFamily(value: any): void {
    __netSetDefaultAutoSelectFamily(value);
  },

  getDefaultAutoSelectFamilyAttemptTimeout(): number {
    return __netGetDefaultAutoSelectFamilyAttemptTimeout();
  },

  setDefaultAutoSelectFamilyAttemptTimeout(value: any): void {
    __netSetDefaultAutoSelectFamilyAttemptTimeout(value);
  },

  _normalizeArgs(args: any): any {
    return __netNormalizeArgs(args);
  },

  // `internal/net`'s one export the corpus reaches for. The bundler serves
  // `require('internal/net')` from this same object (see MODULE_SPECS), which
  // is how `test-net-normalize-args.js` gets it.
  normalizedArgsSymbol: __netNormalizedArgs,
};

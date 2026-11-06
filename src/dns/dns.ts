// node:dns and node:dns/promises — the Node-shaped `dns` module, in Zun
// TypeScript over the native `node:dns` extension.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-dns*.js` files (see ../../test/dns/).
// The API shaping follows Node's `lib/dns.js`, `lib/dns/promises.js` and
// `lib/internal/dns/{utils,callback_resolver,promises}.js` (MIT, Copyright
// Joyent, Inc. and other Node contributors): the `setServers` address grammar,
// the `lookup` argument cascade, the `DNSException` message and the fabricated
// `ENOTFOUND`, the `resolveMap` dispatch of `resolve(name, rrtype)` and the
// per-record result shapes. `isIP` follows `lib/internal/net.js`. None of that
// is derivable — it is observable through the corpus.
//
// ---------------------------------------------------------------------------
// Why this module is split in two
// ---------------------------------------------------------------------------
//
// The seam is PLAN.md principle 2, drawn where Node draws it between
// `lib/dns.js` and `src/cares_wrap.cc`:
//
//   * `src/dns/*.rs` answers what needs the operating system or the network —
//     the system resolver (`getaddrinfo`/`getnameinfo`), the machine's
//     configured resolvers, and the DNS wire protocol.
//   * this file is everything that is shape rather than syscall: `isIP`, the
//     `Resolver` classes, the argument validation, the error classes, the
//     record shapes and the two module objects.
//
// Nothing structured can cross ABI v1, whose carrier is one scalar word, so the
// natives hand this file status-prefixed, separator-delimited records and this
// file parses them; the grammar is documented in `src/dns/mod.rs` and is the
// mirror image of `__dnsRecords` below:
//
//     result  := "+" payload | "-" error    payload := record (RS record)*
//     record  := field (US field)*          RS = U+001E     US = U+001F
//
// The one difference from `node:os`'s use of the same carrier is what follows
// the `"-"`. A `dns` failure is not a `SystemError`: Node's binding returns a
// *value* — a libuv errno from `getaddrinfo`, a c-ares code name from a query —
// and `DNSException` switches on `typeof code === 'number'` to turn either into
// an error. So the payload after `"-"` is that value verbatim, and
// `__dnsErrorValue` recovers which of the two it is. Failure is in band rather
// than through the ABI's status for the reason `src/os/os.ts` documents
// (https://github.com/UrubuCode/zun/issues/33).
//
// ---------------------------------------------------------------------------
// The internal binding, and why it is shaped like Node's
// ---------------------------------------------------------------------------
//
// `__dnsCares` below is deliberately the shape of Node's
// `internalBinding('cares_wrap')`: `getaddrinfo`, `getnameinfo`, `strerror`,
// the `AI_*`/`DNS_ORDER_*` constants, and a `ChannelWrap` whose `prototype`
// carries one method per query type. That is not decoration. Node's own module
// is written against exactly this interface, so following it keeps every
// algorithm above it a transcription rather than a reinvention — and it gives
// the one seam Node's own tests reach for: nine files in this corpus replace
// `cares.getaddrinfo`, `cares.getnameinfo` or
// `cares.ChannelWrap.prototype.queryA` before requiring `dns`, to drive the
// error paths that would otherwise need a DNS server. `tools/harness/binding.ts`
// serves `require('internal/test/binding')` from this object.
//
// Two deviations from Node's binding are forced by the engine and are marked at
// their use sites:
//
//   * every completion callback is an **arrow closure over its request**, not
//     the shared `function onlookup(err, addresses) { this.callback(...) }`
//     Node installs: a top-level function assigned to an object property is
//     called with `this === undefined` here, while an object-literal method
//     keeps its receiver (zun#17/#19 are the same gap seen from two other
//     angles). The closure is observationally the same thing — the corpus calls
//     `req.oncomplete(err, addresses)` and gets the request's own completion.
//   * a `ChannelWrap.prototype` method is called with `(req, name)` and reads
//     its channel out of `__dnsChannelSlot`, because `this` cannot be threaded
//     into it either. The argument positions are Node's, which is what a test
//     that replaces one of those methods observes.
//
// ---------------------------------------------------------------------------
// Synchronous natives, asynchronous API
// ---------------------------------------------------------------------------
//
// ABI v1 gives an extension no way to complete a call later, so every native
// here blocks. The *observable* asynchrony of Node's API is restored on this
// side: a resolution is delivered through `process.nextTick`, so a callback
// still runs on a later tick than its caller and a `Resolver` still has a
// pending-query window for `setServers` to refuse. What is not restored is
// concurrency — two queries issued back to back run one after the other.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `Number(x.length)` throughout: the checker still types `.length` as `u64`,
//     so it can be neither assigned to nor passed as a `number` (zun#3).
//   * `__cc(s, i)` (from util.ts) instead of `s.charCodeAt(i)`, and `charAt`
//     instead of `s[i]`, in the two address parsers (zun#2).
//   * the module objects' functions are **object-literal methods** delegating
//     to top-level `__dns*` functions: a bare function value does not survive
//     every path through `any`, while a method does (zun#17).
//   * no dynamic method call takes seven or more arguments (zun#10), which is
//     why `__dnsLookupImpl` takes an options record rather than a flat list.
//   * `x ? true : false` rather than `!x` wherever `x` is an `any` that may be
//     the empty string (zun#13) — `__dnsTruthy` below, which takes the value
//     through a parameter so constant folding cannot hide the gap.
//   * `message` is installed with `Object.defineProperty` in `DNSException`
//     rather than left to `Error`: an `Error` here has no own `message`
//     property at all, and `test-dns-lookup.js` asserts that the descriptor
//     exists and is non-enumerable.
//   * the promise `Resolver` is declared as `DnsPromiseResolver`, not as a
//     second `Resolver`: both module objects bind the name `Resolver` to two
//     different classes, `new <object>.Ctor()` does not reach a constructor
//     (zun#18), and two top-level declarations of one name are a compile
//     error — so `tools/bundle_node_test.sh` rewrites `<alias>.promises.Resolver`
//     to this class, the same move it makes for `stream.Readable`.

import * as __dnsNative from "node:dns";

// ---------------------------------------------------------------------------
// The native carrier
// ---------------------------------------------------------------------------

// Record and unit separators — C0 control characters, so no address, host name
// or TXT chunk can contain one. See src/dns/mod.rs.
const __DNS_RS: string = String.fromCharCode(30);
const __DNS_US: string = String.fromCharCode(31);
const __DNS_FAILED: string = "-";

// Did the call fail? The prefix is the whole protocol: an empty payload is an
// empty list, not an error.
function __dnsFailed(raw: string): boolean {
  return raw.charAt(0) === __DNS_FAILED;
}

// The error value a failed native left after the `"-"`: a number when the
// payload is a libuv errno, the string itself when it is a c-ares code name.
// `DNSException` distinguishes exactly these two, as Node's does.
function __dnsErrorValue(raw: string): any {
  const payload: string = raw.slice(1);
  if (payload.charAt(0) === "-") {
    const parsed: number = Number(payload);
    if (Number.isInteger(parsed)) return parsed;
  }
  return payload;
}

// A successful status-prefixed result as records of fields.
function __dnsRecords(raw: string): string[][] {
  const payload: string = raw.slice(1);
  const out: string[][] = [];
  if (payload === "") return out;
  const records: string[] = payload.split(__DNS_RS);
  const count: number = Number(records.length);
  for (let i = 0; i < count; i++) out.push(records[i].split(__DNS_US));
  return out;
}

// A successful result known to carry exactly one record.
function __dnsFields(raw: string): string[] {
  return raw.slice(1).split(__DNS_US);
}

// `!value` where `value` may be an `any` holding the empty string: the negation
// of such a value is wrong in this engine, and constant folding hides it in a
// probe, so the value is routed through a parameter (zun#13).
function __dnsTruthy(value: any): boolean {
  return value ? true : false;
}

// ---------------------------------------------------------------------------
// The platform's `AI_*` flags and Node's `DNS_ORDER_*`
// ---------------------------------------------------------------------------

// `dns.ADDRCONFIG` / `dns.ALL` / `dns.V4MAPPED` are the *system's* values, which
// differ between Windows and glibc, so they cross from the native rather than
// being restated here. The `DNS_ORDER_*` enumerators ride along so that both
// sides of the ABI agree on them by construction.
const __dnsConstantFields: string[] = __dnsFields(__dnsNative.dnsConstants());
const __DNS_AI_ADDRCONFIG: number = Number(__dnsConstantFields[0]);
const __DNS_AI_ALL: number = Number(__dnsConstantFields[1]);
const __DNS_AI_V4MAPPED: number = Number(__dnsConstantFields[2]);
const __DNS_ORDER_VERBATIM: number = Number(__dnsConstantFields[3]);
const __DNS_ORDER_IPV4_FIRST: number = Number(__dnsConstantFields[4]);
const __DNS_ORDER_IPV6_FIRST: number = Number(__dnsConstantFields[5]);

// The IANA DNS port, which `getServers()` elides and `setServers()` defaults to.
const __DNS_IANA_PORT: number = 53;

// c-ares' "there are pending queries" refusal of `ares_set_servers`, which
// Node returns from `ChannelWrap::SetServers` and renders through `strerror`.
// The number is private to this pair of functions; only the text is observable.
const __DNS_ESETSERVERS_PENDING: number = -1001;

// ---------------------------------------------------------------------------
// isIP (lib/internal/net.js)
// ---------------------------------------------------------------------------
//
// Node's `isIPv4`/`isIPv6` are two regular expressions. They are hand-written
// parsers here for one reason that is not style: `test-dns.js` feeds
// `setServers` a hundred thousand colons and a hundred thousand brackets as an
// explicit ReDoS check, and a parser that walks the string once cannot have
// that failure mode at all. The accepted grammars are the regexes' own —
// including the `%zone` suffix Node's IPv6 pattern allows.

// One IPv4 segment: `0`, or 1-3 digits with no leading zero, value <= 255.
function __dnsIsIPv4Segment(text: string): boolean {
  const n: number = Number(text.length);
  if (n === 0 || n > 3) return false;
  for (let i = 0; i < n; i++) {
    const code: number = __cc(text, i);
    if (code < 48 || code > 57) return false;
  }
  if (n > 1 && text.charAt(0) === "0") return false;
  return Number(text) <= 255;
}

function __dnsIsIPv4(text: string): boolean {
  const parts: string[] = text.split(".");
  if (Number(parts.length) !== 4) return false;
  for (let i = 0; i < 4; i++) {
    if (!__dnsIsIPv4Segment(parts[i])) return false;
  }
  return true;
}

// One IPv6 group: 1-4 hexadecimal digits.
function __dnsIsIPv6Group(text: string): boolean {
  const n: number = Number(text.length);
  if (n === 0 || n > 4) return false;
  for (let i = 0; i < n; i++) {
    const code: number = __cc(text, i);
    const digit: boolean = code >= 48 && code <= 57;
    const lower: boolean = code >= 97 && code <= 102;
    const upper: boolean = code >= 65 && code <= 70;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

// The groups of one side of a `::`, where the last of the whole address may be
// a dotted IPv4 quad (which counts as two groups). A negative result means the
// side is malformed.
function __dnsIPv6Side(text: string, trailingV4Allowed: boolean): number {
  if (text === "") return 0;
  const parts: string[] = text.split(":");
  const count: number = Number(parts.length);
  let groups = 0;
  for (let i = 0; i < count; i++) {
    const part: string = parts[i];
    if (i === count - 1 && trailingV4Allowed && Number(part.indexOf(".")) !== -1) {
      if (!__dnsIsIPv4(part)) return -1;
      groups = groups + 2;
      continue;
    }
    if (!__dnsIsIPv6Group(part)) return -1;
    groups = groups + 1;
  }
  return groups;
}

function __dnsIsIPv6(input: string): boolean {
  // Node's pattern ends with an optional `%<zone>` of at least one character
  // from `[0-9a-zA-Z-.:]`; the zone is not part of the address.
  let text: string = input;
  const percent: number = Number(text.indexOf("%"));
  if (percent !== -1) {
    const zone: string = text.slice(percent + 1);
    if (Number(zone.length) === 0) return false;
    text = text.slice(0, percent);
  }
  const double: number = Number(text.indexOf("::"));
  if (double === -1) {
    return __dnsIPv6Side(text, true) === 8;
  }
  // Only one `::` is allowed anywhere in the address.
  if (Number(text.indexOf("::", double + 1)) !== -1) return false;
  const head: string = text.slice(0, double);
  const tail: string = text.slice(double + 2);
  // A side may not itself start or end with a stray colon.
  if (head.charAt(Number(head.length) - 1) === ":") return false;
  if (tail.charAt(0) === ":") return false;
  const left: number = __dnsIPv6Side(head, false);
  const right: number = __dnsIPv6Side(tail, true);
  if (left < 0 || right < 0) return false;
  return left + right <= 7;
}

// `net.isIP`: 4, 6, or 0.
function __dnsIsIP(value: any): number {
  if (typeof value !== "string") return 0;
  if (__dnsIsIPv4(value)) return 4;
  if (__dnsIsIPv6(value)) return 6;
  return 0;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// Each extends the Node-style base in ../events/events.ts, so `code` is a
// declared field rather than an expando written through `any`
// (https://github.com/UrubuCode/zun/issues/37).

// `internal/errors.js`' `determineSpecificType`, which is how every `Received
// ...` clause of a *range* error is rendered (the type-error clause is
// `__evReceived` in ../events/events.ts).
function __dnsSpecificType(value: any): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const kind: string = typeof value;
  if (kind === "function") {
    const name: any = value.name;
    if (typeof name === "string" && name !== "") return "function " + name;
  }
  if (kind === "object") {
    const ctor: any = value.constructor;
    const name: any = ctor === undefined || ctor === null ? undefined : ctor.name;
    return "an instance of " + (typeof name === "string" && name !== "" ? name : "Object");
  }
  let inspected: string = inspect(value, { depth: 0 });
  if (Number(inspected.length) > 28) inspected = inspected.slice(0, 25) + "...";
  return "type " + kind + " (" + inspected + ")";
}

class ERR_SOCKET_BAD_PORT extends NodeRangeError {
  constructor(name: string, port: any, allowZero: boolean) {
    super(
      "ERR_SOCKET_BAD_PORT",
      name + " should be " + (allowZero ? ">=" : ">") + " 0 and < 65536. Received " +
        __dnsSpecificType(port) + ".",
    );
  }
}

class ERR_INVALID_IP_ADDRESS extends NodeTypeError {
  constructor(address: any) {
    super("ERR_INVALID_IP_ADDRESS", "Invalid IP address: " + String(address));
  }
}

class ERR_DNS_SET_SERVERS_FAILED extends NodeError {
  constructor(description: string, servers: any) {
    super(
      "ERR_DNS_SET_SERVERS_FAILED",
      'c-ares failed to set servers: "' + description + '" [' + String(servers) + "]",
    );
  }
}

// `internal/errors.js`' `DNSException`. It is *not* a `SystemError`: `errno` is
// present only when the binding reported a libuv number, `code` is either that
// number's name or the c-ares code name verbatim, and the two `EAI_*` codes
// that mean "no such host" are fabricated into the historical `ENOTFOUND`.
//
// `message` is installed with `Object.defineProperty` rather than through
// `super(...)` because an `Error` in this engine has no own `message` property
// at all, and `test-dns-lookup.js` asserts the descriptor exists and is
// non-enumerable — which is also exactly what Node guarantees.
class DNSException extends NodeError {
  errno: any = undefined;
  syscall: string = "";
  hostname: any = undefined;
  constructor(code: any, syscall: string, hostname?: any) {
    super(__dnsExceptionCode(code), "");
    if (typeof code === "number") this.errno = code;
    const named: string = __dnsExceptionCode(code);
    this.syscall = syscall;
    let message: string = syscall + " " + named;
    if (__dnsTruthy(hostname)) {
      message = message + " " + String(hostname);
      this.hostname = hostname;
    }
    Object.defineProperty(this, "message", {
      value: message,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  }
  get name(): string {
    return "Error";
  }
  toString(): string {
    return "Error: " + this.message;
  }
}

// libuv's `EAI_NODATA` / `EAI_NONAME` as Node's fabricated `ENOTFOUND`, every
// other number through `util.getSystemErrorName`, and a string through
// unchanged.
function __dnsExceptionCode(code: any): string {
  if (typeof code !== "number") return String(code);
  if (code === -3007 || code === -3008) return "ENOTFOUND";
  // `getSystemErrorName` rejects a non-negative errno outright; a binding that
  // answered one is not describable, so the number itself is the code.
  if (code >= 0) return String(code);
  return util.getSystemErrorName(code);
}

// ---------------------------------------------------------------------------
// Argument validation (internal/validators)
// ---------------------------------------------------------------------------

function __dnsValidateString(value: any, name: string): void {
  if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
}

function __dnsValidateFunction(value: any, name: string): void {
  if (typeof value !== "function") throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
}

function __dnsValidateBoolean(value: any, name: string): void {
  if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
}

function __dnsValidateNumber(value: any, name: string): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
}

function __dnsValidateArray(value: any, name: string): void {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
}

// `validateOneOf`, whose reason lists the allowed values with strings quoted.
function __dnsValidateOneOf(value: any, name: string, allowed: any[]): void {
  for (const candidate of allowed) {
    if (candidate === value) return;
  }
  const rendered: string[] = [];
  for (const candidate of allowed) {
    rendered.push(typeof candidate === "string" ? "'" + candidate + "'" : String(candidate));
  }
  throw new ERR_INVALID_ARG_VALUE(name, value, "must be one of: " + rendered.join(", "));
}

const __DNS_INT32_MAX: number = 2147483647;
const __DNS_UINT32_MAX: number = 4294967295;

function __dnsValidateInt32(value: any, name: string, min: number): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  if (value < min || value > __DNS_INT32_MAX) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(min) + " && <= " + String(__DNS_INT32_MAX),
      value,
    );
  }
}

function __dnsValidateUint32(value: any, name: string): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  if (value < 0 || value > __DNS_UINT32_MAX) {
    throw new ERR_OUT_OF_RANGE(name, ">= 0 && <= " + String(__DNS_UINT32_MAX), value);
  }
}

// `validatePort`, whose accepted set is "a number or a non-blank string whose
// numeric value is an unsigned 16-bit integer".
function __dnsValidatePort(port: any): number {
  let bad = false;
  if (typeof port !== "number" && typeof port !== "string") {
    bad = true;
  } else if (typeof port === "string" && port.trim() === "") {
    bad = true;
  } else {
    const numeric: number = Number(port);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 65535) bad = true;
  }
  if (bad) throw new ERR_SOCKET_BAD_PORT("Port", port, true);
  return Number(port);
}

// `internal/dns/utils.js`' three constructor options.
function __dnsValidateTimeout(options: any): number {
  if (options === undefined || options === null) return -1;
  const timeout: any = options.timeout;
  if (timeout === undefined) return -1;
  __dnsValidateInt32(timeout, "options.timeout", -1);
  return Number(timeout);
}

function __dnsValidateTries(options: any): number {
  if (options === undefined || options === null) return 4;
  const tries: any = options.tries;
  if (tries === undefined) return 4;
  __dnsValidateInt32(tries, "options.tries", 1);
  return Number(tries);
}

function __dnsValidateMaxTimeout(options: any): number {
  if (options === undefined || options === null) return 0;
  const maxTimeout: any = options.maxTimeout;
  if (maxTimeout === undefined) return 0;
  __dnsValidateUint32(maxTimeout, "options.maxTimeout");
  return Number(maxTimeout);
}

// `internal/dns/utils.js`' `validateHints`.
function __dnsValidateHints(hints: number): void {
  const known: number = __DNS_AI_ADDRCONFIG | __DNS_AI_ALL | __DNS_AI_V4MAPPED;
  if ((hints & ~known) !== 0) {
    throw new ERR_INVALID_ARG_VALUE("hints", hints, "is invalid");
  }
}

const __DNS_VALID_ORDERS: string[] = ["verbatim", "ipv4first", "ipv6first"];
const __DNS_VALID_FAMILIES: number[] = [0, 4, 6];

// ---------------------------------------------------------------------------
// The internal binding, shaped like Node's `internalBinding('cares_wrap')`
// ---------------------------------------------------------------------------

// The channel a `ChannelWrap.prototype` method is operating on. Node threads it
// as the method's `this`; that cannot be done here (see the header), so the
// dispatcher parks it and the default implementations read it back. A query is
// synchronous, so the slot is never contended.
const __dnsChannelSlot: any = { current: undefined };

// `getaddrinfo(req, hostname, family, hints, order)`.
//
// Node's binding returns 0 once the request is *queued* and reports the
// resolution through `req.oncomplete` later; a non-zero return means the
// request could not be made at all. This keeps that contract: the blocking
// native runs here, and both the answer and the failure are handed to
// `oncomplete` on the next tick.
function __dnsBindingGetaddrinfo(
  req: any,
  hostname: any,
  family: any,
  hints: any,
  order: any,
): any {
  const raw: string = __dnsNative.dnsGetaddrinfo(
    String(hostname),
    Number(family),
    Number(hints),
    Number(order),
  );
  if (__dnsFailed(raw)) {
    const error: any = __dnsErrorValue(raw);
    process.nextTick(() => {
      __evCall(req.oncomplete, [error]);
    });
    return 0;
  }
  const addresses: any[] = [];
  for (const record of __dnsRecords(raw)) addresses.push(record[0]);
  process.nextTick(() => {
    __evCall(req.oncomplete, [null, addresses]);
  });
  return 0;
}

// `getnameinfo(req, hostname, port)`, on the same contract.
function __dnsBindingGetnameinfo(req: any, hostname: any, port: any): any {
  const raw: string = __dnsNative.dnsGetnameinfo(String(hostname), Number(port));
  if (__dnsFailed(raw)) {
    const error: any = __dnsErrorValue(raw);
    process.nextTick(() => {
      __evCall(req.oncomplete, [error]);
    });
    return 0;
  }
  const fields: string[] = __dnsFields(raw);
  process.nextTick(() => {
    __evCall(req.oncomplete, [null, fields[0], fields[1]]);
  });
  return 0;
}

// The DNS question each `ChannelWrap.prototype` method asks, and the shape its
// answer takes. `reverse` is `getHostByAddr`, which is a PTR query over the
// `.arpa` name — c-ares builds that name inside `ares_gethostbyaddr`, and it is
// string arithmetic, so it is built here.
const __DNS_BINDING_TYPES: any = {
  queryAny: "ANY",
  queryA: "A",
  queryAaaa: "AAAA",
  queryCaa: "CAA",
  queryCname: "CNAME",
  queryMx: "MX",
  queryNs: "NS",
  queryTlsa: "TLSA",
  queryTxt: "TXT",
  querySrv: "SRV",
  queryPtr: "PTR",
  queryNaptr: "NAPTR",
  querySoa: "SOA",
  getHostByAddr: "PTR",
};

// `rrtype` (the `dns.resolve(name, rrtype)` spelling) to the binding method
// that answers it — Node's `resolveMap`.
const __DNS_RRTYPE_MAP: any = {
  A: "queryA",
  AAAA: "queryAaaa",
  ANY: "queryAny",
  CAA: "queryCaa",
  CNAME: "queryCname",
  MX: "queryMx",
  NAPTR: "queryNaptr",
  NS: "queryNs",
  PTR: "queryPtr",
  SOA: "querySoa",
  SRV: "querySrv",
  TLSA: "queryTlsa",
  TXT: "queryTxt",
};

// `1.2.3.4` as `4.3.2.1.in-addr.arpa`, and an IPv6 address as its 32 reversed
// nibbles under `ip6.arpa` (RFC 3596 §2.5).
function __dnsArpaName(address: string): string {
  if (__dnsIsIPv4(address)) {
    const parts: string[] = address.split(".");
    return parts[3] + "." + parts[2] + "." + parts[1] + "." + parts[0] + ".in-addr.arpa";
  }
  const nibbles: string = __dnsIpv6Nibbles(address);
  if (nibbles === "") return address;
  let out = "";
  for (let i = Number(nibbles.length) - 1; i >= 0; i--) {
    if (out !== "") out = out + ".";
    out = out + nibbles.charAt(i);
  }
  return out + ".ip6.arpa";
}

// An IPv6 address as its 32 hexadecimal digits, `::` expanded.
function __dnsIpv6Nibbles(address: string): string {
  const percent: number = Number(address.indexOf("%"));
  const bare: string = percent === -1 ? address : address.slice(0, percent);
  const double: number = Number(bare.indexOf("::"));
  const head: string[] = [];
  const tail: string[] = [];
  if (double === -1) {
    for (const group of bare.split(":")) head.push(group);
  } else {
    const left: string = bare.slice(0, double);
    const right: string = bare.slice(double + 2);
    if (left !== "") {
      for (const group of left.split(":")) head.push(group);
    }
    if (right !== "") {
      for (const group of right.split(":")) tail.push(group);
    }
  }
  const groups: string[] = [];
  for (const group of head) groups.push(group);
  const missing: number = 8 - (Number(head.length) + Number(tail.length));
  for (let i = 0; i < missing; i++) groups.push("0");
  for (const group of tail) groups.push(group);
  if (Number(groups.length) !== 8) return "";
  let out = "";
  for (const group of groups) {
    const padded: string = ("0000" + group.toLowerCase()).slice(-4);
    out = out + padded;
  }
  return out;
}

// One query against the channel in `__dnsChannelSlot`, as the default
// implementation of every `ChannelWrap.prototype` query method.
function __dnsBindingQuery(bindingName: string, req: any, name: any): any {
  const handle: any = __dnsChannelSlot.current;
  const rrtype: string = __DNS_BINDING_TYPES[bindingName];
  const queried: string = bindingName === "getHostByAddr" ? __dnsArpaName(String(name)) : String(name);
  const raw: string = __dnsNative.dnsQuery(
    __dnsServerPayload(handle),
    queried,
    rrtype,
    Number(handle.timeout) > 0 ? Number(handle.timeout) : 0,
    Number(handle.tries),
  );
  handle.pending = Number(handle.pending) + 1;
  process.nextTick(() => {
    handle.pending = Number(handle.pending) - 1;
    handle.requests = __dnsWithoutRequest(handle.requests, req);
    if (req.cancelled === true) {
      __evCall(req.oncomplete, ["ECANCELLED"]);
      return;
    }
    if (__dnsFailed(raw)) {
      __evCall(req.oncomplete, [__dnsErrorValue(raw)]);
      return;
    }
    const shaped: any = __dnsShapeAnswer(bindingName, __dnsRecords(raw));
    __evCall(req.oncomplete, [null, shaped.result, shaped.ttls]);
  });
  return 0;
}

// The channel's pending-request list without one request, so that a completed
// query is no longer a `cancel()` target.
function __dnsWithoutRequest(requests: any[], req: any): any[] {
  const kept: any[] = [];
  for (const pending of requests) {
    if (pending !== req) kept.push(pending);
  }
  return kept;
}

// The channel's server list as the native's `address US port` records.
function __dnsServerPayload(handle: any): string {
  const parts: string[] = [];
  for (const server of handle.servers) {
    parts.push(String(server[0]) + __DNS_US + String(server[1]));
  }
  return parts.join(__DNS_RS);
}

// The records from `dnsQuery` as the value Node's callback receives, plus the
// separate `ttls` array the binding passes only for A and AAAA (which is what
// makes `{ ttl: true }` an A/AAAA-only option in Node).
function __dnsShapeAnswer(bindingName: string, records: string[][]): any {
  if (bindingName === "queryA" || bindingName === "queryAaaa") {
    const addresses: any[] = [];
    const ttls: any[] = [];
    for (const record of records) {
      addresses.push(record[0]);
      ttls.push(Number(record[1]));
    }
    return { result: addresses, ttls: ttls };
  }
  if (bindingName === "querySoa") {
    return { result: __dnsSoaRecord(records[0], 0), ttls: null };
  }
  const out: any[] = [];
  for (const record of records) {
    if (bindingName === "queryAny") {
      const entry: any = __dnsAnyRecord(record);
      if (entry !== undefined) out.push(entry);
    } else {
      out.push(__dnsTypedRecord(bindingName, record));
    }
  }
  return { result: out, ttls: null };
}

// One record of a single-type query, in the shape `lib/dns.js` documents.
function __dnsTypedRecord(bindingName: string, record: string[]): any {
  if (bindingName === "queryMx") {
    return { priority: Number(record[0]), exchange: record[1] };
  }
  if (bindingName === "querySrv") {
    return {
      priority: Number(record[0]),
      weight: Number(record[1]),
      port: Number(record[2]),
      name: record[3],
    };
  }
  if (bindingName === "queryNaptr") {
    return {
      flags: record[0],
      service: record[1],
      regexp: record[2],
      replacement: record[3],
      order: Number(record[4]),
      preference: Number(record[5]),
    };
  }
  if (bindingName === "queryCaa") {
    const entry: any = { critical: Number(record[0]) };
    entry[record[1]] = record[2];
    return entry;
  }
  if (bindingName === "queryTlsa") {
    return {
      certUsage: Number(record[0]),
      selector: Number(record[1]),
      match: Number(record[2]),
      data: record[3],
    };
  }
  if (bindingName === "queryTxt") {
    const chunks: any[] = [];
    const n: number = Number(record.length);
    for (let i = 1; i < n; i++) chunks.push(record[i]);
    return chunks;
  }
  // queryCname / queryNs / queryPtr / getHostByAddr are all one name.
  return record[0];
}

function __dnsSoaRecord(record: string[], offset: number): any {
  return {
    nsname: record[offset],
    hostmaster: record[offset + 1],
    serial: Number(record[offset + 2]),
    refresh: Number(record[offset + 3]),
    retry: Number(record[offset + 4]),
    expire: Number(record[offset + 5]),
    minttl: Number(record[offset + 6]),
  };
}

// One record of an `ANY` query: the native prefixes each with its type name, and
// Node's entry carries that `type` plus the per-type fields. A type this module
// does not model is dropped, which is where c-ares drops it too.
function __dnsAnyRecord(record: string[]): any {
  const type: string = record[0];
  if (type === "A" || type === "AAAA") {
    return { type: type, address: record[1], ttl: Number(record[2]) };
  }
  if (type === "CNAME" || type === "NS" || type === "PTR") {
    return { type: type, value: record[1] };
  }
  if (type === "MX") {
    return { type: type, priority: Number(record[1]), exchange: record[2] };
  }
  if (type === "TXT") {
    const chunks: any[] = [];
    const n: number = Number(record.length);
    for (let i = 2; i < n; i++) chunks.push(record[i]);
    return { type: type, entries: chunks };
  }
  if (type === "SRV") {
    return {
      type: type,
      priority: Number(record[1]),
      weight: Number(record[2]),
      port: Number(record[3]),
      name: record[4],
    };
  }
  if (type === "SOA") {
    const soa: any = __dnsSoaRecord(record, 1);
    soa.type = type;
    return soa;
  }
  if (type === "NAPTR") {
    return {
      type: type,
      flags: record[1],
      service: record[2],
      regexp: record[3],
      replacement: record[4],
      order: Number(record[5]),
      preference: Number(record[6]),
    };
  }
  if (type === "CAA") {
    const entry: any = { critical: Number(record[1]) };
    entry[record[2]] = record[3];
    return entry;
  }
  if (type === "TLSA") {
    return {
      type: type,
      certUsage: Number(record[1]),
      selector: Number(record[2]),
      match: Number(record[3]),
      data: record[4],
    };
  }
  return undefined;
}

// Node's `internalBinding('cares_wrap')`. Every member a test replaces is an
// own, writable property, and each `ChannelWrap.prototype` method is reached
// through that table on every call so that a replacement is seen — which is the
// whole point of giving this object Node's shape.
const __dnsCares: any = {
  AI_ADDRCONFIG: __DNS_AI_ADDRCONFIG,
  AI_ALL: __DNS_AI_ALL,
  AI_V4MAPPED: __DNS_AI_V4MAPPED,
  DNS_ORDER_VERBATIM: __DNS_ORDER_VERBATIM,
  DNS_ORDER_IPV4_FIRST: __DNS_ORDER_IPV4_FIRST,
  DNS_ORDER_IPV6_FIRST: __DNS_ORDER_IPV6_FIRST,
  getaddrinfo(req: any, hostname: any, family: any, hints: any, order: any): any {
    return __dnsBindingGetaddrinfo(req, hostname, family, hints, order);
  },
  getnameinfo(req: any, hostname: any, port: any): any {
    return __dnsBindingGetnameinfo(req, hostname, port);
  },
  strerror(code: any): string {
    return Number(code) === __DNS_ESETSERVERS_PENDING
      ? "There are pending queries."
      : "Unknown error";
  },
  // Node's three request wrappers are `AsyncWrap` subclasses whose only role in
  // JavaScript is to be a property bag the completion reads; a plain object is
  // the same thing here, which is why these are factories rather than classes.
  GetAddrInfoReqWrap(): any {
    return {};
  },
  GetNameInfoReqWrap(): any {
    return {};
  },
  QueryReqWrap(): any {
    return {};
  },
  ChannelWrap: {
    prototype: {
      queryAny(req: any, name: any): any {
        return __dnsBindingQuery("queryAny", req, name);
      },
      queryA(req: any, name: any): any {
        return __dnsBindingQuery("queryA", req, name);
      },
      queryAaaa(req: any, name: any): any {
        return __dnsBindingQuery("queryAaaa", req, name);
      },
      queryCaa(req: any, name: any): any {
        return __dnsBindingQuery("queryCaa", req, name);
      },
      queryCname(req: any, name: any): any {
        return __dnsBindingQuery("queryCname", req, name);
      },
      queryMx(req: any, name: any): any {
        return __dnsBindingQuery("queryMx", req, name);
      },
      queryNs(req: any, name: any): any {
        return __dnsBindingQuery("queryNs", req, name);
      },
      queryTlsa(req: any, name: any): any {
        return __dnsBindingQuery("queryTlsa", req, name);
      },
      queryTxt(req: any, name: any): any {
        return __dnsBindingQuery("queryTxt", req, name);
      },
      querySrv(req: any, name: any): any {
        return __dnsBindingQuery("querySrv", req, name);
      },
      queryPtr(req: any, name: any): any {
        return __dnsBindingQuery("queryPtr", req, name);
      },
      queryNaptr(req: any, name: any): any {
        return __dnsBindingQuery("queryNaptr", req, name);
      },
      querySoa(req: any, name: any): any {
        return __dnsBindingQuery("querySoa", req, name);
      },
      getHostByAddr(req: any, name: any): any {
        return __dnsBindingQuery("getHostByAddr", req, name);
      },
    },
  },
};

// ---------------------------------------------------------------------------
// The channel (Node's `ChannelWrap` instance, `resolver._handle`)
// ---------------------------------------------------------------------------

// One channel. `getServers` / `setServers` / `setLocalAddress` / `cancel` are
// own, writable properties, because `test-dns-get-server.js` replaces
// `_handle.getServers` on the instance; each query property forwards through
// `__dnsCares.ChannelWrap.prototype` on every call, because
// `test-dns-resolve-promises.js` replaces one there.
function __dnsMakeChannel(timeout: number, tries: number, maxTimeout: number): any {
  const servers: any[] = [];
  for (const record of __dnsRecords(__dnsNative.dnsSystemServers())) {
    servers.push([record[0], Number(record[1])]);
  }
  const handle: any = {
    servers: servers,
    pending: 0,
    timeout: timeout,
    tries: tries,
    maxTimeout: maxTimeout,
    requests: [],
    localAddressV4: undefined,
    localAddressV6: undefined,
  };

  // Every method below is a closure over `handle` rather than a method reading
  // `this`, and that is load-bearing twice over. A test replaces one of them
  // with `common.mustCall()`, whose wrapper is a *boxed* callable (zun#17) that
  // only `__evCall` can invoke — and `__evCall` threads no receiver (zun#1), so
  // a method that needed `this` would break the moment it was replaced. Reading
  // the channel out of the closure makes the two cases identical.
  handle.getServers = (): any => {
    const copy: any[] = [];
    for (const server of handle.servers) copy.push([server[0], server[1]]);
    return copy;
  };
  // Node's `[ipVersion, address, port]` triples, and c-ares' refusal while
  // queries are in flight.
  handle.setServers = (list: any): any => {
    if (Number(handle.pending) > 0) return __DNS_ESETSERVERS_PENDING;
    const next: any[] = [];
    const n: number = Number(list.length);
    for (let i = 0; i < n; i++) {
      const entry: any = list[i];
      next.push([entry[1], Number(entry[2])]);
    }
    handle.servers = next;
    return 0;
  };
  handle.setLocalAddress = (ipv4: any, ipv6: any): void => {
    __dnsChannelSetLocalAddress(handle, ipv4, ipv6);
  };
  handle.cancel = (): void => {
    for (const request of handle.requests) request.cancelled = true;
    handle.requests = [];
  };
  for (const bindingName of Object.keys(__DNS_BINDING_TYPES)) {
    handle[bindingName] = (req: any, name: any): any => {
      return __dnsChannelDispatch(handle, bindingName, req, name);
    };
  }
  return handle;
}

// Park the channel, call whatever `ChannelWrap.prototype` currently holds for
// this method, and restore. See the header for why the channel does not travel
// as `this`.
function __dnsChannelDispatch(handle: any, bindingName: string, req: any, name: any): any {
  const previous: any = __dnsChannelSlot.current;
  __dnsChannelSlot.current = handle;
  handle.requests.push(req);
  const method: any = __dnsCares.ChannelWrap.prototype[bindingName];
  const status: any = __evCall(method, [req, name]);
  __dnsChannelSlot.current = previous;
  return status;
}

// `ChannelWrap::SetLocalAddress`: the first argument may be either family, and
// a second must be the other one.
function __dnsChannelSetLocalAddress(handle: any, ipv4: any, ipv6: any): void {
  const first: number = __dnsIsIP(ipv4);
  if (first === 0) throw new ERR_INVALID_ARG_VALUE("ipv4", ipv4, "is invalid");
  if (first === 4) handle.localAddressV4 = ipv4;
  else handle.localAddressV6 = ipv4;
  if (ipv6 === undefined) return;
  const second: number = __dnsIsIP(ipv6);
  if (second === 0) throw new ERR_INVALID_ARG_VALUE("ipv6", ipv6, "is invalid");
  if (second === first) {
    throw new ERR_INVALID_ARG_VALUE(
      "ipv6",
      ipv6,
      "cannot be a second IPv" + String(first) + " address",
    );
  }
  if (second === 4) handle.localAddressV4 = ipv6;
  else handle.localAddressV6 = ipv6;
}

// ---------------------------------------------------------------------------
// The resolver surface shared by both classes (`internal/dns/utils.js`)
// ---------------------------------------------------------------------------

// `ResolverBase.getServers()`: the IANA port is elided, and a non-default port
// on an IPv6 address brings the brackets back.
function __dnsGetServers(handle: any): string[] {
  const rows: any = __evCall(handle.getServers, []) || [];
  const out: string[] = [];
  const n: number = Number(rows.length);
  for (let i = 0; i < n; i++) {
    const row: any = rows[i];
    const port: any = row[1];
    if (!__dnsTruthy(port) || Number(port) === __DNS_IANA_PORT) {
      out.push(String(row[0]));
      continue;
    }
    const host: string = __dnsIsIP(row[0]) === 6 ? "[" + String(row[0]) + "]" : String(row[0]);
    out.push(host + ":" + String(port));
  }
  return out;
}

// `ResolverBase.setServers()`. The address grammar is Node's: a bare address,
// an IPv6 address in brackets with an optional port, or `address:port`.
//
// Node spells the last two as regular expressions (`/^\[([^[\]]*)\]/` and
// `/(^.+?)(?::(\d+))?$/`); they are walked by hand here because `test-dns.js`
// feeds this function a hundred thousand colons and a hundred thousand brackets
// as an explicit ReDoS check, and a single pass cannot have that failure mode.
// The lazy first group of Node's second pattern selects the *last* colon whose
// tail is all digits, which is what `__dnsSplitPort` computes.
function __dnsSetServers(handle: any, servers: any): void {
  __dnsValidateArray(servers, "servers");
  const next: any[] = [];
  const count: number = Number(servers.length);
  for (let index = 0; index < count; index++) {
    const serv: any = servers[index];
    __dnsValidateString(serv, "servers[" + String(index) + "]");
    let version: number = __dnsIsIP(serv);
    if (version !== 0) {
      next.push([version, serv, __DNS_IANA_PORT]);
      continue;
    }
    const bracketed: any = __dnsBracketedHost(serv);
    if (bracketed !== undefined) {
      version = __dnsIsIP(bracketed);
      if (version !== 0) {
        const split: any = __dnsSplitPort(serv);
        const port: number = split.port === undefined ? __DNS_IANA_PORT : Number(split.port);
        next.push([version, bracketed, port]);
        continue;
      }
    }
    const split: any = __dnsSplitPort(serv);
    version = __dnsIsIP(split.host);
    if (version !== 0) {
      const port: number = split.port === undefined ? __DNS_IANA_PORT : Number(split.port);
      next.push([version, split.host, port]);
      continue;
    }
    throw new ERR_INVALID_IP_ADDRESS(serv);
  }
  __dnsSetServersInternal(handle, next, servers);
}

function __dnsSetServersInternal(handle: any, next: any[], servers: any): void {
  // Cache the originals: c-ares leaves the channel with no servers at all when
  // setting them fails, so Node puts the old list back before throwing.
  const original: any = __evCall(handle.getServers, []) || [];
  const restore: any[] = [];
  const n: number = Number(original.length);
  for (let i = 0; i < n; i++) {
    const row: any = original[i];
    restore.push([__dnsIsIP(row[0]), row[0], row[1]]);
  }
  const status: any = __evCall(handle.setServers, [next]);
  if (Number(status) !== 0) {
    __evCall(handle.setServers, [restore]);
    throw new ERR_DNS_SET_SERVERS_FAILED(__evCall(__dnsCares.strerror, [status]), servers);
  }
}

// `[<ipv6>]` — the host inside the brackets, or `undefined` when the value does
// not open with a bracketed, bracket-free host.
function __dnsBracketedHost(serv: string): any {
  if (serv.charAt(0) !== "[") return undefined;
  const close: number = Number(serv.indexOf("]"));
  if (close === -1) return undefined;
  const inner: string = serv.slice(1, close);
  if (Number(inner.indexOf("[")) !== -1) return undefined;
  return inner;
}

// The value split at the last colon whose tail is a non-empty run of digits.
function __dnsSplitPort(serv: string): any {
  const colon: number = Number(serv.lastIndexOf(":"));
  if (colon === -1 || colon === Number(serv.length) - 1) {
    return { host: serv, port: undefined };
  }
  const tail: string = serv.slice(colon + 1);
  const n: number = Number(tail.length);
  for (let i = 0; i < n; i++) {
    const code: number = __cc(tail, i);
    if (code < 48 || code > 57) return { host: serv, port: undefined };
  }
  return { host: serv.slice(0, colon), port: tail };
}

function __dnsSetLocalAddress(handle: any, ipv4: any, ipv6: any): void {
  __dnsValidateString(ipv4, "ipv4");
  if (ipv6 !== undefined) __dnsValidateString(ipv6, "ipv6");
  __evCall(handle.setLocalAddress, [ipv4, ipv6]);
}

// ---------------------------------------------------------------------------
// The default result order
// ---------------------------------------------------------------------------

// Node's module-level `dnsOrder`, which `--dns-result-order` seeds and
// `setDefaultResultOrder()` replaces. The engine has no such flag, so the
// initial value is the default Node uses without one.
const __dnsOrderState: any = { order: "verbatim" };

function __dnsSetDefaultResultOrder(value: any): void {
  __dnsValidateOneOf(value, "dnsOrder", __DNS_VALID_ORDERS);
  __dnsOrderState.order = value;
}

function __dnsGetDefaultResultOrder(): string {
  return String(__dnsOrderState.order);
}

function __dnsOrderCode(dnsOrder: string): number {
  if (dnsOrder === "ipv4first") return __DNS_ORDER_IPV4_FIRST;
  if (dnsOrder === "ipv6first") return __DNS_ORDER_IPV6_FIRST;
  return __DNS_ORDER_VERBATIM;
}

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

// The `options` cascade of `lib/dns.js`' `lookup`, shared by the callback and
// the promise surface because the two parse identically once the callback is
// out of the way. The result is the four values the request carries.
function __dnsParseLookupOptions(options: any): any {
  const parsed: any = {
    hints: 0,
    family: 0,
    all: false,
    dnsOrder: __dnsGetDefaultResultOrder(),
  };
  if (options === undefined || options === null) return parsed;

  if (options.hints !== undefined && options.hints !== null) {
    __dnsValidateNumber(options.hints, "options.hints");
    parsed.hints = Number(options.hints) >>> 0;
    __dnsValidateHints(parsed.hints);
  }
  if (options.family !== undefined && options.family !== null) {
    if (options.family === "IPv4") {
      parsed.family = 4;
    } else if (options.family === "IPv6") {
      parsed.family = 6;
    } else {
      __dnsValidateOneOf(options.family, "options.family", __DNS_VALID_FAMILIES);
      parsed.family = Number(options.family);
    }
  }
  if (options.all !== undefined && options.all !== null) {
    __dnsValidateBoolean(options.all, "options.all");
    parsed.all = options.all;
  }
  if (options.verbatim !== undefined && options.verbatim !== null) {
    __dnsValidateBoolean(options.verbatim, "options.verbatim");
    parsed.dnsOrder = options.verbatim ? "verbatim" : "ipv4first";
  }
  if (options.order !== undefined && options.order !== null) {
    __dnsValidateOneOf(options.order, "options.order", __DNS_VALID_ORDERS);
    parsed.dnsOrder = options.order;
  }
  return parsed;
}

// `onlookup` / `onlookupall` for the callback surface. Node installs these as
// shared functions that read the request through `this`; they take the request
// as a parameter here, because an assigned function does not keep its receiver
// (see the header).
function __dnsOnLookup(req: any, err: any, addresses: any): void {
  if (__dnsTruthy(err)) {
    __evCall(req.callback, [new DNSException(err, "getaddrinfo", req.hostname)]);
    return;
  }
  __evCall(req.callback, [
    null,
    addresses[0],
    Number(req.family) || __dnsIsIP(addresses[0]),
  ]);
}

function __dnsOnLookupAll(req: any, err: any, addresses: any): void {
  if (__dnsTruthy(err)) {
    __evCall(req.callback, [new DNSException(err, "getaddrinfo", req.hostname)]);
    return;
  }
  const family: any = req.family;
  const out: any[] = [];
  const n: number = Number(addresses.length);
  for (let i = 0; i < n; i++) {
    out.push({ address: addresses[i], family: Number(family) || __dnsIsIP(addresses[i]) });
  }
  __evCall(req.callback, [null, out]);
}

// `dns.lookup(hostname[, options], callback)`.
function __dnsLookup(hostname: any, rest: any[]): any {
  const given: number = Number(rest.length);
  let options: any = given > 0 ? rest[0] : undefined;
  let callback: any = given > 1 ? rest[1] : undefined;

  if (__dnsTruthy(hostname)) __dnsValidateString(hostname, "hostname");

  let parsed: any = undefined;
  if (typeof options === "function") {
    callback = options;
    parsed = { hints: 0, family: 0, all: false, dnsOrder: __dnsGetDefaultResultOrder() };
  } else if (typeof options === "number") {
    __dnsValidateFunction(callback, "callback");
    __dnsValidateOneOf(options, "family", __DNS_VALID_FAMILIES);
    parsed = {
      hints: 0,
      family: Number(options),
      all: false,
      dnsOrder: __dnsGetDefaultResultOrder(),
    };
  } else if (options !== undefined && typeof options !== "object") {
    // Node validates whichever argument was *meant* to be the callback, which
    // is `options` itself in the two-argument form.
    __dnsValidateFunction(given === 1 ? options : callback, "callback");
    throw new ERR_INVALID_ARG_TYPE("options", ["integer", "object"], options);
  } else {
    __dnsValidateFunction(callback, "callback");
    parsed = __dnsParseLookupOptions(options);
  }

  if (!__dnsTruthy(hostname)) {
    throw new ERR_INVALID_ARG_VALUE("hostname", hostname, "must be a non-empty string");
  }

  const matched: number = __dnsIsIP(hostname);
  if (matched !== 0) {
    if (parsed.all) {
      process.nextTick(() => {
        __evCall(callback, [null, [{ address: hostname, family: matched }]]);
      });
    } else {
      process.nextTick(() => {
        __evCall(callback, [null, hostname, matched]);
      });
    }
    return {};
  }

  const req: any = __evCall(__dnsCares.GetAddrInfoReqWrap, []);
  req.callback = callback;
  req.family = parsed.family;
  req.hostname = hostname;
  const all: boolean = parsed.all === true;
  req.oncomplete = (err: any, addresses: any) => {
    if (all) __dnsOnLookupAll(req, err, addresses);
    else __dnsOnLookup(req, err, addresses);
  };

  const err: any = __evCall(__dnsCares.getaddrinfo, [
    req,
    hostname,
    parsed.family,
    parsed.hints,
    __dnsOrderCode(parsed.dnsOrder),
  ]);
  if (__dnsTruthy(err)) {
    process.nextTick(() => {
      __evCall(callback, [new DNSException(err, "getaddrinfo", hostname)]);
    });
    return {};
  }
  return req;
}

// `dnsPromises.lookup(hostname[, options])`. The option validation is
// synchronous (Node throws rather than rejecting for a bad option), while the
// empty-hostname check lives inside the promise and therefore rejects.
function __dnsLookupPromise(hostname: any, options: any): any {
  if (__dnsTruthy(hostname)) __dnsValidateString(hostname, "hostname");

  let parsed: any = undefined;
  if (typeof options === "number") {
    __dnsValidateOneOf(options, "family", __DNS_VALID_FAMILIES);
    parsed = {
      hints: 0,
      family: Number(options),
      all: false,
      dnsOrder: __dnsGetDefaultResultOrder(),
    };
  } else if (options !== undefined && typeof options !== "object") {
    throw new ERR_INVALID_ARG_TYPE("options", ["integer", "object"], options);
  } else {
    parsed = __dnsParseLookupOptions(options);
  }

  return new Promise((resolve: any, reject: any) => {
    if (!__dnsTruthy(hostname)) {
      reject(new ERR_INVALID_ARG_VALUE("hostname", hostname, "must be a non-empty string"));
      return;
    }
    const matched: number = __dnsIsIP(hostname);
    if (matched !== 0) {
      const single: any = { address: hostname, family: matched };
      resolve(parsed.all ? [single] : single);
      return;
    }

    const req: any = __evCall(__dnsCares.GetAddrInfoReqWrap, []);
    req.family = parsed.family;
    req.hostname = hostname;
    req.resolve = resolve;
    req.reject = reject;
    const all: boolean = parsed.all === true;
    req.oncomplete = (err: any, addresses: any) => {
      if (all) __dnsOnLookupAllPromise(req, err, addresses);
      else __dnsOnLookupPromise(req, err, addresses);
    };

    const err: any = __evCall(__dnsCares.getaddrinfo, [
      req,
      hostname,
      parsed.family,
      parsed.hints,
      __dnsOrderCode(parsed.dnsOrder),
    ]);
    if (__dnsTruthy(err)) reject(new DNSException(err, "getaddrinfo", hostname));
  });
}

function __dnsOnLookupPromise(req: any, err: any, addresses: any): void {
  if (__dnsTruthy(err)) {
    __evCall(req.reject, [new DNSException(err, "getaddrinfo", req.hostname)]);
    return;
  }
  const family: number = Number(req.family) || __dnsIsIP(addresses[0]);
  __evCall(req.resolve, [{ address: addresses[0], family: family }]);
}

function __dnsOnLookupAllPromise(req: any, err: any, addresses: any): void {
  if (__dnsTruthy(err)) {
    __evCall(req.reject, [new DNSException(err, "getaddrinfo", req.hostname)]);
    return;
  }
  const family: any = req.family;
  const out: any[] = [];
  const n: number = Number(addresses.length);
  for (let i = 0; i < n; i++) {
    out.push({ address: addresses[i], family: Number(family) || __dnsIsIP(addresses[i]) });
  }
  __evCall(req.resolve, [out]);
}

// ---------------------------------------------------------------------------
// lookupService
// ---------------------------------------------------------------------------

function __dnsLookupService(args: any[]): any {
  if (Number(args.length) !== 3) {
    throw new ERR_MISSING_ARGS("address", "port", "callback");
  }
  const address: any = args[0];
  const port: any = args[1];
  const callback: any = args[2];
  if (__dnsIsIP(address) === 0) {
    throw new ERR_INVALID_ARG_VALUE("address", address, "is invalid");
  }
  __dnsValidatePort(port);
  __dnsValidateFunction(callback, "callback");

  const req: any = __evCall(__dnsCares.GetNameInfoReqWrap, []);
  req.callback = callback;
  req.hostname = address;
  req.port = Number(port);
  req.oncomplete = (err: any, hostname: any, service: any) => {
    if (__dnsTruthy(err)) {
      __evCall(req.callback, [new DNSException(err, "getnameinfo", req.hostname)]);
      return;
    }
    __evCall(req.callback, [null, hostname, service]);
  };

  const err: any = __evCall(__dnsCares.getnameinfo, [req, address, Number(port)]);
  if (__dnsTruthy(err)) throw new DNSException(err, "getnameinfo", address);
  return req;
}

function __dnsLookupServicePromise(args: any[]): any {
  if (Number(args.length) !== 2) throw new ERR_MISSING_ARGS("address", "port");
  const address: any = args[0];
  const port: any = args[1];
  if (__dnsIsIP(address) === 0) {
    throw new ERR_INVALID_ARG_VALUE("address", address, "is invalid");
  }
  __dnsValidatePort(port);

  return new Promise((resolve: any, reject: any) => {
    const req: any = __evCall(__dnsCares.GetNameInfoReqWrap, []);
    req.hostname = address;
    req.port = Number(port);
    req.resolve = resolve;
    req.reject = reject;
    req.oncomplete = (err: any, hostname: any, service: any) => {
      if (__dnsTruthy(err)) {
        __evCall(req.reject, [new DNSException(err, "getnameinfo", req.hostname)]);
        return;
      }
      __evCall(req.resolve, [{ hostname: hostname, service: service }]);
    };
    const err: any = __evCall(__dnsCares.getnameinfo, [req, address, Number(port)]);
    if (__dnsTruthy(err)) reject(new DNSException(err, "getnameinfo", address));
  });
}

// ---------------------------------------------------------------------------
// The resolve* family
// ---------------------------------------------------------------------------

// `internal/dns/callback_resolver.js`' `query`, for one binding name.
function __dnsQueryCallback(resolver: any, bindingName: string, name: any, rest: any[]): any {
  const given: number = Number(rest.length);
  let options: any = given > 1 ? rest[0] : undefined;
  let callback: any = given > 1 ? rest[1] : given > 0 ? rest[0] : undefined;

  __dnsValidateString(name, "name");
  __dnsValidateFunction(callback, "callback");

  const req: any = __evCall(__dnsCares.QueryReqWrap, []);
  req.bindingName = bindingName;
  req.callback = callback;
  req.hostname = name;
  req.ttl = options !== undefined && options !== null && __dnsTruthy(options.ttl);
  req.oncomplete = (err: any, result: any, ttls: any) => {
    __dnsOnResolve(req, err, result, ttls);
  };

  const handle: any = resolver._handle;
  const err: any = __evCall(handle[bindingName], [req, name]);
  if (__dnsTruthy(err)) throw new DNSException(err, bindingName, name);
  return req;
}

function __dnsOnResolve(req: any, err: any, result: any, ttls: any): void {
  let value: any = result;
  if (__dnsTruthy(ttls) && req.ttl === true) value = __dnsWithTtls(result, ttls);
  if (__dnsTruthy(err)) {
    __evCall(req.callback, [new DNSException(err, req.bindingName, req.hostname)]);
    return;
  }
  __evCall(req.callback, [null, value]);
}

function __dnsWithTtls(addresses: any, ttls: any): any {
  const out: any[] = [];
  const n: number = Number(addresses.length);
  for (let i = 0; i < n; i++) out.push({ address: addresses[i], ttl: ttls[i] });
  return out;
}

// `internal/dns/promises.js`' `query` / `createResolverPromise`.
function __dnsQueryPromise(resolver: any, bindingName: string, name: any, options: any): any {
  __dnsValidateString(name, "name");
  const ttl: boolean = options !== undefined && options !== null && __dnsTruthy(options.ttl);

  return new Promise((resolve: any, reject: any) => {
    const req: any = __evCall(__dnsCares.QueryReqWrap, []);
    req.bindingName = bindingName;
    req.hostname = name;
    req.resolve = resolve;
    req.reject = reject;
    req.ttl = ttl;
    req.oncomplete = (err: any, result: any, ttls: any) => {
      if (__dnsTruthy(err)) {
        __evCall(req.reject, [new DNSException(err, req.bindingName, req.hostname)]);
        return;
      }
      let value: any = result;
      if (__dnsTruthy(ttls) && req.ttl === true) value = __dnsWithTtls(result, ttls);
      __evCall(req.resolve, [value]);
    };
    const handle: any = resolver._handle;
    const err: any = __evCall(handle[bindingName], [req, name]);
    if (__dnsTruthy(err)) reject(new DNSException(err, bindingName, name));
  });
}

// `resolve(hostname, rrtype, callback)` — the `resolveMap` dispatch.
function __dnsResolveCallback(resolver: any, hostname: any, rest: any[]): any {
  const given: number = Number(rest.length);
  const rrtype: any = given > 0 ? rest[0] : undefined;
  let callback: any = given > 1 ? rest[1] : undefined;
  let bindingName: any = undefined;
  if (typeof rrtype === "string") {
    bindingName = __DNS_RRTYPE_MAP[rrtype];
  } else if (typeof rrtype === "function") {
    bindingName = "queryA";
    callback = rrtype;
  } else {
    throw new ERR_INVALID_ARG_TYPE("rrtype", "string", rrtype);
  }
  if (bindingName === undefined) throw new ERR_INVALID_ARG_VALUE("rrtype", rrtype, "is invalid");
  return __dnsQueryCallback(resolver, bindingName, hostname, [callback]);
}

// `resolve(hostname, rrtype)` — the promise half, where an absent `rrtype`
// means `A` and a present one must be a string naming a known type.
function __dnsResolvePromise(resolver: any, hostname: any, rrtype: any): any {
  let bindingName: any = "queryA";
  if (rrtype !== undefined) {
    __dnsValidateString(rrtype, "rrtype");
    bindingName = __DNS_RRTYPE_MAP[rrtype];
    if (bindingName === undefined) throw new ERR_INVALID_ARG_VALUE("rrtype", rrtype, "is invalid");
  }
  return __dnsQueryPromise(resolver, bindingName, hostname, undefined);
}

// ---------------------------------------------------------------------------
// The two Resolver classes
// ---------------------------------------------------------------------------

// `dns.Resolver` — one channel, callback-shaped queries.
class Resolver {
  _handle: any = undefined;
  constructor(options?: any) {
    const timeout: number = __dnsValidateTimeout(options);
    const tries: number = __dnsValidateTries(options);
    const maxTimeout: number = __dnsValidateMaxTimeout(options);
    this._handle = __dnsMakeChannel(timeout, tries, maxTimeout);
  }
  cancel(): void {
    __evCall(this._handle.cancel, []);
  }
  getServers(): string[] {
    return __dnsGetServers(this._handle);
  }
  setServers(servers: any): void {
    __dnsSetServers(this._handle, servers);
  }
  setLocalAddress(ipv4?: any, ipv6?: any): void {
    __dnsSetLocalAddress(this._handle, ipv4, ipv6);
  }
  resolve(hostname: any, ...rest: any[]): any {
    return __dnsResolveCallback(this, hostname, rest);
  }
  resolve4(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryA", name, rest);
  }
  resolve6(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryAaaa", name, rest);
  }
  resolveAny(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryAny", name, rest);
  }
  resolveCaa(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryCaa", name, rest);
  }
  resolveCname(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryCname", name, rest);
  }
  resolveMx(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryMx", name, rest);
  }
  resolveNaptr(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryNaptr", name, rest);
  }
  resolveNs(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryNs", name, rest);
  }
  resolvePtr(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryPtr", name, rest);
  }
  resolveSoa(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "querySoa", name, rest);
  }
  resolveSrv(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "querySrv", name, rest);
  }
  resolveTlsa(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryTlsa", name, rest);
  }
  resolveTxt(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "queryTxt", name, rest);
  }
  reverse(address: any, ...rest: any[]): any {
    return __dnsQueryCallback(this, "getHostByAddr", address, rest);
  }
}

// `dns.promises.Resolver`. Node names this class `Resolver` too; two top-level
// declarations of one name are a compile error here, and the name has to be a
// top-level class because `new <object>.Ctor()` does not reach a constructor
// (zun#18) — so this is the second name, and `tools/bundle_node_test.sh`
// rewrites `<alias>.promises.Resolver` to it.
class DnsPromiseResolver {
  _handle: any = undefined;
  constructor(options?: any) {
    const timeout: number = __dnsValidateTimeout(options);
    const tries: number = __dnsValidateTries(options);
    const maxTimeout: number = __dnsValidateMaxTimeout(options);
    this._handle = __dnsMakeChannel(timeout, tries, maxTimeout);
  }
  cancel(): void {
    __evCall(this._handle.cancel, []);
  }
  getServers(): string[] {
    return __dnsGetServers(this._handle);
  }
  setServers(servers: any): void {
    __dnsSetServers(this._handle, servers);
  }
  setLocalAddress(ipv4?: any, ipv6?: any): void {
    __dnsSetLocalAddress(this._handle, ipv4, ipv6);
  }
  resolve(hostname: any, rrtype?: any): any {
    return __dnsResolvePromise(this, hostname, rrtype);
  }
  resolve4(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryA", name, options);
  }
  resolve6(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryAaaa", name, options);
  }
  resolveAny(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryAny", name, options);
  }
  resolveCaa(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryCaa", name, options);
  }
  resolveCname(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryCname", name, options);
  }
  resolveMx(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryMx", name, options);
  }
  resolveNaptr(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryNaptr", name, options);
  }
  resolveNs(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryNs", name, options);
  }
  resolvePtr(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryPtr", name, options);
  }
  resolveSoa(name: any, options?: any): any {
    return __dnsQueryPromise(this, "querySoa", name, options);
  }
  resolveSrv(name: any, options?: any): any {
    return __dnsQueryPromise(this, "querySrv", name, options);
  }
  resolveTlsa(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryTlsa", name, options);
  }
  resolveTxt(name: any, options?: any): any {
    return __dnsQueryPromise(this, "queryTxt", name, options);
  }
  reverse(address: any, options?: any): any {
    return __dnsQueryPromise(this, "getHostByAddr", address, options);
  }
}

// ---------------------------------------------------------------------------
// The default resolver
// ---------------------------------------------------------------------------

// Node creates the default resolver lazily, the first time a `dns` module is
// loaded, and shares *one* channel between `dns` and `dns.promises` — which is
// why `dns.setServers()` is visible through `dns.promises.getServers()`. The
// two module objects below therefore hold no resolver of their own: each call
// reaches this pair.
const __dnsDefaultState: any = { callback: undefined, promise: undefined };

function __dnsDefaultResolver(): any {
  if (__dnsDefaultState.callback === undefined) {
    const resolver: any = new Resolver();
    __dnsDefaultState.callback = resolver;
    const promise: any = new DnsPromiseResolver();
    promise._handle = resolver._handle;
    __dnsDefaultState.promise = promise;
  }
  return __dnsDefaultState.callback;
}

function __dnsDefaultPromiseResolver(): any {
  __dnsDefaultResolver();
  return __dnsDefaultState.promise;
}

// `lib/dns.js`' `defaultResolverSetServers`: a *new* resolver takes the
// servers and becomes the default, so the module-level `setServers` never
// reports pending queries even when the old channel has some in flight. The
// validation runs on the new resolver before it is installed, so a rejected
// list leaves the current default untouched.
function __dnsDefaultSetServers(servers: any): void {
  const resolver: any = new Resolver();
  resolver.setServers(servers);
  const promise: any = new DnsPromiseResolver();
  promise._handle = resolver._handle;
  __dnsDefaultState.callback = resolver;
  __dnsDefaultState.promise = promise;
}

// ---------------------------------------------------------------------------
// The error-code constants both module objects export
// ---------------------------------------------------------------------------

const __DNS_NODATA: string = "ENODATA";
const __DNS_FORMERR: string = "EFORMERR";
const __DNS_SERVFAIL: string = "ESERVFAIL";
const __DNS_NOTFOUND: string = "ENOTFOUND";
const __DNS_NOTIMP: string = "ENOTIMP";
const __DNS_REFUSED: string = "EREFUSED";
const __DNS_BADQUERY: string = "EBADQUERY";
const __DNS_BADNAME: string = "EBADNAME";
const __DNS_BADFAMILY: string = "EBADFAMILY";
const __DNS_BADRESP: string = "EBADRESP";
const __DNS_CONNREFUSED: string = "ECONNREFUSED";
const __DNS_TIMEOUT: string = "ETIMEOUT";
const __DNS_EOF: string = "EOF";
const __DNS_FILE: string = "EFILE";
const __DNS_NOMEM: string = "ENOMEM";
const __DNS_DESTRUCTION: string = "EDESTRUCTION";
const __DNS_BADSTR: string = "EBADSTR";
const __DNS_BADFLAGS: string = "EBADFLAGS";
const __DNS_NONAME: string = "ENONAME";
const __DNS_BADHINTS: string = "EBADHINTS";
const __DNS_NOTINITIALIZED: string = "ENOTINITIALIZED";
const __DNS_LOADIPHLPAPI: string = "ELOADIPHLPAPI";
const __DNS_ADDRGETNETWORKPARAMS: string = "EADDRGETNETWORKPARAMS";
const __DNS_CANCELLED: string = "ECANCELLED";

// ---------------------------------------------------------------------------
// node:dns/promises
// ---------------------------------------------------------------------------

const __node_dns_promises: any = {
  lookup(hostname: any, options?: any): any {
    return __dnsLookupPromise(hostname, options);
  },
  lookupService(...args: any[]): any {
    return __dnsLookupServicePromise(args);
  },
  Resolver: DnsPromiseResolver,
  getDefaultResultOrder(): string {
    return __dnsGetDefaultResultOrder();
  },
  setDefaultResultOrder(value: any): void {
    __dnsSetDefaultResultOrder(value);
  },
  setServers(servers: any): void {
    __dnsDefaultSetServers(servers);
  },
  getServers(): string[] {
    return __dnsDefaultPromiseResolver().getServers();
  },
  resolve(hostname: any, rrtype?: any): any {
    return __dnsResolvePromise(__dnsDefaultPromiseResolver(), hostname, rrtype);
  },
  resolve4(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryA", name, options);
  },
  resolve6(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryAaaa", name, options);
  },
  resolveAny(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryAny", name, options);
  },
  resolveCaa(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryCaa", name, options);
  },
  resolveCname(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryCname", name, options);
  },
  resolveMx(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryMx", name, options);
  },
  resolveNaptr(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryNaptr", name, options);
  },
  resolveNs(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryNs", name, options);
  },
  resolvePtr(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryPtr", name, options);
  },
  resolveSoa(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "querySoa", name, options);
  },
  resolveSrv(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "querySrv", name, options);
  },
  resolveTlsa(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryTlsa", name, options);
  },
  resolveTxt(name: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "queryTxt", name, options);
  },
  reverse(address: any, options?: any): any {
    return __dnsQueryPromise(__dnsDefaultPromiseResolver(), "getHostByAddr", address, options);
  },

  NODATA: __DNS_NODATA,
  FORMERR: __DNS_FORMERR,
  SERVFAIL: __DNS_SERVFAIL,
  NOTFOUND: __DNS_NOTFOUND,
  NOTIMP: __DNS_NOTIMP,
  REFUSED: __DNS_REFUSED,
  BADQUERY: __DNS_BADQUERY,
  BADNAME: __DNS_BADNAME,
  BADFAMILY: __DNS_BADFAMILY,
  BADRESP: __DNS_BADRESP,
  CONNREFUSED: __DNS_CONNREFUSED,
  TIMEOUT: __DNS_TIMEOUT,
  EOF: __DNS_EOF,
  FILE: __DNS_FILE,
  NOMEM: __DNS_NOMEM,
  DESTRUCTION: __DNS_DESTRUCTION,
  BADSTR: __DNS_BADSTR,
  BADFLAGS: __DNS_BADFLAGS,
  NONAME: __DNS_NONAME,
  BADHINTS: __DNS_BADHINTS,
  NOTINITIALIZED: __DNS_NOTINITIALIZED,
  LOADIPHLPAPI: __DNS_LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS: __DNS_ADDRGETNETWORKPARAMS,
  CANCELLED: __DNS_CANCELLED,
};

// ---------------------------------------------------------------------------
// node:dns
// ---------------------------------------------------------------------------

const __node_dns: any = {
  lookup(hostname: any, ...rest: any[]): any {
    return __dnsLookup(hostname, rest);
  },
  lookupService(...args: any[]): any {
    return __dnsLookupService(args);
  },
  Resolver: Resolver,
  promises: __node_dns_promises,
  getDefaultResultOrder(): string {
    return __dnsGetDefaultResultOrder();
  },
  setDefaultResultOrder(value: any): void {
    __dnsSetDefaultResultOrder(value);
  },
  setServers(servers: any): void {
    __dnsDefaultSetServers(servers);
  },
  getServers(): string[] {
    return __dnsDefaultResolver().getServers();
  },
  resolve(hostname: any, ...rest: any[]): any {
    return __dnsResolveCallback(__dnsDefaultResolver(), hostname, rest);
  },
  resolve4(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryA", name, rest);
  },
  resolve6(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryAaaa", name, rest);
  },
  resolveAny(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryAny", name, rest);
  },
  resolveCaa(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryCaa", name, rest);
  },
  resolveCname(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryCname", name, rest);
  },
  resolveMx(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryMx", name, rest);
  },
  resolveNaptr(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryNaptr", name, rest);
  },
  resolveNs(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryNs", name, rest);
  },
  resolvePtr(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryPtr", name, rest);
  },
  resolveSoa(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "querySoa", name, rest);
  },
  resolveSrv(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "querySrv", name, rest);
  },
  resolveTlsa(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryTlsa", name, rest);
  },
  resolveTxt(name: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "queryTxt", name, rest);
  },
  reverse(address: any, ...rest: any[]): any {
    return __dnsQueryCallback(__dnsDefaultResolver(), "getHostByAddr", address, rest);
  },

  // uv_getaddrinfo flags, as the platform defines them.
  ADDRCONFIG: __DNS_AI_ADDRCONFIG,
  ALL: __DNS_AI_ALL,
  V4MAPPED: __DNS_AI_V4MAPPED,

  NODATA: __DNS_NODATA,
  FORMERR: __DNS_FORMERR,
  SERVFAIL: __DNS_SERVFAIL,
  NOTFOUND: __DNS_NOTFOUND,
  NOTIMP: __DNS_NOTIMP,
  REFUSED: __DNS_REFUSED,
  BADQUERY: __DNS_BADQUERY,
  BADNAME: __DNS_BADNAME,
  BADFAMILY: __DNS_BADFAMILY,
  BADRESP: __DNS_BADRESP,
  CONNREFUSED: __DNS_CONNREFUSED,
  TIMEOUT: __DNS_TIMEOUT,
  EOF: __DNS_EOF,
  FILE: __DNS_FILE,
  NOMEM: __DNS_NOMEM,
  DESTRUCTION: __DNS_DESTRUCTION,
  BADSTR: __DNS_BADSTR,
  BADFLAGS: __DNS_BADFLAGS,
  NONAME: __DNS_NONAME,
  BADHINTS: __DNS_BADHINTS,
  NOTINITIALIZED: __DNS_NOTINITIALIZED,
  LOADIPHLPAPI: __DNS_LOADIPHLPAPI,
  ADDRGETNETWORKPARAMS: __DNS_ADDRGETNETWORKPARAMS,
  CANCELLED: __DNS_CANCELLED,
};

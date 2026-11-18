// node:http — the Node-shaped `http` module, in Zun TypeScript over `node:net`
// and `node:stream`.
//
// Behavior is defined by Node.js 25: the module is measured against Node's own
// `test/parallel/test-http-*.js` files (see ../../test/http/). The shapes follow
// Node's `lib/_http_common.js`, `_http_incoming.js`, `_http_outgoing.js`,
// `_http_server.js`, `_http_client.js` and `_http_agent.js` (MIT, Copyright
// Joyent, Inc. and other Node contributors): the header-storage rules, the
// implicit-header logic (Content-Length vs chunked vs close), the keep-alive
// decision, the 100-continue handshake, the agent's socket pool, and the error
// codes and messages.
//
// ---------------------------------------------------------------------------
// Where this module sits
// ---------------------------------------------------------------------------
//
// Node parses HTTP with llhttp, a C state machine. There is no such thing here,
// and no syscall to add: the parser is a small incremental HTTP/1.1 state
// machine written in TypeScript (`__httpParse`), fed with the bytes a `net.Socket`
// delivers. It reads the start line, the header block, and then one of four body
// framings — none, `Content-Length`, `Transfer-Encoding: chunked` (with
// trailers), or "until the connection closes" (a response with neither). A
// message that completes resets the machine, which is what keep-alive and
// pipelining are.
//
// Bytes are kept as a *latin1 string* between the socket and the parser. HTTP
// framing is 7-bit ASCII and a body is opaque octets; latin1 maps one byte to one
// code unit in both directions, so slicing the string at byte offsets and turning
// a slice back into a `Buffer` is exact. Body bytes are never decoded as text
// here.
//
// There is deliberately no `src/http/*.rs`: everything http needs from the
// kernel is a socket, and `net` already owns that.
//
// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
//
// One bundle is one Zun program, so every top-level name is shared with `net`,
// `stream` and `events`. `net` already declares `Server` and `Socket`; the http
// classes are therefore `__HttpServer` and so on internally and are published
// under Node's names on the module object only.
//
// Engine workarounds are the ones `src/net/net.ts` documents (zun#1, #3, #13,
// #17, #19, #37, #38, #58): `any` locals, `Number(x.length)`, object-literal
// methods as callbacks, stream hooks through `__sSetOptFn`, side-state in plain
// objects instead of function-typed class fields.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __HTTP_METHODS: string[] = [
  "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK",
  "LOCK", "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE",
  "NOTIFY", "OPTIONS", "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT",
  "QUERY", "REBIND", "REPORT", "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND",
  "UNLINK", "UNLOCK", "UNSUBSCRIBE",
];

const __HTTP_STATUS_CODES: any = {
  "100": "Continue",
  "101": "Switching Protocols",
  "102": "Processing",
  "103": "Early Hints",
  "200": "OK",
  "201": "Created",
  "202": "Accepted",
  "203": "Non-Authoritative Information",
  "204": "No Content",
  "205": "Reset Content",
  "206": "Partial Content",
  "207": "Multi-Status",
  "208": "Already Reported",
  "226": "IM Used",
  "300": "Multiple Choices",
  "301": "Moved Permanently",
  "302": "Found",
  "303": "See Other",
  "304": "Not Modified",
  "305": "Use Proxy",
  "307": "Temporary Redirect",
  "308": "Permanent Redirect",
  "400": "Bad Request",
  "401": "Unauthorized",
  "402": "Payment Required",
  "403": "Forbidden",
  "404": "Not Found",
  "405": "Method Not Allowed",
  "406": "Not Acceptable",
  "407": "Proxy Authentication Required",
  "408": "Request Timeout",
  "409": "Conflict",
  "410": "Gone",
  "411": "Length Required",
  "412": "Precondition Failed",
  "413": "Payload Too Large",
  "414": "URI Too Long",
  "415": "Unsupported Media Type",
  "416": "Range Not Satisfiable",
  "417": "Expectation Failed",
  "418": "I'm a Teapot",
  "421": "Misdirected Request",
  "422": "Unprocessable Entity",
  "423": "Locked",
  "424": "Failed Dependency",
  "425": "Too Early",
  "426": "Upgrade Required",
  "428": "Precondition Required",
  "429": "Too Many Requests",
  "431": "Request Header Fields Too Large",
  "451": "Unavailable For Legal Reasons",
  "500": "Internal Server Error",
  "501": "Not Implemented",
  "502": "Bad Gateway",
  "503": "Service Unavailable",
  "504": "Gateway Timeout",
  "505": "HTTP Version Not Supported",
  "506": "Variant Also Negotiates",
  "507": "Insufficient Storage",
  "508": "Loop Detected",
  "509": "Bandwidth Limit Exceeded",
  "510": "Not Extended",
  "511": "Network Authentication Required",
};

// `http.maxHeaderSize`, the `--max-http-header-size` default.
const __HTTP_MAX_HEADER_SIZE: number = 16384;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function __httpIsFn(value: any): boolean {
  return __evIsFn(value);
}

function __httpIsObj(value: any): boolean {
  return value !== null && typeof value === "object";
}

function __httpInvoke(fn: any, args: any[]): any {
  if (fn === undefined || fn === null) return undefined;
  return __evCall(fn, args);
}

function __httpTick(fn: any, a?: any, b?: any): void {
  if (fn === undefined || fn === null) return;
  if (b !== undefined) {
    __processNextTick(fn, a, b);
  } else if (a !== undefined) {
    __processNextTick(fn, a);
  } else {
    __processNextTick(fn);
  }
}

function __httpTruthy(value: any): boolean {
  if (value === undefined || value === null) return false;
  return value ? true : false;
}

function __httpLower(text: any): string {
  return String(text).toLowerCase();
}

function __httpCc(text: string, index: number): number {
  if (index < 0 || index >= Number(text.length)) return -1;
  return Number(text.charCodeAt(index));
}

// A string's byte length, as it would go on the wire.
function __httpByteLen(chunk: any, encoding: any): number {
  if (typeof chunk === "string") {
    const text: string = chunk;
    let name: string = encoding === undefined || encoding === null ? "utf8" : String(encoding);
    if (name === "" || name === "buffer") name = "utf8";
    return Number(Buffer.byteLength(text, name));
  }
  const view: Buffer = chunk;
  return Number(view.length);
}

// A chunk as a `Buffer`, whatever the caller handed in.
function __httpToBuffer(chunk: any, encoding: any): Buffer {
  if (typeof chunk === "string") {
    const text: string = chunk;
    let name: string = encoding === undefined || encoding === null ? "utf8" : String(encoding);
    if (name === "" || name === "buffer") name = "utf8";
    return Buffer.from(text, name);
  }
  const view: Buffer = chunk;
  return view;
}

function __httpLatin1(chunk: any): string {
  const view: Buffer = chunk;
  return view.toString("latin1");
}

function __httpFromLatin1(text: string): Buffer {
  return Buffer.from(text, "latin1");
}

// A Node `Buffer`/`Uint8Array`-like argument, as opposed to a string.
function __httpIsBytes(value: any): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return false;
  if (typeof value !== "object") return false;
  return ArrayBuffer.isView(value);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class __HttpError extends NodeError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

class __HttpTypeError extends NodeTypeError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

class __HttpRangeError extends NodeRangeError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

// A transport-level error: the fields Node's `uvException` and llhttp errors
// carry. Declared up front for the reason every error class here declares its
// `code` (zun#37).
class __HttpSocketError extends NodeError {
  syscall: any = undefined;
  reason: any = undefined;
  bytesParsed: any = undefined;
  rawPacket: any = undefined;
  constructor(code: string, message: string) {
    super(code, message);
  }
}

// `ERR_INVALID_HTTP_TOKEN`, `Header name must be a valid HTTP token ["x"]`.
function __httpBadToken(label: string, value: any): any {
  return new __HttpTypeError(
    "ERR_INVALID_HTTP_TOKEN",
    label + ' must be a valid HTTP token ["' + __httpShow(value) + '"]',
  );
}

function __httpShow(value: any): string {
  if (typeof value === "string") return value;
  return __evInspect(value);
}

function __httpHeadersSent(action: string): any {
  return new __HttpError(
    "ERR_HTTP_HEADERS_SENT",
    "Cannot " + action + " headers after they are sent to the client",
  );
}

// ---------------------------------------------------------------------------
// Header validation (`lib/_http_common.js`)
// ---------------------------------------------------------------------------

// RFC 7230 `tchar`.
function __httpIsTokenChar(c: number): boolean {
  if (c >= 48 && c <= 57) return true; // 0-9
  if (c >= 65 && c <= 90) return true; // A-Z
  if (c >= 97 && c <= 122) return true; // a-z
  switch (c) {
    case 33: // !
    case 35: // #
    case 36: // $
    case 37: // %
    case 38: // &
    case 39: // '
    case 42: // *
    case 43: // +
    case 45: // -
    case 46: // .
    case 94: // ^
    case 95: // _
    case 96: // `
    case 124: // |
    case 126: // ~
      return true;
  }
  return false;
}

function __httpCheckIsToken(value: any): boolean {
  if (typeof value !== "string") return false;
  const text: string = value;
  const n: number = Number(text.length);
  if (n === 0) return false;
  let i = 0;
  while (i < n) {
    if (!__httpIsTokenChar(__httpCc(text, i))) return false;
    i = i + 1;
  }
  return true;
}

// `checkInvalidHeaderChar`: true when the value holds something illegal.
function __httpInvalidHeaderChar(value: string): boolean {
  const n: number = Number(value.length);
  let i = 0;
  while (i < n) {
    const c: number = __httpCc(value, i);
    if (c === 9) {
      i = i + 1;
      continue;
    }
    if (c < 32 || c === 127 || c > 255) return true;
    i = i + 1;
  }
  return false;
}

function __httpValidateHeaderName(name: any, label?: any): void {
  if (typeof name !== "string" || name === "" || !__httpCheckIsToken(name)) {
    const what: string = label === undefined || label === null ? "Header name" : String(label);
    throw __httpBadToken(what, name);
  }
}

function __httpValidateHeaderValue(name: any, value: any): void {
  if (value === undefined) {
    throw new __HttpTypeError(
      "ERR_HTTP_INVALID_HEADER_VALUE",
      'Invalid value "undefined" for header "' + String(name) + '"',
    );
  }
  if (__httpInvalidHeaderChar(String(value))) {
    throw new __HttpTypeError(
      "ERR_INVALID_CHAR",
      'Invalid character in header content ["' + String(name) + '"]',
    );
  }
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------
//
// One parser per connection direction. `kind` 0 reads requests, 1 reads
// responses. The state is a plain object; the consumer is a handler *object*
// with `headers`, `body`, `complete`, `error` methods (an object-literal method
// survives every path through an `any`, zun#17).
//
// States: 0 start line, 1 body by length, 2 chunk-size line, 3 chunk data,
// 4 chunk CRLF, 5 trailers, 6 body until close, 7 stopped (upgrade / error).

function __httpNewParser(kind: number, handler: any): any {
  return {
    kind: kind,
    handler: handler,
    buf: "",
    state: 0,
    remaining: 0,
    maxHeaderSize: __HTTP_MAX_HEADER_SIZE,
    // Client side: the response to a HEAD (or a 304) has no body whatever its
    // headers claim.
    skipBody: false,
    chunkedBody: false,
    // The pieces of the message in progress.
    trailers: [],
    consumed: 0,
    lenient: false,
    // Node's `parser.incoming`: the request being received or read.
    incoming: null,
    // The chunk handed to the last `__httpParse` (for errors' `rawPacket`).
    lastInput: "",
    errAt: -1,
  };
}

function __httpParserError(p: any, code: string, reason: string): void {
  p.state = 7;
  const err: any = new __HttpSocketError(code, "Parse Error: " + reason);
  err.reason = reason;
  // Node reports the chunk being executed and how far into it parsing got.
  const input: string = p.lastInput;
  let parsed: number = Number(input.length) - Number(p.buf.length);
  if (parsed < 0) parsed = 0;
  // An error found at a known byte of the buffer (llhttp stops just past it).
  if (Number(p.errAt) >= 0) parsed = parsed + Number(p.errAt);
  p.errAt = -1;
  err.bytesParsed = parsed;
  err.rawPacket = __httpFromLatin1(input);
  p.handler.error(err);
}

// Feed more bytes (as latin1) into the parser.
function __httpParse(p: any, input: string): void {
  if (Number(p.state) === 7) return;
  p.lastInput = input;
  p.buf = p.buf + input;
  __httpDrive(p);
}

function __httpDrive(p: any): void {
  while (true) {
    const st: number = Number(p.state);
    if (st === 7) return;
    if (st === 0) {
      if (!__httpParseHead(p)) return;
      continue;
    }
    const buf: string = p.buf;
    const have: number = Number(buf.length);
    if (st === 1) {
      if (have === 0) return;
      let take: number = Number(p.remaining);
      if (take > have) take = have;
      const slice: string = buf.slice(0, take);
      p.buf = buf.slice(take);
      p.remaining = Number(p.remaining) - take;
      p.handler.body(__httpFromLatin1(slice));
      if (Number(p.state) === 7) return;
      if (Number(p.remaining) === 0) __httpFinishMessage(p);
      continue;
    }
    if (st === 2) {
      const eol: number = Number(buf.indexOf("\r\n"));
      // Node caps chunk extensions at 16 KiB (`kMaxChunkExtensionsSize`).
      if ((eol < 0 && have > 16384) || eol > 16384) {
        __httpParserError(p, "HPE_CHUNK_EXTENSIONS_OVERFLOW", "Chunk extensions overflow");
        return;
      }
      if (eol < 0) return;
      let line: string = buf.slice(0, eol);
      if (line.indexOf("\r") >= 0 || line.indexOf("\n") >= 0) {
        // A bare CR or LF inside the size line (smuggling).
        __httpParserError(p, "HPE_LF_EXPECTED", "Expected LF after chunk size");
        return;
      }
      const semi: number = Number(line.indexOf(";"));
      if (semi >= 0) line = line.slice(0, semi);
      line = line.trim();
      if (line === "" || !__httpIsHex(line)) {
        __httpParserError(p, "HPE_INVALID_CHUNK_SIZE", "Invalid character in chunk size");
        return;
      }
      p.buf = buf.slice(eol + 2);
      const size: number = parseInt(line, 16);
      if (size === 0) {
        p.state = 5;
        p.trailers = [];
      } else {
        p.remaining = size;
        p.state = 3;
      }
      continue;
    }
    if (st === 3) {
      if (have === 0) return;
      let take: number = Number(p.remaining);
      if (take > have) take = have;
      const slice: string = buf.slice(0, take);
      p.buf = buf.slice(take);
      p.remaining = Number(p.remaining) - take;
      p.handler.body(__httpFromLatin1(slice));
      if (Number(p.state) === 7) return;
      if (Number(p.remaining) === 0) p.state = 4;
      continue;
    }
    if (st === 4) {
      if (have < 2) return;
      if (buf.slice(0, 2) !== "\r\n") {
        __httpParserError(p, "HPE_STRICT", "Expected LF after chunk data");
        return;
      }
      p.buf = buf.slice(2);
      p.state = 2;
      continue;
    }
    if (st === 5) {
      const eol: number = Number(buf.indexOf("\r\n"));
      if (eol < 0) return;
      const line: string = buf.slice(0, eol);
      p.buf = buf.slice(eol + 2);
      if (line === "") {
        __httpFinishMessage(p);
        continue;
      }
      const colon: number = Number(line.indexOf(":"));
      if (colon <= 0) {
        __httpParserError(p, "HPE_INVALID_HEADER_TOKEN", "Invalid header token");
        return;
      }
      p.trailers.push(line.slice(0, colon));
      p.trailers.push(line.slice(colon + 1).trim());
      continue;
    }
    if (st === 6) {
      if (have === 0) return;
      p.buf = "";
      p.handler.body(__httpFromLatin1(buf));
      return;
    }
    return;
  }
}

function __httpIsHex(text: string): boolean {
  const n: number = Number(text.length);
  let i = 0;
  while (i < n) {
    const c: number = __httpCc(text, i);
    const ok: boolean =
      (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
    if (!ok) return false;
    i = i + 1;
  }
  return true;
}

// The message is complete: hand it over and rearm for the next one.
function __httpFinishMessage(p: any): void {
  const trailers: any = p.trailers;
  p.trailers = [];
  p.state = 0;
  p.skipBody = false;
  p.handler.complete(trailers);
}

// Parse a start line and the header block. Returns true when a message head was
// consumed and driving should continue.
function __httpParseHead(p: any): boolean {
  let buf: string = p.buf;
  // Empty lines before a start line are ignored (RFC 7230 3.5).
  while (buf.length >= 2 && buf.slice(0, 2) === "\r\n") {
    buf = buf.slice(2);
  }
  p.buf = buf;
  if (Number(buf.length) === 0) return false;
  // llhttp knows its methods and fails on the first byte that cannot start
  // one, without waiting for the rest of the head.
  if (Number(p.kind) === 0 && !__httpMethodPrefixOk(buf)) {
    p.errAt = __httpMethodMatchLen(buf);
    __httpParserError(p, "HPE_INVALID_METHOD", "Invalid method encountered");
    return false;
  }
  if (Number(p.kind) === 1) {
    const n: number = Number(buf.length) < 5 ? Number(buf.length) : 5;
    if (buf.slice(0, n) !== "HTTP/".slice(0, n)) {
      __httpParserError(p, "HPE_INVALID_CONSTANT", "Expected HTTP/, RTSP/ or ICE/");
      return false;
    }
  }
  const end: number = Number(buf.indexOf("\r\n\r\n"));
  if (end < 0) {
    if (Number(buf.length) > Number(p.maxHeaderSize)) {
      __httpParserError(p, "HPE_HEADER_OVERFLOW", "Header overflow");
    }
    return false;
  }
  if (end + 4 > Number(p.maxHeaderSize)) {
    __httpParserError(p, "HPE_HEADER_OVERFLOW", "Header overflow");
    return false;
  }
  const head: string = buf.slice(0, end);
  p.buf = buf.slice(end + 4);
  const lines: string[] = head.split("\r\n");
  const first: string = lines[0];

  const info: any = {
    method: undefined,
    url: undefined,
    versionMajor: 1,
    versionMinor: 1,
    statusCode: 0,
    statusMessage: "",
    headers: [],
    shouldKeepAlive: true,
    upgrade: false,
  };

  if (Number(p.kind) === 0) {
    const sp1: number = Number(first.indexOf(" "));
    if (sp1 <= 0) {
      __httpParserError(p, "HPE_INVALID_METHOD", "Invalid method encountered");
      return false;
    }
    const method: string = first.slice(0, sp1);
    if (__HTTP_METHODS.indexOf(method) < 0) {
      __httpParserError(p, "HPE_INVALID_METHOD", "Invalid method encountered");
      return false;
    }
    const rest: string = first.slice(sp1 + 1);
    const sp2: number = Number(rest.lastIndexOf(" "));
    if (sp2 < 0) {
      __httpParserError(p, "HPE_INVALID_URL", "Invalid URL");
      return false;
    }
    const url: string = rest.slice(0, sp2);
    const version: string = rest.slice(sp2 + 1);
    if (url === "") {
      __httpParserError(p, "HPE_INVALID_URL", "Invalid URL");
      return false;
    }
    if (!__httpParseVersion(info, version)) {
      __httpParserError(p, "HPE_INVALID_VERSION", "Invalid HTTP version");
      return false;
    }
    info.method = method;
    info.url = url;
  } else {
    if (first.slice(0, 5) !== "HTTP/") {
      __httpParserError(p, "HPE_INVALID_CONSTANT", "Expected HTTP/, RTSP/ or ICE/");
      return false;
    }
    const sp1: number = Number(first.indexOf(" "));
    if (sp1 < 0) {
      __httpParserError(p, "HPE_INVALID_VERSION", "Invalid HTTP version");
      return false;
    }
    if (!__httpParseVersion(info, first.slice(0, sp1))) {
      __httpParserError(p, "HPE_INVALID_VERSION", "Invalid HTTP version");
      return false;
    }
    const rest: string = first.slice(sp1 + 1);
    const sp2: number = Number(rest.indexOf(" "));
    const codeText: string = sp2 < 0 ? rest : rest.slice(0, sp2);
    const code: number = parseInt(codeText, 10);
    if (Number.isNaN(code) || Number(codeText.length) !== 3) {
      __httpParserError(p, "HPE_INVALID_STATUS", "Invalid status code");
      return false;
    }
    info.statusCode = code;
    info.statusMessage = sp2 < 0 ? "" : rest.slice(sp2 + 1);
  }

  // Header lines.
  let contentLength: number = -1;
  let chunked = false;
  let hasTE = false;
  let connection: string = "";
  let upgradeHeader = false;
  let i = 1;
  const nlines: number = Number(lines.length);
  while (i < nlines) {
    const line: string = lines[i];
    i = i + 1;
    if (line === "") continue;
    const c0: number = __httpCc(line, 0);
    if (c0 === 32 || c0 === 9) {
      // obs-fold: continuation of the previous value.
      const count: number = Number(info.headers.length);
      if (count >= 2) {
        info.headers[count - 1] = String(info.headers[count - 1]) + " " + line.trim();
        continue;
      }
      __httpParserError(p, "HPE_INVALID_HEADER_TOKEN", "Invalid header token");
      return false;
    }
    const colon: number = Number(line.indexOf(":"));
    if (colon <= 0) {
      __httpParserError(p, "HPE_INVALID_HEADER_TOKEN", "Invalid header token");
      return false;
    }
    const name: string = line.slice(0, colon);
    if (!__httpCheckIsToken(name)) {
      __httpParserError(p, "HPE_INVALID_HEADER_TOKEN", "Invalid header token");
      return false;
    }
    const value: string = line.slice(colon + 1).trim();
    // llhttp is strict about line endings and control characters in values: a
    // bare CR or LF is how header smuggling hides a second header.
    const badValue: number = __httpBadValueChar(line.slice(colon + 1));
    if (badValue === 13) {
      __httpParserError(p, "HPE_LF_EXPECTED", "Missing expected LF after header value");
      return false;
    }
    if (badValue === 10) {
      __httpParserError(p, "HPE_CR_EXPECTED", "Missing expected CR after header value");
      return false;
    }
    if (badValue > 0) {
      __httpParserError(p, "HPE_INVALID_HEADER_TOKEN", "Invalid header value char");
      return false;
    }
    info.headers.push(name);
    info.headers.push(value);
    const lname: string = name.toLowerCase();
    if (lname === "content-length") {
      const n: number = parseInt(value, 10);
      if (Number.isNaN(n) || n < 0 || !__httpAllDigits(value)) {
        __httpParserError(p, "HPE_INVALID_CONTENT_LENGTH", "Invalid character in Content-Length");
        return false;
      }
      if (contentLength >= 0 && contentLength !== n) {
        __httpParserError(p, "HPE_UNEXPECTED_CONTENT_LENGTH", "Duplicate Content-Length");
        return false;
      }
      contentLength = n;
    } else if (lname === "transfer-encoding") {
      hasTE = true;
    } else if (lname === "connection") {
      connection = connection === "" ? value.toLowerCase() : connection + "," + value.toLowerCase();
    } else if (lname === "upgrade") {
      upgradeHeader = true;
    }
  }

  // Transfer codings, read after the loop so that an obs-fold continuation
  // counts: `chunked` must be the final one.
  let h = 0;
  while (hasTE && h + 1 < Number(info.headers.length)) {
    if (String(info.headers[h]).toLowerCase() === "transfer-encoding") {
      const parts: string[] = String(info.headers[h + 1]).toLowerCase().split(",");
      for (const part of parts) {
        if (chunked) {
          __httpParserError(p, "HPE_INVALID_TRANSFER_ENCODING", "Invalid `Transfer-Encoding` header value");
          return false;
        }
        if (part.trim() === "chunked") chunked = true;
      }
    }
    h = h + 2;
  }
  if (hasTE && contentLength >= 0) {
    __httpParserError(p, "HPE_INVALID_TRANSFER_ENCODING", "Transfer-Encoding can't be present with Content-Length");
    return false;
  }

  // Keep-alive, per RFC 7230 6.3.
  const hasClose: boolean = __httpTokenIn(connection, "close");
  const hasKeep: boolean = __httpTokenIn(connection, "keep-alive");
  if (Number(info.versionMajor) === 1 && Number(info.versionMinor) >= 1) {
    info.shouldKeepAlive = !hasClose;
  } else {
    info.shouldKeepAlive = hasKeep;
  }
  const hasUpgrade: boolean = __httpTokenIn(connection, "upgrade") && upgradeHeader;
  info.upgrade = hasUpgrade || (Number(p.kind) === 0 && info.method === "CONNECT");
  info.contentLength = contentLength;
  info.chunked = chunked;

  // The handler decides what the head means: 0 normal, 1 this response has no
  // body (the answer to a HEAD), 2 the connection is being upgraded and parsing
  // stops here.
  const action: number = Number(p.handler.headers(info));
  if (action === 2) {
    p.state = 7;
    const rest: string = p.buf;
    p.buf = "";
    p.handler.upgrade(info, rest);
    return false;
  }
  if (Number(p.state) === 7) return false;
  if (hasTE && !chunked && Number(p.kind) === 0) {
    // llhttp reports this after the head callback: the request is emitted,
    // its body never arrives.
    __httpParserError(p, "HPE_INVALID_TRANSFER_ENCODING", "Request has invalid `Transfer-Encoding`");
    return false;
  }

  const status: number = Number(info.statusCode);
  let noBody = false;
  if (Number(p.kind) === 1) {
    if (action === 1 || (status >= 100 && status < 200) || status === 204 || status === 304) {
      noBody = true;
    }
  }
  if (noBody) {
    __httpFinishMessage(p);
    return true;
  }
  if (chunked) {
    p.state = 2;
    return true;
  }
  if (contentLength >= 0) {
    if (contentLength === 0) {
      __httpFinishMessage(p);
      return true;
    }
    p.remaining = contentLength;
    p.state = 1;
    return true;
  }
  if (Number(p.kind) === 0) {
    // A request without a length has no body.
    __httpFinishMessage(p);
    return true;
  }
  // A response without a length runs until the connection closes.
  p.state = 6;
  return true;
}

// How many leading bytes of `buf` some known method still matches.
function __httpMethodMatchLen(buf: string): number {
  let best = 0;
  for (const m of __HTTP_METHODS) {
    let i = 0;
    const n: number = Number(m.length) < Number(buf.length) ? Number(m.length) : Number(buf.length);
    while (i < n && m.charAt(i) === buf.charAt(i)) i = i + 1;
    if (i > best) best = i;
  }
  return best;
}

// `maxHeadersCount`: null/undefined is Node's default of 2000, 0 is no limit.
function __httpLimitHeaders(raw: any, max: any): any {
  let limit: number = max === null || max === undefined ? 2000 : Number(max);
  if (!(limit > 0)) return raw;
  if (Number(raw.length) <= limit * 2) return raw;
  return raw.slice(0, limit * 2);
}

// Whether the start of a request buffer can still be (or is) a known method.
function __httpMethodPrefixOk(buf: string): boolean {
  const sp: number = Number(buf.indexOf(" "));
  const head: string = sp >= 0 ? buf.slice(0, sp) : buf;
  if (sp >= 0) return __HTTP_METHODS.indexOf(head) >= 0;
  if (Number(head.length) > 24) return false;
  for (const m of __HTTP_METHODS) {
    if (m.slice(0, Number(head.length)) === head) return true;
  }
  return false;
}

// The first character a header value may not hold (a CTL other than HTAB), or 0.
function __httpBadValueChar(text: string): number {
  const n: number = Number(text.length);
  let i = 0;
  while (i < n) {
    const c: number = __httpCc(text, i);
    if ((c < 32 && c !== 9) || c === 127) return c;
    i = i + 1;
  }
  return 0;
}

function __httpAllDigits(text: string): boolean {
  const n: number = Number(text.length);
  if (n === 0) return false;
  let i = 0;
  while (i < n) {
    const c: number = __httpCc(text, i);
    if (c < 48 || c > 57) return false;
    i = i + 1;
  }
  return true;
}

function __httpParseVersion(info: any, text: string): boolean {
  if (text.slice(0, 5) !== "HTTP/") return false;
  const rest: string = text.slice(5);
  const dot: number = Number(rest.indexOf("."));
  if (dot < 1) return false;
  const major: string = rest.slice(0, dot);
  const minor: string = rest.slice(dot + 1);
  if (!__httpAllDigits(major) || !__httpAllDigits(minor)) return false;
  info.versionMajor = parseInt(major, 10);
  info.versionMinor = parseInt(minor, 10);
  return true;
}

// Is `token` one of the comma separated words in `list`?
function __httpTokenIn(list: string, token: string): boolean {
  if (list === "") return false;
  const parts: string[] = list.split(",");
  for (const part of parts) {
    if (part.trim() === token) return true;
  }
  return false;
}

// The peer closed the connection: finish a body that runs until close, or
// report a message cut short.
function __httpParserEof(p: any): void {
  const st: number = Number(p.state);
  if (st === 6) {
    __httpFinishMessage(p);
  } else if (st === 7) {
    // nothing
  } else if (st === 0 && Number(p.buf.length) === 0) {
    // clean end between messages
  } else {
    p.state = 7;
    p.handler.truncated();
  }
}

// ---------------------------------------------------------------------------
// IncomingMessage (`lib/_http_incoming.js`)
// ---------------------------------------------------------------------------
//
// A `Readable` over one parsed message. Its `_read` is the connection's way of
// being told that the consumer wants more: the socket was paused when `push`
// answered `false`, and `_read` lets it go again.

class IncomingMessage extends Readable {
  httpVersionMajor: any = 1;
  httpVersionMinor: any = 1;
  httpVersion: any = "1.1";
  complete: any = false;
  rawHeaders: any = [];
  rawTrailers: any = [];
  joinDuplicateHeaders: any = false;
  aborted: any = false;
  upgrade: any = false;
  url: any = "";
  method: any = null;
  statusCode: any = null;
  statusMessage: any = null;
  client: any = null;
  _consuming: any = false;
  _dumped: any = false;
  socket: any = null;
  req: any = undefined;
  res: any = undefined;
  shouldKeepAlive: any = true;
  _in: any = null;
  _headersObj: any = null;
  _trailersObj: any = null;

  constructor(socket?: any) {
    super({ autoDestroy: false });
    this._in = { paused: false };
    // Node leaves `socket` undefined on a message made without one.
    this.socket = socket;
    this.client = this.socket;
    const self: any = this;
    __sSetOptFn(self, "read", function (n: any): void {
      __httpIncomingRead(self);
    });
    __sSetOptFn(self, "destroy", function (err: any, cb: any): void {
      __httpIncomingDestroy(self, err, cb);
    });
  }

  get connection(): any {
    return this.socket;
  }

  set connection(value: any) {
    this.socket = value;
  }

  get headers(): any {
    if (this._headersObj === null) {
      this._headersObj = __httpHeadersObject(this.rawHeaders, this.joinDuplicateHeaders === true, false);
    }
    return this._headersObj;
  }

  set headers(value: any) {
    this._headersObj = value;
  }

  get headersDistinct(): any {
    return __httpHeadersObject(this.rawHeaders, false, true);
  }

  get trailers(): any {
    if (this._trailersObj === null) {
      this._trailersObj = __httpHeadersObject(this.rawTrailers, this.joinDuplicateHeaders === true, false);
    }
    return this._trailersObj;
  }

  set trailers(value: any) {
    this._trailersObj = value;
  }

  get trailersDistinct(): any {
    return __httpHeadersObject(this.rawTrailers, false, true);
  }

  setTimeout(msecs: any, callback?: any): any {
    if (callback !== undefined && callback !== null) this.on("timeout", callback);
    const sock: any = this.socket;
    if (sock !== null && sock !== undefined) sock.setTimeout(msecs);
    return this;
  }

  // `_dump`: discard the body so the connection can be reused.
  _dump(): void {
    if (this._dumped !== true) {
      this._dumped = true;
      this.removeAllListeners("data");
      this.resume();
    }
  }
}

// `_read`: the consumer wants data, so the connection may be read again.
function __httpIncomingRead(self: any): void {
  if (self._consuming !== true) self._consuming = true;
  const st: any = self._in;
  if (st.paused === true) {
    st.paused = false;
    const sock: any = self.socket;
    if (sock !== null && sock !== undefined && sock.destroyed !== true) sock.resume();
  }
}

function __httpIncomingDestroy(self: any, err: any, cb: any): void {
  let error: any = err;
  if (self.readableEnded !== true || self.complete !== true) {
    self.aborted = true;
    self.emit("aborted");
  }
  const sock: any = self.socket;
  if (sock !== null && sock !== undefined && sock.destroyed !== true && self.aborted === true) {
    // An aborted request takes its connection with it.
    sock.destroy(error);
  }
  if (error !== undefined && error !== null && self.aborted === true && Number(self.listenerCount("error")) === 0) {
    // Node drops an error nobody listens for rather than crashing the server
    // over a client that went away.
    error = null;
  }
  __httpInvoke(cb, [error]);
}

// Build the `headers` object the way `_http_incoming.js` does: names are
// lowercased, duplicates are joined (or dropped, for the singleton headers),
// and `set-cookie` is always an array.
function __httpHeadersObject(raw: any, join: boolean, distinct: boolean): any {
  const out: any = {};
  const n: number = Number(raw.length);
  let i = 0;
  while (i + 1 < n) {
    const name: string = String(raw[i]).toLowerCase();
    const value: string = String(raw[i + 1]);
    i = i + 2;
    if (distinct) {
      if (!Object.hasOwn(out, name)) out[name] = [];
      out[name].push(value);
      continue;
    }
    // Own keys only: `constructor`, `toString`, ... are ordinary header names.
    const prior: any = Object.hasOwn(out, name) ? out[name] : undefined;
    if (prior === undefined) {
      out[name] = name === "set-cookie" ? [value] : value;
      continue;
    }
    if (name === "set-cookie") {
      prior.push(value);
    } else if (!join && __httpDropsDuplicates(name)) {
      // keep the first
    } else if (name === "cookie") {
      out[name] = String(prior) + "; " + value;
    } else {
      out[name] = String(prior) + ", " + value;
    }
  }
  return out;
}

function __httpDropsDuplicates(name: string): boolean {
  switch (name) {
    case "age":
    case "authorization":
    case "content-length":
    case "content-type":
    case "etag":
    case "expires":
    case "from":
    case "host":
    case "if-modified-since":
    case "if-unmodified-since":
    case "last-modified":
    case "location":
    case "max-forwards":
    case "proxy-authorization":
    case "referer":
    case "retry-after":
    case "server":
    case "user-agent":
      return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// OutgoingMessage (`lib/_http_outgoing.js`)
// ---------------------------------------------------------------------------
//
// A `Writable` whose sink is the connection. Header storage is a plain object
// keyed by the lowercased name, each entry `[originalName, value]`; the header
// block is *serialised once*, by `__httpStoreHeader`, when the first byte has to
// go out — which is when `headersSent` flips.

// A header-table entry by lowercased name, own keys only: `constructor`,
// `toString`, ... are ordinary header names, not `Object.prototype` members.
function __httpHdr(table: any, key: string): any {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

class OutgoingMessage extends Writable {
  _hdrs: any = null;
  _header: any = null;
  _headerFlushed: any = false;
  finished: any = false;
  chunkedEncoding: any = false;
  useChunkedEncodingByDefault: any = true;
  shouldKeepAlive: any = true;
  sendDate: any = false;
  _hasBody: any = true;
  _contentLength: any = null;
  _last: any = false;
  _removedConnection: any = false;
  _removedContLen: any = false;
  _removedTE: any = false;
  _headersArray: any = null;
  _maxRequestsPerSocket: any = 0;
  _uniqueHeaders: any = null;
  strictContentLength: any = false;
  socket: any = null;
  _out: any = null;
  _trailer: any = "";
  _keepAliveTimeout: any = 0;
  _closed: any = false;
  agent: any = undefined;
  _sentBytes: any = 0;
  _destroySocket: any = false;
  _closeEmitted: any = false;
  _destroyErr: any = undefined;
  _pendingSocketDestroy: any = false;

  constructor(options?: any) {
    super({ autoDestroy: false, emitClose: false, decodeStrings: true });
    this._hdrs = {};
    this._out = { queue: [] };
    const self: any = this;
    __sSetOptFn(self, "write", function (chunk: any, enc: any, cb: any): void {
      __httpOutWrite(self, chunk, enc, cb);
    });
    __sSetOptFn(self, "final", function (cb: any): void {
      __httpOutFinal(self, cb);
    });
    __sSetOptFn(self, "destroy", function (err: any, cb: any): void {
      __httpOutDestroy(self, err, cb);
    });
  }

  get connection(): any {
    return this.socket;
  }

  set connection(value: any) {
    this.socket = value;
  }

  // Legacy: Node's OutgoingMessage stays `writable` after `end()` (only a
  // destroy clears it), which error detection in user code relies on.
  get writable(): any {
    return this.destroyed !== true;
  }
  set writable(value: any) {
    const w: any = this._writableState;
    if (w !== null && w !== undefined) w.writable = value === true;
  }

  get headersSent(): any {
    return this._header !== null && this._header !== undefined;
  }

  get _headers(): any {
    return this.getHeaders();
  }

  set _headers(value: any) {
    this._hdrs = {};
    if (value !== null && value !== undefined) {
      const keys: string[] = Object.keys(value);
      for (const key of keys) this.setHeader(key, value[key]);
    }
  }

  get _headerNames(): any {
    const out: any = {};
    const keys: string[] = Object.keys(this._hdrs);
    for (const key of keys) out[key] = this._hdrs[key][0];
    return out;
  }

  // ---- headers ------------------------------------------------------------

  setHeader(name: any, value: any): any {
    if (this._header !== null && this._header !== undefined) throw __httpHeadersSent("set");
    __httpValidateHeaderName(name);
    if (Array.isArray(value)) {
      for (const item of value) __httpValidateHeaderValue(name, item);
    } else {
      __httpValidateHeaderValue(name, value);
    }
    let stored: any = value;
    if (Array.isArray(value)) {
      stored = [];
      for (const item of value) stored.push(item);
    }
    this._hdrs[String(name).toLowerCase()] = [String(name), stored];
    return this;
  }

  setHeaders(headers: any): any {
    if (this._header !== null && this._header !== undefined) throw __httpHeadersSent("set");
    // A built-in method read off a `Map` through `any` answers undefined
    // (zun#17) though calling it works, so a Map is recognised by
    // `instanceof` and walked with `forEach`.
    const isMap: boolean = headers instanceof Map;
    if (
      headers === null ||
      headers === undefined ||
      Array.isArray(headers) ||
      (!isMap && (headers.keys === undefined || headers.get === undefined))
    ) {
      throw new ERR_INVALID_ARG_TYPE("headers", ["Headers", "Map"], headers);
    }
    const pairs: any[] = [];
    headers.forEach(function (value: any, key: any): void {
      pairs.push([key, value]);
    });
    // Node: `set-cookie` values from a Headers object are kept apart.
    const cookies: any[] = [];
    for (const pair of pairs) {
      if (String(pair[0]).toLowerCase() === "set-cookie") {
        if (Array.isArray(pair[1])) {
          for (const c of pair[1]) cookies.push(c);
        } else {
          cookies.push(pair[1]);
        }
      }
      else this.setHeader(pair[0], pair[1]);
    }
    if (Number(cookies.length) > 0) this.setHeader("set-cookie", cookies);
    return this;
  }

  appendHeader(name: any, value: any): any {
    if (this._header !== null && this._header !== undefined) throw __httpHeadersSent("set");
    __httpValidateHeaderName(name);
    if (Array.isArray(value)) {
      for (const item of value) __httpValidateHeaderValue(name, item);
    } else {
      __httpValidateHeaderValue(name, value);
    }
    const key: string = String(name).toLowerCase();
    const entry: any = __httpHdr(this._hdrs, key);
    if (entry === undefined) {
      this._hdrs[key] = [String(name), Array.isArray(value) ? value.slice() : value];
      return this;
    }
    let list: any = entry[1];
    if (!Array.isArray(list)) list = [list];
    if (Array.isArray(value)) {
      for (const item of value) list.push(item);
    } else {
      list.push(value);
    }
    entry[1] = list;
    return this;
  }

  getHeader(name: any): any {
    if (typeof name !== "string") throw new ERR_INVALID_ARG_TYPE("name", "string", name);
    const entry: any = __httpHdr(this._hdrs, name.toLowerCase());
    if (entry === undefined) return undefined;
    return entry[1];
  }

  getHeaders(): any {
    const out: any = Object.create(null);
    const keys: string[] = Object.keys(this._hdrs);
    for (const key of keys) out[key] = this._hdrs[key][1];
    return out;
  }

  getHeaderNames(): any {
    return Object.keys(this._hdrs);
  }

  getRawHeaderNames(): any {
    const out: string[] = [];
    const keys: string[] = Object.keys(this._hdrs);
    for (const key of keys) out.push(this._hdrs[key][0]);
    return out;
  }

  hasHeader(name: any): any {
    if (typeof name !== "string") throw new ERR_INVALID_ARG_TYPE("name", "string", name);
    return __httpHdr(this._hdrs, name.toLowerCase()) !== undefined;
  }

  removeHeader(name: any): any {
    if (typeof name !== "string") throw new ERR_INVALID_ARG_TYPE("name", "string", name);
    if (this._header !== null && this._header !== undefined) throw __httpHeadersSent("remove");
    const key: string = name.toLowerCase();
    switch (key) {
      case "connection":
        this._removedConnection = true;
        break;
      case "content-length":
        this._removedContLen = true;
        break;
      case "transfer-encoding":
        this._removedTE = true;
        break;
      case "date":
        this.sendDate = false;
        break;
    }
    delete this._hdrs[key];
    return undefined;
  }

  addTrailers(headers: any): any {
    let text = "";
    const pairs: any[] = [];
    if (Array.isArray(headers)) {
      for (const pair of headers) pairs.push(pair);
    } else {
      const keys: string[] = Object.keys(headers);
      for (const key of keys) pairs.push([key, headers[key]]);
    }
    for (const pair of pairs) {
      const name: any = pair[0];
      const value: any = pair[1];
      __httpValidateHeaderName(name, "Trailer name");
      __httpValidateHeaderValue(name, value);
      if (Array.isArray(value) && __httpIsUniqueHeader(this, String(name).toLowerCase())) {
        text = text + String(name) + ": " + value.join("; ") + "\r\n";
      } else if (Array.isArray(value)) {
        for (const item of value) text = text + String(name) + ": " + String(item) + "\r\n";
      } else {
        text = text + String(name) + ": " + String(value) + "\r\n";
      }
    }
    this._trailer = String(this._trailer) + text;
    return undefined;
  }

  // ---- body ---------------------------------------------------------------

  write(chunk?: any, encoding?: any, cb?: any): boolean {
    let enc: any = encoding;
    let callback: any = cb;
    if (enc !== undefined && enc !== null && __httpIsFn(enc)) {
      callback = enc;
      enc = undefined;
    }
    if (this.destroyed === true) {
      const gone: any = new ERR_STREAM_DESTROYED("write");
      __httpTick(function (): void {
        __httpInvoke(callback, [gone]);
      });
      return false;
    }
    if (this.finished === true || this._writableState.ending === true) {
      const err: any = new ERR_STREAM_WRITE_AFTER_END();
      const self: any = this;
      __httpTick(function (): void {
        __httpInvoke(callback, [err]);
        if (self._closed !== true) self.emit("error", err);
      });
      return false;
    }
    if (this._header === null || this._header === undefined) {
      this._implicitHeader();
    }
    return __sWriteImpl(this, chunk, enc === undefined ? null : enc, callback) === true;
  }

  end(chunk?: any, encoding?: any, cb?: any): any {
    let data: any = chunk;
    let enc: any = encoding;
    let callback: any = cb;
    if (__httpIsFn(data)) {
      callback = data;
      data = undefined;
      enc = undefined;
    } else if (__httpIsFn(enc)) {
      callback = enc;
      enc = undefined;
    }
    if (this.finished === true || this._writableState.ending === true) {
      if (data !== undefined && data !== null) {
        const err: any = new ERR_STREAM_WRITE_AFTER_END();
        const self: any = this;
        __httpTick(function (): void {
          __httpInvoke(callback, [err]);
          self.emit("error", err);
        });
      } else if (callback !== undefined && callback !== null) {
        if (this._writableState.finished === true) {
          const err2: any = new ERR_STREAM_ALREADY_FINISHED("end");
          __httpTick(function (): void {
            __httpInvoke(callback, [err2]);
          });
        } else {
          this.once("finish", callback);
        }
      }
      return this;
    }
    if (data !== undefined && data !== null) {
      if (typeof data !== "string" && !__httpIsBytes(data)) {
        throw new ERR_INVALID_ARG_TYPE("chunk", ["string", "Buffer", "TypedArray", "DataView"], data);
      }
      if (this._header === null || this._header === undefined) {
        this._contentLength = __httpByteLen(data, enc);
        this._implicitHeader();
      }
    } else if (this._header === null || this._header === undefined) {
      this._contentLength = 0;
      this._implicitHeader();
    }
    this.finished = true;
    __sWritableEnd(this, data, enc, callback);
    return this;
  }

  _implicitHeader(): void {
    throw new __HttpError("ERR_METHOD_NOT_IMPLEMENTED", "The _implicitHeader() method is not implemented");
  }

  flushHeaders(): void {
    if (this._header === null || this._header === undefined) this._implicitHeader();
    __httpFlushHeader(this);
  }

  setTimeout(msecs: any, callback?: any): any {
    if (callback !== undefined && callback !== null) this.on("timeout", callback);
    const sock: any = this.socket;
    if (sock === null || sock === undefined) {
      this.once("socket", function (s: any): void {
        s.setTimeout(msecs);
      });
    } else {
      sock.setTimeout(msecs);
    }
    return this;
  }

  setNoDelay(noDelay?: any): void {}
  setSocketKeepAlive(enable?: any, initialDelay?: any): void {}

  pipe(dest?: any, options?: any): any {
    __sErrorOrDestroy(this, new ERR_STREAM_CANNOT_PIPE());
    return undefined;
  }

  // `OutgoingMessage.prototype.destroy` is not a stream destroy: the error, if
  // any, goes to the socket, which reports it to whoever listens there.
  destroy(err?: any, cb?: any): any {
    return __httpOutgoingDestroy(this, err, cb);
  }

  // Node's low-level `_send`/`_writeRaw`, which a few tests call directly.
  _send(data: any, encoding?: any, callback?: any): any {
    return __httpSendRaw(this, data, encoding, callback);
  }

  _writeRaw(data: any, encoding?: any, callback?: any): any {
    return __httpSendRaw(this, data, encoding, callback);
  }
}

function __httpOutgoingDestroy(self: any, err: any, cb: any): any {
  if (self.destroyed === true) return self;
  self._destroyErr = err;
  const wstate: any = self._writableState;
  if (
    (wstate.buffered !== null && wstate.buffered !== undefined) ||
    (wstate.onfinishCallbacks !== null && wstate.onfinishCallbacks !== undefined)
  ) {
    if (wstate.destroyed !== true) __sTick(__sErrorBuffer, wstate);
  }
  __sDestroy(self, undefined, cb);
  return self;
}

const __HTTP_LINK_RE: RegExp = /^<[^>]*>(?:\s*;\s*[^;"\s]+(?:="[^;"\s]*"|=[^;"\s]*)?)*$/;

// Node's `uniqueHeaders` option (server or request): lowercase names.
function __httpParseUniqueHeaders(list: any): any {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list)) throw new ERR_INVALID_ARG_TYPE("options.uniqueHeaders", "Array", list);
  const out: string[] = [];
  for (const item of list) out.push(String(item).toLowerCase());
  return out;
}

function __httpIsUniqueHeader(self: any, key: string): boolean {
  const list: any = self._uniqueHeaders;
  return Array.isArray(list) && list.indexOf(key) >= 0;
}

// Serialise the header block. `firstLine` includes its trailing CRLF.
function __httpStoreHeader(self: any, firstLine: string): void {
  let header: string = firstLine;
  let contLen = false;
  let te = false;
  let connection = false;
  let date = false;
  let keepAliveHdr = false;
  // A declared `Trailer` needs chunked framing, never Content-Length.
  let trailerHdr = false;
  // A flat `[name, value, ...]` array given as `options.headers` goes out as
  // written, in order (Node's `headersArray`); otherwise the header map.
  const entries: any[] = [];
  const raw: any = self._headersArray;
  if (Array.isArray(raw)) {
    let r = 0;
    while (r + 1 < Number(raw.length)) {
      entries.push([String(raw[r]), String(raw[r]).toLowerCase(), raw[r + 1]]);
      r = r + 2;
    }
  } else {
    const keys: string[] = Object.keys(self._hdrs);
    for (const k of keys) {
      const e: any = __httpHdr(self._hdrs, k);
      entries.push([String(e[0]), k, e[1]]);
    }
  }
  for (const item of entries) {
    const name: string = String(item[0]);
    const key: string = String(item[1]);
    const value: any = item[2];
    if (Array.isArray(value) && __httpIsUniqueHeader(self, key)) {
      // `uniqueHeaders`: one line, values joined by "; ".
      header = header + name + ": " + value.join("; ") + "\r\n";
    } else if (Array.isArray(value)) {
      for (const item of value) header = header + name + ": " + String(item) + "\r\n";
    } else {
      header = header + name + ": " + String(value) + "\r\n";
    }
    if (key === "connection") {
      connection = true;
      const lowered: string = String(value).toLowerCase();
      if (__httpTokenIn(lowered, "close")) self._last = true;
      else self.shouldKeepAlive = true;
    } else if (key === "transfer-encoding") {
      te = true;
      if (String(value).toLowerCase().indexOf("chunked") >= 0) self.chunkedEncoding = true;
    } else if (key === "content-length") {
      contLen = true;
      self._contentLength = Number(value);
    } else if (key === "date") {
      date = true;
    } else if (key === "keep-alive") {
      // A caller-set `Keep-Alive` replaces the default one.
      keepAliveHdr = true;
    } else if (key === "trailer") {
      trailerHdr = true;
    }
  }
  // Node's `writeHead`: a 204/304 must not be chunked, so the connection
  // closes instead of keeping a framing the peer will not read.
  const status: number = Number(self.statusCode);
  if (self.chunkedEncoding === true && (status === 204 || status === 304)) {
    self.chunkedEncoding = false;
    self.shouldKeepAlive = false;
  }
  if (self.sendDate === true && !date) {
    header = header + "Date: " + new Date().toUTCString() + "\r\n";
  }
  if (self._removedConnection === true) {
    // The header is not sent, but an HTTP/1.1 connection still persists.
    self._last = self.shouldKeepAlive !== true;
  } else if (!connection) {
    const sendKeep: boolean =
      self.shouldKeepAlive === true &&
      (contLen || self.useChunkedEncodingByDefault === true || (self.agent !== undefined && self.agent !== null));
    if (sendKeep) {
      header = header + "Connection: keep-alive\r\n";
      if (Number(self._keepAliveTimeout) > 0 && !keepAliveHdr) {
        let max = "";
        if (Number(self._maxRequestsPerSocket) > 0) max = ", max=" + String(self._maxRequestsPerSocket);
        header = header + "Keep-Alive: timeout=" + String(Math.floor(Number(self._keepAliveTimeout) / 1000)) + max + "\r\n";
      }
    } else {
      self._last = true;
      header = header + "Connection: close\r\n";
    }
  }
  if (!contLen && !te) {
    if (self._hasBody !== true) {
      self._last = true;
    } else if (!trailerHdr && self._removedContLen !== true && typeof self._contentLength === "number") {
      header = header + "Content-Length: " + String(self._contentLength) + "\r\n";
    } else if (self._removedTE !== true && self.useChunkedEncodingByDefault === true) {
      header = header + "Transfer-Encoding: chunked\r\n";
      self.chunkedEncoding = true;
    } else {
      self._last = true;
    }
  }
  self._header = header + "\r\n";
}

// Hand bytes to the connection, or queue them until there is one.
function __httpSendRaw(self: any, data: any, encoding: any, callback: any): any {
  let enc: any = encoding;
  let cb: any = callback;
  if (__httpIsFn(enc)) {
    cb = enc;
    enc = undefined;
  }
  const out: any = self._out;
  const sock: any = self.socket;
  if (sock === null || sock === undefined) {
    out.queue.push({ data: data, enc: enc, cb: cb });
    return false;
  }
  if (sock.destroyed === true) {
    if (cb !== undefined && cb !== null) {
      __httpTick(function (): void {
        __httpInvoke(cb, [new ERR_STREAM_DESTROYED("write")]);
      });
    }
    return false;
  }
  if (cb !== undefined && cb !== null) return sock.write(data, enc, cb);
  return sock.write(data, enc);
}

function __httpFlushQueue(self: any): void {
  const out: any = self._out;
  const sock: any = self.socket;
  if (sock === null || sock === undefined) return;
  const list: any = out.queue;
  out.queue = [];
  for (const item of list) {
    __httpSendRaw(self, item.data, item.enc, item.cb);
  }
}

// Write the stored header block now, if it has not gone out yet.
function __httpFlushHeader(self: any): void {
  if (self._headerFlushed === true) return;
  if (self._header === null || self._header === undefined) return;
  self._headerFlushed = true;
  __httpSendRaw(self, String(self._header), "latin1", undefined);
}

// The Writable `_write`: frame the chunk and send it, with the header block in
// front of the first one.
function __httpOutWrite(self: any, chunk: any, enc: any, cb: any): void {
  if (self._header === null || self._header === undefined) self._implicitHeader();
  const view: Buffer = __httpToBuffer(chunk, enc);
  const len: number = Number(view.length);
  if (self._hasBody !== true || len === 0) {
    __httpFlushHeader(self);
    __httpInvoke(cb, [null]);
    return;
  }
  self._sentBytes = Number(self._sentBytes) + len;
  let head = "";
  if (self._headerFlushed !== true) {
    self._headerFlushed = true;
    head = String(self._header);
  }
  const done: any = function (err: any): void {
    __httpInvoke(cb, [err]);
  };
  if (self.chunkedEncoding === true) {
    const framed: string = head + len.toString(16) + "\r\n";
    const parts: Buffer[] = [Buffer.from(framed, "latin1"), view, Buffer.from("\r\n", "latin1")];
    __httpSendRaw(self, Buffer.concat(parts), undefined, done);
    return;
  }
  if (head !== "") {
    const parts2: Buffer[] = [Buffer.from(head, "latin1"), view];
    __httpSendRaw(self, Buffer.concat(parts2), undefined, done);
    return;
  }
  __httpSendRaw(self, view, undefined, done);
}

// The Writable `_final`: the terminating chunk, or just the header block when
// there was no body.
function __httpOutFinal(self: any, cb: any): void {
  if (self._header === null || self._header === undefined) self._implicitHeader();
  let tail = "";
  if (self._headerFlushed !== true) {
    self._headerFlushed = true;
    tail = String(self._header);
  }
  if (self.chunkedEncoding === true && self._hasBody === true) {
    tail = tail + "0\r\n" + String(self._trailer) + "\r\n";
  }
  if (tail === "") {
    __httpInvoke(cb, [null]);
    return;
  }
  __httpSendRaw(self, tail, "latin1", function (err: any): void {
    __httpInvoke(cb, [err]);
  });
}

function __httpOutDestroy(self: any, err: any, cb: any): void {
  self._closed = true;
  const sock: any = self.socket;
  if (sock !== null && sock !== undefined && sock.destroyed !== true) {
    sock.destroy(self._destroyErr);
  }
  __httpInvoke(cb, [err]);
}

// ---------------------------------------------------------------------------
// ServerResponse (`lib/_http_server.js`)
// ---------------------------------------------------------------------------

class ServerResponse extends OutgoingMessage {
  statusCode: any = 200;
  statusMessage: any = undefined;
  req: any = null;
  _sent100: any = false;
  _expect_continue: any = false;
  _conn: any = null;

  constructor(req?: any, options?: any) {
    super();
    this.req = req === undefined ? null : req;
    this.sendDate = true;
    if (req !== undefined && req !== null) {
      if (req.method === "HEAD") this._hasBody = false;
      if (Number(req.httpVersionMajor) < 1 || Number(req.httpVersionMinor) < 1) {
        const te: any = req.headers !== undefined ? req.headers["te"] : undefined;
        this.useChunkedEncodingByDefault =
          te !== undefined && String(te).toLowerCase().indexOf("chunked") >= 0;
        this.shouldKeepAlive = false;
      }
    }
    if (options !== undefined && options !== null && options.rejectNonStandardBodyWrites === true) {
      this._rejectBody = true;
    }
  }

  _rejectBody: any = false;

  get writableFinished(): any {
    return this._writableState.finished === true;
  }

  _implicitHeader(): void {
    this.writeHead(this.statusCode);
  }

  writeHead(statusCode: any, reason?: any, obj?: any): any {
    if (this._header !== null && this._header !== undefined) throw __httpHeadersSent("write");
    const original: any = statusCode;
    const code: number = Number(statusCode) | 0;
    if (code < 100 || code > 999) {
      throw new __HttpRangeError("ERR_HTTP_INVALID_STATUS_CODE", "Invalid status code: " + __httpShow(original));
    }
    let headers: any = obj;
    if (typeof reason === "string") {
      this.statusMessage = reason;
    } else {
      if (this.statusMessage === undefined || this.statusMessage === null || this.statusMessage === "") {
        const known: any = __HTTP_STATUS_CODES[String(code)];
        this.statusMessage = known === undefined ? "unknown" : known;
      }
      if (headers === undefined || headers === null) headers = reason;
    }
    this.statusCode = code;
    const message: string = String(this.statusMessage);
    if (__httpInvalidHeaderChar(message) || message.indexOf("\r") >= 0 || message.indexOf("\n") >= 0) {
      throw new __HttpTypeError("ERR_INVALID_CHAR", "Invalid character in statusMessage");
    }
    if (headers !== undefined && headers !== null) {
      if (Array.isArray(headers)) {
        if (Number(headers.length) % 2 !== 0 && !Array.isArray(headers[0])) {
          throw new ERR_INVALID_ARG_VALUE("headers", headers, "is invalid");
        }
        if (Array.isArray(headers[0])) {
          for (const pair of headers) this.appendHeader(pair[0], pair[1]);
        } else {
          // Node: these override earlier headers yet keep their own
          // duplicates -- drop the conflicts first, then append.
          let i = 0;
          while (i + 1 < Number(headers.length)) {
            if (headers[i]) this.removeHeader(headers[i]);
            i = i + 2;
          }
          i = 0;
          while (i + 1 < Number(headers.length)) {
            this.appendHeader(headers[i], headers[i + 1]);
            i = i + 2;
          }
        }
      } else {
        const keys: string[] = Object.keys(headers);
        for (const key of keys) this.setHeader(key, headers[key]);
      }
    }
    if (code === 204 || code === 304 || (code >= 100 && code <= 199)) {
      this._hasBody = false;
    }
    __httpStoreHeader(this, "HTTP/1.1 " + String(code) + " " + message + "\r\n");
    return this;
  }

  writeContinue(callback?: any): void {
    __httpSendRaw(this, "HTTP/1.1 100 Continue\r\n\r\n", "latin1", callback);
    this._sent100 = true;
  }

  writeProcessing(callback?: any): void {
    __httpSendRaw(this, "HTTP/1.1 102 Processing\r\n\r\n", "latin1", callback);
  }

  writeEarlyHints(hints: any, callback?: any): void {
    let cb: any = callback;
    if (hints === null || typeof hints !== "object") {
      throw new ERR_INVALID_ARG_TYPE("hints", "object", hints);
    }
    if (__httpIsFn(hints)) throw new ERR_INVALID_ARG_TYPE("hints", "object", hints);
    let text = "HTTP/1.1 103 Early Hints\r\n";
    const link: any = hints["link"];
    if (link !== undefined && link !== null) {
      const links: any[] = Array.isArray(link) ? link : [link];
      let joined = "";
      for (const item of links) {
        const piece: string = String(item);
        // Node's `validateLinkHeaderFormat`: `<uri>` then `; param[=value]`s.
        if (typeof item !== "string" || !__HTTP_LINK_RE.test(piece) || __httpInvalidHeaderChar(piece)) {
          throw new __HttpTypeError("ERR_INVALID_ARG_VALUE", "The argument 'hints.link' is invalid. Received " + __evInspect(link));
        }
        joined = joined === "" ? piece : joined + ", " + piece;
      }
      text = text + "Link: " + joined + "\r\n";
    }
    const keys: string[] = Object.keys(hints);
    for (const key of keys) {
      if (key === "link") continue;
      __httpValidateHeaderName(key);
      __httpValidateHeaderValue(key, hints[key]);
      text = text + key + ": " + String(hints[key]) + "\r\n";
    }
    text = text + "\r\n";
    __httpSendRaw(this, text, "latin1", cb);
  }

  assignSocket(socket: any): void {
    if (this.socket !== null && this.socket !== undefined) {
      throw new NodeError("ERR_HTTP_SOCKET_ASSIGNED", "Response has already been assigned to a socket");
    }
    this.socket = socket;
    this._flushQueueNow();
    this.emit("socket", socket);
  }

  detachSocket(socket: any): void {
    this.socket = null;
  }

  _flushQueueNow(): void {
    __httpFlushQueue(this);
  }

  get writableCorked(): any {
    return Number(this._writableState.corked);
  }
}

// ---------------------------------------------------------------------------
// Server (`lib/_http_server.js`)
// ---------------------------------------------------------------------------
//
// `net.Server` underneath, with `allowHalfOpen: true` (a client may half-close
// after its request and still wait for the answer). Every accepted socket gets
// a parser and a `conn` record; the record is the one place that knows which
// response is writing and which are queued behind it (pipelining).

class __HttpServer extends Server {
  timeout: any = 0;
  keepAliveTimeout: any = 5000;
  keepAliveTimeoutBuffer: any = 1000;
  maxHeadersCount: any = null;
  headersTimeout: any = 60000;
  requestTimeout: any = 300000;
  connectionsCheckingInterval: any = 30000;
  maxRequestsPerSocket: any = 0;
  requireHostHeader: any = true;
  httpAllowHalfOpen: any = false;
  _httpState: any = null;

  constructor(options?: any, requestListener?: any) {
    let opts: any = options;
    let listener: any = requestListener;
    if (__httpIsFn(opts)) {
      listener = opts;
      opts = {};
    } else if (opts === undefined || opts === null) {
      opts = {};
    } else if (!__httpIsObj(opts)) {
      throw new ERR_INVALID_ARG_TYPE("options", "object", options);
    }
    super({
      allowHalfOpen: true,
      noDelay: opts.noDelay === undefined ? true : opts.noDelay === true,
      keepAlive: opts.keepAlive === true,
      keepAliveInitialDelay: opts.keepAliveInitialDelay,
      highWaterMark: opts.highWaterMark,
      pauseOnConnect: opts.pauseOnConnect === true,
    });
    this._httpState = {
      conns: [],
      checkTimer: null,
      uniqueHeaders: __httpParseUniqueHeaders(opts.uniqueHeaders),
      joinDuplicateHeaders: opts.joinDuplicateHeaders === true,
      maxHeaderSize: opts.maxHeaderSize === undefined ? __HTTP_MAX_HEADER_SIZE : Number(opts.maxHeaderSize),
      incoming: opts.IncomingMessage !== undefined ? opts.IncomingMessage : null,
      response: opts.ServerResponse !== undefined ? opts.ServerResponse : null,
    };
    if (opts.keepAliveTimeout !== undefined) this.keepAliveTimeout = opts.keepAliveTimeout;
    // Node: `requestTimeout` defaults to five minutes, `headersTimeout` to the
    // smaller of one minute and `requestTimeout`, and must not exceed it.
    if (opts.requestTimeout !== undefined) this.requestTimeout = opts.requestTimeout;
    if (opts.headersTimeout !== undefined) this.headersTimeout = opts.headersTimeout;
    else this.headersTimeout = Math.min(60000, Number(this.requestTimeout));
    if (Number(this.requestTimeout) > 0 && Number(this.headersTimeout) > 0 && Number(this.headersTimeout) > Number(this.requestTimeout)) {
      throw new ERR_OUT_OF_RANGE("headersTimeout", "<= requestTimeout", this.headersTimeout);
    }
    if (opts.connectionsCheckingInterval !== undefined) this.connectionsCheckingInterval = opts.connectionsCheckingInterval;
    if (opts.requireHostHeader !== undefined) this.requireHostHeader = opts.requireHostHeader;
    if (opts.connectionsCheckingInterval !== undefined) this.connectionsCheckingInterval = opts.connectionsCheckingInterval;
    if (opts.joinDuplicateHeaders !== undefined && typeof opts.joinDuplicateHeaders !== "boolean") {
      throw new ERR_INVALID_ARG_TYPE("options.joinDuplicateHeaders", "boolean", opts.joinDuplicateHeaders);
    }
    const self: any = this;
    this.on("connection", function (socket: any): void {
      __httpServerAttach(self, socket);
    });
    if (listener !== undefined && listener !== null) this.on("request", listener);
    // The connection-checking sweep that enforces `headersTimeout` and
    // `requestTimeout` (Node's `setupConnectionsTracking`).
    this.on("listening", function (): void {
      __httpServerStartChecking(self);
    });
    this.on("close", function (): void {
      __httpServerStopChecking(self);
    });
  }

  setTimeout(msecs?: any, callback?: any): any {
    this.timeout = msecs === undefined ? 0 : msecs;
    if (callback !== undefined && callback !== null) this.on("timeout", callback);
    return this;
  }

  closeIdleConnections(): void {
    const conns: any = this._httpState.conns;
    for (const conn of conns.slice()) {
      // Idle as Node's connection list means it: no message being received
      // (a fresh connection counts as receiving one) and no response pending.
      if (conn.current === null && Number(conn.waiting.length) === 0 && conn.req === null && conn.msgStart === 0) {
        conn.socket.destroy();
      }
    }
  }

  closeAllConnections(): void {
    const conns: any = this._httpState.conns;
    for (const conn of conns.slice()) conn.socket.destroy();
  }

  close(callback?: any): any {
    __httpServerStopChecking(this);
    const result: any = super.close(callback);
    this.closeIdleConnections();
    return result;
  }
}

// Attach the parser and the socket listeners to a freshly accepted socket.
function __httpServerAttach(server: any, socket: any): void {
  const conn: any = {
    server: server,
    socket: socket,
    parser: null,
    req: null,
    current: null,
    waiting: [],
    closed: false,
    upgradeReq: null,
    requests: 0,
    ended: false,
    // When the message being received began (0: none in progress) and whether
    // its header block is complete; read by the connection-checking sweep.
    msgStart: Date.now(),
    headersDone: false,
  };
  server._httpState.conns.push(conn);
  const handler: any = {
    headers(info: any): any {
      return __httpServerOnHeaders(conn, info);
    },
    body(chunk: any): void {
      __httpServerOnBody(conn, chunk);
    },
    complete(trailers: any): void {
      __httpServerOnComplete(conn, trailers);
    },
    upgrade(info: any, rest: string): void {
      __httpServerOnUpgrade(conn, info, rest);
    },
    error(err: any): void {
      __httpServerOnParseError(conn, err);
    },
    truncated(): void {
      __httpServerAbortIncoming(conn);
    },
  };
  conn.parser = __httpNewParser(0, handler);
  conn.parser.maxHeaderSize = Number(server._httpState.maxHeaderSize);
  socket.parser = conn.parser;
  // Node's `socketSetEncoding`: the byte stream is HTTP's.
  socket.setEncoding = function (enc?: any): any {
    throw new NodeError("ERR_HTTP_SOCKET_ENCODING", "Changing the socket encoding is not allowed per RFC7230 Section 3.");
  };

  socket.on("data", function (chunk: any): void {
    if (conn.closed === true) return;
    if (conn.msgStart === 0) {
      conn.msgStart = Date.now();
      conn.headersDone = false;
    }
    __httpParse(conn.parser, __httpLatin1(chunk));
    // A pipelined message that began in the same chunk as the end of the
    // previous one is in progress too.
    if (conn.msgStart === 0 && Number(conn.parser.buf.length) > 0) {
      conn.msgStart = Date.now();
      conn.headersDone = false;
    }
  });
  socket.on("end", function (): void {
    __httpServerOnSocketEnd(conn);
  });
  socket.on("close", function (): void {
    __httpServerOnSocketClose(conn);
  });
  socket.on("error", function (err: any): void {
    __httpServerOnSocketError(conn, err);
  });
  socket.on("timeout", function (): void {
    __httpServerOnSocketTimeout(conn);
  });
  const timeout: number = Number(server.timeout);
  if (timeout > 0) socket.setTimeout(timeout);
  else if (Number(server.keepAliveTimeout) > 0) socket.setTimeout(Number(server.keepAliveTimeout));
}

// `require('_http_server').kConnectionsCheckingInterval`: the key the sweep's
// interval is stored under on the server.
const __httpKConnectionsCheckingInterval: any = Symbol("http.server.connectionsCheckingInterval");

function __httpServerStartChecking(server: any): void {
  __httpServerStopChecking(server);
  const every: number = Number(server.connectionsCheckingInterval);
  if (!(every > 0)) return;
  const timer: any = setInterval(function (): void {
    __httpServerCheckConnections(server);
  }, every);
  if (timer !== null && timer !== undefined && typeof timer.unref === "function") timer.unref();
  server._httpState.checkTimer = timer;
  server[__httpKConnectionsCheckingInterval] = timer;
}

function __httpServerStopChecking(server: any): void {
  const timer: any = server._httpState.checkTimer;
  if (timer !== undefined && timer !== null) {
    clearInterval(timer);
    server._httpState.checkTimer = null;
  }
}

// Node's `checkConnections`: a connection whose header block (or whole request)
// is still arriving past `headersTimeout` (or `requestTimeout`) gets a `408`.
function __httpServerCheckConnections(server: any): void {
  const headersTimeout: number = Number(server.headersTimeout);
  const requestTimeout: number = Number(server.requestTimeout);
  if (headersTimeout === 0 && requestTimeout === 0) return;
  const now: number = Date.now();
  const conns: any = server._httpState.conns;
  for (const conn of conns.slice()) {
    const start: number = Number(conn.msgStart);
    if (start === 0 || conn.closed === true) continue;
    const elapsed: number = now - start;
    const headersLate: boolean = conn.headersDone !== true && headersTimeout > 0 && elapsed > headersTimeout;
    const requestLate: boolean = requestTimeout > 0 && elapsed > requestTimeout;
    if (!headersLate && !requestLate) continue;
    conn.msgStart = 0;
    conn.socket.setTimeout(0);
    __httpServerOnRequestTimeout(conn);
  }
}

// Node's guard before answering a client error: no response in flight, or none
// of its bytes written yet (so the reply cannot corrupt the stream).
function __httpServerNoInflightHeader(conn: any): boolean {
  const cur: any = conn.current;
  return cur === null || cur === undefined || cur.headersSent !== true;
}

class __HttpRequestTimeout extends NodeError {
  constructor() {
    super("ERR_HTTP_REQUEST_TIMEOUT", "Request timeout");
  }
}

function __httpServerOnRequestTimeout(conn: any): void {
  const server: any = conn.server;
  const socket: any = conn.socket;
  const err: any = new __HttpRequestTimeout();
  if (server.emit("clientError", err, socket) === true) return;
  if (socket.writable === true && __httpServerNoInflightHeader(conn)) {
    socket.write("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n", "latin1");
  }
  socket.destroy(err);
}

function __httpServerOnSocketTimeout(conn: any): void {
  const socket: any = conn.socket;
  const req: any = conn.req;
  const server: any = conn.server;
  const reqTimeout: boolean = req !== null && req.complete !== true && req.emit("timeout", socket) === true;
  const cur: any = conn.current;
  const resTimeout: boolean = cur !== null && cur.emit("timeout", socket) === true;
  const serverTimeout: boolean = server.emit("timeout", socket) === true;
  if (!reqTimeout && !resTimeout && !serverTimeout) socket.destroy();
}

function __httpServerOnSocketError(conn: any, err: any): void {
  const server: any = conn.server;
  const socket: any = conn.socket;
  if (server.emit("clientError", err, socket) !== true) {
    socket.destroy(err);
  }
}

function __httpServerOnParseError(conn: any, err: any): void {
  const server: any = conn.server;
  const socket: any = conn.socket;
  if (err.rawPacket === undefined || err.rawPacket === null) err.rawPacket = Buffer.alloc(0);
  if (server.emit("clientError", err, socket) === true) return;
  if (socket.writable === true && __httpServerNoInflightHeader(conn)) {
    let status = "400 Bad Request";
    if (err.code === "HPE_HEADER_OVERFLOW") status = "431 Request Header Fields Too Large";
    else if (err.code === "HPE_CHUNK_EXTENSIONS_OVERFLOW") status = "413 Payload Too Large";
    socket.write("HTTP/1.1 " + status + "\r\nConnection: close\r\n\r\n", "latin1");
  }
  socket.destroy(err);
}

function __httpServerAbortIncoming(conn: any): void {
  const req: any = conn.req;
  if (req === null || req === undefined) return;
  conn.req = null;
  if (req.complete !== true && req.destroyed !== true) {
    req.destroy(new __HttpConnReset("aborted"));
  }
}

class __HttpConnReset extends NodeError {
  errno: any = "ECONNRESET";
  syscall: any = undefined;
  constructor(message: string) {
    super("ECONNRESET", message);
  }
}

function __httpServerOnSocketEnd(conn: any): void {
  const socket: any = conn.socket;
  __httpParserEof(conn.parser);
  conn.ended = true;
  if (conn.server.httpAllowHalfOpen !== true) {
    __httpServerAbortIncoming(conn);
    if (conn.current !== null || Number(conn.waiting.length) > 0) {
      // Let the responses in flight finish, then close.
      const last: any = Number(conn.waiting.length) > 0 ? conn.waiting[Number(conn.waiting.length) - 1] : conn.current;
      last._last = true;
    } else if (socket.writable === true) {
      socket.end();
    }
  } else if (conn.current !== null || Number(conn.waiting.length) > 0) {
    const last2: any = Number(conn.waiting.length) > 0 ? conn.waiting[Number(conn.waiting.length) - 1] : conn.current;
    last2._last = true;
  } else if (socket.writable === true) {
    socket.end();
  }
}

function __httpServerOnSocketClose(conn: any): void {
  conn.closed = true;
  const conns: any = conn.server._httpState.conns;
  const at: number = Number(conns.indexOf(conn));
  if (at >= 0) conns.splice(at, 1);
  __httpServerAbortIncoming(conn);
  const cur: any = conn.current;
  conn.current = null;
  if (cur !== null) {
    cur._closed = true;
    if (cur._closeEmitted !== true) {
      cur._closeEmitted = true;
      cur.emit("close");
    }
  }
  const waiting: any = conn.waiting;
  conn.waiting = [];
  for (const res of waiting) {
    res._closed = true;
    if (res._closeEmitted !== true) {
      res._closeEmitted = true;
      res.emit("close");
    }
  }
}

function __httpServerOnUpgrade(conn: any, info: any, rest: string): void {
  const server: any = conn.server;
  const socket: any = conn.socket;
  const req: any = conn.upgradeReq;
  conn.upgradeReq = null;
  conn.msgStart = 0;
  conn.req = null;
  const head: Buffer = __httpFromLatin1(rest);
  const event: string = info.method === "CONNECT" ? "connect" : "upgrade";
  // The socket is the application's now.
  socket.removeAllListeners("data");
  socket.removeAllListeners("end");
  socket.removeAllListeners("timeout");
  socket.setTimeout(0);
  req.upgrade = true;
  req.complete = true;
  const conns: any = server._httpState.conns;
  const at: number = Number(conns.indexOf(conn));
  if (at >= 0) conns.splice(at, 1);
  server.emit(event, req, socket, head);
}

function __httpServerOnHeaders(conn: any, info: any): any {
  const server: any = conn.server;
  const socket: any = conn.socket;
  conn.headersDone = true;
  const req: any = new IncomingMessage(socket);
  req.httpVersionMajor = info.versionMajor;
  req.httpVersionMinor = info.versionMinor;
  req.httpVersion = String(info.versionMajor) + "." + String(info.versionMinor);
  req.url = info.url;
  req.method = info.method;
  req.rawHeaders = __httpLimitHeaders(info.headers, server.maxHeadersCount);
  req.joinDuplicateHeaders = server._httpState.joinDuplicateHeaders;
  req.upgrade = false;
  conn.requests = Number(conn.requests) + 1;

  if (info.upgrade === true) {
    const evName: string = info.method === "CONNECT" ? "connect" : "upgrade";
    if (Number(server.listenerCount(evName)) > 0) {
      conn.upgradeReq = req;
      return 2;
    }
    if (info.method === "CONNECT") {
      // Nobody handles CONNECT: close the connection.
      socket.destroy();
      return 2 + 0 * 1;
    }
    info.upgrade = false;
  }

  conn.req = req;
  conn.parser.incoming = req;
  socket.setTimeout(Number(server.timeout));

  const res: any = new ServerResponse(req);
  res._conn = conn;
  res.shouldKeepAlive = info.shouldKeepAlive;
  if (Number(server.keepAliveTimeout) > 0) res._keepAliveTimeout = Number(server.keepAliveTimeout);
  if (Number(server.maxRequestsPerSocket) > 0) res._maxRequestsPerSocket = Number(server.maxRequestsPerSocket);
  res._uniqueHeaders = server._httpState.uniqueHeaders;
  if (res.shouldKeepAlive === true && Number(server.maxRequestsPerSocket) > 0 && Number(conn.requests) >= Number(server.maxRequestsPerSocket)) {
    res.shouldKeepAlive = false;
    res._last = true;
  }
  if (Number(info.versionMajor) < 1 || Number(info.versionMinor) < 1) res.shouldKeepAlive = info.shouldKeepAlive;
  res.on("finish", function (): void {
    __httpServerResFinish(conn, res);
  });
  if (conn.current === null) {
    __httpServerAssign(conn, res);
  } else {
    conn.waiting.push(res);
  }
  req.res = res;

  // 100-continue and the `Expect` header.
  const expect: any = req.headers["expect"];
  if (expect !== undefined && Number(info.versionMajor) === 1 && Number(info.versionMinor) >= 1) {
    if (String(expect).toLowerCase() === "100-continue") {
      if (Number(server.listenerCount("checkContinue")) > 0) {
        res._expect_continue = true;
        server.emit("checkContinue", req, res);
      } else {
        res.writeContinue();
        server.emit("request", req, res);
      }
    } else if (Number(server.listenerCount("checkExpectation")) > 0) {
      res._expect_continue = true;
      server.emit("checkExpectation", req, res);
    } else {
      res.writeHead(417);
      res.end();
    }
    return 0;
  }

  if (Number(server.listenerCount("request")) === 0) {
    // Node emits regardless; with no listener the request is simply dumped.
    server.emit("request", req, res);
    req._dump();
  } else {
    server.emit("request", req, res);
  }
  return 0;
}

function __httpServerAssign(conn: any, res: any): void {
  conn.current = res;
  res.assignSocket(conn.socket);
  const server: any = conn.server;
  conn.socket.setTimeout(Number(server.timeout));
}

function __httpServerOnBody(conn: any, chunk: any): void {
  const req: any = conn.req;
  if (req === null || req === undefined) return;
  if (req.destroyed === true) return;
  const ok: boolean = req.push(chunk);
  if (!ok) {
    req._in.paused = true;
    conn.socket.pause();
  }
}

function __httpServerOnComplete(conn: any, trailers: any): void {
  const req: any = conn.req;
  conn.req = null;
  conn.msgStart = 0;
  conn.headersDone = false;
  if (req === null || req === undefined) return;
  req.rawTrailers = trailers;
  req.complete = true;
  req.push(null);
}

// A response is fully written: decide between closing, serving the next queued
// response and waiting idle for the next request.
function __httpServerResFinish(conn: any, res: any): void {
  const socket: any = conn.socket;
  const req: any = res.req;
  if (req !== null && req !== undefined && req.complete !== true) {
    // The client has not finished sending: discard the rest of the body.
    req._dump();
  }
  res.detachSocket(socket);
  if (conn.current === res) conn.current = null;
  // Node's `clearIncoming`.
  const parser: any = conn.parser;
  if (req !== null && req !== undefined && parser.incoming === req) {
    if (req.readableEnded === true) {
      parser.incoming = null;
    } else {
      req.once("end", function (): void {
        if (parser.incoming === req) parser.incoming = null;
      });
    }
  }
  __httpTick(function (): void {
    if (res._closeEmitted !== true) {
      res._closeEmitted = true;
      res._closed = true;
      res.emit("close");
    }
  });
  if (conn.closed === true) return;
  if (res._last === true || res.shouldKeepAlive !== true) {
    // `destroySoon`: end the writable side, destroy once it is flushed.
    socket.destroySoon();
    return;
  }
  if (Number(conn.waiting.length) > 0) {
    const next: any = conn.waiting.shift();
    __httpServerAssign(conn, next);
    return;
  }
  if (conn.ended === true) {
    socket.destroySoon();
    return;
  }
  // Idle: the keep-alive timeout replaces the request timeout.
  const keep: number = Number(conn.server.keepAliveTimeout);
  if (keep > 0) socket.setTimeout(keep);
  else socket.setTimeout(0);
  if (socket.isPaused !== undefined && socket.isPaused() === true && req !== null && req.complete === true) {
    socket.resume();
  }
}

// ---------------------------------------------------------------------------
// Agent (`lib/_http_agent.js`)
// ---------------------------------------------------------------------------
//
// The socket pool. `sockets[name]` are the sockets with a request on them,
// `freeSockets[name]` the idle keep-alive ones, `requests[name]` the requests
// waiting for a slot; `name` is `host:port:localAddress[:family]`.

function __httpMerge(a: any, b: any): any {
  const out: any = {};
  if (a !== undefined && a !== null) {
    const ka: string[] = Object.keys(a);
    for (const key of ka) out[key] = a[key];
  }
  if (b !== undefined && b !== null) {
    const kb: string[] = Object.keys(b);
    for (const key of kb) out[key] = b[key];
  }
  return out;
}

class Agent extends EventEmitter {
  defaultPort: any = 80;
  protocol: any = "http:";
  options: any = null;
  requests: any = null;
  sockets: any = null;
  freeSockets: any = null;
  keepAliveMsecs: any = 1000;
  keepAlive: any = false;
  maxSockets: any = Infinity;
  maxFreeSockets: any = 256;
  maxTotalSockets: any = Infinity;
  totalSocketCount: any = 0;
  scheduling: any = "lifo";

  constructor(options?: any) {
    super();
    const opts: any = __httpMerge(options, null);
    if (opts.noDelay === undefined) opts.noDelay = true;
    opts.path = null;
    this.options = opts;
    this.requests = {};
    this.sockets = {};
    this.freeSockets = {};
    this.keepAliveMsecs = opts.keepAliveMsecs === undefined ? 1000 : opts.keepAliveMsecs;
    this.keepAlive = opts.keepAlive === true;
    this.maxSockets = opts.maxSockets === undefined ? Infinity : opts.maxSockets;
    this.maxFreeSockets = opts.maxFreeSockets === undefined ? 256 : opts.maxFreeSockets;
    this.maxTotalSockets = opts.maxTotalSockets === undefined ? Infinity : opts.maxTotalSockets;
    if (opts.scheduling !== undefined) {
      if (opts.scheduling !== "fifo" && opts.scheduling !== "lifo") {
        throw new ERR_INVALID_ARG_VALUE("scheduling", opts.scheduling, "must be one of: 'fifo', 'lifo'");
      }
      this.scheduling = opts.scheduling;
    }
    if (opts.maxTotalSockets !== undefined) {
      __httpValidateAgentNumber(opts.maxTotalSockets, "maxTotalSockets");
    }
    __httpValidateAgentNumber(this.maxSockets, "maxSockets");
    __httpValidateAgentNumber(this.maxFreeSockets, "maxFreeSockets");
    const self: any = this;
    this.on("free", function (socket: any, opt: any): void {
      __httpAgentOnFree(self, socket, opt);
    });
  }

  createConnection(options?: any, callback?: any): any {
    return __netConnect(options, undefined, undefined, undefined);
  }

  getName(options?: any): any {
    const o: any = options === undefined || options === null ? {} : options;
    let name: string = o.host !== undefined && o.host !== null && o.host !== "" ? String(o.host) : "localhost";
    name = name + ":";
    if (o.port) name = name + String(o.port);
    name = name + ":";
    if (o.localAddress) name = name + String(o.localAddress);
    if (o.family === 4 || o.family === 6) name = name + ":" + String(o.family);
    if (o.socketPath) name = name + ":" + String(o.socketPath);
    return name;
  }

  addRequest(req: any, options?: any, port?: any, localAddress?: any): void {
    __httpAgentAddRequest(this, req, options, port, localAddress);
  }

  createSocket(req: any, options: any, cb: any): void {
    __httpAgentCreateSocket(this, req, options, cb);
  }

  keepSocketAlive(socket: any): any {
    socket.setKeepAlive(true, this.keepAliveMsecs);
    socket.unref();
    const agentTimeout: any = this.options.timeout === undefined ? 0 : this.options.timeout;
    if (socket.timeout !== agentTimeout && !(socket.timeout === undefined && Number(agentTimeout) === 0)) {
      socket.setTimeout(agentTimeout);
    }
    return true;
  }

  reuseSocket(socket: any, req: any): void {
    req.reusedSocket = true;
    socket.ref();
  }

  removeSocket(s: any, options?: any): void {
    __httpAgentRemoveSocket(this, s, options);
  }

  destroy(): void {
    const groups: any[] = [this.sockets, this.freeSockets];
    for (const group of groups) {
      const names: string[] = Object.keys(group);
      for (const name of names) {
        const list: any = group[name].slice();
        for (const sock of list) sock.destroy();
      }
    }
  }
}

function __httpValidateAgentNumber(value: any, name: string): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  if (Number.isNaN(value) || value <= 0) {
    throw new ERR_OUT_OF_RANGE(name, "> 0", value);
  }
}

function __httpSetRequestSocket(agent: any, req: any, socket: any): void {
  req.onSocket(socket);
  const agentTimeout: any = agent.options.timeout === undefined ? 0 : agent.options.timeout;
  if (req.timeout === undefined || req.timeout === agentTimeout) return;
  socket.setTimeout(req.timeout);
}

function __httpAgentAddRequest(agent: any, req: any, opts: any, port: any, localAddress: any): void {
  let options: any = opts;
  if (typeof options === "string") {
    options = { host: options, port: port, localAddress: localAddress };
  }
  options = __httpMerge(options, agent.options);
  if (options.socketPath) options.path = options.socketPath;
  if (options.servername === undefined || options.servername === null) {
    // Node derives the SNI name from the Host header; nothing here uses it.
  }
  const name: string = agent.getName(options);
  if (agent.sockets[name] === undefined) agent.sockets[name] = [];
  let freeList: any = agent.freeSockets[name];
  let socket: any = undefined;
  if (freeList !== undefined) {
    while (Number(freeList.length) > 0 && freeList[0].destroyed === true) freeList.shift();
    socket = agent.scheduling === "fifo" ? freeList.shift() : freeList.pop();
    if (Number(freeList.length) === 0) delete agent.freeSockets[name];
  }
  const freeLen: number = freeList === undefined ? 0 : Number(freeList.length);
  const sockLen: number = freeLen + Number(agent.sockets[name].length);
  if (socket !== undefined && socket !== null) {
    agent.reuseSocket(socket, req);
    __httpSetRequestSocket(agent, req, socket);
    agent.sockets[name].push(socket);
  } else if (sockLen < Number(agent.maxSockets) && Number(agent.totalSocketCount) < Number(agent.maxTotalSockets)) {
    agent.createSocket(req, options, function (err: any, s: any): void {
      if (err !== undefined && err !== null) req.onSocket(s, err);
      else __httpSetRequestSocket(agent, req, s);
    });
  } else {
    if (agent.requests[name] === undefined) agent.requests[name] = [];
    agent.requests[name].push(req);
  }
}

function __httpAgentCreateSocket(agent: any, req: any, opts: any, cb: any): void {
  const options: any = __httpMerge(opts, agent.options);
  if (options.socketPath) options.path = options.socketPath;
  const name: string = agent.getName(options);
  options._agentKey = name;
  let called = false;
  const oncreate: any = function (err: any, s: any): void {
    if (called) return;
    called = true;
    if (err !== undefined && err !== null) {
      __httpInvoke(cb, [err]);
      return;
    }
    if (agent.sockets[name] === undefined) agent.sockets[name] = [];
    agent.sockets[name].push(s);
    agent.totalSocketCount = Number(agent.totalSocketCount) + 1;
    __httpAgentInstall(agent, s, options);
    __httpInvoke(cb, [null, s]);
  };
  // `path` is the *request* path here; the connection must not see it.
  const connOptions: any = __httpMerge(options, null);
  if (connOptions.path === null || connOptions.path === undefined || !connOptions.socketPath) {
    delete connOptions.path;
  }
  const created: any = agent.createConnection(connOptions, oncreate);
  if (created !== undefined && created !== null) oncreate(null, created);
}

function __httpAgentInstall(agent: any, s: any, options: any): void {
  s.on("free", function (): void {
    agent.emit("free", s, options);
  });
  s.on("close", function (): void {
    agent.removeSocket(s, options);
  });
  s.on("agentRemove", function (): void {
    agent.removeSocket(s, options);
  });
  // Node's agent `onTimeout`: an idle pooled socket that times out is closed.
  s.on("timeout", function (): void {
    const lists: any = agent.freeSockets;
    const names: string[] = Object.keys(lists);
    for (const name of names) {
      if (Number(lists[name].indexOf(s)) >= 0) {
        s.destroy();
        return;
      }
    }
  });
}

function __httpAgentOnFree(agent: any, socket: any, options: any): void {
  const name: string = agent.getName(options);
  const queued: any = agent.requests[name];
  if (socket.writable === true && queued !== undefined && Number(queued.length) > 0) {
    const req: any = queued.shift();
    __httpSetRequestSocket(agent, req, socket);
    if (Number(queued.length) === 0) delete agent.requests[name];
    return;
  }
  const req2: any = socket._httpMessage;
  if (req2 === null || req2 === undefined || req2.shouldKeepAlive !== true || socket.writable !== true) {
    socket.destroy();
    return;
  }
  let freeList: any = agent.freeSockets[name];
  if (freeList === undefined) freeList = [];
  const freeLen: number = Number(freeList.length);
  let count: number = freeLen;
  if (agent.sockets[name] !== undefined) count = count + Number(agent.sockets[name].length);
  if (
    Number(agent.totalSocketCount) > Number(agent.maxTotalSockets) ||
    count > Number(agent.maxSockets) ||
    freeLen >= Number(agent.maxFreeSockets) ||
    agent.keepSocketAlive(socket) !== true
  ) {
    socket.destroy();
    return;
  }
  agent.freeSockets[name] = freeList;
  socket._httpMessage = null;
  agent.removeSocket(socket, options);
  socket.once("error", function (): void {
    // A free socket that errors is simply discarded.
    socket.destroy();
  });
  freeList.push(socket);
}

function __httpAgentRemoveSocket(agent: any, s: any, options: any): void {
  const name: string = agent.getName(options);
  const list: any = agent.sockets[name];
  if (list !== undefined) {
    const at: number = Number(list.indexOf(s));
    if (at !== -1) {
      list.splice(at, 1);
      agent.totalSocketCount = Number(agent.totalSocketCount) - 1;
      if (Number(list.length) === 0) delete agent.sockets[name];
    }
  }
  const free: any = agent.freeSockets[name];
  if (free !== undefined) {
    const at2: number = Number(free.indexOf(s));
    if (at2 !== -1) {
      free.splice(at2, 1);
      if (Number(free.length) === 0) delete agent.freeSockets[name];
    }
  }
  const waiting: any = agent.requests[name];
  if (waiting !== undefined && Number(waiting.length) > 0) {
    const req: any = waiting[0];
    agent.createSocket(req, options, function (err: any, ns: any): void {
      if (err !== undefined && err !== null) {
        req.onSocket(ns, err);
        return;
      }
      ns.emit("free");
    });
  }
}

// ---------------------------------------------------------------------------
// ClientRequest (`lib/_http_client.js`)
// ---------------------------------------------------------------------------

class ClientRequest extends OutgoingMessage {
  method: any = "GET";
  path: any = "/";
  host: any = "localhost";
  protocol: any = "http:";
  res: any = null;
  aborted: any = false;
  timeout: any = undefined;
  reusedSocket: any = false;
  maxHeadersCount: any = null;
  insecureHTTPParser: any = false;
  joinDuplicateHeaders: any = undefined;
  _ended: any = false;
  _cs: any = null;
  _deferred: any = null;
  _timeoutArmed: any = false;
  _timeoutCb: any = null;
  _errored: any = false;
  _hasBodyMethod: any = true;

  constructor(input?: any, options?: any, cb?: any) {
    super();
    __httpClientInit(this, input, options, cb);
  }

  _implicitHeader(): void {
    if (this._header !== null && this._header !== undefined) throw __httpHeadersSent("render");
    if (this._hasBodyMethod === false && this._contentLength === 0) {
      this._contentLength = null;
    }
    __httpStoreHeader(this, String(this.method) + " " + String(this.path) + " HTTP/1.1\r\n");
  }

  onSocket(socket: any, err?: any): void {
    const self: any = this;
    __httpTick(function (): void {
      __httpClientOnSocketNT(self, socket, err);
    });
  }

  abort(): void {
    if (this.aborted === true) return;
    this.aborted = true;
    const self: any = this;
    __httpTick(function (): void {
      self.emit("abort");
    });
    this.destroy();
  }

  destroy(err?: any, cb?: any): any {
    if (this.destroyed === true) return this;
    const res: any = this.res;
    if (res !== null && res !== undefined) res._dump();
    return __httpOutgoingDestroy(this, err, cb);
  }

  setTimeout(msecs: any, callback?: any): any {
    if (this._ended === true) return this;
    __httpClientListenTimeout(this);
    if (callback !== undefined && callback !== null) this.once("timeout", callback);
    const self: any = this;
    if (this.socket !== null && this.socket !== undefined) {
      __httpClientSetSocketTimeout(this.socket, msecs);
    } else {
      this.once("socket", function (s: any): void {
        __httpClientSetSocketTimeout(s, msecs);
      });
    }
    return this;
  }

  setNoDelay(noDelay?: any): void {
    const flag: boolean = noDelay === undefined ? true : noDelay === true;
    __httpClientDefer(this, function (s: any): void {
      s.setNoDelay(flag);
    });
  }

  setSocketKeepAlive(enable?: any, initialDelay?: any): void {
    const flag: boolean = enable === undefined ? false : enable === true;
    __httpClientDefer(this, function (s: any): void {
      s.setKeepAlive(flag, initialDelay);
    });
  }

  getRawHeaders(): any {
    return [];
  }
}

function __httpClientDefer(req: any, fn: any): void {
  if (req.socket !== null && req.socket !== undefined) {
    __httpInvoke(fn, [req.socket]);
  } else {
    req.once("socket", function (s: any): void {
      __httpInvoke(fn, [s]);
    });
  }
}

function __httpClientSetSocketTimeout(sock: any, msecs: any): void {
  if (sock.connecting === true) {
    sock.once("connect", function (): void {
      sock.setTimeout(msecs);
    });
  } else {
    sock.setTimeout(msecs);
  }
}

function __httpClientListenTimeout(req: any): void {
  if (req._timeoutArmed === true) return;
  req._timeoutArmed = true;
  // Node's `listenSocketTimeout` delegates the socket's timeout once.
  const arm: any = function (s: any): void {
    const onTimeout: any = function (): void {
      const cs: any = s._httpConn;
      if (cs !== null && cs !== undefined && cs.req === req) req.emit("timeout");
    };
    req._timeoutCb = onTimeout;
    s.once("timeout", onTimeout);
  };
  if (req.socket !== null && req.socket !== undefined) arm(req.socket);
  else req.once("socket", arm);
}

class __HttpClientConnReset extends NodeError {
  errno: any = "ECONNRESET";
  syscall: any = undefined;
  constructor(message: string) {
    super("ECONNRESET", message);
  }
}

// `new URL`-like and string inputs, reduced to request options.
function __httpUrlToOptions(input: any): any {
  const out: any = {};
  if (typeof input === "string") {
    const text: string = input;
    const sch: number = Number(text.indexOf("://"));
    if (sch <= 0) {
      throw new __HttpTypeError("ERR_INVALID_URL", "Invalid URL");
    }
    out.protocol = text.slice(0, sch + 1).toLowerCase();
    let rest: string = text.slice(sch + 3);
    let end: number = rest.length;
    const slash: number = Number(rest.indexOf("/"));
    const query: number = Number(rest.indexOf("?"));
    const hash: number = Number(rest.indexOf("#"));
    if (slash >= 0 && slash < end) end = slash;
    if (query >= 0 && query < end) end = query;
    if (hash >= 0 && hash < end) end = hash;
    let authority: string = rest.slice(0, end);
    let path: string = rest.slice(end);
    const hashAt: number = Number(path.indexOf("#"));
    if (hashAt >= 0) path = path.slice(0, hashAt);
    if (path === "" || path.charAt(0) === "?") path = "/" + path;
    const at: number = Number(authority.lastIndexOf("@"));
    if (at >= 0) {
      out.auth = authority.slice(0, at);
      authority = authority.slice(at + 1);
    }
    let host: string = authority;
    let port = "";
    if (authority.charAt(0) === "[") {
      const close: number = Number(authority.indexOf("]"));
      host = authority.slice(1, close);
      if (authority.charAt(close + 1) === ":") port = authority.slice(close + 2);
    } else {
      const colon: number = Number(authority.lastIndexOf(":"));
      if (colon >= 0) {
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
      }
    }
    if (host === "") throw new __HttpTypeError("ERR_INVALID_URL", "Invalid URL");
    out.hostname = host.toLowerCase();
    if (port !== "") out.port = Number(port);
    out.path = path;
    out.href = text;
    return out;
  }
  // A WHATWG `URL`.
  out.protocol = input.protocol;
  let hostname: string = String(input.hostname);
  if (hostname.charAt(0) === "[") hostname = hostname.slice(1, Number(hostname.length) - 1);
  out.hostname = hostname;
  if (input.port !== undefined && input.port !== "") out.port = Number(input.port);
  out.path = String(input.pathname === undefined ? "/" : input.pathname) + String(input.search === undefined ? "" : input.search);
  if (input.username !== undefined && input.username !== "" || input.password !== undefined && input.password !== "") {
    out.auth = decodeURIComponent(String(input.username)) + ":" + decodeURIComponent(String(input.password));
  }
  out.href = input.href;
  return out;
}

function __httpIsUrlObject(value: any): boolean {
  return (
    __httpIsObj(value) &&
    typeof value.href === "string" &&
    typeof value.protocol === "string" &&
    typeof value.hostname === "string" &&
    typeof value.pathname === "string" &&
    // Node's `isURL`: a legacy `url.parse()` object has `path` and `auth`
    // (possibly `null`), so it is read as a plain options object instead.
    value.path === undefined &&
    value.auth === undefined
  );
}

let __httpGlobalAgent: any = null;

function __httpDefaultAgent(): any {
  if (__httpGlobalAgent === null) {
    __httpGlobalAgent = new Agent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });
  }
  return __httpGlobalAgent;
}

function __httpClientInit(self: any, input: any, opts: any, cb: any): void {
  let options: any = {};
  let callback: any = cb;
  if (typeof input === "string") {
    options = __httpUrlToOptions(input);
    if (__httpIsFn(opts)) {
      callback = opts;
    } else if (opts !== undefined && opts !== null) {
      options = __httpMerge(options, opts);
    }
  } else if (__httpIsUrlObject(input)) {
    options = __httpUrlToOptions(input);
    if (__httpIsFn(opts)) {
      callback = opts;
    } else if (opts !== undefined && opts !== null) {
      options = __httpMerge(options, opts);
    }
  } else {
    if (input !== undefined && input !== null && !__httpIsObj(input)) {
      throw new ERR_INVALID_ARG_TYPE("options", ["string", "object", "URL"], input);
    }
    if (__httpIsFn(input)) {
      callback = input;
      options = {};
    } else {
      options = __httpMerge(input, null);
      if (__httpIsFn(opts)) callback = opts;
    }
  }
  if (options.path !== undefined && options.path !== null) {
    const pathText: string = String(options.path);
    const pn: number = Number(pathText.length);
    let k = 0;
    while (k < pn) {
      const c: number = __httpCc(pathText, k);
      if (c <= 32 || c > 255) {
        throw new __HttpTypeError("ERR_UNESCAPED_CHARACTERS", "Request path contains unescaped characters");
      }
      k = k + 1;
    }
  }

  let agent: any = options.agent;
  const defaultAgent: any = __httpDefaultAgent();
  const customConnect: boolean = __httpIsFn(options.createConnection);
  if (agent === false) {
    agent = new Agent();
  } else if ((agent === null || agent === undefined) && !customConnect) {
    agent = defaultAgent;
  } else if (agent === null || agent === undefined) {
    agent = null;
  } else if (!__httpIsObj(agent) || typeof agent.addRequest !== "function") {
    throw new __HttpTypeError(
      "ERR_INVALID_ARG_TYPE",
      'The "options.agent" property must be one of Agent-like Object, undefined, or false.' + __evReceived(agent),
    );
  }
  self.agent = agent === null ? undefined : agent;
  const agentProtocol: any = agent === null || agent.protocol === undefined || agent.protocol === null || agent.protocol === "" ? defaultAgent.protocol : agent.protocol;

  const protocol: string = options.protocol === undefined || options.protocol === null ? String(agentProtocol) : String(options.protocol);
  const expectedProtocol: string = String(agentProtocol);
  if (protocol !== expectedProtocol) {
    throw new __HttpTypeError(
      "ERR_INVALID_PROTOCOL",
      'Protocol "' + protocol + '" not supported. Expected "' + expectedProtocol + '"',
    );
  }
  self.protocol = protocol;

  const defaultPort: any = options.defaultPort !== undefined && options.defaultPort !== null ? options.defaultPort : agent === null ? 80 : agent.defaultPort;
  let port: any = options.port;
  if (port === undefined || port === null || port === "") port = defaultPort;
  if (port === undefined || port === null) port = 80;
  options.port = port;
  // Node's `validateHost`: a string, or nothing.
  __httpValidateHost(options.hostname, "hostname");
  __httpValidateHost(options.host, "host");
  const host: any =
    options.hostname !== undefined && options.hostname !== null && options.hostname !== ""
      ? options.hostname
      : options.host !== undefined && options.host !== null && options.host !== ""
      ? options.host
      : "localhost";
  options.host = host;
  self.host = host;

  if (options.timeout !== undefined) {
    // Node's `getTimerDuration`.
    if (typeof options.timeout !== "number") throw new ERR_INVALID_ARG_TYPE("timeout", "number", options.timeout);
    self.timeout = options.timeout;
  }
  if (options.maxHeaderSize !== undefined) {
    // accepted, applied by the response parser
  }
  self.insecureHTTPParser = options.insecureHTTPParser === true;
  if (options.joinDuplicateHeaders !== undefined) self.joinDuplicateHeaders = options.joinDuplicateHeaders;

  let method: any = options.method;
  if (method !== undefined && method !== null && typeof method !== "string") {
    throw new ERR_INVALID_ARG_TYPE("options.method", "string", method);
  }
  if (method !== undefined && method !== null && method !== "") {
    if (!__httpCheckIsToken(method)) throw __httpBadToken("Method", method);
    method = String(method).toUpperCase();
  } else {
    method = "GET";
  }
  self.method = method;
  self.path = options.path === undefined || options.path === null || options.path === "" ? "/" : String(options.path);

  if (method === "GET" || method === "HEAD" || method === "DELETE" || method === "OPTIONS" || method === "TRACE" || method === "CONNECT") {
    self.useChunkedEncodingByDefault = false;
    self._hasBodyMethod = false;
  }

  if (agent === null) {
    self._last = true;
    self.shouldKeepAlive = false;
  } else {
    if (agent.keepAlive !== true && Number.isFinite(Number(agent.maxSockets)) !== true) {
      self._last = true;
      self.shouldKeepAlive = false;
    } else {
      self._last = false;
      self.shouldKeepAlive = true;
    }
  }

  const headers: any = options.headers;
  if (headers !== undefined && headers !== null) {
    if (Array.isArray(headers)) {
      if (Number(headers.length) > 0 && Array.isArray(headers[0])) {
        for (const pair of headers) self.appendHeader(pair[0], pair[1]);
      } else {
        if (Number(headers.length) % 2 !== 0) {
          throw new ERR_INVALID_ARG_VALUE("options.headers", headers, "is invalid");
        }
        let h = 0;
        while (h + 1 < Number(headers.length)) {
          __httpValidateHeaderName(headers[h]);
          __httpValidateHeaderValue(headers[h], headers[h + 1]);
          h = h + 2;
        }
        self._headersArray = headers;
      }
    } else {
      const hk: string[] = Object.keys(headers);
      for (const key of hk) self.setHeader(key, headers[key]);
    }
  }

  self._uniqueHeaders = __httpParseUniqueHeaders(options.uniqueHeaders);
  if (options.setDefaultHeaders === false) {
    self._removedConnection = true;
    self._removedContLen = true;
    self._removedTE = true;
  }
  const setHost: boolean =
    options.setHost === undefined ? options.setDefaultHeaders !== false : options.setHost === true;
  if (Array.isArray(self.getHeader("host"))) {
    throw new ERR_INVALID_ARG_TYPE("options.headers.host", "string", self.getHeader("host"));
  }
  // Headers given as an array are the whole header set: no Host, no
  // Authorization is derived for them.
  const headersIsArray: boolean = Array.isArray(options.headers);
  if (host !== undefined && setHost && !headersIsArray && !self.hasHeader("host")) {
    let hostHeader: string = String(host);
    // Only an IPv6 literal (two colons or more) is bracketed.
    const colon: number = Number(hostHeader.indexOf(":"));
    if (colon !== -1 && hostHeader.indexOf(":", colon + 1) !== -1 && hostHeader.charAt(0) !== "[") {
      hostHeader = "[" + hostHeader + "]";
    }
    // With `createConnection` and no agent Node has no default port, so the
    // port is always spelled out.
    const hostDefaultPort: any =
      agent === null && __httpIsFn(options.createConnection) && (options.defaultPort === undefined || options.defaultPort === null)
        ? undefined
        : defaultPort;
    if (port && (hostDefaultPort === undefined || Number(port) !== Number(hostDefaultPort))) {
      hostHeader = hostHeader + ":" + String(port);
    }
    self.setHeader("Host", hostHeader);
  }

  if (options.auth !== undefined && options.auth !== null && !headersIsArray && !self.hasHeader("Authorization")) {
    self.setHeader("Authorization", "Basic " + Buffer.from(String(options.auth)).toString("base64"));
  }

  if (callback !== undefined && callback !== null) self.once("response", callback);

  if (options.signal !== undefined && options.signal !== null) {
    const signal: any = options.signal;
    if (signal.aborted === true) {
      __httpTick(function (): void {
        self.destroy(new AbortError(undefined, { cause: signal.reason }));
      });
    } else {
      signal.addEventListener("abort", function (): void {
        self.destroy(new AbortError(undefined, { cause: signal.reason }));
      });
    }
  }

  // Hosts are handed to the pool without the request `path`.
  const connOpts: any = __httpMerge(options, null);
  if (options.socketPath !== undefined) {
    // Unix domain sockets are not supported by node:net here.
  }
  if (agent === null) {
    // A custom `createConnection` and no agent: the request owns its socket.
    let called = false;
    const oncreate: any = function (err: any, sock: any): void {
      if (called) return;
      called = true;
      if (err !== undefined && err !== null) self.onSocket(sock, err);
      else self.onSocket(sock);
    };
    const made: any = __httpInvoke(options.createConnection, [connOpts, oncreate]);
    if (made !== undefined && made !== null) oncreate(null, made);
    return;
  }
  agent.addRequest(self, connOpts);
}

function __httpClientOnSocketNT(req: any, socket: any, err: any): void {
  if (req.destroyed === true || (err !== undefined && err !== null)) {
    req._closed = true;
    if (socket !== undefined && socket !== null) {
      if ((err === undefined || err === null) && req.agent !== undefined && req.agent !== null && socket.destroyed !== true) {
        socket._httpMessage = req;
        socket.emit("free");
      } else {
        socket.destroy();
      }
    }
    let error: any = err;
    if (error === undefined || error === null) error = req._destroyErr;
    if ((error === undefined || error === null) && req.aborted !== true) {
      error = new __HttpClientConnReset("socket hang up");
    }
    if (error !== undefined && error !== null) {
      req._errored = true;
      req.emit("error", error);
    }
    req.emit("close");
    return;
  }
  __httpClientTickOnSocket(req, socket);
}

function __httpValidateHost(host: any, name: string): void {
  if (host !== null && host !== undefined && typeof host !== "string") {
    throw new ERR_INVALID_ARG_TYPE("options." + name, ["string", "undefined", "null"], host);
  }
}

function __httpClientTickOnSocket(req: any, socket: any): void {
  const cs: any = {
    req: req,
    socket: socket,
    parser: null,
    res: null,
    onData: null,
    onEnd: null,
    onClose: null,
    onError: null,
    skipComplete: false,
  };
  const handler: any = {
    headers(info: any): any {
      return __httpClientOnHeaders(cs, info);
    },
    body(chunk: any): void {
      __httpClientOnBody(cs, chunk);
    },
    complete(trailers: any): void {
      __httpClientOnComplete(cs, trailers);
    },
    upgrade(info: any, rest: string): void {
      __httpClientOnUpgrade(cs, info, rest);
    },
    error(e: any): void {
      __httpClientOnParseError(cs, e);
    },
    truncated(): void {
      // The close listener reports the cut-off message.
    },
  };
  cs.parser = __httpNewParser(1, handler);
  req._cs = cs;
  req.socket = socket;
  socket._httpMessage = req;
  socket._httpConn = cs;

  cs.onData = function (chunk: any): void {
    __httpParse(cs.parser, __httpLatin1(chunk));
  };
  cs.onEnd = function (): void {
    __httpClientOnSocketEnd(cs);
  };
  cs.onClose = function (): void {
    __httpClientOnSocketClose(cs);
  };
  cs.onError = function (err: any): void {
    __httpClientOnSocketError(cs, err);
  };
  socket.on("data", cs.onData);
  socket.on("end", cs.onEnd);
  socket.on("close", cs.onClose);
  socket.on("error", cs.onError);
  if (req.timeout !== undefined) {
    __httpClientListenTimeout(req);
  }
  req.emit("socket", socket);
  __httpFlushQueue(req);
}

function __httpClientOnSocketError(cs: any, err: any): void {
  const req: any = cs.req;
  const socket: any = cs.socket;
  if (req.res !== null && req.res !== undefined && req.res.complete !== true) {
    // The close listener destroys the response with `aborted`.
  }
  socket._hadError = true;
  req._errored = true;
  req.emit("error", err);
  socket.destroy();
}

function __httpClientOnSocketEnd(cs: any): void {
  const req: any = cs.req;
  const socket: any = cs.socket;
  if ((req.res === null || req.res === undefined) && socket._hadError !== true) {
    socket._hadError = true;
    req._errored = true;
    req.emit("error", new __HttpClientConnReset("socket hang up"));
  }
  __httpParserEof(cs.parser);
  socket.destroy();
}

function __httpClientOnSocketClose(cs: any): void {
  const req: any = cs.req;
  const socket: any = cs.socket;
  const res: any = req.res;
  req.destroyed = true;
  socket.removeListener("data", cs.onData);
  socket.removeListener("end", cs.onEnd);
  socket.removeListener("error", cs.onError);
  if (cs.released === true) return;
  if (res !== null && res !== undefined) {
    if (res.complete !== true) {
      res.destroy(new __HttpClientConnReset("aborted"));
    }
    req._closed = true;
    req.emit("close");
    if (res.aborted !== true && res.readable === true) res.push(null);
  } else {
    if (socket._hadError !== true && req.aborted !== true) {
      socket._hadError = true;
      req._errored = true;
      req.emit("error", new __HttpClientConnReset("socket hang up"));
    }
    req._closed = true;
    req.emit("close");
  }
}

function __httpClientOnParseError(cs: any, err: any): void {
  const req: any = cs.req;
  cs.socket._hadError = true;
  req._errored = true;
  // Node frees the parser first: the socket no longer feeds it.
  cs.socket.removeListener("data", cs.onData);
  req.emit("error", err);
  cs.socket.destroy();
}

function __httpClientOnHeaders(cs: any, info: any): any {
  const req: any = cs.req;
  const socket: any = cs.socket;
  const status: number = Number(info.statusCode);
  const res: any = new IncomingMessage(socket);
  res.httpVersionMajor = info.versionMajor;
  res.httpVersionMinor = info.versionMinor;
  res.httpVersion = String(info.versionMajor) + "." + String(info.versionMinor);
  res.rawHeaders = __httpLimitHeaders(info.headers, req.maxHeadersCount);
  res.statusCode = status;
  res.statusMessage = info.statusMessage;
  res.req = req;
  res.joinDuplicateHeaders = req.joinDuplicateHeaders === true;
  res.upgrade = false;

  if (status === 100 || (status >= 100 && status < 200 && status !== 101)) {
    cs.skipComplete = true;
    if (status === 100) {
      req.emit("continue");
    } else {
      req.emit("information", {
        statusCode: status,
        statusMessage: info.statusMessage,
        httpVersion: res.httpVersion,
        httpVersionMajor: info.versionMajor,
        httpVersionMinor: info.versionMinor,
        headers: res.headers,
        rawHeaders: info.headers,
      });
    }
    return 1;
  }
  cs.skipComplete = false;

  if (status === 101 || (req.method === "CONNECT" && status >= 200 && status < 300)) {
    cs.upgradeRes = res;
    return 2;
  }

  cs.res = res;
  req.res = res;
  res.shouldKeepAlive = info.shouldKeepAlive;
  if (info.shouldKeepAlive !== true) req.shouldKeepAlive = false;

  res.on("end", function (): void {
    __httpClientResponseOnEnd(cs, res);
  });
  const hasListener: boolean = Number(req.listenerCount("response")) > 0;
  req.emit("response", res);
  if (!hasListener) res._dump();
  if (req.method === "HEAD") return 1;
  return 0;
}

function __httpClientOnBody(cs: any, chunk: any): void {
  const res: any = cs.res;
  if (res === null || res === undefined || res.destroyed === true) return;
  const ok: boolean = res.push(chunk);
  if (!ok) {
    res._in.paused = true;
    cs.socket.pause();
  }
}

function __httpClientOnComplete(cs: any, trailers: any): void {
  if (cs.skipComplete === true) {
    cs.skipComplete = false;
    return;
  }
  const res: any = cs.res;
  if (res === null || res === undefined) return;
  // Node's `responseOnEnd`: the request's socket-timeout delegate goes.
  const req: any = cs.req;
  if (req._timeoutCb !== null && req._timeoutCb !== undefined) {
    cs.socket.removeListener("timeout", req._timeoutCb);
    req._timeoutCb = null;
  }
  res.rawTrailers = trailers;
  res.complete = true;
  res.push(null);
}

function __httpClientOnUpgrade(cs: any, info: any, rest: string): void {
  const req: any = cs.req;
  const socket: any = cs.socket;
  const res: any = cs.upgradeRes;
  const head: Buffer = __httpFromLatin1(rest);
  const evName: string = req.method === "CONNECT" ? "connect" : "upgrade";
  if (Number(req.listenerCount(evName)) > 0) {
    socket.removeListener("data", cs.onData);
    socket.removeListener("end", cs.onEnd);
    socket.removeListener("close", cs.onClose);
    socket.removeListener("error", cs.onError);
    socket.setTimeout(0);
    req.res = res;
    req.emit(evName, res, socket, head);
    req.emit("close");
  } else {
    socket.destroy();
  }
}

function __httpClientResponseOnEnd(cs: any, res: any): void {
  const req: any = cs.req;
  const socket: any = cs.socket;
  req._ended = true;
  if (req.shouldKeepAlive !== true) {
    if (socket.writable === true) socket.destroySoon();
  } else if (req.writableFinished === true && res.aborted !== true) {
    __httpClientResponseKeepAlive(cs);
  } else {
    req.once("finish", function (): void {
      if (res.aborted !== true) __httpClientResponseKeepAlive(cs);
    });
  }
}

function __httpClientResponseKeepAlive(cs: any): void {
  const req: any = cs.req;
  const socket: any = cs.socket;
  if (cs.released === true) return;
  cs.released = true;
  req.destroyed = true;
  socket.removeListener("data", cs.onData);
  socket.removeListener("end", cs.onEnd);
  socket.removeListener("error", cs.onError);
  socket.removeListener("close", cs.onClose);
  __httpTick(function (): void {
    req._closed = true;
    req.emit("close");
    // `emitFreeNT`: unconditional, even if the socket was destroyed meanwhile
    // (the agent's handler drops a dead socket).
    socket.emit("free");
  });
}

// A request that has no socket yet keeps its output queued; this is the
// counterpart of `_flushQueue` for the moment one arrives.
function __httpClientFlushPending(req: any): void {
  __httpFlushQueue(req);
}

// ---------------------------------------------------------------------------
// request / get
// ---------------------------------------------------------------------------

function __httpRequest(input?: any, options?: any, cb?: any): any {
  return new ClientRequest(input, options, cb);
}

function __httpGet(input?: any, options?: any, cb?: any): any {
  const req: any = new ClientRequest(input, options, cb);
  req.end();
  return req;
}

function __httpCreateServer(options?: any, listener?: any): any {
  return new __HttpServer(options, listener);
}

// `validateHeaderName`/`validateHeaderValue` as the module publishes them.
function __httpPublicValidateName(name: any, label?: any): void {
  __httpValidateHeaderName(name, label);
}

function __httpPublicValidateValue(name: any, value: any): void {
  __httpValidateHeaderValue(name, value);
}

const __node_http: any = {
  METHODS: __HTTP_METHODS.slice(),
  STATUS_CODES: __HTTP_STATUS_CODES,
  kConnectionsCheckingInterval: __httpKConnectionsCheckingInterval,
  Agent: Agent,
  ClientRequest: ClientRequest,
  IncomingMessage: IncomingMessage,
  OutgoingMessage: OutgoingMessage,
  // `http.Server(...)` is callable without `new` in Node, and a class cannot be
  // called in this engine -- so the published `Server` is a factory, which
  // also means `new http.Server(...)` and `x instanceof http.Server` are not
  // available (the module-object `new` gap, zun#18).
  Server(options?: any, listener?: any): any {
    return __httpCreateServer(options, listener);
  },
  ServerResponse: ServerResponse,
  createServer(options?: any, listener?: any): any {
    return __httpCreateServer(options, listener);
  },
  get(input?: any, options?: any, cb?: any): any {
    return __httpGet(input, options, cb);
  },
  request(input?: any, options?: any, cb?: any): any {
    return __httpRequest(input, options, cb);
  },
  validateHeaderName(name: any, label?: any): void {
    __httpPublicValidateName(name, label);
  },
  validateHeaderValue(name: any, value: any): void {
    __httpPublicValidateValue(name, value);
  },
  setMaxIdleHTTPParsers(max: any): void {
    if (typeof max !== "number") throw new ERR_INVALID_ARG_TYPE("max", "number", max);
    if (!(max > 0) || Math.floor(max) !== max) throw new ERR_OUT_OF_RANGE("max", "> 0", max);
  },
  maxHeaderSize: __HTTP_MAX_HEADER_SIZE,
  // `_http_common`'s two predicates, which Node's tests reach through
  // `require('_http_common')` (served from this same object).
  _checkIsHttpToken(value: any): boolean {
    return __httpCheckIsToken(value);
  },
  _checkInvalidHeaderChar(value: any): boolean {
    return __httpInvalidHeaderChar(String(value));
  },
  methods: __HTTP_METHODS.slice(),
  get globalAgent(): any {
    return __httpDefaultAgent();
  },
  set globalAgent(value: any) {
    __httpGlobalAgent = value;
  },
};

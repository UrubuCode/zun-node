# `http` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-http-*.js` — 379 files,
listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded by
[`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. (`test-http2-*` and `test-https-*` are different modules and are not
selected.) The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* the failing tests fail.

**225 / 379 passing (59.4%)**, measured on Windows with the release engine built
from zun `main` (2026-11-18) and `zun_node.dll`. The previous measurement was
164 / 379.

`http` is Zun TypeScript over `net` — [`../../src/http/http.ts`](../../src/http/http.ts)
— and, like `net`, runs as `zun run --ext <lib> <bundle.ts>`: the sockets
underneath are the shared I/O loop's. It has **no natives of its own**: what
Node does with llhttp (a C state machine) is a small incremental HTTP/1.1
parser written in TypeScript.

## What is implemented

- **Parser** (`__httpParse`): request and status lines, header block (with
  `obs-fold`), and four body framings — none, `Content-Length`,
  `Transfer-Encoding: chunked` (with chunk extensions and trailers), and "until
  the connection closes". A finished message rearms the machine, which is
  keep-alive and pipelining. Errors carry llhttp's codes (`HPE_INVALID_METHOD`,
  `HPE_HEADER_OVERFLOW`, `HPE_INVALID_CONTENT_LENGTH`, ...). Bytes live as a
  *latin1 string* between the socket and the parser: one code unit per octet, so
  slicing at byte offsets and turning a slice back into a `Buffer` is exact.
- **`createServer` / `Server`** over `net.Server` with `allowHalfOpen`:
  `'request'`, `'checkContinue'`, `'checkExpectation'`, `'upgrade'`,
  `'connect'`, `'clientError'` (default: `400`/`431` and destroy), `timeout`,
  `setTimeout`, `keepAliveTimeout`, `maxRequestsPerSocket` (with `Keep-Alive:
  timeout=N, max=M`), `maxHeadersCount`, `uniqueHeaders`, `closeIdleConnections`,
  `closeAllConnections`, and `close()` dropping idle connections as Node 19+ does
  (a connection still receiving its first message is not idle).
- **`headersTimeout` / `requestTimeout`** are enforced by Node's
  connection-checking sweep: a `setInterval` of `connectionsCheckingInterval`
  armed on `'listening'` (stored under `kConnectionsCheckingInterval`, which
  `require('_http_server')` publishes), cleared by `close()`, that answers `408
  Request Timeout` (or `'clientError'` with `ERR_HTTP_REQUEST_TIMEOUT`) to a
  connection whose header block or whole message is still arriving past the
  limit. A message's clock starts at accept time or at its first byte, a
  pipelined message that begins in the chunk ending the previous one included;
  `headersTimeout` defaults to `min(60 s, requestTimeout)` and may not exceed it.
  Pipelined requests are queued behind the response in flight.
- **`IncomingMessage`** (`Readable`): `headers`/`rawHeaders` with Node's
  duplicate-joining rules, `trailers`, `headersDistinct`, backpressure that
  pauses the *socket*, `_dump`, abort semantics on destroy.
- **`OutgoingMessage` / `ServerResponse`** (`Writable`): `setHeader`/`getHeader`/
  `getHeaders`/`getHeaderNames`/`hasHeader`/`removeHeader`/`appendHeader`/
  `setHeaders`, `writeHead` (all argument shapes), `writeContinue`,
  `writeProcessing`, `writeEarlyHints`, `addTrailers`, implicit headers
  (`Content-Length` when `end(data)` has the whole body, `chunked` otherwise,
  `Connection: close` for HTTP/1.0 or `shouldKeepAlive` false, no body for
  `HEAD`/`204`/`304`/`1xx`), `Date`, `Keep-Alive: timeout=N`, `headersSent`.
- **`ClientRequest`** + `request`/`get`: URL string / URL object / options
  cascades, `host`/`hostname`/`port`/`path`/`method`/`headers`/`auth`/`agent`/
  `createConnection`/`signal`/`timeout`/`setHost`, `Host` header derivation,
  `'socket'`, `'response'`, `'continue'`, `'information'`, `'upgrade'`,
  `'connect'`, `'timeout'`, `abort()`/`destroy()`, `socket hang up`.
- **`Agent`**: the pool — `sockets` / `freeSockets` / `requests` by
  `host:port:localAddress[:family]`, `maxSockets`, `maxFreeSockets`,
  `maxTotalSockets`, `lifo`/`fifo` scheduling, `keepAlive` reuse (idle sockets are
  `unref`ed, re-`ref`ed on reuse), the `'free'` protocol, `getName`, `destroy`;
  `globalAgent` is `keepAlive: true` as in Node 19+.
- `METHODS`, `STATUS_CODES`, `validateHeaderName`/`validateHeaderValue` (with
  Node's `ERR_INVALID_HTTP_TOKEN` / `ERR_HTTP_INVALID_HEADER_VALUE` /
  `ERR_INVALID_CHAR`), `maxHeaderSize`, `setMaxIdleHTTPParsers`,
  `_checkIsHttpToken`, `_checkInvalidHeaderChar`.

## Documented deviations

| Area | Deviation |
|---|---|
| Parser | Not llhttp: no `insecureHTTPParser` leniency flags (accepted, ignored), no `HTTPParser` binding, no lenient-flag per-stream override. The smuggling hardening the corpus checks is reproduced: only llhttp's known methods (an impossible first byte fails at once), a response must start with `HTTP/`, bare CR / LF / CTLs in header values and chunk-size lines, `chunked` not last (also across an `obs-fold`), `Transfer-Encoding` with `Content-Length`, duplicate or conflicting `Content-Length`, chunk extensions over 16 KiB (`413`). Errors carry `bytesParsed` and `rawPacket`. |
| `new http.Server(...)` | `http.Server` on the module object is a **factory function**, not the class: Node lets you call it without `new`, a class cannot be called here, and `new <module object>.Ctor()` does not reach a constructor in this engine ([zun#18](https://github.com/UrubuCode/zun/issues/18)). So `new http.Server()` and `x instanceof http.Server` are unavailable; `createServer` and `http.Server(fn)` work. `Agent`, `ClientRequest`, `IncomingMessage`, `OutgoingMessage` and `ServerResponse` are *canonical bindings* of the bundler (top-level class names), so `new http.Agent()` works; `http.Agent(opts)` without `new` does not. |
| Timeouts | All enforced (see above). The sweep compares wall-clock `Date.now()`, while the harness's Node timers run on the engine's virtual clock, which advances one millisecond per I/O pump turn: on a loaded machine a `setTimeout(f, 300)` fires seconds late, so the two `*-timeout-keepalive` files (which wait 15 virtual seconds) run out the runner's 20 s. |
| Sockets | `socketPath`/Unix domain sockets are unsupported (`net` has no pipes). Name resolution blocks, as in `net`. |
| `OutgoingMessage` | A `Writable` rather than a legacy `Stream`; `'close'` is emitted by the module (`autoDestroy`/`emitClose` are off). `strictContentLength` and `Content-Length` mismatch errors are not enforced. `rejectNonStandardBodyWrites` is accepted, not applied. |
| Not published | `HTTPParser`, `parsers`, `freeParser`, `WebSocket`, `MessageEvent`, `CloseEvent`, `kOutHeaders`-style internals, `https`/`http2`. |
## What blocks the other 154 tests

Counts are from [`RESULTS.md`](RESULTS.md). The five `test-http-url.parse-*`
files were not failing on the `DEP0169` warning (that is only the first stderr
line): a legacy `url.parse()` object was taken for a WHATWG `URL`, and Node's
`isURL` (no `path`/`auth` own data) now decides.

| Count | Blocker | Where it lives |
|---:|---|---|
| ~33 | `mustCall` never satisfied / `mustNotCall` fired — multi-section tests that stop at an engine gap, `finished()` on a response firing before `'close'` (`test-http-outgoing-finished`), `res.end()` to a non-socket `Writable` not issuing its final empty write (`test-http-server-response-standalone`), self-piped upgrade sockets (`test-http-server-request-timeout-upgrade`), the virtual-clock lag above | mixed |
| ~28 | `strictEqual` / `deepStrictEqual` / `throws` mismatches — socket `'timeout'` listener counts that mirror Node internals (`test-http-client-timeout-option-*`, `test-http-agent-timeout-option`), `err.constructor === Error` ([zun#140](https://github.com/UrubuCode/zun/issues/140), `test-http-client-close-event`), `fn.constructor === Function` ([zun#98](https://github.com/UrubuCode/zun/issues/98), `test-http-header-validators`), the `forEach`-with-`this` argument shift ([zun#117](https://github.com/UrubuCode/zun/issues/117), `test-http-request-methods`) | mixed |
| ~22 | Compile-time rejections in the test body: monkey-patching a method on a typed instance ([zun#112](https://github.com/UrubuCode/zun/issues/112)), `duplicate class` (zun#108), `spread arguments are not lowered yet` (zun#92) | engine |
| ~25 | `unresolved require()` (`https`, `tls`, `cluster`, `internal/*`, `../common/*`), `internalBinding('http_parser')`, `WebSocket`, `async_hooks.createHook` | not in scope |
| 4 | `socketPath` / named pipes (`options.path` unsupported by `net`: the I/O loop has no pipe handle on either platform) | `net` |
| 1 | `test-http-write-callbacks` used to "pass": its assertions live in a `process.on('exit')` handler whose failure does not change the exit code. It now runs into the runner's timeout instead | harness |

## Work the tests forced

- `src/net/net.ts` gained four declared fields on `Socket` — `_httpMessage`,
  `_httpConn`, `_hadError`, `parser` — which are Node's own names; an undeclared
  write on a class instance is a compile error here. `socket.parser.incoming`
  follows Node's `clearIncoming`.
- `setHeaders(map)` recognises a `Map` by `instanceof` and walks it with
  `forEach`: a built-in method read off a `Map` through `any` answers
  `undefined` although calling it works ([zun#17](https://github.com/UrubuCode/zun/issues/17)).
- `tools/harness/countdown.ts` is `test/common/countdown.js`; it unblocked 33
  files that failed to bundle.
- Engine facts established while writing the module: `super.write(chunk, undefined, undefined)`
  from a subclass override fails with `invalid argument to built-in function`
  (the module calls the stream internals directly); the stream hands a *string*
  to a write hook even with `decodeStrings: true`; a class cannot be invoked as a
  function.

# `http` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-http-*.js` — 379 files,
listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded by
[`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. (`test-http2-*` and `test-https-*` are different modules and are not
selected.) The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* the failing tests fail.

**164 / 379 passing (43.3%)**, measured on Windows with the release engine built
from zun `main` (2026-11-18, after the zun#111 bundler workaround) and `zun_node.dll`.

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
  `setTimeout`, `keepAliveTimeout`, `maxRequestsPerSocket`, `closeIdleConnections`,
  `closeAllConnections`, and `close()` dropping idle connections as Node 19+ does.
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
| Parser | Not llhttp: no `insecureHTTPParser` leniency flags (accepted, ignored), no `HTTPParser` binding, no lenient-flag per-stream override. Request-smuggling hardening is partial (duplicate or conflicting `Content-Length` and bad chunk framing are errors; the full llhttp list is not reproduced). |
| `new http.Server(...)` | `http.Server` on the module object is a **factory function**, not the class: Node lets you call it without `new`, a class cannot be called here, and `new <module object>.Ctor()` does not reach a constructor in this engine ([zun#18](https://github.com/UrubuCode/zun/issues/18)). So `new http.Server()` and `x instanceof http.Server` are unavailable; `createServer` and `http.Server(fn)` work. `Agent`, `ClientRequest`, `IncomingMessage`, `OutgoingMessage` and `ServerResponse` are *canonical bindings* of the bundler (top-level class names), so `new http.Agent()` works; `http.Agent(opts)` without `new` does not. |
| Timeouts | `server.timeout`, `keepAliveTimeout` and per-request `setTimeout` are implemented on the socket timer. `headersTimeout`, `requestTimeout` and `connectionsCheckingInterval` are stored and validated but **not enforced** (no connection-checking sweep); about fourteen `test-http-server-*timeout*` files depend on it. |
| Sockets | `socketPath`/Unix domain sockets are unsupported (`net` has no pipes). Name resolution blocks, as in `net`. |
| `OutgoingMessage` | A `Writable` rather than a legacy `Stream`; `'close'` is emitted by the module (`autoDestroy`/`emitClose` are off). `strictContentLength` and `Content-Length` mismatch errors are not enforced. `rejectNonStandardBodyWrites` is accepted, not applied. |
| Not published | `HTTPParser`, `parsers`, `freeParser`, `WebSocket`, `MessageEvent`, `CloseEvent`, `kOutHeaders`-style internals, `https`/`http2`. |
## What blocks the other 215 tests

Counts are from [`RESULTS.md`](RESULTS.md). The `this`-in-a-callback and
closure-capture blockers of the previous measurement are fixed in the engine.

| Count | Blocker | Where it lives |
|---:|---|---|
| ~49 | `mustCall` never satisfied / `mustNotCall` fired — a mix: unenforced timeouts (`headersTimeout`/`requestTimeout`, ~14 `test-http-server-*timeout*`), `Connection: close` decisions after `server.close()`, smuggling hardening, `Content-Length` mismatch; plus engine gaps inside multi-section tests | mixed |
| ~39 | `strictEqual` / `deepStrictEqual` / `throws` mismatches — partly http gaps (error codes and messages of edge cases), partly engine: a `forEach` callback that mentions `this` gets its arguments shifted ([zun#117](https://github.com/UrubuCode/zun/issues/117), e.g. `test-http-request-methods`) | mixed |
| ~10 | Monkey-patching a method on a typed instance (`agent.createSocket = ...`, `msg._implicitHeader = ...`) is a compile error ([zun#112](https://github.com/UrubuCode/zun/issues/112)); expandos on other modules' classes (`url.headers`, `stream.pause`) the same way | engine |
| 5 + 4 | `duplicate class` (zun#108) and `spread arguments are not lowered yet` (zun#92) — rejected at compile time in the test body | engine |
| ~25 | `unresolved require()` (`https`, `tls`, `cluster`, `internal/*`, `../common/*`), `internalBinding`, `WebSocket`, `async_hooks.createHook` | not in scope |
| 4 | `socketPath` / named pipes (`options.path` unsupported by `net`) | `net` |
| ~5 | `url.parse()` deprecation warning written to stderr makes the test fail its stderr check | `url` |

## Work the tests forced

- `src/net/net.ts` gained three declared fields on `Socket` — `_httpMessage`,
  `_httpConn`, `_hadError` — which are Node's own names; an undeclared write on a
  class instance is a compile error here.
- `tools/harness/countdown.ts` is `test/common/countdown.js`; it unblocked 33
  files that failed to bundle.
- Engine facts established while writing the module: `super.write(chunk, undefined, undefined)`
  from a subclass override fails with `invalid argument to built-in function`
  (the module calls the stream internals directly); the stream hands a *string*
  to a write hook even with `decodeStrings: true`; a class cannot be invoked as a
  function.

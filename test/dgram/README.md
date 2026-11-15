# `dgram` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-dgram-*.js` (and
`.mjs`) — 76 files, listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded
by [`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* each failing test fails.

**29 / 76 passing (38.1%)**, measured on Windows with the release engine and
the worktree's own `zun_node.dll` (the engine build at the time had a
`Function.prototype.call/apply` regression reported by the coordinator; nothing
in `dgram` uses `call`/`apply`, but a re-measure after the engine fix is
warranted).

`dgram` is the second consumer of the shared I/O loop in
[`../../src/io/`](../../src/io/) and follows exactly the pattern `net`
established: syscalls in Rust, Node's API in TypeScript.

| Layer | File | What it is |
|---|---|---|
| Syscalls | [`src/io/udp.rs`](../../src/io/udp.rs) | `ioUdpOpen/Bind/Send/Recv/Connect/Disconnect/Opt/Membership/SourceMembership/MulticastIf`, published under `node:io` beside the stream verbs |
| Platform primitives | [`src/io/sys.rs`](../../src/io/sys.rs) | `socket(SOCK_DGRAM)`, `sendto`/`recvfrom`, `connect(AF_UNSPEC)`, raw `setsockopt`/`getsockopt`, the option numbers per platform |
| Natives glue | [`src/io/native.ts`](../../src/io/native.ts) | forwarding methods only |
| Module | [`src/dgram/dgram.ts`](../../src/dgram/dgram.ts) | `createSocket`, `Socket` (an `EventEmitter`), bind/connect state machines, the pre-bind send queue, the `send()` argument cascades, errors |

The handle table, readiness query (`ioPoll`), `ref`/`unref` accounting and the
error slots are the loop's own; a datagram handle needed only a new `Kind` and
an `ipv6` flag in the table. `ioSockName`, `ioPeerName`, `ioClose`, `ioInterest`
work on it unchanged. Ten Rust tests in
[`src/io/tests.rs`](../../src/io/tests.rs) drive the datagram verbs below the
ABI: a lossless round trip of every byte value with the sender's address, `EAGAIN`
before a datagram arrives, an empty datagram being a datagram, connect /
addressless send / disconnect, `EADDRINUSE`, `SO_REUSEADDR` sharing, the scalar
options, the `udp6` family check, membership join/leave and a closed handle.

What is implemented: `createSocket(type | options, listener)` (`type`, `lookup`,
`reuseAddr`, `ipv6Only`, `reusePort`, `recvBufferSize`, `sendBufferSize`,
`signal`), `bind` (all argument forms), `connect`/`disconnect`/`remoteAddress`,
`send` (string, Buffer, array of them, `offset`/`length`, default host, callback
with the byte count, the queue held until bound, sends dropped silently without
a callback), `sendto`, `address`, `close`, `ref`/`unref`, `setBroadcast`,
`setTTL`, `setMulticastTTL`, `setMulticastLoopback`, `setMulticastInterface`,
`addMembership`/`dropMembership` (IPv4 and IPv6),
`add/dropSourceSpecificMembership` (IPv4; Linux and Windows),
`get/setRecvBufferSize`, `get/setSendBufferSize`, `getSendQueueSize/Count`
(only counts datagrams the kernel refused with "would block"), and Node's error
classes and messages.

## Why the other 47 fail

### 1. The test requires something this library does not have — 14 tests

They fail in the bundler, before the engine sees them: `internal/dgram` (7:
`kStateSymbol`, `_createSocketHandle`, the handle binding), `cluster` (6) and
`../common/udp` (1).

### 2. Engine gaps in the *test bodies*

* **A byte view is opaque through an `any` lane
  ([zun#38](https://github.com/UrubuCode/zun/issues/38)).** The `'message'`
  event hands the test a real `Buffer`, but a test's `(msg, rinfo) => …`
  parameter is an `any`, so `msg.toString()` answers `104,101,108,108,111`
  instead of `hello`. Any test that inspects message *contents* is capped by
  this (the same ceiling `net`, `zlib` and `fs` report). Minimal repro: a
  bound socket, `s.on('message', (m) => console.log(m.toString()))`, send
  `'hello'`.
* **A `number` cannot be a `Buffer` size or fill byte** (`Buffer.alloc(n)`,
  `.fill(n)`; "Buffer fill byte must be an integer", zun#58) — 11 tests are
  rejected at compile time by their own bodies.
* **`this` is not threaded into a listener** (zun#1): the `bind(0, function
  () { this.address() })` idiom reads `this.address` of `undefined`. 6 tests.
  `EventEmitter` calls listeners as `fn(...args)`.
* **`Function.prototype.bind` is not usable on a method**
  (`const setup = dgram.createSocket.bind(dgram, {...})` in
  `test-dgram-membership.js`).
* **`assert.throws(fn, validatorArrowFunction)` treats an arrow as a class**
  (`test-dgram-socket-buffer-size.js`: "expected to be an instance of
  undefined"); this is `assert`, not `dgram`.
* `new String('udp4')` is a primitive here, so `test-dgram-createSocket-type.js`
  cannot see it rejected; `AbortSignal.addEventListener` takes exactly two
  arguments and an `__evBox`ed listener is refused by the built-in (a raw
  function works), which is why `{ once: true }` is emulated.

### 3. Remaining, in this module or undetermined

`test-dgram-send-queue-info.js` (a send queue that is non-empty after `send()`
returns needs a kernel refusing the datagram; loopback never does),
`test-dgram-udp6-link-local-address.js` (needs a link-local interface scope),
`test-dgram-send-address-types.js`, `-send-bad-arguments.js`,
`-multicast-set-interface.js`, `-connect-send-empty-array.js`,
`-send-empty-array.js` and the two `*-multi-string-array.js` (message contents
through the `any` lane or a `deepStrictEqual` on views), `test-dgram-blocklist.js`
(`net.BlockList.check` through an `any`), and `test-dgram-async-dispose.mjs`
(`Symbol.asyncDispose` is not implemented). The residual failures were not all
reduced to a single cause.

## Documented deviations

* **Name resolution blocks.** A non-literal `address` goes through the same
  synchronous `getaddrinfo` as `net` (delivered on a later tick); IP literals
  resolve on a tick without a syscall.
* **The socket is opened in the constructor** (as Node creates its `UDP`
  handle there), but registered with the loop — and so able to keep the
  process alive — only at `bind()`, which is when libuv's handle becomes
  active. Calls that need a bound socket throw `EBADF` before that, with the
  libuv errno of the platform (`ENOTSOCK` for the buffer-size calls on Windows,
  as the corpus expects).
* **Views are copied.** `Buffer`s are sent by reference to their bytes, but a
  `Uint8Array` is copied element by element and a `DataView`/wider view is read
  as its element sequence, because a byte view cannot be read through an `any`.
* **`send()` that the kernel refuses** is held in a queue and retried on the
  writable event, order preserved; on loopback this essentially never happens.
* **`setMulticastInterface` with a multicast address** fails with
  `EADDRNOTAVAIL` on every platform (Winsock would accept it silently).
* **`reusePort` is `ENOTSUP` on Windows**, as in libuv.
* **No `cluster`/`handle`/`fd` binding** (`bind({ fd })`, `bind(handle)`),
  no `dgram._createSocketHandle`, no `Symbol.asyncDispose`, no
  `ERR_SOCKET_BUFFER_SIZE` inspect shape (`[Getter/Setter]` fields): the error
  carries `info`, `errno`, `syscall` as plain properties.
* **The unix side of `src/io/sys.rs` is not compiled or tested here** (this
  was developed and measured on Windows); the POSIX code follows the same
  structure as the stream verbs, with Linux's `ip_mreq_source` field order and
  `IPV6_JOIN_GROUP` on the BSDs behind `cfg`.

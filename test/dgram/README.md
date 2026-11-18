# `dgram` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-dgram-*.js` (and
`.mjs`) — 76 files, listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded
by [`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* each failing test fails.

**58 / 76 passing (76.3%)**, measured on Windows with the release engine of
the `fix/dgram-gaps` branch (the engine fixes below) and the worktree's own
`zun_node.dll`. Before this round: 29 / 76 (the bundler could not resolve
`internal/dgram`, `cluster` and `../common/udp`, and three engine gaps rejected
or mis-ran a test's own body). Tests that `common.skip` on Windows (the cluster
group, `bind({ fd })`) count as passing, as they do in Node's TAP output.

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

## Why the other 18 fail

### Harness additions in this round

* `internal/dgram` is `{ kStateSymbol, _createSocketHandle }`
  (`src/dgram/dgram.ts`). `socket[kStateSymbol]` is `{ handle }`, where `handle`
  is a facade with `fd`, `lookup`, `send` and `onmessage`; the socket routes its
  own lookup, send and receive-error paths through it, so a test that replaces
  `handle.lookup`/`handle.send` or calls `handle.onmessage(-1, ...)` takes
  effect. `kStateSymbol` is the *string* `"_dgView"` rather than a `Symbol`: a
  class instance that gains a symbol-keyed member stops resolving `this.<field>`
  in its own methods (engine bug, "Cannot read private member").
* `cluster` (`tools/harness/cluster.ts`) is always the primary; `fork()` is a
  `common.skip`, because this platform has no process fork. `../common/udp`
  (`tools/harness/udp.ts`) probes `reusePort` with a real socket.

### Engine gaps still in the test bodies

* `net.BlockList.check` through an `any` (`test-dgram-blocklist.js`);
  `Symbol.asyncDispose` (`test-dgram-async-dispose.mjs`).
* `repeated.push(...toSend.slice(0, 3))`: "spread arguments are not lowered yet"
  (`test-dgram-send-default-host.js`, `-udp6-send-default-host.js`).
* `msg.toString()` where the checker infers `String` (`test-dgram-udp4.js`: "no
  method `toString` on String").
* `Function.prototype.bind` on a method (`test-dgram-membership.js`);
  `assert.throws(fn, validatorArrow)` treats an arrow as a class
  (`test-dgram-socket-buffer-size.js`); `udp_wrap` is not an internal binding
  (`test-dgram-create-socket-handle.js`).
* `test-dgram-send-empty-buffer.js`: `interval is not defined` (a `const`
  captured by a closure that runs before its initializer finishes).

### Remaining, in this module or undetermined

`test-dgram-send-queue-info.js` (needs a kernel refusing the datagram; loopback
never does), `test-dgram-udp6-link-local-address.js` (needs a link-local
interface scope), `-send-address-types.js`, `-send-bad-arguments.js`,
`-multicast-set-interface.js`, `-connect-send-default-host.js`,
`-connect-send-empty-packet.js`, `-send-empty-packet.js`, `-custom-lookup.js`.
The residual failures were not all reduced to a single cause.

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
  `_createSocketHandle` exists but there is no `udp_wrap` binding, no `Symbol.asyncDispose`, no
  `ERR_SOCKET_BUFFER_SIZE` inspect shape (`[Getter/Setter]` fields): the error
  carries `info`, `errno`, `syscall` as plain properties.
* **The unix side of `src/io/sys.rs` is not compiled or tested here** (this
  was developed and measured on Windows); the POSIX code follows the same
  structure as the stream verbs, with Linux's `ip_mreq_source` field order and
  `IPV6_JOIN_GROUP` on the BSDs behind `cfg`.

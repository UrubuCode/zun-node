# `dgram` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-dgram-*.js` (and
`.mjs`) — 76 files, listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded
by [`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* each failing test fails.

**68 / 76 passing (89.4%)**, measured on Windows with the release engine and
the worktree's own `zun_node.dll` (60 / 76 at the start of this round, 29 / 76
before the previous one). Tests that `common.skip` on Windows (the cluster
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
(datagrams waiting for writability; size is 0 on Windows, as libuv's
`uv__send` reports there), `receiveBlockList`/`sendBlockList` (`ERR_IP_BLOCKED`),
`Symbol.asyncDispose`, and Node's error
classes and messages.

## Why the other 8 fail

All eight are engine gaps in the test body itself; none is in this module.

| Test | Blocker |
|---|---|
| `test-dgram-send-empty-buffer.js`, `-send-empty-packet.js`, `-connect-send-empty-packet.js` | A closure reading a `const` declared later in the same scope (`clearInterval(interval)`) throws `interval is not defined` ([zun#147](https://github.com/UrubuCode/zun/issues/147)). |
| `test-dgram-send-default-host.js`, `-udp6-send-default-host.js` | `repeated.push(...toSend.slice(0, 3))`: spread into a method call is not lowered ([zun#92](https://github.com/UrubuCode/zun/issues/92)). |
| `test-dgram-membership.js` | `dgram.createSocket.bind(dgram, { type: 'udp4', ... })()` delivers the bound options to the wrong parameter ([zun#157](https://github.com/UrubuCode/zun/issues/157)). |
| `test-dgram-socket-buffer-size.js` | `const { UV_ENOTSOCK } = internalBinding('uv')` at top level is not visible inside a function declaration ([zun#34](https://github.com/UrubuCode/zun/issues/34)). |
| `test-dgram-udp4.js` | `message_to_send.toString()` on a typed string is a compile error ([zun#164](https://github.com/UrubuCode/zun/issues/164)). |

## What moved the count from 60 to 68

* `send()` on a connected socket follows Node's cascade exactly (the buffer
  type is validated before an address is refused), and a `DataView` is read
  byte by byte (`-send-bad-arguments.js`).
* The default lookup calls `dns.lookup` at call time when `dns` is in the
  program (published as `globalThis.__zunNodeDns`), so a replaced
  `dns.lookup` is honoured (`-custom-lookup.js`).
* `setMulticastInterface` on `udp6` is `EINVAL` for a text that is not an IPv6
  address, as `uv_ip6_addr` decides (`-multicast-set-interface.js`).
* `--test-udp-no-try-send` (forwarded from `// Flags:` through `NODE_OPTIONS`
  by the runner) queues every send until writability (`-send-queue-info.js`).
* A link-local IPv6 sender carries its scope in `rinfo.address`
  (`%<index>` on Windows, `%<ifname>` elsewhere, as Node's `AddressToJS`)
  (`-udp6-link-local-address.js`).
* `receiveBlockList` / `sendBlockList`, with `net.BlockList.check` now an
  own, replaceable function field; the list is consulted through
  `Reflect.apply` because a replacement reading `arguments` loses its first
  argument through a member call ([zun#163](https://github.com/UrubuCode/zun/issues/163)) (`-blocklist.js`).
* `socket[Symbol.asyncDispose]` (an own property: class computed keys are
  limited, zun#31), and the bundler maps `../common/index.mjs` to the common
  harness (`-async-dispose.mjs`).
* `internalBinding('udp_wrap').UDP` is served by the harness
  (`-create-socket-handle.js`).

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
  `Uint8Array` is copied element by element, a `DataView` is read byte by byte, and a wider view is read
  as its element sequence, because a byte view cannot be read through an `any`.
* **`send()` that the kernel refuses** is held in a queue and retried on the
  writable event, order preserved; on loopback this essentially never happens.
* **`setMulticastInterface` with a multicast address** fails with
  `EADDRNOTAVAIL` on every platform (Winsock would accept it silently).
* **`reusePort` is `ENOTSUP` on Windows**, as in libuv.
* **No `cluster`/`handle`/`fd` binding** (`bind({ fd })`, `bind(handle)`),
  `udp_wrap` serves only `UDP` (an unbound handle's `fd` is -1, a bound one's
  is not a real descriptor), no `ERR_SOCKET_BUFFER_SIZE` inspect shape (`[Getter/Setter]` fields): the error
  carries `info`, `errno`, `syscall` as plain properties.
* **The unix side of `src/io/sys.rs` is not compiled or tested here** (this
  was developed and measured on Windows); the POSIX code follows the same
  structure as the stream verbs, with Linux's `ip_mreq_source` field order and
  `IPV6_JOIN_GROUP` on the BSDs behind `cfg`.

# `net` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-net-*.js` — 149 files,
listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded by
[`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* each failing test fails.

**41 / 149 passing (27.5%)**, measured on Windows with the release engine at
`c4afcca4` and the worktree's own `zun_node.dll`.

`net` is the kind `os` introduced — Zun TypeScript over Rust natives, run as
`zun run --ext <lib> <bundle.ts>` — with one difference that is the whole story
of this track: **its natives are not its own**.

## The thing that had to be built first

Every native in this library until now *blocks*. `os` asks the kernel a
question and gets an answer; `fs` reads a file; `dns` resolves a name. The
asynchrony of Node's API is restored on the TypeScript side by delivering the
result through `process.nextTick`, which `../../src/dns/dns.ts` documents as
"synchronous natives, asynchronous API". That is honest for a name lookup. It
cannot work for a socket: a server has to be *waiting* for a connection while
the program runs, two sockets have to make progress at the same time, and a
read has to be able to complete after the call that armed it returned.

ABI v1 gives an extension no way to complete a call later, so the direction is
inverted instead. No native waits for a *particular* event — each one either
completes or answers "not yet" (`+A`) — and **one** native, `ioPoll(timeoutMs)`,
waits for *any* registered handle, blocking at most the timeout it is given.
That is the readiness model (`select`/`poll`), and it is the only asynchronous
I/O this ABI can express.

So the lower half of `net` is `../../src/io/` under the module key `node:io`,
not `src/net/*.rs`:

- [`../../src/io/mod.rs`](../../src/io/mod.rs) — the handle table, the eleven
  verbs on one handle, and `ioPoll`.
- [`../../src/io/sys.rs`](../../src/io/sys.rs) — the raw non-blocking
  primitives, `poll(2)` on POSIX and `select` on Windows. **Not `WSAPoll`**: it
  has the documented defect of never reporting a *failed* connection attempt,
  which would hang the loop instead of raising `ECONNREFUSED` (libuv avoids it
  for the same reason). `select`'s `FD_SETSIZE` ceiling does not apply, because
  the Windows `fd_set` is a counted array and that file builds the layout in a
  `Vec` of the needed size.
- [`../../src/io/io.ts`](../../src/io/io.ts) — the loop: which handle wants
  which event, `ref`/`unref`, the pump, the dispatch.
- [`../../src/io/native.ts`](../../src/io/native.ts) — the one file that names
  the extension, appended only to a bundle that gets `--ext`.

Nothing in any of them is `net`-shaped beyond TCP's own verbs, because `dgram`,
`child_process.spawn`'s pipes, `fs`' streams and `http` are meant to register
with this same loop rather than start a second one. Thirteen Rust tests in
[`../../src/io/tests.rs`](../../src/io/tests.rs) drive it below the ABI: a
loopback round trip over every byte value, `EAGAIN` before a peer arrives, an
orderly close read as end of file, a refused connect settling rather than
hanging, a reserved handle being invisible until it connects, and `ioPoll`
actually honouring its timeout when there is nothing to watch.

### Two design points the next tracks inherit

**Nothing drives the pump but the program's existing loop turn.** The first
version of this loop armed its own chain — each turn scheduling the next with
`setTimeout(step, 1)` — and it does not work here, in a way worth recording
because the next track will reach for the same shape. The virtual clock
fast-forwards to the earliest due time, so *every* armed task is due as soon as
it jumps, and among due tasks this engine runs the most recently armed one. A
pump that re-arms at the end of its own turn is therefore always the newest
task and always wins: with one handle registered, **nothing else in the program
ever ran again**. A four-line probe shows it — a `net` server plus
`setTimeout(f, 1)`, where `f` never fires — and no arming distance fixes it,
because the clock fast-forwards past any distance. Measured, it cost 20 of the
149 tests: they died on the runner's timeout instead of on their own
assertions. So `src/io/io.ts` owns no chain; it exposes one turn,
`__ioPumpOnce()`, and whoever already drives this program's macrotasks calls it
— the harness settle loop today, a VM "before the loop blocks" hook in future.

**The real wait happens inside the native, and it has to.** The VM's macrotask
tier runs on a *virtual* clock that fast-forwards to the next due time instead
of sleeping (NUCLEUS §9a; a probe confirms it — `setTimeout(f, 50)` runs with
`Date.now()` one millisecond later than when it was armed). A pump written as
`setTimeout(pump, 20)` is therefore re-entered immediately, and a loop built on
timers alone would spin a core without giving the network any time at all. The
only real sleep available to this runtime is the one inside a native call,
which is where `ioPoll` puts it. Measured, an idle *referenced* server — one
that nothing connects to, with no timer armed — spends **31 ms of CPU over a 5 s
window, 0.6% of one core**.

That blocking slice is also what keeps the virtual clock honest. The VM
fast-forwards only when the next due macrotask is the one it would jump to;
while the pump is armed one millisecond out it is always next, so a pending
`setTimeout(f, 1000)` is not jumped past — it needs a thousand pump turns.
`__ioPollTimeout` therefore blocks one millisecond per turn whenever a ref'd
Node timer is armed, which keeps a thousand virtual milliseconds costing a
thousand real ones. Without it, a test's one-second failsafe would fire before
its socket could possibly have connected.

**`pause()` is real.** libuv's model is *completion*: a read is submitted and a
callback fires with the bytes, so pausing means cancelling something already in
flight. Readiness is the other way round — a paused socket simply stops
declaring read interest, so the peer's data stays in the kernel's receive
buffer and the TCP window closes. The events a test observes are the same
either way, and this side needs no bookkeeping to get it right.

## What the module covers

`../../src/net/net.ts` is `net` as Node exposes it: `Socket` as a
`stream.Duplex` whose `_read`/`_write`/`_final`/`_destroy` are the loop's
events, `Server` over one listening handle, `createServer`/`connect`/
`createConnection`, `isIP`/`isIPv4`/`isIPv6`, `BlockList`, `SocketAddress`, the
four `autoSelectFamily` accessors, `_normalizeArgs`, `readyState`,
`allowHalfOpen`, `setTimeout`/`setNoDelay`/`setKeepAlive`, `maxConnections`
with the `'drop'` event, `getConnections`, `resetAndDestroy` (a real abortive
close, `SO_LINGER { on, 0 }`), `ref`/`unref`, and `socket._handle` as an object
of libuv's `TCP`-wrap shape — because four files in this corpus *replace* a
method on it.

### Named gaps

- **No pipes / Unix domain sockets.** A pipe handle is a different kernel
  object with a different readiness story, and the loop has only the TCP half.
  `listen(path)` and `connect(path)` raise rather than pretending.
- **Name resolution blocks.** `ioLookup` is `getaddrinfo`, called
  synchronously, with the answer delivered through `process.nextTick` — the
  `dns` pattern. A `lookup` callback still runs on a later tick than its caller
  and `options.lookup` is still honoured, but two concurrent connects resolve
  one after the other.
- **Happy Eyeballs is sequential, not raced.** A name with both an A and an
  AAAA record gets the second address as a *fallback* when the first attempt
  fails, which is the observable half of `autoSelectFamily`; the attempt
  timeout is validated and reported but not used to overlap the two.
- **No `fd` adoption** (`new net.Socket({ fd })`, `listen({ fd })`): an fd may
  be a pipe, a tty or a socket, decided by `fstat`, and the loop has only the
  socket half.

## Why the rest fail

Of the 108 remaining, **31 are one engine defect** and 15 are a module this
library does not have yet. The table at the end names a blocker for every one.

### 1. `this` inside a listener is never the emitter (zun#1) — 31 tests

The single biggest blocker in the corpus, and it is one defect. Node calls an
event listener with the emitter as its receiver, and Node's own `net` tests use
that constantly:

```js
server.listen(0, common.mustCall(function() {
  const port = this.address().port;   // zun: TypeError, `this` is undefined
  ...
}));
```

`tools/harness/common.ts` already records the cause: a listener can only be
reached as `fn(...args)` here, because neither `apply` nor `call` threads a
receiver into a plain function value. What this corpus adds is a measurement of
the **other half** of that issue. The argument *shifting* the repository's notes
describe — `f.apply(recv, [a, b])` arriving as `f(recv, a)` — is **gone**:
`apply` and `call` now deliver the right arguments, they simply deliver no
`this`. And `Function.prototype.bind` does not exist at all. So the one
remaining piece is receiver threading, and fixing it alone would unblock this
whole group.

```js
// zun vs node
const target = { tag: 'RECEIVER' };
const fn = function (a, b) { console.log(this === undefined ? 'undefined' : this.tag, a, b); };
fn.call(target, 1, 2);        // zun: undefined 1 2        node: RECEIVER 1 2
fn.apply(target, [1, 2]);     // zun: undefined 1 2        node: RECEIVER 1 2
fn.bind(target)(1, 2);        // zun: bind is not a function   node: RECEIVER 1 2
```

### 2. A module this library does not have yet — 15 tests

They fail before the engine sees them, because the bundler cannot resolve the
`require`: `cluster` (six files, which test `listen(handle)` across workers),
`../common/dns` and `../common/internet` (six), `tls`, `../common/net` and
`../common/gc`.

### 3. Engine gaps in the *test bodies* — 9 tests

Eight are rejected at compile time by something in the test rather than in this
module: a `number` cannot be a Buffer size, offset or fill byte (zun#58),
`Buffer.from` of an `any` does not compile (zun#58 again), and spread into a
method call is not lowered (zun#92). One more reaches a `'data'` listener and
then cannot look at the chunk, because a byte view is opaque through an `any`
lane (zun#38): `chunk.length` reads `undefined` and `chunk.toString()` throws.
That is the same ceiling `zlib` and `fs` report, and it caps what *any*
byte-carrying module here can be measured on.

### 4. A `const` inside a function is invisible to a closure in its own initializer

A new engine defect this corpus found, and it blocks several files on its own,
because Node's tests are full of the shape it breaks:

```js
const client = net.connect(port, common.mustCall(() => client.write('ping')));
```

At module top level the self-reference works. Inside a function — which is
where every one of these lives, since the port is only known in the `listening`
listener — the closure gets a `ReferenceError`:

```js
// zun vs node
function make(cb) { return { tag: 'T', run: cb }; }
function outer() {
  const thing = make(function () { console.log('inner sees:', thing.tag); });
  console.log('outer sees:', thing.tag);   // both: T
  thing.run();                             // zun: ReferenceError   node: T
}
const top = make(function () { console.log('top inner sees:', top.tag); });
top.run();                                 // both: T
outer();
```

### 5. Pipes, `internalBinding` and the named gaps — 9 tests

Six files use `common.PIPE`, which is this module's documented gap; three reach
into `internalBinding('tcp_wrap')` under `--expose-internals` to drive paths
the public API cannot. `socket._handle` here has the shape those tests poke at
— that is why it is an object rather than the loop's handle number — but there
is no `internalBinding` to hand them the constructor.

### 6. Assertions this module does not yet satisfy — 10 tests

The honest remainder: the two `autoSelectFamily` attempt-timeout files (the
timeout is validated and reported but not used to overlap two attempts, because
the fallback is sequential), `test-net-normalize-args.js` (the array
`_normalizeArgs` answers is structurally right but not reference-equal to the
test's), `test-net-localerror.js` (whose expectation is `TypeError.name`, which
reads `undefined` here — zun#20), and seven others.

## Per-test table

| Test | Blocker |
|---|---|
| `test-net-access-byteswritten.js` | no `tls` in this library: the bundler cannot resolve the `require` |
| `test-net-allow-half-open.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-autoselectfamily-attempt-timeout-cli-option.js` | an assertion this module does not yet satisfy |
| `test-net-autoselectfamily-attempt-timeout-default-value.js` | an assertion this module does not yet satisfy |
| `test-net-autoselectfamily-commandline-option.js` | no `../common/dns` in this library: the bundler cannot resolve the `require` |
| `test-net-autoselectfamily-default.js` | no `../common/dns` in this library: the bundler cannot resolve the `require` |
| `test-net-autoselectfamily-ipv4first.js` | no `../common/dns` in this library: the bundler cannot resolve the `require` |
| `test-net-autoselectfamily.js` | no `../common/dns` in this library: the bundler cannot resolve the `require` |
| `test-net-better-error-messages-listen-path.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-better-error-messages-path.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-better-error-messages-port-hostname.js` | no `../common/dns, ../common/internet` in this library: the bundler cannot resolve the `require` |
| `test-net-binary.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-bind-twice.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-blocklist.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-buffersize.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-bytes-read.js` | zun#58 — a `number` cannot be a Buffer size, offset or fill byte, in the *test body* |
| `test-net-bytes-stats.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-bytes-written-large.js` | zun#58 — a `number` cannot be a Buffer size, offset or fill byte, in the *test body* |
| `test-net-can-reset-timeout.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-child-process-connect-reset.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-client-bind-twice.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-connect-buffer.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-connect-buffer2.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-connect-call-socket-connect.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-connect-custom-lookup-non-string-address.mjs` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-connect-immediate-destroy.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-connect-immediate-finish.js` | no `../common/dns, ../common/internet` in this library: the bundler cannot resolve the `require` |
| `test-net-connect-keepalive.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-connect-memleak.js` | no `../common/gc` in this library: the bundler cannot resolve the `require` |
| `test-net-connect-nodelay.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-connect-options-allowhalfopen.js` | zun#38 — the `Buffer` a `data` listener receives is opaque through `any` |
| `test-net-connect-options-ipv6.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-connect-options-path.js` | pipes / Unix sockets, a named gap of this module |
| `test-net-connect-options-port.js` | an assertion this module does not yet satisfy |
| `test-net-connect-paused-connection.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-connect-reset-before-connected.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-dns-custom-lookup.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-dns-lookup-skip.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-dns-lookup.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-during-close.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-eaddrinuse.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-end-close.js` | `internalBinding('tcp_wrap')`, which has no counterpart here |
| `test-net-end-destroyed.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-error-twice.js` | zun#58 — a `number` cannot be a Buffer size, offset or fill byte, in the *test body* |
| `test-net-keepalive.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-large-string.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-listen-close-server-callback-is-not-function.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-listen-exclusive-random-ports.js` | no `cluster` in this library: the bundler cannot resolve the `require` |
| `test-net-listen-fd0.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-listen-handle-in-cluster-1.js` | no `cluster` in this library: the bundler cannot resolve the `require` |
| `test-net-listen-handle-in-cluster-2.js` | no `cluster` in this library: the bundler cannot resolve the `require` |
| `test-net-listen-invalid-port.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-listen-ipv6only.js` | an assertion this module does not yet satisfy |
| `test-net-listen-twice.js` | no `cluster` in this library: the bundler cannot resolve the `require` |
| `test-net-local-address-port.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-localerror.js` | an assertion this module does not yet satisfy |
| `test-net-normalize-args.js` | an assertion this module does not yet satisfy |
| `test-net-onread-static-buffer.js` | zun#58 — `Buffer.from` of an `any` does not compile |
| `test-net-pause-resume-connecting.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-perf_hooks.js` | zun#92 — spread into a method call is not lowered |
| `test-net-persistent-keepalive.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-persistent-nodelay.js` | `internalBinding('tcp_wrap')`, which has no counterpart here |
| `test-net-persistent-ref-unref.js` | `internalBinding('tcp_wrap')`, which has no counterpart here |
| `test-net-pingpong.js` | pipes / Unix sockets, a named gap of this module |
| `test-net-pipe-connect-errors.js` | pipes / Unix sockets, a named gap of this module |
| `test-net-reconnect.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-remote-address-port.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-remote-address.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-reuseport.js` | no `../common/net` in this library: the bundler cannot resolve the `require` |
| `test-net-server-async-dispose.mjs` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-server-blocklist.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-server-call-listen-multiple-times.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-server-capture-rejection.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-server-close-before-ipc-response.js` | no `cluster` in this library: the bundler cannot resolve the `require` |
| `test-net-server-keepalive.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-server-listen-handle.js` | pipes / Unix sockets, a named gap of this module |
| `test-net-server-listen-options-signal.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-server-listen-options.js` | pipes / Unix sockets, a named gap of this module |
| `test-net-server-listen-path.js` | pipes / Unix sockets, a named gap of this module |
| `test-net-server-max-connections-close-makes-more-available.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-server-nodelay.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-server-pause-on-connect.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-server-try-ports.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-settimeout.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-socket-byteswritten.js` | an assertion this module does not yet satisfy |
| `test-net-socket-close-after-end.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-socket-connecting.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-socket-constructor.js` | no `cluster` in this library: the bundler cannot resolve the `require` |
| `test-net-socket-destroy-twice.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-socket-end-callback.js` | zun#92 — spread into a method call is not lowered |
| `test-net-socket-local-address.js` | an assertion this module does not yet satisfy |
| `test-net-socket-no-halfopen-enforcer.js` | an assertion this module does not yet satisfy |
| `test-net-socket-reset-twice.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-socket-setnodelay.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-socket-timeout-unref.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-socket-timeout.js` | an assertion this module does not yet satisfy |
| `test-net-socket-write-after-close.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-socket-write-error.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-stream.js` | zun#58 — a `number` cannot be a Buffer size, offset or fill byte, in the *test body* |
| `test-net-sync-cork.js` | zun#58 — a `number` cannot be a Buffer size, offset or fill byte, in the *test body* |
| `test-net-writable.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-write-after-close.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-write-after-end-nt.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-write-arguments.js` | an error raised where the test expects a different one (zun#8 prints only an address) |
| `test-net-write-connect-write.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-write-fully-async-buffer.js` | zun#58 — `Buffer.from` of an `any` does not compile |
| `test-net-write-fully-async-hex-string.js` | zun#1 — `this` inside a listener is never the emitter |
| `test-net-write-slow.js` | zun#58 — a `number` cannot be a Buffer size, offset or fill byte, in the *test body* |

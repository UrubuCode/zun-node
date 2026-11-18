# `dns` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-dns*.js` — 27 files,
listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded by
[`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* each failing test fails.

**22 / 27 passing (81.4%)**, measured on Windows with the release engine and the
worktree's own `zun_node.dll`.

`dns` is the kind `os` introduced: Zun TypeScript (`../../src/dns/dns.ts`) over
Rust natives (`../../src/dns/*.rs`), run as
`zun run --ext <lib> <bundle.ts>`. The module surface is complete — `lookup`,
`lookupService`, the fourteen `resolve*` entry points, `reverse`, both
`Resolver` classes with `cancel`/`setLocalAddress`/`get`/`setServers`,
`set`/`getDefaultResultOrder`, the twenty-four error-code constants, and the
same surface again under `node:dns/promises` — so the table below is almost
entirely about things outside it.

## Why the other 5 fail

None of the five is in this module.

| Test | Blocker |
|---|---|
| `test-dns.js` | **An accessor on an array index reads back as the engine's internal record** ([zun#132](https://github.com/UrubuCode/zun/issues/132)): the test defines a getter on `servers[2]` that truncates the array mid-walk, and `servers[2]` yields `{ __elemAcc: true, v: ... }` instead of the getter's string, so `validateString` rejects it. Holes in the array are handled (`setServers` skips them, as `ArrayPrototypeForEach` does). |
| `test-dns-channel-cancel.js` | `TypeError: apply is not a function`, raised inside `resolver.resolve4('example0.org', next)` where `next` is a rest-parameter arrow that spreads into a `common.mustCall` wrapper and is defined inside an `async` `mustCall` callback. Every smaller reduction of that shape runs correctly, so it is not yet isolated well enough for an engine issue; `test-dns-channel-cancel-promise.js` and `test-dns-cancel-reverse-lookup.js` cover the same `cancel()` path and pass. |
| `test-dns-lookup-promises.js` | **Arity is enforced on a plain function** — `function getaddrinfoPositive(addresses)` is called with two arguments and the checker rejects the program (`expects 0 to 1 argument(s), found 2`). |
| `test-dns-memory-error.js` | Needs named stack frames (`err.stack.split('\n')[1]` must match `/^ {4}at Object/`), which the engine does not produce. |
| `test-dns-perf_hooks.js` | **A spread into a method call is not lowered** (`entries.push(...items.getEntries())`). Behind it is a real gap: `dns` does not feed the performance timeline. |

## What moved the count from 6 to 22

* **The asynchronous transport** (below) — the nine fake-server files.
* **`tools/harness/dns.ts`**, a port of `test/common/dns.js`
  (`parseDNSPacket` / `writeDNSPacket` / `errorLookupMock`), registered in
  `tools/bundle_node_test.sh` as `../common/dns`. Its module object is a class
  instance, because a `Buffer` passed to a plain function stored in an
  object-literal property arrives without its `Buffer` identity.
* **The carrier escapes NUL and the separators.** A TXT chunk is arbitrary
  bytes; a NUL in one made the C-string return slot drop the whole payload.
* **`--dns-result-order`** is read from `NODE_OPTIONS` and the engine's option
  vector at load, and `tools/run_node_tests.sh` forwards that one flag from a
  test's `// Flags:` line through `NODE_OPTIONS` (the three `default-order`
  files).
* The engine fixes since the last measurement (a `mustCall` wrapper is now
  invokable by `Promise.prototype.then`) unblocked the six files that cause
  used to account for.

## Design notes worth knowing when reading the source

### The binding object is shaped like Node's on purpose

`__dnsCares` in `src/dns/dns.ts` is a deliberate copy of the *shape* of Node's
`internalBinding('cares_wrap')`: `getaddrinfo`, `getnameinfo`, `strerror`, the
`AI_*`/`DNS_ORDER_*` constants and a `ChannelWrap` whose `prototype` carries one
method per query type. Nine files in this corpus replace a method on that object
**before** requiring `dns`, which is the only way to drive the `ENOMEM` /
`ENOENT` / `EPERM` paths and the result shapes without a DNS server, and
`tools/harness/binding.ts` hands the object to
`require('internal/test/binding')`. Three mechanics make the replacement visible
where the engine would otherwise hide it:

* each `ChannelWrap.prototype` method is looked up **on every call**, so a
  prototype patch is seen (verified: a two-level plain-object patch table and a
  dynamic key both resolve correctly).
* the channel does not travel as `this`. It cannot: `__evCall` — the only
  spelling that can invoke a boxed harness wrapper — threads no receiver
  (zun#1), and a plain function assigned to an object property is called with
  `this === undefined` anyway. Every channel method is therefore a **closure
  over its channel**, and `__dnsChannelSlot` parks it for the duration of a
  `prototype` dispatch so the default implementations can read it back. The
  argument positions are Node's, which is what a replacing test observes.
* every completion is an **arrow closure over its request**, not Node's shared
  `function onlookup(err, addresses) { this.callback(…) }`. The corpus calls
  `req.oncomplete(err, addresses)` itself and gets that request's completion,
  which is the observable contract.

### Every user callback goes through `__evCall`

`common.mustCall()` returns a boxed callable (see cause 2), and `fn(1)` on one
throws `TypeError: f is not a function` while `fn(...args)` works. So each
`req.callback`, `req.resolve`, `req.reject`, `req.oncomplete`, channel method
and binding entry point is invoked as `__evCall(fn, [args])` — the house pattern
from `src/events/events.ts`. Five tests moved from failing to passing on that
change alone.

### The queries are asynchronous when the I/O loop is present

The original design was "synchronous natives, asynchronous API": `dnsQuery`
blocks and the result is delivered through `process.nextTick`. That cannot
serve a server living in the same process — nine files in the corpus answer
from their own `dgram` socket, and nothing runs while a native blocks.

So whenever `src/io/` is available (a bundle run with `--ext`), a query is sent
and received in `src/dns/dns.ts` over a non-blocking `node:io` datagram socket,
and only the wire format is native: `dnsEncodeQuery(name, rrtype)` and
`dnsDecodeResponse(base64, rrtype, id)` in `src/dns/resolve.rs`. This gives real
concurrency, a `cancel()` that completes in-flight queries with `ECANCELLED`
immediately (as `ares_cancel` does), and c-ares' schedule: each server is asked
`tries` times, attempt `n` waits `timeout * 2^n` ms capped at `maxTimeout`,
`timeout: -1` is 5 s. A truncated answer is re-asked over TCP through the
blocking native, against that one server. Without the extension the blocking
path remains.

### `isIP` and the `setServers` grammar are hand-written parsers

Node spells both as regular expressions. `test-dns.js` feeds `setServers`
`':'.repeat(100000)`, `'['.repeat(100000)` and
`'['.repeat(100000) + ']'.repeat(100000) + 'a'` as an explicit ReDoS check, so
every walk here is a single pass and cannot have that failure mode at all. The
accepted grammars are the regexes' own, including the `%zone` suffix Node's
IPv6 pattern allows.

## The natives

[`../../src/dns/mod.rs`](../../src/dns/mod.rs) documents the carrier (the
status-prefixed, separator-delimited string `node:os` fixed) and why a failed
call reports a *value* — a libuv errno from `getaddrinfo`, a c-ares code name
from a query — rather than a `SystemError`: `DNSException` switches on
`typeof code === 'number'`, so the two-shaped contract Node's module is written
against is kept instead of a third being invented.

The stub resolver is hand-written ([`../../src/dns/resolve.rs`](../../src/dns/resolve.rs)),
and the alternative was weighed: `hickory-resolver` in blocking mode still
brings a `tokio` reactor, `futures`, a TLS stack and some ninety transitive
crates, for a job that is one question per query, no cache, no DNSSEC and a
server list the caller owns because `dns.setServers()` is part of the API. RFC
1035 message format with §4.1.4 name decompression, over UDP with the §4.2.2
TCP retry on truncation, is a few hundred lines over `std::net` and no new
dependency. One deliberate divergence from c-ares: the retry budget is a single
`timeout × tries` deadline for the whole server list rather than per server, so
an unreachable network costs 20 s on a three-resolver machine instead of 60.

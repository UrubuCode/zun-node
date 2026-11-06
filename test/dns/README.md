# `dns` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-dns*.js` — 27 files,
listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded by
[`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) rather than
vendored. The per-test run of the last measurement is
[`RESULTS.md`](RESULTS.md); this file says *why* each failing test fails.

**6 / 27 passing (22.2%)**, measured on Windows with the release engine at
`c4afcca4` and the worktree's own `zun_node.dll`.

`dns` is the kind `os` introduced: Zun TypeScript (`../../src/dns/dns.ts`) over
Rust natives (`../../src/dns/*.rs`), run as
`zun run --ext <lib> <bundle.ts>`. The module surface is complete — `lookup`,
`lookupService`, the fourteen `resolve*` entry points, `reverse`, both
`Resolver` classes with `cancel`/`setLocalAddress`/`get`/`setServers`,
`set`/`getDefaultResultOrder`, the twenty-four error-code constants, and the
same surface again under `node:dns/promises` — so the table below is almost
entirely about things outside it.

## Why the other 21 fail

Three causes account for eighteen of them, and none is in this module.

### 1. `node:dgram` does not exist yet (9 tests)

Nine files in the corpus stand up a **fake DNS server** with
`dgram.createSocket('udp4')`, point `dns.setServers()` at it, and assert on
hand-assembled DNS packets through `test/common/dns.js`. That is the right way
to test a resolver without a network, and it is how the whole `resolveAny`,
`cancel`, channel-timeout and multi-channel surface is covered. There is no
`node:dgram` in this library, so the bundler reports an unresolved `require`
before the engine sees the test. Nothing in `src/dns/` is implicated: the wire
format those tests exercise is covered by 21 Rust tests in
[`../../src/dns/tests.rs`](../../src/dns/tests.rs) instead, driven from
hand-assembled messages in exactly the same way.

### 2. A function value loses its callability across a dynamic call (6 tests)

This is one engine defect, and it is the single largest blocker in the corpus —
not only here. The repository already records half of it (see the `stream`
section of the top-level README: "a `functionBox` handed to
`Promise.prototype.then` is silently never called"); what this corpus adds is
*where the value goes wrong*, and that a fix path exists.

A function value **returned across a dynamic call boundary**
comes back as something that is no longer a function: returned from an
object-literal method it reports `typeof === "object"`, and the boxing
workaround `tools/harness/common.ts` applies (`[fn][0]`, zun#17) keeps
`typeof === "function"` but produces a callable that the engine's
`Promise.prototype.then` **silently will not invoke**.

`common.mustCall()` is an object-literal method on the harness's `common`
object, so *every* `.then(common.mustCall(...))` in Node's corpus registers an
expectation that can never be met, and the test fails on the call count with
every assertion in it having passed.

```js
// zun vs node — run with tools/bundle_node_test.sh
function makeTop(tag) { return function () { console.log(tag); }; }
const asMethod = { make(tag) { return function () { console.log(tag); }; } };
const asProp = { make: makeTop };
const boxed = { make(tag) { return [function () { console.log(tag); }][0]; } };

const a = makeTop('TOP');          // zun: typeof "function"   node: "function"
const b = asMethod.make('METHOD'); // zun: typeof "object"     node: "function"
const c = asProp.make('PROP');     // zun: typeof "object"     node: "function"
const d = boxed.make('BOXED');     // zun: typeof "function"   node: "function"

Promise.resolve().then(a);   // zun: runs     node: runs
Promise.resolve().then(b);   // zun: SILENT   node: runs
Promise.resolve().then(c);   // zun: SILENT   node: runs
Promise.resolve().then(d);   // zun: SILENT   node: runs
d();                         // zun: runs     node: runs
```

Two facts narrow it down. The value is callable *directly* (`d()` works, and so
does `d(...args)`) — it is only the `then` intrinsic that refuses it. And a
**class** method's return does not degrade at all:

```js
class C { make(tag) { return function () { console.log(tag); }; } }
const e = new C().make('CLASS');  // zun: typeof "function"
Promise.resolve().then(e);        // zun: runs
```

So the degradation is specific to a call whose callee was read from an
`any`-typed object, and the fix is likely the same path that already works for
a class method. Until then the six tests below are unreachable, and a harness
whose `common` object became a class instance would unblock the same pattern
across every module's corpus.

Code site: the call-return lowering in `crates/zun_interp` (read-only here),
together with `Promise.prototype.then`'s callee check — the `then` intrinsic
accepts a plain function and a locally boxed one but not the degraded value.

### 3. `--dns-result-order` is a CLI flag the engine has no equivalent of (3 tests)

`test-dns-default-order-{ipv4,ipv6,verbatim}.js` each open with
`// Flags: --dns-result-order=…` and assert that `dns.lookup` passes the
matching `DNS_ORDER_*` to the binding. The flag seeds Node's module-level
`dnsOrder` before any user code runs; neither the engine nor
`tools/run_node_tests.sh` has a way to deliver it, so the default
(`verbatim`) is what the module starts with and the assertion fails on the
first `checkParameter`. `dns.setDefaultResultOrder()` — the programmatic half of
the same knob — is implemented and is what `test-dns-set-default-order.js`
exercises (that file is blocked by cause 2 instead).

### The remaining three

| Test | Blocker |
|---|---|
| `test-dns-lookup-promises.js` | **Arity is enforced on a plain function** — the test declares `function getaddrinfoPositive(addresses)` and calls it as `getaddrinfoPositive(['127.0.0.1'], { family: 4 })`; the checker rejects the program with `'getaddrinfoPositive' expects 0 to 1 argument(s), found 2`, where JavaScript ignores the extra argument. Every assertion in the file is about this module's result shapes, so it would otherwise be a strong test of them. |
| `test-dns-memory-error.js` | **`new <object>.Ctor()` does not reach a constructor** ([zun#18](https://github.com/UrubuCode/zun/issues/18)): the test does `new errors.DNSException(UV_EAI_MEMORY, 'fhqwhgads')` through the `internal/errors` module object. It then asserts on `err.stack.split('\n')[1]`, which needs named stack frames the engine does not produce either. |
| `test-dns-perf_hooks.js` | **A spread into a method call is not lowered**: `entries.push(...items.getEntries())`. Behind that there is also a real gap — `src/dns/dns.ts` does not feed the performance timeline, because `src/perf_hooks/perf_hooks.ts` has no `startPerf`/`stopPerf` seam and both files are *conditional*, so `dns` cannot name a symbol that may be absent from its bundle. Wiring the two would need a seam in `perf_hooks` that is more than a localized change. |

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

### The queries are synchronous

ABI v1 gives an extension no way to complete a call later: there is no handle
the host could poll and no callback it could be given. Every native blocks, and
the *observable* asynchrony is restored on the TypeScript side — a resolution is
delivered through `process.nextTick`, so a callback runs on a later tick than
its caller and a `Resolver` has a real pending-query window for `setServers` to
refuse (which is exactly what `test-dns-setserver-when-querying.js` asserts, and
it passes). What is not restored is concurrency: two queries issued back to back
run one after the other.

### `isIP` and the `setServers` grammar are hand-written parsers

Node spells both as regular expressions. `test-dns.js` feeds `setServers`
`':'.repeat(100000)`, `'['.repeat(100000)` and
`'['.repeat(100000) + ']'.repeat(100000) + 'a'` as an explicit ReDoS check, so
every walk here is a single pass and cannot have that failure mode at all. The
accepted grammars are the regexes' own, including the `%zone` suffix Node's
IPv6 pattern allows.

### Known divergence: a sparse `servers` array

Node's `setServers` iterates with `ArrayPrototypeForEach`, which skips holes, so
`servers[0] = a; servers[2] = b` yields two entries. This implementation walks
`0 … length - 1`, so a hole is an `undefined` element and
`validateString(undefined, 'servers[1]')` throws. Only `test-dns.js` exercises
it (it also defines an index as a *getter* that truncates the array mid-walk),
and that file is blocked on `node:dgram` regardless.

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

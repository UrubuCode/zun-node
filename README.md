# zun-node

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform. See [`PLAN.md`](PLAN.md) for the architecture and the library roadmap.

## Three kinds of module

A Node module lands here in whichever form fits what it actually does:

- **Native extension modules** — a Rust `cdylib` that exports `zun_register_v1`
  and publishes its functions through the stable `zun_abi` contract. This is for
  modules that need the operating system: `fs` (`src/fs/`) needs syscalls, so it
  is Rust and is loaded with `zun run --ext <lib>`.
- **Zun TypeScript modules** — written in the language the platform compiles, and
  run by the engine like any other program. This is for modules that are pure
  computation: `path` (`src/path/path.ts`) is string manipulation end to end, so
  there is nothing to gain from crossing the ABI, and no `--ext` is involved.
  `querystring` (`src/querystring/querystring.ts`), `punycode`
  (`src/punycode/punycode.ts`) and `url` (`src/url/url.ts`) are the same kind;
  `url` stands on the other two plus `path`, and re-exports the engine's
  prelude `URL`/`URLSearchParams`, which is the relationship `node:url` has with
  the globals in Node. `stream` (`src/stream/stream.ts`) is the largest of
  them: pure computation over `events`, `process.nextTick`, the global `Buffer`
  and `string_decoder` — exactly the dependency set `lib/internal/streams/*`
  has.
- **Zun TypeScript over natives** — both, with the seam drawn where the
  capability changes. `os` is the first: the facts it reports are syscalls
  (`src/os/`, Rust), while the module *Node* exposes is objects, arrays,
  `constants`, validation and `ERR_*` errors (`src/os/os.ts`, Zun TypeScript),
  which reaches the natives with `import * as native from "node:os"`. Its tests
  are bundled like a TypeScript module **and** run with `--ext`. This is the
  shape `fs` takes once its Node-API shaping is written, which is why `os`
  establishes it: ABI v1 carries one scalar word per value, so `os` also fixes
  how a structured result crosses — one status-prefixed, separator-delimited
  string per call, documented in [`src/os/mod.rs`](src/os/mod.rs).

Support slices exist to run Node's own tests, and are Zun TypeScript for the
same reason: `src/assert/assert.ts` (the strict-mode `assert` surface the tests
assert with) and `src/process/process.ts` (`cwd()`, `env`, `platform`, and —
because Node's `process` is an EventEmitter —
`on`/`emit`/`nextTick`/`emitWarning`). `src/util/util.ts` used to be one of them;
it is now a module in its own right, and `assert` stands on it rather than
carrying its own copy of `inspect` and `deepStrictEqual`.

## Compatibility

The bar is **Node.js 25's own test suite**, not tests written here. The workflow
[`.github/workflows/node-compat.yml`](.github/workflows/node-compat.yml)
**downloads** the Node `test/parallel/test-<module>*.js` files at a pinned tag,
runs each through the Zun engine
([`tools/run_node_tests.sh`](tools/run_node_tests.sh)), and reports the share that
passes. The percentages below are that measurement — they climb as the library
grows.

The `util`, `path`, `events` and `os` numbers below were last regenerated on **Windows**
(the CI workflow runs on `ubuntu-latest`). One test differs between the two:
`test-os-process-priority.js` passes on Linux and fails on Windows
([zun#34](https://github.com/UrubuCode/zun/issues/34)), while
`test-path-win32-normalize-device-names.js` is only a real signal on Windows,
where it passes — on Linux it `common.skip`s, which the harness scores as a
pass. So `os` reads 1/7 here, and should read 2/7 on Linux once CI runs again —
`test-os-eol.js`'s fix is platform-independent and
`test-os-process-priority.js` already passed there.

Because the engine has no CommonJS `require` or module resolution
([zun#4](https://github.com/UrubuCode/zun/issues/4)), a Zun TypeScript module's
tests are first passed through
[`tools/bundle_node_test.sh`](tools/bundle_node_test.sh), which inlines the
util/events/process/assert/path/querystring/punycode/url modules, the modules
the test actually requires (`os`, `buffer`, `string_decoder`, `stream`) and the
`common` harness (plus `node:test` when the test requires it) ahead of the test body,
rewrites its `require` lines to the one object each
inlined module exposes (`__node_events`, `__node_assert`, …), and appends the
statement that settles the event loop and verifies the `common.mustCall` counts;
the resulting single file runs as `zun run <bundle.ts>`. Extension modules keep
the direct `zun run --ext <lib> <test.js>` path.

<!-- node-fs:start -->
### Node.js v25 `fs` compatibility

`░░░░░░░░░░░░░░░░░░░░░░░░` **0.0%** — 0 / 227 Node `test-fs-*` tests passing
<!-- node-fs:end -->

> The `fs` number is near zero by design: running Node's `fs` tests needs the
> Node-API shaping over the low-level extension functions (Buffers, file
> descriptors, callbacks and promises, a full `Stats`), `node:test`, and the
> `test/fixtures/` tree. Those are the next work; this number is how we watch it
> land. Per-test breakdown: [`test/fs/RESULTS.md`](test/fs/RESULTS.md).

<!-- node-util:start -->
### Node.js v25 `util` compatibility

`██████░░░░░░░░░░░░░░░░░░` **26.9%** — 7 / 26 Node `test-util*` tests passing
<!-- node-util:end -->

> `util` is implemented end to end — `inspect` with every option Node documents
> (including the Node 25 regular-expression depth highlighter and the
> `compact`/`breakLength` line-breaking algorithm), `format`/`formatWithOptions`,
> `isDeepStrictEqual`, `promisify`, `callbackify`, `deprecate`, `debuglog`,
> `types`, `styleText`, `stripVTControlCharacters`, `parseArgs`, `parseEnv`,
> `MIMEType`, the `getSystemError*` trio over libuv's 85-row table, and the abort
> helpers. It was taken before `stream` because `stream` cannot be written
> without it, and because `assert` now formats its messages with `util.inspect`
> and compares with `util.isDeepStrictEqual`, the way Node's `assert` does.
> **No remaining failure is in `util.ts`**: eleven of the nineteen need a
> harness module that does not exist (`vm`, `v8`, `worker_threads`, `url`,
> `node:fs`, `child_process`, `internal/test/binding`, `internal/errors`), and
> the other eight are engine gaps — four of them found by this work: typed arrays
> and `ArrayBuffer` are completely opaque through an `any` lane, a symbol's
> `description` panics the interpreter there, assigning to a built-in namespace
> member (`Object.keys = fn`) panics, and a regex literal with a duplicate named
> capture group is rejected although ES2025 and Node 25 accept it — that last one
> is the *only* thing standing between
> `test-util-inspect-regexp.js` and a pass, since all ~100 of its colour
> expectations match byte for byte without it. All four were re-probed against
> this engine build and all four still hold. One of the eight changed shape:
> accessors **are** reflectable now (a class or object-literal accessor's
> descriptor carries working `get`/`set` slots), but
> `desc.get.apply(obj, [])` aborts the interpreter and `apply` threads no
> receiver, so `getters: true` still cannot invoke a getter that reads `this` —
> which is what `test-util-inspect-getters-accessing-this.js` is about. The
> blocker-by-blocker table is in
> [`test/util/README.md`](test/util/README.md), the per-test breakdown in
> [`test/util/RESULTS.md`](test/util/RESULTS.md).
>
> One `inspect` bug came out of this engine update and is fixed here: a
> `functionBox` record reports `typeof === "function"` now rather than
> `"object"`, so the unwrap guard stopped opening it — and because a box is
> tagged `[object Object]` exactly like a class, every ordinary function reached
> through an array, an object property or an `any` lane printed as
> `[class (anonymous)]`. Functions print `[Function (anonymous)]` again
> (`[Function: name]` waits on
> [zun#25](https://github.com/UrubuCode/zun/issues/25)) and classes print
> `[class Foo]`. A second one came for free: a function-valued property is
> visible to `Object.keys` now, so `inspect({ fn() {} })` is
> `{ fn: [Function (anonymous)] }` rather than `{}`.

<!-- node-path:start -->
### Node.js v25 `path` compatibility

`█████████████████████░░░` **88.2%** — 15 / 17 Node `test-path*` tests passing
<!-- node-path:end -->

> `path` already runs the whole Node corpus, so its number is a real measurement.
> Every test still failing is blocked in the **engine**, not in `path.ts` — the
> blocking table is in [`test/path/README.md`](test/path/README.md), the per-test
> breakdown with a failure note for each in
> [`test/path/RESULTS.md`](test/path/RESULTS.md).
> `test-path-parse-format.js` passes now: it needed a value that is callable
> *and* carries `strictEqual` & co., and a function can carry callable
> properties ([zun#14](https://github.com/UrubuCode/zun/issues/14) is closed), so
> `assert.ts` is a real function with the methods attached. The two that remain
> are `test-path-join.js` — a function taken out of an array has no `apply` on
> it, and `map(JSON.stringify)` aborts the VM
> ([zun#17](https://github.com/UrubuCode/zun/issues/17); its `concat` blocker,
> [#16](https://github.com/UrubuCode/zun/issues/16), is closed) — and
> `test-path-resolve.js`, which adds a Windows-only `child_process.spawnSync`.

<!-- node-events:start -->
### Node.js v25 `events` compatibility

`████████░░░░░░░░░░░░░░░░` **34.2%** — 12 / 35 Node `test-event-emitter-*|test-events-*` tests passing
<!-- node-events:end -->

> `events` is implemented end to end — the whole `EventEmitter` surface plus every
> module static — and the number is low because the *tests* reach for engine
> features that do not exist yet, not because the module is thin. Nine of the
> thirty-five files open with `new events.EventEmitter()`, which still does not
> work: it compiles now, but the member read answers `undefined` at run time
> ([zun#18](https://github.com/UrubuCode/zun/issues/18), with
> [#20](https://github.com/UrubuCode/zun/issues/20) behind it). Three more
> need a class static that shares a name with an instance method
> (`EventEmitter.once`, `EventEmitter.listenerCount` — still ``duplicate method
> `once` ``; the value-shaped statics `defaultMaxListeners` and `errorMonitor`
> *are* reachable and are real statics in `events.ts`), five need a bound `this`
> inside a listener ([zun#1](https://github.com/UrubuCode/zun/issues/1) —
> `apply`/`call` thread no receiver into a function value, and `apply` shifts its
> arguments there), and three require Node's `internal/event_target`.
> `test-event-emitter-special-event-names.js` passes, and it is the one that
> keeps the storage layer honest: `_events` is a real null-prototype object, so
> an event named `toString`, `__defineGetter__` or `__proto__` is an ordinary
> key — which needs both of the engine regressions this update introduced to be
> compensated (a computed read with a variable key resolves `Object.prototype`'s
> members on a null-prototype object, and `events.__proto__ = value` sets the
> prototype instead of creating an own property). The one file now standing on a
> single line is `test-event-emitter-listeners-side-effects.js`:
> `Object.create(null) instanceof Object` answers `true`
> ([zun#26](https://github.com/UrubuCode/zun/issues/26)).
>
> Six more files came in with `stream`, and none of them needed a line of
> `events.ts`: the bundler learned to collapse a **renamed alias** of a
> canonical binding — `const { EventEmitter: EE } = require('events')` and
> `const EE = require('events').EventEmitter;` both leave `EE` bound to the
> class now — because a class base must be the original class's own identifier
> ([zun#21](https://github.com/UrubuCode/zun/issues/21)) and `new EE()` over a
> class *value* answers `undefined` at run time. A seventh came from the
> coded-error bases printing their `code` in `String(err)` the way Node's do,
> which is what `assert.throws(fn, /ERR_SOMETHING/)` matches against. The full
> blocker-by-blocker table is in [`test/events/README.md`](test/events/README.md),
> the per-test breakdown in [`test/events/RESULTS.md`](test/events/RESULTS.md).

<!-- node-os:start -->
### Node.js v25 `os` compatibility

`███░░░░░░░░░░░░░░░░░░░░░` **14.2%** — 1 / 7 Node `test-os*` tests passing
<!-- node-os:end -->

> `os` is complete — every function, `constants` for both platforms, `EOL`,
> `devNull`, the validation and the `ERR_SYSTEM_ERROR` shape — and verified by a
> differential run against Node over 140 values (every string fact, the whole
> `constants` table, every CPU row, every interface entry with its CIDR and
> scope id, `userInfo()` in both encodings, all eight validation messages and
> every `tmpdir()` environment rule): **zero divergences on Windows and zero on
> Linux**. The corpus number is low because the seven test files are unusually
> harness-hungry: two require `internal/test/binding` to monkey-patch the `os`
> binding, two re-run themselves through `child_process` to see a different
> environment, and `test-os.js` asserts `` `${os.hostname}` === os.hostname() ``
> for ten getters — template interpolation of a function value ignores the
> function's own `Symbol.toPrimitive`/`toString`/`valueOf` and yields the literal
> `[function]` ([zun#36](https://github.com/UrubuCode/zun/issues/36)). That file
> used to be blocked ahead of #36 by needing a callable `assert`
> ([zun#14](https://github.com/UrubuCode/zun/issues/14), now closed — `assert.ts`
> is a real function carrying the methods), so its own `is` helper runs now and
> #36 is all that is left.
> `test-os-eol.js` passes: `assert.throws(fn, TypeError)` with the constructor as
> a *value* works now, because `assert.ts` matches the standard error
> constructors by identity and spells the `instanceof` against the literal class
> ([zun#17](https://github.com/UrubuCode/zun/issues/17) still leaves a
> constructor value with no `.name` and unusable on the right of an
> `instanceof`). `test-os-process-priority.js` passes on Linux but not on
> Windows, where it needs a top-level destructuring declaration to be visible to
> a function body ([zun#34](https://github.com/UrubuCode/zun/issues/34)) — the
> number above was measured on Windows. The blocker-by-blocker table is in
> [`test/os/README.md`](test/os/README.md), the per-test breakdown in
> [`test/os/RESULTS.md`](test/os/RESULTS.md).

<!-- node-buffer:start -->
### Node.js v25 `buffer` compatibility

`░░░░░░░░░░░░░░░░░░░░░░░░` **1.5%** — 1 / 64 Node `test-buffer*` tests passing
<!-- node-buffer:end -->

> `buffer` is the first module whose central object is **the engine's**, not
> this library's: Node's `Buffer` is a `Uint8Array` subclass, and Zun's is a
> nominal alias for the `Uint8Array` byte-view floor — a realm global with its
> statics recognised by receiver name in the checker and its instance methods
> lowered to the `nodeBuffer` intrinsics (NUCLEUS #21). Node's `buffer.Buffer`
> and `globalThis.Buffer` are the same object, so `src/buffer/buffer.ts` is the
> module *surface* around that global and never a second Buffer: `Buffer` is
> this module's canonical binding in the bundler, the way `EventEmitter` is
> `events`'. That surface is complete — `kMaxLength`, `kStringMaxLength`,
> `constants`, `INSPECT_MAX_BYTES`, a strict WHATWG `atob`/`btoa`, `isUtf8`,
> `isAscii`, `transcode`, `Blob`, `File`, `resolveObjectURL` (there is no
> `SlowBuffer`: Node removed it in v25). The number is low because **every
> remaining failure is an engine gap**, and the biggest one is a single rule:
> the `nodeBuffer` intrinsics take machine integers, so a plain `number` is
> rejected at the call site (`Buffer.alloc(n)` where `n` is a parameter does not
> compile), which costs 28 of the 64 tests on their first line. Behind it:
> `compare`/`toJSON`/`entries`/`buffer`/`byteOffset`/`parent`/`isEncoding`/`of`/
> `allocUnsafeSlow` are absent and absent *at compile time*, a byte view is
> opaque through `any`, `util.inspect` of one prints `{}`, and — the serious one
> — **the GC frees a live Buffer's backing `ArrayBuffer`**, reproducibly on the
> 256th class instance, because a view object carries type RID 0 and the mark
> phase has no reference slots for it. The four historical Buffer CVEs were
> checked one by one; two are unreachable rather than fixed, one (UCS-2 `write`
> near the end) writes a *partial code unit* though never past the end, and a
> fifth hazard turned up: `Buffer.alloc(-1)` panics the interpreter. The
> per-test blocker table, with a standalone repro for each group, is in
> [`test/buffer/README.md`](test/buffer/README.md); the per-test breakdown in
> [`test/buffer/RESULTS.md`](test/buffer/RESULTS.md).

<!-- node-string_decoder:start -->
### Node.js v25 `string_decoder` compatibility

`░░░░░░░░░░░░░░░░░░░░░░░░` **0.0%** — 0 / 3 Node `test-string-decoder*` tests passing
<!-- node-string_decoder:end -->

> `StringDecoder` is implemented end to end over the global `Buffer` —
> `write`, `end`, `text`, `lastChar`/`lastNeed`/`lastTotal`, for utf8, utf16le,
> ucs2, base64, base64url, hex, latin1 and ascii — following Node's own
> pure-JavaScript decoder (there is no `internalBinding('string_decoder')` to
> wrap), with the two places Node 25's C++ decoder diverges from it handled: one
> U+FFFD per *maximal subpart* of an aborted sequence, and Node 25's shape for
> the legacy `text(buf, offset)`. Since all three corpus files fail to compile,
> it is verified the way `os` is — a **differential run against Node** over
> `test-string-decoder.js`'s own driver (33 byte sequences × every possible
> split across successive `write()` calls × 8 encodings = **1216 cases**,
> including every invalid-UTF-8 vector in the file and both nodejs/node#22626
> regressions) plus all 32 `testEnd` vectors of
> `test-string-decoder-end.js`: **zero divergences**. The three failures are
> `Buffer.from`/`Buffer.of` with an `any` argument, `Math.random`, and a
> function called with one more argument than it declares — all engine gaps,
> none of them in the decoder. Table in
> [`test/string_decoder/README.md`](test/string_decoder/README.md), breakdown in
> [`test/string_decoder/RESULTS.md`](test/string_decoder/RESULTS.md).

<!-- node-querystring:start -->
### Node.js v25 `querystring` compatibility

`████████████░░░░░░░░░░░░` **50.0%** — 2 / 4 Node `test-querystring*` tests passing
<!-- node-querystring:end -->

> `querystring` is implemented end to end — `parse`/`decode`, `stringify`/`encode`,
> `escape`, `unescape`, `unescapeBuffer`, `maxKeys`, custom `sep`/`eq` of any
> length, and the `decodeURIComponent`/`encodeURIComponent` options — following
> Node's own scanner instruction for instruction, including the quirks its tests
> pin (which empty segment spends a `maxKeys` slot, that `parse('a=b', [])`
> drops the value, that `escape` consumes the code unit after a high surrogate
> and masks it). Results are null-prototype objects, so a `__proto__=1` query
> yields an own key (through `Object.defineProperty`, because
> [zun#47](https://github.com/UrubuCode/zun/issues/47) makes a plain
> `__proto__` assignment rewrite the prototype instead) and never reaches
> `Object.prototype`, and nothing in the
> module builds a RegExp — which is the structural reason `querystring` has no
> CVEs of its own in Node's history. The two failures are not in
> `querystring.ts`: both of Node's remaining files open their `check()` with the
> bare callable form `assert(!(actual instanceof Object))`, which needs an
> `assert` that is a function *and* carries methods
> ([zun#14](https://github.com/UrubuCode/zun/issues/14)) and an `instanceof
> Object` that answers `false` for a null-prototype object
> ([zun#26](https://github.com/UrubuCode/zun/issues/26)); `test-querystring.js`
> additionally needs a second realm (`vm.runInNewContext`). The blocker table is
> in [`test/querystring/README.md`](test/querystring/README.md), the per-test
> breakdown in [`test/querystring/RESULTS.md`](test/querystring/RESULTS.md).

<!-- node-punycode:start -->
### Node.js v25 `punycode` compatibility

`████████████████████████` **100.0%** — 1 / 1 Node `test-punycode*` tests passing
<!-- node-punycode:end -->

> `punycode` passes its whole corpus: `encode`, `decode`, `toASCII`,
> `toUnicode`, `ucs2.decode`/`ucs2.encode` and `version`, verified against all
> nineteen RFC 3492 test vectors plus the surrogate and email-address cases, and
> the DEP0040 deprecation warning that Node emits when the module is required —
> which is why the `process.emitWarning` call lives in its own
> `src/punycode/deprecation.ts`, inlined by the bundler only for a test that
> actually requires `punycode` (`src/url/url.ts` uses the algorithms without
> being a `punycode` require). Getting there needed `assert.throws(fn, regexp)`
> fixed to match `String(err)` the way Node's does, and the Bootstring state
> variables annotated `number`: a conditional whose branches mix an
> integer-typed constant with a float-typed expression yields an `Any`, and
> passing that to a `number` parameter panics the interpreter (new bug, found by
> this work). Details in [`test/punycode/README.md`](test/punycode/README.md).

<!-- node-url:start -->
### Node.js v25 `url` compatibility

`█████████░░░░░░░░░░░░░░░` **41.1%** — 7 / 17 Node `test-url*` tests passing
<!-- node-url:end -->

> `url` is implemented end to end — the legacy `parse` (with `parseQueryString`
> and `slashesDenoteHost`), `format` (string, object and `URL` forms, plus
> `format(URL, options)`), `resolve`, `resolveObject` and the `Url` class, the
> WHATWG re-exports, `domainToASCII`/`domainToUnicode`,
> `fileURLToPath`/`pathToFileURL` for both platforms, and `urlToHttpOptions` —
> following Node's `lib/url.js` and `lib/internal/url.js` instruction for
> instruction, because `url.parse` is explicitly not standardized (that is what
> DEP0169 says) and its behaviour simply *is* that code. Every CVE guard is
> reproduced rather than simplified: the scheme is lower-cased before any
> protocol-set decision (CVE-2018-12123), the hostname is re-checked against the
> forbidden set **after** IDNA so a NUL can neither be accepted nor truncated
> away (the CVE-2026-48930 class), an empty post-IDNA hostname throws
> `ERR_INVALID_URL`, and `parse(url, true)` hands back a null-prototype query.
> Node's eight regular expressions here are eight hand-written scans, so the
> parser owns no backtracking engine. Because four of the seventeen files are
> ICU skips and two cannot be expressed on this engine at all, the module was
> checked directly against Node's own expectation tables: 89 `parseTests` cases
> (all twelve fields, the whitespace-trimmed re-parse and `format(expected)`),
> 29 `formatTests` cases in both their string and object forms, all 194
> `relativeTests2` and 31 `relativeTests` resolve cases, and the 51
> `pathToFileURL` / 43 `fileURLToPath` cases with their error paths — 447 of
> Node's own expectation rows and 1 695 individual comparisons, **zero
> divergences**. `test-url-relative.js` therefore fails on the
> engine, not on `url.ts`: the run corrupts a long-lived array of strings after
> roughly 250 `url.parse` calls (new engine bug, reported with this work). The rest are the prelude `URL`'s own limits
> (`new URL('file:///C:/foo')` throws there, so `pathToFileURL` builds its
> `URL` instances from components instead), `URLPattern` (a separate WHATWG
> specification Node implements in C++, and unreachable from a test here in any
> case), a callable `assert`, `new` on a member expression, `child_process` and
> spread into a built-in. The blocker-by-blocker table is in
> [`test/url/README.md`](test/url/README.md), the per-test breakdown in
> [`test/url/RESULTS.md`](test/url/RESULTS.md).

<!-- node-stream:start -->
### Node.js v25 `stream` compatibility

`████████░░░░░░░░░░░░░░░░` **33.3%** — 68 / 204 Node `test-stream-*|test-stream2-*|test-stream3-*|test-streams-*|test-readable-*` tests passing
<!-- node-stream:end -->

> `stream` is the largest module here by a wide margin — 204 Node files against
> `src/stream/stream.ts` — and it is implemented end to end: `Stream` with the
> legacy `pipe`, `Readable` (flowing and paused modes, `read`, `push`,
> `unshift`, `setEncoding` over `string_decoder`, `pipe`/`unpipe` with the
> `awaitDrainWriters` set, backpressure, objectMode, `destroy`, async
> iteration, `Readable.from`, `wrap`), `Writable`
> (`write`/`end`/`cork`/`uncork`, `_writev` batching, `_final`, `drain`),
> `Duplex` (+ `Duplex.from` in all seven shapes), `Transform`, `PassThrough`,
> `pipeline` in both forms, `finished`, `addAbortSignal`, `compose`, `destroy`,
> `duplexPair`, the `is*` predicates, the default-high-water-mark pair,
> `stream/promises`, and all eleven async operators. The state machines are
> Node's `lib/internal/streams/*.js` transcribed instruction for instruction,
> because which of `'end'`, `'finish'`, `'close'`, `'error'` and `'drain'`
> fires in which `process.nextTick` turn is pinned by this corpus and derivable
> from nothing else — Node 25's bit-packed `kState` is plain properties here
> only because the tests read two dozen state fields straight off the state
> object. Since most of the corpus is blocked before its first assertion, the
> module is verified the way `os`, `string_decoder` and `url` are: **two
> differential runs against Node** over 46 scenarios — the event order of every
> class, the whole error matrix, `cork`/`_writev`, the option flags, `read(n)`
> slicing, every operator, async iteration, `pipeline`, `compose`,
> `duplexPair`, `addAbortSignal` — with **one divergence**, an interleaving
> between two *independent* streams rather than a reordering inside one. Three
> real bugs came out of those runs rather than out of the corpus, which is the
> point of them.
>
> Two shapes the engine forces, both argued at the top of the file. The two
> states are **plain objects**, because a function assigned to a class *field*
> stops being callable (a new engine bug, one of five found here) and
> `onwrite`, the eight option hooks and the parked Transform callback are all
> functions. And the eight overridable hooks (`_read`, `_write`, `_writev`,
> `_final`, `_destroy`, `_construct`, `_transform`, `_flush`) are **accessor
> pairs over `state.fns`** rather than methods: 51 of the 204 files assign a
> hook onto an instance and 26 subclass, a class member cannot be both, and the
> "is there an implementation?" question cannot be asked without making the
> call — so the dispatchers make it and read the engine's own
> `TypeError: _read is not a function` as the answer. One deliberate deviation:
> a byte-mode **string** chunk stays a string instead of becoming a Buffer,
> because `Buffer.from` rejects an `any`
> ([zun#58](https://github.com/UrubuCode/zun/issues/58)), a view is opaque
> through one ([zun#38](https://github.com/UrubuCode/zun/issues/38)) and the GC
> frees its backing store
> ([zun#55](https://github.com/UrubuCode/zun/issues/55)); the accounting still
> charges Node's UTF-8 byte length, so every high water mark and `drain`
> threshold agrees with Node.
>
> The number is what it is because the corpus reaches for language features
> rather than for stream features. The largest single group is the twenty-one
> files that require a module which does not exist yet (`fs`, `http`, `http2`,
> `net`, `timers/promises`, `readline`, `async_hooks`, `child_process`,
> `internal/test/binding`), and the two after it are new engine bugs found by
> this work: **a derived class cannot introduce an instance field** (10 files) (`class MyReadable extends Readable { constructor() { super();
> this.n = 0; } }` does not compile — field inference from a constructor
> assignment is gated on the class having no base), and **a constructor's
> declared parameters are all required** (11 files; `new MyWritable()` on a
> `constructor(options)` is a compile error, although
> [zun#61](https://github.com/UrubuCode/zun/issues/61) records that a plain
> function accepts too few). Behind them: `setTimeout`/`setImmediate` reject a
> dynamic callback ([zun#29](https://github.com/UrubuCode/zun/issues/29)), a
> `number` cannot be a Buffer size
> ([zun#58](https://github.com/UrubuCode/zun/issues/58)), `this` inside a
> listener is `undefined` ([zun#1](https://github.com/UrubuCode/zun/issues/1)),
> there is no function-constructor model for `Readable.call(this)`
> ([zun#25](https://github.com/UrubuCode/zun/issues/25)), and a `functionBox`
> handed to `Promise.prototype.then` is silently never called — which is what
> `promise.then(common.mustCall())` is, so the harness cannot verify those
> counts at all (a fifth new engine bug). **Every failure traced so far lands
> outside `stream.ts`** — those groups account for every bundle failure and
> every compile error in the corpus.
>
> `stream` also brought three *generic* bundler rules for canonical bindings,
> all of them engine workarounds over the module table's new comma-separated
> third column: a member read through the module alias
> (`stream.Readable` → `Readable`, because `new <object>.Ctor()` answers
> `undefined is not a function` at run time —
> [zun#18](https://github.com/UrubuCode/zun/issues/18)), a renamed
> destructuring (`const { Readable: R } = require('stream')`, because a class
> base must be the original identifier —
> [zun#21](https://github.com/UrubuCode/zun/issues/21)), and the renamed member
> spelling (`const EE = require('events').EventEmitter`). The last two lifted
> **`events` from 6/35 to 12/35** on their own: six of its files were blocked on
> nothing but the alias. The blocker-by-blocker table is in
> [`test/stream/README.md`](test/stream/README.md), the per-test breakdown in
> [`test/stream/RESULTS.md`](test/stream/RESULTS.md).

## Running the tracker locally

The tracker always needs the `zun` binary from the engine checkout; it needs the
extension `cdylib` only for extension modules.

```sh
# from the Zun engine checkout containing this submodule
cargo build -p zun_cli                 # the `zun` binary

# a Zun TypeScript module: no --ext, each test is bundled first
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --module path          # add --limit N to sample

# an extension module: build the cdylib and pass it with --ext
cargo build --manifest-path zun-node/Cargo.toml   # the extension cdylib
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --ext zun-node/target/debug/libzun_node.so \
    --module fs

# a Zun TypeScript module over natives: bundled *and* --ext
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --ext zun-node/target/debug/libzun_node.so \
    --module os
```

On Windows the binary is `target/debug/zun.exe` and the extension is
`zun-node/target/debug/zun_node.dll`. Other flags: `--tag v25.0.0` pins the Node
revision, `--timeout 20` caps each test, `--limit 0` (the default) means all
tests.

Each run rewrites this README's `<!-- node-<module>:start -->` block and
`test/<module>/RESULTS.md`.

To debug a single test by hand, bundle it and run the bundle:

```sh
bash zun-node/tools/bundle_node_test.sh path/to/test-path-join.js /tmp/bundle.ts
target/debug/zun run /tmp/bundle.ts
```

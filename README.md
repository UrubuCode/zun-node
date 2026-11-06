# zun-node

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform. See [`PLAN.md`](PLAN.md) for the architecture and the library roadmap.

## Three kinds of module

A Node module lands here in whichever form fits what it actually does:

- **Native extension modules** — a Rust `cdylib` that exports `zun_register_v1`
  and publishes its functions through the stable `zun_abi` contract. This is for
  modules that need the operating system, and it is how the *lower half* of
  `fs` and `os` is written (`src/fs/`, `src/os/`): a syscall cannot be expressed
  in the language, so it is Rust and is loaded with `zun run --ext <lib>`.
- **Zun TypeScript modules** — written in the language the platform compiles, and
  run by the engine like any other program. This is for modules that are pure
  computation: `path` (`src/path/path.ts`) is string manipulation end to end, so
  there is nothing to gain from crossing the ABI, and no `--ext` is involved.
  `querystring` (`src/querystring/querystring.ts`), `punycode`
  (`src/punycode/punycode.ts`) and `url` (`src/url/url.ts` plus
  `src/url/whatwg.ts`) are the same kind; `url` stands on the other two plus
  `path`, and carries the WHATWG URL Standard — the parser, the hosts, the
  percent-encode sets, the setters and `URLSearchParams` — in
  `src/url/whatwg.ts` rather than deferring to the engine's partial prelude
  classes. `stream` (`src/stream/stream.ts`) is the largest of
  them: pure computation over `events`, `process.nextTick`, the global `Buffer`
  and `string_decoder` — exactly the dependency set `lib/internal/streams/*`
  has. `timers` (`src/timers/timers.ts`) is the same kind for a
  different reason: it is not pure computation, but the capability it needs — the
  macrotask tier of the VM's unified event loop (NUCLEUS §9a) — is already
  *inside* the engine, so there is nothing for a native to do. It reaches that
  tier through `import { timers } from "zun:core"`, and it declares the six
  timer globals itself, which is what gives Node's own signatures to every
  bundle. `diagnostics_channel`
  (`src/diagnostics_channel/diagnostics_channel.ts`) is pure computation again —
  a channel is a map, a list and a few calls — and it brings an
  `AsyncLocalStorage` with it (`src/async_hooks/async_hooks.ts`), because
  `Channel.bindStore`/`runStores` are defined in terms of one. `console`
  (`src/console/console.ts`) is the second module after `timers` that has to be
  inlined into *every* bundle, and for the same kind of reason: `console` is a
  global in Node, while the engine's prelude `console` has five of its nineteen
  methods and a compile error for the rest. The binding that shadows it is one
  file of its own (`src/console/global.ts`), so that a test declaring its own
  `console` can still be bundled. `perf_hooks`
  (`src/perf_hooks/perf_hooks.ts`) is the third global of that kind, and the
  clearest case of the seam being drawn by *capability* rather than by subject:
  a performance timeline is marks in a map, entries in three arrays and
  observers in a list — pure computation — and the one thing it cannot compute
  is a clock, which `process` already answers as `process.hrtime`. So it needs
  no native of its own and runs with or without `--ext`; the extension only
  sharpens `performance.now()` from whole milliseconds to the platform
  monotonic clock. `domain` (`src/domain/domain.ts`) is the kind's limiting
  case: it computes nothing at all for itself — a domain is a stack, a member
  list and an error route — but Node implements it by *monkey-patching*
  `events`, `process` and `timers`, which this engine has no prototype model to
  allow. So the three modules declare one hook record between them
  (`__domainHooks` in `src/events/events.ts`), every slot of it is `null`, and
  `src/domain/domain.ts` is the only writer; see
  [`test/domain/README.md`](test/domain/README.md) for the table of what each
  slot replaces.
  `vm` (`src/vm/vm.ts`) is the kind's other limiting case, from the opposite
  side: compiling source text at run time sounds like the least
  library-expressible thing in Node, and it turns out the engine already owns
  the capability. `new Function(...)` is lowered to the `functionConstruct`
  intrinsic and answered by an injected `EvalHost` that calls **the project's
  own compiler**, so `vm` needs no syscall and no native — only the Node-shaped
  surface over that one primitive. It is the one module that must run *without*
  `--ext`, because `zun run --ext` injects no such host; see
  [`test/vm/README.md`](test/vm/README.md).

  `console` can still be bundled. `readline` and `readline/promises`
  (`src/readline/`) are pure computation over `events`, `stream`,
  `string_decoder` and `timers` — a line editor is string arithmetic, and the
  one thing a terminal adds, `setRawMode`, belongs to the input stream — and
  they are the first module written as **three** files: the shared base and
  everything around it in `src/readline/readline.ts`, plus one
  `class Interface extends __RlInterface` in each of `src/readline/callback.ts`
  (the callback `question`) and `src/readline/promises.ts` (the promise one),
  because the two module objects have to bind that one name to two different
  classes. Their tests are nevertheless run with `--ext`: three files in the
  corpus read their input from a file, which is `fs`.
- **Zun TypeScript over natives** — both, with the seam drawn where the
  capability changes. `os` is the first: the facts it reports are syscalls
  (`src/os/`, Rust), while the module *Node* exposes is objects, arrays,
  `constants`, validation and `ERR_*` errors (`src/os/os.ts`, Zun TypeScript),
  which reaches the natives with `import * as native from "node:os"`. Its tests
  are bundled like a TypeScript module **and** run with `--ext`. ABI v1 carries
  one scalar word per value, so `os` also fixes how a structured result
  crosses — one status-prefixed, separator-delimited string per call,
  documented in [`src/os/mod.rs`](src/os/mod.rs). **`fs` is the same shape**:
  `src/fs/*.rs` for the syscalls and the descriptor table,
  [`src/fs/fs.ts`](src/fs/fs.ts) for the Node API, with one addition `os` did
  not need — a file's *bytes* cannot ride a NUL-terminated string carrier, so
  they cross base64 and the TypeScript side turns them into the engine's
  prelude `Buffer`. **`child_process` is the third**: `src/child_process/*.rs`
  spawns a child and waits for it (`std::process::Command`, a thread per pipe, a
  timeout with a chosen kill signal), while
  [`src/child_process/child_process.ts`](src/child_process/child_process.ts)
  holds the module Node exposes — the argument normalizers, the shell rules, the
  `stdio` grammar and the result object. A spawn request cannot cross one scalar
  word at a time either, so it crosses as one delimited string in the same
  grammar, with the child's output base64 for the same reason a file's bytes
  are. **`process` is the fourth, and the only module in three files**:
  `src/process/*.rs` for the pid, the clocks, `getrusage`, `kill`, `chdir`, the
  real `umask`, the environment block and the POSIX credentials;
  [`src/process/process.ts`](src/process/process.ts) for Node's object; and
  [`src/process/native.ts`](src/process/native.ts) for the import alone. The
  third file exists because **every** bundle in this library inlines
  `process.ts` while most of them run with no `--ext` at all, so the import has
  to be separable — `tools/bundle_node_test.sh` appends `native.ts` only for a
  bundle that will get an extension, and `process.ts` keeps a documented
  fallback for every native-backed value (the table is in its header). **`zlib`
  is the fifth**: `src/zlib/*.rs` holds one `z_stream` (or Brotli
  encoder/decoder) per handle behind a small handle table, over `libz-rs-sys`
  and the `brotli` crate — both pure Rust, so the extension still builds with
  nothing but a Rust toolchain — while [`src/zlib/zlib.ts`](src/zlib/zlib.ts)
  holds the module Node exposes: nine `Transform` classes, the `create*`
  factories, the sync and callback convenience methods, `constants`/`codes` and
  the option validation. Compressed bytes cross base64, the same carrier `fs`
  uses and for the same reason.

  `v8` (`src/v8/v8.ts`) and `tty` (`src/tty/tty.ts`) are the last two of this
  kind so far, and both are the seam-by-capability case again. `node:v8` looks
  like the most engine-bound module in Node's library and is in fact almost
  entirely arithmetic: V8's value-serialization wire format is bytes over the
  engine's `Buffer` and a `DataView`, so `serialize`/`deserialize` are
  byte-identical to Node's here, while the readings that *are* V8's — heap
  spaces, a sampling profiler, a heap graph — have no isolate under them and
  are reported shape-true and content-empty, each row named in the resolution
  table in that file's header. `node:tty` is the same split one level down:
  `isatty(fd)` is a real predicate `process` already answers,
  `getColorDepth`/`hasColors` is `process.env` arithmetic, the two terminal
  streams are `Duplex`es from `stream`, and the four cursor methods are
  `readline`'s own functions reached through its module object — which is why
  `tty` is the one module here that depends on `readline` rather than the
  other way round.

  **`net` is the first module of this kind whose natives are not its own**, and
  that is worth a paragraph, because what it needed first was not `net` but a
  piece of *infrastructure* this library did not have. Every native above
  blocks: `os` asks the kernel a question and gets an answer, `fs` reads a
  file, `dns` resolves a name, and the asynchrony of Node's API is restored on
  the TypeScript side by delivering the result through `process.nextTick` — the
  pattern [`src/dns/dns.ts`](src/dns/dns.ts) documents as "synchronous natives,
  asynchronous API". A socket cannot work that way: a server has to be
  *waiting* for a connection while the program runs, two sockets have to make
  progress at once, and a read has to complete after the call that armed it
  returned. ABI v1 gives an extension no way to complete a call later, so the
  direction is inverted instead — no native waits for a *particular* event
  (each one either completes or answers "not yet"), and **one** native waits
  for *any* registered handle. That is the readiness model (`select`/`poll`),
  and it is the only asynchronous I/O this ABI can express.
  So the lower half of `net` is not `src/net/*.rs` but
  [`src/io/mod.rs`](src/io/mod.rs) + [`src/io/sys.rs`](src/io/sys.rs) — a table
  of non-blocking handles, the eleven verbs on one, and `ioPoll(timeoutMs)` —
  published under `node:io`, with its scheduling half in
  [`src/io/io.ts`](src/io/io.ts): `ref`/`unref` accounting, the pump, and the
  dispatch to callbacks. Nothing in either file is socket-shaped beyond TCP's
  own verbs, because `dgram`, `child_process.spawn`'s pipes, `fs`' streams and
  `http` are meant to register with that same loop rather than start a second
  one. [`src/net/net.ts`](src/net/net.ts) is then `net` as Node exposes it:
  `Socket` as a `stream.Duplex` whose `_read`/`_write`/`_final`/`_destroy` are
  the loop's events, `Server` over one listening handle, and
  `isIP`/`BlockList`/`SocketAddress`/the argument cascades as pure shape.
  `io.ts` is inlined into **every** bundle for the reason `process.ts` and
  `timers.ts` are — the harness asks it how many ref'd handles are live — so
  its `import` lives in `src/io/native.ts` and is appended only for a bundle
  that gets `--ext`.

Support slices exist to run Node's own tests, and are Zun TypeScript for the
same reason: `src/assert/assert.ts` is the strict-mode `assert` surface the
tests assert with. `src/util/util.ts` and `src/process/process.ts` used to be
two more; both are modules in their own right now, and `assert` stands on `util`
rather than carrying its own copy of `inspect` and `deepStrictEqual`.

## Compatibility

The bar is **Node.js 25's own test suite**, not tests written here. The workflow
[`.github/workflows/node-compat.yml`](.github/workflows/node-compat.yml)
**downloads** the Node `test/parallel/test-<module>*.js` files at a pinned tag,
runs each through the Zun engine
([`tools/run_node_tests.sh`](tools/run_node_tests.sh)), and reports the share that
passes. The percentages below are that measurement — they climb as the library
grows.

The `util`, `path`, `events`, `os` and `process` numbers below were last
regenerated on **Windows** (the CI workflow runs on `ubuntu-latest`). One test differs between the two:
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
util/events/process/assert/path/querystring/punycode/url/timers/console
modules, `src/process/native.ts` when the bundle will be run with `--ext`, the
modules the test actually requires (`os`, `buffer`, `string_decoder`, `stream`,
`fs`, `child_process`, `diagnostics_channel`, `domain`) and the
`common` harness (plus `node:test` when the test requires it) ahead of the test body,
rewrites its `require` lines to the one object each
inlined module exposes (`__node_events`, `__node_assert`, …), and appends the
statement that settles the event loop and verifies the `common.mustCall` counts;
the resulting single file runs as `zun run <bundle.ts>`. Extension modules keep
the direct `zun run --ext <lib> <test.js>` path.

<!-- node-fs:start -->
### Node.js v25 `fs` compatibility

`██████████░░░░░░░░░░░░░░` **42.2%** — 96 / 227 Node `test-fs-*` tests passing
<!-- node-fs:end -->

> `fs` is implemented as **TS over natives**, the `os` kind: `src/fs/*.rs` holds
> the syscalls and the descriptor table, [`src/fs/fs.ts`](src/fs/fs.ts) holds
> the Node module — the whole synchronous surface with Node's option shapes,
> `Stats`/`BigIntStats`/`Dirent`/`Dir`/`StatsFs`, `fs.constants`, the `ERR_*`
> and libuv-shaped errors, the callback API and `fs.promises`. Three more files
> complete it: [`src/fs/streams.ts`](src/fs/streams.ts) is
> `ReadStream`/`WriteStream` over [`src/stream/stream.ts`](src/stream/stream.ts),
> [`src/fs/watchers.ts`](src/fs/watchers.ts) is `watch`/`watchFile`/
> `unwatchFile`/`fsPromises.watch` as pollers — which is what libuv itself is
> for `watchFile` and what Node's own recursive fallback is for `watch` — and
> [`src/fs/internal.ts`](src/fs/internal.ts) is the `internal/fs/utils` surface
> six of Node's tests drive directly. Only `glob` (no file in the corpus
> reaches it) and `openAsBlob` (needs `node:buffer`'s `Blob`) are still named
> gaps. What caps the number is not the library but one engine limit: a
> `Buffer` is opaque through `any`
> ([zun#38](https://github.com/UrubuCode/zun/issues/38)), so a test file cannot
> call a method on one this module returns, nor pass an `any` to
> `Buffer.from`/`byteLength`/`alloc`
> ([zun#58](https://github.com/UrubuCode/zun/issues/58)) — which is how most of
> the corpus is written. Per-test breakdown and the full blocker table:
> [`test/fs/README.md`](test/fs/README.md),
> [`test/fs/RESULTS.md`](test/fs/RESULTS.md).

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
> One file joined the passing set without a line of `util.ts` changing:
> `test-util-deprecate.js` needed a one-field fix one module over.
> `ProcessWarning.code` in `src/process/process.ts` was declared `string = ""`,
> so a warning raised with no code reported `''` where Node reports `undefined`.
> A warning has a `code` only when one was passed, which is what the field says
> now (`any = undefined`).
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

<!-- node-assert:start -->
### Node.js v25 `assert` compatibility

`█████░░░░░░░░░░░░░░░░░░░` **21.4%** — 3 / 14 Node `test-assert*` tests passing
<!-- node-assert:end -->

> `assert` is the module every other corpus runs *through* — each
> `test/parallel/test-*.js` opens with `const assert = require('assert')` — and
> it is now implemented end to end rather than as a harness slice: the callable
> module object, `ok`, `equal`/`notEqual` (loose, with Node 25's `NaN == NaN`
> rule), `strictEqual`/`notStrictEqual` (`Object.is`, so `0` and `-0` differ),
> `deepEqual`/`notDeepEqual` (**loose** deep equality — it used to be aliased to
> the strict comparison, which was simply wrong),
> `deepStrictEqual`/`notDeepStrictEqual`, `partialDeepStrictEqual`,
> `throws`/`doesNotThrow`, `rejects`/`doesNotReject`, `match`/`doesNotMatch`,
> `fail`, `ifError`, `assert.strict`, `require('assert/strict')` and Node 25's
> `assert.Assert` class. `AssertionError` composes **Node's own generated
> messages**: the `kReadableOperator` headers, the `+ actual - expected` Myers
> line diff with its `...`/"Skipped lines" collapsing (a port of
> `lib/internal/assert/myers_diff.js`, exported as `internal/assert/myers_diff`
> because Node's own test file requires it), the short `a !== b` form and the
> stacked form with its `^` indicator — verified byte for byte against Node.
> `CallTracker` and `fail`'s legacy four-argument form with DEP0094 are absent
> because **Node 25 removed them**, not as a gap.
> **No remaining failure is in `assert.ts`.** The dominant blocker is new and
> was found by this work: `err instanceof assert.AssertionError` does not
> compile, because the right operand of `instanceof` must be a literal class
> name — which takes out `test-assert.js`, `test-assert-async.js` and
> `test-assert-class.js` between them. The rest are typed arrays through an
> `any` lane ([zun#38](https://github.com/UrubuCode/zun/issues/38)), a class
> method that cannot be read as a value
> ([zun#19](https://github.com/UrubuCode/zun/issues/19)), `err.stack` having no
> setter, `new Array(a, b, c)` being rejected, and two files that need
> `require()` of a fixture module and a child process. The blocker-by-blocker
> table is in [`test/assert/README.md`](test/assert/README.md), the per-test
> breakdown in [`test/assert/RESULTS.md`](test/assert/RESULTS.md).

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

`████████████░░░░░░░░░░░░` **51.4%** — 18 / 35 Node `test-event-emitter-*|test-events-*` tests passing
<!-- node-events:end -->

> `events` is implemented end to end — the whole `EventEmitter` surface, every
> module static, and now **`EventEmitter.prototype`** as Node's own object:
> `constructor`, the three bookkeeping defaults and every instance method, each
> reachable *and* callable with a receiver, so
> `EventEmitter.prototype.on.call(plainObject, 'x', fn)` and
> `EventEmitter.prototype.emit.apply(ee, args)` both work and
> `E.on === E.addListener` holds. That one addition is worth three files
> (`get-max-listeners`, `method-names`, `once`), and the trick behind it is that
> an **object-literal method** is the one callable this engine threads a receiver
> into — `m.call(recv, a, b)` binds `this` *and* passes the arguments, where a
> plain function value loses `this`
> ([zun#1](https://github.com/UrubuCode/zun/issues/1)) and a function in a class
> static field cannot be called at all. Two more files came from the bundler
> learning that `EventEmitter.once` and `events.once` are literally the same
> function in Node, which lets it route the five statics that collide with an
> instance method name through the module object
> ([zun#20](https://github.com/UrubuCode/zun/issues/20)), and one from coercing
> every slot key the way ToPropertyKey does: a *function* stored under a
> **numeric** computed key is silently dropped by this engine, so
> `ee.on(123, fn)` landed in a slot that `in` and `Object.keys` reported and every
> read answered `undefined` for.
>
> The number is still capped by the *tests* reaching for engine features rather
> than by the module being thin: five files need a bound `this` inside a listener
> or on a `.call` (zun#1), two stand on the single line
> `assert(!(e._events instanceof Object))` — `Object.create(null) instanceof
> Object` answers `true`
> ([zun#26](https://github.com/UrubuCode/zun/issues/26)) — three need the
> function-constructor/prototype model
> ([zun#25](https://github.com/UrubuCode/zun/issues/25)), and three require
> Node's `internal/event_target` *and* an `EventTarget` the host does not let a
> library replace (`class EventTarget` is a `duplicate class`; the prelude's has
> no listener reader). `test-event-emitter-error-monitor.js` is down to one line,
> `.then(common.mustCall())`: `then` silently drops a boxed function handler
> ([zun#71](https://github.com/UrubuCode/zun/issues/71)).
> `test-event-emitter-special-event-names.js` keeps the storage layer honest —
> `_events` is a real null-prototype object, so an event named `toString`,
> `__defineGetter__` or `__proto__` is an ordinary key, which needs both engine
> regressions ([#46](https://github.com/UrubuCode/zun/issues/46),
> [#47](https://github.com/UrubuCode/zun/issues/47)) compensated.
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

`██░░░░░░░░░░░░░░░░░░░░░░` **9.3%** — 6 / 64 Node `test-buffer*` tests passing
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
> `constants`, `INSPECT_MAX_BYTES` as Node's validating accessor pair, a strict
> WHATWG `atob`/`btoa`, `isUtf8`, `isAscii`, `transcode` with ICU's exact
> substitution and strictness rules (verified over a 544-case matrix), `Blob`,
> `File`, `resolveObjectURL` (there is no `SlowBuffer`: Node removed it in v25)
> — and it carries the one piece of the inspector that `lib/buffer.js` owns, so
> a byte view prints as `<Buffer 61 62 63>` and, under `customInspect: false`,
> as `Buffer(3) [Uint8Array] [ 97, 98, 99 ]`. The number is low because **every
> remaining failure is an engine gap**, and the biggest one is a single rule:
> the `nodeBuffer` intrinsics take machine integers, so a plain `number` is
> rejected at the call site (`Buffer.alloc(n)` where `n` is a parameter does not
> compile), which costs 32 of the 64 tests on their first line. Behind it:
> `compare`/`toJSON`/`entries`/`buffer`/`byteOffset`/`parent`/`isEncoding`/`of`/
> `allocUnsafeSlow` are absent and absent *at compile time*, a byte view is
> opaque through `any` (only `Buffer.isBuffer` and `ArrayBuffer.isView` survive
> that boundary), and — the serious one — **the GC frees a live Buffer's backing
> `ArrayBuffer`**, reproducibly on the 256th class instance, because a view
> object carries type RID 0 and the mark phase has no reference slots for it;
> reached through a dynamically dispatched call that failure is *silent* and the
> read answers `undefined`. The four historical Buffer CVEs were
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
> `test-string-decoder-end.js`, and re-verified over a further 1056 cases
> compared code unit by code unit so a surrogate pair cannot hide a bug:
> **zero divergences**. The caller-supplied buffer is validated with
> `Buffer.isBuffer` rather than `ArrayBuffer.isView`, which removes a latent
> crash — a `Uint16Array` or a `DataView` cannot have its bytes read in this
> engine, and trying is an uncatchable error. The three failures are
> `Buffer.from`/`Buffer.of` with an `any` argument, `Math.random`, and a
> function called with one more argument than it declares — all engine gaps,
> all three re-probed and unchanged, none of them in the decoder. Table in
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
> bare callable form `assert(!(actual instanceof Object))`, and `instanceof
> Object` answers `true` for a null-prototype object on this engine
> ([zun#26](https://github.com/UrubuCode/zun/issues/26)) — which is exactly what
> that line denies. With it removed,
> `test-querystring-multichar-separator.js` passes in full. The callable-`assert`
> half of the old blocker ([zun#14](https://github.com/UrubuCode/zun/issues/14))
> **no longer reproduces** as of engine `c4afcca4`, and `test-querystring.js`'s
> `vm.runInNewContext('({"foo": ["bar", "baz"]})')` is served by the real
> `node:vm` now ([`src/vm/vm.ts`](src/vm/vm.ts)). The blocker table is
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

`████████░░░░░░░░░░░░░░░░` **34.0%** — 15 / 44 Node `test-url*|test-whatwg-url-*` tests passing
<!-- node-url:end -->

> `url` is implemented end to end, on both of its halves. `src/url/url.ts` is
> the legacy API — `parse` (with `parseQueryString` and `slashesDenoteHost`),
> `format` (string, object and `URL` forms, plus `format(URL, options)`),
> `resolve`, `resolveObject`, the `Url` class,
> `domainToASCII`/`domainToUnicode`, `fileURLToPath`/`pathToFileURL` for both
> platforms and `urlToHttpOptions` — following Node's `lib/url.js` and
> `lib/internal/url.js` instruction for instruction, because `url.parse` is
> explicitly not standardized (that is what DEP0169 says) and its behaviour
> simply *is* that code. Every CVE guard is reproduced rather than simplified:
> the scheme is lower-cased before any protocol-set decision (CVE-2018-12123),
> the hostname is re-checked against the forbidden set **after** IDNA so a NUL
> can neither be accepted nor truncated away (the CVE-2026-48930 class), an
> empty post-IDNA hostname throws `ERR_INVALID_URL`, and `parse(url, true)`
> hands back a null-prototype query. Node's eight regular expressions here are
> eight hand-written scans, so the parser owns no backtracking engine.
>
> `src/url/whatwg.ts` is the **WHATWG URL Standard itself** — the basic URL
> parser as its 21 states (`stateOverride` included, which is what every setter
> runs), host parsing with the IPv4 and IPv6 parsers and serializers and IDNA,
> the eight percent-encode sets, the URL and origin serializers, every getter
> and setter, `URL.canParse`/`URL.parse`, and `URLSearchParams` in full with the
> live link back to the URL that owns it. Measured against the WPT fixtures
> Node ships: **869 of 869 `urltestdata.json` constructor cases bar seven**, and
> **270 of 270 `setters_tests.json` setter cases with no divergence at all** —
> the seven are each one line of the UTS#46 mapping table this runtime has no
> ICU for. The classes are declared `NodeURL`/`NodeURLSearchParams`, because
> `URL` and `URLSearchParams` are prelude class names here and a user class of
> the same name is a "duplicate class" error; the bundler rewrites `new URL(…)`,
> `URL.<static>` and `x instanceof URL` to them, exactly as it already rewrites
> `console`, `performance` and `crypto`.
>
> Because the corpus now covers both prefixes (`test-url*` and
> `test-whatwg-url-*`, 44 files), and six of them cannot be bundled or expressed
> on this engine at all, the module is also checked directly against Node's own
> expectation tables: 89 `parseTests` cases (all twelve fields, the
> whitespace-trimmed re-parse and `format(expected)`), 29 `formatTests` cases in
> both forms, all 194 `relativeTests2` and 31 `relativeTests` resolve cases, the
> 51 `pathToFileURL` / 43 `fileURLToPath` cases with their error paths, and 35
> `URLSearchParams` cases — **zero divergences**. `test-url-relative.js`
> therefore fails on the engine, not on `url.ts`: the run corrupts a long-lived
> array of strings after roughly 80 `url.resolve` calls and the interpreter
> panics on the loop counter
> ([zun#67](https://github.com/UrubuCode/zun/issues/67), re-confirmed on
> `c4afcca4`). The
> remaining failures are `URLPattern` (a separate WHATWG specification Node
> implements in C++, declared as a gap rather than faked), the
> function/prototype/descriptor model, symbol-keyed class members
> (`Symbol.iterator`, `Symbol.toStringTag`, `util.inspect.custom`), reading a
> class method as a value for the `method.call(undefined)` brand checks,
> `child_process`, `eval`, and spread into a built-in. The blocker-by-blocker
> table is in [`test/url/README.md`](test/url/README.md), the per-test breakdown
> in [`test/url/RESULTS.md`](test/url/RESULTS.md).

<!-- node-timers:start -->
### Node.js v25 `timers` compatibility

`████████████░░░░░░░░░░░░` **53.4%** — 31 / 58 Node `test-timers*` tests passing
<!-- node-timers:end -->

> `timers` is the first module whose *substance* was already in the engine: the
> VM owns the event loop (NUCLEUS §9a — one unified loop that drains Promise
> microtasks and fires timers, on a virtual clock that fast-forwards to the next
> due time instead of sleeping). What Node adds on top is shape, and that is
> what [`src/timers/timers.ts`](src/timers/timers.ts) is — the `Timeout` and
> `Immediate` objects with Node's own enumerable fields,
> `ref`/`unref`/`hasRef`/`refresh`/`close`/`[Symbol.toPrimitive]`, the delay
> coercion with its three `Timeout*Warning`s, `clearTimeout` by object *or* id,
> the DEP0096 `enroll`/`unenroll`/`active` trio, and `timers/promises`'
> `setTimeout`/`setImmediate`/`setInterval` (an async generator) plus
> `scheduler.wait`/`scheduler.yield`, all with `AbortSignal` and the `ref`
> option. It is also where
> [zun#29](https://github.com/UrubuCode/zun/issues/29) gets its answer:
> `setTimeout` & co. are *globals* in Node and typed *intrinsics* in Zun, so
> Node's tests — which pass an `any` callback and clear with an object — are
> rejected at compile time. Declaring the six names as top-level functions
> shadows the intrinsics program-wide, and the implementation reaches the loop
> through `import { timers } from "zun:core"` instead, where the native's
> callback parameter is `Opaque`. Beyond the corpus the module was checked
> against Node directly — one 33-assertion driver run unchanged under `node` and
> under `zun run`, **zero divergences**. The failures are not in `timers.ts`:
> thirteen files need a harness module that does not exist, nine are two *new*
> engine bugs (a bare `return;` in a function whose return type was **inferred**
> as `Any` is rejected; an explicit `obj[Symbol.toPrimitive]()` panics the
> interpreter although every implicit coercion works), three need a closure to
> see a `const` initialised by the statement it was created in, and one is an
> honest ordering deviation — libuv runs immediates in a *check* phase after the
> timers phase, while the VM has a single macrotask tier. A third new engine bug
> was found and worked around here: `clearTimeout('16')` panicked, because
> reading an undeclared property off a **string** held in an `any` aborts the
> run. The harness gained something real in exchange: the settle loop now asks
> this module how many **ref'd** timers are armed and when the next one is due,
> so it stops guessing and jumps the virtual clock instead of spending a turn
> per millisecond, and it emits `process` 'beforeExit'. Blocker table:
> [`test/timers/README.md`](test/timers/README.md); per-test breakdown:
> [`test/timers/RESULTS.md`](test/timers/RESULTS.md).

<!-- node-process:start -->
### Node.js v25 `process` compatibility

`███████████░░░░░░░░░░░░░` **45.8%** — 44 / 96 Node `test-process-*` tests passing
<!-- node-process:end -->

> `process` is the module every other bundle in this library stands on, and the
> only one in **three** files: `src/process/*.rs` for the pid, the clocks,
> `getrusage`, `kill`, `chdir`, the real `umask`, the environment block and the
> POSIX credentials; [`src/process/process.ts`](src/process/process.ts) for
> Node's object; and [`src/process/native.ts`](src/process/native.ts) for the
> import alone, inlined only when a bundle will be run with `--ext`. The
> remaining failures are not a thin surface: `process` itself is complete, and
> 30 of the 54 are a harness module the bundler does not provide (`net`, `v8`,
> `inspector`, `internal/test/binding`, `hijackstdio`) or a test that re-runs
> *itself* as `spawn(process.execPath, [__filename])` — a child that would have
> to be Node. Blocker table, grouped by cause, with the three engine bugs this
> corpus found: [`test/process/README.md`](test/process/README.md); per-test
> breakdown: [`test/process/RESULTS.md`](test/process/RESULTS.md).

<!-- node-child_process:start -->
### Node.js v25 `child_process` compatibility

`░░░░░░░░░░░░░░░░░░░░░░░░` **3.6%** — 4 / 109 Node `test-child-process*` tests passing
<!-- node-child_process:end -->

> `child_process` is **TS over natives** (the `os` kind) and deliberately **half
> a module**: `src/child_process/*.rs` runs one child to completion with
> `std::process::Command` plus the three things `Command` does not do on its own
> (feed stdin from its own thread so it cannot deadlock against the child's
> output, enforce a timeout and kill with a *chosen* signal — `libc::kill` on
> POSIX, since `Child::kill` is hard-wired to `SIGKILL` and Node's default is
> `SIGTERM` — and cap a pipe at `maxBuffer` with `ENOBUFS`), and
> [`src/child_process/child_process.ts`](src/child_process/child_process.ts) is
> Node's shape: `spawnSync`, `execSync`, `execFileSync` with Node's three
> argument normalizers, the `cmd.exe /d /s /c "<command>"` and `/bin/sh -c`
> shells, the `stdio` grammar, `encoding`, the result object with its `output`
> array, `convertToValidSignal`, the null-byte rejection and
> `checkExecSyncError`'s two kinds of throw. The async half is a **stated gap**:
> a `ChildProcess` is an `EventEmitter` whose `stdin`/`stdout`/`stderr` are
> `node:stream` objects, so `spawn` and `fork` throw
> `ERR_METHOD_NOT_IMPLEMENTED` rather than pretending — while `exec` and
> `execFile` *are* here, because their callback contract is reproducible without
> streams (the child runs through the sync native and only the callback is
> deferred, through `process.nextTick`). The number is low for two reasons, and
> the second one matters more than the first: about seventy of the files need
> that async half, and about twenty re-run **themselves** with
> `spawnSync(process.execPath, [__filename, 'child'])`. `process.execPath` is
> real here (`cpExecPath()` is the host's own executable, i.e. the `zun`
> binary), but the child would be handed a raw CommonJS test file the engine
> cannot run ([zun#4](https://github.com/UrubuCode/zun/issues/4)) — it would
> have to be bundled first, which is a harness capability this library does not
> have yet. The module is therefore verified directly instead: 15 native tests
> through the real `cpSpawnSync` entry point (the wire grammar, the spawn and
> the reply encoder together) plus a differential pass over the TypeScript layer against
> Node on commands that need no Node child. One real bug came out of that: on
> Windows `Command::arg` applies MSVCRT quoting, which turned
> `cmd /d /s /c "echo hi"` into `cmd /d /s /c "\"echo hi\""` and made every
> shell command an unknown program — the Windows shell path uses `raw_arg` now,
> which is what libuv's `UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS` is for. Blocker
> table: [`test/child_process/README.md`](test/child_process/README.md);
> per-test breakdown:
> [`test/child_process/RESULTS.md`](test/child_process/RESULTS.md).

<!-- node-stream:start -->
### Node.js v25 `stream` compatibility

`█████████░░░░░░░░░░░░░░░` **38.2%** — 78 / 204 Node `test-stream-*|test-stream2-*|test-stream3-*|test-streams-*|test-readable-*` tests passing
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
> rather than for stream features. Fourteen files still require a module that
> does not exist here (`http`, `http2`, `net`, `readline`, `async_hooks`,
> `internal/test/binding`, `internal/js_stream_socket`); `fs`, `child_process`
> and `timers/promises` used to be on that list and are not any more, which is
> where most of the gap between the branch's 68 and this 79 comes from. The two
> largest remaining groups are new engine bugs found by this work: **a derived class cannot introduce an instance field** (10 files) (`class MyReadable extends Readable { constructor() { super();
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

<!-- node-diagnostics_channel:start -->
### Node.js v25 `diagnostics_channel` compatibility

`█████░░░░░░░░░░░░░░░░░░░` **24.4%** — 12 / 49 Node `test-diagnostics-channel*` tests passing
<!-- node-diagnostics_channel:end -->

<!-- node-console:start -->
### Node.js v25 `console` compatibility

`████████░░░░░░░░░░░░░░░░` **36.3%** — 8 / 22 Node `test-console*` tests passing
<!-- node-console:end -->

<!-- node-perf_hooks:start -->
### Node.js v25 `perf_hooks` compatibility

`██░░░░░░░░░░░░░░░░░░░░░░` **10.0%** — 2 / 20 Node `test-perf-hooks-*|test-performance*` tests passing
<!-- node-perf_hooks:end -->

> The whole surface is implemented — `performance` (`now`, `timeOrigin`,
> `mark`/`measure` with `detail` and start/end/duration options, the
> `getEntriesBy*`/`clear*` trio over Node's three separate global buffers,
> `markResourceTiming` with the secondary buffer and its single
> `resourcetimingbufferfull` drain, `timerify`, `eventLoopUtilization`,
> `nodeTiming`, `toJSON`), the five entry classes, `PerformanceObserver` with
> buffered observation and `setImmediate`-delivered callbacks, `createHistogram`
> and `monitorEventLoopDelay` with every reading including the `*BigInt`
> variants, and `constants`. The bar is low because this corpus leans hard on
> things the VM does not publish: six of the twenty files need
> `node:worker_threads`, three need `internalBinding` or `--expose-gc`, and one
> is an ES module the bundler does not rewrite. Of the rest, **two are blocked
> by a single engine gap** — `Object.defineProperty` does not store
> `writable: false` for a *symbol-keyed* property, so Node's
> `Symbol.toStringTag` descriptor assertion fails; re-run with only that block
> removed, `test-perf-hooks-usertiming.js` passes **in full**, which is the real
> measure of the user-timing half. `test-performance-measure.js` is recorded as
> a pass but is not one: its assertion runs inside an observer callback, where
> the engine does not let a throw fail the run, and it would fail anyway because
> the VM's timer tier advances a *virtual* clock while `performance.now()` reads
> a real one. Five new engine findings came out of this module — BigInt identity
> lost across a value round-trip, the symbol-descriptor gap above, quadratic
> class-instance allocation, a throw inside a macrotask not failing the run, and
> a spread into a method call rejected inside a function body — each with a
> repro in [`test/perf_hooks/README.md`](test/perf_hooks/README.md), alongside
> the per-test blocker table; the per-test run is in
> [`test/perf_hooks/RESULTS.md`](test/perf_hooks/RESULTS.md).

<!-- node-zlib:start -->
### Node.js v25 `zlib` compatibility

`████████░░░░░░░░░░░░░░░░` **33.3%** — 20 / 60 Node `test-zlib*` tests passing
<!-- node-zlib:end -->

> `zlib` is implemented end to end except zstd: the nine `Transform` classes,
> the `create*` factories, the nine `*Sync` and nine callback convenience
> methods with `maxOutputLength` and `info`, `crc32`, the frozen
> `constants`/`codes` tables with Node's numeric reverse mapping and the legacy
> top-level `Z_*` aliases, `flush`/`params`/`reset`/`close`, `bytesWritten`,
> and Node's whole error surface — `checkRangesOrGetDefault` over every option,
> `ERR_BROTLI_INVALID_PARAM`, `ERR_ZLIB_INITIALIZATION_FAILED`,
> `ERR_BUFFER_TOO_LARGE`, and the compression errors with zlib's own messages
> (`incorrect header check`, `unexpected end of file`, `Missing dictionary` vs
> `Bad dictionary`). The engines are `libz-rs-sys` (zlib-rs's C API, a
> memory-safe Rust rewrite of zlib with byte-identical output) and the `brotli`
> crate, and `src/zlib/zstream.rs` follows Node's own `src/node_zlib.cc` call
> for call — the per-mode `windowBits` rewriting, the `Z_NEED_DICT` retry, the
> concatenated-gzip member loop, the error classification.
>
> The percentage is held down by one engine gap rather than by the module: a
> typed array is opaque through an `any` binding
> ([zun#38](https://github.com/UrubuCode/zun/issues/38)), and every `Buffer`
> `zlib` returns reaches a test through one — so `zlib.gzipSync(x).length` reads
> `undefined` and `.toString()` throws, and any test that *compares bytes* is
> blocked before it can look at them. The compression is verified the way `os`
> and `stream` are instead: 22 Rust tests over the engines (round trips in every
> mode, the empty-input byte sequences, blobs produced by the real zlib and the
> reference Brotli encoder, dictionaries, concatenated members, `reset`,
> `params` mid-stream, the four error classifications, the `crc32` vectors) plus
> a differential pass in which `zlib.crc32` — which stays inside the module and
> therefore sees real `Buffer`s — confirms every round trip. zstd is the one
> deliberate omission: every pure-Rust zstd crate is decompression-only and a
> C-backed one would break the no-`cc` build. Blocker table:
> [`test/zlib/README.md`](test/zlib/README.md); per-test breakdown:
> [`test/zlib/RESULTS.md`](test/zlib/RESULTS.md).

<!-- node-crypto:start -->
### Node.js v25 `crypto` compatibility

`███░░░░░░░░░░░░░░░░░░░░░` **13.0%** — 15 / 115 Node `test-crypto*` tests passing
<!-- node-crypto:end -->

> `crypto` covers the symmetric half of Node's module end to end: `createHash`
> and `Hash` (MD5, SHA-1, the whole SHA-2 family with `sha512-224`/`sha512-256`,
> SHA-3 in four sizes, the two SHAKE XOFs with `options.outputLength`,
> RIPEMD-160, BLAKE2b-512, BLAKE2s-256, and OpenSSL's aliases for each) with
> `update`/`digest`/`copy` in every encoding, `crypto.hash()`'s one-shot in both
> of its third-argument forms, `createHmac`, `createCipheriv`/`createDecipheriv`
> for AES-128/192/256 in ECB, CBC, CTR and GCM plus ChaCha20 and
> ChaCha20-Poly1305 — with `setAutoPadding`, `setAAD`, `getAuthTag`/`setAuthTag`
> and their per-mode length rules — `pbkdf2`, `scrypt` and `hkdf` in sync and
> callback form, the whole `random*` family over the OS CSPRNG,
> `timingSafeEqual`, secret `KeyObject`s, `generateKey`, `getHashes` /
> `getCiphers` / `getCurves` / `getCipherInfo` over the real OpenSSL 3 table,
> `constants`, and `subtle.digest`. The primitives are RustCrypto's (`sha2`,
> `sha3`, `blake2`, `aes`, `ghash`, `poly1305`, `chacha20`, `scrypt`, `subtle`,
> `getrandom`), all pure Rust, so the extension still builds with nothing but a
> Rust toolchain; HMAC, PBKDF2 and HKDF are written out over one
> `Box<dyn DynDigest>` handle table rather than instantiated per digest.
>
> The percentage is held down by two things, neither of them the cryptography.
> **The asymmetric half is not written** — `generateKeyPair`, sign/verify,
> `publicEncrypt`/`privateDecrypt`, Diffie-Hellman, ECDH, X.509, the
> post-quantum families — which 72 of the 115 files reach for; every one of those entry
> points is present and raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` rather than
> being absent. And **zun#38** again: a typed array is opaque through an `any`
> binding, so `hash.digest()`, `randomBytes(32)` and `key.export()` reach a test
> as values whose `.length` reads `undefined` and whose `.toString()` throws —
> which is what stops `test-crypto-pbkdf2`, `test-crypto-hmac` and
> `test-crypto-padding` even though their bytes are right. The bytes are
> verified the way `zlib`'s are instead: 24 Rust tests against the published
> RFC/NIST/FIPS vectors (SHA/SHA-3/BLAKE2 `abc`, RFC 4231 HMAC, RFC 6070
> PBKDF2, RFC 5869 HKDF, RFC 7914 scrypt, FIPS 197 AES, SP 800-38A CTR, the
> NIST GCM cases including a 64-bit IV, RFC 8439 ChaCha20-Poly1305) plus a
> 165-value differential pass against the installed Node over every path that
> answers a string, which agrees everywhere. A third blocker was found and
> worked around: the prelude has a `crypto` of its own, and the checker resolves
> `crypto.<member>` against it from inside a `function` body even when a user
> declaration shadows the name — which is
> [zun#85](https://github.com/UrubuCode/zun/issues/85)'s second half, filed for
> `console`, landing on a second prelude namespace (standalone repro in the
> module's test README). The bundler rewrites `crypto` as a receiver to a second
> name, as it already does for `console` and `performance`. Blocker table:
> [`test/crypto/README.md`](test/crypto/README.md); per-test breakdown:
> [`test/crypto/RESULTS.md`](test/crypto/RESULTS.md).

<!-- node-readline:start -->
### Node.js v25 `readline` compatibility

`██████████░░░░░░░░░░░░░░` **45.4%** — 10 / 22 Node `test-readline*` tests passing
<!-- node-readline:end -->

<!-- node-v8:start -->
### Node.js v25 `v8` compatibility

`█████████░░░░░░░░░░░░░░░` **38.0%** — 8 / 21 Node `test-v8-*` tests passing
<!-- node-v8:end -->

> `node:v8` is a window onto a V8 isolate, and Zun is not V8: the wire format
> of `serialize`/`deserialize` is reproduced byte for byte (every value in the
> round-trip table in [`test/v8/README.md`](test/v8/README.md) matches the hex
> `node -e "v8.serialize(...)"` prints), while every heap, profiler and
> snapshot reading is shape-true and content-empty — the keys, types and file
> formats are Node's and the numbers are what this runtime can observe. The
> resolution table is in the header of [`src/v8/v8.ts`](src/v8/v8.ts); blockers
> per test: [`test/v8/README.md`](test/v8/README.md); per-test breakdown:
> [`test/v8/RESULTS.md`](test/v8/RESULTS.md).

<!-- node-tty:start -->
### Node.js v25 `tty` compatibility

`█████████░░░░░░░░░░░░░░░` **40.0%** — 2 / 5 Node `test-tty-*|test-ttywrap*` tests passing
<!-- node-tty:end -->

> `node:tty` answers `isatty(fd)` for real (through `process`' predicate) and
> implements `getColorDepth`/`hasColors`' whole environment table; the two
> terminal streams are `Duplex`es over fds 0–2 and raise
> `ERR_TTY_INIT_FAILED` for a descriptor that is not a terminal, which is
> what Node does too. Window size and raw mode have no capability under them
> here and are named as gaps. Blockers per test:
> [`test/tty/README.md`](test/tty/README.md); per-test breakdown:
> [`test/tty/RESULTS.md`](test/tty/RESULTS.md).

<!-- node-dns:start -->
### Node.js v25 `dns` compatibility

`█████░░░░░░░░░░░░░░░░░░░` **22.2%** — 6 / 27 Node `test-dns*` tests passing
<!-- node-dns:end -->

> `dns` is the sixth module written as Zun TypeScript over Rust natives, and the
> seam is the one Node itself draws between `lib/dns.js` and `src/cares_wrap.cc`:
> `src/dns/*.rs` answers the system resolver (`getaddrinfo`/`getnameinfo`
> through `libc` on POSIX and `GetAddrInfoW` on Windows, with the `AI_*` flags
> and `NI_NAMEREQD` libuv passes), the machine's configured resolvers
> (`/etc/resolv.conf`, `GetAdaptersAddresses`) and the DNS wire protocol itself;
> [`src/dns/dns.ts`](src/dns/dns.ts) holds the module Node exposes — `isIP`, the
> `setServers` address grammar, the `lookup` argument cascade, both `Resolver`
> classes, `DNSException` with its fabricated `ENOTFOUND`, the thirteen record
> shapes and the twenty-four error-code constants, for `node:dns` and
> `node:dns/promises` alike.
>
> The `resolve*` family is a **hand-written stub resolver**
> ([`src/dns/resolve.rs`](src/dns/resolve.rs)), not a resolver crate, and the
> reason is the same principle that keeps a VM out of this extension: what the
> module needs is one question per query, no cache, no DNSSEC and a server list
> the *caller* owns, while `hickory-resolver` in blocking mode still brings a
> `tokio` reactor and some ninety transitive crates. RFC 1035 message format
> with §4.1.4 name decompression over UDP, with the §4.2.2 TCP retry on a
> truncated answer, is a few hundred lines over `std::net` and no new
> dependency — and it is verified by 21 Rust tests that drive the encoder and
> the parser from hand-assembled messages (A/AAAA/MX/TXT/SOA/ANY records, a
> compression pointer, every RCODE, a truncated record and a compression loop).
>
> Six of the twenty-seven tests pass, and the shape of the remainder is worth
> stating because almost none of it is the module. Nine files need
> [`node:dgram`](https://nodejs.org/api/dgram.html) to stand up a fake DNS
> server (that module does not exist here yet); three need the
> `--dns-result-order` CLI flag; and **six are blocked by the one engine defect
> the `stream` section above already names** — a callable handed to
> `Promise.prototype.then` is silently never called, which is exactly what
> `.then(common.mustCall())` is. This corpus narrows it: the value
> `common.mustCall()` hands back is degraded by the *return* of a dynamic call
> (from an object-literal method it even reports `typeof === "object"`), it is
> still callable directly, and a **class** method's return is not degraded at
> all — so a harness whose `common` were a class instance would unblock the
> pattern in every module's corpus. The repro is in
> [`test/dns/README.md`](test/dns/README.md) with the other findings, alongside
> the per-test blocker table; the per-test run is in
> [`test/dns/RESULTS.md`](test/dns/RESULTS.md).

<!-- node-domain:start -->
### Node.js v25 `domain` compatibility

`████████░░░░░░░░░░░░░░░░` **36.0%** — 18 / 50 Node `test-domain-*` tests passing
<!-- node-domain:end -->

> `node:domain` is deprecated but fully specified, and it is the one module in
> this library whose implementation is defined by what it does to the *other*
> modules. Node's `lib/domain.js` replaces `EventEmitter.init`,
> `EventEmitter.prototype.emit` and
> `process.setUncaughtExceptionCaptureCallback`, redefines `process.domain` as
> an accessor, and registers an `async_hooks` hook so that every scheduled
> callback re-enters the domain that created it. None of that is expressible
> here — there is no prototype to patch
> ([zun#25](https://github.com/UrubuCode/zun/issues/25)), a class method cannot
> be read as a value ([zun#19](https://github.com/UrubuCode/zun/issues/19)),
> and the VM has no async-hooks tier. So the direction is inverted:
> `src/events/events.ts` declares one record whose every slot is `null`,
> `src/process/process.ts` stamps each `nextTick` entry and
> `src/timers/timers.ts` each `Timeout`/`Immediate` with the active domain, and
> `src/domain/domain.ts` — inlined only for a test that requires it — fills the
> slots. The cost to every other corpus is one null check per emit, per
> constructed emitter, per tick and per timer fire.
>
> The whole surface is implemented: `create`/`createDomain`, the `Domain` class
> with `run`, `add`, `remove`, `bind`, `intercept`, `enter`, `exit`, `members`
> and `_errorHandler`, `domain._stack`, `domain.active`, `process.domain`,
> `events.usingDomains`, the implicit binding of an `EventEmitter` constructed
> inside a domain, the full `error.domain`/`domainEmitter`/`domainBound`/
> `domainThrown` decoration, Node's stack-truncate-emit-restore dance in
> `emit`, the stack-clearing `uncaughtException` listener kept first through
> `process`' own `newListener`/`removeListener` events, and the exclusive claim
> on `process.setUncaughtExceptionCaptureCallback`
> (`ERR_DOMAIN_CALLBACK_NOT_AVAILABLE`,
> `ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE`). A throw out of a
> `nextTick` callback, a `setTimeout`, a `setImmediate` and an `fs` callback is
> routed to the domain that scheduled it, through the capture-callback path
> `src/process/process.ts` already walks in Node's order.
>
> Twenty-two of the fifty files are not about any of that: fifteen spawn a
> **child of the engine** to watch what V8's `--abort-on-uncaught-exception`
> does, five need a module this library does not have (`http`, `inspector`,
> `net`, `vm`), one needs `vm` plus the async-hooks tier and one needs
> `async_hooks.AsyncResource` with `--expose-gc`. Of the twenty-eight that are
> the module, **eighteen pass** — including every file that pins the stack
> discipline. The other ten are one engine gap each, and two engine bugs were
> found here: `Error`'s `name` and `stack`
> become unreadable, *even through an `any`*, once the error carries any added
> own property — which makes `console.error(err)` die for every error a
> Node-style `err.code = …` has annotated — and `Error.stackTraceLimit =
> Infinity` panics the interpreter. There is no `Function` global either, so
> `Function.call.bind(Object.prototype.propertyIsEnumerable)` is the sole
> blocker of three files. Deviations, repros and the blocker table:
> [`test/domain/README.md`](test/domain/README.md); per-test breakdown:
> [`test/domain/RESULTS.md`](test/domain/RESULTS.md).

<!-- node-net:start -->
### Node.js v25 `net` compatibility

`██████░░░░░░░░░░░░░░░░░░` **27.5%** — 41 / 149 Node `test-net-*` tests passing
<!-- node-net:end -->

> `net` is **TS over natives, and the first module here whose natives are not
> its own**. What it needed before it needed anything else was a piece of
> infrastructure this library did not have: an asynchronous-I/O readiness loop.
> Every other native in this repository blocks, with Node's asynchrony restored
> on the TypeScript side by `process.nextTick` (the pattern
> [`src/dns/dns.ts`](src/dns/dns.ts) documents). A socket cannot work that way,
> and ABI v1 cannot complete a call later — so the direction is inverted: no
> native waits for a *particular* event, and one native, `ioPoll(timeoutMs)`,
> waits for *any* registered handle. That loop is [`src/io/`](src/io/) under the
> module key `node:io` — a handle table and the eleven verbs on one
> (`src/io/mod.rs`), the raw non-blocking primitives with `poll(2)` on POSIX and
> `select` on Windows (`src/io/sys.rs`, **not** `WSAPoll`, which never reports a
> refused connection), the scheduling half with `ref`/`unref` and the pump
> (`src/io/io.ts`), and the one file that names the extension
> (`src/io/native.ts`). That loop deliberately owns **no macrotask chain of
> its own**: with the VM's virtual clock every armed task is due at once and
> the most recently armed one wins, so a pump that re-armed itself starved
> the whole program (a four-line probe shows `setTimeout(f, 1)` never firing
> while a server is registered; it cost 20 of the 149 tests). It exposes one
> turn and the existing loop driver calls it. Nothing in it is socket-shaped beyond TCP's own verbs,
> because `dgram`, `child_process.spawn`'s pipes, `fs`' streams and `http` are
> meant to register with the same loop. Thirteen Rust tests drive it below the
> ABI. [`src/net/net.ts`](src/net/net.ts) is then the module Node exposes:
> `Socket` as a `stream.Duplex` whose `_read`/`_write`/`_final`/`_destroy` are
> the loop's events, `Server`, `isIP*`, `BlockList`, `SocketAddress`, the
> argument cascades, `readyState`, `allowHalfOpen`, the socket options,
> `maxConnections` with `'drop'`, a real abortive `resetAndDestroy`, and
> `socket._handle` in libuv's `TCP`-wrap shape because four files in the corpus
> replace a method on it. Named gaps: no pipes / Unix sockets, no `fd`
> adoption, blocking name resolution, and a *sequential* rather than raced
> Happy Eyeballs. **The largest blocker is not in the module**: Node's `net`
> tests constantly write `server.listen(0, function () { this.address() })`, and
> `this` inside a listener is `undefined` here
> ([zun#1](https://github.com/UrubuCode/zun/issues/1)) — this corpus narrows
> that issue to receiver threading alone, because the argument *shifting* it also
> describes is gone (`apply`/`call` now pass the right arguments, just no
> receiver; `bind` does not exist at all). Per-test breakdown and the full
> blocker table: [`test/net/README.md`](test/net/README.md),
> [`test/net/RESULTS.md`](test/net/RESULTS.md).

<!-- node-vm:start -->
### Node.js v25 `vm` compatibility

`███░░░░░░░░░░░░░░░░░░░░░` **16.3%** — 15 / 92 Node `test-vm-*` tests passing
<!-- node-vm:end -->

> `vm` is the one module whose job *is* run-time compilation, so the first
> question was whether this platform has any. It does, and it is a real compile:
> the checker lowers `new Function(p1, …, body)` to the `functionConstruct`
> intrinsic, the interpreter hands the strings to an injected `EvalHost`, and
> the driver answers with **the project's own compiler**
> (`zun_compiler::compile_without_prelude`), links the resulting methods into
> the live module and re-verifies them. There is no `eval`, direct or indirect,
> and no host/ABI entry that compiles — `zun_abi` publishes natives *to* the
> engine, never the other way — so `new Function` is the whole surface, and
> `src/vm/vm.ts` is built on it rather than on an imitation of it. Every
> `Script` here is compiled by the compiler and every run executes compiled
> code.
>
> Two gaps separate `new Function(body)` from `vm.Script`, and both are closed
> with **the compiler as the authority** instead of a guess. A *completion
> value*: `__vmScan` finds the top-level statement boundaries — tracking
> comments, the three string forms, regular-expression literals and bracket
> depth — and the compile driver walks them backwards asking the compiler
> whether `<prefix> __zunVmR = (<suffix>);` compiles, keeping the first split it
> accepts; a bad proposal simply fails to compile and is discarded. And
> *contextified globals*: reading a free identifier lowers to `globalGet(name)`,
> but **writing** one is a compile error — ``unknown variable `foo` `` — and
> that diagnostic *names* every implicitly assigned global, so the names are
> read out of the message, declared `let` at the top of the generated body from
> the active context and copied back in a `finally`, while reads are served by
> installing the context's own properties on the realm global for the duration.
> Top-level `var` and `function` declarations go back to the context too,
> because in Node they become context-global properties where `let` and `const`
> do not.
>
> What this cannot be is a second realm: the engine has one realm global, so a
> context cannot *hide* the host's globals, and
> `vm.runInNewContext('typeof process')` answers `"object"` where Node answers
> `"undefined"`. That is stated rather than papered over, and it is most of what
> the corpus measures — along with two engine findings that this work produced
> and that between them cost about twenty files: `new Error("boom")` inside
> dynamically compiled code evaluates to a **function value** rather than an
> error (the builtin class cannot be referenced, so `new` on the realm class
> descriptor returns the descriptor, with no diagnostic), and `this.x = v` in
> compiled code **panics the interpreter** instead of throwing a `TypeError`.
> A third finding is why the tracker kind is `zun-ts`: `zun run --ext <lib>
> file.ts` injects no `EvalHost`, so loading any native extension silently
> removes run-time code generation from the program. Twenty-one more files need
> `--experimental-vm-modules`, whose `SourceTextModule` needs a module
> compilation entry the engine does not expose — so `vm.Module` and friends are
> **absent**, exactly as they are in a Node run without that flag. There is no
> code cache either, so `produceCachedData` reports
> `cachedDataProduced: false`, a supplied `cachedData` is honestly rejected and
> `createCachedData()` throws with its reason; and `timeout`/`breakOnSigint`
> are validated and then ignored, because nothing can interrupt a running
> frame. The file-by-file blocker table, with a standalone repro for each
> finding, is in [`test/vm/README.md`](test/vm/README.md); the per-test
> breakdown in [`test/vm/RESULTS.md`](test/vm/RESULTS.md).

<!-- node-module:start -->
### Node.js v25 `module` compatibility

`████████░░░░░░░░░░░░░░░░` **37.0%** — 20 / 54 Node `test-module-*|test-require-*` tests passing
<!-- node-module:end -->

> `module` is the one module in this library that cannot reach 100%, and the
> reason is structural rather than a gap to close: the Zun engine compiles a
> program ahead of execution, so there is no runtime compiler, no `eval` and no
> `vm` ([zun#4](https://github.com/UrubuCode/zun/issues/4)), and a `require`
> that turns a JavaScript file into a module needs one. That single fact
> accounts for **17 of the 34 failures**; nine more spawn `process.execPath` as
> if it were a `node` binary and ask it to run a `.js` main.
>
> What *is* here is the whole half of `node:module` that is computation over
> paths and files, and it is complete: the resolver
> (`_resolveFilename` with `options.paths`, `_findPath` with `_pathCache` and
> multi-dot extensions, `_resolveLookupPaths`, `_nodeModulePaths` for both
> platforms, `_initPaths`/`globalPaths`, `_stat`, package.json `"main"` with its
> DEP0128 warning), the caches, the extension table with user-registered
> loaders, `createRequire`, `findPackageJSON`, a complete Source Map v3 reader
> (`SourceMap`, `findEntry`, `findOrigin`, index maps), `Module.wrap`,
> `setSourceMapsSupport`, the compile-cache trio reporting honest values, and
> `stripTypeScriptTypes` over a whitespace-preserving stripper written here
> rather than borrowed from SWC. `.json` modules load for real; `.mjs` answers
> `ERR_REQUIRE_ESM` and `.node` answers `ERR_DLOPEN_FAILED`, which are the
> honest errors rather than fabricated successes.
>
> It also needed a bundler mode. Every other corpus is built by rewriting
> `require(...)` *away* into the inlined module objects, which is exactly wrong
> for the corpus whose subject is `require`: `test-require-cache.js` writes
> `require.cache.fs` and then asks what `require('fs')` answers. So
> `tools/run_node_tests.sh --module module` exports `ZUN_NODE_REQUIRE=1`, under
> which the bundler leaves a builtin specifier for the run-time `require` to
> resolve, renames the body's `require` to `__zunRequire` — the `require` of the
> bundled file's own module record — and emits one
> `__modRegisterBuiltin("<specifier>", __node_<specifier>)` call per module
> object the bundle carries. No other corpus' bundle changes by a byte.
>
> Two engine bugs were found here, both with standalone repros: a function
> expression assigned to an expando property of a **function** is given a
> synthetic leading `this` parameter — shifting every argument by one — as soon
> as the token `this` appears anywhere in its source span, comments included
> (the same assignment onto a plain *object* is unaffected); and
> `Object.defineProperty` on a function value throws "called on non-object".
> Deviations, repros and the blocker table:
> [`test/module/README.md`](test/module/README.md); per-test breakdown:
> [`test/module/RESULTS.md`](test/module/RESULTS.md).

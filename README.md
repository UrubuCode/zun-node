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
util/events/process/assert/path modules and the `common`/`node:test` harness
ahead of the test body, rewrites its `require` lines to the one object each
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

`████░░░░░░░░░░░░░░░░░░░░` **17.1%** — 6 / 35 Node `test-event-emitter-*|test-events-*` tests passing
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
> ([zun#26](https://github.com/UrubuCode/zun/issues/26)). The full
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

# zun-node

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform. See [`PLAN.md`](PLAN.md) for the architecture and the library roadmap.

## Two kinds of module

A Node module lands here in whichever form fits what it actually does:

- **Native extension modules** — a Rust `cdylib` that exports `zun_register_v1`
  and publishes its functions through the stable `zun_abi` contract. This is for
  modules that need the operating system: `fs` (`src/fs/`) needs syscalls, so it
  is Rust and is loaded with `zun run --ext <lib>`.
- **Zun TypeScript modules** — written in the language the platform compiles, and
  run by the engine like any other program. This is for modules that are pure
  computation: `path` (`src/path/path.ts`) is string manipulation end to end, so
  there is nothing to gain from crossing the ABI, and no `--ext` is involved.

Support slices exist to run Node's own tests, and are Zun TypeScript for the
same reason: `src/assert/assert.ts` (the strict-mode `assert` surface the tests
assert with), `src/process/process.ts` (`cwd()`, `env`, `platform`, and — because
Node's `process` is an EventEmitter — `on`/`emit`/`nextTick`/`emitWarning`), and
`src/util/util.ts` (`inspect`, which `events` formats its error and warning
messages with).

## Compatibility

The bar is **Node.js 25's own test suite**, not tests written here. The workflow
[`.github/workflows/node-compat.yml`](.github/workflows/node-compat.yml)
**downloads** the Node `test/parallel/test-<module>*.js` files at a pinned tag,
runs each through the Zun engine
([`tools/run_node_tests.sh`](tools/run_node_tests.sh)), and reports the share that
passes. The percentages below are that measurement — they climb as the library
grows.

Because the engine has no CommonJS `require` or module resolution
([zun#4](https://github.com/UrubuCode/zun/issues/4)), a Zun TypeScript module's
tests are first passed through
[`tools/bundle_node_test.sh`](tools/bundle_node_test.sh), which inlines the
util/events/process/assert/path/common modules ahead of the test body, rewrites
its `require` lines to the one object each inlined module exposes
(`__node_events`, `__node_assert`, …), and appends the statement that settles the
event loop and verifies the `common.mustCall` counts; the resulting single file
runs as `zun run <bundle.ts>`. Extension modules keep the direct
`zun run --ext <lib> <test.js>` path.

<!-- node-fs:start -->
### Node.js v25 `fs` compatibility

`░░░░░░░░░░░░░░░░░░░░░░░░` **0.0%** — 0 / 227 Node `test-fs-*` tests passing
<!-- node-fs:end -->

> The `fs` number is near zero by design: running Node's `fs` tests needs the
> Node-API shaping over the low-level extension functions (Buffers, file
> descriptors, callbacks and promises, a full `Stats`), `node:test`, and the
> `test/fixtures/` tree. Those are the next work; this number is how we watch it
> land. Per-test breakdown: [`test/fs/RESULTS.md`](test/fs/RESULTS.md).

<!-- node-path:start -->
### Node.js v25 `path` compatibility

`███████████████████░░░░░` **82.3%** — 14 / 17 Node `test-path*` tests passing
<!-- node-path:end -->

> `path` already runs the whole Node corpus, so its number is a real measurement.
> Every test still failing is blocked in the **engine**, not in `path.ts` — the
> blocking table is in [`test/path/README.md`](test/path/README.md), the per-test
> breakdown with a failure note for each in
> [`test/path/RESULTS.md`](test/path/RESULTS.md).

<!-- node-events:start -->
### Node.js v25 `events` compatibility

`███░░░░░░░░░░░░░░░░░░░░░` **14.2%** — 5 / 35 Node `test-event-emitter-*|test-events-*` tests passing
<!-- node-events:end -->

> `events` is implemented end to end — the whole `EventEmitter` surface plus every
> module static — and the number is low because the *tests* reach for engine
> features that do not exist yet, not because the module is thin. Nine of the
> thirty-five files open with `new events.EventEmitter()`, which cannot compile:
> `new` accepts a class identifier or a `Proxy`-typed expression, never a member
> expression. Three more need class statics (`EventEmitter.defaultMaxListeners`,
> `EventEmitter.once`), five need a bound `this` inside a listener
> ([zun#1](https://github.com/UrubuCode/zun/issues/1) — `apply`/`call` thread no
> receiver), and three require Node's `internal/event_target`. The full
> blocker-by-blocker table is in [`test/events/README.md`](test/events/README.md),
> the per-test breakdown in [`test/events/RESULTS.md`](test/events/RESULTS.md).

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

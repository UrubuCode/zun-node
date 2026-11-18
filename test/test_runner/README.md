# node:test — Node.js compatibility tests

The compatibility bar for `node:test` is **Node.js 25's own test suite**:
`test/parallel/test-runner-*.js` at tag `v25.0.0`.

## The oracle

`NODE_TESTS.txt` lists the 42 CommonJS files of that prefix. The twenty
`test-runner-*.mjs` files are not in the corpus: the bundler resolves
`require`, and the engine has no `import` of a second file
([zun#4](https://github.com/UrubuCode/zun/issues/4)).

A third of the corpus spawns `node --test <fixture>` (or `node <self> child`),
so `NODE_FIXTURES.txt` downloads Node's `test/fixtures/test-runner` tree —
minus `output/`, `global-setup-teardown/` and `shards/`, which only the
`.mjs` tests read.

```sh
cargo build --release                              # zun_node.dll + zun-node-run
bash tools/run_node_tests.sh \
    --zun <zun.exe> --ext target/release/zun_node.dll \
    --module test_runner
```

The kind is `zun-ts+ext` and the per-test timeout defaults to 180 s: every
`node --test` child is bundled on first use, so a file that spawns a dozen
children spends most of its time in the bundler.

## Where it lives

`node:test` used to be a 180-line harness shim (`tools/harness/node_test.ts`:
tests run synchronously at declaration, hooks run immediately). It is now
library code in `src/test/`:

| File | What it is |
|---|---|
| [`src/test/test.ts`](../../src/test/test.ts) | the runner: test tree, scheduling, hooks, contexts, options, reporters, summary, `node:test/reporters`, `internal/test_runner/utils` |
| [`src/test/mock.ts`](../../src/test/mock.ts) | `MockTracker`, `MockFunctionContext`, `MockPropertyContext`, `MockTimers` |
| [`src/test/run.ts`](../../src/test/run.ts) | `run()` and the `node --test` CLI (`__ntCli`); inlined only into a bundle that names `run` |

Supporting changes outside the module:

* `src/timers/timers.ts` — the `__timerMock` hook table: a bundle's bare
  `setTimeout(...)` is a call to a top-level function, not a read of a
  mutable global, so `mock.timers.enable()` reaches it through this table
  (and replaces `globalThis.*`, `node:timers` and `node:timers/promises` as
  Node does). The runner's own timers use the unhooked `__timerReal*`
  functions, so a test that mocks the clock does not freeze its runner.
* `src/bin/zun-node-run.rs` — `zun-node-run --test [flags] [files]` is Node's
  test-runner CLI: it writes a two-line script that hands the flags and files
  to `run()`, or, under `--test-isolation=none`, concatenates the files (each
  in a function of its own) into one program. Every Node flag before the
  script now reaches the child as `process.execArgv`
  (`ZUN_NODE_EXEC_ARGV`, read by `src/process/process.ts`), which is how
  `--test-reporter`, `--test-only`, `--test-name-pattern`, `--test-timeout`
  and `--test-force-exit` get to a test file.
* `tools/bundle_node_test.sh` — `.mjs` sources have their static `import`
  declarations lowered to `require()` (Node's fixtures are half ESM), and
  `src/test/run.ts` + `child_process` + `fs` are appended when a test names
  `run`.
* `src/io/io.ts` / `tools/harness/common.ts` — `__ioDeadlineOverride`: the
  harness settle loop gives up on live I/O after 12 s, and `run()` waits on
  one child process per file, so it lifts that deadline while it runs.

## What is implemented

* **The tree.** `test`/`it` and `describe`/`suite` (plus `.skip`, `.todo`,
  `.only` on both), `t.test()`. Suites are built synchronously when declared;
  tests start after the file's synchronous part (Node's bootstrap is
  asynchronous), one at a time unless `concurrency` says otherwise; a test
  waits for the subtests it started and cancels the ones still queued when
  it returns; a parent with failing subtests fails with
  `N subtest(s) failed`; a subtest created after its parent finished fails
  with `parentAlreadyFinished`. `test()` returns a promise that resolves to
  `undefined`. `require('node:test') === test`, `test.test === test`,
  `test.describe === test.suite`.
* **Hooks.** `before`/`after`/`beforeEach`/`afterEach` at the top level, in a
  suite and on a `TestContext`, with Node's order: `before` once per parent,
  inherited `beforeEach` outermost first, `afterEach` innermost first, `after`
  after the owner's subtests; a failing hook is `hookFailed`; root `after`
  hooks run when every test has finished. Hook, test and suite functions get
  the context as both argument and `this`.
* **`TestContext`.** `name`, `fullName`, `filePath`, `signal` (aborted when the
  test ends or times out), `passed`, `error`, `attempt`, `diagnostic()`,
  `plan(count, { wait })` (counted by `t.assert.*` and `t.test`), `skip()`,
  `todo()`, `runOnly()`, `test()`, the four hooks, `waitFor(condition,
  { interval, timeout })`, `assert` (every `node:assert` function but the four
  Node leaves out, plus `snapshot`/`fileSnapshot` and whatever
  `assert.register(name, fn)` added, called with `this` = the context) and
  `mock`. `SuiteContext`: `name`, `fullName`, `filePath`, `signal`.
* **Options.** `skip`, `todo` (inherited by every descendant), `only`,
  `timeout` (validated, inherited, `--test-timeout` for top-level tests),
  `concurrency` (number or boolean), `plan`, `signal`, error-first callback
  tests (`(t, done)`) with the `callbackAndPromisePresent` and multiple-call
  failures, Node's `ERR_INVALID_ARG_TYPE`/`ERR_OUT_OF_RANGE` validation.
* **Filtering.** Node's rules exactly: `only` tests make their parent run only
  `only` subtests (filtering is on in a plain run and under
  `--test-isolation=none`, and in a `run()` child only with `--test-only`);
  `--test-name-pattern`/`--test-skip-pattern` match a test, an ancestor, or
  the space-joined ancestor chain, and a match unfilters every ancestor.
  Filtered tests are not reported.
* **Reporters.** `spec` (the default, as in Node 25), `tap` and `dot`, on
  stdout or a `--test-reporter-destination` (`stdout`, `stderr`, a file),
  with Node's reporter/destination pairing check. The summary
  (`tests suites pass fail cancelled skipped todo duration_ms`), spec's
  `✖ failing tests:` section, and `process.exitCode = 1` when a test, a suite
  or a hook failed or a test was cancelled — a failing `todo` does not count.
  `--test-force-exit` exits once every test has been reported.
* **`run()`.** Each file runs in a child process (`process.execPath <file>`
  with `NODE_TEST_CONTEXT=child-v8`), whose runner then reports one JSON event
  per stdout line instead of Node's v8-serialized stream; the parent turns
  them back into `test:start`/`test:pass`/`test:fail`/`test:plan`/
  `test:diagnostic`/`test:complete`/`test:stdout`/`test:stderr` events, adds
  the file-level test Node reports when a file fails outside any test (or
  reports nothing), reports files in order whatever the concurrency, and
  emits the aggregated summary. The stream is an EventEmitter, an async
  iterable of events, and has `compose(reporter)` (a reporter name, a
  generator function or a `Transform`-shaped object) and `pipe()`. Options:
  `files`, default discovery from `cwd` (Node's `--test` patterns, sorted,
  relative), `concurrency`, `timeout` (per test, as in Node), `only`,
  `testNamePatterns`, `testSkipPatterns`, `signal`, `setup`, `execArgv`,
  `argv`, `env`, `cwd`, `isolation`.
* **The CLI.** `node --test [files]` with `--test-reporter(-destination)`,
  `--test-concurrency`, `--test-timeout`, `--test-isolation`, `--test-only`,
  `--test-name-pattern`, `--test-skip-pattern`, `--test-force-exit`;
  `Could not find '<path>'` for a missing file; `NODE_DEBUG=test_runner`
  prints the configuration line Node prints.
* **`mock`.** `fn(original, implementation, { times })`, `method` (with
  `getter`/`setter`), `getter`, `setter`, `property` (accesses,
  `mockImplementation(Once)`, `resetAccesses`, `restore`), `reset`,
  `restoreAll`, and the mock context's `calls` (`arguments`, `result`,
  `error`, `this`, `target`, `stack`), `callCount`, `mockImplementation`,
  `mockImplementationOnce(fn, onCall)`, `resetCalls`, `restore`. A test's
  `t.mock` is reset when the test ends.
* **`mock.timers`.** `enable({ apis, now })` over `setTimeout`, `setInterval`,
  `setImmediate`, `Date` and `scheduler.wait`, `tick`, `runAll`, `setTime`,
  `reset`, `[Symbol.dispose]`, the promisified forms (with `AbortSignal`) and
  the async-iterator `setInterval`, all with Node's validation errors.
* **`snapshot`.** `setDefaultSnapshotSerializers`, `setResolveSnapshotPath`
  (validation only).

## What is missing

* **`mock.module()`** (needs a module loader the engine does not have) and
  **`t.assert.snapshot`/`fileSnapshot`** (throw `ERR_METHOD_NOT_IMPLEMENTED`).
* **Coverage** (`--experimental-test-coverage`) and **watch mode**.
* **Source locations.** Node reports each test's `file:line:column` from the
  call site; the engine's stack frames carry bundle offsets, not source
  positions, so events carry `file` only (the file-level test of `run()` has
  Node's `1:1`). The `generated asynchronous activity after the test ended`
  diagnostic needs the same locations plus per-test async attribution.
* **Custom reporters by module path**, `--test-shard`, `--test-rerun-failures`,
  global setup files: each needs loading a module at run time.
* `concurrency: true` at the CLI runs four files at a time rather than
  `availableParallelism() - 1`.

## Engine issues found

| Issue | Effect here |
|---|---|
| [zun#137](https://github.com/UrubuCode/zun/issues/137) | an expression-bodied `: void` arrow fails verification (worked around with block bodies) |
| [zun#138](https://github.com/UrubuCode/zun/issues/138) | a class method called through `any` loses a returned function (`MockTracker` is an object literal for this reason) |
| [zun#139](https://github.com/UrubuCode/zun/issues/139) | any property read on a function returned from a dynamic method call panics: `t.mock.fn().mock` — blocks `test-runner-mocking.js`, `-mock-timers-scheduler.js` |
| [zun#141](https://github.com/UrubuCode/zun/issues/141) | `RegExp.prototype.source` does not escape `/` — `test-runner-string-to-regexp.js` |
| [zun#142](https://github.com/UrubuCode/zun/issues/142) | `new Promise(boxedFn)` throws — `test-runner-root-after-with-refed-handles.js` |
| [zun#11](https://github.com/UrubuCode/zun/issues/11) | a rest-parameter function called through `any` gets no rest array (the public API takes three optional parameters instead) |
| [zun#40](https://github.com/UrubuCode/zun/issues/40) | the word `arguments` injects a rest parameter (the mock call record spells its key indirectly) |

Bare `Date` in a bundle is the engine's intrinsic, so `mock.timers`' `Date`
replaces `globalThis.Date` but `new Date()`/`Date.now()` written bare still read
the real clock (`test-runner-mock-timers-date.js`).

Per-test results: [`RESULTS.md`](RESULTS.md).

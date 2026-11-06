# node:process — Node.js compatibility tests

The compatibility bar for `process` is **Node.js 25's own test suite**, not tests
we write. `process` is **not finished** until it passes 100% of Node's
`test-process-*` tests.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module —
**96 files** under the single `test-process-` prefix, three of them `.mjs`:

```
test-process-abort.js                 test-process-exit-code.js
test-process-argv-0.js                test-process-exit-from-before-exit.js
test-process-available-memory.js      test-process-exit-handler.js
…                                     test-process-warnings.mjs
```

Each file is fetched verbatim from `nodejs/node` at tag `v25.0.0`; nothing is
vendored here.

## How they run

`process` is the kind `os` introduced — Zun TypeScript over a native extension,
`zun-ts+ext` in the tracker — **plus one constraint none of the other modules
has**:

> every bundle in this library inlines `../../src/process/process.ts`, and most
> of those bundles run with no `--ext` at all.

`node:path`, `node:events`, `node:util`, `node:assert` and `node:url` are pure
computation, and their tests run as `zun run <bundle.ts>`. A `process` that
imported its own natives would make every one of those bundles fail to *compile*
for want of a cdylib they do not need. So the import lives in a **third file**:
[`../../src/process/native.ts`](../../src/process/native.ts) is one object
literal of forwarding methods and one `__processInstallNative(...)` call, and
[`../../tools/bundle_node_test.sh`](../../tools/bundle_node_test.sh) appends it
only when the bundle will be run with the extension (`EXT_FILES`, gated on the
`ZUN_NODE_EXT` variable that `tools/run_node_tests.sh` exports whenever it
passes `--ext`). `process.ts` keeps a documented fallback for every
native-backed value — the complete table is in its header — so a bundle without
`native.ts` still compiles and still runs, with `pid` reporting `0` and the
clocks falling back to `Date.now()`.

```sh
cargo build -p zun_cli                              # the `zun` binary
cargo build --manifest-path zun-node/Cargo.toml     # the extension cdylib
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --ext zun-node/target/debug/libzun_node.so \
    --module process
```

## What is implemented

The Node 25 surface, with the deviations below and nothing else stubbed.

* **Identity**: `pid`, `ppid`, `platform`, `arch`, `execPath`, `argv`, `argv0`,
  `execArgv`, `title` (readable and writable), `version`, `versions`, `release`,
  `config` (frozen), `features`, `allowedNodeEnvironmentFlags`.
* **Clocks and resources**: `hrtime()` with Node's borrow arithmetic and
  `hrtime.bigint()`, `uptime()`, `memoryUsage()` and `memoryUsage.rss()`,
  `resourceUsage()` (all sixteen keys), `cpuUsage()`, `threadCpuUsage()`,
  `availableMemory()`, `constrainedMemory()`.
* **Control**: `exit()`/`exitCode`/`reallyExit` with Node's ordering, `abort()`,
  `kill()` over a platform signal table with a monkey-patchable `_kill()`,
  `chdir()`, `cwd()`, `umask()`, `execve()` (validation and the platform error),
  `getuid`/`geteuid`/`getgid`/`getegid`/`getgroups` on POSIX and **absent** on
  Windows, exactly as in Node.
* **Events and scheduling**: the whole `EventEmitter` surface delegated to one
  emitter, `nextTick` (a FIFO queue over `queueMicrotask`), `emitWarning` with
  Node's full option grammar, `noDeprecation`/`throwDeprecation`/
  `traceDeprecation` honoured synchronously, `uncaughtException` and
  `uncaughtExceptionMonitor`, `setUncaughtExceptionCaptureCallback` and
  `hasUncaughtExceptionCaptureCallback`.
* **Diagnostics**: `getActiveResourcesInfo()` over `node:timers`'
  live-timer table, `_getActiveHandles()`, `_getActiveRequests()`,
  `ref`/`unref`, `binding('util')`, `dlopen`, `setSourceMapsEnabled`,
  `getSourceMapsSupport`, `_rawDebug`.
* **Streams**: minimal `stdout`/`stderr`/`stdin` shims with `write`, `fd`,
  `isTTY` and `columns`/`rows`, written to be replaced by `node:stream`'s real
  `WriteStream`/`ReadStream` rather than to pretend to be them.
* **Errors**: `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE` (both the
  `TypeError` and the `RangeError` form), `ERR_OUT_OF_RANGE`,
  `ERR_UNKNOWN_SIGNAL`, `ERR_UNCAUGHT_EXCEPTION_CAPTURE_ALREADY_SET`,
  `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, `ERR_METHOD_NOT_IMPLEMENTED`,
  `ERR_DLOPEN_FAILED`, and Node's `uvException`/`errnoException` shapes for
  `chdir` and `kill` (`code`, `errno`, `syscall`, `path`, `dest`, and the
  `"ENOENT: no such file or directory, chdir '<cwd>' -> '<target>'"` message).

Both platforms are implemented from libuv's own behaviour: `getrusage`,
`/proc/self/{stat,statm}`, the cgroup v2/v1 memory limit, `getgroups`,
`umask(0)`-and-restore and `prctl(PR_SET_NAME)` on Linux; `GetProcessTimes`,
`GetThreadTimes`, `GetProcessMemoryInfo`, `GetProcessIoCounters`,
`CreateToolhelp32Snapshot`, `GlobalMemoryStatusEx`, the CRT's `_umask`,
`SetConsoleTitleW` and libuv's `uv__kill` (which is why `process.kill(pid,
'SIGHUP')` succeeds on POSIX and is `ENOSYS` here) on Windows.

## Deliberate deviations, each with its reason

1. **`process.env` is accessor-backed, not a `Proxy`.** A `Proxy` is the right
   shape — Node's `process.env` is one — and four of its five traps work in this
   engine (`get`, `set`, `has`, `deleteProperty`, `defineProperty`). `ownKeys`
   never fires, so `Object.keys` over a Proxy comes back empty
   ([zun#6](https://github.com/UrubuCode/zun/issues/6)), and `Object.keys`,
   `{ ...process.env }` and `structuredClone(process.env)` are read by
   `node:child_process` (to build a child's environment), by the harness, and by
   Node's own corpus — `test-util-styletext.js` passes today only because the
   spread works. So each variable is an own **accessor** property instead: a
   read is live, a write to an existing name is a real `setenv`, and enumeration
   is exact. What accessors cannot do is intercept a write to a name that does
   not exist yet, which is precisely what the three env tests below measure. One
   trap away.
2. **The uncaught-exception capture callback is best effort.** The engine has no
   "uncaught exception" hook: an error that escapes the main script ends the
   program before any JavaScript runs. What this library *can* route is every
   throw it catches on a callback boundary — a `process.nextTick` callback and a
   timer callback — and it does, through one function that
   `src/timers/timers.ts` also calls, so the capture callback, the
   `uncaughtExceptionMonitor` event and the `uncaughtException` listeners are
   consulted in Node's order whichever boundary the throw crossed.
3. **`process` is an object literal, so it has no `EventEmitter` prototype.** An
   object-literal method is the only shape that can carry a rest parameter and
   `arguments` at the same time here, and `process.emit(type, ...args)` needs
   both. The cost is `Object.getPrototypeOf(process)`, which
   `test-process-prototype.js` reads.
4. **`versions` names only `node` and `zun`.** No V8, libuv, OpenSSL, ICU,
   nghttp2 or zlib is embedded, so advertising their versions would be a lie;
   an absent key is the honest answer for an absent component, and the corpus's
   `if (process.versions.icu)` branches take the right path because of it.
   `version` is `v25.0.0` because that is the Node release this library's
   behaviour is defined by.
5. **`allowedNodeEnvironmentFlags` holds the flags this runtime honours** —
   `--no-deprecation`, `--no-warnings`, `--pending-deprecation`,
   `--throw-deprecation`, `--title`, `--trace-deprecation`, read out of
   `NODE_OPTIONS` — not Node's own flag list, which this runtime does not
   implement and would be a lie to advertise.
6. **`memoryUsage()`'s four heap figures are zero.** Node takes them from V8's
   heap statistics; this runtime's host surface exposes none, and an obvious
   zero is better than an invented number. `rss` is real.
7. **`process.execve` validates and then refuses.** Replacing the process image
   has no Windows equivalent at all (where Node raises
   `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, which this does too), and on POSIX it
   would replace the runtime with another program mid-call — the engine would be
   executing JavaScript on a stack that no longer exists. Every argument error
   Node's own test expects is raised; a call that passes validation is
   `ERR_METHOD_NOT_IMPLEMENTED`.
8. **`process.binding(name)` answers only `'util'`.** Node 25 still has the
   deprecated accessor over an allowlist of internal bindings. This runtime has
   exactly one of those surfaces — the sixteen `util.types` predicates, which in
   Node *are* that binding — so `binding('util')` is a projection of
   `util.types`, and every other name is the `No such module: <name>` error Node
   raises for a name outside its own list. Nothing is stubbed into existence.
9. **`process.dlopen` always throws.** A native addon is built against Node's
   own C++ ABI, which this runtime does not have.

## Status and what blocks the rest

[`RESULTS.md`](RESULTS.md) is the live per-test table, with the first line of
stderr for each failure; it and the README bar are regenerated by every tracker
run, so they — not this page — are the current number. What follows is the
*cause* of each remaining failure, grouped, because the groups are what a reader
can act on.

### Harness modules the bundler does not provide (17 files)

The bundler fails a test loudly when it requires a module it does not know,
rather than letting the engine report a mystery. These are those files, with the
module each needs:

| Test | Needs |
|---|---|
| `test-process-beforeexit.js` | `net` |
| `test-process-execve-socket.js` | `net` |
| `test-process-getactivehandles.js` | `net` |
| `test-process-getactiveresources-track-active-handles.js` | `net` |
| `test-process-binding.js` | `internal/test/binding` |
| `test-process-hrtime.js` | `internal/test/binding`, and `eval('%OptimizeFunctionOnNextCall')` |
| `test-process-hrtime-bigint.js` | `internal/test/binding`, same `eval` |
| `test-process-exception-capture-should-abort-on-uncaught-setflagsfromstring.js` | `v8` |
| `test-process-env-sideeffects.js` | `inspector` |
| `test-process-env-allowed-flags-are-documented.js` | `../common/crypto`, and Node's own `doc/api/cli.md` |
| `test-process-exit-code.js` | `../common/process-exit-code-cases` |
| `test-process-raw-debug.js` | `../common/hijackstdio` |
| `test-process-warning.js` | `../common/hijackstdio` |
| `test-process-versions.js` | `../../deps/{acorn,undici,cjs-module-lexer}/package.json` |
| `test-process-load-env-file.js` | `../../test/common/fixtures` (an `.env` fixture tree) |
| `test-process-get-builtin.mjs` | ESM, `node:module` |
| `test-process-warnings.mjs` | ESM, `node:test` over `../common/index.mjs` |

`hijackstdio` is the cheapest of these to add and would unlock
`test-process-warning.js` on its own; `net`, `v8`, `inspector` and
`internal/test/binding` are facilities this platform does not have.

### A child process that has to be Node (13 files)

`test-process-{argv-0, env, exec-argv, external-stdio-close,
external-stdio-close-spawn, kill-null, ppid, really-exit, redirect-warnings,
redirect-warnings-env, remove-all-signal-listeners,
uncaught-exception-monitor}.js` and `test-process-exit-code-validation.js` all
re-run *themselves* as `spawn(process.execPath, [__filename, …])`. `execPath` is
real here (it is the `zun` binary), but the child would be
`zun run <the test file>` — a CommonJS `.js` with `require` calls that the
engine cannot load, because the bundler is a build step and not a module loader.
Several of them also need the asynchronous `child_process` half, which needs
`node:stream`. This is the same blocker `test/child_process/README.md` records
for most of its corpus. (`test-process-execpath.js` and
`test-process-getgroups.js` are in this shape too and **pass**: the first only
needs the spawn to fail, and the second takes a `common.skip` branch.)

### Engine gaps (11 files)

| Test | Blocker |
|---|---|
| `test-process-env-symbols.js` | `delete obj[symbol]` is rejected at compile time: "`delete obj[k]` requires a string key" |
| `test-process-ref-unref.js` | a class computed member must be one of five well-known symbols, so the test's own `[Symbol.for('nodejs.ref')]() {}` does not compile ([zun#25](https://github.com/UrubuCode/zun/issues/25)) |
| `test-process-emitwarning.js` | the test's `CustomWarning` constructor calls `Error.captureStackTrace`, which does not exist in this engine; the file also spreads an argument array into a call |
| `test-process-prototype.js` | `process instanceof process.constructor` — the right operand is not a resolvable class ([zun#25](https://github.com/UrubuCode/zun/issues/25)) |
| `test-process-threadCpuUsage-main-thread.js` | `const { ok, throws } = require('assert')` at top level, then read from inside a function — invisible there ([zun#34](https://github.com/UrubuCode/zun/issues/34)) |
| `test-process-uid-gid.js` | CommonJS top-level `return`, which is a parse error in a bundle (the bundler inlines the test body at program top level, where Node wraps it in a module function) |
| `test-process-euid-egid.js` | same top-level `return` |
| `test-process-initgroups.js`, `test-process-setgroups.js` | same top-level `return`; on Windows both assert the function is absent, which it is, and then `return` |
| `test-process-default.js` | `import('node:process')` — no dynamic import |
| `test-process-finalization.mjs` | ESM plus `FinalizationRegistry` |

And two more that are the *engine boundary* rather than a bug:
`test-process-exception-capture.js` and
`test-process-exception-capture-should-abort-on-uncaught.js` both `throw` from
the top level of the test and expect the capture callback to see it. Nothing in
this library runs after that throw — the engine ends the program — which is
deviation 2 above. The third file of that trio,
`test-process-exception-capture-errors.js`, exercises only the validation and
passes.

The top-level `return` group is a *harness* gap with a known fix — wrapping the
inlined test body in a function, the way CommonJS does — which is deliberately
not taken here: it would change how **every** module's tests are bundled, and
the four files it unlocks are Windows-only (on Linux they continue into
`setuid`/`setgid`, which this module does not implement).

### Deliberate deviations above (6 files)

`test-process-env-delete.js`, `test-process-env-deprecation.js` and
`test-process-env-ignore-getter-setter.js` all need a `Proxy`'s `set` or
`defineProperty` trap on `process.env` (deviation 1).
`test-process-env-allowed-flags.js` asserts Node's own flag list and
`Set.prototype.add.call` (deviation 5, plus zun#25).
`test-process-title-cli.js` runs with `--title=foo`, which the tracker does not
pass to the engine; `process.title` does honour `--title=` when it is there.
`test-process-env-tz.js` sets `process.env.TZ` and expects `Date` to follow;
`setenv` is real here, but the engine's date formatting reads the timezone once,
so a mid-run change is not observed.

### Resources this runtime does not have (4 files)

`test-process-getactiverequests.js` and
`test-process-getactiveresources-track-active-requests.js` open twelve
*asynchronous* `fs` requests and count them; `node:fs` here is synchronous with
its callbacks on `nextTick`, so there is no libuv request to count, and
`_getActiveRequests()` answers `[]` rather than fabricating twelve.
`test-process-binding-internalbinding-allowlist.js` asks for twenty internal
bindings (deviation 8). `test-process-chdir.js` and
`test-process-dlopen-error-message-crash.js` need `../common/tmpdir` over the
asynchronous `fs` surface.

## Rust-side verification

`src/process/tests.rs` drives `zun_register_v1` into an `OwnedRegistry` and
invokes every native by key through the real checked-invocation path — the same
path the host uses — asserting the *invariants* Node's own tests assert rather
than absolute figures a machine decides: a monotonic `hrtime`, non-decreasing
CPU time across a busy loop, sixteen `resourceUsage` fields, a `kill(pid, 0)`
that succeeds for this process and reports `ESRCH` for one that cannot exist, a
`chdir` failure carrying both paths and the exact libuv description, a `umask`
read that does not clear the mask, an environment round trip through
`procSetEnv`, and the frame encoders and libuv error table on their own. It also
asserts that no `node:process` key is published by another module in this
library and that none of them is a bare name `node:os` already owns, which is
the constraint [zun#35](https://github.com/UrubuCode/zun/issues/35) imposes.

## Engine bugs this corpus found

* **`Object.hasOwn` and `hasOwnProperty` are blind to an accessor property.**
  `Object.keys`, `in` and `Object.getOwnPropertyNames` all see it; those two
  answer `false`. It is why `process.config`, `process.features` and
  `process.allowedNodeEnvironmentFlags` are plain data properties here rather
  than the lazy getters they would naturally be — `test-process-config.js` opens
  with `assert(Object.hasOwn(process, 'config'))`.

  ```js
  const o = {};
  Object.defineProperty(o, 'g', { enumerable: true, get() { return 1; } });
  Object.hasOwn(o, 'g');   // zun: false     node: true
  o.hasOwnProperty('g');   // zun: false     node: true
  Object.keys(o);          // zun: ["g"]     node: ["g"]
  ```

* **A `functionBox` on an object property is not callable as a member.** The box
  reports `typeof === "function"` and is callable through a bare identifier, but
  `obj.f()` throws `f is not a function`. So do
  `Object.defineProperty(obj, 'f', { value: fn })`. What does work is a plain
  assignment of a function value, including a function hung off another function
  — which is how `process.hrtime.bigint` and `process.memoryUsage.rss` exist.
  The five shapes are listed at that assignment in `../../src/process/process.ts`.

* **A `Proxy` property key may not be a symbol**, and `delete proxy[k]` /
  `delete obj[k]` require a string key, both rejected at compile time. That is
  the second half of what blocks `test-process-env-symbols.js`.

* **A frozen `Set` is still mutable**, and `Set.prototype.add` reads
  `undefined`, so neither half of
  `test-process-env-allowed-flags.js`' immutability check can be satisfied by
  correct code.

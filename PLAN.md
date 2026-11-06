# zun-node — Node.js compatibility library for Zun

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform. The Zun engine core holds only base logic; libraries like this one sit
outside it — either **behind the ABI** (a Rust `cdylib` exporting
`zun_register_v1`) or **in Zun TypeScript**, compiled by the platform's own
compiler. Which form a module takes follows from what the module needs (see
principle 2).

**Baseline: Node.js 25.** The oracle for "done" is Node's own test suite (`test/` in
nodejs/node): **a library is not finished until it passes 100% of the Node tests
that apply to it.**

## Principles

1. **Library by library, finished before moving on.** Order: **`fs` → `process` →
   `path` → `os` → `events` → `stream` → `buffer` → …**. Do not start the next
   library until the current one passes 100% of its applicable Node tests.
   *Exception by capability, not by preference:* `path` can be driven to 100%
   ahead of `fs`, because it needs no host harness beyond the test bundler —
   whereas `fs`'s tests additionally need Buffers, file descriptors,
   callbacks/promises and the `test/fixtures/` tree. The order above still
   governs which library's *API surface* is owed next.
   *Second exception, by dependency:* **`events` was taken before `os`.** Node's
   `process` **is** an `EventEmitter`, and the test harness cannot verify a
   single `common.mustCall` count without `process.on('exit')`,
   `process.on('warning')` and `process.nextTick` — all of which need `events`
   to exist first. Taking `events` early is therefore what makes the *harness*
   real for every later library; `os` is still owed ahead of `stream`.
2. **The implementation form follows the capability.**
   - A module that needs the operating system is **native through the ABI**: Rust
     over `std`, exposed as `zun_abi` functions under a `node:<name>` module key,
     depending on `zun_abi` alone — no VM, interpreter, or allocator dependency.
     `fs` is this kind.
   - A module that is **pure computation** is written in **Zun TypeScript** and
     compiled by the platform. Crossing the ABI would buy nothing and would cost
     a marshalling convention. `path` is this kind (`src/path/path.ts`): it is
     string manipulation end to end.
   - A module that is **both** draws the seam where the capability changes:
     **TypeScript over natives**. `os` is this kind, and most Node modules are:
     only a handful of its entry points touch the kernel, while everything a
     caller actually sees — the objects, the arrays, `constants`, the argument
     validation, the `ERR_*` errors — is shape. Putting the shape behind the ABI
     would mean marshalling it; putting the syscalls in TypeScript is impossible.
     So the extension answers only the facts, and `src/os/os.ts` builds Node's
     module on top, reaching them with `import * as native from "node:os"`. See
     *TS over natives* under Architecture.
3. **No module graph beyond the engine.** Implement the maximum API that does not
   require a third-party package or the signed module registry. Self-contained.
4. **Dependency rule.** If a module needs a capability another unfinished module
   owns, implement *just that piece* to unblock — but never leave a module before
   its own internal dependency is finished. This is why `src/assert/assert.ts`
   and `src/process/process.ts` exist: Node's `path` tests are written against
   `assert` and read `process.cwd()` / `process.platform`, so the slice of each
   that the corpus actually uses is implemented, and no more.

## Architecture

```
src/fs/      ──[cdylib, zun_register_v1]──▶ zun_abi ◀──[loads + invokes]── Zun host
src/os/*.rs  ──[same cdylib]─────────────────▶ zun_abi ◀────┐ (facts: syscalls)
src/os/os.ts ──[compiled by the Zun compiler]───────────────┘ (shape: TS over natives)
src/path/    ──[path.ts]──────────────────▶ compiled by the Zun compiler, run by the VM
src/events/  ──[events.ts]────────────────▶ same route
src/util/    ──[util.ts]─────────────────┐  harness slices (principle 4), same route
src/assert/  ──[assert.ts]               │
src/process/ ──[process.ts, zun:core]────┘
```

Bundle order is dependency order: `util` (no dependencies) → `events`
(`util.inspect` for its messages) → `process` (an `EventEmitter`) → `assert` →
`path` → `os` (the `ERR_*` classes from `events`, `process.env` for `tmpdir()`)
→ `tools/harness/common.ts`.

### TS over natives (the `os` pattern, and the one `fs` will take)

`os` is the first module written as **Zun TypeScript on top of extension
natives**, and the split is deliberate rather than incidental:

- **The extension answers only what needs the kernel.** `src/os/{facts,stats,net,user}.rs`
  are thin ABI wrappers over `src/os/sys/{unix,windows}.rs`, which is where the
  syscalls live. Each one documents the libuv entry point Node calls and follows
  it where the result is observable.
- **The TypeScript is the module.** `src/os/os.ts` holds every object and array
  shape, the per-platform `constants` tables, `EOL`/`devNull` with Node's own
  property attributes, `validateInt32`, `ERR_SYSTEM_ERROR`, the `tmpdir()`
  environment rules and the CIDR arithmetic. None of that is a syscall, and all
  of it would need a marshalling convention if it lived behind the ABI.
- **Structured results cross as one string.** ABI v1's carrier is a single
  scalar word, so a CPU table or an interface list cannot cross as a structure.
  `os` fixes the convention: `"+"` then records separated by U+001E, fields by
  U+001F; `"-"` means the call failed and the four error slots describe it. The
  separators are C0 controls, so no payload can contain one, and no quoting or
  escaping rule exists for the two sides to disagree about. One call captures a
  whole table, so its rows are a coherent snapshot rather than a sample smeared
  across one call per field — which matters for CPU times, that move while they
  are read. The grammar is documented in `src/lib.rs` and `src/os/mod.rs`.
- **Failure is reported in band, not as a status.** The ABI has an error status,
  but an exception thrown out of an extension call escapes an enclosing
  `try`/`catch` in the host today, so a status-based failure could never become
  a catchable `ERR_SYSTEM_ERROR`. The natives therefore always return
  successfully and say `"-"`, and the TypeScript raises Node's `SystemError`
  from the slots — `errorSyscall`, `errorCode`, `errorErrno`, `errorMessage`.
- **Keys are unique across modules.** Those four readers are `node:fs`'s
  `lastError*` functions under different names, because the checker rejects a
  program as soon as a single function *name* is registered by two modules,
  even when every use site is a namespace member access naming its module.

The tracker knows this as a third module kind, `zun-ts+ext`: bundle the test
like a TypeScript module, then run the bundle with `--ext`.

- **`src/lib.rs`** — `zun_register_v1`, the ABI carrier helpers (`abi` module), the
  shared `Descriptor` type, and shared error retrieval. Extension modules only.
- **`src/<module>/`** — one folder per Node module (Node's modules are large).
  - An extension module has a `mod.rs` with the module's `DESCRIPTORS` table and
    submodules by area; e.g. `src/fs/{mod,rw,dirs,meta,links}.rs`. Each function
    is a `zun_abi::ZunInvoke` over `std`.
  - A Zun TypeScript module is `<name>.ts` in the same place; e.g.
    `src/path/path.ts`. It depends on the engine only through `zun:core`
    (`src/process/process.ts` is the only one that does so today, for `cwd`/`env`).
- **`tools/`** — the compatibility tracker (`run_node_tests.sh`), the test bundler
  (`bundle_node_test.sh`) and the `test/common` harness (`harness/common.ts`).
- **`test/<module>/`** — that module's Node test inventory (`NODE_TESTS.txt`),
  status write-up (`README.md`) and generated results (`RESULTS.md`). See
  `test/fs/` and `test/path/`.

The Rust side is built as a `cdylib`; the host loads it (by name or embedded in a
`.zmlib`) and calls `zun_register_v1`. It is also an `rlib`, so every native
module is unit-tested as plain Rust against the real `zun_abi` registration +
checked-invocation path. The Zun TypeScript side needs no build step at all: the
engine compiles it.

### ABI v1 carrier convention (fixed by this crate, see `src/lib.rs`)

ABI v1's `ZunValue` is a single-word payload, so this crate fixes a simple,
host-agnostic convention until a richer ABI version lands:

- **`Str` argument:** `payload` is a `*const c_char` (host-owned, NUL-terminated
  UTF-8, valid for the call).
- **`Str` result:** stored in a per-thread scratch `CString`; `payload` is its
  pointer, valid until the next call on that thread (the host copies it out first).
- **Multi-value string results** (e.g. `readdirSync`) join on `/`, which cannot
  occur in a path component and (unlike NUL) survives the NUL-terminated carrier.
- **Errors:** a failing call stashes a Node-accurate `(code, message)` per thread
  and returns a non-zero status; the host/wrapper reads them via the module's
  `lastErrorCode` / `lastErrorMessage` functions to build a JS error whose
  `code`/`message` match Node's.

This convention applies to extension modules only. `path` returns real JS strings
and objects, because it is compiled, not marshalled.

## Compatibility tracker

`tools/run_node_tests.sh` + `.github/workflows/node-compat.yml` download Node 25's
`test-<module>*.js` at a pinned tag (a module's corpus may span several prefixes —
`events` is `test-event-emitter-*` plus `test-events-*`), run each through `zun`, and render the pass
share into the README (a progress bar + percentage) and `test/<module>/RESULTS.md`,
with the first line of stderr recorded for every failure. A test passes when the
`zun run` invocation exits 0. Tests are downloaded into `<work>/test/parallel/`,
because several of them assert their own location through `__dirname`.

The runner knows all three module kinds:

- **extension modules** run as `zun run --ext <lib> <test.js>`; `--ext` is
  required for them.
- **Zun TypeScript modules** are bundled first and run as `zun run <bundle.ts>`,
  with no `--ext`.
- **Zun TypeScript over natives** (`zun-ts+ext`) are bundled first *and* need
  `--ext`: `zun run --ext <lib> <bundle.ts>`. `os` is this kind.

### The test bundler

The engine has no CommonJS `require` and no file-based module resolution
([zun#4](https://github.com/UrubuCode/zun/issues/4)), while every Node test opens
with `require('assert')` / `require('path')` / `require('../common')`. Rather than
block the measurement on module resolution,
`tools/bundle_node_test.sh <node-test.js> <out.ts>` turns one test into one Zun
program: it concatenates the modules in bundle order ahead of the test body,
injects `__filename`/`__dirname`, rewrites the test's `require` lines, and
appends the one statement that settles the event loop and verifies the
`common.mustCall` counts.

The `require` convention is generic: **each inlined module exposes exactly one
object**, named `__node_<module>` (`__node_events`, `__node_assert`, ...), and
`require('x')` / `require('node:x')` both become that object. One refinement sits
on top: a module that is *already bound* under the name the tests use has that
whole-line declaration deleted instead (`const path = require('path');`), and for
`events` the canonical binding is the **class** `EventEmitter` rather than an
object, because `new <identifier>()` only compiles for a statically known class
— so `EventEmitter` is also removed from a destructuring pattern and left bound
to the class, while the other destructured names come from `__node_events`. An
unknown module makes the bundle fail with a named diagnostic, so a missing
harness module is never mistaken for an engine bug.

Exit verification is the harness's other job. The VM drains its unified event
loop after the main script returns but exposes no "about to exit" hook, so the
bundler's epilogue (`__zunHarnessFinish()`) runs a *settle loop*: a chain of
`setTimeout` turns that yields to the VM's timer and microtask queues until
`process.nextTick` has been quiet for a fixed number of turns, then emits
`process` 'exit' and exits non-zero if a `common.mustCall` count was not met.
See the header of `tools/harness/common.ts`.

When CommonJS resolution does land in the engine, the bundler is the thing that
gets deleted; nothing else in the tracker changes.

## Status

- **`node:path`: implemented in `src/path/path.ts`, measured against the full
  Node corpus.** The POSIX and Windows surfaces are both there —
  `normalize`, `join`, `resolve`, `relative`, `isAbsolute`, `dirname`,
  `basename`, `extname`, `parse`, `format`, `toNamespacedPath`, `matchesGlob`,
  `sep`, `delimiter`, `posix`, `win32` — written against Node 25's
  `test/parallel/test-path*.js` (17 files). Current measurement and the per-test
  failure notes are in `test/path/` (regenerated by the tracker, so the README
  block is the live number). **Every remaining failure is an engine gap, not a
  `path.ts` gap**: differential runs against Node (~36 000 assertions over both
  namespaces and every function) show zero divergences. `test-path-join.js` and
  `test-path-resolve.js` are blocked by the `apply`/spread/`concat`/function-value
  issues ([zun#1](https://github.com/UrubuCode/zun/issues/1),
  [#15](https://github.com/UrubuCode/zun/issues/15),
  [#16](https://github.com/UrubuCode/zun/issues/16),
  [#17](https://github.com/UrubuCode/zun/issues/17)), plus a Windows-only
  `child_process.spawnSync` block in `resolve`; `test-path-parse-format.js` needs a
  callable `assert` with methods ([zun#14](https://github.com/UrubuCode/zun/issues/14)).
  `path.ts` carries marked workarounds for [zun#2](https://github.com/UrubuCode/zun/issues/2),
  [#3](https://github.com/UrubuCode/zun/issues/3), [#7](https://github.com/UrubuCode/zun/issues/7)
  and [#13](https://github.com/UrubuCode/zun/issues/13). The full table is in
  `test/path/README.md`. A security pass against Node's path CVEs (CVE-2025-23084,
  CVE-2025-27210 and their follow-ups, `toNamespacedPath`, `\\?\` roots) found
  the current implementation matches fixed Node on all 389 attack inputs.
- **`node:fs` (sync surface): in progress, split across `src/fs/`.** Implemented:
  existsSync, accessSync, readFileSync (utf8), writeFileSync, appendFileSync,
  truncateSync, mkdirSync, rmdirSync, unlinkSync, rmSync, readdirSync, mkdtempSync,
  statSync/lstatSync (kind/size/mtimeMs/atimeMs/birthtimeMs), realpathSync,
  renameSync, copyFileSync, linkSync, symlinkSync, readlinkSync, plus
  lastErrorCode/lastErrorMessage. 8 crate tests green (`cargo test`). **Not done:**
  the acceptance bar is 100% of Node 25's `test-fs-*` suite (227 files — see
  `test/fs/`), which also needs Buffers, fds, callbacks/promises, streams, watch,
  Dirent, and the full `Stats`; those land in their own `src/fs/` submodules. Its
  tracker number stays near 0% until the Node-API shaping and the
  `test/fixtures/` tree exist.
- **`node:events`: implemented in `src/events/events.ts`, measured against the
  full Node corpus.** The whole `EventEmitter` surface is there —
  `on`/`addListener`, `prependListener`, `once`, `prependOnceListener`,
  `off`/`removeListener`, `removeAllListeners`, `emit` with the
  `error`/`errorMonitor`/`ERR_UNHANDLED_ERROR` semantics, `listeners`,
  `rawListeners`, `listenerCount` (with the listener argument), `eventNames`
  (strings and symbols), `setMaxListeners`/`getMaxListeners`, the
  `newListener`/`removeListener` meta-events, the MaxListenersExceededWarning
  through `process.emitWarning`, and `captureRejections` — plus the module
  statics `once`, `on`, `getEventListeners`, `getMaxListeners`,
  `setMaxListeners`, `listenerCount`, `addAbortListener`, `errorMonitor`,
  `captureRejectionSymbol`, `defaultMaxListeners`, `usingDomains`. Listener
  storage is null-prototype-safe, so a `__proto__` event name works. A
  differential self-test over every method, both meta-events, the error paths,
  the warning text and the storage shapes passes clean; **every remaining test
  failure is an engine gap**, catalogued test by test in `test/events/README.md`
  (member `new`, class statics, no receiver threading, symbol identity, class
  bases, `internal/` modules). **Not done:** `EventEmitterAsyncResource`, which
  needs `async_hooks` — there is nothing to build it on, so it is absent rather
  than faked.
- **`node:os`: complete, split across `src/os/` (natives) and
  `src/os/os.ts` (the module).** Every documented entry point is there —
  `arch`, `availableParallelism`, `cpus`, `endianness`, `freemem`,
  `getPriority`, `homedir`, `hostname`, `loadavg`, `machine`,
  `networkInterfaces`, `platform`, `release`, `setPriority`, `tmpdir`,
  `totalmem`, `type`, `uptime`, `userInfo`, `version`, plus `EOL`, `devNull`
  and `constants` (`signals`, `errno`, `priority`, `dlopen`,
  `UV_UDP_REUSEADDR`) with the per-platform values Node reports, the
  `validateInt32` errors (`ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`) and
  `ERR_SYSTEM_ERROR` with Node's `SystemError` name, `errno`, `syscall` and
  `info`. **Windows and Linux are both implemented** from libuv's own behavior:
  `/proc` plus `getifaddrs`/`getpwuid_r`/`getpriority` on Linux;
  `GetAdaptersAddresses`, `NtQuerySystemInformation`, `GlobalMemoryStatusEx`,
  the `CentralProcessor` registry keys and the priority-class mapping on
  Windows. A differential run against Node over 140 values — every string fact,
  the whole `constants` table, every CPU row, every interface entry with its
  CIDR and scope id, `userInfo()` in both encodings, all eight validation
  messages, and every `tmpdir()` environment rule — shows **zero divergences on
  both platforms**. **Not done, by capability:**
  `userInfo({ encoding: 'buffer' })` returns a documented byte view rather than
  a `Buffer`, because `node:buffer` does not exist yet; one function changes
  when it does. The remaining test failures are all outside this module
  (`internal/test/binding`, `node:child_process`, a callable `assert`, a
  constructor used as a value) — the table is in `test/os/README.md`. 28 crate
  tests green on both platforms (`cargo test`).
- **`node:util` (harness slice): `src/util/util.ts`.** `inspect` (with
  `inspect.custom`, `depth`, and the `[Constructor]` form `depth: -1` produces),
  `format`, `inherits`, `types.isPromise`, `isDeepStrictEqual`. It exists because
  `events` formats `ERR_UNHANDLED_ERROR` and the MaxListenersExceededWarning with
  `util.inspect`, and Node's `test-event-emitter-errors.js` reads
  `util.inspect.custom`. Not the finished module.
- **`node:assert` (harness slice): `src/assert/assert.ts`.** `ok`, `equal`,
  `notEqual`, `strictEqual`, `notStrictEqual`, `deepStrictEqual`,
  `notDeepStrictEqual`, `throws`, `doesNotThrow`, `match`, `doesNotMatch`,
  `fail`, `AssertionError` with Node's `code`/`actual`/`expected`/`operator`.
  Not the finished module: it is what the corpus asserts with.
- **`node:process` (harness slice): `src/process/process.ts`.** `cwd()`, `env`,
  `platform`, `argv`, `exit()`, `stdout`/`stderr`, over `zun:core`'s `host`, plus
  the **EventEmitter surface** Node's `process` has
  (`on`/`once`/`off`/`emit`/`listeners`/`listenerCount`/`eventNames`/`setMaxListeners`,
  delegated to one `EventEmitter` instance), `nextTick` (a FIFO queue over
  `queueMicrotask`), `emitWarning` (which the events module's warning route is
  wired to), and `exitCode`. `platform` is derived from the shape of `cwd()`
  because no host native reports the OS yet. Not the finished module; the full
  `process` is still owed in the order above.

### Module keys and host dispatch

The native surface is registered under `node:fs` and `node:os`, so those import
specifiers resolve. The engine already dispatches external module calls at runtime through
`CallHook::try_call_external(module, name, args)` (with string marshalling), and
loads native extensions through `zun_abi` — **no `zun:core` core change is needed**.
Wiring is a matter of loading this extension and routing `node:fs` external calls
to its registered functions, in the engine's existing format.

**That routing is now exercised end to end**, by `os`: a program that writes
`import * as native from "node:os"` and calls `native.hostname()` reaches this
crate's descriptor through the existing path — `zun run --ext` →
`zun_compiler::external_functions_all` (which derives the compiler's external
declarations from what the extension registered, so the toolchain hardcodes
nothing) → the checker's namespace-import resolution →
`CallHook::try_call_external` at run time. No `zun:core` change was needed, as
predicted. Two limits surfaced in the process and are documented at their use
sites in `src/os/mod.rs`: a function *name* may be registered by only one
module, and an error thrown out of an extension call is not catchable.

`cargo test` here remains the verification path for a native that no program
calls yet (it drives the real `zun_abi` registration + checked-invocation path).
The Zun TypeScript modules need no routing at all: they are compiled into the
program, which is why `path` was measurable against Node's suite before any of
this existed.

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
2. **The implementation form follows the capability.**
   - A module that needs the operating system is **native through the ABI**: Rust
     over `std`, exposed as `zun_abi` functions under a `node:<name>` module key,
     depending on `zun_abi` alone — no VM, interpreter, or allocator dependency.
     `fs` is this kind.
   - A module that is **pure computation** is written in **Zun TypeScript** and
     compiled by the platform. Crossing the ABI would buy nothing and would cost
     a marshalling convention. `path` is this kind (`src/path/path.ts`): it is
     string manipulation end to end.
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
src/path/    ──[path.ts]──────────────────▶ compiled by the Zun compiler, run by the VM
src/assert/  ──[assert.ts]───────────────┐  harness slices (principle 4), same route
src/process/ ──[process.ts, zun:core]────┘
```

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
`test-<module>*.js` at a pinned tag, run each through `zun`, and render the pass
share into the README (a progress bar + percentage) and `test/<module>/RESULTS.md`,
with the first line of stderr recorded for every failure. A test passes when the
`zun run` invocation exits 0. Tests are downloaded into `<work>/test/parallel/`,
because several of them assert their own location through `__dirname`.

The runner knows both module kinds:

- **extension modules** run as `zun run --ext <lib> <test.js>`; `--ext` is
  required for them.
- **Zun TypeScript modules** are bundled first and run as `zun run <bundle.ts>`,
  with no `--ext`.

### The test bundler

The engine has no CommonJS `require` and no file-based module resolution
([zun#4](https://github.com/UrubuCode/zun/issues/4)), while every Node test opens
with `require('assert')` / `require('path')` / `require('../common')`. Rather than
block the measurement on module resolution,
`tools/bundle_node_test.sh <node-test.js> <out.ts>` turns one test into one Zun
program: it concatenates `src/process/process.ts`, `src/assert/assert.ts`,
`src/path/path.ts` and `tools/harness/common.ts` ahead of the test body, injects
`__filename`/`__dirname`, and rewrites the test's `require` lines — a whole-line
`const path = require('path');` is deleted, because the inlined module already
binds that name, and inline forms (`require('path/win32')`, `require('assert')`)
are rewritten to the corresponding binding. Any surviving `require(` is reported,
so a missing harness module is never mistaken for an engine bug.

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
- **`node:assert` (harness slice): `src/assert/assert.ts`.** `ok`, `equal`,
  `notEqual`, `strictEqual`, `notStrictEqual`, `deepStrictEqual`,
  `notDeepStrictEqual`, `throws`, `doesNotThrow`, `match`, `doesNotMatch`,
  `fail`, `AssertionError` with Node's `code`/`actual`/`expected`/`operator`.
  Not the finished module: it is what the corpus asserts with.
- **`node:process` (harness slice): `src/process/process.ts`.** `cwd()`, `env`,
  `platform`, `argv`, `exit()`, over `zun:core`'s `host`. `platform` is derived
  from the shape of `cwd()` because no host native reports the OS yet. Not the
  finished module; the full `process` is still owed in the order above.

### Module keys and host dispatch

The native surface is registered under `node:fs`, so that import specifier
resolves. The engine already dispatches external module calls at runtime through
`CallHook::try_call_external(module, name, args)` (with string marshalling), and
loads native extensions through `zun_abi` — **no `zun:core` core change is needed**.
Wiring is a matter of loading this extension and routing `node:fs` external calls
to its registered functions, in the engine's existing format.

Until that routing is exercised from a user program, `cargo test` here is the
verification path for the native side (it drives the real `zun_abi` registration +
checked-invocation path). The Zun TypeScript modules need no such routing: they
are compiled into the program, which is exactly why `path` is already measurable
against Node's suite while `fs` is not.

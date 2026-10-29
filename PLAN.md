# zun-node — Node.js compatibility library for Zun

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform, implemented as a **native Zun extension**: a Rust `cdylib` that exports
`zun_register_v1` and publishes each Node module's functions through the stable
`zun_abi` contract. The Zun engine core holds only base logic; libraries like this
one are reached **through the ABI**, not baked into the core.

**Baseline: Node.js 25.** The oracle for "done" is Node's own test suite (`test/` in
nodejs/node): **a library is not finished until it passes 100% of the Node tests
that apply to it.**

## Principles

1. **Library by library, finished before moving on.** Order: **`fs` → `process` →
   `path` → `os` → `events` → `stream` → `buffer` → …**. Do not start the next
   library until the current one passes 100% of its applicable Node tests.
2. **Native through the ABI.** Each module is Rust over `std`/the OS, exposed as
   `zun_abi` functions under a `node:<name>` module key. The crate depends on
   `zun_abi` alone — no VM, interpreter, or allocator dependency.
3. **No module graph beyond the engine.** Implement the maximum API that does not
   require a third-party package or the signed module registry. Self-contained.
4. **Dependency rule.** If a module needs a capability another unfinished module
   owns, implement *just that piece* to unblock — but never leave a module before
   its own internal dependency is finished.

## Architecture

```
zun-node (this repo) ──[cdylib, zun_register_v1]──▶ zun_abi ◀──[loads + invokes]── Zun host
```

- **`src/lib.rs`** — `zun_register_v1`, the ABI carrier helpers (`abi` module), the
  shared `Descriptor` type, and shared error retrieval.
- **`src/<module>/`** — one folder per Node module (Node's modules are large). Each
  has a `mod.rs` with the module's `DESCRIPTORS` table and submodules by area; e.g.
  `src/fs/{mod,rw,dirs,meta,links}.rs`. Each function is a `zun_abi::ZunInvoke` over
  `std`.
- **`test/<module>/`** — that module's Node test corpus and status (see
  `test/fs/README.md` and `test/fs/NODE_TESTS.txt`).

Built as a `cdylib`; the host loads it (by name or embedded in a `.zmlib`) and calls
`zun_register_v1`. It is also an `rlib`, so every module is unit-tested as plain
Rust against the real `zun_abi` registration + checked-invocation path.

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

## Compatibility tracker

`tools/run_node_tests.sh` + `.github/workflows/node-compat.yml` download Node 25's
`test-<module>-*.js` at a pinned tag, run each through `zun` with this extension
loaded, and render the pass share into the README (a progress bar + percentage) and
`test/<module>/RESULTS.md`. A test passes when `zun run` exits 0. The baseline is
**0% for `fs`** (227 tests): Node's tests need a compatibility harness that does not
exist yet. The path to raise the number, in order:

1. **CommonJS `require` + module resolution** (Node tests are `require('fs')`,
   `require('../common')`, `require('assert')`), including `node:` specifier
   normalization so bare `fs` resolves.
2. **A `common` + `assert` harness** (the `test/common` helpers and `assert` the
   suite leans on), and `node:test` where newer tests use it.
3. **Node-API shaping** over the low-level extension natives: `readFileSync`
   options/Buffer, a `Stats` object with `isFile()`/`size`/…, callback and promise
   forms, file descriptors.

Each lands in its own `src/<module>/` area (or a shared harness module) and is
ticked off by the percentage climbing, never by self-written tests.

## Status

- **`node:fs` (sync surface): in progress, split across `src/fs/`.** Implemented:
  existsSync, accessSync, readFileSync (utf8), writeFileSync, appendFileSync,
  truncateSync, mkdirSync, rmdirSync, unlinkSync, rmSync, readdirSync, mkdtempSync,
  statSync/lstatSync (kind/size/mtimeMs/atimeMs/birthtimeMs), realpathSync,
  renameSync, copyFileSync, linkSync, symlinkSync, readlinkSync, plus
  lastErrorCode/lastErrorMessage. 8 crate tests green (`cargo test`). **Not done:**
  the acceptance bar is 100% of Node 25's `test-fs-*` suite (227 files — see
  `test/fs/`), which also needs Buffers, fds, callbacks/promises, streams, watch,
  Dirent, and the full `Stats`; those land in their own `src/fs/` submodules.
- **`process`: not started** — next after fs. Most of its core maps onto the
  engine's existing `host` native state; its folder (`src/process/`) lands then.

### Module keys and host dispatch

The surface is registered under both `node:fs` and `fs`, so either import specifier
resolves. The engine already dispatches external module calls at runtime through
`CallHook::try_call_external(module, name, args)` (with string marshalling), and
loads native extensions through `zun_abi` — **no `zun:core` core change is needed**.
Wiring is a matter of loading this extension and routing `node:fs`/`fs` external
calls to its registered functions, in the engine's existing format.

Until that routing is exercised from a user program, `cargo test` here is the
verification path (it drives the real `zun_abi` registration + checked-invocation
path), and the Node `.js` corpus in `test/` is ported against this surface.

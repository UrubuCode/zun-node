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

- **`src/lib.rs`** — `zun_register_v1`, the ABI carrier helpers (`abi` module), and
  the per-module registration tables.
- **`src/<module>.rs`** — one file per Node module (`fs.rs`, later `process.rs`, …),
  each function a `zun_abi::ZunInvoke` over `std`.
- **`test/`** — the Node test corpus being ported (see `test/README.md`).

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

## Status

- **`node:fs` (sync core): implemented + tested through the ABI.** `existsSync`,
  `readFileSync` (utf8), `writeFileSync`, `appendFileSync`, `mkdirSync`, `rmdirSync`,
  `unlinkSync`, `rmSync`, `renameSync`, `copyFileSync`, `readdirSync`,
  `statSync`/`lstatSync` kind+size+mtimeMs, `realpathSync`, plus `lastErrorCode`/
  `lastErrorMessage`. 4 crate tests green (`cargo test`): register + round-trip +
  Node ENOENT + mkdir/readdir/stat.
- **`process`: not started** — next after fs. Most of its core maps onto the
  engine's existing `host` native state; the ABI surface lands here when it starts.

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

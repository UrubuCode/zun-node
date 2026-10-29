# zun-node — Node.js compatibility library for Zun

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform, implemented as Zun/TypeScript (`.zun`) modules over the engine's native
`zun:core` intrinsics.

**Baseline: Node.js 25.** The target surface and semantics are Node 25; the oracle
for "done" is Node's own test suite (`test/` in nodejs/node): **a library is not
finished until it passes 100% of the Node tests that apply to it.**

## Principles

1. **Library by library, finished before moving on.** Order: **`fs` → `process` →
   `path` → `os` → `events` → `stream` → `buffer` → …**. Do not start the next
   library until the current one passes 100% of its applicable Node tests.
2. **Intrinsics first.** Lean on native `zun:core` groups (implemented in the Zun
   engine's `zun_natives` crate) for anything the OS or the machine floor must do
   (filesystem, process state, time, randomness). The `.zun` layer is a thin,
   Node-shaped wrapper; real work lives in the Rust floor and JITs to native.
3. **No module graph beyond the engine.** Implement the maximum API that does not
   require pulling in the signed module-registry/distribution layer or third-party
   packages. Each library is self-contained over `zun:core`.
4. **Dependency rule.** If a library needs a capability another unfinished library
   owns, implement *just that piece* of the other library to unblock — but never
   leave a library before its own dependency within it is finished.

## Two-repository split

A Node library is two halves that land together:

- **Engine side (main `zun` repo, `crates/zun_natives`):** new `zun:core` native
  groups for syscalls the library needs (e.g. the `fs` group: `fsReadFileUtf8`,
  `fsWriteFileSync`, …). These are Rust, unit-tested in-process, and append-only in
  `MODULES` so dispatch ids stay stable.
- **Library side (this repo, `lib/<name>/`):** the Node-shaped `.zun` surface that
  composes those natives into the public API (`fs.readFileSync`, `fs.Stats`, …),
  plus the vendored/adapted Node tests in `test/<name>/`.

The engine-side natives are committed in the main repo; the `.zun` surface and tests
are committed here (this submodule). A library is "done" only when both halves are in.

## Layout

```
PLAN.md
lib/
  fs/        fs.zun        — node:fs surface over the zun:core `fs` native group
  process/   process.zun   — node:process over the zun:core `host` group
test/
  fs/        adapted nodejs/node fs tests
  process/
```

## Status

- **Engine `fs` native group: DONE** (main repo, `zun:core` `fs`). Sync core:
  existsSync, readFileSync (utf8), writeFileSync, appendFileSync, mkdirSync,
  rmdirSync, unlinkSync, rmSync, renameSync, copyFileSync, readdirSync,
  statSync/lstatSync kind+size+mtimeMs, realpathSync. Rust-unit-tested; Node-accurate
  error messages.
- **`lib/fs/fs.zun`: in progress** — the Node surface over that group (sync path
  first). Buffer-returning reads and the async/promise/stream surface follow once
  (a) the native boundary can return a managed Buffer and (b) a local module-load
  path lets a user program `import … from "node:fs"`.
- **`process`: not started** — most of its surface already has backing natives in the
  `zun:core` `host` group (`envGet`/`cwd`/`argAt`/`exitProcess`/`isTty`).

### Immediate next integration step (blocks running the `.zun` surface + Node tests)

A **local module-load path** so a user program can resolve `node:fs` to this repo's
compiled `lib/fs/fs.zun` without the signed registry. Until that exists, the engine
natives are verified in Rust but the `.zun` wrapper and Node tests cannot execute.
This is the gate before `fs` can be driven to 100%.

# zun-node tests

The acceptance oracle for each library is **Node.js 25's own test suite**. A
library is finished only when it passes 100% of the Node tests that apply to it.

## Two test layers

1. **Rust (`cargo test`)** — each native module is exercised through the real
   `zun_abi` registration + checked-invocation path (the same path the host
   uses). This is the always-available verification for the extension side while
   the host-side marshalling/dispatch is being wired. See `src/tests.rs`.
2. **Node `.js` (`test/<lib>/`)** — Node 25's own `test/parallel/test-<lib>*.js`
   files, never vendored: `../tools/run_node_tests.sh` downloads them at a pinned
   tag, runs each, and writes the pass share into the top-level `README.md` and
   `test/<lib>/RESULTS.md`. How a test runs depends on how its module is
   implemented (see `../PLAN.md`): an extension module's test runs as
   `zun run --ext <lib> <test.js>`, a Zun TypeScript module's test is first
   inlined by `../tools/bundle_node_test.sh` and then run as
   `zun run <bundle.ts>`.

## Current corpus

- `path/` — the full 17-file `test-path*` corpus, running today through the
  bundler. This is the live measurement; see `path/README.md` for what blocks the
  remaining failures.
- `fs/` — the full 227-file `test-fs-*` inventory. It measures 0% until the
  Node-API shaping over the extension natives (Buffers, fds, callbacks/promises,
  full `Stats`) and the `test/fixtures/` tree exist; see `fs/README.md`.

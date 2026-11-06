# zun-node tests

The acceptance oracle for each library is **Node.js 25's own test suite**. A
library is finished only when it passes 100% of the Node tests that apply to it.

## Two test layers

1. **Rust (`cargo test`)** — each native module is exercised through the real
   `zun_abi` registration + checked-invocation path (the same path the host
   uses). This is the always-available verification for the extension side while
   the host-side marshalling/dispatch is being wired. See `src/tests.rs` for
   `fs` and `src/os/tests.rs` for `os`, which also unit-tests the pure
   encoders and `/proc` parsers its TypeScript layer is written against.
2. **Node `.js` (`test/<lib>/`)** — Node 25's own `test/parallel/test-<lib>*.js`
   files, never vendored: `../tools/run_node_tests.sh` downloads them at a pinned
   tag, runs each, and writes the pass share into the top-level `README.md` and
   `test/<lib>/RESULTS.md`. How a test runs depends on how its module is
   implemented (see `../PLAN.md`): an extension module's test runs as
   `zun run --ext <lib> <test.js>`, a Zun TypeScript module's test is first
   inlined by `../tools/bundle_node_test.sh` and then run as
   `zun run <bundle.ts>`, and a TypeScript-over-natives module's test is
   inlined **and** run with `--ext`.

The measurements committed here are taken on **ubuntu-latest**, the platform the
`node-compat` workflow runs on, so the repository's numbers are the ones CI
reproduces.

## Current corpus

- `assert/` — the full 14-file `test-assert*` corpus, through the bundler.
  `assert` is also the harness **every** other corpus runs through, so a change
  to it is re-measured against all of them; `assert/README.md` names the blocker
  for each remaining file and records the four engine gaps this corpus found.
- `path/` — the full 17-file `test-path*` corpus, running today through the
  bundler. This is the live measurement; see `path/README.md` for what blocks the
  remaining failures.
- `events/` — the full 35-file `test-event-emitter-*` + `test-events-*` corpus,
  also through the bundler; see `events/README.md`.
- `os/` — the full 7-file `test-os*` corpus, through the bundler *and* `--ext`.
  The module itself is verified by a differential run against Node with zero
  divergences on both platforms, so every remaining failure is a harness or
  engine gap; see `os/README.md`.
- `buffer/` — the full 64-file `test-buffer*` corpus, through the bundler.
  `Buffer` itself is the **engine's** realm global (NUCLEUS #21), so this corpus
  measures the engine's Buffer as much as the module around it, and every
  failure is an engine or harness gap; `buffer/README.md` groups all 63 of them
  by root cause with a standalone repro each, and records the check of the four
  historical Buffer CVEs.
- `string_decoder/` — the full 3-file `test-string-decoder*` corpus, through the
  bundler. All three fail to compile on engine gaps, so the decoder is verified
  by a differential run against Node over 1248 cases with zero divergences; see
  `string_decoder/README.md`.
- `fs/` — the full 227-file `test-fs-*` inventory. It measures 0% until the
  Node-API shaping over the extension natives (Buffers, fds, callbacks/promises,
  full `Stats`) and the `test/fixtures/` tree exist; see `fs/README.md`.

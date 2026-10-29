# zun-node tests

The acceptance oracle for each library is **Node.js 25's own test suite**. A
library is finished only when it passes 100% of the Node tests that apply to it.

## Two test layers

1. **Rust (`cargo test`)** — each module is exercised through the real `zun_abi`
   registration + checked-invocation path (the same path the host uses). This is
   the always-available verification while the host-side marshalling/dispatch is
   being wired. See `src/tests.rs`.
2. **Node `.js` (`test/<lib>/`)** — the ported `nodejs/node` tests
   (`test/parallel/test-<lib>-*.js` and needed `test/fixtures/`), trimmed to the
   implemented surface as it grows. These run once the host can resolve
   `import … from "node:<lib>"` to this extension (see `../PLAN.md` →
   "Enabling work on the host/core side").

## Current corpus

- `fs/` — to be populated from Node 25's `test-fs-*` sync-API tests as the surface
  (readFileSync/writeFileSync/existsSync/mkdirSync/readdirSync/statSync/…) is driven
  to 100% through the host dispatch path.

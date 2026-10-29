# zun-node tests

The acceptance oracle for each library is **Node.js 25's own test suite**. A
library is finished only when it passes 100% of the Node tests that apply to it.

## Layout

- `test/<lib>/` — the Node tests for that library, vendored/adapted from
  `nodejs/node` `test/parallel/test-<lib>-*.js` (and `test/fixtures/` as needed),
  trimmed to the implemented surface as it grows.

## Harness (pending)

Running the `.zun` wrapper and the Node `.js` tests against the Zun engine needs
the **local module-load path** (see `../PLAN.md` → "Immediate next integration
step"): a way for a test program to resolve `node:fs` to `lib/fs/fs.zun` without
the signed module registry. Until that lands, the engine-side natives are verified
in the main repo's Rust unit tests (`cargo test -p zun_natives fs::`), and this
directory holds the test corpus being ported.

## Current corpus

- `fs/` — to be populated from Node 25's `test-fs-*` sync-API tests as the wrapper
  surface (readFileSync/writeFileSync/existsSync/mkdirSync/readdirSync/statSync/…)
  comes online through the loader.

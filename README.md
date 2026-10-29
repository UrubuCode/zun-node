# zun-node

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform, built as a native `zun_abi` extension (a Rust `cdylib`). See
[`PLAN.md`](PLAN.md) for the architecture and the library roadmap.

## Compatibility

The bar is **Node.js 25's own test suite**, not tests written here. The workflow
[`.github/workflows/node-compat.yml`](.github/workflows/node-compat.yml)
**downloads** the Node `test/parallel/test-<module>-*.js` files at a pinned tag,
runs each through the Zun engine with this extension loaded
([`tools/run_node_tests.sh`](tools/run_node_tests.sh)), and reports the share that
passes. The percentage below is that measurement — it climbs as the library grows.

<!-- node-fs:start -->
### Node.js v25 `fs` compatibility

`░░░░░░░░░░░░░░░░░░░░░░░░` **0.0%** — 0 / 227 Node `test-fs-*` tests passing
<!-- node-fs:end -->

> The current number is near zero by design: running Node's tests needs a Node
> compatibility harness (CommonJS `require`, the `common` helpers, `assert`), the
> Node-API shaping over the low-level extension functions, and `node:test`. Those
> are the next work; this number is how we watch it land. Per-test breakdown:
> [`test/fs/RESULTS.md`](test/fs/RESULTS.md).

## Running the tracker locally

```sh
# from the Zun engine checkout containing this submodule
cargo build -p zun_cli                 # the `zun` binary
cargo build --manifest-path zun-node/Cargo.toml   # the extension cdylib
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --ext zun-node/target/debug/libzun_node.so \
    --module fs           # add --limit N to sample
```

On Windows the binary is `target/debug/zun.exe` and the extension is
`zun-node/target/debug/zun_node.dll`.

# node:fs — Node.js compatibility tests

The compatibility bar for `fs` is **Node.js 25's own test suite**, not tests we
write. `fs` is **not finished** until it passes 100% of Node's `test-fs-*` tests
that apply to the implemented surface.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's `test/parallel/test-fs-*.js`
files (227 of them — `fs` is large). Each is fetched verbatim from
`nodejs/node` at tag `v25.0.0`; running them also needs the relevant
`test/fixtures/` and the `test/common/` harness.

## How they run (pending the host JS harness)

Node's tests are `.js` using `require('fs')`, the `common` harness, callbacks,
promises, file descriptors, and streams. Running them against Zun needs:

1. The Zun host resolving `require`/`import` of `node:fs`/`fs` to this loaded
   extension (the engine already dispatches external module calls and marshals
   strings — see `../../PLAN.md`).
2. A small Node-compatible test harness (the `common` shims + fixtures) on top of
   the Zun engine.

Until that harness exists, the always-available verification is the Rust crate
tests (`cargo test`), which drive the real `zun_abi` registration +
checked-invocation path (`../../src/tests.rs`).

## Coverage order (sync surface first)

The implemented surface is the synchronous, text API. The first Node tests to
turn green, once the harness lands, are the sync ones that map onto it:

| Node test | Needs |
|---|---|
| `test-fs-existssync-false.js` | existsSync ✅ |
| `test-fs-readfilesync-enoent.js` | readFileSync + ENOENT ✅ |
| `test-fs-read-file-sync.js` | readFileSync (utf8 ✅; Buffer pending) |
| `test-fs-write-file-sync.js` | writeFileSync ✅ |
| `test-fs-append-file-sync.js` | appendFileSync ✅ |
| `test-fs-truncate-sync.js` | truncateSync ✅ |
| `test-fs-mkdir.js` | mkdirSync ✅ (recursive ✅) |
| `test-fs-rmdir-type-check.js` | rmdirSync ✅ |
| `test-fs-rm.js` | rmSync ✅ |
| `test-fs-readdir*.js` | readdirSync ✅ (withFileTypes/Dirent pending) |
| `test-fs-stat.js` | statSync kind/size/times ✅ (full Stats fields pending) |
| `test-fs-access.js` | accessSync (F_OK/W_OK ✅; R/X bits pending) |
| `test-fs-rename*.js` | renameSync ✅ |
| `test-fs-copyfile.js` | copyFileSync ✅ (mode flags pending) |
| `test-fs-link.js` | linkSync ✅ |
| `test-fs-symlink*.js` | symlinkSync/readlinkSync ✅ (dir type pending) |
| `test-fs-mkdtemp.js` | mkdtempSync ✅ |
| `test-fs-realpath*.js` | realpathSync ✅ |

Everything else in `NODE_TESTS.txt` (callbacks, promises, fds, streams, watch,
Dirent, full `Stats`, Buffers, encodings) is later surface, implemented in its own
submodule under `../../src/fs/` and ticked off against its Node tests before `fs`
is declared done.

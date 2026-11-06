# node:fs — Node.js compatibility tests

The compatibility bar for `fs` is **Node.js 25's own test suite**, not tests we
write. `fs` is **not finished** until it passes 100% of Node's `test-fs-*`
tests.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's `test/parallel/test-fs-*.js`
files — **227** of them, which makes `fs` by far the largest corpus in this
repository. Each is fetched verbatim from `nodejs/node` at tag `v25.0.0`;
nothing is vendored here.

`NODE_FIXTURES.txt` is the second half of the oracle: 14 files from Node's
`test/fixtures/` that the corpus **opens** rather than merely computes paths
over (`x.txt`, `empty.txt`, `elipses.txt`, `a.js`, `cycles/`, `nested-index/`,
…). `tools/run_node_tests.sh` downloads them from the same tag into the scratch
tree beside the downloaded test file, so that the harness's
`path.join(__dirname, "..", "fixtures")` — which is exactly what Node's own
`test/common/fixtures.js` computes — resolves to them. Adding a fixture a new
test needs is a line in that file.

## How they run

`fs` is a **TS-over-natives** module, the kind `os` established, so the tracker
runs it as `zun-ts+ext`: the bundler *and* `--ext`.

```sh
cargo build -p zun_cli                              # the `zun` binary
cargo build --manifest-path zun-node/Cargo.toml     # the extension cdylib
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --ext zun-node/target/debug/libzun_node.so \
    --module fs
```

Each test is bundled by `tools/bundle_node_test.sh` (`util` → `events` →
`process` → `assert` → `path` → **`fs`** → the harness) and then run as
`zun run --ext <lib> <bundle.ts>`, because the Node-shaped API is
`../../src/fs/fs.ts` while the syscalls underneath it are `../../src/fs/*.rs`.

Two harness pieces exist for this corpus and are inlined only when a test asks
for them (`CONDITIONAL_FILES`, so a `path` or `events` bundle still compiles
with no `--ext`):

* **`tools/harness/tmpdir.ts`** — `test/common/tmpdir`, which **160 of the 227
  tests** require. `refresh()`, `resolve()`, `path`, `fileURL()` and
  `hasEnoughSpace()` behave as Node's do; the directory is
  `<os temp>/.tmp.zun-node.<pid>` rather than one inside a Node checkout, since
  the only source tree in reach is the engine's.
* **`tools/harness/node_test.ts`** — the `node:test` shim. It used to be
  inlined unconditionally, which broke every test file declaring its own
  `function test(...)` (eight in this corpus) with "duplicate function
  declaration".

## What is implemented

**Syscalls (`../../src/fs/*.rs`)** — `open`/`close`/`read`/`write` over a
process-wide descriptor table, `fstat`/`fsync`/`ftruncate`/`futimes`/`fchmod`/
`fchown`, `stat`/`lstat` (the whole `uv_stat_t`), `statfs`, `readdir` with
`UV_DIRENT_*` type tags, `mkdir` (recursive, reporting the first directory it
created), `rmdir`/`unlink`/`rm`, `rename`/`copyfile`/`link`/`symlink`/
`readlink`, `realpath`, `access`, `chmod`/`chown`/`utimes`, `mkdtemp`, and the
platform's own `O_*`/`S_*`/`*_OK` table. Both platforms are written from
libuv's behavior, so the Windows half synthesizes libuv's POSIX-shaped
`st_mode`, reads `FILE_ATTRIBUTE_READONLY` where POSIX reads permission bits,
and reports `ENOENT` for `rmdir` of a file the way the CRT's `_wrmdir` does.

**The Node API (`../../src/fs/fs.ts`)**

* **Sync**: `accessSync`, `appendFileSync`, `chmodSync`, `chownSync`,
  `closeSync`, `copyFileSync`, `cpSync`, `existsSync`, `fchmodSync`,
  `fchownSync`, `fdatasyncSync`, `fstatSync`, `fsyncSync`, `ftruncateSync`,
  `futimesSync`, `lchownSync`, `linkSync`, `lstatSync`, `lutimesSync`,
  `mkdirSync`, `mkdtempSync`, `openSync`, `opendirSync`, `readSync`,
  `readdirSync`, `readFileSync`, `readlinkSync`, `readvSync`, `realpathSync`
  (+ `.native`), `renameSync`, `rmSync`, `rmdirSync`, `statSync`, `statfsSync`,
  `symlinkSync`, `truncateSync`, `unlinkSync`, `utimesSync`, `writeSync`,
  `writeFileSync`, `writevSync`.
* **Option shapes**: `encoding`/`flag`/`mode`, `withFileTypes`, `recursive`,
  `bigint`, `throwIfNoEntry`, `force`, `maxRetries`, the `COPYFILE_*` modes,
  and `getOptions`' string-is-an-encoding rule.
* **Objects**: `Stats` and `BigIntStats` (every field, the four `Date`s, and
  the exact `*Ns` integers), `StatsFs`, `Dirent` (`name`, `parentPath`, the
  deprecated `path` alias, all seven predicates), `Dir`, `FileHandle`.
* **`fs.constants`**, with a null prototype and the platform's own values.
* **Errors**: libuv-shaped `uvException`s (`code`, `errno`, `syscall`, `path`,
  `dest`, and the `"<code>: <description>, <syscall> '<path>'"` message), plus
  `ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`, `ERR_INVALID_ARG_VALUE`,
  `ERR_FS_EISDIR`, `ERR_FS_INVALID_SYMLINK_TYPE` and the `ERR_FS_CP_*` family.
* **Callbacks**: every `fs` function, with Node's split — an *argument* error is
  thrown at the call site, an *operation* error is delivered to the callback on
  a later tick, and a non-function callback is a synchronous
  `ERR_INVALID_ARG_TYPE` on `"cb"`.
* **`fs.promises`** (and the `fs/promises` require spelling), including
  `FileHandle` with `read`/`write`/`readv`/`writev`/`stat`/`truncate`/`sync`/
  `datasync`/`chmod`/`chown`/`utimes`/`readFile`/`writeFile`/`appendFile`.

### Deliberate gaps

Each of these throws `ERR_METHOD_NOT_IMPLEMENTED` rather than being absent, so
a test that reaches one fails with a named gap instead of
"undefined is not a function":

| Gap | Needs |
|---|---|
| `createReadStream` / `createWriteStream`, `ReadStream`, `WriteStream` | `node:stream`, its own module in PLAN.md's order |
| `watch`, `watchFile`, `unwatchFile` | a filesystem-event source in the VM's loop (libuv's `uv_fs_event_t`); there is no loop hook to attach one to |
| `glob`, `globSync` | a path matcher, which `node:path` does not have yet |
| `openAsBlob` | `node:buffer`'s `Blob` |
| `lchmodSync` / `lchmod` | only defined on macOS in Node; libuv reports `ENOSYS` elsewhere |

### How bytes cross the ABI

ABI v1's carrier is one scalar word, and its `Str` form is a NUL-terminated C
string — so it can carry neither a NUL byte nor non-UTF-8 data. File contents
therefore cross **base64**, and `fs.ts` turns them into the engine's prelude
`Buffer` with `Buffer.from(text, "base64")` (and back with
`buf.toString("base64")`). base64 over hex because it is 4/3 rather than 2× the
byte count; over a latin1 passthrough because latin1 cannot carry NUL. Both
codecs are native in the engine's `Buffer`, so neither side hand-rolls one, and
a round trip through a file containing NUL and invalid UTF-8 is covered by
`../../src/fs/tests.rs`.

## Results

**40 of 227** of Node 25's `test-fs-*` files pass (`tools/run_node_tests.sh --module fs`, Windows). What stops the other 187:

| Blocker | Issue | Tests |
|---|---|---|
| `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | 45 |
| `node:stream` / `createReadStream` | — | 35 |
| unresolved `require` | — | 32 |
| `fs.watch` / `watchFile` | — | 22 |
| `.then(common.mustCall())` | new (see below) | 10 |
| bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | 8 |
| behaviour mismatch | — | 8 |
| top-level `return` in a CommonJS module | — | 7 |
| `f.apply` / `f.call` | [zun#1](https://github.com/UrubuCode/zun/issues/1) | 6 |
| uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | 6 |
| `child_process` | — | 3 |
| callback never ran | — | 2 |
| callable-with-properties | [zun#14](https://github.com/UrubuCode/zun/issues/14) | 1 |
| does not compile | — | 1 |
| runtime error | — | 1 |

### Per test

| Test | Blocker | Issue | Why |
|---|---|---|---|
| `test-fs-access.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-access.js: |
| `test-fs-append-file.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-append-file.ts:10938:44: error: [SEM0001] 'Buffer.byteLength' expects a… |
| `test-fs-append-file-flush.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Missing expected exception. |
| `test-fs-append-file-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — bundles/test-fs-append-file-sync.ts:10938:38: error: [SEM0001] 'Buffer.byteLength' expects a… |
| `test-fs-assert-encoding-error.js` | `fs.watch` / `watchFile` | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-buffer.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-buffer.ts:10906:23: error: [SEM0001] 'Buffer.from' expects a string, ar… |
| `test-fs-chmod.js` | `f.apply` / `f.call` | [zun#1](https://github.com/UrubuCode/zun/issues/1) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x213b9c31f80)) |
| `test-fs-chmod-mask.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x2012fa72960)) |
| `test-fs-copyfile.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-copyfile.js: |
| `test-fs-copyfile-respect-permissions.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | runtime — zun: runtime error: call did not resolve to a method at <closure@403028> [403121..403153] |
| `test-fs-cp-sync-dereference.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1e225fb5868)) |
| `test-fs-error-messages.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-error-messages.js: |
| `test-fs-exists.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | runtime — zun: runtime error: call did not resolve to a method at <main> [398806..398807] |
| `test-fs-existssync-false.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | runtime — zun: runtime error: call did not resolve to a method at <main> [402902..402931] |
| `test-fs-existssync-memleak-longpath.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-existssync-memleak-longpath.js: |
| `test-fs-fchmod.js` | behaviour mismatch | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-fchown.js` | behaviour mismatch | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-filehandle.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-filehandle.js: |
| `test-fs-filehandle-use-after-close.js` | `.then(common.mustCall())` | new (see below) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-internal-assertencoding.js` | behaviour mismatch | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-lchown-negative-one.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x257486a1fe8)) |
| `test-fs-long-path.js` | `.then(common.mustCall())` | new (see below) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-make-callback.js` | behaviour mismatch | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-mkdir.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-mkdir.js: |
| `test-fs-mkdir-mode-mask.js` | top-level `return` in a CommonJS module | — | runtime — bundles/test-fs-mkdir-mode-mask.ts: error: parse error: "A 'return' statement can only be … |
| `test-fs-mkdir-recursive-eaccess.js` | `child_process` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x21f44664268)) |
| `test-fs-mkdir-rmdir.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | runtime — zun: runtime error: call did not resolve to a method at <main> [402536..402537] |
| `test-fs-mkdtemp.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-mkdtemp.ts:10920:40: error: [SEM0001] 'Buffer.byteLength' expects a str… |
| `test-fs-non-number-arguments-throw.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x26a151c1f50)) |
| `test-fs-null-bytes.js` | `fs.watch` / `watchFile` | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-open.js` | `.then(common.mustCall())` | new (see below) | type error — bundles/test-fs-open.ts:10832:31: error: [SEM0001] spread arguments are not lowered yet |
| `test-fs-opendir.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | type error — bundles/test-fs-opendir.ts:10925:25: error: [SEM0001] right operand of 'instanceof' mus… |
| `test-fs-open-flags.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-open-flags.js: |
| `test-fs-open-no-close.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-options-immutable.js` | `fs.watch` / `watchFile` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x233a4630cb0)) |
| `test-fs-promises.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x155b52c1e70)) |
| `test-fs-promises-file-handle-aggregate-errors.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-aggregate-… |
| `test-fs-promises-file-handle-append-file.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-file-handle-chmod.js` | `.then(common.mustCall())` | new (see below) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-file-handle-close-errors.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-close-erro… |
| `test-fs-promises-file-handle-dispose.js` | `.then(common.mustCall())` | new (see below) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-file-handle-op-errors.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-op-errors.… |
| `test-fs-promises-file-handle-read.js` | `node:stream` / `createReadStream` | — | type error — bundles/test-fs-promises-file-handle-read.ts:10919:30: error: [SEM0001] 'Buffer.from' e… |
| `test-fs-promises-file-handle-read-worker.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-read-worke… |
| `test-fs-promises-file-handle-stat.js` | `.then(common.mustCall())` | new (see below) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-file-handle-stream.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-stream.js: |
| `test-fs-promises-file-handle-truncate.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-file-handle-write.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-readfile.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-readfile.js: |
| `test-fs-promises-readfile-empty.js` | callable-with-properties | [zun#14](https://github.com/UrubuCode/zun/issues/14) | runtime — zun: runtime error: call did not resolve to a method at <main> [397149..397151] |
| `test-fs-promises-readfile-with-fd.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-watch.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-watch.js: |
| `test-fs-promises-watch-iterator.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-watch-iterator.js: |
| `test-fs-promises-writefile.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x23431281f60)) |
| `test-fs-promises-writefile-typedarray.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-promises-writefile-typedarray.ts:10914:35: error: [SEM0001] type Buffer… |
| `test-fs-promises-writefile-with-fd.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-write-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-promises-write-optional-params.ts:10969:15: error: [SEM0001] type Buffe… |
| `test-fs-promisified.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-read.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | assertion — AssertionError [strictEqual]: 4 !== undefined |
| `test-fs-readdir-recursive.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-readdir-recursive.js: |
| `test-fs-readdir-stack-overflow.js` | runtime error | — | runtime — thread '<unknown>' (28928) has overflowed its stack |
| `test-fs-readdir-types.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-readdir-types.js: |
| `test-fs-readdir-ucs2.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readdir-ucs2.ts:10924:38: error: [SEM0001] 'Buffer.from' expects a stri… |
| `test-fs-read-empty-buffer.js` | `.then(common.mustCall())` | new (see below) | type error — bundles/test-fs-read-empty-buffer.ts:10775:16: error: [SEM0001] 'Uint8Array' expects at… |
| `test-fs-readfile.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readfile.ts:10795:35: error: [SEM0001] Buffer size must be an integer |
| `test-fs-readfile-eof.js` | top-level `return` in a CommonJS module | — | runtime — bundles/test-fs-readfile-eof.ts: error: parse error: "A 'return' statement can only be use… |
| `test-fs-readfile-error.js` | `child_process` | — | type error — bundles/test-fs-readfile-error.ts:10803:8: error: [SEM0001] spread arguments are not lo… |
| `test-fs-readfile-fd.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x284b93e6268)) |
| `test-fs-readfile-flags.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-readfile-pipe.js` | top-level `return` in a CommonJS module | — | runtime — bundles/test-fs-readfile-pipe.ts: error: parse error: "A 'return' statement can only be us… |
| `test-fs-readfile-pipe-large.js` | top-level `return` in a CommonJS module | — | runtime — bundles/test-fs-readfile-pipe-large.ts: error: parse error: "A 'return' statement can only… |
| `test-fs-read-file-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x23314659288)) |
| `test-fs-readfilesync-enoent.js` | behaviour mismatch | — | assertion — AssertionError [strictEqual]: '\\\\marcospc\\c$' !== '\\\\marcospc\\c$\\' |
| `test-fs-readfilesync-pipe-large.js` | top-level `return` in a CommonJS module | — | parse — bundles/test-fs-readfilesync-pipe-large.ts: error: parse error: "A 'return' statement can on… |
| `test-fs-readfile-unlink.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readfile-unlink.ts:10928:26: error: [SEM0001] Buffer size must be an in… |
| `test-fs-read-offset-null.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | assertion — AssertionError [strictEqual]: undefined !== 120 |
| `test-fs-read-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-read-optional-params.ts:10780:29: error: [SEM0001] spread arguments are… |
| `test-fs-read-promises-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-read-promises-optional-params.ts:10777:43: error: [SEM0001] type Buffer… |
| `test-fs-read-stream.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x20cffc320e0)) |
| `test-fs-read-stream-concurrent-reads.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x2a94ef181d0)) |
| `test-fs-read-stream-double-close.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1d03ce9d2d0)) |
| `test-fs-read-stream-encoding.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x18c020106c8)) |
| `test-fs-read-stream-err.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x234ff5d1d60)) |
| `test-fs-read-stream-fd.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x120202dd100)) |
| `test-fs-read-stream-fd-leak.js` | `node:stream` / `createReadStream` | — | parse — bundles/test-fs-read-stream-fd-leak.ts:10800:7: error: [SEM0001] expected a Any return value |
| `test-fs-read-stream-file-handle.js` | `node:stream` / `createReadStream` | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-read-stream-inherit.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x12520311fc0)) |
| `test-fs-read-stream-patch-open.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x22d862c1d50)) |
| `test-fs-read-stream-pos.js` | `node:stream` / `createReadStream` | — | parse — bundles/test-fs-read-stream-pos.ts:10926:15: error: [SEM0001] expected a Any return value |
| `test-fs-read-stream-resume.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1fb2f3be1a8)) |
| `test-fs-read-stream-throw-type-error.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x246f006f608)) |
| `test-fs-read-type.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | assertion — AssertionError [throws]: Missing expected exception. |
| `test-fs-readv.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readv.ts:10914:31: error: [SEM0001] Buffer size must be an integer |
| `test-fs-readv-promises.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readv-promises.ts:10915:31: error: [SEM0001] Buffer size must be an int… |
| `test-fs-readv-promisify.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | assertion — AssertionError [deepStrictEqual]: undefined !== [ {} ] |
| `test-fs-readv-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — bundles/test-fs-readv-sync.ts:10916:31: error: [SEM0001] Buffer size must be an integer |
| `test-fs-ready-event-stream.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x11795791e60)) |
| `test-fs-realpath.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-realpath.js: |
| `test-fs-realpath-buffer-encoding.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | runtime — bundles/test-fs-realpath-buffer-encoding.ts: error: OXC adapter supports declared for-in b… |
| `test-fs-realpath-native.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x230bf8b56f0)) |
| `test-fs-realpath-on-substed-drive.js` | `child_process` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1ee1c1ed150)) |
| `test-fs-rm.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-rm.js: |
| `test-fs-rmdir-recursive-error.js` | `.then(common.mustCall())` | new (see below) | assertion — AssertionError [throws]: Missing expected exception. |
| `test-fs-rmdir-throws-not-found.js` | `.then(common.mustCall())` | new (see below) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-rmdir-throws-on-file.js` | `.then(common.mustCall())` | new (see below) | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-stat.js` | does not compile | — | type error — bundles/test-fs-stat.ts:10923:3: error: [SEM0001] type Any has no methods |
| `test-fs-stat-bigint.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | type error — bundles/test-fs-stat-bigint.ts:10929:51: error: [SEM0001] 'BigInt' expects a string or … |
| `test-fs-statfs.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x247941b2070)) |
| `test-fs-stream-construct-compat-error-read.js` | `f.apply` / `f.call` | [zun#1](https://github.com/UrubuCode/zun/issues/1) | type error — bundles/test-fs-stream-construct-compat-error-read.ts:10909:30: error: [SEM0001] spread… |
| `test-fs-stream-construct-compat-error-write.js` | `f.apply` / `f.call` | [zun#1](https://github.com/UrubuCode/zun/issues/1) | type error — bundles/test-fs-stream-construct-compat-error-write.ts:10915:31: error: [SEM0001] sprea… |
| `test-fs-stream-construct-compat-graceful-fs.js` | `f.apply` / `f.call` | [zun#1](https://github.com/UrubuCode/zun/issues/1) | type error — bundles/test-fs-stream-construct-compat-graceful-fs.ts:10910:30: error: [SEM0001] sprea… |
| `test-fs-stream-construct-compat-old-node.js` | `f.apply` / `f.call` | [zun#1](https://github.com/UrubuCode/zun/issues/1) | parse — bundles/test-fs-stream-construct-compat-old-node.ts:10910:30: error: [SEM0001] spread argume… |
| `test-fs-stream-destroy-emit-error.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x20270457b70)) |
| `test-fs-stream-double-close.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x206eeb21ec0)) |
| `test-fs-stream-fs-options.js` | `node:stream` / `createReadStream` | — | assertion — AssertionError [throws]: createWriteStream options.fs.open should throw if isn't a funct… |
| `test-fs-stream-options.js` | `node:stream` / `createReadStream` | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-symlink-buffer-path.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-symlink-buffer-path.ts:10938:28: error: [SEM0001] 'Buffer.from' expects… |
| `test-fs-symlink-dir-junction.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | parse — Mismatched function call: mustSucceed received an error: EPERM: operation not permitted, sym… |
| `test-fs-symlink-dir-junction-relative.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1cf2f8d2218)) |
| `test-fs-symlink-longpath.js` | bare `assert(...)` | [zun#14](https://github.com/UrubuCode/zun/issues/14) | parse — Mismatched function call: mustSucceed received an error: EPERM: operation not permitted, sym… |
| `test-fs-sync-fd-leak.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-sync-fd-leak.js: |
| `test-fs-syncwritestream.js` | top-level `return` in a CommonJS module | — | parse — bundles/test-fs-syncwritestream.ts: error: parse error: "A 'return' statement can only be us… |
| `test-fs-truncate.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-truncate.ts:10925:27: error: [SEM0001] Buffer size must be an integer |
| `test-fs-truncate-clear-file-zero.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x25fd5d8cb00)) |
| `test-fs-truncate-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x2332b2a1fb0)) |
| `test-fs-utils-get-dirents.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-utils-get-dirents.js: |
| `test-fs-util-validateoffsetlength.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-util-validateoffsetlength.js: |
| `test-fs-utimes.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-utimes.js: |
| `test-fs-watch.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch.ts:10945:21: error: [SEM0001] 'clearInterval' expects a numeric h… |
| `test-fs-watch-abort-signal.js` | `fs.watch` / `watchFile` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1daa33bb950)) |
| `test-fs-watch-close-when-destroyed.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-close-when-destroyed.ts:10927:5: error: [SEM0001] 'setTimeout' de… |
| `test-fs-watch-encoding.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-encoding.ts:10938:19: error: [SEM0001] 'clearInterval' expects a … |
| `test-fs-watch-enoent.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-watch-enoent.js: |
| `test-fs-watchfile.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watchfile.ts:10986:21: error: [SEM0001] 'clearInterval' expects a numer… |
| `test-fs-watchfile-bigint.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-watchfile-bigint.js: |
| `test-fs-watch-file-enoent-after-deletion.js` | `fs.watch` / `watchFile` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x26bfcdccce0)) |
| `test-fs-watchfile-ref-unref.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watchfile-ref-unref.ts:10791:3: error: [SEM0001] 'setTimeout' expects a… |
| `test-fs-watch-recursive-add-file.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-recursive-add-file.ts:10939:4: error: [SEM0001] 'setTimeout' dela… |
| `test-fs-watch-recursive-add-file-to-existing-subfolder.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-recursive-add-file-to-existing-subfolder.ts:10948:4: error: [SEM0… |
| `test-fs-watch-recursive-add-file-to-new-folder.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-recursive-add-file-to-new-folder.ts:10944:4: error: [SEM0001] 'se… |
| `test-fs-watch-recursive-add-file-with-url.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-watch-recursive-add-file-with-u… |
| `test-fs-watch-recursive-add-folder.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-watch-recursive-add-folder.js: |
| `test-fs-watch-recursive-assert-leaks.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-watch-recursive-assert-leaks.js… |
| `test-fs-watch-recursive-delete.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-recursive-delete.ts:10928:4: error: [SEM0001] 'setTimeout' delay … |
| `test-fs-watch-recursive-promise.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-recursive-promise.ts:10949:17: error: [SEM0001] 'clearInterval' e… |
| `test-fs-watch-recursive-symlink.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-watch-recursive-symlink.js: |
| `test-fs-watch-recursive-sync-write.js` | `fs.watch` / `watchFile` | — | parse — bundles/test-fs-watch-recursive-sync-write.ts:10925:18: error: [SEM0001] 'clearTimeout' expe… |
| `test-fs-watch-recursive-update-file.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-recursive-update-file.ts:10940:4: error: [SEM0001] 'setTimeout' d… |
| `test-fs-watch-recursive-validate.js` | `fs.watch` / `watchFile` | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-watch-recursive-watch-file.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-recursive-watch-file.ts:10935:21: error: [SEM0001] 'clearInterval… |
| `test-fs-watch-ref-unref.js` | `fs.watch` / `watchFile` | — | type error — bundles/test-fs-watch-ref-unref.ts:10779:3: error: [SEM0001] 'setTimeout' expects a fun… |
| `test-fs-watch-stop-async.js` | `fs.watch` / `watchFile` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x26505c61d80)) |
| `test-fs-watch-stop-sync.js` | `fs.watch` / `watchFile` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1ab38cfc470)) |
| `test-fs-whatwg-url.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-whatwg-url.js: |
| `test-fs-write.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | assertion — AssertionError [notStrictEqual]: undefined !== undefined |
| `test-fs-write-buffer.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-buffer.ts:11057:31: error: [SEM0001] type BufferView(U8) has no f… |
| `test-fs-write-buffer-large.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-buffer-large.ts:10910:28: error: [SEM0001] Buffer size must be an… |
| `test-fs-write-file.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-file.ts:10931:42: error: [SEM0001] 'Buffer.byteLength' expects a … |
| `test-fs-write-file-buffer.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-file-buffer.ts:10940:8: error: [SEM0001] cannot assign String to … |
| `test-fs-write-file-flush.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Missing expected exception. |
| `test-fs-write-file-invalid-path.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x196451a25c0)) |
| `test-fs-write-file-sync.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-write-file-sync.js: |
| `test-fs-write-file-typedarrays.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-file-typedarrays.ts:10910:33: error: [SEM0001] 'Buffer.from' expe… |
| `test-fs-writefile-with-fd.js` | unresolved `require` | — | bundle failed — tools/bundle_node_test.sh: line 254: … |
| `test-fs-write-negativeoffset.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | assertion — AssertionError [throws]: Missing expected exception. |
| `test-fs-write-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-optional-params.ts:10977:15: error: [SEM0001] type BufferView(U8)… |
| `test-fs-write-reuse-callback.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-reuse-callback.ts:10942:28: error: [SEM0001] Buffer size must be … |
| `test-fs-write-stream.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x298d84f9c48)) |
| `test-fs-write-stream-autoclose-option.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x26bc2544518)) |
| `test-fs-write-stream-change-open.js` | `f.apply` / `f.call` | [zun#1](https://github.com/UrubuCode/zun/issues/1) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x1d0081f78f8)) |
| `test-fs-write-stream-close-without-callback.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x199a4b81dd8)) |
| `test-fs-write-stream-double-close.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x27dff231f08)) |
| `test-fs-write-stream-encoding.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x29fcd7547d0)) |
| `test-fs-write-stream-end.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x2337f4a6688)) |
| `test-fs-write-stream-err.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x285cc565ec0)) |
| `test-fs-write-stream-file-handle.js` | `node:stream` / `createReadStream` | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-write-stream-file-handle-2.js` | `node:stream` / `createReadStream` | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-write-stream-flush.js` | `node:stream` / `createReadStream` | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-write-stream-fs.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x171652120d8)) |
| `test-fs-writestream-open-write.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x19174bcd4c8)) |
| `test-fs-write-stream-patch-open.js` | top-level `return` in a CommonJS module | — | runtime — bundles/test-fs-write-stream-patch-open.ts: error: parse error: "A 'return' statement can … |
| `test-fs-write-stream-throw-type-error.js` | `node:stream` / `createReadStream` | — | runtime — zun: runtime error: unhandled exception: Object(Obj(0x21c76369ce8)) |
| `test-fs-writesync-crash.js` | behaviour mismatch | — | assertion — AssertionError [throws]: The error does not match the expectation. |
| `test-fs-write-sync-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — bundles/test-fs-write-sync-optional-params.ts:10932:30: error: [SEM0001] spread arguments ar… |
| `test-fs-writev.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-writev.ts:10935:47: error: [SEM0001] type BufferView(U8) has no fields |
| `test-fs-writev-promises.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-writev-promises.ts:10928:47: error: [SEM0001] type BufferView(U8) has n… |
| `test-fs-writev-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — bundles/test-fs-writev-sync.ts:10932:45: error: [SEM0001] type BufferView(U8) has no fields |

A test is listed under the **first** thing that stops it, so a file blocked by a
missing `node:stream` is counted there even though it also calls
`Buffer.from(x)`. "unresolved `require`" is a module the bundler does not know
(`internal/*`, `worker_threads`, `timers/promises`, `node:net`); the rest are
engine limits, described below.

### The blockers that cap this corpus

Everything listed above is implemented; these are the limits in front of it.

**[zun#38](https://github.com/UrubuCode/zun/issues/38) — a `Buffer` is opaque
through `any`.** A typed array reached through an `any` binding has no
`length`, no indexing and no methods: `buf.toString("utf8")` throws
"toString is not a function" and `buf.length` reads `undefined`. Inside
`fs.ts` this is worked around by keeping every `Buffer` in a statically typed
binding (`__fsAsBuffer` re-types one that arrives as `any`), but a *test file*
is plain JavaScript, where every binding is `any` — so
`fs.readFileSync(p).equals(Buffer.from("hello"))` cannot work no matter what
this module returns. The same compile-time restriction rejects
`Buffer.from(x)`, `Buffer.byteLength(x)` and `Buffer.alloc(x)` when `x` is
`any`, which is how most of the corpus writes them. Reads *with* an encoding
return strings and are unaffected, which is why they are the surface that
passes today.

**[zun#14](https://github.com/UrubuCode/zun/issues/14) — the bare
`assert(value)` form.** Node's `assert` is a function that also carries
`strictEqual` & co., and `assert(fs.existsSync(dir))` fails with
"call did not resolve to a method". 51 files in this corpus use the bare form at
least once; it is the *first* blocker for 9 of them.

The issue says such a value cannot exist, and that turns out to be too strong:
a function routed through a one-element array — the `functionBox` record
`__evBox` already uses — **is** callable *and* accepts callable properties, at
top level and from inside a nested function:

```ts
function box(fn: any): any { const holder: any[] = [fn]; return holder[0]; }
const a: any = box(function (v: any, m?: any): void { /* assert.ok */ });
a.strictEqual = function (x: any, y: any): void { /* … */ };
a(true, "m");            // calls the box
a.strictEqual(1, 1);     // calls the property
```

Both lines work today. Building `src/assert/assert.ts`'s export that way —
every method assigned onto the box instead of being an object-literal member —
would make the bare form work for this corpus and for `path`, `events` and `os`
as well. It is a change to `assert`, not to `fs`, so it is left for whoever
owns that module to land once.

**A `functionBox` is invisible to `Promise.prototype.then`** (not yet filed).
`typeof box === "function"` and `box()` calls it, but `Promise.resolve(1).then(box)`
never invokes it — the reaction is attached with no handler. `promiseThen`'s
`callback_arg` (`crates/zun_interp/src/collections.rs:60`) accepts only
`Value::Function`, so an object-wrapped callable silently becomes `None`. That
is what stops the ten tests whose last line is
`assert.rejects(…).then(common.mustCall())`: `common.mustCall()` has to return
a box (a function value cannot be returned out of an object-literal method),
and the box is then dropped.

Two smaller ones, each affecting a handful of files:

* **[zun#9](https://github.com/UrubuCode/zun/issues/9)** — a string literal
  containing U+0000 is truncated at the NUL, so `test-fs-null-bytes.js` cannot
  even express its input.
* **A top-level `return`** is legal in a CommonJS module (the module wrapper is
  a function) and is how several tests spell an early `common.skip`. The bundle
  is one program, not a function, so the parser rejects it. Wrapping the test
  body in a function would fix it, and that is a bundler change rather than an
  engine one.

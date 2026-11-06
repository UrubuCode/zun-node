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
`process` → `assert` → `path` → `buffer` → `string_decoder` → `stream` →
**`fs`** → `fs/streams` → `fs/watchers` → the harness) and then run as
`zun run --ext <lib> <bundle.ts>`, because the Node-shaped API is
`../../src/fs/fs.ts` while the syscalls underneath it are `../../src/fs/*.rs`.
`stream` is in that list because `fs.createReadStream` stands on it, exactly as
`lib/internal/fs/streams.js` stands on `lib/stream.js`.

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

The `fs` entry in `CONDITIONAL_FILES` therefore pulls six files rather than
one, and `../common/tmpdir` pulls `fs.ts` and `fs/watchers.ts` but *not*
`fs/streams.ts` — which is the whole reason the two stream entry points go
through a hook table instead of naming the classes directly.

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

**The streams (`../../src/fs/streams.ts`)** — `ReadStream` and `WriteStream`
over `../../src/stream/stream.ts`, which is what `fs.createReadStream`,
`fs.createWriteStream`, `fs.ReadStream`/`fs.WriteStream` and
`filehandle.createReadStream`/`createWriteStream` answer. The `options.fs`
operations table a program can replace is there (and the default *is* the
module object, so patching `fs.open` is observable, which Node's own
`test-fs-read-stream-patch-open.js` checks), as are `start`/`end`,
`autoClose`/`autoDestroy`, `flush`, `pending`, `bytesRead`/`bytesWritten`, the
`'open'`/`'ready'`/`'close'` order, the five-retry short-write loop and the
`kIoDone` handshake that keeps a descriptor open under a pending read.

The classes are a separate file for one reason: `fs.ts` is inlined for
`../common/tmpdir` as well, which 160 of these 227 files require, and a `path`
or `events` bundle must not grow a stream module it never uses. `fs.ts`
therefore knows only the hook table `__fsStreamHooks`, which still throws
`ERR_METHOD_NOT_IMPLEMENTED` when this file is not in the bundle.

**The watchers (`../../src/fs/watchers.ts`)** — `fs.watch`, `fs.watchFile`,
`fs.unwatchFile`, `fsPromises.watch`, and the `FSWatcher`/`StatWatcher`
classes, as **pollers over `setInterval`**:

* `watchFile` is a poller in Node too. `uv_fs_poll_t` stats the path on a timer
  and compares the result with the previous one, and libuv's `poll_cb` is
  reproduced field for field — the first *successful* stat is recorded without
  an event, the first *failing* one does fire, and the `busy_polling`
  tri-state is what makes those two rules work out. That is why `watchFile` on
  a path that does not exist yet calls its listener once with two all-zero
  `Stats` and again when the file appears, which is exactly what
  `test-fs-watchfile.js` asserts.
* `watch` is `uv_fs_event_t` in Node — `ReadDirectoryChangesW` on Windows,
  `inotify` on Linux — and there is no loop hook in this VM to attach such a
  handle to. So it diffs a snapshot of the entry names and their
  `(mtimeMs, size, ino, mode)`: an appeared or vanished name is reported as
  `'rename'` and a changed one as `'change'`, with the same `(eventType,
  filename)` listener arguments. The resolution is the poll interval rather
  than the kernel's. Node ships a poller of exactly this shape as its own
  `recursive` fallback on Linux (`lib/internal/fs/recursive_watch.js`).

`persistent: false` is an `unref()` on that interval, so a non-persistent
watcher does not hold the process open — which is what `ref`/`unref` mean on
both classes.

**`internal/fs/utils` (`../../src/fs/internal.ts`)** — not a public module, and
here for the reason `internal/util` is in `src/util/util.ts`: six of Node's own
`test-fs-*` files run under `--expose-internals` and drive these functions
*directly* rather than through the `fs` API that calls them
(`test-fs-open-flags.js` walks `stringToFlags` over the whole flag table,
`test-fs-util-validateoffsetlength.js` checks the two range validators message
for message, `test-fs-rm.js` calls `validateRmOptionsSync`,
`test-fs-watchfile-bigint.js` wants the `BigIntStats` class). Every member is
the same function `fs.ts` already uses, re-exported under Node's internal name.

### Deliberate gaps

Each of these throws `ERR_METHOD_NOT_IMPLEMENTED` rather than being absent, so
a test that reaches one fails with a named gap instead of
"undefined is not a function":

| Gap | Needs |
|---|---|
| `glob`, `globSync` | a path matcher, which `node:path` does not have yet. No file in this corpus reaches either, so it is the one gap with no test behind it |
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

**96 of 227** of Node 25's `test-fs-*` files pass
(`tools/run_node_tests.sh --module fs`, Windows). What stops the other 131:

| Blocker | Issue | Tests |
|---|---|---|
| `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | 29 |
| uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | 29 |
| behaviour mismatch | — | 28 |
| runtime error | — | 12 |
| callback never ran | — | 11 |
| unresolved `require` | — | 11 |
| does not compile | — | 7 |
| spread arguments | [zun#11](https://github.com/UrubuCode/zun/issues/11) | 3 |
| timed out | — | 1 |

### Per test

| Test | Blocker | Issue | Why |
|---|---|---|---|
| `test-fs-access.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-access.ts:31273:37: error: [SEM0001] 'Buffer.from' expects a string, arr |
| `test-fs-append-file.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-append-file.ts:29053:44: error: [SEM0001] 'Buffer.byteLength' expects a  |
| `test-fs-append-file-flush.js` | behaviour mismatch | — | runtime — not ok - performs flush: Cannot read properties of undefined (reading 'method') |
| `test-fs-append-file-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — bundles/test-fs-append-file-sync.ts:29053:38: error: [SEM0001] 'Buffer.byteLength' expec |
| `test-fs-assert-encoding-error.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Expected values to be strictly deep-equal: |
| `test-fs-buffer.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-buffer.ts:29021:23: error: [SEM0001] 'Buffer.from' expects a string, arr |
| `test-fs-chmod.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-chmod-mask.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-copyfile.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Expected values to be strictly deep-equal: |
| `test-fs-cp-sync-dereference.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-error-messages.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-exists.js` | runtime error | — | parse — Mismatched function call: expected warning DeprecationWarning was never emitted |
| `test-fs-existssync-false.js` | callback never ran | — | parse — Mismatched function call: mustSucceed received an error: ENOENT: no such file or directo |
| `test-fs-existssync-memleak-longpath.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-existssync-memleak-longpath.js: |
| `test-fs-filehandle.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-filehandle-use-after-close.js` | behaviour mismatch | — | assertion — AssertionError [rejects]: Expected values to be strictly deep-equal: |
| `test-fs-lchown-negative-one.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-mkdir.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Expected values to be strictly deep-equal: |
| `test-fs-mkdir-recursive-eaccess.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-mkdtemp.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-mkdtemp.ts:29035:40: error: [SEM0001] 'Buffer.byteLength' expects a stri |
| `test-fs-non-number-arguments-throw.js` | runtime error | — | runtime — TypeError: toString is not a function |
| `test-fs-null-bytes.js` | runtime error | — | runtime — zun: runtime error: call did not resolve to a method at <main> [1098830..1098851] |
| `test-fs-open.js` | spread arguments | [zun#11](https://github.com/UrubuCode/zun/issues/11) | type error — bundles/test-fs-open.ts:28947:31: error: [SEM0001] spread arguments are not lowered yet |
| `test-fs-opendir.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Expected values to be strictly deep-equal: |
| `test-fs-open-flags.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Expected values to be strictly deep-equal: |
| `test-fs-options-immutable.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-promises.js` | behaviour mismatch | — | assertion — AssertionError [strictEqual]: Expected values to be strictly equal: |
| `test-fs-promises-file-handle-aggregate-errors.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-aggregate-erro |
| `test-fs-promises-file-handle-append-file.js` | behaviour mismatch | — | assertion — AssertionError [rejects]: Missing expected rejection (AbortError). |
| `test-fs-promises-file-handle-close-errors.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-close-errors.j |
| `test-fs-promises-file-handle-dispose.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-file-handle-op-errors.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-promises-file-handle-op-errors.js: |
| `test-fs-promises-file-handle-read.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-promises-file-handle-read.ts:29034:30: error: [SEM0001] 'Buffer.from' ex |
| `test-fs-promises-file-handle-stream.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-file-handle-truncate.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-readfile.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-promises-readfile-empty.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-promises-readfile-with-fd.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-watch-iterator.js` | does not compile | — | parse — bundles/test-fs-promises-watch-iterator.ts:29032:9: error: [SEM0001] async functions mus |
| `test-fs-promises-writefile.js` | behaviour mismatch | — | assertion — AssertionError [rejects]: Missing expected rejection (AbortError). |
| `test-fs-promises-writefile-typedarray.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-promises-writefile-typedarray.ts:29029:35: error: [SEM0001] type BufferV |
| `test-fs-promises-writefile-with-fd.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-promises-write-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-promises-write-optional-params.ts:29084:15: error: [SEM0001] type Buffer |
| `test-fs-promisified.js` | behaviour mismatch | — | assertion — AssertionError [strictEqual]: Expected values to be strictly equal: |
| `test-fs-read.js` | behaviour mismatch | — | assertion — AssertionError [strictEqual]: Expected values to be strictly equal: |
| `test-fs-readdir.js` | behaviour mismatch | — | assertion — AssertionError [throws]: The input did not match the regular expression /Error: ENOTDIR: |
| `test-fs-readdir-recursive.js` | unresolved `require` | — | bundle failed — bundle_node_test.sh: unresolved require() in test-fs-readdir-recursive.js: |
| `test-fs-readdir-stack-overflow.js` | timed out | — | timeout —  |
| `test-fs-readdir-types.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-readdir-ucs2.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readdir-ucs2.ts:29039:38: error: [SEM0001] 'Buffer.from' expects a strin |
| `test-fs-read-empty-buffer.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-read-empty-buffer.ts:28890:16: error: [SEM0001] 'Uint8Array' expects at  |
| `test-fs-readfile.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readfile.ts:29041:35: error: [SEM0001] Buffer size must be an integer |
| `test-fs-readfile-error.js` | behaviour mismatch | — | assertion — AssertionError [match]: The input did not match the regular expression /EISDIR/. Input: |
| `test-fs-readfile-fd.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-readfile-flags.js` | runtime error | — | parse — TypeError: Cannot read properties of null (reading 'code') |
| `test-fs-readfile-pipe.js` | unresolved `require` | — | bundle failed — tools/bundle_node_test.sh: line 970: syntax error near unexpected token '(' |
| `test-fs-readfile-pipe-large.js` | unresolved `require` | — | bundle failed — tools/bundle_node_test.sh: line 935: syntax error near unexpected token ''\(node:\)\{0,1 |
| `test-fs-read-file-sync.js` | unresolved `require` | — | bundle failed — tools/bundle_node_test.sh: line 935: syntax error near unexpected token ''\(node:\)\{0,1 |
| `test-fs-readfilesync-enoent.js` | unresolved `require` | — | bundle failed — tools/bundle_node_test.sh: line 935: syntax error near unexpected token ''\(node:\)\{0,1 |
| `test-fs-read-file-sync-hostname.js` | unresolved `require` | — | bundle failed — tools/bundle_node_test.sh: line 935: syntax error near unexpected token ''\(node:\)\{0,1 |
| `test-fs-readfile-unlink.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readfile-unlink.ts:29045:26: error: [SEM0001] Buffer size must be an int |
| `test-fs-read-offset-null.js` | behaviour mismatch | — | assertion — AssertionError [strictEqual]: Expected values to be strictly equal: |
| `test-fs-read-optional-params.js` | spread arguments | [zun#11](https://github.com/UrubuCode/zun/issues/11) | type error — bundles/test-fs-read-optional-params.ts:28897:29: error: [SEM0001] spread arguments are  |
| `test-fs-read-promises-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-read-promises-optional-params.ts:28894:43: error: [SEM0001] type BufferV |
| `test-fs-read-stream.js` | unresolved `require` | — | bundle failed —  |
| `test-fs-read-stream-concurrent-reads.js` | runtime error | — | runtime — zun: runtime error: call did not resolve to a method at <closure@1096589> [1096684..1096 |
| `test-fs-read-stream-encoding.js` | runtime error | — | runtime — TypeError: equals is not a function |
| `test-fs-read-stream-file-handle.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Expected values to be strictly deep-equal: |
| `test-fs-read-stream-inherit.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-read-type.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Missing expected exception (RangeError). |
| `test-fs-readv.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readv.ts:29031:31: error: [SEM0001] Buffer size must be an integer |
| `test-fs-readv-promises.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-readv-promises.ts:29032:31: error: [SEM0001] Buffer size must be an inte |
| `test-fs-readv-promisify.js` | behaviour mismatch | — | assertion — AssertionError [deepStrictEqual]: Expected values to be strictly deep-equal: |
| `test-fs-readv-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — bundles/test-fs-readv-sync.ts:29033:31: error: [SEM0001] Buffer size must be an integer |
| `test-fs-realpath.js` | runtime error | — | assertion — start tests |
| `test-fs-realpath-buffer-encoding.js` | runtime error | — | runtime — bundles/test-fs-realpath-buffer-encoding.ts: error: OXC adapter supports declared for-in |
| `test-fs-realpath-native.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-realpath-on-substed-drive.js` | behaviour mismatch | — | assertion — AssertionError [strictEqual]: Expected values to be strictly equal: |
| `test-fs-rm.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-rmdir-recursive-error.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Missing expected exception. |
| `test-fs-stat.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-stat-bigint.js` | does not compile | — | type error — bundles/test-fs-stat-bigint.ts:29046:51: error: [SEM0001] 'BigInt' expects a string or n |
| `test-fs-statfs.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-stream-construct-compat-error-read.js` | does not compile | — | type error — bundles/test-fs-stream-construct-compat-error-read.ts:29026:30: error: [SEM0001] spread  |
| `test-fs-stream-construct-compat-error-write.js` | does not compile | — | type error — bundles/test-fs-stream-construct-compat-error-write.ts:29032:31: error: [SEM0001] spread |
| `test-fs-stream-construct-compat-graceful-fs.js` | does not compile | — | type error — bundles/test-fs-stream-construct-compat-graceful-fs.ts:29027:30: error: [SEM0001] spread |
| `test-fs-stream-construct-compat-old-node.js` | does not compile | — | type error — bundles/test-fs-stream-construct-compat-old-node.ts:29027:30: error: [SEM0001] spread ar |
| `test-fs-symlink-buffer-path.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-symlink-buffer-path.ts:29055:28: error: [SEM0001] 'Buffer.from' expects  |
| `test-fs-symlink-dir-junction.js` | callback never ran | — | parse — Mismatched function call: mustSucceed received an error: EPERM: operation not permitted, |
| `test-fs-symlink-dir-junction-relative.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-symlink-longpath.js` | callback never ran | — | parse — Mismatched function call: mustSucceed received an error: EPERM: operation not permitted, |
| `test-fs-sync-fd-leak.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-syncwritestream.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-truncate.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-truncate.ts:29042:27: error: [SEM0001] Buffer size must be an integer |
| `test-fs-truncate-clear-file-zero.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-truncate-sync.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-utils-get-dirents.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-utils-get-dirents.ts:31308:17: error: [SEM0001] 'Buffer.from' expects a  |
| `test-fs-utimes.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-watch-enoent.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-watchfile.js` | runtime error | — | runtime — ReferenceError: interval is not defined |
| `test-fs-watchfile-bigint.js` | behaviour mismatch | — | assertion — AssertionError [deepStrictEqual]: Values have same structure but are not reference-equal |
| `test-fs-watch-recursive-symlink.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-watch-recursive-sync-write.js` | runtime error | — | runtime — ReferenceError: watcher is not defined |
| `test-fs-watch-ref-unref.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-whatwg-url.js` | behaviour mismatch | — | assertion — AssertionError [==]: false == true |
| `test-fs-write.js` | behaviour mismatch | — | assertion — AssertionError [notStrictEqual]: Expected "actual" to be strictly unequal to: |
| `test-fs-write-buffer.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-buffer.ts:29174:31: error: [SEM0001] type BufferView(U8) has no fi |
| `test-fs-write-buffer-large.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-buffer-large.ts:29027:28: error: [SEM0001] Buffer size must be an  |
| `test-fs-write-file.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-file.ts:29048:42: error: [SEM0001] 'Buffer.byteLength' expects a s |
| `test-fs-write-file-buffer.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-file-buffer.ts:29057:8: error: [SEM0001] cannot assign String to A |
| `test-fs-write-file-flush.js` | behaviour mismatch | — | runtime — not ok - performs flush: Cannot read properties of undefined (reading 'method') |
| `test-fs-write-file-invalid-path.js` | behaviour mismatch | — | assertion — AssertionError [throws]: failed with '<' |
| `test-fs-write-file-sync.js` | does not compile | — | parse — bundles/test-fs-write-file-sync.ts:29126:66: error: [SEM0001] 'Math.random' is not suppo |
| `test-fs-write-file-typedarrays.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-file-typedarrays.ts:29027:33: error: [SEM0001] 'Buffer.from' expec |
| `test-fs-writefile-with-fd.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-write-negativeoffset.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Missing expected exception. |
| `test-fs-write-optional-params.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-optional-params.ts:29082:15: error: [SEM0001] type BufferView(U8)  |
| `test-fs-write-reuse-callback.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-write-reuse-callback.ts:29047:28: error: [SEM0001] Buffer size must be a |
| `test-fs-write-stream.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-write-stream-autoclose-option.js` | runtime error | — | engine panic — thread '<unnamed>' (44920) panicked at crates\zun_interp\src\value.rs:228:22: |
| `test-fs-write-stream-change-open.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-write-stream-encoding.js` | runtime error | — | runtime — TypeError: equals is not a function |
| `test-fs-write-stream-file-handle.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-write-stream-file-handle-2.js` | callback never ran | — | parse — Mismatched function call: <anonymous> called 0 times, expected exactly 1 |
| `test-fs-write-stream-flush.js` | behaviour mismatch | — | runtime — not ok - performs flush: Cannot read properties of undefined (reading 'method') |
| `test-fs-write-stream-patch-open.js` | uncaught error (address only) | [zun#8](https://github.com/UrubuCode/zun/issues/8) | runtime — zun: runtime error: unhandled exception: Object(Obj(0x…)) |
| `test-fs-writesync-crash.js` | behaviour mismatch | — | assertion — AssertionError [throws]: Expected values to be strictly deep-equal: |
| `test-fs-write-sync-optional-params.js` | spread arguments | [zun#11](https://github.com/UrubuCode/zun/issues/11) | parse — bundles/test-fs-write-sync-optional-params.ts:29037:30: error: [SEM0001] spread argument |
| `test-fs-writev.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-writev.ts:29040:47: error: [SEM0001] type BufferView(U8) has no fields |
| `test-fs-writev-promises.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | type error — bundles/test-fs-writev-promises.ts:29033:47: error: [SEM0001] type BufferView(U8) has no |
| `test-fs-writev-sync.js` | `Buffer` through `any` | [zun#38](https://github.com/UrubuCode/zun/issues/38) | parse — bundles/test-fs-writev-sync.ts:29037:45: error: [SEM0001] type BufferView(U8) has no fie |

A test is listed under the **first** thing that stops it, so a file whose
`Buffer.from(x)` is rejected at compile time is counted there even though it
would also have hit something else afterwards. "unresolved `require`" is a
module the bundler does not know (`internal/fs/promises`, `worker_threads`,
`node:net`, `../common/gc`); "uncaught error (address only)" is
[zun#8](https://github.com/UrubuCode/zun/issues/8), where the engine prints a
heap address instead of the error, so the row says nothing about the cause and
the test has to be re-run by hand to find it. The rest are described below.

### The blockers that cap this corpus

Everything listed above is implemented; these are the limits in front of it.

**[zun#38](https://github.com/UrubuCode/zun/issues/38) — a `Buffer` is opaque
through `any`,** with
[zun#58](https://github.com/UrubuCode/zun/issues/58) beside it. A typed array
reached through an `any` binding has no `length`, no indexing and no methods:
`buf.toString("utf8")` throws "toString is not a function" and `buf.length`
reads `undefined`. Inside `fs.ts` this is worked around by keeping every
`Buffer` in a statically typed binding (`__fsAsBuffer` re-types one that
arrives as `any`), but a *test file* is plain JavaScript, where every binding
is `any` — so `fs.readFileSync(p).equals(Buffer.from("hello"))` cannot work no
matter what this module returns. The companion restriction is a *compile*
error: `Buffer.from(x)`, `Buffer.byteLength(x)` and `Buffer.alloc(x)` are
rejected outright when `x` is `any`, which is how most of the corpus writes
them. It bites this module too — `Buffer.alloc(n)` only compiles for an
integer **literal**, so `src/fs/streams.ts` allocates one 64K scratch buffer
and slices it to the length a read asked for. Reads *with* an encoding return
strings and are unaffected, which is why they are the surface that passes
today. This one blocker is the first thing in the way of a third of the
corpus.

**A `functionBox` is invisible to `Promise.prototype.then`** — worked around
here. `typeof box === "function"` and `box()` calls it, but
`Promise.resolve(1).then(box)` never invokes it: `promiseThen`'s
`callback_arg` (`crates/zun_interp/src/collections.rs`) accepts only a
`Value::Function`, so an object-wrapped callable silently becomes `None` and
the reaction is attached with no handler. That stopped **21 of these 227
files**, every one of them ending in `assert.rejects(…).then(common.mustCall())`
— because `common.mustCall()` *has* to hand back a box: a function value
returned out of an object-literal method reads back as `null`, and out of a
class method as `undefined`.

The way out is that a **top-level function** can return a bare function value.
So `tools/harness/common.ts` grew `__commonMustCall`, `__commonMustCallAtLeast`,
`__commonMustNotCall` and `__commonMustSucceed` beside the four object-literal
methods, and `tools/bundle_node_test.sh` rewrites `common.mustCall(` & co. to
them. Nothing is lost by the bare form for these four: a bare function keeps
its identity through an array or an object property on this engine, and none of
the four wrappers carries an own property.

**[zun#34](https://github.com/UrubuCode/zun/issues/34) — a top-level
destructuring is invisible to functions** — also worked around in the bundler.
`const { sep } = path;` reads correctly at top level and raises a
`ReferenceError` from inside any function, and `const { x } = require('m')` is
how Node's tests spell half of their imports. The bundler now splits such a
line into one member read per name (`const sep = path.sep;`), which is visible
everywhere; it does so only when the right-hand side is a bare reference and
every entry is a plain name or a `name: alias` pair.

**A top-level `return`** is legal in a CommonJS module (the module body is a
function) and is how seven files here spell an early `common.skip`. A bundle is
one program, where the parser rejects it — so the bundler now wraps the test
body in a function of its own when the source has one, and only then.

**BigInt `*` and `/` through `any`** (new, not filed): with both operands
`any`-typed and holding BigInts, `a * b` and `a / b` raise
`zun: runtime error: unhandled exception`, and a `typeof x === "bigint"`
narrowing makes `/` **panic the interpreter** ("expected float, found Object",
`crates/zun_interp/src/value.rs:157`) because the compiler emits float division
for the narrowed `any`. The gate is `lhs.ty == Ty::BigInt && rhs.ty ==
Ty::BigInt` in `crates/zun_sema/src/check/expr/operators.rs`, which a dynamic
operand never satisfies; `+` and `-` happen to survive. `BigIntStats` divides
nanoseconds by a million, so it goes through a float instead.

**Node's `_write` is reached with a *string*.** `src/stream/stream.ts` keeps a
written string as a string and only tags its encoding `"buffer"`, where Node's
`decodeStrings: true` would have handed `_write` a `Buffer`. `src/fs/streams.ts`
converts it (`__fsStreamBytes`). Without that conversion the string reaches
`__fsAsBuffer`, whose cast is a lie for a string, and reading `.length` off it
**abandons the running frame with no exception at all** — the caller resumes as
though the call had returned, which inside `__sHookWrite`'s
`return stream._write(...)` looks exactly like "this stream has no `_write`".
That silent frame abandonment is worth filing on its own.

Two smaller ones, each affecting a handful of files:

* **[zun#9](https://github.com/UrubuCode/zun/issues/9)** — a string literal
  containing U+0000 is truncated at the NUL, so `test-fs-null-bytes.js` cannot
  even express its input.
* **Stack exhaustion is not catchable.** `test-fs-readdir-stack-overflow.js`
  asserts that an infinitely recursive `readdirSync` throws a `RangeError`
  whose message is "Maximum call stack size exceeded"; here the run never
  returns.

One blocker in the old table is **gone**: the bare `assert(value)` form
([zun#14](https://github.com/UrubuCode/zun/issues/14)) works on this engine
build — `assert(true)` and `assert(fs.existsSync(dir))` both call through — so
the nine files it used to stop are now counted under whatever is actually in
front of them.

# node:zlib — Node.js compatibility tests

The compatibility bar for `zlib` is **Node.js 25's own test suite**, not tests
we write. `zlib` is **not finished** until it passes 100% of Node's
`test-zlib*` tests.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module —
sixty files under the single `test-zlib` prefix, which includes `test-zlib.js`
itself. Each file is fetched verbatim from `nodejs/node` at tag `v25.0.0`;
nothing is vendored here. `NODE_FIXTURES.txt` lists the eight
`test/fixtures/*` files those tests open (`person.jpg` and its `.gz`/`.br`
companions, the two pseudo-multimember archives, `pss-vectors.json`,
`elipses.txt`, `empty.txt`), which the tracker downloads next to the test file
so the harness's `path.join(__dirname, "..", "fixtures")` finds them.

## How they run

`zlib` is a `zun-ts+ext` module, the kind `os` established: the Node-shaped API
is TypeScript and the compression engines are Rust behind the ABI.

```sh
cargo build -p zun_cli                              # the `zun` binary
cargo build --manifest-path zun-node/Cargo.toml     # the extension cdylib
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --ext zun-node/target/debug/libzun_node.so \
    --module zlib
```

Each test is bundled by `tools/bundle_node_test.sh` (`util` → `events` →
`process` → `assert` → `path` → `querystring` → `punycode` → `url` → `timers` →
`console` → `buffer` → `string_decoder` → **`stream`** → **`zlib`** → the
harness) and then run as `zun run --ext <lib> <bundle.ts>`. `stream` is in that
list because every class this module exports is a `Transform`.

## What is implemented

The whole Node 25 `zlib` surface, zstd included:

* **Streams**: `Deflate`, `Inflate`, `Gzip`, `Gunzip`, `DeflateRaw`,
  `InflateRaw`, `Unzip` (auto-detecting zlib or gzip), `BrotliCompress`,
  `BrotliDecompress`, `ZstdCompress`, `ZstdDecompress`, each callable with or
  without `new` (the export is a function sharing the class prototype), each a real `Transform` with `flush`, `params`, `reset`,
  `close`, `bytesWritten`, `_closed`, `_level`, `_strategy`, `_handle` and
  `_processChunk`.
* **Factories**: `createDeflate`, `createInflate`, `createDeflateRaw`,
  `createInflateRaw`, `createGzip`, `createGunzip`, `createUnzip`,
  `createBrotliCompress`, `createBrotliDecompress`, `createZstdCompress`,
  `createZstdDecompress`.
* **Convenience methods**: the eleven `*Sync` forms and the eleven callback forms,
  with Node's `(buffer, opts, callback)` / `(buffer, callback)` overloads,
  `maxOutputLength` + `ERR_BUFFER_TOO_LARGE`, and `info: true` results
  (`{ buffer, engine }`).
* **`crc32`**, over zlib's own table, with the seeded form and
  `validateUint32` on the seed.
* **Data**: `constants` (frozen, including the `BROTLI_*` and `ZSTD_*` tables
  and `Z_MAX_CHUNK: Infinity`), `codes` (frozen, with Node's numeric reverse
  mapping) and the legacy non-enumerable top-level `Z_*` aliases.
* **Errors**: `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` from
  `checkRangesOrGetDefault` over `chunkSize`, `flush`, `finishFlush`,
  `maxOutputLength`, `windowBits`, `level`, `memLevel`, `strategy` and
  `params()`'s two arguments; `ERR_BROTLI_INVALID_PARAM`,
  `ERR_ZSTD_INVALID_PARAM`, `ZSTD_error_srcSize_wrong` for a wrong
  `pledgedSrcSize`,
  `ERR_ZLIB_INITIALIZATION_FAILED`, `ERR_BUFFER_TOO_LARGE`,
  `ERR_TRAILING_JUNK_AFTER_STREAM_END`; and the compression errors themselves
  with Node's `(message, code, errno)` — `Z_DATA_ERROR` carrying zlib's own
  text (`incorrect header check`), the `Z_BUF_ERROR`/`unexpected end of file`
  of a truncated stream, and `Missing dictionary` vs `Bad dictionary`.

The engines are `libz-rs-sys` (the C API of `zlib-rs`, a memory-safe Rust
rewrite of zlib whose output is byte-identical to zlib's) and the `brotli`
crate (a port of the reference encoder and decoder) — both pure Rust, so this
extension still builds with nothing but a Rust toolchain. `src/zlib/zstream.rs`
follows Node's `src/node_zlib.cc` call for call: the per-mode `windowBits`
rewriting, the `Z_NEED_DICT` retry, the concatenated-gzip member loop and the
error classification. Wire compatibility is pinned by Rust tests that decode
blobs produced by the real libraries, and by the empty-input byte sequences
(`deflate` of nothing is `78 9c 03 00 00 00 00 01`, `gzip` of nothing is 20
bytes).

**zstd** runs over `ruzstd` (pure Rust: a complete decoder and an encoder),
in `src/zlib/zstd.rs`. `ZSTD_e_flush` emits the buffered input as raw blocks
of an open frame behind libzstd's own streaming header (`28 b5 2f fd 00 58`),
so a flushed chunk is byte-for-byte what Node produces
(`test-zlib-zstd-flush.js`); `ZSTD_e_end` closes the frame, compressing it in
one go when it was never flushed. Decompression decodes every complete frame
as soon as it is buffered, skippable frames included.

## What is not implemented

* **zstd compression levels.** `ruzstd`'s encoder implements only its
  "fastest" level (about zstd level 1), so `ZSTD_c_compressionLevel` is
  validated and accepted but every level produces the same output, which is
  what `test-zlib-zstd.js` measures. zstd dictionaries are accepted and
  ignored (frames are written without a dictionary id, so they still decode
  with or without one).

## Blockers

45 of the 60 files pass on the current engine. What is left is mostly not
this module: test-body classes with undeclared fields (zun#38), harness gaps
(`gc`, `crypto`, WHATWG compression streams), the `kMaxLength`-before-`require`
trick the bundler cannot honour, and zstd's single compression level.

| Test | Blocker |
|---|---|
| `test-zlib.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38): a test-body class assigns `this.chunks` / `this.length` with no declaration |
| `test-zlib-brotli-16GB.js` | allocates 16 GB of input; times out |
| `test-zlib-brotli-kmaxlength-rangeerror.js`, `test-zlib-kmaxlength-rangeerror.js`, `test-zlib-zstd-kmaxlength-rangeerror.js` | set `buffer.kMaxLength = 64` *before* `require('zlib')` and rely on module caching to freeze that value; the bundler inlines `zlib` ahead of the test body, so the assignment comes too late |
| `test-zlib-deflate-raw-inherits.js` | `DeflateRaw.call(this, opts)` — there is no function-constructor model ([zun#25](https://github.com/UrubuCode/zun/issues/25)) |
| `test-zlib-from-concatenated-gzip.js` | the streamed half reads a fixture through `fs.createReadStream` and compares chunk-by-chunk output |
| `test-zlib-invalid-input-memory.js` | needs `../common/gc` and `globalThis.gc()` |
| `test-zlib-invalid-input.js` | [zun#117](https://github.com/UrubuCode/zun/issues/117): a `forEach` callback wrapped by `common.mustCall` (a function that reads `this`) gets its arguments shifted, so `uz.on` is read off the index |
| `test-zlib-params.js` | times out on the loaded test machine (it pushes the whole `person.jpg` fixture through `params()` and a paused reader) |
| `test-zlib-random-byte-pipes.js` | needs `node:crypto`; also assigns `this.readable` on a test-body class with no declaration |
| `test-zlib-type-error.js` | needs the WHATWG `CompressionStream`/`DecompressionStream` and `Blob#stream` |
| `test-zlib-unused-weak.js` | needs `globalThis.gc()` and `--expose-gc` |
| `test-zlib-unzip-one-byte-chunks.js` | one-byte writes into `Unzip` lose the second gzip member |
| `test-zlib-zstd.js` | `ruzstd` has a single compression level, so the level-vs-size curve is flat (see above) |

## Verified outside the corpus

Because zun#38 hides the bytes from the tests, the compression is verified two
other ways:

1. **22 Rust tests** (`src/zlib/tests.rs`, in `cargo test`) over the engines
   directly: round trips in every mode, the gzip header, the zlib wrapper's
   exact six-byte overhead, the empty-input byte sequences, decoding blobs the
   real zlib and the reference Brotli encoder produced, dictionaries,
   concatenated gzip members, `windowBits: 0` and the raw 8-bit window,
   `reset`, `params` mid-stream, the four error classifications, Brotli quality
   monotonicity and the rejected boolean parameter, and the `crc32` vectors
   `test-zlib-crc32.js` asserts.
2. **A differential pass against the module's own `crc32`**, which stays inside
   the module and therefore sees real `Buffer`s: `zlib.crc32(decompress(
   compress(x))) === zlib.crc32(x)` holds for `deflate`/`inflate`,
   `gzip`/`gunzip`, raw, `unzip` over both wrappers, Brotli, with a dictionary,
   at `level: 0`, at `chunkSize: 64`, through the callback API and through a
   piped `Deflate` → `Inflate` stream pair; `bytesWritten` is exact; and the
   `finishFlush: Z_SYNC_FLUSH` reading of a truncated gzip answers the same
   three bytes Node answers.

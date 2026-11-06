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

The whole Node 25 `zlib` surface except zstd:

* **Streams**: `Deflate`, `Inflate`, `Gzip`, `Gunzip`, `DeflateRaw`,
  `InflateRaw`, `Unzip` (auto-detecting zlib or gzip), `BrotliCompress`,
  `BrotliDecompress`, each a real `Transform` with `flush`, `params`, `reset`,
  `close`, `bytesWritten`, `_closed`, `_level`, `_strategy`, `_handle` and
  `_processChunk`.
* **Factories**: `createDeflate`, `createInflate`, `createDeflateRaw`,
  `createInflateRaw`, `createGzip`, `createGunzip`, `createUnzip`,
  `createBrotliCompress`, `createBrotliDecompress`.
* **Convenience methods**: the nine `*Sync` forms and the nine callback forms,
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

## What is not implemented

**zstd** — Node 25's `ZstdCompress`, `ZstdDecompress`, `zstdCompress*`,
`zstdDecompress*` and `createZstd*`. Every pure-Rust zstd crate today is
decompression-only, and a C-backed one would break this extension's "a Rust
toolchain is the whole build" rule (see the dependency comment in
`../../Cargo.toml`). The `ZSTD_*` constants are present, because
`zlib.constants` is observable on its own; the classes and methods are not.
Seven files in the corpus are zstd-only and three more use zstd alongside the
other codecs.

## Blockers

The dominant blocker is **zun#38**, and it is worth stating plainly because it
caps this corpus rather than this module: a typed array is *opaque* through an
`any` binding in this engine — no `length`, no indexing, no `toString`. Every
`Buffer` this module hands back reaches a Node test through an `any` binding
(`const out = zlib.gzipSync(x)`, a `'data'` listener's parameter), so
`out.length` reads `undefined` and `out.toString()` throws. The compression
itself is correct — the Rust tests and a differential pass against Node
(`zlib.crc32` of a round trip, which stays inside the module, agrees in every
codec and option combination tried) confirm it — but a test that *compares
bytes* cannot see it. That is why the files passing here are the ones asserting
on errors, constants, events and option validation.

| Test | Blocker |
|---|---|
| `test-zlib.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) a test-body class assigns `this.chunks` with no declaration; also needs zstd and `fixtures.readSync` |
| `test-zlib-brotli-16GB.js` | allocates 16 GB of input; times out |
| `test-zlib-brotli-flush.js` | `fixtures.readSync` is not available in the harness (it would need `node:fs` inlined into every bundle) |
| `test-zlib-brotli-from-brotli.js` | `fs.createReadStream` / `fs.createWriteStream` are declared gaps in `src/fs/fs.ts` |
| `test-zlib-brotli-kmaxlength-rangeerror.js` | sets `buffer.kMaxLength = 64` *before* `require('zlib')` and relies on module caching to freeze that value; the bundler inlines `zlib` ahead of the test body, so the assignment comes too late |
| `test-zlib-brotli.js` | `fixtures.readSync`, then [zun#38](https://github.com/UrubuCode/zun/issues/38) for `encoded.length` |
| `test-zlib-close-in-ondata.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.alloc(1024 * 1024 * 20)` — a `number` cannot be a Buffer size |
| `test-zlib-convenience-methods.js` | needs zstd; also `instanceof` against an `any`-held constructor in the test body ([zun#19](https://github.com/UrubuCode/zun/issues/19)) |
| `test-zlib-crc32.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.from(data, 'utf8')` where `data` came out of an array of mixed types |
| `test-zlib-deflate-constructors.js` | [zun#25](https://github.com/UrubuCode/zun/issues/25) `zlib.Deflate()` without `new` — a class is not callable here |
| `test-zlib-deflate-raw-inherits.js` | [zun#25](https://github.com/UrubuCode/zun/issues/25) `Object.setPrototypeOf(NotInitialized.prototype, DeflateRaw.prototype)` — there is no function-constructor model |
| `test-zlib-destroy-pipe.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.allocUnsafe(1024 * 1024 * 20)` |
| `test-zlib-dictionary.js` | `common.getBufferSources` is not in the harness (it enumerates the typed-array family, of which this engine has one member) |
| `test-zlib-empty-buffer.js` | needs zstd |
| `test-zlib-flush-drain.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.alloc(bigValue, 'x')` — a `number` cannot be a Buffer fill byte |
| `test-zlib-from-concatenated-gzip.js` | `fs.createReadStream` is a declared gap in `src/fs/fs.ts` (the `inflateSync` half of the test is correct — the Rust tests cover concatenated members) |
| `test-zlib-from-gzip-with-trailing-garbage.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) `Buffer.concat` over `any`-held views in the test body |
| `test-zlib-from-gzip.js` | `fs.createReadStream` / `createWriteStream` |
| `test-zlib-invalid-arg-value-brotli-compress.js` | [zun#25](https://github.com/UrubuCode/zun/issues/25) `BrotliCompress(opts)` without `new` |
| `test-zlib-invalid-input-memory.js` | needs `../common/gc` and `globalThis.gc()` |
| `test-zlib-invalid-input.js` | [zun#25](https://github.com/UrubuCode/zun/issues/25) `zlib.Unzip()`, `zlib.Gunzip()`, … without `new`; also needs zstd |
| `test-zlib-kmaxlength-rangeerror.js` | as the brotli variant: `buffer.kMaxLength` is mutated before `require('zlib')` |
| `test-zlib-params.js` | `fixtures.readSync` |
| `test-zlib-random-byte-pipes.js` | needs `node:crypto`; also assigns `this.readable` on a test-body class with no declaration |
| `test-zlib-sync-no-event.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) `unzipped.toString()` — `_processChunk` itself is correct and answers the right bytes |
| `test-zlib-truncated.js` | ✅ passes |
| `test-zlib-type-error.js` | needs the WHATWG `CompressionStream`/`DecompressionStream` and `Blob#stream` |
| `test-zlib-unused-weak.js` | needs `globalThis.gc()` and `--expose-gc` |
| `test-zlib-zstd-*.js` (7 files) | zstd is not implemented — see above |

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

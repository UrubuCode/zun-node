// node:zlib — the Node-shaped `zlib` module, in Zun TypeScript over the native
// `node:zlib` extension.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-zlib*.js` files (see ../../test/zlib/).
// The API shaping follows Node's `lib/zlib.js` (MIT, Copyright Joyent, Inc. and
// other Node contributors) instruction for instruction — the `processChunk`
// chunking loop and its `availOut`/`availIn` accounting, the `maxFlush`
// flushiness table, the `flush()`/`params()` write ordering, the
// `zlibBuffer`/`zlibBufferSync` convenience wrappers, the `checkRangesOrGet-
// Default` validation and the per-mode `windowBits` rules — because the
// observable contract of Node's `zlib` *is* that file: which error a bad
// option produces, how `bytesWritten` is counted, and when `maxOutputLength`
// trips are pinned by the corpus and not derivable from any general rule.
//
// ---------------------------------------------------------------------------
// Why this module is split in two
// ---------------------------------------------------------------------------
//
// `zlib` is a *TS-over-natives* module, the shape `node:os` established and
// `node:fs` repeated, and the line is PLAN.md principle 2:
//
//   * `src/zlib/mod.rs` answers only what needs a compression engine: one
//     `z_stream` (or Brotli encoder/decoder) per handle, `init`/`write`/
//     `params`/`reset`/`close`, and `crc32`. It knows nothing about streams,
//     option objects or Node errors.
//   * this file is everything that is shape rather than compression — the nine
//     `Transform` classes, the `create*` factories, the sync and callback
//     convenience methods, `constants`/`codes`, the option validation and the
//     `ERR_*` errors, `bytesWritten`, `flush`/`params`/`reset`/`close`,
//     `maxOutputLength` and `info`.
//
// Nothing structured crosses ABI v1, whose carrier is one scalar word, so the
// natives hand this file status-prefixed, separator-delimited strings and this
// file parses them; the grammar is documented in `src/zlib/mod.rs`:
//
//     result  := "+" payload | "-"        payload := field (US field)*
//     US = U+001F
//
// A leading "-" means the call failed, and the three error slots
// (`zlibErrorMessage`, `zlibErrorCode`, `zlibErrorErrno`) then hold exactly
// what Node's `zlib` error reports — which is why a truncated stream here
// raises the same `Z_BUF_ERROR` / "unexpected end of file" it raises in Node.
// Failure is reported in band rather than through the ABI status for the reason
// `src/fs/fs.ts` gives (https://github.com/UrubuCode/zun/issues/33).
//
// Compressed and decompressed **bytes** cross as base64, the convention
// `node:fs` set: the `Str` carrier is a NUL-terminated C string and compressed
// data is neither NUL-free nor UTF-8. The engine's prelude `Buffer` implements
// that codec on both sides.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `__zAsBuffer` before anything is read off a byte view that arrived
//     through an `any`: a typed array is *opaque* through `any` in this engine
//     (zun#38) — no `length`, no indexing, no `toString` — so every chunk this
//     module receives from the stream machinery is re-typed first. The same
//     bug caps what the corpus can observe: a `Buffer` this module *returns*
//     (`zlib.gzipSync(x)`, or a chunk pushed to a `'data'` listener) reaches
//     the test through an `any` binding, where `.length` reads `undefined` and
//     `.toString()` throws. That is why the tests this module passes today are
//     the ones that assert on errors, constants and events rather than on
//     bytes. See ../../test/zlib/README.md.
//   * `Buffer.from(chunk)` does not compile when `chunk` is an `any` (zun#58),
//     so `__zToBase64` re-types the value into a local of declared type first.
//   * `Number(x.length)` throughout: `.length` is typed `u64` at the type
//     level (zun#3), so it can be neither compared nor arithmetic'd as is.
//   * the stream hooks are installed through `__sSetOptFn` (the store
//     `src/stream/stream.ts` keeps for `options.transform` and friends) rather
//     than by assigning `this._transform = …`: `_transform` and `_flush` are
//     *accessors* on `Transform`, and assigning to an accessor through an `any`
//     receiver panics the interpreter (see that file's header note). The store
//     is the same one the accessor writes to, so the effect is identical.
//   * `flush(kind, cb)` queues the flush flag on the stream instead of
//     tagging the zero-length carrier buffer with it. Node puts a symbol-keyed
//     property on `kFlushBuffers[kind]`; a byte view here has no fields at all
//     (`type BufferView(U8) has no fields`), so the flag travels in a FIFO
//     beside the stream and is claimed by the next zero-length chunk — which,
//     because writes are ordered, is the very chunk `flush()` just wrote.
//   * a class cannot be called without `new` in this engine (zun#25), so
//     `zlib.Deflate()` — Node's DEP0184 form — raises a `ReferenceError`
//     instead of constructing. Four files in the corpus open with that
//     spelling; see ../../test/zlib/README.md.

// ---------------------------------------------------------------------------
// Two deviations that are scheduling, not behaviour
// ---------------------------------------------------------------------------
//
// The natives are **synchronous**: Node hands a compression job to libuv's
// threadpool, and this engine has no threadpool to hand one to. The *accounting*
// is unaffected — the loop below is Node's `processChunk` instruction for
// instruction, `_outOffset` included, so the chunk boundaries a `'data'`
// listener sees are the ones Node produces — but two consequences are visible:
//
//   * **Backpressure is not honoured mid-chunk.** Node stops calling the
//     binding when `push()` answers `false` and resumes from `_read`; here the
//     whole chunk is processed in one pass, so a reader that is not consuming
//     accumulates the output in the readable buffer instead of leaving it
//     unproduced. Nothing observable changes for a consumer that reads; a
//     20 MB write to a paused stream costs more memory than it does in Node.
//   * **`params()` guards on `writableEnded`.** In Node a chunk written
//     between `params()` and its callback is still queued when the callback
//     fires; here it has already been compressed, and `deflateParams` on a
//     stream that has seen its `Z_FINISH` is a `Z_STREAM_ERROR`. See
//     `__zParamsAfterFlush`.
//
// ---------------------------------------------------------------------------
// What is not here
// ---------------------------------------------------------------------------
//
// zstd (`ZstdCompress`, `zstdCompressSync`, …), which Node 25 added. Every
// pure-Rust zstd crate today is decompression-only, and a C-backed one would
// break this extension's "a Rust toolchain is the whole build" rule — see the
// dependency comment in ../../Cargo.toml. The `ZSTD_*` constants are present
// (they are just numbers, and `zlib.constants` is observable on its own), the
// classes and methods are not.

import * as __zNative from "node:zlib";

// ---------------------------------------------------------------------------
// The carrier
// ---------------------------------------------------------------------------

// Unit separator: between the fields of one native result. See
// `src/zlib/mod.rs`.
const __Z_US: string = "\u001f";

// Re-type an `any` known to hold a byte view (zun#38). Not style: without it
// `chunk.length` reads `undefined` and `chunk.toString("base64")` throws.
function __zAsBuffer(value: any): Buffer {
  return value;
}

// Is this a byte view this module can read? `Buffer.isBuffer` answers `true`
// for every `Uint8Array`-family view (they share one runtime type) and `false`
// for a string, a number, `null` and a plain object — so it is both the test
// and the only one available, since a view's own `byteLength` is unreadable
// through `any`.
function __zIsByteView(value: any): boolean {
  if (value === null || value === undefined) return false;
  return Buffer.isBuffer(value);
}

// An encoding name for a string chunk. The writable side of a Zun stream keeps
// a string chunk as a string (see `src/stream/stream.ts`' header), so this
// module decodes it here, with the encoding the write carried.
function __zEncodingOf(encoding: any): string {
  if (encoding === undefined || encoding === null) return "utf8";
  const name: string = String(encoding);
  if (name === "" || name === "buffer") return "utf8";
  return name;
}

// A chunk as base64, accepting everything a write can deliver: a string in the
// given encoding, or any byte view.
function __zToBase64(chunk: any, encoding: any): string {
  if (typeof chunk === "string") {
    // The local has a declared type because `Buffer.from` of an `any` does not
    // compile (zun#58).
    const text: string = chunk;
    const bytes: Buffer = Buffer.from(text, __zEncodingOf(encoding));
    return bytes.toString("base64");
  }
  const view: Buffer = __zAsBuffer(chunk);
  return view.toString("base64");
}

// The byte length of a chunk, which is what `availIn` and `writableLength` are
// counted in.
function __zByteLen(chunk: any, encoding: any): number {
  if (typeof chunk === "string") {
    const text: string = chunk;
    return Number(Buffer.byteLength(text, __zEncodingOf(encoding)));
  }
  const view: Buffer = __zAsBuffer(chunk);
  return Number(view.length);
}

// `process.nextTick`, through `../process/process.ts`' FIFO queue — which is
// also what the harness watches to decide the loop has gone quiet.
function __zTick(fn: any, a?: any): void {
  if (fn === undefined || fn === null) return;
  if (a === undefined) {
    __processNextTick(fn);
  } else {
    __processNextTick(fn, a);
  }
}

// Invoke a callback that has no receiver of its own, unboxing it first: a
// callable that crossed the `any` lane arrives as a `functionBox` record
// (zun#17/#50) which carries no `call` of its own.
function __zInvoke(fn: any, args: any[]): any {
  if (fn === undefined || fn === null) return undefined;
  const target: any = __evUnbox(fn);
  return target(...args);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// The `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` carriers live in
// `src/events/events.ts`, where the `NodeTypeError` / `NodeRangeError` bases
// with a **declared** `code` field live; writing `code` onto a plain
// `TypeError` through an `any` alias poisons the instance (zun#37). The four
// below are new with this module, so they are declared here rather than in
// that shared file.

// `lib/internal/errors.js`' `ERR_BUFFER_TOO_LARGE`, a `RangeError`.
class ERR_BUFFER_TOO_LARGE extends NodeRangeError {
  constructor(max: any) {
    super(
      "ERR_BUFFER_TOO_LARGE",
      "Cannot create a Buffer larger than " + String(max) + " bytes",
    );
  }
}

// `ERR_BROTLI_INVALID_PARAM`, a `RangeError`.
class ERR_BROTLI_INVALID_PARAM extends NodeRangeError {
  constructor(key: any) {
    super(
      "ERR_BROTLI_INVALID_PARAM",
      String(key) + " is not a valid Brotli parameter",
    );
  }
}

// `ERR_ZLIB_INITIALIZATION_FAILED`, which the native raises for a rejected
// Brotli parameter.
class ERR_ZLIB_INITIALIZATION_FAILED extends NodeError {
  constructor() {
    super("ERR_ZLIB_INITIALIZATION_FAILED", "Initialization failed");
  }
}

class ERR_TRAILING_JUNK_AFTER_STREAM_END extends NodeError {
  constructor() {
    super(
      "ERR_TRAILING_JUNK_AFTER_STREAM_END",
      "Trailing garbage found after the compressed stream",
    );
  }
}

// The error a failed compression step produces. Node builds it with
// `genericNodeError(message, { errno, code })`, which is a plain `Error`
// carrying `code` and `errno` as own properties — so `name` stays `"Error"`
// and only the two extra fields are added.
class __ZlibError extends NodeError {
  errno: number = 0;
  constructor(code: string, message: string, errno: number) {
    super(code, message);
    this.errno = errno;
  }
}

// Build the error the per-thread slots describe, after a native answered `-`.
// `ERR_ZLIB_INITIALIZATION_FAILED` is recognised by code so that a rejected
// Brotli parameter is the error Node raises rather than a generic one.
function __zTakeError(): any {
  const code: string = String(__zNative.zlibErrorCode());
  const message: string = String(__zNative.zlibErrorMessage());
  const errno: number = Number(__zNative.zlibErrorErrno());
  if (code === "ERR_ZLIB_INITIALIZATION_FAILED") return new ERR_ZLIB_INITIALIZATION_FAILED();
  return new __ZlibError(code, message, errno);
}

// The payload of a `+`-prefixed native result, or the stashed error thrown.
function __zPayload(result: any): string {
  const text: string = String(result);
  if (text.charAt(0) !== "+") throw __zTakeError();
  return text.slice(1);
}

// ---------------------------------------------------------------------------
// Validation (`lib/internal/validators.js`)
// ---------------------------------------------------------------------------

function __zValidateNumber(value: any, name: string): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
}

function __zValidateFunction(value: any, name: string): void {
  if (!__evIsFn(value)) throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
}

function __zValidateUint32(value: any, name: string): void {
  __zValidateNumber(value, name);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  if (value < 0 || value > 4294967295) {
    throw new ERR_OUT_OF_RANGE(name, ">= 0 && <= 4294967295", value);
  }
}

// `validateFiniteNumber`: answers whether `value` is a usable number, `false`
// for "absent" (`undefined` or `NaN`, which both fall back to the default) and
// a throw for a wrong type or an infinity.
function __zIsFiniteNumber(value: any, name: string): boolean {
  if (value === undefined) return false;
  if (typeof value === "number" && Number.isNaN(value)) return false;
  __zValidateNumber(value, name);
  if (!Number.isFinite(value)) throw new ERR_OUT_OF_RANGE(name, "a finite number", value);
  return true;
}

// `checkRangesOrGetDefault`.
function __zRange(value: any, name: string, lower: number, upper: number, fallback: any): any {
  if (!__zIsFiniteNumber(value, name)) return fallback;
  if (value < lower || value > upper) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + String(lower) + " and <= " + String(upper), value);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// Node reads these from `internalBinding('constants').zlib`, i.e. straight out
// of zlib's and Brotli's headers. They are the same numbers here, and
// `zlib.constants` is frozen because the binding's object is
// (`test-zlib-const.js` asserts the assignment throws).

const __Z_NO_FLUSH: number = 0;
const __Z_PARTIAL_FLUSH: number = 1;
const __Z_SYNC_FLUSH: number = 2;
const __Z_FULL_FLUSH: number = 3;
const __Z_FINISH: number = 4;
const __Z_BLOCK: number = 5;

const __Z_MIN_WINDOWBITS: number = 8;
const __Z_MAX_WINDOWBITS: number = 15;
const __Z_DEFAULT_WINDOWBITS: number = 15;
const __Z_MIN_CHUNK: number = 64;
const __Z_DEFAULT_CHUNK: number = 16384;
const __Z_MIN_MEMLEVEL: number = 1;
const __Z_MAX_MEMLEVEL: number = 9;
const __Z_DEFAULT_MEMLEVEL: number = 8;
const __Z_MIN_LEVEL: number = -1;
const __Z_MAX_LEVEL: number = 9;
const __Z_DEFAULT_COMPRESSION: number = -1;
const __Z_DEFAULT_STRATEGY: number = 0;
const __Z_FIXED: number = 4;

// `node_zlib_mode`, which the natives take unchanged.
const __Z_MODE_DEFLATE: number = 1;
const __Z_MODE_INFLATE: number = 2;
const __Z_MODE_GZIP: number = 3;
const __Z_MODE_GUNZIP: number = 4;
const __Z_MODE_DEFLATERAW: number = 5;
const __Z_MODE_INFLATERAW: number = 6;
const __Z_MODE_UNZIP: number = 7;
const __Z_MODE_BROTLI_DECODE: number = 8;
const __Z_MODE_BROTLI_ENCODE: number = 9;

const __Z_BROTLI_OPERATION_PROCESS: number = 0;
const __Z_BROTLI_OPERATION_FLUSH: number = 1;
const __Z_BROTLI_OPERATION_FINISH: number = 2;
const __Z_BROTLI_OPERATION_EMIT_METADATA: number = 3;

// The highest `BROTLI_PARAM_*` value, i.e. the length of the dense parameter
// array Node builds minus one.
const __Z_MAX_BROTLI_PARAM: number = 8;

// `buffer.kMaxLength`, the ceiling on `maxOutputLength`.
const __Z_MAX_LENGTH: number = 9007199254740991;

const __zConstants: any = Object.freeze({
  // Flush levels.
  Z_NO_FLUSH: __Z_NO_FLUSH,
  Z_PARTIAL_FLUSH: __Z_PARTIAL_FLUSH,
  Z_SYNC_FLUSH: __Z_SYNC_FLUSH,
  Z_FULL_FLUSH: __Z_FULL_FLUSH,
  Z_FINISH: __Z_FINISH,
  Z_BLOCK: __Z_BLOCK,
  Z_TREES: 6,

  // Return codes.
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,

  // Compression levels.
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: __Z_DEFAULT_COMPRESSION,

  // Strategies.
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: __Z_FIXED,
  Z_DEFAULT_STRATEGY: __Z_DEFAULT_STRATEGY,

  ZLIB_VERNUM: 4800,
  DEFLATE: __Z_MODE_DEFLATE,
  INFLATE: __Z_MODE_INFLATE,
  GZIP: __Z_MODE_GZIP,
  GUNZIP: __Z_MODE_GUNZIP,
  DEFLATERAW: __Z_MODE_DEFLATERAW,
  INFLATERAW: __Z_MODE_INFLATERAW,
  UNZIP: __Z_MODE_UNZIP,
  BROTLI_DECODE: __Z_MODE_BROTLI_DECODE,
  BROTLI_ENCODE: __Z_MODE_BROTLI_ENCODE,
  ZSTD_COMPRESS: 10,
  ZSTD_DECOMPRESS: 11,

  // Option bounds. `Z_MAX_CHUNK` really is `Infinity` in Node.
  Z_MIN_WINDOWBITS: __Z_MIN_WINDOWBITS,
  Z_MAX_WINDOWBITS: __Z_MAX_WINDOWBITS,
  Z_DEFAULT_WINDOWBITS: __Z_DEFAULT_WINDOWBITS,
  Z_MIN_CHUNK: __Z_MIN_CHUNK,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: __Z_DEFAULT_CHUNK,
  Z_MIN_MEMLEVEL: __Z_MIN_MEMLEVEL,
  Z_MAX_MEMLEVEL: __Z_MAX_MEMLEVEL,
  Z_DEFAULT_MEMLEVEL: __Z_DEFAULT_MEMLEVEL,
  Z_MIN_LEVEL: __Z_MIN_LEVEL,
  Z_MAX_LEVEL: __Z_MAX_LEVEL,
  Z_DEFAULT_LEVEL: __Z_DEFAULT_COMPRESSION,

  // Brotli operations (~flush levels).
  BROTLI_OPERATION_PROCESS: __Z_BROTLI_OPERATION_PROCESS,
  BROTLI_OPERATION_FLUSH: __Z_BROTLI_OPERATION_FLUSH,
  BROTLI_OPERATION_FINISH: __Z_BROTLI_OPERATION_FINISH,
  BROTLI_OPERATION_EMIT_METADATA: __Z_BROTLI_OPERATION_EMIT_METADATA,

  // Brotli encoder parameters and their bounds.
  BROTLI_PARAM_MODE: 0,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_DEFAULT_MODE: 0,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
  BROTLI_PARAM_SIZE_HINT: 5,
  BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7,
  BROTLI_PARAM_NDIRECT: 8,

  // Brotli decoder results, parameters and error codes.
  BROTLI_DECODER_RESULT_ERROR: 0,
  BROTLI_DECODER_RESULT_SUCCESS: 1,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
  BROTLI_DECODER_NO_ERROR: 0,
  BROTLI_DECODER_SUCCESS: 1,
  BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
  BROTLI_DECODER_ERROR_UNREACHABLE: -31,

  // zstd. The numbers are part of `zlib.constants` in Node 25; the streams
  // they configure are not implemented here (see the header).
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_windowLog: 101,
  ZSTD_c_hashLog: 102,
  ZSTD_c_chainLog: 103,
  ZSTD_c_searchLog: 104,
  ZSTD_c_minMatch: 105,
  ZSTD_c_targetLength: 106,
  ZSTD_c_strategy: 107,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_ldmHashLog: 161,
  ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_nbWorkers: 400,
  ZSTD_c_jobSize: 401,
  ZSTD_c_overlapLog: 402,
  ZSTD_d_windowLogMax: 100,
  ZSTD_error_no_error: 0,
  ZSTD_error_GENERIC: 1,
  ZSTD_CLEVEL_DEFAULT: 3,
});

// `codes`: zlib's return codes, plus the reverse mapping Node adds, frozen.
function __zBuildCodes(): any {
  const codes: any = {
    Z_OK: 0,
    Z_STREAM_END: 1,
    Z_NEED_DICT: 2,
    Z_ERRNO: -1,
    Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3,
    Z_MEM_ERROR: -4,
    Z_BUF_ERROR: -5,
    Z_VERSION_ERROR: -6,
  };
  // The key list is snapshotted first: the loop adds keys as it goes.
  for (const key of Object.keys(codes)) codes[codes[key]] = key;
  return Object.freeze(codes);
}

const __zCodes: any = __zBuildCodes();

// ---------------------------------------------------------------------------
// Flush bounds and "flushiness"
// ---------------------------------------------------------------------------

// `FLUSH_BOUND`: the legal `options.flush` / `options.finishFlush` range, which
// differs between the zlib family and Brotli.
const __Z_FLUSH_BOUND_ZLIB: number[] = [__Z_NO_FLUSH, __Z_BLOCK];
const __Z_FLUSH_BOUND_BROTLI: number[] = [
  __Z_BROTLI_OPERATION_PROCESS,
  __Z_BROTLI_OPERATION_EMIT_METADATA,
];

// `flushiness`: a sparse table ordering the flush flags by strength, so that
// `maxFlush` can pick the stronger of a scheduled flush and the finish flush.
// Roughly `Z_NO_FLUSH < Z_BLOCK < Z_PARTIAL_FLUSH < Z_SYNC_FLUSH <
// Z_FULL_FLUSH < Z_FINISH`. The same table serves Brotli, whose operation
// values (0…3) land in it in the right order.
function __zFlushiness(flag: number): number {
  if (flag === __Z_NO_FLUSH) return 0;
  if (flag === __Z_BLOCK) return 1;
  if (flag === __Z_PARTIAL_FLUSH) return 2;
  if (flag === __Z_SYNC_FLUSH) return 3;
  if (flag === __Z_FULL_FLUSH) return 4;
  if (flag === __Z_FINISH) return 5;
  return 0;
}

function __zMaxFlush(a: number, b: number): number {
  return __zFlushiness(a) > __zFlushiness(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Option handling
// ---------------------------------------------------------------------------

// The settings `ZlibBase` needs, validated in Node's order. Computed by the
// subclass as an argument to `super(...)`, because a TypeScript constructor
// cannot run anything before its `super` call and Node validates these in
// `ZlibBase` rather than in the subclass.
function __zBaseSettings(opts: any, defaults: any, bound: number[]): any {
  let chunkSize: number = __Z_DEFAULT_CHUNK;
  let maxOutputLength: number = __Z_MAX_LENGTH;
  let flush: number = Number(defaults.flush);
  let finishFlush: number = Number(defaults.finishFlush);
  let options: any = opts;

  if (opts !== undefined && opts !== null) {
    if (!__zIsFiniteNumber(opts.chunkSize, "options.chunkSize")) {
      chunkSize = __Z_DEFAULT_CHUNK;
    } else if (Number(opts.chunkSize) < __Z_MIN_CHUNK) {
      throw new ERR_OUT_OF_RANGE(
        "options.chunkSize",
        ">= " + String(__Z_MIN_CHUNK),
        opts.chunkSize,
      );
    } else {
      chunkSize = Number(opts.chunkSize);
    }

    flush = Number(__zRange(opts.flush, "options.flush", bound[0], bound[1], flush));
    finishFlush = Number(
      __zRange(opts.finishFlush, "options.finishFlush", bound[0], bound[1], finishFlush),
    );
    maxOutputLength = Number(
      __zRange(opts.maxOutputLength, "options.maxOutputLength", 1, __Z_MAX_LENGTH, __Z_MAX_LENGTH),
    );

    // A zlib stream is always a byte stream: Node strips the three options
    // that would make it anything else, on a copy, so the caller's object is
    // left alone. `test-zlib-object-write.js` asserts that a
    // `{ objectMode: true }` Gunzip still rejects `write({})`.
    if (opts.encoding || opts.objectMode === true || opts.writableObjectMode === true) {
      options = {};
      for (const key of Object.keys(opts)) options[key] = opts[key];
      options.encoding = null;
      options.objectMode = false;
      options.writableObjectMode = false;
    }
  }

  // Node's `{ autoDestroy: true, ...opts }`: the default is on, and a caller
  // that asked for `autoDestroy: false` still wins, which is why the copy
  // comes *after* the default rather than the other way round.
  const transformOptions: any = { autoDestroy: true };
  if (options !== undefined && options !== null) {
    for (const key of Object.keys(options)) transformOptions[key] = options[key];
  }

  return {
    options: transformOptions,
    chunkSize: chunkSize,
    flush: flush,
    finishFlush: finishFlush,
    fullFlush: Number(defaults.fullFlush),
    maxOutputLength: maxOutputLength,
    info: opts === undefined || opts === null ? undefined : opts.info,
    rejectGarbageAfterEnd:
      opts !== undefined && opts !== null && opts.rejectGarbageAfterEnd === true,
  };
}

const __Z_ZLIB_DEFAULTS: any = {
  flush: __Z_NO_FLUSH,
  finishFlush: __Z_FINISH,
  fullFlush: __Z_FULL_FLUSH,
};

const __Z_BROTLI_DEFAULTS: any = {
  flush: __Z_BROTLI_OPERATION_PROCESS,
  finishFlush: __Z_BROTLI_OPERATION_FINISH,
  fullFlush: __Z_BROTLI_OPERATION_FLUSH,
};

// `Zlib`'s own option validation plus `handle.init(...)`: `windowBits`,
// `level`, `memLevel`, `strategy` and `dictionary`, in Node's order.
//
// `windowBits` is special. On the compression side 0 is invalid; on the
// decompression side it tells zlib to take the window size from the stream's
// own header. And `{ windowBits: 8 }` is valid for deflate but not for gzip,
// whose header needs one more bit.
function __zZlibInit(opts: any, mode: number): any {
  let windowBits: number = __Z_DEFAULT_WINDOWBITS;
  let level: number = __Z_DEFAULT_COMPRESSION;
  let memLevel: number = __Z_DEFAULT_MEMLEVEL;
  let strategy: number = __Z_DEFAULT_STRATEGY;
  let dictionary: string = "";

  if (opts !== undefined && opts !== null) {
    const given: any = opts.windowBits;
    const auto: boolean =
      (given === undefined || given === null || given === 0) &&
      (mode === __Z_MODE_INFLATE || mode === __Z_MODE_GUNZIP || mode === __Z_MODE_UNZIP);
    if (auto) {
      windowBits = 0;
    } else {
      const min: number = __Z_MIN_WINDOWBITS + (mode === __Z_MODE_GZIP ? 1 : 0);
      windowBits = Number(
        __zRange(given, "options.windowBits", min, __Z_MAX_WINDOWBITS, __Z_DEFAULT_WINDOWBITS),
      );
    }

    level = Number(
      __zRange(opts.level, "options.level", __Z_MIN_LEVEL, __Z_MAX_LEVEL, __Z_DEFAULT_COMPRESSION),
    );
    memLevel = Number(
      __zRange(
        opts.memLevel,
        "options.memLevel",
        __Z_MIN_MEMLEVEL,
        __Z_MAX_MEMLEVEL,
        __Z_DEFAULT_MEMLEVEL,
      ),
    );
    strategy = Number(
      __zRange(
        opts.strategy,
        "options.strategy",
        __Z_DEFAULT_STRATEGY,
        __Z_FIXED,
        __Z_DEFAULT_STRATEGY,
      ),
    );

    const given_dictionary: any = opts.dictionary;
    if (given_dictionary !== undefined) {
      if (!__zIsByteView(given_dictionary)) {
        throw new ERR_INVALID_ARG_TYPE(
          "options.dictionary",
          ["Buffer", "TypedArray", "DataView", "ArrayBuffer"],
          given_dictionary,
        );
      }
      dictionary = __zAsBuffer(given_dictionary).toString("base64");
    }
  }

  const handle: number = Number(
    __zPayload(
      __zNative.zlibInit(mode, windowBits, level, memLevel, strategy, dictionary),
    ),
  );
  return { handle: handle, level: level, strategy: strategy };
}

// `Brotli`'s own validation plus `handle.init(...)`.
//
// Node builds a dense `Uint32Array` of `BROTLI_PARAM_*` values pre-filled with
// `-1` and rejects a key that is out of range *or already set* — which is how
// `{ '0': 0, '00': 0 }` is caught, since both spell key 0. The same two rules
// are applied here over a sparse list, because the dense array would have to
// cross the ABI as one anyway.
function __zBrotliInit(opts: any, mode: number): any {
  const seen: any = {};
  const fields: string[] = [];
  const params: any = opts === undefined || opts === null ? undefined : opts.params;
  if (params !== undefined && params !== null) {
    for (const original of Object.keys(params)) {
      const key: number = Number(original);
      if (
        Number.isNaN(key) ||
        key < 0 ||
        key > __Z_MAX_BROTLI_PARAM ||
        seen[String(key)] === true
      ) {
        throw new ERR_BROTLI_INVALID_PARAM(original);
      }
      const value: any = params[original];
      if (typeof value !== "number" && typeof value !== "boolean") {
        throw new ERR_INVALID_ARG_TYPE("options.params[key]", "number", value);
      }
      seen[String(key)] = true;
      fields.push(String(key) + ":" + String(value === true ? 1 : value === false ? 0 : value));
    }
  }
  const encoded: string = fields.join(__Z_US);
  const handle: number = Number(
    __zPayload(__zNative.zlibBrotliInit(mode === __Z_MODE_BROTLI_ENCODE ? 1 : 0, encoded)),
  );
  return { handle: handle, level: __Z_DEFAULT_COMPRESSION, strategy: __Z_DEFAULT_STRATEGY };
}

// ---------------------------------------------------------------------------
// The chunking loop (`lib/zlib.js`' processChunk / processChunkSync)
// ---------------------------------------------------------------------------

// Close the native handle, idempotently. Node's `_close(engine)`.
function __zCloseHandle(engine: any): void {
  const handle: any = engine._handle;
  if (handle === null || handle === undefined) return;
  engine._handle = null;
  __zNative.zlibClose(Number(handle));
}

// One native step. Answers `[output, availInAfter]`, or throws the stashed
// error. `first` writes a fresh chunk; a continuation re-enters the retained
// input at the offset the previous step stopped at (see `src/zlib/mod.rs`).
function __zStep(handle: number, flushFlag: number, base64: string, outLen: number, first: boolean): any[] {
  const raw: any = first
    ? __zNative.zlibWrite(handle, flushFlag, base64, outLen)
    : __zNative.zlibWriteMore(handle, flushFlag, outLen);
  const fields: string[] = __zPayload(raw).split(__Z_US);
  // The element goes through a declared local: an array index reads back as
  // `Any` here, and `Buffer.from` of an `Any` does not compile (zun#58).
  const encoded: string = fields[0];
  const available: string = fields[1];
  return [Buffer.from(encoded, "base64"), Number(available)];
}

// The asynchronous path. The natives are synchronous — the engine has no
// threadpool to hand a compression job to — so the whole chunk is processed in
// one pass and the write callback is invoked at the end, which is exactly what
// Node's own `writeSync` path does. The *accounting* is Node's
// `processCallback` instruction for instruction, including `_outOffset`, so the
// chunk boundaries a `'data'` listener sees are the ones Node produces.
function __zProcessChunk(self: any, chunk: any, encoding: any, flushFlag: number, cb: any): void {
  const handle: any = self._handle;
  if (handle === null || handle === undefined) {
    __zTick(cb);
    return;
  }
  const base64: string = __zToBase64(chunk, encoding);
  let availInBefore: number = __zByteLen(chunk, encoding);
  let availOutBefore: number = Number(self._chunkSize) - Number(self._outOffset);
  let first: boolean = true;

  for (;;) {
    let produced: any[];
    try {
      produced = __zStep(Number(handle), flushFlag, base64, availOutBefore, first);
    } catch (error: any) {
      // Node's `zlibOnError` destroys the stream; reporting the error to the
      // write callback takes the same route (`afterTransform` ->
      // `errorOrDestroy`) and emits 'error' exactly once. The handle is closed
      // first so that `_closed` is already true inside the handler, which
      // `test-zlib-close-after-error.js` asserts.
      __zCloseHandle(self);
      __zInvoke(cb, [error]);
      return;
    }
    first = false;
    const out: Buffer = produced[0];
    const availInAfter: number = Number(produced[1]);
    const have: number = Number(out.length);
    const availOutAfter: number = availOutBefore - have;

    self.bytesWritten = Number(self.bytesWritten) + (availInBefore - availInAfter);

    if (have > 0) {
      self._outOffset = Number(self._outOffset) + have;
      self.push(out);
    }

    if (self.destroyed === true) {
      __zInvoke(cb, []);
      return;
    }

    if (availOutAfter === 0 || Number(self._outOffset) >= Number(self._chunkSize)) {
      availOutBefore = Number(self._chunkSize);
      self._outOffset = 0;
    }

    if (availOutAfter === 0) {
      // Not actually done; reprocess what is left of the input.
      availInBefore = availInAfter;
      continue;
    }

    if (availInAfter > 0) {
      // Output space was available but the engine stopped taking input, so the
      // compressed stream ended early and the rest is trailing data.
      if (self._rejectGarbageAfterEnd === true) {
        const junk: any = new ERR_TRAILING_JUNK_AFTER_STREAM_END();
        self.destroy(junk);
        __zInvoke(cb, [junk]);
        return;
      }
      self.push(null);
    }

    __zInvoke(cb, []);
    return;
  }
}

// The synchronous path. Collects the output, enforces `maxOutputLength`, closes
// the handle and answers one `Buffer`.
function __zProcessChunkSync(self: any, chunk: any, encoding: any, flushFlag: number): Buffer {
  const handle: any = self._handle;
  if (handle === null || handle === undefined) return Buffer.alloc(0);
  const base64: string = __zToBase64(chunk, encoding);
  let availInBefore: number = __zByteLen(chunk, encoding);
  let availOutBefore: number = Number(self._chunkSize) - Number(self._outOffset);
  let first: boolean = true;
  const buffers: Buffer[] = [];
  let nread: number = 0;
  let inputRead: number = 0;

  for (;;) {
    let produced: any[];
    try {
      produced = __zStep(Number(handle), flushFlag, base64, availOutBefore, first);
    } catch (error: any) {
      __zCloseHandle(self);
      throw error;
    }
    first = false;
    const out: Buffer = produced[0];
    const availInAfter: number = Number(produced[1]);
    const have: number = Number(out.length);
    const availOutAfter: number = availOutBefore - have;

    inputRead = inputRead + (availInBefore - availInAfter);

    if (have > 0) {
      buffers.push(out);
      nread = nread + have;
      self._outOffset = Number(self._outOffset) + have;
      if (nread > Number(self._maxOutputLength)) {
        __zCloseHandle(self);
        throw new ERR_BUFFER_TOO_LARGE(self._maxOutputLength);
      }
    }

    if (availOutAfter === 0 || Number(self._outOffset) >= Number(self._chunkSize)) {
      availOutBefore = Number(self._chunkSize);
      self._outOffset = 0;
    }

    if (availOutAfter === 0) {
      availInBefore = availInAfter;
      continue;
    }
    break;
  }

  self.bytesWritten = inputRead;
  __zCloseHandle(self);

  if (nread === 0) return Buffer.alloc(0);
  if (Number(buffers.length) === 1) return buffers[0];
  return Buffer.concat(buffers);
}

// ---------------------------------------------------------------------------
// The stream hooks
// ---------------------------------------------------------------------------

// `ZlibBase.prototype._transform`.
function __zTransformHook(self: any, chunk: any, encoding: any, cb: any): void {
  let flushFlag: number = Number(self._defaultFlushFlag);
  const length: number = __zByteLen(chunk, encoding);

  // Node carries a scheduled flush on the zero-length buffer `flush()` writes,
  // through a symbol-keyed property. A byte view here has no fields at all, so
  // the flag waits in a FIFO beside the stream and is claimed by the next
  // zero-length chunk — which, writes being ordered, is that same buffer.
  const queue: any[] = self._zs.flushQueue;
  if (length === 0 && Number(queue.length) > 0) flushFlag = Number(queue.shift());

  // For the last chunk, the finish flush applies as well.
  if (self.writableEnded === true && Number(self.writableLength) === length) {
    flushFlag = __zMaxFlush(flushFlag, Number(self._finishFlushFlag));
  }
  __zProcessChunk(self, chunk, encoding, flushFlag, cb);
}

// `ZlibBase.prototype._flush`: the end of the writable side is one more
// transform of nothing, which is what emits the stream trailer.
function __zFlushHook(self: any, cb: any): void {
  __zProcessChunk(self, Buffer.alloc(0), "", Number(self._finishFlushFlag), cb);
}

// `ZlibBase.prototype._destroy`.
function __zDestroyHook(self: any, err: any, cb: any): void {
  __zCloseHandle(self);
  __zInvoke(cb, [err]);
}

// `paramsAfterFlushCallback`: the native `params()` call must not run while a
// write is in flight, so `params()` schedules it behind a full flush.
//
// The `writableEnded` guard has no counterpart in Node, and it stands in for
// Node's threadpool. There, a chunk written after `params()` is still queued
// when the flush callback fires, so `deflateParams` runs while the stream is
// merely flushed; here the natives are synchronous, so a `write()`/`end()`
// issued between `params()` and its callback has *already* been compressed —
// and `deflateParams` on a stream that has seen its `Z_FINISH` is a
// `Z_STREAM_ERROR`. Recording the new level without calling the engine is the
// same observable outcome Node has in that ordering: nothing more will be
// compressed, so the parameters cannot reach any output either way.
function __zParamsAfterFlush(self: any, level: number, strategy: number, callback: any): void {
  const handle: any = self._handle;
  if (handle === null || handle === undefined) {
    __zInvoke(callback, [new ERR_ZLIB_BINDING_CLOSED()]);
    return;
  }
  if (self.writableEnded === true) {
    self._level = level;
    self._strategy = strategy;
    __zInvoke(callback, []);
    return;
  }
  let payload: string;
  try {
    payload = __zPayload(__zNative.zlibParams(Number(handle), level, strategy, Number(self._chunkSize)));
  } catch (error: any) {
    self.destroy(error);
    return;
  }
  // `deflateParams` may close the block the previous level produced; those
  // bytes belong to the stream, so they are pushed rather than dropped. In
  // every case the corpus reaches there are none.
  const tail: Buffer = Buffer.from(payload, "base64");
  if (Number(tail.length) > 0) self.push(tail);
  if (self.destroyed !== true) {
    self._level = level;
    self._strategy = strategy;
    __zInvoke(callback, []);
  }
}

// `assert(this._handle, 'zlib binding closed')` — Node's assertion for a
// `reset()`/`params()` on a closed stream.
class ERR_ZLIB_BINDING_CLOSED extends NodeError {
  constructor() {
    super("ERR_ASSERTION", "zlib binding closed");
  }
}

// ---------------------------------------------------------------------------
// ZlibBase
// ---------------------------------------------------------------------------

class ZlibBase extends Transform {
  // Every field is declared: an undeclared write on a class instance is a
  // compile error here, and these are all read by Node's own tests
  // (`_handle`, `_closed`, `bytesWritten`, `_level`, `_strategy`).
  //
  // Every one of them is `any`, including the numbers, and that is not
  // laziness. With this set declared `number` / `boolean`, the interpreter
  // panics outright — `expected float, found Any(Any { tag: Float, payload:
  // <the bits of 16384> })` at `crates/zun_interp/src/value.rs:157`, 16384
  // being `_chunkSize` — on a path that reads them back through an `any`
  // receiver, which is the only kind they ever have: the free functions below
  // take the stream as `any` (a class method is unreachable as a value,
  // zun#19) and Node's own tests reach `stream.bytesWritten` through an `any`
  // binding too. A new engine bug, reported with this work; it could not be
  // reduced below this module, and declaring the whole set `any` removes it.
  // The values are still numbers, and every read site funnels them through
  // `Number(...)` anyway (zun#3).
  _handle: any = null;
  _chunkSize: any = __Z_DEFAULT_CHUNK;
  _outOffset: any = 0;
  bytesWritten: any = 0;
  _defaultFlushFlag: any = __Z_NO_FLUSH;
  _finishFlushFlag: any = __Z_FINISH;
  _defaultFullFlushFlag: any = __Z_FULL_FLUSH;
  _info: any = undefined;
  _maxOutputLength: any = __Z_MAX_LENGTH;
  _rejectGarbageAfterEnd: any = false;
  _level: any = __Z_DEFAULT_COMPRESSION;
  _strategy: any = __Z_DEFAULT_STRATEGY;
  _mode: any = 0;
  // The per-stream side table. A plain object, not a set of class fields,
  // because a *function* assigned to a class field is unreachable afterwards
  // (see `src/stream/stream.ts`' header note 1) and this holds the convenience
  // wrapper's callback.
  _zs: any = null;

  constructor(settings: any, started: any, mode: number) {
    super(settings.options);

    this._handle = started.handle;
    this._mode = mode;
    this._level = Number(started.level);
    this._strategy = Number(started.strategy);
    this.bytesWritten = 0;
    this._outOffset = 0;
    this._chunkSize = Number(settings.chunkSize);
    this._defaultFlushFlag = Number(settings.flush);
    this._finishFlushFlag = Number(settings.finishFlush);
    this._defaultFullFlushFlag = Number(settings.fullFlush);
    this._maxOutputLength = Number(settings.maxOutputLength);
    this._info = settings.info;
    this._rejectGarbageAfterEnd = settings.rejectGarbageAfterEnd === true;
    this._zs = { flushQueue: [], buffers: null, nread: 0, cb: null };

    // A listener or hook is invoked with no receiver of its own (zun#1), so the
    // stream is captured rather than read off `this`. The hooks go into
    // `src/stream/stream.ts`' option store, which is what its `_transform` /
    // `_flush` / `_destroy` accessors write to — assigning to one of those
    // accessors through an `any` receiver panics the interpreter.
    const self: any = this;
    __sSetOptFn(self, "transform", function (chunk: any, encoding: any, cb: any): void {
      __zTransformHook(self, chunk, encoding, cb);
    });
    __sSetOptFn(self, "flush", function (cb: any): void {
      __zFlushHook(self, cb);
    });
    __sSetOptFn(self, "destroy", function (err: any, cb: any): void {
      __zDestroyHook(self, err, cb);
    });
  }

  // Node defines this as an accessor on the prototype: a stream is "closed"
  // exactly when its handle is gone.
  get _closed(): boolean {
    return this._handle === null || this._handle === undefined;
  }

  reset(): any {
    const handle: any = this._handle;
    if (handle === null || handle === undefined) throw new ERR_ZLIB_BINDING_CLOSED();
    __zPayload(__zNative.zlibReset(Number(handle)));
    return undefined;
  }

  // `flush(kind, callback)`. A flush is introduced into the write sequence as
  // a zero-length write, so it cannot overtake data already written.
  flush(kind?: any, callback?: any): void {
    let flag: any = kind;
    let cb: any = callback;
    if (__evIsFn(flag) || (flag === undefined && (cb === undefined || cb === null))) {
      cb = flag;
      flag = this._defaultFullFlushFlag;
    }
    if (this.writableFinished === true) {
      if (cb !== undefined && cb !== null) __zTick(cb);
    } else if (this.writableEnded === true) {
      if (cb !== undefined && cb !== null) this.once("end", cb);
    } else {
      this._zs.flushQueue.push(Number(flag));
      this.write(Buffer.alloc(0), "", cb);
    }
  }

  // `params(level, strategy, callback)`. Changing the level mid-stream has to
  // wait for a full flush, so the parameters are applied behind one.
  params(level?: any, strategy?: any, callback?: any): void {
    __zRange(level, "level", __Z_MIN_LEVEL, __Z_MAX_LEVEL, undefined);
    __zRange(strategy, "strategy", __Z_DEFAULT_STRATEGY, __Z_FIXED, undefined);
    const self: any = this;
    if (Number(this._level) !== Number(level) || Number(this._strategy) !== Number(strategy)) {
      this.flush(__Z_SYNC_FLUSH, function (): void {
        __zParamsAfterFlush(self, Number(level), Number(strategy), callback);
      });
    } else {
      __zTick(callback);
    }
  }

  close(callback?: any): void {
    if (callback !== undefined && callback !== null) __sEos(this, undefined, callback);
    this.destroy();
  }

  // `_processChunk` is kept for backwards compatibility, and
  // `test-zlib-sync-no-event.js` is written against it: with no callback it
  // runs the synchronous path and answers the whole output.
  _processChunk(chunk?: any, flushFlag?: any, cb?: any): any {
    if (__evIsFn(cb)) {
      __zProcessChunk(this, chunk, "", Number(flushFlag), cb);
      return undefined;
    }
    return __zProcessChunkSync(this, chunk, "", Number(flushFlag));
  }
}

// ---------------------------------------------------------------------------
// Zlib, Brotli and the nine concrete streams
// ---------------------------------------------------------------------------
//
// The option validation and the native `init` run as argument expressions of
// the `super(...)` call, because nothing may precede `super` in a TypeScript
// constructor and Node does both before `ZlibBase` touches the instance.
// `__zBaseSettings` is evaluated first so that a bad `chunkSize` or `flush` is
// reported before a handle is allocated — the one place the order differs from
// Node's, and no two options the corpus combines can tell the difference.

class Zlib extends ZlibBase {
  constructor(opts: any, mode: number) {
    super(
      __zBaseSettings(opts, __Z_ZLIB_DEFAULTS, __Z_FLUSH_BOUND_ZLIB),
      __zZlibInit(opts, mode),
      mode,
    );
  }
}

class Brotli extends ZlibBase {
  constructor(opts: any, mode: number) {
    super(
      __zBaseSettings(opts, __Z_BROTLI_DEFAULTS, __Z_FLUSH_BOUND_BROTLI),
      __zBrotliInit(opts, mode),
      mode,
    );
  }
}

class Deflate extends Zlib {
  constructor(opts?: any) {
    super(opts, __Z_MODE_DEFLATE);
  }
}

class Inflate extends Zlib {
  constructor(opts?: any) {
    super(opts, __Z_MODE_INFLATE);
  }
}

class Gzip extends Zlib {
  constructor(opts?: any) {
    super(opts, __Z_MODE_GZIP);
  }
}

class Gunzip extends Zlib {
  constructor(opts?: any) {
    super(opts, __Z_MODE_GUNZIP);
  }
}

class DeflateRaw extends Zlib {
  constructor(opts?: any) {
    // zlib silently upgrades an 8-bit window to 9 on the raw deflate side, and
    // Node does the upgrade itself so that the stream's own `windowBits` says
    // what zlib will actually use. The caller's object is mutated, as in Node.
    super(__zRawWindowBits(opts), __Z_MODE_DEFLATERAW);
  }
}

class InflateRaw extends Zlib {
  constructor(opts?: any) {
    super(opts, __Z_MODE_INFLATERAW);
  }
}

class Unzip extends Zlib {
  constructor(opts?: any) {
    super(opts, __Z_MODE_UNZIP);
  }
}

class BrotliCompress extends Brotli {
  constructor(opts?: any) {
    super(opts, __Z_MODE_BROTLI_ENCODE);
  }
}

class BrotliDecompress extends Brotli {
  constructor(opts?: any) {
    super(opts, __Z_MODE_BROTLI_DECODE);
  }
}

// `DeflateRaw`'s `windowBits: 8` fixup, as a free function so it can run as an
// argument expression of `super(...)`.
function __zRawWindowBits(opts: any): any {
  if (opts !== undefined && opts !== null && opts.windowBits === 8) opts.windowBits = 9;
  return opts;
}

// ---------------------------------------------------------------------------
// The convenience methods (`zlibBuffer` / `zlibBufferSync`)
// ---------------------------------------------------------------------------

function __zBufferSync(engine: any, buffer: any): any {
  if (typeof buffer !== "string" && !__zIsByteView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE(
      "buffer",
      ["string", "Buffer", "TypedArray", "DataView", "ArrayBuffer"],
      buffer,
    );
  }
  const out: Buffer = __zProcessChunkSync(engine, buffer, "utf8", Number(engine._finishFlushFlag));
  if (engine._info) return { buffer: out, engine: engine };
  return out;
}

function __zBufferOnData(engine: any, chunk: any): void {
  const state: any = engine._zs;
  const piece: Buffer = __zAsBuffer(chunk);
  if (state.buffers === null || state.buffers === undefined) {
    state.buffers = [piece];
  } else {
    state.buffers.push(piece);
  }
  state.nread = Number(state.nread) + Number(piece.length);
  if (Number(state.nread) > Number(engine._maxOutputLength)) {
    engine.close();
    engine.removeAllListeners("end");
    __zInvoke(state.cb, [new ERR_BUFFER_TOO_LARGE(engine._maxOutputLength)]);
  }
}

function __zBufferOnError(engine: any, err: any): void {
  const state: any = engine._zs;
  engine.removeAllListeners("end");
  __zInvoke(state.cb, [err]);
}

function __zBufferOnEnd(engine: any): void {
  const state: any = engine._zs;
  let out: Buffer;
  if (Number(state.nread) === 0) {
    out = Buffer.alloc(0);
  } else {
    const list: any[] = state.buffers;
    out = Number(list.length) === 1 ? list[0] : Buffer.concat(list);
  }
  engine.close();
  if (engine._info) {
    __zInvoke(state.cb, [null, { buffer: out, engine: engine }]);
  } else {
    __zInvoke(state.cb, [null, out]);
  }
}

function __zBuffer(engine: any, buffer: any, callback: any): void {
  __zValidateFunction(callback, "callback");
  const state: any = engine._zs;
  state.buffers = null;
  state.nread = 0;
  state.cb = callback;
  engine.on("data", function (chunk: any): void {
    __zBufferOnData(engine, chunk);
  });
  engine.on("error", function (err: any): void {
    __zBufferOnError(engine, err);
  });
  engine.on("end", function (): void {
    __zBufferOnEnd(engine);
  });
  engine.end(buffer);
}

// The `(buffer, opts, callback)` signature every asynchronous convenience
// method has, with the two-argument form folded in.
function __zAsync(engine: any, buffer: any, opts: any, callback: any): void {
  __zBuffer(engine, buffer, __evIsFn(opts) ? opts : callback);
}

// `opts` for the asynchronous form, which is `{}` when the second argument is
// the callback.
function __zOpts(opts: any): any {
  return __evIsFn(opts) ? {} : opts;
}

// ---------------------------------------------------------------------------
// crc32
// ---------------------------------------------------------------------------

function __zCrc32(data: any, value?: any): number {
  if (typeof data !== "string" && !__zIsByteView(data)) {
    throw new ERR_INVALID_ARG_TYPE(
      "data",
      ["Buffer", "TypedArray", "DataView", "string"],
      data,
    );
  }
  const seed: any = value === undefined ? 0 : value;
  __zValidateUint32(seed, "value");
  return Number(__zNative.zlibCrc32(__zToBase64(data, "utf8"), Number(seed)));
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------

const __node_zlib: any = {
  crc32(data: any, value?: any): number {
    return __zCrc32(data, value);
  },

  Deflate: Deflate,
  Inflate: Inflate,
  Gzip: Gzip,
  Gunzip: Gunzip,
  DeflateRaw: DeflateRaw,
  InflateRaw: InflateRaw,
  Unzip: Unzip,
  BrotliCompress: BrotliCompress,
  BrotliDecompress: BrotliDecompress,

  createDeflate(options?: any): any {
    return new Deflate(options);
  },
  createInflate(options?: any): any {
    return new Inflate(options);
  },
  createDeflateRaw(options?: any): any {
    return new DeflateRaw(options);
  },
  createInflateRaw(options?: any): any {
    return new InflateRaw(options);
  },
  createGzip(options?: any): any {
    return new Gzip(options);
  },
  createGunzip(options?: any): any {
    return new Gunzip(options);
  },
  createUnzip(options?: any): any {
    return new Unzip(options);
  },
  createBrotliCompress(options?: any): any {
    return new BrotliCompress(options);
  },
  createBrotliDecompress(options?: any): any {
    return new BrotliDecompress(options);
  },

  // The synchronous convenience methods.
  deflateSync(buffer: any, opts?: any): any {
    return __zBufferSync(new Deflate(opts), buffer);
  },
  inflateSync(buffer: any, opts?: any): any {
    return __zBufferSync(new Inflate(opts), buffer);
  },
  deflateRawSync(buffer: any, opts?: any): any {
    return __zBufferSync(new DeflateRaw(opts), buffer);
  },
  inflateRawSync(buffer: any, opts?: any): any {
    return __zBufferSync(new InflateRaw(opts), buffer);
  },
  gzipSync(buffer: any, opts?: any): any {
    return __zBufferSync(new Gzip(opts), buffer);
  },
  gunzipSync(buffer: any, opts?: any): any {
    return __zBufferSync(new Gunzip(opts), buffer);
  },
  unzipSync(buffer: any, opts?: any): any {
    return __zBufferSync(new Unzip(opts), buffer);
  },
  brotliCompressSync(buffer: any, opts?: any): any {
    return __zBufferSync(new BrotliCompress(opts), buffer);
  },
  brotliDecompressSync(buffer: any, opts?: any): any {
    return __zBufferSync(new BrotliDecompress(opts), buffer);
  },

  // The callback convenience methods.
  deflate(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new Deflate(__zOpts(opts)), buffer, opts, callback);
  },
  inflate(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new Inflate(__zOpts(opts)), buffer, opts, callback);
  },
  deflateRaw(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new DeflateRaw(__zOpts(opts)), buffer, opts, callback);
  },
  inflateRaw(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new InflateRaw(__zOpts(opts)), buffer, opts, callback);
  },
  gzip(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new Gzip(__zOpts(opts)), buffer, opts, callback);
  },
  gunzip(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new Gunzip(__zOpts(opts)), buffer, opts, callback);
  },
  unzip(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new Unzip(__zOpts(opts)), buffer, opts, callback);
  },
  brotliCompress(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new BrotliCompress(__zOpts(opts)), buffer, opts, callback);
  },
  brotliDecompress(buffer: any, opts?: any, callback?: any): void {
    __zAsync(new BrotliDecompress(__zOpts(opts)), buffer, opts, callback);
  },
};

// `constants` and `codes` are not writable properties in Node, and
// `test-zlib-const.js` asserts both halves of that: the tables themselves are
// frozen, and `zlib.codes = {...}` throws.
Object.defineProperty(__node_zlib, "constants", {
  configurable: false,
  enumerable: true,
  value: __zConstants,
});
Object.defineProperty(__node_zlib, "codes", {
  enumerable: true,
  writable: false,
  value: __zCodes,
});

// The legacy top-level `Z_*` aliases. Node still exposes every non-Brotli
// constant straight off the module object, non-enumerably and read-only, and
// marks them deprecated in the documentation rather than at run time.
function __zInstallLegacyConstants(target: any, constants: any): void {
  for (const key of Object.keys(constants)) {
    if (key.indexOf("BROTLI") === 0) continue;
    Object.defineProperty(target, key, {
      enumerable: false,
      writable: false,
      value: constants[key],
    });
  }
}

__zInstallLegacyConstants(__node_zlib, __zConstants);

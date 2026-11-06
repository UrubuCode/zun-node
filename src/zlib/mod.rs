//! `node:zlib` — the compression engines behind Node's `zlib` module, as a
//! native `zun_abi` extension.
//!
//! # TS over natives
//!
//! `zlib` is a *TS-over-natives* module, the shape `node:os` established and
//! `node:fs` repeated, and the split is PLAN.md principle 2 again:
//!
//! - *This* crate answers only what needs a compression engine: one `z_stream`
//!   (or Brotli encoder/decoder) per handle, `init`/`write`/`params`/`reset`/
//!   `close`, and `crc32`. Nothing here knows what a stream, an option object
//!   or a Node error is.
//! - `src/zlib/zlib.ts` is the Node-shaped module: the nine `Transform`
//!   classes, the `create*` factories, the sync and callback convenience
//!   methods, `constants`/`codes`, the option validation and the `ERR_*`
//!   errors, `bytesWritten`, `flush`/`params`/`reset`/`close`,
//!   `maxOutputLength` and `info`.
//!
//! The TS layer reaches these functions with `import * as native from
//! "node:zlib"`.
//!
//! # The handle table
//!
//! A compression stream outlives a single call, so this module keeps one, in
//! [`TABLE`], exactly as `src/fs/fd.rs` keeps open files: the program holds a
//! small integer and every later call names it. The numbers count up from 1 and
//! are never reused, so a use-after-close is an `EBADF`-shaped failure rather
//! than a different stream's state.
//!
//! Each handle also owns the **pending input** of the chunking loop. Node's
//! `lib/zlib.js` calls the binding repeatedly with the same input buffer and a
//! moving offset whenever the output buffer fills up; re-encoding that buffer
//! for every iteration would make a large write quadratic, so `zlibWrite`
//! stores the chunk in the handle and `zlibWriteMore` continues from where the
//! previous step stopped.
//!
//! # What crosses the boundary
//!
//! ABI v1 carries one scalar word per value, so every fallible function here
//! returns **one status-prefixed, separator-delimited string**, in the grammar
//! `lib.rs` documents and `node:os`/`node:fs` already use:
//!
//! ```text
//! result  := "+" payload | "-"
//! payload := record (RS record)*
//! record  := field (US field)*
//! RS = U+001E     US = U+001F
//! ```
//!
//! A leading `-` means the call failed and the error slots describe it; a
//! leading `+` means success. Compressed and decompressed **bytes** cross as
//! base64 (`src/fs/base64.rs`), for the reason `node:fs` gives: the `Str`
//! carrier is a NUL-terminated C string, and compressed data is neither
//! NUL-free nor UTF-8. The engine's prelude `Buffer` implements that codec, so
//! neither side hand-rolls one.
//!
//! ## Failure is reported in band
//!
//! A `node:zlib` native never returns a non-zero ABI status, for the reason
//! `src/fs/mod.rs` states at length: an error raised by an extension call does
//! not reach an enclosing `try`/`catch` as itself
//! (<https://github.com/UrubuCode/zun/issues/33>), and `zlib`'s whole error
//! surface is caught — `zlib.inflateSync(garbage)` throwing a `Z_DATA_ERROR` is
//! the first thing any consumer relies on. Failure therefore travels as the
//! single-character result `"-"`, with the three fields a Node `zlib` error
//! carries (`message`, `code`, `errno`) in the per-thread error slots, read
//! back through `zlibErrorMessage`, `zlibErrorCode` and `zlibErrorErrno`.
//!
//! Those keys are `zlib`-prefixed, like every key in [`DESCRIPTORS`], because
//! the checker rejects a program whenever one *function name* is registered by
//! two modules, even behind namespace imports that already name the module
//! (<https://github.com/UrubuCode/zun/issues/35>).
//!
//! Behavior is defined by Node.js 25, whose `zlib` is a thin layer over zlib
//! and Brotli, so each native documents the `src/node_zlib.cc` entry point it
//! stands in for and follows it where the two could differ (the per-mode
//! `windowBits` rewriting, the `Z_NEED_DICT` retry, the concatenated-gzip
//! member loop, the `"unexpected end of file"` classification). The acceptance
//! bar is Node's own `test-zlib*.js` suite — see `../../test/zlib/`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use zun_abi::ZunValue;

use crate::abi::{arg_f64, arg_i64, arg_str, ret_bool, ret_f64, ret_str};
use crate::fs::base64;
use crate::Descriptor;
use zun_abi::ZunTy::{Bool, F64, I64, Str};

mod brotli;
mod zstream;

#[cfg(test)]
mod tests;

/// Unit separator: between the fields of one record.
pub(super) const US: char = '\u{1f}';
/// The in-band failure marker.
pub(super) const FAILED: &str = "-";

/// Node's `node_zlib_mode` enumeration, which its JS layer passes through
/// unchanged. Only the modes this extension implements are named.
pub(super) mod mode {
    pub(crate) const DEFLATE: i64 = 1;
    pub(crate) const INFLATE: i64 = 2;
    pub(crate) const GZIP: i64 = 3;
    pub(crate) const GUNZIP: i64 = 4;
    pub(crate) const DEFLATERAW: i64 = 5;
    pub(crate) const INFLATERAW: i64 = 6;
    pub(crate) const UNZIP: i64 = 7;
}

/// One live compression stream, and the input the chunking loop is working
/// through.
enum Engine {
    Zlib(zstream::ZlibStream),
    Brotli(brotli::BrotliStream),
}

struct Handle {
    engine: Engine,
    /// The chunk `zlibWrite` was last given, and how much of it has been
    /// consumed. See the module documentation.
    input: Vec<u8>,
    offset: usize,
}

/// The handle table, behind a wrapper that asserts it may cross threads.
///
/// `z_stream` is a C struct of raw pointers, so it is neither `Send` nor
/// `Sync` by inference, and a process-wide `static` has to be `Sync`. The
/// assertion is sound because the `Mutex` is the only way in and every pointer
/// inside is owned by its own handle: `state` is the engine's allocation,
/// `msg` is a `&'static str` of the engine's own table, and `next_in` /
/// `next_out` are set and nulled again inside a single [`step`] (see
/// `zstream.rs`), so no buffer is ever reachable from two places or outlives
/// the call that lent it.
struct Table(HashMap<i64, Handle>);

// SAFETY: see above — exclusive access through the `Mutex`, no shared
// interior, no pointer outliving the call that set it.
unsafe impl Send for Table {}

static TABLE: Mutex<Option<Table>> = Mutex::new(None);

/// The next handle number. Starts at 1 so that 0 is never a valid handle.
static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);

/// Run `action` with the handle table, creating it on first use.
fn with_table<R>(action: impl FnOnce(&mut HashMap<i64, Handle>) -> R) -> R {
    let mut guard = TABLE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&mut guard.get_or_insert_with(|| Table(HashMap::new())).0)
}

/// Publish `engine` and return its handle number.
fn insert(engine: Engine) -> i64 {
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    with_table(|table| {
        table.insert(
            handle,
            Handle {
                engine,
                input: Vec::new(),
                offset: 0,
            },
        )
    });
    handle
}

/// Stash a `(message, code, errno)` triple in the per-thread error slots and
/// answer the in-band failure marker.
fn fail(error: zstream::Error) -> String {
    let (message, code, errno) = error;
    crate::abi::fail_system("", code, errno, &message);
    FAILED.to_owned()
}

/// The failure a call naming a handle that is not in the table produces. The
/// TS layer never lets this happen (it checks `_handle` first, as Node does),
/// so this is a defence rather than a path.
fn no_such_handle() -> String {
    fail((
        "zlib binding closed".to_owned(),
        "ERR_ZLIB_BINDING_CLOSED",
        -1,
    ))
}

/// `+` with no payload: a successful call that answers nothing.
fn ok() -> String {
    "+".to_owned()
}

/// `+<payload>`.
fn ok_one(field: &str) -> String {
    let mut out = String::from("+");
    out.push_str(field);
    out
}

/// `zlibInit(mode, windowBits, level, memLevel, strategy, dictionary)` →
/// `+<handle>`. `node_zlib.cc`'s `ZlibStream::Init`.
///
/// `dictionary` is base64; empty means none.
pub(crate) unsafe extern "C" fn zlib_init(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let dictionary = match unsafe { arg_str(args, n, 5) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let m = unsafe { arg_i64(args, n, 0) };
    let window_bits = unsafe { arg_i64(args, n, 1) } as i32;
    let level = unsafe { arg_i64(args, n, 2) } as i32;
    let mem_level = unsafe { arg_i64(args, n, 3) } as i32;
    let strategy = unsafe { arg_i64(args, n, 4) } as i32;
    let payload = match zstream::ZlibStream::open(m, window_bits, level, mem_level, strategy, dictionary)
    {
        Ok(stream) => ok_one(&insert(Engine::Zlib(stream)).to_string()),
        Err(error) => fail(error),
    };
    unsafe { ret_str(out, &payload) }
}

/// `zlibBrotliInit(encode, params)` → `+<handle>`.
/// `node_zlib.cc`'s `BrotliCompressionStream::Init`.
///
/// `params` is the `(key, value)` list the JS layer kept from `options.params`,
/// as `key:value` pairs separated by US — the `-1` ("not set") entries of
/// Node's dense array are dropped there rather than carried across the ABI.
pub(crate) unsafe extern "C" fn zlib_brotli_init(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let encode = unsafe { arg_i64(args, n, 0) } != 0;
    let text = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let mut params: Vec<(i64, u32)> = Vec::new();
    for field in text.split(US) {
        if field.is_empty() {
            continue;
        }
        let Some((key, value)) = field.split_once(':') else {
            continue;
        };
        let Ok(key) = key.parse::<i64>() else { continue };
        let Ok(value) = value.parse::<i64>() else {
            continue;
        };
        if !(0..=brotli::MAX_PARAM).contains(&key) {
            continue;
        }
        params.push((key, value as u32));
    }
    let payload = match brotli::BrotliStream::open(encode, &params) {
        Ok(stream) => ok_one(&insert(Engine::Brotli(stream)).to_string()),
        Err(error) => fail(error),
    };
    unsafe { ret_str(out, &payload) }
}

/// One step of the chunking loop, shared by [`zlib_write`] and
/// [`zlib_write_more`].
///
/// Answers `+<outputBase64>US<availIn>`: the bytes produced by this step, and
/// how much of the pending input is still unconsumed. The caller derives
/// Node's `availOutAfter` from `out_len` and the length of the output, and its
/// `availInAfter` from the second field — which is all `processChunk` needs.
fn step(handle: i64, flush: i32, out_len: usize) -> String {
    let result = with_table(|table| {
        let Some(slot) = table.get_mut(&handle) else {
            return None;
        };
        let mut out = vec![0u8; out_len];
        let pending = &slot.input[slot.offset.min(slot.input.len())..];
        let (produced, consumed, error) = match &mut slot.engine {
            Engine::Zlib(stream) => {
                let (produced, consumed) = stream.step(flush, pending, &mut out);
                let error = stream.error(out_len - produced);
                (produced, consumed, error)
            }
            Engine::Brotli(stream) => {
                let (produced, consumed) = stream.step(flush, pending, &mut out);
                (produced, consumed, stream.error())
            }
        };
        slot.offset += consumed;
        let available_in = slot.input.len() - slot.offset;
        out.truncate(produced);
        Some((out, available_in, error))
    });
    let Some((out, available_in, error)) = result else {
        return no_such_handle();
    };
    if let Some(error) = error {
        return fail(error);
    }
    let mut payload = String::from("+");
    payload.push_str(&base64::encode(&out));
    payload.push(US);
    payload.push_str(&available_in.to_string());
    payload
}

/// `zlibWrite(handle, flush, chunk, outLen)` → `+<outBase64>US<availIn>`.
/// `node_zlib.cc`'s `CompressionStream::Write`, with a fresh input chunk.
pub(crate) unsafe extern "C" fn zlib_write(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let flush = unsafe { arg_i64(args, n, 1) } as i32;
    let chunk = match unsafe { arg_str(args, n, 2) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let out_len = unsafe { arg_i64(args, n, 3) }.max(0) as usize;
    let present = with_table(|table| match table.get_mut(&handle) {
        Some(slot) => {
            slot.input = chunk;
            slot.offset = 0;
            true
        }
        None => false,
    });
    let payload = if present {
        step(handle, flush, out_len)
    } else {
        no_such_handle()
    };
    unsafe { ret_str(out, &payload) }
}

/// `zlibWriteMore(handle, flush, outLen)` → the same, continuing the input the
/// previous [`zlib_write`] left unconsumed. This is the `availOutAfter === 0`
/// arm of Node's `processChunk` loop, which re-enters the binding with the
/// *same* buffer at a moved offset.
pub(crate) unsafe extern "C" fn zlib_write_more(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let flush = unsafe { arg_i64(args, n, 1) } as i32;
    let out_len = unsafe { arg_i64(args, n, 2) }.max(0) as usize;
    let payload = step(handle, flush, out_len);
    unsafe { ret_str(out, &payload) }
}

/// `zlibParams(handle, level, strategy, outLen)` → `+<outBase64>`.
/// `deflateParams`; a no-op for the inflating and Brotli modes, as in Node.
///
/// The payload exists because `deflateParams` may emit the tail of the block
/// the previous level produced — see [`zstream::ZlibStream::params`]. It is
/// empty in every case the corpus reaches, and the TS layer pushes it like any
/// other output rather than assuming so.
pub(crate) unsafe extern "C" fn zlib_params(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let level = unsafe { arg_i64(args, n, 1) } as i32;
    let strategy = unsafe { arg_i64(args, n, 2) } as i32;
    let out_len = unsafe { arg_i64(args, n, 3) }.max(0) as usize;
    let result = with_table(|table| match table.get_mut(&handle) {
        Some(slot) => {
            let mut scratch = vec![0u8; out_len];
            Some(match &mut slot.engine {
                Engine::Zlib(stream) => {
                    let (produced, error) = stream.params(level, strategy, &mut scratch);
                    scratch.truncate(produced);
                    (scratch, error)
                }
                Engine::Brotli(_) => (Vec::new(), None),
            })
        }
        None => None,
    });
    let payload = match result {
        Some((bytes, None)) => ok_one(&base64::encode(&bytes)),
        Some((_, Some(error))) => fail(error),
        None => no_such_handle(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `zlibReset(handle)` → `+`. `ZlibContext::ResetStream`.
pub(crate) unsafe extern "C" fn zlib_reset(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let result = with_table(|table| match table.get_mut(&handle) {
        Some(slot) => {
            slot.input = Vec::new();
            slot.offset = 0;
            Some(match &mut slot.engine {
                Engine::Zlib(stream) => stream.reset(),
                Engine::Brotli(stream) => stream.reset(),
            })
        }
        None => None,
    });
    let payload = match result {
        Some(None) => ok(),
        Some(Some(error)) => fail(error),
        None => no_such_handle(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `zlibClose(handle)` → whether a handle was removed. `deflateEnd`/
/// `inflateEnd` happen in the engine's `Drop`.
///
/// Closing twice is not an error: Node's `_close()` is idempotent (it nulls
/// `_handle` and the second call sees nothing to do), and so is this.
pub(crate) unsafe extern "C" fn zlib_close(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let removed = with_table(|table| table.remove(&handle).is_some());
    unsafe { ret_bool(out, removed) }
}

/// `zlibCrc32(data, value)` → the CRC-32 of `data` seeded with `value`.
/// `zlib.crc32`, which Node exposes straight from the binding.
///
/// `data` is base64 and the result is an `F64`, because a CRC is a full `u32`
/// and the TS layer wants it as a JavaScript number without a sign fixup.
pub(crate) unsafe extern "C" fn zlib_crc32(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let data = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let seed = unsafe { arg_f64(args, n, 1) };
    let seed = if seed.is_finite() && seed >= 0.0 && seed <= u32::MAX as f64 {
        seed as u32
    } else {
        0
    };
    unsafe { ret_f64(out, f64::from(zstream::crc32(seed, &data))) }
}

/// The `node:zlib` functions published to the host. Keys are the names
/// `src/zlib/zlib.ts` calls through its `node:zlib` namespace import, each
/// `zlib`-prefixed so no other module in this library registers the same name
/// (<https://github.com/UrubuCode/zun/issues/35>).
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor {
        key: b"zlibInit\0",
        params: &[I64, I64, I64, I64, I64, Str],
        ret: Str,
        invoke: zlib_init,
    },
    Descriptor {
        key: b"zlibBrotliInit\0",
        params: &[I64, Str],
        ret: Str,
        invoke: zlib_brotli_init,
    },
    Descriptor {
        key: b"zlibWrite\0",
        params: &[I64, I64, Str, I64],
        ret: Str,
        invoke: zlib_write,
    },
    Descriptor {
        key: b"zlibWriteMore\0",
        params: &[I64, I64, I64],
        ret: Str,
        invoke: zlib_write_more,
    },
    Descriptor {
        key: b"zlibParams\0",
        params: &[I64, I64, I64, I64],
        ret: Str,
        invoke: zlib_params,
    },
    Descriptor {
        key: b"zlibReset\0",
        params: &[I64],
        ret: Str,
        invoke: zlib_reset,
    },
    Descriptor {
        key: b"zlibClose\0",
        params: &[I64],
        ret: Bool,
        invoke: zlib_close,
    },
    Descriptor {
        key: b"zlibCrc32\0",
        params: &[Str, F64],
        ret: F64,
        invoke: zlib_crc32,
    },
    // The error slots (the ABI v1 convention, see lib.rs), under `zlib`-
    // prefixed keys for the reason the module documentation gives.
    Descriptor {
        key: b"zlibErrorCode\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_code,
    },
    Descriptor {
        key: b"zlibErrorMessage\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_message,
    },
    Descriptor {
        key: b"zlibErrorErrno\0",
        params: &[],
        ret: I64,
        invoke: crate::last_error_errno,
    },
];

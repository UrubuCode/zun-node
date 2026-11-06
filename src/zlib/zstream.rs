//! The zlib half of `node:zlib`: one `z_stream` per handle, driven exactly the
//! way Node's `src/node_zlib.cc` drives it.
//!
//! Every decision here is taken from that file rather than invented, because
//! the observable behaviour of Node's `zlib` *is* the sequence of zlib calls it
//! makes: the `windowBits` rewriting per mode, the `Z_NEED_DICT` retry, the
//! concatenated-gzip member loop, and the error classification (including the
//! `"unexpected end of file"` that a truncated stream produces). The zlib
//! implementation underneath is `libz-rs-sys` (zlib-rs), whose output is
//! byte-identical to zlib's for the same parameters -- which is what the
//! corpus compares.

use core::ffi::{c_int, c_uint};

use libz_rs_sys as z;

use super::mode;

/// zlib's `Z_DEFLATED` compression method; the only one zlib defines.
const Z_DEFLATED: c_int = 8;

/// zlib return codes, named as zlib names them.
pub(super) const Z_OK: c_int = 0;
pub(super) const Z_STREAM_END: c_int = 1;
pub(super) const Z_NEED_DICT: c_int = 2;
pub(super) const Z_ERRNO: c_int = -1;
pub(super) const Z_STREAM_ERROR: c_int = -2;
pub(super) const Z_DATA_ERROR: c_int = -3;
pub(super) const Z_MEM_ERROR: c_int = -4;
pub(super) const Z_BUF_ERROR: c_int = -5;
pub(super) const Z_VERSION_ERROR: c_int = -6;

/// zlib flush values. Only the three this module names itself are declared;
/// the rest travel from the TS layer as plain integers.
#[cfg_attr(not(test), allow(dead_code))]
pub(super) const Z_NO_FLUSH: c_int = 0;
/// `Z_BLOCK`, which `deflateParams` runs internally — the reason it needs an
/// output buffer of its own.
const Z_BLOCK: c_int = 5;
pub(super) const Z_FINISH: c_int = 4;

/// `ZlibStrerror` in `node_zlib.cc`: the *code* Node reports for a raw zlib
/// return value.
pub(super) fn strerror(err: c_int) -> &'static str {
    match err {
        Z_OK => "Z_OK",
        Z_STREAM_END => "Z_STREAM_END",
        Z_NEED_DICT => "Z_NEED_DICT",
        Z_ERRNO => "Z_ERRNO",
        Z_STREAM_ERROR => "Z_STREAM_ERROR",
        Z_DATA_ERROR => "Z_DATA_ERROR",
        Z_MEM_ERROR => "Z_MEM_ERROR",
        Z_BUF_ERROR => "Z_BUF_ERROR",
        Z_VERSION_ERROR => "Z_VERSION_ERROR",
        _ => "Z_UNKNOWN_ERROR",
    }
}

/// One `(message, code, errno)` triple, the shape of `node_zlib.cc`'s
/// `CompressionError`. `None` means the step succeeded.
pub(super) type Error = (String, &'static str, i64);

/// A zlib stream and the configuration it was initialized with.
///
/// `strm.next_in` / `next_out` are set only for the duration of one
/// [`ZlibStream::step`] and nulled again afterwards: `deflateParams` and
/// `deflateReset` can touch the output buffer, and the output buffer of a step
/// is a temporary that no longer exists by then.
pub(super) struct ZlibStream {
    strm: Box<z::z_stream>,
    mode: i64,
    /// `windowBits` *after* the per-mode rewriting, i.e. what was handed to
    /// `deflateInit2`/`inflateInit2`.
    window_bits: c_int,
    level: c_int,
    mem_level: c_int,
    strategy: c_int,
    dictionary: Vec<u8>,
    /// The last zlib return code and the flush it was called with, which is
    /// what [`ZlibStream::error`] classifies (as `GetErrorInfo` does).
    err: c_int,
    flush: c_int,
    /// Has `deflateInit2`/`inflateInit2` succeeded? Nothing else may touch the
    /// stream if it has not, and `Drop` must not call `*End` on it.
    live: bool,
}

impl core::fmt::Debug for ZlibStream {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ZlibStream")
            .field("mode", &self.mode)
            .field("window_bits", &self.window_bits)
            .field("level", &self.level)
            .field("mem_level", &self.mem_level)
            .field("strategy", &self.strategy)
            .field("dictionary", &self.dictionary.len())
            .finish()
    }
}

impl Drop for ZlibStream {
    fn drop(&mut self) {
        if !self.live {
            return;
        }
        self.live = false;
        let strm = &mut *self.strm as *mut z::z_stream;
        // SAFETY: `strm` was initialized by the matching `*Init2_` below and
        // has not been ended yet (`live`). The buffers are null here, which is
        // what every step restores before returning.
        unsafe {
            if deflating(self.mode) {
                z::deflateEnd(strm);
            } else {
                z::inflateEnd(strm);
            }
        }
    }
}

/// Does this mode compress? `node_zlib.cc` switches on exactly this split.
fn deflating(m: i64) -> bool {
    m == mode::DEFLATE || m == mode::GZIP || m == mode::DEFLATERAW
}

impl ZlibStream {
    /// `ZlibContext::Init` + `ZlibContext::InitZlib` + `SetDictionary`.
    ///
    /// `window_bits` is the *unrewritten* value the JS layer validated, and
    /// may be 0 for the three inflating modes that read the window size out of
    /// the stream header.
    pub(super) fn open(
        m: i64,
        window_bits: c_int,
        level: c_int,
        mem_level: c_int,
        strategy: c_int,
        dictionary: Vec<u8>,
    ) -> Result<Self, Error> {
        // `ZlibContext::Init`: the mode decides what `windowBits` means to
        // zlib. Negative is a raw stream, +16 is a gzip wrapper, +32 is
        // "detect zlib or gzip from the header".
        let rewritten = match m {
            mode::DEFLATERAW | mode::INFLATERAW => -window_bits,
            mode::GZIP | mode::GUNZIP => window_bits + 16,
            mode::UNZIP => window_bits + 32,
            _ => window_bits,
        };

        let mut stream = ZlibStream {
            strm: Box::new(z::z_stream::default()),
            mode: m,
            window_bits: rewritten,
            level,
            mem_level,
            strategy,
            dictionary,
            err: Z_OK,
            flush: 0,
            live: false,
        };

        let strm = &mut *stream.strm as *mut z::z_stream;
        // SAFETY: `strm` points at a zeroed, owned `z_stream` whose
        // `zalloc`/`zfree` are `None`, which `libz-rs-sys` reads as "use the
        // Rust allocator". The version/size pair is the one this crate was
        // compiled against.
        stream.err = unsafe {
            if deflating(m) {
                z::deflateInit2_(
                    strm,
                    level,
                    Z_DEFLATED,
                    rewritten,
                    mem_level,
                    strategy,
                    z::zlibVersion(),
                    core::mem::size_of::<z::z_stream>() as c_int,
                )
            } else {
                z::inflateInit2_(
                    strm,
                    rewritten,
                    z::zlibVersion(),
                    core::mem::size_of::<z::z_stream>() as c_int,
                )
            }
        };
        if stream.err != Z_OK {
            return Err((
                "Init error".to_owned(),
                strerror(stream.err),
                stream.err as i64,
            ));
        }
        stream.live = true;
        stream.set_dictionary()?;
        Ok(stream)
    }

    /// `ZlibContext::SetDictionary`. A dictionary is installed up front only
    /// for the modes that cannot be told about it later: the inflating ones
    /// other than `INFLATERAW` learn about it when `inflate` answers
    /// `Z_NEED_DICT`.
    fn set_dictionary(&mut self) -> Result<(), Error> {
        if self.dictionary.is_empty() {
            return Ok(());
        }
        let strm = &mut *self.strm as *mut z::z_stream;
        let data = self.dictionary.as_ptr();
        let len = self.dictionary.len() as c_uint;
        // SAFETY: `strm` is a live, initialized stream and `data`/`len`
        // describe the owned dictionary vector.
        self.err = unsafe {
            match self.mode {
                mode::DEFLATE | mode::DEFLATERAW => z::deflateSetDictionary(strm, data, len),
                mode::INFLATERAW => z::inflateSetDictionary(strm, data, len),
                _ => Z_OK,
            }
        };
        if self.err != Z_OK {
            return Err((
                "Failed to set dictionary".to_owned(),
                strerror(self.err),
                self.err as i64,
            ));
        }
        Ok(())
    }

    /// One `deflate`/`inflate` call over `input`, writing into `out`.
    ///
    /// Returns `(produced, consumed)`. The caller owns the chunking, exactly as
    /// `lib/zlib.js`' `processChunk` loop does: a `produced == out.len()` step
    /// means "call again with a fresh output buffer".
    pub(super) fn step(&mut self, flush: c_int, input: &[u8], out: &mut [u8]) -> (usize, usize) {
        self.flush = flush;
        let strm = &mut *self.strm;
        strm.next_in = input.as_ptr();
        strm.avail_in = input.len() as c_uint;
        strm.next_out = out.as_mut_ptr();
        strm.avail_out = out.len() as c_uint;

        let ptr = strm as *mut z::z_stream;
        if deflating(self.mode) {
            // SAFETY: a live deflate stream whose buffers point at the two
            // slices above, both valid for this call.
            self.err = unsafe { z::deflate(ptr, flush) };
        } else {
            // SAFETY: as above, for a live inflate stream.
            self.err = unsafe { z::inflate(ptr, flush) };

            // `ZlibContext::DoThreadPoolWork`: a stream compressed with a
            // dictionary reports `Z_NEED_DICT`; install it and retry once.
            // `inflateSetDictionary` and `inflate` both answer `Z_DATA_ERROR`,
            // so a failure there is reported back as `Z_NEED_DICT` to keep
            // "Bad dictionary" distinguishable from bad input.
            if !self.dictionary.is_empty() && self.err == Z_NEED_DICT {
                let data = self.dictionary.as_ptr();
                let len = self.dictionary.len() as c_uint;
                // SAFETY: as above; `data`/`len` describe the owned vector.
                self.err = unsafe { z::inflateSetDictionary(ptr, data, len) };
                if self.err == Z_OK {
                    // SAFETY: as above.
                    self.err = unsafe { z::inflate(ptr, flush) };
                } else if self.err == Z_DATA_ERROR {
                    self.err = Z_NEED_DICT;
                }
            }

            // The concatenated-gzip loop. A gzip *archive* may hold several
            // members back to back; zlib stops at the end of one, so Node
            // resets the stream and keeps going while input remains and the
            // next byte is not NUL padding.
            while self.mode == mode::GUNZIP
                && self.err == Z_STREAM_END
                && strm_avail_in(ptr) > 0
                && next_in_byte(ptr) != 0
            {
                self.reset_keep_dictionary();
                if self.err != Z_OK {
                    break;
                }
                // SAFETY: the stream was just reset and still holds the
                // buffers set above.
                self.err = unsafe { z::inflate(ptr, flush) };
            }
        }

        let strm = &mut *self.strm;
        let produced = out.len() - strm.avail_out as usize;
        let consumed = input.len() - strm.avail_in as usize;
        // Nothing outside a step may see these: the slices do not outlive it.
        strm.next_in = core::ptr::null();
        strm.avail_in = 0;
        strm.next_out = core::ptr::null_mut();
        strm.avail_out = 0;
        (produced, consumed)
    }

    /// The avail_out of the *last* step, which `error` needs and which the
    /// step itself has already zeroed. Recomputed by the caller instead:
    /// `step` hands back `produced`, and the caller knows the buffer length.
    ///
    /// `ZlibContext::GetErrorInfo`, with `avail_out` passed in because this
    /// struct deliberately does not keep the step's buffers alive.
    pub(super) fn error(&self, avail_out: usize) -> Option<Error> {
        match self.err {
            Z_OK | Z_BUF_ERROR => {
                if avail_out != 0 && self.flush == Z_FINISH {
                    return Some((
                        "unexpected end of file".to_owned(),
                        "Z_BUF_ERROR",
                        Z_BUF_ERROR as i64,
                    ));
                }
                None
            }
            Z_STREAM_END => None,
            Z_NEED_DICT => {
                let message = if self.dictionary.is_empty() {
                    "Missing dictionary"
                } else {
                    "Bad dictionary"
                };
                Some((message.to_owned(), "Z_NEED_DICT", Z_NEED_DICT as i64))
            }
            err => match self.message() {
                Some(text) => Some((text, strerror(err), err as i64)),
                None => Some(("Unknown error".to_owned(), "Z_ERRNO", err as i64)),
            },
        }
    }

    /// `strm.msg`, zlib's own description of the failure (`"incorrect header
    /// check"`, `"invalid distance too far back"`, ...). Node splices it into
    /// the error verbatim.
    fn message(&self) -> Option<String> {
        if self.strm.msg.is_null() {
            return None;
        }
        // SAFETY: zlib only ever stores a static NUL-terminated string here.
        let text = unsafe { core::ffi::CStr::from_ptr(self.strm.msg) };
        Some(text.to_string_lossy().into_owned())
    }

    /// `ZlibContext::SetParams` -> `deflateParams`. A no-op for the inflating
    /// modes, as in Node.
    ///
    /// `deflateParams` runs a `deflate(strm, Z_BLOCK)` of its own to close the
    /// block the old level produced, so it needs a live output buffer: with a
    /// null `next_out` zlib answers `Z_STREAM_ERROR` outright. `out` is that
    /// buffer, and the bytes written into it are handed back the way a step's
    /// are. In practice there are none — the JS layer only calls this straight
    /// after a `Z_SYNC_FLUSH` completed, so nothing is pending — but returning
    /// them is the only reading under which none can be lost.
    ///
    /// `Z_BUF_ERROR` is accepted for the same reason Node tolerates it: it
    /// means the level change could not flush what the stream still held, and
    /// there is nothing held.
    pub(super) fn params(
        &mut self,
        level: c_int,
        strategy: c_int,
        out: &mut [u8],
    ) -> (usize, Option<Error>) {
        if !deflating(self.mode) {
            return (0, None);
        }
        let strm = &mut *self.strm;
        strm.next_in = core::ptr::null();
        strm.avail_in = 0;
        strm.next_out = out.as_mut_ptr();
        strm.avail_out = out.len() as c_uint;
        let ptr = strm as *mut z::z_stream;
        // SAFETY: a live deflate stream whose output buffer is the slice above,
        // valid for this call.
        self.err = unsafe { z::deflateParams(ptr, level, strategy) };
        let strm = &mut *self.strm;
        let produced = out.len() - strm.avail_out as usize;
        strm.next_out = core::ptr::null_mut();
        strm.avail_out = 0;
        if self.err == Z_OK || self.err == Z_BUF_ERROR {
            self.level = level;
            self.strategy = strategy;
            self.err = Z_OK;
            // The flush of record is the `Z_BLOCK` zlib just ran, so a later
            // `error()` does not read this as a truncated `Z_FINISH`.
            self.flush = Z_BLOCK;
            return (produced, None);
        }
        (
            produced,
            Some((
                "Failed to set parameters".to_owned(),
                strerror(self.err),
                self.err as i64,
            )),
        )
    }

    /// `ZlibContext::ResetStream`: `deflateReset`/`inflateReset` and then the
    /// dictionary again. `UNZIP` is not reset, matching `node_zlib.cc`'s
    /// switch, which lists only `INFLATE`, `INFLATERAW` and `GUNZIP`.
    pub(super) fn reset(&mut self) -> Option<Error> {
        self.reset_keep_dictionary();
        if self.err != Z_OK {
            return Some((
                "Failed to reset stream".to_owned(),
                strerror(self.err),
                self.err as i64,
            ));
        }
        self.set_dictionary().err()
    }

    /// The `*Reset` half of [`Self::reset`], without reinstalling the
    /// dictionary — which is what the concatenated-gzip loop needs, since it
    /// resets mid-step with the step's buffers still attached.
    fn reset_keep_dictionary(&mut self) {
        let strm = &mut *self.strm as *mut z::z_stream;
        // SAFETY: a live stream of the matching direction.
        self.err = unsafe {
            match self.mode {
                mode::DEFLATE | mode::DEFLATERAW | mode::GZIP => z::deflateReset(strm),
                mode::INFLATE | mode::INFLATERAW | mode::GUNZIP => z::inflateReset(strm),
                _ => Z_OK,
            }
        };
    }
}

/// `strm.avail_in` through a raw pointer, for the gzip member loop (which runs
/// while the struct's own borrow of `strm` is live).
///
/// # Safety
/// `ptr` must be a live stream.
fn strm_avail_in(ptr: *mut z::z_stream) -> c_uint {
    // SAFETY: the caller holds a live, initialized stream.
    unsafe { (*ptr).avail_in }
}

/// The next unread input byte, for the same loop.
fn next_in_byte(ptr: *mut z::z_stream) -> u8 {
    // SAFETY: only read when `avail_in > 0`, so `next_in` addresses at least
    // one readable byte of the caller's input slice.
    unsafe {
        let next = (*ptr).next_in;
        if next.is_null() {
            0
        } else {
            *next
        }
    }
}

/// `crc32` over `data`, seeded with `value` — zlib's own table, so the digests
/// match `zlib.crc32` exactly.
pub(super) fn crc32(value: u32, data: &[u8]) -> u32 {
    // SAFETY: `data` is a valid slice; `crc32_z` reads `len` bytes from it.
    unsafe { z::crc32_z(value as core::ffi::c_ulong, data.as_ptr(), data.len()) as u32 }
}

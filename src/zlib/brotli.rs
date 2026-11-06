//! The Brotli half of `node:zlib`, driven the way Node's `src/node_zlib.cc`
//! drives the reference library.
//!
//! Node's `BrotliCompress`/`BrotliDecompress` use the same `ZlibBase` stream
//! machinery as `Deflate`/`Inflate`; only the flush flags differ
//! (`BROTLI_OPERATION_PROCESS`/`FLUSH`/`FINISH`/`EMIT_METADATA` instead of
//! `Z_NO_FLUSH`…`Z_FINISH`) and the error classification. This module therefore
//! exposes the same `step` shape as [`super::zstream::ZlibStream`], so the
//! handle table and the TS-side chunking loop do not care which one they have.
//!
//! The implementation is the `brotli` crate, a port of the reference encoder
//! and decoder, so a stream produced here decodes in Node and vice versa
//! (`test-zlib-brotli-from-string.js` decompresses a base64 blob produced by
//! the C library, and `test-zlib-brotli-from-brotli.js` a fixture file).

use brotli::enc::encode::{
    BrotliEncoderOperation, BrotliEncoderParameter, BrotliEncoderStateStruct,
};
use brotli::enc::StandardAlloc;
use brotli::{BrotliResult, BrotliState};
use brotli_decompressor::BrotliDecoderErrorCode;

use super::zstream::Error;

/// `BROTLI_OPERATION_FINISH`, the only operation whose failure mode differs:
/// a decoder still asking for input under `FINISH` is a truncated stream.
const OPERATION_FINISH: i32 = 2;

/// The highest `BROTLI_PARAM_*` value Node's constants define
/// (`BROTLI_PARAM_NDIRECT`), which is the length of the `params` array its JS
/// layer builds minus one.
pub(super) const MAX_PARAM: i64 = 8;

/// The one `(message, code, errno)` a failed Brotli *initialization* produces.
/// Node reports exactly this for a rejected parameter — see
/// `test-zlib-brotli.js`, which asserts
/// `{ code: 'ERR_ZLIB_INITIALIZATION_FAILED', message: 'Initialization failed' }`
/// for `{ params: { BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 42 } }`.
fn init_failed() -> Error {
    (
        "Initialization failed".to_owned(),
        "ERR_ZLIB_INITIALIZATION_FAILED",
        -1,
    )
}

/// A Brotli encoder or decoder, plus the flush flag of the last step (which the
/// decoder's error classification needs).
pub(super) enum BrotliStream {
    Encode(Box<Encoder>),
    Decode(Box<Decoder>),
}

impl core::fmt::Debug for BrotliStream {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            BrotliStream::Encode(_) => f.write_str("BrotliStream::Encode"),
            BrotliStream::Decode(_) => f.write_str("BrotliStream::Decode"),
        }
    }
}

/// The encoder half. `ok` is the reference API's boolean result, which Node
/// reports as `ERR_BROTLI_COMPRESSION_FAILED`.
pub(super) struct Encoder {
    state: BrotliEncoderStateStruct<StandardAlloc>,
    /// The parameters this encoder was built with, replayed by `reset`.
    params: Vec<(i64, u32)>,
    ok: bool,
}

/// The decoder half.
pub(super) struct Decoder {
    state: BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>,
    result: BrotliResult,
    error: BrotliDecoderErrorCode,
    flush: i32,
}

/// Apply one `(index, value)` pair to an encoder, with the *reference*
/// library's validation rather than the Rust port's.
///
/// `brotli`'s own `set_parameter` is permissive where `BrotliEncoderSetParameter`
/// is not: the C function rejects a `DISABLE_LITERAL_CONTEXT_MODELING` that is
/// neither 0 nor 1, and rejects any key it does not know, and Node's corpus
/// observes both. The two keys the Rust port has no field for
/// (`BROTLI_PARAM_NPOSTFIX` = 7 and `BROTLI_PARAM_NDIRECT` = 8) are rejected
/// here for that reason, which is the one place this module is narrower than
/// Node rather than equal to it.
fn apply_param(
    state: &mut BrotliEncoderStateStruct<StandardAlloc>,
    key: i64,
    value: u32,
) -> bool {
    let parameter = match key {
        0 => BrotliEncoderParameter::BROTLI_PARAM_MODE,
        1 => BrotliEncoderParameter::BROTLI_PARAM_QUALITY,
        2 => BrotliEncoderParameter::BROTLI_PARAM_LGWIN,
        3 => BrotliEncoderParameter::BROTLI_PARAM_LGBLOCK,
        4 => {
            if value > 1 {
                return false;
            }
            BrotliEncoderParameter::BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING
        }
        5 => BrotliEncoderParameter::BROTLI_PARAM_SIZE_HINT,
        6 => BrotliEncoderParameter::BROTLI_PARAM_LARGE_WINDOW,
        _ => return false,
    };
    state.set_parameter(parameter, value)
}

impl BrotliStream {
    /// `BrotliEncoderContext::Init` / `BrotliDecoderContext::Init`, with the
    /// parameter list Node's JS layer assembles (`-1` entries are already
    /// dropped by the caller).
    pub(super) fn open(encode: bool, params: &[(i64, u32)]) -> Result<Self, Error> {
        if !encode {
            // The decoder takes `BROTLI_DECODER_PARAM_*`, of which Node defines
            // two: `DISABLE_RING_BUFFER_REALLOCATION` (0) and `LARGE_WINDOW`
            // (1). Only the second is observable, and this decoder already
            // accepts large windows, so both are accepted and ignored.
            return Ok(BrotliStream::Decode(Box::new(Decoder {
                state: BrotliState::new(
                    StandardAlloc::default(),
                    StandardAlloc::default(),
                    StandardAlloc::default(),
                ),
                result: BrotliResult::NeedsMoreInput,
                error: BrotliDecoderErrorCode::BROTLI_DECODER_NO_ERROR,
                flush: 0,
            })));
        }
        let mut state = BrotliEncoderStateStruct::new(StandardAlloc::default());
        for (key, value) in params {
            if !apply_param(&mut state, *key, *value) {
                return Err(init_failed());
            }
        }
        Ok(BrotliStream::Encode(Box::new(Encoder {
            state,
            params: params.to_vec(),
            ok: true,
        })))
    }

    /// One step, with the same `(produced, consumed)` contract as
    /// [`super::zstream::ZlibStream::step`].
    pub(super) fn step(&mut self, flush: i32, input: &[u8], out: &mut [u8]) -> (usize, usize) {
        match self {
            BrotliStream::Encode(encoder) => encoder.step(flush, input, out),
            BrotliStream::Decode(decoder) => decoder.step(flush, input, out),
        }
    }

    /// `GetErrorInfo` for whichever half this is.
    pub(super) fn error(&self) -> Option<Error> {
        match self {
            BrotliStream::Encode(encoder) => {
                if encoder.ok {
                    None
                } else {
                    Some((
                        "Compression failed".to_owned(),
                        "ERR_BROTLI_COMPRESSION_FAILED",
                        -1,
                    ))
                }
            }
            BrotliStream::Decode(decoder) => decoder.error(),
        }
    }

    /// `reset()`. Brotli has no in-place reset, so a fresh instance with the
    /// same parameters takes the old one's place — which is what the reference
    /// library's own `BrotliEncoderDestroyInstance` + `CreateInstance` pair
    /// amounts to.
    pub(super) fn reset(&mut self) -> Option<Error> {
        let replacement = match self {
            BrotliStream::Encode(encoder) => BrotliStream::open(true, &encoder.params),
            BrotliStream::Decode(_) => BrotliStream::open(false, &[]),
        };
        match replacement {
            Ok(fresh) => {
                *self = fresh;
                None
            }
            Err(error) => Some(error),
        }
    }
}

impl Encoder {
    fn step(&mut self, flush: i32, input: &[u8], out: &mut [u8]) -> (usize, usize) {
        let operation = match flush {
            1 => BrotliEncoderOperation::BROTLI_OPERATION_FLUSH,
            2 => BrotliEncoderOperation::BROTLI_OPERATION_FINISH,
            3 => BrotliEncoderOperation::BROTLI_OPERATION_EMIT_METADATA,
            _ => BrotliEncoderOperation::BROTLI_OPERATION_PROCESS,
        };
        let mut available_in = input.len();
        let mut input_offset = 0usize;
        let mut available_out = out.len();
        let mut output_offset = 0usize;
        let mut total_out = Some(0usize);
        self.ok = self.state.compress_stream(
            operation,
            &mut available_in,
            input,
            &mut input_offset,
            &mut available_out,
            out,
            &mut output_offset,
            &mut total_out,
            &mut |_, _, _, _| (),
        );
        (output_offset, input_offset)
    }
}

impl Decoder {
    fn step(&mut self, flush: i32, input: &[u8], out: &mut [u8]) -> (usize, usize) {
        self.flush = flush;
        let mut available_in = input.len();
        let mut input_offset = 0usize;
        let mut available_out = out.len();
        let mut output_offset = 0usize;
        let mut total_out = 0usize;
        self.result = brotli::BrotliDecompressStream(
            &mut available_in,
            &mut input_offset,
            input,
            &mut available_out,
            &mut output_offset,
            out,
            &mut total_out,
            &mut self.state,
        );
        if let BrotliResult::ResultFailure = self.result {
            self.error = self.state.error_code;
        }
        (output_offset, input_offset)
    }

    /// `BrotliDecoderContext::GetErrorInfo`: a decoder error carries the
    /// reference library's error *name* as the Node error code, and a decoder
    /// still asking for input under `BROTLI_OPERATION_FINISH` is a truncated
    /// stream.
    fn error(&self) -> Option<Error> {
        if !matches!(
            self.error,
            BrotliDecoderErrorCode::BROTLI_DECODER_NO_ERROR
                | BrotliDecoderErrorCode::BROTLI_DECODER_SUCCESS
        ) {
            return Some((
                "Decompression failed".to_owned(),
                error_name(self.error),
                self.error as i64,
            ));
        }
        if self.flush == OPERATION_FINISH && matches!(self.result, BrotliResult::NeedsMoreInput) {
            return Some((
                "Unexpected end of input".to_owned(),
                "ERR_BROTLI_DECOMPRESSION_FAILED",
                -1,
            ));
        }
        None
    }
}

/// The reference library's name for a decoder error code
/// (`"ERROR_FORMAT_EXUBERANT_NIBBLE"`, ...), which Node reports as the error's
/// `code` — `BrotliDecoderErrorString` in the C library, which drops the
/// `BROTLI_DECODER_` prefix the enum carries.
///
/// `brotli-decompressor` has the same table, but only behind its `ffi-api`
/// feature, which would export two dozen `#[no_mangle]` C symbols from this
/// extension's dynamic library. The names are mechanical, so they are spelled
/// out here instead of widening the ABI surface for them.
fn error_name(code: BrotliDecoderErrorCode) -> &'static str {
    use BrotliDecoderErrorCode as E;
    match code {
        E::BROTLI_DECODER_NO_ERROR => "NO_ERROR",
        E::BROTLI_DECODER_SUCCESS => "SUCCESS",
        E::BROTLI_DECODER_NEEDS_MORE_INPUT => "NEEDS_MORE_INPUT",
        E::BROTLI_DECODER_NEEDS_MORE_OUTPUT => "NEEDS_MORE_OUTPUT",
        E::BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE => "ERROR_FORMAT_EXUBERANT_NIBBLE",
        E::BROTLI_DECODER_ERROR_FORMAT_RESERVED => "ERROR_FORMAT_RESERVED",
        E::BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE => {
            "ERROR_FORMAT_EXUBERANT_META_NIBBLE"
        }
        E::BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET => {
            "ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET"
        }
        E::BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME => "ERROR_FORMAT_SIMPLE_HUFFMAN_SAME",
        E::BROTLI_DECODER_ERROR_FORMAT_CL_SPACE => "ERROR_FORMAT_CL_SPACE",
        E::BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE => "ERROR_FORMAT_HUFFMAN_SPACE",
        E::BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT => "ERROR_FORMAT_CONTEXT_MAP_REPEAT",
        E::BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1 => "ERROR_FORMAT_BLOCK_LENGTH_1",
        E::BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2 => "ERROR_FORMAT_BLOCK_LENGTH_2",
        E::BROTLI_DECODER_ERROR_FORMAT_TRANSFORM => "ERROR_FORMAT_TRANSFORM",
        E::BROTLI_DECODER_ERROR_FORMAT_DICTIONARY => "ERROR_FORMAT_DICTIONARY",
        E::BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS => "ERROR_FORMAT_WINDOW_BITS",
        E::BROTLI_DECODER_ERROR_FORMAT_PADDING_1 => "ERROR_FORMAT_PADDING_1",
        E::BROTLI_DECODER_ERROR_FORMAT_PADDING_2 => "ERROR_FORMAT_PADDING_2",
        E::BROTLI_DECODER_ERROR_FORMAT_DISTANCE => "ERROR_FORMAT_DISTANCE",
        E::BROTLI_DECODER_ERROR_FORMAT_BLOCK_SWITCH => "ERROR_FORMAT_BLOCK_SWITCH",
        E::BROTLI_DECODER_ERROR_COMPOUND_DICTIONARY => "ERROR_COMPOUND_DICTIONARY",
        E::BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET => "ERROR_DICTIONARY_NOT_SET",
        E::BROTLI_DECODER_ERROR_INVALID_ARGUMENTS => "ERROR_INVALID_ARGUMENTS",
        E::BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES => "ERROR_ALLOC_CONTEXT_MODES",
        E::BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS => "ERROR_ALLOC_TREE_GROUPS",
        E::BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP => "ERROR_ALLOC_CONTEXT_MAP",
        E::BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1 => "ERROR_ALLOC_RING_BUFFER_1",
        E::BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2 => "ERROR_ALLOC_RING_BUFFER_2",
        E::BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES => "ERROR_ALLOC_BLOCK_TYPE_TREES",
        E::BROTLI_DECODER_ERROR_UNREACHABLE => "ERROR_UNREACHABLE",
    }
}

//! zstd streams for Node 25's `ZstdCompress` / `ZstdDecompress`, over the
//! pure-Rust `ruzstd` crate.
//!
//! The stream shape is the one [`super::zstream::ZlibStream::step`] has:
//! `step(flush, input, out)` answers `(produced, consumed)`. Both halves take
//! the whole input chunk on every step and keep a private output queue, so the
//! chunking loop in `zlib.ts` sees `availInAfter === 0` and keeps calling while
//! the queue fills `out`.
//!
//! Compression. `ruzstd` compresses a whole frame at a time, so the encoder
//! buffers its input:
//!
//! * `ZSTD_e_continue` only buffers.
//! * `ZSTD_e_flush` emits what is buffered as raw blocks of an open frame —
//!   the frame header first if this is the frame's first output. The header is
//!   libzstd's streaming one (`0x00` descriptor, `0x58` window), so a flushed
//!   16-byte chunk is byte-for-byte what Node produces.
//! * `ZSTD_e_end` closes the frame. A frame that was never flushed is
//!   compressed in one go by `ruzstd`; one that was already opened by a flush
//!   is finished with raw blocks and a last block.
//!
//! `ruzstd` implements only its "fastest" level (about zstd level 1), so every
//! compression level compresses the same way.
//!
//! Decompression buffers input and decodes every complete frame as soon as it
//! is present. An incomplete frame waits for more input; at `ZSTD_e_end` it is
//! an error.

use ruzstd::decoding::errors::{FrameDecoderError, ReadFrameHeaderError};
use ruzstd::decoding::{BlockDecodingStrategy, FrameDecoder};
use ruzstd::encoding::{compress_to_vec, CompressionLevel};

use super::zstream::Error;

/// `ZSTD_e_flush`.
const E_FLUSH: i32 = 1;
/// `ZSTD_e_end`.
const E_END: i32 = 2;

/// The zstd frame magic number, little-endian.
const MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
/// The largest raw block (`ZSTD_BLOCKSIZE_MAX`).
const BLOCK_MAX: usize = 128 * 1024;

pub(super) enum ZstdStream {
    Encode(Encoder),
    Decode(Decoder),
}

pub(super) struct Encoder {
    pending: Vec<u8>,
    queue: Vec<u8>,
    sent: usize,
    /// Whether a flush has already emitted the current frame's header.
    open: bool,
    /// Bytes taken into the current frame, for `pledgedSrcSize`.
    total: u64,
    pledged: Option<u64>,
    /// Whether `ZSTD_e_end` already closed the frame and no input came since,
    /// so a repeated end step (the chunking loop's continuation) emits nothing.
    ended: bool,
    error: Option<Error>,
}

pub(super) struct Decoder {
    pending: Vec<u8>,
    queue: Vec<u8>,
    sent: usize,
    error: Option<Error>,
}

fn raw_blocks(data: &[u8], last: bool, out: &mut Vec<u8>) {
    let mut chunks: Vec<&[u8]> = data.chunks(BLOCK_MAX).collect();
    if chunks.is_empty() {
        if !last {
            return;
        }
        chunks.push(&[]);
    }
    let count = chunks.len();
    for (index, chunk) in chunks.into_iter().enumerate() {
        let is_last = last && index + 1 == count;
        let header = ((chunk.len() as u32) << 3) | u32::from(is_last);
        out.extend_from_slice(&header.to_le_bytes()[..3]);
        out.extend_from_slice(chunk);
    }
}

fn drain(queue: &mut Vec<u8>, sent: &mut usize, out: &mut [u8]) -> usize {
    let available = queue.len() - *sent;
    let n = available.min(out.len());
    out[..n].copy_from_slice(&queue[*sent..*sent + n]);
    *sent += n;
    if *sent == queue.len() {
        queue.clear();
        *sent = 0;
    }
    n
}

impl ZstdStream {
    pub(super) fn open(encode: bool, pledged: Option<u64>) -> Self {
        if encode {
            ZstdStream::Encode(Encoder {
                pending: Vec::new(),
                queue: Vec::new(),
                sent: 0,
                open: false,
                total: 0,
                pledged,
                ended: false,
                error: None,
            })
        } else {
            ZstdStream::Decode(Decoder {
                pending: Vec::new(),
                queue: Vec::new(),
                sent: 0,
                error: None,
            })
        }
    }

    pub(super) fn step(&mut self, flush: i32, input: &[u8], out: &mut [u8]) -> (usize, usize) {
        match self {
            ZstdStream::Encode(encoder) => encoder.step(flush, input, out),
            ZstdStream::Decode(decoder) => decoder.step(flush, input, out),
        }
    }

    pub(super) fn error(&self) -> Option<Error> {
        match self {
            ZstdStream::Encode(encoder) => encoder.error.clone(),
            ZstdStream::Decode(decoder) => decoder.error.clone(),
        }
    }

    pub(super) fn reset(&mut self) {
        let fresh = match self {
            ZstdStream::Encode(encoder) => ZstdStream::open(true, encoder.pledged),
            ZstdStream::Decode(_) => ZstdStream::open(false, None),
        };
        *self = fresh;
    }
}

impl Encoder {
    fn step(&mut self, flush: i32, input: &[u8], out: &mut [u8]) -> (usize, usize) {
        if self.error.is_some() {
            return (0, 0);
        }
        self.pending.extend_from_slice(input);
        self.total += input.len() as u64;
        if !input.is_empty() {
            self.ended = false;
        }
        if flush == E_FLUSH && !self.pending.is_empty() {
            if !self.open {
                self.queue.extend_from_slice(&MAGIC);
                self.queue.extend_from_slice(&[0x00, 0x58]);
                self.open = true;
            }
            let data = std::mem::take(&mut self.pending);
            raw_blocks(&data, false, &mut self.queue);
        } else if flush == E_END && !self.ended {
            if let Some(pledged) = self.pledged {
                if pledged != self.total {
                    self.error = Some((
                        "Src size is incorrect".to_owned(),
                        "ZSTD_error_srcSize_wrong",
                        -72,
                    ));
                    return (0, input.len());
                }
            }
            let data = std::mem::take(&mut self.pending);
            if self.open {
                raw_blocks(&data, true, &mut self.queue);
            } else {
                if data.is_empty() {
                    // libzstd's frame for no input: single-segment, a one-byte
                    // content size of 0, and one empty last raw block.
                    self.queue.extend_from_slice(&MAGIC);
                    self.queue.extend_from_slice(&[0x20, 0x00, 0x01, 0x00, 0x00]);
                } else {
                    let frame = compress_to_vec(&data[..], CompressionLevel::Fastest);
                    self.queue.extend_from_slice(&frame);
                }
            }
            self.open = false;
            self.total = 0;
            self.ended = true;
        }
        (drain(&mut self.queue, &mut self.sent, out), input.len())
    }
}

impl Decoder {
    fn step(&mut self, flush: i32, input: &[u8], out: &mut [u8]) -> (usize, usize) {
        if self.error.is_some() {
            return (0, 0);
        }
        self.pending.extend_from_slice(input);
        // Decode every complete frame at the front of `pending`.
        let mut position = 0usize;
        while position < self.pending.len() {
            let mut source: &[u8] = &self.pending[position..];
            let before = source.len();
            let mut decoder = FrameDecoder::new();
            match decoder.init(&mut source) {
                Ok(()) => {}
                Err(FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::SkipFrame {
                    length,
                    ..
                })) => {
                    let header = before - source.len();
                    let skip = header + length as usize;
                    if position + skip > self.pending.len() {
                        break;
                    }
                    position += skip;
                    continue;
                }
                Err(error) => {
                    if flush == E_END || before >= 4 && self.pending[position..position + 4] != MAGIC {
                        self.error = Some(decode_error(&error));
                        return (0, input.len());
                    }
                    break;
                }
            }
            match decoder.decode_blocks(&mut source, BlockDecodingStrategy::All) {
                Ok(true) => {
                    if let Some(bytes) = decoder.collect() {
                        self.queue.extend_from_slice(&bytes);
                    }
                    position += before - source.len();
                }
                Ok(false) => break,
                Err(error) => {
                    if flush == E_END {
                        self.error = Some(decode_error(&error));
                        return (0, input.len());
                    }
                    break;
                }
            }
        }
        self.pending.drain(..position);
        (drain(&mut self.queue, &mut self.sent, out), input.len())
    }
}

fn decode_error(error: &FrameDecoderError) -> Error {
    match error {
        FrameDecoderError::ReadFrameHeaderError(ReadFrameHeaderError::BadMagicNumber(_)) => (
            "Unknown frame descriptor".to_owned(),
            "ZSTD_error_prefix_unknown",
            -10,
        ),
        FrameDecoderError::DictNotProvided { .. } => (
            "Dictionary mismatch".to_owned(),
            "ZSTD_error_dictionary_wrong",
            -32,
        ),
        _ => (
            "Data corruption detected".to_owned(),
            "ZSTD_error_corruption_detected",
            -20,
        ),
    }
}

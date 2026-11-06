//! Tests for the `node:zlib` natives.
//!
//! These exercise the engines through the same `(message, code, errno)` and
//! `(produced, consumed)` contracts the ABI layer uses, and pin the two things
//! the TypeScript side cannot check for itself: that the bytes agree with
//! zlib's (a fixture produced by the real library round-trips), and that the
//! error classification matches `node_zlib.cc`'s.

use super::brotli::BrotliStream;
use super::mode;
use super::zstream::{crc32, ZlibStream, Z_FINISH, Z_NO_FLUSH};

/// Node's `Z_DEFAULT_*` option values, as its JS layer passes them.
const LEVEL: i32 = -1;
const MEM_LEVEL: i32 = 8;
const STRATEGY: i32 = 0;
const WINDOW_BITS: i32 = 15;

/// Run a whole buffer through one stream with `Z_FINISH`, growing the output
/// the way `lib/zlib.js`' loop does.
fn run(stream: &mut ZlibStream, input: &[u8]) -> Vec<u8> {
    let mut collected = Vec::new();
    let mut offset = 0usize;
    loop {
        let mut out = vec![0u8; 256];
        let (produced, consumed) = stream.step(Z_FINISH, &input[offset..], &mut out);
        offset += consumed;
        collected.extend_from_slice(&out[..produced]);
        if produced < out.len() {
            break;
        }
    }
    collected
}

fn deflate_of(m: i64, input: &[u8]) -> Vec<u8> {
    let mut stream =
        ZlibStream::open(m, WINDOW_BITS, LEVEL, MEM_LEVEL, STRATEGY, Vec::new()).unwrap();
    run(&mut stream, input)
}

fn inflate_of(m: i64, input: &[u8]) -> Vec<u8> {
    let mut stream = ZlibStream::open(m, WINDOW_BITS, LEVEL, MEM_LEVEL, STRATEGY, Vec::new()).unwrap();
    run(&mut stream, input)
}

#[test]
fn deflate_inflate_round_trips() {
    let input = b"ZunZunZun compresses nicely because it repeats. ".repeat(40);
    let compressed = deflate_of(mode::DEFLATE, &input);
    assert!(compressed.len() < input.len());
    assert_eq!(inflate_of(mode::INFLATE, &compressed), input);
}

#[test]
fn gzip_gunzip_round_trips_and_wears_a_gzip_header() {
    let input = b"gzip me".to_vec();
    let compressed = deflate_of(mode::GZIP, &input);
    assert_eq!(&compressed[..3], &[0x1f, 0x8b, 0x08]);
    assert_eq!(inflate_of(mode::GUNZIP, &compressed), input);
    // UNZIP auto-detects both wrappers.
    assert_eq!(inflate_of(mode::UNZIP, &compressed), input);
    assert_eq!(
        inflate_of(mode::UNZIP, &deflate_of(mode::DEFLATE, &input)),
        input
    );
}

#[test]
fn raw_deflate_has_no_wrapper() {
    let input = b"raw".to_vec();
    let raw = deflate_of(mode::DEFLATERAW, &input);
    let zlib = deflate_of(mode::DEFLATE, &input);
    // The zlib wrapper is a two-byte header plus a four-byte adler32.
    assert_eq!(zlib.len(), raw.len() + 6);
    assert_eq!(inflate_of(mode::INFLATERAW, &raw), input);
}

/// The one byte sequence this module must agree with zlib on exactly: the
/// zlib stream of the empty input at the default level, which is what
/// `test-zlib-empty-buffer.js` round-trips and `test-zlib-zero-byte.js`
/// measures (gzip of nothing is 20 bytes).
#[test]
fn empty_input_matches_zlib_byte_for_byte() {
    assert_eq!(deflate_of(mode::DEFLATE, b""), vec![0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01]);
    assert_eq!(deflate_of(mode::DEFLATERAW, b""), vec![0x03, 0x00]);
    assert_eq!(deflate_of(mode::GZIP, b"").len(), 20);
}

/// `test-zlib-from-string.js` decompresses this blob, which the real zlib
/// produced, so decoding it proves wire compatibility in the direction that
/// matters most.
#[test]
fn inflates_a_stream_produced_by_the_real_zlib() {
    // `deflate` of "hello world" at the default level, as zlib emits it.
    let compressed = [
        0x78, 0x9c, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0x01, 0x00,
        0x1a, 0x0b, 0x04, 0x5d,
    ];
    assert_eq!(inflate_of(mode::INFLATE, &compressed), b"hello world");
}

#[test]
fn truncated_input_is_an_unexpected_end_of_file() {
    let input = b"truncate me, please, with enough bytes to need a block".to_vec();
    let compressed = deflate_of(mode::DEFLATE, &input);
    let truncated = &compressed[..compressed.len() / 2];

    let mut stream =
        ZlibStream::open(mode::INFLATE, WINDOW_BITS, LEVEL, MEM_LEVEL, STRATEGY, Vec::new())
            .unwrap();
    let mut out = vec![0u8; 4096];
    let (produced, _) = stream.step(Z_FINISH, truncated, &mut out);
    let error = stream.error(out.len() - produced).expect("should fail");
    assert_eq!(error.0, "unexpected end of file");
    assert_eq!(error.1, "Z_BUF_ERROR");
}

#[test]
fn garbage_input_is_a_data_error_with_zlibs_own_message() {
    let mut stream =
        ZlibStream::open(mode::INFLATE, WINDOW_BITS, LEVEL, MEM_LEVEL, STRATEGY, Vec::new())
            .unwrap();
    let mut out = vec![0u8; 64];
    let (produced, _) = stream.step(Z_FINISH, b"this is not valid compressed data.", &mut out);
    let error = stream.error(out.len() - produced).expect("should fail");
    assert_eq!(error.1, "Z_DATA_ERROR");
    assert_eq!(error.0, "incorrect header check");
}

/// `test-zlib-dictionary-fail.js`: the two `Z_NEED_DICT` messages have to stay
/// distinguishable, because that is the only way a consumer can tell a missing
/// dictionary from a wrong one.
#[test]
fn missing_and_bad_dictionaries_report_differently() {
    // "test" deflated with the dictionary "dict".
    let input = [0x78u8, 0xBB, 0x04, 0x09, 0x01, 0xA5];

    let mut missing =
        ZlibStream::open(mode::INFLATE, WINDOW_BITS, LEVEL, MEM_LEVEL, STRATEGY, Vec::new())
            .unwrap();
    let mut out = vec![0u8; 64];
    let (produced, _) = missing.step(Z_FINISH, &input, &mut out);
    let error = missing.error(out.len() - produced).expect("should fail");
    assert_eq!(error.0, "Missing dictionary");
    assert_eq!(error.1, "Z_NEED_DICT");

    let mut bad = ZlibStream::open(
        mode::INFLATE,
        WINDOW_BITS,
        LEVEL,
        MEM_LEVEL,
        STRATEGY,
        b"fail".to_vec(),
    )
    .unwrap();
    let mut out = vec![0u8; 64];
    let (produced, _) = bad.step(Z_FINISH, &input, &mut out);
    let error = bad.error(out.len() - produced).expect("should fail");
    assert_eq!(error.0, "Bad dictionary");
}

#[test]
fn a_dictionary_round_trips() {
    let dictionary = b"the quick brown fox".to_vec();
    let input = b"the quick brown fox jumps over the quick brown fox".to_vec();

    let mut deflate = ZlibStream::open(
        mode::DEFLATE,
        WINDOW_BITS,
        LEVEL,
        MEM_LEVEL,
        STRATEGY,
        dictionary.clone(),
    )
    .unwrap();
    let compressed = run(&mut deflate, &input);

    let mut inflate = ZlibStream::open(
        mode::INFLATE,
        WINDOW_BITS,
        LEVEL,
        MEM_LEVEL,
        STRATEGY,
        dictionary,
    )
    .unwrap();
    assert_eq!(run(&mut inflate, &compressed), input);
}

/// `test-zlib-from-concatenated-gzip.js`: two gzip members back to back are
/// one logical stream to `gunzip`.
#[test]
fn concatenated_gzip_members_decode_as_one_stream() {
    let mut both = deflate_of(mode::GZIP, b"abc");
    both.extend_from_slice(&deflate_of(mode::GZIP, b"def"));
    assert_eq!(inflate_of(mode::GUNZIP, &both), b"abcdef");
}

/// `windowBits: 0` is only legal for the inflating modes, where it means "read
/// the window size out of the header"; the engine must accept it there.
#[test]
fn zero_window_bits_inflates_with_the_streams_own_window() {
    let compressed = deflate_of(mode::DEFLATE, b"window");
    let mut stream =
        ZlibStream::open(mode::INFLATE, 0, LEVEL, MEM_LEVEL, STRATEGY, Vec::new()).unwrap();
    assert_eq!(run(&mut stream, &compressed), b"window");
}

/// A `windowBits: 8` raw deflate is readable by a `windowBits: 8` raw inflate,
/// which is the invariant `test-zlib.js` spells out at length (zlib silently
/// upgrades 8 to 9 on the deflate side and the result is still a valid
/// 8-bit-window stream).
#[test]
fn raw_window_bits_eight_round_trips() {
    let input = b"small window".repeat(8);
    let mut deflate =
        ZlibStream::open(mode::DEFLATERAW, 9, LEVEL, MEM_LEVEL, STRATEGY, Vec::new()).unwrap();
    let compressed = run(&mut deflate, &input);
    let mut inflate =
        ZlibStream::open(mode::INFLATERAW, 8, LEVEL, MEM_LEVEL, STRATEGY, Vec::new()).unwrap();
    assert_eq!(run(&mut inflate, &compressed), input);
}

/// `reset()` puts a half-written deflate back at the start of a stream.
#[test]
fn reset_restarts_the_stream() {
    let mut stream = ZlibStream::open(
        mode::DEFLATE,
        WINDOW_BITS,
        LEVEL,
        MEM_LEVEL,
        STRATEGY,
        Vec::new(),
    )
    .unwrap();
    let mut out = vec![0u8; 64];
    stream.step(Z_NO_FLUSH, b"discarded", &mut out);
    assert!(stream.reset().is_none());
    let compressed = run(&mut stream, b"kept");
    assert_eq!(inflate_of(mode::INFLATE, &compressed), b"kept");
}

/// `params()` after a flush changes the level without breaking the stream.
#[test]
fn params_changes_the_level_mid_stream() {
    let mut stream =
        ZlibStream::open(mode::DEFLATE, WINDOW_BITS, 9, MEM_LEVEL, STRATEGY, Vec::new()).unwrap();
    let head = b"the first half, compressed at level nine".repeat(4);
    let mut out = vec![0u8; 4096];
    // Z_SYNC_FLUSH (3) leaves the stream open with nothing pending.
    let (produced, _) = stream.step(3, &head, &mut out);
    let mut collected = out[..produced].to_vec();
    let mut scratch = vec![0u8; 64];
    let (produced, error) = stream.params(0, STRATEGY, &mut scratch);
    assert!(error.is_none());
    collected.extend_from_slice(&scratch[..produced]);
    let tail = b"the second half, stored".to_vec();
    collected.extend_from_slice(&run(&mut stream, &tail));

    let mut whole = head.clone();
    whole.extend_from_slice(&tail);
    assert_eq!(inflate_of(mode::INFLATE, &collected), whole);
}

/// The CRCs `test-zlib-crc32.js` asserts, including the seeded form.
#[test]
fn crc32_matches_zlibs_table() {
    assert_eq!(crc32(0, b""), 0);
    assert_eq!(crc32(0xffffffff, b""), 0xffffffff);
    assert_eq!(crc32(0, b"hello"), 0x3610a686);
    assert_eq!(crc32(0, b"zlib"), 0x73887d3a);
    assert_eq!(crc32(0x73c84278, b"zlib"), 0x6432d127);
    assert_eq!(crc32(0x7a30360d, b"abacus"), 0xf8655a84);
}

// ---------------------------------------------------------------------------
// Brotli
// ---------------------------------------------------------------------------

/// `BROTLI_OPERATION_FINISH`.
const FINISH: i32 = 2;

fn brotli_run(stream: &mut BrotliStream, input: &[u8]) -> Vec<u8> {
    let mut collected = Vec::new();
    let mut offset = 0usize;
    loop {
        let mut out = vec![0u8; 256];
        let (produced, consumed) = stream.step(FINISH, &input[offset..], &mut out);
        offset += consumed;
        collected.extend_from_slice(&out[..produced]);
        if produced < out.len() {
            break;
        }
    }
    collected
}

#[test]
fn brotli_round_trips() {
    let input = b"Brotli compresses repeated text very well indeed. ".repeat(20);
    let mut encoder = BrotliStream::open(true, &[]).unwrap();
    let compressed = brotli_run(&mut encoder, &input);
    assert!(encoder.error().is_none());
    assert!(compressed.len() < input.len());

    let mut decoder = BrotliStream::open(false, &[]).unwrap();
    assert_eq!(brotli_run(&mut decoder, &compressed), input);
    assert!(decoder.error().is_none());
}

/// The blob `test-zlib-brotli-from-string.js` decompresses was produced by the
/// reference C encoder, so decoding it proves wire compatibility.
#[test]
fn brotli_decodes_a_stream_from_the_reference_encoder() {
    // `brotliCompress("hello world")` as Node emits it.
    let compressed = [
        0x0bu8, 0x05, 0x80, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x03,
    ];
    let mut decoder = BrotliStream::open(false, &[]).unwrap();
    assert_eq!(brotli_run(&mut decoder, &compressed), b"hello world");
}

/// Higher `BROTLI_PARAM_QUALITY` must not produce *larger* output, which is
/// the property `test-zlib-brotli.js` asserts across the whole quality range.
#[test]
fn brotli_quality_is_honoured() {
    let input = b"quality matters when the input is long and repetitive. ".repeat(50);
    let small = {
        let mut encoder = BrotliStream::open(true, &[(1, 11)]).unwrap();
        brotli_run(&mut encoder, &input).len()
    };
    let large = {
        let mut encoder = BrotliStream::open(true, &[(1, 0)]).unwrap();
        brotli_run(&mut encoder, &input).len()
    };
    assert!(small < large, "quality 11 ({small}) should beat quality 0 ({large})");
}

/// `test-zlib-brotli.js` asserts that a boolean parameter given 42 fails
/// initialization with `ERR_ZLIB_INITIALIZATION_FAILED`.
#[test]
fn brotli_rejects_an_out_of_range_boolean_parameter() {
    let error = BrotliStream::open(true, &[(4, 42)]).expect_err("should fail");
    assert_eq!(error.0, "Initialization failed");
    assert_eq!(error.1, "ERR_ZLIB_INITIALIZATION_FAILED");
    // 0 and 1 are the legal values.
    assert!(BrotliStream::open(true, &[(4, 1)]).is_ok());
}

#[test]
fn brotli_garbage_is_a_decompression_failure() {
    let mut decoder = BrotliStream::open(false, &[]).unwrap();
    let mut out = vec![0u8; 64];
    decoder.step(FINISH, b"this is not valid compressed data.", &mut out);
    let error = decoder.error().expect("should fail");
    assert_eq!(error.0, "Decompression failed");
}

#[test]
fn brotli_truncated_input_is_an_unexpected_end_of_input() {
    let input = b"truncate this brotli stream somewhere in the middle".to_vec();
    let mut encoder = BrotliStream::open(true, &[]).unwrap();
    let compressed = brotli_run(&mut encoder, &input);

    let mut decoder = BrotliStream::open(false, &[]).unwrap();
    let mut out = vec![0u8; 4096];
    decoder.step(FINISH, &compressed[..compressed.len() / 2], &mut out);
    let error = decoder.error().expect("should fail");
    assert_eq!(error.0, "Unexpected end of input");
    assert_eq!(error.1, "ERR_BROTLI_DECOMPRESSION_FAILED");
}

#[test]
fn brotli_reset_restarts_the_stream() {
    let mut encoder = BrotliStream::open(true, &[(1, 5)]).unwrap();
    let mut out = vec![0u8; 64];
    encoder.step(0, b"discarded", &mut out);
    assert!(encoder.reset().is_none());
    let compressed = brotli_run(&mut encoder, b"kept");
    let mut decoder = BrotliStream::open(false, &[]).unwrap();
    assert_eq!(brotli_run(&mut decoder, &compressed), b"kept");
}

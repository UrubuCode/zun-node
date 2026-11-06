//! base64 for the byte payloads that cross the ABI.
//!
//! The `Str` carrier is a NUL-terminated C string, so raw file bytes cannot
//! ride it (see the `node:fs` module documentation). They cross base64-encoded
//! instead, which the engine's prelude `Buffer` decodes on the other side.
//!
//! Standard alphabet, `=`-padded (RFC 4648 §4) — `Buffer.from(text, "base64")`
//! accepts that, and `buf.toString("base64")` produces it.

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encode `bytes` as padded base64.
pub(crate) fn encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    let mut chunks = bytes.chunks_exact(3);
    for chunk in &mut chunks {
        let word = (u32::from(chunk[0]) << 16) | (u32::from(chunk[1]) << 8) | u32::from(chunk[2]);
        out.push(ALPHABET[(word >> 18) as usize & 0x3f] as char);
        out.push(ALPHABET[(word >> 12) as usize & 0x3f] as char);
        out.push(ALPHABET[(word >> 6) as usize & 0x3f] as char);
        out.push(ALPHABET[word as usize & 0x3f] as char);
    }
    match chunks.remainder() {
        [a] => {
            let word = u32::from(*a) << 16;
            out.push(ALPHABET[(word >> 18) as usize & 0x3f] as char);
            out.push(ALPHABET[(word >> 12) as usize & 0x3f] as char);
            out.push_str("==");
        }
        [a, b] => {
            let word = (u32::from(*a) << 16) | (u32::from(*b) << 8);
            out.push(ALPHABET[(word >> 18) as usize & 0x3f] as char);
            out.push(ALPHABET[(word >> 12) as usize & 0x3f] as char);
            out.push(ALPHABET[(word >> 6) as usize & 0x3f] as char);
            out.push('=');
        }
        _ => {}
    }
    out
}

/// The 6-bit value of one base64 character, or `None` for padding/whitespace
/// and anything outside the alphabet.
fn sextet(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Decode base64 (padding optional, unknown characters skipped — the lenient
/// reading `Buffer.from(…, "base64")` also takes, so a round trip through
/// either side agrees).
pub(crate) fn decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut accumulator: u32 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
        let Some(value) = sextet(byte) else { continue };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
        }
    }
    out
}

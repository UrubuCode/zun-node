//! The key derivation functions: PBKDF2 (RFC 2898), HKDF (RFC 5869) and
//! scrypt (RFC 7914).
//!
//! PBKDF2 and HKDF are written out here, over [`Mac`], for the reason
//! `mac.rs` gives: taking them from the `pbkdf2`/`hkdf` crates would mean a
//! generic instantiation per digest, and both are a dozen lines of HMAC
//! bookkeeping whose correctness the RFC vectors in `tests.rs` pin exactly.
//!
//! scrypt is not: `scryptROMix` over Salsa20/8 is where an implementation of
//! it goes wrong, and the `scrypt` crate is the reviewed port (see
//! `../../Cargo.toml`).

use super::hash::Alg;
use super::mac::Mac;

/// `PBKDF2(PRF = HMAC-alg, password, salt, c, dkLen)`.
///
/// `iterations` and `keylen` are validated by the caller (Node's `ERR_*`
/// ranges live in the TS layer), so both are trusted positive here.
pub(crate) fn pbkdf2(
    alg: Alg,
    password: &[u8],
    salt: &[u8],
    iterations: u32,
    keylen: usize,
) -> Vec<u8> {
    let size = alg.output_size();
    let mut out = Vec::with_capacity(keylen);
    // The HMAC key is the password for every block, so the padded key is
    // derived once and cloned per block rather than per iteration.
    let prf = Mac::new(alg, password);
    let mut index: u32 = 1;
    while out.len() < keylen {
        // U_1 = PRF(password, salt || INT_32_BE(i))
        let mut mac = prf.clone();
        mac.update(salt);
        mac.update(&index.to_be_bytes());
        let mut block = mac.finish();
        let mut accumulator = block.clone();
        // U_n = PRF(password, U_{n-1}); T_i = U_1 ^ ... ^ U_c
        for _ in 1..iterations {
            let mut mac = prf.clone();
            mac.update(&block);
            block = mac.finish();
            for (slot, byte) in accumulator.iter_mut().zip(block.iter()) {
                *slot ^= *byte;
            }
        }
        let take = size.min(keylen - out.len());
        out.extend_from_slice(&accumulator[..take]);
        index += 1;
    }
    out
}

/// `HKDF(alg, ikm, salt, info, length)` — extract then expand, RFC 5869 §2.
///
/// Returns `None` when `length` exceeds the `255 * HashLen` the construction
/// allows; Node reports that as `ERR_CRYPTO_INVALID_KEYLEN`.
pub(crate) fn hkdf(
    alg: Alg,
    ikm: &[u8],
    salt: &[u8],
    info: &[u8],
    length: usize,
) -> Option<Vec<u8>> {
    let size = alg.output_size();
    if length > size * 255 {
        return None;
    }
    // Extract: PRK = HMAC(salt, ikm). An absent salt is HashLen zero bytes,
    // which is exactly what an empty key pads to, so no special case.
    let mut extract = Mac::new(alg, salt);
    extract.update(ikm);
    let prk = extract.finish();

    // Expand: T(n) = HMAC(PRK, T(n-1) || info || n)
    let prf = Mac::new(alg, &prk);
    let mut out = Vec::with_capacity(length);
    let mut previous: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while out.len() < length {
        let mut mac = prf.clone();
        mac.update(&previous);
        mac.update(info);
        mac.update(&[counter]);
        previous = mac.finish();
        let take = size.min(length - out.len());
        out.extend_from_slice(&previous[..take]);
        counter = counter.wrapping_add(1);
    }
    Some(out)
}

/// `scrypt(password, salt, N, r, p, dkLen)`.
///
/// `N` is passed as its base-2 logarithm by the `scrypt` crate's `Params`, so
/// a non-power-of-two `N` (which Node rejects with
/// `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`) is reported as `None` here too, as is
/// any parameter combination the crate refuses.
pub(crate) fn scrypt(
    password: &[u8],
    salt: &[u8],
    n: u64,
    r: u32,
    p: u32,
    keylen: usize,
) -> Option<Vec<u8>> {
    if n < 2 || !n.is_power_of_two() || r == 0 || p == 0 || keylen == 0 {
        return None;
    }
    let log_n = n.trailing_zeros();
    if log_n > u8::MAX as u32 {
        return None;
    }
    let params = scrypt::Params::new(log_n as u8, r, p, keylen).ok()?;
    let mut out = vec![0u8; keylen];
    scrypt::scrypt(password, salt, &params, &mut out).ok()?;
    Some(out)
}

//! HMAC (RFC 2104), over the one `DynDigest` handle the [`super::hash`] table
//! already provides.
//!
//! This is deliberately not the `hmac` crate. `Hmac<D>` is a distinct *type*
//! per digest, so a handle table holding one would need either a variant per
//! algorithm or a second object-safe trait of its own — and HMAC itself is the
//! three lines below, with the only algorithm-specific fact (the block size
//! `B`) already on [`Alg`]. The result is checked against RFC 4231's test
//! vectors in `tests.rs`.

use super::hash::{Alg, Hasher};

/// A live HMAC state. The inner hash has already absorbed `K' ^ ipad`; the
/// outer pad is kept so [`Mac::finish`] can run the second hash.
pub(crate) struct Mac {
    alg: Alg,
    inner: Hasher,
    opad: Vec<u8>,
}

impl Clone for Mac {
    fn clone(&self) -> Mac {
        Mac {
            alg: self.alg,
            inner: self.inner.clone(),
            opad: self.opad.clone(),
        }
    }
}

impl Mac {
    /// `HMAC(K, ·)`: a key longer than the block size is replaced by its own
    /// digest, a shorter one is zero-padded (RFC 2104 §2).
    ///
    /// An empty key is legal and is what Node's `createHmac(alg, '')` does —
    /// OpenSSL pads it to a block of zeros like any other short key.
    pub(crate) fn new(alg: Alg, key: &[u8]) -> Mac {
        let block = alg.block_size();
        let mut padded = if key.len() > block {
            alg.digest(key)
        } else {
            key.to_vec()
        };
        padded.resize(block, 0);

        let mut ipad = padded.clone();
        let mut opad = padded;
        for byte in ipad.iter_mut() {
            *byte ^= 0x36;
        }
        for byte in opad.iter_mut() {
            *byte ^= 0x5c;
        }

        let mut inner = Hasher::new(alg);
        inner.update(&ipad);
        Mac { alg, inner, opad }
    }

    pub(crate) fn update(&mut self, data: &[u8]) {
        self.inner.update(data);
    }

    /// `H(K' ^ opad || H(K' ^ ipad || message))`, as a clone of this state so
    /// that the handle stays usable (Node marks the JS object finalized
    /// instead of destroying the context).
    pub(crate) fn finish(&self) -> Vec<u8> {
        let size = self.alg.output_size();
        let inner = self.inner.finish(size);
        let mut outer = Hasher::new(self.alg);
        outer.update(&self.opad);
        outer.update(&inner);
        outer.finish(size)
    }
}

// ---------------------------------------------------------------------------
// KMAC (NIST SP 800-185 §4), for WebCrypto's `KMAC128` / `KMAC256`.
// ---------------------------------------------------------------------------

fn left_encode(value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let skip = bytes.iter().position(|b| *b != 0).unwrap_or(7);
    let mut out = vec![(8 - skip) as u8];
    out.extend_from_slice(&bytes[skip..]);
    out
}

fn right_encode(value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let skip = bytes.iter().position(|b| *b != 0).unwrap_or(7);
    let mut out = bytes[skip..].to_vec();
    out.push((8 - skip) as u8);
    out
}

/// `KMAC128/256(K, X, L, S)`; `wide` selects KMAC256. `length` is in bytes.
pub(crate) fn kmac(wide: bool, key: &[u8], data: &[u8], length: usize, custom: &[u8]) -> Vec<u8> {
    use digest::{ExtendableOutput, Update, XofReader};
    let rate: usize = if wide { 136 } else { 168 };
    // bytepad(encode_string(K), rate)
    let mut padded = left_encode(rate as u64);
    padded.extend(left_encode((key.len() as u64) * 8));
    padded.extend_from_slice(key);
    while padded.len() % rate != 0 {
        padded.push(0);
    }
    let tail = right_encode((length as u64) * 8);
    let mut out = vec![0u8; length];
    if wide {
        let mut h = sha3::CShake256::from_core(sha3::CShake256Core::new_with_function_name(b"KMAC", custom));
        h.update(&padded);
        h.update(data);
        h.update(&tail);
        h.finalize_xof().read(&mut out);
    } else {
        let mut h = sha3::CShake128::from_core(sha3::CShake128Core::new_with_function_name(b"KMAC", custom));
        h.update(&padded);
        h.update(data);
        h.update(&tail);
        h.finalize_xof().read(&mut out);
    }
    out
}

#[cfg(test)]
mod kmac_tests {
    fn hex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    /// NIST SP 800-185 KMAC sample #1 and #4.
    #[test]
    fn nist_samples() {
        let key: Vec<u8> = (0x40u8..=0x5f).collect();
        let data = hex("00010203");
        assert_eq!(
            super::kmac(false, &key, &data, 32, b""),
            hex("e5780b0d3ea6f7d3a429c5706aa43a00fadbd7d49628839e3187243f456ee14e")
        );
        assert_eq!(
            super::kmac(true, &key, &data, 64, b"My Tagged Application"),
            hex("20c570c31346f703c9ac36c61c03cb64c3970d0cfc787e9b79599d273a68d2f7f69d4cc3de9d104a351689f27cf6f5951f0103f33f4f24871024d9c27773a8dd")
        );
    }
}

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

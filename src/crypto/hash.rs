//! The digest algorithms behind `crypto.createHash`, `crypto.hash` and every
//! HMAC/KDF in this module.
//!
//! One enum names the algorithms, and everything else dispatches through it.
//! The fixed-output digests are held as `Box<dyn DynDigest>` — the object-safe
//! half of the `digest` crate's trait set — so the handle table in
//! `super::mod` stores *one* type rather than one per algorithm, which is the
//! whole reason `md-5`/`sha1`/`sha2`/`sha3`/`ripemd`/`blake2` were taken from
//! RustCrypto instead of each being wrapped by hand (see `../../Cargo.toml`).
//!
//! The two XOFs (`shake128`, `shake256`) cannot ride that trait: their output
//! length is a parameter, not a property of the algorithm, which is exactly
//! what Node's `options.outputLength` exposes. They are separate variants of
//! [`Hasher`] and squeeze as many bytes as asked for.

use digest::{DynDigest, ExtendableOutput, Update, XofReader};

/// Every digest `crypto.getHashes()` reports here, by its OpenSSL name.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Alg {
    Md5,
    Sha1,
    Sha224,
    Sha256,
    Sha384,
    Sha512,
    Sha512_224,
    Sha512_256,
    Sha3_224,
    Sha3_256,
    Sha3_384,
    Sha3_512,
    Ripemd160,
    Blake2b512,
    Blake2s256,
    Shake128,
    Shake256,
}

/// One row of the name table: an accepted spelling and what it resolves to.
///
/// The aliases are OpenSSL's own. `EVP_get_digestbyname` resolves a digest's
/// long name, its short name and the `RSA-*` / `*WithRSAEncryption` signature
/// algorithm names to the same digest, and Node's `createHash` is that lookup,
/// so `createHash('RSA-SHA1')` and `createHash('sha1')` are the same hash.
/// Matching is case-insensitive, as OpenSSL's is.
const NAMES: &[(&str, Alg)] = &[
    ("blake2b512", Alg::Blake2b512),
    ("blake2s256", Alg::Blake2s256),
    ("md5", Alg::Md5),
    ("md5withrsaencryption", Alg::Md5),
    ("rsa-md5", Alg::Md5),
    ("rsa-ripemd160", Alg::Ripemd160),
    ("rsa-sha1", Alg::Sha1),
    ("rsa-sha224", Alg::Sha224),
    ("rsa-sha256", Alg::Sha256),
    ("rsa-sha3-224", Alg::Sha3_224),
    ("rsa-sha3-256", Alg::Sha3_256),
    ("rsa-sha3-384", Alg::Sha3_384),
    ("rsa-sha3-512", Alg::Sha3_512),
    ("rsa-sha384", Alg::Sha384),
    ("rsa-sha512", Alg::Sha512),
    ("rsa-sha512/224", Alg::Sha512_224),
    ("rsa-sha512/256", Alg::Sha512_256),
    ("ripemd", Alg::Ripemd160),
    ("ripemd160", Alg::Ripemd160),
    ("ripemd160withrsa", Alg::Ripemd160),
    ("rmd160", Alg::Ripemd160),
    ("sha1", Alg::Sha1),
    ("sha1withrsaencryption", Alg::Sha1),
    ("sha224", Alg::Sha224),
    ("sha224withrsaencryption", Alg::Sha224),
    ("sha256", Alg::Sha256),
    ("sha256withrsaencryption", Alg::Sha256),
    ("sha3-224", Alg::Sha3_224),
    ("sha3-256", Alg::Sha3_256),
    ("sha3-384", Alg::Sha3_384),
    ("sha3-512", Alg::Sha3_512),
    ("sha384", Alg::Sha384),
    ("sha384withrsaencryption", Alg::Sha384),
    ("sha512", Alg::Sha512),
    ("sha512-224", Alg::Sha512_224),
    ("sha512-224withrsaencryption", Alg::Sha512_224),
    ("sha512-256", Alg::Sha512_256),
    ("sha512-256withrsaencryption", Alg::Sha512_256),
    ("sha512withrsaencryption", Alg::Sha512),
    ("shake128", Alg::Shake128),
    ("shake256", Alg::Shake256),
    ("ssl3-md5", Alg::Md5),
    ("ssl3-sha1", Alg::Sha1),
];

/// The names `crypto.getHashes()` answers, in the order Node's — that is,
/// JavaScript's default `Array#sort` — ordering puts them: UTF-16 code unit
/// order, so every capitalised alias precedes every lowercase one.
///
/// `test-crypto.js` asserts the list is sorted, free of duplicates and that
/// `RSA-SHA1` is in it while `rsa-sha1` is not, which is this exact shape.
pub(crate) const HASH_NAMES: &[&str] = &[
    "RSA-MD5",
    "RSA-RIPEMD160",
    "RSA-SHA1",
    "RSA-SHA224",
    "RSA-SHA256",
    "RSA-SHA3-224",
    "RSA-SHA3-256",
    "RSA-SHA3-384",
    "RSA-SHA3-512",
    "RSA-SHA384",
    "RSA-SHA512",
    "RSA-SHA512/224",
    "RSA-SHA512/256",
    "blake2b512",
    "blake2s256",
    "md5",
    "md5WithRSAEncryption",
    "ripemd",
    "ripemd160",
    "ripemd160WithRSA",
    "rmd160",
    "sha1",
    "sha1WithRSAEncryption",
    "sha224",
    "sha224WithRSAEncryption",
    "sha256",
    "sha256WithRSAEncryption",
    "sha3-224",
    "sha3-256",
    "sha3-384",
    "sha3-512",
    "sha384",
    "sha384WithRSAEncryption",
    "sha512",
    "sha512-224",
    "sha512-224WithRSAEncryption",
    "sha512-256",
    "sha512-256WithRSAEncryption",
    "sha512WithRSAEncryption",
    "shake128",
    "shake256",
    "ssl3-md5",
    "ssl3-sha1",
];

impl Alg {
    /// Resolve an OpenSSL digest name, case-insensitively.
    pub(crate) fn resolve(name: &str) -> Option<Alg> {
        let lowered = name.to_ascii_lowercase();
        NAMES
            .iter()
            .find(|(candidate, _)| *candidate == lowered.as_str())
            .map(|(_, alg)| *alg)
    }

    /// Is this an extendable-output function? Only an XOF accepts an
    /// `options.outputLength` other than its own digest size.
    pub(crate) fn is_xof(self) -> bool {
        matches!(self, Alg::Shake128 | Alg::Shake256)
    }

    /// The digest size in bytes. For an XOF this is the *default* output
    /// length, which is what OpenSSL (and so Node) produces when
    /// `options.outputLength` is absent: half the security strength, 16 bytes
    /// for SHAKE128 and 32 for SHAKE256.
    pub(crate) fn output_size(self) -> usize {
        match self {
            Alg::Md5 => 16,
            Alg::Sha1 | Alg::Ripemd160 => 20,
            Alg::Sha224 | Alg::Sha512_224 | Alg::Sha3_224 => 28,
            Alg::Sha256 | Alg::Sha512_256 | Alg::Sha3_256 | Alg::Blake2s256 => 32,
            Alg::Sha384 | Alg::Sha3_384 => 48,
            Alg::Sha512 | Alg::Sha3_512 | Alg::Blake2b512 => 64,
            Alg::Shake128 => 16,
            Alg::Shake256 => 32,
        }
    }

    /// The compression-function block size in bytes, which is the one fact
    /// HMAC needs beyond the digest itself (RFC 2104's `B`). For Keccak this
    /// is the sponge *rate*, which is what OpenSSL's HMAC uses.
    pub(crate) fn block_size(self) -> usize {
        match self {
            Alg::Md5 | Alg::Sha1 | Alg::Sha224 | Alg::Sha256 | Alg::Ripemd160 | Alg::Blake2s256 => {
                64
            }
            Alg::Sha384 | Alg::Sha512 | Alg::Sha512_224 | Alg::Sha512_256 | Alg::Blake2b512 => 128,
            Alg::Sha3_224 => 144,
            Alg::Sha3_256 => 136,
            Alg::Sha3_384 => 104,
            Alg::Sha3_512 => 72,
            Alg::Shake128 => 168,
            Alg::Shake256 => 136,
        }
    }

    /// A fresh fixed-output hasher, or `None` for an XOF (which has no fixed
    /// output and so cannot implement `DynDigest`).
    pub(crate) fn new_digest(self) -> Option<Box<dyn DynDigest>> {
        Some(match self {
            Alg::Md5 => Box::<md5::Md5>::default(),
            Alg::Sha1 => Box::<sha1::Sha1>::default(),
            Alg::Sha224 => Box::<sha2::Sha224>::default(),
            Alg::Sha256 => Box::<sha2::Sha256>::default(),
            Alg::Sha384 => Box::<sha2::Sha384>::default(),
            Alg::Sha512 => Box::<sha2::Sha512>::default(),
            Alg::Sha512_224 => Box::<sha2::Sha512_224>::default(),
            Alg::Sha512_256 => Box::<sha2::Sha512_256>::default(),
            Alg::Sha3_224 => Box::<sha3::Sha3_224>::default(),
            Alg::Sha3_256 => Box::<sha3::Sha3_256>::default(),
            Alg::Sha3_384 => Box::<sha3::Sha3_384>::default(),
            Alg::Sha3_512 => Box::<sha3::Sha3_512>::default(),
            Alg::Ripemd160 => Box::<ripemd::Ripemd160>::default(),
            Alg::Blake2b512 => Box::<blake2::Blake2b512>::default(),
            Alg::Blake2s256 => Box::<blake2::Blake2s256>::default(),
            Alg::Shake128 | Alg::Shake256 => return None,
        })
    }

    /// The one-shot digest of `data`, as `DynDigest` has no free function for
    /// it. Used by HMAC's key reduction and by `crypto.hash`.
    pub(crate) fn digest(self, data: &[u8]) -> Vec<u8> {
        let mut hasher = Hasher::new(self);
        hasher.update(data);
        hasher.finish(self.output_size())
    }
}

/// A live hashing state: a boxed fixed-output digest, or an XOF sponge.
pub(crate) enum Hasher {
    Fixed(Box<dyn DynDigest>),
    Shake128(sha3::Shake128),
    Shake256(sha3::Shake256),
}

impl Clone for Hasher {
    fn clone(&self) -> Hasher {
        match self {
            Hasher::Fixed(inner) => Hasher::Fixed(inner.box_clone()),
            Hasher::Shake128(inner) => Hasher::Shake128(inner.clone()),
            Hasher::Shake256(inner) => Hasher::Shake256(inner.clone()),
        }
    }
}

impl Hasher {
    pub(crate) fn new(alg: Alg) -> Hasher {
        match alg {
            Alg::Shake128 => Hasher::Shake128(sha3::Shake128::default()),
            Alg::Shake256 => Hasher::Shake256(sha3::Shake256::default()),
            // SAFETY of the `expect`: `new_digest` answers `None` only for the
            // two XOFs, both matched above.
            other => Hasher::Fixed(other.new_digest().expect("non-XOF digest")),
        }
    }

    pub(crate) fn update(&mut self, data: &[u8]) {
        match self {
            Hasher::Fixed(inner) => inner.update(data),
            Hasher::Shake128(inner) => Update::update(inner, data),
            Hasher::Shake256(inner) => Update::update(inner, data),
        }
    }

    /// Finalize a *clone* of this state into `length` bytes.
    ///
    /// Cloning rather than consuming is what lets `Hash.prototype.copy()` and
    /// `digest()` share one path: Node's `copy()` duplicates the EVP context,
    /// and its `digest()` finalizes one, after which the object is marked
    /// finalized in the JS layer rather than here.
    pub(crate) fn finish(&self, length: usize) -> Vec<u8> {
        let mut out = vec![0u8; length];
        match self {
            Hasher::Fixed(inner) => {
                let digested = inner.box_clone().finalize();
                let n = out.len().min(digested.len());
                out[..n].copy_from_slice(&digested[..n]);
            }
            Hasher::Shake128(inner) => inner.clone().finalize_xof().read(&mut out),
            Hasher::Shake256(inner) => inner.clone().finalize_xof().read(&mut out),
        }
        out
    }
}

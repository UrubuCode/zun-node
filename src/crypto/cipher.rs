//! The symmetric ciphers behind `crypto.createCipheriv` /
//! `crypto.createDecipheriv`: AES in ECB, CBC, CTR and GCM, plus ChaCha20 and
//! the ChaCha20-Poly1305 AEAD.
//!
//! # Why the modes are here and not taken from crates
//!
//! `aes` gives the AES block function; the modes are written out over it. The
//! reason is the handle table: `cbc::Encryptor<Aes128>` is a distinct *type*
//! per key size and per direction, so a table holding "a cipher" would need a
//! variant for each of the dozen combinations, and the mode logic itself is
//! short and fully pinned by Node's own vectors. The two parts that are *not*
//! short — the carry-less multiplication of GHASH and Poly1305 — come from
//! the `ghash` and `poly1305` crates.
//!
//! # Streaming
//!
//! Every mode here is incremental, including the AEADs, because Node's
//! `Cipheriv` is a `Transform` stream and `update()` must answer the bytes
//! that are ready. GCM is CTR plus GHASH and ChaCha20-Poly1305 is ChaCha20
//! plus Poly1305, so both decompose into a stream cipher (which never blocks)
//! and a universal hash (which only needs 16-byte blocks). The block modes
//! keep a partial block in [`Cipher::pending`], exactly as OpenSSL's
//! `EVP_EncryptUpdate` does.
//!
//! Decryption of an AEAD answers plaintext from `update()` *before* the tag is
//! checked, which is Node's documented behaviour too: the tag is verified in
//! `final()`, and until then the output is unauthenticated.
//!
//! # What is not here
//!
//! CCM, OCB, XTS, the key-wrap modes and the legacy block ciphers (DES,
//! Camellia, ARIA, SM4). `ciphers.rs` still *lists* them, because
//! `getCiphers()`/`getCipherInfo()` describe algorithms rather than
//! capability; `prepare` answers `Unsupported` for them and the TS layer
//! raises `ERR_CRYPTO_UNSUPPORTED_OPERATION`.

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, KeyIvInit, StreamCipher, StreamCipherSeek};
use ghash::universal_hash::UniversalHash;
use subtle::ConstantTimeEq;

use super::ciphers::{self, Spec};

/// Why a cipher could not be constructed.
#[derive(Debug)]
pub(crate) enum InitError {
    /// The name is not in the catalogue at all.
    UnknownCipher,
    /// The name is known but this extension has no implementation of it.
    Unsupported,
    InvalidKeyLength,
    InvalidIv,
    /// `options.authTagLength` is not one this AEAD accepts.
    InvalidAuthTagLength,
}

/// AES, boxed once per handle so that every mode below is one type.
enum BlockKey {
    Aes128(aes::Aes128),
    Aes192(aes::Aes192),
    Aes256(aes::Aes256),
}

impl BlockKey {
    fn new(key: &[u8]) -> Option<BlockKey> {
        Some(match key.len() {
            16 => BlockKey::Aes128(aes::Aes128::new_from_slice(key).ok()?),
            24 => BlockKey::Aes192(aes::Aes192::new_from_slice(key).ok()?),
            32 => BlockKey::Aes256(aes::Aes256::new_from_slice(key).ok()?),
            _ => return None,
        })
    }

    fn encrypt(&self, block: &mut [u8; 16]) {
        let block = aes::cipher::generic_array::GenericArray::from_mut_slice(block);
        match self {
            BlockKey::Aes128(key) => key.encrypt_block(block),
            BlockKey::Aes192(key) => key.encrypt_block(block),
            BlockKey::Aes256(key) => key.encrypt_block(block),
        }
    }

    fn decrypt(&self, block: &mut [u8; 16]) {
        let block = aes::cipher::generic_array::GenericArray::from_mut_slice(block);
        match self {
            BlockKey::Aes128(key) => key.decrypt_block(block),
            BlockKey::Aes192(key) => key.decrypt_block(block),
            BlockKey::Aes256(key) => key.decrypt_block(block),
        }
    }
}

/// A 128-bit counter-mode keystream over [`BlockKey`].
///
/// `wide` selects which part of the counter increments: AES-CTR counts the
/// whole 128-bit block (OpenSSL's `aes_ctr`), while GCM's `inc32` counts only
/// the last four bytes and leaves the 96-bit prefix alone (NIST SP 800-38D
/// §6.2).
struct Counter {
    block: [u8; 16],
    keystream: [u8; 16],
    used: usize,
    wide: bool,
}

impl Counter {
    fn new(block: [u8; 16], wide: bool) -> Counter {
        Counter {
            block,
            keystream: [0u8; 16],
            used: 16,
            wide,
        }
    }

    fn step(&mut self) {
        let from = if self.wide { 0 } else { 12 };
        for index in (from..16).rev() {
            self.block[index] = self.block[index].wrapping_add(1);
            if self.block[index] != 0 {
                break;
            }
        }
    }

    /// XOR `data` in place with the next `data.len()` keystream bytes.
    fn apply(&mut self, key: &BlockKey, data: &mut [u8]) {
        for byte in data.iter_mut() {
            if self.used == 16 {
                self.keystream = self.block;
                key.encrypt(&mut self.keystream);
                self.step();
                self.used = 0;
            }
            *byte ^= self.keystream[self.used];
            self.used += 1;
        }
    }
}

/// A universal hash fed in 16-byte blocks, buffering the partial one.
///
/// `UniversalHash::update_padded` zero-pads whatever it is given, so it may
/// only be called once per region; streaming therefore means holding back
/// fewer than 16 bytes until either a full block completes or the region ends.
struct Blocked<H: UniversalHash + Clone> {
    hash: H,
    pending: Vec<u8>,
}

impl<H: UniversalHash + Clone> Blocked<H> {
    fn new(hash: H) -> Blocked<H> {
        Blocked {
            hash,
            pending: Vec::with_capacity(16),
        }
    }

    fn update(&mut self, mut data: &[u8]) {
        if !self.pending.is_empty() {
            let take = (16 - self.pending.len()).min(data.len());
            self.pending.extend_from_slice(&data[..take]);
            data = &data[take..];
            if self.pending.len() < 16 {
                return;
            }
            let block = core::mem::take(&mut self.pending);
            self.hash.update_padded(&block);
            self.pending.reserve(16);
        }
        let whole = data.len() - data.len() % 16;
        if whole > 0 {
            self.hash.update_padded(&data[..whole]);
        }
        self.pending.extend_from_slice(&data[whole..]);
    }

    /// Close the current region: the partial block is zero-padded, as both
    /// GCM and RFC 8439 require between AAD and ciphertext.
    fn pad(&mut self) {
        if !self.pending.is_empty() {
            let block = core::mem::take(&mut self.pending);
            self.hash.update_padded(&block);
            self.pending.reserve(16);
        }
    }
}

/// AES-GCM state: CTR over `inc32(J0)` and GHASH over `A || C || lengths`.
struct Gcm {
    counter: Counter,
    ghash: Blocked<ghash::GHash>,
    /// `E(K, J0)`, which the tag is masked with.
    mask: [u8; 16],
    aad_bits: u64,
    data_bits: u64,
    /// Has the AAD region been zero-padded to a block boundary? GHASH runs
    /// over `A || pad || C || pad || lengths`, so the pad between the two
    /// regions has to happen exactly once, at the first ciphertext byte.
    aad_closed: bool,
    tag_length: usize,
}

/// ChaCha20-Poly1305 state (RFC 8439 §2.8).
struct ChaChaPoly {
    stream: chacha20::ChaCha20,
    poly: Blocked<poly1305::Poly1305>,
    aad_length: u64,
    data_length: u64,
    /// As [`Gcm::aad_closed`]: RFC 8439 pads the AAD to 16 bytes before the
    /// ciphertext region begins.
    aad_closed: bool,
    tag_length: usize,
}

/// The mode-specific half of a handle.
enum Mode {
    Ecb,
    Cbc { chain: [u8; 16] },
    Ctr(Counter),
    Gcm(Gcm),
    ChaChaPoly(ChaChaPoly),
    ChaCha20(chacha20::ChaCha20),
}

/// A live `Cipheriv`/`Decipheriv`.
pub(crate) struct Cipher {
    key: BlockKey,
    mode: Mode,
    encrypt: bool,
    /// Whether PKCS#7 padding is applied (encrypt) or stripped (decrypt).
    /// Only the block modes read it, which is also the only place Node's
    /// `setAutoPadding` has an effect.
    auto_padding: bool,
    /// The partial block the block modes are holding back.
    pending: Vec<u8>,
    /// The tag `setAuthTag` was given, for an AEAD decryption.
    expected_tag: Option<Vec<u8>>,
    /// The tag `final()` produced, for an AEAD encryption.
    produced_tag: Option<Vec<u8>>,
    /// Has any plaintext/ciphertext been written? `setAAD` is only legal
    /// before the first one, as in OpenSSL.
    started: bool,
}

/// What went wrong in `update` / `final`.
#[derive(Debug)]
pub(crate) enum Error {
    /// `final()` on a block mode whose input is not a whole number of blocks,
    /// or whose padding does not check out. Node reports the OpenSSL error.
    BadDecrypt,
    /// `final()` on a block-mode encryption with padding disabled and a
    /// partial block pending.
    WrongFinalBlockLength,
    /// An AEAD `final()` whose tag did not verify, or which had no tag.
    AuthFailed,
    /// `setAuthTag`/`getAuthTag`/`setAAD` on a non-AEAD cipher, or out of
    /// order.
    InvalidState,
}

/// A dummy IV for the modes that take none, so that one `prepare` signature
/// serves all of them.
const NO_IV: [u8; 16] = [0u8; 16];

fn iv16(iv: &[u8]) -> [u8; 16] {
    let mut out = NO_IV;
    out[..iv.len().min(16)].copy_from_slice(&iv[..iv.len().min(16)]);
    out
}

impl Cipher {
    /// Construct the cipher `name` names, in the direction `encrypt` asks for.
    ///
    /// `auth_tag_length` is `options.authTagLength` or `-1` for "not given".
    /// It is only meaningful for an AEAD: GCM takes 4, 8 or 12..=16 bytes (the
    /// set OpenSSL's `EVP_CTRL_AEAD_SET_TAG` accepts) and ChaCha20-Poly1305
    /// takes 16 only.
    pub(crate) fn prepare(
        name: &str,
        encrypt: bool,
        key: &[u8],
        iv: &[u8],
        auth_tag_length: i64,
    ) -> Result<Cipher, InitError> {
        let spec: &Spec = ciphers::by_name(name).ok_or(InitError::UnknownCipher)?;
        if key.len() as i64 != spec.key_length {
            return Err(InitError::InvalidKeyLength);
        }
        if spec.iv_length < 0 {
            if !iv.is_empty() {
                return Err(InitError::InvalidIv);
            }
        } else if !spec.accepts_iv(iv.len() as i64) {
            return Err(InitError::InvalidIv);
        }

        // Every cipher implemented here has a 16/24/32-byte key, so the AES
        // key schedule is always buildable -- including for the two ChaCha
        // modes, which keep their own key inside their state and simply never
        // read `self.key`.
        let block_key = BlockKey::new(key).ok_or(InitError::InvalidKeyLength)?;

        // Dispatch on the *canonical* name, not the one the caller spelled:
        // `aes256` is OpenSSL's alias for `aes-256-cbc` and `aes-256-gcm`
        // canonicalises to `id-aes256-gcm`, so a name-prefix test would miss
        // both. `test-crypto-padding-aes256.js` is written against the first
        // of those spellings.
        let mode = match spec.mode {
            "ecb" if IMPLEMENTED.contains(&spec.canonical) => Mode::Ecb,
            "cbc" if IMPLEMENTED.contains(&spec.canonical) => Mode::Cbc { chain: iv16(iv) },
            "ctr" if IMPLEMENTED.contains(&spec.canonical) => {
                Mode::Ctr(Counter::new(iv16(iv), true))
            }
            "gcm" if IMPLEMENTED.contains(&spec.canonical) => {
                let tag_length = gcm_tag_length(auth_tag_length)?;
                Mode::Gcm(new_gcm(&block_key, iv, tag_length))
            }
            _ if spec.canonical == "chacha20-poly1305" => {
                let tag_length = match auth_tag_length {
                    -1 | 16 => 16,
                    _ => return Err(InitError::InvalidAuthTagLength),
                };
                Mode::ChaChaPoly(new_chacha_poly(key, iv, tag_length))
            }
            _ if spec.canonical == "chacha20" => Mode::ChaCha20(new_chacha20(key, iv)),
            _ => return Err(InitError::Unsupported),
        };

        Ok(Cipher {
            key: block_key,
            mode,
            encrypt,
            auto_padding: true,
            pending: Vec::new(),
            expected_tag: None,
            produced_tag: None,
            started: false,
        })
    }

    pub(crate) fn set_auto_padding(&mut self, on: bool) {
        self.auto_padding = on;
    }

    pub(crate) fn is_aead(&self) -> bool {
        matches!(self.mode, Mode::Gcm(_) | Mode::ChaChaPoly(_))
    }

    /// `cipher.setAAD(buffer)`. Legal only before the first data byte.
    pub(crate) fn set_aad(&mut self, aad: &[u8]) -> Result<(), Error> {
        if self.started {
            return Err(Error::InvalidState);
        }
        match &mut self.mode {
            Mode::Gcm(gcm) => {
                gcm.ghash.update(aad);
                gcm.aad_bits += (aad.len() as u64) * 8;
                Ok(())
            }
            Mode::ChaChaPoly(state) => {
                state.poly.update(aad);
                state.aad_length += aad.len() as u64;
                Ok(())
            }
            _ => Err(Error::InvalidState),
        }
    }

    /// `decipher.setAuthTag(buffer)`.
    pub(crate) fn set_auth_tag(&mut self, tag: &[u8]) -> Result<(), Error> {
        if self.encrypt || !self.is_aead() {
            return Err(Error::InvalidState);
        }
        self.expected_tag = Some(tag.to_vec());
        Ok(())
    }

    /// `cipher.getAuthTag()`, available only after `final()`.
    pub(crate) fn auth_tag(&self) -> Result<&[u8], Error> {
        match &self.produced_tag {
            Some(tag) => Ok(tag),
            None => Err(Error::InvalidState),
        }
    }

    /// The tag length this AEAD will produce, which `final()` needs before it
    /// has one. `0` for a non-AEAD.
    pub(crate) fn tag_length(&self) -> usize {
        match &self.mode {
            Mode::Gcm(gcm) => gcm.tag_length,
            Mode::ChaChaPoly(state) => state.tag_length,
            _ => 0,
        }
    }

    /// `cipher.update(data)` — the bytes that are ready now.
    pub(crate) fn update(&mut self, data: &[u8]) -> Vec<u8> {
        if !data.is_empty() {
            self.started = true;
        }
        if matches!(self.mode, Mode::Ecb | Mode::Cbc { .. }) {
            return self.update_blocks(data);
        }
        // Field-by-field borrows: the stream modes read the AES key while
        // holding their own state mutably, which is only disjoint if `key` and
        // `mode` are named separately.
        let encrypt = self.encrypt;
        let key = &self.key;
        match &mut self.mode {
            Mode::Ctr(counter) => {
                let mut out = data.to_vec();
                counter.apply(key, &mut out);
                out
            }
            Mode::Gcm(gcm) => {
                let mut out = data.to_vec();
                if !gcm.aad_closed && !out.is_empty() {
                    gcm.ghash.pad();
                    gcm.aad_closed = true;
                }
                // GHASH always runs over the *ciphertext*, which is the input
                // when decrypting and the output when encrypting.
                if !encrypt {
                    gcm.ghash.update(&out);
                }
                gcm.counter.apply(key, &mut out);
                if encrypt {
                    gcm.ghash.update(&out);
                }
                gcm.data_bits += (data.len() as u64) * 8;
                out
            }
            Mode::ChaChaPoly(state) => {
                let mut out = data.to_vec();
                if !state.aad_closed && !out.is_empty() {
                    state.poly.pad();
                    state.aad_closed = true;
                }
                if !encrypt {
                    state.poly.update(&out);
                }
                state.stream.apply_keystream(&mut out);
                if encrypt {
                    state.poly.update(&out);
                }
                state.data_length += data.len() as u64;
                out
            }
            Mode::ChaCha20(stream) => {
                let mut out = data.to_vec();
                stream.apply_keystream(&mut out);
                out
            }
            Mode::Ecb | Mode::Cbc { .. } => Vec::new(),
        }
    }

    /// ECB/CBC: consume whole blocks, hold the remainder.
    fn update_blocks(&mut self, data: &[u8]) -> Vec<u8> {
        self.pending.extend_from_slice(data);
        // A decryption with padding on must keep the last whole block back:
        // it may be the padding block, which `final()` strips. OpenSSL's
        // `EVP_DecryptUpdate` does exactly this.
        let take = if !self.encrypt && self.auto_padding {
            // Hold back at least one byte, so a whole-block input leaves its
            // last block for `final()` to unpad.
            self.pending.len().saturating_sub(1) / 16 * 16
        } else {
            self.pending.len() / 16 * 16
        };
        let mut out: Vec<u8> = self.pending.drain(..take).collect();
        for chunk in out.chunks_mut(16) {
            let mut block = [0u8; 16];
            block.copy_from_slice(chunk);
            self.transform_block(&mut block);
            chunk.copy_from_slice(&block);
        }
        out
    }

    fn transform_block(&mut self, block: &mut [u8; 16]) {
        match (&mut self.mode, self.encrypt) {
            (Mode::Ecb, true) => self.key.encrypt(block),
            (Mode::Ecb, false) => self.key.decrypt(block),
            (Mode::Cbc { chain }, true) => {
                for index in 0..16 {
                    block[index] ^= chain[index];
                }
                self.key.encrypt(block);
                *chain = *block;
            }
            (Mode::Cbc { chain }, false) => {
                let ciphertext = *block;
                self.key.decrypt(block);
                for index in 0..16 {
                    block[index] ^= chain[index];
                }
                *chain = ciphertext;
            }
            _ => {}
        }
    }

    /// `cipher.final()` — the padding block, or the tag check.
    pub(crate) fn finish(&mut self) -> Result<Vec<u8>, Error> {
        if matches!(self.mode, Mode::Ecb | Mode::Cbc { .. }) {
            return self.finish_blocks();
        }
        if self.is_aead() {
            return self.finish_aead();
        }
        Ok(Vec::new())
    }

    fn finish_blocks(&mut self) -> Result<Vec<u8>, Error> {
        if self.encrypt {
            if !self.auto_padding {
                return if self.pending.is_empty() {
                    Ok(Vec::new())
                } else {
                    Err(Error::WrongFinalBlockLength)
                };
            }
            // PKCS#7: always a block, even for an empty remainder.
            let padding = 16 - self.pending.len();
            let mut block = [0u8; 16];
            block[..self.pending.len()].copy_from_slice(&self.pending);
            for slot in block[self.pending.len()..].iter_mut() {
                *slot = padding as u8;
            }
            self.pending.clear();
            self.transform_block(&mut block);
            return Ok(block.to_vec());
        }

        if self.pending.is_empty() {
            // Decrypting nothing is only legal with padding off; OpenSSL
            // reports "wrong final block length" otherwise.
            return if self.auto_padding {
                Err(Error::BadDecrypt)
            } else {
                Ok(Vec::new())
            };
        }
        if self.pending.len() != 16 {
            return Err(Error::BadDecrypt);
        }
        let mut block = [0u8; 16];
        block.copy_from_slice(&self.pending);
        self.pending.clear();
        self.transform_block(&mut block);
        if !self.auto_padding {
            return Ok(block.to_vec());
        }
        let padding = block[15] as usize;
        if padding == 0 || padding > 16 {
            return Err(Error::BadDecrypt);
        }
        if block[16 - padding..].iter().any(|byte| *byte as usize != padding) {
            return Err(Error::BadDecrypt);
        }
        Ok(block[..16 - padding].to_vec())
    }

    fn finish_aead(&mut self) -> Result<Vec<u8>, Error> {
        let tag = match &mut self.mode {
            Mode::Gcm(gcm) => {
                gcm.ghash.pad();
                let mut lengths = [0u8; 16];
                lengths[..8].copy_from_slice(&gcm.aad_bits.to_be_bytes());
                lengths[8..].copy_from_slice(&gcm.data_bits.to_be_bytes());
                gcm.ghash.hash.update_padded(&lengths);
                let digest = gcm.ghash.hash.clone().finalize();
                let mut tag = [0u8; 16];
                for index in 0..16 {
                    tag[index] = digest[index] ^ gcm.mask[index];
                }
                tag[..gcm.tag_length].to_vec()
            }
            Mode::ChaChaPoly(state) => {
                state.poly.pad();
                let mut lengths = [0u8; 16];
                lengths[..8].copy_from_slice(&state.aad_length.to_le_bytes());
                lengths[8..].copy_from_slice(&state.data_length.to_le_bytes());
                state.poly.hash.update_padded(&lengths);
                let digest = state.poly.hash.clone().finalize();
                digest[..state.tag_length].to_vec()
            }
            _ => return Err(Error::InvalidState),
        };

        if self.encrypt {
            self.produced_tag = Some(tag);
            return Ok(Vec::new());
        }
        let expected = self.expected_tag.as_ref().ok_or(Error::AuthFailed)?;
        // The comparison is length-first and then constant-time: a tag of the
        // wrong length is a mismatch, and one of the right length must not
        // leak where it differs.
        let n = expected.len().min(tag.len());
        if expected.len() != n || tag.len() != n || !bool::from(tag[..n].ct_eq(&expected[..n])) {
            return Err(Error::AuthFailed);
        }
        Ok(Vec::new())
    }
}

/// The canonical names `prepare` can actually construct. Everything else in
/// the catalogue is metadata only (see the module documentation), and the
/// composite `aes-128-cbc-hmac-sha1` is deliberately absent: it is a TLS
/// record cipher rather than a CBC mode.
const IMPLEMENTED: &[&str] = &[
    "aes-128-ecb",
    "aes-192-ecb",
    "aes-256-ecb",
    "aes-128-cbc",
    "aes-192-cbc",
    "aes-256-cbc",
    "aes-128-ctr",
    "aes-192-ctr",
    "aes-256-ctr",
    "id-aes128-gcm",
    "id-aes192-gcm",
    "id-aes256-gcm",
];

/// The GCM tag lengths OpenSSL accepts, which is what Node validates against.
fn gcm_tag_length(requested: i64) -> Result<usize, InitError> {
    match requested {
        -1 => Ok(16),
        4 | 8 | 12 | 13 | 14 | 15 | 16 => Ok(requested as usize),
        _ => Err(InitError::InvalidAuthTagLength),
    }
}

/// NIST SP 800-38D §7: derive `H`, `J0` and the tag mask from the key and IV.
fn new_gcm(key: &BlockKey, iv: &[u8], tag_length: usize) -> Gcm {
    let mut subkey = [0u8; 16];
    key.encrypt(&mut subkey);
    let hash = ghash::GHash::new(&subkey.into());

    // A 96-bit IV is used as is; any other length is folded through GHASH.
    let j0 = if iv.len() == 12 {
        let mut block = [0u8; 16];
        block[..12].copy_from_slice(iv);
        block[15] = 1;
        block
    } else {
        let mut folding = Blocked::new(ghash::GHash::new(&subkey.into()));
        folding.update(iv);
        folding.pad();
        let mut lengths = [0u8; 16];
        lengths[8..].copy_from_slice(&((iv.len() as u64) * 8).to_be_bytes());
        folding.hash.update_padded(&lengths);
        let digest = folding.hash.finalize();
        let mut block = [0u8; 16];
        block.copy_from_slice(&digest);
        block
    };

    let mut mask = j0;
    key.encrypt(&mut mask);
    let mut counter = Counter::new(j0, false);
    counter.step();

    Gcm {
        counter,
        ghash: Blocked::new(hash),
        mask,
        aad_bits: 0,
        data_bits: 0,
        aad_closed: false,
        tag_length,
    }
}

/// RFC 8439 §2.8: the Poly1305 one-time key is the first ChaCha20 block of
/// counter 0, and the payload keystream starts at counter 1.
fn new_chacha_poly(key: &[u8], iv: &[u8], tag_length: usize) -> ChaChaPoly {
    let mut block = [0u8; 64];
    let mut zeroth = chacha20::ChaCha20::new_from_slices(key, iv).expect("validated key/iv");
    zeroth.apply_keystream(&mut block);
    let mut poly_key = [0u8; 32];
    poly_key.copy_from_slice(&block[..32]);

    let mut stream = chacha20::ChaCha20::new_from_slices(key, iv).expect("validated key/iv");
    stream.seek(64u64);

    ChaChaPoly {
        stream,
        poly: Blocked::new(poly1305::Poly1305::new(&poly_key.into())),
        aad_length: 0,
        data_length: 0,
        aad_closed: false,
        tag_length,
    }
}

/// OpenSSL's bare `chacha20` takes a 16-byte IV: a 4-byte little-endian
/// initial counter followed by the 12-byte nonce.
fn new_chacha20(key: &[u8], iv: &[u8]) -> chacha20::ChaCha20 {
    let counter = u32::from_le_bytes([iv[0], iv[1], iv[2], iv[3]]);
    let mut stream =
        chacha20::ChaCha20::new_from_slices(key, &iv[4..16]).expect("validated key/iv");
    stream.seek(u64::from(counter) * 64);
    stream
}

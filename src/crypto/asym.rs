//! The asymmetric half of `node:crypto`: key import/export, key generation,
//! signatures, RSA encryption, ECDH and classic (finite-field)
//! Diffie-Hellman.
//!
//! # How a key crosses the boundary
//!
//! There is no key handle table. A key is always carried by the TS layer as
//! one canonical DER document, base64 like every other byte string here:
//!
//! - a **private** key is PKCS#8 (`PrivateKeyInfo`),
//! - a **public** key is SPKI (`SubjectPublicKeyInfo`).
//!
//! Every native below takes that document and parses it again. Parsing a DER
//! key is cheap next to the operation that follows it, and a stateless key
//! means a `KeyObject` needs no `free`, no finaliser and no lifetime rules:
//! it is a value, exactly as Node's `KeyObject` behaves from JS.
//!
//! All the other encodings Node accepts (PEM in any of its labels, PKCS#1,
//! SEC1, encrypted PKCS#8, RFC 1421 encrypted PEM, JWK) are converted to the
//! canonical form on import and from it on export.
//!
//! # Algorithms
//!
//! RSA (PKCS#1 v1.5 and PSS signatures; PKCS#1 v1.5, OAEP and raw
//! encryption), ECDSA and ECDH over `prime256v1`, `secp384r1` and `secp256k1`,
//! Ed25519 and X25519. RSA-PSS-restricted keys, DSA, X448/Ed448 and the
//! post-quantum families are not implemented and answer
//! `ERR_CRYPTO_UNSUPPORTED_OPERATION`-shaped errors.
//!
//! Failure is reported in band, with the `(code, message)` convention
//! `mod.rs` documents.

use num_bigint_dig::{BigUint, RandBigInt, RandPrime};
use rand_core::{OsRng, RngCore};
use rsa::pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey, EncodeRsaPrivateKey, EncodeRsaPublicKey};
use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use rsa::traits::{PrivateKeyParts, PublicKeyParts};
use rsa::{Oaep, Pkcs1v15Encrypt, Pkcs1v15Sign, Pss, RsaPrivateKey, RsaPublicKey};
use zun_abi::ZunValue;

use super::ff::{self, DsaParams};
use super::hash::Alg;
use super::{fail, US};
use crate::abi::{arg_bool, arg_i64, arg_str, ret_str};
use crate::fs::base64;

type Res<T> = Result<T, String>;

fn err<T>(code: &str, message: &str) -> Res<T> {
    Err(fail(code, message))
}

fn unsupported<T>() -> Res<T> {
    err("ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation")
}

fn invalid_key<T>() -> Res<T> {
    err(
        "ERR_OSSL_UNSUPPORTED",
        "error:1E08010C:DECODER routines::unsupported",
    )
}

/// The arguments of one native call.
struct Args {
    args: *const ZunValue,
    n: usize,
}

impl Args {
    fn s(&self, i: usize) -> Res<String> {
        match unsafe { arg_str(self.args, self.n, i) } {
            Ok(text) => Ok(text.to_owned()),
            Err(_) => err("ERR_INVALID_ARG_TYPE", "invalid native argument"),
        }
    }
    fn bytes(&self, i: usize) -> Res<Vec<u8>> {
        Ok(base64::decode(&self.s(i)?))
    }
    fn i(&self, i: usize) -> i64 {
        unsafe { arg_i64(self.args, self.n, i) }
    }
    fn b(&self, i: usize) -> bool {
        unsafe { arg_bool(self.args, self.n, i) }
    }
}

macro_rules! native {
    ($(#[$meta:meta])* $name:ident, |$a:ident| $body:block) => {
        $(#[$meta])*
        pub(crate) unsafe extern "C" fn $name(
            args: *const ZunValue,
            n: usize,
            out: *mut ZunValue,
        ) -> i32 {
            let $a = Args { args, n };
            let run = || -> Res<String> { $body };
            let payload = match run() {
                Ok(text) => text,
                Err(failure) => failure,
            };
            unsafe { ret_str(out, &payload) }
        }
    };
}

fn ok_fields(fields: &[String]) -> Res<String> {
    let mut out = String::from("+");
    for (i, field) in fields.iter().enumerate() {
        if i > 0 {
            out.push(US);
        }
        out.push_str(field);
    }
    Ok(out)
}

fn b64(bytes: &[u8]) -> String {
    base64::encode(bytes)
}

// ---------------------------------------------------------------------------
// Digests, `Send + Sync` for the `rsa` padding schemes
// ---------------------------------------------------------------------------

type BoxDigest = Box<dyn digest::DynDigest + Send + Sync>;

fn dyn_digest(alg: Alg) -> Option<BoxDigest> {
    Some(match alg {
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
        _ => return None,
    })
}

/// The DER `DigestInfo` prefix PKCS#1 v1.5 signatures carry (RFC 8017
/// §9.2, note 1), keyed by digest.
fn digest_info_prefix(alg: Alg) -> Option<Vec<u8>> {
    Some(match alg {
        Alg::Md5 => vec![
            0x30, 0x20, 0x30, 0x0c, 0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x05,
            0x05, 0x00, 0x04, 0x10,
        ],
        Alg::Sha1 => vec![
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04,
            0x14,
        ],
        Alg::Ripemd160 => vec![
            0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x24, 0x03, 0x02, 0x01, 0x05, 0x00, 0x04,
            0x14,
        ],
        Alg::Sha224 => sha2_prefix::<0x04, 0x1c>().to_vec(),
        Alg::Sha256 => sha2_prefix::<0x01, 0x20>().to_vec(),
        Alg::Sha384 => sha2_prefix::<0x02, 0x30>().to_vec(),
        Alg::Sha512 => sha2_prefix::<0x03, 0x40>().to_vec(),
        Alg::Sha512_224 => sha2_prefix::<0x05, 0x1c>().to_vec(),
        Alg::Sha512_256 => sha2_prefix::<0x06, 0x20>().to_vec(),
        Alg::Sha3_224 => sha2_prefix::<0x07, 0x1c>().to_vec(),
        Alg::Sha3_256 => sha2_prefix::<0x08, 0x20>().to_vec(),
        Alg::Sha3_384 => sha2_prefix::<0x09, 0x30>().to_vec(),
        Alg::Sha3_512 => sha2_prefix::<0x0a, 0x40>().to_vec(),
        _ => return None,
    })
}

/// The `DigestInfo` prefix of a digest under the NIST hash arc
/// `2.16.840.1.101.3.4.2.<id>`.
const fn sha2_prefix<const ID: u8, const LEN: u8>() -> [u8; 19] {
    [
        0x30,
        0x0d + 0x04 + LEN,
        0x30,
        0x0d,
        0x06,
        0x09,
        0x60,
        0x86,
        0x48,
        0x01,
        0x65,
        0x03,
        0x04,
        0x02,
        ID,
        0x05,
        0x00,
        0x04,
        LEN,
    ]
}

/// Resolve a signature digest name; `""` means "none given".
fn sig_digest(name: &str) -> Res<Option<Alg>> {
    if name.is_empty() {
        return Ok(None);
    }
    match Alg::resolve(name) {
        Some(alg) if !alg.is_xof() => Ok(Some(alg)),
        _ => err("ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest"),
    }
}

// ---------------------------------------------------------------------------
// Elliptic curves
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Crv {
    P256,
    P384,
    P521,
    K256,
}

const OID_RSA: &str = "1.2.840.113549.1.1.1";
const OID_EC: &str = "1.2.840.10045.2.1";
const OID_ED25519: &str = "1.3.101.112";
const OID_X25519: &str = "1.3.101.110";
const OID_X448: &str = "1.3.101.111";
const OID_ED448: &str = "1.3.101.113";
const OID_DSA: &str = "1.2.840.10040.4.1";
const OID_DH: &str = "1.2.840.113549.1.3.1";

impl Crv {
    fn from_name(name: &str) -> Option<Crv> {
        match name {
            "prime256v1" | "P-256" | "secp256r1" => Some(Crv::P256),
            "secp384r1" | "P-384" => Some(Crv::P384),
            "secp521r1" | "P-521" => Some(Crv::P521),
            "secp256k1" => Some(Crv::K256),
            _ => None,
        }
    }
    fn from_oid(oid: &str) -> Option<Crv> {
        match oid {
            "1.2.840.10045.3.1.7" => Some(Crv::P256),
            "1.3.132.0.34" => Some(Crv::P384),
            "1.3.132.0.35" => Some(Crv::P521),
            "1.3.132.0.10" => Some(Crv::K256),
            _ => None,
        }
    }
    /// The OpenSSL short name Node reports as `namedCurve`.
    fn name(self) -> &'static str {
        match self {
            Crv::P256 => "prime256v1",
            Crv::P384 => "secp384r1",
            Crv::P521 => "secp521r1",
            Crv::K256 => "secp256k1",
        }
    }
    /// The JWK `crv`.
    fn jwk(self) -> &'static str {
        match self {
            Crv::P256 => "P-256",
            Crv::P384 => "P-384",
            Crv::P521 => "P-521",
            Crv::K256 => "secp256k1",
        }
    }
    fn size(self) -> usize {
        match self {
            Crv::P256 | Crv::K256 => 32,
            Crv::P384 => 48,
            Crv::P521 => 66,
        }
    }
}

/// The per-curve operations, written once and instantiated per curve crate.
macro_rules! curve_ops {
    ($modname:ident, $krate:ident) => {
        mod $modname {
            use super::Res;
            use $krate::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
            use $krate::ecdsa::{Signature, SigningKey, VerifyingKey};
            use $krate::elliptic_curve::sec1::ToEncodedPoint;
            use $krate::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
            use $krate::{PublicKey, SecretKey};

            fn bad<T>() -> Res<T> {
                super::invalid_key()
            }

            pub(super) fn generate() -> Vec<u8> {
                SecretKey::random(&mut rand_core::OsRng).to_bytes().to_vec()
            }
            pub(super) fn secret(raw: &[u8]) -> Res<SecretKey> {
                SecretKey::from_slice(raw).or_else(|_| bad())
            }
            pub(super) fn check(raw: &[u8]) -> Res<()> {
                secret(raw).map(|_| ())
            }
            pub(super) fn check_point(bytes: &[u8]) -> Res<()> {
                point(bytes).map(|_| ())
            }
            pub(super) fn public_of(raw: &[u8], compressed: bool) -> Res<Vec<u8>> {
                Ok(secret(raw)?
                    .public_key()
                    .to_encoded_point(compressed)
                    .as_bytes()
                    .to_vec())
            }
            pub(super) fn point(bytes: &[u8]) -> Res<PublicKey> {
                PublicKey::from_sec1_bytes(bytes).or_else(|_| {
                    super::err(
                        "ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY",
                        "Public key is not valid for specified curve",
                    )
                })
            }
            pub(super) fn convert(bytes: &[u8], compressed: bool) -> Res<Vec<u8>> {
                Ok(point(bytes)?
                    .to_encoded_point(compressed)
                    .as_bytes()
                    .to_vec())
            }
            pub(super) fn ecdh(raw: &[u8], peer: &[u8]) -> Res<Vec<u8>> {
                let secret = secret(raw)?;
                let peer = point(peer)?;
                let shared = $krate::ecdh::diffie_hellman(secret.to_nonzero_scalar(), peer.as_affine());
                Ok(shared.raw_secret_bytes().to_vec())
            }
            pub(super) fn sign(raw: &[u8], prehash: &[u8], p1363: bool) -> Res<Vec<u8>> {
                let key = SigningKey::from_slice(raw).or_else(|_| bad())?;
                let sig: Signature = key
                    .sign_prehash(prehash)
                    .or_else(|_| super::err("ERR_OSSL_EVP_BAD_SIGNATURE", "bad signature"))?;
                Ok(if p1363 {
                    sig.to_bytes().to_vec()
                } else {
                    sig.to_der().as_bytes().to_vec()
                })
            }
            pub(super) fn verify(point_bytes: &[u8], prehash: &[u8], sig: &[u8], p1363: bool) -> bool {
                let Ok(key) = VerifyingKey::from_sec1_bytes(point_bytes) else {
                    return false;
                };
                let parsed = if p1363 {
                    Signature::from_slice(sig)
                } else {
                    Signature::from_der(sig)
                };
                let Ok(sig) = parsed else { return false };
                let sig = sig.normalize_s().unwrap_or(sig);
                key.verify_prehash(prehash, &sig).is_ok()
            }
            pub(super) fn to_pkcs8(raw: &[u8]) -> Res<Vec<u8>> {
                Ok(secret(raw)?
                    .to_pkcs8_der()
                    .or_else(|_| bad())?
                    .as_bytes()
                    .to_vec())
            }
            pub(super) fn from_pkcs8(der: &[u8]) -> Res<Vec<u8>> {
                Ok(SecretKey::from_pkcs8_der(der).or_else(|_| bad())?.to_bytes().to_vec())
            }
            pub(super) fn to_sec1(raw: &[u8]) -> Res<Vec<u8>> {
                Ok(secret(raw)?.to_sec1_der().or_else(|_| bad())?.to_vec())
            }
            pub(super) fn from_sec1(der: &[u8]) -> Res<Vec<u8>> {
                Ok(SecretKey::from_sec1_der(der).or_else(|_| bad())?.to_bytes().to_vec())
            }
            pub(super) fn to_spki(point_bytes: &[u8]) -> Res<Vec<u8>> {
                Ok(point(point_bytes)?
                    .to_public_key_der()
                    .or_else(|_| bad())?
                    .as_bytes()
                    .to_vec())
            }
            pub(super) fn from_spki(der: &[u8]) -> Res<Vec<u8>> {
                Ok(PublicKey::from_public_key_der(der)
                    .or_else(|_| bad())?
                    .to_encoded_point(false)
                    .as_bytes()
                    .to_vec())
            }
        }
    };
}

curve_ops!(c_p256, p256);
curve_ops!(c_p384, p384);
curve_ops!(c_p521, p521);
curve_ops!(c_k256, k256);

macro_rules! on_curve {
    ($crv:expr, $f:ident ( $($arg:expr),* )) => {
        match $crv {
            Crv::P256 => c_p256::$f($($arg),*),
            Crv::P384 => c_p384::$f($($arg),*),
            Crv::P521 => c_p521::$f($($arg),*),
            Crv::K256 => c_k256::$f($($arg),*),
        }
    };
}

// ---------------------------------------------------------------------------
// The parsed key
// ---------------------------------------------------------------------------

/// A private key, parsed from its PKCS#8 document.
enum Private {
    Rsa(Box<RsaPrivateKey>),
    /// An `id-RSASSA-PSS` key, restricted to PSS signatures.
    RsaPss(Box<RsaPrivateKey>, PssParams),
    /// The raw scalar, big-endian.
    Ec(Crv, Vec<u8>),
    Ed25519([u8; 32]),
    X25519([u8; 32]),
    Ed448([u8; 57]),
    X448([u8; 56]),
    /// Domain parameters and `x`.
    Dsa(Box<DsaParams>, BigUint),
    /// X9.42 / PKCS#3 `dhKeyAgreement`: `p`, `g` and `x`.
    Dh(BigUint, BigUint, BigUint),
}

/// A public key, parsed from its SPKI document.
enum Public {
    Rsa(Box<RsaPublicKey>),
    RsaPss(Box<RsaPublicKey>, PssParams),
    /// The uncompressed SEC1 point.
    Ec(Crv, Vec<u8>),
    Ed25519([u8; 32]),
    X25519([u8; 32]),
    Ed448([u8; 57]),
    X448([u8; 56]),
    /// Domain parameters and `y`.
    Dsa(Box<DsaParams>, BigUint),
    /// `p`, `g` and `y`.
    Dh(BigUint, BigUint, BigUint),
}

/// The `RSASSA-PSS-params` restriction of an `id-RSASSA-PSS` key (RFC 4055
/// §3.1). `None` throughout is an unrestricted key, written with no
/// parameters at all.
#[derive(Clone, Copy, Default)]
struct PssParams {
    hash: Option<Alg>,
    mgf1: Option<Alg>,
    salt: Option<u32>,
}

const OID_RSA_PSS: &str = "1.2.840.113549.1.1.10";
const OID_RSA_PSS_DER: &[u8] = &[0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0a];
const OID_MGF1_DER: &[u8] = &[0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x08];

fn hash_oid_der(alg: Alg) -> Option<Vec<u8>> {
    let tail: u8 = match alg {
        Alg::Sha1 => return Some(vec![0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a]),
        Alg::Sha256 => 1,
        Alg::Sha384 => 2,
        Alg::Sha512 => 3,
        Alg::Sha224 => 4,
        Alg::Sha512_224 => 5,
        Alg::Sha512_256 => 6,
        _ => return None,
    };
    Some(vec![0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, tail])
}

fn hash_from_oid_der(oid: &[u8]) -> Option<Alg> {
    [
        Alg::Sha1,
        Alg::Sha256,
        Alg::Sha384,
        Alg::Sha512,
        Alg::Sha224,
        Alg::Sha512_224,
        Alg::Sha512_256,
    ]
    .into_iter()
    .find(|alg| hash_oid_der(*alg).as_deref() == Some(oid))
}

/// The Node name of a digest, as `asymmetricKeyDetails` reports it.
fn hash_name(alg: Alg) -> &'static str {
    match alg {
        Alg::Sha1 => "sha1",
        Alg::Sha224 => "sha224",
        Alg::Sha256 => "sha256",
        Alg::Sha384 => "sha384",
        Alg::Sha512 => "sha512",
        Alg::Sha512_224 => "sha512-224",
        Alg::Sha512_256 => "sha512-256",
        _ => "",
    }
}

fn der_tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(der_len(body.len()));
    out.extend_from_slice(body);
    out
}

/// `AlgorithmIdentifier { hash, NULL }`.
fn hash_alg_id(alg: Alg) -> Vec<u8> {
    let mut body = hash_oid_der(alg).unwrap_or_default();
    body.extend_from_slice(&[0x05, 0x00]);
    der_tlv(0x30, &body)
}

impl PssParams {
    fn restricted(&self) -> bool {
        self.hash.is_some() || self.mgf1.is_some() || self.salt.is_some()
    }

    /// The key's `AlgorithmIdentifier`.
    fn alg_id(&self) -> Vec<u8> {
        let mut body = OID_RSA_PSS_DER.to_vec();
        if self.restricted() {
            let mut params = Vec::new();
            let hash = self.hash.unwrap_or(Alg::Sha1);
            if hash != Alg::Sha1 {
                params.extend(der_tlv(0xa0, &hash_alg_id(hash)));
            }
            let mgf1 = self.mgf1.unwrap_or(hash);
            if mgf1 != Alg::Sha1 {
                let mut mgf = OID_MGF1_DER.to_vec();
                mgf.extend(hash_alg_id(mgf1));
                params.extend(der_tlv(0xa1, &der_tlv(0x30, &mgf)));
            }
            let salt = self.salt.unwrap_or(20);
            if salt != 20 {
                let mut int = salt.to_be_bytes().to_vec();
                while int.len() > 1 && int[0] == 0 && int[1] & 0x80 == 0 {
                    int.remove(0);
                }
                if int[0] & 0x80 != 0 {
                    int.insert(0, 0);
                }
                params.extend(der_tlv(0xa2, &der_tlv(0x02, &int)));
            }
            body.extend(der_tlv(0x30, &params));
        }
        der_tlv(0x30, &body)
    }

    /// Parse the *content* of an `RSASSA-PSS-params` SEQUENCE.
    fn parse(content: &[u8]) -> PssParams {
        let mut out = PssParams {
            hash: Some(Alg::Sha1),
            mgf1: Some(Alg::Sha1),
            salt: Some(20),
        };
        let mut at = 0;
        while let Some((tag, start, end)) = tlv(content, at) {
            let field = &content[start..end];
            match tag {
                0xa0 => {
                    if let Some((_, s, _)) = tlv(field, 0) {
                        if let Some((_, os, oe)) = tlv(field, s) {
                            out.hash = hash_from_oid_der(&field[s..oe]).or(out.hash);
                            let _ = os;
                        }
                    }
                    out.mgf1 = out.hash;
                }
                0xa1 => {
                    // SEQUENCE { mgf1 OID, AlgorithmIdentifier { hash } }
                    if let Some((_, s, _)) = tlv(field, 0) {
                        if let Some((_, _, oid_end)) = tlv(field, s) {
                            if let Some((_, hs, _)) = tlv(field, oid_end) {
                                if let Some((_, _, he)) = tlv(field, hs) {
                                    out.mgf1 = hash_from_oid_der(&field[hs..he]).or(out.mgf1);
                                }
                            }
                        }
                    }
                }
                0xa2 => {
                    if let Some((_, s, e)) = tlv(field, 0) {
                        let mut salt = 0u32;
                        for byte in &field[s..e] {
                            salt = (salt << 8) | *byte as u32;
                        }
                        out.salt = Some(salt);
                    }
                }
                _ => {}
            }
            at = end;
        }
        out
    }

    fn from_alg_params(params: Option<pkcs8::der::asn1::AnyRef<'_>>) -> PssParams {
        match params {
            Some(any) => PssParams::parse(any.value()),
            None => PssParams::default(),
        }
    }
}

fn arr32(bytes: &[u8]) -> Res<[u8; 32]> {
    bytes.try_into().or_else(|_| invalid_key())
}

/// The fixed PKCS#8 / SPKI framings of the two 25519 algorithms (RFC 8410).
fn okp_pkcs8(oid_byte: u8, raw: &[u8; 32]) -> Vec<u8> {
    let mut out = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oid_byte, 0x04, 0x22,
        0x04, 0x20,
    ];
    out.extend_from_slice(raw);
    out
}

fn okp_spki(oid_byte: u8, raw: &[u8; 32]) -> Vec<u8> {
    let mut out = vec![
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oid_byte, 0x03, 0x21, 0x00,
    ];
    out.extend_from_slice(raw);
    out
}

/// RFC 8410 framings for the 448 curves (the raw key is not 32 bytes).
fn okp_pkcs8_any(oid_byte: u8, raw: &[u8]) -> Vec<u8> {
    let mut body = vec![0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oid_byte];
    body.extend(ff::tlv_bytes(0x04, &ff::tlv_bytes(0x04, raw)));
    ff::tlv_bytes(0x30, &body)
}

fn okp_spki_any(oid_byte: u8, raw: &[u8]) -> Vec<u8> {
    let mut bits = vec![0u8];
    bits.extend_from_slice(raw);
    let mut body = vec![0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, oid_byte];
    body.extend(ff::tlv_bytes(0x03, &bits));
    ff::tlv_bytes(0x30, &body)
}

/// `AlgorithmIdentifier { oid, SEQUENCE { ints } }` for DSA and DH.
fn ff_alg_id(oid_der: &[u8], params: &[&BigUint]) -> Vec<u8> {
    let mut body = oid_der.to_vec();
    body.extend(ff::seq_of(params));
    ff::tlv_bytes(0x30, &body)
}

fn ff_pkcs8(oid_der: &[u8], params: &[&BigUint], secret: &BigUint) -> Vec<u8> {
    let mut body = vec![0x02, 0x01, 0x00];
    body.extend(ff_alg_id(oid_der, params));
    body.extend(ff::tlv_bytes(0x04, &ff::der_uint(secret)));
    ff::tlv_bytes(0x30, &body)
}

fn ff_spki(oid_der: &[u8], params: &[&BigUint], public: &BigUint) -> Vec<u8> {
    let mut bits = vec![0u8];
    bits.extend(ff::der_uint(public));
    let mut body = ff_alg_id(oid_der, params);
    body.extend(ff::tlv_bytes(0x03, &bits));
    ff::tlv_bytes(0x30, &body)
}

/// The integers of an `AlgorithmIdentifier`'s `SEQUENCE` parameters.
fn alg_param_ints(params: Option<spki::der::asn1::AnyRef<'_>>) -> Res<Vec<BigUint>> {
    let Some(any) = params else { return invalid_key() };
    ff::ints(any.value()).map_or_else(invalid_key, Ok)
}

/// One DER `INTEGER` that is the whole of `der`.
fn single_int(der: &[u8]) -> Res<BigUint> {
    match ff::tlv(der, 0) {
        Some((0x02, start, end)) if end == der.len() => Ok(BigUint::from_bytes_be(&der[start..end])),
        _ => invalid_key(),
    }
}

fn dsa_params(v: &[BigUint]) -> Res<Box<DsaParams>> {
    if v.len() != 3 {
        return invalid_key();
    }
    Ok(Box::new(DsaParams { p: v[0].clone(), q: v[1].clone(), g: v[2].clone() }))
}

impl Private {
    fn from_pkcs8(der: &[u8]) -> Res<Private> {
        let info = pkcs8::PrivateKeyInfo::try_from(der).or_else(|_| invalid_key())?;
        let oid = info.algorithm.oid.to_string();
        match oid.as_str() {
            OID_RSA_PSS => Ok(Private::RsaPss(
                Box::new(RsaPrivateKey::from_pkcs1_der(info.private_key).or_else(|_| invalid_key())?),
                PssParams::from_alg_params(info.algorithm.parameters),
            )),
            OID_RSA => Ok(Private::Rsa(Box::new(
                RsaPrivateKey::from_pkcs8_der(der).or_else(|_| invalid_key())?,
            ))),
            OID_EC => {
                let curve = info
                    .algorithm
                    .parameters_oid()
                    .ok()
                    .and_then(|o| Crv::from_oid(&o.to_string()));
                let Some(crv) = curve else { return unsupported() };
                Ok(Private::Ec(crv, on_curve!(crv, from_pkcs8(der))?))
            }
            OID_ED25519 | OID_X25519 => {
                // `CurvePrivateKey ::= OCTET STRING` inside the PKCS#8 one.
                let inner = info.private_key;
                if inner.len() != 34 || inner[0] != 0x04 || inner[1] != 0x20 {
                    return invalid_key();
                }
                let raw = arr32(&inner[2..])?;
                Ok(if oid == OID_ED25519 {
                    Private::Ed25519(raw)
                } else {
                    Private::X25519(raw)
                })
            }
            OID_ED448 | OID_X448 => {
                let inner = info.private_key;
                let size = if oid == OID_ED448 { 57 } else { 56 };
                if inner.len() != size + 2 || inner[0] != 0x04 || inner[1] as usize != size {
                    return invalid_key();
                }
                let raw = &inner[2..];
                Ok(if oid == OID_ED448 {
                    Private::Ed448(raw.try_into().or_else(|_| invalid_key())?)
                } else {
                    Private::X448(raw.try_into().or_else(|_| invalid_key())?)
                })
            }
            OID_DSA => {
                let params = dsa_params(&alg_param_ints(info.algorithm.parameters)?)?;
                Ok(Private::Dsa(params, single_int(info.private_key)?))
            }
            OID_DH => {
                let v = alg_param_ints(info.algorithm.parameters)?;
                if v.len() < 2 {
                    return invalid_key();
                }
                Ok(Private::Dh(v[0].clone(), v[1].clone(), single_int(info.private_key)?))
            }
            _ => unsupported(),
        }
    }

    fn to_pkcs8(&self) -> Res<Vec<u8>> {
        match self {
            Private::Rsa(key) => Ok(key
                .to_pkcs8_der()
                .or_else(|_| invalid_key())?
                .as_bytes()
                .to_vec()),
            Private::RsaPss(key, params) => {
                let body = key.to_pkcs1_der().or_else(|_| invalid_key())?.as_bytes().to_vec();
                let mut seq = vec![0x02, 0x01, 0x00];
                seq.extend(params.alg_id());
                seq.extend(der_tlv(0x04, &body));
                Ok(der_tlv(0x30, &seq))
            }
            Private::Ec(crv, raw) => on_curve!(*crv, to_pkcs8(raw)),
            Private::Ed25519(raw) => Ok(okp_pkcs8(0x70, raw)),
            Private::X25519(raw) => Ok(okp_pkcs8(0x6e, raw)),
            Private::Ed448(raw) => Ok(okp_pkcs8_any(0x71, raw)),
            Private::X448(raw) => Ok(okp_pkcs8_any(0x6f, raw)),
            Private::Dsa(params, x) => Ok(ff_pkcs8(ff::DSA_OID_DER, &[&params.p, &params.q, &params.g], x)),
            Private::Dh(p, g, x) => Ok(ff_pkcs8(ff::DH_OID_DER, &[p, g], x)),
        }
    }

    fn public(&self) -> Res<Public> {
        Ok(match self {
            Private::Rsa(key) => Public::Rsa(Box::new(key.to_public_key())),
            Private::RsaPss(key, params) => Public::RsaPss(Box::new(key.to_public_key()), *params),
            Private::Ec(crv, raw) => Public::Ec(*crv, on_curve!(*crv, public_of(raw, false))?),
            Private::Ed25519(raw) => Public::Ed25519(
                ed25519_dalek::SigningKey::from_bytes(raw)
                    .verifying_key()
                    .to_bytes(),
            ),
            Private::X25519(raw) => Public::X25519(
                x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*raw)).to_bytes(),
            ),
            Private::Ed448(raw) => Public::Ed448(ff::ed448_public(raw)),
            Private::X448(raw) => Public::X448(ff::x448_public(raw)),
            Private::Dsa(params, x) => Public::Dsa(params.clone(), ff::dsa_public(params, x)),
            Private::Dh(p, g, x) => Public::Dh(p.clone(), g.clone(), g.modpow(x, p)),
        })
    }
}

impl Public {
    fn from_spki(der: &[u8]) -> Res<Public> {
        let info = spki::SubjectPublicKeyInfoRef::try_from(der).or_else(|_| invalid_key())?;
        let oid = info.algorithm.oid.to_string();
        match oid.as_str() {
            OID_RSA_PSS => Ok(Public::RsaPss(
                Box::new(
                    RsaPublicKey::from_pkcs1_der(info.subject_public_key.raw_bytes())
                        .or_else(|_| invalid_key())?,
                ),
                PssParams::from_alg_params(info.algorithm.parameters),
            )),
            OID_RSA => Ok(Public::Rsa(Box::new(
                RsaPublicKey::from_public_key_der(der).or_else(|_| invalid_key())?,
            ))),
            OID_EC => {
                let curve = info
                    .algorithm
                    .parameters_oid()
                    .ok()
                    .and_then(|o| Crv::from_oid(&o.to_string()));
                let Some(crv) = curve else { return unsupported() };
                Ok(Public::Ec(crv, on_curve!(crv, from_spki(der))?))
            }
            OID_ED25519 | OID_X25519 => {
                let raw = arr32(info.subject_public_key.raw_bytes())?;
                Ok(if oid == OID_ED25519 {
                    Public::Ed25519(raw)
                } else {
                    Public::X25519(raw)
                })
            }
            OID_ED448 => Ok(Public::Ed448(
                info.subject_public_key.raw_bytes().try_into().or_else(|_| invalid_key())?,
            )),
            OID_X448 => Ok(Public::X448(
                info.subject_public_key.raw_bytes().try_into().or_else(|_| invalid_key())?,
            )),
            OID_DSA => {
                let params = dsa_params(&alg_param_ints(info.algorithm.parameters)?)?;
                Ok(Public::Dsa(params, single_int(info.subject_public_key.raw_bytes())?))
            }
            OID_DH => {
                let v = alg_param_ints(info.algorithm.parameters)?;
                if v.len() < 2 {
                    return invalid_key();
                }
                Ok(Public::Dh(v[0].clone(), v[1].clone(), single_int(info.subject_public_key.raw_bytes())?))
            }
            _ => unsupported(),
        }
    }

    fn to_spki(&self) -> Res<Vec<u8>> {
        match self {
            Public::Rsa(key) => Ok(key
                .to_public_key_der()
                .or_else(|_| invalid_key())?
                .as_bytes()
                .to_vec()),
            Public::RsaPss(key, params) => {
                let body = key.to_pkcs1_der().or_else(|_| invalid_key())?.as_bytes().to_vec();
                let mut bits = vec![0u8];
                bits.extend(body);
                let mut seq = params.alg_id();
                seq.extend(der_tlv(0x03, &bits));
                Ok(der_tlv(0x30, &seq))
            }
            Public::Ec(crv, point) => on_curve!(*crv, to_spki(point)),
            Public::Ed25519(raw) => Ok(okp_spki(0x70, raw)),
            Public::X25519(raw) => Ok(okp_spki(0x6e, raw)),
            Public::Ed448(raw) => Ok(okp_spki_any(0x71, raw)),
            Public::X448(raw) => Ok(okp_spki_any(0x6f, raw)),
            Public::Dsa(params, y) => Ok(ff_spki(ff::DSA_OID_DER, &[&params.p, &params.q, &params.g], y)),
            Public::Dh(p, g, y) => Ok(ff_spki(ff::DH_OID_DER, &[p, g], y)),
        }
    }
}

/// Parse a canonical document of either kind into its public half.
fn public_of(kind: &str, der: &[u8]) -> Res<Public> {
    if kind == "private" {
        Private::from_pkcs8(der)?.public()
    } else {
        Public::from_spki(der)
    }
}

// ---------------------------------------------------------------------------
// PEM
// ---------------------------------------------------------------------------

struct Pem {
    label: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// The first PEM block in `text`.
fn parse_pem(text: &str) -> Option<Pem> {
    let start = text.find("-----BEGIN ")?;
    let rest = &text[start + 11..];
    let label_end = rest.find("-----")?;
    let label = rest[..label_end].to_owned();
    let rest = &rest[label_end + 5..];
    let end_marker = format!("-----END {label}-----");
    let end = rest.find(&end_marker)?;
    let inner = &rest[..end];
    let mut headers = Vec::new();
    let mut body = String::new();
    for line in inner.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_owned(), value.trim().to_owned()));
            continue;
        }
        body.push_str(line);
    }
    Some(Pem {
        label,
        headers,
        body: base64::decode(&body),
    })
}

fn to_pem(label: &str, headers: &[(String, String)], der: &[u8]) -> String {
    let mut out = format!("-----BEGIN {label}-----\n");
    if !headers.is_empty() {
        for (name, value) in headers {
            out.push_str(&format!("{name}: {value}\n"));
        }
        out.push('\n');
    }
    let text = base64::encode(der);
    let bytes = text.as_bytes();
    for chunk in bytes.chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

// ---------------------------------------------------------------------------
// Passphrase encryption
// ---------------------------------------------------------------------------

fn missing_passphrase<T>() -> Res<T> {
    err(
        "ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED",
        "error:07880109:common libcrypto routines::interrupted or cancelled",
    )
}

fn bad_decrypt<T>() -> Res<T> {
    err(
        "ERR_OSSL_BAD_DECRYPT",
        "error:1C800064:Provider routines::bad decrypt",
    )
}

/// OpenSSL's `EVP_BytesToKey(MD5, salt, pass, 1)`, the key derivation of the
/// RFC 1421 `DEK-Info` PEM encryption.
fn bytes_to_key(pass: &[u8], salt: &[u8], len: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut prev: Vec<u8> = Vec::new();
    while out.len() < len {
        let mut input = prev.clone();
        input.extend_from_slice(pass);
        input.extend_from_slice(salt);
        prev = Alg::Md5.digest(&input);
        out.extend_from_slice(&prev);
    }
    out.truncate(len);
    out
}

fn aes_key_len(cipher: &str) -> Option<usize> {
    match cipher.to_ascii_uppercase().as_str() {
        "AES-128-CBC" | "AES128" => Some(16),
        "AES-192-CBC" | "AES192" => Some(24),
        "AES-256-CBC" | "AES256" => Some(32),
        _ => None,
    }
}

fn cbc_crypt(encrypt: bool, key: &[u8], iv: &[u8], data: &[u8]) -> Res<Vec<u8>> {
    use aes::cipher::block_padding::Pkcs7;
    use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
    macro_rules! run {
        ($ty:ty) => {
            if encrypt {
                Ok(cbc::Encryptor::<$ty>::new_from_slices(key, iv)
                    .or_else(|_| bad_decrypt())?
                    .encrypt_padded_vec_mut::<Pkcs7>(data))
            } else {
                cbc::Decryptor::<$ty>::new_from_slices(key, iv)
                    .or_else(|_| bad_decrypt())?
                    .decrypt_padded_vec_mut::<Pkcs7>(data)
                    .or_else(|_| bad_decrypt())
            }
        };
    }
    match key.len() {
        16 => run!(aes::Aes128),
        24 => run!(aes::Aes192),
        32 => run!(aes::Aes256),
        _ => unsupported(),
    }
}

fn hex_decode(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// Decrypt an RFC 1421 encrypted PEM body, if its headers say it is one.
fn pem_legacy_decrypt(pem: &Pem, pass: Option<&[u8]>) -> Res<Vec<u8>> {
    let encrypted = pem
        .headers
        .iter()
        .any(|(n, v)| n == "Proc-Type" && v.contains("ENCRYPTED"));
    if !encrypted {
        return Ok(pem.body.clone());
    }
    let Some(pass) = pass else { return missing_passphrase() };
    let Some((_, dek)) = pem.headers.iter().find(|(n, _)| n == "DEK-Info") else {
        return invalid_key();
    };
    let (cipher, iv_hex) = dek.split_once(',').unwrap_or((dek.as_str(), ""));
    let Some(len) = aes_key_len(cipher) else { return unsupported() };
    let iv = hex_decode(iv_hex);
    if iv.len() < 8 {
        return invalid_key();
    }
    let key = bytes_to_key(pass, &iv[..8], len);
    cbc_crypt(false, &key, &iv, &pem.body)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// What an import produced.
enum Imported {
    Private(Private),
    Public(Public),
}

fn rsa_private_from_pkcs1(der: &[u8]) -> Res<Private> {
    Ok(Private::Rsa(Box::new(
        RsaPrivateKey::from_pkcs1_der(der).or_else(|_| invalid_key())?,
    )))
}

fn ec_from_sec1(der: &[u8]) -> Res<Private> {
    // SEC1 names its curve in the optional `[0] parameters`; try each.
    for crv in [Crv::P256, Crv::P384, Crv::P521, Crv::K256] {
        if let Ok(raw) = on_curve!(crv, from_sec1(der)) {
            if sec1_curve_matches(der, crv) {
                return Ok(Private::Ec(crv, raw));
            }
        }
    }
    invalid_key()
}

/// Does a SEC1 `ECPrivateKey` name `crv` (or name nothing and have the size)?
fn sec1_curve_matches(der: &[u8], crv: Crv) -> bool {
    let oid: &[u8] = match crv {
        Crv::P256 => &[0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
        Crv::P384 => &[0x2b, 0x81, 0x04, 0x00, 0x22],
        Crv::P521 => &[0x2b, 0x81, 0x04, 0x00, 0x23],
        Crv::K256 => &[0x2b, 0x81, 0x04, 0x00, 0x0a],
    };
    if der.windows(oid.len()).any(|w| w == oid) {
        return true;
    }
    // No parameters: fall back to the length of the private octet string.
    der.len() > 7 && der[6] as usize == crv.size()
}

fn curve_oid_der(crv: Crv) -> &'static [u8] {
    match crv {
        Crv::P256 => &[0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
        Crv::P384 => &[0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x22],
        Crv::P521 => &[0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x23],
        Crv::K256 => &[0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a],
    }
}

fn der_len(len: usize) -> Vec<u8> {
    if len < 0x80 {
        vec![len as u8]
    } else if len < 0x100 {
        vec![0x81, len as u8]
    } else {
        vec![0x82, (len >> 8) as u8, len as u8]
    }
}

/// A SEC1 `ECPrivateKey` with its `[0] parameters` (the curve OID) present,
/// which is how OpenSSL writes one and what lets it be read back
/// unambiguously.
fn sec1_with_params(der: &[u8], crv: Crv) -> Vec<u8> {
    let Some((_, start, end)) = tlv(der, 0) else { return der.to_vec() };
    let mut fields: Vec<&[u8]> = Vec::new();
    let mut at = start;
    while at < end {
        let Some((_, _, next)) = tlv(der, at) else { return der.to_vec() };
        fields.push(&der[at..next]);
        at = next;
    }
    if fields.iter().any(|f| f[0] == 0xa0) {
        return der.to_vec();
    }
    let oid = curve_oid_der(crv);
    let mut params = vec![0xa0];
    params.extend(der_len(oid.len()));
    params.extend_from_slice(oid);
    let mut body = Vec::new();
    for (i, field) in fields.iter().enumerate() {
        body.extend_from_slice(field);
        if i == 1 {
            body.extend_from_slice(&params);
        }
    }
    let mut out = vec![0x30];
    out.extend(der_len(body.len()));
    out.extend(body);
    out
}

fn import_der(der: &[u8], typ: &str, pass: Option<&[u8]>) -> Res<Imported> {
    match typ {
        "pkcs8" => {
            if let Ok(encrypted) = pkcs8::EncryptedPrivateKeyInfo::try_from(der) {
                let Some(pass) = pass else {
                    return err("ERR_MISSING_PASSPHRASE", "Passphrase required for encrypted key");
                };
                let doc = encrypted.decrypt(pass).or_else(|_| bad_decrypt())?;
                return Ok(Imported::Private(Private::from_pkcs8(doc.as_bytes())?));
            }
            Ok(Imported::Private(Private::from_pkcs8(der)?))
        }
        "spki" => Ok(Imported::Public(Public::from_spki(der)?)),
        "sec1" => Ok(Imported::Private(ec_from_sec1(der)?)),
        "pkcs1" => {
            if let Ok(key) = rsa_private_from_pkcs1(der) {
                return Ok(Imported::Private(key));
            }
            Ok(Imported::Public(Public::Rsa(Box::new(
                RsaPublicKey::from_pkcs1_der(der).or_else(|_| invalid_key())?,
            ))))
        }
        // No type: try every DER form in turn, as OpenSSL's decoder does.
        _ => {
            for t in ["pkcs8", "spki", "pkcs1", "sec1"] {
                if let Ok(key) = import_der(der, t, pass) {
                    return Ok(key);
                }
            }
            invalid_key()
        }
    }
}

fn import_pem(text: &str, pass: Option<&[u8]>) -> Res<Imported> {
    let Some(pem) = parse_pem(text) else {
        return err(
            "ERR_OSSL_UNSUPPORTED",
            "error:1E08010C:DECODER routines::unsupported",
        );
    };
    match pem.label.as_str() {
        "PUBLIC KEY" => Ok(Imported::Public(Public::from_spki(&pem.body)?)),
        "RSA PUBLIC KEY" => Ok(Imported::Public(Public::Rsa(Box::new(
            RsaPublicKey::from_pkcs1_der(&pem.body).or_else(|_| invalid_key())?,
        )))),
        "PRIVATE KEY" => Ok(Imported::Private(Private::from_pkcs8(&pem.body)?)),
        "ENCRYPTED PRIVATE KEY" => match pass {
            None => missing_passphrase(),
            Some(_) => import_der(&pem.body, "pkcs8", pass),
        },
        "RSA PRIVATE KEY" => {
            let der = pem_legacy_decrypt(&pem, pass)?;
            Ok(Imported::Private(
                rsa_private_from_pkcs1(&der).or_else(|_| bad_decrypt())?,
            ))
        }
        "EC PRIVATE KEY" => {
            let der = pem_legacy_decrypt(&pem, pass)?;
            Ok(Imported::Private(ec_from_sec1(&der)?))
        }
        // The traditional `DSAPrivateKey ::= SEQUENCE { 0, p, q, g, y, x }`.
        "DSA PRIVATE KEY" => {
            let der = pem_legacy_decrypt(&pem, pass)?;
            match ff::seq_ints(&der) {
                Some(v) if v.len() == 6 => Ok(Imported::Private(Private::Dsa(
                    dsa_params(&v[1..4])?,
                    v[5].clone(),
                ))),
                _ => bad_decrypt(),
            }
        }
        "CERTIFICATE" => Ok(Imported::Public(Public::from_spki(&cert_spki(&pem.body)?)?)),
        _ => unsupported(),
    }
}

/// A DER TLV header at `at`: `(tag, content start, content end)`.
fn tlv(der: &[u8], at: usize) -> Option<(u8, usize, usize)> {
    let tag = *der.get(at)?;
    let first = *der.get(at + 1)? as usize;
    let (len, start) = if first < 0x80 {
        (first, at + 2)
    } else {
        let count = first & 0x7f;
        let mut len = 0usize;
        for i in 0..count {
            len = (len << 8) | *der.get(at + 2 + i)? as usize;
        }
        (len, at + 2 + count)
    };
    if start + len > der.len() {
        return None;
    }
    Some((tag, start, start + len))
}

/// The `subjectPublicKeyInfo` of an X.509 certificate: the seventh field of
/// `tbsCertificate` (counting the optional `[0] version`).
fn cert_spki(der: &[u8]) -> Res<Vec<u8>> {
    let walk = || -> Option<Vec<u8>> {
        let (_, cert, _) = tlv(der, 0)?;
        let (_, tbs, tbs_end) = tlv(der, cert)?;
        let mut at = tbs;
        let (tag, _, end) = tlv(der, at)?;
        if tag == 0xa0 {
            at = end;
        }
        // serialNumber, signature, issuer, validity, subject
        for _ in 0..5 {
            let (_, _, end) = tlv(der, at)?;
            at = end;
        }
        let (_, _, end) = tlv(der, at)?;
        if end > tbs_end {
            return None;
        }
        Some(der[at..end].to_vec())
    };
    walk().map_or_else(invalid_key, Ok)
}

fn finish_import(imported: Imported, want_private: bool) -> Res<String> {
    match imported {
        Imported::Private(key) => {
            if want_private {
                ok_fields(&["private".into(), b64(&key.to_pkcs8()?)])
            } else {
                ok_fields(&["public".into(), b64(&key.public()?.to_spki()?)])
            }
        }
        Imported::Public(key) => {
            if want_private {
                return err(
                    "ERR_OSSL_UNSUPPORTED",
                    "error:1E08010C:DECODER routines::unsupported",
                );
            }
            ok_fields(&["public".into(), b64(&key.to_spki()?)])
        }
    }
}

native!(
    /// `cryptoKeyImport(data, format, type, passphrase, hasPassphrase,
    /// wantPrivate)` → `+<kind> US <der>`. `data` and `passphrase` are base64;
    /// `format` is `pem` or `der`.
    key_import,
    |a| {
        let data = a.bytes(0)?;
        let format = a.s(1)?;
        let typ = a.s(2)?;
        let pass = a.bytes(3)?;
        let pass = if a.b(4) { Some(pass.as_slice()) } else { None };
        let want_private = a.b(5);
        let imported = if format == "der" {
            import_der(&data, &typ, pass)?
        } else {
            let text = String::from_utf8_lossy(&data).into_owned();
            import_pem(&text, pass)?
        };
        finish_import(imported, want_private)
    }
);

fn b64url_decode(text: &str) -> Vec<u8> {
    let standard: String = text
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            other => other,
        })
        .collect();
    base64::decode(&standard)
}

fn b64url(bytes: &[u8]) -> String {
    base64::encode(bytes)
        .trim_end_matches('=')
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect()
}

fn big(bytes: &[u8]) -> BigUint {
    BigUint::from_bytes_be(bytes)
}

/// Left-pad to `len` bytes.
fn pad_to(mut bytes: Vec<u8>, len: usize) -> Vec<u8> {
    if bytes.len() < len {
        let mut out = vec![0u8; len - bytes.len()];
        out.append(&mut bytes);
        bytes = out;
    }
    bytes
}

native!(
    /// `cryptoKeyImportJwk(fields, wantPrivate)`: `fields` is `kty crv n e d
    /// p q dp dq qi x y`, US-separated, each a base64url string or empty.
    key_import_jwk,
    |a| {
        let fields = a.s(0)?;
        let want_private = a.b(1);
        let f: Vec<&str> = fields.split(US).collect();
        let get = |i: usize| f.get(i).copied().unwrap_or("");
        let (kty, crv) = (get(0), get(1));
        let has_d = !get(4).is_empty();
        let invalid = || {
            err::<Imported>("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data")
        };
        let imported = match kty {
            "RSA" => {
                let n = big(&b64url_decode(get(2)));
                let e = big(&b64url_decode(get(3)));
                if want_private && has_d {
                    let d = big(&b64url_decode(get(4)));
                    let mut primes = Vec::new();
                    if !get(5).is_empty() && !get(6).is_empty() {
                        primes.push(big(&b64url_decode(get(5))));
                        primes.push(big(&b64url_decode(get(6))));
                    }
                    match RsaPrivateKey::from_components(n, e, d, primes) {
                        Ok(key) => Imported::Private(Private::Rsa(Box::new(key))),
                        Err(_) => invalid()?,
                    }
                } else {
                    match RsaPublicKey::new(n, e) {
                        Ok(key) => Imported::Public(Public::Rsa(Box::new(key))),
                        Err(_) => invalid()?,
                    }
                }
            }
            "EC" => {
                let Some(curve) = Crv::from_name(crv) else {
                    return err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key");
                };
                if want_private && has_d {
                    let raw = pad_to(b64url_decode(get(4)), curve.size());
                    on_curve!(curve, check(&raw))?;
                    Imported::Private(Private::Ec(curve, raw))
                } else {
                    let mut point = vec![4u8];
                    point.extend(pad_to(b64url_decode(get(10)), curve.size()));
                    point.extend(pad_to(b64url_decode(get(11)), curve.size()));
                    on_curve!(curve, check_point(&point)).or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK EC key"))?;
                    Imported::Public(Public::Ec(curve, point))
                }
            }
            "OKP" => {
                let raw_d = b64url_decode(get(4));
                let raw_x = b64url_decode(get(10));
                match crv {
                    "Ed25519" if want_private && has_d => {
                        Imported::Private(Private::Ed25519(arr32(&raw_d).or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?))
                    }
                    "Ed25519" => {
                        Imported::Public(Public::Ed25519(arr32(&raw_x).or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?))
                    }
                    "X25519" if want_private && has_d => {
                        Imported::Private(Private::X25519(arr32(&raw_d).or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?))
                    }
                    "X25519" => {
                        Imported::Public(Public::X25519(arr32(&raw_x).or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?))
                    }
                    "Ed448" if want_private && has_d => Imported::Private(Private::Ed448(
                        raw_d.as_slice().try_into().or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?,
                    )),
                    "Ed448" => Imported::Public(Public::Ed448(
                        raw_x.as_slice().try_into().or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?,
                    )),
                    "X448" if want_private && has_d => Imported::Private(Private::X448(
                        raw_d.as_slice().try_into().or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?,
                    )),
                    "X448" => Imported::Public(Public::X448(
                        raw_x.as_slice().try_into().or_else(|_| err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"))?,
                    )),
                    _ => return unsupported(),
                }
            }
            _ => return err("ERR_CRYPTO_INVALID_JWK", "Invalid JWK data"),
        };
        finish_import(imported, want_private)
    }
);

native!(
    /// `cryptoKeyDerivePublic(pkcs8)` → `+<spki>`.
    key_derive_public,
    |a| {
        let der = a.bytes(0)?;
        let spki = Private::from_pkcs8(&der)?.public()?.to_spki()?;
        ok_fields(&[b64(&spki)])
    }
);

native!(
    /// `cryptoKeyInfo(kind, der)` → `+<asymmetricKeyType> US <modulusLength>
    /// US <publicExponent, decimal> US <namedCurve> US <hashAlgorithm> US
    /// <mgf1HashAlgorithm> US <saltLength>` (the last three for a restricted
    /// RSA-PSS key only).
    key_info,
    |a| {
        let kind = a.s(0)?;
        let der = a.bytes(1)?;
        let public = public_of(&kind, &der)?;
        let none = String::new;
        let fields: [String; 7] = match public {
            Public::Rsa(key) => [
                "rsa".into(),
                key.n().bits().to_string(),
                key.e().to_string(),
                none(),
                none(),
                none(),
                none(),
            ],
            Public::RsaPss(key, params) => {
                let restricted = params.restricted();
                let name = |alg: Option<Alg>| {
                    if restricted { hash_name(alg.unwrap_or(Alg::Sha1)).to_owned() } else { String::new() }
                };
                [
                    "rsa-pss".into(),
                    key.n().bits().to_string(),
                    key.e().to_string(),
                    none(),
                    name(params.hash),
                    name(params.mgf1.or(params.hash)),
                    if restricted { params.salt.unwrap_or(20).to_string() } else { none() },
                ]
            }
            Public::Ec(crv, _) => ["ec".into(), none(), none(), crv.name().into(), none(), none(), none()],
            Public::Ed25519(_) => ["ed25519".into(), none(), none(), none(), none(), none(), none()],
            Public::X25519(_) => ["x25519".into(), none(), none(), none(), none(), none(), none()],
            Public::Ed448(_) => ["ed448".into(), none(), none(), none(), none(), none(), none()],
            Public::X448(_) => ["x448".into(), none(), none(), none(), none(), none(), none()],
            // DSA: modulusLength, then divisorLength in the exponent slot.
            Public::Dsa(params, _) => [
                "dsa".into(),
                params.p.bits().to_string(),
                params.q.bits().to_string(),
                none(),
                none(),
                none(),
                none(),
            ],
            Public::Dh(p, _, _) => ["dh".into(), p.bits().to_string(), none(), none(), none(), none(), none()],
        };
        ok_fields(&fields)
    }
);

fn invalid_encoding<T>(message: &str) -> Res<T> {
    err("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", message)
}

native!(
    /// `cryptoKeyExport(kind, der, type, format, cipher, passphrase)` →
    /// `+<bytes>` (base64; the PEM text's bytes for `pem`).
    key_export,
    |a| {
        let kind = a.s(0)?;
        let der = a.bytes(1)?;
        let typ = a.s(2)?;
        let format = a.s(3)?;
        let cipher = a.s(4)?;
        let pass = a.bytes(5)?;
        let pem = format != "der";
        let out: Vec<u8> = if kind == "public" {
            let key = Public::from_spki(&der)?;
            match typ.as_str() {
                "pkcs1" => {
                    let Public::Rsa(rsa) = &key else {
                        return invalid_encoding("The selected key encoding pkcs1 can only be used for RSA keys.");
                    };
                    let body = rsa.to_pkcs1_der().or_else(|_| invalid_key())?.as_bytes().to_vec();
                    if pem { to_pem("RSA PUBLIC KEY", &[], &body).into_bytes() } else { body }
                }
                _ => {
                    if pem { to_pem("PUBLIC KEY", &[], &der).into_bytes() } else { der }
                }
            }
        } else {
            let key = Private::from_pkcs8(&der)?;
            match typ.as_str() {
                "pkcs1" | "sec1" => {
                    let (label, body) = match (&key, typ.as_str()) {
                        (Private::Rsa(rsa), "pkcs1") => (
                            "RSA PRIVATE KEY",
                            rsa.to_pkcs1_der().or_else(|_| invalid_key())?.as_bytes().to_vec(),
                        ),
                        (Private::Ec(crv, raw), "sec1") => {
                            ("EC PRIVATE KEY", sec1_with_params(&on_curve!(*crv, to_sec1(raw))?, *crv))
                        }
                        (_, "pkcs1") => {
                            return invalid_encoding("The selected key encoding pkcs1 can only be used for RSA keys.")
                        }
                        _ => {
                            return invalid_encoding("The selected key encoding sec1 can only be used for EC keys.")
                        }
                    };
                    if !pem {
                        if !cipher.is_empty() {
                            return invalid_encoding(&format!(
                                "The selected key encoding {typ} does not support encryption."
                            ));
                        }
                        body
                    } else if cipher.is_empty() {
                        to_pem(label, &[], &body).into_bytes()
                    } else {
                        let Some(len) = aes_key_len(&cipher) else { return unsupported() };
                        let mut iv = [0u8; 16];
                        OsRng.fill_bytes(&mut iv);
                        let k = bytes_to_key(&pass, &iv[..8], len);
                        let enc = cbc_crypt(true, &k, &iv, &body)?;
                        let name = format!("AES-{}-CBC", len * 8);
                        let headers = vec![
                            ("Proc-Type".to_owned(), "4,ENCRYPTED".to_owned()),
                            ("DEK-Info".to_owned(), format!("{name},{}", hex_upper(&iv))),
                        ];
                        to_pem(label, &headers, &enc).into_bytes()
                    }
                }
                _ => {
                    if cipher.is_empty() {
                        if pem { to_pem("PRIVATE KEY", &[], &der).into_bytes() } else { der }
                    } else {
                        let Some(len) = aes_key_len(&cipher)
                            .or(if cipher.eq_ignore_ascii_case("aes-128-ecb") { Some(16) } else { None })
                        else {
                            return unsupported();
                        };
                        let mut salt = [0u8; 16];
                        let mut iv = [0u8; 16];
                        OsRng.fill_bytes(&mut salt);
                        OsRng.fill_bytes(&mut iv);
                        let params = if len == 16 {
                            pkcs8::pkcs5::pbes2::Parameters::pbkdf2_sha256_aes128cbc(2048, &salt, &iv)
                        } else {
                            pkcs8::pkcs5::pbes2::Parameters::pbkdf2_sha256_aes256cbc(2048, &salt, &iv)
                        }
                        .or_else(|_| unsupported())?;
                        let info = pkcs8::PrivateKeyInfo::try_from(der.as_slice()).or_else(|_| invalid_key())?;
                        let doc = info.encrypt_with_params(params, &pass).or_else(|_| unsupported())?;
                        let body = doc.as_bytes().to_vec();
                        if pem { to_pem("ENCRYPTED PRIVATE KEY", &[], &body).into_bytes() } else { body }
                    }
                }
            }
        };
        ok_fields(&[b64(&out)])
    }
);

native!(
    /// `cryptoKeyJwk(kind, der)` → `+kty US crv US n US e US d US p US q US
    /// dp US dq US qi US x US y`, each base64url or empty.
    key_jwk,
    |a| {
        let kind = a.s(0)?;
        let der = a.bytes(1)?;
        let mut f: Vec<String> = vec![String::new(); 12];
        let private = if kind == "private" { Some(Private::from_pkcs8(&der)?) } else { None };
        let public = match &private {
            Some(key) => key.public()?,
            None => Public::from_spki(&der)?,
        };
        if matches!(public, Public::RsaPss(..)) {
            return err("ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.");
        }
        if matches!(public, Public::Dsa(..) | Public::Dh(..)) {
            return err("ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.");
        }
        match &public {
            Public::RsaPss(..) | Public::Dsa(..) | Public::Dh(..) => {}
            Public::Ed448(raw) => {
                f[0] = "OKP".into();
                f[1] = "Ed448".into();
                f[10] = b64url(raw);
            }
            Public::X448(raw) => {
                f[0] = "OKP".into();
                f[1] = "X448".into();
                f[10] = b64url(raw);
            }
            Public::Rsa(key) => {
                f[0] = "RSA".into();
                f[2] = b64url(&key.n().to_bytes_be());
                f[3] = b64url(&key.e().to_bytes_be());
            }
            Public::Ec(crv, point) => {
                f[0] = "EC".into();
                f[1] = crv.jwk().into();
                let size = crv.size();
                f[10] = b64url(&point[1..1 + size]);
                f[11] = b64url(&point[1 + size..]);
            }
            Public::Ed25519(raw) => {
                f[0] = "OKP".into();
                f[1] = "Ed25519".into();
                f[10] = b64url(raw);
            }
            Public::X25519(raw) => {
                f[0] = "OKP".into();
                f[1] = "X25519".into();
                f[10] = b64url(raw);
            }
        }
        match &private {
            Some(Private::Rsa(key)) => {
                f[4] = b64url(&key.d().to_bytes_be());
                let primes = key.primes();
                if primes.len() >= 2 {
                    f[5] = b64url(&primes[0].to_bytes_be());
                    f[6] = b64url(&primes[1].to_bytes_be());
                    let one = BigUint::from(1u8);
                    let dp = key.d() % (&primes[0] - &one);
                    let dq = key.d() % (&primes[1] - &one);
                    f[7] = b64url(&dp.to_bytes_be());
                    f[8] = b64url(&dq.to_bytes_be());
                    if let Some(qi) = key.crt_coefficient() {
                        f[9] = b64url(&qi.to_bytes_be());
                    }
                }
            }
            Some(Private::RsaPss(..)) => {}
            Some(Private::Ec(_, raw)) => f[4] = b64url(raw),
            Some(Private::Ed25519(raw)) | Some(Private::X25519(raw)) => f[4] = b64url(raw),
            Some(Private::Ed448(raw)) => f[4] = b64url(raw),
            Some(Private::X448(raw)) => f[4] = b64url(raw),
            Some(Private::Dsa(..)) | Some(Private::Dh(..)) => {}
            None => {}
        }
        ok_fields(&f)
    }
);

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

fn random32() -> [u8; 32] {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    raw
}

native!(
    /// `cryptoKeyGenerate(type, modulusLength, publicExponent, namedCurve)` →
    /// `+<pkcs8> US <spki>`.
    key_generate,
    |a| {
        let typ = a.s(0)?;
        let bits = a.i(1);
        let exponent = a.i(2);
        let curve = a.s(3)?;
        let private = match typ.as_str() {
            "rsa" | "rsa-pss" => {
                if !(512..=16384).contains(&bits) || exponent < 3 || exponent % 2 == 0 {
                    return err("ERR_OSSL_BN_BITS_TOO_SMALL", "error:1C80006B:Provider routines::invalid key length");
                }
                let key = RsaPrivateKey::new_with_exp(
                    &mut OsRng,
                    bits as usize,
                    &BigUint::from(exponent as u64),
                )
                .or_else(|_| err("ERR_OSSL_RSA_KEY_SIZE_TOO_SMALL", "key size too small"))?;
                if typ == "rsa" {
                    Private::Rsa(Box::new(key))
                } else {
                    // `curve` carries `hash US mgf1 US saltLength` (each may
                    // be empty) for an RSA-PSS key.
                    let f: Vec<&str> = curve.split(US).collect();
                    let alg = |i: usize| -> Res<Option<Alg>> {
                        match f.get(i).copied().unwrap_or("") {
                            "" => Ok(None),
                            name => match Alg::resolve(name) {
                                Some(alg) if hash_oid_der(alg).is_some() => Ok(Some(alg)),
                                _ => err("ERR_CRYPTO_INVALID_DIGEST", &format!("Invalid MGF1 digest: {name}")),
                            },
                        }
                    };
                    let hash = alg(0)?;
                    let mgf1 = alg(1)?;
                    let salt = f.get(2).and_then(|s| s.parse::<u32>().ok());
                    let mut params = PssParams { hash, mgf1, salt };
                    if params.restricted() {
                        let h = params.hash.unwrap_or(Alg::Sha1);
                        params.hash = Some(h);
                        params.mgf1 = Some(params.mgf1.unwrap_or(h));
                        params.salt = Some(params.salt.unwrap_or(h.output_size() as u32));
                    }
                    Private::RsaPss(Box::new(key), params)
                }
            }
            "ec" => {
                let Some(crv) = Crv::from_name(&curve) else {
                    return err("ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name");
                };
                Private::Ec(crv, on_curve!(crv, generate()))
            }
            "ed25519" => Private::Ed25519(random32()),
            "x25519" => Private::X25519(random32()),
            "ed448" => {
                let mut raw = [0u8; 57];
                OsRng.fill_bytes(&mut raw);
                Private::Ed448(raw)
            }
            "x448" => {
                let mut raw = [0u8; 56];
                OsRng.fill_bytes(&mut raw);
                Private::X448(raw)
            }
            // `bits` is modulusLength; `curve` carries divisorLength (or "").
            "dsa" => {
                let l = bits as usize;
                let n = match curve.parse::<usize>() {
                    Ok(n) => n,
                    Err(_) => if l >= 2048 { 256 } else { 160 },
                };
                if !(512..=16384).contains(&l) || !(160..=512).contains(&n) || n >= l || n % 8 != 0 {
                    return err("ERR_OSSL_DSA_BAD_FFC_PARAMETERS", "error:0A000101:dsa routines::bad ffc parameters");
                }
                let params = ff::dsa_generate(l, n);
                let x = ff::random_private(&params.q);
                Private::Dsa(Box::new(params), x)
            }
            // `curve` carries `prime(base64) US generator(decimal)`; the TS
            // layer resolves `group` and `primeLength` to a prime first.
            "dh" => {
                let f: Vec<&str> = curve.split(US).collect();
                let p = big(&base64::decode(f.first().copied().unwrap_or("")));
                let g = BigUint::from(f.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(2));
                if p.bits() < 2 {
                    return invalid_key();
                }
                let x = ff::random_private(&(&p - BigUint::from(1u8)));
                Private::Dh(p, g, x)
            }
            _ => return unsupported(),
        };
        let spki = private.public()?.to_spki()?;
        ok_fields(&[b64(&private.to_pkcs8()?), b64(&spki)])
    }
);

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const RSA_PKCS1_PADDING: i64 = 1;
const RSA_NO_PADDING: i64 = 3;
const RSA_PKCS1_OAEP_PADDING: i64 = 4;
const RSA_PKCS1_PSS_PADDING: i64 = 6;
const RSA_PSS_SALTLEN_DIGEST: i64 = -1;
const RSA_PSS_SALTLEN_MAX_SIGN: i64 = -2;

/// `padding US saltLength US dsaEncoding(0 = der, 1 = ieee-p1363)`.
/// An empty field means "not given".
struct SigOpts {
    padding: i64,
    salt: i64,
    p1363: bool,
    explicit_padding: bool,
    explicit_salt: bool,
    /// The Ed448 `context` (empty when not given).
    context: Vec<u8>,
}

fn sig_opts(text: &str) -> SigOpts {
    let f: Vec<&str> = text.split(US).collect();
    let get = |i: usize| f.get(i).and_then(|s| s.parse::<i64>().ok());
    SigOpts {
        padding: get(0).unwrap_or(RSA_PKCS1_PADDING),
        salt: get(1).unwrap_or(RSA_PSS_SALTLEN_MAX_SIGN),
        p1363: get(2) == Some(1),
        explicit_padding: get(0).is_some(),
        explicit_salt: get(1).is_some(),
        context: base64::decode(f.get(3).copied().unwrap_or("")),
    }
}

fn keytype_unsupported<T>() -> Res<T> {
    err(
        "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE",
        "error:03000096:digital envelope routines::operation not supported for this keytype",
    )
}

/// The effective options of a signature with an RSA-PSS key: PSS padding
/// always, and the key's own digest and salt length unless overridden.
fn pss_key_opts(o: &SigOpts, params: &PssParams, alg: Option<Alg>) -> Res<(SigOpts, Option<Alg>)> {
    if o.explicit_padding && o.padding != RSA_PKCS1_PSS_PADDING {
        return err(
            "ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE",
            "error:1C8000A5:Provider routines::illegal or unsupported padding mode",
        );
    }
    let salt = if o.explicit_salt {
        o.salt
    } else {
        params.salt.map_or(RSA_PSS_SALTLEN_MAX_SIGN, |s| s as i64)
    };
    Ok((
        SigOpts {
            padding: RSA_PKCS1_PSS_PADDING,
            salt,
            p1363: o.p1363,
            explicit_padding: true,
            explicit_salt: true,
            context: o.context.clone(),
        },
        alg.or(params.hash),
    ))
}

fn pss_max_salt(key: &RsaPublicKey, hash_len: usize) -> usize {
    let em_len = (key.n().bits() - 1).div_ceil(8);
    em_len.saturating_sub(hash_len + 2)
}

fn rsa_sign(key: &RsaPrivateKey, alg: Option<Alg>, data: &[u8], o: &SigOpts) -> Res<Vec<u8>> {
    let alg = alg.unwrap_or(Alg::Sha256);
    let hashed = alg.digest(data);
    let failed = |_| err::<Vec<u8>>("ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY", "error:02000070:rsa routines::digest too big for rsa key");
    if o.padding == RSA_PKCS1_PSS_PADDING {
        let Some(digest) = dyn_digest(alg) else { return unsupported() };
        let salt = match o.salt {
            RSA_PSS_SALTLEN_DIGEST => hashed.len(),
            s if s < 0 => pss_max_salt(&key.to_public_key(), hashed.len()),
            s => s as usize,
        };
        let scheme = Pss { blinded: true, digest, salt_len: salt };
        return key.sign_with_rng(&mut OsRng, scheme, &hashed).or_else(failed);
    }
    let Some(prefix) = digest_info_prefix(alg) else { return unsupported() };
    let scheme = Pkcs1v15Sign { hash_len: Some(hashed.len()), prefix: prefix.into_boxed_slice() };
    key.sign(scheme, &hashed).or_else(failed)
}

fn rsa_verify(key: &RsaPublicKey, alg: Option<Alg>, data: &[u8], sig: &[u8], o: &SigOpts) -> bool {
    let alg = alg.unwrap_or(Alg::Sha256);
    let hashed = alg.digest(data);
    if o.padding == RSA_PKCS1_PSS_PADDING {
        let max = pss_max_salt(key, hashed.len());
        let candidates: Vec<usize> = match o.salt {
            RSA_PSS_SALTLEN_DIGEST => vec![hashed.len()],
            s if s >= 0 => vec![s as usize],
            // AUTO: whatever length the signature carries.
            _ => {
                let mut all = vec![hashed.len(), max];
                all.extend(0..=max);
                all
            }
        };
        return candidates.into_iter().any(|salt| {
            let Some(digest) = dyn_digest(alg) else { return false };
            let scheme = Pss { blinded: false, digest, salt_len: salt };
            key.verify(scheme, &hashed, sig).is_ok()
        });
    }
    let Some(prefix) = digest_info_prefix(alg) else { return false };
    let scheme = Pkcs1v15Sign { hash_len: Some(hashed.len()), prefix: prefix.into_boxed_slice() };
    key.verify(scheme, &hashed, sig).is_ok()
}

native!(
    /// `cryptoSign(digest, pkcs8, data, opts)` → `+<signature>`.
    sign,
    |a| {
        let alg = sig_digest(&a.s(0)?)?;
        let der = a.bytes(1)?;
        let data = a.bytes(2)?;
        let o = sig_opts(&a.s(3)?);
        let key = Private::from_pkcs8(&der)?;
        let sig = match &key {
            Private::Rsa(rsa) => rsa_sign(rsa, alg, &data, &o)?,
            Private::RsaPss(rsa, params) => {
                let (o, alg) = pss_key_opts(&o, params, alg)?;
                rsa_sign(rsa, alg, &data, &o)?
            }
            Private::Ec(crv, raw) => {
                let hashed = alg.unwrap_or(Alg::Sha256).digest(&data);
                on_curve!(*crv, sign(raw, &hashed, o.p1363))?
            }
            Private::Ed25519(raw) => {
                use ed25519_dalek::Signer;
                if alg.is_some() {
                    return err("ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:1C8000B3:Provider routines::invalid digest");
                }
                ed25519_dalek::SigningKey::from_bytes(raw).sign(&data).to_bytes().to_vec()
            }
            Private::Ed448(raw) => {
                if alg.is_some() {
                    return err("ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:1C8000B3:Provider routines::invalid digest");
                }
                let Some(sig) = ff::ed448_sign(raw, &data, &o.context) else { return unsupported() };
                sig
            }
            Private::Dsa(params, x) => {
                let hashed = alg.unwrap_or(Alg::Sha256).digest(&data);
                ff::dsa_sign(params, x, &hashed, o.p1363)
            }
            Private::X25519(_) | Private::X448(_) | Private::Dh(..) => {
                return err(
                    "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE",
                    "error:03000096:digital envelope routines::operation not supported for this keytype",
                )
            }
        };
        ok_fields(&[b64(&sig)])
    }
);

native!(
    /// `cryptoVerify(digest, kind, der, data, signature, opts)` → `+1` / `+0`.
    verify,
    |a| {
        let alg = sig_digest(&a.s(0)?)?;
        let kind = a.s(1)?;
        let der = a.bytes(2)?;
        let data = a.bytes(3)?;
        let sig = a.bytes(4)?;
        let o = sig_opts(&a.s(5)?);
        let key = public_of(&kind, &der)?;
        let good = match &key {
            Public::Rsa(rsa) => rsa_verify(rsa, alg, &data, &sig, &o),
            Public::RsaPss(rsa, params) => {
                let (o, alg) = pss_key_opts(&o, params, alg)?;
                rsa_verify(rsa, alg, &data, &sig, &o)
            }
            Public::Ec(crv, point) => {
                let hashed = alg.unwrap_or(Alg::Sha256).digest(&data);
                on_curve!(*crv, verify(point, &hashed, &sig, o.p1363))
            }
            Public::Ed25519(raw) => {
                use ed25519_dalek::Verifier;
                let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(raw) else {
                    return ok_fields(&["0".into()]);
                };
                match ed25519_dalek::Signature::from_slice(&sig) {
                    Ok(sig) => vk.verify(&data, &sig).is_ok(),
                    Err(_) => false,
                }
            }
            Public::Ed448(raw) => ff::ed448_verify(raw, &data, &sig, &o.context),
            Public::Dsa(params, y) => {
                let hashed = alg.unwrap_or(Alg::Sha256).digest(&data);
                ff::dsa_verify(params, y, &hashed, &sig, o.p1363)
            }
            Public::X25519(_) | Public::X448(_) | Public::Dh(..) => {
                return err(
                    "ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE",
                    "error:03000096:digital envelope routines::operation not supported for this keytype",
                )
            }
        };
        ok_fields(&[if good { "1".into() } else { "0".into() }])
    }
);

// ---------------------------------------------------------------------------
// RSA encryption
// ---------------------------------------------------------------------------

fn rsa_raw(m: &[u8], exp: &BigUint, n: &BigUint) -> Res<Vec<u8>> {
    let size = n.bits().div_ceil(8);
    let value = big(m);
    if &value >= n {
        return err(
            "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS",
            "error:0200006E:rsa routines::data too large for modulus",
        );
    }
    Ok(pad_to(value.modpow(exp, n).to_bytes_be(), size))
}

fn data_too_large<T>() -> Res<T> {
    err(
        "ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE",
        "error:0200006E:rsa routines::data too large for key size",
    )
}

fn oaep(hash: &str, label: &[u8]) -> Res<Oaep> {
    let alg = if hash.is_empty() { Alg::Sha1 } else {
        match Alg::resolve(hash) {
            Some(alg) => alg,
            None => return err("ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest"),
        }
    };
    let (Some(digest), Some(mgf_digest)) = (dyn_digest(alg), dyn_digest(alg)) else {
        return unsupported();
    };
    Ok(Oaep {
        digest,
        mgf_digest,
        label: if label.is_empty() { None } else { Some(String::from_utf8_lossy(label).into_owned()) },
    })
}

native!(
    /// `cryptoRsaCrypt(op, kind, der, data, opts)` → `+<bytes>`. `op` is
    /// `publicEncrypt`, `privateDecrypt`, `privateEncrypt` or `publicDecrypt`;
    /// `opts` is `padding US oaepHash US oaepLabel(base64)`.
    rsa_crypt,
    |a| {
        let op = a.s(0)?;
        let kind = a.s(1)?;
        let der = a.bytes(2)?;
        let data = a.bytes(3)?;
        let opts = a.s(4)?;
        let f: Vec<&str> = opts.split(US).collect();
        let padding = f.first().and_then(|s| s.parse::<i64>().ok()).unwrap_or(RSA_PKCS1_PADDING);
        let hash = f.get(1).copied().unwrap_or("");
        let label = base64::decode(f.get(2).copied().unwrap_or(""));
        let failed_decrypt = || err::<Vec<u8>>("ERR_OSSL_RSA_PADDING_CHECK_FAILED", "error:02000079:rsa routines::oaep decoding error");
        let out = match op.as_str() {
            "publicEncrypt" => {
                let Public::Rsa(key) = public_of(&kind, &der)? else { return keytype_unsupported() };
                match padding {
                    RSA_NO_PADDING => {
                        if data.len() != key.size() {
                            return data_too_large();
                        }
                        rsa_raw(&data, key.e(), key.n())?
                    }
                    RSA_PKCS1_OAEP_PADDING => key
                        .encrypt(&mut OsRng, oaep(hash, &label)?, &data)
                        .or_else(|_| data_too_large())?,
                    _ => key.encrypt(&mut OsRng, Pkcs1v15Encrypt, &data).or_else(|_| data_too_large())?,
                }
            }
            "privateDecrypt" => {
                let Private::Rsa(key) = Private::from_pkcs8(&der)? else { return keytype_unsupported() };
                match padding {
                    RSA_NO_PADDING => rsa_raw(&data, key.d(), key.n())?,
                    RSA_PKCS1_OAEP_PADDING => key.decrypt(oaep(hash, &label)?, &data).or_else(|_| failed_decrypt())?,
                    _ => key.decrypt(Pkcs1v15Encrypt, &data).or_else(|_| {
                        err::<Vec<u8>>("ERR_OSSL_RSA_PADDING_CHECK_FAILED", "error:0200009F:rsa routines::pkcs decoding error")
                    })?,
                }
            }
            "privateEncrypt" => {
                let Private::Rsa(key) = Private::from_pkcs8(&der)? else { return keytype_unsupported() };
                match padding {
                    RSA_NO_PADDING => rsa_raw(&data, key.d(), key.n())?,
                    _ => key.sign(Pkcs1v15Sign::new_unprefixed(), &data).or_else(|_| data_too_large())?,
                }
            }
            "publicDecrypt" => {
                let Public::Rsa(key) = public_of(&kind, &der)? else { return keytype_unsupported() };
                let raw = rsa_raw(&data, key.e(), key.n())?;
                if padding == RSA_NO_PADDING {
                    raw
                } else {
                    // EMSA-PKCS1-v1_5 type 1: 00 01 FF.. 00 <data>.
                    let bad = || err::<Vec<u8>>("ERR_OSSL_RSA_PADDING_CHECK_FAILED", "error:02000072:rsa routines::padding check failed");
                    if raw.len() < 11 || raw[0] != 0 || raw[1] != 1 {
                        bad()?
                    } else {
                        let mut i = 2;
                        while i < raw.len() && raw[i] == 0xff {
                            i += 1;
                        }
                        if i >= raw.len() || raw[i] != 0 || i < 10 {
                            bad()?
                        } else {
                            raw[i + 1..].to_vec()
                        }
                    }
                }
            }
            _ => return unsupported(),
        };
        ok_fields(&[b64(&out)])
    }
);

// ---------------------------------------------------------------------------
// ECDH and X25519
// ---------------------------------------------------------------------------

fn curve(name: &str) -> Res<Crv> {
    Crv::from_name(name).map_or_else(|| err("ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name"), Ok)
}

native!(
    /// `cryptoEcdhKeys(curve, privateKey)` → `+<private> US <public,
    /// uncompressed>`; a fresh key when `privateKey` is empty.
    ecdh_keys,
    |a| {
        let crv = curve(&a.s(0)?)?;
        let mut raw = a.bytes(1)?;
        if raw.is_empty() {
            raw = on_curve!(crv, generate());
        } else {
            raw = pad_to(raw, crv.size());
            if on_curve!(crv, check(&raw)).is_err() {
                return err("ERR_CRYPTO_INVALID_KEYTYPE", "Private key is not valid for specified curve.");
            }
        }
        let public = on_curve!(crv, public_of(&raw, false))?;
        ok_fields(&[b64(&raw), b64(&public)])
    }
);

native!(
    /// `cryptoEcdhCompute(curve, privateKey, peerPublic)` → `+<secret>`.
    ecdh_compute,
    |a| {
        let crv = curve(&a.s(0)?)?;
        let raw = a.bytes(1)?;
        let peer = a.bytes(2)?;
        ok_fields(&[b64(&on_curve!(crv, ecdh(&raw, &peer))?)])
    }
);

native!(
    /// `cryptoEcdhConvert(curve, point, compressed)` → `+<point>`.
    ecdh_convert,
    |a| {
        let crv = curve(&a.s(0)?)?;
        let point = a.bytes(1)?;
        let compressed = a.b(2);
        ok_fields(&[b64(&on_curve!(crv, convert(&point, compressed))?)])
    }
);

native!(
    /// `cryptoDiffieHellmanKeys(pkcs8, spki)` → `+<secret>`, the stateless
    /// `crypto.diffieHellman({ privateKey, publicKey })`.
    diffie_hellman_keys,
    |a| {
        let private = Private::from_pkcs8(&a.bytes(0)?)?;
        let public = Public::from_spki(&a.bytes(1)?)?;
        let secret = match (&private, &public) {
            (Private::Ec(c1, raw), Public::Ec(c2, point)) if c1 == c2 => on_curve!(*c1, ecdh(raw, point))?,
            (Private::X25519(raw), Public::X25519(peer)) => {
                let secret = x25519_dalek::StaticSecret::from(*raw);
                secret.diffie_hellman(&x25519_dalek::PublicKey::from(*peer)).to_bytes().to_vec()
            }
            (Private::X448(raw), Public::X448(peer)) => {
                let out = ff::x448(raw, peer);
                if out.iter().all(|b| *b == 0) {
                    return err("ERR_CRYPTO_OPERATION_FAILED", "Failed to derive shared secret");
                }
                out.to_vec()
            }
            (Private::Dh(p1, g1, x), Public::Dh(p2, g2, y)) if p1 == p2 && g1 == g2 => {
                pad_to(y.modpow(x, p1).to_bytes_be(), p1.bits().div_ceil(8))
            }
            (Private::Ec(..), Public::Ec(..)) | (Private::Dh(..), Public::Dh(..)) => {
                return err("ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS", "error:1C800071:Provider routines::mismatching domain parameters")
            }
            _ => return err("ERR_CRYPTO_INCOMPATIBLE_KEY", "Incompatible key types for Diffie-Hellman: The keys must be of the same type."),
        };
        ok_fields(&[b64(&secret)])
    }
);

// ---------------------------------------------------------------------------
// Finite-field Diffie-Hellman
// ---------------------------------------------------------------------------

/// `floor(pi * 2^bits)`, by Machin's formula in fixed point.
fn pi_fixed(bits: usize) -> BigUint {
    let guard = 64;
    let one = BigUint::from(1u8) << (bits + guard);
    let atan_inv = |x: u32| -> (BigUint, BigUint) {
        // atan(1/x) = sum (-1)^k / ((2k+1) x^(2k+1)), returned as (positive
        // terms, negative terms).
        let x2 = BigUint::from(x * x);
        let mut power = &one / BigUint::from(x);
        let mut plus = BigUint::from(0u8);
        let mut minus = BigUint::from(0u8);
        let mut k = 0u32;
        while power > BigUint::from(0u8) {
            let term = &power / BigUint::from(2 * k + 1);
            if k % 2 == 0 {
                plus += term;
            } else {
                minus += term;
            }
            power /= &x2;
            k += 1;
        }
        (plus, minus)
    };
    let (p5, m5) = atan_inv(5);
    let (p239, m239) = atan_inv(239);
    let value = (p5 * 16u32 + m239 * 4u32) - (m5 * 16u32 + p239 * 4u32);
    value >> guard
}

/// The RFC 2409 / RFC 3526 MODP primes:
/// `2^n - 2^(n-64) - 1 + 2^64 * (floor(2^(n-130) * pi) + k)`.
fn modp_prime(name: &str) -> Option<BigUint> {
    let (n, k): (usize, u64) = match name {
        "modp1" => (768, 149686),
        "modp2" => (1024, 129093),
        "modp5" => (1536, 741804),
        "modp14" => (2048, 124476),
        "modp15" => (3072, 1690314),
        "modp16" => (4096, 240904),
        "modp17" => (6144, 929484),
        "modp18" => (8192, 4743158),
        _ => return None,
    };
    let one = BigUint::from(1u8);
    let core = (pi_fixed(n - 130) + BigUint::from(k)) << 64;
    Some((&one << n) - (&one << (n - 64)) - &one + core)
}

native!(
    /// `cryptoDhGroup(name)` → `+<prime>`.
    dh_group,
    |a| {
        match modp_prime(&a.s(0)?) {
            Some(prime) => ok_fields(&[b64(&prime.to_bytes_be())]),
            None => err("ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group"),
        }
    }
);

native!(
    /// `cryptoModPow(base, exponent, modulus)` → `+<result>`, padded to the
    /// modulus' size.
    mod_pow,
    |a| {
        let base = big(&a.bytes(0)?);
        let exp = big(&a.bytes(1)?);
        let modulus = big(&a.bytes(2)?);
        if modulus == BigUint::from(0u8) {
            return err("ERR_CRYPTO_INVALID_STATE", "Invalid modulus");
        }
        let size = modulus.bits().div_ceil(8);
        ok_fields(&[b64(&pad_to(base.modpow(&exp, &modulus).to_bytes_be(), size))])
    }
);

native!(
    /// `cryptoGeneratePrime(bits)` → `+<prime>`.
    generate_prime,
    |a| {
        let bits = a.i(0);
        if !(2..=16384).contains(&bits) {
            return err("ERR_OSSL_BN_BITS_TOO_SMALL", "bits too small");
        }
        let prime: BigUint = OsRng.gen_prime(bits as usize);
        ok_fields(&[b64(&prime.to_bytes_be())])
    }
);

native!(
    /// `cryptoGeneratePrimeEx(bits, safe, add, rem)` → `+<prime>`: Node's
    /// `generatePrime(size, { safe, add, rem })`. `add`/`rem` are base64
    /// big-endian, empty when absent; `rem` defaults to 1 (3 for a safe
    /// prime), as in OpenSSL's `BN_generate_prime_ex`.
    generate_prime_ex,
    |a| {
        let bits = a.i(0);
        let safe = a.b(1);
        let add = a.bytes(2)?;
        let rem = a.bytes(3)?;
        if !(2..=16384).contains(&bits) {
            return err("ERR_OUT_OF_RANGE", "invalid prime size");
        }
        let bits = bits as usize;
        let one = BigUint::from(1u8);
        let add = if add.is_empty() { None } else { Some(big(&add)) };
        let rem = if rem.is_empty() {
            BigUint::from(if safe && add.is_some() { 3u8 } else { 1u8 })
        } else {
            big(&rem)
        };
        if let Some(add) = &add {
            if add.bits() > bits || &rem >= add {
                return err("ERR_OUT_OF_RANGE", "invalid options.add");
            }
        }
        if add.is_none() && !safe {
            let prime: BigUint = OsRng.gen_prime(bits);
            return ok_fields(&[b64(&prime.to_bytes_be())]);
        }
        for _ in 0..1_000_000 {
            let mut p = OsRng.gen_biguint(bits);
            p |= &one << (bits - 1);
            match &add {
                Some(add) => {
                    p = &p - (&p % add) + &rem;
                }
                None => p |= one.clone(),
            }
            if p.bits() != bits || !num_bigint_dig::prime::probably_prime(&p, 20) {
                continue;
            }
            if safe && !num_bigint_dig::prime::probably_prime(&((&p - &one) >> 1), 20) {
                continue;
            }
            return ok_fields(&[b64(&p.to_bytes_be())]);
        }
        err("ERR_OSSL_BN_NO_PRIME_CANDIDATE", "no prime candidate")
    }
);

native!(
    /// `cryptoCheckPrime(candidate, checks)` → `+1` / `+0`.
    check_prime,
    |a| {
        let candidate = big(&a.bytes(0)?);
        let checks = a.i(1).max(20) as usize;
        let prime = num_bigint_dig::prime::probably_prime(&candidate, checks);
        ok_fields(&[if prime { "1".into() } else { "0".into() }])
    }
);

native!(
    /// `cryptoDhCheck(prime, generator)` → `+<flags>`, OpenSSL's `DH_check`
    /// bits: `DH_CHECK_P_NOT_PRIME` (1), `DH_CHECK_P_NOT_SAFE_PRIME` (2),
    /// `DH_NOT_SUITABLE_GENERATOR` (8).
    dh_check,
    |a| {
        let p = big(&a.bytes(0)?);
        let g = big(&a.bytes(1)?);
        let one = BigUint::from(1u8);
        let two = BigUint::from(2u8);
        let mut flags = 0u32;
        if !num_bigint_dig::prime::probably_prime(&p, 20) {
            flags |= 1;
        } else if p <= two || !num_bigint_dig::prime::probably_prime(&((&p - &one) >> 1), 20) {
            flags |= 2;
        }
        if g < two || p < two || g > &p - &two {
            flags |= 8;
        }
        ok_fields(&[flags.to_string()])
    }
);

// ---------------------------------------------------------------------------
// SPKAC (`crypto.Certificate`)
// ---------------------------------------------------------------------------

/// The pieces of a Netscape `SignedPublicKeyAndChallenge`:
/// `(publicKeyAndChallenge DER, spki DER, challenge, signature algorithm OID
/// DER content, signature)`.
fn parse_spkac(der: &[u8]) -> Option<(Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>)> {
    let (tag, outer, outer_end) = ff::tlv(der, 0)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, pkac_start, pkac_end) = ff::tlv(der, outer)?;
    if tag != 0x30 {
        return None;
    }
    let pkac = der[outer..pkac_end].to_vec();
    let (_, _, spki_end) = ff::tlv(der, pkac_start)?;
    let spki = der[pkac_start..spki_end].to_vec();
    let (tag, ch_start, ch_end) = ff::tlv(der, spki_end)?;
    if tag != 0x16 {
        return None;
    }
    let challenge = der[ch_start..ch_end].to_vec();
    let (tag, alg_start, alg_end) = ff::tlv(der, pkac_end)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, oid_start, oid_end) = ff::tlv(der, alg_start)?;
    if tag != 0x06 {
        return None;
    }
    let oid = der[oid_start..oid_end].to_vec();
    let (tag, sig_start, sig_end) = ff::tlv(der, alg_end)?;
    if tag != 0x03 || sig_end > outer_end || sig_start >= sig_end {
        return None;
    }
    let sig = der[sig_start + 1..sig_end].to_vec();
    Some((pkac, spki, challenge, oid, sig))
}

/// The digest of a `*WithRSAEncryption` signature algorithm OID.
fn rsa_sig_alg(oid: &[u8]) -> Option<Alg> {
    let prefix = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01];
    if oid.len() != 9 || oid[..8] != prefix {
        return None;
    }
    Some(match oid[8] {
        4 => Alg::Md5,
        5 => Alg::Sha1,
        11 => Alg::Sha256,
        12 => Alg::Sha384,
        13 => Alg::Sha512,
        14 => Alg::Sha224,
        _ => return None,
    })
}

native!(
    /// `cryptoSpkac(op, data)` with `data` the base64 of the SPKAC text
    /// (itself base64). `op` is `verify` (→ `+1`/`+0`), `publicKey` (→ the
    /// SPKI, base64) or `challenge` (→ its bytes, base64); a malformed SPKAC
    /// answers `+` with an empty field.
    spkac,
    |a| {
        let op = a.s(0)?;
        let text = a.bytes(1)?;
        let cleaned: String = String::from_utf8_lossy(&text).chars().filter(|c| !c.is_whitespace()).collect();
        let der = base64::decode(&cleaned);
        let Some((pkac, spki, challenge, oid, sig)) = parse_spkac(&der) else {
            return ok_fields(&[if op == "verify" { "0".into() } else { String::new() }]);
        };
        match op.as_str() {
            "verify" => {
                let good = match (Public::from_spki(&spki), rsa_sig_alg(&oid)) {
                    (Ok(Public::Rsa(key)), Some(alg)) => rsa_verify(&key, Some(alg), &pkac, &sig, &sig_opts("")),
                    _ => false,
                };
                ok_fields(&[if good { "1".into() } else { "0".into() }])
            }
            "publicKey" => match Public::from_spki(&spki) {
                Ok(_) => ok_fields(&[b64(&spki)]),
                Err(_) => ok_fields(&[String::new()]),
            },
            _ => ok_fields(&[b64(&challenge)]),
        }
    }
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modp2_matches_rfc2409() {
        let p = modp_prime("modp2").unwrap().to_bytes_be();
        assert_eq!(p.len(), 128);
        assert_eq!(&p[..12], &[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xc9, 0x0f, 0xda, 0xa2]);
        assert_eq!(&p[116..], &[0xec, 0xe6, 0x53, 0x81, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn modp14_tail() {
        let p = modp_prime("modp14").unwrap().to_bytes_be();
        assert_eq!(p.len(), 256);
        assert_eq!(&p[240..], &[0x15, 0x72, 0x8e, 0x5a, 0x8a, 0xac, 0xaa, 0x68, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    }

    #[test]
    fn sha256_digest_info_prefix() {
        let p = digest_info_prefix(Alg::Sha256).unwrap();
        assert_eq!(
            p,
            &[0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20]
        );
    }

    #[test]
    fn rsa_round_trip_through_pkcs8() {
        let key = RsaPrivateKey::new(&mut OsRng, 512).unwrap();
        let private = Private::Rsa(Box::new(key));
        let der = private.to_pkcs8().unwrap();
        let back = Private::from_pkcs8(&der).unwrap();
        let o = sig_opts("1");
        let Private::Rsa(rsa) = &back else { panic!() };
        let sig = rsa_sign(rsa, Some(Alg::Sha256), b"hi", &o).unwrap();
        assert!(rsa_verify(&rsa.to_public_key(), Some(Alg::Sha256), b"hi", &sig, &o));
    }

    #[test]
    fn x25519_and_ed25519_framing_round_trip() {
        let raw = random32();
        let der = Private::X25519(raw).to_pkcs8().unwrap();
        assert!(matches!(Private::from_pkcs8(&der).unwrap(), Private::X25519(r) if r == raw));
        let spki = Private::Ed25519(raw).public().unwrap().to_spki().unwrap();
        assert!(matches!(Public::from_spki(&spki).unwrap(), Public::Ed25519(_)));
    }

    #[test]
    fn ec_sec1_and_pem() {
        let raw = c_k256::generate();
        let sec1 = sec1_with_params(&c_k256::to_sec1(&raw).unwrap(), Crv::K256);
        assert!(matches!(ec_from_sec1(&sec1).unwrap(), Private::Ec(Crv::K256, _)));
        let raw = c_p256::generate();
        let sec1 = c_p256::to_sec1(&raw).unwrap();
        assert!(matches!(ec_from_sec1(&sec1).unwrap(), Private::Ec(Crv::P256, _)));
        let pem = to_pem("EC PRIVATE KEY", &[], &sec1);
        let parsed = parse_pem(&pem).unwrap();
        assert_eq!(parsed.body, sec1);
    }
}

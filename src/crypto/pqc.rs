//! The post-quantum key families of `node:crypto`: ML-DSA (FIPS 204) and
//! ML-KEM (FIPS 203), over RustCrypto's pure-Rust `ml-dsa` / `ml-kem` crates.
//!
//! Keys cross the boundary in the same canonical PKCS#8 / SPKI documents as
//! every other key (see `asym.rs`), using the IETF LAMPS encodings OpenSSL 3.5
//! writes:
//!
//! - SPKI: `AlgorithmIdentifier { oid }` (no parameters) and the raw public
//!   key as the BIT STRING;
//! - PKCS#8: the private-key OCTET STRING holds one of the three `CHOICE`
//!   forms — `seed [0] IMPLICIT OCTET STRING`, `expandedKey OCTET STRING`, or
//!   `both SEQUENCE { seed, expandedKey }`. A key that knows its seed is
//!   always written as `both` (OpenSSL's default output form), and one that
//!   does not as `expandedKey`.

use ml_dsa::{MlDsa44, MlDsa65, MlDsa87, MlDsaParams};

/// One post-quantum parameter set.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PqAlg {
    MlDsa44,
    MlDsa65,
    MlDsa87,
    MlKem512,
    MlKem768,
    MlKem1024,
}

const ALL: [PqAlg; 6] = [
    PqAlg::MlDsa44,
    PqAlg::MlDsa65,
    PqAlg::MlDsa87,
    PqAlg::MlKem512,
    PqAlg::MlKem768,
    PqAlg::MlKem1024,
];

impl PqAlg {
    /// Node's `asymmetricKeyType`.
    pub(crate) fn name(self) -> &'static str {
        match self {
            PqAlg::MlDsa44 => "ml-dsa-44",
            PqAlg::MlDsa65 => "ml-dsa-65",
            PqAlg::MlDsa87 => "ml-dsa-87",
            PqAlg::MlKem512 => "ml-kem-512",
            PqAlg::MlKem768 => "ml-kem-768",
            PqAlg::MlKem1024 => "ml-kem-1024",
        }
    }

    pub(crate) fn from_name(name: &str) -> Option<PqAlg> {
        ALL.iter().copied().find(|alg| alg.name() == name)
    }

    pub(crate) fn oid(self) -> &'static str {
        match self {
            PqAlg::MlDsa44 => "2.16.840.1.101.3.4.3.17",
            PqAlg::MlDsa65 => "2.16.840.1.101.3.4.3.18",
            PqAlg::MlDsa87 => "2.16.840.1.101.3.4.3.19",
            PqAlg::MlKem512 => "2.16.840.1.101.3.4.4.1",
            PqAlg::MlKem768 => "2.16.840.1.101.3.4.4.2",
            PqAlg::MlKem1024 => "2.16.840.1.101.3.4.4.3",
        }
    }

    pub(crate) fn from_oid(oid: &str) -> Option<PqAlg> {
        ALL.iter().copied().find(|alg| alg.oid() == oid)
    }

    fn oid_der(self) -> Vec<u8> {
        let (arc, last) = match self {
            PqAlg::MlDsa44 => (3, 17),
            PqAlg::MlDsa65 => (3, 18),
            PqAlg::MlDsa87 => (3, 19),
            PqAlg::MlKem512 => (4, 1),
            PqAlg::MlKem768 => (4, 2),
            PqAlg::MlKem1024 => (4, 3),
        };
        vec![0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, arc, last]
    }

    pub(crate) fn is_dsa(self) -> bool {
        matches!(self, PqAlg::MlDsa44 | PqAlg::MlDsa65 | PqAlg::MlDsa87)
    }

    pub(crate) fn seed_len(self) -> usize {
        if self.is_dsa() {
            32
        } else {
            64
        }
    }

    pub(crate) fn public_len(self) -> usize {
        match self {
            PqAlg::MlDsa44 => 1312,
            PqAlg::MlDsa65 => 1952,
            PqAlg::MlDsa87 => 2592,
            PqAlg::MlKem512 => 800,
            PqAlg::MlKem768 => 1184,
            PqAlg::MlKem1024 => 1568,
        }
    }
}

/// A parsed private key. `expanded` is always present (derived from the seed
/// when only the seed was given); `seed` is kept when known.
#[derive(Clone)]
pub(crate) struct PqPrivate {
    pub(crate) alg: PqAlg,
    pub(crate) seed: Option<Vec<u8>>,
    pub(crate) expanded: Vec<u8>,
}

fn tlv(tag: u8, body: &[u8]) -> Vec<u8> {
    super::ff::tlv_bytes(tag, body)
}

/// `(tag, body)` of the single TLV that is the whole of `der`.
fn single(der: &[u8]) -> Option<(u8, &[u8])> {
    let (tag, start, end) = super::ff::tlv(der, 0)?;
    if end != der.len() {
        return None;
    }
    Some((tag, &der[start..end]))
}

macro_rules! dsa {
    ($alg:expr, $f:ident($($arg:expr),*)) => {
        match $alg {
            PqAlg::MlDsa44 => $f::<MlDsa44>($($arg),*),
            PqAlg::MlDsa65 => $f::<MlDsa65>($($arg),*),
            PqAlg::MlDsa87 => $f::<MlDsa87>($($arg),*),
            _ => None,
        }
    };
}

macro_rules! kem {
    ($alg:expr, $f:ident($($arg:expr),*)) => {
        match $alg {
            PqAlg::MlKem512 => kem512::$f($($arg),*),
            PqAlg::MlKem768 => kem768::$f($($arg),*),
            PqAlg::MlKem1024 => kem1024::$f($($arg),*),
            _ => None,
        }
    };
}

fn dsa_expand<P: MlDsaParams>(seed: &[u8]) -> Option<Vec<u8>> {
    let seed: ml_dsa::Seed = seed.try_into().ok()?;
    #[allow(deprecated)]
    let bytes = ml_dsa::ExpandedSigningKey::<P>::from_seed(&seed).to_expanded();
    Some(bytes.to_vec())
}

#[allow(deprecated)]
fn dsa_signing<P: MlDsaParams>(expanded: &[u8]) -> Option<ml_dsa::ExpandedSigningKey<P>> {
    let enc: ml_dsa::ExpandedSigningKeyBytes<P> = expanded.try_into().ok()?;
    Some(ml_dsa::ExpandedSigningKey::<P>::from_expanded(&enc))
}

fn dsa_public<P: MlDsaParams>(expanded: &[u8]) -> Option<Vec<u8>> {
    Some(dsa_signing::<P>(expanded)?.verifying_key().encode().to_vec())
}

fn dsa_sign<P: MlDsaParams>(expanded: &[u8], msg: &[u8], ctx: &[u8], rnd: &[u8; 32]) -> Option<Vec<u8>> {
    let key = dsa_signing::<P>(expanded)?;
    let header = [0u8, ctx.len() as u8];
    let rnd: ml_dsa::B32 = (&rnd[..]).try_into().ok()?;
    Some(key.sign_internal(&[&header, ctx, msg], &rnd).encode().to_vec())
}

fn dsa_verify<P: MlDsaParams>(public: &[u8], msg: &[u8], ctx: &[u8], sig: &[u8]) -> Option<bool> {
    let enc: ml_dsa::EncodedVerifyingKey<P> = public.try_into().ok()?;
    let key = ml_dsa::VerifyingKey::<P>::decode(&enc);
    let Ok(sig) = <ml_dsa::EncodedSignature<P>>::try_from(sig) else { return Some(false) };
    let Some(sig) = ml_dsa::Signature::<P>::decode(&sig) else { return Some(false) };
    Some(key.verify_with_context(msg, ctx, &sig))
}

fn dsa_public_ok<P: MlDsaParams>(public: &[u8]) -> Option<()> {
    let _: ml_dsa::EncodedVerifyingKey<P> = public.try_into().ok()?;
    Some(())
}

// `ml-kem`'s parameter trait is not public, so the KEM operations are
// expanded per concrete parameter set instead of being generic.
macro_rules! kem_fns {
    ($module:ident, $p:ty) => {
        mod $module {
            #![allow(deprecated)]
            use ml_kem::{ExpandedKeyEncoding, KeyExport};
            type P = $p;

            pub(super) fn expand(seed: &[u8]) -> Option<Vec<u8>> {
                let seed: ml_kem::Seed = seed.try_into().ok()?;
                Some(ml_kem::DecapsulationKey::<P>::from_seed(seed).to_expanded_bytes().to_vec())
            }

            fn decaps_key(expanded: &[u8]) -> Option<ml_kem::DecapsulationKey<P>> {
                let enc: ml_kem::ExpandedDecapsulationKey<P> = expanded.try_into().ok()?;
                ml_kem::DecapsulationKey::<P>::from_expanded(&enc).ok()
            }

            pub(super) fn public(expanded: &[u8]) -> Option<Vec<u8>> {
                Some(decaps_key(expanded)?.encapsulation_key().to_bytes().to_vec())
            }

            fn encaps_key(public: &[u8]) -> Option<ml_kem::EncapsulationKey<P>> {
                let enc = public.try_into().ok()?;
                ml_kem::EncapsulationKey::<P>::new(&enc).ok()
            }

            pub(super) fn public_ok(public: &[u8]) -> Option<()> {
                encaps_key(public).map(|_| ())
            }

            pub(super) fn encapsulate(public: &[u8], m: &[u8; 32]) -> Option<(Vec<u8>, Vec<u8>)> {
                let key = encaps_key(public)?;
                let m: ml_kem::B32 = (&m[..]).try_into().ok()?;
                let (ct, ss) = key.encapsulate_deterministic(&m);
                Some((ss.to_vec(), ct.to_vec()))
            }

            pub(super) fn decapsulate(expanded: &[u8], ct: &[u8]) -> Option<Vec<u8>> {
                use ml_kem::kem::Decapsulate;
                let key = decaps_key(expanded)?;
                let ct: ml_kem::Ciphertext<P> = ct.try_into().ok()?;
                Some(key.decapsulate(&ct).to_vec())
            }
        }
    };
}

kem_fns!(kem512, ml_kem::MlKem512);
kem_fns!(kem768, ml_kem::MlKem768);
kem_fns!(kem1024, ml_kem::MlKem1024);

/// The expanded private key a seed generates.
pub(crate) fn expand(alg: PqAlg, seed: &[u8]) -> Option<Vec<u8>> {
    if seed.len() != alg.seed_len() {
        return None;
    }
    if alg.is_dsa() {
        dsa!(alg, dsa_expand(seed))
    } else {
        kem!(alg, expand(seed))
    }
}

/// A fresh private key.
pub(crate) fn generate(alg: PqAlg) -> Option<PqPrivate> {
    let mut seed = vec![0u8; alg.seed_len()];
    getrandom::getrandom(&mut seed).ok()?;
    let expanded = expand(alg, &seed)?;
    Some(PqPrivate { alg, seed: Some(seed), expanded })
}

/// Validate a raw public key for `alg`.
pub(crate) fn check_public(alg: PqAlg, public: &[u8]) -> bool {
    if alg.is_dsa() {
        dsa!(alg, dsa_public_ok(public)).is_some()
    } else {
        kem!(alg, public_ok(public)).is_some()
    }
}

impl PqPrivate {
    /// Parse the PKCS#8 `privateKey` OCTET STRING contents.
    pub(crate) fn from_inner(alg: PqAlg, inner: &[u8]) -> Option<PqPrivate> {
        let (tag, body) = single(inner)?;
        let (seed, expanded) = match tag {
            0x80 => (Some(body.to_vec()), None),
            0x04 => (None, Some(body.to_vec())),
            0x30 => {
                let (t1, s1, e1) = super::ff::tlv(body, 0)?;
                let (t2, s2, e2) = super::ff::tlv(body, e1)?;
                if t1 != 0x04 || t2 != 0x04 || e2 != body.len() {
                    return None;
                }
                (Some(body[s1..e1].to_vec()), Some(body[s2..e2].to_vec()))
            }
            _ => return None,
        };
        let expanded = match (&seed, expanded) {
            (Some(seed), Some(expanded)) => {
                // OpenSSL rejects a `both` encoding whose halves disagree.
                if expand(alg, seed)? != expanded {
                    return None;
                }
                expanded
            }
            (Some(seed), None) => expand(alg, seed)?,
            (None, Some(expanded)) => {
                // Validate by deriving the public key.
                PqPrivate { alg, seed: None, expanded: expanded.clone() }.public()?;
                expanded
            }
            (None, None) => return None,
        };
        Some(PqPrivate { alg, seed, expanded })
    }

    pub(crate) fn to_pkcs8(&self) -> Vec<u8> {
        let inner = match &self.seed {
            Some(seed) => {
                let mut both = tlv(0x04, seed);
                both.extend(tlv(0x04, &self.expanded));
                tlv(0x30, &both)
            }
            None => tlv(0x04, &self.expanded),
        };
        let mut body = vec![0x02, 0x01, 0x00];
        body.extend(tlv(0x30, &self.alg.oid_der()));
        body.extend(tlv(0x04, &inner));
        tlv(0x30, &body)
    }

    pub(crate) fn public(&self) -> Option<Vec<u8>> {
        if self.alg.is_dsa() {
            dsa!(self.alg, dsa_public(&self.expanded))
        } else {
            kem!(self.alg, public(&self.expanded))
        }
    }

    /// ML-DSA.Sign (hedged), with the FIPS 204 context string.
    pub(crate) fn sign(&self, msg: &[u8], ctx: &[u8]) -> Option<Vec<u8>> {
        if ctx.len() > 255 {
            return None;
        }
        let mut rnd = [0u8; 32];
        getrandom::getrandom(&mut rnd).ok()?;
        dsa!(self.alg, dsa_sign(&self.expanded, msg, ctx, &rnd))
    }

    /// ML-KEM.Decaps; `None` for a ciphertext of the wrong length.
    pub(crate) fn decapsulate(&self, ct: &[u8]) -> Option<Vec<u8>> {
        kem!(self.alg, decapsulate(&self.expanded, ct))
    }
}

pub(crate) fn spki(alg: PqAlg, public: &[u8]) -> Vec<u8> {
    let mut bits = vec![0u8];
    bits.extend_from_slice(public);
    let mut body = tlv(0x30, &alg.oid_der());
    body.extend(tlv(0x03, &bits));
    tlv(0x30, &body)
}

/// ML-DSA.Verify with the FIPS 204 context string.
pub(crate) fn verify(alg: PqAlg, public: &[u8], msg: &[u8], ctx: &[u8], sig: &[u8]) -> bool {
    if ctx.len() > 255 {
        return false;
    }
    dsa!(alg, dsa_verify(public, msg, ctx, sig)).unwrap_or(false)
}

/// ML-KEM.Encaps: `(shared secret, ciphertext)`.
pub(crate) fn encapsulate(alg: PqAlg, public: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut m = [0u8; 32];
    getrandom::getrandom(&mut m).ok()?;
    kem!(alg, encapsulate(public, &m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        for alg in ALL {
            let key = generate(alg).unwrap();
            let public = key.public().unwrap();
            assert_eq!(public.len(), alg.public_len());
            assert!(check_public(alg, &public));
            if alg.is_dsa() {
                let sig = key.sign(b"msg", b"").unwrap();
                assert!(verify(alg, &public, b"msg", b"", &sig));
                assert!(!verify(alg, &public, b"msh", b"", &sig));
            } else {
                let (ss, ct) = encapsulate(alg, &public).unwrap();
                assert_eq!(key.decapsulate(&ct).unwrap(), ss);
            }
            let expanded_only = PqPrivate { alg, seed: None, expanded: key.expanded.clone() };
            assert_eq!(expanded_only.public().unwrap(), public);
        }
    }
}

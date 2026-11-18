//! The arithmetic behind the key families `asym.rs` dispatches to but no
//! RustCrypto crate covers in the shape Node needs: DSA (any `L`/`N`,
//! including the 1025-bit fixture keys OpenSSL accepts), the X9.42 `dh` key
//! documents, and X448 (RFC 7748). Ed448 signatures come from
//! `ed448-goldilocks-plus` and are wrapped here so `asym.rs` sees byte arrays
//! only.
//!
//! Everything here is plain `BigUint` work; none of it is constant-time,
//! which matches what this extension promises (see `asym.rs`).

use num_bigint_dig::{BigUint, RandBigInt, RandPrime};
use rand_core::OsRng;

// ---------------------------------------------------------------------------
// DER
// ---------------------------------------------------------------------------

pub(super) fn der_len(len: usize) -> Vec<u8> {
    if len < 0x80 {
        return vec![len as u8];
    }
    let bytes: Vec<u8> = len.to_be_bytes().iter().copied().skip_while(|b| *b == 0).collect();
    let mut out = vec![0x80 | bytes.len() as u8];
    out.extend(bytes);
    out
}

pub(super) fn tlv_bytes(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    out.extend(der_len(body.len()));
    out.extend_from_slice(body);
    out
}

/// A DER `INTEGER` for a non-negative value.
pub(super) fn der_uint(value: &BigUint) -> Vec<u8> {
    let mut body = value.to_bytes_be();
    if body.is_empty() {
        body.push(0);
    }
    if body[0] & 0x80 != 0 {
        body.insert(0, 0);
    }
    tlv_bytes(0x02, &body)
}

/// One TLV at `at`: `(tag, content start, content end)`.
pub(super) fn tlv(der: &[u8], at: usize) -> Option<(u8, usize, usize)> {
    let tag = *der.get(at)?;
    let first = *der.get(at + 1)? as usize;
    let (len, start) = if first < 0x80 {
        (first, at + 2)
    } else {
        let count = first & 0x7f;
        if count > 4 {
            return None;
        }
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

/// The `INTEGER`s that make up `content` (the inside of a `SEQUENCE`), in
/// order; `None` when anything else is found.
pub(super) fn ints(content: &[u8]) -> Option<Vec<BigUint>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < content.len() {
        let (tag, start, end) = tlv(content, at)?;
        if tag != 0x02 {
            return None;
        }
        out.push(BigUint::from_bytes_be(&content[start..end]));
        at = end;
    }
    Some(out)
}

/// The `INTEGER`s of the `SEQUENCE` that is the whole of `der`.
pub(super) fn seq_ints(der: &[u8]) -> Option<Vec<BigUint>> {
    let (tag, start, end) = tlv(der, 0)?;
    if tag != 0x30 || end != der.len() {
        return None;
    }
    ints(&der[start..end])
}

pub(super) fn seq_of(items: &[&BigUint]) -> Vec<u8> {
    let mut body = Vec::new();
    for item in items {
        body.extend(der_uint(item));
    }
    tlv_bytes(0x30, &body)
}

// ---------------------------------------------------------------------------
// DSA (FIPS 186-4)
// ---------------------------------------------------------------------------

#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) struct DsaParams {
    pub p: BigUint,
    pub q: BigUint,
    pub g: BigUint,
}

pub(super) const DSA_OID_DER: &[u8] = &[0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x38, 0x04, 0x01];
pub(super) const DH_OID_DER: &[u8] =
    &[0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x03, 0x01];

/// A random value in `[1, n)`.
fn random_below(n: &BigUint) -> BigUint {
    let one = BigUint::from(1u8);
    OsRng.gen_biguint_range(&one, n)
}

fn mod_inverse(a: &BigUint, m: &BigUint) -> Option<BigUint> {
    // `m` is prime everywhere this is used.
    let two = BigUint::from(2u8);
    if a == &BigUint::from(0u8) {
        return None;
    }
    Some(a.modpow(&(m - &two), m))
}

/// The leftmost `min(N, outlen)` bits of `hash`, as an integer.
fn dsa_z(q: &BigUint, hash: &[u8]) -> BigUint {
    let n = q.bits();
    let mut z = BigUint::from_bytes_be(hash);
    let hash_bits = hash.len() * 8;
    if hash_bits > n {
        z >>= hash_bits - n;
    }
    z
}

pub(super) fn dsa_public(params: &DsaParams, x: &BigUint) -> BigUint {
    params.g.modpow(x, &params.p)
}

/// Sign a digest: DER `Dss-Sig-Value`, or `r || s` (IEEE P1363).
pub(super) fn dsa_sign(params: &DsaParams, x: &BigUint, hash: &[u8], p1363: bool) -> Vec<u8> {
    let zero = BigUint::from(0u8);
    let z = dsa_z(&params.q, hash);
    loop {
        let k = random_below(&params.q);
        let r = params.g.modpow(&k, &params.p) % &params.q;
        if r == zero {
            continue;
        }
        let Some(k_inv) = mod_inverse(&k, &params.q) else { continue };
        let s = (k_inv * ((&z + x * &r) % &params.q)) % &params.q;
        if s == zero {
            continue;
        }
        return encode_rs(&r, &s, params.q.bits().div_ceil(8), p1363);
    }
}

pub(super) fn encode_rs(r: &BigUint, s: &BigUint, size: usize, p1363: bool) -> Vec<u8> {
    if p1363 {
        let mut out = pad(r.to_bytes_be(), size);
        out.extend(pad(s.to_bytes_be(), size));
        out
    } else {
        seq_of(&[r, s])
    }
}

fn pad(mut bytes: Vec<u8>, len: usize) -> Vec<u8> {
    if bytes.len() < len {
        let mut out = vec![0u8; len - bytes.len()];
        out.append(&mut bytes);
        bytes = out;
    }
    bytes
}

pub(super) fn dsa_verify(params: &DsaParams, y: &BigUint, hash: &[u8], sig: &[u8], p1363: bool) -> bool {
    let size = params.q.bits().div_ceil(8);
    let (r, s) = if p1363 {
        if sig.len() != 2 * size {
            return false;
        }
        (BigUint::from_bytes_be(&sig[..size]), BigUint::from_bytes_be(&sig[size..]))
    } else {
        match seq_ints(sig) {
            Some(v) if v.len() == 2 => (v[0].clone(), v[1].clone()),
            _ => return false,
        }
    };
    let zero = BigUint::from(0u8);
    if r == zero || s == zero || r >= params.q || s >= params.q {
        return false;
    }
    let Some(w) = mod_inverse(&s, &params.q) else { return false };
    let z = dsa_z(&params.q, hash);
    let u1 = (&z * &w) % &params.q;
    let u2 = (&r * &w) % &params.q;
    let v = ((params.g.modpow(&u1, &params.p) * y.modpow(&u2, &params.p)) % &params.p) % &params.q;
    v == r
}

/// Domain parameters for an `L`-bit `p` and an `N`-bit `q` (FIPS 186-4
/// A.1.1.2's search, without the seed bookkeeping nobody here can observe).
pub(super) fn dsa_generate(l: usize, n: usize) -> DsaParams {
    let one = BigUint::from(1u8);
    let q: BigUint = OsRng.gen_prime(n);
    let two_q = &q << 1;
    let p = loop {
        let mut x = OsRng.gen_biguint(l);
        x |= &one << (l - 1);
        let c = &x % &two_q;
        let p = x - c + &one;
        if p.bits() == l && num_bigint_dig::prime::probably_prime(&p, 30) {
            break p;
        }
    };
    let e = (&p - &one) / &q;
    let mut h = BigUint::from(2u8);
    let g = loop {
        let g = h.modpow(&e, &p);
        if g > one {
            break g;
        }
        h += &one;
    };
    DsaParams { p, q, g }
}

pub(super) fn random_private(q: &BigUint) -> BigUint {
    random_below(q)
}

// ---------------------------------------------------------------------------
// X448 (RFC 7748 §5)
// ---------------------------------------------------------------------------

fn p448() -> BigUint {
    (BigUint::from(1u8) << 448) - (BigUint::from(1u8) << 224) - BigUint::from(1u8)
}

fn le(bytes: &[u8]) -> BigUint {
    BigUint::from_bytes_le(bytes)
}

fn to_le56(value: &BigUint) -> [u8; 56] {
    let mut out = [0u8; 56];
    let bytes = value.to_bytes_le();
    out[..bytes.len().min(56)].copy_from_slice(&bytes[..bytes.len().min(56)]);
    out
}

/// `X448(k, u)`.
pub(super) fn x448(scalar: &[u8; 56], u: &[u8; 56]) -> [u8; 56] {
    let p = p448();
    let mut k = *scalar;
    k[0] &= 252;
    k[55] |= 128;
    let x1 = le(u) % &p;
    let a24 = BigUint::from(39081u32);
    let (mut x2, mut z2) = (BigUint::from(1u8), BigUint::from(0u8));
    let (mut x3, mut z3) = (x1.clone(), BigUint::from(1u8));
    let mut swap = false;
    let sub = |a: &BigUint, b: &BigUint| ((a + &p) - b) % &p;
    for t in (0..448).rev() {
        let bit = (k[t / 8] >> (t % 8)) & 1 == 1;
        if swap ^ bit {
            std::mem::swap(&mut x2, &mut x3);
            std::mem::swap(&mut z2, &mut z3);
        }
        swap = bit;
        let a = (&x2 + &z2) % &p;
        let aa = (&a * &a) % &p;
        let b = sub(&x2, &z2);
        let bb = (&b * &b) % &p;
        let e = sub(&aa, &bb);
        let c = (&x3 + &z3) % &p;
        let d = sub(&x3, &z3);
        let da = (&d * &a) % &p;
        let cb = (&c * &b) % &p;
        let sum = (&da + &cb) % &p;
        x3 = (&sum * &sum) % &p;
        let diff = sub(&da, &cb);
        z3 = (&x1 * ((&diff * &diff) % &p)) % &p;
        x2 = (&aa * &bb) % &p;
        z2 = (&e * ((&aa + (&a24 * &e)) % &p)) % &p;
    }
    if swap {
        std::mem::swap(&mut x2, &mut x3);
        std::mem::swap(&mut z2, &mut z3);
    }
    let inv = z2.modpow(&(&p - BigUint::from(2u8)), &p);
    to_le56(&((x2 * inv) % &p))
}

pub(super) fn x448_public(scalar: &[u8; 56]) -> [u8; 56] {
    let mut base = [0u8; 56];
    base[0] = 5;
    x448(scalar, &base)
}

// ---------------------------------------------------------------------------
// Ed448 (RFC 8032 §5.2)
// ---------------------------------------------------------------------------

pub(super) fn ed448_public(seed: &[u8; 57]) -> [u8; 57] {
    let key = ed448_goldilocks_plus::SigningKey::try_from(&seed[..]).expect("57-byte seed");
    let vk = key.verifying_key();
    let mut out = [0u8; 57];
    out.copy_from_slice(&vk.to_bytes()[..]);
    out
}

pub(super) fn ed448_sign(seed: &[u8; 57], message: &[u8], context: &[u8]) -> Option<Vec<u8>> {
    let key = ed448_goldilocks_plus::SigningKey::try_from(&seed[..]).ok()?;
    let sig = if context.is_empty() {
        key.sign_raw(message)
    } else {
        key.sign_ctx(context, message).ok()?
    };
    Some(sig.to_bytes().to_vec())
}

pub(super) fn ed448_verify(public: &[u8; 57], message: &[u8], sig: &[u8], context: &[u8]) -> bool {
    let Ok(vk) = ed448_goldilocks_plus::VerifyingKey::from_bytes(public) else { return false };
    let Ok(bytes) = <[u8; 114]>::try_from(sig) else { return false };
    let Ok(sig) = ed448_goldilocks_plus::Signature::from_bytes(&bytes) else { return false };
    if context.is_empty() {
        vk.verify_raw(&sig, message).is_ok()
    } else {
        vk.verify_ctx(&sig, context, message).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
    }

    #[test]
    fn x448_rfc7748_vector() {
        let k: [u8; 56] = hex("3d262fddf9ec8e88495266fea19a34d28882acef045104d0d1aae121700a779c984c24f8cdd78fbff44943eba368f54b29259a4f1c600ad3").try_into().unwrap();
        let u: [u8; 56] = hex("06fce640fa3487bfda5f6cf2d5263f8aad88334cbd07437f020f08f9814dc031ddbdc38c19c6da2583fa5429db94ada18aa7a7fb4ef8a086").try_into().unwrap();
        let out = x448(&k, &u);
        assert_eq!(out.to_vec(), hex("ce3e4ff95a60dc6697da1db1d85e6afbdf79b50a2412d7546d5f239fe14fbaadeb445fc66a01b0779d98223961111e21766282f73dd96b6f"));
    }

    #[test]
    fn ed448_rfc8032_blank_vector() {
        let seed: [u8; 57] = hex("6c82a562cb808d10d632be89c8513ebf6c929f34ddfa8c9f63c9960ef6e348a3528c8a3fcc2f044e39a3fc5b94492f8f032e7549a20098f95b").try_into().unwrap();
        assert_eq!(ed448_public(&seed).to_vec(), hex("5fd7449b59b461fd2ce787ec616ad46a1da1342485a70e1f8a0ea75d80e96778edf124769b46c7061bd6783df1e50f6cd1fa1abeafe8256180"));
        let sig = ed448_sign(&seed, b"", b"").unwrap();
        assert!(ed448_verify(&ed448_public(&seed), b"", &sig, b""));
    }

    #[test]
    fn dsa_round_trip() {
        let params = dsa_generate(512, 160);
        let x = random_private(&params.q);
        let y = dsa_public(&params, &x);
        let hash = [7u8; 32];
        let sig = dsa_sign(&params, &x, &hash, false);
        assert!(dsa_verify(&params, &y, &hash, &sig, false));
        assert!(!dsa_verify(&params, &y, &[8u8; 32], &sig, false));
    }
}

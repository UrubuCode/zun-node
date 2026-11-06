//! Vector tests for the `node:crypto` primitives.
//!
//! Every expected value here is either an RFC/NIST test vector or the output
//! of OpenSSL for the same input, because that is the acceptance bar the
//! corpus sets: `test-crypto-hash.js`, `test-crypto-hmac.js`,
//! `test-crypto-pbkdf2.js`, `test-crypto-hkdf.js`, `test-crypto-scrypt.js`,
//! `test-crypto-padding.js`, `test-crypto-cipheriv-decipheriv.js` and
//! `test-crypto-authenticated.js` all compare against literals. Checking them
//! here makes a byte-level regression a `cargo test` failure rather than one
//! Node test among a hundred.

use super::cipher::Cipher;
use super::hash::{Alg, Hasher};
use super::kdf;
use super::mac::Mac;
use super::{ciphers, random};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            u8::from_str_radix(core::str::from_utf8(pair).expect("ascii hex"), 16)
                .expect("valid hex")
        })
        .collect()
}

fn digest_hex(alg: Alg, data: &[u8]) -> String {
    hex(&alg.digest(data))
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

#[test]
fn digests_of_abc_match_the_published_values() {
    // The `abc` vectors from FIPS 180-4, FIPS 202, RFC 1321 and the RIPEMD-160
    // and BLAKE2 reference pages.
    assert_eq!(digest_hex(Alg::Md5, b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(
        digest_hex(Alg::Sha1, b"abc"),
        "a9993e364706816aba3e25717850c26c9cd0d89d"
    );
    assert_eq!(
        digest_hex(Alg::Sha224, b"abc"),
        "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"
    );
    assert_eq!(
        digest_hex(Alg::Sha256, b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        digest_hex(Alg::Sha384, b"abc"),
        concat!(
            "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded163",
            "1a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7"
        )
    );
    assert_eq!(
        digest_hex(Alg::Sha512, b"abc"),
        concat!(
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea2",
            "0a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd",
            "454d4423643ce80e2a9ac94fa54ca49f"
        )
    );
    assert_eq!(
        digest_hex(Alg::Sha512_224, b"abc"),
        "4634270f707b6a54daae7530460842e20e37ed265ceee9a43e8924aa"
    );
    assert_eq!(
        digest_hex(Alg::Sha512_256, b"abc"),
        "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23"
    );
    assert_eq!(
        digest_hex(Alg::Sha3_256, b"abc"),
        "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532"
    );
    assert_eq!(
        digest_hex(Alg::Ripemd160, b"abc"),
        "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc"
    );
    assert_eq!(
        digest_hex(Alg::Blake2s256, b"abc"),
        "508c5e8c327c14e2e1a72ba34eeb452f37458b209ed63a294d999b4c86675982"
    );
}

#[test]
fn an_incremental_hash_equals_the_one_shot() {
    // What `createHash('sha1').update('Test').update('123')` relies on, and
    // the literal `test-crypto-hash.js` compares it to.
    let mut hasher = Hasher::new(Alg::Sha1);
    hasher.update(b"Test");
    hasher.update(b"123");
    assert_eq!(
        hex(&hasher.finish(20)),
        "8308651804facb7b9af8ffc53a33a22d6a1c8ac2"
    );
}

#[test]
fn a_cloned_hash_continues_independently() {
    // `Hash.prototype.copy()`: a copy of `abc` fed `def` must equal `abcdef`.
    let mut base = Hasher::new(Alg::Sha512);
    base.update(b"abc");
    let mut copy = base.clone();
    copy.update(b"def");
    let mut whole = Hasher::new(Alg::Sha512);
    whole.update(b"abcdef");
    assert_eq!(hex(&copy.finish(64)), hex(&whole.finish(64)));
    // And the original is untouched by the copy's update.
    let mut again = Hasher::new(Alg::Sha512);
    again.update(b"abc");
    assert_eq!(hex(&base.finish(64)), hex(&again.finish(64)));
}

#[test]
fn shake_squeezes_the_requested_length() {
    // The literals `test-crypto-hash.js` asserts for the empty message.
    let shake128 = Hasher::new(Alg::Shake128);
    assert_eq!(hex(&shake128.finish(16)), "7f9c2ba4e88f827d616045507605853e");
    assert_eq!(hex(&shake128.finish(0)), "");
    assert_eq!(hex(&shake128.finish(5)), "7f9c2ba4e8");
    assert_eq!(hex(&shake128.finish(15)), "7f9c2ba4e88f827d61604550760585");
    let shake256 = Hasher::new(Alg::Shake256);
    assert_eq!(
        hex(&shake256.finish(32)),
        "46b9dd2b0ba88d13233b3feb743eeb243fcd52ea62b81b82b50c27646ed5762f"
    );
    // A long squeeze is one stream, not repeated blocks.
    let mut long = Hasher::new(Alg::Shake256);
    long.update(b"The message is shorter than the hash!");
    let squeezed = hex(&long.finish(1024 * 1024));
    assert_eq!(squeezed.len(), 2 * 1024 * 1024);
    assert!(squeezed.starts_with("a2a28dbc49cfd6e5d6ceea3d03e77748"));
    assert!(squeezed.ends_with("193414035ddba77bf7bba97981e656ec"));
}

#[test]
fn digest_names_resolve_case_insensitively_and_through_aliases() {
    assert_eq!(Alg::resolve("SHA256"), Some(Alg::Sha256));
    assert_eq!(Alg::resolve("RSA-SHA1"), Some(Alg::Sha1));
    assert_eq!(Alg::resolve("rmd160"), Some(Alg::Ripemd160));
    assert_eq!(Alg::resolve("sha512-256"), Some(Alg::Sha512_256));
    assert_eq!(Alg::resolve("xyzzy"), None);
}

#[test]
fn the_hash_catalogue_is_sorted_unique_and_resolvable() {
    // `test-crypto.js`' `validateList`, plus its "every listed hash can be
    // created" loop.
    let names = super::hash::HASH_NAMES;
    let mut sorted: Vec<Vec<u16>> = names.iter().map(|n| n.encode_utf16().collect()).collect();
    let original = sorted.clone();
    sorted.sort();
    assert_eq!(sorted, original, "getHashes() must be sorted");
    sorted.dedup();
    assert_eq!(sorted.len(), names.len(), "getHashes() must be unique");
    for name in names {
        assert!(Alg::resolve(name).is_some(), "{name} does not resolve");
    }
    assert!(names.contains(&"RSA-SHA1"));
    assert!(!names.contains(&"rsa-sha1"));
}

// ---------------------------------------------------------------------------
// HMAC
// ---------------------------------------------------------------------------

#[test]
fn hmac_matches_rfc_4231() {
    // RFC 4231 §4.2: key = 20 x 0x0b, data = "Hi There".
    let key = vec![0x0bu8; 20];
    let mut mac = Mac::new(Alg::Sha256, &key);
    mac.update(b"Hi There");
    assert_eq!(
        hex(&mac.finish()),
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
    );

    // §4.3: key = "Jefe", data = "what do ya want for nothing?".
    let mut mac = Mac::new(Alg::Sha256, b"Jefe");
    mac.update(b"what do ya want for nothing?");
    assert_eq!(
        hex(&mac.finish()),
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    );
    let mut mac = Mac::new(Alg::Sha512, b"Jefe");
    mac.update(b"what do ya want for nothing?");
    assert_eq!(
        hex(&mac.finish()),
        concat!(
            "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd6",
            "10270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fd",
            "caeab1a34d4a6b4b636e070a38bce737"
        )
    );

    // §4.7: a key longer than the block size, which must be hashed down.
    let key = vec![0xaau8; 131];
    let mut mac = Mac::new(Alg::Sha256, &key);
    mac.update(
        b"This is a test using a larger than block-size key and a larger than block-size \
data. The key needs to be hashed before being used by the HMAC algorithm.",
    );
    assert_eq!(
        hex(&mac.finish()),
        "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2"
    );
}

#[test]
fn hmac_md5_matches_rfc_2202() {
    // RFC 2202 §2, case 1.
    let mut mac = Mac::new(Alg::Md5, &vec![0x0bu8; 16]);
    mac.update(b"Hi There");
    assert_eq!(hex(&mac.finish()), "9294727a3638bb1c13f48ef8158bfc9d");
}

#[test]
fn an_hmac_clone_does_not_disturb_the_original() {
    let mut mac = Mac::new(Alg::Sha256, b"key");
    mac.update(b"abc");
    let mut copy = mac.clone();
    copy.update(b"def");
    let mut whole = Mac::new(Alg::Sha256, b"key");
    whole.update(b"abcdef");
    assert_eq!(hex(&copy.finish()), hex(&whole.finish()));
    let mut expected = Mac::new(Alg::Sha256, b"key");
    expected.update(b"abc");
    assert_eq!(hex(&mac.finish()), hex(&expected.finish()));
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

#[test]
fn pbkdf2_matches_rfc_6070() {
    // RFC 6070's HMAC-SHA1 vectors.
    assert_eq!(
        hex(&kdf::pbkdf2(Alg::Sha1, b"password", b"salt", 1, 20)),
        "0c60c80f961f0e71f3a9b524af6012062fe037a6"
    );
    assert_eq!(
        hex(&kdf::pbkdf2(Alg::Sha1, b"password", b"salt", 2, 20)),
        "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957"
    );
    assert_eq!(
        hex(&kdf::pbkdf2(Alg::Sha1, b"password", b"salt", 4096, 20)),
        "4b007901b765489abead49d926f721d065a429c1"
    );
    assert_eq!(
        hex(&kdf::pbkdf2(
            Alg::Sha1,
            b"passwordPASSWORDpassword",
            b"saltSALTsaltSALTsaltSALTsaltSALTsalt",
            4096,
            25
        )),
        "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038"
    );
    // RFC 7914 §11's HMAC-SHA256 vector, which crosses a block boundary.
    assert_eq!(
        hex(&kdf::pbkdf2(Alg::Sha256, b"passwd", b"salt", 1, 64)),
        concat!(
            "55ac046e56e3089fec1691c22544b605f94185216dde0465",
            "e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef31",
            "7c71b845b1e30bd509112041d3a19783"
        )
    );
}

#[test]
fn hkdf_matches_rfc_5869() {
    // RFC 5869 appendix A.1 (SHA-256, basic).
    let derived = kdf::hkdf(
        Alg::Sha256,
        &unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
        &unhex("000102030405060708090a0b0c"),
        &unhex("f0f1f2f3f4f5f6f7f8f9"),
        42,
    )
    .expect("length within 255 * HashLen");
    assert_eq!(
        hex(&derived),
        concat!(
            "3cb25f25faacd57a90434f64d0362f2a",
            "2d2d0a90cf1a5a4c5db02d56ecc4c5bf",
            "34007208d5b887185865"
        )
    );

    // A.3: zero-length salt and info.
    let derived = kdf::hkdf(
        Alg::Sha256,
        &unhex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"),
        b"",
        b"",
        42,
    )
    .expect("length within 255 * HashLen");
    assert_eq!(
        hex(&derived),
        concat!(
            "8da4e775a563c18f715f802a063c5a31",
            "b8a11f5c5ee1879ec3454e5f3c738d2d",
            "9d201395faa4b61a96c8"
        )
    );

    // A.4: SHA-1.
    let derived = kdf::hkdf(
        Alg::Sha1,
        &unhex("0b0b0b0b0b0b0b0b0b0b0b"),
        &unhex("000102030405060708090a0b0c"),
        &unhex("f0f1f2f3f4f5f6f7f8f9"),
        42,
    )
    .expect("length within 255 * HashLen");
    assert_eq!(
        hex(&derived),
        concat!(
            "085a01ea1b10f36933068b56efa5ad81",
            "a4f14b822f5b091568a9cdd4f155fda2",
            "c22e422478d305f3f896"
        )
    );

    // Over 255 * HashLen is `ERR_CRYPTO_INVALID_KEYLEN` in Node.
    assert!(kdf::hkdf(Alg::Sha256, b"ikm", b"salt", b"", 32 * 255 + 1).is_none());
    assert!(kdf::hkdf(Alg::Sha256, b"ikm", b"salt", b"", 32 * 255).is_some());
}

#[test]
fn scrypt_matches_rfc_7914() {
    // RFC 7914 §12, the second vector.
    let derived =
        kdf::scrypt(b"password", b"NaCl", 1024, 8, 16, 64).expect("valid scrypt parameters");
    assert_eq!(
        hex(&derived),
        concat!(
            "fdbabe1c9d3472007856e7190d01e9fe",
            "7c6ad7cbc8237830e77376634b373162",
            "2eaf30d92e22a3886ff109279d9830da",
            "c727afb94a83ee6d8360cbdfa2cc0640"
        )
    );
    // The first vector (N=16, r=1, p=1), the smallest legal N.
    let derived = kdf::scrypt(b"", b"", 16, 1, 1, 64).expect("valid scrypt parameters");
    assert_eq!(
        hex(&derived),
        concat!(
            "77d6576238657b203b19ca42c18a0497",
            "f16b4844e3074ae8dfdffa3fede21442",
            "fcd0069ded0948f8326a753a0fc81f17",
            "e8d3e0fb2e0d3628cf35e20c38d18906"
        )
    );
    // A non-power-of-two or degenerate N is `ERR_CRYPTO_INVALID_SCRYPT_PARAMS`.
    assert!(kdf::scrypt(b"p", b"s", 3, 8, 1, 64).is_none());
    assert!(kdf::scrypt(b"p", b"s", 1, 8, 1, 64).is_none());
}

// ---------------------------------------------------------------------------
// Ciphers
// ---------------------------------------------------------------------------

/// Run `name` over `plaintext` and answer the hex ciphertext plus the hex tag.
fn encrypt(name: &str, key: &[u8], iv: &[u8], aad: &[u8], plaintext: &[u8]) -> (String, String) {
    let mut cipher = Cipher::prepare(name, true, key, iv, -1).expect("supported cipher");
    if !aad.is_empty() {
        cipher.set_aad(aad).expect("AEAD accepts AAD");
    }
    let mut out = cipher.update(plaintext);
    out.extend_from_slice(&cipher.finish().expect("encryption cannot fail"));
    let tag = cipher.auth_tag().map(hex).unwrap_or_default();
    (hex(&out), tag)
}

#[test]
fn aes_cbc_matches_openssl() {
    // The vectors `test-crypto-padding.js` quotes from `openssl enc`.
    let key = b"S3c.r.e.t.K.e.Y!";
    let iv = b"blahFizz2011Buzz";
    let (ciphertext, _) = encrypt("aes-128-cbc", key, iv, b"", b"Hello node world!");
    assert_eq!(
        ciphertext,
        "7f57859550d4d2fdb9806da2a750461a9fe77253cd1cbd4b07beee4e070d561f"
    );
    let (ciphertext, _) = encrypt(
        "aes-128-cbc",
        key,
        iv,
        b"",
        b"Hello node world!AbC09876dDeFgHi",
    );
    assert_eq!(
        ciphertext,
        concat!(
            "7f57859550d4d2fdb9806da2a750461a",
            "b46e71b3d78ebe2d9684dfc87f7575b9",
            "886119866912cb8c7bcaf76c5ebc2378"
        )
    );
}

#[test]
fn aes_cbc_round_trips_at_every_chunking() {
    // `update()` must hold a partial block back and produce the same bytes
    // whatever the chunk boundaries are -- the property Node's `Transform`
    // relies on.
    let key = [7u8; 32];
    let iv = [3u8; 16];
    let plaintext: Vec<u8> = (0..100u8).collect();
    let (whole, _) = encrypt("aes-256-cbc", &key, &iv, b"", &plaintext);

    for chunk in [1usize, 3, 7, 16, 17, 64] {
        let mut cipher = Cipher::prepare("aes-256-cbc", true, &key, &iv, -1).expect("cipher");
        let mut out = Vec::new();
        for part in plaintext.chunks(chunk) {
            out.extend_from_slice(&cipher.update(part));
        }
        out.extend_from_slice(&cipher.finish().expect("encryption cannot fail"));
        assert_eq!(hex(&out), whole, "chunk size {chunk}");

        let ciphertext = unhex(&whole);
        let mut decipher = Cipher::prepare("aes-256-cbc", false, &key, &iv, -1).expect("cipher");
        let mut back = Vec::new();
        for part in ciphertext.chunks(chunk) {
            back.extend_from_slice(&decipher.update(part));
        }
        back.extend_from_slice(&decipher.finish().expect("padding checks out"));
        assert_eq!(back, plaintext, "chunk size {chunk}");
    }
}

#[test]
fn aes_ecb_is_the_bare_block_function() {
    // FIPS 197 appendix C.1: AES-128 of the standard block.
    let key = unhex("000102030405060708090a0b0c0d0e0f");
    let plaintext = unhex("00112233445566778899aabbccddeeff");
    let mut cipher = Cipher::prepare("aes-128-ecb", true, &key, b"", -1).expect("cipher");
    cipher.set_auto_padding(false);
    let out = cipher.update(&plaintext);
    assert_eq!(hex(&out), "69c4e0d86a7b0430d8cdb78070b4c55a");
}

#[test]
fn aes_ctr_matches_sp_800_38a() {
    // NIST SP 800-38A F.5.1, AES-128-CTR, the first two blocks.
    let key = unhex("2b7e151628aed2a6abf7158809cf4f3c");
    let iv = unhex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
    let plaintext = unhex(concat!(
        "6bc1bee22e409f96e93d7e117393172a",
        "ae2d8a571e03ac9c9eb76fac45af8e51"
    ));
    let (ciphertext, _) = encrypt("aes-128-ctr", &key, &iv, b"", &plaintext);
    assert_eq!(
        ciphertext,
        concat!(
            "874d6191b620e3261bef6864990db6ce",
            "9806f66b7970fdff8617187bb9fffdff"
        )
    );
}

#[test]
fn aes_gcm_matches_the_nist_vectors() {
    // NIST GCM test case 3: a 96-bit IV and no AAD.
    let key = unhex("feffe9928665731c6d6a8f9467308308");
    let iv = unhex("cafebabefacedbaddecaf888");
    let plaintext = unhex(concat!(
        "d9313225f88406e5a55909c5aff5269a",
        "86a7a9531534f7da2e4c303d8a318a72",
        "1c3c0c95956809532fcf0e2449a6b525",
        "b16aedf5aa0de657ba637b391aafd255"
    ));
    let (ciphertext, tag) = encrypt("aes-128-gcm", &key, &iv, b"", &plaintext);
    assert_eq!(
        ciphertext,
        concat!(
            "42831ec2217774244b7221b784d0d49c",
            "e3aa212f2c02a4e035c17e2329aca12e",
            "21d514b25466931c7d8f6a5aac84aa05",
            "1ba30b396a0aac973d58e091473f5985"
        )
    );
    assert_eq!(tag, "4d5c2af327cd64a62cf35abd2ba6fab4");

    // Case 4: the same with AAD and a truncated plaintext.
    let plaintext = unhex(concat!(
        "d9313225f88406e5a55909c5aff5269a",
        "86a7a9531534f7da2e4c303d8a318a72",
        "1c3c0c95956809532fcf0e2449a6b525",
        "b16aedf5aa0de657ba637b39"
    ));
    let aad = unhex("feedfacedeadbeeffeedfacedeadbeefabaddad2");
    let (ciphertext, tag) = encrypt("aes-128-gcm", &key, &iv, &aad, &plaintext);
    assert_eq!(
        ciphertext,
        concat!(
            "42831ec2217774244b7221b784d0d49c",
            "e3aa212f2c02a4e035c17e2329aca12e",
            "21d514b25466931c7d8f6a5aac84aa05",
            "1ba30b396a0aac973d58e091"
        )
    );
    assert_eq!(tag, "5bc94fbc3221a5db94fae95ae7121a47");

    // Case 5: a 64-bit IV, which must be folded through GHASH rather than
    // used directly -- the arm Node reaches whenever `ivLength !== 12`.
    let iv = unhex("cafebabefacedbad");
    let (ciphertext, tag) = encrypt("aes-128-gcm", &key, &iv, &aad, &plaintext);
    assert_eq!(
        ciphertext,
        concat!(
            "61353b4c2806934a777ff51fa22a4755",
            "699b2a714fcdc6f83766e5f97b6c7423",
            "73806900e49f24b22b097544d4896b42",
            "4989b5e1ebac0f07c23f4598"
        )
    );
    assert_eq!(tag, "3612d2e79e3b0785561be14aaca2fccb");
}

#[test]
fn aes_gcm_decryption_verifies_the_tag() {
    let key = unhex("feffe9928665731c6d6a8f9467308308");
    let iv = unhex("cafebabefacedbaddecaf888");

    // A tag that is not this message's must not verify.
    let mut decipher = Cipher::prepare("aes-128-gcm", false, &key, &iv, -1).expect("cipher");
    decipher
        .set_auth_tag(&unhex("1f3afa4611c8b9cb1e5e43b1a1e13b0d"))
        .expect("AEAD accepts a tag");
    let _ = decipher.update(&unhex("42831ec2217774244b7221b784d0d49c"));
    assert!(decipher.finish().is_err(), "a wrong tag must not verify");

    // A round trip with the tag the encryption produced does verify.
    let plaintext = b"authenticated and encrypted";
    let (hexed, tag) = encrypt("aes-256-gcm", &[9u8; 32], &iv, b"aad", plaintext);
    let mut decipher = Cipher::prepare("aes-256-gcm", false, &[9u8; 32], &iv, -1).expect("cipher");
    decipher.set_aad(b"aad").expect("AEAD accepts AAD");
    decipher.set_auth_tag(&unhex(&tag)).expect("accepts a tag");
    let out = decipher.update(&unhex(&hexed));
    assert!(decipher.finish().is_ok(), "the produced tag must verify");
    assert_eq!(out, plaintext);

    // A missing tag is a failure, not an empty comparison.
    let mut decipher = Cipher::prepare("aes-256-gcm", false, &[9u8; 32], &iv, -1).expect("cipher");
    let _ = decipher.update(&unhex(&hexed));
    assert!(decipher.finish().is_err(), "no tag must not verify");
}

#[test]
fn chacha20_poly1305_matches_rfc_8439() {
    // RFC 8439 §2.8.2.
    let key = unhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f");
    let iv = unhex("070000004041424344454647");
    let aad = unhex("50515253c0c1c2c3c4c5c6c7");
    let plaintext = b"Ladies and Gentlemen of the class of '99: If I could offer you only one \
tip for the future, sunscreen would be it.";
    let (ciphertext, tag) = encrypt("chacha20-poly1305", &key, &iv, &aad, plaintext);
    assert_eq!(
        ciphertext,
        concat!(
            "d31a8d34648e60db7b86afbc53ef7ec2",
            "a4aded51296e08fea9e2b5a736ee62d6",
            "3dbea45e8ca9671282fafb69da92728b",
            "1a71de0a9e060b2905d6a5b67ecd3b36",
            "92ddbd7f2d778b8c9803aee328091b58",
            "fab324e4fad675945585808b4831d7bc",
            "3ff4def08e4b7a9de576d26586cec64b",
            "6116"
        )
    );
    assert_eq!(tag, "1ae10b594f09e26a7e902ecbd0600691");
}

#[test]
fn padding_failures_report_the_openssl_classification() {
    let key = b"S3c.r.e.t.K.e.Y!";
    let iv = b"blahFizz2011Buzz";

    // `enc(ODD_LENGTH_PLAIN, false)`: no padding and a partial block.
    let mut cipher = Cipher::prepare("aes-128-cbc", true, key, iv, -1).expect("cipher");
    cipher.set_auto_padding(false);
    let _ = cipher.update(b"Hello node world!");
    assert!(matches!(
        cipher.finish(),
        Err(super::cipher::Error::WrongFinalBlockLength)
    ));

    // `dec(EVEN_LENGTH_ENCRYPTED_NOPAD, true)`: a last block with no PKCS#7
    // padding in it.
    let ciphertext = unhex(concat!(
        "7f57859550d4d2fdb9806da2a750461a",
        "b46e71b3d78ebe2d9684dfc87f7575b9"
    ));
    let mut decipher = Cipher::prepare("aes-128-cbc", false, key, iv, -1).expect("cipher");
    let _ = decipher.update(&ciphertext);
    assert!(matches!(
        decipher.finish(),
        Err(super::cipher::Error::BadDecrypt)
    ));

    // With padding off the same input decrypts to the plaintext plus its
    // original padding, which is what `test-crypto-padding.js` asserts.
    let mut decipher = Cipher::prepare("aes-128-cbc", false, key, iv, -1).expect("cipher");
    decipher.set_auto_padding(false);
    let mut out = decipher.update(&ciphertext);
    out.extend_from_slice(&decipher.finish().expect("no padding to check"));
    assert_eq!(out, b"Hello node world!AbC09876dDeFgHi");
}

#[test]
fn a_bad_key_or_iv_length_is_refused() {
    assert!(matches!(
        Cipher::prepare("xyzzy", true, &[0u8; 16], &[0u8; 16], -1),
        Err(super::cipher::InitError::UnknownCipher)
    ));
    assert!(matches!(
        Cipher::prepare("aes-128-cbc", true, &[0u8; 15], &[0u8; 16], -1),
        Err(super::cipher::InitError::InvalidKeyLength)
    ));
    assert!(matches!(
        Cipher::prepare("aes-128-cbc", true, &[0u8; 16], &[0u8; 15], -1),
        Err(super::cipher::InitError::InvalidIv)
    ));
    // ECB takes no IV at all.
    assert!(matches!(
        Cipher::prepare("aes-128-ecb", true, &[0u8; 16], &[0u8; 16], -1),
        Err(super::cipher::InitError::InvalidIv)
    ));
    // A listed-but-unimplemented cipher is distinguishable from an unknown
    // one, so the TS layer can report `ERR_CRYPTO_UNSUPPORTED_OPERATION`.
    assert!(matches!(
        Cipher::prepare("aria-128-cbc", true, &[0u8; 16], &[0u8; 16], -1),
        Err(super::cipher::InitError::Unsupported)
    ));
    // GCM takes 4, 8 and 12..=16 byte tags and nothing else.
    assert!(Cipher::prepare("aes-128-gcm", true, &[0u8; 16], &[0u8; 12], 8).is_ok());
    assert!(matches!(
        Cipher::prepare("aes-128-gcm", true, &[0u8; 16], &[0u8; 12], 6),
        Err(super::cipher::InitError::InvalidAuthTagLength)
    ));
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

#[test]
fn the_cipher_catalogue_is_sorted_and_answers_openssl_facts() {
    let mut sorted: Vec<Vec<u16>> = ciphers::SPECS
        .iter()
        .map(|spec| spec.name.encode_utf16().collect())
        .collect();
    let original = sorted.clone();
    sorted.sort();
    assert_eq!(sorted, original, "getCiphers() must be sorted");
    sorted.dedup();
    assert_eq!(sorted.len(), ciphers::SPECS.len());

    let cbc = ciphers::by_name("aes-128-cbc").expect("in the catalogue");
    assert_eq!(cbc.nid, 419);
    assert_eq!(cbc.block_size, 16);
    assert_eq!(cbc.iv_length, 16);
    assert_eq!(cbc.key_length, 16);
    assert_eq!(cbc.mode, "cbc");
    // The canonical name differs from the lookup name for the AEADs.
    assert_eq!(
        ciphers::by_name("aes-256-gcm")
            .expect("in the catalogue")
            .canonical,
        "id-aes256-gcm"
    );
    // A NID lookup answers a row with the same fields, which is what
    // `getCipherInfo(info.nid)` deep-equalling `info` needs.
    assert_eq!(ciphers::by_nid(419).expect("by nid").name, "aes-128-cbc");
    assert!(ciphers::by_nid(-1).is_none());
    // Case-insensitive, as OpenSSL's own lookup is.
    assert!(ciphers::by_name("AES-128-CBC").is_some());
}

#[test]
fn the_aead_iv_ranges_are_openssls() {
    let ccm = ciphers::by_name("aes-128-ccm").expect("in the catalogue");
    assert!(!ccm.accepts_iv(1));
    assert!(!ccm.accepts_iv(14));
    for length in 7..=13 {
        assert!(ccm.accepts_iv(length), "CCM should accept {length}");
    }
    let ocb = ciphers::by_name("aes-128-ocb").expect("in the catalogue");
    assert!(!ocb.accepts_iv(16));
    for length in 1..16 {
        assert!(ocb.accepts_iv(length), "OCB should accept {length}");
    }
    let cbc = ciphers::by_name("aes-128-cbc").expect("in the catalogue");
    assert!(cbc.accepts_iv(16));
    assert!(!cbc.accepts_iv(12));
}

// ---------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------

#[test]
fn the_os_random_source_answers_the_requested_length() {
    assert_eq!(random::bytes(0).expect("CSPRNG available").len(), 0);
    let first = random::bytes(32).expect("CSPRNG available");
    let second = random::bytes(32).expect("CSPRNG available");
    assert_eq!(first.len(), 32);
    // Two 256-bit draws colliding would be a broken source, not bad luck.
    assert_ne!(first, second);
}

//! The cipher *catalogue*: what `crypto.getCiphers()` lists and what
//! `crypto.getCipherInfo()` reports for each entry.
//!
//! This is metadata, not capability. Node's `getCiphers()` enumerates every
//! cipher OpenSSL knows and `getCipherInfo()` answers OpenSSL's NID, block
//! size, key length, IV length and mode for it — facts about the algorithm
//! that are the same wherever it is implemented, and that
//! `test-crypto-getcipherinfo.js` checks against literals (`aes-128-cbc` is
//! NID 419 with a 16-byte block, key and IV; `aes-128-ccm` accepts a 7..=13
//! byte IV; `aes-128-ocb` accepts 1..=15). The table is therefore the real
//! OpenSSL 3 one, transcribed, so those answers match Node's.
//!
//! Which of these `createCipheriv` can actually *construct* is a smaller set,
//! decided by `cipher.rs`: AES in ECB/CBC/CTR/GCM, ChaCha20 and
//! ChaCha20-Poly1305. The rest report `ERR_CRYPTO_UNSUPPORTED_OPERATION` from
//! the TS layer — see `../../test/crypto/README.md`. Listing them anyway is
//! the honest reading of what the two functions mean: they describe
//! algorithms, and a caller that wants to know whether one is usable here
//! finds out by constructing it.
//!
//! `-1` in `block_size` or `iv_length` means the key is *absent* from Node's
//! info object (a stream cipher reports no block size; ECB reports no IV).

/// One catalogue row.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Spec {
    /// The name `getCiphers()` lists, which is also what `createCipheriv`
    /// accepts.
    pub(crate) name: &'static str,
    /// OpenSSL's canonical name for the algorithm, which is what
    /// `getCipherInfo().name` answers (`aes-256-gcm` canonicalises to
    /// `id-aes256-gcm`).
    pub(crate) canonical: &'static str,
    pub(crate) nid: i64,
    pub(crate) block_size: i64,
    pub(crate) iv_length: i64,
    pub(crate) key_length: i64,
    pub(crate) mode: &'static str,
}

/// Every cipher `crypto.getCiphers()` reports, in JavaScript `Array#sort`
/// order (UTF-16 code units), which is the order Node answers in.
pub(crate) const SPECS: &[Spec] = &[
    Spec { name: "aes-128-cbc",               canonical: "aes-128-cbc",                 nid:   419, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "aes-128-cbc-hmac-sha1",     canonical: "aes-128-cbc-hmac-sha1",       nid:   916, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "aes-128-cbc-hmac-sha256",   canonical: "aes-128-cbc-hmac-sha256",     nid:   948, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "aes-128-ccm",               canonical: "id-aes128-ccm",               nid:   896, block_size:   1, iv_length:  12, key_length: 16, mode: "ccm"     },
    Spec { name: "aes-128-cfb",               canonical: "aes-128-cfb",                 nid:   421, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "aes-128-cfb1",              canonical: "aes-128-cfb1",                nid:   650, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "aes-128-cfb8",              canonical: "aes-128-cfb8",                nid:   653, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "aes-128-ctr",               canonical: "aes-128-ctr",                 nid:   904, block_size:   1, iv_length:  16, key_length: 16, mode: "ctr"     },
    Spec { name: "aes-128-ecb",               canonical: "aes-128-ecb",                 nid:   418, block_size:  16, iv_length:  -1, key_length: 16, mode: "ecb"     },
    Spec { name: "aes-128-gcm",               canonical: "id-aes128-gcm",               nid:   895, block_size:   1, iv_length:  12, key_length: 16, mode: "gcm"     },
    Spec { name: "aes-128-ocb",               canonical: "aes-128-ocb",                 nid:   958, block_size:  16, iv_length:  12, key_length: 16, mode: "ocb"     },
    Spec { name: "aes-128-ofb",               canonical: "aes-128-ofb",                 nid:   420, block_size:   1, iv_length:  16, key_length: 16, mode: "ofb"     },
    Spec { name: "aes-128-xts",               canonical: "aes-128-xts",                 nid:   913, block_size:   1, iv_length:  16, key_length: 32, mode: "xts"     },
    Spec { name: "aes-192-cbc",               canonical: "aes-192-cbc",                 nid:   423, block_size:  16, iv_length:  16, key_length: 24, mode: "cbc"     },
    Spec { name: "aes-192-ccm",               canonical: "id-aes192-ccm",               nid:   899, block_size:   1, iv_length:  12, key_length: 24, mode: "ccm"     },
    Spec { name: "aes-192-cfb",               canonical: "aes-192-cfb",                 nid:   425, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "aes-192-cfb1",              canonical: "aes-192-cfb1",                nid:   651, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "aes-192-cfb8",              canonical: "aes-192-cfb8",                nid:   654, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "aes-192-ctr",               canonical: "aes-192-ctr",                 nid:   905, block_size:   1, iv_length:  16, key_length: 24, mode: "ctr"     },
    Spec { name: "aes-192-ecb",               canonical: "aes-192-ecb",                 nid:   422, block_size:  16, iv_length:  -1, key_length: 24, mode: "ecb"     },
    Spec { name: "aes-192-gcm",               canonical: "id-aes192-gcm",               nid:   898, block_size:   1, iv_length:  12, key_length: 24, mode: "gcm"     },
    Spec { name: "aes-192-ocb",               canonical: "aes-192-ocb",                 nid:   959, block_size:  16, iv_length:  12, key_length: 24, mode: "ocb"     },
    Spec { name: "aes-192-ofb",               canonical: "aes-192-ofb",                 nid:   424, block_size:   1, iv_length:  16, key_length: 24, mode: "ofb"     },
    Spec { name: "aes-256-cbc",               canonical: "aes-256-cbc",                 nid:   427, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "aes-256-cbc-hmac-sha1",     canonical: "aes-256-cbc-hmac-sha1",       nid:   918, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "aes-256-cbc-hmac-sha256",   canonical: "aes-256-cbc-hmac-sha256",     nid:   950, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "aes-256-ccm",               canonical: "id-aes256-ccm",               nid:   902, block_size:   1, iv_length:  12, key_length: 32, mode: "ccm"     },
    Spec { name: "aes-256-cfb",               canonical: "aes-256-cfb",                 nid:   429, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "aes-256-cfb1",              canonical: "aes-256-cfb1",                nid:   652, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "aes-256-cfb8",              canonical: "aes-256-cfb8",                nid:   655, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "aes-256-ctr",               canonical: "aes-256-ctr",                 nid:   906, block_size:   1, iv_length:  16, key_length: 32, mode: "ctr"     },
    Spec { name: "aes-256-ecb",               canonical: "aes-256-ecb",                 nid:   426, block_size:  16, iv_length:  -1, key_length: 32, mode: "ecb"     },
    Spec { name: "aes-256-gcm",               canonical: "id-aes256-gcm",               nid:   901, block_size:   1, iv_length:  12, key_length: 32, mode: "gcm"     },
    Spec { name: "aes-256-ocb",               canonical: "aes-256-ocb",                 nid:   960, block_size:  16, iv_length:  12, key_length: 32, mode: "ocb"     },
    Spec { name: "aes-256-ofb",               canonical: "aes-256-ofb",                 nid:   428, block_size:   1, iv_length:  16, key_length: 32, mode: "ofb"     },
    Spec { name: "aes-256-xts",               canonical: "aes-256-xts",                 nid:   914, block_size:   1, iv_length:  16, key_length: 64, mode: "xts"     },
    Spec { name: "aes128",                    canonical: "aes-128-cbc",                 nid:   419, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "aes128-wrap",               canonical: "id-aes128-wrap",              nid:   788, block_size:   8, iv_length:   8, key_length: 16, mode: "wrap"    },
    Spec { name: "aes128-wrap-pad",           canonical: "id-aes128-wrap-pad",          nid:   897, block_size:   8, iv_length:   4, key_length: 16, mode: "wrap"    },
    Spec { name: "aes192",                    canonical: "aes-192-cbc",                 nid:   423, block_size:  16, iv_length:  16, key_length: 24, mode: "cbc"     },
    Spec { name: "aes192-wrap",               canonical: "id-aes192-wrap",              nid:   789, block_size:   8, iv_length:   8, key_length: 24, mode: "wrap"    },
    Spec { name: "aes192-wrap-pad",           canonical: "id-aes192-wrap-pad",          nid:   900, block_size:   8, iv_length:   4, key_length: 24, mode: "wrap"    },
    Spec { name: "aes256",                    canonical: "aes-256-cbc",                 nid:   427, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "aes256-wrap",               canonical: "id-aes256-wrap",              nid:   790, block_size:   8, iv_length:   8, key_length: 32, mode: "wrap"    },
    Spec { name: "aes256-wrap-pad",           canonical: "id-aes256-wrap-pad",          nid:   903, block_size:   8, iv_length:   4, key_length: 32, mode: "wrap"    },
    Spec { name: "aria-128-cbc",              canonical: "aria-128-cbc",                nid:  1066, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "aria-128-ccm",              canonical: "aria-128-ccm",                nid:  1120, block_size:   1, iv_length:  12, key_length: 16, mode: "ccm"     },
    Spec { name: "aria-128-cfb",              canonical: "aria-128-cfb",                nid:  1067, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "aria-128-cfb1",             canonical: "aria-128-cfb1",               nid:  1080, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "aria-128-cfb8",             canonical: "aria-128-cfb8",               nid:  1083, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "aria-128-ctr",              canonical: "aria-128-ctr",                nid:  1069, block_size:   1, iv_length:  16, key_length: 16, mode: "ctr"     },
    Spec { name: "aria-128-ecb",              canonical: "aria-128-ecb",                nid:  1065, block_size:  16, iv_length:  -1, key_length: 16, mode: "ecb"     },
    Spec { name: "aria-128-gcm",              canonical: "aria-128-gcm",                nid:  1123, block_size:   1, iv_length:  12, key_length: 16, mode: "gcm"     },
    Spec { name: "aria-128-ofb",              canonical: "aria-128-ofb",                nid:  1068, block_size:   1, iv_length:  16, key_length: 16, mode: "ofb"     },
    Spec { name: "aria-192-cbc",              canonical: "aria-192-cbc",                nid:  1071, block_size:  16, iv_length:  16, key_length: 24, mode: "cbc"     },
    Spec { name: "aria-192-ccm",              canonical: "aria-192-ccm",                nid:  1121, block_size:   1, iv_length:  12, key_length: 24, mode: "ccm"     },
    Spec { name: "aria-192-cfb",              canonical: "aria-192-cfb",                nid:  1072, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "aria-192-cfb1",             canonical: "aria-192-cfb1",               nid:  1081, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "aria-192-cfb8",             canonical: "aria-192-cfb8",               nid:  1084, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "aria-192-ctr",              canonical: "aria-192-ctr",                nid:  1074, block_size:   1, iv_length:  16, key_length: 24, mode: "ctr"     },
    Spec { name: "aria-192-ecb",              canonical: "aria-192-ecb",                nid:  1070, block_size:  16, iv_length:  -1, key_length: 24, mode: "ecb"     },
    Spec { name: "aria-192-gcm",              canonical: "aria-192-gcm",                nid:  1124, block_size:   1, iv_length:  12, key_length: 24, mode: "gcm"     },
    Spec { name: "aria-192-ofb",              canonical: "aria-192-ofb",                nid:  1073, block_size:   1, iv_length:  16, key_length: 24, mode: "ofb"     },
    Spec { name: "aria-256-cbc",              canonical: "aria-256-cbc",                nid:  1076, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "aria-256-ccm",              canonical: "aria-256-ccm",                nid:  1122, block_size:   1, iv_length:  12, key_length: 32, mode: "ccm"     },
    Spec { name: "aria-256-cfb",              canonical: "aria-256-cfb",                nid:  1077, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "aria-256-cfb1",             canonical: "aria-256-cfb1",               nid:  1082, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "aria-256-cfb8",             canonical: "aria-256-cfb8",               nid:  1085, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "aria-256-ctr",              canonical: "aria-256-ctr",                nid:  1079, block_size:   1, iv_length:  16, key_length: 32, mode: "ctr"     },
    Spec { name: "aria-256-ecb",              canonical: "aria-256-ecb",                nid:  1075, block_size:  16, iv_length:  -1, key_length: 32, mode: "ecb"     },
    Spec { name: "aria-256-gcm",              canonical: "aria-256-gcm",                nid:  1125, block_size:   1, iv_length:  12, key_length: 32, mode: "gcm"     },
    Spec { name: "aria-256-ofb",              canonical: "aria-256-ofb",                nid:  1078, block_size:   1, iv_length:  16, key_length: 32, mode: "ofb"     },
    Spec { name: "aria128",                   canonical: "aria-128-cbc",                nid:  1066, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "aria192",                   canonical: "aria-192-cbc",                nid:  1071, block_size:  16, iv_length:  16, key_length: 24, mode: "cbc"     },
    Spec { name: "aria256",                   canonical: "aria-256-cbc",                nid:  1076, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "camellia-128-cbc",          canonical: "camellia-128-cbc",            nid:   751, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "camellia-128-cfb",          canonical: "camellia-128-cfb",            nid:   757, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "camellia-128-cfb1",         canonical: "camellia-128-cfb1",           nid:   760, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "camellia-128-cfb8",         canonical: "camellia-128-cfb8",           nid:   763, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "camellia-128-ctr",          canonical: "camellia-128-ctr",            nid:   963, block_size:   1, iv_length:  16, key_length: 16, mode: "ctr"     },
    Spec { name: "camellia-128-ecb",          canonical: "camellia-128-ecb",            nid:   754, block_size:  16, iv_length:  -1, key_length: 16, mode: "ecb"     },
    Spec { name: "camellia-128-ofb",          canonical: "camellia-128-ofb",            nid:   766, block_size:   1, iv_length:  16, key_length: 16, mode: "ofb"     },
    Spec { name: "camellia-192-cbc",          canonical: "camellia-192-cbc",            nid:   752, block_size:  16, iv_length:  16, key_length: 24, mode: "cbc"     },
    Spec { name: "camellia-192-cfb",          canonical: "camellia-192-cfb",            nid:   758, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "camellia-192-cfb1",         canonical: "camellia-192-cfb1",           nid:   761, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "camellia-192-cfb8",         canonical: "camellia-192-cfb8",           nid:   764, block_size:   1, iv_length:  16, key_length: 24, mode: "cfb"     },
    Spec { name: "camellia-192-ctr",          canonical: "camellia-192-ctr",            nid:   967, block_size:   1, iv_length:  16, key_length: 24, mode: "ctr"     },
    Spec { name: "camellia-192-ecb",          canonical: "camellia-192-ecb",            nid:   755, block_size:  16, iv_length:  -1, key_length: 24, mode: "ecb"     },
    Spec { name: "camellia-192-ofb",          canonical: "camellia-192-ofb",            nid:   767, block_size:   1, iv_length:  16, key_length: 24, mode: "ofb"     },
    Spec { name: "camellia-256-cbc",          canonical: "camellia-256-cbc",            nid:   753, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "camellia-256-cfb",          canonical: "camellia-256-cfb",            nid:   759, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "camellia-256-cfb1",         canonical: "camellia-256-cfb1",           nid:   762, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "camellia-256-cfb8",         canonical: "camellia-256-cfb8",           nid:   765, block_size:   1, iv_length:  16, key_length: 32, mode: "cfb"     },
    Spec { name: "camellia-256-ctr",          canonical: "camellia-256-ctr",            nid:   971, block_size:   1, iv_length:  16, key_length: 32, mode: "ctr"     },
    Spec { name: "camellia-256-ecb",          canonical: "camellia-256-ecb",            nid:   756, block_size:  16, iv_length:  -1, key_length: 32, mode: "ecb"     },
    Spec { name: "camellia-256-ofb",          canonical: "camellia-256-ofb",            nid:   768, block_size:   1, iv_length:  16, key_length: 32, mode: "ofb"     },
    Spec { name: "camellia128",               canonical: "camellia-128-cbc",            nid:   751, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "camellia192",               canonical: "camellia-192-cbc",            nid:   752, block_size:  16, iv_length:  16, key_length: 24, mode: "cbc"     },
    Spec { name: "camellia256",               canonical: "camellia-256-cbc",            nid:   753, block_size:  16, iv_length:  16, key_length: 32, mode: "cbc"     },
    Spec { name: "chacha20",                  canonical: "chacha20",                    nid:  1019, block_size:  -1, iv_length:  16, key_length: 32, mode: "stream"  },
    Spec { name: "chacha20-poly1305",         canonical: "chacha20-poly1305",           nid:  1018, block_size:  -1, iv_length:  12, key_length: 32, mode: "stream"  },
    Spec { name: "des-ede",                   canonical: "des-ede",                     nid:    32, block_size:   8, iv_length:  -1, key_length: 16, mode: "ecb"     },
    Spec { name: "des-ede-cbc",               canonical: "des-ede-cbc",                 nid:    43, block_size:   8, iv_length:   8, key_length: 16, mode: "cbc"     },
    Spec { name: "des-ede-cfb",               canonical: "des-ede-cfb",                 nid:    60, block_size:   1, iv_length:   8, key_length: 16, mode: "cfb"     },
    Spec { name: "des-ede-ecb",               canonical: "des-ede",                     nid:    32, block_size:   8, iv_length:  -1, key_length: 16, mode: "ecb"     },
    Spec { name: "des-ede-ofb",               canonical: "des-ede-ofb",                 nid:    62, block_size:   1, iv_length:   8, key_length: 16, mode: "ofb"     },
    Spec { name: "des-ede3",                  canonical: "des-ede3",                    nid:    33, block_size:   8, iv_length:  -1, key_length: 24, mode: "ecb"     },
    Spec { name: "des-ede3-cbc",              canonical: "des-ede3-cbc",                nid:    44, block_size:   8, iv_length:   8, key_length: 24, mode: "cbc"     },
    Spec { name: "des-ede3-cfb",              canonical: "des-ede3-cfb",                nid:    61, block_size:   1, iv_length:   8, key_length: 24, mode: "cfb"     },
    Spec { name: "des-ede3-cfb1",             canonical: "des-ede3-cfb1",               nid:   658, block_size:   1, iv_length:   8, key_length: 24, mode: "cfb"     },
    Spec { name: "des-ede3-cfb8",             canonical: "des-ede3-cfb8",               nid:   659, block_size:   1, iv_length:   8, key_length: 24, mode: "cfb"     },
    Spec { name: "des-ede3-ecb",              canonical: "des-ede3",                    nid:    33, block_size:   8, iv_length:  -1, key_length: 24, mode: "ecb"     },
    Spec { name: "des-ede3-ofb",              canonical: "des-ede3-ofb",                nid:    63, block_size:   1, iv_length:   8, key_length: 24, mode: "ofb"     },
    Spec { name: "des3",                      canonical: "des-ede3-cbc",                nid:    44, block_size:   8, iv_length:   8, key_length: 24, mode: "cbc"     },
    Spec { name: "des3-wrap",                 canonical: "id-smime-alg-cms3deswrap",    nid:   246, block_size:   8, iv_length:  -1, key_length: 24, mode: "wrap"    },
    Spec { name: "id-aes128-CCM",             canonical: "id-aes128-ccm",               nid:   896, block_size:   1, iv_length:  12, key_length: 16, mode: "ccm"     },
    Spec { name: "id-aes128-GCM",             canonical: "id-aes128-gcm",               nid:   895, block_size:   1, iv_length:  12, key_length: 16, mode: "gcm"     },
    Spec { name: "id-aes128-wrap",            canonical: "id-aes128-wrap",              nid:   788, block_size:   8, iv_length:   8, key_length: 16, mode: "wrap"    },
    Spec { name: "id-aes128-wrap-pad",        canonical: "id-aes128-wrap-pad",          nid:   897, block_size:   8, iv_length:   4, key_length: 16, mode: "wrap"    },
    Spec { name: "id-aes192-CCM",             canonical: "id-aes192-ccm",               nid:   899, block_size:   1, iv_length:  12, key_length: 24, mode: "ccm"     },
    Spec { name: "id-aes192-GCM",             canonical: "id-aes192-gcm",               nid:   898, block_size:   1, iv_length:  12, key_length: 24, mode: "gcm"     },
    Spec { name: "id-aes192-wrap",            canonical: "id-aes192-wrap",              nid:   789, block_size:   8, iv_length:   8, key_length: 24, mode: "wrap"    },
    Spec { name: "id-aes192-wrap-pad",        canonical: "id-aes192-wrap-pad",          nid:   900, block_size:   8, iv_length:   4, key_length: 24, mode: "wrap"    },
    Spec { name: "id-aes256-CCM",             canonical: "id-aes256-ccm",               nid:   902, block_size:   1, iv_length:  12, key_length: 32, mode: "ccm"     },
    Spec { name: "id-aes256-GCM",             canonical: "id-aes256-gcm",               nid:   901, block_size:   1, iv_length:  12, key_length: 32, mode: "gcm"     },
    Spec { name: "id-aes256-wrap",            canonical: "id-aes256-wrap",              nid:   790, block_size:   8, iv_length:   8, key_length: 32, mode: "wrap"    },
    Spec { name: "id-aes256-wrap-pad",        canonical: "id-aes256-wrap-pad",          nid:   903, block_size:   8, iv_length:   4, key_length: 32, mode: "wrap"    },
    Spec { name: "id-smime-alg-CMS3DESwrap",  canonical: "id-smime-alg-cms3deswrap",    nid:   246, block_size:   8, iv_length:  -1, key_length: 24, mode: "wrap"    },
    Spec { name: "sm4",                       canonical: "sm4-cbc",                     nid:  1134, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "sm4-cbc",                   canonical: "sm4-cbc",                     nid:  1134, block_size:  16, iv_length:  16, key_length: 16, mode: "cbc"     },
    Spec { name: "sm4-cfb",                   canonical: "sm4-cfb",                     nid:  1137, block_size:   1, iv_length:  16, key_length: 16, mode: "cfb"     },
    Spec { name: "sm4-ctr",                   canonical: "sm4-ctr",                     nid:  1139, block_size:   1, iv_length:  16, key_length: 16, mode: "ctr"     },
    Spec { name: "sm4-ecb",                   canonical: "sm4-ecb",                     nid:  1133, block_size:  16, iv_length:  -1, key_length: 16, mode: "ecb"     },
    Spec { name: "sm4-ofb",                   canonical: "sm4-ofb",                     nid:  1135, block_size:   1, iv_length:  16, key_length: 16, mode: "ofb"     },
];

impl Spec {
    /// Is `length` an acceptable IV length for this cipher?
    ///
    /// Most modes take exactly one IV length. The AEADs are the exception, and
    /// `test-crypto-getcipherinfo.js` pins both: CCM accepts 7..=13 bytes
    /// (RFC 3610's nonce range) and OCB 1..=15, while GCM accepts any
    /// non-empty IV because GHASH folds a non-96-bit one down itself.
    pub(crate) fn accepts_iv(&self, length: i64) -> bool {
        match self.mode {
            "ccm" => (7..=13).contains(&length),
            "ocb" => (1..=15).contains(&length),
            "gcm" => length >= 1,
            _ => length == self.iv_length,
        }
    }
}

/// The catalogue row for a cipher name, case-insensitively â€” OpenSSL's own
/// lookup is, and `createCipheriv('AES-128-CBC', â€¦)` works in Node.
pub(crate) fn by_name(name: &str) -> Option<&'static Spec> {
    SPECS
        .iter()
        .find(|spec| spec.name.eq_ignore_ascii_case(name))
}

/// The catalogue row for an OpenSSL NID. Several names share one NID
/// (`aes128-wrap` and `id-aes128-wrap` are both 788); the first row wins,
/// which is what makes `getCipherInfo(info.nid)` deep-equal `info` â€” the
/// answer carries the *canonical* name either way.
pub(crate) fn by_nid(nid: i64) -> Option<&'static Spec> {
    SPECS.iter().find(|spec| spec.nid == nid)
}

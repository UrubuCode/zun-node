//! `node:crypto` — the primitives behind Node's `crypto` module, as a native
//! `zun_abi` extension.
//!
//! # TS over natives
//!
//! `crypto` is a *TS-over-natives* module, the shape `node:os` established and
//! `node:fs`/`node:zlib` repeated, and the split is PLAN.md principle 2 again:
//!
//! - *This* crate answers only what needs a cryptographic primitive: one
//!   hash/HMAC state or one cipher per handle, `init`/`update`/`digest`/
//!   `final`, the three KDFs, the OS random source, the constant-time compare,
//!   and the algorithm catalogue. Nothing here knows what a stream, an option
//!   object, an encoding name or a Node error is.
//! - `src/crypto/crypto.ts` is the Node-shaped module: `Hash`/`Hmac`/
//!   `Cipheriv`/`Decipheriv` as `Transform` streams, the `create*` factories,
//!   the sync and callback KDF forms, the `random*` family, `KeyObject`,
//!   `constants`, the encoding handling and every `ERR_*` error.
//!
//! The TS layer reaches these functions with `import * as native from
//! "node:crypto"`.
//!
//! # The handle tables
//!
//! A hash and a cipher both outlive a single call, so this module keeps two
//! tables, exactly as `src/fs/fd.rs` keeps open files and `src/zlib/mod.rs`
//! keeps compression streams: the program holds a small integer and every
//! later call names it. The numbers count up from 1 and are never reused, so a
//! use-after-free is a distinct failure rather than a different object's
//! state.
//!
//! Hashes and HMACs share one table ([`DIGESTS`]) because they share their
//! whole interface — `update`, `digest`, `copy` — and Node's `Hash` and `Hmac`
//! differ only in which JS class wraps them. Ciphers have their own
//! ([`CIPHERS`]) because theirs is a different interface entirely.
//!
//! # What crosses the boundary
//!
//! ABI v1 carries one scalar word per value, so every fallible function here
//! returns **one status-prefixed, separator-delimited string**, in the grammar
//! `lib.rs` documents and `node:os`/`node:fs`/`node:zlib` already use:
//!
//! ```text
//! result  := "+" payload | "-"
//! payload := field (US field)*
//! US = U+001F     RS = U+001E
//! ```
//!
//! A leading `-` means the call failed and the error slots describe it; a
//! leading `+` means success. Keys, messages, digests, ciphertexts and random
//! bytes all cross as **base64** (`src/fs/base64.rs`), for the reason
//! `node:fs` gives: the `Str` carrier is a NUL-terminated C string, and none
//! of those is either NUL-free or UTF-8. The engine's prelude `Buffer`
//! implements that codec, so neither side hand-rolls one.
//!
//! ## Failure is reported in band
//!
//! A `node:crypto` native never returns a non-zero ABI status, for the reason
//! `src/fs/mod.rs` states at length: an error raised by an extension call does
//! not reach an enclosing `try`/`catch` as itself
//! (<https://github.com/UrubuCode/zun/issues/33>), and `crypto`'s error
//! surface is *all* caught — `assert.throws(() => createHash('xyzzy'))` and a
//! failed AEAD tag check are the first two things any consumer relies on.
//! Failure therefore travels as the single-character result `"-"`, with the
//! `(code, message)` pair in the per-thread error slots, read back through
//! `cryptoErrorCode` and `cryptoErrorMessage`.
//!
//! Those keys are `crypto`-prefixed, like every key in [`DESCRIPTORS`],
//! because the checker rejects a program whenever one *function name* is
//! registered by two modules, even behind namespace imports that already name
//! the module (<https://github.com/UrubuCode/zun/issues/35>).
//!
//! Behavior is defined by Node.js 25, whose `crypto` is a layer over OpenSSL,
//! so each error below carries the code and message OpenSSL produces — down to
//! `error:1C800064:Provider routines::bad decrypt`, which
//! `test-crypto-padding.js` matches as a literal. The acceptance bar is Node's
//! own `test-crypto*.js` suite — see `../../test/crypto/`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use subtle::ConstantTimeEq;
use zun_abi::ZunValue;

use crate::abi::{arg_bool, arg_i64, arg_str, ret_bool, ret_i64, ret_str};
use crate::fs::base64;
use crate::Descriptor;
use zun_abi::ZunTy::{Bool, I64, Str};

pub(crate) mod cipher;
pub(crate) mod ciphers;
pub(crate) mod hash;
pub(crate) mod kdf;
pub(crate) mod mac;
pub(crate) mod random;

#[cfg(test)]
mod tests;

/// Record separator: between the records of a list result.
const RS: char = '\u{1e}';
/// Unit separator: between the fields of one record.
const US: char = '\u{1f}';
/// The in-band failure marker.
const FAILED: &str = "-";

/// A live hashing object: `createHash`'s or `createHmac`'s.
enum Digester {
    Hash { state: hash::Hasher, length: usize },
    Mac(mac::Mac),
}

impl Clone for Digester {
    fn clone(&self) -> Digester {
        match self {
            Digester::Hash { state, length } => Digester::Hash {
                state: state.clone(),
                length: *length,
            },
            Digester::Mac(inner) => Digester::Mac(inner.clone()),
        }
    }
}

/// The two handle tables, behind a wrapper that asserts they may cross
/// threads.
///
/// `Box<dyn DynDigest>` carries no `Send` bound (the `digest` crate's trait
/// does not require one) and a process-wide `static` has to be `Sync`. The
/// assertion is sound for the same reason it is in `src/zlib/mod.rs`: the
/// `Mutex` is the only way in, every state is owned by its own handle, and no
/// reference to one outlives the call that took it.
struct Table<T>(HashMap<i64, T>);

// SAFETY: see above — exclusive access through the `Mutex`, no shared interior,
// nothing escaping a call.
unsafe impl<T> Send for Table<T> {}

static DIGESTS: Mutex<Option<Table<Digester>>> = Mutex::new(None);
static CIPHERS: Mutex<Option<Table<cipher::Cipher>>> = Mutex::new(None);

/// The next handle number, shared by both tables so that a handle is never
/// ambiguous even if one is passed to the wrong function. Starts at 1 so that
/// 0 is never valid.
static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);

fn with_digests<R>(action: impl FnOnce(&mut HashMap<i64, Digester>) -> R) -> R {
    let mut guard = DIGESTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&mut guard.get_or_insert_with(|| Table(HashMap::new())).0)
}

fn with_ciphers<R>(action: impl FnOnce(&mut HashMap<i64, cipher::Cipher>) -> R) -> R {
    let mut guard = CIPHERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    action(&mut guard.get_or_insert_with(|| Table(HashMap::new())).0)
}

fn next_handle() -> i64 {
    NEXT_HANDLE.fetch_add(1, Ordering::Relaxed)
}

/// Stash a `(code, message)` pair in the per-thread error slots and answer the
/// in-band failure marker.
fn fail(code: &str, message: &str) -> String {
    crate::abi::fail_system("", code, 0, message);
    FAILED.to_owned()
}

/// The failure a call naming a handle that is not in its table produces. The
/// TS layer never lets this happen (it checks the handle first, as Node checks
/// its own), so this is a defence rather than a path.
fn no_such_handle() -> String {
    fail("ERR_CRYPTO_INVALID_STATE", "Invalid state")
}

/// `+` with no payload: a successful call that answers nothing.
fn ok() -> String {
    "+".to_owned()
}

/// `+<payload>`.
fn ok_one(field: &str) -> String {
    let mut out = String::from("+");
    out.push_str(field);
    out
}

// ---------------------------------------------------------------------------
// The OpenSSL errors this module reproduces
//
// Node surfaces an OpenSSL failure as an `Error` whose `message` is OpenSSL's
// own `error:<hex>:<library>::<reason>` string and whose `code` is the
// `ERR_OSSL_*` spelling of the reason. `test-crypto-padding.js` matches both,
// plus the `reason` property the TS layer derives from the message, as
// literals — so the strings below are the ones OpenSSL 3 produces, not
// paraphrases.
// ---------------------------------------------------------------------------

const ERR_BAD_DECRYPT: (&str, &str) = (
    "ERR_OSSL_BAD_DECRYPT",
    "error:1C800064:Provider routines::bad decrypt",
);
const ERR_WRONG_FINAL_BLOCK_LENGTH: (&str, &str) = (
    "ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH",
    "error:1C80006B:Provider routines::wrong final block length",
);
const ERR_NOT_XOF: (&str, &str) = (
    "ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH",
    "error:030000B2:digital envelope routines::not XOF or invalid length",
);
/// Node's own message for a failed AEAD tag check, which carries no `code`.
const ERR_AUTH: (&str, &str) = (
    "",
    "Unsupported state or unable to authenticate data",
);

fn fail_pair(pair: (&str, &str)) -> String {
    fail(pair.0, pair.1)
}

/// Resolve a digest name, or answer the in-band failure with the code the KDFs
/// and HMAC report. `createHash` turns this into its own code-less `Error`.
fn resolve(name: &str) -> Result<hash::Alg, String> {
    hash::Alg::resolve(name).ok_or_else(|| {
        fail(
            "ERR_CRYPTO_INVALID_DIGEST",
            &format!("Invalid digest: {name}"),
        )
    })
}

// ---------------------------------------------------------------------------
// Hash and HMAC
// ---------------------------------------------------------------------------

/// `cryptoHashInit(algorithm, outputLength)` → `+<handle>`.
///
/// `outputLength` is `options.outputLength` or `-1` for "not given". Only an
/// XOF accepts a length other than its own digest size; anything else is
/// OpenSSL's `not XOF or invalid length`, which is what Node reports.
pub(crate) unsafe extern "C" fn hash_init(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let requested = unsafe { arg_i64(args, n, 1) };
    let payload = match resolve(name) {
        Err(failure) => failure,
        Ok(alg) => match digest_length(alg, requested) {
            None => fail_pair(ERR_NOT_XOF),
            Some(length) => {
                let handle = next_handle();
                with_digests(|table| {
                    table.insert(
                        handle,
                        Digester::Hash {
                            state: hash::Hasher::new(alg),
                            length,
                        },
                    )
                });
                ok_one(&handle.to_string())
            }
        },
    };
    unsafe { ret_str(out, &payload) }
}

/// The output length a `(algorithm, options.outputLength)` pair asks for, or
/// `None` if the pair is one OpenSSL rejects.
fn digest_length(alg: hash::Alg, requested: i64) -> Option<usize> {
    match requested {
        -1 => Some(alg.output_size()),
        length if length < 0 => None,
        length if alg.is_xof() => Some(length as usize),
        // A non-XOF tolerates its own size being named explicitly, which is
        // what `createHash('sha224', { outputLength: 28 })` does.
        length if length as usize == alg.output_size() => Some(length as usize),
        _ => None,
    }
}

/// `cryptoHmacInit(algorithm, key)` → `+<handle>`. `key` is base64.
pub(crate) unsafe extern "C" fn hmac_init(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let key = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let payload = match resolve(name) {
        Err(failure) => failure,
        // OpenSSL's HMAC takes a fixed-output digest; SHAKE has no fixed
        // output, so `createHmac('shake128', k)` is an invalid digest there
        // and here.
        Ok(alg) if alg.is_xof() => fail(
            "ERR_CRYPTO_INVALID_DIGEST",
            &format!("Invalid digest: {name}"),
        ),
        Ok(alg) => {
            let handle = next_handle();
            with_digests(|table| table.insert(handle, Digester::Mac(mac::Mac::new(alg, &key))));
            ok_one(&handle.to_string())
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoHashUpdate(handle, data)` → `+`. `data` is base64. Serves both a
/// `Hash` and an `Hmac`.
pub(crate) unsafe extern "C" fn hash_update(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let data = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let found = with_digests(|table| match table.get_mut(&handle) {
        Some(Digester::Hash { state, .. }) => {
            state.update(&data);
            true
        }
        Some(Digester::Mac(inner)) => {
            inner.update(&data);
            true
        }
        None => false,
    });
    let payload = if found { ok() } else { no_such_handle() };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoHashDigest(handle)` → `+<base64>`.
///
/// The state is *not* destroyed: Node's `Hash` marks itself finalized in
/// JavaScript (`ERR_CRYPTO_HASH_FINALIZED` comes from there), and the TS layer
/// frees the handle when the object is done with.
pub(crate) unsafe extern "C" fn hash_digest(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let digested = with_digests(|table| {
        table.get(&handle).map(|slot| match slot {
            Digester::Hash { state, length } => state.finish(*length),
            Digester::Mac(inner) => inner.finish(),
        })
    });
    let payload = match digested {
        Some(bytes) => ok_one(&base64::encode(&bytes)),
        None => no_such_handle(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoHashCopy(handle, outputLength)` → `+<handle>`. `Hash.prototype.copy`,
/// which may change the output length of an XOF (`copy({ outputLength: 5 })`).
/// `-1` keeps the current one.
pub(crate) unsafe extern "C" fn hash_copy(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let requested = unsafe { arg_i64(args, n, 1) };
    let copied = with_digests(|table| table.get(&handle).cloned());
    let payload = match copied {
        None => no_such_handle(),
        Some(mut slot) => {
            if requested >= 0 {
                match &mut slot {
                    Digester::Hash { length, .. } => *length = requested as usize,
                    // Node ignores `outputLength` on an Hmac copy; there is no
                    // `Hmac.prototype.copy` at all, so this is unreachable.
                    Digester::Mac(_) => {}
                }
            }
            let fresh = next_handle();
            with_digests(|table| table.insert(fresh, slot));
            ok_one(&fresh.to_string())
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoHashFree(handle)` → whether a handle was removed. Freeing twice is
/// not an error.
pub(crate) unsafe extern "C" fn hash_free(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let removed = with_digests(|table| table.remove(&handle).is_some());
    unsafe { ret_bool(out, removed) }
}

/// `cryptoHashOne(algorithm, data, outputLength)` → `+<base64>`.
/// `crypto.hash(...)`, Node 21's one-shot, which allocates no handle.
pub(crate) unsafe extern "C" fn hash_one(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let data = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let requested = unsafe { arg_i64(args, n, 2) };
    let payload = match resolve(name) {
        Err(failure) => failure,
        Ok(alg) => match digest_length(alg, requested) {
            None => fail_pair(ERR_NOT_XOF),
            Some(length) => {
                let mut hasher = hash::Hasher::new(alg);
                hasher.update(&data);
                ok_one(&base64::encode(&hasher.finish(length)))
            }
        },
    };
    unsafe { ret_str(out, &payload) }
}

// ---------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------

/// `cryptoRandomBytes(size)` → `+<base64>`, from the OS CSPRNG.
pub(crate) unsafe extern "C" fn random_bytes(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let size = unsafe { arg_i64(args, n, 0) };
    let payload = if size < 0 {
        fail("ERR_OUT_OF_RANGE", "size is out of range")
    } else {
        match random::bytes(size as usize) {
            Some(bytes) => ok_one(&base64::encode(&bytes)),
            None => fail("ERR_OPERATION_FAILED", "Operation failed: the OS CSPRNG refused"),
        }
    };
    unsafe { ret_str(out, &payload) }
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

/// `cryptoPbkdf2(digest, password, salt, iterations, keylen)` → `+<base64>`.
/// Both byte arguments are base64; the ranges are validated in the TS layer,
/// where Node's `ERR_OUT_OF_RANGE` messages live.
pub(crate) unsafe extern "C" fn pbkdf2(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let password = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let salt = match unsafe { arg_str(args, n, 2) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let iterations = unsafe { arg_i64(args, n, 3) };
    let keylen = unsafe { arg_i64(args, n, 4) };
    let payload = match resolve(name) {
        Err(failure) => failure,
        Ok(alg) if alg.is_xof() => fail(
            "ERR_CRYPTO_INVALID_DIGEST",
            &format!("Invalid digest: {name}"),
        ),
        Ok(_) if iterations < 1 || keylen < 0 => {
            fail("ERR_OUT_OF_RANGE", "iterations or keylen is out of range")
        }
        Ok(alg) => {
            let derived = kdf::pbkdf2(
                alg,
                &password,
                &salt,
                iterations as u32,
                keylen as usize,
            );
            ok_one(&base64::encode(&derived))
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoScrypt(password, salt, N, r, p, keylen)` → `+<base64>`.
pub(crate) unsafe extern "C" fn scrypt(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let password = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let salt = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let cost = unsafe { arg_i64(args, n, 2) };
    let block_size = unsafe { arg_i64(args, n, 3) };
    let parallel = unsafe { arg_i64(args, n, 4) };
    let keylen = unsafe { arg_i64(args, n, 5) };
    let invalid = cost < 0 || block_size < 0 || parallel < 0 || keylen < 0;
    let payload = if invalid {
        fail("ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "Invalid scrypt params")
    } else {
        match kdf::scrypt(
            &password,
            &salt,
            cost as u64,
            block_size as u32,
            parallel as u32,
            keylen as usize,
        ) {
            Some(derived) => ok_one(&base64::encode(&derived)),
            None => fail("ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "Invalid scrypt params"),
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoHkdf(digest, ikm, salt, info, keylen)` → `+<base64>`.
pub(crate) unsafe extern "C" fn hkdf(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let ikm = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let salt = match unsafe { arg_str(args, n, 2) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let info = match unsafe { arg_str(args, n, 3) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let keylen = unsafe { arg_i64(args, n, 4) };
    let payload = match resolve(name) {
        Err(failure) => failure,
        Ok(alg) if alg.is_xof() => fail(
            "ERR_CRYPTO_INVALID_DIGEST",
            &format!("Invalid digest: {name}"),
        ),
        Ok(alg) => match kdf::hkdf(alg, &ikm, &salt, &info, keylen.max(0) as usize) {
            Some(derived) => ok_one(&base64::encode(&derived)),
            None => fail("ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length"),
        },
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoTimingSafeEqual(a, b)` → whether the two base64 payloads are equal,
/// in time independent of where they differ.
///
/// The length check Node does (`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`) is in
/// the TS layer, because it is a *throw*, not a comparison result.
pub(crate) unsafe extern "C" fn timing_safe_equal(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let left = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let right = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let equal = left.len() == right.len() && bool::from(left.ct_eq(&right));
    unsafe { ret_bool(out, equal) }
}

// ---------------------------------------------------------------------------
// Ciphers
// ---------------------------------------------------------------------------

fn cipher_init_error(error: cipher::InitError) -> String {
    match error {
        cipher::InitError::UnknownCipher => fail("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher"),
        cipher::InitError::Unsupported => fail(
            "ERR_CRYPTO_UNSUPPORTED_OPERATION",
            "Unsupported crypto operation",
        ),
        cipher::InitError::InvalidKeyLength => {
            fail("ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length")
        }
        cipher::InitError::InvalidIv => {
            fail("ERR_CRYPTO_INVALID_IV", "Invalid initialization vector")
        }
        cipher::InitError::InvalidAuthTagLength => fail(
            "ERR_CRYPTO_INVALID_AUTH_TAG",
            "Invalid authentication tag length",
        ),
    }
}

fn cipher_error(error: cipher::Error) -> String {
    match error {
        cipher::Error::BadDecrypt => fail_pair(ERR_BAD_DECRYPT),
        cipher::Error::WrongFinalBlockLength => fail_pair(ERR_WRONG_FINAL_BLOCK_LENGTH),
        cipher::Error::AuthFailed => fail_pair(ERR_AUTH),
        cipher::Error::InvalidState => fail("ERR_CRYPTO_INVALID_STATE", "Invalid state"),
    }
}

/// `cryptoCipherInit(name, encrypt, key, iv, authTagLength)` → `+<handle>`.
/// Both byte arguments are base64; `authTagLength` is `-1` when absent.
pub(crate) unsafe extern "C" fn cipher_init(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let encrypt = unsafe { arg_bool(args, n, 1) };
    let key = match unsafe { arg_str(args, n, 2) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let iv = match unsafe { arg_str(args, n, 3) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let auth_tag_length = unsafe { arg_i64(args, n, 4) };
    let payload = match cipher::Cipher::prepare(name, encrypt, &key, &iv, auth_tag_length) {
        Ok(state) => {
            let handle = next_handle();
            with_ciphers(|table| table.insert(handle, state));
            ok_one(&handle.to_string())
        }
        Err(error) => cipher_init_error(error),
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherUpdate(handle, data)` → `+<base64>`.
pub(crate) unsafe extern "C" fn cipher_update(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let data = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let produced = with_ciphers(|table| table.get_mut(&handle).map(|state| state.update(&data)));
    let payload = match produced {
        Some(bytes) => ok_one(&base64::encode(&bytes)),
        None => no_such_handle(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherFinal(handle)` → `+<outputBase64>US<authTagBase64>`.
///
/// The tag field is empty unless this is an AEAD *encryption*, in which case
/// it is what `getAuthTag()` will answer — carried back in the same result so
/// the TS layer needs one call rather than two.
pub(crate) unsafe extern "C" fn cipher_final(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let result = with_ciphers(|table| {
        table.get_mut(&handle).map(|state| {
            let finished = state.finish();
            let tag = state.auth_tag().map(|bytes| bytes.to_vec()).ok();
            (finished, tag)
        })
    });
    let payload = match result {
        None => no_such_handle(),
        Some((Err(error), _)) => cipher_error(error),
        Some((Ok(bytes), tag)) => {
            let mut text = String::from("+");
            text.push_str(&base64::encode(&bytes));
            text.push(US);
            if let Some(tag) = tag {
                text.push_str(&base64::encode(&tag));
            }
            text
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherSetAAD(handle, aad)` → `+`.
pub(crate) unsafe extern "C" fn cipher_set_aad(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let aad = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let result = with_ciphers(|table| table.get_mut(&handle).map(|state| state.set_aad(&aad)));
    let payload = match result {
        None => no_such_handle(),
        Some(Err(error)) => cipher_error(error),
        Some(Ok(())) => ok(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherSetAuthTag(handle, tag)` → `+`.
pub(crate) unsafe extern "C" fn cipher_set_auth_tag(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let tag = match unsafe { arg_str(args, n, 1) } {
        Ok(text) => base64::decode(text),
        Err(status) => return status,
    };
    let result = with_ciphers(|table| {
        table
            .get_mut(&handle)
            .map(|state| state.set_auth_tag(&tag))
    });
    let payload = match result {
        None => no_such_handle(),
        Some(Err(error)) => cipher_error(error),
        Some(Ok(())) => ok(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherSetAutoPadding(handle, pad)` → `+`.
pub(crate) unsafe extern "C" fn cipher_set_auto_padding(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let pad = unsafe { arg_bool(args, n, 1) };
    let found = with_ciphers(|table| match table.get_mut(&handle) {
        Some(state) => {
            state.set_auto_padding(pad);
            true
        }
        None => false,
    });
    let payload = if found { ok() } else { no_such_handle() };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherTagLength(handle)` → the AEAD tag length in bytes, or `0`.
/// `Decipheriv` needs it to validate `setAuthTag`'s argument the way Node
/// does, before any data is written.
pub(crate) unsafe extern "C" fn cipher_tag_length(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let length = with_ciphers(|table| {
        table
            .get(&handle)
            .map(|state| state.tag_length() as i64)
            .unwrap_or(0)
    });
    unsafe { ret_i64(out, length) }
}

/// `cryptoCipherFree(handle)` → whether a handle was removed.
pub(crate) unsafe extern "C" fn cipher_free(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let handle = unsafe { arg_i64(args, n, 0) };
    let removed = with_ciphers(|table| table.remove(&handle).is_some());
    unsafe { ret_bool(out, removed) }
}

// ---------------------------------------------------------------------------
// The catalogues
// ---------------------------------------------------------------------------

/// `cryptoHashNames()` → `+<name>RS<name>…`, `crypto.getHashes()`.
pub(crate) unsafe extern "C" fn hash_names(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    unsafe { ret_str(out, &ok_one(&hash::HASH_NAMES.join(&RS.to_string()))) }
}

/// `cryptoCipherNames()` → `+<name>RS<name>…`, `crypto.getCiphers()`.
pub(crate) unsafe extern "C" fn cipher_names(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let names: Vec<&str> = ciphers::SPECS.iter().map(|spec| spec.name).collect();
    unsafe { ret_str(out, &ok_one(&names.join(&RS.to_string()))) }
}

/// `cryptoCurveNames()` → `+<name>RS<name>…`, `crypto.getCurves()`.
pub(crate) unsafe extern "C" fn curve_names(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    unsafe { ret_str(out, &ok_one(&CURVE_NAMES.join(&RS.to_string()))) }
}

/// One catalogue row as
/// `+<name>US<canonical>US<nid>US<blockSize>US<ivLength>US<keyLength>US<mode>`,
/// with `-1` for a field Node's info object omits. A `-` result means the
/// cipher is unknown, which `getCipherInfo` answers as `undefined` rather than
/// an error.
fn spec_record(spec: &ciphers::Spec) -> String {
    let fields = [
        spec.name.to_owned(),
        spec.canonical.to_owned(),
        spec.nid.to_string(),
        spec.block_size.to_string(),
        spec.iv_length.to_string(),
        spec.key_length.to_string(),
        spec.mode.to_owned(),
    ];
    ok_one(&fields.join(&US.to_string()))
}

/// `cryptoCipherSpec(name)` → the catalogue row for a cipher name.
pub(crate) unsafe extern "C" fn cipher_spec(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let payload = match ciphers::by_name(name) {
        Some(spec) => spec_record(spec),
        None => FAILED.to_owned(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherSpecByNid(nid)` → the catalogue row for an OpenSSL NID.
pub(crate) unsafe extern "C" fn cipher_spec_by_nid(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let nid = unsafe { arg_i64(args, n, 0) };
    let payload = match ciphers::by_nid(nid) {
        Some(spec) => spec_record(spec),
        None => FAILED.to_owned(),
    };
    unsafe { ret_str(out, &payload) }
}

/// `cryptoCipherIvOk(name, length)` → whether that IV length is one the cipher
/// accepts. `getCipherInfo(name, { ivLength })` answers `undefined` when it is
/// not, and the per-mode ranges (CCM 7..=13, OCB 1..=15, GCM any) are
/// OpenSSL's.
pub(crate) unsafe extern "C" fn cipher_iv_ok(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let name = match unsafe { arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let length = unsafe { arg_i64(args, n, 1) };
    let accepted = ciphers::by_name(name).is_some_and(|spec| spec.accepts_iv(length));
    unsafe { ret_bool(out, accepted) }
}

/// The named curves `crypto.getCurves()` reports.
///
/// This is OpenSSL's built-in curve list, transcribed, and it is *information*
/// rather than capability — exactly as the cipher catalogue in `ciphers.rs`
/// is. No elliptic-curve operation is implemented here (`ECDH`,
/// `generateKeyPair` and the EC signature algorithms are all absent), and
/// `getCurves` is the one function that answers nothing but names. In JS
/// `Array#sort` order, which is what `test-crypto.js` asserts.
const CURVE_NAMES: &[&str] = &[
    "Oakley-EC2N-3",
    "Oakley-EC2N-4",
    "SM2",
    "brainpoolP160r1",
    "brainpoolP160t1",
    "brainpoolP192r1",
    "brainpoolP192t1",
    "brainpoolP224r1",
    "brainpoolP224t1",
    "brainpoolP256r1",
    "brainpoolP256t1",
    "brainpoolP320r1",
    "brainpoolP320t1",
    "brainpoolP384r1",
    "brainpoolP384t1",
    "brainpoolP512r1",
    "brainpoolP512t1",
    "c2pnb163v1",
    "c2pnb163v2",
    "c2pnb163v3",
    "c2pnb176v1",
    "c2pnb208w1",
    "c2pnb272w1",
    "c2pnb304w1",
    "c2pnb368w1",
    "c2tnb191v1",
    "c2tnb191v2",
    "c2tnb191v3",
    "c2tnb239v1",
    "c2tnb239v2",
    "c2tnb239v3",
    "c2tnb359v1",
    "c2tnb431r1",
    "prime192v1",
    "prime192v2",
    "prime192v3",
    "prime239v1",
    "prime239v2",
    "prime239v3",
    "prime256v1",
    "secp112r1",
    "secp112r2",
    "secp128r1",
    "secp128r2",
    "secp160k1",
    "secp160r1",
    "secp160r2",
    "secp192k1",
    "secp224k1",
    "secp224r1",
    "secp256k1",
    "secp384r1",
    "secp521r1",
    "sect113r1",
    "sect113r2",
    "sect131r1",
    "sect131r2",
    "sect163k1",
    "sect163r1",
    "sect163r2",
    "sect193r1",
    "sect193r2",
    "sect233k1",
    "sect233r1",
    "sect239k1",
    "sect283k1",
    "sect283r1",
    "sect409k1",
    "sect409r1",
    "sect571k1",
    "sect571r1",
    "wap-wsg-idm-ecid-wtls1",
    "wap-wsg-idm-ecid-wtls10",
    "wap-wsg-idm-ecid-wtls11",
    "wap-wsg-idm-ecid-wtls12",
    "wap-wsg-idm-ecid-wtls3",
    "wap-wsg-idm-ecid-wtls4",
    "wap-wsg-idm-ecid-wtls5",
    "wap-wsg-idm-ecid-wtls6",
    "wap-wsg-idm-ecid-wtls7",
    "wap-wsg-idm-ecid-wtls8",
    "wap-wsg-idm-ecid-wtls9",
];

/// The `node:crypto` functions published to the host. Keys are the names
/// `src/crypto/crypto.ts` calls through its `node:crypto` namespace import,
/// each `crypto`-prefixed so no other module in this library registers the
/// same name (<https://github.com/UrubuCode/zun/issues/35>).
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor {
        key: b"cryptoHashInit\0",
        params: &[Str, I64],
        ret: Str,
        invoke: hash_init,
    },
    Descriptor {
        key: b"cryptoHmacInit\0",
        params: &[Str, Str],
        ret: Str,
        invoke: hmac_init,
    },
    Descriptor {
        key: b"cryptoHashUpdate\0",
        params: &[I64, Str],
        ret: Str,
        invoke: hash_update,
    },
    Descriptor {
        key: b"cryptoHashDigest\0",
        params: &[I64],
        ret: Str,
        invoke: hash_digest,
    },
    Descriptor {
        key: b"cryptoHashCopy\0",
        params: &[I64, I64],
        ret: Str,
        invoke: hash_copy,
    },
    Descriptor {
        key: b"cryptoHashFree\0",
        params: &[I64],
        ret: Bool,
        invoke: hash_free,
    },
    Descriptor {
        key: b"cryptoHashOne\0",
        params: &[Str, Str, I64],
        ret: Str,
        invoke: hash_one,
    },
    Descriptor {
        key: b"cryptoRandomBytes\0",
        params: &[I64],
        ret: Str,
        invoke: random_bytes,
    },
    Descriptor {
        key: b"cryptoPbkdf2\0",
        params: &[Str, Str, Str, I64, I64],
        ret: Str,
        invoke: pbkdf2,
    },
    Descriptor {
        key: b"cryptoScrypt\0",
        params: &[Str, Str, I64, I64, I64, I64],
        ret: Str,
        invoke: scrypt,
    },
    Descriptor {
        key: b"cryptoHkdf\0",
        params: &[Str, Str, Str, Str, I64],
        ret: Str,
        invoke: hkdf,
    },
    Descriptor {
        key: b"cryptoTimingSafeEqual\0",
        params: &[Str, Str],
        ret: Bool,
        invoke: timing_safe_equal,
    },
    Descriptor {
        key: b"cryptoCipherInit\0",
        params: &[Str, Bool, Str, Str, I64],
        ret: Str,
        invoke: cipher_init,
    },
    Descriptor {
        key: b"cryptoCipherUpdate\0",
        params: &[I64, Str],
        ret: Str,
        invoke: cipher_update,
    },
    Descriptor {
        key: b"cryptoCipherFinal\0",
        params: &[I64],
        ret: Str,
        invoke: cipher_final,
    },
    Descriptor {
        key: b"cryptoCipherSetAAD\0",
        params: &[I64, Str],
        ret: Str,
        invoke: cipher_set_aad,
    },
    Descriptor {
        key: b"cryptoCipherSetAuthTag\0",
        params: &[I64, Str],
        ret: Str,
        invoke: cipher_set_auth_tag,
    },
    Descriptor {
        key: b"cryptoCipherSetAutoPadding\0",
        params: &[I64, Bool],
        ret: Str,
        invoke: cipher_set_auto_padding,
    },
    Descriptor {
        key: b"cryptoCipherTagLength\0",
        params: &[I64],
        ret: I64,
        invoke: cipher_tag_length,
    },
    Descriptor {
        key: b"cryptoCipherFree\0",
        params: &[I64],
        ret: Bool,
        invoke: cipher_free,
    },
    Descriptor {
        key: b"cryptoHashNames\0",
        params: &[],
        ret: Str,
        invoke: hash_names,
    },
    Descriptor {
        key: b"cryptoCipherNames\0",
        params: &[],
        ret: Str,
        invoke: cipher_names,
    },
    Descriptor {
        key: b"cryptoCurveNames\0",
        params: &[],
        ret: Str,
        invoke: curve_names,
    },
    Descriptor {
        key: b"cryptoCipherSpec\0",
        params: &[Str],
        ret: Str,
        invoke: cipher_spec,
    },
    Descriptor {
        key: b"cryptoCipherSpecByNid\0",
        params: &[I64],
        ret: Str,
        invoke: cipher_spec_by_nid,
    },
    Descriptor {
        key: b"cryptoCipherIvOk\0",
        params: &[Str, I64],
        ret: Bool,
        invoke: cipher_iv_ok,
    },
    // The error slots (the ABI v1 convention, see lib.rs), under `crypto`-
    // prefixed keys for the reason the module documentation gives.
    Descriptor {
        key: b"cryptoErrorCode\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_code,
    },
    Descriptor {
        key: b"cryptoErrorMessage\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_message,
    },
];

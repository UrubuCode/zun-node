//! The OS random source behind `randomBytes`, `randomFill`, `randomInt`,
//! `randomUUID` and `getRandomValues`.
//!
//! There is one correct answer here and it is the operating system's CSPRNG:
//! `BCryptGenRandom` on Windows, `getrandom(2)` on Linux. That is the source
//! `uv_random` and OpenSSL's `RAND_bytes` draw from, and `getrandom` is the
//! crate that wraps exactly those two calls and nothing else — no userspace
//! pool, no seeding, no state of its own to get wrong.

/// `n` cryptographically secure random bytes, or `None` if the OS refused.
///
/// A failure is real (a sandbox without the syscall, an early-boot entropy
/// error) and must not be papered over with a fallback: Node reports it as
/// `ERR_OPERATION_FAILED` rather than producing predictable bytes.
pub(crate) fn bytes(n: usize) -> Option<Vec<u8>> {
    let mut out = vec![0u8; n];
    getrandom::getrandom(&mut out).ok()?;
    Some(out)
}

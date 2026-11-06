//! `node:fs` metadata: stat/lstat, statfs, realpath, chmod, chown, utimes.
//!
//! `fsStat` hands the TS layer the whole `uv_stat_t` in one call, in a fixed
//! field order, because that is what Node's `Stats` object *is* — a record of
//! those fields and nothing else. One call per field would both cost 18
//! syscalls and let the fields disagree with each other if the file changed
//! between two of them.

use std::fs;

use zun_abi::ZunValue;

use super::sys::{self, RawStat};
use super::{fail_io, ok, ok_fields, ok_one};
use crate::abi::{arg_bool, arg_f64, arg_i64, arg_str, ret_str};

/// The 18 fields of a `uv_stat_t`, in the order `src/fs/fs.ts`'s
/// `__fsStatsFromFields` reads them.
///
/// Every field is a decimal integer *string*, not a float: `dev` and `ino` can
/// exceed 2^53 on Windows (the file index is a 64-bit value) and
/// `BigIntStats` has to report them exactly, which it can only do if the text
/// that crossed was exact. Each timestamp is a `(seconds, nanoseconds)` pair
/// for the same reason — `Stats.atimeMs` is a double and `BigIntStats.atimeNs`
/// an exact integer, and both are derivable from the pair while neither is
/// derivable from the other.
pub(super) fn encode_stat(raw: &RawStat) -> String {
    ok_fields(&[
        raw.dev.to_string(),
        raw.mode.to_string(),
        raw.nlink.to_string(),
        raw.uid.to_string(),
        raw.gid.to_string(),
        raw.rdev.to_string(),
        raw.blksize.to_string(),
        raw.ino.to_string(),
        raw.size.to_string(),
        raw.blocks.to_string(),
        raw.atime.0.to_string(),
        raw.atime.1.to_string(),
        raw.mtime.0.to_string(),
        raw.mtime.1.to_string(),
        raw.ctime.0.to_string(),
        raw.ctime.1.to_string(),
        raw.birthtime.0.to_string(),
        raw.birthtime.1.to_string(),
    ])
}

/// `fsStat(path, follow)` — `uv_fs_stat` when `follow`, `uv_fs_lstat` otherwise.
pub(crate) unsafe extern "C" fn fs_stat(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let follow = unsafe { arg_bool(args, n, 1) };
    let metadata = if follow { fs::metadata(path) } else { fs::symlink_metadata(path) };
    let payload = match metadata {
        Ok(metadata) => encode_stat(&sys::raw_stat_of(&metadata, Some(path))),
        Err(err) => fail_io(if follow { "stat" } else { "lstat" }, &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsStatfs(path)` — `uv_fs_statfs`, as Node's `StatFs` reports it.
pub(crate) unsafe extern "C" fn fs_statfs(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let payload = match sys::statfs(path) {
        Ok(stats) => ok_fields(&[
            stats.kind.to_string(),
            stats.bsize.to_string(),
            stats.blocks.to_string(),
            stats.bfree.to_string(),
            stats.bavail.to_string(),
            stats.files.to_string(),
            stats.ffree.to_string(),
        ]),
        Err(err) => fail_io("statfs", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsRealpath(path)` — `uv_fs_realpath`.
///
/// `fs::canonicalize` is `GetFinalPathNameByHandle` on Windows, which is also
/// what libuv calls, so both return the `\\?\`-prefixed form; the prefix is
/// stripped here because Node strips it before returning (its `realpath` does
/// not hand back extended-length paths).
pub(crate) unsafe extern "C" fn fs_realpath(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let payload = match fs::canonicalize(path) {
        Ok(resolved) => ok_one(&with_root_separator(&strip_verbatim(
            &resolved.to_string_lossy(),
        ))),
        Err(err) => fail_io("realpath", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// libuv reports a *root* with its trailing separator -- `C:\`,
/// `\\server\share\` -- while `fs::canonicalize` normalises it away, so it is
/// put back. Node's own `test-fs-readfilesync-enoent.js` compares
/// `realpathSync` of a file-server share root against `path.resolve` of the
/// same string, and the two differ by exactly that character.
#[cfg(windows)]
pub(crate) fn with_root_separator(path: &str) -> String {
    // `C:` -> `C:\`
    if path.len() == 2 && path.as_bytes()[1] == b':' {
        return format!("{path}\\");
    }
    // `\\server\share` -> `\\server\share\` (exactly two components after the
    // leading pair of separators; anything deeper is not a root).
    if let Some(rest) = path.strip_prefix(r"\\") {
        let separators = rest.matches('\\').count();
        if !rest.is_empty() && separators == 1 && !rest.ends_with('\\') {
            return format!("{path}\\");
        }
    }
    path.to_owned()
}

#[cfg(not(windows))]
pub(crate) fn with_root_separator(path: &str) -> String {
    path.to_owned()
}

/// Drop Windows' extended-length prefix: `\\?\C:\x` → `C:\x`, and
/// `\\?\UNC\host\share` → `\\host\share`.
fn strip_verbatim(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        return rest.to_owned();
    }
    path.to_owned()
}

/// `fsChmod(path, mode)` — `uv_fs_chmod`.
pub(crate) unsafe extern "C" fn fs_chmod(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let mode = unsafe { arg_i64(args, n, 1) };
    let payload = match sys::chmod(path, mode) {
        Ok(()) => ok(),
        Err(err) => fail_io("chmod", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsChown(path, uid, gid, follow)` — `uv_fs_chown` / `uv_fs_lchown`.
pub(crate) unsafe extern "C" fn fs_chown(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let uid = unsafe { arg_i64(args, n, 1) };
    let gid = unsafe { arg_i64(args, n, 2) };
    let follow = unsafe { arg_bool(args, n, 3) };
    let payload = match sys::chown(path, uid, gid, follow) {
        Ok(()) => ok(),
        Err(err) => fail_io(if follow { "chown" } else { "lchown" }, &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsUtimes(path, atimeMs, mtimeMs, follow)` — `uv_fs_utime` / `uv_fs_lutime`.
pub(crate) unsafe extern "C" fn fs_utimes(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let atime = sys::millis_to_parts(unsafe { arg_f64(args, n, 1) });
    let mtime = sys::millis_to_parts(unsafe { arg_f64(args, n, 2) });
    let follow = unsafe { arg_bool(args, n, 3) };
    let payload = match sys::utimes(path, atime, mtime, follow) {
        Ok(()) => ok(),
        Err(err) => fail_io(if follow { "utime" } else { "lutime" }, &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_verbatim_prefix_is_stripped_in_both_forms() {
        assert_eq!(strip_verbatim(r"\\?\C:\Windows"), r"C:\Windows");
        assert_eq!(strip_verbatim(r"\\?\UNC\host\share"), r"\\host\share");
        assert_eq!(strip_verbatim("/usr/lib"), "/usr/lib");
    }

    #[test]
    fn a_stat_payload_carries_eighteen_fields() {
        let raw = RawStat { size: 7, mode: 0o100644, ..RawStat::default() };
        let encoded = encode_stat(&raw);
        assert!(encoded.starts_with('+'));
        let fields: Vec<&str> = encoded[1..].split(super::super::US).collect();
        assert_eq!(fields.len(), 18);
        assert_eq!(fields[8], "7");
    }
}

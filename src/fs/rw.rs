//! `node:fs` whole-file reads and writes, existence and access, copy:
//! `fsExists`, `fsAccess`, `fsReadFile`, `fsWriteFile`, `fsTruncate`,
//! `fsCopyFile`.
//!
//! The data of a read or a write crosses as base64 (see the module
//! documentation): the `Str` carrier is NUL-terminated, so it cannot carry a
//! file's bytes, and the TS layer turns the text into the engine's prelude
//! `Buffer` — which is what makes `readFileSync(p)` with no encoding return a
//! real `Buffer` rather than a lossy string.

use std::fs;
use std::io::Write;

use zun_abi::ZunValue;

use super::consts::UV_FS_COPYFILE_EXCL;
use super::{base64, fail_code, fail_io, fail_io2, ok, ok_one, sys};
use crate::abi::{arg_i64, arg_str, ret_bool, ret_str};

/// `fsExists(path)` — never fails; `false` for any error, as Node's
/// `existsSync` does (it swallows the `stat` error rather than reporting it).
pub(crate) unsafe extern "C" fn fs_exists(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    // `symlink_metadata` would be wrong here: Node's `existsSync` is
    // `uv_fs_access(F_OK)`, which follows symlinks, so a dangling symlink does
    // not exist.
    unsafe { ret_bool(out, fs::metadata(path).is_ok()) }
}

/// `fsAccess(path, mode)` — `uv_fs_access`.
pub(crate) unsafe extern "C" fn fs_access(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let mode = unsafe { arg_i64(args, n, 1) };
    let payload = match sys::access(path, mode) {
        Ok(()) => ok(),
        Err(err) => fail_io("access", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsReadFile(path)` → `+<base64 of the file's bytes>`.
///
/// Node reads a whole file with `open`/`fstat`/`read`*/`close`; the one
/// difference that shows is that it reports `EISDIR` for a directory on POSIX,
/// which `fs::read` also does.
pub(crate) unsafe extern "C" fn fs_read_file(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let payload = match fs::read(path) {
        Ok(bytes) => ok_one(&base64::encode(&bytes)),
        Err(err) => fail_io("open", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsWriteFile(path, base64, flags, mode)`.
///
/// `flags` is the same bitmask `fsOpen` takes, so `writeFileSync(p, d, { flag:
/// "a" })` appends and `{ flag: "wx" }` fails with `EEXIST` without the TS
/// layer having to know how either is spelled on this platform.
pub(crate) unsafe extern "C" fn fs_write_file(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let data = match unsafe { arg_str(args, n, 1) } {
        Ok(data) => data,
        Err(status) => return status,
    };
    let flags = unsafe { arg_i64(args, n, 2) };
    let mode = unsafe { arg_i64(args, n, 3) };
    let bytes = base64::decode(data);

    let payload = match sys::open(path, flags, mode) {
        Ok(mut file) => match file.write_all(&bytes) {
            Ok(()) => ok(),
            Err(err) => fail_io("write", &err, path),
        },
        Err(err) => fail_io("open", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsTruncate(path, len)` — `uv_fs_truncate`, which is `open` + `ftruncate`.
pub(crate) unsafe extern "C" fn fs_truncate(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let len = unsafe { arg_i64(args, n, 1) }.max(0) as u64;
    let payload = match fs::OpenOptions::new().write(true).open(path) {
        Ok(file) => match file.set_len(len) {
            Ok(()) => ok(),
            Err(err) => fail_io("ftruncate", &err, path),
        },
        Err(err) => fail_io("open", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsCopyFile(src, dest, mode)` — `uv_fs_copyfile`.
///
/// `COPYFILE_EXCL` is honored here rather than by an `O_EXCL` open, because
/// `fs::copy` owns the destination open; the two `FICLONE` bits are advisory
/// (libuv falls back to a byte copy wherever the filesystem cannot reflink,
/// which is what `fs::copy` always does).
pub(crate) unsafe extern "C" fn fs_copy_file(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let src = match unsafe { arg_str(args, n, 0) } {
        Ok(src) => src,
        Err(status) => return status,
    };
    let dest = match unsafe { arg_str(args, n, 1) } {
        Ok(dest) => dest,
        Err(status) => return status,
    };
    let mode = unsafe { arg_i64(args, n, 2) };

    if mode & UV_FS_COPYFILE_EXCL != 0 && fs::symlink_metadata(dest).is_ok() {
        let payload = fail_code("copyfile", "EEXIST", src, dest);
        return unsafe { ret_str(out, &payload) };
    }
    let payload = match fs::copy(src, dest) {
        Ok(_) => ok(),
        Err(err) => fail_io2("copyfile", &err, src, dest),
    };
    unsafe { ret_str(out, &payload) }
}

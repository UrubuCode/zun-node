//! `node:fs` move and links: `fsRename`, `fsLink` (hard link), `fsSymlink`,
//! `fsReadlink`.

use std::fs;

use zun_abi::ZunValue;

use super::{fail_io, fail_io2, ok, ok_one, sys};
use crate::abi::{arg_i64, arg_str, ret_str};

/// `fsRename(from, to)` — `uv_fs_rename`.
pub(crate) unsafe extern "C" fn fs_rename(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let from = match unsafe { arg_str(args, n, 0) } {
        Ok(from) => from,
        Err(status) => return status,
    };
    let to = match unsafe { arg_str(args, n, 1) } {
        Ok(to) => to,
        Err(status) => return status,
    };
    let payload = match fs::rename(from, to) {
        Ok(()) => ok(),
        Err(err) => fail_io2("rename", &err, from, to),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsLink(existingPath, newPath)` — `uv_fs_link`, a hard link.
pub(crate) unsafe extern "C" fn fs_link(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let existing = match unsafe { arg_str(args, n, 0) } {
        Ok(existing) => existing,
        Err(status) => return status,
    };
    let new_path = match unsafe { arg_str(args, n, 1) } {
        Ok(new_path) => new_path,
        Err(status) => return status,
    };
    let payload = match fs::hard_link(existing, new_path) {
        Ok(()) => ok(),
        Err(err) => fail_io2("link", &err, existing, new_path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsSymlink(target, path, flags)` — `uv_fs_symlink`.
///
/// `flags` is the `UV_FS_SYMLINK_DIR` / `UV_FS_SYMLINK_JUNCTION` pair, which
/// the TS layer has already resolved from Node's `type` argument (including
/// Node's own rule that an omitted `type` on Windows is decided by `stat`ing
/// the target). POSIX has one kind of symlink and ignores the flags, exactly as
/// libuv does.
pub(crate) unsafe extern "C" fn fs_symlink(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let target = match unsafe { arg_str(args, n, 0) } {
        Ok(target) => target,
        Err(status) => return status,
    };
    let path = match unsafe { arg_str(args, n, 1) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let kind = unsafe { arg_i64(args, n, 2) };
    let payload = match sys::symlink(target, path, kind) {
        Ok(()) => ok(),
        Err(err) => fail_io2("symlink", &err, target, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsReadlink(path)` — `uv_fs_readlink`, the target a symbolic link holds.
pub(crate) unsafe extern "C" fn fs_readlink(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let payload = match fs::read_link(path) {
        Ok(target) => ok_one(&target.to_string_lossy()),
        Err(err) => fail_io("readlink", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

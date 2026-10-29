//! `node:fs` move/copy and links: renameSync, copyFileSync, linkSync (hard
//! link), symlinkSync, readlinkSync.

use std::fs;

use zun_abi::ZunValue;

use super::{fs_fail, fs_fail2};
use crate::abi::{arg_str, ok, ret_str};

/// `fs.renameSync(from, to)`.
pub(crate) unsafe extern "C" fn rename_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let from = match unsafe { arg_str(args, n, 0) } {
        Ok(from) => from,
        Err(status) => return status,
    };
    let to = match unsafe { arg_str(args, n, 1) } {
        Ok(to) => to,
        Err(status) => return status,
    };
    match fs::rename(from, to) {
        Ok(()) => ok(),
        Err(err) => fs_fail2(&err, "rename", from, to),
    }
}

/// `fs.copyFileSync(src, dest)`.
pub(crate) unsafe extern "C" fn copy_file_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let src = match unsafe { arg_str(args, n, 0) } {
        Ok(src) => src,
        Err(status) => return status,
    };
    let dest = match unsafe { arg_str(args, n, 1) } {
        Ok(dest) => dest,
        Err(status) => return status,
    };
    match fs::copy(src, dest) {
        Ok(_) => ok(),
        Err(err) => fs_fail2(&err, "copyfile", src, dest),
    }
}

/// `fs.linkSync(existingPath, newPath)` — a hard link.
pub(crate) unsafe extern "C" fn link_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let existing = match unsafe { arg_str(args, n, 0) } {
        Ok(existing) => existing,
        Err(status) => return status,
    };
    let new_path = match unsafe { arg_str(args, n, 1) } {
        Ok(new_path) => new_path,
        Err(status) => return status,
    };
    match fs::hard_link(existing, new_path) {
        Ok(()) => ok(),
        Err(err) => fs_fail2(&err, "link", existing, new_path),
    }
}

/// `fs.symlinkSync(target, path)` — a symbolic link. On Windows this creates a
/// file symlink (Node's default `type` when omitted); directory symlinks are a
/// follow-up that threads the explicit `type` argument.
pub(crate) unsafe extern "C" fn symlink_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let target = match unsafe { arg_str(args, n, 0) } {
        Ok(target) => target,
        Err(status) => return status,
    };
    let path = match unsafe { arg_str(args, n, 1) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    #[cfg(unix)]
    let result = std::os::unix::fs::symlink(target, path);
    #[cfg(windows)]
    let result = std::os::windows::fs::symlink_file(target, path);
    #[cfg(not(any(unix, windows)))]
    let result = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlink unsupported on this platform",
    ));
    match result {
        Ok(()) => ok(),
        Err(err) => fs_fail2(&err, "symlink", target, path),
    }
}

/// `fs.readlinkSync(path)` — the target a symbolic link points to.
pub(crate) unsafe extern "C" fn readlink_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::read_link(path) {
        Ok(target) => unsafe { ret_str(out, &target.to_string_lossy()) },
        Err(err) => fs_fail(&err, "readlink", path),
    }
}

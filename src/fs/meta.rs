//! `node:fs` metadata: statSync/lstatSync (kind), size, mtime/atime/birthtime in
//! milliseconds, and realpathSync. The host composes these scalar getters into a
//! `Stats` object on the JS side.

use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

use zun_abi::ZunValue;

use super::fs_fail;
use crate::abi::{arg_str, ret_f64, ret_i64, ret_str};

/// The entry kind of `metadata`, mapped to a short tag the host turns into the
/// `Stats.isFile()`/`isDirectory()`/… predicates.
fn kind_tag(metadata: &fs::Metadata) -> &'static str {
    let file_type = metadata.file_type();
    if file_type.is_file() {
        "file"
    } else if file_type.is_dir() {
        "directory"
    } else if file_type.is_symlink() {
        "symlink"
    } else {
        "other"
    }
}

/// A `SystemTime` as milliseconds since the Unix epoch (`0.0` if unavailable).
fn millis(time: std::io::Result<SystemTime>) -> f64 {
    time.ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// `fs.statSync(path).<kind>` — follows symlinks.
pub(crate) unsafe extern "C" fn stat_kind(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::metadata(path) {
        Ok(metadata) => unsafe { ret_str(out, kind_tag(&metadata)) },
        Err(err) => fs_fail(&err, "stat", path),
    }
}

/// `fs.lstatSync(path).<kind>` — does not follow symlinks.
pub(crate) unsafe extern "C" fn lstat_kind(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::symlink_metadata(path) {
        Ok(metadata) => unsafe { ret_str(out, kind_tag(&metadata)) },
        Err(err) => fs_fail(&err, "lstat", path),
    }
}

/// `fs.statSync(path).size` in bytes (follows symlinks).
pub(crate) unsafe extern "C" fn stat_size(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::metadata(path) {
        Ok(metadata) => unsafe { ret_i64(out, metadata.len() as i64) },
        Err(err) => fs_fail(&err, "stat", path),
    }
}

/// `fs.statSync(path).mtimeMs` — last-modified time in epoch milliseconds.
pub(crate) unsafe extern "C" fn stat_mtime_ms(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::metadata(path) {
        Ok(metadata) => unsafe { ret_f64(out, millis(metadata.modified())) },
        Err(err) => fs_fail(&err, "stat", path),
    }
}

/// `fs.statSync(path).atimeMs` — last-access time in epoch milliseconds.
pub(crate) unsafe extern "C" fn stat_atime_ms(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::metadata(path) {
        Ok(metadata) => unsafe { ret_f64(out, millis(metadata.accessed())) },
        Err(err) => fs_fail(&err, "stat", path),
    }
}

/// `fs.statSync(path).birthtimeMs` — creation time in epoch milliseconds
/// (`0.0` on platforms that do not record it).
pub(crate) unsafe extern "C" fn stat_birthtime_ms(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::metadata(path) {
        Ok(metadata) => unsafe { ret_f64(out, millis(metadata.created())) },
        Err(err) => fs_fail(&err, "stat", path),
    }
}

/// `fs.realpathSync(path)` — the canonical absolute path.
pub(crate) unsafe extern "C" fn realpath_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::canonicalize(path) {
        Ok(resolved) => unsafe { ret_str(out, &resolved.to_string_lossy()) },
        Err(err) => fs_fail(&err, "realpath", path),
    }
}

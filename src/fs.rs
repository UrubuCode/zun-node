//! `node:fs` — synchronous filesystem surface, implemented natively over
//! `std::fs` and exposed through the `zun_abi` extension contract.
//!
//! Scope of this slice: the synchronous, UTF-8/text path. Deferred until the
//! ABI can carry a managed byte buffer: byte-exact `readFileSync` without an
//! encoding, file descriptors, and the callback/promise/stream surfaces.
//!
//! Each function is a [`zun_abi::ZunInvoke`]. String arguments and results use
//! the crate's [`crate::abi`] carrier helpers; a failure stashes a Node-accurate
//! `(code, message)` via [`crate::abi::fail`] and returns a non-zero status.

use std::fs;
use std::io;
use std::path::Path;

use zun_abi::ZunValue;

use crate::abi::{arg_str, fail, ok, ret_bool, ret_f64, ret_i64, ret_str};

/// Map a `std::io::Error` to Node's `(code, description)` pair. Errno first
/// (stable for the POSIX set), then `ErrorKind` for unnumbered errors.
fn error_code(err: &io::Error) -> (&'static str, &'static str) {
    if let Some(errno) = err.raw_os_error() {
        match errno {
            1 => return ("EPERM", "operation not permitted"),
            2 => return ("ENOENT", "no such file or directory"),
            13 => return ("EACCES", "permission denied"),
            17 => return ("EEXIST", "file already exists"),
            20 => return ("ENOTDIR", "not a directory"),
            21 => return ("EISDIR", "illegal operation on a directory"),
            39 | 66 => return ("ENOTEMPTY", "directory not empty"),
            _ => {}
        }
    }
    match err.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        _ => ("EIO", "i/o error"),
    }
}

/// Report a failed `syscall` on `path` as a Node-style error.
fn fs_fail(err: &io::Error, syscall: &str, path: &str) -> i32 {
    let (code, description) = error_code(err);
    fail(code, &format!("{code}: {description}, {syscall} '{path}'"))
}

/// Report the two-path variant (`rename`, `copyfile`).
fn fs_fail2(err: &io::Error, syscall: &str, a: &str, b: &str) -> i32 {
    let (code, description) = error_code(err);
    fail(code, &format!("{code}: {description}, {syscall} '{a}' -> '{b}'"))
}

/// `fs.existsSync(path)` — never fails; `false` for any error (matching Node).
pub unsafe extern "C" fn exists_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    unsafe { ret_bool(out, Path::new(path).exists()) }
}

/// `fs.readFileSync(path, "utf8")`.
pub unsafe extern "C" fn read_file_utf8(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::read(path) {
        Ok(bytes) => unsafe { ret_str(out, &String::from_utf8_lossy(&bytes)) },
        Err(err) => fs_fail(&err, "open", path),
    }
}

/// `fs.writeFileSync(path, data)` — overwrite with UTF-8 text.
pub unsafe extern "C" fn write_file_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let data = match unsafe { arg_str(args, n, 1) } {
        Ok(data) => data,
        Err(status) => return status,
    };
    match fs::write(path, data) {
        Ok(()) => ok(),
        Err(err) => fs_fail(&err, "open", path),
    }
}

/// `fs.appendFileSync(path, data)` — append UTF-8 text, creating the file.
pub unsafe extern "C" fn append_file_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    use std::io::Write;
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let data = match unsafe { arg_str(args, n, 1) } {
        Ok(data) => data,
        Err(status) => return status,
    };
    let mut file = match fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(file) => file,
        Err(err) => return fs_fail(&err, "open", path),
    };
    match file.write_all(data.as_bytes()) {
        Ok(()) => ok(),
        Err(err) => fs_fail(&err, "write", path),
    }
}

/// `fs.mkdirSync(path, { recursive })` — the boolean carries `recursive`.
pub unsafe extern "C" fn mkdir_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let recursive = unsafe { crate::abi::arg_bool(args, n, 1) };
    let result = if recursive {
        fs::create_dir_all(path)
    } else {
        fs::create_dir(path)
    };
    match result {
        Ok(()) => ok(),
        Err(err) => fs_fail(&err, "mkdir", path),
    }
}

/// `fs.rmdirSync(path)` — remove an empty directory.
pub unsafe extern "C" fn rmdir_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::remove_dir(path) {
        Ok(()) => ok(),
        Err(err) => fs_fail(&err, "rmdir", path),
    }
}

/// `fs.unlinkSync(path)` — remove a file.
pub unsafe extern "C" fn unlink_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::remove_file(path) {
        Ok(()) => ok(),
        Err(err) => fs_fail(&err, "unlink", path),
    }
}

/// `fs.rmSync(path, { recursive, force })`: args `[path, recursive, force]`.
pub unsafe extern "C" fn rm_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let recursive = unsafe { crate::abi::arg_bool(args, n, 1) };
    let force = unsafe { crate::abi::arg_bool(args, n, 2) };
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if force && err.kind() == io::ErrorKind::NotFound => return ok(),
        Err(err) => return fs_fail(&err, "stat", path),
    };
    let result = if metadata.is_dir() {
        if recursive {
            fs::remove_dir_all(path)
        } else {
            fs::remove_dir(path)
        }
    } else {
        fs::remove_file(path)
    };
    match result {
        Ok(()) => ok(),
        Err(err) if force && err.kind() == io::ErrorKind::NotFound => ok(),
        Err(err) => fs_fail(&err, "unlink", path),
    }
}

/// `fs.renameSync(from, to)`.
pub unsafe extern "C" fn rename_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
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
pub unsafe extern "C" fn copy_file_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
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

/// `fs.readdirSync(path)` — directory entry names joined with `/` for the
/// wrapper to split. `/` can never appear in a single path component on any
/// supported platform, and (unlike NUL) it survives the NUL-terminated `Str`
/// carrier, so the join is lossless.
pub unsafe extern "C" fn readdir_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(err) => return fs_fail(&err, "scandir", path),
    };
    let mut names = Vec::new();
    for entry in entries {
        match entry {
            Ok(entry) => names.push(entry.file_name().to_string_lossy().into_owned()),
            Err(err) => return fs_fail(&err, "scandir", path),
        }
    }
    unsafe { ret_str(out, &names.join("/")) }
}

/// The entry kind of `path`'s metadata, mapped to a short tag.
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

/// `fs.statSync(path).<kind>` — follows symlinks.
pub unsafe extern "C" fn stat_kind(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
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
pub unsafe extern "C" fn lstat_kind(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
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
pub unsafe extern "C" fn stat_size(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::metadata(path) {
        Ok(metadata) => unsafe { ret_i64(out, metadata.len() as i64) },
        Err(err) => fs_fail(&err, "stat", path),
    }
}

/// `fs.statSync(path).mtimeMs` — last-modified time in milliseconds since the
/// Unix epoch, `0.0` if the platform cannot report it.
pub unsafe extern "C" fn stat_mtime_ms(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::metadata(path) {
        Ok(metadata) => {
            let millis = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            unsafe { ret_f64(out, millis) }
        }
        Err(err) => fs_fail(&err, "stat", path),
    }
}

/// `fs.realpathSync(path)` — the canonical absolute path.
pub unsafe extern "C" fn realpath_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    match fs::canonicalize(path) {
        Ok(resolved) => unsafe { ret_str(out, &resolved.to_string_lossy()) },
        Err(err) => fs_fail(&err, "realpath", path),
    }
}

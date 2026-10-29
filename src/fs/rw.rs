//! `node:fs` read/write and existence/access: existsSync, accessSync,
//! readFileSync (utf8), writeFileSync, appendFileSync, truncateSync.

use std::fs;
use std::path::Path;

use zun_abi::ZunValue;

use super::fs_fail;
use crate::abi::{arg_i64, arg_str, ok, ret_bool, ret_str};

/// `fs.existsSync(path)` — never fails; `false` for any error (matching Node).
pub(crate) unsafe extern "C" fn exists_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    unsafe { ret_bool(out, Path::new(path).exists()) }
}

/// `fs.accessSync(path, mode)` — visibility/permission check. `mode` follows
/// Node's constants (`F_OK=0`, `X_OK=1`, `W_OK=2`, `R_OK=4`). This slice checks
/// existence (`F_OK`) and, on a writable check, that the target is not
/// read-only; finer POSIX permission bits are a follow-up.
pub(crate) unsafe extern "C" fn access_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let mode = unsafe { arg_i64(args, n, 1) };
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(err) => return fs_fail(&err, "access", path),
    };
    // W_OK (2) against a read-only target fails with EACCES, as in Node.
    if mode & 2 != 0 && metadata.permissions().readonly() {
        return crate::abi::fail(
            "EACCES",
            &format!("EACCES: permission denied, access '{path}'"),
        );
    }
    ok()
}

/// `fs.readFileSync(path, "utf8")`.
pub(crate) unsafe extern "C" fn read_file_utf8(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
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
pub(crate) unsafe extern "C" fn write_file_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
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
pub(crate) unsafe extern "C" fn append_file_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
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

/// `fs.truncateSync(path, len)` — grow/shrink a file to `len` bytes.
pub(crate) unsafe extern "C" fn truncate_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let len = unsafe { arg_i64(args, n, 1) }.max(0) as u64;
    let file = match fs::OpenOptions::new().write(true).open(path) {
        Ok(file) => file,
        Err(err) => return fs_fail(&err, "open", path),
    };
    match file.set_len(len) {
        Ok(()) => ok(),
        Err(err) => fs_fail(&err, "ftruncate", path),
    }
}

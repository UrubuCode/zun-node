//! `node:fs` directory operations: mkdirSync, rmdirSync, unlinkSync, rmSync,
//! readdirSync, mkdtempSync.

use std::fs;
use std::io;

use zun_abi::ZunValue;

use super::fs_fail;
use crate::abi::{arg_bool, arg_str, ok, ret_str};

/// `fs.mkdirSync(path, { recursive })` — the boolean carries `recursive`.
pub(crate) unsafe extern "C" fn mkdir_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let recursive = unsafe { arg_bool(args, n, 1) };
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
pub(crate) unsafe extern "C" fn rmdir_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
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
pub(crate) unsafe extern "C" fn unlink_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
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
/// `force` swallows a not-found error, as in Node.
pub(crate) unsafe extern "C" fn rm_sync(args: *const ZunValue, n: usize, _out: *mut ZunValue) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let recursive = unsafe { arg_bool(args, n, 1) };
    let force = unsafe { arg_bool(args, n, 2) };
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

/// `fs.readdirSync(path)` — directory entry names joined with `/` for the
/// wrapper to split. `/` can never appear in a single path component on any
/// supported platform, and (unlike NUL) it survives the NUL-terminated `Str`
/// carrier, so the join is lossless.
pub(crate) unsafe extern "C" fn readdir_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
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

/// `fs.mkdtempSync(prefix)` — create a uniquely-named directory by appending six
/// characters to `prefix` (as Node does, which appends to the prefix verbatim —
/// no `XXXXXX` template), and return the created path. Retries on collision.
pub(crate) unsafe extern "C" fn mkdtemp_sync(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let prefix = match unsafe { arg_str(args, n, 0) } {
        Ok(prefix) => prefix,
        Err(status) => return status,
    };
    for _ in 0..1000 {
        let candidate = format!("{prefix}{}", random_suffix());
        match fs::create_dir(&candidate) {
            Ok(()) => return unsafe { ret_str(out, &candidate) },
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => return fs_fail(&err, "mkdtemp", prefix),
        }
    }
    crate::abi::fail("EEXIST", &format!("EEXIST: file already exists, mkdtemp '{prefix}'"))
}

/// Six URL-safe characters derived from the clock and a per-thread counter —
/// enough entropy for a temp name, with the create-retry loop covering clashes.
fn random_suffix() -> String {
    use std::cell::Cell;
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    thread_local!(static COUNTER: Cell<u64> = const { Cell::new(0) });
    let counter = COUNTER.with(|c| {
        let next = c.get().wrapping_add(1);
        c.set(next);
        next
    });
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut state = nanos
        ^ counter.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ ((std::process::id() as u64) << 32);
    let mut suffix = String::with_capacity(6);
    for _ in 0..6 {
        // SplitMix64 step for a well-mixed index.
        state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        suffix.push(ALPHABET[(z % 64) as usize] as char);
    }
    suffix
}

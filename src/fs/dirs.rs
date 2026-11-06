//! `node:fs` directory operations: `fsMkdir`, `fsRmdir`, `fsUnlink`, `fsRm`,
//! `fsReaddir`, `fsMkdtemp`.

use std::fs;
use std::io;
use std::path::Path;

use zun_abi::ZunValue;

#[cfg(unix)]
use super::consts::{UV_DIRENT_BLOCK, UV_DIRENT_CHAR, UV_DIRENT_FIFO, UV_DIRENT_SOCKET};
use super::consts::{UV_DIRENT_DIR, UV_DIRENT_FILE, UV_DIRENT_LINK, UV_DIRENT_UNKNOWN};
use super::{fail_code, fail_io, ok, ok_one, ok_records};
use crate::abi::{arg_bool, arg_i64, arg_str, ret_str};

/// `fsMkdir(path, recursive, mode)` → `+` or, for a recursive call, `+<the
/// first directory created>`.
///
/// Node's `mkdirSync(p, { recursive: true })` *returns* the first path it
/// created (or `undefined` if everything already existed), which is why the
/// recursive form reports it: that value is observable, and only the side that
/// walks the chain knows it.
pub(crate) unsafe extern "C" fn fs_mkdir(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let recursive = unsafe { arg_bool(args, n, 1) };
    let mode = unsafe { arg_i64(args, n, 2) };

    let payload = if recursive {
        match create_dir_all(Path::new(path), mode) {
            Ok(first) => ok_one(&first),
            Err(err) => fail_io("mkdir", &err, path),
        }
    } else {
        match create_dir(Path::new(path), mode) {
            Ok(()) => ok(),
            Err(err) => fail_io("mkdir", &err, path),
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// One directory, with the POSIX `mode` applied at creation rather than after,
/// so no window exists in which it is more permissive than asked.
fn create_dir(path: &Path, mode: i64) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(mode as u32).create(path)
    }
    #[cfg(not(unix))]
    {
        let _ = mode;
        fs::create_dir(path)
    }
}

/// `mkdir -p`, reporting the **first** path it had to create, which is the
/// value Node's recursive `mkdirSync` returns.
///
/// Written as its own walk rather than `fs::create_dir_all` for exactly that
/// reason: `create_dir_all` answers `()`, and recovering "the topmost missing
/// ancestor" afterwards would be a second, racy pass.
fn create_dir_all(path: &Path, mode: i64) -> io::Result<String> {
    if path.as_os_str().is_empty() {
        return Err(io::Error::from_raw_os_error(enoent()));
    }
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => return Ok(String::new()),
        // An existing non-directory is `EEXIST`, as `mkdir(2)` reports.
        Ok(_) => return Err(io::Error::new(io::ErrorKind::AlreadyExists, "exists")),
        Err(_) => {}
    }
    let first = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => create_dir_all(parent, mode)?,
        _ => String::new(),
    };
    match create_dir(path, mode) {
        Ok(()) => {}
        // Lost a race with another creator, which `mkdir -p` tolerates.
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists && path.is_dir() => {}
        Err(err) => return Err(err),
    }
    Ok(if first.is_empty() { path.to_string_lossy().into_owned() } else { first })
}

/// `ENOENT`'s number on this platform, for the one error raised without a
/// syscall behind it.
const fn enoent() -> i32 {
    #[cfg(windows)]
    {
        2 // ERROR_FILE_NOT_FOUND
    }
    #[cfg(not(windows))]
    {
        2 // ENOENT
    }
}

/// `fsRmdir(path)` — `uv_fs_rmdir`.
///
/// On Windows libuv's `fs__rmdir` is the CRT's `_wrmdir`, which reports
/// **ENOENT** for a path that exists but is not a directory, where the Win32
/// error (`ERROR_DIRECTORY`) would translate to `ENOTDIR`. Node's own
/// test-fs-rmdir-throws-on-file.js asserts exactly that difference
/// (`common.isWindows ? 'ENOENT' : 'ENOTDIR'`), so it is reproduced here rather
/// than in the generic error table, where it would mistranslate every other
/// `ERROR_DIRECTORY`.
pub(crate) unsafe extern "C" fn fs_rmdir(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let payload = match fs::remove_dir(path) {
        Ok(()) => ok(),
        Err(err) => {
            #[cfg(windows)]
            if fs::symlink_metadata(path).map(|m| !m.is_dir()).unwrap_or(false) {
                let payload = fail_code("rmdir", "ENOENT", path, "");
                return unsafe { ret_str(out, &payload) };
            }
            fail_io("rmdir", &err, path)
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsUnlink(path)` — `uv_fs_unlink`.
pub(crate) unsafe extern "C" fn fs_unlink(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let payload = match remove_file(Path::new(path)) {
        Ok(()) => ok(),
        Err(err) => fail_io("unlink", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `unlink(2)`. A *directory* symlink on Windows has to be removed with
/// `RemoveDirectory`, not `DeleteFile`, so the link's own metadata decides —
/// which is what `uv_fs_unlink` does there too.
fn remove_file(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() && fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false)
        {
            return fs::remove_dir(path);
        }
    }
    fs::remove_file(path)
}

/// `fsRm(path, recursive, force)` — Node's `rmSync`, which is not a libuv call
/// but a JavaScript walk in `lib/internal/fs/rimraf.js`; the walk is here
/// because it is the one piece of `rm` that is pure syscalls.
///
/// `force` swallows a not-found error at every level, and a non-recursive `rm`
/// of a directory is `ERR_FS_EISDIR` territory the TS layer raises — this
/// reports the platform's own `EPERM`/`EISDIR` for it.
pub(crate) unsafe extern "C" fn fs_rm(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let recursive = unsafe { arg_bool(args, n, 1) };
    let force = unsafe { arg_bool(args, n, 2) };

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if force && err.kind() == io::ErrorKind::NotFound => {
            let payload = ok();
            return unsafe { ret_str(out, &payload) };
        }
        Err(err) => {
            let payload = fail_io("lstat", &err, path);
            return unsafe { ret_str(out, &payload) };
        }
    };

    // A symlink is removed as a link, never followed — otherwise
    // `rm(symlinkToDir, { recursive: true })` would delete the target's
    // contents, which is the behavior Node's rimraf is careful to avoid.
    let result = if metadata.file_type().is_symlink() {
        remove_file(Path::new(path))
    } else if metadata.is_dir() {
        if recursive {
            fs::remove_dir_all(path)
        } else {
            // `rmSync` without `recursive` on a directory is an error; libuv's
            // `rmdir` reports `ENOTEMPTY`/`EPERM`, and Node turns a directory
            // into `ERR_FS_EISDIR` itself, so `EISDIR` is the honest code.
            let payload = fail_code("rm", "EISDIR", path, "");
            return unsafe { ret_str(out, &payload) };
        }
    } else {
        remove_file(Path::new(path))
    };

    let payload = match result {
        Ok(()) => ok(),
        Err(err) if force && err.kind() == io::ErrorKind::NotFound => ok(),
        Err(err) => fail_io("unlink", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsReaddir(path)` → one `name US type` record per entry.
///
/// The type is the `UV_DIRENT_*` tag `fs.readdir({ withFileTypes: true })`
/// reports, taken from the directory entry itself (`d_type` on POSIX, the
/// `FILE_ATTRIBUTE_*` of the enumeration on Windows) so that no extra `stat`
/// is needed per entry — which is also why a `Dirent` can be `UNKNOWN` on a
/// filesystem that does not fill `d_type` in.
///
/// A file name *can* contain U+001E or U+001F on POSIX, which would corrupt
/// the frame. It cannot on Windows, and no real toolchain produces one on
/// POSIX; the alternative is a name-length-prefixed encoding, which is the
/// change to make if that ever turns up.
pub(crate) unsafe extern "C" fn fs_readdir(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(err) => {
            let payload = fail_io("scandir", &err, path);
            return unsafe { ret_str(out, &payload) };
        }
    };
    let mut records: Vec<Vec<String>> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                let payload = fail_io("scandir", &err, path);
                return unsafe { ret_str(out, &payload) };
            }
        };
        let tag = entry.file_type().map(dirent_tag).unwrap_or(UV_DIRENT_UNKNOWN);
        records.push(vec![entry.file_name().to_string_lossy().into_owned(), tag.to_string()]);
    }
    let payload = ok_records(&records);
    unsafe { ret_str(out, &payload) }
}

/// A `FileType` as its `UV_DIRENT_*` tag.
fn dirent_tag(file_type: fs::FileType) -> i64 {
    if file_type.is_symlink() {
        return UV_DIRENT_LINK;
    }
    if file_type.is_dir() {
        return UV_DIRENT_DIR;
    }
    if file_type.is_file() {
        return UV_DIRENT_FILE;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        if file_type.is_fifo() {
            return UV_DIRENT_FIFO;
        }
        if file_type.is_socket() {
            return UV_DIRENT_SOCKET;
        }
        if file_type.is_char_device() {
            return UV_DIRENT_CHAR;
        }
        if file_type.is_block_device() {
            return UV_DIRENT_BLOCK;
        }
    }
    UV_DIRENT_UNKNOWN
}

/// `fsMkdtemp(prefix)` → `+<the created path>`.
///
/// `uv_fs_mkdtemp` appends six random characters to the prefix **verbatim** —
/// no `XXXXXX` template, which is the one place Node differs from `mkdtemp(3)`.
pub(crate) unsafe extern "C" fn fs_mkdtemp(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let prefix = match unsafe { arg_str(args, n, 0) } {
        Ok(prefix) => prefix,
        Err(status) => return status,
    };
    for _ in 0..1000 {
        let candidate = format!("{prefix}{}", random_suffix());
        match create_dir(Path::new(&candidate), 0o700) {
            Ok(()) => {
                let payload = ok_one(&candidate);
                return unsafe { ret_str(out, &payload) };
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(err) => {
                let payload = fail_io("mkdtemp", &err, prefix);
                return unsafe { ret_str(out, &payload) };
            }
        }
    }
    let payload = fail_code("mkdtemp", "EEXIST", prefix, "");
    unsafe { ret_str(out, &payload) }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zun-node-dirs-{}-{name}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn recursive_mkdir_reports_the_topmost_directory_it_created() {
        let root = scratch("mkdir");
        let deep = root.join("a").join("b").join("c");
        let first = create_dir_all(&deep, 0o777).unwrap();
        assert_eq!(first, root.join("a").to_string_lossy());
        assert!(deep.is_dir());

        // Creating it again creates nothing, so there is no first path.
        assert_eq!(create_dir_all(&deep, 0o777).unwrap(), "");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn recursive_mkdir_over_a_file_is_eexist() {
        let root = scratch("mkdir-file");
        let file = root.join("f");
        fs::write(&file, b"x").unwrap();
        let err = create_dir_all(&file.join("deeper"), 0o777).unwrap_err();
        assert!(matches!(
            err.kind(),
            io::ErrorKind::AlreadyExists | io::ErrorKind::NotADirectory | io::ErrorKind::Other
        ));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn dirent_tags_distinguish_files_from_directories() {
        let root = scratch("dirent");
        fs::write(root.join("f"), b"x").unwrap();
        fs::create_dir(root.join("d")).unwrap();
        for entry in fs::read_dir(&root).unwrap() {
            let entry = entry.unwrap();
            let tag = dirent_tag(entry.file_type().unwrap());
            if entry.file_name() == "f" {
                assert_eq!(tag, UV_DIRENT_FILE);
            } else {
                assert_eq!(tag, UV_DIRENT_DIR);
            }
        }
        fs::remove_dir_all(&root).ok();
    }
}

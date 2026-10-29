//! `node:fs` — the Node filesystem module, implemented natively over `std::fs`
//! and exposed through the `zun_abi` extension contract.
//!
//! `fs` is large, so it is split by area across submodules; [`DESCRIPTORS`] is
//! the single registration table `lib.rs` publishes. Scope so far: the
//! synchronous, UTF-8/text surface. Deferred until the ABI can carry a managed
//! byte buffer and a file-descriptor handle: byte-exact reads, `open`/`read`/
//! `write`/`close`, and the callback/promise/stream surfaces.
//!
//! The acceptance bar is **Node.js 25's own `test-fs-*` suite**, not just the
//! crate tests here (see `../../test/fs/`).

use std::io;

use crate::Descriptor;
use zun_abi::ZunTy::{Bool, F64, I64, Str, Void};

mod dirs;
mod links;
mod meta;
mod rw;

/// Map a `std::io::Error` to Node's `(code, description)` pair. Errno first
/// (stable for the POSIX set), then `ErrorKind` for unnumbered errors.
pub(super) fn error_code(err: &io::Error) -> (&'static str, &'static str) {
    if let Some(errno) = err.raw_os_error() {
        match errno {
            1 => return ("EPERM", "operation not permitted"),
            2 => return ("ENOENT", "no such file or directory"),
            9 => return ("EBADF", "bad file descriptor"),
            13 => return ("EACCES", "permission denied"),
            17 => return ("EEXIST", "file already exists"),
            20 => return ("ENOTDIR", "not a directory"),
            21 => return ("EISDIR", "illegal operation on a directory"),
            22 => return ("EINVAL", "invalid argument"),
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

/// Report a failed `syscall` on `path` as a Node-style error status.
pub(super) fn fs_fail(err: &io::Error, syscall: &str, path: &str) -> i32 {
    let (code, description) = error_code(err);
    crate::abi::fail(code, &format!("{code}: {description}, {syscall} '{path}'"))
}

/// Report the two-path variant (`rename`, `copyfile`, `link`, `symlink`).
pub(super) fn fs_fail2(err: &io::Error, syscall: &str, a: &str, b: &str) -> i32 {
    let (code, description) = error_code(err);
    crate::abi::fail(code, &format!("{code}: {description}, {syscall} '{a}' -> '{b}'"))
}

/// The `node:fs` functions published to the host. Grouped by submodule; each key
/// is the module-local name the host dispatches (`fs.<key>`).
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    // read/write + existence (rw.rs)
    Descriptor { key: b"existsSync\0", params: &[Str], ret: Bool, invoke: rw::exists_sync },
    Descriptor { key: b"accessSync\0", params: &[Str, I64], ret: Void, invoke: rw::access_sync },
    Descriptor { key: b"readFileUtf8\0", params: &[Str], ret: Str, invoke: rw::read_file_utf8 },
    Descriptor { key: b"writeFileSync\0", params: &[Str, Str], ret: Void, invoke: rw::write_file_sync },
    Descriptor { key: b"appendFileSync\0", params: &[Str, Str], ret: Void, invoke: rw::append_file_sync },
    Descriptor { key: b"truncateSync\0", params: &[Str, I64], ret: Void, invoke: rw::truncate_sync },
    // directories (dirs.rs)
    Descriptor { key: b"mkdirSync\0", params: &[Str, Bool], ret: Void, invoke: dirs::mkdir_sync },
    Descriptor { key: b"rmdirSync\0", params: &[Str], ret: Void, invoke: dirs::rmdir_sync },
    Descriptor { key: b"unlinkSync\0", params: &[Str], ret: Void, invoke: dirs::unlink_sync },
    Descriptor { key: b"rmSync\0", params: &[Str, Bool, Bool], ret: Void, invoke: dirs::rm_sync },
    Descriptor { key: b"readdirSync\0", params: &[Str], ret: Str, invoke: dirs::readdir_sync },
    Descriptor { key: b"mkdtempSync\0", params: &[Str], ret: Str, invoke: dirs::mkdtemp_sync },
    // metadata (meta.rs)
    Descriptor { key: b"statKind\0", params: &[Str], ret: Str, invoke: meta::stat_kind },
    Descriptor { key: b"lstatKind\0", params: &[Str], ret: Str, invoke: meta::lstat_kind },
    Descriptor { key: b"statSize\0", params: &[Str], ret: I64, invoke: meta::stat_size },
    Descriptor { key: b"statMtimeMs\0", params: &[Str], ret: F64, invoke: meta::stat_mtime_ms },
    Descriptor { key: b"statAtimeMs\0", params: &[Str], ret: F64, invoke: meta::stat_atime_ms },
    Descriptor { key: b"statBirthtimeMs\0", params: &[Str], ret: F64, invoke: meta::stat_birthtime_ms },
    Descriptor { key: b"realpathSync\0", params: &[Str], ret: Str, invoke: meta::realpath_sync },
    // links + move/copy (links.rs)
    Descriptor { key: b"renameSync\0", params: &[Str, Str], ret: Void, invoke: links::rename_sync },
    Descriptor { key: b"copyFileSync\0", params: &[Str, Str], ret: Void, invoke: links::copy_file_sync },
    Descriptor { key: b"linkSync\0", params: &[Str, Str], ret: Void, invoke: links::link_sync },
    Descriptor { key: b"symlinkSync\0", params: &[Str, Str], ret: Void, invoke: links::symlink_sync },
    Descriptor { key: b"readlinkSync\0", params: &[Str], ret: Str, invoke: links::readlink_sync },
    // error retrieval (the ABI v1 (code, message) convention, see lib.rs)
    Descriptor { key: b"lastErrorCode\0", params: &[], ret: Str, invoke: crate::last_error_code },
    Descriptor { key: b"lastErrorMessage\0", params: &[], ret: Str, invoke: crate::last_error_message },
];

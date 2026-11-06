//! `node:fs` — the operating-system half of Node's filesystem module, as a
//! native `zun_abi` extension.
//!
//! # TS over natives
//!
//! `fs` is a *TS-over-natives* module, the shape `node:os` established (see
//! `../os/mod.rs`), and the split is the same one PLAN.md principle 2 draws:
//!
//! - *This* crate answers only what needs the kernel: `open`/`read`/`write`/
//!   `close`, `stat`, `readdir`, `mkdir`, `rename`, the links, the permission
//!   and time setters, `statfs`, `mkdtemp`, `realpath`. Every one is a syscall.
//! - `src/fs/fs.ts` is the Node-shaped module: the option objects, the flag
//!   strings, `Stats`/`BigIntStats`/`Dirent`, `fs.constants`, the argument
//!   validation and `ERR_*`/`SystemError` construction, the recursive `cp`,
//!   the callback API and `fs.promises`. None of that is a syscall.
//!
//! The TS layer reaches these functions with `import * as native from
//! "node:fs"`.
//!
//! # What crosses the boundary
//!
//! ABI v1 carries one scalar word per value, so nothing structured can cross as
//! a structure. Every fallible function here returns **one status-prefixed,
//! separator-delimited string** in the grammar documented in `lib.rs` and used
//! by `node:os`:
//!
//! ```text
//! result  := "+" payload | "-"
//! payload := record (RS record)*
//! record  := field (US field)*
//! RS = U+001E     US = U+001F
//! ```
//!
//! A leading `-` means the call failed and the six error slots below describe
//! it; a leading `+` means success, and an empty payload is an empty list (an
//! empty directory) rather than an error.
//!
//! ## Failure is reported in band
//!
//! A `node:fs` native never returns a non-zero ABI status, even though the ABI
//! has one: an exception thrown out of an extension call **escapes an enclosing
//! `try`/`catch`** in the host today
//! (<https://github.com/UrubuCode/zun/issues/33>), and `fs` is the module whose
//! entire error surface is caught — `try { fs.readFileSync(p) } catch` is the
//! first thing any Node program does. Failure therefore travels as the
//! single-character result `"-"`, with the six fields Node's filesystem errors
//! expose (`errno`, `code`, `syscall`, `message`, `path`, `dest`) in the
//! per-thread error slots, read back through `lastErrorCode`,
//! `lastErrorMessage`, `lastErrorSyscall`, `lastErrorErrno`, `lastErrorPath`
//! and `lastErrorDest`.
//!
//! Those six keys are deliberately **not** spelled like `node:os`'s four
//! (`errorCode`, …): the checker rejects a program whenever one *function name*
//! is registered by two modules, even behind namespace imports that already
//! name the module (<https://github.com/UrubuCode/zun/issues/35>). Every key in
//! [`DESCRIPTORS`] is likewise `fs`-prefixed for that reason.
//!
//! ## Bytes
//!
//! The `Str` carrier is a NUL-terminated C string, so raw file bytes cannot
//! ride it: a file containing a NUL byte would be truncated, and arbitrary
//! bytes are not UTF-8. Byte payloads therefore cross as **base64** — the
//! `fsReadFile`/`fsRead` results and the `fsWriteFile`/`fsWrite` data argument —
//! and the TS layer turns them into the engine's prelude `Buffer` with
//! `Buffer.from(text, "base64")` (and back with `buf.toString("base64")`).
//! base64 was chosen over hex because it is 4/3 rather than 2× the byte count,
//! and over a latin1 passthrough because that cannot carry NUL. The engine's
//! `Buffer` implements both codecs natively, so neither side hand-rolls one.
//!
//! Behavior is defined by Node.js 25, whose `fs` is a thin layer over libuv, so
//! each native documents the libuv entry point it stands in for and follows it
//! where the two could differ (the Windows `mode` synthesis in `stat`, the
//! `FILE_ATTRIBUTE_READONLY` reading of `access`/`chmod`, the `UV_DIRENT_*`
//! type tags). The acceptance bar is Node's own `test-fs-*.js` suite — see
//! `../../test/fs/`.

use std::io;

use crate::Descriptor;
use zun_abi::ZunTy::{Bool, F64, I64, Str};

mod base64;
mod consts;
mod dirs;
mod fd;
mod links;
mod meta;
mod rw;
mod sys;

#[cfg(test)]
mod tests;

/// Unit separator: between the fields of one record.
pub(super) const US: char = '\u{1f}';
/// Record separator: between records.
pub(super) const RS: char = '\u{1e}';
/// The in-band failure marker. The caller has already stashed the error.
pub(super) const FAILED: &str = "-";

/// Encode a successful multi-record payload (`"+"` and the records).
pub(super) fn ok_records(records: &[Vec<String>]) -> String {
    let mut out = String::from("+");
    for (index, record) in records.iter().enumerate() {
        if index > 0 {
            out.push(RS);
        }
        for (field_index, field) in record.iter().enumerate() {
            if field_index > 0 {
                out.push(US);
            }
            out.push_str(field);
        }
    }
    out
}

/// Encode a successful single-record payload.
pub(super) fn ok_fields(fields: &[String]) -> String {
    ok_records(std::slice::from_ref(&fields.to_vec()))
}

/// Encode a successful single-field payload. Not split by the TS side, so the
/// payload is returned byte for byte.
pub(super) fn ok_one(field: &str) -> String {
    let mut out = String::from("+");
    out.push_str(field);
    out
}

/// Encode a successful empty payload (a call that only has to succeed).
pub(super) fn ok() -> String {
    String::from("+")
}

/// libuv's `(code, errno, description)` for an error code, as `uv_strerror`
/// words it.
///
/// libuv reports `-errno` where the platform has an errno and a value from its
/// own reserved range where it does not, which is Windows; see
/// `include/uv/errno.h`. Node splices the description into the error message
/// verbatim, which is why it is libuv's wording rather than the platform's.
fn uv_error(code: &str) -> (&'static str, i64, &'static str) {
    match code {
        "E2BIG" => ("E2BIG", uv_errno(7, -4093), "argument list too long"),
        "EACCES" => ("EACCES", uv_errno(13, -4092), "permission denied"),
        "EAGAIN" => ("EAGAIN", uv_errno(11, -4088), "resource temporarily unavailable"),
        "EBADF" => ("EBADF", uv_errno(9, -4083), "bad file descriptor"),
        "EBUSY" => ("EBUSY", uv_errno(16, -4082), "resource busy or locked"),
        "ECANCELED" => ("ECANCELED", uv_errno(125, -4081), "operation canceled"),
        "EEXIST" => ("EEXIST", uv_errno(17, -4075), "file already exists"),
        "EFAULT" => ("EFAULT", uv_errno(14, -4074), "bad address in system call argument"),
        "EFBIG" => ("EFBIG", uv_errno(27, -4036), "file too large"),
        "EILSEQ" => ("EILSEQ", uv_errno(84, -4027), "illegal byte sequence"),
        "EINVAL" => ("EINVAL", uv_errno(22, -4071), "invalid argument"),
        "EIO" => ("EIO", uv_errno(5, -4070), "i/o error"),
        "EISDIR" => ("EISDIR", uv_errno(21, -4068), "illegal operation on a directory"),
        "ELOOP" => ("ELOOP", uv_errno(40, -4067), "too many symbolic links encountered"),
        "EMFILE" => ("EMFILE", uv_errno(24, -4066), "too many open files"),
        "EMLINK" => ("EMLINK", uv_errno(31, -4032), "too many links"),
        "ENAMETOOLONG" => ("ENAMETOOLONG", uv_errno(36, -4064), "name too long"),
        "ENFILE" => ("ENFILE", uv_errno(23, -4061), "file table overflow"),
        "ENOBUFS" => ("ENOBUFS", uv_errno(105, -4060), "no buffer space available"),
        "ENODEV" => ("ENODEV", uv_errno(19, -4059), "no such device"),
        "ENOENT" => ("ENOENT", uv_errno(2, -4058), "no such file or directory"),
        "ENOMEM" => ("ENOMEM", uv_errno(12, -4057), "not enough memory"),
        "ENOSPC" => ("ENOSPC", uv_errno(28, -4055), "no space left on device"),
        "ENOSYS" => ("ENOSYS", uv_errno(38, -4054), "function not implemented"),
        "ENOTDIR" => ("ENOTDIR", uv_errno(20, -4052), "not a directory"),
        "ENOTEMPTY" => ("ENOTEMPTY", uv_errno(39, -4051), "directory not empty"),
        "ENOTSUP" => ("ENOTSUP", uv_errno(95, -4049), "operation not supported on socket"),
        "ENXIO" => ("ENXIO", uv_errno(6, -4033), "no such device or address"),
        "EOVERFLOW" => {
            ("EOVERFLOW", uv_errno(75, -4026), "value too large for defined data type")
        }
        "EPERM" => ("EPERM", uv_errno(1, -4048), "operation not permitted"),
        "EPIPE" => ("EPIPE", uv_errno(32, -4047), "broken pipe"),
        "EROFS" => ("EROFS", uv_errno(30, -4043), "read-only file system"),
        "ESPIPE" => ("ESPIPE", uv_errno(29, -4041), "invalid seek"),
        "ESRCH" => ("ESRCH", uv_errno(3, -4040), "no such process"),
        "ETXTBSY" => ("ETXTBSY", uv_errno(26, -4038), "text file is busy"),
        "EXDEV" => ("EXDEV", uv_errno(18, -4037), "cross-device link not permitted"),
        _ => ("UNKNOWN", -4094, "unknown error"),
    }
}

/// See [`uv_error`]: `-errno` on POSIX, libuv's reserved range on Windows.
#[allow(unused_variables)]
const fn uv_errno(posix: i64, windows: i64) -> i64 {
    #[cfg(windows)]
    {
        windows
    }
    #[cfg(not(windows))]
    {
        -posix
    }
}

/// Stash a failure described by a libuv error code, and return [`FAILED`].
///
/// `path` and `dest` are the two Node reports on a filesystem error; `dest` is
/// empty for the one-path syscalls, which is how the TS layer decides the key
/// is absent from the error object.
pub(super) fn fail_code(syscall: &str, code: &str, path: &str, dest: &str) -> String {
    let (code, errno, description) = uv_error(code);
    crate::abi::fail_fs(syscall, code, errno, description, path, dest);
    FAILED.to_owned()
}

/// Stash a failure described by an [`io::Error`], mapping the platform error to
/// the libuv code Node would report, and return [`FAILED`].
pub(super) fn fail_io(syscall: &str, err: &io::Error, path: &str) -> String {
    fail_code(syscall, sys::uv_code_of(err), path, "")
}

/// The two-path form of [`fail_io`] (`rename`, `copyfile`, `link`, `symlink`).
pub(super) fn fail_io2(syscall: &str, err: &io::Error, path: &str, dest: &str) -> String {
    fail_code(syscall, sys::uv_code_of(err), path, dest)
}

/// The `node:fs` functions published to the host, grouped by submodule. Keys
/// are the names `src/fs/fs.ts` calls through its `node:fs` namespace import,
/// and every one is `fs`-prefixed so no other module in this library can
/// collide with it (<https://github.com/UrubuCode/zun/issues/35>).
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    // the platform's own constant table (consts.rs)
    Descriptor { key: b"fsConstants\0", params: &[], ret: Str, invoke: consts::fs_constants },
    Descriptor { key: b"fsPid\0", params: &[], ret: I64, invoke: consts::fs_pid },
    // read/write whole files, existence and access (rw.rs)
    Descriptor { key: b"fsExists\0", params: &[Str], ret: Bool, invoke: rw::fs_exists },
    Descriptor { key: b"fsAccess\0", params: &[Str, I64], ret: Str, invoke: rw::fs_access },
    Descriptor { key: b"fsReadFile\0", params: &[Str], ret: Str, invoke: rw::fs_read_file },
    Descriptor {
        key: b"fsWriteFile\0",
        params: &[Str, Str, I64, I64],
        ret: Str,
        invoke: rw::fs_write_file,
    },
    Descriptor { key: b"fsTruncate\0", params: &[Str, I64], ret: Str, invoke: rw::fs_truncate },
    Descriptor {
        key: b"fsCopyFile\0",
        params: &[Str, Str, I64],
        ret: Str,
        invoke: rw::fs_copy_file,
    },
    // file descriptors (fd.rs)
    Descriptor { key: b"fsOpen\0", params: &[Str, I64, I64], ret: Str, invoke: fd::fs_open },
    Descriptor { key: b"fsClose\0", params: &[I64], ret: Str, invoke: fd::fs_close },
    Descriptor { key: b"fsRead\0", params: &[I64, I64, I64], ret: Str, invoke: fd::fs_read },
    Descriptor { key: b"fsWrite\0", params: &[I64, Str, I64], ret: Str, invoke: fd::fs_write },
    Descriptor { key: b"fsFstat\0", params: &[I64], ret: Str, invoke: fd::fs_fstat },
    Descriptor { key: b"fsFsync\0", params: &[I64, Bool], ret: Str, invoke: fd::fs_fsync },
    Descriptor { key: b"fsFtruncate\0", params: &[I64, I64], ret: Str, invoke: fd::fs_ftruncate },
    Descriptor { key: b"fsFutimes\0", params: &[I64, F64, F64], ret: Str, invoke: fd::fs_futimes },
    Descriptor { key: b"fsFchmod\0", params: &[I64, I64], ret: Str, invoke: fd::fs_fchmod },
    Descriptor { key: b"fsFchown\0", params: &[I64, I64, I64], ret: Str, invoke: fd::fs_fchown },
    // directories (dirs.rs)
    Descriptor { key: b"fsMkdir\0", params: &[Str, Bool, I64], ret: Str, invoke: dirs::fs_mkdir },
    Descriptor { key: b"fsRmdir\0", params: &[Str], ret: Str, invoke: dirs::fs_rmdir },
    Descriptor { key: b"fsUnlink\0", params: &[Str], ret: Str, invoke: dirs::fs_unlink },
    Descriptor { key: b"fsRm\0", params: &[Str, Bool, Bool], ret: Str, invoke: dirs::fs_rm },
    Descriptor { key: b"fsReaddir\0", params: &[Str], ret: Str, invoke: dirs::fs_readdir },
    Descriptor { key: b"fsMkdtemp\0", params: &[Str], ret: Str, invoke: dirs::fs_mkdtemp },
    // metadata (meta.rs)
    Descriptor { key: b"fsStat\0", params: &[Str, Bool], ret: Str, invoke: meta::fs_stat },
    Descriptor { key: b"fsStatfs\0", params: &[Str], ret: Str, invoke: meta::fs_statfs },
    Descriptor { key: b"fsRealpath\0", params: &[Str], ret: Str, invoke: meta::fs_realpath },
    Descriptor { key: b"fsChmod\0", params: &[Str, I64], ret: Str, invoke: meta::fs_chmod },
    Descriptor {
        key: b"fsChown\0",
        params: &[Str, I64, I64, Bool],
        ret: Str,
        invoke: meta::fs_chown,
    },
    Descriptor {
        key: b"fsUtimes\0",
        params: &[Str, F64, F64, Bool],
        ret: Str,
        invoke: meta::fs_utimes,
    },
    // links + move (links.rs)
    Descriptor { key: b"fsRename\0", params: &[Str, Str], ret: Str, invoke: links::fs_rename },
    Descriptor { key: b"fsLink\0", params: &[Str, Str], ret: Str, invoke: links::fs_link },
    Descriptor {
        key: b"fsSymlink\0",
        params: &[Str, Str, I64],
        ret: Str,
        invoke: links::fs_symlink,
    },
    Descriptor { key: b"fsReadlink\0", params: &[Str], ret: Str, invoke: links::fs_readlink },
    // Error retrieval (the ABI v1 error-slot convention, see lib.rs). The keys
    // are `fs`-local on purpose; see the module documentation and zun#35.
    Descriptor { key: b"lastErrorCode\0", params: &[], ret: Str, invoke: crate::last_error_code },
    Descriptor {
        key: b"lastErrorMessage\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_message,
    },
    Descriptor {
        key: b"lastErrorSyscall\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_syscall,
    },
    Descriptor { key: b"lastErrorErrno\0", params: &[], ret: I64, invoke: crate::last_error_errno },
    Descriptor { key: b"lastErrorPath\0", params: &[], ret: Str, invoke: crate::last_error_path },
    Descriptor { key: b"lastErrorDest\0", params: &[], ret: Str, invoke: crate::last_error_dest },
];

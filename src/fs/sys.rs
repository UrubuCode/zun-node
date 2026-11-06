//! The platform contract behind `node:fs`: the handful of operations `std`
//! cannot express, written twice.
//!
//! Everything above this module is platform-independent; everything here is
//! syscalls. Both implementations answer the same signatures and are written
//! against **libuv's** behavior, because that is what Node's `fs` exposes — so
//! the Windows half synthesizes the POSIX-shaped `st_mode` libuv synthesizes,
//! reads `FILE_ATTRIBUTE_READONLY` where POSIX reads permission bits, and maps
//! its error codes to libuv's names rather than to POSIX errno numbers that do
//! not exist there.

use std::fs::Metadata;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

/// One `uv_stat_t`, which is what Node's `Stats` is built from field for field.
///
/// The four timestamps are `(seconds, nanoseconds)` rather than a float: Node
/// exposes both `atimeMs` (a double) and, under `bigint: true`, `atimeNs` (an
/// exact integer), and only the split pair can produce both without losing the
/// sub-millisecond part on the way.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct RawStat {
    pub(super) dev: u64,
    pub(super) mode: u32,
    pub(super) nlink: u64,
    pub(super) uid: u32,
    pub(super) gid: u32,
    pub(super) rdev: u64,
    pub(super) blksize: i64,
    pub(super) ino: u64,
    pub(super) size: u64,
    pub(super) blocks: i64,
    pub(super) atime: (i64, u32),
    pub(super) mtime: (i64, u32),
    pub(super) ctime: (i64, u32),
    pub(super) birthtime: (i64, u32),
}

/// One `uv_statfs_t`, which is what Node's `StatFs` reports.
#[derive(Debug, Clone, Copy, Default)]
pub(super) struct RawStatFs {
    pub(super) kind: u64,
    pub(super) bsize: u64,
    pub(super) blocks: u64,
    pub(super) bfree: u64,
    pub(super) bavail: u64,
    pub(super) files: u64,
    pub(super) ffree: u64,
}

/// A `SystemTime` as the `(seconds, nanoseconds)` pair [`RawStat`] carries,
/// handling pre-epoch times (which `duration_since` reports as an error).
#[cfg_attr(windows, allow(dead_code))]
fn split(time: io::Result<SystemTime>) -> (i64, u32) {
    let Ok(time) = time else { return (0, 0) };
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => (duration.as_secs() as i64, duration.subsec_nanos()),
        Err(err) => {
            let duration = err.duration();
            if duration.subsec_nanos() == 0 {
                (-(duration.as_secs() as i64), 0)
            } else {
                (-(duration.as_secs() as i64) - 1, 1_000_000_000 - duration.subsec_nanos())
            }
        }
    }
}

/// Epoch milliseconds (as Node's `utimes` receives them) as the `(seconds,
/// nanoseconds)` pair the setters want.
pub(super) fn millis_to_parts(millis: f64) -> (i64, u32) {
    let seconds = millis.div_euclid(1000.0);
    let remainder = millis.rem_euclid(1000.0);
    (seconds as i64, (remainder * 1_000_000.0).round().min(999_999_999.0) as u32)
}

// ---------------------------------------------------------------------------
// POSIX
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod imp {
    use super::*;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;
    use std::os::unix::io::FromRawFd;
    use std::path::Path;

    /// libuv's error *name* for a platform error. On POSIX `UV_E*` is `-errno`,
    /// so the name is the errno's own name and `std`'s `raw_os_error` is enough.
    pub(in crate::fs) fn uv_code_of(err: &io::Error) -> &'static str {
        if let Some(errno) = err.raw_os_error() {
            return match errno {
                libc::E2BIG => "E2BIG",
                libc::EACCES => "EACCES",
                libc::EAGAIN => "EAGAIN",
                libc::EBADF => "EBADF",
                libc::EBUSY => "EBUSY",
                libc::ECANCELED => "ECANCELED",
                libc::EEXIST => "EEXIST",
                libc::EFAULT => "EFAULT",
                libc::EFBIG => "EFBIG",
                libc::EILSEQ => "EILSEQ",
                libc::EINVAL => "EINVAL",
                libc::EIO => "EIO",
                libc::EISDIR => "EISDIR",
                libc::ELOOP => "ELOOP",
                libc::EMFILE => "EMFILE",
                libc::EMLINK => "EMLINK",
                libc::ENAMETOOLONG => "ENAMETOOLONG",
                libc::ENFILE => "ENFILE",
                libc::ENOBUFS => "ENOBUFS",
                libc::ENODEV => "ENODEV",
                libc::ENOENT => "ENOENT",
                libc::ENOMEM => "ENOMEM",
                libc::ENOSPC => "ENOSPC",
                libc::ENOSYS => "ENOSYS",
                libc::ENOTDIR => "ENOTDIR",
                libc::ENOTEMPTY => "ENOTEMPTY",
                libc::ENOTSUP => "ENOTSUP",
                libc::ENXIO => "ENXIO",
                libc::EOVERFLOW => "EOVERFLOW",
                libc::EPERM => "EPERM",
                libc::EPIPE => "EPIPE",
                libc::EROFS => "EROFS",
                libc::ESPIPE => "ESPIPE",
                libc::ESRCH => "ESRCH",
                libc::ETXTBSY => "ETXTBSY",
                libc::EXDEV => "EXDEV",
                _ => "UNKNOWN",
            };
        }
        match err.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::AlreadyExists => "EEXIST",
            io::ErrorKind::InvalidInput => "EINVAL",
            _ => "EIO",
        }
    }

    fn c_path(path: &str) -> io::Result<CString> {
        CString::new(Path::new(path).as_os_str().as_bytes())
            .map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))
    }

    fn check(result: i32) -> io::Result<()> {
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    /// The whole `uv_stat_t` from a `Metadata`. On POSIX every field is already
    /// there through `MetadataExt`, so no second syscall is needed.
    pub(in crate::fs) fn raw_stat_of(metadata: &Metadata, _path: Option<&str>) -> RawStat {
        RawStat {
            dev: metadata.dev(),
            mode: metadata.mode(),
            nlink: metadata.nlink(),
            uid: metadata.uid(),
            gid: metadata.gid(),
            rdev: metadata.rdev(),
            blksize: metadata.blksize() as i64,
            ino: metadata.ino(),
            size: metadata.size(),
            blocks: metadata.blocks() as i64,
            atime: (metadata.atime(), metadata.atime_nsec() as u32),
            mtime: (metadata.mtime(), metadata.mtime_nsec() as u32),
            ctime: (metadata.ctime(), metadata.ctime_nsec() as u32),
            // `st_birthtime` is not in the POSIX `stat`; libuv reports whatever
            // the platform has (`statx` on Linux, `st_birthtim` on the BSDs)
            // and zero otherwise, which is what `created()` answers.
            birthtime: split(metadata.created()),
        }
    }

    /// `uv_fs_open` — `open(2)` with the flags the program actually passed, so
    /// `O_DIRECTORY`, `O_NOFOLLOW` and `O_SYNC` mean what they mean.
    pub(in crate::fs) fn open(path: &str, flags: i64, mode: i64) -> io::Result<std::fs::File> {
        let c_path = c_path(path)?;
        // SAFETY: a NUL-terminated path and plain integers; the returned fd is
        // adopted by a `File`, which closes it.
        let fd = unsafe { libc::open(c_path.as_ptr(), flags as libc::c_int, mode as libc::c_uint) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` is a fresh, owned descriptor.
        Ok(unsafe { std::fs::File::from_raw_fd(fd) })
    }

    /// The descriptor number a `File` is published under. On POSIX it is the
    /// real one, so a child process or a native library sees the same number.
    pub(in crate::fs) fn fd_number(file: &std::fs::File) -> i64 {
        use std::os::unix::io::AsRawFd;
        file.as_raw_fd() as i64
    }

    /// Does this platform hand out real descriptor numbers? (POSIX does;
    /// Windows does not — see the registry in `fd.rs`.)
    pub(in crate::fs) const REAL_FDS: bool = true;

    /// `uv_fs_access` — `access(2)`, which answers for the *real* uid/gid the
    /// way Node's `fs.access` documents.
    pub(in crate::fs) fn access(path: &str, mode: i64) -> io::Result<()> {
        let c_path = c_path(path)?;
        // SAFETY: a NUL-terminated path and an int mode.
        check(unsafe { libc::access(c_path.as_ptr(), mode as libc::c_int) })
    }

    /// `uv_fs_chmod` / `uv_fs_fchmod`.
    pub(in crate::fs) fn chmod(path: &str, mode: i64) -> io::Result<()> {
        let c_path = c_path(path)?;
        // SAFETY: a NUL-terminated path and a mode_t.
        check(unsafe { libc::chmod(c_path.as_ptr(), mode as libc::mode_t) })
    }

    pub(in crate::fs) fn fchmod(fd: i64, mode: i64) -> io::Result<()> {
        // SAFETY: plain integers; an invalid fd is reported as EBADF.
        check(unsafe { libc::fchmod(fd as libc::c_int, mode as libc::mode_t) })
    }

    /// `uv_fs_chown` / `uv_fs_lchown`. `-1` leaves the id unchanged, which is
    /// `chown(2)`'s own convention and the one Node documents.
    pub(in crate::fs) fn chown(path: &str, uid: i64, gid: i64, follow: bool) -> io::Result<()> {
        let c_path = c_path(path)?;
        let uid = uid as libc::uid_t;
        let gid = gid as libc::gid_t;
        // SAFETY: a NUL-terminated path and two ids.
        check(unsafe {
            if follow {
                libc::chown(c_path.as_ptr(), uid, gid)
            } else {
                libc::lchown(c_path.as_ptr(), uid, gid)
            }
        })
    }

    pub(in crate::fs) fn fchown(fd: i64, uid: i64, gid: i64) -> io::Result<()> {
        // SAFETY: plain integers.
        check(unsafe {
            libc::fchown(fd as libc::c_int, uid as libc::uid_t, gid as libc::gid_t)
        })
    }

    fn timespec(parts: (i64, u32)) -> libc::timespec {
        libc::timespec { tv_sec: parts.0 as libc::time_t, tv_nsec: parts.1 as _ }
    }

    /// `uv_fs_utime` / `uv_fs_lutime` — `utimensat(2)`, which carries the
    /// nanosecond part `utimes(2)` would truncate.
    pub(in crate::fs) fn utimes(
        path: &str,
        atime: (i64, u32),
        mtime: (i64, u32),
        follow: bool,
    ) -> io::Result<()> {
        let c_path = c_path(path)?;
        let times = [timespec(atime), timespec(mtime)];
        let flags = if follow { 0 } else { libc::AT_SYMLINK_NOFOLLOW };
        // SAFETY: a NUL-terminated path and a two-element timespec array.
        check(unsafe { libc::utimensat(libc::AT_FDCWD, c_path.as_ptr(), times.as_ptr(), flags) })
    }

    /// POSIX has `fchmod(2)`/`futimens(2)`, so no path is needed. See the
    /// Windows half.
    pub(in crate::fs) const FD_OPS_NEED_PATH: bool = false;

    /// `uv_fs_futime` — `futimens(2)`.
    pub(in crate::fs) fn futimes(
        fd: i64,
        atime: (i64, u32),
        mtime: (i64, u32),
    ) -> io::Result<()> {
        let times = [timespec(atime), timespec(mtime)];
        // SAFETY: a fd and a two-element timespec array.
        check(unsafe { libc::futimens(fd as libc::c_int, times.as_ptr()) })
    }

    /// `uv_fs_statfs` — `statvfs(2)`. `f_type` is not in `statvfs`, so libuv
    /// reports `f_fsid` there, and so do we.
    pub(in crate::fs) fn statfs(path: &str) -> io::Result<RawStatFs> {
        let c_path = c_path(path)?;
        let mut buffer: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: a NUL-terminated path and a writable `statvfs`.
        check(unsafe { libc::statvfs(c_path.as_ptr(), &mut buffer) })?;
        Ok(RawStatFs {
            kind: buffer.f_fsid as u64,
            bsize: buffer.f_bsize as u64,
            blocks: buffer.f_blocks as u64,
            bfree: buffer.f_bfree as u64,
            bavail: buffer.f_bavail as u64,
            files: buffer.f_files as u64,
            ffree: buffer.f_ffree as u64,
        })
    }

    /// `uv_fs_symlink`. The `type` argument is Windows-only; POSIX symlinks do
    /// not distinguish a directory target, and libuv ignores the flags there.
    pub(in crate::fs) fn symlink(target: &str, path: &str, _kind: i64) -> io::Result<()> {
        std::os::unix::fs::symlink(target, path)
    }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod imp {
    use super::*;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::fs::MetadataExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, SetLastError, ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS,
        ERROR_BAD_PATHNAME, ERROR_BUFFER_OVERFLOW, ERROR_DIRECTORY, ERROR_DIR_NOT_EMPTY,
        ERROR_DISK_FULL, ERROR_FILE_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_FILENAME_EXCED_RANGE,
        ERROR_INVALID_FUNCTION, ERROR_INVALID_HANDLE, ERROR_INVALID_NAME,
        ERROR_INVALID_PARAMETER, ERROR_NOT_ENOUGH_MEMORY, ERROR_NOT_SAME_DEVICE,
        ERROR_NOT_SUPPORTED, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND,
        ERROR_PRIVILEGE_NOT_HELD, ERROR_SHARING_VIOLATION, ERROR_TOO_MANY_OPEN_FILES,
        ERROR_WRITE_PROTECT, FILETIME, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, CreateSymbolicLinkW, GetDiskFreeSpaceExW, GetDiskFreeSpaceW,
        GetFileAttributesW, GetFileInformationByHandle, SetFileAttributesW, SetFileTime,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
        FILE_ATTRIBUTE_READONLY, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES,
        INVALID_FILE_ATTRIBUTES, OPEN_EXISTING, SYMBOLIC_LINK_FLAG_DIRECTORY,
    };

    /// libuv's error *name* for a Windows error. libuv has no errno there, so
    /// this is `uv_translate_sys_error`'s table rather than a `-errno` mapping;
    /// it is what makes `err.code` read `ENOENT` on Windows too.
    pub(in crate::fs) fn uv_code_of(err: &io::Error) -> &'static str {
        if let Some(code) = err.raw_os_error() {
            return match code as u32 {
                ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_INVALID_NAME
                | ERROR_BAD_PATHNAME => "ENOENT",
                ERROR_ACCESS_DENIED | ERROR_WRITE_PROTECT => "EACCES",
                // `CreateSymbolicLinkW` without the SeCreateSymbolicLink
                // privilege (no Developer Mode, not elevated), which libuv
                // reports as EPERM.
                ERROR_PRIVILEGE_NOT_HELD => "EPERM",
                ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => "EEXIST",
                ERROR_SHARING_VIOLATION => "EBUSY",
                ERROR_DIR_NOT_EMPTY => "ENOTEMPTY",
                ERROR_DIRECTORY => "ENOTDIR",
                ERROR_DISK_FULL => "ENOSPC",
                ERROR_INVALID_HANDLE => "EBADF",
                ERROR_INVALID_PARAMETER | ERROR_INVALID_FUNCTION => "EINVAL",
                ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY => "ENOMEM",
                ERROR_NOT_SAME_DEVICE => "EXDEV",
                ERROR_NOT_SUPPORTED => "ENOTSUP",
                ERROR_TOO_MANY_OPEN_FILES => "EMFILE",
                ERROR_FILENAME_EXCED_RANGE | ERROR_BUFFER_OVERFLOW => "ENAMETOOLONG",
                _ => "UNKNOWN",
            };
        }
        match err.kind() {
            io::ErrorKind::NotFound => "ENOENT",
            io::ErrorKind::PermissionDenied => "EACCES",
            io::ErrorKind::AlreadyExists => "EEXIST",
            io::ErrorKind::InvalidInput => "EINVAL",
            io::ErrorKind::IsADirectory => "EISDIR",
            _ => "EIO",
        }
    }

    /// A path as the NUL-terminated UTF-16 the wide Win32 entry points want.
    fn wide(path: &str) -> Vec<u16> {
        Path::new(path).as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    fn last_error() -> io::Error {
        // SAFETY: no arguments, no state.
        io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
    }

    /// 100-nanosecond FILETIME ticks since 1601 as `(seconds, nanoseconds)`
    /// since 1970. `0` means "not recorded", which libuv reports as 0 too.
    fn filetime_parts(ticks: u64) -> (i64, u32) {
        if ticks == 0 {
            return (0, 0);
        }
        /// 1601-01-01 to 1970-01-01 in 100ns ticks.
        const EPOCH_DELTA: i64 = 116_444_736_000_000_000;
        let since_epoch = ticks as i64 - EPOCH_DELTA;
        let seconds = since_epoch.div_euclid(10_000_000);
        let remainder = since_epoch.rem_euclid(10_000_000);
        (seconds, (remainder * 100) as u32)
    }

    /// `(seconds, nanoseconds)` since 1970 as a `FILETIME`.
    fn parts_to_filetime(parts: (i64, u32)) -> FILETIME {
        const EPOCH_DELTA: i64 = 116_444_736_000_000_000;
        let ticks = parts.0 * 10_000_000 + i64::from(parts.1 / 100) + EPOCH_DELTA;
        let ticks = ticks.max(0) as u64;
        FILETIME {
            dwLowDateTime: (ticks & 0xffff_ffff) as u32,
            dwHighDateTime: (ticks >> 32) as u32,
        }
    }

    /// Open a handle for metadata only (no read/write access), which is what
    /// `GetFileInformationByHandle` and `SetFileTime` need.
    ///
    /// `FILE_FLAG_BACKUP_SEMANTICS` is what makes a *directory* openable at
    /// all, and `FILE_FLAG_OPEN_REPARSE_POINT` is the difference between
    /// `stat` and `lstat`.
    fn metadata_handle(
        path: &str,
        access: u32,
        follow: bool,
    ) -> io::Result<windows_sys::Win32::Foundation::HANDLE> {
        let wide = wide(path);
        let mut flags = FILE_FLAG_BACKUP_SEMANTICS;
        if !follow {
            flags |= FILE_FLAG_OPEN_REPARSE_POINT;
        }
        // SAFETY: a NUL-terminated wide path and plain flags; the handle is
        // closed by the caller.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                flags,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(last_error());
        }
        Ok(handle)
    }

    /// `dev`, `ino` and `nlink`, which no stable `std` API exposes on Windows.
    ///
    /// A failure here is not a failure of `stat`: libuv falls back to zeros for
    /// a file it cannot open a second handle to, and reporting ENOENT for a
    /// path that demonstrably exists would be worse than a zero `ino`.
    fn by_handle(path: &str, follow: bool) -> Option<(u64, u64, u64)> {
        let handle = metadata_handle(path, 0, follow).ok()?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: a live handle and a writable info block.
        let ok = unsafe { GetFileInformationByHandle(handle, &mut info) } != 0;
        // SAFETY: the handle came from `CreateFileW` and is not used again.
        unsafe { CloseHandle(handle) };
        if !ok {
            return None;
        }
        let ino = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
        Some((u64::from(info.dwVolumeSerialNumber), ino, u64::from(info.nNumberOfLinks)))
    }

    /// The whole `uv_stat_t` from a `Metadata`, with libuv's Windows mode
    /// synthesis: there are no POSIX permission bits, so `st_mode` is the entry
    /// kind plus `0o666` (`0o444` when the read-only attribute is set),
    /// repeated across user/group/other — exactly what `fs__stat_assign` does.
    pub(in crate::fs) fn raw_stat_of(metadata: &Metadata, path: Option<&str>) -> RawStat {
        let attributes = metadata.file_attributes();
        let readonly = attributes & FILE_ATTRIBUTE_READONLY != 0;
        let permissions: u32 = if readonly { 0o444 } else { 0o666 };
        let kind: u32 = if metadata.file_type().is_symlink() {
            0xA000
        } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
            0x4000
        } else {
            0x8000
        };
        // libuv reports a fixed 4 KiB block size on Windows and derives
        // `st_blocks` from it in 512-byte units.
        let blksize: i64 = 4096;
        let size = metadata.file_size();
        let blocks = ((size as i64 + blksize - 1) / blksize) * (blksize / 512);
        let (dev, ino, nlink) = path
            .and_then(|path| by_handle(path, !metadata.file_type().is_symlink()))
            .unwrap_or((0, 0, 1));
        RawStat {
            dev,
            mode: kind | permissions,
            nlink,
            // No passwd database: libuv reports 0/0 on Windows.
            uid: 0,
            gid: 0,
            rdev: 0,
            blksize,
            ino,
            size,
            blocks,
            atime: filetime_parts(metadata.last_access_time()),
            mtime: filetime_parts(metadata.last_write_time()),
            // Windows has a change time, but not through this API; libuv falls
            // back to the write time, and `ctime === mtime` is what Node
            // reports there.
            ctime: filetime_parts(metadata.last_write_time()),
            birthtime: filetime_parts(metadata.creation_time()),
        }
    }

    /// `uv_fs_open`. Windows has no `open(2)`, so the CRT's `_O_*` bits are
    /// decoded into the `OpenOptions` that produce the same handle — which is
    /// also what libuv does there, in `fs__open`.
    pub(in crate::fs) fn open(path: &str, flags: i64, mode: i64) -> io::Result<std::fs::File> {
        let decoded = super::super::consts::OpenFlags::decode(flags);
        let mut options = std::fs::OpenOptions::new();
        options.read(decoded.read);
        if decoded.append {
            options.append(true);
        } else if decoded.write {
            options.write(true);
        }
        if decoded.create && decoded.exclusive {
            options.create_new(true);
        } else if decoded.create {
            options.create(true);
        }
        if decoded.truncate {
            options.truncate(true);
        }
        // A read-only open of a directory is how `opendir` and `fs.open` on a
        // directory work; `OpenOptions` needs the backup-semantics flag for it.
        if !decoded.write && !decoded.create {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
        }
        let file = options.open(path)?;
        // `mode` on a *created* file: Windows has no permission bits, so libuv's
        // `fs__open` turns an absent owner-write bit into
        // `FILE_ATTRIBUTE_READONLY` (it passes `_S_IWRITE` through to
        // `CreateFileW`'s attributes). Without this, `open(path, "w", 0o444)`
        // leaves a writable file and `statSync(path).mode` reports 0o666 where
        // Node reports 0o444 — which is what Node's own
        // test-fs-open-mode-mask.js checks.
        if decoded.create && mode & 0o200 == 0 {
            let _ = chmod(path, mode);
        }
        Ok(file)
    }

    /// Windows hands out handles, not small integers, so the descriptor numbers
    /// `node:fs` publishes are allocated by the registry in `fd.rs`.
    pub(in crate::fs) fn fd_number(_file: &std::fs::File) -> i64 {
        0
    }

    pub(in crate::fs) const REAL_FDS: bool = false;

    /// `uv_fs_access`. There is no `access(2)`: libuv reads the attributes and
    /// fails a write check only for a read-only *file* (the attribute is
    /// meaningless on a directory), and never fails an execute check.
    pub(in crate::fs) fn access(path: &str, mode: i64) -> io::Result<()> {
        let wide = wide(path);
        // SAFETY: a NUL-terminated wide path.
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            return Err(last_error());
        }
        if mode & 2 != 0
            && attributes & FILE_ATTRIBUTE_READONLY != 0
            && attributes & FILE_ATTRIBUTE_DIRECTORY == 0
        {
            return Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32));
        }
        Ok(())
    }

    /// `uv_fs_chmod`. The only bit Windows has is read-only, which libuv drives
    /// from the owner write bit — so `chmod(0o444)` makes a file read-only and
    /// `chmod(0o666)` clears it, and nothing else is observable.
    pub(in crate::fs) fn chmod(path: &str, mode: i64) -> io::Result<()> {
        let wide = wide(path);
        // SAFETY: a NUL-terminated wide path.
        let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
        if attributes == INVALID_FILE_ATTRIBUTES {
            return Err(last_error());
        }
        let updated = if mode & 0o200 != 0 {
            attributes & !FILE_ATTRIBUTE_READONLY
        } else {
            attributes | FILE_ATTRIBUTE_READONLY
        };
        let updated = if updated == 0 { FILE_ATTRIBUTE_NORMAL } else { updated };
        // SAFETY: a NUL-terminated wide path and an attribute mask.
        if unsafe { SetFileAttributesW(wide.as_ptr(), updated) } == 0 {
            return Err(last_error());
        }
        Ok(())
    }

    /// `uv_fs_fchmod`. Windows has no `fchmod(2)`: libuv reaches the file
    /// through `NtSetInformationFile` on the handle, which is beyond what this
    /// slice binds — but the descriptor table knows the path the descriptor was
    /// opened from (see `fd.rs`), and `SetFileAttributesW` on that path is the
    /// same operation, since the only bit Windows has is read-only.
    pub(in crate::fs) fn fchmod(_fd: i64, _mode: i64) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(ERROR_INVALID_FUNCTION as i32))
    }

    /// Does this platform need the descriptor's *path* to answer `fchmod` and
    /// `futimes`? (Windows does; POSIX has the real calls.)
    pub(in crate::fs) const FD_OPS_NEED_PATH: bool = true;

    /// `uv_fs_chown` / `uv_fs_lchown` / `uv_fs_fchown` are no-ops that succeed
    /// on Windows, which is exactly what libuv does: there is no uid/gid to
    /// set, and Node's own tests expect the call to succeed.
    pub(in crate::fs) fn chown(_path: &str, _uid: i64, _gid: i64, _follow: bool) -> io::Result<()> {
        Ok(())
    }

    pub(in crate::fs) fn fchown(_fd: i64, _uid: i64, _gid: i64) -> io::Result<()> {
        Ok(())
    }

    /// `uv_fs_utime` / `uv_fs_lutime` — `SetFileTime` on a handle opened for
    /// `FILE_WRITE_ATTRIBUTES`.
    pub(in crate::fs) fn utimes(
        path: &str,
        atime: (i64, u32),
        mtime: (i64, u32),
        follow: bool,
    ) -> io::Result<()> {
        let handle = metadata_handle(path, FILE_WRITE_ATTRIBUTES, follow)?;
        let accessed = parts_to_filetime(atime);
        let written = parts_to_filetime(mtime);
        // SAFETY: a live handle and two FILETIMEs.
        let ok = unsafe {
            SetFileTime(handle, std::ptr::null(), &accessed, &written)
        } != 0;
        let error = last_error();
        // SAFETY: the handle came from `CreateFileW` and is not used again.
        unsafe { CloseHandle(handle) };
        if ok {
            Ok(())
        } else {
            Err(error)
        }
    }

    pub(in crate::fs) fn futimes(
        _fd: i64,
        _atime: (i64, u32),
        _mtime: (i64, u32),
    ) -> io::Result<()> {
        Err(io::Error::from_raw_os_error(ERROR_INVALID_FUNCTION as i32))
    }

    /// `uv_fs_statfs`. `f_type` has no Windows equivalent and libuv reports 0;
    /// `f_files`/`f_ffree` likewise (NTFS has no inode table to count).
    pub(in crate::fs) fn statfs(path: &str) -> io::Result<RawStatFs> {
        let wide = wide(path);
        let mut free_to_caller = 0u64;
        let mut total = 0u64;
        let mut free = 0u64;
        // SAFETY: a NUL-terminated wide path and three writable u64s.
        let ok = unsafe {
            GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_to_caller, &mut total, &mut free)
        } != 0;
        if !ok {
            return Err(last_error());
        }
        let mut sectors_per_cluster = 0u32;
        let mut bytes_per_sector = 0u32;
        let mut free_clusters = 0u32;
        let mut total_clusters = 0u32;
        // SAFETY: as above; a failure leaves the outputs untouched, which the
        // 4 KiB fallback below covers.
        unsafe { SetLastError(0) };
        let detailed = unsafe {
            GetDiskFreeSpaceW(
                wide.as_ptr(),
                &mut sectors_per_cluster,
                &mut bytes_per_sector,
                &mut free_clusters,
                &mut total_clusters,
            )
        } != 0;
        let bsize = if detailed && sectors_per_cluster != 0 && bytes_per_sector != 0 {
            u64::from(sectors_per_cluster) * u64::from(bytes_per_sector)
        } else {
            4096
        };
        Ok(RawStatFs {
            kind: 0,
            bsize,
            blocks: total / bsize,
            bfree: free / bsize,
            bavail: free_to_caller / bsize,
            files: 0,
            ffree: 0,
        })
    }

    /// `uv_fs_symlink`. Windows distinguishes file and directory symlinks, and
    /// the caller has already resolved Node's `type` into the
    /// `UV_FS_SYMLINK_DIR` bit.
    pub(in crate::fs) fn symlink(target: &str, path: &str, kind: i64) -> io::Result<()> {
        let wide_target = wide(target);
        let wide_path = wide(path);
        let flags = if kind & super::super::consts::UV_FS_SYMLINK_DIR != 0 {
            SYMBOLIC_LINK_FLAG_DIRECTORY
        } else {
            0
        };
        // SAFETY: two NUL-terminated wide paths and a flag word.
        if !unsafe { CreateSymbolicLinkW(wide_path.as_ptr(), wide_target.as_ptr(), flags) } {
            return Err(last_error());
        }
        Ok(())
    }

}

pub(super) use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn millis_split_into_seconds_and_nanoseconds() {
        assert_eq!(millis_to_parts(1500.0), (1, 500_000_000));
        assert_eq!(millis_to_parts(0.0), (0, 0));
        // A negative time (Node accepts one) borrows a second, as `utimensat`
        // requires a non-negative nanosecond part.
        assert_eq!(millis_to_parts(-1500.0), (-2, 500_000_000));
    }

    #[test]
    fn a_missing_file_maps_to_enoent() {
        let err = std::fs::metadata("./definitely-not-here-zun-node").unwrap_err();
        assert_eq!(uv_code_of(&err), "ENOENT");
    }

    #[test]
    fn stat_of_a_real_file_reports_its_size_and_kind() {
        let dir = std::env::temp_dir().join(format!("zun-node-sys-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.txt");
        std::fs::write(&file, b"hello").unwrap();
        let metadata = std::fs::metadata(&file).unwrap();
        let raw = raw_stat_of(&metadata, file.to_str());
        assert_eq!(raw.size, 5);
        // S_IFREG, on both platforms.
        assert_eq!(raw.mode & 0xF000, 0x8000);
        assert!(raw.nlink >= 1);
        assert!(raw.mtime.0 > 0);
        std::fs::remove_dir_all(&dir).ok();
    }
}

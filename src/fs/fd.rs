//! `node:fs` file descriptors: open, close, read, write, fstat, fsync,
//! ftruncate, futimes, fchmod, fchown.
//!
//! # The descriptor table
//!
//! Node's `fd` is a small integer the program holds on to across calls, so this
//! extension needs somewhere to keep the open file between two ABI invocations.
//! That is [`TABLE`], a process-wide map from the published number to the open
//! `File`, and the two platforms populate it differently for one honest reason:
//!
//! - On POSIX the published number **is** the real descriptor (`open(2)`
//!   returned it), so a program that hands the number to a child process, to
//!   `/dev/fd`, or to another library is handing out something real.
//! - Windows has no such number — the kernel object is a `HANDLE`, and the
//!   small integers are an invention of whichever C runtime allocated them. The
//!   numbers published there are therefore the table's own, counting up from 3
//!   (which is also where the CRT starts, 0/1/2 being the standard streams).
//!
//! fds 0, 1 and 2 are never in the table: they are the standard streams, and a
//! read or write naming them goes straight to `std::io::stdin`/`stdout`/
//! `stderr`, which is how `fs.writeSync(1, …)` works in Node.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use zun_abi::ZunValue;

use super::sys;
use super::{base64, fail_code, fail_io, meta, ok, ok_one};
use crate::abi::{arg_bool, arg_f64, arg_i64, arg_str, ret_str};

/// One open descriptor: the file, and the path it was opened from.
///
/// The path is kept because Windows has no `fchmod`/`futime` — libuv reaches
/// the file through `NtSetInformationFile` on the handle, and this slice
/// reaches it through the path instead, which is the same operation for the one
/// attribute Windows has. POSIX never reads it.
struct Open {
    file: File,
    path: String,
}

/// The open descriptors of this process, keyed by the number published to the
/// program. See the module documentation for why the key is the real fd on
/// POSIX and a counter on Windows.
static TABLE: Mutex<Option<HashMap<i64, Open>>> = Mutex::new(None);

/// The next number to publish on a platform without real descriptor numbers.
/// Starts at 3 because 0/1/2 are the standard streams.
static NEXT_FD: AtomicI64 = AtomicI64::new(3);

/// Run `action` with the descriptor table, creating it on first use.
fn with_table<R>(action: impl FnOnce(&mut HashMap<i64, Open>) -> R) -> R {
    let mut guard = TABLE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    action(guard.get_or_insert_with(HashMap::new))
}

/// Publish `file` (opened from `path`) and return its number.
fn insert(file: File, path: &str) -> i64 {
    let fd = if sys::REAL_FDS {
        sys::fd_number(&file)
    } else {
        NEXT_FD.fetch_add(1, Ordering::Relaxed)
    };
    with_table(|table| table.insert(fd, Open { file, path: path.to_owned() }));
    fd
}

/// The path descriptor `fd` was opened from, for the platforms whose `fchmod`
/// and `futimes` need one.
fn path_of(fd: i64) -> Option<String> {
    with_table(|table| table.get(&fd).map(|open| open.path.clone()))
}

/// Is this one of the three standard streams?
fn is_standard(fd: i64) -> bool {
    (0..=2).contains(&fd)
}

/// Run `action` on the open file `fd` names, or report `EBADF` the way libuv
/// does for a descriptor the program never got from `open`.
fn with_fd<R>(
    fd: i64,
    syscall: &str,
    action: impl FnOnce(&mut File) -> io::Result<R>,
) -> Result<R, String> {
    let result = with_table(|table| match table.get_mut(&fd) {
        Some(open) => Some(action(&mut open.file)),
        None => None,
    });
    match result {
        Some(Ok(value)) => Ok(value),
        Some(Err(err)) => Err(fail_io(syscall, &err, "")),
        None => Err(fail_code(syscall, "EBADF", "", "")),
    }
}

/// `fsOpen(path, flags, mode)` → `+fd`. `uv_fs_open`.
pub(crate) unsafe extern "C" fn fs_open(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = match unsafe { arg_str(args, n, 0) } {
        Ok(path) => path,
        Err(status) => return status,
    };
    let flags = unsafe { arg_i64(args, n, 1) };
    let mode = unsafe { arg_i64(args, n, 2) };
    let payload = match sys::open(path, flags, mode) {
        Ok(file) => ok_one(&insert(file, path).to_string()),
        Err(err) => fail_io("open", &err, path),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsClose(fd)`. `uv_fs_close`. Dropping the `File` is the `close(2)`.
pub(crate) unsafe extern "C" fn fs_close(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let removed = with_table(|table| table.remove(&fd));
    let payload = match removed {
        Some(open) => {
            drop(open);
            ok()
        }
        // Closing a standard stream is allowed in Node; it is not this
        // extension's descriptor to close, so it is accepted and ignored.
        None if is_standard(fd) => ok(),
        None => fail_code("close", "EBADF", "", ""),
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsRead(fd, length, position)` → `+<base64 of the bytes read>`.
///
/// `uv_fs_read`. `position` is `-1` for "read from the current offset", which
/// is how Node spells a null `position`; any other value is a positioned read
/// that leaves the file offset alone, as `pread(2)` does.
pub(crate) unsafe extern "C" fn fs_read(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let length = unsafe { arg_i64(args, n, 1) }.max(0) as usize;
    let position = unsafe { arg_i64(args, n, 2) };

    if is_standard(fd) {
        let mut buffer = vec![0u8; length];
        let read = io::stdin().read(&mut buffer);
        let payload = match read {
            Ok(count) => {
                buffer.truncate(count);
                ok_one(&base64::encode(&buffer))
            }
            Err(err) => fail_io("read", &err, ""),
        };
        return unsafe { ret_str(out, &payload) };
    }

    let payload = match with_fd(fd, "read", |file| {
        let mut buffer = vec![0u8; length];
        let count = if position < 0 {
            file.read(&mut buffer)?
        } else {
            read_at(file, &mut buffer, position as u64)?
        };
        buffer.truncate(count);
        Ok(buffer)
    }) {
        Ok(bytes) => ok_one(&base64::encode(&bytes)),
        Err(failure) => failure,
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsWrite(fd, base64, position)` → `+<bytes written>`. `uv_fs_write`.
pub(crate) unsafe extern "C" fn fs_write(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let data = match unsafe { arg_str(args, n, 1) } {
        Ok(data) => data,
        Err(status) => return status,
    };
    let position = unsafe { arg_i64(args, n, 2) };
    let bytes = base64::decode(data);

    if is_standard(fd) {
        let written = if fd == 2 {
            io::stderr().write_all(&bytes).map(|()| bytes.len())
        } else {
            io::stdout().write_all(&bytes).map(|()| bytes.len())
        };
        let payload = match written {
            Ok(count) => ok_one(&count.to_string()),
            Err(err) => fail_io("write", &err, ""),
        };
        return unsafe { ret_str(out, &payload) };
    }

    let payload = match with_fd(fd, "write", |file| {
        if position < 0 {
            file.write(&bytes)
        } else {
            write_at(file, &bytes, position as u64)
        }
    }) {
        Ok(count) => ok_one(&count.to_string()),
        Err(failure) => failure,
    };
    unsafe { ret_str(out, &payload) }
}

/// A positioned read that does not move the file offset.
fn read_at(file: &mut File, buffer: &mut [u8], position: u64) -> io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(buffer, position)
    }
    #[cfg(windows)]
    {
        // `seek_read` *does* move the handle's offset, so it is restored —
        // `uv_fs_read` with a position leaves the offset where it was.
        use std::os::windows::fs::FileExt;
        let saved = file.stream_position()?;
        let count = file.seek_read(buffer, position)?;
        file.seek(SeekFrom::Start(saved))?;
        Ok(count)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let saved = file.stream_position()?;
        file.seek(SeekFrom::Start(position))?;
        let count = file.read(buffer)?;
        file.seek(SeekFrom::Start(saved))?;
        Ok(count)
    }
}

/// A positioned write that does not move the file offset.
fn write_at(file: &mut File, bytes: &[u8], position: u64) -> io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_at(bytes, position)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let saved = file.stream_position()?;
        let count = file.seek_write(bytes, position)?;
        file.seek(SeekFrom::Start(saved))?;
        Ok(count)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let saved = file.stream_position()?;
        file.seek(SeekFrom::Start(position))?;
        let count = file.write(bytes)?;
        file.seek(SeekFrom::Start(saved))?;
        Ok(count)
    }
}

/// `fsFstat(fd)` → the same 18 fields as `fsStat`. `uv_fs_fstat`.
pub(crate) unsafe extern "C" fn fs_fstat(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let path = path_of(fd);
    let payload = match with_fd(fd, "fstat", |file| file.metadata()) {
        // The path the descriptor was opened from is what lets the Windows half
        // report `dev`/`ino`/`nlink`; POSIX reads them straight off the
        // `Metadata` and ignores it.
        Ok(metadata) => meta::encode_stat(&sys::raw_stat_of(&metadata, path.as_deref())),
        Err(failure) => failure,
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsFsync(fd, dataOnly)`. `uv_fs_fsync` / `uv_fs_fdatasync`.
pub(crate) unsafe extern "C" fn fs_fsync(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let data_only = unsafe { arg_bool(args, n, 1) };
    let payload = match with_fd(fd, if data_only { "fdatasync" } else { "fsync" }, |file| {
        if data_only {
            // `sync_data` is `fdatasync` where the platform has it and
            // `FlushFileBuffers` on Windows, which is libuv's own mapping.
            file.sync_data()
        } else {
            file.sync_all()
        }
    }) {
        Ok(()) => ok(),
        Err(failure) => failure,
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsFtruncate(fd, len)`. `uv_fs_ftruncate`.
pub(crate) unsafe extern "C" fn fs_ftruncate(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let len = unsafe { arg_i64(args, n, 1) }.max(0) as u64;
    let payload = match with_fd(fd, "ftruncate", |file| file.set_len(len)) {
        Ok(()) => ok(),
        Err(failure) => failure,
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsFutimes(fd, atimeMs, mtimeMs)`. `uv_fs_futime`.
pub(crate) unsafe extern "C" fn fs_futimes(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let atime = sys::millis_to_parts(unsafe { arg_f64(args, n, 1) });
    let mtime = sys::millis_to_parts(unsafe { arg_f64(args, n, 2) });
    // The platform call takes the descriptor, not the `File`, so the table is
    // only consulted to confirm the fd is one of ours.
    let path = path_of(fd);
    let payload = match path {
        None => fail_code("futime", "EBADF", "", ""),
        Some(path) => {
            let result = if sys::FD_OPS_NEED_PATH {
                sys::utimes(&path, atime, mtime, true)
            } else {
                sys::futimes(fd, atime, mtime)
            };
            match result {
                Ok(()) => ok(),
                Err(err) => fail_io("futime", &err, ""),
            }
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsFchmod(fd, mode)`. `uv_fs_fchmod`.
pub(crate) unsafe extern "C" fn fs_fchmod(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let mode = unsafe { arg_i64(args, n, 1) };
    let path = path_of(fd);
    let payload = match path {
        None => fail_code("fchmod", "EBADF", "", ""),
        Some(path) => {
            let result = if sys::FD_OPS_NEED_PATH {
                sys::chmod(&path, mode)
            } else {
                sys::fchmod(fd, mode)
            };
            match result {
                Ok(()) => ok(),
                Err(err) => fail_io("fchmod", &err, ""),
            }
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `fsFchown(fd, uid, gid)`. `uv_fs_fchown`.
pub(crate) unsafe extern "C" fn fs_fchown(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let fd = unsafe { arg_i64(args, n, 0) };
    let uid = unsafe { arg_i64(args, n, 1) };
    let gid = unsafe { arg_i64(args, n, 2) };
    let known = with_table(|table| table.contains_key(&fd));
    let payload = if !known {
        fail_code("fchown", "EBADF", "", "")
    } else {
        match sys::fchown(fd, uid, gid) {
            Ok(()) => ok(),
            Err(err) => fail_io("fchown", &err, ""),
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// Close every descriptor the table holds. Not reachable from the ABI — it
/// exists so the crate tests can start from a clean table.
#[cfg(test)]
pub(super) fn close_all() {
    with_table(|table| table.clear());
}

/// How many descriptors are open. Test-only, as [`close_all`].
#[cfg(test)]
pub(super) fn open_count() -> usize {
    with_table(|table| table.len())
}


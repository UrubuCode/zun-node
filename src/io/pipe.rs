//! Local stream sockets: Node's "pipes" (`net.connect({ path })`,
//! `server.listen(path)`, `http`'s `socketPath`).
//!
//! # One kernel object on both platforms
//!
//! On POSIX a Node pipe *is* a Unix domain socket, so the path is used as is.
//! On Windows Node opens a named pipe (`\\.\pipe\name`), which is a file
//! handle with overlapped-completion I/O and no readiness model at all — it
//! cannot sit in the loop's `select()` next to the TCP sockets. Windows 10
//! (1803+) has `AF_UNIX` stream sockets in Winsock, though, and those *do*
//! select. So a Windows pipe name is mapped to an `AF_UNIX` socket file in the
//! temporary directory, and everything after `socket()` is the same code path
//! the TCP streams take: the same handle table, the same `ioRead`/`ioWrite`,
//! the same readiness.
//!
//! The mapping is only visible to another process that speaks real named
//! pipes; client and server in this runtime agree on it by construction, which
//! is what the corpus exercises (`common.PIPE` is always served and dialled by
//! the same test).

use std::io;
use std::path::PathBuf;

use super::sys::{self, Raw};

/// `AF_UNIX` is 1 on every platform this library targets.
const AF_UNIX: u16 = 1;

/// The longest `sun_path` every platform accepts (macOS has 104 bytes).
const MAX_PATH: usize = 103;

/// Whether `path` is a Windows named-pipe name.
pub(crate) fn is_named_pipe(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("\\\\.\\pipe\\") || lower.starts_with("\\\\?\\pipe\\")
}

/// The filesystem path the socket actually binds for a Node pipe path.
///
/// A named-pipe name maps to a short, stable file under the temporary
/// directory (an FNV-1a hash keeps it under `sun_path`'s limit whatever the
/// name); anything else is used verbatim.
pub(crate) fn socket_path(path: &str) -> PathBuf {
    if !is_named_pipe(path) {
        return PathBuf::from(path);
    }
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_ascii_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    std::env::temp_dir().join(format!("zun-pipe-{hash:016x}.sock"))
}

/// A `sockaddr_un` for `path`, and its length.
fn sockaddr_un(path: &std::path::Path) -> io::Result<([u8; 128], i32)> {
    let text = path.to_string_lossy();
    let bytes = text.as_bytes();
    if bytes.len() > MAX_PATH || bytes.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "pipe path too long"));
    }
    let mut storage = [0u8; 128];
    if cfg!(any(target_os = "macos", target_os = "ios", target_os = "freebsd")) {
        storage[0] = (2 + bytes.len() + 1) as u8;
        storage[1] = AF_UNIX as u8;
    } else {
        storage[0..2].copy_from_slice(&AF_UNIX.to_ne_bytes());
    }
    storage[2..2 + bytes.len()].copy_from_slice(bytes);
    Ok((storage, (2 + bytes.len() + 1) as i32))
}

#[cfg(unix)]
fn raw_socket() -> io::Result<Raw> {
    // SAFETY: scalar arguments.
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(sys::last());
    }
    // SAFETY: `raw` is a descriptor this function just opened.
    unsafe { libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) };
    sys::set_nonblocking(raw)?;
    Ok(raw)
}

#[cfg(windows)]
fn raw_socket() -> io::Result<Raw> {
    use windows_sys::Win32::Networking::WinSock::{socket, INVALID_SOCKET, SOCK_STREAM};
    sys::startup();
    // SAFETY: scalar arguments.
    let raw = unsafe { socket(i32::from(AF_UNIX), SOCK_STREAM, 0) };
    if raw == INVALID_SOCKET {
        return Err(sys::last());
    }
    sys::set_nonblocking(raw)?;
    Ok(raw)
}

#[cfg(unix)]
fn raw_bind(s: Raw, storage: &[u8; 128], len: i32) -> bool {
    // SAFETY: `storage` holds `len` valid sockaddr bytes.
    unsafe { libc::bind(s, storage.as_ptr().cast(), len as libc::socklen_t) == 0 }
}

#[cfg(windows)]
fn raw_bind(s: Raw, storage: &[u8; 128], len: i32) -> bool {
    // SAFETY: `storage` holds `len` valid sockaddr bytes.
    unsafe { windows_sys::Win32::Networking::WinSock::bind(s, storage.as_ptr().cast(), len) == 0 }
}

#[cfg(unix)]
fn raw_connect(s: Raw, storage: &[u8; 128], len: i32) -> bool {
    // SAFETY: `storage` holds `len` valid sockaddr bytes.
    unsafe { libc::connect(s, storage.as_ptr().cast(), len as libc::socklen_t) == 0 }
}

#[cfg(windows)]
fn raw_connect(s: Raw, storage: &[u8; 128], len: i32) -> bool {
    // SAFETY: `storage` holds `len` valid sockaddr bytes.
    unsafe {
        windows_sys::Win32::Networking::WinSock::connect(s, storage.as_ptr().cast(), len) == 0
    }
}

/// Whether a failed non-blocking `connect` is merely in progress.
fn in_progress(err: &io::Error) -> bool {
    #[cfg(unix)]
    if matches!(err.raw_os_error(), Some(libc::EINPROGRESS) | Some(libc::EALREADY)) {
        return true;
    }
    sys::would_block(err)
}

/// `socket` + `bind` + `listen` on a pipe path.
///
/// A Windows named pipe disappears with its last handle, so a mapped socket
/// file left by a process that died is stale by definition: when binding one
/// reports "in use", a probe connect decides whether anything is serving it,
/// and a dead file is removed and the bind retried. A real POSIX path keeps
/// Node's semantics (`EADDRINUSE` on any existing file).
pub(crate) fn listen(path: &str, backlog: i32) -> io::Result<Raw> {
    let file = socket_path(path);
    let (storage, len) = sockaddr_un(&file)?;
    let raw = raw_socket()?;
    if !raw_bind(raw, &storage, len) {
        let err = sys::last();
        let stale = is_named_pipe(path) && file.exists() && !probe(&storage, len);
        if !stale {
            sys::close(raw);
            return Err(err);
        }
        let _ = std::fs::remove_file(&file);
        if !raw_bind(raw, &storage, len) {
            let err = sys::last();
            sys::close(raw);
            return Err(err);
        }
    }
    if let Err(err) = sys::listen(raw, backlog) {
        sys::close(raw);
        let _ = std::fs::remove_file(&file);
        return Err(err);
    }
    Ok(raw)
}

/// Whether something accepts connections on a socket address (a blocking
/// probe, used only to tell a live mapped pipe from a stale file).
fn probe(storage: &[u8; 128], len: i32) -> bool {
    let Ok(raw) = raw_socket() else { return false };
    let mut up = raw_connect(raw, storage, len);
    if !up && in_progress(&sys::last()) {
        let mut items = [sys::PollItem { raw, interest: sys::WRITE, revents: 0 }];
        if sys::poll(&mut items, 200).is_ok() && items[0].revents & sys::WRITE != 0 {
            up = matches!(sys::take_error(raw), Ok(None));
        }
    }
    sys::close(raw);
    up
}

/// Start a non-blocking connect to a pipe path: `Ok(true)` when it completed
/// inside the call, `Ok(false)` when readiness will report it.
pub(crate) fn connect(path: &str) -> io::Result<(Raw, bool)> {
    let (storage, len) = sockaddr_un(&socket_path(path))?;
    let raw = raw_socket()?;
    if raw_connect(raw, &storage, len) {
        return Ok((raw, true));
    }
    let err = sys::last();
    if in_progress(&err) {
        return Ok((raw, false));
    }
    sys::close(raw);
    Err(err)
}

/// Remove the socket file a listener bound (libuv unlinks it on close).
pub(crate) fn unlink(path: &str) {
    let _ = std::fs::remove_file(socket_path(path));
}

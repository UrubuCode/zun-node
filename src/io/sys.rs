//! The raw, non-blocking socket primitives the handle table is built on, one
//! module per platform behind one API.
//!
//! Nothing here is `node:net`-specific: these are the eleven operations a
//! readiness loop needs (create, bind, listen, accept, connect, recv, send,
//! shutdown, close, name, readiness) plus the socket options Node exposes. The
//! next tracks that need the loop — `dgram`, `child_process` pipes, `http` —
//! add their own primitives beside these rather than reimplementing the table.
//!
//! # Why `select` on Windows rather than `WSAPoll`
//!
//! `WSAPoll` is the obvious counterpart of `poll(2)` and is what a first
//! reading of this design calls for, but it has a documented defect that this
//! loop cannot live with: it never reports a **failed connection attempt**. A
//! socket whose non-blocking `connect` is refused is left out of the result set
//! entirely instead of being flagged `POLLERR`/`POLLHUP`, so a `connect` to a
//! closed port would hang the loop forever instead of raising `ECONNREFUSED`.
//! Microsoft acknowledged the defect and libuv avoids `WSAPoll` for the same
//! reason.
//!
//! `select` reports exactly that case, in `exceptfds`. Its classic limitation —
//! `FD_SETSIZE`, 64 by default — does not apply here, because the Windows
//! `fd_set` is a *counted array* (`u_int fd_count; SOCKET fd_array[]`) and
//! `select` only ever reads `fd_count`. [`FdSet`] below therefore builds that
//! layout in a `Vec` sized to the live handle count, which lifts the ceiling to
//! whatever the process can open.
//!
//! On POSIX `poll(2)` has neither problem and is used directly.

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};

/// The handle is readable (or, for a listener, has a pending connection).
pub(crate) const READ: u8 = 1;
/// The handle is writable (or a pending `connect` has settled).
pub(crate) const WRITE: u8 = 2;
/// The handle has an error or the peer hung up.
pub(crate) const ERR: u8 = 4;

/// One row of a readiness query: what to watch, and what came back.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PollItem {
    pub(crate) raw: Raw,
    pub(crate) interest: u8,
    pub(crate) revents: u8,
}

#[cfg(unix)]
pub(crate) use unix::*;
#[cfg(windows)]
pub(crate) use windows::*;

#[cfg(unix)]
mod unix {
    use super::*;
    use std::mem;

    /// A POSIX socket is a file descriptor.
    pub(crate) type Raw = i32;

    /// The "no socket yet" value for a handle that has been reserved but not
    /// opened — libuv's uninitialized `uv_tcp_t`, which is what
    /// `socket._handle` is between `connect()` and the address lookup
    /// completing.
    pub(crate) const INVALID: Raw = -1;

    /// Winsock needs an explicit initialization; POSIX does not.
    pub(crate) fn startup() {}

    /// libuv's error *name* for a POSIX errno, which is what makes
    /// `err.code` read `ECONNREFUSED` rather than a number.
    pub(crate) fn uv_code_of(err: &io::Error) -> &'static str {
        match err.raw_os_error().unwrap_or(0) {
            libc::EACCES => "EACCES",
            libc::EADDRINUSE => "EADDRINUSE",
            libc::EADDRNOTAVAIL => "EADDRNOTAVAIL",
            libc::EAFNOSUPPORT => "EAFNOSUPPORT",
            libc::EAGAIN => "EAGAIN",
            libc::EALREADY => "EALREADY",
            libc::EBADF => "EBADF",
            libc::ECONNABORTED => "ECONNABORTED",
            libc::ECONNREFUSED => "ECONNREFUSED",
            libc::ECONNRESET => "ECONNRESET",
            libc::EDESTADDRREQ => "EDESTADDRREQ",
            libc::EFAULT => "EFAULT",
            libc::EHOSTUNREACH => "EHOSTUNREACH",
            libc::EINPROGRESS => "EINPROGRESS",
            libc::EINTR => "EINTR",
            libc::EINVAL => "EINVAL",
            libc::EISCONN => "EISCONN",
            libc::EMFILE => "EMFILE",
            libc::EMSGSIZE => "EMSGSIZE",
            libc::ENETDOWN => "ENETDOWN",
            libc::ENETUNREACH => "ENETUNREACH",
            libc::ENOBUFS => "ENOBUFS",
            libc::ENOMEM => "ENOMEM",
            libc::ENOTCONN => "ENOTCONN",
            libc::ENOTSOCK => "ENOTSOCK",
            libc::ENOTSUP => "ENOTSUP",
            libc::EPERM => "EPERM",
            libc::EPIPE => "EPIPE",
            libc::EPROTO => "EPROTO",
            libc::EPROTONOSUPPORT => "EPROTONOSUPPORT",
            libc::ETIMEDOUT => "ETIMEDOUT",
            _ => "UNKNOWN",
        }
    }

    fn last() -> io::Error {
        io::Error::last_os_error()
    }

    fn would_block(err: &io::Error) -> bool {
        matches!(err.raw_os_error(), Some(libc::EAGAIN) | Some(libc::EWOULDBLOCK))
    }

    /// `socket(2)` for a non-blocking stream socket of the given family.
    pub(crate) fn socket(ipv6: bool) -> io::Result<Raw> {
        let domain = if ipv6 { libc::AF_INET6 } else { libc::AF_INET };
        // SAFETY: a plain syscall with scalar arguments.
        let raw = unsafe { libc::socket(domain, libc::SOCK_STREAM, 0) };
        if raw < 0 {
            return Err(last());
        }
        set_nonblocking(raw)?;
        Ok(raw)
    }

    pub(crate) fn set_nonblocking(s: Raw) -> io::Result<()> {
        // SAFETY: `s` is a descriptor this module owns.
        let flags = unsafe { libc::fcntl(s, libc::F_GETFL) };
        if flags < 0 {
            return Err(last());
        }
        // SAFETY: as above.
        if unsafe { libc::fcntl(s, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    fn set_opt_i32(s: Raw, level: i32, name: i32, value: i32) -> io::Result<()> {
        // SAFETY: `value` outlives the call and its size is passed exactly.
        let status = unsafe {
            libc::setsockopt(
                s,
                level,
                name,
                std::ptr::addr_of!(value).cast(),
                mem::size_of::<i32>() as libc::socklen_t,
            )
        };
        if status < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn set_reuse_addr(s: Raw, on: bool) -> io::Result<()> {
        set_opt_i32(s, libc::SOL_SOCKET, libc::SO_REUSEADDR, i32::from(on))
    }

    pub(crate) fn set_ipv6_only(s: Raw, on: bool) -> io::Result<()> {
        set_opt_i32(s, libc::IPPROTO_IPV6, libc::IPV6_V6ONLY, i32::from(on))
    }

    pub(crate) fn set_nodelay(s: Raw, on: bool) -> io::Result<()> {
        set_opt_i32(s, libc::IPPROTO_TCP, libc::TCP_NODELAY, i32::from(on))
    }

    /// `SO_KEEPALIVE`, plus the idle delay libuv sets with it
    /// (`TCP_KEEPIDLE`, spelled `TCP_KEEPALIVE` on the BSDs).
    pub(crate) fn set_keepalive(s: Raw, on: bool, delay_secs: u32) -> io::Result<()> {
        set_opt_i32(s, libc::SOL_SOCKET, libc::SO_KEEPALIVE, i32::from(on))?;
        if on && delay_secs > 0 {
            #[cfg(target_os = "linux")]
            let name = libc::TCP_KEEPIDLE;
            #[cfg(not(target_os = "linux"))]
            let name = libc::TCP_KEEPALIVE;
            // A kernel that refuses the idle knob is not a failure of
            // `setKeepAlive` — libuv ignores it too.
            let _ = set_opt_i32(s, libc::IPPROTO_TCP, name, delay_secs as i32);
        }
        Ok(())
    }

    /// `SO_LINGER { on, 0 }` -- make the next `close` send an RST rather than a
    /// FIN, which is the abortive close `socket.resetAndDestroy()` performs.
    pub(crate) fn set_linger_reset(s: Raw) -> io::Result<()> {
        let value = libc::linger { l_onoff: 1, l_linger: 0 };
        // SAFETY: `value` outlives the call and its size is passed exactly.
        let status = unsafe {
            libc::setsockopt(
                s,
                libc::SOL_SOCKET,
                libc::SO_LINGER,
                std::ptr::addr_of!(value).cast(),
                mem::size_of::<libc::linger>() as libc::socklen_t,
            )
        };
        if status < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn bind(s: Raw, addr: &SocketAddr) -> io::Result<()> {
        let (storage, len) = sockaddr_of(addr);
        // SAFETY: `storage` is a correctly sized sockaddr for `len`.
        if unsafe { libc::bind(s, storage.as_ptr().cast(), len) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn listen(s: Raw, backlog: i32) -> io::Result<()> {
        // SAFETY: scalar arguments on a socket this module owns.
        if unsafe { libc::listen(s, backlog) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    /// `accept(2)`. `Ok(None)` is "nothing pending", which is not an error.
    pub(crate) fn accept(s: Raw) -> io::Result<Option<(Raw, SocketAddr)>> {
        let mut storage = [0u8; 128];
        let mut len = storage.len() as libc::socklen_t;
        // SAFETY: `storage`/`len` are a correctly paired out buffer.
        let raw = unsafe { libc::accept(s, storage.as_mut_ptr().cast(), &mut len) };
        if raw < 0 {
            let err = last();
            if would_block(&err) {
                return Ok(None);
            }
            return Err(err);
        }
        set_nonblocking(raw)?;
        let addr = addr_of(&storage).unwrap_or_else(unspecified);
        Ok(Some((raw, addr)))
    }

    /// `connect(2)`. `Ok(true)` means the connection completed immediately,
    /// `Ok(false)` that it is in progress and readiness will report it.
    pub(crate) fn connect(s: Raw, addr: &SocketAddr) -> io::Result<bool> {
        let (storage, len) = sockaddr_of(addr);
        // SAFETY: `storage` is a correctly sized sockaddr for `len`.
        if unsafe { libc::connect(s, storage.as_ptr().cast(), len) } == 0 {
            return Ok(true);
        }
        let err = last();
        match err.raw_os_error() {
            Some(libc::EINPROGRESS) | Some(libc::EALREADY) => Ok(false),
            Some(libc::EISCONN) => Ok(true),
            _ if would_block(&err) => Ok(false),
            _ => Err(err),
        }
    }

    /// `recv(2)`. `Ok(None)` is "would block"; `Ok(Some(0))` is end of file.
    pub(crate) fn recv(s: Raw, buf: &mut [u8]) -> io::Result<Option<usize>> {
        // SAFETY: `buf` is writable for `buf.len()` bytes.
        let n = unsafe { libc::recv(s, buf.as_mut_ptr().cast(), buf.len(), 0) };
        if n < 0 {
            let err = last();
            if would_block(&err) {
                return Ok(None);
            }
            return Err(err);
        }
        Ok(Some(n as usize))
    }

    /// `send(2)`. `Ok(None)` is "would block".
    pub(crate) fn send(s: Raw, buf: &[u8]) -> io::Result<Option<usize>> {
        // `MSG_NOSIGNAL` where it exists: a write to a closed peer must be
        // `EPIPE`, not a process-killing SIGPIPE.
        #[cfg(target_os = "linux")]
        let flags = libc::MSG_NOSIGNAL;
        #[cfg(not(target_os = "linux"))]
        let flags = 0;
        // SAFETY: `buf` is readable for `buf.len()` bytes.
        let n = unsafe { libc::send(s, buf.as_ptr().cast(), buf.len(), flags) };
        if n < 0 {
            let err = last();
            if would_block(&err) {
                return Ok(None);
            }
            return Err(err);
        }
        Ok(Some(n as usize))
    }

    pub(crate) fn shutdown_write(s: Raw) -> io::Result<()> {
        // SAFETY: scalar arguments on a socket this module owns.
        if unsafe { libc::shutdown(s, libc::SHUT_WR) } < 0 {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn close(s: Raw) {
        // SAFETY: the descriptor is removed from the table before this call,
        // so nothing can use it afterwards.
        unsafe { libc::close(s) };
    }

    pub(crate) fn local_addr(s: Raw) -> io::Result<SocketAddr> {
        let mut storage = [0u8; 128];
        let mut len = storage.len() as libc::socklen_t;
        // SAFETY: `storage`/`len` are a correctly paired out buffer.
        if unsafe { libc::getsockname(s, storage.as_mut_ptr().cast(), &mut len) } < 0 {
            return Err(last());
        }
        addr_of(&storage).ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))
    }

    pub(crate) fn peer_addr(s: Raw) -> io::Result<SocketAddr> {
        let mut storage = [0u8; 128];
        let mut len = storage.len() as libc::socklen_t;
        // SAFETY: as `local_addr`.
        if unsafe { libc::getpeername(s, storage.as_mut_ptr().cast(), &mut len) } < 0 {
            return Err(last());
        }
        addr_of(&storage).ok_or_else(|| io::Error::from_raw_os_error(libc::EINVAL))
    }

    /// `SO_ERROR`, which is how a settled non-blocking `connect` reports
    /// whether it succeeded.
    pub(crate) fn take_error(s: Raw) -> io::Result<Option<io::Error>> {
        let mut value: i32 = 0;
        let mut len = mem::size_of::<i32>() as libc::socklen_t;
        // SAFETY: `value`/`len` are a correctly paired out buffer.
        let status = unsafe {
            libc::getsockopt(
                s,
                libc::SOL_SOCKET,
                libc::SO_ERROR,
                std::ptr::addr_of_mut!(value).cast(),
                &mut len,
            )
        };
        if status < 0 {
            return Err(last());
        }
        if value == 0 {
            return Ok(None);
        }
        Ok(Some(io::Error::from_raw_os_error(value)))
    }

    /// `poll(2)` over the live handles, blocking at most `timeout_ms`.
    pub(crate) fn poll(items: &mut [PollItem], timeout_ms: i32) -> io::Result<()> {
        if items.is_empty() {
            if timeout_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(timeout_ms as u64));
            }
            return Ok(());
        }
        let mut fds: Vec<libc::pollfd> = items
            .iter()
            .map(|item| libc::pollfd {
                fd: item.raw,
                events: events_of(item.interest),
                revents: 0,
            })
            .collect();
        // SAFETY: `fds` is a valid array of `fds.len()` pollfds.
        let status =
            unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout_ms) };
        if status < 0 {
            let err = last();
            // An interrupted wait is not a failure: the caller polls again.
            if err.raw_os_error() == Some(libc::EINTR) {
                return Ok(());
            }
            return Err(err);
        }
        for (item, fd) in items.iter_mut().zip(fds.iter()) {
            item.revents = revents_of(fd.revents);
        }
        Ok(())
    }

    fn events_of(interest: u8) -> libc::c_short {
        let mut events: libc::c_short = 0;
        if interest & READ != 0 {
            events |= libc::POLLIN;
        }
        if interest & WRITE != 0 {
            events |= libc::POLLOUT;
        }
        events
    }

    fn revents_of(revents: libc::c_short) -> u8 {
        let mut mask = 0u8;
        if revents & (libc::POLLIN | libc::POLLHUP) != 0 {
            mask |= READ;
        }
        if revents & libc::POLLOUT != 0 {
            mask |= WRITE;
        }
        if revents & (libc::POLLERR | libc::POLLNVAL) != 0 {
            mask |= ERR;
        }
        mask
    }

    /// A `SocketAddr` as the bytes `bind`/`connect` want.
    fn sockaddr_of(addr: &SocketAddr) -> ([u8; 128], libc::socklen_t) {
        let mut storage = [0u8; 128];
        match addr {
            SocketAddr::V4(v4) => {
                let raw = libc::sockaddr_in {
                    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
                    sin_len: mem::size_of::<libc::sockaddr_in>() as u8,
                    sin_family: libc::AF_INET as libc::sa_family_t,
                    sin_port: v4.port().to_be(),
                    sin_addr: libc::in_addr {
                        s_addr: u32::from_ne_bytes(v4.ip().octets()),
                    },
                    sin_zero: [0; 8],
                };
                let len = mem::size_of::<libc::sockaddr_in>();
                // SAFETY: `raw` is `len` bytes and `storage` is larger.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        std::ptr::addr_of!(raw).cast::<u8>(),
                        storage.as_mut_ptr(),
                        len,
                    )
                };
                (storage, len as libc::socklen_t)
            }
            SocketAddr::V6(v6) => {
                let raw = libc::sockaddr_in6 {
                    #[cfg(any(target_os = "macos", target_os = "ios", target_os = "freebsd"))]
                    sin6_len: mem::size_of::<libc::sockaddr_in6>() as u8,
                    sin6_family: libc::AF_INET6 as libc::sa_family_t,
                    sin6_port: v6.port().to_be(),
                    sin6_flowinfo: v6.flowinfo(),
                    sin6_addr: libc::in6_addr {
                        s6_addr: v6.ip().octets(),
                    },
                    sin6_scope_id: v6.scope_id(),
                };
                let len = mem::size_of::<libc::sockaddr_in6>();
                // SAFETY: as above.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        std::ptr::addr_of!(raw).cast::<u8>(),
                        storage.as_mut_ptr(),
                        len,
                    )
                };
                (storage, len as libc::socklen_t)
            }
        }
    }

    /// The inverse of [`sockaddr_of`], for `getsockname`/`getpeername`/`accept`.
    fn addr_of(storage: &[u8; 128]) -> Option<SocketAddr> {
        let family = u16::from_ne_bytes([storage[0], storage[1]]);
        // The BSDs put a one-byte length first, so the family is byte 1 there.
        let family = if cfg!(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd"
        )) {
            u16::from(storage[1])
        } else {
            family
        };
        decode_sockaddr(storage, family)
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::mem;
    use std::sync::Once;
    use windows_sys::Win32::Networking::WinSock::{
        bind as ws_bind, closesocket, connect as ws_connect, getpeername, getsockname, getsockopt,
        ioctlsocket, listen as ws_listen, recv as ws_recv, select, send as ws_send,
        setsockopt, shutdown as ws_shutdown, socket as ws_socket, WSAGetLastError, WSAStartup,
        AF_INET, AF_INET6, FIONBIO, INVALID_SOCKET, IPPROTO_IPV6, IPPROTO_TCP, IPV6_V6ONLY,
        SD_SEND, SOCKET, SOCKET_ERROR, SOCK_STREAM, SOL_SOCKET, SO_ERROR, SO_KEEPALIVE, SO_LINGER,
        SO_REUSEADDR, TCP_KEEPIDLE, TCP_NODELAY, TIMEVAL, WSADATA, WSAEADDRINUSE,
        WSAEADDRNOTAVAIL, WSAEAFNOSUPPORT, WSAEALREADY, WSAECONNABORTED, WSAECONNREFUSED,
        WSAECONNRESET, WSAEDESTADDRREQ, WSAEFAULT, WSAEHOSTUNREACH, WSAEINPROGRESS, WSAEINTR,
        WSAEINVAL, WSAEISCONN, WSAEMFILE, WSAEMSGSIZE, WSAENETDOWN, WSAENETUNREACH, WSAENOBUFS,
        WSAENOTCONN, WSAENOTSOCK, WSAEOPNOTSUPP, WSAEPROTONOSUPPORT, WSAESHUTDOWN,
        WSAETIMEDOUT, WSAEWOULDBLOCK,
    };

    /// A Windows socket is a kernel handle, not a small integer.
    pub(crate) type Raw = SOCKET;

    /// The "no socket yet" value; see the POSIX counterpart.
    pub(crate) const INVALID: Raw = INVALID_SOCKET;

    static STARTUP: Once = Once::new();

    /// `WSAStartup`, once per process. `std::net` does this lazily on its first
    /// socket, and nothing here goes through `std::net`, so the loop does it
    /// itself before the first `socket()`.
    pub(crate) fn startup() {
        STARTUP.call_once(|| {
            let mut data: WSADATA = unsafe { mem::zeroed() };
            // SAFETY: `data` is a writable WSADATA for the call.
            unsafe { WSAStartup(0x0202, &mut data) };
        });
    }

    /// libuv's error *name* for a Winsock error (`uv_translate_sys_error`),
    /// which is what makes `err.code` read `ECONNREFUSED` on Windows too.
    pub(crate) fn uv_code_of(err: &io::Error) -> &'static str {
        match err.raw_os_error().unwrap_or(0) {
            x if x == WSAEADDRINUSE => "EADDRINUSE",
            x if x == WSAEADDRNOTAVAIL => "EADDRNOTAVAIL",
            x if x == WSAEAFNOSUPPORT => "EAFNOSUPPORT",
            x if x == WSAEWOULDBLOCK => "EAGAIN",
            x if x == WSAEALREADY => "EALREADY",
            x if x == WSAECONNABORTED => "ECONNABORTED",
            x if x == WSAECONNREFUSED => "ECONNREFUSED",
            x if x == WSAECONNRESET => "ECONNRESET",
            x if x == WSAEDESTADDRREQ => "EDESTADDRREQ",
            x if x == WSAEFAULT => "EFAULT",
            x if x == WSAEHOSTUNREACH => "EHOSTUNREACH",
            x if x == WSAEINPROGRESS => "EBUSY",
            x if x == WSAEINTR => "EINTR",
            x if x == WSAEINVAL => "EINVAL",
            x if x == WSAEISCONN => "EISCONN",
            x if x == WSAEMFILE => "EMFILE",
            x if x == WSAEMSGSIZE => "EMSGSIZE",
            x if x == WSAENETDOWN => "ENETDOWN",
            x if x == WSAENETUNREACH => "ENETUNREACH",
            x if x == WSAENOBUFS => "ENOBUFS",
            x if x == WSAENOTCONN => "ENOTCONN",
            x if x == WSAENOTSOCK => "ENOTSOCK",
            x if x == WSAEOPNOTSUPP => "ENOTSUP",
            x if x == WSAEPROTONOSUPPORT => "EPROTONOSUPPORT",
            x if x == WSAESHUTDOWN => "EPIPE",
            x if x == WSAETIMEDOUT => "ETIMEDOUT",
            10013 => "EACCES",
            _ => "UNKNOWN",
        }
    }

    fn last() -> io::Error {
        // SAFETY: no arguments, reads this thread's last Winsock error.
        io::Error::from_raw_os_error(unsafe { WSAGetLastError() })
    }

    fn would_block(err: &io::Error) -> bool {
        err.raw_os_error() == Some(WSAEWOULDBLOCK)
    }

    pub(crate) fn socket(ipv6: bool) -> io::Result<Raw> {
        startup();
        let family = if ipv6 { AF_INET6 } else { AF_INET };
        // SAFETY: scalar arguments.
        let raw = unsafe { ws_socket(i32::from(family), SOCK_STREAM, IPPROTO_TCP) };
        if raw == INVALID_SOCKET {
            return Err(last());
        }
        set_nonblocking(raw)?;
        Ok(raw)
    }

    pub(crate) fn set_nonblocking(s: Raw) -> io::Result<()> {
        let mut mode: u32 = 1;
        // SAFETY: `mode` outlives the call.
        if unsafe { ioctlsocket(s, FIONBIO, &mut mode) } == SOCKET_ERROR {
            return Err(last());
        }
        Ok(())
    }

    fn set_opt_i32(s: Raw, level: i32, name: i32, value: i32) -> io::Result<()> {
        let bytes = value.to_ne_bytes();
        // SAFETY: `bytes` is four readable bytes for the call.
        let status = unsafe { setsockopt(s, level, name, bytes.as_ptr(), 4) };
        if status == SOCKET_ERROR {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn set_reuse_addr(s: Raw, on: bool) -> io::Result<()> {
        set_opt_i32(s, SOL_SOCKET, SO_REUSEADDR, i32::from(on))
    }

    pub(crate) fn set_ipv6_only(s: Raw, on: bool) -> io::Result<()> {
        set_opt_i32(s, IPPROTO_IPV6 as i32, IPV6_V6ONLY, i32::from(on))
    }

    pub(crate) fn set_nodelay(s: Raw, on: bool) -> io::Result<()> {
        set_opt_i32(s, IPPROTO_TCP as i32, TCP_NODELAY, i32::from(on))
    }

    pub(crate) fn set_keepalive(s: Raw, on: bool, delay_secs: u32) -> io::Result<()> {
        set_opt_i32(s, SOL_SOCKET, SO_KEEPALIVE, i32::from(on))?;
        if on && delay_secs > 0 {
            // Windows takes the idle delay in seconds too, since 10.0.16299;
            // an older kernel refuses it, which libuv also ignores.
            let _ = set_opt_i32(s, IPPROTO_TCP as i32, TCP_KEEPIDLE, delay_secs as i32);
        }
        Ok(())
    }

    /// `SO_LINGER { on, 0 }`; see the POSIX counterpart. Windows' `LINGER` is
    /// two `u_short`s rather than two `int`s.
    pub(crate) fn set_linger_reset(s: Raw) -> io::Result<()> {
        let mut bytes = [0u8; 4];
        bytes[0..2].copy_from_slice(&1u16.to_ne_bytes());
        bytes[2..4].copy_from_slice(&0u16.to_ne_bytes());
        // SAFETY: `bytes` is four readable bytes for the call.
        let status = unsafe { setsockopt(s, SOL_SOCKET, SO_LINGER, bytes.as_ptr(), 4) };
        if status == SOCKET_ERROR {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn bind(s: Raw, addr: &SocketAddr) -> io::Result<()> {
        let (storage, len) = sockaddr_of(addr);
        // SAFETY: `storage` holds `len` valid sockaddr bytes.
        if unsafe { ws_bind(s, storage.as_ptr().cast(), len) } == SOCKET_ERROR {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn listen(s: Raw, backlog: i32) -> io::Result<()> {
        // SAFETY: scalar arguments.
        if unsafe { ws_listen(s, backlog) } == SOCKET_ERROR {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn accept(s: Raw) -> io::Result<Option<(Raw, SocketAddr)>> {
        let mut storage = [0u8; 128];
        let mut len = storage.len() as i32;
        // SAFETY: `storage`/`len` are a correctly paired out buffer.
        let raw = unsafe {
            windows_sys::Win32::Networking::WinSock::accept(
                s,
                storage.as_mut_ptr().cast(),
                &mut len,
            )
        };
        if raw == INVALID_SOCKET {
            let err = last();
            if would_block(&err) {
                return Ok(None);
            }
            return Err(err);
        }
        set_nonblocking(raw)?;
        let addr = addr_of(&storage).unwrap_or_else(unspecified);
        Ok(Some((raw, addr)))
    }

    pub(crate) fn connect(s: Raw, addr: &SocketAddr) -> io::Result<bool> {
        let (storage, len) = sockaddr_of(addr);
        // SAFETY: `storage` holds `len` valid sockaddr bytes.
        if unsafe { ws_connect(s, storage.as_ptr().cast(), len) } == 0 {
            return Ok(true);
        }
        let err = last();
        match err.raw_os_error() {
            Some(x) if x == WSAEWOULDBLOCK || x == WSAEINPROGRESS || x == WSAEALREADY => Ok(false),
            Some(x) if x == WSAEISCONN => Ok(true),
            _ => Err(err),
        }
    }

    pub(crate) fn recv(s: Raw, buf: &mut [u8]) -> io::Result<Option<usize>> {
        // SAFETY: `buf` is writable for `buf.len()` bytes.
        let n = unsafe { ws_recv(s, buf.as_mut_ptr(), buf.len() as i32, 0) };
        if n == SOCKET_ERROR {
            let err = last();
            if would_block(&err) {
                return Ok(None);
            }
            return Err(err);
        }
        Ok(Some(n as usize))
    }

    pub(crate) fn send(s: Raw, buf: &[u8]) -> io::Result<Option<usize>> {
        // SAFETY: `buf` is readable for `buf.len()` bytes.
        let n = unsafe { ws_send(s, buf.as_ptr(), buf.len() as i32, 0) };
        if n == SOCKET_ERROR {
            let err = last();
            if would_block(&err) {
                return Ok(None);
            }
            return Err(err);
        }
        Ok(Some(n as usize))
    }

    pub(crate) fn shutdown_write(s: Raw) -> io::Result<()> {
        // SAFETY: scalar arguments.
        if unsafe { ws_shutdown(s, SD_SEND as i32) } == SOCKET_ERROR {
            return Err(last());
        }
        Ok(())
    }

    pub(crate) fn close(s: Raw) {
        // SAFETY: the handle is removed from the table before this call.
        unsafe { closesocket(s) };
    }

    pub(crate) fn local_addr(s: Raw) -> io::Result<SocketAddr> {
        let mut storage = [0u8; 128];
        let mut len = storage.len() as i32;
        // SAFETY: `storage`/`len` are a correctly paired out buffer.
        if unsafe { getsockname(s, storage.as_mut_ptr().cast(), &mut len) } == SOCKET_ERROR {
            return Err(last());
        }
        addr_of(&storage).ok_or_else(|| io::Error::from_raw_os_error(WSAEINVAL))
    }

    pub(crate) fn peer_addr(s: Raw) -> io::Result<SocketAddr> {
        let mut storage = [0u8; 128];
        let mut len = storage.len() as i32;
        // SAFETY: as `local_addr`.
        if unsafe { getpeername(s, storage.as_mut_ptr().cast(), &mut len) } == SOCKET_ERROR {
            return Err(last());
        }
        addr_of(&storage).ok_or_else(|| io::Error::from_raw_os_error(WSAEINVAL))
    }

    pub(crate) fn take_error(s: Raw) -> io::Result<Option<io::Error>> {
        let mut bytes = [0u8; 4];
        let mut len: i32 = 4;
        // SAFETY: `bytes`/`len` are a correctly paired out buffer.
        let status =
            unsafe { getsockopt(s, SOL_SOCKET, SO_ERROR, bytes.as_mut_ptr(), &mut len) };
        if status == SOCKET_ERROR {
            return Err(last());
        }
        let value = i32::from_ne_bytes(bytes);
        if value == 0 {
            return Ok(None);
        }
        Ok(Some(io::Error::from_raw_os_error(value)))
    }

    /// A Windows `fd_set`: `u_int fd_count` followed by `fd_count` SOCKETs.
    ///
    /// Built in a `Vec` rather than taken from the header's fixed-size struct,
    /// which is what lifts the `FD_SETSIZE` ceiling — see the module
    /// documentation.
    struct FdSet {
        words: Vec<usize>,
    }

    impl FdSet {
        fn new(capacity: usize) -> Self {
            // One word for the count (`u_int` padded to the SOCKET alignment),
            // then one per socket.
            FdSet { words: vec![0usize; capacity + 1] }
        }

        fn push(&mut self, s: Raw) {
            let count = self.words[0];
            self.words[1 + count] = s;
            self.words[0] = count + 1;
        }

        fn is_empty(&self) -> bool {
            self.words[0] == 0
        }

        fn contains(&self, s: Raw) -> bool {
            let count = self.words[0];
            self.words[1..=count].contains(&s)
        }

        fn as_ptr(&mut self) -> *mut windows_sys::Win32::Networking::WinSock::FD_SET {
            self.words.as_mut_ptr().cast()
        }
    }

    /// `select` over the live handles, blocking at most `timeout_ms`.
    pub(crate) fn poll(items: &mut [PollItem], timeout_ms: i32) -> io::Result<()> {
        if items.is_empty() {
            if timeout_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(timeout_ms as u64));
            }
            return Ok(());
        }
        let mut readers = FdSet::new(items.len());
        let mut writers = FdSet::new(items.len());
        let mut excepts = FdSet::new(items.len());
        for item in items.iter() {
            if item.interest & READ != 0 {
                readers.push(item.raw);
            }
            if item.interest & WRITE != 0 {
                writers.push(item.raw);
                // A refused `connect` only ever shows up here; see the module
                // documentation for why this loop is `select` and not `WSAPoll`.
                excepts.push(item.raw);
            }
        }
        if readers.is_empty() && writers.is_empty() {
            if timeout_ms > 0 {
                std::thread::sleep(std::time::Duration::from_millis(timeout_ms as u64));
            }
            return Ok(());
        }
        let timeout = TIMEVAL {
            tv_sec: timeout_ms / 1000,
            tv_usec: (timeout_ms % 1000) * 1000,
        };
        let read_ptr = if readers.is_empty() { std::ptr::null_mut() } else { readers.as_ptr() };
        let write_ptr = if writers.is_empty() { std::ptr::null_mut() } else { writers.as_ptr() };
        let except_ptr = if excepts.is_empty() { std::ptr::null_mut() } else { excepts.as_ptr() };
        // SAFETY: each non-null pointer is a correctly laid out counted fd_set,
        // and `timeout` outlives the call.
        let status = unsafe { select(0, read_ptr, write_ptr, except_ptr, &timeout) };
        if status == SOCKET_ERROR {
            let err = last();
            if err.raw_os_error() == Some(WSAEINTR) {
                return Ok(());
            }
            return Err(err);
        }
        for item in items.iter_mut() {
            let mut mask = 0u8;
            if readers.contains(item.raw) {
                mask |= READ;
            }
            if writers.contains(item.raw) {
                mask |= WRITE;
            }
            if excepts.contains(item.raw) {
                mask |= ERR;
            }
            item.revents = mask;
        }
        Ok(())
    }

    fn sockaddr_of(addr: &SocketAddr) -> ([u8; 128], i32) {
        let mut storage = [0u8; 128];
        match addr {
            SocketAddr::V4(v4) => {
                storage[0..2].copy_from_slice(&AF_INET.to_ne_bytes());
                storage[2..4].copy_from_slice(&v4.port().to_be_bytes());
                storage[4..8].copy_from_slice(&v4.ip().octets());
                (storage, 16)
            }
            SocketAddr::V6(v6) => {
                storage[0..2].copy_from_slice(&AF_INET6.to_ne_bytes());
                storage[2..4].copy_from_slice(&v6.port().to_be_bytes());
                storage[4..8].copy_from_slice(&v6.flowinfo().to_ne_bytes());
                storage[8..24].copy_from_slice(&v6.ip().octets());
                storage[24..28].copy_from_slice(&v6.scope_id().to_ne_bytes());
                (storage, 28)
            }
        }
    }

    fn addr_of(storage: &[u8; 128]) -> Option<SocketAddr> {
        let family = u16::from_ne_bytes([storage[0], storage[1]]);
        decode_sockaddr(storage, family)
    }
}

/// The address a peer reports when the platform gives none — `0.0.0.0:0`,
/// which is also what libuv hands up in that case.
fn unspecified() -> SocketAddr {
    SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
}

/// Decode a `sockaddr_in`/`sockaddr_in6` whose family is already known.
///
/// Shared by both platforms: the on-the-wire layout of the two address
/// structures (port and address in network order at fixed offsets) is the same
/// everywhere, and only the family field's position differs — which the
/// callers resolve before calling this.
fn decode_sockaddr(storage: &[u8; 128], family: u16) -> Option<SocketAddr> {
    const AF_INET_U16: u16 = 2;
    match family {
        AF_INET_U16 => {
            let port = u16::from_be_bytes([storage[2], storage[3]]);
            let octets = [storage[4], storage[5], storage[6], storage[7]];
            Some(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::from(octets), port)))
        }
        // `AF_INET6` is 10 on Linux, 30 on the BSDs and 23 on Windows; any of
        // the three means the same 28-byte layout.
        10 | 23 | 30 => {
            let port = u16::from_be_bytes([storage[2], storage[3]]);
            let flowinfo = u32::from_ne_bytes([storage[4], storage[5], storage[6], storage[7]]);
            let mut octets = [0u8; 16];
            octets.copy_from_slice(&storage[8..24]);
            let scope = u32::from_ne_bytes([storage[24], storage[25], storage[26], storage[27]]);
            Some(SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::from(octets),
                port,
                flowinfo,
                scope,
            )))
        }
        _ => None,
    }
}

/// The textual address and family Node reports for a `SocketAddr`, as the
/// `(address, port, family)` triple `socket.address()` answers.
pub(crate) fn describe(addr: &SocketAddr) -> (String, u16, &'static str) {
    match addr.ip() {
        IpAddr::V4(v4) => (v4.to_string(), addr.port(), "IPv4"),
        IpAddr::V6(v6) => (v6.to_string(), addr.port(), "IPv6"),
    }
}

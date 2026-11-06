//! `node:io` — the shared asynchronous-I/O readiness loop, as a native
//! `zun_abi` extension.
//!
//! This module is **not** `node:net`. It is the foundation every I/O-bearing
//! Node module in this library needs and none of them had: a table of
//! non-blocking handles, the eleven operations on one, and a *readiness query*
//! that blocks for at most a requested timeout and reports which handles are
//! ready. `net` is the first consumer (`src/net/net.ts`); `dgram`,
//! `child_process.spawn`'s pipes, `fs`' streams and `http` are the next ones,
//! and they add primitives beside these rather than starting a second table.
//!
//! Its TypeScript counterpart is `src/io/io.ts` — the loop proper, which owns
//! `ref`/`unref` accounting, the pump and the dispatch to callbacks. The seam
//! is PLAN.md principle 2 at its sharpest: *every* line here is a syscall, and
//! every line there is scheduling.
//!
//! # Why a readiness loop and not blocking natives
//!
//! `src/dns/dns.ts` documents the pattern this library used until now:
//! "synchronous natives, asynchronous API" — the native blocks, and the result
//! is delivered through `process.nextTick` so the *shape* of Node's API is
//! preserved. That works for a name lookup, which completes in milliseconds and
//! cannot be interleaved with anything the program is also doing. It cannot
//! work for a socket. A `net` server has to be *waiting* for a connection while
//! the program runs; two sockets have to make progress at the same time; and a
//! read has to be able to complete after the call that armed it returned. None
//! of that is expressible as a blocking call.
//!
//! The answer, and the only one ABI v1 allows, inverts the direction: the
//! natives never wait for a *particular* event. Every operation here either
//! completes immediately or reports "not yet" ([`AGAIN`]), and one native —
//! [`poll`] — waits for *any* of the registered handles to become ready, for at
//! most the timeout it is given. The TypeScript loop calls that one from the
//! engine's macrotask tier, so the wait happens inside a native (which is the
//! only place in this runtime where a real wait can happen) while the engine's
//! own queues stay in charge of ordering.
//!
//! That division is also what keeps an idle server off the CPU. The engine's
//! timer tier runs on a *virtual* clock that fast-forwards to the next due time
//! instead of sleeping (NUCLEUS §9a), so a pump armed with `setTimeout(…, 20)`
//! is re-entered immediately and a loop built on timers alone would spin a core.
//! The only real sleep available is the one inside [`poll`], which is exactly
//! where this design puts it.
//!
//! # The carrier
//!
//! ABI v1 carries one scalar word per value, so every structured result crosses
//! as **one status-prefixed, separator-delimited string**, in the grammar
//! `node:os` fixed and `lib.rs` documents:
//!
//! ```text
//! result  := "+" payload | "-"
//! payload := record (RS record)*
//! record  := field (US field)*
//! RS = U+001E     US = U+001F
//! ```
//!
//! A leading `-` means the call failed and the per-thread error slots describe
//! it ([`crate::last_error_code`] & co., read back through the `ioError*`
//! functions below). Failure is reported in band rather than through the ABI's
//! status for the reason `src/os/os.ts` documents: an error thrown out of an
//! extension call is not catchable in the host today
//! (<https://github.com/UrubuCode/zun/issues/33>).
//!
//! Three results need a third answer besides success and failure, because
//! "not ready yet" is neither:
//!
//! | native       | `"+"` + …                                   | [`AGAIN`] |
//! |--------------|---------------------------------------------|-----------|
//! | `ioAccept`   | the new handle and both peers' addresses    | no connection pending |
//! | `ioRead`     | `D` + base64 bytes, or `E` for end of file  | no data pending |
//! | `ioWrite`    | the number of bytes accepted                | the send buffer is full |
//!
//! Bytes cross base64 for the reason `node:fs` documents: the `Str` carrier is
//! a NUL-terminated C string, so raw bytes cannot ride it. The encoder is
//! `src/fs/base64.rs`, shared rather than copied.
//!
//! # The handle table
//!
//! A handle is a small integer the program keeps across calls, exactly like an
//! `fs` descriptor, and for the same reason: the socket itself lives here. The
//! numbers are this table's own and count up from 1 — a POSIX socket *is* a
//! descriptor, but a Windows socket is a kernel handle with no small-integer
//! form, so publishing the table's own number is the only portable choice (the
//! same decision `src/fs/fd.rs` documents).
//!
//! Each row remembers its readiness **interest**, which is what makes the
//! single [`poll`] call cheap: the TypeScript loop sets a handle's interest
//! when it starts and stops wanting an event, and [`poll`] watches exactly the
//! union. A handle with no interest is still in the table (so its address can
//! be read and it can be closed) but is not waited on.

use std::collections::HashMap;
use std::io;
use std::net::{SocketAddr, ToSocketAddrs};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use zun_abi::ZunTy::{I64, Str};
use zun_abi::ZunValue;

use crate::abi::{arg_i64, arg_str, ret_str};
use crate::fs::base64;
use crate::Descriptor;

pub(crate) mod sys;

#[cfg(test)]
mod tests;

/// Unit separator: between the fields of one record.
pub(crate) const US: char = '\u{1f}';
/// Record separator: between records.
pub(crate) const RS: char = '\u{1e}';
/// The in-band failure marker.
pub(crate) const FAILED: &str = "-";
/// The in-band "not ready yet" marker — `EAGAIN`, which is not an error.
pub(crate) const AGAIN: &str = "+A";
/// `ioRead`'s end-of-file answer.
pub(crate) const EOF: &str = "+E";

/// The largest chunk one `ioRead` takes off a socket. Node's default allocation
/// for a stream read is 64 KiB, and the base64 of that still fits a `Str`
/// comfortably.
const MAX_READ: usize = 65536;

/// What a handle is, which decides what readiness means for it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// A listening socket: readable means a connection is pending.
    Listener,
    /// A connected or connecting stream.
    Stream,
}

/// One row of the handle table.
#[derive(Debug)]
struct Handle {
    raw: sys::Raw,
    kind: Kind,
    /// The readiness mask [`poll`] watches for this handle; see the module
    /// documentation.
    interest: u8,
    /// True until a non-blocking `connect` has settled, which is what makes a
    /// writable event mean "connected" rather than "drained".
    connecting: bool,
}

/// Every live handle, keyed by the number published to the program.
static TABLE: Mutex<Option<HashMap<i64, Handle>>> = Mutex::new(None);

/// The next handle number to publish. 1-based, so `0` is never a valid handle
/// and the TypeScript side can use it as "none".
static NEXT_HANDLE: AtomicI64 = AtomicI64::new(1);

fn with_table<R>(action: impl FnOnce(&mut HashMap<i64, Handle>) -> R) -> R {
    let mut guard = TABLE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    action(guard.get_or_insert_with(HashMap::new))
}

/// Encode a successful payload of one record.
fn ok_fields(fields: &[String]) -> String {
    let mut out = String::from("+");
    for (index, field) in fields.iter().enumerate() {
        if index > 0 {
            out.push(US);
        }
        out.push_str(field);
    }
    out
}

/// Encode a successful payload with nothing in it (a call that only has to
/// succeed).
fn ok() -> String {
    String::from("+")
}

/// libuv's `(code, errno, description)` for a network error code, as
/// `uv_strerror` words it.
///
/// Node splices the description into `err.message` verbatim, which is why the
/// wording is libuv's rather than the platform's: `connect ECONNREFUSED
/// 127.0.0.1:80` comes from here. libuv reports `-errno` where the platform has
/// an errno and a value from its own reserved range where it does not, which is
/// Windows (`include/uv/errno.h`).
fn uv_error(code: &str) -> (&'static str, i64, &'static str) {
    match code {
        "EACCES" => ("EACCES", uv_errno(13, -4092), "permission denied"),
        "EADDRINUSE" => ("EADDRINUSE", uv_errno(98, -4091), "address already in use"),
        "EADDRNOTAVAIL" => {
            ("EADDRNOTAVAIL", uv_errno(99, -4090), "address not available")
        }
        "EAFNOSUPPORT" => {
            ("EAFNOSUPPORT", uv_errno(97, -4089), "address family not supported")
        }
        "EAGAIN" => ("EAGAIN", uv_errno(11, -4088), "resource temporarily unavailable"),
        "EAI_AGAIN" => ("EAI_AGAIN", -3001, "temporary failure"),
        "EAI_FAIL" => ("EAI_FAIL", -3003, "permanent failure"),
        "EAI_NODATA" => ("EAI_NODATA", -3007, "no address"),
        "EAI_NONAME" => ("EAI_NONAME", -3008, "unknown node or service"),
        "EALREADY" => ("EALREADY", uv_errno(114, -4084), "connection already in progress"),
        "EBADF" => ("EBADF", uv_errno(9, -4083), "bad file descriptor"),
        "EBUSY" => ("EBUSY", uv_errno(16, -4082), "resource busy or locked"),
        "ECANCELED" => ("ECANCELED", uv_errno(125, -4081), "operation canceled"),
        "ECONNABORTED" => ("ECONNABORTED", uv_errno(103, -4079), "software caused connection abort"),
        "ECONNREFUSED" => ("ECONNREFUSED", uv_errno(111, -4078), "connection refused"),
        "ECONNRESET" => ("ECONNRESET", uv_errno(104, -4077), "connection reset by peer"),
        "EDESTADDRREQ" => ("EDESTADDRREQ", uv_errno(89, -4076), "destination address required"),
        "EFAULT" => ("EFAULT", uv_errno(14, -4074), "bad address in system call argument"),
        "EHOSTUNREACH" => ("EHOSTUNREACH", uv_errno(113, -4073), "host is unreachable"),
        "EINTR" => ("EINTR", uv_errno(4, -4072), "interrupted system call"),
        "EINVAL" => ("EINVAL", uv_errno(22, -4071), "invalid argument"),
        "EIO" => ("EIO", uv_errno(5, -4070), "i/o error"),
        "EISCONN" => ("EISCONN", uv_errno(106, -4069), "socket is already connected"),
        "EMFILE" => ("EMFILE", uv_errno(24, -4066), "too many open files"),
        "EMSGSIZE" => ("EMSGSIZE", uv_errno(90, -4065), "message too long"),
        "ENETDOWN" => ("ENETDOWN", uv_errno(100, -4062), "network is down"),
        "ENETUNREACH" => ("ENETUNREACH", uv_errno(101, -4063), "network is unreachable"),
        "ENOBUFS" => ("ENOBUFS", uv_errno(105, -4060), "no buffer space available"),
        "ENOMEM" => ("ENOMEM", uv_errno(12, -4057), "not enough memory"),
        "ENOTCONN" => ("ENOTCONN", uv_errno(107, -4053), "socket is not connected"),
        "ENOTSOCK" => ("ENOTSOCK", uv_errno(88, -4050), "socket operation on non-socket"),
        "ENOTSUP" => ("ENOTSUP", uv_errno(95, -4049), "operation not supported on socket"),
        "EPERM" => ("EPERM", uv_errno(1, -4048), "operation not permitted"),
        "EPIPE" => ("EPIPE", uv_errno(32, -4047), "broken pipe"),
        "EPROTO" => ("EPROTO", uv_errno(71, -4046), "protocol error"),
        "EPROTONOSUPPORT" => {
            ("EPROTONOSUPPORT", uv_errno(93, -4045), "protocol not supported")
        }
        "ETIMEDOUT" => ("ETIMEDOUT", uv_errno(110, -4039), "connection timed out"),
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

/// Stash a failure described by a libuv error code and return [`FAILED`].
///
/// `address` is the `address:port` Node names in a socket error's message
/// (`connect ECONNREFUSED 127.0.0.1:8080`); it rides the `path` slot, which is
/// the one the error carrier already has for "what the failed call was given".
fn fail_code(syscall: &str, code: &str, address: &str) -> String {
    let (code, errno, description) = uv_error(code);
    crate::abi::fail_fs(syscall, code, errno, description, address, "");
    FAILED.to_owned()
}

/// [`fail_code`] for a platform error, mapped to the libuv code Node reports.
fn fail_io(syscall: &str, err: &io::Error, address: &str) -> String {
    fail_code(syscall, sys::uv_code_of(err), address)
}

/// Look a handle up, or report `EBADF` the way a closed socket does.
///
/// A row whose socket is still [`sys::INVALID`] — reserved by `ioSocket` and
/// not yet connected — is `EBADF` too, which is what libuv answers for an
/// uninitialized handle.
fn handle_of<R>(
    id: i64,
    syscall: &str,
    action: impl FnOnce(&mut Handle) -> R,
) -> Result<R, String> {
    with_table(|table| match table.get_mut(&id) {
        Some(handle) if handle.raw != sys::INVALID => Ok(action(handle)),
        _ => Err(fail_code(syscall, "EBADF", "")),
    })
}

/// Publish a raw socket into the table and answer its number.
fn publish(raw: sys::Raw, kind: Kind, connecting: bool) -> i64 {
    let id = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    with_table(|table| {
        table.insert(id, Handle { raw, kind, interest: 0, connecting });
    });
    id
}

/// The `address US port US family` triple every address-bearing result carries.
fn address_fields(addr: &SocketAddr) -> [String; 3] {
    let (address, port, family) = sys::describe(addr);
    [address, port.to_string(), family.to_owned()]
}

// ---------------------------------------------------------------------------
// ioLookup
// ---------------------------------------------------------------------------

/// `ioLookup(host, family)` — the system resolver, for `net`'s default
/// `lookup`.
///
/// `net.connect(port)` resolves `'localhost'` before it can connect, and
/// `server.listen({ host })` resolves too, so the loop needs a resolver. This
/// is the same `getaddrinfo` `node:dns` calls and is **blocking**, which is the
/// one place this module keeps the older "synchronous native, asynchronous API"
/// pattern: `src/net/net.ts` delivers the answer through `process.nextTick`, so
/// a `lookup` callback still runs on a later tick than its caller, exactly as
/// `src/dns/dns.ts` documents for the whole `dns` surface.
///
/// `family` is 0 (either), 4 or 6. The result is one record per address, in the
/// order the resolver returned them, which is the order Node's
/// `autoSelectFamily` reasons about.
unsafe extern "C" fn lookup(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let host = match unsafe { arg_str(args, n, 0) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above.
    let family = unsafe { arg_i64(args, n, 1) };

    // Port 0 with a host is the `getaddrinfo` call Node's `lookup` makes.
    let resolved = match (host, 0u16).to_socket_addrs() {
        Ok(iterator) => iterator,
        Err(err) => {
            // `getaddrinfo` failure is reported as libuv's EAI_* family, which
            // is what `dns.lookup` turns into `ENOTFOUND`.
            let code = if err.kind() == io::ErrorKind::InvalidInput {
                "EAI_NONAME"
            } else {
                "EAI_NONAME"
            };
            // SAFETY: `out` is a writable Str return.
            return unsafe { ret_str(out, &fail_code("getaddrinfo", code, host)) };
        }
    };

    let mut records: Vec<String> = Vec::new();
    for addr in resolved {
        let wanted = match addr {
            SocketAddr::V4(_) => 4,
            SocketAddr::V6(_) => 6,
        };
        if family != 0 && family != wanted {
            continue;
        }
        let (address, _, _) = sys::describe(&addr);
        records.push(format!("{address}{US}{wanted}"));
    }
    if records.is_empty() {
        // SAFETY: `out` is a writable Str return.
        return unsafe { ret_str(out, &fail_code("getaddrinfo", "EAI_NODATA", host)) };
    }
    let payload = format!("+{}", records.join(&RS.to_string()));
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

// ---------------------------------------------------------------------------
// ioListen / ioAccept
// ---------------------------------------------------------------------------

/// `ioListen(address, port, backlog, flags)` — bind and listen.
///
/// `address` must be an IP literal (`ioLookup` has already run); the empty
/// string is the wildcard, and `family` picks which one. `flags` is a bit set:
/// bit 0 is `ipv6Only`, bit 1 is `exclusive` — Node's `exclusive: true`, which
/// declines `SO_REUSEADDR` so a second bind of the same port fails with
/// `EADDRINUSE` instead of silently sharing it.
///
/// The result is the handle plus the address actually bound, which is how
/// `listen(0)` reports the port the kernel chose.
unsafe extern "C" fn listen(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let address = match unsafe { arg_str(args, n, 0) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above.
    let port = unsafe { arg_i64(args, n, 1) } as u16;
    // SAFETY: as above.
    let backlog = unsafe { arg_i64(args, n, 2) } as i32;
    // SAFETY: as above.
    let flags = unsafe { arg_i64(args, n, 3) };
    let ipv6_only = flags & 1 != 0;
    let exclusive = flags & 2 != 0;

    let payload = if address.is_empty() && !ipv6_only {
        // `server.listen(port)` with no host. Node binds the **dual-stack**
        // IPv6 wildcard so that a client resolving `localhost` to `::1` and one
        // resolving it to `127.0.0.1` both reach the server, and falls back to
        // the IPv4 wildcard on a machine with no IPv6 at all. Binding
        // `0.0.0.0` instead is the one thing that cannot work: a loopback
        // connect to `::1` would be refused, which is exactly what the first
        // run of this module did.
        let dual = SocketAddr::new(std::net::Ipv6Addr::UNSPECIFIED.into(), port);
        match listen_on(&dual, backlog, false, exclusive) {
            Ok(text) => text,
            Err(_) => {
                let v4 = SocketAddr::new(std::net::Ipv4Addr::UNSPECIFIED.into(), port);
                match listen_on(&v4, backlog, false, exclusive) {
                    Ok(text) => text,
                    Err(text) => text,
                }
            }
        }
    } else {
        let bind_to = match parse_bind_address(address, port) {
            Some(addr) => addr,
            None => {
                // SAFETY: `out` is a writable Str return.
                return unsafe { ret_str(out, &fail_code("bind", "EINVAL", address)) };
            }
        };
        match listen_on(&bind_to, backlog, ipv6_only, exclusive) {
            Ok(text) => text,
            Err(text) => text,
        }
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// The address `ioListen` binds: an IP literal, or the family's wildcard when
/// the caller gave none. A bare `"6"` asks for the IPv6 wildcard, which is how
/// `server.listen(port)` with `ipv6Only` reaches `::`.
fn parse_bind_address(address: &str, port: u16) -> Option<SocketAddr> {
    match address {
        "" | "4" => Some(SocketAddr::new(std::net::Ipv4Addr::UNSPECIFIED.into(), port)),
        "6" => Some(SocketAddr::new(std::net::Ipv6Addr::UNSPECIFIED.into(), port)),
        literal => literal.parse::<std::net::IpAddr>().ok().map(|ip| SocketAddr::new(ip, port)),
    }
}

/// The `socket`/`setsockopt`/`bind`/`listen` sequence, factored out so the Rust
/// tests can drive it without the ABI.
fn listen_on(
    addr: &SocketAddr,
    backlog: i32,
    ipv6_only: bool,
    exclusive: bool,
) -> Result<String, String> {
    let ipv6 = addr.is_ipv6();
    let raw = sys::socket(ipv6).map_err(|err| fail_io("socket", &err, ""))?;
    // Node binds with SO_REUSEADDR unless `exclusive` was asked for, which is
    // what lets a test rebind a just-closed port.
    if !exclusive {
        let _ = sys::set_reuse_addr(raw, true);
    }
    if ipv6 {
        // A dual-stack wildcard is what Node gives `::`; `ipv6Only` is the
        // documented opt-out. Windows defaults the other way, so the option is
        // set explicitly in both directions rather than left alone.
        let _ = sys::set_ipv6_only(raw, ipv6_only);
    }
    if let Err(err) = sys::bind(raw, addr) {
        sys::close(raw);
        return Err(fail_io("bind", &err, &addr.to_string()));
    }
    if let Err(err) = sys::listen(raw, backlog) {
        sys::close(raw);
        return Err(fail_io("listen", &err, &addr.to_string()));
    }
    let bound = sys::local_addr(raw).unwrap_or(*addr);
    let id = publish(raw, Kind::Listener, false);
    let [address, port, family] = address_fields(&bound);
    Ok(ok_fields(&[id.to_string(), address, port, family]))
}

/// `ioAccept(handle)` — take one pending connection, or [`AGAIN`].
///
/// The result carries the new handle and *both* ends' addresses, because
/// `server.on('connection', socket)` hands up a socket whose `remoteAddress`
/// and `localAddress` are both already readable.
unsafe extern "C" fn accept(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let raw = match handle_of(id, "accept", |handle| {
        if handle.kind == Kind::Listener {
            Some(handle.raw)
        } else {
            None
        }
    }) {
        Ok(Some(raw)) => raw,
        Ok(None) => {
            // SAFETY: `out` is a writable Str return.
            return unsafe { ret_str(out, &fail_code("accept", "ENOTSOCK", "")) };
        }
        Err(text) => {
            // SAFETY: `out` is a writable Str return.
            return unsafe { ret_str(out, &text) };
        }
    };

    let payload = match sys::accept(raw) {
        Ok(None) => AGAIN.to_owned(),
        Ok(Some((accepted, peer))) => {
            let local = sys::local_addr(accepted).unwrap_or(peer);
            let child = publish(accepted, Kind::Stream, false);
            let [remote_address, remote_port, family] = address_fields(&peer);
            let [local_address, local_port, _] = address_fields(&local);
            ok_fields(&[
                child.to_string(),
                remote_address,
                remote_port,
                family,
                local_address,
                local_port,
            ])
        }
        Err(err) => fail_io("accept", &err, ""),
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

// ---------------------------------------------------------------------------
// ioConnect
// ---------------------------------------------------------------------------

/// `ioSocket()` — reserve a stream handle with no socket under it yet.
///
/// This is libuv's uninitialized `uv_tcp_t`, and it exists for an observable
/// reason: Node's `Socket.prototype.connect` creates its `_handle` at the top,
/// *before* the address lookup, so `socket._handle` is non-null the instant
/// `connect()` returns. Four files in the `net` corpus replace a method on it
/// right there (`client._handle.setNoDelay = …`). A handle reserved here has no
/// interest, so [`poll`] does not watch it, and `ioConnect` opens the real
/// socket into the same row once the family is known.
unsafe extern "C" fn reserve(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let id = publish(sys::INVALID, Kind::Stream, true);
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &ok_fields(&[id.to_string()])) }
}

/// `ioConnect(handle, address, port, localAddress, localPort)` — open the
/// socket for a reserved handle and start connecting.
///
/// `address` is an IP literal; `localAddress`/`localPort` are Node's
/// `localAddress`/`localPort` connect options and are bound first when given.
/// The result field is `1` when the connection completed inside this call
/// (which a loopback connect often does) and `0` when it is in progress, in
/// which case a writable readiness event settles it and `ioConnectError` says
/// whether it succeeded.
///
/// Calling it twice on one handle is how the caller tries the *next* resolved
/// address: a socket whose connect failed cannot be reused, so the old one is
/// closed and a fresh one takes its place in the same row — which keeps the
/// handle number, and therefore `socket._handle`, stable across the attempts.
unsafe extern "C" fn connect(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let address = match unsafe { arg_str(args, n, 1) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above.
    let port = unsafe { arg_i64(args, n, 2) } as u16;
    // SAFETY: as above.
    let local_address = match unsafe { arg_str(args, n, 3) } {
        Ok(value) => value,
        Err(_) => "",
    };
    // SAFETY: as above.
    let local_port = unsafe { arg_i64(args, n, 4) } as u16;

    let Ok(ip) = address.parse::<std::net::IpAddr>() else {
        // SAFETY: `out` is a writable Str return.
        return unsafe { ret_str(out, &fail_code("connect", "EINVAL", address)) };
    };
    let target = SocketAddr::new(ip, port);
    let payload = match connect_to(id, &target, local_address, local_port) {
        Ok(text) => text,
        Err(text) => text,
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// The `socket`/`bind`/`connect` sequence, factored out for the Rust tests.
///
/// `id` is a row this module already published; `0` means "publish a new one",
/// which is what the Rust tests use.
fn connect_to(
    id: i64,
    target: &SocketAddr,
    local_address: &str,
    local_port: u16,
) -> Result<String, String> {
    if id != 0 && !with_table(|table| table.contains_key(&id)) {
        return Err(fail_code("connect", "EBADF", ""));
    }
    let raw = sys::socket(target.is_ipv6()).map_err(|err| fail_io("socket", &err, ""))?;
    if !local_address.is_empty() || local_port != 0 {
        let wildcard = if target.is_ipv6() {
            std::net::Ipv6Addr::UNSPECIFIED.into()
        } else {
            std::net::Ipv4Addr::UNSPECIFIED.into()
        };
        let ip: std::net::IpAddr = if local_address.is_empty() {
            wildcard
        } else {
            match local_address.parse() {
                Ok(parsed) => parsed,
                Err(_) => {
                    sys::close(raw);
                    return Err(fail_code("bind", "EINVAL", local_address));
                }
            }
        };
        let _ = sys::set_reuse_addr(raw, true);
        if let Err(err) = sys::bind(raw, &SocketAddr::new(ip, local_port)) {
            sys::close(raw);
            return Err(fail_io("bind", &err, &format!("{ip}:{local_port}")));
        }
    }
    match sys::connect(raw, target) {
        Ok(connected) => {
            if id == 0 {
                let fresh = publish(raw, Kind::Stream, !connected);
                return Ok(ok_fields(&[fresh.to_string(), i64::from(connected).to_string()]));
            }
            // Take over the reserved row, closing whatever a previous attempt
            // on this handle left behind.
            let previous = with_table(|table| {
                table.get_mut(&id).map(|handle| {
                    let old = handle.raw;
                    handle.raw = raw;
                    handle.connecting = !connected;
                    old
                })
            });
            if let Some(old) = previous {
                if old != sys::INVALID {
                    sys::close(old);
                }
            }
            Ok(ok_fields(&[id.to_string(), i64::from(connected).to_string()]))
        }
        Err(err) => {
            sys::close(raw);
            Err(fail_io("connect", &err, &target.to_string()))
        }
    }
}

/// `ioConnectError(handle)` — `SO_ERROR` on a settled connection attempt.
///
/// Called once a connecting handle reports writable (or, on Windows, an
/// exception — see `sys.rs`): `"+"` means the connection is up, `"-"` that it
/// failed and the error slots hold libuv's reading of why.
unsafe extern "C" fn connect_error(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let looked_up = handle_of(id, "connect", |handle| {
        handle.connecting = false;
        handle.raw
    });
    let payload = match looked_up {
        Err(text) => text,
        Ok(raw) => match sys::take_error(raw) {
            Ok(None) => {
                // A socket that reports writable but has no peer is a refused
                // connection the platform declined to put in SO_ERROR (which
                // some Windows builds do); `getpeername` is the cross-check.
                match sys::peer_addr(raw) {
                    Ok(peer) => {
                        let [address, port, family] = address_fields(&peer);
                        ok_fields(&[address, port, family])
                    }
                    Err(err) => fail_io("connect", &err, ""),
                }
            }
            Ok(Some(err)) => fail_io("connect", &err, ""),
            Err(err) => fail_io("connect", &err, ""),
        },
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

// ---------------------------------------------------------------------------
// ioRead / ioWrite / ioShutdown / ioClose
// ---------------------------------------------------------------------------

/// `ioRead(handle, max)` — one non-blocking read.
///
/// `+D<base64>` is data, [`EOF`] (`+E`) is the peer's orderly close, [`AGAIN`]
/// (`+A`) is "nothing pending". `max` is clamped to [`MAX_READ`]; `0` means
/// that maximum.
unsafe extern "C" fn read(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let requested = unsafe { arg_i64(args, n, 1) };
    let wanted = if requested <= 0 {
        MAX_READ
    } else {
        (requested as usize).min(MAX_READ)
    };

    let raw = match handle_of(id, "read", |handle| handle.raw) {
        Ok(raw) => raw,
        Err(text) => {
            // SAFETY: `out` is a writable Str return.
            return unsafe { ret_str(out, &text) };
        }
    };
    let mut buffer = vec![0u8; wanted];
    let payload = match sys::recv(raw, &mut buffer) {
        Ok(None) => AGAIN.to_owned(),
        Ok(Some(0)) => EOF.to_owned(),
        Ok(Some(count)) => {
            let mut text = String::from("+D");
            text.push_str(&base64::encode(&buffer[..count]));
            text
        }
        Err(err) => fail_io("read", &err, ""),
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioWrite(handle, base64)` — one non-blocking write.
///
/// The result is the number of bytes the kernel accepted, which may be fewer
/// than were offered: a partial write is normal on a socket and the caller
/// re-offers the remainder when the handle next reports writable. [`AGAIN`]
/// means the send buffer was full and nothing was taken.
unsafe extern "C" fn write(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let encoded = match unsafe { arg_str(args, n, 1) } {
        Ok(value) => value,
        Err(status) => return status,
    };

    let raw = match handle_of(id, "write", |handle| handle.raw) {
        Ok(raw) => raw,
        Err(text) => {
            // SAFETY: `out` is a writable Str return.
            return unsafe { ret_str(out, &text) };
        }
    };
    let bytes = base64::decode(encoded);
    let payload = if bytes.is_empty() {
        ok_fields(&["0".to_owned()])
    } else {
        match sys::send(raw, &bytes) {
            Ok(None) => AGAIN.to_owned(),
            Ok(Some(count)) => ok_fields(&[count.to_string()]),
            Err(err) => fail_io("write", &err, ""),
        }
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioShutdown(handle)` — half-close the writing side, which is what
/// `socket.end()` does once its queue has drained.
unsafe extern "C" fn shutdown(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let payload = match handle_of(id, "shutdown", |handle| handle.raw) {
        Err(text) => text,
        Ok(raw) => match sys::shutdown_write(raw) {
            Ok(()) => ok(),
            Err(err) => fail_io("shutdown", &err, ""),
        },
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioReset(handle)` — arm an abortive close.
///
/// `SO_LINGER { on, 0 }` makes the `ioClose` that follows send an RST instead
/// of a FIN, which is what `socket.resetAndDestroy()` is for and what
/// `test-net-server-reset.js` observes as `ECONNRESET` on the peer. It is a
/// separate native rather than a flag on [`close`] because the TypeScript side
/// closes a socket from four paths and only one of them resets.
unsafe extern "C" fn reset(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let payload = match handle_of(id, "shutdown", |handle| handle.raw) {
        Err(text) => text,
        Ok(raw) => match sys::set_linger_reset(raw) {
            Ok(()) => ok(),
            Err(err) => fail_io("shutdown", &err, ""),
        },
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioClose(handle)` — drop the handle and close the socket.
///
/// Closing an unknown handle succeeds rather than reporting `EBADF`: the
/// TypeScript loop closes on every path out of a socket's lifetime, and a
/// double close must not raise.
unsafe extern "C" fn close(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    if let Some(handle) = with_table(|table| table.remove(&id)) {
        if handle.raw != sys::INVALID {
            sys::close(handle.raw);
        }
    }
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &ok()) }
}

// ---------------------------------------------------------------------------
// ioInterest / ioPoll
// ---------------------------------------------------------------------------

/// `ioInterest(handle, mask)` — which readiness events to watch for.
///
/// `1` is readable, `2` is writable, `3` is both, `0` is neither (the handle
/// stays in the table but [`poll`] stops waiting on it). This is the knob
/// `socket.pause()` turns: a paused socket has no read interest, so a peer that
/// keeps sending fills the kernel buffer instead of this process's memory —
/// real backpressure rather than a flag.
unsafe extern "C" fn interest(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let mask = unsafe { arg_i64(args, n, 1) } as u8;
    let payload = match handle_of(id, "poll", |handle| {
        handle.interest = mask & (sys::READ | sys::WRITE);
    }) {
        Ok(()) => ok(),
        Err(text) => text,
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioPoll(timeoutMs)` — wait for any registered handle to become ready.
///
/// This is the one call in this library that *blocks on purpose*, and the whole
/// loop rests on it: it returns as soon as a handle is ready, and after
/// `timeoutMs` milliseconds otherwise. One record per ready handle, each
/// `handle US revents`, where `revents` is the same bit set as the interest
/// mask plus bit 2 for an error or hangup.
///
/// A connecting handle is reported with the writable bit, which is how a
/// non-blocking `connect` completes; the caller then asks `ioConnectError`
/// whether it succeeded.
unsafe extern "C" fn poll(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let timeout = unsafe { arg_i64(args, n, 0) };
    let timeout = timeout.clamp(0, 60_000) as i32;

    // The table is snapshotted rather than held across the wait: a `poll` that
    // kept the lock would deadlock any re-entrant call, and nothing else can
    // touch the table while this thread is inside the syscall anyway.
    let mut items: Vec<(i64, sys::PollItem)> = with_table(|table| {
        table
            .iter()
            .filter(|(_, handle)| handle.interest != 0 && handle.raw != sys::INVALID)
            .map(|(id, handle)| {
                (
                    *id,
                    sys::PollItem { raw: handle.raw, interest: handle.interest, revents: 0 },
                )
            })
            .collect()
    });

    let mut masks: Vec<sys::PollItem> = items.iter().map(|(_, item)| *item).collect();
    if let Err(err) = sys::poll(&mut masks, timeout) {
        // SAFETY: `out` is a writable Str return.
        return unsafe { ret_str(out, &fail_io("poll", &err, "")) };
    }
    for ((_, item), polled) in items.iter_mut().zip(masks.iter()) {
        item.revents = polled.revents;
    }

    let mut records: Vec<String> = Vec::new();
    for (id, item) in &items {
        if item.revents != 0 {
            records.push(format!("{id}{US}{}", item.revents));
        }
    }
    let payload = format!("+{}", records.join(&RS.to_string()));
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

// ---------------------------------------------------------------------------
// Names and options
// ---------------------------------------------------------------------------

/// `ioSockName(handle)` — `getsockname`, which is `server.address()` and
/// `socket.localAddress`/`localPort`.
unsafe extern "C" fn sock_name(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let payload = match handle_of(id, "getsockname", |handle| handle.raw) {
        Err(text) => text,
        Ok(raw) => match sys::local_addr(raw) {
            Ok(addr) => {
                let [address, port, family] = address_fields(&addr);
                ok_fields(&[address, port, family])
            }
            Err(err) => fail_io("getsockname", &err, ""),
        },
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioPeerName(handle)` — `getpeername`, which is `socket.remoteAddress` and
/// `remotePort`.
unsafe extern "C" fn peer_name(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let payload = match handle_of(id, "getpeername", |handle| handle.raw) {
        Err(text) => text,
        Ok(raw) => match sys::peer_addr(raw) {
            Ok(addr) => {
                let [address, port, family] = address_fields(&addr);
                ok_fields(&[address, port, family])
            }
            Err(err) => fail_io("getpeername", &err, ""),
        },
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioSockOpt(handle, name, on, value)` — the two socket options `net` exposes.
///
/// `name` is `"noDelay"` or `"keepAlive"`; `value` is the keep-alive initial
/// delay in milliseconds, which libuv rounds to whole seconds.
unsafe extern "C" fn sock_opt(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let name = match unsafe { arg_str(args, n, 1) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above.
    let on = unsafe { arg_i64(args, n, 2) } != 0;
    // SAFETY: as above.
    let millis = unsafe { arg_i64(args, n, 3) };
    let seconds = (millis / 1000).clamp(0, i64::from(u32::MAX)) as u32;

    let payload = match handle_of(id, "setsockopt", |handle| handle.raw) {
        Err(text) => text,
        Ok(raw) => {
            let result = match name {
                "noDelay" => sys::set_nodelay(raw, on),
                "keepAlive" => sys::set_keepalive(raw, on, seconds),
                _ => Ok(()),
            };
            match result {
                Ok(()) => ok(),
                Err(err) => fail_io("setsockopt", &err, ""),
            }
        }
    };
    // SAFETY: `out` is a writable Str return.
    unsafe { ret_str(out, &payload) }
}

/// `ioHandleCount()` — how many handles are live.
///
/// Not part of Node's surface: it is the assertion a leak test needs, and the
/// one fact `src/io/io.ts` cannot derive from its own bookkeeping.
unsafe extern "C" fn handle_count(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let count = with_table(|table| table.len()) as i64;
    // SAFETY: `out` is a writable I64 return.
    unsafe { crate::abi::ret_i64(out, count) }
}

/// The `node:io` function table.
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor { key: b"ioLookup\0", params: &[Str, I64], ret: Str, invoke: lookup },
    Descriptor {
        key: b"ioListen\0",
        params: &[Str, I64, I64, I64],
        ret: Str,
        invoke: listen,
    },
    Descriptor { key: b"ioAccept\0", params: &[I64], ret: Str, invoke: accept },
    Descriptor { key: b"ioSocket\0", params: &[], ret: Str, invoke: reserve },
    Descriptor {
        key: b"ioConnect\0",
        params: &[I64, Str, I64, Str, I64],
        ret: Str,
        invoke: connect,
    },
    Descriptor { key: b"ioConnectError\0", params: &[I64], ret: Str, invoke: connect_error },
    Descriptor { key: b"ioRead\0", params: &[I64, I64], ret: Str, invoke: read },
    Descriptor { key: b"ioWrite\0", params: &[I64, Str], ret: Str, invoke: write },
    Descriptor { key: b"ioShutdown\0", params: &[I64], ret: Str, invoke: shutdown },
    Descriptor { key: b"ioReset\0", params: &[I64], ret: Str, invoke: reset },
    Descriptor { key: b"ioClose\0", params: &[I64], ret: Str, invoke: close },
    Descriptor { key: b"ioInterest\0", params: &[I64, I64], ret: Str, invoke: interest },
    Descriptor { key: b"ioPoll\0", params: &[I64], ret: Str, invoke: poll },
    Descriptor { key: b"ioSockName\0", params: &[I64], ret: Str, invoke: sock_name },
    Descriptor { key: b"ioPeerName\0", params: &[I64], ret: Str, invoke: peer_name },
    Descriptor {
        key: b"ioSockOpt\0",
        params: &[I64, Str, I64, I64],
        ret: Str,
        invoke: sock_opt,
    },
    Descriptor { key: b"ioHandleCount\0", params: &[], ret: I64, invoke: handle_count },
    // Error retrieval, on the ABI v1 error-slot convention (see lib.rs).
    Descriptor { key: b"ioErrorCode\0", params: &[], ret: Str, invoke: crate::last_error_code },
    Descriptor {
        key: b"ioErrorMessage\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_message,
    },
    Descriptor {
        key: b"ioErrorSyscall\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_syscall,
    },
    Descriptor { key: b"ioErrorErrno\0", params: &[], ret: I64, invoke: crate::last_error_errno },
    Descriptor { key: b"ioErrorAddress\0", params: &[], ret: Str, invoke: crate::last_error_path },
];

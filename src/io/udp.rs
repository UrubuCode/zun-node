//! Datagram (UDP) sockets on the shared I/O loop — the native half of
//! `node:dgram`.
//!
//! The handle table, the carrier grammar, the readiness query and the error
//! slots all belong to the parent module ([`super`]); this file only adds the
//! verbs a *datagram* socket has and a stream socket does not:
//!
//! | native              | what it is                                         |
//! |---------------------|----------------------------------------------------|
//! | `ioUdpOpen`         | `socket(SOCK_DGRAM)`, non-blocking                 |
//! | `ioUdpBind`         | `bind`, with `SO_REUSEADDR`/`SO_REUSEPORT`/`IPV6_V6ONLY` |
//! | `ioUdpSend`         | `sendto` (or `send` on a connected socket)         |
//! | `ioUdpRecv`         | `recvfrom`, answering the sender's address         |
//! | `ioUdpConnect`      | `connect` (a default peer, not a handshake)        |
//! | `ioUdpDisconnect`   | `connect(AF_UNSPEC)`                               |
//! | `ioUdpOpt`          | broadcast, TTL, multicast TTL/loopback, buffer sizes |
//! | `ioUdpMembership`   | `IP_ADD_MEMBERSHIP` & co. (`addMembership`/`dropMembership`) |
//! | `ioUdpSourceMembership` | `IP_ADD_SOURCE_MEMBERSHIP` & co.               |
//! | `ioUdpMulticastIf`  | `IP_MULTICAST_IF` (`setMulticastInterface`)        |
//!
//! `ioSockName`, `ioPeerName`, `ioClose`, `ioInterest` and `ioPoll` are the
//! parent's and work on a datagram handle unchanged: readiness means the same
//! thing ("a datagram is waiting" / "the send buffer has room"), so the loop
//! needs no second table and no second wait.
//!
//! Every datagram crosses base64 for the reason the parent documents, with one
//! difference from `ioRead`: the result also names the *sender*, so a received
//! datagram is one record `base64 US address US port US family`. It always has
//! the `US` in it, which is how it is told apart from [`AGAIN`] (`+A`) — an
//! empty datagram is `+` `US` `…`, not nothing.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use zun_abi::ZunValue;

use super::*;

/// The largest datagram UDP can carry (65535 minus the 8-byte header and the
/// 20-byte IPv4 header); the receive buffer is one of these so that a datagram
/// is never truncated.
const MAX_DATAGRAM: usize = 65507;

/// `ioUdpBind` flag: `SO_REUSEADDR`.
const BIND_REUSE_ADDR: i64 = 1;
/// `ioUdpBind` flag: `IPV6_V6ONLY`.
const BIND_IPV6_ONLY: i64 = 2;
/// `ioUdpBind` flag: `SO_REUSEPORT`.
const BIND_REUSE_PORT: i64 = 4;

/// The raw socket of a datagram handle, or the `EBADF` failure text.
fn datagram(id: i64, syscall: &str) -> Result<(sys::Raw, bool), String> {
    handle_of(id, syscall, |handle| (handle.raw, handle.ipv6))
}

macro_rules! ret {
    ($out:expr, $text:expr) => {
        // SAFETY: `out` is a writable Str return.
        return unsafe { ret_str($out, &$text) }
    };
}

macro_rules! text_arg {
    ($args:expr, $n:expr, $i:expr) => {
        // SAFETY: the host passes `n` initialized values matching the descriptor.
        match unsafe { arg_str($args, $n, $i) } {
            Ok(value) => value,
            Err(status) => return status,
        }
    };
}

/// `ioUdpOpen(ipv6)` — create the socket; `1` is `udp6`.
unsafe extern "C" fn open(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let ipv6 = unsafe { arg_i64(args, n, 0) } != 0;
    let payload = match open_socket(ipv6) {
        Ok(id) => ok_fields(&[id.to_string()]),
        Err(text) => text,
    };
    ret!(out, payload)
}

/// The `socket` half of `ioUdpOpen`, factored out for the Rust tests.
pub(super) fn open_socket(ipv6: bool) -> Result<i64, String> {
    let raw = sys::udp_socket(ipv6).map_err(|err| fail_io("socket", &err, ""))?;
    let id = publish(raw, Kind::Datagram, false);
    with_table(|table| {
        if let Some(handle) = table.get_mut(&id) {
            handle.ipv6 = ipv6;
        }
    });
    Ok(id)
}

/// `ioUdpBind(handle, address, port, flags)` — bind to an IP literal, answering
/// the address actually bound (which is how `bind(0)` reports its port).
unsafe extern "C" fn bind(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let address = text_arg!(args, n, 1);
    // SAFETY: as above.
    let port = unsafe { arg_i64(args, n, 2) } as u16;
    // SAFETY: as above.
    let flags = unsafe { arg_i64(args, n, 3) };
    let payload = match bind_socket(id, address, port, flags) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn bind_socket(id: i64, address: &str, port: u16, flags: i64) -> Result<String, String> {
    let (raw, ipv6) = datagram(id, "bind")?;
    let ip: IpAddr = match address.parse() {
        Ok(ip) => ip,
        Err(_) => return Err(fail_code("bind", "EINVAL", address)),
    };
    if ip.is_ipv6() != ipv6 {
        return Err(fail_code("bind", "EINVAL", &format!("{address}:{port}")));
    }
    let target = SocketAddr::new(ip, port);
    let where_ = target.to_string();
    if flags & BIND_REUSE_ADDR != 0 {
        let _ = sys::set_reuse_addr(raw, true);
    }
    if flags & BIND_REUSE_PORT != 0 {
        if let Err(err) = sys::set_reuse_port(raw, true) {
            return Err(fail_io("bind", &err, &where_));
        }
    }
    if ipv6 && flags & BIND_IPV6_ONLY != 0 {
        let _ = sys::set_ipv6_only(raw, true);
    }
    sys::bind(raw, &target).map_err(|err| fail_io("bind", &err, &where_))?;
    let bound = sys::local_addr(raw).unwrap_or(target);
    let [address, port, family] = address_fields(&bound);
    Ok(ok_fields(&[address, port, family]))
}

/// `ioUdpSend(handle, address, port, base64)` — one datagram.
///
/// An empty `address` sends on the connected default peer. The answer is the
/// number of bytes sent (a datagram is all or nothing), or [`AGAIN`] when the
/// kernel's send buffer is full.
unsafe extern "C" fn send(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let address = text_arg!(args, n, 1);
    // SAFETY: as above.
    let port = unsafe { arg_i64(args, n, 2) } as u16;
    let encoded = text_arg!(args, n, 3);
    let bytes = base64::decode(encoded);
    let payload = match send_datagram(id, address, port, &bytes) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn send_datagram(
    id: i64,
    address: &str,
    port: u16,
    bytes: &[u8],
) -> Result<String, String> {
    let (raw, _) = datagram(id, "send")?;
    let target = if address.is_empty() {
        None
    } else {
        match address.parse::<IpAddr>() {
            Ok(ip) => Some(SocketAddr::new(ip, port)),
            Err(_) => return Err(fail_code("send", "EINVAL", address)),
        }
    };
    let where_ = target.map(|addr| addr.to_string()).unwrap_or_default();
    match sys::send_to(raw, bytes, target.as_ref()) {
        Ok(None) => Ok(AGAIN.to_owned()),
        Ok(Some(count)) => Ok(ok_fields(&[count.to_string()])),
        Err(err) => Err(fail_io("send", &err, &where_)),
    }
}

/// `ioUdpRecv(handle)` — one datagram and who sent it, or [`AGAIN`].
unsafe extern "C" fn recv(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let payload = match recv_datagram(id) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn recv_datagram(id: i64) -> Result<String, String> {
    let (raw, _) = datagram(id, "recvmsg")?;
    let mut buffer = vec![0u8; MAX_DATAGRAM];
    match sys::recv_from(raw, &mut buffer) {
        Ok(None) => Ok(AGAIN.to_owned()),
        Ok(Some((count, from))) => {
            let [address, port, family] = address_fields(&from);
            Ok(ok_fields(&[base64::encode(&buffer[..count]), address, port, family]))
        }
        Err(err) => Err(fail_io("recvmsg", &err, "")),
    }
}

/// `ioUdpConnect(handle, address, port)` — fix the default peer.
unsafe extern "C" fn connect_peer(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let address = text_arg!(args, n, 1);
    // SAFETY: as above.
    let port = unsafe { arg_i64(args, n, 2) } as u16;
    let payload = match connect_socket(id, address, port) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn connect_socket(id: i64, address: &str, port: u16) -> Result<String, String> {
    let (raw, _) = datagram(id, "connect")?;
    let ip: IpAddr = match address.parse() {
        Ok(ip) => ip,
        Err(_) => return Err(fail_code("connect", "EINVAL", address)),
    };
    let target = SocketAddr::new(ip, port);
    sys::connect(raw, &target).map_err(|err| fail_io("connect", &err, &target.to_string()))?;
    Ok(ok())
}

/// `ioUdpDisconnect(handle)` — drop the default peer.
unsafe extern "C" fn disconnect(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let payload = match datagram(id, "connect") {
        Err(text) => text,
        Ok((raw, _)) => match sys::disconnect(raw) {
            Ok(()) => ok(),
            Err(err) => fail_io("connect", &err, ""),
        },
    };
    ret!(out, payload)
}

/// `ioUdpOpt(handle, name, value)` — the scalar socket options.
///
/// `name` is one of `broadcast`, `ttl`, `multicastTtl`, `multicastLoop`,
/// `recvBuf`, `sendBuf` (set, `value` is the new value) or `getRecvBuf`,
/// `getSendBuf` (get, `value` ignored). The answer is the resulting value.
unsafe extern "C" fn option(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let name = text_arg!(args, n, 1);
    // SAFETY: as above.
    let value = unsafe { arg_i64(args, n, 2) };
    let payload = match set_option(id, name, value) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn set_option(id: i64, name: &str, value: i64) -> Result<String, String> {
    let (raw, ipv6) = datagram(id, "setsockopt")?;
    let int = value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let (level, optname, getter) = match name {
        "broadcast" => (sys::SOL_SOCKET, sys::SO_BROADCAST, false),
        "recvBuf" => (sys::SOL_SOCKET, sys::SO_RCVBUF, false),
        "sendBuf" => (sys::SOL_SOCKET, sys::SO_SNDBUF, false),
        "getRecvBuf" => (sys::SOL_SOCKET, sys::SO_RCVBUF, true),
        "getSendBuf" => (sys::SOL_SOCKET, sys::SO_SNDBUF, true),
        "ttl" if ipv6 => (sys::IPPROTO_IPV6, sys::IPV6_UNICAST_HOPS, false),
        "ttl" => (sys::IPPROTO_IP, sys::IP_TTL, false),
        "multicastTtl" if ipv6 => (sys::IPPROTO_IPV6, sys::IPV6_MULTICAST_HOPS, false),
        "multicastTtl" => (sys::IPPROTO_IP, sys::IP_MULTICAST_TTL, false),
        "multicastLoop" if ipv6 => (sys::IPPROTO_IPV6, sys::IPV6_MULTICAST_LOOP, false),
        "multicastLoop" => (sys::IPPROTO_IP, sys::IP_MULTICAST_LOOP, false),
        _ => return Err(fail_code("setsockopt", "EINVAL", name)),
    };
    if getter {
        let got = sys::udp_get_opt(raw, level, optname)
            .map_err(|err| fail_io("getsockopt", &err, ""))?;
        return Ok(ok_fields(&[got.to_string()]));
    }
    sys::udp_set_opt(raw, level, optname, &int.to_ne_bytes())
        .map_err(|err| fail_io("setsockopt", &err, ""))?;
    Ok(ok_fields(&[int.to_string()]))
}

/// The interface index an IPv6 multicast call names: empty is "the default"
/// (`0`), and `"<anything>%<n>"` or a bare number is the index `<n>`.
fn interface_index(iface: &str) -> u32 {
    let tail = iface.rsplit('%').next().unwrap_or("");
    tail.parse::<u32>().unwrap_or(0)
}

/// `ioUdpMembership(handle, op, group, interface)` — `op` is `1` to join and `0`
/// to leave.
unsafe extern "C" fn membership(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let join = unsafe { arg_i64(args, n, 1) } != 0;
    let group = text_arg!(args, n, 2);
    let iface = text_arg!(args, n, 3);
    let payload = match change_membership(id, join, group, iface) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn change_membership(
    id: i64,
    join: bool,
    group: &str,
    iface: &str,
) -> Result<String, String> {
    let syscall = if join { "addMembership" } else { "dropMembership" };
    let (raw, ipv6) = datagram(id, syscall)?;
    let group_ip: IpAddr = group.parse().map_err(|_| fail_code(syscall, "EINVAL", ""))?;
    let result = match group_ip {
        IpAddr::V4(group) => {
            let interface: Ipv4Addr = if iface.is_empty() {
                Ipv4Addr::UNSPECIFIED
            } else {
                iface.parse().map_err(|_| fail_code(syscall, "EINVAL", ""))?
            };
            if ipv6 {
                return Err(fail_code(syscall, "EINVAL", ""));
            }
            let mut bytes = [0u8; 8];
            bytes[0..4].copy_from_slice(&group.octets());
            bytes[4..8].copy_from_slice(&interface.octets());
            let name = if join { sys::IP_ADD_MEMBERSHIP } else { sys::IP_DROP_MEMBERSHIP };
            sys::udp_set_opt(raw, sys::IPPROTO_IP, name, &bytes)
        }
        IpAddr::V6(group) => {
            if !ipv6 {
                return Err(fail_code(syscall, "EINVAL", ""));
            }
            let mut bytes = [0u8; 20];
            bytes[0..16].copy_from_slice(&group.octets());
            bytes[16..20].copy_from_slice(&interface_index(iface).to_ne_bytes());
            let name = if join { sys::IPV6_ADD_MEMBERSHIP } else { sys::IPV6_DROP_MEMBERSHIP };
            sys::udp_set_opt(raw, sys::IPPROTO_IPV6, name, &bytes)
        }
    };
    result.map_err(|err| fail_io(syscall, &err, ""))?;
    Ok(ok())
}

/// `ioUdpSourceMembership(handle, op, source, group, interface)` — IPv4
/// source-specific multicast.
unsafe extern "C" fn source_membership(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let join = unsafe { arg_i64(args, n, 1) } != 0;
    let source = text_arg!(args, n, 2);
    let group = text_arg!(args, n, 3);
    let iface = text_arg!(args, n, 4);
    let payload = match change_source_membership(id, join, source, group, iface) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn change_source_membership(
    id: i64,
    join: bool,
    source: &str,
    group: &str,
    iface: &str,
) -> Result<String, String> {
    let syscall = if join { "addSourceSpecificMembership" } else { "dropSourceSpecificMembership" };
    let (raw, ipv6) = datagram(id, syscall)?;
    if ipv6 {
        return Err(fail_code(syscall, "ENOTSUP", ""));
    }
    let name = if join { sys::IP_ADD_SOURCE_MEMBERSHIP } else { sys::IP_DROP_SOURCE_MEMBERSHIP };
    if name == 0 {
        return Err(fail_code(syscall, "ENOTSUP", ""));
    }
    let source: Ipv4Addr = source.parse().map_err(|_| fail_code(syscall, "EINVAL", ""))?;
    let group: Ipv4Addr = group.parse().map_err(|_| fail_code(syscall, "EINVAL", ""))?;
    let interface: Ipv4Addr = if iface.is_empty() {
        Ipv4Addr::UNSPECIFIED
    } else {
        iface.parse().map_err(|_| fail_code(syscall, "EINVAL", ""))?
    };
    let bytes = sys::mreq_source(group.octets(), interface.octets(), source.octets());
    sys::udp_set_opt(raw, sys::IPPROTO_IP, name, &bytes)
        .map_err(|err| fail_io(syscall, &err, ""))?;
    Ok(ok())
}

/// `ioUdpMulticastIf(handle, interface)` — pick the outgoing multicast
/// interface (an IPv4 address, or an IPv6 scope index).
unsafe extern "C" fn multicast_interface(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host passes `n` initialized values matching the descriptor.
    let id = unsafe { arg_i64(args, n, 0) };
    let iface = text_arg!(args, n, 1);
    let payload = match set_multicast_interface(id, iface) {
        Ok(text) => text,
        Err(text) => text,
    };
    ret!(out, payload)
}

pub(super) fn set_multicast_interface(id: i64, iface: &str) -> Result<String, String> {
    let (raw, ipv6) = datagram(id, "setMulticastInterface")?;
    let result = if ipv6 {
        // libuv parses the whole text with `uv_ip6_addr` and takes its scope
        // id as the interface index, so a text that is not an IPv6 address
        // (`''`, `'undefined'`) is EINVAL rather than "the default interface".
        let address = iface.split('%').next().unwrap_or("");
        if address.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(fail_code("setMulticastInterface", "EINVAL", ""));
        }
        sys::udp_set_opt(
            raw,
            sys::IPPROTO_IPV6,
            sys::IPV6_MULTICAST_IF,
            &interface_index(iface).to_ne_bytes(),
        )
    } else {
        let interface: Ipv4Addr = iface
            .parse()
            .map_err(|_| fail_code("setMulticastInterface", "EINVAL", ""))?;
        // Linux refuses a multicast address as the outgoing interface with
        // `EADDRNOTAVAIL`; Winsock accepts it silently. Answer the Linux way so
        // the behaviour does not depend on the platform.
        if interface.is_multicast() {
            return Err(fail_code("setMulticastInterface", "EADDRNOTAVAIL", ""));
        }
        sys::udp_set_opt(raw, sys::IPPROTO_IP, sys::IP_MULTICAST_IF, &interface.octets())
    };
    result.map_err(|err| fail_io("setMulticastInterface", &err, ""))?;
    Ok(ok())
}

/// The datagram natives, appended to `node:io`'s table.
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor { key: b"ioUdpOpen\0", params: &[I64], ret: Str, invoke: open },
    Descriptor { key: b"ioUdpBind\0", params: &[I64, Str, I64, I64], ret: Str, invoke: bind },
    Descriptor { key: b"ioUdpSend\0", params: &[I64, Str, I64, Str], ret: Str, invoke: send },
    Descriptor { key: b"ioUdpRecv\0", params: &[I64], ret: Str, invoke: recv },
    Descriptor {
        key: b"ioUdpConnect\0",
        params: &[I64, Str, I64],
        ret: Str,
        invoke: connect_peer,
    },
    Descriptor { key: b"ioUdpDisconnect\0", params: &[I64], ret: Str, invoke: disconnect },
    Descriptor { key: b"ioUdpOpt\0", params: &[I64, Str, I64], ret: Str, invoke: option },
    Descriptor {
        key: b"ioUdpMembership\0",
        params: &[I64, I64, Str, Str],
        ret: Str,
        invoke: membership,
    },
    Descriptor {
        key: b"ioUdpSourceMembership\0",
        params: &[I64, I64, Str, Str, Str],
        ret: Str,
        invoke: source_membership,
    },
    Descriptor {
        key: b"ioUdpMulticastIf\0",
        params: &[I64, Str],
        ret: Str,
        invoke: multicast_interface,
    },
];


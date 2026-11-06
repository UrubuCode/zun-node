//! The POSIX half of `node:dns`: `getaddrinfo(3)`, `getnameinfo(3)` and
//! `/etc/resolv.conf`.

use std::ffi::CString;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use super::Server;
use crate::dns::{
    UV_EAI_AGAIN, UV_EAI_BADFLAGS, UV_EAI_FAIL, UV_EAI_FAMILY, UV_EAI_MEMORY, UV_EAI_NODATA,
    UV_EAI_NONAME, UV_EAI_SERVICE, UV_EAI_SOCKTYPE,
};

/// The three `ai_flags` Node re-exports as `dns.ADDRCONFIG` / `dns.ALL` /
/// `dns.V4MAPPED`. They are the *platform's* values, which is why they cross
/// the ABI instead of being restated in TypeScript.
pub(in crate::dns) const AI_ADDRCONFIG: i64 = libc::AI_ADDRCONFIG as i64;
pub(in crate::dns) const AI_ALL: i64 = libc::AI_ALL as i64;
pub(in crate::dns) const AI_V4MAPPED: i64 = libc::AI_V4MAPPED as i64;

/// Winsock needs an explicit startup call; POSIX does not, so this is a no-op
/// kept so the callers read the same on both platforms.
pub(in crate::dns) fn ensure_network_ready() {}

/// `getaddrinfo(3)` as `uv_getaddrinfo` calls it: `AF_UNSPEC`/`AF_INET`/
/// `AF_INET6` from Node's `family`, `ai_flags` from Node's `hints`, and
/// `SOCK_STREAM` as the socket type so that each address is reported once
/// rather than once per protocol (libuv passes the same, which is what makes
/// `dns.lookup` answer two entries for a dual-stack host and not six).
///
/// Returns the addresses in the order the resolver gave them — the caller
/// applies Node's `DNS_ORDER_*` afterwards, because libuv's own sort is in
/// `cares_wrap.cc` rather than in the syscall.
pub(in crate::dns) fn getaddrinfo(
    hostname: &str,
    family: i32,
    hints: i32,
) -> Result<Vec<IpAddr>, i64> {
    let node = CString::new(hostname).map_err(|_| UV_EAI_NONAME)?;
    let mut request: libc::addrinfo = unsafe { std::mem::zeroed() };
    request.ai_family = match family {
        4 => libc::AF_INET,
        6 => libc::AF_INET6,
        _ => libc::AF_UNSPEC,
    };
    request.ai_socktype = libc::SOCK_STREAM;
    request.ai_flags = hints;

    let mut result: *mut libc::addrinfo = std::ptr::null_mut();
    // SAFETY: `node` is a live NUL-terminated string, `request` a fully
    // initialized `addrinfo`, and `result` an out-pointer we free below.
    let status =
        unsafe { libc::getaddrinfo(node.as_ptr(), std::ptr::null(), &request, &mut result) };
    if status != 0 {
        return Err(translate_eai(status));
    }

    let mut addresses = Vec::new();
    let mut cursor = result;
    while !cursor.is_null() {
        // SAFETY: the list libc returned is well-formed until `freeaddrinfo`.
        let entry = unsafe { &*cursor };
        if let Some(address) = sockaddr_to_ip(entry.ai_addr, entry.ai_addrlen as usize) {
            if !addresses.contains(&address) {
                addresses.push(address);
            }
        }
        cursor = entry.ai_next;
    }
    // SAFETY: `result` came from a successful `getaddrinfo` and is freed once.
    unsafe { libc::freeaddrinfo(result) };
    Ok(addresses)
}

/// `getnameinfo(3)` as `uv_getnameinfo` calls it, with `NI_NAMEREQD`: libuv
/// passes that flag, so an address with no PTR record is an **error** rather
/// than the numeric form echoed back — which is the behavior
/// `test-dns-lookupService-promises.js` asserts for an RFC 5737 address.
pub(in crate::dns) fn getnameinfo(address: SocketAddr) -> Result<(String, String), i64> {
    let mut host = [0i8; libc::NI_MAXHOST as usize];
    let mut service = [0i8; libc::NI_MAXSERV as usize];
    let (storage, length) = socket_addr_to_sockaddr(address);
    // SAFETY: `storage` holds a valid `sockaddr_in`/`sockaddr_in6` of `length`
    // bytes, and both buffers are sized by the platform's own maxima.
    let status = unsafe {
        libc::getnameinfo(
            &storage as *const libc::sockaddr_storage as *const libc::sockaddr,
            length as libc::socklen_t,
            host.as_mut_ptr() as *mut libc::c_char,
            host.len() as libc::socklen_t,
            service.as_mut_ptr() as *mut libc::c_char,
            service.len() as libc::socklen_t,
            libc::NI_NAMEREQD,
        )
    };
    if status != 0 {
        return Err(translate_eai(status));
    }
    Ok((cstr_text(&host), cstr_text(&service)))
}

/// The resolvers in `/etc/resolv.conf`, which is where c-ares' default
/// `ares_init` reads them from on every POSIX platform.
///
/// Only `nameserver` lines are read: `search`, `domain` and `options` shape a
/// *search list*, and Node's `resolve*` family queries the name as given
/// (c-ares' `ndots` handling applies to `ares_search`, which `cares_wrap.cc`
/// does not call).
pub(in crate::dns) fn system_servers() -> Vec<Server> {
    let Ok(text) = std::fs::read_to_string("/etc/resolv.conf") else {
        return Vec::new();
    };
    let mut servers = Vec::new();
    for line in text.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let line = line.split(';').next().unwrap_or("").trim();
        let mut parts = line.split_whitespace();
        if parts.next() != Some("nameserver") {
            continue;
        }
        if let Some(address) = parts.next() {
            // An interface-zone suffix (`fe80::1%eth0`) is c-ares' link-local
            // form; the address alone is what the server list reports.
            let address = address.split('%').next().unwrap_or(address);
            if crate::dns::parse_ip(address).is_some() {
                servers.push(Server { address: address.to_owned(), port: 53 });
            }
        }
    }
    servers
}

/// libuv's `uv__getaddrinfo_translate_error`: the platform's `EAI_*` as libuv's
/// own, which is what Node reports and what `util.getSystemErrorName` names.
fn translate_eai(status: i32) -> i64 {
    match status {
        libc::EAI_AGAIN => UV_EAI_AGAIN,
        libc::EAI_BADFLAGS => UV_EAI_BADFLAGS,
        libc::EAI_FAIL => UV_EAI_FAIL,
        libc::EAI_FAMILY => UV_EAI_FAMILY,
        libc::EAI_MEMORY => UV_EAI_MEMORY,
        libc::EAI_NODATA => UV_EAI_NODATA,
        libc::EAI_NONAME => UV_EAI_NONAME,
        libc::EAI_SERVICE => UV_EAI_SERVICE,
        libc::EAI_SOCKTYPE => UV_EAI_SOCKTYPE,
        _ => UV_EAI_FAIL,
    }
}

fn cstr_text(buffer: &[i8]) -> String {
    let bytes: Vec<u8> = buffer.iter().take_while(|byte| **byte != 0).map(|byte| *byte as u8).collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn sockaddr_to_ip(address: *const libc::sockaddr, length: usize) -> Option<IpAddr> {
    if address.is_null() {
        return None;
    }
    // SAFETY: the caller passes a `sockaddr` of at least `length` bytes.
    let family = unsafe { (*address).sa_family } as i32;
    match family {
        libc::AF_INET if length >= std::mem::size_of::<libc::sockaddr_in>() => {
            // SAFETY: the family says this is a `sockaddr_in` and the length agrees.
            let v4 = unsafe { &*(address as *const libc::sockaddr_in) };
            Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr))))
        }
        libc::AF_INET6 if length >= std::mem::size_of::<libc::sockaddr_in6>() => {
            // SAFETY: as above, for a `sockaddr_in6`.
            let v6 = unsafe { &*(address as *const libc::sockaddr_in6) };
            Some(IpAddr::V6(Ipv6Addr::from(v6.sin6_addr.s6_addr)))
        }
        _ => None,
    }
}

fn socket_addr_to_sockaddr(address: SocketAddr) -> (libc::sockaddr_storage, usize) {
    let mut storage: libc::sockaddr_storage = unsafe { std::mem::zeroed() };
    match address {
        SocketAddr::V4(v4) => {
            // SAFETY: `sockaddr_storage` is large enough for a `sockaddr_in`
            // and correctly aligned for it by definition.
            let slot = unsafe { &mut *(&mut storage as *mut _ as *mut libc::sockaddr_in) };
            slot.sin_family = libc::AF_INET as libc::sa_family_t;
            slot.sin_port = v4.port().to_be();
            slot.sin_addr.s_addr = u32::from(*v4.ip()).to_be();
            (storage, std::mem::size_of::<libc::sockaddr_in>())
        }
        SocketAddr::V6(v6) => {
            // SAFETY: as above, for a `sockaddr_in6`.
            let slot = unsafe { &mut *(&mut storage as *mut _ as *mut libc::sockaddr_in6) };
            slot.sin6_family = libc::AF_INET6 as libc::sa_family_t;
            slot.sin6_port = v6.port().to_be();
            slot.sin6_addr.s6_addr = v6.ip().octets();
            slot.sin6_scope_id = v6.scope_id();
            (storage, std::mem::size_of::<libc::sockaddr_in6>())
        }
    }
}

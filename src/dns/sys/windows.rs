//! The Windows half of `node:dns`: `GetAddrInfoW`, `GetNameInfoW` and the DNS
//! servers `GetAdaptersAddresses` reports.
//!
//! libuv calls the wide entry points (`uv_getaddrinfo` converts the host name
//! to UTF-16 and calls `GetAddrInfoW`) rather than the ANSI ones, because the
//! ANSI forms go through the active code page and cannot carry a non-ASCII
//! name; this module does the same. Both need winsock initialized, which is
//! why [`ensure_network_ready`] exists here and is a no-op on POSIX.

use std::ffi::OsString;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::os::windows::ffi::OsStringExt;
use std::sync::Once;

use windows_sys::Win32::Foundation::{ERROR_BUFFER_OVERFLOW, ERROR_NO_DATA, ERROR_SUCCESS};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_FRIENDLY_NAME,
    GAA_FLAG_SKIP_MULTICAST, GAA_FLAG_SKIP_UNICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows_sys::Win32::Networking::WinSock::{
    FreeAddrInfoW, GetAddrInfoW, GetNameInfoW, WSAStartup, ADDRESS_FAMILY, ADDRINFOW, AF_INET,
    AF_INET6, AF_UNSPEC, NI_MAXHOST, NI_MAXSERV, NI_NAMEREQD, SOCKADDR, SOCKADDR_IN, SOCKADDR_IN6,
    SOCKADDR_STORAGE, SOCK_STREAM, WSADATA, WSAEAFNOSUPPORT, WSAEINVAL, WSAESOCKTNOSUPPORT,
    WSAHOST_NOT_FOUND, WSANO_DATA, WSANO_RECOVERY, WSATRY_AGAIN, WSATYPE_NOT_FOUND,
    WSA_NOT_ENOUGH_MEMORY,
};

use super::Server;
use crate::dns::{
    UV_EAI_AGAIN, UV_EAI_FAIL, UV_EAI_FAMILY, UV_EAI_MEMORY, UV_EAI_NODATA, UV_EAI_NONAME,
    UV_EAI_SERVICE, UV_EAI_SOCKTYPE,
};

/// The three `ai_flags` Node re-exports as `dns.ADDRCONFIG` / `dns.ALL` /
/// `dns.V4MAPPED`. Windows' values differ from glibc's, which is exactly why
/// they cross the ABI rather than being restated in TypeScript.
pub(in crate::dns) const AI_ADDRCONFIG: i64 =
    windows_sys::Win32::Networking::WinSock::AI_ADDRCONFIG as i64;
pub(in crate::dns) const AI_ALL: i64 = windows_sys::Win32::Networking::WinSock::AI_ALL as i64;
pub(in crate::dns) const AI_V4MAPPED: i64 =
    windows_sys::Win32::Networking::WinSock::AI_V4MAPPED as i64;

static WINSOCK: Once = Once::new();

/// `WSAStartup(2.2)`, once per process.
///
/// Every winsock entry point below needs it, and `std::net` runs its own copy
/// behind its own `Once`, so the two are independent and both idempotent. No
/// `WSACleanup` is paired with it on purpose: winsock reference-counts
/// startups, and an extension that cleaned up would tear down the state the
/// host's own sockets rely on.
pub(in crate::dns) fn ensure_network_ready() {
    WINSOCK.call_once(|| {
        let mut data: WSADATA = unsafe { std::mem::zeroed() };
        // SAFETY: `data` is a writable `WSADATA`; the version word is the
        // literal 2.2 encoding winsock expects (low byte major).
        unsafe { WSAStartup(0x0202, &mut data) };
    });
}

/// `GetAddrInfoW` as `uv_getaddrinfo` calls it. See the POSIX twin for why the
/// socket type is pinned to `SOCK_STREAM` and why the result is left in
/// resolver order.
pub(in crate::dns) fn getaddrinfo(
    hostname: &str,
    family: i32,
    hints: i32,
) -> Result<Vec<IpAddr>, i64> {
    ensure_network_ready();
    let node = wide(hostname);
    let mut request: ADDRINFOW = unsafe { std::mem::zeroed() };
    request.ai_family = match family {
        4 => AF_INET as i32,
        6 => AF_INET6 as i32,
        _ => AF_UNSPEC as i32,
    };
    request.ai_socktype = SOCK_STREAM;
    request.ai_flags = hints;

    let mut result: *mut ADDRINFOW = std::ptr::null_mut();
    // SAFETY: `node` is NUL-terminated UTF-16, `request` a fully initialized
    // `ADDRINFOW`, and `result` an out-pointer freed below.
    let status =
        unsafe { GetAddrInfoW(node.as_ptr(), std::ptr::null(), &request, &mut result) };
    if status != 0 {
        return Err(translate_eai(status));
    }

    let mut addresses = Vec::new();
    let mut cursor = result;
    while !cursor.is_null() {
        // SAFETY: winsock returned a well-formed list, live until `FreeAddrInfoW`.
        let entry = unsafe { &*cursor };
        if let Some(address) = sockaddr_to_ip(entry.ai_addr, entry.ai_addrlen) {
            if !addresses.contains(&address) {
                addresses.push(address);
            }
        }
        cursor = entry.ai_next;
    }
    // SAFETY: `result` came from a successful `GetAddrInfoW` and is freed once.
    unsafe { FreeAddrInfoW(result) };
    Ok(addresses)
}

/// `GetNameInfoW` with `NI_NAMEREQD`, which is the flag libuv passes: an
/// address with no PTR record is an error rather than the numeric form echoed
/// back.
pub(in crate::dns) fn getnameinfo(address: SocketAddr) -> Result<(String, String), i64> {
    ensure_network_ready();
    let mut host = [0u16; NI_MAXHOST as usize];
    let mut service = [0u16; NI_MAXSERV as usize];
    let (storage, length) = socket_addr_to_sockaddr(address);
    // SAFETY: `storage` holds a valid sockaddr of `length` bytes and both
    // buffers are sized by winsock's own maxima.
    let status = unsafe {
        GetNameInfoW(
            &storage as *const SOCKADDR_STORAGE as *const SOCKADDR,
            length as i32,
            host.as_mut_ptr(),
            host.len() as u32,
            service.as_mut_ptr(),
            service.len() as u32,
            NI_NAMEREQD as i32,
        )
    };
    if status != 0 {
        return Err(translate_eai(status));
    }
    Ok((wide_text(&host), wide_text(&service)))
}

/// The resolvers Windows reports per adapter, which is where c-ares' Windows
/// `ares_init` reads them from (`ares_sysconfig_win.c` calls
/// `GetAdaptersAddresses` and walks `FirstDnsServerAddress`).
///
/// Duplicates are dropped: the same resolver is normally listed by every
/// adapter, and c-ares' server list is a set. The `::` / `0.0.0.0` placeholders
/// Windows reports for an adapter with no configured server are skipped, as are
/// the `fec0:0:0:ffff::1..3` site-local defaults — c-ares skips those three by
/// name for the same reason (they are never reachable).
pub(in crate::dns) fn system_servers() -> Vec<Server> {
    let flags = GAA_FLAG_SKIP_UNICAST
        | GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST
        | GAA_FLAG_SKIP_FRIENDLY_NAME;
    let mut size: u32 = 15 * 1024;
    let mut buffer: Vec<u8> = Vec::new();

    loop {
        buffer.clear();
        buffer.resize(size as usize, 0);
        // SAFETY: `buffer` holds `size` writable bytes; on overflow the call
        // writes the required size back and we retry.
        let status = unsafe {
            GetAdaptersAddresses(
                AF_UNSPEC as u32,
                flags,
                core::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match status {
            ERROR_SUCCESS => break,
            ERROR_BUFFER_OVERFLOW => continue,
            _ if status == ERROR_NO_DATA => return Vec::new(),
            _ => return Vec::new(),
        }
    }

    let mut out: Vec<Server> = Vec::new();
    let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !adapter.is_null() {
        // SAFETY: `adapter` points into `buffer`, filled as a linked list.
        let current = unsafe { &*adapter };
        adapter = current.Next;

        let mut server = current.FirstDnsServerAddress;
        while !server.is_null() {
            // SAFETY: a non-null node of the adapter's DNS server list.
            let entry = unsafe { &*server };
            server = entry.Next;
            let socket_address = entry.Address.lpSockaddr;
            let Some(address) = sockaddr_to_ip(socket_address, entry.Address.iSockaddrLength as usize)
            else {
                continue;
            };
            if is_placeholder(address) {
                continue;
            }
            let text = address.to_string();
            if out.iter().any(|known| known.address == text) {
                continue;
            }
            out.push(Server { address: text, port: 53 });
        }
    }
    out
}

/// The addresses Windows reports as "no resolver here": the two wildcards and
/// c-ares' three site-local defaults.
fn is_placeholder(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => v4.is_unspecified(),
        IpAddr::V6(v6) => {
            if v6.is_unspecified() {
                return true;
            }
            let segments = v6.segments();
            segments[0] == 0xfec0
                && segments[1] == 0
                && segments[2] == 0
                && segments[3] == 0xffff
                && segments[4] == 0
                && segments[5] == 0
                && segments[6] == 0
                && (1..=3).contains(&segments[7])
        }
    }
}

/// libuv's `uv__getaddrinfo_translate_error`, Windows arm: a winsock error as
/// libuv's own `EAI_*`.
fn translate_eai(status: i32) -> i64 {
    match status {
        WSATRY_AGAIN => UV_EAI_AGAIN,
        WSAEINVAL => UV_EAI_FAIL,
        WSANO_RECOVERY => UV_EAI_FAIL,
        WSAEAFNOSUPPORT => UV_EAI_FAMILY,
        WSA_NOT_ENOUGH_MEMORY => UV_EAI_MEMORY,
        WSANO_DATA => UV_EAI_NODATA,
        WSAHOST_NOT_FOUND => UV_EAI_NONAME,
        WSATYPE_NOT_FOUND => UV_EAI_SERVICE,
        WSAESOCKTNOSUPPORT => UV_EAI_SOCKTYPE,
        _ => UV_EAI_FAIL,
    }
}

fn wide(text: &str) -> Vec<u16> {
    let mut encoded: Vec<u16> = text.encode_utf16().collect();
    encoded.push(0);
    encoded
}

fn wide_text(buffer: &[u16]) -> String {
    let length = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    OsString::from_wide(&buffer[..length]).to_string_lossy().into_owned()
}

fn sockaddr_to_ip(address: *const SOCKADDR, length: usize) -> Option<IpAddr> {
    if address.is_null() {
        return None;
    }
    // SAFETY: the caller passes a `sockaddr` of at least `length` bytes.
    let family: ADDRESS_FAMILY = unsafe { (*address).sa_family };
    if family == AF_INET && length >= std::mem::size_of::<SOCKADDR_IN>() {
        // SAFETY: the family says this is a `SOCKADDR_IN`.
        let v4 = unsafe { &*(address as *const SOCKADDR_IN) };
        // SAFETY: `S_un` is a union over the four octets and the u32 form.
        let octets = unsafe { v4.sin_addr.S_un.S_un_b };
        return Some(IpAddr::V4(Ipv4Addr::new(octets.s_b1, octets.s_b2, octets.s_b3, octets.s_b4)));
    }
    if family == AF_INET6 && length >= std::mem::size_of::<SOCKADDR_IN6>() {
        // SAFETY: as above, for a `SOCKADDR_IN6`.
        let v6 = unsafe { &*(address as *const SOCKADDR_IN6) };
        // SAFETY: `u` is a union over the sixteen bytes and the word forms.
        let bytes = unsafe { v6.sin6_addr.u.Byte };
        return Some(IpAddr::V6(Ipv6Addr::from(bytes)));
    }
    None
}

fn socket_addr_to_sockaddr(address: SocketAddr) -> (SOCKADDR_STORAGE, usize) {
    let mut storage: SOCKADDR_STORAGE = unsafe { std::mem::zeroed() };
    match address {
        SocketAddr::V4(v4) => {
            // SAFETY: `SOCKADDR_STORAGE` is large enough and aligned for a
            // `SOCKADDR_IN` by definition.
            let slot = unsafe { &mut *(&mut storage as *mut _ as *mut SOCKADDR_IN) };
            slot.sin_family = AF_INET;
            slot.sin_port = v4.port().to_be();
            slot.sin_addr.S_un.S_addr = u32::from(*v4.ip()).to_be();
            (storage, std::mem::size_of::<SOCKADDR_IN>())
        }
        SocketAddr::V6(v6) => {
            // SAFETY: as above, for a `SOCKADDR_IN6`.
            let slot = unsafe { &mut *(&mut storage as *mut _ as *mut SOCKADDR_IN6) };
            slot.sin6_family = AF_INET6;
            slot.sin6_port = v6.port().to_be();
            slot.sin6_addr.u.Byte = v6.ip().octets();
            slot.Anonymous.sin6_scope_id = v6.scope_id();
            (storage, std::mem::size_of::<SOCKADDR_IN6>())
        }
    }
}

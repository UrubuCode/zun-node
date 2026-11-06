//! `node:dns`' two system-resolver entry points: the natives behind
//! `dns.lookup()` and `dns.lookupService()`.
//!
//! These stand in for Node's `cares.getaddrinfo` / `cares.getnameinfo`, which
//! are `uv_getaddrinfo` / `uv_getnameinfo`, which are the platform's own
//! resolver — not c-ares. That distinction is the whole reason `dns.lookup` and
//! `dns.resolve4` can disagree about a name: `lookup` consults `/etc/hosts`,
//! NSS or the Windows NRPT stack, while `resolve4` asks a DNS server directly.

use std::net::IpAddr;

use zun_abi::ZunValue;

use super::{
    failed, ok_fields, ok_records, parse_socket_addr, sys, DNS_ORDER_IPV4_FIRST,
    DNS_ORDER_IPV6_FIRST, UV_EAI_NONAME,
};
use crate::abi::{arg_i64, arg_str, ret_str};

/// `dnsGetaddrinfo(hostname, family, hints, order)`.
///
/// The result is one record per address, a single field each — Node's binding
/// hands `lib/dns.js` a flat array of address strings and nothing else, and
/// `onlookup` derives each `family` from the string with `isIP`, so there is
/// nothing more to carry.
///
/// `order` applies Node's own sort, not the resolver's: `cares_wrap.cc` calls
/// `uv_getaddrinfo` and then reorders the list itself, which is why
/// `DNS_ORDER_VERBATIM` means "leave the resolver's order alone". The two
/// family-first orders are **stable** partitions, as Node's
/// `std::stable_sort` over the address family is.
pub(crate) unsafe extern "C" fn getaddrinfo(
    args: *const ZunValue,
    count: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host passes `count` initialized values matching the
    // descriptor's `[Str, I64, I64, I64]` parameter list.
    let hostname = match unsafe { arg_str(args, count, 0) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above, for the three integer arguments.
    let family = unsafe { arg_i64(args, count, 1) } as i32;
    // SAFETY: as above.
    let hints = unsafe { arg_i64(args, count, 2) } as i32;
    // SAFETY: as above.
    let order = unsafe { arg_i64(args, count, 3) };

    let payload = match sys::getaddrinfo(hostname, family, hints) {
        Ok(mut addresses) => {
            if addresses.is_empty() {
                // libuv reports an empty list as `EAI_NONAME`; the host name
                // resolved to nothing usable, which Node fabricates into
                // `ENOTFOUND`.
                failed(&UV_EAI_NONAME.to_string())
            } else {
                sort_addresses(&mut addresses, order);
                let records: Vec<Vec<String>> = addresses
                    .into_iter()
                    .map(|address| vec![super::ip_text(address)])
                    .collect();
                ok_records(&records)
            }
        }
        Err(errno) => failed(&errno.to_string()),
    };
    // SAFETY: `out` is the host's writable return slot.
    unsafe { ret_str(out, &payload) }
}

/// Node's `DNS_ORDER_*` as a stable partition by address family.
fn sort_addresses(addresses: &mut [IpAddr], order: i64) {
    let ipv4_first = order == DNS_ORDER_IPV4_FIRST;
    let ipv6_first = order == DNS_ORDER_IPV6_FIRST;
    if !ipv4_first && !ipv6_first {
        return;
    }
    addresses.sort_by_key(|address| match (address, ipv4_first) {
        (IpAddr::V4(_), true) => 0,
        (IpAddr::V4(_), false) => 1,
        (IpAddr::V6(_), true) => 1,
        (IpAddr::V6(_), false) => 0,
    });
}

/// `dnsGetnameinfo(address, port)` — one record of two fields, the host name
/// and the service name, which is exactly what Node's `onlookupservice`
/// receives.
///
/// A malformed address is `UV_EINVAL` rather than an `EAI_*`: the TS layer has
/// already run `isIP` over it (a non-IP is `ERR_INVALID_ARG_VALUE` before the
/// call), so reaching here with one at all means the two disagree, and `EINVAL`
/// says so instead of claiming the name does not exist.
pub(crate) unsafe extern "C" fn getnameinfo(
    args: *const ZunValue,
    count: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host passes `count` initialized values matching `[Str, I64]`.
    let address = match unsafe { arg_str(args, count, 0) } {
        Ok(value) => value,
        Err(status) => return status,
    };
    // SAFETY: as above, for the port.
    let port = unsafe { arg_i64(args, count, 1) };

    let payload = match parse_socket_addr(address, port as u16) {
        None => failed(&super::uv_einval().to_string()),
        Some(socket) => match sys::getnameinfo(socket) {
            Ok((hostname, service)) => ok_fields(&[hostname, service]),
            Err(errno) => failed(&errno.to_string()),
        },
    };
    // SAFETY: `out` is the host's writable return slot.
    unsafe { ret_str(out, &payload) }
}

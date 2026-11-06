//! `node:dns` — the name-resolution syscalls and the DNS wire protocol behind
//! Node's `dns` module, as a native `zun_abi` extension.
//!
//! # TS over natives
//!
//! `dns` is the sixth module in this library written as an extension *and* Zun
//! TypeScript, and the seam is drawn exactly where Node draws it between
//! `lib/dns.js` and `src/cares_wrap.cc`:
//!
//! - *This* crate answers what needs the operating system or the network. The
//!   system resolver (`getaddrinfo`/`getnameinfo`, which read `/etc/hosts`, the
//!   NSS/NRPT stack, mDNS and the per-interface search lists — none of which is
//!   expressible in the language), the machine's configured resolvers, and the
//!   DNS wire protocol itself: a UDP/TCP query against a chosen server and the
//!   parse of its answer section.
//! - [`crate::dns`]'s counterpart `src/dns/dns.ts` is the Node-shaped module:
//!   the `Resolver` classes, `isIP`, the `setServers` address grammar, the
//!   argument validation, `DNSException` and the two module objects (`dns` and
//!   `dns/promises`).
//!
//! The TS layer reaches these descriptors with
//! `import * as __dnsNative from "node:dns"`.
//!
//! # Why a hand-written DNS client
//!
//! Node's `resolve*` family is c-ares, not the system resolver: it talks to the
//! servers `dns.setServers()` names and returns whole records (`MX` priorities,
//! `SOA` serials, `TXT` chunk arrays), which `getaddrinfo` cannot express. So a
//! stub resolver is genuinely needed, and there were two ways to get one.
//!
//! `hickory-resolver` is the obvious crate, but even in its blocking mode it
//! pulls a `tokio` reactor, `futures`, `rustls`/`ring` and roughly ninety
//! transitive crates into an extension whose whole premise (PLAN.md principle
//! 2) is that it carries no runtime of its own. What this module actually needs
//! is far narrower than a resolver library: one question per query, no cache, no
//! DNSSEC, no connection pooling, and a server list that the *caller* owns
//! because `dns.setServers()` is part of the observable API. That is a few
//! hundred lines of wire format over `std::net`, which is what [`resolve`] is —
//! zero new dependencies, and the record shapes are written against the same
//! RFCs Node's own `cares_wrap.cc` parses.
//!
//! # What crosses the boundary
//!
//! ABI v1 carries one scalar word per value, so every structured result crosses
//! as **one status-prefixed, separator-delimited string**, in the same grammar
//! `node:os` fixed (documented in `lib.rs`):
//!
//! ```text
//! result  := "+" payload | "-" error
//! payload := record (RS record)*
//! record  := field (US field)*
//! RS = U+001E     US = U+001F
//! ```
//!
//! The one difference from `node:os` is what follows the `"-"`. A `node:os`
//! failure is a `SystemError` the TS layer reads out of the per-thread error
//! slots; a `dns` failure is a *value Node's own binding returns*, because
//! `lib/dns.js` receives an integer from `cares.getaddrinfo` and a c-ares code
//! string from a query callback and turns either into a `DNSException`
//! (`internal/errors.js` switches on `typeof code === 'number'`). So the error
//! payload here is that value verbatim: a libuv errno for the two `getaddrinfo`
//! entry points and a c-ares code name (`ENOTFOUND`, `ESERVFAIL`, …) for a
//! query. The TS layer hands it straight to its `DNSException`, which keeps the
//! two-shaped contract Node's module is written against instead of inventing a
//! third.
//!
//! Failure is reported in band for the reason `node:os` documents: an error
//! thrown out of an extension call is not usefully catchable in the host today
//! (<https://github.com/UrubuCode/zun/issues/33>).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::Descriptor;
use zun_abi::ZunTy::{I64, Str};

mod addrinfo;
mod config;
mod resolve;
mod sys;

#[cfg(test)]
mod tests;

/// Unit separator: between the fields of one record.
pub(super) const US: char = '\u{1f}';
/// Record separator: between records.
pub(super) const RS: char = '\u{1e}';
/// The in-band failure marker.
pub(super) const FAILED: &str = "-";

/// Encode a successful multi-record payload (`"+"` and the records).
pub(super) fn ok_records<R: AsRef<[String]>>(records: &[R]) -> String {
    let mut out = String::from("+");
    for (index, record) in records.iter().enumerate() {
        if index > 0 {
            out.push(RS);
        }
        for (field_index, field) in record.as_ref().iter().enumerate() {
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
    ok_records(&[fields.to_vec()])
}

/// Encode an in-band failure: `"-"` followed by the value Node's binding would
/// have returned (a libuv errno, or a c-ares code name).
pub(super) fn failed(error: &str) -> String {
    let mut out = String::from(FAILED);
    out.push_str(error);
    out
}

/// libuv reports `-errno` where the platform has an errno and a value out of
/// its own reserved range where it does not, which is Windows. See
/// `include/uv/errno.h`; the mirror of this table on the TS side is
/// `__UV_ERRNO_TABLE` in `src/util/util.ts`, which `util.getSystemErrorName`
/// reads to turn one of these back into a code name.
#[allow(unused_variables)]
pub(super) const fn uv_errno(posix: i64, windows: i64) -> i64 {
    #[cfg(windows)]
    {
        windows
    }
    #[cfg(not(windows))]
    {
        -posix
    }
}

/// The `EAI_*` half of libuv's error space, which is platform-independent
/// because libuv translates every system `EAI_*` into it
/// (`uv__getaddrinfo_translate_error`). These are the values Node's
/// `cares.getaddrinfo` returns and the ones `internal/errors.js` special-cases
/// into the fabricated `ENOTFOUND`.
pub(super) const UV_EAI_AGAIN: i64 = -3001;
// Only the POSIX translation table names this one: winsock has no
// `WSA`-spelled counterpart of `EAI_BADFLAGS`, so the Windows build never maps
// anything to it.
#[cfg_attr(windows, allow(dead_code))]
pub(super) const UV_EAI_BADFLAGS: i64 = -3002;
pub(super) const UV_EAI_FAIL: i64 = -3004;
pub(super) const UV_EAI_FAMILY: i64 = -3005;
pub(super) const UV_EAI_MEMORY: i64 = -3006;
pub(super) const UV_EAI_NODATA: i64 = -3007;
pub(super) const UV_EAI_NONAME: i64 = -3008;
pub(super) const UV_EAI_SERVICE: i64 = -3010;
pub(super) const UV_EAI_SOCKTYPE: i64 = -3011;

/// `UV_EINVAL`, the one non-`EAI_` errno these entry points can report (a
/// malformed address handed to `getnameinfo`).
pub(super) fn uv_einval() -> i64 {
    uv_errno(22, -4071)
}

/// Node's `cares.DNS_ORDER_*`, the three values `lib/dns.js` passes as
/// `getaddrinfo`'s fifth argument. They are an enum in `cares_wrap.cc`, so the
/// numbers matter only in that both sides agree; the TS layer takes them from
/// [`constants`] rather than restating them.
pub(super) const DNS_ORDER_VERBATIM: i64 = 0;
pub(super) const DNS_ORDER_IPV4_FIRST: i64 = 1;
pub(super) const DNS_ORDER_IPV6_FIRST: i64 = 2;

/// Format one resolved address the way Node's `AddrInfoToStrings` does:
/// `uv_ip4_name`/`uv_ip6_name`, which is `inet_ntop`, which for IPv6 is the
/// RFC 5952 compressed form. [`Ipv6Addr`]'s `Display` is that same form, so
/// `std` answers it exactly.
pub(super) fn ip_text(address: IpAddr) -> String {
    address.to_string()
}

/// Parse a presentation-form address, accepting only what `inet_pton` accepts
/// (no interface zone, no trailing text) — the same bar `isIP` holds on the TS
/// side, so a value that reached here has already passed it.
pub(super) fn parse_ip(text: &str) -> Option<IpAddr> {
    text.parse::<Ipv4Addr>()
        .map(IpAddr::V4)
        .or_else(|_| text.parse::<Ipv6Addr>().map(IpAddr::V6))
        .ok()
}

/// A `SocketAddr` from an address text and a port, for the two entry points
/// that take them separately (`getnameinfo` and a server in the query list).
pub(super) fn parse_socket_addr(text: &str, port: u16) -> Option<SocketAddr> {
    parse_ip(text).map(|address| SocketAddr::new(address, port))
}

/// `dnsConstants()` — the platform's `AI_*` flag values and the three
/// `DNS_ORDER_*` enumerators, as one record.
///
/// `dns.ADDRCONFIG` / `dns.ALL` / `dns.V4MAPPED` are Node's re-exports of the
/// *system's* `AI_*` constants (`cares.AI_ADDRCONFIG` and friends), and those
/// differ between platforms — 0x0400/0x0100/0x0800 on Windows against
/// 0x0020/0x0010/0x0008 on glibc. A program that ors them together and hands
/// the result back to `lookup()` therefore has to be given the same numbers the
/// resolver will be called with, which is why they cross from here rather than
/// being restated in TypeScript.
unsafe extern "C" fn constants(
    _: *const zun_abi::ZunValue,
    _: usize,
    out: *mut zun_abi::ZunValue,
) -> i32 {
    let fields = vec![
        sys::AI_ADDRCONFIG.to_string(),
        sys::AI_ALL.to_string(),
        sys::AI_V4MAPPED.to_string(),
        DNS_ORDER_VERBATIM.to_string(),
        DNS_ORDER_IPV4_FIRST.to_string(),
        DNS_ORDER_IPV6_FIRST.to_string(),
    ];
    unsafe { crate::abi::ret_str(out, &ok_fields(&fields)) }
}

/// The `node:dns` functions published to the host.
///
/// Every key is `dns`-prefixed. That is not style: the checker rejects a
/// program whenever one function *name* is registered by two modules, even
/// through namespace imports that already name the module
/// (<https://github.com/UrubuCode/zun/issues/35>), so a module added to this
/// library has to pick keys no other module uses — which is also why the error
/// readers below are `dnsError*` rather than the `lastError*` of `node:fs`.
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor { key: b"dnsConstants\0", params: &[], ret: Str, invoke: constants },
    // The system resolver (addrinfo.rs).
    Descriptor {
        key: b"dnsGetaddrinfo\0",
        params: &[Str, I64, I64, I64],
        ret: Str,
        invoke: addrinfo::getaddrinfo,
    },
    Descriptor {
        key: b"dnsGetnameinfo\0",
        params: &[Str, I64],
        ret: Str,
        invoke: addrinfo::getnameinfo,
    },
    // The machine's configured resolvers (config.rs).
    Descriptor {
        key: b"dnsSystemServers\0",
        params: &[],
        ret: Str,
        invoke: config::system_servers,
    },
    // One DNS question against a chosen server list (resolve.rs).
    Descriptor {
        key: b"dnsQuery\0",
        params: &[Str, Str, Str, I64, I64],
        ret: Str,
        invoke: resolve::query,
    },
    // Error retrieval, on the ABI v1 error-slot convention (see lib.rs). These
    // carry the *description* of a transport failure, which Node does not
    // expose on a `DNSException` but which makes a failed query diagnosable.
    Descriptor { key: b"dnsErrorCode\0", params: &[], ret: Str, invoke: crate::last_error_code },
    Descriptor {
        key: b"dnsErrorMessage\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_message,
    },
];

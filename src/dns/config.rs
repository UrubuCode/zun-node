//! The machine's resolver configuration — what c-ares' `ares_init` discovers
//! and what `dns.getServers()` reports before anything calls
//! `dns.setServers()`.

use zun_abi::ZunValue;

use super::{ok_records, sys};
use crate::abi::ret_str;

/// c-ares' fallback when the platform reports no resolver at all
/// (`ares_sysconfig.c`: an empty server list becomes the loopback address).
/// It matters for the corpus as well as for correctness — Node's own
/// `test-dns.js` opens with `assert(dns.getServers().length > 0)`.
const LOOPBACK: &str = "127.0.0.1";

/// `dnsSystemServers()` — one record per resolver, `address US port`.
///
/// Never an error: a machine with no configured resolver reports the loopback,
/// exactly as c-ares does, so the TS layer has a server list from the moment a
/// `Resolver` is constructed.
pub(crate) unsafe extern "C" fn system_servers(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let mut servers = sys::system_servers();
    if servers.is_empty() {
        servers.push(sys::Server { address: LOOPBACK.to_owned(), port: 53 });
    }
    let records: Vec<Vec<String>> = servers
        .into_iter()
        .map(|server| vec![server.address, server.port.to_string()])
        .collect();
    // SAFETY: `out` is the host's writable return slot.
    unsafe { ret_str(out, &ok_records(&records)) }
}

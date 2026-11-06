//! `node:os` interface addresses — libuv's `uv_interface_addresses`.

use zun_abi::ZunValue;

use super::{fail_io, ok_records, sys};
use crate::abi::ret_str;

/// `os.networkInterfaces()`.
///
/// One record per *address* (not per interface), seven fields each, in the
/// order Node's own flat `getInterfaceAddresses()` array uses: name, address,
/// netmask, family, mac, internal, scopeid. The TS layer groups the records by
/// name into the object Node returns, and drops `scopeid` when it is `-1`,
/// which is the sentinel Node uses for an IPv4 entry.
///
/// A machine with no reportable interface yields the payload `"+"` — an empty
/// record list, which is an empty object rather than a failure.
pub(crate) unsafe extern "C" fn network_interfaces(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::interface_addresses() {
        Ok(addresses) => {
            let records: Vec<Vec<String>> = addresses
                .into_iter()
                .map(|address| {
                    vec![
                        address.name,
                        address.address,
                        address.netmask,
                        address.family.to_owned(),
                        address.mac,
                        if address.internal { "1" } else { "0" }.to_owned(),
                        address.scopeid.to_string(),
                    ]
                })
                .collect();
            ok_records(&records)
        }
        Err(err) => fail_io("uv_interface_addresses", &err),
    };
    unsafe { ret_str(out, &payload) }
}

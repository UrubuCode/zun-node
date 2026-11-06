//! `node:os` identity facts: the host name, `uname`, the home directory, and
//! the three compile-time facts (`arch`, `platform`, endianness) that the TS
//! layer has no other honest way to learn.
//!
//! Every function here is an ABI wrapper: it calls one `sys` function and
//! encodes the result in the status-prefixed grammar documented in
//! `super`. The behavior lives in `sys`.

use zun_abi::ZunValue;

use super::{fail_io, ok_fields, ok_one, sys};
use crate::abi::{ret_bool, ret_i64, ret_str};

/// `os.hostname()` — libuv's `uv_os_gethostname`.
pub(crate) unsafe extern "C" fn hostname(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let payload = match sys::hostname() {
        Ok(name) => ok_one(&name),
        Err(err) => fail_io("uv_os_gethostname", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `os.type()` / `version()` / `release()` / `machine()` in one call — libuv's
/// `uv_os_uname`.
///
/// Node reads all four from a single `getOSInformation()` at module load and
/// serves each from that snapshot, because `uname` does not change while a
/// process runs. The four fields therefore cross as one record, in Node's own
/// order: type, version, release, machine.
pub(crate) unsafe extern "C" fn os_info(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let payload = match sys::os_info() {
        Ok(info) => ok_fields(&[info.sysname, info.version, info.release, info.machine]),
        Err(err) => fail_io("uv_os_uname", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `os.homedir()` — libuv's `uv_os_homedir`.
pub(crate) unsafe extern "C" fn homedir(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let payload = match sys::homedir() {
        Ok(path) => ok_one(&path),
        Err(err) => fail_io("uv_os_homedir", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `process.arch`, which `os.arch()` returns verbatim. Infallible, so it
/// carries no status prefix.
pub(crate) unsafe extern "C" fn arch(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    unsafe { ret_str(out, sys::arch()) }
}

/// `process.platform`, which `os.platform()` returns verbatim. Infallible.
pub(crate) unsafe extern "C" fn platform(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    unsafe { ret_str(out, sys::platform()) }
}

/// The `isBigEndian` flag behind `os.endianness()`. Infallible.
pub(crate) unsafe extern "C" fn is_big_endian(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    unsafe { ret_bool(out, sys::is_big_endian()) }
}

/// `process.pid` — libuv's `uv_os_getpid`.
///
/// Not part of Node's `os` surface: Node's `process.pid` comes from the process
/// binding. It is published here because it is unambiguously an operating-system
/// fact of exactly this module's kind, and because `zun:core`'s host surface
/// does not report it, which leaves `src/process/process.ts` guessing. The
/// bridge is one line in `src/os/os.ts`, marked there.
pub(crate) unsafe extern "C" fn pid(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    unsafe { ret_i64(out, sys::pid()) }
}

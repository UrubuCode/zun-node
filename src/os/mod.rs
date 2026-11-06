//! `node:os` — the operating-system facts behind Node's `os` module, as a
//! native `zun_abi` extension.
//!
//! # TS over natives
//!
//! `os` is the first module in this library that is **both kinds at once**, and
//! the split is the point:
//!
//! - *This* crate answers only what needs the kernel — the hostname, the CPU
//!   table, memory and uptime, the interface addresses, the passwd entry, the
//!   scheduling priority, `uname`. Every one of those is a syscall, so by
//!   PLAN.md principle 2 it belongs behind the ABI.
//! - `src/os/os.ts` is the Node-shaped module: the objects and arrays, the
//!   `constants` tables, `EOL` and `devNull`, the argument validation, the
//!   `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` / `ERR_SYSTEM_ERROR` errors,
//!   the `tmpdir()` environment rules and the CIDR arithmetic. None of that is
//!   a syscall, and all of it is shape that would be miserable to marshal.
//!
//! The TS layer reaches the natives with `import * as native from "node:os"`,
//! which the host resolves to the descriptors in [`DESCRIPTORS`] through its
//! existing external-call dispatch. `fs` will take the same route when its
//! Node-API shaping lands, which is why the carrier convention below is
//! written as a general rule rather than an `os` detail.
//!
//! # What crosses the boundary
//!
//! ABI v1 carries one scalar word per value, so nothing structured can cross
//! as a structure. Facts that are a single scalar stay typed (`totalmem` is an
//! `F64`, `availableParallelism` an `I64`, `isBigEndian` a `Bool`). Everything
//! else — the CPU table, the interface list, the passwd entry, `uname`, the
//! load average — crosses as **one status-prefixed, separator-delimited
//! string** that the TS layer splits, in the grammar documented in `lib.rs`:
//!
//! ```text
//! result  := "+" payload | "-"
//! payload := record (RS record)*
//! record  := field (US field)*
//! RS = U+001E     US = U+001F
//! ```
//!
//! Two properties earn that choice over the obvious alternatives. Against a
//! JSON blob: no quoting or escaping is needed, so neither side can disagree
//! about it, and a CPU model containing `"` or `\` cannot corrupt the frame.
//! Against one native call per field (`cpuModel(i)`, `cpuSpeed(i)`, …): the
//! whole table is captured in a single syscall, so the rows are a consistent
//! snapshot rather than a sample smeared across 8 × N calls — which matters
//! precisely because the CPU times move while they are being read.
//!
//! The separators are C0 control characters, which cannot occur in a host
//! name, an interface friendly name, a CPU model string, a path or a shell,
//! and are not NUL, so they survive the NUL-terminated `Str` carrier intact.
//!
//! # Failure
//!
//! A `node:os` native never returns a non-zero status, even though the ABI has
//! one: an exception thrown out of an extension call **escapes an enclosing
//! `try`/`catch`** in the host today (the interpreter pushes the hook's
//! `Err(Thrown)` straight out instead of routing it to the handler, as it does
//! for a managed call — see `crates/zun_interp/src/lib.rs`'s `MemberRef` arm,
//! https://github.com/UrubuCode/zun/issues/33),
//! so a failing native would be unrecoverable rather than an
//! `ERR_SYSTEM_ERROR`. Failure is
//! reported in band as the single-character result `"-"`, with the Node
//! `SystemError` fields in the per-thread error slots, which the TS layer reads
//! through `errorSyscall` / `errorCode` / `errorErrno` / `errorMessage` and
//! raises as a proper `SystemError`.
//!
//! Behavior is defined by Node.js 25, whose `os` is a thin layer over libuv, so
//! each native documents the libuv function it stands in for and follows it
//! where the two could differ (the Windows priority-class mapping, the
//! `ProductName` "Windows 10" → "Windows 11" fixup, the `/proc` sources for the
//! Linux CPU table, the `OperStatus`/`PhysicalAddressLength` rules for the
//! interface list). The acceptance bar is Node's own `test-os*.js` suite — see
//! `../../test/os/`.

use std::io;

use crate::Descriptor;
use zun_abi::ZunTy::{Bool, F64, I64, Str};

mod facts;
mod net;
mod stats;
mod sys;
mod user;

#[cfg(test)]
mod tests;

/// Unit separator: between the fields of one record.
pub(super) const US: char = '\u{1f}';
/// Record separator: between records.
pub(super) const RS: char = '\u{1e}';

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
    ok_records(std::slice::from_ref(&fields.to_vec()))
}

/// Encode a successful single-field payload.
pub(super) fn ok_one(field: &str) -> String {
    let mut out = String::from("+");
    out.push_str(field);
    out
}

/// The in-band failure marker. The caller has already stashed the error.
pub(super) const FAILED: &str = "-";

/// Node's `(code, description)` pair for a libuv error, plus the libuv errno.
/// The description is libuv's own `uv_strerror` text, because Node splices it
/// into the `SystemError` message verbatim.
fn uv_error(code: &'static str) -> (&'static str, &'static str, i64) {
    match code {
        "EACCES" => (code, "permission denied", uv_errno(13, -4092)),
        "EAGAIN" => (code, "resource temporarily unavailable", uv_errno(11, -4088)),
        "EINVAL" => (code, "invalid argument", uv_errno(22, -4071)),
        "EIO" => (code, "i/o error", uv_errno(5, -4070)),
        "ENOBUFS" => (code, "no buffer space available", uv_errno(105, -4060)),
        "ENOENT" => (code, "no such file or directory", uv_errno(2, -4058)),
        "ENOMEM" => (code, "not enough memory", uv_errno(12, -4057)),
        "ENOSYS" => (code, "function not implemented", uv_errno(38, -4054)),
        "EPERM" => (code, "operation not permitted", uv_errno(1, -4048)),
        "ESRCH" => (code, "no such process", uv_errno(3, -4040)),
        _ => ("UNKNOWN", "unknown error", -4094),
    }
}

/// libuv reports `-errno` where the platform has an errno and a value out of
/// its own reserved range where it does not, which is Windows. See
/// `include/uv/errno.h`.
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

/// Stash a failure described by a libuv error code, and return [`FAILED`].
pub(super) fn fail_code(syscall: &str, code: &'static str) -> String {
    let (code, description, errno) = uv_error(code);
    crate::abi::fail_system(syscall, code, errno, description);
    FAILED.to_owned()
}

/// Stash a failure described by an [`io::Error`], mapping the platform error to
/// the libuv code Node would report, and return [`FAILED`].
pub(super) fn fail_io(syscall: &str, err: &io::Error) -> String {
    fail_code(syscall, sys::uv_code_of(err))
}

/// A number as the payload text. `{}` on an `f64` is Rust's shortest
/// round-tripping form, so the TS side's `Number(field)` recovers the exact
/// same double.
pub(super) fn num(value: f64) -> String {
    format!("{value}")
}

/// The `node:os` functions published to the host, grouped by submodule. Keys
/// are the names `src/os/os.ts` calls through its `node:os` namespace import.
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    // identity and locations (facts.rs)
    Descriptor { key: b"hostname\0", params: &[], ret: Str, invoke: facts::hostname },
    Descriptor { key: b"osInfo\0", params: &[], ret: Str, invoke: facts::os_info },
    Descriptor { key: b"homedir\0", params: &[], ret: Str, invoke: facts::homedir },
    Descriptor { key: b"arch\0", params: &[], ret: Str, invoke: facts::arch },
    Descriptor { key: b"platform\0", params: &[], ret: Str, invoke: facts::platform },
    Descriptor { key: b"isBigEndian\0", params: &[], ret: Bool, invoke: facts::is_big_endian },
    Descriptor { key: b"pid\0", params: &[], ret: I64, invoke: facts::pid },
    // memory, time and processors (stats.rs)
    Descriptor { key: b"totalmem\0", params: &[], ret: F64, invoke: stats::totalmem },
    Descriptor { key: b"freemem\0", params: &[], ret: F64, invoke: stats::freemem },
    Descriptor { key: b"availableParallelism\0", params: &[], ret: I64, invoke: stats::available_parallelism },
    Descriptor { key: b"uptime\0", params: &[], ret: Str, invoke: stats::uptime },
    Descriptor { key: b"loadavg\0", params: &[], ret: Str, invoke: stats::loadavg },
    Descriptor { key: b"cpus\0", params: &[], ret: Str, invoke: stats::cpus },
    // interface addresses (net.rs)
    Descriptor { key: b"networkInterfaces\0", params: &[], ret: Str, invoke: net::network_interfaces },
    // the passwd entry and scheduling priority (user.rs)
    Descriptor { key: b"userInfo\0", params: &[], ret: Str, invoke: user::user_info },
    Descriptor { key: b"getPriority\0", params: &[I64], ret: Str, invoke: user::get_priority },
    Descriptor { key: b"setPriority\0", params: &[I64, I64], ret: Str, invoke: user::set_priority },
    // Error retrieval (the ABI v1 error-slot convention, see lib.rs).
    //
    // `node:fs` publishes the same four readers under `lastError*`, and these
    // are deliberately NOT spelled the same: the checker rejects a program
    // whenever one *name* is registered by two modules, even though every use
    // site here is `native.errorCode()` through a namespace import that already
    // names `node:os`. The ambiguity is raised while building the by-name map
    // (`crates/zun_sema/src/check.rs`, https://github.com/UrubuCode/zun/issues/35),
    // before any use site is known, even
    // though the by-`(module, name)` map right beside it would resolve it. Until
    // that is fixed, a second module in this library must pick keys no other
    // module uses.
    Descriptor { key: b"errorCode\0", params: &[], ret: Str, invoke: crate::last_error_code },
    Descriptor { key: b"errorMessage\0", params: &[], ret: Str, invoke: crate::last_error_message },
    Descriptor { key: b"errorSyscall\0", params: &[], ret: Str, invoke: crate::last_error_syscall },
    Descriptor { key: b"errorErrno\0", params: &[], ret: I64, invoke: crate::last_error_errno },
];

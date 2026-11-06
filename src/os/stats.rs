//! `node:os` machine statistics: memory, uptime, the load average, the CPU
//! table and the available parallelism.
//!
//! `totalmem`, `freemem` and `availableParallelism` are single scalars that
//! libuv reports without a failure path, so they stay typed (`F64`, `I64`)
//! rather than paying for the status prefix. The rest is structured or
//! fallible, so it crosses as a status-prefixed record string.

use zun_abi::ZunValue;

use super::{fail_io, num, ok_fields, ok_one, ok_records, sys};
use crate::abi::{ret_f64, ret_i64, ret_str};

/// `os.totalmem()` — libuv's `uv_get_total_memory`. A byte count can exceed
/// 2^53 only on a machine with 8 petabytes of RAM, and Node has the same
/// double-precision ceiling, so `F64` is the faithful carrier.
pub(crate) unsafe extern "C" fn totalmem(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    unsafe { ret_f64(out, sys::total_memory()) }
}

/// `os.freemem()` — libuv's `uv_get_free_memory`.
pub(crate) unsafe extern "C" fn freemem(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    unsafe { ret_f64(out, sys::free_memory()) }
}

/// `os.availableParallelism()` — libuv's `uv_available_parallelism`.
pub(crate) unsafe extern "C" fn available_parallelism(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    unsafe { ret_i64(out, sys::available_parallelism()) }
}

/// `os.uptime()` — libuv's `uv_uptime`. Fallible (Node wraps it in a checked
/// function), so it carries the status prefix and the seconds as text.
pub(crate) unsafe extern "C" fn uptime(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let payload = match sys::uptime() {
        Ok(seconds) => ok_one(&num(seconds)),
        Err(err) => fail_io("uv_uptime", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `os.loadavg()` — libuv's `uv_loadavg`, which cannot fail: a platform with no
/// load average (Windows) reports three zeros.
pub(crate) unsafe extern "C" fn loadavg(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let [one, five, fifteen] = sys::loadavg();
    let payload = ok_fields(&[num(one), num(five), num(fifteen)]);
    unsafe { ret_str(out, &payload) }
}

/// `os.cpus()` — libuv's `uv_cpu_info`.
///
/// One record per logical processor, seven fields each, in the order Node's own
/// flat `getCPUs()` array uses: model, speed, then the five times (user, nice,
/// sys, idle, irq). The whole table comes from one syscall, so the rows are a
/// coherent snapshot — which matters because the times advance continuously.
pub(crate) unsafe extern "C" fn cpus(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let payload = match sys::cpus() {
        Ok(cpus) => {
            let records: Vec<Vec<String>> = cpus
                .into_iter()
                .map(|cpu| {
                    vec![
                        cpu.model,
                        cpu.speed.to_string(),
                        num(cpu.user),
                        num(cpu.nice),
                        num(cpu.sys),
                        num(cpu.idle),
                        num(cpu.irq),
                    ]
                })
                .collect();
            ok_records(&records)
        }
        Err(err) => fail_io("uv_cpu_info", &err),
    };
    unsafe { ret_str(out, &payload) }
}

//! The platform contract behind `node:process`: one set of plain Rust
//! functions, implemented twice.
//!
//! The split is the same one `node:os` uses. Everything above this module (the
//! ABI wrappers in `../mod.rs`) is platform-independent encoding; everything
//! below it is syscalls, written against the libuv entry point Node itself
//! calls, so the two cannot differ where the result is observable.
//!
//! `arch()`, `platform()` and the `std::env`-backed environment helpers live in
//! `../mod.rs` instead: they are compile-time or `std` facts rather than
//! syscalls, so they need no second implementation.

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(in crate::process) use windows::*;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(in crate::process) use unix::*;

/// The identity facts Node reads once at startup: `process.pid`,
/// `process.ppid` and `process.execPath`.
///
/// They are one struct because the TS layer reads all three in a single native
/// call at load time, the way Node reads them from one `process` binding
/// snapshot — none of them changes while a process runs.
pub(in crate::process) struct Facts {
    pub(in crate::process) pid: i64,
    /// `-1` when the platform cannot name the parent any more (the parent has
    /// exited and its entry is gone), which is how the TS layer decides
    /// `process.ppid` is unknown rather than zero.
    pub(in crate::process) ppid: i64,
    pub(in crate::process) exec_path: String,
}

/// Consumed CPU time, in **microseconds**, which is the unit Node's
/// `process.cpuUsage()` and `process.threadCpuUsage()` report.
pub(in crate::process) struct CpuTimes {
    pub(in crate::process) user: f64,
    pub(in crate::process) system: f64,
}

/// `getrusage(2)` as Node's `process.resourceUsage()`.
///
/// The field names and units are Node's: the two CPU times are microseconds,
/// `max_rss` is kilobytes, and every counter is a plain count. Windows has no
/// `getrusage`, and libuv fills only the six fields the Win32 process APIs can
/// answer, leaving the rest zero — this struct is therefore the union, and the
/// Windows implementation documents which fields it cannot fill.
pub(in crate::process) struct ResourceUsage {
    pub(in crate::process) user_cpu_time: f64,
    pub(in crate::process) system_cpu_time: f64,
    pub(in crate::process) max_rss: f64,
    pub(in crate::process) shared_memory_size: f64,
    pub(in crate::process) unshared_data_size: f64,
    pub(in crate::process) unshared_stack_size: f64,
    pub(in crate::process) minor_page_fault: f64,
    pub(in crate::process) major_page_fault: f64,
    pub(in crate::process) swapped_out: f64,
    pub(in crate::process) fs_read: f64,
    pub(in crate::process) fs_write: f64,
    pub(in crate::process) ipc_sent: f64,
    pub(in crate::process) ipc_received: f64,
    pub(in crate::process) signals_count: f64,
    pub(in crate::process) voluntary_context_switches: f64,
    pub(in crate::process) involuntary_context_switches: f64,
}

impl ResourceUsage {
    /// Every field zero, which the two implementations fill in from there.
    pub(in crate::process) fn zeroed() -> Self {
        Self {
            user_cpu_time: 0.0,
            system_cpu_time: 0.0,
            max_rss: 0.0,
            shared_memory_size: 0.0,
            unshared_data_size: 0.0,
            unshared_stack_size: 0.0,
            minor_page_fault: 0.0,
            major_page_fault: 0.0,
            swapped_out: 0.0,
            fs_read: 0.0,
            fs_write: 0.0,
            ipc_sent: 0.0,
            ipc_received: 0.0,
            signals_count: 0.0,
            voluntary_context_switches: 0.0,
            involuntary_context_switches: 0.0,
        }
    }
}

/// The POSIX credentials behind `process.getuid()` / `getgid()` / `geteuid()` /
/// `getegid()` / `getgroups()`.
///
/// Windows has none of them, and neither does Node there: the five functions
/// are simply **absent** from `process` on `win32`. The Windows implementation
/// therefore returns `ENOSYS`, which is what the TS layer reads as "do not
/// define these properties at all".
pub(in crate::process) struct Credentials {
    pub(in crate::process) uid: i64,
    pub(in crate::process) gid: i64,
    pub(in crate::process) euid: i64,
    pub(in crate::process) egid: i64,
    pub(in crate::process) groups: Vec<i64>,
}

/// The memory facts behind `process.memoryUsage()`.
///
/// Only `rss` is a platform fact: the heap numbers Node reports come from V8's
/// own heap statistics, and this runtime's host exposes none, so the TS layer
/// documents them as zero rather than inventing a figure. See
/// `../process.ts`'s `memoryUsage`.
pub(in crate::process) struct Memory {
    pub(in crate::process) rss: f64,
}

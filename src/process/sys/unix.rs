//! The POSIX half of the `node:process` platform contract.
//!
//! Each function stands in for the libuv entry point Node calls and follows its
//! implementation where the result is observable: `getrusage(RUSAGE_SELF)` for
//! `cpuUsage()` and `resourceUsage()`, `getrusage(RUSAGE_THREAD)` for
//! `threadCpuUsage()`, `/proc/self/statm` for the resident set size,
//! `/proc/self/stat`'s start time against `/proc/uptime` for the process
//! uptime, the cgroup v2/v1 memory limit for `constrainedMemory()`, and
//! `umask(0)` followed by a restore for a *reading* `process.umask()` — which
//! is the sequence that makes reading the mask not clear it.
//!
//! The `/proc` sources are Linux-only. On another POSIX the same functions
//! answer from what that platform does expose (`getrusage`, `sysconf`,
//! `current_exe`), and the two facts that have no portable source — the
//! resident set size and the cgroup limit — are reported as zero rather than
//! guessed. Linux is the platform this library's CI measures, and Windows is
//! the other implementation; see `windows.rs`.

use std::ffi::CString;
use std::io;

use super::{Credentials, CpuTimes, Facts, Memory, ResourceUsage};

/// Map a POSIX `errno` to the libuv error code Node reports. Only the codes the
/// `node:process` syscalls can produce are listed; anything else is `UNKNOWN`,
/// exactly as libuv's own fallback.
///
/// `node:fs` and `node:os` each carry their own copy of this mapping over their
/// own code set, which is the house pattern: a module's error table lists the
/// errors that module's syscalls can raise, so nothing silently inherits a code
/// it cannot produce.
pub(in crate::process) fn uv_code_of(err: &io::Error) -> &'static str {
    match err.raw_os_error() {
        Some(libc::EACCES) => "EACCES",
        Some(libc::EAGAIN) => "EAGAIN",
        Some(libc::EFAULT) => "EFAULT",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::EIO) => "EIO",
        Some(libc::ELOOP) => "ELOOP",
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG",
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::ENOMEM) => "ENOMEM",
        Some(libc::ENOSYS) => "ENOSYS",
        Some(libc::ENOTDIR) => "ENOTDIR",
        Some(libc::EPERM) => "EPERM",
        Some(libc::ESRCH) => "ESRCH",
        _ => "UNKNOWN",
    }
}

/// `process.pid` / `process.ppid` / `process.execPath` — `uv_os_getpid`,
/// `uv_os_getppid` and `uv_exepath`.
pub(in crate::process) fn facts() -> Facts {
    // SAFETY: `getpid`/`getppid` take no arguments and cannot fail.
    let (pid, ppid) = unsafe { (libc::getpid() as i64, libc::getppid() as i64) };
    Facts {
        pid,
        ppid,
        exec_path: std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// `process.cpuUsage()` — libuv's `uv_getrusage`, whose `ru_utime`/`ru_stime`
/// Node converts to microseconds.
pub(in crate::process) fn cpu_usage() -> io::Result<CpuTimes> {
    rusage_of(libc::RUSAGE_SELF).map(|usage| CpuTimes {
        user: timeval_micros(&usage.ru_utime),
        system: timeval_micros(&usage.ru_stime),
    })
}

/// `process.threadCpuUsage()` — libuv's `uv_getrusage_thread`, which is
/// `getrusage(RUSAGE_THREAD)` on Linux. Elsewhere there is no per-thread
/// variant, and the process-wide figure is the closest honest answer (this
/// runtime runs JavaScript on one thread, so the two coincide for the main
/// thread, which is the only thread Node's own test exercises).
pub(in crate::process) fn thread_cpu_usage() -> io::Result<CpuTimes> {
    #[cfg(target_os = "linux")]
    let who = libc::RUSAGE_THREAD;
    #[cfg(not(target_os = "linux"))]
    let who = libc::RUSAGE_SELF;
    rusage_of(who).map(|usage| CpuTimes {
        user: timeval_micros(&usage.ru_utime),
        system: timeval_micros(&usage.ru_stime),
    })
}

/// `process.resourceUsage()` — libuv's `uv_getrusage`, field for field.
pub(in crate::process) fn resource_usage() -> io::Result<ResourceUsage> {
    let usage = rusage_of(libc::RUSAGE_SELF)?;
    Ok(ResourceUsage {
        user_cpu_time: timeval_micros(&usage.ru_utime),
        system_cpu_time: timeval_micros(&usage.ru_stime),
        max_rss: usage.ru_maxrss as f64,
        shared_memory_size: usage.ru_ixrss as f64,
        unshared_data_size: usage.ru_idrss as f64,
        unshared_stack_size: usage.ru_isrss as f64,
        minor_page_fault: usage.ru_minflt as f64,
        major_page_fault: usage.ru_majflt as f64,
        swapped_out: usage.ru_nswap as f64,
        fs_read: usage.ru_inblock as f64,
        fs_write: usage.ru_oublock as f64,
        ipc_sent: usage.ru_msgsnd as f64,
        ipc_received: usage.ru_msgrcv as f64,
        signals_count: usage.ru_nsignals as f64,
        voluntary_context_switches: usage.ru_nvcsw as f64,
        involuntary_context_switches: usage.ru_nivcsw as f64,
    })
}

/// One `getrusage` call, with libuv's own error handling.
fn rusage_of(who: libc::c_int) -> io::Result<libc::rusage> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
    // SAFETY: `usage` is a writable, zeroed `rusage` the kernel fills.
    if unsafe { libc::getrusage(who, usage.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the call above succeeded, so the structure is initialized.
    Ok(unsafe { usage.assume_init() })
}

/// A `timeval` in microseconds, which is the unit Node reports.
fn timeval_micros(value: &libc::timeval) -> f64 {
    value.tv_sec as f64 * 1_000_000.0 + value.tv_usec as f64
}

/// `process.memoryUsage().rss` — libuv's `uv_resident_set_memory`, which on
/// Linux reads the resident page count out of `/proc/self/statm`.
pub(in crate::process) fn memory() -> io::Result<Memory> {
    #[cfg(target_os = "linux")]
    {
        let statm = std::fs::read_to_string("/proc/self/statm")?;
        let resident: f64 = statm
            .split_whitespace()
            .nth(1)
            .and_then(|field| field.parse::<f64>().ok())
            .unwrap_or(0.0);
        return Ok(Memory { rss: resident * page_size() });
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(Memory { rss: 0.0 })
    }
}

/// `sysconf(_SC_PAGESIZE)`, the unit `/proc/self/statm` counts in.
#[cfg(target_os = "linux")]
fn page_size() -> f64 {
    // SAFETY: `sysconf` takes an integer name and cannot write through a
    // pointer; `-1` on failure is handled by the caller's `max`.
    let value = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if value > 0 {
        value as f64
    } else {
        4096.0
    }
}

/// `process.uptime()` — libuv's `uv_uptime` is the *machine* uptime, but Node's
/// `process.uptime()` is the time since **this process** started, which libuv
/// answers with `uv_os_uptime`-style arithmetic over `/proc`: the process start
/// time (field 22 of `/proc/self/stat`, in clock ticks since boot) subtracted
/// from the machine uptime.
pub(in crate::process) fn uptime_seconds() -> io::Result<f64> {
    #[cfg(target_os = "linux")]
    {
        let machine = std::fs::read_to_string("/proc/uptime")?;
        let machine_uptime: f64 = machine
            .split_whitespace()
            .next()
            .and_then(|field| field.parse::<f64>().ok())
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EIO))?;
        let stat = std::fs::read_to_string("/proc/self/stat")?;
        // The second field is the command name in parentheses and may itself
        // contain spaces and parentheses, so the fields after it are counted
        // from the LAST ')' rather than by splitting the whole line.
        let tail = stat
            .rfind(')')
            .map(|at| &stat[at + 1..])
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EIO))?;
        // `tail` starts at field 3, so the start time (field 22) is the 20th.
        let ticks: f64 = tail
            .split_whitespace()
            .nth(19)
            .and_then(|field| field.parse::<f64>().ok())
            .ok_or_else(|| io::Error::from_raw_os_error(libc::EIO))?;
        // SAFETY: `sysconf` as in `page_size`.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let hz = if hz > 0 { hz as f64 } else { 100.0 };
        let elapsed = machine_uptime - ticks / hz;
        return Ok(if elapsed > 0.0 { elapsed } else { 0.0 });
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err(io::Error::from_raw_os_error(libc::ENOSYS))
    }
}

/// `process.availableMemory()` — libuv's `uv_get_available_memory`: the cgroup
/// headroom when this process is in a memory-constrained cgroup, and the
/// machine's available memory otherwise.
pub(in crate::process) fn available_memory() -> f64 {
    let constrained = constrained_memory();
    if constrained > 0.0 {
        let used = cgroup_value(&["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
        let headroom = constrained - used;
        return if headroom > 0.0 { headroom } else { 0.0 };
    }
    free_memory()
}

/// `process.constrainedMemory()` — libuv's `uv_get_constrained_memory`: the
/// cgroup v2 `memory.max` or v1 `memory.limit_in_bytes`, and `0` when there is
/// no limit (the files hold `max` on v2 and an implausibly large number on v1).
pub(in crate::process) fn constrained_memory() -> f64 {
    let limit = cgroup_value(&[
        "/sys/fs/cgroup/memory.max",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes",
    ]);
    // libuv treats a limit at or above 2^62 as "no limit", because that is how
    // cgroup v1 spells it.
    if limit <= 0.0 || limit >= 4.611686018427388e18 {
        0.0
    } else {
        limit
    }
}

/// The first of `paths` that holds a decimal byte count, or `0`.
fn cgroup_value(paths: &[&str]) -> f64 {
    for path in paths {
        if let Ok(text) = std::fs::read_to_string(path) {
            let trimmed = text.trim();
            if trimmed == "max" {
                return 0.0;
            }
            if let Ok(value) = trimmed.parse::<f64>() {
                return value;
            }
        }
    }
    0.0
}

/// libuv's `uv_get_free_memory`, which on Linux prefers `/proc/meminfo`'s
/// `MemAvailable` (what the kernel believes can be handed out without
/// swapping) and falls back to `sysinfo`'s `freeram`.
fn free_memory() -> f64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
            for line in meminfo.lines() {
                if let Some(rest) = line.strip_prefix("MemAvailable:") {
                    if let Some(kilobytes) = rest.split_whitespace().next() {
                        if let Ok(value) = kilobytes.parse::<f64>() {
                            return value * 1024.0;
                        }
                    }
                }
            }
        }
    }
    0.0
}

/// `process.kill(pid, signal)` — libuv's `uv_kill`, which is `kill(2)`.
pub(in crate::process) fn kill(pid: i32, signal: i32) -> io::Result<()> {
    // SAFETY: `kill` takes two integers and writes through no pointer.
    if unsafe { libc::kill(pid, signal) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// `process.chdir(directory)` — libuv's `uv_chdir`.
pub(in crate::process) fn chdir(directory: &str) -> io::Result<()> {
    std::env::set_current_dir(directory)
}

/// `process.umask([mask])` — libuv's `uv_os_umask`.
///
/// POSIX `umask` has no reading form: it always sets. Node therefore reads it
/// by setting `0` and immediately restoring, which is the sequence
/// `test-process-umask.js` checks does not leave the mask cleared.
pub(in crate::process) fn umask(mask: Option<u32>) -> io::Result<u32> {
    match mask {
        // SAFETY: `umask` takes a mode and returns the previous one.
        Some(mask) => Ok(unsafe { libc::umask(mask as libc::mode_t) } as u32),
        None => {
            // SAFETY: as above; the previous value is put straight back.
            let previous = unsafe { libc::umask(0) };
            // SAFETY: as above.
            unsafe { libc::umask(previous) };
            Ok(previous as u32)
        }
    }
}

/// The POSIX credentials behind `process.getuid()` and friends — libuv's
/// `uv_os_getuid` / `getgid` / `geteuid` / `getegid`, plus `getgroups(2)`.
pub(in crate::process) fn credentials() -> io::Result<Credentials> {
    // SAFETY: none of the four takes an argument or can fail.
    let (uid, gid, euid, egid) = unsafe {
        (
            libc::getuid() as i64,
            libc::getgid() as i64,
            libc::geteuid() as i64,
            libc::getegid() as i64,
        )
    };
    Ok(Credentials { uid, gid, euid, egid, groups: groups()? })
}

/// `process.getgroups()` — the supplementary group list, sized by the
/// `getgroups(0, NULL)` query libuv also uses.
fn groups() -> io::Result<Vec<i64>> {
    // SAFETY: a size of 0 with a null list is the documented "how many?" query.
    let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
    if count < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut list = vec![0 as libc::gid_t; count as usize];
    // SAFETY: `list` holds `count` writable `gid_t`s, which is the size the
    // query above reported.
    let filled = unsafe { libc::getgroups(count, list.as_mut_ptr()) };
    if filled < 0 {
        return Err(io::Error::last_os_error());
    }
    list.truncate(filled as usize);
    Ok(list.into_iter().map(|gid| gid as i64).collect())
}

/// `process.title` — libuv's `uv_get_process_title`, which hands back the
/// `argv[0]` area. `/proc/self/cmdline`'s first NUL-terminated entry is that
/// same memory as the kernel sees it, so it reflects a title another thread has
/// already rewritten.
pub(in crate::process) fn title() -> io::Result<String> {
    #[cfg(target_os = "linux")]
    {
        if let Ok(cmdline) = std::fs::read("/proc/self/cmdline") {
            let first: Vec<u8> = cmdline.into_iter().take_while(|byte| *byte != 0).collect();
            if !first.is_empty() {
                return Ok(String::from_utf8_lossy(&first).into_owned());
            }
        }
    }
    Ok(std::env::args().next().unwrap_or_default())
}

/// `process.title = value` — libuv's `uv_set_process_title`.
///
/// libuv rewrites the `argv[0]` area in place, which it can only do because it
/// saved the original `argv` pointers in `uv_setup_args()` at startup. An
/// extension loaded later has no access to that memory, so what is set here is
/// the **thread name** (`prctl(PR_SET_NAME)`, truncated to 15 bytes by the
/// kernel), which is the part of the title `ps -L`, `top -H` and
/// `/proc/self/comm` report. The value the program reads back from
/// `process.title` is remembered by the TS layer, so a round trip is exact;
/// `../process.ts` documents the difference.
pub(in crate::process) fn set_title(value: &str) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let name = CString::new(value).map_err(|_| io::Error::from_raw_os_error(libc::EINVAL))?;
        // SAFETY: `PR_SET_NAME` reads a NUL-terminated string through the
        // second argument and writes nothing; `name` outlives the call.
        unsafe { libc::prctl(libc::PR_SET_NAME, name.as_ptr() as libc::c_ulong, 0, 0, 0) };
        return Ok(());
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = CString::new(value);
        Ok(())
    }
}

/// `process.stdout.isTTY` and friends — libuv's `uv_guess_handle` reduced to
/// the one question Node's streams ask of it.
pub(in crate::process) fn is_tty(fd: i32) -> bool {
    // SAFETY: `isatty` takes a descriptor and writes through no pointer.
    unsafe { libc::isatty(fd) == 1 }
}

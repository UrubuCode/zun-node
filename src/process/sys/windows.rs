//! The Windows half of the `node:process` platform contract.
//!
//! Each function follows the libuv entry point Node calls, because libuv is
//! what decides what `process` reports on this platform and the differences are
//! observable:
//!
//!   * `GetProcessTimes` for `cpuUsage()` and `GetThreadTimes` for
//!     `threadCpuUsage()`, both in 100-nanosecond units divided down to the
//!     microseconds Node reports.
//!   * `resourceUsage()` fills only the six fields the Win32 process APIs can
//!     answer — the two CPU times, `maxRSS` from `PeakWorkingSetSize`,
//!     `majorPageFault` from `PageFaultCount`, and `fsRead`/`fsWrite` from the
//!     process I/O counters. libuv leaves the other ten zero on Windows, and so
//!     does this, rather than inventing a figure for a counter the platform
//!     does not keep.
//!   * `uptime()` is the process creation time against the current system time,
//!     both `FILETIME`s, which is how libuv dates a process on Windows.
//!   * `kill()` is libuv's `uv__kill` exactly: `SIGTERM`/`SIGKILL`/`SIGINT`
//!     terminate unconditionally with exit code 1, signal 0 is a health check
//!     that only opens the process, and every other valid signal number is
//!     `ENOSYS` — which is the reason `process.kill(pid, 'SIGHUP')` does not
//!     throw on POSIX but does here.
//!   * `constrainedMemory()` is `0`: Windows job objects can cap a process's
//!     memory, but libuv's `uv_get_constrained_memory` reports a limit only
//!     from a cgroup, so it answers 0 on this platform and so does this.
//!
//! `process.ppid` has no direct Win32 call. libuv's `uv_os_getppid` reads the
//! `InheritedFromUniqueProcessId` field of `NtQueryInformationProcess`'s basic
//! information block; the documented equivalent is a `TH32CS_SNAPPROCESS`
//! snapshot's `th32ParentProcessID`, which is used here because it is a stable,
//! documented API rather than an internal one. A parent that has already exited
//! may be absent from the snapshot, and the contract's `-1` says so.

use std::io;
use std::os::windows::ffi::{OsStrExt, OsStringExt};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_CALL_NOT_IMPLEMENTED, ERROR_INVALID_PARAMETER, FILETIME,
    HANDLE, INVALID_HANDLE_VALUE, MAX_PATH,
};
use windows_sys::Win32::Storage::FileSystem::{GetFileType, FILE_TYPE_CHAR};
use windows_sys::Win32::System::Console::{
    GetConsoleTitleW, GetStdHandle, SetConsoleTitleW, STD_ERROR_HANDLE, STD_INPUT_HANDLE,
    STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::SystemInformation::{
    GetSystemTimePreciseAsFileTime, GlobalMemoryStatusEx, MEMORYSTATUSEX,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThread, GetProcessIoCounters,
    GetProcessTimes, GetThreadTimes, OpenProcess, TerminateProcess, IO_COUNTERS,
    PROCESS_QUERY_INFORMATION, PROCESS_TERMINATE,
};

use super::{Credentials, CpuTimes, Facts, Memory, ResourceUsage};

// `_umask` from the Microsoft C runtime, which is what libuv's `uv_os_umask`
// calls on this platform. It is not in `windows-sys` (it is a CRT function
// rather than a Win32 one), and the CRT is already linked into every MSVC
// target, so it is declared here.
extern "C" {
    fn _umask(mode: i32) -> i32;
}

/// The signal numbers the Microsoft C runtime defines, which is the range
/// libuv's `uv_kill` validates against (`NSIG` is 23 there).
const NSIG: i32 = 23;
const SIGINT: i32 = 2;
const SIGKILL: i32 = 9;
const SIGTERM: i32 = 15;

/// Map a Win32 error to the libuv error code Node reports, over the codes the
/// `node:process` syscalls can produce. See the note on the POSIX twin in
/// `unix.rs` for why each module keeps its own table.
pub(in crate::process) fn uv_code_of(err: &io::Error) -> &'static str {
    const FILE_NOT_FOUND: i32 = 2;
    const PATH_NOT_FOUND: i32 = 3;
    const ACCESS_DENIED: i32 = 5;
    const NOT_ENOUGH_MEMORY: i32 = 8;
    const OUT_OF_MEMORY: i32 = 14;
    const DIRECTORY: i32 = 267;
    const FILENAME_EXCED_RANGE: i32 = 206;
    const PRIVILEGE_NOT_HELD: i32 = 1314;

    let invalid_parameter = ERROR_INVALID_PARAMETER as i32;
    let not_implemented = ERROR_CALL_NOT_IMPLEMENTED as i32;

    match err.raw_os_error() {
        Some(code) if code == not_implemented => "ENOSYS",
        Some(code) if code == invalid_parameter => "EINVAL",
        Some(ACCESS_DENIED) => "EACCES",
        Some(FILE_NOT_FOUND) | Some(PATH_NOT_FOUND) => "ENOENT",
        Some(DIRECTORY) => "ENOTDIR",
        Some(FILENAME_EXCED_RANGE) => "ENAMETOOLONG",
        Some(NOT_ENOUGH_MEMORY) | Some(OUT_OF_MEMORY) => "ENOMEM",
        Some(PRIVILEGE_NOT_HELD) => "EPERM",
        _ => "UNKNOWN",
    }
}

/// `process.pid` / `process.ppid` / `process.execPath`.
pub(in crate::process) fn facts() -> Facts {
    // SAFETY: `GetCurrentProcessId` takes no argument and cannot fail.
    let pid = unsafe { GetCurrentProcessId() } as i64;
    Facts {
        pid,
        ppid: parent_of(pid as u32).map(|parent| parent as i64).unwrap_or(-1),
        exec_path: std::env::current_exe()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// The parent process id, from a process snapshot. `None` when the parent is
/// gone from the table or the snapshot cannot be taken.
fn parent_of(pid: u32) -> Option<u32> {
    // SAFETY: a `TH32CS_SNAPPROCESS` snapshot of pid 0 is the whole process
    // table; the handle is closed on every exit path below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
        return None;
    }
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: `entry.dwSize` is set as the API requires, and `snapshot` is a
    // live snapshot handle.
    let mut found = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    let mut parent = None;
    while found {
        if entry.th32ProcessID == pid {
            parent = Some(entry.th32ParentProcessID);
            break;
        }
        // SAFETY: as above.
        found = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: `snapshot` is a handle this function owns and no longer uses.
    unsafe { CloseHandle(snapshot) };
    parent
}

/// `process.cpuUsage()` — `GetProcessTimes`, in microseconds.
pub(in crate::process) fn cpu_usage() -> io::Result<CpuTimes> {
    let times = process_times()?;
    Ok(CpuTimes {
        user: filetime_micros(&times.user),
        system: filetime_micros(&times.kernel),
    })
}

/// `process.threadCpuUsage()` — `GetThreadTimes` for the calling thread.
pub(in crate::process) fn thread_cpu_usage() -> io::Result<CpuTimes> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: the four `FILETIME`s are writable locals; the pseudo-handle from
    // `GetCurrentThread` needs no closing.
    let ok = unsafe {
        GetThreadTimes(
            GetCurrentThread(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(CpuTimes {
        user: filetime_micros(&user),
        system: filetime_micros(&kernel),
    })
}

/// The four `FILETIME`s `GetProcessTimes` reports.
struct ProcessTimes {
    creation: FILETIME,
    kernel: FILETIME,
    user: FILETIME,
}

/// `GetProcessTimes` for the current process.
fn process_times() -> io::Result<ProcessTimes> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: the four `FILETIME`s are writable locals; the pseudo-handle from
    // `GetCurrentProcess` needs no closing.
    let ok = unsafe {
        GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        )
    };
    if ok == 0 {
        return Err(last_error());
    }
    Ok(ProcessTimes { creation, kernel, user })
}

/// A `FILETIME` as a 64-bit count of 100-nanosecond intervals.
fn filetime_units(value: &FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

/// A `FILETIME` as microseconds, the unit Node reports CPU time in.
fn filetime_micros(value: &FILETIME) -> f64 {
    filetime_units(value) as f64 / 10.0
}

/// `process.resourceUsage()` — libuv's `uv_getrusage`, which on Windows fills
/// six fields and leaves the rest zero. See the module note.
pub(in crate::process) fn resource_usage() -> io::Result<ResourceUsage> {
    let times = process_times()?;
    let mut usage = ResourceUsage::zeroed();
    usage.user_cpu_time = filetime_micros(&times.user);
    usage.system_cpu_time = filetime_micros(&times.kernel);

    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: `counters.cb` is set as the API requires and `counters` is a
    // writable local.
    if unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) } != 0 {
        usage.max_rss = counters.PeakWorkingSetSize as f64 / 1024.0;
        usage.major_page_fault = counters.PageFaultCount as f64;
    }

    let mut io_counters: IO_COUNTERS = unsafe { std::mem::zeroed() };
    // SAFETY: `io_counters` is a writable local of the size the API expects.
    if unsafe { GetProcessIoCounters(GetCurrentProcess(), &mut io_counters) } != 0 {
        usage.fs_read = io_counters.ReadOperationCount as f64;
        usage.fs_write = io_counters.WriteOperationCount as f64;
    }
    Ok(usage)
}

/// `process.memoryUsage().rss` — libuv's `uv_resident_set_memory`, which is
/// `GetProcessMemoryInfo`'s `WorkingSetSize` here.
pub(in crate::process) fn memory() -> io::Result<Memory> {
    let mut counters: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
    counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    // SAFETY: as in `resource_usage`.
    if unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) } == 0 {
        return Err(last_error());
    }
    Ok(Memory { rss: counters.WorkingSetSize as f64 })
}

/// `process.uptime()` — the time since this process was created, from its
/// creation `FILETIME` against the current system time.
pub(in crate::process) fn uptime_seconds() -> io::Result<f64> {
    let times = process_times()?;
    let mut now = FILETIME::default();
    // SAFETY: `now` is a writable local; the call cannot fail.
    unsafe { GetSystemTimePreciseAsFileTime(&mut now) };
    let created = filetime_units(&times.creation);
    let current = filetime_units(&now);
    if current <= created {
        return Ok(0.0);
    }
    // 100-nanosecond intervals to seconds.
    Ok((current - created) as f64 / 10_000_000.0)
}

/// `process.availableMemory()` — libuv's `uv_get_available_memory`, which with
/// no cgroup to consult is the machine's available physical memory.
pub(in crate::process) fn available_memory() -> f64 {
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: `status.dwLength` is set as the API requires.
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return 0.0;
    }
    status.ullAvailPhys as f64
}

/// `process.constrainedMemory()` — `0` on Windows; see the module note.
pub(in crate::process) fn constrained_memory() -> f64 {
    0.0
}

/// `process.kill(pid, signal)` — libuv's `uv_kill`, step for step.
pub(in crate::process) fn kill(pid: i32, signal: i32) -> io::Result<()> {
    if signal < 0 || signal >= NSIG {
        return Err(io::Error::from_raw_os_error(ERROR_INVALID_PARAMETER as i32));
    }
    let terminating = signal == SIGTERM || signal == SIGKILL || signal == SIGINT;
    let access = if terminating {
        PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION
    } else {
        PROCESS_QUERY_INFORMATION
    };
    // SAFETY: `OpenProcess` takes integers only; the handle is closed below.
    let handle = unsafe { OpenProcess(access, 0, pid as u32) };
    if handle.is_null() {
        return Err(last_error());
    }
    let result = if terminating {
        // SAFETY: `handle` was opened with PROCESS_TERMINATE.
        if unsafe { TerminateProcess(handle, 1) } != 0 {
            Ok(())
        } else {
            Err(last_error())
        }
    } else if signal == 0 {
        // libuv's health check: opening the process was the whole test.
        Ok(())
    } else {
        Err(io::Error::from_raw_os_error(ERROR_CALL_NOT_IMPLEMENTED as i32))
    };
    // SAFETY: `handle` is owned here and no longer used.
    unsafe { CloseHandle(handle) };
    result
}

/// `process.chdir(directory)` — libuv's `uv_chdir`.
pub(in crate::process) fn chdir(directory: &str) -> io::Result<()> {
    std::env::set_current_dir(directory)
}

/// `process.umask([mask])` — libuv's `uv_os_umask`, which is the CRT's
/// `_umask` on this platform.
///
/// Windows has no file mode, and the CRT's mask affects only the `_O_CREAT`
/// read-only bit, so Node reports and accepts it all the same — which is why
/// `test-process-umask.js` uses `0600` here and `0664` on POSIX.
pub(in crate::process) fn umask(mask: Option<u32>) -> io::Result<u32> {
    match mask {
        // SAFETY: `_umask` takes a mode and returns the previous one.
        Some(mask) => Ok(unsafe { _umask(mask as i32) } as u32),
        None => {
            // SAFETY: as above; the previous value is put straight back, which
            // is how a *reading* umask is spelled on every platform.
            let previous = unsafe { _umask(0) };
            // SAFETY: as above.
            unsafe { _umask(previous) };
            Ok(previous as u32)
        }
    }
}

/// POSIX credentials do not exist on Windows, and `process.getuid` and friends
/// are absent from `process` there. `ENOSYS` is how that reaches the TS layer.
pub(in crate::process) fn credentials() -> io::Result<Credentials> {
    Err(io::Error::from_raw_os_error(ERROR_CALL_NOT_IMPLEMENTED as i32))
}

/// `process.title` — libuv's `uv_get_process_title`, which is the console
/// title on this platform.
pub(in crate::process) fn title() -> io::Result<String> {
    let mut buffer = vec![0u16; MAX_PATH as usize * 2];
    // SAFETY: `buffer` holds the number of writable units passed as the length.
    let length = unsafe { GetConsoleTitleW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 {
        // No console (a detached or redirected process) is not an error: libuv
        // reports the executable name in that case, and so does Node.
        return Ok(std::env::current_exe()
            .ok()
            .and_then(|path| path.file_name().map(|name| name.to_string_lossy().into_owned()))
            .unwrap_or_default());
    }
    buffer.truncate(length as usize);
    Ok(std::ffi::OsString::from_wide(&buffer).to_string_lossy().into_owned())
}

/// `process.title = value` — libuv's `uv_set_process_title`, which is
/// `SetConsoleTitleW` here.
pub(in crate::process) fn set_title(value: &str) -> io::Result<()> {
    let mut wide: Vec<u16> = std::ffi::OsStr::new(value).encode_wide().collect();
    wide.push(0);
    // SAFETY: `wide` is NUL-terminated and outlives the call.
    if unsafe { SetConsoleTitleW(wide.as_ptr()) } == 0 {
        // A process with no console cannot have a title; the TS layer still
        // remembers the value, so `process.title` round-trips either way.
        return Err(last_error());
    }
    Ok(())
}

/// `process.stdout.isTTY` and friends — `GetFileType` on the standard handle,
/// which is the test libuv's `uv_guess_handle` makes for a character device.
pub(in crate::process) fn is_tty(fd: i32) -> bool {
    let id = match fd {
        0 => STD_INPUT_HANDLE,
        1 => STD_OUTPUT_HANDLE,
        2 => STD_ERROR_HANDLE,
        _ => return false,
    };
    // SAFETY: both calls take integers and return a handle/type; the standard
    // handle is owned by the process and must not be closed.
    let handle: HANDLE = unsafe { GetStdHandle(id) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return false;
    }
    // SAFETY: `handle` is a live standard handle.
    unsafe { GetFileType(handle) == FILE_TYPE_CHAR }
}

/// The last Win32 error as an [`io::Error`].
fn last_error() -> io::Error {
    // SAFETY: `GetLastError` reads thread-local state and takes no argument.
    io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
}

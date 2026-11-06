//! The Windows half of the `node:os` platform contract.
//!
//! Each function stands in for the libuv entry point Node calls, and follows
//! its implementation where the result is observable: `GetTickCount64` for the
//! uptime, zero load averages (Windows has no such counter and libuv reports
//! zeros), `NtQuerySystemInformation` for the per-processor times with
//! `sys = kernel - idle`, the `CentralProcessor` registry keys for the model
//! and clock, the `ProductName` "Windows 10" → "Windows 11" fixup for
//! `os.version()`, `GetAdaptersAddresses` with the `OperStatus`/
//! `PhysicalAddressLength` rules, `uid`/`gid` of `-1` and a `null` shell for
//! the passwd entry, and the nice-value ↔ priority-class mapping for the
//! scheduling priority.
//!
//! One deliberate divergence: libuv reads the host name with winsock's
//! `GetHostNameW`, which obliges it to run `WSAStartup` first. An extension
//! should not install process-wide winsock state as a side effect of
//! `os.hostname()`, so `GetComputerNameExW(ComputerNameDnsHostname)` is used
//! instead — the same DNS host name, from the same source, without the
//! initialization.

use std::ffi::OsString;
use std::io;
use std::os::windows::ffi::OsStringExt;

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_BUFFER_OVERFLOW, ERROR_INSUFFICIENT_BUFFER,
    ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, ERROR_NO_DATA, ERROR_SUCCESS, HANDLE,
};
use windows_sys::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
};
use windows_sys::Win32::NetworkManagement::Ndis::IF_OPER_STATUS;
use windows_sys::Win32::Networking::WinSock::{
    AF_INET, AF_INET6, SOCKADDR_IN, SOCKADDR_IN6,
};
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE,
    KEY_WOW64_64KEY,
};
use windows_sys::Win32::System::SystemInformation::{
    GetComputerNameExW, GetSystemInfo, GetTickCount64, GlobalMemoryStatusEx, ComputerNameDnsHostname,
    MEMORYSTATUSEX, SYSTEM_INFO,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetPriorityClass, OpenProcess, OpenProcessToken, SetPriorityClass,
    ABOVE_NORMAL_PRIORITY_CLASS, BELOW_NORMAL_PRIORITY_CLASS, HIGH_PRIORITY_CLASS,
    IDLE_PRIORITY_CLASS, NORMAL_PRIORITY_CLASS, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_SET_INFORMATION, REALTIME_PRIORITY_CLASS,
};
use windows_sys::Win32::System::WindowsProgramming::{
    GetUserNameW, SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION,
};
use windows_sys::Win32::UI::Shell::GetUserProfileDirectoryW;
use windows_sys::Wdk::System::SystemInformation::{
    NtQuerySystemInformation, SystemProcessorPerformanceInformation,
};

use super::{
    format_ipv4, format_ipv6, format_mac, ipv4_netmask, ipv6_netmask, Cpu, InterfaceAddress,
    OsInfo, UserInfo,
};

/// One processor's cumulative times in 100-nanosecond units.
///
/// This is `SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION` with the two fields
/// windows-sys leaves as `Reserved1` named, because `interrupt_time` is
/// precisely what libuv reports as `irq`. `kernel_time` *includes*
/// `idle_time`, which is why `sys` subtracts it below. The assertion keeps the
/// layout tied to the binding's.
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct ProcessorPerformance {
    idle_time: i64,
    kernel_time: i64,
    user_time: i64,
    dpc_time: i64,
    interrupt_time: i64,
    interrupt_count: u32,
}

const _: () = assert!(
    core::mem::size_of::<ProcessorPerformance>()
        == core::mem::size_of::<SYSTEM_PROCESSOR_PERFORMANCE_INFORMATION>()
);

/// `IfOperStatusUp`.
const IF_OPER_STATUS_UP: IF_OPER_STATUS = 1;
/// `IF_TYPE_SOFTWARE_LOOPBACK`, which is what libuv reports as `internal`.
const IF_TYPE_SOFTWARE_LOOPBACK: u32 = 24;

/// A NUL-terminated UTF-16 buffer as a Rust string.
fn from_wide(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
    OsString::from_wide(&buffer[..end]).to_string_lossy().into_owned()
}

/// A wide string literal for a Win32 call, NUL terminated.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(core::iter::once(0)).collect()
}

/// The last Win32 error as an [`io::Error`].
fn last_error() -> io::Error {
    io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
}

/// Map a Win32 error to the libuv error code Node reports, following
/// `uv_translate_sys_error` for the codes these natives can produce.
pub(in crate::os) fn uv_code_of(err: &io::Error) -> &'static str {
    const ACCESS_DENIED: i32 = 5;
    const FILE_NOT_FOUND: i32 = 2;
    const PATH_NOT_FOUND: i32 = 3;
    const NOT_ENOUGH_MEMORY: i32 = 8;
    const OUT_OF_MEMORY: i32 = 14;
    const NOT_FOUND: i32 = 1168;
    const PRIVILEGE_NOT_HELD: i32 = 1314;

    let invalid_parameter = ERROR_INVALID_PARAMETER as i32;
    let no_data = ERROR_NO_DATA as i32;
    let overflow = ERROR_BUFFER_OVERFLOW as i32;
    let insufficient = ERROR_INSUFFICIENT_BUFFER as i32;
    let more_data = ERROR_MORE_DATA as i32;

    match err.raw_os_error() {
        Some(ESRCH_MARKER) => "ESRCH",
        Some(code) if code == invalid_parameter => "EINVAL",
        Some(code) if code == no_data => "EAGAIN",
        Some(code) if code == overflow || code == insufficient || code == more_data => "ENOBUFS",
        Some(ACCESS_DENIED) => "EACCES",
        Some(FILE_NOT_FOUND) | Some(PATH_NOT_FOUND) | Some(NOT_FOUND) => "ENOENT",
        Some(NOT_ENOUGH_MEMORY) | Some(OUT_OF_MEMORY) => "ENOMEM",
        Some(PRIVILEGE_NOT_HELD) => "EPERM",
        _ => "UNKNOWN",
    }
}

/// `uv_os_gethostname()` — see the module note on `GetComputerNameExW`.
pub(in crate::os) fn hostname() -> io::Result<String> {
    let mut length: u32 = 256;
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: `buffer` holds `length` writable units; on ERROR_MORE_DATA the
    // call writes the required length back into `length` and we retry.
    if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buffer.as_mut_ptr(), &mut length) } == 0
    {
        let error = unsafe { GetLastError() };
        if error != ERROR_MORE_DATA {
            return Err(io::Error::from_raw_os_error(error as i32));
        }
        buffer = vec![0u16; length as usize + 1];
        // SAFETY: as above, now with the length the first call asked for.
        if unsafe {
            GetComputerNameExW(ComputerNameDnsHostname, buffer.as_mut_ptr(), &mut length)
        } == 0
        {
            return Err(last_error());
        }
    }
    Ok(from_wide(&buffer))
}

/// Read one `REG_SZ` value, as a string.
fn registry_string(root: HKEY, subkey: &str, name: &str) -> Option<String> {
    let mut key: HKEY = core::ptr::null_mut();
    // SAFETY: `subkey` is NUL-terminated and `key` receives the opened handle.
    let status = unsafe {
        RegOpenKeyExW(
            root,
            wide(subkey).as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let mut buffer = [0u16; 512];
    let mut size = (buffer.len() * 2) as u32;
    // SAFETY: `buffer`/`size` describe a writable byte buffer for the value.
    let status = unsafe {
        RegQueryValueExW(
            key,
            wide(name).as_ptr(),
            core::ptr::null(),
            core::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    // SAFETY: `key` came from a successful `RegOpenKeyExW` and is unused after.
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS {
        return None;
    }
    Some(from_wide(&buffer))
}

/// Read one `REG_DWORD` value.
fn registry_dword(root: HKEY, subkey: &str, name: &str) -> Option<u32> {
    let mut key: HKEY = core::ptr::null_mut();
    // SAFETY: as `registry_string`.
    let status = unsafe {
        RegOpenKeyExW(
            root,
            wide(subkey).as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let mut value: u32 = 0;
    let mut size = 4u32;
    // SAFETY: `value`/`size` describe a writable 4-byte buffer.
    let status = unsafe {
        RegQueryValueExW(
            key,
            wide(name).as_ptr(),
            core::ptr::null(),
            core::ptr::null_mut(),
            (&raw mut value).cast(),
            &mut size,
        )
    };
    // SAFETY: `key` came from a successful open and is unused after.
    unsafe { RegCloseKey(key) };
    if status != ERROR_SUCCESS {
        None
    } else {
        Some(value)
    }
}

const CURRENT_VERSION_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

/// `uv_os_uname()`.
///
/// `sysname` is the constant `Windows_NT`; `release` is `major.minor.build`;
/// `machine` comes from the processor architecture; and `version` is the
/// registry `ProductName`, with libuv's fixup for Windows 11 reporting itself
/// as "Windows 10" there (same major version, build >= 22000).
pub(in crate::os) fn os_info() -> io::Result<OsInfo> {
    let major = registry_dword(HKEY_LOCAL_MACHINE, CURRENT_VERSION_KEY, "CurrentMajorVersionNumber");
    let minor = registry_dword(HKEY_LOCAL_MACHINE, CURRENT_VERSION_KEY, "CurrentMinorVersionNumber");
    let build = registry_string(HKEY_LOCAL_MACHINE, CURRENT_VERSION_KEY, "CurrentBuildNumber")
        .and_then(|text| text.parse::<u32>().ok());

    let (major, minor, build) = (major.unwrap_or(0), minor.unwrap_or(0), build.unwrap_or(0));

    let mut version = registry_string(HKEY_LOCAL_MACHINE, CURRENT_VERSION_KEY, "ProductName")
        .unwrap_or_default();
    if major == 10 && build >= 22000 && version.starts_with("Windows 10") {
        version = version.replacen("Windows 10", "Windows 11", 1);
    }

    // SAFETY: `info` is a writable `SYSTEM_INFO`; `GetSystemInfo` fills it.
    let mut info: SYSTEM_INFO = unsafe { core::mem::zeroed() };
    unsafe { GetSystemInfo(&mut info) };
    // SAFETY: the architecture lives in an anonymous union whose only other
    // member is the deprecated `dwOemId`, so this read is always valid.
    let architecture = unsafe { info.Anonymous.Anonymous.wProcessorArchitecture };
    let machine = match architecture {
        9 => "x86_64".to_owned(),  // PROCESSOR_ARCHITECTURE_AMD64
        6 => "ia64".to_owned(),    // PROCESSOR_ARCHITECTURE_IA64
        12 => "arm64".to_owned(),  // PROCESSOR_ARCHITECTURE_ARM64
        5 => "arm".to_owned(),     // PROCESSOR_ARCHITECTURE_ARM
        0 => {
            // PROCESSOR_ARCHITECTURE_INTEL: libuv appends the processor level,
            // clamped to 6, so a modern 32-bit build reports `i686`.
            let level = info.wProcessorLevel;
            if level > 3 {
                format!("i{}86", level.min(6))
            } else {
                "i386".to_owned()
            }
        }
        _ => "unknown".to_owned(),
    };

    Ok(OsInfo {
        sysname: "Windows_NT".to_owned(),
        version,
        release: format!("{major}.{minor}.{build}"),
        machine,
    })
}

/// `uv_os_homedir()`: `USERPROFILE` when it is set and at least three
/// characters (libuv's own check, which rejects a truncated drive), else the
/// profile directory from the process token.
pub(in crate::os) fn homedir() -> io::Result<String> {
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        let profile = profile.to_string_lossy().into_owned();
        if profile.len() >= 3 {
            return Ok(profile);
        }
    }
    user_profile_directory()
}

/// `GetUserProfileDirectoryW` over the current process token.
fn user_profile_directory() -> io::Result<String> {
    let mut token: HANDLE = core::ptr::null_mut();
    // SAFETY: the pseudo-handle from `GetCurrentProcess` is always valid, and
    // `token` receives an owned handle we close below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(last_error());
    }
    let mut size: u32 = 0;
    // SAFETY: a null path with a zero size is the documented size query.
    unsafe { GetUserProfileDirectoryW(token, core::ptr::null_mut(), &mut size) };
    if size == 0 {
        let error = last_error();
        // SAFETY: `token` is the handle opened above.
        unsafe { CloseHandle(token) };
        return Err(error);
    }
    let mut buffer = vec![0u16; size as usize];
    // SAFETY: `buffer` holds `size` writable units, as the query asked for.
    let ok = unsafe { GetUserProfileDirectoryW(token, buffer.as_mut_ptr(), &mut size) } != 0;
    let error = if ok { None } else { Some(last_error()) };
    // SAFETY: `token` is the handle opened above and is unused after.
    unsafe { CloseHandle(token) };
    match error {
        Some(error) => Err(error),
        None => Ok(from_wide(&buffer)),
    }
}

/// `GlobalMemoryStatusEx`, which both `uv_get_total_memory` and
/// `uv_get_free_memory` read on Windows.
fn memory_status() -> Option<MEMORYSTATUSEX> {
    let mut status: MEMORYSTATUSEX = unsafe { core::mem::zeroed() };
    status.dwLength = core::mem::size_of::<MEMORYSTATUSEX>() as u32;
    // SAFETY: `status` is writable and its `dwLength` is set as required.
    if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
        Some(status)
    } else {
        None
    }
}

/// `uv_get_total_memory()`.
pub(in crate::os) fn total_memory() -> f64 {
    memory_status().map(|status| status.ullTotalPhys as f64).unwrap_or(0.0)
}

/// `uv_get_free_memory()`.
pub(in crate::os) fn free_memory() -> f64 {
    memory_status().map(|status| status.ullAvailPhys as f64).unwrap_or(0.0)
}

/// `uv_uptime()`.
pub(in crate::os) fn uptime() -> io::Result<f64> {
    // SAFETY: `GetTickCount64` takes no arguments and cannot fail.
    Ok(unsafe { GetTickCount64() } as f64 / 1000.0)
}

/// `uv_loadavg()`: Windows keeps no load average, and libuv fills zeros.
pub(in crate::os) fn loadavg() -> [f64; 3] {
    [0.0, 0.0, 0.0]
}

/// The number of logical processors `NtQuerySystemInformation` reports on.
fn processor_count() -> usize {
    // SAFETY: `info` is a writable `SYSTEM_INFO`.
    let mut info: SYSTEM_INFO = unsafe { core::mem::zeroed() };
    unsafe { GetSystemInfo(&mut info) };
    info.dwNumberOfProcessors as usize
}

/// `uv_cpu_info()`.
///
/// The times come from `NtQuerySystemInformation` in 100-nanosecond units
/// (hence `/ 10_000` to milliseconds) with `sys = kernel - idle`, because
/// Windows counts idle inside kernel time; `nice` has no Windows counterpart
/// and libuv reports 0. The model and clock come from the per-processor
/// `HARDWARE\DESCRIPTION` registry keys.
pub(in crate::os) fn cpus() -> io::Result<Vec<Cpu>> {
    let count = processor_count();
    if count == 0 {
        return Err(io::Error::from_raw_os_error(ERROR_NO_DATA as i32));
    }
    let mut records = vec![ProcessorPerformance::default(); count];
    let length = (core::mem::size_of::<ProcessorPerformance>() * count) as u32;
    let mut returned: u32 = 0;
    // SAFETY: `records` is a writable array of exactly `length` bytes, which is
    // the shape this information class returns.
    let status = unsafe {
        NtQuerySystemInformation(
            SystemProcessorPerformanceInformation,
            records.as_mut_ptr().cast(),
            length,
            &mut returned,
        )
    };
    if status < 0 {
        // An NTSTATUS is not a Win32 error; report the generic libuv mapping.
        return Err(io::Error::from_raw_os_error(ERROR_NO_DATA as i32));
    }

    let mut out = Vec::with_capacity(count);
    for (index, record) in records.iter().enumerate() {
        let key = format!(r"HARDWARE\DESCRIPTION\System\CentralProcessor\{index}");
        let model = registry_string(HKEY_LOCAL_MACHINE, &key, "ProcessorNameString")
            .unwrap_or_else(|| "unknown".to_owned());
        let speed = registry_dword(HKEY_LOCAL_MACHINE, &key, "~MHz").unwrap_or(0) as i64;
        out.push(Cpu {
            model,
            speed,
            user: (record.user_time / 10_000) as f64,
            nice: 0.0,
            sys: ((record.kernel_time - record.idle_time) / 10_000) as f64,
            idle: (record.idle_time / 10_000) as f64,
            irq: (record.interrupt_time / 10_000) as f64,
        });
    }
    Ok(out)
}

/// `uv_interface_addresses()`.
///
/// Adapters that are not `IfOperStatusUp`, and adapters with no unicast
/// address, are not reported — libuv skips both. The netmask is built from the
/// unicast address's `OnLinkPrefixLength`, the MAC from `PhysicalAddress` only
/// when it is exactly six bytes long (so a loopback reports zeros), and
/// `internal` from `IfType == IF_TYPE_SOFTWARE_LOOPBACK`.
pub(in crate::os) fn interface_addresses() -> io::Result<Vec<InterfaceAddress>> {
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    // Microsoft's recommended first guess, which avoids a size query.
    let mut size: u32 = 15 * 1024;
    let mut buffer: Vec<u8> = Vec::new();

    loop {
        buffer.clear();
        buffer.resize(size as usize, 0);
        // SAFETY: `buffer` holds `size` writable bytes; on overflow the call
        // writes the required size back into `size` and we retry.
        let status = unsafe {
            GetAdaptersAddresses(
                0, // AF_UNSPEC
                flags,
                core::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        match status {
            ERROR_SUCCESS => break,
            ERROR_BUFFER_OVERFLOW => continue,
            ERROR_NO_DATA => return Ok(Vec::new()),
            other => return Err(io::Error::from_raw_os_error(other as i32)),
        }
    }

    let mut out = Vec::new();
    let mut adapter = buffer.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
    while !adapter.is_null() {
        // SAFETY: `adapter` points into `buffer`, which `GetAdaptersAddresses`
        // filled as a linked list of these records.
        let current = unsafe { &*adapter };
        adapter = current.Next;

        if current.OperStatus != IF_OPER_STATUS_UP || current.FirstUnicastAddress.is_null() {
            continue;
        }

        // SAFETY: `FriendlyName` is a NUL-terminated wide string in `buffer`.
        let name = unsafe { wide_from_ptr(current.FriendlyName) };
        let mac = if current.PhysicalAddressLength == 6 {
            let mut bytes = [0u8; 6];
            bytes.copy_from_slice(&current.PhysicalAddress[..6]);
            format_mac(&bytes)
        } else {
            format_mac(&[0; 6])
        };
        // SAFETY: the interface type lives in an anonymous union alongside the
        // deprecated `dwLength`/`IfIndex` pair; `IfType` is a plain field.
        let internal = current.IfType == IF_TYPE_SOFTWARE_LOOPBACK;

        let mut unicast = current.FirstUnicastAddress;
        while !unicast.is_null() {
            // SAFETY: `unicast` is a non-null node of the adapter's list.
            let entry = unsafe { &*unicast };
            unicast = entry.Next;

            let socket_address = entry.Address.lpSockaddr;
            if socket_address.is_null() {
                continue;
            }
            // SAFETY: `lpSockaddr` is a `sockaddr` whose family is readable.
            let family = unsafe { (*socket_address).sa_family };
            let prefix = u32::from(entry.OnLinkPrefixLength);

            let (address, netmask, scopeid, family_name) = if family == AF_INET {
                // SAFETY: an AF_INET sockaddr is a `SOCKADDR_IN`.
                let addr = unsafe { &*(socket_address as *const SOCKADDR_IN) };
                // SAFETY: the address bytes live in an anonymous union whose
                // members are all four bytes of the same storage.
                let bytes = unsafe { addr.sin_addr.S_un.S_addr }.to_ne_bytes();
                (format_ipv4(&bytes), ipv4_netmask(prefix), -1i64, "IPv4")
            } else if family == AF_INET6 {
                // SAFETY: an AF_INET6 sockaddr is a `SOCKADDR_IN6`.
                let addr = unsafe { &*(socket_address as *const SOCKADDR_IN6) };
                // SAFETY: the 16 address bytes are an anonymous union of the
                // same storage, and the scope id likewise.
                let bytes = unsafe { addr.sin6_addr.u.Byte };
                let scope = unsafe { addr.Anonymous.sin6_scope_id };
                (
                    format_ipv6(&bytes),
                    ipv6_netmask(prefix),
                    scope as i64,
                    "IPv6",
                )
            } else {
                continue;
            };

            out.push(InterfaceAddress {
                name: name.clone(),
                address,
                netmask,
                family: family_name,
                mac: mac.clone(),
                internal,
                scopeid,
            });
        }
    }
    Ok(out)
}

/// A NUL-terminated wide string at `ptr` as a Rust string.
///
/// # Safety
/// `ptr` must be null or point to a NUL-terminated UTF-16 string.
unsafe fn wide_from_ptr(ptr: *const u16) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let mut length = 0usize;
    // SAFETY: the caller guarantees a NUL terminator, so the scan stops.
    while unsafe { *ptr.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: `length` units before the terminator are initialized.
    let units = unsafe { core::slice::from_raw_parts(ptr, length) };
    OsString::from_wide(units).to_string_lossy().into_owned()
}

/// `uv_os_get_passwd()`: Windows has no uid/gid and no login shell, so libuv
/// reports `-1`, `-1` and `NULL`, and Node turns the last into `null`.
pub(in crate::os) fn user_info() -> io::Result<UserInfo> {
    let mut length: u32 = 256;
    let mut buffer = vec![0u16; length as usize];
    // SAFETY: `buffer` holds `length` writable units; `GetUserNameW` writes the
    // required length back on failure and we retry once.
    if unsafe { GetUserNameW(buffer.as_mut_ptr(), &mut length) } == 0 {
        buffer = vec![0u16; length as usize + 1];
        // SAFETY: as above, with the length the first call asked for.
        if unsafe { GetUserNameW(buffer.as_mut_ptr(), &mut length) } == 0 {
            return Err(last_error());
        }
    }
    Ok(UserInfo {
        uid: -1,
        gid: -1,
        username: from_wide(&buffer),
        homedir: user_profile_directory()?,
        shell: None,
    })
}

/// libuv's nice-value scale, which `os.constants.priority` exposes.
const PRIORITY_LOW: i32 = 19;
const PRIORITY_BELOW_NORMAL: i32 = 10;
const PRIORITY_NORMAL: i32 = 0;
const PRIORITY_ABOVE_NORMAL: i32 = -7;
const PRIORITY_HIGH: i32 = -14;
const PRIORITY_HIGHEST: i32 = -20;

/// `uv__get_handle()`: pid 0 means the current process, and an
/// `ERROR_INVALID_PARAMETER` from `OpenProcess` is reported as `ESRCH` rather
/// than `EINVAL` — which is why `os.getPriority(-1)` raises "no such process".
fn process_handle(pid: i32, access: u32) -> io::Result<HANDLE> {
    if pid == 0 {
        // SAFETY: a pseudo-handle, always valid, and harmless to close.
        return Ok(unsafe { GetCurrentProcess() });
    }
    // SAFETY: `OpenProcess` takes scalars and returns an owned handle or null.
    let handle = unsafe { OpenProcess(access, 0, pid as u32) };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        if error == ERROR_INVALID_PARAMETER {
            return Err(io::Error::from_raw_os_error(ESRCH_MARKER));
        }
        return Err(io::Error::from_raw_os_error(error as i32));
    }
    Ok(handle)
}

/// `uv_os_getpriority()`, including libuv's priority-class → nice mapping.
pub(in crate::os) fn get_priority(pid: i32) -> io::Result<i32> {
    let handle = process_handle(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    // SAFETY: `handle` is a live process handle with query access.
    let class = unsafe { GetPriorityClass(handle) };
    let error = if class == 0 { Some(last_error()) } else { None };
    // SAFETY: `handle` is the handle obtained above and is unused after.
    unsafe { CloseHandle(handle) };
    if let Some(error) = error {
        return Err(error);
    }
    Ok(if class == REALTIME_PRIORITY_CLASS {
        PRIORITY_HIGHEST
    } else if class == HIGH_PRIORITY_CLASS {
        PRIORITY_HIGH
    } else if class == ABOVE_NORMAL_PRIORITY_CLASS {
        PRIORITY_ABOVE_NORMAL
    } else if class == NORMAL_PRIORITY_CLASS {
        PRIORITY_NORMAL
    } else if class == BELOW_NORMAL_PRIORITY_CLASS {
        PRIORITY_BELOW_NORMAL
    } else {
        PRIORITY_LOW
    })
}

/// `uv_os_setpriority()`, including libuv's nice → priority-class mapping.
pub(in crate::os) fn set_priority(pid: i32, priority: i32) -> io::Result<()> {
    if priority < PRIORITY_HIGHEST || priority > PRIORITY_LOW {
        return Err(io::Error::from_raw_os_error(ERROR_INVALID_PARAMETER as i32));
    }
    let class = if priority < PRIORITY_HIGH {
        REALTIME_PRIORITY_CLASS
    } else if priority < PRIORITY_ABOVE_NORMAL {
        HIGH_PRIORITY_CLASS
    } else if priority < PRIORITY_NORMAL {
        ABOVE_NORMAL_PRIORITY_CLASS
    } else if priority < PRIORITY_BELOW_NORMAL {
        NORMAL_PRIORITY_CLASS
    } else if priority < PRIORITY_LOW {
        BELOW_NORMAL_PRIORITY_CLASS
    } else {
        IDLE_PRIORITY_CLASS
    };
    let handle = process_handle(pid, PROCESS_SET_INFORMATION)?;
    // SAFETY: `handle` is a live process handle with set-information access.
    let ok = unsafe { SetPriorityClass(handle, class) } != 0;
    let error = if ok { None } else { Some(last_error()) };
    // SAFETY: `handle` is the handle obtained above and is unused after.
    unsafe { CloseHandle(handle) };
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Windows has no errno, and the Win32 code `OpenProcess` reports for an
/// unknown pid (`ERROR_INVALID_PARAMETER`) already means `EINVAL` everywhere
/// else. libuv nevertheless translates exactly that case to `ESRCH`, so it
/// travels as this out-of-band marker, which [`uv_code_of`] names `ESRCH`. No
/// real Win32 error is negative, so it cannot collide with one.
const ESRCH_MARKER: i32 = -1;

//! The Unix/Linux half of the `node:os` platform contract.
//!
//! Each function stands in for the libuv entry point Node calls, and follows
//! its implementation where the result is observable: the `/proc` files it
//! reads and in which order, the tick-to-millisecond factor for the CPU times,
//! `scaling_max_freq` rather than `scaling_cur_freq` for the clock speed, the
//! `IFF_UP | IFF_RUNNING` filter and the `AF_PACKET` second pass for the MAC
//! address, `geteuid()` rather than `getuid()` for the passwd entry, and `HOME`
//! ahead of the passwd entry for the home directory.
//!
//! `/proc` is read with `std::fs` wherever libuv reads it too; `libc` is used
//! only for what has no `std` equivalent at all (`uname`, `getifaddrs`,
//! `getpwuid_r`, `getpriority`/`setpriority`, `sysinfo`).

use std::ffi::CStr;
use std::io;
use std::mem;

use super::{
    format_ipv4, format_ipv6, format_mac, read_trimmed, Cpu, InterfaceAddress, OsInfo, UserInfo,
};

/// The current `errno` as an [`io::Error`].
fn last_error() -> io::Error {
    io::Error::last_os_error()
}

/// Map a platform error to the libuv error code Node reports. On Unix the raw
/// OS error *is* the errno, so this is a direct naming of the numbers libuv
/// would negate.
pub(in crate::os) fn uv_code_of(err: &io::Error) -> &'static str {
    match err.raw_os_error() {
        Some(libc::EPERM) => "EPERM",
        Some(libc::ENOENT) => "ENOENT",
        Some(libc::ESRCH) => "ESRCH",
        Some(libc::EIO) => "EIO",
        Some(libc::EAGAIN) => "EAGAIN",
        Some(libc::ENOMEM) => "ENOMEM",
        Some(libc::EACCES) => "EACCES",
        Some(libc::EINVAL) => "EINVAL",
        Some(libc::ENOSYS) => "ENOSYS",
        Some(libc::ENOBUFS) => "ENOBUFS",
        _ => "UNKNOWN",
    }
}

/// `uv_os_gethostname()`.
pub(in crate::os) fn hostname() -> io::Result<String> {
    // POSIX allows a host name of HOST_NAME_MAX bytes; libuv uses 256 and so
    // do we, with room for the terminator.
    let mut buffer = [0i8; 257];
    // SAFETY: `buffer` is a writable array of exactly the length passed.
    let status = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len() - 1) };
    if status != 0 {
        return Err(last_error());
    }
    // SAFETY: `gethostname` succeeded, so the buffer holds a NUL-terminated
    // string (the final byte stayed zero, so a truncated name is still
    // terminated).
    let name = unsafe { CStr::from_ptr(buffer.as_ptr().cast()) };
    Ok(name.to_string_lossy().into_owned())
}

/// `uv_os_uname()`.
pub(in crate::os) fn os_info() -> io::Result<OsInfo> {
    // SAFETY: `uname` fills the struct it is given; a zeroed `utsname` is a
    // valid input, and every field is a NUL-terminated char array on return.
    let mut raw: libc::utsname = unsafe { mem::zeroed() };
    if unsafe { libc::uname(&mut raw) } != 0 {
        return Err(last_error());
    }
    // SAFETY: each field is a NUL-terminated char array written by `uname`.
    let field = |chars: &[libc::c_char]| unsafe {
        CStr::from_ptr(chars.as_ptr()).to_string_lossy().into_owned()
    };
    Ok(OsInfo {
        sysname: field(&raw.sysname),
        version: field(&raw.version),
        release: field(&raw.release),
        machine: field(&raw.machine),
    })
}

/// `uv_os_homedir()`: `HOME` when it is set and non-empty, else the passwd
/// entry's home directory.
pub(in crate::os) fn homedir() -> io::Result<String> {
    if let Some(home) = std::env::var_os("HOME") {
        let home = home.to_string_lossy().into_owned();
        if !home.is_empty() {
            return Ok(home);
        }
    }
    Ok(user_info()?.homedir)
}

/// `uv_get_total_memory()`: `MemTotal:` from `/proc/meminfo`, then `sysinfo`.
pub(in crate::os) fn total_memory() -> f64 {
    proc_meminfo("MemTotal:")
        .or_else(sysinfo_total)
        .unwrap_or(0.0)
}

/// `uv_get_free_memory()`: `MemAvailable:` from `/proc/meminfo`, then `sysinfo`.
pub(in crate::os) fn free_memory() -> f64 {
    proc_meminfo("MemAvailable:")
        .or_else(sysinfo_free)
        .unwrap_or(0.0)
}

/// One `/proc/meminfo` line in bytes. The file reports kibibytes.
fn proc_meminfo(key: &str) -> Option<f64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix(key) {
            let kibibytes: f64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kibibytes * 1024.0);
        }
    }
    None
}

/// `sysinfo(2)`'s total/free RAM, scaled by its unit, as libuv's fallback.
fn sysinfo() -> Option<libc::sysinfo> {
    // SAFETY: `sysinfo` fills the struct it is given; a zeroed one is valid input.
    let mut info: libc::sysinfo = unsafe { mem::zeroed() };
    if unsafe { libc::sysinfo(&mut info) } == 0 {
        Some(info)
    } else {
        None
    }
}

fn sysinfo_total() -> Option<f64> {
    let info = sysinfo()?;
    Some(info.totalram as f64 * info.mem_unit as f64)
}

fn sysinfo_free() -> Option<f64> {
    let info = sysinfo()?;
    Some(info.freeram as f64 * info.mem_unit as f64)
}

/// `uv_uptime()`: the first field of `/proc/uptime`, then `CLOCK_BOOTTIME`.
pub(in crate::os) fn uptime() -> io::Result<f64> {
    if let Ok(text) = read_trimmed("/proc/uptime") {
        if let Some(seconds) = text.split_whitespace().next() {
            if let Ok(seconds) = seconds.parse::<f64>() {
                return Ok(seconds);
            }
        }
    }
    let mut now = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `now` is a writable `timespec`.
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut now) } != 0 {
        return Err(last_error());
    }
    Ok(now.tv_sec as f64)
}

/// `uv_loadavg()`: the three averages from `/proc/loadavg`. libuv reports zeros
/// rather than failing, and so does Node.
pub(in crate::os) fn loadavg() -> [f64; 3] {
    let mut out = [0.0f64; 3];
    if let Ok(text) = read_trimmed("/proc/loadavg") {
        for (slot, field) in out.iter_mut().zip(text.split_whitespace()) {
            *slot = field.parse().unwrap_or(0.0);
        }
    }
    out
}

/// The `/proc/cpuinfo` key holding the model name, per architecture, as libuv
/// selects it.
const MODEL_MARKERS: &[&str] = {
    #[cfg(target_arch = "aarch64")]
    {
        &["CPU part"]
    }
    #[cfg(target_arch = "arm")]
    {
        &["model name", "Processor"]
    }
    #[cfg(any(target_arch = "powerpc", target_arch = "powerpc64"))]
    {
        &["cpu"]
    }
    #[cfg(not(any(
        target_arch = "aarch64",
        target_arch = "arm",
        target_arch = "powerpc",
        target_arch = "powerpc64"
    )))]
    {
        &["model name"]
    }
};

/// On arm64 `/proc/cpuinfo` reports a numeric implementer part code rather than
/// a model name, so libuv carries this translation table; it is reproduced here
/// (libuv, MIT) because the strings are what `os.cpus()[i].model` must contain.
#[cfg(target_arch = "aarch64")]
const ARM_PARTS: &[(&str, &str)] = &[
    ("0x811", "ARM810"), ("0x920", "ARM920"), ("0x922", "ARM922"),
    ("0x926", "ARM926"), ("0x940", "ARM940"), ("0x946", "ARM946"),
    ("0x966", "ARM966"), ("0xa20", "ARM1020"), ("0xa22", "ARM1022"),
    ("0xa26", "ARM1026"), ("0xb02", "ARM11 MPCore"), ("0xb36", "ARM1136"),
    ("0xb56", "ARM1156"), ("0xb76", "ARM1176"), ("0xc05", "Cortex-A5"),
    ("0xc07", "Cortex-A7"), ("0xc08", "Cortex-A8"), ("0xc09", "Cortex-A9"),
    ("0xc0d", "Cortex-A17"), ("0xc0f", "Cortex-A15"), ("0xc0e", "Cortex-A17"),
    ("0xc14", "Cortex-R4"), ("0xc15", "Cortex-R5"), ("0xc17", "Cortex-R7"),
    ("0xc18", "Cortex-R8"), ("0xc20", "Cortex-M0"), ("0xc21", "Cortex-M1"),
    ("0xc23", "Cortex-M3"), ("0xc24", "Cortex-M4"), ("0xc27", "Cortex-M7"),
    ("0xc60", "Cortex-M0+"), ("0xd01", "Cortex-A32"), ("0xd03", "Cortex-A53"),
    ("0xd04", "Cortex-A35"), ("0xd05", "Cortex-A55"), ("0xd06", "Cortex-A65"),
    ("0xd07", "Cortex-A57"), ("0xd08", "Cortex-A72"), ("0xd09", "Cortex-A73"),
    ("0xd0a", "Cortex-A75"), ("0xd0b", "Cortex-A76"), ("0xd0c", "Neoverse-N1"),
    ("0xd0d", "Cortex-A77"), ("0xd0e", "Cortex-A76AE"), ("0xd13", "Cortex-R52"),
    ("0xd20", "Cortex-M23"), ("0xd21", "Cortex-M33"), ("0xd41", "Cortex-A78"),
    ("0xd42", "Cortex-A78AE"), ("0xd4a", "Neoverse-E1"), ("0xd4b", "Cortex-A78C"),
    ("0xd4f", "Neoverse-V2"),
];

/// Translate a raw `/proc/cpuinfo` model field to the name libuv reports.
fn model_name(raw: &str) -> String {
    #[cfg(target_arch = "aarch64")]
    {
        for (code, name) in ARM_PARTS {
            if *code == raw {
                return (*name).to_owned();
            }
        }
        return "unknown".to_owned();
    }
    #[cfg(not(target_arch = "aarch64"))]
    {
        raw.to_owned()
    }
}

/// `uv_cpu_info()`.
///
/// `/proc/stat` gives the per-CPU times in clock ticks, which are fixed at
/// 100 Hz for this interface regardless of `_SC_CLK_TCK`, hence the factor of
/// 10 to milliseconds. `/proc/cpuinfo` gives the model and
/// `cpufreq/scaling_max_freq` the nominal clock in kHz; a core whose `cpufreq`
/// node is absent reports speed 0, which is what Node shows in a container.
pub(in crate::os) fn cpus() -> io::Result<Vec<Cpu>> {
    let stat = std::fs::read_to_string("/proc/stat")?;
    let models = match std::fs::read_to_string("/proc/cpuinfo") {
        Ok(text) => super::parse_cpuinfo_models(&text, MODEL_MARKERS, model_name),
        Err(_) => Vec::new(),
    };

    let mut out = Vec::new();
    for (index, ticks) in super::parse_proc_stat(&stat) {
        // user, nice, system, idle, (iowait, which libuv skips), irq.
        out.push(Cpu {
            model: models.get(index).cloned().unwrap_or_else(|| "unknown".to_owned()),
            speed: scaling_max_freq(index),
            user: ticks[0] * 10.0,
            nice: ticks[1] * 10.0,
            sys: ticks[2] * 10.0,
            idle: ticks[3] * 10.0,
            irq: ticks[5] * 10.0,
        });
    }
    if out.is_empty() {
        return Err(io::Error::from_raw_os_error(libc::ENOENT));
    }
    Ok(out)
}

/// One core's nominal clock in MHz, or 0 when the kernel does not report it.
fn scaling_max_freq(index: usize) -> i64 {
    let path = format!("/sys/devices/system/cpu/cpu{index}/cpufreq/scaling_max_freq");
    read_trimmed(&path)
        .ok()
        .and_then(|text| text.parse::<i64>().ok())
        .map(|kilohertz| kilohertz / 1000)
        .unwrap_or(0)
}

/// `uv_interface_addresses()`.
///
/// An entry is reported when the interface is both `IFF_UP` and `IFF_RUNNING`
/// and carries an address that is not `AF_PACKET`; `internal` is `IFF_LOOPBACK`.
/// The MAC address lives on the interface's separate `AF_PACKET` entry, so it
/// is collected in a second pass and matched by interface name — which is why a
/// loopback, having no `AF_PACKET` entry, reports `00:00:00:00:00:00`.
pub(in crate::os) fn interface_addresses() -> io::Result<Vec<InterfaceAddress>> {
    let mut head: *mut libc::ifaddrs = core::ptr::null_mut();
    // SAFETY: `getifaddrs` writes a list head we free with `freeifaddrs` below.
    if unsafe { libc::getifaddrs(&mut head) } != 0 {
        return Err(last_error());
    }

    let mut out: Vec<InterfaceAddress> = Vec::new();
    let mut macs: Vec<(String, [u8; 6])> = Vec::new();

    let mut entry = head;
    while !entry.is_null() {
        // SAFETY: `entry` is a non-null node of the list `getifaddrs` built,
        // valid until `freeifaddrs`.
        let current = unsafe { &*entry };
        entry = current.ifa_next;

        if current.ifa_addr.is_null() {
            continue;
        }
        // SAFETY: `ifa_addr` is non-null, so its family field is readable.
        let family = unsafe { (*current.ifa_addr).sa_family } as i32;
        // SAFETY: `ifa_name` is a NUL-terminated interface name.
        let name = unsafe { CStr::from_ptr(current.ifa_name) }
            .to_string_lossy()
            .into_owned();

        if family == libc::AF_PACKET {
            // SAFETY: an AF_PACKET address is a `sockaddr_ll`.
            let link = unsafe { &*(current.ifa_addr as *const libc::sockaddr_ll) };
            if link.sll_halen == 6 {
                let mut mac = [0u8; 6];
                mac.copy_from_slice(&link.sll_addr[..6]);
                macs.push((name, mac));
            }
            continue;
        }

        let up = current.ifa_flags & libc::IFF_UP as u32 != 0;
        let running = current.ifa_flags & libc::IFF_RUNNING as u32 != 0;
        if !up || !running {
            continue;
        }

        let internal = current.ifa_flags & libc::IFF_LOOPBACK as u32 != 0;
        let (address, netmask, scopeid, family) = if family == libc::AF_INET {
            // SAFETY: an AF_INET address is a `sockaddr_in`.
            let addr = unsafe { &*(current.ifa_addr as *const libc::sockaddr_in) };
            let bytes = addr.sin_addr.s_addr.to_ne_bytes();
            let mask = if current.ifa_netmask.is_null() {
                [0u8; 4]
            } else {
                // SAFETY: when non-null, the netmask has the address's family.
                unsafe { (*(current.ifa_netmask as *const libc::sockaddr_in)).sin_addr.s_addr }
                    .to_ne_bytes()
            };
            (format_ipv4(&bytes), format_ipv4(&mask), -1i64, "IPv4")
        } else if family == libc::AF_INET6 {
            // SAFETY: an AF_INET6 address is a `sockaddr_in6`.
            let addr = unsafe { &*(current.ifa_addr as *const libc::sockaddr_in6) };
            let bytes = addr.sin6_addr.s6_addr;
            let mask = if current.ifa_netmask.is_null() {
                [0u8; 16]
            } else {
                // SAFETY: when non-null, the netmask has the address's family.
                unsafe { (*(current.ifa_netmask as *const libc::sockaddr_in6)).sin6_addr.s6_addr }
            };
            (
                format_ipv6(&bytes),
                format_ipv6(&mask),
                addr.sin6_scope_id as i64,
                "IPv6",
            )
        } else {
            continue;
        };

        out.push(InterfaceAddress {
            name,
            address,
            netmask,
            family,
            mac: format_mac(&[0; 6]),
            internal,
            scopeid,
        });
    }

    // SAFETY: `head` is the list `getifaddrs` allocated and nothing holds a
    // pointer into it any more (every field was copied out above).
    unsafe { libc::freeifaddrs(head) };

    for address in out.iter_mut() {
        if let Some((_, mac)) = macs.iter().find(|(name, _)| *name == address.name) {
            address.mac = format_mac(mac);
        }
    }
    Ok(out)
}

/// `uv_os_get_passwd()`, which Node calls for `os.userInfo()`. libuv looks the
/// *effective* uid up, so a setuid program reports the user it is running as.
pub(in crate::os) fn user_info() -> io::Result<UserInfo> {
    // SAFETY: `geteuid` and `getegid` cannot fail and take no arguments.
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };

    // `getpwuid_r` wants a scratch buffer and asks for a bigger one with
    // ERANGE; libuv grows it the same way.
    let mut capacity = 2048usize;
    loop {
        let mut passwd: libc::passwd = unsafe { mem::zeroed() };
        let mut result: *mut libc::passwd = core::ptr::null_mut();
        let mut buffer = vec![0i8; capacity];
        // SAFETY: `passwd` and `buffer` are writable and live across the call;
        // `result` receives either `&passwd` or null.
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                &mut passwd,
                buffer.as_mut_ptr().cast(),
                capacity,
                &mut result,
            )
        };
        if status == libc::ERANGE && capacity < 1 << 20 {
            capacity *= 2;
            continue;
        }
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        if result.is_null() {
            // No entry for this uid: libuv reports ENOENT.
            return Err(io::Error::from_raw_os_error(libc::ENOENT));
        }
        // SAFETY: `getpwuid_r` succeeded with a non-null result, so each of
        // these pointers is either null or a NUL-terminated string in `buffer`.
        let text = |ptr: *const libc::c_char| -> String {
            if ptr.is_null() {
                String::new()
            } else {
                unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
            }
        };
        return Ok(UserInfo {
            uid: uid as i64,
            gid: gid as i64,
            username: text(passwd.pw_name),
            homedir: text(passwd.pw_dir),
            shell: Some(text(passwd.pw_shell)),
        });
    }
}

/// `uv_os_getpriority()`: `getpriority` returns -1 both for a real priority of
/// -1 and for failure, so `errno` is cleared first and consulted after.
pub(in crate::os) fn get_priority(pid: i32) -> io::Result<i32> {
    // SAFETY: writing the thread's own errno slot.
    unsafe { *libc::__errno_location() = 0 };
    // SAFETY: `getpriority` takes two scalars and returns the nice value.
    let value = unsafe { libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t) };
    // SAFETY: reading the thread's own errno slot.
    let errno = unsafe { *libc::__errno_location() };
    if value == -1 && errno != 0 {
        return Err(io::Error::from_raw_os_error(errno));
    }
    Ok(value)
}

/// `uv_os_setpriority()`.
pub(in crate::os) fn set_priority(pid: i32, priority: i32) -> io::Result<()> {
    // SAFETY: `setpriority` takes three scalars.
    if unsafe { libc::setpriority(libc::PRIO_PROCESS, pid as libc::id_t, priority) } != 0 {
        return Err(last_error());
    }
    Ok(())
}

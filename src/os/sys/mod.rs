//! The platform contract behind `node:os`: one set of plain Rust functions,
//! implemented twice.
//!
//! Everything above this module (the ABI wrappers in `facts.rs`, `stats.rs`,
//! `net.rs`, `user.rs`) is platform-independent; everything below it is
//! syscalls. Both implementations answer the same signatures and are written
//! against libuv's behavior, because that is what Node's `os` exposes — see
//! the per-function notes in [`windows`] and [`unix`].

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub(in crate::os) use windows::*;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
pub(in crate::os) use unix::*;

/// `uname(3)` as Node's `os.type()` / `version()` / `release()` / `machine()`.
pub(in crate::os) struct OsInfo {
    pub(in crate::os) sysname: String,
    pub(in crate::os) version: String,
    pub(in crate::os) release: String,
    pub(in crate::os) machine: String,
}

/// One logical processor, as one row of Node's `os.cpus()`. The times are
/// milliseconds, which is what libuv normalizes every platform's units to.
pub(in crate::os) struct Cpu {
    pub(in crate::os) model: String,
    pub(in crate::os) speed: i64,
    pub(in crate::os) user: f64,
    pub(in crate::os) nice: f64,
    pub(in crate::os) sys: f64,
    pub(in crate::os) idle: f64,
    pub(in crate::os) irq: f64,
}

/// One address of one interface, as one entry of Node's
/// `os.networkInterfaces()`. `scopeid` is `-1` for IPv4, which is the sentinel
/// Node uses to decide the key is absent from the entry.
pub(in crate::os) struct InterfaceAddress {
    pub(in crate::os) name: String,
    pub(in crate::os) address: String,
    pub(in crate::os) netmask: String,
    pub(in crate::os) family: &'static str,
    pub(in crate::os) mac: String,
    pub(in crate::os) internal: bool,
    pub(in crate::os) scopeid: i64,
}

/// The passwd entry behind Node's `os.userInfo()`. `uid`/`gid` are `-1` and
/// `shell` is `None` on Windows, exactly as libuv reports them.
pub(in crate::os) struct UserInfo {
    pub(in crate::os) uid: i64,
    pub(in crate::os) gid: i64,
    pub(in crate::os) username: String,
    pub(in crate::os) homedir: String,
    pub(in crate::os) shell: Option<String>,
}

/// `os.endianness()` is a compile-time fact, not a syscall: Node reads it from
/// the V8 build, we read it from the target.
pub(in crate::os) fn is_big_endian() -> bool {
    cfg!(target_endian = "big")
}

/// `process.arch`, which Node's `os.arch()` returns verbatim. The names are
/// Node's, not Rust's, so the two differ where Node's spelling is older
/// (`x64`, `ia32`, `arm64`).
pub(in crate::os) fn arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        "powerpc64" => "ppc64",
        "powerpc" => "ppc",
        "riscv64" => "riscv64",
        "s390x" => "s390x",
        "loongarch64" => "loong64",
        other => other,
    }
}

/// `process.platform`, which Node's `os.platform()` returns verbatim. Rust's
/// `OS` constant already matches Node's spelling for every platform this
/// extension can be built for except Windows, which Node calls `win32`.
pub(in crate::os) fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        other => other,
    }
}

/// `uv_os_getpid()` — `std::process::id()` is exactly that call on both
/// platforms, so no binding is needed.
pub(in crate::os) fn pid() -> i64 {
    std::process::id() as i64
}

/// `std::thread::available_parallelism()` is `uv_available_parallelism()`'s
/// contract exactly — the CPUs this process may actually run on, so affinity
/// masks and cgroup quotas are honored rather than the raw core count. Node
/// clamps a failure to 1 and so do we.
pub(in crate::os) fn available_parallelism() -> i64 {
    std::thread::available_parallelism().map(|n| n.get() as i64).unwrap_or(1)
}

/// Read a whole `/proc` (or other pseudo-file) entry, trimmed.
#[cfg(unix)]
pub(in crate::os) fn read_trimmed(path: &str) -> std::io::Result<String> {
    Ok(std::fs::read_to_string(path)?.trim_end().to_owned())
}

/// One `/proc/stat` per-CPU row: the logical CPU's index and its six leading
/// tick counters (user, nice, system, idle, iowait, irq).
///
/// Only rows whose `cpu` prefix is **immediately** followed by a digit are
/// returned, which is what excludes the aggregate `cpu  …` row that opens the
/// file — libuv's `fscanf(fp, "cpu%u …")` makes the same distinction, and
/// reading the aggregate as a CPU would report one processor too many with its
/// counters shifted by a field. (It did, until a differential run against Node
/// on Linux said so.)
#[cfg_attr(windows, allow(dead_code))]
pub(in crate::os) fn parse_proc_stat(text: &str) -> Vec<(usize, [f64; 6])> {
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("cpu") else { continue };
        let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
        if digits == 0 {
            continue; // the aggregate row
        }
        let Ok(index) = rest[..digits].parse::<usize>() else { continue };
        let mut ticks = [0.0f64; 6];
        let mut seen = 0usize;
        for (slot, field) in ticks.iter_mut().zip(rest[digits..].split_whitespace()) {
            let Ok(value) = field.parse::<f64>() else { break };
            *slot = value;
            seen += 1;
        }
        // libuv requires all six counters before accepting the row.
        if seen == 6 {
            out.push((index, ticks));
        }
    }
    out
}

/// The model name of each logical CPU from `/proc/cpuinfo`, indexed by its
/// `processor` number. `markers` are the architecture's model keys, in the order
/// libuv tries them; `translate` maps a raw field to the reported name (identity
/// on x86, the part-code table on arm64).
#[cfg_attr(windows, allow(dead_code))]
pub(in crate::os) fn parse_cpuinfo_models(
    text: &str,
    markers: &[&str],
    translate: fn(&str) -> String,
) -> Vec<String> {
    let mut models: Vec<String> = Vec::new();
    let mut current: Option<usize> = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let key = key.trim_end();
        let value = value.trim();
        if key == "processor" {
            current = value.parse::<usize>().ok();
            continue;
        }
        if !markers.contains(&key) {
            continue;
        }
        if let Some(index) = current {
            if models.len() <= index {
                models.resize(index + 1, String::new());
            }
            if models[index].is_empty() {
                models[index] = translate(value);
            }
        }
    }
    models
}

/// Format six MAC bytes the way Node's `GetInterfaceAddresses` does.
pub(in crate::os) fn format_mac(bytes: &[u8; 6]) -> String {
    format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]
    )
}

/// An IPv4 netmask from a prefix length, in dotted-quad form.
///
/// Windows-only in a release build: `GetAdaptersAddresses` reports a prefix
/// length, while `getifaddrs` hands back the netmask itself. The tests exercise
/// it on both platforms.
#[cfg_attr(not(windows), allow(dead_code))]
pub(in crate::os) fn ipv4_netmask(prefix: u32) -> String {
    let mask: u32 = if prefix == 0 { 0 } else { u32::MAX << (32 - prefix.min(32)) };
    format!(
        "{}.{}.{}.{}",
        (mask >> 24) & 0xff,
        (mask >> 16) & 0xff,
        (mask >> 8) & 0xff,
        mask & 0xff
    )
}

/// An IPv6 netmask from a prefix length, built byte by byte as libuv does and
/// then printed with the same compression rules as the address itself.
/// Windows-only in a release build, as [`ipv4_netmask`].
#[cfg_attr(not(windows), allow(dead_code))]
pub(in crate::os) fn ipv6_netmask(prefix: u32) -> String {
    let mut bytes = [0u8; 16];
    let prefix = prefix.min(128) as usize;
    for byte in bytes.iter_mut().take(prefix / 8) {
        *byte = 0xff;
    }
    if prefix % 8 != 0 {
        bytes[prefix / 8] = 0xffu8 << (8 - prefix % 8);
    }
    format_ipv6(&bytes)
}

/// `inet_ntop(AF_INET)`.
pub(in crate::os) fn format_ipv4(bytes: &[u8; 4]) -> String {
    format!("{}.{}.{}.{}", bytes[0], bytes[1], bytes[2], bytes[3])
}

/// `inet_ntop(AF_INET6)`.
///
/// This is RFC 5952 as `uv_inet_ntop` implements it: lowercase hex, the groups
/// without leading zeros, the longest run of two or more zero groups collapsed
/// to `::`, and an embedded IPv4 printed in dotted-quad form for the v4-mapped
/// and v4-compatible prefixes.
///
/// No `%scope` suffix. `uv_ip6_name`, which is what Node's
/// `GetInterfaceAddresses` formats an interface address with, is a bare
/// `uv_inet_ntop` call; the scope id travels as its own `scopeid` field
/// instead. Appending it here would make `os.networkInterfaces()` report every
/// link-local address differently from Node — which is exactly what a
/// differential run against Node caught.
pub(in crate::os) fn format_ipv6(bytes: &[u8; 16]) -> String {
    let groups: [u16; 8] = core::array::from_fn(|i| {
        u16::from(bytes[i * 2]) << 8 | u16::from(bytes[i * 2 + 1])
    });

    // v4-mapped (::ffff:a.b.c.d) and v4-compatible (::a.b.c.d, excluding :: and ::1).
    let leading_zero = groups[..5].iter().all(|&group| group == 0);
    let embedded_v4 = (leading_zero && groups[5] == 0xffff)
        || (leading_zero && groups[5] == 0 && groups[6] != 0);

    // The longest run of >= 2 zero groups, earliest on a tie, as RFC 5952 requires.
    let mut best_start = usize::MAX;
    let mut best_len = 0usize;
    let mut run_start = usize::MAX;
    let limit = if embedded_v4 { 6 } else { 8 };
    for index in 0..=limit {
        let zero = index < limit && groups[index] == 0;
        if zero {
            if run_start == usize::MAX {
                run_start = index;
            }
        } else if run_start != usize::MAX {
            let len = index - run_start;
            if len > best_len {
                best_len = len;
                best_start = run_start;
            }
            run_start = usize::MAX;
        }
    }
    if best_len < 2 {
        best_start = usize::MAX;
    }

    let mut text = String::new();
    let mut index = 0usize;
    while index < limit {
        if index == best_start {
            text.push_str("::");
            index += best_len;
            continue;
        }
        if !text.is_empty() && !text.ends_with(':') {
            text.push(':');
        }
        text.push_str(&format!("{:x}", groups[index]));
        index += 1;
    }
    if embedded_v4 {
        if !text.ends_with(':') {
            text.push(':');
        }
        text.push_str(&format_ipv4(&[bytes[12], bytes[13], bytes[14], bytes[15]]));
    }
    if text.is_empty() {
        text.push_str("::");
    }
    text
}


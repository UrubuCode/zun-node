//! End-to-end tests of the `node:os` surface through the real `zun_abi`
//! registration + checked-invocation path (the same path the host uses), plus
//! unit tests of the pure encoders the TS layer's parser is written against.
//!
//! These follow the style of `src/tests.rs`: drive `zun_register_v1` into an
//! `OwnedRegistry` and invoke by key, so what is tested is exactly what a
//! program reaches through `import * as native from "node:os"`.

use core::ffi::c_char;
use std::ffi::CStr;

use zun_abi::{OwnedRegistry, ZunTy, ZunTyRepr, ZunValue};

use crate::os::{sys, FAILED, RS, US};
use crate::zun_register_v1;

/// Register the extension into an owned registry, exactly as the host does.
fn registry() -> OwnedRegistry {
    let mut owned = OwnedRegistry::new();
    let mut host = owned.as_registry();
    let status = unsafe { zun_register_v1(&mut host) };
    assert_eq!(status, 0, "registration must succeed");
    owned
}

fn i64_value(value: i64) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::I64), reserved: 0, payload: value as u64 }
}

fn read_str(value: ZunValue) -> String {
    unsafe { CStr::from_ptr(value.payload as *const c_char) }
        .to_string_lossy()
        .into_owned()
}

/// Invoke `node:os.<key>` through the checked ABI path.
fn call(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> Result<Option<ZunValue>, i32> {
    reg.module("node:os")
        .func(key)
        .unwrap_or_else(|| panic!("function `{key}` must be registered"))
        .invoke_checked(args)
}

/// Invoke a `Str`-returning native and split the status-prefixed payload into
/// records of fields — the same parse the TS layer performs.
fn records(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> Vec<Vec<String>> {
    let raw = read_str(call(reg, key, args).unwrap().unwrap());
    assert_ne!(raw, FAILED, "`{key}` failed: {}", last_message(reg));
    assert!(raw.starts_with('+'), "`{key}` must answer a status prefix, got {raw:?}");
    let payload = &raw[1..];
    if payload.is_empty() {
        return Vec::new();
    }
    payload
        .split(RS)
        .map(|record| record.split(US).map(str::to_owned).collect())
        .collect()
}

/// The single-field payload of a `Str`-returning native.
fn one(reg: &OwnedRegistry, key: &str) -> String {
    one_with(reg, key, &[])
}

/// As [`one`], for a native that takes arguments.
fn one_with(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> String {
    let rows = records(reg, key, args);
    assert_eq!(rows.len(), 1, "`{key}` must answer one record");
    assert_eq!(rows[0].len(), 1, "`{key}` must answer one field");
    rows[0][0].clone()
}

fn last_message(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "errorMessage", &[]).unwrap().unwrap())
}

fn last_code(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "errorCode", &[]).unwrap().unwrap())
}

fn last_syscall(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "errorSyscall", &[]).unwrap().unwrap())
}

#[test]
fn registers_the_os_surface_under_node_os() {
    let reg = registry();
    for key in [
        "hostname",
        "osInfo",
        "homedir",
        "arch",
        "platform",
        "isBigEndian",
        "totalmem",
        "freemem",
        "availableParallelism",
        "uptime",
        "loadavg",
        "cpus",
        "networkInterfaces",
        "userInfo",
        "getPriority",
        "setPriority",
        "errorCode",
        "errorMessage",
        "errorSyscall",
        "errorErrno",
    ] {
        assert!(reg.module("node:os").func(key).is_some(), "missing `node:os.{key}`");
    }
    // Registering `fs` and `os` under one library must not blur the module
    // boundary: each key belongs to exactly one module.
    assert!(reg.module("node:os").func("readFileUtf8").is_none());
    assert!(reg.module("node:fs").func("hostname").is_none());
    assert!(reg.module("os").func("hostname").is_none());
}

#[test]
fn hostname_is_a_non_empty_name_without_separators() {
    let reg = registry();
    let hostname = one(&reg, "hostname");
    assert!(!hostname.is_empty(), "a host always has a name");
    // The whole encoding rests on the separators being impossible in a payload.
    assert!(!hostname.contains(US) && !hostname.contains(RS));
}

#[test]
fn os_info_answers_the_four_uname_fields() {
    let reg = registry();
    let rows = records(&reg, "osInfo", &[]);
    assert_eq!(rows.len(), 1);
    let fields = &rows[0];
    assert_eq!(fields.len(), 4, "type, version, release, machine");
    assert!(!fields[0].is_empty(), "type");
    assert!(!fields[2].is_empty(), "release");
    assert!(!fields[3].is_empty(), "machine");
    if cfg!(windows) {
        assert_eq!(fields[0], "Windows_NT");
        // `major.minor.build`, all numeric.
        let parts: Vec<&str> = fields[2].split('.').collect();
        assert_eq!(parts.len(), 3, "release is major.minor.build, got {:?}", fields[2]);
        assert!(parts.iter().all(|part| part.parse::<u32>().is_ok()));
    }
}

#[test]
fn homedir_is_an_absolute_path() {
    let reg = registry();
    let home = one(&reg, "homedir");
    assert!(!home.is_empty());
    let separator = if cfg!(windows) { '\\' } else { '/' };
    assert!(
        home.contains(separator),
        "Node's own test asserts homedir contains path.sep, got {home:?}"
    );
}

#[test]
fn arch_and_platform_match_the_build_target() {
    let reg = registry();
    let arch = read_str(call(&reg, "arch", &[]).unwrap().unwrap());
    let platform = read_str(call(&reg, "platform", &[]).unwrap().unwrap());
    // Node's spellings, not Rust's.
    assert!(!arch.contains('_'), "Node spells the arch `x64`/`arm64`, got {arch:?}");
    if cfg!(windows) {
        assert_eq!(platform, "win32");
    } else if cfg!(target_os = "linux") {
        assert_eq!(platform, "linux");
    }
    let big_endian = call(&reg, "isBigEndian", &[]).unwrap().unwrap();
    assert_eq!(big_endian.payload != 0, cfg!(target_endian = "big"));
}

#[test]
fn memory_and_parallelism_are_positive() {
    let reg = registry();
    let total = f64::from_bits(call(&reg, "totalmem", &[]).unwrap().unwrap().payload);
    let free = f64::from_bits(call(&reg, "freemem", &[]).unwrap().unwrap().payload);
    assert!(total > 0.0, "a machine running this test has memory");
    assert!(free > 0.0);
    assert!(free <= total, "free ({free}) cannot exceed total ({total})");

    let parallelism = call(&reg, "availableParallelism", &[]).unwrap().unwrap().payload as i64;
    assert!(parallelism > 0, "Node asserts availableParallelism() > 0");
}

#[test]
fn uptime_is_positive_and_monotonic() {
    let reg = registry();
    let first: f64 = one(&reg, "uptime").parse().expect("uptime parses as a number");
    assert!(first > 0.0, "Node asserts uptime() > 0");
    let second: f64 = one(&reg, "uptime").parse().unwrap();
    assert!(second >= first, "uptime must not go backwards");
}

#[test]
fn loadavg_is_three_numbers() {
    let reg = registry();
    let rows = records(&reg, "loadavg", &[]);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].len(), 3, "one, five and fifteen minutes");
    for field in &rows[0] {
        let value: f64 = field.parse().expect("a load average parses as a number");
        assert!(value >= 0.0 && !value.is_nan());
    }
}

#[test]
fn cpus_answers_one_seven_field_record_per_processor() {
    let reg = registry();
    let rows = records(&reg, "cpus", &[]);
    assert!(!rows.is_empty(), "Node asserts cpus().length > 0");
    for row in &rows {
        assert_eq!(row.len(), 7, "model, speed and five times");
        assert!(!row[0].is_empty(), "every CPU has a model string");
        for field in &row[1..] {
            let value: f64 = field.parse().unwrap_or_else(|_| panic!("not a number: {field:?}"));
            assert!(value >= 0.0 && !value.is_nan(), "{field:?}");
        }
    }
}

#[test]
fn network_interfaces_include_a_loopback_entry() {
    let reg = registry();
    let rows = records(&reg, "networkInterfaces", &[]);
    for row in &rows {
        assert_eq!(row.len(), 7, "name, address, netmask, family, mac, internal, scopeid");
        assert!(matches!(row[3].as_str(), "IPv4" | "IPv6"), "family {:?}", row[3]);
        assert!(matches!(row[5].as_str(), "0" | "1"), "internal is a flag, got {:?}", row[5]);
        assert_eq!(row[4].len(), 17, "a MAC is six hex pairs: {:?}", row[4]);
        row[6].parse::<i64>().expect("scopeid is an integer");
        // An IPv4 entry carries Node's -1 scopeid sentinel.
        if row[3] == "IPv4" {
            assert_eq!(row[6], "-1");
        }
    }
    let loopback = rows
        .iter()
        .find(|row| row[1] == "127.0.0.1")
        .expect("every host reports 127.0.0.1");
    assert_eq!(loopback[2], "255.0.0.0", "the loopback netmask Node's test pins");
    assert_eq!(loopback[4], "00:00:00:00:00:00", "a loopback has no physical address");
    assert_eq!(loopback[5], "1", "a loopback is internal");
}

#[test]
fn user_info_answers_five_fields_with_the_platform_shape() {
    let reg = registry();
    let rows = records(&reg, "userInfo", &[]);
    assert_eq!(rows.len(), 1);
    let fields = &rows[0];
    assert_eq!(fields.len(), 5, "uid, gid, username, homedir, shell");
    let uid: i64 = fields[0].parse().unwrap();
    let gid: i64 = fields[1].parse().unwrap();
    assert!(!fields[2].is_empty(), "the user has a name");
    assert!(!fields[3].is_empty(), "the user has a home directory");
    if cfg!(windows) {
        assert_eq!(uid, -1, "Windows has no uid, and Node's test pins -1");
        assert_eq!(gid, -1);
        assert_eq!(fields[4], crate::os::user::NO_SHELL, "Windows has no login shell");
    } else {
        assert!(uid >= 0);
        assert!(gid >= 0);
        assert_ne!(fields[4], crate::os::user::NO_SHELL, "Unix reports a shell field");
    }
}

#[test]
fn get_priority_round_trips_through_set_priority() {
    let reg = registry();
    // 0 is "this process" on both platforms, and PRIORITY_NORMAL is the one
    // value every user may set without extra privilege.
    let set = read_str(
        call(&reg, "setPriority", &[i64_value(0), i64_value(0)]).unwrap().unwrap(),
    );
    assert_eq!(set, "+", "setting PRIORITY_NORMAL must succeed: {}", last_message(&reg));
    let priority: i64 = one_with(&reg, "getPriority", &[i64_value(0)]).parse().unwrap();
    assert_eq!(priority, 0, "the priority just set must read back");
}

#[test]
fn get_priority_reports_a_node_system_error_for_an_unknown_process() {
    let reg = registry();
    // Node's own test asserts `os.getPriority(-1)` raises ERR_SYSTEM_ERROR
    // naming `uv_os_getpriority`.
    let raw = read_str(call(&reg, "getPriority", &[i64_value(-1)]).unwrap().unwrap());
    assert_eq!(raw, FAILED, "an unknown pid must fail in band");
    assert_eq!(last_syscall(&reg), "uv_os_getpriority");
    let code = last_code(&reg);
    assert!(!code.is_empty(), "a failure names a libuv code");
    // The slot holds uv_strerror's description; the TS layer composes Node's
    // `A system error occurred: <syscall> returned <code> (<description>)`.
    let description = last_message(&reg);
    assert!(!description.is_empty(), "a failure names a description");
    assert!(
        !description.starts_with("A system error occurred"),
        "the description must not be pre-composed, got {description:?}"
    );
    assert_eq!(
        format!("A system error occurred: {} returned {code} ({description})", last_syscall(&reg)),
        format!("A system error occurred: uv_os_getpriority returned ESRCH (no such process)"),
        "the four slots must compose Node's exact SystemError text"
    );
    let errno = call(&reg, "errorErrno", &[]).unwrap().unwrap().payload as i64;
    assert!(errno < 0, "libuv errnos are negative, got {errno}");
}

#[test]
fn set_priority_rejects_a_priority_outside_the_nice_range() {
    let reg = registry();
    // The TS layer rejects this with ERR_OUT_OF_RANGE before the native is
    // reached; the native must not silently accept it either.
    let raw = read_str(
        call(&reg, "setPriority", &[i64_value(0), i64_value(1 << 40)]).unwrap().unwrap(),
    );
    assert_eq!(raw, FAILED);
    assert_eq!(last_syscall(&reg), "uv_os_setpriority");
}

// ---------------------------------------------------------------------------
// The encoders, which the TS layer's parser is the mirror of
// ---------------------------------------------------------------------------

#[test]
fn the_encoding_round_trips_through_the_documented_grammar() {
    let records = [
        vec!["lo".to_owned(), "127.0.0.1".to_owned()],
        vec!["eth0".to_owned(), "10.0.0.2".to_owned()],
    ];
    let encoded = super::ok_records(&records);
    assert_eq!(encoded, format!("+lo{US}127.0.0.1{RS}eth0{US}10.0.0.2"));

    let decoded: Vec<Vec<&str>> = encoded[1..]
        .split(RS)
        .map(|record| record.split(US).collect())
        .collect();
    assert_eq!(decoded, vec![vec!["lo", "127.0.0.1"], vec!["eth0", "10.0.0.2"]]);

    // An empty record list is "+" — an empty payload, not a failure.
    let empty: [Vec<String>; 0] = [];
    assert_eq!(super::ok_records(&empty), "+");
    assert_ne!(super::ok_records(&empty), FAILED);

    // A single field still carries the prefix, so "+" can never be mistaken
    // for "-".
    assert_eq!(super::ok_one("x"), "+x");
    assert_eq!(super::ok_fields(&["a".to_owned(), "b".to_owned()]), format!("+a{US}b"));
}

#[test]
fn ipv4_netmasks_follow_the_prefix_length() {
    assert_eq!(sys::ipv4_netmask(8), "255.0.0.0");
    assert_eq!(sys::ipv4_netmask(16), "255.255.0.0");
    assert_eq!(sys::ipv4_netmask(24), "255.255.255.0");
    assert_eq!(sys::ipv4_netmask(32), "255.255.255.255");
    assert_eq!(sys::ipv4_netmask(0), "0.0.0.0");
    assert_eq!(sys::ipv4_netmask(12), "255.240.0.0");
}

#[test]
fn ipv6_formatting_matches_rfc_5952() {
    let loopback = {
        let mut bytes = [0u8; 16];
        bytes[15] = 1;
        bytes
    };
    assert_eq!(sys::format_ipv6(&loopback), "::1");
    assert_eq!(sys::format_ipv6(&[0; 16]), "::");
    // No scope suffix: `uv_ip6_name` is a bare `uv_inet_ntop`, and the scope id
    // is its own field in the entry Node builds.
    assert!(!sys::format_ipv6(&loopback).contains('%'));

    let full = [
        0x20, 0x01, 0x0d, 0xb8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x01,
    ];
    assert_eq!(sys::format_ipv6(&full), "2001:db8::1:0:0:1");

    // A v4-mapped address prints its tail in dotted-quad form.
    let mapped = [
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 1, 1,
    ];
    assert_eq!(sys::format_ipv6(&mapped), "::ffff:192.168.1.1");

    // The netmasks Node's own test maps to CIDR suffixes.
    assert_eq!(sys::ipv6_netmask(128), "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
    assert_eq!(sys::ipv6_netmask(64), "ffff:ffff:ffff:ffff::");
}

/// The `/proc` parsers are pure text, so they are tested on every platform even
/// though only Linux calls them — and this is the test that would have caught
/// the aggregate-row bug a differential run against Node found.
#[test]
fn proc_stat_skips_the_aggregate_row_and_keeps_six_counters() {
    // The real column order: user, nice, system, idle, iowait, irq, softirq,
    // steal, guest, guest_nice. libuv reads the first six and reports the sixth
    // (irq), skipping iowait — so `softirq` and everything after it is ignored.
    let text = "\
cpu  1145110 2 357232 44292671 20250 5176 20154 0 0 0
cpu0 73158 0 25027 2765248 1621 5176 1234 0 0 0
cpu1 69186 1 22189 2772438 1114 1992 456 0 0 0
cpu10 70000 0 22000 2770000 1000 1500 99 0 0 0
intr 123456
ctxt 7890
";
    let rows = super::sys::parse_proc_stat(text);
    let indices: Vec<usize> = rows.iter().map(|(index, _)| *index).collect();
    assert_eq!(indices, vec![0, 1, 10], "the aggregate `cpu` row is not a CPU");

    let (_, first) = &rows[0];
    assert_eq!(first[0], 73158.0, "user");
    assert_eq!(first[1], 0.0, "nice");
    assert_eq!(first[2], 25027.0, "system");
    assert_eq!(first[3], 2765248.0, "idle");
    assert_eq!(first[4], 1621.0, "iowait, read and then skipped");
    assert_eq!(first[5], 5176.0, "irq");

    // A truncated row is not a CPU either: libuv wants all six counters.
    assert!(super::sys::parse_proc_stat("cpu0 1 2 3\n").is_empty());
    assert!(super::sys::parse_proc_stat("cpu\ncpufreq 1 2 3 4 5 6\n").is_empty());
}

#[test]
fn cpuinfo_models_are_indexed_by_processor_number() {
    let text = "\
processor\t: 0
vendor_id\t: GenuineIntel
model name\t: Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz
cpu MHz\t\t: 3600.000

processor\t: 1
model name\t: Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz
";
    let models = super::sys::parse_cpuinfo_models(text, &["model name"], str::to_owned);
    assert_eq!(models.len(), 2);
    assert_eq!(models[0], "Intel(R) Core(TM) i9-9900K CPU @ 3.60GHz");
    assert_eq!(models[1], models[0]);

    // arm64 reports a part code, which libuv translates through a table; the
    // translation is a parameter, so the parser is architecture-agnostic.
    let arm = "processor\t: 0\nCPU part\t: 0xd0c\n";
    let translated =
        super::sys::parse_cpuinfo_models(arm, &["CPU part"], |raw| format!("<{raw}>"));
    assert_eq!(translated, vec!["<0xd0c>".to_owned()]);

    // A marker the architecture does not use is ignored.
    assert!(super::sys::parse_cpuinfo_models(text, &["CPU part"], str::to_owned)
        .iter()
        .all(String::is_empty));
}

#[test]
fn macs_are_formatted_as_six_lowercase_hex_pairs() {
    assert_eq!(sys::format_mac(&[0, 0, 0, 0, 0, 0]), "00:00:00:00:00:00");
    assert_eq!(sys::format_mac(&[0xb2, 0x90, 0x3a, 0xe5, 0x39, 0xe7]), "b2:90:3a:e5:39:e7");
    assert_eq!(sys::format_mac(&[0xff; 6]).len(), 17);
}

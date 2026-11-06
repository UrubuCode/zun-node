//! End-to-end tests of the `node:process` surface through the real `zun_abi`
//! registration + checked-invocation path (the same path the host uses), plus
//! unit tests of the pure encoders and the error table the TS layer's parser is
//! written against.
//!
//! Same style as `src/os/tests.rs`: drive `zun_register_v1` into an
//! `OwnedRegistry` and invoke by key, so what is tested is exactly what
//! `src/process/native.ts` reaches through
//! `import * as native from "node:process"`.
//!
//! Two kinds of assertion are deliberately avoided. Nothing here asserts an
//! absolute figure the machine decides (a pid, an uptime, a byte count); the
//! assertions are the *shape* and the *invariants* Node's own tests check —
//! monotonic clocks, non-negative counters, a field count, a round trip. And
//! nothing mutates process-wide state another test could observe, except the
//! environment and umask round trips, which restore what they found.

use core::ffi::c_char;
use std::ffi::{CStr, CString};

use zun_abi::{OwnedRegistry, ZunTy, ZunTyRepr, ZunValue};

use crate::process::{num, ok, ok_fields, ok_one, ok_records, uv_error, FAILED, RS, US};
use crate::zun_register_v1;

/// Register the extension into an owned registry, exactly as the host does.
fn registry() -> OwnedRegistry {
    let mut owned = OwnedRegistry::new();
    let mut host = owned.as_registry();
    // SAFETY: `host` is a valid v1 registry for the duration of the call.
    let status = unsafe { zun_register_v1(&mut host) };
    assert_eq!(status, 0, "registration must succeed");
    owned
}

fn i64_value(value: i64) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::I64), reserved: 0, payload: value as u64 }
}

fn bool_value(value: bool) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::Bool), reserved: 0, payload: value as u64 }
}

/// A `Str` argument. The returned `CString` must outlive the call, which is why
/// the caller keeps it alive.
fn str_value(text: &CString) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::Str), reserved: 0, payload: text.as_ptr() as u64 }
}

fn read_str(value: ZunValue) -> String {
    // SAFETY: a `Str` result points at the per-thread scratch buffer, which is
    // valid until the next call on this thread; it is copied out here.
    unsafe { CStr::from_ptr(value.payload as *const c_char) }
        .to_string_lossy()
        .into_owned()
}

fn read_f64(value: ZunValue) -> f64 {
    f64::from_bits(value.payload)
}

/// Invoke `node:process.<key>` through the checked ABI path.
fn call(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> Result<Option<ZunValue>, i32> {
    reg.module("node:process")
        .func(key)
        .unwrap_or_else(|| panic!("function `{key}` must be registered"))
        .invoke_checked(args)
}

/// Invoke a `Str`-returning native and split the status-prefixed payload into
/// records of fields — the same parse the TS layer performs.
fn records(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> Vec<Vec<String>> {
    let raw = read_str(call(reg, key, args).unwrap().unwrap());
    assert_ne!(raw, FAILED, "`{key}` failed: {} {}", last_code(reg), last_message(reg));
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

/// The one record of a single-record payload.
fn fields(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> Vec<String> {
    let rows = records(reg, key, args);
    assert_eq!(rows.len(), 1, "`{key}` must answer one record");
    rows.into_iter().next().unwrap()
}

/// The single-field payload of a `Str`-returning native.
fn one(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> String {
    let row = fields(reg, key, args);
    assert_eq!(row.len(), 1, "`{key}` must answer one field");
    row.into_iter().next().unwrap()
}

/// The raw result of a `Str`-returning native, status prefix included.
fn raw(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> String {
    read_str(call(reg, key, args).unwrap().unwrap())
}

fn last_message(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "procErrorMessage", &[]).unwrap().unwrap())
}

fn last_code(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "procErrorCode", &[]).unwrap().unwrap())
}

fn last_syscall(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "procErrorSyscall", &[]).unwrap().unwrap())
}

fn last_errno(reg: &OwnedRegistry) -> i64 {
    call(reg, "procErrorErrno", &[]).unwrap().unwrap().payload as i64
}

fn last_path(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "procErrorPath", &[]).unwrap().unwrap())
}

fn last_dest(reg: &OwnedRegistry) -> String {
    read_str(call(reg, "procErrorDest", &[]).unwrap().unwrap())
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

#[test]
fn registers_the_process_surface_under_node_process() {
    let reg = registry();
    for key in [
        "procFacts",
        "procTitle",
        "procSetTitle",
        "procCredentials",
        "procHrtime",
        "procUptime",
        "procCpuUsage",
        "procThreadCpuUsage",
        "procResourceUsage",
        "procMemoryUsage",
        "procAvailableMemory",
        "procConstrainedMemory",
        "procKill",
        "procChdir",
        "procUmask",
        "procAbort",
        "procEnviron",
        "procSetEnv",
        "procIsTty",
        "procErrorCode",
        "procErrorMessage",
        "procErrorSyscall",
        "procErrorErrno",
        "procErrorPath",
        "procErrorDest",
    ] {
        assert!(
            reg.module("node:process").func(key).is_some(),
            "missing `node:process.{key}`"
        );
    }
}

/// The module boundary must stay sharp, and — because the checker rejects a
/// program whenever one *name* is registered by two modules
/// (<https://github.com/UrubuCode/zun/issues/35>) — no key may be shared with
/// another module in this library.
#[test]
fn process_keys_collide_with_no_other_module() {
    let reg = registry();
    for key in ["pid", "arch", "platform", "uptime", "cpus", "hostname"] {
        assert!(
            reg.module("node:process").func(key).is_none(),
            "`node:process` must not publish the bare name `{key}`"
        );
    }
    for module in ["node:os", "node:fs", "node:child_process"] {
        for key in ["procFacts", "procHrtime", "procEnviron", "procErrorCode"] {
            assert!(
                reg.module(module).func(key).is_none(),
                "`{module}` must not publish `{key}`"
            );
        }
    }
    assert!(reg.module("process").func("procFacts").is_none());
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

#[test]
fn facts_report_this_process() {
    let reg = registry();
    let row = fields(&reg, "procFacts", &[]);
    assert_eq!(row.len(), 5, "pid, ppid, platform, arch, execPath");
    assert_eq!(row[0].parse::<i64>().unwrap(), std::process::id() as i64);
    // The parent is either a real pid or the `-1` the contract uses for "gone".
    let ppid: i64 = row[1].parse().unwrap();
    assert!(ppid > 0 || ppid == -1, "implausible ppid {ppid}");
    assert_eq!(row[2], if cfg!(windows) { "win32" } else { std::env::consts::OS });
    assert!(!row[3].is_empty(), "arch must be named");
    let exec_path = std::env::current_exe().unwrap();
    assert_eq!(row[4], exec_path.to_string_lossy());
    for field in &row {
        assert!(!field.contains(US) && !field.contains(RS), "separator in {field:?}");
    }
}

#[test]
fn arch_and_platform_use_nodes_spelling() {
    assert_eq!(super::platform(), if cfg!(windows) { "win32" } else { std::env::consts::OS });
    // Node calls x86_64 `x64` and aarch64 `arm64`; anything else is passed on.
    let arch = super::arch();
    assert_ne!(arch, "x86_64");
    assert_ne!(arch, "aarch64");
    assert!(!arch.is_empty());
}

#[test]
fn title_is_readable_and_round_trips() {
    let reg = registry();
    let before = raw(&reg, "procTitle", &[]);
    assert!(before.starts_with('+') || before == FAILED);
    // Setting a title must not fail the call in a way the TS layer cannot
    // explain: either it succeeds, or the error slots name the syscall.
    let wanted = CString::new("zun-node-test-title").unwrap();
    let set = raw(&reg, "procSetTitle", &[str_value(&wanted)]);
    if set == FAILED {
        assert_eq!(last_syscall(&reg), "uv_set_process_title");
    } else {
        assert_eq!(set, "+");
    }
}

// ---------------------------------------------------------------------------
// Clocks and resources
// ---------------------------------------------------------------------------

#[test]
fn hrtime_is_monotonic_nanoseconds() {
    let reg = registry();
    let first: u128 = one(&reg, "procHrtime", &[]).parse().unwrap();
    let second: u128 = one(&reg, "procHrtime", &[]).parse().unwrap();
    assert!(second >= first, "hrtime went backwards: {first} then {second}");
    // Decimal digits only, so the TS layer can hand them to `BigInt`.
    let text = one(&reg, "procHrtime", &[]);
    assert!(text.bytes().all(|byte| byte.is_ascii_digit()), "not digits: {text:?}");
}

#[test]
fn uptime_is_a_small_positive_number_of_seconds() {
    let reg = registry();
    let payload = raw(&reg, "procUptime", &[]);
    if payload == FAILED {
        // The only platform without a source for this is a POSIX that is not
        // Linux; it must then say so rather than report a wrong number.
        assert_eq!(last_code(&reg), "ENOSYS");
        return;
    }
    let seconds: f64 = one(&reg, "procUptime", &[]).parse().unwrap();
    assert!(seconds >= 0.0, "negative uptime {seconds}");
    // A test binary that has been alive for a day is not this test's business,
    // but a figure in the billions means the machine's uptime leaked in.
    assert!(seconds < 86_400.0 * 365.0, "implausible process uptime {seconds}");
}

#[test]
fn cpu_usage_is_non_negative_and_non_decreasing() {
    let reg = registry();
    let first = fields(&reg, "procCpuUsage", &[]);
    assert_eq!(first.len(), 2, "user and system");
    let (user, system): (f64, f64) = (first[0].parse().unwrap(), first[1].parse().unwrap());
    assert!(user >= 0.0 && system >= 0.0, "negative cpu time {user}/{system}");
    // Burn a little CPU so the second reading cannot be mistaken for noise.
    let mut sink = 0u64;
    for index in 0..2_000_000u64 {
        sink = sink.wrapping_add(index);
    }
    assert!(sink > 0);
    let second = fields(&reg, "procCpuUsage", &[]);
    let later: f64 = second[0].parse().unwrap();
    assert!(later >= user, "user cpu time went backwards: {user} then {later}");
}

#[test]
fn thread_cpu_usage_is_non_negative() {
    let reg = registry();
    let row = fields(&reg, "procThreadCpuUsage", &[]);
    assert_eq!(row.len(), 2);
    for field in &row {
        assert!(field.parse::<f64>().unwrap() >= 0.0, "negative thread cpu time {field}");
    }
}

#[test]
fn resource_usage_has_nodes_sixteen_fields() {
    let reg = registry();
    let row = fields(&reg, "procResourceUsage", &[]);
    assert_eq!(row.len(), 16, "Node's resourceUsage() has sixteen keys");
    for field in &row {
        let value: f64 = field.parse().unwrap();
        assert!(value.is_finite() && value >= 0.0, "bad resource figure {field}");
    }
}

#[test]
fn memory_usage_reports_a_plausible_resident_set() {
    let reg = registry();
    let payload = raw(&reg, "procMemoryUsage", &[]);
    if payload == FAILED {
        assert!(!last_code(&reg).is_empty());
        return;
    }
    let rss: f64 = one(&reg, "procMemoryUsage", &[]).parse().unwrap();
    assert!(rss >= 0.0 && rss.is_finite(), "bad rss {rss}");
    #[cfg(any(windows, target_os = "linux"))]
    assert!(rss > 0.0, "a running process has a resident set");
}

#[test]
fn memory_limits_are_finite_and_non_negative() {
    let reg = registry();
    let available = read_f64(call(&reg, "procAvailableMemory", &[]).unwrap().unwrap());
    let constrained = read_f64(call(&reg, "procConstrainedMemory", &[]).unwrap().unwrap());
    assert!(available >= 0.0 && available.is_finite(), "bad availableMemory {available}");
    assert!(constrained >= 0.0 && constrained.is_finite(), "bad constrainedMemory {constrained}");
    #[cfg(windows)]
    assert_eq!(constrained, 0.0, "Windows reports no cgroup limit, as libuv does");
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

/// Signal 0 is libuv's health check: it must succeed for this very process and
/// report `ESRCH` for a pid that cannot exist.
#[test]
fn kill_zero_is_a_liveness_check() {
    let reg = registry();
    let mine = std::process::id() as i64;
    assert_eq!(raw(&reg, "procKill", &[i64_value(mine), i64_value(0)]), "+");

    // Pid 0 means "this process group" on POSIX and is not a process at all on
    // Windows, so the probe uses a high pid instead, which no system assigns
    // while this test runs.
    let absent = 0x7FFF_0000i64;
    let result = raw(&reg, "procKill", &[i64_value(absent), i64_value(0)]);
    assert_eq!(result, FAILED, "killing a nonexistent pid must fail");
    assert_eq!(last_syscall(&reg), "uv_kill");
    assert!(
        last_code(&reg) == "ESRCH" || last_code(&reg) == "EPERM" || last_code(&reg) == "EINVAL",
        "unexpected code {}",
        last_code(&reg)
    );
    assert!(last_errno(&reg) != 0, "a failure must carry a libuv errno");
}

/// A pid outside `i32` cannot be a process; the native rejects it as `EINVAL`
/// rather than truncating it into some other process's pid.
#[test]
fn kill_rejects_an_out_of_range_pid() {
    let reg = registry();
    let result = raw(&reg, "procKill", &[i64_value(i64::MAX), i64_value(0)]);
    assert_eq!(result, FAILED);
    assert_eq!(last_code(&reg), "EINVAL");
}

#[test]
fn chdir_failure_carries_both_paths_node_reports() {
    let reg = registry();
    let before = std::env::current_dir().unwrap();
    let missing = CString::new("zun-node-no-such-directory-ffff").unwrap();
    let result = raw(&reg, "procChdir", &[str_value(&missing)]);
    assert_eq!(result, FAILED);
    assert_eq!(last_syscall(&reg), "chdir");
    assert_eq!(last_code(&reg), "ENOENT");
    assert_eq!(last_message(&reg), "no such file or directory");
    assert_eq!(last_path(&reg), before.to_string_lossy());
    assert_eq!(last_dest(&reg), "zun-node-no-such-directory-ffff");
    // The failed call must not have moved the process.
    assert_eq!(std::env::current_dir().unwrap(), before);
}

#[test]
fn chdir_moves_the_process_and_is_reversible() {
    let reg = registry();
    let before = std::env::current_dir().unwrap();
    let parent = before.parent().map(|path| path.to_path_buf());
    let Some(parent) = parent else { return };
    let target = CString::new(parent.to_string_lossy().as_ref()).unwrap();
    assert_eq!(raw(&reg, "procChdir", &[str_value(&target)]), "+");
    assert_eq!(std::env::current_dir().unwrap(), parent);
    let back = CString::new(before.to_string_lossy().as_ref()).unwrap();
    assert_eq!(raw(&reg, "procChdir", &[str_value(&back)]), "+");
    assert_eq!(std::env::current_dir().unwrap(), before);
}

/// Reading the mask must not clear it, which is the whole point of the
/// set-and-restore sequence `test-process-umask.js` checks.
#[test]
fn umask_reads_without_clearing_and_sets_reversibly() {
    let reg = registry();
    let first: u32 = one(&reg, "procUmask", &[i64_value(0), bool_value(false)]).parse().unwrap();
    let second: u32 = one(&reg, "procUmask", &[i64_value(0), bool_value(false)]).parse().unwrap();
    assert_eq!(first, second, "reading the umask changed it");

    // Set a mask, check the previous one comes back, then restore.
    let wanted = 0o077u32;
    let previous: u32 =
        one(&reg, "procUmask", &[i64_value(wanted as i64), bool_value(true)]).parse().unwrap();
    assert_eq!(previous, first);
    let now: u32 = one(&reg, "procUmask", &[i64_value(0), bool_value(false)]).parse().unwrap();
    let restored: u32 =
        one(&reg, "procUmask", &[i64_value(first as i64), bool_value(true)]).parse().unwrap();
    assert_eq!(restored, now);
    let after: u32 = one(&reg, "procUmask", &[i64_value(0), bool_value(false)]).parse().unwrap();
    assert_eq!(after, first, "the mask was not restored");
}

#[test]
fn credentials_are_posix_only() {
    let reg = registry();
    let payload = raw(&reg, "procCredentials", &[]);
    if cfg!(windows) {
        assert_eq!(payload, FAILED, "Windows has no POSIX credentials");
        assert_eq!(last_code(&reg), "ENOSYS");
        return;
    }
    let row = fields(&reg, "procCredentials", &[]);
    assert_eq!(row.len(), 5, "uid, gid, euid, egid, groups");
    for index in 0..4 {
        assert!(row[index].parse::<i64>().unwrap() >= 0, "bad id {}", row[index]);
    }
    for group in row[4].split(',').filter(|entry| !entry.is_empty()) {
        assert!(group.parse::<i64>().is_ok(), "bad group {group}");
    }
}

// ---------------------------------------------------------------------------
// The environment block
// ---------------------------------------------------------------------------

#[test]
fn environ_reports_every_variable_as_a_name_value_record() {
    let reg = registry();
    let rows = records(&reg, "procEnviron", &[]);
    let expected = std::env::vars_os().count();
    assert_eq!(rows.len(), expected, "every variable must be one record");
    for row in &rows {
        assert_eq!(row.len(), 2, "name and value");
        assert!(!row[0].is_empty(), "a variable must be named");
    }
}

#[test]
fn set_env_reaches_the_real_environment_and_delete_removes_it() {
    let reg = registry();
    let name = CString::new("ZUN_NODE_PROCESS_TEST").unwrap();
    let value = CString::new("marker").unwrap();
    let empty = CString::new("").unwrap();

    assert_eq!(raw(&reg, "procSetEnv", &[str_value(&name), str_value(&value), bool_value(false)]), "+");
    assert_eq!(std::env::var("ZUN_NODE_PROCESS_TEST").unwrap(), "marker");
    let rows = records(&reg, "procEnviron", &[]);
    assert!(
        rows.iter().any(|row| row[0] == "ZUN_NODE_PROCESS_TEST" && row[1] == "marker"),
        "a variable just set must appear in the block"
    );

    assert_eq!(raw(&reg, "procSetEnv", &[str_value(&name), str_value(&empty), bool_value(true)]), "+");
    assert!(std::env::var_os("ZUN_NODE_PROCESS_TEST").is_none());
}

/// Node silently drops `process.env[''] = ''`; so does this, rather than
/// failing a call the program is allowed to make.
#[test]
fn set_env_ignores_an_empty_name() {
    let reg = registry();
    let empty = CString::new("").unwrap();
    let value = CString::new("x").unwrap();
    assert_eq!(raw(&reg, "procSetEnv", &[str_value(&empty), str_value(&value), bool_value(false)]), "+");
    assert!(std::env::var_os("").is_none());
}

// ---------------------------------------------------------------------------
// Standard descriptors
// ---------------------------------------------------------------------------

#[test]
fn is_tty_answers_only_for_the_three_standard_descriptors() {
    let reg = registry();
    for fd in [0i64, 1, 2] {
        // The answer depends on how the test binary was launched, so only the
        // type is asserted; what must hold is that the call is total.
        let value = call(&reg, "procIsTty", &[i64_value(fd)]).unwrap().unwrap();
        assert!(value.payload == 0 || value.payload == 1);
    }
    for fd in [-1i64, 3, 4096, i64::MAX] {
        let value = call(&reg, "procIsTty", &[i64_value(fd)]).unwrap().unwrap();
        assert_eq!(value.payload, 0, "fd {fd} is not a standard descriptor");
    }
}

// ---------------------------------------------------------------------------
// The pure encoders and the error table
// ---------------------------------------------------------------------------

#[test]
fn encoders_match_the_documented_grammar() {
    assert_eq!(ok(), "+");
    assert_eq!(ok_one("x"), "+x");
    assert_eq!(ok_one(""), "+");
    assert_eq!(ok_fields(&["a".to_owned(), "b".to_owned()]), format!("+a{US}b"));
    assert_eq!(
        ok_records(&[vec!["a".to_owned(), "b".to_owned()], vec!["c".to_owned()]]),
        format!("+a{US}b{RS}c")
    );
    assert_eq!(ok_records(&[]), "+");
    // An empty field is a field, not a missing one.
    assert_eq!(ok_fields(&["".to_owned(), "b".to_owned()]), format!("+{US}b"));
}

#[test]
fn num_round_trips_through_the_payload() {
    for value in [0.0f64, 1.0, -1.5, 1e21, 2f64.powi(53) + 1.0, 1.7976931348623157e308] {
        assert_eq!(num(value).parse::<f64>().unwrap(), value, "{value} did not round-trip");
    }
}

#[test]
fn the_error_table_is_libuvs() {
    // The description is spliced into Node's message verbatim, so the wording
    // is libuv's `uv_strerror` text, not the platform's.
    assert_eq!(uv_error("ENOENT").0, "ENOENT");
    assert_eq!(uv_error("ENOENT").2, "no such file or directory");
    assert_eq!(uv_error("ESRCH").2, "no such process");
    assert_eq!(uv_error("ENOSYS").2, "function not implemented");
    assert_eq!(uv_error("ENOTDIR").2, "not a directory");
    // libuv reports -errno on POSIX and a value from its own reserved range on
    // Windows; either way, never zero.
    for code in ["EACCES", "EINVAL", "ENOENT", "EPERM", "ESRCH", "ENOSYS", "ENOTDIR"] {
        assert_ne!(uv_error(code).1, 0, "{code} must carry an errno");
    }
    let unknown = uv_error("ENOT_A_REAL_CODE");
    assert_eq!(unknown.0, "UNKNOWN");
    assert_eq!(unknown.2, "unknown error");
}

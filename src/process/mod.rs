//! `node:process` — the operating-system facts behind Node's `process` object,
//! as a native `zun_abi` extension.
//!
//! # TS over natives, with one extra constraint
//!
//! The split is the one `node:os`, `node:fs` and `node:child_process` use: this
//! crate answers only what needs the kernel, and `src/process/process.ts` is
//! the Node-shaped object around it. `process` has one constraint none of the
//! others has, though, and it shapes the whole design:
//!
//! > **every** bundle in this library inlines `src/process/process.ts`, and
//! > most of them run without `--ext`.
//!
//! `node:path`, `node:events`, `node:util`, `node:assert` and `node:url` are
//! pure computation and their tests run as `zun run <bundle.ts>` with no
//! extension at all (see `tools/run_node_tests.sh`'s `zun-ts` kind). A
//! `process` that imported this module directly would make every one of those
//! bundles fail to compile for want of a cdylib they do not need.
//!
//! So the import lives in a **third file**: `src/process/native.ts` is nothing
//! but `import * as native from "node:process"` and a single call to
//! `__processInstallNative(...)`, which hands `process.ts` an object of methods
//! it then uses for every native-backed value. `process.ts` itself never names
//! this module, keeps a complete no-extension fallback for each value, and is
//! the only file with logic in it. The bundler inlines `native.ts` only when
//! the bundle will be run with `--ext` (`ZUN_NODE_EXT`, set by the tracker for
//! the `zun-ts+ext` kinds), so:
//!
//! | bundle                        | `native.ts` | `process.pid` |
//! |-------------------------------|-------------|---------------|
//! | `path`, `events`, `util`, …   | absent      | `0`, documented |
//! | `process`, `os`, `fs`, `cp`   | inlined     | the real pid  |
//!
//! # What crosses the boundary
//!
//! ABI v1 carries one scalar word per value, so nothing structured crosses as a
//! structure. The frame is the status-prefixed, separator-delimited grammar
//! `node:os` fixed and `../lib.rs` documents:
//!
//! ```text
//! result  := "+" payload | "-"
//! payload := record (RS record)*
//! record  := field (US field)*
//! RS = U+001E     US = U+001F
//! ```
//!
//! A leading `-` means the call failed and the error slots describe it. The
//! encoders below are this module's own copy rather than a shared helper, which
//! is the house pattern (`node:fs` and `node:os` each carry theirs): a module's
//! frame and error table list exactly what that module's syscalls can produce,
//! so nothing silently inherits a code it cannot raise.
//!
//! Two payloads earn the frame rather than a scalar return. `procFacts`
//! captures the pid, parent pid, platform, architecture and executable path in
//! **one** call, because Node reads all five from a single binding snapshot at
//! startup and none of them changes. `procEnviron` captures the whole
//! environment block in one call, which is what makes `process.env` a coherent
//! snapshot instead of a smear of per-name reads — and what finally makes
//! `Object.keys(process.env)` honest in this library.
//!
//! # Failure
//!
//! A `node:process` native never returns a non-zero status. An error raised by
//! an extension call does not reach an enclosing `try`/`catch` with its own
//! `(code, message)` in this host — what the handler receives names the
//! namespace import instead
//! (<https://github.com/UrubuCode/zun/issues/33>) — so failure is reported in
//! band with `"-"` and the Node `SystemError`/`uvException` fields in the
//! per-thread error slots, which the TS layer reads through `procErrorCode` /
//! `procErrorMessage` / `procErrorSyscall` / `procErrorErrno` / `procErrorPath`
//! / `procErrorDest` and raises itself. `process.chdir` is the one call whose
//! error carries paths (Node reports `ENOENT: no such file or directory, chdir
//! '<cwd>' -> '<target>'`), which is why the two path slots are read here too.
//!
//! Behaviour is defined by Node.js 25, whose `process` is a thin layer over
//! libuv, so each native documents the libuv entry point it stands in for and
//! follows it where the two could differ — see `sys/windows.rs` and
//! `sys/unix.rs`. The acceptance bar is Node's own `test-process-*` suite; see
//! `../../test/process/`.

use std::io;
use std::sync::OnceLock;
use std::time::Instant;

use crate::abi::{arg_bool, arg_i64, arg_str, ret_bool, ret_f64, ret_str};
use crate::Descriptor;
use zun_abi::ZunTy::{Bool, F64, I64, Str};
use zun_abi::ZunValue;

mod sys;

#[cfg(test)]
mod tests;

/// Unit separator: between the fields of one record.
pub(super) const US: char = '\u{1f}';
/// Record separator: between records.
pub(super) const RS: char = '\u{1e}';

/// The in-band failure marker. The caller has already stashed the error.
pub(super) const FAILED: &str = "-";

/// Encode a successful multi-record payload (`"+"` and the records).
pub(super) fn ok_records(records: &[Vec<String>]) -> String {
    let mut out = String::from("+");
    for (index, record) in records.iter().enumerate() {
        if index > 0 {
            out.push(RS);
        }
        for (field_index, field) in record.iter().enumerate() {
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

/// Encode a successful single-field payload, returned byte for byte.
pub(super) fn ok_one(field: &str) -> String {
    let mut out = String::from("+");
    out.push_str(field);
    out
}

/// Encode a successful empty payload (a call that only has to succeed).
pub(super) fn ok() -> String {
    String::from("+")
}

/// A number as payload text. `{}` on an `f64` is Rust's shortest
/// round-tripping form, so the TS side's `Number(field)` recovers the same
/// double.
pub(super) fn num(value: f64) -> String {
    format!("{value}")
}

/// libuv's `(code, errno, description)` for an error code, as `uv_strerror`
/// words it, over the codes the `node:process` syscalls can produce.
///
/// libuv reports `-errno` where the platform has an errno and a value from its
/// own reserved range where it does not, which is Windows; see
/// `include/uv/errno.h`. Node splices the description into the error message
/// verbatim, which is why it is libuv's wording rather than the platform's.
fn uv_error(code: &str) -> (&'static str, i64, &'static str) {
    match code {
        "EACCES" => ("EACCES", uv_errno(13, -4092), "permission denied"),
        "EAGAIN" => ("EAGAIN", uv_errno(11, -4088), "resource temporarily unavailable"),
        "EFAULT" => ("EFAULT", uv_errno(14, -4074), "bad address in system call argument"),
        "EINVAL" => ("EINVAL", uv_errno(22, -4071), "invalid argument"),
        "EIO" => ("EIO", uv_errno(5, -4070), "i/o error"),
        "ELOOP" => ("ELOOP", uv_errno(40, -4067), "too many symbolic links encountered"),
        "ENAMETOOLONG" => ("ENAMETOOLONG", uv_errno(36, -4064), "name too long"),
        "ENOENT" => ("ENOENT", uv_errno(2, -4058), "no such file or directory"),
        "ENOMEM" => ("ENOMEM", uv_errno(12, -4057), "not enough memory"),
        "ENOSYS" => ("ENOSYS", uv_errno(38, -4054), "function not implemented"),
        "ENOTDIR" => ("ENOTDIR", uv_errno(20, -4052), "not a directory"),
        "EPERM" => ("EPERM", uv_errno(1, -4048), "operation not permitted"),
        "ESRCH" => ("ESRCH", uv_errno(3, -4040), "no such process"),
        _ => ("UNKNOWN", -4094, "unknown error"),
    }
}

/// See [`uv_error`]: `-errno` on POSIX, libuv's reserved range on Windows.
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
///
/// `path` and `dest` are empty for every call but `chdir`, which is how the TS
/// layer decides those keys are absent from the error object.
fn fail_code(syscall: &str, code: &str, path: &str, dest: &str) -> String {
    let (code, errno, description) = uv_error(code);
    crate::abi::fail_fs(syscall, code, errno, description, path, dest);
    FAILED.to_owned()
}

/// Stash a failure described by an [`io::Error`], mapping the platform error to
/// the libuv code Node would report, and return [`FAILED`].
fn fail_io(syscall: &str, err: &io::Error) -> String {
    fail_code(syscall, sys::uv_code_of(err), "", "")
}

/// The path-carrying form of [`fail_io`], for `process.chdir`.
fn fail_io_paths(syscall: &str, err: &io::Error, path: &str, dest: &str) -> String {
    fail_code(syscall, sys::uv_code_of(err), path, dest)
}

/// `process.arch`. The names are Node's, not Rust's, so the two differ where
/// Node's spelling is older (`x64`, `ia32`, `arm64`). This is the same table
/// `node:os`'s `arch()` answers from — both are `std::env::consts::ARCH`
/// renamed, and neither is a syscall, which is why it lives above `sys`.
fn arch() -> &'static str {
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

/// `process.platform`. Rust's `OS` constant already matches Node's spelling for
/// every platform this extension can be built for except Windows, which Node
/// calls `win32`.
fn platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        other => other,
    }
}

/// `procFacts()` — the pid, parent pid, platform, architecture and executable
/// path, in one record.
///
/// Infallible: a platform that cannot name the parent reports `-1` rather than
/// failing the whole call, because `process.pid` must not be lost with it.
pub(crate) unsafe extern "C" fn proc_facts(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let facts = sys::facts();
    let payload = ok_fields(&[
        facts.pid.to_string(),
        facts.ppid.to_string(),
        platform().to_owned(),
        arch().to_owned(),
        facts.exec_path,
    ]);
    unsafe { ret_str(out, &payload) }
}

/// `procHrtime()` — a monotonic nanosecond count, as decimal text.
///
/// Node's `process.hrtime()` is relative to "an arbitrary time in the past";
/// the epoch here is the first call, which makes the value the time since this
/// extension was first asked the question. Text rather than an `F64` return
/// because a nanosecond count passes 2^53 after 104 days of uptime and
/// `hrtime.bigint()` must be exact — the TS layer parses the digits into a
/// `BigInt` and splits the tuple form out of them.
pub(crate) unsafe extern "C" fn proc_hrtime(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    let nanos = EPOCH.get_or_init(Instant::now).elapsed().as_nanos();
    unsafe { ret_str(out, &ok_one(&nanos.to_string())) }
}

/// `procUptime()` — seconds since this process started.
pub(crate) unsafe extern "C" fn proc_uptime(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::uptime_seconds() {
        Ok(seconds) => ok_one(&num(seconds)),
        Err(err) => fail_io("uv_uptime", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procMemoryUsage()` — the resident set size in bytes. See
/// [`sys::Memory`] for why the heap figures are not here.
pub(crate) unsafe extern "C" fn proc_memory_usage(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::memory() {
        Ok(memory) => ok_one(&num(memory.rss)),
        Err(err) => fail_io("uv_resident_set_memory", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procCpuUsage()` — the process's user and system CPU time, microseconds.
pub(crate) unsafe extern "C" fn proc_cpu_usage(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::cpu_usage() {
        Ok(times) => ok_fields(&[num(times.user), num(times.system)]),
        Err(err) => fail_io("uv_getrusage", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procThreadCpuUsage()` — the calling thread's user and system CPU time.
pub(crate) unsafe extern "C" fn proc_thread_cpu_usage(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::thread_cpu_usage() {
        Ok(times) => ok_fields(&[num(times.user), num(times.system)]),
        Err(err) => fail_io("uv_getrusage_thread", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procResourceUsage()` — `getrusage`, in Node's own field order.
pub(crate) unsafe extern "C" fn proc_resource_usage(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::resource_usage() {
        Ok(usage) => ok_fields(&[
            num(usage.user_cpu_time),
            num(usage.system_cpu_time),
            num(usage.max_rss),
            num(usage.shared_memory_size),
            num(usage.unshared_data_size),
            num(usage.unshared_stack_size),
            num(usage.minor_page_fault),
            num(usage.major_page_fault),
            num(usage.swapped_out),
            num(usage.fs_read),
            num(usage.fs_write),
            num(usage.ipc_sent),
            num(usage.ipc_received),
            num(usage.signals_count),
            num(usage.voluntary_context_switches),
            num(usage.involuntary_context_switches),
        ]),
        Err(err) => fail_io("uv_getrusage", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procAvailableMemory()` — bytes this process may still allocate.
pub(crate) unsafe extern "C" fn proc_available_memory(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    unsafe { ret_f64(out, sys::available_memory()) }
}

/// `procConstrainedMemory()` — the cgroup memory limit, or `0` when there is
/// none.
pub(crate) unsafe extern "C" fn proc_constrained_memory(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    unsafe { ret_f64(out, sys::constrained_memory()) }
}

/// `procKill(pid, signal)` — libuv's `uv_kill`.
///
/// The pid and the signal number have already been validated by the TS layer,
/// which is also where Node validates them (an unknown signal *name* is an
/// `ERR_UNKNOWN_SIGNAL` before any syscall happens).
pub(crate) unsafe extern "C" fn proc_kill(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let pid = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let signal = unsafe { arg_i64(args, n, 1) };
    let payload = match (i32::try_from(pid), i32::try_from(signal)) {
        (Ok(pid), Ok(signal)) => match sys::kill(pid, signal) {
            Ok(()) => ok(),
            Err(err) => fail_io("uv_kill", &err),
        },
        _ => fail_code("uv_kill", "EINVAL", "", ""),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procChdir(directory)` — libuv's `uv_chdir`.
///
/// The failure carries both paths Node reports: the working directory the call
/// was made from, and the directory it could not reach.
pub(crate) unsafe extern "C" fn proc_chdir(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let payload = match unsafe { arg_str(args, n, 0) } {
        Err(_) => fail_code("uv_chdir", "EINVAL", "", ""),
        Ok(directory) => {
            let from = std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            match sys::chdir(directory) {
                Ok(()) => ok(),
                Err(err) => fail_io_paths("chdir", &err, &from, directory),
            }
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `procUmask(mask, set)` — libuv's `uv_os_umask`, returning the previous mask.
///
/// `set` is the flag that distinguishes `process.umask()` (read) from
/// `process.umask(mask)` (set), because the ABI has no optional argument and
/// `0` is a perfectly good mask to set.
pub(crate) unsafe extern "C" fn proc_umask(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let mask = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let set = unsafe { arg_bool(args, n, 1) };
    let requested = if set { Some(mask as u32) } else { None };
    let payload = match sys::umask(requested) {
        Ok(previous) => ok_one(&previous.to_string()),
        Err(err) => fail_io("uv_os_umask", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procEnviron()` — the whole environment block, one `name US value` record
/// per variable.
///
/// A variable name or value can hold any byte but NUL, so in principle a value
/// could contain a separator. In practice neither a C0 control character nor a
/// `=` inside a *name* survives the platform's own environment block, and the
/// same argument covers `node:os`'s payloads; a name is reported verbatim so
/// Windows' per-drive `=C:` entries arrive intact.
pub(crate) unsafe extern "C" fn proc_environ(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let mut records: Vec<Vec<String>> = Vec::new();
    for (name, value) in std::env::vars_os() {
        records.push(vec![
            name.to_string_lossy().into_owned(),
            value.to_string_lossy().into_owned(),
        ]);
    }
    unsafe { ret_str(out, &ok_records(&records)) }
}

/// `procSetEnv(name, value, remove)` — `setenv`/`unsetenv` for the real
/// process environment, so a variable a program sets is inherited by a child
/// this runtime spawns through any route, not only through `node:child_process`.
pub(crate) unsafe extern "C" fn proc_set_env(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let name = unsafe { arg_str(args, n, 0) };
    // SAFETY: as above.
    let value = unsafe { arg_str(args, n, 1) };
    // SAFETY: as above.
    let remove = unsafe { arg_bool(args, n, 2) };
    let payload = match name {
        Err(_) => fail_code("uv_os_setenv", "EINVAL", "", ""),
        // An empty name is not a variable on either platform; Node's own
        // `process.env[''] = ''` is silently dropped, which is what this is.
        Ok(name) if name.is_empty() => ok(),
        Ok(name) => {
            if remove {
                std::env::remove_var(name);
            } else {
                std::env::set_var(name, value.unwrap_or_default());
            }
            ok()
        }
    };
    unsafe { ret_str(out, &payload) }
}

/// `procCredentials()` — uid, gid, euid, egid and the comma-separated
/// supplementary groups. `ENOSYS` on Windows, where Node has none of them.
pub(crate) unsafe extern "C" fn proc_credentials(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::credentials() {
        Ok(credentials) => ok_fields(&[
            credentials.uid.to_string(),
            credentials.gid.to_string(),
            credentials.euid.to_string(),
            credentials.egid.to_string(),
            credentials
                .groups
                .iter()
                .map(|gid| gid.to_string())
                .collect::<Vec<String>>()
                .join(","),
        ]),
        Err(err) => fail_io("uv_os_getuid", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procTitle()` — libuv's `uv_get_process_title`.
pub(crate) unsafe extern "C" fn proc_title(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let payload = match sys::title() {
        Ok(title) => ok_one(&title),
        Err(err) => fail_io("uv_get_process_title", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `procSetTitle(title)` — libuv's `uv_set_process_title`. See the platform
/// notes: what it can actually rewrite differs, and `../process.ts` remembers
/// the value either way so `process.title` round-trips.
pub(crate) unsafe extern "C" fn proc_set_title(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let payload = match unsafe { arg_str(args, n, 0) } {
        Err(_) => fail_code("uv_set_process_title", "EINVAL", "", ""),
        Ok(title) => match sys::set_title(title) {
            Ok(()) => ok(),
            Err(err) => fail_io("uv_set_process_title", &err),
        },
    };
    unsafe { ret_str(out, &payload) }
}

/// `procIsTty(fd)` — whether a standard descriptor is a character device, which
/// is what `process.stdout.isTTY` reports.
pub(crate) unsafe extern "C" fn proc_is_tty(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let fd = unsafe { arg_i64(args, n, 0) };
    let answer = i32::try_from(fd).map(sys::is_tty).unwrap_or(false);
    unsafe { ret_bool(out, answer) }
}

/// `procAbort()` — `process.abort()`, which Node documents as "exit
/// immediately, generating a core file".
///
/// `std::process::abort` raises `SIGABRT` (or calls `abort()` on Windows), so
/// this never returns and the `out` value is never read. It is a `Str` return
/// only because every fallible native in this module is.
pub(crate) unsafe extern "C" fn proc_abort(
    _: *const ZunValue,
    _: usize,
    _out: *mut ZunValue,
) -> i32 {
    std::process::abort()
}

/// The `node:process` functions published to the host. Every key is
/// `proc`-prefixed: the checker rejects a program whenever one *name* is
/// registered by two modules, even through a namespace import that already
/// names the module (<https://github.com/UrubuCode/zun/issues/35>), so each
/// module in this library picks keys no other module uses. `node:os` already
/// publishes `pid`, `arch`, `platform` and `uptime` under their bare names.
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    // identity (sys::facts)
    Descriptor { key: b"procFacts\0", params: &[], ret: Str, invoke: proc_facts },
    Descriptor { key: b"procTitle\0", params: &[], ret: Str, invoke: proc_title },
    Descriptor { key: b"procSetTitle\0", params: &[Str], ret: Str, invoke: proc_set_title },
    Descriptor { key: b"procCredentials\0", params: &[], ret: Str, invoke: proc_credentials },
    // time and resources
    Descriptor { key: b"procHrtime\0", params: &[], ret: Str, invoke: proc_hrtime },
    Descriptor { key: b"procUptime\0", params: &[], ret: Str, invoke: proc_uptime },
    Descriptor { key: b"procCpuUsage\0", params: &[], ret: Str, invoke: proc_cpu_usage },
    Descriptor {
        key: b"procThreadCpuUsage\0",
        params: &[],
        ret: Str,
        invoke: proc_thread_cpu_usage,
    },
    Descriptor { key: b"procResourceUsage\0", params: &[], ret: Str, invoke: proc_resource_usage },
    Descriptor { key: b"procMemoryUsage\0", params: &[], ret: Str, invoke: proc_memory_usage },
    Descriptor {
        key: b"procAvailableMemory\0",
        params: &[],
        ret: F64,
        invoke: proc_available_memory,
    },
    Descriptor {
        key: b"procConstrainedMemory\0",
        params: &[],
        ret: F64,
        invoke: proc_constrained_memory,
    },
    // process control
    Descriptor { key: b"procKill\0", params: &[I64, I64], ret: Str, invoke: proc_kill },
    Descriptor { key: b"procChdir\0", params: &[Str], ret: Str, invoke: proc_chdir },
    Descriptor { key: b"procUmask\0", params: &[I64, Bool], ret: Str, invoke: proc_umask },
    Descriptor { key: b"procAbort\0", params: &[], ret: Str, invoke: proc_abort },
    // the environment block
    Descriptor { key: b"procEnviron\0", params: &[], ret: Str, invoke: proc_environ },
    Descriptor {
        key: b"procSetEnv\0",
        params: &[Str, Str, Bool],
        ret: Str,
        invoke: proc_set_env,
    },
    // standard descriptors
    Descriptor { key: b"procIsTty\0", params: &[I64], ret: Bool, invoke: proc_is_tty },
    // Error retrieval (the ABI v1 error-slot convention, see ../lib.rs). The
    // names are `proc`-prefixed for the same reason as every key above.
    Descriptor { key: b"procErrorCode\0", params: &[], ret: Str, invoke: crate::last_error_code },
    Descriptor {
        key: b"procErrorMessage\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_message,
    },
    Descriptor {
        key: b"procErrorSyscall\0",
        params: &[],
        ret: Str,
        invoke: crate::last_error_syscall,
    },
    Descriptor { key: b"procErrorErrno\0", params: &[], ret: I64, invoke: crate::last_error_errno },
    Descriptor { key: b"procErrorPath\0", params: &[], ret: Str, invoke: crate::last_error_path },
    Descriptor { key: b"procErrorDest\0", params: &[], ret: Str, invoke: crate::last_error_dest },
];

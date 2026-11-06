//! `spawnSync` — run one child process to completion.
//!
//! `std::process::Command` covers the easy part. The three things it does not
//! do, and that libuv's `uv_spawn_sync` does, are implemented here:
//!
//!   1. **Feeding stdin without deadlocking.** Writing the whole input before
//!      reading the child's output deadlocks as soon as the child fills a pipe
//!      buffer, so the writer and both readers each run on their own thread.
//!   2. **A timeout with a chosen kill signal.** `Child::kill` is
//!      `TerminateProcess` on Windows and `SIGKILL` on Unix; Node's default
//!      `killSignal` is `SIGTERM`, so on Unix the signal is delivered with
//!      `libc::kill` and only Windows (which has no signals — libuv's `uv_kill`
//!      terminates the process whatever the signal) falls back to `kill()`.
//!   3. **`maxBuffer`.** A pipe that produces more than `maxBuffer` bytes is
//!      truncated there and the result carries `ENOBUFS`, as Node reports.

use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use zun_abi::ZunValue;

use super::{RS, US};
use crate::abi;
use crate::fs::base64;

/// How often the wait loop checks a timed child. Short enough that the measured
/// kill time stays close to the requested timeout, long enough not to spin.
const POLL_INTERVAL: Duration = Duration::from_millis(2);

/// What to do with one of the child's three standard streams.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pipe {
    /// `'pipe'` — captured and returned.
    Capture,
    /// `'inherit'` — the parent's own handle.
    Inherit,
    /// `'ignore'` — the null device.
    Ignore,
}

impl Pipe {
    fn parse(field: &str) -> Self {
        match field {
            "inherit" => Pipe::Inherit,
            "ignore" => Pipe::Ignore,
            _ => Pipe::Capture,
        }
    }

    fn stdio(self) -> Stdio {
        match self {
            Pipe::Capture => Stdio::piped(),
            Pipe::Inherit => Stdio::inherit(),
            Pipe::Ignore => Stdio::null(),
        }
    }
}

/// One decoded `cpSpawnSync` request. See the module documentation for the wire
/// grammar.
///
/// Three fields are platform-specific — `detached`, `uid` and `gid` are POSIX
/// only, `windows_hide` is Windows only — so each is dead on the other target.
/// They are parsed on both so the wire format has one shape, and
/// [`apply_platform_options`] is the single place that knows which apply where.
#[derive(Debug)]
#[cfg_attr(not(unix), allow(dead_code))]
struct Request {
    argv: Vec<String>,
    cwd: Option<String>,
    /// Milliseconds; `0` means "no timeout", which is also Node's encoding.
    timeout: u64,
    kill_signal: String,
    /// `u64::MAX` stands for `Infinity`, which Node accepts.
    max_buffer: u64,
    stdin: Pipe,
    stdout: Pipe,
    stderr: Pipe,
    windows_hide: bool,
    detached: bool,
    /// Whether the `env` record replaces the inherited environment. Node always
    /// passes a complete block, so this is set whenever the caller gave one.
    use_env: bool,
    env: Vec<(String, String)>,
    uid: Option<u32>,
    gid: Option<u32>,
    /// Windows only: pass the argument vector to `CreateProcess` verbatim,
    /// without MSVCRT quoting. libuv sets `UV_PROCESS_WINDOWS_VERBATIM_ARGUMENTS`
    /// here, and Node sets the flag itself whenever it builds a `cmd.exe /d /s /c`
    /// command line — `cmd.exe` re-parses its own tail, so a second round of
    /// quoting would reach the shell as part of the command.
    windows_verbatim: bool,
    input: Vec<u8>,
}

/// The reply built for the TypeScript layer.
#[derive(Default, Debug)]
struct Reply {
    status: Option<i32>,
    signal: Option<String>,
    pid: u32,
    stdout: Option<Vec<u8>>,
    stderr: Option<Vec<u8>>,
    error: Option<(&'static str, &'static str, i64)>,
    timed_out: bool,
}

impl Reply {
    fn encode(&self, file: &str) -> String {
        let mut fields: Vec<String> = Vec::with_capacity(12);
        fields.push(match self.status {
            Some(code) => code.to_string(),
            None => String::new(),
        });
        fields.push(self.signal.clone().unwrap_or_default());
        fields.push(self.pid.to_string());
        fields.push(match &self.stdout {
            Some(bytes) => base64::encode(bytes),
            None => String::new(),
        });
        fields.push(match &self.stderr {
            Some(bytes) => base64::encode(bytes),
            None => String::new(),
        });
        fields.push(if self.stdout.is_some() { "1".to_owned() } else { "0".to_owned() });
        fields.push(if self.stderr.is_some() { "1".to_owned() } else { "0".to_owned() });
        match self.error {
            Some((code, description, errno)) => {
                fields.push(code.to_owned());
                fields.push(description.to_owned());
                fields.push(format!("spawnSync {file}"));
                fields.push(errno.to_string());
            }
            None => {
                fields.push(String::new());
                fields.push(String::new());
                fields.push(String::new());
                fields.push("0".to_owned());
            }
        }
        fields.push(if self.timed_out { "1".to_owned() } else { "0".to_owned() });

        let mut out = String::from("+");
        for (index, field) in fields.iter().enumerate() {
            if index > 0 {
                out.push(US);
            }
            out.push_str(field);
        }
        out
    }
}

/// Node's `(code, uv_strerror description, libuv errno)` for the codes a spawn
/// can produce. Kept beside `node:os`'s table rather than shared with it,
/// because the two modules need different rows and the Windows errno values are
/// libuv's own reserved range (`include/uv/errno.h`) either way.
fn uv_error(code: &str) -> (&'static str, &'static str, i64) {
    match code {
        "EACCES" => ("EACCES", "permission denied", uv_errno(13, -4092)),
        "EAGAIN" => ("EAGAIN", "resource temporarily unavailable", uv_errno(11, -4088)),
        "EINVAL" => ("EINVAL", "invalid argument", uv_errno(22, -4071)),
        "EMFILE" => ("EMFILE", "too many open files", uv_errno(24, -4066)),
        "ENOBUFS" => ("ENOBUFS", "no buffer space available", uv_errno(105, -4060)),
        "ENOENT" => ("ENOENT", "no such file or directory", uv_errno(2, -4058)),
        "ENOMEM" => ("ENOMEM", "not enough memory", uv_errno(12, -4057)),
        "ENOTDIR" => ("ENOTDIR", "not a directory", uv_errno(20, -4052)),
        "EPERM" => ("EPERM", "operation not permitted", uv_errno(1, -4048)),
        "ETIMEDOUT" => ("ETIMEDOUT", "connection timed out", uv_errno(110, -4039)),
        "E2BIG" => ("E2BIG", "argument list too long", uv_errno(7, -4093)),
        _ => ("UNKNOWN", "unknown error", -4094),
    }
}

/// libuv reports `-errno` where the platform has an errno and a value out of its
/// own reserved range where it does not, which is Windows.
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

/// The libuv code for a failed spawn. `std` reports `NotFound` for both a
/// missing executable and a missing `cwd`; both are `ENOENT` in libuv too.
fn spawn_error_code(err: &std::io::Error) -> &'static str {
    match err.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        std::io::ErrorKind::InvalidInput => "EINVAL",
        std::io::ErrorKind::OutOfMemory => "ENOMEM",
        _ => match err.raw_os_error() {
            // Windows: ERROR_BAD_EXE_FORMAT / ERROR_DIRECTORY.
            Some(193) | Some(267) => "ENOENT",
            _ => "UNKNOWN",
        },
    }
}

fn split_fields(record: &str) -> Vec<&str> {
    if record.is_empty() {
        Vec::new()
    } else {
        record.split(US).collect()
    }
}

fn field<'a>(fields: &[&'a str], index: usize) -> &'a str {
    fields.get(index).copied().unwrap_or("")
}

fn parse_request(text: &str) -> Option<Request> {
    let mut records = text.split(RS);
    let header = split_fields(records.next()?);
    let argv_record = records.next().unwrap_or("");
    let env_record = records.next().unwrap_or("");
    let input_record = records.next().unwrap_or("");

    let argv: Vec<String> = split_fields(argv_record).iter().map(|s| (*s).to_owned()).collect();
    if argv.is_empty() {
        return None;
    }

    let cwd = {
        let raw = field(&header, 0);
        if raw.is_empty() {
            None
        } else {
            Some(raw.to_owned())
        }
    };
    let timeout: u64 = field(&header, 1).parse().unwrap_or(0);
    let kill_signal = {
        let raw = field(&header, 2);
        if raw.is_empty() {
            "SIGTERM".to_owned()
        } else {
            raw.to_owned()
        }
    };
    // `Infinity` arrives as the literal word, because that is what
    // `String(Infinity)` produces on the TypeScript side.
    let max_buffer_raw = field(&header, 3);
    let max_buffer = if max_buffer_raw.is_empty() || max_buffer_raw == "Infinity" {
        u64::MAX
    } else {
        max_buffer_raw.parse::<f64>().map(|v| v.max(0.0) as u64).unwrap_or(u64::MAX)
    };
    let use_env = field(&header, 9) == "1";
    let env: Vec<(String, String)> = if use_env {
        split_fields(env_record)
            .iter()
            .filter_map(|pair| pair.split_once('=').map(|(k, v)| (k.to_owned(), v.to_owned())))
            .collect()
    } else {
        Vec::new()
    };

    Some(Request {
        argv,
        cwd,
        timeout,
        kill_signal,
        max_buffer,
        stdin: Pipe::parse(field(&header, 4)),
        stdout: Pipe::parse(field(&header, 5)),
        stderr: Pipe::parse(field(&header, 6)),
        windows_hide: field(&header, 7) == "1",
        detached: field(&header, 8) == "1",
        use_env,
        env,
        uid: field(&header, 10).parse().ok(),
        gid: field(&header, 11).parse().ok(),
        windows_verbatim: field(&header, 12) == "1",
        input: base64::decode(input_record),
    })
}

/// POSIX signal numbers for the names Node's `constants.signals` carries, which
/// is what `convertToValidSignal` has already narrowed the request to. Windows
/// has no signals at all — libuv's `uv_kill` terminates the process for any of
/// them — so this is only reachable on POSIX.
#[cfg_attr(not(unix), allow(dead_code))]
fn signal_number(name: &str) -> Option<i32> {
    let number = match name {
        "SIGHUP" => 1,
        "SIGINT" => 2,
        "SIGQUIT" => 3,
        "SIGILL" => 4,
        "SIGTRAP" => 5,
        "SIGABRT" | "SIGIOT" => 6,
        "SIGBUS" => 7,
        "SIGFPE" => 8,
        "SIGKILL" => 9,
        "SIGUSR1" => 10,
        "SIGSEGV" => 11,
        "SIGUSR2" => 12,
        "SIGPIPE" => 13,
        "SIGALRM" => 14,
        "SIGTERM" => 15,
        "SIGCHLD" => 17,
        "SIGCONT" => 18,
        "SIGSTOP" => 19,
        "SIGTSTP" => 20,
        "SIGTTIN" => 21,
        "SIGTTOU" => 22,
        "SIGURG" => 23,
        "SIGXCPU" => 24,
        "SIGXFSZ" => 25,
        "SIGVTALRM" => 26,
        "SIGPROF" => 27,
        "SIGWINCH" => 28,
        "SIGIO" | "SIGPOLL" => 29,
        "SIGSYS" => 31,
        _ => return None,
    };
    Some(number)
}

/// The signal name for a number, used to report a child that died on a signal.
fn signal_name(number: i32) -> String {
    let name = match number {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        5 => "SIGTRAP",
        6 => "SIGABRT",
        7 => "SIGBUS",
        8 => "SIGFPE",
        9 => "SIGKILL",
        10 => "SIGUSR1",
        11 => "SIGSEGV",
        12 => "SIGUSR2",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        17 => "SIGCHLD",
        18 => "SIGCONT",
        19 => "SIGSTOP",
        20 => "SIGTSTP",
        21 => "SIGTTIN",
        22 => "SIGTTOU",
        23 => "SIGURG",
        24 => "SIGXCPU",
        25 => "SIGXFSZ",
        26 => "SIGVTALRM",
        27 => "SIGPROF",
        28 => "SIGWINCH",
        29 => "SIGIO",
        31 => "SIGSYS",
        _ => return format!("SIG{number}"),
    };
    name.to_owned()
}

/// Deliver `signal` to `child`. On Unix the requested signal is sent with
/// `libc::kill`, because `Child::kill` is hard-wired to `SIGKILL` and Node's
/// default is `SIGTERM`. Windows has no signals: libuv's `uv_kill` terminates
/// the process for any signal but `SIGCONT`/0, so `Child::kill` is the faithful
/// behaviour there.
fn deliver_signal(child: &mut Child, signal: &str) {
    #[cfg(unix)]
    {
        if let Some(number) = signal_number(signal) {
            // SAFETY: `child.id()` is this process's own child, and `kill` with
            // a valid signal number has no safety requirement beyond that.
            unsafe {
                libc::kill(child.id() as libc::pid_t, number);
            }
            return;
        }
        let _ = child.kill();
    }
    #[cfg(not(unix))]
    {
        let _ = signal;
        let _ = child.kill();
    }
}

/// Append the argument vector. With `windowsVerbatimArguments` the arguments go
/// on the command line exactly as given (`raw_arg`), because `Command::arg`
/// applies MSVCRT quoting and `cmd.exe /d /s /c "<command>"` must reach the shell
/// with its own quotes intact — double-quoting it turns the whole command into an
/// unknown program name.
fn push_args(command: &mut Command, request: &Request) {
    #[cfg(windows)]
    if request.windows_verbatim {
        use std::os::windows::process::CommandExt;
        for argument in &request.argv[1..] {
            command.raw_arg(argument);
        }
        return;
    }
    command.args(&request.argv[1..]);
}

/// Apply the platform-specific options `Command` exposes behind an extension
/// trait: the Windows "no console window" creation flag and the POSIX
/// `setsid`/`setuid`/`setgid` work.
fn apply_platform_options(command: &mut Command, request: &Request) {
    #[cfg(windows)]
    {
        if request.windows_hide {
            use std::os::windows::process::CommandExt;
            // CREATE_NO_WINDOW, which is what libuv sets for
            // UV_PROCESS_WINDOWS_HIDE_CONSOLE.
            command.creation_flags(0x0800_0000);
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        if let Some(uid) = request.uid {
            command.uid(uid);
        }
        if let Some(gid) = request.gid {
            command.gid(gid);
        }
        if request.detached {
            // SAFETY: `setsid` is async-signal-safe and allocates nothing,
            // which is the requirement `pre_exec` imposes.
            unsafe {
                command.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (command, request);
    }
}

/// Read one of the child's pipes on its own thread, stopping once `limit` bytes
/// have been collected plus one — the extra byte is what tells the caller the
/// stream overflowed `maxBuffer` rather than ending exactly at it.
fn reader_thread<R: Read + Send + 'static>(
    mut source: R,
    limit: u64,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut collected: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    collected.extend_from_slice(&chunk[..read]);
                    if limit != u64::MAX && collected.len() as u64 > limit {
                        break;
                    }
                }
            }
        }
        collected
    })
}

/// Run the request. Returns the reply, never an error: a failed spawn is a
/// reply with its `error` field set, which is what Node's `spawnSync` hands
/// back.
fn run(request: &Request) -> Reply {
    let mut reply = Reply::default();
    let file = &request.argv[0];

    let mut command = Command::new(file);
    push_args(&mut command, request);
    if let Some(cwd) = &request.cwd {
        command.current_dir(cwd);
    }
    if request.use_env {
        command.env_clear();
        for (key, value) in &request.env {
            command.env(key, value);
        }
    }
    // An `input` to write implies a pipe on stdin whatever the stdio entry says,
    // which is exactly what Node's `spawnSync` does when `options.input` is set.
    let stdin_mode = if request.input.is_empty() { request.stdin } else { Pipe::Capture };
    command.stdin(stdin_mode.stdio());
    command.stdout(request.stdout.stdio());
    command.stderr(request.stderr.stdio());
    apply_platform_options(&mut command, request);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            reply.error = Some(uv_error(spawn_error_code(&err)));
            // Node reports `output: [null, null, null]` for a child that never
            // started, so neither pipe is marked captured.
            return reply;
        }
    };
    reply.pid = child.id();

    // One thread per stream. Writing the input inline would deadlock as soon as
    // the child filled its own stdout pipe.
    let writer = child.stdin.take().map(|mut sink| {
        let payload = request.input.clone();
        std::thread::spawn(move || {
            let _ = sink.write_all(&payload);
            let _ = sink.flush();
            // Dropping the handle closes the pipe, which is what lets a child
            // reading to EOF finish.
        })
    });
    let out_reader = child.stdout.take().map(|pipe| reader_thread(pipe, request.max_buffer));
    let err_reader = child.stderr.take().map(|pipe| reader_thread(pipe, request.max_buffer));

    let status = if request.timeout > 0 {
        let deadline = Instant::now() + Duration::from_millis(request.timeout);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        reply.timed_out = true;
                        deliver_signal(&mut child, &request.kill_signal);
                        break child.wait().ok();
                    }
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(_) => break None,
            }
        }
    } else {
        child.wait().ok()
    };

    if let Some(handle) = writer {
        let _ = handle.join();
    }
    let mut overflowed = false;
    if let Some(handle) = out_reader {
        let mut bytes = handle.join().unwrap_or_default();
        if request.max_buffer != u64::MAX && bytes.len() as u64 > request.max_buffer {
            bytes.truncate(request.max_buffer as usize);
            overflowed = true;
        }
        reply.stdout = Some(bytes);
    }
    if let Some(handle) = err_reader {
        let mut bytes = handle.join().unwrap_or_default();
        if request.max_buffer != u64::MAX && bytes.len() as u64 > request.max_buffer {
            bytes.truncate(request.max_buffer as usize);
            overflowed = true;
        }
        reply.stderr = Some(bytes);
    }

    match status {
        Some(status) => {
            let signalled = unix_signal(&status);
            match signalled {
                Some(number) => reply.signal = Some(signal_name(number)),
                None => reply.status = Some(status.code().unwrap_or(0)),
            }
        }
        None => reply.status = None,
    }

    // A timed-out child is reported with `signal` set to the kill signal and
    // `status` null, plus an `ETIMEDOUT` error — Windows included, where the
    // process is terminated rather than signalled but Node still names the
    // signal it asked for.
    if reply.timed_out {
        reply.status = None;
        reply.signal = Some(request.kill_signal.clone());
        reply.error = Some(uv_error("ETIMEDOUT"));
    } else if overflowed {
        reply.error = Some(uv_error("ENOBUFS"));
    }

    reply
}

/// The signal a child died on, where the platform reports one.
#[allow(unused_variables)]
fn unix_signal(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    }
    #[cfg(not(unix))]
    {
        None
    }
}

/// `cpSpawnSync(request)` — see the module documentation for both grammars.
///
/// # Safety
/// `args` must point to one initialized `Str` [`ZunValue`] whose payload is a
/// valid NUL-terminated pointer the host owns for the call, and `out` must be a
/// writable [`ZunValue`].
pub(crate) unsafe extern "C" fn spawn_sync(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let text = match unsafe { abi::arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let Some(request) = parse_request(text) else {
        return unsafe { abi::ret_str(out, "-") };
    };
    let file = request.argv[0].clone();
    let reply = run(&request);
    unsafe { abi::ret_str(out, &reply.encode(&file)) }
}

/// `cpExecPath()` — the absolute path of the running interpreter, which is what
/// `process.execPath` reports.
///
/// Inside an extension this is the *host* process's executable, i.e. the `zun`
/// binary that loaded this library. That is the honest answer, and it is worth
/// stating what it does and does not buy: a Node test that re-runs itself with
/// `spawnSync(process.execPath, [__filename])` will start a `zun` binary and
/// hand it a raw CommonJS test file, which the engine cannot run — it has no
/// `require` (<https://github.com/UrubuCode/zun/issues/4>) and the test would
/// need to be bundled first. `execPath` is right; the re-run pattern is what
/// does not work, and `child_process.ts` documents it.
///
/// # Safety
/// `out` must point to a writable [`ZunValue`] the host initialized for a `Str`
/// return.
pub(crate) unsafe extern "C" fn exec_path(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let path = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    unsafe { abi::ret_str(out, &path) }
}

//! `node:child_process` native tests.
//!
//! The wire grammar is exercised through the real entry point — a request
//! string in, a reply string out — so the parser and the encoder are tested
//! together with the spawn itself, which is the only way a carrier convention
//! can actually be checked.
//!
//! The commands are chosen to exist on both platforms without a shell:
//! `cmd /c ...` on Windows and `/bin/sh -c ...` on POSIX, which is what the
//! TypeScript layer builds for `shell: true` anyway.

use super::spawn;
use super::{RS, US};
use core::ffi::c_char;
use std::ffi::CString;

use zun_abi::{ZunTy, ZunTyRepr, ZunValue};

/// One request, built field by field so a test reads like the grammar.
struct Request {
    cwd: String,
    timeout: u64,
    kill_signal: String,
    max_buffer: String,
    stdio: [&'static str; 3],
    windows_hide: bool,
    detached: bool,
    use_env: bool,
    uid: String,
    gid: String,
    verbatim: bool,
    argv: Vec<String>,
    env: Vec<String>,
    input: String,
}

impl Request {
    fn new(argv: &[&str]) -> Self {
        Request {
            cwd: String::new(),
            timeout: 0,
            kill_signal: "SIGTERM".to_owned(),
            max_buffer: "Infinity".to_owned(),
            stdio: ["pipe", "pipe", "pipe"],
            windows_hide: false,
            detached: false,
            use_env: false,
            uid: String::new(),
            gid: String::new(),
            verbatim: false,
            argv: argv.iter().map(|s| (*s).to_owned()).collect(),
            env: Vec::new(),
            input: String::new(),
        }
    }

    fn encode(&self) -> String {
        let header = [
            self.cwd.clone(),
            self.timeout.to_string(),
            self.kill_signal.clone(),
            self.max_buffer.clone(),
            self.stdio[0].to_owned(),
            self.stdio[1].to_owned(),
            self.stdio[2].to_owned(),
            if self.windows_hide { "1" } else { "0" }.to_owned(),
            if self.detached { "1" } else { "0" }.to_owned(),
            if self.use_env { "1" } else { "0" }.to_owned(),
            self.uid.clone(),
            self.gid.clone(),
            if self.verbatim { "1" } else { "0" }.to_owned(),
        ];
        let mut out = header.join(&US.to_string());
        out.push(RS);
        out.push_str(&self.argv.join(&US.to_string()));
        out.push(RS);
        out.push_str(&self.env.join(&US.to_string()));
        out.push(RS);
        out.push_str(&self.input);
        out
    }
}

/// Call `cpSpawnSync` the way the host does and split the reply into fields.
fn call(request: &Request) -> Vec<String> {
    let encoded = CString::new(request.encode()).expect("no NUL in a request");
    let argument = ZunValue {
        ty: ZunTyRepr::from(ZunTy::Str),
        reserved: 0,
        payload: encoded.as_ptr() as *const c_char as u64,
    };
    let mut out = ZunValue { ty: ZunTyRepr::from(ZunTy::Str), reserved: 0, payload: 0 };
    // SAFETY: one initialized `Str` argument whose payload outlives the call,
    // and a writable `out`.
    let status = unsafe { spawn::spawn_sync(&argument, 1, &mut out) };
    assert_eq!(status, 0, "the native never fails the call itself");
    // SAFETY: the native wrote a NUL-terminated pointer into the per-thread
    // scratch buffer, valid until the next call on this thread.
    let reply = unsafe { core::ffi::CStr::from_ptr(out.payload as *const c_char) }
        .to_str()
        .expect("a reply is UTF-8")
        .to_owned();
    assert!(reply.starts_with('+'), "reply was {reply:?}");
    reply[1..].split(US).map(|s| s.to_owned()).collect()
}

fn decode_base64(text: &str) -> String {
    String::from_utf8(crate::fs::base64::decode(text)).expect("UTF-8 output")
}

/// `cmd /c <command>` on Windows, `/bin/sh -c <command>` elsewhere — the two
/// shells the TypeScript layer selects, so a test command is written once.
fn shell(command: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec!["cmd".to_owned(), "/c".to_owned(), command.to_owned()]
    }
    #[cfg(not(windows))]
    {
        vec!["/bin/sh".to_owned(), "-c".to_owned(), command.to_owned()]
    }
}

fn shell_request(command: &str) -> Request {
    let argv = shell(command);
    let refs: Vec<&str> = argv.iter().map(|s| s.as_str()).collect();
    Request::new(&refs)
}

#[test]
fn captures_stdout_and_a_zero_status() {
    let fields = call(&shell_request("echo hello"));
    assert_eq!(fields[0], "0", "status");
    assert_eq!(fields[1], "", "no signal");
    assert_ne!(fields[2], "0", "a pid was reported");
    assert_eq!(decode_base64(&fields[3]).trim(), "hello");
    assert_eq!(fields[5], "1", "stdout was piped");
    assert_eq!(fields[7], "", "no error");
}

#[test]
fn reports_a_non_zero_status() {
    let fields = call(&shell_request("exit 3"));
    assert_eq!(fields[0], "3");
    assert_eq!(fields[7], "");
}

#[test]
fn captures_stderr_separately() {
    let command = if cfg!(windows) { "echo oops 1>&2" } else { "echo oops 1>&2" };
    let fields = call(&shell_request(command));
    assert_eq!(decode_base64(&fields[3]), "", "stdout stayed empty");
    assert_eq!(decode_base64(&fields[4]).trim(), "oops");
}

#[test]
fn a_missing_program_is_enoent_not_a_failed_call() {
    let fields = call(&Request::new(&["zun_node_no_such_program_exists"]));
    assert_eq!(fields[0], "", "no status: the child never ran");
    assert_eq!(fields[7], "ENOENT");
    assert_eq!(fields[8], "no such file or directory");
    assert_eq!(fields[9], "spawnSync zun_node_no_such_program_exists");
    assert_eq!(fields[5], "0", "nothing was piped");
}

#[test]
fn writes_input_to_the_child_stdin() {
    // `sort` with no arguments is a filter on both platforms.
    let mut request = shell_request("sort");
    request.input = crate::fs::base64::encode(b"b\na\n");
    let fields = call(&request);
    let out = decode_base64(&fields[3]);
    // Some Windows hosts' `sort` writes a UTF-8 byte-order mark first.
    let out = out.trim_start_matches('\u{feff}');
    assert!(out.starts_with('a'), "sorted output was {out:?}");
}

#[test]
fn ignored_stdio_is_not_captured() {
    let mut request = shell_request("echo hidden");
    request.stdio = ["ignore", "ignore", "ignore"];
    let fields = call(&request);
    assert_eq!(fields[5], "0");
    assert_eq!(fields[6], "0");
    assert_eq!(fields[3], "");
}

#[test]
fn max_buffer_truncates_and_reports_enobufs() {
    let mut request = shell_request("echo abcdefghij");
    request.max_buffer = "3".to_owned();
    let fields = call(&request);
    assert_eq!(decode_base64(&fields[3]).len(), 3);
    assert_eq!(fields[7], "ENOBUFS");
}

#[test]
fn an_exact_fit_is_not_enobufs() {
    let mut request = shell_request("echo ab");
    // "ab" plus the platform's line ending.
    let newline = if cfg!(windows) { 2 } else { 1 };
    request.max_buffer = (2 + newline).to_string();
    let fields = call(&request);
    assert_eq!(fields[7], "", "output fitting exactly is not an overflow");
}

#[test]
fn a_timeout_kills_the_child_and_reports_the_signal() {
    // A command that outlives the timeout on both platforms.
    let command = if cfg!(windows) { "ping -n 10 127.0.0.1" } else { "sleep 5" };
    let mut request = shell_request(command);
    request.timeout = 100;
    request.kill_signal = "SIGTERM".to_owned();
    let fields = call(&request);
    assert_eq!(fields[0], "", "a killed child has no exit status");
    assert_eq!(fields[1], "SIGTERM");
    assert_eq!(fields[7], "ETIMEDOUT");
    assert_eq!(fields[11], "1");
}

#[test]
fn the_environment_is_replaced_when_one_is_given() {
    let command = if cfg!(windows) { "echo %ZUN_NODE_PROBE%" } else { "echo $ZUN_NODE_PROBE" };
    let mut request = shell_request(command);
    request.use_env = true;
    request.env = vec!["ZUN_NODE_PROBE=marker".to_owned()];
    // The shell itself has to be findable, so the search path travels with it.
    for name in ["PATH", "Path", "SystemRoot", "windir", "PATHEXT", "COMSPEC"] {
        if let Ok(value) = std::env::var(name) {
            request.env.push(format!("{name}={value}"));
        }
    }
    let fields = call(&request);
    assert_eq!(decode_base64(&fields[3]).trim(), "marker");
}

#[test]
fn the_working_directory_is_honoured() {
    let temp = std::env::temp_dir();
    let command = if cfg!(windows) { "cd" } else { "pwd" };
    let mut request = shell_request(command);
    request.cwd = temp.to_string_lossy().into_owned();
    let fields = call(&request);
    assert_eq!(fields[7], "", "the spawn itself succeeded");
    let reported = decode_base64(&fields[3]).trim().to_lowercase();
    let expected = temp.to_string_lossy().to_lowercase();
    // `cd`/`pwd` may report the path without its trailing separator.
    assert!(
        expected.trim_end_matches(['/', '\\']).contains(reported.trim_end_matches(['/', '\\']))
            || reported.contains(expected.trim_end_matches(['/', '\\'])),
        "reported {reported:?}, expected around {expected:?}"
    );
}

#[test]
fn a_malformed_request_is_the_failure_marker() {
    let encoded = CString::new("").expect("empty is fine");
    let argument = ZunValue {
        ty: ZunTyRepr::from(ZunTy::Str),
        reserved: 0,
        payload: encoded.as_ptr() as *const c_char as u64,
    };
    let mut out = ZunValue { ty: ZunTyRepr::from(ZunTy::Str), reserved: 0, payload: 0 };
    // SAFETY: as in `call`.
    let status = unsafe { spawn::spawn_sync(&argument, 1, &mut out) };
    assert_eq!(status, 0);
    // SAFETY: as in `call`.
    let reply = unsafe { core::ffi::CStr::from_ptr(out.payload as *const c_char) }
        .to_str()
        .expect("UTF-8");
    assert_eq!(reply, "-");
}

#[test]
fn exec_path_is_the_running_executable() {
    let mut out = ZunValue { ty: ZunTyRepr::from(ZunTy::Str), reserved: 0, payload: 0 };
    // SAFETY: a writable `out` and no arguments, which is this native's shape.
    let status = unsafe { spawn::exec_path(core::ptr::null(), 0, &mut out) };
    assert_eq!(status, 0);
    // SAFETY: as in `call`.
    let reported = unsafe { core::ffi::CStr::from_ptr(out.payload as *const c_char) }
        .to_str()
        .expect("UTF-8");
    let expected = std::env::current_exe().expect("a current exe");
    assert_eq!(reported, expected.to_string_lossy());
}

/// The combination the TypeScript layer always sends: a replaced environment
/// *and* a working directory. Both work on their own, so this is the case that
/// says whether the two interact — on Windows the program is resolved against
/// the child's `PATH`, and the environment block being rebuilt is exactly when
/// that can go wrong.
#[test]
fn a_replaced_environment_and_a_working_directory_together() {
    let temp = std::env::temp_dir();
    let command = if cfg!(windows) { "cd" } else { "pwd" };
    let mut request = shell_request(command);
    request.cwd = temp.to_string_lossy().into_owned();
    request.use_env = true;
    for name in ["PATH", "SystemRoot", "windir", "PATHEXT", "COMSPEC"] {
        if let Ok(value) = std::env::var(name) {
            request.env.push(format!("{name}={value}"));
        }
    }
    let fields = call(&request);
    assert_eq!(fields[7], "", "the spawn succeeded; reply was {fields:?}");
}

/// An environment entry with an empty name, which is what Windows' per-drive
/// current directories (`=C:`) look like once they have been split on the first
/// `=`. `process.env` carries them (`win32.resolve` reads them), so they reach
/// this native on every call and must not break the environment block.
#[test]
fn an_empty_environment_name_does_not_break_the_spawn() {
    let command = if cfg!(windows) { "echo ok" } else { "echo ok" };
    let mut request = shell_request(command);
    request.use_env = true;
    request.env.push("=C:=C:\\".to_owned());
    for name in ["PATH", "SystemRoot", "windir", "PATHEXT", "COMSPEC"] {
        if let Ok(value) = std::env::var(name) {
            request.env.push(format!("{name}={value}"));
        }
    }
    let fields = call(&request);
    assert_eq!(fields[7], "", "reply was {fields:?}");
}

//! Tests for the asynchronous half (`asyncp.rs`), through the real ABI entry
//! points: a request string in, a reply string out, exactly as `child_process.ts`
//! calls them. Time-dependent assertions wait on [`asyncp::wait`] with a
//! generous bound rather than sleeping a fixed amount.

use super::asyncp;
use super::{RS, US};
use core::ffi::c_char;
use std::ffi::CString;
use std::time::{Duration, Instant};

use zun_abi::{ZunTy, ZunTyRepr, ZunValue};

type Native = unsafe extern "C" fn(*const ZunValue, usize, *mut ZunValue) -> i32;

enum Arg<'a> {
    Int(i64),
    Text(&'a str),
}

fn call(native: Native, args: &[Arg]) -> String {
    let owned: Vec<Option<CString>> = args
        .iter()
        .map(|arg| match arg {
            Arg::Text(text) => Some(CString::new(*text).expect("no NUL")),
            Arg::Int(_) => None,
        })
        .collect();
    let values: Vec<ZunValue> = args
        .iter()
        .zip(owned.iter())
        .map(|(arg, text)| match arg {
            Arg::Int(value) => {
                ZunValue { ty: ZunTyRepr::from(ZunTy::I64), reserved: 0, payload: *value as u64 }
            }
            Arg::Text(_) => ZunValue {
                ty: ZunTyRepr::from(ZunTy::Str),
                reserved: 0,
                payload: text.as_ref().unwrap().as_ptr() as *const c_char as u64,
            },
        })
        .collect();
    let mut out = ZunValue { ty: ZunTyRepr::from(ZunTy::Str), reserved: 0, payload: 0 };
    // SAFETY: the arguments match each native's descriptor and outlive the call.
    let status = unsafe { native(values.as_ptr(), values.len(), &mut out) };
    assert_eq!(status, 0);
    // SAFETY: the native wrote a NUL-terminated per-thread scratch string.
    unsafe { core::ffi::CStr::from_ptr(out.payload as *const c_char) }
        .to_str()
        .expect("UTF-8")
        .to_owned()
}

fn shell(command: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["cmd".into(), "/c".into(), command.into()]
    } else {
        vec!["/bin/sh".into(), "-c".into(), command.into()]
    }
}

fn request(argv: &[String], stdio: [&str; 3]) -> String {
    let header = [
        "", "0", "SIGTERM", "Infinity", stdio[0], stdio[1], stdio[2], "0", "0", "0", "", "", "0",
    ];
    format!("{}{RS}{}{RS}{RS}", header.join(&US.to_string()), argv.join(&US.to_string()))
}

struct Started {
    process: i64,
    stdin: i64,
    stdout: i64,
    stderr: i64,
    pid: i64,
}

fn spawn(argv: &[String], stdio: [&str; 3]) -> Started {
    let reply = call(asyncp::spawn_async, &[Arg::Text(&request(argv, stdio))]);
    let fields: Vec<&str> = reply.strip_prefix('+').expect("success").split(US).collect();
    assert_eq!(fields[0], "ok", "reply was {reply:?}");
    let number = |i: usize| fields[i].parse::<i64>().unwrap();
    Started { pid: number(1), process: number(2), stdin: number(3), stdout: number(4), stderr: number(5) }
}

/// Read a pipe to end of file, waiting for the reader thread as the loop would.
fn drain(id: i64) -> Vec<u8> {
    asyncp::set_interest(id, 1);
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut bytes = Vec::new();
    loop {
        let seen = asyncp::generation();
        let reply = call(asyncp::read, &[Arg::Int(id), Arg::Int(0)]);
        match &reply[..2] {
            "+D" => bytes.extend(crate::fs::base64::decode(&reply[2..])),
            "+E" => return bytes,
            _ => {
                assert!(Instant::now() < deadline, "timed out draining pipe {id}");
                asyncp::wait(seen, 50);
            }
        }
    }
}

/// Wait for the process to exit and answer `(code, signal)`.
fn exit_of(process: i64) -> (String, String) {
    asyncp::set_interest(process, 1);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let seen = asyncp::generation();
        let reply = call(asyncp::exit_info, &[Arg::Int(process)]);
        if reply != "+A" {
            let fields: Vec<&str> = reply[1..].split(US).collect();
            return (fields[0].to_owned(), fields.get(1).copied().unwrap_or("").to_owned());
        }
        assert!(Instant::now() < deadline, "timed out waiting for exit");
        asyncp::wait(seen, 50);
    }
}

#[test]
fn spawns_and_streams_stdout_then_reports_the_exit() {
    let child = spawn(&shell("echo hello"), ["pipe", "pipe", "pipe"]);
    assert!(child.pid > 0);
    assert!(child.stdin > 0 && child.stdout > 0 && child.stderr > 0);
    let out = drain(child.stdout);
    assert_eq!(String::from_utf8(out).unwrap().trim(), "hello");
    assert_eq!(drain(child.stderr), Vec::<u8>::new());
    assert_eq!(exit_of(child.process), ("0".to_owned(), String::new()));
}

#[test]
fn stdout_and_stderr_stay_separate_and_a_status_is_reported() {
    let child = spawn(&shell("echo out && echo err 1>&2 && exit 4"), ["pipe", "pipe", "pipe"]);
    assert_eq!(String::from_utf8(drain(child.stdout)).unwrap().trim(), "out");
    assert_eq!(String::from_utf8(drain(child.stderr)).unwrap().trim(), "err");
    assert_eq!(exit_of(child.process).0, "4");
}

#[test]
fn a_missing_program_answers_enoent_in_the_reply() {
    let argv = vec!["zun_node_no_such_program".to_owned()];
    let reply = call(asyncp::spawn_async, &[Arg::Text(&request(&argv, ["pipe", "pipe", "pipe"]))]);
    let fields: Vec<&str> = reply[1..].split(US).collect();
    assert_eq!(fields[0], "err");
    assert_eq!(fields[1], "ENOENT");
}

#[test]
fn ignored_stdio_has_no_handles() {
    let child = spawn(&shell("exit 0"), ["ignore", "ignore", "ignore"]);
    assert_eq!((child.stdin, child.stdout, child.stderr), (0, 0, 0));
    assert_eq!(exit_of(child.process).0, "0");
}

#[test]
fn stdin_bytes_reach_the_child_and_closing_it_ends_the_child() {
    // An echo program reads stdin to end of file, so it only finishes once we
    // close it: `findstr "^"` on Windows, `cat` elsewhere.
    let argv = if cfg!(windows) {
        vec!["findstr".to_owned(), "^".to_owned()]
    } else {
        vec!["cat".to_owned()]
    };
    let child = spawn(&argv, ["pipe", "pipe", "pipe"]);
    let payload = crate::fs::base64::encode(b"c\nb\na\n");
    assert_eq!(call(asyncp::write, &[Arg::Int(child.stdin), Arg::Text(&payload)]), "+");
    assert_eq!(call(asyncp::close_stdin, &[Arg::Int(child.stdin)]), "+");
    let out = String::from_utf8(drain(child.stdout)).unwrap().replace('\r', "");
    assert_eq!(out, "c\nb\na\n");
    assert_eq!(exit_of(child.process).0, "0");
}

#[test]
fn a_write_to_a_closed_stdin_fails_in_band() {
    let child = spawn(&shell("exit 0"), ["pipe", "ignore", "ignore"]);
    call(asyncp::close_stdin, &[Arg::Int(child.stdin)]);
    assert_eq!(call(asyncp::write, &[Arg::Int(child.stdin), Arg::Text("AAAA")]), "-");
    exit_of(child.process);
}

#[test]
fn kill_ends_a_running_child_and_reports_the_signal() {
    let argv = if cfg!(windows) {
        vec!["ping".to_owned(), "-n".to_owned(), "30".to_owned(), "127.0.0.1".to_owned()]
    } else {
        vec!["sleep".to_owned(), "30".to_owned()]
    };
    let child = spawn(&argv, ["ignore", "ignore", "ignore"]);
    assert_eq!(call(asyncp::kill, &[Arg::Int(child.process), Arg::Text("SIGTERM")]), "+");
    let (code, signal) = exit_of(child.process);
    assert_eq!(code, "", "a killed child has no exit code");
    assert_eq!(signal, "SIGTERM");
    // Once it has exited there is nothing to signal.
    assert_eq!(call(asyncp::kill, &[Arg::Int(child.process), Arg::Text("SIGTERM")]), "+ESRCH");
}

#[test]
fn a_pipe_with_no_read_interest_is_not_reported_ready() {
    let child = spawn(&shell("echo hi"), ["ignore", "pipe", "ignore"]);
    exit_of(child.process);
    let deadline = Instant::now() + Duration::from_secs(20);
    // Wait for the reader thread to have buffered the line.
    loop {
        asyncp::set_interest(child.stdout, 1);
        if asyncp::ready().contains(&child.stdout) {
            break;
        }
        assert!(Instant::now() < deadline);
        asyncp::wait(asyncp::generation(), 20);
    }
    asyncp::set_interest(child.stdout, 0);
    assert!(!asyncp::ready().contains(&child.stdout), "withdrawn interest is honoured");
    drain(child.stdout);
}

#[test]
fn a_large_output_is_delivered_whole_under_backpressure() {
    // More than HIGH_WATER, so the reader thread has to stop and be resumed.
    let command = if cfg!(windows) {
        "for /l %i in (1,1,30000) do @echo 0123456789012345678901234567890123456789"
    } else {
        "yes 0123456789012345678901234567890123456789 | head -n 30000"
    };
    let child = spawn(&shell(command), ["ignore", "pipe", "ignore"]);
    let out = drain(child.stdout);
    let lines = String::from_utf8(out).unwrap().lines().count();
    assert_eq!(lines, 30000);
    assert_eq!(exit_of(child.process).0, "0");
}

#[test]
fn release_forgets_the_handle() {
    let child = spawn(&shell("exit 0"), ["ignore", "ignore", "ignore"]);
    exit_of(child.process);
    assert!(asyncp::owns(child.process));
    call(asyncp::release, &[Arg::Int(child.process)]);
    assert!(!asyncp::owns(child.process));
    assert_eq!(call(asyncp::exit_info, &[Arg::Int(child.process)]), "-");
}

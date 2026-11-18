//! The asynchronous half of `node:child_process`: a child that runs *while* the
//! program does.
//!
//! `spawn.rs` runs one child to completion inside one call. This file starts a
//! child and returns at once; what the program then observes — bytes on the
//! child's stdout and stderr, the end of those streams, the child's exit —
//! arrives through the shared I/O loop (`src/io/`), the way a `net` socket's
//! readiness does.
//!
//! # Why threads, and how they meet the loop
//!
//! The loop's wait is `select` / `poll(2)` over *sockets*. A child's stdio is
//! an anonymous pipe: on Windows a pipe handle cannot be put in a `select` set
//! at all (libuv answers with named pipes and IOCP, which is a second
//! completion model this library's one-readiness-loop design deliberately does
//! not have), and on POSIX a pipe *can* be polled but the exit of a child
//! cannot (that is `SIGCHLD` or a `pidfd`). So the pipes are drained by one
//! small thread each, into a bounded buffer, and a thread waits on the child
//! itself. Every thread ends in [`notify`], which bumps a generation counter
//! and wakes a condition variable; [`wait`] is what `ioPoll` blocks on when
//! there are no sockets to select on, and when there are, `ioPoll` selects in
//! one-millisecond slices and looks at [`ready`] between them. The latency
//! bound is therefore one millisecond, and an idle loop with only children
//! costs nothing (it sleeps on the condition variable).
//!
//! The buffer is bounded ([`HIGH_WATER`]): a reader thread stops reading — so
//! the child blocks on a full pipe — once that many bytes are waiting, and
//! resumes when the program takes some. That is the same real backpressure
//! `socket.pause()` has over TCP, and it is what a withdrawn read interest
//! means for a pipe here: [`ready`] only reports a pipe the program asked
//! about.
//!
//! # Handles
//!
//! A pipe and a process each get a number from the loop's own counter
//! (`io::NEXT_HANDLE`), so one `__ioRegister(id, …)` in `io.ts` serves all
//! three kinds of handle and the dispatch needs no second table on the
//! TypeScript side. `ioInterest` and `ioClose` route here when the number is
//! one of ours.
//!
//! # Wire grammar
//!
//! `cpSpawn` takes the request `cpSpawnSync` takes (see `mod.rs`), with one
//! addition to the stdio entries: `fd0`/`fd1`/`fd2` duplicate the parent's own
//! stdio (Node's numeric `stdio` entries). The reply is
//!
//! ```text
//! "+" "ok"  US pid US process US stdin US stdout US stderr
//! "+" "err" US code US description US errno
//! ```
//!
//! with `0` for a stream that was not piped. Reads answer in the `ioRead`
//! grammar (`+A` nothing yet, `+E` end of file, `+D<base64>` a chunk).

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use zun_abi::ZunValue;

use super::spawn::{self, Pipe};
use super::{RS, US};
use crate::abi;
use crate::fs::base64;

/// How many bytes a reader thread lets pile up before it stops reading.
const HIGH_WATER: usize = 256 * 1024;
/// The largest chunk one `cpRead` hands back.
const MAX_READ: usize = 65536;

// ---------------------------------------------------------------------------
// The wake-up channel
// ---------------------------------------------------------------------------

struct Wake {
    generation: Mutex<u64>,
    signal: Condvar,
}

static WAKE: Wake = Wake { generation: Mutex::new(0), signal: Condvar::new() };

/// Something a handle could report changed: wake whoever is in [`wait`].
fn notify() {
    let mut generation = WAKE.generation.lock().unwrap_or_else(|p| p.into_inner());
    *generation += 1;
    WAKE.signal.notify_all();
}

/// The current generation; read it *before* looking at [`ready`], so a change
/// that lands in between makes [`wait`] return at once instead of being lost.
pub(crate) fn generation() -> u64 {
    *WAKE.generation.lock().unwrap_or_else(|p| p.into_inner())
}

/// Block until the generation moves past `seen` or `timeout_ms` passes.
pub(crate) fn wait(seen: u64, timeout_ms: i32) {
    let mut generation = WAKE.generation.lock().unwrap_or_else(|p| p.into_inner());
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms.max(0) as u64);
    while *generation == seen {
        let now = std::time::Instant::now();
        if now >= deadline {
            return;
        }
        let (next, _) = WAKE
            .signal
            .wait_timeout(generation, deadline - now)
            .unwrap_or_else(|p| p.into_inner());
        generation = next;
    }
}

// ---------------------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------------------

#[derive(Default)]
struct PipeBuf {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    eof: bool,
    closed: bool,
}

struct PipeState {
    inner: Mutex<PipeBuf>,
    space: Condvar,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

/// Drain `source` into `state` until end of file, a read error, or the program
/// closing the handle.
fn reader_thread<R: Read + Send + 'static>(mut source: R, state: Arc<PipeState>) {
    std::thread::spawn(move || {
        let mut chunk = vec![0u8; MAX_READ];
        loop {
            let read = match source.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            let mut inner = lock(&state.inner);
            while inner.bytes >= HIGH_WATER && !inner.closed {
                inner = state.space.wait(inner).unwrap_or_else(|p| p.into_inner());
            }
            if inner.closed {
                return;
            }
            inner.bytes += read;
            inner.chunks.push_back(chunk[..read].to_vec());
            drop(inner);
            notify();
        }
        lock(&state.inner).eof = true;
        notify();
    });
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ProcInner {
    exited: bool,
    code: Option<i32>,
    signal: Option<String>,
    /// The signal a successful `cpKill` sent. Windows has no signals: the
    /// process is terminated, and libuv reports the *requested* signal as the
    /// way the child ended, so this is what the exit record carries there.
    killed_with: Option<String>,
}

struct ProcState {
    #[cfg_attr(windows, allow(dead_code))]
    pid: u32,
    /// The OS handle, valid until the waiter thread drops the `Child`, which it
    /// does only after setting `exited` under this same lock.
    raw: usize,
    inner: Mutex<ProcInner>,
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

enum Message {
    Data(Vec<u8>),
    Close,
}

struct Stdin {
    sender: Sender<Message>,
    broken: Arc<AtomicBool>,
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

enum Entry {
    Pipe { state: Arc<PipeState>, interest: u8 },
    Proc { state: Arc<ProcState>, interest: u8 },
    Stdin(Stdin),
}

static TABLE: Mutex<Option<HashMap<i64, Entry>>> = Mutex::new(None);

fn with_table<R>(action: impl FnOnce(&mut HashMap<i64, Entry>) -> R) -> R {
    let mut guard = lock(&TABLE);
    action(guard.get_or_insert_with(HashMap::new))
}

fn next_id() -> i64 {
    crate::io::next_handle()
}

/// Is `id` one of this module's handles?
pub(crate) fn owns(id: i64) -> bool {
    with_table(|table| table.contains_key(&id))
}

/// `ioInterest` for one of our handles.
pub(crate) fn set_interest(id: i64, mask: u8) {
    with_table(|table| match table.get_mut(&id) {
        Some(Entry::Pipe { interest, .. }) | Some(Entry::Proc { interest, .. }) => {
            *interest = mask & 1;
        }
        _ => {}
    });
    notify();
}

/// `ioClose` for one of our handles.
pub(crate) fn close(id: i64) {
    let removed = with_table(|table| table.remove(&id));
    if let Some(Entry::Pipe { state, .. }) = removed {
        lock(&state.inner).closed = true;
        state.space.notify_all();
    }
}

/// Whether any handle here could produce an event — the signal `ioPoll` uses
/// to switch from a plain `select` to the sliced wait.
pub(crate) fn active() -> bool {
    with_table(|table| {
        table.values().any(|entry| {
            matches!(entry, Entry::Pipe { interest: 1, .. } | Entry::Proc { interest: 1, .. })
        })
    })
}

/// The handles with something to report, in the loop's `READ` bit.
pub(crate) fn ready() -> Vec<i64> {
    with_table(|table| {
        let mut out = Vec::new();
        for (id, entry) in table.iter() {
            match entry {
                Entry::Pipe { state, interest } if *interest & 1 != 0 => {
                    let inner = lock(&state.inner);
                    if !inner.chunks.is_empty() || inner.eof {
                        out.push(*id);
                    }
                }
                Entry::Proc { state, interest } if *interest & 1 != 0 => {
                    if lock(&state.inner).exited {
                        out.push(*id);
                    }
                }
                _ => {}
            }
        }
        out
    })
}

// ---------------------------------------------------------------------------
// Stdio
// ---------------------------------------------------------------------------

fn stdio_for(pipe: Pipe, slot: usize) -> Stdio {
    match pipe {
        Pipe::Fd(number) => duplicate_parent(number, slot),
        other => other.stdio(),
    }
}

/// `Stdio` for "the parent's own descriptor `number`" — Node's numeric `stdio`
/// entries. Only 0, 1 and 2 are supported; anything else is the null device.
fn duplicate_parent(number: i32, _slot: usize) -> Stdio {
    #[cfg(unix)]
    {
        use std::os::fd::AsFd;
        let owned = match number {
            0 => std::io::stdin().as_fd().try_clone_to_owned(),
            1 => std::io::stdout().as_fd().try_clone_to_owned(),
            2 => std::io::stderr().as_fd().try_clone_to_owned(),
            _ => return Stdio::null(),
        };
        owned.map(Stdio::from).unwrap_or_else(|_| Stdio::null())
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsHandle;
        let owned = match number {
            0 => std::io::stdin().as_handle().try_clone_to_owned(),
            1 => std::io::stdout().as_handle().try_clone_to_owned(),
            2 => std::io::stderr().as_handle().try_clone_to_owned(),
            _ => return Stdio::null(),
        };
        owned.map(Stdio::from).unwrap_or_else(|_| Stdio::null())
    }
}

// ---------------------------------------------------------------------------
// cpSpawn
// ---------------------------------------------------------------------------

fn spawn_error(code: &str) -> String {
    let (code, description, errno) = spawn::uv_error(code);
    format!("+err{US}{code}{US}{description}{US}{errno}")
}

/// Start the child and register its handles. Returns the reply text.
fn start(text: &str) -> String {
    let Some(request) = spawn::parse_request(text) else {
        return "-".to_owned();
    };
    let mut command = spawn::build_command(&request);
    command.stdin(stdio_for(request.stdin, 0));
    command.stdout(stdio_for(request.stdout, 1));
    command.stderr(stdio_for(request.stderr, 2));

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return spawn_error(spawn::spawn_error_code(&err)),
    };
    let pid = child.id();

    let stdin_id = match child.stdin.take() {
        Some(mut sink) => {
            let (sender, receiver) = channel::<Message>();
            let broken = Arc::new(AtomicBool::new(false));
            let flag = Arc::clone(&broken);
            std::thread::spawn(move || {
                for message in receiver {
                    match message {
                        Message::Data(bytes) => {
                            if sink.write_all(&bytes).is_err() || sink.flush().is_err() {
                                flag.store(true, Ordering::SeqCst);
                                return;
                            }
                        }
                        Message::Close => return,
                    }
                }
                // Dropping `sink` closes the pipe, which is what lets a child
                // reading to end of file finish.
            });
            let id = next_id();
            with_table(|table| {
                table.insert(id, Entry::Stdin(Stdin { sender, broken }));
            });
            id
        }
        None => 0,
    };

    let pipe_id = |source: Option<Box<dyn Read + Send>>| -> i64 {
        match source {
            Some(source) => {
                let state = Arc::new(PipeState {
                    inner: Mutex::new(PipeBuf::default()),
                    space: Condvar::new(),
                });
                reader_thread(source, Arc::clone(&state));
                let id = next_id();
                with_table(|table| {
                    table.insert(id, Entry::Pipe { state, interest: 0 });
                });
                id
            }
            None => 0,
        }
    };
    let stdout_id = pipe_id(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr_id = pipe_id(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let state = Arc::new(ProcState {
        pid,
        raw: raw_handle(&child),
        inner: Mutex::new(ProcInner::default()),
    });
    let waiter = Arc::clone(&state);
    std::thread::spawn(move || {
        let status = child.wait();
        {
            let mut inner = lock(&waiter.inner);
            match status {
                Ok(status) => match spawn::exit_signal(&status) {
                    Some(name) => inner.signal = Some(name),
                    None => {
                        if let Some(sent) = inner.killed_with.clone() {
                            // Windows: terminated through `cpKill`.
                            inner.signal = Some(sent);
                        } else {
                            inner.code = Some(status.code().unwrap_or(0));
                        }
                    }
                },
                Err(_) => inner.code = Some(-1),
            }
            inner.exited = true;
        }
        drop(child);
        notify();
    });
    let process_id = next_id();
    with_table(|table| {
        table.insert(process_id, Entry::Proc { state, interest: 0 });
    });

    format!("+ok{US}{pid}{US}{process_id}{US}{stdin_id}{US}{stdout_id}{US}{pipe_err}", pipe_err = stderr_id)
}

#[cfg(windows)]
fn raw_handle(child: &std::process::Child) -> usize {
    use std::os::windows::io::AsRawHandle;
    child.as_raw_handle() as usize
}

#[cfg(unix)]
fn raw_handle(_child: &std::process::Child) -> usize {
    0
}

/// Deliver `signal` to a live process. Answers `""` on success or a libuv code.
fn deliver(state: &ProcState, signal: &str) -> &'static str {
    let mut inner = lock(&state.inner);
    if inner.exited {
        return "ESRCH";
    }
    #[cfg(unix)]
    {
        let number = if signal == "0" { Some(0) } else { spawn::signal_number(signal) };
        let Some(number) = number else { return "EINVAL" };
        // SAFETY: `pid` is this process's own child, still unreaped because
        // `exited` is false; `kill` with a valid number has no further
        // requirement.
        let status = unsafe { libc::kill(state.pid as libc::pid_t, number) };
        let _ = &mut inner;
        if status == 0 {
            ""
        } else {
            "ESRCH"
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::TerminateProcess;
        match signal {
            "0" => "",
            _ => {
                // SAFETY: `raw` is the live child's handle (see `ProcState`).
                let ok = unsafe { TerminateProcess(state.raw as _, 1) };
                if ok == 0 {
                    return "ESRCH";
                }
                // Windows has no signals: the process is terminated, and the
                // four libuv knows by name are reported as themselves while any
                // other (`SIGHUP`, ...) ends as `SIGKILL`
                // (`test-child-process-kill.js` pins this).
                let reported = match signal {
                    "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGQUIT" => signal,
                    _ => "SIGKILL",
                };
                inner.killed_with = Some(reported.to_owned());
                ""
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The ABI entry points
// ---------------------------------------------------------------------------

/// `cpSpawn(request)`.
pub(crate) unsafe extern "C" fn spawn_async(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let text = match unsafe { abi::arg_str(args, n, 0) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    unsafe { abi::ret_str(out, &start(text)) }
}

/// `cpRead(id, max)` — `+A`, `+E` or `+D<base64>`.
pub(crate) unsafe extern "C" fn read(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let id = unsafe { abi::arg_i64(args, n, 0) };
    let state = with_table(|table| match table.get(&id) {
        Some(Entry::Pipe { state, .. }) => Some(Arc::clone(state)),
        _ => None,
    });
    let reply = match state {
        None => "-".to_owned(),
        Some(state) => {
            let mut inner = lock(&state.inner);
            match inner.chunks.pop_front() {
                Some(chunk) => {
                    inner.bytes -= chunk.len();
                    drop(inner);
                    state.space.notify_all();
                    format!("+D{}", base64::encode(&chunk))
                }
                None if inner.eof => "+E".to_owned(),
                None => "+A".to_owned(),
            }
        }
    };
    unsafe { abi::ret_str(out, &reply) }
}

/// `cpWrite(id, base64)` — queue bytes for the child's stdin. `-` once the
/// pipe is known to be broken.
pub(crate) unsafe extern "C" fn write(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let id = unsafe { abi::arg_i64(args, n, 0) };
    let text = match unsafe { abi::arg_str(args, n, 1) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let bytes = base64::decode(text);
    let reply = with_table(|table| match table.get(&id) {
        Some(Entry::Stdin(stdin)) => {
            if stdin.broken.load(Ordering::SeqCst) || stdin.sender.send(Message::Data(bytes)).is_err()
            {
                "-"
            } else {
                "+"
            }
        }
        _ => "-",
    });
    unsafe { abi::ret_str(out, reply) }
}

/// `cpCloseStdin(id)` — close the child's stdin once queued writes are done.
pub(crate) unsafe extern "C" fn close_stdin(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let id = unsafe { abi::arg_i64(args, n, 0) };
    if let Some(Entry::Stdin(stdin)) = with_table(|table| table.remove(&id)) {
        let _ = stdin.sender.send(Message::Close);
    }
    unsafe { abi::ret_str(out, "+") }
}

/// `cpKill(process, signal)` — `+` or `+<code>` for a failure.
pub(crate) unsafe extern "C" fn kill(args: *const ZunValue, n: usize, out: *mut ZunValue) -> i32 {
    let id = unsafe { abi::arg_i64(args, n, 0) };
    let signal = match unsafe { abi::arg_str(args, n, 1) } {
        Ok(text) => text,
        Err(status) => return status,
    };
    let state = with_table(|table| match table.get(&id) {
        Some(Entry::Proc { state, .. }) => Some(Arc::clone(state)),
        _ => None,
    });
    let reply = match state {
        Some(state) => format!("+{}", deliver(&state, signal)),
        None => "+ESRCH".to_owned(),
    };
    unsafe { abi::ret_str(out, &reply) }
}

/// `cpExit(process)` — `+A` while running, else `+code US signal`.
pub(crate) unsafe extern "C" fn exit_info(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let id = unsafe { abi::arg_i64(args, n, 0) };
    let state = with_table(|table| match table.get(&id) {
        Some(Entry::Proc { state, .. }) => Some(Arc::clone(state)),
        _ => None,
    });
    let reply = match state {
        None => "-".to_owned(),
        Some(state) => {
            let inner = lock(&state.inner);
            if !inner.exited {
                "+A".to_owned()
            } else {
                format!(
                    "+{}{US}{}",
                    inner.code.map(|c| c.to_string()).unwrap_or_default(),
                    inner.signal.clone().unwrap_or_default()
                )
            }
        }
    };
    unsafe { abi::ret_str(out, &reply) }
}

/// `cpRelease(id)` — forget a handle (process or stdin).
pub(crate) unsafe extern "C" fn release(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    let id = unsafe { abi::arg_i64(args, n, 0) };
    close(id);
    unsafe { abi::ret_str(out, "+") }
}

/// Keep the record separator in use for the grammar this module documents.
#[allow(dead_code)]
const _GRAMMAR: char = RS;

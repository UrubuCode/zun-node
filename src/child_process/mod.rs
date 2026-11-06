//! `node:child_process` — the synchronous half of Node's `child_process`, as a
//! native `zun_abi` extension.
//!
//! # TS over natives
//!
//! Same split as `node:os` and `node:fs`, and for the same reason: spawning a
//! process is a syscall, and everything Node wraps around it is shape.
//!
//! - *This* crate runs one child to completion and reports what happened:
//!   [`spawn::spawn_sync`] is `std::process::Command` plus the three things
//!   `Command` does not do on its own (feed stdin without deadlocking against
//!   the child's own output, enforce a timeout and kill with a chosen signal,
//!   and cap a pipe at `maxBuffer`). It also answers `cpExecPath`, which is the
//!   path of the running interpreter.
//! - `src/child_process/child_process.ts` is the Node-shaped module: the
//!   argument normalization (`normalizeSpawnArguments`,
//!   `normalizeExecFileArgs`, `normalizeExecArgs`), the shell rules, the
//!   `stdio` grammar, the `encoding` handling, the result object with its
//!   `output` array, and the `ERR_*` / `Command failed:` errors.
//!
//! The async half (`spawn`, `exec`, `execFile`, `fork`) is *not* here: a
//! `ChildProcess` is an `EventEmitter` whose `stdin`/`stdout`/`stderr` are
//! `node:stream` objects, and `node:stream` does not exist in this library yet.
//! See the module documentation in `child_process.ts` for what that costs.
//!
//! # What crosses the boundary
//!
//! ABI v1 carries one scalar word per value, so a spawn request — a file, an
//! argument vector, an environment block, a working directory, a stdio
//! configuration, a timeout, a kill signal, a `maxBuffer` and the bytes to
//! write to the child's stdin — cannot cross as a structure. It crosses as
//! **one delimited string**, in the grammar `node:os` fixed (documented in
//! `../lib.rs`):
//!
//! ```text
//! request := header RS argv RS env RS input
//! header  := cwd US timeout US killSignal US maxBuffer US stdin US stdout
//!            US stderr US windowsHide US detached US useEnv US uid US gid
//! argv    := file US arg*
//! env     := ("KEY=VALUE") (US "KEY=VALUE")*     -- ignored unless useEnv
//! input   := base64 of the bytes to write to the child's stdin
//! RS = U+001E     US = U+001F
//! ```
//!
//! and the reply is one `"+"`-prefixed record of twelve `US`-separated fields:
//!
//! ```text
//! 0  status          the exit code in decimal, or "" when the child was killed
//! 1  signal          the signal name ("SIGTERM"), or "" when it exited normally
//! 2  pid             decimal; 0 when the child never started
//! 3  stdout          base64, "" when stdout was not piped
//! 4  stderr          base64, "" when stderr was not piped
//! 5  stdoutPiped     "1" / "0"
//! 6  stderrPiped     "1" / "0"
//! 7  errorCode       "" or a libuv code: ENOENT, EACCES, ETIMEDOUT, ENOBUFS
//! 8  errorDescription   uv_strerror's text for that code
//! 9  errorSyscall    "spawnSync <file>", which is what Node reports
//! 10 errorErrno      the libuv errno, in decimal
//! 11 timedOut        "1" when the timeout fired, "0" otherwise
//! ```
//!
//! A child's stdout is arbitrary bytes, which cannot ride the NUL-terminated
//! `Str` carrier, so those two fields are base64 — the rule `node:fs` fixed for
//! file contents. The separators are C0 control characters, so no path,
//! argument, environment value or signal name can contain one, and neither is
//! NUL.
//!
//! # Failure
//!
//! `spawnSync` does not *throw* when the child cannot be started: Node returns
//! a result object with `error` set and `status`/`signal` null, and it is
//! `execSync`/`execFileSync` that turn a bad result into a throw. The failure
//! therefore travels in the reply's own fields rather than through the
//! per-thread error slots — which is also what the host requires, since an
//! exception raised by an extension call escapes an enclosing `try`/`catch`
//! today (<https://github.com/UrubuCode/zun/issues/33>).
//!
//! Behaviour is defined by Node.js 25, whose `child_process` is a layer over
//! libuv's `uv_spawn`, so this module follows libuv where the two could differ:
//! the shell is `cmd.exe /d /s /c` on Windows and `/bin/sh -c` on POSIX (chosen
//! on the TypeScript side, as in Node), a timeout kills with the requested
//! signal and reports it as `signal`, and a pipe that exceeds `maxBuffer` is
//! truncated with `ENOBUFS`.

use crate::Descriptor;
use zun_abi::ZunTy::Str;

pub(crate) mod spawn;

#[cfg(test)]
mod tests;

/// Unit separator: between the fields of one record.
pub(super) const US: char = '\u{1f}';
/// Record separator: between records.
pub(super) const RS: char = '\u{1e}';

/// The `node:child_process` functions published to the host. The keys are
/// deliberately `cp`-prefixed: the checker rejects a program whenever one
/// *name* is registered by two modules, even through a namespace import that
/// already names the module
/// (<https://github.com/UrubuCode/zun/issues/35>), so every module in this
/// library has to pick keys no other module uses.
pub(crate) const DESCRIPTORS: &[Descriptor] = &[
    Descriptor { key: b"cpSpawnSync\0", params: &[Str], ret: Str, invoke: spawn::spawn_sync },
    Descriptor { key: b"cpExecPath\0", params: &[], ret: Str, invoke: spawn::exec_path },
];

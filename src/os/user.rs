//! `node:os` user and scheduling: the passwd entry and the process priority.

use zun_abi::ZunValue;

use super::{fail_code, fail_io, ok_fields, ok_one, sys};
use crate::abi::{arg_i64, ret_str};

/// The sentinel the TS layer reads as `shell: null`.
///
/// The empty string is *not* usable for this: a Unix passwd entry may leave the
/// shell field blank, and Node then reports `shell: ''`, which must stay
/// distinct from Windows' `shell: null`. NUL is not usable either — it would
/// terminate the `Str` carrier. So the sentinel is the group separator, from
/// the same C0 family as the record and unit separators and equally impossible
/// in a path.
pub(super) const NO_SHELL: &str = "\u{1d}";

/// `os.userInfo()` — libuv's `uv_os_get_passwd`.
///
/// Five fields: uid, gid, username, homedir, shell. `uid`/`gid` are `-1` on
/// Windows, and the shell is [`NO_SHELL`] where there is none.
pub(crate) unsafe extern "C" fn user_info(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let payload = match sys::user_info() {
        Ok(user) => ok_fields(&[
            user.uid.to_string(),
            user.gid.to_string(),
            user.username,
            user.homedir,
            user.shell.unwrap_or_else(|| NO_SHELL.to_owned()),
        ]),
        Err(err) => fail_io("uv_os_get_passwd", &err),
    };
    unsafe { ret_str(out, &payload) }
}

/// `os.getPriority(pid)` — libuv's `uv_os_getpriority`.
///
/// The pid has already been validated by the TS layer (Node validates it as an
/// int32 before reaching the binding), so an out-of-int32 value here can only
/// be a caller bug and is reported as `EINVAL` rather than truncated.
pub(crate) unsafe extern "C" fn get_priority(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let pid = unsafe { arg_i64(args, n, 0) };
    let payload = match i32::try_from(pid) {
        Err(_) => fail_code("uv_os_getpriority", "EINVAL"),
        Ok(pid) => match sys::get_priority(pid) {
            Ok(priority) => ok_one(&priority.to_string()),
            Err(err) => fail_io("uv_os_getpriority", &err),
        },
    };
    unsafe { ret_str(out, &payload) }
}

/// `os.setPriority(pid, priority)` — libuv's `uv_os_setpriority`. Returns the
/// bare success marker `"+"`, or `"-"` with the error slots filled.
pub(crate) unsafe extern "C" fn set_priority(
    args: *const ZunValue,
    n: usize,
    out: *mut ZunValue,
) -> i32 {
    // SAFETY: the host marshalled `n` arguments per this function's descriptor.
    let pid = unsafe { arg_i64(args, n, 0) };
    // SAFETY: as above.
    let priority = unsafe { arg_i64(args, n, 1) };
    let payload = match (i32::try_from(pid), i32::try_from(priority)) {
        (Ok(pid), Ok(priority)) => match sys::set_priority(pid, priority) {
            Ok(()) => ok_one(""),
            Err(err) => fail_io("uv_os_setpriority", &err),
        },
        _ => fail_code("uv_os_setpriority", "EINVAL"),
    };
    unsafe { ret_str(out, &payload) }
}

//! zun-node — Node.js-compatible library for Zun, as a native `zun_abi`
//! extension.
//!
//! The host loads this as a dynamic library and calls [`zun_register_v1`],
//! which publishes each module's functions under a `node:<name>` module key
//! (e.g. `node:fs`). The host then invokes them by `(module, key)` with the
//! stable [`zun_abi::ZunValue`] carrier.
//!
//! ## String and error carrier convention (ABI v1)
//!
//! ABI v1's [`ZunValue`] is a single-word payload, so this crate fixes a
//! convention for the `Str` type and for error reporting, documented here so
//! the host marshalling matches:
//!
//! - **`Str` argument:** `payload` is a `*const c_char` to a NUL-terminated
//!   UTF-8 string the host owns for the duration of the call.
//! - **`Str` result:** the function stores the string in a per-thread scratch
//!   [`CString`] and sets `payload` to its pointer. It stays valid until the
//!   next call on that thread, so the host must copy it out before invoking
//!   another extension function on the same thread.
//! - **Errors:** ABI v1 carries only an `i32` status. A failing call stashes a
//!   Node-accurate `(code, message)` in per-thread slots and returns a non-zero
//!   status; the host (or the JS wrapper) reads them back through the
//!   `node:fs` functions `lastErrorCode` / `lastErrorMessage` to build a JS
//!   error whose `code`/`message` match Node's.
//!
//! These are deliberately simple and host-agnostic; a richer multi-word /
//! owned-string / managed-buffer carrier is a future ABI version.
//!
//! ## Status-prefixed results (the `node:os` convention)
//!
//! Returning a non-zero status is only usable when the host lets the program
//! *catch* the resulting exception, and today it does not: a `RunError::Thrown`
//! raised by an extension call escapes an enclosing `try`/`catch`, because the
//! interpreter propagates the hook's error straight out instead of routing it to
//! the handler the way it does for a managed call
//! (https://github.com/UrubuCode/zun/issues/33). `node:os` therefore reports
//! failure **in band** instead, and the TS layer builds Node's `SystemError`
//! itself. Every fallible `node:os` native returns a `Str`:
//!
//! ```text
//! result  := "+" payload | "-"
//! payload := record (RS record)*
//! record  := field (US field)*
//! RS = U+001E (record separator), US = U+001F (unit separator)
//! ```
//!
//! A leading `-` means the call failed and the four error slots below describe
//! it; a leading `+` means success, and an empty payload is an empty list
//! rather than an error. The separators are C0 control characters, so no host
//! name, CPU model string, path or shell can contain one, and neither is NUL,
//! so both survive the NUL-terminated `Str` carrier.
//!
//! The error slots carry everything Node's `SystemError` exposes, under the
//! keys `errorSyscall` (the libuv entry point, e.g. `uv_os_getpriority`),
//! `errorCode` (`EACCES`), `errorErrno` (the libuv negative errno) and
//! `errorMessage` (`uv_strerror`'s description, which the TS layer composes
//! into Node's `A system error occurred: …` text the way Node does).

use core::ffi::c_char;
use std::cell::RefCell;
use std::ffi::{CStr, CString};

use zun_abi::{ZunFunction, ZunRegistry, ZunTy, ZunTyRepr, ZunValue, ZUN_ABI_V1};

pub mod child_process;
pub mod fs;
pub mod os;

thread_local! {
    /// Backing storage for the most recent `Str` result on this thread.
    static RET_SCRATCH: RefCell<CString> = RefCell::new(CString::default());
    /// The most recent error's Node code (`ENOENT`, …) and message.
    static ERR_CODE: RefCell<CString> = RefCell::new(CString::default());
    static ERR_MSG: RefCell<CString> = RefCell::new(CString::default());
    /// The libuv entry point that failed (`uv_os_getpriority`, …) and the
    /// libuv errno, which Node's `SystemError` reports as `syscall`/`errno`.
    static ERR_SYSCALL: RefCell<CString> = RefCell::new(CString::default());
    static ERR_ERRNO: RefCell<i64> = const { RefCell::new(0) };
    /// The path(s) the failed call was given, which Node's *filesystem* errors
    /// report as `path` and `dest` (`node:os` errors have neither). Empty when
    /// the error has none, which is how the TS layer decides the key is absent.
    static ERR_PATH: RefCell<CString> = RefCell::new(CString::default());
    static ERR_DEST: RefCell<CString> = RefCell::new(CString::default());
}

/// Carrier helpers implementing the `Str`/error convention documented above.
pub(crate) mod abi {
    use super::*;

    /// Status returned to the host for an extension-defined failure.
    const STATUS_ERROR: i32 = 1;

    /// Read `Str` argument `i`, or a non-zero status if it is missing, null, or
    /// not valid UTF-8.
    ///
    /// # Safety
    /// `args` must point to at least `n` initialized [`ZunValue`]s; argument `i`
    /// (when present) must be a `Str` whose payload is a valid NUL-terminated
    /// pointer owned by the host for the call.
    pub(crate) unsafe fn arg_str<'a>(
        args: *const ZunValue,
        n: usize,
        i: usize,
    ) -> Result<&'a str, i32> {
        if i >= n {
            return Err(fail("EINVAL", "missing string argument"));
        }
        let value = unsafe { &*args.add(i) };
        let ptr = value.payload as *const c_char;
        if ptr.is_null() {
            return Err(fail("EINVAL", "null string argument"));
        }
        unsafe { CStr::from_ptr(ptr) }
            .to_str()
            .map_err(|_| fail("EINVAL", "string argument is not valid UTF-8"))
    }

    /// Read boolean argument `i`; `false` when absent.
    ///
    /// # Safety
    /// As [`arg_str`], for a `Bool` argument.
    pub(crate) unsafe fn arg_bool(args: *const ZunValue, n: usize, i: usize) -> bool {
        if i >= n {
            return false;
        }
        unsafe { (*args.add(i)).payload != 0 }
    }

    /// Read `i64` argument `i`; `0` when absent.
    ///
    /// # Safety
    /// As [`arg_str`], for an `I64` argument.
    pub(crate) unsafe fn arg_i64(args: *const ZunValue, n: usize, i: usize) -> i64 {
        if i >= n {
            return 0;
        }
        unsafe { (*args.add(i)).payload as i64 }
    }

    /// Read `f64` argument `i`; `0.0` when absent.
    ///
    /// # Safety
    /// As [`arg_str`], for an `F64` argument.
    pub(crate) unsafe fn arg_f64(args: *const ZunValue, n: usize, i: usize) -> f64 {
        if i >= n {
            return 0.0;
        }
        f64::from_bits(unsafe { (*args.add(i)).payload })
    }

    /// Write a `Str` result through the per-thread scratch buffer.
    ///
    /// # Safety
    /// `out` must point to a writable [`ZunValue`] the host initialized for a
    /// `Str` return.
    pub(crate) unsafe fn ret_str(out: *mut ZunValue, s: &str) -> i32 {
        let encoded = CString::new(s).unwrap_or_default();
        let ptr = RET_SCRATCH.with(|scratch| {
            *scratch.borrow_mut() = encoded;
            scratch.borrow().as_ptr()
        });
        unsafe {
            (*out).ty = ZunTyRepr::from(ZunTy::Str);
            (*out).reserved = 0;
            (*out).payload = ptr as u64;
        }
        0
    }

    /// Write a boolean result.
    ///
    /// # Safety
    /// As [`ret_str`], for a `Bool` return.
    pub(crate) unsafe fn ret_bool(out: *mut ZunValue, value: bool) -> i32 {
        unsafe {
            (*out).ty = ZunTyRepr::from(ZunTy::Bool);
            (*out).reserved = 0;
            (*out).payload = value as u64;
        }
        0
    }

    /// Write an `i64` result.
    ///
    /// # Safety
    /// As [`ret_str`], for an `I64` return.
    pub(crate) unsafe fn ret_i64(out: *mut ZunValue, value: i64) -> i32 {
        unsafe {
            (*out).ty = ZunTyRepr::from(ZunTy::I64);
            (*out).reserved = 0;
            (*out).payload = value as u64;
        }
        0
    }

    /// Write an `f64` result.
    ///
    /// # Safety
    /// As [`ret_str`], for an `F64` return.
    pub(crate) unsafe fn ret_f64(out: *mut ZunValue, value: f64) -> i32 {
        unsafe {
            (*out).ty = ZunTyRepr::from(ZunTy::F64);
            (*out).reserved = 0;
            (*out).payload = value.to_bits();
        }
        0
    }

    /// Stash a Node-accurate `(code, message)` and return the error status.
    pub(crate) fn fail(code: &str, message: &str) -> i32 {
        ERR_CODE.with(|slot| *slot.borrow_mut() = CString::new(code).unwrap_or_default());
        ERR_MSG.with(|slot| *slot.borrow_mut() = CString::new(message).unwrap_or_default());
        ERR_SYSCALL.with(|slot| *slot.borrow_mut() = CString::default());
        ERR_ERRNO.with(|slot| *slot.borrow_mut() = 0);
        STATUS_ERROR
    }

    /// Stash the four fields Node's `SystemError` reports for a failed libuv
    /// call: the libuv entry point, its error code, its errno, and
    /// `uv_strerror`'s description.
    ///
    /// The *message* is deliberately not composed here. Node composes it in
    /// JavaScript, from exactly these fields
    /// (`A system error occurred: <syscall> returned <code> (<description>)`),
    /// and exposes the description on its own as `err.info.message` — so the
    /// slot holds the description and the TS layer does the composing, which
    /// keeps both values available instead of only their concatenation.
    ///
    /// Unlike [`fail`], this does **not** return an error status: a `node:os`
    /// native signals failure in band with a `"-"` result (see the module
    /// documentation), because a thrown extension error is not catchable in the
    /// host today.
    pub(crate) fn fail_system(syscall: &str, code: &str, errno: i64, description: &str) {
        ERR_CODE.with(|slot| *slot.borrow_mut() = CString::new(code).unwrap_or_default());
        ERR_MSG.with(|slot| *slot.borrow_mut() = CString::new(description).unwrap_or_default());
        ERR_SYSCALL.with(|slot| *slot.borrow_mut() = CString::new(syscall).unwrap_or_default());
        ERR_ERRNO.with(|slot| *slot.borrow_mut() = errno);
        ERR_PATH.with(|slot| *slot.borrow_mut() = CString::default());
        ERR_DEST.with(|slot| *slot.borrow_mut() = CString::default());
    }

    /// [`fail_system`] plus the one or two paths a *filesystem* error carries.
    ///
    /// Node's `fs` errors are `uvException`s rather than `SystemError`s: the
    /// message is `"<code>: <description>, <syscall> '<path>'"` (with
    /// `" -> '<dest>'"` appended for the two-path syscalls), and `path`/`dest`
    /// are own properties of the error. The composing is left to the TS layer
    /// for the same reason as in [`fail_system`] — it keeps the fields
    /// available individually instead of only their concatenation.
    pub(crate) fn fail_fs(
        syscall: &str,
        code: &str,
        errno: i64,
        description: &str,
        path: &str,
        dest: &str,
    ) {
        fail_system(syscall, code, errno, description);
        ERR_PATH.with(|slot| *slot.borrow_mut() = CString::new(path).unwrap_or_default());
        ERR_DEST.with(|slot| *slot.borrow_mut() = CString::new(dest).unwrap_or_default());
    }
}

/// `lastErrorCode()` — the most recent error's Node code on this thread. Shared
/// by every module (the per-thread error slot is not fs-specific).
pub(crate) unsafe extern "C" fn last_error_code(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let code = ERR_CODE.with(|slot| slot.borrow().to_string_lossy().into_owned());
    unsafe { abi::ret_str(out, &code) }
}

/// `lastErrorMessage()` — the most recent error's message on this thread.
pub(crate) unsafe extern "C" fn last_error_message(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let message = ERR_MSG.with(|slot| slot.borrow().to_string_lossy().into_owned());
    unsafe { abi::ret_str(out, &message) }
}

/// `lastErrorSyscall()` — the libuv entry point that failed, which Node's
/// `SystemError` reports as `syscall` (and names in its message).
pub(crate) unsafe extern "C" fn last_error_syscall(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let syscall = ERR_SYSCALL.with(|slot| slot.borrow().to_string_lossy().into_owned());
    unsafe { abi::ret_str(out, &syscall) }
}

/// `lastErrorErrno()` — the libuv errno (negative, as libuv reports it), which
/// Node's `SystemError` exposes as `errno` and `info.errno`.
pub(crate) unsafe extern "C" fn last_error_errno(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let errno = ERR_ERRNO.with(|slot| *slot.borrow());
    unsafe { abi::ret_i64(out, errno) }
}

/// `lastErrorPath()` — the path the failed filesystem call was given, which
/// Node's `fs` errors expose as `path`.
pub(crate) unsafe extern "C" fn last_error_path(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let path = ERR_PATH.with(|slot| slot.borrow().to_string_lossy().into_owned());
    unsafe { abi::ret_str(out, &path) }
}

/// `lastErrorDest()` — the second path of a two-path filesystem call
/// (`rename`, `copyfile`, `link`, `symlink`), which Node exposes as `dest`.
pub(crate) unsafe extern "C" fn last_error_dest(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let dest = ERR_DEST.with(|slot| slot.borrow().to_string_lossy().into_owned());
    unsafe { abi::ret_str(out, &dest) }
}

/// One function descriptor: a NUL-terminated key, its parameter types, return
/// type, and implementation. Shared by each module's registration table (e.g.
/// [`fs::DESCRIPTORS`]).
pub(crate) struct Descriptor {
    pub(crate) key: &'static [u8],
    pub(crate) params: &'static [ZunTy],
    pub(crate) ret: ZunTy,
    pub(crate) invoke: zun_abi::ZunInvoke,
}

/// Publish every `Descriptor` in `functions` under `module` (a NUL-terminated
/// module key) through the host registry. Returns a non-zero status on the
/// first failed registration.
///
/// # Safety
/// `registry` must be a valid host registry for the registration call.
unsafe fn register_module(
    registry: &mut ZunRegistry,
    module: &[u8],
    functions: &[Descriptor],
) -> i32 {
    for descriptor in functions {
        let params: Vec<ZunTyRepr> = descriptor.params.iter().copied().map(ZunTyRepr::from).collect();
        let function = ZunFunction {
            key: descriptor.key.as_ptr() as *const c_char,
            params: params.as_ptr(),
            param_count: params.len(),
            ret: ZunTyRepr::from(descriptor.ret),
            invoke: Some(descriptor.invoke),
        };
        // SAFETY: `module`, `function`, and the `params` vector all outlive this
        // synchronous call (the host copies them in the callback).
        if let Err(status) =
            unsafe { registry.register_function(module.as_ptr() as *const c_char, &function) }
        {
            return status;
        }
    }
    0
}

/// Module key the `fs` surface is published under. The canonical Node 25
/// specifier is the prefixed `node:fs`. The bare `fs` alias is intentionally
/// NOT a second registration: giving the compiler the same export under two
/// module names makes every name ambiguous. Bare `fs` will resolve by
/// normalizing a leading `node:` at import resolution, a single rule, rather
/// than duplicating the surface here.
const FS_MODULE_KEYS: &[&[u8]] = &[b"node:fs\0"];

/// Module key the `os` surface is published under, on the same single-key rule
/// as [`FS_MODULE_KEYS`]. The Node-shaped `os` API is *not* here: it is
/// `src/os/os.ts`, which imports this module and reshapes it. See `src/os/mod.rs`.
const OS_MODULE_KEYS: &[&[u8]] = &[b"node:os\0"];

/// Module key the `child_process` natives are published under, on the same
/// single-key rule. The Node-shaped module is
/// `src/child_process/child_process.ts`, which imports this one and reshapes it;
/// see `src/child_process/mod.rs`.
const CHILD_PROCESS_MODULE_KEYS: &[&[u8]] = &[b"node:child_process\0"];

/// ABI v1 registration entry point. The host calls this once after loading the
/// library, passing a validated [`ZunRegistry`]; it publishes every module.
///
/// # Safety
/// `registry` must point to a valid, host-supplied v1 [`ZunRegistry`].
#[no_mangle]
pub unsafe extern "C" fn zun_register_v1(registry: *mut ZunRegistry) -> i32 {
    let Some(registry) = (unsafe { registry.as_mut() }) else {
        return -1;
    };
    if registry.abi_version != ZUN_ABI_V1 {
        return -1;
    }
    for module in FS_MODULE_KEYS {
        let status = unsafe { register_module(registry, module, fs::DESCRIPTORS) };
        if status != 0 {
            return status;
        }
    }
    for module in OS_MODULE_KEYS {
        let status = unsafe { register_module(registry, module, os::DESCRIPTORS) };
        if status != 0 {
            return status;
        }
    }
    for module in CHILD_PROCESS_MODULE_KEYS {
        let status = unsafe { register_module(registry, module, child_process::DESCRIPTORS) };
        if status != 0 {
            return status;
        }
    }
    0
}

#[cfg(test)]
mod tests;

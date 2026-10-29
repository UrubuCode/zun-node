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

use core::ffi::c_char;
use std::cell::RefCell;
use std::ffi::{CStr, CString};

use zun_abi::{ZunFunction, ZunRegistry, ZunTy, ZunTyRepr, ZunValue, ZUN_ABI_V1};

pub mod fs;

thread_local! {
    /// Backing storage for the most recent `Str` result on this thread.
    static RET_SCRATCH: RefCell<CString> = RefCell::new(CString::default());
    /// The most recent error's Node code (`ENOENT`, …) and message.
    static ERR_CODE: RefCell<CString> = RefCell::new(CString::default());
    static ERR_MSG: RefCell<CString> = RefCell::new(CString::default());
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

    /// Success status for a `Void` function.
    pub(crate) fn ok() -> i32 {
        0
    }

    /// Stash a Node-accurate `(code, message)` and return the error status.
    pub(crate) fn fail(code: &str, message: &str) -> i32 {
        ERR_CODE.with(|slot| *slot.borrow_mut() = CString::new(code).unwrap_or_default());
        ERR_MSG.with(|slot| *slot.borrow_mut() = CString::new(message).unwrap_or_default());
        STATUS_ERROR
    }
}

/// `node:fs.lastErrorCode()` — the most recent error's Node code on this thread.
unsafe extern "C" fn last_error_code(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let code = ERR_CODE.with(|slot| slot.borrow().to_string_lossy().into_owned());
    unsafe { abi::ret_str(out, &code) }
}

/// `node:fs.lastErrorMessage()` — the most recent error's message on this thread.
unsafe extern "C" fn last_error_message(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    let message = ERR_MSG.with(|slot| slot.borrow().to_string_lossy().into_owned());
    unsafe { abi::ret_str(out, &message) }
}

/// One function descriptor: a NUL-terminated key, its parameter types, return
/// type, and implementation.
struct Descriptor {
    key: &'static [u8],
    params: &'static [ZunTy],
    ret: ZunTy,
    invoke: zun_abi::ZunInvoke,
}

use ZunTy::{Bool, F64, I64, Str, Void};

/// The `node:fs` surface published to the host.
const FS_FUNCTIONS: &[Descriptor] = &[
    Descriptor { key: b"existsSync\0", params: &[Str], ret: Bool, invoke: fs::exists_sync },
    Descriptor { key: b"readFileUtf8\0", params: &[Str], ret: Str, invoke: fs::read_file_utf8 },
    Descriptor { key: b"writeFileSync\0", params: &[Str, Str], ret: Void, invoke: fs::write_file_sync },
    Descriptor { key: b"appendFileSync\0", params: &[Str, Str], ret: Void, invoke: fs::append_file_sync },
    Descriptor { key: b"mkdirSync\0", params: &[Str, Bool], ret: Void, invoke: fs::mkdir_sync },
    Descriptor { key: b"rmdirSync\0", params: &[Str], ret: Void, invoke: fs::rmdir_sync },
    Descriptor { key: b"unlinkSync\0", params: &[Str], ret: Void, invoke: fs::unlink_sync },
    Descriptor { key: b"rmSync\0", params: &[Str, Bool, Bool], ret: Void, invoke: fs::rm_sync },
    Descriptor { key: b"renameSync\0", params: &[Str, Str], ret: Void, invoke: fs::rename_sync },
    Descriptor { key: b"copyFileSync\0", params: &[Str, Str], ret: Void, invoke: fs::copy_file_sync },
    Descriptor { key: b"readdirSync\0", params: &[Str], ret: Str, invoke: fs::readdir_sync },
    Descriptor { key: b"statKind\0", params: &[Str], ret: Str, invoke: fs::stat_kind },
    Descriptor { key: b"lstatKind\0", params: &[Str], ret: Str, invoke: fs::lstat_kind },
    Descriptor { key: b"statSize\0", params: &[Str], ret: I64, invoke: fs::stat_size },
    Descriptor { key: b"statMtimeMs\0", params: &[Str], ret: F64, invoke: fs::stat_mtime_ms },
    Descriptor { key: b"realpathSync\0", params: &[Str], ret: Str, invoke: fs::realpath_sync },
    Descriptor { key: b"lastErrorCode\0", params: &[], ret: Str, invoke: last_error_code },
    Descriptor { key: b"lastErrorMessage\0", params: &[], ret: Str, invoke: last_error_message },
];

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

/// Module keys the `fs` surface is published under. Node resolves both the
/// prefixed (`node:fs`) and bare (`fs`) specifiers to the same builtin, so the
/// surface is registered under each — whichever an `import` uses resolves.
const FS_MODULE_KEYS: &[&[u8]] = &[b"node:fs\0", b"fs\0"];

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
        let status = unsafe { register_module(registry, module, FS_FUNCTIONS) };
        if status != 0 {
            return status;
        }
    }
    0
}

#[cfg(test)]
mod tests;

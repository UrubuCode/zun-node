//! End-to-end tests of the `node:fs` surface through the real `zun_abi`
//! registration + checked-invocation path (the same path the host uses).

use core::ffi::c_char;
use std::ffi::{CStr, CString};

use zun_abi::{OwnedRegistry, ZunTy, ZunTyRepr, ZunValue};

use super::zun_register_v1;

/// Register the extension into an owned registry, exactly as the host does.
fn registry() -> OwnedRegistry {
    let mut owned = OwnedRegistry::new();
    let mut host = owned.as_registry();
    let status = unsafe { zun_register_v1(&mut host) };
    assert_eq!(status, 0, "registration must succeed");
    owned
}

fn str_value(text: &CString) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::Str), reserved: 0, payload: text.as_ptr() as u64 }
}

fn bool_value(value: bool) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::Bool), reserved: 0, payload: value as u64 }
}

fn read_str(value: ZunValue) -> String {
    unsafe { CStr::from_ptr(value.payload as *const c_char) }
        .to_string_lossy()
        .into_owned()
}

/// Invoke `node:fs.<key>` through the checked ABI path.
fn call(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> Result<Option<ZunValue>, i32> {
    reg.module("node:fs")
        .func(key)
        .unwrap_or_else(|| panic!("function `{key}` must be registered"))
        .invoke_checked(args)
}

fn cstr(text: &str) -> CString {
    CString::new(text).unwrap()
}

fn temp_dir() -> std::path::PathBuf {
    let mut dir = std::env::temp_dir();
    dir.push(format!(
        "zun-node-fs-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn registers_the_fs_surface_under_node_fs() {
    let reg = registry();
    for key in ["existsSync", "readFileUtf8", "writeFileSync", "readdirSync", "statKind"] {
        assert!(reg.module("node:fs").func(key).is_some(), "missing `{key}`");
    }
}

#[test]
fn write_read_exists_and_unlink_round_trip() {
    let reg = registry();
    let dir = temp_dir();
    let path = cstr(dir.join("hello.txt").to_str().unwrap());
    let data = cstr("hi zun-node");

    call(&reg, "writeFileSync", &[str_value(&path), str_value(&data)]).unwrap();

    let exists = call(&reg, "existsSync", &[str_value(&path)]).unwrap().unwrap();
    assert_eq!(exists.payload, 1);

    let contents = call(&reg, "readFileUtf8", &[str_value(&path)]).unwrap().unwrap();
    assert_eq!(read_str(contents), "hi zun-node");

    call(&reg, "unlinkSync", &[str_value(&path)]).unwrap();
    let exists = call(&reg, "existsSync", &[str_value(&path)]).unwrap().unwrap();
    assert_eq!(exists.payload, 0);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn reading_a_missing_file_fails_with_node_enoent() {
    let reg = registry();
    let missing = cstr("./definitely-not-here-zun-node.txt");

    let status = call(&reg, "readFileUtf8", &[str_value(&missing)]).unwrap_err();
    assert_ne!(status, 0, "a missing file must fail");

    let code = read_str(call(&reg, "lastErrorCode", &[]).unwrap().unwrap());
    assert_eq!(code, "ENOENT");
    let message = read_str(call(&reg, "lastErrorMessage", &[]).unwrap().unwrap());
    assert!(
        message.starts_with("ENOENT: no such file or directory, open '"),
        "message should match Node's ENOENT open format, got {message:?}"
    );
}

#[test]
fn mkdir_readdir_and_stat_kind() {
    let reg = registry();
    let dir = temp_dir();
    let sub = cstr(dir.join("sub").to_str().unwrap());
    let file = cstr(dir.join("a.txt").to_str().unwrap());
    let dir_arg = cstr(dir.to_str().unwrap());

    call(&reg, "mkdirSync", &[str_value(&sub), bool_value(false)]).unwrap();
    call(&reg, "writeFileSync", &[str_value(&file), str_value(&cstr("x"))]).unwrap();

    let joined = read_str(call(&reg, "readdirSync", &[str_value(&dir_arg)]).unwrap().unwrap());
    let mut names: Vec<&str> = joined.split('/').collect();
    names.sort_unstable();
    assert_eq!(names, vec!["a.txt", "sub"]);

    let kind = read_str(call(&reg, "statKind", &[str_value(&sub)]).unwrap().unwrap());
    assert_eq!(kind, "directory");

    let size = call(&reg, "statSize", &[str_value(&file)]).unwrap().unwrap();
    assert_eq!(size.payload as i64, 1);

    std::fs::remove_dir_all(&dir).ok();
}

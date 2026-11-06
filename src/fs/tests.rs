//! Tests of the `node:fs` natives through the real `zun_abi` registration +
//! checked-invocation path — the same path the host uses, with the same
//! status-prefixed carrier the TS layer parses.

use core::ffi::c_char;
use std::ffi::{CStr, CString};

use zun_abi::{OwnedRegistry, ZunTy, ZunTyRepr, ZunValue};

use super::{FAILED, RS, US};

fn registry() -> OwnedRegistry {
    let mut owned = OwnedRegistry::new();
    let mut host = owned.as_registry();
    let status = unsafe { crate::zun_register_v1(&mut host) };
    assert_eq!(status, 0, "registration must succeed");
    owned
}

fn str_value(text: &CString) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::Str), reserved: 0, payload: text.as_ptr() as u64 }
}

fn bool_value(value: bool) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::Bool), reserved: 0, payload: value as u64 }
}

fn i64_value(value: i64) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::I64), reserved: 0, payload: value as u64 }
}

fn f64_value(value: f64) -> ZunValue {
    ZunValue { ty: ZunTyRepr::from(ZunTy::F64), reserved: 0, payload: value.to_bits() }
}

fn read_str(value: ZunValue) -> String {
    unsafe { CStr::from_ptr(value.payload as *const c_char) }.to_string_lossy().into_owned()
}

fn cstr(text: &str) -> CString {
    CString::new(text).unwrap()
}

/// Invoke `node:fs.<key>` through the checked ABI path and read the `Str`
/// result.
fn call(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> String {
    let value = reg
        .module("node:fs")
        .func(key)
        .unwrap_or_else(|| panic!("function `{key}` must be registered"))
        .invoke_checked(args)
        .expect("a node:fs native never returns a non-zero status")
        .expect("a Str result");
    read_str(value)
}

/// The payload of a successful result, or a panic naming the stashed error.
fn payload(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> String {
    let raw = call(reg, key, args);
    if raw == FAILED {
        panic!(
            "`{key}` failed: {} ({})",
            call(reg, "lastErrorCode", &[]),
            call(reg, "lastErrorMessage", &[])
        );
    }
    raw[1..].to_owned()
}

/// The fields of a single-record payload.
fn fields(reg: &OwnedRegistry, key: &str, args: &[ZunValue]) -> Vec<String> {
    payload(reg, key, args).split(US).map(|field| field.to_owned()).collect()
}

/// The value of one `fs.constants` entry, read back the way `fs.ts` reads it.
fn constant(reg: &OwnedRegistry, name: &str) -> i64 {
    for record in payload(reg, "fsConstants", &[]).split(RS) {
        let mut parts = record.split(US);
        if parts.next() == Some(name) {
            return parts.next().unwrap().parse().unwrap();
        }
    }
    panic!("no `{name}` in fs.constants");
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "zun-node-fs-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// The `flags` a plain `"w"` means, assembled from the platform's own table —
/// which is what the TS layer's `stringToFlags` does.
fn write_flags(reg: &OwnedRegistry) -> i64 {
    constant(reg, "O_TRUNC") | constant(reg, "O_CREAT") | constant(reg, "O_WRONLY")
}

fn read_flags(reg: &OwnedRegistry) -> i64 {
    constant(reg, "O_RDONLY")
}

#[test]
fn registers_the_fs_surface_under_node_fs() {
    let reg = registry();
    for key in ["fsConstants", "fsOpen", "fsReadFile", "fsStat", "fsReaddir", "lastErrorPath"] {
        assert!(reg.module("node:fs").func(key).is_some(), "missing `node:fs.{key}`");
    }
    // Not double-registered under bare `fs` (that would make names ambiguous at
    // compile time); bare `fs` resolves via `node:` normalization instead.
    assert!(reg.module("fs").func("fsExists").is_none());
}

#[test]
fn every_fs_key_is_distinct_from_every_os_key() {
    // The checker rejects a program whenever one *name* is registered by two
    // modules, whatever the module import says (zun#35), so the two tables
    // must stay disjoint.
    for fs_descriptor in super::DESCRIPTORS {
        for os_descriptor in crate::os::DESCRIPTORS {
            assert_ne!(
                fs_descriptor.key, os_descriptor.key,
                "`{}` is registered by both node:fs and node:os",
                String::from_utf8_lossy(fs_descriptor.key)
            );
        }
    }
}

#[test]
fn bytes_survive_a_write_read_round_trip_including_nul() {
    let reg = registry();
    let dir = temp_dir("bytes");
    let path = cstr(dir.join("bytes.bin").to_str().unwrap());
    // A NUL byte and invalid UTF-8 — neither of which could ride the `Str`
    // carrier directly, which is why the payload is base64.
    let bytes: &[u8] = &[0x00, 0xff, 0x41, 0x00, 0xfe];
    let encoded = cstr(&super::base64::encode(bytes));

    payload(
        &reg,
        "fsWriteFile",
        &[str_value(&path), str_value(&encoded), i64_value(write_flags(&reg)), i64_value(0o666)],
    );
    let read = payload(&reg, "fsReadFile", &[str_value(&path)]);
    assert_eq!(super::base64::decode(&read), bytes);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_missing_file_fails_in_band_with_every_node_error_field() {
    let reg = registry();
    let dir = temp_dir("enoent");
    let missing = dir.join("nope.txt");
    let path = cstr(missing.to_str().unwrap());

    // In band: the status is 0 and the *payload* is the failure marker, because
    // a thrown extension error is not catchable in the host (zun#33).
    assert_eq!(call(&reg, "fsReadFile", &[str_value(&path)]), FAILED);
    assert_eq!(call(&reg, "lastErrorCode", &[]), "ENOENT");
    assert_eq!(call(&reg, "lastErrorMessage", &[]), "no such file or directory");
    assert_eq!(call(&reg, "lastErrorSyscall", &[]), "open");
    assert_eq!(call(&reg, "lastErrorPath", &[]), missing.to_string_lossy());
    assert_eq!(call(&reg, "lastErrorDest", &[]), "");

    let errno = reg
        .module("node:fs")
        .func("lastErrorErrno")
        .unwrap()
        .invoke_checked(&[])
        .unwrap()
        .unwrap()
        .payload as i64;
    // libuv's ENOENT: -2 on POSIX, -4058 on Windows.
    assert!(errno == -2 || errno == -4058, "unexpected errno {errno}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn a_two_path_failure_reports_both_paths() {
    let reg = registry();
    let dir = temp_dir("dest");
    let from = cstr(dir.join("missing").to_str().unwrap());
    let to = cstr(dir.join("target").to_str().unwrap());

    assert_eq!(call(&reg, "fsRename", &[str_value(&from), str_value(&to)]), FAILED);
    assert_eq!(call(&reg, "lastErrorSyscall", &[]), "rename");
    assert!(call(&reg, "lastErrorPath", &[]).ends_with("missing"));
    assert!(call(&reg, "lastErrorDest", &[]).ends_with("target"));

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn descriptors_open_read_write_and_close() {
    let reg = registry();
    let dir = temp_dir("fd");
    let path = cstr(dir.join("fd.txt").to_str().unwrap());
    let hello = cstr(&super::base64::encode(b"hello world"));

    let fd: i64 = payload(
        &reg,
        "fsOpen",
        &[str_value(&path), i64_value(write_flags(&reg)), i64_value(0o666)],
    )
    .parse()
    .unwrap();
    let written =
        payload(&reg, "fsWrite", &[i64_value(fd), str_value(&hello), i64_value(-1)]);
    assert_eq!(written, "11");
    payload(&reg, "fsClose", &[i64_value(fd)]);

    // Closing twice is EBADF, as it is in Node.
    assert_eq!(call(&reg, "fsClose", &[i64_value(fd)]), FAILED);
    assert_eq!(call(&reg, "lastErrorCode", &[]), "EBADF");

    let fd: i64 = payload(&reg, "fsOpen", &[str_value(&path), i64_value(read_flags(&reg)), i64_value(0)])
        .parse()
        .unwrap();
    // A positioned read does not move the offset, so reading at 6 twice gives
    // the same bytes — which is `pread(2)`'s contract and Node's.
    let first = payload(&reg, "fsRead", &[i64_value(fd), i64_value(5), i64_value(6)]);
    let second = payload(&reg, "fsRead", &[i64_value(fd), i64_value(5), i64_value(6)]);
    assert_eq!(super::base64::decode(&first), b"world");
    assert_eq!(first, second);
    // Reading at the current offset advances it.
    let head = payload(&reg, "fsRead", &[i64_value(fd), i64_value(5), i64_value(-1)]);
    let next = payload(&reg, "fsRead", &[i64_value(fd), i64_value(1), i64_value(-1)]);
    assert_eq!(super::base64::decode(&head), b"hello");
    assert_eq!(super::base64::decode(&next), b" ");

    let stat = fields(&reg, "fsFstat", &[i64_value(fd)]);
    assert_eq!(stat.len(), 18);
    assert_eq!(stat[8], "11", "fstat size");

    payload(&reg, "fsClose", &[i64_value(fd)]);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_exclusive_open_of_an_existing_file_is_eexist() {
    let reg = registry();
    let dir = temp_dir("excl");
    let file = dir.join("x.txt");
    std::fs::write(&file, b"x").unwrap();
    let path = cstr(file.to_str().unwrap());
    let flags = constant(&reg, "O_WRONLY") | constant(&reg, "O_CREAT") | constant(&reg, "O_EXCL");

    assert_eq!(
        call(&reg, "fsOpen", &[str_value(&path), i64_value(flags), i64_value(0o666)]),
        FAILED
    );
    assert_eq!(call(&reg, "lastErrorCode", &[]), "EEXIST");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn stat_reports_the_kind_size_and_times_of_a_file_and_a_directory() {
    let reg = registry();
    let dir = temp_dir("stat");
    let file = dir.join("s.txt");
    std::fs::write(&file, b"1234").unwrap();

    let file_path = cstr(file.to_str().unwrap());
    let file_stat = fields(&reg, "fsStat", &[str_value(&file_path), bool_value(true)]);
    let mode: u32 = file_stat[1].parse().unwrap();
    assert_eq!(mode & 0xF000, 0x8000, "S_IFREG");
    assert_eq!(file_stat[8], "4");

    let dir_path = cstr(dir.to_str().unwrap());
    let dir_stat = fields(&reg, "fsStat", &[str_value(&dir_path), bool_value(true)]);
    let mode: u32 = dir_stat[1].parse().unwrap();
    assert_eq!(mode & 0xF000, 0x4000, "S_IFDIR");

    // Seconds are plausible and the nanosecond part is in range.
    let mtime_sec: i64 = file_stat[12].parse().unwrap();
    let mtime_nsec: u32 = file_stat[13].parse().unwrap();
    assert!(mtime_sec > 1_600_000_000, "mtime seconds look wrong: {mtime_sec}");
    assert!(mtime_nsec < 1_000_000_000);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn readdir_reports_a_type_tag_per_entry() {
    let reg = registry();
    let dir = temp_dir("readdir");
    std::fs::write(dir.join("a.txt"), b"a").unwrap();
    std::fs::create_dir(dir.join("sub")).unwrap();
    let path = cstr(dir.to_str().unwrap());

    let mut seen: Vec<(String, String)> = payload(&reg, "fsReaddir", &[str_value(&path)])
        .split(RS)
        .map(|record| {
            let mut parts = record.split(US);
            (parts.next().unwrap().to_owned(), parts.next().unwrap().to_owned())
        })
        .collect();
    seen.sort();
    assert_eq!(
        seen,
        vec![("a.txt".to_owned(), "1".to_owned()), ("sub".to_owned(), "2".to_owned())],
        "UV_DIRENT_FILE = 1, UV_DIRENT_DIR = 2"
    );

    // An empty directory is an empty payload, not a failure — the whole point
    // of the status prefix.
    let empty = temp_dir("readdir-empty");
    let empty_path = cstr(empty.to_str().unwrap());
    assert_eq!(call(&reg, "fsReaddir", &[str_value(&empty_path)]), "+");

    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&empty).ok();
}

#[test]
fn recursive_mkdir_reports_the_first_created_directory_and_rm_removes_the_tree() {
    let reg = registry();
    let root = temp_dir("mkdir");
    let deep = root.join("a").join("b").join("c");
    let deep_path = cstr(deep.to_str().unwrap());

    let first = payload(
        &reg,
        "fsMkdir",
        &[str_value(&deep_path), bool_value(true), i64_value(0o777)],
    );
    assert_eq!(first, root.join("a").to_string_lossy());
    assert!(deep.is_dir());

    // Already there: nothing created, so no path to report.
    assert_eq!(
        payload(&reg, "fsMkdir", &[str_value(&deep_path), bool_value(true), i64_value(0o777)]),
        ""
    );
    // A non-recursive mkdir over it is EEXIST.
    assert_eq!(
        call(&reg, "fsMkdir", &[str_value(&deep_path), bool_value(false), i64_value(0o777)]),
        FAILED
    );
    assert_eq!(call(&reg, "lastErrorCode", &[]), "EEXIST");

    let top = cstr(root.join("a").to_str().unwrap());
    payload(&reg, "fsRm", &[str_value(&top), bool_value(true), bool_value(false)]);
    assert!(!root.join("a").exists());

    // `force` makes a missing path succeed.
    payload(&reg, "fsRm", &[str_value(&top), bool_value(true), bool_value(true)]);
    // Without it, ENOENT.
    assert_eq!(
        call(&reg, "fsRm", &[str_value(&top), bool_value(true), bool_value(false)]),
        FAILED
    );
    assert_eq!(call(&reg, "lastErrorCode", &[]), "ENOENT");

    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn utimes_sets_the_modification_time_stat_reports() {
    let reg = registry();
    let dir = temp_dir("utimes");
    let file = dir.join("t.txt");
    std::fs::write(&file, b"t").unwrap();
    let path = cstr(file.to_str().unwrap());

    // 2001-09-09T01:46:40.500Z, chosen so the sub-second part is observable.
    let when = 1_000_000_000_500.0f64;
    payload(
        &reg,
        "fsUtimes",
        &[str_value(&path), f64_value(when), f64_value(when), bool_value(true)],
    );
    let stat = fields(&reg, "fsStat", &[str_value(&path), bool_value(true)]);
    assert_eq!(stat[12], "1000000000", "mtime seconds");
    let nsec: u32 = stat[13].parse().unwrap();
    // Not every filesystem keeps nanoseconds; it must at least not be wrong.
    assert!(nsec == 0 || (400_000_000..600_000_000).contains(&nsec), "mtime nsec {nsec}");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn copy_file_honors_copyfile_excl() {
    let reg = registry();
    let dir = temp_dir("copy");
    let src = dir.join("a");
    let dest = dir.join("b");
    std::fs::write(&src, b"source").unwrap();
    let src_path = cstr(src.to_str().unwrap());
    let dest_path = cstr(dest.to_str().unwrap());

    payload(&reg, "fsCopyFile", &[str_value(&src_path), str_value(&dest_path), i64_value(0)]);
    assert_eq!(std::fs::read(&dest).unwrap(), b"source");

    let excl = constant(&reg, "COPYFILE_EXCL");
    assert_eq!(
        call(&reg, "fsCopyFile", &[str_value(&src_path), str_value(&dest_path), i64_value(excl)]),
        FAILED
    );
    assert_eq!(call(&reg, "lastErrorCode", &[]), "EEXIST");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn access_rejects_a_missing_path_and_accepts_an_existing_one() {
    let reg = registry();
    let dir = temp_dir("access");
    let file = dir.join("a");
    std::fs::write(&file, b"a").unwrap();
    let path = cstr(file.to_str().unwrap());
    let missing = cstr(dir.join("nope").to_str().unwrap());

    payload(&reg, "fsAccess", &[str_value(&path), i64_value(constant(&reg, "F_OK"))]);
    payload(&reg, "fsAccess", &[str_value(&path), i64_value(constant(&reg, "R_OK"))]);
    assert_eq!(
        call(&reg, "fsAccess", &[str_value(&missing), i64_value(constant(&reg, "F_OK"))]),
        FAILED
    );
    assert_eq!(call(&reg, "lastErrorCode", &[]), "ENOENT");
    assert_eq!(call(&reg, "lastErrorSyscall", &[]), "access");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn statfs_reports_a_nonzero_block_size_and_total() {
    let reg = registry();
    let dir = temp_dir("statfs");
    let path = cstr(dir.to_str().unwrap());
    let stats = fields(&reg, "fsStatfs", &[str_value(&path)]);
    assert_eq!(stats.len(), 7);
    let bsize: u64 = stats[1].parse().unwrap();
    let blocks: u64 = stats[2].parse().unwrap();
    assert!(bsize > 0, "bsize");
    assert!(blocks > 0, "blocks");
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn mkdtemp_appends_six_characters_to_the_prefix_verbatim() {
    let reg = registry();
    let dir = temp_dir("mkdtemp");
    let prefix = dir.join("run-").to_string_lossy().into_owned();
    let prefix_value = cstr(&prefix);

    let first = payload(&reg, "fsMkdtemp", &[str_value(&prefix_value)]);
    let second = payload(&reg, "fsMkdtemp", &[str_value(&prefix_value)]);
    assert_ne!(first, second);
    for created in [&first, &second] {
        assert!(created.starts_with(&prefix), "{created} must extend {prefix}");
        assert_eq!(created.len(), prefix.len() + 6);
        assert!(std::path::Path::new(created).is_dir());
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn hard_link_points_at_the_same_contents() {
    let reg = registry();
    let dir = temp_dir("link");
    let original = dir.join("a.txt");
    std::fs::write(&original, b"shared").unwrap();
    let from = cstr(original.to_str().unwrap());
    let to = cstr(dir.join("b.txt").to_str().unwrap());

    payload(&reg, "fsLink", &[str_value(&from), str_value(&to)]);
    assert_eq!(std::fs::read(dir.join("b.txt")).unwrap(), b"shared");

    let stat = fields(&reg, "fsStat", &[str_value(&from), bool_value(true)]);
    // Two names for one inode. Windows reports it through
    // `GetFileInformationByHandle`, POSIX through `st_nlink`.
    assert_eq!(stat[2], "2", "nlink");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn realpath_resolves_to_an_absolute_path_without_the_windows_prefix() {
    let reg = registry();
    let dir = temp_dir("realpath");
    let file = dir.join("r.txt");
    std::fs::write(&file, b"r").unwrap();
    let path = cstr(file.to_str().unwrap());

    let resolved = payload(&reg, "fsRealpath", &[str_value(&path)]);
    assert!(!resolved.starts_with(r"\\?\"), "the verbatim prefix must be stripped");
    assert!(resolved.ends_with("r.txt"));

    std::fs::remove_dir_all(&dir).ok();
}

/// A *root* keeps its trailing separator, which is what libuv reports and what
/// `fs::canonicalize` normalises away. Node's own
/// `test-fs-readfilesync-enoent.js` compares `realpathSync` of a drive or
/// share root against `path.resolve` of the same string, so that one
/// character is the whole difference between a pass and a failure there.
#[cfg(windows)]
#[test]
fn realpath_keeps_the_trailing_separator_of_a_root() {
    let reg = registry();

    let drive = cstr("C:\\");
    let resolved = payload(&reg, "fsRealpath", &[str_value(&drive)]);
    assert_eq!(resolved, "C:\\", "a drive root keeps its separator");

    // The share-root rule is exercised directly, because a UNC path needs a
    // file server this test cannot assume: `\\host\share` gains a separator,
    // anything deeper does not, and a drive-relative `C:` becomes `C:\`.
    assert_eq!(crate::fs::meta::with_root_separator(r"\\host\share"), r"\\host\share\");
    assert_eq!(
        crate::fs::meta::with_root_separator(r"\\host\share\dir"),
        r"\\host\share\dir"
    );
    assert_eq!(crate::fs::meta::with_root_separator("C:"), "C:\\");
    assert_eq!(crate::fs::meta::with_root_separator(r"C:\Windows"), r"C:\Windows");
}

#[test]
fn descriptor_operations_reach_the_file_through_the_table() {
    let reg = registry();
    let dir = temp_dir("fdops");
    let file = dir.join("ops.txt");
    std::fs::write(&file, b"abcd").unwrap();
    let path = cstr(file.to_str().unwrap());

    let fd: i64 = payload(
        &reg,
        "fsOpen",
        &[str_value(&path), i64_value(constant(&reg, "O_RDWR")), i64_value(0o666)],
    )
    .parse()
    .unwrap();

    // `fsFutimes` and `fsFchmod` are the two calls Windows cannot make from a
    // handle; they are answered from the path the table remembers, so both
    // platforms must observe the change through `fsStat`.
    let when = 1_000_000_000_000.0f64;
    payload(&reg, "fsFutimes", &[i64_value(fd), f64_value(when), f64_value(when)]);
    let stat = fields(&reg, "fsStat", &[str_value(&path), bool_value(true)]);
    assert_eq!(stat[12], "1000000000", "mtime seconds after futimes");

    payload(&reg, "fsFchmod", &[i64_value(fd), i64_value(0o444)]);
    let stat = fields(&reg, "fsStat", &[str_value(&path), bool_value(true)]);
    let mode: u32 = stat[1].parse().unwrap();
    assert_eq!(mode & 0o200, 0, "the owner write bit is cleared: {mode:o}");
    // Put it back, so the scratch directory can be removed on Windows.
    payload(&reg, "fsFchmod", &[i64_value(fd), i64_value(0o666)]);

    payload(&reg, "fsFtruncate", &[i64_value(fd), i64_value(2)]);
    payload(&reg, "fsFsync", &[i64_value(fd), bool_value(false)]);
    let stat = fields(&reg, "fsFstat", &[i64_value(fd)]);
    assert_eq!(stat[8], "2", "size after ftruncate");

    payload(&reg, "fsClose", &[i64_value(fd)]);

    // Every descriptor operation on an unknown fd is EBADF, not a panic.
    for key in ["fsFstat", "fsClose"] {
        assert_eq!(call(&reg, key, &[i64_value(99_999)]), FAILED);
        assert_eq!(call(&reg, "lastErrorCode", &[]), "EBADF");
    }
    assert_eq!(
        call(&reg, "fsFchmod", &[i64_value(99_999), i64_value(0o666)]),
        FAILED
    );
    assert_eq!(call(&reg, "lastErrorCode", &[]), "EBADF");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn an_appending_write_file_keeps_what_was_there() {
    let reg = registry();
    let dir = temp_dir("append");
    let file = dir.join("log.txt");
    let path = cstr(file.to_str().unwrap());
    let first = cstr(&super::base64::encode(b"one
"));
    let second = cstr(&super::base64::encode(b"two
"));

    let write = constant(&reg, "O_TRUNC") | constant(&reg, "O_CREAT") | constant(&reg, "O_WRONLY");
    let append = constant(&reg, "O_APPEND") | constant(&reg, "O_CREAT") | constant(&reg, "O_WRONLY");
    payload(
        &reg,
        "fsWriteFile",
        &[str_value(&path), str_value(&first), i64_value(write), i64_value(0o666)],
    );
    payload(
        &reg,
        "fsWriteFile",
        &[str_value(&path), str_value(&second), i64_value(append), i64_value(0o666)],
    );
    let read = payload(&reg, "fsReadFile", &[str_value(&path)]);
    assert_eq!(super::base64::decode(&read), b"one
two
");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn base64_round_trips_every_remainder_length() {
    for length in 0..9usize {
        let bytes: Vec<u8> = (0..length).map(|i| (i * 37 + 11) as u8).collect();
        let encoded = super::base64::encode(&bytes);
        assert_eq!(super::base64::decode(&encoded), bytes, "length {length}");
        // Padded to a multiple of four, which is what `Buffer.from` expects.
        assert_eq!(encoded.len() % 4, 0);
    }
    assert_eq!(super::base64::encode(b"hello"), "aGVsbG8=");
    assert_eq!(super::base64::decode("aGVsbG8="), b"hello");
}

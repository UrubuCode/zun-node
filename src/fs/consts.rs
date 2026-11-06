//! `fs.constants` — the platform's own `O_*` / `S_*` / `*_OK` numbers, and the
//! single place this extension interprets them.
//!
//! These are data rather than computation (like `os.constants`), but unlike
//! `os.constants` they cannot live in the TypeScript layer: the `flags` a
//! program passes to `fs.open` are *these very numbers*, and this crate is what
//! has to turn them back into an open mode. One table, exported to the TS side
//! through [`fs_constants`] and consumed internally by [`OpenFlags`], is the
//! only arrangement in which the two cannot disagree.
//!
//! The values are the platform's, as Node reports them: POSIX takes them from
//! `<fcntl.h>`/`<sys/stat.h>`, Windows from the MSVC CRT's `_O_*` (which is
//! what libuv's `uv_fs_open` is given there). The name list is Node 25's
//! `test-fs-constants.js` `knownFsConstantNames`, minus the names that platform
//! does not define — which is exactly what makes the test's
//! "unknown constants" assertion meaningful.

// The named `UV_*` values below are the ones *this crate* reads back out of
// the table. Several are only reachable on one platform (a FIFO or a socket
// cannot appear in a Windows directory, and the symlink flags mean nothing on
// POSIX), so they are allowed to be dead there rather than cfg-split: the
// table they mirror is shared, and splitting the names would make the two
// halves of one contract look like two contracts.
#![allow(dead_code)]

use zun_abi::ZunValue;

use super::ok_records;
use crate::abi::ret_str;

/// One `fs.constants` entry.
struct Constant {
    name: &'static str,
    value: i64,
}

macro_rules! constants {
    ($($name:ident = $value:expr),* $(,)?) => {
        &[$(Constant { name: stringify!($name), value: $value as i64 }),*]
    };
}

/// `UV_FS_SYMLINK_DIR` / `UV_FS_SYMLINK_JUNCTION`, the two bits `uv_fs_symlink`
/// takes on Windows. Node exposes them on every platform.
pub(super) const UV_FS_SYMLINK_DIR: i64 = 0x0001;
pub(super) const UV_FS_SYMLINK_JUNCTION: i64 = 0x0002;

/// `UV_FS_COPYFILE_*`, the `mode` bits of `fs.copyFile`.
pub(super) const UV_FS_COPYFILE_EXCL: i64 = 0x0001;
pub(super) const UV_FS_COPYFILE_FICLONE: i64 = 0x0002;
pub(super) const UV_FS_COPYFILE_FICLONE_FORCE: i64 = 0x0004;

/// The `UV_DIRENT_*` type tags `fs.readdir({ withFileTypes: true })` reports,
/// which is what a `Dirent`'s `isFile()`/`isDirectory()`/… answer from.
pub(super) const UV_DIRENT_UNKNOWN: i64 = 0;
pub(super) const UV_DIRENT_FILE: i64 = 1;
pub(super) const UV_DIRENT_DIR: i64 = 2;
pub(super) const UV_DIRENT_LINK: i64 = 3;
pub(super) const UV_DIRENT_FIFO: i64 = 4;
pub(super) const UV_DIRENT_SOCKET: i64 = 5;
pub(super) const UV_DIRENT_CHAR: i64 = 6;
pub(super) const UV_DIRENT_BLOCK: i64 = 7;

#[cfg(windows)]
const TABLE: &[Constant] = constants![
    UV_FS_SYMLINK_DIR = 0x0001,
    UV_FS_SYMLINK_JUNCTION = 0x0002,
    O_RDONLY = 0,
    O_WRONLY = 1,
    O_RDWR = 2,
    UV_DIRENT_UNKNOWN = 0,
    UV_DIRENT_FILE = 1,
    UV_DIRENT_DIR = 2,
    UV_DIRENT_LINK = 3,
    UV_DIRENT_FIFO = 4,
    UV_DIRENT_SOCKET = 5,
    UV_DIRENT_CHAR = 6,
    UV_DIRENT_BLOCK = 7,
    S_IFMT = 0xF000,
    S_IFREG = 0x8000,
    S_IFDIR = 0x4000,
    S_IFCHR = 0x2000,
    S_IFLNK = 0xA000,
    O_CREAT = 0x0100,
    O_EXCL = 0x0400,
    UV_FS_O_FILEMAP = 0x2000_0000,
    O_TRUNC = 0x0200,
    O_APPEND = 0x0008,
    S_IRUSR = 0x0100,
    S_IWUSR = 0x0080,
    F_OK = 0,
    R_OK = 4,
    W_OK = 2,
    X_OK = 1,
    UV_FS_COPYFILE_EXCL = 0x0001,
    COPYFILE_EXCL = 0x0001,
    UV_FS_COPYFILE_FICLONE = 0x0002,
    COPYFILE_FICLONE = 0x0002,
    UV_FS_COPYFILE_FICLONE_FORCE = 0x0004,
    COPYFILE_FICLONE_FORCE = 0x0004,
];

#[cfg(not(windows))]
const TABLE: &[Constant] = constants![
    UV_FS_SYMLINK_DIR = 0x0001,
    UV_FS_SYMLINK_JUNCTION = 0x0002,
    O_RDONLY = libc::O_RDONLY,
    O_WRONLY = libc::O_WRONLY,
    O_RDWR = libc::O_RDWR,
    UV_DIRENT_UNKNOWN = 0,
    UV_DIRENT_FILE = 1,
    UV_DIRENT_DIR = 2,
    UV_DIRENT_LINK = 3,
    UV_DIRENT_FIFO = 4,
    UV_DIRENT_SOCKET = 5,
    UV_DIRENT_CHAR = 6,
    UV_DIRENT_BLOCK = 7,
    S_IFMT = libc::S_IFMT,
    S_IFREG = libc::S_IFREG,
    S_IFDIR = libc::S_IFDIR,
    S_IFCHR = libc::S_IFCHR,
    S_IFBLK = libc::S_IFBLK,
    S_IFIFO = libc::S_IFIFO,
    S_IFLNK = libc::S_IFLNK,
    S_IFSOCK = libc::S_IFSOCK,
    O_CREAT = libc::O_CREAT,
    O_EXCL = libc::O_EXCL,
    O_NOCTTY = libc::O_NOCTTY,
    O_TRUNC = libc::O_TRUNC,
    O_APPEND = libc::O_APPEND,
    O_DIRECTORY = libc::O_DIRECTORY,
    O_NOFOLLOW = libc::O_NOFOLLOW,
    O_SYNC = libc::O_SYNC,
    O_DSYNC = libc::O_DSYNC,
    O_NONBLOCK = libc::O_NONBLOCK,
    S_IRWXU = 0o700,
    S_IRUSR = 0o400,
    S_IWUSR = 0o200,
    S_IXUSR = 0o100,
    S_IRWXG = 0o070,
    S_IRGRP = 0o040,
    S_IWGRP = 0o020,
    S_IXGRP = 0o010,
    S_IRWXO = 0o007,
    S_IROTH = 0o004,
    S_IWOTH = 0o002,
    S_IXOTH = 0o001,
    F_OK = libc::F_OK,
    R_OK = libc::R_OK,
    W_OK = libc::W_OK,
    X_OK = libc::X_OK,
    UV_FS_COPYFILE_EXCL = 0x0001,
    COPYFILE_EXCL = 0x0001,
    UV_FS_COPYFILE_FICLONE = 0x0002,
    COPYFILE_FICLONE = 0x0002,
    UV_FS_COPYFILE_FICLONE_FORCE = 0x0004,
    COPYFILE_FICLONE_FORCE = 0x0004,
];

/// The value of one constant by name, or `0` if this platform has none.
fn value_of(name: &str) -> i64 {
    TABLE.iter().find(|entry| entry.name == name).map(|entry| entry.value).unwrap_or(0)
}

/// `fsPid()` — this process's id.
///
/// Not an `fs` fact, and `node:os` publishes the same number under `pid` — but
/// a `node:fs` bundle does not inline `src/os/os.ts`, so without this
/// `process.pid` is the placeholder `src/process/process.ts` falls back to
/// (that module has no extension of its own and must keep compiling without
/// `--ext`). A wrong `process.pid` is not cosmetic here: it is what makes the
/// `test/common/tmpdir` scratch directory unique per process, so two test
/// processes with the same reported pid delete each other's files. The key is
/// `fs`-prefixed because one function *name* may be registered by only one
/// module (<https://github.com/UrubuCode/zun/issues/35>).
pub(crate) unsafe extern "C" fn fs_pid(_: *const ZunValue, _: usize, out: *mut ZunValue) -> i32 {
    unsafe { crate::abi::ret_i64(out, std::process::id() as i64) }
}

/// `fsConstants()` — the whole table as `name US value` records, which the TS
/// layer turns into the null-prototype `fs.constants` object.
pub(crate) unsafe extern "C" fn fs_constants(
    _: *const ZunValue,
    _: usize,
    out: *mut ZunValue,
) -> i32 {
    let records: Vec<Vec<String>> = TABLE
        .iter()
        .map(|entry| vec![entry.name.to_owned(), entry.value.to_string()])
        .collect();
    unsafe { ret_str(out, &ok_records(&records)) }
}

/// A `flags` bitmask as the open mode it means, decoded with the same table the
/// TS layer was handed.
///
/// Only the bits that change *how a file is opened* are read here; the advisory
/// ones (`O_SYNC`, `O_DIRECT`, `O_NONBLOCK`, `O_NOATIME`, `O_DIRECTORY`,
/// `O_NOFOLLOW`, `UV_FS_O_FILEMAP`) are passed through to `libc::open` verbatim
/// on POSIX, where they mean something, and dropped on Windows, where
/// `OpenOptions` is the only route and libuv itself ignores most of them.
#[derive(Debug, Clone, Copy)]
pub(super) struct OpenFlags {
    pub(super) read: bool,
    pub(super) write: bool,
    pub(super) append: bool,
    pub(super) create: bool,
    pub(super) truncate: bool,
    pub(super) exclusive: bool,
    /// The mask as given, for the platforms that can hand it straight to
    /// `open(2)` (POSIX does; Windows has to decode it, which is what the
    /// booleans above are for).
    pub(super) raw: i64,
}

impl OpenFlags {
    pub(super) fn decode(flags: i64) -> Self {
        let access = flags & 0x3;
        let o_append = value_of("O_APPEND");
        let o_creat = value_of("O_CREAT");
        let o_trunc = value_of("O_TRUNC");
        let o_excl = value_of("O_EXCL");
        let append = o_append != 0 && flags & o_append != 0;
        Self {
            // `O_RDONLY` is 0 on every platform, so "neither write bit set"
            // *is* the read-only request; `O_RDWR` asks for both.
            read: access == 0 || access == 2,
            write: access == 1 || access == 2 || append,
            append,
            create: o_creat != 0 && flags & o_creat != 0,
            truncate: o_trunc != 0 && flags & o_trunc != 0,
            exclusive: o_excl != 0 && flags & o_excl != 0,
            raw: flags,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_table_defines_every_name_the_platform_has() {
        // `S_IRUSR`/`S_IWUSR` are the two Node's own test-fs-constants.js
        // insists on everywhere, because they are what `chmod` accepts on
        // Windows.
        assert_ne!(value_of("S_IRUSR"), 0);
        assert_ne!(value_of("S_IWUSR"), 0);
        assert_eq!(value_of("F_OK"), 0);
        assert_eq!(value_of("O_RDONLY"), 0);
        assert_eq!(value_of("COPYFILE_EXCL"), 1);
    }

    #[test]
    fn read_write_append_decode_from_the_platform_bits() {
        let read_only = OpenFlags::decode(value_of("O_RDONLY"));
        assert!(read_only.read && !read_only.write);

        let write = OpenFlags::decode(
            value_of("O_WRONLY") | value_of("O_CREAT") | value_of("O_TRUNC"),
        );
        assert!(write.write && write.create && write.truncate && !write.read);

        let append = OpenFlags::decode(
            value_of("O_WRONLY") | value_of("O_CREAT") | value_of("O_APPEND"),
        );
        assert!(append.append && append.write && !append.truncate);

        let exclusive = OpenFlags::decode(value_of("O_WRONLY") | value_of("O_EXCL"));
        assert!(exclusive.exclusive);

        let read_write = OpenFlags::decode(value_of("O_RDWR"));
        assert!(read_write.read && read_write.write);
    }
}

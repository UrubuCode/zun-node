// `internal/fs/utils` — the surface `lib/internal/fs/utils.js` exports.
//
// This is not a public module, and it is here for exactly the reason
// `internal/util` is in `src/util/util.ts`: six of Node's own `test-fs-*`
// files run under `--expose-internals` and test these functions *directly*
// rather than through the `fs` API that calls them (`test-fs-open-flags.js`
// drives `stringToFlags` over the whole flag table,
// `test-fs-util-validateoffsetlength.js` checks the two range validators
// message for message, `test-fs-rm.js` calls `validateRmOptionsSync`,
// `test-fs-watchfile-bigint.js` wants the `BigIntStats` class). Every member
// below is the *same* function `src/fs/fs.ts` already uses, re-exported under
// Node's internal name — never a second implementation.
//
// It is inlined only when a test requires it (tools/bundle_node_test.sh's
// CONDITIONAL_FILES), so a program that only uses `fs` does not carry it.

const __node_internal_fs_utils: any = {
  // ---- the option and path helpers ---------------------------------------
  assertEncoding(encoding: any): void {
    __fsAssertEncoding(encoding);
  },
  getOptions(options: any, defaultOptions?: any): any {
    return __fsGetOptions(options, defaultOptions === undefined ? {} : defaultOptions);
  },
  getValidatedPath(path: any, propName?: any): any {
    return __fsGetValidatedPath(path, propName === undefined ? undefined : String(propName));
  },
  getValidatedFd(fd: any, propName?: any): number {
    return __fsGetValidatedFd(fd, propName === undefined ? undefined : String(propName));
  },
  validatePath(path: any, propName?: any): void {
    __fsGetValidatedPath(path, propName === undefined ? undefined : String(propName));
  },
  // `copyObject(source)` is Node's own shallow copy with a null prototype;
  // the spread is the same object graph.
  copyObject(source: any): any {
    return { ...source };
  },
  stringToFlags(flags: any, name?: any): number {
    return __fsStringToFlags(flags, name === undefined ? undefined : String(name));
  },
  stringToSymlinkType(type: any): number {
    return __fsSymlinkFlags("", type);
  },
  toUnixTimestamp(time: any, name?: any): number {
    return __fsToUnixTimestamp(time, name === undefined ? undefined : String(name));
  },
  parseFileMode(value: any, name: any, fallback?: any): number {
    return __fsParseFileMode(value, String(name), fallback);
  },

  // ---- the two range validators ------------------------------------------
  //
  // `validateOffsetLengthRead` guards a destination buffer and
  // `validateOffsetLengthWrite` a source one, and the order of their checks is
  // observable: a write with both a bad offset *and* a bad length reports the
  // offset, a read reports whichever of the two is negative first.
  validateOffsetLengthRead(offset: any, length: any, bufferLength: any): void {
    if (Number(offset) < 0) {
      throw new ERR_OUT_OF_RANGE("offset", ">= 0", offset);
    }
    if (Number(length) < 0) {
      throw new ERR_OUT_OF_RANGE("length", ">= 0", length);
    }
    if (Number(offset) + Number(length) > Number(bufferLength)) {
      throw new ERR_OUT_OF_RANGE(
        "length",
        "<= " + String(Number(bufferLength) - Number(offset)),
        length,
      );
    }
  },
  validateOffsetLengthWrite(offset: any, length: any, byteLength: any): void {
    if (Number(offset) > Number(byteLength)) {
      throw new ERR_OUT_OF_RANGE("offset", "<= " + String(byteLength), offset);
    }
    if (Number(length) > Number(byteLength) - Number(offset)) {
      throw new ERR_OUT_OF_RANGE(
        "length",
        "<= " + String(Number(byteLength) - Number(offset)),
        length,
      );
    }
    if (Number(length) < 0) {
      throw new ERR_OUT_OF_RANGE("length", ">= 0", length);
    }
    __fsValidateInteger(length, "length", 0, __FS_INT32_MAX);
  },

  // ---- rm / rmdir --------------------------------------------------------
  validateRmdirOptions(options: any, defaults?: any): any {
    if (options === undefined) {
      return defaults === undefined ? {} : defaults;
    }
    __fsValidateObject(options, "options");
    return { ...(defaults === undefined ? {} : defaults), ...options };
  },
  validateRmOptionsSync(path: any, options: any, expectDir?: any): any {
    return __fsValidateRmOptionsSync(path, options, expectDir);
  },

  // ---- Dirent construction -----------------------------------------------
  //
  // `UV_DIRENT_UNKNOWN` is the type libuv reports when the platform's
  // `readdir` does not carry one, and Node then `lstat`s the entry to find
  // out. `src/fs/dirs.rs` always carries a type, so the unknown arm exists
  // for a caller that hands one in rather than for this module's own readdir.
  getDirent(path: any, name: any, type: any, callback?: any): any {
    return __fsInternalGetDirent(path, name, type, callback);
  },
  getDirents(path: any, pair: any, callback?: any): any {
    return __fsInternalGetDirents(path, pair, callback);
  },

  // ---- the classes -------------------------------------------------------
  Dirent: Dirent,
  Stats: Stats,
  BigIntStats: BigIntStats,
  Dir: Dir,
  StatsFs: StatsFs,

  // ---- the constants Node exports off this module ------------------------
  kMaxUserId: 4294967295,
  kDefaultCopyMode: 0,
  kMinimumAccessMode: 0,
  kMaximumAccessMode: 7,
  kMinimumCopyMode: 0,
  kMaximumCopyMode: 7,
};

// `validateRmOptionsSync(path, options, expectDir)` — `false` when the caller
// expected a directory and the path is not one, the merged options otherwise,
// and `ERR_FS_EISDIR` for a non-recursive `rm` of a directory.
function __fsValidateRmOptionsSync(path: any, options: any, expectDir: any): any {
  const settings: any = __fsValidateRmOptions(options);
  if (!settings.force || expectDir === true || !settings.recursive) {
    let stats: any = undefined;
    if (settings.force) {
      try {
        stats = __fsLstatSync(path, undefined);
      } catch (error) {
        stats = undefined;
      }
    } else {
      stats = __fsLstatSync(path, undefined);
    }
    const isDirectory: boolean = stats !== undefined && stats.isDirectory();
    if (expectDir === true && !isDirectory) return false;
    if (isDirectory && !settings.recursive) {
      throw new ERR_FS_EISDIR(__fsGetValidatedPath(path));
    }
  }
  return settings;
}

function __fsInternalGetDirent(path: any, name: any, type: any, callback: any): any {
  if (__evIsFn(callback)) {
    if (Number(type) === __FS_DIRENT_UNKNOWN) {
      const full: string = __node_path.join(String(path), String(name));
      __fsRunAsync(callback, function (): any {
        const stats: any = __fsLstatSync(full, undefined);
        return __fsDirentFromStats(name, stats, path);
      });
      return undefined;
    }
    __fsDeliver(__fsMakeCallback(callback), [null, new Dirent(name, Number(type), path)]);
    return undefined;
  }
  if (Number(type) === __FS_DIRENT_UNKNOWN) {
    const full: string = __node_path.join(String(path), String(name));
    return __fsDirentFromStats(name, __fsLstatSync(full, undefined), path);
  }
  return new Dirent(name, Number(type), path);
}

// `getDirents(path, [names, types], callback?)`, which Node's readdir calls
// with the two parallel arrays the binding fills. The names array is rewritten
// in place, exactly as Node's is.
function __fsInternalGetDirents(path: any, pair: any, callback: any): any {
  const names: any = pair[0];
  const types: any = pair[1];
  const count: number = Number(names.length);
  for (let i = 0; i < count; i++) {
    const type: number = Number(types[i]);
    if (type === __FS_DIRENT_UNKNOWN) {
      const full: string = __node_path.join(String(path), String(names[i]));
      names[i] = __fsDirentFromStats(names[i], __fsLstatSync(full, undefined), path);
    } else {
      names[i] = new Dirent(names[i], Number(types[i]), path);
    }
  }
  if (__evIsFn(callback)) {
    __fsDeliver(__fsMakeCallback(callback), [null, names]);
    return undefined;
  }
  return names;
}

// `DirentFromStats` — the same `Dirent`, with the type taken from a `Stats`
// rather than from libuv's tag.
function __fsDirentFromStats(name: any, stats: any, parentPath: any): any {
  return new Dirent(name, __fsDirentTypeOfStats(stats), parentPath);
}

function __fsDirentTypeOfStats(stats: any): number {
  if (stats.isDirectory()) return __FS_DIRENT_DIR;
  if (stats.isSymbolicLink()) return __FS_DIRENT_LINK;
  if (stats.isFIFO()) return __FS_DIRENT_FIFO;
  if (stats.isSocket()) return __FS_DIRENT_SOCKET;
  if (stats.isCharacterDevice()) return __FS_DIRENT_CHAR;
  if (stats.isBlockDevice()) return __FS_DIRENT_BLOCK;
  return __FS_DIRENT_FILE;
}

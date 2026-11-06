// `test/common/tmpdir` — the scratch directory 160 of Node's 227 `test-fs-*`
// files write into, and the single largest prerequisite for running them.
//
// Node's version (test/common/tmpdir.js) puts the directory inside the Node
// checkout, at `test/.tmp.<TEST_THREAD_ID>`, and cleans it with a child
// process when asked. There is no Node checkout here and no `child_process`,
// so this one differs in exactly two ways, both of them deliberate:
//
//   * the directory lives under the **OS temp directory** rather than a source
//     tree, because the only source tree in reach is the engine's and a test's
//     scratch files do not belong there. The environment rules are the ones
//     `os.tmpdir()` applies, reimplemented here rather than imported, so this
//     file stays usable in a bundle that does not inline `node:os`;
//   * the name carries the **process id**, so two tracker runs (or a test and
//     the engine's own suite) cannot share one scratch directory. Node gets
//     that isolation from `TEST_THREAD_ID` instead.
//
// `refresh()` removes and recreates the directory and — on the first call, as
// in Node — registers the `process.on('exit')` cleanup, so a test that never
// calls `refresh()` leaves nothing behind to clean.
//
// This file is inlined **only** when a test requires `../common/tmpdir`
// (tools/bundle_node_test.sh's CONDITIONAL_FILES), because it uses `node:fs`
// and would otherwise make every `path`/`events`/`util` bundle need `--ext`.

// The OS temp directory, by `os.tmpdir()`'s rules: on Windows TEMP, then TMP,
// then `(SystemRoot || windir) + '\temp'`, with one trailing separator dropped
// unless it is a drive root; on POSIX TMPDIR, then TMP, then TEMP, each only
// when non-empty, then `/tmp`.
function __tmpdirSystemTemp(): string {
  if (process.platform === "win32") {
    const candidate: string =
      process.env.TEMP ||
      process.env.TMP ||
      (process.env.SystemRoot || process.env.windir) + "\\temp";
    const length = Number(candidate.length);
    if (
      length > 1 &&
      candidate.charAt(length - 1) === "\\" &&
      candidate.charAt(length - 2) !== ":"
    ) {
      return candidate.slice(0, -1);
    }
    return candidate;
  }
  const found: any = process.env.TMPDIR || process.env.TMP || process.env.TEMP;
  if (found === undefined || found === null || found === "") return "/tmp";
  const candidate: string = String(found);
  const length = Number(candidate.length);
  if (length > 1 && candidate.charAt(length - 1) === "/") {
    return candidate.slice(0, -1);
  }
  return candidate;
}

// A `.`-prefixed name, which is the POSIX convention for "hidden" and gets
// tools to ignore it — the same reasoning as Node's own `.tmp.` prefix.
const __tmpdirState: any = {
  path: path.join(__tmpdirSystemTemp(), ".tmp.zun-node." + String(process.pid)),
  firstRefresh: true,
};

function __tmpdirRemove(target: string): void {
  // `maxRetries`/`retryDelay` are what Node passes here, for a Windows virus
  // scanner holding a handle open; there is no retry loop to drive them with
  // yet, so a single forced recursive remove is what this does.
  __node_fs.rmSync(target, { recursive: true, force: true });
}

function __tmpdirRefresh(): void {
  __tmpdirRemove(__tmpdirState.path);
  __node_fs.mkdirSync(__tmpdirState.path, { recursive: true });
  if (__tmpdirState.firstRefresh === true) {
    __tmpdirState.firstRefresh = false;
    // Clean only when a test uses refresh, exactly as in Node: a test that
    // never refreshed never created anything to clean.
    process.on("exit", __tmpdirOnExit);
  }
}

function __tmpdirOnExit(): void {
  try {
    __tmpdirRemove(__tmpdirState.path);
  } catch (error) {
    console.error("Can't clean tmpdir: " + String(__tmpdirState.path));
  }
}

const tmpdir: any = {
  refresh(): void {
    __tmpdirRefresh();
  },

  // Built with repeated two-argument joins rather than `path.resolve(...paths)`
  // because a call on an `any` receiver still fails to compile past six
  // arguments (https://github.com/UrubuCode/zun/issues/10), and a resolve of
  // one absolute base plus relative segments is the same fold.
  resolve(...paths: any[]): string {
    let result: string = String(__tmpdirState.path);
    for (const segment of paths) result = path.resolve(result, String(segment));
    return result;
  },

  fileURL(...paths: any[]): any {
    let result: string = String(__tmpdirState.path);
    for (const segment of paths) result = path.resolve(result, String(segment));
    let encoded: string = result.split("\\").join("/");
    if (encoded.charAt(0) !== "/") encoded = "/" + encoded;
    return { href: "file://" + encoded, pathname: encoded, protocol: "file:" };
  },

  // Node reads `statfsSync(tmpPath)` and compares the available blocks; so
  // does this, which is why `fsStatfs` is one of the natives.
  hasEnoughSpace(size: any): boolean {
    const stats: any = __node_fs.statfsSync(__tmpdirState.path);
    return Number(stats.bavail) >= Math.ceil(Number(size) / Number(stats.bsize));
  },
};

// `tmpdir.path` is a getter/setter in Node (a test may point the scratch
// directory somewhere else), so it is one here too.
Object.defineProperty(tmpdir, "path", {
  configurable: true,
  enumerable: true,
  get(): string {
    return String(__tmpdirState.path);
  },
  set(value: any): void {
    __tmpdirState.path = path.resolve(String(value));
  },
});

// The `test/common` harness Node's own test files require, reduced to what the
// corpus actually uses. Bundled ahead of each test by tools/bundle_node_test.sh.
//
// `common` and `fixtures` keep Node's names so the bundler can simply delete the
// `require` lines and let these bindings take over.

const common: any = {
  isWindows: process.platform === "win32",
  isLinux: process.platform === "linux",
  isMacOS: process.platform === "darwin",

  // A skipped test is a pass in Node's TAP output; exit 0 so the runner agrees.
  skip(message: string): void {
    console.log("1..0 # Skipped: " + message);
    process.exit(0);
  },

  printSkipMessage(message: string): void {
    console.log("1..0 # Skipped: " + message);
  },

  // Mirrors test/common/index.js: the suffix of an ERR_INVALID_ARG_TYPE message
  // describing what was received.
  invalidArgTypeHelper(input: any): string {
    if (input === null) return " Received null";
    if (input === undefined) return " Received undefined";
    if (typeof input === "function") {
      const name = input.name === undefined ? "" : String(input.name);
      return " Received function " + name;
    }
    if (typeof input === "object") {
      if (Array.isArray(input)) return " Received an instance of Array";
      return " Received an instance of Object";
    }
    let inspected =
      typeof input === "string" ? JSON.stringify(input) : String(input);
    if (Number(inspected.length) > 25) {
      inspected = inspected.slice(0, 25) + "...";
    }
    return " Received type " + typeof input + " (" + inspected + ")";
  },

  // No exit hook is available, so the call count is not enforced; the wrapper
  // keeps the tests that use it running.
  mustCall(fn?: any, exact?: number): any {
    if (fn === undefined) {
      return function (): void {};
    }
    return fn;
  },

  mustNotCall(message?: string): any {
    return function (): void {
      throw new Error(
        message === undefined ? "function should not have been called" : message,
      );
    };
  },

  mustSucceed(fn?: any): any {
    return fn === undefined ? function (): void {} : fn;
  },

  platformTimeout(ms: number): number {
    return ms;
  },
};

// `test/common/fixtures`. The path tests only compute over the returned string,
// never open it, so the directory is synthesized from the current working
// directory rather than pointing into a Node checkout.
const fixtures: any = {
  fixturesDir: path.join(process.cwd(), "test", "fixtures"),

  // Built with repeated two-argument joins: `join.apply(null, parts)` would hit
  // https://github.com/UrubuCode/zun/issues/1.
  path(...segments: any[]): string {
    let result = path.join(process.cwd(), "test", "fixtures");
    for (const segment of segments) result = path.join(result, segment);
    return result;
  },

  fileURL(...segments: any[]): any {
    return "file://" + path.join(process.cwd(), "test", "fixtures");
  },

  readSync(): string {
    throw new Error("fixtures.readSync is not available in the zun harness");
  },
};

// `child_process` is required by `test-path-resolve.js`, whose Windows-only tail
// spawns the runtime on a fixture. A real `spawnSync` belongs to the
// `child_process` module's own work; until then the stub throws, so that block
// fails on Windows (on Linux the test takes the other branch).
const __nodeChildProcess: any = {
  execSync(): string {
    throw new Error("child_process is not available in the zun harness");
  },
  spawnSync(): any {
    throw new Error("child_process is not available in the zun harness");
  },
};

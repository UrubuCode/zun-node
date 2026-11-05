// node:process — the slice of `process` that the rest of this library needs.
//
// Written in Zun TypeScript over the `zun:core` host surface. This is NOT the
// finished `node:process` module (see ../../PLAN.md for the library order): it is
// the "implement just the piece that unblocks the current module" case from
// PLAN.md principle 4. `node:path` needs `cwd()`, per-drive cwd lookups through
// `env`, and `platform`; Node's own path tests additionally read `process.cwd()`
// and `process.platform`.
//
// Engine notes (see https://github.com/UrubuCode/zun/issues):
//   * `host.cwd()` / `host.envGet` / `host.envHas` come from `zun:core`.
//   * There is no host native reporting the OS, so `platform` is derived from the
//     shape of `cwd()`: a `X:\...` drive-rooted cwd means Windows.

import { host } from "zun:core";

function __processCwd(): string {
  return host.cwd();
}

function __looksWindows(): boolean {
  const cwd = __processCwd();
  if (cwd.length < 3) return false;
  const drive = cwd.charCodeAt(0);
  const isLetter =
    (drive >= 65 && drive <= 90) || (drive >= 97 && drive <= 122);
  if (!isLetter) return false;
  if (cwd.charCodeAt(1) !== 58) return false; // ':'
  const third = cwd.charCodeAt(2);
  return third === 92 || third === 47; // '\' or '/'
}

const __isWindowsHost: boolean = __looksWindows();

function __processEnvGet(name: string): any {
  if (!host.envHas(name)) return undefined;
  return host.envGet(name);
}

// `process.env`.
//
// A live `Proxy` lookup would be the right shape, since `zun:core` can read a
// variable by name but cannot enumerate the environment block. It is not usable:
// Proxy traps are keyed on the receiver's static type, so reading the proxy through
// the `any`-typed `env` field of the `process` object loses them and every variable
// answers `undefined` (https://github.com/UrubuCode/zun/issues/6).
//
// Until that is fixed, `env` is a snapshot over a fixed list of names: the variables
// Node's own tests touch, plus the per-drive `=X:` cwd variables `win32.resolve`
// consults. `envLookup` stays available for a name outside the list.
const __envNames: string[] = [
  "PATH",
  "Path",
  "PATHEXT",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "USERNAME",
  "TEMP",
  "TMP",
  "TMPDIR",
  "OS",
  "OSTYPE",
  "ComSpec",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "PWD",
  "CD",
  "NODE_ENV",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LANG",
  "LC_ALL",
  "TZ",
];

function __buildEnv(): any {
  const env: any = {};
  for (const name of __envNames) {
    if (host.envHas(name)) env[name] = host.envGet(name);
  }
  // The cmd.exe per-drive current directories: `=C:`, `=D:`, ...
  for (let letter = 65; letter <= 90; letter++) {
    const name = "=" + String.fromCharCode(letter) + ":";
    if (host.envHas(name)) env[name] = host.envGet(name);
  }
  return env;
}

const __processEnv: any = __buildEnv();

function __processArgv(): string[] {
  const out: string[] = [];
  const count = Number(host.argCount());
  for (let i = 0; i < count; i++) {
    out.push(host.argAt(i));
  }
  return out;
}

const process: any = {
  platform: __isWindowsHost ? "win32" : "linux",
  cwd(): string {
    return __processCwd();
  },
  env: __processEnv,
  // Escape hatch for a variable outside the snapshot list above.
  envLookup(name: string): any {
    return __processEnvGet(name);
  },
  argv: __processArgv(),
  exit(code?: number): void {
    host.exitProcess(code === undefined ? 0 : code);
  },
  stdout: {
    write(text: string): boolean {
      host.stdoutWrite(text);
      return true;
    },
  },
  stderr: {
    write(text: string): boolean {
      host.stderrWrite(text);
      return true;
    },
  },
};

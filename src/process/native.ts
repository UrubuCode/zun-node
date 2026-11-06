// node:process — the one file that names the native extension.
//
// `src/process/process.ts` is inlined into **every** bundle in this library,
// including the `path`, `events`, `util`, `assert`, `url` and `timers` ones that
// run as `zun run <bundle.ts>` with no `--ext` at all. An
// `import * as native from "node:process"` in that file would make every one of
// those bundles fail to compile for want of a cdylib they do not need.
//
// So the import lives here instead, and `tools/bundle_node_test.sh` inlines
// this file only when the bundle will be run with the extension — the
// `ZUN_NODE_EXT` gate, which `tools/run_node_tests.sh` sets for its
// `zun-ts+ext` kinds. `process.ts` keeps a documented fallback for every value
// (each marked `NO-EXT:` at its use site) and never names this module.
//
// There is no logic here on purpose. This file is one object literal of
// forwarding methods — object-literal methods, because a method survives every
// path through an `any` while a bare function value does not
// (https://github.com/UrubuCode/zun/issues/17) — and one call. Everything the
// methods' results mean is decoded in `process.ts`, against the grammar
// documented in `src/process/mod.rs`.

import * as __procNative from "node:process";

__processInstallNative({
  facts(): string {
    return __procNative.procFacts();
  },
  title(): string {
    return __procNative.procTitle();
  },
  setTitle(value: string): string {
    return __procNative.procSetTitle(value);
  },
  credentials(): string {
    return __procNative.procCredentials();
  },
  hrtime(): string {
    return __procNative.procHrtime();
  },
  uptime(): string {
    return __procNative.procUptime();
  },
  cpuUsage(): string {
    return __procNative.procCpuUsage();
  },
  threadCpuUsage(): string {
    return __procNative.procThreadCpuUsage();
  },
  resourceUsage(): string {
    return __procNative.procResourceUsage();
  },
  memoryUsage(): string {
    return __procNative.procMemoryUsage();
  },
  availableMemory(): number {
    return __procNative.procAvailableMemory();
  },
  constrainedMemory(): number {
    return __procNative.procConstrainedMemory();
  },
  kill(pid: number, signal: number): string {
    return __procNative.procKill(pid, signal);
  },
  chdir(directory: string): string {
    return __procNative.procChdir(directory);
  },
  umask(mask: number, set: boolean): string {
    return __procNative.procUmask(mask, set);
  },
  abort(): string {
    return __procNative.procAbort();
  },
  environ(): string {
    return __procNative.procEnviron();
  },
  setEnv(name: string, value: string, remove: boolean): string {
    return __procNative.procSetEnv(name, value, remove);
  },
  isTty(fd: number): boolean {
    return __procNative.procIsTty(fd);
  },
  errorCode(): string {
    return __procNative.procErrorCode();
  },
  errorMessage(): string {
    return __procNative.procErrorMessage();
  },
  errorSyscall(): string {
    return __procNative.procErrorSyscall();
  },
  errorErrno(): number {
    return __procNative.procErrorErrno();
  },
  errorPath(): string {
    return __procNative.procErrorPath();
  },
  errorDest(): string {
    return __procNative.procErrorDest();
  },
});

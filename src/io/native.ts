// node:io — the one file that names the readiness loop's native extension.
//
// `src/io/io.ts` is inlined into **every** bundle in this library, because
// `tools/harness/common.ts` asks it for the ref count whether or not the bundle
// has an extension (exactly as it asks `src/timers/timers.ts` for the timer ref
// count). An `import * as native from "node:io"` in that file would make every
// `path`, `events`, `util`, `assert` and `url` bundle fail to compile for want
// of a cdylib it does not need.
//
// So the import lives here instead, and `tools/bundle_node_test.sh` inlines
// this file only when the bundle will be run with the extension — the
// `ZUN_NODE_EXT` gate, which `tools/run_node_tests.sh` sets for its
// `zun-ts+ext` kinds. `io.ts` answers `__ioAvailable() === false` without it,
// the pump never arms, and nothing can be registered; a module built on the
// loop raises an honest error instead of hanging.
//
// This is the same split `src/process/native.ts` documents, and there is no
// logic here on purpose: one object literal of forwarding methods —
// object-literal methods, because a method survives every path through an `any`
// while a bare function value does not
// (https://github.com/UrubuCode/zun/issues/17) — and one call. Every result's
// grammar is decoded in `io.ts` and in the modules above it, against the
// carrier documented in `src/io/mod.rs`.

import * as __ioNative from "node:io";

__ioInstallNative({
  lookup(host: string, family: number): string {
    return __ioNative.ioLookup(host, family);
  },
  listen(address: string, port: number, backlog: number, flags: number): string {
    return __ioNative.ioListen(address, port, backlog, flags);
  },
  accept(handle: number): string {
    return __ioNative.ioAccept(handle);
  },
  socket(): string {
    return __ioNative.ioSocket();
  },
  connect(
    handle: number,
    address: string,
    port: number,
    localAddress: string,
    localPort: number,
  ): string {
    return __ioNative.ioConnect(handle, address, port, localAddress, localPort);
  },
  connectError(handle: number): string {
    return __ioNative.ioConnectError(handle);
  },
  read(handle: number, max: number): string {
    return __ioNative.ioRead(handle, max);
  },
  write(handle: number, bytes: string): string {
    return __ioNative.ioWrite(handle, bytes);
  },
  shutdown(handle: number): string {
    return __ioNative.ioShutdown(handle);
  },
  reset(handle: number): string {
    return __ioNative.ioReset(handle);
  },
  close(handle: number): string {
    return __ioNative.ioClose(handle);
  },
  interest(handle: number, mask: number): string {
    return __ioNative.ioInterest(handle, mask);
  },
  poll(timeout: number): string {
    return __ioNative.ioPoll(timeout);
  },
  sockName(handle: number): string {
    return __ioNative.ioSockName(handle);
  },
  peerName(handle: number): string {
    return __ioNative.ioPeerName(handle);
  },
  sockOpt(handle: number, name: string, on: number, value: number): string {
    return __ioNative.ioSockOpt(handle, name, on, value);
  },
  handleCount(): number {
    return __ioNative.ioHandleCount();
  },
  errorCode(): string {
    return __ioNative.ioErrorCode();
  },
  errorMessage(): string {
    return __ioNative.ioErrorMessage();
  },
  errorSyscall(): string {
    return __ioNative.ioErrorSyscall();
  },
  errorErrno(): number {
    return __ioNative.ioErrorErrno();
  },
  errorAddress(): string {
    return __ioNative.ioErrorAddress();
  },
});

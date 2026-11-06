# zun-node — Node.js compatibility library for Zun

A Node.js-compatible standard library for the [Zun](https://github.com/UrubuCode/zun)
platform. The Zun engine core holds only base logic; libraries like this one sit
outside it — either **behind the ABI** (a Rust `cdylib` exporting
`zun_register_v1`) or **in Zun TypeScript**, compiled by the platform's own
compiler. Which form a module takes follows from what the module needs (see
principle 2).

**Baseline: Node.js 25.** The oracle for "done" is Node's own test suite (`test/` in
nodejs/node): **a library is not finished until it passes 100% of the Node tests
that apply to it.**

## Principles

1. **Library by library, finished before moving on.** Order: **`fs` → `process` →
   `path` → `os` → `events` → `stream` → `buffer` → …**. Do not start the next
   library until the current one passes 100% of its applicable Node tests.
   *Exception by capability, not by preference:* `path` can be driven to 100%
   ahead of `fs`, because it needs no host harness beyond the test bundler —
   whereas `fs`'s tests additionally need Buffers, file descriptors,
   callbacks/promises and the `test/fixtures/` tree. The order above still
   governs which library's *API surface* is owed next.
   *Second exception, by dependency:* **`events` was taken before `os`.** Node's
   `process` **is** an `EventEmitter`, and the test harness cannot verify a
   single `common.mustCall` count without `process.on('exit')`,
   `process.on('warning')` and `process.nextTick` — all of which need `events`
   to exist first. Taking `events` early is therefore what makes the *harness*
   real for every later library; `os` is still owed ahead of `stream`.
2. **The implementation form follows the capability.**
   - A module that needs the operating system is **native through the ABI**: Rust
     over `std`, exposed as `zun_abi` functions under a `node:<name>` module key,
     depending on `zun_abi` alone — no VM, interpreter, or allocator dependency.
     `fs` is this kind.
   - A module that is **pure computation** is written in **Zun TypeScript** and
     compiled by the platform. Crossing the ABI would buy nothing and would cost
     a marshalling convention. `path` is this kind (`src/path/path.ts`): it is
     string manipulation end to end.
   - A module that is **both** draws the seam where the capability changes:
     **TypeScript over natives**. `os` is this kind, and most Node modules are:
     only a handful of its entry points touch the kernel, while everything a
     caller actually sees — the objects, the arrays, `constants`, the argument
     validation, the `ERR_*` errors — is shape. Putting the shape behind the ABI
     would mean marshalling it; putting the syscalls in TypeScript is impossible.
     So the extension answers only the facts, and `src/os/os.ts` builds Node's
     module on top, reaching them with `import * as native from "node:os"`. See
     *TS over natives* under Architecture.
3. **No module graph beyond the engine.** Implement the maximum API that does not
   require a third-party package or the signed module registry. Self-contained.
4. **Dependency rule.** If a module needs a capability another unfinished module
   owns, implement *just that piece* to unblock — but never leave a module before
   its own internal dependency is finished. This is why `src/assert/assert.ts`
   and `src/process/process.ts` exist: Node's `path` tests are written against
   `assert` and read `process.cwd()` / `process.platform`, so the slice of each
   that the corpus actually uses is implemented, and no more.

## Architecture

```
src/fs/      ──[cdylib, zun_register_v1]──▶ zun_abi ◀──[loads + invokes]── Zun host
src/os/*.rs  ──[same cdylib]─────────────────▶ zun_abi ◀────┐ (facts: syscalls)
src/os/os.ts ──[compiled by the Zun compiler]───────────────┘ (shape: TS over natives)
src/path/    ──[path.ts]──────────────────▶ compiled by the Zun compiler, run by the VM
src/events/  ──[events.ts]────────────────▶ same route
src/util/    ──[util.ts]─────────────────┐  harness slices (principle 4), same route
src/assert/  ──[assert.ts]               │
src/process/ ──[process.ts, zun:core]────┘
```

Bundle order is dependency order: `util` (no dependencies) → `events`
(`util.inspect` for its messages) → `process` (an `EventEmitter`) → `assert` →
`path` → `os` (the `ERR_*` classes from `events`, `process.env` for `tmpdir()`)
→ `tools/harness/common.ts`.

`events.ts` is also where the library's three Node error bases live —
`NodeTypeError`, `NodeRangeError`, `NodeError` — so `path` and `os` build their
coded errors from the same shape: a real `TypeError`/`RangeError`/`Error`
subclass with `code` as a **declared** field. That is not a style preference.
Attaching `code` to a plain error instance through an `any` alias writes a key
the class never declared, which poisons the instance: every later statically
typed read of one of its own members, `err.name` included, throws
([zun#37](https://github.com/UrubuCode/zun/issues/37)). Node's tests read
`err.name` and `err.code` constantly, through
`assert.throws(fn, { code, name })`.

### TS over natives (the `os` pattern, and the one `fs` will take)

`os` is the first module written as **Zun TypeScript on top of extension
natives**, and the split is deliberate rather than incidental:

- **The extension answers only what needs the kernel.** `src/os/{facts,stats,net,user}.rs`
  are thin ABI wrappers over `src/os/sys/{unix,windows}.rs`, which is where the
  syscalls live. Each one documents the libuv entry point Node calls and follows
  it where the result is observable.
- **The TypeScript is the module.** `src/os/os.ts` holds every object and array
  shape, the per-platform `constants` tables, `EOL`/`devNull` with Node's own
  property attributes, `validateInt32`, `ERR_SYSTEM_ERROR`, the `tmpdir()`
  environment rules and the CIDR arithmetic. None of that is a syscall, and all
  of it would need a marshalling convention if it lived behind the ABI.
- **Structured results cross as one string.** ABI v1's carrier is a single
  scalar word, so a CPU table or an interface list cannot cross as a structure.
  `os` fixes the convention: `"+"` then records separated by U+001E, fields by
  U+001F; `"-"` means the call failed and the four error slots describe it. The
  separators are C0 controls, so no payload can contain one, and no quoting or
  escaping rule exists for the two sides to disagree about. One call captures a
  whole table, so its rows are a coherent snapshot rather than a sample smeared
  across one call per field — which matters for CPU times, that move while they
  are read. The grammar is documented in `src/lib.rs` and `src/os/mod.rs`.
- **Failure is reported in band, not as a status.** The ABI has an error status,
  and a failing extension call *is* catchable now
  ([zun#33](https://github.com/UrubuCode/zun/issues/33)'s own complaint is
  fixed) — but the value that reaches the handler is a `ReferenceError` naming
  the module namespace (`fsn is not defined`) rather than the extension's
  `(code, message)`, so a status-based failure still cannot become a
  Node-accurate `ERR_SYSTEM_ERROR`. The natives therefore always return
  successfully and say `"-"`, and the TypeScript raises Node's `SystemError`
  from the slots — `errorSyscall`, `errorCode`, `errorErrno`, `errorMessage`.
- **Keys are unique across modules.** Those four readers are `node:fs`'s
  `lastError*` functions under different names, because the checker rejects a
  program as soon as a single function *name* is registered by two modules,
  even when every use site is a namespace member access naming its module.

The tracker knows this as a third module kind, `zun-ts+ext`: bundle the test
like a TypeScript module, then run the bundle with `--ext`.

- **`src/lib.rs`** — `zun_register_v1`, the ABI carrier helpers (`abi` module), the
  shared `Descriptor` type, and shared error retrieval. Extension modules only.
- **`src/<module>/`** — one folder per Node module (Node's modules are large).
  - An extension module has a `mod.rs` with the module's `DESCRIPTORS` table and
    submodules by area; e.g. `src/fs/{mod,rw,dirs,meta,links}.rs`. Each function
    is a `zun_abi::ZunInvoke` over `std`.
  - A Zun TypeScript module is `<name>.ts` in the same place; e.g.
    `src/path/path.ts`. It depends on the engine only through `zun:core`
    (`src/process/process.ts` is the only one that does so today, for `cwd`/`env`).
- **`tools/`** — the compatibility tracker (`run_node_tests.sh`), the test bundler
  (`bundle_node_test.sh`) and the `test/common` harness (`harness/common.ts`).
- **`test/<module>/`** — that module's Node test inventory (`NODE_TESTS.txt`),
  status write-up (`README.md`) and generated results (`RESULTS.md`). See
  `test/fs/` and `test/path/`.

The Rust side is built as a `cdylib`; the host loads it (by name or embedded in a
`.zmlib`) and calls `zun_register_v1`. It is also an `rlib`, so every native
module is unit-tested as plain Rust against the real `zun_abi` registration +
checked-invocation path. The Zun TypeScript side needs no build step at all: the
engine compiles it.

### ABI v1 carrier convention (fixed by this crate, see `src/lib.rs`)

ABI v1's `ZunValue` is a single-word payload, so this crate fixes a simple,
host-agnostic convention until a richer ABI version lands:

- **`Str` argument:** `payload` is a `*const c_char` (host-owned, NUL-terminated
  UTF-8, valid for the call).
- **`Str` result:** stored in a per-thread scratch `CString`; `payload` is its
  pointer, valid until the next call on that thread (the host copies it out first).
- **Multi-value string results** (e.g. `readdirSync`) join on `/`, which cannot
  occur in a path component and (unlike NUL) survives the NUL-terminated carrier.
- **Errors:** a failing call stashes a Node-accurate `(code, message)` per thread
  and returns a non-zero status; the host/wrapper reads them via the module's
  `lastErrorCode` / `lastErrorMessage` functions to build a JS error whose
  `code`/`message` match Node's.

This convention applies to extension modules only. `path` returns real JS strings
and objects, because it is compiled, not marshalled.

## Compatibility tracker

`tools/run_node_tests.sh` + `.github/workflows/node-compat.yml` download Node 25's
`test-<module>*.js` at a pinned tag (a module's corpus may span several prefixes —
`events` is `test-event-emitter-*` plus `test-events-*`), run each through `zun`, and render the pass
share into the README (a progress bar + percentage) and `test/<module>/RESULTS.md`,
with the first line of stderr recorded for every failure. A test passes when the
`zun run` invocation exits 0. Tests are downloaded into `<work>/test/parallel/`,
because several of them assert their own location through `__dirname`.

The runner knows all three module kinds:

- **extension modules** run as `zun run --ext <lib> <test.js>`; `--ext` is
  required for them.
- **Zun TypeScript modules** are bundled first and run as `zun run <bundle.ts>`,
  with no `--ext`. `util`, `path`, `events`, `buffer` and `string_decoder` are
  this kind.
- **Zun TypeScript over natives** (`zun-ts+ext`) are bundled first *and* need
  `--ext`: `zun run --ext <lib> <bundle.ts>`. `os` is this kind.

### The test bundler

The engine has no CommonJS `require` and no file-based module resolution
([zun#4](https://github.com/UrubuCode/zun/issues/4)), while every Node test opens
with `require('assert')` / `require('path')` / `require('../common')`. Rather than
block the measurement on module resolution,
`tools/bundle_node_test.sh <node-test.js> <out.ts>` turns one test into one Zun
program: it concatenates the modules in bundle order ahead of the test body,
injects `__filename`/`__dirname`, rewrites the test's `require` lines, and
appends the one statement that settles the event loop and verifies the
`common.mustCall` counts.

The `require` convention is generic: **each inlined module exposes exactly one
object**, named `__node_<module>` (`__node_events`, `__node_assert`,
`__node_util_types`, `__node_internal_util`, ...), and `require('x')` /
`require('node:x')` both become that object. One refinement sits
on top: a module that is *already bound* under the name the tests use has that
whole-line declaration deleted instead (`const path = require('path');`), and for
`events` the canonical binding is the **class** `EventEmitter` rather than an
object, because `new <identifier>()` only compiles for a statically known class
— so `EventEmitter` is also removed from a destructuring pattern and left bound
to the class, while the other destructured names come from `__node_events`. An
unknown module makes the bundle fail with a named diagnostic, so a missing
harness module is never mistaken for an engine bug.

Two modules are inlined **only when the test requires them**, through the
bundler's `CONDITIONAL_FILES`: `os`, because its source calls into the native
extension and inlining it unconditionally would make every pure-computation
bundle need a cdylib; and `buffer`/`string_decoder`, because fifty of the
sixty-four `test-buffer*` files use the global `Buffer` alone and need no library
code at all. `string_decoder` lists `src/buffer/buffer.ts` as well as its own
file, the way Node's `lib/string_decoder.js` does `require('buffer')`, and a
file already queued is not appended twice.

`buffer` is also the first module whose **canonical binding is an engine realm
global** rather than a library declaration. `Buffer` is the engine's — a nominal
alias for the `Uint8Array` byte-view floor, statics recognised by receiver name
in the checker (NUCLEUS #21) — and Node's `buffer.Buffer` is the same object as
`globalThis.Buffer`, so `const { Buffer } = require('buffer')` leaves the name
bound to the global exactly as `EventEmitter` does for `events`.

`node:test` is the one module in the table that is harness code rather than
library code (`tools/harness/node_test.ts`): it is not a module zun-node
implements, it is the language several of Node's newer test files are *written
in*, so without it those files cannot be bundled at all and the public API they
exercise never gets measured. Its canonical binding is the **function** `test`,
because Node's files spell both `const test = require('node:test')` — where the
module object is itself callable — and `const { test } = require('node:test')`.
It is conditional too, for a reason specific to that name: `test` is also what
several of Node's own test files call their local helper, and two top-level
declarations of one name are a compile error in a single Zun program, so
inlining it unconditionally reported `duplicate function declaration` for files
whose real blocker was something else.

Exit verification is the harness's other job. The VM drains its unified event
loop after the main script returns but exposes no "about to exit" hook, so the
bundler's epilogue (`__zunHarnessFinish()`) runs a *settle loop*: a chain of
`setTimeout` turns that yields to the VM's timer and microtask queues until
`process.nextTick` has been quiet for a fixed number of turns, then emits
`process` 'exit' and exits non-zero if a `common.mustCall` count was not met.
See the header of `tools/harness/common.ts`.

When CommonJS resolution does land in the engine, the bundler is the thing that
gets deleted; nothing else in the tracker changes.

## Status

- **`node:path`: implemented in `src/path/path.ts`, measured against the full
  Node corpus.** The POSIX and Windows surfaces are both there —
  `normalize`, `join`, `resolve`, `relative`, `isAbsolute`, `dirname`,
  `basename`, `extname`, `parse`, `format`, `toNamespacedPath`, `matchesGlob`,
  `sep`, `delimiter`, `posix`, `win32` — written against Node 25's
  `test/parallel/test-path*.js` (17 files). Current measurement and the per-test
  failure notes are in `test/path/` (regenerated by the tracker, so the README
  block is the live number). **Every remaining failure is an engine gap, not a
  `path.ts` gap**: differential runs against Node (~36 000 assertions over both
  namespaces and every function) show zero divergences. `test-path-join.js` is now
  blocked by [#17](https://github.com/UrubuCode/zun/issues/17) alone: a function
  taken out of an array is a `functionBox` record with no `apply` on it, and the
  failure message's `map(JSON.stringify)` aborts the VM on a built-in read as a
  value. Three blockers it used to have are gone —
  [#16](https://github.com/UrubuCode/zun/issues/16) is closed, so
  `slice(0).concat([…])` builds the Windows table correctly;
  [#15](https://github.com/UrubuCode/zun/issues/15) is closed, so the spread
  spelling compiles; and a function stored in an array keeps its identity.
  `test-path-resolve.js` keeps #17 plus a Windows-only
  `child_process.spawnSync` block. `test-path-parse-format.js` **passes now**:
  [zun#14](https://github.com/UrubuCode/zun/issues/14) is closed, a function can
  carry callable properties that resolve from module scope, nested functions,
  closures and `any` parameters, so `src/assert/assert.ts` is a real callable
  with the methods attached — the shape `lib/assert.js` exports.
  `path.ts` carries marked workarounds for [zun#2](https://github.com/UrubuCode/zun/issues/2),
  [#3](https://github.com/UrubuCode/zun/issues/3),
  [#7](https://github.com/UrubuCode/zun/issues/7) and
  [#13](https://github.com/UrubuCode/zun/issues/13).
  Its `ERR_INVALID_ARG_TYPE` is a real `TypeError`
  subclass with `code` as a declared field, which is what keeps
  [#37](https://github.com/UrubuCode/zun/issues/37) designed out of the module
  rather than worked around. The full table is in `test/path/README.md`. A security pass against Node's path CVEs (CVE-2025-23084,
  CVE-2025-27210 and their follow-ups, `toNamespacedPath`, `\\?\` roots) found
  the current implementation matches fixed Node on all 389 attack inputs.
- **`node:fs` (sync surface): in progress, split across `src/fs/`.** Implemented:
  existsSync, accessSync, readFileSync (utf8), writeFileSync, appendFileSync,
  truncateSync, mkdirSync, rmdirSync, unlinkSync, rmSync, readdirSync, mkdtempSync,
  statSync/lstatSync (kind/size/mtimeMs/atimeMs/birthtimeMs), realpathSync,
  renameSync, copyFileSync, linkSync, symlinkSync, readlinkSync, plus
  lastErrorCode/lastErrorMessage. 8 crate tests green (`cargo test`). **Not done:**
  the acceptance bar is 100% of Node 25's `test-fs-*` suite (227 files — see
  `test/fs/`), which also needs Buffers, fds, callbacks/promises, streams, watch,
  Dirent, and the full `Stats`; those land in their own `src/fs/` submodules. Its
  tracker number stays near 0% until the Node-API shaping and the
  `test/fixtures/` tree exist.
- **`node:events`: implemented in `src/events/events.ts`, measured against the
  full Node corpus.** The whole `EventEmitter` surface is there —
  `on`/`addListener`, `prependListener`, `once`, `prependOnceListener`,
  `off`/`removeListener`, `removeAllListeners`, `emit` with the
  `error`/`errorMonitor`/`ERR_UNHANDLED_ERROR` semantics, `listeners`,
  `rawListeners`, `listenerCount` (with the listener argument), `eventNames`
  (strings and symbols), `setMaxListeners`/`getMaxListeners`, the
  `newListener`/`removeListener` meta-events, the MaxListenersExceededWarning
  through `process.emitWarning`, and `captureRejections` — plus the module
  statics `once`, `on`, `getEventListeners`, `getMaxListeners`,
  `setMaxListeners`, `listenerCount`, `addAbortListener`, `errorMonitor`,
  `captureRejectionSymbol`, `defaultMaxListeners`, `usingDomains`. Listener
  storage is null-prototype-safe, so a `__proto__` event name works. A
  differential self-test over every method, both meta-events, the error paths,
  the warning text and the storage shapes passes clean; **every remaining test
  failure is an engine gap**, catalogued test by test in `test/events/README.md`
  (member `new`, the remaining half of class statics, no receiver threading,
  class bases, `internal/` modules). Symbol identity
  ([#23](https://github.com/UrubuCode/zun/issues/23)) was fixed and
  `test-events-list.js` passes; six workarounds came out with it — `emit` is
  `emit(type, ...args)` again, `prependListener` uses `unshift`,
  `defaultMaxListeners`/`errorMonitor`/`captureRejectionSymbol` are real class
  statics, the event-name bookkeeping compares symbols by identity,
  `captureRejectionSymbol` is `Symbol.for('nodejs.rejection')`, and the
  EventTarget side tables are `Map`s. Four more came out with this engine
  update: a **symbol**-keyed slot holds Node's own shape (`_events[sym] ===
  listener` while there is one) because a function value under a symbol key
  round-trips, `__evRawSet` no longer deletes the key before every write because
  a function written over a slot holding an object is no longer swallowed, and
  `__evRawDelete` is a plain `delete` for a string key because `delete` clears a
  function-valued property (three parts of
  [#32](https://github.com/UrubuCode/zun/issues/32)); and `emit`'s rest
  parameter needs no caveat because
  [#11](https://github.com/UrubuCode/zun/issues/11) measures as fixed. Two
  **new** engine faults are compensated instead, both of them regressions this
  update introduced and both of them in the listener store: a computed read with
  a *variable* key resolves `Object.prototype`'s members even on a
  null-prototype object, so every slot read asks `in` first (`_events[type]`
  answered `Object.prototype.toString` for the event name `toString`, which is
  what cost `test-event-emitter-special-event-names.js` its pass); and
  `events.__proto__ = value` sets the *prototype* of a null-prototype object
  instead of creating an own property for every value but a bare callable, so
  `Object.defineProperty` installs the rest. The `captureRejections` flag is a
  declared field, which is what keeps
  [#37](https://github.com/UrubuCode/zun/issues/37) out of the module. `events.ts`
  also owns the library's three coded-error bases, and their message assembly is
  now Node's own: `ERR_INVALID_ARG_TYPE` lowercases the nine primitive type
  names, says `property` rather than `argument` for a dotted name, splits
  capitalised names into an "an instance of …" clause and joins lists the way
  `internal/errors`' `formatList` does; `ERR_INVALID_ARG_VALUE` quotes the name
  and truncates the inspected value at 128 characters. Every module in the
  library raises them, so `util.inherits(fn, {})` reports exactly what Node
  reports. **Not done:** `EventEmitterAsyncResource`, which
  needs `async_hooks` — there is nothing to build it on, so it is absent rather
  than faked.
- **`node:os`: complete, split across `src/os/` (natives) and
  `src/os/os.ts` (the module).** Every documented entry point is there —
  `arch`, `availableParallelism`, `cpus`, `endianness`, `freemem`,
  `getPriority`, `homedir`, `hostname`, `loadavg`, `machine`,
  `networkInterfaces`, `platform`, `release`, `setPriority`, `tmpdir`,
  `totalmem`, `type`, `uptime`, `userInfo`, `version`, plus `EOL`, `devNull`
  and `constants` (`signals`, `errno`, `priority`, `dlopen`,
  `UV_UDP_REUSEADDR`) with the per-platform values Node reports, the
  `validateInt32` errors (`ERR_INVALID_ARG_TYPE`, `ERR_OUT_OF_RANGE`) and
  `ERR_SYSTEM_ERROR` with Node's `SystemError` name, `errno`, `syscall` and
  `info`. **Windows and Linux are both implemented** from libuv's own behavior:
  `/proc` plus `getifaddrs`/`getpwuid_r`/`getpriority` on Linux;
  `GetAdaptersAddresses`, `NtQuerySystemInformation`, `GlobalMemoryStatusEx`,
  the `CentralProcessor` registry keys and the priority-class mapping on
  Windows. A differential run against Node over 140 values — every string fact,
  the whole `constants` table, every CPU row, every interface entry with its
  CIDR and scope id, `userInfo()` in both encodings, all eight validation
  messages, and every `tmpdir()` environment rule — shows **zero divergences on
  both platforms**. **Not done, by capability:**
  `userInfo({ encoding: 'buffer' })` returns a documented byte view rather than
  a `Buffer`, because `node:buffer` does not exist yet; one function changes
  when it does. The remaining test failures are all outside this module
  (`internal/test/binding`, `node:child_process`, ToPrimitive on a function
  value — `` `${os.hostname}` `` yields the literal `[function]`,
  [#36](https://github.com/UrubuCode/zun/issues/36) — and destructured top-level
  bindings). The callable-`assert` blocker is gone:
  [#14](https://github.com/UrubuCode/zun/issues/14) is closed and `assert.ts` is
  a real function with the methods attached, so `test-os.js`'s own `is` helper
  runs and #36 is all that stands between it and a pass — the table is in `test/os/README.md`.
  `test-os-eol.js` passes now: `assert.ts` matches the standard error
  constructors by identity, so `assert.throws(fn, TypeError)` works even though
  a constructor read as a value still has no `.name` and still cannot sit on the
  right of an `instanceof`
  ([#17](https://github.com/UrubuCode/zun/issues/17)). 28 crate tests green on
  both platforms (`cargo test`).
- **`node:buffer`: the module surface is complete, in `src/buffer/buffer.ts`;
  `Buffer` itself is the engine's.** This is the first module whose central
  object already exists in the VM: Node's `Buffer` is a `Uint8Array` subclass,
  Zun's is a nominal alias for the `Uint8Array` byte-view floor (a realm global,
  statics by receiver name, instance methods lowered to the `nodeBuffer`
  intrinsics — NUCLEUS #21), and `buffer.Buffer === globalThis.Buffer` in Node,
  so **this library never introduces a second Buffer**. What it owns is the
  module surface, and all of it is there: `kMaxLength`, `kStringMaxLength`,
  `constants`, `INSPECT_MAX_BYTES`, a strict WHATWG `atob`/`btoa` (the engine
  globals are lenient where Node throws), `isUtf8`, `isAscii`, `transcode`,
  `Blob`, `File` and `resolveObjectURL`. **No `SlowBuffer`:** Node removed
  DEP0030 in v25 and `test-buffer-slow.js` now tests
  `Buffer.allocUnsafeSlow`. **Not done, and not doable from here:** every gap in
  the engine's `Buffer`. A method the checker does not know on a
  `BufferView(U8)` receiver is a *compile error*, there is no prototype to
  extend, and a byte view is opaque through `any` — so `compare`, `toJSON`,
  `entries`/`keys`/`values`, `buffer`/`byteOffset`/`parent` as properties,
  `Buffer.compare`, `isEncoding`, `of`, `allocUnsafeSlow` and `poolSize` are
  engine work. The dominant blocker is narrower than any of them: the
  `nodeBuffer` intrinsics take machine integers, so a plain `number` is rejected
  at the call site, which stops 28 of the 64 tests on their first line. The
  worst is a GC bug this track found — **a live Buffer's backing `ArrayBuffer`
  is freed at the first young collection**, reproducibly on the 256th class
  instance, because a view object carries type RID 0 and the mark phase has no
  reference slots for it. The four historical Buffer CVEs were each checked:
  `alloc` never returns non-zeroed memory, the `alloc(size, fill, encoding)` and
  `write(string, offset, length, encoding)` forms are unreachable rather than
  unsafe, and the UCS-2 `write` near the end of a buffer stays in bounds but
  writes a *partial code unit*. Table in `test/buffer/README.md`.
- **`node:string_decoder`: complete, in
  `src/string_decoder/string_decoder.ts`.** `write`, `end`, the legacy
  `text(buf, offset)` and `lastChar`/`lastNeed`/`lastTotal`, for utf8, utf16le,
  ucs2, base64, base64url, hex, latin1 and ascii. There is no
  `internalBinding('string_decoder')` to wrap, so it follows Node's own
  pure-JavaScript decoder, with the two points where Node 25's C++ decoder
  diverges from it reproduced: one U+FFFD per *maximal subpart* of an aborted
  multi-byte sequence (nodejs/node#22626), and Node 25's shape for `text`. Two
  codecs are decoded in the library rather than through the engine, because the
  engine's disagree with V8: UTF-16, which replaces an unpaired surrogate with
  U+FFFD where a stream decoder must carry it across the chunk boundary, and
  `ascii`, whose decoder must mask the high bit. Verified by a **differential
  run against Node** — `test-string-decoder.js`'s own driver over 33 byte
  sequences × every possible split across successive `write()` calls × 8
  encodings (1216 cases) plus all 32 `testEnd` vectors of
  `test-string-decoder-end.js`: **zero divergences**. All three corpus files
  fail to compile on engine gaps (`Buffer.from`/`Buffer.of` with an `any`
  argument, `Math.random`, a call with one more argument than the function
  declares); table in `test/string_decoder/README.md`.
- **`node:util`: complete, in `src/util/util.ts`, measured against the full
  Node corpus.** The whole Node 25 public surface is there — `format`,
  `formatWithOptions`, `inspect` with every documented option (`depth`,
  `colors`, `customInspect`, `showHidden`, `showProxy`, `maxArrayLength`,
  `maxStringLength`, `breakLength`, `compact`, `sorted`, `getters`,
  `numericSeparator`, a user `stylize`), `inspect.custom`,
  `inspect.defaultOptions`, `inspect.colors` (44 styles + Node's twelve
  aliases), `inspect.styles` **including Node 25's regular-expression depth
  highlighter**, `stripVTControlCharacters`, `styleText`, `isDeepStrictEqual`
  (with the v25 `skipPrototype` argument), `inherits`, `deprecate`, `promisify`
  (+ `promisify.custom`), `callbackify`, `debuglog`/`debug`, `types`,
  `getSystemErrorName`/`getSystemErrorMessage`/`getSystemErrorMap` over libuv's
  85-row `UV_ERRNO_MAP` for both platforms, `toUSVString`, `aborted`,
  `transferableAbortSignal`/`transferableAbortController`, `parseArgs`,
  `parseEnv`, `MIMEType`/`MIMEParams`, `getCallSites`, `TextEncoder`/
  `TextDecoder`, and the two deprecated entries v25 still ships (`isArray`,
  `_extend`). The line-breaking is Node's own
  `reduceToSingleString`/`isBelowBreakLength`/`groupArrayElements` plus its
  2²⁷-character output budget, so `inspect` of a ten-element numeric array
  really does come out as Node's two right-aligned columns.
  **`util` was taken before `stream`** because `stream` cannot be written
  without it (`inspect`, `promisify`, `deprecate`, `debuglog`, `types` are all
  load-bearing in `lib/internal/streams/*`) and because nearly every test file
  in every corpus reads through it: `assert` now formats its messages with
  `util.inspect` and compares with `util.isDeepStrictEqual`, the way Node's
  `assert` does, instead of carrying reduced copies that could disagree with it.
  `lib/internal/util.js`'s own surface (`sleep`, `emitExperimentalWarning`,
  `pendingDeprecate`, `customPromisifyArgs`) is implemented in the same file,
  because in Node it *is* the same module. **Every remaining test failure is
  outside this module**: fourteen need a harness module that does not exist
  (`vm`, `v8`, `worker_threads`, `url`, `node:fs`, `child_process`,
  `internal/test/binding`, `internal/errors`), and five are engine gaps — four
  of them new (typed arrays/`ArrayBuffer` opaque through `any`, a symbol's
  `description` panicking there, `Object.keys = fn` panicking, and a regex
  literal with a duplicate named capture group being rejected although ES2025
  and Node 25 accept it). The table is in `test/util/README.md`. **Documented
  capability gaps**, not omissions: `types.isProxy` and `showProxy` need a host
  hook; a promise's settled value is unreadable, so `inspect` prints
  `Promise { <pending> }`; every typed-array/boxed-primitive predicate answers
  `false`; `getters: true` cannot show a getter's value because, although an
  accessor's descriptor now carries working `get`/`set` slots,
  `desc.get.apply(obj, [])` aborts the interpreter and `apply` threads no
  receiver into a function value
  ([#1](https://github.com/UrubuCode/zun/issues/1)); a function declaration
  inspects as `[Function (anonymous)]` because `fn.name` is unavailable
  ([#25](https://github.com/UrubuCode/zun/issues/25)) — a class correctly
  inspects as `[class Foo]` — and every callable is tagged `[object Function]`,
  so `[AsyncFunction: f]`, `[GeneratorFunction: f]` and `[Function: bound f]`
  are not reachable either. One rendering bug came out of this engine update and
  is fixed: a `functionBox` record reports `typeof === "function"` now rather
  than `"object"`, which stopped the unwrap guard opening it — and since a box
  is tagged `[object Object]` exactly like a class, every ordinary function
  reached through an array, an object property or an `any` lane printed as
  `[class (anonymous)]`. A function-valued property is also visible to
  `Object.keys` now, so `inspect({ fn() {} })` is
  `{ fn: [Function (anonymous)] }` rather than `{}`
  ([#32](https://github.com/UrubuCode/zun/issues/32)).
- **`node:assert` (harness slice): `src/assert/assert.ts`.** `ok`, `equal`,
  `notEqual`, `strictEqual`, `notStrictEqual`, `deepStrictEqual`,
  `notDeepStrictEqual`, `throws`, `doesNotThrow`, `match`, `doesNotMatch`,
  `fail`, `AssertionError` with Node's `code`/`actual`/`expected`/`operator`.
  `assert.throws(fn, Ctor)` handles the eight standard error constructors by
  matching `expected` against each one's identity and spelling the `instanceof`
  against the literal class, which is the only form the engine resolves.
  **`assert` is a function carrying the methods**, the shape Node exports
  (`lib/assert.js` ends with `module.exports = assert = ok`), so the bare
  `assert(value, message)` form Node's own tests use works. It was a plain object
  until the engine could express a callable with callable properties
  ([zun#14](https://github.com/UrubuCode/zun/issues/14)); that turned
  `test-path-parse-format.js` into a pass and took the same blocker off
  `test-os.js` and `test-event-emitter-listeners-side-effects.js`, which are now
  blocked one layer in (zun#36 and zun#26 respectively).
  Not the finished module: it is what the corpus asserts with.
- **`node:process` (harness slice): `src/process/process.ts`.** `cwd()`, `env`,
  `platform`, `argv`, `exit()`, `stdout`/`stderr`, over `zun:core`'s `host`, plus
  the **EventEmitter surface** Node's `process` has
  (`on`/`once`/`off`/`emit`/`listeners`/`listenerCount`/`eventNames`/`setMaxListeners`,
  delegated to one `EventEmitter` instance), `nextTick` (a FIFO queue over
  `queueMicrotask`), `emitWarning` (which the events module's warning route is
  wired to), and `exitCode`. `platform` is derived from the shape of `cwd()`
  because no host native reports the OS yet. Not the finished module; the full
  `process` is still owed in the order above.

### Module keys and host dispatch

The native surface is registered under `node:fs` and `node:os`, so those import
specifiers resolve. The engine already dispatches external module calls at runtime through
`CallHook::try_call_external(module, name, args)` (with string marshalling), and
loads native extensions through `zun_abi` — **no `zun:core` core change is needed**.
Wiring is a matter of loading this extension and routing `node:fs` external calls
to its registered functions, in the engine's existing format.

**That routing is now exercised end to end**, by `os`: a program that writes
`import * as native from "node:os"` and calls `native.hostname()` reaches this
crate's descriptor through the existing path — `zun run --ext` →
`zun_compiler::external_functions_all` (which derives the compiler's external
declarations from what the extension registered, so the toolchain hardcodes
nothing) → the checker's namespace-import resolution →
`CallHook::try_call_external` at run time. No `zun:core` change was needed, as
predicted. Two limits surfaced in the process and are documented at their use
sites in `src/os/mod.rs`: a function *name* may be registered by only one
module, and an error thrown out of an extension call is not catchable.

`cargo test` here remains the verification path for a native that no program
calls yet (it drives the real `zun_abi` registration + checked-invocation path).
The Zun TypeScript modules need no routing at all: they are compiled into the
program, which is why `path` was measurable against Node's suite before any of
this existed.

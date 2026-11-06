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

### TS over natives (the `os` pattern, which `fs` now also follows)

`os` is the first module written as **Zun TypeScript on top of extension
natives**, and `fs` is the second (`src/fs/*.rs` for the syscalls,
`src/fs/fs.ts` for the Node API). The split is deliberate rather than
incidental:

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
  but an exception thrown out of an extension call escapes an enclosing
  `try`/`catch` in the host today, so a status-based failure could never become
  a catchable `ERR_SYSTEM_ERROR`. The natives therefore always return
  successfully and say `"-"`, and the TypeScript raises Node's `SystemError`
  from the slots — `errorSyscall`, `errorCode`, `errorErrno`, `errorMessage`.
- **Keys are unique across modules.** Those four readers are `node:fs`'s
  `lastError*` functions under different names, because the checker rejects a
  program as soon as a single function *name* is registered by two modules,
  even when every use site is a namespace member access naming its module. The
  same rule is why every `node:fs` key is `fs`-prefixed (`fsOpen`, `fsStat`, …).
- **Bytes cross as base64.** `fs` adds one thing `os` did not need: file
  contents. The `Str` carrier is a NUL-terminated C string, so it can carry
  neither a NUL byte nor non-UTF-8 data; the read/write payloads are therefore
  base64, and `src/fs/fs.ts` turns them into the engine's prelude `Buffer`
  (`Buffer.from(text, "base64")`) and back. base64 over hex because it is 4/3
  rather than 2× the byte count, and over a latin1 passthrough because that
  cannot carry NUL; both codecs are native in the engine's `Buffer`, so neither
  side hand-rolls one.

The tracker knows this as a third module kind, `zun-ts+ext`: bundle the test
like a TypeScript module, then run the bundle with `--ext`. `os` and `fs` are
both of that kind.

- **`src/lib.rs`** — `zun_register_v1`, the ABI carrier helpers (`abi` module), the
  shared `Descriptor` type, and shared error retrieval. Extension modules only.
- **`src/<module>/`** — one folder per Node module (Node's modules are large).
  - An extension module has a `mod.rs` with the module's `DESCRIPTORS` table and
    submodules by area; e.g. `src/fs/{mod,rw,dirs,fd,meta,links,consts,base64,sys}.rs`.
    Each function is a `zun_abi::ZunInvoke` over `std` (plus `libc` /
    `windows-sys` for what `std` does not cover, behind `sys.rs`).
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
  with no `--ext`. `util`, `path` and `events` are this kind.
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

`node:test` is the one module in the table that is harness code rather than
library code (`tools/harness/node_test.ts`): it is not a module zun-node
implements, it is the language several of Node's newer test files are *written
in*, so without it those files cannot be bundled at all and the public API they
exercise never gets measured. Its canonical binding is the **function** `test`,
because Node's files spell both `const test = require('node:test')` — where the
module object is itself callable — and `const { test } = require('node:test')`.

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
  namespaces and every function) show zero divergences. `test-path-join.js` is blocked by
  `concat` on an `any` receiver flattening its argument one level too deep
  ([#16](https://github.com/UrubuCode/zun/issues/16)) and by a built-in read as
  a value ([#17](https://github.com/UrubuCode/zun/issues/17)); the `apply` and
  spread blockers it used to have are gone
  ([#1](https://github.com/UrubuCode/zun/issues/1)'s argument-shifting half and
  [#15](https://github.com/UrubuCode/zun/issues/15) are fixed, and a function
  stored in an array keeps its identity). `test-path-resolve.js` keeps #17 plus a
  Windows-only `child_process.spawnSync` block; `test-path-parse-format.js` needs a
  callable `assert` with methods ([zun#14](https://github.com/UrubuCode/zun/issues/14)).
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
- **`node:fs`: TS over natives (the `os` kind), measured against the full Node
  corpus.** `src/fs/*.rs` holds the syscalls — `open`/`close`/`read`/`write`,
  `stat`/`fstat`/`statfs`, `readdir` with `UV_DIRENT_*` tags, `mkdir`
  (reporting the first directory a recursive call created), `rm`, the links,
  `chmod`/`chown`/`utimes`, `access`, `mkdtemp`, `realpath`, `copyfile`, and the
  platform `O_*`/`S_*` table — behind a process-wide descriptor registry;
  `src/fs/fs.ts` is the Node module over them: the whole **sync** surface with
  Node's option shapes, `Stats`/`BigIntStats`/`StatsFs`/`Dirent`/`Dir`,
  `fs.constants` (null-prototype), the flag strings, the `ERR_*` validation
  errors and libuv-shaped `uvException`s, the recursive `cp`, then the
  **callback** API (argument errors thrown synchronously, operation errors
  delivered on a later tick) and **`fs.promises`** including `FileHandle`.
  50 crate tests green (`cargo test`). **Not done:** `createReadStream`/
  `createWriteStream` (needs `node:stream`), `watch`/`watchFile` (needs a
  filesystem-event source in the VM loop), `glob`/`globSync` (needs a path
  matcher), `openAsBlob` (needs `node:buffer`'s `Blob`); each throws
  `ERR_METHOD_NOT_IMPLEMENTED` rather than being absent. The acceptance bar is
  100% of Node 25's `test-fs-*` suite (227 files); the per-test blocker table is
  in `test/fs/README.md`, and the two engine bugs that cap it are
  [#38](https://github.com/UrubuCode/zun/issues/38) (a `Buffer` is opaque
  through `any`, so a test body cannot call a method on one this module returns)
  and [#14](https://github.com/UrubuCode/zun/issues/14) (the bare
  `assert(value)` form).
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
  EventTarget side tables are `Map`s. The `captureRejections` flag is a declared
  field, which is what keeps
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
  (`internal/test/binding`, `node:child_process`, a callable `assert`,
  destructured top-level bindings) — the table is in `test/os/README.md`.
  `test-os-eol.js` passes now: `assert.ts` matches the standard error
  constructors by identity, so `assert.throws(fn, TypeError)` works even though
  a constructor read as a value still has no `.name` and still cannot sit on the
  right of an `instanceof`
  ([#17](https://github.com/UrubuCode/zun/issues/17)). 28 crate tests green on
  both platforms (`cargo test`).
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
  `false`; `getters: true` cannot find an accessor because accessors are not
  reflectable; a function declaration inspects as `[Function (anonymous)]`
  because `fn.name` is unavailable
  ([#25](https://github.com/UrubuCode/zun/issues/25)) — a class correctly
  inspects as `[class Foo]`.
- **`node:assert` (harness slice): `src/assert/assert.ts`.** `ok`, `equal`,
  `notEqual`, `strictEqual`, `notStrictEqual`, `deepStrictEqual`,
  `notDeepStrictEqual`, `throws`, `doesNotThrow`, `match`, `doesNotMatch`,
  `fail`, `AssertionError` with Node's `code`/`actual`/`expected`/`operator`.
  `assert.throws(fn, Ctor)` handles the eight standard error constructors by
  matching `expected` against each one's identity and spelling the `instanceof`
  against the literal class, which is the only form the engine resolves.
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

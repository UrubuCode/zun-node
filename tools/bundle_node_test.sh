#!/usr/bin/env bash
# Turn one Node.js test file into a single Zun program.
#
# Node's tests are CommonJS: `require('assert')`, `require('node:events')`,
# `require('../common')`. The Zun engine has no `require` and no file-based
# module resolution (https://github.com/UrubuCode/zun/issues/4), so the bundler
# inlines this library's modules ahead of the test and rewrites the test's
# `require` calls to reference them.
#
# ---------------------------------------------------------------------------
# The require convention
# ---------------------------------------------------------------------------
#
# Every inlined module exposes exactly **one object**, named `__node_<module>`
# (`__node_events`, `__node_assert`, `__node_path`, `__node_util`, ...). The
# rewriting is then a single generic rule — `require('x')` and
# `require('node:x')` both become that object — plus one refinement: some
# modules are *already bound* in the bundle under the name the tests use, and a
# few of those bindings cannot be replaced by an object.
#
#   * `assert`, `path`, `process`, `common`, `fixtures` are plain bindings, so a
#     whole-line `const assert = require('assert');` is simply deleted and the
#     test's later uses resolve to the inlined module.
#   * `events` is the interesting one: its canonical binding is the **class**
#     `EventEmitter`, not an object. `new <identifier>()` only compiles in this
#     engine when the identifier is a statically known class, so
#     `const EventEmitter = require('events');`,
#     `const EventEmitter = require('events').EventEmitter;` and
#     `const { EventEmitter, once } = require('events');` must all leave the
#     name `EventEmitter` bound to that class; only the *other* destructured
#     names are taken from `__node_events`.
#
#   * `stream` is the same case six times over: `Stream`, `Readable`,
#     `Writable`, `Duplex`, `Transform` and `PassThrough` all have to stay
#     bound to their classes, so the canonical column is a comma-separated
#     **list**. Three further rewrites come with it, all of them engine
#     workarounds and all generic over that column: a member read through the
#     module alias (`stream.Readable` -> `Readable`, zun#18), a renamed
#     destructuring (`const { Readable: R } = require('stream')`, zun#21) and
#     the renamed member spelling (`const EE = require('events').EventEmitter`).
#     The last two are why `events` reads 12/35 rather than 6/35.
#
#   * `url`'s canonical binding is the legacy `Url` **class** (not `URL`, which
#     is a different thing and handled by its own rewrite further down): three
#     of Node's own files build their expectations with
#     `Object.assign(new url.Url(), …)`, and `new <object>.Ctor()` does not
#     reach a constructor in this engine (zun#18), so the member read through
#     the module alias becomes the top-level class name.
#
#   * `util/types` is the *same object* as `util.types`, and `internal/util` is
#     `util`'s own implementation surface (`sleep`, `emitExperimentalWarning`,
#     `pendingDeprecate`, `customPromisifyArgs`), which lives in
#     `src/util/util.ts` for the same reason it lives in `lib/internal/util.js`
#     in Node: it is the same module.
#   * `test` is the other canonical-binding case, and the only entry that is
#     *harness* code rather than library code: `node:test` is not a module
#     zun-node implements, it is the language several of Node's newer test files
#     are written in (`tools/harness/node_test.ts`). Its binding is the function
#     `test`, because those files spell both `const test = require('node:test')`
#     — where the module object is itself callable — and
#     `const { test } = require('node:test')`.
#
# Anything else (`internal/event_target`, `net`, `v8`, `inspector`, ...) is
# reported as an unresolved module and the bundle fails, so a missing harness
# module is never mistaken for an engine bug.
#
# CommonJS also provides `__filename` and `__dirname`; they are injected as the
# test's own location (override the file name with ZUN_NODE_TEST_FILENAME, used
# when bundling a truncated copy of a test).

# ---------------------------------------------------------------------------
# ZUN_NODE_REQUIRE: the `module` corpus, where `require` is the subject
# ---------------------------------------------------------------------------
#
# Every rule above rewrites `require(...)` *away*, which is exactly wrong for
# the one corpus whose subject is `require` itself: `test-require-cache.js`
# writes `require.cache.fs` and then asks what `require('fs')` answers, and
# `test-module-cache.js` calls `require(<a path held in a variable>)`. Both
# need `require` to be a **function at run time**, not a name the bundler
# erased.
#
# `tools/run_node_tests.sh --module module` therefore exports
# ZUN_NODE_REQUIRE=1, and this bundler then does three things differently --
# and only for that corpus, so every other bundle stays byte-identical:
#
#   1. `src/fs/fs.ts` and `src/module/module.ts` are inlined unconditionally
#      (the resolver is file-system work), so the bundle runs with `--ext`.
#   2. the generic `require('<specifier>')` -> `__node_<specifier>` rewrite is
#      **not** emitted for a Node builtin specifier. The canonical-binding
#      rules still are, so `const assert = require('assert');` is still
#      deleted and `assert` is still the inlined module -- what changes is
#      that an *inline* `require('fs')` survives to run time.
#   3. every surviving `require` in the body becomes `__zunRequire`, the
#      `require` of the bundled file's own module record
#      (`src/module/module.ts`). That one rename carries `require(...)`,
#      `require.resolve(...)`, `require.cache`, `require.extensions` and
#      `require.main` at once, and the word boundary keeps it off
#      `createRequire`.
#
# The registry that makes step 3 answer anything is emitted with the bundle:
# one `__modRegisterBuiltin("<specifier>", __node_<specifier>)` call per module
# object the bundle actually declares, which is how `node:module` knows what
# this program carries. `builtinModules` and `isBuiltin` still answer *Node's*
# list, because that list is a fact about Node's API; requiring a builtin this
# library has not implemented throws rather than answering an empty object.
#
# The last line of the bundle is `__zunHarnessFinish();`, which starts the
# settle loop that emits `process` 'exit' and verifies the `common.mustCall`
# counts. See tools/harness/common.ts for why that statement has to be here.
#
# Usage: tools/bundle_node_test.sh <node-test.js> <output.ts>
set -eu

SRC="${1:?usage: bundle_node_test.sh <node-test.js> <output.ts>}"
OUT="${2:?usage: bundle_node_test.sh <node-test.js> <output.ts>}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TEST_PATH="$(cd "$(dirname "$SRC")" && pwd)/$(basename "${ZUN_NODE_TEST_FILENAME:-$SRC}")"
# Native form on Windows, so `__filename` looks like what Node reports there.
if command -v cygpath >/dev/null 2>&1; then TEST_PATH="$(cygpath -w "$TEST_PATH")"; fi
TEST_DIR="$(dirname "$TEST_PATH")"
if command -v cygpath >/dev/null 2>&1; then TEST_DIR="$(cygpath -w "$(dirname "$(cygpath -u "$TEST_PATH")")")"; fi
json_string() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/^/"/' -e 's/$/"/'; }

# ---------------------------------------------------------------------------
# The module table: <specifier> <module object> <canonical binding>
#
# A canonical binding of `-` means the module is only reachable through its
# object. The order is the bundle order, which is also the dependency order:
# util has no dependencies of its own (it raises events' `ERR_*` classes and
# calls `process.emitWarning`, but top-level declarations resolve across the
# whole program, so bundle order does not constrain that), events formats its
# messages with util.inspect,
# process is an EventEmitter over events, assert and path stand on process, os
# stands on events (for its ERR_* classes) and process (for `env`, which
# `os.tmpdir()` reads), and the harness stands on all of them.
#
# querystring is pure string computation with no dependency of its own, punycode
# likewise, and url stands on all four of events (its `ERR_*` bases), path (for
# `fileURLToPath`/`pathToFileURL` on both platforms), querystring (`url.parse`'s
# `parseQueryString`) and punycode (`domainToASCII`/`domainToUnicode`), so it is
# inlined last of the library modules.
#
# `timers` is inlined unconditionally, and it is the one module that has to be:
# `setTimeout`/`setInterval`/`setImmediate`/`clearTimeout`/`clearInterval` are
# *globals* in Node, and in Zun they are typed intrinsics that reject an `any`
# callback or a non-numeric handle at compile time
# (https://github.com/UrubuCode/zun/issues/29). `src/timers/timers.ts` declares
# them as top-level functions, which shadows the intrinsics program-wide and
# gives every bundle Node's signatures; it reaches the VM's macrotask tier through
# the `zun:core` `timers` namespace instead of the shadowed bare names. The
# harness settle loop stands on the same file (it asks it how many ref'd timers
# are still armed), so `timers` is inlined ahead of `tools/harness/common.ts` for
# every module, not only for `test-timers-*`.
#
# `src/io/io.ts` is inlined unconditionally for the same reason, one level
# down: it is the shared asynchronous-I/O readiness loop, and the harness
# settle loop asks it how many ref'd handles are live
# (`__ioPendingRefs()`) exactly as it asks `timers` how many ref'd timers are
# armed. That question has to compile in a bundle with no extension, so the
# `import * as native from "node:io"` lives in `src/io/native.ts` and is
# appended through EXT_FILES below — the split `src/process/native.ts`
# documents. Without it `__ioAvailable()` is false and the file costs a bundle
# nothing but its declarations.
#
# `os` is the first module whose bundle also needs `--ext`: the Node-shaped API
# is this TypeScript file, but the facts underneath it are syscalls in the
# `node:os` extension, which `src/os/os.ts` reaches with
# `import * as __osNative from "node:os"`. The bundle is therefore run as
# `zun run --ext <lib> <bundle.ts>`; see tools/run_node_tests.sh's `zun-ts+ext`.
# ---------------------------------------------------------------------------
MODULE_SPECS="
util __node_util -
util/types __node_util_types -
internal/util __node_internal_util -
events __node_events EventEmitter
process __node_process process
assert __node_assert assert,Assert,strict
assert/strict __node_assert_strict -
internal/assert/myers_diff __node_internal_assert_myers_diff myersDiff
path __node_path path
os __node_os os
buffer __node_buffer Buffer
string_decoder __node_string_decoder StringDecoder
querystring __node_querystring -
punycode __node_punycode -
url __node_url Url
internal/url __node_internal_url -
fs __node_fs Stats,BigIntStats,Dirent,Dir,StatsFs,FSWatcher,StatWatcher
internal/fs/utils __node_internal_fs_utils -
fs/promises __node_fs_promises -
timers __node_timers setTimeout
timers/promises __node_timers_promises -
child_process __node_child_process -
diagnostics_channel __node_diagnostics_channel Channel,TracingChannel
async_hooks __node_async_hooks AsyncLocalStorage
console __node_console Console
internal/util/debuglog __node_internal_util_debuglog -
[.][.]/common/hijackstdio __node_harness_hijackstdio -
domain __node_domain Domain
stream __node_stream Stream,Readable,Writable,Duplex,Transform,PassThrough
stream/promises __node_stream_promises -
stream/web __node_stream_web -
stream/consumers __node_stream_consumers -
internal/streams/add-abort-signal __node_internal_streams_add_abort_signal -
_stream_readable Readable Readable
_stream_writable Writable Writable
_stream_duplex Duplex Duplex
_stream_transform Transform Transform
_stream_passthrough PassThrough PassThrough
zlib __node_zlib Deflate,Inflate,Gzip,Gunzip,DeflateRaw,InflateRaw,Unzip,BrotliCompress,BrotliDecompress
readline __node_readline Interface
readline/promises __node_readline_promises Interface
internal/readline/utils __node_internal_readline_utils CSI
internal/readline/callbacks __node_internal_readline_callbacks -
internal/util/inspect __node_internal_util_inspect -
[.][.]/common/arraystream __node_harness_arraystream ArrayStream
vm __node_vm Script,compileFunction
crypto __node_crypto Hash,Hmac,Cipheriv,Decipheriv,KeyObject
[.][.]/common/crypto __node_harness_crypto -
test __node_test test
v8 __node_v8 Serializer,Deserializer,DefaultSerializer,DefaultDeserializer,GCProfiler
tty __node_tty ReadStream,WriteStream
internal/tty __node_internal_tty -
worker_threads __node_worker_threads -
dns __node_dns Resolver
dns/promises __node_dns_promises -
net __node_net Socket,Server,Stream,BlockList,SocketAddress
internal/net __node_net -
internal/test/binding __node_internal_test_binding -
internal/errors __node_internal_errors -
[.][.]/common/internet __node_harness_internet -
perf_hooks __node_perf_hooks PerformanceEntry,PerformanceMark,PerformanceMeasure,PerformanceObserver,PerformanceObserverEntryList,PerformanceResourceTiming,Performance,createHistogram,monitorEventLoopDelay
module __node_module Module,builtinModules,isBuiltin,createRequire,SourceMap,stripTypeScriptTypes,findPackageJSON
"

# The modules inlined into every bundle, in dependency order.
BUNDLE_FILES="
src/util/util.ts
src/events/events.ts
src/process/process.ts
src/assert/assert.ts
src/path/path.ts
src/querystring/querystring.ts
src/punycode/punycode.ts
src/url/whatwg.ts
src/url/url.ts
src/timers/timers.ts
src/io/io.ts
src/console/console.ts
"

# Files inlined only when the bundle will be run WITH the native extension.
#
# `src/process/process.ts` is in BUNDLE_FILES above, because every module in
# this library stands on `process` — and most of those bundles run as
# `zun run <bundle.ts>` with no `--ext` at all. So `process` cannot import its
# own natives: the import lives in `src/process/native.ts`, which is nothing but
# that import and one `__processInstallNative(...)` call, and is appended here
# only when an extension will actually be loaded. `process.ts` keeps a
# documented fallback for every native-backed value, so a bundle without this
# file still compiles and still runs.
#
# The gate is the environment variable ZUN_NODE_EXT, which
# `tools/run_node_tests.sh` sets whenever it passes `--ext` (its `zun-ts+ext`
# and `extension` kinds). It is a *list*, one file per line, so a later module
# in the same position needs no second mechanism.
EXT_FILES="
src/process/native.ts
src/io/native.ts
"

# Modules inlined **only when the test actually requires them**.
#
# Two reasons put a file here. The first is the native extension: `os`'s source
# calls into the cdylib, so inlining it unconditionally would make every `path`
# and `events` bundle fail to compile without one, which is exactly the coupling
# PLAN.md's principle 2 keeps out of a pure-computation module.
#
# The second is a **load-time side effect**. `punycode` emits its DEP0040
# deprecation warning when the module is first required (Node does it at the top
# of `lib/punycode.js`), and `test-punycode.js` asserts the warning with
# `common.expectWarning`. The algorithms themselves are always inlined, because
# `src/url/url.ts` stands on them for `domainToASCII`/`domainToUnicode`; only the
# `process.emitWarning` call is conditional, so requiring `node:url` does not
# emit a `punycode` warning — just as it does not in Node.
#
# `buffer` and `string_decoder` are conditional for a different reason: they
# need no `--ext`, but inlining them into every `path`/`events`/`util` bundle
# would put two more files in front of tests that never mention them. A module
# may list several files -- `string_decoder` reads `ERR_UNKNOWN_ENCODING` and
# `__bufNormalizeEncoding` out of `src/buffer/buffer.ts`, exactly as Node's
# `lib/string_decoder.js` does `require('buffer')` -- and a file already queued
# is not appended twice, so a test that requires both gets one copy of each.
#
# `readline` is here for a third reason, and it is the strongest one: the module
# is **three** files, and which of the last two is inlined decides what the name
# `Interface` means. `node:readline` and `node:readline/promises` both bind that
# name, to two different classes (a callback `question` and a promise-returning
# one), and the name has to be a top-level class rather than a module-object
# member because `new <object>.Ctor()` does not reach the constructor in this
# engine (zun#18) while Node's tests spell the constructor
# `new readline.Interface(...)`. Two top-level declarations of one name are a
# compile error in a single program, so `src/readline/callback.ts` and
# `src/readline/promises.ts` each declare `Interface` and the shared base lives
# in `src/readline/readline.ts`. No test in the corpus requires both modules, so
# exactly one of the two is ever inlined. `internal/readline/utils` and
# `internal/util/inspect` are two internal surfaces the readline corpus requires
# under `--expose-internals`; both are served by `src/readline/readline.ts`.
#
# `../common/arraystream` is `test/common/arraystream.js`, a fake stream three
# readline tests push lines into. It stands on `Stream`, so it is listed after
# `stream`'s own files.
#
# `tty` stands on `stream` (its two terminal streams are `Duplex`es) and on
# `readline` — `lib/tty.js` lazily requires `readline` for `cursorTo`,
# `moveCursor`, `clearLine` and `clearScreenDown`, and reaching them *through*
# the module object is observable behaviour (`test-tty-backwards-api.js`
# replaces them). Only `src/readline/readline.ts` is listed, which is the file
# that holds those four functions and `__node_readline`; the `Interface` half
# (`callback.ts` / `promises.ts`) comes along only when the test requires
# `readline` itself, and the `readline` block above is listed first so that a
# test requiring both gets one copy in dependency order.
#
# `v8` stands on `stream` for one member: `getHeapSnapshot()` answers a
# `Readable`. The serializer itself is pure computation over the engine's
# `Buffer` and a `DataView`.

# `vm` is conditional for the plainest of the reasons: two corpora other than
# its own require it (`querystring` for a second-realm object literal, `domain`
# for five files), and nothing else needs it, so there is no sense putting a
# module whose whole floor is `new Function` in front of every `path` bundle.
# It also declares a top-level `compileFunction`, which is its canonical
# binding in the table above -- `vm.compileFunction(...)` hands back a
# *closure*, and a closure returned through a dynamic member call reads as a
# non-callable box in this engine (zun#17/#19), so that call has to be static.
#
# `fs` is six files rather than one, and the split is the same argument
# `readline`'s is. `src/fs/fs.ts` is the Node API, `src/fs/streams.ts` is
# `ReadStream`/`WriteStream` and therefore needs `stream` (and `buffer` and
# `string_decoder` under it), and `src/fs/watchers.ts` is
# `watch`/`watchFile`, which needs nothing but `timers`. The reason `fs.ts`
# does not simply name those classes is `../common/tmpdir` below: 160 of the
# `fs` corpus' files reach `fs` *only* through it, as do tests in the `zlib`,
# `readline` and `domain` corpora, and a bundle that wants a temp directory
# must not grow a 5,000-line stream module. So `tmpdir` lists `fs.ts` and
# `watchers.ts` and stops there, and `fs.ts` reaches the two stream entry
# points through a hook table that keeps throwing
# `ERR_METHOD_NOT_IMPLEMENTED` until `streams.ts` overwrites it.
# `internal/fs/utils` is the same set plus `src/fs/internal.ts`.
#
# One line per module: `<specifier> <file>`. The files are appended in this
# order, after BUNDLE_FILES and before the harness.
CONDITIONAL_FILES="
os src/os/os.ts
buffer src/buffer/buffer.ts
string_decoder src/buffer/buffer.ts
string_decoder src/string_decoder/string_decoder.ts
stream src/buffer/buffer.ts
stream src/string_decoder/string_decoder.ts
stream src/stream/stream.ts
stream/promises src/buffer/buffer.ts
stream/promises src/string_decoder/string_decoder.ts
stream/promises src/stream/stream.ts
stream/web src/buffer/buffer.ts
stream/web src/string_decoder/string_decoder.ts
stream/web src/stream/stream.ts
stream/consumers src/buffer/buffer.ts
stream/consumers src/string_decoder/string_decoder.ts
stream/consumers src/stream/stream.ts
_stream_readable src/buffer/buffer.ts
_stream_readable src/string_decoder/string_decoder.ts
_stream_readable src/stream/stream.ts
internal/streams/add-abort-signal src/buffer/buffer.ts
internal/streams/add-abort-signal src/string_decoder/string_decoder.ts
internal/streams/add-abort-signal src/stream/stream.ts
crypto src/buffer/buffer.ts
crypto src/string_decoder/string_decoder.ts
crypto src/stream/stream.ts
crypto src/crypto/crypto.ts
[.][.]/common/crypto src/buffer/buffer.ts
[.][.]/common/crypto src/string_decoder/string_decoder.ts
[.][.]/common/crypto src/stream/stream.ts
[.][.]/common/crypto src/crypto/crypto.ts
[.][.]/common/crypto tools/harness/crypto_common.ts
zlib src/buffer/buffer.ts
zlib src/string_decoder/string_decoder.ts
zlib src/stream/stream.ts
zlib src/zlib/zlib.ts
test tools/harness/node_test.ts
vm src/vm/vm.ts
punycode src/punycode/deprecation.ts
fs src/buffer/buffer.ts
fs src/string_decoder/string_decoder.ts
fs src/stream/stream.ts
fs src/fs/fs.ts
fs src/fs/streams.ts
fs src/fs/watchers.ts
internal/fs/utils src/buffer/buffer.ts
internal/fs/utils src/string_decoder/string_decoder.ts
internal/fs/utils src/stream/stream.ts
internal/fs/utils src/fs/fs.ts
internal/fs/utils src/fs/streams.ts
internal/fs/utils src/fs/watchers.ts
internal/fs/utils src/fs/internal.ts
fs/promises src/buffer/buffer.ts
fs/promises src/string_decoder/string_decoder.ts
fs/promises src/stream/stream.ts
fs/promises src/fs/fs.ts
fs/promises src/fs/streams.ts
fs/promises src/fs/watchers.ts
child_process src/child_process/child_process.ts
async_hooks src/async_hooks/async_hooks.ts
domain src/domain/domain.ts
diagnostics_channel src/async_hooks/async_hooks.ts
diagnostics_channel src/diagnostics_channel/diagnostics_channel.ts
[^']*common/tmpdir src/fs/fs.ts
[^']*common/tmpdir src/fs/watchers.ts
[^']*common/tmpdir tools/harness/tmpdir.ts
[.][.]/common/hijackstdio tools/harness/hijackstdio.ts
perf_hooks src/perf_hooks/perf_hooks.ts
readline src/buffer/buffer.ts
readline src/string_decoder/string_decoder.ts
readline src/readline/readline.ts
readline src/readline/callback.ts
readline/promises src/buffer/buffer.ts
readline/promises src/string_decoder/string_decoder.ts
readline/promises src/readline/readline.ts
readline/promises src/readline/promises.ts
internal/readline/utils src/buffer/buffer.ts
internal/readline/utils src/string_decoder/string_decoder.ts
internal/readline/utils src/readline/readline.ts
internal/readline/callbacks src/buffer/buffer.ts
internal/readline/callbacks src/string_decoder/string_decoder.ts
internal/readline/callbacks src/readline/readline.ts
internal/util/inspect src/buffer/buffer.ts
internal/util/inspect src/string_decoder/string_decoder.ts
internal/util/inspect src/readline/readline.ts
[.][.]/common/arraystream src/buffer/buffer.ts
[.][.]/common/arraystream src/string_decoder/string_decoder.ts
[.][.]/common/arraystream src/stream/stream.ts
[.][.]/common/arraystream tools/harness/arraystream.ts
tty src/buffer/buffer.ts
tty src/string_decoder/string_decoder.ts
tty src/stream/stream.ts
tty src/readline/readline.ts
tty src/tty/tty.ts
internal/tty src/buffer/buffer.ts
internal/tty src/string_decoder/string_decoder.ts
internal/tty src/stream/stream.ts
internal/tty src/readline/readline.ts
internal/tty src/tty/tty.ts
v8 src/buffer/buffer.ts
v8 src/string_decoder/string_decoder.ts
v8 src/stream/stream.ts
v8 src/v8/v8.ts
dns src/dns/dns.ts
dns/promises src/dns/dns.ts
net src/buffer/buffer.ts
net src/string_decoder/string_decoder.ts
net src/stream/stream.ts
net src/net/net.ts
internal/net src/buffer/buffer.ts
internal/net src/string_decoder/string_decoder.ts
internal/net src/stream/stream.ts
internal/net src/net/net.ts
internal/test/binding src/dns/dns.ts
internal/test/binding tools/harness/binding.ts
internal/errors src/dns/dns.ts
internal/errors tools/harness/binding.ts
module src/fs/fs.ts
module src/module/module.ts
[.][.]/common/internet tools/harness/internet.ts
"

# The harness, which stands on everything above it.
#
# `tools/harness/node_test.ts` is *not* here: it declares a top-level
# `function test(...)`, which is the name several of Node's own test files give
# their local helper (`test-buffer-tostring-rangeerror.js`,
# `test-buffer-constructor-node-modules-paths.js`, `test-string-decoder.js`),
# and two top-level declarations of one name are a compile error in a single
# Zun program. Inlining it unconditionally therefore reported "duplicate
# function declaration" for tests whose real blocker is something else
# entirely. It is in CONDITIONAL_FILES above instead, under the one name it
# provides (`test`), so only a test that actually requires it gets it.
HARNESS_FILES="
tools/harness/common.ts
"

obj_of() { printf '%s\n' "$MODULE_SPECS" | awk -v m="$1" '$1 == m { print $2 }'; }
canon_of() { printf '%s\n' "$MODULE_SPECS" | awk -v m="$1" '$1 == m { print $3 }'; }

# Does the test require `<module>` (bare or `node:`-prefixed)? Single quotes
# only, which is exactly what the rewriting rules above match — if that ever
# grows, this grows with it, and until then a double-quoted require fails the
# unresolved-require check at the end rather than silently losing a module.
#
# A plain name is tested in-shell against the source read once (a `grep` per
# conditional file cost ~3 s per bundle on Windows); a name written as a regex
# (`[^']*common/tmpdir`) still goes through grep.
SRC_TEXT="$(<"$SRC")"
module_required() {
  case "$SRC_TEXT" in
    *"require('$1')"*|*"require('node:$1')"*|*"require('$1.js')"*) return 0;;
  esac
  return 1
}
requires_module() {
  case "$1" in
    *[][*?\\]*) grep -Eq "require\('(node:)?$1(\.js)?'\)" "$SRC";;
    *) module_required "$1";;
  esac
}

# ---------------------------------------------------------------------------
# Destructuring a module object (https://github.com/UrubuCode/zun/issues/34)
# ---------------------------------------------------------------------------
#
# A top-level destructuring binding is invisible to every function in the
# program:
#
#     const ns = { sep: "/" };
#     const { sep } = ns;
#     console.log(sep);                 // "/"
#     function f() { console.log(sep); }
#     f();                              // ReferenceError
#
# and `const { sep } = require('path')` is how Node's tests spell half of their
# imports, so a test that uses such a name inside *any* function fails with a
# ReferenceError that has nothing to do with what it is testing
# (`test-fs-make-callback.js` is one line of `${tmpdir.path}${sep}` inside a
# helper).
#
# A member read of the same object is visible everywhere, so the pattern is
# rewritten into one binding per name, on one line so that every later line
# keeps its number:
#
#     const { a, b: c } = __node_path;  ->  const a = __node_path.a; const c = __node_path.b;
#
# The right-hand side has to be a **bare reference** -- an identifier, or an
# identifier followed by a member path (`__node_fs.promises`, which is how
# `require('fs').promises` lands, or `fs.promises` through the test's own
# alias) -- and every entry in the brace list has to be a plain name or a
# `name: alias` pair. That is what makes the split safe: a bare reference is
# read the same way either side of the rewrite. A call, an `await`, a default,
# a rest element or a nested pattern is left exactly as written, because the
# point is to dodge one engine bug rather than to reimplement destructuring.
#
# This runs after the whole $REWRITE program, so it sees the module objects the
# `require` rules have already substituted in.
UNPACK_MODULE_DESTRUCTURING='
{
  line = $0;
  if (line ~ /^[[:space:]]*(const|let|var)[[:space:]]*\{[^{}]*\}[[:space:]]*=[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)*[[:space:]]*;[[:space:]]*$/) {
    kw = line; sub(/^[[:space:]]*/, "", kw); sub(/[[:space:]].*$/, "", kw);
    obj = line; sub(/^.*=[[:space:]]*/, "", obj); sub(/[[:space:]]*;[[:space:]]*$/, "", obj);
    inner = line; sub(/^[^{]*\{/, "", inner); sub(/\}[^}]*$/, "", inner);
    count = split(inner, parts, ",");
    out = ""; ok = 1;
    for (i = 1; i <= count; i++) {
      entry = parts[i];
      gsub(/^[[:space:]]+/, "", entry); gsub(/[[:space:]]+$/, "", entry);
      if (entry == "") continue;
      if (entry ~ /^[A-Za-z_$][A-Za-z0-9_$]*$/) {
        out = out kw " " entry " = " obj "." entry "; ";
      } else if (entry ~ /^[A-Za-z_$][A-Za-z0-9_$]*[[:space:]]*:[[:space:]]*[A-Za-z_$][A-Za-z0-9_$]*$/) {
        key = entry; sub(/[[:space:]]*:.*$/, "", key);
        name = entry; sub(/^[^:]*:[[:space:]]*/, "", name);
        out = out kw " " name " = " obj "." key "; ";
      } else { ok = 0; break; }
    }
    if (ok == 1 && out != "") { print out; next; }
  }
  print line;
}
'

# ---------------------------------------------------------------------------
# A top-level `return`
# ---------------------------------------------------------------------------
#
# CommonJS runs a module body inside a function wrapper, so a top-level
# `return` is legal in a Node test, and it is how a dozen of them spell an
# early `common.skip`:
#
#     if (common.isWindows) { common.skip('...'); return; }
#
# A bundle is one *program*, where the parser rejects that outright -- the test
# then fails on a parse error rather than on whatever it is really about, or,
# as with the seven `fs` files that open this way, rather than skipping
# cleanly. So the test body -- and only the body, never the inlined modules --
# is wrapped in a function of its own when the source has such a `return`.
#
# The wrapper is conditional rather than unconditional on purpose: it turns
# every top-level declaration in the test into a function-local one. That is
# the scope CommonJS gives them, but it is *not* the scope the rest of this
# bundler's rewriting assumes (a deleted `const assert = require('assert')`
# resolves to the inlined top-level binding either way, but a test whose own
# declaration shadows an inlined name behaves differently inside a function),
# so a file that does not need the wrapper does not get it.
#
# The test is lexical: a `return` at an indentation shallow enough to be
# top-level in a Node test file. Node's style indents a nested `return` by at
# least four spaces inside a function, and the `if (...) { ...; return; }`
# skips above are at two.
if grep -Eq '^[[:space:]]{0,3}return[[:space:]]*;' "$SRC"; then
  WRAP_BODY=1
else
  WRAP_BODY=0
fi

# The final file list: the always-inlined modules, then the extension-backed
# ones this test actually requires, then the harness.
FILES="$BUNDLE_FILES"
if [ -n "${ZUN_NODE_EXT:-}" ]; then
  FILES="$FILES$EXT_FILES"
fi
while read -r name file; do
  [ -n "${name:-}" ] || continue
  requires_module "$name" || continue
  # One file can be named by several specifiers (`fs` and `fs/promises` are two
  # module objects in one source file), so each is appended at most once.
  case "
$FILES" in *"
$file
"*) continue;; esac
  FILES="$FILES$file
"
done <<EOF_CONDITIONAL
$CONDITIONAL_FILES
EOF_CONDITIONAL

# The `module` corpus always carries the resolver and the file system under it,
# whether or not the test in hand spells `require('module')`; see
# ZUN_NODE_REQUIRE above. The append-once rule is the loop's.
if [ -n "${ZUN_NODE_REQUIRE:-}" ]; then
  for required in src/fs/fs.ts src/module/module.ts; do
    case "
$FILES" in *"
$required
"*) continue;; esac
    FILES="$FILES$required
"
  done
fi

# The global `performance`.
#
# `performance` is a *global* in Node, so a test can reach it without ever
# writing `require('perf_hooks')` -- `test-performance-many-marks.js` does
# nothing else. The engine's prelude has a `performance` of its own with a
# single method, so such a test compiles and then fails on the second method it
# calls; the CONDITIONAL_FILES entry above cannot help it, because that gate is
# the `require` call. One in-shell substring test over the source already read
# therefore appends the module for any test that mentions `performance` or one
# of the `Performance*` classes, with the same append-once rule as the loop.
case "$SRC_TEXT" in *erformance*)
  case "
$FILES" in
    *"
src/perf_hooks/perf_hooks.ts
"*) :;;
    *) FILES="${FILES}src/perf_hooks/perf_hooks.ts
";;
  esac;;
esac

# The global `console`.
#
# `src/console/console.ts` is in BUNDLE_FILES because `console` is a *global* in
# Node and the engine's own prelude `console` has only five of its nineteen
# methods (and a call to any other is a compile error, not a missing method), so
# every bundle needs the real one. The two bindings that shadow the prelude are
# in `src/console/global.ts`, split off for the same reason
# `tools/harness/node_test.ts` is conditional: `test-console-table.js` and
# `test-console-log-throw-primitive.js` declare their own top-level
# `const console = new Console(...)`, and two top-level declarations of one name
# are a compile error in a single Zun program. Such a test keeps its own
# binding (renamed, see below) and the global file is left out.
OWN_CONSOLE=no
if grep -Eq "^[[:space:]]*(const|let|var)[[:space:]]+console[[:space:]]*=" "$SRC"; then
  OWN_CONSOLE=yes
else
  FILES="${FILES}src/console/global.ts
"
fi

FILES="$FILES$HARNESS_FILES"

# `common.hasCrypto`.
#
# The flag has to track what this bundle contains rather than what the library
# can do, and the decision is only known after the conditional loop above has
# run -- so `tools/harness/crypto_flag.ts` sets it *after* the harness, which
# is the one position later than `common.ts`' own declaration. See that file.
case "
$FILES" in
  *"
src/crypto/crypto.ts
"*) FILES="${FILES}tools/harness/crypto_flag.ts
";;
esac

# ---------------------------------------------------------------------------
# Build the sed program that rewrites the test body.
# ---------------------------------------------------------------------------
# `$LATE` collects the rules that must be the *last* in the sed program: the
# body-wide alias renames, which may only run once every `require(...)` call
# has been rewritten. The loop below runs in a pipeline subshell, so a file is
# the only way to carry them out of it.
REWRITE="$(mktemp)"
LATE="$(mktemp)"
trap 'rm -f "$REWRITE" "$LATE"' EXIT

# Every per-module rule below matches only that module's own `require(...)`
# call, so a module the test never requires contributes nothing;
# `module_required` (defined with `requires_module` above) skips it with an
# in-shell string test. The rule generation spawns `sed`, `sort` and `tr` per
# module, which costs ~0.6 s each on Windows and made the bundler, not the
# engine, the slowest step of every tracker run.

{
  # Strip the CommonJS strict-mode pragma: the bundle is one program and the
  # inlined modules are not written against it.
  printf "s/^'use strict';[[:space:]]*$//\n"
  printf 's/^"use strict";[[:space:]]*$//\n'

  # `../common` and `../common/fixtures` are bound by the harness itself.
  printf "s|^\\(const\\|let\\|var\\)[[:space:]]\\{1,\\}common[[:space:]]*=[[:space:]]*require('\\.\\./common')[[:space:]]*;[[:space:]]*\$||\n"
  printf "s|^\\(const\\|let\\|var\\)[[:space:]]\\{1,\\}fixtures[[:space:]]*=[[:space:]]*require('\\.\\./common/fixtures')[[:space:]]*;[[:space:]]*\$||\n"
  printf "s|^require('\\.\\./common')[[:space:]]*;[[:space:]]*\$||\n"
  printf "s|require('\\.\\./common/fixtures')|fixtures|g\n"
  printf "s|^\(const\|let\|var\)[[:space:]]\{1,\}tmpdir[[:space:]]*=[[:space:]]*require('[^']*common/tmpdir\(\.js\)\{0,1\}')[[:space:]]*;[[:space:]]*\$||\n"
  printf "s|require('[^']*common/tmpdir\(\.js\)\{0,1\}')|tmpdir|g\n"
  printf "s|require('\\.\\./common')|common|g\n"

  # A `common` helper handed straight to `Promise.prototype.then` / `.catch` /
  # `.finally` is rewritten to the top-level spelling in
  # tools/harness/common.ts.
  #
  # An object-literal method cannot return a function value in this engine, so
  # `common.mustCall()` answers a `functionBox` -- and `then` drops a box
  # silently, because `promiseThen`'s `callback_arg` accepts only a
  # `Value::Function` (the full explanation is on `__commonMustCall` in that
  # file). The top-level functions hand back the bare wrapper, which `then`
  # does invoke; 21 of the 227 files in the `fs` corpus end in
  # `assert.rejects(...).then(common.mustCall())` and ran *none* of their
  # assertions before this.
  #
  # The rewrite is deliberately scoped to that one position rather than to
  # every `common.mustCall` in the file. The box is not a wart: a bare
  # function reaches `src/domain/domain.ts`' `intercept` and comes back
  # boxed, so `assert.strictEqual(err.domainBound, mustNotCall)` in
  # `test-domain-intercept.js` stops holding -- and a reaction position is
  # exactly where the box is useless, since it is never called at all.
  # `mustCallAtLeast` is listed before `mustCall` so that the longer name
  # wins.
  printf "s|\\.then(common\\.mustCallAtLeast|.then(__commonMustCallAtLeast|g\n"
  printf "s|\\.then(common\\.mustCall|.then(__commonMustCall|g\n"
  printf "s|\\.then(common\\.mustNotCall|.then(__commonMustNotCall|g\n"
  printf "s|\\.then(common\\.mustSucceed|.then(__commonMustSucceed|g\n"
  printf "s|\\.catch(common\\.mustCall|.catch(__commonMustCall|g\n"
  printf "s|\\.catch(common\\.mustNotCall|.catch(__commonMustNotCall|g\n"
  printf "s|\\.finally(common\\.mustCall|.finally(__commonMustCall|g\n"

  # `path/posix` and `path/win32` are bound inside path.ts under those names.
  printf "s|require('\\(node:\\)\\{0,1\\}path/posix')|posix|g\n"
  printf "s|require('\\(node:\\)\\{0,1\\}path/win32')|win32|g\n"

  # `console` as a *receiver* becomes `__zunConsole`.
  #
  # The identifier `console` cannot carry a method call in this engine, for two
  # reasons that compound (both documented, with repros, in
  # ../test/console/README.md and at the declaration in src/console/global.ts):
  # eleven of the nineteen method names are intercepted by the checker and
  # lowered to the prelude's console with no user-declaration guard, and a
  # module-level `const console` is invisible to `console.<method>` from inside
  # a function. So `console.log(...)`, `console.table(...)` and
  # `console[method](...)` are rewritten to the second name
  # `src/console/global.ts` binds to the very same object — leaving every *other*
  # use of the word alone, so `const { Console } = console` and
  # `globalThis.console` still read the name Node programs expect.
  #
  # The match requires a method-access or index immediately after the name, and
  # refuses a quote immediately before it, so a `console.log` that is *data* —
  # `execNode('-e "console.log(1)"')` in the `child_process` corpus,
  # `eval('console.log("FOO");…')` in `test-assert.js`, a script written to a
  # file in `test-fs-realpath.js` — is left as written. The rule is emitted
  # twice because sed's `g` consumes the character it matched before the name,
  # so two occurrences sharing one separator would otherwise need a second pass.
  #
  # A test that declares its own `console` has that declaration renamed as well
  # (it owns the name, and `src/console/global.ts` is not in its bundle).
  # `printf '%s\n'` rather than a format string: a bare `\1` backreference in a
  # printf *format* is an octal escape, which would emit a U+0001 into the sed
  # program instead of the backreference.
  if [ "$OWN_CONSOLE" = yes ]; then
    printf '%s\n' "s#^\([[:space:]]*\)\(const\|let\|var\)\([[:space:]]\{1,\}\)console\([[:space:]]*=\)#\1\2\3__zunConsole\4#"
  fi
  for _pass in 1 2; do
    printf '%s\n' "s#^console\(\.[A-Za-z_\$]\|\[\)#__zunConsole\1#"
    printf '%s\n' "s#\([^'\"\`A-Za-z0-9_\$.]\)console\(\.[A-Za-z_\$]\|\[\)#\1__zunConsole\2#g"
  done

  # `performance` as a *receiver* becomes `__zunPerformance`, for the same
  # reason and by the same rules as `console` above: the engine's prelude has a
  # `performance` whose `now()` spelling the checker lowers to the prelude even
  # when a user declaration shadows it, so the real module is bound under a
  # second name that the checker has no opinion about (see the header of
  # src/perf_hooks/perf_hooks.ts). A member read through a dot
  # (`perf_hooks.performance`, `globalThis.performance`) is excluded by the
  # same character class the console rule uses, and a test that declares its
  # own `performance` keeps it -- the module object is still reachable as
  # `__node_perf_hooks.performance`.
  if ! grep -Eq "^[[:space:]]*(const|let|var)[[:space:]]+performance[[:space:]]*=" "$SRC"; then
    for _pass in 1 2; do
      printf '%s\n' "s#^performance\(\.[A-Za-z_\$]\|\[\)#__zunPerformance\1#"
      printf '%s\n' "s#\([^'\"\`A-Za-z0-9_\$.]\)performance\(\.[A-Za-z_\$]\|\[\)#\1__zunPerformance\2#g"
    done
  fi

  # `crypto` as a *receiver* becomes `__zunCrypto`, for the same reason and by
  # the same rules as `console` and `performance` above: the engine's prelude
  # has a `crypto` of its own (`crates/zun_prelude/builtin/crypto.zun`, the
  # WinterCG `getRandomValues`/`randomUUID` pair), and the checker lowers
  # `crypto.<member>` to it from inside a function body even when a user
  # declaration shadows the name. So
  #
  #     const crypto = require('crypto');
  #     function f() { return crypto.createHash('sha1'); }
  #
  # answers "createHash is not a function", while the same call at the top
  # level works. That is the second half of zun#85, filed for `console`, landing
  # on a second prelude namespace; the standalone repro is in
  # ../test/crypto/README.md. `src/crypto/crypto.ts` binds the second name to
  # the very same object; see its note.
  #
  # Emitted only for a test that actually requires `crypto`, so every other
  # corpus' bundle stays byte-identical, and the leading character class keeps
  # `require('crypto')`, `require('node:crypto')` and a member read such as
  # `webcrypto.crypto` as written.
  if requires_module "crypto"; then
    for _pass in 1 2; do
      printf '%s\n' "s#^crypto\(\.[A-Za-z_\$]\|\[\)#__zunCrypto\1#"
      printf '%s\n' "s#\([^'\"\`A-Za-z0-9_\$.]\)crypto\(\.[A-Za-z_\$]\|\[\)#\1__zunCrypto\2#g"
    done
  fi

  # `URL` / `URLSearchParams` as a *constructor*, a *static receiver*, an
  # `instanceof` right-hand side or a class base become `NodeURL` /
  # `NodeURLSearchParams`.
  #
  # Those two names are **prelude classes** in this engine
  # (crates/zun_prelude/builtin/url.zun, url_search_params.zun), and a user
  # class of the same name is rejected outright with "duplicate class" -- so the
  # WHATWG spec implementation in src/url/whatwg.ts cannot be *called* `URL`. It
  # is declared there as `NodeURL`/`NodeURLSearchParams` and exported as
  # `url.URL`/`url.URLSearchParams`, which is the spelling Node's own tests
  # reach for (`const { URL } = require('url')`); the three spellings a test
  # body uses to reach the class itself are rewritten here. That is the same
  # move the `console`, `performance` and `crypto` rules above make, for the
  # same reason: a prelude name the checker owns, bound to the real module under
  # a second name.
  #
  # Every *other* appearance of the word is left exactly as written -- a string,
  # `ERR_INVALID_URL`, `globalThis.URL`, a local called `fileURL` -- because
  # each rule needs either `new `/`instanceof `/`extends ` before the name or a
  # member access immediately after it, and the member rule refuses a word
  # character, a dot or a quote before the name (so `myURL.href`,
  # `require('url').URL` and `'url.canParse'` are untouched). Audited over the
  # whole `test-url*` + `test-whatwg-url-*` corpus: the only matches inside a
  # string literal are in `test-whatwg-url-canparse.js`, which needs `eval` and
  # V8 natives syntax and cannot run here at all.
  #
  # Emitted only for a test whose source mentions the word, so every other
  # corpus' bundle stays byte-identical. `\b` is what keeps `URL` from matching
  # the prefix of `URLSearchParams`, and `printf '%s\n'` rather than a format
  # string, because a bare `\1` in a printf *format* is an octal escape.
  case "$SRC_TEXT" in *URL*)
    printf '%s\n' "s#\bnew URLSearchParams\b#new NodeURLSearchParams#g"
    printf '%s\n' "s#\bnew URL\b#new NodeURL#g"
    printf '%s\n' "s#\binstanceof URLSearchParams\b#instanceof NodeURLSearchParams#g"
    printf '%s\n' "s#\binstanceof URL\b#instanceof NodeURL#g"
    printf '%s\n' "s#\bextends URLSearchParams\b#extends NodeURLSearchParams#g"
    printf '%s\n' "s#\bextends URL\b#extends NodeURL#g"
    for _pass in 1 2; do
      printf '%s\n' "s#^URLSearchParams\(\.[A-Za-z_\$]\)#NodeURLSearchParams\1#"
      printf '%s\n' "s#\([^'\"\`A-Za-z0-9_\$.]\)URLSearchParams\(\.[A-Za-z_\$]\)#\1NodeURLSearchParams\2#g"
      printf '%s\n' "s#^URL\(\.[A-Za-z_\$]\)#NodeURL\1#"
      printf '%s\n' "s#\([^'\"\`A-Za-z0-9_\$.]\)URL\(\.[A-Za-z_\$]\)#\1NodeURL\2#g"
    done;;
  esac

  # A canonical binding recovered from an *aliased* module object.
  #
  # The canonical-binding rules below only see the `require(...)` call itself:
  # `const { Channel } = require('diagnostics_channel')` keeps `Channel` bound to
  # the top-level class, but `const dc = require('diagnostics_channel'); const
  # { Channel } = dc;` does not — the second line destructures a local alias, so
  # `Channel` becomes an `any` holding the class. That matters because
  # `x instanceof C` is a *runtime* failure in this engine when `C` is an
  # `any`-typed binding rather than a class name ("call did not resolve to a
  # method"; zun#72 is the compile-time half of the same gap, for
  # `x instanceof ns.Ctor`), and two of Node's own tests for this module assert
  # `channel instanceof Channel` through exactly that alias.
  #
  # So the one-name destructuring is dropped as well, leaving `Channel` bound to
  # the class — the same move the `events`/`EventEmitter` rule makes, one
  # indirection further along. It is emitted only for a test that actually
  # requires `diagnostics_channel`, so no other corpus can be touched by it.
  if requires_module "diagnostics_channel"; then
    printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}{[[:space:]]*Channel[[:space:]]*}[[:space:]]*=[[:space:]]*[A-Za-z_\$][A-Za-z0-9_\$]*[[:space:]]*;[[:space:]]*\$##\n"
  fi

  # `internal/util/inspect`'s `stripVTControlCharacters`, dropped from a
  # destructuring list.
  #
  # That name is already a top-level *function* in the always-inlined
  # src/util/util.ts, so a `const { stripVTControlCharacters } = ...` at the top
  # level of the test body is a second declaration of it, which is a compile
  # error. The canonical-binding machinery below removes such a name from the
  # brace list, but only when the whole destructuring sits on one line, and the
  # two readline tests that reach for this write it across four:
  #
  #     const {
  #       getStringWidth,
  #       stripVTControlCharacters
  #     } = require('internal/util/inspect');
  #
  # sed is line-based, so the name is dropped by deleting the line it is alone
  # on. `getStringWidth` is left to come out of the module object, where
  # src/readline/readline.ts puts it.
  if requires_module "internal/util/inspect"; then
    printf "s#^[[:space:]]*stripVTControlCharacters[[:space:]]*,\{0,1\}[[:space:]]*\$##\n"
  fi

  # Engine workaround (https://github.com/UrubuCode/zun/issues/19 and #10):
  # `x.m.apply(x, args)` becomes `__rlApply(x, "m", args)`.
  #
  # A method a class declared cannot be *read* as a value here -- `rl.write`
  # answers `undefined` while `rl.write(...)` works -- so `.apply` on one is
  # unreachable; a field holding the function instead reads back `undefined` as
  # well (a function stored in a class instance field is lost); and
  # `x.m(...args)` does not compile either ("spread arguments are not lowered
  # yet"). `__rlApply` in src/readline/readline.ts unrolls the argument list
  # into a dynamic method call of fixed arity, which does work.
  # `test-readline.js` sends every key sequence as `rl.write.apply(rl, key)`,
  # six times over.
  #
  # The rewrite is semantics-preserving wherever it applies, because the match
  # requires the *same identifier* as receiver and as `apply`'s first argument:
  # `x.m.apply(x, args)` and `x.m(args[0], ...)` call the same function with the
  # same `this` and the same arguments. It is emitted only for a test that
  # requires `readline` -- which is also what puts `__rlApply` in the bundle --
  # so every other corpus' bundle stays byte-identical.
  #
  # `printf '%s\n'`, not a format string: a bare `\1` backreference in a printf
  # *format* is an octal escape and would emit a U+0001 instead.
  if requires_module "readline"; then
    printf '%s\n' "s#\([A-Za-z_\$][A-Za-z0-9_\$]*\)\.\([A-Za-z_\$][A-Za-z0-9_\$]*\)\.apply(\1,[[:space:]]*\([^()]*\))#__rlApply(\1, \"\2\", \3)#g"
  fi

  # Engine workaround (https://github.com/UrubuCode/zun/issues/18):
  # `<alias>.promises.Resolver` becomes the class `DnsPromiseResolver`.
  #
  # `node:dns` and `node:dns/promises` both bind the name `Resolver`, to two
  # different classes (callback-shaped queries and promise-shaped ones), and
  # `new <object>.Ctor()` does not reach a constructor in this engine -- while
  # two top-level declarations of one name are a compile error, so the two
  # classes cannot both be called `Resolver`. The promise one is therefore
  # declared as `DnsPromiseResolver` in src/dns/dns.ts, and the spelling
  # Node's own tests use for it is rewritten to that name. The rule is
  # semantics-preserving (the two denote the same class) and is emitted only
  # for a test that requires `dns`, which is also what puts the class in the
  # bundle.
  if requires_module "dns"; then
    printf '%s\n' "s#\([A-Za-z_\$][A-Za-z0-9_\$]*\)\.promises\.Resolver\b#DnsPromiseResolver#g"
  fi

  printf '%s\n' "$MODULE_SPECS" | while read -r name obj canons; do
    [ -n "${name:-}" ] || continue
    requires_module "$name" || continue
    pat="require('\\(node:\\)\\{0,1\\}$name')"

    # The canonical-binding column is a comma-separated **list**, because a
    # module may be bound several times over: `assert` three times -- as the
    # callable module object (`assert`), as the `Assert` class and as the
    # `strict` surface -- and `stream` six (`Stream`, `Readable`, `Writable`,
    # `Duplex`, `Transform`, `PassThrough`), where `events` has one. Each of
    # those names is a top-level declaration of its own in the inlined source
    # and each is a spelling Node's own test files use, so every rule below is
    # emitted once per name. The generic `require(...)` -> object rewrite is
    # emitted after the whole list, so a later binding's rules still see the
    # original `require` call.
    #
    # Every sed address here is delimited with `%` rather than `/`, because a
    # specifier may contain a slash (`internal/assert/myers_diff`,
    # `stream/promises`, `internal/streams/add-abort-signal`).
    for canon in $(printf '%s' "$canons" | tr ',' ' '); do
      [ "$canon" != "-" ] || continue

      # A **renamed** destructuring of a canonical binding --
      # `const { Readable: R } = require('stream')`, which four of the
      # `test-stream2-*` files open with -- cannot keep the new name: a class
      # base must be the original class's own identifier, so `class T extends R`
      # is rejected outright (https://github.com/UrubuCode/zun/issues/21) and
      # `new R()` over a class *value* answers undefined at run time. The two
      # names denote the same class, so the alias is collapsed back to the
      # canonical one: `Readable: R` in the brace list becomes `Readable`
      # (which the removal rules below then drop), and every later `R` becomes
      # `Readable`. That second, body-wide rename is deferred to the end of the
      # sed program (see $LATE): emitted here it would run *before* the generic
      # `require(...)` rewrites and could rewrite a specifier still spelled out
      # on another line -- `const { strict: assert } = require('assert')` would
      # turn every later `require('assert')` into `require('strict')`.
      for alias in $(sed -n "s%^[[:space:]]*\(const\|let\|var\)[[:space:]]*{[^}]*$canon[[:space:]]*:[[:space:]]*\([A-Za-z_][A-Za-z0-9_]*\)[^}]*}[[:space:]]*=[[:space:]]*require('\(node:\)\{0,1\}$name')[[:space:]]*;.*\$%\2%p" "$SRC" | sort -u); do
        [ "$alias" != "$canon" ] || continue
        printf "\%%%s%%{ s#%s[[:space:]]*:[[:space:]]*%s#%s#g; }\n" "$pat" "$canon" "$alias" "$canon"
        printf "s#\\\\b%s\\\\b#%s#g\n" "$alias" "$canon" >> "$LATE"
      done

      # The same collapse for the member spelling with a new name:
      # `const EE = require('events').EventEmitter;` -- `class T extends EE`
      # is the same rejected alias (zun#21).
      for alias in $(sed -n "s%^[[:space:]]*\(const\|let\|var\)[[:space:]]\{1,\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=[[:space:]]*require('\(node:\)\{0,1\}$name')\.$canon[[:space:]]*;.*\$%\2%p" "$SRC" | sort -u); do
        [ "$alias" != "$canon" ] || continue
        printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}%s[[:space:]]*=[[:space:]]*%s\.%s[[:space:]]*;[[:space:]]*\$##\n" "$alias" "$pat" "$canon"
        printf "s#\\\\b%s\\\\b#%s#g\n" "$alias" "$canon" >> "$LATE"
      done

      # `const <canon> = require('<name>');`  -> the binding already exists.
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}%s[[:space:]]*=[[:space:]]*%s[[:space:]]*;[[:space:]]*\$##\n" "$canon" "$pat"
      # `const <canon> = require('<name>').<canon>;`  (events' two spellings).
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}%s[[:space:]]*=[[:space:]]*%s\.%s[[:space:]]*;[[:space:]]*\$##\n" "$canon" "$pat" "$canon"
      # A destructuring that names the canonical binding keeps that name bound
      # to the existing one; drop it from the brace list -- wherever it sits in
      # the list -- and let the rest come from the module object.
      printf "\%%%s%%{ s#,[[:space:]]*%s[[:space:]]*,#,#; }\n" "$pat" "$canon"
      printf "\%%%s%%{ s#{[[:space:]]*%s[[:space:]]*,[[:space:]]*#{ #; }\n" "$pat" "$canon"
      printf "\%%%s%%{ s#,[[:space:]]*%s[[:space:]]*}# }#; }\n" "$pat" "$canon"
      printf "\%%%s%%{ s#{[[:space:]]*%s[[:space:]]*}#{}#; }\n" "$pat" "$canon"
      # `const { } = require(...)` after that removal is a no-op line.
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}{}[[:space:]]*=[[:space:]]*%s[[:space:]]*;[[:space:]]*\$##\n" "$pat"
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}{[[:space:]]*}[[:space:]]*=[[:space:]]*%s[[:space:]]*;[[:space:]]*\$##\n" "$pat"
    done

    # A bare `require('<name>');` for its side effects only.
    printf "s#^%s[[:space:]]*;[[:space:]]*\$##\n" "$pat"
    # Everything else -- `const x = require('m')`, `require('m').member`,
    # `const { a, b } = require('m')` -- becomes the module object in place.
    #
    # Except in ZUN_NODE_REQUIRE mode, where every specifier but a harness
    # one (`../common/*`) is left for the run-time `require` to resolve (see
    # the header). That includes the `internal/*` surfaces, which are *not*
    # builtins in Node: `test-require-node-prefix.js` asserts that
    # `require('node:internal/test/binding')` throws
    # ERR_UNKNOWN_BUILTIN_MODULE, which it cannot do if the bundler has
    # already turned the call into the object.
    if [ -n "${ZUN_NODE_REQUIRE:-}" ]; then
      case "$name" in
        '[.][.]/'*) printf "s#%s#%s#g\n" "$pat" "$obj";;
        *) :;;
      esac
    else
      printf "s#%s#%s#g\n" "$pat" "$obj"
    fi
  done

  # Engine workaround (https://github.com/UrubuCode/zun/issues/18): `new
  # <object>.Ctor()` compiles but answers `undefined is not a function` at run
  # time, so a test that keeps the module object in a local and constructs
  # through it -- `const stream = require('stream'); new stream.Readable()`,
  # which 54 of the 204 files in the stream corpus do -- cannot reach the
  # class at all. Every canonical binding is already a top-level name in the
  # bundle, so a member read of one through the local alias is rewritten to
  # that name: `stream.Readable` becomes `Readable`, which denotes the same
  # object and only changes the lane the engine takes. The rule is skipped
  # when the alias *is* the canonical name (`const path = require('path')`
  # must keep `path.join` as it is).
  printf '%s\n' "$MODULE_SPECS" | while read -r name obj canons; do
    [ -n "${name:-}" ] || continue
    requires_module "$name" || continue
    [ "${canons:-}" != "-" ] || continue
    aliases="$(sed -n "s%^[[:space:]]*\(const\|let\|var\)[[:space:]]\{1,\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=[[:space:]]*require('\(node:\)\{0,1\}$name')[[:space:]]*;.*\$%\2%p" "$SRC" | sort -u)"
    for alias in $aliases; do
      for canon in $(printf '%s' "$canons" | tr ',' ' '); do
        [ "$alias" != "$canon" ] || continue
        printf "s#\\\\b%s\\.%s\\\\b#%s#g\n" "$alias" "$canon" "$canon"
      done
    done
  done

  # Engine workaround (https://github.com/UrubuCode/zun/issues/20): five of
  # `events`' module statics share a name with an `EventEmitter` *instance*
  # method -- `once`, `on`, `listenerCount`, `getMaxListeners` and
  # `setMaxListeners` -- and this engine's checker will not let one class carry
  # both ("duplicate method `once`"), nor resolve `EventEmitter.once(...)` to
  # anything but the instance method ("instance method `once` must be called
  # through an object"). In Node the two spellings are *literally the same
  # function*: `lib/events.js` is `module.exports = EventEmitter` with
  # `EventEmitter.once = once` and `exports.once = once`, so
  # `require('events').once === require('events').EventEmitter.once`. The static
  # spelling is therefore rewritten to the module-object one, which denotes the
  # same function and only changes the lane the engine takes -- the same move
  # the `stream.Readable` -> `Readable` rule above makes for zun#18.
  #
  # The match requires the call parenthesis immediately after the name, so
  # `EventEmitter.prototype.on.call(...)` (a different member read, served by
  # the prototype object `src/events/events.ts` installs) and
  # `EventEmitter.defaultMaxListeners` (a real class static) are left as
  # written.
  if requires_module "events"; then
    printf '%s\n' "s#\\bEventEmitter\\.\\(once\\|on\\|listenerCount\\|getMaxListeners\\|setMaxListeners\\)(#__node_events.\\1(#g"
  fi

  # The body-wide alias renames, last of all: by this point every
  # `require('<specifier>')` in the body has already become its module object,
  # so a one-letter alias (`R`, `W`, `D`, `EE`, `SD`) can no longer collide
  # with a specifier that is still spelled out. `__node_assert` and friends are
  # out of reach too, since `_` is a word character and `\b` does not match
  # inside them.
  cat "$LATE"

  # ZUN_NODE_REQUIRE, last of all: every `require` the rules above left in
  # the body becomes `__zunRequire`. It has to be last for the same reason
  # the alias renames do -- a specifier still spelled out must already have
  # been consumed.
  #
  # The match requires a `(`, `.` or `[` immediately after the name, and
  # refuses a word character, a `-` or a `.` immediately before it, so the
  # word has to be *used as the require function* to be renamed.
  # `createRequire` and `requires` are out of reach because the name is
  # case-sensitive and the trailing class is not a word character, and -- the
  # case that made the leading class necessary -- the fixture directory name
  # `'module-require'` keeps its spelling, where a bare word boundary turned
  # it into `module-__zunRequire` and sent
  # `test-require-resolve-opts-paths-relative.js` looking for a path that does
  # not exist.
  #
  # A quote is *not* excluded, unlike the `console` rule above. Three files in
  # this corpus write a tiny CommonJS module into a scratch file as a string
  # literal (`fs.writeFileSync(f, 'require("./other");')`), and leaving those
  # alone made the whole bundle fail the unresolved-require check at the end --
  # reporting "bundle failed" for a test whose real blocker is that this
  # platform cannot compile a file at run time at all. The rewrite inside such
  # a string changes data that is written to a file nothing here can load, so
  # it costs nothing and keeps the failure honest.
  #
  # The rule is emitted twice because sed's `g` consumes the character it
  # matched before the name.
  #
  # `printf '%s\n'` rather than a format string: a bare `\1` backreference in
  # a printf *format* is an octal escape, which would emit a U+0001 into the
  # sed program instead of the backreference.
  if [ -n "${ZUN_NODE_REQUIRE:-}" ]; then
    for _pass in 1 2; do
      printf '%s\n' "s#^require\([.([]\)#__zunRequire\1#"
      printf '%s\n' "s#\([^A-Za-z0-9_\$.-]\)require\([.([]\)#\1__zunRequire\2#g"
    done
  fi
} > "$REWRITE"

# ---------------------------------------------------------------------------
# Emit the bundle.
# ---------------------------------------------------------------------------
{
  echo "// ==== zun-node bundle of $(basename "$SRC") ===="
  # One `cat` over the whole list (a `cat` per file was ~1.7 s on Windows).
  set --
  while read -r file; do
    [ -n "${file:-}" ] && set -- "$@" "$ROOT/$file"
  done <<EOF_FILES
$FILES
EOF_FILES
  cat "$@"
  echo "const __filename: string = $(json_string "$TEST_PATH");"
  echo "const __dirname: string = $(json_string "$TEST_DIR");"
  # The builtin registry and `require.main` (ZUN_NODE_REQUIRE only; see the
  # header). One declaration scan over the inlined files, then an in-shell
  # membership test per specifier -- a `grep` per specifier cost about a
  # second a bundle on Windows. Only a module object named `__node_<something>`
  # can be registered, and only under a specifier that is a Node builtin id: a
  # harness specifier (`../common/*`) is not a module `require` resolves, and
  # an `internal/*` surface is not a builtin in Node either.
  #
  # `__modInitMain()` is last, and it is here rather than in the library
  # because the module record it builds reads `__filename`, which is declared
  # just above. It is the position Node's own
  # `setOwnProperty(module.require, 'main', process.mainModule)` occupies.
  if [ -n "${ZUN_NODE_REQUIRE:-}" ]; then
    declared="$(grep -ho '^const __node_[A-Za-z0-9_]*' "$@" | sed 's/^const //' | sort -u)
"
    printf '%s\n' "$MODULE_SPECS" | while read -r name obj canons; do
      [ -n "${name:-}" ] || continue
      case "$name" in '[.][.]/'*|internal/*) continue;; esac
      case "$obj" in __node_*) ;; *) continue;; esac
      case "
$declared" in *"
$obj
"*) ;; *) continue;; esac
      printf '__modRegisterBuiltin("%s", %s);\n' "$name" "$obj"
    done
    echo "__modInitMain();"
  fi
  echo "// ==== test body ===="
  if [ "$WRAP_BODY" = 1 ]; then echo "function __zunTestBody(): void {"; fi
  sed -f "$REWRITE" "$SRC" | awk "$UNPACK_MODULE_DESTRUCTURING"
  if [ "$WRAP_BODY" = 1 ]; then echo "}"; echo "__zunTestBody();"; fi
  echo "// ==== harness epilogue: settle the loop, emit 'exit', check call counts ===="
  echo "__zunHarnessFinish();"
} > "$OUT"

# Any `require` left over means the test needs a module the bundler does not
# know; fail loudly rather than letting the engine report a mystery.
if grep -n "require(" "$OUT" | grep -v "^[0-9]*: *[*/]" >/dev/null 2>&1; then
  echo "bundle_node_test.sh: unresolved require() in $(basename "$SRC"):" >&2
  grep -n "require(" "$OUT" | grep -v "^[0-9]*: *[*/]" >&2 || true
  exit 1
fi

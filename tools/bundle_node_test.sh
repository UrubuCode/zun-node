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
# Anything else (`internal/event_target`, `vm`, `v8`, `worker_threads`, ...) is
# reported as an unresolved module and the bundle fails, so a missing harness
# module is never mistaken for an engine bug.
#
# CommonJS also provides `__filename` and `__dirname`; they are injected as the
# test's own location (override the file name with ZUN_NODE_TEST_FILENAME, used
# when bundling a truncated copy of a test).
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
assert __node_assert assert
path __node_path path
os __node_os os
buffer __node_buffer Buffer
string_decoder __node_string_decoder StringDecoder
querystring __node_querystring -
punycode __node_punycode -
url __node_url -
internal/url __node_internal_url -
fs __node_fs -
fs/promises __node_fs_promises -
child_process __node_child_process -
domain __node_domain -
stream __node_stream -
vm __node_vm -
test __node_test test
tty __node_tty -
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
src/url/url.ts
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
# One line per module: `<specifier> <file>`. The files are appended in this
# order, after BUNDLE_FILES and before the harness.
CONDITIONAL_FILES="
os src/os/os.ts
buffer src/buffer/buffer.ts
string_decoder src/buffer/buffer.ts
string_decoder src/string_decoder/string_decoder.ts
test tools/harness/node_test.ts
punycode src/punycode/deprecation.ts
fs src/fs/fs.ts
fs/promises src/fs/fs.ts
[.][.]/common/tmpdir src/fs/fs.ts
[.][.]/common/tmpdir tools/harness/tmpdir.ts
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
# entirely. It is in CONDITIONAL_FILES above instead, under both names it
# provides (`test` and `tty`), so only a test that actually requires one of
# them gets it.
HARNESS_FILES="
tools/harness/common.ts
"

obj_of() { printf '%s\n' "$MODULE_SPECS" | awk -v m="$1" '$1 == m { print $2 }'; }
canon_of() { printf '%s\n' "$MODULE_SPECS" | awk -v m="$1" '$1 == m { print $3 }'; }

# Does the test require `<module>` (bare or `node:`-prefixed)? Single quotes
# only, which is exactly what the rewriting rules above match — if that ever
# grows, this grows with it, and until then a double-quoted require fails the
# unresolved-require check at the end rather than silently losing a module.
requires_module() {
  grep -Eq "require\('(node:)?$1(\.js)?'\)" "$SRC"
}

# The final file list: the always-inlined modules, then the extension-backed
# ones this test actually requires, then the harness.
FILES="$BUNDLE_FILES"
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
FILES="$FILES$HARNESS_FILES"

# ---------------------------------------------------------------------------
# Build the sed program that rewrites the test body.
# ---------------------------------------------------------------------------
REWRITE="$(mktemp)"
trap 'rm -f "$REWRITE"' EXIT

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

  # `path/posix` and `path/win32` are bound inside path.ts under those names.
  printf "s|require('\\(node:\\)\\{0,1\\}path/posix')|posix|g\n"
  printf "s|require('\\(node:\\)\\{0,1\\}path/win32')|win32|g\n"

  printf '%s\n' "$MODULE_SPECS" | while read -r name obj canon; do
    [ -n "${name:-}" ] || continue
    pat="require('\\(node:\\)\\{0,1\\}$name')"

    if [ "$canon" != "-" ]; then
      # `const <canon> = require('<name>');`  -> the binding already exists.
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}%s[[:space:]]*=[[:space:]]*%s[[:space:]]*;[[:space:]]*\$##
" "$canon" "$pat"
      # `const <canon> = require('<name>').<canon>;`  (events' two spellings).
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}%s[[:space:]]*=[[:space:]]*%s\.%s[[:space:]]*;[[:space:]]*\$##
" "$canon" "$pat" "$canon"
      # A destructuring that names the canonical binding keeps that name bound
      # to the existing one; drop it from the brace list -- wherever it sits in
      # the list -- and let the rest come from the module object.
      printf "/%s/{ s#,[[:space:]]*%s[[:space:]]*,#,#; }
" "$pat" "$canon"
      printf "/%s/{ s#{[[:space:]]*%s[[:space:]]*,[[:space:]]*#{ #; }
" "$pat" "$canon"
      printf "/%s/{ s#,[[:space:]]*%s[[:space:]]*}# }#; }
" "$pat" "$canon"
      printf "/%s/{ s#{[[:space:]]*%s[[:space:]]*}#{}#; }
" "$pat" "$canon"
      # `const { } = require(...)` after that removal is a no-op line.
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}{}[[:space:]]*=[[:space:]]*%s[[:space:]]*;[[:space:]]*\$##
" "$pat"
      printf "s#^\(const\|let\|var\)[[:space:]]\{1,\}{[[:space:]]*}[[:space:]]*=[[:space:]]*%s[[:space:]]*;[[:space:]]*\$##
" "$pat"
    fi

    # A bare `require('<name>');` for its side effects only.
    printf "s#^%s[[:space:]]*;[[:space:]]*\$##
" "$pat"
    # Everything else -- `const x = require('m')`, `require('m').member`,
    # `const { a, b } = require('m')` -- becomes the module object in place.
    printf "s#%s#%s#g
" "$pat" "$obj"
  done
} > "$REWRITE"

# ---------------------------------------------------------------------------
# Emit the bundle.
# ---------------------------------------------------------------------------
{
  echo "// ==== zun-node bundle of $(basename "$SRC") ===="
  printf '%s\n' "$FILES" | while read -r file; do
    [ -n "${file:-}" ] || continue
    cat "$ROOT/$file"
  done
  echo "const __filename: string = $(json_string "$TEST_PATH");"
  echo "const __dirname: string = $(json_string "$TEST_DIR");"
  echo "// ==== test body ===="
  sed -f "$REWRITE" "$SRC"
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

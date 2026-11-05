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
# Anything else (`internal/event_target`, `node:test`, ...) is reported as an
# unresolved module and the bundle fails, so a missing harness module is never
# mistaken for an engine bug.
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
# util has no dependencies, events formats its messages with util.inspect,
# process is an EventEmitter over events, assert and path stand on process, and
# the harness stands on all of them.
# ---------------------------------------------------------------------------
MODULE_SPECS="
util __node_util -
events __node_events EventEmitter
process __node_process process
assert __node_assert assert
path __node_path path
child_process __node_child_process -
domain __node_domain -
stream __node_stream -
"

BUNDLE_FILES="
src/util/util.ts
src/events/events.ts
src/process/process.ts
src/assert/assert.ts
src/path/path.ts
tools/harness/common.ts
"

obj_of() { printf '%s\n' "$MODULE_SPECS" | awk -v m="$1" '$1 == m { print $2 }'; }
canon_of() { printf '%s\n' "$MODULE_SPECS" | awk -v m="$1" '$1 == m { print $3 }'; }

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
  printf '%s\n' "$BUNDLE_FILES" | while read -r file; do
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

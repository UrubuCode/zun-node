#!/usr/bin/env bash
# Turn one Node.js test file into a single Zun program.
#
# Node's tests are CommonJS: `require('assert')`, `require('path')`,
# `require('../common')`. The Zun engine has no `require` and no file-based module
# resolution (https://github.com/UrubuCode/zun/issues/4), so the bundler inlines
# this library's modules ahead of the test and rewrites the test's `require`
# calls to reference them.
#
# The inlined modules declare the same names the tests bind (`assert`, `path`,
# `common`, `fixtures`), so a whole-line `require` declaration is simply deleted
# and the test's later uses resolve to the inlined module.
#
# CommonJS also provides `__filename` and `__dirname`; they are injected as the
# test's own location (override the file name with ZUN_NODE_TEST_FILENAME, used
# when bundling a truncated copy of a test).
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

{
  echo "// ==== zun-node bundle of $(basename "$SRC") ===="
  cat "$ROOT/src/process/process.ts"
  cat "$ROOT/src/assert/assert.ts"
  cat "$ROOT/src/path/path.ts"
  cat "$ROOT/tools/harness/common.ts"
  echo "const __filename: string = $(json_string "$TEST_PATH");"
  echo "const __dirname: string = $(json_string "$TEST_DIR");"
  echo "// ==== test body ===="
  sed -E \
    -e "s/^'use strict';[[:space:]]*$//" \
    -e "s/^\"use strict\";[[:space:]]*$//" \
    -e "s/^(const|let|var)[[:space:]]+assert[[:space:]]*=[[:space:]]*require\('assert'\);[[:space:]]*$//" \
    -e "s/^(const|let|var)[[:space:]]+path[[:space:]]*=[[:space:]]*require\('path'\);[[:space:]]*$//" \
    -e "s/^(const|let|var)[[:space:]]+common[[:space:]]*=[[:space:]]*require\('\.\.\/common'\);[[:space:]]*$//" \
    -e "s/^(const|let|var)[[:space:]]+fixtures[[:space:]]*=[[:space:]]*require\('\.\.\/common\/fixtures'\);[[:space:]]*$//" \
    -e "s/^require\('\.\.\/common'\);[[:space:]]*$//" \
    -e "s/require\('child_process'\)/__nodeChildProcess/g" \
    -e "s/require\('path\/posix'\)/posix/g" \
    -e "s/require\('path\/win32'\)/win32/g" \
    -e "s/require\('path'\)/path/g" \
    -e "s/require\('assert'\)/assert/g" \
    "$SRC"
} > "$OUT"

# Any `require` left over means the test needs a module the harness does not
# provide; say so loudly rather than letting the engine report a mystery.
if grep -n "require(" "$OUT" | grep -v "^.*// " >/dev/null 2>&1; then
  echo "bundle_node_test.sh: unresolved require() in $(basename "$SRC"):" >&2
  grep -n "require(" "$OUT" >&2 || true
fi

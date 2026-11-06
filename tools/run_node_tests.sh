#!/usr/bin/env bash
# Download Node.js v25 tests for a module and validate them against Zun.
#
# The Node.js test suite is the compatibility oracle for zun-node (see
# ../PLAN.md). This runner never vendors the tests: it downloads each from the
# nodejs/node repository at a pinned tag, runs it through the built `zun`
# binary, tallies pass/fail, and renders a progress bar + percentage into the
# README and a results file.
#
# zun-node has two kinds of module, and this runner handles both:
#
#   * extension modules (`fs`) are a Rust `zun_abi` cdylib, because they need
#     syscalls. The downloaded test is run as `zun run --ext <lib> <test.js>`,
#     so `--ext` is required for them.
#   * Zun-TypeScript modules (`path`) are pure computation written in the
#     language the platform compiles (`src/path/path.ts`). The engine has no
#     CommonJS `require` (https://github.com/UrubuCode/zun/issues/4), so each
#     downloaded test is first passed through `tools/bundle_node_test.sh`, which
#     inlines the process/assert/path/common shims and rewrites the test's
#     `require` lines; the bundle then runs as `zun run <bundle.ts>`, with no
#     `--ext`.
#   * Zun-TypeScript-over-natives modules (`os`) are **both**: the Node-shaped
#     API is TypeScript (`src/os/os.ts`) but the facts under it are syscalls in
#     the cdylib, which the TypeScript reaches with
#     `import * as native from "node:os"`. Their tests are bundled like a
#     `zun-ts` module and then run as `zun run --ext <lib> <bundle.ts>`, so
#     `--ext` is required for them too. This is the kind `fs` will become once
#     its Node-API shaping is written in TypeScript over the existing natives.
#
# Tests are downloaded into `$WORK/test/parallel/<name>` because several of them
# assert their own location through `__dirname`.
#
# A test "passes" when the `zun run` invocation exits 0. For each failing test
# the results file records the first line of stderr, so a reader can see why
# without re-running anything.
#
# Usage:
#   tools/run_node_tests.sh --zun <path> [--ext <lib>] [--tag v25.0.0]
#       [--module fs|path|events] [--limit N] [--timeout 20]
set -u

ZUN=""; EXT=""; TAG="v25.0.0"; MODULE="fs"; LIMIT=0; TIMEOUT=20
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --zun) ZUN="$2"; shift 2;;
    --ext) EXT="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --module) MODULE="$2"; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done

# How this module is implemented, and the Node file-name prefix(es) that select
# its tests. A corpus is not always one prefix: `path`'s includes `test-path.js`
# itself, which does not match `test-path-`, and `events`' is split between
# `test-event-emitter-*` (the EventEmitter surface) and `test-events-*` (the
# module statics). PATTERNS is therefore a space-separated list, and PATTERN is
# the human-readable form used in the README block and the results header.
case "$MODULE" in
  path)   KIND="zun-ts";     PATTERNS="test-path";                        PATTERN="test-path";;
  util)   KIND="zun-ts";     PATTERNS="test-util";                        PATTERN="test-util";;
  events) KIND="zun-ts";     PATTERNS="test-event-emitter- test-events-"; PATTERN="test-event-emitter-*|test-events-";;
  os)     KIND="zun-ts+ext"; PATTERNS="test-os";                          PATTERN="test-os";;
  querystring) KIND="zun-ts"; PATTERNS="test-querystring";                PATTERN="test-querystring";;
  punycode)    KIND="zun-ts"; PATTERNS="test-punycode";                   PATTERN="test-punycode";;
  # `url`'s corpus is `test-url*`, which also selects `test-urlpattern*`:
  # `URLPattern` is a `node:url` export in Node 25, so those files are part of
  # this module's bar rather than a different one's.
  url)         KIND="zun-ts"; PATTERNS="test-url";                        PATTERN="test-url";;
  *)      KIND="extension";  PATTERNS="test-$MODULE-";                    PATTERN="test-$MODULE-";;
esac

[ -n "$ZUN" ] || { echo "usage: --zun <path> [--ext <lib>] [--module fs|path|events|os]" >&2; exit 2; }
case "$KIND" in
  extension)
    if [ -z "$EXT" ]; then
      echo "module '$MODULE' is a zun_abi extension: --ext <lib> is required" >&2
      exit 2
    fi;;
  zun-ts+ext)
    if [ -z "$EXT" ]; then
      echo "module '$MODULE' is Zun TypeScript over a native extension: --ext <lib> is required" >&2
      exit 2
    fi;;
esac

LIST="$ROOT/test/$MODULE/NODE_TESTS.txt"
RESULTS="$ROOT/test/$MODULE/RESULTS.md"
README="$ROOT/README.md"
BUNDLER="$ROOT/tools/bundle_node_test.sh"
RAW="https://raw.githubusercontent.com/nodejs/node/$TAG/test/parallel"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/test/parallel" "$WORK/bundles"
# The engine reports the native form of the path it was given, so the scratch
# directory is stripped from failure notes in both spellings.
WORK_NATIVE="$WORK"
if command -v cygpath >/dev/null 2>&1; then WORK_NATIVE="$(cygpath -m "$WORK")"; fi

# `timeout` guards a hung test where available (Linux CI, git-bash); otherwise
# run directly.
runner() { if command -v timeout >/dev/null 2>&1; then timeout "$TIMEOUT" "$@"; else "$@"; fi; }

# Reduce one stderr blob to a single short, table-safe markdown cell: the scratch
# directory and the compiler's diagnostic wrapper carry no information, so they
# are dropped before truncating.
note_of() {
  printf '%s\n' "$1" \
    | tr -d '\r' \
    | grep -m1 . \
    | sed -e "s|$WORK_NATIVE/||g" -e "s|$WORK/||g" \
          -e 's/OxcDiagnostic *{ *inner: *OxcDiagnosticInner *{ *message: /parse error: /' \
          -e 's/|/\\|/g' -e 's/`/'"'"'/g' \
    | cut -c1-110
}

NAMES=()
while IFS= read -r line; do
  line="$(printf '%s' "$line" | tr -d '[:space:]')"
  [ -n "$line" ] || continue
  for prefix in $PATTERNS; do
    case "$line" in *"$prefix"*) NAMES+=("$line"); break;; esac
  done
done < "$LIST"
if [ "$LIMIT" -gt 0 ] && [ "${#NAMES[@]}" -gt "$LIMIT" ]; then
  NAMES=("${NAMES[@]:0:$LIMIT}")
fi
TOTAL=${#NAMES[@]}
[ "$TOTAL" -gt 0 ] || { echo "no tests matching $PATTERN in $LIST" >&2; exit 2; }

PASS=0
ROWS=""
i=0
for name in "${NAMES[@]}"; do
  i=$((i + 1))
  src="$WORK/test/parallel/$name"
  if ! curl -fsSL --max-time "$TIMEOUT" "$RAW/$name" -o "$src" 2>/dev/null; then
    ROWS+="| \`$name\` | ⚠️ download failed | $RAW/$name |"$'\n'
    echo "[$i/$TOTAL] $name: download failed" >&2
    continue
  fi

  case "$KIND" in
    zun-ts|zun-ts+ext)
      bundle="$WORK/bundles/${name%.*}.ts"
      if ! bundle_err="$(bash "$BUNDLER" "$src" "$bundle" 2>&1 >/dev/null)"; then
        ROWS+="| \`$name\` | ❌ bundle failed | $(note_of "$bundle_err") |"$'\n'
        echo "[$i/$TOTAL] $name: bundle failed" >&2
        continue
      fi
      # A `zun-ts+ext` module is TypeScript whose own facts are syscalls in the
      # extension, so its bundle needs the bundler *and* --ext.
      if [ "$KIND" = "zun-ts+ext" ]; then
        err="$(runner "$ZUN" run --ext "$EXT" "$bundle" 2>&1 >/dev/null)"; code=$?
      else
        err="$(runner "$ZUN" run "$bundle" 2>&1 >/dev/null)"; code=$?
      fi;;
    *)
      err="$(runner "$ZUN" run --ext "$EXT" "$src" 2>&1 >/dev/null)"; code=$?;;
  esac

  if [ "$code" -eq 0 ]; then
    PASS=$((PASS + 1)); short="pass"
    ROWS+="| \`$name\` | ✅ pass | |"$'\n'
  else
    low="$(printf '%s' "$err" | tr '[:upper:]' '[:lower:]')"
    case "$low" in
      *panic*) short="engine panic";;
      *assertionerror*|*"assertion failed"*) short="assertion";;
      *syn*|*expected*) short="parse";;
      *require*|*import*|*"not found"*|*external*) short="unsupported import/require";;
      *sem*) short="type error";;
      *) short="runtime";;
    esac
    [ "$code" -eq 124 ] && short="timeout"
    ROWS+="| \`$name\` | ❌ $short | $(note_of "$err") |"$'\n'
  fi
  echo "[$i/$TOTAL] $name: $short" >&2
done

# Percentage to one decimal and a 24-cell bar, with integer arithmetic.
PCT10=$((PASS * 1000 / TOTAL)); WHOLE=$((PCT10 / 10)); FRAC=$((PCT10 % 10))
FILLED=$((PASS * 24 / TOTAL)); EMPTY=$((24 - FILLED))
bar=""; c=0
while [ "$c" -lt "$FILLED" ]; do bar+="█"; c=$((c + 1)); done
c=0
while [ "$c" -lt "$EMPTY" ]; do bar+="░"; c=$((c + 1)); done

read -r -d '' BLOCK <<EOF
<!-- node-$MODULE:start -->
### Node.js v25 \`$MODULE\` compatibility

\`$bar\` **$WHOLE.$FRAC%** — $PASS / $TOTAL Node \`$PATTERN*\` tests passing
<!-- node-$MODULE:end -->
EOF

case "$KIND" in
  zun-ts)     HOW="\`tools/bundle_node_test.sh\` + \`zun run <bundle.ts>\`";;
  zun-ts+ext) HOW="\`tools/bundle_node_test.sh\` + \`zun run --ext <lib> <bundle.ts>\`";;
  *)          HOW="\`zun run --ext <lib> <test.js>\`";;
esac

mkdir -p "$(dirname "$RESULTS")"
{
  echo "# Node.js v25 \`$MODULE\` test results"
  echo
  echo "Oracle: \`nodejs/node@$TAG\` \`test/parallel/$PATTERN*.js\`. Generated by"
  echo "\`tools/run_node_tests.sh --module $MODULE\`, which runs each test through $HOW."
  echo
  echo "$BLOCK"
  echo
  echo "The \"Why\" column is the first line of the failing run's stderr, truncated."
  echo
  echo "| Test | Result | Why |"
  echo "|---|---|---|"
  printf '%s' "$ROWS"
} > "$RESULTS"

# Splice the block into the README between its markers (create the file with a
# title + markers on first run).
if [ ! -f "$README" ] || ! grep -q "<!-- node-$MODULE:start -->" "$README"; then
  {
    [ -f "$README" ] && cat "$README" && echo
    [ -f "$README" ] || { echo "# zun-node"; echo; echo "Node.js-compatible library for the Zun platform."; echo; }
    echo "$BLOCK"
  } > "$README.tmp"
  mv "$README.tmp" "$README"
else
  printf '%s\n' "$BLOCK" > "$WORK/block.md"
  awk -v f="$WORK/block.md" '
    $0 ~ /<!-- node-'"$MODULE"':start -->/ { while ((getline line < f) > 0) print line; close(f); skip = 1; next }
    $0 ~ /<!-- node-'"$MODULE"':end -->/ { skip = 0; next }
    !skip { print }
  ' "$README" > "$README.tmp" && mv "$README.tmp" "$README"
fi

echo
echo "$MODULE: $PASS/$TOTAL passing ($WHOLE.$FRAC%)"

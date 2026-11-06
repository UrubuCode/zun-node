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
#       [--module fs|path|events|buffer|string_decoder|stream|readline] [--limit N] [--timeout 20]
set -u

ZUN=""; EXT=""; TAG="v25.0.0"; MODULE="fs"; LIMIT=0; TIMEOUT=20
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JOBS="${JOBS:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --zun) ZUN="$2"; shift 2;;
    --ext) EXT="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --module) MODULE="$2"; shift 2;;
    --limit) LIMIT="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --jobs) JOBS="$2"; shift 2;;
    *) echo "unknown argument: $1" >&2; exit 2;;
  esac
done
if [ -z "$JOBS" ]; then
  cores="$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  JOBS=$(( cores / 2 )); [ "$JOBS" -ge 1 ] || JOBS=1
fi

# How this module is implemented, and the Node file-name prefix(es) that select
# its tests. A corpus is not always one prefix: `path`'s includes `test-path.js`
# itself, which does not match `test-path-`, and `events`' is split between
# `test-event-emitter-*` (the EventEmitter surface) and `test-events-*` (the
# module statics). PATTERNS is therefore a space-separated list, and PATTERN is
# the human-readable form used in the README block and the results header.
case "$MODULE" in
  path)   KIND="zun-ts";     PATTERNS="test-path";                        PATTERN="test-path";;
  util)   KIND="zun-ts";     PATTERNS="test-util";                        PATTERN="test-util";;
  assert) KIND="zun-ts";     PATTERNS="test-assert";                      PATTERN="test-assert";;
  events) KIND="zun-ts";     PATTERNS="test-event-emitter- test-events-"; PATTERN="test-event-emitter-*|test-events-";;
  os)     KIND="zun-ts+ext"; PATTERNS="test-os";                          PATTERN="test-os";;
  buffer) KIND="zun-ts";     PATTERNS="test-buffer";                      PATTERN="test-buffer";;
  string_decoder)
          KIND="zun-ts";     PATTERNS="test-string-decoder";              PATTERN="test-string-decoder";;
  querystring) KIND="zun-ts"; PATTERNS="test-querystring";                PATTERN="test-querystring";;
  punycode)    KIND="zun-ts"; PATTERNS="test-punycode";                   PATTERN="test-punycode";;
  # `url`'s corpus is `test-url*`, which also selects `test-urlpattern*`:
  # `URLPattern` is a `node:url` export in Node 25, so those files are part of
  # this module's bar rather than a different one's.
  url)         KIND="zun-ts"; PATTERNS="test-url";                        PATTERN="test-url";;
  # `stream`'s corpus is five prefixes, and naming each one is the point:
  # `test-stream-` is the bulk, `test-stream2-` and `test-stream3-` are the two
  # historical rewrites Node still ships under their old names, `test-streams-`
  # is the one file about the module surface itself, and `test-readable-` covers
  # `Readable.from` and the async iterator -- that last one shares no prefix
  # with the others at all.
  stream)      KIND="zun-ts"; PATTERNS="test-stream- test-stream2- test-stream3- test-streams- test-readable-";
               PATTERN="test-stream-*|test-stream2-*|test-stream3-*|test-streams-*|test-readable-";;
  fs)     KIND="zun-ts+ext"; PATTERNS="test-fs-";                         PATTERN="test-fs-";;
  # `timers`' corpus is `test-timers*`, which includes `test-timers.js` itself.
  # The module is pure Zun TypeScript: the VM already owns the event loop, so
  # there is nothing for a native extension to do (see src/timers/timers.ts).
  timers) KIND="zun-ts";     PATTERNS="test-timers";                      PATTERN="test-timers";;
  # `child_process` is TS over natives: `std::process::Command` in
  # src/child_process/*.rs, Node's shape in src/child_process/child_process.ts.
  child_process)
          KIND="zun-ts+ext"; PATTERNS="test-child-process";               PATTERN="test-child-process";;
  # `diagnostics_channel` and `console` are both pure Zun TypeScript: a channel
  # is a map and a list, and a console is formatting plus a `write` call, so
  # neither has a syscall of its own to put behind the ABI.
  diagnostics_channel)
          KIND="zun-ts";     PATTERNS="test-diagnostics-channel";         PATTERN="test-diagnostics-channel";;
  console) KIND="zun-ts";    PATTERNS="test-console";                     PATTERN="test-console";;
  # `readline`'s corpus is `test-readline*`, which also selects the
  # `test-readline-promises-*` files: `readline/promises` is the same module's
  # second surface (src/readline/promises.ts), so those files are part of this
  # module's bar rather than a different one's.
  #
  # The module itself is pure Zun TypeScript -- the line editor is string
  # arithmetic over `stream`, `events` and `string_decoder`, and the one thing a
  # terminal would add, `setRawMode`, belongs to the input stream rather than to
  # readline. The kind is nevertheless `zun-ts+ext`, because three files in the
  # corpus read their input from a *file*
  # (`test-readline-async-iterators{,-destroy}.js` and
  # `test-readline-input-onerror.js` all build a `fs.createReadStream`), and
  # `fs` is syscalls. Nothing in src/readline imports a native.
  readline)
          KIND="zun-ts+ext"; PATTERNS="test-readline";                    PATTERN="test-readline";;
  # `process` is TS over natives too, and the one module every other bundle
  # stands on: src/process/process.ts is inlined everywhere, its natives live in
  # src/process/*.rs, and src/process/native.ts -- the only file that imports
  # them -- is inlined by the bundler just for the bundles that get `--ext`.
  process) KIND="zun-ts+ext"; PATTERNS="test-process-";                   PATTERN="test-process-";;
  # `perf_hooks`' corpus is two prefixes that share no stem: `test-perf-hooks-`
  # (the module surface) and `test-performance*` (the timeline, which also
  # covers `test-performanceobserver*`). The module is pure Zun TypeScript: its
  # one capability is a clock, and `src/process/process.ts` already answers it
  # in both of its forms. Running the bundle with `--ext` sharpens
  # `performance.now()` from whole milliseconds to the platform monotonic
  # clock, but no test in the corpus distinguishes the two, so the kind is
  # `zun-ts` -- see the resolution table in src/perf_hooks/perf_hooks.ts.
  perf_hooks)
          KIND="zun-ts";     PATTERNS="test-perf-hooks- test-performance";
          PATTERN="test-perf-hooks-*|test-performance";;
  # `zlib` is TS over natives: the nine `Transform` classes and the whole
  # convenience surface are src/zlib/zlib.ts, and the compression engines
  # (zlib-rs and the Rust Brotli port) are src/zlib/*.rs. Its corpus is
  # `test-zlib*`, which includes `test-zlib.js` itself.
  zlib)   KIND="zun-ts+ext"; PATTERNS="test-zlib";                         PATTERN="test-zlib";;
  # `v8` is pure Zun TypeScript: V8's value-serialization wire format is byte
  # arithmetic over the engine's `Buffer` and a `DataView`, and every reading
  # `node:v8` gives about a heap belongs to a V8 isolate that does not exist
  # here -- so there is no syscall for a native to make. See the resolution
  # table in src/v8/v8.ts.
  v8)     KIND="zun-ts";     PATTERNS="test-v8-";                          PATTERN="test-v8-";;
  # `tty`'s corpus is two prefixes: `test-tty-` (the module) and `test-ttywrap`
  # (the libuv handle under it, which Node's tests reach through
  # `internalBinding('tty_wrap')`). The module is pure Zun TypeScript -- the
  # colour-depth table is `process.env` arithmetic and the two terminal streams
  # are `Duplex`es -- over the one predicate src/process/process.ts already
  # answers, `isatty(fd)`.
  tty)    KIND="zun-ts";     PATTERNS="test-tty- test-ttywrap";
          PATTERN="test-tty-*|test-ttywrap";;
  *)      KIND="extension";  PATTERNS="test-$MODULE-";                    PATTERN="test-$MODULE-";;
esac

[ -n "$ZUN" ] || { echo "usage: --zun <path> [--ext <lib>] [--module fs|path|events|os|buffer|string_decoder]" >&2; exit 2; }
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

# The bundler inlines `src/process/native.ts` -- the one file that imports the
# `node:process` extension -- only for a bundle that will actually be run with
# one. Every bundle inlines `src/process/process.ts`, and the `zun-ts` kinds run
# without `--ext`, so the gate cannot live in the module table; see
# EXT_FILES in tools/bundle_node_test.sh.
# Only for a kind that actually runs with `--ext`: a `zun-ts` module given an
# `--ext` (convenient when looping over every module) must still bundle and run
# without the extension.
if [ -n "$EXT" ] && [ "$KIND" != "zun-ts" ]; then
  export ZUN_NODE_EXT="$EXT"
fi

LIST="$ROOT/test/$MODULE/NODE_TESTS.txt"
# Some corpora open files from Node's `test/fixtures/` rather than only
# computing over their paths (`fs` does; `path` does not). Those files are no
# more vendored than the tests are: the module lists the ones it needs in
# `test/<module>/NODE_FIXTURES.txt`, as repository-relative paths, and they are
# downloaded next to the test file so that the harness's
# `path.join(__dirname, "..", "fixtures")` -- which is exactly what Node's own
# test/common/fixtures.js computes -- finds them.
FIXTURES="$ROOT/test/$MODULE/NODE_FIXTURES.txt"
RESULTS="$ROOT/test/$MODULE/RESULTS.md"
README="$ROOT/README.md"
BUNDLER="$ROOT/tools/bundle_node_test.sh"
RAW="https://raw.githubusercontent.com/nodejs/node/$TAG/test/parallel"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/test/parallel" "$WORK/bundles" "$WORK/test/fixtures"

if [ -f "$FIXTURES" ]; then
  while IFS= read -r fixture; do
    fixture="$(printf '%s' "$fixture" | tr -d '[:space:]')"
    [ -n "$fixture" ] || continue
    case "$fixture" in \#*) continue;; esac
    mkdir -p "$(dirname "$WORK/$fixture")"
    if ! curl -fsSL --max-time "$TIMEOUT" \
      "https://raw.githubusercontent.com/nodejs/node/$TAG/$fixture" -o "$WORK/$fixture"; then
      echo "warning: could not download fixture $fixture" >&2
    fi
  done < "$FIXTURES"
fi
# The engine reports the native form of the path it was given, so the scratch
# directory is stripped from failure notes in both spellings.
WORK_NATIVE="$WORK"
if command -v cygpath >/dev/null 2>&1; then WORK_NATIVE="$(cygpath -m "$WORK")"; fi

# `timeout` guards a hung test where available (Linux CI, git-bash); otherwise
# run directly.
runner() { if command -v timeout >/dev/null 2>&1; then timeout "$TIMEOUT" "$@"; else "$@"; fi; }

# Reduce one stderr blob to a single short, table-safe markdown cell: the scratch
# directory and the compiler's diagnostic wrapper carry no information, so they
# are dropped before truncating. The machine's host and user names are redacted,
# because tests such as test-os.js print them and RESULTS.md is published.
HOST_NAME="$(hostname 2>/dev/null || true)"
USER_NAME="${USER:-${USERNAME:-}}"
note_of() {
  printf '%s\n' "$1" \
    | tr -d '\r' \
    | grep -m1 . \
    | sed -e "s|$WORK_NATIVE/||g" -e "s|$WORK/||g" -e "s|$ROOT/||g" \
          -e 's/0x[0-9a-fA-F]\{6,\}/0x…/g' \
          ${HOST_NAME:+-e "s|$HOST_NAME|<hostname>|g"} \
          ${USER_NAME:+-e "s|$USER_NAME|<user>|g"} \
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

# Each test runs in its own job and writes one result file; the rows are joined
# in corpus order afterwards, so RESULTS.md is identical to a serial run. JOBS
# defaults to half the cores (each run is single-threaded, and the timeout must
# not fire just because the machine is oversubscribed); --jobs 1 is serial.
mkdir -p "$WORK/rows"
run_one() {
  local i="$1" name="$2" src bundle bundle_err err code low short
  src="$WORK/test/parallel/$name"
  if ! curl -fsSL --max-time "$TIMEOUT" "$RAW/$name" -o "$src" 2>/dev/null; then
    printf 'fail\t| `%s` | ⚠️ download failed | %s |\n' "$name" "$RAW/$name" > "$WORK/rows/$i"
    echo "[$i/$TOTAL] $name: download failed" >&2
    return
  fi

  case "$KIND" in
    zun-ts|zun-ts+ext)
      bundle="$WORK/bundles/${name%.*}.ts"
      if ! bundle_err="$(bash "$BUNDLER" "$src" "$bundle" 2>&1 >/dev/null)"; then
        printf 'fail\t| `%s` | ❌ bundle failed | %s |\n' "$name" "$(note_of "$bundle_err")" > "$WORK/rows/$i"
        echo "[$i/$TOTAL] $name: bundle failed" >&2
        return
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
    short="pass"
    printf 'pass\t| `%s` | ✅ pass | |\n' "$name" > "$WORK/rows/$i"
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
    printf 'fail\t| `%s` | ❌ %s | %s |\n' "$name" "$short" "$(note_of "$err")" > "$WORK/rows/$i"
  fi
  echo "[$i/$TOTAL] $name: $short" >&2
}

i=0
for name in "${NAMES[@]}"; do
  i=$((i + 1))
  while [ "$(jobs -rp | wc -l)" -ge "$JOBS" ]; do wait -n 2>/dev/null || true; done
  run_one "$i" "$name" &
done
wait

PASS=0
ROWS=""
i=0
while [ "$i" -lt "$TOTAL" ]; do
  i=$((i + 1))
  [ -f "$WORK/rows/$i" ] || continue
  IFS=$'\t' read -r status row < "$WORK/rows/$i"
  [ "$status" = "pass" ] && PASS=$((PASS + 1))
  ROWS+="$row"$'\n'
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

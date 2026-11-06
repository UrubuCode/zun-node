// node:assert — the whole Node.js 25 module: the loose and strict assertion
// surfaces, the `Assert` class, `assert/strict`, and `AssertionError` with
// Node's own generated messages and Myers diff output.
//
// This module matters twice over. It is a Node module like any other, and it is
// also zun-node's own harness: Node's test suite is this library's
// compatibility oracle (see ../../PLAN.md), and every
// `test/parallel/test-*.js` starts with `const assert = require('assert')`.
// Implementing it is therefore part of implementing every other module, per
// PLAN.md principle 4 — which is also why a change here is measured against
// *all* the baseline modules, not just `test-assert*.js`.
//
// Behavior follows Node's own sources (MIT, Copyright Joyent, Inc. and other
// Node contributors), because the messages are observable through the corpus
// rather than derivable from any general rule:
//
//   * `lib/assert.js`                          — the method surface, the
//     `expectedException` / `expectsNoError` validation rules and their
//     messages, and the `Assert` class with its
//     `{ diff, strict, skipPrototype }` options.
//   * `lib/internal/assert/assertion_error.js` — `AssertionError`, the
//     `kReadableOperator` headers and `createErrDiff`.
//   * `lib/internal/assert/myers_diff.js`      — the line diff, its `...`
//     collapsing and the `+ actual` / `- expected` rendering.
//   * `lib/internal/assert/utils.js`           — `innerOk`, including the
//     "No value argument passed to `assert.ok()`" message.
//   * `lib/internal/util/comparisons.js`       — the *loose* deep-equality mode
//     behind `assert.deepEqual`, and the *partial* mode behind
//     `assert.partialDeepStrictEqual`.
//
// Two members are **not** here because Node 25 does not have them:
// `assert.CallTracker` was removed (there is no
// `lib/internal/assert/calltracker.js` at v25.0.0), and `assert.fail`'s legacy
// four-argument form — with its DEP0094 warning — went with it;
// `Assert.prototype.fail` takes a single `message`. Node 25 *added*
// `assert.Assert`, which is implemented below.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to a zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `__asUnboxFn` / `__asObjectIs` — a function that crosses the `Any` lane
//     arrives as a `functionBox` record rather than the callable (zun#17,
//     zun#50). Unwrapping both sides restores JavaScript's `===` for functions;
//     without it every `deepStrictEqual(ee.listeners('x'), [listener])` in
//     Node's events corpus would fail for a reason that has nothing to do with
//     the module under test.
//   * `__asRegexTest` — a RegExp loses its methods through `any` (zun#7), so a
//     pattern received as an argument cannot answer `.test` directly; a
//     statically typed one is rebuilt from its stringification.
//   * `__asMatchesErrorConstructor` — `instanceof` only accepts a literal class
//     name as its right operand, so `error instanceof expectedValue` cannot be
//     written at all (a new engine gap, reported with this work, and the reason
//     Node's own `err instanceof assert.AssertionError` does not even compile).
//     The eight standard error constructors are matched by identity with the
//     `instanceof` spelled statically; any other constructor is matched by
//     `error.constructor === expected`, which is exact-class only because a
//     class prototype chain carries no `constructor` (zun#51).
//   * `__asIsConstructor` — a *class* value has a `prototype` and a `name`, a
//     plain function has neither, which is exactly Node's own
//     `expected.prototype !== undefined` guard. It matters more here than in
//     Node: **calling** a class value aborts the program with "call did not
//     resolve to a method", and the abort is not catchable, so a constructor
//     must never reach the predicate path.
//   * `__asHasKey` — `key in instance` is a compile error on a typed receiver
//     and answers `false` for `message`/`name` on an `Error` subclass, because
//     those live on the base rather than as own properties. Node's
//     `compareExceptionKey` asks `key in actual` first; the helper widens that
//     to "own property, reachable through `in`, or one of the three members
//     every error has".
//   * `__asColors` — `lib/internal/util/colors.js` with every escape empty and
//     `hasColors` false. `process.stderr` does not exist here, so Node's own
//     non-TTY branch is the only reachable one; the record is kept rather than
//     inlined so the diff code reads like Node's.
//   * `myersDiff` uses plain number arrays rather than `Int32Array`: a typed
//     array is opaque through `any` (zun#38), which is what the diff's `v` rows
//     become as soon as they are stored in `trace`.
//   * `Number(x.length)` throughout: the checker still types `.length` as
//     `u64`, so it can be neither assigned to nor passed as a `number`
//     (zun#3).
//   * Every function collects its call values through a **rest parameter**.
//     The parser looks for the name of the implicit call-value object textually
//     anywhere inside a function's source span — comments included — and
//     injects a synthetic trailing rest parameter into the *enclosing* function
//     where it finds one, which then dies with "spread: value is not iterable"
//     on a dynamic call (zun#40). That name is never spelled in this file.
//   * `x ? true : false` rather than `!x` wherever `x` may be an `any`-typed
//     empty string (zun#13).
//   * `err.stack` cannot be assigned (a new engine gap, reported with this
//     work), so `ifError` cannot splice the original error's frames onto the
//     `AssertionError` the way Node does.
//   * the `Assert` **class** methods take three optional parameters where the
//     module-level ones take a rest parameter: passing a **function** value to
//     a class method that declares a rest parameter aborts the program with
//     "call did not resolve to a method" (a new engine gap, reported with this
//     work — `k.m(1)` is fine, `k.m(() => 1)` is not), and every one of these
//     methods takes a callback or a predicate. A rest parameter on a plain
//     function, on an object-literal method and on a function's expando
//     property all accept one, which is why only the class is written this
//     way.

// ---------------------------------------------------------------------------
// Colors (lib/internal/util/colors.js)
// ---------------------------------------------------------------------------
//
// Node resets these on every `AssertionError` from `process.stderr`'s TTY
// state. There is no `process.stderr` here, so `refresh()` would always take
// the "no colors" branch; the record is frozen in that state.
const __asColors: any = {
  blue: "",
  green: "",
  white: "",
  red: "",
  gray: "",
  hasColors: false,
};

// ---------------------------------------------------------------------------
// Myers diff (lib/internal/assert/myers_diff.js)
// ---------------------------------------------------------------------------

const __AS_NOP_LINES_TO_COLLAPSE: number = 5;
const __AS_DELETE: number = -1;
const __AS_NOP: number = 0;
const __AS_INSERT: number = 1;

function __asLinesEqual(actual: any, expected: any, checkCommaDisparity: boolean): boolean {
  if (actual === expected) return true;
  if (checkCommaDisparity) {
    return String(actual) + "," === String(expected) ||
      String(actual) === String(expected) + ",";
  }
  return false;
}

// `v[i]` with `Int32Array`'s out-of-range answer. Node reads `v[offset - 1]`
// and `v[offset + 1]` unconditionally and relies on a typed array handing back
// `undefined` at the two edges, where the ternary that follows never uses the
// value; a plain array index of -1 is "malformed bytecode: negative array
// index" here, so the read goes through this helper.
function __asVAt(v: any, index: number): number {
  if (index < 0) return 0;
  if (index >= Number(v.length)) return 0;
  return v[index];
}

function __asEndsWithComma(line: any): boolean {
  const text = String(line);
  const n = Number(text.length);
  if (n === 0) return false;
  return text.charAt(n - 1) === ",";
}

// `myersDiff(actual, expected, checkCommaDisparity?)` -> an array of
// `[operation, value]` pairs, in reverse order (the printers walk it
// backwards), where `operation` is -1 delete, 0 keep, 1 insert.
//
// `2 ** 31 - 1` is the documented input-size cap and the only part of this
// function Node's own `test-assert-myers-diff.js` exercises, so the
// `ERR_OUT_OF_RANGE` is raised with `node:events`' coded-error base rather than
// an ad-hoc `RangeError`.
function myersDiff(actual: any, expected: any, checkCommaDisparity?: any): any {
  const checkComma: boolean = checkCommaDisparity ? true : false;
  const actualLength = Number(actual.length);
  const expectedLength = Number(expected.length);
  const max = actualLength + expectedLength;

  if (max > 2147483647) {
    throw new ERR_OUT_OF_RANGE("myersDiff input size", "< 2^31", max);
  }

  // Plain arrays, not `Int32Array`: a typed array is opaque through `any`
  // (zun#38), and the `trace` rows are read back through one.
  const v: number[] = [];
  const width = 2 * max + 1;
  for (let i = 0; i < width; i++) v.push(0);
  const trace: any[] = [];

  for (let diffLevel = 0; diffLevel <= max; diffLevel++) {
    trace.push(v.slice(0));

    for (let diagonalIndex = -diffLevel; diagonalIndex <= diffLevel; diagonalIndex += 2) {
      const offset = diagonalIndex + max;
      const previousOffset = __asVAt(v, offset - 1);
      const nextOffset = __asVAt(v, offset + 1);
      let x = diagonalIndex === -diffLevel ||
        (diagonalIndex !== diffLevel && previousOffset < nextOffset)
        ? nextOffset
        : previousOffset + 1;
      let y = x - diagonalIndex;

      while (
        x < actualLength &&
        y < expectedLength &&
        __asLinesEqual(actual[x], expected[y], checkComma)
      ) {
        x = x + 1;
        y = y + 1;
      }

      v[offset] = x;

      if (x >= actualLength && y >= expectedLength) {
        return __asBacktrack(trace, actual, expected, checkComma);
      }
    }
  }
  return undefined;
}

function __asBacktrack(trace: any[], actual: any, expected: any, checkComma: boolean): any[] {
  const actualLength = Number(actual.length);
  const expectedLength = Number(expected.length);
  const max = actualLength + expectedLength;

  let x = actualLength;
  let y = expectedLength;
  const result: any[] = [];

  for (let diffLevel = Number(trace.length) - 1; diffLevel >= 0; diffLevel--) {
    const v: any = trace[diffLevel];
    const diagonalIndex = x - y;
    const offset = diagonalIndex + max;

    let prevDiagonalIndex = 0;
    if (
      diagonalIndex === -diffLevel ||
      (diagonalIndex !== diffLevel &&
        __asVAt(v, offset - 1) < __asVAt(v, offset + 1))
    ) {
      prevDiagonalIndex = diagonalIndex + 1;
    } else {
      prevDiagonalIndex = diagonalIndex - 1;
    }

    const prevX = __asVAt(v, prevDiagonalIndex + max);
    const prevY = prevX - prevDiagonalIndex;

    while (x > prevX && y > prevY) {
      const actualItem: any = actual[x - 1];
      const value: any = checkComma && !__asEndsWithComma(actualItem)
        ? expected[y - 1]
        : actualItem;
      result.push([__AS_NOP, value]);
      x = x - 1;
      y = y - 1;
    }

    if (diffLevel > 0) {
      if (x > prevX) {
        x = x - 1;
        result.push([__AS_INSERT, actual[x]]);
      } else {
        y = y - 1;
        result.push([__AS_DELETE, expected[y]]);
      }
    }
  }

  return result;
}

// The character-level renderer, used only for a colored string comparison.
// `colors.hasColors` is false here, so no assertion message reaches it; it
// exists because `internal/assert/myers_diff` exports it.
function printSimpleMyersDiff(diff: any): string {
  let message = "";
  for (let diffIdx = Number(diff.length) - 1; diffIdx >= 0; diffIdx--) {
    const pair: any = diff[diffIdx];
    const operation = pair[0];
    const value = pair[1];
    let color = __asColors.white;
    if (operation === __AS_INSERT) {
      color = __asColors.green;
    } else if (operation === __AS_DELETE) {
      color = __asColors.red;
    }
    message = message + color + String(value) + __asColors.white;
  }
  return "\n" + message;
}

// The line renderer: `+ ` for a line only `actual` has, `- ` for a line only
// `expected` has, two spaces for a shared one, and `...` once more than
// `kNopLinesToCollapse` shared lines run together.
function printMyersDiff(diff: any, operator: any): any {
  let message = "";
  let skipped = false;
  let nopCount = 0;
  const n = Number(diff.length);

  for (let diffIdx = n - 1; diffIdx >= 0; diffIdx--) {
    const pair: any = diff[diffIdx];
    const operation = pair[0];
    const value = pair[1];
    const previousOperation: any = diffIdx < n - 1 ? diff[diffIdx + 1][0] : null;

    // Avoid grouping if only one line would have been grouped otherwise.
    if (previousOperation === __AS_NOP && operation !== previousOperation) {
      if (nopCount === __AS_NOP_LINES_TO_COLLAPSE + 1) {
        message = message + __asColors.white + "  " + String(diff[diffIdx + 1][1]) + "\n";
      } else if (nopCount === __AS_NOP_LINES_TO_COLLAPSE + 2) {
        message = message + __asColors.white + "  " + String(diff[diffIdx + 2][1]) + "\n";
        message = message + __asColors.white + "  " + String(diff[diffIdx + 1][1]) + "\n";
      } else if (nopCount >= __AS_NOP_LINES_TO_COLLAPSE + 3) {
        message = message + __asColors.blue + "..." + __asColors.white + "\n";
        message = message + __asColors.white + "  " + String(diff[diffIdx + 1][1]) + "\n";
        skipped = true;
      }
      nopCount = 0;
    }

    if (operation === __AS_INSERT) {
      if (operator === "partialDeepStrictEqual") {
        message = message + __asColors.gray +
          (__asColors.hasColors ? " " : "+") + " " + String(value) + __asColors.white + "\n";
      } else {
        message = message + __asColors.green + "+" + __asColors.white + " " + String(value) + "\n";
      }
    } else if (operation === __AS_DELETE) {
      message = message + __asColors.red + "-" + __asColors.white + " " + String(value) + "\n";
    } else if (operation === __AS_NOP) {
      if (nopCount < __AS_NOP_LINES_TO_COLLAPSE) {
        message = message + __asColors.white + "  " + String(value) + "\n";
      }
      nopCount = nopCount + 1;
    }
  }

  message = message.trimEnd();
  return { message: "\n" + message, skipped: skipped };
}

// `internal/assert/myers_diff`, which Node's own `test-assert-myers-diff.js`
// requires under `--expose-internals`. It is this module's implementation
// surface, exactly as `internal/util` is `util`'s.
const __node_internal_assert_myers_diff: any = {
  myersDiff: myersDiff,
  printMyersDiff: printMyersDiff,
  printSimpleMyersDiff: printSimpleMyersDiff,
};

// ---------------------------------------------------------------------------
// AssertionError (lib/internal/assert/assertion_error.js)
// ---------------------------------------------------------------------------

// The header line each operator prints above its diff.
const __AS_READABLE_OPERATOR: any = {
  deepStrictEqual: "Expected values to be strictly deep-equal:",
  partialDeepStrictEqual: "Expected values to be partially and strictly deep-equal:",
  strictEqual: "Expected values to be strictly equal:",
  strictEqualObject: 'Expected "actual" to be reference-equal to "expected":',
  deepEqual: "Expected values to be loosely deep-equal:",
  notDeepStrictEqual: 'Expected "actual" not to be strictly deep-equal to:',
  notStrictEqual: 'Expected "actual" to be strictly unequal to:',
  notStrictEqualObject: 'Expected "actual" not to be reference-equal to "expected":',
  notDeepEqual: 'Expected "actual" not to be loosely deep-equal to:',
  notIdentical: "Values have same structure but are not reference-equal:",
  notDeepEqualUnequal: "Expected values not to be loosely deep-equal:",
};

const __AS_MAX_SHORT_STRING_LENGTH: number = 12;
const __AS_MAX_LONG_STRING_LENGTH: number = 512;

// The three operators that build a diff even when the caller supplied a
// message, so a custom message keeps the comparison under it.
function __asHasCustomMessageDiff(operator: any): boolean {
  return operator === "deepStrictEqual" || operator === "strictEqual" ||
    operator === "partialDeepStrictEqual";
}

// Assertion values are formatted with `util.inspect`, the way Node's own
// `assert` formats them (`inspectValue` in `internal/assert/assertion_error`).
// `util` is bundled ahead of this module (see tools/bundle_node_test.sh), so
// `inspect` is the real one.
function __asInspectValue(value: any): string {
  return inspect(value, {
    compact: false,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Infinity,
    // Assert compares only enumerable properties (with a few exceptions).
    showHidden: false,
    // Assert does not detect proxies currently.
    showProxy: false,
    sorted: true,
    // Inspect getters as we also check them when comparing entries.
    getters: true,
  });
}

// `util.inspect` with this module's other default options, used for the pieces
// of a message that are not the diff itself (`lib/assert.js` calls plain
// `inspect` there).
function __asInspect(value: any): string {
  return inspect(value, {
    compact: 3,
    customInspect: false,
    depth: 1000,
    maxArrayLength: Infinity,
    showHidden: false,
    breakLength: Infinity,
    showProxy: false,
    sorted: true,
    getters: true,
    numericSeparator: false,
  });
}

function __asGetErrorMessage(operator: any, message: any): string {
  if (message !== undefined && message !== null && String(message) !== "") {
    return String(message);
  }
  const known: any = __AS_READABLE_OPERATOR[String(operator)];
  return known === undefined ? "" : String(known);
}

// Two objects or two functions that are not `===` are not reference-equal, and
// `strictEqual` says so with its own header.
function __asCheckOperator(actual: any, expected: any, operator: any): any {
  if (
    operator === "strictEqual" &&
    ((typeof actual === "object" && actual !== null &&
      typeof expected === "object" && expected !== null) ||
      (typeof actual === "function" && typeof expected === "function"))
  ) {
    return "strictEqualObject";
  }
  return operator;
}

// `getStackedDiff`: the two one-line forms stacked, plus a `^` under the first
// differing character when the pair fits the terminal. Node's own
// `isStringComparison` guard here is always true — the two parameters are the
// *inspected* lines, which are strings whatever the raw values were — so it is
// not repeated. `process.stderr` does not exist here, so Node's non-TTY width
// of 80 is the only reachable one.
function __asGetStackedDiff(actual: string, expected: string): any {
  let message = "\n" + __asColors.green + "+" + __asColors.white + " " + actual +
    "\n" + __asColors.red + "- " + __asColors.white + expected;
  const stringsLen = Number(actual.length) + Number(expected.length);
  if (stringsLen <= 80) {
    let indicatorIdx = -1;
    const n = Number(actual.length);
    for (let i = 0; i < n; i++) {
      if (actual.charAt(i) !== expected.charAt(i)) {
        // Skip the indicator for the first characters because the difference is
        // immediately apparent; 3 rather than 2 accounts for the quotes.
        if (i >= 3) indicatorIdx = i;
        break;
      }
    }
    if (indicatorIdx !== -1) {
      message = message + "\n" + " ".repeat(indicatorIdx + 2) + "^";
    }
  }
  return { message: message, header: undefined, skipped: false };
}

function __asGetSimpleDiff(
  originalActual: any,
  actual: string,
  originalExpected: any,
  expected: string,
): any {
  let stringsLen = Number(actual.length) + Number(expected.length);
  // Accounting for the quotes wrapping strings.
  if (typeof originalActual === "string") stringsLen = stringsLen - 2;
  if (typeof originalExpected === "string") stringsLen = stringsLen - 2;
  if (
    stringsLen <= __AS_MAX_SHORT_STRING_LENGTH &&
    (originalActual !== 0 || originalExpected !== 0)
  ) {
    return { message: actual + " !== " + expected, header: "", skipped: false };
  }
  // Node branches to the *colored* character-level Myers diff when both raw
  // values are strings and the terminal has colors; without colors — which is
  // also Node on a redirected stderr — the stacked form is the only outcome.
  return __asGetStackedDiff(actual, expected);
}

function __asIsSimpleDiff(
  actual: any,
  inspectedActual: any,
  expected: any,
  inspectedExpected: any,
): boolean {
  if (Number(inspectedActual.length) > 1 || Number(inspectedExpected.length) > 1) {
    return false;
  }
  return typeof actual !== "object" || actual === null ||
    typeof expected !== "object" || expected === null;
}

function __asCreateErrDiff(
  actual: any,
  expected: any,
  rawOperator: any,
  customMessage: any,
  diffType: any,
): string {
  let operator: any = __asCheckOperator(actual, expected, rawOperator);

  let skipped = false;
  let message = "";
  const inspectedActual = __asInspectValue(actual);
  const inspectedExpected = __asInspectValue(expected);
  const inspectedSplitActual: any = inspectedActual.split("\n");
  const inspectedSplitExpected: any = inspectedExpected.split("\n");
  const showSimpleDiff = __asIsSimpleDiff(
    actual, inspectedSplitActual, expected, inspectedSplitExpected,
  );
  let header = __asColors.green + "+ actual" + __asColors.white + " " +
    __asColors.red + "- expected" + __asColors.white;

  if (showSimpleDiff) {
    const simpleDiff: any = __asGetSimpleDiff(
      actual, inspectedSplitActual[0], expected, inspectedSplitExpected[0],
    );
    message = String(simpleDiff.message);
    if (simpleDiff.header !== undefined) header = String(simpleDiff.header);
    if (simpleDiff.skipped === true) skipped = true;
  } else if (inspectedActual === inspectedExpected) {
    // Structurally the same but a different reference.
    operator = "notIdentical";
    if (Number(inspectedSplitActual.length) > 50 && diffType !== "full") {
      message = inspectedSplitActual.slice(0, 50).join("\n") + "\n...}";
      skipped = true;
    } else {
      message = inspectedSplitActual.join("\n");
    }
    header = "";
  } else {
    const checkCommaDisparity = actual !== null && actual !== undefined &&
      typeof actual === "object";
    const diff: any = myersDiff(
      inspectedSplitActual, inspectedSplitExpected, checkCommaDisparity,
    );
    const rendered: any = printMyersDiff(diff, operator);
    message = String(rendered.message);

    if (operator === "partialDeepStrictEqual") {
      header = __asColors.gray + (__asColors.hasColors ? "" : "+ ") + "actual" +
        __asColors.white + " " + __asColors.red + "- expected" + __asColors.white;
    }
    if (rendered.skipped === true) skipped = true;
  }

  const headerMessage = __asGetErrorMessage(operator, customMessage) + "\n" + header;
  const skippedMessage = skipped ? "\n... Skipped lines" : "";
  return headerMessage + skippedMessage + "\n" + message + "\n";
}

// The `notDeepStrictEqual` / `notStrictEqual` message: a single inspected side
// under the "not to be" header.
function __asCreateNotEqualMessage(actual: any, operator: any, diffType: any): string {
  let base: any = __AS_READABLE_OPERATOR[String(operator)];
  const res: any = __asInspectValue(actual).split("\n");

  if (
    operator === "notStrictEqual" &&
    ((typeof actual === "object" && actual !== null) || typeof actual === "function")
  ) {
    base = __AS_READABLE_OPERATOR["notStrictEqualObject"];
  }

  // Only remove lines where it makes sense to collapse them.
  if (Number(res.length) > 50 && diffType !== "full") {
    res[46] = __asColors.blue + "..." + __asColors.white;
    while (Number(res.length) > 47) res.pop();
  }

  if (Number(res.length) === 1) {
    return String(base) + (Number(res[0].length) > 5 ? "\n\n" : " ") + String(res[0]);
  }
  return String(base) + "\n\n" + res.join("\n") + "\n";
}

// The `deepEqual` / `notDeepEqual` / `==` / `!=` message: both sides inspected,
// joined by the operator or by one of the "should (not) loosely deep-equal"
// phrases.
function __asCreatePlainMessage(
  actual: any,
  expected: any,
  operator: any,
  diffType: any,
): string {
  let res = __asInspectValue(actual);
  let other = __asInspectValue(expected);
  const knownOperator: any = __AS_READABLE_OPERATOR[String(operator)];

  if (operator === "notDeepEqual" && res === other) {
    res = String(knownOperator) + "\n\n" + res;
    if (Number(res.length) > 1024 && diffType !== "full") {
      res = res.slice(0, 1021) + "...";
    }
    return res;
  }

  if (Number(res.length) > __AS_MAX_LONG_STRING_LENGTH && diffType !== "full") {
    res = res.slice(0, 509) + "...";
  }
  if (Number(other.length) > __AS_MAX_LONG_STRING_LENGTH && diffType !== "full") {
    other = other.slice(0, 509) + "...";
  }
  if (operator === "deepEqual") {
    res = String(knownOperator) + "\n\n" + res + "\n\nshould loosely deep-equal\n\n";
  } else {
    const newOp: any = __AS_READABLE_OPERATOR[String(operator) + "Unequal"];
    if (newOp !== undefined) {
      res = String(newOp) + "\n\n" + res + "\n\nshould not loosely deep-equal\n\n";
    } else {
      other = " " + String(operator) + " " + other;
    }
  }
  return res + other;
}

// The message `new AssertionError(options)` composes, split out of the
// constructor because a `super(...)` call must come first and this is several
// screens of branching.
function __asAssertionMessage(options: any): string {
  const message: any = options.message;
  const operator: any = options.operator;
  const actual: any = options.actual;
  const expected: any = options.expected;
  const diff: any = options.diff === undefined ? "simple" : options.diff;

  if (message !== undefined && message !== null) {
    if (__asHasCustomMessageDiff(operator)) {
      return __asCreateErrDiff(actual, expected, operator, message, diff);
    }
    return String(message);
  }
  if (__asHasCustomMessageDiff(operator)) {
    return __asCreateErrDiff(actual, expected, operator, undefined, diff);
  }
  if (operator === "notDeepStrictEqual" || operator === "notStrictEqual") {
    return __asCreateNotEqualMessage(actual, operator, diff);
  }
  return __asCreatePlainMessage(actual, expected, operator, diff);
}

// `assert.AssertionError`. `name` is a getter: Node defines it as
// `'AssertionError [ERR_ASSERTION]'` while the stack is captured and resets it
// to `'AssertionError'` afterwards, and the engine composes `err.stack`'s first
// line from `toString()`, which gets to the same place.
class AssertionError extends Error {
  code: string = "ERR_ASSERTION";
  actual: any = undefined;
  expected: any = undefined;
  operator: any = undefined;
  generatedMessage: boolean = false;
  diff: any = "simple";

  constructor(options: any) {
    super(__asAssertionMessage(options));
    this.code = "ERR_ASSERTION";
    this.generatedMessage = options.message === undefined || options.message === null;
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.diff = options.diff === undefined ? "simple" : options.diff;
  }

  get name(): string {
    return "AssertionError";
  }

  toString(): string {
    return this.name + " [" + this.code + "]: " + this.message;
  }
}

// ---------------------------------------------------------------------------
// Engine helpers
// ---------------------------------------------------------------------------

// A RegExp loses its methods when it flows through `any`, so a pattern received
// as an argument cannot answer `.test` directly; rebuild a statically typed one
// from its stringification (zun#7).
function __asRegexTest(value: any, subject: string): boolean {
  const text = String(value);
  let end = Number(text.length) - 1;
  while (end > 0 && text.charAt(end) !== "/") {
    end = end - 1;
  }
  const re = new RegExp(text.slice(1, end), text.slice(end + 1));
  return re.test(subject);
}

// `tools/harness/common.ts`' `expectsError` and `src/fs/fs.ts`' file-mode
// parser reach into this module for these two under their original spellings,
// the way `string_decoder` reads `__bufNormalizeEncoding` out of `buffer`.
// They are kept as the names those files already use so that renaming the
// internals here cannot break them.
function __regexTest(value: any, subject: string): boolean {
  return __asRegexTest(value, subject);
}

function __isDeepStrictEqual(a: any, b: any): boolean {
  return __asIsDeepStrictEqual(a, b);
}

// Unwrap a `functionBox` record back to its callable (zun#17, zun#50). A box
// reports `typeof === "function"` now, so both kinds are probed.
function __asUnboxFn(value: any): any {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return value;
  const inner: any = value["__boxedFn"];
  if (inner !== undefined) return inner;
  return value;
}

// `Object.is`, over the boxing unwrap: `NaN` equals `NaN` and `+0` differs from
// `-0`, which is what `strictEqual` means.
function __asObjectIs(a: any, b: any): boolean {
  if (a === b) {
    if (a === 0) return Object.is(a, b);
    return true;
  }
  if (__asUnboxFn(a) === __asUnboxFn(b)) return true;
  return Object.is(a, b);
}

// Is `value` a *constructor* rather than a predicate? A class value has a
// `prototype`, a plain function does not — which is Node's own guard
// (`expected.prototype !== undefined`). Here it also keeps a class value off
// the predicate path, where calling one aborts the program uncatchably.
function __asIsConstructor(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "function") return false;
  return value.prototype !== undefined;
}

function __asIsError(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  return value instanceof Error;
}

// An error's own constructor, through the boxing unwrap.
function __asCtorOf(value: any): any {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" && typeof value !== "function") return undefined;
  return value.constructor;
}

// `key in actual`, widened. `in` is a compile error on a typed receiver and
// answers `false` for the three members an `Error` subclass inherits rather
// than owns, so an own-property check, a dynamic read and that fixed set are
// all accepted.
function __asHasKey(obj: any, key: any): boolean {
  if (obj === null || obj === undefined) return false;
  if (typeof obj !== "object" && typeof obj !== "function") return false;
  const name = String(key);
  if (name === "name" || name === "message" || name === "stack") {
    return __asIsError(obj) || Object.hasOwn(obj, name);
  }
  if (Object.hasOwn(obj, name)) return true;
  return obj[name] !== undefined;
}

// ---------------------------------------------------------------------------
// The one coded error `assert` raises that no other module needed yet
// ---------------------------------------------------------------------------
//
// `ERR_INVALID_ARG_TYPE`, `ERR_INVALID_ARG_VALUE` and `ERR_OUT_OF_RANGE` come
// from `node:events` (src/events/events.ts holds this library's coded error
// bases); `ERR_MISSING_ARGS` and `ERR_INVALID_RETURN_VALUE` come from
// `node:util`. Only `ERR_AMBIGUOUS_ARGUMENT` is `assert`'s alone, so only it
// lives here. It extends `NodeTypeError`, so the `code` is a **declared
// field** and the instance never goes through the expando path (zun#37).

// `The "error/message" argument is ambiguous. <detail>`.
class ERR_AMBIGUOUS_ARGUMENT extends NodeTypeError {
  constructor(name: string, detail: string) {
    super(
      "ERR_AMBIGUOUS_ARGUMENT",
      'The "' + name + '" argument is ambiguous. ' + detail,
    );
  }
}

// ---------------------------------------------------------------------------
// Deep equality (lib/internal/util/comparisons.js)
// ---------------------------------------------------------------------------

// `assert.deepStrictEqual` is `util.isDeepStrictEqual`, which is how Node wires
// it: `lib/assert.js` calls `isDeepStrictEqual` out of
// `internal/util/comparisons`, the module `util.isDeepStrictEqual` also
// exposes. Keeping one implementation, in `util`, is the only arrangement where
// `assert.deepStrictEqual(new Map(…), new Map(…))` and
// `util.isDeepStrictEqual(new Map(…), new Map(…))` cannot disagree.
function __asIsDeepStrictEqual(a: any, b: any): boolean {
  return isDeepStrictEqual(a, b);
}

// The two modes `util` does not export, because nothing but `assert` asks for
// them: `kLoose` behind `assert.deepEqual`/`notDeepEqual` and `kPartial` behind
// `assert.partialDeepStrictEqual`.
const __AS_LOOSE: number = 0;
const __AS_PARTIAL: number = 1;

// `Object.prototype.toString.call(value)`.
function __asTag(value: any): string {
  return Object.prototype.toString.call(value);
}

// `innerDeepEqual(val1, val2, mode, memos)` for the loose and partial modes.
// The strict mode is `util`'s, above.
function __asInnerDeepEqual(a: any, b: any, mode: number, seen: any[]): boolean {
  if (a === b) {
    if (mode === __AS_LOOSE) return true;
    return a !== 0 || Object.is(a, b);
  }

  if (mode !== __AS_LOOSE) {
    if (typeof a === "number") {
      return Number.isNaN(a) && typeof b === "number" && Number.isNaN(b);
    }
    if (
      typeof b !== "object" || typeof a !== "object" ||
      a === null || b === null
    ) {
      // A function that crossed the `Any` lane is not an object on either side.
      const fnA: any = __asUnboxFn(a);
      const fnB: any = __asUnboxFn(b);
      if (typeof fnA === "function" || typeof fnB === "function") return fnA === fnB;
      return false;
    }
  } else {
    if (a === null || typeof a !== "object") {
      if (b !== null && typeof b === "object") return false;
      const fnA: any = __asUnboxFn(a);
      const fnB: any = __asUnboxFn(b);
      if (typeof fnA === "function" || typeof fnB === "function") return fnA === fnB;
      // eslint-disable-next-line eqeqeq
      if (a == b) return true;
      return typeof a === "number" && typeof b === "number" &&
        Number.isNaN(a) && Number.isNaN(b);
    }
    if (b === null || typeof b !== "object") return false;
  }

  const callableA: any = __asUnboxFn(a);
  const callableB: any = __asUnboxFn(b);
  if (typeof callableA === "function" || typeof callableB === "function") {
    return callableA === callableB;
  }

  return __asObjectComparison(a, b, mode, seen);
}

function __asObjectComparison(a: any, b: any, mode: number, seen: any[]): boolean {
  const tagA = __asTag(a);
  const tagB = __asTag(b);
  if (tagA !== tagB) return false;

  if (a instanceof Date) {
    if (!(b instanceof Date)) return false;
    const t1 = Number(a.getTime());
    const t2 = Number(b.getTime());
    if (t1 !== t2) return Number.isNaN(t1) && Number.isNaN(t2);
  } else if (tagA === "[object RegExp]") {
    if (String(a.source) !== String(b.source)) return false;
    if (String(a.flags) !== String(b.flags)) return false;
  } else if (a instanceof Error) {
    if (!(b instanceof Error)) return false;
    if (!__asEnumerableOrIdentical(a, b, "message", mode, seen)) return false;
    if (!__asEnumerableOrIdentical(a, b, "name", mode, seen)) return false;
    if (!__asEnumerableOrIdentical(a, b, "cause", mode, seen)) return false;
    if (!__asEnumerableOrIdentical(a, b, "errors", mode, seen)) return false;
    const hasOwnBCause = Object.hasOwn(b, "cause");
    if (hasOwnBCause !== Object.hasOwn(a, "cause") && (mode !== __AS_PARTIAL || hasOwnBCause)) {
      return false;
    }
  }

  // Cycles: the pair is remembered while its members are compared.
  for (const pair of seen) {
    if (pair[0] === a && pair[1] === b) return true;
  }
  seen.push([a, b]);

  let equal = true;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) {
    equal = false;
  } else if (arrayA) {
    const lenA = Number(a.length);
    const lenB = Number(b.length);
    if (lenA !== lenB && (mode !== __AS_PARTIAL || lenA < lenB)) {
      equal = false;
    } else if (mode === __AS_PARTIAL) {
      equal = __asPartialArrayEquiv(a, b, mode, seen);
    } else {
      for (let i = 0; i < lenA; i++) {
        if (!__asInnerDeepEqual(a[i], b[i], mode, seen)) {
          equal = false;
          break;
        }
      }
    }
  } else if (tagA === "[object Map]") {
    equal = __asMapEquiv(a, b, mode, seen);
  } else if (tagA === "[object Set]") {
    equal = __asSetEquiv(a, b, mode, seen);
  }

  if (equal) equal = __asKeyCheck(a, b, mode, seen, arrayA);
  seen.pop();
  return equal;
}

// `isEnumerableOrIdentical`: an error member matches when `expected` has it as
// an own property, when the partial mode lets it be absent, or when the two
// values are deep-equal.
function __asEnumerableOrIdentical(
  a: any, b: any, prop: string, mode: number, seen: any[],
): boolean {
  if (Object.hasOwn(b, prop)) return true;
  if (mode === __AS_PARTIAL) {
    if (b[prop] === undefined) return true;
    if (prop === "message" && b[prop] === "") return true;
  }
  return __asInnerDeepEqual(a[prop], b[prop], mode, seen);
}

// Is `key` a canonical array index? Node reaches the same split with
// `getOwnNonIndexProperties`, an internal binding: an array's elements are
// compared by the array walk, so only its *named* properties belong to the key
// check.
function __asIsIndexKey(key: any): boolean {
  const text = String(key);
  const n = Number(text.length);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const ch = text.charAt(i);
    if (ch < "0" || ch > "9") return false;
  }
  if (n > 1 && text.charAt(0) === "0") return false;
  return true;
}

function __asNamedKeys(value: any, skipIndices: boolean): any[] {
  const out: any[] = [];
  for (const key of Object.keys(value)) {
    if (skipIndices && __asIsIndexKey(key)) continue;
    out.push(key);
  }
  return out;
}

// `keyCheck`: the own enumerable key sets must match (or, in the partial mode,
// `expected`'s must be a subset of `actual`'s). `skipIndices` is set for an
// array, whose elements the array walk has already compared.
function __asKeyCheck(a: any, b: any, mode: number, seen: any[], skipIndices: boolean): boolean {
  const bKeys: any = __asNamedKeys(b, skipIndices);
  if (mode !== __AS_PARTIAL) {
    const aKeys: any = __asNamedKeys(a, skipIndices);
    if (Number(bKeys.length) !== Number(aKeys.length)) return false;
  }
  for (const key of bKeys) {
    if (!Object.hasOwn(a, key)) return false;
    if (!__asInnerDeepEqual(a[key], b[key], mode, seen)) return false;
  }
  const bSyms: any = Object.getOwnPropertySymbols(b);
  if (mode !== __AS_PARTIAL) {
    const aSyms: any = Object.getOwnPropertySymbols(a);
    if (Number(aSyms.length) !== Number(bSyms.length)) return false;
  }
  for (const sym of bSyms) {
    if (!__asInnerDeepEqual(a[sym], b[sym], mode, seen)) return false;
  }
  return true;
}

// `partialArrayEquiv`: `expected`'s elements must appear in `actual` in order,
// not necessarily contiguously.
function __asPartialArrayEquiv(a: any, b: any, mode: number, seen: any[]): boolean {
  let aPos = 0;
  const lenA = Number(a.length);
  const lenB = Number(b.length);
  for (let i = 0; i < lenB; i++) {
    while (!__asInnerDeepEqual(a[aPos], b[i], mode, seen)) {
      aPos = aPos + 1;
      if (aPos > lenA - lenB + i) return false;
    }
    aPos = aPos + 1;
  }
  return true;
}

// `setEquiv`, reduced to the pairwise search: every member of `b` must have an
// unused deep-equal partner in `a`. Node reaches the same answer with a
// direction-walking optimisation that only changes the cost.
function __asSetEquiv(a: any, b: any, mode: number, seen: any[]): boolean {
  const sizeA = Number(a.size);
  const sizeB = Number(b.size);
  if (sizeA !== sizeB && (mode !== __AS_PARTIAL || sizeA < sizeB)) return false;
  const pool: any[] = [];
  for (const entry of a) pool.push(entry);
  const used: boolean[] = [];
  for (let i = 0; i < Number(pool.length); i++) used.push(false);
  for (const wanted of b) {
    let found = false;
    for (let i = 0; i < Number(pool.length); i++) {
      if (used[i]) continue;
      if (__asInnerDeepEqual(pool[i], wanted, mode, seen)) {
        used[i] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// `mapEquiv`, reduced the same way: every entry of `b` must have an unused
// entry of `a` whose key *and* value are deep-equal.
function __asMapEquiv(a: any, b: any, mode: number, seen: any[]): boolean {
  const sizeA = Number(a.size);
  const sizeB = Number(b.size);
  if (sizeA !== sizeB && (mode !== __AS_PARTIAL || sizeA < sizeB)) return false;
  const pool: any[] = [];
  for (const entry of a) pool.push(entry);
  const used: boolean[] = [];
  for (let i = 0; i < Number(pool.length); i++) used.push(false);
  for (const wanted of b) {
    let found = false;
    for (let i = 0; i < Number(pool.length); i++) {
      if (used[i]) continue;
      const candidate: any = pool[i];
      if (
        __asInnerDeepEqual(candidate[0], wanted[0], mode, seen) &&
        __asInnerDeepEqual(candidate[1], wanted[1], mode, seen)
      ) {
        used[i] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// `isDeepEqual` — the loose mode, which is what `assert.deepEqual` has always
// meant and what this module used to get wrong by aliasing it to the strict
// comparison.
function __asIsDeepEqual(a: any, b: any): boolean {
  return __asInnerDeepEqual(a, b, __AS_LOOSE, []);
}

// `isPartialStrictEqual` — `expected` describes a *subset* of `actual`.
function __asIsPartialStrictEqual(a: any, b: any): boolean {
  return __asInnerDeepEqual(a, b, __AS_PARTIAL, []);
}

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

// An uncaught error prints only its address today (zun#8), so every failure is
// reported here, where the detail is still in hand. The throw still decides the
// exit code. This is a debugging aid the whole library's work depends on, so it
// stays even though Node prints nothing at this point.
function __asReport(err: any): void {
  console.error("AssertionError [" + String(err.operator) + "]: " + String(err.message));
}

// `innerFail(obj)`: an `Error` message is thrown as-is, anything else becomes
// an `AssertionError`.
function __asInnerFail(options: any): void {
  const message: any = options.message;
  if (__asIsError(message)) throw message;
  const err = new AssertionError(options);
  __asReport(err);
  throw err;
}

// `innerOk(fn, argLen, value, message)` from `internal/assert/utils`. Node also
// recovers the *source expression* that evaluated falsy, which needs a stack
// with column information plus the test file's own text; without it the
// generated message is empty, exactly as Node's is when
// `getErrorSourceExpression` finds nothing.
function __asInnerOk(argLen: number, value: any, message: any): void {
  if (value) return;
  let generatedMessage = false;
  let text: any = message;

  if (argLen === 0) {
    generatedMessage = true;
    text = "No value argument passed to `assert.ok()`";
  } else if (text === undefined || text === null) {
    generatedMessage = true;
    text = undefined;
  } else if (__asIsError(text)) {
    throw text;
  }

  const err = new AssertionError({
    actual: value,
    expected: true,
    message: text,
    operator: "==",
  });
  err.generatedMessage = generatedMessage;
  __asReport(err);
  throw err;
}

// ---------------------------------------------------------------------------
// throws / rejects validation (lib/assert.js' expectedException)
// ---------------------------------------------------------------------------

// Is `error` an instance of `expected`, when `expected` is one of the standard
// error constructors? `undefined` means "`expected` is not one of them", which
// is what tells the caller to look further.
//
// Every `instanceof` below names its class literally, because that is the only
// spelling the engine resolves; the identity test in front of it is what makes
// the dispatch work at all. `AssertionError` is this module's own class and is
// included so `assert.throws(fn, assert.AssertionError)` behaves.
function __asMatchesErrorConstructor(error: any, expected: any): any {
  if (expected === Error) return error instanceof Error;
  if (expected === TypeError) return error instanceof TypeError;
  if (expected === RangeError) return error instanceof RangeError;
  if (expected === SyntaxError) return error instanceof SyntaxError;
  if (expected === ReferenceError) return error instanceof ReferenceError;
  if (expected === EvalError) return error instanceof EvalError;
  if (expected === URIError) return error instanceof URIError;
  if (expected === AssertionError) return error instanceof AssertionError;
  return undefined;
}

// A constructor's `name`. A *class* value answers its own name, but a built-in
// read as a value answers `undefined` (zun#17), so the eight standard error
// constructors are named by identity — which is exactly the set Node's
// "The error is expected to be an instance of …" message is reached with most
// often.
function __asCtorName(ctor: any): string {
  if (ctor === Error) return "Error";
  if (ctor === TypeError) return "TypeError";
  if (ctor === RangeError) return "RangeError";
  if (ctor === SyntaxError) return "SyntaxError";
  if (ctor === ReferenceError) return "ReferenceError";
  if (ctor === EvalError) return "EvalError";
  if (ctor === URIError) return "URIError";
  if (ctor === AssertionError) return "AssertionError";
  if (ctor === null || ctor === undefined) return "undefined";
  const name: any = ctor.name;
  return name === undefined || name === null ? "undefined" : String(name);
}

// `assert.throws(fn, Ctor)`: Node writes `actual instanceof expected`. The
// right operand of `instanceof` must be a literal class name here, so the
// standard constructors are matched by identity and anything else by
// `constructor` identity, which is exact-class only (zun#51).
function __asMatchesConstructor(error: any, expected: any): boolean {
  const byStandard: any = __asMatchesErrorConstructor(error, expected);
  if (byStandard !== undefined) return byStandard === true;
  return __asCtorOf(error) === expected;
}

// `Comparison`: the placeholder object Node builds so a failing validation
// object prints only the keys it asked about.
//
// Node's is an instance of a class called `Comparison`, so its diff reads
// `Comparison { name: 'Error' }`; this one is a plain object and reads
// `{ name: 'Error' }`. A class instance cannot be given the keys: a key the
// class did not declare poisons the instance (zun#37) and
// `Object.defineProperty` on one throws. It is the single divergence left in a
// 50-case differential run of this module's failure messages against Node.
function __asComparison(obj: any, keys: any, actual: any): any {
  const out: any = {};
  for (const key of keys) {
    if (!__asHasKey(obj, key)) continue;
    const want: any = obj[key];
    if (
      actual !== undefined && actual !== null &&
      typeof actual[key] === "string" &&
      want instanceof RegExp &&
      __asRegexTest(want, String(actual[key]))
    ) {
      out[key] = actual[key];
    } else {
      out[key] = want;
    }
  }
  return out;
}

// `compareExceptionKey`.
function __asCompareExceptionKey(
  actual: any, expected: any, key: any, message: any, keys: any, fnName: string, diff: any,
): void {
  if (__asHasKey(actual, key) && __asIsDeepStrictEqual(actual[key], expected[key])) {
    return;
  }
  if (message === undefined || message === null) {
    const a = __asComparison(actual, keys, undefined);
    const b = __asComparison(expected, keys, actual);
    const err = new AssertionError({
      actual: a,
      expected: b,
      operator: "deepStrictEqual",
      diff: diff,
    });
    err.actual = actual;
    err.expected = expected;
    err.operator = fnName;
    __asReport(err);
    throw err;
  }
  __asInnerFail({
    actual: actual,
    expected: expected,
    message: message,
    operator: fnName,
    diff: diff,
  });
}

// `expectedException(actual, expected, message, fn)`: `expected` may be a
// RegExp, a constructor, a validation object (`{ code, name, message }`), an
// error instance or a predicate.
function __asExpectedException(
  actual: any, boxedExpected: any, message: any, fnName: string, diff: any,
): void {
  const expected: any = __asUnboxFn(boxedExpected);
  let generatedMessage = false;
  let throwError = false;
  let text: any = message;

  if (typeof expected !== "function") {
    if (expected instanceof RegExp) {
      // Node's `expectedException` tests the pattern against `String(actual)`,
      // i.e. against `"RangeError: Invalid input"`, not against the message
      // alone — which is why its own tests anchor the error's *name* in the
      // pattern (`test-punycode.js` uses `/^RangeError: Invalid input$/`).
      const str = String(actual);
      if (__asRegexTest(expected, str)) return;
      if (text === undefined || text === null || String(text) === "") {
        generatedMessage = true;
        text = "The input did not match the regular expression " +
          __asInspect(expected) + ". Input:\n\n" + __asInspect(str) + "\n";
      }
      throwError = true;
    } else if (typeof actual !== "object" || actual === null) {
      // A primitive was thrown where a validation object was expected.
      const err = new AssertionError({
        actual: actual,
        expected: expected,
        message: text,
        operator: "deepStrictEqual",
        diff: diff,
      });
      err.operator = fnName;
      __asReport(err);
      throw err;
    } else {
      // A validation object. An `Error` additionally has its `name` and
      // `message` compared, and an empty plain object is rejected outright.
      const keys: any[] = [];
      for (const key of Object.keys(expected)) keys.push(key);
      if (expected instanceof Error) {
        keys.push("name");
        keys.push("message");
      } else if (Number(keys.length) === 0) {
        throw new ERR_INVALID_ARG_VALUE("error", expected, "may not be an empty object");
      }
      for (const key of keys) {
        const want: any = expected[key];
        if (
          typeof actual[key] === "string" &&
          want instanceof RegExp &&
          __asRegexTest(want, String(actual[key]))
        ) {
          continue;
        }
        __asCompareExceptionKey(actual, expected, key, text, keys, fnName, diff);
      }
      return;
    }
  } else if (__asIsConstructor(expected)) {
    if (__asMatchesConstructor(actual, expected)) return;
    if (text === undefined || text === null || String(text) === "") {
      generatedMessage = true;
      const wantedName = __asCtorName(expected);
      text = 'The error is expected to be an instance of "' + wantedName + '". Received ';
      if (__asIsError(actual)) {
        const ctor: any = __asCtorOf(actual);
        const name: any = ctor === undefined || ctor === null || ctor.name === undefined
          ? actual.name
          : ctor.name;
        if (wantedName === String(name)) {
          text = text + "an error with identical name but a different prototype.";
        } else {
          text = text + '"' + String(name) + '"';
        }
        if (actual.message !== undefined && String(actual.message) !== "") {
          text = text + "\n\nError message:\n\n" + String(actual.message);
        }
      } else {
        text = text + '"' + inspect(actual, { depth: -1 }) + '"';
      }
    }
    throwError = true;
  } else {
    // A validation function.
    const res: any = expected(actual);
    if (res !== true) {
      if (text === undefined || text === null || String(text) === "") {
        generatedMessage = true;
        const name: any = expected.name;
        const named = name === undefined || name === null || String(name) === ""
          ? ""
          : '"' + String(name) + '" ';
        text = "The " + named + "validation function is expected to return" +
          ' "true". Received ' + __asInspect(res);
        if (__asIsError(actual)) {
          text = text + "\n\nCaught error:\n\n" + String(actual);
        }
      }
      throwError = true;
    }
  }

  if (throwError) {
    const err = new AssertionError({
      actual: actual,
      expected: expected,
      message: text,
      operator: fnName,
      diff: diff,
    });
    err.generatedMessage = generatedMessage;
    __asReport(err);
    throw err;
  }
}

// The sentinel Node uses to tell "did not throw" from "threw `undefined`".
const __AS_NO_EXCEPTION: any = { __zunNoException: true };

function __asGetActual(fn: any): any {
  const callable: any = __asUnboxFn(fn);
  if (typeof callable !== "function") {
    throw new ERR_INVALID_ARG_TYPE("fn", "Function", fn);
  }
  try {
    callable();
  } catch (caught) {
    return caught;
  }
  return __AS_NO_EXCEPTION;
}

// `expectsError(stackStartFn, actual, error, message)`. `argLen` is the number
// of values the caller passed to `throws`/`rejects`, which Node reads to reject
// a four-argument call whose `error` is a string.
function __asExpectsError(
  fnName: string, actual: any, error: any, message: any, argLen: number, diff: any,
): void {
  let expected: any = error;
  let text: any = message;

  // The `typeof` test is hoisted into a boolean rather than written in the
  // `if` condition: an assignment inside a `typeof`-narrowed block lands in the
  // narrowing's shadow slot and the variable keeps its old value (zun#66), so
  // `expected = undefined` below was swallowed and `expected.name` then
  // panicked the interpreter with "expected object, found Str".
  const expectedIsString: boolean = typeof expected === "string";
  if (expectedIsString) {
    if (argLen >= 4) {
      throw new ERR_INVALID_ARG_TYPE(
        "error", ["Object", "Error", "Function", "RegExp"], expected,
      );
    }
    if (typeof actual === "object" && actual !== null) {
      if (String(actual.message) === expected) {
        throw new ERR_AMBIGUOUS_ARGUMENT(
          "error/message",
          'The error message "' + String(actual.message) + '" is identical to the message.',
        );
      }
    } else if (actual === expected) {
      throw new ERR_AMBIGUOUS_ARGUMENT(
        "error/message",
        'The error "' + String(actual) + '" is identical to the message.',
      );
    }
    text = expected;
    expected = undefined;
  } else if (
    expected !== null && expected !== undefined &&
    typeof expected !== "object" && typeof expected !== "function"
  ) {
    throw new ERR_INVALID_ARG_TYPE(
      "error", ["Object", "Error", "Function", "RegExp"], expected,
    );
  }

  if (actual === __AS_NO_EXCEPTION) {
    let details = "";
    const wantedName: any = __asIsConstructor(expected)
      ? __asCtorName(expected)
      : (expected === null || expected === undefined ? undefined : expected.name);
    if (wantedName !== undefined && wantedName !== null) {
      details = details + " (" + String(wantedName) + ")";
    }
    details = details +
      (text !== undefined && text !== null && String(text) !== "" ? ": " + String(text) : ".");
    const fnType = fnName === "rejects" ? "rejection" : "exception";
    __asInnerFail({
      actual: undefined,
      expected: expected,
      operator: fnName,
      message: "Missing expected " + fnType + details,
      diff: diff,
    });
    return;
  }

  if (expected === undefined || expected === null || expected === false) return;
  __asExpectedException(actual, expected, text, fnName, diff);
}

// `hasMatchingError(actual, expected)` for `doesNotThrow`/`doesNotReject`.
function __asHasMatchingError(actual: any, boxedExpected: any): boolean {
  const expected: any = __asUnboxFn(boxedExpected);
  if (typeof expected !== "function") {
    if (expected instanceof RegExp) {
      return __asRegexTest(expected, String(actual));
    }
    throw new ERR_INVALID_ARG_TYPE("expected", ["Function", "RegExp"], expected);
  }
  if (__asIsConstructor(expected)) {
    return __asMatchesConstructor(actual, expected);
  }
  return expected(actual) === true;
}

// `expectsNoError(stackStartFn, actual, error, message)`.
function __asExpectsNoError(
  fnName: string, actual: any, error: any, message: any, diff: any,
): void {
  if (actual === __AS_NO_EXCEPTION) return;

  let expected: any = error;
  let text: any = message;
  // Hoisted for the same reason as in `__asExpectsError` above (zun#66).
  const expectedIsString: boolean = typeof expected === "string";
  if (expectedIsString) {
    text = expected;
    expected = undefined;
  }

  const unwanted = expected === undefined || expected === null ||
    __asHasMatchingError(actual, expected);
  if (unwanted) {
    const details = text !== undefined && text !== null && String(text) !== ""
      ? ": " + String(text)
      : ".";
    const fnType = fnName === "doesNotReject" ? "rejection" : "exception";
    const actualMessage = actual === null || actual === undefined
      ? "undefined"
      : String(actual.message);
    __asInnerFail({
      actual: actual,
      expected: expected,
      operator: fnName,
      message: "Got unwanted " + fnType + details + "\n" +
        'Actual message: "' + actualMessage + '"',
      diff: diff,
    });
  }
  throw actual;
}

// `checkIsPromise`: a native promise, or a thenable with both `then` and
// `catch`.
function __asIsThenable(obj: any): boolean {
  if (obj instanceof Promise) return true;
  if (obj === null || obj === undefined || typeof obj !== "object") return false;
  return typeof obj["then"] === "function" && typeof obj["catch"] === "function";
}

// `internalMatch(string, regexp, message, fn)`.
function __asInternalMatch(
  value: any, regexp: any, message: any, fnName: string, wantMatch: boolean, diff: any,
): void {
  if (!(regexp instanceof RegExp)) {
    throw new ERR_INVALID_ARG_TYPE("regexp", "RegExp", regexp);
  }
  const isString = typeof value === "string";
  const matched = isString ? __asRegexTest(regexp, String(value)) : false;
  if (!isString || matched !== wantMatch) {
    if (__asIsError(message)) throw message;
    const generatedMessage = message === undefined || message === null ||
      String(message) === "";
    let text: any = message;
    if (generatedMessage) {
      if (!isString) {
        text = 'The "string" argument must be of type string. Received type ' +
          typeof value + " (" + __asInspect(value) + ")";
      } else {
        text = (wantMatch
          ? "The input did not match the regular expression "
          : "The input was expected to not match the regular expression ") +
          __asInspect(regexp) + ". Input:\n\n" + __asInspect(value) + "\n";
      }
    }
    const err = new AssertionError({
      actual: value,
      expected: regexp,
      message: text,
      operator: fnName,
      diff: diff,
    });
    err.generatedMessage = generatedMessage;
    __asReport(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The shared method bodies
// ---------------------------------------------------------------------------
//
// `assert`, `assert.strict`, `require('assert/strict')` and every `Assert`
// instance expose the same assertions; only the `{ diff, strict,
// skipPrototype }` options differ. Each assertion is therefore one function
// taking its options explicitly, and the four surfaces are thin wrappers over
// these.

function __asFail(message: any, diff: any): void {
  if (__asIsError(message)) throw message;
  let internalMessage = false;
  let text: any = message;
  if (text === undefined) {
    text = "Failed";
    internalMessage = true;
  }
  const err = new AssertionError({ operator: "fail", message: text, diff: diff });
  if (internalMessage) err.generatedMessage = true;
  __asReport(err);
  throw err;
}

function __asEqual(actual: any, expected: any, message: any, argLen: number, diff: any): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  // eslint-disable-next-line eqeqeq
  if (actual != expected && (!Number.isNaN(actual) || !Number.isNaN(expected))) {
    __asInnerFail({
      actual: actual, expected: expected, message: message, operator: "==", diff: diff,
    });
  }
}

function __asNotEqual(actual: any, expected: any, message: any, argLen: number, diff: any): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  // eslint-disable-next-line eqeqeq
  if (actual == expected || (Number.isNaN(actual) && Number.isNaN(expected))) {
    __asInnerFail({
      actual: actual, expected: expected, message: message, operator: "!=", diff: diff,
    });
  }
}

function __asStrictEqual(
  actual: any, expected: any, message: any, argLen: number, diff: any,
): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  if (!__asObjectIs(actual, expected)) {
    __asInnerFail({
      actual: actual, expected: expected, message: message,
      operator: "strictEqual", diff: diff,
    });
  }
}

function __asNotStrictEqual(
  actual: any, expected: any, message: any, argLen: number, diff: any,
): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  if (__asObjectIs(actual, expected)) {
    __asInnerFail({
      actual: actual, expected: expected, message: message,
      operator: "notStrictEqual", diff: diff,
    });
  }
}

function __asDeepEqual(actual: any, expected: any, message: any, argLen: number, diff: any): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  if (!__asIsDeepEqual(actual, expected)) {
    __asInnerFail({
      actual: actual, expected: expected, message: message,
      operator: "deepEqual", diff: diff,
    });
  }
}

function __asNotDeepEqual(
  actual: any, expected: any, message: any, argLen: number, diff: any,
): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  if (__asIsDeepEqual(actual, expected)) {
    __asInnerFail({
      actual: actual, expected: expected, message: message,
      operator: "notDeepEqual", diff: diff,
    });
  }
}

function __asDeepStrictEqual(
  actual: any, expected: any, message: any, argLen: number, diff: any,
): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  if (!__asIsDeepStrictEqual(actual, expected)) {
    __asInnerFail({
      actual: actual, expected: expected, message: message,
      operator: "deepStrictEqual", diff: diff,
    });
  }
}

function __asNotDeepStrictEqual(
  actual: any, expected: any, message: any, argLen: number, diff: any,
): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  if (__asIsDeepStrictEqual(actual, expected)) {
    __asInnerFail({
      actual: actual, expected: expected, message: message,
      operator: "notDeepStrictEqual", diff: diff,
    });
  }
}

function __asPartialDeepStrictEqual(
  actual: any, expected: any, message: any, argLen: number, diff: any,
): void {
  if (argLen < 2) throw new ERR_MISSING_ARGS("actual", "expected");
  if (!__asIsPartialStrictEqual(actual, expected)) {
    __asInnerFail({
      actual: actual, expected: expected, message: message,
      operator: "partialDeepStrictEqual", diff: diff,
    });
  }
}

function __asIfError(err: any, diff: any): void {
  if (err === null || err === undefined) return;
  let message = "ifError got unwanted exception: ";
  if (typeof err === "object" && typeof err.message === "string") {
    if (Number(err.message.length) === 0 && __asCtorOf(err) !== undefined) {
      message = message + String(__asCtorOf(err).name);
    } else {
      message = message + String(err.message);
    }
  } else {
    message = message + __asInspect(err);
  }
  // Node splices the original error's frames onto the new error's stack so the
  // throw site of the real failure survives. `stack` has no setter here (a new
  // engine gap, reported with this work), so the new error keeps its own.
  __asInnerFail({
    actual: err, expected: null, operator: "ifError", message: message, diff: diff,
  });
}

function __asThrows(fn: any, args: any[], diff: any): void {
  const actual: any = __asGetActual(fn);
  __asExpectsError("throws", actual, args[0], args[1], Number(args.length) + 2, diff);
}

function __asDoesNotThrow(fn: any, args: any[], diff: any): void {
  const actual: any = __asGetActual(fn);
  __asExpectsNoError("doesNotThrow", actual, args[0], args[1], diff);
}

// `waitForActual(promiseFn)` -> a Promise of either the rejection reason or the
// "did not throw" sentinel. The engine has no `async function`, so this and the
// two assertions over it are written with explicit `then` handlers.
//
// Every callback below is declared `: any` and ends in an explicit
// `return undefined`: a `void` closure that calls an `any`-typed callback
// leaves the call result on the stack and the bytecode verifier rejects the
// method (`BadReturnHeight`).
function __asWaitForActual(promiseOrFn: any): any {
  return new Promise(function (resolve: any, reject: any): any {
    let subject: any = promiseOrFn;
    const callable: any = __asUnboxFn(promiseOrFn);
    if (typeof callable === "function") {
      try {
        subject = callable();
      } catch (caught) {
        // A synchronous throw out of `promiseFn` is the rejection.
        resolve(caught);
        return undefined;
      }
      if (!__asIsThenable(subject)) {
        reject(new ERR_INVALID_RETURN_VALUE("instance of Promise", "promiseFn", subject));
        return undefined;
      }
    } else if (!__asIsThenable(subject)) {
      reject(new ERR_INVALID_ARG_TYPE("promiseFn", ["Function", "Promise"], promiseOrFn));
      return undefined;
    }
    const onFulfilled: any = function (): any {
      resolve(__AS_NO_EXCEPTION);
      return undefined;
    };
    const onRejected: any = function (error: any): any {
      resolve(error);
      return undefined;
    };
    subject.then(onFulfilled, onRejected);
    return undefined;
  });
}

function __asRejects(promiseOrFn: any, args: any[], diff: any): any {
  const state: any = { args: args, diff: diff };
  const settled: any = __asWaitForActual(promiseOrFn);
  return new Promise(function (resolve: any, reject: any): any {
    const onSettled: any = function (actual: any): any {
      try {
        __asExpectsError(
          "rejects", actual, state.args[0], state.args[1],
          Number(state.args.length) + 2, state.diff,
        );
        resolve(undefined);
      } catch (failure) {
        reject(failure);
      }
      return undefined;
    };
    const onBroken: any = function (error: any): any {
      reject(error);
      return undefined;
    };
    settled.then(onSettled, onBroken);
    return undefined;
  });
}

function __asDoesNotReject(promiseOrFn: any, args: any[], diff: any): any {
  const state: any = { args: args, diff: diff };
  const settled: any = __asWaitForActual(promiseOrFn);
  return new Promise(function (resolve: any, reject: any): any {
    const onSettled: any = function (actual: any): any {
      try {
        __asExpectsNoError(
          "doesNotReject", actual, state.args[0], state.args[1], state.diff,
        );
        resolve(undefined);
      } catch (failure) {
        reject(failure);
      }
      return undefined;
    };
    const onBroken: any = function (error: any): any {
      reject(error);
      return undefined;
    };
    settled.then(onSettled, onBroken);
    return undefined;
  });
}

// ---------------------------------------------------------------------------
// The default surface
// ---------------------------------------------------------------------------
//
// `assert` is a **function** that carries the methods, which is how Node
// exports it: `lib/assert.js` ends with `module.exports = assert`, where
// `assert` is `ok`'s twin, so `assert(value)` and `assert.ok(value)` are the
// same assertion and the module object is callable. Several of Node's own test
// files depend on that — `test-path-parse-format.js`, `test-os.js` and
// `test-event-emitter-listeners-side-effects.js` all call `assert(...)`
// directly — and until recently this engine could not express it: a function
// could not carry callable properties, so the surface had to be a plain object
// and the call form was unreachable (zun#14). It can now, and the call form
// resolves from module scope, from a nested function, from a closure, through
// an `any` parameter and through `assert.strict`.
//
// Each method takes a rest parameter rather than named optionals, because the
// *count* of supplied values is observable: `assert.ok()` with none says "No
// value argument passed to `assert.ok()`", and `assert.equal(1)` raises
// `ERR_MISSING_ARGS`.
function assert(...passed: any[]): void {
  __asInnerOk(Number(passed.length), passed[0], passed[1]);
}

assert.AssertionError = AssertionError;

assert.ok = function (...passed: any[]): void {
  __asInnerOk(Number(passed.length), passed[0], passed[1]);
};

assert.fail = function (...passed: any[]): void {
  __asFail(passed[0], undefined);
};

assert.equal = function (...passed: any[]): void {
  __asEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.notEqual = function (...passed: any[]): void {
  __asNotEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.deepEqual = function (...passed: any[]): void {
  __asDeepEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.notDeepEqual = function (...passed: any[]): void {
  __asNotDeepEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.strictEqual = function (...passed: any[]): void {
  __asStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.notStrictEqual = function (...passed: any[]): void {
  __asNotStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.deepStrictEqual = function (...passed: any[]): void {
  __asDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.notDeepStrictEqual = function (...passed: any[]): void {
  __asNotDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.partialDeepStrictEqual = function (...passed: any[]): void {
  __asPartialDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

assert.ifError = function (...passed: any[]): void {
  __asIfError(passed[0], undefined);
};

assert.throws = function (...passed: any[]): void {
  __asThrows(passed[0], passed.slice(1), undefined);
};

assert.doesNotThrow = function (...passed: any[]): void {
  __asDoesNotThrow(passed[0], passed.slice(1), undefined);
};

assert.rejects = function (...passed: any[]): any {
  return __asRejects(passed[0], passed.slice(1), undefined);
};

assert.doesNotReject = function (...passed: any[]): any {
  return __asDoesNotReject(passed[0], passed.slice(1), undefined);
};

assert.match = function (...passed: any[]): void {
  __asInternalMatch(passed[0], passed[1], passed[2], "match", true, undefined);
};

assert.doesNotMatch = function (...passed: any[]): void {
  __asInternalMatch(passed[0], passed[1], passed[2], "doesNotMatch", false, undefined);
};

// ---------------------------------------------------------------------------
// The strict surface (`assert.strict`, `require('assert/strict')`)
// ---------------------------------------------------------------------------
//
// `strict` is a top-level function of its own, not a copy of `assert`, because
// Node's is: `assert.strict = ObjectAssign(strict, assert, { equal:
// strictEqual, deepEqual: deepStrictEqual, notEqual: notStrictEqual,
// notDeepEqual: notDeepStrictEqual })`. Declaring it top-level is also what
// lets the bundler bind `const { strict } = require('assert');` to it, the
// spelling Node's own `test-assert.js` uses.
function strict(...passed: any[]): void {
  __asInnerOk(Number(passed.length), passed[0], passed[1]);
}

// Each method is its own closure rather than a copy of `assert`'s: reading a
// function-valued property back off a function is not reliable here (zun#17,
// zun#32), and the four loose names have to point at the strict comparisons
// anyway.
strict.AssertionError = AssertionError;

strict.ok = function (...passed: any[]): void {
  __asInnerOk(Number(passed.length), passed[0], passed[1]);
};

strict.fail = function (...passed: any[]): void {
  __asFail(passed[0], undefined);
};

strict.equal = function (...passed: any[]): void {
  __asStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.notEqual = function (...passed: any[]): void {
  __asNotStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.deepEqual = function (...passed: any[]): void {
  __asDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.notDeepEqual = function (...passed: any[]): void {
  __asNotDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.strictEqual = function (...passed: any[]): void {
  __asStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.notStrictEqual = function (...passed: any[]): void {
  __asNotStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.deepStrictEqual = function (...passed: any[]): void {
  __asDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.notDeepStrictEqual = function (...passed: any[]): void {
  __asNotDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.partialDeepStrictEqual = function (...passed: any[]): void {
  __asPartialDeepStrictEqual(passed[0], passed[1], passed[2], Number(passed.length), undefined);
};

strict.ifError = function (...passed: any[]): void {
  __asIfError(passed[0], undefined);
};

strict.throws = function (...passed: any[]): void {
  __asThrows(passed[0], passed.slice(1), undefined);
};

strict.doesNotThrow = function (...passed: any[]): void {
  __asDoesNotThrow(passed[0], passed.slice(1), undefined);
};

strict.rejects = function (...passed: any[]): any {
  return __asRejects(passed[0], passed.slice(1), undefined);
};

strict.doesNotReject = function (...passed: any[]): any {
  return __asDoesNotReject(passed[0], passed.slice(1), undefined);
};

strict.match = function (...passed: any[]): void {
  __asInternalMatch(passed[0], passed[1], passed[2], "match", true, undefined);
};

strict.doesNotMatch = function (...passed: any[]): void {
  __asInternalMatch(passed[0], passed[1], passed[2], "doesNotMatch", false, undefined);
};

strict.strict = strict;

assert.strict = strict;

// ---------------------------------------------------------------------------
// assert.Assert (new in Node 25)
// ---------------------------------------------------------------------------
//
// `new Assert({ diff, strict, skipPrototype })` is a configured assertion
// surface: `diff: 'full'` stops the diff collapsing long output, `strict: true`
// (the default) points the loose methods at the strict comparisons, and
// `skipPrototype` compares structure only.
//
// It is a real class, so `new Assert(...)` resolves statically and
// `instance.strictEqual(...)` is ordinary method dispatch. What it cannot do is
// Node's "a destructured method falls back to the defaults" rule: a class
// method cannot be read as a value at all here (zun#19), so
// `const { strictEqual } = new Assert(...)` is `undefined` rather than a
// context-free function. That is the part of
// `test/parallel/test-assert-class-destructuring.js` which is out of reach; see
// ../../test/assert/README.md.
// How many values a caller actually passed, read back from three optional
// parameters. It is what Node gets from the implicit call-value object, with
// one seam: a trailing explicit `undefined` is indistinguishable from an
// omitted value, so `new Assert().strictEqual(undefined)` compares rather than
// raising `ERR_MISSING_ARGS`.
function __asArgCount(a: any, b: any, c: any): number {
  if (c !== undefined) return 3;
  if (b !== undefined) return 2;
  if (a !== undefined) return 1;
  return 0;
}

// The extra values `throws`/`rejects` forward, as the array those helpers want.
function __asRest2(a: any, b: any): any[] {
  if (b !== undefined) return [a, b];
  if (a !== undefined) return [a];
  return [];
}

class Assert {
  AssertionError: any = AssertionError;
  __diff: any = undefined;
  __strict: boolean = true;
  __skipPrototype: boolean = false;

  constructor(options?: any) {
    this.AssertionError = AssertionError;
    const opts: any = options === undefined || options === null ? {} : options;
    const diff: any = opts.diff;
    if (diff !== undefined && diff !== "simple" && diff !== "full") {
      throw new ERR_INVALID_ARG_VALUE(
        "options.diff", diff, "must be one of: 'simple', 'full'",
      );
    }
    this.__diff = diff;
    this.__strict = opts.strict === undefined ? true : (opts.strict ? true : false);
    this.__skipPrototype = opts.skipPrototype ? true : false;
  }

  ok(a?: any, b?: any): void {
    __asInnerOk(__asArgCount(a, b, undefined), a, b);
  }

  fail(a?: any): void {
    __asFail(a, this.__diff);
  }

  equal(a?: any, b?: any, c?: any): void {
    if (this.__strict) {
      __asStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
      return;
    }
    __asEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  notEqual(a?: any, b?: any, c?: any): void {
    if (this.__strict) {
      __asNotStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
      return;
    }
    __asNotEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  deepEqual(a?: any, b?: any, c?: any): void {
    if (this.__strict) {
      __asDeepStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
      return;
    }
    __asDeepEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  notDeepEqual(a?: any, b?: any, c?: any): void {
    if (this.__strict) {
      __asNotDeepStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
      return;
    }
    __asNotDeepEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  strictEqual(a?: any, b?: any, c?: any): void {
    __asStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  notStrictEqual(a?: any, b?: any, c?: any): void {
    __asNotStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  deepStrictEqual(a?: any, b?: any, c?: any): void {
    __asDeepStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  notDeepStrictEqual(a?: any, b?: any, c?: any): void {
    __asNotDeepStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  partialDeepStrictEqual(a?: any, b?: any, c?: any): void {
    __asPartialDeepStrictEqual(a, b, c, __asArgCount(a, b, c), this.__diff);
  }

  ifError(a?: any): void {
    __asIfError(a, this.__diff);
  }

  throws(fn?: any, a?: any, b?: any): void {
    __asThrows(fn, __asRest2(a, b), this.__diff);
  }

  doesNotThrow(fn?: any, a?: any, b?: any): void {
    __asDoesNotThrow(fn, __asRest2(a, b), this.__diff);
  }

  rejects(fn?: any, a?: any, b?: any): any {
    return __asRejects(fn, __asRest2(a, b), this.__diff);
  }

  doesNotReject(fn?: any, a?: any, b?: any): any {
    return __asDoesNotReject(fn, __asRest2(a, b), this.__diff);
  }

  match(a?: any, b?: any, c?: any): void {
    __asInternalMatch(a, b, c, "match", true, this.__diff);
  }

  doesNotMatch(a?: any, b?: any, c?: any): void {
    __asInternalMatch(a, b, c, "doesNotMatch", false, this.__diff);
  }
}

assert.Assert = Assert;
strict.Assert = Assert;

// `node:assert` and `node:assert/strict` module objects for the bundler's
// `require` rewriting. `require('assert/strict')` is `assert.strict` itself,
// which is what Node's own `test-assert.js` asserts.
const __node_assert: any = assert;
const __node_assert_strict: any = strict;

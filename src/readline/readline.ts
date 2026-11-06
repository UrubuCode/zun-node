// node:readline / node:readline/promises — the line-editing interface, the
// keypress decoder and the cursor callbacks, in Zun TypeScript over
// ../stream/stream.ts, ../events/events.ts, ../string_decoder/ and ../timers/.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-readline*.js` files (see
// ../../test/readline/).
//
// ---------------------------------------------------------------------------
// Which Node implementation this follows
// ---------------------------------------------------------------------------
//
// Node 25 splits `readline` across six files, and this one file is all six:
//
//   * `lib/internal/readline/utils.js`     — `CSI`, `charLengthAt`,
//     `charLengthLeft`, `commonPrefix`, `reverseString`, `emitKeys`
//   * `lib/internal/readline/callbacks.js` — `cursorTo`, `moveCursor`,
//     `clearLine`, `clearScreenDown`
//   * `lib/internal/readline/emitKeypressEvents.js`
//   * `lib/internal/readline/interface.js` — `InterfaceConstructor`/`Interface`
//   * `lib/internal/repl/history.js`       — `ReplHistory`, the history manager
//     `Interface` has delegated to since Node 24
//   * `lib/internal/readline/promises.js`  — the `Readline` class
//
// plus `lib/readline.js` and `lib/readline/promises.js`, the two public
// surfaces. All of it is MIT, Copyright Joyent, Inc. and other Node
// contributors; the algorithms below — the escape-sequence state machine, the
// line-ending scanner, the kill ring, the undo/redo stacks, the multiline
// cursor arithmetic — are Node's, transcribed.
//
// The two public `Interface` classes are **not** here: `src/readline/callback.ts`
// and `src/readline/promises.ts` each declare one, named `Interface`, over the
// `__RlInterface` base below. They are two files rather than one because two
// top-level declarations of a name are a compile error in a single Zun program
// and both modules have to bind the name `Interface` (see the bundler note in
// tools/bundle_node_test.sh); no test requires both modules, so the bundler
// inlines exactly one of them.
//
// ---------------------------------------------------------------------------
// What is deliberately not Node's shape
// ---------------------------------------------------------------------------
//
//   * Node keys every internal on a `Symbol` (`kTtyWrite`, `kRefreshLine`, ...)
//     and `lib/readline.js` then re-exposes each one under its historical
//     underscore name (`_ttyWrite`, `_refreshLine`, ...) through an accessor
//     pair. There is no `ObjectDefineProperty`-over-a-prototype model in this
//     engine (zun#25), so the underscore name *is* the method here. That is the
//     name Node documents as the backwards-compatible one, so a subclass that
//     overrides `_ttyWrite` or `_writeToOutput` — which `test-readline-*`
//     and the REPL both do — still works.
//   * `ReplHistory` is memory-only. Its file-backed half (`initialize`,
//     `kFlushHistory`, the `r+` handle) is only ever reached from the REPL,
//     which passes `filePath`; `readline` itself never does, and no test in
//     this corpus exercises it. The navigation, de-duplication and
//     reverse-multiline halves are complete.
//   * `getStringWidth` lives here rather than in src/util/util.ts, next to
//     `stripVTControlCharacters` where Node keeps it, only to keep this track's
//     edits off a file every other module shares. The `internal/util/inspect`
//     module object at the bottom hands out both.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * **A class method cannot be read as a value** (zun#19): `typeof
//     input.setRawMode === 'function'` answers `"undefined"` for a method a
//     class declared, which is exactly how Node's own test fakes spell their
//     streams (`class FakeInput extends EventEmitter { resume() {} ... }`).
//     Every duck test here is therefore `name in obj` — which *does* see a class
//     method — and every optional call goes through `__rlTryCall`, which calls
//     it and catches the `TypeError` a genuinely absent method raises.
//   * **`new ns.Ctor()` does not reach the constructor** (zun#18), so the two
//     `Interface` classes must be top-level names the bundler can rewrite
//     `readline.Interface` to; see the file split above.
//   * **A function's `.length` is always 0** in this engine, so Node's
//     `completer.length !== 2` — the test that tells a callback-style completer
//     from a value-returning one — cannot be made. `_tabComplete` instead calls
//     the completer *with* a callback and also uses its return value when it is
//     not `undefined`: a two-argument completer calls the callback and returns
//     `undefined`, a one-argument one ignores the extra argument and returns the
//     value (or a promise). Both shapes are served by one call, and the timing
//     matches Node's — synchronous for the callback form, a microtask later for
//     the promise form.
//   * **A function written into a class instance field is silently discarded**
//     (zun#78/#17), which is what `this.completer = comp` is. The three
//     function-valued fields (`completer`, `_questionCallback`,
//     `_questionReject`) therefore go through `__rlStoreFn`, which boxes them;
//     see that helper. Before it existed the tab key inserted a literal `\t`,
//     because `this.completer` read back `undefined`.
//   * **No regular expressions at all.** A `RegExp` read out of a module-level
//     `const` from inside a function or a method has lost every one of its
//     methods ("exec is not a function"), which is the `any` half of zun#7, so
//     a regex may only be created and consumed in the same top-level scope.
//     Rebuilding one per keystroke is the only alternative, so Node's six
//     patterns are hand-written scans here — the two `cmd` grammars, the
//     line-ending scanner and the three word-boundary ones. The line-ending one
//     also cannot be written as a *literal*, because U+2028 and U+2029 are line
//     terminators in source text.
//   * **A `const` holding a function expression is not hoisted**, so a closure
//     that mentions a name declared below it raises "<name> is not defined"
//     whenever it runs. Node's mutually recursive handlers
//     (`onData`/`onNewListener` in `emitKeypressEvents`, the four in
//     `__rlLineIterator`) are `let` bindings assigned in order instead.
//   * **A `number`-typed class field initialized from a module-level
//     `const x: number` is stored boxed**, and the first read panics the
//     interpreter ("expected float, found Any { tag: Float }"). The three
//     numeric fields with a named default (`_size`, `crlfDelay`,
//     `escapeCodeTimeout`) are initialized with the literal. The same shape
//     bites a conditional expression assigned to such a field, which is why
//     `MathMax(kMincrlfDelay, crlfDelay)` is spelled out as an `if`.
//   * **`const { 0: a, 1: b } = value` answers null** for an array-like, so
//     `_tabCompleter` indexes its argument instead of destructuring it.
//   * **`x.m.apply(x, args)` is unreachable** — the read is `undefined`
//     (zun#19), a spread argument list does not lower for a method call, and a
//     field cannot hold the function either — so `__rlApply` unrolls the list
//     into a dynamic call of fixed arity (capped at six by zun#10), and
//     `tools/bundle_node_test.sh` rewrites that spelling in a test body to a
//     call of it.
//   * `__cc` (../util/util.ts) rather than `charCodeAt` wherever the index may
//     be out of range (zun#2).
//   * `Number(x.length)` on every length and index (zun#3).
//   * The keypress decoder's per-stream state lives in a `Map` keyed by the
//     stream, not in expando properties on the caller's stream object: an
//     undeclared key written through `any` onto a typed instance poisons every
//     later typed read of it (zun#37). `WeakMap` is unusable (zun#28).

// ---------------------------------------------------------------------------
// CSI — the escape-sequence builder
// ---------------------------------------------------------------------------
//
// Node's `CSI` is a template tag that also carries the four canned sequences as
// properties. It is a real `function` declaration here, not a `const` holding
// one: a tagged-template call through an `any`-typed binding loses the
// substitution arguments in this engine, and `test-readline-csi.js` asserts
// `CSI`1${2}3`` is `'\x1b[123'`.
const __RL_ESCAPE: string = "\u{1b}";

function CSI(strings: any, ...args: any[]): string {
  let ret: string = __RL_ESCAPE + "[";
  const count = Number(strings.length);
  const argc = Number(args.length);
  for (let n = 0; n < count; n++) {
    ret = ret + String(strings[n]);
    if (n < argc) ret = ret + String(args[n]);
  }
  return ret;
}

// The sequences, spelled out rather than built through the tag, so that the
// properties below do not depend on the tag's own call lane.
const __RL_CLEAR_TO_LINE_BEGINNING: string = __RL_ESCAPE + "[1K";
const __RL_CLEAR_TO_LINE_END: string = __RL_ESCAPE + "[0K";
const __RL_CLEAR_LINE: string = __RL_ESCAPE + "[2K";
const __RL_CLEAR_SCREEN_DOWN: string = __RL_ESCAPE + "[0J";

CSI.kEscape = __RL_ESCAPE;
CSI.kClearToLineBeginning = __RL_CLEAR_TO_LINE_BEGINNING;
CSI.kClearToLineEnd = __RL_CLEAR_TO_LINE_END;
CSI.kClearLine = __RL_CLEAR_LINE;
CSI.kClearScreenDown = __RL_CLEAR_SCREEN_DOWN;

// `CSI`${x}G`` and the three other shapes the module builds, as plain calls.
function __rlCsiCol(x: number): string {
  return __RL_ESCAPE + "[" + String(x) + "G";
}
function __rlCsiRowCol(y: number, x: number): string {
  return __RL_ESCAPE + "[" + String(y) + ";" + String(x) + "H";
}
function __rlCsiMove(n: number, letter: string): string {
  return __RL_ESCAPE + "[" + String(n) + letter;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// The three shared bases (`NodeError`, `NodeTypeError`, `NodeRangeError`) and
// `ERR_INVALID_ARG_TYPE` / `ERR_INVALID_ARG_VALUE` / `ERR_OUT_OF_RANGE` /
// `AbortError` come from ../events/events.ts; the two readline-only codes are
// here.
class ERR_USE_AFTER_CLOSE extends NodeError {
  constructor(name: string) {
    super("ERR_USE_AFTER_CLOSE", name + " was closed");
  }
}

class ERR_INVALID_CURSOR_POS extends NodeTypeError {
  constructor() {
    super(
      "ERR_INVALID_CURSOR_POS",
      "Cannot set cursor row without setting its column",
    );
  }
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

// Is `name` reachable on `obj` at all? `typeof obj[name] === "function"` is not
// usable: a method a class declared reads back as `undefined` (zun#19), while
// `name in obj` sees it. Both spellings are tried, because a *field* holding an
// arrow function (`write = (d) => {...}`, which three of Node's test fakes use)
// is found by either.
function __rlHas(obj: any, name: string): boolean {
  if (obj === null || obj === undefined) return false;
  const kind = typeof obj;
  if (kind !== "object" && kind !== "function") return false;
  if (typeof obj[name] === "function") return true;
  return name in obj;
}

function __rlIsFn(value: any): boolean {
  return typeof __evUnbox(value) === "function";
}

// A function on its way into a class instance **field**.
//
// A function written into a declared `any` field of a class instance is
// silently discarded in this engine (https://github.com/UrubuCode/zun/issues/78
// and #17): the field keeps its old value, so `this.completer = comp` leaves
// `undefined` and the tab key falls through to inserting a literal `\t`.
// `__evBox` (../events/events.ts) routes the function through a one-element
// array and hands back the `functionBox` *record*, which is an object — and an
// object does survive a field. It is truthy, `__rlIsFn` sees through it and
// `__evCall` unwraps it to call, so the three function-valued fields here
// (`completer`, `_questionCallback`, `_questionReject`) read and behave exactly
// as Node's do.
function __rlStoreFn(fn: any): any {
  if (fn === null || fn === undefined) return fn;
  return __evBox(fn);
}

// Call `obj.name(...)` when there is something to call, and swallow the
// `TypeError` the engine raises when there is not. Node guards each of these
// with `typeof ... === 'function'`, which zun#19 makes unusable.
function __rlTryCall0(obj: any, name: string): any {
  if (!__rlHas(obj, name)) return undefined;
  return obj[name]();
}
function __rlTryCall1(obj: any, name: string, a: any): any {
  if (!__rlHas(obj, name)) return undefined;
  return obj[name](a);
}

// `obj.method.apply(obj, args)`.
//
// Neither half of that expression works in this engine: a method a class
// declared cannot be read as a value (zun#19, so `obj.method` is `undefined`),
// and a spread argument list is not lowered for a method call either ("spread
// arguments are not lowered yet"), so `obj.method(...args)` is a compile error
// too. What does work is a dynamic method call with a fixed argument count, so
// the list is unrolled. Six is the ceiling because a dynamic call with seven or
// more arguments does not compile (zun#10).
//
// `tools/bundle_node_test.sh` rewrites `x.m.apply(x, args)` in a test body to a
// call of this, for the same reason; see the rule's comment there.
function __rlApply(recv: any, name: string, args: any): any {
  const list: any = args === undefined || args === null ? [] : args;
  const n = Number(list.length);
  if (n === 0) return recv[name]();
  if (n === 1) return recv[name](list[0]);
  if (n === 2) return recv[name](list[0], list[1]);
  if (n === 3) return recv[name](list[0], list[1], list[2]);
  if (n === 4) return recv[name](list[0], list[1], list[2], list[3]);
  if (n === 5) return recv[name](list[0], list[1], list[2], list[3], list[4]);
  return recv[name](list[0], list[1], list[2], list[3], list[4], list[5]);
}

// `lib/internal/validators.js`, the four this module uses.
function __rlValidateString(value: any, name: string): void {
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }
}

function __rlValidateFunction(value: any, name: string): void {
  if (!__rlIsFn(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "function", value);
  }
}

function __rlValidateInteger(value: any, name: string, min?: any, max?: any): void {
  const low = min === undefined ? -9007199254740991 : Number(min);
  const high = max === undefined ? 9007199254740991 : Number(max);
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < low || value > high) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(low) + " && <= " + String(high),
      value,
    );
  }
}

function __rlValidateUint32(value: any, name: string, positive?: any): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  const min = positive === true ? 1 : 0;
  if (value < min || value > 4294967295) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(min) + " && <= 4294967295",
      value,
    );
  }
}

function __rlValidateArray(value: any, name: string): void {
  if (!Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
  }
}

function __rlValidateNumber(value: any, name: string, min: number): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (Number.isNaN(value) || value < min) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(min) + " && <= 9007199254740991",
      value,
    );
  }
}

function __rlValidateAbortSignal(signal: any, name: string): void {
  if (signal === undefined || signal === null) return;
  if (typeof signal !== "object" || typeof signal.aborted !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE(name, "AbortSignal", signal);
  }
}

// ---------------------------------------------------------------------------
// String width — `internal/util/inspect`'s `getStringWidth`
// ---------------------------------------------------------------------------
//
// Node's build has ICU and uses `icu.getStringWidth`; the pure-JavaScript
// fallback in the very same file is what this is, and the two agree on every
// code point this corpus measures (`あ` 2, `𐐷` 1, `🐕` 2, `丁` 2, the combining
// marks 0). NFC normalization is applied when the engine has
// `String.prototype.normalize` and skipped when it does not — a combining mark
// counts 0 either way, so the width is the same.
function __rlIsZeroWidthCodePoint(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f) ||
    (code >= 0xe0100 && code <= 0xe01ef)
  );
}

function __rlIsFullWidthCodePoint(code: number): boolean {
  if (code < 0x1100) return false;
  return (
    code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) ||
    (code >= 0x3250 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0xa4c6) ||
    (code >= 0xa960 && code <= 0xa97c) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6b) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1b000 && code <= 0x1b001) ||
    (code >= 0x1f200 && code <= 0x1f251) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

function __rlNormalize(text: string): string {
  const value: any = text;
  if (!__rlHas(value, "normalize")) return text;
  const normalized: any = value.normalize("NFC");
  return typeof normalized === "string" ? normalized : text;
}

function __rlStringWidth(str: any, removeControlChars?: any): number {
  let text: string = typeof str === "string" ? str : String(str);
  if (removeControlChars === undefined || removeControlChars === true) {
    text = stripVTControlCharacters(text);
  }
  text = __rlNormalize(text);
  let width = 0;
  for (const char of text) {
    const value: any = char;
    const code = Number(value.codePointAt(0));
    if (__rlIsFullWidthCodePoint(code)) {
      width = width + 2;
    } else if (!__rlIsZeroWidthCodePoint(code)) {
      width = width + 1;
    }
  }
  return width;
}

// ---------------------------------------------------------------------------
// `internal/readline/utils`' character arithmetic
// ---------------------------------------------------------------------------

const __RL_SURROGATE_THRESHOLD: number = 0x10000;

function __rlCodePointAt(str: string, i: number): number {
  const value: any = str;
  const code: any = value.codePointAt(i);
  return code === undefined ? 0 : Number(code);
}

// The number of UTF-16 units making up the character to the *left* of `i`.
function charLengthLeft(str: any, i: any): number {
  const text: string = typeof str === "string" ? str : String(str);
  const at = Number(i);
  if (at <= 0) return 0;
  if (
    (at > 1 && __rlCodePointAt(text, at - 2) >= __RL_SURROGATE_THRESHOLD) ||
    __rlCodePointAt(text, at - 1) >= __RL_SURROGATE_THRESHOLD
  ) {
    return 2;
  }
  return 1;
}

// The number of UTF-16 units making up the character *at* `i`. Past the end it
// answers 1, which is what lets the cursor move right while completing.
function charLengthAt(str: any, i: any): number {
  const text: string = typeof str === "string" ? str : String(str);
  const at = Number(i);
  if (Number(text.length) <= at) return 1;
  return __rlCodePointAt(text, at) >= __RL_SURROGATE_THRESHOLD ? 2 : 1;
}

// The longest common prefix of a list of strings, in O(n log n).
function commonPrefix(strings: any): string {
  const count = Number(strings.length);
  if (count === 0) return "";
  if (count === 1) return String(strings[0]);
  const sorted: any[] = [];
  for (let i = 0; i < count; i++) sorted.push(String(strings[i]));
  sorted.sort();
  const min: string = sorted[0];
  const max: string = sorted[Number(sorted.length) - 1];
  const limit = Number(min.length);
  for (let i = 0; i < limit; i++) {
    if (min.charAt(i) !== max.charAt(i)) return min.slice(0, i);
  }
  return min;
}

// A multiline history entry is stored with its lines in reverse order and `\r`
// where the newlines were, so that it occupies one line of a history file.
function reverseString(line: any, from?: any, to?: any): string {
  const text: string = typeof line === "string" ? line : String(line);
  const sep: string = from === undefined ? "\r" : String(from);
  const join: string = to === undefined ? "\r" : String(to);
  const parts: any[] = text.split(sep);
  let result = "";
  for (let i = Number(parts.length) - 1; i > 0; i--) {
    result = result + String(parts[i]) + join;
  }
  return result + String(parts[0]);
}

// ---------------------------------------------------------------------------
// `emitKeys` — the escape-sequence state machine
// ---------------------------------------------------------------------------
//
// A generator driven one character at a time by `emitKeypressEvents`'s data
// handler, exactly as in Node. It emits `keypress` on the stream it was handed.
//
// Patterns seen in terminal key escape codes, from Node's own comment (derived
// from midnight-commander's lib/tty/key.c):
//
//   ESC letter / ESC [ letter / ESC [ modifier letter / ESC [ 1 ; modifier
//   letter / ESC [ num char / ESC [ num ; modifier char / ESC O letter /
//   ESC O modifier letter / ESC O 1 ; modifier letter / ESC N letter /
//   ESC [ [ num ; modifier char / ESC [ [ 1 ; modifier letter /
//   ESC ESC [ num char / ESC ESC O letter
//
//   - char is usually `~`, but `$` and `^` also happen with rxvt
//   - modifier is 1 + (shift * 1) + (left_alt * 2) + (ctrl * 4) +
//     (right_alt * 8)
//   - two leading ESCs mean the same as one
// ---------------------------------------------------------------------------
// Character classes and the two escape-sequence grammars, without regexes
// ---------------------------------------------------------------------------
//
// Node spells all of this with regular expressions. A `RegExp` here may only be
// *created and consumed in the same top-level scope*: read out of a
// module-level `const` from inside a function or a method it has lost every one
// of its methods ("exec is not a function"), which is the `any` half of
// https://github.com/UrubuCode/zun/issues/7. Rebuilding one per keystroke and
// per line chunk is the only alternative, and these grammars are small enough
// that a scan is both cheaper and clearer — the posture src/punycode and
// src/querystring already take.

function __rlIsDigitCode(c: number): boolean {
  return c >= 48 && c <= 57;
}

// The `\w` class, `[A-Za-z0-9_]`.
function __rlIsWordCode(c: number): boolean {
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 95
  );
}

// The `\s` class: ECMAScript WhiteSpace plus LineTerminator.
function __rlIsSpaceCode(c: number): boolean {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 0x85) return false;
  return (
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

// `/^[0-9A-Za-z]$/` and `/^[A-Z]$/` over a single character. The length test is
// the `^...$` anchoring: a surrogate pair is two units and matches neither.
function __rlIsAlnumChar(ch: any): boolean {
  if (typeof ch !== "string" || Number(ch.length) !== 1) return false;
  const c = __cc(ch, 0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function __rlIsUpperChar(ch: any): boolean {
  if (typeof ch !== "string" || Number(ch.length) !== 1) return false;
  const c = __cc(ch, 0);
  return c >= 65 && c <= 90;
}

// Node's first `cmd` grammar, `/^(?:(\d\d?)(?:;(\d))?([~^$])|(\d{3}~))$/`.
// Answers null, or a record: `three` for the bracketed-paste form (three
// digits and a tilde, which carries no modifier), otherwise `digits`, the
// optional `modifier` digit and the `final` character.
function __rlParseCmdTilde(cmd: string): any {
  const n = Number(cmd.length);
  // The `\d{3}~` alternative. The regex tries the other one first, but that one
  // cannot match a four-character all-digits-then-tilde string (after one or
  // two digits the next character is neither `;` nor a final), so testing this
  // one first answers the same.
  if (
    n === 4 && cmd.charAt(3) === "~" &&
    __rlIsDigitCode(__cc(cmd, 0)) && __rlIsDigitCode(__cc(cmd, 1)) &&
    __rlIsDigitCode(__cc(cmd, 2))
  ) {
    return { three: cmd, digits: "", modifier: null, final: "" };
  }
  let i = 0;
  if (i >= n || !__rlIsDigitCode(__cc(cmd, i))) return null;
  i = i + 1;
  if (i < n && __rlIsDigitCode(__cc(cmd, i))) i = i + 1;
  const digits: string = cmd.slice(0, i);
  let modifier: any = null;
  if (i < n && cmd.charAt(i) === ";") {
    i = i + 1;
    if (i >= n || !__rlIsDigitCode(__cc(cmd, i))) return null;
    modifier = cmd.charAt(i);
    i = i + 1;
  }
  if (i >= n) return null;
  const fin: string = cmd.charAt(i);
  if (fin !== "~" && fin !== "^" && fin !== "$") return null;
  if (i + 1 !== n) return null;
  return { three: null, digits: digits, modifier: modifier, final: fin };
}

// Node's second `cmd` grammar, `/^((\d;)?(\d))?([A-Za-z])$/`: one letter,
// optionally preceded by a digit or by `<digit>;<digit>`. Answers null, or the
// trailing `letter` and the `(\d)` group as `digit`.
function __rlParseCmdLetter(cmd: string): any {
  const n = Number(cmd.length);
  if (n === 0) return null;
  const last: string = cmd.charAt(n - 1);
  const code = __cc(last, 0);
  if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) return null;
  const head: string = cmd.slice(0, n - 1);
  const h = Number(head.length);
  if (h === 0) return { digit: null, letter: last };
  if (h === 1 && __rlIsDigitCode(__cc(head, 0))) {
    return { digit: head, letter: last };
  }
  if (
    h === 3 && __rlIsDigitCode(__cc(head, 0)) && head.charAt(1) === ";" &&
    __rlIsDigitCode(__cc(head, 2))
  ) {
    return { digit: head.charAt(2), letter: last };
  }
  return null;
}

// `switch (code)` over 90 cases is one table lookup here: a plain object whose
// values are `[name, ctrl, shift]`, because a 90-arm `switch` on a string costs
// a linear scan in the Tier-0 interpreter and this runs once per keystroke.
const __rlKeyNames: any = {
  "[P": "f1", "[Q": "f2", "[R": "f3", "[S": "f4",
  "OP": "f1", "OQ": "f2", "OR": "f3", "OS": "f4",
  "[11~": "f1", "[12~": "f2", "[13~": "f3", "[14~": "f4",
  "[200~": "paste-start", "[201~": "paste-end",
  "[[A": "f1", "[[B": "f2", "[[C": "f3", "[[D": "f4", "[[E": "f5",
  "[15~": "f5", "[17~": "f6", "[18~": "f7", "[19~": "f8",
  "[20~": "f9", "[21~": "f10", "[23~": "f11", "[24~": "f12",
  "[A": "up", "[B": "down", "[C": "right", "[D": "left",
  "[E": "clear", "[F": "end", "[H": "home",
  "OA": "up", "OB": "down", "OC": "right", "OD": "left",
  "OE": "clear", "OF": "end", "OH": "home",
  "[1~": "home", "[2~": "insert", "[3~": "delete", "[4~": "end",
  "[5~": "pageup", "[6~": "pagedown",
  "[[5~": "pageup", "[[6~": "pagedown",
  "[7~": "home", "[8~": "end",
};

// The sequences that additionally force `shift`.
const __rlKeyNamesShift: any = {
  "[a": "up", "[b": "down", "[c": "right", "[d": "left", "[e": "clear",
  "[2$": "insert", "[3$": "delete", "[5$": "pageup", "[6$": "pagedown",
  "[7$": "home", "[8$": "end",
  "[Z": "tab",
};

// The sequences that additionally force `ctrl`.
const __rlKeyNamesCtrl: any = {
  "Oa": "up", "Ob": "down", "Oc": "right", "Od": "left", "Oe": "clear",
  "[2^": "insert", "[3^": "delete", "[5^": "pageup", "[6^": "pagedown",
  "[7^": "home", "[8^": "end",
};

function __rlIsDigit(ch: any): boolean {
  return typeof ch === "string" && ch >= "0" && ch <= "9";
}

function* emitKeys(stream: any): any {
  while (true) {
    let ch: any = yield;
    let s: any = ch;
    let escaped = false;
    const key: any = {
      sequence: null,
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
    };

    if (ch === __RL_ESCAPE) {
      escaped = true;
      ch = yield;
      s = s + ch;
      if (ch === __RL_ESCAPE) {
        ch = yield;
        s = s + ch;
      }
    }

    if (escaped && (ch === "O" || ch === "[")) {
      // ANSI escape sequence.
      let code: string = ch;
      let modifier = 0;

      if (ch === "O") {
        // ESC O letter, ESC O modifier letter.
        ch = yield;
        s = s + ch;
        if (__rlIsDigit(ch)) {
          modifier = (Number(ch) >> 0) - 1;
          ch = yield;
          s = s + ch;
        }
        code = code + String(ch);
      } else {
        // ESC [ letter, ESC [ modifier letter, ESC [ [ modifier letter,
        // ESC [ [ num char.
        ch = yield;
        s = s + ch;

        if (ch === "[") {
          // `\x1b[[A` — escape codes might have a second bracket.
          code = code + String(ch);
          ch = yield;
          s = s + ch;
        }

        // Buffer just enough to get a complete ASCII sequence. Two classes:
        //   1. `\x1b[24;5~` is `{ code: '[24~', modifier: 5 }` (Ctrl+F12 in
        //      xterm); `;5` is optional, the first part is one or two digits,
        //      and three digits with no modifier is bracketed-paste mode, so
        //      the pattern is /^(?:\d\d?(;\d)?[~^$]|\d{3}~)$/.
        //   2. `\x1b[1;5H` is `{ code: '[H', modifier: 5 }` (Ctrl+Home in
        //      xterm); `1;5` is optional and so is `1;`, so the pattern is
        //      /^((\d;)?\d)?[A-Za-z]$/.
        const cmdStart = Number(s.length) - 1;

        if (__rlIsDigit(ch)) {
          ch = yield;
          s = s + ch;
          if (__rlIsDigit(ch)) {
            ch = yield;
            s = s + ch;
            if (__rlIsDigit(ch)) {
              ch = yield;
              s = s + ch;
            }
          }
        }

        if (ch === ";") {
          ch = yield;
          s = s + ch;
          if (__rlIsDigit(ch)) {
            s = s + (yield);
          }
        }

        const cmd: string = String(s).slice(cmdStart);
        const tilde: any = __rlParseCmdTilde(cmd);
        if (tilde !== null) {
          if (tilde.three) {
            code = code + String(tilde.three);
          } else {
            code = code + String(tilde.digits) + String(tilde.final);
            modifier = Number(tilde.modifier === null ? 1 : tilde.modifier) - 1;
          }
        } else {
          const letter: any = __rlParseCmdLetter(cmd);
          if (letter !== null) {
            code = code + String(letter.letter);
            modifier = Number(letter.digit === null ? 1 : letter.digit) - 1;
          } else {
            code = code + cmd;
          }
        }
      }

      // The key modifier.
      key.ctrl = (modifier & 4) !== 0;
      key.meta = (modifier & 10) !== 0;
      key.shift = (modifier & 1) !== 0;
      key.code = code;

      // The key itself.
      const plain: any = __rlKeyNames[code];
      const shifted: any = __rlKeyNamesShift[code];
      const ctrled: any = __rlKeyNamesCtrl[code];
      if (plain !== undefined) {
        key.name = plain;
      } else if (shifted !== undefined) {
        key.name = shifted;
        key.shift = true;
      } else if (ctrled !== undefined) {
        key.name = ctrled;
        key.ctrl = true;
      } else {
        key.name = "undefined";
      }
    } else if (ch === "\r") {
      key.name = "return";
      key.meta = escaped;
    } else if (ch === "\n") {
      // Enter; should have been called linefeed.
      key.name = "enter";
      key.meta = escaped;
    } else if (ch === "\t") {
      key.name = "tab";
      key.meta = escaped;
    } else if (ch === "\b" || ch === "\u{7f}") {
      // Backspace or ctrl+h.
      key.name = "backspace";
      key.meta = escaped;
    } else if (ch === __RL_ESCAPE) {
      key.name = "escape";
      key.meta = escaped;
    } else if (ch === " ") {
      key.name = "space";
      key.meta = escaped;
    } else if (!escaped && typeof ch === "string" && ch <= "\u{1a}") {
      // ctrl+letter.
      key.name = String.fromCharCode(__cc(ch, 0) + __cc("a", 0) - 1);
      key.ctrl = true;
    } else if (__rlIsAlnumChar(ch)) {
      // Letter, number, shift+letter.
      key.name = ch.toLowerCase();
      key.shift = __rlIsUpperChar(ch);
      key.meta = escaped;
    } else if (escaped) {
      // Escape-sequence timeout.
      key.name = Number(ch.length) ? undefined : "escape";
      key.meta = true;
    }

    key.sequence = s;

    if (Number(s.length) !== 0 && (key.name !== undefined || escaped)) {
      // Named character or sequence.
      stream.emit("keypress", escaped ? undefined : s, key);
    } else if (charLengthAt(s, 0) === Number(s.length)) {
      // Single unnamed character, e.g. ".".
      stream.emit("keypress", s, key);
    }
    // Unrecognized or broken escape sequence: emit nothing.
  }
}

// ---------------------------------------------------------------------------
// `internal/readline/callbacks` — the four cursor writers
// ---------------------------------------------------------------------------

function __rlNextTickCallback(callback: any): void {
  if (__rlIsFn(callback)) process.nextTick(callback, null);
}

function cursorTo(stream: any, x?: any, y?: any, callback?: any): boolean {
  let cb: any = callback;
  if (cb !== undefined) __rlValidateFunction(cb, "callback");
  if (__rlIsFn(y)) {
    cb = y;
    y = undefined;
  }
  if (Number.isNaN(x)) throw new ERR_INVALID_ARG_VALUE("x", x, "is invalid");
  if (Number.isNaN(y)) throw new ERR_INVALID_ARG_VALUE("y", y, "is invalid");

  if (
    stream === null || stream === undefined ||
    (typeof x !== "number" && typeof y !== "number")
  ) {
    __rlNextTickCallback(cb);
    return true;
  }

  if (typeof x !== "number") throw new ERR_INVALID_CURSOR_POS();

  const data: string = typeof y !== "number"
    ? __rlCsiCol(Number(x) + 1)
    : __rlCsiRowCol(Number(y) + 1, Number(x) + 1);
  return __rlStreamWrite(stream, data, cb);
}

function moveCursor(stream: any, dx?: any, dy?: any, callback?: any): boolean {
  if (callback !== undefined) __rlValidateFunction(callback, "callback");
  if (stream === null || stream === undefined || !(dx || dy)) {
    __rlNextTickCallback(callback);
    return true;
  }

  let data = "";
  if (dx < 0) {
    data = data + __rlCsiMove(-Number(dx), "D");
  } else if (dx > 0) {
    data = data + __rlCsiMove(Number(dx), "C");
  }
  if (dy < 0) {
    data = data + __rlCsiMove(-Number(dy), "A");
  } else if (dy > 0) {
    data = data + __rlCsiMove(Number(dy), "B");
  }
  return __rlStreamWrite(stream, data, callback);
}

function clearLine(stream: any, dir?: any, callback?: any): boolean {
  if (callback !== undefined) __rlValidateFunction(callback, "callback");
  if (stream === null || stream === undefined) {
    __rlNextTickCallback(callback);
    return true;
  }
  const type: string = dir < 0
    ? __RL_CLEAR_TO_LINE_BEGINNING
    : dir > 0 ? __RL_CLEAR_TO_LINE_END : __RL_CLEAR_LINE;
  return __rlStreamWrite(stream, type, callback);
}

function clearScreenDown(stream: any, callback?: any): boolean {
  if (callback !== undefined) __rlValidateFunction(callback, "callback");
  if (stream === null || stream === undefined) {
    __rlNextTickCallback(callback);
    return true;
  }
  return __rlStreamWrite(stream, __RL_CLEAR_SCREEN_DOWN, callback);
}

// `stream.write(data, cb)`. Node passes the callback straight through; a stream
// that does not take one (the `write() {}` of Node's own test fakes) would drop
// it, so the two-argument call is tried first and the callback is run here when
// the stream answered without taking it.
function __rlStreamWrite(stream: any, data: string, callback?: any): boolean {
  if (callback === undefined || callback === null) {
    const result: any = stream.write(data);
    return result === false ? false : true;
  }
  const result: any = stream.write(data, callback);
  return result === false ? false : true;
}

// ---------------------------------------------------------------------------
// `emitKeypressEvents`
// ---------------------------------------------------------------------------
//
// One record per stream, in a `Map` rather than in expando properties on the
// stream itself (zun#37, zun#28). The record is deliberately *kept* across
// `Interface` instances over one input: `test-readline-reopen.js` writes one
// third of a three-byte character, closes the interface, opens another over the
// same stream and expects the remaining two bytes to complete the character —
// which only works when the decoder survives, exactly as the early return on
// `stream[KEYPRESS_DECODER]` makes it in Node.
const __RL_ESCAPE_CODE_TIMEOUT: number = 500;
const __rlKeypressStates: any = new Map();

function emitKeypressEvents(stream: any, iface?: any): void {
  if (__rlKeypressStates.get(stream) !== undefined) return;

  const target: any = iface === undefined ? {} : iface;
  const state: any = {
    decoder: new StringDecoder("utf8"),
    escape: undefined,
    timeoutId: undefined,
  };
  __rlKeypressStates.set(stream, state);

  state.escape = emitKeys(stream);
  state.escape.next();

  const triggerEscape: any = function (): void {
    state.escape.next("");
  };

  let escapeCodeTimeout: any = target.escapeCodeTimeout;
  if (escapeCodeTimeout === undefined) escapeCodeTimeout = __RL_ESCAPE_CODE_TIMEOUT;

  // `onData` and `onNewListener` name each other. Node spells both as hoisted
  // `function` declarations; a `const` holding a function expression is not
  // hoisted here, so the forward reference raised "onNewListener is not
  // defined" at run time. Two `let` bindings assigned in order, captured by
  // reference, are the same thing.
  let onData: any = undefined;
  let onNewListener: any = undefined;

  onData = function (input: any): void {
    if (Number(stream.listenerCount("keypress")) > 0) {
      const string: any = state.decoder.write(input);
      if (string) {
        if (state.timeoutId !== undefined) {
          clearTimeout(state.timeoutId);
          state.timeoutId = undefined;
        }

        // This supports characters of length 2.
        __rlNoteKeypress(target, charLengthAt(string, 0) === Number(string.length), false);

        let length = 0;
        for (const character of string) {
          length = length + Number(character.length);
          if (length === Number(string.length)) {
            __rlSetCompletionEnabled(target, true);
          }
          try {
            state.escape.next(character);
            // An escape letter at the tail position waits for the rest.
            if (length === Number(string.length) && character === __RL_ESCAPE) {
              state.timeoutId = setTimeout(triggerEscape, escapeCodeTimeout);
            }
          } catch (err) {
            // The generator threw — which can happen inside the `keypress`
            // listener — so it has to be restarted.
            state.escape = emitKeys(stream);
            state.escape.next();
            throw err;
          }
        }
      }
    } else {
      // Nobody is watching anyway.
      stream.removeListener("data", onData);
      stream.on("newListener", onNewListener);
    }
  };

  onNewListener = function (event: any): void {
    if (event === "keypress") {
      stream.on("data", onData);
      stream.removeListener("newListener", onNewListener);
    }
  };

  if (Number(stream.listenerCount("keypress")) > 0) {
    stream.on("data", onData);
  } else {
    stream.on("newListener", onNewListener);
  }
}

// `iface[kSawKeyPress] = ...; iface.isCompletionEnabled = ...` in Node. Both
// names are declared fields on `__RlInterface`, so the write is a declared-field
// write rather than an expando (zun#37); a plain `{}` iface — which
// `readline.emitKeypressEvents(stream)` passes — takes them as ordinary keys.
function __rlNoteKeypress(iface: any, sawKeyPress: boolean, completionEnabled: boolean): void {
  iface._sawKeyPress = sawKeyPress;
  iface.isCompletionEnabled = completionEnabled;
}

function __rlSetCompletionEnabled(iface: any, value: boolean): void {
  iface.isCompletionEnabled = value;
}

// ---------------------------------------------------------------------------
// The history manager — `internal/repl/history`' `ReplHistory`, memory half
// ---------------------------------------------------------------------------

const __RL_HISTORY_SIZE: number = 30;

class __RlHistory {
  context: any;
  _history: any[] = [];
  // The literal, not `__RL_HISTORY_SIZE`: a `number`-typed class field whose
  // initializer is a module-level `const x: number` is stored *boxed*, and the
  // first read panics the interpreter ("expected float, found Any { tag:
  // Float }"). The same applies to `crlfDelay` and `escapeCodeTimeout` on
  // `__RlInterface` below.
  _size: number = 30;
  _index: number = -1;
  _removeDuplicates: boolean = false;

  constructor(context: any, options: any) {
    const opts: any = options === undefined || options === null ? {} : options;
    if (opts.history !== undefined) __rlValidateArray(opts.history, "history");
    if (opts.size !== undefined) __rlValidateNumber(opts.size, "size", 0);

    this.context = context;
    this._removeDuplicates = opts.removeHistoryDuplicates === true;
    let size: any = opts.size;
    if (size === undefined || size === null) size = __RL_HISTORY_SIZE;
    this._size = Number(size);
    const history: any = opts.history;
    this._history = history === undefined || history === null ? [] : history;
    this._index = -1;
  }

  get size(): number {
    return this._size;
  }
  get isFlushing(): boolean {
    return false;
  }
  get history(): any {
    return this._history;
  }
  set history(value: any) {
    this._history = value;
  }
  get index(): number {
    return this._index;
  }
  set index(value: any) {
    this._index = Number(value);
  }

  addHistory(isMultiline: boolean, lastCommandErrored: any): string {
    const context: any = this.context;
    const line: string = String(context.line);

    if (Number(line.length) === 0) return "";
    // History disabled: hand the line back unrecorded.
    if (this._size === 0) return line;
    if (Number(line.trim().length) === 0) return line;

    // Each line of a multiline entry would otherwise be saved on its own while
    // the entry is being built, which is not wanted; and a line that is being
    // edited to fix an error replaces the broken one.
    if (isMultiline && this._index === -1) {
      this._history.shift();
    } else if (lastCommandErrored) {
      this._history.shift();
    }

    const normalizedLine: string = reverseString(line, "\n", "\r");

    if (Number(this._history.length) === 0 || this._history[0] !== normalizedLine) {
      if (this._removeDuplicates) {
        // Remove an older identical entry.
        const dupIndex = Number(this._history.indexOf(line));
        if (dupIndex !== -1) this._history.splice(dupIndex, 1);
      }
      this._history.unshift(normalizedLine);
      if (Number(this._history.length) > this._size) this._history.pop();
    }

    this._index = -1;

    const finalLine: string = isMultiline
      ? reverseString(this._history[0])
      : String(this._history[0]);

    // A listener may change the history object — to drop an entry that should
    // not be persisted, such as a password — so the event comes before the
    // line is handed back.
    context.emit("history", this._history);

    return finalLine;
  }

  canNavigateToNext(): boolean {
    return this._index > -1 && Number(this._history.length) > 0;
  }

  navigateToNext(substringSearch?: any): any {
    if (!this.canNavigateToNext()) return null;
    const search: string = substringSearch ? String(substringSearch) : "";
    let index = this._index - 1;
    const context: any = this.context;
    while (
      index >= 0 &&
      (!String(this._history[index]).startsWith(search) ||
        context.line === this._history[index])
    ) {
      index = index - 1;
    }
    this._index = index;
    if (index === -1) return search;
    return reverseString(this._history[index], "\r", "\n");
  }

  canNavigateToPrevious(): boolean {
    return Number(this._history.length) !== this._index && Number(this._history.length) > 0;
  }

  navigateToPrevious(substringSearch?: any): any {
    if (!this.canNavigateToPrevious()) return null;
    const search: string = substringSearch ? String(substringSearch) : "";
    let index = this._index + 1;
    const context: any = this.context;
    const total = Number(this._history.length);
    while (
      index < total &&
      (!String(this._history[index]).startsWith(search) ||
        context.line === this._history[index])
    ) {
      index = index + 1;
    }
    this._index = index;
    if (index === total) return search;
    return reverseString(this._history[index], "\r", "\n");
  }
}

// ---------------------------------------------------------------------------
// The line-ending scanner
// ---------------------------------------------------------------------------
//
// The end of a line is any of `\r\n`, `\n`, `\r` not followed by `\n`,
// U+2028 LINE SEPARATOR or U+2029 PARAGRAPH SEPARATOR. Node's
// `/\r?\n|\r(?!\n)|U+2028|U+2029/g`, as a scan — for the regex reason in the
// character-class section above (zun#7), and because the two separators cannot
// be written into a regex *literal* by the tooling that maintains this file
// (they are line terminators in source text, and the escape is normalized to
// the character itself on the way in).

// The length of the line ending that starts at `i`, or 0 when none does.
function __rlLineEndingAt(text: string, i: number): number {
  const c = __cc(text, i);
  if (c === 13) return __cc(text, i + 1) === 10 ? 2 : 1;
  if (c === 10) return 1;
  if (c === 0x2028 || c === 0x2029) return 1;
  return 0;
}

// The index of the next line ending at or after `from`, or -1.
function __rlFindLineEnding(text: string, from: number): number {
  const n = Number(text.length);
  for (let i = from; i < n; i++) {
    if (__rlLineEndingAt(text, i) > 0) return i;
  }
  return -1;
}

// `/^\s*(?:[^\w\s]+|\w+)?/`, as a length: the whitespace then one run of either
// word or non-word-non-space characters.
function __rlWordLeftLength(text: string): number {
  const n = Number(text.length);
  let i = 0;
  while (i < n && __rlIsSpaceCode(__cc(text, i))) i = i + 1;
  if (i < n) {
    const c = __cc(text, i);
    if (__rlIsWordCode(c)) {
      while (i < n && __rlIsWordCode(__cc(text, i))) i = i + 1;
    } else if (!__rlIsSpaceCode(c)) {
      while (i < n) {
        const d = __cc(text, i);
        if (__rlIsWordCode(d) || __rlIsSpaceCode(d)) break;
        i = i + 1;
      }
    }
  }
  return i;
}

// `/^(?:\s+|[^\w\s]+|\w+)\s*/`, as a length.
function __rlWordRightLength(text: string): number {
  const n = Number(text.length);
  if (n === 0) return 0;
  let i = 0;
  const c = __cc(text, 0);
  if (__rlIsSpaceCode(c)) {
    while (i < n && __rlIsSpaceCode(__cc(text, i))) i = i + 1;
    return i;
  }
  if (__rlIsWordCode(c)) {
    while (i < n && __rlIsWordCode(__cc(text, i))) i = i + 1;
  } else {
    while (i < n) {
      const d = __cc(text, i);
      if (__rlIsWordCode(d) || __rlIsSpaceCode(d)) break;
      i = i + 1;
    }
  }
  while (i < n && __rlIsSpaceCode(__cc(text, i))) i = i + 1;
  return i;
}

// `/^(?:\s+|\W+|\w+)\s*/`, as a length. `\W` is the complement of `\w`, so the
// middle alternative swallows whitespace too — which is what makes this one
// differ from `__rlWordRightLength`.
function __rlWordRightDeleteLength(text: string): number {
  const n = Number(text.length);
  if (n === 0) return 0;
  let i = 0;
  const c = __cc(text, 0);
  if (__rlIsSpaceCode(c)) {
    while (i < n && __rlIsSpaceCode(__cc(text, i))) i = i + 1;
    return i;
  }
  if (__rlIsWordCode(c)) {
    while (i < n && __rlIsWordCode(__cc(text, i))) i = i + 1;
  } else {
    while (i < n && !__rlIsWordCode(__cc(text, i))) i = i + 1;
  }
  while (i < n && __rlIsSpaceCode(__cc(text, i))) i = i + 1;
  return i;
}

const __RL_MAX_UNDO_REDO_STACK_SIZE: number = 2048;
const __RL_MIN_CRLF_DELAY: number = 100;
const __RL_MAX_KILL_RING: number = 32;
const __RL_MULTILINE_PROMPT: string = "| ";

// ---------------------------------------------------------------------------
// The async line iterator — `events.on(rl, 'line', ...)` with kFirstEventParam
// ---------------------------------------------------------------------------
//
// `events.on` in ../events/events.ts always yields the argument *list* and has
// no `nodejs.watermarkData` accessor, and readline needs both the bare first
// argument (`kFirstEventParam`) and that accessor, which
// `test-readline-async-iterators-backpressure.js` reads. So the iterator is
// here, built on the same algorithm: queue while nobody is awaiting, pause the
// emitter above the high watermark, resume below the low one.
const __RL_LINE_HIGH_WATERMARK: number = 1024;

function __rlLineIterator(emitter: any): any {
  const highWatermark: number = __RL_LINE_HIGH_WATERMARK;
  const lowWatermark: number = 1;
  const state: any = {
    events: [],
    promises: [],
    finished: false,
    error: null,
    paused: false,
    size: 0,
  };

  // The four handlers name each other, and a `const` holding a function
  // expression is not hoisted in this engine: a closure that mentions a name
  // declared below it raises "<name> is not defined" when it runs, however late
  // that is. So each is a `let` declared up front and assigned in order.
  let removeAll: any = undefined;
  let closeHandler: any = undefined;
  let errorHandler: any = undefined;
  let lineHandler: any = undefined;

  removeAll = function (): void {
    emitter.removeListener("line", lineHandler);
    emitter.removeListener("error", errorHandler);
    emitter.removeListener("close", closeHandler);
  };

  closeHandler = function (): any {
    removeAll();
    state.finished = true;
    const done: any = { value: undefined, done: true };
    while (Number(state.promises.length) > 0) {
      const pending: any = state.promises.shift();
      __evCall(pending.resolve, [done]);
    }
    return Promise.resolve(done);
  };

  errorHandler = function (err: any): void {
    if (Number(state.promises.length) === 0) {
      state.error = err;
    } else {
      const pending: any = state.promises.shift();
      __evCall(pending.reject, [err]);
    }
    closeHandler();
  };

  lineHandler = function (value: any): void {
    if (Number(state.promises.length) === 0) {
      state.size = Number(state.size) + 1;
      if (!state.paused && Number(state.size) > highWatermark) {
        state.paused = true;
        __rlTryCall0(emitter, "pause");
      }
      state.events.push(value);
    } else {
      const pending: any = state.promises.shift();
      __evCall(pending.resolve, [{ value: value, done: false }]);
    }
  };

  emitter.on("line", lineHandler);
  emitter.on("error", errorHandler);
  emitter.on("close", closeHandler);

  const watermarkData: any = {
    get high(): number {
      return highWatermark;
    },
    get low(): number {
      return lowWatermark;
    },
    get isPaused(): boolean {
      return state.paused === true;
    },
    get size(): number {
      return Number(state.size);
    },
  };

  const iterator: any = {
    next(): any {
      if (Number(state.size) > 0) {
        const value: any = state.events.shift();
        state.size = Number(state.size) - 1;
        if (state.paused && Number(state.size) < lowWatermark) {
          // The flag is cleared *before* the resume, where Node clears it
          // after. `Readable.prototype.resume` schedules its flow on the next
          // tick in Node, but delivers the next buffered chunk synchronously
          // here — so with Node's order `lineHandler` would run while `paused`
          // was still true, set it true again for the new backlog, pause the
          // stream, and then have the flag overwritten with false by the line
          // below. The iterator would believe the stream was flowing while it
          // was paused, and would never resume it again.
          state.paused = false;
          __rlTryCall0(emitter, "resume");
        }
        return Promise.resolve({ value: value, done: false });
      }
      if (state.error !== null && state.error !== undefined) {
        const rejected: any = Promise.reject(state.error);
        state.error = null;
        return rejected;
      }
      if (state.finished) return closeHandler();
      return new Promise(function (resolve: any, reject: any): void {
        state.promises.push({ resolve: resolve, reject: reject });
      });
    },
    return(): any {
      return closeHandler();
    },
    throw(err: any): void {
      errorHandler(err);
    },
    [Symbol.asyncIterator](): any {
      return this;
    },
  };
  iterator[Symbol.for("nodejs.watermarkData")] = watermarkData;
  return iterator;
}

// ---------------------------------------------------------------------------
// `__RlInterface` — `InterfaceConstructor` + `Interface`
// ---------------------------------------------------------------------------

class __RlInterface extends EventEmitter {
  // Public surface.
  line: any = "";
  cursor: number = 0;
  input: any = undefined;
  output: any = undefined;
  terminal: boolean = false;
  completer: any = undefined;
  crlfDelay: number = 100;
  escapeCodeTimeout: number = 500;
  tabSize: number = 8;
  isCompletionEnabled: boolean = true;
  closed: boolean = false;
  paused: boolean = false;
  prevRows: number = 0;
  historyManager: any = undefined;


  // Node's symbol-keyed internals, under the underscore names `lib/readline.js`
  // re-exposes them with.
  _prompt: string = "> ";
  _oldPrompt: any = undefined;
  _sawReturnAt: number = 0;
  _sawKeyPress: boolean = false;
  _previousKey: any = null;
  _questionCallback: any = null;
  _questionReject: any = null;
  _lineBuffer: any = null;
  _decoder: any = null;
  _undoStack: any[] = [];
  _redoStack: any[] = [];
  _killRing: any[] = [];
  _killRingCursor: number = 0;
  _yanking: boolean = false;
  _substringSearch: any = null;
  _isMultiline: boolean = false;
  _previousCursorCols: number = -1;
  _previousLine: any = "";
  _previousCursor: number = 0;
  _previousPrevRows: number = 0;
  _lineObjectStream: any = undefined;
  _lastCommandErrored: any = undefined;

  constructor(input?: any, output?: any, completer?: any, terminal?: any) {
    super();
    this._init(input, output, completer, terminal);
  }

  // `InterfaceConstructor`. A method rather than inline constructor code so
  // that the two public subclasses share one body without `FunctionPrototypeCall`
  // (which cannot thread a receiver here).
  _init(input?: any, output?: any, completer?: any, terminal?: any): void {
    const self: any = this;
    let inp: any = input;
    let out: any = output;
    let comp: any = completer;
    let term: any = terminal;


    let crlfDelay: any = undefined;
    let prompt: any = "> ";
    let signal: any = undefined;
    let historyOptions: any = {};

    if (inp !== null && inp !== undefined && inp.input) {
      // An options object was given.
      out = inp.output;
      comp = inp.completer;
      term = inp.terminal;
      signal = inp.signal;

      const historySize: any = inp.historySize;
      const history: any = inp.history;
      const removeHistoryDuplicates: any = inp.removeHistoryDuplicates;

      if (inp.tabSize !== undefined) {
        __rlValidateUint32(inp.tabSize, "tabSize", true);
        this.tabSize = Number(inp.tabSize);
      }
      if (inp.prompt !== undefined) prompt = inp.prompt;
      if (inp.escapeCodeTimeout !== undefined) {
        if (Number.isFinite(inp.escapeCodeTimeout)) {
          this.escapeCodeTimeout = Number(inp.escapeCodeTimeout);
        } else {
          throw new ERR_INVALID_ARG_VALUE(
            "input.escapeCodeTimeout",
            this.escapeCodeTimeout,
            "is invalid",
          );
        }
      }
      if (signal) __rlValidateAbortSignal(signal, "options.signal");

      crlfDelay = inp.crlfDelay;
      inp = inp.input;

      // Node stashes the three history options on the input stream and reads
      // them back out of it in `setupHistoryManager`. They go into a record of
      // their own here instead: an expando write through `any` onto the
      // caller's stream poisons every later typed read of it (zun#37), and the
      // record is exactly as observable.
      historyOptions = {
        size: historySize,
        history: history,
        removeHistoryDuplicates: removeHistoryDuplicates,
      };
    }

    this.historyManager = new __RlHistory(this, historyOptions);

    if (comp !== undefined && !__rlIsFn(comp)) {
      throw new ERR_INVALID_ARG_VALUE("completer", comp, "is invalid");
    }

    // Backwards compat: check the output stream's `isTTY` when `terminal` was
    // not specified.
    if (term === undefined && !(out === null || out === undefined)) {
      term = out.isTTY ? true : false;
    }

    this.line = "";
    this._isMultiline = false;
    this._substringSearch = null;
    this.output = out;
    this.input = inp;
    this._undoStack = [];
    this._redoStack = [];
    this._previousCursorCols = -1;

    // The kill ring is a list of blocks of text that were previously killed
    // (deleted). Above `__RL_MAX_KILL_RING` entries the oldest is dropped. It
    // is what lets a user recall (yank) or cycle (yank pop) killed text, as in
    // Emacs.
    this._killRing = [];
    this._killRingCursor = 0;

    // `MathMax(kMincrlfDelay, crlfDelay)`, spelled out: a conditional whose
    // arms are a `number` const and an `any` call result reaches a `number`
    // field as a *boxed* float and panics the interpreter ("expected float,
    // found Any { tag: Float }"), so each arm is kept a plain `number`.
    let delay: number = __RL_MIN_CRLF_DELAY;
    if (crlfDelay) {
      const given: number = Number(crlfDelay);
      if (given > __RL_MIN_CRLF_DELAY) delay = given;
    }
    this.crlfDelay = delay;
    this.completer = __rlStoreFn(comp);

    this.setPrompt(prompt);

    this.terminal = term ? true : false;

    const onerror: any = function (err: any): void {
      self.emit("error", err);
    };
    const ondata: any = function (data: any): void {
      self._normalWrite(data);
    };
    const onend: any = function (): void {
      if (
        typeof self._lineBuffer === "string" &&
        Number(self._lineBuffer.length) > 0
      ) {
        self.emit("line", self._lineBuffer);
      }
      self.close();
    };
    const ontermend: any = function (): void {
      if (typeof self.line === "string" && Number(self.line.length) > 0) {
        self.emit("line", self.line);
      }
      self.close();
    };
    const onkeypress: any = function (s: any, key: any): void {
      self._ttyWrite(s, key);
      if (key && key.sequence) {
        // Half of a surrogate pair needs the line refreshed so that the
        // character is displayed.
        const ch = __rlCodePointAt(String(key.sequence), 0);
        if (ch >= 0xd800 && ch <= 0xdfff) self._refreshLine();
      }
    };
    const onresize: any = function (): void {
      self._refreshLine();
    };

    this._lineObjectStream = undefined;

    inp.on("error", onerror);

    if (!this.terminal) {
      const onSelfCloseWithoutTerminal: any = function (): void {
        inp.removeListener("data", ondata);
        inp.removeListener("error", onerror);
        inp.removeListener("end", onend);
      };
      inp.on("data", ondata);
      inp.on("end", onend);
      self.once("close", onSelfCloseWithoutTerminal);
      this._decoder = new StringDecoder("utf8");
    } else {
      const onSelfCloseWithTerminal: any = function (): void {
        inp.removeListener("keypress", onkeypress);
        inp.removeListener("error", onerror);
        inp.removeListener("end", ontermend);
        if (out !== null && out !== undefined) {
          out.removeListener("resize", onresize);
        }
      };

      emitKeypressEvents(inp, this);

      // `input` usually refers to stdin.
      inp.on("keypress", onkeypress);
      inp.on("end", ontermend);

      this._setRawMode(true);
      this.terminal = true;

      // Cursor position on the line.
      this.cursor = 0;

      if (out !== null && out !== undefined) out.on("resize", onresize);

      self.once("close", onSelfCloseWithTerminal);
    }

    if (signal) {
      const onAborted: any = function (): void {
        self.close();
      };
      if (signal.aborted) {
        process.nextTick(onAborted);
      } else {
        const disposable: any = __eventsAddAbortListener(signal, onAborted);
        self.once("close", function (): void {
          const dispose: any = disposable.dispose;
          if (__rlIsFn(dispose)) __evCall(dispose, []);
        });
      }
    }

    // Current line.
    this._setLine("");

    __rlTryCall0(inp, "resume");
  }

  get columns(): any {
    const out: any = this.output;
    if (out !== null && out !== undefined && out.columns) return out.columns;
    return Infinity;
  }

  // Sets the prompt written to the output.
  setPrompt(prompt: any): void {
    this._prompt = prompt;
  }

  // The current prompt used by `rl.prompt()`.
  getPrompt(): any {
    return this._prompt;
  }

  get history(): any {
    return this.historyManager.history;
  }
  set history(value: any) {
    this.historyManager.history = value;
  }
  get historyIndex(): any {
    return this.historyManager.index;
  }
  set historyIndex(value: any) {
    this.historyManager.index = value;
  }
  get historySize(): any {
    return this.historyManager.size;
  }
  get isFlushing(): any {
    return this.historyManager.isFlushing;
  }

  _setRawMode(mode: any): any {
    const inp: any = this.input;
    const wasInRawMode: any = inp === null || inp === undefined ? undefined : inp.isRaw;
    __rlTryCall1(inp, "setRawMode", mode);
    return wasInRawMode;
  }

  // Writes the configured prompt to a new line in the output.
  prompt(preserveCursor?: any): void {
    if (this.paused) this.resume();
    if (this.terminal && process.env.TERM !== "dumb") {
      if (!preserveCursor) this.cursor = 0;
      this._refreshLine();
    } else {
      this._writeToOutput(this._prompt);
    }
  }

  // `kQuestion`: the shared half of both modules' `question`.
  _question(query: any, cb: any): void {
    if (this.closed) throw new ERR_USE_AFTER_CLOSE("readline");
    if (this._questionCallback) {
      this.prompt();
    } else {
      this._oldPrompt = this._prompt;
      this.setPrompt(query);
      this._questionCallback = __rlStoreFn(cb);
      this.prompt();
    }
  }

  _questionCancel(): void {
    if (this._questionCallback) {
      this._questionCallback = null;
      this.setPrompt(this._oldPrompt);
      this.clearLine();
    }
  }

  _setLine(line?: any): void {
    const value: any = line === undefined ? "" : line;
    this.line = value;
    this._isMultiline = String(value).includes("\n");
  }

  _onLine(line: any): void {
    if (this._questionCallback) {
      const cb: any = this._questionCallback;
      this._questionCallback = null;
      this.setPrompt(this._oldPrompt);
      __evCall(cb, [line]);
    } else {
      this.emit("line", line);
    }
  }

  _beforeEdit(oldText: any, oldCursor: any): void {
    this._pushToUndoStack(oldText, oldCursor);
  }

  _writeToOutput(stringToWrite: any): void {
    __rlValidateString(stringToWrite, "stringToWrite");
    if (this.output !== null && this.output !== undefined) {
      this.output.write(stringToWrite);
    }
  }

  _addHistory(): string {
    return this.historyManager.addHistory(this._isMultiline, this._lastCommandErrored);
  }

  _refreshLine(): void {
    // Line length.
    const line: string = String(this._prompt) + String(this.line);
    const dispPos: any = this._getDisplayPos(line);
    const lineCols: number = Number(dispPos.cols);
    const lineRows: number = Number(dispPos.rows);

    // Cursor position.
    const cursorPos: any = this.getCursorPos();

    // First move to the bottom of the current line, based on the cursor
    // position.
    const prevRows: number = Number(this.prevRows || 0);
    if (prevRows > 0) moveCursor(this.output, 0, -prevRows);

    // Cursor to the left edge, then erase.
    cursorTo(this.output, 0);
    clearScreenDown(this.output);

    if (this._isMultiline) {
      const lines: any[] = String(this.line).split("\n");
      // The first line carries the normal prompt.
      this._writeToOutput(String(this._prompt) + String(lines[0]));
      // Continuation lines carry the `| ` prefix.
      const count = Number(lines.length);
      for (let i = 1; i < count; i++) {
        this._writeToOutput("\n" + __RL_MULTILINE_PROMPT + String(lines[i]));
      }
    } else {
      this._writeToOutput(line);
    }

    // Force the terminal to allocate a new line.
    if (lineCols === 0) this._writeToOutput(" ");

    // Move the cursor back to where it was.
    cursorTo(this.output, Number(cursorPos.cols));

    const diff = lineRows - Number(cursorPos.rows);
    if (diff > 0) moveCursor(this.output, 0, -diff);

    this.prevRows = Number(cursorPos.rows);
  }

  // Closes the interface.
  close(): void {
    if (this.closed) return;
    this.pause();
    if (this.terminal) this._setRawMode(false);
    this.closed = true;
    this.emit("close");
  }

  // Pauses the input stream.
  pause(): any {
    if (this.closed) throw new ERR_USE_AFTER_CLOSE("readline");
    if (this.paused) return undefined;
    __rlTryCall0(this.input, "pause");
    this.paused = true;
    this.emit("pause");
    return this;
  }

  // Resumes the input stream if paused.
  resume(): any {
    if (this.closed) throw new ERR_USE_AFTER_CLOSE("readline");
    if (!this.paused) return undefined;
    __rlTryCall0(this.input, "resume");
    this.paused = false;
    this.emit("resume");
    return this;
  }

  // Writes either `d` or the key sequence identified by `key`.
  //
  // `test-readline.js` reaches this as a value — `rl.write.apply(rl, key.home)`
  // — and a method a class declared cannot be read back as one in this engine
  // (zun#19), while a *field* holding a function reads back `undefined`
  // outright. `tools/bundle_node_test.sh` therefore rewrites
  // `x.m.apply(x, args)` to `x.m(...args)`, which is the same call; see the
  // rule's comment there.
  write(d?: any, key?: any): void {
    if (this.closed) throw new ERR_USE_AFTER_CLOSE("readline");
    if (this.paused) this.resume();
    if (this.terminal) {
      this._ttyWrite(d, key);
    } else {
      this._normalWrite(d);
    }
  }

  _normalWrite(b: any): void {
    if (b === undefined) return;
    let string: string = String(this._decoder.write(b));
    if (this._sawReturnAt && Number(Date.now()) - this._sawReturnAt <= this.crlfDelay) {
      if (__rlCodePointAt(string, 0) === 10) string = string.slice(1);
      this._sawReturnAt = 0;
    }

    // Run the scan over the new chunk, not over the whole line buffer.
    let first = __rlFindLineEnding(string, 0);
    if (first !== -1) {
      if (this._lineBuffer) {
        string = String(this._lineBuffer) + string;
        this._lineBuffer = null;
        // Start the search from the beginning of the joined string.
        first = __rlFindLineEnding(string, 0);
      }
      this._sawReturnAt = string.endsWith("\r") ? Number(Date.now()) : 0;

      // `[0, start1, end1, start2, end2, ...]`, Node's `indexes`.
      const indexes: number[] = [0];
      let at = first;
      while (at !== -1) {
        const len = __rlLineEndingAt(string, at);
        indexes.push(at);
        indexes.push(at + len);
        at = __rlFindLineEnding(string, at + len);
      }
      const lastIndex = Number(indexes.length) - 1;
      // Either "" or the unfinished portion of the next line.
      this._lineBuffer = string.slice(indexes[lastIndex]);
      for (let i = 1; i < lastIndex; i = i + 2) {
        this._onLine(string.slice(indexes[i - 1], indexes[i]));
      }
    } else if (string) {
      // No newlines this time; save what there is for next time.
      if (this._lineBuffer) {
        this._lineBuffer = String(this._lineBuffer) + String(string);
      } else {
        this._lineBuffer = string;
      }
    }
  }

  _insertString(c: any): void {
    this._beforeEdit(this.line, this.cursor);
    const text: string = String(c);
    if (!this.isCompletionEnabled) {
      this.line = String(this.line) + text;
      this.cursor = this.cursor + Number(text.length);
      this._writeToOutput(text);
      return;
    }
    if (this.cursor < Number(String(this.line).length)) {
      const beg: string = String(this.line).slice(0, this.cursor);
      const end: string = String(this.line).slice(this.cursor, Number(String(this.line).length));
      this._setLine(beg + text + end);
      this.cursor = this.cursor + Number(text.length);
      this._refreshLine();
    } else {
      const oldPos: any = this.getCursorPos();
      this.line = String(this.line) + text;
      this.cursor = this.cursor + Number(text.length);
      const newPos: any = this.getCursorPos();
      if (Number(oldPos.rows) < Number(newPos.rows)) {
        this._refreshLine();
      } else {
        this._writeToOutput(text);
      }
    }
  }

  // Tab completion.
  //
  // Node has two of these: `internal/readline/interface`'s `async kTabComplete`,
  // which awaits `completer(string)`, and `lib/readline.js`' `_tabComplete`,
  // which calls `completer(string, cb)` — the legacy callback shape. Which one
  // runs is decided by `completer.length !== 2` in the constructor, and a
  // function's `.length` is 0 in this engine, so the two are served by one
  // body: the completer is called *with* a callback and its return value is
  // used when it is not `undefined`. A callback completer therefore settles
  // synchronously (as in `lib/readline.js`) and a value-or-promise completer a
  // microtask later (as in the promises module).
  _tabComplete(lastKeypressWasTab: any): void {
    const self: any = this;
    this.pause();
    const string: string = String(this.line).slice(0, this.cursor);
    let settled = false;

    const finish: any = function (err: any, value: any): void {
      if (settled) return;
      settled = true;
      self.resume();
      if (err !== null && err !== undefined) {
        self._writeToOutput("Tab completion error: " + __evInspect(err));
        return;
      }
      self._tabCompleter(lastKeypressWasTab, value);
    };

    let returned: any = undefined;
    try {
      returned = __evCall(this.completer, [string, function (err: any, value: any): void {
        finish(err, value);
      }]);
    } catch (err) {
      finish(err, undefined);
      return;
    }
    if (settled || returned === undefined) return;
    Promise.resolve(returned).then(
      function (value: any): void {
        finish(null, value);
      },
      function (err: any): void {
        finish(err === null || err === undefined ? new Error("Tab completion failed") : err, undefined);
      },
    );
  }

  _tabCompleter(lastKeypressWasTab: any, value: any): void {
    if (value === null || value === undefined) return;
    // `const { 0: completions, 1: completeOn } = value` answers null for an
    // array-like in this engine, so the two are indexed out.
    const completions: any = value[0];
    const completeOn: any = value[1];

    if (!completions || Number(completions.length) === 0) return;

    // Apply the common prefix of all matches, if there is one.
    const nonEmpty: any[] = [];
    const total = Number(completions.length);
    for (let i = 0; i < total; i++) {
      if (completions[i] !== "") nonEmpty.push(completions[i]);
    }
    const prefix: string = commonPrefix(nonEmpty);
    const on: string = String(completeOn);
    if (prefix.startsWith(on) && Number(prefix.length) > Number(on.length)) {
      this._insertString(prefix.slice(Number(on.length)));
      return;
    } else if (!on.startsWith(prefix)) {
      this._setLine(
        String(this.line).slice(0, this.cursor - Number(on.length)) +
          prefix +
          String(this.line).slice(this.cursor, Number(String(this.line).length)),
      );
      this.cursor = this.cursor - Number(on.length) + Number(prefix.length);
      this._refreshLine();
      return;
    }

    if (!lastKeypressWasTab) return;

    this._beforeEdit(this.line, this.cursor);

    // Show the completions.
    const completionsWidth: number[] = [];
    for (let i = 0; i < total; i++) {
      completionsWidth.push(__rlStringWidth(completions[i]));
    }
    let widest = 0;
    for (let i = 0; i < total; i++) {
      if (completionsWidth[i] > widest) widest = completionsWidth[i];
    }
    const width = widest + 2; // Two spaces of padding.
    let maxColumns: any = Math.floor(Number(this.columns) / width) || 1;
    if (maxColumns === Infinity) maxColumns = 1;

    let output = "\r\n";
    let lineIndex = 0;
    let whitespace = 0;
    for (let i = 0; i < total; i++) {
      const completion: any = completions[i];
      if (completion === "" || lineIndex === maxColumns) {
        output = output + "\r\n";
        lineIndex = 0;
        whitespace = 0;
      } else {
        output = output + " ".repeat(whitespace);
      }
      if (completion !== "") {
        output = output + String(completion);
        whitespace = width - completionsWidth[i];
        lineIndex = lineIndex + 1;
      } else {
        output = output + "\r\n";
      }
    }
    if (lineIndex !== 0) output = output + "\r\n\r\n";
    this._writeToOutput(output);
    this._refreshLine();
  }

  _wordLeft(): void {
    if (this.cursor > 0) {
      // Reverse the string and match a word near the beginning, to avoid
      // quadratic time.
      const leading: string = String(this.line).slice(0, this.cursor);
      const reversed: string = __rlReverse(leading);
      this._moveCursor(-__rlWordLeftLength(reversed));
    }
  }

  _wordRight(): void {
    if (this.cursor < Number(String(this.line).length)) {
      const trailing: string = String(this.line).slice(this.cursor);
      this._moveCursor(__rlWordRightLength(trailing));
    }
  }

  _deleteLeft(): void {
    if (this.cursor > 0 && Number(String(this.line).length) > 0) {
      this._beforeEdit(this.line, this.cursor);
      const charSize = charLengthLeft(this.line, this.cursor);
      this.line =
        String(this.line).slice(0, this.cursor - charSize) +
        String(this.line).slice(this.cursor, Number(String(this.line).length));
      this.cursor = this.cursor - charSize;
      this._refreshLine();
    }
  }

  _deleteRight(): void {
    if (this.cursor < Number(String(this.line).length)) {
      this._beforeEdit(this.line, this.cursor);
      const charSize = charLengthAt(this.line, this.cursor);
      this.line =
        String(this.line).slice(0, this.cursor) +
        String(this.line).slice(this.cursor + charSize, Number(String(this.line).length));
      this._refreshLine();
    }
  }

  _deleteWordLeft(): void {
    if (this.cursor > 0) {
      this._beforeEdit(this.line, this.cursor);
      let leading: string = String(this.line).slice(0, this.cursor);
      const reversed: string = __rlReverse(leading);
      leading = leading.slice(0, Number(leading.length) - __rlWordLeftLength(reversed));
      this.line = leading + String(this.line).slice(this.cursor, Number(String(this.line).length));
      this.cursor = Number(leading.length);
      this._refreshLine();
    }
  }

  _deleteWordRight(): void {
    if (this.cursor < Number(String(this.line).length)) {
      this._beforeEdit(this.line, this.cursor);
      const trailing: string = String(this.line).slice(this.cursor);
      this.line =
        String(this.line).slice(0, this.cursor) +
        trailing.slice(__rlWordRightDeleteLength(trailing));
      this._refreshLine();
    }
  }

  _deleteLineLeft(): void {
    this._beforeEdit(this.line, this.cursor);
    const del: string = String(this.line).slice(0, this.cursor);
    this._setLine(String(this.line).slice(this.cursor));
    this.cursor = 0;
    this._pushToKillRing(del);
    this._refreshLine();
  }

  _deleteLineRight(): void {
    this._beforeEdit(this.line, this.cursor);
    const del: string = String(this.line).slice(this.cursor);
    this._setLine(String(this.line).slice(0, this.cursor));
    this._pushToKillRing(del);
    this._refreshLine();
  }

  _pushToKillRing(del: any): void {
    if (!del || del === this._killRing[0]) return;
    this._killRing.unshift(del);
    this._killRingCursor = 0;
    while (Number(this._killRing.length) > __RL_MAX_KILL_RING) this._killRing.pop();
  }

  _yank(): void {
    if (Number(this._killRing.length) > 0) {
      this._yanking = true;
      this._insertString(this._killRing[this._killRingCursor]);
    }
  }

  _yankPop(): void {
    if (!this._yanking) return;
    if (Number(this._killRing.length) > 1) {
      const lastYank: string = String(this._killRing[this._killRingCursor]);
      this._killRingCursor = this._killRingCursor + 1;
      if (this._killRingCursor >= Number(this._killRing.length)) {
        this._killRingCursor = 0;
      }
      const currentYank: string = String(this._killRing[this._killRingCursor]);
      const head: string = String(this.line).slice(0, this.cursor - Number(lastYank.length));
      const tail: string = String(this.line).slice(this.cursor);
      this._setLine(head + currentYank + tail);
      this.cursor = Number(head.length) + Number(currentYank.length);
      this._refreshLine();
    }
  }

  _savePreviousState(): void {
    this._previousLine = this.line;
    this._previousCursor = this.cursor;
    this._previousPrevRows = this.prevRows;
  }

  _restorePreviousState(): void {
    this._setLine(this._previousLine);
    this.cursor = this._previousCursor;
    this.prevRows = this._previousPrevRows;
  }

  clearLine(): void {
    this._moveCursor(Infinity);
    this._writeToOutput("\r\n");
    this._setLine("");
    this.cursor = 0;
    this.prevRows = 0;
  }

  _line(): void {
    this._savePreviousState();
    const line: any = this._addHistory();
    this._undoStack = [];
    this._redoStack = [];
    this.clearLine();
    this._onLine(line);
  }

  // Adds a newline in the middle of a complete multiline entry. Only used when
  // the output is a TTY; when it is called the real cursor sits at the very end
  // of the whole string, no matter where the newline was entered.
  _addNewLineOnTTY(): void {
    this._restorePreviousState();
    const originalLine: string = String(this.line);

    const beforeCursor: string = String(this.line).slice(0, this.cursor);
    let afterCursor: string = String(this.line).slice(this.cursor, Number(String(this.line).length));

    this._setLine(beforeCursor + "\n" + afterCursor);
    this.cursor = this.cursor + 1;

    const hasContentAfterCursor = Number(afterCursor.length) > 0;
    const cursorIsNotOnFirstLine = this.prevRows > 0;
    let needsRewriteFirstLine = false;

    if (hasContentAfterCursor) {
      const splitBeg: any[] = beforeCursor.split("\n");
      needsRewriteFirstLine = Number(splitBeg.length) < 2;

      if (cursorIsNotOnFirstLine) {
        const splitEnd: any[] = afterCursor.split("\n");
        // The cursor was at least on the second line, so the whole line it was
        // on has to be rewritten — it may have been split in the middle. Reach
        // the line above the current one, coming from the end.
        const dy = Number(splitEnd.length) + 1;
        const above: any = splitBeg[Number(splitBeg.length) - 2];
        const dxEndOfLineAbove =
          Number(String(above === undefined || above === null ? "" : above).length) +
          Number(__RL_MULTILINE_PROMPT.length);
        moveCursor(this.output, dxEndOfLineAbove, -dy);
        afterCursor = String(splitBeg[Number(splitBeg.length) - 1]) + "\n" + afterCursor;
      } else {
        const dy = Number(originalLine.split("\n").length);
        moveCursor(this.output, 0, -dy);
      }

      clearScreenDown(this.output);

      if (cursorIsNotOnFirstLine) this._writeToOutput("\n");
    }

    if (needsRewriteFirstLine) {
      this._writeToOutput(
        String(this._prompt) + beforeCursor + "\n" + __RL_MULTILINE_PROMPT,
      );
    } else {
      this._writeToOutput(__RL_MULTILINE_PROMPT);
    }

    if (hasContentAfterCursor) {
      const oldCursor: any = this.getCursorPos();
      const formattedEndContent: string = afterCursor.split("\n").join(
        "\n" + __RL_MULTILINE_PROMPT,
      );
      this._writeToOutput(formattedEndContent);
      const newCursor: any = this._getDisplayPos(this.line);
      moveCursor(
        this.output,
        Number(oldCursor.cols) - Number(newCursor.cols),
        Number(oldCursor.rows) - Number(newCursor.rows),
      );
      this.prevRows = Number(oldCursor.rows);
    } else {
      this.prevRows = Number(String(this.line).split("\n").length) - 1;
    }
  }

  _pushToUndoStack(text: any, cursor: any): void {
    this._undoStack.push({ text: text, cursor: cursor });
    if (Number(this._undoStack.length) > __RL_MAX_UNDO_REDO_STACK_SIZE) {
      this._undoStack.shift();
    }
  }

  _undo(): void {
    if (Number(this._undoStack.length) <= 0) return;
    this._redoStack.push({ text: this.line, cursor: this.cursor });
    const entry: any = this._undoStack.pop();
    this._setLine(entry.text);
    this.cursor = Number(entry.cursor);
    this._refreshLine();
  }

  _redo(): void {
    if (Number(this._redoStack.length) <= 0) return;
    this._undoStack.push({ text: this.line, cursor: this.cursor });
    const entry: any = this._redoStack.pop();
    this._setLine(entry.text);
    this.cursor = Number(entry.cursor);
    this._refreshLine();
  }

  _multilineMove(direction: number, splitLines: any, rows: number, cols: number): void {
    const curr: string = String(splitLines[rows]);
    const down = direction === 1;
    const adj: string = String(splitLines[rows + direction]);
    const promptLen = Number(__RL_MULTILINE_PROMPT.length);
    let amountToMove = 0;
    // Clamp the distance to end of current + prompt + next/prev line + newline.
    const clamp = down
      ? Number(curr.length) - cols + promptLen + Number(adj.length) + 1
      : -cols + 1;
    const shouldClamp = cols > Number(adj.length) + 1;

    if (shouldClamp) {
      if (this._previousCursorCols === -1) this._previousCursorCols = cols;
      amountToMove = clamp;
    } else {
      if (down) {
        amountToMove = Number(curr.length) + 1;
      } else {
        amountToMove = -Number(adj.length) - 1;
      }
      if (this._previousCursorCols !== -1) {
        if (this._previousCursorCols <= Number(adj.length)) {
          amountToMove = amountToMove + this._previousCursorCols - cols;
          this._previousCursorCols = -1;
        } else {
          amountToMove = clamp;
        }
      }
    }

    this._moveCursor(amountToMove);
  }

  _moveDownOrHistoryNext(): void {
    const cursorPos: any = this.getCursorPos();
    const splitLines: any[] = String(this.line).split("\n");
    if (this._isMultiline && Number(cursorPos.rows) < Number(splitLines.length) - 1) {
      this._multilineMove(1, splitLines, Number(cursorPos.rows), Number(cursorPos.cols));
      return;
    }
    this._previousCursorCols = -1;
    this._historyNext();
  }

  _historyNext(): void {
    if (!this.historyManager.canNavigateToNext()) return;
    this._beforeEdit(this.line, this.cursor);
    this._setLine(this.historyManager.navigateToNext(this._substringSearch));
    this.cursor = Number(String(this.line).length);
    this._refreshLine();
  }

  _moveUpOrHistoryPrev(): void {
    const cursorPos: any = this.getCursorPos();
    if (this._isMultiline && Number(cursorPos.rows) > 0) {
      const splitLines: any[] = String(this.line).split("\n");
      this._multilineMove(-1, splitLines, Number(cursorPos.rows), Number(cursorPos.cols));
      return;
    }
    this._previousCursorCols = -1;
    this._historyPrev();
  }

  _historyPrev(): void {
    if (!this.historyManager.canNavigateToPrevious()) return;
    this._beforeEdit(this.line, this.cursor);
    this._setLine(this.historyManager.navigateToPrevious(this._substringSearch));
    this.cursor = Number(String(this.line).length);
    this._refreshLine();
  }

  // The last character's display position of the given string.
  _getDisplayPos(str: any): any {
    let offset = 0;
    const col: any = this.columns;
    let rows = 0;
    const text: string = stripVTControlCharacters(String(str));

    for (const char of text) {
      if (char === "\n") {
        // Rows must grow by 1 even when offset is 0 or col is +Infinity.
        rows = rows + (Math.ceil(offset / col) || 1);
        // Only a continuation line of user input carries the prefix offset,
        // never a prompt.
        offset = this._isMultiline ? Number(__RL_MULTILINE_PROMPT.length) : 0;
        continue;
      }
      if (char === "\t") {
        // Tabs are aligned to a multiple of the tab size.
        offset = offset + this.tabSize - (offset % this.tabSize);
        continue;
      }
      const width = __rlStringWidth(char, false);
      if (width === 0 || width === 1) {
        offset = offset + width;
      } else {
        // width === 2
        if ((offset + 1) % col === 0) offset = offset + 1;
        offset = offset + 2;
      }
    }

    const cols = offset % col;
    rows = rows + (offset - cols) / col;
    return { cols: cols, rows: rows };
  }

  // The real position of the cursor relative to the prompt plus the string.
  getCursorPos(): any {
    const strBeforeCursor: string =
      String(this._prompt) + String(this.line).slice(0, this.cursor);
    return this._getDisplayPos(strBeforeCursor);
  }

  _getCursorPos(): any {
    return this.getCursorPos();
  }

  // Moves the cursor `dx` places to the right (negative for left) and refreshes
  // the line when that is needed.
  _moveCursor(dx: any): void {
    if (dx === 0) return;
    const oldPos: any = this.getCursorPos();
    this.cursor = this.cursor + Number(dx);

    // Bounds check.
    if (this.cursor < 0) {
      this.cursor = 0;
    } else if (this.cursor > Number(String(this.line).length)) {
      this.cursor = Number(String(this.line).length);
    }

    const newPos: any = this.getCursorPos();

    if (Number(oldPos.rows) === Number(newPos.rows)) {
      const diffWidth = Number(newPos.cols) - Number(oldPos.cols);
      moveCursor(this.output, diffWidth, 0);
    } else {
      this._refreshLine();
    }
  }

  // Handle a write from the tty.
  _ttyWrite(s: any, key?: any): void {
    const self: any = this;
    const previousKey: any = this._previousKey;
    const k: any = key ? key : {};
    this._previousKey = k;
    let shouldResetPreviousCursorCols = true;

    if (!k.meta || k.name !== "y") {
      // Reset the yanking state unless this is a yank pop.
      this._yanking = false;
    }

    // Activate or deactivate substring search.
    if (
      (k.name === "up" || k.name === "down") && !k.ctrl && !k.meta && !k.shift
    ) {
      if (this._substringSearch === null && !this._isMultiline) {
        this._substringSearch = String(this.line).slice(0, this.cursor);
      }
    } else if (this._substringSearch !== null) {
      this._substringSearch = null;
      // Reset the index in case there is no match.
      if (Number(this.history.length) === this.historyIndex) {
        this.historyIndex = -1;
      }
    }

    // Undo and redo.
    if (typeof k.sequence === "string") {
      const first = __rlCodePointAt(k.sequence, 0);
      if (first === 0x1f) {
        this._undo();
        return;
      }
      if (first === 0x1e) {
        this._redo();
        return;
      }
    }

    // Ignore the escape key; fixes nodejs/node-v0.x-archive#2876.
    if (k.name === "escape") return;

    if (k.ctrl && k.shift) {
      // Control and shift pressed.
      if (k.name === "backspace") {
        // The transmitted escape sequence is `\b`, identical to <ctrl>-h.
        this._deleteLineLeft();
      } else if (k.name === "delete") {
        this._deleteLineRight();
      }
    } else if (k.ctrl) {
      // Control pressed.
      const name: any = k.name;
      if (name === "c") {
        if (Number(this.listenerCount("SIGINT")) > 0) {
          this.emit("SIGINT");
        } else {
          // This readline instance is finished.
          this.close();
          if (this._questionReject) {
            __evCall(this._questionReject, [new AbortError("Aborted with Ctrl+C")]);
          }
        }
      } else if (name === "h") {
        this._deleteLeft();
      } else if (name === "d") {
        if (this.cursor === 0 && Number(String(this.line).length) === 0) {
          // This readline instance is finished.
          this.close();
          if (this._questionReject) {
            __evCall(this._questionReject, [new AbortError("Aborted with Ctrl+D")]);
          }
        } else if (this.cursor < Number(String(this.line).length)) {
          this._deleteRight();
        }
      } else if (name === "u") {
        this._deleteLineLeft();
      } else if (name === "k") {
        this._deleteLineRight();
      } else if (name === "a") {
        this._moveCursor(-Infinity);
      } else if (name === "e") {
        this._moveCursor(Infinity);
      } else if (name === "b") {
        this._moveCursor(-charLengthLeft(this.line, this.cursor));
      } else if (name === "f") {
        this._moveCursor(charLengthAt(this.line, this.cursor));
      } else if (name === "l") {
        cursorTo(this.output, 0, 0);
        clearScreenDown(this.output);
        this._refreshLine();
      } else if (name === "n") {
        this._historyNext();
      } else if (name === "p") {
        this._historyPrev();
      } else if (name === "y") {
        this._yank();
      } else if (name === "z") {
        if (process.platform !== "win32") {
          if (Number(this.listenerCount("SIGTSTP")) > 0) {
            this.emit("SIGTSTP");
          } else {
            process.once("SIGCONT", function (): void {
              // Don't raise events if the stream has already been abandoned.
              if (!self.paused) {
                // The stream must be paused and resumed after SIGCONT to catch
                // SIGINT, SIGTSTP and EOF (joyent/node#3295).
                self.pause();
                self.emit("SIGCONT");
              }
              self._setRawMode(true);
              self._refreshLine();
            });
            this._setRawMode(false);
            process.kill(process.pid, "SIGTSTP");
          }
        }
      } else if (name === "w" || name === "backspace") {
        // <ctrl>-w, and <ctrl>-backspace whose sequence is also `\b`.
        this._deleteWordLeft();
      } else if (name === "delete") {
        this._deleteWordRight();
      } else if (name === "left") {
        this._wordLeft();
      } else if (name === "right") {
        this._wordRight();
      }
    } else if (k.meta) {
      // Meta pressed.
      const name: any = k.name;
      if (name === "b") {
        this._wordLeft();
      } else if (name === "f") {
        this._wordRight();
      } else if (name === "d" || name === "delete") {
        this._deleteWordRight();
      } else if (name === "backspace") {
        this._deleteWordLeft();
      } else if (name === "y") {
        this._yankPop();
      }
    } else {
      // No modifier keys used.
      //
      // `\r` bookkeeping only matters if a `\n` comes right after.
      if (this._sawReturnAt && k.name !== "enter") this._sawReturnAt = 0;

      const name: any = k.name;
      if (name === "return") {
        // Carriage return, i.e. `\r`.
        this._sawReturnAt = Number(Date.now());
        this._line();
      } else if (name === "enter") {
        // Only a line when the key interval exceeded crlfDelay.
        if (
          this._sawReturnAt === 0 ||
          Number(Date.now()) - this._sawReturnAt > this.crlfDelay
        ) {
          this._line();
        }
        this._sawReturnAt = 0;
      } else if (name === "backspace") {
        this._deleteLeft();
      } else if (name === "delete") {
        this._deleteRight();
      } else if (name === "left") {
        this._moveCursor(-charLengthLeft(this.line, this.cursor));
      } else if (name === "right") {
        this._moveCursor(charLengthAt(this.line, this.cursor));
      } else if (name === "home") {
        this._moveCursor(-Infinity);
      } else if (name === "end") {
        this._moveCursor(Infinity);
      } else if (name === "up") {
        shouldResetPreviousCursorCols = false;
        this._moveUpOrHistoryPrev();
      } else if (name === "down") {
        shouldResetPreviousCursorCols = false;
        this._moveDownOrHistoryNext();
      } else if (
        name === "tab" && __rlIsFn(this.completer) && this.isCompletionEnabled
      ) {
        const lastKeypressWasTab =
          previousKey && previousKey.name === "tab" ? true : false;
        this._tabComplete(lastKeypressWasTab);
      } else if (typeof s === "string" && s) {
        // Every line ending in the sequence closes a line. Node keeps the
        // regex's `lastIndex` across the `_line()` call, which may re-enter
        // this method; the scan carries that cursor in a local instead, so
        // re-entry cannot disturb it.
        let lastIndex = 0;
        let at = __rlFindLineEnding(s, 0);
        while (at !== -1) {
          this._insertString(s.slice(lastIndex, at));
          lastIndex = at + __rlLineEndingAt(s, at);
          this._line();
          at = __rlFindLineEnding(s, lastIndex);
        }
        // Write the last line even when it does not end in a newline. That last
        // line may also be the first, in which case this still works.
        this._insertString(s.slice(lastIndex));
      }
    }
    if (shouldResetPreviousCursorCols) this._previousCursorCols = -1;
  }

  // Creates an async iterator over each line of the input stream.
  [Symbol.asyncIterator](): any {
    if (this._lineObjectStream === undefined) {
      this._lineObjectStream = __rlLineIterator(this);
    }
    return this._lineObjectStream;
  }
}

// `ArrayPrototypeJoin(ArrayPrototypeReverse(ArrayFrom(str)), '')` — reverse by
// code point, which is what keeps a surrogate pair together.
function __rlReverse(text: string): string {
  const chars: any[] = [];
  for (const ch of text) chars.push(ch);
  chars.reverse();
  return chars.join("");
}


// ---------------------------------------------------------------------------
// `readline/promises`' `Readline`
// ---------------------------------------------------------------------------

class Readline {
  _stream: any = undefined;
  _autoCommit: boolean = false;
  _todo: any[] = [];

  constructor(stream: any, options?: any) {
    if (
      stream === null || stream === undefined ||
      !(__rlHas(stream, "write") || __rlIsFn(stream))
    ) {
      throw new ERR_INVALID_ARG_TYPE("stream", "Writable", stream);
    }
    this._stream = stream;
    if (options !== null && options !== undefined && options.autoCommit !== undefined &&
        options.autoCommit !== null) {
      __evValidateBoolean(options.autoCommit, "options.autoCommit");
      this._autoCommit = options.autoCommit === true;
    }
    this._todo = [];
  }

  _queue(data: string): void {
    const self: any = this;
    if (this._autoCommit) {
      process.nextTick(function (): void {
        self._stream.write(data);
      });
    } else {
      this._todo.push(data);
    }
  }

  // Moves the cursor to the x and y coordinate on the stream.
  cursorTo(x: any, y?: any): any {
    __rlValidateInteger(x, "x");
    if (y !== undefined && y !== null) __rlValidateInteger(y, "y");
    const data: string = y === undefined || y === null
      ? __rlCsiCol(Number(x) + 1)
      : __rlCsiRowCol(Number(y) + 1, Number(x) + 1);
    this._queue(data);
    return this;
  }

  // Moves the cursor relative to its current location.
  moveCursor(dx: any, dy: any): any {
    if (dx || dy) {
      __rlValidateInteger(dx, "dx");
      __rlValidateInteger(dy, "dy");
      let data = "";
      if (dx < 0) {
        data = data + __rlCsiMove(-Number(dx), "D");
      } else if (dx > 0) {
        data = data + __rlCsiMove(Number(dx), "C");
      }
      if (dy < 0) {
        data = data + __rlCsiMove(-Number(dy), "A");
      } else if (dy > 0) {
        data = data + __rlCsiMove(Number(dy), "B");
      }
      this._queue(data);
    }
    return this;
  }

  // Clears the current line the cursor is on: -1 for left of the cursor, +1 for
  // right of it, 0 for the entire line.
  clearLine(dir: any): any {
    __rlValidateInteger(dir, "dir", -1, 1);
    const data: string = dir < 0
      ? __RL_CLEAR_TO_LINE_BEGINNING
      : dir > 0 ? __RL_CLEAR_TO_LINE_END : __RL_CLEAR_LINE;
    this._queue(data);
    return this;
  }

  // Clears the screen from the current cursor position down.
  clearScreenDown(): any {
    this._queue(__RL_CLEAR_SCREEN_DOWN);
    return this;
  }

  // Sends every pending action to the stream and clears the pending list.
  commit(): any {
    const self: any = this;
    return new Promise(function (resolve: any): void {
      self._stream.write(self._todo.join(""), resolve);
      self._todo = [];
    });
  }

  // Clears the pending list without sending it.
  rollback(): any {
    this._todo = [];
    return this;
  }
}

// ---------------------------------------------------------------------------
// Module objects
// ---------------------------------------------------------------------------
//
// `Interface` and `createInterface` are added by src/readline/callback.ts and
// src/readline/promises.ts, each of which declares its own `Interface` class;
// the bundler inlines exactly one of them.
const __node_readline: any = {
  clearLine: clearLine,
  clearScreenDown: clearScreenDown,
  cursorTo: cursorTo,
  moveCursor: moveCursor,
  emitKeypressEvents: emitKeypressEvents,
};

const __node_readline_promises: any = {
  Readline: Readline,
};

__node_readline.promises = __node_readline_promises;

// `internal/readline/utils`, which `test-readline-csi.js` reaches for `CSI`.
const __node_internal_readline_utils: any = {
  CSI: CSI,
  charLengthAt: charLengthAt,
  charLengthLeft: charLengthLeft,
  commonPrefix: commonPrefix,
  reverseString: reverseString,
  emitKeys: emitKeys,
};

// `internal/readline/callbacks` and `internal/readline/emitKeypressEvents`,
// for completeness; the public module above is the one the corpus uses.
const __node_internal_readline_callbacks: any = {
  clearLine: clearLine,
  clearScreenDown: clearScreenDown,
  cursorTo: cursorTo,
  moveCursor: moveCursor,
};

// `internal/util/inspect`'s two width helpers. `stripVTControlCharacters` is
// src/util/util.ts' own top-level function, handed out here under the name the
// internal module publishes it as.
const __node_internal_util_inspect: any = {
  getStringWidth: __rlStringWidth,
  stripVTControlCharacters: stripVTControlCharacters,
  inspect: __evInspect,
};

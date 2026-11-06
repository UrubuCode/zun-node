// node:console — the `Console` class, its nineteen methods, and the module
// instance bound to `process.stdout`/`process.stderr`.
//
// Behavior is defined by Node.js 25: this module follows
// `lib/internal/console/constructor.js`, `lib/internal/cli_table.js` and the
// `time`/`timeLog`/`timeEnd`/`formatTime` half of
// `lib/internal/util/debuglog.js` (all MIT, Copyright Joyent, Inc. and other
// Node contributors). Those three files are the only description of what is
// observable here — the exact box-drawing of `console.table`, `formatTime`'s
// four output shapes, the per-instance group indentation, the five
// `console.<level>` diagnostics channels, which warnings `countReset`/`timeLog`
// emit and the `colorMode`/`inspectOptions` interaction — none of which is
// derivable from the documentation.
//
// It is pure computation (PLAN.md principle 2): a console is argument
// validation, `util.formatWithOptions`, and a `write` call on something the
// caller supplied. The only host facility it needs is a clock, and `Date.now()`
// is already in the language.
//
// ---------------------------------------------------------------------------
// The engine already has a `console`, and this module has to replace it
// ---------------------------------------------------------------------------
//
// Zun's prelude binds `console` as a namespace with exactly five members —
// `log`, `info`, `debug`, `warn`, `error` (`zun_sema/src/check.rs`) — and a call
// to anything else (`console.count`, `console.table`, `console.group`) is a
// *compile* error, not a missing method. Node's `console` is the global, is the
// value of `require('console')`, and has nineteen methods, so this module cannot
// be a module object that sits beside the prelude: the corpus calls these
// methods on the global.
//
// A top-level declaration of the name shadows the prelude for the *computed*
// spelling `console[method](...)`, which is guarded on `cx.lookup(...)` — the
// same mechanism `src/timers/timers.ts` uses for the six timer globals. The
// dotted spelling is not so lucky: eleven method names are intercepted with no
// such guard, and a module-level `const console` is invisible to
// `console.<method>` from inside a function altogether. Both behaviours are
// documented with repros at the declaration in `src/console/global.ts`, which
// binds the one console object under *two* names so the bundler can rewrite
// receiver positions to the second.
//
// Those declarations are not in this file. The bundler leaves
// `src/console/global.ts` out for a test that declares its own top-level
// `console` (`test-console-table.js` and `test-console-log-throw-primitive.js`
// both write `const console = new Console(...)`, and two top-level declarations
// of one name are a compile error in a single Zun program) and renames that
// test's own binding instead. Splitting the global off is what lets both kinds
// of test compile; see tools/bundle_node_test.sh.
//
// ---------------------------------------------------------------------------
// Shapes that differ from Node's source, and why
// ---------------------------------------------------------------------------
//
// * **Real fields instead of symbol-keyed descriptors.** Node builds the whole
//   instance out of `ObjectDefineProperties` with symbol keys
//   (`kGroupIndentationWidth`, `kColorMode`, `kIsConsole`, ...) and binds every
//   prototype method to the instance in the constructor. A class computed
//   member key must be the literal `Symbol.<wellKnown>` here
//   (https://github.com/UrubuCode/zun/issues/31), and a class method cannot be
//   read as a value to be bound (zun#19), so the internals are declared fields
//   with reserved names and the methods stay on the class. The two observable
//   consequences the corpus checks are both preserved: `_times` is a real `Map`,
//   and no enumerable own key named `Symbol(groupIndent)` exists.
//
// * **No `new.target`.** `Console(out, err)` without `new` returns an instance
//   in Node (`ReflectConstruct(Console, arguments)`); there is no
//   function-constructor model here (zun#25) and a class cannot be called, so
//   that spelling is a declared gap.
//
// * **`stream.write(string)` with no error callback.** Node passes an error
//   handler as the second argument and brackets the write with a temporary
//   `'error'` listener. A stream in this library is still being written
//   (`node:stream` is a separate module in the roadmap), and the brief for this
//   module is that a console stream need only answer `write(chunk)`, so the
//   listener bracket is applied only when the stream actually has
//   `listenerCount`/`once`/`removeListener`, and the error callback is dropped.
//   `_ignoreErrors` still decides whether a throwing `write` propagates, which
//   is what `test-console-table.js` (`false`) and the global console (`true`)
//   each depend on.
//
// * **`console.table` collects its columns in a `Map`, not an object.** Node
//   uses `{ __proto__: null }` — the fix for CVE-2022-21824, where a
//   prototype-bearing accumulator let a user-supplied column name such as
//   `__proto__` write through to `Object.prototype`. A null-prototype object is
//   not a safe accumulator in this engine either: a computed read with a
//   variable key still resolves `Object.prototype`'s members on one
//   (zun#46), and a `__proto__` assignment is unconditional (zun#47). A `Map`
//   has no prototype to pollute and no inherited key to collide with, keeps
//   insertion order (which is what `ObjectKeys(map)` gave Node), and is
//   therefore the accumulator here. `test-console-table.js`'s regression case —
//   `console.table([{ foo: 10 }], ['__proto__'])` followed by
//   `assert.strictEqual('0' in Object.prototype, false)` — is exactly this.
//
// Engine notes (https://github.com/UrubuCode/zun/issues):
//   * `ToString(Symbol)` does not throw in this engine: `${Symbol('x')}` yields
//     `"Symbol(x)"` where the specification requires a `TypeError`. Node's
//     `console.time`/`count`/`countReset` coerce their label with a template
//     literal and therefore reject a symbol, and the corpus asserts that, so
//     `__consoleLabel` performs the coercion with the spec's `TypeError`
//     spelled out rather than relying on the engine's.
//   * `.length` is typed `u64`, hence `Number(x.length)` throughout (zun#3).
//   * `charCodeAt` throws on an out-of-range index, so `__consoleCharCode`
//     guards it (zun#2).
//   * every stored callable goes through `__evBox`, and every call to a value
//     through `__evCall` — a bare function loses identity and properties in an
//     array (zun#17) and no receiver can be threaded into one (zun#1).
//   * the errors are declared `NodeTypeError`/`NodeRangeError` subclasses, never
//     a plain error with `code` written through an `any` alias (zun#37).

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ERR_CONSOLE_WRITABLE_STREAM extends NodeTypeError {
  constructor(name: string) {
    super(
      "ERR_CONSOLE_WRITABLE_STREAM",
      "Console expects a writable stream instance for " + name,
    );
  }
}

class ERR_INCOMPATIBLE_OPTION_PAIR extends NodeTypeError {
  constructor(first: string, second: string) {
    super(
      "ERR_INCOMPATIBLE_OPTION_PAIR",
      "Option " + '"' + first + '"' + " cannot be used in combination with option " +
        '"' + second + '"',
    );
  }
}

// `validateInteger(value, name, min, max)`. `events`' validator fixes the upper
// bound at MAX_SAFE_INTEGER; `groupIndentation`'s is 1000, and the corpus reads
// the `>= 0 && <= 1000` text out of the message.
function __consoleValidateInteger(value: any, name: string, min: number, max: number): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(min) + " && <= " + String(max),
      value,
    );
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function __consoleCharCode(text: string, index: number): number {
  if (index < 0 || index >= Number(text.length)) return -1;
  return text.charCodeAt(index);
}

// Write to a console stream.
//
// `process.stdout.write` is an object-literal method, and Node's own tests
// replace it (`process.stdout.write = (s) => buf += s`) to capture output. Once
// that assignment has happened, the *method* call `stream.write(text)` no
// longer resolves — the engine keeps the original method in a side store that
// the data property shadows without replacing
// (https://github.com/UrubuCode/zun/issues/32), and the call dies with
// `call did not resolve to a method`. Reading the slot first and calling the
// value is correct in both states: a replaced `write` reads back as a callable,
// and so does the original object-literal method; only a `write` that is a
// *class* method reads back `undefined` (zun#19), and that is the one case the
// method call handles. No receiver is threaded either way (zun#1), which is why
// a console stream here need only answer `write(chunk)`.
function __consoleStreamWrite(stream: any, text: string): any {
  const writer: any = stream["write"];
  if (__consoleIsFn(writer)) return __evCall(writer, [text]);
  return stream.write(text);
}

function __consoleNoop(): void {}

function __consoleIsFn(value: any): boolean {
  return __evIsFn(value);
}

// The label coercion Node writes as `` label = `${label}` ``. Every value but a
// symbol becomes its string form; a symbol is a `TypeError`, which is the
// specification's `ToString` and what `test-console.js` and
// `test-console-count.js` assert. The engine's own coercion answers
// `"Symbol(x)"` instead of throwing, so the check is explicit.
function __consoleLabel(value: any, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "symbol") {
    throw new TypeError("Cannot convert a Symbol value to a string");
  }
  return String(value);
}

// `repeat` with a non-negative count, spelled so a zero count is "" rather than
// an engine-dependent edge case.
function __consoleRepeat(text: string, count: number): string {
  if (count <= 0) return "";
  let out = "";
  for (let i = 0; i < count; i++) out = out + text;
  return out;
}

function __consoleReplaceAll(text: string, needle: string, replacement: string): string {
  return text.split(needle).join(replacement);
}

// ---------------------------------------------------------------------------
// getStringWidth (lib/internal/util/inspect.js)
// ---------------------------------------------------------------------------
//
// `cli_table` pads every cell to the column's *display* width, so a full-width
// character counts two columns and a combining mark counts none. `util`'s own
// width helper is the string length (which is all `util.inspect`'s line
// breaking needs), so the real thing lives here — it is what makes
// `console.table({ foo: '￥' })` line up, which `test-console-table.js` checks
// with a CJK and a Latin-1 yen sign side by side.

function __consoleIsFullWidth(code: number): boolean {
  if (code < 0x1100) return false;
  if (code <= 0x115f) return true;
  if (code === 0x2329 || code === 0x232a) return true;
  if (code >= 0x2e80 && code <= 0x3247 && code !== 0x303f) return true;
  if (code >= 0x3250 && code <= 0x4dbf) return true;
  if (code >= 0x4e00 && code <= 0xa4c6) return true;
  if (code >= 0xa960 && code <= 0xa97c) return true;
  if (code >= 0xac00 && code <= 0xd7a3) return true;
  if (code >= 0xf900 && code <= 0xfaff) return true;
  if (code >= 0xfe10 && code <= 0xfe19) return true;
  if (code >= 0xfe30 && code <= 0xfe6b) return true;
  if (code >= 0xff01 && code <= 0xff60) return true;
  if (code >= 0xffe0 && code <= 0xffe6) return true;
  if (code >= 0x1b000 && code <= 0x1b001) return true;
  if (code >= 0x1f200 && code <= 0x1f251) return true;
  if (code >= 0x1f300 && code <= 0x1f64f) return true;
  if (code >= 0x20000 && code <= 0x3fffd) return true;
  return false;
}

function __consoleIsZeroWidth(code: number): boolean {
  if (code <= 0x1f) return true;
  if (code >= 0x7f && code <= 0x9f) return true;
  if (code >= 0x300 && code <= 0x36f) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code >= 0x20d0 && code <= 0x20f0) return true;
  if (code >= 0xfe00 && code <= 0xfe0f) return true;
  if (code >= 0xfe20 && code <= 0xfe23) return true;
  if (code >= 0xe0100 && code <= 0xe01ef) return true;
  return false;
}

function __consoleStringWidth(value: any): number {
  const text: string = stripVTControlCharacters(String(value));
  const n = Number(text.length);
  let width = 0;
  let i = 0;
  while (i < n) {
    let code = __consoleCharCode(text, i);
    let step = 1;
    // A surrogate pair is one code point, so it is measured once.
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      const low = __consoleCharCode(text, i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        step = 2;
      }
    }
    if (__consoleIsFullWidth(code)) {
      width = width + 2;
    } else if (!__consoleIsZeroWidth(code)) {
      width = width + 1;
    }
    i = i + step;
  }
  return width;
}

// ---------------------------------------------------------------------------
// cli_table (lib/internal/cli_table.js)
// ---------------------------------------------------------------------------
//
// The only non-ASCII characters in this library, and deliberately so: they are
// the box-drawing characters Node renders a table with, and the corpus compares
// the output byte for byte.
const __TABLE_MIDDLE_MIDDLE: string = "─";
const __TABLE_ROW_MIDDLE: string = "┼";
const __TABLE_TOP_RIGHT: string = "┐";
const __TABLE_TOP_LEFT: string = "┌";
const __TABLE_LEFT_MIDDLE: string = "├";
const __TABLE_TOP_MIDDLE: string = "┬";
const __TABLE_BOTTOM_RIGHT: string = "┘";
const __TABLE_BOTTOM_LEFT: string = "└";
const __TABLE_BOTTOM_MIDDLE: string = "┴";
const __TABLE_RIGHT_MIDDLE: string = "┤";
const __TABLE_LEFT: string = "│ ";
const __TABLE_RIGHT: string = " │";
const __TABLE_MIDDLE: string = " │ ";

function __consoleRenderRow(row: any[], widths: number[]): string {
  let out: string = __TABLE_LEFT;
  const count = Number(row.length);
  for (let i = 0; i < count; i++) {
    const cell: string = String(row[i]);
    const needed: number = Number(widths[i]) - __consoleStringWidth(cell);
    out = out + cell + __consoleRepeat(" ", needed);
    if (i !== count - 1) out = out + __TABLE_MIDDLE;
  }
  return out + __TABLE_RIGHT;
}

function __consoleTableRender(head: any[], columns: any[]): string {
  const headCount = Number(head.length);
  const widths: number[] = [];
  for (let i = 0; i < headCount; i++) widths.push(__consoleStringWidth(head[i]));

  let longest = 0;
  for (const column of columns) {
    const length = Number(column.length);
    if (length > longest) longest = length;
  }

  const rows: any[] = [];
  for (let i = 0; i < headCount; i++) {
    const column: any = columns[i];
    for (let j = 0; j < longest; j++) {
      if (rows[j] === undefined) rows[j] = [];
      const cell: any = column[j] === undefined ? "" : column[j];
      rows[j][i] = cell;
      const counted = __consoleStringWidth(cell);
      if (counted > Number(widths[i])) widths[i] = counted;
    }
  }

  const dividers: string[] = [];
  for (let i = 0; i < headCount; i++) {
    dividers.push(__consoleRepeat(__TABLE_MIDDLE_MIDDLE, Number(widths[i]) + 2));
  }

  let result: string =
    __TABLE_TOP_LEFT + dividers.join(__TABLE_TOP_MIDDLE) + __TABLE_TOP_RIGHT + "\n" +
    __consoleRenderRow(head, widths) + "\n" +
    __TABLE_LEFT_MIDDLE + dividers.join(__TABLE_ROW_MIDDLE) + __TABLE_RIGHT_MIDDLE + "\n";

  for (const row of rows) {
    result = result + __consoleRenderRow(row, widths) + "\n";
  }

  return result + __TABLE_BOTTOM_LEFT + dividers.join(__TABLE_BOTTOM_MIDDLE) +
    __TABLE_BOTTOM_RIGHT;
}

// ---------------------------------------------------------------------------
// formatTime and the time store (lib/internal/util/debuglog.js)
// ---------------------------------------------------------------------------

const __CONSOLE_SECOND: number = 1000;
const __CONSOLE_MINUTE: number = 60 * __CONSOLE_SECOND;
const __CONSOLE_HOUR: number = 60 * __CONSOLE_MINUTE;

function __consolePad(value: any): string {
  const text: string = String(value);
  return Number(text.length) >= 2 ? text : "0" + text;
}

// `formatTime(ms)` — four shapes, in Node's own order: `h:mm:ss.mmm`,
// `m:ss.mmm`, `s.sss s` and `n.nnn ms`.
function formatTime(ms: any): string {
  let remaining: number = Number(ms);
  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (remaining >= __CONSOLE_SECOND) {
    if (remaining >= __CONSOLE_MINUTE) {
      if (remaining >= __CONSOLE_HOUR) {
        hours = Math.floor(remaining / __CONSOLE_HOUR);
        remaining = remaining % __CONSOLE_HOUR;
      }
      minutes = Math.floor(remaining / __CONSOLE_MINUTE);
      remaining = remaining % __CONSOLE_MINUTE;
    }
    seconds = remaining / __CONSOLE_SECOND;
  }

  if (hours !== 0 || minutes !== 0) {
    // Node destructures `toFixed(seconds, 3).split('.')` back into
    // `seconds`/`ms`, so the rounding of the fractional part can carry into the
    // whole seconds — and it is the *string* halves that are printed.
    const fixed: string = seconds.toFixed(3);
    const parts: string[] = fixed.split(".");
    const wholeSeconds: string = parts[0];
    const millis: string = Number(parts.length) > 1 ? parts[1] : "000";
    const head: string = hours !== 0 ? String(hours) + ":" + __consolePad(minutes) : String(minutes);
    return head + ":" + __consolePad(wholeSeconds) + "." + millis +
      " (" + (hours !== 0 ? "h:m" : "") + "m:ss.mmm)";
  }

  if (seconds !== 0) return seconds.toFixed(3) + "s";

  return String(Number(remaining.toFixed(3))) + "ms";
}

// `process.hrtime()` is a placeholder in ../process/process.ts (it answers
// `[0, 0]`, because `process` has no native of its own yet), so the time store
// keeps its own `[seconds, nanoseconds]` pair from `Date.now()`. The shape is
// Node's, which is what `console._times.get('test')` hands back to a test; the
// resolution is a millisecond, which is all `formatTime` prints anyway.
function __consoleHrtime(): any[] {
  const now: number = Number(Date.now());
  const seconds: number = Math.floor(now / 1000);
  return [seconds, (now - seconds * 1000) * 1000000];
}

function __consoleHrtimeSince(start: any): number {
  const now: any[] = __consoleHrtime();
  const seconds: number = Number(now[0]) - Number(start[0]);
  const nanos: number = Number(now[1]) - Number(start[1]);
  return seconds * 1000 + nanos / 1000000;
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

const __CONSOLE_MAX_GROUP_INDENT: number = 1000;
const __CONSOLE_COLOR_OPTIONS: any = { colors: true };

const __consoleTraceEvents: string[] = ["log", "warn", "error", "info", "debug"];

// The five `console.<level>` diagnostics channels.
//
// Node has `internal/console/constructor` require `diagnostics_channel` and
// create the five channels eagerly. The dependency has to run the other way
// here: `console` is inlined into *every* bundle, because it is a global, while
// `diagnostics_channel` is inlined only for a test that requires it — so a hard
// reference from this file would not compile without it. Instead this file owns
// a hook, and ../diagnostics_channel/diagnostics_channel.ts fills it in at load
// time when it is present. The channels themselves are then created on the
// first `console` call, which is also when Node's `hasSubscribers` check would
// first matter.
const __consoleChannelHook: any = { channel: undefined };

const __consoleChannels: any = {
  ready: false,
  log: undefined,
  warn: undefined,
  error: undefined,
  info: undefined,
  debug: undefined,
};

function __consoleChannelFor(level: string): any {
  if (__consoleChannels.ready !== true) {
    __consoleChannels.ready = true;
    const factory: any = __consoleChannelHook.channel;
    if (factory !== undefined && factory !== null) {
      for (const name of __consoleTraceEvents) {
        __consoleChannels[name] = __evCall(factory, ["console." + name]);
      }
    }
  }
  return __consoleChannels[level];
}

// Publish the *unformatted* argument list, which is the contract: a subscriber
// may mutate the arguments and see the change in the output, which is what
// `test-console-diagnostics-channels.js` asserts.
function __consolePublish(level: string, args: any[]): void {
  const target: any = __consoleChannelFor(level);
  if (target === undefined || target === null) return;
  if (target.hasSubscribers !== true) return;
  target.publish(args);
}

class Console {
  // Node's `_stdout`/`_stderr`/`_ignoreErrors`/`_times` are public by name and
  // read (and written) by the corpus, so they keep their names.
  _stdout: any = undefined;
  _stderr: any = undefined;
  _ignoreErrors: boolean = true;
  _times: any = undefined;
  // The symbol-keyed internals, as declared fields (see the header).
  consoleCounts: any = undefined;
  consoleColorMode: any = "auto";
  consoleGroupIndent: string = "";
  consoleGroupWidth: number = 2;
  consoleInspectOptions: any = undefined;
  consoleIsConsole: boolean = true;
  // `console.Console`, which Node exposes on the instance and the corpus
  // destructures (`const { Console } = console`). A declared field, because an
  // undeclared key written onto a typed instance poisons it (zun#37).
  Console: any = undefined;

  constructor(options?: any, stderrArg?: any, ignoreErrorsArg?: any) {
    // `new Console(stdout, stderr, ignoreErrors)` and
    // `new Console({ stdout, stderr, ... })` are one constructor in Node, told
    // apart by whether the first argument is itself a stream.
    let settings: any = options;
    if (
      options === undefined ||
      options === null ||
      options === false ||
      __consoleIsFn(options === null || options === undefined ? undefined : options["write"])
    ) {
      settings = { stdout: options, stderr: stderrArg, ignoreErrors: ignoreErrorsArg };
    }

    const stdout: any = settings.stdout;
    const stderr: any = settings.stderr === undefined ? stdout : settings.stderr;
    const ignoreErrors: any = settings.ignoreErrors === undefined ? true : settings.ignoreErrors;
    const colorMode: any = settings.colorMode === undefined ? "auto" : settings.colorMode;
    const inspectOptions: any = settings.inspectOptions;
    const groupIndentation: any = settings.groupIndentation;

    if (stdout === undefined || stdout === null || !__consoleIsFn(stdout["write"])) {
      throw new ERR_CONSOLE_WRITABLE_STREAM("stdout");
    }
    if (stderr === undefined || stderr === null || !__consoleIsFn(stderr["write"])) {
      throw new ERR_CONSOLE_WRITABLE_STREAM("stderr");
    }

    __utilValidateOneOf(colorMode, "colorMode", ["auto", true, false]);

    if (groupIndentation !== undefined) {
      __consoleValidateInteger(
        groupIndentation,
        "groupIndentation",
        0,
        __CONSOLE_MAX_GROUP_INDENT,
      );
    }

    if (inspectOptions !== undefined) {
      __utilValidateObject(inspectOptions, "options.inspectOptions");
      // A `Map` keyed by stream is Node's per-stream form; anything else is one
      // option bag shared by both streams.
      let optionsMap: any = inspectOptions;
      if (!(inspectOptions instanceof Map)) {
        optionsMap = new Map();
        optionsMap.set(stdout, inspectOptions);
        optionsMap.set(stderr, inspectOptions);
      }
      for (const entry of optionsMap.values()) {
        if (entry.colors !== undefined && settings.colorMode !== undefined) {
          throw new ERR_INCOMPATIBLE_OPTION_PAIR(
            "options.inspectOptions.color",
            "colorMode",
          );
        }
      }
      this.consoleInspectOptions = optionsMap;
    }

    this._stdout = stdout;
    this._stderr = stderr;
    this._ignoreErrors = ignoreErrors === true || ignoreErrors === undefined;
    this._times = new Map();
    this.consoleCounts = new Map();
    this.consoleColorMode = colorMode;
    this.consoleGroupIndent = "";
    this.consoleGroupWidth = groupIndentation === undefined ? 2 : Number(groupIndentation);
  }

  // Node's `kGetInspectOptions`.
  consoleInspectOptionsFor(stream: any): any {
    let color: any = this.consoleColorMode;
    if (color === "auto") color = __utilShouldColorize(stream);
    const map: any = this.consoleInspectOptions;
    const found: any = map === undefined || map === null ? undefined : map.get(stream);
    if (found !== undefined && found !== null) {
      if (found.colors === undefined) found.colors = color;
      return found;
    }
    return color === true ? __CONSOLE_COLOR_OPTIONS : {};
  }

  // Node's `kFormatForStdout` / `kFormatForStderr`: the inspect options go in
  // front of the argument list and the whole thing goes to
  // `util.formatWithOptions`.
  consoleFormat(args: any[], useStdout: boolean): string {
    const stream: any = useStdout ? this._stdout : this._stderr;
    return __utilFormatWithOptions(this.consoleInspectOptionsFor(stream), args);
  }

  // Node's `kWriteToConsole`.
  consoleWrite(useStdout: boolean, text: any): any {
    let string: string = String(text);
    const groupIndent: string = this.consoleGroupIndent;
    if (groupIndent !== "") {
      if (Number(string.indexOf("\n")) !== -1) {
        string = __consoleReplaceAll(string, "\n", "\n" + groupIndent);
      }
      string = groupIndent + string;
    }
    string = string + "\n";

    const stream: any = useStdout ? this._stdout : this._stderr;
    if (this._ignoreErrors === false) return __consoleStreamWrite(stream, string);

    // A console is a debugging utility, so a failing write is swallowed — but
    // never a stack overflow, which `test-console-no-swallow-stack-overflow.js`
    // checks.
    const bracketed: boolean =
      __consoleIsFn(stream["listenerCount"]) &&
      __consoleIsFn(stream["once"]) &&
      __consoleIsFn(stream["removeListener"]);
    try {
      if (bracketed && Number(stream.listenerCount("error")) === 0) {
        stream.once("error", __consoleNoop);
      }
      __consoleStreamWrite(stream, string);
    } catch (error) {
      if (__consoleIsStackOverflow(error)) throw error;
    } finally {
      if (bracketed) stream.removeListener("error", __consoleNoop);
    }
    return undefined;
  }

  log(...args: any[]): void {
    const passed: any[] = __consoleSpread(args);
    __consolePublish("log", passed);
    this.consoleWrite(true, this.consoleFormat(passed, true));
  }

  info(...args: any[]): void {
    const passed: any[] = __consoleSpread(args);
    __consolePublish("info", passed);
    this.consoleWrite(true, this.consoleFormat(passed, true));
  }

  debug(...args: any[]): void {
    const passed: any[] = __consoleSpread(args);
    __consolePublish("debug", passed);
    this.consoleWrite(true, this.consoleFormat(passed, true));
  }

  // `dirxml` is `log` in Node (`Console.prototype.dirxml = Console.prototype.log`).
  dirxml(...args: any[]): void {
    const passed: any[] = __consoleSpread(args);
    __consolePublish("log", passed);
    this.consoleWrite(true, this.consoleFormat(passed, true));
  }

  warn(...args: any[]): void {
    const passed: any[] = __consoleSpread(args);
    __consolePublish("warn", passed);
    this.consoleWrite(false, this.consoleFormat(passed, false));
  }

  error(...args: any[]): void {
    const passed: any[] = __consoleSpread(args);
    __consolePublish("error", passed);
    this.consoleWrite(false, this.consoleFormat(passed, false));
  }

  dir(object?: any, options?: any): void {
    const merged: any = { customInspect: false };
    const base: any = this.consoleInspectOptionsFor(this._stdout);
    for (const key of Object.keys(base)) merged[key] = base[key];
    if (options !== undefined && options !== null) {
      for (const key of Object.keys(options)) merged[key] = options[key];
    }
    this.consoleWrite(true, inspect(object, merged));
  }

  trace(...args: any[]): void {
    const passed: any[] = __consoleSpread(args);
    let text: string = "Trace: " + this.consoleFormat(passed, false);
    // Node captures the stack with `ErrorCaptureStackTrace`; a fresh `Error`'s
    // own stack is the same information, minus this frame.
    const probe: any = new Error();
    const stack: any = probe.stack;
    if (typeof stack === "string") {
      const lines: string[] = stack.split("\n");
      for (let i = 1; i < Number(lines.length); i++) text = text + "\n" + lines[i];
    }
    this.error(text);
  }

  // https://console.spec.whatwg.org/#assert
  assert(expression?: any, ...args: any[]): void {
    if (__consoleTruthy(expression)) return;
    const passed: any[] = __consoleSpread(args);
    if (Number(passed.length) > 0 && typeof passed[0] === "string") {
      passed[0] = "Assertion failed: " + passed[0];
    } else {
      passed.unshift("Assertion failed");
    }
    __consolePublish("warn", passed);
    this.consoleWrite(false, this.consoleFormat(passed, false));
  }

  // https://console.spec.whatwg.org/#clear — only meaningful on a TTY. The two
  // escape sequences are `cursorTo(stream, 0, 0)` and `clearScreenDown(stream)`
  // from `internal/readline/callbacks`, written directly: `readline` is its own
  // module in the roadmap and these are its only two uses here.
  clear(): void {
    const stream: any = this._stdout;
    if (stream !== undefined && stream !== null && stream.isTTY === true) {
      // `__utilEnv` falls back to `process.envLookup`, so `TERM` is read even
      // though it is outside `process.env`'s snapshot list — Node reads the
      // real variable here, and `test-console-clear.js` guards on the same one.
      const term: any = __utilEnv("TERM");
      if (term === "dumb") return;
      this.consoleWriteRaw("\u001b[1;1H");
      this.consoleWriteRaw("\u001b[0J");
    }
  }

  // `clear` writes its escape sequences with no trailing newline and no group
  // indentation, which `consoleWrite` would both add.
  consoleWriteRaw(text: string): void {
    const stream: any = this._stdout;
    try {
      __consoleStreamWrite(stream, text);
    } catch (error) {
      if (__consoleIsStackOverflow(error)) throw error;
    }
  }

  // https://console.spec.whatwg.org/#count
  count(label?: any): void {
    const key: string = __consoleLabel(label, "default");
    const counts: any = this.consoleCounts;
    let value: any = counts.get(key);
    value = value === undefined ? 1 : Number(value) + 1;
    counts.set(key, value);
    this.log(key + ": " + String(value));
  }

  // https://console.spec.whatwg.org/#countreset
  countReset(label?: any): void {
    const key: string = __consoleLabel(label, "default");
    const counts: any = this.consoleCounts;
    if (counts.has(key) !== true) {
      process.emitWarning("Count for '" + key + "' does not exist");
      return;
    }
    counts.delete(key);
  }

  group(...data: any[]): void {
    const passed: any[] = __consoleSpread(data);
    if (Number(passed.length) > 0) {
      __consolePublish("log", passed);
      this.consoleWrite(true, this.consoleFormat(passed, true));
    }
    this.consoleGroupIndent =
      this.consoleGroupIndent + __consoleRepeat(" ", Number(this.consoleGroupWidth));
  }

  // `groupCollapsed` is `group` in Node.
  groupCollapsed(...data: any[]): void {
    const passed: any[] = __consoleSpread(data);
    if (Number(passed.length) > 0) {
      __consolePublish("log", passed);
      this.consoleWrite(true, this.consoleFormat(passed, true));
    }
    this.consoleGroupIndent =
      this.consoleGroupIndent + __consoleRepeat(" ", Number(this.consoleGroupWidth));
  }

  groupEnd(): void {
    const current: string = this.consoleGroupIndent;
    const keep: number = Number(current.length) - Number(this.consoleGroupWidth);
    this.consoleGroupIndent = keep > 0 ? current.slice(0, keep) : "";
  }

  time(label?: any): void {
    const key: string = __consoleLabel(label, "default");
    if (this._times.has(key) === true) {
      process.emitWarning("Label '" + key + "' already exists for console.time()");
      return;
    }
    this._times.set(key, __consoleHrtime());
  }

  timeEnd(label?: any): void {
    const key: string = __consoleLabel(label, "default");
    this.consoleTimeLog(key, "console.timeEnd()", undefined);
    this._times.delete(key);
  }

  timeLog(label?: any, ...data: any[]): void {
    // `arguments.length`, not `label === undefined`: an optional parameter the
    // caller omitted arrives as `null` in a method that also declares a rest
    // parameter (the engine bug recorded in
    // ../../test/diagnostics_channel/README.md), and `console.count(null)` has
    // to stay `"null"` — so absence is decided by the argument count rather
    // than by the value.
    const key: string = Number(arguments.length) === 0 ? "default" : __consoleLabel(label, "default");
    this.consoleTimeLog(key, "console.timeLog()", __consoleSpread(data));
  }

  // Node's `timeLogImpl`: the warning when the label is unknown, and
  // `log('%s: %s', label, formatted, ...args)` when it is not.
  consoleTimeLog(key: string, implementation: string, data?: any): void {
    const started: any = this._times.get(key);
    if (started === undefined) {
      process.emitWarning("No such label '" + key + "' for " + implementation);
      return;
    }
    const formatted: string = formatTime(__consoleHrtimeSince(started));
    const passed: any[] = ["%s: %s", key, formatted];
    if (data !== undefined && data !== null) {
      const count = Number(data.length);
      for (let i = 0; i < count; i++) passed.push(data[i]);
    }
    __consolePublish("log", passed);
    this.consoleWrite(true, this.consoleFormat(passed, true));
  }

  // https://console.spec.whatwg.org/#table
  table(tabularData?: any, properties?: any): void {
    if (properties !== undefined) __utilValidateArray(properties, "properties");

    if (tabularData === null || typeof tabularData !== "object") {
      // Node writes `return this.log(tabularData)`. It is spelled out here
      // because a bare **function** value cannot be handed to a rest parameter:
      // `this.log(fn)` aborts with `call did not resolve to a method`
      // (https://github.com/UrubuCode/zun/issues/11), and
      // `console.table(function () {})` is one of the cases Node's own test
      // file covers. Building the argument array directly takes the same route
      // `log` would have taken, one step later.
      const single: any[] = [tabularData];
      __consolePublish("log", single);
      this.consoleWrite(true, this.consoleFormat(single, true));
      return;
    }

    const self: any = this;
    this.consoleWrite(true, __consoleTable(self, tabularData, properties));
  }

  // The inspector's three no-ops. They exist on Node's global console (the V8
  // inspector installs them) and a program may call them unconditionally; with
  // no inspector there is nothing to profile.
  profile(): void {}
  profileEnd(): void {}
  timeStamp(): void {}
}

// `console.assert`'s `if (!expression)`, and the one other truthiness test in
// this file. `!x` on an `any` holding an empty string is unreliable
// (https://github.com/UrubuCode/zun/issues/13).
function __consoleTruthy(value: any): boolean {
  if (value === undefined || value === null) return false;
  if (value === false) return false;
  if (value === 0) return false;
  if (value === "") return false;
  return true;
}

function __consoleSpread(args: any[]): any[] {
  const passed: any[] = [];
  if (args === undefined || args === null) return passed;
  const count = Number(args.length);
  for (let i = 0; i < count; i++) passed.push(args[i]);
  return passed;
}

// Node's `isStackOverflowError`: a `RangeError` whose message is V8's
// "Maximum call stack size exceeded".
function __consoleIsStackOverflow(error: any): boolean {
  if (error === null || error === undefined) return false;
  if (!(error instanceof RangeError)) return false;
  const message: any = error.message;
  if (typeof message !== "string") return false;
  return Number(message.indexOf("call stack size exceeded")) !== -1;
}

// ---------------------------------------------------------------------------
// console.table's data shaping
// ---------------------------------------------------------------------------

const __CONSOLE_KEY_KEY: string = "Key";
const __CONSOLE_VALUES_KEY: string = "Values";
const __CONSOLE_INDEX_KEY: string = "(index)";
const __CONSOLE_ITER_KEY: string = "(iteration index)";

// Node's `isArray` for table purposes: a real array, a typed array or a Buffer.
function __consoleIsArrayLike(value: any): boolean {
  if (Array.isArray(value)) return true;
  return __utilTypes.isTypedArray(value) === true;
}

function __consoleTableInspect(instance: any, value: any): string {
  let depth = 0;
  if (
    value !== null &&
    typeof value === "object" &&
    !__consoleIsArrayLike(value) &&
    Number(Object.keys(value).length) > 2
  ) {
    depth = -1;
  }
  const options: any = { depth: depth, maxArrayLength: 3, breakLength: Infinity };
  const base: any = instance.consoleInspectOptionsFor(instance._stdout);
  for (const key of Object.keys(base)) options[key] = base[key];
  return inspect(value, options);
}

function __consoleIndexArray(instance: any, length: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < length; i++) out.push(__consoleTableInspect(instance, i));
  return out;
}

// Is this an iterator the engine hands back from `Map`/`Set`? All of
// `map.entries()`, `map.keys()`, `map.values()` and `set.values()` report the
// class tag `[object Array Iterator]` here — the engine has no distinct
// map/set-iterator type and no `previewEntries` to inspect one without
// consuming it — so the three cases Node tells apart by internal type are told
// apart by what the iterator *yields*: a sequence of two-element arrays is an
// entries iterator, anything else is a values iterator. The deviations that
// follows from that are recorded in ../../test/console/README.md.
function __consoleIsIterator(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  return Object.prototype.toString.call(value) === "[object Array Iterator]";
}

function __consoleTable(instance: any, tabularData: any, properties: any): string {
  let data: any = tabularData;
  let isKeyValue = false;
  let drained: any[] | undefined = undefined;

  if (__consoleIsIterator(data)) {
    const collected: any[] = [];
    for (const item of data) collected.push(item);
    let allPairs: boolean = Number(collected.length) > 0;
    for (const item of collected) {
      if (!Array.isArray(item) || Number(item.length) !== 2) {
        allPairs = false;
        break;
      }
    }
    drained = collected;
    isKeyValue = allPairs;
  }

  if (isKeyValue || data instanceof Map) {
    const keys: string[] = [];
    const values: string[] = [];
    let length = 0;
    if (drained !== undefined) {
      for (const pair of drained) {
        keys.push(__consoleTableInspect(instance, pair[0]));
        values.push(__consoleTableInspect(instance, pair[1]));
        length = length + 1;
      }
    } else {
      for (const pair of data.entries()) {
        keys.push(__consoleTableInspect(instance, pair[0]));
        values.push(__consoleTableInspect(instance, pair[1]));
        length = length + 1;
      }
    }
    return __consoleTableRender(
      [__CONSOLE_ITER_KEY, __CONSOLE_KEY_KEY, __CONSOLE_VALUES_KEY],
      [__consoleIndexArray(instance, length), keys, values],
    );
  }

  if (drained !== undefined || data instanceof Set) {
    const values: string[] = [];
    let length = 0;
    const source: any = drained !== undefined ? drained : data;
    for (const item of source) {
      values.push(__consoleTableInspect(instance, item));
      length = length + 1;
    }
    return __consoleTableRender(
      [__CONSOLE_ITER_KEY, __CONSOLE_VALUES_KEY],
      [__consoleIndexArray(instance, length), values],
    );
  }

  // The accumulator is a `Map`, not an object: see the header note on
  // CVE-2022-21824 and why a null-prototype object is not safe here either.
  const columns: any = new Map();
  let hasPrimitives = false;
  const valuesColumn: any[] = [];
  const indexKeys: any[] = __consoleOwnKeys(data);
  const rowCount = Number(indexKeys.length);

  for (let i = 0; i < rowCount; i++) {
    const item: any = data[indexKeys[i]];
    const primitive: boolean =
      item === null || (typeof item !== "function" && typeof item !== "object");
    if (properties === undefined && primitive) {
      hasPrimitives = true;
      valuesColumn[i] = __consoleTableInspect(instance, item);
    } else {
      const keys: any[] = properties === undefined ? __consoleOwnKeys(item) : properties;
      for (const key of keys) {
        if (columns.has(key) !== true) columns.set(key, []);
        const column: any = columns.get(key);
        if ((primitive && properties !== undefined) || !__consoleHasOwn(item, key)) {
          column[i] = "";
        } else {
          column[i] = __consoleTableInspect(instance, item[key]);
        }
      }
    }
  }

  const head: any[] = [];
  const body: any[] = [];
  for (const entry of columns.entries()) {
    head.push(entry[0]);
    body.push(__consolePadColumn(entry[1], rowCount));
  }
  if (hasPrimitives) {
    head.push(__CONSOLE_VALUES_KEY);
    body.push(__consolePadColumn(valuesColumn, rowCount));
  }
  head.unshift(__CONSOLE_INDEX_KEY);
  body.unshift(indexKeys);

  return __consoleTableRender(head, body);
}

// A column array built by index assignment has holes where no cell was written;
// `cli_table` renders a hole as an empty cell, so the holes are filled in
// instead of relying on a sparse-array `hasOwnProperty` this engine does not
// offer (https://github.com/UrubuCode/zun/issues/5).
function __consolePadColumn(column: any, rowCount: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < rowCount; i++) {
    out.push(column[i] === undefined ? "" : column[i]);
  }
  return out;
}

// `ObjectKeys(value)`, with the index keys of a typed array or Buffer supplied
// by hand: a byte view is opaque through an `any` binding in this engine, so
// `Object.keys` over one answers nothing (zun#38).
function __consoleOwnKeys(value: any): any[] {
  if (value === null || value === undefined) return [];
  if (__utilTypes.isTypedArray(value) === true) {
    const out: string[] = [];
    const length = Number(value.length);
    for (let i = 0; i < length; i++) out.push(String(i));
    return out;
  }
  if (typeof value !== "object" && typeof value !== "function") return [];
  return Object.keys(value);
}

function __consoleHasOwn(value: any, key: any): boolean {
  if (value === null || value === undefined) return false;
  if (__utilTypes.isTypedArray(value) === true) {
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < Number(value.length);
  }
  if (typeof value !== "object" && typeof value !== "function") return false;
  return Object.hasOwn(value, key) === true;
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------

// `require('console')` is the global console in Node, and it carries the class
// under two names (`console.Console` and the module's own `Console` export).
const __node_console: any = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
});
__node_console.Console = Console;

// `internal/util/debuglog`'s `formatTime`, which `test-console-formatTime.js`
// requires directly. The rest of that file is `util.debuglog`, which lives in
// ../util/util.ts for the same reason it lives in `lib/internal/util/` in Node.
const __node_internal_util_debuglog: any = {
  formatTime: formatTime,
};

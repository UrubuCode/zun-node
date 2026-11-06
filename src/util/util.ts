// node:util — the complete Node.js 25 surface, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-util*.js` files (see ../../test/util/).
// `util` is pure computation — no syscalls — so it is written in the language
// the platform compiles rather than behind the `zun_abi` boundary (PLAN.md
// principle 2).
//
// `util` was taken before `stream` because `stream` cannot be written without
// it: `util.inspect`, `util.promisify`, `util.deprecate`, `util.types` and
// `util.debuglog` are load-bearing inside `lib/internal/streams/*`, and nearly
// every Node test file in every corpus formats a value with `util.inspect`
// somewhere — `assert`'s own failure messages included.
//
// The implementation follows Node's `lib/util.js`, `lib/internal/util.js`,
// `lib/internal/util/inspect.js`, `lib/internal/util/comparisons.js`,
// `lib/internal/util/types.js`, `lib/internal/util/debuglog.js`,
// `lib/internal/util/parse_args/*` and `lib/internal/mime.js` (MIT, Copyright
// Joyent, Inc. and other Node contributors). Those files are followed rather
// than paraphrased wherever the output is observable: the exact escape table
// for strings, the `compact`/`breakLength` line-breaking algorithm, the array
// grouping, the `<ref *1>` / `[Circular *1]` notation, the SGR colour table and
// its aliases, the regular-expression depth highlighter, the `%s`/`%d`/`%i`
// placeholder rules, the `.env` grammar and `parseArgs`' tokenizer are all
// defined by Node's source, not derivable from a general rule.
//
// ---------------------------------------------------------------------------
// What this engine cannot express, and what is printed instead
// ---------------------------------------------------------------------------
//
// These are observable gaps, not shortcuts. Each is a value class the VM keeps
// opaque once it rides an `any` lane, which is the only lane `inspect(value)`
// has:
//
//   * **Typed arrays, `ArrayBuffer`, `DataView`.** `const o: any = new
//     Uint8Array([1,2,3])` loses almost everything: `o.length`, `o[0]`,
//     `o.byteLength`, `o.buffer`, `o.constructor` are all `undefined`,
//     `Object.keys(o)` is empty, and `Object.prototype.toString.call(o)`
//     answers `[object Object]`. Statically typed code can still index one; the
//     `any` boundary is where it goes dark.
//     The two *predicates* the engine still answers through an `any` are
//     `ArrayBuffer.isView` and `Buffer.isBuffer`, which is what
//     `types.isArrayBufferView` and `types.isUint8Array` are, and what lets
//     `inspect` print `<Buffer 61 62>` for a byte view instead of `{}`. The
//     bytes themselves are reachable only by passing the value *into* a
//     `Buffer`-typed parameter. Everything else — `types.isTypedArray` (it
//     would have to exclude `DataView`, and nothing separates them),
//     `types.isArrayBuffer`, the per-kind predicates — stays `false`.
//     (zun#38, reported with this work.)
//   * **Boxed primitives** (`new Number(1)`, `new String('a')`,
//     `new Boolean(true)`) are indistinguishable from `{}`, so
//     `[Number: 1]` cannot be produced and `types.isNumberObject` and friends
//     answer `false`.
//   * **`Proxy`.** Detecting one needs a host hook (Node uses
//     `internalBinding('util').getProxyDetails`); `new Proxy({}, {})` is just an
//     object here, so `types.isProxy` answers `false` and `showProxy` has
//     nothing to show.
//   * **Promise state.** A promise's settled value is not readable from the
//     language, so `inspect(Promise.resolve(1))` prints `Promise { <pending> }`
//     rather than `Promise { 1 }`. `types.isPromise` *is* exact, because
//     `Object.prototype.toString` tags promises.
//   * **Function `name` and `length`.** `function foo() {}` reports `name ===
//     undefined` and `length === 0` (zun#25), so `[Function: foo]` degrades to
//     `[Function (anonymous)]` for function declarations. A **class** does
//     report its name, so `[class Foo]` and the `Foo { … }` prefix are right.
//   * **Function kind.** Every callable is tagged `[object Function]` — an
//     `async function`, a `function*`, an `async function*` and a bound
//     function alike — so `[AsyncFunction: f]`, `[GeneratorFunction: f]` and
//     `[Function: bound f]` all come out as `[Function (anonymous)]`.
//     `__utilFormatFunctionValue` derives the word from the tag the way Node
//     does, so each kind appears on its own the day the engine tags it.
//   * **Getters.** Accessors *are* reflectable now:
//     `Object.getOwnPropertyDescriptor(K.prototype, 'y')` comes back with
//     working `get` and `set` slots for a class accessor and for an
//     object-literal one. What is still missing is the step after that —
//     **invoking** the getter against the instance. `desc.get.apply(obj, [])`
//     aborts the interpreter (`expected object, found Void`), and `apply`
//     threads no receiver into a plain function value anyway (zun#1), so
//     `[Getter: 123]` cannot be produced for the getters that read `this`,
//     which is what `getters: true` exists for. Two smaller gaps sit on the
//     same path: `Object.getOwnPropertyNames(K.prototype)` omits
//     `constructor`, and `Object.getOwnPropertyDescriptor(Object.prototype,
//     'constructor')` is `undefined`, so Node's "stop at a built-in
//     prototype" rule in `addPrototypeProperties` has nothing to test. The
//     prototype-accessor walk is therefore still absent rather than half
//     built.
//   * **Symbol `description`.** Reading `.description` off a symbol held in an
//     `any` panics the interpreter (new bug, reported with this work), so the
//     description is recovered from `String(sym)` instead.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `inspect`, `format`, `formatWithOptions`, `promisify`, `deprecate`,
//     `debuglog`, `highlightRegExp` and `styleText` are **top-level function
//     declarations** that are only then placed on the `util` object. An
//     object-literal method can carry properties now (zun#14), so this is no
//     longer forced — it stays because it is the clearer shape for the eight
//     entry points that own properties (`inspect.custom`, `inspect.colors`,
//     `inspect.styles`, `promisify.custom`, `inspect.styles.regexp.colors`).
//   * `__utilUnbox` / `__utilIsBox` — a `functionBox` record reports
//     `typeof === "function"` now rather than `"object"`, so the `__boxedFn`
//     slot is probed for both: a record left unopened is tagged
//     `[object Object]`, which `__utilFormatFunctionValue` reads as a class.
//   * `__utilBox` — a function still cannot be returned out of an
//     object-literal method (the caller receives an opaque object that no
//     longer compares equal to the original), so every entry point that answers
//     a function (`promisify`, `callbackify`, `deprecate`, `debuglog`) hands
//     back the engine's own `functionBox` record instead (zun#17). The record
//     stays callable and keeps one identity.
//   * `__utilCall` — `fn.apply(thisArg, args)` threads no receiver into a plain
//     function value and *shifts* its arguments there (`f.apply(r, [a, b])`
//     arrives as `f(r, a)` — zun#1), so a callback is always invoked as
//     `fn(...args)`; `promisify`/`callbackify` therefore cannot forward `this`,
//     which is the one behavioural gap in them.
//   * Every closure here collects its call arguments through a **rest
//     parameter**, never the implicit object the word `arg`+`uments` names: the
//     parser looks for that word textually anywhere inside a function's span —
//     nested closures *and comments* included — and injects a synthetic trailing
//     rest parameter into the enclosing function, which a dynamic call through
//     an `any` receiver leaves unbound. See the note above `deprecate`. (New
//     bug; this is also why the word is spelled with a seam in this file.)
//   * `util.format` and `util.formatWithOptions` are reached through forwarding
//     object-literal methods rather than shorthand properties. zun#11 is
//     closed — a rest-parameter function read as a property value off an `any`
//     receiver works now, and so does a rest method called on one — so the
//     forwarding is kept for shape, not for survival.
//   * `__cc()` instead of `.charCodeAt()` — an out-of-range index is a *runtime
//     abort*, not a catchable throw (zun#2).
//   * `Number(x.length)` everywhere: the checker still types `.length` as `u64`,
//     so it can be neither assigned to nor passed as a `number` (zun#3).
//   * `value === ""` rather than `!value` for an `any`-typed string (zun#13).
//   * No `Object.prototype.toString` held as a value: reading a built-in method
//     into a binding answers `undefined` (zun#17), so `__utilTag` spells the
//     call out in place.
//   * A dynamic method call compiles to at most six call operands (zun#10), so every
//     internal helper stays at or below that and extra state travels in a `ctx`
//     object.
//   * `util.types` is a plain object whose predicates are object-literal
//     methods; `util.types === require('util/types')` therefore holds by
//     identity, which is what `test-util-types-exists.js` asserts.
//   * `Error` subclasses with a declared `code` come from `events.ts`
//     (`NodeTypeError`, `NodeRangeError`, `NodeError`) — never
//     `const e: any = new TypeError(m); e.code = …`, which poisons every later
//     typed member read of the instance (zun#37). Forward references across the
//     bundle resolve, so `util.ts` sitting first in bundle order is fine.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// `charCodeAt` that answers -1 out of range instead of aborting the process
// (zun#2). -1 can never be a real code unit.
function __cc(value: string, index: number): number {
  if (index < 0 || index >= Number(value.length)) return -1;
  return value.charCodeAt(index);
}

// A function value that has ridden through an `any` lane inside an array is a
// `functionBox` record, not a callable (zun#17). The `__boxedFn` slot reads the
// callable back with its identity intact.
//
// A box now reports `typeof === "function"` rather than `"object"`, so the
// `__boxedFn` slot has to be probed for both: guarding on `"object"` alone let
// every boxed callable through unopened, and since a box is also tagged
// `[object Object]`, `__utilFormatFunctionValue` then read it as a class and
// printed `[class (anonymous)]` for every ordinary function.
function __utilUnbox(value: any): any {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return value;
  const inner: any = value["__boxedFn"];
  if (inner !== undefined) return inner;
  return value;
}

// Is this value a `functionBox` record rather than a bare callable?
function __utilIsBox(value: any): boolean {
  if (value === null || value === undefined) return false;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return false;
  return value["__boxedFn"] !== undefined;
}

// Hand a function value out of an object-literal method: route it through a
// one-element array, which yields the engine's own box record. The record is an
// object, so it survives the return, and it stays callable. Re-boxing a box is
// identity-preserving (`[box][0] === box`), so the guard is an optimisation
// rather than a correctness requirement.
function __utilBox(fn: any): any {
  if (__utilIsBox(fn)) return fn;
  if (fn !== null && fn !== undefined && typeof fn === "object") return fn;
  const holder: any[] = [fn];
  return holder[0];
}

function __utilIsFn(value: any): boolean {
  return typeof __utilUnbox(value) === "function";
}

// Invoke a callable held in an `any`. `fn(...args)` is the only spelling that
// reaches it with the right argument count; `apply`/`call` thread no
// receiver in this engine (zun#1).
function __utilCall(fn: any, args: any[]): any {
  const callable: any = __utilUnbox(fn);
  return callable(...args);
}

// `Object.prototype.toString.call(value)`, spelled in place: the method is not
// readable as a value (zun#17).
function __utilTag(value: any): string {
  return Object.prototype.toString.call(value);
}

function __utilIsObjectLike(value: any): boolean {
  return value !== null && typeof value === "object";
}

// `Symbol.prototype.description` panics when read through an `any` (new bug), so
// the description is recovered from the `Symbol(desc)` spelling.
function __utilSymbolDescription(sym: any): string {
  const text = String(sym);
  if (Number(text.length) >= 8 && text.slice(0, 7) === "Symbol(") {
    return text.slice(7, Number(text.length) - 1);
  }
  return "";
}

// The name a value's constructor reports. Classes do reflect their name; plain
// function constructors do not (zun#25).
function __utilCtorName(value: any): string {
  if (value === null || value === undefined) return "";
  const ctor: any = value.constructor;
  if (ctor === undefined || ctor === null) return "";
  const name: any = ctor.name;
  if (typeof name === "string" && name !== "") return name;
  return "";
}

const __UTIL_MAX_SAFE: number = 9007199254740991;

// ---------------------------------------------------------------------------
// util-specific coded errors (the shared bases live in events.ts)
// ---------------------------------------------------------------------------

class ERR_FALSY_VALUE_REJECTION extends NodeError {
  reason: any;
  constructor(reason: any) {
    super("ERR_FALSY_VALUE_REJECTION", "Promise was rejected with falsy value");
    this.reason = reason;
  }
}

class ERR_INVALID_RETURN_VALUE extends NodeTypeError {
  constructor(input: string, name: string, value: any) {
    super(
      "ERR_INVALID_RETURN_VALUE",
      "Expected " + input + ' to be returned from the "' + name + '" function but got ' +
        __utilTypeName(value) + ".",
    );
  }
}

// Node's takes a variadic list of names and joins them (`assert.equal(1)` is
// the two-name case, `url.domainToASCII()` the one-name case). An **optional**
// constructor parameter is still counted as fixed by the checker, so the list
// is a rest parameter.
class ERR_MISSING_ARGS extends NodeTypeError {
  constructor(...names: string[]) {
    super("ERR_MISSING_ARGS", __utilMissingArgsMessage(names));
  }
}

function __utilMissingArgsMessage(names: string[]): string {
  const quoted: string[] = [];
  for (const name of names) quoted.push('"' + String(name) + '"');
  const n = Number(quoted.length);
  // The plural noun is assembled from two pieces: the parser looks for the
  // name of the implicit call-value object textually anywhere inside a
  // function's source span and injects a synthetic rest parameter where it
  // finds one (zun#40), and the singular spelling plus `"s"` is the same
  // string without the trip.
  const plural = " argument" + "s must be specified";
  if (n === 1) return "The " + quoted[0] + " argument must be specified";
  if (n === 2) return "The " + quoted[0] + " and " + quoted[1] + plural;
  return "The " + quoted.slice(0, n - 1).join(", ") + ", and " + quoted[n - 1] + plural;
}

class ERR_PARSE_ARGS_INVALID_OPTION_VALUE extends NodeTypeError {
  constructor(message: string) {
    super("ERR_PARSE_ARGS_INVALID_OPTION_VALUE", message);
  }
}

class ERR_PARSE_ARGS_UNKNOWN_OPTION extends NodeTypeError {
  constructor(option: string, allowPositionals: boolean) {
    super(
      "ERR_PARSE_ARGS_UNKNOWN_OPTION",
      "Unknown option '" + option + "'" +
        (allowPositionals ? "" : ". To specify a positional argument, use a double-dash first"),
    );
  }
}

class ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL extends NodeTypeError {
  constructor(positional: string) {
    super(
      "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
      "Unexpected argument '" + positional + "'. This command does not take positional arg" + "uments",
    );
  }
}

class ERR_INVALID_MIME_SYNTAX extends NodeTypeError {
  constructor(production: string, str: string, invalidIndex: number) {
    super(
      "ERR_INVALID_MIME_SYNTAX",
      "The MIME syntax for a " + production + " in " + JSON.stringify(str) +
        " is invalid" + (invalidIndex !== -1 ? " at index " + String(invalidIndex) : "") + ".",
    );
  }
}

function __utilTypeName(value: any): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const kind = typeof value;
  if (kind === "object") {
    if (Array.isArray(value)) return "an instance of Array";
    const name = __utilCtorName(value);
    return "an instance of " + (name === "" ? "Object" : name);
  }
  return "type " + kind;
}

// ---------------------------------------------------------------------------
// Validators (lib/internal/validators.js, the slice `util` uses)
// ---------------------------------------------------------------------------

function __utilValidateString(value: any, name: string): void {
  if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
}

function __utilValidateFunction(value: any, name: string): void {
  if (!__utilIsFn(value)) throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
}

function __utilValidateBoolean(value: any, name: string): void {
  if (typeof value !== "boolean") throw new ERR_INVALID_ARG_TYPE(name, "boolean", value);
}

function __utilValidateNumber(value: any, name: string): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
}

function __utilValidateObject(value: any, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "object", value);
  }
}

function __utilValidateArray(value: any, name: string): void {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
}

function __utilValidateOneOf(value: any, name: string, allowed: any[]): void {
  for (const candidate of allowed) {
    if (candidate === value) return;
  }
  const shown: string[] = [];
  for (const candidate of allowed) shown.push(__utilInspectShort(candidate));
  throw new ERR_INVALID_ARG_VALUE(
    name,
    value,
    "must be one of: " + shown.join(", "),
  );
}

function __utilInspectShort(value: any): string {
  return typeof value === "string" ? "'" + value + "'" : String(value);
}

// ===========================================================================
// util.inspect
// ===========================================================================

// `util.inspect.custom`, spelled as Node spells it. The symbol registry
// round-trips (zun#23), so a caller that writes
// `Symbol.for('nodejs.util.inspect.custom')` — which is how Node's docs tell you
// to reach it without importing `util` — gets *this* symbol.
const __inspectCustomSymbol: any = Symbol.for("nodejs.util.inspect.custom");
const __promisifyCustomSymbol: any = Symbol.for("nodejs.util.promisify.custom");
const __customPromisifyArgsSymbol: any = Symbol("customPromisifyArgs");

// `inspect.defaultOptions`. Node seals this object and assigning to
// `inspect.defaultOptions` merges rather than replaces; both spellings are
// supported here, the second through `__inspectSetDefaultOptions`.
const __inspectDefaultOptions: any = {
  showHidden: false,
  depth: 2,
  colors: false,
  customInspect: true,
  showProxy: false,
  maxArrayLength: 100,
  maxStringLength: 10000,
  breakLength: 80,
  compact: 3,
  sorted: false,
  getters: false,
  numericSeparator: false,
};

const __INSPECT_OPTION_KEYS: string[] = [
  "showHidden",
  "depth",
  "colors",
  "customInspect",
  "showProxy",
  "maxArrayLength",
  "maxStringLength",
  "breakLength",
  "compact",
  "sorted",
  "getters",
  "numericSeparator",
];

// Escaped control characters, plus the single quote and the backslash — Node's
// `meta` table, index = code unit.
const __META: string[] = [
  "\\x00", "\\x01", "\\x02", "\\x03", "\\x04", "\\x05", "\\x06", "\\x07",
  "\\b", "\\t", "\\n", "\\x0B", "\\f", "\\r", "\\x0E", "\\x0F",
  "\\x10", "\\x11", "\\x12", "\\x13", "\\x14", "\\x15", "\\x16", "\\x17",
  "\\x18", "\\x19", "\\x1A", "\\x1B", "\\x1C", "\\x1D", "\\x1E", "\\x1F",
  "", "", "", "", "", "", "", "\\'", "", "", "", "", "", "", "", "",
  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
  "", "", "", "", "", "", "", "", "", "", "", "", "\\\\", "", "", "",
  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "",
  "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "\\x7F",
  "\\x80", "\\x81", "\\x82", "\\x83", "\\x84", "\\x85", "\\x86", "\\x87",
  "\\x88", "\\x89", "\\x8A", "\\x8B", "\\x8C", "\\x8D", "\\x8E", "\\x8F",
  "\\x90", "\\x91", "\\x92", "\\x93", "\\x94", "\\x95", "\\x96", "\\x97",
  "\\x98", "\\x99", "\\x9A", "\\x9B", "\\x9C", "\\x9D", "\\x9E", "\\x9F",
];

const __UTIL_DEFAULT_FG: number = 39;
const __UTIL_DEFAULT_BG: number = 49;

// `inspect.colors`: the SGR pair for each style name, as in Node. Node defines
// the aliases as accessors onto the canonical entry; here they are plain
// duplicate entries, which reads the same and writes to the alias only — the
// one observable difference, and `Object.keys(inspect.colors)` deliberately
// still lists only the canonical names (see `__INSPECT_COLOR_NAMES`).
const __inspectColors: any = {
  reset: [0, 0],
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  underline: [4, 24],
  blink: [5, 25],
  inverse: [7, 27],
  hidden: [8, 28],
  strikethrough: [9, 29],
  doubleunderline: [21, 24],
  black: [30, __UTIL_DEFAULT_FG],
  red: [31, __UTIL_DEFAULT_FG],
  green: [32, __UTIL_DEFAULT_FG],
  yellow: [33, __UTIL_DEFAULT_FG],
  blue: [34, __UTIL_DEFAULT_FG],
  magenta: [35, __UTIL_DEFAULT_FG],
  cyan: [36, __UTIL_DEFAULT_FG],
  white: [37, __UTIL_DEFAULT_FG],
  bgBlack: [40, __UTIL_DEFAULT_BG],
  bgRed: [41, __UTIL_DEFAULT_BG],
  bgGreen: [42, __UTIL_DEFAULT_BG],
  bgYellow: [43, __UTIL_DEFAULT_BG],
  bgBlue: [44, __UTIL_DEFAULT_BG],
  bgMagenta: [45, __UTIL_DEFAULT_BG],
  bgCyan: [46, __UTIL_DEFAULT_BG],
  bgWhite: [47, __UTIL_DEFAULT_BG],
  framed: [51, 54],
  overlined: [53, 55],
  gray: [90, __UTIL_DEFAULT_FG],
  redBright: [91, __UTIL_DEFAULT_FG],
  greenBright: [92, __UTIL_DEFAULT_FG],
  yellowBright: [93, __UTIL_DEFAULT_FG],
  blueBright: [94, __UTIL_DEFAULT_FG],
  magentaBright: [95, __UTIL_DEFAULT_FG],
  cyanBright: [96, __UTIL_DEFAULT_FG],
  whiteBright: [97, __UTIL_DEFAULT_FG],
  bgGray: [100, __UTIL_DEFAULT_BG],
  bgRedBright: [101, __UTIL_DEFAULT_BG],
  bgGreenBright: [102, __UTIL_DEFAULT_BG],
  bgYellowBright: [103, __UTIL_DEFAULT_BG],
  bgBlueBright: [104, __UTIL_DEFAULT_BG],
  bgMagentaBright: [105, __UTIL_DEFAULT_BG],
  bgCyanBright: [106, __UTIL_DEFAULT_BG],
  bgWhiteBright: [107, __UTIL_DEFAULT_BG],
  // Node's aliases, defined there as non-enumerable accessors.
  grey: [90, __UTIL_DEFAULT_FG],
  blackBright: [90, __UTIL_DEFAULT_FG],
  bgGrey: [100, __UTIL_DEFAULT_BG],
  bgBlackBright: [100, __UTIL_DEFAULT_BG],
  faint: [2, 22],
  crossedout: [9, 29],
  strikeThrough: [9, 29],
  crossedOut: [9, 29],
  conceal: [8, 28],
  swapColors: [7, 27],
  swapcolors: [7, 27],
  doubleUnderline: [21, 24],
};

// The canonical names, in Node's declaration order — what
// `validateOneOf(key, 'format', ObjectKeys(inspect.colors))` reports and what
// `styleText` accepts.
const __INSPECT_COLOR_NAMES: string[] = [
  "reset", "bold", "dim", "italic", "underline", "blink", "inverse", "hidden",
  "strikethrough", "doubleunderline", "black", "red", "green", "yellow", "blue",
  "magenta", "cyan", "white", "bgBlack", "bgRed", "bgGreen", "bgYellow",
  "bgBlue", "bgMagenta", "bgCyan", "bgWhite", "framed", "overlined", "gray",
  "redBright", "greenBright", "yellowBright", "blueBright", "magentaBright",
  "cyanBright", "whiteBright", "bgGray", "bgRedBright", "bgGreenBright",
  "bgYellowBright", "bgBlueBright", "bgMagentaBright", "bgCyanBright",
  "bgWhiteBright",
];

function __utilEscapeStyleCode(code: any): string {
  if (code === undefined) return "";
  return "\u001b[" + String(code) + "m";
}

// ---------------------------------------------------------------------------
// Regular-expression highlighting (Node 25's `highlightRegExp`)
// ---------------------------------------------------------------------------

// Declared at top level so `.colors` can be attached (zun#14): Node exposes the
// palette as `util.inspect.styles.regexp.colors`.
function highlightRegExp(regexpString: string): string {
  const state: any = { out: "", i: 0, depth: 0, src: regexpString, palette: [] };
  const requested: any = (highlightRegExp as any).colors;
  let names: any[] = __HIGHLIGHT_REGEXP_COLORS;
  if (Array.isArray(requested) && Number(requested.length) > 0) names = requested;
  const palette: any[] = [];
  for (const name of names) {
    const color: any = __inspectColors[String(name)];
    if (color !== undefined && color !== null) {
      palette.push(["\u001b[" + String(color[0]) + "m", "\u001b[" + String(color[1]) + "m"]);
    }
  }
  if (Number(palette.length) === 0) {
    for (const name of __HIGHLIGHT_REGEXP_COLORS) {
      const color: any = __inspectColors[name];
      palette.push(["\u001b[" + String(color[0]) + "m", "\u001b[" + String(color[1]) + "m"]);
    }
  }
  state.palette = palette;
  __hreWalk(state);
  return state.out;
}

const __HIGHLIGHT_REGEXP_COLORS: string[] = ["green", "red", "yellow", "cyan", "magenta"];

function __hreWrite(state: any, text: string): void {
  const palette: any[] = state.palette;
  // Node writes `palette[depth % palette.length] ?? palette[0]`, and a negative
  // depth indexes a JavaScript array with a negative number — which is `undefined`
  // and so falls back to `palette[0]`. That fallback is observable (the
  // `\k<name>` backreference in `test-util-inspect-regexp.js` depends on it), so
  // the index is deliberately *not* normalised into range here.
  const idx = Number(state.depth) % Number(palette.length);
  const color: any = idx < 0 || palette[idx] === undefined ? palette[0] : palette[idx];
  state.out = String(state.out) + String(color[0]) + text + String(color[1]);
}

function __hreWriteDepth(state: any, text: string, incDepth: number, incI: number): void {
  state.depth = Number(state.depth) + incDepth;
  __hreWrite(state, text);
  state.depth = Number(state.depth) - incDepth;
  state.i = Number(state.i) + incI;
}

function __hreWriteGroup(state: any, start: string, end: string, decreaseDepth: number): void {
  const src: string = state.src;
  const n = Number(src.length);
  let seq = "";
  state.i = Number(state.i) + 1;
  while (Number(state.i) < n && src.charAt(Number(state.i)) !== end) {
    seq = seq + src.charAt(Number(state.i));
    state.i = Number(state.i) + 1;
  }
  if (Number(state.i) < n) {
    state.depth = Number(state.depth) - decreaseDepth;
    __hreWrite(state, start);
    __hreWriteDepth(state, seq, 1, 1);
    __hreWrite(state, end);
    state.depth = Number(state.depth) + decreaseDepth;
  } else {
    __hreWriteDepth(state, start, 1, -Number(seq.length));
  }
}

function __hreWalk(state: any): void {
  const src: string = state.src;
  const n = Number(src.length);
  let inClass = false;

  __hreWrite(state, "/");
  state.depth = 1;
  state.i = 1;

  while (Number(state.i) < n) {
    const i = Number(state.i);
    const ch = src.charAt(i);

    if (inClass) {
      if (ch === "\\") {
        let seq = "\\";
        state.i = i + 1;
        if (Number(state.i) < n) {
          seq = seq + src.charAt(Number(state.i));
          state.i = Number(state.i) + 1;
          const next = seq.charAt(1);
          if (next === "u" && src.charAt(Number(state.i)) === "{") {
            __hreWriteGroup(state, seq + "{", "}", 0);
            continue;
          } else if ((next === "p" || next === "P") && src.charAt(Number(state.i)) === "{") {
            __hreWriteGroup(state, seq + "{", "}", 0);
            continue;
          } else if (next === "x") {
            seq = seq + src.slice(Number(state.i), Number(state.i) + 2);
            state.i = Number(state.i) + 2;
          }
        }
        __hreWrite(state, seq);
      } else if (ch === "]") {
        state.depth = Number(state.depth) - 1;
        __hreWrite(state, "]");
        state.i = i + 1;
        inClass = false;
      } else if (
        ch === "-" &&
        src.charAt(i - 1) !== "[" &&
        i + 1 < n &&
        src.charAt(i + 1) !== "]"
      ) {
        __hreWriteDepth(state, "-", 1, 1);
      } else {
        __hreWrite(state, ch);
        state.i = i + 1;
      }
    } else if (ch === "[") {
      __hreWrite(state, "[");
      state.depth = Number(state.depth) + 1;
      state.i = i + 1;
      inClass = true;
    } else if (ch === "(") {
      __hreWrite(state, "(");
      state.depth = Number(state.depth) + 1;
      state.i = i + 1;
      if (Number(state.i) < n && src.charAt(Number(state.i)) === "?") {
        state.i = Number(state.i) + 1;
        const a = Number(state.i) < n ? src.charAt(Number(state.i)) : "";
        if (a === ":" || a === "=" || a === "!") {
          __hreWriteDepth(state, "?" + a, -1, 1);
        } else {
          const b = Number(state.i) + 1 < n ? src.charAt(Number(state.i) + 1) : "";
          if (a === "<" && (b === "=" || b === "!")) {
            __hreWriteDepth(state, "?<" + b, -1, 2);
          } else if (a === "<") {
            state.i = Number(state.i) + 1;
            const start = Number(state.i);
            while (Number(state.i) < n && src.charAt(Number(state.i)) !== ">") {
              state.i = Number(state.i) + 1;
            }
            const name = src.slice(start, Number(state.i));
            if (Number(state.i) < n && src.charAt(Number(state.i)) === ">") {
              state.depth = Number(state.depth) - 1;
              __hreWrite(state, "?<");
              __hreWriteDepth(state, name, 1, 0);
              __hreWrite(state, ">");
              state.depth = Number(state.depth) + 1;
              state.i = Number(state.i) + 1;
            } else {
              __hreWriteDepth(state, "?<", -1, 0);
              __hreWrite(state, name);
            }
          } else {
            __hreWrite(state, "?");
          }
        }
      }
    } else if (ch === ")") {
      state.depth = Number(state.depth) - 1;
      __hreWrite(state, ")");
      state.i = i + 1;
    } else if (ch === "\\") {
      let seq = "\\";
      state.i = i + 1;
      if (Number(state.i) < n) {
        seq = seq + src.charAt(Number(state.i));
        state.i = Number(state.i) + 1;
        const next = seq.charAt(1);
        if (Number(state.i) < n) {
          if (next === "u" && src.charAt(Number(state.i)) === "{") {
            __hreWriteGroup(state, seq + "{", "}", 0);
            continue;
          } else if (next === "x") {
            seq = seq + src.slice(Number(state.i), Number(state.i) + 2);
            state.i = Number(state.i) + 2;
          } else if (next >= "0" && next <= "9") {
            while (
              Number(state.i) < n &&
              src.charAt(Number(state.i)) >= "0" &&
              src.charAt(Number(state.i)) <= "9"
            ) {
              seq = seq + src.charAt(Number(state.i));
              state.i = Number(state.i) + 1;
            }
          } else if (next === "k" && src.charAt(Number(state.i)) === "<") {
            __hreWriteGroup(state, seq + "<", ">", 1);
            continue;
          } else if ((next === "p" || next === "P") && src.charAt(Number(state.i)) === "{") {
            __hreWriteGroup(state, seq + "{", "}", 0);
            continue;
          }
        }
      }
      __hreWriteDepth(state, seq, 1, 0);
    } else if (
      ch === "|" || ch === "+" || ch === "*" || ch === "?" ||
      ch === "," || ch === "^" || ch === "$"
    ) {
      __hreWriteDepth(state, ch, 3, 1);
    } else if (ch === "{") {
      state.i = i + 1;
      let digits = "";
      while (
        Number(state.i) < n &&
        src.charAt(Number(state.i)) >= "0" &&
        src.charAt(Number(state.i)) <= "9"
      ) {
        digits = digits + src.charAt(Number(state.i));
        state.i = Number(state.i) + 1;
      }
      if (digits !== "") {
        __hreWrite(state, "{");
        state.depth = Number(state.depth) + 1;
        __hreWriteDepth(state, digits, 1, 0);
      }
      if (Number(state.i) < n) {
        if (src.charAt(Number(state.i)) === ",") {
          if (digits === "") {
            __hreWrite(state, "{");
            state.depth = Number(state.depth) + 1;
          }
          __hreWrite(state, ",");
          state.i = Number(state.i) + 1;
        } else if (digits === "") {
          state.depth = Number(state.depth) + 1;
          __hreWrite(state, "{");
          state.depth = Number(state.depth) - 1;
          continue;
        }
      }
      let digits2 = "";
      while (
        Number(state.i) < n &&
        src.charAt(Number(state.i)) >= "0" &&
        src.charAt(Number(state.i)) <= "9"
      ) {
        digits2 = digits2 + src.charAt(Number(state.i));
        state.i = Number(state.i) + 1;
      }
      if (digits2 !== "") {
        __hreWriteDepth(state, digits2, 1, 0);
      }
      if (Number(state.i) < n && src.charAt(Number(state.i)) === "}") {
        state.depth = Number(state.depth) - 1;
        __hreWrite(state, "}");
        state.i = Number(state.i) + 1;
      }
      if (Number(state.i) < n && src.charAt(Number(state.i)) === "?") {
        __hreWriteDepth(state, "?", 3, 1);
      }
    } else if (ch === ".") {
      __hreWriteDepth(state, ch, 2, 1);
    } else if (ch === "/") {
      break;
    } else {
      __hreWriteDepth(state, ch, 1, 1);
    }
  }

  __hreWriteDepth(state, "/", -1, 1);
  if (Number(state.i) < n) {
    __hreWrite(state, src.slice(Number(state.i)));
  }
}

// `inspect.styles`. `regexp` holds the highlighter function, which users may
// replace with a plain colour name — both shapes are honoured by `__utilStylize`.
const __inspectStyles: any = {
  special: "cyan",
  number: "yellow",
  bigint: "yellow",
  boolean: "yellow",
  undefined: "grey",
  null: "bold",
  string: "green",
  symbol: "green",
  date: "magenta",
  module: "underline",
  regexp: highlightRegExp,
};

// ---------------------------------------------------------------------------
// Stylizing
// ---------------------------------------------------------------------------

function __utilStylize(ctx: any, text: string, styleType: string): string {
  if (ctx.userStylize !== undefined && ctx.userStylize !== null) {
    const produced: any = __utilCall(ctx.userStylize, [text, styleType]);
    return typeof produced === "string" ? produced : text;
  }
  if (ctx.colors !== true) return text;
  const style: any = __inspectStyles[styleType];
  if (style === undefined || style === null) return text;
  if (__utilIsFn(style)) {
    return String(__utilCall(style, [text]));
  }
  const color: any = __inspectColors[String(style)];
  if (color === undefined || color === null) return text;
  return "\u001b[" + String(color[0]) + "m" + text + "\u001b[" + String(color[1]) + "m";
}

// ---------------------------------------------------------------------------
// stripVTControlCharacters
// ---------------------------------------------------------------------------

// Node applies the `ansi-regex` pattern (MIT, Sindre Sorhus). It is spelled as a
// hand-written scanner here, because the pattern needs a lookbehind-free single
// pass anyway and this keeps the one hot path off the regex engine.
//
//   ESC|CSI  [[\]()#;?]*  ( <params> (BEL | ESC \ | ST)   // OSC-style
//                         | <digits;digits...>? <final> ) // CSI-style
function __utilIsAnsiParamChar(code: number): boolean {
  // [-a-zA-Z\d/#&.:=?%@~_]
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  return (
    code === 45 || code === 47 || code === 35 || code === 38 || code === 46 ||
    code === 58 || code === 61 || code === 63 || code === 37 || code === 64 ||
    code === 126 || code === 95
  );
}

// `[\dA-PR-TZcf-nq-uy=><~]`
function __utilIsCsiFinal(code: number): boolean {
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 80) return true;
  if (code >= 82 && code <= 84) return true;
  if (code === 90) return true;
  if (code === 99) return true;
  if (code >= 102 && code <= 110) return true;
  if (code >= 113 && code <= 117) return true;
  if (code === 121) return true;
  return code === 61 || code === 62 || code === 60 || code === 126;
}

// Length of the escape sequence starting at `start`, or 0 when there is none.
function __utilAnsiLength(text: string, start: number): number {
  const n = Number(text.length);
  const first = __cc(text, start);
  if (first !== 27 && first !== 155) return 0;
  let i = start + 1;
  // `[[\]()#;?]*`
  while (i < n) {
    const code = __cc(text, i);
    if (code === 91 || code === 93 || code === 40 || code === 41 ||
        code === 35 || code === 59 || code === 63) {
      i = i + 1;
    } else {
      break;
    }
  }
  // Branch one: optional parameters, then a string terminator.
  let j = i;
  if (__cc(text, j) === 59) {
    while (__cc(text, j) === 59) {
      j = j + 1;
      let seen = 0;
      while (j < n && __utilIsAnsiParamChar(__cc(text, j))) {
        j = j + 1;
        seen = seen + 1;
      }
      if (seen === 0) break;
    }
  } else {
    let seen = 0;
    while (j < n && __utilIsAnsiParamChar(__cc(text, j))) {
      j = j + 1;
      seen = seen + 1;
    }
    if (seen > 0) {
      while (__cc(text, j) === 59) {
        j = j + 1;
        while (j < n && __utilIsAnsiParamChar(__cc(text, j))) j = j + 1;
      }
    }
  }
  const terminator = __cc(text, j);
  if (terminator === 7 || terminator === 156) return j + 1 - start;
  if (terminator === 27 && __cc(text, j + 1) === 92) return j + 2 - start;

  // Branch two: `\d{1,4}(?:;\d{0,4})*` then a final byte.
  let k = i;
  let digits = 0;
  while (k < n && digits < 4 && __cc(text, k) >= 48 && __cc(text, k) <= 57) {
    k = k + 1;
    digits = digits + 1;
  }
  if (digits > 0) {
    while (__cc(text, k) === 59) {
      k = k + 1;
      let more = 0;
      while (k < n && more < 4 && __cc(text, k) >= 48 && __cc(text, k) <= 57) {
        k = k + 1;
        more = more + 1;
      }
    }
  }
  if (k < n && __utilIsCsiFinal(__cc(text, k))) return k + 1 - start;
  // A bare `\d{1,4}` with no final byte still matches the final-byte class via
  // its own digits, which the loop above already consumed; retry without them.
  if (digits > 0 && __utilIsCsiFinal(__cc(text, i))) return i + 1 - start;
  return 0;
}

function stripVTControlCharacters(str: any): string {
  __utilValidateString(str, "str");
  const text: string = str;
  const n = Number(text.length);
  let out = "";
  let i = 0;
  while (i < n) {
    const code = __cc(text, i);
    if (code === 27 || code === 155) {
      const len = __utilAnsiLength(text, i);
      if (len > 0) {
        i = i + len;
        continue;
      }
    }
    out = out + text.charAt(i);
    i = i + 1;
  }
  return out;
}

function __utilRemoveColors(text: string): string {
  const n = Number(text.length);
  let out = "";
  let i = 0;
  while (i < n) {
    const code = __cc(text, i);
    if (code === 27 || code === 155) {
      const len = __utilAnsiLength(text, i);
      if (len > 0) {
        i = i + len;
        continue;
      }
    }
    out = out + text.charAt(i);
    i = i + 1;
  }
  return out;
}

function __utilWidth(text: string, colors: boolean): number {
  return colors ? Number(__utilRemoveColors(text).length) : Number(text.length);
}

// ---------------------------------------------------------------------------
// String escaping (Node's `strEscape`)
// ---------------------------------------------------------------------------

function __utilAddQuotes(str: string, quotes: number): string {
  if (quotes === -1) return '"' + str + '"';
  if (quotes === -2) return "`" + str + "`";
  return "'" + str + "'";
}

function __utilStrEscape(str: string): string {
  let singleQuote = 39;
  if (Number(str.indexOf("'")) !== -1) {
    if (Number(str.indexOf('"')) === -1) {
      singleQuote = -1;
    } else if (Number(str.indexOf("`")) === -1 && Number(str.indexOf("${")) === -1) {
      singleQuote = -2;
    }
  }
  const n = Number(str.length);
  let needsEscape = false;
  for (let i = 0; i < n; i++) {
    const code = __cc(str, i);
    if (code < 32 || code === 92 || (code >= 127 && code <= 159)) {
      needsEscape = true;
      break;
    }
    if (singleQuote === 39 && code === 39) {
      needsEscape = true;
      break;
    }
  }
  if (!needsEscape) return __utilAddQuotes(str, singleQuote);

  let out = "";
  for (let i = 0; i < n; i++) {
    const code = __cc(str, i);
    const escapeIt =
      code < 32 || code === 92 || (code >= 127 && code <= 159) ||
      (singleQuote === 39 && code === 39);
    if (!escapeIt) {
      out = out + str.charAt(i);
      continue;
    }
    const replacement = code < Number(__META.length) ? __META[code] : "";
    out = out + (replacement === "" ? "\\u" + __utilHex4(code) : replacement);
  }
  return __utilAddQuotes(out, singleQuote);
}

function __utilHex4(code: number): string {
  let hex = code.toString(16);
  while (Number(hex.length) < 4) hex = "0" + hex;
  return hex;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

// `numericSeparator: true` groups the integer part in threes, as Node does.
function __utilAddNumericSeparator(text: string): string {
  let start = Number(text.indexOf("-")) === 0 ? 1 : 0;
  let end = Number(text.length);
  const dot = Number(text.indexOf("."));
  const exponent = Number(text.indexOf("e"));
  let tail = "";
  if (dot !== -1) {
    tail = text.slice(dot);
    end = dot;
  } else if (exponent !== -1) {
    tail = text.slice(exponent);
    end = exponent;
  }
  let head = text.slice(0, start);
  const digits = text.slice(start, end);
  const count = Number(digits.length);
  let grouped = "";
  for (let i = 0; i < count; i++) {
    const remaining = count - i;
    if (i > 0 && remaining % 3 === 0) grouped = grouped + "_";
    grouped = grouped + digits.charAt(i);
  }
  return head + grouped + __utilAddNumericSeparatorTail(tail);
}

// The fractional part is grouped from the left, the exponent is not grouped.
function __utilAddNumericSeparatorTail(tail: string): string {
  if (tail === "") return "";
  if (tail.charAt(0) === "e" || tail.charAt(0) === "E") return tail;
  let end = Number(tail.length);
  let exponent = "";
  const e = Number(tail.indexOf("e"));
  if (e !== -1) {
    exponent = tail.slice(e);
    end = e;
  }
  const digits = tail.slice(1, end);
  const count = Number(digits.length);
  let grouped = "";
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 3 === 0) grouped = grouped + "_";
    grouped = grouped + digits.charAt(i);
  }
  return "." + grouped + exponent;
}

function __utilFormatNumberText(value: any, numericSeparator: boolean): string {
  if (!numericSeparator) {
    if (value === 0 && 1 / value < 0) return "-0";
    return String(value);
  }
  if (Number.isInteger(value)) {
    if (value === 0 && 1 / value < 0) return "-0";
    return __utilAddNumericSeparator(String(value));
  }
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return __utilAddNumericSeparator(String(value));
}

function __utilFormatBigIntText(value: any, numericSeparator: boolean): string {
  const text = String(value);
  return (numericSeparator ? __utilAddNumericSeparator(text) : text) + "n";
}

// ---------------------------------------------------------------------------
// The inspect context
// ---------------------------------------------------------------------------

function __utilNewCtx(options: any): any {
  const ctx: any = {
    budget: {},
    indentationLvl: 0,
    seen: [],
    circular: undefined,
    circularCount: 0,
    currentDepth: 0,
    userStylize: undefined,
    userOptions: undefined,
    showHidden: __inspectDefaultOptions.showHidden,
    depth: __inspectDefaultOptions.depth,
    colors: __inspectDefaultOptions.colors,
    customInspect: __inspectDefaultOptions.customInspect,
    showProxy: __inspectDefaultOptions.showProxy,
    maxArrayLength: __inspectDefaultOptions.maxArrayLength,
    maxStringLength: __inspectDefaultOptions.maxStringLength,
    breakLength: __inspectDefaultOptions.breakLength,
    compact: __inspectDefaultOptions.compact,
    sorted: __inspectDefaultOptions.sorted,
    getters: __inspectDefaultOptions.getters,
    numericSeparator: __inspectDefaultOptions.numericSeparator,
  };
  if (typeof options === "boolean") {
    ctx.showHidden = options;
  } else if (options !== undefined && options !== null && typeof options === "object") {
    for (const key of Object.keys(options)) {
      if (__utilIsInspectOptionKey(key)) {
        ctx[key] = options[key];
      } else if (key === "stylize") {
        ctx.userStylize = options[key];
      } else if (ctx.userOptions === undefined) {
        ctx.userOptions = options;
      }
    }
    // A function-valued property *is* visible to `Object.keys` now (zun#32), so
    // the loop above does find `stylize` and a `sorted` comparator. These two
    // reads by name are kept as a safety net: they are the only options that may
    // hold a function, and a caller who passes one must not silently lose it.
    if (__utilIsFn(options["stylize"])) ctx.userStylize = options["stylize"];
    if (__utilIsFn(options["sorted"])) ctx.sorted = options["sorted"];
  }
  if (ctx.maxArrayLength === null) ctx.maxArrayLength = Infinity;
  if (ctx.maxStringLength === null) ctx.maxStringLength = Infinity;
  return ctx;
}

function __utilIsInspectOptionKey(key: string): boolean {
  for (const known of __INSPECT_OPTION_KEYS) {
    if (known === key) return true;
  }
  return false;
}

// The options object handed to a `[util.inspect.custom]` implementation.
function __utilUserOptions(ctx: any, depth: any): any {
  const ret: any = {
    showHidden: ctx.showHidden,
    depth: depth,
    colors: ctx.colors,
    customInspect: ctx.customInspect,
    showProxy: ctx.showProxy,
    maxArrayLength: ctx.maxArrayLength,
    maxStringLength: ctx.maxStringLength,
    breakLength: ctx.breakLength,
    compact: ctx.compact,
    sorted: ctx.sorted,
    getters: ctx.getters,
    numericSeparator: ctx.numericSeparator,
  };
  if (ctx.userOptions !== undefined && ctx.userOptions !== null) {
    for (const key of Object.keys(ctx.userOptions)) ret[key] = ctx.userOptions[key];
  }
  return ret;
}

// ---------------------------------------------------------------------------
// formatValue
// ---------------------------------------------------------------------------

function inspect(value: any, options?: any): string {
  const ctx = __utilNewCtx(options);
  return __utilFormatValue(ctx, value, 0);
}

function __utilFormatValue(ctx: any, value: any, recurseTimes: number): string {
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") {
    return __utilFormatPrimitive(ctx, value);
  }
  if (value === null) return __utilStylize(ctx, "null", "null");
  if (kind === "function" || __utilIsFn(value)) {
    return __utilFormatFunctionValue(ctx, value, recurseTimes);
  }

  // A byte view is the one built-in whose inspected form Node defines in
  // `lib/buffer.js` rather than in `lib/internal/util/inspect.js`:
  // `Buffer.prototype[util.inspect.custom]` answers `<Buffer 61 62>`, and with
  // `customInspect: false` — which is what `assert` uses for its diff — the
  // generic typed-array form `Buffer(2) [Uint8Array] [ 97, 98 ]` shows through.
  // Both are produced here rather than in `src/buffer/buffer.ts` because `util`
  // is inlined into every bundle while `buffer` is conditional, and because a
  // byte view read through `any` is opaque in this engine — the bytes have to
  // be taken by a `Buffer`-typed parameter (zun#38). `INSPECT_MAX_BYTES` is
  // kept in this file for the same reason, and `node:buffer`'s accessor pair
  // writes through to it.
  //
  // The engine's `Buffer` is a nominal alias for the `Uint8Array` byte-view
  // floor, so `Buffer.isBuffer` cannot tell the two apart and a real
  // `Uint8Array` inspects as a `Buffer` here; Node prints
  // `Uint8Array(2) [ 1, 2 ]` for that one. No engine predicate separates them.
  if (Buffer.isBuffer(value)) {
    return __utilFormatByteView(ctx, value, recurseTimes);
  }

  if (ctx.customInspect === true) {
    const maybeCustom: any = value[__inspectCustomSymbol];
    if (__utilIsFn(maybeCustom)) {
      const depth = ctx.depth === null ? null : Number(ctx.depth) - recurseTimes;
      const produced: any = __utilCall(maybeCustom, [
        depth,
        __utilUserOptions(ctx, depth),
        __utilBox(inspect),
      ]);
      if (produced !== value) {
        if (typeof produced !== "string") {
          return __utilFormatValue(ctx, produced, recurseTimes);
        }
        return __utilIndentLines(produced, Number(ctx.indentationLvl));
      }
    }
  }

  for (const previous of ctx.seen) {
    if (previous === value) {
      return __utilStylize(ctx, "[Circular *" + String(__utilCircularIndex(ctx, value)) + "]", "special");
    }
  }

  return __utilFormatRaw(ctx, value, recurseTimes);
}

function __utilCircularIndex(ctx: any, value: any): number {
  if (ctx.circular === undefined) ctx.circular = new Map();
  const table: any = ctx.circular;
  const existing: any = table.get(value);
  if (existing !== undefined) return Number(existing);
  const index = Number(ctx.circularCount) + 1;
  ctx.circularCount = index;
  table.set(value, index);
  return index;
}

function __utilIndentLines(text: string, indentation: number): string {
  if (indentation === 0) return text;
  const pad = " ".repeat(indentation);
  const n = Number(text.length);
  let out = "";
  for (let i = 0; i < n; i++) {
    const ch = text.charAt(i);
    out = ch === "\n" ? out + "\n" + pad : out + ch;
  }
  return out;
}

function __utilFormatPrimitive(ctx: any, value: any): string {
  const kind = typeof value;
  if (kind === "string") {
    const limit = ctx.maxStringLength;
    let text: string = value;
    let trailer = "";
    if (limit !== Infinity && limit !== null && Number(text.length) > Number(limit)) {
      const remaining = Number(text.length) - Number(limit);
      text = text.slice(0, Number(limit));
      trailer =
        "... " + String(remaining) + " more character" + (remaining > 1 ? "s" : "");
    }
    if (
      ctx.compact !== true &&
      Number(text.length) > 16 &&
      Number(text.length) > Number(ctx.breakLength) - Number(ctx.indentationLvl) - 4
    ) {
      const lines = __utilSplitLongString(ctx, text);
      if (Number(lines.length) > 1) {
        const parts: string[] = [];
        for (const line of lines) parts.push(__utilStylize(ctx, __utilStrEscape(line), "string"));
        return parts.join(" +\n" + " ".repeat(Number(ctx.indentationLvl) + 2)) + trailer;
      }
    }
    return __utilStylize(ctx, __utilStrEscape(text), "string") + trailer;
  }
  if (kind === "number") {
    return __utilStylize(ctx, __utilFormatNumberText(value, ctx.numericSeparator === true), "number");
  }
  if (kind === "bigint") {
    return __utilStylize(ctx, __utilFormatBigIntText(value, ctx.numericSeparator === true), "bigint");
  }
  if (kind === "boolean") return __utilStylize(ctx, String(value), "boolean");
  if (kind === "undefined") return __utilStylize(ctx, "undefined", "undefined");
  if (kind === "symbol") return __utilStylize(ctx, String(value), "symbol");
  return String(value);
}

// Node 25 splits a long string **after each newline only** — `split(/(?<=\n)/)`
// — and joins the pieces with ` +\n<indent>`. (Older Node also broke at word
// boundaries; it no longer does, so a long single-line string stays on one
// line.) Each piece keeps its trailing newline.
function __utilSplitLongString(ctx: any, text: string): string[] {
  const out: string[] = [];
  const n = Number(text.length);
  let start = 0;
  for (let i = 0; i < n; i++) {
    if (__cc(text, i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < n) out.push(text.slice(start));
  return out;
}

function __utilFormatFunctionValue(ctx: any, value: any, recurseTimes: number): string {
  const callable: any = __utilUnbox(value);
  const name: any = callable.name;
  const named = typeof name === "string" && name !== "";
  // Node tells a class from a function with `Function.prototype.toString()`
  // ("class …"), which this engine answers `[any]` to
  // (https://github.com/UrubuCode/zun/issues/36). Two engine signals stand in,
  // and they agree with each other on every form tested (declaration,
  // expression, arrow, class, subclass, anonymous class expression, boxed and
  // unboxed):
  //   * a class value is tagged `[object Object]`, a function
  //     `[object Function]` — itself a divergence from the standard, where both
  //     are `[object Function]`;
  //   * a class exposes `.prototype`, while a function value answers
  //     `undefined` for it (it carries none of its own properties — zun#25).
  // Both are read off the *unboxed* callable, and a record that could not be
  // opened is excluded explicitly, because a `functionBox` is tagged
  // `[object Object]` exactly like a class: that is what made every ordinary
  // function print as `[class (anonymous)]`.
  // `[class Foo extends Bar]` is not reachable: the base is not readable.
  if (
    !__utilIsBox(callable) &&
    (__utilTag(callable) === "[object Object]" || callable.prototype !== undefined)
  ) {
    return __utilStylize(ctx, named ? "[class " + name + "]" : "[class (anonymous)]", "special");
  }
  // Node builds the prefix from the kind — `[AsyncFunction: f]`,
  // `[GeneratorFunction: f]`, `[Function: bound f]` — which it reads off the
  // object tag. This engine tags every callable `[object Function]`, so every
  // one prints `[Function …]`; deriving the word from the tag the way Node does
  // means the other kinds appear on their own if the engine ever tags them.
  let type = "Function";
  const tag = __utilTag(callable);
  const inner = tag.slice(8, Number(tag.length) - 1);
  if (inner !== "Function" && inner.slice(Number(inner.length) - 8) === "Function") {
    type = inner;
  }
  const label = named ? "[" + type + ": " + name + "]" : "[" + type + " (anonymous)]";
  return __utilStylize(ctx, label, "special");
}

// ---------------------------------------------------------------------------
// formatRaw: objects
// ---------------------------------------------------------------------------

function __utilFormatRaw(ctx: any, value: any, recurseTimes: number): string {
  const tag = __utilTag(value);
  const ctorName = __utilCtorName(value);
  const prefixBase = ctorName === "" || ctorName === "Object" ? "" : ctorName;

  let braces: string[] = ["{", "}"];
  let base = "";
  let kind = "object";
  let keysSource: any = value;

  if (Array.isArray(value)) {
    kind = "array";
    braces = ["[", "]"];
    if (prefixBase !== "" && prefixBase !== "Array") {
      braces[0] = prefixBase + "(" + String(Number(value.length)) + ") [";
    }
  } else if (tag === "[object Map]") {
    kind = "map";
    braces = [(prefixBase === "" ? "Map" : prefixBase) + "(" + String(Number(value.size)) + ") {", "}"];
  } else if (tag === "[object Set]") {
    kind = "set";
    braces = [(prefixBase === "" ? "Set" : prefixBase) + "(" + String(Number(value.size)) + ") {", "}"];
  } else if (tag === "[object RegExp]") {
    kind = "regexp";
    base = __utilStylize(ctx, __utilRegExpSource(value), "regexp");
  } else if (tag === "[object Promise]") {
    kind = "promise";
    braces = ["Promise {", "}"];
  } else if (value instanceof Date) {
    kind = "date";
    base = __utilStylize(ctx, __utilDateText(value), "date");
  } else if (value instanceof Error) {
    kind = "error";
    base = __utilFormatError(ctx, value);
  } else if (prefixBase !== "") {
    braces = [prefixBase + " {", "}"];
  }

  // Past the depth limit a value collapses to `[<its kind>]`: `[Array]`,
  // `[Object]`, `[Map]`, `[Set]`, `[Promise]`, `[Foo]` for a class instance. A
  // `RegExp`, a `Date` and an `Error` keep their own one-line form, as in Node.
  if (
    (recurseTimes > Number(ctx.depth) && ctx.depth !== null) ||
    Number(ctx.depth) < 0
  ) {
    if (kind === "regexp" || kind === "date" || kind === "error") return base;
    let label = prefixBase;
    if (label === "") {
      if (kind === "array") label = "Array";
      else if (kind === "map") label = "Map";
      else if (kind === "set") label = "Set";
      else if (kind === "promise") label = "Promise";
      else label = "Object";
    }
    return __utilStylize(ctx, "[" + label + "]", "special");
  }

  ctx.seen.push(value);
  ctx.currentDepth = recurseTimes;
  let output: string[] = [];
  const extrasType = kind === "array" ? 2 : 0;

  if (kind === "array") {
    output = __utilFormatArray(ctx, value, recurseTimes);
  } else if (kind === "map") {
    output = __utilFormatMap(ctx, value, recurseTimes);
  } else if (kind === "set") {
    output = __utilFormatSet(ctx, value, recurseTimes);
  } else if (kind === "promise") {
    output = [__utilStylize(ctx, "<pending>", "special")];
  }

  // Two built-ins report own keys they do not have in Node. A `Date` exposes an
  // internal `millis`, so enumerating it would print
  // `1970-01-01T00:00:00.000Z { millis: 0 }`. A `Promise` reports a *foreign*
  // class's field names in a program that declares many classes — inside the
  // test bundle `Object.keys(Promise.resolve(1))` answers `['code']`, which is
  // `NodeError`'s declared field, while the same expression in a small program
  // answers `[]`. Both are engine bugs; neither value can carry a user property
  // in Node's sense here, so both are simply not enumerated. (`Map`, `Set`,
  // `RegExp`, `Error`, plain objects and arrays were all verified clean in the
  // same bundle.)
  let extraCount = 0;
  if (kind === "date" || kind === "promise") {
    // no own properties to show
  } else if (kind !== "array") {
    const extra = __utilFormatKeys(ctx, value, recurseTimes, kind === "error");
    for (const entry of extra) output.push(entry);
    extraCount = Number(extra.length);
  } else {
    const extra = __utilFormatExtraArrayKeys(ctx, value, recurseTimes);
    for (const entry of extra) output.push(entry);
    extraCount = Number(extra.length);
  }

  ctx.seen.pop();

  // `sorted: true | comparator`. For an object-shaped body every entry is
  // sorted; for an array only the trailing *named* keys are, so the elements
  // keep their index order — Node's split on `extrasType`.
  if (ctx.sorted !== false && ctx.sorted !== undefined) {
    if (extrasType === 0) {
      output = __utilSortOutput(ctx, output, 0);
    } else if (extraCount > 1) {
      output = __utilSortOutput(ctx, output, Number(output.length) - extraCount);
    }
  }

  if ((kind === "regexp" || kind === "date") && Number(output.length) === 0) {
    return base;
  }
  if (kind === "error" && Number(output.length) === 0) {
    return base;
  }
  if (kind === "regexp" || kind === "date") {
    braces = ["{", "}"];
  }

  const circularIndex: any =
    ctx.circular === undefined ? undefined : ctx.circular.get(value);

  // An empty body collapses to the braces themselves: `{}`, `[]`, `Map(0) {}`,
  // `Foo {}` — never `{  }`.
  if (Number(output.length) === 0) {
    const empty = (base === "" ? "" : base + " ") + braces[0] + braces[1];
    if (circularIndex !== undefined) {
      return __utilStylize(ctx, "<ref *" + String(circularIndex) + ">", "special") + " " + empty;
    }
    return empty;
  }

  const result = __utilReduceToSingleString(
    ctx, output, base, braces, extrasType, recurseTimes, kind === "array" ? value : undefined,
  );
  __utilChargeBudget(ctx, Number(result.length));
  if (circularIndex !== undefined) {
    return __utilStylize(ctx, "<ref *" + String(circularIndex) + ">", "special") + " " + result;
  }
  return result;
}

// Node's output budget: the rendered length produced at each indentation level
// is accumulated and, once any level passes 2**27 characters, `ctx.depth` drops
// to -1 so everything further collapses to `[Object]`. Without it a huge or
// deeply shared object graph keeps inspecting past the maximum string size.
function __utilChargeBudget(ctx: any, length: number): void {
  const level = String(Number(ctx.indentationLvl));
  const current: any = ctx.budget[level];
  const total = (current === undefined ? 0 : Number(current)) + length;
  ctx.budget[level] = total;
  if (total > 134217728) ctx.depth = -1;
}

function __utilRegExpSource(value: any): string {
  const source: any = value.source;
  const flags: any = value.flags;
  if (typeof source === "string") {
    return "/" + source + "/" + (typeof flags === "string" ? flags : "");
  }
  return String(value);
}

function __utilDateText(value: any): string {
  const time = Number(value.getTime());
  if (Number.isNaN(time)) return "Invalid Date";
  return String(value.toISOString());
}

function __utilFormatError(ctx: any, value: any): string {
  const stack: any = value.stack;
  if (typeof stack === "string" && stack !== "") return stack;
  const name: any = value.name;
  const message: any = value.message;
  const label = typeof name === "string" && name !== "" ? name : "Error";
  if (message === undefined || message === "") return "[" + label + "]";
  return label + ": " + String(message);
}

function __utilFormatArray(ctx: any, value: any, recurseTimes: number): string[] {
  const length = Number(value.length);
  const limit = ctx.maxArrayLength === Infinity ? length : Number(ctx.maxArrayLength);
  const shown = length < limit ? length : limit;
  const remaining = length - shown;
  const output: string[] = [];
  for (let i = 0; i < shown; i++) {
    output.push(__utilFormatValue(ctx, value[i], recurseTimes + 1));
  }
  if (remaining > 0) {
    output.push("... " + String(remaining) + " more item" + (remaining > 1 ? "s" : ""));
  }
  return output;
}

// ---------------------------------------------------------------------------
// Byte views: `<Buffer 61 62>` and `Buffer(2) [Uint8Array] [ 97, 98 ]`
// ---------------------------------------------------------------------------
//
// `buffer.INSPECT_MAX_BYTES`. The value lives here because `util` is inlined
// into every bundle while `src/buffer/buffer.ts` is conditional, and Node's own
// coupling runs the same way round at the point of use: `lib/buffer.js`'s
// custom inspector reads the module-scoped `INSPECT_MAX_BYTES` that its
// accessor pair on `module.exports` writes. `node:buffer`'s setter calls
// `__utilSetInspectMaxBytes` after running Node's `validateNumber`.
let __utilInspectMaxBytes: number = 50;

function __utilGetInspectMaxBytes(): number {
  return __utilInspectMaxBytes;
}

function __utilSetInspectMaxBytes(value: number): void {
  __utilInspectMaxBytes = value;
}

// The bytes of a view can only be reached through a `Buffer`-typed parameter:
// the same value read through `any` answers `undefined` for `.length` and does
// not resolve a method (zun#38). These three take it that way.
function __utilByteViewLength(view: Buffer): number {
  return Number(view.length);
}

function __utilByteViewByte(view: Buffer, index: number): number {
  return Number(view[index]);
}

// Node's `this.hexSlice(0, actualMax)` with a space after every pair, which is
// `StringPrototypeTrim(RegExpPrototypeSymbolReplace(/(.{2})/g, …, '$1 '))`.
function __utilByteViewHex(view: Buffer, count: number): string {
  if (count <= 0) return "";
  const hex = view.toString("hex", 0 as u64, count as u64);
  const chars = Number(hex.length);
  let out = "";
  for (let i = 0; i < chars; i = i + 2) {
    if (i > 0) out = out + " ";
    out = out + hex.slice(i, i + 2);
  }
  return out;
}

function __utilFormatByteView(ctx: any, value: any, recurseTimes: number): string {
  const length = __utilByteViewLength(value);

  // `lib/buffer.js`: `<Buffer 61 62 ... 3 more bytes>`, with the byte count
  // capped by `INSPECT_MAX_BYTES` and an empty buffer rendering as `<Buffer >`.
  // The "inspect special properties as well" tail of Node's inspector has no
  // counterpart here — a byte view carries no own non-index properties in this
  // engine — and the constructor-name lookup is always `Buffer`.
  if (ctx.customInspect === true) {
    const max = __utilInspectMaxBytes;
    const actualMax = length < max ? length : max;
    let str = __utilByteViewHex(value, actualMax);
    const remaining = length - max;
    if (remaining > 0) {
      str = str + " ... " + String(remaining) + " more byte" + (remaining > 1 ? "s" : "");
    }
    return "<Buffer " + str + ">";
  }

  // `customInspect: false` — which is how `assert` renders its diff — falls
  // through to the generic typed-array body.
  if ((recurseTimes > Number(ctx.depth) && ctx.depth !== null) || Number(ctx.depth) < 0) {
    return __utilStylize(ctx, "[Buffer]", "special");
  }
  const limit = ctx.maxArrayLength === Infinity ? length : Number(ctx.maxArrayLength);
  const shown = length < limit ? length : limit;
  const remaining = length - shown;
  const output: string[] = [];
  // `elements` is what Node passes `groupArrayElements` as the backing value:
  // the view itself, which it indexes one past the shown range when the body is
  // truncated. Only that many bytes are materialized.
  const elements: number[] = [];
  for (let i = 0; i < shown; i++) {
    const byte = __utilByteViewByte(value, i);
    elements.push(byte);
    output.push(__utilStylize(ctx, String(byte), "number"));
  }
  if (remaining > 0) {
    elements.push(__utilByteViewByte(value, shown));
    output.push("... " + String(remaining) + " more item" + (remaining > 1 ? "s" : ""));
  }
  const braces: string[] = ["Buffer(" + String(length) + ") [Uint8Array] [", "]"];
  if (Number(output.length) === 0) return braces[0] + braces[1];
  return __utilReduceToSingleString(ctx, output, "", braces, 2, recurseTimes, elements);
}

function __utilFormatMap(ctx: any, value: any, recurseTimes: number): string[] {
  const output: string[] = [];
  ctx.indentationLvl = Number(ctx.indentationLvl) + 2;
  for (const entry of value) {
    output.push(
      __utilFormatValue(ctx, entry[0], recurseTimes + 1) +
        " => " +
        __utilFormatValue(ctx, entry[1], recurseTimes + 1),
    );
  }
  ctx.indentationLvl = Number(ctx.indentationLvl) - 2;
  return output;
}

function __utilFormatSet(ctx: any, value: any, recurseTimes: number): string[] {
  const output: string[] = [];
  ctx.indentationLvl = Number(ctx.indentationLvl) + 2;
  for (const entry of value) {
    output.push(__utilFormatValue(ctx, entry, recurseTimes + 1));
  }
  ctx.indentationLvl = Number(ctx.indentationLvl) - 2;
  return output;
}

// An identifier-shaped key prints bare and is stylized as `name`; anything else
// is quoted and stylized as `string`. The shape is Node's `keyStrRegExp`,
// `/^[a-zA-Z_][a-zA-Z_0-9]*$/` — note that `$` is *not* in it, so `{ $a: 1 }`
// inspects as `{ '$a': 1 }`. `inspect.styles` deliberately has no `name` entry,
// so the key is uncoloured under `colors: true`; a user `stylize` still sees it.
function __utilInspectKey(ctx: any, key: string): string {
  const n = Number(key.length);
  let identifier = n > 0;
  for (let i = 0; i < n; i++) {
    const code = __cc(key, i);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    const isUnderscore = code === 95;
    if (!isLetter && !isUnderscore && !(isDigit && i > 0)) {
      identifier = false;
      break;
    }
  }
  if (identifier) return __utilStylize(ctx, key, "name");
  return __utilStylize(ctx, __utilStrEscape(key), "string");
}

function __utilFormatKeys(ctx: any, value: any, recurseTimes: number, isError: boolean): string[] {
  const output: string[] = [];
  const keys: any = __utilOwnKeys(value);
  ctx.indentationLvl = Number(ctx.indentationLvl) + 2;
  for (const key of keys) {
    if (isError && (key === "stack" || key === "message")) continue;
    output.push(
      __utilInspectKey(ctx, key) + ": " + __utilFormatValue(ctx, value[key], recurseTimes + 1),
    );
  }
  for (const sym of Object.getOwnPropertySymbols(value)) {
    const label = "[" + __utilStylize(ctx, String(sym), "symbol") + "]";
    output.push(label + ": " + __utilFormatValue(ctx, value[sym], recurseTimes + 1));
  }
  ctx.indentationLvl = Number(ctx.indentationLvl) - 2;
  return output;
}

// `Object.keys` is read defensively: `test-util-primordial-monkeypatching.js`
// replaces it with a thrower and expects `inspect({})` to be unaffected. There
// is no %ObjectKeys% primordial to capture in this engine, so the call is
// guarded instead — which produces the same observable result for that test and
// degrades to "no own string keys" if the replacement throws.
function __utilOwnKeys(value: any): any[] {
  try {
    const keys: any = Object.keys(value);
    return keys;
  } catch (error) {
    return [];
  }
}

// Array indices come from the element walk; only the non-index keys are extra.
function __utilFormatExtraArrayKeys(ctx: any, value: any, recurseTimes: number): string[] {
  const output: string[] = [];
  const keys: any = __utilOwnKeys(value);
  ctx.indentationLvl = Number(ctx.indentationLvl) + 2;
  for (const key of keys) {
    if (__utilIsIndexKey(key)) continue;
    output.push(
      __utilInspectKey(ctx, key) + ": " + __utilFormatValue(ctx, value[key], recurseTimes + 1),
    );
  }
  ctx.indentationLvl = Number(ctx.indentationLvl) - 2;
  return output;
}

function __utilIsIndexKey(key: string): boolean {
  const n = Number(key.length);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    const code = __cc(key, i);
    if (code < 48 || code > 57) return false;
  }
  return n === 1 || __cc(key, 0) !== 48;
}

// Sort `output` from `from` onwards. An insertion sort rather than
// `Array.prototype.sort`, because `ctx.sorted` may be a user comparator held in
// an `any` — which has to be reached through `__utilCall`, and a dynamic
// callback is not accepted as a `sort` argument here.
function __utilSortOutput(ctx: any, output: string[], from: number): string[] {
  const copy: string[] = [];
  for (const entry of output) copy.push(entry);
  const comparator: any = ctx.sorted === true ? undefined : ctx.sorted;
  const n = Number(copy.length);
  for (let i = from + 1; i < n; i++) {
    const current = copy[i];
    let j = i - 1;
    while (j >= from && __utilCompareEntries(comparator, copy[j], current) > 0) {
      copy[j + 1] = copy[j];
      j = j - 1;
    }
    copy[j + 1] = current;
  }
  return copy;
}

function __utilCompareEntries(comparator: any, a: string, b: string): number {
  if (comparator !== undefined && comparator !== null && __utilIsFn(comparator)) {
    return Number(__utilCall(comparator, [a, b]));
  }
  // The default is `Array.prototype.sort`'s: compare the UTF-16 strings.
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Line breaking (Node's reduceToSingleString / groupArrayElements)
// ---------------------------------------------------------------------------

function __utilIsBelowBreakLength(ctx: any, output: string[], start: number, base: string): boolean {
  let totalLength = Number(output.length) + start;
  if (totalLength + Number(output.length) > Number(ctx.breakLength)) return false;
  for (const entry of output) {
    totalLength = totalLength + __utilWidth(entry, ctx.colors === true);
    if (totalLength > Number(ctx.breakLength)) return false;
  }
  return base === "" || Number(base.indexOf("\n")) === -1;
}

function __utilReduceToSingleString(
  ctx: any,
  output: string[],
  base: string,
  braces: string[],
  extrasType: number,
  recurseTimes: number,
  value: any,
): string {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === "number" && Number(ctx.compact) >= 1) {
      const entries = Number(output.length);
      let working: string[] = output;
      if (extrasType === 2 && entries > 6) {
        working = __utilGroupArrayElements(ctx, output, value);
      }
      if (
        Number(ctx.currentDepth) - recurseTimes < Number(ctx.compact) &&
        entries === Number(working.length)
      ) {
        const start =
          Number(working.length) + Number(ctx.indentationLvl) +
          Number(braces[0].length) + Number(base.length) + 10;
        if (__utilIsBelowBreakLength(ctx, working, start, base)) {
          const joined = working.join(", ");
          if (Number(joined.indexOf("\n")) === -1) {
            return (base === "" ? "" : base + " ") + braces[0] + " " + joined + " " + braces[1];
          }
        }
      }
      output = working;
    }
    const indentation = "\n" + " ".repeat(Number(ctx.indentationLvl));
    return (
      (base === "" ? "" : base + " ") + braces[0] + indentation + "  " +
      output.join("," + indentation + "  ") + indentation + braces[1]
    );
  }
  if (__utilIsBelowBreakLength(ctx, output, 0, base)) {
    return braces[0] + (base === "" ? "" : " " + base) + " " + output.join(", ") + " " + braces[1];
  }
  const indentation = " ".repeat(Number(ctx.indentationLvl));
  const ln =
    base === "" && Number(braces[0].length) === 1
      ? " "
      : (base === "" ? "" : " " + base) + "\n" + indentation + "  ";
  return braces[0] + ln + output.join(",\n" + indentation + "  ") + " " + braces[1];
}

function __utilGroupArrayElements(ctx: any, output: string[], value: any): string[] {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = Number(output.length);
  if (Number(ctx.maxArrayLength) < Number(output.length)) outputLength = outputLength - 1;
  const separatorSpace = 2;
  const dataLen: number[] = [];
  for (let i = 0; i < outputLength; i++) {
    const len = __utilWidth(output[i], ctx.colors === true);
    dataLen.push(len);
    totalLength = totalLength + len + separatorSpace;
    if (maxLength < len) maxLength = len;
  }
  const actualMax = maxLength + separatorSpace;
  if (
    actualMax * 3 + Number(ctx.indentationLvl) < Number(ctx.breakLength) &&
    (totalLength / actualMax > 5 || maxLength <= 6)
  ) {
    const approxCharHeights = 2.5;
    const averageBias = Math.sqrt(actualMax - totalLength / Number(output.length));
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      Math.round(Math.sqrt(approxCharHeights * biasedMax * outputLength) / biasedMax),
      Math.min(
        Math.floor((Number(ctx.breakLength) - Number(ctx.indentationLvl)) / actualMax),
        Math.min(Number(ctx.compact) * 4, 15),
      ),
    );
    if (columns <= 1) return output;
    const maxLineLength: number[] = [];
    for (let i = 0; i < columns; i++) {
      let lineMaxLength = 0;
      for (let j = i; j < Number(output.length); j = j + columns) {
        if (j < Number(dataLen.length) && dataLen[j] > lineMaxLength) lineMaxLength = dataLen[j];
      }
      maxLineLength.push(lineMaxLength + separatorSpace);
    }
    // Numeric arrays are right-aligned, everything else left-aligned.
    let padStart = true;
    if (value !== undefined) {
      for (let i = 0; i < Number(output.length); i++) {
        const element: any = value[i];
        if (typeof element !== "number" && typeof element !== "bigint") {
          padStart = false;
          break;
        }
      }
    } else {
      padStart = false;
    }
    const tmp: string[] = [];
    for (let i = 0; i < outputLength; i = i + columns) {
      const max = Math.min(i + columns, outputLength);
      let str = "";
      let j = i;
      while (j < max - 1) {
        const padding = maxLineLength[j - i] + Number(output[j].length) - dataLen[j];
        const cell = output[j] + ", ";
        str = str + (padStart ? cell.padStart(padding, " ") : cell.padEnd(padding, " "));
        j = j + 1;
      }
      if (padStart) {
        const padding =
          maxLineLength[j - i] + Number(output[j].length) - dataLen[j] - separatorSpace;
        str = str + output[j].padStart(padding, " ");
      } else {
        str = str + output[j];
      }
      tmp.push(str);
    }
    if (Number(ctx.maxArrayLength) < Number(output.length)) tmp.push(output[outputLength]);
    return tmp;
  }
  return output;
}

// `util.inspect`'s own properties. `inspect` is a declaration rather than an
// object-literal method precisely so these can be attached (zun#14).
(inspect as any).custom = __inspectCustomSymbol;
(inspect as any).colors = __inspectColors;
(inspect as any).styles = __inspectStyles;
(inspect as any).defaultOptions = __inspectDefaultOptions;
(highlightRegExp as any).colors = __HIGHLIGHT_REGEXP_COLORS;

// `inspect.defaultOptions = { … }` merges in Node (the property is an accessor
// whose setter calls `Object.assign`). An accessor on a function value is not
// expressible here, so the merge is also offered as a method.
function __inspectSetDefaultOptions(options: any): any {
  __utilValidateObject(options, "options");
  for (const key of Object.keys(options)) __inspectDefaultOptions[key] = options[key];
  return __inspectDefaultOptions;
}
(inspect as any).setDefaultOptions = __utilBox(__inspectSetDefaultOptions);

// ===========================================================================
// util.format / util.formatWithOptions
// ===========================================================================

function format(...args: any[]): string {
  return __utilFormatWithOptions(__inspectDefaultOptions, args);
}

function formatWithOptions(inspectOptions: any, ...args: any[]): string {
  __utilValidateObject(inspectOptions, "inspectOptions");
  return __utilFormatWithOptions(inspectOptions, args);
}

function __utilInspectWith(value: any, inspectOptions: any, overrides: any): string {
  const merged: any = {};
  for (const key of Object.keys(inspectOptions)) merged[key] = inspectOptions[key];
  if (overrides !== undefined) {
    for (const key of Object.keys(overrides)) merged[key] = overrides[key];
  }
  return inspect(value, merged);
}

// `hasBuiltInToString(value)` — **true** when the value stringifies through a
// *built-in* `toString`, which is when `%s` inspects it instead of calling
// `String()` on it. Node answers this by walking the prototype chain to the
// nearest object with an own `toString` (or `Symbol.toPrimitive`) and asking
// whether that object's `constructor` is one of the known built-ins. There is no
// prototype chain to walk here, so the same question is answered in two steps:
// the built-in classes the inspector already recognises answer `true` outright,
// and for everything else a custom `toString`/`Symbol.toPrimitive` is detected
// by probing what it produces — `[object …]` means the built-in ran.
function __utilHasBuiltInToString(value: any): boolean {
  if (Array.isArray(value)) return true;
  if (value instanceof Date) return true;
  if (value instanceof Error) return true;
  const tag = __utilTag(value);
  if (
    tag === "[object Map]" || tag === "[object Set]" ||
    tag === "[object RegExp]" || tag === "[object Promise]"
  ) {
    return true;
  }
  if (!__utilIsFn(value["toString"]) && !__utilIsFn(value[Symbol.toPrimitive])) {
    return true;
  }
  const produced: any = String(value);
  if (typeof produced !== "string") return true;
  return Number(produced.indexOf("[object ")) === 0;
}

function __utilTryStringify(value: any): string {
  try {
    const produced: any = JSON.stringify(value);
    return produced === undefined ? "undefined" : String(produced);
  } catch (error) {
    const err: any = error;
    const message: any = err === null || err === undefined ? "" : err.message;
    if (typeof message === "string" && Number(message.indexOf("circular")) !== -1) {
      return "[Circular]";
    }
    throw error;
  }
}

function __utilFormatWithOptions(inspectOptions: any, args: any[]): string {
  const count = Number(args.length);
  if (count === 0) return "";
  const first: any = args[0];
  let a = 0;
  let str = "";
  let join = "";
  const numericSeparator = inspectOptions["numericSeparator"] === true;

  if (typeof first === "string") {
    if (count === 1) return first;
    let tempStr = "";
    let lastPos = 0;
    const n = Number(first.length);
    for (let i = 0; i < n - 1; i++) {
      if (__cc(first, i) === 37) {
        i = i + 1;
        const nextChar = __cc(first, i);
        if (a + 1 !== count) {
          let handled = true;
          if (nextChar === 115) {
            a = a + 1;
            const arg: any = args[a];
            if (typeof arg === "number") {
              tempStr = __utilFormatNumberText(arg, numericSeparator);
            } else if (typeof arg === "bigint") {
              tempStr = __utilFormatBigIntText(arg, numericSeparator);
            } else if (
              typeof arg !== "object" || arg === null || !__utilHasBuiltInToString(arg)
            ) {
              tempStr = String(arg);
            } else {
              tempStr = __utilInspectWith(arg, inspectOptions, {
                compact: 3,
                colors: false,
                depth: 0,
              });
            }
          } else if (nextChar === 106) {
            a = a + 1;
            tempStr = __utilTryStringify(args[a]);
          } else if (nextChar === 100) {
            a = a + 1;
            const arg: any = args[a];
            if (typeof arg === "bigint") {
              tempStr = __utilFormatBigIntText(arg, numericSeparator);
            } else if (typeof arg === "symbol") {
              tempStr = "NaN";
            } else {
              tempStr = __utilFormatNumberText(Number(arg), numericSeparator);
            }
          } else if (nextChar === 79) {
            a = a + 1;
            tempStr = __utilInspectWith(args[a], inspectOptions, undefined);
          } else if (nextChar === 111) {
            a = a + 1;
            tempStr = __utilInspectWith(args[a], inspectOptions, {
              showHidden: true,
              showProxy: true,
              depth: 4,
            });
          } else if (nextChar === 105) {
            a = a + 1;
            const arg: any = args[a];
            if (typeof arg === "bigint") {
              tempStr = __utilFormatBigIntText(arg, numericSeparator);
            } else if (typeof arg === "symbol") {
              tempStr = "NaN";
            } else {
              tempStr = __utilFormatNumberText(Number.parseInt(arg), numericSeparator);
            }
          } else if (nextChar === 102) {
            a = a + 1;
            const arg: any = args[a];
            if (typeof arg === "symbol") {
              tempStr = "NaN";
            } else {
              tempStr = __utilFormatNumberText(Number.parseFloat(arg), numericSeparator);
            }
          } else if (nextChar === 99) {
            a = a + 1;
            tempStr = "";
          } else if (nextChar === 37) {
            str = str + first.slice(lastPos, i);
            lastPos = i + 1;
            handled = false;
          } else {
            handled = false;
          }
          if (handled) {
            if (lastPos !== i - 1) str = str + first.slice(lastPos, i - 1);
            str = str + tempStr;
            lastPos = i + 1;
          }
        } else if (nextChar === 37) {
          str = str + first.slice(lastPos, i);
          lastPos = i + 1;
        }
      }
    }
    if (lastPos !== 0) {
      a = a + 1;
      join = " ";
      if (lastPos < n) str = str + first.slice(lastPos);
    }
  }

  while (a < count) {
    const value: any = args[a];
    str = str + join;
    str = str + (typeof value !== "string" ? __utilInspectWith(value, inspectOptions, undefined) : value);
    join = " ";
    a = a + 1;
  }
  return str;
}

// ===========================================================================
// util.styleText
// ===========================================================================

function styleText(formatSpec: any, text: any, options?: any): string {
  __utilValidateString(text, "text");
  let validateStream = true;
  let stream: any = process.stdout;
  if (options !== undefined && options !== null) {
    __utilValidateObject(options, "options");
    if (options["validateStream"] !== undefined) validateStream = options["validateStream"];
    if (options["stream"] !== undefined) stream = options["stream"];
  }
  __utilValidateBoolean(validateStream, "options.validateStream");

  let skipColorize = false;
  if (validateStream) {
    if (!__utilIsStreamLike(stream)) {
      throw new ERR_INVALID_ARG_TYPE(
        "stream",
        ["ReadableStream", "WritableStream", "Stream"],
        stream,
      );
    }
    skipColorize = !__utilShouldColorize(stream);
  }

  const formatArray: any[] = Array.isArray(formatSpec) ? formatSpec : [formatSpec];
  const codes: any[] = [];
  for (const key of formatArray) {
    if (key === "none") continue;
    const formatCodes: any = typeof key === "string" ? __inspectColors[key] : undefined;
    if (formatCodes === undefined || formatCodes === null) {
      __utilValidateOneOf(key, "format", __INSPECT_COLOR_NAMES);
    }
    if (skipColorize) continue;
    codes.push(formatCodes);
  }
  if (skipColorize) return text;

  let openCodes = "";
  for (const code of codes) openCodes = openCodes + __utilEscapeStyleCode(code[0]);

  let processedText: string = text;
  if (Number(codes.length) > 0) {
    for (const code of codes) {
      processedText = __utilReapplyStyle(processedText, code);
    }
  }

  let closeCodes = "";
  for (let i = Number(codes.length) - 1; i >= 0; i--) {
    closeCodes = closeCodes + __utilEscapeStyleCode(codes[i][1]);
  }
  return openCodes + processedText + closeCodes;
}

// Replace each occurrence of this style's reset code inside `text` so a nested
// `styleText` call does not cancel the outer style — Node's `ArrayPrototypeReduce`
// over `RegExpPrototypeSymbolReplace`, spelled as a scan so no regular
// expression has to be built from a string.
function __utilReapplyStyle(text: string, code: any): string {
  const marker = "\u001b[" + String(code[1]) + "m";
  const markerLen = Number(marker.length);
  const dimOrBold = Number(code[0]) === 2 || Number(code[0]) === 1;
  const n = Number(text.length);
  let out = "";
  let i = 0;
  while (i < n) {
    if (text.slice(i, i + markerLen) === marker) {
      if (i + markerLen < n) {
        out = out + (dimOrBold ? marker + __utilEscapeStyleCode(code[0]) : __utilEscapeStyleCode(code[0]));
      } else {
        out = out + marker;
      }
      i = i + markerLen;
      continue;
    }
    out = out + text.charAt(i);
    i = i + 1;
  }
  return out;
}

function __utilIsStreamLike(stream: any): boolean {
  if (stream === null || stream === undefined) return false;
  if (typeof stream !== "object" && typeof stream !== "function") return false;
  if (__utilIsFn(stream["write"])) return true;
  if (__utilIsFn(stream["pipe"])) return true;
  if (__utilIsFn(stream["getReader"])) return true;
  return stream["readable"] !== undefined || stream["writable"] !== undefined;
}

// `lib/internal/util/colors.js`' `shouldColorize`, reduced to what is readable
// here: the environment overrides plus the stream's own `hasColors`.
function __utilShouldColorize(stream: any): boolean {
  if (__utilEnv("NODE_DISABLE_COLORS") !== undefined) return false;
  if (__utilEnv("NO_COLOR") !== undefined) return false;
  const forced = __utilEnv("FORCE_COLOR");
  if (forced !== undefined) return String(forced) !== "0";
  if (stream !== null && stream !== undefined && __utilIsFn(stream["hasColors"])) {
    return __utilCall(stream["hasColors"], []) === true;
  }
  return false;
}

function __utilEnv(name: string): any {
  const direct: any = process.env[name];
  if (direct !== undefined) return direct;
  return process.envLookup(name);
}

// ===========================================================================
// util.isDeepStrictEqual (lib/internal/util/comparisons.js)
// ===========================================================================

// `skipPrototype` (Node 25) compares structure only: two values with different
// constructors but the same own properties are equal.
function isDeepStrictEqual(a: any, b: any, skipPrototype?: any): boolean {
  // Node tests `if (skipPrototype)`; the ternary is the spelling that survives
  // `!x` on an `any`-typed empty string (zun#13).
  const skip: boolean = skipPrototype ? true : false;
  return __utilInnerDeepEqual(a, b, [], skip);
}

function __utilDeepSame(a: any, b: any): boolean {
  if (__utilUnbox(a) === __utilUnbox(b)) {
    // +0 and -0 are distinct under strict deep equality.
    if (a === 0 && b === 0) return 1 / a === 1 / b;
    return true;
  }
  // NaN equals NaN here, unlike `===`.
  return typeof a === "number" && typeof b === "number" &&
    Number.isNaN(a) && Number.isNaN(b);
}

function __utilInnerDeepEqual(a: any, b: any, seen: any[], skipProto: boolean): boolean {
  if (__utilDeepSame(a, b)) return true;
  // One side may be a `functionBox` record and the other the bare callable
  // (zun#17), in which case `typeof` disagrees even though the two are the same
  // function. Unwrapping both restores JavaScript's own answer, which is what
  // makes `deepStrictEqual(ee.listeners('x'), [listener])` behave in Node's
  // events corpus.
  const callableA: any = __utilUnbox(a);
  const callableB: any = __utilUnbox(b);
  if (typeof callableA === "function" || typeof callableB === "function") {
    return callableA === callableB;
  }
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object") return false;

  const tagA = __utilTag(a);
  const tagB = __utilTag(b);
  if (tagA !== tagB) return false;

  // Prototype identity: strict deep equality requires the same constructor,
  // unless `skipPrototype` asked for a structural comparison.
  if (!skipProto && __utilCtorName(a) !== __utilCtorName(b)) return false;

  if (a instanceof Date) {
    return b instanceof Date && Number(a.getTime()) === Number(b.getTime());
  }
  if (tagA === "[object RegExp]") {
    return String(a.source) === String(b.source) && String(a.flags) === String(b.flags);
  }
  if (a instanceof Error) {
    if (String(a.name) !== String(b.name)) return false;
    if (String(a.message) !== String(b.message)) return false;
    // Node compares `cause` and `errors` as well, and deliberately not `stack`
    // (`lib/internal/util/comparisons.js`' `isError` branch). Both are
    // *readable* here but are not own properties — `Object.keys(new Error('a',
    // { cause: e }))` is empty — so the key walk below never reaches them and
    // two errors differing only in their cause used to compare equal.
    if (!__utilInnerDeepEqual(a.cause, b.cause, seen, skipProto)) return false;
    if (!__utilInnerDeepEqual(a.errors, b.errors, seen, skipProto)) return false;
  }

  for (const pair of seen) {
    if (pair[0] === a && pair[1] === b) return true;
  }
  seen.push([a, b]);

  let equal = true;
  if (Array.isArray(a) !== Array.isArray(b)) {
    equal = false;
  } else if (Array.isArray(a)) {
    if (Number(a.length) !== Number(b.length)) {
      equal = false;
    } else {
      const n = Number(a.length);
      for (let i = 0; i < n; i++) {
        if (!__utilInnerDeepEqual(a[i], b[i], seen, skipProto)) {
          equal = false;
          break;
        }
      }
    }
  } else if (tagA === "[object Map]") {
    equal = __utilDeepEqualMap(a, b, seen, skipProto);
  } else if (tagA === "[object Set]") {
    equal = __utilDeepEqualSet(a, b, seen, skipProto);
  }

  if (equal) equal = __utilDeepEqualKeys(a, b, seen, skipProto);
  seen.pop();
  return equal;
}

function __utilDeepEqualKeys(a: any, b: any, seen: any[], skipProto: boolean): boolean {
  const aKeys: any = Object.keys(a);
  const bKeys: any = Object.keys(b);
  if (Number(aKeys.length) !== Number(bKeys.length)) return false;
  for (const key of aKeys) {
    if (!Object.hasOwn(b, key)) return false;
    if (!__utilInnerDeepEqual(a[key], b[key], seen, skipProto)) return false;
  }
  const aSyms: any = Object.getOwnPropertySymbols(a);
  const bSyms: any = Object.getOwnPropertySymbols(b);
  if (Number(aSyms.length) !== Number(bSyms.length)) return false;
  for (const sym of aSyms) {
    if (!__utilInnerDeepEqual(a[sym], b[sym], seen, skipProto)) return false;
  }
  return true;
}

function __utilDeepEqualMap(a: any, b: any, seen: any[], skipProto: boolean): boolean {
  if (Number(a.size) !== Number(b.size)) return false;
  const unmatched: any[] = [];
  for (const entry of b) unmatched.push(entry);
  for (const entry of a) {
    let found = false;
    for (let i = 0; i < Number(unmatched.length); i++) {
      const candidate: any = unmatched[i];
      if (candidate === undefined) continue;
      if (
        __utilInnerDeepEqual(entry[0], candidate[0], seen, skipProto) &&
        __utilInnerDeepEqual(entry[1], candidate[1], seen, skipProto)
      ) {
        unmatched[i] = undefined;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function __utilDeepEqualSet(a: any, b: any, seen: any[], skipProto: boolean): boolean {
  if (Number(a.size) !== Number(b.size)) return false;
  const unmatched: any[] = [];
  for (const entry of b) unmatched.push(entry);
  const used: boolean[] = [];
  for (let i = 0; i < Number(unmatched.length); i++) used.push(false);
  for (const entry of a) {
    let found = false;
    for (let i = 0; i < Number(unmatched.length); i++) {
      if (used[i]) continue;
      if (__utilInnerDeepEqual(entry, unmatched[i], seen, skipProto)) {
        used[i] = true;
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

// ===========================================================================
// util.inherits
// ===========================================================================

// Node sets `ctor.super_` and grafts `ctor.prototype`'s prototype onto
// `superCtor.prototype`. The engine has no function-constructor/prototype model
// (zun#25) — `ctor.prototype` is `undefined` for a function declaration — so the
// `super_` record is kept (which is what `ctor.super_` readers want) and the
// graft is a no-op where there is no prototype to graft. The argument validation
// is Node's, including the `superCtor.prototype` check.
function inherits(ctor: any, superCtor: any): void {
  if (ctor === undefined || ctor === null) {
    throw new ERR_INVALID_ARG_TYPE("ctor", "Function", ctor);
  }
  if (superCtor === undefined || superCtor === null) {
    throw new ERR_INVALID_ARG_TYPE("superCtor", "Function", superCtor);
  }
  if (superCtor.prototype === undefined) {
    throw new ERR_INVALID_ARG_TYPE("superCtor.prototype", "Object", superCtor.prototype);
  }
  ctor.super_ = superCtor;
  if (ctor.prototype !== undefined && ctor.prototype !== null) {
    Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
  }
}

// ===========================================================================
// util.deprecate
// ===========================================================================

const __utilDeprecationsEmitted: any = new Map();

// Every closure in this file collects its call arguments through a **rest
// parameter**, never through the implicit `arg`+`uments` object. The parser
// looks for that word textually anywhere inside a function's source span —
// nested closures and comments included — and, where it finds one, injects a
// synthetic trailing rest parameter into the *enclosing* function as well. A
// dynamic call through an `any` receiver (`util.deprecate(…)`,
// `util.promisify(…)`, `util.callbackify(…)`, `util.debuglog(…)`) leaves that
// synthetic parameter unbound, and the injected `[...rest]` spread then aborts
// the program with "spread: value is not iterable". (New bug, reported with
// this work; the word is spelled with a seam above so this comment does not
// trip it.)
function deprecate(fn: any, msg: any, code?: any): any {
  if (code !== undefined) __utilValidateString(code, "code");
  const state: any = { fn: fn, msg: String(msg), code: code, warned: false };
  const deprecated: any = function (...passed: any[]): any {
    if (process.noDeprecation !== true) {
      __utilEmitDeprecation(state);
    }
    return __utilCall(state.fn, passed);
  };
  return __utilBox(deprecated);
}

function __utilEmitDeprecation(state: any): void {
  if (state.code !== undefined) {
    if (__utilDeprecationsEmitted.get(String(state.code)) === true) return;
    __utilDeprecationsEmitted.set(String(state.code), true);
  } else {
    if (state.warned === true) return;
    state.warned = true;
  }
  process.emitWarning(state.msg, "DeprecationWarning", state.code);
}

// ===========================================================================
// util.promisify
// ===========================================================================

function promisify(original: any): any {
  __utilValidateFunction(original, "original");

  const custom: any = original[__promisifyCustomSymbol];
  if (custom !== undefined && custom !== null) {
    __utilValidateFunction(custom, "util.promisify.custom");
    return __utilBox(custom);
  }

  const argumentNames: any = original[__customPromisifyArgsSymbol];
  const state: any = { original: original, argumentNames: argumentNames };
  const fn: any = function (...passed: any[]): any {
    return new Promise(function (resolve: any, reject: any): any {
      const callback: any = function (...settled: any[]): any {
        const err: any = settled[0];
        if (err !== undefined && err !== null && err !== false) {
          reject(err);
          return undefined;
        }
        const values: any[] = [];
        const got = Number(settled.length);
        for (let i = 1; i < got; i++) values.push(settled[i]);
        const names: any = state.argumentNames;
        if (names !== undefined && Number(values.length) > 1) {
          const obj: any = {};
          for (let i = 0; i < Number(names.length); i++) obj[names[i]] = values[i];
          resolve(obj);
          return undefined;
        }
        resolve(values[0]);
        return undefined;
      };
      passed.push(__utilBox(callback));
      const produced: any = __utilCall(state.original, passed);
      if (__utilIsPromise(produced)) {
        process.emitWarning(
          "Calling promisify on a function that returns a Promise is likely a mistake.",
          "DeprecationWarning",
          "DEP0174",
        );
      }
      return undefined;
    });
  };
  const boxed: any = __utilBox(fn);
  boxed[__promisifyCustomSymbol] = boxed;
  return boxed;
}

// ===========================================================================
// util.callbackify
// ===========================================================================

function callbackify(original: any): any {
  __utilValidateFunction(original, "original");
  const state: any = { original: original };
  const callbackified: any = function (...passed: any[]): any {
    const maybeCb: any = passed.pop();
    __utilValidateFunction(maybeCb, "last argument");
    const produced: any = __utilCall(state.original, passed);
    const onResolved: any = function (ret: any): any {
      process.nextTick(__utilBox(maybeCb), null, ret);
      return undefined;
    };
    const onRejected: any = function (reason: any): any {
      let error: any = reason;
      if (error === undefined || error === null || error === false || error === 0 || error === "") {
        error = new ERR_FALSY_VALUE_REJECTION(reason);
      }
      process.nextTick(__utilBox(maybeCb), error);
      return undefined;
    };
    produced.then(onResolved, onRejected);
    return undefined;
  };
  return __utilBox(callbackified);
}

// ===========================================================================
// util.debuglog / util.debug
// ===========================================================================

const __utilDebugState: any = { sections: undefined };

function __utilDebugSections(): any {
  if (__utilDebugState.sections === undefined) {
    const raw: any = __utilEnv("NODE_DEBUG");
    const list: string[] = [];
    if (typeof raw === "string" && raw !== "") {
      for (const piece of raw.split(",")) {
        const trimmed = piece.trim();
        if (trimmed !== "") list.push(trimmed.toUpperCase());
      }
    }
    __utilDebugState.sections = list;
  }
  return __utilDebugState.sections;
}

function __utilDebugEnabled(set: string): boolean {
  const upper = set.toUpperCase();
  for (const pattern of __utilDebugSections()) {
    if (pattern === upper) return true;
    // `NODE_DEBUG=foo*` enables every section starting with `foo`.
    const starAt = Number(pattern.indexOf("*"));
    if (starAt !== -1 && upper.slice(0, starAt) === pattern.slice(0, starAt)) return true;
  }
  return false;
}

function debuglog(set: any, callback?: any): any {
  __utilValidateString(set, "section");
  const state: any = { set: String(set), enabled: undefined, callback: callback, inited: false };
  const logger: any = function (...passed: any[]): any {
    if (!__utilDebugLoggerEnabled(state)) return undefined;
    const text = __utilFormatWithOptions(__inspectDefaultOptions, passed);
    process.stderr.write(
      String(state.set).toUpperCase() + " " + String(process.pid) + ": " + text + "\n",
    );
    return undefined;
  };
  const boxed: any = __utilBox(logger);
  boxed.enabled = __utilDebugEnabled(String(set));
  return boxed;
}

function __utilDebugLoggerEnabled(state: any): boolean {
  if (state.enabled === undefined) {
    state.enabled = __utilDebugEnabled(String(state.set));
    if (state.enabled === true && state.callback !== undefined && state.callback !== null) {
      __utilCall(state.callback, []);
    }
  }
  return state.enabled === true;
}

// ===========================================================================
// util.types
// ===========================================================================

function __utilIsPromise(value: any): boolean {
  if (!__utilIsObjectLike(value)) return false;
  if (__utilTag(value) === "[object Promise]") return true;
  return __utilIsFn(value["then"]);
}

// `util.types`, declared once so `require('util/types') === util.types` holds by
// identity, which is what `test-util-types-exists.js` asserts.
//
// The predicates the engine cannot answer (every typed-array shape,
// `ArrayBuffer`, `DataView`, boxed primitives, `Proxy`, the iterator and
// generator shapes, `WeakMap`/`WeakSet`, the crypto key shapes) answer `false`
// rather than throwing: the value class is simply not distinguishable from a
// plain object once it is held in an `any`. See the header for the list.
const __utilTypes: any = {
  isAnyArrayBuffer(value: any): boolean {
    return false;
  },
  isArrayBuffer(value: any): boolean {
    return false;
  },
  isSharedArrayBuffer(value: any): boolean {
    return false;
  },
  isArgumentsObject(value: any): boolean {
    return false;
  },
  // Two of the view predicates *are* answerable: the engine's
  // `ArrayBuffer.isView` and `Buffer.isBuffer` both work on a value held in an
  // `any`, and `Buffer.isBuffer` is exactly "a `U8` byte view" — which is
  // `isUint8Array`, since the engine's `Buffer` is a nominal alias for that
  // floor. `isTypedArray` stays `false` rather than answering
  // `ArrayBuffer.isView`, because that would also claim a `DataView`, and
  // nothing in the engine separates the two.
  isArrayBufferView(value: any): boolean {
    return ArrayBuffer.isView(value);
  },
  isTypedArray(value: any): boolean {
    return false;
  },
  isUint8Array(value: any): boolean {
    return Buffer.isBuffer(value);
  },
  isUint8ClampedArray(value: any): boolean {
    return false;
  },
  isUint16Array(value: any): boolean {
    return false;
  },
  isUint32Array(value: any): boolean {
    return false;
  },
  isInt8Array(value: any): boolean {
    return false;
  },
  isInt16Array(value: any): boolean {
    return false;
  },
  isInt32Array(value: any): boolean {
    return false;
  },
  isFloat16Array(value: any): boolean {
    return false;
  },
  isFloat32Array(value: any): boolean {
    return false;
  },
  isFloat64Array(value: any): boolean {
    return false;
  },
  isBigInt64Array(value: any): boolean {
    return false;
  },
  isBigUint64Array(value: any): boolean {
    return false;
  },
  isDataView(value: any): boolean {
    return false;
  },
  isAsyncFunction(value: any): boolean {
    return false;
  },
  isGeneratorFunction(value: any): boolean {
    return false;
  },
  isGeneratorObject(value: any): boolean {
    return false;
  },
  isMapIterator(value: any): boolean {
    return false;
  },
  isSetIterator(value: any): boolean {
    return false;
  },
  isModuleNamespaceObject(value: any): boolean {
    return false;
  },
  isProxy(value: any): boolean {
    return false;
  },
  isExternal(value: any): boolean {
    return false;
  },
  isBoxedPrimitive(value: any): boolean {
    return false;
  },
  isNumberObject(value: any): boolean {
    return false;
  },
  isStringObject(value: any): boolean {
    return false;
  },
  isBooleanObject(value: any): boolean {
    return false;
  },
  isBigIntObject(value: any): boolean {
    return false;
  },
  isSymbolObject(value: any): boolean {
    return false;
  },
  isWeakMap(value: any): boolean {
    return false;
  },
  isWeakSet(value: any): boolean {
    return false;
  },
  isCryptoKey(value: any): boolean {
    return false;
  },
  isKeyObject(value: any): boolean {
    return false;
  },

  // Answerable exactly.
  isDate(value: any): boolean {
    return __utilIsObjectLike(value) && value instanceof Date;
  },
  isMap(value: any): boolean {
    return __utilIsObjectLike(value) && __utilTag(value) === "[object Map]";
  },
  isSet(value: any): boolean {
    return __utilIsObjectLike(value) && __utilTag(value) === "[object Set]";
  },
  isRegExp(value: any): boolean {
    return __utilIsObjectLike(value) && __utilTag(value) === "[object RegExp]";
  },
  isPromise(value: any): boolean {
    return __utilIsObjectLike(value) && __utilTag(value) === "[object Promise]";
  },
  isNativeError(value: any): boolean {
    return __utilIsObjectLike(value) && value instanceof Error;
  },
};

// ===========================================================================
// getSystemErrorName / getSystemErrorMap / getSystemErrorMessage
// ===========================================================================

// libuv's `UV_ERRNO_MAP`: one row per code, `NAME|win32|posix|message`. The
// win32 column is libuv's `UV__E*` constant, the posix column `-errno` where the
// platform defines one and the same `UV__E*` constant where it does not. This is
// the same data `os.constants.errno` is built from, but `os.ts` is bundled only
// for tests that require `node:os`, so it is embedded here rather than shared.
const __UV_ERRNO_TABLE: string =
  "EAI_ADDRFAMILY|-3000|-3000|address family not supported," +
  "EAI_AGAIN|-3001|-3001|temporary failure," +
  "EAI_BADFLAGS|-3002|-3002|bad ai_flags value," +
  "EAI_CANCELED|-3003|-3003|request canceled," +
  "EAI_FAIL|-3004|-3004|permanent failure," +
  "EAI_FAMILY|-3005|-3005|ai_family not supported," +
  "EAI_MEMORY|-3006|-3006|out of memory," +
  "EAI_NODATA|-3007|-3007|no address," +
  "EAI_NONAME|-3008|-3008|unknown node or service," +
  "EAI_OVERFLOW|-3009|-3009|argument buffer overflow," +
  "EAI_SERVICE|-3010|-3010|service not available for socket type," +
  "EAI_SOCKTYPE|-3011|-3011|socket type not supported," +
  "EAI_BADHINTS|-3013|-3013|invalid value for hints," +
  "EAI_PROTOCOL|-3014|-3014|resolved protocol is unknown," +
  "ENOEXEC|-4022|-8|exec format error," +
  "EUNATCH|-4023|-49|protocol driver not attached," +
  "ENODATA|-4024|-61|no data available," +
  "ESOCKTNOSUPPORT|-4025|-94|socket type not supported," +
  "EOVERFLOW|-4026|-75|value too large for defined data type," +
  "EILSEQ|-4027|-84|illegal byte sequence," +
  "EFTYPE|-4028|-4028|inappropriate file type or format," +
  "ENOTTY|-4029|-25|inappropriate ioctl for device," +
  "EREMOTEIO|-4030|-121|remote I/O error," +
  "EHOSTDOWN|-4031|-112|host is down," +
  "EMLINK|-4032|-31|too many links," +
  "ENXIO|-4033|-6|no such device or address," +
  "ERANGE|-4034|-34|result too large," +
  "ENOPROTOOPT|-4035|-92|protocol not available," +
  "EFBIG|-4036|-27|file too large," +
  "EXDEV|-4037|-18|cross-device link not permitted," +
  "ETXTBSY|-4038|-26|text file is busy," +
  "ETIMEDOUT|-4039|-110|connection timed out," +
  "ESRCH|-4040|-3|no such process," +
  "ESPIPE|-4041|-29|invalid seek," +
  "ESHUTDOWN|-4042|-108|cannot send after transport endpoint shutdown," +
  "EROFS|-4043|-30|read-only file system," +
  "EPROTOTYPE|-4044|-91|protocol wrong type for socket," +
  "EPROTONOSUPPORT|-4045|-93|protocol not supported," +
  "EPROTO|-4046|-71|protocol error," +
  "EPIPE|-4047|-32|broken pipe," +
  "EPERM|-4048|-1|operation not permitted," +
  "ENOTSUP|-4049|-95|operation not supported on socket," +
  "ENOTSOCK|-4050|-88|socket operation on non-socket," +
  "ENOTEMPTY|-4051|-39|directory not empty," +
  "ENOTDIR|-4052|-20|not a directory," +
  "ENOTCONN|-4053|-107|socket is not connected," +
  "ENOSYS|-4054|-38|function not implemented," +
  "ENOSPC|-4055|-28|no space left on device," +
  "ENONET|-4056|-64|machine is not on the network," +
  "ENOMEM|-4057|-12|not enough memory," +
  "ENOENT|-4058|-2|no such file or directory," +
  "ENODEV|-4059|-19|no such device," +
  "ENOBUFS|-4060|-105|no buffer space available," +
  "ENFILE|-4061|-23|file table overflow," +
  "ENETUNREACH|-4062|-101|network is unreachable," +
  "ENETDOWN|-4063|-100|network is down," +
  "ENAMETOOLONG|-4064|-36|name too long," +
  "EMSGSIZE|-4065|-90|message too long," +
  "EMFILE|-4066|-24|too many open files," +
  "ELOOP|-4067|-40|too many symbolic links encountered," +
  "EISDIR|-4068|-21|illegal operation on a directory," +
  "EISCONN|-4069|-106|socket is already connected," +
  "EIO|-4070|-5|i/o error," +
  "EINVAL|-4071|-22|invalid argument," +
  "EINTR|-4072|-4|interrupted system call," +
  "EHOSTUNREACH|-4073|-113|host is unreachable," +
  "EFAULT|-4074|-14|bad address in system call argument," +
  "EEXIST|-4075|-17|file already exists," +
  "EDESTADDRREQ|-4076|-89|destination address required," +
  "ECONNRESET|-4077|-104|connection reset by peer," +
  "ECONNREFUSED|-4078|-111|connection refused," +
  "ECONNABORTED|-4079|-103|software caused connection abort," +
  "ECHARSET|-4080|-4080|invalid Unicode character," +
  "ECANCELED|-4081|-125|operation canceled," +
  "EBUSY|-4082|-16|resource busy or locked," +
  "EBADF|-4083|-9|bad file descriptor," +
  "EALREADY|-4084|-114|connection already in progress," +
  "EAGAIN|-4088|-11|resource temporarily unavailable," +
  "EAFNOSUPPORT|-4089|-97|address family not supported," +
  "EADDRNOTAVAIL|-4090|-99|address not available," +
  "EADDRINUSE|-4091|-98|address already in use," +
  "EACCES|-4092|-13|permission denied," +
  "E2BIG|-4093|-7|argument list too long," +
  "UNKNOWN|-4094|-4094|unknown error," +
  "EOF|-4095|-4095|end of file";

const __utilErrnoState: any = { map: undefined };

function __utilErrnoMap(): any {
  if (__utilErrnoState.map === undefined) {
    const isWindows = process.platform === "win32";
    const table: any = new Map();
    for (const row of __UV_ERRNO_TABLE.split(",")) {
      const fields = row.split("|");
      const value = Number(isWindows ? fields[1] : fields[2]);
      table.set(value, [fields[0], fields[3]]);
    }
    __utilErrnoState.map = table;
  }
  return __utilErrnoState.map;
}

function __utilCheckErrno(err: any): void {
  __utilValidateNumber(err, "err");
  if (err >= 0 || !Number.isSafeInteger(err)) {
    throw new ERR_OUT_OF_RANGE("err", "a negative integer", err);
  }
}

// ===========================================================================
// MIMEType / MIMEParams (lib/internal/mime.js)
// ===========================================================================

// RFC 9110 token characters.
function __mimeIsTokenChar(code: number): boolean {
  if (code >= 48 && code <= 57) return true;
  if (code >= 65 && code <= 90) return true;
  if (code >= 97 && code <= 122) return true;
  return (
    code === 33 || code === 35 || code === 36 || code === 37 || code === 38 ||
    code === 39 || code === 42 || code === 43 || code === 45 || code === 46 ||
    code === 94 || code === 95 || code === 96 || code === 124 || code === 126
  );
}

function __mimeIsToken(text: string): boolean {
  const n = Number(text.length);
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (!__mimeIsTokenChar(__cc(text, i))) return false;
  }
  return true;
}

// A quoted-string is needed when the value is not a bare token.
function __mimeQuoteValue(value: string): string {
  if (__mimeIsToken(value)) return value;
  const n = Number(value.length);
  let out = '"';
  for (let i = 0; i < n; i++) {
    const ch = value.charAt(i);
    if (ch === '"' || ch === "\\") out = out + "\\";
    out = out + ch;
  }
  return out + '"';
}

function __mimeIsWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

class MIMEParams {
  // The engine has no private-field model for a `Map` held by a class instance
  // that must also iterate, so the backing store is a declared field.
  data: any = new Map();

  delete(name: any): void {
    this.data.delete(String(name));
  }

  get(name: any): any {
    const value: any = this.data.get(String(name));
    return value === undefined ? null : value;
  }

  has(name: any): boolean {
    return this.data.has(String(name)) === true;
  }

  set(name: any, value: any): void {
    const key = String(name);
    const text = String(value);
    if (key === "" || !__mimeIsToken(key)) {
      throw new ERR_INVALID_MIME_SYNTAX("parameter name", key, -1);
    }
    const n = Number(text.length);
    for (let i = 0; i < n; i++) {
      const code = __cc(text, i);
      if (code === 34 || code < 32 || code === 127) {
        throw new ERR_INVALID_MIME_SYNTAX("parameter value", text, i);
      }
    }
    this.data.set(key, text);
  }

  entries(): any {
    const out: any[] = [];
    for (const entry of this.data) out.push([entry[0], entry[1]]);
    return out;
  }

  keys(): any {
    const out: any[] = [];
    for (const entry of this.data) out.push(entry[0]);
    return out;
  }

  values(): any {
    const out: any[] = [];
    for (const entry of this.data) out.push(entry[1]);
    return out;
  }

  toString(): string {
    let out = "";
    for (const entry of this.data) {
      out = out + ";" + String(entry[0]) + "=" + __mimeQuoteValue(String(entry[1]));
    }
    return out;
  }
}

class MIMEType {
  type: string = "";
  subtype: string = "";
  params: any = undefined;

  constructor(source: any) {
    const text = String(source).trim();
    const n = Number(text.length);
    const slash = Number(text.indexOf("/"));
    if (slash === -1) {
      throw new ERR_INVALID_MIME_SYNTAX("type", text, -1);
    }
    const type = text.slice(0, slash);
    if (!__mimeIsToken(type)) {
      throw new ERR_INVALID_MIME_SYNTAX("type", text, 0);
    }
    let end = slash + 1;
    while (end < n && text.charAt(end) !== ";") end = end + 1;
    const subtype = text.slice(slash + 1, end).trim();
    if (!__mimeIsToken(subtype)) {
      throw new ERR_INVALID_MIME_SYNTAX("subtype", text, slash + 1);
    }
    this.type = type.toLowerCase();
    this.subtype = subtype.toLowerCase();
    this.params = new MIMEParams();
    __mimeParseParameters(this.params, text, end);
  }

  get essence(): string {
    return this.type + "/" + this.subtype;
  }

  toString(): string {
    return this.type + "/" + this.subtype + String(this.params.toString());
  }
}

// `;name=value` / `;name="quoted \" value"`, repeated. An unparsable parameter
// is skipped, as in Node.
function __mimeParseParameters(params: any, text: string, start: number): void {
  const n = Number(text.length);
  let i = start;
  while (i < n) {
    if (text.charAt(i) !== ";") {
      i = i + 1;
      continue;
    }
    i = i + 1;
    while (i < n && __mimeIsWhitespace(__cc(text, i))) i = i + 1;
    const nameStart = i;
    while (i < n && text.charAt(i) !== "=" && text.charAt(i) !== ";") i = i + 1;
    const name = text.slice(nameStart, i).trim().toLowerCase();
    if (i >= n || text.charAt(i) === ";") continue;
    i = i + 1;
    let value = "";
    if (text.charAt(i) === '"') {
      i = i + 1;
      while (i < n) {
        const ch = text.charAt(i);
        if (ch === "\\") {
          i = i + 1;
          if (i < n) {
            value = value + text.charAt(i);
            i = i + 1;
          }
          continue;
        }
        if (ch === '"') {
          i = i + 1;
          break;
        }
        value = value + ch;
        i = i + 1;
      }
      while (i < n && text.charAt(i) !== ";") i = i + 1;
    } else {
      const valueStart = i;
      while (i < n && text.charAt(i) !== ";") i = i + 1;
      value = text.slice(valueStart, i).trim();
    }
    if (name === "" || !__mimeIsToken(name)) continue;
    if (params.has(name)) continue;
    let valid = true;
    const len = Number(value.length);
    for (let k = 0; k < len; k++) {
      const code = __cc(value, k);
      if (code === 34 || code < 32 || code === 127) {
        valid = false;
        break;
      }
    }
    if (valid) params.set(name, value);
  }
}

// ===========================================================================
// util.parseEnv (node_dotenv.cc's grammar)
// ===========================================================================

function parseEnv(content: any): any {
  __utilValidateString(content, "content");
  const text: string = content;
  const result: any = Object.create(null);
  const n = Number(text.length);
  let i = 0;
  while (i < n) {
    // Skip whitespace and comments.
    while (i < n && __mimeIsWhitespace(__cc(text, i))) i = i + 1;
    if (i >= n) break;
    if (text.charAt(i) === "#") {
      while (i < n && __cc(text, i) !== 10) i = i + 1;
      continue;
    }
    // An optional `export ` prefix is ignored.
    if (text.slice(i, i + 7) === "export ") i = i + 7;
    while (i < n && (__cc(text, i) === 32 || __cc(text, i) === 9)) i = i + 1;

    const keyStart = i;
    while (i < n && __cc(text, i) !== 61 && __cc(text, i) !== 10) i = i + 1;
    if (i >= n || __cc(text, i) === 10) {
      // No `=` on this line: skip it.
      if (i < n) i = i + 1;
      continue;
    }
    const key = text.slice(keyStart, i).trim();
    i = i + 1; // past '='
    while (i < n && (__cc(text, i) === 32 || __cc(text, i) === 9)) i = i + 1;

    let value = "";
    const quote = i < n ? text.charAt(i) : "";
    if (quote === '"' || quote === "'" || quote === "`") {
      i = i + 1;
      const valueStart = i;
      let closed = false;
      while (i < n) {
        if (text.charAt(i) === quote) {
          closed = true;
          break;
        }
        i = i + 1;
      }
      if (closed) {
        value = text.slice(valueStart, i);
        i = i + 1;
        // Only double quotes expand `\n` / `\r`.
        if (quote === '"') value = __utilExpandNewlines(value);
        // The rest of the line after the closing quote is a comment.
        while (i < n && __cc(text, i) !== 10) i = i + 1;
      } else {
        // An unterminated quote: the value is the remainder of that one line,
        // quote character included, which is what Node's parser yields.
        i = valueStart;
        const lineEnd = __utilLineEnd(text, i);
        value = quote + text.slice(i, lineEnd).trim();
        value = value.slice(1);
        i = lineEnd;
      }
    } else {
      const lineEnd = __utilLineEnd(text, i);
      let raw = text.slice(i, lineEnd);
      const hash = Number(raw.indexOf("#"));
      if (hash !== -1) raw = raw.slice(0, hash);
      value = raw.trim();
      i = lineEnd;
    }
    if (key !== "") result[key] = value;
  }
  return result;
}

function __utilLineEnd(text: string, from: number): number {
  const n = Number(text.length);
  let i = from;
  while (i < n && __cc(text, i) !== 10) i = i + 1;
  return i;
}

function __utilExpandNewlines(value: string): string {
  const n = Number(value.length);
  let out = "";
  let i = 0;
  while (i < n) {
    if (value.charAt(i) === "\\" && i + 1 < n) {
      const next = value.charAt(i + 1);
      if (next === "n") {
        out = out + "\n";
        i = i + 2;
        continue;
      }
      if (next === "r") {
        out = out + "\r";
        i = i + 2;
        continue;
      }
    }
    out = out + value.charAt(i);
    i = i + 1;
  }
  return out;
}

// ===========================================================================
// util.parseArgs (lib/internal/util/parse_args/*)
// ===========================================================================

function __paIsOptionLikeValue(value: any): boolean {
  if (value === undefined) return false;
  const text = String(value);
  return text !== "-" && Number(text.indexOf("-")) === 0;
}

function __paIsLoneShortOption(arg: string): boolean {
  return Number(arg.length) === 2 && arg.charAt(0) === "-" && arg.charAt(1) !== "-";
}

function __paIsLoneLongOption(arg: string): boolean {
  return (
    Number(arg.length) > 2 &&
    arg.slice(0, 2) === "--" &&
    Number(arg.indexOf("=")) === -1
  );
}

function __paIsLongOptionAndValue(arg: string): boolean {
  return Number(arg.length) > 2 && arg.slice(0, 2) === "--" && Number(arg.indexOf("=")) > -1;
}

function __paIsShortOptionGroup(arg: string, options: any): boolean {
  if (Number(arg.length) <= 2) return false;
  if (arg.charAt(0) !== "-") return false;
  if (arg.charAt(1) === "-") return false;
  const first = arg.charAt(1);
  const longOption = __paFindByShort(options, first);
  if (longOption === undefined) return true;
  return String(__paOptionType(options, longOption)) !== "string";
}

function __paIsShortOptionAndValue(arg: string, options: any): boolean {
  if (Number(arg.length) <= 2) return false;
  if (arg.charAt(0) !== "-") return false;
  if (arg.charAt(1) === "-") return false;
  const longOption = __paFindByShort(options, arg.charAt(1));
  if (longOption === undefined) return false;
  return String(__paOptionType(options, longOption)) === "string";
}

function __paFindByShort(options: any, short: string): any {
  for (const name of Object.keys(options)) {
    const config: any = options[name];
    if (config !== null && config !== undefined && String(config["short"]) === short) {
      return name;
    }
  }
  return undefined;
}

function __paOptionType(options: any, name: string): any {
  const config: any = options[name];
  if (config === null || config === undefined) return undefined;
  return config["type"];
}

function __paOptionMultiple(options: any, name: string): boolean {
  const config: any = options[name];
  if (config === null || config === undefined) return false;
  return config["multiple"] === true;
}

function parseArgs(config?: any): any {
  const settings: any = config === undefined || config === null ? {} : config;
  __utilValidateObject(settings, "config");

  const args: any =
    settings["args"] === undefined ? __paDefaultArgs() : settings["args"];
  __utilValidateArray(args, "args");

  const options: any = settings["options"] === undefined ? {} : settings["options"];
  __utilValidateObject(options, "options");

  const strict = settings["strict"] === undefined ? true : settings["strict"];
  __utilValidateBoolean(strict, "strict");

  const allowPositionals =
    settings["allowPositionals"] === undefined ? !strict : settings["allowPositionals"];
  __utilValidateBoolean(allowPositionals, "allowPositionals");

  const allowNegative =
    settings["allowNegative"] === undefined ? false : settings["allowNegative"];
  __utilValidateBoolean(allowNegative, "allowNegative");

  const returnTokens = settings["tokens"] === undefined ? false : settings["tokens"];
  __utilValidateBoolean(returnTokens, "tokens");

  for (const name of Object.keys(options)) {
    const optionConfig: any = options[name];
    __utilValidateObject(optionConfig, "options." + name);
    const type: any = optionConfig["type"];
    if (type !== "string" && type !== "boolean") {
      // Node spells the expected type as the literal `('string|boolean')`
      // (`validateUnion`), which lands in `internal/errors`' "other" bucket and
      // so is emitted verbatim.
      throw new ERR_INVALID_ARG_TYPE("options." + name + ".type", "('string|boolean')", type);
    }
    if (optionConfig["short"] !== undefined) {
      const short: any = optionConfig["short"];
      __utilValidateString(short, "options." + name + ".short");
      if (Number(short.length) !== 1) {
        throw new ERR_INVALID_ARG_VALUE(
          "options." + name + ".short",
          short,
          "must be a single character",
        );
      }
    }
    if (optionConfig["multiple"] !== undefined) {
      __utilValidateBoolean(optionConfig["multiple"], "options." + name + ".multiple");
    }
  }

  const tokens: any[] = __paTokenize(args, options, strict, allowPositionals, allowNegative);

  const result: any = { values: Object.create(null), positionals: [] };
  if (returnTokens === true) result.tokens = tokens;

  for (const token of tokens) {
    if (token.kind === "option") {
      if (strict === true) __paCheckOption(token, options, allowPositionals, allowNegative);
      __paStoreOption(token.name, token.value, options, result.values, allowNegative);
    } else if (token.kind === "positional") {
      if (allowPositionals !== true) {
        throw new ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL(String(token.value));
      }
      result.positionals.push(token.value);
    }
  }

  // Defaults are applied after the command line, never over it.
  for (const name of Object.keys(options)) {
    const optionConfig: any = options[name];
    if (optionConfig["default"] !== undefined && result.values[name] === undefined) {
      result.values[name] = optionConfig["default"];
    }
  }
  return result;
}

// `process.argv.slice(2)` is what Node uses when `args` is omitted (it drops one
// more entry when the entry point is an npm-style wrapper, which does not exist
// here).
function __paDefaultArgs(): any[] {
  const out: any[] = [];
  const argv: any = process.argv;
  for (let i = 2; i < Number(argv.length); i++) out.push(argv[i]);
  return out;
}

function __paCheckOption(token: any, options: any, allowPositionals: boolean, allowNegative: boolean): void {
  const name = String(token.name);
  let known = options[name] !== undefined;
  if (!known && allowNegative === true && name.slice(0, 3) === "no-") {
    known = options[name.slice(3)] !== undefined;
  }
  if (!known) {
    throw new ERR_PARSE_ARGS_UNKNOWN_OPTION(String(token.rawName), allowPositionals);
  }
  const type = __paOptionType(options, name);
  if (type === "string" && typeof token.value !== "string") {
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(
      "Option '" + String(token.rawName) + " <value>' argument missing",
    );
  }
  if (type === "boolean" && token.value !== undefined) {
    throw new ERR_PARSE_ARGS_INVALID_OPTION_VALUE(
      "Option '" + String(token.rawName) + "' does not take an argument",
    );
  }
}

function __paStoreOption(longOption: any, optionValue: any, options: any, values: any, allowNegative: boolean): void {
  let name = String(longOption);
  let value: any = optionValue === undefined ? true : optionValue;
  if (name === "__proto__") return;
  if (
    allowNegative === true &&
    optionValue === undefined &&
    name.slice(0, 3) === "no-" &&
    options[name.slice(3)] !== undefined
  ) {
    name = name.slice(3);
    value = false;
  }
  if (__paOptionMultiple(options, name)) {
    if (Array.isArray(values[name])) {
      values[name].push(value);
    } else {
      values[name] = [value];
    }
    return;
  }
  values[name] = value;
}

function __paTokenize(args: any, options: any, strict: boolean, allowPositionals: boolean, allowNegative: boolean): any[] {
  const tokens: any[] = [];
  let remainingArgs = false;
  const total = Number(args.length);
  for (let index = 0; index < total; index++) {
    const arg: string = String(args[index]);
    if (remainingArgs) {
      tokens.push({ kind: "positional", index: index, value: arg });
      continue;
    }
    if (arg === "--") {
      remainingArgs = true;
      tokens.push({ kind: "option-terminator", index: index });
      continue;
    }
    if (__paIsLoneShortOption(arg)) {
      const short = arg.charAt(1);
      const longOption = __paFindByShort(options, short);
      const name = longOption === undefined ? short : String(longOption);
      let value: any = undefined;
      let inlineValue = false;
      if (String(__paOptionType(options, name)) === "string") {
        if (index + 1 < total && !__paIsOptionLikeValue(args[index + 1])) {
          value = String(args[index + 1]);
          index = index + 1;
        }
      }
      tokens.push({
        kind: "option", name: name, rawName: arg, index: index,
        value: value, inlineValue: inlineValue,
      });
      continue;
    }
    if (__paIsShortOptionGroup(arg, options)) {
      const expanded: string[] = [];
      for (let i = 1; i < Number(arg.length); i++) expanded.push("-" + arg.charAt(i));
      const inner = __paTokenize(expanded, options, strict, allowPositionals, allowNegative);
      for (const token of inner) {
        token.index = index;
        tokens.push(token);
      }
      continue;
    }
    if (__paIsShortOptionAndValue(arg, options)) {
      const short = arg.charAt(1);
      const longOption = __paFindByShort(options, short);
      tokens.push({
        kind: "option",
        name: String(longOption),
        rawName: "-" + short,
        index: index,
        value: arg.slice(2),
        inlineValue: true,
      });
      continue;
    }
    if (__paIsLoneLongOption(arg)) {
      const name = arg.slice(2);
      let value: any = undefined;
      if (String(__paOptionType(options, name)) === "string") {
        if (index + 1 < total && !__paIsOptionLikeValue(args[index + 1])) {
          value = String(args[index + 1]);
          index = index + 1;
        }
      }
      tokens.push({
        kind: "option", name: name, rawName: arg, index: index,
        value: value, inlineValue: false,
      });
      continue;
    }
    if (__paIsLongOptionAndValue(arg)) {
      const eq = Number(arg.indexOf("="));
      tokens.push({
        kind: "option",
        name: arg.slice(2, eq),
        rawName: arg.slice(0, eq),
        index: index,
        value: arg.slice(eq + 1),
        inlineValue: true,
      });
      continue;
    }
    tokens.push({ kind: "positional", index: index, value: arg });
  }
  return tokens;
}

// ===========================================================================
// AbortSignal helpers
// ===========================================================================

// `util.aborted(signal, resource)` — a promise that settles when the signal
// aborts. Node keeps a weak reference to `resource`; there is no observable
// difference here beyond the lifetime, which this engine does not expose.
function aborted(signal: any, resource: any): any {
  // `validateAbortSignal(signal, 'signal')`: anything without an `aborted` flag
  // is rejected.
  if (
    signal === undefined || signal === null ||
    typeof signal !== "object" || typeof signal.aborted !== "boolean"
  ) {
    throw new ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  }
  __utilValidateObject(resource, "resource");
  return new Promise(function (resolve: any, reject: any): any {
    if (signal.aborted === true) {
      resolve(undefined);
      return undefined;
    }
    // Registered exactly as `events.addAbortListener` registers one: a bare
    // function expression, three operands. A `functionBox` record is rejected
    // here with "call did not resolve to a method", so this is the one place in
    // the file that hands a raw callable across an `any` boundary.
    const onAbort: any = function (event: any): void {
      resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return undefined;
  });
}

// `transferableAbortSignal` / `transferableAbortController` mark a signal as
// transferable across a `MessagePort`. There are no worker threads and no
// structured-clone transfer list in this runtime, so the mark is recorded on the
// signal (which is what `kTransfer` is in Node) and the value handed back
// unchanged — the observable behaviour inside one thread.
function transferableAbortSignal(signal: any): any {
  if (signal === undefined || signal === null || typeof signal.aborted !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE("signal", "AbortSignal", signal);
  }
  signal["__zunTransferable"] = true;
  return signal;
}

function transferableAbortController(): any {
  const controller: any = new AbortController();
  transferableAbortSignal(controller.signal);
  return controller;
}

// ===========================================================================
// getCallSites
// ===========================================================================

// Node reads V8's structured stack frames. The engine exposes a stack only as a
// formatted string, so the frames are recovered from it: `at <name> (<file>:
// <line>:<column>)`. A frame the engine does not spell out that way is reported
// with empty strings and zeroes rather than dropped, so the array length still
// matches the stack depth.
function getCallSites(frameCountOrOptions?: any, options?: any): any[] {
  let frameCount: any = frameCountOrOptions === undefined ? 10 : frameCountOrOptions;
  let settings: any = options;
  if (settings === undefined) {
    if (typeof frameCount === "object") {
      settings = frameCount;
      __utilValidateObject(settings, "options");
      if (settings["sourceMap"] !== undefined) {
        __utilValidateBoolean(settings["sourceMap"], "options.sourceMap");
      }
      frameCount = 10;
    } else {
      settings = {};
    }
  } else {
    __utilValidateObject(settings, "options");
    if (settings["sourceMap"] !== undefined) {
      __utilValidateBoolean(settings["sourceMap"], "options.sourceMap");
    }
  }
  // `validateNumber(frameCount, 'frameCount', 1, 200)`: kDefaultMaxCallStack-
  // SizeToCapture is the ceiling, and a fractional count is truncated.
  __utilValidateNumber(frameCount, "frameCount");
  if (Number.isNaN(frameCount) || frameCount < 1 || frameCount > 200) {
    throw new ERR_OUT_OF_RANGE("frameCount", ">= 1 && <= 200", frameCount);
  }
  frameCount = Math.trunc(frameCount);
  const holder: any = new Error("getCallSites");
  const stack: any = holder.stack;
  const out: any[] = [];
  if (typeof stack !== "string") return out;
  const lines = stack.split("\n");
  for (let i = 1; i < Number(lines.length) && Number(out.length) < frameCount; i++) {
    const frame = __utilParseStackFrame(lines[i].trim());
    if (frame !== undefined) out.push(frame);
  }
  return out;
}

function __utilParseStackFrame(line: string): any {
  if (line.slice(0, 3) !== "at ") return undefined;
  let body = line.slice(3);
  let functionName = "";
  const open = Number(body.lastIndexOf("("));
  if (open !== -1 && body.charAt(Number(body.length) - 1) === ")") {
    functionName = body.slice(0, open).trim();
    body = body.slice(open + 1, Number(body.length) - 1);
  }
  let lineNumber = 0;
  let columnNumber = 0;
  let scriptName = body;
  const lastColon = Number(body.lastIndexOf(":"));
  if (lastColon > 0) {
    const secondColon = Number(body.slice(0, lastColon).lastIndexOf(":"));
    if (secondColon > 0) {
      columnNumber = Number(body.slice(lastColon + 1));
      lineNumber = Number(body.slice(secondColon + 1, lastColon));
      scriptName = body.slice(0, secondColon);
      if (Number.isNaN(columnNumber)) columnNumber = 0;
      if (Number.isNaN(lineNumber)) lineNumber = 0;
    }
  }
  return {
    functionName: functionName,
    scriptName: scriptName,
    lineNumber: lineNumber,
    column: columnNumber,
    columnNumber: columnNumber,
  };
}

// ===========================================================================
// toUSVString
// ===========================================================================

// `String.prototype.toWellFormed`: every unpaired surrogate becomes U+FFFD.
function toUSVString(input: any): string {
  const text = String(input);
  const n = Number(text.length);
  let out = "";
  let i = 0;
  while (i < n) {
    const code = __cc(text, i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < n ? __cc(text, i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out = out + text.charAt(i) + text.charAt(i + 1);
        i = i + 2;
        continue;
      }
      out = out + "�";
      i = i + 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out = out + "�";
      i = i + 1;
      continue;
    }
    out = out + text.charAt(i);
    i = i + 1;
  }
  return out;
}

// ===========================================================================
// The module object
// ===========================================================================

// `util._extend`, the deprecated shallow copy. Declared so `deprecate` can wrap
// it the way Node does.
function __utilExtend(target: any, source: any): any {
  if (source === null || source === undefined || typeof source !== "object") return target;
  for (const key of Object.keys(source)) target[key] = source[key];
  return target;
}

function __utilIsArray(value: any): boolean {
  return Array.isArray(value);
}

const util: any = {
  // Formatting. `format` and `formatWithOptions` are reached through a
  // forwarding object-literal method rather than a shorthand property: a
  // rest-parameter function read as a property value off an `any` receiver
  // panics the interpreter (zun#11), while a method that re-spreads into it
  // does not.
  format(...args: any[]): string {
    return format(...args);
  },
  formatWithOptions(inspectOptions: any, ...args: any[]): string {
    return formatWithOptions(inspectOptions, ...args);
  },
  inspect,
  stripVTControlCharacters,
  styleText,

  // Comparison
  isDeepStrictEqual,

  // Function adapters
  inherits,
  deprecate,
  promisify,
  callbackify,
  debuglog,
  debug: debuglog,

  // Predicates
  types: __utilTypes,

  // System errors
  getSystemErrorName(err: any): string {
    __utilCheckErrno(err);
    const entry: any = __utilErrnoMap().get(Number(err));
    return entry === undefined ? "Unknown system error " + String(err) : String(entry[0]);
  },
  getSystemErrorMessage(err: any): string {
    __utilCheckErrno(err);
    const entry: any = __utilErrnoMap().get(Number(err));
    return entry === undefined ? "Unknown system error " + String(err) : String(entry[1]);
  },
  getSystemErrorMap(): any {
    const copy: any = new Map();
    for (const entry of __utilErrnoMap()) copy.set(entry[0], [entry[1][0], entry[1][1]]);
    return copy;
  },

  // Strings
  toUSVString,

  // Abort helpers
  aborted,
  transferableAbortSignal,
  transferableAbortController,

  // Parsers
  parseArgs,
  parseEnv,

  // Call sites
  getCallSites,
  getCallSite: getCallSites,

  // Encoding globals, re-exported from the prelude as Node re-exports them from
  // `internal/encoding`.
  TextEncoder,
  TextDecoder,

  // MIME
  MIMEType,
  MIMEParams,

  // Deprecated, still exported in v25.
  isArray: __utilIsArray,
  _extend: __utilExtend,
};

// `util.promisify.custom`, and the symbol `internal/util` exports as
// `customPromisifyArgs` for modules that promisify a multi-value callback.
(promisify as any).custom = __promisifyCustomSymbol;

// ===========================================================================
// lib/internal/util.js
// ===========================================================================
//
// Three files in Node's `util` corpus — `test-util-sleep.js`,
// `test-util-emit-experimental-warning.js` and `test-util-deprecate.js` — are
// written against `require('internal/util')` under `--expose-internals`,
// because that is where `util`'s own implementation lives: `deprecate`,
// `promisify`, `getSystemErrorMap` and friends are all re-exported from
// `lib/internal/util.js` by `lib/util.js`. They are implemented here, in the
// same file, for the same reason: they are `util`'s internals, not a separate
// module, and nothing about them is stubbed.

const __utilExperimentalWarnings: any = new Set();

function __utilEmitExperimentalWarning(feature: any, messagePrefix?: any, code?: any): void {
  const key = String(feature);
  if (__utilExperimentalWarnings.has(key)) return;
  __utilExperimentalWarnings.add(key);
  let msg = key + " is an experimental feature and might change at any time";
  if (messagePrefix !== undefined && messagePrefix !== null && messagePrefix !== "") {
    msg = String(messagePrefix) + msg;
  }
  process.emitWarning(msg, "ExperimentalWarning", code);
}

// `validateUint32(value, name)`.
function __utilValidateUint32(value: any, name: string): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  if (value < 0 || value > 4294967295) {
    throw new ERR_OUT_OF_RANGE(name, ">= 0 && <= 4294967295", value);
  }
}

// `internal/util`'s `sleep(msec)` blocks the thread for `msec` milliseconds.
// Node calls into `uv_sleep`; there is no such host call here, so the wait is a
// spin on the clock. That is a genuine blocking sleep with the same observable
// effect, at the cost of burning the core — which is why nothing in the library
// itself uses it.
function __utilSleep(msec: any): void {
  __utilValidateUint32(msec, "msec");
  const until = Number(Date.now()) + Number(msec);
  while (Number(Date.now()) < until) {
    // spin
  }
}

const __node_internal_util: any = {
  sleep(msec: any): void {
    __utilSleep(msec);
  },
  emitExperimentalWarning(feature: any, messagePrefix?: any, code?: any): void {
    __utilEmitExperimentalWarning(feature, messagePrefix, code);
  },
  deprecate(fn: any, msg: any, code?: any): any {
    return deprecate(fn, msg, code);
  },
  // `pendingDeprecate` is `deprecate` that only warns under
  // `--pending-deprecation`; the flag does not exist here, so the wrapper never
  // warns, which is the flag's default state in Node too.
  pendingDeprecate(fn: any, msg?: any, code?: any): any {
    return deprecate(fn, msg === undefined ? "" : msg, code);
  },
  promisify(original: any): any {
    return promisify(original);
  },
  customPromisifyArgs: __customPromisifyArgsSymbol,
  kEmptyObject: {},
  getSystemErrorMap(): any {
    return util.getSystemErrorMap();
  },
  getSystemErrorName(err: any): string {
    return util.getSystemErrorName(err);
  },
  isError(value: any): boolean {
    return __utilIsObjectLike(value) && value instanceof Error;
  },
};

// `node:util` module object for the bundler's `require` rewriting, plus the
// `util/types` sub-module, which is the very same object (by identity).
const __node_util: any = util;
const __node_util_types: any = __utilTypes;

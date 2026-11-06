// node:util — the slice of `util` that `node:events` and its tests need.
//
// PLAN.md principle 4: implement just the piece that unblocks the module in
// hand, and no more. `node:events` needs `util.inspect` (the `error` event's
// `ERR_UNHANDLED_ERROR` message is `Unhandled error. (${inspect(er)})`, and the
// MaxListenersExceededWarning text embeds `inspect(target, { depth: -1 })`), and
// Node's `test-event-emitter-errors.js` additionally reads
// `util.inspect.custom`. `util.inherits` is here because it is the one other
// `util` entry point the events corpus reaches for.
//
// The formatting rules follow Node's `lib/internal/util/inspect.js` (MIT,
// Copyright Joyent, Inc. and other Node contributors) only where the output is
// observable through those messages: single-quoted strings with the quote picked
// to avoid escaping, `[Function: name]`, `{ a: 1 }` / `[ 1, 2 ]` spacing,
// `[Object]` past the depth limit, and `depth: -1` collapsing an object to its
// constructor name. It is not the full inspector.
//
// Engine notes (https://github.com/UrubuCode/zun/issues):
//   * `inspect` is declared as a top-level function and only then placed on the
//     `util` object, so `util.inspect.custom` stays readable: a method defined
//     inline in an object literal cannot carry properties (zun#14).
//   * `Number(x.length)` everywhere: the arithmetic on `.length` was widened,
//     but the checker still types it `u64`, so it can be neither assigned to
//     nor passed as a `number` (zun#3).
//   * `__utilUnbox` — a function stored in an array still reports
//     `typeof === "object"` (zun#17), so `[Function: name]` would otherwise be
//     printed as an object.

// `util.inspect.custom`, spelled as Node spells it. The symbol registry
// round-trips again (https://github.com/UrubuCode/zun/issues/23), so a caller
// that writes `Symbol.for('nodejs.util.inspect.custom')` — which is how Node's
// own docs tell you to reach it without importing `util` — gets *this* symbol.
// It used to be a plain `Symbol` and reachable only through
// `util.inspect.custom`, because `Symbol.for` handed back a fresh symbol on
// every call.
const __inspectCustomSymbol: any = Symbol.for("nodejs.util.inspect.custom");

const __INSPECT_DEFAULT_DEPTH: number = 2;

function __utilQuote(value: string): string {
  // Node prefers single quotes, then double, then backtick, choosing the first
  // that does not occur in the string.
  const hasSingle = Number(value.indexOf("'")) >= 0;
  const hasDouble = Number(value.indexOf('"')) >= 0;
  const hasBacktick = Number(value.indexOf("`")) >= 0;
  let quote = "'";
  if (hasSingle && !hasDouble) {
    quote = '"';
  } else if (hasSingle && hasDouble && !hasBacktick) {
    quote = "`";
  }
  let out = "";
  const n = Number(value.length);
  for (let i = 0; i < n; i++) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    if (ch === quote || ch === "\\") {
      out = out + "\\" + ch;
    } else if (code === 10) {
      out = out + "\\n";
    } else if (code === 13) {
      out = out + "\\r";
    } else if (code === 9) {
      out = out + "\\t";
    } else if (code < 32) {
      out = out + "\\x" + (code < 16 ? "0" : "1") + "0123456789abcdef".charAt(code % 16);
    } else {
      out = out + ch;
    }
  }
  return quote + out + quote;
}

// A function value that has ridden through an `any` lane inside an array is a
// `functionBox` record, not a callable (zun#17). It is recognised by the
// `__boxedFn` slot, which is readable even though the key is invisible to
// `Object.keys`.
function __utilUnbox(value: any): any {
  if (value !== null && value !== undefined && typeof value === "object") {
    const inner: any = value["__boxedFn"];
    if (inner !== undefined) return inner;
  }
  return value;
}

function __utilIsCallable(value: any): boolean {
  return typeof __utilUnbox(value) === "function";
}

// The name a constructor reports, used by `depth: -1` and by the
// `[EventEmitter]` / `[FakeInput]` form in the max-listeners warning. Class
// names are not reflected by this engine, so an explicit `constructor.name`
// is read when present and the generic `Object` is the fallback.
function __utilConstructorName(value: any): string {
  if (value === null || value === undefined) return "Object";
  const ctor: any = value.constructor;
  if (ctor === undefined || ctor === null) return "Object";
  const name: any = ctor.name;
  if (typeof name === "string" && name !== "") return name;
  return "Object";
}

function __utilInspectValue(value: any, depth: number, seen: any[]): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const kind = typeof value;
  if (kind === "string") return __utilQuote(value);
  if (kind === "number") {
    // `-0` inspects as `-0`, unlike `String(-0)`.
    if (value === 0 && 1 / value < 0) return "-0";
    return String(value);
  }
  if (kind === "boolean") return String(value);
  if (kind === "bigint") return String(value) + "n";
  if (kind === "symbol") return String(value);
  if (kind === "function") {
    const name: any = value.name;
    if (typeof name === "string" && name !== "") {
      return "[Function: " + name + "]";
    }
    return "[Function (anonymous)]";
  }
  if (__utilIsCallable(value)) return "[Function (anonymous)]";

  // From here on it is an object.
  if (value instanceof Error) {
    const stack: any = value.stack;
    if (typeof stack === "string" && stack !== "") return stack;
    const name: any = value.name;
    const message: any = value.message;
    const label = typeof name === "string" && name !== "" ? name : "Error";
    return message === undefined || message === "" ? label : label + ": " + String(message);
  }

  // `depth: -1` collapses any object to its constructor name, which is the form
  // the MaxListenersExceededWarning message uses.
  if (depth < 0) return "[" + __utilConstructorName(value) + "]";

  for (const previous of seen) {
    if (previous === value) return "[Circular *1]";
  }

  // A user-supplied `util.inspect.custom` wins, exactly as in Node. It is
  // invoked through a local binding, because a value read out of an `any`
  // receiver is not callable in place.
  const custom: any = value[__inspectCustomSymbol];
  if (__utilIsCallable(custom)) {
    const callable: any = __utilUnbox(custom);
    const produced: any = callable(depth, { depth: depth });
    return typeof produced === "string" ? produced : __utilInspectValue(produced, depth - 1, seen);
  }

  seen.push(value);
  let out = "";
  if (Array.isArray(value)) {
    const n = Number(value.length);
    if (n === 0) {
      out = "[]";
    } else {
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(__utilInspectValue(value[i], depth - 1, seen));
      }
      out = "[ " + parts.join(", ") + " ]";
    }
  } else {
    const keys = Object.keys(value);
    if (Number(keys.length) === 0) {
      out = "{}";
    } else {
      const parts: string[] = [];
      for (const key of keys) {
        parts.push(__utilInspectKey(key) + ": " + __utilInspectValue(value[key], depth - 1, seen));
      }
      out = "{ " + parts.join(", ") + " }";
    }
    const prefix = __utilConstructorName(value);
    if (prefix !== "Object" && prefix !== "") out = prefix + " " + out;
  }
  seen.pop();
  return out;
}

// An identifier-shaped key prints bare; anything else is quoted.
function __utilInspectKey(key: string): string {
  const n = Number(key.length);
  if (n === 0) return __utilQuote(key);
  for (let i = 0; i < n; i++) {
    const code = key.charCodeAt(i);
    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const isDigit = code >= 48 && code <= 57;
    const isWordPunct = code === 95 || code === 36; // _ $
    if (!isLetter && !isWordPunct && !(isDigit && i > 0)) return __utilQuote(key);
  }
  return key;
}

function inspect(value: any, options?: any): string {
  let depth = __INSPECT_DEFAULT_DEPTH;
  if (options !== undefined && options !== null && typeof options === "object") {
    const requested: any = options.depth;
    if (typeof requested === "number") depth = requested;
    if (requested === null) depth = 1000000;
  }
  const seen: any[] = [];
  return __utilInspectValue(value, depth, seen);
}

// `util.inspect.custom` is a property of the function itself, which is why
// `inspect` is a declaration rather than an object-literal method.
(inspect as any).custom = __inspectCustomSymbol;
(inspect as any).defaultOptions = { depth: __INSPECT_DEFAULT_DEPTH };

// `util.format`: only the substitutions the harness needs (`%s`, `%d`, `%i`,
// `%j`, `%o`, `%O`, `%%`), with trailing arguments appended space-separated.
function format(...args: any[]): string {
  const count = Number(args.length);
  if (count === 0) return "";
  const first: any = args[0];
  let out = "";
  let next = 1;
  if (typeof first === "string") {
    const n = Number(first.length);
    let i = 0;
    while (i < n) {
      const ch = first.charAt(i);
      if (ch === "%" && i + 1 < n) {
        const spec = first.charAt(i + 1);
        if (spec === "%") {
          out = out + "%";
          i = i + 2;
          continue;
        }
        if (next < count) {
          const value: any = args[next];
          if (spec === "s") {
            out = out + (typeof value === "string" ? value : inspect(value, { depth: 0 }));
            next = next + 1;
            i = i + 2;
            continue;
          }
          if (spec === "d" || spec === "i") {
            out = out + String(Number(value));
            next = next + 1;
            i = i + 2;
            continue;
          }
          if (spec === "f") {
            out = out + String(Number(value));
            next = next + 1;
            i = i + 2;
            continue;
          }
          if (spec === "j") {
            out = out + JSON.stringify(value);
            next = next + 1;
            i = i + 2;
            continue;
          }
          if (spec === "o" || spec === "O") {
            out = out + inspect(value);
            next = next + 1;
            i = i + 2;
            continue;
          }
        }
      }
      out = out + ch;
      i = i + 1;
    }
  } else {
    out = inspect(first);
  }
  while (next < count) {
    const value: any = args[next];
    out = out + " " + (typeof value === "string" ? value : inspect(value));
    next = next + 1;
  }
  return out;
}

// `util.inherits(ctor, superCtor)`. The engine has no prototype-chain model
// (`Object.setPrototypeOf` on a constructor's `prototype` is not honoured), so
// this records the relationship on `super_` the way Node does and copies
// nothing. It is enough for callers that only read `ctor.super_`; a real
// prototype graft is not expressible here.
function inherits(ctor: any, superCtor: any): void {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The "ctor" argument must be of type function');
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The "superCtor" argument must be of type function');
  }
  ctor.super_ = superCtor;
}

const util: any = {
  inspect,
  format,
  inherits,
  // `util.types`, reduced to the predicates the events corpus touches.
  types: {
    isPromise(value: any): boolean {
      if (value === null || value === undefined) return false;
      if (typeof value !== "object") return false;
      return __utilIsCallable(value.then);
    },
  },
  isArray(value: any): boolean {
    return Array.isArray(value);
  },
  isDeepStrictEqual(a: any, b: any): boolean {
    return __utilDeepEqual(a, b);
  },
};

function __utilDeepEqual(a: any, b: any): boolean {
  if (__utilUnbox(a) === __utilUnbox(b)) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (Number(a.length) !== Number(b.length)) return false;
    const n = Number(a.length);
    for (let i = 0; i < n; i++) {
      if (!__utilDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aKeys = Object.keys(a);
  if (Number(aKeys.length) !== Number(Object.keys(b).length)) return false;
  for (const key of aKeys) {
    if (!__utilDeepEqual(a[key], b[key])) return false;
  }
  return true;
}

// `node:util` module object for the bundler's `require` rewriting.
const __node_util: any = util;

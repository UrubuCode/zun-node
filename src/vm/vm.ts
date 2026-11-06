// node:vm — compiling and running source text at run time, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-vm-*.js` files (see ../../test/vm/).
// The argument validation, the option names and defaults, the order the checks
// run in and the error messages all follow Node's `lib/vm.js` and
// `lib/internal/validators.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors), because those are observable through the corpus rather than
// derivable from any general rule.
//
// ===========================================================================
// What the engine can actually do at run time
// ===========================================================================
//
// `vm` is the one Node module whose whole job is run-time compilation, so the
// first question is whether this platform has any. It does, and it is a *real*
// compile — not an interpreter written in this file:
//
//   * `new Function(p1, ..., body)` / `Function(...)` is lowered by the checker
//     to the `functionConstruct` intrinsic (`zun_sema/src/check/builtins/
//     object.rs`). The interpreter (`zun_interp/src/eval.rs`) hands the strings
//     to an injected `EvalHost`; the driver's host
//     (`zun_vm/src/eval_host.rs`) calls `zun_compiler::compile_without_prelude`
//     on `function __zun_eval(<params>): any { <body> }`, appends the resulting
//     module's methods to the live module with `Module::link`, re-verifies that
//     method range and returns a callable Tier-0 function value. Results are
//     memoised per `(params, body)` pair.
//   * There is **no `eval`** and no indirect eval: `eval` is not a binding in
//     the realm (`Object.keys(globalThis)` does not contain it) and no `.zun`
//     prelude declares it. `new Function` is the entire run-time compile
//     surface.
//   * There is no host/ABI entry point for compiling a *module*: `zun_abi`
//     publishes native functions to the engine, not the other way round, so an
//     extension cannot ask the compiler for anything. `Module::link` also
//     rejects any dynamically compiled module that declares or references a
//     type (`zun_module/src/link.rs`), which is why `class C {}` inside
//     compiled code fails with "dynamically compiled code may not declare or
//     reference types or external members".
//
// So this module is built on that compile path rather than on a fake. Every
// `Script` really is compiled by the project's own compiler, and every run
// really executes the compiled code.
//
// ---------------------------------------------------------------------------
// The two things `new Function` does not give us, and how this file bridges
// ---------------------------------------------------------------------------
//
// 1. **A function body, not a script.** `new Function(body)` returns
//    `undefined` unless `body` contains a `return`; a Node `Script` answers the
//    *completion value* of its last statement (`vm.runInThisContext("'passed';")`
//    is `'passed'`). `__vmScan` finds the top-level statement boundaries
//    of the source (tracking string, template, comment and regular-expression
//    literals and bracket depth), and `__vmCompile` walks them from the last
//    one backwards, asking the **real compiler** whether `<prefix>
//    __zunVmR = (<suffix>);` compiles. The first split that does is used, so
//    the completion value is the value of a suffix the compiler itself accepted
//    as an expression; when no split compiles, the body runs as statements and
//    the result is `undefined`. The scanner only *proposes* splits — it never
//    evaluates anything, and a bad proposal fails to compile and is discarded.
//
// 2. **Contextified globals.** A Node context is a separate V8 global object
//    whose properties the script sees as globals. This engine has one realm
//    global, and the compiled body reaches it in two ways that were probed
//    directly:
//      * a free identifier *read* lowers to `globalGet(name)`, so anything on
//        the realm global is visible by bare name (and `typeof missing` is
//        `"undefined"` rather than a throw, as in JavaScript);
//      * a free identifier *write* is a **compile error** —
//        ``unknown variable `foo` `` — because the checker only lets an
//        assignment reach `globalSet` for a name in the compilation unit's own
//        `module_globals` (`zun_sema/src/check/expr/assign.rs`), and a
//        dynamically compiled unit has none.
//    `__vmCompile` turns that compile error into the mechanism: the diagnostic
//    *names* every implicitly assigned global, so the names are collected out
//    of the message, declared as `let` at the top of the generated body
//    (initialised from the active context) and copied back to the context in a
//    `finally`. That is the compiler telling us which names a script assigns,
//    not a guess. Reads are served by installing the context object's own
//    properties on the realm global for the duration of the run and restoring
//    them afterwards (`__vmInstall`/`__vmUninstall`). Top-level `var` and
//    `function` declarations are copied back as well, because in Node they
//    become properties of the context global where `let` and `const` do not —
//    the difference `test-vm-function-declaration.js` pins.
//
//    This is **emulation, and it is documented as such rather than dressed up**:
//    one realm means a context cannot *hide* the host's globals, so
//    `vm.runInNewContext('typeof process')` answers `"object"` where Node
//    answers `"undefined"`, and a script in a "new" context can still reach
//    everything the bundle declared. `createContext` marks the object so
//    `isContext` is exact, and the property bridge is exact for the names a
//    script reads and writes; isolation is the part this platform cannot
//    provide, and the per-test table in ../../test/vm/README.md says so for
//    every file it costs.
//
// ---------------------------------------------------------------------------
// Engine gaps that cost tests here (each probed standalone)
// ---------------------------------------------------------------------------
//   * `new Error("boom")` inside dynamically compiled code evaluates to a
//     **function value**, not an error: `typeof new Error("m")` is `"function"`,
//     `.message`/`.name` read back `undefined`, `instanceof Error` is `false`
//     and the value is opaque to the host (`String(e)` is `"[any]"`).
//     `Error` is a builtin class, `Module::link` forbids the type reference a
//     `new` of one needs, so the identifier resolves through `globalGet` to the
//     realm class descriptor and `new` on that yields the descriptor itself —
//     with no diagnostic. `Date` and `Symbol`'s methods are lost the same way,
//     and `JSON.stringify` answers "stringify is not a function". This is the
//     single biggest blocker in the corpus: `assert.throws(() =>
//     vm.runInThisContext('throw new Error("test")'), /test/)` cannot match,
//     so every file that checks a thrown error fails. Reported with this work.
//   * `this` inside a compiled body is `undefined` — there is no
//     function-`this` model (zun#25) — so `this.x = 1`, which is how Node's
//     corpus writes to the context global, has no receiver. Worse, the store
//     does not throw a `TypeError`: it reaches `Value::as_object`
//     (`zun_interp/src/value.rs:228`) and **panics the interpreter**
//     ("expected object, found Void"), which no `try`/`catch` can see. About
//     fifteen files in the corpus die there. A compiled function also has no
//     `name`, `length` or `toString`, so `vm.compileFunction(...).toString()`
//     cannot be Node's `function () {\n<code>\n}`.
//   * `zun run --ext <lib> file.ts` injects **no** `EvalHost`
//     (`zun_vm::execute_with_extensions` calls `run_with` with no host, while
//     `zun run file.ts` goes through `execute_with`, which injects
//     `CompilerEvalHost`), so loading any native extension silently removes
//     run-time code generation: `new Function` answers "code generation from
//     strings disallowed". That is why this module's tracker kind is `zun-ts`
//     and why the CI workflow excludes `vm` from `--ext`.
//   * `EvalHost::compile_function` types every parameter `number`
//     (`zun_vm/src/eval_host.rs`: "v1 typing"), so `new Function("s", "return
//     s.length")` fails to compile with "type Float(F64) has no fields".
//     `compileFunction`'s parameters therefore do not use that path at all:
//     they are `let` bindings read out of a realm-global argument array
//     (`__zunVmArgs`), which carries values of any type.
//   * There is no interruptible execution and no stack-map-based unwind from
//     outside, so `timeout` and `breakOnSigint` are validated and then
//     ignored; a runaway script runs to completion. There is no code cache
//     either, so `produceCachedData` honestly reports
//     `cachedDataProduced: false` and a supplied `cachedData` is honestly
//     rejected rather than silently accepted.
//   * `--experimental-vm-modules` has no counterpart here (the bundler passes
//     no V8 flags), and ES module instantiation needs a compile entry this
//     platform does not expose, so `vm.Module`, `vm.SourceTextModule` and
//     `vm.SyntheticModule` are **absent** — which is exactly their shape in a
//     Node run without that flag.
//
// Like `path` and `events`, `vm` needs no syscall, so it is Zun TypeScript
// rather than a `zun_abi` extension (PLAN.md principle 2).

// ---------------------------------------------------------------------------
// The names the generated body uses
// ---------------------------------------------------------------------------
//
// All three are realm globals the host sets immediately before a run and
// restores immediately after, because a free identifier inside compiled code
// resolves through `globalGet` and that is the only channel into it. They are
// spelled with a `__zunVm` prefix so a script of the user's own cannot
// plausibly collide with them.
const __VM_CTX: string = "__zunVmCtx";
const __VM_ARGS: string = "__zunVmArgs";
const __VM_RESULT: string = "__zunVmR";

// The default `filename` Node gives a `Script` with no `options.filename`.
const __VM_DEFAULT_FILENAME: string = "evalmachine.<anonymous>";

// How many rounds of "compile, read the unknown-variable names, retry" to run
// before giving up. Each round adds at least one name, and a script with more
// than this many distinct implicit globals is not something the corpus has.
const __VM_MAX_BRIDGE_ROUNDS: number = 12;

// How many statement boundaries to try as the completion-value split, counted
// back from the end of the source. Each attempt is a full compile, so this
// bounds the cost of a long script whose last statement is not an expression.
const __VM_MAX_SPLITS: number = 16;

// ---------------------------------------------------------------------------
// Validators (lib/internal/validators.js, reduced to what `vm` uses)
// ---------------------------------------------------------------------------
//
// `events`' `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` / `ERR_INVALID_ARG_VALUE`
// classes and its `__evValidateObject` / `__evValidateBoolean` are already in
// every bundle, so only the validators `events` has no use for are written
// here.

const __VM_INT32_MIN: number = -2147483648;
const __VM_INT32_MAX: number = 2147483647;
const __VM_UINT32_MAX: number = 4294967295;

function __vmValidateString(value: any, name: string): void {
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }
}

function __vmValidateInt32(value: any, name: string): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < __VM_INT32_MIN || value > __VM_INT32_MAX) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(__VM_INT32_MIN) + " && <= " + String(__VM_INT32_MAX),
      value,
    );
  }
}

// `validateUint32(value, name, positive)` — the `positive` form is what
// `options.timeout` uses, so `0` is out of range there.
function __vmValidateUint32(value: any, name: string, positive: boolean): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  // A conditional whose branches are two integer literals yields an `Any`,
  // and storing one in a `number` panics the interpreter, so the bound is
  // chosen with a statement instead.
  let min: number = 0;
  if (positive) min = 1;
  if (value < min || value > __VM_UINT32_MAX) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(min) + " && <= " + String(__VM_UINT32_MAX),
      value,
    );
  }
}

function __vmValidateArray(value: any, name: string): void {
  if (!Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
  }
}

function __vmValidateStringArray(value: any, name: string): void {
  __vmValidateArray(value, name);
  const n: number = Number(value.length);
  for (let i = 0; i < n; i++) {
    __vmValidateString(value[i], name + "[" + String(i) + "]");
  }
}

// `validateBuffer(value, name)` — an `ArrayBuffer` *view*, which is what
// `cachedData` is. The engine's `ArrayBuffer.isView` is the same predicate
// Node's `isArrayBufferView` is.
function __vmValidateBuffer(value: any, name: string): void {
  if (!ArrayBuffer.isView(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, ["Buffer", "TypedArray", "DataView"], value);
  }
}

// `validateObject(value, name, kValidateObjectAllowArray)` — `isContext`'s
// form, which takes an array (Node's own `vm.createContext([])` test).
function __vmValidateObjectAllowArray(value: any, name: string): void {
  if (value === null || typeof value !== "object") {
    throw new ERR_INVALID_ARG_TYPE(name, "object", value);
  }
}

// `validateObject(value, name, kValidateObjectAllowNullable)` —
// `options.contextExtensions[i]`'s form.
function __vmValidateObjectNullable(value: any, name: string): void {
  if (value === null) return;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "object", value);
  }
}

// `validateOneOf(value, name, oneOf)`, with `undefined` spelled in the list the
// way `lib/vm.js` spells it for `microtaskMode`.
function __vmValidateOneOf(value: any, name: string, oneOf: any[]): void {
  let found = false;
  const n: number = Number(oneOf.length);
  for (let i = 0; i < n; i++) {
    if (oneOf[i] === value) {
      found = true;
      break;
    }
  }
  if (found) return;
  const shown: string[] = [];
  for (let i = 0; i < n; i++) {
    const entry: any = oneOf[i];
    shown.push(typeof entry === "string" ? "'" + entry + "'" : String(entry));
  }
  throw new ERR_INVALID_ARG_VALUE(name, value, "must be one of: " + shown.join(", "));
}

// ---------------------------------------------------------------------------
// Source scanning: where the top-level statements of a script end
// ---------------------------------------------------------------------------

function __vmIsIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
}

function __vmIsIdentChar(c: string): boolean {
  return __vmIsIdentStart(c) || (c >= "0" && c <= "9");
}

function __vmIsIdentifier(name: string): boolean {
  const n: number = Number(name.length);
  if (n === 0) return false;
  if (!__vmIsIdentStart(name.charAt(0))) return false;
  for (let i = 1; i < n; i++) {
    if (!__vmIsIdentChar(name.charAt(i))) return false;
  }
  return true;
}

// After one of these words a `/` opens a regular expression rather than a
// division: the scanner needs them so a literal such as `return /a;b/.test(x)`
// does not look like two statements.
function __vmRegexAfterWord(word: string): boolean {
  return (
    word === "return" ||
    word === "typeof" ||
    word === "instanceof" ||
    word === "in" ||
    word === "of" ||
    word === "new" ||
    word === "delete" ||
    word === "void" ||
    word === "throw" ||
    word === "case" ||
    word === "do" ||
    word === "else" ||
    word === "yield" ||
    word === "await"
  );
}

// One pass over the source, answering the two things the body generator needs:
//
//   * `bounds` — the index just past every top-level statement terminator
//     (`;` or `}` at bracket depth 0), with 0 first so "the whole source is one
//     expression" is the last split tried;
//   * `vars` / `fns` — the names a script's top-level `var` and `function`
//     declarations put on the *context global* in Node. `let` and `const` do
//     not (Node's own `test-vm-function-declaration.js` pins that difference),
//     so they are not collected.
//
// Nothing here evaluates anything. A boundary is a *proposal* that
// `__vmCompile` keeps only if the compiler accepts the split, and a collected
// name only adds a copy-back line. The scan tracks line and block comments,
// the three string forms, regular-expression literals and bracket depth; a
// declaration nested inside a block (`if (x) { var y; }`) is at depth 1 and is
// therefore missed, which is a documented limit rather than a wrong answer
// about the names it does report.
function __vmScan(code: string): any {
  const bounds: number[] = [0];
  const vars: string[] = [];
  const fns: string[] = [];
  const n: number = Number(code.length);
  let i = 0;
  let depth = 0;
  let prev = "";
  let prevWord = "";
  // "var" while a `var` statement is still being read, "fn" just after the
  // word `function`, "" otherwise.
  let mode = "";
  let expectIdent = false;
  while (i < n) {
    const c: string = code.charAt(i);
    // comments
    if (c === "/" && i + 1 < n) {
      const d: string = code.charAt(i + 1);
      if (d === "/") {
        i = i + 2;
        while (i < n && code.charAt(i) !== "\n") i++;
        continue;
      }
      if (d === "*") {
        i = i + 2;
        while (i + 1 < n && !(code.charAt(i) === "*" && code.charAt(i + 1) === "/")) i++;
        i = i + 2;
        continue;
      }
    }
    // regular-expression literal: a `/` that cannot be a division, i.e. one
    // that does not follow a value.
    if (c === "/") {
      const afterValue: boolean =
        (__vmIsIdentChar(prev) && !__vmRegexAfterWord(prevWord)) ||
        prev === ")" ||
        prev === "]" ||
        prev === '"' ||
        prev === "'" ||
        prev === "`";
      if (!afterValue) {
        i++;
        let inClass = false;
        while (i < n) {
          const d: string = code.charAt(i);
          if (d === "\\") {
            i = i + 2;
            continue;
          }
          if (d === "\n") break;
          if (d === "[") inClass = true;
          else if (d === "]") inClass = false;
          else if (d === "/" && !inClass) {
            i++;
            break;
          }
          i++;
        }
        while (i < n && __vmIsIdentChar(code.charAt(i))) i++;
        prev = "/";
        prevWord = "";
        continue;
      }
    }
    // string and template literals
    if (c === '"' || c === "'" || c === "`") {
      i++;
      while (i < n) {
        const d: string = code.charAt(i);
        if (d === "\\") {
          i = i + 2;
          continue;
        }
        if (d === c) {
          i++;
          break;
        }
        i++;
      }
      prev = c;
      prevWord = "";
      expectIdent = false;
      continue;
    }
    // identifier run, tracked so the regex test above can look at the word and
    // so a declaration's name can be collected
    if (__vmIsIdentStart(c)) {
      const at: number = i;
      while (i < n && __vmIsIdentChar(code.charAt(i))) i++;
      const word: string = code.slice(at, i);
      if (depth === 0) {
        if (word === "var") {
          mode = "var";
          expectIdent = true;
        } else if (word === "function") {
          mode = "fn";
          expectIdent = true;
        } else if (expectIdent) {
          if (mode === "var") {
            if (!__vmHas(vars, word)) vars.push(word);
          } else if (mode === "fn") {
            if (!__vmHas(fns, word)) fns.push(word);
            mode = "";
          }
          expectIdent = false;
        }
      }
      prevWord = word;
      prev = code.charAt(i - 1);
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth > 0) depth--;
    }
    if (depth === 0) {
      if (c === ",") {
        // the next declarator of the same `var` statement
        if (mode === "var") expectIdent = true;
      } else if (c === ";" || c === "}") {
        mode = "";
        expectIdent = false;
      } else if (c !== " " && c !== "\t" && c !== "\n" && c !== "\n" && mode === "fn") {
        // `function (` — an anonymous function expression has no name to take
        expectIdent = false;
        mode = "";
      }
    }
    if (depth === 0 && (c === ";" || c === "}")) bounds.push(i + 1);
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\n") {
      prev = c;
      prevWord = "";
    }
    i++;
  }
  return { bounds: bounds, vars: vars, fns: fns };
}

// Trailing whitespace and one trailing `;` removed, so a statement such as
// `typeof Object;` can be wrapped as an expression.
function __vmTrimCompletion(text: string): string {
  let end: number = Number(text.length);
  while (end > 0) {
    const c: string = text.charAt(end - 1);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      end--;
      continue;
    }
    break;
  }
  if (end > 0 && text.charAt(end - 1) === ";") end--;
  let start = 0;
  while (start < end) {
    const c: string = text.charAt(start);
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      start++;
      continue;
    }
    break;
  }
  return text.slice(start, end);
}

// ---------------------------------------------------------------------------
// The compile driver
// ---------------------------------------------------------------------------

// `new Function(body)`, with the thrown value (a plain string from the
// interpreter's `functionConstruct`) returned instead of propagating.
function __vmTryCompile(body: string): any {
  try {
    const fn: any = new Function(body);
    return { fn: fn, error: "" };
  } catch (e: any) {
    const message: string = String(e);
    // A compile that reports nothing is still a failure; keep a non-empty
    // marker so the caller's `error === ""` test stays meaningful.
    return { fn: undefined, error: message === "" ? "SyntaxError" : message };
  }
}

// Every name in ``unknown variable `x` `` out of a compiler diagnostic. The
// host joins all diagnostics of one compile with "; ", so a body that assigns
// three implicit globals reports all three at once.
function __vmUnknownNames(message: string): string[] {
  const out: string[] = [];
  const marker: string = "unknown variable `";
  let at: number = Number(message.indexOf(marker));
  while (at !== -1) {
    const start: number = at + Number(marker.length);
    const end: number = Number(message.indexOf("`", start));
    if (end === -1) break;
    out.push(message.slice(start, end));
    at = Number(message.indexOf(marker, end + 1));
  }
  return out;
}

function __vmHas(list: string[], name: string): boolean {
  const n: number = Number(list.length);
  for (let i = 0; i < n; i++) {
    if (list[i] === name) return true;
  }
  return false;
}

// The generated body:
//
//     let <param> = __zunVmArgs[<i>];      // compileFunction only
//     let <bridged> = __zunVmCtx["<bridged>"];
//     let __zunVmR;
//     try {
//     <prefix>
//     __zunVmR = (<completion>
//     );
//     __zunVmCtx["<fn>"] = <fn>;
//     } finally {
//     __zunVmCtx["<bridged>"] = <bridged>;
//     __zunVmCtx["<var>"] = <var>;
//     }
//     return __zunVmR;
//
// The `try`/`finally` is emitted only when there is something to copy back, so
// a script with no names to bridge compiles to the source plus a `return`. The
// newline before the closing parenthesis of the completion expression lets the
// source end in a line comment.
//
// `<var>` is copied back in the `finally` because a `var` declared inside a
// `try` block *is* visible from its `finally` in this engine (it is hoisted to
// the function, as in JavaScript), so a script that throws halfway still
// leaves its declarations on the context. A `function` declaration is **not**
// visible there -- it is block-scoped here -- so those are copied at the end
// of the `try` block instead, which is the one place they are in scope.
function __vmBuildBody(
  params: string[],
  bridged: string[],
  hoistedVars: string[],
  hoistedFns: string[],
  prefix: string,
  completion: string,
  hasCompletion: boolean,
): string {
  let out = "";
  const np: number = Number(params.length);
  for (let i = 0; i < np; i++) {
    out = out + "let " + params[i] + " = " + __VM_ARGS + "[" + String(i) + "];\n";
  }
  const nb: number = Number(bridged.length);
  for (let i = 0; i < nb; i++) {
    out = out + "let " + bridged[i] + " = " + __VM_CTX + '["' + bridged[i] + '"];\n';
  }
  out = out + "let " + __VM_RESULT + ";\n";
  let inner: string = prefix + "\n";
  if (hasCompletion) {
    inner = inner + __VM_RESULT + " = (" + completion + "\n);\n";
  }
  const nf: number = Number(hoistedFns.length);
  for (let i = 0; i < nf; i++) {
    inner = inner + __VM_CTX + '["' + hoistedFns[i] + '"] = ' + hoistedFns[i] + ";\n";
  }
  const nv: number = Number(hoistedVars.length);
  if (nb > 0 || nv > 0) {
    out = out + "try {\n" + inner + "} finally {\n";
    for (let i = 0; i < nb; i++) {
      out = out + __VM_CTX + '["' + bridged[i] + '"] = ' + bridged[i] + ";\n";
    }
    for (let i = 0; i < nv; i++) {
      out = out + __VM_CTX + '["' + hoistedVars[i] + '"] = ' + hoistedVars[i] + ";\n";
    }
    out = out + "}\n";
  } else {
    out = out + inner;
  }
  return out + "return " + __VM_RESULT + ";\n";
}

// Compile `code` into a callable, discovering the implicit globals it assigns
// and (for a script) the completion-value split.
//
// `asFunction` is `true` for `vm.compileFunction`, whose value comes from an
// explicit `return` rather than from a completion value and whose declarations
// are function-local rather than context properties, so neither the split
// search nor the hoisted-name copy-back applies to it.
//
// Returns `{ fn, bridged, error }`; a non-empty `error` is the compiler's own
// diagnostic text and nothing was compiled.
function __vmCompile(code: string, params: string[], asFunction: boolean): any {
  const scan: any = __vmScan(code);
  const hoistedVars: string[] = asFunction ? [] : scan.vars;
  const hoistedFns: string[] = asFunction ? [] : scan.fns;
  const bridged: string[] = [];
  let error = "";
  let rounds = 0;
  while (rounds < __VM_MAX_BRIDGE_ROUNDS) {
    rounds++;
    const attempt: any = __vmTryCompile(
      __vmBuildBody(params, bridged, hoistedVars, hoistedFns, code, "", false),
    );
    if (attempt.error === "") {
      error = "";
      break;
    }
    error = attempt.error;
    const names: string[] = __vmUnknownNames(error);
    let added = false;
    const nn: number = Number(names.length);
    for (let i = 0; i < nn; i++) {
      const name: string = names[i];
      if (
        !__vmHas(bridged, name) &&
        !__vmHas(params, name) &&
        !__vmHas(hoistedVars, name) &&
        __vmIsIdentifier(name)
      ) {
        bridged.push(name);
        added = true;
      }
    }
    if (!added) break;
  }
  // A copy-back line can be the only thing that fails to compile -- a
  // `function` name read as a value is lost in this engine (zun#17/#19) -- and
  // losing the whole script over it would be worse than losing the copy. So
  // the hoisted names are dropped and the discovery is redone without them
  // before the source itself is declared a syntax error.
  if (error !== "" && (Number(hoistedVars.length) > 0 || Number(hoistedFns.length) > 0)) {
    const plain: any = __vmCompile(code, params, true);
    if (plain.error === "") {
      if (asFunction) return plain;
      return __vmCompleteSplit(code, params, [], [], plain.bridged, plain);
    }
  }
  if (error !== "") return { fn: undefined, bridged: bridged, error: error };
  if (asFunction) {
    const plain: any = __vmTryCompile(
      __vmBuildBody(params, bridged, hoistedVars, hoistedFns, code, "", false),
    );
    return { fn: plain.fn, bridged: bridged, error: plain.error };
  }
  return __vmCompleteSplit(code, params, hoistedVars, hoistedFns, bridged, undefined);
}

// The completion-value search: walk the top-level statement boundaries from the
// last one backwards and keep the first split the compiler accepts as
// `<statements> __zunVmR = (<expression>);`. `fallback` is the already-compiled
// statement-only form to answer with when no split compiles.
function __vmCompleteSplit(
  code: string,
  params: string[],
  hoistedVars: string[],
  hoistedFns: string[],
  bridged: string[],
  fallback: any,
): any {
  const scan: any = __vmScan(code);
  const bounds: number[] = scan.bounds;
  let tried = 0;
  for (let i = Number(bounds.length) - 1; i >= 0 && tried < __VM_MAX_SPLITS; i--) {
    const at: number = bounds[i];
    const tail: string = __vmTrimCompletion(code.slice(at));
    if (tail === "") continue;
    tried++;
    const attempt: any = __vmTryCompile(
      __vmBuildBody(params, bridged, hoistedVars, hoistedFns, code.slice(0, at), tail, true),
    );
    if (attempt.error === "") {
      return { fn: attempt.fn, bridged: bridged, error: "" };
    }
  }
  if (fallback !== undefined) return fallback;
  // No completion value: the statement-only form, which the discovery loop in
  // `__vmCompile` already proved compiles.
  const plain: any = __vmTryCompile(
    __vmBuildBody(params, bridged, hoistedVars, hoistedFns, code, "", false),
  );
  return { fn: plain.fn, bridged: bridged, error: plain.error };
}

// `Script.sourceMapURL` — V8's source-map magic comment, which is the **last**
// `//# sourceMappingURL=` (or the older `//@ `) line comment in the source; the
// value is the rest of that line with surrounding whitespace removed, and
// `undefined` when there is none. A comment without the `#`/`@` marker is not
// one, which is what Node's own "malformed magic comment" case pins.
function __vmSourceMapURL(code: string): any {
  const markers: string[] = ["//# sourceMappingURL=", "//@ sourceMappingURL="];
  let best: number = -1;
  let bestEnd: number = -1;
  for (let m = 0; m < 2; m++) {
    const marker: string = markers[m];
    let at: number = Number(code.indexOf(marker));
    while (at !== -1) {
      if (at > best) {
        best = at;
        bestEnd = at + Number(marker.length);
      }
      at = Number(code.indexOf(marker, at + 1));
    }
  }
  if (best === -1) return undefined;
  let end: number = Number(code.indexOf("\n", bestEnd));
  if (end === -1) end = Number(code.length);
  const url: string = code.slice(bestEnd, end).trim();
  return url === "" ? undefined : url;
}

// A compiler diagnostic reduced to the message a `SyntaxError` should carry.
//
// Two layers of wrapping come off. The interpreter prefixes its own
// `SyntaxError: `, which would otherwise be doubled by the error class. And a
// *parse* failure arrives as the `Debug` formatting of the parser's diagnostic
// struct — `OxcDiagnostic { inner: OxcDiagnosticInner { message: "Unexpected
// token", labels: [...], ... } }` — of which only the `message` field is for a
// reader; the span and the label vector are Rust internals. Unwrapping it
// leaves the compiler's own words, which is what Node's message is too
// ("Unexpected token '}'"), just without V8's offending token.
function __vmSyntaxMessage(diagnostic: string): string {
  let text: string = diagnostic;
  const prefix: string = "SyntaxError: ";
  if (text.slice(0, Number(prefix.length)) === prefix) {
    text = text.slice(Number(prefix.length));
  }
  const marker: string = 'OxcDiagnosticInner { message: "';
  const at: number = Number(text.indexOf(marker));
  if (at !== -1) {
    const start: number = at + Number(marker.length);
    const end: number = Number(text.indexOf('"', start));
    if (end !== -1) return text.slice(start, end);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------
//
// Compiled scripts, by key: `__vmCompiled[key]` is the callable `new Function`
// returned for that script's source. See `Script.scriptId` for why this is not
// an instance field.
const __vmCompiled: any = {};
// A module-level `let` is stored on the realm global and read back through
// `globalGet`, which answers an `Any`; storing that in a binding declared
// `number` panics the interpreter ("expected float, found Any"). Every
// mutable counter in this file is therefore declared `any`.
let __vmNextScriptId: any = 1;

// `createContext` marks the object it is given and hands the very same object
// back (Node's `assert.strictEqual(sandbox, context)`), so the marker is a list
// of the marked objects rather than anything stored on them — a property would
// be visible to `Object.keys(sandbox)`, which `test-vm-basic.js` compares with
// `assert.deepStrictEqual`. A `WeakSet` would be the natural home, but its
// methods are lost through an `any` (zun#7), so the list is an array scanned by
// identity.
const __vmContexts: any[] = [];

// `vm.constants.DONT_CONTEXTIFY` / `USE_MAIN_CONTEXT_DEFAULT_LOADER` are
// internal symbols in Node; what matters about them is identity, which a
// `Symbol` here has too.
const __vmDontContextify: any = Symbol("vm_context_no_contextify");
const __vmMainContextDefaultLoader: any = Symbol("vm_dynamic_import_main_context_default");

let __vmContextNameIndex: any = 1;

function __vmIsContext(object: any): boolean {
  __vmValidateObjectAllowArray(object, "object");
  const n: number = Number(__vmContexts.length);
  for (let i = 0; i < n; i++) {
    if (__vmContexts[i] === object) return true;
  }
  return false;
}

function __vmValidateContext(contextifiedObject: any): void {
  let ok = false;
  if (contextifiedObject !== null && typeof contextifiedObject === "object") {
    ok = __vmIsContext(contextifiedObject);
  }
  if (!ok) {
    throw new ERR_INVALID_ARG_TYPE("contextifiedObject", "vm.Context", contextifiedObject);
  }
}

// `lib/vm.js`' `createContext`.
function __vmCreateContext(contextObject?: any, options?: any): any {
  let target: any = contextObject === undefined ? {} : contextObject;
  if (target !== __vmDontContextify && __vmIsContext(target)) return target;

  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");

  let name: any = opts.name;
  if (name === undefined) {
    name = "VM Context " + String(__vmContextNameIndex);
    __vmContextNameIndex = __vmContextNameIndex + 1;
  }
  __vmValidateString(name, "options.name");
  const origin: any = opts.origin;
  if (origin !== undefined) __vmValidateString(origin, "options.origin");
  const codeGeneration: any = opts.codeGeneration;
  if (codeGeneration !== undefined) {
    __evValidateObject(codeGeneration, "options.codeGeneration");
    const strings: any = codeGeneration.strings;
    const wasm: any = codeGeneration.wasm;
    if (strings !== undefined) __evValidateBoolean(strings, "options.codeGeneration.strings");
    if (wasm !== undefined) __evValidateBoolean(wasm, "options.codeGeneration.wasm");
  }
  __vmValidateOneOf(opts.microtaskMode, "options.microtaskMode", ["afterEvaluate", undefined]);

  // `vm.constants.DONT_CONTEXTIFY` asks for a context whose global is a plain
  // new global object rather than a proxy over a sandbox; the object this
  // returns is that global.
  if (target === __vmDontContextify) target = {};
  __vmContexts.push(target);
  return target;
}

// `lib/vm.js`' `getContextOptions` — the `contextName`/`contextOrigin`/
// `contextCodeGeneration`/`microtaskMode` half of a run option bag, validated
// and renamed into `createContext`'s own option names.
function __vmGetContextOptions(options?: any): any {
  // `Script.runInNewContext(contextObject, options)` hands its `options`
  // straight through, so a non-object lands here: in JavaScript every
  // `options.contextName` read then answers `undefined`, while a member read
  // of a string panics this interpreter ("expected object, found Str"), so a
  // non-object is answered with the all-`undefined` bag it would produce.
  // `Script.runInContext` validates the same value a moment later and throws.
  if (options === undefined || options === null || typeof options !== "object") return {};
  const out: any = {
    name: options.contextName,
    origin: options.contextOrigin,
    codeGeneration: undefined,
    microtaskMode: options.microtaskMode,
  };
  if (out.name !== undefined) __vmValidateString(out.name, "options.contextName");
  if (out.origin !== undefined) __vmValidateString(out.origin, "options.contextOrigin");
  if (options.contextCodeGeneration !== undefined) {
    __evValidateObject(options.contextCodeGeneration, "options.contextCodeGeneration");
    const strings: any = options.contextCodeGeneration.strings;
    const wasm: any = options.contextCodeGeneration.wasm;
    if (strings !== undefined) {
      __evValidateBoolean(strings, "options.contextCodeGeneration.strings");
    }
    if (wasm !== undefined) __evValidateBoolean(wasm, "options.contextCodeGeneration.wasm");
    out.codeGeneration = { strings: strings, wasm: wasm };
  }
  if (options.microtaskMode !== undefined) {
    __vmValidateString(options.microtaskMode, "options.microtaskMode");
  }
  return out;
}

// ---------------------------------------------------------------------------
// Installing a context's properties on the realm global for one run
// ---------------------------------------------------------------------------
//
// A free identifier *read* inside compiled code lowers to `globalGet(name)`, so
// the only way a context property can be visible by bare name is for it to be
// on the realm global while the script runs. Each installed name is saved with
// whether the realm had it at all, the value is copied back to the context
// afterwards (a script may have assigned through `globalThis.x = ...`), and
// then the previous state is restored — a name the realm did not have is
// deleted rather than left as `undefined`.
function __vmOwnNames(object: any): string[] {
  const out: string[] = [];
  const keys: any = Object.keys(object);
  const n: number = Number(keys.length);
  for (let i = 0; i < n; i++) {
    const key: any = keys[i];
    if (typeof key === "string") out.push(key);
  }
  return out;
}

function __vmRealmHas(name: string): boolean {
  const keys: any = Object.keys(globalThis);
  return Number(keys.indexOf(name)) !== -1;
}

// The realm's own key set as a map, so one install does not pay a linear scan
// of `Object.keys(globalThis)` per name — `vm.createContext(globalThis)` is a
// real spelling in the corpus and its key count is in the hundreds.
function __vmRealmKeys(): any {
  const set: any = {};
  const keys: any = Object.keys(globalThis);
  const n: number = Number(keys.length);
  for (let i = 0; i < n; i++) set[keys[i]] = true;
  return set;
}

function __vmInstall(source: any): any[] {
  const saved: any[] = [];
  if (source === null || typeof source !== "object") return saved;
  const global: any = globalThis;
  const present: any = __vmRealmKeys();
  const names: string[] = __vmOwnNames(source);
  const n: number = Number(names.length);
  for (let i = 0; i < n; i++) {
    const name: string = names[i];
    // The channel names are the host's own; a context must not be able to
    // shadow them or the bridge would read the script's value instead.
    if (name === __VM_CTX || name === __VM_ARGS || name === __VM_RESULT) continue;
    const incoming: any = source[name];
    const had: boolean = present[name] === true;
    const previous: any = global[name];
    // `vm.createContext(globalThis)` hands every realm global back to itself:
    // there is nothing to install, and some of them (`Math`, `Object`, ...) are
    // read-only, so writing would throw.
    if (had && previous === incoming) continue;
    try {
      global[name] = incoming;
    } catch (e: any) {
      // A non-writable realm global cannot be shadowed on this platform; the
      // script sees the realm's own value instead of the context's. Skipping
      // the entry keeps the restore honest rather than half-applied.
      continue;
    }
    saved.push({ name: name, had: had, value: previous, installed: incoming });
  }
  return saved;
}

// Undo an install. A name whose value the *script* changed is copied into the
// context first (that is how `globalThis.x = 1` inside a script reaches the
// sandbox); a name it left alone is not, because the context may already hold
// the newer value — the generated body's own copy-back runs in a `finally`
// *inside* the script, so it has already landed by the time this runs.
function __vmUninstall(target: any, saved: any[]): void {
  const global: any = globalThis;
  const n: number = Number(saved.length);
  for (let i = 0; i < n; i++) {
    const entry: any = saved[i];
    const name: string = entry.name;
    if (target !== null && typeof target === "object" && global[name] !== entry.installed) {
      target[name] = global[name];
    }
    try {
      if (entry.had) {
        global[name] = entry.value;
      } else {
        delete global[name];
      }
    } catch (e: any) {
      // see `__vmInstall`
    }
  }
}

// ---------------------------------------------------------------------------
// Running a compiled script against a context
// ---------------------------------------------------------------------------

function __vmRunCompiled(fn: any, context: any, isThisContext: boolean): any {
  if (fn === undefined) {
    // A `Script` whose source did not compile never reaches here: the
    // constructor throws. This guard is for the `createCachedData`-style paths
    // that can be reached on a script object built by other means.
    throw new NodeError("ERR_VM_SCRIPT_NOT_COMPILED", "Script has no compiled code");
  }
  const global: any = globalThis;
  const previousContext: any = global[__VM_CTX];
  const hadContext: boolean = __vmRealmHas(__VM_CTX);
  // `runInThisContext` *is* the realm global, so its properties are already
  // where compiled code looks for them and only the write bridge is needed.
  const saved: any[] = isThisContext ? [] : __vmInstall(context);
  global[__VM_CTX] = isThisContext ? globalThis : context;
  try {
    return fn();
  } finally {
    if (!isThisContext) __vmUninstall(context, saved);
    if (hadContext) {
      global[__VM_CTX] = previousContext;
    } else {
      delete global[__VM_CTX];
    }
  }
}

// `lib/vm.js`' `getRunInContextArgs`, reduced to the validation (there is no
// interruptible execution here, so `timeout` and `breakOnSigint` are checked
// and then have nothing to act on).
function __vmValidateRunOptions(options?: any): void {
  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");
  const timeout: any = opts.timeout;
  if (timeout !== undefined) __vmValidateUint32(timeout, "options.timeout", true);
  const displayErrors: any = opts.displayErrors === undefined ? true : opts.displayErrors;
  __evValidateBoolean(displayErrors, "options.displayErrors");
  const breakOnSigint: any = opts.breakOnSigint === undefined ? false : opts.breakOnSigint;
  __evValidateBoolean(breakOnSigint, "options.breakOnSigint");
}

// ---------------------------------------------------------------------------
// vm.Script
// ---------------------------------------------------------------------------
//
// `Script` is a top-level class rather than a member of the module object
// because `new <object>.Ctor()` does not reach a constructor in this engine
// (zun#18); the bundler rewrites `vm.Script` to this name, the way it does
// `stream.Readable`.
class Script {
  code: string = "";
  // `filename`, `lineOffset` and `columnOffset` come out of the option bag as
  // `any` after their validators have passed. Storing an `Any` in a field
  // declared `number` or `string` panics the interpreter ("expected float,
  // found Any"), so the declared type is the one the value actually has.
  filename: any = __VM_DEFAULT_FILENAME;
  lineOffset: any = 0;
  columnOffset: any = 0;
  // Node hangs these three on the script object itself, and a test reads them
  // back; there is no code cache on this platform, so `produceCachedData`
  // answers that it produced none and a supplied `cachedData` is rejected.
  cachedData: any = undefined;
  cachedDataProduced: any = undefined;
  cachedDataRejected: any = undefined;
  sourceMapURL: any = undefined;
  // The key into `__vmCompiled`, where the compiled callable lives.
  //
  // A function value stored in a **class instance field** reads back
  // `undefined` in this engine (zun#17/#19 -- the same gap that makes
  // `src/readline/readline.ts` keep its callbacks out of fields), while a
  // property of a plain object holds one perfectly well: that is how every
  // module object in this library carries its functions. So the compiled
  // callable goes in a module-level map and the script keeps only its key.
  scriptId: any = 0;

  constructor(code?: any, options?: any) {
    const source: string = code === undefined ? "undefined" : String(code);
    let opts: any = options;
    if (typeof opts === "string") {
      opts = { filename: opts };
    } else if (opts === undefined) {
      opts = {};
    } else {
      __evValidateObject(opts, "options");
    }

    const filename: any = opts.filename === undefined ? __VM_DEFAULT_FILENAME : opts.filename;
    __vmValidateString(filename, "options.filename");
    const lineOffset: any = opts.lineOffset === undefined ? 0 : opts.lineOffset;
    __vmValidateInt32(lineOffset, "options.lineOffset");
    const columnOffset: any = opts.columnOffset === undefined ? 0 : opts.columnOffset;
    __vmValidateInt32(columnOffset, "options.columnOffset");
    const cachedData: any = opts.cachedData;
    if (cachedData !== undefined) __vmValidateBuffer(cachedData, "options.cachedData");
    const produceCachedData: any =
      opts.produceCachedData === undefined ? false : opts.produceCachedData;
    __evValidateBoolean(produceCachedData, "options.produceCachedData");

    this.code = source;
    this.filename = filename;
    this.lineOffset = lineOffset;
    this.columnOffset = columnOffset;

    // Node compiles in the constructor, so a syntax error surfaces here and
    // not at the first run; this does the same, with the project's compiler.
    const result: any = __vmCompile(source, [], false);
    if (result.error !== "") {
      throw new SyntaxError(__vmSyntaxMessage(result.error));
    }
    this.scriptId = __vmNextScriptId;
    __vmNextScriptId = __vmNextScriptId + 1;
    __vmCompiled[String(this.scriptId)] = result.fn;

    this.sourceMapURL = __vmSourceMapURL(source);

    if (produceCachedData) this.cachedDataProduced = false;
    if (cachedData !== undefined) this.cachedDataRejected = true;
  }

  runInThisContext(options?: any): any {
    __vmValidateRunOptions(options);
    return __vmRunCompiled(__vmCompiled[String(this.scriptId)], globalThis, true);
  }

  runInContext(contextifiedObject?: any, options?: any): any {
    __vmValidateContext(contextifiedObject);
    __vmValidateRunOptions(options);
    return __vmRunCompiled(__vmCompiled[String(this.scriptId)], contextifiedObject, false);
  }

  runInNewContext(contextObject?: any, options?: any): any {
    const context: any = __vmCreateContext(contextObject, __vmGetContextOptions(options));
    return this.runInContext(context, options);
  }

  // There is no code cache, so the honest answer is a rejection rather than an
  // empty buffer that a later run would silently ignore.
  createCachedData(): any {
    throw new NodeError(
      "ERR_VM_CODE_CACHE_UNAVAILABLE",
      "this platform has no code cache: createCachedData() cannot produce one",
    );
  }
}

// ---------------------------------------------------------------------------
// The module statics
// ---------------------------------------------------------------------------

function __vmCreateScript(code?: any, options?: any): any {
  return new Script(code, options);
}

function __vmRunInContext(code?: any, contextifiedObject?: any, options?: any): any {
  __vmValidateContext(contextifiedObject);
  let opts: any = options;
  if (typeof opts === "string") opts = { filename: opts };
  const script: any = new Script(code, opts);
  return script.runInContext(contextifiedObject, opts);
}

function __vmRunInNewContext(code?: any, contextObject?: any, options?: any): any {
  let opts: any = options;
  if (typeof opts === "string") opts = { filename: opts };
  const context: any = __vmCreateContext(contextObject, __vmGetContextOptions(opts));
  const script: any = new Script(code, opts);
  return script.runInContext(context, opts);
}

function __vmRunInThisContext(code?: any, options?: any): any {
  let opts: any = options;
  if (typeof opts === "string") opts = { filename: opts };
  const script: any = new Script(code, opts);
  return script.runInThisContext(opts);
}

// `lib/vm.js`' `compileFunction`.
//
// Declared under Node's own name rather than a `__vm`-prefixed one, and listed
// as a canonical binding of `vm` in the bundler, so `vm.compileFunction(...)`
// is rewritten to a **static** call. That is not cosmetic: the value it returns
// is a closure, and a closure handed back through a *dynamic* member call
// reads as a non-callable box in this engine (zun#17/#19 -- the same gap that
// keeps a function out of a class field), so `vm.compileFunction('return
// 1')()` answered "null is not a function" until the call stopped being
// dynamic.
//
// The parameters do **not** become `new Function` parameters: the eval host
// types every one of them `number` (`zun_vm/src/eval_host.rs`), so
// `vm.compileFunction('return s.length', ['s'])('abc')` would fail to compile
// with "type Float(F64) has no fields". They are `let` bindings read out of a
// realm-global argument array instead, which carries any value, and the
// returned closure fills that array before each call.
function compileFunction(code?: any, params?: any, options?: any): any {
  __vmValidateString(code, "code");
  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");
  if (params !== undefined) __vmValidateStringArray(params, "params");

  const filename: any = opts.filename === undefined ? "" : opts.filename;
  __vmValidateString(filename, "options.filename");
  const columnOffset: any = opts.columnOffset === undefined ? 0 : opts.columnOffset;
  __vmValidateInt32(columnOffset, "options.columnOffset");
  const lineOffset: any = opts.lineOffset === undefined ? 0 : opts.lineOffset;
  __vmValidateInt32(lineOffset, "options.lineOffset");
  const cachedData: any = opts.cachedData;
  if (cachedData !== undefined) __vmValidateBuffer(cachedData, "options.cachedData");
  const produceCachedData: any =
    opts.produceCachedData === undefined ? false : opts.produceCachedData;
  __evValidateBoolean(produceCachedData, "options.produceCachedData");
  const parsingContext: any = opts.parsingContext;
  if (parsingContext !== undefined) {
    let ok = false;
    if (parsingContext !== null && typeof parsingContext === "object") {
      ok = __vmIsContext(parsingContext);
    }
    if (!ok) {
      throw new ERR_INVALID_ARG_TYPE("options.parsingContext", "Context", parsingContext);
    }
  }
  const contextExtensions: any =
    opts.contextExtensions === undefined ? [] : opts.contextExtensions;
  __vmValidateArray(contextExtensions, "options.contextExtensions");
  const ne: number = Number(contextExtensions.length);
  for (let i = 0; i < ne; i++) {
    __vmValidateObjectNullable(
      contextExtensions[i],
      "options.contextExtensions[" + String(i) + "]",
    );
  }

  const names: string[] = [];
  if (params !== undefined) {
    const np: number = Number(params.length);
    for (let i = 0; i < np; i++) names.push(String(params[i]));
  }
  const result: any = __vmCompile(String(code), names, true);
  if (result.error !== "") {
    throw new SyntaxError(__vmSyntaxMessage(result.error));
  }
  // The returned callable captures **one** number, the key of a registry row
  // holding everything else the call needs. A closure that captures several
  // bindings and is then reached through a *dynamic* member call
  // (`vm.compileFunction(...)`, which is what every test writes) makes the
  // engine throw "spread: value is not iterable" before the method body even
  // starts -- the closure environment is built at entry and that build fails.
  // One captured number is small enough to survive it.
  const key: string = String(__vmNextCompiledId);
  __vmNextCompiledId = __vmNextCompiledId + 1;
  __vmCompiledFunctions[key] = {
    fn: result.fn,
    context: parsingContext === undefined ? globalThis : parsingContext,
    inThisContext: parsingContext === undefined,
    extensions: contextExtensions,
  };
  return (a0?: any, a1?: any, a2?: any, a3?: any, a4?: any, a5?: any, a6?: any, a7?: any): any =>
    __vmInvokeCompiled(key, [a0, a1, a2, a3, a4, a5, a6, a7]);
}

// Rows for `compileFunction`'s callables, keyed by a stringified counter; see
// the comment at the `return` above for why the closure captures only the key.
const __vmCompiledFunctions: any = {};
let __vmNextCompiledId: any = 1;

// One call of a `compileFunction` result: publish the arguments where the
// compiled body reads them, install the `contextExtensions` as globals for the
// duration, run, and undo all of it.
function __vmInvokeCompiled(key: string, args: any[]): any {
  const row: any = __vmCompiledFunctions[key];
  const global: any = globalThis;
  const previousArgs: any = global[__VM_ARGS];
  const hadArgs: boolean = __vmRealmHas(__VM_ARGS);
  global[__VM_ARGS] = args;
  // `contextExtensions` are extra scopes Node gives the compiled function;
  // here they are installed on the realm global for the duration, exactly as a
  // context's own properties are.
  const extensions: any = row.extensions;
  const ne: number = extensions === undefined ? 0 : Number(extensions.length);
  const savedExtensions: any[] = [];
  for (let i = 0; i < ne; i++) {
    const extension: any = extensions[i];
    if (extension === null) continue;
    const entries: any[] = __vmInstall(extension);
    const n: number = Number(entries.length);
    for (let k = 0; k < n; k++) savedExtensions.push(entries[k]);
  }
  try {
    return __vmRunCompiled(row.fn, row.context, row.inThisContext);
  } finally {
    __vmUninstall(null, savedExtensions);
    if (hadArgs) {
      global[__VM_ARGS] = previousArgs;
    } else {
      delete global[__VM_ARGS];
    }
  }
}

// `vm.measureMemory` — `process.memoryUsage()` is the only heap fact this
// platform exposes, so the estimate is its `heapUsed` and the range is that
// single point rather than a fabricated interval. The shape, the option
// validation and the experimental warning are Node's.
let __vmMeasureMemoryWarned: any = false;

function __vmMeasureMemory(options?: any): any {
  if (__vmMeasureMemoryWarned !== true) {
    __vmMeasureMemoryWarned = true;
    try {
      process.emitWarning(
        "vm.measureMemory is an experimental feature and might change at any time",
        "ExperimentalWarning",
      );
    } catch (e: any) {
      // `process.emitWarning` is always present in a bundle; a failure here
      // must not turn a measurement into a rejection.
    }
  }
  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");
  const mode: any = opts.mode === undefined ? "summary" : opts.mode;
  __vmValidateOneOf(mode, "options.mode", ["summary", "detailed"]);
  const execution: any = opts.execution === undefined ? "default" : opts.execution;
  __vmValidateOneOf(execution, "options.execution", ["default", "eager"]);

  let used: any = 0;
  try {
    const usage: any = process.memoryUsage();
    const heapUsed: any = usage === undefined || usage === null ? 0 : usage.heapUsed;
    if (typeof heapUsed === "number") used = heapUsed;
  } catch (e: any) {
    used = 0;
  }
  const total: any = { jsMemoryEstimate: used, jsMemoryRange: [used, used] };
  const result: any = { total: total };
  if (mode === "detailed") {
    result.current = { jsMemoryEstimate: used, jsMemoryRange: [used, used] };
    result.other = [];
  }
  return Promise.resolve(result);
}

const __vmConstants: any = {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: __vmMainContextDefaultLoader,
  DONT_CONTEXTIFY: __vmDontContextify,
};

// `vm.Module`, `vm.SourceTextModule` and `vm.SyntheticModule` are absent, which
// is their shape in a Node run without `--experimental-vm-modules`: this
// platform has no flag to turn them on, and ES module instantiation would need
// a compile entry point the engine does not expose (see the header).
const __node_vm: any = {
  Script: Script,
  createContext: __vmCreateContext,
  createScript: __vmCreateScript,
  runInContext: __vmRunInContext,
  runInNewContext: __vmRunInNewContext,
  runInThisContext: __vmRunInThisContext,
  isContext: __vmIsContext,
  compileFunction: compileFunction,
  measureMemory: __vmMeasureMemory,
  constants: __vmConstants,
};

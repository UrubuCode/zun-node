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
//     ignored (zun#150); a runaway script runs to completion. There is no code cache
//     either, so `produceCachedData` honestly reports
//     `cachedDataProduced: false` and a supplied `cachedData` is honestly
//     rejected rather than silently accepted.
//   * There is no ES-module compile entry for run-time code, so
//     `vm.SourceTextModule` is a source rewrite onto the same `new Function`
//     floor (see the section near the end of this file); `vm.Module` and
//     `vm.SyntheticModule` are always available, as if
//     `--experimental-vm-modules` were on. Interrupting a run needs an engine
//     API that does not exist yet (zun#150).
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
// The host values a compiled script can name although they are not realm
// globals in compiled code (`process`, `console`); see `__vmReadNames`.
const __VM_HOST: string = "__zunVmHost";

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
  // Every identifier the source assigns to (`x = ...`, `x += ...`, `x++`,
  // `++x`) and every identifier it declares anywhere; see `__vmAssignedNames`.
  const assigned: string[] = [];
  const declared: string[] = [];
  const refs: string[] = [];
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
      if (
        prevWord === "let" || prevWord === "const" || prevWord === "var" ||
        prevWord === "function" || prevWord === "class"
      ) {
        if (!__vmHas(declared, word)) declared.push(word);
      } else if (prev !== ".") {
        if (!__vmHas(refs, word)) refs.push(word);
        let j: number = i;
        while (j < n && (code.charAt(j) === " " || code.charAt(j) === "	")) j++;
        const a: string = code.charAt(j);
        const b: string = j + 1 < n ? code.charAt(j + 1) : "";
        const pre2: string = at >= 2 ? code.slice(at - 2, at) : "";
        let isWrite = false;
        if (a === "=" && b !== "=" && b !== ">") isWrite = true;
        else if ((a === "+" && b === "+") || (a === "-" && b === "-")) isWrite = true;
        else if (pre2 === "++" || pre2 === "--") isWrite = true;
        else if (b === "=" && "+-*/%|&^".indexOf(a) !== -1 && a !== "") isWrite = true;
        else {
          const rest: string = code.slice(j, j + 4);
          if (
            rest.slice(0, 3) === "**=" || rest.slice(0, 3) === "<<=" ||
            rest.slice(0, 3) === ">>=" || rest === ">>>=" ||
            rest.slice(0, 3) === "??=" || rest.slice(0, 3) === "||=" ||
            rest.slice(0, 3) === "&&="
          ) {
            isWrite = true;
          }
        }
        if (isWrite && !__vmHas(assigned, word)) assigned.push(word);
      }
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
  return { bounds: bounds, vars: vars, fns: fns, assigned: assigned, declared: declared, refs: refs };
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
  const nr: number = Number(__vmReadBridged.length);
  for (let i = 0; i < nr; i++) {
    const r: string = __vmReadBridged[i];
    if (__vmHas(bridged, r) || __vmHas(params, r)) continue;
    out = out + "const " + r + " = " + __VM_CTX + '["' + r + '"] !== undefined ? ' +
      __VM_CTX + '["' + r + '"] : ' + __VM_HOST + '["' + r + '"];\n';
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

// The implicit globals a script assigns, found lexically. The engine used to
// reject a write to an undeclared name at compile time and name it in the
// diagnostic, which `__vmUnknownNames` still reads; it now compiles the write
// and throws `ReferenceError` when it runs, so the names have to be known up
// front. Over-approximating is harmless -- an extra bridged `let` is shadowed
// by any inner binding of the same name -- and a bridged name that collides
// with a declaration the scan missed makes the compile fail, which
// `__vmCompile` answers by retrying without the lexical guesses.
const __VM_KEYWORDS: string[] = [
  "this", "true", "false", "null", "undefined", "arguments", "eval", "if", "for",
  "while", "return", "typeof", "new", "delete", "void", "in", "of", "instanceof",
];
let __vmNoGuess: any = false;
// The read-only names bridged by the body being built; see `__vmReadNames`.
let __vmReadBridged: any = [];
const __vmResolvable: any = {};
const __VM_RESERVED: string[] = [
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "do",
  "else", "export", "extends", "finally", "function", "import", "let", "super", "switch",
  "throw", "try", "var", "with", "yield", "await", "async", "static", "get", "set",
];
// Free identifiers a script *reads* that compiled code cannot resolve. A
// module-level binding of the program is listed by `Object.keys(globalThis)`
// but is not reachable through `globalGet`, and neither are the prelude's
// `process` and `console`, so a context property installed under such a name
// would stay invisible. Each one is bridged as a `const` read from the context
// (falling back to the host value). Only names that do not resolve are
// bridged, so the over-approximation of the lexical scan cannot shadow a
// binding that works.
function __vmReadNames(scan: any, params: string[], vars: string[], fns: string[]): string[] {
  const out: string[] = [];
  const refs: string[] = scan.refs;
  const n: number = Number(refs.length);
  for (let i = 0; i < n; i++) {
    const name: string = refs[i];
    if (
      __vmHas(scan.declared, name) || __vmHas(scan.assigned, name) || __vmHas(params, name) ||
      __vmHas(vars, name) || __vmHas(fns, name) || __vmHas(__VM_KEYWORDS, name) ||
      __vmHas(__VM_RESERVED, name) || !__vmIsIdentifier(name) ||
      name === __VM_CTX || name === __VM_ARGS || name === __VM_RESULT || name === __VM_HOST
    ) {
      continue;
    }
    let ok: any = __vmResolvable[name];
    if (ok === undefined) {
      ok = true;
      try {
        const probe: any = new Function(
          "try { void (" + name + "); return true; } catch (e) { return false; }",
        );
        ok = probe() === true;
      } catch (e: any) {
        ok = true;
      }
      __vmResolvable[name] = ok;
    }
    if (ok !== true) out.push(name);
  }
  return out;
}
function __vmAssignedNames(scan: any, params: string[], vars: string[], fns: string[]): string[] {
  const out: string[] = [];
  const assigned: string[] = scan.assigned;
  const n: number = Number(assigned.length);
  for (let i = 0; i < n; i++) {
    const name: string = assigned[i];
    if (
      __vmHas(scan.declared, name) || __vmHas(params, name) || __vmHas(vars, name) ||
      __vmHas(fns, name) || __vmHas(__VM_KEYWORDS, name) || !__vmIsIdentifier(name) ||
      name === __VM_CTX || name === __VM_ARGS || name === __VM_RESULT
    ) {
      continue;
    }
    out.push(name);
  }
  return out;
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
  const bridged: string[] = __vmNoGuess
    ? []
    : __vmAssignedNames(scan, params, hoistedVars, hoistedFns);
  const guessed: boolean = Number(bridged.length) > 0;
  const previousReads: any = __vmReadBridged;
  __vmReadBridged = __vmNoGuess ? [] : __vmReadNames(scan, params, hoistedVars, hoistedFns);
  try {
    return __vmCompileWith(code, params, asFunction, hoistedVars, hoistedFns, bridged, guessed);
  } finally {
    __vmReadBridged = previousReads;
  }
}

function __vmCompileWith(
  code: string,
  params: string[],
  asFunction: boolean,
  hoistedVars: string[],
  hoistedFns: string[],
  bridged: string[],
  guessed: boolean,
): any {
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
  if (error !== "" && guessed) {
    __vmNoGuess = true;
    let retry: any;
    try {
      retry = __vmCompile(code, params, asFunction);
    } finally {
      __vmNoGuess = false;
    }
    if (retry.error === "") return retry;
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
  // `target` is never reassigned: in this engine a later `target = {}` made a
  // dynamic call (`vm.createContext(obj)`) see `contextObject` as `undefined`
  // at function entry, so the DONT_CONTEXTIFY case picks its own binding.
  const target: any = contextObject === undefined ? {} : contextObject;
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
  const global: any = target === __vmDontContextify ? {} : target;
  __vmContexts.push(global);
  return global;
}

// The canonical binding of `vm.createContext` (see the bundler's table): a
// dynamic `vm.createContext(obj)` call reached `__vmCreateContext` with its
// first argument read as `undefined` in this engine, so the call is made
// static.
function createContext(contextObject?: any, options?: any): any {
  return __vmCreateContext(contextObject, options);
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
  // A new context has V8's `console` but not Node's `process`.
  global[__VM_HOST] = isThisContext ? { process: process, console: console } : { console: console };
  try {
    // A script's `this` is its context global: `this.x = 1` and
    // `Object.defineProperty(this, ...)` must land on the sandbox.
    return fn.call(isThisContext ? globalThis : context);
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

// ---------------------------------------------------------------------------
// vm.Module / vm.SourceTextModule / vm.SyntheticModule
// ---------------------------------------------------------------------------
//
// The engine has no ES-module compile entry for run-time code, so a
// `SourceTextModule` is expressed over the same `new Function` floor as a
// `Script`: its source is rewritten into an async function body.
//
//   * every top-level `import` becomes a `let` per local binding plus a setter
//     closure the record keeps (`(v) => { local = v; }`), so a binding is live:
//     the exporter publishes a new value and every importer's setter runs;
//   * every top-level `export` declaration loses its keyword and is followed by
//     a `__zunVmM.pub("name", () => name)` call, which publishes the binding's
//     value at that point (an `export function` is published at the top of the
//     body, because function declarations are hoisted) and once more at the
//     end of the body;
//   * `export default <expr>` assigns a hidden `__zunVmD`;
//   * `import.meta` reads a per-module object and `import(...)` calls the
//     module's `importModuleDynamically`;
//   * the body is wrapped in `return (async () => { ... })();`, so top-level
//     `await` works and evaluation is a promise.
//
// Linking calls the user's linker per specifier and checks the answer the way
// `lib/internal/vm/module.js` does; once no module in the graph is still
// linking, the graph is instantiated: every module's export names are resolved
// (own exports, named re-exports, `export *`) and every import is bound, which
// is where `import { nonexistent }` becomes a `SyntaxError`. The top-level
// scan is lexical (strings, templates, comments and bracket depth are
// tracked; statement ends are found at a `;` or a newline at depth 0 that does
// not continue the expression), which covers the forms Node's tests write.

const __VM_MOD_REC: string = "__zunVmModRec";
let __vmModContextIds: any = [];
let __vmModMainIds: any = 0;

class ERR_VM_MODULE_STATUS extends NodeError {
  constructor(message: string) {
    super("ERR_VM_MODULE_STATUS", "Module status " + message);
  }
}

function __vmModInvalidThis(): any {
  return new NodeTypeError("ERR_INVALID_THIS", 'Value of "this" must be of type Module');
}

class __VmModuleReferenceError extends ReferenceError {
  code: string = "";
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function __vmModIsWordChar(c: string): boolean {
  return c !== "" && __vmIsIdentChar(c);
}

// Skip a string/template/comment starting at `i`; answers the index past it,
// or `i` itself when nothing is to be skipped there.
function __vmModSkip(code: string, i: number): number {
  const n: number = code.length;
  const c: string = code[i];
  if (c === "/" && i + 1 < n && code[i + 1] === "/") {
    let j = i + 2;
    while (j < n && code[j] !== "\n") j++;
    return j;
  }
  if (c === "/" && i + 1 < n && code[i + 1] === "*") {
    let j = i + 2;
    while (j + 1 < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
    return j + 2;
  }
  if (c === "'" || c === '"' || c === "`") {
    let j = i + 1;
    let depth = 0;
    while (j < n) {
      const d: string = code[j];
      if (d === "\\") {
        j += 2;
        continue;
      }
      if (c === "`" && d === "$" && j + 1 < n && code[j + 1] === "{") {
        // a template substitution: skip to its matching brace
        let k = j + 2;
        depth = 1;
        while (k < n && depth > 0) {
          const s: number = __vmModSkip(code, k);
          if (s !== k) {
            k = s;
            continue;
          }
          if (code[k] === "{") depth++;
          else if (code[k] === "}") depth--;
          k++;
        }
        j = k;
        continue;
      }
      if (d === c) return j + 1;
      j++;
    }
    return n;
  }
  return i;
}

function __vmModWs(code: string, i: number): number {
  const n: number = code.length;
  let j = i;
  while (j < n) {
    const c: string = code[j];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      j++;
      continue;
    }
    const s: number = __vmModSkip(code, j);
    if (s !== j && code[j] === "/") {
      j = s;
      continue;
    }
    break;
  }
  return j;
}

function __vmModWord(code: string, i: number): string {
  let j = i;
  while (j < code.length && __vmModIsWordChar(code[j])) j++;
  return code.substring(i, j);
}

// The index past the statement that starts at `i` (exclusive of a `;`, which
// is consumed).
function __vmModStatementEnd(code: string, i: number): number {
  const n: number = code.length;
  let depth = 0;
  let j = i;
  let last = "";
  while (j < n) {
    const s: number = __vmModSkip(code, j);
    if (s !== j) {
      j = s;
      last = "x";
      continue;
    }
    const c: string = code[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (depth < 0) return j;
    if (depth === 0 && c === ";") return j + 1;
    if (depth === 0 && c === "\n") {
      const k: number = __vmModWs(code, j);
      const next: string = k < n ? code[k] : "";
      const continues: boolean =
        "=+-*/%&|^?:.,([<>".indexOf(next) >= 0 && next !== "" ||
        "=+-*/%&|^?:.,([<>".indexOf(last) >= 0 && last !== "";
      if (!continues) return j;
    }
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") last = c;
    j++;
  }
  return n;
}

// Reads a string literal at `i`: `{ value, end }` or undefined.
function __vmModString(code: string, i: number): any {
  const c: string = code[i];
  if (c !== "'" && c !== '"') return undefined;
  const end: number = __vmModSkip(code, i);
  const raw: string = code.substring(i + 1, end - 1);
  return { value: raw, end: end };
}

// `with { a: 'b' }` / `assert { ... }` after a specifier.
function __vmModAttributes(code: string, i: number): any {
  const j: number = __vmModWs(code, i);
  const w: string = __vmModWord(code, j);
  const attrs: any = {};
  if (w !== "with" && w !== "assert") return { attrs: attrs, end: i };
  let k: number = __vmModWs(code, j + w.length);
  if (code[k] !== "{") return { attrs: attrs, end: i };
  k++;
  while (k < code.length) {
    k = __vmModWs(code, k);
    if (code[k] === "}") {
      k++;
      break;
    }
    let key = "";
    const str: any = __vmModString(code, k);
    if (str !== undefined) {
      key = str.value;
      k = str.end;
    } else {
      key = __vmModWord(code, k);
      k += key.length;
    }
    k = __vmModWs(code, k);
    if (code[k] === ":") k++;
    k = __vmModWs(code, k);
    const val: any = __vmModString(code, k);
    if (val === undefined) break;
    attrs[key] = val.value;
    k = __vmModWs(code, val.end);
    if (code[k] === ",") k++;
  }
  return { attrs: attrs, end: k };
}

// `{ a, b as c, default as d }` at `i` -> `{ pairs: [[imported, local]], end }`.
function __vmModBraces(code: string, i: number): any {
  const pairs: any[] = [];
  let k: number = i + 1;
  while (k < code.length) {
    k = __vmModWs(code, k);
    if (code[k] === "}") {
      k++;
      break;
    }
    let first = "";
    const str: any = __vmModString(code, k);
    if (str !== undefined) {
      first = str.value;
      k = str.end;
    } else {
      first = __vmModWord(code, k);
      k += first.length;
      if (first === "") return { pairs: pairs, end: code.length };
    }
    k = __vmModWs(code, k);
    let second: string = first;
    if (__vmModWord(code, k) === "as") {
      k = __vmModWs(code, k + 2);
      const s2: any = __vmModString(code, k);
      if (s2 !== undefined) {
        second = s2.value;
        k = s2.end;
      } else {
        second = __vmModWord(code, k);
        k += second.length;
      }
      k = __vmModWs(code, k);
    }
    pairs.push([first, second]);
    if (code[k] === ",") k++;
  }
  return { pairs: pairs, end: k };
}

// The names a `const`/`let`/`var` declaration list introduces (simple
// declarators and flat destructuring).
function __vmModDeclNames(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let expect = true;
  let i = 0;
  while (i < text.length) {
    const s: number = __vmModSkip(text, i);
    if (s !== i) {
      i = s;
      continue;
    }
    const c: string = text[i];
    if (depth === 0 && c === ",") {
      expect = true;
      i++;
      continue;
    }
    if (depth === 0 && c === "=") expect = false;
    if (c === "(" || c === "[" || c === "{") {
      if (expect && depth === 0 && (c === "[" || c === "{")) {
        // destructuring pattern: take every identifier not followed by `:`
        const close: string = c === "[" ? "]" : "}";
        let j = i + 1;
        let d = 1;
        while (j < text.length && d > 0) {
          if (text[j] === c) d++;
          else if (text[j] === close) d--;
          else if (__vmIsIdentStart(text[j])) {
            const w: string = __vmModWord(text, j);
            const after: number = __vmModWs(text, j + w.length);
            if (text[after] !== ":") out.push(w);
            j += w.length;
            continue;
          }
          j++;
        }
        i = j;
        expect = false;
        continue;
      }
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      depth--;
    } else if (expect && depth === 0 && __vmIsIdentStart(c)) {
      const w: string = __vmModWord(text, i);
      out.push(w);
      expect = false;
      i += w.length;
      continue;
    }
    i++;
  }
  return out;
}

// The rewrite. Answers `{ body, requests, imports, locals, reexports, stars,
// usesMeta, usesImport, hasTLA }`.
function __vmModTransform(code: string): any {
  const requests: any[] = [];
  const imports: any[] = [];
  const locals: any[] = [];
  const reexports: any[] = [];
  const stars: any[] = [];
  const hoisted: string[] = [];
  let out = "";
  let depth = 0;
  let i = 0;
  let segStart = 0;
  let prev = "";
  let usesMeta = false;
  let usesImport = false;
  let hasTLA = false;
  const n: number = code.length;

  // One request per distinct (specifier, attributes, phase), as V8 dedups.
  const addRequest = (spec: string, attrs: any, phase: string): number => {
    const key: string = spec + "|" + JSON.stringify(attrs) + "|" + phase;
    for (let r = 0; r < requests.length; r++) {
      if (requests[r].key === key) return r;
    }
    requests.push({ specifier: spec, attributes: attrs, phase: phase, key: key });
    return requests.length - 1;
  };

  while (i < n) {
    const s: number = __vmModSkip(code, i);
    if (s !== i) {
      i = s;
      prev = "x";
      continue;
    }
    const c: string = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (__vmIsIdentStart(c) && !(i > 0 && __vmModIsWordChar(code[i - 1]))) {
      const w: string = __vmModWord(code, i);
      const afterWord: number = __vmModWs(code, i + w.length);
      const nextC: string = afterWord < n ? code[afterWord] : "";
      if (w === "await" && depth === 0 && prev !== ".") hasTLA = true;
      if (w === "import" && prev !== "." && nextC === ".") {
        // import.meta
        out = out + code.substring(segStart, i) + "__zunVmMeta";
        usesMeta = true;
        i = __vmModWs(code, afterWord + 1) + 4;
        segStart = i;
        prev = "x";
        continue;
      }
      if (w === "import" && prev !== "." && nextC === "(") {
        out = out + code.substring(segStart, i) + "__zunVmImport";
        usesImport = true;
        i = i + w.length;
        segStart = i;
        prev = "x";
        continue;
      }
      const atStatement: boolean =
        depth === 0 && (prev === "" || prev === ";" || prev === "}" || prev === "\n");
      if (w === "import" && atStatement) {
        out = out + code.substring(segStart, i);
        let k: number = afterWord;
        const bare: any = __vmModString(code, k);
        if (bare !== undefined) {
          const at: any = __vmModAttributes(code, bare.end);
          addRequest(bare.value, at.attrs, "evaluation");
          k = at.end;
        } else {
          const bindings: any[] = [];
          let phase = "evaluation";
          {
            const pk: number = __vmModWs(code, k);
            const pw: string = __vmModWord(code, pk);
            const after: number = __vmModWs(code, pk + pw.length);
            if ((pw === "source" || pw === "defer") && __vmIsIdentStart(code[after] === undefined ? "" : code[after]) && __vmModWord(code, after) !== "from") {
              phase = pw;
              k = after;
            }
          }
          while (k < n) {
            k = __vmModWs(code, k);
            if (code[k] === "{") {
              const br: any = __vmModBraces(code, k);
              for (let p = 0; p < br.pairs.length; p++) bindings.push(br.pairs[p]);
              k = br.end;
            } else if (code[k] === "*") {
              k = __vmModWs(code, k + 1);
              k = __vmModWs(code, k + 2); // `as`
              const local: string = __vmModWord(code, k);
              bindings.push(["*", local]);
              k += local.length;
            } else if (code[k] === ",") {
              k++;
            } else {
              const word: string = __vmModWord(code, k);
              if (word === "from" || word === "") break;
              bindings.push(["default", word]);
              k += word.length;
            }
          }
          k = __vmModWs(code, k + 4);
          const spec: any = __vmModString(code, k);
          const specifier: string = spec === undefined ? "" : spec.value;
          const at: any = __vmModAttributes(code, spec === undefined ? k : spec.end);
          const reqIdx: number = addRequest(specifier, at.attrs, phase);
          k = at.end;
          for (let b = 0; b < bindings.length; b++) {
            const imported: string = phase === "source" ? "*source" : bindings[b][0];
            imports.push({ specifier: specifier, request: reqIdx, imported: imported, local: bindings[b][1] });
          }
        }
        const semi: number = __vmModWs(code, k);
        if (code[semi] === ";") k = semi + 1;
        out = out + "\n";
        i = k;
        segStart = i;
        prev = ";";
        continue;
      }
      if (w === "export" && atStatement) {
        out = out + code.substring(segStart, i);
        let k: number = afterWord;
        const next: string = __vmModWord(code, k);
        if (code[k] === "{" || code[k] === "*") {
          let pairs: any[] = [];
          let star = false;
          let starAs = "";
          if (code[k] === "{") {
            const br: any = __vmModBraces(code, k);
            pairs = br.pairs;
            k = br.end;
          } else {
            star = true;
            k = __vmModWs(code, k + 1);
            if (__vmModWord(code, k) === "as") {
              k = __vmModWs(code, k + 2);
              const s2: any = __vmModString(code, k);
              if (s2 !== undefined) {
                starAs = s2.value;
                k = s2.end;
              } else {
                starAs = __vmModWord(code, k);
                k += starAs.length;
              }
            }
          }
          k = __vmModWs(code, k);
          let specifier: any = undefined;
          let reqIdx = -1;
          if (__vmModWord(code, k) === "from") {
            k = __vmModWs(code, k + 4);
            const spec: any = __vmModString(code, k);
            specifier = spec === undefined ? "" : spec.value;
            const at: any = __vmModAttributes(code, spec === undefined ? k : spec.end);
            reqIdx = addRequest(specifier, at.attrs, "evaluation");
            k = at.end;
          }
          if (star && starAs === "") {
            stars.push(reqIdx);
          } else if (star) {
            reexports.push({ specifier: specifier, request: reqIdx, imported: "*", exported: starAs });
          } else if (specifier === undefined) {
            for (let p = 0; p < pairs.length; p++) {
              locals.push({ exported: pairs[p][1], local: pairs[p][0], late: true });
            }
          } else {
            for (let p = 0; p < pairs.length; p++) {
              reexports.push({ specifier: specifier, request: reqIdx, imported: pairs[p][0], exported: pairs[p][1] });
            }
          }
          const semi: number = __vmModWs(code, k);
          if (code[semi] === ";") k = semi + 1;
          out = out + "\n";
          i = k;
          segStart = i;
          prev = ";";
          continue;
        }
        if (next === "default") {
          k = __vmModWs(code, k + 7);
          let word: string = __vmModWord(code, k);
          let k2: number = k;
          if (word === "async") {
            k2 = __vmModWs(code, k + 5);
            word = __vmModWord(code, k2);
          }
          if (word === "function" || word === "class") {
            let k3: number = __vmModWs(code, k2 + word.length);
            if (code[k3] === "*") k3 = __vmModWs(code, k3 + 1);
            const name: string = __vmModWord(code, k3);
            if (name !== "") {
              locals.push({ exported: "default", local: name, late: word === "class" });
              if (word === "function") hoisted.push(name);
              segStart = k;
              i = k;
              prev = ";";
              continue;
            }
          }
          const end: number = __vmModStatementEnd(code, k);
          let expr: string = code.substring(k, end);
          if (expr.endsWith(";")) expr = expr.substring(0, expr.length - 1);
          out = out + "__zunVmD = (" + expr + "\n);\n__zunVmM.pub(\"default\", () => __zunVmD);\n";
          locals.push({ exported: "default", local: "__zunVmD", late: true });
          i = end;
          segStart = i;
          prev = ";";
          continue;
        }
        // export const|let|var|function|class|async function
        let kind: string = next;
        let k2: number = k;
        if (kind === "async") {
          k2 = __vmModWs(code, k + 5);
          kind = __vmModWord(code, k2);
        }
        if (kind === "function" || kind === "class") {
          let k3: number = __vmModWs(code, k2 + kind.length);
          if (code[k3] === "*") k3 = __vmModWs(code, k3 + 1);
          const name: string = __vmModWord(code, k3);
          locals.push({ exported: name, local: name, late: kind === "class" });
          if (kind === "function") hoisted.push(name);
          if (kind === "class") {
            // published after the declaration
            const end: number = __vmModStatementEnd(code, k);
            out = out + code.substring(k, end) + "\n__zunVmM.pub(" + JSON.stringify(name) + ", () => " + name + ");\n";
            i = end;
            segStart = i;
            prev = ";";
            continue;
          }
          segStart = k;
          i = k;
          prev = ";";
          continue;
        }
        const end: number = __vmModStatementEnd(code, k);
        const names: string[] = __vmModDeclNames(code.substring(k2 + kind.length, end));
        let pubs = "";
        for (let p = 0; p < names.length; p++) {
          locals.push({ exported: names[p], local: names[p], late: true });
          pubs = pubs + "__zunVmM.pub(" + JSON.stringify(names[p]) + ", () => " + names[p] + ");\n";
        }
        out = out + code.substring(k, end) + "\n" + pubs;
        i = end;
        segStart = i;
        prev = ";";
        continue;
      }
      i += w.length;
      prev = "x";
      continue;
    }
    if (c === ";" || c === "}") prev = c;
    else if (c === "\n") {
      if (prev === "x" || prev === ")" || prev === "]") prev = "\n";
    } else if (c !== " " && c !== "\t" && c !== "\r") prev = c;
    i++;
  }
  out = out + code.substring(segStart, n);

  let head = "const __zunVmM = " + __VM_MOD_REC + ";\n";
  for (let b = 0; b < imports.length; b++) {
    const local: string = imports[b].local;
    head = head + "let " + local + ";\n__zunVmM.set[" + JSON.stringify(local) + "] = (__zunVmV) => { " +
      local + " = __zunVmV; };\n";
  }
  head = head + "let __zunVmD;\n";
  if (usesMeta) head = head + "const __zunVmMeta = __zunVmM.meta;\n";
  if (usesImport) head = head + "const __zunVmImport = __zunVmM.dyn;\n";
  head = head + "__zunVmM.ready();\nreturn (async () => {\n";
  for (let h = 0; h < hoisted.length; h++) {
    head = head + "__zunVmM.pub(" + JSON.stringify(hoisted[h]) + ", () => " + hoisted[h] + ");\n";
  }
  let tail = "\n";
  for (let l = 0; l < locals.length; l++) {
    tail = tail + "__zunVmM.pub(" + JSON.stringify(locals[l].exported) + ", () => " + locals[l].local + ");\n";
  }
  tail = tail + "})();\n";
  return {
    body: head + out + tail,
    requests: requests,
    imports: imports,
    locals: locals,
    reexports: reexports,
    stars: stars,
    usesMeta: usesMeta,
    usesImport: usesImport,
    hasTLA: hasTLA,
  };
}

// --- records ----------------------------------------------------------------

function __vmModNewNamespace(): any {
  const ns: any = Object.create(null);
  Object.defineProperty(ns, Symbol.toStringTag, { value: "Module" });
  const g: any = globalThis;
  if (g.__zunVmNamespaces === undefined) g.__zunVmNamespaces = [];
  g.__zunVmNamespaces.push(ns);
  return ns;
}

function __vmModNewRecord(mod: any, kind: string, context: any, identifier: any): any {
  return {
    module: mod,
    kind: kind,
    context: context,
    identifier: identifier,
    status: "unlinked",
    error: undefined,
    ns: __vmModNewNamespace(),
    exportNames: [],
    listeners: {},
    values: {},
    set: {},
    linked: [],
    requests: [],
    imports: [],
    locals: [],
    reexports: [],
    stars: [],
    fn: undefined,
    instantiated: false,
    evaluation: undefined,
    meta: undefined,
    initializeImportMeta: undefined,
    importModuleDynamically: undefined,
    evaluateCallback: undefined,
    hasTLA: false,
    specifiers: [],
    moduleRequests: [],
    dyn: undefined,
    pub: undefined,
    ready: undefined,
  };
}

function __vmModRec(m: any): any {
  if (m === null || m === undefined || (typeof m !== "object" && typeof m !== "function")) {
    throw __vmModInvalidThis();
  }
  const rec: any = m.__zunVmModule;
  if (rec === undefined || rec === null || rec.module !== m) throw __vmModInvalidThis();
  return rec;
}

function __vmModIsModule(m: any): boolean {
  if (m === null || m === undefined || typeof m !== "object") return false;
  const rec: any = m.__zunVmModule;
  return rec !== undefined && rec !== null && rec.module === m;
}

function __vmModPublish(rec: any, name: string, value: any): void {
  rec.values[name] = value;
  rec.ns[name] = value;
  const list: any = rec.listeners[name];
  if (list === undefined) return;
  for (let i = 0; i < list.length; i++) {
    const fn: any = list[i];
    fn(value);
  }
}

function __vmModListen(rec: any, name: string, fn: any): void {
  let list: any = rec.listeners[name];
  if (list === undefined) {
    list = [];
    rec.listeners[name] = list;
  }
  list.push(fn);
  if (name in rec.values) fn(rec.values[name]);
}

function __vmModContextIdentifier(context: any): string {
  if (context === undefined) {
    const id: any = __vmModMainIds;
    __vmModMainIds = __vmModMainIds + 1;
    return "vm:module(" + String(id) + ")";
  }
  for (let i = 0; i < __vmModContextIds.length; i++) {
    const row: any = __vmModContextIds[i];
    if (row.context === context) {
      const id: any = row.next;
      row.next = row.next + 1;
      return "vm:module(" + String(id) + ")";
    }
  }
  __vmModContextIds.push({ context: context, next: 1 });
  return "vm:module(0)";
}

function __vmModRequestFor(rec: any, index: any): any {
  return rec.linked[index];
}

// Export names, resolved through re-exports and `export *` (cycle-guarded).
function __vmModExportNames(rec: any, seen: any[]): string[] {
  for (let i = 0; i < seen.length; i++) if (seen[i] === rec) return [];
  seen.push(rec);
  if (rec.kind === "synthetic") return rec.exportNames;
  const out: string[] = [];
  for (let i = 0; i < rec.locals.length; i++) {
    if (out.indexOf(rec.locals[i].exported) < 0) out.push(rec.locals[i].exported);
  }
  for (let i = 0; i < rec.reexports.length; i++) {
    if (out.indexOf(rec.reexports[i].exported) < 0) out.push(rec.reexports[i].exported);
  }
  for (let i = 0; i < rec.stars.length; i++) {
    const dep: any = __vmModRequestFor(rec, rec.stars[i]);
    if (dep === undefined) continue;
    const names: string[] = __vmModExportNames(dep.__zunVmModule, seen);
    for (let j = 0; j < names.length; j++) {
      if (names[j] !== "default" && out.indexOf(names[j]) < 0) out.push(names[j]);
    }
  }
  return out;
}

function __vmModInstantiate(rec: any): void {
  if (rec.instantiated) return;
  if (rec.kind === "synthetic") {
    rec.instantiated = true;
    return;
  }
  for (let i = 0; i < rec.requests.length; i++) {
    if (rec.linked[i] === undefined) {
      throw new NodeError(
        "ERR_VM_MODULE_LINK_FAILURE",
        "request for '" + rec.requests[i].specifier + "' can not be resolved on module '" +
          rec.identifier + "' that is not linked",
      );
    }
  }
  rec.instantiated = true;
  try {
    for (let i = 0; i < rec.linked.length; i++) __vmModInstantiate(rec.linked[i].__zunVmModule);
  } catch (e: any) {
    rec.instantiated = false;
    throw e;
  }
  const names: string[] = __vmModExportNames(rec, []);
  // A namespace lists its exports in code-unit order.
  names.sort();
  rec.exportNames = names;
  for (let i = 0; i < names.length; i++) {
    if (!(names[i] in rec.ns)) rec.ns[names[i]] = undefined;
  }
  // imports must resolve now: a missing name is a SyntaxError at link time
  for (let i = 0; i < rec.imports.length; i++) {
    const imp: any = rec.imports[i];
    if (imp.imported === "*" || imp.imported === "*source") continue;
    const dep: any = __vmModRequestFor(rec, imp.request);
    const depRec: any = dep.__zunVmModule;
    const depNames: string[] = depRec.kind === "synthetic" ? depRec.exportNames : __vmModExportNames(depRec, []);
    if (depNames.indexOf(imp.imported) < 0) {
      throw new SyntaxError(
        "The requested module '" + imp.specifier + "' does not provide an export named '" +
          imp.imported + "'",
      );
    }
  }
  // re-exports forward the dependency's published values
  for (let i = 0; i < rec.reexports.length; i++) {
    const re: any = rec.reexports[i];
    const dep: any = __vmModRequestFor(rec, re.request);
    const depRec: any = dep.__zunVmModule;
    if (re.imported === "*") {
      __vmModPublish(rec, re.exported, depRec.ns);
    } else {
      __vmModListen(depRec, re.imported, __vmModForwarder(rec, re.exported));
    }
  }
  for (let i = 0; i < rec.stars.length; i++) {
    const dep: any = __vmModRequestFor(rec, rec.stars[i]);
    const depRec: any = dep.__zunVmModule;
    const depNames: string[] = __vmModExportNames(depRec, []);
    for (let j = 0; j < depNames.length; j++) {
      const name: string = depNames[j];
      if (name === "default") continue;
      let own = false;
      for (let l = 0; l < rec.locals.length; l++) if (rec.locals[l].exported === name) own = true;
      if (!own) __vmModListen(depRec, name, __vmModForwarder(rec, name));
    }
  }
}

function __vmModForwarder(rec: any, name: string): any {
  return (v: any): void => {
    __vmModPublish(rec, name, v);
  };
}

// Binds the module's import setters; called by the compiled body once it has
// registered them (`__zunVmM.ready()`).
function __vmModBindImports(rec: any): void {
  for (let i = 0; i < rec.imports.length; i++) {
    const imp: any = rec.imports[i];
    const setter: any = rec.set[imp.local];
    if (imp.imported === "*source") continue;
    const dep: any = __vmModRequestFor(rec, imp.request);
    const depRec: any = dep.__zunVmModule;
    if (imp.imported === "*") {
      setter(depRec.ns);
    } else {
      __vmModListen(depRec, imp.imported, setter);
    }
  }
}

function __vmModGraphLinking(rec: any, self: any, seen: any[]): boolean {
  for (let i = 0; i < seen.length; i++) if (seen[i] === rec) return false;
  seen.push(rec);
  if (rec !== self && rec.status === "linking") return true;
  for (let i = 0; i < rec.linked.length; i++) {
    const dep: any = rec.linked[i];
    if (dep === undefined) continue;
    if (__vmModGraphLinking(dep.__zunVmModule, self, seen)) return true;
  }
  return false;
}

async function __vmModLink(rec: any, linker: any): Promise<any> {
  const n: number = rec.requests.length;
  const self: any = rec.module;
  const results: any[] = [];
  for (let i = 0; i < n; i++) {
    const req: any = rec.requests[i];
    results.push(linker(req.specifier, self, { attributes: req.attributes, assert: req.attributes }));
  }
  for (let i = 0; i < n; i++) {
    const req: any = rec.requests[i];
    const m: any = await results[i];
    if (!__vmModIsModule(m)) {
      throw new NodeError("ERR_VM_MODULE_NOT_MODULE", "Provided module is not an instance of Module");
    }
    const depRec: any = m.__zunVmModule;
    if (depRec.context !== rec.context) {
      throw new NodeError("ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
    }
    if (depRec.status === "errored") {
      const err: any = new NodeError(
        "ERR_VM_MODULE_LINK_FAILURE",
        "request for '" + req.specifier + "' resolved to an errored module",
      );
      err.cause = depRec.error;
      throw err;
    }
    rec.linked[i] = m;
    if (depRec.status === "unlinked") await __vmModLinkEntry(depRec, linker);
  }
}

async function __vmModLinkEntry(rec: any, linker: any): Promise<any> {
  rec.status = "linking";
  try {
    await __vmModLink(rec, linker);
  } catch (e: any) {
    rec.status = "errored";
    rec.error = e;
    throw e;
  }
  rec.status = "linked";
  if (!__vmModGraphLinking(rec, rec, [])) {
    try {
      __vmModInstantiate(rec);
    } catch (e: any) {
      rec.status = "errored";
      rec.error = e;
      throw e;
    }
  }
}

function __vmModRunBody(rec: any): any {
  const global: any = globalThis;
  const previous: any = global[__VM_MOD_REC];
  global[__VM_MOD_REC] = rec;
  try {
    if (rec.context === undefined) return __vmRunCompiled(rec.fn, globalThis, true);
    return __vmRunCompiled(rec.fn, rec.context, false);
  } finally {
    global[__VM_MOD_REC] = previous;
  }
}

function __vmModEvaluate(rec: any): any {
  if (rec.evaluation !== undefined) return rec.evaluation;
  rec.status = "evaluating";
  rec.evaluation = __vmModEvaluateAsync(rec);
  return rec.evaluation;
}

async function __vmModEvaluateAsync(rec: any): Promise<any> {
  try {
    for (let i = 0; i < rec.linked.length; i++) {
      const depRec: any = rec.linked[i].__zunVmModule;
      if (depRec.status === "evaluating") continue;
      await __vmModEvaluate(depRec);
    }
    if (rec.kind === "synthetic") {
      const cb: any = rec.evaluateCallback;
      const r: any = cb.call(rec.module);
      if (r !== undefined && r !== null && typeof r.then === "function") await r;
    } else {
      if (rec.meta === undefined && rec.usesMeta) {
        rec.meta = Object.create(null);
        const init: any = rec.initializeImportMeta;
        if (init !== undefined) init(rec.meta, rec.module);
      }
      await __vmModRunBody(rec);
    }
  } catch (e: any) {
    rec.status = "errored";
    rec.error = e;
    throw e;
  }
  rec.status = "evaluated";
  return undefined;
}

function __vmModValidateEvaluate(options: any): void {
  if (options === undefined) return;
  __evValidateObject(options, "options");
  if (options.timeout !== undefined) __vmValidateUint32(options.timeout, "options.timeout", true);
  if (options.breakOnSigint !== undefined) {
    __evValidateBoolean(options.breakOnSigint, "options.breakOnSigint");
  }
}

function __vmModValidateContext(options: any): any {
  const context: any = options.context;
  if (context === undefined) return undefined;
  if (context === null || typeof context !== "object" || !__vmIsContext(context)) {
    throw new ERR_INVALID_ARG_TYPE("options.context", "vm.Context", context);
  }
  return context;
}

class __VmModule {
  constructor() {
    if (this.constructor === __VmModule) {
      throw new TypeError("Module is not a constructor");
    }
  }

  get identifier(): any {
    return __vmModRec(this).identifier;
  }

  get context(): any {
    return __vmModRec(this).context;
  }

  get status(): any {
    return __vmModRec(this).status;
  }

  get namespace(): any {
    const rec: any = __vmModRec(this);
    if (rec.status === "unlinked" || rec.status === "linking") {
      throw new ERR_VM_MODULE_STATUS("must not be unlinked or linking");
    }
    return rec.ns;
  }

  get error(): any {
    const rec: any = __vmModRec(this);
    if (rec.status !== "errored") throw new ERR_VM_MODULE_STATUS("must be errored");
    return rec.error;
  }

  async link(linker?: any): Promise<any> {
    const rec: any = __vmModRec(this);
    if (typeof linker !== "function") throw new ERR_INVALID_ARG_TYPE("linker", "Function", linker);
    // A SyntheticModule has no requests: it is linked from construction.
    if (rec.kind === "synthetic") return undefined;
    if (rec.status === "linked") {
      throw new NodeError("ERR_VM_MODULE_ALREADY_LINKED", "Module has already been linked");
    }
    if (rec.status !== "unlinked") throw new ERR_VM_MODULE_STATUS("must be unlinked");
    await __vmModLinkEntry(rec, linker);
    return undefined;
  }

  async evaluate(options?: any): Promise<any> {
    const rec: any = __vmModRec(this);
    __vmModValidateEvaluate(options);
    const st: string = rec.status;
    if (st !== "linked" && st !== "evaluating" && st !== "evaluated" && st !== "errored") {
      throw new ERR_VM_MODULE_STATUS("must be one of linked, evaluated, or errored");
    }
    if (st === "errored" && rec.evaluation === undefined) throw rec.error;
    if (!rec.instantiated) __vmModInstantiate(rec);
    await __vmModEvaluate(rec);
    return undefined;
  }
}

class SourceTextModule extends __VmModule {
  constructor(sourceText?: any, options?: any) {
    super();
    __vmValidateString(sourceText, "sourceText");
    const opts: any = options === undefined ? {} : options;
    __evValidateObject(opts, "options");
    const context: any = __vmModValidateContext(opts);
    let identifier: any = opts.identifier;
    if (identifier !== undefined) __vmValidateString(identifier, "options.identifier");
    if (opts.lineOffset !== undefined) __vmValidateInt32(opts.lineOffset, "options.lineOffset");
    if (opts.columnOffset !== undefined) __vmValidateInt32(opts.columnOffset, "options.columnOffset");
    if (opts.cachedData !== undefined) __vmValidateBuffer(opts.cachedData, "options.cachedData");
    const init: any = opts.initializeImportMeta;
    if (init !== undefined && typeof init !== "function") {
      throw new ERR_INVALID_ARG_TYPE("options.initializeImportMeta", "function", init);
    }
    const dyn: any = opts.importModuleDynamically;
    if (dyn !== undefined && typeof dyn !== "function") {
      throw new ERR_INVALID_ARG_TYPE("options.importModuleDynamically", "function", dyn);
    }
    const t: any = __vmModTransform(String(sourceText));
    const compiled: any = __vmCompile(t.body, [], true);
    if (compiled.error !== "") throw new SyntaxError(__vmSyntaxMessage(compiled.error));
    if (identifier === undefined) identifier = __vmModContextIdentifier(context);
    const rec: any = __vmModNewRecord(this, "source", context, identifier);
    rec.fn = compiled.fn;
    rec.requests = t.requests;
    rec.imports = t.imports;
    rec.locals = t.locals;
    rec.reexports = t.reexports;
    rec.stars = t.stars;
    rec.usesMeta = t.usesMeta;
    rec.hasTLA = t.hasTLA;
    rec.initializeImportMeta = init;
    rec.importModuleDynamically = dyn;
    const specs: string[] = [];
    const reqs: any[] = [];
    for (let i = 0; i < t.requests.length; i++) {
      specs.push(t.requests[i].specifier);
      const attrs: any = Object.create(null);
      const src: any = t.requests[i].attributes;
      for (const key of Object.keys(src)) attrs[key] = src[key];
      const req: any = Object.create(null);
      req.specifier = t.requests[i].specifier;
      req.attributes = Object.freeze(attrs);
      req.phase = t.requests[i].phase;
      reqs.push(Object.freeze(req));
    }
    rec.specifiers = Object.freeze(specs);
    rec.moduleRequests = Object.freeze(reqs);
    rec.pub = (name: any, getter: any): void => {
      __vmModPublish(rec, name, getter());
    };
    rec.ready = (): void => {
      __vmModBindImports(rec);
    };
    const self: any = this;
    rec.dyn = (specifier: any, options?: any): any => __vmModDynamicImport(rec, self, specifier, options);
    Object.defineProperty(this, "__zunVmModule", { value: rec, enumerable: false });
  }

  get dependencySpecifiers(): any {
    return __vmModRec(this).specifiers;
  }

  get moduleRequests(): any {
    return __vmModRec(this).moduleRequests;
  }

  hasTopLevelAwait(): boolean {
    return __vmModRec(this).hasTLA;
  }

  hasAsyncGraph(): boolean {
    const rec: any = __vmModRec(this);
    if (rec.status !== "evaluated" && rec.status !== "evaluating" && !rec.instantiated) {
      throw new ERR_VM_MODULE_STATUS("must be instantiated");
    }
    return __vmModAsyncGraph(rec, []);
  }

  linkRequests(modules?: any): void {
    const rec: any = __vmModRec(this);
    __vmValidateArray(modules, "modules");
    if (rec.status !== "unlinked") {
      throw new NodeError("ERR_VM_MODULE_ALREADY_LINKED", "Module has already been linked");
    }
    if (modules.length !== rec.requests.length) {
      throw new NodeError(
        "ERR_MODULE_LINK_MISMATCH",
        "Module request count does not match the number of modules provided",
      );
    }
    for (let i = 0; i < modules.length; i++) {
      const m: any = modules[i];
      if (!__vmModIsModule(m)) {
        throw new NodeError("ERR_VM_MODULE_NOT_MODULE", "Provided module is not an instance of Module");
      }
      if (m.__zunVmModule.context !== rec.context) {
        throw new NodeError("ERR_VM_MODULE_DIFFERENT_CONTEXT", "Linked modules must use the same context");
      }
    }
    // Requests that share a module cache key (specifier + attributes) must
    // resolve to one module, whatever their phase.
    for (let i = 0; i < modules.length; i++) {
      for (let j = 0; j < i; j++) {
        const a: any = rec.requests[i];
        const b: any = rec.requests[j];
        if (a.specifier === b.specifier && JSON.stringify(a.attributes) === JSON.stringify(b.attributes) &&
            modules[i] !== modules[j]) {
          throw new NodeError(
            "ERR_MODULE_LINK_MISMATCH",
            "Module request '" + a.specifier + "' must be linked to the same module",
          );
        }
      }
    }
    for (let i = 0; i < modules.length; i++) rec.linked[i] = modules[i];
    rec.status = "linked";
  }

  instantiate(): void {
    const rec: any = __vmModRec(this);
    // An unlinked request is reported by the instantiation itself, naming it.
    if (rec.status === "unlinked" && rec.requests.length === 0) {
      throw new NodeError("ERR_VM_MODULE_LINK_FAILURE", "module '" + rec.identifier + "' is not linked");
    }
    __vmModInstantiate(rec);
  }

  createCachedData(): any {
    throw new NodeError(
      "ERR_VM_CODE_CACHE_UNAVAILABLE",
      "this platform has no code cache: createCachedData() cannot produce one",
    );
  }
}

function __vmModAsyncGraph(rec: any, seen: any[]): boolean {
  for (let i = 0; i < seen.length; i++) if (seen[i] === rec) return false;
  seen.push(rec);
  if (rec.hasTLA) return true;
  for (let i = 0; i < rec.linked.length; i++) {
    if (__vmModAsyncGraph(rec.linked[i].__zunVmModule, seen)) return true;
  }
  return false;
}

async function __vmModDynamicImport(rec: any, referrer: any, specifier: any, options?: any): Promise<any> {
  const dyn: any = rec.importModuleDynamically;
  if (dyn === undefined) {
    throw new NodeTypeError(
      "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
      "A dynamic import callback was not specified.",
    );
  }
  const attrs: any = options !== undefined && options !== null && options.with !== undefined ? options.with : {};
  const m: any = await dyn(String(specifier), referrer, attrs);
  if (!__vmModIsModule(m)) return m;
  const depRec: any = m.__zunVmModule;
  if (depRec.status === "unlinked") {
    throw new ERR_VM_MODULE_STATUS("must be linked");
  }
  if (!depRec.instantiated) __vmModInstantiate(depRec);
  await __vmModEvaluate(depRec);
  return depRec.ns;
}

class SyntheticModule extends __VmModule {
  constructor(exportNames?: any, evaluateCallback?: any, options?: any) {
    super();
    let ok: boolean = Array.isArray(exportNames);
    if (ok) {
      for (let i = 0; i < exportNames.length; i++) {
        if (typeof exportNames[i] !== "string") ok = false;
      }
    }
    if (!ok) {
      throw new NodeTypeError(
        "ERR_INVALID_ARG_TYPE",
        'The "exportNames" argument must be an Array of unique strings.' + __evReceived(exportNames),
      );
    }
    for (let i = 0; i < exportNames.length; i++) {
      for (let j = 0; j < i; j++) {
        if (exportNames[i] === exportNames[j]) {
          throw new NodeTypeError(
            "ERR_INVALID_ARG_VALUE",
            "The property 'exportNames." + exportNames[i] + "' is duplicated. Received '" +
              exportNames[i] + "'",
          );
        }
      }
    }
    if (typeof evaluateCallback !== "function") {
      throw new ERR_INVALID_ARG_TYPE("evaluateCallback", "function", evaluateCallback);
    }
    const opts: any = options === undefined ? {} : options;
    __evValidateObject(opts, "options");
    const context: any = __vmModValidateContext(opts);
    let identifier: any = opts.identifier;
    if (identifier !== undefined) __vmValidateString(identifier, "options.identifier");
    if (identifier === undefined) identifier = __vmModContextIdentifier(context);
    const rec: any = __vmModNewRecord(this, "synthetic", context, identifier);
    const names: string[] = [];
    for (let i = 0; i < exportNames.length; i++) names.push(exportNames[i]);
    const sorted: string[] = names.slice();
    sorted.sort();
    for (let i = 0; i < sorted.length; i++) rec.ns[sorted[i]] = undefined;
    rec.exportNames = names;
    rec.evaluateCallback = evaluateCallback;
    rec.status = "linked";
    rec.instantiated = true;
    Object.defineProperty(this, "__zunVmModule", { value: rec, enumerable: false });
  }

  setExport(name?: any, value?: any): void {
    const rec: any = __vmModRec(this);
    if (rec.kind !== "synthetic") throw __vmModInvalidThis();
    __vmValidateString(name, "name");
    if (rec.exportNames.indexOf(name) < 0) {
      throw new __VmModuleReferenceError(
        "ERR_VM_MODULE_EXPORT_NOT_FOUND",
        "Export '" + name + "' is not defined in module",
      );
    }
    __vmModPublish(rec, name, value);
  }
}

const __vmConstants: any = {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: __vmMainContextDefaultLoader,
  DONT_CONTEXTIFY: __vmDontContextify,
};

const __node_vm: any = {
  Script: Script,
  createContext: createContext,
  createScript: __vmCreateScript,
  runInContext: __vmRunInContext,
  runInNewContext: __vmRunInNewContext,
  runInThisContext: __vmRunInThisContext,
  isContext: __vmIsContext,
  compileFunction: compileFunction,
  measureMemory: __vmMeasureMemory,
  constants: __vmConstants,
  Module: __VmModule,
  SourceTextModule: SourceTextModule,
  SyntheticModule: SyntheticModule,
};

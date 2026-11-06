# node:util — Node.js compatibility tests

The compatibility bar for `util` is **Node.js 25's own test suite**, not tests we
write. `util` is **not finished** until it passes 100% of Node's `test-util*`
tests.

## Why `util` came before `stream`

`stream` was next in the roadmap, and `util` was taken ahead of it because
`stream` cannot be written without it: `util.inspect`, `util.promisify`,
`util.deprecate`, `util.debuglog` and `util.types` are load-bearing inside
`lib/internal/streams/*`. The same argument applies to nearly every other
module's *tests*: `assert`'s failure messages are `util.inspect` output and
`assert.deepStrictEqual` is `util.isDeepStrictEqual`, so every corpus in this
repository reads through `util` whether its test file requires it or not. The
slice that existed before this work — enough `inspect` for `events`' two error
messages — was explicitly a slice (PLAN.md principle 4); this is the whole
module.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module —
twenty-six files, all under the single `test-util` prefix:

```
test-util.js                                    test-util-inspect-namespace.js
test-util-callbackify.js                        test-util-inspect-proxy.js
test-util-deprecate.js                          test-util-inspect-regexp.js
test-util-deprecate-invalid-code.js             test-util-internal.js
test-util-emit-experimental-warning.js          test-util-isDeepStrictEqual.js
test-util-format.js                             test-util-parse-env.js
test-util-getcallsites.js                       test-util-primordial-monkeypatching.js
test-util-inherits.js                           test-util-promisify.js
test-util-inspect.js                            test-util-sigint-watchdog.js
test-util-inspect-getters-accessing-this.js     test-util-sleep.js
test-util-inspect-long-running.js               test-util-stripvtcontrolcharacters.js
test-util-styletext.js                          test-util-text-decoder.js
test-util-types.js                              test-util-types-exists.js
```

Each file is fetched verbatim from `nodejs/node` at tag `v25.0.0`; nothing is
vendored here. `test-util-promisify-custom-names.mjs` is an ES module and is not
in the corpus: the bundler resolves `require`, and the engine has no `import`
for a second file ([zun#4](https://github.com/UrubuCode/zun/issues/4)).

## How they run

`util` is a Zun TypeScript module (`zun-ts`): no `--ext`, each test bundled
first.

```sh
cargo build -p zun_cli                              # the `zun` binary
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --module util
```

Each test is bundled by `tools/bundle_node_test.sh` — **`util`** → `events` →
`process` → `assert` → `path` → the harness — and run as `zun run <bundle.ts>`.
`util` sits first in bundle order because it has no dependencies of its own;
that it nonetheless raises `events`' `NodeTypeError`/`ERR_INVALID_ARG_TYPE` and
calls `process.emitWarning` is fine, because top-level declarations resolve
across the whole program regardless of order.

Three bundler entries were added for this corpus:

* `util/types` → `__node_util_types`, the *same object* `util.types` is, so
  `require('util/types') === require('util').types` holds by identity — which is
  the whole of `test-util-types-exists.js`.
* `internal/util` → `__node_internal_util`. Node's `lib/internal/util.js` *is*
  `util`'s implementation (`lib/util.js` re-exports `deprecate`, `promisify`,
  `getSystemErrorMap` straight out of it), and three files in this corpus are
  written against it under `--expose-internals`. Its `sleep`,
  `emitExperimentalWarning`, `deprecate`, `pendingDeprecate`, `promisify` and
  `customPromisifyArgs` are implemented in `src/util/util.ts` with real
  behaviour — nothing here is a stub.
* `test` → `tools/harness/node_test.ts` and `tty` → a declared gap in the same
  file. `node:test` is not a module this library implements; it is the language
  several of Node's newer test files are *written in*, so it belongs with
  `common.ts`. Without it `test-util-stripvtcontrolcharacters.js` could not even
  be bundled and `util.stripVTControlCharacters` would never be measured.

Tests are downloaded into `<tmp>/test/parallel/<name>` because several of them
assert their own location through `__dirname`.

## What is implemented

The whole Node 25 public surface of `node:util`, with nothing stubbed:

* **Formatting** — `format`, `formatWithOptions` (all of `%s %d %i %f %j %o %O
  %c %%`, with the `numericSeparator` grouping and the `hasBuiltInToString`
  rule), `inspect`, `inspect.custom`, `inspect.defaultOptions`,
  `inspect.colors` (all 44 styles plus Node's twelve aliases), `inspect.styles`
  including the Node 25 regular-expression depth highlighter,
  `stripVTControlCharacters`, `styleText` (nested-style re-application and the
  stream validation).
* **`inspect` options** — `depth`, `colors`, `customInspect`, `showHidden`,
  `showProxy`, `maxArrayLength`, `maxStringLength`, `breakLength`, `compact`,
  `sorted` (`true` or a comparator, sorting only the trailing named keys of an
  array as Node does), `getters`, `numericSeparator`, a user `stylize` (which
  sees Node's `name`/`string`/`number`/`special`/… style types, keys included),
  and the pass-through of unknown keys as `userOptions`. The line-breaking is Node's
  `reduceToSingleString`/`isBelowBreakLength`/`groupArrayElements` — so
  `inspect([1,2,3,4,5,6,7,8,9,10])` really does come out as the two
  right-aligned columns Node prints — plus Node's 2²⁷-character output budget,
  the `<ref *1>` / `[Circular *1]` notation, long-string splitting at word
  boundaries, and the `Map(n) {}` / `Set(n) {}` / `Foo(3) []` / `[Object]`
  forms.
* **Comparison** — `isDeepStrictEqual`, including the Node 25 `skipPrototype`
  third argument, `Map`/`Set` unordered matching, `Date`/`RegExp`/`Error`
  identity, `-0` ≠ `+0`, `NaN` = `NaN`, symbol keys and cycles. `assert`'s
  `deepStrictEqual`/`notDeepStrictEqual` now call it, so the two can no longer
  disagree.
* **Function adapters** — `promisify` (+ `promisify.custom` and
  `customPromisifyArgs`), `callbackify` (with `ERR_FALSY_VALUE_REJECTION`),
  `deprecate` (per-function and per-`code` deduplication), `debuglog`/`debug`
  (`NODE_DEBUG` sections with the trailing-`*` form, and `.enabled`),
  `inherits`.
* **Predicates** — `types`, every `is*` the engine can answer exactly (`isDate`,
  `isMap`, `isSet`, `isRegExp`, `isPromise`, `isNativeError`) and the rest
  answering `false` rather than throwing, each listed in the file header with
  why.
* **System errors** — `getSystemErrorName`, `getSystemErrorMessage`,
  `getSystemErrorMap` over libuv's 85-row `UV_ERRNO_MAP`, with the `win32` and
  POSIX numbering both present and selected by `process.platform`.
* **One shape that differs** — `inspect.defaultOptions` is a plain object, so
  `inspect.defaultOptions.compact = 5` works exactly as in Node (and
  `test-util-inspect-regexp.js` relies on it), but *assigning* the whole
  property — `inspect.defaultOptions = { … }` — replaces it instead of merging,
  because Node's merge lives in a setter and an accessor on a function value is
  not expressible here. `inspect.setDefaultOptions(obj)` performs the merge.
* **The rest** — `toUSVString`, `aborted`, `transferableAbortSignal`,
  `transferableAbortController`, `parseArgs` (tokenizer, short groups, inline
  values, `--`, `multiple`, `allowNegative`, `tokens`, strict-mode errors),
  `parseEnv` (quoting, backticks, inline comments, `export` prefix, `\n`
  expansion in double quotes), `MIMEType`/`MIMEParams`, `getCallSites`
  (recovered from the formatted stack, with Node's 1…200 validation),
  `TextEncoder`/`TextDecoder` re-exported from the prelude, and the two
  deprecated entries v25 still has, `isArray` and `_extend`.

## Status and what blocks the rest

[`RESULTS.md`](RESULTS.md) is the live per-test table, with the first line of
stderr for each failure; it and the README bar are regenerated by every tracker
run, so they — not this page — are the current number.

**Not one failure is in `util.ts`.** Nine of the nineteen need a harness module
that does not exist, two need one *and* an engine feature, and the remaining
eight are engine gaps — four of them new, found while writing this module.

| Test | Blocked by | What happens |
|---|---|---|
| `test-util.js` | harness: `internal/errors`, `vm` | `require('internal/errors')` for `errors.codes.ERR_IPC_CHANNEL_CLOSED` and `require('vm').runInNewContext` for the cross-realm `Array`/`Error` checks |
| `test-util-callbackify.js` | [zun#25](https://github.com/UrubuCode/zun/issues/25); harness: `child_process` | the first expectation after the resolution loop is `cbAsyncFn.length === 1` and `cbAsyncFn.name === 'asyncFnCallbackified'`; a function reports `length` 0 and `name` `undefined`, so `callbackify` cannot carry the `+1`/`Callbackified` rename Node's `ObjectDefineProperties` applies. The tail re-runs itself through `child_process.execFile` |
| `test-util-format.js` | engine: `class … extends Array`; [zun#25](https://github.com/UrubuCode/zun/issues/25) | `class Foobar extends Array { aaa = true; }` is rejected with ``unknown base class `Array` ``. The block it sits in also needs `Object.setPrototypeOf(new Foo(), null)`, `D.prototype = { __proto__: C.prototype }` and a `constructor` accessor that throws — the whole function-prototype model |
| `test-util-getcallsites.js` | engine: no structured call sites; harness: `child_process` | `callSites[0].scriptName` has to match `/test-util-getcallsites/`, but the program the engine is running is the *bundle*, so the recovered frame names the bundle. The rest of the file spawns itself with `spawnSync` |
| `test-util-inherits.js` | [zun#1](https://github.com/UrubuCode/zun/issues/1), [zun#25](https://github.com/UrubuCode/zun/issues/25) | ``error: `call` passes 1 argument`` on `A.call(this)` — `Function.prototype.call` threads no receiver. The file is a function-constructor inheritance exercise end to end (`B.prototype.b = …`, `C.super_`, `new B('b')`), which needs the prototype model `util.inherits` cannot be given here |
| `test-util-inspect.js` | harness: `internal/test/binding`, `vm`, `v8`, `worker_threads`, `url`, `trace_events` | the 3 700-line flagship, which monkey-patches the `util` binding and inspects a `MessageChannel`, a `vm` context, `v8` serialized values and a `URL` |
| `test-util-inspect-getters-accessing-this.js` | engine: a reflected getter cannot be invoked against a receiver — [zun#1](https://github.com/UrubuCode/zun/issues/1) | `'X { _y: 123 }' !== 'X { _y: 123, [y]: [Getter: 123] }'`. Half of this one is fixed: accessors **are** reflectable now, and `Object.getOwnPropertyDescriptor(K.prototype, 'y')` comes back with working `get` and `set` slots for a class accessor and an object-literal one alike. The step after it is missing — `desc.get.apply(obj, [])` aborts the interpreter with `expected object, found Void`, and `apply` threads no receiver into a function value anyway, so a getter that reads `this` (which is the whole point of this file) cannot be called. Two smaller gaps sit on the same path: `Object.getOwnPropertyNames(K.prototype)` omits `constructor` and `Object.getOwnPropertyDescriptor(Object.prototype, 'constructor')` is `undefined`, so Node's "stop at a built-in prototype" rule in `addPrototypeProperties` has nothing to test. The prototype-accessor walk is therefore still absent rather than half built |
| `test-util-inspect-long-running.js` | Tier-0 throughput | a 1 000-node shared graph inspected at `depth: Infinity`. Node's 2²⁷-character budget *is* implemented (`__utilChargeBudget`), and Node itself takes 128 ms; the interpreter does not reach the budget inside the tracker's cap. This is the one failure that is neither a missing module nor a semantic gap — it is a speed limit, and [zun#12](https://github.com/UrubuCode/zun/issues/12) (`charCodeAt`/`slice` are O(n)) is part of why |
| `test-util-inspect-namespace.js` | harness: `vm` | `new SourceTextModule(…)` and `[Module: null prototype]` |
| `test-util-inspect-proxy.js` | harness: `internal/test/binding`; engine: no proxy introspection | `showProxy` needs `getProxyDetails`, a host hook. `types.isProxy` answers `false` here, documented in the file header |
| `test-util-inspect-regexp.js` | engine: duplicate named capture groups (**new**) | `zun: runtime error: regex parse error: duplicate capture group name` on the literal `/(?<year>\d{4})-\d{2}\|\d{2}-(?<year>\d{4})/`, which ES2025 permits in disjoint alternatives and Node 25 accepts. With that one literal removed, **the entire file passes**: all ~100 highlighting expectations, the `brokenTests` entry, and the four palette-override cases (`colors = []`, `colors = undefined`, a custom three-colour palette, and `styles.regexp = 'red'`) |
| `test-util-internal.js` | harness: `internal/test/binding`, a real `require` | `privateSymbols.arrow_message_private_symbol` out of the `util` binding, then `require(fixtures.path('syntax','bad_syntax'))` to read the arrow message off a SyntaxError |
| `test-util-isDeepStrictEqual.js` | engine: boxed primitives | ``no field or setter `slow` `` on `boxedString.slow = true`. Boxed primitives are also indistinguishable from `{}` once held in an `any`, so `isDeepStrictEqual(new Number(2), new Number(1))` cannot be answered. The `skipPrototype` block at the end of the file *is* implemented |
| `test-util-parse-env.js` | harness: `node:fs`, `../../test/common/fixtures` | it reads `fixtures/dotenv/valid.env` off disk and compares 50 parsed entries |
| `test-util-primordial-monkeypatching.js` | engine: assigning to a built-in namespace member panics (**new**) | `Object.keys = () => { throw … }` aborts the interpreter with `expected object, found Any(Any { tag: ClassDescriptor, … })`. `inspect` already reads `Object.keys` defensively (`__utilOwnKeys` catches), so the moment the assignment itself works, this test passes |
| `test-util-promisify.js` | harness: `node:fs`, `node:vm` | `promisify(fs.readFile)` and a cross-context `Promise` |
| `test-util-sigint-watchdog.js` | harness: `internal/test/binding` | the SIGINT watchdog is a native facility |
| `test-util-text-decoder.js` | engine: `TextDecoder` arity (**new**) | ``error: `TextDecoder` has 0`` — the prelude's `TextDecoder` constructor takes no encoding label, so `new TextDecoder('windows-1252')` does not compile. The test body is inside a `skip: !common.hasIntl` test that would not even run |
| `test-util-types.js` | harness: `vm`, `internal/test/binding`, `crypto`; engine: opaque value classes | the file asks `types.isUint8Array`, `types.isArrayBuffer`, `types.isNumberObject`, `types.isGeneratorObject`… of values the engine keeps opaque once they ride an `any` lane (see below) |

### The engine gaps this module cannot design around

Four of these are new, found while writing `util.ts`, and all four are about a
value class the VM keeps opaque — which matters because `inspect(value)` and
`types.is*(value)` have exactly one lane, `any`:

* **Typed arrays, `ArrayBuffer`, `DataView`** lose everything through `any`:
  `o.length`, `o[0]`, `o.byteLength`, `o.buffer` and `o.constructor` are all
  `undefined`, `Object.keys(o)` is empty, and `Object.prototype.toString.call(o)`
  answers `[object Object]`. There is no way to tell one from a plain object, so
  `inspect` prints `{}` and every typed-array predicate answers `false`.
  Statically typed code can still index one — the `any` boundary is where it goes
  dark.
* **Boxed primitives** are likewise indistinguishable from `{}`, so `[Number: 1]`
  cannot be produced.
* **A symbol's `description`** read through an `any` panics the interpreter, so
  `util.ts` recovers it from `String(sym)`.
* **A nested closure's implicit arguments object** makes the parser inject a
  synthetic rest parameter into the *enclosing* function, and a dynamic call
  through an `any` receiver leaves it unbound — `util.promisify(fn)` aborted with
  `spread: value is not iterable` until every closure in `util.ts` was rewritten
  to take a real rest parameter. (Adjacent to
  [zun#11](https://github.com/UrubuCode/zun/issues/11), but a different
  mechanism.)
* **`Object.keys(aPromise)`** reports a foreign class's field names in a program
  that declares many classes: inside the test bundle it answers `['code']`,
  which is `NodeError`'s declared field. `Date` separately exposes an internal
  `millis`. Neither value can carry a user property here, so `inspect` does not
  enumerate either.

Known gaps that are *not* new: `Proxy` cannot be detected without a host hook,
a promise's settled value is not readable (so `inspect` prints
`Promise { <pending> }`), and a function's `name`/`length` are unavailable
([zun#25](https://github.com/UrubuCode/zun/issues/25)) so a function declaration
inspects as `[Function (anonymous)]` while a **class** correctly inspects as
`[class Foo]` and prefixes its instances `Foo { … }`.

One more, and it is how a function is told from a class here. Node uses
`Function.prototype.toString()` and looks for `class`; this engine answers
`[function]` or `[any]` to that ([zun#36](https://github.com/UrubuCode/zun/issues/36)),
so `__utilFormatFunctionValue` reads the object tag instead — a class is tagged
`[object Object]`, a function `[object Function]` — cross-checked against
`.prototype`, which a class exposes and a function value does not. That also
means every callable is one *kind*: an `async function`, a `function*`, an
`async function*` and a bound function are all tagged `[object Function]`, so
`[AsyncFunction: f]`, `[GeneratorFunction: f]` and `[Function: bound f]` all come
out as `[Function (anonymous)]`. The word is derived from the tag the way Node
derives it, so each kind appears on its own the day the engine tags it.

### Engine issues `util.ts` works around

No test is blocked by these; they are marked at each use site in
`src/util/util.ts`:

[#2](https://github.com/UrubuCode/zun/issues/2) `charCodeAt` out of range is a
runtime *abort*, not a throw, so every scan goes through `__cc()`;
[#3](https://github.com/UrubuCode/zun/issues/3) `.length` is typed `u64`, so
`Number(x.length)` everywhere;
[#10](https://github.com/UrubuCode/zun/issues/10) a dynamic method call caps at
six operands, so helper state travels in a `ctx` object;
[#13](https://github.com/UrubuCode/zun/issues/13) `!x` on an `any` empty string,
so `skipPrototype ? true : false`;
[#17](https://github.com/UrubuCode/zun/issues/17) a function cannot be returned
out of an object-literal method (the caller gets an opaque object that no longer
compares equal to the original), so `promisify`/`callbackify`/`deprecate`/
`debuglog` hand back the engine's `functionBox` record, and
`Object.prototype.toString` is never held in a binding. #17 also changed shape
under this engine: a `functionBox` now reports `typeof === "function"` rather
than `"object"` while staying tagged `[object Object]`, so `__utilUnbox` probes
the `__boxedFn` slot for both kinds — guarding on `"object"` alone left every
boxed callable unopened, and `inspect` then read it as a class and printed
`[class (anonymous)]` for every ordinary function;
[#1](https://github.com/UrubuCode/zun/issues/1) `apply`/`call` thread no
receiver into a plain function value and `apply` *shifts* there
(`f.apply(r, [a, b])` arrives as `f(r, a)`), so a promisified or callbackified
function cannot forward `this` — the one behavioural gap in those two;
[#32](https://github.com/UrubuCode/zun/issues/32) is mostly fixed and needs no
work-around in `inspect` any more: a function-valued property is visible to
`Object.keys`, `getOwnPropertyNames`, `Reflect.ownKeys`, `for-in` and
`getOwnPropertyDescriptor`, in insertion order, so `inspect({ fn() {} })` prints
`{ fn: [Function (anonymous)] }` where it used to print `{}` (Node prints
`{ fn: [Function: fn] }` — the difference is #25's missing `name`, nothing else).
What is left of #32 is symbol-keyed: `Object.getOwnPropertySymbols` reports none,
and `sym in obj` throws `Cannot convert a Symbol value to a string`;
[#37](https://github.com/UrubuCode/zun/issues/37) is designed out rather than
worked around: every coded error here is a `NodeTypeError`/`NodeRangeError`/
`NodeError` subclass with `code` as a **declared** field.

Two of the entries above came out with this engine update.
[#11](https://github.com/UrubuCode/zun/issues/11) measures as **fixed** — a rest
parameter is a real array through an `any` binding, read as a property value off
an `any` receiver, and called on an `any` receiver — and
[#14](https://github.com/UrubuCode/zun/issues/14) is **closed**: a method defined
inline in an object literal *can* carry properties now, and a function can carry
callable ones that resolve from module scope, a nested function, a closure and
an `any` parameter. `inspect`/`format`/`promisify`/`deprecate`/`debuglog`/
`styleText`/`highlightRegExp` stay top-level declarations placed onto the `util`
object, and `util.format`/`util.formatWithOptions` stay forwarding methods,
because that is the clearer shape for entry points that own properties — not
because the engine still demands it.

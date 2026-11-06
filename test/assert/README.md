# node:assert — Node.js compatibility tests

The compatibility bar for `assert` is **Node.js 25's own test suite**, not tests
we write. `assert` is **not finished** until it passes 100% of Node's
`test-assert*` tests.

`assert` is the one module in this repository that is measured twice. It is a
Node module like any other — the corpus below is its own bar — and it is also
the **harness every other module's corpus runs through**: each
`test/parallel/test-*.js` opens with `const assert = require('assert')`, so a
change here moves `path`, `events`, `os`, `util`, `buffer`, `string_decoder`,
`querystring`, `punycode`, `url` and `fs` at the same time. Every change to
`../../src/assert/assert.ts` is therefore re-measured against all of them, not
just against this corpus.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's
`test/parallel/test-assert*.js` files — fourteen of them, including
`test-assert.js` itself (which is why the tracker matches the prefix
`test-assert`, not `test-assert-`):

```
test-assert.js                        test-assert-fail.js
test-assert-async.js                  test-assert-first-line.js
test-assert-checktag.js               test-assert-if-error.js
test-assert-class.js                  test-assert-myers-diff.js
test-assert-class-destructuring.js    test-assert-partial-deep-equal.js
test-assert-deep.js                   test-assert-typedarray-deepequal.js
test-assert-deep-with-error.js        test-assert-esm-cjs-message-verify.js
```

Each is fetched verbatim from `nodejs/node` at tag `v25.0.0`; nothing is
vendored here. They need no `test/fixtures/` tree except
`test-assert-first-line.js`, which `require()`s two fixture *modules* — see the
table below.

## How they run

`assert` is **not** a `zun_abi` extension. It is pure computation, so it is
written in Zun TypeScript (`../../src/assert/assert.ts`) and compiled by the
platform's own compiler — no `--ext` library, no syscalls. See `../../PLAN.md`.

```sh
bash tools/run_node_tests.sh --zun <path-to-zun> --module assert
```

The tracker bundles each test with `tools/bundle_node_test.sh` and runs the
bundle as `zun run <bundle.ts>`. Three bundler entries exist for this module:

* `require('assert')` / `require('node:assert')` — the canonical bindings
  `assert`, `Assert` and `strict`, all three of which are top-level
  declarations in `assert.ts`, so `const { Assert } = require('assert')` and
  `const { strict } = require('assert')` both resolve to the real thing rather
  than to a destructured copy.
* `require('assert/strict')` → `__node_assert_strict`, which **is**
  `assert.strict` (`test-assert.js` asserts exactly that identity).
* `require('internal/assert/myers_diff')` →
  `__node_internal_assert_myers_diff`, this module's implementation surface in
  the same sense `internal/util` is `util`'s, with the canonical binding
  `myersDiff`.

## What the module implements

Following `lib/assert.js`, `lib/internal/assert/{assertion_error,myers_diff,
utils}.js` and `lib/internal/util/comparisons.js` (MIT, Copyright Joyent, Inc.
and other Node contributors):

* the callable module object, `ok`, `equal`/`notEqual` (loose, with Node 25's
  `NaN == NaN` rule), `strictEqual`/`notStrictEqual` (`Object.is`, so `0` and
  `-0` differ), `deepEqual`/`notDeepEqual` (**loose** deep equality — this used
  to be an alias for the strict comparison, which was simply wrong),
  `deepStrictEqual`/`notDeepStrictEqual`, `partialDeepStrictEqual`,
  `throws`/`doesNotThrow`, `rejects`/`doesNotReject`, `match`/`doesNotMatch`,
  `fail`, `ifError`;
* `AssertionError` with `code: 'ERR_ASSERTION'`, `actual`, `expected`,
  `operator`, `generatedMessage`, `diff`, a `toString()` of
  `AssertionError [ERR_ASSERTION]: <message>`, and Node's **generated messages**
  — the `kReadableOperator` headers ("Expected values to be strictly equal:",
  "Expected \"actual\" to be reference-equal to \"expected\":", …), the
  `+ actual - expected` Myers line diff with its `...`/"Skipped lines"
  collapsing, the short-value `a !== b` form and the stacked form with its `^`
  indicator;
* the `throws`/`rejects` validation forms — a RegExp against `String(error)`, a
  constructor, a validation object, an error instance, a predicate — each with
  Node's own failure message (`Missing expected exception`,
  `The error is expected to be an instance of "X". Received "Y"`,
  `The … validation function is expected to return "true". Received …`), plus
  `ERR_AMBIGUOUS_ARGUMENT` for the `error`-is-the-message case and
  `ERR_INVALID_ARG_TYPE`/`ERR_INVALID_RETURN_VALUE`/`ERR_MISSING_ARGS` where
  Node raises them;
* `assert.strict` / `require('assert/strict')`, and `assert.Assert` — Node 25's
  configurable surface, `new Assert({ diff, strict, skipPrototype })`.

Two members the module does **not** have, because Node 25 does not either:
`assert.CallTracker` was removed (there is no
`lib/internal/assert/calltracker.js` at `v25.0.0`), and with it `assert.fail`'s
legacy four-argument form and its DEP0094 warning —
`Assert.prototype.fail(message)` takes one value.

## Status and what blocks the rest

[`RESULTS.md`](RESULTS.md) is the live per-test table; it and the README bar are
regenerated by every tracker run, so they — not this page — are the current
number.

**Nothing still failing is blocked in `assert.ts`.** Every remaining failure is
an engine gap or a facility the harness cannot provide; the assertions
themselves were checked against Node 22 and Node 25's expectations by hand and
match.

| Test | Blocked by | What happens |
|---|---|---|
| `test-assert.js` | *instanceof on a member expression* (new, reported with this work), [zun#37](https://github.com/UrubuCode/zun/issues/37), `new TypeError(nonString)` | three sites spell `err instanceof assert.AssertionError`, and the right operand of `instanceof` must be a literal class name — a member expression does not compile at all. The file also does `const err = new TypeError(); err.code = …` on an engine `TypeError` ("no field or setter `code`", the typed half of #37) and `new TypeError(someObject)` ("`TypeError` message must be a string"). |
| `test-assert-async.js` | *instanceof on a member expression* (new) | the same `err instanceof assert.AssertionError` at three sites, and nothing else: the `rejects`/`doesNotReject` behaviour underneath was verified by hand. |
| `test-assert-checktag.js` | — | **passes.** Its body is one `test('', { skip: !hasCrypto })`, and `common.hasCrypto` is `false` here, exactly as in a `--without-ssl` Node build. |
| `test-assert-class.js` | *instanceof on a member expression* (new), `new Array(a, b, c)` | `assertInstance.ok(e instanceof assertInstance.AssertionError)` is the member-expression form again, and `new Array(1, 2, 3)` is rejected with "`Array` expects one length argument" — the engine only has the single-length constructor. |
| `test-assert-class-destructuring.js` | [zun#19](https://github.com/UrubuCode/zun/issues/19) | `new Assert({ diff: 'full' })` and its methods work (the first and third suites get as far as their *destructuring* half); `const { strictEqual } = assertInstance` is the blocker — a class method cannot be read as a value, so the destructured name is `undefined` and the call reports "undefined is not a function". Node's rule here is precisely that a destructured method **loses** its options and falls back to the defaults, which is why the instance cannot simply hand out closures that capture them. |
| `test-assert-deep.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38), [zun#21](https://github.com/UrubuCode/zun/issues/21), `super(...rest)`, `Buffer.from(view)` | the file builds `class MyRegExp extends RegExp` ("unknown base class `RegExp`") with a `super(...args)` ("`super` calls do not support rest/spread parameters yet"), and then walks every typed-array kind (`type BufferView(U8) has no fields`, `Buffer.from` of a view). Its `require('crypto')` branch is guarded by `common.hasCrypto` and is skipped. |
| `test-assert-deep-with-error.js` | `util.inspect` of an error | the assertions compare `AssertionError.message` against diffs such as `  [Error: a] {\n+   [cause]: [Error: x]\n…`. Node reaches that form by *copying* the error into a plain object with the error's prototype so `inspect` prints the short `[Error: a]` tag and surfaces `cause` as a hidden `[cause]` entry; `util.inspect` here prints an error as its `stack` and has no `[cause]` entry, so the diff text differs. The comparison itself is now right — the file's `deepStrictEqual`/`notDeepStrictEqual` pairs over differing causes do throw and do not throw as Node says, so what is left is the *text*: `assert.deepStrictEqual` compares `cause` and `errors` (that was fixed in `util`'s deep-equality with this work — two errors differing only in their cause used to compare **equal**, because `cause` is readable but is not an own property here, so the key walk never saw it). |
| `test-assert-esm-cjs-message-verify.js` | [zun#4](https://github.com/UrubuCode/zun/issues/4); harness: `child_process` | the test spawns `process.execPath` twice, as CommonJS and as ESM, and compares the two `AssertionError` lines on stderr. There is no child-process facility here (the harness stub throws), and the bundler's unresolved-`require` check additionally trips over the file's `'const assert = require("assert");'` **string literal**, which is the program it feeds to `--eval`. |
| `test-assert-fail.js` | — | **passes.** `fail()`'s generated `Failed` message, `operator`, `actual`/`expected`, `generatedMessage` and the `stack: /Failed/` match. |
| `test-assert-first-line.js` | [zun#4](https://github.com/UrubuCode/zun/issues/4) | `assert.throws(() => require(path('assert-first-line')))` loads a *fixture module* at run time to prove the "The expression evaluated to a falsy value:\n\n  ässört.ok('')" message. There is no `require`/module resolution in the engine, so the call cannot be made. That message also needs the source expression behind the failing `ok`, which needs a stack with column information plus the caller's own text. |
| `test-assert-if-error.js` | *`err.stack` has no setter* (new, reported with this work) | the first case is `const error = new Error(); error.stack = 'Error: containing weird stack\nYes!\n…'`, which does not compile ("no field or setter `stack` on this type"). The same gap is why `ifError` cannot splice the original error's frames onto the `AssertionError` as Node does. |
| `test-assert-myers-diff.js` | — | **passes.** `require('internal/assert/myers_diff')` resolves to this module's own `myersDiff`, and its `ERR_OUT_OF_RANGE` for an input larger than `2 ** 31 - 1` carries Node's message. |
| `test-assert-partial-deep-equal.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38), `array index must be an integer` | `partialDeepStrictEqual` itself is implemented (objects, arrays as ordered subsequences, `Map`, `Set`, the error members); the file's own fixtures are typed arrays, `SharedArrayBuffer` views and computed array indices the checker rejects. Its two `node:crypto` uses are guarded by `common.hasCrypto` and are skipped. |
| `test-assert-typedarray-deepequal.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38), `subarray(begin)` | the whole file is typed arrays: `type BufferView(U8) has no fields`, and the one-argument `view.subarray(1)` form is missing ("`subarray` expects 2 argument(s), found 1"). |

### Differential run against Node

Fifty failing assertions — every operator, every `throws`/`rejects` validation
form, custom messages, the short `a !== b` form, the stacked form with its `^`
indicator, the `...`/"Skipped lines" collapsing over a 30-key object and a
60-element array, `Map`/`Set`/`Date`/`RegExp`/`Symbol` values, and the
`partialDeepStrictEqual` header — were run through both this module and Node,
comparing `err.code` and `err.message` byte for byte. **Forty-nine are
identical.** The one divergence is the placeholder object a failing *validation
object* prints: Node's is an instance of a class called `Comparison`, so the
diff reads `Comparison { name: 'Error' }`, and this one is a plain object
reading `{ name: 'Error' }`. A class instance cannot be given those keys here —
a key the class did not declare poisons the instance
([zun#37](https://github.com/UrubuCode/zun/issues/37)) and
`Object.defineProperty` on one throws.

### New engine gaps this work found

Each has a standalone repro; none is in the issue list (checked against
`--state all`):

1. **`instanceof` with a member expression as its right operand does not
   compile.** `const ns = { Err: TypeError }; e instanceof ns.Err` →
   `[SEM0001] right operand of 'instanceof' must be a class name`. This is
   [zun#18](https://github.com/UrubuCode/zun/issues/18)'s sibling for
   `instanceof` rather than `new`, and it is what blocks three of the four
   largest files in this corpus, because `err instanceof assert.AssertionError`
   is how Node's own tests check an assertion error.
2. **`new Array(a, b, c)` is rejected**: `[SEM0001] 'Array' expects one length
   argument`. Only the single-length constructor exists, so the
   element-list form of a valid JavaScript built-in is a compile error.
3. **`err.stack` cannot be assigned**: `const e = new Error('m'); e.stack = 'x'`
   → `[SEM0001] no field or setter 'stack' on this type`. Reading it works and
   answers a string.
4. **Passing a function value to a class method that declares a rest parameter
   aborts the program.** `class K { m(...rest) {} } new K().m(() => 1)` →
   `zun: runtime error: call did not resolve to a method`. `new K().m(1)` is
   fine, and a rest parameter on a plain function, on an object-literal method
   and on a function's expando property all accept a function argument — only
   the class method does not. This is why `assert.Assert`'s methods take three
   optional parameters while the module-level ones take a rest parameter.

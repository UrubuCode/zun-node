# node:punycode — Node.js compatibility tests

The compatibility bar for `punycode` is **Node.js 25's own test suite**, not
tests we write. `punycode` **passes 100% of it**.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's
`test/parallel/test-punycode*.js` files — one of them:

```
test-punycode.js
```

It is fetched verbatim from `nodejs/node` at tag `v25.0.0`; nothing is vendored
here. The file is dense: on top of the hand-written `encode`/`decode`/`toASCII`/
`toUnicode`/`ucs2` expectations it runs **all nineteen RFC 3492 section 7.1 test
vectors** (Arabic, both Chinese scripts, Czech, Hebrew, Hindi, Japanese, Korean,
Russian, Spanish, Vietnamese and the seven Japanese title cases) through four
functions each, and checks the three `RangeError` paths and the DEP0040
deprecation warning.

## How they run

`punycode` is **not** a `zun_abi` extension. Bootstring is pure computation, so
it is written in Zun TypeScript (`../../src/punycode/punycode.ts`) and compiled
by the platform's own compiler — no `--ext` library, no syscalls. See
`../../PLAN.md`.

```sh
bash tools/run_node_tests.sh --zun <path-to-zun> --module punycode
```

## The deprecation warning, and why it lives in its own file

`punycode` is deprecated (DEP0040) and still shipped. Node emits the warning
from the top of `lib/punycode.js`, so it fires on the **first require** of the
module and once per process, and `test-punycode.js` asserts it with
`common.expectWarning('DeprecationWarning', …, 'DEP0040')` — an expectation the
harness fails if the warning never arrives.

The engine has no module system ([zun#4](https://github.com/UrubuCode/zun/issues/4)),
so "the module was required" is a fact only the bundler knows. The algorithms
are therefore always inlined — `../../src/url/url.ts` stands on them for
`domainToASCII`/`domainToUnicode` — while the single `process.emitWarning` call
sits in `../../src/punycode/deprecation.ts`, which the bundler inlines **only**
for a test that requires `punycode` (see `CONDITIONAL_FILES` in
`tools/bundle_node_test.sh`). Requiring `node:url` therefore does not emit a
`punycode` warning, exactly as in Node.

## What it took to get to 100%

Two things outside `punycode.ts`:

| Fix | Why |
|---|---|
| `assert.throws(fn, regexp)` now matches `String(err)` | Node's `expectedException` tests a regular expression against the *stringified error* (`"RangeError: Invalid input"`), which is why its own tests anchor the error's name in the pattern — `test-punycode.js` uses `/^RangeError: Invalid input$/` for all three error paths. `src/assert/assert.ts` was matching the message alone. |
| The Bootstring state variables are annotated `number` | A conditional whose branches mix an integer-typed constant with a float-typed expression (`k <= bias ? tMin : k - bias`, where `bias` is later assigned `Math.floor(...)`) yields an `Any`, and passing that `Any` to a `number` parameter panics the interpreter with `expected float, found Any(Any { tag: Float, … })` — in `zun_interp/src/value.rs`'s `as_number`. **New engine bug**, reported with this work; the annotations pin the representation and are the whole workaround. |

## Engine workarounds in the module

Each is marked at its use site in `../../src/punycode/punycode.ts`:

- **No regular expressions.** Node's `lib/punycode.js` uses four (`/^xn--/`,
  `/[^\0-\x7F]/`, the RFC 3490 separator class and its `g` flag); a RegExp loses
  its methods through an `any`
  ([zun#7](https://github.com/UrubuCode/zun/issues/7)), and all four are
  single-character classes or a literal prefix, so each is a scan. That also
  leaves the module with no backtracking surface — the same posture
  `querystring.ts` takes.
- `__pcUnits()` — `charCodeAt(index)` is O(n) in the string's length
  ([zun#12](https://github.com/UrubuCode/zun/issues/12)), so every scan runs
  over the code-unit array `split("")` produces.
- `__pcLen()` — the checker types `.length` as `u64`
  ([zun#3](https://github.com/UrubuCode/zun/issues/3)).
- `String.fromCodePoint(...codePoints)` is a per-element fold; Node spreads the
  whole array into the built-in, and spread into a built-in is not something to
  lean on here when a fold is identical.
- Boolean-as-number arithmetic (`75 * (digit < 26)`, `(flag != 0) << 5`) is
  written out as conditionals.
- Every entry of the module object is a function **expression assigned to a
  property**, not a shorthand method, because `test-punycode.js` drives the
  whole vector table through `testBattery[key](testCase)` — the function has to
  be callable through the object *and* readable out of it as a value, and a
  shorthand method read as a value answers `null`.

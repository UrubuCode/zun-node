# node:url — Node.js compatibility tests

The compatibility bar for `url` is **Node.js 25's own test suite**, not tests we
write. `url` is **not finished** until it passes 100% of Node's `test-url*` and
`test-whatwg-url-*` tests.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's **two** prefixes — 44 files.

`test/parallel/test-url*.js` is 17 of them. That prefix also selects
`test-urlpattern*`, and that is deliberate: `URLPattern` is a `node:url` export
in Node 25, so those files are part of this module's bar rather than a
different one's.

```
test-url-domain-ascii-unicode.js           test-url-parse-invalid-input.js
test-url-fileurltopath.js                  test-url-parse-query.js
test-url-format-invalid-input.js           test-url-pathtofileurl.js
test-url-format-whatwg.js                  test-url-relative.js
test-url-format.js                         test-url-revokeobjecturl.js
test-url-invalid-file-url-path-input.js    test-url-urltooptions.js
test-url-is-url-internal.js                test-urlpattern-invalidthis.js
test-url-parse-format.js                   test-urlpattern-types.js
                                           test-urlpattern.js
```

`test/parallel/test-whatwg-url-*.js` is the other 27. They used to be declared
out of scope here, on the grounds that they exercise the engine's global
`URL`/`URLSearchParams` — the prelude classes in `crates/zun_prelude/builtin/`
— rather than anything `node:url` adds. That is no longer true: **the WHATWG
URL Standard is implemented in this module**, in `../../src/url/whatwg.ts`, and
`node:url` exports it. Those 27 files are this module's bar.

```
test-whatwg-url-canparse.js                   test-whatwg-url-custom-searchparams-has.js
test-whatwg-url-custom-deepequal.js           test-whatwg-url-custom-searchparams-inspect.js
test-whatwg-url-custom-global.js              test-whatwg-url-custom-searchparams-keys.js
test-whatwg-url-custom-href-side-effect.js    test-whatwg-url-custom-searchparams-set.js
test-whatwg-url-custom-inspect.js             test-whatwg-url-custom-searchparams-sort.js
test-whatwg-url-custom-parsing.js             test-whatwg-url-custom-searchparams-stringifier.js
test-whatwg-url-custom-properties.js          test-whatwg-url-custom-searchparams-values.js
test-whatwg-url-custom-searchparams-append.js test-whatwg-url-custom-searchparams.js
test-whatwg-url-custom-searchparams-constructor.js  test-whatwg-url-custom-setters.js
test-whatwg-url-custom-searchparams-delete.js       test-whatwg-url-custom-tostringtag.js
test-whatwg-url-custom-searchparams-entries.js      test-whatwg-url-invalidthis.js
test-whatwg-url-custom-searchparams-foreach.js      test-whatwg-url-override-hostname.js
test-whatwg-url-custom-searchparams-get.js          test-whatwg-url-properties.js
test-whatwg-url-custom-searchparams-getall.js
```

Each file is fetched verbatim from `nodejs/node` at tag `v25.0.0`; nothing is
vendored here.

## How they run

`url` is **not** a `zun_abi` extension. It is pure computation, so it is written
in Zun TypeScript (`../../src/url/url.ts` and `../../src/url/whatwg.ts`) and
compiled by the platform's own compiler — no `--ext` library, no syscalls. It
stands on `events` (the `ERR_*` bases), `util` (`ERR_MISSING_ARGS`), `path`
(`fileURLToPath`/`pathToFileURL`, both platforms), `querystring` (`parse`'s
`parseQueryString`) and `punycode` (IDNA, `domainToASCII`/`domainToUnicode`),
which is why the two files are inlined last of the library modules. See
`../../PLAN.md`.

```sh
bash tools/run_node_tests.sh --zun <path-to-zun> --module url
```

`internal/url` is in the bundler's module table alongside `internal/util`, for
the same reason: it is `url`'s own implementation surface, not a separate
module, and that is what lets `test-url-is-url-internal.js` ask for `isURL`
under `--expose-internals`.

### `NodeURL`, and why the bundler renames

`URL` and `URLSearchParams` are **prelude class names** in this engine, and a
user class of the same name is rejected outright with "duplicate class" — so
the spec implementation cannot be *called* `URL`. It is declared as
`NodeURL`/`NodeURLSearchParams`, exported as `url.URL`/`url.URLSearchParams`
(the spelling Node's own tests reach for, `const { URL } = require('url')`), and
`tools/bundle_node_test.sh` rewrites the three spellings a test body can use to
reach the class itself:

```
new URL(…)          ->  new NodeURL(…)
URL.<static>        ->  NodeURL.<static>
x instanceof URL    ->  x instanceof NodeURL
```

plus `extends URL`, and the same four for `URLSearchParams`. Every *other*
appearance of the word is left exactly as written — a string, `ERR_INVALID_URL`,
`globalThis.URL`, a local called `fileURL` — because each rule needs either
`new `/`instanceof `/`extends ` before the name or a member access immediately
after it, and the member rule refuses a word character, a dot or a quote before
the name. That is the same move the bundler already makes for `console`,
`performance` and `crypto`, and for the same reason: a prelude name the checker
owns, bound to the real module under a second name. The whole 44-file corpus was
audited for it; the only matches inside a string literal are in
`test-whatwg-url-canparse.js`, which needs `eval` and V8 natives syntax and
cannot run here at all.

The prelude classes stay reachable and untouched; nothing here shadows them.

## Status and what blocks the rest

[`RESULTS.md`](RESULTS.md) is the live per-test table; it and the README bar are
regenerated by every tracker run, so they — not this page — are the current
number.

Nothing in the table below is blocked by a gap in `url.ts` or `whatwg.ts`. The
blockers fall into six groups.

### 1. `URLPattern` is not implemented

| Test | What happens |
|---|---|
| `test-urlpattern.js`, `test-urlpattern-types.js`, `test-urlpattern-invalidthis.js` | `URLPattern` is a separate WHATWG specification that Node implements in C++ (ada's `url_pattern`). The export is `undefined` and the gap is declared rather than faked — the two small files are almost entirely argument *type* checks, and answering them without the pattern compiler underneath would be exactly the special-casing this repository does not do. `test-urlpattern-invalidthis.js` additionally needs `Object.getOwnPropertyDescriptor(proto, name).get` and an "Illegal invocation" brand check, i.e. the function/prototype model of [zun#25](https://github.com/UrubuCode/zun/issues/25). |

### 2. Reading a class method as a *value* ([zun#19](https://github.com/UrubuCode/zun/issues/19), [zun#1](https://github.com/UrubuCode/zun/issues/1))

Eight of the nine `test-whatwg-url-custom-searchparams-*.js` files open with the
same three lines — `params.<method>.call(undefined)` must raise
`ERR_INVALID_THIS` — and nothing else in them is in question.

| Test | What happens |
|---|---|
| `…-searchparams-append.js`, `…-delete.js`, `…-foreach.js`, `…-get.js`, `…-getall.js`, `…-has.js`, `…-set.js` | the checker rejects the bundle outright: "`call` passes 1 argument(s) including the receiver". A method a class declared cannot be read as a value here, so `.call` on one is unreachable. Every *other* expectation in these seven was checked individually and matches — the `ERR_MISSING_ARGS` messages, and the `toString`-throwing object and the `Symbol` rejection for each argument position. |
| `…-searchparams-stringifier.js` | the same first block, by a worse route: `params.toString.call(undefined)` **panics the interpreter** instead of failing cleanly. A class method invoked with `this` undefined, whose body reads `this.<field>`, aborts the process with "expected object, found Void" (`crates/zun_interp/src/value.rs:228`) where Node throws `TypeError: Cannot read properties of undefined`. New bug, reported with this work; it is the `.call(undefined)` sibling of [zun#54](https://github.com/UrubuCode/zun/issues/54). Its second block — the stringifier re-encoding the URL's query, `?foo=~bar` becoming `?foo=%7Ebar` after `searchParams.sort()` — is correct here. |

### 3. `Symbol.iterator` / `Symbol.toStringTag` on a class

Zun has no symbol-keyed class members, so `URLSearchParams` exposes
`entries()`/`keys()`/`values()` as objects carrying a `next()` and an `items`
array rather than as real ECMAScript iterators.

| Test | What happens |
|---|---|
| `…-searchparams-entries.js`, `…-keys.js`, `…-values.js` | each asserts `typeof it[Symbol.iterator] === 'function'` and `it[Symbol.iterator]() === it` before anything else, and each *closes* with the `params.<method>.call(undefined)` pair of group 2 — so these three need both gaps closed. The `next()` sequences in between — `{ value, done }` through the end and twice past it — are all correct. |
| `test-whatwg-url-custom-tostringtag.js` | `url[Symbol.toStringTag]` must be `'URL'` and `Object.prototype.toString.call(url)` must be `'[object URL]'`. |
| `test-whatwg-url-custom-searchparams-constructor.js` | builds its iterables with `Object.assign(() => {}, { [Symbol.iterator]() {…} })` and asserts `ERR_ARG_NOT_ITERABLE` for `{ [Symbol.iterator]: 42 }`. The record, sequence, string, `undefined`/`null` and copy forms of the constructor, and the `ERR_INVALID_TUPLE` / `toString`-throws / `Symbol` paths, were each checked by hand and match. |
| `test-whatwg-url-custom-searchparams-sort.js` | `for (const param of params)`, over both a free-standing `URLSearchParams` and `url.searchParams`. The sort itself is the standard's **stable** sort and was verified against Node over the 90-pair input this file builds. |

### 4. The function/prototype/descriptor model ([zun#25](https://github.com/UrubuCode/zun/issues/25))

| Test | What happens |
|---|---|
| `test-whatwg-url-properties.js` | walks `URL.prototype` and `URLSearchParams.prototype` with `Object.getOwnPropertyDescriptor`, checking `writable`/`enumerable`/`configurable` and that each accessor is a getter pair on the *prototype*. |
| `test-whatwg-url-custom-properties.js` | the same, from the instance side: a `for…in` over a `URL` must enumerate exactly the fourteen prototype accessors in WebIDL order, `delete url.href` must answer `true` and have no effect, and setting `url.origin` must throw "Cannot set property origin of [object URL] which has only a getter". |
| `test-whatwg-url-invalidthis.js` | `Reflect.apply(URL.prototype[i], [], {})` and `Reflect.get(URL.prototype, i, {})` must raise "Receiver must be an instance of class" / "Cannot read private member". |
| `test-whatwg-url-custom-global.js` | `Object.getOwnPropertyDescriptor(globalThis, 'URL')` must be `{ value: URL, writable: true, configurable: true, enumerable: false }`. The global here is the engine's prelude class, installed by the prelude, and a property descriptor for it is not something a library can produce. |

### 5. `util.inspect` custom formatting

| Test | What happens |
|---|---|
| `test-whatwg-url-custom-searchparams-inspect.js` | needs `util.inspect(sp)` to answer ``URLSearchParams { 'a' => 'a', … }`` and `util.inspect(sp.keys())` to answer `URLSearchParams Iterator { 'a', … }`, i.e. a `Symbol.for('nodejs.util.inspect.custom')` member on the class — the same symbol-keyed-member gap as group 3 — and `sp[util.inspect.custom].call()` to raise `ERR_INVALID_THIS`, which is group 2. |

### 6. The harness and the bundler

| Test | Blocked by | What happens |
|---|---|---|
| `test-url-parse-invalid-input.js` | harness: `common.spawnPromisified` | re-runs the runtime through `child_process` to see `url.parse` fail in a fresh process, and awaits the result through `common.mustCall`, so the call counts can never settle. The checks that do not need a subprocess — the ten `ERR_INVALID_ARG_TYPE` messages, the `URIError` with no `code` from `decodeURIComponent`, and `ERR_INVALID_URL` for a NUL inside an IPv6 host — all pass. |
| `test-url-pathtofileurl.js` | [zun#92](https://github.com/UrubuCode/zun/issues/92) (spread into a call) | the file opens with `String.fromCharCode(...Array.from({ length: 26 }, …))` at top level, which the compiler rejects with "spread arguments are not lowered yet". Behind it, every one of its 27 Windows and 24 posix cases was checked against the file's own expectation table and matches, including the UNC, extended-UNC and local-device forms and the 32 767-character path. |
| `test-url-relative.js` | **engine bug** (allocation-triggered corruption) | the single biggest file in the corpus, and `url.ts` answers all of it correctly: a differential run against Node over all 194 `relativeTests2` cases through `url.resolve` (compared, as the file does, against `url.format(expected)`) and all 31 `relativeTests` through `url.resolve`, `url.resolveObject` + `assert.deepStrictEqual` and `url.format` shows **zero divergences**. What stops the file is the engine: after roughly 80 `url.resolve` calls over a long-lived array of string literals, the loop counter itself reads back `Void` and the interpreter panics ("expected float, found Void", `crates/zun_interp/src/value.rs:157`). That is [zun#67](https://github.com/UrubuCode/zun/issues/67) — the dynamic-call path drops the *calling* frame from the GC root chain, so the first young collection frees the caller's live locals. Re-confirmed on `c4afcca4`; the reduced repro is 120 rows of `['aN', 'http://hN/p']` and one `url.resolve` per row, which dies at row 83. |
| `test-whatwg-url-canparse.js` | `eval` + V8 natives syntax | drives `eval('%PrepareFunctionForOptimization(URL.canParse)')` and `eval('%OptimizeFunctionOnNextCall(URL.canParse)')` to check that the fast API path is taken. The three things it asserts without `eval` — `URL.canParse()` raising `ERR_MISSING_ARGS`, `URL.canParse('https://example.org')`, and the two-argument `URL.canParse('/', 'http://n')` — all pass. |
| `test-whatwg-url-custom-parsing.js`, `…-custom-searchparams.js`, `…-custom-setters.js` | bundler: `require(fixtures.path(…))` | each `require`s a data module out of Node's `test/fixtures/` tree (`wpt/url/resources/urltestdata.json`, `url-tests-additional.js`, `url-searchparams.js`, `url-setter-tests-additional.js`), which the bundler has no rule for, so the bundle is refused rather than silently losing a module. All three are `{ skip: !hasIntl }` files in any case. What they would have driven is covered directly instead — see the differential table below, which runs two of those same fixtures. |
| `test-whatwg-url-custom-searchparams-sort.js` | bundler: `../common/wpt` | needs the WPT harness shim (`test`, `assert_array_equals`), which this library does not carry; and then group 3's iterator. |

## Differential evidence

Six of the corpus files cannot be bundled or expressed at all, so the
implementation was checked directly against the fixtures Node itself ships, with
Node v22.23.2 as the second oracle.

| Table | Comparisons | Result |
|---|---|---|
| WPT `url/resources/urltestdata.json` (what `test-whatwg-url-custom-parsing.js` and Node's own WPT runner drive) | 869 cases x 11 components (`href`, `origin`, `protocol`, `username`, `password`, `host`, `hostname`, `port`, `pathname`, `search`, `hash`), plus parse failure vs. success | **862 identical, 7 divergent** — every one of the seven is a UTS#46 mapping-table case; see below |
| WPT `url/resources/setters_tests.json` (what `test-whatwg-url-custom-setters.js` drives) | 270 setter cases x 10 components after the write | **0 divergences** |
| `URLSearchParams` surface | 35 cases: all five constructor forms, `get`/`getAll`/`has`/`size`/`append`/`set`/`delete` (one- and two-argument), the stable `sort`, `forEach`, `keys`/`values`/`entries`, the urlencoded serializer's exact escape set, every `ERR_MISSING_ARGS`, and the live link to the owning URL through `append`, `delete`, `sort`, `search =` and `href =` | **0 divergences** |
| `test-url-parse-format.js`' `parseTests` | 89 cases x (12 fields + the whitespace-trimmed re-parse + `url.format(expected)`) | 0 divergences |
| `test-url-format.js`' `formatTests` | 29 cases x (`format(string)` and `format(object)`) | 0 divergences |
| `test-url-relative.js`' `relativeTests2` | 194 cases through `url.resolve`, compared against `url.format(expected)` as the file does | 0 divergences |
| `test-url-relative.js`' `relativeTests` | 31 cases x (`url.resolve`, `url.resolveObject` + `assert.deepStrictEqual`, `url.format`) | 0 divergences |
| `test-url-pathtofileurl.js`' case tables | 27 Windows + 24 posix, including the UNC, extended-UNC, local-device (the `\\?\C:\` prefix) and 32 767-character cases | 0 divergences |
| `test-url-fileurltopath.js`' case tables | 22 Windows + 21 posix, plus the six argument/scheme error paths and the three `ERR_INVALID_FILE_URL_PATH` cases | 0 divergences |

The four passing `{ skip: !hasIntl }` files — `test-url-format.js`,
`test-url-format-whatwg.js`, `test-url-parse-format.js`,
`test-url-domain-ascii-unicode.js` — and `test-whatwg-url-custom-inspect.js`
are **skips, not green**: this runtime has no ICU, `common.hasIntl` is `false`,
and Node's own runner skips them on an ICU-less build too (a skip is a pass in
TAP). Everything else in the table is a real pass.

## What the WHATWG implementation is

`../../src/url/whatwg.ts` follows <https://url.spec.whatwg.org/> step for step:

- the **basic URL parser** as its 21 states, including `stateOverride` — which
  is what every setter runs;
- **host parsing**: opaque hosts, the IPv4 parser (with the hexadecimal and
  octal number forms, the "ends in a number" test and the overflow rule that
  makes `http://0x100000000/` a parse failure rather than a domain), the IPv6
  parser and both serializers (including the longest-zero-run compression);
- the eight **percent-encode sets** (C0 control, fragment, query, special
  query, path, userinfo, component, urlencoded) as a predicate chain, applied
  per *code point* so a surrogate pair becomes one four-byte sequence;
- the **URL and origin serializers**, including the `/.` guard that keeps
  `a:/.//p` from re-parsing as an authority, and the `blob:` inner-URL origin;
- every **getter and setter**, with the standard's "cannot have
  credentials"/"has an opaque path" guards and the "potentially strip trailing
  C0 control or space from an opaque path" step that makes `data:space ?query`'s
  trailing space observable once the query is removed;
- `URL.canParse`, `URL.parse`, `toJSON`, and the argument check of
  `URL.createObjectURL`/`revokeObjectURL`;
- `URLSearchParams` in full, with the urlencoded parser and serializer and the
  **live link** back to the URL that owns it, so `url.searchParams.sort()`
  rewrites `url.search`.

**No regular expressions**, anywhere: a RegExp loses its methods through an
`any` ([zun#7](https://github.com/UrubuCode/zun/issues/7)), and a URL parser is
the last place that should own a backtracking engine.

## Engine gaps, and what the two files do about them

- **IDNA is punycode plus a finite slice of UTS#46, not ICU.** There is no ICU
  in this runtime (`common.hasIntl` is `false`, which is why Node's own
  IDNA-dependent tests are written `{ skip: !hasIntl }`).
  `__wuDomainToASCII` does the RFC 3492 encoding — `punycode.toASCII`, from
  `../../src/punycode/punycode.ts` — plus the three parts of UTS#46 processing
  that are a table rather than the whole Unicode database: the **ignored** code
  points (soft hyphen, zero-width space, word joiner, BOM, the combining
  grapheme joiner, the Mongolian free variation selectors, the variation
  selectors), the **disallowed** ones (U+FFFD — which is also what an invalid
  UTF-8 percent-escape decodes to — and every Unicode noncharacter), and the
  **mapped** ones it can map exactly (the fullwidth forms U+FF01..U+FF5E, which
  fold onto ASCII so that a fullwidth `%` reaches the forbidden-domain check,
  and the space-like code points UTS#46 maps onto U+0020). An `xn--` label also
  has to be decodable and has to decode to something, so `https://xn--/` is a
  failure.
  Those additions take the WPT constructor corpus from 36 divergences to 7. The
  remaining seven are all one missing piece of the same table: six
  `xn--pokxncvks` variants, whose punycode decodes to code points UTS#46 would
  have mapped away (so ICU rejects the label and we accept it), and one
  `file://` host written in Mathematical Bold Capitals, which needs that block
  to fold onto ASCII before `localhost` can be recognised.
- **`URLPattern` is not implemented** — see group 1 above.
- **`fileURLToPathBuffer` is absent**, because `node:buffer` is not wired into
  this module yet.
- **`isURL` is `value instanceof NodeURL`, not Node's duck-type.** Node tests
  `href && protocol && auth === undefined && path === undefined` because it
  wants to accept a cross-realm URL; there is one realm here, so identity
  against the class is both correct and what the duck-type stands in for. That
  is exactly what `test-url-is-url-internal.js` asserts.
- **Every method of `URLSearchParams` takes a rest parameter, except
  `forEach`.** Two opposite engine constraints meet here. The checker counts
  `name?: any, value?: any, ...rest: any[]` as two *required* parameters, so
  `params.has("a")` is a compile error ("`has` expects at least 2
  argument(s)") — hence the rest parameter, which Node's own tests need because
  they call each of these with too few arguments on purpose. But passing a
  **function** value into a rest parameter fails at the *call site* with "call
  did not resolve to a method", for a function expression written inline just as
  much as for an `any` holding one — a string, a number, a plain object and an
  array all pass through the same parameter fine — hence
  `forEach(callback, ...rest)`. Both are new bugs, reported with this work; the
  cost of the second is that `params.forEach()` with no argument is a compile
  error here rather than the `ERR_MISSING_ARGS` Node answers.
- **The `static` methods take optional parameters, for the mirror-image
  reason**: a `static` declared `(...args: any[])` is typed as taking one
  *array* argument, so `URL.canParse('https://example.org')` is rejected with
  "argument type String does not match Array".
- **Writing through a setter on an `any`-typed binding aborts the process**
  ([zun#79](https://github.com/UrubuCode/zun/issues/79) — the assigned value is
  passed where the receiver belongs). It does not reach the corpus, because a
  test's `const url = new URL(…)` is typed, but it is why the differential
  drivers in this work bind `const u = new NodeURL(href)` rather than
  `const u: any = …`.
- **`Object.assign(target, source)` copies nothing between two class
  instances** ([zun#70](https://github.com/UrubuCode/zun/issues/70)), and
  `resolveObject` is built on exactly that operation, so `__urlCopyInto` copies
  the twelve `Url` fields by name.
- **A `typeof`-narrowed variable cannot be reassigned to an object**
  ([zun#66](https://github.com/UrubuCode/zun/issues/66)).
  Narrowing `v` with `typeof v === "string"` and then assigning an object to `v`
  makes every later member read on it compile as a *string* member access, and
  the interpreter aborts with `expected object, found Str(…)`. Narrowing a
  *different* binding is unaffected, so `__urlResolveObjectFrom` and
  `__urlFileURLToPath` test the parameter and assign to a second name.
- **`host` cannot be a local variable name**: it resolves to the `zun:core`
  `host` namespace, and the checker reports "namespace `host` has no member
  `slice`". Hence `hostText`/`hostPart`/`hostValue`.
- `__urlUnits()` / `__wuUnits()` — `charCodeAt(index)` and `slice(from, to)`
  are O(n) in the string's length
  ([zun#12](https://github.com/UrubuCode/zun/issues/12)), so every scan in both
  files runs over the code-unit array `split("")` produces. `charCodeAt` also
  throws out of range ([zun#2](https://github.com/UrubuCode/zun/issues/2)),
  which the array form cannot. The same issue makes `path.posix.resolve` O(n²)
  — 11 seconds for a 10 000-character path — which is why `pathToFileURL`
  first decides in one linear pass whether `resolve` is the identity.
- `__urlTruthy()` — `!value` mis-reports an `any`-typed empty string as truthy
  ([zun#13](https://github.com/UrubuCode/zun/issues/13)), and `url.parse` is
  full of `this.hostname || ''`-shaped tests on exactly such values.
- `__urlLen()` / `__wuLen()` — the checker types `.length` as `u64`
  ([zun#3](https://github.com/UrubuCode/zun/issues/3)).
- `__wuCall3()` — a function that travelled through an array, which is what a
  rest parameter is, comes back boxed
  ([zun#17](https://github.com/UrubuCode/zun/issues/17)).
- [#37](https://github.com/UrubuCode/zun/issues/37) is designed out rather than
  worked around: `ERR_INVALID_URL`, `ERR_INVALID_URL_SCHEME`,
  `ERR_INVALID_FILE_URL_HOST`, `ERR_INVALID_FILE_URL_PATH` and
  `ERR_INVALID_THIS` are real `TypeError` subclasses with `code` — and, where
  Node carries one, `input` — as **declared** fields, because
  `test-url-invalid-file-url-path-input.js` reads `err.input.href` on exactly
  such an error.

Uncaught errors are printed as `Object(Obj(0x…))`
([zun#8](https://github.com/UrubuCode/zun/issues/8)), which is why the "Why"
column in `RESULTS.md` is often opaque.

## Security posture

`url.parse` is the one function in this library with a CVE history, and every
guard Node grew for it is reproduced rather than simplified away:

- **CVE-2018-12123** (hostname spoofing through a mixed-case scheme). The
  protocol is lower-cased *before* any `slashedProtocol` / `hostlessProtocol` /
  `unsafeProtocol` decision, so `HTTP://` and `http://` take the same branch.
  The one place Node asks with the literal (non-lowered) protocol is kept
  asymmetric, because that asymmetry is observable.
- **Forbidden host characters.** After IDNA the hostname is re-checked against
  NUL, tab, newline, carriage return, space and `# % / : < > ? @ [ \ ] ^ |`
  (with `[`, `]` and `:` permitted for an IPv6 literal) and an offender raises
  `ERR_INVALID_URL` instead of being moved into the path. NUL is in that set —
  the `http://[127.0.0.1\x00c8763]:8000/` case, i.e. the CVE-2026-48930 class: a
  NUL in a host must neither be accepted nor truncated away. The check runs
  *after* the IDNA step precisely because that step is what can reintroduce such
  a character.
- **An empty hostname after IDNA** also raises `ERR_INVALID_URL`: it was
  non-empty a moment earlier, so it can only have been emptied by `toASCII`, and
  an empty host is exactly what a spoof needs.
- **Hostnames over 255 characters** are dropped to the empty string first, as in
  Node.
- **No regular expressions.** Node uses eight in `lib/url.js`
  (`protocolPattern`, `portPattern`, `hostPattern`, `simplePathPattern`,
  `forbiddenHostChars`, `forbiddenHostCharsIpv6`, the `file:` protocol test and
  the slash replacement in `getPathFromURLWin32`); each is a hand-written scan.
- **Null-prototype query objects.** `parse(url, true)` routes the query through
  `querystring.parse`, which answers a null-prototype object, and the "no query
  string but `parseQueryString` requested" branch builds one directly.

The WHATWG side carries the standard's own guards: the forbidden *host* and
forbidden *domain* code point sets, the IPv4 overflow rule, the `xn--`
decodability check, and the `/.` serializer guard that stops a path beginning
with an empty segment from being re-read as an authority.

# node:module — Node.js compatibility tests

The compatibility bar for `module` is **Node.js 25's own test suite**, not tests
we write. Unlike every other module in this library, though, `module` cannot
reach 100% here, and the reason is structural rather than a gap to close: see
[What cannot work on this platform](#what-cannot-work-on-this-platform).

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module — 54
files under two prefixes, which is the split Node's own test names make:

* **`test-module-*`** (31 files) — the `node:module` surface itself:
  `builtinModules`, `isBuiltin`, `createRequire`, `Module._stat`,
  `Module._nodeModulePaths`, `Module._resolveLookupPaths`, `Module._initPaths`,
  `Module.wrap`, `Module.setSourceMapsSupport`, `stripTypeScriptTypes`, the
  caches and the extension table.
* **`test-require-*`** (23 files) — the *same* module system exercised through
  `require`: the resolver, `require.resolve`, `require.resolve.paths`,
  `require.cache`, `require.extensions`, the `node:` prefix and the error
  codes.

Nothing is excluded. `test-module-print-timing.mjs` is an ES module rather than
a CommonJS one and the bundler only handles CommonJS, so it cannot run — but it
is listed and counted anyway, because a corpus that leaves out the files it
fails is not a measurement. Each file is fetched verbatim from `nodejs/node` at
tag `v25.0.0`; nothing is vendored here.

`NODE_FIXTURES.txt` lists the 33 files from Node's `test/fixtures/` tree that
this corpus opens or stats — packages with a `main`, a package with an empty
`main`, a directory literally named `package.json`, an invalid JSON file, a
`.mjs` file, the `module-require/relative` tree. `tools/run_node_tests.sh`
downloads them next to the test file, so that the harness's
`fixtures.path(...)` — which computes exactly what Node's own
`test/common/fixtures.js` computes — finds them.

## How they run

`module` is Zun TypeScript over the native extension (`zun-ts+ext`): the whole
module is `../../src/module/module.ts`, and the facts under it are file-system
syscalls reached through `../../src/fs/fs.ts`.

```sh
bash tools/run_node_tests.sh \
    --zun target/release/zun.exe \
    --ext zun-node/target/debug/zun_node.dll \
    --module module
```

### The bundler's require mode

Every other corpus is bundled by rewriting `require(...)` **away**: the bundler
inlines this library's modules ahead of the test and replaces each
`require('x')` with the inlined object `__node_x` (see the header of
`../../tools/bundle_node_test.sh`). That is exactly wrong for the one corpus
whose subject *is* `require`. `test-require-cache.js` writes
`require.cache.fs` and then asks what `require('fs')` answers;
`test-module-cache.js` calls `require(<a path held in a variable>)`. Both need
`require` to be a function at run time, not a name the bundler erased.

So `tools/run_node_tests.sh --module module` exports **`ZUN_NODE_REQUIRE=1`**,
and the bundler then does three things differently — and only for this corpus,
so every other bundle stays byte-identical:

1. `src/fs/fs.ts` and `src/module/module.ts` are inlined unconditionally.
2. the generic `require('<specifier>')` → `__node_<specifier>` rewrite is **not**
   emitted for a Node builtin specifier. The canonical-binding rules still are,
   so a whole-line `const assert = require('assert');` is still deleted and
   `assert` is still the inlined module; what changes is that an *inline*
   `require('fs')` survives to run time.
3. every surviving `require` in the body becomes **`__zunRequire`**, the
   `require` of the bundled file's own module record. That one rename carries
   `require(...)`, `require.resolve(...)`, `require.resolve.paths(...)`,
   `require.cache`, `require.extensions` and `require.main` at once.

The registry that makes step 3 answer anything is emitted with the bundle: one
`__modRegisterBuiltin("<specifier>", __node_<specifier>)` call per module object
the bundle actually declares. That is how `node:module` knows what *this
program* carries, and it is the only honest answer available — there is no disk
to read a built-in module from.

That "byte-identical" is checked rather than asserted: five bundles from the
other corpora (`test-path-join`, `test-events-once`, `test-assert`,
`test-util-inspect`, `test-buffer-alloc`) were produced by the bundler as it
stands at `de71a38` and by this one, and compared with `cmp` — identical in
every case. Every behavioural change is behind that one environment variable;
the only unconditional edits are three rows in the bundler's tables
(`module`'s specifier and its two conditional files), which no test outside
this corpus reaches, because no other file in Node's `test/parallel` requires
`module` at all.

`builtinModules` and `isBuiltin` nevertheless answer **Node's** list, because
that list is a fact about Node's API: a program asking "is `http` a built-in?"
is asking about Node, not about this bundle. Requiring a built-in that
zun-node has not implemented throws `ERR_ZUN_UNIMPLEMENTED_BUILTIN` rather than
answering an empty object.

## What is implemented

The whole Node 25 surface, with the resolver complete:

* **The builtin registry** — `builtinModules` (Node 25's 73 ids, the five
  scheme-only ones spelled `node:sea`, `node:sqlite`, `node:quic`,
  `node:test`, `node:test/reporters`), `isBuiltin`, and
  `normalizeRequirableId`'s exact rules: `isBuiltin('node:test')` is true,
  `isBuiltin('test')` is false, `isBuiltin('internal/errors')` is false.
* **The resolver** — `Module._resolveFilename` (with `options.paths`, including
  the "resolve each path as if it were a parent" branch),
  `Module._findPath` (`Module._pathCache`, the trailing-slash rule, the
  `insidePath` short-circuit, multi-dot extensions),
  `Module._resolveLookupPaths`, `Module._nodeModulePaths` (both platforms,
  character for character), `Module._initPaths` / `Module.globalPaths`
  (`NODE_PATH`, `$HOME/.node_modules`, `$HOME/.node_libraries`,
  `$PREFIX/lib/node`), `Module._stat`, `tryFile`/`tryExtensions`/`tryPackage`
  with package.json `"main"` and the **DEP0128** warning for a `main` that
  resolves to nothing.
* **The loader** — `Module._load`, `Module._cache`, `Module._extensions`,
  `findLongestRegisteredExtension`, the `node:`-prefix cache bypass, the
  circular-require path, and the `.json` loader in full (BOM stripping,
  `JSON.parse`, Node's `"<filename>: <message>"` error rewrite). A
  user-registered extension (`require.extensions['.foo'] = fn`) is called
  exactly as Node calls it.
* **`require`** — `createRequire` (file URL object, `file:` URL string or
  absolute path, with Node's `ERR_INVALID_ARG_VALUE` message for everything
  else), `require.resolve`, `require.resolve.paths`, `require.cache`,
  `require.extensions`, `require.main`, and the bundled file's own `module`
  record — `module.id`, `module.filename`, `module.path`, `module.paths`,
  `module.children`, `module.exports`, `module.loaded` — which is a top-level
  binding in the bundle, set by the one `__modInitMain()` call the bundler
  emits after `__filename`.
* **Source maps** — `SourceMap` as a complete Source Map v3 reader (the base64
  VLQ decoder, the `mappings` scanner including an index map's `sections`,
  `findEntry`'s binary search, `findOrigin`), `findSourceMap`,
  `setSourceMapsSupport` / `getSourceMapsSupport` with Node's validation.
* **`stripTypeScriptTypes`** — Node's wrapper exactly (the one-shot
  `ExperimentalWarning`, the option validation in Node's order, the
  `//# sourceURL=` tail, the inlined `//# sourceMappingURL=data:` tail) over
  this file's own whitespace-preserving stripper. See
  [the stripper's scope](#the-typescript-stripper).
* **`findPackageJSON`**, **`Module.wrap`** / **`Module.wrapper`**,
  **`syncBuiltinESMExports`**, **`constants`**, and the compile-cache trio
  (`enableCompileCache` reports `FAILED` *with a reason*, `getCompileCacheDir`
  answers `undefined`, `flushCompileCache` is a no-op) — all with honest
  values rather than fabricated ones.
* **Errors** — `MODULE_NOT_FOUND` (a plain `Error`, with Node's
  `Require stack:` tail), `ERR_UNKNOWN_BUILTIN_MODULE`,
  `ERR_INVALID_PACKAGE_CONFIG`, `ERR_REQUIRE_ESM`, `ERR_DLOPEN_FAILED`,
  `ERR_INVALID_ARG_TYPE` / `ERR_INVALID_ARG_VALUE` from `require(1)` and
  `require('')`.

### Deliberate gaps, named

* **`register` and `registerHooks` throw `ERR_METHOD_NOT_IMPLEMENTED`.** Both
  forms of loader hook exist to feed a module *compiler*: a `resolve` hook
  chooses which file a specifier names, a `load` hook hands that file's source
  back to be compiled. There is no runtime compiler here, so a `load` hook
  could never be honoured, and honouring a `resolve` hook on its own would
  quietly change which file a specifier names while still refusing to load it.
* **`Module` is not a constructor.** This engine has no function-constructor or
  prototype model ([zun#25](https://github.com/UrubuCode/zun/issues/25)), so
  `new Module(id, parent)` cannot work; `Module` is a function carrying all of
  Node's statics, module records are plain objects, and `Module.prototype` is
  absent rather than faked.
* **No `exports`-field resolution.** A package whose entry point is declared
  with `"main"` resolves exactly as in Node; one that declares only `"exports"`
  does not, because that step needs the ESM package-exports resolver.
  `#name` package-imports specifiers are the same gap.
* **No circular-require warning proxy.** Node swaps a circularly-required
  module's exports prototype for a `Proxy` that warns on a missing property
  read; a `Proxy` is not reachable here, so the exports object is returned as
  it is.
* **`module.parent` is absent rather than `null`.** Node only has it under
  `--pending-deprecation`, and this runtime honours no command-line flags, so
  answering `null` would claim a flag state it cannot have.

## What cannot work on this platform

The Zun engine compiles a program ahead of execution. There is no runtime
compiler, no `eval` and no `vm`
([zun#4](https://github.com/UrubuCode/zun/issues/4)). So the half of
`node:module` that is *computation over paths and files* is here in full, and
the half that is *turning a source file into a module* is not — and says so
rather than pretending:

| Extension | What happens |
|---|---|
| `.json` | works, completely |
| a user-registered extension | the handler is called, exactly as Node calls it |
| `.js` / `.cjs` / anything unregistered | `ERR_ZUN_NO_RUNTIME_COMPILER` |
| `.mjs`, or a `.js` under `"type": "module"` | `ERR_REQUIRE_ESM` — Node's own error for "this file is an ES module and cannot be required", which is the honest answer here because there is no ESM loader to fall back to either |
| `.node` | `ERR_DLOPEN_FAILED` — a Node addon is a V8 N-API shared object, and there is no V8 isolate to load one into. (The engine's own native extensions are loaded by `zun run --ext`, not by `require`.) |

That one fact accounts for **17 of the 34 failures** below. It is not a bug to
fix in `module.ts`: a `require` that compiles a JavaScript file needs a compiler
in the running process, which is a platform capability rather than a library
one.

## Status and what blocks the rest

[`RESULTS.md`](RESULTS.md) is the live per-test table, with the first line of
stderr for each failure; it and the README bar are regenerated by every tracker
run, so they — not this page — are the current number. As measured on Windows
with the release engine, **20 / 54**.

Every failure below is blocked by the platform, the harness or the engine, not
by a divergence in `module.ts`. The groups:

| Test | Blocked by | What happens |
|---|---|---|
| `test-module-children.js` | no runtime compiler | loads `fixtures/GH-7131/{a,b}.js` to inspect `module.children` |
| `test-module-circular-dependency-warning.js` | no runtime compiler (+ the `Proxy` gap) | loads the `fixtures/cycles/*` pairs |
| `test-module-create-require.js` | no runtime compiler | `createRequire(u)` then `reqToo('./experimental')` loads a `.js` fixture. The three `assert.throws` on `createRequire` itself all pass |
| `test-module-create-require-multibyte.js` | no runtime compiler | same, through two multibyte paths |
| `test-module-loading-deprecated.js` | no runtime compiler | `require('../fixtures/packages/missing-main')` — the DEP0128 warning *is* emitted (verified by probe), but the module behind it cannot load |
| `test-module-multi-extensions.js` | no runtime compiler | the multi-dot lookup this file is about works — `Module._findPath` finds `test-extensions.foo.bar` through a registered `.foo.bar`, and `findLongestRegisteredExtension` hands it to that registered loader. Its last two blocks require a **dotfile** (`.bar`, `.foo.bar`), which Node's own rule resolves to the `.js` loader, and that needs a compiler |
| `test-require-dot.js` | no runtime compiler | `require('.../dot.js').value` |
| `test-require-empty-main.js` | no runtime compiler | `require.resolve(where)` is correct (verified by probe); `require(where)` must answer `42` |
| `test-require-enoent-dir.js` | no runtime compiler | requires two `.cjs` files it wrote |
| `test-require-exceptions.js` | no runtime compiler | `fixtures/throws_error.js` must throw `Error: blah` *from the module body* |
| `test-require-extension-over-directory.js` | no runtime compiler | compares the exports of `inner` and `inner.js` |
| `test-require-extensions-main.js` | no runtime compiler | `require('fixtures/require-bin/bin/req.js')` |
| `test-require-extensions-same-filename-as-dir.js` | no runtime compiler | loads `three.js` |
| `test-require-extensions-same-filename-as-dir-trailing-slash.js` | no runtime compiler | same, one path shape further |
| `test-require-long-path.js` | no runtime compiler | Windows-only; writes and requires two `.js` files |
| `test-require-resolve.js` | no runtime compiler | the three `require.resolve` assertions pass (verified by probe); the test then `require`s `fixtures/require-resolve.js` |
| `test-require-unicode.js` | no runtime compiler | requires a `.js` file under a CJK directory name |
| `test-module-main-fail.js` | no `node` binary | spawns `process.execPath` on a missing entry point and matches its stderr. `process.execPath` is `zun.exe`, which cannot be asked to run a `.js` main |
| `test-module-main-extension-lookup.js` | no `node` binary | same, with an `.mjs` and an extensionless main |
| `test-module-main-preserve-symlinks-fail.js` | no `node` binary | same, with `--preserve-symlinks` |
| `test-module-wrap.js` | no `node` binary | `execFileSync(node, [fixtures/cjs-module-wrap.js])` |
| `test-module-wrapper.js` | no `node` binary | `execFileSync(node, [fixtures/cjs-module-wrapper.js])` |
| `test-module-run-main-monkey-patch.js` | no `node` binary | `spawnSync(node, ['--require', …])` |
| `test-module-loading-globalpaths.js` | no `node` binary | copies the runtime into a scratch `$PREFIX` and runs it with four different `$HOME`s |
| `test-require-invalid-main-no-exports.js` | no `node` binary | `spawnSync(node, [fixtures/package-main-enoent/test.js])` |
| `test-module-readonly.js` | no `node` binary + no runtime compiler | Windows-only; `icacls` through `child_process`, then requires the read-only `.js` module |
| `test-module-parent-deprecation.js` | flags not honoured | needs `--pending-deprecation`, under which `module.parent` is `null` and reading it emits DEP0144. This runtime has no command line to pass a flag on, so `module.parent` is absent and no warning is emitted |
| `test-module-parent-setter-deprecation.js` | flags not honoured | the same flag, through the setter |
| `test-module-prototype-mutation.js` | dynamic `import()` | `import(fixtures.fileURL(…))` — the engine requires a literal string specifier (`SEM0001: import() specifier must be a string`) |
| `test-require-delete-array-iterator.js` | dynamic `import()` | deletes `Array.prototype[Symbol.iterator]`, then `import(...)`; fails earlier, on the deletion (`call did not resolve to a method`) |
| `test-module-print-timing.mjs` | ES module test file | the bundler rewrites CommonJS `require`; this file is `import`-based |
| `test-module-loading-error.js` | no addon loader | `require('../fixtures/module-loading-error.node')` must throw an `Error` whose message is the platform's own dynamic-loader complaint ("is not a valid Win32 application"). The *rest* of the file — the five `require(<non-string>)` type errors, `require('')` and the `MODULE_NOT_FOUND` for a directory — passes |
| `test-module-version.js` | `process.config` | asserts `process.config.variables.node_module_version > 0`. `src/process/process.ts` reports `0`, which is the honest value for a runtime with no Node addon ABI; raising it would be a claim this platform cannot back |
| `test-module-strip-types.js` | engine: `Buffer.from(any)` | the test never reaches its `common.skip`: it fails to **compile**, because `Buffer.from(JSON.stringify(sourceMap))` is a typed intrinsic that rejects an `Any` argument at compile time (`SEM0001: 'Buffer.from' expects a string, array or ArrayBuffer, found Any`) — the same family as [zun#58](https://github.com/UrubuCode/zun/issues/58), where the `nodeBuffer` intrinsics take machine types and an ordinary JavaScript call is therefore a compile error. `Buffer` is a *global* in Node, so the test requires no module the bundler could use as a gate. Beyond that, the file's six transform-mode cases compare against SWC's own byte-exact `mappings` string, which this stripper does not reproduce — see below |

## The TypeScript stripper

`stripTypeScriptTypes` in Node is a thin wrapper over Amaro, which is SWC's
TypeScript stripper compiled to Wasm. The *wrapper* is reproduced exactly. The
stripper underneath it is `module.ts`' own, because there is no Wasm engine to
run SWC in — and what "strip" means is well defined and checkable without a
parser: every byte of type syntax becomes **spaces**, newlines are preserved,
and nothing else moves, so the output is the same length as the input and every
line and column still lines up with the source.

Handled: type annotations on declarations, parameters, class members and return
types; optional `?` markers; non-null `!`; `as` and `satisfies`; generic
parameter lists on declarations; `interface` and `type` declarations; `declare`
statements; `import type` / `export type` and inline `{ type X }` specifiers;
`implements` clauses; the `public` / `private` / `protected` / `readonly` /
`override` / `abstract` modifiers; parameter properties. Rejected with
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, as SWC's strip-only mode rejects them
because erasing them would change what the program does: `enum`, `namespace`
and `module X { … }`.

Four constructs are deliberately **left as written**, with no silent guess:
call-site type arguments (`f<number>(x)`, because `a < b > (c)` is valid
JavaScript and telling the two apart needs backtracking); a labelled statement
sharing a line with a declaration; an object *type* in return position
(`function f(): { a: number } {}`, where the first `{` is read as the body);
and type syntax inside a template interpolation. Each leaves TypeScript in the
output rather than removing the wrong bytes, which is the failure mode a caller
can see.

`mode: 'transform'` is strip plus a **source map**, and the map is the identity
map — which is correct for position-preserving output. It is *not* SWC's
transform, which also lowers `enum` and `namespace` to runtime code; this
stripper rejects those instead. So the six transform-mode cases in
`test-module-strip-types.js`, which compare against SWC's exact `mappings`
string for a `namespace` lowering, cannot pass.

## New engine findings from this work

Two gaps were found here, both with standalone repros, and both worked around
at their use sites in `../../src/module/module.ts`:

1. **A function expression assigned to an expando property of a *function* is
   given a synthetic leading `this` parameter, shifting every argument by one,
   as soon as the token `this` appears anywhere in its source span — comments
   included.** The same assignment onto a plain *object* is unaffected, and a
   named function declaration never shifts. It is the same textual-scan family
   as [zun#40](https://github.com/UrubuCode/zun/issues/40).

   ```ts
   function F(): void {}
   F.a = function (x?: any, y?: any): any { // so does this.
     return "Fa:" + String(x) + "," + String(y);
   };
   F.b = function (x?: any, y?: any): any {
     return "Fb:" + String(x) + "," + String(y);
   };
   console.log(String(F.a(1, 2)));  // zun: "Fa:2,undefined"   node: "Fa:1,2"
   console.log(String(F.b(1, 2)));  // zun: "Fb:1,2"           node: "Fb:1,2"
   ```

   This is why every `Module.<name>` and `require.<name>` in `module.ts` is a
   **named top-level function** assigned to the property rather than a function
   expression written in place. (It cost an afternoon: the shift turned
   `Module._findPath(request, paths, isMain)` into `_findPath(paths, isMain)`,
   which failed on `paths.join` with "join is not a function" — an error about
   a line that was never the problem.)

2. **`Object.defineProperty` on a function value throws
   `TypeError: Object.defineProperty called on non-object`.**

   ```ts
   function f(): void {}
   Object.defineProperty(f, "main", { get(): any { return 42; } });
   // zun: TypeError: Object.defineProperty called on non-object
   // node: fine; f.main === 42
   ```

   This is why `require.main` is a plain property set by one
   `__modInitMain();` call the bundler emits after `__filename`, rather than
   the accessor Node's own `makeRequireFunction` would suggest.

Two further behaviours were confirmed rather than newly found: a class
prototype carries none of the class's own members
([zun#51](https://github.com/UrubuCode/zun/issues/51)), which is why
`SourceMap`'s `payload` and `lineLengths` are declared fields rather than the
accessors Node makes them; and a top-level `let` assigned from a function is
readable from ordinary code but not from a closure passed as an argument, which
is the zun#34 family.

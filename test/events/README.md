# node:events — Node.js compatibility tests

The compatibility bar for `events` is **Node.js 25's own test suite**, not tests
we write. `events` is **not finished** until it passes 100% of Node's
`test-event-emitter-*` and `test-events-*` tests.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module — 35
files, split across two prefixes, which is why the tracker matches a *list* of
patterns for `events` rather than a single one:

```
test-event-emitter-add-listeners.js          test-event-emitter-prepend.js
test-event-emitter-check-listener-leaks.js   test-event-emitter-remove-all-listeners.js
test-event-emitter-emit-context.js           test-event-emitter-remove-listeners.js
test-event-emitter-error-monitor.js          test-event-emitter-set-max-listeners-side-effects.js
test-event-emitter-errors.js                 test-event-emitter-special-event-names.js
test-event-emitter-get-max-listeners.js      test-event-emitter-subclass.js
test-event-emitter-invalid-listener.js       test-event-emitter-symbols.js
test-event-emitter-listener-count.js         test-events-add-abort-listener.mjs
test-event-emitter-listeners-side-effects.js test-events-customevent.js
test-event-emitter-listeners.js              test-events-getmaxlisteners.js
test-event-emitter-max-listeners-warning-for-null.js    test-events-list.js
test-event-emitter-max-listeners-warning-for-symbol.js  test-events-listener-count-with-listener.js
test-event-emitter-max-listeners-warning.js  test-events-on-async-iterator.js
test-event-emitter-max-listeners.js          test-events-once.js
test-event-emitter-method-names.js           test-events-static-geteventlisteners.js
test-event-emitter-modify-in-emit.js         test-events-uncaught-exception-stack.js
test-event-emitter-no-error-provided-to-error-event.js
test-event-emitter-num-args.js
test-event-emitter-once.js
```

`test-eventtarget*.js`, `test-nodeeventtarget.js` and
`test-whatwg-events-eventtarget-*.js` are **out of scope**: EventTarget is an
engine prelude global here, not part of `node:events`, and those files exercise
EventTarget itself rather than any `events` export. `test-events-customevent.js`
is in the corpus by name only — it imports `internal/event_target` and tests
`CustomEvent`, so it is an EventTarget test wearing an `events` file name.

Each file is fetched verbatim from `nodejs/node` at tag `v25.0.0`; nothing is
vendored here.

## How they run

`events` is **not** a `zun_abi` extension. Listener bookkeeping is pure
computation, so it is written in Zun TypeScript (`../../src/events/events.ts`)
and compiled by the platform's own compiler — no `--ext` library, no syscalls.
See `../../PLAN.md`.

```sh
bash tools/run_node_tests.sh --zun <path-to-zun> --module events
```

Each test goes through `tools/bundle_node_test.sh`, which inlines
`src/util/util.ts`, `src/events/events.ts`, `src/process/process.ts`,
`src/assert/assert.ts`, `src/path/path.ts` and `tools/harness/common.ts` ahead of
the test body, injects `__filename` / `__dirname`, rewrites the `require` lines,
and appends one statement — `__zunHarnessFinish();` — that settles the event
loop, emits `process` 'exit' and verifies the `common.mustCall` counts. The
mechanism is documented at the top of `tools/harness/common.ts`.

**`events` was taken ahead of `os`** (PLAN.md's order is `fs → process → path →
os → events → …`) for a hard dependency reason: Node's `process` *is* an
EventEmitter, and the harness cannot verify a single `common.mustCall` count
without `process.on('exit')`, `process.on('warning')` and `process.nextTick`.
Those needed `events` first, so `events` moved up and
`src/process/process.ts` grew its EventEmitter surface in the same pass.

## What is implemented

`src/events/events.ts` carries the whole documented surface:

* **EventEmitter**: `on`/`addListener`, `prependListener`, `once`,
  `prependOnceListener`, `off`/`removeListener`, `removeAllListeners`, `emit`
  (with the `error` / `errorMonitor` / `ERR_UNHANDLED_ERROR` semantics),
  `listeners`, `rawListeners`, `listenerCount` (with the optional listener
  argument), `eventNames` (strings and symbols), `setMaxListeners`,
  `getMaxListeners`, the `newListener` / `removeListener` meta-events, the
  MaxListenersExceededWarning through `process.emitWarning`, and
  `captureRejections` with the rejection handler key.
* **Module statics**: `once` (promise, with AbortSignal), `on` (async iterator
  with `next`/`return`/`throw` and the watermark options), `getEventListeners`,
  `getMaxListeners`, `setMaxListeners`, `listenerCount`, `addAbortListener`,
  `errorMonitor`, `captureRejectionSymbol`, `defaultMaxListeners`,
  `usingDomains`, `EventEmitter.EventEmitter`.
* Listener storage is **null-prototype-safe**: `_events` is
  `Object.create(null)`, so `__proto__`, `toString` and `__defineGetter__` are
  ordinary event names (Node's CVE lesson), and `test-event-emitter-special-event-names.js`
  passes.

**Not implemented, by capability:** `EventEmitterAsyncResource` needs
`async_hooks`, which the engine does not have — there is nothing to build it on,
so it is absent rather than faked. `usingDomains` is the constant `false`,
because `node:domain` needs async_hooks too.

## Status and what blocks the rest

[`RESULTS.md`](RESULTS.md) is the live per-test table, with the first line of
stderr for each failure; it and the README bar are regenerated by every tracker
run, so they — not this page — are the current number.

The module itself is exercised by a differential self-test covering every method,
both meta-events, the error paths, the warning text and the storage shapes; it
passes clean. **Every remaining test failure is blocked in the engine or in a
module outside this one**, in one of nine distinct ways:

| Test | Blocked by | What happens |
|---|---|---|
| `test-event-emitter-check-listener-leaks.js`, `test-event-emitter-max-listeners.js`, `test-event-emitter-max-listeners-warning-for-null.js`, `test-event-emitter-max-listeners-warning-for-symbol.js`, `test-event-emitter-modify-in-emit.js`, `test-event-emitter-num-args.js`, `test-event-emitter-remove-all-listeners.js`, `test-event-emitter-set-max-listeners-side-effects.js`, `test-event-emitter-no-error-provided-to-error-event.js` | **member `new`** — [zun#18](https://github.com/UrubuCode/zun/issues/18) | `new events.EventEmitter()` does not compile: `new <expr>(...)` is accepted only for a statically known class identifier or a `Proxy`-typed expression, and a member expression is neither (`new (expr)(...) requires a Proxy-typed expression`). Nine tests use that spelling and nothing in the library can change it. |
| `test-event-emitter-get-max-listeners.js`, `test-event-emitter-error-monitor.js`, `test-event-emitter-listener-count.js` | **class statics** — [zun#20](https://github.com/UrubuCode/zun/issues/20) | `EventEmitter` must be a class (so `new EventEmitter()` compiles), but a class static *field* reads back as `undefined`, assigning a property to a class panics the interpreter, and a static *method* may not share a name with an instance method (`instance method 'once' must be called through an object`). So `EventEmitter.defaultMaxListeners`, `EventEmitter.errorMonitor`, `EventEmitter.once(...)` and `EventEmitter.listenerCount(...)` are unreachable; the same values are reachable through the module object. |
| `test-event-emitter-add-listeners.js`, `test-event-emitter-emit-context.js`, `test-event-emitter-method-names.js`, `test-event-emitter-once.js`, `test-events-once.js` | **no receiver threading** — [zun#1](https://github.com/UrubuCode/zun/issues/1); **methods not readable as values** — [zun#19](https://github.com/UrubuCode/zun/issues/19) | `f.apply(thisArg, args)` / `f.call(...)` do not bind a receiver at all ([zun#1](https://github.com/UrubuCode/zun/issues/1) — the intrinsic prepends `thisArg` as a positional slot), so `this` inside a listener is always `undefined` and `EventEmitter.prototype.emit.apply(ee, args)` cannot work. A method also cannot be *read* as a value (`ee.on` is `undefined`, `E[name].name` is unreachable), (Assigning a new property to a typed class instance works through an `any` alias; only the uncast write is rejected, which is correct TypeScript.) |
| `test-event-emitter-listeners.js`, `test-event-emitter-max-listeners-warning.js` | **class bases** — [zun#21](https://github.com/UrubuCode/zun/issues/21) | `class TestStream extends events.EventEmitter {}` — a class base must be a plain identifier (`OXC adapter supports identifier class bases only`), and a member expression is not one. |
| `test-event-emitter-subclass.js` | **no prototype model** — [zun#25](https://github.com/UrubuCode/zun/issues/25) | `Object.setPrototypeOf(MyEE.prototype, EventEmitter.prototype)` plus `new MyEE()` over a `function` constructor. The engine has typed classes and no `function.prototype` construction model, so `new <function>()` is rejected outright. |
| `test-events-list.js` | **symbol identity** — [zun#23](https://github.com/UrubuCode/zun/issues/23) | `s === s` is `false` for every symbol in this engine, so `assert.deepStrictEqual(['foo', s], EE.eventNames())` compares two readings of the same symbol and fails. Symbol-keyed properties are distinct per symbol; only `===` (the interpreter's `cmp`) lacks a symbol case. |
| `test-event-emitter-invalid-listener.js` | **computed call on a typed instance** — [zun#24](https://github.com/UrubuCode/zun/issues/24) | `const ee = new EventEmitter(); ee[method]('foo', null);` — a computed member *call* on a statically typed class instance resolves to `undefined` unless the key is a literal the checker can fold. The four `on`/`once`/`removeListener`/`prependOnceListener` throws are each correct when written with a literal key. |
| `test-event-emitter-remove-listeners.js`, `test-event-emitter-method-names.js` | **bare `return;`** — [zun#22](https://github.com/UrubuCode/zun/issues/22) | a function expression whose inferred return type is `Any` is rejected when it also contains a bare `return;` (`expected a Any return value`); both files have a listener shaped `function(name, cb) { if (…) return; … }`. |
| `test-event-emitter-listeners-side-effects.js` | **callable `assert`** | the file opens with `assert(Array.isArray(fl))` — the bare `assert(...)` form needs a function that also carries `strictEqual` & co., which [zun#14](https://github.com/UrubuCode/zun/issues/14) makes impossible. It additionally asserts `!(e._events instanceof Object)`, which is `true` here because a null-prototype object still reports `instanceof Object` ([zun#26](https://github.com/UrubuCode/zun/issues/26)). |
| `test-events-customevent.js`, `test-events-on-async-iterator.js`, `test-events-static-geteventlisteners.js` | **`internal/` modules** | these require `internal/event_target` (`kEvents`, `kWeakHandler`, `NodeEventTarget`). Those are Node-internal bindings, not a public module; the bundler reports an unresolved require and fails the bundle rather than guessing. |
| `test-event-emitter-prepend.js` | **`node:stream`** | its tail builds a `Writable`/`Readable` pair over `stream.Stream`. `stream` is its own library in PLAN.md's order. |
| `test-events-uncaught-exception-stack.js` | **no `uncaughtException`** | needs a process-level uncaught-exception hook and a Node-shaped `err.stack`; the engine has neither, and a hook cannot be installed from library code. |
| `test-events-add-abort-listener.mjs` | **ESM + `node:test`** | the only `.mjs` file in the corpus: `import` is not supported by the engine (`unsupported statement ImportDeclaration`), and it also needs `node:test`'s `describe`/`it` and `Symbol.dispose`. |

Uncaught errors are printed as `Object(Obj(0x…))`
([zun#8](https://github.com/UrubuCode/zun/issues/8)), which is why the "Why"
column in `RESULTS.md` is often opaque; `assert` prints the failure to stderr
before throwing to compensate.

### Engine workarounds carried by `events.ts`

None of these block a test — they are what makes the module work at all, and each
is marked at its use site:

* a function stored in an array arrives as a `functionBox` record, so
  `[fn][0] === fn` is `false` and `typeof [fn][0]` is `"object"`
  ([zun#17](https://github.com/UrubuCode/zun/issues/17)). The record's
  `__boxedFn` slot reads the callable back with its identity intact, so
  `__evUnbox` / `__evSame` / `__evIsFn` restore `===` for functions — in
  `events.ts`, in `assert.ts`'s comparisons, and in the harness.
* a function **returned** from an object-literal method is `null` and from a
  class method is `undefined`. `common.mustCall()` is exactly that shape, so the
  harness hands back the *boxed* wrapper (`__evBox`), which is an object and
  survives the return.
* a function **assigned under a symbol key** is silently dropped, so a
  symbol-keyed slot stores the boxed form.
* a function-valued property is invisible to `Object.keys`/`Object.hasOwn`, so
  the event-name order is tracked in `__evTypes` beside `_events`.
* `delete obj[sym]` throws, and `delete` does not clear a function-valued
  property; writing `undefined` is the only clear that works for both.
* a function written over a property that currently holds `undefined` is shadowed
  by that `undefined` ([zun#32](https://github.com/UrubuCode/zun/issues/32)), so every such write deletes first (`__evRawSet`).
* a class method's rest parameter is not an array (`undefined` with no rest
  arguments, the bare value with one, and `.length` then panics), and
  `arguments` is unavailable in a class method, so `emit` is spelled with ten
  explicit optional slots and trims the trailing `undefined`s ([zun#11](https://github.com/UrubuCode/zun/issues/11)).
* `Array.prototype.unshift` rejects a function argument, so `prependListener`
  rebuilds the list ([zun#17](https://github.com/UrubuCode/zun/issues/17)).
* `WeakMap` accepts only object values ([zun#28](https://github.com/UrubuCode/zun/issues/28)) and `Map.get` through an `any`
  binding throws ([zun#7](https://github.com/UrubuCode/zun/issues/7)),
  so the EventTarget side tables are parallel arrays with a linear scan.
* `splice`'s start index must be an integer, which only an `any`-typed array
  receiver accepts; array-held flags such as `warned` likewise need an `any`
  receiver.
* a numeric class field declared without an initializer panics the interpreter at
  construction ([zun#27](https://github.com/UrubuCode/zun/issues/27)), so every `number` field carries one.
* `Number(x.length)` throughout, because `.length` is a u64
  ([zun#3](https://github.com/UrubuCode/zun/issues/3)).

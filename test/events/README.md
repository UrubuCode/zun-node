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
  passes. It briefly stopped passing, not over storage but over
  [zun#37](https://github.com/UrubuCode/zun/issues/37): `new EventEmitter()`
  attached the `captureRejections` flag under a key the class had not declared,
  through an `any` alias, which poisoned the instance so that the test's very
  first `ee._events` read threw `Cannot read private member from an object whose
  class did not declare it`. The flag is a declared field now.

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
| `test-event-emitter-check-listener-leaks.js`, `test-event-emitter-max-listeners.js`, `test-event-emitter-max-listeners-warning-for-null.js`, `test-event-emitter-max-listeners-warning-for-symbol.js`, `test-event-emitter-modify-in-emit.js`, `test-event-emitter-num-args.js`, `test-event-emitter-remove-all-listeners.js`, `test-event-emitter-set-max-listeners-side-effects.js`, `test-event-emitter-no-error-provided-to-error-event.js` | **member `new`** — [zun#18](https://github.com/UrubuCode/zun/issues/18) | `new events.EventEmitter()` *compiles* now — the checker used to reject it with `new (expr)(...) requires a Proxy-typed expression` — but the member read answers `undefined` at run time (`undefined is not a function`), because a class is invisible through a module object the same way a static is invisible through a class value ([zun#20](https://github.com/UrubuCode/zun/issues/20)). Nine tests use that spelling and nothing in the library can change it. |
| `test-event-emitter-get-max-listeners.js`, `test-event-emitter-error-monitor.js`, `test-event-emitter-listener-count.js` | **class statics** — [zun#20](https://github.com/UrubuCode/zun/issues/20); **no prototype model** — [zun#25](https://github.com/UrubuCode/zun/issues/25) | half of #20 is fixed: a class static *field* now reads back and can be assigned, so `EventEmitter.defaultMaxListeners`, `EventEmitter.errorMonitor` and `EventEmitter.captureRejectionSymbol` are real statics in `events.ts` and resolve. What remains blocks all three files anyway — a static *method* may not share a name with an instance method (`duplicate method 'once'`), so `EventEmitter.once(...)` and `EventEmitter.listenerCount(...)` are still reachable only through the module object; and `get-max-listeners` additionally needs `EventEmitter.prototype.on.call(recv, …)`, which wants a `prototype` (#25), a method readable as a value ([zun#19](https://github.com/UrubuCode/zun/issues/19)) and `call` to thread a receiver ([zun#1](https://github.com/UrubuCode/zun/issues/1)). |
| `test-event-emitter-add-listeners.js`, `test-event-emitter-emit-context.js`, `test-event-emitter-method-names.js`, `test-event-emitter-once.js`, `test-events-once.js` | **no receiver threading** — [zun#1](https://github.com/UrubuCode/zun/issues/1); **methods not readable as values** — [zun#19](https://github.com/UrubuCode/zun/issues/19) | `f.apply(thisArg, args)` / `f.call(...)` do not bind a receiver on a plain function value, and `apply` prepends `thisArg` as a positional slot there — `f.apply(recv, [a, b])` arrives as `f(recv, a)`, re-measured on this build — so `this` inside a listener is always `undefined` and `EventEmitter.prototype.emit.apply(ee, args)` cannot work. An object-literal **method** is the one shape that gets both right, which is why the library's own call sites use `fn(...args)` and never `apply`. `f.call(recv, a, b)` is not even accepted: ```call` on a dynamic function value expects exactly one `this` argument``. A method also cannot be *read* as a value (`ee.on` is `undefined`, `E[name].name` is unreachable), (Assigning a new property to a typed class instance works through an `any` alias; only the uncast write is rejected, which is correct TypeScript.) |
| `test-event-emitter-listeners.js`, `test-event-emitter-max-listeners-warning.js` | **class bases** — [zun#21](https://github.com/UrubuCode/zun/issues/21) | `class TestStream extends events.EventEmitter {}` — a class base must be a plain identifier (`OXC adapter supports identifier class bases only`), and a member expression is not one. |
| `test-event-emitter-subclass.js` | **no prototype model** — [zun#25](https://github.com/UrubuCode/zun/issues/25) | `Object.setPrototypeOf(MyEE.prototype, EventEmitter.prototype)` plus `new MyEE()` over a `function` constructor. The engine has typed classes and no `function.prototype` construction model, so `new <function>()` is rejected outright. |
| `test-event-emitter-invalid-listener.js` | **computed call on a typed instance** — [zun#24](https://github.com/UrubuCode/zun/issues/24) | `const ee = new EventEmitter(); ee[method]('foo', null);` still answers `undefined is not a function`. #24 is partly fixed — the same call routed through an `any` alias (`(ee as any)[method](…)`) resolves now — but an *uncast* statically typed receiver does not, and that is the spelling the test uses. The four `on`/`once`/`removeListener`/`prependOnceListener` throws are each correct when written with a literal key, message and `code` included. |
| `test-event-emitter-remove-listeners.js`, `test-event-emitter-method-names.js` | **bare `return;`** — [zun#22](https://github.com/UrubuCode/zun/issues/22) | a function expression whose inferred return type is `Any` is rejected when it also contains a bare `return;` (`expected a Any return value`); both files have a listener shaped `function(name, cb) { if (…) return; … }`. |
| `test-event-emitter-listeners-side-effects.js` | **null-prototype object is `instanceof Object`** — [zun#26](https://github.com/UrubuCode/zun/issues/26) | the bare `assert(...)` form is no longer a blocker: [zun#14](https://github.com/UrubuCode/zun/issues/14) is fixed and `assert.ts` is a real callable carrying the methods. What is left is one line — `assert(!(e._events instanceof Object))` — and `Object.create(null) instanceof Object` answers `true` here. Everything after it already holds: `e._events.foo === assert.fail`, the function→array promotion, both element identities and `Object.keys(e._events)` were each verified by hand against this build. |
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
is marked at its use site. Every entry below was re-probed against the current
engine; the ones that were fixed are listed after the table.

* a function stored in an array still arrives as a `functionBox` record and
  `[fn].indexOf(fn)` still answers `-1` for a bare one
  ([zun#17](https://github.com/UrubuCode/zun/issues/17)) — though
  `[fn][0] === fn` is `true`. What changed is `typeof`: a box reports
  `"function"` now rather than `"object"`, so `__evUnbox` / `__utilUnbox` /
  `__unboxFn` / `__testCall` probe the `__boxedFn` slot for **both** kinds. That
  one guard is what broke `util.inspect`: a record left unopened is tagged
  `[object Object]` exactly like a class, so every ordinary function printed as
  `[class (anonymous)]`.
* a bare function **loses its own properties** on the way into an array, while a
  box keeps them — which is why a once-wrapper is still boxed: `__evBox` is what
  carries `.listener` and what `indexOf` can find.
* a function **returned** from an object-literal method is still not the
  callable: the caller gets an opaque object that no longer compares equal to
  the original. `common.mustCall()` is exactly that shape, so the harness hands
  back the *boxed* wrapper (`__evBox`), which survives the return. (A function
  returned from a **class** method, or from a plain function, keeps its
  identity.)
* a **symbol** key is still invisible to `Object.getOwnPropertySymbols` and
  `sym in obj` still throws `Cannot convert a Symbol value to a string`
  ([zun#32](https://github.com/UrubuCode/zun/issues/32)), so the event-name
  order is tracked in `__evTypes` beside `_events`. String keys are visible to
  `Object.keys`, `getOwnPropertyNames`, `Reflect.ownKeys`, `for-in` and
  `getOwnPropertyDescriptor` in insertion order, function-valued ones included;
  `obj.hasOwnProperty(k)` and `Object.entries` are the two that still miss them.
* `delete obj[sym]` is rejected by the checker outright — "`delete obj[k]`
  requires a string key" — so a symbol slot is blanked with `undefined`. A string key needs
  no special case: `delete` clears a function-valued property now (#32).
* **new, and a regression:** a computed read with a *variable* key resolves
  `Object.prototype`'s members even on a null-prototype object. `_events[type]`
  answered `Object.prototype.toString` for the event name `toString`, so
  `on('toString', fn)` saw a listener already in the slot and stored a
  two-element list — which is what cost
  `test-event-emitter-special-event-names.js` its pass. The same read with a
  *literal* key is correct, and `in` reports the truth, so `__evRawGet` asks it
  first.
* **new, and a regression:** `events.__proto__ = value` sets the **prototype**
  of a null-prototype object instead of creating an own property, so the slot
  for an event named `__proto__` is lost. A bare callable happens to take the
  ordinary path; every other value (a listener array, a boxed once-wrapper) is
  installed with `Object.defineProperty`, which is exact. The two paths cannot be
  merged: `defineProperty` with a bare callable stores nothing readable.
* `Array.prototype.splice`'s start index must be an integer, which only an
  `any`-typed array receiver accepts; array-held flags such as `warned` likewise
  need an `any` receiver.
* `WeakMap` is still unusable, and worse than before:
  `new WeakMap().set(key, 1)` aborts the VM outright with `call did not resolve
  to a method`, which no `try`/`catch` can contain
  ([zun#28](https://github.com/UrubuCode/zun/issues/28)), so the EventTarget side
  tables keep their keys alive. They are real `Map`s.
* `apply`/`call` still thread no receiver into a function value
  ([zun#1](https://github.com/UrubuCode/zun/issues/1)), so a listener is invoked
  as `fn(...args)` through `__evCall` and `this` inside it is `undefined`. The
  argument-shifting half of #1 is **not** fixed either, contrary to what this
  page said before: `f.apply(recv, [a, b])` reaches a plain function value as
  `f(recv, a)`. Only an object-literal **method** gets both right.
* `Number(x.length)` throughout, because the checker still types `.length` as
  `u64` ([zun#3](https://github.com/UrubuCode/zun/issues/3)) even though its
  arithmetic was widened.
* `EventEmitter` **declares** `__zunEventsCapture` instead of attaching it,
  because an undeclared key written onto a typed instance through an `any` alias
  poisons every later statically typed read of that instance
  ([zun#37](https://github.com/UrubuCode/zun/issues/37)).

Nine workarounds were **removed**, because the engine fixed what forced them:

| Was | Now | Fixed by |
|---|---|---|
| `emit` spelled with ten explicit optional slots and the trailing `undefined`s trimmed | `emit(type, ...args)`, as Node spells it — so `emit('x', undefined)` is a one-argument emit again and an emit may carry more than ten arguments | a rest parameter is a real array everywhere now — in a class method, through an `any` binding, and called on an `any` receiver ([zun#11](https://github.com/UrubuCode/zun/issues/11), which measures as fixed on this build) |
| a symbol-keyed slot always held an **array**, even for a single listener, and `__evRawSet` deleted the key before every write | Node's own shape under a symbol key too (`_events[sym] === listener` while there is one), and a plain assignment | a function value under a symbol key round-trips, and a function written over a slot that holds an object is no longer swallowed ([zun#32](https://github.com/UrubuCode/zun/issues/32), two of its three parts) |
| `__evRawDelete` blanked a function-valued string key with `undefined`, because `delete` would not clear it | `delete events[type]` for every string key | `delete` clears a function-valued property (#32) |
| the surface `assert` was a plain object, so Node's bare `assert(value)` form was unreachable | `src/assert/assert.ts` is a **function** carrying the methods, as `lib/assert.js` exports it | a function can carry callable properties and they resolve from module scope, nested functions, closures and `any` parameters ([zun#14](https://github.com/UrubuCode/zun/issues/14)) |
| `prependListener` rebuilt the list and copied the `warned` flag across | `list.unshift(listener)` | `unshift` accepts a function argument ([zun#17](https://github.com/UrubuCode/zun/issues/17)) |
| `EventEmitter.defaultMaxListeners` / `.errorMonitor` / `.captureRejectionSymbol` reachable only through the module object | real class statics, and `defaultMaxListeners` is the single storage location both spellings write | static fields read back and can be assigned ([zun#20](https://github.com/UrubuCode/zun/issues/20), partly) |
| `__evKeyId` keyed `__evTypes` by a symbol's *description*, which merged two `Symbol('x')`s | plain identity (`types.indexOf(type)`) | `s === s`, distinct descriptions stay distinct, and `_events[sym]` keys by identity ([zun#23](https://github.com/UrubuCode/zun/issues/23)) |
| `captureRejectionSymbol` was a plain `Symbol`, unreachable from a caller | `Symbol.for('nodejs.rejection')`, as in Node | the symbol registry round-trips (#23) |
| the EventTarget side tables were two parallel arrays with a linear scan | real `Map`s behind the same three accessors | a `Map` keeps its methods through an `any` binding ([zun#7](https://github.com/UrubuCode/zun/issues/7)) |

A tenth is no longer *required*: a class field declared without an initializer
no longer panics the interpreter
([zun#27](https://github.com/UrubuCode/zun/issues/27) — it reads back a typed
zero). The explicit initializers stay, because they are what the code means.

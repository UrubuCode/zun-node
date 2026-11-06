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
* **`EventEmitter.prototype`** — the real object, with Node's own shape:
  `constructor`, the three bookkeeping defaults (`_events`, `_eventsCount`,
  `_maxListeners`) and every instance method, each one reachable *and callable
  with a receiver*. `EventEmitter.prototype.on.call(plainObject, 'x', fn)`,
  `EventEmitter.prototype.emit.apply(ee, args)` and
  `EventEmitter.prototype.constructor.name` all work, `E.on === E.addListener`
  and `E.off === E.removeListener` hold, and `E.addListener.name` is
  `"addListener"`. See the section below for why every entry has to be an
  object-literal method.
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
* An event name that is not a symbol goes through **ToPropertyKey**, as it does
  in Node: `ee.on(123, fn)` occupies the slot `"123"`, `ee.emit(123)` finds it
  and `ee.eventNames()` answers `["123"]` — in Node's own key order, integer-like
  keys first. That needs `__evKeyOf` on every slot key, because a **function**
  stored under a *numeric* computed key is dropped by this engine (see the
  workaround list below).

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
module outside this one.** Each row below was re-probed against this engine
build with a standalone snippet, so the blocker named is the one that actually
fires first.

| Test | Blocked by | What happens |
|---|---|---|
| `test-event-emitter-add-listeners.js` | **a class method read as a value has no identity** — [zun#19](https://github.com/UrubuCode/zun/issues/19) | the first line is `assert.strictEqual(ee.addListener, ee.on)`. Half of #19 is fixed: `ee.on` *is* readable off a typed instance now and answers a callable rather than `undefined`. What is missing is identity — each read mints a fresh value, so `ee.on === ee.addListener` is `false` and so is `ee.on === EventEmitter.prototype.on`. Node has one function object under both names. The rest of the file additionally wants `this.listeners('hello')` inside a `newListener` listener, which is [zun#1](https://github.com/UrubuCode/zun/issues/1) below. |
| `test-event-emitter-check-listener-leaks.js` | **`delete` is a no-op on an array's non-index property** (new, reported with this work) | the file runs clean up to one line, `delete e._events.fortytwo.warned`. `warned` is a property of the listener **array**, as in Node, and `delete arr.warned` silently does nothing there while `Reflect.deleteProperty(arr, 'warned')` and `delete obj.warned` on a plain object both work. `Object.hasOwn` therefore still reports the flag and the next assertion fails. Every check before it, the symbol-keyed slot, the per-emitter and process-wide limits and the `warned` promotion were each verified by hand against this build. |
| `test-event-emitter-emit-context.js` | **`call` on a class method cannot take a foreign receiver or a rest parameter** — [zun#1](https://github.com/UrubuCode/zun/issues/1) | `EE.emit.call(ctx, 'error', new Error('foo'))` is rejected by the checker twice over: `argument type DynamicObject does not match Instance(…)` — the implicit `this` parameter of a class method is typed as that class, so a plain object may not be the receiver — and `argument type Instance(…) does not match Array`, because `call` matches the arguments positionally against `(type, ...args)` instead of collecting the tail. A class method *can* be `.call`ed with a plain object when the arity matches exactly (probed), so this is the rest-parameter half plus the receiver type, not the whole of #1. |
| `test-event-emitter-error-monitor.js` | **a boxed function handed to `Promise.prototype.then` is ignored** — [zun#71](https://github.com/UrubuCode/zun/issues/71) | the whole error-monitor contract now works — the monitor fires for every `error`, before the throw and before the `error` listener, and not for other events, and `events.once(EE, 'notTriggered')` rejects with the error. The file's last line is `assert.rejects(…).then(common.mustCall())`, and `common.mustCall()` is necessarily a `functionBox` record (see `tools/harness/common.ts`: a function cannot be returned out of an object-literal method, re-probed here). `then` drops such a handler without calling it, so the count stays 0. The one-line repro is `Promise.resolve(1).then(common.mustCall())`. |
| `test-event-emitter-invalid-listener.js` | **computed call on a typed instance** — [zun#24](https://github.com/UrubuCode/zun/issues/24) | `const ee = new EventEmitter(); ee[method]('foo', null);` answers `undefined is not a function` for all four of `on`/`once`/`removeListener`/`prependOnceListener`. #24 is partly fixed — the same call routed through an `any` alias resolves — but an *uncast* statically typed receiver does not, and that is the spelling the test uses. The four throws are each correct, message and `code` included, when written with a literal key. |
| `test-event-emitter-listeners-side-effects.js`, `test-event-emitter-set-max-listeners-side-effects.js` | **a null-prototype object is `instanceof Object`** — [zun#26](https://github.com/UrubuCode/zun/issues/26) | both files open with `assert(!(e._events instanceof Object))`, and `Object.create(null) instanceof Object` answers `true` here. Everything after that line already holds in both files: `e._events.foo === assert.fail`, the function→array promotion, both element identities, `Object.keys(e._events)` before and after `setMaxListeners(5)`. |
| `test-event-emitter-no-error-provided-to-error-event.js` | **`node:domain`** | `domain.create()`, `d.add(e)` and the domain's `error` handler receiving a synthesized `Error` for `e.emit('error')`. `node:domain` is its own library. |
| `test-event-emitter-prepend.js` | **no function-constructor model** — [zun#25](https://github.com/UrubuCode/zun/issues/25) | nothing in the file runs: the tail builds `function Writable()` / `function Readable()` and wires them with `Object.setPrototypeOf(Writable.prototype, stream.Stream.prototype)`. `new <function>()` is rejected outright and a function has no `prototype`, so the bundle does not even load (the two names collide with `stream`'s own exports, which is the error you see — the cause is one layer down). |
| `test-event-emitter-remove-all-listeners.js`, `test-event-emitter-remove-listeners.js` | **no receiver threading into a plain function** — [zun#1](https://github.com/UrubuCode/zun/issues/1); **`bind` is missing** — [zun#17](https://github.com/UrubuCode/zun/issues/17) | both files drive the `removeListener` meta-event from *inside* a listener through `this`: `this.removeListener('quux', remove2)`, `this.emit('quux')`, `this.listeners('baz').length`. Node calls a listener with the emitter as `this`; here a listener is invoked as `fn(...args)` because nothing threads a receiver into a plain function value — `f.call(recv, a, b)` and `f.apply(recv, [a, b])` now deliver the *arguments* correctly (that half of #1 is fixed) but leave `this` undefined, and `Reflect.apply` prepends the receiver as a positional slot instead. `remove-all-listeners` additionally wants `ee.removeAllListeners.bind(ee, 'foo')`, and `bind` is not a method on a function value (`bind is not a function`). |
| `test-event-emitter-subclass.js` | **no function-constructor model** — [zun#25](https://github.com/UrubuCode/zun/issues/25) | `Object.setPrototypeOf(MyEE.prototype, EventEmitter.prototype)` plus `new MyEE()` over a `function` constructor, three times over. `EventEmitter.prototype` is a real object now and would be a usable target; the `MyEE` side is what the engine has no model for. |
| `test-events-add-abort-listener.mjs` | **ESM** — [zun#4](https://github.com/UrubuCode/zun/issues/4); **`Symbol.dispose`** | the only `.mjs` file in the corpus. The bundler rewrites `require`, not `import`, and the engine reads `import * as events from 'node:events'` as an *extension* import that resolves to nothing. `Symbol.dispose` is `undefined` here too, and the file is six `assert.strictEqual(typeof disposable[Symbol.dispose], 'function')` checks. |
| `test-events-customevent.js`, `test-events-on-async-iterator.js`, `test-events-static-geteventlisteners.js` | **`internal/event_target`** and the host `EventTarget`'s internals | these require `internal/event_target` for `Event`, `EventTarget`, `CustomEvent`, `NodeEventTarget`, `kEvents` and `kWeakHandler`, and the bundler reports an unresolved require rather than guessing. A harness module would not make them pass: `EventTarget`, `Event` and `CustomEvent` are *engine prelude classes* here and a user declaration of any of those names is rejected as a `duplicate class`, so the host implementation cannot be replaced — and it exposes no listener reader, which is exactly what `getEventListeners(target, type)` and `signal[kEvents].get('abort').size` ask for. (What *can* be built on it is `class NodeEventTarget extends EventTarget`, which compiles and dispatches; it is the introspection that is missing, not the subclass.) |
| `test-events-once.js` | **an instance method may not be overwritten, and a typed instance may not grow a field** | `prioritizesEventEmitter()` opens with `ee.addEventListener = fail; ee.removeAllListeners = fail;` — `no field or setter 'addEventListener' on this type` for the first (an undeclared key on a typed instance) and the same for the second (assigning over a method). Further down, `signal.addEventListener('abort', cb, { once: true })` on a prelude `AbortSignal` is `` `addEventListener` expects 2 to 2 argument(s), found 3 `` — the host signal's listener method takes no options, where the prelude `EventTarget`'s does. |
| `test-events-uncaught-exception-stack.js` | **no `uncaughtException` hook** | needs a process-level uncaught-exception hook and a Node-shaped `err.stack`; the engine has neither, and a hook cannot be installed from library code ([zun#74](https://github.com/UrubuCode/zun/issues/74) is the `stack` half). |

Uncaught errors are printed as `Object(Obj(0x…))`
([zun#8](https://github.com/UrubuCode/zun/issues/8)), which is why the "Why"
column in `RESULTS.md` is often opaque; `assert` prints the failure to stderr
before throwing to compensate.

### How `EventEmitter.prototype` is built, and why

Node's `EventEmitter.prototype` is a documented object, and three spellings in
Node's own corpus go through it. This engine's class prototype carries neither
`constructor` nor the class's methods
([zun#51](https://github.com/UrubuCode/zun/issues/51)) — but the object itself is
real, stable (`K.prototype === K.prototype`), writable, and is what
`Object.getPrototypeOf(instance)` answers, so Node's shape is installed onto it
at module load.

The **shape of each entry is the whole trick**, and only one shape works:

* a plain function value threads no receiver, so `f.call(recv, …)` leaves `this`
  undefined (zun#1);
* a function held in a *class static field* cannot be called at all;
* an **object-literal method** — `{ on(type, listener) { … } }` — is the one
  callable this engine threads a receiver into. `m.call(recv, a, b)` and
  `m.apply(recv, [a, b])` bind `this` to `recv` **and** pass the arguments
  through, and the value keeps doing so after being read out of the literal and
  stored in a property of the prototype.

So every prototype entry is an object-literal method whose body forwards `this`
to the same free function (`__evAddListener`, `__evEmit`, `__evRemoveListener`,
…) the class method calls: the class and the prototype are two spellings of one
implementation, never two implementations. `listenerCount` was the one method
whose body lived only inside the class; it is now the free function
`__evListenerCountOf`, which both spellings call.

Each method value also carries its own `name`, because a function's `name` is
otherwise unavailable here (zun#25) and `test-event-emitter-method-names.js`
asserts `E[name].name === name` for every function on the prototype. `on` and
`off` are *aliases* of the `addListener` and `removeListener` values, exactly as
`lib/events.js` assigns them — which is why `E.on === E.addListener` holds and
why `E.on.name` is `"addListener"` in Node too.

### The one bundler rewrite this module needs

Five of `events`' module statics share a name with an `EventEmitter` *instance*
method — `once`, `on`, `listenerCount`, `getMaxListeners`, `setMaxListeners` —
and this engine will not let one class carry both (`duplicate method 'once'`),
nor resolve `EventEmitter.once(…)` to anything but the instance method
(`instance method 'once' must be called through an object`). Putting the
instance methods on a base class removes the duplicate-declaration error but
makes the *static* win for both spellings, so it is worse.

In Node the two spellings are **literally the same function**: `lib/events.js`
is `module.exports = EventEmitter` with `EventEmitter.once = once` and
`exports.once = once`, so
`require('events').once === require('events').EventEmitter.once`.
`tools/bundle_node_test.sh` therefore rewrites `EventEmitter.<name>(` to
`__node_events.<name>(` for exactly those five names — the same kind of
lane-changing rewrite the file already makes for `stream.Readable` → `Readable`
(zun#18). The match requires the call parenthesis immediately after the name, so
`EventEmitter.prototype.on.call(…)` and `EventEmitter.defaultMaxListeners` are
left as written. It is what `test-event-emitter-error-monitor.js`,
`test-event-emitter-listener-count.js` and `test-event-emitter-max-listeners.js`
need, and the last two pass because of it.

### Engine workarounds carried by `events.ts`

None of these block a test — they are what makes the module work at all, and each
is marked at its use site. Every entry below was re-probed against the current
engine; the ones that were fixed are listed after the table.

* a function stored in an array still arrives as a `functionBox` record and
  `[fn].indexOf(fn)` still answers `-1` for a bare one
  ([zun#17](https://github.com/UrubuCode/zun/issues/17)) — though
  `[fn][0] === fn` is `true`. `typeof` reports `"function"` for a box, so
  `__evUnbox` / `__utilUnbox` / `__unboxFn` / `__testCall` probe the `__boxedFn`
  slot for **both** kinds.
* a bare function **loses its own properties** on the way into an array, while a
  box keeps them — which is why a once-wrapper is still boxed: `__evBox` is what
  carries `.listener` and what `indexOf` can find.
* a function **returned** from an object-literal method is still not the
  callable: the caller gets an opaque object that no longer compares equal to the
  original. Re-probed three ways on this build — out of an object-literal method,
  out of a class method, and out of a plain function held in a *property* of an
  object — and all three lose it; only a direct call of a top-level function
  keeps it. `common.mustCall()` is exactly that shape, so the harness hands back
  the *boxed* wrapper, which is also why zun#71 blocks `error-monitor`.
* a listener is invoked as `fn(...args)` through `__evCall`, so `this` inside it
  is `undefined` ([zun#1](https://github.com/UrubuCode/zun/issues/1)). The
  argument-shifting half of #1 **is** fixed on this build:
  `f.apply(recv, [a, b])` now reaches a plain function value as `f(a, b)` rather
  than `f(recv, a)`, and `f.call(recv, a, b)` is accepted and passes `(a, b)`.
  Only `this` is still lost, and only for a plain function — an object-literal
  method gets both right, which is what `EventEmitter.prototype` is built from.
* every closure that collects its call arguments uses a **rest parameter**, never
  the implicit call-arguments object. The parser looks for that word textually
  anywhere inside a function's source span and injects a synthetic trailing rest
  parameter into the *enclosing* function too
  ([zun#40](https://github.com/UrubuCode/zun/issues/40)); a dynamic call through
  an `any` receiver — which `events.once(…)` and `events.on(…)` are, since the
  module object is the only lane to them — then leaves that synthetic parameter
  unbound and the injected spread aborts with `spread: value is not iterable`.
  That is what `EventEmitter.once(EE, 'x')` hit the moment the bundler rewrite
  above made it reachable, in `__evOnceWrap`'s wrapper, `__eventsOnce`'s resolver
  and `__eventsOn`'s collector.
* a **symbol** key is still invisible to `Object.getOwnPropertySymbols` and
  `sym in obj` still throws `Cannot convert a Symbol value to a string`
  ([zun#32](https://github.com/UrubuCode/zun/issues/32)), so the event-name
  order is tracked in `__evTypes` beside `_events`. String keys are visible to
  `Object.keys`, `getOwnPropertyNames`, `Reflect.ownKeys`, `for-in` and
  `getOwnPropertyDescriptor` in insertion order, function-valued ones included;
  `obj.hasOwnProperty(k)` and `Object.entries` are the two that still miss them.
* `delete obj[sym]` is rejected by the checker outright — "`delete obj[k]`
  requires a string key" — so a symbol slot is blanked with `undefined`. A string
  key needs no special case: `delete` clears a function-valued property now (#32).
* a computed read with a *variable* key resolves `Object.prototype`'s members
  even on a null-prototype object
  ([zun#46](https://github.com/UrubuCode/zun/issues/46)), so `_events[type]`
  answered `Object.prototype.toString` for the event name `toString`. The same
  read with a *literal* key is correct, and `in` reports the truth, so
  `__evRawGet` asks it first.
* `events.__proto__ = value` sets the **prototype** of a null-prototype object
  instead of creating an own property
  ([zun#47](https://github.com/UrubuCode/zun/issues/47)), so the slot for an
  event named `__proto__` is lost. A bare callable happens to take the ordinary
  path; every other value (a listener array, a boxed once-wrapper) is installed
  with `Object.defineProperty`, which is exact. The two paths cannot be merged:
  `defineProperty` with a bare callable stores nothing readable.
* a **numeric** event name needs an explicit `String(type)` (`__evKeyOf`),
  because a **function** value under a numeric computed key is silently dropped
  (new, reported with this work). `obj[123] = fn` leaves a slot that `in` and
  `Object.keys` report while every read answers `undefined`; the same function
  under the key `"123"` round-trips, and a *non-function* value under the key
  `123` round-trips too. `StoreDynamicValue` applies ToPropertyKey to booleans,
  `null`, `undefined` and objects but not to numbers, and its function-store arms
  match only `Value::Str` — so `ee.on(123, fn)` followed by
  `ee.listenerCount(123)` answered 0.
* `Array.prototype.splice`'s start index must be an integer, which only an
  `any`-typed array receiver accepts; array-held flags such as `warned` likewise
  need an `any` receiver.
* `WeakMap` is still unusable, and worse than before:
  `new WeakMap().set(key, 1)` aborts the VM outright with `call did not resolve
  to a method`, which no `try`/`catch` can contain
  ([zun#28](https://github.com/UrubuCode/zun/issues/28)), so the EventTarget side
  tables keep their keys alive. They are real `Map`s.
* `Number(x.length)` throughout, because the checker still types `.length` as
  `u64` ([zun#3](https://github.com/UrubuCode/zun/issues/3)) even though its
  arithmetic was widened.
* `EventEmitter` **declares** `__zunEventsCapture` instead of attaching it,
  because an undeclared key written onto a typed instance through an `any` alias
  poisons every later statically typed read of that instance
  ([zun#37](https://github.com/UrubuCode/zun/issues/37)).

Workarounds that were **removed**, because the engine fixed what forced them:

| Was | Now | Fixed by |
|---|---|---|
| `emit` spelled with ten explicit optional slots and the trailing `undefined`s trimmed | `emit(type, ...args)`, as Node spells it | a rest parameter is a real array everywhere now ([zun#11](https://github.com/UrubuCode/zun/issues/11)) |
| a symbol-keyed slot always held an **array**, even for a single listener | Node's own shape under a symbol key too (`_events[sym] === listener` while there is one) | a function value under a symbol key round-trips ([zun#32](https://github.com/UrubuCode/zun/issues/32)) |
| `__evRawDelete` blanked a function-valued string key with `undefined` | `delete events[type]` for every string key | `delete` clears a function-valued property (#32) |
| the surface `assert` was a plain object, so Node's bare `assert(value)` form was unreachable | `src/assert/assert.ts` is a **function** carrying the methods | a function can carry callable properties ([zun#14](https://github.com/UrubuCode/zun/issues/14)) |
| `prependListener` rebuilt the list and copied the `warned` flag across | `list.unshift(listener)` | `unshift` accepts a function argument (#17) |
| `EventEmitter.defaultMaxListeners` / `.errorMonitor` / `.captureRejectionSymbol` reachable only through the module object | real class statics | static fields read back and can be assigned ([zun#20](https://github.com/UrubuCode/zun/issues/20), partly) |
| `__evKeyId` keyed `__evTypes` by a symbol's *description* | plain identity (`types.indexOf(type)`) | `s === s`, and `_events[sym]` keys by identity ([zun#23](https://github.com/UrubuCode/zun/issues/23)) |
| `captureRejectionSymbol` was a plain `Symbol`, unreachable from a caller | `Symbol.for('nodejs.rejection')`, as in Node | the symbol registry round-trips (#23) |
| the EventTarget side tables were two parallel arrays with a linear scan | real `Map`s behind the same three accessors | a `Map` keeps its methods through an `any` binding ([zun#7](https://github.com/UrubuCode/zun/issues/7)) |

Two more are no longer *required*. A class field declared without an initializer
no longer panics the interpreter
([zun#27](https://github.com/UrubuCode/zun/issues/27) — it reads back a typed
zero); the explicit initializers stay, because they are what the code means. And
a bare `return;` in a function whose inferred return type is `Any` is accepted
now ([zun#22](https://github.com/UrubuCode/zun/issues/22), re-probed as fixed) —
it used to be `expected a Any return value`, and it was the stated blocker for
`test-event-emitter-method-names.js` and `test-event-emitter-remove-listeners.js`.

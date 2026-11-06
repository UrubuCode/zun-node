// node:timers + node:timers/promises — Node's timer surface over the Zun VM's
// own event loop.
//
// This module is Zun TypeScript with **no native extension**: the VM already
// owns the macrotask tier (NUCLEUS §9a — one unified loop that drains Promise
// microtasks and fires timers, on a virtual clock that fast-forwards to the
// next due time instead of sleeping). What Node adds on top of that tier is all
// shape, and shape is what this file is: the `Timeout` and `Immediate` objects,
// `ref`/`unref`/`hasRef`/`refresh`/`close`, argument validation, the three
// `Timeout*Warning`s, `clearTimeout` by object *or* id, and the promisified
// surface with `AbortSignal` support.
//
// ---------------------------------------------------------------------------
// Why the globals are declared here, and how the intrinsics are still reached
// ---------------------------------------------------------------------------
//
// In Node, `setTimeout` & co. are *globals* that are the very same functions
// `require('timers')` hands back. In Zun they are **intrinsics**: the checker
// resolves a bare call to `setTimeout`/`setInterval`/`setImmediate`/`clearTimeout`/
// `clearInterval`/`queueMicrotask` against the `timers` native namespace
// (`zun_sema/src/check.rs`), with typed parameters — the callback must be
// statically `Ty::Function` and a handle must be numeric. Node's own tests hand
// those functions an `any` (every `common.mustCall()` result is one) and hand
// `clearTimeout` a `Timeout` object, `null`, a string, or `{}`, so the intrinsic
// rejects the test **at compile time**:
//
//     error: [SEM0001] `setTimeout` expects a function callback
//     error: [SEM0001] `clearTimeout` expects a numeric handle
//
// (https://github.com/UrubuCode/zun/issues/29.)
//
// The checker resolves the intrinsic only when the name is *not* a user symbol,
// so declaring `function setTimeout(...)` here shadows it program-wide and gives
// the tests Node's signature. The catch is that the shadow is whole-program: a
// helper in this same file that calls `setTimeout(cb, ms)` resolves to *this*
// function, not the intrinsic, and recurses.
//
// The spelling that works — and the answer to zun#29 for any library in this
// position — is the **namespace import**:
//
//     import { timers as __timerCore } from "zun:core";
//     __timerCore.setTimeout(cb, ms);
//
// `import { <ns> } from "zun:core"` binds a native namespace whose member calls
// lower straight to `call.builtin` (`zun_sema/src/module_resolution.rs`'s
// `resolve_core_import`), bypassing the bare-name resolution the shadow
// intercepts. It is also *less* restrictive than the bare form: the namespace
// call is checked against the native signature, where the callback parameter is
// `Opaque`, so an `any`-typed callable is accepted there and nowhere else.
//
// Everything below is therefore armed through four natives:
// `setTimeoutArgs(cb, ms, args)` (the only one that forwards arguments),
// `clearTimeout(handle)`, and `queueMicrotask(cb)`. `setInterval` is *not* used:
// Node re-arms an interval after its callback returns, with whatever
// `_idleTimeout` then holds, and a `refresh()` or an `unref()` in the middle of
// a callback has to be visible to the next arming — so every Node timer, interval
// included, is one engine `setTimeoutArgs` at a time, re-armed by `__timerFire`.
//
// ---------------------------------------------------------------------------
// Keeping the program alive, and the harness settle loop
// ---------------------------------------------------------------------------
//
// Node exits when no *ref'd* handle is left; an `unref()`'d timer never holds
// the loop open. The VM has no "about to exit" hook, so the test harness
// (`tools/harness/common.ts`) runs a settle loop and decides for itself when the
// program is quiet. This module gives it the two facts it cannot otherwise see:
// `__timerPendingRefs()` (how many ref'd, undestroyed timers are armed) and
// `__timerNextDelay()` (how long until the earliest of them is due), so a
// pending `setTimeout(fn, 1000)` neither ends the run early nor burns a thousand
// settle turns — the loop arms its next turn for the due time and the VM's
// virtual clock jumps straight there.
//
// ---------------------------------------------------------------------------
// Documented deviations from Node
// ---------------------------------------------------------------------------
//
//   * **`this` inside a timer callback.** Node calls the callback with the
//     `Timeout`/`Immediate` as the receiver. A callable held in an `any` can
//     only be reached here as `fn(...args)`; `apply`/`call` thread no receiver
//     (https://github.com/UrubuCode/zun/issues/1), so `this` is undefined in a
//     callback. That is what `test-timers-this.js` measures.
//   * **`setImmediate` versus `setTimeout(fn, 0)`.** libuv runs the whole
//     immediate queue in the *check* phase, after the timers phase of the same
//     turn. The VM has a single macrotask tier, so an `Immediate` is a 0-delay
//     macrotask and the two interleave in arm order. The relative order *within*
//     the immediate queue is FIFO, as in Node.
//   * **`[Symbol.dispose]`.** `Symbol.dispose` does not exist in this engine
//     (`Symbol.dispose` reads `undefined`) and a class computed key must be one
//     of five well-known symbols, so the explicit-resource-management method
//     cannot be declared. `close()` is the same operation and is present.
//   * **`async_hooks`.** There is no async-resource tracking, so `destroy` hooks
//     are not emitted. The id a `Timeout` coerces to is a plain counter, which is
//     all `[Symbol.toPrimitive]`'s observable contract needs.
//
// Node's own `lib/timers.js`, `lib/internal/timers.js` and `lib/timers/promises.js`
// (MIT) are followed instruction for instruction for the parts that are
// observable: the constructor's delay coercion and warning ladder, `unenroll`,
// `clearTimeout`'s two accepted shapes, the `knownTimersById` registration that
// only happens once a timer has been coerced to a primitive, and the
// promisified functions' validation order.

import { timers as __timerCore } from "zun:core";

// `2 ** 31 - 1`, the largest delay libuv accepts (`lib/internal/timers.js`).
const __TIMEOUT_MAX: number = 2147483647;

// Module state. A single object rather than a set of `let`s: a top-level `let`
// mutated from inside a callback is reliable, but one object keeps the whole
// timer bookkeeping in one place and makes the harness hooks cheap to read.
//
//   nextId          — the counter a timer coerces to. Node uses its async id,
//                     which starts above 1; the only contract the tests rest on
//                     is that it is a number, is not NaN, and is stable.
//   live            — every armed-or-armable timer, keyed by `String(id)`. This
//                     is what `__timerFire` resolves a fired engine timer back
//                     to, so it is kept for every timer whether or not the
//                     program ever coerced it.
//   known           — Node's `knownTimersById`: only the timers that have been
//                     coerced to a primitive, which is the set `clearTimeout(id)`
//                     can find.
//   refs            — how many ref'd, undestroyed timers/immediates are armed.
//   warnedNegative / warnedNaN — Node emits those two warnings once per process.
const __timerState: any = {
  nextId: 2,
  live: {},
  known: {},
  refs: 0,
  warnedNegative: false,
  warnedNaN: false,
};

function __timerNow(): number {
  return Number(Date.now());
}

// `validateFunction(callback, 'callback')`. A `common.mustCall()` result is a
// `functionBox` record rather than a bare callable, so the test is `events`'
// unwrapping one (https://github.com/UrubuCode/zun/issues/17).
function __timerValidateCallback(callback: any): void {
  if (!__evIsFn(callback)) {
    throw new ERR_INVALID_ARG_TYPE("callback", "Function", callback);
  }
}

// `lib/internal/timers.js`' `Timeout` constructor, lines 180-204: coerce the
// delay, warn about the three ways it can be unusable, and fall back to 1.
//
// The ladder's order is Node's and matters: an overflowing delay warns *every*
// time, a negative one and a NaN one warn once per process each, and a delay
// that is merely below 1 (0, 0.5, a negative zero) warns not at all.
function __timerCoerceDelay(after: any): number {
  let ms: number = 1;
  if (after === undefined) return 1;
  ms = Number(after);
  if (ms >= 1 && ms <= __TIMEOUT_MAX) return ms;
  if (ms > __TIMEOUT_MAX) {
    process.emitWarning(
      String(ms) +
        " does not fit into a 32-bit signed integer." +
        "\nTimeout duration was set to 1.",
      "TimeoutOverflowWarning",
    );
  } else if (ms < 0 && !__timerState.warnedNegative) {
    __timerState.warnedNegative = true;
    process.emitWarning(
      String(ms) + " is a negative number." + "\nTimeout duration was set to 1.",
      "TimeoutNegativeWarning",
    );
  } else if (Number.isNaN(ms) && !__timerState.warnedNaN) {
    __timerState.warnedNaN = true;
    process.emitWarning(
      String(ms) + " is not a number." + "\nTimeout duration was set to 1.",
      "TimeoutNaNWarning",
    );
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------
//
// Node's `Timeout` is a plain class whose own enumerable fields the tests read
// directly (`_idleTimeout`, `_onTimeout`, `_destroyed`, `_repeat`, the
// `_idlePrev`/`_idleNext` list pointers). They are declared fields here for the
// reason every error class in this library declares its `code`: an undeclared
// key written onto a typed instance through an `any` alias poisons every later
// typed read of that instance (https://github.com/UrubuCode/zun/issues/37).
//
// `_handle` and `_refed` are this implementation's own: the engine task id the
// timer is currently armed as (-1 when not armed), and Node's `kRefed` symbol
// field, which has to be an ordinary name because a user symbol cannot key a
// class member here.
class Timeout {
  _idleTimeout: number;
  _idlePrev: any;
  _idleNext: any;
  _idleStart: any;
  _onTimeout: any;
  _timerArgs: any;
  _repeat: any;
  _destroyed: boolean;
  _id: number;
  _refed: boolean;
  _hasPrimitive: boolean;
  _handle: number;
  _enrolled: boolean;
  // The domain this timer was created in, or `null`. In Node the timer *is*
  // the async resource, so `lib/domain.js`' init hook hangs a non-enumerable
  // `domain` property on it; a property added to a class instance from outside
  // poisons every later typed read of that instance's own fields here
  // (https://github.com/UrubuCode/zun/issues/37 — `this._refed` inside
  // `unref()` then throws), so it is a declared field under this
  // implementation's `_`-prefix instead. It stays `null` whenever `node:domain`
  // is not in the bundle.
  _domain: any;

  constructor(callback: any, after: any, args: any, isRepeat: boolean, isRefed: boolean) {
    const ms: number = __timerCoerceDelay(after);
    this._idleTimeout = ms;
    this._idlePrev = this;
    this._idleNext = this;
    this._idleStart = null;
    // `__evBox`: a bare function written into an instance field and read back
    // through an `any` comes out `null`
    // (https://github.com/UrubuCode/zun/issues/17), which would silently drop
    // the callback. The box is the engine's own `functionBox` record — an
    // object, so it survives the round trip — and `__evCall` unwraps it. It is
    // also what `common.mustCall()` already hands over, and `__evBox` is
    // idempotent, so there is one representation either way.
    this._onTimeout = __evBox(callback);
    this._timerArgs = args;
    this._repeat = isRepeat ? ms : null;
    this._destroyed = false;
    this._id = 0;
    this._refed = isRefed;
    this._hasPrimitive = false;
    this._handle = -1;
    this._enrolled = false;
    this._domain = __domainHooks.active;
  }

  // `refresh()` restarts the countdown from now. Node routes it through
  // `active()`/`unrefActive()`, which call `insert(item, item._idleTimeout)` —
  // and `insert` returns immediately when `_idleTimeout` is negative. So a timer
  // that `clearTimeout` has unenrolled (`_idleTimeout === -1`) is not
  // resurrected, while one that merely *fired* is: its delay is still positive,
  // so `refresh()` arms it again. That asymmetry is what
  // `test-timers-refresh.js` and `test-timers-refresh-in-callback.js` pin, and
  // Node leaves `_destroyed` alone either way.
  refresh(): any {
    if (Number(this._idleTimeout) >= 0) {
      __timerDisarm(this);
      __timerEnlist(this);
      __timerArm(this);
    }
    return this;
  }

  unref(): any {
    if (this._refed) {
      this._refed = false;
      if (this._enrolled) __timerState.refs = Number(__timerState.refs) - 1;
    }
    return this;
  }

  ref(): any {
    if (!this._refed) {
      this._refed = true;
      if (this._enrolled) __timerState.refs = Number(__timerState.refs) + 1;
    }
    return this;
  }

  hasRef(): boolean {
    return this._refed;
  }

  // `Timeout.prototype.close` in `lib/timers.js`: `clearTimeout(this)`.
  close(): any {
    __timerClearTimeout(this);
    return this;
  }

  // `lib/timers.js`' `Timeout.prototype[SymbolToPrimitive]`: hand back the id
  // and, the first time, publish the timer under it so `clearTimeout(id)` can
  // find it. Node registers lazily precisely so that a program that never
  // coerces a timer never adds a map entry.
  [Symbol.toPrimitive](): number {
    const id: number = Number(this._id);
    if (!this._hasPrimitive) {
      this._hasPrimitive = true;
      __timerState.known[String(id)] = this;
    }
    return id;
  }
}

// ---------------------------------------------------------------------------
// Immediate
// ---------------------------------------------------------------------------
//
// `lib/internal/timers.js`' `Immediate`. It has no delay and no id of its own in
// Node's public shape; the `_id` here is this implementation's handle into
// `__timerState.live`, exactly as for a `Timeout`.
class Immediate {
  _idleNext: any;
  _idlePrev: any;
  _onImmediate: any;
  _argv: any;
  _destroyed: boolean;
  _id: number;
  _refed: boolean;
  _handle: number;
  _enrolled: boolean;
  // The domain this immediate was created in; see `Timeout._domain`.
  _domain: any;

  constructor(callback: any, args: any) {
    this._idleNext = null;
    this._idlePrev = null;
    // Boxed for the reason given in `Timeout`'s constructor.
    this._onImmediate = __evBox(callback);
    this._argv = args;
    this._destroyed = false;
    this._id = 0;
    this._refed = true;
    this._handle = -1;
    this._enrolled = false;
    this._domain = __domainHooks.active;
  }

  ref(): any {
    if (this._refed === false) {
      this._refed = true;
      if (this._enrolled) __timerState.refs = Number(__timerState.refs) + 1;
    }
    return this;
  }

  unref(): any {
    if (this._refed === true) {
      this._refed = false;
      if (this._enrolled) __timerState.refs = Number(__timerState.refs) - 1;
    }
    return this;
  }

  hasRef(): boolean {
    return this._refed;
  }
}

// ---------------------------------------------------------------------------
// Arming, firing and cancelling
// ---------------------------------------------------------------------------

// Add a timer to the live set. `__timerState.refs` is exactly "how many ref'd
// entries are in `live`", so membership and the refcount move together and the
// count cannot drift.
function __timerEnlist(timer: any): void {
  if (timer._enrolled) return;
  timer._enrolled = true;
  __timerState.live[String(timer._id)] = timer;
  if (timer._refed) __timerState.refs = Number(__timerState.refs) + 1;
}

function __timerDelist(timer: any): void {
  if (!timer._enrolled) return;
  timer._enrolled = false;
  const live: any = __timerState.live;
  delete live[String(timer._id)];
  if (timer._refed) __timerState.refs = Number(__timerState.refs) - 1;
}

// Register a freshly constructed timer and hand out its id.
function __timerEnrol(timer: any): number {
  const id: number = Number(__timerState.nextId);
  __timerState.nextId = id + 1;
  timer._id = id;
  __timerEnlist(timer);
  return id;
}

// Arm one engine timer for this Node timer. `setTimeoutArgs` is the only timer
// intrinsic that forwards arguments, which is how the id reaches
// `__timerFire`/`__timerFireImmediate` without a closure — a top-level function
// is both the cheapest callback and the one shape the `Opaque` parameter is
// guaranteed to accept.
function __timerArm(timer: any): void {
  timer._idleStart = __timerNow();
  timer._handle = Number(
    __timerCore.setTimeoutArgs(__timerFire, Number(timer._idleTimeout), [Number(timer._id)]),
  );
}

function __timerArmImmediate(immediate: any): void {
  immediate._handle = Number(
    __timerCore.setTimeoutArgs(__timerFireImmediate, 0, [Number(immediate._id)]),
  );
}

// Cancel the engine timer without touching Node-visible state.
function __timerDisarm(timer: any): void {
  const handle: number = Number(timer._handle);
  if (handle >= 0) {
    __timerCore.clearTimeout(handle);
    timer._handle = -1;
  }
}

// `lib/internal/timers.js`' `listOnTimeout` destroy step: the timer is done, but
// it was *not* explicitly cleared, so its `_idleTimeout` keeps its value — which
// is why a `refresh()` after the fact still works.
function __timerMarkDestroyed(timer: any): void {
  __timerDisarm(timer);
  __timerDelist(timer);
  if (timer._destroyed) return;
  timer._destroyed = true;
  if (timer._hasPrimitive) {
    const known: any = __timerState.known;
    delete known[String(timer._id)];
  }
}

// `lib/timers.js`' `unenroll`: the destroy step plus `_idleTimeout = -1`, which
// is the flag that makes every later `refresh()` a no-op.
function __timerUnenrol(timer: any): void {
  __timerMarkDestroyed(timer);
  timer._idleTimeout = -1;
}

// Invoke a timer callback. `fn(...args)` is the only spelling that reaches a
// callable held in an `any` with the right arity; no receiver is threaded
// (https://github.com/UrubuCode/zun/issues/1), which is this module's one
// behavioural gap against Node.
//
// `node:domain`: a timer callback runs inside the domain that was active when
// the timer was *created* (Node gets that from `lib/domain.js`' async_hooks
// `before`/`after` pair, the timer being its own async resource), and a throw
// out of it is routed to that domain rather than straight to `process`. The
// routing has to happen while the domain is still on the stack, so the hook
// owns the whole invocation and does not re-throw — which is also why
// `__timerFire`'s re-arm step still sees a clean run. Both the domain and the
// hook are `null` unless `src/domain/domain.ts` is in the bundle (see
// `__domainHooks` in ../events/events.ts).
function __timerInvoke(callback: any, args: any, domain: any): void {
  const passed: any[] = [];
  if (args !== undefined && args !== null) {
    const count: number = Number(args.length);
    for (let i = 0; i < count; i++) passed.push(args[i]);
  }
  const hook: any = __domainHooks.callback;
  if (domain !== null && domain !== undefined && hook !== null && hook !== undefined) {
    __evCall(hook, [domain, callback, passed]);
    return;
  }
  __evCall(callback, passed);
}

// An exception out of a timer callback. In Node it leaves `listOnTimeout`, is
// caught by the process-wide fatal-exception handler and delivered to
// `process.on('uncaughtException')` — and the loop carries on, which is why
// `test-timers-interval-throw.js` can watch an interval throw twice. The same
// two outcomes are reproduced here: with a listener, the error is emitted and
// the loop continues; with none, it is re-thrown so the run fails the way an
// uncaught exception should.
// A throw out of a timer callback is an uncaught exception, which is
// `process`'s business: the capture callback, the `uncaughtExceptionMonitor`
// event and the `uncaughtException` listeners all have to be consulted in
// Node's order, and `src/process/process.ts` owns that order because a
// `process.nextTick` callback reaches it the same way.
function __timerReportUncaught(error: any): void {
  __processReportUncaught(error);
}

// Node's truthiness test for `_repeat`: an interval re-arms while `_repeat` is
// a non-zero number, and `test-timers-timeout-to-interval.js` turns a one-shot
// into an interval by assigning `_repeat` from inside the callback — so the
// field is read *after* the callback has run, never before.
function __timerIsRepeating(repeat: any): boolean {
  if (repeat === undefined || repeat === null || repeat === false) return false;
  if (typeof repeat === "number") return Number(repeat) !== 0 && !Number.isNaN(Number(repeat));
  return repeat ? true : false;
}

// The engine timer fired. This is `listOnTimeout`'s body for one timer, in its
// order: drop the timer from the list, skip (and destroy) a timer whose callback
// has been cleared, run the callback, and then — in the `finally` position, so a
// throw does not skip it — either re-arm an interval or mark a one-shot
// destroyed, the latter only if the callback did not re-arm it with `refresh()`.
function __timerFire(idArg: any): void {
  const key: string = String(idArg);
  const timer: any = __timerState.live[key];
  if (timer === undefined || timer === null) return;
  timer._handle = -1;
  const callback: any = timer._onTimeout;
  if (callback === undefined || callback === null || callback === false) {
    __timerMarkDestroyed(timer);
    return;
  }
  let failure: any = undefined;
  let failed: boolean = false;
  try {
    __timerInvoke(callback, timer._timerArgs, timer._domain);
  } catch (error) {
    failed = true;
    failure = error;
  }
  if (__timerIsRepeating(timer._repeat) && Number(timer._idleTimeout) !== -1) {
    timer._idleTimeout = Number(timer._repeat);
    __timerEnlist(timer);
    __timerArm(timer);
  } else if (Number(timer._handle) < 0 && !timer._destroyed) {
    __timerMarkDestroyed(timer);
  }
  if (failed) __timerReportUncaught(failure);
}

// `processImmediate`'s body for one `Immediate`: Node clears it *before* running
// the callback, so a `clearImmediate(self)` inside the callback is a no-op and a
// throw does not leave the immediate armed.
//
// The one thing libuv adds is the reason an `unref()`'d immediate is subtle: the
// check phase only runs while the loop is alive, so an unref'd immediate runs
// when *something else* holds the loop open and is silently dropped when nothing
// does. The VM has no such rule — its macrotask tier runs whatever is in it — so
// the test is made explicitly: if this immediate is unref'd and no other ref'd
// timer is armed and no tick is pending, the loop would already have ended and
// the callback does not run. That is the whole content of
// `test-timers-immediate-unref.js` and
// `test-timers-immediate-unref-nested-once.js`.
function __timerFireImmediate(idArg: any): void {
  const key: string = String(idArg);
  const immediate: any = __timerState.live[key];
  if (immediate === undefined || immediate === null) return;
  immediate._handle = -1;
  if (immediate._destroyed) return;
  if (!immediate._refed && !__timerLoopWouldLive(immediate)) {
    __timerClearImmediate(immediate);
    return;
  }
  const callback: any = immediate._onImmediate;
  __timerClearImmediate(immediate);
  if (callback === undefined || callback === null) return;
  try {
    __timerInvoke(callback, immediate._argv, immediate._domain);
  } catch (error) {
    __timerReportUncaught(error);
  }
}

// Is anything other than `self` keeping the loop open? `__timerState.refs`
// counts the ref'd live entries, and `self` is unref'd by the time this is
// asked, so the count is already exclusive of it.
function __timerLoopWouldLive(self: any): boolean {
  const _unused: any = self;
  if (Number(__timerState.refs) > 0) return true;
  return __processPendingTicks() > 0;
}

// ---------------------------------------------------------------------------
// The harness hooks (see the header)
// ---------------------------------------------------------------------------

// How many ref'd, undestroyed timers are armed — i.e. how many handles would
// keep Node's loop alive.
function __timerPendingRefs(): number {
  return Number(__timerState.refs);
}

// The provider names `process.getActiveResourcesInfo()` reports for this
// module's handles, one entry per live timer. A timer is "active" while it is in
// `live` and not destroyed, which is exactly the window Node keeps its handle
// in: a `Timeout` is still listed while its own callback runs (`__timerFire`
// destroys it afterwards) and an `Immediate` is not (`__timerFireImmediate`
// clears it first), which is the difference
// `test-process-getactiveresources-track-timer-lifetime.js` measures.
//
// Timers are the only handle kind this runtime has, so this is the whole of
// `getActiveResourcesInfo()`; see `src/process/process.ts`.
function __timerActiveResources(): string[] {
  const live: any = __timerState.live;
  const out: string[] = [];
  for (const key of Object.keys(live)) {
    const timer: any = live[key];
    if (timer === undefined || timer === null) continue;
    if (timer._destroyed) continue;
    out.push(timer instanceof Immediate ? "Immediate" : "Timeout");
  }
  return out;
}

// Milliseconds until the earliest ref'd timer is due, floored at 1. `-1` when
// nothing ref'd is pending.
function __timerNextDelay(): number {
  const live: any = __timerState.live;
  const keys: any[] = Object.keys(live);
  const now: number = __timerNow();
  let best: number = -1;
  for (const key of keys) {
    const timer: any = live[key];
    if (timer === undefined || timer === null) continue;
    if (timer._destroyed || !timer._refed) continue;
    if (Number(timer._handle) < 0) continue;
    const start: any = timer._idleStart;
    const delay: number = Number(timer._idleTimeout);
    const due: number = start === null || start === undefined ? now : Number(start) + delay;
    const remaining: number = due - now;
    if (best < 0 || remaining < best) best = remaining;
  }
  if (best < 0) return -1;
  return best < 1 ? 1 : best;
}

// Disarm every engine timer this module still holds, without touching any
// Node-visible field.
//
// Node's loop ends when no ref'd handle is left; an `unref()`'d interval is
// simply dropped. The VM has no such rule — its timer heap re-arms whatever is
// in it, so an unref'd interval would keep the process alive forever. The test
// harness calls this once it has emitted `process` 'exit' (after the 'exit'
// listeners have read `_destroyed` and friends), which is the point at which
// Node would have returned from the loop too.
function __timerShutdown(): void {
  const live: any = __timerState.live;
  const keys: any[] = Object.keys(live);
  for (const key of keys) {
    const timer: any = live[key];
    if (timer === undefined || timer === null) continue;
    __timerDisarm(timer);
  }
}

// ---------------------------------------------------------------------------
// The globals (and `node:timers`' exports — in Node they are the same functions)
// ---------------------------------------------------------------------------

function setTimeout(callback: any, after?: any, ...args: any[]): any {
  __timerValidateCallback(callback);
  const forwarded: any = Number(args.length) > 0 ? __timerRest(args) : undefined;
  const timeout = new Timeout(callback, after, forwarded, false, true);
  __timerEnrol(timeout);
  __timerArm(timeout);
  return timeout;
}

function setInterval(callback: any, repeat?: any, ...args: any[]): any {
  __timerValidateCallback(callback);
  const forwarded: any = Number(args.length) > 0 ? __timerRest(args) : undefined;
  const timeout = new Timeout(callback, repeat, forwarded, true, true);
  __timerEnrol(timeout);
  __timerArm(timeout);
  return timeout;
}

function setImmediate(callback: any, ...args: any[]): any {
  __timerValidateCallback(callback);
  const forwarded: any = Number(args.length) > 0 ? __timerRest(args) : undefined;
  const immediate = new Immediate(callback, forwarded);
  __timerEnrol(immediate);
  __timerArmImmediate(immediate);
  return immediate;
}

// A rest parameter copied into a plain array. The rest binding itself is handed
// straight to the engine's argument-forwarding native, which wants an ordinary
// array it can box element by element.
function __timerRest(args: any[]): any[] {
  const out: any[] = [];
  const count: number = Number(args.length);
  for (let i = 0; i < count; i++) out.push(args[i]);
  return out;
}

// `lib/timers.js`' `clearTimeout`: a timer-shaped argument with a live callback
// is unenrolled; a number or a string is looked up in the by-id map; anything
// else — `null`, `undefined`, `{}`, an already-cleared timer — is a no-op.
function __timerClearTimeout(timer: any): void {
  const kind: string = typeof timer;
  // Node spells this `timer?._onTimeout`, which is simply `undefined` for a
  // string or a number. Here the receiver has to be narrowed first: reading an
  // undeclared property off a **string** held in an `any` panics the
  // interpreter (`expected object, found Str(…)`, crates/zun_interp/src/value.rs
  // — new engine bug, found by this work), and `clearTimeout(id)` with a string
  // id is exactly that call, straight out of `test-timers-to-primitive.js`.
  if (timer !== undefined && timer !== null && (kind === "object" || kind === "function")) {
    const callback: any = timer._onTimeout;
    if (callback !== undefined && callback !== null && callback !== false) {
      timer._onTimeout = null;
      __timerUnenrol(timer);
      return;
    }
  }
  if (kind === "number" || kind === "string") {
    const found: any = __timerState.known[String(timer)];
    if (found !== undefined && found !== null) {
      found._onTimeout = null;
      __timerUnenrol(found);
    }
  }
}

function clearTimeout(timer?: any): void {
  __timerClearTimeout(timer);
}

// `clearInterval` is `clearTimeout`: the HTML Living Standard makes the two
// interchangeable, and Node implements it as a direct call.
function clearInterval(timer?: any): void {
  __timerClearTimeout(timer);
}

function __timerClearImmediate(immediate: any): void {
  if (immediate === undefined || immediate === null) return;
  // Narrowed for the same reason as in `__timerClearTimeout`:
  // `clearImmediate('x')` must be a no-op, not an interpreter panic.
  const kind: string = typeof immediate;
  if (kind !== "object" && kind !== "function") return;
  const callback: any = immediate._onImmediate;
  if (callback === undefined || callback === null || callback === false) return;
  if (immediate._destroyed) return;
  immediate._destroyed = true;
  __timerDisarm(immediate);
  __timerDelist(immediate);
  immediate._refed = false;
  immediate._onImmediate = null;
}

function clearImmediate(immediate?: any): void {
  __timerClearImmediate(immediate);
}

// ---------------------------------------------------------------------------
// queueMicrotask
// ---------------------------------------------------------------------------
//
// A global in Node, not a `node:timers` export, and the only one of the six that
// is *not* a macrotask. It is declared here for the same reason as the others —
// the intrinsic rejects an `any` callback at compile time, and
// `test-timers-promises-scheduler.js` passes it a `common.mustCall()` — and
// because Node's version validates its argument and routes a throw to
// `uncaughtException`, neither of which the intrinsic does.
//
// Callbacks go through one FIFO queue drained by a single `queueMicrotask` pass,
// the shape `process.nextTick` already uses: the engine's microtask native takes
// no forwarded arguments, so a top-level drain function is the only callback
// that needs no closure.
const __timerMicrotasks: any = { queue: [], scheduled: false };

function queueMicrotask(callback: any): void {
  if (!__evIsFn(callback)) {
    throw new ERR_INVALID_ARG_TYPE("callback", "function", callback);
  }
  __timerMicrotasks.queue.push(__evBox(callback));
  if (!__timerMicrotasks.scheduled) {
    __timerMicrotasks.scheduled = true;
    __timerCore.queueMicrotask(__timerDrainMicrotasks);
  }
}

function __timerDrainMicrotasks(): void {
  __timerMicrotasks.scheduled = false;
  const queue: any[] = __timerMicrotasks.queue;
  __timerMicrotasks.queue = [];
  const count: number = Number(queue.length);
  for (let i = 0; i < count; i++) {
    try {
      __evCall(queue[i], []);
    } catch (error) {
      __timerReportUncaught(error);
    }
  }
}

// ---------------------------------------------------------------------------
// node:timers/promises
// ---------------------------------------------------------------------------
//
// Each promisified call is one `Promise.withResolvers()` plus one timer whose
// callback settles it. The resolver functions cannot be captured into a timer
// closure reliably, so they ride `__timerState.live` with the timer itself: the
// timer's `_onTimeout` is a top-level function and the settlement data hangs off
// a record the callback reaches through the same by-id lookup every other timer
// uses.
const __timerPromiseState: any = { settlers: {} };

function __timerSettleResolve(idArg: any): void {
  const key: string = String(idArg);
  const record: any = __timerPromiseState.settlers[key];
  if (record === undefined || record === null) return;
  const settlers: any = __timerPromiseState.settlers;
  delete settlers[key];
  __timerDetachAbort(record);
  const resolve: any = record.resolve;
  __evCall(resolve, [record.value]);
}

function __timerSettleReject(record: any, error: any): void {
  const key: string = String(record.key);
  const settlers: any = __timerPromiseState.settlers;
  delete settlers[key];
  __timerDetachAbort(record);
  const reject: any = record.reject;
  __evCall(reject, [error]);
}

// The 'abort' listener a pending promisified timer installs. Node binds
// `cancelListenerHandler` to the timer; here the record is found by id, which
// avoids needing a bound receiver (https://github.com/UrubuCode/zun/issues/1).
const __timerAbortHandlers: any = { byKey: {} };

function __timerDetachAbort(record: any): void {
  const signal: any = record.signal;
  const handler: any = record.handler;
  if (signal === undefined || signal === null) return;
  if (handler === undefined || handler === null) return;
  signal.removeEventListener("abort", handler);
  record.handler = undefined;
}

// `AbortError` with the signal's reason as `cause`, exactly as
// `lib/timers/promises.js` builds it.
function __timerAbortError(signal: any): any {
  const reason: any = signal === undefined || signal === null ? undefined : signal.reason;
  return new AbortError(undefined, { cause: reason });
}

// Shared validation for `setTimeout`/`setImmediate`/`setInterval`: the delay (if
// given) must be a number, `options` must be an object, and `options.signal` /
// `options.ref` must have their documented types. Node performs these in this
// order and turns a throw into a rejected promise for the two non-generator
// functions.
function __timerValidatePromiseOptions(after: any, options: any, hasDelay: boolean): void {
  if (hasDelay && after !== undefined) {
    __timerValidateNumber(after, "delay");
  }
  __evValidateObject(options, "options");
  const signal: any = options.signal;
  if (signal !== undefined) __evValidateAbortSignal(signal, "options.signal");
  const ref: any = options.ref;
  if (ref !== undefined) __evValidateBoolean(ref, "options.ref");
}

const __TIMER_EMPTY_OPTIONS: any = {};

// `validateNumber(value, name)` with neither bound, which is how
// `lib/timers/promises.js` calls it: only the *type* is checked, so `NaN` and
// `Infinity` are accepted delays (`events`' own `__evValidateNumber` always
// range-checks, which would reject both).
function __timerValidateNumber(value: any, name: string): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
}

function __timerPromiseTimeout(after?: any, value?: any, options?: any): any {
  const opts: any = options === undefined ? __TIMER_EMPTY_OPTIONS : options;
  const wr: any = Promise.withResolvers();
  try {
    __timerValidatePromiseOptions(after, opts, true);
  } catch (err) {
    __evCall(wr.reject, [err]);
    return wr.promise;
  }
  const signal: any = opts.signal;
  const refOption: any = opts.ref;
  const refed: boolean = refOption === undefined ? true : refOption ? true : false;
  if (signal !== undefined && signal !== null && signal.aborted) {
    __evCall(wr.reject, [__timerAbortError(signal)]);
    return wr.promise;
  }
  const timeout = new Timeout(__timerSettleResolve, after, undefined, false, refed);
  const id: number = __timerEnrol(timeout);
  const key: string = String(id);
  const record: any = {
    key: key,
    resolve: wr.resolve,
    reject: wr.reject,
    value: value,
    signal: signal,
    handler: undefined,
    timer: timeout,
    kind: "timeout",
  };
  __timerPromiseState.settlers[key] = record;
  // The engine fires `_onTimeout` with the id, so the settler needs no closure.
  timeout._timerArgs = [id];
  __timerArm(timeout);
  if (signal !== undefined && signal !== null) __timerAttachAbort(record);
  return wr.promise;
}

function __timerPromiseImmediate(value?: any, options?: any): any {
  const opts: any = options === undefined ? __TIMER_EMPTY_OPTIONS : options;
  const wr: any = Promise.withResolvers();
  try {
    __timerValidatePromiseOptions(undefined, opts, false);
  } catch (err) {
    __evCall(wr.reject, [err]);
    return wr.promise;
  }
  const signal: any = opts.signal;
  const refOption: any = opts.ref;
  const refed: boolean = refOption === undefined ? true : refOption ? true : false;
  if (signal !== undefined && signal !== null && signal.aborted) {
    __evCall(wr.reject, [__timerAbortError(signal)]);
    return wr.promise;
  }
  const immediate = new Immediate(__timerSettleResolve, undefined);
  const id: number = __timerEnrol(immediate);
  const key: string = String(id);
  const record: any = {
    key: key,
    resolve: wr.resolve,
    reject: wr.reject,
    value: value,
    signal: signal,
    handler: undefined,
    timer: immediate,
    kind: "immediate",
  };
  __timerPromiseState.settlers[key] = record;
  immediate._argv = [id];
  if (!refed) immediate.unref();
  __timerArmImmediate(immediate);
  if (signal !== undefined && signal !== null) __timerAttachAbort(record);
  return wr.promise;
}

// Install the 'abort' listener. The handler is an arrow over `key` only — a
// string — which is the one capture shape that is reliable here.
function __timerAttachAbort(record: any): void {
  const key: string = String(record.key);
  const handler = (): void => {
    __timerAbortFired(key);
  };
  record.handler = handler;
  const signal: any = record.signal;
  signal.addEventListener("abort", handler);
  __timerAbortHandlers.byKey[key] = handler;
}

function __timerAbortFired(key: string): void {
  const record: any = __timerPromiseState.settlers[String(key)];
  if (record === undefined || record === null) return;
  const timer: any = record.timer;
  if (timer !== undefined && timer !== null && timer._destroyed) return;
  if (record.kind === "immediate") {
    __timerClearImmediate(timer);
  } else {
    __timerClearTimeout(timer);
  }
  __timerSettleReject(record, __timerAbortError(record.signal));
}

// `timers/promises.setInterval` — an async generator that yields `value` once
// per tick and ends by throwing an `AbortError` when the signal fires.
//
// Node drives it with a `Timeout` whose callback resolves a promise the
// generator is awaiting. The same structure is used here, with the pending
// resolver kept in a record reached by id rather than captured, for the reason
// given above.
const __timerIntervalState: any = { records: {} };

function __timerIntervalTick(idArg: any): void {
  const key: string = String(idArg);
  const record: any = __timerIntervalState.records[key];
  if (record === undefined || record === null) return;
  record.pending = Number(record.pending) + 1;
  const waiter: any = record.waiter;
  if (waiter !== undefined && waiter !== null) {
    record.waiter = undefined;
    __evCall(waiter, [undefined]);
  }
}

async function* __timerPromiseInterval(after?: any, value?: any, options?: any): any {
  const opts: any = options === undefined ? __TIMER_EMPTY_OPTIONS : options;
  __timerValidatePromiseOptions(after, opts, true);
  const signal: any = opts.signal;
  const refOption: any = opts.ref;
  const refed: boolean = refOption === undefined ? true : refOption ? true : false;
  if (signal !== undefined && signal !== null && signal.aborted) {
    throw __timerAbortError(signal);
  }

  const interval = new Timeout(__timerIntervalTick, after, undefined, true, refed);
  const id: number = __timerEnrol(interval);
  const key: string = String(id);
  interval._timerArgs = [id];
  const record: any = { pending: 0, waiter: undefined, aborted: false };
  __timerIntervalState.records[key] = record;
  __timerArm(interval);

  let abortHandler: any = undefined;
  if (signal !== undefined && signal !== null) {
    abortHandler = (): void => {
      const current: any = __timerIntervalState.records[key];
      if (current === undefined || current === null) return;
      current.aborted = true;
      const waiter: any = current.waiter;
      if (waiter !== undefined && waiter !== null) {
        current.waiter = undefined;
        __evCall(waiter, [undefined]);
      }
    };
    signal.addEventListener("abort", abortHandler);
  }

  try {
    while (!record.aborted) {
      if (Number(record.pending) === 0) {
        const gate: any = Promise.withResolvers();
        record.waiter = gate.resolve;
        await gate.promise;
      }
      if (record.aborted) break;
      while (Number(record.pending) > 0) {
        record.pending = Number(record.pending) - 1;
        yield value;
      }
    }
    throw __timerAbortError(signal);
  } finally {
    __timerClearTimeout(interval);
    const records: any = __timerIntervalState.records;
    delete records[key];
    if (signal !== undefined && signal !== null && abortHandler !== undefined) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}

// `scheduler` — the WICG scheduling-API shape Node ships as experimental.
// `Scheduler` itself is not constructible (`ERR_ILLEGAL_CONSTRUCTOR`); only this
// one instance exists.
const __timerScheduler: any = {
  wait(delay?: any, options?: any): any {
    return __timerPromiseTimeout(delay, undefined, options);
  },
  yield(): any {
    return __timerPromiseImmediate(undefined, undefined);
  },
};

const __node_timers_promises: any = {
  setTimeout: __timerPromiseTimeout,
  setImmediate: __timerPromiseImmediate,
  setInterval: __timerPromiseInterval,
  scheduler: __timerScheduler,
};

// ---------------------------------------------------------------------------
// node:timers
// ---------------------------------------------------------------------------
//
// In Node these are the *same* function objects as the globals, which is what
// `test-timers-api-refs.js` relies on: it deletes the globals and keeps using
// `timers.setTimeout`. `enroll`/`unenroll`/`active` are the three legacy
// `node:timers` exports Node deprecated in v10 (DEP0096) and still exports.
const __node_timers: any = {
  setTimeout: setTimeout,
  setInterval: setInterval,
  setImmediate: setImmediate,
  clearTimeout: clearTimeout,
  clearInterval: clearInterval,
  clearImmediate: clearImmediate,
  promises: __node_timers_promises,
  Timeout: Timeout,
  Immediate: Immediate,

  // DEP0096: the pre-v0.9 `enroll`/`unenroll`/`active` trio, which stores the
  // delay on an arbitrary object and arms it with `active()`.
  enroll(item: any, msecs: any): void {
    __evValidateNumber(msecs, "msecs", 0);
    item._idleTimeout = Number(msecs);
    item._idleNext = item;
    item._idlePrev = item;
  },
  unenroll(item: any): void {
    if (item === undefined || item === null) return;
    __timerClearTimeout(item);
    item._idleTimeout = -1;
  },
  active(item: any): void {
    if (item === undefined || item === null) return;
    const msecs: any = item._idleTimeout;
    if (msecs === undefined || msecs === null || Number(msecs) < 0) return;
    const callback: any = item._onTimeout;
    if (callback === undefined || callback === null) return;
    const timeout = new Timeout(callback, Number(msecs), undefined, false, true);
    __timerEnrol(timeout);
    __timerArm(timeout);
  },
};

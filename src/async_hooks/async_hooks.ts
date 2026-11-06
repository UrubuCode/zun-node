// node:async_hooks — the `AsyncLocalStorage` slice `diagnostics_channel` needs.
//
// This is PLAN.md principle 4 in its purest form: `async_hooks` is not a module
// this library owns yet, but `diagnostics_channel`'s `Channel.bindStore`,
// `Channel.unbindStore` and `Channel.runStores` are defined in terms of an
// `AsyncLocalStorage`, and five of Node's own `test-diagnostics-channel-*` files
// construct one. So the piece that unblocks the module in hand is implemented
// here, and no more: there is no `createHook`, no `executionAsyncId`, no
// `AsyncResource`. Node's `lib/async_hooks.js` and
// `lib/internal/async_local_storage.js` (MIT, Copyright Joyent, Inc. and other
// Node contributors) are the reference for the surface.
//
// ---------------------------------------------------------------------------
// The honest gap: this store is a *synchronous* context, not an async one
// ---------------------------------------------------------------------------
//
// Node's `AsyncLocalStorage` rides on async_hooks: the store a callback sees is
// the one that was current when the asynchronous operation that scheduled it was
// *created*, so a context survives an `await`, a `setTimeout`, a promise
// continuation and an I/O callback. That propagation is a VM facility — V8's
// promise hooks plus libuv's async-resource bookkeeping — and the Zun VM exposes
// nothing of the sort (NUCLEUS §9a describes one unified macrotask/microtask
// loop with no continuation-local storage hook). It cannot be synthesized from
// the language side.
//
// What *can* be built faithfully is the synchronous half, which is a save →
// set → call → restore around `run()`:
//
//   * `run(store, fn, ...args)` makes `store` the current value for the whole
//     synchronous extent of `fn`, nests correctly, and restores the previous
//     value even when `fn` throws.
//   * `exit(fn, ...args)` runs `fn` with no store, and restores afterwards.
//   * `enterWith(store)` sets the value for the rest of the current synchronous
//     extent; `disable()` clears it.
//   * `getStore()` answers `undefined` outside any `run()`.
//
// So anything `diagnostics_channel` does *synchronously* — which is what
// `Channel.runStores` and `TracingChannel.traceSync` are, and what
// `TracingChannel.traceCallback`'s `asyncStart.runStores(...)` wrapper is as
// well, because it re-enters the store synchronously around the callback — is
// exact. What is **not** supported is reading the store back after an `await`
// or inside a callback that was merely *scheduled* inside `run()`:
//
//     store.run(ctx, async () => {
//       await something();
//       store.getStore();   // Node: ctx.  Here: undefined.
//     });
//
// `test-diagnostics-channel-tracing-channel-promise-run-stores.js` measures
// exactly that, and it is recorded as a blocker in
// ../../test/diagnostics_channel/README.md rather than papered over: faking the
// propagation (for instance by never restoring the value) would make that one
// assertion pass while silently leaking a context into every unrelated
// continuation, which is worse than an honest `undefined`.
//
// Engine notes (https://github.com/UrubuCode/zun/issues):
//   * the callback is invoked through `__evCall` (`fn(...args)`), because
//     `apply`/`call`/`bind` thread no receiver and shift the argument list
//     (zun#1). Node's `run` does not promise a receiver either, so nothing is
//     lost here.
//   * the saved value lives in a **declared** field. Writing an undeclared key
//     onto a typed instance through an `any` alias poisons every later typed
//     read of that instance (zun#37).

// ---------------------------------------------------------------------------
// AsyncLocalStorage
// ---------------------------------------------------------------------------

class AsyncLocalStorage {
  // `store` is only meaningful while `entered` is true: `undefined` is a
  // legitimate value to `run()` with, and `getStore()` must still answer
  // `undefined` outside a run, so the two facts are kept apart.
  alsStore: any = undefined;
  alsEntered: boolean = false;
  alsDisabled: boolean = false;

  constructor(options?: any) {
    // Node 24 accepts `{ defaultValue, name }`. `defaultValue` is what
    // `getStore()` answers outside any run; `name` is diagnostic only.
    if (options !== undefined && options !== null && typeof options === "object") {
      const fallback: any = options.defaultValue;
      if (fallback !== undefined) {
        this.alsStore = fallback;
        this.alsEntered = true;
      }
    }
  }

  getStore(): any {
    if (this.alsDisabled) return undefined;
    if (!this.alsEntered) return undefined;
    return this.alsStore;
  }

  // `run(store, callback, ...args)` — the synchronous extent of `callback` sees
  // `store`, and the previous value is restored even if `callback` throws.
  run(store: any, callback: any, ...args: any[]): any {
    if (!__evIsFn(callback)) {
      throw new ERR_INVALID_ARG_TYPE("callback", "Function", callback);
    }
    const hadStore: boolean = this.alsEntered;
    const previous: any = this.alsStore;
    const wasDisabled: boolean = this.alsDisabled;
    this.alsDisabled = false;
    this.alsEntered = true;
    this.alsStore = store;
    const passed: any[] = __alsSpread(args);
    try {
      return __evCall(callback, passed);
    } finally {
      this.alsEntered = hadStore;
      this.alsStore = previous;
      this.alsDisabled = wasDisabled;
    }
  }

  // `exit(callback, ...args)` — run outside any store.
  exit(callback: any, ...args: any[]): any {
    if (!__evIsFn(callback)) {
      throw new ERR_INVALID_ARG_TYPE("callback", "Function", callback);
    }
    const hadStore: boolean = this.alsEntered;
    const previous: any = this.alsStore;
    this.alsEntered = false;
    this.alsStore = undefined;
    const passed: any[] = __alsSpread(args);
    try {
      return __evCall(callback, passed);
    } finally {
      this.alsEntered = hadStore;
      this.alsStore = previous;
    }
  }

  // `enterWith(store)` — set the value for the remainder of this synchronous
  // extent. In Node it also propagates to everything scheduled from here; see
  // the header for why that half is missing.
  enterWith(store: any): void {
    this.alsDisabled = false;
    this.alsEntered = true;
    this.alsStore = store;
  }

  disable(): void {
    this.alsDisabled = true;
    this.alsEntered = false;
    this.alsStore = undefined;
  }
}

// A rest parameter is a real array through an `any` binding now, but it is
// copied before being forwarded so a callee that mutates it cannot reach the
// caller's frame — the same shape `src/process/process.ts` uses for `nextTick`.
function __alsSpread(args: any[]): any[] {
  const passed: any[] = [];
  if (args === undefined || args === null) return passed;
  const count = Number(args.length);
  for (let i = 0; i < count; i++) passed.push(args[i]);
  return passed;
}

// `node:async_hooks` module object for the bundler's `require` rewriting. Only
// the implemented surface is published: a test that reaches for `createHook`
// gets `undefined` and fails on it, rather than being handed a stub that
// silently never fires.
const __node_async_hooks: any = {
  AsyncLocalStorage: AsyncLocalStorage,
};

// node:domain — the whole deprecated `Domain` surface, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// Node's own `test/parallel/test-domain-*.js` files (see ../../test/domain/).
// The algorithms follow Node's `lib/domain.js` (MIT, Copyright Joyent, Inc.
// and other Node contributors) line for line, because almost nothing about a
// domain is derivable: the order in which `_errorHandler` pops the stack, the
// way `emit` truncates it to the first non-duplicate frame and then restores
// it, the `domain`/`domainEmitter`/`domainBound`/`domainThrown` decoration of
// the error and the interaction with
// `process.setUncaughtExceptionCaptureCallback` are all observable through the
// corpus and nowhere else specified.
//
// Like `path` and `events`, `domain` is pure computation — no syscalls — so it
// is written in the language the platform compiles rather than behind the
// `zun_abi` boundary (PLAN.md principle 2). It is a *conditional* module in
// `tools/bundle_node_test.sh`: it reaches into `events`, `process` and
// `timers`, so inlining it into every bundle would put domain bookkeeping in
// front of corpora that never mention it.
//
// ---------------------------------------------------------------------------
// How it installs itself
// ---------------------------------------------------------------------------
//
// `lib/domain.js` is a monkey-patch. It replaces `EventEmitter.init` and
// `EventEmitter.prototype.emit`, it replaces
// `process.setUncaughtExceptionCaptureCallback`, it redefines
// `process.domain` as an accessor, and it registers an `async_hooks` hook so
// that every scheduled callback re-enters the domain that created it.
//
// None of that is expressible here. This engine has no
// function-constructor/prototype model, so there is no
// `EventEmitter.prototype` to patch (https://github.com/UrubuCode/zun/issues/25);
// a class method cannot be read as a value, so the original cannot be captured
// and delegated to (zun#19); and there is no `async_hooks` tier at all — the
// VM's unified loop (NUCLEUS §9a) exposes no continuation-local hook.
//
// So the direction is inverted: `src/events/events.ts` declares one record,
// `__domainHooks`, whose every slot is `null`, and this file is its only
// writer. The other three modules consult it:
//
//   * `events` — `EventEmitter`'s constructor and `init()` call the `init`
//     slot (Node's patched `EventEmitter.init`), and `EventEmitter.emit` calls
//     the `emit` slot ahead of the real dispatch (Node's patched
//     `EventEmitter.prototype.emit`). `process.emit` goes straight to
//     `__evEmit`, which *is* Node's `this === process` exclusion.
//   * `process` — `nextTick` stamps each entry with `__domainHooks.active`,
//     and the drain calls the `callback` slot for an entry that carries one.
//     `setUncaughtExceptionCaptureCallback` calls the `blockCapture` slot.
//   * `timers` — a `Timeout`/`Immediate` records `__domainHooks.active` in its
//     `_domain` field at construction, and the fire path hands it to the
//     `callback` slot.
//
// The `callback` slot owns the *whole* invocation — enter, call, route a
// throw, exit — because the routing has to happen while the domain is still on
// the stack: `process.domain._errorHandler(er)` is how Node's capture callback
// finds the domain at all. That is the exact pairing Node's `before`/`after`
// hooks give it, restricted to the three kinds of callback this runtime has.
//
// With no `domain` in the bundle every slot stays `null`, so the cost to every
// other module is one null check per emit, per constructed emitter, per tick
// and per timer fire.
//
// ---------------------------------------------------------------------------
// The honest gaps
// ---------------------------------------------------------------------------
//
//  1. **A throw out of `run`/`bind`/`intercept` is caught here.** In Node the
//     exception propagates out of `d.run(fn)` to the caller and only reaches
//     the domain if nothing catches it on the way to `process._fatalException`.
//     This engine has no uncaught-exception hook — an error that escapes the
//     main script ends the program before any JavaScript sees it (the same
//     reason `src/process/process.ts` documents
//     `setUncaughtExceptionCaptureCallback` as best effort) — so `run` and the
//     bound wrappers catch and route the error themselves, through the very
//     same `__processReportUncaught` path a timer or tick throw takes. For the
//     shape every domain test is written in, `d.run(() => { throw er; })` at
//     the top level of a program, that is exactly Node's outcome. It deviates
//     only when the *caller* would have caught the throw itself
//     (`try { d.run(f) } catch {}`), where Node never consults the domain and
//     this does.
//  2. **Promise continuations carry no domain.** Node pairs a promise with the
//     active domain through `async_hooks`, so `process.domain` is still the
//     domain inside a `.then()`. There is no hook to do that on (see
//     ../async_hooks/async_hooks.ts for the same gap in
//     `AsyncLocalStorage`), and faking it by never restoring the value would
//     leak a context into every unrelated continuation. `test-domain-promise.js`
//     measures this and is recorded as a blocker in ../../test/domain/README.md.
//  3. **`d.bind(cb)`'s result carries no `domain` property.** A function loses
//     its own properties when it crosses the `Any` lane (zun#50), and the
//     wrapper has to cross it to be returned at all.
//  4. **`Domain.prototype.dispose` is absent**, as it is in Node 25: it was
//     removed from `lib/domain.js` long ago, and the oracle is Node 25.
//  5. **`err.domain` is defined, but `err.domainEmitter`/`domainBound`/
//     `domainThrown` are plain own properties**, as in Node. A *function*
//     error (`d.run(() => { throw () => {} })`) is not decorated at all:
//     `Object.*` reflection aborts the program when its target is a function
//     (zun#49), and Node's own decoration of one is unobservable through the
//     corpus (`test-domain-error-types.js` only checks identity).
//  6. **Decorating an error makes its `name` and `stack` unreadable** — not a
//     choice, an engine defect this module found: once an `Error` carries any
//     added own property, `err.name` and `err.stack` throw `Cannot read
//     private member from an object whose class did not declare it` *even
//     through an `any` alias*, which makes `util.inspect(err)` (and therefore
//     `console.error(err)`) die. There is no way to decorate the error the way
//     Node does and avoid it; the two-line repro and the code site are in
//     ../../test/domain/README.md, and it is the sole blocker of
//     `test-domain-implicit-fs.js`.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * every method delegates to a top-level `__dom*` function that takes the
//     domain as an `any` parameter. The stack holds domains as plain `any`
//     values, and a *computed* method call on a statically typed class
//     instance throws "undefined is not a function" (zun#24), so
//     `stack[i].enter()` is not a spelling this module can use. The functions
//     are also what the hook slots hold.
//   * the stack lives in `__domainState.stack` and is **mutated in place**,
//     never reassigned: a module-level `let` reassigned inside a function
//     splits into two bindings (zun#94), and `domain._stack` has to stay the
//     same array object across the save/restore `emit` performs.
//   * `stack.splice(0)` rather than `stack.length = 0`.
//   * `name` is a **declared** field on `Domain` although Node's domain has no
//     such property: `test-domain-enter-exit.js` and `test-domain-stack.js`
//     write `a.name = 'a'`, and an undeclared key written onto a typed
//     instance poisons every later typed read of that instance (zun#37).
//     `EventEmitter` declares `domain` for the same reason, plus a second one:
//     Node's own tests read it off a statically typed emitter (`e.domain`),
//     which is a compile error for a field no class declares.
//   * `__domDefine` (`Object.defineProperty`) is used for the non-enumerable
//     `domain` property Node gives an **error**, and never on a class
//     instance: a property added to one from outside poisons every later typed
//     read of its own fields (zun#37 again — `Timeout.unref()`'s `this._refed`
//     is the repro). An emitter takes a plain assignment into its declared
//     field instead, so its `domain` is enumerable where Node's is not.
//   * every wrapper this module hands back (`bind`, `intercept`, and the two
//     `process` listeners) goes through `__evBox`: a function value cannot be
//     returned out of a class method, and the box is what keeps one identity
//     for `removeListener` (see `__evBox` in ../events/events.ts).
//   * `__processUncaught.callback` is written directly rather than through
//     `process.setUncaughtExceptionCaptureCallback`, which this module has
//     just made throw. Node does the same thing, keeping a reference to the
//     original function before replacing it.

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `lib/internal/errors.js`' two domain codes, spelled as Node spells them.
class ERR_DOMAIN_CALLBACK_NOT_AVAILABLE extends NodeError {
  constructor() {
    super(
      "ERR_DOMAIN_CALLBACK_NOT_AVAILABLE",
      "A callback was registered through " +
        "process.setUncaughtExceptionCapture(), which is mutually exclusive " +
        "with using the `domain` module",
    );
  }
}

class ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE extends NodeError {
  constructor() {
    super(
      "ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE",
      "The `domain` module is in use, which is mutually exclusive with calling " +
        "process.setUncaughtExceptionCapture()",
    );
  }
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
//
// `stack` is Node's `domain._stack`: one frame per `enter()`, so entering the
// same domain twice pushes it twice and `exit()` pops back to the *last*
// occurrence. The active domain is `__domainHooks.active`, which is the slot
// `process` and `timers` read, and `process.domain` mirrors it — Node keeps the
// same three names in step (`exports.active`, `process.domain`, `stack`).
const __domainState: any = {
  stack: [],
  // The boxed capture callback, the boxed stack-clearing 'uncaughtException'
  // listener and the boxed 'newListener'/'removeListener' listener a `Domain`
  // installs on itself — each created once so that identity holds for
  // `removeListener`.
  capture: undefined,
  clear: undefined,
  update: undefined,
};

function __domStack(): any {
  return __domainState.stack;
}

// `exports.active = process.domain = <d>`. Node distinguishes `null` (nothing
// is active, set explicitly) from `undefined` (the stack ran empty through
// `exit()`), and `test-timers-reset-process-domain-on-throw.js` compares
// against *both* in one file — `undefined` inside a domain error handler,
// `null` in a timer scheduled before any domain existed — so the two are kept
// apart here as well.
function __domSetActive(value: any): void {
  __domainHooks.active = value;
  process.domain = value;
}

// ---------------------------------------------------------------------------
// Property helpers
// ---------------------------------------------------------------------------

// Node's `ObjectDefineProperty(target, 'domain', { configurable: true,
// enumerable: false, value, writable: true })`.
//
// Called only on an error (see `__domSetOf`). Every call makes that error's
// `name` and `stack` unreadable for the rest of the program — gap 6 in the
// header — which is not avoidable while still giving Node's `err.domain`.
function __domDefine(target: any, key: string, value: any): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: false,
    value: value,
    writable: true,
  });
}

// Read and write `<target>.domain`, which is three things in this runtime.
//
//   * An `EventEmitter` — a `Domain` included — **declares** the field, so it
//     is a plain read and a plain assignment.
//   * A `Timeout`/`Immediate` is what Node's comment on `add()` means by "this
//     works for timers as well": in Node the timer is its own async resource
//     and the async_hooks init hook hangs a `domain` property on it. Here the
//     same fact lives in the timer's declared `_domain` field, which is what
//     `src/timers/timers.ts` consults when it fires, and a property added to a
//     class instance from outside would poison its own typed reads (zun#37 —
//     `unref()`'s `this._refed` is the repro).
//   * Anything else — an error — gets Node's non-enumerable own property.
//
// The read goes through an `any` receiver, so a target without the property
// answers `undefined` instead of being a compile error.
function __domOf(target: any): any {
  if (target instanceof Timeout || target instanceof Immediate) return target._domain;
  return target.domain;
}

function __domSetOf(target: any, value: any): void {
  if (target instanceof Timeout || target instanceof Immediate) {
    target._domain = value;
    return;
  }
  if (target instanceof EventEmitter) {
    target.domain = value;
    return;
  }
  __domDefine(target, "domain", value);
}

// Is this value something the error decoration may be written onto? Node
// accepts an object or a function; `Object.*` reflection aborts the program
// when handed a function (zun#49), so only the object half is decorated here.
function __domDecorable(value: any): boolean {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// The uncaught-exception capture callback
// ---------------------------------------------------------------------------
//
// `lib/domain.js`' `updateExceptionCapture`: while *some* domain on the stack
// has an 'error' listener, the process-wide capture callback is this module's,
// which routes the error to `process.domain`; otherwise it is cleared, so an
// uncaught exception reaches `process.on('uncaughtException')` as it normally
// would. That single rule is what makes a domain without an error handler
// transparent, which is the whole of `test-domain-uncaught-exception.js`.
function __domCaptureCallback(er: any): any {
  return __domErrorHandler(process.domain, er);
}

function __domUpdateExceptionCapture(): void {
  const stack: any = __domStack();
  const count: number = Number(stack.length);
  let handled: boolean = false;
  for (let i = 0; i < count; i++) {
    if (Number(__evCountOf(stack[i], "error")) > 0) {
      handled = true;
      break;
    }
  }
  __processUncaught.callback = handled ? __domainState.capture : undefined;
}

// `lib/domain.js`' `domainUncaughtExceptionClear`: an uncaught exception ends
// the current tick, and no domain may be left on the stack between ticks.
function __domainUncaughtExceptionClear(): void {
  __domStack().splice(0);
  __domSetActive(null);
  __domUpdateExceptionCapture();
}

// The 'newListener'/'removeListener' listener a `Domain` installs on itself.
// Node passes `updateExceptionCapture` directly; it is wrapped here because
// the two events carry `(type, listener)` and a declared function may not be
// called with more arguments than it takes (zun#61).
function __domOnListenerChange(type?: any, listener?: any): void {
  __domUpdateExceptionCapture();
}

// Node makes sure the stack-clearing listener is always the *first*
// 'uncaughtException' listener, by watching `process`' own 'newListener' and
// 'removeListener' events. Reproduced exactly: without it, a test's
// `process.on('uncaughtException')` handler would see a stale domain stack,
// which is what `test-domain-stack-empty-in-process-uncaughtexception.js`
// measures.
function __domOnNewListener(name: any, listener: any): void {
  if (name !== "uncaughtException") return;
  if (__evSame(listener, __domainState.clear)) return;
  process.removeListener(name, __domainState.clear);
  process.prependListener(name, __domainState.clear);
}

function __domOnRemoveListener(name: any, listener: any): void {
  if (name !== "uncaughtException") return;
  if (__evSame(listener, __domainState.clear)) return;
  const listeners: any[] = process.listeners("uncaughtException");
  if (Number(listeners.length) === 1 && __evSame(listeners[0], __domainState.clear)) {
    process.removeListener(name, __domainState.clear);
  }
}

// ---------------------------------------------------------------------------
// enter / exit
// ---------------------------------------------------------------------------

function __domEnter(d: any): void {
  // Note that this may be a no-op, but the frame is still pushed so that it
  // can be popped later — Node's own comment.
  __domSetActive(d);
  __domStack().push(d);
  __domUpdateExceptionCapture();
}

function __domExit(d: any): void {
  const stack: any = __domStack();
  const index: number = Number(stack.lastIndexOf(d));
  if (index === -1) return;
  // Exit every domain above this one as well.
  stack.splice(index);
  const length: number = Number(stack.length);
  __domSetActive(length === 0 ? undefined : stack[length - 1]);
  __domUpdateExceptionCapture();
}

// ---------------------------------------------------------------------------
// The error handler
// ---------------------------------------------------------------------------
//
// `Domain.prototype._errorHandler`, which Node reaches through the capture
// callback from `process._fatalException`.
function __domErrorHandler(d: any, er: any): boolean {
  // `updateExceptionCapture` keeps the capture callback installed only while
  // some domain is on the stack, so `process.domain` is never empty here —
  // Node would simply `TypeError` on `process.domain._errorHandler` if it
  // were. Rather than turn that into a confusing crash, an empty domain means
  // the error is genuinely uncaught and goes back to `process` with the
  // callback cleared, which cannot recurse.
  if (d === null || d === undefined) {
    __processUncaught.callback = undefined;
    __domainUncaughtExceptionClear();
    __processReportUncaught(er);
    return false;
  }

  let caught: boolean = false;
  if (__domDecorable(er)) {
    __domDefine(er, "domain", d);
    er["domainThrown"] = true;
  }

  // Pop every adjacent duplicate of the currently active domain, so that the
  // error handler does not run inside the very domain whose error it is —
  // otherwise an exception thrown in the handler would re-enter it. `exit()` is
  // a documented no-op for a domain that is not on the stack, so the loop also
  // watches the stack shrink: Node's unguarded `while` would spin forever on a
  // hand-assigned `domain.active`.
  while (__domainHooks.active === d) {
    const before: number = Number(__domStack().length);
    __domExit(d);
    if (Number(__domStack().length) >= before) {
      __domSetActive(undefined);
      break;
    }
  }

  const stack: any = __domStack();
  if (Number(stack.length) === 0) {
    // With no error handler, do *not* emit: that would throw, end the process
    // and prevent `process.on('uncaughtException')` from ever seeing the error.
    if (Number(__evCountOf(d, "error")) > 0) {
      // Clear the capture callback first: the top-level domain is no longer
      // active, so an uncaught exception from here on is genuinely uncaught.
      __processUncaught.callback = undefined;
      try {
        caught = __domEmitError(d, er);
      } finally {
        __domUpdateExceptionCapture();
      }
    }
  } else {
    // One of three things happens: there is a handler (caught), there is none
    // (not caught), or the handler throws — in which case the next domain down
    // gets a chance at *that* error, and failing that it is re-thrown.
    try {
      caught = __domEmitError(d, er);
    } catch (second) {
      __domUpdateExceptionCapture();
      const length: number = Number(stack.length);
      if (length > 0) {
        __domSetActive(stack[length - 1]);
        caught = __domErrorHandler(process.domain, second);
      } else {
        __domainUncaughtExceptionClear();
        throw second;
      }
    }
  }

  __domainUncaughtExceptionClear();
  return caught;
}

// `this.emit('error', er)` from inside `lib/domain.js` goes through the
// *patched* emit, so a domain that is itself a member of another domain routes
// its error onward. `__domainEmit` is that patched emit.
function __domEmitError(d: any, er: any): boolean {
  return __domainEmit(d, "error", [er]);
}

// `process._fatalException` for the three callback boundaries this runtime
// owns: the monitor event, then the capture callback (this module's, whenever
// some domain on the stack has an 'error' listener), then
// `process.on('uncaughtException')`, then the crash.
// `src/process/process.ts` already performs exactly that order.
function __domFatal(er: any): void {
  __processReportUncaught(er);
}

// ---------------------------------------------------------------------------
// The hook slots
// ---------------------------------------------------------------------------

// Node's patched `EventEmitter.init`. An emitter constructed while a domain is
// active becomes a member of it implicitly — which is what makes
// `test-domain-ee-implicit.js` work — and a `Domain` is excluded, so that
// `domain.create()` inside a `run()` does not bind itself to its parent.
function __domainInit(target: any): void {
  const active: any = __domainHooks.active;
  if (active === null || active === undefined) return;
  if (target instanceof Domain) return;
  target.domain = active;
}

// Node's patched `EventEmitter.prototype.emit`.
function __domainEmit(target: any, type: any, args: any[]): boolean {
  const d: any = __domOf(target);
  const shouldEmitError: boolean = type === "error" && Number(__evCountOf(target, type)) > 0;

  // Plain dispatch when the emitter handles its own 'error', or when there is
  // no domain on it at all. `process` never reaches here: `process.emit` calls
  // `__evEmit` directly.
  if (shouldEmitError || d === null || d === undefined) {
    return __evEmit(target, type, args);
  }

  if (type === "error") {
    // `emit('error')` with no argument, or a falsy one, is Node's
    // ERR_UNHANDLED_ERROR. The type is spelled `args[0]` rather than Node's
    // `args[1]` because the event name is a separate parameter here.
    let er: any = Number(args.length) > 0 ? args[0] : undefined;
    // Node's test is plain truthiness (`args[1] ? args[1] : new
    // ERR_UNHANDLED_ERROR()`); it is routed through a boolean because `!x` on
    // an `any` is unreliable (zun#13).
    const present: boolean = er ? true : false;
    if (!present) er = new ERR_UNHANDLED_ERROR(undefined);

    if (__domDecorable(er)) {
      er["domainEmitter"] = target;
      __domDefine(er, "domain", d);
      er["domainThrown"] = false;
    }

    // Take the current domain — and every adjacent duplicate of it — off the
    // stack, so the error handler does not run inside its own context; then
    // put the stack back exactly as it was. The array is mutated in place
    // rather than swapped, because `domain._stack` is a stable object here.
    const stack: any = __domStack();
    const saved: any[] = [];
    const depth: number = Number(stack.length);
    for (let i = 0; i < depth; i++) saved.push(stack[i]);
    const savedActive: any = process.domain;

    // Walk down to the first frame that is not a duplicate of the active one.
    let idx: number = depth - 1;
    while (idx > -1 && process.domain === stack[idx]) idx = idx - 1;
    stack.splice(idx < 0 ? 0 : idx + 1);

    const remaining: number = Number(stack.length);
    __domSetActive(remaining > 0 ? stack[remaining - 1] : null);
    __domUpdateExceptionCapture();

    __domEmitError(d, er);

    stack.splice(0);
    const count: number = Number(saved.length);
    for (let i = 0; i < count; i++) stack.push(saved[i]);
    __domSetActive(savedActive);
    __domUpdateExceptionCapture();

    return false;
  }

  __domEnter(d);
  const result: boolean = __evEmit(target, type, args);
  __domExit(d);
  return result;
}

// Node's `async_hooks` `before`/`after` pair, for the callbacks this runtime
// has: a `process.nextTick` entry, a `Timeout` and an `Immediate`. The throw is
// routed from *inside* the domain, because `__domCaptureCallback` finds the
// domain through `process.domain`.
function __domainRunCallback(d: any, fn: any, args: any[]): void {
  __domEnter(d);
  try {
    __evCall(fn, args);
  } catch (error) {
    __domFatal(error);
  }
  __domExit(d);
}

// `process.setUncaughtExceptionCaptureCallback` once `domain` is loaded. Node
// also appends the `require('domain')` stack to the error's own, separated by
// forty dashes; `Error.prototype.stack` cannot be assigned here (zun#74), so
// the message and the code are all this carries.
function __domainBlockCapture(): void {
  throw new ERR_DOMAIN_CANNOT_SET_UNCAUGHT_EXCEPTION_CAPTURE();
}

// ---------------------------------------------------------------------------
// bound and intercepted wrappers
// ---------------------------------------------------------------------------

function __domSpread(args: any): any[] {
  const passed: any[] = [];
  if (args === undefined || args === null) return passed;
  const count: number = Number(args.length);
  for (let i = 0; i < count; i++) passed.push(args[i]);
  return passed;
}

// `lib/domain.js`' `bound(_this, self, cb, fnargs)`. The `catch` is gap 1 in
// the header: Node lets the throw leave the wrapper.
function __domBound(d: any, cb: any, fnargs: any[]): any {
  __domEnter(d);
  let result: any = undefined;
  try {
    result = __evCall(cb, fnargs);
  } catch (error) {
    __domFatal(error);
    return undefined;
  }
  __domExit(d);
  return result;
}

// `lib/domain.js`' `intercepted(_this, self, cb, fnargs)`: a Node-style
// `(err, ...rest)` callback whose error argument is routed to the domain
// instead of being passed on.
function __domIntercepted(d: any, cb: any, fnargs: any[]): any {
  const first: any = Number(fnargs.length) > 0 ? fnargs[0] : undefined;
  const truthy: boolean = first ? true : false;
  if (truthy && first instanceof Error) {
    if (__domDecorable(first)) {
      first["domainBound"] = cb;
      first["domainThrown"] = false;
      __domDefine(first, "domain", d);
    }
    __domEmitError(d, first);
    return undefined;
  }
  const rest: any[] = [];
  const count: number = Number(fnargs.length);
  for (let i = 1; i < count; i++) rest.push(fnargs[i]);
  return __domBound(d, cb, rest);
}

// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

class Domain extends EventEmitter {
  members: any[] = [];
  // `name` is declared although Node's `Domain` has no such property: see the
  // engine notes above. `domain` is inherited from `EventEmitter`, which
  // declares it for the same reason.
  name: any = undefined;

  constructor() {
    super();
    this.members = [];
    // The capture callback has to be re-evaluated whenever an 'error' listener
    // appears or goes away, which is exactly what Node does here.
    this.on("removeListener", __domainState.update);
    this.on("newListener", __domainState.update);
  }

  enter(): void {
    __domEnter(this);
  }

  exit(): void {
    __domExit(this);
  }

  // Called by `__domCaptureCallback` in place of Node's `process._fatalException`.
  _errorHandler(er: any): boolean {
    return __domErrorHandler(this, er);
  }

  // `add(ee)` — take ownership of an emitter (or a timer: Node's comment notes
  // that this works for those too).
  add(ee: any): void {
    if (ee === null || ee === undefined) return;
    const owner: any = __domOf(ee);
    if (owner === this) return;
    // Already owned elsewhere: hand it over.
    if (owner !== null && owner !== undefined) __domRemove(owner, ee);
    // Refuse a circular Domain -> Domain link, which would overflow the stack
    // the first time either one emitted an error.
    if (this.domain !== null && this.domain !== undefined && ee instanceof Domain) {
      let walk: any = this.domain;
      while (walk !== null && walk !== undefined) {
        if (ee === walk) return;
        walk = __domOf(walk);
      }
    }
    __domSetOf(ee, this);
    this.members.push(ee);
  }

  remove(ee: any): void {
    __domRemove(this, ee);
  }

  // `run(fn, ...args)`. Node's `ReflectApply(fn, this, …)` threads the domain
  // as the receiver; no receiver can be threaded here (zun#1), and no test in
  // the corpus reads `this` inside a `run` callback.
  run(fn: any, ...args: any[]): any {
    __domEnter(this);
    let result: any = undefined;
    try {
      result = __evCall(fn, __domSpread(args));
    } catch (error) {
      // Gap 1 in the header: this engine has no uncaught-exception hook, so the
      // throw is routed from here rather than from `process._fatalException`.
      __domFatal(error);
      return undefined;
    }
    __domExit(this);
    return result;
  }

  // `bind(cb)` / `intercept(cb)`. The wrapper is a function *expression* using
  // `arguments`, which is the one shape that forwards an exact argument list
  // here, and it is handed back boxed — a class method cannot return a bare
  // function value (see `__evBox`).
  bind(cb: any): any {
    const self: any = this;
    const runBound: any = function (): any {
      return __domBound(self, cb, __domSpread(arguments));
    };
    return __evBox(runBound);
  }

  intercept(cb: any): any {
    const self: any = this;
    const runIntercepted: any = function (): any {
      return __domIntercepted(self, cb, __domSpread(arguments));
    };
    return __evBox(runIntercepted);
  }
}

// `remove` as a free function, because `add` has to call it on the *other*
// domain, which it only holds as an `any` (zun#24).
function __domRemove(d: any, ee: any): void {
  if (ee === null || ee === undefined) return;
  __domSetOf(ee, null);
  const members: any = d.members;
  if (members === undefined || members === null) return;
  const at: number = Number(members.indexOf(ee));
  if (at !== -1) members.splice(at, 1);
}

function __domainCreate(): any {
  return new Domain();
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

// Node throws ERR_DOMAIN_CALLBACK_NOT_AVAILABLE at *load* time when a capture
// callback is already registered: domains claim it exclusively. A module is
// inlined here rather than required, so "load time" is this statement, which
// runs before the test body.
if (process.hasUncaughtExceptionCaptureCallback()) {
  throw new ERR_DOMAIN_CALLBACK_NOT_AVAILABLE();
}

__domainState.capture = __evBox(__domCaptureCallback);
__domainState.clear = __evBox(__domainUncaughtExceptionClear);
__domainState.update = __evBox(__domOnListenerChange);

__evInstallDomainHooks({
  init: __evBox(__domainInit),
  emit: __evBox(__domainEmit),
  callback: __evBox(__domainRunCallback),
  blockCapture: __evBox(__domainBlockCapture),
});

// `events.usingDomains` is Node's own flag, flipped by `lib/domain.js`.
__node_events.usingDomains = true;

process.on("newListener", __evBox(__domOnNewListener));
process.on("removeListener", __evBox(__domOnRemoveListener));

// ---------------------------------------------------------------------------
// Module object
//
// `tools/bundle_node_test.sh` rewrites `require('domain')` /
// `require('node:domain')` to this object, and `<alias>.Domain` to the class
// itself — `new <object>.Ctor()` does not reach a constructor in this engine
// (zun#18) while Node's own tests spell it `new domain.Domain()`.
//
// `_stack` is the live array, which is why `__domEnter`/`__domExit` mutate it
// in place: Node's tests compare `domain._stack` against a literal with
// `assert.deepStrictEqual` after every push and pop.
// ---------------------------------------------------------------------------

const __node_domain: any = {
  Domain: Domain,
  create: __domainCreate,
  createDomain: __domainCreate,
  _stack: __domainState.stack,
  get active(): any {
    return __domainHooks.active;
  },
  set active(value: any) {
    __domSetActive(value);
  },
};

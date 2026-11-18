// node:worker_threads — the message-port family in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// 100% of Node's own `test/parallel/test-worker-*.js`,
// `test-messagechannel*.js`, `test-messageport*.js` and
// `test-broadcastchannel*.js` files (see ../../test/worker_threads/). The
// hybrid `EventTarget`/`EventEmitter` dispatch, the port reference counting,
// the transfer-list validation order, the `DataCloneError` messages and the
// `Worker` constructor's validation sequence all follow Node's
// `lib/internal/worker/io.js`, `lib/internal/event_target.js` and
// `lib/internal/worker.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors), because those are observable through the corpus rather than
// derivable from any general rule.
//
// ---------------------------------------------------------------------------
// Two layers, and why only one of them is here
// ---------------------------------------------------------------------------
//
// `node:worker_threads` is two things wearing one name:
//
//   1. **The message-port family** — `MessageChannel`, `MessagePort`,
//      `MessageEvent`, `BroadcastChannel`, `receiveMessageOnPort`, the
//      transfer/clone rules, the `environmentData` map and the thread-identity
//      constants. Every one of those is *in-process*: a channel is two queues
//      and a dispatch rule, and Node's own semantics for them are defined
//      without reference to a second thread. That is what this file is, and it
//      is complete.
//
//   2. **`Worker`** — a second JavaScript realm. The Zun VM has one thread
//      and one realm, so a worker is a child Zun process linked to this one
//      over a loopback socket; see "The Worker process" below.
//
// Unlike `path`, this module is not pure computation: a port delivers its
// messages on a later loop turn. The capability it needs for that — the
// macrotask tier of the VM's unified event loop — is already inside the
// engine and already wrapped by `src/timers/timers.ts`, so (as with `timers`
// itself) there is nothing for a native extension to do. Nothing in this file
// imports a native.
//
// ---------------------------------------------------------------------------
// Where the message queue lives, and when it drains
// ---------------------------------------------------------------------------
//
// Each `MessagePort` owns its *incoming* queue. `a.postMessage(v)` clones `v`,
// pushes the clone onto `b`'s queue and arms one drain of `b`. A drain takes a
// snapshot of the queue, empties it and dispatches the snapshot; a message
// posted *during* a drain lands in the queue the next drain will take, which is
// what keeps an `on('message')` handler that posts back to itself from starving
// the loop (`test-worker-message-port-infinite-message-loop.js` asserts exactly
// that). The drain is armed through `setImmediate`, which is the closest tier
// the VM offers to the libuv async handle Node uses, and it is `unref()`'d when
// the port is — so a port nobody is listening to neither ends the run early nor
// keeps it alive, which is also Node's rule.
//
// A port is created *stopped* and *unref'd*. The first `'message'` listener
// (through `on`, `addEventListener` or the `onmessage` setter) `ref()`s and
// `start()`s it; removing the last one stops and unrefs it again. That is
// `setupPortReferencing` in `lib/internal/worker/io.js`, and it is what
// `hasRef()` reports.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * **`MessageChannel` is declared as `__zunMessageChannel`.** The engine's
//     prelude already has a `MessageChannel` of its own
//     (`crates/zun_prelude/builtin/async.zun`, two dynamic objects delivering
//     `{ data }` to `onmessage` on a `setTimeout(0)`), and a top-level
//     `class MessageChannel` in the program is rejected outright with
//     `[SEM0001] duplicate class` — a prelude class cannot be shadowed the way
//     `src/timers/timers.ts` shadows the timer *intrinsics*. So the real class
//     is bound to a second name the checker has no opinion about and
//     `tools/bundle_node_test.sh` rewrites the spelling Node programs use,
//     exactly as it does for `console`, `performance` and `crypto`. The two
//     names denote the same class. `MessagePort`, `MessageEvent`,
//     `BroadcastChannel` and `__WtDOMException` are *not* in the prelude, so they
//     keep their own names.
//   * **No `[util.inspect.custom]` on a port or a channel.** A symbol-keyed own
//     property written onto a *class instance* reads back `undefined`, through
//     a plain assignment and through `Object.defineProperty` alike (it works on
//     a plain object), so the custom inspector `lib/internal/worker/io.js`
//     installs on `MessagePort.prototype` and `BroadcastChannel.prototype`
//     cannot be installed here. `util.inspect` therefore prints the generic
//     class body. Trading the class away for a dynamic object would cost
//     `port instanceof MessagePort` and `port.constructor === MessagePort`,
//     which more of the corpus depends on. See ../../test/worker_threads/README.md.
//   * **`port.onmessage = fn` is rewritten by the bundler to the backing slot
//     (`port.__wtHandlers.message`).** `onmessage`/`onmessageerror` are
//     accessor pairs on both classes, as they are in Node
//     (`defineEventHandler`), and in this engine a class accessor's **setter is
//     not invoked** for an assignment through an `any`-typed receiver — while
//     the *getter* is invoked on a read, which is what makes the asymmetry a
//     bug rather than a missing feature. There is no fallback either: a
//     function written into a declared `any` field of a class instance is
//     discarded (zun#78) and an expando on one reads back `undefined`, so no
//     slot on the instance is reachable from plain JavaScript. The accessors
//     and the rewrite read and write the very same slot, so the two spellings
//     agree; what is lost is the *hook*, which is why `__wtPortStarted`,
//     `hasRef()` and `__wtListenerCount` ask the slot every time instead of
//     refing and starting the port at the moment of assignment, and why the
//     handler dispatches after the registered listeners of its type rather
//     than at the position the first assignment put it.
//   * **Delivery uses two macrotask tiers.** The VM's loop has no check phase:
//     `src/timers/timers.ts` arms a `setImmediate` as an engine timer with a
//     0 ms delay and a `setTimeout(fn, 0)` as one with 1 ms (Node's own clamp),
//     and the virtual clock does not advance while 0 ms work remains. A drain
//     that re-armed itself on the immediate tier would starve every timer in
//     the program, so a drain armed from inside another drain goes on the timer
//     tier — see `__wtArmDrain`.
//   * `__wtReadIterable` reads a transfer list with `for (… of …)` inside a
//     `try`, never through the iterator protocol by hand: a generator object's
//     `[Symbol.iterator]` reads back `undefined` here, so the by-hand form
//     declares `(function*(){ yield ab; })()` non-iterable. `for`-of over a
//     **non-object** aborts the VM uncatchably ("call did not resolve to a
//     method"), so the object test comes first and is not negotiable.
//   * `Number(x.length)` throughout: the checker types `.length` as `u64`, so
//     it can be neither assigned to nor passed as a `number` (zun#3).
//   * Every listener is stored through `__evBox` (../events/events.ts): a bare
//     function loses its own properties on the way into an array and is not
//     found by `indexOf` (zun#17). `__evCall` invokes it, because `apply`/`call`
//     thread no receiver in this engine (zun#1) — so a listener sees no `this`,
//     where Node's `EventTarget` calls it with the target as the receiver.
//   * Each port's state lives in **declared** fields. Writing an undeclared key
//     onto a typed instance through an `any` alias poisons every later
//     statically typed read of that instance (zun#37), and the ports are
//     handed to test code as `any` throughout.
//   * `markAsUntransferable` / `markAsUncloneable` keep their marks in a `Map`
//     side table rather than on the object, for the symbol-key reason above —
//     and because the mark must not be inherited by an instance of a marked
//     prototype, which a side table gives for free.

// ---------------------------------------------------------------------------
// __WtDOMException
// ---------------------------------------------------------------------------

// The legacy error-code table from the DOM spec, reduced to the names this
// module raises. `err.code` is the number, `err.name` is the string, and
// `String(err)` is `"<name>: <message>"` — which is how four files in the
// corpus spell "this must be a DataCloneError".
const __WT_DOM_CODES: string[] = [
  "IndexSizeError",
  "DOMStringSizeError",
  "HierarchyRequestError",
  "WrongDocumentError",
  "InvalidCharacterError",
  "NoDataAllowedError",
  "NoModificationAllowedError",
  "NotFoundError",
  "NotSupportedError",
  "InUseAttributeError",
  "InvalidStateError",
  "SyntaxError",
  "InvalidModificationError",
  "NamespaceError",
  "InvalidAccessError",
  "ValidationError",
  "TypeMismatchError",
  "SecurityError",
  "NetworkError",
  "AbortError",
  "URLMismatchError",
  "QuotaExceededError",
  "TimeoutError",
  "InvalidNodeTypeError",
  "DataCloneError",
];

// The "this argument was not passed at all" sentinel.
//
// `arguments.length` is the test Node uses to tell `postMessage()` from
// `postMessage(undefined)`, and `arguments` is not reliable inside a class
// method in this engine, so a private default value carries the same
// distinction: a caller cannot produce it, and `undefined` stays a value a
// caller may legitimately post.
const __WT_MISSING: any = { token: "zun-node:worker_threads:missing" };

function __wtDomCode(name: string): number {
  const index = Number(__WT_DOM_CODES.indexOf(name));
  if (index === -1) return 0;
  return index + 1;
}

class __WtDOMException extends Error {
  code: number = 0;
  constructor(message: string = "", name: string = "Error") {
    super(message);
    this.name = name;
    this.code = __wtDomCode(name);
  }
}

function __wtDataCloneError(message: string): any {
  return new __WtDOMException(message, "DataCloneError");
}

// ---------------------------------------------------------------------------
// MessageEvent
// ---------------------------------------------------------------------------
//
// `new MessageEvent(type, init?)`, with the `data`/`origin`/`lastEventId`/
// `source`/`ports` members the WHATWG definition gives it. The validation
// messages are the ones undici's `createFastMessageEvent` raises, because
// `test-worker-message-event.js` matches them verbatim.

function __wtIsObjectLike(value: any): boolean {
  if (value === null || value === undefined) return false;
  const kind = typeof value;
  return kind === "object" || kind === "function";
}

function __wtInspectShort(value: any): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "object" && !Array.isArray(value)) {
    const keys: any[] = Object.keys(value);
    if (Number(keys.length) === 0) return "{}";
  }
  return String(value);
}

class MessageEvent extends Event {
  data: any = null;
  origin: string = "";
  lastEventId: string = "";
  source: any = null;
  ports: any[] = [];

  constructor(type: any, init: any = null) {
    super(String(type), init);
    this.data = null;
    this.origin = "";
    this.lastEventId = "";
    this.source = null;
    this.ports = [];
    if (init === null || init === undefined) return;
    const data: any = init.data;
    if (data !== undefined) this.data = data;
    const origin: any = init.origin;
    if (origin !== undefined) this.origin = String(origin);
    const lastEventId: any = init.lastEventId;
    if (lastEventId !== undefined) this.lastEventId = String(lastEventId);
    const source: any = init.source;
    if (source !== undefined && source !== null) {
      if (!(source instanceof MessagePort)) {
        throw new TypeError(
          "MessageEvent constructor: Expected eventInitDict.source (\"" +
            __wtInspectShort(source) +
            "\") to be an instance of MessagePort.",
        );
      }
      this.source = source;
    }
    const ports: any = init.ports;
    if (ports !== undefined && ports !== null) {
      const list: any[] | null = __wtReadIterable(ports);
      if (list === null) {
        throw new TypeError(
          "MessageEvent constructor: eventInitDict.ports (" +
            __wtInspectShort(ports) +
            ") is not iterable.",
        );
      }
      const collected: any[] = [];
      for (const port of list) {
        if (!(port instanceof MessagePort)) {
          throw new TypeError(
            "MessageEvent constructor: Expected eventInitDict.ports[" +
              String(Number(collected.length)) +
              "] (\"" +
              __wtInspectShort(port) +
              "\") to be an instance of MessagePort.",
          );
        }
        collected.push(port);
      }
      this.ports = collected;
    }
  }
}

// ---------------------------------------------------------------------------
// The hybrid listener machinery (lib/internal/event_target.js)
// ---------------------------------------------------------------------------
//
// Node's `MessagePort` and `BroadcastChannel` are `NodeEventTarget`s: one
// listener list serving two calling conventions. A listener added through
// `addEventListener` (or an `onmessage` assignment) is handed the `Event`; one
// added through `on`/`once`/`addListener` is handed the *raw value* instead.
// `kHybridDispatch` is the single routine that knows both, and it creates the
// event lazily, so `port.on('message', …)` never allocates one.
//
// Both classes declare `__wtEntries`, `__wtHandlers` and `__wtMaxListeners`,
// and the free functions below operate on either — which is also why they are
// free functions: a method a class declares cannot be inherited into the other
// class without a shared base, and a shared base would have to be the prelude's
// `EventTarget`, whose own storage is unreachable from TypeScript.

const __WT_DEFAULT_MAX_LISTENERS: number = 10;

function __wtEntryNew(type: any, listener: any, once: boolean, capture: boolean, nodeStyle: boolean): any {
  return {
    type: String(type),
    callback: __evBox(listener),
    once: once,
    capture: capture,
    nodeStyle: nodeStyle,
    removed: false,
  };
}

function __wtCaptureOf(options: any): boolean {
  if (options === null || options === undefined) return false;
  if (options === true) return true;
  if (options === false) return false;
  if (typeof options !== "object") return false;
  return options.capture === true;
}

function __wtOnceOf(options: any): boolean {
  if (options === null || options === undefined) return false;
  if (typeof options !== "object") return false;
  return options.once === true;
}

// Find a live entry for (type, listener, capture). Node's `addEventListener`
// drops a duplicate regardless of the calling convention, so `nodeStyle` is not
// part of the identity.
function __wtFindEntry(target: any, type: any, listener: any, capture: boolean): number {
  const entries: any[] = target.__wtEntries;
  const key = String(type);
  const total = Number(entries.length);
  for (let i = 0; i < total; i++) {
    const entry: any = entries[i];
    if (entry.removed === true) continue;
    if (entry.type !== key) continue;
    if (entry.capture !== capture) continue;
    if (__evSame(entry.callback, listener)) return i;
  }
  return -1;
}

function __wtListenerCount(target: any, type: any): number {
  const entries: any[] = target.__wtEntries;
  const key = String(type);
  let count = 0;
  const total = Number(entries.length);
  for (let i = 0; i < total; i++) {
    const entry: any = entries[i];
    if (entry.removed !== true && entry.type === key) count = count + 1;
  }
  // An `onmessage`/`onmessageerror` handler counts as a listener in Node, and
  // that is what makes the assignment ref and start a port.
  if (__wtHandlerOf(target, key) !== null) count = count + 1;
  return count;
}

function __wtEventNames(target: any): any[] {
  const entries: any[] = target.__wtEntries;
  const names: string[] = [];
  const total = Number(entries.length);
  for (let i = 0; i < total; i++) {
    const entry: any = entries[i];
    if (entry.removed === true) continue;
    if (Number(names.indexOf(entry.type)) === -1) names.push(entry.type);
  }
  return names;
}

// Drop the entries flagged `removed` out of the list. Dispatch runs over a
// snapshot, so a removal during dispatch only sets the flag; the compaction is
// deferred to the next structural change.
function __wtCompact(target: any): void {
  const entries: any[] = target.__wtEntries;
  const total = Number(entries.length);
  let live = 0;
  for (let i = 0; i < total; i++) {
    if (entries[i].removed !== true) live = live + 1;
  }
  if (live === total) return;
  const kept: any[] = [];
  for (let i = 0; i < total; i++) {
    if (entries[i].removed !== true) kept.push(entries[i]);
  }
  target.__wtEntries = kept;
}

// `maxListeners` is bookkeeping only: Node warns about an `EventTarget` with
// too many listeners through the same `MaxListenersExceededWarning` path
// `events` uses, and no file in this corpus asserts the warning.
function __wtAddListener(
  target: any,
  type: any,
  listener: any,
  once: boolean,
  capture: boolean,
  nodeStyle: boolean,
): void {
  if (!__evIsFn(listener)) {
    // Node's `addEventListener` ignores a null/undefined listener and throws
    // `ERR_INVALID_ARG_TYPE` for anything else that is not callable or an
    // object with `handleEvent`.
    if (listener === null || listener === undefined) return;
    throw new ERR_INVALID_ARG_TYPE("listener", ["Function", "Object"], listener);
  }
  __wtCompact(target);
  if (__wtFindEntry(target, type, listener, capture) !== -1) return;
  const before = __wtListenerCount(target, type);
  const entries: any[] = target.__wtEntries;
  entries.push(__wtEntryNew(type, listener, once, capture, nodeStyle));
  __wtListenerAdded(target, String(type), before);
}

function __wtRemoveListener(target: any, type: any, listener: any, capture: boolean): void {
  const index = __wtFindEntry(target, type, listener, capture);
  if (index === -1) return;
  const entries: any[] = target.__wtEntries;
  entries[index].removed = true;
  __wtCompact(target);
  __wtListenerRemoved(target, String(type), __wtListenerCount(target, type));
}

function __wtRemoveAllListeners(target: any, type: any, hasType: boolean): void {
  const entries: any[] = target.__wtEntries;
  const total = Number(entries.length);
  const key = hasType ? String(type) : "";
  const touched: string[] = [];
  for (let i = 0; i < total; i++) {
    const entry: any = entries[i];
    if (entry.removed === true) continue;
    if (hasType && entry.type !== key) continue;
    entry.removed = true;
    if (Number(touched.indexOf(entry.type)) === -1) touched.push(entry.type);
  }
  __wtCompact(target);
  for (const name of touched) __wtListenerRemoved(target, name, __wtListenerCount(target, name));
}

// The event a lazily created dispatch hands a DOM-style listener.
// `lib/internal/worker/io.js` overrides `kCreateEvent` so that `'message'` and
// `'messageerror'` become a `MessageEvent` carrying the data and the received
// ports, and everything else stays the `CustomEvent` the base class makes.
function __wtCreateEvent(target: any, nodeValue: any, type: string): any {
  if (type === "message" || type === "messageerror") {
    const ports: any[] = target.__wtReceivingPorts === null ? [] : target.__wtReceivingPorts;
    target.__wtReceivingPorts = null;
    return new MessageEvent(type, { data: nodeValue, ports: ports });
  }
  return new CustomEvent(type, { detail: nodeValue });
}

// `kHybridDispatch`. `event` is `null` when the caller has no `Event` of its
// own (the `emit`/incoming-message path) and the event is to be created only if
// a DOM-style listener actually needs it.
function __wtHybridDispatch(target: any, nodeValue: any, type: string, event: any): boolean {
  let created: any = event;
  const entries: any[] = target.__wtEntries;
  const snapshot: any[] = [];
  const total = Number(entries.length);
  for (let i = 0; i < total; i++) {
    const entry: any = entries[i];
    if (entry.removed !== true && entry.type === type) snapshot.push(entry);
  }
  if (created !== null && created !== undefined) {
    created.target = target;
    created.currentTarget = target;
  }
  // The event-handler slot, dispatched last. Node keeps it in the listener list
  // at the position the first assignment put it, which this engine cannot
  // reproduce (the slot is written straight through, with no setter to hook);
  // it only differs when a program mixes `onmessage` with `addEventListener`
  // for the same type, which one Windows-skipped block of
  // `test-worker-broadcastchannel-wpt.js` is alone in doing.
  const handler: any = __wtHandlerOf(target, type);
  if (handler !== null) {
    snapshot.push({ type: type, callback: handler, once: false, capture: false, nodeStyle: false, removed: false });
  }
  if (Number(snapshot.length) === 0) {
    // The ports of a message nobody is listening for are still consumed: Node
    // hands them to the event it never creates, and they are not re-delivered.
    target.__wtReceivingPorts = null;
    return true;
  }
  for (const entry of snapshot) {
    if (entry.removed === true) continue;
    if (entry.once === true) {
      entry.removed = true;
      __wtCompact(target);
      __wtListenerRemoved(target, type, __wtListenerCount(target, type));
    }
    let argument: any = nodeValue;
    if (entry.nodeStyle !== true) {
      if (created === null || created === undefined) {
        created = __wtCreateEvent(target, nodeValue, type);
        created.target = target;
        created.currentTarget = target;
      }
      argument = created;
    }
    __evCall(entry.callback, [argument]);
  }
  target.__wtReceivingPorts = null;
  if (created === null || created === undefined) return true;
  return created.defaultPrevented !== true;
}

// ---------------------------------------------------------------------------
// `onmessage` / `onmessageerror`
// ---------------------------------------------------------------------------
//
// In Node these are `defineEventHandler` accessors: the assignment registers a
// DOM-style listener (which is also what refs and starts a port), `null`
// removes it, and the getter answers whatever was assigned — `null` when
// nothing ever was.
//
// Here the handler lives in **one slot** instead, `__wtHandlers[type]`, a plain
// dynamic object held by a declared field. The accessors read and write that
// slot and so does the bundler's rewrite of `x.onmessage = fn` (the setter is
// unreachable through an `any` receiver; see the header), so both spellings
// agree — but there is no *hook*, so nothing can happen at the moment of
// assignment. Every question the hook would have answered eagerly is therefore
// asked of the slot each time instead: `__wtListenerCount` counts it,
// `__wtPortStarted` consults it, and `hasRef()` reports it.

function __wtGetEventHandler(target: any, type: string): any {
  const stored: any = target.__wtHandlers[type];
  if (stored === undefined) return null;
  return stored;
}

function __wtSetEventHandler(target: any, type: string, value: any): void {
  target.__wtHandlers[type] = value === undefined ? null : value;
}

// The handler as a *listener*, or `null`. Dispatch consults this slot directly
// instead of registering an entry for it, because the slot is the only thing
// both spellings of the assignment can agree on — see the note above.
function __wtHandlerOf(target: any, type: string): any {
  const stored: any = target.__wtHandlers[type];
  if (stored === null || stored === undefined) return null;
  if (!__evIsFn(stored)) return null;
  return stored;
}

// ---------------------------------------------------------------------------
// Side tables
// ---------------------------------------------------------------------------
//
// A `WeakMap` is still unusable here (`new WeakMap().set(key, 1)` aborts the VM
// with "call did not resolve to a method", zun#28), so these keep their keys
// alive — one entry per object a program actually marks, which is a handful.

const __wtUntransferable: any = new Map();
const __wtUncloneable: any = new Map();
// ArrayBuffers this program has already transferred. The engine cannot detach
// an `ArrayBuffer` (there is no `transfer()` and no `detached`), so a second
// transfer of one is caught by remembering the first — which is the observable
// half of the rule that `test-worker-message-port-arraybuffer.js` checks.
const __wtDetachedBuffers: any = new Map();

function __wtMarkAsUntransferable(value: any): void {
  if (!__wtIsObjectLike(value)) return;
  __wtUntransferable.set(value, true);
}

function __wtIsMarkedAsUntransferable(value: any): boolean {
  if (!__wtIsObjectLike(value)) return false;
  return __wtUntransferable.get(value) === true;
}

function __wtMarkAsUncloneable(value: any): void {
  if (!__wtIsObjectLike(value)) return;
  __wtUncloneable.set(value, true);
}

function __wtIsMarkedAsUncloneable(value: any): boolean {
  if (!__wtIsObjectLike(value)) return false;
  return __wtUncloneable.get(value) === true;
}

// ---------------------------------------------------------------------------
// Reading a transfer list
// ---------------------------------------------------------------------------

// `ReadIterable` from `src/node_messaging.cc`: `null` means "not iterable",
// which is how the two `postMessage` argument forms are told apart. The
// `for`-of is inside a `try` on purpose — see the header note.
function __wtReadIterable(value: any): any[] | null {
  if (!__wtIsObjectLike(value)) return null;
  if (Array.isArray(value)) {
    const copy: any[] = [];
    for (const item of value) copy.push(item);
    return copy;
  }
  const collected: any[] = [];
  try {
    for (const item of value) collected.push(item);
  } catch (error: any) {
    return null;
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Cloning a message
// ---------------------------------------------------------------------------
//
// The structured-clone algorithm, reduced to the value kinds this engine has
// and this corpus posts. Two rules carry the weight:
//
//   * a value that must be *transferred* rather than cloned (a `MessagePort`)
//     is replaced by its transferred counterpart when it is in the transfer
//     list, and is a `DataCloneError` when it is not;
//   * a function, a symbol, or an object marked uncloneable is a
//     `DataCloneError`, which is what makes a `workerData` holding a closure
//     fail at construction time rather than at delivery time.
//
// `seen` is a parallel pair of lists rather than a `Map`, because the cycle
// test has to compare by identity and a cloned graph must share the structure
// the original shared.

function __wtCloneLookup(seen: any[], clones: any[], value: any): any {
  const total = Number(seen.length);
  for (let i = 0; i < total; i++) {
    if (seen[i] === value) return clones[i];
  }
  return undefined;
}

function __wtCloneValue(value: any, moved: any[], replacements: any[], seen: any[], clones: any[]): any {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind === "boolean" || kind === "number" || kind === "string" || kind === "bigint") return value;
  if (kind === "symbol") {
    throw __wtDataCloneError(String(value) + " could not be cloned.");
  }
  if (kind === "function") {
    throw __wtDataCloneError(__wtFunctionLabel(value) + " could not be cloned.");
  }

  // A transferable that travelled in the transfer list: hand back the moved
  // counterpart, not a clone.
  const movedIndex = Number(moved.indexOf(value));
  if (movedIndex !== -1) return replacements[movedIndex];

  if (value instanceof MessagePort) {
    throw __wtDataCloneError(
      "Object that needs transfer was found in message but not listed in transferList",
    );
  }
  if (__wtIsMarkedAsUncloneable(value)) {
    throw __wtDataCloneError(__wtObjectLabel(value) + " could not be cloned.");
  }

  const already: any = __wtCloneLookup(seen, clones, value);
  if (already !== undefined) return already;

  if (value instanceof Date) {
    const copy: any = new Date(Number(value.getTime()));
    seen.push(value);
    clones.push(copy);
    return copy;
  }
  if (value instanceof RegExp) {
    const copy: any = new RegExp(String(value.source), String(value.flags));
    seen.push(value);
    clones.push(copy);
    return copy;
  }
  if (value instanceof Error) {
    // Node clones an `Error` as `{ name, message, stack }` on a fresh error of
    // the matching kind; only the three fields are observable here.
    const copy: any = new Error(String(value.message));
    copy.name = String(value.name);
    copy.stack = value.stack;
    seen.push(value);
    clones.push(copy);
    return copy;
  }
  if (Buffer.isBuffer(value)) {
    // A byte view is copied, not shared. The copy goes through a `number[]`:
    // `Buffer.from(aBuffer)` is rejected by the checker ("expects a string,
    // array or ArrayBuffer, found BufferView(U8)"), so the bytes are read out
    // one at a time through the re-typed view.
    const source: Buffer = __wtAsByteView(value);
    const bytes: number[] = [];
    const span = Number(source.length);
    for (let i = 0; i < span; i++) bytes.push(Number(source[i]));
    const copy: any = Buffer.from(bytes);
    seen.push(value);
    clones.push(copy);
    return copy;
  }
  if (value instanceof ArrayBuffer) {
    // An ArrayBuffer that is not in the transfer list is copied byte by byte.
    const source: any = new Uint8Array(value);
    const span = Number(source.length);
    const copy: any = new ArrayBuffer(span);
    const target: any = new Uint8Array(copy);
    for (let i = 0; i < span; i++) target[i] = source[i];
    seen.push(value);
    clones.push(copy);
    return copy;
  }
  if (Array.isArray(value)) {
    const copy: any[] = [];
    seen.push(value);
    clones.push(copy);
    const total = Number(value.length);
    for (let i = 0; i < total; i++) {
      copy.push(__wtCloneValue(value[i], moved, replacements, seen, clones));
    }
    return copy;
  }
  if (value instanceof Map) {
    const copy: any = new Map();
    seen.push(value);
    clones.push(copy);
    for (const entry of value) {
      copy.set(
        __wtCloneValue(entry[0], moved, replacements, seen, clones),
        __wtCloneValue(entry[1], moved, replacements, seen, clones),
      );
    }
    return copy;
  }
  if (value instanceof Set) {
    const copy: any = new Set();
    seen.push(value);
    clones.push(copy);
    for (const item of value) copy.add(__wtCloneValue(item, moved, replacements, seen, clones));
    return copy;
  }

  // Anything else is cloned as its own enumerable properties, which is what
  // the algorithm does for a plain object. A class instance loses its class,
  // exactly as it does in Node.
  const copy: any = {};
  seen.push(value);
  clones.push(copy);
  for (const key of Object.keys(value)) {
    copy[key] = __wtCloneValue(value[key], moved, replacements, seen, clones);
  }
  return copy;
}

// Re-type an `any` known to hold a `Uint8Array`/`Buffer` (zun#38): without the
// declared return type the checker refuses to hand the value to `Buffer.from`.
function __wtAsByteView(value: any): Buffer {
  return value;
}

function __wtFunctionLabel(value: any): string {
  const name: any = value.name;
  if (typeof name === "string" && name !== "") return name + "() {}";
  return "function () {}";
}

function __wtObjectLabel(value: any): string {
  // The transfer list holds whatever the caller put in it, and in this engine a
  // perfectly ordinary `buf.buffer` reads back `undefined`
  // (https://github.com/UrubuCode/zun/issues/38) -- so this has to survive a
  // primitive rather than reading `.constructor` off one.
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object" && typeof value !== "function") return String(value);
  const ctor: any = value.constructor;
  if (ctor !== null && ctor !== undefined) {
    const name: any = ctor.name;
    if (typeof name === "string" && name !== "") return "#<" + name + ">";
  }
  return "#<Object>";
}

function __wtClone(value: any, moved: any[], replacements: any[]): any {
  const seen: any[] = [];
  const clones: any[] = [];
  return __wtCloneValue(value, moved, replacements, seen, clones);
}

// ---------------------------------------------------------------------------
// MessagePort
// ---------------------------------------------------------------------------

// Is this value an `ArrayBuffer`?
//
// Engine gap, and a deep one: an `ArrayBuffer` here is *observationally* an
// empty plain object. `ab.byteLength` is a compile error ("type Buffer has no
// fields"), `ArrayBuffer.isView(ab)` is `false`, `Buffer.isBuffer(ab)` is
// `false`, `ab instanceof ArrayBuffer` is `false`, `Object.keys(ab)` is `[]`
// and `JSON.stringify(ab)` is `{}`. The one thing that *does* separate it from
// `{}` is `ab.constructor`, which reads back `undefined` where a plain object
// answers `Object` and a class instance answers its class. So that is the test,
// and it is a heuristic: a null-prototype object would pass it too. The cost is
// confined to the transfer list, where the only question asked of a non-port
// entry is "is this a transferable buffer or a mistake".
function __wtIsArrayBufferLike(value: any): boolean {
  if (!__wtIsObjectLike(value)) return false;
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (value instanceof MessagePort) return false;
  if (ArrayBuffer.isView(value) === true) return false;
  // Newer engines expose a real `ArrayBuffer`; older ones only leave the
  // `constructor === undefined` fingerprint described above.
  if (value instanceof ArrayBuffer) return true;
  return value.constructor === undefined;
}

class MessagePort extends EventTarget {
  // The listener list and the two event-handler slots, shared with
  // `BroadcastChannel` through the `__wt*` free functions above.
  __wtEntries: any[] = [];
  __wtHandlers: any = {};
  // `any`, and the default is written in the constructor rather than here:
  // a `number`-typed field of a class that extends a *prelude* class, given a
  // top-level `const ...: number` as its initializer, aborts the VM with
  // "expected float, found Any" (new engine bug, repro in
  // ../../test/worker_threads/README.md).
  __wtMaxListeners: any = 10;
  // The ports arriving with the message currently being dispatched, consumed
  // by `__wtCreateEvent` (Node's `kCurrentlyReceivingPorts`).
  __wtReceivingPorts: any = null;

  __wtQueue: any[] = [];
  __wtSibling: any = null;
  // The cross-process link this port speaks over, or null for an in-process
  // port. Only a worker's `parentPort` has one (see "The Worker process").
  __wtLink: any = null;
  // A port that crossed the link: `__wtProxyId` names it in the link's port
  // table. On the receiving side the port *is* the remote end (`__wtLink` is
  // set); on the sending side the moved port's local stand-in forwards
  // whatever its sibling posts (`__wtForward` is the link).
  __wtProxyId: any = 0;
  __wtForward: any = null;
  __wtStarted: boolean = false;
  // `__wtDetached` is set the instant `close()` or a transfer happens, because
  // Node's detachment is synchronous and instant even though the handle lives
  // on for one more turn; `__wtActive` is the handle, and is what `hasRef()`
  // and the custom inspector report.
  __wtDetached: boolean = false;
  __wtActive: boolean = true;
  __wtRefed: boolean = false;
  __wtDrainArmed: boolean = false;
  // The armed drain's `Immediate`, kept so that a listener arriving after the
  // drain was armed can `ref()` it -- see `__wtArmDrain`.
  __wtDrainHandle: any = null;
  __wtClosing: boolean = false;

  constructor(guard: any = undefined) {
    super();
    // `new MessagePort()` is not reachable in Node: the constructor is the
    // C++ one and refuses a direct call. The guard is the private token
    // `__wtNewPort` passes.
    if (guard !== __WT_PORT_GUARD) {
      throw new NodeTypeError(
        "ERR_CONSTRUCT_CALL_INVALID",
        "Constructor cannot be called",
      );
    }
    this.__wtEntries = [];
    this.__wtHandlers = { message: null, messageerror: null };
    this.__wtMaxListeners = __WT_DEFAULT_MAX_LISTENERS;
    this.__wtReceivingPorts = null;
    this.__wtQueue = [];
    this.__wtSibling = null;
    this.__wtLink = null;
    this.__wtProxyId = 0;
    this.__wtForward = null;
    this.__wtStarted = false;
    this.__wtDetached = false;
    this.__wtActive = true;
    this.__wtRefed = false;
    this.__wtDrainArmed = false;
    this.__wtDrainHandle = null;
    this.__wtClosing = false;
  }

  // ---- the EventTarget half (overriding the prelude's) --------------------

  addEventListener(type: any, listener: any, options: any = null): void {
    __wtAddListener(this, type, listener, __wtOnceOf(options), __wtCaptureOf(options), false);
  }

  removeEventListener(type: any, listener: any, options: any = null): void {
    __wtRemoveListener(this, type, listener, __wtCaptureOf(options));
  }

  dispatchEvent(event: any): boolean {
    if (!(event instanceof Event)) {
      throw new ERR_INVALID_ARG_TYPE("event", "Event", event);
    }
    return __wtHybridDispatch(this, event, String(event.type), event);
  }

  // ---- the EventEmitter half --------------------------------------------

  on(type: any, listener: any): any {
    __wtAddListener(this, type, listener, false, false, true);
    return this;
  }

  addListener(type: any, listener: any): any {
    __wtAddListener(this, type, listener, false, false, true);
    return this;
  }

  once(type: any, listener: any): any {
    __wtAddListener(this, type, listener, true, false, true);
    return this;
  }

  off(type: any, listener: any, options: any = null): any {
    __wtRemoveListener(this, type, listener, __wtCaptureOf(options));
    return this;
  }

  removeListener(type: any, listener: any, options: any = null): any {
    __wtRemoveListener(this, type, listener, __wtCaptureOf(options));
    return this;
  }

  removeAllListeners(type?: any): any {
    __wtRemoveAllListeners(this, type, type !== undefined);
    return this;
  }

  listenerCount(type: any): number {
    return __wtListenerCount(this, type);
  }

  eventNames(): any[] {
    return __wtEventNames(this);
  }

  setMaxListeners(n: any): any {
    this.__wtMaxListeners = Number(n);
    return this;
  }

  getMaxListeners(): number {
    return Number(this.__wtMaxListeners);
  }

  emit(type: any, argument?: any): boolean {
    const name = String(type);
    const had = __wtListenerCount(this, name) > 0;
    __wtHybridDispatch(this, argument, name, null);
    return had;
  }

  // ---- the port itself ---------------------------------------------------

  get onmessage(): any {
    return __wtGetEventHandler(this, "message");
  }

  set onmessage(value: any) {
    __wtSetEventHandler(this, "message", value);
  }

  get onmessageerror(): any {
    return __wtGetEventHandler(this, "messageerror");
  }

  set onmessageerror(value: any) {
    __wtSetEventHandler(this, "messageerror", value);
  }

  // A rest parameter, because a defaulted `value = MISSING` cannot tell
  // `postMessage()` from `postMessage(undefined)` -- an explicit `undefined`
  // takes the default too -- and only the first one is `ERR_MISSING_ARGS`.
  postMessage(...rest: any[]): void {
    if (Number(rest.length) === 0) {
      throw new NodeTypeError(
        "ERR_MISSING_ARGS",
        "Not enough arguments to MessagePort.postMessage",
      );
    }
    __wtPortPostMessage(this, rest[0], rest[1]);
  }

  start(): void {
    if (this.__wtDetached === true) return;
    this.__wtStarted = true;
    __wtArmDrain(this);
  }

  close(callback?: any): void {
    if (__evIsFn(callback)) __wtAddListener(this, "close", callback, true, false, true);
    __wtClosePort(this);
  }

  ref(): void {
    this.__wtRefed = true;
  }

  unref(): void {
    this.__wtRefed = false;
  }

  hasRef(): boolean {
    if (this.__wtActive !== true) return false;
    if (this.__wtRefed === true) return true;
    return __wtHandlerOf(this, "message") !== null;
  }
}

// The token the real constructor demands, so that `new MessagePort()` from user
// code raises `ERR_CONSTRUCT_CALL_INVALID` exactly as Node's C++ constructor
// does while `__wtNewPort` can still build one.
const __WT_PORT_GUARD: any = { token: "zun-node:MessagePort" };

function __wtNewPort(): any {
  return new MessagePort(__WT_PORT_GUARD);
}

// ---------------------------------------------------------------------------
// Reference counting and the delivery loop
// ---------------------------------------------------------------------------
//
// `setupPortReferencing`: the first `'message'` listener refs and starts the
// port, the last one removed stops and unrefs it. The two hooks are called by
// the shared listener machinery, so an `onmessage` assignment, an
// `addEventListener` and an `on` all go through them.

function __wtListenerAdded(target: any, type: string, countBefore: number): void {
  if (type !== "message") return;
  if (countBefore !== 0) return;
  if (!(target instanceof MessagePort)) return;
  const port: any = target;
  port.__wtRefed = true;
  if (port.__wtDetached !== true) {
    port.__wtStarted = true;
    __wtArmDrain(port);
  }
  // A drain armed while nothing was listening was unref'd; the port is ref'd
  // now, so the turn that delivers has to be too.
  if (port.__wtDrainHandle !== null && port.__wtDrainHandle !== undefined) {
    port.__wtDrainHandle.ref();
  }
}

function __wtListenerRemoved(target: any, type: string, countAfter: number): void {
  if (type !== "message") return;
  if (countAfter !== 0) return;
  if (!(target instanceof MessagePort)) return;
  const port: any = target;
  port.__wtStarted = false;
  port.__wtRefed = false;
}

// A port delivers once it has been started — by `start()`, by the first
// `'message'` listener, or by an `onmessage` assignment, which has no setter to
// hook and is therefore read out of the slot every time the question is asked.
function __wtPortStarted(port: any): boolean {
  if (port.__wtStarted === true) return true;
  return __wtHandlerOf(port, "message") !== null;
}

// Arm one drain of this port.
//
// The drain is armed whenever the queue is non-empty, *whether or not* the port
// has been started, and a drain that finds the port still stopped re-arms
// itself instead of dropping the queue — because `onmessage = fn` is written
// straight into its slot with no setter to hook (see `__wtSetEventHandler`), so
// "has this port been started" is a question that can only be answered by
// asking again on the next turn. That is also what Node's loop does: the port's
// async handle is polled every iteration and stays unref'd until something is
// listening, so a queued message neither ends the run early nor keeps it alive.
// Which macrotask tier the next drain is armed on.
//
// The VM's loop has no check phase: `src/timers/timers.ts` arms a `setImmediate`
// as an engine timer with a **0 ms** delay and a `setTimeout(fn, 0)` as one with
// **1 ms** (Node's own clamp), and the VM's virtual clock does not advance while
// 0 ms work remains. A drain that re-armed itself on the immediate tier would
// therefore starve every timer in the program -- which is precisely what
// `test-worker-message-port-infinite-message-loop.js` exists to rule out ("the
// event loop should be available and not stall out due to the recursive
// .postMessage() calls").
//
// So the *first* drain of a batch is armed on the immediate tier, where Node's
// poll phase sits relative to `setImmediate`, and a drain armed from **inside**
// another drain goes on the timer tier instead, which is the turn Node's loop
// gives the timers phase once per iteration. `__wtDraining` is the flag that
// tells the two apart.
const __wtDraining: any = { depth: 0 };

function __wtArmDrain(port: any): void {
  if (port.__wtDrainArmed === true) return;
  if (port.__wtActive !== true) return;
  if (Number(port.__wtQueue.length) === 0) return;
  port.__wtDrainArmed = true;
  if (Number(__wtDraining.depth) > 0) {
    port.__wtDrainHandle = setTimeout(() => __wtDrainPort(port), 0);
  } else {
    port.__wtDrainHandle = setImmediate(() => __wtDrainPort(port));
  }
}

// One drain: take the queue, empty it, dispatch the snapshot. A message posted
// from inside a handler lands in the fresh queue and arms the next drain, which
// is what keeps a self-feeding port from starving the loop.
function __wtDrainPort(port: any): void {
  port.__wtDrainArmed = false;
  port.__wtDrainHandle = null;
  if (port.__wtActive !== true) return;
  if (!__wtPortStarted(port)) {
    // Nothing is listening yet, so the queue stays and one more turn is armed
    // -- *unref'd*, because Node's port handle is unref'd until a listener
    // arrives and a message nobody asked for must not keep the run alive.
    // `__wtListenerAdded` refs this very handle the moment one does, which is
    // what delivers a message posted before `port.on('message', …)` was called.
    //
    // An unref'd `Immediate` is never run at all in this engine when nothing
    // else keeps the loop turning (Node runs it in the same iteration), so the
    // *first* drain is deliberately left ref'd: that is the turn in which an
    // `onmessage = fn` written after the `postMessage` -- which has no setter
    // to hook, see `__wtSetEventHandler` -- still gets its message.
    __wtArmDrain(port);
    if (port.__wtDrainHandle !== null) port.__wtDrainHandle.unref();
    return;
  }
  const batch: any[] = port.__wtQueue;
  port.__wtQueue = [];
  __wtDraining.depth = Number(__wtDraining.depth) + 1;
  for (const entry of batch) {
    port.__wtReceivingPorts = entry.ports;
    __wtHybridDispatch(port, entry.data, "message", null);
  }
  __wtArmDrain(port);
  __wtDraining.depth = Number(__wtDraining.depth) - 1;
}

// `receiveMessageOnPort`: dequeue without dispatching.
function __wtReceiveMessage(port: any): any {
  const queue: any[] = port.__wtQueue;
  if (Number(queue.length) === 0) return undefined;
  const entry: any = queue.shift();
  return { message: entry.data };
}

// ---------------------------------------------------------------------------
// postMessage
// ---------------------------------------------------------------------------

// Transfer a port: the *handle* moves, so the receiving side gets a fresh
// `MessagePort` carrying this one's entanglement and its undelivered queue,
// and this one is detached. That is what crossing a thread boundary does in
// Node, and in one realm it is the same operation with both ends visible.
function __wtTransferPort(port: any): any {
  const replacement: any = __wtNewPort();
  replacement.__wtSibling = port.__wtSibling;
  replacement.__wtQueue = port.__wtQueue;
  if (port.__wtSibling !== null && port.__wtSibling !== undefined) {
    port.__wtSibling.__wtSibling = replacement;
  }
  port.__wtSibling = null;
  port.__wtQueue = [];
  port.__wtStarted = false;
  port.__wtRefed = false;
  port.__wtDetached = true;
  port.__wtActive = false;
  return replacement;
}

// The transfer list is validated **completely** before anything is moved:
// `test-worker-message-port-transfer-closed.js` posts `[arrayBuf, closedPort]`
// and asserts that `arrayBuf` was not transferred, so a failure late in the
// list may not have moved an entry early in it.
function __wtPrepareTransfer(port: any, list: any[]): any[] {
  const ports: any[] = [];
  const buffers: any[] = [];
  for (const item of list) {
    if (item instanceof MessagePort) {
      if (item === port) throw __wtDataCloneError("Transfer list contains source port");
      if (Number(ports.indexOf(item)) !== -1) {
        throw __wtDataCloneError("Transfer list contains duplicate MessagePort");
      }
      if (__wtIsMarkedAsUntransferable(item)) {
        throw __wtDataCloneError(__wtObjectLabel(item) + " could not be cloned.");
      }
      if (item.__wtDetached === true) {
        throw __wtDataCloneError("MessagePort in transfer list is already detached");
      }
      ports.push(item);
      continue;
    }
    if (__wtIsArrayBufferLike(item)) {
      if (__wtIsMarkedAsUntransferable(item)) {
        throw __wtDataCloneError(__wtObjectLabel(item) + " could not be cloned.");
      }
      if (Number(buffers.indexOf(item)) !== -1) {
        throw __wtDataCloneError("Transfer list contains duplicate ArrayBuffer");
      }
      if (__wtDetachedBuffers.get(item) === true) {
        throw __wtDataCloneError("Transfer list contains an already detached ArrayBuffer");
      }
      buffers.push(item);
      continue;
    }
    // Anything else is not transferable. Node's list is longer -- a `Blob`, an
    // `X509Certificate`, a `FileHandle`, any `JSTransferable` -- and every one
    // of those is either absent from this runtime or reached through the
    // `internal/worker/js_transferable` protocol, which is an internal surface.
    throw __wtDataCloneError(__wtObjectLabel(item) + " could not be cloned.");
  }
  return [ports, buffers];
}

// The two argument forms `MessagePort.prototype.postMessage` accepts, resolved
// exactly as `MessagePort::PostMessage` in `src/node_messaging.cc` does: a
// non-nullish non-object second argument is an error; an *iterable* second
// argument is the transfer list itself; otherwise `options.transfer` is, and
// must be iterable when it is present.
function __wtResolveTransferList(options: any): any[] {
  if (options === null || options === undefined) return [];
  if (!__wtIsObjectLike(options)) {
    throw new ERR_INVALID_ARG_TYPE_MESSAGE("Optional transferList argument must be an iterable");
  }
  const direct: any[] | null = __wtReadIterable(options);
  if (direct !== null) return direct;
  const transfer: any = options.transfer;
  if (transfer === undefined) return [];
  const listed: any[] | null = __wtReadIterable(transfer);
  if (listed === null) {
    throw new ERR_INVALID_ARG_TYPE_MESSAGE(
      "Optional options.transfer argument must be an iterable",
    );
  }
  return listed;
}

// `ERR_INVALID_ARG_TYPE` with a message that is not built from an argument
// name: the two `postMessage` transfer-list errors are raised in C++ with a
// literal string, and `test-worker-message-port.js` matches it verbatim.
class ERR_INVALID_ARG_TYPE_MESSAGE extends NodeTypeError {
  constructor(message: string) {
    super("ERR_INVALID_ARG_TYPE", message);
  }
}

function __wtPortPostMessage(port: any, value: any, options: any): void {
  const list: any[] = __wtResolveTransferList(options);
  const prepared: any[] = __wtPrepareTransfer(port, list);
  const ports: any[] = prepared[0];
  const buffers: any[] = prepared[1];

  // Posting to the other end of a channel whose own port is in the transfer
  // list loses the channel, and Node warns rather than throwing.
  const target: any = port.__wtSibling;
  const losesTarget = target !== null && target !== undefined && Number(ports.indexOf(target)) !== -1;

  const moved: any[] = [];
  const replacements: any[] = [];
  for (const item of ports) {
    moved.push(item);
    replacements.push(__wtTransferPort(item));
  }
  for (const item of buffers) {
    __wtDetachedBuffers.set(item, true);
    moved.push(item);
    replacements.push(item);
  }

  let data: any = undefined;
  try {
    data = __wtClone(value, moved, replacements);
  } catch (error: any) {
    // The clone failed after the list was moved, which is the order Node has
    // too: the transfer is not undone, and the message is simply not sent.
    throw error;
  }

  // A worker's `parentPort` has no in-process sibling: its other end is the
  // `Worker` object in the parent process, reached over the link.
  if (port.__wtLink !== null && port.__wtLink !== undefined) {
    if (port.__wtDetached === true) return;
    const link: any = port.__wtLink;
    if (Number(port.__wtProxyId) !== 0) {
      __wtLinkSend(link, { t: "pm", id: Number(port.__wtProxyId), v: __wtEncode(data, link) });
    } else {
      __wtLinkSend(link, { t: "m", v: __wtEncode(data, link) });
    }
    return;
  }
  if (target !== null && target !== undefined && target.__wtForward !== null && target.__wtForward !== undefined) {
    if (port.__wtDetached === true) return;
    const link: any = target.__wtForward;
    __wtLinkSend(link, { t: "pm", id: Number(target.__wtProxyId), v: __wtEncode(data, link) });
    return;
  }

  if (losesTarget) {
    process.emitWarning(
      "The target port was posted to itself, and the communication channel was lost",
    );
    __wtClosePort(port);
    return;
  }
  if (port.__wtDetached === true) return;
  if (target === null || target === undefined) return;
  if (target.__wtDetached === true) return;

  const delivered: any[] = [];
  for (const replacement of replacements) {
    if (replacement instanceof MessagePort) delivered.push(replacement);
  }
  target.__wtQueue.push({ data: data, ports: delivered });
  __wtArmDrain(target);
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------
//
// `close()` detaches both ends at once and instantly (that is the observable
// rule `test-worker-message-port-transfer-closed.js` states), but the handle
// outlives the call by one turn: the messages already queued are still
// delivered, and only then does the `'close'` event fire and `hasRef()` start
// answering `false`.

function __wtClosePort(port: any): void {
  if (port.__wtClosing === true) return;
  const sibling: any = port.__wtSibling;
  port.__wtClosing = true;
  port.__wtDetached = true;
  if (sibling !== null && sibling !== undefined) {
    sibling.__wtClosing = true;
    sibling.__wtDetached = true;
  }
  const handle: any = setImmediate(() => __wtFinishClose(port));
  // A closing port always keeps the loop alive long enough to fire 'close':
  // Node's handle close is a real loop event, and `close(cb)` must run its
  // callback.
  handle.ref();
}

function __wtFinishClose(port: any): void {
  const sibling: any = port.__wtSibling;
  __wtDrainOnClose(port);
  if (sibling !== null && sibling !== undefined) __wtDrainOnClose(sibling);
  port.__wtActive = false;
  port.__wtSibling = null;
  if (sibling !== null && sibling !== undefined) {
    sibling.__wtActive = false;
    sibling.__wtSibling = null;
  }
  __wtHybridDispatch(port, undefined, "close", new Event("close"));
  if (sibling !== null && sibling !== undefined) {
    __wtHybridDispatch(sibling, undefined, "close", new Event("close"));
  }
}

function __wtDrainOnClose(port: any): void {
  if (!__wtPortStarted(port)) {
    port.__wtQueue = [];
    return;
  }
  const batch: any[] = port.__wtQueue;
  port.__wtQueue = [];
  for (const entry of batch) {
    port.__wtReceivingPorts = entry.ports;
    __wtHybridDispatch(port, entry.data, "message", null);
  }
}

// ---------------------------------------------------------------------------
// MessageChannel
// ---------------------------------------------------------------------------
//
// Declared under a second name, because the prelude owns `MessageChannel` and a
// prelude class cannot be shadowed (see the header). `tools/bundle_node_test.sh`
// rewrites the Node spelling to this one.

class __zunMessageChannel {
  port1: any = null;
  port2: any = null;
  constructor() {
    const first: any = __wtNewPort();
    const second: any = __wtNewPort();
    first.__wtSibling = second;
    second.__wtSibling = first;
    this.port1 = first;
    this.port2 = second;
  }
}

// ---------------------------------------------------------------------------
// moveMessagePortToContext
// ---------------------------------------------------------------------------

// Moving a port into another `vm` context needs a second realm, which is a VM
// facility rather than something a library can synthesize. The one piece that
// *is* this module's own is the pre-flight check: a closed port cannot be
// moved, and Node reports that before it ever looks at the context.
function __wtMoveMessagePortToContext(port: any, context: any): any {
  if (!(port instanceof MessagePort)) {
    throw new ERR_INVALID_ARG_TYPE("port", "MessagePort", port);
  }
  if (port.__wtDetached === true) {
    throw new NodeError("ERR_CLOSED_MESSAGE_PORT", "Cannot send data on closed MessagePort");
  }
  throw new ERR_METHOD_NOT_IMPLEMENTED(
    "worker_threads.moveMessagePortToContext (a second realm is a VM facility)",
  );
}

// ---------------------------------------------------------------------------
// BroadcastChannel
// ---------------------------------------------------------------------------
//
// One registry keyed by name, and a delivery rule: a `postMessage` enqueues the
// message on every *other* live channel of the same name, in channel creation
// order, and each channel drains its own queue on a later loop turn. That
// ordering is Node's rather than the browsers' — `test-worker-broadcastchannel-wpt.js`
// says so in a comment of its own — and it falls out of giving each channel a
// queue, exactly as it does for a `MessagePort`.

const __wtBroadcastRegistry: any = new Map();

function __wtBroadcastList(name: string): any[] {
  let list: any = __wtBroadcastRegistry.get(name);
  if (list === undefined) {
    list = [];
    __wtBroadcastRegistry.set(name, list);
  }
  return list;
}

class BroadcastChannel extends EventTarget {
  __wtEntries: any[] = [];
  __wtHandlers: any = {};
  // `any`, and the default is written in the constructor rather than here:
  // a `number`-typed field of a class that extends a *prelude* class, given a
  // top-level `const ...: number` as its initializer, aborts the VM with
  // "expected float, found Any" (new engine bug, repro in
  // ../../test/worker_threads/README.md).
  __wtMaxListeners: any = 10;
  __wtReceivingPorts: any = null;
  __wtName: string = "";
  __wtOpen: boolean = false;
  __wtQueue: any[] = [];
  __wtRefed: boolean = true;
  __wtDrainArmed: boolean = false;

  // A rest parameter, not a defaulted one: `new BroadcastChannel(undefined)`
  // is legal (name "undefined") and only a missing argument throws.
  constructor(...args: any[]) {
    super();
    const name: any = args[0];
    if (Number(args.length) === 0) {
      throw new NodeTypeError("ERR_MISSING_ARGS", 'The "name" argument must be specified');
    }
    this.__wtEntries = [];
    this.__wtHandlers = { message: null, messageerror: null };
    this.__wtMaxListeners = __WT_DEFAULT_MAX_LISTENERS;
    this.__wtReceivingPorts = null;
    // `${name}` — which is a `TypeError` for a symbol, and the test asserts the
    // engine's own message for that.
    this.__wtName = "" + name;
    this.__wtOpen = true;
    this.__wtQueue = [];
    this.__wtRefed = true;
    this.__wtDrainArmed = false;
    __wtBroadcastList(this.__wtName).push(this);
  }

  get name(): string {
    return this.__wtName;
  }

  addEventListener(type: any, listener: any, options: any = null): void {
    __wtAddListener(this, type, listener, __wtOnceOf(options), __wtCaptureOf(options), false);
  }

  removeEventListener(type: any, listener: any, options: any = null): void {
    __wtRemoveListener(this, type, listener, __wtCaptureOf(options));
  }

  dispatchEvent(event: any): boolean {
    if (!(event instanceof Event)) {
      throw new ERR_INVALID_ARG_TYPE("event", "Event", event);
    }
    return __wtHybridDispatch(this, event, String(event.type), event);
  }

  on(type: any, listener: any): any {
    __wtAddListener(this, type, listener, false, false, true);
    return this;
  }

  once(type: any, listener: any): any {
    __wtAddListener(this, type, listener, true, false, true);
    return this;
  }

  off(type: any, listener: any, options: any = null): any {
    __wtRemoveListener(this, type, listener, __wtCaptureOf(options));
    return this;
  }

  listenerCount(type: any): number {
    return __wtListenerCount(this, type);
  }

  eventNames(): any[] {
    return __wtEventNames(this);
  }

  get onmessage(): any {
    return __wtGetEventHandler(this, "message");
  }

  set onmessage(value: any) {
    __wtSetEventHandler(this, "message", value);
  }

  get onmessageerror(): any {
    return __wtGetEventHandler(this, "messageerror");
  }

  set onmessageerror(value: any) {
    __wtSetEventHandler(this, "messageerror", value);
  }

  // A rest parameter for the reason `MessagePort.prototype.postMessage` gives.
  postMessage(...rest: any[]): void {
    if (this.__wtOpen !== true) {
      throw new __WtDOMException("BroadcastChannel is closed.", "InvalidStateError");
    }
    const message: any = rest[0];
    if (Number(rest.length) === 0) {
      throw new NodeTypeError("ERR_MISSING_ARGS", 'The "message" argument must be specified');
    }
    __wtBroadcastPost(this, message);
  }

  close(): void {
    if (this.__wtOpen !== true) return;
    this.__wtOpen = false;
    this.__wtQueue = [];
    const list: any[] = __wtBroadcastList(this.__wtName);
    const index = Number(list.indexOf(this));
    if (index !== -1) {
      const mutable: any = list;
      mutable.splice(index, 1);
    }
  }

  ref(): any {
    this.__wtRefed = true;
    return this;
  }

  unref(): any {
    this.__wtRefed = false;
    return this;
  }
}

function __wtBroadcastPost(channel: any, message: any): void {
  const data: any = __wtClone(message, [], []);
  const list: any[] = __wtBroadcastList(channel.__wtName);
  // A snapshot, because a listener may create or close channels while the queue
  // is draining (`test-worker-broadcastchannel-wpt.js` does both).
  const peers: any[] = [];
  for (const peer of list) {
    if (peer !== channel) peers.push(peer);
  }
  for (const peer of peers) {
    if (peer.__wtOpen !== true) continue;
    peer.__wtQueue.push(data);
    __wtArmBroadcastDrain(peer);
  }
}

// A channel's drain stays on the immediate tier even when it is armed from
// inside another drain, where a *port*'s moves to the timer tier (see
// `__wtArmDrain`): a broadcast is one hop, so a channel cannot feed itself —
// `__wtBroadcastPost` skips the sender — and the starvation `__wtArmDrain`
// guards against needs a cycle.
function __wtArmBroadcastDrain(channel: any): void {
  if (channel.__wtDrainArmed === true) return;
  if (Number(channel.__wtQueue.length) === 0) return;
  channel.__wtDrainArmed = true;
  const handle: any = setImmediate(() => __wtDrainBroadcast(channel));
  if (channel.__wtRefed !== true) handle.unref();
}

function __wtDrainBroadcast(channel: any): void {
  channel.__wtDrainArmed = false;
  const batch: any[] = channel.__wtQueue;
  channel.__wtQueue = [];
  for (const data of batch) {
    // A channel closed while its own queue drains delivers nothing more, which
    // is the rule the WPT file checks.
    if (channel.__wtOpen !== true) break;
    __wtHybridDispatch(channel, data, "message", null);
  }
  __wtArmBroadcastDrain(channel);
}

// ---------------------------------------------------------------------------
// Thread identity and environmentData
// ---------------------------------------------------------------------------

// This runtime has one thread, so `isMainThread` is `true` and `threadId` is
// `0` — the honest answer, and the same one Node gives on its own main thread.
// `parentPort` is `null` and `workerData` is `null` for the same reason.
const __wtEnvironmentData: any = new Map();

function __wtSetEnvironmentData(key: any, value?: any): void {
  if (value === undefined) {
    __wtEnvironmentData.delete(key);
    return;
  }
  __wtEnvironmentData.set(key, value);
}

function __wtGetEnvironmentData(key: any): any {
  return __wtEnvironmentData.get(key);
}

// `SHARE_ENV`, the sentinel a `Worker` is given to share `process.env` rather
// than receive a copy. Node makes it a symbol; the only thing a program may do
// with it is pass it back, so a symbol is exactly right.
//
// Named `__wtShareEnv` rather than `SHARE_ENV`, because Node's own tests spell
// `const { Worker, parentPort, SHARE_ENV } = require('worker_threads')`, which
// the bundler turns into a top-level `const SHARE_ENV` of the test's own -- and
// two top-level declarations of one name are a compile error in a single Zun
// program. Every other module export is reached through the module object or is
// a canonical binding in the module table, so this is the only one that needed
// a private name.
const __wtShareEnv: any = Symbol.for("nodejs.worker_threads.SHARE_ENV");

// `resourceLimits` on the main thread is an empty object in Node (the limits
// are a worker's, and the main thread has none).
const __wtResourceLimits: any = {};

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------
//
// The constructor is Node's, validation for validation, in Node's order:
//
//   1. `options.execArgv` and `options.argv` must be arrays;
//   2. `options.eval` demands a string `filename`;
//   3. a `data:` URL is the eval form, a `file:` URL becomes a path, a
//      non-string non-URL is `ERR_INVALID_ARG_TYPE`, and a relative path that
//      does not start with `./` or `../` is `ERR_WORKER_PATH` — with the two
//      hints Node adds when the string looks like a `file:`/`data:` URL;
//   4. `options.env` must be an object, nullish, or `SHARE_ENV`;
//   5. `options.name` must be a string;
//   6. `options.resourceLimits` members must be numbers;
//   7. every `execArgv` entry must be a per-isolate option, and so must every
//      flag in `options.env.NODE_OPTIONS` — both `ERR_WORKER_INVALID_EXEC_ARGV`;
//   8. `options.workerData` and `options.transferList` are structured-cloned,
//      so a `workerData` holding a closure is a `DataCloneError` *here*, at
//      construction time, which is the behavior `test-worker-invalid-workerdata.js`
//      exists to pin down.
//
// Then it starts the worker -- see "The Worker process" below.

// The `execArgv` entries Node accepts for a worker: the per-isolate options.
// Anything else — an unknown flag, or a per-*process* option such as `--title`
// or `--redirect-warnings` — is `ERR_WORKER_INVALID_EXEC_ARGV`, which is what
// `test-worker-execargv-invalid.js` checks three ways over.
const __WT_PER_ISOLATE_OPTIONS: string[] = [
  "--abort-on-uncaught-exception",
  "--conditions",
  "--disable-proto",
  "--disable-warning",
  "--disallow-code-generation-from-strings",
  "--enable-source-maps",
  "--experimental-import-meta-resolve",
  "--experimental-json-modules",
  "--experimental-modules",
  "--experimental-permission",
  "--experimental-print-required-tla",
  "--experimental-require-module",
  "--experimental-specifier-resolution",
  "--experimental-strip-types",
  "--experimental-top-level-await",
  "--experimental-transform-types",
  "--experimental-vm-modules",
  "--experimental-wasm-modules",
  "--frozen-intrinsics",
  "--harmony-shadow-realm",
  "--huge-max-old-generation-size",
  "--input-type",
  "--jitless",
  "--max-old-space-size",
  "--max-semi-space-size",
  "--no-deprecation",
  "--no-experimental-detect-module",
  "--no-experimental-require-module",
  "--no-extra-info-on-fatal-exception",
  "--no-force-async-hooks-checks",
  "--no-global-search-paths",
  "--no-warnings",
  "--pending-deprecation",
  "--perf-basic-prof",
  "--perf-prof",
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--prof",
  "--stack-size",
  "--stack-trace-limit",
  "--throw-deprecation",
  "--trace-deprecation",
  "--trace-exit",
  "--trace-sync-io",
  "--trace-uncaught",
  "--trace-warnings",
  "--unhandled-rejections",
  "--use-bundled-ca",
  "--use-openssl-ca",
  "--zero-fill-buffers",
];

// The flag *name*, i.e. everything before a `=`.
function __wtFlagName(flag: string): string {
  const at = Number(flag.indexOf("="));
  if (at === -1) return flag;
  return flag.slice(0, at);
}

function __wtInvalidFlags(flags: string[]): string[] {
  const bad: string[] = [];
  for (const flag of flags) {
    const text = String(flag);
    if (text === "") continue;
    const name = __wtFlagName(text);
    if (Number(__WT_PER_ISOLATE_OPTIONS.indexOf(name)) !== -1) continue;
    bad.push(text);
  }
  return bad;
}

class ERR_WORKER_PATH extends NodeTypeError {
  constructor(filename: string) {
    super("ERR_WORKER_PATH", __wtWorkerPathMessage(filename));
  }
}

function __wtWorkerPathMessage(filename: string): string {
  let message =
    "The worker script or module filename must be an absolute path or a " +
    "relative path starting with './' or '../'.";
  if (filename.slice(0, 7) === "file://") message = message + " Wrap file:// URLs with `new URL`.";
  if (filename.slice(0, 20) === "data:text/javascript") {
    message = message + " Wrap data: URLs with `new URL`.";
  }
  return message + ' Received "' + filename + '"';
}

class ERR_WORKER_INVALID_EXEC_ARGV extends NodeError {
  constructor(errors: string[], detail?: any) {
    super(
      "ERR_WORKER_INVALID_EXEC_ARGV",
      "Initiated Worker with " +
        (detail === undefined ? "invalid execArgv flags" : String(detail)) +
        ": " +
        errors.join(", "),
    );
  }
}

function __wtIsUrl(value: any): boolean {
  if (!__wtIsObjectLike(value)) return false;
  // `new URL(...)` in a bundle is src/url/whatwg.ts' `NodeURL` (the bundler
  // rewrites the global); the prelude's own `URL` is still accepted.
  return value instanceof NodeURL || value instanceof URL;
}

function __wtValidateArray(value: any, name: string): void {
  if (!Array.isArray(value)) throw new ERR_INVALID_ARG_TYPE(name, "Array", value);
}

function __wtValidateString(value: any, name: string): void {
  if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
}

function __wtParseResourceLimits(limits: any): any {
  const parsed: any = {};
  if (limits === null || limits === undefined) return parsed;
  if (typeof limits !== "object") return parsed;
  const names: string[] = ["maxYoungGenerationSizeMb", "maxOldGenerationSizeMb", "codeRangeSizeMb", "stackSizeMb"];
  for (const name of names) {
    const value: any = limits[name];
    if (value === undefined) continue;
    if (typeof value !== "number") {
      throw new ERR_INVALID_ARG_TYPE("options.resourceLimits." + name, "number", value);
    }
    parsed[name] = value;
  }
  return parsed;
}

class Worker extends EventEmitter {
  threadId: number = -1;
  stdin: any = null;
  stdout: any = null;
  stderr: any = null;
  resourceLimits: any = {};
  performance: any = null;
  threadName: string = "WorkerThread";
  // The parent's end of the link to the worker process (see "The Worker
  // process" below).
  __wtLinkRef: any = null;

  constructor(filename: any, options: any = undefined) {
    super();
    const opts: any = options === undefined || options === null ? {} : options;

    if (opts.execArgv !== undefined && opts.execArgv !== null) {
      __wtValidateArray(opts.execArgv, "options.execArgv");
    }
    if (opts.argv !== undefined && opts.argv !== null) {
      __wtValidateArray(opts.argv, "options.argv");
    }

    let resolved: any = filename;
    if (opts.eval === true || opts.eval === "classic") {
      if (typeof filename !== "string") {
        throw new ERR_INVALID_ARG_VALUE(
          "options.eval",
          opts.eval,
          "must be false when 'filename' is not a string",
        );
      }
    } else if (__wtIsUrl(filename) && String(filename.protocol) === "data:") {
      resolved = String(filename);
    } else if (__wtIsUrl(filename)) {
      // `fileURLToPath` is the one that raises `ERR_INVALID_URL_SCHEME` for a
      // URL that is not `file:` — which is exactly what Node reports for
      // `new Worker(new URL('https://…'))`.
      resolved = __urlFileURLToPath(filename);
    } else if (typeof filename !== "string") {
      throw new ERR_INVALID_ARG_TYPE("filename", ["string", "URL"], filename);
    } else if (isAbsoluteImpl(filename, pathPlatformIsWindows()) || __wtIsExplicitlyRelative(filename)) {
      resolved = __wtResolvePath(filename);
    } else {
      throw new ERR_WORKER_PATH(filename);
    }

    let nodeOptions: any = undefined;
    if (opts.env !== undefined && opts.env !== null && opts.env !== __wtShareEnv) {
      if (typeof opts.env !== "object") {
        throw new ERR_INVALID_ARG_TYPE(
          "options.env",
          ["object", "undefined", "null", "worker_threads.SHARE_ENV"],
          opts.env,
        );
      }
      nodeOptions = opts.env["NODE_OPTIONS"];
    }

    if (opts.name !== undefined && opts.name !== null && opts.name !== "") {
      __wtValidateString(opts.name, "options.name");
    }

    this.resourceLimits = __wtParseResourceLimits(opts.resourceLimits);

    if (opts.execArgv !== undefined && opts.execArgv !== null) {
      const bad: string[] = __wtInvalidFlags(opts.execArgv);
      if (Number(bad.length) > 0) throw new ERR_WORKER_INVALID_EXEC_ARGV(bad);
    }
    if (typeof nodeOptions === "string" && nodeOptions !== "") {
      const bad: string[] = __wtInvalidFlags(nodeOptions.split(" "));
      if (Number(bad.length) > 0) {
        throw new ERR_WORKER_INVALID_EXEC_ARGV(bad, "invalid NODE_OPTIONS env variable");
      }
    }

    if (opts.transferList !== undefined && opts.transferList !== null) {
      __wtValidateArray(opts.transferList, "options.transferList");
    }
    // The `workerData` clone is the last validation, and it is a real one: a
    // value a worker could not receive is a `DataCloneError` at construction.
    const transferList: any[] = opts.transferList === undefined || opts.transferList === null ? [] : opts.transferList;
    const data: any = __wtCloneTransfer(opts.workerData, transferList);

    const host: any = __wtHost.impl;
    if (host === null || host === undefined || !__ioAvailable()) {
      throw new ERR_METHOD_NOT_IMPLEMENTED(
        "worker_threads.Worker constructor (" +
          String(resolved) +
          "): a Worker is a child Zun process, which needs the native extension " +
          "(the I/O loop and child_process)",
      );
    }

    let code: any = null;
    let script: string = String(resolved);
    if (opts.eval === true || opts.eval === "classic") {
      code = String(filename);
    } else if (script.slice(0, 5) === "data:") {
      code = __wtDataUrlSource(script);
    }

    if (typeof opts.name === "string" && opts.name !== "") this.threadName = opts.name;
    this.threadId = Number(__wtLinkState.nextThreadId);
    __wtLinkState.nextThreadId = Number(__wtLinkState.nextThreadId) + 1;
    const link: any = __wtLinkNew(this);
    this.__wtLinkRef = link;
    __wtSpawnWorker(link, host, opts, code, script, data);
    if (link.child !== null) {
      this.stdout = link.stdout;
      this.stderr = link.stderr;
    }
    // Node announces every new worker on `process`, one tick later.
    const self: any = this;
    process.nextTick((): void => {
      process.emit("worker", self);
    });
  }

  // A rest parameter rather than `(value = MISSING, options = undefined)`: the
  // word "arguments" in the error text below makes the checker inject a
  // synthetic rest parameter after the declared ones, so a statically typed
  // `worker.postMessage(v)` would be rejected as too few arguments (zun#40).
  postMessage(...rest: any[]): void {
    if (Number(rest.length) === 0) {
      throw new NodeTypeError("ERR_MISSING_ARGS", "Not enough arguments to Worker.postMessage");
    }
    const value: any = rest[0];
    const options: any = rest[1];
    const list: any[] = __wtResolveTransferList(options);
    const data: any = __wtCloneTransfer(value, list);
    const link: any = this.__wtLinkRef;
    if (link === null || link === undefined || link.exited === true) return;
    __wtLinkSend(link, { t: "m", v: __wtEncode(data) });
  }

  terminate(callback?: any): any {
    const link: any = this.__wtLinkRef;
    const self: any = this;
    if (link === null || link === undefined || link.exited === true) {
      const done: any = link === null || link === undefined ? undefined : link.exitCode;
      return Promise.resolve(done);
    }
    const promise: any = new Promise((resolve: any): void => {
      self.once("exit", (exitCode: any): void => {
        resolve(exitCode);
      });
    });
    if (link.terminated !== true) {
      link.terminated = true;
      // Closing the link first is what stops the worker: its end sees the
      // peer go away and exits at once (see `__wtLinkClose`). Killing the
      // child alone is not enough when the child is the launcher, because the
      // worker it started is a grandchild that would outlive it.
      __wtLinkClose(link);
      if (Number(link.server) !== 0) {
        __ioUnregister(Number(link.server));
        link.server = 0;
      }
      const child: any = link.child;
      if (child !== null && child !== undefined) child.kill();
    }
    return promise;
  }

  ref(): void {
    const link: any = this.__wtLinkRef;
    if (link !== null && link !== undefined && link.child !== null) link.child.ref();
  }

  unref(): void {
    const link: any = this.__wtLinkRef;
    if (link !== null && link !== undefined && link.child !== null) link.child.unref();
  }

  // JavaScript ignores an extra argument, and test code passes one
  // (`worker.on('exit', fn, 1)`); the inherited two-parameter `on` would make
  // that a compile error at a statically typed call site.
  on(type: any, listener: any, extra?: any): any {
    return super.on(type, listener);
  }

  getHeapSnapshot(): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("worker.getHeapSnapshot");
  }

  getHeapStatistics(): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("worker.getHeapStatistics");
  }
}

// `path.resolve(filename)`, reached through the two platform implementations
// rather than through the `path` module object: those are top-level functions in
// src/path/path.ts, which every bundle inlines.
function __wtResolvePath(filename: string): string {
  if (pathPlatformIsWindows()) return resolveWin32([filename]);
  return resolvePosix([filename]);
}

function __wtIsExplicitlyRelative(filename: string): boolean {
  if (filename.slice(0, 2) === "./" || filename.slice(0, 2) === ".\\") return true;
  if (filename.slice(0, 3) === "../" || filename.slice(0, 3) === "..\\") return true;
  return false;
}

// ---------------------------------------------------------------------------
// The Worker process
// ---------------------------------------------------------------------------
//
// A `Worker` is a **child Zun process**: the VM has one thread and one realm,
// so a second realm has to be a second process. What crosses between the two:
//
//   * **The boot record** travels in the child's environment, as the JSON
//     value of `ZUN_NODE_WORKER`: the loopback port to connect back to, the
//     `threadId`, the `name`, the encoded `workerData`, the `environmentData`
//     entries and the `resourceLimits`. The environment rather than the link,
//     because the worker script runs synchronously at startup and the link is
//     asynchronous: `workerData` has to be readable on the script's first line.
//   * **The script** is run through `process.execPath`, which under the test
//     runner is the `zun-node-run` launcher (src/bin/zun-node-run.rs): it
//     bundles the file -- or the `eval: true` text, as `-e` -- with this library
//     inlined and runs it with `zun run --ext`. So the worker gets the same
//     `worker_threads` module the parent has, and the boot below turns it into
//     the worker's: `isMainThread === false`, `parentPort`, `workerData`,
//     `threadId`.
//   * **The link** is a loopback TCP connection on the shared I/O loop
//     (src/io/io.ts): the parent listens on `127.0.0.1:0` before spawning, the
//     child connects at boot. A stdio pipe would have been the obvious
//     carrier, but a child Zun process has no non-blocking stdin -- only the
//     parent side of a pipe is on the loop -- while a socket is on the loop at
//     both ends, and leaves the worker's stdout and stderr to be its stdout and
//     stderr.
//   * **The framing** is one JSON document per line. A message is the
//     structured clone (the same `__wtClone` an in-process port uses, so every
//     `DataCloneError` is raised in the sender exactly as before) encoded by
//     `__wtEncode` into a JSON tree that keeps what JSON alone would lose:
//     `undefined`, `NaN`/`Infinity`/`-0`, `BigInt`, `Date`, `RegExp`, `Map`,
//     `Set`, errors, byte buffers, typed arrays, and shared or cyclic
//     references.
//
// Frames: `{t:"o"}` (the worker is running: `'online'`), `{t:"m",v}` (a
// message, either direction), `{t:"e",e}` (an uncaught exception in the worker,
// reported before it exits). A top-level throw in the worker never reaches any
// JavaScript -- the engine prints it and exits 1 -- so the parent also reads
// the worker's stderr and recognizes the engine's `unhandled exception:` line;
// every other stderr line is forwarded to the parent's stderr.
//
// Documented differences from a thread: a worker has its own heap, so a
// `SharedArrayBuffer` and `Atomics` are not shared; a `MessagePort` cannot be
// transferred to another process (it is delivered as a closed port); and
// `SHARE_ENV` gives a copy of `process.env`, not a shared one.

// `__wtHost.impl` is installed by src/worker_threads/host.ts, which the bundler
// appends only for a bundle that runs with the native extension (it needs
// `child_process.spawn`). Without it a `Worker` cannot start, and says so.
const __wtHost: any = { impl: null };

function __wtInstallHost(impl: any): void {
  __wtHost.impl = impl;
}

const __wtLinkState: any = { nextThreadId: 1, worker: null };

function __wtLinkNew(owner: any): any {
  return {
    owner: owner,
    id: 0,
    server: 0,
    connected: false,
    closed: false,
    inbuf: "",
    out: [],
    child: null,
    stdout: null,
    stderr: null,
    errtext: "",
    online: false,
    error: null,
    hasError: false,
    exited: false,
    exitCode: undefined,
    terminated: false,
    forwardStderr: true,
    ports: {},
    nextPortId: 1,
    isWorkerSide: false,
  };
}

// `data:text/javascript,<source>` (and the `;base64` form) is Node's other way
// to give a worker its source inline.
function __wtDataUrlSource(url: string): string {
  const comma = Number(url.indexOf(","));
  if (comma === -1) return "";
  const meta: string = url.slice(5, comma);
  const body: string = url.slice(comma + 1);
  if (meta.endsWith(";base64")) return String(Buffer.from(body, "base64").toString("utf8"));
  return decodeURIComponent(body);
}

// ---- encoding --------------------------------------------------------------

function __wtTypedName(value: any): string {
  if (value instanceof Int8Array) return "Int8Array";
  if (value instanceof Uint8ClampedArray) return "Uint8ClampedArray";
  if (value instanceof Uint8Array) return "Uint8Array";
  if (value instanceof Int16Array) return "Int16Array";
  if (value instanceof Uint16Array) return "Uint16Array";
  if (value instanceof Int32Array) return "Int32Array";
  if (value instanceof Uint32Array) return "Uint32Array";
  if (value instanceof Float32Array) return "Float32Array";
  if (value instanceof Float64Array) return "Float64Array";
  return "";
}

function __wtBytesOf(view: any): number[] {
  const bytes: any = new Uint8Array(view.buffer, Number(view.byteOffset), Number(view.byteLength));
  const out: number[] = [];
  const span = Number(bytes.length);
  for (let i = 0; i < span; i++) out.push(Number(bytes[i]));
  return out;
}

function __wtEncode(value: any, link: any = null): any {
  const seen: any[] = [];
  return __wtEncodeValue(value, seen, link);
}

// A port that is about to cross the link becomes a forwarding stand-in: it
// stays entangled with its local sibling, and whatever the sibling posts goes
// over the link under the id registered here (see `__wtPortPostMessage`).
function __wtExportPort(port: any, link: any): number {
  if (Number(port.__wtProxyId) !== 0 && port.__wtForward === link) return Number(port.__wtProxyId);
  const id = Number(link.nextPortId);
  link.nextPortId = id + 2;
  link.ports[String(id)] = port;
  port.__wtForward = link;
  port.__wtProxyId = id;
  // Messages the sibling posted before the transfer are already queued here.
  const queued: any[] = port.__wtQueue;
  port.__wtQueue = [];
  for (const entry of queued) {
    __wtLinkSend(link, { t: "pm", id: id, v: __wtEncode(entry.data, link) });
  }
  return id;
}

function __wtEncodeValue(value: any, seen: any[], link: any): any {
  if (value === undefined) return { $: "u" };
  if (value === null) return null;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return value;
  if (kind === "number") {
    const n: number = value;
    if (n !== n) return { $: "f", v: "NaN" };
    if (n === Infinity) return { $: "f", v: "Infinity" };
    if (n === -Infinity) return { $: "f", v: "-Infinity" };
    if (n === 0 && 1 / n < 0) return { $: "f", v: "-0" };
    return n;
  }
  if (kind === "bigint") return { $: "n", v: String(value) };
  if (kind !== "object") return { $: "u" };

  const index = Number(seen.indexOf(value));
  if (index !== -1) return { $: "r", i: index };
  const id = Number(seen.length);
  seen.push(value);

  if (value instanceof MessagePort) {
    if (link !== null && link !== undefined && value.__wtActive === true) {
      return { $: "p", i: id, k: __wtExportPort(value, link) };
    }
    return { $: "p", i: id, k: 0 };
  }
  if (value instanceof Date) return { $: "d", i: id, v: Number(value.getTime()) };
  if (value instanceof RegExp) return { $: "x", i: id, s: String(value.source), f: String(value.flags) };
  if (value instanceof Error) {
    const props: any = {};
    for (const key of Object.keys(value)) {
      if (key === "name" || key === "message" || key === "stack") continue;
      props[key] = __wtEncodeValue(value[key], seen, link);
    }
    return {
      $: "e",
      i: id,
      name: String(value.name),
      message: String(value.message),
      stack: typeof value.stack === "string" ? value.stack : null,
      p: props,
    };
  }
  if (Buffer.isBuffer(value)) return { $: "b", i: id, v: __wtBytesOf(value) };
  if (value instanceof ArrayBuffer) {
    const all: any = new Uint8Array(value);
    return { $: "ab", i: id, v: __wtBytesOf(all) };
  }
  if (ArrayBuffer.isView(value) === true) {
    const name: string = __wtTypedName(value);
    if (name !== "") return { $: "t", i: id, k: name, v: __wtBytesOf(value) };
  }
  if (Array.isArray(value)) {
    const items: any[] = [];
    const total = Number(value.length);
    for (let i = 0; i < total; i++) items.push(__wtEncodeValue(value[i], seen, link));
    return { $: "a", i: id, v: items };
  }
  if (value instanceof Map) {
    const entries: any[] = [];
    for (const entry of value) {
      entries.push([__wtEncodeValue(entry[0], seen, link), __wtEncodeValue(entry[1], seen, link)]);
    }
    return { $: "m", i: id, v: entries };
  }
  if (value instanceof Set) {
    const items: any[] = [];
    for (const item of value) items.push(__wtEncodeValue(item, seen, link));
    return { $: "s", i: id, v: items };
  }
  const props: any = {};
  for (const key of Object.keys(value)) props[key] = __wtEncodeValue(value[key], seen, link);
  return { $: "o", i: id, v: props };
}

function __wtDecode(tree: any, link: any = null): any {
  const refs: any[] = [];
  return __wtDecodeValue(tree, refs, link);
}

function __wtMakeError(name: string, message: string): any {
  if (name === "TypeError") return new TypeError(message);
  if (name === "RangeError") return new RangeError(message);
  if (name === "SyntaxError") return new SyntaxError(message);
  if (name === "ReferenceError") return new ReferenceError(message);
  const error: any = new Error(message);
  if (name !== "Error") error.name = name;
  return error;
}

function __wtBytesInto(view: any, bytes: any[]): void {
  const target: any = new Uint8Array(view.buffer, Number(view.byteOffset), Number(view.byteLength));
  const span = Number(bytes.length);
  for (let i = 0; i < span; i++) target[i] = Number(bytes[i]);
}

function __wtTypedNew(name: string, length: number): any {
  if (name === "Int8Array") return new Int8Array(length);
  if (name === "Uint8ClampedArray") return new Uint8ClampedArray(length);
  if (name === "Int16Array") return new Int16Array(length / 2);
  if (name === "Uint16Array") return new Uint16Array(length / 2);
  if (name === "Int32Array") return new Int32Array(length / 4);
  if (name === "Uint32Array") return new Uint32Array(length / 4);
  if (name === "Float32Array") return new Float32Array(length / 4);
  if (name === "Float64Array") return new Float64Array(length / 8);
  return new Uint8Array(length);
}

function __wtDecodeValue(tree: any, refs: any[], link: any): any {
  if (tree === null) return null;
  const kind = typeof tree;
  if (kind !== "object") return tree;
  const tag: string = String(tree.$);
  if (tag === "u") return undefined;
  if (tag === "f") {
    const text: string = String(tree.v);
    if (text === "NaN") return NaN;
    if (text === "Infinity") return Infinity;
    if (text === "-Infinity") return -Infinity;
    return -0;
  }
  if (tag === "n") return BigInt(String(tree.v));
  if (tag === "r") return refs[Number(tree.i)];
  const id = Number(tree.i);
  if (tag === "p") {
    const port: any = __wtNewPort();
    refs[id] = port;
    const proxy = Number(tree.k === undefined ? 0 : tree.k);
    if (proxy === 0 || link === null || link === undefined) {
      // A port that was not transferred (or had nowhere to go) arrives closed.
      port.__wtDetached = true;
      port.__wtActive = false;
      return port;
    }
    // The remote end of a transferred port: what it posts goes back over the
    // link to the sibling the port was entangled with.
    port.__wtLink = link;
    port.__wtProxyId = proxy;
    link.ports[String(proxy)] = port;
    return port;
  }
  if (tag === "d") {
    const date: any = new Date(Number(tree.v));
    refs[id] = date;
    return date;
  }
  if (tag === "x") {
    const re: any = new RegExp(String(tree.s), String(tree.f));
    refs[id] = re;
    return re;
  }
  if (tag === "e") {
    const error: any = __wtMakeError(String(tree.name), String(tree.message));
    refs[id] = error;
    if (tree.stack !== null && tree.stack !== undefined) error.stack = tree.stack;
    const props: any = tree.p;
    if (props !== null && props !== undefined) {
      for (const key of Object.keys(props)) error[key] = __wtDecodeValue(props[key], refs, link);
    }
    return error;
  }
  if (tag === "b") {
    const buffer: any = Buffer.from(tree.v);
    refs[id] = buffer;
    return buffer;
  }
  if (tag === "ab") {
    const bytes: any[] = tree.v;
    const ab: any = new ArrayBuffer(Number(bytes.length));
    const view: any = new Uint8Array(ab);
    const span = Number(bytes.length);
    for (let i = 0; i < span; i++) view[i] = Number(bytes[i]);
    refs[id] = ab;
    return ab;
  }
  if (tag === "t") {
    const bytes: any[] = tree.v;
    const typed: any = __wtTypedNew(String(tree.k), Number(bytes.length));
    __wtBytesInto(typed, bytes);
    refs[id] = typed;
    return typed;
  }
  if (tag === "a") {
    const out: any[] = [];
    refs[id] = out;
    for (const item of tree.v) out.push(__wtDecodeValue(item, refs, link));
    return out;
  }
  if (tag === "m") {
    const out: any = new Map();
    refs[id] = out;
    for (const entry of tree.v) {
      out.set(__wtDecodeValue(entry[0], refs, link), __wtDecodeValue(entry[1], refs, link));
    }
    return out;
  }
  if (tag === "s") {
    const out: any = new Set();
    refs[id] = out;
    for (const item of tree.v) out.add(__wtDecodeValue(item, refs, link));
    return out;
  }
  const out: any = {};
  refs[id] = out;
  const props: any = tree.v;
  for (const key of Object.keys(props)) out[key] = __wtDecodeValue(props[key], refs, link);
  return out;
}

// The structured clone with a transfer list, for a message that leaves through
// the link: ports are moved exactly as `__wtPortPostMessage` moves them (the
// clone then holds their local stand-ins, which the encoder exports), and
// buffers are marked detached.
function __wtCloneTransfer(value: any, list: any[]): any {
  const prepared: any[] = __wtPrepareTransfer(null, list);
  const moved: any[] = [];
  const replacements: any[] = [];
  for (const item of prepared[0]) {
    moved.push(item);
    replacements.push(__wtTransferPort(item));
  }
  for (const item of prepared[1]) {
    __wtDetachedBuffers.set(item, true);
    moved.push(item);
    replacements.push(item);
  }
  return __wtClone(value, moved, replacements);
}

// ---- the link: framing over a loopback socket -------------------------------

function __wtLinkSend(link: any, frame: any): void {
  if (link.closed === true) return;
  const text: string = JSON.stringify(frame) + "\n";
  link.out.push(Buffer.from(text, "utf8"));
  __wtLinkFlush(link);
}

// Write as much of the outgoing queue as the socket takes now; the rest waits
// for a writable event.
function __wtLinkFlush(link: any): void {
  const ops: any = __ioOps();
  if (ops === null || ops === undefined) return;
  if (link.connected !== true || link.closed === true) return;
  const id = Number(link.id);
  while (Number(link.out.length) > 0) {
    const head: any = link.out[0];
    const reply: string = String(ops.write(id, head.toString("base64")));
    if (reply === "-") {
      link.out = [];
      break;
    }
    if (reply === "+A") break;
    const taken = Number(reply.slice(1));
    if (taken >= Number(head.length)) {
      link.out.shift();
    } else {
      link.out[0] = head.subarray(taken);
      break;
    }
  }
  if (Number(link.out.length) > 0) {
    __ioWant(id, __IO_WRITE);
  } else {
    __ioUnwant(id, __IO_WRITE);
  }
  __wtLinkSyncRef(link);
}

// Read everything pending and dispatch each complete line. Answers false once
// the peer has closed.
function __wtLinkRead(link: any): boolean {
  const ops: any = __ioOps();
  if (ops === null || ops === undefined || link.closed === true || Number(link.id) === 0) return false;
  let open = true;
  while (true) {
    const reply: string = String(ops.read(Number(link.id), 0));
    if (reply === "-" || reply === "+E") {
      open = false;
      break;
    }
    if (reply === "+A") break;
    link.inbuf = String(link.inbuf) + String(Buffer.from(reply.slice(2), "base64").toString("utf8"));
  }
  while (true) {
    const text: string = String(link.inbuf);
    const nl = Number(text.indexOf("\n"));
    if (nl === -1) break;
    link.inbuf = text.slice(nl + 1);
    const line: string = text.slice(0, nl);
    if (line === "") continue;
    __wtLinkFrame(link, JSON.parse(line));
  }
  if (!open) __wtLinkClose(link);
  return open;
}

function __wtLinkClose(link: any): void {
  if (link.closed === true) return;
  link.closed = true;
  const id = Number(link.id);
  if (id !== 0) __ioUnregister(id);
  link.id = 0;
  if (link.isWorkerSide === true) {
    // The parent is gone or called `terminate()`: either way this worker
    // stops now, as a thread would.
    host.exitProcess(1);
  }
}

function __wtLinkHandler(link: any): any {
  return {
    readable(): void {
      __wtLinkRead(link);
    },
    writable(): void {
      if (link.connected !== true) {
        const ops: any = __ioOps();
        const status: string = String(ops.connectError(Number(link.id)));
        if (status === "-") {
          __wtLinkClose(link);
          return;
        }
        link.connected = true;
        __ioWant(Number(link.id), __IO_READ);
      }
      __wtLinkFlush(link);
    },
    failed(): void {
      __wtLinkRead(link);
      __wtLinkClose(link);
    },
  };
}

// A worker keeps itself alive while its `parentPort` is ref'd (a `'message'`
// listener or `ref()`), while it still has frames to write, and until it has
// connected; the parent's link never holds the parent open -- the child
// process handle does.
function __wtLinkSyncRef(link: any): void {
  if (link.isWorkerSide !== true || Number(link.id) === 0) return;
  const port: any = link.owner;
  let want: boolean =
    link.connected !== true || Number(link.out.length) > 0 || (port !== null && port.hasRef() === true);
  if (!want) {
    for (const key of Object.keys(link.ports)) {
      const proxy: any = link.ports[key];
      if (proxy.__wtLink === link && proxy.hasRef() === true) want = true;
    }
  }
  if (want) {
    __ioRef(Number(link.id));
  } else {
    __ioUnref(Number(link.id));
  }
}

function __wtLinkFrame(link: any, frame: any): void {
  const type: string = String(frame.t);
  if (type === "pm") {
    const entry: any = link.ports[String(frame.id)];
    if (entry === undefined || entry === null) return;
    const data: any = __wtDecode(frame.v, link);
    // A forwarding stand-in delivers to the sibling it is entangled with; a
    // remote end delivers to itself.
    const target: any = entry.__wtForward !== null && entry.__wtForward !== undefined ? entry.__wtSibling : entry;
    if (target === null || target === undefined || target.__wtActive !== true) return;
    target.__wtQueue.push({ data: data, ports: [] });
    __wtArmDrain(target);
    return;
  }
  if (link.isWorkerSide === true) {
    if (type === "m") {
      const port: any = link.owner;
      if (port.__wtActive !== true) return;
      port.__wtQueue.push({ data: __wtDecode(frame.v, link), ports: [] });
      __wtArmDrain(port);
    }
    return;
  }
  const worker: any = link.owner;
  if (type === "o") {
    __wtLinkOnline(link);
    return;
  }
  if (type === "m") {
    __wtLinkOnline(link);
    worker.emit("message", __wtDecode(frame.v, link));
    return;
  }
  if (type === "e") {
    link.error = __wtDecode(frame.e);
    link.hasError = true;
  }
}

function __wtLinkOnline(link: any): void {
  if (link.online === true) return;
  link.online = true;
  link.owner.emit("online");
}

// ---- the parent side -------------------------------------------------------

function __wtAccept(link: any): void {
  const ops: any = __ioOps();
  if (Number(link.server) === 0 || Number(link.id) !== 0 || link.closed === true) return;
  const reply: string = String(ops.accept(Number(link.server)));
  if (reply === "-" || reply === "+A") return;
  const fields: string[] = __ioFields(reply);
  const id = Number(fields[0]);
  __ioUnregister(Number(link.server));
  link.server = 0;
  link.id = id;
  link.connected = true;
  __ioRegister(id, __wtLinkHandler(link));
  __ioUnref(id);
  __ioWant(id, __IO_READ);
  __wtLinkFlush(link);
}

function __wtStrings(list: any): string[] {
  const out: string[] = [];
  if (list === undefined || list === null) return out;
  for (const item of list) out.push(String(item));
  return out;
}

function __wtEnvCopy(source: any): any {
  const env: any = {};
  for (const key of Object.keys(source)) {
    const value: any = source[key];
    if (value !== undefined) env[key] = String(value);
  }
  return env;
}

function __wtSpawnWorker(link: any, host: any, opts: any, code: any, script: string, data: any): void {
  const ops: any = __ioOps();
  const listen: string = String(ops.listen("127.0.0.1", 0, 8, 0));
  if (listen === "-") throw __ioLastError();
  const fields: string[] = __ioFields(listen);
  link.server = Number(fields[0]);
  const port = Number(fields[2]);
  __ioRegister(Number(link.server), {
    readable(): void {
      __wtAccept(link);
    },
    writable(): void {},
    failed(): void {},
  });
  __ioUnref(Number(link.server));
  __ioWant(Number(link.server), __IO_READ);

  const envData: any[] = [];
  for (const entry of __wtEnvironmentData) envData.push([entry[0], entry[1]]);
  const boot: any = {
    port: port,
    threadId: Number(link.owner.threadId),
    name: opts.name === undefined || opts.name === null ? "" : String(opts.name),
    workerData: __wtEncode(data, link),
    environmentData: __wtEncode(envData),
    resourceLimits: link.owner.resourceLimits,
    execArgv: __wtStrings(opts.execArgv === undefined || opts.execArgv === null ? process.execArgv : opts.execArgv),
  };
  let env: any = null;
  if (opts.env !== undefined && opts.env !== null && opts.env !== __wtShareEnv && typeof opts.env === "object") {
    env = __wtEnvCopy(opts.env);
  } else {
    env = __wtEnvCopy(process.env);
  }
  env["ZUN_NODE_WORKER"] = JSON.stringify(boot);

  const args: any[] = [];
  if (opts.execArgv !== undefined && opts.execArgv !== null) {
    for (const flag of opts.execArgv) args.push(String(flag));
  }
  if (code !== null) {
    args.push("-e");
    args.push(String(code));
    // `process.argv[1]` of an eval worker is Node's placeholder.
    args.push("[worker eval]");
  } else {
    args.push(script);
  }
  if (opts.argv !== undefined && opts.argv !== null) {
    for (const item of opts.argv) args.push(String(item));
  }
  // The common case -- `new Worker(__filename)`, the test re-running itself as
  // the worker -- needs no second bundling: the program already running *is*
  // that script's bundle, so the worker runs it with `zun run` directly and
  // gets its `process.argv` tail through `ZUN_NODE_ARGV`, as the launcher
  // would hand it over. Bundling is the expensive part of starting a worker
  // (seconds), compiling the bundle is not.
  let file: string = String(process.execPath);
  let argv: any[] = args;
  const self: any = __wtSelfBundle(code, script);
  if (self !== null) {
    file = String(self.zun);
    argv = ["run", "--ext", String(self.ext), String(self.bundle)];
    const tail: string[] = [script];
    if (opts.argv !== undefined && opts.argv !== null) {
      for (const item of opts.argv) tail.push(String(item));
    }
    env["ZUN_NODE_ARGV"] = "A" + tail.join("\u001f");
    // The launcher's recursion guard, which this path bypasses: a script
    // that starts a worker of itself unconditionally would otherwise spawn
    // generations without end (it happened, with the one test whose
    // relative path is only accepted because of where the runner runs it).
    const depth = Number(process.env["ZUN_NODE_DEPTH"] === undefined ? 0 : process.env["ZUN_NODE_DEPTH"]);
    if (depth >= 8) {
      throw new NodeError("ERR_WORKER_INIT_FAILED", "Worker re-execution depth limit (8) reached");
    }
    env["ZUN_NODE_DEPTH"] = String(depth + 1);
  }
  // Both output streams are pipes, as a worker's are in Node: `worker.stdout`
  // and `worker.stderr` are readable in the parent, and unless the worker was
  // created with `stdout: true` / `stderr: true` what arrives on them is also
  // written to the parent's own stream.
  const stdio: any[] = ["ignore", "pipe", "pipe"];
  const child: any = host.spawn(file, argv, { env: env, stdio: stdio, windowsHide: true });
  __ioPatience.holders = Number(__ioPatience.holders) + 1;
  link.child = child;
  link.stdout = child.stdout;
  link.stderr = child.stderr;
  link.forwardStderr = opts.stderr !== true;
  const stdout: any = child.stdout;
  if (stdout !== null && stdout !== undefined && opts.stdout !== true) {
    stdout.on("data", (chunk: any): void => {
      process.stdout.write(chunk);
    });
  }
  const stderr: any = child.stderr;
  if (stderr !== null && stderr !== undefined) {
    stderr.on("data", (chunk: any): void => {
      __wtOnStderr(link, String(chunk), false);
    });
  }
  child.on("error", (error: any): void => {
    if (link.hasError !== true) {
      link.error = error;
      link.hasError = true;
    }
  });
  child.on("close", (exitCode: any, signal: any): void => {
    __wtOnClose(link, exitCode, signal);
  });
}

// `{ zun, ext, bundle }` when the worker script is the running program's own
// source file and this program is a bundle run by `zun run --ext`, else null.
function __wtSelfBundle(code: any, script: string): any {
  if (code !== null) return null;
  const zun: any = process.env["ZUN_NODE_ZUN"];
  const ext: any = process.env["ZUN_NODE_EXT"];
  const bundle: any = __processArgvSplit.script;
  if (typeof zun !== "string" || zun === "" || typeof ext !== "string" || ext === "") return null;
  if (typeof bundle !== "string" || !bundle.endsWith(".ts")) return null;
  const own: string = String(__filename);
  if (__wtSamePath(own, script)) return { zun: zun, ext: ext, bundle: bundle };
  return null;
}

function __wtSamePath(a: string, b: string): boolean {
  if (pathPlatformIsWindows()) {
    return a.split("/").join("\\").toLowerCase() === b.split("/").join("\\").toLowerCase();
  }
  return a === b;
}

const __WT_FATAL_PREFIXES: string[] = ["zun: runtime error: unhandled exception: ", "Uncaught "];

// The worker's stderr, line by line: the engine's report of an uncaught
// exception becomes the `'error'` event, everything else is the worker's own
// output and goes to the parent's stderr.
function __wtOnStderr(link: any, text: string, final: boolean): void {
  link.errtext = String(link.errtext) + text;
  while (true) {
    const all: string = String(link.errtext);
    let nl = Number(all.indexOf("\n"));
    if (nl === -1) {
      if (!final || all === "") break;
      nl = Number(all.length);
    }
    const line: string = all.slice(0, nl);
    link.errtext = all.slice(nl + 1);
    let fatal = false;
    for (const prefix of __WT_FATAL_PREFIXES) {
      if (line.startsWith(prefix) && link.hasError !== true) {
        link.error = __wtParseFatal(line.slice(Number(prefix.length)));
        link.hasError = true;
        fatal = true;
        break;
      }
    }
    if (!fatal && link.forwardStderr === true) process.stderr.write(line + "\n");
  }
}

// `TypeError: message` back into a `TypeError`; a thrown non-error is
// reported by the engine as its string form and is handed over as a string.
function __wtParseFatal(text: string): any {
  const colon = Number(text.indexOf(": "));
  if (colon > 0) {
    const name: string = text.slice(0, colon);
    if (/^[A-Za-z_$][\w$]*Error$/.test(name)) {
      return __wtMakeError(name, text.slice(colon + 2));
    }
  }
  if (/^[A-Za-z_$][\w$]*Error$/.test(text)) return __wtMakeError(text, "");
  return text;
}

function __wtOnClose(link: any, exitCode: any, signal: any): void {
  __ioPatience.holders = Number(__ioPatience.holders) - 1;
  // Whatever the worker wrote before it exited is still in the socket (or the
  // connection is still waiting to be accepted): deliver it first.
  __wtAccept(link);
  if (Number(link.id) !== 0) __wtLinkRead(link);
  __wtOnStderr(link, "", true);
  __wtLinkClose(link);
  if (Number(link.server) !== 0) {
    __ioUnregister(Number(link.server));
    link.server = 0;
  }
  let code: number = exitCode === null || exitCode === undefined ? 1 : Number(exitCode);
  if (link.terminated === true) code = 1;
  link.exited = true;
  link.exitCode = code;
  const worker: any = link.owner;
  if (link.hasError === true && link.terminated !== true) {
    __wtLinkOnline(link);
    worker.emit("error", link.error);
  } else if (link.terminated !== true && link.online !== true && code === 0) {
    // A worker script that never loaded this module never connected, but it
    // did run.
    __wtLinkOnline(link);
  }
  worker.emit("exit", code);
}

// ---- the worker side -------------------------------------------------------

function __wtBootWorker(module: any): void {
  const raw: any = process.env["ZUN_NODE_WORKER"];
  if (raw === undefined || raw === null || raw === "") return;
  // Not inherited by anything this worker spawns in turn.
  process.env["ZUN_NODE_WORKER"] = "";
  const boot: any = JSON.parse(String(raw));
  const port: any = __wtNewPort();
  const link: any = __wtLinkNew(port);
  link.isWorkerSide = true;
  // Port ids are odd when the parent allocates them and even here, so the two
  // ends never hand out the same one.
  link.nextPortId = 2;
  port.__wtLink = link;
  __wtLinkState.worker = link;
  __wtLinkState.nextThreadId = Number(boot.threadId) * 1000 + 1;

  module.isMainThread = false;
  module.threadId = Number(boot.threadId);
  module.threadName = String(boot.name);
  module.parentPort = port;
  module.workerData = __wtDecode(boot.workerData, link);
  const limits: any = boot.resourceLimits === undefined || boot.resourceLimits === null ? {} : boot.resourceLimits;
  const filled: any = {
    maxYoungGenerationSizeMb: 48,
    maxOldGenerationSizeMb: 2048,
    codeRangeSizeMb: 0,
    stackSizeMb: 4,
  };
  for (const key of Object.keys(limits)) filled[key] = limits[key];
  module.resourceLimits = filled;
  if (Array.isArray(boot.execArgv)) process.execArgv = boot.execArgv;
  const envData: any[] = __wtDecode(boot.environmentData);
  for (const entry of envData) __wtEnvironmentData.set(entry[0], entry[1]);

  const ops: any = __ioOps();
  if (ops === null || ops === undefined) return;
  const reserved: string = String(ops.socket());
  if (reserved === "-") return;
  const reservedId = Number(__ioFields(reserved)[0]);
  const reply: string = String(ops.connect(reservedId, "127.0.0.1", Number(boot.port), "", 0));
  if (reply === "-") return;
  const fields: string[] = __ioFields(reply);
  link.id = Number(fields[0]);
  __ioRegister(Number(link.id), __wtLinkHandler(link));
  if (String(fields[1]) === "1") {
    link.connected = true;
    __ioWant(Number(link.id), __IO_READ);
  } else {
    __ioWant(Number(link.id), __IO_WRITE);
  }
  __processWorkerHook.target = {
    uncaught(error: any): void {
      __wtLinkSend(link, { t: "e", e: __wtEncode(error) });
      // The worker exits right after this. A frame still queued (the link may
      // not have finished connecting yet) would be lost, so the report also
      // goes out the way the engine reports a top-level throw, which the
      // parent recognizes on the worker's stderr.
      if (link.connected !== true || Number(link.out.length) > 0) {
        let text: string = "";
        try {
          text = error instanceof Error ? String(error.name) + ": " + String(error.message) : String(error);
        } catch (ignored) {
          text = "Error";
        }
        host.stderrWrite("zun: runtime error: unhandled exception: " + text + "\n");
      }
    },
  };
  __ioTurnHooks.push({
    turn(): void {
      __wtLinkSyncRef(link);
    },
  });
  __wtLinkSend(link, { t: "o" });
}

// ---------------------------------------------------------------------------
// postMessageToThread
// ---------------------------------------------------------------------------

// `postMessageToThread(threadId, value, transferList?, timeout?)` answers a
// promise. The only case this runtime can decide is the one it *is*: posting to
// your own thread is `ERR_WORKER_MESSAGING_SAME_THREAD`, and every other thread
// id does not exist, which Node reports as `ERR_WORKER_MESSAGING_FAILED`.
function __wtPostMessageToThread(threadId: any, value?: any, transferList?: any, timeout?: any): any {
  if (typeof threadId !== "number") {
    return Promise.reject(new ERR_INVALID_ARG_TYPE("threadId", "number", threadId));
  }
  if (threadId === 0) {
    return Promise.reject(
      new NodeError(
        "ERR_WORKER_MESSAGING_SAME_THREAD",
        "Cannot send a message to the same thread",
      ),
    );
  }
  return Promise.reject(
    new NodeError("ERR_WORKER_MESSAGING_FAILED", "Cannot find the destination thread"),
  );
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------

const __node_worker_threads: any = {
  isMainThread: true,
  isInternalThread: false,
  threadId: 0,
  threadName: "MainThread",
  MessagePort: MessagePort,
  MessageChannel: __zunMessageChannel,
  BroadcastChannel: BroadcastChannel,
  Worker: Worker,
  parentPort: null,
  workerData: null,
  resourceLimits: __wtResourceLimits,
  SHARE_ENV: __wtShareEnv,
  markAsUntransferable: __wtMarkAsUntransferable,
  isMarkedAsUntransferable: __wtIsMarkedAsUntransferable,
  markAsUncloneable: __wtMarkAsUncloneable,
  moveMessagePortToContext: __wtMoveMessagePortToContext,
  postMessageToThread: __wtPostMessageToThread,
  setEnvironmentData: __wtSetEnvironmentData,
  getEnvironmentData: __wtGetEnvironmentData,
  receiveMessageOnPort(port: any): any {
    if (!(port instanceof MessagePort) && !(port instanceof BroadcastChannel)) {
      throw new ERR_INVALID_ARG_TYPE_MESSAGE(
        'The "port" argument must be a MessagePort instance',
      );
    }
    return __wtReceiveMessage(port);
  },
};

// A worker process turns this module into the worker's view of it.
__wtBootWorker(__node_worker_threads);

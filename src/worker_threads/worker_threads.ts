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
//   2. **`Worker`** — a second JavaScript realm running on a second thread.
//      The Zun VM has one thread and one realm, so there is nothing here for a
//      `Worker` to run *in*. The constructor below is therefore the real
//      Node constructor down to the last validation — every `ERR_*` a bad
//      `filename`, `execArgv`, `env`, `name`, `resourceLimits` or `workerData`
//      raises is raised here, in Node's order — and then it reports the one
//      honest failure left: there is no thread. See the `Worker` section for
//      the design of the child-process form and what it still needs.
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
//     `BroadcastChannel` and `DOMException` are *not* in the prelude, so they
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
// DOMException
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

class DOMException extends Error {
  code: number = 0;
  constructor(message: string = "", name: string = "Error") {
    super(message);
    this.name = name;
    this.code = __wtDomCode(name);
  }
}

function __wtDataCloneError(message: string): any {
  return new DOMException(message, "DataCloneError");
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

  postMessage(value: any = __WT_MISSING, options: any = undefined): void {
    if (value === __WT_MISSING) {
      throw new NodeTypeError(
        "ERR_MISSING_ARGS",
        "Not enough arguments to MessagePort.postMessage",
      );
    }
    __wtPortPostMessage(this, value, options);
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
    port.__wtDrainHandle = setTimeout(__wtDrainPort, 0, port);
  } else {
    port.__wtDrainHandle = setImmediate(__wtDrainPort, port);
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
  const handle: any = setImmediate(__wtFinishClose, port);
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

  constructor(name: any = __WT_MISSING) {
    super();
    if (name === __WT_MISSING) {
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

  postMessage(message: any = __WT_MISSING): void {
    if (this.__wtOpen !== true) {
      throw new DOMException("BroadcastChannel is closed.", "InvalidStateError");
    }
    if (message === __WT_MISSING) {
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
  const handle: any = setImmediate(__wtDrainBroadcast, channel);
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
// Then it reports the one thing left: there is no second thread.
//
// ---------------------------------------------------------------------------
// The design for a real `Worker`, and what it still needs
// ---------------------------------------------------------------------------
//
// A `Worker` here cannot be a thread — the VM has one — so it has to be a
// **child Zun process**, which is the same trade `child_process.fork` makes and
// which keeps every observable fact a worker has *except* the shared heap:
//
//   * **The script.** The child runs a bundle produced by the same
//     `tools/bundle_node_test.sh` machinery the tests go through, so the worker
//     script gets this library inlined exactly as the parent did. `eval: true`
//     bundles the string instead of a file.
//   * **The handshake.** `isMainThread === false`, `threadId`, `workerData`,
//     `environmentData` and `resourceLimits` are the *first* frame the parent
//     writes to the child's stdin; the child's prologue reads it before running
//     the script and installs `parentPort` as a `MessagePort` whose sibling is
//     the pipe rather than another in-process port. That is the one place the
//     class above needs a seam, and it already has it: a port with
//     `__wtSibling === null` delivers nothing, so a pipe-backed port is a
//     subclass that overrides `postMessage` and pushes onto `__wtQueue` from
//     the reader.
//   * **The framing.** `src/v8/v8.ts` is V8's value-serialization wire format
//     over a `Buffer`, which is exactly what Node puts on a worker's message
//     channel (`advanced` serialization in `child_process` terms). A frame is a
//     4-byte length plus a `v8.serialize` payload, so a message is self
//     delimiting and the structured-clone rules above are reused rather than
//     re-derived.
//   * **The events.** `online` fires when the child's prologue acknowledges the
//     handshake; `message` per inbound frame; `error` for a frame carrying a
//     serialized exception; `exit` with the child's exit code. `terminate()`
//     kills the child and resolves with `1`. `stdout`/`stderr` are the child's
//     pipes wrapped as `Readable`s, which `src/stream/stream.ts` already gives.
//   * **What differs, and is documented rather than hidden**: a worker has its
//     own heap, so a `SharedArrayBuffer` cannot be shared (the engine has none
//     either); `process.exit()` in a worker ends only the worker, which a child
//     process gives for free; and `process.env` is a copy unless `SHARE_ENV`,
//     where a child process can only ever be a copy — `SHARE_ENV` is therefore
//     a gap that needs a shared store, not a pipe.
//
// **The missing piece is a non-blocking read of the child's stdout.** The
// parent must notice an inbound frame without blocking, which needs a
// poll-based event loop over the pipe; `src/child_process/*.rs` has
// `std::process::Command` and a blocking read, and the loop is being built on
// another branch (`feat/net`, `src/io/`, not merged). This file deliberately
// does **not** grow a socket loop of its own: when `src/io/` lands, `Worker`
// needs the reader above and nothing else, because every rule a message obeys
// on the way in and out is already here.

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
  return value instanceof URL;
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
    __wtClone(opts.workerData, transferList, transferList);

    throw new ERR_METHOD_NOT_IMPLEMENTED(
      "worker_threads.Worker constructor (" +
        String(resolved) +
        "): this runtime has one thread and one realm, so a Worker has to be a " +
        "child process, which needs the poll-based loop under src/io/",
    );
  }

  postMessage(): void {
    throw new ERR_METHOD_NOT_IMPLEMENTED("worker.postMessage");
  }

  terminate(): any {
    throw new ERR_METHOD_NOT_IMPLEMENTED("worker.terminate");
  }

  ref(): void {}

  unref(): void {}

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

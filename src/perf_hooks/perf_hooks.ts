// node:perf_hooks — the performance timeline, user timing, observers,
// histograms and `performance.timerify`, in Zun TypeScript.
//
// Behavior is defined by Node.js 25: this module follows the algorithms in
// Node's `lib/perf_hooks.js`, `lib/internal/perf/*` and
// `lib/internal/histogram.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors), because the observable details are not derivable from the
// documentation — the three separate global entry buffers and the order
// `getEntries()` concatenates them in, `measure`'s six-way
// start/end/duration resolution, the resource-timing *secondary* buffer and
// the single `resourcetimingbufferfull` event that drains it, the fact that an
// observer callback is delivered from a `setImmediate` rather than inline, and
// the exact empty-histogram readings (`min` is `INT64_MAX`, `mean` and
// `stddev` are `NaN`).
//
// It is pure computation (PLAN.md principle 2) over one capability it does not
// own: a clock. The clock is `process.hrtime`, which `src/process/process.ts`
// already answers in both of its forms — through the `node:process` extension
// when one is loaded, and from `Date.now()` when none is (see the NO-EXT notes
// in that file). So there is no `zun_abi` extension here and no second native:
// this file reads `__processHrtimeDigits()`, the one function behind both
// `process.hrtime()` and `process.hrtime.bigint()`.
//
// ---------------------------------------------------------------------------
// Resolution, and why the tracker kind is `zun-ts` rather than `zun-ts+ext`
// ---------------------------------------------------------------------------
//
// `performance.now()` is as sharp as the clock under it:
//
//   | how the bundle runs            | resolution of `now()`                |
//   | ------------------------------ | ------------------------------------ |
//   | `zun run --ext <lib> b.ts`     | the platform monotonic clock, ~100 ns |
//   | `zun run b.ts`                 | whole milliseconds (`Date.now()`)    |
//
// Measured on this machine, two `now()` calls a few statements apart read
// 0.4355 and 0.6536 with the extension and 3 and 3 without it. No test in
// Node's `test-perf-hooks*` / `test-performance*` corpus distinguishes the two,
// because every timing assertion in it is either a comparison against a
// `setTimeout` of 50 ms or more, or a `duration > 0` over a mark taken at
// `startTime: 0` — true at millisecond resolution as well. The module is
// therefore registered as `zun-ts` in `tools/run_node_tests.sh`: it needs no
// extension to be correct, and passing `--ext` only sharpens it. A reader who
// wants nanoseconds runs the bundle with `--ext`; nothing else changes.
//
// `timeOrigin` is the `Date.now()` reading taken when this module is loaded,
// which is the earliest unix timestamp the library can observe. Node's is the
// process start, a few milliseconds earlier.
//
// ---------------------------------------------------------------------------
// Shapes that differ from Node's source, and why
// ---------------------------------------------------------------------------
//
// * **`Performance`'s methods never read `this`.** Each is a one-line
//   delegation to a top-level function over module-level state. That is not a
//   style preference: `performance` is also reachable as
//   `__node_perf_hooks.performance`, an `any`-typed path that threads no
//   receiver (https://github.com/UrubuCode/zun/issues/1), so a method body
//   that read `this` would answer `undefined` for one of the two spellings
//   Node's tests use. The entry and histogram classes do use `this`, because
//   they are only ever reached as a known class type — which is where this
//   engine does thread a receiver, and the corpus needs them to be classes
//   anyway (`entry instanceof PerformanceMark`). A *getter* read through an
//   `any` also works; it is a method read as a *value* that does not (zun#19,
//   and see `__zunPerformance`).
//
// * **`performance` is reached as `__zunPerformance`.** `performance` is a
//   global in Node, and the engine's prelude has one of its own
//   (`crates/zun_prelude/builtin/performance.zun`) with a single method. That
//   method's spelling is intercepted by the checker *even when a user
//   declaration shadows it*: with a top-level
//   `const performance = { now() { return 42; } }` in scope,
//   `performance.now()` still answers the prelude's epoch-millisecond clock,
//   while `performance.mark(...)` and `performance.timeOrigin` reach the
//   declaration. This is the same gap `src/console/global.ts` documents for
//   `console`, and it has the same fix: `tools/bundle_node_test.sh` rewrites
//   `performance` *as a receiver* to the second name below, which is an
//   ordinary identifier the checker has no opinion about.
//
// * **One exact histogram instead of HdrHistogram.** Node's histograms are
//   `hdr_histogram` handles with a configurable significant-figure count, so a
//   recorded value is bucketed and read back approximately. Here a histogram
//   is a value→count `Map` plus running sums, which is *exact* — and exactness
//   is a superset of what the corpus checks (`record(1)` then `min`, `max`,
//   `mean`, `stddev`, `percentile(1)`, `percentile(100)` and the whole
//   `percentiles` map). `lowest`/`highest`/`figures` are still validated
//   exactly as Node validates them, and `highest` still decides `exceeds`;
//   `figures` has nothing to do in an exact histogram and is kept only as the
//   validated option it is.
//
// * **`timerify` has no constructor path.** Node's wrapper branches on
//   `new.target` and calls `ReflectConstruct` for `new timerified(...)`. This
//   engine has no function-constructor model (zun#25): `new f()` over a plain
//   function throws "value is not a constructor" before any wrapper can see
//   it, and `fn.name` / `fn.length` read back `""` / `0` through a parameter
//   (zun#17/#19), so the wrapper cannot carry Node's `timerified <name>` name
//   either. The call path, the histogram recording and the promise path are
//   all here; the three assertions that need the other half are the blocker
//   named in ../../test/perf_hooks/README.md.
//
// * **`monitorEventLoopDelay` samples with a timer.** Node's ELD histogram is
//   a libuv check/prepare pair inside the loop. The VM owns the loop and
//   exposes its macrotask tier through `src/timers/timers.ts`, so the sampler
//   here is a repeating timer that records how late it was relative to its own
//   interval, in nanoseconds — the same quantity, read from the only side of
//   the loop this library stands on. The timer is `unref`'d, so enabling a
//   monitor does not keep a program alive, which is Node's behavior too.
//
// Engine notes (https://github.com/UrubuCode/zun/issues):
//   * `Object.defineProperty(C.prototype, Symbol.toStringTag, { writable:
//     false, ... })` stores `writable: true`. The same descriptor with a
//     *string* key on the same prototype, and with a symbol key on a plain
//     object, both round-trip — it is the symbol-keyed case that loses the
//     flag. The tag itself works, so `Symbol.toStringTag` is defined below as
//     Node defines it; the two corpus files that `deepStrictEqual` the whole
//     descriptor are blocked on that one field (see the README table).
//   * `structuredClone` is an engine global, but it rejects a RegExp
//     ("unsupported object kind") where Node's clones it. `mark`'s and
//     `measure`'s `detail` is therefore cloned by `__perfClone` below, which
//     is a plain structured-clone walk over the data kinds Node's algorithm
//     accepts.
//   * `Promise` has no readable fields at the type level ("type Promise has no
//     fields") and no `finally`, so the promise path of `timerify` detects a
//     thenable through an `any` alias and chains with `then`.
//   * `arguments.length` counts *declared* parameters, not supplied ones, so
//     every method that owes `ERR_MISSING_ARGS` for a missing argument takes a
//     rest parameter and counts it (a rest parameter's length is exact).
//   * `Number(x.length)` throughout: `.length` is typed `u64` at the type
//     level (zun#3).
//   * the errors are the declared `NodeTypeError`/`NodeRangeError` subclasses
//     from `src/events/events.ts`, never a plain error with `code` attached
//     through an `any` alias (zun#37).

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// `ERR_ILLEGAL_CONSTRUCTOR` is already declared in `src/stream/stream.ts`, and
// that file is inlined whenever a test requires `stream`. Two top-level
// declarations of one name are a compile error in a single Zun program and this
// file is inlined far more often, so the class is named for this module and
// only its `code` and message — the two things a test can observe — are Node's.
class __PerfIllegalConstructor extends NodeTypeError {
  constructor() {
    super("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
  }
}

class __PerfInvalidThis extends NodeTypeError {
  constructor(what: string) {
    super("ERR_INVALID_THIS", 'Value of "this" must be of type ' + what);
  }
}

class __PerfInvalidTimestamp extends NodeTypeError {
  constructor(value: any) {
    super(
      "ERR_PERFORMANCE_INVALID_TIMESTAMP",
      String(value) + " is not a valid timestamp",
    );
  }
}

class __PerfMeasureInvalidOptions extends NodeTypeError {
  constructor(reason: string) {
    super("ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS", reason);
  }
}

// Node raises a `DOMException` — not a Node error — for a measure over a mark
// that was never set (`SyntaxError`) and for an observer asked to change
// between single and multiple observation (`InvalidModificationError`).
// `DOMException` is not an engine global, so the two things a caller can
// observe are declared here: the `name`, and the legacy numeric `code` a
// DOMException carries (12 `SYNTAX_ERR`, 13 `INVALID_MODIFICATION_ERR`).
// `name` is a virtual getter on `Error` in this engine, so a subclass
// overriding it is the supported spelling, and the value has to come from a
// declared field (the same move `src/buffer/buffer.ts` makes for `atob`).
const __PERF_SYNTAX_ERR: number = 12;
const __PERF_INVALID_MODIFICATION_ERR: number = 13;

class __PerfDOMException extends Error {
  domName: string = "Error";
  code: number = 0;
  constructor(message: string, domName: string, legacyCode: number) {
    super(message);
    this.domName = domName;
    this.code = legacyCode;
  }
  get name(): string {
    return this.domName;
  }
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

// `src/process/process.ts`' `__processHrtimeDigits()` answers a decimal
// nanosecond count as text, from the extension's monotonic clock when one is
// loaded and from `Date.now()` otherwise. A `Number` round trip is exact below
// 2^53 nanoseconds, which is 104 days of uptime.
function __perfNanos(): number {
  return Number(__processHrtimeDigits());
}

const __perfEpoch: any = {
  nanos: __perfNanos(),
  origin: Number(Date.now()),
};

// `performance.now()`: milliseconds since `timeOrigin`.
function __perfNow(): number {
  return (__perfNanos() - Number(__perfEpoch.nanos)) / 1000000;
}

// ---------------------------------------------------------------------------
// `structuredClone` for a `detail`
// ---------------------------------------------------------------------------

// The data kinds Node's structured-clone algorithm accepts, walked by hand
// because the engine's `structuredClone` rejects a RegExp. A function, a
// promise and a class instance are not data in Node either; they are passed
// through rather than raised on, which is the one place this is laxer than
// Node (nothing in the corpus clones one).
function __perfClone(value: any): any {
  if (value === null || value === undefined) return value;
  const kind = typeof value;
  if (kind !== "object") return value;
  if (Array.isArray(value)) {
    const out: any[] = [];
    for (const item of value) out.push(__perfClone(item));
    return out;
  }
  if (value instanceof RegExp) {
    return new RegExp(String(value.source), String(value.flags));
  }
  if (value instanceof Date) {
    return new Date(Number(value.getTime()));
  }
  if (value instanceof Map) {
    const copy: any = new Map();
    for (const pair of value) copy.set(__perfClone(pair[0]), __perfClone(pair[1]));
    return copy;
  }
  if (value instanceof Set) {
    const copy: any = new Set();
    for (const item of value) copy.add(__perfClone(item));
    return copy;
  }
  const plain: any = {};
  for (const key of Object.keys(value)) plain[key] = __perfClone(value[key]);
  return plain;
}

// ---------------------------------------------------------------------------
// How an entry, an observer and a histogram inspect
// ---------------------------------------------------------------------------

// Node gives each of them a `[util.inspect.custom]` method on the prototype
// that renders `<ClassName> <inspect(summary)>`. Neither half of that spelling
// is available here:
//
//   * a prototype-level hook is invoked as a bare call with no receiver
//     (zun#1), so it has no instance to summarise;
//   * the hook installed **per instance**, as a closure over that instance,
//     works on a *dynamic object* but is dropped on a **class instance** — a
//     symbol-keyed function property lives in a side store that a class
//     instance does not carry (zun#32), and `util.inspect` then formats the
//     object raw. Measured: `o[kInspect] = fn` on `{}` is honoured,
//     `e[kInspect] = fn` on `new E()` is not, inside or outside an array.
//   * `Object.defineProperty(entry, kInspect, { value: fn })` defines a
//     property that enumerates and reads `undefined` (zun#48).
//
// So the entries below do not install a hook. They are shaped so that the raw
// formatting the engine falls back to *is* Node's output: each class's own
// fields are Node's own reading names, declared in the order Node's
// `[kInspect]` prints them, and the engine prints a class instance as
// `<ClassName> { <fields in declaration order> }`. Three consequences, all
// deliberate:
//
//   * a reading Node computes in a getter (`PerformanceResourceTiming`'s
//     `duration` and `transferSize`) is computed once, when the entry is
//     created, instead of on every read. Resource timing info is final by the
//     time `markResourceTiming` sees it — Node's own comment says the class
//     "is using timingInfo assuming it's already validated" — so nothing can
//     observe the difference.
//   * the fields are writable where Node's are read-only accessors. The
//     engine cannot express a read-only property anyway (see
//     `__perfDefineTag`).
//   * `cacheMode` and the raw `timingInfo` are **not** stored on a resource
//     entry: `cacheMode` must not be readable (the corpus asserts it is
//     `undefined`), and storing either would add a key to the inspect output
//     that Node's does not have.

// `Symbol.toStringTag`, defined on the prototype exactly as Node defines it.
// `writable: false` does not survive on a symbol-keyed prototype property in
// this engine (see the header), so the stored descriptor reports `true`; the
// tag itself reads back correctly.
function __perfDefineTag(ctorPrototype: any, tag: string): void {
  Object.defineProperty(ctorPrototype, Symbol.toStringTag, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: tag,
  });
}

// ---------------------------------------------------------------------------
// PerformanceEntry and its subclasses
// ---------------------------------------------------------------------------

// Node guards every entry constructor with a private symbol so that
// `new PerformanceEntry()` from user code raises `ERR_ILLEGAL_CONSTRUCTOR`.
const __PERF_TOKEN: any = Symbol("kSkipThrow");

class PerformanceEntry {
  name: any = undefined;
  entryType: any = undefined;
  startTime: any = undefined;
  duration: any = undefined;

  constructor(token?: any, name?: any, type?: any, start?: any, duration?: any) {
    if (token !== __PERF_TOKEN) throw new __PerfIllegalConstructor();
    this.name = name;
    this.entryType = type;
    this.startTime = start;
    this.duration = duration;
  }

  toJSON(): any {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
    };
  }
}
__perfDefineTag(PerformanceEntry.prototype, "PerformanceEntry");

// Node's `PerformanceNodeEntry`: an entry that also carries a `detail`. It is
// the shape `gc`, `function`, `http`, `dns` and `net` entries have.
class PerformanceNodeEntry extends PerformanceEntry {
  detail: any = null;

  toJSON(): any {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail,
    };
  }
}

class PerformanceMark extends PerformanceEntry {
  detail: any = null;

  constructor(name?: any, options?: any) {
    super(
      __PERF_TOKEN,
      __perfMarkName(name),
      "mark",
      __perfMarkStart(__perfMarkName(name), options),
      0,
    );
    this.detail = __perfDetailOf(options);
  }

  toJSON(): any {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail,
    };
  }
}
__perfDefineTag(PerformanceMark.prototype, "PerformanceMark");

class PerformanceMeasure extends PerformanceEntry {
  detail: any = null;

  constructor(token?: any, name?: any, type?: any, start?: any, duration?: any) {
    super(token, name, type, start, duration);
  }

  toJSON(): any {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail,
    };
  }
}
__perfDefineTag(PerformanceMeasure.prototype, "PerformanceMeasure");

// `PerformanceMark`'s constructor runs before the instance exists, so the two
// pieces of its work that can throw are top-level functions it calls from the
// `super(...)` argument list. `name` is converted first (a Symbol raises there,
// which is what the corpus asserts), then the read-only `nodeTiming` names are
// rejected, then `startTime` is validated.
function __perfMarkName(name: any): string {
  const text: string = `${name}`;
  if (__perfIsMilestoneName(text)) {
    throw new ERR_INVALID_ARG_VALUE("name", text, "is invalid");
  }
  return text;
}

function __perfMarkStart(name: string, options: any): number {
  if (options !== undefined && options !== null) {
    __evValidateObject(options, "options");
  }
  let start: any = undefined;
  if (options !== undefined && options !== null) start = options.startTime;
  if (start === undefined || start === null) start = __perfNow();
  if (typeof start !== "number") {
    throw new ERR_INVALID_ARG_TYPE("startTime", "number", start);
  }
  if (Number.isNaN(start)) {
    throw new ERR_OUT_OF_RANGE("startTime", "a number", start);
  }
  if (start < 0) throw new __PerfInvalidTimestamp(start);
  __perfMarkTimings.set(name, start);
  return start;
}

// Node spells this `options?.detail`, which answers `undefined` for the string
// `measure('x', 'markName')` passes. An undeclared property read off a
// *string* held in an `any` panics the interpreter here ("expected object,
// found Str"), so the non-object cases are taken first.
function __perfDetailOf(options: any): any {
  if (options === undefined || options === null) return null;
  if (typeof options !== "object" || Array.isArray(options)) return null;
  const detail: any = options.detail;
  if (detail === undefined || detail === null) return null;
  return __perfClone(detail);
}

// ---------------------------------------------------------------------------
// PerformanceResourceTiming
// ---------------------------------------------------------------------------

// Every reading is a projection of the `timingInfo` record `fetch` hands to
// `markResourceTiming`, read once when the entry is created (see the note
// above the entry classes). The nineteen fields are declared in the order
// Node's `[kInspect]` prints them, after the four the base declares.
class PerformanceResourceTiming extends PerformanceEntry {
  initiatorType: any = undefined;
  nextHopProtocol: any = undefined;
  workerStart: any = undefined;
  redirectStart: any = undefined;
  redirectEnd: any = undefined;
  fetchStart: any = undefined;
  domainLookupStart: any = undefined;
  domainLookupEnd: any = undefined;
  connectStart: any = undefined;
  connectEnd: any = undefined;
  secureConnectionStart: any = undefined;
  requestStart: any = undefined;
  responseStart: any = undefined;
  responseEnd: any = undefined;
  transferSize: any = undefined;
  encodedBodySize: any = undefined;
  decodedBodySize: any = undefined;
  deliveryType: any = undefined;
  responseStatus: any = undefined;

  constructor(token?: any, name?: any, type?: any) {
    super(token, name, type, undefined, undefined);
  }

  toJSON(): any {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      initiatorType: this.initiatorType,
      nextHopProtocol: this.nextHopProtocol,
      workerStart: this.workerStart,
      redirectStart: this.redirectStart,
      redirectEnd: this.redirectEnd,
      fetchStart: this.fetchStart,
      domainLookupStart: this.domainLookupStart,
      domainLookupEnd: this.domainLookupEnd,
      connectStart: this.connectStart,
      connectEnd: this.connectEnd,
      secureConnectionStart: this.secureConnectionStart,
      requestStart: this.requestStart,
      responseStart: this.responseStart,
      responseEnd: this.responseEnd,
      transferSize: this.transferSize,
      encodedBodySize: this.encodedBodySize,
      decodedBodySize: this.decodedBodySize,
      deliveryType: this.deliveryType,
      responseStatus: this.responseStatus,
    };
  }
}
__perfDefineTag(PerformanceResourceTiming.prototype, "PerformanceResourceTiming");

// Node spells the five connection readings with optional chaining on
// `finalConnectionTimingInfo`, so a `timingInfo` without one answers
// `undefined` rather than throwing.
function __perfConnection(timing: any, key: string): any {
  const info: any = timing.finalConnectionTimingInfo;
  if (info === undefined || info === null) return undefined;
  return info[key];
}

// ---------------------------------------------------------------------------
// The three global entry buffers
// ---------------------------------------------------------------------------

// Node keeps `mark`, `measure` and `resource` in separate arrays, and
// `getEntries()` is their concatenation re-sorted by `startTime` — which is
// why a measure recorded after a mark can still come first.
const __perfBuffers: any = {
  mark: [],
  measure: [],
  resource: [],
  resourceSecondary: [],
  resourceLimit: 250,
  resourceFullPending: false,
};

// The mark name → startTime table `measure` resolves a named mark through.
const __perfMarkTimings: any = new Map();

const __PERF_SUPPORTED_ENTRY_TYPES: string[] = [
  "dns",
  "function",
  "gc",
  "http",
  "http2",
  "mark",
  "measure",
  "net",
  "resource",
];

const __PERF_MILESTONE_NAMES: string[] = [
  "nodeStart",
  "v8Start",
  "environment",
  "loopStart",
  "loopExit",
  "bootstrapComplete",
];

function __perfIsMilestoneName(name: string): boolean {
  for (const known of __PERF_MILESTONE_NAMES) {
    if (known === name) return true;
  }
  return false;
}

// One warning per entry type, once the buffer passes a million entries — Node
// calls it a "Possible perf_hooks memory leak".
const __PERF_BUFFER_WARN_SIZE: number = 1000000;
const __perfWarnedTypes: any = new Map();

function __perfBufferUserTiming(entry: any): void {
  const type: any = entry.entryType;
  if (type !== "mark" && type !== "measure") return;
  const buffer: any[] = __perfBuffers[type];
  buffer.push(entry);
  const count: number = Number(buffer.length);
  if (count > __PERF_BUFFER_WARN_SIZE && __perfWarnedTypes.get(type) === undefined) {
    __perfWarnedTypes.set(type, true);
    const clearer: string =
      type === "mark" ? "performance.clearMarks" : "performance.clearMeasures";
    const warning: any = new Error(
      "Possible perf_hooks memory leak detected. " + String(count) + " " +
        String(type) + " entries added to the global performance entry buffer. " +
        "Use " + clearer + " to clear the buffer.",
    );
    __processEmitWarning(warning, "MaxPerformanceEntryBufferExceededWarning");
  }
}

// `https://www.w3.org/TR/resource-timing-2/#dfn-add-a-performanceresourcetiming-entry`.
// Once the primary buffer is full, entries land in a secondary buffer and a
// single `resourcetimingbufferfull` event is scheduled; the handler may clear
// the buffer or change its limit, and whatever room that leaves is filled from
// the secondary buffer, in order, with the excess dropped.
function __perfBufferResourceTiming(entry: any): void {
  const primary: any[] = __perfBuffers.resource;
  if (
    Number(primary.length) < Number(__perfBuffers.resourceLimit) &&
    !__perfBuffers.resourceFullPending
  ) {
    primary.push(entry);
    return;
  }
  if (!__perfBuffers.resourceFullPending) {
    __perfBuffers.resourceFullPending = true;
    setImmediate(__perfDrainResourceBuffer);
  }
  __perfBuffers.resourceSecondary.push(entry);
}

function __perfDrainResourceBuffer(): void {
  while (Number(__perfBuffers.resourceSecondary.length) > 0) {
    const before: number = Number(__perfBuffers.resourceSecondary.length);
    __perfDispatchBufferFull("resourcetimingbufferfull");

    const room: number =
      Number(__perfBuffers.resourceLimit) - Number(__perfBuffers.resource.length);
    const secondary: any[] = __perfBuffers.resourceSecondary;
    let keep: number = room < Number(secondary.length) ? room : Number(secondary.length);
    if (keep < 0) keep = 0;
    const after: number = Number(secondary.length) - keep;
    let idx = 0;
    while (idx < keep) {
      __perfBuffers.resource.push(secondary[idx]);
      idx = idx + 1;
    }
    if (before <= after) __perfBuffers.resourceSecondary = [];
  }
  __perfBuffers.resourceFullPending = false;
}

function __perfClearEntriesFromBuffer(type: string, name: any): void {
  if (type !== "mark" && type !== "measure" && type !== "resource") return;
  if (name === undefined) {
    __perfBuffers[type] = [];
    return;
  }
  const kept: any[] = [];
  for (const entry of __perfBuffers[type]) {
    if (entry.name !== name) kept.push(entry);
  }
  __perfBuffers[type] = kept;
}

function __perfSorter(first: any, second: any): number {
  return Number(first.startTime) - Number(second.startTime);
}

// Node's `filterBufferMapByNameAndType`. An unrecognised `type` answers an
// empty list; no `type` at all concatenates all three buffers.
function __perfFilterBuffers(name: any, type: any): any[] {
  let list: any[] = [];
  if (type === "mark" || type === "measure" || type === "resource") {
    for (const entry of __perfBuffers[type]) list.push(entry);
  } else if (type !== undefined) {
    return [];
  } else {
    for (const entry of __perfBuffers.mark) list.push(entry);
    for (const entry of __perfBuffers.measure) list.push(entry);
    for (const entry of __perfBuffers.resource) list.push(entry);
  }
  if (name !== undefined) {
    const kept: any[] = [];
    for (const entry of list) {
      if (entry.name === name) kept.push(entry);
    }
    list = kept;
  }
  return list.sort(__perfSorter);
}

// ---------------------------------------------------------------------------
// PerformanceObserver
// ---------------------------------------------------------------------------

const __perfObservers: any = {
  connected: [],
  pending: [],
  flushScheduled: false,
};

function __perfQueuePending(): void {
  if (__perfObservers.flushScheduled) return;
  __perfObservers.flushScheduled = true;
  setImmediate(__perfFlushPending);
}

function __perfFlushPending(): void {
  __perfObservers.flushScheduled = false;
  const pendings: any[] = __perfObservers.pending;
  __perfObservers.pending = [];
  for (const observer of pendings) __perfObserverDispatch(observer);
}

function __perfListRemove(list: any[], value: any): any[] {
  const kept: any[] = [];
  for (const item of list) {
    if (item !== value) kept.push(item);
  }
  return kept;
}

function __perfListHas(list: any[], value: any): boolean {
  for (const item of list) {
    if (item === value) return true;
  }
  return false;
}

class PerformanceObserverEntryList {
  __oEntries: any[] = [];

  constructor(token?: any, entries?: any) {
    if (token !== __PERF_TOKEN) throw new __PerfIllegalConstructor();
    const list: any[] = entries === undefined || entries === null ? [] : entries;
    this.__oEntries = list.sort(__perfSorter);
  }

  getEntries(): any[] {
    return this.__oEntries.slice(0);
  }

  getEntriesByType(...args: any[]): any[] {
    if (Number(args.length) === 0) throw new ERR_MISSING_ARGS("type");
    const type: string = `${args[0]}`;
    const kept: any[] = [];
    for (const entry of this.__oEntries) {
      if (entry.entryType === type) kept.push(entry);
    }
    return kept;
  }

  getEntriesByName(...args: any[]): any[] {
    if (Number(args.length) === 0) throw new ERR_MISSING_ARGS("name");
    const name: string = `${args[0]}`;
    const type: any = Number(args.length) > 1 ? args[1] : undefined;
    const kept: any[] = [];
    for (const entry of this.__oEntries) {
      if (entry.name !== name) continue;
      if (type !== undefined && type !== null && entry.entryType !== type) continue;
      kept.push(entry);
    }
    return kept;
  }
}
__perfDefineTag(PerformanceObserverEntryList.prototype, "PerformanceObserverEntryList");

// The observer's callback, its entry types and its buffer live in a side record
// rather than in private fields, because the record is also what `enqueue`
// walks and what `disconnect` has to find; `__perfObserverStateOf` is the one
// reader. The observer object itself carries the key.
const __perfObserverStates: any = new Map();

class PerformanceObserver {
  __obsId: any = undefined;

  constructor(callback?: any) {
    if (!__evIsFn(callback)) {
      throw new ERR_INVALID_ARG_TYPE("callback", "Function", callback);
    }
    this.__obsId = Symbol("PerformanceObserver");
    __perfObserverStates.set(this.__obsId, {
      // A callable stored in a record loses its identity and its properties as
      // a bare value (zun#17), so it goes through `__evBox` exactly as every
      // stored listener in `src/events/events.ts` does.
      callback: __evBox(callback),
      entryTypes: [],
      buffer: [],
      kind: undefined,
      self: this,
    });
  }

  observe(...args: any[]): any {
    return __perfObserverObserve(this.__obsId, Number(args.length) === 0 ? {} : args[0]);
  }

  disconnect(): any {
    return __perfObserverDisconnect(this.__obsId);
  }

  takeRecords(): any[] {
    const state: any = __perfObserverStates.get(this.__obsId);
    if (state === undefined) return [];
    const list: any[] = state.buffer;
    state.buffer = [];
    return list;
  }

  static get supportedEntryTypes(): string[] {
    return __PERF_SUPPORTED_ENTRY_TYPES.slice(0);
  }
}
__perfDefineTag(PerformanceObserver.prototype, "PerformanceObserver");

const __PERF_TYPE_SINGLE: number = 0;
const __PERF_TYPE_MULTIPLE: number = 1;

function __perfObserverObserve(id: any, options: any): void {
  const state: any = __perfObserverStates.get(id);
  if (state === undefined) throw new __PerfInvalidThis("PerformanceObserver");
  __evValidateObject(options, "options");
  const entryTypes: any = options.entryTypes;
  const type: any = options.type;
  const buffered: any = options.buffered;
  if (entryTypes === undefined && type === undefined) {
    throw new ERR_MISSING_ARGS("options.entryTypes", "options.type");
  }
  if (
    entryTypes !== undefined && entryTypes !== null &&
    type !== undefined && type !== null
  ) {
    throw new ERR_INVALID_ARG_VALUE(
      "options.entryTypes",
      entryTypes,
      "options.entryTypes can not set with options.type together",
    );
  }

  if (state.kind === undefined) {
    if (entryTypes !== undefined) state.kind = __PERF_TYPE_MULTIPLE;
    if (type !== undefined) state.kind = __PERF_TYPE_SINGLE;
  } else if (state.kind === __PERF_TYPE_SINGLE) {
    if (entryTypes !== undefined) {
      throw new __PerfDOMException(
        "PerformanceObserver can not change to multiple observations",
        "InvalidModificationError",
        __PERF_INVALID_MODIFICATION_ERR,
      );
    }
  } else if (state.kind === __PERF_TYPE_MULTIPLE) {
    if (type !== undefined) {
      throw new __PerfDOMException(
        "PerformanceObserver can not change to single observation",
        "InvalidModificationError",
        __PERF_INVALID_MODIFICATION_ERR,
      );
    }
  }

  if (state.kind === __PERF_TYPE_MULTIPLE) {
    if (!Array.isArray(entryTypes)) {
      throw new ERR_INVALID_ARG_TYPE("options.entryTypes", "string[]", entryTypes);
    }
    const unique: any[] = [];
    for (const wanted of entryTypes) {
      if (!__PERF_SUPPORTED_ENTRY_TYPES.includes(wanted)) continue;
      if (!__perfListHas(unique, wanted)) unique.push(wanted);
    }
    state.entryTypes = unique;
  } else {
    if (!__PERF_SUPPORTED_ENTRY_TYPES.includes(type)) return;
    if (!__perfListHas(state.entryTypes, type)) state.entryTypes.push(type);
    if (buffered) {
      for (const entry of __perfFilterBuffers(undefined, type)) state.buffer.push(entry);
      if (!__perfListHas(__perfObservers.pending, state.self)) {
        __perfObservers.pending.push(state.self);
      }
      __perfQueuePending();
    }
  }

  if (Number(state.entryTypes.length) > 0) {
    if (!__perfListHas(__perfObservers.connected, state.self)) {
      __perfObservers.connected.push(state.self);
    }
  } else {
    __perfObserverDisconnect(id);
  }
}

function __perfObserverDisconnect(id: any): void {
  const state: any = __perfObserverStates.get(id);
  if (state === undefined) return;
  __perfObservers.connected = __perfListRemove(__perfObservers.connected, state.self);
  __perfObservers.pending = __perfListRemove(__perfObservers.pending, state.self);
  state.buffer = [];
  state.entryTypes = [];
  state.kind = undefined;
}

function __perfObserverDispatch(observer: any): void {
  const state: any = __perfObserverStates.get(observer.__obsId);
  if (state === undefined) return;
  const taken: any[] = state.buffer;
  state.buffer = [];
  const list: any = new PerformanceObserverEntryList(__PERF_TOKEN, taken);
  __evCall(state.callback, [list, observer]);
}

// `https://www.w3.org/TR/performance-timeline/#dfn-queue-a-performanceentry`.
function __perfEnqueue(entry: any): void {
  if (!(entry instanceof PerformanceEntry)) {
    throw new ERR_INVALID_ARG_TYPE("entry", "PerformanceEntry", entry);
  }
  const type: any = entry.entryType;
  for (const observer of __perfObservers.connected.slice(0)) {
    const state: any = __perfObserverStates.get(observer.__obsId);
    if (state === undefined) continue;
    if (!__perfListHas(state.entryTypes, type)) continue;
    state.buffer.push(entry);
    if (!__perfListHas(__perfObservers.pending, observer)) {
      __perfObservers.pending.push(observer);
    }
    __perfQueuePending();
  }
}

// ---------------------------------------------------------------------------
// nodeTiming
// ---------------------------------------------------------------------------

// Node's `PerformanceNodeTiming` reports six process milestones the VM does not
// publish. Four of them are reported as the earliest instant this library can
// observe — 0, the clock's own origin — and `bootstrapComplete` as the instant
// this module finished loading, which is the last thing that happens before a
// bundle's own code runs. `loopStart` and `loopExit` stay -1, which is Node's
// value on the main thread until the loop starts and after it exits; nothing in
// the VM's macrotask tier reports either edge to this library, and -1 is also
// what makes `eventLoopUtilization()` answer the all-zero reading Node answers
// before the loop has started.
const __perfMilestones: any = {
  nodeStart: 0,
  v8Start: 0,
  environment: 0,
  bootstrapComplete: 0,
  loopStart: -1,
  loopExit: -1,
};

class PerformanceNodeTiming {
  get name(): string {
    return "node";
  }

  get entryType(): string {
    return "node";
  }

  get startTime(): number {
    return 0;
  }

  get duration(): number {
    return __perfNow();
  }

  get nodeStart(): number {
    return Number(__perfMilestones.nodeStart);
  }

  get v8Start(): number {
    return Number(__perfMilestones.v8Start);
  }

  get environment(): number {
    return Number(__perfMilestones.environment);
  }

  get bootstrapComplete(): number {
    return Number(__perfMilestones.bootstrapComplete);
  }

  get loopStart(): number {
    return Number(__perfMilestones.loopStart);
  }

  get loopExit(): number {
    return Number(__perfMilestones.loopExit);
  }

  get idleTime(): number {
    return 0;
  }

  get uvMetricsInfo(): any {
    return { loopCount: 0, events: 0, eventsWaiting: 0 };
  }

  toJSON(): any {
    return {
      name: "node",
      entryType: "node",
      startTime: 0,
      duration: this.duration,
      nodeStart: this.nodeStart,
      v8Start: this.v8Start,
      bootstrapComplete: this.bootstrapComplete,
      environment: this.environment,
      loopStart: this.loopStart,
      loopExit: this.loopExit,
      idleTime: this.idleTime,
    };
  }
}

const __perfNodeTiming: any = new PerformanceNodeTiming();

// Node's `internalEventLoopUtilization`, with `loopStart <= 0` meaning "the
// loop has not started", which is this library's permanent state (see above).
function __perfEventLoopUtilization(util1?: any, util2?: any): any {
  const loopStart: number = Number(__perfMilestones.loopStart);
  if (loopStart <= 0) return { idle: 0, active: 0, utilization: 0 };
  const idleTime: number = 0;
  if (util2 !== undefined && util2 !== null) {
    const idle: number = Number(util1.idle) - Number(util2.idle);
    const active: number = Number(util1.active) - Number(util2.active);
    return { idle, active, utilization: active / (idle + active) };
  }
  const active: number = __perfNow() - loopStart - idleTime;
  if (util1 === undefined || util1 === null) {
    return { idle: idleTime, active, utilization: active / (idleTime + active) };
  }
  const idleDelta: number = idleTime - Number(util1.idle);
  const activeDelta: number = active - Number(util1.active);
  return {
    idle: idleDelta,
    active: activeDelta,
    utilization: activeDelta / (idleDelta + activeDelta),
  };
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------

// `INT64_MAX`, which is what an empty histogram answers for `min`. As a double
// it rounds to 9223372036854776000, and the corpus asserts exactly that number
// for `min` and exactly `9223372036854775807n` for `minBigInt`, so the two are
// kept as separate constants rather than one converted into the other.
const __PERF_INT64_MAX: number = 9223372036854776000;
const __PERF_INT64_MAX_TEXT: string = "9223372036854775807";
const __PERF_MAX_SAFE: number = 9007199254740991;

// A histogram is a value→count map plus the sums the readings need. See the
// header for why it is exact rather than HdrHistogram-shaped.
function __perfHistogramNew(lowest: number, highest: number, figures: number): any {
  return {
    lowest,
    highest,
    figures,
    counts: new Map(),
    total: 0,
    sum: 0,
    sumSquares: 0,
    min: 0,
    max: 0,
    exceeds: 0,
    last: 0,
  };
}

function __perfHistogramRecordValue(data: any, value: number): void {
  if (value > Number(data.highest)) {
    data.exceeds = Number(data.exceeds) + 1;
    return;
  }
  const previous: any = data.counts.get(value);
  data.counts.set(value, previous === undefined ? 1 : Number(previous) + 1);
  if (Number(data.total) === 0 || value < Number(data.min)) data.min = value;
  if (value > Number(data.max)) data.max = value;
  data.total = Number(data.total) + 1;
  data.sum = Number(data.sum) + value;
  data.sumSquares = Number(data.sumSquares) + value * value;
}

function __perfHistogramReset(data: any): void {
  data.counts = new Map();
  data.total = 0;
  data.sum = 0;
  data.sumSquares = 0;
  data.min = 0;
  data.max = 0;
  data.exceeds = 0;
}

function __perfHistogramMin(data: any): number {
  return Number(data.total) === 0 ? __PERF_INT64_MAX : Number(data.min);
}

function __perfHistogramMean(data: any): number {
  if (Number(data.total) === 0) return NaN;
  return Number(data.sum) / Number(data.total);
}

function __perfHistogramStddev(data: any): number {
  const n: number = Number(data.total);
  if (n === 0) return NaN;
  const mean: number = Number(data.sum) / n;
  const variance: number = Number(data.sumSquares) / n - mean * mean;
  return variance <= 0 ? 0 : Math.sqrt(variance);
}

// The distinct recorded values, ascending — the iteration order every
// percentile reading walks.
function __perfHistogramValues(data: any): number[] {
  const values: number[] = [];
  for (const pair of data.counts) values.push(Number(pair[0]));
  return values.sort(function (a: any, b: any): number {
    return Number(a) - Number(b);
  });
}

function __perfHistogramPercentile(data: any, percentile: number): number {
  if (Number(data.total) === 0) return 0;
  const wanted: number = (percentile / 100) * Number(data.total);
  let seen = 0;
  for (const value of __perfHistogramValues(data)) {
    seen = seen + Number(data.counts.get(value));
    if (seen >= wanted) return value;
  }
  return Number(data.max);
}

// HdrHistogram's `percentiles` iteration, which is *not* one entry per
// distinct value: it walks halving percentile levels -- 0, 50, 75, 87.5, ... ,
// each `100 - (100 - level) / 2` -- reports the value at each level, and stops
// as soon as that value is the maximum, after which it reports 100. A
// histogram holding one value therefore answers `Map { 0 => v, 100 => v }`
// and one holding 1, 3 and 5 answers
// `Map { 0 => 1, 50 => 3, 75 => 5, 100 => 5 }`; both are differentially
// verified against Node.
function __perfHistogramPercentiles(data: any, asBigInt: boolean): any {
  const out: any = new Map();
  const max: number = Number(data.max);
  // An empty histogram has nothing to walk, and hdr reports only the closing
  // entry for it (`Map { 100 => 0 }`, verified against Node).
  if (Number(data.total) === 0) {
    out.set(100, asBigInt ? __perfBigInt(0) : 0);
    return out;
  }
  let level: number = 0;
  while (true) {
    const value: number = __perfHistogramPercentile(data, level);
    out.set(level, asBigInt ? __perfBigInt(value) : value);
    if (value >= max) break;
    level = 100 - (100 - level) / 2;
  }
  out.set(100, asBigInt ? __perfBigInt(max) : max);
  return out;
}

function __perfHistogramAdd(data: any, other: any): void {
  for (const pair of other.counts) {
    const value: number = Number(pair[0]);
    let left: number = Number(pair[1]);
    while (left > 0) {
      __perfHistogramRecordValue(data, value);
      left = left - 1;
    }
  }
  data.exceeds = Number(data.exceeds) + Number(other.exceeds);
}

// BigInt arithmetic is not available in this engine ("Cannot convert a BigInt
// value to a number" for `a - b`), so every `*BigInt` reading is computed as a
// number and converted once, through the decimal text — which is also how
// `src/process/process.ts` builds `process.hrtime.bigint()`.
function __perfBigInt(value: number): any {
  return BigInt(String(Math.round(value)));
}

// The `Histogram` surface. `RecordableHistogram` adds the three mutators;
// `IntervalHistogram` (what `monitorEventLoopDelay` answers) adds
// `enable`/`disable`. All three share one state record, so a histogram
// transferred between them reads the same.
class Histogram {
  __hData: any = undefined;

  constructor(token?: any, data?: any) {
    if (token !== __PERF_TOKEN) throw new __PerfIllegalConstructor();
    this.__hData = data;
  }

  get count(): number {
    return Number(this.__hData.total);
  }

  get countBigInt(): any {
    return __perfBigInt(Number(this.__hData.total));
  }

  get min(): number {
    return __perfHistogramMin(this.__hData);
  }

  get minBigInt(): any {
    return Number(this.__hData.total) === 0
      ? BigInt(String(__PERF_INT64_MAX_TEXT))
      : __perfBigInt(Number(this.__hData.min));
  }

  get max(): number {
    return Number(this.__hData.max);
  }

  get maxBigInt(): any {
    return __perfBigInt(Number(this.__hData.max));
  }

  get mean(): number {
    return __perfHistogramMean(this.__hData);
  }

  get exceeds(): number {
    return Number(this.__hData.exceeds);
  }

  get exceedsBigInt(): any {
    return __perfBigInt(Number(this.__hData.exceeds));
  }

  get stddev(): number {
    return __perfHistogramStddev(this.__hData);
  }

  get percentiles(): any {
    return __perfHistogramPercentiles(this.__hData, false);
  }

  get percentilesBigInt(): any {
    return __perfHistogramPercentiles(this.__hData, true);
  }

  percentile(percentile?: any): number {
    __perfValidatePercentile(percentile);
    return __perfHistogramPercentile(this.__hData, Number(percentile));
  }

  percentileBigInt(percentile?: any): any {
    __perfValidatePercentile(percentile);
    return __perfBigInt(__perfHistogramPercentile(this.__hData, Number(percentile)));
  }

  reset(): void {
    __perfHistogramReset(this.__hData);
  }

  toJSON(): any {
    const percentiles: any = {};
    for (const pair of __perfHistogramPercentiles(this.__hData, false)) {
      percentiles[String(pair[0])] = pair[1];
    }
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      percentiles,
    };
  }
}
__perfDefineTag(Histogram.prototype, "Histogram");

function __perfValidatePercentile(percentile: any): void {
  if (typeof percentile !== "number") {
    throw new ERR_INVALID_ARG_TYPE("percentile", "number", percentile);
  }
  if (Number.isNaN(percentile) || percentile <= 0 || percentile > 100) {
    throw new ERR_OUT_OF_RANGE("percentile", "> 0 && <= 100", percentile);
  }
}

class RecordableHistogram extends Histogram {
  constructor(token?: any, data?: any) {
    super(token, data);
  }

  record(value?: any): void {
    if (typeof value === "bigint") {
      __perfHistogramRecordValue(this.__hData, Number(String(value)));
      return;
    }
    __evValidateInteger(value, "val", 1);
    __perfHistogramRecordValue(this.__hData, Number(value));
  }

  // Node's `recordDelta` records the nanoseconds since the previous
  // `recordDelta` call, and records nothing on the first one.
  recordDelta(): void {
    const data: any = this.__hData;
    const nanos: number = __perfNanos();
    if (Number(data.last) !== 0) {
      const delta: number = nanos - Number(data.last);
      if (delta > 0) __perfHistogramRecordValue(data, delta);
    }
    data.last = nanos;
  }

  add(other?: any): void {
    const data: any = __perfDataOf(other);
    if (data === undefined) {
      throw new ERR_INVALID_ARG_TYPE("other", "RecordableHistogram", other);
    }
    __perfHistogramAdd(this.__hData, data);
  }
}
__perfDefineTag(RecordableHistogram.prototype, "RecordableHistogram");

// `isHistogram(object)`: Node tests for the internal handle. The state record
// is the handle here, and it is only reachable from a histogram built by this
// module.
function __perfDataOf(value: any): any {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return undefined;
  const data: any = value.__hData;
  if (data === null || data === undefined) return undefined;
  if (data.counts === undefined) return undefined;
  return data;
}

class IntervalHistogram extends Histogram {
  __hEnabled: boolean = false;
  __hResolution: number = 10;
  __hTimer: any = undefined;

  constructor(token?: any, data?: any, resolution?: any) {
    super(token, data);
    this.__hResolution = Number(resolution);
  }

  enable(): boolean {
    if (this.__hEnabled) return false;
    this.__hEnabled = true;
    const data: any = this.__hData;
    const resolution: number = Number(this.__hResolution);
    let expected: number = __perfNanos() + resolution * 1000000;
    const timer: any = setInterval(function (): void {
      const nanos: number = __perfNanos();
      // The delay is how late this tick is relative to where it was due. A
      // tick that is not late at all still records 1 ns, because Node's ELD
      // histogram never records a zero either (its resolution is the timer's).
      let delay: number = nanos - expected;
      if (delay < 1) delay = 1;
      expected = nanos + resolution * 1000000;
      __perfHistogramRecordValue(data, delay);
    }, resolution);
    this.__hTimer = timer;
    // An enabled monitor must not keep a program alive.
    if (timer !== undefined && timer !== null) timer.unref();
    return true;
  }

  disable(): boolean {
    if (!this.__hEnabled) return false;
    this.__hEnabled = false;
    if (this.__hTimer !== undefined && this.__hTimer !== null) {
      clearInterval(this.__hTimer);
      this.__hTimer = undefined;
    }
    return true;
  }
}
__perfDefineTag(IntervalHistogram.prototype, "IntervalHistogram");

function createHistogram(options?: any): any {
  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");
  let lowest: any = opts.lowest;
  let highest: any = opts.highest;
  let figures: any = opts.figures;
  if (lowest === undefined) lowest = 1;
  if (highest === undefined) highest = __PERF_MAX_SAFE;
  if (figures === undefined) figures = 3;
  if (typeof lowest !== "bigint") {
    __perfValidateIntegerRange(lowest, "options.lowest", 1, __PERF_MAX_SAFE);
  }
  if (typeof highest !== "bigint") {
    __perfValidateIntegerRange(
      highest,
      "options.highest",
      2 * Number(lowest),
      __PERF_MAX_SAFE,
    );
  } else if (Number(String(highest)) < 2 * Number(lowest)) {
    throw new ERR_INVALID_ARG_VALUE("options.highest", highest, "is invalid");
  }
  __perfValidateIntegerRange(figures, "options.figures", 1, 5);
  const data: any = __perfHistogramNew(
    Number(typeof lowest === "bigint" ? Number(String(lowest)) : lowest),
    Number(typeof highest === "bigint" ? Number(String(highest)) : highest),
    Number(figures),
  );
  return new RecordableHistogram(__PERF_TOKEN, data);
}

// `validateInteger(value, name, min, max)`: `src/events/events.ts`' version
// fixes `max` at MAX_SAFE_INTEGER, and `createHistogram` needs the four-argument
// form for `options.highest`'s `2 * lowest` floor.
function __perfValidateIntegerRange(value: any, name: string, min: number, max: number): void {
  if (typeof value !== "number") {
    throw new ERR_INVALID_ARG_TYPE(name, "number", value);
  }
  if (!Number.isInteger(value)) {
    throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  }
  if (value < min || value > max) {
    throw new ERR_OUT_OF_RANGE(
      name,
      ">= " + String(min) + " && <= " + String(max),
      value,
    );
  }
}

function monitorEventLoopDelay(options?: any): any {
  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");
  let resolution: any = opts.resolution;
  if (resolution === undefined) resolution = 10;
  __evValidateInteger(resolution, "options.resolution", 1);
  const data: any = __perfHistogramNew(1, __PERF_MAX_SAFE, 3);
  return new IntervalHistogram(__PERF_TOKEN, data, Number(resolution));
}

// ---------------------------------------------------------------------------
// User timing: mark and measure
// ---------------------------------------------------------------------------

function __perfMark(name: any, options?: any): any {
  const entry: any = new PerformanceMark(name, options);
  __perfEnqueue(entry);
  __perfBufferUserTiming(entry);
  return entry;
}

// `getMark(name)`: a number is a timestamp, a milestone name is read from
// `nodeTiming`, and anything else must be a mark that has been set.
function __perfGetMark(name: any): any {
  if (name === undefined) return undefined;
  if (typeof name === "number") {
    if (name < 0) throw new __PerfInvalidTimestamp(name);
    return name;
  }
  const text: string = `${name}`;
  if (__perfIsMilestoneName(text)) return __perfNodeTiming[text];
  const stamp: any = __perfMarkTimings.get(text);
  if (stamp === undefined) {
    throw new __PerfDOMException(
      'The "' + text + '" performance mark has not been set',
      "SyntaxError",
      __PERF_SYNTAX_ERR,
    );
  }
  return stamp;
}

// Node's `calculateStartDuration`, which is six cases over
// `(startOrMeasureOptions, endMark)`.
function __perfCalculateStartDuration(startOrOptions: any, endMark: any): any {
  const given: any =
    startOrOptions === undefined || startOrOptions === null ? 0 : startOrOptions;
  let start: any = undefined;
  let end: any = undefined;
  let duration: any = undefined;
  let optionsValid = false;
  if (given !== null && typeof given === "object") {
    start = given.start;
    end = given.end;
    duration = given.duration;
    optionsValid = start !== undefined || end !== undefined;
  }
  if (optionsValid) {
    if (endMark !== undefined) {
      throw new __PerfMeasureInvalidOptions("endMark must not be specified");
    }
    if (start === undefined && end === undefined) {
      throw new __PerfMeasureInvalidOptions(
        "One of options.start or options.end is required",
      );
    }
    if (start !== undefined && end !== undefined && duration !== undefined) {
      throw new __PerfMeasureInvalidOptions(
        "Must not have options.start, options.end, and options.duration specified",
      );
    }
  }

  if (endMark !== undefined) {
    end = __perfGetMark(endMark);
  } else if (optionsValid && end !== undefined) {
    end = __perfGetMark(end);
  } else if (optionsValid && start !== undefined && duration !== undefined) {
    end = Number(__perfGetMark(start)) + Number(__perfGetMark(duration));
  } else {
    end = __perfNow();
  }

  if (typeof given === "string") {
    start = __perfGetMark(given);
  } else if (optionsValid && start !== undefined) {
    start = __perfGetMark(start);
  } else if (optionsValid && duration !== undefined && end !== undefined) {
    start = Number(end) - Number(__perfGetMark(duration));
  } else {
    start = 0;
  }

  return { start: Number(start), duration: Number(end) - Number(start) };
}

function __perfMeasure(name: any, startOrOptions?: any, endMark?: any): any {
  if (typeof name !== "string") {
    throw new ERR_INVALID_ARG_TYPE("name", "string", name);
  }
  const span: any = __perfCalculateStartDuration(startOrOptions, endMark);
  const entry: any = new PerformanceMeasure(
    __PERF_TOKEN,
    name,
    "measure",
    span.start,
    span.duration,
  );
  entry.detail = __perfDetailOf(startOrOptions);
  __perfEnqueue(entry);
  __perfBufferUserTiming(entry);
  return entry;
}

function __perfClearMarkTimings(name: any): void {
  if (name !== undefined) {
    const text: string = `${name}`;
    if (__perfIsMilestoneName(text)) {
      throw new ERR_INVALID_ARG_VALUE("name", text, "is invalid");
    }
    __perfMarkTimings.delete(text);
    return;
  }
  __perfMarkTimings.clear();
}

// ---------------------------------------------------------------------------
// markResourceTiming
// ---------------------------------------------------------------------------

function __perfMarkResourceTiming(
  timingInfo?: any,
  requestedUrl?: any,
  initiatorType?: any,
  globalObject?: any,
  cacheMode?: any,
  bodyInfo?: any,
  responseStatus?: any,
  deliveryType?: any,
): any {
  // `https://w3c.github.io/resource-timing/#dfn-setup-the-resource-timing-entry`
  // admits only these two cache modes, and Node asserts it.
  if (cacheMode !== "" && cacheMode !== "local" && cacheMode !== undefined) {
    throw new ERR_INVALID_ARG_VALUE(
      "cacheMode",
      cacheMode,
      "must be an empty string or 'local'",
    );
  }
  const timing: any = timingInfo;
  const mode: any = cacheMode === undefined ? "" : cacheMode;
  const entry: any = new PerformanceResourceTiming(__PERF_TOKEN, requestedUrl, "resource");
  entry.startTime = timing.startTime;
  entry.duration = Number(timing.endTime) - Number(timing.startTime);
  entry.initiatorType = initiatorType;
  entry.nextHopProtocol = __perfConnection(timing, "ALPNNegotiatedProtocol");
  entry.workerStart = timing.finalServiceWorkerStartTime;
  entry.redirectStart = timing.redirectStartTime;
  entry.redirectEnd = timing.redirectEndTime;
  entry.fetchStart = timing.postRedirectStartTime;
  entry.domainLookupStart = __perfConnection(timing, "domainLookupStartTime");
  entry.domainLookupEnd = __perfConnection(timing, "domainLookupEndTime");
  entry.connectStart = __perfConnection(timing, "connectionStartTime");
  entry.connectEnd = __perfConnection(timing, "connectionEndTime");
  entry.secureConnectionStart = __perfConnection(timing, "secureConnectionStartTime");
  entry.requestStart = timing.finalNetworkRequestStartTime;
  entry.responseStart = timing.finalNetworkResponseStartTime;
  entry.responseEnd = timing.endTime;
  // `transferSize` is 0 for a local hit, 300 for a validated one, and the
  // encoded body plus a 300-byte header allowance otherwise.
  entry.transferSize =
    mode === "local" ? 0 : mode === "validated" ? 300 : Number(timing.encodedBodySize) + 300;
  entry.encodedBodySize = timing.encodedBodySize;
  entry.decodedBodySize = timing.decodedBodySize;
  entry.deliveryType = deliveryType === undefined ? "" : deliveryType;
  entry.responseStatus = responseStatus;
  __perfEnqueue(entry);
  __perfBufferResourceTiming(entry);
  return entry;
}

// ---------------------------------------------------------------------------
// timerify
// ---------------------------------------------------------------------------

function __perfProcessComplete(name: any, start: number, args: any[], data: any): void {
  const duration: number = __perfNow() - start;
  if (data !== undefined) {
    const nanos: number = Math.ceil(duration * 1000000);
    __perfHistogramRecordValue(data, nanos < 1 ? 1 : nanos);
  }
  const entry: any = new PerformanceNodeEntry(
    __PERF_TOKEN,
    name,
    "function",
    start,
    duration,
  );
  entry.detail = args;
  // Node copies the call's arguments onto the entry under numeric keys, so an
  // observer can read `entry[0]`.
  let idx = 0;
  const count: number = Number(args.length);
  while (idx < count) {
    entry[idx] = args[idx];
    idx = idx + 1;
  }
  __perfEnqueue(entry);
}

// A thenable, detected through an `any` alias: `Promise` has no readable
// fields at the type level in this engine, so the probe cannot be written
// against a `Promise`-typed value.
function __perfThenOf(value: any): any {
  if (value === null || value === undefined) return undefined;
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return undefined;
  const then: any = value.then;
  return __evIsFn(then) ? then : undefined;
}

function __perfTimerify(fn?: any, options?: any): any {
  if (!__evIsFn(fn)) {
    throw new ERR_INVALID_ARG_TYPE("fn", "Function", fn);
  }
  const opts: any = options === undefined ? {} : options;
  __evValidateObject(opts, "options");
  const histogram: any = opts.histogram;
  let data: any = undefined;
  if (histogram !== undefined) {
    data = __perfDataOf(histogram);
    if (data === undefined) {
      throw new ERR_INVALID_ARG_TYPE(
        "options.histogram",
        "RecordableHistogram",
        histogram,
      );
    }
  }
  const target: any = __evBox(fn);
  const name: any = fn.name;
  function timerified(...args: any[]): any {
    const start: number = __perfNow();
    const result: any = __evCall(target, args);
    const settled: any = __perfThenOf(result);
    if (settled !== undefined) {
      // Node uses `result.finally(...)`, which this engine's `Promise` does
      // not have; `then` with both handlers is the same timing point, and
      // re-raising keeps the rejection observable.
      const chained: any = result;
      return chained.then(
        function (value: any): any {
          __perfProcessComplete(name, start, args, data);
          return value;
        },
        function (reason: any): any {
          __perfProcessComplete(name, start, args, data);
          throw reason;
        },
      );
    }
    __perfProcessComplete(name, start, args, data);
    return result;
  }
  return timerified;
}

// ---------------------------------------------------------------------------
// The `performance` object
// ---------------------------------------------------------------------------

// `performance` is an `EventTarget` in Node, which `resourcetimingbufferfull`
// is dispatched on. A class cannot extend the engine's `EventTarget` here, so
// the target is contained and the three methods forward to it — the same
// relationship `Performance` has with `EventTarget` as far as anything
// observable goes.
const __perfEventTarget: any = new EventTarget();

function __perfDispatchBufferFull(type: string): void {
  __perfEventTarget.dispatchEvent(new Event(type));
}

// `webidl.convertToInt('maxSize', value, 32)` for an unsigned long: anything
// that is not a finite number becomes 0, and the value is wrapped into
// [0, 2^32).
function __perfToUint32(value: any): number {
  let number: any = value;
  if (typeof number === "boolean") number = number ? 1 : 0;
  if (typeof number !== "number") number = Number(number);
  if (typeof number !== "number" || Number.isNaN(number)) return 0;
  if (number === Infinity || number === -Infinity) return 0;
  const truncated: number = number < 0 ? Math.ceil(number) : Math.floor(number);
  if (truncated === 0) return 0;
  const wrapped: number = truncated % 4294967296;
  return wrapped < 0 ? wrapped + 4294967296 : wrapped;
}

class Performance {
  constructor(token?: any) {
    if (token !== __PERF_TOKEN) throw new __PerfIllegalConstructor();
  }

  clearMarks(name?: any): void {
    const text: any = name === undefined ? undefined : `${name}`;
    __perfClearMarkTimings(text);
    __perfClearEntriesFromBuffer("mark", text);
  }

  clearMeasures(name?: any): void {
    const text: any = name === undefined ? undefined : `${name}`;
    __perfClearEntriesFromBuffer("measure", text);
  }

  clearResourceTimings(name?: any): void {
    const text: any = name === undefined ? undefined : `${name}`;
    __perfClearEntriesFromBuffer("resource", text);
  }

  getEntries(): any[] {
    return __perfFilterBuffers(undefined, undefined);
  }

  getEntriesByName(...args: any[]): any[] {
    if (Number(args.length) === 0) throw new ERR_MISSING_ARGS("name");
    const name: string = `${args[0]}`;
    let type: any = Number(args.length) > 1 ? args[1] : undefined;
    if (type !== undefined) type = `${type}`;
    return __perfFilterBuffers(name, type);
  }

  getEntriesByType(...args: any[]): any[] {
    if (Number(args.length) === 0) throw new ERR_MISSING_ARGS("type");
    return __perfFilterBuffers(undefined, `${args[0]}`);
  }

  mark(...args: any[]): any {
    if (Number(args.length) === 0) throw new ERR_MISSING_ARGS("name");
    return __perfMark(args[0], Number(args.length) > 1 ? args[1] : undefined);
  }

  measure(...args: any[]): any {
    if (Number(args.length) === 0) throw new ERR_MISSING_ARGS("name");
    return __perfMeasure(
      args[0],
      Number(args.length) > 1 ? args[1] : undefined,
      Number(args.length) > 2 ? args[2] : undefined,
    );
  }

  now(): number {
    return __perfNow();
  }

  setResourceTimingBufferSize(...args: any[]): void {
    if (Number(args.length) === 0) throw new ERR_MISSING_ARGS("maxSize");
    __perfBuffers.resourceLimit = __perfToUint32(args[0]);
  }

  get timeOrigin(): number {
    return Number(__perfEpoch.origin);
  }

  get nodeTiming(): any {
    return __perfNodeTiming;
  }

  eventLoopUtilization(util1?: any, util2?: any): any {
    return __perfEventLoopUtilization(util1, util2);
  }

  // A rest parameter rather than Node's eight named ones: `fetch` calls this
  // with all eight, and the corpus also spreads an array into it. An
  // eight-argument call compiles only through a class-typed receiver (zun#10),
  // and a spread into a call compiles only into a method whose parameter *is*
  // the rest list — both measured, both exercised here.
  markResourceTiming(...args: any[]): any {
    return __perfMarkResourceTiming(
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
      args[5],
      args[6],
      args[7],
    );
  }

  timerify(fn?: any, options?: any): any {
    return __perfTimerify(fn, options);
  }

  addEventListener(type?: any, listener?: any, options?: any): void {
    __perfEventTarget.addEventListener(type, listener, options);
  }

  removeEventListener(type?: any, listener?: any, options?: any): void {
    __perfEventTarget.removeEventListener(type, listener, options);
  }

  dispatchEvent(event?: any): boolean {
    return __perfEventTarget.dispatchEvent(event);
  }

  toJSON(): any {
    return {
      nodeTiming: __perfNodeTiming,
      timeOrigin: Number(__perfEpoch.origin),
      eventLoopUtilization: __perfEventLoopUtilization(undefined, undefined),
    };
  }
}
__perfDefineTag(Performance.prototype, "Performance");

// The second name `performance` is reached by. See the header: the prelude's
// `performance.now()` spelling is intercepted by the checker even when a user
// declaration shadows it, so `tools/bundle_node_test.sh` rewrites `performance`
// as a receiver to this identifier.
//
// The declared type is `Performance`, not `any`, and that is load-bearing in
// three ways that an `any` binding gets wrong — all three measured on this
// engine, all three exercised by the corpus:
//
//   * `performance.markResourceTiming(a, b, c, d, e, f, g, h)` is a call with
//     eight arguments, which does not compile through an `any` receiver
//     ("type Any has no methods", zun#10). Through a class-typed receiver it
//     does.
//   * `performance.markResourceTiming(...args)` spreads an array into a call,
//     which "is not lowered yet" for an object-literal or property-held
//     callable but works for a class method.
//   * `assert(performance.mark)` reads a method *as a value*, which answers
//     `undefined` through an `any` receiver (zun#19) and a function through a
//     class-typed one.
//
// Everything the corpus reads off `performance` is therefore declared on the
// class above; a name that is not would be a compile error here rather than an
// `undefined` at run time, which is the better failure.
const __zunPerformance: Performance = new Performance(__PERF_TOKEN);

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

// `internalBinding('performance').constants`, which `node:perf_hooks` re-exports
// as a frozen object. The values are the enumerator order in
// `src/node_perf_common.h`, which is what a test comparing two of them relies
// on.
//
// The top-level name is `__perfConstants`, not `constants`, and the module
// object below is the only place the Node spelling appears. This file is
// inlined into any bundle whose test mentions `performance`, and `constants`
// is a name a test of some *other* module may well declare for itself
// (`const constants = require('fs').constants`); two top-level declarations of
// one name are a compile error in a single Zun program. It is for the same
// reason not a canonical binding in `tools/bundle_node_test.sh`:
// `const { constants } = require('perf_hooks')` therefore keeps its
// destructuring and reads the member off the module object.
const __perfConstants: any = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
  NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN: 0,
  NODE_PERFORMANCE_MILESTONE_TIME_ORIGIN_TIMESTAMP: 1,
  NODE_PERFORMANCE_MILESTONE_NODE_START: 2,
  NODE_PERFORMANCE_MILESTONE_V8_START: 3,
  NODE_PERFORMANCE_MILESTONE_LOOP_START: 4,
  NODE_PERFORMANCE_MILESTONE_LOOP_EXIT: 5,
  NODE_PERFORMANCE_MILESTONE_BOOTSTRAP_COMPLETE: 6,
  NODE_PERFORMANCE_MILESTONE_ENVIRONMENT: 7,
  NODE_PERFORMANCE_ENTRY_TYPE_GC: 0,
  NODE_PERFORMANCE_ENTRY_TYPE_HTTP2: 1,
  NODE_PERFORMANCE_ENTRY_TYPE_HTTP: 2,
  NODE_PERFORMANCE_ENTRY_TYPE_NET: 3,
  NODE_PERFORMANCE_ENTRY_TYPE_DNS: 4,
});

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------

// `bootstrapComplete` is the last milestone: this is the moment the library
// stops loading and a bundle's own code starts.
__perfMilestones.bootstrapComplete = __perfNow();

const __node_perf_hooks: any = {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  Histogram,
  RecordableHistogram,
  IntervalHistogram,
  monitorEventLoopDelay,
  createHistogram,
  performance: __zunPerformance,
  constants: __perfConstants,
};

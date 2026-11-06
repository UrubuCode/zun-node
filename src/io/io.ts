// The shared asynchronous-I/O readiness loop — the scheduling half.
//
// `src/io/mod.rs` owns the syscalls: a table of non-blocking handles and one
// `ioPoll(timeoutMs)` native that waits for any of them to become ready. This
// file owns everything above that: which handle wants which event, which
// handles keep the process alive, when to pump, and who to call when a handle
// is ready.
//
// It is deliberately **not** part of `node:net`. `net` is its first consumer
// and the one that forced it into existence, but a readiness loop is the
// capability `dgram`, `child_process.spawn`'s pipes, `fs`' streams and `http`
// all need next, and none of them should start a second one. The contract below
// is therefore written as a general interface — register a handle, declare an
// interest, be called back — with nothing socket-shaped in it.
//
// ---------------------------------------------------------------------------
// Why zun-node had no asynchronous I/O before this
// ---------------------------------------------------------------------------
//
// `src/dns/dns.ts` documents the pattern that got the library this far:
// "synchronous natives, asynchronous API". The native blocks, the result is
// delivered through `process.nextTick`, and the *shape* of Node's callback API
// survives even though the concurrency does not. That is honest for a name
// lookup. It cannot work for a socket, for three reasons at once: a server has
// to be waiting for a connection *while* the program runs, two sockets have to
// make progress at the same time, and a read has to complete after the call
// that armed it returned.
//
// ABI v1 gives an extension no way to complete a call later, so the direction
// is inverted instead. No native here waits for a *particular* event: each one
// either completes or answers "not yet", and a single native waits for *any*
// registered handle. That is the readiness model (`select`/`poll`), and it is
// the only asynchronous I/O this ABI can express.
//
// ---------------------------------------------------------------------------
// Where the waiting happens, and why it has to be inside the native
// ---------------------------------------------------------------------------
//
// The VM's macrotask tier runs on a **virtual clock**: between macrotasks it
// fast-forwards to the earliest due time instead of sleeping (NUCLEUS §9a, and
// see the note in `tools/harness/common.ts`). A probe confirms it —
// `setTimeout(f, 50)` runs with `Date.now()` one millisecond later than when it
// was armed. So a pump written as `setTimeout(pump, 20)` is re-entered
// immediately, and a loop built on timers alone would spin a core without ever
// giving the network time to do anything.
//
// The only real sleep available to this runtime is the one inside a native
// call, which is exactly where `ioPoll` puts it. Each pump turn therefore
// *blocks* in `ioPoll` for a chosen number of milliseconds, and that block is
// both how the process yields the CPU and how real time advances at all.
//
// It is also what keeps the virtual clock honest while I/O is in flight. The
// driver turns once per virtual millisecond while a handle is registered (see
// `tools/harness/common.ts`' `__zunHarnessArm`), so a pending
// `setTimeout(f, 1000)` needs a thousand turns to come due -- and
// `__ioPollTimeout` below blocks one real millisecond per turn whenever a
// ref'd Node timer is armed, which keeps a thousand virtual milliseconds
// costing a thousand real ones. Without that, a test's one-second failsafe
// would fire before its socket could possibly have connected. When no timer is
// armed there is nothing to stay in step with, and the pump blocks in longer
// slices. Measured: an idle *referenced* server — one that nothing connects to,
// with no timer armed — spends **31 ms of CPU over a 5 s window, 0.6% of one
// core**, which is the `__IO_STEP_IDLE` wait doing its job.
//
// ---------------------------------------------------------------------------
// ref / unref
// ---------------------------------------------------------------------------
//
// Node exits when no *ref'd* handle is left, and the `net` corpus checks it
// directly: `test-net-server-unref.js` asserts that an unref'd server does not
// hold the process open. A handle registered here is ref'd by default and can
// be unref'd; `__ioPendingRefs()` reports how many ref'd handles are live, and
// `tools/harness/common.ts` consults it exactly as it consults
// `__timerPendingRefs()`. An unref'd handle is still pumped and still delivers
// its events — it just stops being a reason to stay alive.
//
// ---------------------------------------------------------------------------
// Without the extension
// ---------------------------------------------------------------------------
//
// This file is inlined into **every** bundle, like `src/process/process.ts` and
// `src/timers/timers.ts`, because `tools/harness/common.ts` has to be able to
// ask it for the ref count whether or not the bundle has an extension. So, for
// the reason `src/process/native.ts` documents, the `import` lives in a
// separate file (`src/io/native.ts`) that the bundler appends only for a bundle
// that will be run with `--ext`. With no extension `__ioOps()` answers `null`,
// nothing can ever be registered, `__ioPendingRefs()` is 0, and `__ioPumpOnce`
// answers `false` without doing anything -- the file costs such a bundle
// nothing but its own declarations.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file
// ---------------------------------------------------------------------------
//   * the handler a consumer registers is an **object with three methods**
//     (`readable`, `writable`, `failed`), not three function values: an
//     object-literal method survives every path through an `any` while a bare
//     function value does not (https://github.com/UrubuCode/zun/issues/17), and
//     `src/dns/dns.ts` draws its binding the same way for the same reason.
//   * `Number(x.length)` throughout: `.length` is typed `u64` at the type level
//     (https://github.com/UrubuCode/zun/issues/3).
//   * the loop's state lives in one module-level object rather than in
//     closures: a turn is reached from a `setTimeout` callback in the driver,
//     which cannot capture here, so everything a turn touches has to be
//     reachable from a module-level name (the reason
//     `src/timers/timers.ts` gives for its own `__timerState`).

// Readiness bits, the same set `src/io/sys.rs` uses.
const __IO_READ: number = 1;
const __IO_WRITE: number = 2;
const __IO_ERR: number = 4;

// Field and record separators of the native carrier (see `src/io/mod.rs`).
const __IO_US: string = "\u001f";
const __IO_RS: string = "\u001e";

// How long one pump turn blocks in `ioPoll`, in milliseconds.
//
// `__IO_STEP_BUSY` is used while a ref'd Node timer is armed, so that the
// virtual clock and real time advance together (see the header). `__IO_STEP_IDLE`
// is the slice used when there is nothing to stay in step with; it is what makes
// an idle referenced server cost no measurable CPU, and it is short enough that
// a connection arriving is still delivered promptly.
const __IO_STEP_BUSY: number = 1;
const __IO_STEP_IDLE: number = 10;


// The loop's whole state, in one object rather than a set of top-level `let`s
// — the same reason `src/timers/timers.ts` gives: a pump turn is a `setTimeout`
// callback, which cannot capture, so everything it touches has to be reachable
// from a module-level name.
//
//   ops      — the native namespace, installed by `src/io/native.ts`, or null.
//   handles  — every registered handle, keyed by `String(id)`.
//   ids      — the handle ids in registration order, so dispatch is stable.
//   refs     — how many registered handles are ref'd.
const __ioState: any = {
  ops: null,
  handles: {},
  ids: [],
  refs: 0,
};

// Called once by `src/io/native.ts`, which is the only file that names the
// extension.
function __ioInstallNative(ops: any): void {
  __ioState.ops = ops;
}

// The native namespace, or null when the bundle has no extension.
function __ioOps(): any {
  return __ioState.ops;
}

// Whether asynchronous I/O is available at all in this bundle. A module built
// on this loop uses it to raise an honest error rather than hanging.
function __ioAvailable(): boolean {
  return __ioState.ops !== null && __ioState.ops !== undefined;
}

// ---------------------------------------------------------------------------
// The carrier
// ---------------------------------------------------------------------------

// Did the native report failure in band? See `src/io/mod.rs`.
function __ioFailed(payload: any): boolean {
  return String(payload).charAt(0) === "-";
}

// The fields of a one-record `"+"` payload.
function __ioFields(payload: any): string[] {
  const text: string = String(payload);
  const body: string = text.slice(1);
  if (body === "") return [];
  return body.split(__IO_US);
}

// The records of a multi-record `"+"` payload, each already split into fields.
function __ioRecords(payload: any): any[] {
  const text: string = String(payload);
  const body: string = text.slice(1);
  const out: any[] = [];
  if (body === "") return out;
  for (const record of body.split(__IO_RS)) {
    out.push(record.split(__IO_US));
  }
  return out;
}

// The four fields the native error slots hold for the most recent failure, as
// one record. The caller turns them into whatever error its own module raises
// — this loop has no error class of its own, because `net`'s errors are
// `net`'s and `dgram`'s will be `dgram`'s.
function __ioLastError(): any {
  const ops: any = __ioState.ops;
  if (ops === null || ops === undefined) {
    return { code: "ENOSYS", message: "no asynchronous I/O", syscall: "", errno: 0, address: "" };
  }
  return {
    code: String(ops.errorCode()),
    message: String(ops.errorMessage()),
    syscall: String(ops.errorSyscall()),
    errno: Number(ops.errorErrno()),
    address: String(ops.errorAddress()),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// Register `id` (a handle the native side published) with the handler that
// receives its readiness events.
//
// `handler` is an object with three methods — `readable()`, `writable()` and
// `failed()` — for the reason the header gives. A handle is ref'd when it is
// registered, which is Node's default for a server and a socket alike, and
// starts with no interest: the consumer declares one as soon as it wants an
// event.
function __ioRegister(id: number, handler: any): void {
  const key: string = String(id);
  if (__ioState.handles[key] !== undefined) return;
  __ioState.handles[key] = { id: id, handler: handler, interest: 0, ref: true };
  __ioState.ids.push(id);
  __ioState.refs = Number(__ioState.refs) + 1;
}

// Drop `id` from the loop and close the socket under it. Idempotent: the
// consumers call it on every path out of a handle's lifetime.
function __ioUnregister(id: number): void {
  const key: string = String(id);
  const entry: any = __ioState.handles[key];
  if (entry === undefined) return;
  if (entry.ref === true) __ioState.refs = Number(__ioState.refs) - 1;
  delete __ioState.handles[key];
  const ids: any[] = [];
  for (const other of __ioState.ids) {
    if (Number(other) !== Number(id)) ids.push(other);
  }
  __ioState.ids = ids;
  const ops: any = __ioState.ops;
  if (ops !== null && ops !== undefined) ops.close(Number(id));
}

// Declare which readiness events `id` wants: `__IO_READ`, `__IO_WRITE`, both,
// or 0 for neither.
//
// 0 is what `socket.pause()` reaches: a handle with no read interest is not
// waited on, so a peer that keeps sending fills the *kernel's* receive buffer
// instead of this process's memory. That is real backpressure rather than a
// flag, and it is the one place where the readiness model is simpler than
// Node's own.
function __ioInterest(id: number, mask: number): void {
  const key: string = String(id);
  const entry: any = __ioState.handles[key];
  if (entry === undefined) return;
  if (Number(entry.interest) === Number(mask)) return;
  entry.interest = Number(mask);
  const ops: any = __ioState.ops;
  if (ops !== null && ops !== undefined) ops.interest(Number(id), Number(mask));
}

// Add `mask` to what `id` already wants.
function __ioWant(id: number, mask: number): void {
  const entry: any = __ioState.handles[String(id)];
  if (entry === undefined) return;
  __ioInterest(id, Number(entry.interest) | Number(mask));
}

// Take `mask` away from what `id` wants.
function __ioUnwant(id: number, mask: number): void {
  const entry: any = __ioState.handles[String(id)];
  if (entry === undefined) return;
  const next: number = Number(entry.interest) & ~Number(mask);
  __ioInterest(id, next);
}

// `handle.ref()` — count this handle as a reason for the process to stay alive.
function __ioRef(id: number): void {
  const entry: any = __ioState.handles[String(id)];
  if (entry === undefined || entry.ref === true) return;
  entry.ref = true;
  __ioState.refs = Number(__ioState.refs) + 1;
}

// `handle.unref()` — keep delivering this handle's events, but stop holding the
// process open for it.
function __ioUnref(id: number): void {
  const entry: any = __ioState.handles[String(id)];
  if (entry === undefined || entry.ref !== true) return;
  entry.ref = false;
  __ioState.refs = Number(__ioState.refs) - 1;
}

// Is `id` still registered?
function __ioHas(id: number): boolean {
  return __ioState.handles[String(id)] !== undefined;
}

// How many ref'd handles are live — the fact `tools/harness/common.ts` needs to
// decide the program is not finished yet, and the mirror of
// `__timerPendingRefs()`.
function __ioPendingRefs(): number {
  return Number(__ioState.refs);
}

// How many handles are registered at all, ref'd or not.
function __ioPending(): number {
  return Number(__ioState.ids.length);
}

// Close every handle and forget it. The harness calls this once the program is
// over, for the same reason it calls `__timerShutdown()`: the loop would
// otherwise keep re-arming.
function __ioShutdown(): void {
  const ids: any[] = [];
  for (const id of __ioState.ids) ids.push(id);
  for (const id of ids) __ioUnregister(Number(id));
  __ioState.handles = {};
  __ioState.ids = [];
  __ioState.refs = 0;
}

// ---------------------------------------------------------------------------
// The pump
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Who drives the pump, and why it is not this file
// ---------------------------------------------------------------------------
//
// The first version of this loop owned a chain of its own: each turn armed the
// next with `__ioCore.setTimeout(step, 1)`. It does not work, and the way it
// fails is worth recording, because the next track will reach for the same
// shape.
//
// The VM's macrotask tier runs on a virtual clock that fast-forwards to the
// earliest due time instead of sleeping, so *every* armed task is due as soon
// as the clock jumps, and among due tasks this engine runs the most recently
// armed one. A pump that re-arms itself at the end of its own turn is
// therefore always the newest task in the queue and always wins: with one
// handle registered, nothing else in the program ever ran again. A probe
// reduces it to four lines — a `net` server plus `setTimeout(f, 1)`, where `f`
// never fires — and no arming distance fixes it, because the clock
// fast-forwards past any distance. Measured, it cost 20 of the 149 `net`
// tests: they died on the runner's timeout instead of on their own assertions.
//
// So the loop does not own a chain. It exposes **one turn**,
// [`__ioPumpOnce`], and whoever already drives this program's macrotasks calls
// it once per turn. Today that is the test harness's settle loop
// (`tools/harness/common.ts`), which is the only macrotask driver a bundle in
// this library has; a VM that grew a "before the loop blocks" hook would be the
// natural place for it instead, and the shape of this function is chosen so
// that such a host needs no change here.
//
// `__ioPending()` is what the driver watches: while it is positive there are
// handles to poll, whether or not any of them is ref'd (an unref'd handle still
// delivers its events — it just stops being a reason to stay alive, which is
// `__ioPendingRefs()`' business).

// How long this turn should block inside `ioPoll`. See the header: the choice
// is what keeps the virtual clock in step with real time while Node timers are
// armed, and what keeps an idle server off the CPU when none is.
function __ioPollTimeout(): number {
  // `process.nextTick` work is strictly ahead of any I/O event in Node's
  // ordering, so a turn with ticks pending does not wait at all.
  if (__processPendingTicks() > 0) return 0;
  if (__timerPendingRefs() > 0) return __IO_STEP_BUSY;
  return __IO_STEP_IDLE;
}

// One turn: wait for readiness, then deliver it. Answers whether anything is
// still registered, so the driver knows whether to keep calling.
function __ioPumpOnce(): boolean {
  const ops: any = __ioState.ops;
  if (ops === null || ops === undefined) return false;
  if (Number(__ioState.ids.length) === 0) return false;

  const payload: any = ops.poll(__ioPollTimeout());
  if (!__ioFailed(payload)) {
    for (const record of __ioRecords(payload)) {
      if (Number(record.length) < 2) continue;
      __ioDeliver(Number(record[0]), Number(record[1]));
    }
  }
  return Number(__ioState.ids.length) > 0;
}

// Deliver one handle's readiness to its handler.
//
// The order is Node's: an error is reported before a read, and a read before a
// write, because a handle that is both readable and in error has data the
// consumer still wants and an error it must see first. A handler may close its
// handle from inside any of the three, so each step re-checks that the handle
// is still registered.
function __ioDeliver(id: number, revents: number): void {
  const key: string = String(id);
  let entry: any = __ioState.handles[key];
  if (entry === undefined) return;
  const handler: any = entry.handler;

  if ((Number(revents) & __IO_ERR) !== 0) {
    handler.failed();
    if (__ioState.handles[key] === undefined) return;
  }
  if ((Number(revents) & __IO_READ) !== 0) {
    handler.readable();
    if (__ioState.handles[key] === undefined) return;
  }
  if ((Number(revents) & __IO_WRITE) !== 0) {
    handler.writable();
  }
}

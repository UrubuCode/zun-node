// `test/common/hijackstdio` — the harness module Node's own test files use to
// capture what a `console` method writes.
//
// This is harness code, not library code, in the same sense as
// `tools/harness/common.ts` and `tools/harness/tmpdir.ts`: it is a module Node's
// test suite provides to its own tests (`test/common/hijackstdio.js`, MIT), not
// a module `zun-node` implements. Three console tests are written against it
// (`test-console.js`, `test-console-group.js`,
// `test-console-diagnostics-channels.js`), and they are the only consumers.
//
// Node's version swaps `process.stdout.write` for a wrapper that calls the
// listener, writes through to the real stream, and counts the write; `restore*`
// puts the original function back and drops the counter. Two details differ
// here, and only in how the original is recovered:
//
//   * `process.stdout.write` is an **object-literal method** in
//     ../../src/process/process.ts, and a method read as a *value* is not a
//     callable in this engine (https://github.com/UrubuCode/zun/issues/17), so
//     the saved value cannot always be called back. The real writer is therefore
//     a named function here — `host.stdoutWrite` is what `process.stdout.write`
//     does — and it is the fallback when the slot held the original method. A
//     function the *test* installed reads back fine, and that one is saved and
//     restored exactly, which is what `test-console.js` needs when it hijacks
//     stderr twice.
//   * `_write.call(stream, data, callback)` becomes a direct call: `call`
//     threads no receiver and shifts the argument list
//     (https://github.com/UrubuCode/zun/issues/1), and a write needs no
//     receiver.
//
// `host` is in scope without an import of its own: ../../src/process/process.ts
// binds it for the whole program, which is the same thing
// `tools/harness/common.ts` relies on for `host.stderrWrite`.

// Per-stream state: the listener in force, and whatever the `write` slot held
// when the hijack started (a boxed callable, or `undefined` when it was the
// original method and therefore unreadable).
const __hijackState: any = {
  stdoutListener: undefined,
  stderrListener: undefined,
  stdoutSaved: undefined,
  stderrSaved: undefined,
};

// What `process.stdout.write` / `process.stderr.write` do, as plain functions,
// so the slot can be restored to something callable.
function __hijackRealStdoutWrite(text: any): boolean {
  host.stdoutWrite(String(text));
  return true;
}

function __hijackRealStderrWrite(text: any): boolean {
  host.stderrWrite(String(text));
  return true;
}

// A listener that throws is re-raised on the next tick, as in Node: the write
// itself must still go through.
function __hijackRethrow(error: any): void {
  throw error;
}

function __hijackDeliver(listener: any, data: any): void {
  if (listener === undefined || listener === null) return;
  try {
    __evCall(listener, [data]);
  } catch (error) {
    process.nextTick(__hijackRethrow, error);
  }
}

function __hijackWriteStdout(data: any, callback?: any): boolean {
  __hijackDeliver(__hijackState.stdoutListener, data);
  const saved: any = __hijackState.stdoutSaved;
  if (saved !== undefined && saved !== null) {
    __evCall(saved, [data, callback]);
  } else {
    __hijackRealStdoutWrite(data);
  }
  const stream: any = process.stdout;
  stream.writeTimes = Number(stream.writeTimes) + 1;
  return true;
}

function __hijackWriteStderr(data: any, callback?: any): boolean {
  __hijackDeliver(__hijackState.stderrListener, data);
  const saved: any = __hijackState.stderrSaved;
  if (saved !== undefined && saved !== null) {
    __evCall(saved, [data, callback]);
  } else {
    __hijackRealStderrWrite(data);
  }
  const stream: any = process.stderr;
  stream.writeTimes = Number(stream.writeTimes) + 1;
  return true;
}

function __hijackStdout(listener: any): void {
  const stream: any = process.stdout;
  const previous: any = stream["write"];
  __hijackState.stdoutSaved = __evIsFn(previous) ? __evBox(previous) : undefined;
  __hijackState.stdoutListener = __evBox(listener);
  stream.writeTimes = 0;
  stream.write = __hijackWriteStdout;
}

function __hijackStderr(listener: any): void {
  const stream: any = process.stderr;
  const previous: any = stream["write"];
  __hijackState.stderrSaved = __evIsFn(previous) ? __evBox(previous) : undefined;
  __hijackState.stderrListener = __evBox(listener);
  stream.writeTimes = 0;
  stream.write = __hijackWriteStderr;
}

function __hijackRestoreStdout(): void {
  const stream: any = process.stdout;
  const saved: any = __hijackState.stdoutSaved;
  stream.write = saved !== undefined && saved !== null ? saved : __hijackRealStdoutWrite;
  __hijackState.stdoutSaved = undefined;
  __hijackState.stdoutListener = undefined;
  stream.writeTimes = undefined;
}

function __hijackRestoreStderr(): void {
  const stream: any = process.stderr;
  const saved: any = __hijackState.stderrSaved;
  stream.write = saved !== undefined && saved !== null ? saved : __hijackRealStderrWrite;
  __hijackState.stderrSaved = undefined;
  __hijackState.stderrListener = undefined;
  stream.writeTimes = undefined;
}

const __node_harness_hijackstdio: any = {
  hijackStdout: __hijackStdout,
  hijackStderr: __hijackStderr,
  restoreStdout: __hijackRestoreStdout,
  restoreStderr: __hijackRestoreStderr,
};

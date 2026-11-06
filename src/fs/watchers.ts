// node:fs — `fs.watch`, `fs.watchFile`, `fs.unwatchFile` and
// `fsPromises.watch`, as polling watchers.
//
// This follows `lib/internal/fs/watchers.js` and `lib/fs.js` (MIT, Copyright
// Joyent, Inc. and other Node contributors) for the two classes' observable
// surface — the `'change'`/`'stop'`/`'close'`/`'error'` events, the
// `statWatchers` map `unwatchFile` deletes from, the reference counting
// `watchFile` does when a second listener joins an existing watcher, and the
// `{ interval: 5007, persistent: true }` default.
//
// ---------------------------------------------------------------------------
// Why polling, and why that is not a shortcut
// ---------------------------------------------------------------------------
//
// Node has two watchers and only one of them is event-driven:
//
//   * `fs.watchFile` **is** a poller in Node too — `uv_fs_poll_t`, which
//     stats the path on a timer and compares the result with the previous
//     one. The algorithm reproduced below is libuv's `poll_cb` verbatim
//     (`deps/uv/src/fs-poll.c`): the first *successful* stat is recorded
//     without an event, the first *failing* one does fire, and `busyPolling`
//     is the tri-state that makes those two rules work out. That is why a
//     `watchFile` on a path that does not exist yet calls its listener once
//     with two all-zero `Stats` and again when the file appears, which is
//     exactly what Node's own test-fs-watchfile.js asserts.
//
//   * `fs.watch` is `uv_fs_event_t` in Node, which is `ReadDirectoryChangesW`
//     on Windows and `inotify` on Linux. There is no loop hook in this VM to
//     attach such a handle to, so this one is a directory/file poller: a
//     snapshot of the entry names and their `(mtimeMs, size, ino)` is diffed
//     on each tick, an appeared or vanished name is reported as `'rename'`
//     and a changed one as `'change'` — the same two event types, and the
//     same `(eventType, filename)` listener arguments. The resolution is the
//     poll interval rather than the kernel's, so a program that writes and
//     then immediately closes the watcher in the same tick can miss an event
//     the real one would deliver. Node's own `recursive` fallback on Linux
//     (`lib/internal/fs/recursive_watch.js`) is a poller of exactly this kind,
//     so the shape is one Node ships rather than one invented here.
//
// The timer is the module's own `setInterval`/`clearInterval`
// (src/timers/timers.ts), so `persistent: false` is an `unref()` and the
// process exits with a non-persistent watcher still armed — which is what
// `ref`/`unref` mean on both classes.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file
// ---------------------------------------------------------------------------
//   * `Number(x.length)` for every array length (zun#3).
//   * a listener is invoked through `__evCall` (zun#1/zun#17), and the
//     `'change'` listener `watchFile` adds is the caller's own value so that
//     `unwatchFile(path, listener)` can find it again by identity.
//   * the watcher classes extend `EventEmitter` directly; `emit` is reached as
//     a method, never as a value.

// ---------------------------------------------------------------------------
// The zeroed `Stats` a failing poll reports
// ---------------------------------------------------------------------------

// libuv's `zero_statbuf`. Node's own test constructs the same thing with
// `new fs.Stats(0, 0, ...)` and compares with `deepStrictEqual`, so every
// field has to be the zero of its kind and the four dates have to be the
// epoch.
function __fsWatchZeroStats(bigint: boolean): any {
  const fields: string[] = [
    "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "0", "0", "0",
  ];
  return __fsStatsFromFields(fields, bigint);
}

// `statbuf_eq` — libuv compares the whole `uv_stat_t`, so a change in any one
// of these fields is a change.
function __fsWatchStatsEq(a: any, b: any): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    Number(a.dev) === Number(b.dev) &&
    Number(a.mode) === Number(b.mode) &&
    Number(a.nlink) === Number(b.nlink) &&
    Number(a.uid) === Number(b.uid) &&
    Number(a.gid) === Number(b.gid) &&
    Number(a.rdev) === Number(b.rdev) &&
    Number(a.ino) === Number(b.ino) &&
    Number(a.size) === Number(b.size) &&
    Number(a.blksize) === Number(b.blksize) &&
    Number(a.blocks) === Number(b.blocks) &&
    Number(a.atimeMs) === Number(b.atimeMs) &&
    Number(a.mtimeMs) === Number(b.mtimeMs) &&
    Number(a.ctimeMs) === Number(b.ctimeMs) &&
    Number(a.birthtimeMs) === Number(b.birthtimeMs)
  );
}

// ---------------------------------------------------------------------------
// StatWatcher — `fs.watchFile`'s return value
// ---------------------------------------------------------------------------

class StatWatcher extends EventEmitter {
  _handle: any = null;
  __bigint: boolean = false;
  __path: string = "";
  __interval: number = 5007;
  __persistent: boolean = true;
  // libuv's `busy_polling`: 0 before the first poll, 1 once a stat succeeded,
  // and the negative errno while the path cannot be stat'ed.
  __busy: number = 0;
  __prev: any = undefined;
  __refs: number = 1;
  __maxRefs: number = 1;

  constructor(bigint?: any) {
    super();
    this.__bigint = bigint === true;
    this.__prev = __fsWatchZeroStats(this.__bigint);
  }

  // `StatWatcher.prototype.start` is a documented-nowhere no-op in Node, kept
  // for programs that called it before the handle became private.
  start(): void {}

  stop(): any {
    if (this._handle === null) return undefined;
    __fsWatchClearTimer(this._handle);
    this._handle = null;
    const self: any = this;
    __processNextTick(function (): void {
      self.emit("stop");
    });
    return undefined;
  }

  ref(): any {
    if (this.__refs === this.__maxRefs) return this;
    const before: number = this.__refs;
    this.__refs = before + 1;
    if (this._handle !== null && before === 0) __fsWatchRefTimer(this._handle, true);
    return this;
  }

  unref(): any {
    if (this.__refs === 0) return this;
    this.__refs = this.__refs - 1;
    if (this._handle !== null && this.__refs === 0) {
      __fsWatchRefTimer(this._handle, false);
    }
    return this;
  }
}

// `kFSStatWatcherAddOrCleanRef`, which `watchFile`/`unwatchFile` use to keep
// one watcher alive for as long as any of its listeners wants it.
function __fsStatWatcherRefs(watcher: any, operate: string): void {
  if (operate === "add") {
    watcher.__refs = Number(watcher.__refs) + 1;
    watcher.__maxRefs = Number(watcher.__maxRefs) + 1;
    return;
  }
  if (operate === "clean") {
    watcher.__maxRefs = Number(watcher.__maxRefs) - 1;
    watcher.unref();
    return;
  }
  // "cleanAll"
  watcher.__maxRefs = 0;
  watcher.__refs = 0;
  if (watcher._handle !== null) __fsWatchRefTimer(watcher._handle, false);
}

// `kFSStatWatcherStart`.
function __fsStatWatcherStart(
  watcher: any,
  filename: string,
  persistent: any,
  interval: any,
): void {
  if (watcher._handle !== null) return;
  __fsValidateInteger(interval, "interval", 0, __FS_UINT32_MAX);
  watcher.__path = filename;
  watcher.__interval = Number(interval);
  watcher.__persistent = persistent !== false;
  watcher.__busy = 0;
  watcher._handle = __fsWatchSetTimer(
    function (): void {
      __fsStatWatcherPoll(watcher);
    },
    watcher.__interval,
    watcher.__persistent,
  );
  if (!watcher.__persistent) watcher.unref();
}

// libuv's `poll_cb`, field for field.
function __fsStatWatcherPoll(watcher: any): void {
  let current: any = undefined;
  let failure: any = undefined;
  try {
    current = __fsStatSync(watcher.__path, { bigint: watcher.__bigint });
  } catch (error) {
    failure = error;
  }

  if (failure !== undefined) {
    const errno: number = Number(failure.errno);
    if (Number(watcher.__busy) !== errno) {
      watcher.__busy = errno;
      const zero: any = __fsWatchZeroStats(watcher.__bigint);
      __fsStatWatcherEmit(watcher, zero, watcher.__prev);
    }
    return;
  }

  const busy: number = Number(watcher.__busy);
  if (busy !== 0) {
    if (busy < 0 || !__fsWatchStatsEq(watcher.__prev, current)) {
      __fsStatWatcherEmit(watcher, current, watcher.__prev);
    }
  }
  watcher.__prev = current;
  watcher.__busy = 1;
}

function __fsStatWatcherEmit(watcher: any, current: any, previous: any): void {
  watcher.emit("change", current, previous);
}

// The `statWatchers` map in `lib/fs.js`, keyed by the resolved path.
const __fsStatWatchers: any = new Map();

function __fsWatchFileImpl(filename: any, options: any, listener: any): any {
  let resolved: string = __node_path.resolve(__fsGetValidatedPath(filename));
  let settings: any = options;
  let target: any = listener;
  if (settings === null || typeof settings !== "object") {
    target = settings;
    settings = null;
  }
  // 5007 is what libev used to use; Node keeps it to hold behavioural change
  // to a minimum.
  const merged: any = { interval: 5007, persistent: true, ...settings };
  __fsValidateFunction(target, "listener");

  let watcher: any = __fsStatWatchers.get(resolved);
  if (watcher === undefined) {
    watcher = new StatWatcher(merged.bigint);
    __fsStatWatcherStart(watcher, resolved, merged.persistent, merged.interval);
    __fsStatWatchers.set(resolved, watcher);
  } else {
    __fsStatWatcherRefs(watcher, "add");
  }
  watcher.addListener("change", target);
  return watcher;
}

function __fsUnwatchFileImpl(filename: any, listener: any): void {
  const resolved: string = __node_path.resolve(__fsGetValidatedPath(filename));
  const watcher: any = __fsStatWatchers.get(resolved);
  if (watcher === undefined) return;
  if (__evIsFn(listener)) {
    const before: number = Number(watcher.listenerCount("change"));
    watcher.removeListener("change", listener);
    if (Number(watcher.listenerCount("change")) < before) {
      __fsStatWatcherRefs(watcher, "clean");
    }
  } else {
    watcher.removeAllListeners("change");
    __fsStatWatcherRefs(watcher, "cleanAll");
  }
  if (Number(watcher.listenerCount("change")) === 0) {
    watcher.stop();
    __fsStatWatchers.delete(resolved);
  }
}

// ---------------------------------------------------------------------------
// FSWatcher — `fs.watch`'s return value
// ---------------------------------------------------------------------------

// How often the directory/file snapshot is re-taken. libuv reports a change
// as the kernel sees it; this is the resolution of the substitute, chosen
// short enough that a test which writes on a 1 ms interval and waits for one
// event sees it, and long enough that a 60-second corpus run is not spent
// stat'ing.
const __FS_WATCH_INTERVAL: number = 10;

class FSWatcher extends EventEmitter {
  _handle: any = null;
  __path: string = "";
  __encoding: any = "utf8";
  __recursive: boolean = false;
  __persistent: boolean = true;
  __snapshot: any = undefined;
  __started: boolean = false;
  __closed: boolean = false;

  constructor(options?: any) {
    super();
    if (options !== undefined && options !== null) {
      if (options.encoding !== undefined) this.__encoding = options.encoding;
      if (options.recursive === true) this.__recursive = true;
      if (options.persistent === false) this.__persistent = false;
    }
    // Node's handle is a live `FSEvent` from the constructor on, and `close()`
    // before `start()` is a silent no-op; the same is had with a record whose
    // timer slot is filled by `start`.
    this._handle = { timer: undefined };
  }

  start(): void {}

  close(): any {
    if (this._handle === null) return undefined;
    if (this.__started !== true) return undefined;
    __fsWatchClearTimer(this._handle);
    this._handle = null;
    this.__closed = true;
    const self: any = this;
    __processNextTick(function (): void {
      self.emit("close");
    });
    return undefined;
  }

  ref(): any {
    if (this._handle !== null) __fsWatchRefTimer(this._handle, true);
    return this;
  }

  unref(): any {
    if (this._handle !== null) __fsWatchRefTimer(this._handle, false);
    return this;
  }
}

// `kFSWatchStart`.
function __fsWatcherStart(
  watcher: any,
  filename: any,
  persistent: any,
  recursive: any,
  encoding: any,
): void {
  if (watcher._handle === null) return;
  if (watcher.__started === true) return;
  const resolved: string = __fsGetValidatedPath(filename, "filename");
  // libuv fails `uv_fs_event_start` on a path that is not there, and Node
  // turns that into a thrown `ENOENT` watch error carrying `filename`.
  let stats: any = undefined;
  try {
    stats = __fsStatSync(resolved, undefined);
  } catch (error) {
    throw __fsWatchError(error, resolved);
  }
  watcher.__path = resolved;
  watcher.__persistent = persistent !== false;
  watcher.__recursive = recursive === true;
  if (encoding !== undefined && encoding !== null) watcher.__encoding = encoding;
  watcher.__snapshot = __fsWatchSnapshot(resolved, stats.isDirectory(), watcher.__recursive);
  watcher.__started = true;
  watcher._handle.timer = __fsWatchSetTimer(
    function (): void {
      __fsWatcherPoll(watcher);
    },
    __FS_WATCH_INTERVAL,
    watcher.__persistent,
  );
}

// The thrown form of a failed `uv_fs_event_start`: Node builds a `UVException`
// with `syscall: 'watch'` and copies the path into `filename` as well.
function __fsWatchError(error: any, filename: string): any {
  const raised: any = new __FsUvError(
    String(error.code),
    Number(error.errno),
    "watch",
    __fsWatchDescription(String(error.code)),
    filename,
    undefined,
  );
  raised.filename = filename;
  return raised;
}

function __fsWatchDescription(code: string): string {
  if (code === "ENOENT") return "no such file or directory";
  if (code === "EACCES") return "permission denied";
  if (code === "ENOTDIR") return "not a directory";
  if (code === "EPERM") return "operation not permitted";
  return "unknown error";
}

// One snapshot entry per name, holding what a change would alter.
function __fsWatchSnapshot(root: string, directory: boolean, recursive: boolean): any {
  const entries: any = new Map();
  if (!directory) {
    __fsWatchSnapshotOne(entries, root, __node_path.basename(root));
    return { directory: false, entries: entries };
  }
  __fsWatchSnapshotDir(entries, root, "", recursive);
  return { directory: true, entries: entries };
}

function __fsWatchSnapshotDir(
  entries: any,
  directory: string,
  prefix: string,
  recursive: boolean,
): void {
  let names: any[] = [];
  try {
    names = __fsReaddirSync(directory, undefined);
  } catch (error) {
    return;
  }
  const count: number = Number(names.length);
  for (let i = 0; i < count; i++) {
    const name: string = String(names[i]);
    const relative: string = prefix === "" ? name : prefix + __node_path.sep + name;
    const full: string = __node_path.join(directory, name);
    const isDir: boolean = __fsWatchSnapshotOne(entries, full, relative);
    if (recursive && isDir) {
      __fsWatchSnapshotDir(entries, full, relative, true);
    }
  }
}

// Returns whether the entry is a directory, so the recursive walk knows where
// to descend.
function __fsWatchSnapshotOne(entries: any, full: string, name: string): boolean {
  let stats: any = undefined;
  try {
    stats = __fsLstatSync(full, undefined);
  } catch (error) {
    return false;
  }
  entries.set(name, {
    mtime: Number(stats.mtimeMs),
    size: Number(stats.size),
    ino: Number(stats.ino),
    mode: Number(stats.mode),
  });
  return stats.isDirectory();
}

function __fsWatcherPoll(watcher: any): void {
  if (watcher.__started !== true || watcher._handle === null) return;
  const previous: any = watcher.__snapshot;
  let stats: any = undefined;
  let present: boolean = true;
  try {
    stats = __fsStatSync(watcher.__path, undefined);
  } catch (error) {
    present = false;
  }
  if (!present) {
    // The watched path itself vanished. libuv reports one `rename` for it and
    // keeps the handle open.
    const name: string = __node_path.basename(watcher.__path);
    watcher.__snapshot = { directory: previous.directory, entries: new Map() };
    if (Number(previous.entries.size) !== 0) {
      __fsWatcherEmit(watcher, "rename", name);
    }
    return;
  }
  const current: any = __fsWatchSnapshot(
    watcher.__path,
    stats.isDirectory(),
    watcher.__recursive,
  );
  watcher.__snapshot = current;
  __fsWatchDiff(watcher, previous.entries, current.entries);
}

function __fsWatchDiff(watcher: any, before: any, after: any): void {
  // An appeared or vanished name is a `rename`; a name whose size, mtime,
  // inode or mode moved is a `change`. libuv's event types, and the order a
  // directory listing gives.
  for (const name of after.keys()) {
    const old: any = before.get(name);
    const now: any = after.get(name);
    if (old === undefined) {
      __fsWatcherEmit(watcher, "rename", name);
      continue;
    }
    if (
      Number(old.mtime) !== Number(now.mtime) ||
      Number(old.size) !== Number(now.size) ||
      Number(old.ino) !== Number(now.ino) ||
      Number(old.mode) !== Number(now.mode)
    ) {
      __fsWatcherEmit(watcher, "change", name);
    }
  }
  for (const name of before.keys()) {
    if (after.get(name) === undefined) {
      __fsWatcherEmit(watcher, "rename", name);
    }
  }
}

function __fsWatcherEmit(watcher: any, eventType: string, name: string): void {
  if (watcher._handle === null) return;
  watcher.emit("change", eventType, __fsWatchName(name, watcher.__encoding));
}

// `filename` is a `Buffer` when the watcher was opened with
// `encoding: 'buffer'`, exactly as `readdir` reports its names.
function __fsWatchName(name: string, encoding: any): any {
  return __fsName(name, encoding);
}

// ---------------------------------------------------------------------------
// The timer under both classes
// ---------------------------------------------------------------------------
//
// A record rather than the handle itself, so `ref`/`unref` and `close` have
// one place to reach and a closed watcher's slot can be emptied.

function __fsWatchSetTimer(tick: any, interval: any, persistent: boolean): any {
  // `setInterval(fn, 0)` is `setInterval(fn, 1)` in Node, and a watcher with
  // `interval: 0` is exactly how its own tests ask for "as fast as you can".
  const delay: number = Number(interval) > 0 ? Number(interval) : 1;
  const handle: any = { timer: undefined };
  handle.timer = setInterval(tick, delay);
  if (!persistent) handle.timer.unref();
  return handle;
}

function __fsWatchClearTimer(handle: any): void {
  if (handle === null || handle === undefined) return;
  if (handle.timer !== undefined && handle.timer !== null) {
    clearInterval(handle.timer);
    handle.timer = undefined;
  }
}

function __fsWatchRefTimer(handle: any, on: boolean): void {
  if (handle === null || handle === undefined) return;
  const timer: any = handle.timer;
  if (timer === undefined || timer === null) return;
  if (on) {
    timer.ref();
    return;
  }
  timer.unref();
}

// ---------------------------------------------------------------------------
// fs.watch
// ---------------------------------------------------------------------------

function __fsWatchImpl(filename: any, options: any, listener: any): any {
  let target: any = listener;
  let given: any = options;
  if (__evIsFn(options)) {
    target = options;
    given = undefined;
  }
  const settings: any = { ...__fsGetOptions(given, {}) };
  if (settings.persistent === undefined) settings.persistent = true;
  if (settings.recursive === undefined) settings.recursive = false;
  __fsValidateBoolean(settings.persistent, "options.persistent");
  __fsValidateBoolean(settings.recursive, "options.recursive");

  const watcher: any = new FSWatcher(settings);
  __fsWatcherStart(
    watcher,
    filename,
    settings.persistent,
    settings.recursive,
    settings.encoding,
  );
  if (target !== undefined && target !== null) {
    watcher.addListener("change", target);
  }
  const signal: any = settings.signal;
  if (signal !== undefined && signal !== null) {
    if (signal.aborted === true) {
      __processNextTick(function (): void {
        watcher.close();
      });
    } else {
      signal.addEventListener("abort", function (): void {
        watcher.close();
      });
    }
  }
  return watcher;
}

// ---------------------------------------------------------------------------
// fsPromises.watch
// ---------------------------------------------------------------------------
//
// Node's is an `async function*`. The observable contract is the async
// iterator it returns, so this is that iterator written out: a queue the
// `FSWatcher` fills and a `next()` that either answers from the queue or
// parks a resolver until the next event. `for await ... of` reaches it
// through `Symbol.asyncIterator`, and `break`ing out of the loop calls
// `return()`, which closes the watcher — the same as Node's `finally`.

function __fsPromisesWatchImpl(filename: any, options: any): any {
  const settings: any = { ...__fsGetOptions(options, {}) };
  if (settings.persistent === undefined) settings.persistent = true;
  if (settings.recursive === undefined) settings.recursive = false;
  const maxQueue: number = settings.maxQueue === undefined ? 2048 : Number(settings.maxQueue);
  const overflow: any = settings.overflow === undefined ? "ignore" : settings.overflow;
  __fsValidateBoolean(settings.persistent, "options.persistent");
  __fsValidateBoolean(settings.recursive, "options.recursive");
  __fsValidateInteger(maxQueue, "options.maxQueue", 0, __FS_UINT32_MAX);
  if (overflow !== "ignore" && overflow !== "error") {
    throw new ERR_INVALID_ARG_VALUE(
      "options.overflow",
      overflow,
      "must be one of: 'ignore', 'error'",
    );
  }

  const state: any = {
    queue: [],
    waiting: undefined,
    done: false,
    watcher: undefined,
  };

  const watcher: any = __fsWatchImpl(filename, settings, undefined);
  state.watcher = watcher;
  watcher.on("change", function (eventType: any, name: any): void {
    __fsWatchQueuePush(state, { eventType: eventType, filename: name }, maxQueue, overflow);
  });
  watcher.on("error", function (error: any): void {
    __fsWatchQueuePush(state, error, maxQueue, "ignore");
  });

  const signal: any = settings.signal;
  if (signal !== undefined && signal !== null) {
    signal.addEventListener("abort", function (): void {
      __fsWatchQueueEnd(state);
    });
  }

  return __fsWatchIterator(state);
}

function __fsWatchQueuePush(state: any, item: any, maxQueue: number, overflow: any): void {
  if (state.done === true) return;
  if (Number(state.queue.length) >= maxQueue) {
    if (overflow === "error") {
      state.queue = [];
      state.queue.push(new ERR_FS_WATCH_QUEUE_OVERFLOW(maxQueue));
    } else {
      __processEmitWarning("fs.watch maxQueue exceeded");
      return;
    }
  } else {
    state.queue.push(item);
  }
  __fsWatchWake(state);
}

function __fsWatchQueueEnd(state: any): void {
  state.done = true;
  __fsWatchWake(state);
}

function __fsWatchWake(state: any): void {
  const parked: any = state.waiting;
  if (parked === undefined || parked === null) return;
  state.waiting = undefined;
  __evCall(parked, []);
}

class ERR_FS_WATCH_QUEUE_OVERFLOW extends NodeError {
  constructor(size: any) {
    super(
      "ERR_FS_WATCH_QUEUE_OVERFLOW",
      "fs.watch queue overflow: " + String(size) + " events queued",
    );
  }
}

// The iterator object itself. `next()` answers from the queue when it can and
// otherwise parks one resolver — there is exactly one consumer of an async
// iterator, so one slot is enough.
function __fsWatchIterator(state: any): any {
  const iterator: any = {
    next(): any {
      if (Number(state.queue.length) > 0) {
        return Promise.resolve(__fsWatchStep(state));
      }
      if (state.done === true) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise(function (resolve: any, reject: any): void {
        state.waiting = function (): void {
          if (Number(state.queue.length) > 0) {
            const step: any = __fsWatchStep(state);
            if (step.failure !== undefined) {
              reject(step.failure);
              return;
            }
            resolve(step);
            return;
          }
          resolve({ value: undefined, done: true });
        };
      });
    },
    return(value?: any): any {
      state.done = true;
      state.watcher.close();
      return Promise.resolve({ value: value, done: true });
    },
    throw(error?: any): any {
      state.done = true;
      state.watcher.close();
      return Promise.reject(error);
    },
  };
  iterator[Symbol.asyncIterator] = function (): any {
    return iterator;
  };
  return iterator;
}

// One queued item, as the iterator result Node's generator would yield. An
// error in the queue becomes the `failure` slot, which `next()` rejects with.
function __fsWatchStep(state: any): any {
  const item: any = state.queue.shift();
  if (item instanceof Error) {
    state.done = true;
    state.watcher.close();
    return { value: undefined, done: true, failure: item };
  }
  return { value: item, done: false };
}

// ---------------------------------------------------------------------------
// Installing into `fs`
// ---------------------------------------------------------------------------

fs.FSWatcher = FSWatcher;
fs.StatWatcher = StatWatcher;

__fsWatchHooks.watch = function (path: any, options?: any, listener?: any): any {
  return __fsWatchImpl(path, options, listener);
};
__fsWatchHooks.watchFile = function (path: any, options?: any, listener?: any): any {
  return __fsWatchFileImpl(path, options, listener);
};
__fsWatchHooks.unwatchFile = function (path: any, listener?: any): void {
  __fsUnwatchFileImpl(path, listener);
};
__fsWatchHooks.promisesWatch = function (path: any, options?: any): any {
  return __fsPromisesWatchImpl(path, options);
};

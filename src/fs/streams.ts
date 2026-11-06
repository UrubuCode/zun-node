// node:fs — `fs.ReadStream` / `fs.WriteStream`, over src/stream/stream.ts.
//
// This is `lib/internal/fs/streams.js` (MIT, Copyright Joyent, Inc. and other
// Node contributors): the two classes are observable through Node's corpus
// down to the order of their `'open'`/`'ready'` events, which chunk a short
// read pushes, and which `ERR_*` a bad option raises, so the algorithms are
// followed rather than re-derived.
//
// ---------------------------------------------------------------------------
// Why a separate file
// ---------------------------------------------------------------------------
//
// `src/fs/fs.ts` must keep compiling in a bundle that has no `node:stream` in
// it — `../common/tmpdir` pulls `fs` in for 160 of the corpus' files, and a
// `path`/`events` bundle must not grow a stream module it never uses. So the
// two classes live here, this file is appended after `src/stream/stream.ts`
// (tools/bundle_node_test.sh's CONDITIONAL_FILES), and the only thing `fs.ts`
// knows about them is the hook table `__fsStreamHooks`, which holds
// `ERR_METHOD_NOT_IMPLEMENTED` throwers until this file overwrites them.
//
// ---------------------------------------------------------------------------
// How the "asynchronous" I/O happens
// ---------------------------------------------------------------------------
//
// The natives under `fs` are synchronous (`src/fs/rw.rs`), and the callback
// half of `fs.ts` turns each one into a `process.nextTick` delivery
// (`__fsRunAsync`/`__fsDeliver`). A stream here is therefore exactly Node's:
// `_read` asks the *callback* `read` for a chunk and pushes it when the
// callback fires on a later tick, so back-pressure, `pause()`/`resume()` and
// `pipe()` behave as written even though the kernel call itself does not
// block the way libuv's thread pool does.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file
// ---------------------------------------------------------------------------
//   * every call into the operations table goes through `__fsStreamOp`, which
//     reads the member and invokes it with `__evCall`: a member holding a
//     `common.mustCall` wrapper is a boxed function record, and `__evCall` is
//     the only spelling that reaches one with the right `arguments.length`
//     (zun#1/zun#17).
//   * the classes are named `__FsReadStream`/`__FsWriteStream` rather than
//     `ReadStream`/`WriteStream`: `src/tty/tty.ts` already declares those two
//     names at top level, and two top-level declarations of one name are a
//     compile error in a single Zun program.
//   * the option parsing cannot run after `super()` (a field read before the
//     base constructor returns) and cannot be handed `this`, so it runs once
//     into a module-private slot, `__fsStreamPending`, which the constructor
//     then drains. Construction is synchronous and single-threaded, so the
//     slot can hold exactly one record.
//   * `Number(x.length)` for every view and array length (zun#3), and
//     `__fsAsBuffer` before any member read on a `Buffer` that arrived through
//     an `any` (zun#38).
//   * `_write`/`_writev` throw `src/stream/stream.ts`' `__S_NO_IMPL` sentinel
//     when the operations table has no counterpart, which is how Node's
//     `this._write = null` is expressed where a class method cannot be
//     deleted.

// Node's `kIoDone` is a private symbol. A symbol event name is invisible to
// `Object.getOwnPropertySymbols` here (zun#32's remaining half), so the name
// is a string no program would pick.
const __FS_IO_DONE: string = "__fs.kIoDone";

// The one-record hand-off from the option parsing to the constructor body.
const __fsStreamPending: any = { settings: undefined };

function __fsStreamStash(settings: any): any {
  __fsStreamPending.settings = settings;
  return settings;
}

function __fsStreamDrain(): any {
  const settings: any = __fsStreamPending.settings;
  __fsStreamPending.settings = undefined;
  return settings;
}

// ---------------------------------------------------------------------------
// The operations table
// ---------------------------------------------------------------------------

// `options.fs || fs`. The default is the module object itself, not a private
// copy of the functions, because reaching them *through* it is observable:
// Node's own test-fs-read-stream-patch-open.js replaces `fs.open` and expects
// the stream to call the replacement.
function __fsStreamOpsOf(options: any): any {
  if (options === undefined || options === null) return fs;
  const given: any = options.fs;
  if (given === undefined || given === null) return fs;
  return given;
}

// Read one operation off the table and call it. `name` is reported the way
// Node reports it (`options.fs.read`), and a non-function raises before any
// descriptor is touched.
function __fsStreamOp(ops: any, name: string, args: any[]): any {
  const fn: any = ops[name];
  __fsValidateFunction(fn, "options.fs." + name);
  return __evCall(fn, args);
}

function __fsStreamHasOp(ops: any, name: string): boolean {
  const fn: any = ops[name];
  return fn !== undefined && fn !== null;
}

// `PromisePrototypeThen(p, onOk, onErr)`. A `then` reaction has to be a bare
// function value in this engine (a boxed record is dropped by `promiseThen`),
// so both arms are function expressions written at the call site.
function __fsStreamThen(promise: any, onOk: any, onErr: any): void {
  promise.then(
    function (value: any): void {
      __evCall(onOk, [value]);
    },
    function (error: any): void {
      __evCall(onErr, [error]);
    },
  );
}

// `FileHandleOperations(handle)` — the table a stream built over a
// `FileHandle` uses. Each entry turns the handle's promise back into the
// callback shape the stream expects.
function __fsStreamHandleOps(handle: any): any {
  return {
    open(path: any, flags: any, mode: any, cb: any): void {
      throw new ERR_METHOD_NOT_IMPLEMENTED("open()");
    },
    close(fd: any, cb: any): void {
      __fsStreamThen(
        handle.close(),
        function (): void {
          __evCall(cb, []);
        },
        function (err: any): void {
          __evCall(cb, [err]);
        },
      );
    },
    fsync(fd: any, cb: any): void {
      __fsStreamThen(
        handle.sync(),
        function (): void {
          __evCall(cb, []);
        },
        function (err: any): void {
          __evCall(cb, [err]);
        },
      );
    },
    read(fd: any, buf: any, offset: any, length: any, pos: any, cb: any): void {
      __fsStreamThen(
        handle.read(buf, offset, length, pos),
        function (r: any): void {
          __evCall(cb, [null, Number(r.bytesRead), r.buffer]);
        },
        function (err: any): void {
          __evCall(cb, [err, 0, buf]);
        },
      );
    },
    write(fd: any, buf: any, offset: any, length: any, pos: any, cb: any): void {
      __fsStreamThen(
        handle.write(buf, offset, length, pos),
        function (r: any): void {
          __evCall(cb, [null, Number(r.bytesWritten), r.buffer]);
        },
        function (err: any): void {
          __evCall(cb, [err, 0, buf]);
        },
      );
    },
    writev(fd: any, buffers: any, pos: any, cb: any): void {
      __fsStreamThen(
        handle.writev(buffers, pos),
        function (r: any): void {
          __evCall(cb, [null, Number(r.bytesWritten), r.buffers]);
        },
        function (err: any): void {
          __evCall(cb, [err, 0, buffers]);
        },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Shared construction and teardown
// ---------------------------------------------------------------------------

// `Readable`/`Writable` call `_construct` **from their own constructor**
// (`__sTryConstruct`), which in a class means before the subclass's field
// initialisers and constructor body have run — so `this.__fsOps`, `this.path`
// and `this.flags` are all still `undefined` there. Node has the same
// structure and does not have the problem, because its `ReadStream` is a
// function-constructor that assigns its fields *before* calling
// `ReflectApply(Readable, this, [options])`, which a class cannot do.
//
// The work is therefore handed to the next tick. That is free: the stream
// state is already `constructed: false`, so nothing reads from it until the
// callback fires, and the real `open` is a `process.nextTick` delivery
// anyway.
function __fsStreamDeferConstruct(stream: any, callback: any): void {
  const self: any = stream;
  __processNextTick(function (): void {
    __fsStreamConstruct(self, callback);
  });
}

// `_construct` for both classes: a stream built over a descriptor is ready at
// once, a stream built over a path opens it through the operations table, and
// a stream that grew its own `open` (the node-0.x compatibility shape) is
// driven through the `'open'`/`'error'` events that method emits.
function __fsStreamConstruct(stream: any, callback: any): void {
  if (typeof stream.fd === "number") {
    __evCall(callback, []);
    return;
  }
  if (__evIsFn(stream.open)) {
    __fsStreamDriveOwnOpen(stream, callback);
    return;
  }
  __fsStreamOp(stream.__fsOps, "open", [
    stream.path,
    stream.flags,
    stream.mode,
    function (er: any, fd: any): void {
      if (er !== undefined && er !== null) {
        __evCall(callback, [er]);
        return;
      }
      stream.fd = Number(fd);
      __evCall(callback, []);
      stream.emit("open", stream.fd);
      stream.emit("ready");
    },
  ]);
}

// Node swaps `stream.emit` for a shim that watches for the first
// `'open'`/`'error'` and then restores it. Replacing a method on an instance
// does not survive this engine (zun#19), so the same effect is had with a
// pair of one-shot listeners installed *before* `open()` is called — which
// keeps the ordering the shim produces, because `prependOnceListener` puts
// them ahead of whatever the program registered.
function __fsStreamDriveOwnOpen(stream: any, callback: any): void {
  const done: any = { called: false };
  stream.prependOnceListener("open", function (): void {
    if (done.called === true) return;
    done.called = true;
    __evCall(callback, []);
  });
  stream.prependOnceListener("error", function (err: any): void {
    if (done.called === true) return;
    done.called = true;
    __evCall(callback, [err]);
  });
  __evCall(stream.open, []);
}

// `close(stream, err, cb)` — flush first when `options.flush` asked for it,
// then close the descriptor and report the first error of the two.
function __fsStreamClose(stream: any, err: any, cb: any): void {
  const fd: any = stream.fd;
  // Node's guard is `if (!stream.fd)`, so descriptor 0 takes this arm there
  // too — a stream over stdin never closes it.
  if (fd === null || fd === undefined || fd === false || fd === 0) {
    __evCall(cb, [err]);
    return;
  }
  if (stream.flush === true) {
    __fsStreamOp(stream.__fsOps, "fsync", [
      fd,
      function (flushErr: any): void {
        __fsStreamCloseFd(
          stream,
          err !== undefined && err !== null ? err : flushErr,
          cb,
        );
      },
    ]);
    return;
  }
  __fsStreamCloseFd(stream, err, cb);
}

function __fsStreamCloseFd(stream: any, err: any, cb: any): void {
  const fd: any = stream.fd;
  __fsStreamOp(stream.__fsOps, "close", [
    fd,
    function (er: any): void {
      __evCall(cb, [er !== undefined && er !== null ? er : err]);
    },
  ]);
  stream.fd = null;
}

// `_destroy` for both classes: a descriptor is not safe to close under a
// pending read or write, so a stream that is mid-I/O waits for the private
// `kIoDone` event first.
function __fsStreamDestroy(stream: any, err: any, cb: any): void {
  if (stream.__fsIo === true) {
    stream.once(__FS_IO_DONE, function (er: any): void {
      __fsStreamClose(stream, err !== undefined && err !== null ? err : er, cb);
    });
    return;
  }
  __fsStreamClose(stream, err, cb);
}

// `importFd`, writing into a plain carrier rather than into the stream, so
// that it can run before `super()`.
function __fsStreamImportFd(carrier: any, options: any): any {
  const given: any = options.fd;
  if (typeof given === "number") {
    carrier.__ops = __fsStreamOpsOf(options);
    return given;
  }
  if (given !== null && typeof given === "object" && typeof given.fd === "number") {
    if (options.fs !== undefined && options.fs !== null) {
      // A FileHandle is not supported with custom fs operations.
      throw new ERR_METHOD_NOT_IMPLEMENTED("FileHandle with fs");
    }
    carrier.__handle = given;
    carrier.__ops = __fsStreamHandleOps(given);
    return given.fd;
  }
  throw new ERR_INVALID_ARG_TYPE("options.fd", ["number", "FileHandle"], given);
}

// `toPathIfFileURL(path)` — a `file:` URL becomes its path, anything else is
// left for `validatePath` to judge.
function __fsStreamPathOf(path: any): any {
  if (__fsIsUrl(path)) return __fsUrlToPath(path);
  return path;
}

// The `'close'` listener a FileHandle-backed stream puts on its handle.
function __fsStreamAdoptHandle(stream: any, handle: any): void {
  stream.__fsHandle = handle;
  const self: any = stream;
  handle.on("close", function (): void {
    self.close();
  });
}

// ---------------------------------------------------------------------------
// fs.ReadStream
// ---------------------------------------------------------------------------

// The option parsing `__FsReadStream`'s constructor runs, in Node's order so
// that the *first* bad option is the one reported. The `__`-prefixed members
// are this file's channel back into the constructor body; everything else is
// what `Readable` itself reads off the options object.
function __fsReadStreamSetup(path: any, options: any): any {
  const settings: any = { ...__fsGetOptions(options, {}) };
  // A little bit bigger buffer and water marks by default.
  if (settings.highWaterMark === undefined) settings.highWaterMark = 65536;
  if (settings.autoDestroy === undefined) settings.autoDestroy = false;

  let fd: any = null;
  let ops: any = undefined;
  if (settings.fd === undefined || settings.fd === null) {
    ops = __fsStreamOpsOf(settings);
    __fsValidateFunction(ops.open, "options.fs.open");
    // The path is ignored when `fd` is given, so it can be falsy.
    settings.__path = __fsStreamPathOf(path);
    settings.__flags = settings.flags === undefined ? "r" : settings.flags;
    settings.__mode = settings.mode === undefined ? 438 : settings.mode;
    __fsGetValidatedPath(settings.__path);
  } else {
    fd = __fsGetValidatedFd(__fsStreamImportFd(settings, settings));
    ops = settings.__ops;
    settings.__path = undefined;
    settings.__flags = "r";
    settings.__mode = 438;
  }

  settings.autoDestroy =
    settings.autoClose === undefined ? true : settings.autoClose;
  __fsValidateFunction(ops.read, "options.fs.read");
  if (settings.autoDestroy) __fsValidateFunction(ops.close, "options.fs.close");

  let pos: any = undefined;
  if (settings.start !== undefined) {
    __fsValidateInteger(settings.start, "start", 0, __FS_UINT32_MAX);
    pos = settings.start;
  }
  if (settings.end === undefined) {
    settings.end = Infinity;
  } else if (settings.end !== Infinity) {
    __fsValidateInteger(settings.end, "end", 0, __FS_UINT32_MAX);
    if (settings.start !== undefined && Number(settings.start) > Number(settings.end)) {
      throw new ERR_OUT_OF_RANGE(
        "start",
        '<= "end" (here: ' + String(settings.end) + ")",
        settings.start,
      );
    }
  }

  settings.__ops = ops;
  settings.__fd = fd;
  settings.__pos = pos;
  return settings;
}

class __FsReadStream extends Readable {
  fd: any = null;
  path: any = undefined;
  flags: any = "r";
  // `mode`/`bytesRead`/`flush` are declared `any`, not `number`/`boolean`:
  // storing an `any` that holds a float into a field declared `number`
  // panics the interpreter ("expected float, found Any",
  // crates/zun_interp/src/value.rs:157), and every one of these arrives from
  // the option record as an `any`.
  mode: any = 438;
  start: any = undefined;
  end: any = undefined;
  pos: any = undefined;
  bytesRead: any = 0;
  flush: any = false;
  __fsOps: any = undefined;
  __fsHandle: any = undefined;
  __fsIo: boolean = false;

  constructor(path?: any, options?: any) {
    super(__fsStreamStash(__fsReadStreamSetup(path, options)));
    const settings: any = __fsStreamDrain();
    this.__fsOps = settings.__ops;
    this.fd = settings.__fd;
    this.path = settings.__path;
    this.flags = settings.__flags;
    this.mode = settings.__mode;
    this.start = settings.start;
    this.end = settings.end;
    this.pos = settings.__pos;
    this.bytesRead = 0;
    this.__fsIo = false;
    if (settings.__handle !== undefined && settings.__handle !== null) {
      __fsStreamAdoptHandle(this, settings.__handle);
    }
  }

  get autoClose(): any {
    return this._readableState.autoDestroy;
  }
  set autoClose(value: any) {
    this._readableState.autoDestroy = value;
  }

  get pending(): boolean {
    return this.fd === null;
  }

  _construct(callback: any): void {
    __fsStreamDeferConstruct(this, callback);
  }

  _read(n: any): void {
    __fsReadStreamRead(this, n);
  }

  _destroy(err: any, cb: any): void {
    __fsStreamDestroy(this, err, cb);
  }

  close(cb?: any): void {
    if (__evIsFn(cb)) __sEos(this, undefined, cb);
    this.destroy();
  }
}

// `Buffer.allocUnsafeSlow(n)` with a **computed** `n`.
//
// `Buffer.alloc(size)` only compiles when `size` is an integer *literal* in
// this engine — "Buffer size must be an integer" for any binding, however it
// is typed or narrowed — and `new Uint8Array(size)` does not resolve at all.
// The one spelling that yields a view of a computed length is a slice of a
// literal-sized allocation, and a slice shares the parent's bytes, so the
// `fs.read` below fills the view the caller is handed.
const __FS_STREAM_SCRATCH: number = 65536;

function __fsStreamScratch(size: number): Buffer {
  const base: Buffer = Buffer.alloc(65536);
  if (size >= __FS_STREAM_SCRATCH) return base;
  return base.slice(0, size);
}

function __fsReadStreamRead(stream: any, n: any): void {
  const asked: number =
    stream.pos !== undefined
      ? Math.min(Number(stream.end) - Number(stream.pos) + 1, Number(n))
      : Math.min(Number(stream.end) - Number(stream.bytesRead) + 1, Number(n));

  if (asked <= 0) {
    stream.push(null);
    return;
  }

  // One scratch allocation per read, so a `highWaterMark` above it becomes
  // several reads rather than one. A `Readable` may always push fewer bytes
  // than `_read` was asked for, so this is invisible to a consumer.
  const want: number = Math.min(asked, __FS_STREAM_SCRATCH);
  const buf: Buffer = __fsStreamScratch(want);
  stream.__fsIo = true;
  __fsStreamOp(stream.__fsOps, "read", [
    stream.fd,
    buf,
    0,
    want,
    stream.pos === undefined ? null : stream.pos,
    function (er: any, bytesRead: any, got: any): void {
      stream.__fsIo = false;
      // Tell `_destroy` that it is safe to close the fd now.
      if (stream.destroyed === true) {
        stream.emit(__FS_IO_DONE, er);
        return;
      }
      if (er !== undefined && er !== null) {
        __sErrorOrDestroy(stream, er);
        return;
      }
      const count: number = Number(bytesRead);
      if (count > 0) {
        if (stream.pos !== undefined) stream.pos = Number(stream.pos) + count;
        stream.bytesRead = Number(stream.bytesRead) + count;
        let chunk: any = got;
        // Shrink to fit: Node copies rather than slices so a short read does
        // not retain the whole 64K backing store.
        if (count !== Number(__fsAsBuffer(got).length)) {
          chunk = __fsSliceOfView(got, 0, count);
        }
        stream.push(chunk);
        return;
      }
      stream.push(null);
    },
  ]);
}

// ---------------------------------------------------------------------------
// fs.WriteStream
// ---------------------------------------------------------------------------

function __fsWriteStreamSetup(path: any, options: any): any {
  const settings: any = { ...__fsGetOptions(options, {}) };
  // Only buffers are supported.
  settings.decodeStrings = true;

  let fd: any = null;
  let ops: any = undefined;
  if (settings.fd === undefined || settings.fd === null) {
    ops = __fsStreamOpsOf(settings);
    __fsValidateFunction(ops.open, "options.fs.open");
    settings.__path = __fsStreamPathOf(path);
    settings.__flags = settings.flags === undefined ? "w" : settings.flags;
    settings.__mode = settings.mode === undefined ? 438 : settings.mode;
    __fsGetValidatedPath(settings.__path);
  } else {
    fd = __fsGetValidatedFd(__fsStreamImportFd(settings, settings));
    ops = settings.__ops;
    settings.__path = undefined;
    settings.__flags = "w";
    settings.__mode = 438;
  }

  settings.autoDestroy =
    settings.autoClose === undefined ? true : settings.autoClose;

  const hasWrite: boolean = __fsStreamHasOp(ops, "write");
  const hasWritev: boolean = __fsStreamHasOp(ops, "writev");
  if (!hasWrite && !hasWritev) {
    throw new ERR_INVALID_ARG_TYPE("options.fs.write", "function", ops.write);
  }
  if (hasWrite) __fsValidateFunction(ops.write, "options.fs.write");
  if (hasWritev) __fsValidateFunction(ops.writev, "options.fs.writev");
  if (settings.autoDestroy) __fsValidateFunction(ops.close, "options.fs.close");

  let flush: any = settings.flush;
  if (flush === undefined || flush === null) {
    flush = false;
  } else {
    __fsValidateBoolean(flush, "options.flush");
    __fsValidateFunction(ops.fsync, "options.fs.fsync");
  }

  let pos: any = undefined;
  if (settings.start !== undefined) {
    __fsValidateInteger(settings.start, "start", 0, __FS_UINT32_MAX);
    pos = settings.start;
  }

  settings.__ops = ops;
  settings.__fd = fd;
  settings.__pos = pos;
  settings.__flush = flush;
  // Node nulls out whichever of `_write`/`_writev` the table cannot serve. A
  // class method cannot be deleted here, so the two flags are recorded and the
  // methods themselves throw `__S_NO_IMPL` — the sentinel `Writable` already
  // reads as "this hook does not exist".
  settings.__noWrite = !hasWrite;
  settings.__noWritev = !hasWritev;
  return settings;
}

class __FsWriteStream extends Writable {
  fd: any = null;
  path: any = undefined;
  flags: any = "w";
  // See `__FsReadStream` above for why these are `any`.
  mode: any = 438;
  start: any = undefined;
  pos: any = undefined;
  bytesWritten: any = 0;
  flush: any = false;
  __fsOps: any = undefined;
  __fsHandle: any = undefined;
  __fsIo: boolean = false;
  __fsNoWrite: any = false;
  __fsNoWritev: any = false;

  constructor(path?: any, options?: any) {
    super(__fsStreamStash(__fsWriteStreamSetup(path, options)));
    const settings: any = __fsStreamDrain();
    this.__fsOps = settings.__ops;
    this.fd = settings.__fd;
    this.path = settings.__path;
    this.flags = settings.__flags;
    this.mode = settings.__mode;
    this.start = settings.start;
    this.pos = settings.__pos;
    this.bytesWritten = 0;
    this.flush = settings.__flush;
    this.__fsIo = false;
    this.__fsNoWrite = settings.__noWrite;
    this.__fsNoWritev = settings.__noWritev;
    if (settings.__handle !== undefined && settings.__handle !== null) {
      __fsStreamAdoptHandle(this, settings.__handle);
    }
    if (settings.encoding !== undefined && settings.encoding !== null) {
      this.setDefaultEncoding(settings.encoding);
    }
  }

  get autoClose(): any {
    return this._writableState.autoDestroy;
  }
  set autoClose(value: any) {
    this._writableState.autoDestroy = value;
  }

  get pending(): boolean {
    return this.fd === null;
  }

  _construct(callback: any): void {
    __fsStreamDeferConstruct(this, callback);
  }

  _write(data: any, encoding: any, cb: any): any {
    if (this.__fsNoWrite === true) throw __S_NO_IMPL;
    __fsWriteStreamWrite(this, __fsStreamBytes(this, data, encoding), cb);
    return undefined;
  }

  _writev(data: any, cb: any): any {
    if (this.__fsNoWritev === true) throw __S_NO_IMPL;
    __fsWriteStreamWritev(this, data, cb);
    return undefined;
  }

  _destroy(err: any, cb: any): void {
    __fsStreamDestroy(this, err, cb);
  }

  close(cb?: any): void {
    if (cb !== undefined && cb !== null) {
      if (this.closed === true) {
        __processNextTick(cb);
        return;
      }
      this.on("close", cb);
    }
    // If we are not autoClosing, we should call destroy on 'finish'.
    if (this.autoClose !== true) {
      const self: any = this;
      this.on("finish", function (): void {
        self.destroy();
      });
    }
    // `end()` rather than `destroy()`, because of nodejs/node#2006.
    this.end();
  }

  // There is no shutdown() for files.
  destroySoon(): any {
    return this.end();
  }
}

// A chunk as the bytes a descriptor takes.
//
// Node sets `decodeStrings: true` on both streams, so `Writable` hands `_write`
// a `Buffer` and never a string. `src/stream/stream.ts` deliberately keeps a
// written string *as a string* and only tags its encoding `"buffer"` (see
// `__sWriteImpl`), so the conversion happens here instead, against the
// encoding the write carried or the stream's `defaultEncoding`. Without it the
// string reaches `__fsAsBuffer`, whose cast is a lie for a string, and reading
// `.length` off it **abandons the running frame with no exception at all** —
// the caller resumes as though the call had returned, which in
// `__sHookWrite`'s `return stream._write(...)` looks exactly like "this stream
// has no `_write`".
function __fsStreamBytes(stream: any, chunk: any, encoding: any): any {
  if (typeof chunk !== "string") return chunk;
  const text: string = String(chunk);
  let enc: any = encoding;
  if (enc === undefined || enc === null || enc === "buffer" || enc === "") {
    const state: any = stream._writableState;
    enc = state === undefined || state === null ? "utf8" : state.defaultEncoding;
  }
  if (enc === undefined || enc === null || enc === "buffer" || enc === "") enc = "utf8";
  return Buffer.from(text, String(enc));
}

// `writeAll` — a short write is retried, up to five times with no progress.
function __fsWriteStreamWrite(stream: any, data: any, cb: any): void {
  const length: number = Number(__fsAsBuffer(data).length);
  stream.__fsIo = true;
  __fsWriteStreamWriteAll(stream, data, length, stream.pos, cb, 0);
  if (stream.pos !== undefined) stream.pos = Number(stream.pos) + length;
}

function __fsWriteStreamWriteAll(
  stream: any,
  data: any,
  size: any,
  pos: any,
  cb: any,
  retries: any,
): void {
  __fsStreamOp(stream.__fsOps, "write", [
    stream.fd,
    data,
    0,
    size,
    pos === undefined ? null : pos,
    function (er: any, bytesWritten: any, buffer: any): void {
      let failure: any = er;
      let written: number = Number(bytesWritten);
      // No data currently available; the operation is retried later.
      if (failure !== undefined && failure !== null && failure.code === "EAGAIN") {
        failure = null;
        written = 0;
      }
      const failed: boolean = failure !== undefined && failure !== null;
      if (stream.destroyed === true || failed) {
        stream.__fsIo = false;
        const reported: any = failed ? failure : new ERR_STREAM_DESTROYED("write");
        __evCall(cb, [reported]);
        if (stream.destroyed === true) stream.emit(__FS_IO_DONE, reported);
        return;
      }
      stream.bytesWritten = Number(stream.bytesWritten) + written;
      const left: number = Number(size) - written;
      const attempts: number = written > 0 ? 0 : Number(retries) + 1;
      if (attempts > 5) {
        stream.__fsIo = false;
        __evCall(cb, [new __FsSystemError("write failed")]);
        return;
      }
      if (left > 0) {
        __fsWriteStreamWriteAll(
          stream,
          __fsSliceOfView(buffer, written, left),
          left,
          pos === undefined ? undefined : Number(pos) + written,
          cb,
          attempts,
        );
        return;
      }
      stream.__fsIo = false;
      __evCall(cb, []);
    },
  ]);
}

function __fsWriteStreamWritev(stream: any, data: any, cb: any): void {
  const count: number = Number(data.length);
  const chunks: any[] = [];
  let size: number = 0;
  for (let i = 0; i < count; i++) {
    const entry: any = data[i];
    const chunk: any = __fsStreamBytes(stream, entry.chunk, entry.encoding);
    chunks.push(chunk);
    size = size + Number(__fsAsBuffer(chunk).length);
  }
  stream.__fsIo = true;
  __fsStreamOp(stream.__fsOps, "writev", [
    stream.fd,
    chunks,
    stream.pos === undefined ? null : stream.pos,
    function (er: any, bytesWritten: any, buffers: any): void {
      stream.__fsIo = false;
      let failure: any = er;
      if (failure !== undefined && failure !== null && failure.code === "EAGAIN") {
        failure = null;
      }
      const failed: boolean = failure !== undefined && failure !== null;
      if (stream.destroyed === true || failed) {
        const reported: any = failed ? failure : new ERR_STREAM_DESTROYED("writev");
        __evCall(cb, [reported]);
        if (stream.destroyed === true) stream.emit(__FS_IO_DONE, reported);
        return;
      }
      stream.bytesWritten = Number(stream.bytesWritten) + Number(bytesWritten);
      __evCall(cb, []);
    },
  ]);
  if (stream.pos !== undefined) stream.pos = Number(stream.pos) + size;
}

// `ERR_SYSTEM_ERROR`, which only the five-retry give-up path raises.
class __FsSystemError extends NodeError {
  constructor(message: string) {
    super("ERR_SYSTEM_ERROR", message);
  }
}

// ---------------------------------------------------------------------------
// Installing into `fs` and `fs.promises`
// ---------------------------------------------------------------------------

fs.ReadStream = __FsReadStream;
fs.WriteStream = __FsWriteStream;
// `fs.FileReadStream`/`fs.FileWriteStream` are Node's node-0.x aliases, still
// exported and still the same two classes.
fs.FileReadStream = __FsReadStream;
fs.FileWriteStream = __FsWriteStream;

__fsStreamHooks.createReadStream = function (path: any, options?: any): any {
  return new __FsReadStream(path, options);
};
__fsStreamHooks.createWriteStream = function (path: any, options?: any): any {
  return new __FsWriteStream(path, options);
};
// `filehandle.createReadStream()` / `createWriteStream()` are the same two
// classes over `{ fd: handle }`, which is how `lib/internal/fs/promises.js`
// spells them.
__fsStreamHooks.handleReadStream = function (handle: any, options?: any): any {
  const settings: any = { ...__fsGetOptions(options, {}) };
  settings.fd = handle;
  return new __FsReadStream(undefined, settings);
};
__fsStreamHooks.handleWriteStream = function (handle: any, options?: any): any {
  const settings: any = { ...__fsGetOptions(options, {}) };
  settings.fd = handle;
  return new __FsWriteStream(undefined, settings);
};

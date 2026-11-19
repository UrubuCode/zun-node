// node:dgram — UDP sockets, as Zun TypeScript over the shared I/O loop.
//
// This is the second consumer of `src/io/` (the first is `src/net/net.ts`) and
// follows the same split: the syscalls are natives in `src/io/udp.rs`
// (`ioUdp*`, published under `node:io`), and everything Node-shaped is here —
// `createSocket`, `Socket` as an `EventEmitter`, the bind/connect state
// machines, the send queue that holds a `send()` until the socket is bound, the
// argument cascades of `send()` and the error classes.
//
// Where Node's `lib/dgram.js` talks to a libuv `UDP` handle, this file talks to
// a handle *number* in the Rust table (see `src/io/mod.rs`). The socket itself
// is opened in the constructor (as Node creates its `UDP` handle there) but is
// only registered with the readiness loop at `bind()` time, because that is
// when libuv's handle becomes active: an unbound socket does not keep the
// process alive, a bound and receiving one does until `unref()`.
//
// Names: this file shares one program with `src/net/net.ts` (it uses its IP
// grammar, port validation and default resolver), so every top-level name here
// is `__dgram…`/`__Dgram…`, and the class is `__DgramSocket` — `Socket` is net's.
// `__node_dgram.Socket` is the public spelling.
//
// Engine workarounds follow net.ts: `any` everywhere a value crosses a
// closure, `Number(x.length)`, function values handed through `any` are boxed
// with `__evBox` (zun#17), callbacks are `function` expressions.

const __DGRAM_UNBOUND: number = 0;
const __DGRAM_BINDING: number = 1;
const __DGRAM_BOUND: number = 2;

const __DGRAM_DISCONNECTED: number = 0;
const __DGRAM_CONNECTING: number = 1;
const __DGRAM_CONNECTED: number = 2;

// How many datagrams one readable event drains before yielding to the loop.
const __DGRAM_DRAIN: number = 128;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class ERR_SOCKET_ALREADY_BOUND extends NodeError {
  constructor() {
    super("ERR_SOCKET_ALREADY_BOUND", "Socket is already bound");
  }
}

class ERR_SOCKET_BAD_TYPE extends NodeTypeError {
  constructor() {
    super("ERR_SOCKET_BAD_TYPE", "Bad socket type specified. Valid types are: udp4, udp6");
  }
}

class ERR_SOCKET_BAD_BUFFER_SIZE extends NodeTypeError {
  constructor() {
    super("ERR_SOCKET_BAD_BUFFER_SIZE", "Buffer size must be a positive integer");
  }
}

class ERR_SOCKET_DGRAM_IS_CONNECTED extends NodeError {
  constructor() {
    super("ERR_SOCKET_DGRAM_IS_CONNECTED", "Already connected");
  }
}

class ERR_SOCKET_DGRAM_NOT_CONNECTED extends NodeError {
  constructor() {
    super("ERR_SOCKET_DGRAM_NOT_CONNECTED", "Not connected");
  }
}

class ERR_SOCKET_DGRAM_NOT_RUNNING extends NodeError {
  constructor() {
    super("ERR_SOCKET_DGRAM_NOT_RUNNING", "Not running");
  }
}

class __DgramBufferOutOfBounds extends NodeRangeError {
  constructor(name: string) {
    super("ERR_BUFFER_OUT_OF_BOUNDS", '"' + name + '" is outside of buffer bounds');
  }
}

// `ERR_SOCKET_BUFFER_SIZE`: a `SystemError` carrying the failed call's context.
class ERR_SOCKET_BUFFER_SIZE extends NodeError {
  info: any = null;
  errno: any = 0;
  syscall: any = "";
  constructor(ctx: any) {
    super(
      "ERR_SOCKET_BUFFER_SIZE",
      "Could not get or set buffer size: " +
        String(ctx.syscall) +
        " returned " +
        String(ctx.code) +
        " (" +
        String(ctx.message) +
        ")",
    );
    this.info = ctx;
    this.errno = ctx.errno;
    this.syscall = ctx.syscall;
    this.name = "SystemError";
  }
}

// Node's `ErrnoException`/`ExceptionWithHostPort`: a plain `Error` whose
// message is `<syscall> <CODE>[ <address>[:<port>]]`.
class __DgramException extends Error {
  errno: any = 0;
  code: any = "";
  syscall: any = "";
  address: any = undefined;
  port: any = undefined;
  constructor(message: string) {
    super(message);
  }
}

function __dgramException(info: any, syscall: string, address?: any, port?: any): any {
  let message: string = syscall + " " + String(info.code);
  const hasAddress: boolean = address !== undefined && address !== null && String(address) !== "";
  if (hasAddress) {
    message = message + " " + String(address);
    if (port !== undefined && port !== null && port !== 0) message = message + ":" + String(port);
  }
  const error: any = new __DgramException(message);
  error.errno = Number(info.errno);
  error.code = String(info.code);
  error.syscall = syscall;
  if (hasAddress) {
    error.address = String(address);
    if (port !== undefined && port !== null && port !== 0) error.port = port;
  }
  return error;
}

// A synthetic libuv error, for the failures Node's binding reports without any
// syscall having been made (an unbound handle is `EBADF`).
function __dgramEbadf(syscall: string): any {
  const ops: any = __ioOps();
  // Ask the native side for its `EBADF` so the errno matches the platform.
  ops.udpRecv(0);
  const info: any = __ioLastError();
  return __dgramException(info, syscall);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function __dgramRequireIo(): any {
  const ops: any = __ioOps();
  if (ops === null || ops === undefined) {
    throw new NodeError(
      "ERR_METHOD_NOT_IMPLEMENTED",
      "node:dgram needs the zun-node native extension (run with --ext)",
    );
  }
  return ops;
}

function __dgramIsView(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  return ArrayBuffer.isView(value);
}

function __dgramValidateString(value: any, name: string): void {
  if (typeof value !== "string") {
    throw new ERR_INVALID_ARG_TYPE(name, "string", value);
  }
}

function __dgramBytesType(): string[] {
  return ["Buffer", "TypedArray", "DataView", "string"];
}

// A byte view read through `any` is opaque in this engine; only a value passed
// into a `Buffer`-typed binding can be read (see src/buffer/buffer.ts). So the
// conversions below bind the value to a typed local first.
function __dgramToBuffer(value: any): Buffer {
  if (typeof value === "string") {
    const text: string = value;
    return Buffer.from(text);
  }
  if (Buffer.isBuffer(value)) {
    const direct: Buffer = value;
    return direct;
  }
  // A `DataView` is read byte by byte through a typed binding.
  if (value instanceof DataView) {
    const dv: DataView = value;
    const raw: number[] = [];
    const n: number = Number(dv.byteLength);
    for (let i = 0; i < n; i++) raw.push(dv.getUint8(i));
    return Buffer.from(raw);
  }
  // A `Uint8Array` (or other typed view) is copied; a wider view is read as
  // its element sequence, which is a documented deviation.
  const view: Uint8Array = value;
  const bytes: number[] = [];
  const size: number = Number(view.length);
  for (let i = 0; i < size; i++) bytes.push(Number(view[i]));
  return Buffer.from(bytes);
}

// Node's `sliceBuffer`.
function __dgramSlice(buffer: any, offset: any, length: any): any {
  if (typeof buffer !== "string" && !__dgramIsView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE("buffer", __dgramBytesType(), buffer);
  }
  const buf: Buffer = __dgramToBuffer(buffer);
  const total: number = Number(buf.length);
  const start: number = Number(offset) >>> 0;
  const count: number = Number(length) >>> 0;
  if (start > total) throw new __DgramBufferOutOfBounds("offset");
  if (start + count > total) throw new __DgramBufferOutOfBounds("length");
  return buf.subarray(start, start + count);
}

// Node's `fixBufferList`: every element as a `Buffer`, or null when one is not
// a byte view.
function __dgramFixList(list: any): any {
  const out: Buffer[] = [];
  for (const item of list) {
    if (typeof item !== "string" && !__dgramIsView(item)) return null;
    out.push(__dgramToBuffer(item));
  }
  return out;
}

function __dgramState(self: any): any {
  return self._dgState;
}

// `healthCheck`: the socket must not be closed.
function __dgramHealth(self: any): void {
  if (Number(self._dgState.handle) === 0) throw new ERR_SOCKET_DGRAM_NOT_RUNNING();
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

// `lookup4`/`lookup6` of Node: the user's `lookup` (or `dns.lookup`) asked for
// this socket's family, with the loopback as the address when none was given.
function __dgramLookup(self: any, address: any, callback: any): void {
  const facade: any = self._dgState.facade;
  if (facade !== undefined && facade !== null) {
    facade.lookup(address, callback);
    return;
  }
  __dgramDefaultLookup(self, address, callback);
}

function __dgramDefaultLookup(self: any, address: any, callback: any): void {
  const state: any = self._dgState;
  const family: number = state.ipv6 === true ? 6 : 4;
  let name: string = String(address === undefined || address === null ? "" : address);
  if (name === "") name = family === 6 ? "::1" : "127.0.0.1";
  if (state.lookup !== null && state.lookup !== undefined) {
    state.lookup(name, family, callback);
    return;
  }
  // Node's `defaultLookup` reads `dns.lookup` at call time, so a test that
  // replaces it is honoured whenever `dns` is part of the program.
  const dnsModule: any = (globalThis as any).__zunNodeDns;
  if (dnsModule !== undefined && dnsModule !== null) {
    dnsModule.lookup(name, family, callback);
    return;
  }
  const literal: number = __netIsIP(name);
  if (literal !== 0) {
    __netTick(function (): void {
      __netInvoke(callback, [null, name, literal]);
    });
    return;
  }
  __netDefaultLookup(name, { family: family }, callback);
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------

class __DgramSocket extends EventEmitter {
  type: any = "";
  _dgState: any = null;
  _dgView: any = null;

  constructor(type?: any, listener?: any) {
    super();
    let kind: any = type;
    let options: any = null;
    let lookup: any = null;
    if (kind !== null && kind !== undefined && typeof kind === "object") {
      options = kind;
      kind = options.type;
      if (options.lookup !== undefined) {
        if (!__netIsFn(options.lookup)) {
          throw new ERR_INVALID_ARG_TYPE("lookup", "function", options.lookup);
        }
        lookup = options.lookup;
      }
    }
    if (kind !== "udp4" && kind !== "udp6") throw new ERR_SOCKET_BAD_TYPE();
    const ops: any = __dgramRequireIo();
    if (options !== null) {
      if (options.recvBufferSize !== undefined && typeof options.recvBufferSize !== "number") {
        throw new ERR_INVALID_ARG_TYPE("options.recvBufferSize", "number", options.recvBufferSize);
      }
      if (options.sendBufferSize !== undefined && typeof options.sendBufferSize !== "number") {
        throw new ERR_INVALID_ARG_TYPE("options.sendBufferSize", "number", options.sendBufferSize);
      }
      if (__dgramTruthy(options.receiveBlockList) && !(options.receiveBlockList instanceof BlockList)) {
        throw new ERR_INVALID_ARG_TYPE("options.receiveBlockList", "net.BlockList", options.receiveBlockList);
      }
      if (__dgramTruthy(options.sendBlockList) && !(options.sendBlockList instanceof BlockList)) {
        throw new ERR_INVALID_ARG_TYPE("options.sendBlockList", "net.BlockList", options.sendBlockList);
      }
    }
    const ipv6: boolean = kind === "udp6";
    const opened: any = ops.udpOpen(ipv6 ? 1 : 0);
    if (__ioFailed(opened)) {
      throw __dgramException(__ioLastError(), "socket");
    }
    this.type = kind;
    if (__netIsFn(listener)) this.on("message", listener);
    let recvSize: any = undefined;
    let sendSize: any = undefined;
    if (options !== null) {
      recvSize = options.recvBufferSize;
      sendSize = options.sendBufferSize;
    }
    this._dgState = {
      handle: Number(__ioFields(opened)[0]),
      ipv6: ipv6,
      lookup: lookup,
      receiving: false,
      registered: false,
      unrefd: false,
      bindState: __DGRAM_UNBOUND,
      connectState: __DGRAM_DISCONNECTED,
      queue: undefined,
      // Sends the kernel refused with "would block", flushed on writable.
      blocked: [],
      reuseAddr: options !== null && options.reuseAddr === true,
      reusePort: options !== null && options.reusePort === true,
      ipv6Only: options !== null && options.ipv6Only === true,
      recvBufferSize: recvSize,
      sendBufferSize: sendSize,
      receiveBlockList: options !== null && __dgramTruthy(options.receiveBlockList) ? options.receiveBlockList : null,
      sendBlockList: options !== null && __dgramTruthy(options.sendBlockList) ? options.sendBlockList : null,
    };
    __dgramInstallFacade(this);
    // `Socket.prototype[SymbolAsyncDispose]`: close, unless already closed.
    // An own property, because a class computed key must be a literal
    // well-known symbol the checker recognises (zun#31).
    const disposing: __DgramSocket = this;
    (this as any)[Symbol.asyncDispose] = function (): any {
      return new Promise((resolve: any, reject: any) => {
        if (Number(disposing._dgState.handle) === 0) {
          resolve(undefined);
          return;
        }
        try {
          disposing.close(function (): void {
            resolve(undefined);
          });
        } catch (error) {
          reject(error);
        }
      });
    };
    if (options !== null && options.ipv6Only === true && !ipv6) {
      this._dgState.handle = 0;
      ops.close(Number(__ioFields(opened)[0]));
      throw new ERR_INVALID_ARG_VALUE("options.ipv6Only", options.ipv6Only, "is only valid for udp6 sockets");
    }
    if (options !== null && options.signal !== undefined) {
      __dgramListenSignal(this, options.signal);
    }
  }

  bind(a?: any, b?: any, c?: any): any {
    return __dgramBind(this, a, b, c);
  }

  connect(port?: any, address?: any, callback?: any): void {
    __dgramConnect(this, port, address, callback);
  }

  disconnect(): void {
    const state: any = this._dgState;
    __dgramHealth(this);
    if (state.connectState !== __DGRAM_CONNECTED) throw new ERR_SOCKET_DGRAM_NOT_CONNECTED();
    const result: any = __dgramRequireIo().udpDisconnect(Number(state.handle));
    if (__ioFailed(result)) throw __dgramException(__ioLastError(), "connect");
    state.connectState = __DGRAM_DISCONNECTED;
  }

  remoteAddress(): any {
    const state: any = this._dgState;
    __dgramHealth(this);
    if (state.connectState !== __DGRAM_CONNECTED) throw new ERR_SOCKET_DGRAM_NOT_CONNECTED();
    const result: any = __dgramRequireIo().peerName(Number(state.handle));
    if (__ioFailed(result)) throw __dgramException(__ioLastError(), "getpeername");
    const parts: string[] = __ioFields(result);
    return { address: parts[0], family: parts[2], port: Number(parts[1]) };
  }

  address(): any {
    const state: any = this._dgState;
    __dgramHealth(this);
    if (state.bindState !== __DGRAM_BOUND) throw __dgramEbadf("getsockname");
    const result: any = __dgramRequireIo().sockName(Number(state.handle));
    if (__ioFailed(result)) throw __dgramException(__ioLastError(), "getsockname");
    const parts: string[] = __ioFields(result);
    return { address: parts[0], family: parts[2], port: Number(parts[1]) };
  }

  send(a?: any, b?: any, c?: any, d?: any, e?: any, f?: any): void {
    __dgramSend(this, a, b, c, d, e, f);
  }

  close(callback?: any): any {
    return __dgramClose(this, callback);
  }

  ref(): any {
    const state: any = this._dgState;
    state.unrefd = false;
    if (Number(state.handle) !== 0 && state.registered === true) __ioRef(Number(state.handle));
    return this;
  }

  unref(): any {
    const state: any = this._dgState;
    state.unrefd = true;
    if (Number(state.handle) !== 0 && state.registered === true) __ioUnref(Number(state.handle));
    return this;
  }

  setBroadcast(arg: any): void {
    __dgramOption(this, "setBroadcast", "broadcast", arg ? 1 : 0);
  }

  setTTL(ttl: any): any {
    if (typeof ttl !== "number") throw new ERR_INVALID_ARG_TYPE("ttl", "number", ttl);
    __dgramRangedOption(this, "setTTL", "ttl", ttl);
    return ttl;
  }

  setMulticastTTL(ttl: any): any {
    if (typeof ttl !== "number") throw new ERR_INVALID_ARG_TYPE("ttl", "number", ttl);
    __dgramRangedOption(this, "setMulticastTTL", "multicastTtl", ttl);
    return ttl;
  }

  setMulticastLoopback(arg: any): any {
    __dgramOption(this, "setMulticastLoopback", "multicastLoop", arg ? 1 : 0);
    return arg;
  }

  setMulticastInterface(interfaceAddress: any): void {
    __dgramHealth(this);
    __dgramValidateString(interfaceAddress, "interfaceAddress");
    if (this._dgState.bindState !== __DGRAM_BOUND) throw __dgramEbadf("setMulticastInterface");
    const result: any = __dgramRequireIo().udpMulticastIf(
      Number(this._dgState.handle),
      String(interfaceAddress),
    );
    if (__ioFailed(result)) throw __dgramException(__ioLastError(), "setMulticastInterface");
  }

  addMembership(multicastAddress?: any, interfaceAddress?: any): void {
    __dgramMembership(this, true, "addMembership", multicastAddress, interfaceAddress);
  }

  dropMembership(multicastAddress?: any, interfaceAddress?: any): void {
    __dgramMembership(this, false, "dropMembership", multicastAddress, interfaceAddress);
  }

  addSourceSpecificMembership(sourceAddress?: any, groupAddress?: any, interfaceAddress?: any): void {
    __dgramSourceMembership(this, true, "addSourceSpecificMembership", sourceAddress, groupAddress, interfaceAddress);
  }

  dropSourceSpecificMembership(sourceAddress?: any, groupAddress?: any, interfaceAddress?: any): void {
    __dgramSourceMembership(this, false, "dropSourceSpecificMembership", sourceAddress, groupAddress, interfaceAddress);
  }

  getRecvBufferSize(): any {
    return __dgramBufferSize(this, 0, true);
  }

  getSendBufferSize(): any {
    return __dgramBufferSize(this, 0, false);
  }

  setRecvBufferSize(size: any): void {
    __dgramBufferSize(this, size, true);
  }

  setSendBufferSize(size: any): void {
    __dgramBufferSize(this, size, false);
  }

  getSendQueueSize(): any {
    // libuv's Windows backend never adds to `send_queue_size` (`uv__send` in
    // src/win/udp.c hands the request to the kernel), so it reads 0 there.
    if (process.platform === "win32") return 0;
    let total = 0;
    for (const entry of this._dgState.blocked) total += Number(entry.size);
    return total;
  }

  getSendQueueCount(): any {
    return Number(this._dgState.blocked.length);
  }

  // Node's exported `sendto`: `send` with every argument required.
  sendto(buffer?: any, offset?: any, length?: any, port?: any, address?: any, callback?: any): void {
    if (typeof offset !== "number") throw new ERR_INVALID_ARG_TYPE("offset", "number", offset);
    if (typeof length !== "number") throw new ERR_INVALID_ARG_TYPE("length", "number", length);
    if (typeof port !== "number") throw new ERR_INVALID_ARG_TYPE("port", "number", port);
    __dgramValidateString(address, "address");
    __dgramSend(this, buffer, offset, length, port, address, callback);
  }
}

// ---------------------------------------------------------------------------
// AbortSignal
// ---------------------------------------------------------------------------

function __dgramListenSignal(self: any, signal: any): void {
  if (!__netIsObj(signal) || !__netIsFn(signal.addEventListener)) {
    throw new ERR_INVALID_ARG_TYPE("options.signal", "AbortSignal", signal);
  }
  if (signal.aborted === true) {
    self.close();
    return;
  }
  // A raw function, not an `__evBox`ed one: the signal is an engine built-in.
  const onAbort: any = function (): void {
    if (Number(self._dgState.handle) !== 0) self.close();
  };
  // The engine's `addEventListener` takes exactly two arguments, so there is
  // no `{ once: true }`; the close handler below removes the listener instead.
  signal.addEventListener("abort", onAbort);
  self.once(
    "close",
    __evBox(function (): void {
      signal.removeEventListener("abort", onAbort);
    }),
  );
}

// ---------------------------------------------------------------------------
// The handle facade (`socket[kStateSymbol].handle`)
// ---------------------------------------------------------------------------
//
// Node keeps the libuv `UDP` handle in `socket[kStateSymbol].handle`, and its
// own tests reach through it: they replace `handle.lookup`/`handle.send`, call
// `handle.onmessage` and read `handle.fd`. The real handle here is a number in
// the Rust table, so the socket carries a small object with the same members
// and routes its own lookup, send and receive-error paths through it, which is
// what makes a test's replacement take effect.

// Node's `kStateSymbol` is a `Symbol`; here it is the *name* of an ordinary
// property, because a class instance that gains a symbol-keyed member (by
// `defineProperty`, assignment or a computed class member) stops resolving
// `this.<field>` inside its own methods ("Cannot read private member"). Every
// consumer only ever indexes with it (`socket[kStateSymbol]`).
const __dgramStateSymbol: any = "_dgView";

function __dgramInstallFacade(self: any): void {
  const state: any = self._dgState;
  const facade: any = {};
  facade.fd = -1;
  facade.lookup = function (address: any, callback: any): void {
    __dgramDefaultLookup(self, address, callback);
  };
  facade.send = function (): any {
    return undefined;
  };
  facade.onmessage = function (nread: any, handle: any, buf: any, rinfo: any): void {
    if (Number(nread) < 0) {
      const code: number = Number(nread);
      self.emit(
        "error",
        __dgramException({ errno: code, code: util.getSystemErrorName(code) }, "recvmsg"),
      );
      return;
    }
    if (__dgramReceiveBlocked(self, rinfo)) return;
    self.emit("message", buf, rinfo);
  };
  state.facade = facade;
  state.defaultSend = facade.send;
  self._dgView = { handle: facade };
}

// `_createSocketHandle` of `lib/internal/dgram.js`: a `UDP` handle, bound when
// an address is given; a negative errno otherwise.
class __DgramUdpHandle {
  fd: number = -1;
  id: number = 0;
}

// `internalBinding('udp_wrap')` as far as the corpus reads it, published for
// the test harness's `internalBinding` (tools/harness/binding.ts), which is
// compiled into bundles that may not contain this module.
(globalThis as any).__zunNodeUdpWrap = { UDP: __DgramUdpHandle };

function __dgramCreateSocketHandle(address: any, port: any, addressType: any, fd?: any): any {
  const ops: any = __dgramRequireIo();
  const ipv6: boolean = addressType === "udp6";
  const opened: any = ops.udpOpen(ipv6 ? 1 : 0);
  if (__ioFailed(opened)) return Number(__ioLastError().errno);
  const handle: __DgramUdpHandle = new __DgramUdpHandle();
  handle.id = Number(__ioFields(opened)[0]);
  if (address !== null && address !== undefined) {
    const literal: number = __netIsIP(String(address));
    if (literal === 0) {
      ops.close(handle.id);
      // `uv_udp_bind` of a host name: `EINVAL`.
      for (const entry of util.getSystemErrorMap()) {
        if (String(entry[1][0]) === "EINVAL") return Number(entry[0]);
      }
      return -22;
    }
    const target: number = port === undefined || port === null ? 0 : Number(port);
    const result: any = ops.udpBind(handle.id, String(address), target, 0);
    if (__ioFailed(result)) {
      const errno: number = Number(__ioLastError().errno);
      ops.close(handle.id);
      return errno;
    }
  }
  return handle;
}

// ---------------------------------------------------------------------------
// bind
// ---------------------------------------------------------------------------

function __dgramBind(self: any, a: any, b: any, c: any): any {
  const state: any = self._dgState;
  if (state.bindState !== __DGRAM_UNBOUND) throw new ERR_SOCKET_ALREADY_BOUND();
  state.bindState = __DGRAM_BINDING;

  // Node reads `arguments[arguments.length - 1]`: the last argument passed.
  let cb: any = c;
  if (cb === undefined) cb = b;
  if (cb === undefined) cb = a;
  if (__netIsFn(cb)) {
    const listener: any = cb;
    // A closure cannot name the binding it is being assigned to here, so the
    // listeners reach each other through one holder object.
    const held: any = {};
    held.remove = __evBox(function (): void {
      self.removeListener("close", held.remove);
      self.removeListener("error", held.remove);
      self.removeListener("listening", held.listening);
    });
    held.listening = __evBox(function (): void {
      self.removeListener("close", held.remove);
      self.removeListener("error", held.remove);
      __evCallOn(listener, self, []);
    });
    self.on("error", held.remove);
    self.on("close", held.remove);
    self.on("listening", held.listening);
  }

  let port: any = a;
  if (__netIsFn(port)) port = 0;
  let address: any = undefined;
  let exclusive = false;
  if (port !== null && port !== undefined && typeof port === "object") {
    address = port.address;
    if (address === undefined || address === null || address === "") address = "";
    exclusive = port.exclusive ? true : false;
    port = port.port;
  } else {
    address = __netIsFn(b) ? "" : b;
  }
  if (address === undefined || address === null || address === "") {
    address = state.ipv6 === true ? "::" : "0.0.0.0";
  }
  if (port !== undefined && port !== null) {
    // `validatePort` happens in Node's handle layer; a bad one throws here.
    port = __netValidatePort(port, "Port", true);
  }

  const handle: number = Number(state.handle);
  __dgramLookup(
    self,
    address,
    __evBox(function (err: any, ip: any): void {
      if (Number(state.handle) !== handle || Number(state.handle) === 0) return;
      if (err !== null && err !== undefined) {
        state.bindState = __DGRAM_UNBOUND;
        self.emit("error", err);
        return;
      }
      let flags = 0;
      if (state.reuseAddr === true && !exclusive) flags = flags | 1;
      if (state.ipv6Only === true) flags = flags | 2;
      if (state.reusePort === true) flags = flags | 4;
      const target: number = port === undefined || port === null ? 0 : Number(port);
      const result: any = __dgramRequireIo().udpBind(handle, String(ip), target, flags);
      if (__ioFailed(result)) {
        state.bindState = __DGRAM_UNBOUND;
        self.emit("error", __dgramException(__ioLastError(), "bind", ip, target));
        return;
      }
      __dgramStartListening(self);
    }),
  );
  return self;
}

function __dgramStartListening(self: any): void {
  const state: any = self._dgState;
  const handle: number = Number(state.handle);
  __ioRegister(handle, {
    readable(): void {
      __dgramOnReadable(self);
    },
    writable(): void {
      __dgramOnWritable(self);
    },
    failed(): void {
      __dgramOnReadable(self);
    },
  });
  state.registered = true;
  if (state.unrefd === true) __ioUnref(handle);
  __ioWant(handle, 1);
  state.receiving = true;
  state.bindState = __DGRAM_BOUND;
  if (state.recvBufferSize !== undefined) __dgramBufferSize(self, state.recvBufferSize, true);
  if (state.sendBufferSize !== undefined) __dgramBufferSize(self, state.sendBufferSize, false);
  self.emit("listening");
}

// Drain the receive queue: one `'message'` per datagram.
function __dgramOnReadable(self: any): void {
  const state: any = self._dgState;
  const handle: number = Number(state.handle);
  if (handle === 0) return;
  const ops: any = __ioOps();
  for (let turn = 0; turn < __DGRAM_DRAIN; turn++) {
    const payload: any = ops.udpRecv(handle);
    if (String(payload) === "+A") return;
    if (__ioFailed(payload)) {
      self.emit("error", __dgramException(__ioLastError(), "recvmsg"));
      return;
    }
    const parts: string[] = __ioFields(payload);
    const bytes: Buffer = __netFromBase64(parts[0]);
    const info: any = {
      address: parts[1],
      family: parts[3],
      port: Number(parts[2]),
      size: Number(bytes.length),
    };
    if (__dgramReceiveBlocked(self, info)) continue;
    self.emit("message", bytes, info);
    if (Number(state.handle) !== handle) return;
  }
}

// ---------------------------------------------------------------------------
// The send queue held until the socket is bound
// ---------------------------------------------------------------------------

function __dgramEnqueue(self: any, action: any): void {
  const state: any = self._dgState;
  if (state.queue === undefined) {
    state.queue = [];
    const held: any = {};
    held.error = __evBox(function (): void {
      self.removeListener("listening", held.success);
      state.queue = undefined;
    });
    held.success = __evBox(function (): void {
      self.removeListener(errorMonitor, held.error);
      __dgramClearQueue(self);
    });
    self.once(errorMonitor, held.error);
    self.once("listening", held.success);
  }
  state.queue.push(action);
}

function __dgramClearQueue(self: any): void {
  const state: any = self._dgState;
  const queue: any = state.queue;
  state.queue = undefined;
  if (queue === undefined) return;
  for (const action of queue) action.run();
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

function __dgramConnect(self: any, portArg: any, addressArg: any, callbackArg: any): void {
  const port: number = __netValidatePort(portArg, "Port", false);
  let address: any = addressArg;
  let callback: any = callbackArg;
  if (__netIsFn(address)) {
    callback = address;
    address = "";
  } else if (address === undefined) {
    address = "";
  }
  __dgramValidateString(address, "address");
  const state: any = self._dgState;
  if (state.connectState !== __DGRAM_DISCONNECTED) throw new ERR_SOCKET_DGRAM_IS_CONNECTED();
  state.connectState = __DGRAM_CONNECTING;
  if (state.bindState === __DGRAM_UNBOUND) self.bind({ port: 0, exclusive: true }, null);
  const run: any = {
    run(): void {
      __dgramDoConnect(self, port, address, callback);
    },
  };
  if (state.bindState !== __DGRAM_BOUND) {
    __dgramEnqueue(self, run);
    return;
  }
  run.run();
}

function __dgramDoConnect(self: any, port: number, address: any, callback: any): void {
  const state: any = self._dgState;
  if (__netIsFn(callback)) self.once("connect", callback);
  __dgramLookup(
    self,
    address,
    __evBox(function (ex: any, ip: any): void {
      if (Number(state.handle) === 0) return;
      let failure: any = ex;
      if ((failure === null || failure === undefined) && __dgramSendBlocked(self, ip)) {
        failure = new __DgramIpBlocked(String(ip));
      }
      if (failure === null || failure === undefined) {
        const result: any = __dgramRequireIo().udpConnect(Number(state.handle), String(ip), port);
        if (__ioFailed(result)) {
          failure = __dgramException(__ioLastError(), "connect", address, port);
        }
      }
      if (failure !== null && failure !== undefined) {
        state.connectState = __DGRAM_DISCONNECTED;
        __netTick(function (): void {
          if (__netIsFn(callback)) {
            self.removeListener("connect", callback);
            __netInvoke(callback, [failure]);
          } else {
            self.emit("error", failure);
          }
        });
        return;
      }
      state.connectState = __DGRAM_CONNECTED;
      __netTick(function (): void {
        self.emit("connect");
      });
    }),
  );
}

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

class __DgramIpBlocked extends NodeError {
  constructor(ip: string) {
    super("ERR_IP_BLOCKED", "IP(" + ip + ") is blocked by net.BlockList");
  }
}

// `state.sendBlockList?.check(ip, "ipv" + isIP(ip))`.
function __dgramSendBlocked(self: any, ip: any): boolean {
  const list: any = self._dgState.sendBlockList;
  if (list === null || list === undefined) return false;
  const text: string = String(ip);
  return __dgramTruthy(Reflect.apply(list.check, list, [text, "ipv" + String(__netIsIP(text))]));
}

// `receiveBlockList?.check(rinfo.address, rinfo.family?.toLocaleLowerCase())`.
function __dgramReceiveBlocked(self: any, rinfo: any): boolean {
  const list: any = self._dgState.receiveBlockList;
  if (list === null || list === undefined) return false;
  const family: any = rinfo.family === undefined || rinfo.family === null ? undefined : String(rinfo.family).toLowerCase();
  // `Reflect.apply` rather than `list.check(...)`: a replacement `check`
  // that reads `arguments` loses its first argument through the member call.
  return __dgramTruthy(Reflect.apply(list.check, list, [rinfo.address, family]));
}

function __dgramTruthy(value: any): boolean {
  return value !== undefined && value !== null && value !== "" && value !== 0 && value !== false &&
    !(typeof value === "number" && value !== value);
}

function __dgramSend(self: any, a: any, b: any, c: any, d: any, e: any, f: any): void {
  let buffer: any = a;
  let offset: any = b;
  let length: any = c;
  let port: any = d;
  let address: any = e;
  let callback: any = f;
  const state: any = self._dgState;
  const connected: boolean = state.connectState === __DGRAM_CONNECTED;

  if (!connected) {
    if ((address !== undefined && address !== null && address !== "" && address !== 0 && address !== false) ||
        (port && typeof port !== "function")) {
      buffer = __dgramSlice(buffer, offset, length);
    } else {
      callback = port;
      port = offset;
      address = length;
    }
  } else {
    if (typeof length === "number") {
      buffer = __dgramSlice(buffer, offset, length);
      if (typeof port === "function") {
        callback = port;
        port = null;
      }
    } else {
      callback = offset;
    }
    if (__dgramTruthy(port) || __dgramTruthy(address)) throw new ERR_SOCKET_DGRAM_IS_CONNECTED();
    port = null;
    address = null;
  }

  let list: any = null;
  if (!Array.isArray(buffer)) {
    if (typeof buffer === "string") {
      list = [__dgramToBuffer(buffer)];
    } else if (!__dgramIsView(buffer)) {
      throw new ERR_INVALID_ARG_TYPE("buffer", __dgramBytesType(), buffer);
    } else {
      list = [__dgramToBuffer(buffer)];
    }
  } else {
    list = __dgramFixList(buffer);
    if (list === null) {
      throw new ERR_INVALID_ARG_TYPE("buffer list arguments", __dgramBytesType(), buffer);
    }
  }

  if (!connected) port = __netValidatePort(port, "Port", false);

  if (!__netIsFn(callback)) callback = undefined;
  if (__netIsFn(address)) {
    callback = address;
    address = undefined;
  } else if (address !== undefined && address !== null) {
    __dgramValidateString(address, "address");
  }

  __dgramHealth(self);
  if (state.bindState === __DGRAM_UNBOUND) self.bind({ port: 0, exclusive: true }, null);
  if (Number(list.length) === 0) list.push(Buffer.alloc(0));

  const run: any = {
    run(): void {
      __dgramDispatch(self, list, address, port, callback, connected);
    },
  };
  if (state.bindState !== __DGRAM_BOUND) {
    __dgramEnqueue(self, run);
    return;
  }
  run.run();
}

function __dgramDispatch(
  self: any,
  list: any,
  address: any,
  port: any,
  callback: any,
  connected: boolean,
): void {
  const state: any = self._dgState;
  if (Number(state.handle) === 0) return;
  if (connected) {
    __dgramDoSend(self, null, null, list, address, port, callback);
    return;
  }
  __dgramLookup(
    self,
    address,
    __evBox(function (ex: any, ip: any): void {
      __dgramDoSend(self, ex, ip, list, address, port, callback);
    }),
  );
}

// Node's `--test-udp-no-try-send` test flag, read out of `NODE_OPTIONS`.
const __dgramNoTrySend: any = { on: __dgramReadNoTrySend() };

function __dgramReadNoTrySend(): boolean {
  const raw: any = __processEnvGet("NODE_OPTIONS");
  if (typeof raw === "string" && raw.indexOf("--test-udp-no-try-send") !== -1) return true;
  for (const word of process.execArgv) {
    if (String(word) === "--test-udp-no-try-send") return true;
  }
  return false;
}

function __dgramDoSend(
  self: any,
  ex: any,
  ip: any,
  list: any,
  address: any,
  port: any,
  callback: any,
): void {
  const state: any = self._dgState;
  if (ex !== null && ex !== undefined) {
    if (__netIsFn(callback)) {
      __netTick(callback, ex);
      return;
    }
    __netTick(function (): void {
      self.emit("error", ex);
    });
    return;
  }
  if (Number(state.handle) === 0) return;
  if (__dgramTruthy(ip) && __dgramSendBlocked(self, ip)) {
    if (__netIsFn(callback)) __netTick(callback, new __DgramIpBlocked(String(ip)));
    return;
  }
  const parts: Buffer[] = [];
  for (const item of list) {
    const piece: Buffer = item;
    parts.push(piece);
  }
  const joined: Buffer = Buffer.concat(parts);
  const encoded: string = joined.toString("base64");
  const target: string = ip === null || ip === undefined ? "" : String(ip);
  const portNumber: number = port === null || port === undefined ? 0 : Number(port);
  const entry: any = {
    encoded: encoded,
    target: target,
    port: portNumber,
    address: address,
    callback: callback,
    size: Number(joined.length),
  };
  if (Number(state.blocked.length) > 0 || __dgramNoTrySend.on) {
    // Earlier datagrams are still waiting for room: keep the order. Under
    // `--test-udp-no-try-send` every datagram takes this queued path, as
    // libuv's `uv_udp_try_send` is skipped and the send waits for writability.
    state.blocked.push(entry);
    __ioWant(Number(state.handle), 2);
    return;
  }
  __dgramAttempt(self, entry, true);
}

// One try at handing a datagram to the kernel. Answers whether it was settled
// (sent or failed); `false` means "would block" and the entry stays queued.
function __dgramAttempt(self: any, entry: any, fresh: boolean): boolean {
  const state: any = self._dgState;
  const handle: number = Number(state.handle);
  if (state.facade !== undefined && state.facade.send !== state.defaultSend) {
    const replaced: any = state.facade.send();
    if (typeof replaced === "number" && replaced < 0) {
      if (__netIsFn(entry.callback)) {
        const failure: any = __dgramException(
          { errno: replaced, code: util.getSystemErrorName(replaced) },
          "send",
          entry.address,
          entry.port,
        );
        __netTick(entry.callback, failure);
      }
      return true;
    }
  }
  const result: any = __ioOps().udpSend(handle, entry.target, entry.port, entry.encoded);
  if (String(result) === "+A") {
    if (fresh) {
      state.blocked.push(entry);
      __ioWant(handle, 2);
    }
    return false;
  }
  if (__ioFailed(result)) {
    // Without a callback the error is dropped, as Node does
    // (`test-dgram-send-cb-quelches-error.js`).
    if (__netIsFn(entry.callback)) {
      const failure: any = __dgramException(__ioLastError(), "send", entry.address, entry.port);
      __netTick(entry.callback, failure);
    }
    return true;
  }
  if (__netIsFn(entry.callback)) {
    __netTick(entry.callback, null, Number(__ioFields(result)[0]));
  }
  return true;
}

function __dgramOnWritable(self: any): void {
  const state: any = self._dgState;
  const handle: number = Number(state.handle);
  if (handle === 0) return;
  while (Number(state.blocked.length) > 0) {
    const entry: any = state.blocked[0];
    if (!__dgramAttempt(self, entry, false)) return;
    state.blocked.shift();
  }
  __ioUnwant(handle, 2);
}

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

function __dgramClose(self: any, callback: any): any {
  const state: any = self._dgState;
  if (__netIsFn(callback)) self.on("close", callback);
  const queue: any = state.queue;
  if (queue !== undefined) {
    queue.push({
      run(): void {
        __dgramClose(self, undefined);
      },
    });
    return self;
  }
  __dgramHealth(self);
  const handle: number = Number(state.handle);
  state.receiving = false;
  state.handle = 0;
  state.blocked = [];
  if (state.registered === true) {
    __ioUnregister(handle);
  } else {
    __ioOps().close(handle);
  }
  state.registered = false;
  __netTick(function (): void {
    self.emit("close");
  });
  return self;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function __dgramOption(self: any, syscall: string, name: string, value: number): void {
  const state: any = self._dgState;
  if (Number(state.handle) === 0) throw new ERR_SOCKET_DGRAM_NOT_RUNNING();
  if (state.bindState !== __DGRAM_BOUND) throw __dgramEbadf(syscall);
  const result: any = __dgramRequireIo().udpOpt(Number(state.handle), name, value);
  if (__ioFailed(result)) throw __dgramException(__ioLastError(), syscall);
}

// `setTTL`/`setMulticastTTL`: libuv refuses a value outside 1..255 (0..255 for
// the multicast one) before any syscall, with `EINVAL`.
function __dgramRangedOption(self: any, syscall: string, name: string, ttl: number): void {
  const state: any = self._dgState;
  if (Number(state.handle) === 0) throw new ERR_SOCKET_DGRAM_NOT_RUNNING();
  if (state.bindState !== __DGRAM_BOUND) throw __dgramEbadf(syscall);
  const low: number = name === "multicastTtl" ? 0 : 1;
  if (!(ttl >= low && ttl <= 255) || ttl !== Math.floor(ttl)) {
    // Let the native side produce its platform's `EINVAL` errno.
    __dgramRequireIo().udpOpt(Number(state.handle), "invalid", 0);
    throw __dgramException(__ioLastError(), syscall);
  }
  __dgramOption(self, syscall, name, ttl);
}

function __dgramMembership(
  self: any,
  join: boolean,
  syscall: string,
  group: any,
  iface: any,
): void {
  __dgramHealth(self);
  if (group === undefined || group === null || group === "") {
    throw new ERR_MISSING_ARGS("multicastAddress");
  }
  const invalidGroup: boolean =
    __netIsIP(String(group)) === 0 ||
    (iface !== undefined && iface !== null && iface !== "" && __netIsIP(String(iface)) === 0);
  if (!invalidGroup && self._dgState.bindState !== __DGRAM_BOUND) throw __dgramEbadf(syscall);
  const result: any = __dgramRequireIo().udpMembership(
    Number(self._dgState.handle),
    join ? 1 : 0,
    String(group),
    iface === undefined || iface === null ? "" : String(iface),
  );
  if (__ioFailed(result)) throw __dgramException(__ioLastError(), syscall);
}

function __dgramSourceMembership(
  self: any,
  join: boolean,
  syscall: string,
  source: any,
  group: any,
  iface: any,
): void {
  __dgramValidateString(source, "sourceAddress");
  __dgramValidateString(group, "groupAddress");
  __dgramHealth(self);
  const invalidSource: boolean = __netIsIP(source) === 0 || __netIsIP(group) === 0;
  if (!invalidSource && self._dgState.bindState !== __DGRAM_BOUND) throw __dgramEbadf(syscall);
  const result: any = __dgramRequireIo().udpSourceMembership(
    Number(self._dgState.handle),
    join ? 1 : 0,
    String(source),
    String(group),
    iface === undefined || iface === null ? "" : String(iface),
  );
  if (__ioFailed(result)) throw __dgramException(__ioLastError(), syscall);
}

// `bufferSize(self, size, recv)`: size 0 reads, anything else sets then reads.
function __dgramBufferSize(self: any, size: any, recv: boolean): any {
  const value: number = Number(size);
  if (typeof size !== "number" || value >>> 0 !== value) throw new ERR_SOCKET_BAD_BUFFER_SIZE();
  const state: any = self._dgState;
  __dgramHealth(self);
  const syscall: string = recv ? "uv_recv_buffer_size" : "uv_send_buffer_size";
  if (state.bindState !== __DGRAM_BOUND) {
    // libuv reports the missing socket as `ENOTSOCK` on Windows, `EBADF`
    // elsewhere.
    if (process.platform === "win32") {
      throw new ERR_SOCKET_BUFFER_SIZE({
        errno: -4050,
        code: "ENOTSOCK",
        message: "socket operation on non-socket",
        syscall: syscall,
      });
    }
    throw new ERR_SOCKET_BUFFER_SIZE({
      errno: -9,
      code: "EBADF",
      message: "bad file descriptor",
      syscall: syscall,
    });
  }
  const ops: any = __dgramRequireIo();
  const handle: number = Number(state.handle);
  if (value !== 0) {
    const set: any = ops.udpOpt(handle, recv ? "recvBuf" : "sendBuf", value);
    if (__ioFailed(set)) {
      const info: any = __ioLastError();
      throw new ERR_SOCKET_BUFFER_SIZE({
        errno: info.errno,
        code: info.code,
        message: info.message,
        syscall: syscall,
      });
    }
  }
  const got: any = ops.udpOpt(handle, recv ? "getRecvBuf" : "getSendBuf", 0);
  if (__ioFailed(got)) {
    const info: any = __ioLastError();
    throw new ERR_SOCKET_BUFFER_SIZE({
      errno: info.errno,
      code: info.code,
      message: info.message,
      syscall: syscall,
    });
  }
  return Number(__ioFields(got)[0]);
}

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------

function __dgramCreateSocket(type: any, listener?: any): any {
  return new __DgramSocket(type, listener);
}

const __node_internal_dgram: any = {
  kStateSymbol: __dgramStateSymbol,
  _createSocketHandle: __dgramCreateSocketHandle,
};

const __node_dgram: any = {
  Socket: __DgramSocket,

  createSocket(type: any, listener?: any): any {
    return __dgramCreateSocket(type, listener);
  },
};

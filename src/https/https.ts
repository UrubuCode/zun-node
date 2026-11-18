// node:https — the Node-shaped `https` module: `node:http` over `node:tls`.
//
// Behavior is defined by Node.js 25's `lib/https.js` (MIT, Copyright Joyent,
// Inc. and other Node contributors) and measured against Node's own
// `test/parallel/test-https-*.js` (see ../../test/https/).
//
// Everything HTTP is `src/http/http.ts`; this file only changes where the
// bytes go:
//
//   * `Agent` is http's `Agent` with `defaultPort` 443, `protocol` 'https:',
//     a `createConnection` that is `tls.connect`, and Node's longer pool key
//     (every TLS option that changes the connection is part of it).
//   * `request`/`get` are http's `ClientRequest` with `_defaultAgent` set to
//     this module's global agent, which is how `lib/https.js` reuses it.
//   * `Server` is http's server whose `'connection'` sockets are wrapped in a
//     server-side `TLSSocket`; the HTTP connection is attached on
//     `'secureConnection'`, as Node's `https.Server` does.

class __HttpsAgent extends Agent {
  maxCachedSessions: any = 100;
  _sessionCache: any = null;

  constructor(options?: any) {
    super(options);
    this.defaultPort = 443;
    this.protocol = "https:";
    const opts: any = options === undefined || options === null ? {} : options;
    this.maxCachedSessions = opts.maxCachedSessions === undefined ? 100 : opts.maxCachedSessions;
    this._sessionCache = { map: {}, list: [] };
  }

  createConnection(options?: any, callback?: any): any {
    return __httpsCreateConnection(this, options, callback);
  }

  getName(options?: any): any {
    return __httpsAgentGetName(options);
  }
}

// The SNI name a request sends: `servername`, else the `Host` header's host,
// else `host` -- and none for an IP literal.
function __httpsServername(options: any): any {
  if (options.servername !== undefined && options.servername !== null) return options.servername;
  let host: string = options.host === undefined || options.host === null ? "localhost" : String(options.host);
  const headers: any = options.headers;
  if (headers !== undefined && headers !== null && !Array.isArray(headers) && typeof headers.host === "string") {
    host = String(headers.host);
    if (host.charAt(0) === "[") {
      const close: number = Number(host.indexOf("]"));
      host = close === -1 ? host.slice(1) : host.slice(1, close);
    } else {
      const colon: number = Number(host.indexOf(":"));
      if (colon !== -1) host = host.slice(0, colon);
    }
  }
  if (__netIsIP(host) !== 0) return "";
  return host;
}

function __httpsCreateConnection(agent: any, options: any, callback: any): any {
  const opts: any = __httpLikeMerge(options, null);
  if (opts.servername === undefined || opts.servername === null) opts.servername = __httpsServername(opts);
  if (opts.servername === "") delete opts.servername;
  return __tlsConnect(opts, undefined, undefined, undefined);
}

function __httpsAgentGetName(options?: any): any {
  const o: any = options === undefined || options === null ? {} : options;
  let name: string = o.host !== undefined && o.host !== null && o.host !== "" ? String(o.host) : "localhost";
  name = name + ":";
  if (o.port) name = name + String(o.port);
  name = name + ":";
  if (o.localAddress) name = name + String(o.localAddress);
  if (o.family === 4 || o.family === 6) name = name + ":" + String(o.family);
  if (o.socketPath) name = name + ":" + String(o.socketPath);
  name = name + ":";
  if (o.ca) name = name + String(o.ca);
  name = name + ":";
  if (o.cert) name = name + String(o.cert);
  name = name + ":";
  if (o.clientCertEngine) name = name + String(o.clientCertEngine);
  name = name + ":";
  if (o.ciphers) name = name + String(o.ciphers);
  name = name + ":";
  if (o.key) name = name + String(o.key);
  name = name + ":";
  if (o.pfx) name = name + String(o.pfx);
  name = name + ":";
  if (o.rejectUnauthorized !== undefined) name = name + String(o.rejectUnauthorized);
  name = name + ":";
  if (o.servername && o.servername !== o.host) name = name + String(o.servername);
  name = name + ":";
  if (o.minVersion) name = name + String(o.minVersion);
  name = name + ":";
  if (o.maxVersion) name = name + String(o.maxVersion);
  name = name + ":";
  if (o.secureProtocol) name = name + String(o.secureProtocol);
  name = name + ":";
  if (o.crl) name = name + String(o.crl);
  name = name + ":";
  if (o.honorCipherOrder !== undefined) name = name + String(o.honorCipherOrder);
  name = name + ":";
  if (o.ecdhCurve) name = name + String(o.ecdhCurve);
  name = name + ":";
  if (o.dhparam) name = name + String(o.dhparam);
  name = name + ":";
  if (o.secureOptions !== undefined) name = name + String(o.secureOptions);
  name = name + ":";
  if (o.sessionIdContext) name = name + String(o.sessionIdContext);
  name = name + ":";
  if (o.sigalgs) name = name + JSON.stringify(o.sigalgs);
  name = name + ":";
  if (o.privateKeyIdentifier) name = name + String(o.privateKeyIdentifier);
  name = name + ":";
  if (o.privateKeyEngine) name = name + String(o.privateKeyEngine);
  return name;
}

let __httpsGlobalAgent: any = null;

function __httpsDefaultAgent(): any {
  if (__httpsGlobalAgent === null) {
    __httpsGlobalAgent = new __HttpsAgent({ keepAlive: true, scheduling: "lifo", timeout: 5000 });
  }
  return __httpsGlobalAgent;
}

// `https.request(input[, options][, cb])`: http's argument shapes, with this
// module's agent as the default.
function __httpsRequest(input?: any, options?: any, cb?: any): any {
  let first: any = input;
  let second: any = options;
  let callback: any = cb;
  if (typeof first === "string" || __httpIsUrlObject(first)) {
    if (typeof second === "function") {
      callback = second;
      second = {};
    } else if (second === undefined || second === null) {
      second = {};
    }
    second = __httpLikeMerge(second, null);
    second._defaultAgent = __httpsDefaultAgent();
  } else {
    if (typeof first === "function") {
      callback = first;
      first = {};
    } else if (first === undefined || first === null) {
      first = {};
    }
    if (typeof first === "object") {
      first = __httpLikeMerge(first, null);
      first._defaultAgent = __httpsDefaultAgent();
    }
    if (typeof second === "function") {
      callback = second;
      second = undefined;
    }
  }
  return new ClientRequest(first, second, callback);
}

function __httpsGet(input?: any, options?: any, cb?: any): any {
  const req: any = __httpsRequest(input, options, cb);
  req.end();
  return req;
}

class __HttpsServer extends __HttpServer {
  _tlsServerState: any = null;

  constructor(options?: any, requestListener?: any) {
    let opts: any = options;
    let listener: any = requestListener;
    if (typeof opts === "function") {
      listener = opts;
      opts = {};
    } else if (opts === undefined || opts === null) {
      opts = {};
    } else if (typeof opts !== "object" || Array.isArray(opts)) {
      throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
    }
    super(opts, listener);
    const tlsOpts: any = __httpLikeMerge(opts, null);
    if (tlsOpts.ALPNProtocols === undefined) tlsOpts.ALPNProtocols = ["http/1.1"];
    __tlsServerInit(this, tlsOpts);
    // http's own `'connection'` listener attaches the HTTP parser to the TCP
    // socket; for https it belongs on the TLS socket instead.
    this.removeAllListeners("connection");
    const self: any = this;
    this.on("connection", function (raw: any): void {
      __tlsServerAccept(self, raw, null);
    });
    this.on("secureConnection", function (sock: any): void {
      __httpServerAttach(self, sock);
    });
  }

  addContext(servername: any, context: any): void {
    __tlsServerAddContext(this, servername, context);
  }

  setSecureContext(options: any): void {
    __tlsServerSetSecureContext(this, options);
  }

  getTicketKeys(): any {
    return this._tlsServerState.ticketKeys;
  }

  setTicketKeys(keys: any): void {
    __tlsServerSetTicketKeys(this, keys);
  }
}

function __httpsCreateServer(options?: any, listener?: any): any {
  return new __HttpsServer(options, listener);
}

const __node_https: any = {
  Agent: __HttpsAgent,
  Server(options?: any, listener?: any): any {
    return __httpsCreateServer(options, listener);
  },
  createServer(options?: any, listener?: any): any {
    return __httpsCreateServer(options, listener);
  },
  request(input?: any, options?: any, cb?: any): any {
    return __httpsRequest(input, options, cb);
  },
  get(input?: any, options?: any, cb?: any): any {
    return __httpsGet(input, options, cb);
  },
  get globalAgent(): any {
    return __httpsDefaultAgent();
  },
  set globalAgent(value: any) {
    __httpsGlobalAgent = value;
  },
};

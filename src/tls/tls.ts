// node:tls — the Node-shaped `tls` module, in Zun TypeScript over `node:net`
// and the rustls engine in `src/tls/mod.rs`.
//
// Behavior is defined by Node.js 25 (`lib/tls.js`, `lib/_tls_wrap.js`,
// `lib/_tls_common.js`, MIT, Copyright Joyent, Inc. and other Node
// contributors) and measured against Node's own `test/parallel/test-tls-*.js`
// (see ../../test/tls/).
//
// ---------------------------------------------------------------------------
// Where this module sits
// ---------------------------------------------------------------------------
//
// Node's `TLSSocket` wraps a TCP handle with an OpenSSL session fed through
// memory BIOs. Here the session is a rustls connection in the extension's
// handle table and the "BIO" is this file: a `TLSSocket` is a `net.Socket`
// subclass *without a handle of its own* that owns a second stream underneath
// (`_tlsState.raw`: a `net.Socket`, or any `Duplex` the caller handed in).
//
//   raw 'data'  -> tlsFeed       -> ciphertext out to raw, plaintext push()ed
//   write()     -> tlsWrite      -> ciphertext out to raw
//   end()       -> tlsCloseNotify, then raw.end()
//
// Every native call answers one poll record, `+done US out US plain US eof`,
// so each socket event costs one crossing.
//
// Verification follows Node's split: the engine records the chain verdict
// (`authorizationError`'s code), and this file decides — `rejectUnauthorized`
// destroys the socket after the handshake, and `checkServerIdentity` runs in
// JavaScript and may be replaced by the caller.
//
// Engine workarounds are the ones `src/net/net.ts` documents: `any` locals,
// `Number(x.length)`, stream hooks through `__sSetOptFn`, side-state in plain
// objects, error classes with declared fields (zun#37).

import * as __tlsNative from "node:tls";

const __TLS_US: string = "\u001f";
const __TLS_RS: string = "\u001e";
const __TLS_GS: string = "\u001d";

const __TLS_DEFAULT_CIPHERS: string =
  "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:" +
  "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:" +
  "ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-CHACHA20-POLY1305";

const __tlsDefaults: any = {
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
  ciphers: __TLS_DEFAULT_CIPHERS,
  ecdhCurve: "auto",
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

// An OpenSSL error as Node surfaces it: `code` is the `ERR_SSL_*` spelling and
// `library`/`reason` are split out of the message.
class __TlsOpenSSLError extends Error {
  code: any = "";
  library: any = "";
  reason: any = "";
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    const parts: string[] = message.split(":");
    if (Number(parts.length) >= 5) {
      this.library = parts[2];
      this.reason = parts.slice(4).join(":");
    }
  }
}

// A chain verdict (`DEPTH_ZERO_SELF_SIGNED_CERT` & co.): `code` is OpenSSL's
// `X509_V_ERR_*` name without its prefix.
class __TlsVerifyError extends Error {
  code: any = "";
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

class ERR_TLS_CERT_ALTNAME_INVALID extends Error {
  code: any = "ERR_TLS_CERT_ALTNAME_INVALID";
  reason: any = "";
  host: any = "";
  cert: any = null;
  constructor(reason: string, host: string, cert: any) {
    super("Hostname/IP does not match certificate's altnames: " + reason);
    this.reason = reason;
    this.host = host;
    this.cert = cert;
  }
}

class __TlsConnResetError extends Error {
  code: any = "ECONNRESET";
  path: any = undefined;
  host: any = undefined;
  port: any = undefined;
  localAddress: any = undefined;
  constructor(message: string) {
    super(message);
  }
}

function __tlsNativeError(): any {
  const code: string = String(__tlsNative.tlsErrorCode());
  const message: string = String(__tlsNative.tlsErrorMessage());
  return new __TlsOpenSSLError(code, message);
}

// ---------------------------------------------------------------------------
// Option values
// ---------------------------------------------------------------------------

function __tlsIsBytes(value: any): boolean {
  return Buffer.isBuffer(value) || ArrayBuffer.isView(value);
}

// A key/cert/ca value to base64: a string is taken as text (PEM), a byte view
// as bytes.
function __tlsB64(value: any): string {
  if (typeof value === "string") return __netToBase64(value, "latin1");
  if (Buffer.isBuffer(value)) return __netToBase64(value, undefined);
  const view: any = value;
  const bytes: Buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  return bytes.toString("base64");
}

function __tlsValidateKeyish(name: string, value: any): void {
  if (typeof value === "string" || __tlsIsBytes(value)) return;
  throw new ERR_INVALID_ARG_TYPE(name, ["string", "Buffer", "TypedArray", "DataView"], value);
}

// `options.key` / `cert` / `ca` as a list of base64 entries. A `key` entry may
// be `{ pem, passphrase }`.
function __tlsCollect(name: string, value: any, allowObject: boolean, passOut: any): string[] {
  const out: string[] = [];
  if (value === undefined || value === null || value === false) return out;
  const isList: boolean = Array.isArray(value);
  const items: any[] = isList ? value : [value];
  for (const item of items) {
    // `{ pem, passphrase }` is accepted only as an element of a key array.
    if (allowObject && isList && item !== null && typeof item === "object" && !__tlsIsBytes(item)) {
      const pem: any = item.pem;
      __tlsValidateKeyish(name, pem);
      if (item.passphrase !== undefined && item.passphrase !== null) passOut.value = String(item.passphrase);
      out.push(__tlsB64(pem));
      continue;
    }
    __tlsValidateKeyish(name, item);
    out.push(__tlsB64(item));
  }
  return out;
}

const __TLS_VERSIONS: string[] = ["TLSv1", "TLSv1.1", "TLSv1.2", "TLSv1.3"];

function __tlsValidateVersion(value: any, which: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE("options." + which + "Version", "string", value);
  if (__TLS_VERSIONS.indexOf(value) === -1) {
    throw new NodeTypeError(
      "ERR_TLS_INVALID_PROTOCOL_VERSION",
      '"' + value + '" is not a valid ' + (which === "min" ? "minimum" : "maximum") + " TLS protocol version",
    );
  }
}

// ALPN protocol names as base64 entries: an array of strings / buffers, or a
// buffer already in wire format (length-prefixed).
function __tlsAlpnList(value: any): string[] {
  const out: string[] = [];
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    for (const item of value) out.push(__tlsB64(typeof item === "string" ? item : item));
    return out;
  }
  if (__tlsIsBytes(value)) {
    const bytes: Buffer = Buffer.from(__tlsB64(value), "base64");
    let i = 0;
    const n: number = Number(bytes.length);
    while (i < n) {
      const len: number = Number(bytes[i]);
      out.push(bytes.subarray(i + 1, i + 1 + len).toString("base64"));
      i = i + 1 + len;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SecureContext / createSecureContext (`lib/_tls_common.js`)
// ---------------------------------------------------------------------------

class SecureContext {
  context: any = null;
  _tls: any = null;
  constructor(secureProtocol?: any, secureOptions?: any, minVersion?: any, maxVersion?: any) {
    this.context = {};
    this._tls = {
      key: [],
      cert: [],
      ca: [],
      passphrase: undefined,
      ciphers: undefined,
      minVersion: minVersion === undefined ? undefined : minVersion,
      maxVersion: maxVersion === undefined ? undefined : maxVersion,
      honorCipherOrder: false,
      pfx: false,
    };
  }
}

function __tlsCreateSecureContext(options?: any): any {
  const opts: any = options === undefined || options === null ? {} : options;
  if (typeof opts !== "object") throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
  __tlsValidateVersion(opts.minVersion, "min");
  __tlsValidateVersion(opts.maxVersion, "max");
  if (opts.secureProtocol !== undefined && opts.secureProtocol !== null) {
    if (typeof opts.secureProtocol !== "string") {
      throw new ERR_INVALID_ARG_TYPE("options.secureProtocol", "string", opts.secureProtocol);
    }
    if ((opts.minVersion !== undefined && opts.minVersion !== null) || (opts.maxVersion !== undefined && opts.maxVersion !== null)) {
      throw new NodeTypeError(
        "ERR_TLS_PROTOCOL_VERSION_CONFLICT",
        "TLS protocol version " + String(opts.minVersion !== undefined ? opts.minVersion : opts.maxVersion) +
          " conflicts with secureProtocol " + String(opts.secureProtocol),
      );
    }
  }
  if (opts.ciphers !== undefined && opts.ciphers !== null && typeof opts.ciphers !== "string") {
    throw new ERR_INVALID_ARG_TYPE("options.ciphers", "string", opts.ciphers);
  }
  if (typeof opts.ciphers === "string" && !__tlsCipherListMatches(String(opts.ciphers))) {
    throw new __TlsOpenSSLError("ERR_SSL_NO_CIPHER_MATCH", "error:0A0000B9:SSL routines::no cipher match");
  }
  if (opts.passphrase !== undefined && opts.passphrase !== null && typeof opts.passphrase !== "string") {
    throw new ERR_INVALID_ARG_TYPE("options.passphrase", "string", opts.passphrase);
  }
  const ctx: any = new SecureContext(opts.secureProtocol, opts.secureOptions, opts.minVersion, opts.maxVersion);
  const state: any = ctx._tls;
  const pass: any = { value: opts.passphrase === undefined || opts.passphrase === null ? undefined : String(opts.passphrase) };
  state.key = __tlsCollect("options.key", opts.key, true, pass);
  state.cert = __tlsCollect("options.cert", opts.cert, false, pass);
  state.ca = __tlsCollect("options.ca", opts.ca, false, pass);
  state.passphrase = pass.value;
  state.ciphers = opts.ciphers;
  state.honorCipherOrder = opts.honorCipherOrder === true;
  if (opts.pfx !== undefined && opts.pfx !== null) state.pfx = true;
  if (opts.secureProtocol !== undefined && opts.secureProtocol !== null) {
    const proto: string = String(opts.secureProtocol);
    if (proto.indexOf("TLSv1_3") === 0) {
      state.minVersion = "TLSv1.3";
      state.maxVersion = "TLSv1.3";
    } else if (proto.indexOf("TLSv1_2") === 0) {
      state.minVersion = "TLSv1.2";
      state.maxVersion = "TLSv1.2";
    } else if (proto.indexOf("TLSv1_1") === 0) {
      state.minVersion = "TLSv1.1";
      state.maxVersion = "TLSv1.1";
    } else if (proto.indexOf("TLSv1_") === 0 || proto === "TLSv1_method") {
      state.minVersion = "TLSv1";
      state.maxVersion = "TLSv1";
    } else if (proto.indexOf("SSLv") === 0) {
      throw new __TlsOpenSSLError("ERR_TLS_INVALID_PROTOCOL_METHOD", proto + " methods disabled");
    } else if (proto !== "TLS_method" && proto !== "SSLv23_method" && proto !== "TLS_client_method" && proto !== "TLS_server_method" && proto !== "SSLv23_client_method" && proto !== "SSLv23_server_method") {
      throw new NodeTypeError("ERR_TLS_INVALID_PROTOCOL_METHOD", "Unknown method: " + proto);
    }
  }
  // A key with no certificate (or the reverse) is accepted, as in OpenSSL,
  // until a handshake needs both; a key that does not parse or does not match
  // its certificate is reported here, which is when Node reports it.
  if (Number(state.key.length) > 0 && Number(state.cert.length) > 0) {
    const check: string = String(__tlsNative.tlsCheckOptions(true, __tlsContextRecord(ctx, [])));
    if (check.charAt(0) !== "+") throw __tlsNativeError();
  } else if (Number(state.key.length) > 0) {
    const check: string = String(
      __tlsNative.tlsCheckOptions(true, __tlsRecord([["key", state.key[0]], ["cert", ""], ["passphrase", state.passphrase === undefined ? "" : state.passphrase]])),
    );
    // Only a key that cannot be read at all is an error at this point.
    if (check.charAt(0) !== "+") {
      const err: any = __tlsNativeError();
      if (String(err.code) !== "ERR_OSSL_PEM_NO_START_LINE" || __tlsKeyLooksBad(state.key[0])) throw err;
    }
  }
  return ctx;
}

// OpenSSL's "no cipher match": a list none of whose entries names a cipher
// or a cipher-string keyword. Keywords (`HIGH`, `DEFAULT`, `!aNULL`, `AES128`)
// are recognised by shape -- upper-case words -- so a list that only uses
// suites rustls lacks is still accepted, as Node accepts it.
function __tlsCipherListMatches(list: string): boolean {
  for (const raw of list.split(":")) {
    let token: string = raw.trim();
    while (token !== "" && "!-+@".indexOf(token.charAt(0)) !== -1) token = token.slice(1);
    if (token === "") continue;
    if (token.charAt(0) === "!" || raw.trim().charAt(0) === "!") continue;
    if (__tlsGetCiphers().indexOf(token.toLowerCase()) !== -1) return true;
    if (token.toUpperCase() === token || /^[A-Za-z0-9+=._-]+$/.test(token) && token.charAt(0) === token.charAt(0).toUpperCase() && /[A-Z]/.test(token)) return true;
  }
  return false;
}

function __tlsKeyLooksBad(b64: string): boolean {
  const text: string = Buffer.from(b64, "base64").toString("latin1");
  return text.indexOf("PRIVATE KEY") === -1;
}

function __tlsRecord(pairs: any[]): string {
  const parts: string[] = [];
  for (const pair of pairs) {
    const value: any = pair[1];
    if (value === undefined || value === null) continue;
    parts.push(String(pair[0]) + __TLS_US + String(value));
  }
  return parts.join(__TLS_RS);
}

// The engine option record for a session over `ctx`, plus `extra` pairs.
function __tlsContextRecord(ctx: any, extra: any[]): string {
  const state: any = ctx._tls;
  const pairs: any[] = [];
  if (Number(state.cert.length) > 0) pairs.push(["cert", state.cert[0]]);
  if (Number(state.key.length) > 0) pairs.push(["key", state.key[0]]);
  for (const ca of state.ca) pairs.push(["ca", ca]);
  if (state.passphrase !== undefined) pairs.push(["passphrase", state.passphrase]);
  if (state.ciphers !== undefined && state.ciphers !== null) pairs.push(["ciphers", state.ciphers]);
  const minV: any = state.minVersion !== undefined && state.minVersion !== null ? state.minVersion : __tlsDefaults.minVersion;
  const maxV: any = state.maxVersion !== undefined && state.maxVersion !== null ? state.maxVersion : __tlsDefaults.maxVersion;
  pairs.push(["minVersion", minV]);
  pairs.push(["maxVersion", maxV]);
  if (state.honorCipherOrder === true) pairs.push(["honorCipherOrder", "1"]);
  for (const pair of extra) pairs.push(pair);
  return __tlsRecord(pairs);
}

// ---------------------------------------------------------------------------
// Certificates (`getPeerCertificate`)
// ---------------------------------------------------------------------------

function __tlsNameObject(lines: string): any {
  const out: any = Object.create(null);
  if (lines === "") return out;
  for (const line of lines.split("\n")) {
    const eq: number = Number(line.indexOf("="));
    if (eq === -1) continue;
    const key: string = line.slice(0, eq);
    const value: string = line.slice(eq + 1);
    const prev: any = out[key];
    if (prev === undefined) out[key] = value;
    else if (Array.isArray(prev)) prev.push(value);
    else out[key] = [prev, value];
  }
  return out;
}

function __tlsDescribeCert(b64: string): any {
  const result: string = String(__tlsNative.tlsParseCert(b64));
  if (result.charAt(0) !== "+") return null;
  const f: string[] = result.slice(1).split(__TLS_US);
  const cert: any = {};
  cert.subject = __tlsNameObject(f[0]);
  cert.issuer = __tlsNameObject(f[1]);
  if (f[8] !== "") cert.subjectaltname = f[8];
  cert.ca = f[13] === "1";
  if (f[10] !== "") {
    cert.modulus = f[10];
    cert.bits = Number(f[9]);
    cert.exponent = f[11];
    cert.pubkey = Buffer.from(f[12], "base64");
  } else if (f[14] !== "" || f[9] !== "") {
    if (f[9] !== "") cert.bits = Number(f[9]);
    cert.pubkey = Buffer.from(f[12], "base64");
    if (f[14] !== "") cert.asn1Curve = f[14];
    if (f[15] !== "") cert.nistCurve = f[15];
  }
  cert.valid_from = f[2];
  cert.valid_to = f[3];
  cert.validFromDate = new Date(Number(f[16]) * 1000);
  cert.validToDate = new Date(Number(f[17]) * 1000);
  cert.fingerprint = f[5];
  cert.fingerprint256 = f[6];
  cert.fingerprint512 = f[7];
  cert.serialNumber = f[4];
  cert.raw = Buffer.from(b64, "base64");
  return cert;
}

function __tlsSameName(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// checkServerIdentity (`lib/tls.js`)
// ---------------------------------------------------------------------------

function __tlsUnfqdn(host: string): string {
  return host.charAt(Number(host.length) - 1) === "." ? host.slice(0, Number(host.length) - 1) : host;
}

function __tlsSplitHost(host: string): string[] {
  return __tlsUnfqdn(host).toLowerCase().split(".");
}

function __tlsHasBadChar(text: string): boolean {
  const n: number = Number(text.length);
  let i = 0;
  while (i < n) {
    const c: number = Number(text.charCodeAt(i));
    if (c < 0x21 || c > 0x7f) return true;
    i = i + 1;
  }
  return false;
}

function __tlsCheckPattern(hostParts: string[], pattern: any, wildcards: boolean): boolean {
  if (pattern === undefined || pattern === null || pattern === "") return false;
  const patternParts: string[] = __tlsSplitHost(String(pattern));
  if (Number(hostParts.length) !== Number(patternParts.length)) return false;
  if (patternParts.indexOf("") !== -1) return false;
  for (const part of patternParts) if (__tlsHasBadChar(part)) return false;
  let i: number = Number(hostParts.length) - 1;
  while (i > 0) {
    if (hostParts[i] !== patternParts[i]) return false;
    i = i - 1;
  }
  const hostSub: string = hostParts[0];
  const patternSub: string = patternParts[0];
  const pieces: string[] = patternSub.split("*");
  if (Number(pieces.length) === 1 || patternSub.indexOf("xn--") !== -1) return hostSub === patternSub;
  if (!wildcards) return false;
  if (Number(pieces.length) > 2) return false;
  if (Number(patternParts.length) <= 2) return false;
  const prefix: string = pieces[0];
  const suffix: string = pieces[1];
  if (Number(prefix.length) + Number(suffix.length) > Number(hostSub.length)) return false;
  if (!hostSub.startsWith(prefix)) return false;
  if (!hostSub.endsWith(suffix)) return false;
  return true;
}

// Split `subjectaltname` on `, ` outside of quoted names.
function __tlsSplitAltNames(altNames: string): string[] {
  if (altNames.indexOf('"') === -1) return altNames.split(", ");
  const out: string[] = [];
  let current = "";
  let quoted = false;
  let i = 0;
  const n: number = Number(altNames.length);
  while (i < n) {
    const ch: string = altNames.charAt(i);
    if (quoted) {
      if (ch === "\\" && i + 1 < n) {
        current = current + altNames.charAt(i + 1);
        i = i + 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i = i + 1;
        continue;
      }
      current = current + ch;
      i = i + 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i = i + 1;
      continue;
    }
    if (ch === "," && altNames.charAt(i + 1) === " ") {
      out.push(current);
      current = "";
      i = i + 2;
      continue;
    }
    current = current + ch;
    i = i + 1;
  }
  out.push(current);
  return out;
}

function __tlsCanonicalIP(ip: string): string {
  if (__netIsIPv6(ip)) {
    const groups: any = __netIPv6Groups(ip, true);
    if (groups !== null && groups !== undefined && Array.isArray(groups)) {
      const parts: string[] = [];
      for (const g of groups) parts.push(Number(g).toString(16));
      return parts.join(":");
    }
    return ip.toLowerCase();
  }
  return ip;
}

function __tlsCheckServerIdentity(hostname: any, cert: any): any {
  const subject: any = cert === undefined || cert === null ? undefined : cert.subject;
  const altNames: any = cert === undefined || cert === null ? undefined : cert.subjectaltname;
  const dnsNames: string[] = [];
  const ips: string[] = [];
  const host: string = String(hostname);
  if (altNames !== undefined && altNames !== null && altNames !== "") {
    for (const name of __tlsSplitAltNames(String(altNames))) {
      if (name.startsWith("DNS:")) dnsNames.push(name.slice(4));
      else if (name.startsWith("IP Address:")) ips.push(__tlsCanonicalIP(name.slice(11)));
    }
  }
  let valid = false;
  let reason = "Unknown reason";
  const bare: string = __tlsUnfqdn(host);
  if (__netIsIP(bare) !== 0) {
    valid = ips.indexOf(__tlsCanonicalIP(bare)) !== -1;
    if (!valid) reason = "IP: " + bare + " is not in the cert's list: " + ips.join(", ");
  } else if (Number(dnsNames.length) > 0 || (subject !== undefined && subject !== null && subject.CN !== undefined)) {
    const hostParts: string[] = __tlsSplitHost(bare);
    if (Number(dnsNames.length) > 0) {
      for (const name of dnsNames) {
        if (__tlsCheckPattern(hostParts, name, true)) {
          valid = true;
          break;
        }
      }
      if (!valid) reason = "Host: " + bare + ". is not in the cert's altnames: " + String(altNames);
    } else {
      const cn: any = subject.CN;
      if (Array.isArray(cn)) {
        for (const one of cn) {
          if (__tlsCheckPattern(hostParts, one, true)) {
            valid = true;
            break;
          }
        }
      } else if (cn !== undefined && cn !== null && cn !== "") {
        valid = __tlsCheckPattern(hostParts, cn, true);
      }
      if (!valid) reason = "Host: " + bare + ". is not cert's CN: " + String(cn);
    }
  } else {
    reason = "Cert does not contain a DNS name";
  }
  if (!valid) return new ERR_TLS_CERT_ALTNAME_INVALID(reason, bare, cert);
  return undefined;
}

// ---------------------------------------------------------------------------
// TLSSocket (`lib/_tls_wrap.js`)
// ---------------------------------------------------------------------------

class TLSSocket extends Socket {
  encrypted: any = true;
  authorized: any = false;
  authorizationError: any = null;
  alpnProtocol: any = false;
  servername: any = undefined;
  server: any = undefined;
  secureConnecting: any = true;
  ssl: any = null;
  _secureEstablished: any = false;
  _tlsOptions: any = null;
  _tlsState: any = null;
  _rejectUnauthorized: any = true;
  _requestCert: any = false;

  constructor(socket?: any, options?: any) {
    const opts: any = options === undefined || options === null ? {} : options;
    super({ allowHalfOpen: opts.allowHalfOpen === true || (socket !== undefined && socket !== null && socket.allowHalfOpen === true) });
    const self: any = this;
    this._tlsOptions = opts;
    // A bare `new TLSSocket()` does not reject; `tls.connect` passes the
    // option explicitly (default true).
    this._rejectUnauthorized = opts.rejectUnauthorized === true;
    this._requestCert = opts.requestCert === true;
    if (opts.isServer === true) this.server = opts.server;
    this.ssl = {};
    let ctx: any = opts.secureContext;
    if (ctx === undefined || ctx === null) ctx = __tlsCreateSecureContext(opts);
    let raw: any = socket;
    let ownsRaw = false;
    if (raw === undefined || raw === null) {
      raw = new Socket({ allowHalfOpen: opts.allowHalfOpen === true });
      ownsRaw = true;
    }
    this._tlsState = {
      raw: raw,
      ownsRaw: ownsRaw,
      ctx: ctx,
      handle: 0,
      isServer: opts.isServer === true,
      started: false,
      secured: false,
      eof: false,
      closeSent: false,
      info: null,
      verifyError: null,
      host: opts.host,
      session: null,
      helloSeen: false,
      pendingFinal: null,
    };
    // A TLS socket has no I/O handle of its own: the hooks below replace the
    // ones `Socket`'s constructor installed.
    __sSetOptFn(self, "read", function (): void {
      __tlsReadHook(self);
    });
    __sSetOptFn(self, "write", function (chunk: any, encoding: any, cb: any): void {
      __tlsWriteHook(self, chunk, encoding, cb);
    });
    __sSetOptFn(self, "final", function (cb: any): void {
      __tlsFinalHook(self, cb);
    });
    __sSetOptFn(self, "destroy", function (err: any, cb: any): void {
      __tlsDestroyHook(self, err, cb);
    });
    this.connecting = raw.connecting === true;
    if (raw.connecting === true) {
      raw.once("connect", function (): void {
        __tlsOnRawConnect(self);
      });
    } else {
      __tlsCopyAddresses(self);
    }
    raw.on("data", function (chunk: any): void {
      __tlsOnRawData(self, chunk);
    });
    raw.on("end", function (): void {
      __tlsOnRawEnd(self);
    });
    raw.on("close", function (): void {
      __tlsOnRawClose(self);
    });
    raw.on("error", function (err: any): void {
      __tlsOnRawError(self, err);
    });
    raw.on("timeout", function (): void {
      // A timeout armed on the TCP socket is the TLS socket's own.
      self.emit("timeout");
    });
    if (opts.isServer === true) __tlsStart(self);
  }

  connect(a?: any, b?: any, c?: any, d?: any): any {
    const st: any = this._tlsState;
    const self: any = this;
    this.connecting = true;
    st.raw.once("connect", function (): void {
      __tlsOnRawConnect(self);
    });
    st.raw.connect(a, b, c, d);
    return this;
  }

  ref(): any {
    const raw: any = this._tlsState.raw;
    if (raw !== null && typeof raw.ref === "function") raw.ref();
    return this;
  }

  unref(): any {
    const raw: any = this._tlsState.raw;
    if (raw !== null && typeof raw.unref === "function") raw.unref();
    return this;
  }

  setNoDelay(enable?: any): any {
    const raw: any = this._tlsState.raw;
    if (typeof raw.setNoDelay === "function") raw.setNoDelay(enable);
    return this;
  }

  setKeepAlive(enable?: any, initialDelay?: any): any {
    const raw: any = this._tlsState.raw;
    if (typeof raw.setKeepAlive === "function") raw.setKeepAlive(enable, initialDelay);
    return this;
  }

  address(): any {
    const raw: any = this._tlsState.raw;
    if (typeof raw.address === "function") return raw.address();
    return {};
  }

  getPeerCertificate(detailed?: any): any {
    return __tlsGetPeerCertificate(this, detailed === true);
  }

  getCertificate(): any {
    const ctx: any = this._tlsState.ctx;
    if (ctx === null || ctx === undefined || Number(ctx._tls.cert.length) === 0) return null;
    const ders: string = String(__tlsNative.tlsPemToDer(ctx._tls.cert[0]));
    if (ders.charAt(0) !== "+" || ders === "+") return null;
    return __tlsDescribeCert(ders.slice(1).split(__TLS_GS)[0]);
  }

  getPeerX509Certificate(): any {
    return undefined;
  }

  getX509Certificate(): any {
    return undefined;
  }

  getCipher(): any {
    const info: any = this._tlsState.info;
    if (info === null || info === undefined) return null;
    return { name: info.cipher, standardName: info.standardName, version: info.cipherVersion };
  }

  getProtocol(): any {
    const info: any = this._tlsState.info;
    if (info === null || info === undefined) return null;
    return info.protocol;
  }

  getSession(): any {
    return undefined;
  }

  getTLSTicket(): any {
    return undefined;
  }

  isSessionReused(): boolean {
    return false;
  }

  setSession(session: any): void {
    this._tlsState.session = session;
  }

  getFinished(): any {
    return undefined;
  }

  getPeerFinished(): any {
    return undefined;
  }

  getEphemeralKeyInfo(): any {
    if (this._tlsState.isServer === true) return null;
    return {};
  }

  getSharedSigalgs(): any {
    return [];
  }

  exportKeyingMaterial(length: any, label: any, context?: any): any {
    throw new NodeError("ERR_TLS_EXPORT_KEYING_MATERIAL", "exportKeyingMaterial is not supported on this runtime");
  }

  setMaxSendFragment(size: any): boolean {
    if (typeof size !== "number") throw new ERR_INVALID_ARG_TYPE("size", "number", size);
    if (!(size >= 512 && size <= 16384)) throw new ERR_OUT_OF_RANGE("size", ">= 512 && <= 16384", size);
    return true;
  }

  setServername(name: any): void {
    if (typeof name !== "string") throw new ERR_INVALID_ARG_TYPE("name", "string", name);
    if (this._tlsState.isServer === true) {
      throw new NodeError("ERR_TLS_SNI_FROM_SERVER", "Cannot issue SNI from a TLS server-side socket");
    }
    this._tlsOptions.servername = name;
  }

  renegotiate(options: any, callback?: any): any {
    if (options === null || typeof options !== "object") throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
    if (callback !== undefined && typeof callback !== "function") throw new ERR_INVALID_ARG_TYPE("callback", "Function", callback);
    const self: any = this;
    if (callback !== undefined) {
      __netTick(function (): void {
        callback(new NodeError("ERR_TLS_RENEGOTIATE", "Attempt to renegotiate TLS session failed"));
      });
    }
    return false;
  }

  disableRenegotiation(): void {}

  enableTrace(): void {}
}

function __tlsCopyAddresses(self: any): void {
  const raw: any = self._tlsState.raw;
  const state: any = self._sockState;
  if (raw._sockState !== undefined && raw._sockState !== null) {
    // Populate the raw socket's caches, then share them.
    const local: any = raw.address();
    const remote: any = raw.remoteAddress;
    if (raw._sockState.local !== null) state.local = raw._sockState.local;
    if (raw._sockState.peer !== null) state.peer = raw._sockState.peer;
  }
}

function __tlsOnRawConnect(self: any): void {
  __tlsCopyAddresses(self);
  self.connecting = false;
  if (self.destroyed === true) return;
  self.emit("connect");
}

// Build the engine session and send whatever the first flight is (a client's
// ClientHello; nothing for a server).
function __tlsStart(self: any): void {
  const st: any = self._tlsState;
  if (st.started === true) return;
  st.started = true;
  const opts: any = self._tlsOptions;
  const extra: any[] = __tlsSessionExtras(self);
  if (st.isServer === true) {
    const server: any = opts.server;
    if (server !== undefined && server !== null && server._tlsServerState !== undefined && server._tlsServerState !== null) {
      for (const entry of server._tlsServerState.contexts) {
        const c: any = entry.ctx._tls;
        if (Number(c.cert.length) > 0 && Number(c.key.length) > 0) {
          extra.push(["sni", String(entry.name) + __TLS_GS + c.cert[0] + __TLS_GS + c.key[0]]);
        }
      }
      // An `SNICallback` is asynchronous: the session stops after the
      // ClientHello (`H` in the poll record) until the callback answers.
      if (typeof server._tlsServerState.options.SNICallback === "function") extra.push(["lazy", "1"]);
    }
  } else {
    const name: any = opts.servername;
    if (name !== undefined && name !== null && name !== "" && __netIsIP(String(name)) === 0) {
      extra.push(["servername", String(name)]);
    }
  }
  const result: string = String(__tlsNative.tlsSessionNew(st.isServer === true, __tlsContextRecord(st.ctx, extra)));
  if (result.charAt(0) !== "+") {
    const err: any = __tlsNativeError();
    __netTick(function (): void {
      __tlsHandshakeFailed(self, err);
    });
    return;
  }
  st.handle = Number(result.slice(1));
  __tlsApply(self, String(__tlsNative.tlsPoll(Number(st.handle))));
}

// The per-socket engine options a context record does not carry.
function __tlsSessionExtras(self: any): any[] {
  const st: any = self._tlsState;
  const opts: any = self._tlsOptions;
  const extra: any[] = [];
  const alpn: string[] = __tlsAlpnList(opts.ALPNProtocols);
  if (Number(alpn.length) > 0) extra.push(["alpn", alpn.join(__TLS_GS)]);
  if (st.isServer === true && self._requestCert === true) extra.push(["requestCert", "1"]);
  return extra;
}

// The ClientHello of a lazy server session is in: ask `SNICallback` for the
// context, then let the handshake continue with it.
function __tlsOnHello(self: any, name: string): void {
  const st: any = self._tlsState;
  if (st.helloSeen === true) return;
  st.helloSeen = true;
  const server: any = self._tlsOptions.server;
  const cb: any = server === undefined || server === null ? undefined : server._tlsServerState.options.SNICallback;
  if (name === "" || typeof cb !== "function") {
    __tlsAcceptWith(self, st.ctx);
    return;
  }
  let answered = false;
  cb(name, function (err: any, ctx: any): void {
    if (answered) return;
    answered = true;
    if (self.destroyed === true) return;
    if (err !== undefined && err !== null) {
      __tlsHandshakeFailed(self, err);
      return;
    }
    if (ctx === undefined || ctx === null) {
      __tlsAcceptWith(self, st.ctx);
      return;
    }
    if (!(ctx instanceof SecureContext)) {
      __tlsHandshakeFailed(self, new NodeTypeError("ERR_TLS_INVALID_CONTEXT", "Invalid SNI context"));
      return;
    }
    __tlsAcceptWith(self, ctx);
  });
}

function __tlsAcceptWith(self: any, ctx: any): void {
  const st: any = self._tlsState;
  if (Number(st.handle) === 0) return;
  st.ctx = ctx;
  const record: string = __tlsContextRecord(ctx, __tlsSessionExtras(self));
  __tlsApply(self, String(__tlsNative.tlsServerAccept(Number(st.handle), record)));
}

function __tlsRawWrite(self: any, b64: string, cb: any): void {
  const raw: any = self._tlsState.raw;
  if (b64 === "") {
    if (cb !== undefined && cb !== null) cb(null);
    return;
  }
  if (raw.destroyed === true || raw.writableEnded === true) {
    if (cb !== undefined && cb !== null) cb(null);
    return;
  }
  const bytes: Buffer = Buffer.from(b64, "base64");
  if (cb !== undefined && cb !== null) raw.write(bytes, cb);
  else raw.write(bytes);
}

// Act on one poll record.
function __tlsApply(self: any, result: string): boolean {
  const st: any = self._tlsState;
  if (result.charAt(0) !== "+") {
    const err: any = __tlsNativeError();
    const alert: string = String(__tlsNative.tlsTakeAlert());
    __tlsRawWrite(self, alert, null);
    __tlsHandshakeFailed(self, err);
    return false;
  }
  const fields: string[] = result.slice(1).split(__TLS_US);
  if (fields[0] === "H") {
    __tlsOnHello(self, String(fields[4]));
    return true;
  }
  __tlsRawWrite(self, fields[1], null);
  if (fields[0] === "1" && st.secured !== true) {
    __tlsOnSecure(self);
    if (self.destroyed === true) return false;
  }
  if (fields[2] !== "") {
    const chunk: Buffer = Buffer.from(fields[2], "base64");
    __netResetTimeout(self);
    if (self.push(chunk) !== true) {
      const raw: any = st.raw;
      if (typeof raw.pause === "function") raw.pause();
    }
  }
  if (fields[3] === "1") __tlsOnEnd(self);
  return true;
}

function __tlsParseInfo(self: any): any {
  const st: any = self._tlsState;
  const result: string = String(__tlsNative.tlsInfo(Number(st.handle)));
  if (result.charAt(0) !== "+") return null;
  const f: string[] = result.slice(1).split(__TLS_US);
  return {
    protocol: f[0],
    cipher: f[1],
    standardName: f[2],
    cipherVersion: f[3],
    alpn: f[4] === "" ? false : Buffer.from(f[4], "base64").toString("latin1"),
    servername: f[5],
    verifyCode: f[6],
    verifyMessage: f[7],
    chain: f[8] === "" ? [] : f[8].split(__TLS_GS),
  };
}

function __tlsOnSecure(self: any): void {
  __tlsOnSecureInner(self);
  const st: any = self._tlsState;
  const pending: any = st.pendingFinal;
  if (pending !== null && pending !== undefined && self.destroyed !== true) {
    st.pendingFinal = null;
    __tlsFinalHook(self, pending);
  }
}

function __tlsOnSecureInner(self: any): void {
  const st: any = self._tlsState;
  st.secured = true;
  self._secureEstablished = true;
  self.secureConnecting = false;
  const info: any = __tlsParseInfo(self);
  st.info = info;
  if (info === null) return;
  self.alpnProtocol = info.alpn;
  const opts: any = self._tlsOptions;
  if (st.isServer === true) {
    self.servername = info.servername === "" ? false : info.servername;
    if (self._requestCert === true) {
      let code: string = info.verifyCode;
      if (Number(info.chain.length) === 0) code = "UNABLE_TO_GET_ISSUER_CERT";
      if (code !== "") {
        self.authorized = false;
        self.authorizationError = code;
        if (self._rejectUnauthorized === true) {
          self.destroy();
          return;
        }
      } else {
        self.authorized = true;
      }
    }
    self.emit("secure");
    const server: any = opts.server;
    if (server !== undefined && server !== null && self.destroyed !== true) {
      server.emit("secureConnection", self);
    }
    return;
  }
  // Client: the chain verdict, then the host name.
  let verifyError: any = null;
  if (info.verifyCode !== "") {
    verifyError = new __TlsVerifyError(info.verifyCode, info.verifyMessage);
  } else {
    const hostname: any =
      opts.servername !== undefined && opts.servername !== null && opts.servername !== ""
        ? opts.servername
        : opts.host !== undefined && opts.host !== null
          ? opts.host
          : "localhost";
    const cert: any = self.getPeerCertificate(true);
    const checker: any = opts.checkServerIdentity !== undefined && opts.checkServerIdentity !== null ? opts.checkServerIdentity : __tlsCheckServerIdentity;
    const err: any = checker(String(hostname), cert);
    if (err !== undefined && err !== null) verifyError = err;
  }
  if (verifyError !== null) {
    self.authorized = false;
    self.authorizationError = verifyError.code !== undefined && verifyError.code !== null && verifyError.code !== "" ? verifyError.code : verifyError.message;
    if (self._rejectUnauthorized === true) {
      self.destroy(verifyError);
      return;
    }
  } else {
    self.authorized = true;
  }
  self.emit("secureConnect");
}

function __tlsHandshakeFailed(self: any, err: any): void {
  const st: any = self._tlsState;
  if (self.destroyed === true) return;
  if (st.isServer === true) {
    const server: any = self._tlsOptions.server;
    if (server !== undefined && server !== null && st.secured !== true) {
      if (server.listenerCount("tlsClientError") > 0) server.emit("tlsClientError", err, self);
      self.destroy();
      return;
    }
  }
  self.destroy(err);
}

function __tlsOnRawData(self: any, chunk: any): void {
  const st: any = self._tlsState;
  if (Number(st.handle) === 0 || self.destroyed === true) return;
  const b64: string = __netToBase64(chunk, undefined);
  __tlsApply(self, String(__tlsNative.tlsFeed(Number(st.handle), b64)));
}

function __tlsOnEnd(self: any): void {
  const st: any = self._tlsState;
  if (st.eof === true) return;
  st.eof = true;
  self._sockState.eof = true;
  self.push(null);
  if (self.allowHalfOpen !== true) {
    if (self.writable === true) self.end();
    else __netMaybeDestroy(self);
  } else {
    __netMaybeDestroy(self);
  }
}

function __tlsResetError(self: any): any {
  const opts: any = self._tlsOptions;
  const err: any = new __TlsConnResetError(
    "Client network socket disconnected before secure TLS connection was established",
  );
  err.host = opts.host;
  err.port = opts.port;
  err.localAddress = opts.localAddress;
  return err;
}

function __tlsOnRawEnd(self: any): void {
  const st: any = self._tlsState;
  if (st.secured !== true) {
    if (self.destroyed === true) return;
    if (st.isServer === true) {
      __tlsHandshakeFailed(self, __tlsResetError(self));
    } else {
      self.destroy(__tlsResetError(self));
    }
    return;
  }
  // A TCP end without `close_notify` still ends the stream.
  __tlsOnEnd(self);
}

function __tlsOnRawClose(self: any): void {
  if (self.destroyed === true) return;
  const st: any = self._tlsState;
  if (st.secured !== true && st.isServer !== true) {
    self.destroy(__tlsResetError(self));
    return;
  }
  if (st.secured !== true) {
    __tlsHandshakeFailed(self, __tlsResetError(self));
    return;
  }
  self.destroy();
}

function __tlsOnRawError(self: any, err: any): void {
  if (self.destroyed === true) return;
  const st: any = self._tlsState;
  if (st.isServer === true && st.secured !== true) {
    __tlsHandshakeFailed(self, err);
    return;
  }
  self.destroy(err);
}

function __tlsReadHook(self: any): void {
  const raw: any = self._tlsState.raw;
  if (raw !== null && typeof raw.isPaused === "function" && raw.isPaused() === true) raw.resume();
}

function __tlsWriteHook(self: any, chunk: any, encoding: any, cb: any): void {
  const st: any = self._tlsState;
  if (Number(st.handle) === 0) {
    if (st.started !== true) {
      // A client socket whose handshake has not been started yet (a bare
      // `new TLSSocket(socket)`): Node buffers the write as well.
      __tlsStart(self);
    }
    if (Number(st.handle) === 0) {
      __netInvoke(cb, [new ERR_SOCKET_CLOSED()]);
      return;
    }
  }
  const b64: string = __netToBase64(chunk, encoding);
  const result: string = String(__tlsNative.tlsWrite(Number(st.handle), b64));
  __netResetTimeout(self);
  if (result.charAt(0) !== "+") {
    __tlsApply(self, result);
    __netInvoke(cb, [null]);
    return;
  }
  const fields: string[] = result.slice(1).split(__TLS_US);
  if (fields[1] === "") {
    __netInvoke(cb, [null]);
    return;
  }
  __tlsRawWrite(self, fields[1], function (err: any): void {
    __netInvoke(cb, [err === undefined ? null : err]);
  });
}

function __tlsFinalHook(self: any, cb: any): void {
  const st: any = self._tlsState;
  // A `close_notify` sent mid-handshake aborts it, so an `end()` issued
  // before the session is up waits for it, as Node's does.
  if (st.secured !== true && Number(st.handle) !== 0) {
    st.pendingFinal = cb;
    return;
  }
  if (Number(st.handle) !== 0 && st.closeSent !== true) {
    st.closeSent = true;
    const result: string = String(__tlsNative.tlsCloseNotify(Number(st.handle)));
    if (result.charAt(0) === "+") {
      const fields: string[] = result.slice(1).split(__TLS_US);
      __tlsRawWrite(self, fields[1], null);
    }
  }
  const raw: any = st.raw;
  if (raw.writableEnded !== true && raw.destroyed !== true) raw.end();
  __netInvoke(cb, [null]);
}

function __tlsDestroyHook(self: any, err: any, cb: any): void {
  const st: any = self._tlsState;
  if (Number(st.handle) !== 0) {
    __tlsNative.tlsFree(Number(st.handle));
    st.handle = 0;
  }
  __netClearTimeout(self);
  const raw: any = st.raw;
  if (raw !== null && raw.destroyed !== true) {
    // The TCP side is closed with a FIN after the queued ciphertext (an
    // alert or `close_notify` included), even when the TLS socket is
    // destroyed with an error: OpenSSL's peer sees an orderly close, while an
    // abortive one surfaces as ECONNRESET/ECONNABORTED on the other end.
    if (typeof raw.destroySoon === "function") raw.destroySoon();
    else raw.destroy();
  }
  __netInvoke(cb, [err === undefined ? null : err]);
  const hadError: boolean = err !== undefined && err !== null;
  __netTick(__netEmitClose, self, hadError);
}

function __tlsGetPeerCertificate(self: any, detailed: boolean): any {
  const st: any = self._tlsState;
  const info: any = st.info;
  if (info === null || info === undefined) return null;
  const chain: string[] = info.chain;
  if (Number(chain.length) === 0) return {};
  const certs: any[] = [];
  for (const b64 of chain) certs.push(__tlsDescribeCert(b64));
  const first: any = certs[0];
  if (!detailed) return first;
  let i = 0;
  const n: number = Number(certs.length);
  while (i < n) {
    const cert: any = certs[i];
    if (i + 1 < n) cert.issuerCertificate = certs[i + 1];
    else if (__tlsSameName(cert.subject, cert.issuer)) cert.issuerCertificate = cert;
    else {
      // The chain stops short of its root: look the issuer up among the
      // context's CAs, as OpenSSL's verified chain would include it.
      const ctx: any = st.ctx;
      const cas: string[] = ctx === null || ctx === undefined ? [] : ctx._tls.ca;
      for (const ca of cas) {
        const ders: string = String(__tlsNative.tlsPemToDer(ca));
        if (ders.charAt(0) !== "+" || ders === "+") continue;
        for (const der of ders.slice(1).split(__TLS_GS)) {
          const root: any = __tlsDescribeCert(der);
          if (root !== null && __tlsSameName(root.subject, cert.issuer)) {
            cert.issuerCertificate = root;
            if (__tlsSameName(root.subject, root.issuer)) root.issuerCertificate = root;
          }
        }
      }
    }
    i = i + 1;
  }
  return first;
}

// ---------------------------------------------------------------------------
// connect (`lib/_tls_wrap.js`)
// ---------------------------------------------------------------------------

function __tlsRejectDefault(): boolean {
  const env: any = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  return !(env === "0");
}

function __tlsConnect(a?: any, b?: any, c?: any, d?: any): any {
  let options: any = {};
  let callback: any = undefined;
  if (a !== null && typeof a === "object") {
    options = __httpLikeMerge(a, null);
    if (typeof b === "function") callback = b;
  } else {
    const port: any = a;
    if (typeof b === "string") {
      options.host = b;
      if (c !== null && typeof c === "object") {
        options = __httpLikeMerge(c, options);
        if (typeof d === "function") callback = d;
      } else if (typeof c === "function") callback = c;
    } else if (b !== null && typeof b === "object") {
      options = __httpLikeMerge(b, null);
      if (typeof c === "function") callback = c;
    } else if (typeof b === "function") {
      callback = b;
    }
    if (port !== undefined) options.port = port;
  }
  if (options.rejectUnauthorized === undefined) options.rejectUnauthorized = __tlsRejectDefault();
  if (options.checkServerIdentity !== undefined && options.checkServerIdentity !== null && typeof options.checkServerIdentity !== "function") {
    throw new ERR_INVALID_ARG_TYPE("options.checkServerIdentity", "function", options.checkServerIdentity);
  }
  if (options.servername !== undefined && options.servername !== null && typeof options.servername !== "string") {
    throw new ERR_INVALID_ARG_TYPE("options.servername", "string", options.servername);
  }
  if (options.servername !== undefined && options.servername !== null && __netIsIP(String(options.servername)) !== 0) {
    throw new ERR_INVALID_ARG_VALUE("options.servername", options.servername, "must not be an IP address");
  }
  const host: string = options.host === undefined || options.host === null ? "localhost" : String(options.host);
  if (options.servername === undefined || options.servername === null) {
    if (__netIsIP(host) === 0) options.servername = host;
  }
  options.isServer = false;
  if (options.secureContext === undefined || options.secureContext === null) {
    options.secureContext = __tlsCreateSecureContext(options);
  }
  const given: any = options.socket;
  const tlssock: any = new TLSSocket(given === undefined || given === null ? undefined : given, options);
  tlssock.servername = options.servername;
  if (callback !== undefined) tlssock.once("secureConnect", callback);
  if (options.timeout !== undefined && options.timeout !== null) tlssock.setTimeout(options.timeout);
  if (given === undefined || given === null) {
    const connectOpts: any = {
      port: options.port,
      host: host,
      localAddress: options.localAddress,
      localPort: options.localPort,
      family: options.family,
      lookup: options.lookup,
      autoSelectFamily: options.autoSelectFamily,
    };
    if (options.path !== undefined && options.path !== null) connectOpts.path = options.path;
    for (const key of Object.keys(connectOpts)) if (connectOpts[key] === undefined) delete connectOpts[key];
    tlssock.connect(connectOpts);
  }
  __tlsStart(tlssock);
  return tlssock;
}

function __httpLikeMerge(a: any, b: any): any {
  const out: any = {};
  if (b !== undefined && b !== null) {
    for (const key of Object.keys(b)) out[key] = b[key];
  }
  if (a !== undefined && a !== null) {
    for (const key of Object.keys(a)) out[key] = a[key];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function __tlsServerInit(server: any, options: any): void {
  const opts: any = options === undefined || options === null ? {} : options;
  if (opts.handshakeTimeout !== undefined && opts.handshakeTimeout !== null && typeof opts.handshakeTimeout !== "number") {
    throw new ERR_INVALID_ARG_TYPE("options.handshakeTimeout", "number", opts.handshakeTimeout);
  }
  if (opts.SNICallback !== undefined && opts.SNICallback !== null && typeof opts.SNICallback !== "function") {
    throw new ERR_INVALID_ARG_TYPE("options.SNICallback", "function", opts.SNICallback);
  }
  if (opts.ALPNCallback !== undefined && opts.ALPNCallback !== null) {
    if (typeof opts.ALPNCallback !== "function") throw new ERR_INVALID_ARG_TYPE("options.ALPNCallback", "function", opts.ALPNCallback);
    if (opts.ALPNProtocols !== undefined && opts.ALPNProtocols !== null) {
      throw new NodeTypeError("ERR_TLS_ALPN_CALLBACK_WITH_PROTOCOLS", "The ALPNCallback and ALPNProtocols TLS options are mutually exclusive");
    }
  }
  server._tlsServerState = {
    options: opts,
    ctx: __tlsCreateSecureContext(opts),
    contexts: [],
    ticketKeys: __tlsRandomTicketKeys(),
  };
}

function __tlsRandomTicketKeys(): Buffer {
  const out: Buffer = Buffer.alloc(48);
  let i = 0;
  while (i < 48) {
    out[i] = Math.floor(Math.random() * 256);
    i = i + 1;
  }
  return out;
}

function __tlsServerAccept(server: any, raw: any, onSecure: any): any {
  const st: any = server._tlsServerState;
  const opts: any = st.options;
  const tlsOpts: any = {
    isServer: true,
    server: server,
    secureContext: st.ctx,
    requestCert: opts.requestCert === true,
    rejectUnauthorized: opts.rejectUnauthorized !== false,
    ALPNProtocols: opts.ALPNProtocols,
    allowHalfOpen: server.allowHalfOpen === true,
  };
  const sock: any = new TLSSocket(raw, tlsOpts);
  const timeout: number = opts.handshakeTimeout === undefined ? 120000 : Number(opts.handshakeTimeout);
  if (timeout > 0) {
    const timer: any = setTimeout(function (): void {
      if (sock._secureEstablished !== true && sock.destroyed !== true) {
        const err: any = new NodeError("ERR_TLS_HANDSHAKE_TIMEOUT", "TLS handshake timeout");
        __tlsHandshakeFailed(sock, err);
      }
    }, timeout);
    if (timer !== null && timer !== undefined && typeof timer.unref === "function") timer.unref();
    sock.once("secure", function (): void {
      clearTimeout(timer);
    });
    sock.once("close", function (): void {
      clearTimeout(timer);
    });
  }
  if (onSecure !== null && onSecure !== undefined) {
    sock.once("secure", function (): void {
      onSecure(sock);
    });
  }
  return sock;
}

function __tlsServerAddContext(server: any, servername: any, context: any): void {
  if (typeof servername !== "string") throw new ERR_INVALID_ARG_TYPE("servername", "string", servername);
  if (servername === "") throw new ERR_INVALID_ARG_VALUE("servername", servername, "must not be empty");
  const ctx: any = context instanceof SecureContext ? context : __tlsCreateSecureContext(context);
  server._tlsServerState.contexts.push({ name: servername, ctx: ctx });
}

function __tlsServerSetSecureContext(server: any, options: any): void {
  const st: any = server._tlsServerState;
  const merged: any = __httpLikeMerge(options, null);
  st.ctx = __tlsCreateSecureContext(merged);
  for (const key of Object.keys(merged)) st.options[key] = merged[key];
}

function __tlsServerSetTicketKeys(server: any, keys: any): void {
  if (!__tlsIsBytes(keys)) throw new ERR_INVALID_ARG_TYPE("buffer", ["Buffer", "TypedArray", "DataView"], keys);
  const bytes: Buffer = Buffer.from(__tlsB64(keys), "base64");
  if (Number(bytes.length) !== 48) {
    throw new ERR_INVALID_ARG_VALUE("keys", keys, "Session ticket keys must be a 48-byte buffer");
  }
  server._tlsServerState.ticketKeys = bytes;
}

class __TlsServer extends Server {
  _tlsServerState: any = null;

  constructor(options?: any, listener?: any) {
    let opts: any = options;
    let cb: any = listener;
    if (typeof opts === "function") {
      cb = opts;
      opts = {};
    } else if (opts === undefined || opts === null) {
      opts = {};
    } else if (typeof opts !== "object" || Array.isArray(opts)) {
      throw new ERR_INVALID_ARG_TYPE("options", "Object", options);
    }
    super({
      allowHalfOpen: opts.allowHalfOpen === true,
      pauseOnConnect: opts.pauseOnConnect === true,
      noDelay: opts.noDelay === true,
      keepAlive: opts.keepAlive === true,
      keepAliveInitialDelay: opts.keepAliveInitialDelay,
      highWaterMark: opts.highWaterMark,
    });
    __tlsServerInit(this, opts);
    const self: any = this;
    this.on("connection", function (raw: any): void {
      __tlsServerAccept(self, raw, null);
    });
    if (cb !== undefined && cb !== null) this.on("secureConnection", cb);
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

function __tlsCreateServer(options?: any, listener?: any): any {
  return new __TlsServer(options, listener);
}

function __tlsConvertALPNProtocols(protocols: any, out: any): void {
  if (Array.isArray(protocols)) {
    const parts: Buffer[] = [];
    for (const p of protocols) {
      const bytes: Buffer = Buffer.from(__tlsB64(p), "base64");
      const len: number = Number(bytes.length);
      if (len > 255) {
        throw new ERR_OUT_OF_RANGE("The byte length of the protocol at index " + String(parts.length), "<= 255", len);
      }
      const head: Buffer = Buffer.alloc(1);
      head[0] = len;
      parts.push(head);
      parts.push(bytes);
    }
    out.ALPNProtocols = Buffer.concat(parts);
  } else if (__tlsIsBytes(protocols)) {
    out.ALPNProtocols = Buffer.from(__tlsB64(protocols), "base64");
  }
}

function __tlsGetCiphers(): string[] {
  return [
    "aes128-gcm-sha256", "aes256-gcm-sha384",
    "ecdhe-ecdsa-aes128-gcm-sha256", "ecdhe-ecdsa-aes256-gcm-sha384", "ecdhe-ecdsa-chacha20-poly1305",
    "ecdhe-rsa-aes128-gcm-sha256", "ecdhe-rsa-aes256-gcm-sha384", "ecdhe-rsa-chacha20-poly1305",
    "tls_aes_128_gcm_sha256", "tls_aes_256_gcm_sha384", "tls_chacha20_poly1305_sha256",
  ];
}

const __node_tls: any = {
  CLIENT_RENEG_LIMIT: 3,
  CLIENT_RENEG_WINDOW: 600,
  DEFAULT_ECDH_CURVE: "auto",
  DEFAULT_CIPHERS: __TLS_DEFAULT_CIPHERS,
  rootCertificates: [],
  SecureContext: SecureContext,
  TLSSocket: TLSSocket,
  // A factory, as http's `Server` is: Node lets `tls.Server(...)` be called
  // without `new`, and a class cannot be called in this engine.
  Server(options?: any, listener?: any): any {
    return __tlsCreateServer(options, listener);
  },
  connect(a?: any, b?: any, c?: any, d?: any): any {
    return __tlsConnect(a, b, c, d);
  },
  createServer(options?: any, listener?: any): any {
    return __tlsCreateServer(options, listener);
  },
  createSecureContext(options?: any): any {
    return __tlsCreateSecureContext(options);
  },
  checkServerIdentity(hostname: any, cert: any): any {
    return __tlsCheckServerIdentity(hostname, cert);
  },
  getCiphers(): string[] {
    return __tlsGetCiphers();
  },
  getCACertificates(type?: any): any {
    if (type !== undefined && type !== "default" && type !== "system" && type !== "bundled" && type !== "extra") {
      throw new ERR_INVALID_ARG_VALUE("type", type, "must be one of 'default', 'system', 'bundled', 'extra'");
    }
    return [];
  },
  setDefaultCACertificates(certs: any): void {
    if (!Array.isArray(certs)) throw new ERR_INVALID_ARG_TYPE("certs", "Array", certs);
  },
  convertALPNProtocols(protocols: any, out: any): void {
    __tlsConvertALPNProtocols(protocols, out);
  },
  get DEFAULT_MIN_VERSION(): any {
    return __tlsDefaults.minVersion;
  },
  set DEFAULT_MIN_VERSION(value: any) {
    __tlsDefaults.minVersion = value;
  },
  get DEFAULT_MAX_VERSION(): any {
    return __tlsDefaults.maxVersion;
  },
  set DEFAULT_MAX_VERSION(value: any) {
    __tlsDefaults.maxVersion = value;
  },
};

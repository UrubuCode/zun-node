// node:crypto — the Node-shaped `crypto` module, in Zun TypeScript over the
// native `node:crypto` extension.
//
// Behavior is defined by Node.js 25: this module is finished when it passes
// Node's own `test/parallel/test-crypto*.js` files (see ../../test/crypto/).
// The API shaping follows Node's `lib/crypto.js` and `lib/internal/crypto/*`
// (MIT, Copyright Joyent, Inc. and other Node contributors) instruction for
// instruction — `hash.js`' `Hash`/`Hmac` `Transform` wrappers and their
// `ERR_CRYPTO_HASH_FINALIZED` bookkeeping, `cipher.js`' `update`/`final`
// encoding rules and its single-`StringDecoder` "Cannot change encoding"
// assertion, `pbkdf2.js`/`scrypt.js`/`hkdf.js`' argument normalisation,
// `random.js`' `randomInt` rejection sampling and `randomUUID` layout, and
// `util.js`' `getCipherInfo` — because the observable contract of Node's
// `crypto` *is* that code: which error a bad encoding produces, when a
// deprecation warning is emitted, and what `getCipherInfo` leaves out are
// pinned by the corpus and not derivable from any general rule.
//
// ---------------------------------------------------------------------------
// Why this module is split in two
// ---------------------------------------------------------------------------
//
// `crypto` is a *TS-over-natives* module, the shape `node:os` established and
// `node:fs`/`node:zlib` repeated, and the line is PLAN.md principle 2:
//
//   * `src/crypto/*.rs` answers only what needs a cryptographic primitive: one
//     hash/HMAC state or one cipher per handle, the three KDFs, the OS random
//     source, the constant-time compare and the algorithm catalogue. It knows
//     nothing about streams, option objects, encodings or Node errors.
//   * this file is everything that is shape rather than cryptography — the
//     `Hash`/`Hmac`/`Cipheriv`/`Decipheriv` `Transform` classes, the `create*`
//     factories, the sync and callback KDF forms, the `random*` family,
//     `KeyObject`, `constants`, the encoding handling and every `ERR_*` error.
//
// Nothing structured crosses ABI v1, whose carrier is one scalar word, so the
// natives hand this file status-prefixed, separator-delimited strings and this
// file parses them; the grammar is documented in `src/crypto/mod.rs`:
//
//     result  := "+" payload | "-"        payload := field (US field)*
//     US = U+001F     RS = U+001E
//
// A leading "-" means the call failed, and the two error slots
// (`cryptoErrorCode`, `cryptoErrorMessage`) then hold exactly what Node's
// error reports — which is why a last block with no PKCS#7 padding here raises
// the same `ERR_OSSL_BAD_DECRYPT` with the same
// `error:1C800064:Provider routines::bad decrypt` message it raises in Node.
// Failure is reported in band rather than through the ABI status for the
// reason `src/fs/fs.ts` gives (https://github.com/UrubuCode/zun/issues/33).
//
// Keys, data, digests and ciphertexts cross as **base64**, the convention
// `node:fs` set: the `Str` carrier is a NUL-terminated C string and none of
// those is either NUL-free or UTF-8. The engine's prelude `Buffer` implements
// that codec on both sides.
//
// ---------------------------------------------------------------------------
// Engine workarounds in this file, each tied to an open zun issue
// (https://github.com/UrubuCode/zun/issues)
// ---------------------------------------------------------------------------
//   * `__cAsBuffer` before anything is read off a byte view that arrived
//     through an `any`: a typed array is *opaque* through `any` in this engine
//     (zun#38) — no `length`, no indexing, no `toString` — so every key, IV,
//     AAD and data chunk this module receives is re-typed first. The same bug
//     caps what the corpus can observe: a `Buffer` this module *returns*
//     (`createHash('sha1').update(x).digest()`, `randomBytes(16)`) reaches the
//     test through an `any` binding, where `.length` reads `undefined` and
//     `.toString()` throws. That is why the tests this module passes are the
//     ones that ask for a *string* digest (`digest('hex')`, `digest('base64')`)
//     or assert on errors, and not the ones that compare raw buffers. See
//     ../../test/crypto/README.md.
//   * `Buffer.from(value)` does not compile when `value` is an `any` (zun#58),
//     so every call site copies the value into a local of declared type first.
//   * `Number(x.length)` throughout: `.length` is typed `u64` at the type
//     level (zun#3), so it can be neither compared nor arithmetic'd as is.
//   * the stream hooks are installed through `__sSetOptFn` (the store
//     `src/stream/stream.ts` keeps for `options.transform` and friends) rather
//     than by assigning `this._transform = …`: `_transform` and `_flush` are
//     *accessors* on `Transform`, and assigning to an accessor through an `any`
//     receiver panics the interpreter (see that file's header note).
//   * every class field is declared `any`, including the numbers and booleans:
//     with them declared `number`/`boolean` the interpreter panics on a read
//     back through an `any` receiver, which is the only kind they ever have
//     (the free functions below take the stream as `any`, because a class
//     method is unreachable as a value — zun#19). `src/zlib/zlib.ts` documents
//     the same finding at `ZlibBase`.
//   * a class cannot be called without `new` in this engine (zun#25), so
//     `crypto.Hash('sha256')` — the DEP0179 form two corpus files use — raises
//     a `ReferenceError` instead of constructing.
//
// ---------------------------------------------------------------------------
// The one deviation that is scheduling, not behaviour
// ---------------------------------------------------------------------------
//
// The natives are **synchronous**: Node hands a KDF or a cipher job to libuv's
// threadpool, and this engine has no threadpool to hand one to. So
// `pbkdf2(...)`, `scrypt(...)`, `hkdf(...)`, `randomBytes(size, cb)` and
// `generateKey(...)` compute their answer immediately and deliver it through
// `process.nextTick`, which keeps the *callback ordering* Node's tests assert
// (the callback never runs before the call returns) while losing the
// concurrency. Nothing observable changes for a consumer that waits for the
// callback.
//
// ---------------------------------------------------------------------------
// What is not here
// ---------------------------------------------------------------------------
//
// Asymmetric cryptography in all its forms: `generateKeyPair`, `createSign` /
// `createVerify` / `sign` / `verify`, `publicEncrypt` / `privateDecrypt`,
// `createDiffieHellman` / `createECDH` / `diffieHellman`, `X509Certificate`,
// `createPublicKey` / `createPrivateKey`, `checkPrime` / `generatePrime`, the
// post-quantum families (ML-DSA, ML-KEM, SLH-DSA) and the full WebCrypto
// surface. `KeyObject` exists for *secret* keys only. The symmetric gaps are
// the CCM, OCB, XTS and key-wrap modes and the legacy block ciphers (DES,
// Camellia, ARIA, SM4), which `getCiphers()` still lists because that function
// describes algorithms rather than capability — see `src/crypto/ciphers.rs`.
// A call into any of those raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` rather
// than being absent, so a program that merely *reaches* for one gets a
// diagnosable error. See ../../test/crypto/README.md for the per-test table.

import * as __cNative from "node:crypto";

// ---------------------------------------------------------------------------
// The carrier
// ---------------------------------------------------------------------------

// Record and unit separators: between the records of a list result, and
// between the fields of one record. See `src/crypto/mod.rs`.
const __C_RS: string = "\u001e";
const __C_US: string = "\u001f";

// Re-type an `any` known to hold a byte view (zun#38). Not style: without it
// `value.length` reads `undefined` and `value.toString("base64")` throws.
function __cAsBuffer(value: any): Buffer {
  return value;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
//
// The `ERR_INVALID_ARG_TYPE` / `ERR_INVALID_ARG_VALUE` / `ERR_OUT_OF_RANGE`
// carriers live in `src/events/events.ts` and `ERR_UNKNOWN_ENCODING` in
// `src/buffer/buffer.ts`, where the `NodeTypeError` / `NodeRangeError` /
// `NodeError` bases with a **declared** `code` field live; writing `code` onto
// a plain `TypeError` through an `any` alias poisons the instance (zun#37).
// The ones below are new with this module.

class ERR_CRYPTO_HASH_FINALIZED extends NodeError {
  constructor() {
    super("ERR_CRYPTO_HASH_FINALIZED", "Digest already called");
  }
}

class ERR_CRYPTO_INVALID_DIGEST extends NodeTypeError {
  constructor(name: any) {
    super("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: " + String(name));
  }
}

class ERR_CRYPTO_INVALID_KEYLEN extends NodeRangeError {
  constructor() {
    super("ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length");
  }
}

class ERR_CRYPTO_INVALID_IV extends NodeTypeError {
  constructor() {
    super("ERR_CRYPTO_INVALID_IV", "Invalid initialization vector");
  }
}

class ERR_CRYPTO_INVALID_AUTH_TAG extends NodeTypeError {
  constructor(detail: string) {
    super("ERR_CRYPTO_INVALID_AUTH_TAG", "Invalid authentication tag" + detail);
  }
}

class ERR_CRYPTO_INVALID_SCRYPT_PARAMS extends NodeRangeError {
  constructor() {
    super("ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "Invalid scrypt params");
  }
}

class ERR_CRYPTO_INVALID_STATE extends NodeError {
  constructor(what: string) {
    super("ERR_CRYPTO_INVALID_STATE", "Invalid state for operation " + what);
  }
}

class ERR_CRYPTO_UNKNOWN_CIPHER extends NodeError {
  constructor() {
    super("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher");
  }
}

class ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH extends NodeRangeError {
  constructor() {
    super(
      "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
      "Input buffers must have the same byte length",
    );
  }
}

class ERR_CRYPTO_UNSUPPORTED_OPERATION extends NodeError {
  constructor() {
    super("ERR_CRYPTO_UNSUPPORTED_OPERATION", "Unsupported crypto operation");
  }
}

class ERR_CRYPTO_FIPS_UNAVAILABLE extends NodeError {
  constructor() {
    super(
      "ERR_CRYPTO_FIPS_UNAVAILABLE",
      "Cannot set FIPS mode in a non-FIPS build.",
    );
  }
}

// An OpenSSL failure, as Node surfaces it: a plain `Error` whose `message` is
// OpenSSL's own `error:<hex>:<library>::<reason>` string, carrying `code`
// plus the `library`, `reason` and `function` own properties the corpus
// matches (`test-crypto-padding.js` asserts all three).
class __CryptoOsslError extends NodeError {
  library: string = "";
  reason: string = "";
  constructor(code: string, message: string, library: string, reason: string) {
    super(code, message);
    this.library = library;
    this.reason = reason;
  }
}

// The AEAD tag check failure, which in Node carries no `code` at all.
class __CryptoAuthError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// Split an OpenSSL message into its `library` and `reason` halves. The shape
// is `error:<8 hex digits>:<library>:<function>:<reason>`, with the function
// field empty in OpenSSL 3.
function __cOsslParts(message: string): string[] {
  const parts: string[] = message.split(":");
  if (Number(parts.length) < 5 || parts[0] !== "error") return ["", ""];
  return [parts[2], parts[4]];
}

// Build the error the per-thread slots describe, after a native answered `-`.
// The code decides the class, because Node's `crypto` errors are a mix of
// `TypeError`, `RangeError` and `Error` and the distinction is asserted.
function __cTakeError(): any {
  const code: string = String(__cNative.cryptoErrorCode());
  const message: string = String(__cNative.cryptoErrorMessage());
  if (code === "") return new __CryptoAuthError(message);
  if (code === "ERR_CRYPTO_INVALID_DIGEST") {
    // The message is `Invalid digest: <name>`; the name is what the error
    // carrier wants.
    return new ERR_CRYPTO_INVALID_DIGEST(message.slice(Number("Invalid digest: ".length)));
  }
  if (code === "ERR_CRYPTO_INVALID_KEYLEN") return new ERR_CRYPTO_INVALID_KEYLEN();
  if (code === "ERR_CRYPTO_INVALID_IV") return new ERR_CRYPTO_INVALID_IV();
  if (code === "ERR_CRYPTO_UNKNOWN_CIPHER") return new ERR_CRYPTO_UNKNOWN_CIPHER();
  if (code === "ERR_CRYPTO_UNSUPPORTED_OPERATION") {
    return new ERR_CRYPTO_UNSUPPORTED_OPERATION();
  }
  if (code === "ERR_CRYPTO_INVALID_SCRYPT_PARAMS") {
    return new ERR_CRYPTO_INVALID_SCRYPT_PARAMS();
  }
  if (code === "ERR_CRYPTO_INVALID_AUTH_TAG") return new ERR_CRYPTO_INVALID_AUTH_TAG("");
  if (code === "ERR_CRYPTO_INVALID_STATE") return new ERR_CRYPTO_INVALID_STATE("update");
  if (code.indexOf("ERR_OSSL_") === 0) {
    const parts: string[] = __cOsslParts(message);
    const library: string = parts[0];
    const reason: string = parts[1];
    return new __CryptoOsslError(code, message, library, reason);
  }
  return new NodeError(code, message);
}

// The payload of a `+`-prefixed native result, or the stashed error thrown.
function __cPayload(result: any): string {
  const text: string = String(result);
  if (text.charAt(0) !== "+") throw __cTakeError();
  return text.slice(1);
}

// The payload of a result whose failure means "no such thing" rather than an
// error — `getCipherInfo` of an unknown name answers `undefined`, not a throw.
function __cMaybePayload(result: any): any {
  const text: string = String(result);
  if (text.charAt(0) !== "+") return undefined;
  return text.slice(1);
}

// ---------------------------------------------------------------------------
// Validation (`lib/internal/validators.js`)
// ---------------------------------------------------------------------------

function __cValidateString(value: any, name: string): void {
  if (typeof value !== "string") throw new ERR_INVALID_ARG_TYPE(name, "string", value);
}

function __cValidateFunction(value: any, name: string): void {
  if (!__evIsFn(value)) throw new ERR_INVALID_ARG_TYPE(name, "Function", value);
}

function __cValidateNumber(value: any, name: string): void {
  if (typeof value !== "number") throw new ERR_INVALID_ARG_TYPE(name, "number", value);
}

function __cValidateObject(value: any, name: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ERR_INVALID_ARG_TYPE(name, "Object", value);
  }
}

// `validateInteger(value, name, min, max)`.
function __cValidateInteger(value: any, name: string, min: number, max: number): number {
  __cValidateNumber(value, name);
  if (!Number.isInteger(value)) throw new ERR_OUT_OF_RANGE(name, "an integer", value);
  const n: number = value;
  if (n < min || n > max) {
    throw new ERR_OUT_OF_RANGE(name, ">= " + min + " && <= " + max, value);
  }
  return n;
}

function __cValidateInt32(value: any, name: string): number {
  return __cValidateInteger(value, name, -2147483648, 2147483647);
}

function __cValidateUint32(value: any, name: string): number {
  return __cValidateInteger(value, name, 0, 4294967295);
}

// `validateEncoding(data, encoding)`: a hex string must have an even length,
// which is the only shape check Node makes here. The message is the one
// `test-crypto.js` matches as a literal.
function __cValidateEncoding(data: string, encoding: any): void {
  if (__bufNormalizeEncoding(encoding) === "hex" && Number(data.length) % 2 !== 0) {
    throw new ERR_INVALID_ARG_VALUE(
      "encoding",
      encoding,
      "is invalid for data of length " + Number(data.length),
    );
  }
}

// ---------------------------------------------------------------------------
// Bytes in, bytes out
// ---------------------------------------------------------------------------

// Is this a byte view this module can read? `Buffer.isBuffer` answers `true`
// for every `Uint8Array`-family view (they share one runtime type in this
// engine) and `false` for a string, a number, `null` and a plain object — so
// it is both the test and the only one available, since a view's own
// `byteLength` is unreadable through `any` (zun#38).
function __cIsByteView(value: any): boolean {
  if (value === null || value === undefined) return false;
  return Buffer.isBuffer(value);
}

// A data argument as base64, accepting what Node's `update()` accepts: a
// string in the given encoding, or any byte view (whose presence makes the
// encoding irrelevant, as in Node).
function __cToBase64(data: any, encoding: any, name: string): string {
  if (typeof data === "string") {
    const text: string = data;
    __cValidateEncoding(text, encoding);
    // The local has a declared type because `Buffer.from` of an `any` does
    // not compile (zun#58).
    const bytes: Buffer = Buffer.from(text, __cInputEncoding(encoding));
    return bytes.toString("base64");
  }
  if (__cIsByteView(data)) {
    const view: Buffer = __cAsBuffer(data);
    return view.toString("base64");
  }
  throw new ERR_INVALID_ARG_TYPE(
    name,
    ["string", "Buffer", "TypedArray", "DataView"],
    data,
  );
}

// The encoding a string data argument is decoded with: Node's default is
// utf8, and `'buffer'` means the same thing for a string input.
function __cInputEncoding(encoding: any): string {
  if (encoding === undefined || encoding === null) return "utf8";
  const name: string = String(encoding);
  if (name === "" || name === "buffer") return "utf8";
  const normalized: string = __bufNormalizeEncoding(name);
  if (normalized === "") throw new ERR_UNKNOWN_ENCODING(encoding);
  return normalized;
}

// A key argument as base64. Node accepts a string (in `encoding`), any byte
// view, or a `KeyObject` of type `'secret'`.
function __cKeyToBase64(key: any, encoding: any, name: string): string {
  if (key !== null && key !== undefined && __cIsKeyObject(key)) {
    const held: any = key;
    if (String(held.type) !== "secret") {
      throw new ERR_INVALID_ARG_TYPE(name, "KeyObject of type secret", key);
    }
    return String(held.__cBase64);
  }
  if (typeof key === "string") {
    const text: string = key;
    const bytes: Buffer = Buffer.from(text, __cInputEncoding(encoding));
    return bytes.toString("base64");
  }
  if (__cIsByteView(key)) {
    const view: Buffer = __cAsBuffer(key);
    return view.toString("base64");
  }
  throw new ERR_INVALID_ARG_TYPE(
    name,
    [
      "string",
      "ArrayBuffer",
      "Buffer",
      "TypedArray",
      "DataView",
      "KeyObject",
      "CryptoKey",
    ],
    key,
  );
}

// base64 bytes as the value Node answers: a `Buffer` when no encoding (or
// `'buffer'`) was asked for, otherwise the string in that encoding.
//
// `String(encoding)` is deliberate rather than defensive: Node calls
// `toString()` on the encoding argument, so an object whose `toString` throws
// propagates that error — which is exactly what `test-crypto-hash.js` and
// `test-crypto-hmac.js` assert after the segfault of nodejs/node#9819.
function __cFromBase64(base64: string, encoding: any): any {
  const bytes: Buffer = Buffer.from(base64, "base64");
  if (encoding === undefined || encoding === null) return bytes;
  const name: string = String(encoding);
  if (name === "buffer") return bytes;
  const normalized: string = __bufNormalizeEncoding(name);
  if (normalized === "") throw new ERR_UNKNOWN_ENCODING(name);
  return bytes.toString(normalized);
}

// ---------------------------------------------------------------------------
// Deprecation warnings
// ---------------------------------------------------------------------------
//
// Node emits each of these once per process, through `internal/util`'s
// `deprecate`, and three corpus files assert them with `common.expectWarning`.
// The emitted-once bookkeeping is a module-level table rather than a closure
// so that every call site shares it.

const __cWarned: any = { DEP0182: false, DEP0198: false };

function __cEmitWarning(code: string, message: string): void {
  if (__cWarned[code] === true) return;
  __cWarned[code] = true;
  process.emitWarning(message, "DeprecationWarning", code);
}

// DEP0198: a SHAKE digest with no explicit `options.outputLength`.
function __cWarnDefaultShakeLength(alg: string): void {
  const lowered: string = alg.toLowerCase();
  if (lowered !== "shake128" && lowered !== "shake256") return;
  __cEmitWarning(
    "DEP0198",
    "Creating SHAKE128/256 digests without an explicit options.outputLength is deprecated.",
  );
}

// `options.outputLength` as the native wants it: `-1` for absent.
function __cOutputLength(options: any): number {
  if (options === undefined || options === null) return -1;
  if (typeof options !== "object") return -1;
  const requested: any = options.outputLength;
  if (requested === undefined) return -1;
  __cValidateUint32(requested, "options.outputLength");
  return Number(requested);
}

// ---------------------------------------------------------------------------
// Hash and Hmac
// ---------------------------------------------------------------------------
//
// Both are `Transform` streams in Node: writing feeds `update()` and the end
// of the writable side pushes the digest. The hooks are installed through
// `src/stream/stream.ts`' option store rather than by assigning to the
// `_transform` / `_flush` accessors, for the reason the header note gives.

// `Hash.prototype._transform` / `Hmac.prototype._transform`.
function __cDigestTransformHook(self: any, chunk: any, encoding: any, cb: any): void {
  let failure: any = null;
  try {
    self.update(chunk, encoding);
  } catch (error) {
    failure = error;
  }
  __cTick(cb, failure === null ? undefined : failure);
}

// The finalized digest, computed once and cached on the object.
//
// Both `digest()` and the stream's `_flush` need it, and either can run first:
// a write completes on a later tick here, so `hash.end(x); hash.digest('hex')`
// finalizes through `digest()` and the flush follows. Caching makes the two
// answer the same bytes from one native finalization, and releases the handle
// as soon as it can no longer be needed.
function __cFinalizeDigest(self: any): string {
  if (self._digest === null) {
    self._digest = __cPayload(__cNative.cryptoHashDigest(Number(self._handle)));
    __cNative.cryptoHashFree(Number(self._handle));
  }
  return String(self._digest);
}

// `Hash.prototype._flush`: the end of the writable side is the digest.
//
// This finalizes the *handle* rather than calling `digest()`, which is what
// Node's own `_flush` does — and the difference is observable: after piping
// into a hash, `hash.digest('hex')` still answers the digest instead of
// `ERR_CRYPTO_HASH_FINALIZED`, because the `finalized` flag lives in the JS
// layer and `_flush` never sets it. `test-crypto-hash-stream-pipe.js` asserts
// exactly that (it is the regression test for nodejs/node#28245).
function __cDigestFlushHook(self: any, cb: any): void {
  let failure: any = null;
  try {
    self.push(Buffer.from(__cFinalizeDigest(self), "base64"));
  } catch (error) {
    failure = error;
  }
  __cTick(cb, failure === null ? undefined : failure);
}

// `process.nextTick`, through `../process/process.ts`' FIFO queue — which is
// also what the harness watches to decide the loop has gone quiet.
function __cTick(fn: any, a?: any, b?: any): void {
  if (fn === undefined || fn === null) return;
  if (a === undefined) {
    __processNextTick(fn);
  } else if (b === undefined) {
    __processNextTick(fn, a);
  } else {
    __processNextTick(fn, a, b);
  }
}

// Invoke a callback that has no receiver of its own, unboxing it first: a
// callable that crossed the `any` lane arrives as a `functionBox` record
// (zun#17/#50) which carries no `call` of its own.
function __cInvoke(fn: any, args: any[]): any {
  if (fn === undefined || fn === null) return undefined;
  const target: any = __evUnbox(fn);
  return target(...args);
}

// The shared half of `Hash` and `Hmac`: a native handle plus the
// `finalized` flag Node keeps in JavaScript (the native state survives a
// digest, and `ERR_CRYPTO_HASH_FINALIZED` is this layer's rule, not
// OpenSSL's).
class __CryptoDigestBase extends Transform {
  // Every field is `any`, not laziness — see the header note.
  _handle: any = 0;
  _finalized: any = false;
  _algorithm: any = "";
  _outputLength: any = -1;
  // The finalized digest as base64, or `null` while the state is still open.
  // See `__cFinalizeDigest`.
  _digest: any = null;

  constructor(options: any) {
    super(options);
    const self: any = this;
    __sSetOptFn(self, "transform", function (chunk: any, encoding: any, cb: any): void {
      __cDigestTransformHook(self, chunk, encoding, cb);
    });
    __sSetOptFn(self, "flush", function (cb: any): void {
      __cDigestFlushHook(self, cb);
    });
  }

  update(data: any, inputEncoding?: any): any {
    if (this._finalized === true) throw new ERR_CRYPTO_HASH_FINALIZED();
    const base64: string = __cToBase64(data, inputEncoding, "data");
    __cPayload(__cNative.cryptoHashUpdate(Number(this._handle), base64));
    return this;
  }

  digest(outputEncoding?: any): any {
    if (this._finalized === true) throw new ERR_CRYPTO_HASH_FINALIZED();
    // The encoding is resolved *before* the object is marked finalized, so an
    // encoding whose `toString` throws leaves it usable, as in Node.
    const answer: any = __cFromBase64(__cFinalizeDigest(this), outputEncoding);
    this._finalized = true;
    return answer;
  }
}

class Hash extends __CryptoDigestBase {
  constructor(algorithm: any, options?: any) {
    super(options);
    __cValidateString(algorithm, "algorithm");
    const name: string = algorithm;
    const requested: number = __cOutputLength(options);
    if (requested < 0) __cWarnDefaultShakeLength(name);
    // `createHash('xyzzy')` is a code-less `Error` in Node ("Digest method not
    // supported"), while every *other* consumer of a digest name reports
    // `ERR_CRYPTO_INVALID_DIGEST`. The native answers the latter, so this is
    // the one place that rewrites it.
    const result: any = __cNative.cryptoHashInit(name, requested);
    if (String(result).charAt(0) !== "+") {
      const error: any = __cTakeError();
      if (String(error.code) === "ERR_CRYPTO_INVALID_DIGEST") {
        throw new Error("Digest method not supported");
      }
      throw error;
    }
    this._handle = Number(String(result).slice(1));
    this._algorithm = name;
    this._outputLength = requested;
  }

  // `Hash.prototype.copy([options])`: a duplicate of the state, optionally
  // with a different XOF output length.
  copy(options?: any): any {
    if (this._finalized === true) throw new ERR_CRYPTO_HASH_FINALIZED();
    const requested: number = __cOutputLength(options);
    const payload: string = __cPayload(
      __cNative.cryptoHashCopy(Number(this._handle), requested),
    );
    const copy: any = new Hash(String(this._algorithm), __cCopyOptions(this, options));
    // The fresh `Hash` allocated a handle of its own in its constructor;
    // replace it with the cloned state and release the unused one.
    __cNative.cryptoHashFree(Number(copy._handle));
    copy._handle = Number(payload);
    return copy;
  }
}

// The options a `copy()` passes to the new `Hash`: the caller's, or an
// explicit `outputLength` of the original when none was given, so the copy
// inherits the length rather than falling back to the algorithm default.
function __cCopyOptions(self: any, options: any): any {
  if (options !== undefined && options !== null) return options;
  if (Number(self._outputLength) < 0) return undefined;
  return { outputLength: Number(self._outputLength) };
}

class Hmac extends __CryptoDigestBase {
  constructor(algorithm: any, key: any, options?: any) {
    super(options);
    __cValidateString(algorithm, "hmac");
    const name: string = algorithm;
    const keyBase64: string = __cKeyToBase64(key, __cOptionEncoding(options), "key");
    this._handle = Number(__cPayload(__cNative.cryptoHmacInit(name, keyBase64)));
    this._algorithm = name;
  }
}

// `options.encoding`, which is how a string key's encoding reaches
// `createHmac`.
function __cOptionEncoding(options: any): any {
  if (options === undefined || options === null) return undefined;
  if (typeof options !== "object") return undefined;
  return options.encoding;
}

// ---------------------------------------------------------------------------
// Cipheriv and Decipheriv
// ---------------------------------------------------------------------------

// `Cipher.prototype._transform`.
function __cCipherTransformHook(self: any, chunk: any, encoding: any, cb: any): void {
  let failure: any = null;
  try {
    self.push(self.update(chunk, encoding));
  } catch (error) {
    failure = error;
  }
  __cTick(cb, failure === null ? undefined : failure);
}

// `Cipher.prototype._flush`.
function __cCipherFlushHook(self: any, cb: any): void {
  let failure: any = null;
  try {
    self.push(self.final());
  } catch (error) {
    failure = error;
  }
  __cTick(cb, failure === null ? undefined : failure);
}

class __CryptoCipherBase extends Transform {
  _handle: any = 0;
  _encrypt: any = true;
  _finalized: any = false;
  // The single `StringDecoder` Node keeps for the output encoding. Its
  // presence is what makes a *second*, different output encoding the
  // "Cannot change encoding" assertion `test-crypto-encoding-validation-error`
  // asserts.
  _decoderEncoding: any = null;
  _decoder: any = null;

  constructor(encrypt: boolean, handle: number, options: any) {
    super(options);
    this._handle = handle;
    this._encrypt = encrypt;
    const self: any = this;
    __sSetOptFn(self, "transform", function (chunk: any, encoding: any, cb: any): void {
      __cCipherTransformHook(self, chunk, encoding, cb);
    });
    __sSetOptFn(self, "flush", function (cb: any): void {
      __cCipherFlushHook(self, cb);
    });
  }

  update(data: any, inputEncoding?: any, outputEncoding?: any): any {
    if (this._finalized === true) throw new ERR_CRYPTO_INVALID_STATE("update");
    const base64: string = __cToBase64(data, inputEncoding, "data");
    // The output encoding is resolved before the cipher runs, so a bad one
    // leaves the state untouched — the order Node's `getDecoder` imposes.
    const wanted: any = __cResolveOutputEncoding(this, outputEncoding);
    const produced: string = __cPayload(
      __cNative.cryptoCipherUpdate(Number(this._handle), base64),
    );
    return __cCipherOut(this, produced, wanted);
  }

  final(outputEncoding?: any): any {
    if (this._finalized === true) throw new ERR_CRYPTO_INVALID_STATE("final");
    const wanted: any = __cResolveOutputEncoding(this, outputEncoding);
    const payload: string = __cPayload(__cNative.cryptoCipherFinal(Number(this._handle)));
    const fields: string[] = payload.split(__C_US);
    this._finalized = true;
    // A member of a `string[]` reads back as an `any`, and `Buffer.from` of
    // an `any` does not compile (zun#58), so each field goes through a local
    // of declared type.
    const produced: string = fields[0];
    if (Number(fields.length) > 1) {
      const tag: string = fields[1];
      if (tag !== "") this._authTag = Buffer.from(tag, "base64");
    }
    return __cCipherOut(this, produced, wanted);
  }

  setAutoPadding(value?: any): any {
    const on: boolean = value === undefined ? true : value ? true : false;
    __cPayload(__cNative.cryptoCipherSetAutoPadding(Number(this._handle), on));
    return this;
  }

  setAAD(aad: any, options?: any): any {
    const encoding: any = __cOptionEncoding(options);
    const base64: string = __cToBase64(aad, encoding, "aad");
    __cPayload(__cNative.cryptoCipherSetAAD(Number(this._handle), base64));
    return this;
  }

  getAuthTag(): any {
    if (this._encrypt !== true || this._authTag === null) {
      throw new ERR_CRYPTO_INVALID_STATE("getAuthTag");
    }
    return this._authTag;
  }

  setAuthTag(tag: any, encoding?: any): any {
    // Only a *decrypting* AEAD takes a tag; Node reports anything else as a
    // state error rather than letting the length check speak first.
    if (this._encrypt === true || Number(__cNative.cryptoCipherTagLength(Number(this._handle))) === 0) {
      throw new ERR_CRYPTO_INVALID_STATE("setAuthTag");
    }
    const base64: string = __cToBase64(tag, encoding, "buffer");
    const bytes: Buffer = Buffer.from(base64, "base64");
    const length: number = Number(bytes.length);
    const explicit: number = Number(this._explicitTagLength);
    if (explicit >= 0) {
      // With `options.authTagLength` given, the tag must be exactly that long.
      if (length !== explicit) {
        throw new ERR_CRYPTO_INVALID_AUTH_TAG(" length: " + length);
      }
    } else if (!__cValidTagLength(String(this._mode), length)) {
      throw new ERR_CRYPTO_INVALID_AUTH_TAG(" length: " + length);
    } else if (String(this._mode) === "gcm" && length < 16) {
      // DEP0182: a short GCM tag accepted without having been declared.
      __cEmitWarning(
        "DEP0182",
        "Using AES-GCM authentication tags of less than 128 bits without " +
          "specifying the authTagLength option when initializing decryption " +
          "is deprecated.",
      );
    }
    __cPayload(__cNative.cryptoCipherSetAuthTag(Number(this._handle), base64));
    return this;
  }

  // Node's `Cipheriv` has no `_authTag`, `_mode` or `_explicitTagLength` of
  // its own; the fields are declared here because an undeclared write on a
  // class instance is a compile error in this engine. `_mode` is the
  // catalogue's mode name and `_explicitTagLength` is `options.authTagLength`
  // or `-1`, which together decide what `setAuthTag` accepts.
  _authTag: any = null;
  _mode: any = "";
  _explicitTagLength: any = -1;
}

// The tag lengths an AEAD accepts when none was declared: OpenSSL's GCM set,
// and 16 for ChaCha20-Poly1305 (whose tag is always a full Poly1305 output).
function __cValidTagLength(mode: string, length: number): boolean {
  if (mode === "gcm") {
    return length === 4 || length === 8 || (length >= 12 && length <= 16);
  }
  return length === 16;
}

// The catalogue's mode name for a cipher, which `setAuthTag` needs and the
// native already knows.
function __cCipherMode(cipher: any): string {
  const record: any = __cMaybePayload(__cNative.cryptoCipherSpec(String(cipher)));
  if (record === undefined) return "";
  const fields: string[] = String(record).split(__C_US);
  return fields[6];
}

// `options.authTagLength`, or `-1` when it was not given.
function __cExplicitTagLength(options: any): number {
  if (options === undefined || options === null) return -1;
  if (typeof options !== "object") return -1;
  const requested: any = options.authTagLength;
  if (requested === undefined) return -1;
  return Number(requested);
}

// `getDecoder(this._decoder, encoding)`: the normalised output encoding, or
// `null` for "answer a Buffer". Changing a chosen encoding is the assertion
// failure Node's `assert(decoder.encoding === encoding)` produces.
function __cResolveOutputEncoding(self: any, encoding: any): any {
  if (encoding === undefined || encoding === null) return null;
  const name: string = String(encoding);
  if (name === "buffer") return null;
  const normalized: string = __bufNormalizeEncoding(name);
  if (normalized === "") throw new ERR_UNKNOWN_ENCODING(name);
  const current: any = self._decoderEncoding;
  if (current !== null && String(current) !== normalized) {
    throw new Error("Cannot change encoding");
  }
  return normalized;
}

// The value a `update()` / `final()` answers: raw bytes, or the string the
// per-stream `StringDecoder` produces (which is stateful, so a multi-byte
// character split across two chunks still comes out whole).
function __cCipherOut(self: any, base64: string, encoding: any): any {
  const bytes: Buffer = Buffer.from(base64, "base64");
  if (encoding === null) return bytes;
  const name: string = String(encoding);
  if (self._decoderEncoding === null) {
    self._decoderEncoding = name;
    self._decoder = new StringDecoder(name);
  }
  const decoder: any = self._decoder;
  return decoder.write(bytes);
}

class Cipheriv extends __CryptoCipherBase {
  constructor(cipher: any, key: any, iv: any, options?: any) {
    super(true, __cCipherInit(cipher, true, key, iv, options), options);
    this._mode = __cCipherMode(cipher);
    this._explicitTagLength = __cExplicitTagLength(options);
  }
}

class Decipheriv extends __CryptoCipherBase {
  constructor(cipher: any, key: any, iv: any, options?: any) {
    super(false, __cCipherInit(cipher, false, key, iv, options), options);
    this._mode = __cCipherMode(cipher);
    this._explicitTagLength = __cExplicitTagLength(options);
  }
}

// The native `init`, with Node's argument validation in front of it. Runs as
// an argument expression of the `super(...)` call, because nothing may precede
// `super` in a TypeScript constructor.
function __cCipherInit(
  cipher: any,
  encrypt: boolean,
  key: any,
  iv: any,
  options: any,
): number {
  __cValidateString(cipher, "cipher");
  const name: string = cipher;
  const encoding: any = __cOptionEncoding(options);
  const keyBase64: string = __cKeyToBase64(key, encoding, "key");
  let ivBase64: string = "";
  if (iv !== null && iv !== undefined) {
    ivBase64 = __cToBase64(iv, encoding, "iv");
  }
  let authTagLength: number = -1;
  if (options !== undefined && options !== null && typeof options === "object") {
    const requested: any = options.authTagLength;
    if (requested !== undefined) {
      authTagLength = __cValidateUint32(requested, "options.authTagLength");
    }
  }
  return Number(
    __cPayload(__cNative.cryptoCipherInit(name, encrypt, keyBase64, ivBase64, authTagLength)),
  );
}

// ---------------------------------------------------------------------------
// KeyObject (secret keys)
// ---------------------------------------------------------------------------
//
// Only the `'secret'` type exists here: `createPublicKey` / `createPrivateKey`
// and every asymmetric operation are absent (see the header). A secret key is
// a byte string plus the three members the corpus reads — `type`,
// `symmetricKeySize` and `export()` — and it is the one key form `createHmac`
// and `createCipheriv` accept in place of a Buffer.

class KeyObject {
  type: any = "secret";
  // The bytes, base64, which is how they reach the natives. Named with the
  // module prefix because it is not part of Node's surface.
  __cBase64: any = "";
  constructor(type: any, base64: any) {
    this.type = type;
    this.__cBase64 = base64;
  }

  get symmetricKeySize(): any {
    const bytes: Buffer = Buffer.from(String(this.__cBase64), "base64");
    return Number(bytes.length);
  }

  get asymmetricKeyType(): any {
    return undefined;
  }

  export(options?: any): any {
    const bytes: Buffer = Buffer.from(String(this.__cBase64), "base64");
    if (options !== undefined && options !== null && typeof options === "object") {
      const format: any = options.format;
      if (format !== undefined && String(format) !== "buffer") {
        throw new ERR_CRYPTO_UNSUPPORTED_OPERATION();
      }
    }
    return bytes;
  }

  equals(other: any): boolean {
    if (!__cIsKeyObject(other)) {
      throw new ERR_INVALID_ARG_TYPE("otherKeyObject", "KeyObject", other);
    }
    const held: any = other;
    if (String(held.type) !== String(this.type)) return false;
    return Boolean(
      __cNative.cryptoTimingSafeEqual(String(this.__cBase64), String(held.__cBase64)),
    );
  }
}

// Is this a `KeyObject`? `x instanceof KeyObject` is a *runtime* failure in
// this engine when the receiver came through an `any` (zun#26 / zun#72), so
// the test is the module-private field every `KeyObject` carries.
function __cIsKeyObject(value: any): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  return value.__cBase64 !== undefined;
}

// ---------------------------------------------------------------------------
// The module surface
// ---------------------------------------------------------------------------

// `getHashes()` / `getCiphers()` / `getCurves()` each answer a *fresh* array,
// because `test-crypto.js` pushes onto the result and then checks the next
// call is unchanged.
function __cNames(payload: string): string[] {
  const out: string[] = [];
  if (payload === "") return out;
  for (const name of payload.split(__C_RS)) out.push(name);
  return out;
}

// `getCipherInfo(nameOrNid, options)`, `lib/internal/crypto/util.js`.
function __cCipherInfo(nameOrNid: any, options?: any): any {
  if (typeof nameOrNid !== "string" && typeof nameOrNid !== "number") {
    throw new ERR_INVALID_ARG_TYPE("nameOrNid", ["string", "number"], nameOrNid);
  }
  let keyLength: any = undefined;
  let ivLength: any = undefined;
  if (options !== undefined) {
    __cValidateObject(options, "options");
    keyLength = options.keyLength;
    ivLength = options.ivLength;
    if (keyLength !== undefined) __cValidateInt32(keyLength, "options.keyLength");
    if (ivLength !== undefined) __cValidateInt32(ivLength, "options.ivLength");
  }

  let record: any = undefined;
  if (typeof nameOrNid === "string") {
    record = __cMaybePayload(__cNative.cryptoCipherSpec(nameOrNid));
  } else {
    __cValidateInt32(nameOrNid, "nameOrNid");
    record = __cMaybePayload(__cNative.cryptoCipherSpecByNid(Number(nameOrNid)));
  }
  if (record === undefined) return undefined;

  const fields: string[] = String(record).split(__C_US);
  const lookupName: string = fields[0];
  const canonical: string = fields[1];
  const mode: string = fields[6];
  const blockSize: number = Number(fields[3]);
  const nativeIvLength: number = Number(fields[4]);
  const nativeKeyLength: number = Number(fields[5]);

  if (keyLength !== undefined && Number(keyLength) !== nativeKeyLength) return undefined;
  if (
    ivLength !== undefined &&
    !Boolean(__cNative.cryptoCipherIvOk(lookupName, Number(ivLength)))
  ) {
    return undefined;
  }

  const info: any = { name: canonical, nid: Number(fields[2]) };
  // A `-1` means Node's info object leaves the key out: a stream cipher has no
  // block size and ECB has no IV.
  if (blockSize >= 0) info.blockSize = blockSize;
  if (nativeIvLength >= 0) {
    info.ivLength = ivLength === undefined ? nativeIvLength : Number(ivLength);
  }
  info.keyLength = nativeKeyLength;
  info.mode = mode;
  return info;
}

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

// The shared argument normalisation of `pbkdf2` and `pbkdf2Sync`.
function __cPbkdf2(
  password: any,
  salt: any,
  iterations: any,
  keylen: any,
  digest: any,
): string {
  const passwordBase64: string = __cToBase64(password, undefined, "password");
  const saltBase64: string = __cToBase64(salt, undefined, "salt");
  __cValidateInteger(iterations, "iterations", 1, 2147483647);
  __cValidateInteger(keylen, "keylen", 0, 2147483647);
  if (digest === undefined || digest === null) {
    throw new ERR_INVALID_ARG_TYPE("digest", "string", digest);
  }
  __cValidateString(digest, "digest");
  return __cPayload(
    __cNative.cryptoPbkdf2(
      String(digest),
      passwordBase64,
      saltBase64,
      Number(iterations),
      Number(keylen),
    ),
  );
}

// `scrypt`'s option normalisation: the defaults and the two spellings of each
// parameter (`N`/`cost`, `r`/`blockSize`, `p`/`parallelization`).
function __cScryptParams(options: any): any {
  let cost: number = 16384;
  let blockSize: number = 8;
  let parallelization: number = 1;
  let maxmem: number = 32 * 1024 * 1024;
  if (options !== undefined && options !== null) {
    __cValidateObject(options, "options");
    if (options.N !== undefined) cost = __cValidateUint32(options.N, "N");
    if (options.cost !== undefined) cost = __cValidateUint32(options.cost, "cost");
    if (options.r !== undefined) blockSize = __cValidateUint32(options.r, "r");
    if (options.blockSize !== undefined) {
      blockSize = __cValidateUint32(options.blockSize, "blockSize");
    }
    if (options.p !== undefined) parallelization = __cValidateUint32(options.p, "p");
    if (options.parallelization !== undefined) {
      parallelization = __cValidateUint32(options.parallelization, "parallelization");
    }
    if (options.maxmem !== undefined) maxmem = Number(options.maxmem);
  }
  return { cost: cost, blockSize: blockSize, parallelization: parallelization, maxmem: maxmem };
}

function __cScrypt(password: any, salt: any, keylen: any, options: any): string {
  const passwordBase64: string = __cToBase64(password, undefined, "password");
  const saltBase64: string = __cToBase64(salt, undefined, "salt");
  __cValidateInteger(keylen, "keylen", 0, 2147483647);
  const params: any = __cScryptParams(options);
  // `128 * r * (N + p)` is the memory scrypt needs, and exceeding `maxmem` is
  // `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` in Node rather than an allocation
  // failure.
  const needed: number =
    128 * Number(params.blockSize) * (Number(params.cost) + Number(params.parallelization));
  if (needed > Number(params.maxmem)) throw new ERR_CRYPTO_INVALID_SCRYPT_PARAMS();
  return __cPayload(
    __cNative.cryptoScrypt(
      passwordBase64,
      saltBase64,
      Number(params.cost),
      Number(params.blockSize),
      Number(params.parallelization),
      Number(keylen),
    ),
  );
}

function __cHkdf(digest: any, key: any, salt: any, info: any, keylen: any): string {
  __cValidateString(digest, "digest");
  const keyBase64: string = __cKeyToBase64(key, undefined, "ikm");
  const saltBase64: string = __cToBase64(salt, undefined, "salt");
  const infoBase64: string = __cToBase64(info, undefined, "info");
  __cValidateInteger(keylen, "length", 0, 4294967295);
  return __cPayload(
    __cNative.cryptoHkdf(String(digest), keyBase64, saltBase64, infoBase64, Number(keylen)),
  );
}

// The callback form of a KDF: Node computes on the threadpool and calls back
// on a later tick. There is no threadpool here, so the answer is computed now
// and *delivered* on the next tick, which preserves the ordering the corpus
// asserts (see the header).
function __cDeferred(callback: any, run: any): void {
  __cValidateFunction(callback, "callback");
  let failure: any = null;
  let answer: any = undefined;
  try {
    answer = run();
  } catch (error) {
    failure = error;
  }
  if (failure !== null) {
    __cTick(callback, failure);
  } else {
    __cTick(callback, null, answer);
  }
}

// ---------------------------------------------------------------------------
// Random
// ---------------------------------------------------------------------------

function __cRandomBytes(size: any): any {
  __cValidateInteger(size, "size", 0, 281474976710655);
  const payload: string = __cPayload(__cNative.cryptoRandomBytes(Number(size)));
  return Buffer.from(payload, "base64");
}

// `randomFillSync(buffer, offset, size)`: the bytes are written *into* the
// caller's view, so the view is re-typed first (zun#38) and then indexed.
function __cRandomFill(buffer: any, offset: any, size: any): any {
  if (!__cIsByteView(buffer)) {
    throw new ERR_INVALID_ARG_TYPE(
      "buf",
      ["ArrayBuffer", "ArrayBufferView"],
      buffer,
    );
  }
  const view: Buffer = __cAsBuffer(buffer);
  const total: number = Number(view.length);
  let start: number = 0;
  if (offset !== undefined && offset !== null) {
    start = __cValidateInteger(offset, "offset", 0, total);
  }
  let count: number = total - start;
  if (size !== undefined && size !== null) {
    count = __cValidateInteger(size, "size", 0, total - start);
  }
  if (count > 0) {
    const payload: string = __cPayload(__cNative.cryptoRandomBytes(count));
    const bytes: Buffer = Buffer.from(payload, "base64");
    for (let index = 0; index < count; index++) {
      view[start + index] = Number(bytes[index]);
    }
  }
  return buffer;
}

// `randomInt(min, max)`, `lib/internal/crypto/random.js`: uniform over
// `[min, max)` by rejection sampling over whole bytes, so no modulo bias.
const __C_RANDOM_INT_MAX: number = 281474976710655; // 2 ** 48 - 1

function __cRandomInt(minOrMax: any, maxOrCb: any, maybeCb: any): any {
  let min: any = minOrMax;
  let max: any = maxOrCb;
  let callback: any = maybeCb;
  if (__evIsFn(max)) {
    callback = max;
    max = min;
    min = 0;
  } else if (max === undefined) {
    max = min;
    min = 0;
  }
  if (callback !== undefined && callback !== null) {
    __cValidateFunction(callback, "callback");
  }
  __cValidateInteger(min, "min", -__C_RANDOM_INT_MAX, __C_RANDOM_INT_MAX);
  __cValidateInteger(max, "max", -__C_RANDOM_INT_MAX, __C_RANDOM_INT_MAX);
  if (Number(max) <= Number(min)) {
    throw new ERR_OUT_OF_RANGE(
      "max",
      "greater than the value of \"min\" (" + Number(min) + ")",
      max,
    );
  }
  const range: number = Number(max) - Number(min);
  if (range > __C_RANDOM_INT_MAX) {
    throw new ERR_OUT_OF_RANGE("max - min", "<= " + __C_RANDOM_INT_MAX, range);
  }

  const run: any = function (): number {
    // The smallest number of bytes that covers the range, and the largest
    // multiple of `range` those bytes can hold; a draw above it is rejected.
    let bytes: number = 1;
    while (Math.pow(256, bytes) <= range) bytes = bytes + 1;
    const span: number = Math.pow(256, bytes);
    const limit: number = span - (span % range);
    for (;;) {
      const payload: string = __cPayload(__cNative.cryptoRandomBytes(bytes));
      const drawn: Buffer = Buffer.from(payload, "base64");
      let value: number = 0;
      for (let index = 0; index < bytes; index++) {
        value = value * 256 + Number(drawn[index]);
      }
      if (value < limit) return Number(min) + (value % range);
    }
  };

  if (callback === undefined || callback === null) return run();
  __cDeferred(callback, run);
  return undefined;
}

// `randomUUID()`: RFC 4122 version 4, from 16 OS random bytes with the version
// and variant bits forced.
const __C_HEX: string = "0123456789abcdef";

function __cByteHex(byte: number): string {
  return __C_HEX.charAt((byte >> 4) & 0xf) + __C_HEX.charAt(byte & 0xf);
}

function __cRandomUUID(options?: any): string {
  if (options !== undefined && options !== null) __cValidateObject(options, "options");
  const payload: string = __cPayload(__cNative.cryptoRandomBytes(16));
  const bytes: Buffer = Buffer.from(payload, "base64");
  const octets: number[] = [];
  for (let index = 0; index < 16; index++) octets.push(Number(bytes[index]));
  octets[6] = (octets[6] & 0x0f) | 0x40;
  octets[8] = (octets[8] & 0x3f) | 0x80;
  let out: string = "";
  for (let index = 0; index < 16; index++) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out = out + "-";
    out = out + __cByteHex(octets[index]);
  }
  return out;
}

// `timingSafeEqual(a, b)`: the length check throws, the comparison itself is
// the native's constant-time one.
function __cTimingSafeEqual(a: any, b: any): boolean {
  if (!__cIsByteView(a)) {
    throw new ERR_INVALID_ARG_TYPE("a", ["ArrayBuffer", "ArrayBufferView"], a);
  }
  if (!__cIsByteView(b)) {
    throw new ERR_INVALID_ARG_TYPE("b", ["ArrayBuffer", "ArrayBufferView"], b);
  }
  const left: Buffer = __cAsBuffer(a);
  const right: Buffer = __cAsBuffer(b);
  if (Number(left.length) !== Number(right.length)) {
    throw new ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH();
  }
  return Boolean(
    __cNative.cryptoTimingSafeEqual(left.toString("base64"), right.toString("base64")),
  );
}

// The byte length `generateKey(type, options)` asks for, with Node's
// validation: an HMAC key is any bit length from 8 up, truncated to whole
// bytes, while an AES key is one of three exact sizes — and the two report
// different errors, `ERR_OUT_OF_RANGE` and `ERR_INVALID_ARG_VALUE`.
function __cGenerateKeyBytes(type: any, options: any): number {
  __cValidateString(type, "type");
  const kind: string = type;
  if (kind !== "hmac" && kind !== "aes") {
    throw new ERR_INVALID_ARG_VALUE("type", type, "must be a supported key type");
  }
  __cValidateObject(options, "options");
  const length: any = options.length;
  if (kind === "hmac") {
    const bits: number = __cValidateInteger(length, "options.length", 8, 2147483647);
    return Math.floor(bits / 8);
  }
  __cValidateInteger(length, "options.length", 0, 4294967295);
  const bits: number = Number(length);
  if (bits !== 128 && bits !== 192 && bits !== 256) {
    throw new ERR_INVALID_ARG_VALUE(
      "options.length",
      length,
      "must be one of: 128, 192, 256",
    );
  }
  return bits / 8;
}

function __cGenerateKey(bytes: number): any {
  return new KeyObject("secret", __cPayload(__cNative.cryptoRandomBytes(bytes)));
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// `crypto.constants`, the numeric table `lib/internal/crypto/util.js` copies
// out of OpenSSL. Only the padding, point-conversion and RSA-PSS values are
// meaningful here (the TLS `SSL_OP_*` half belongs to `node:tls`, which this
// library does not have); the names are kept because `crypto.constants` is
// observable on its own.
const __cConstants: any = {
  OPENSSL_VERSION_NUMBER: 0x30500000,
  RSA_PKCS1_PADDING: 1,
  RSA_NO_PADDING: 3,
  RSA_PKCS1_OAEP_PADDING: 4,
  RSA_X931_PADDING: 5,
  RSA_PKCS1_PSS_PADDING: 6,
  RSA_PSS_SALTLEN_DIGEST: -1,
  RSA_PSS_SALTLEN_MAX_SIGN: -2,
  RSA_PSS_SALTLEN_AUTO: -2,
  POINT_CONVERSION_COMPRESSED: 2,
  POINT_CONVERSION_UNCOMPRESSED: 4,
  POINT_CONVERSION_HYBRID: 6,
  defaultCoreCipherList:
    "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:" +
    "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:" +
    "ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:" +
    "DHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-SHA256:" +
    "DHE-RSA-AES128-SHA256:ECDHE-RSA-AES256-SHA384:DHE-RSA-AES256-SHA384:" +
    "ECDHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA256:HIGH:!aNULL:!eNULL:!EXPORT:" +
    "!DES:!RC4:!MD5:!PSK:!SRP:!CAMELLIA",
};

// Every asymmetric entry point this module does not implement answers the same
// diagnosable error rather than being absent, so a program that reaches for
// one gets `ERR_CRYPTO_UNSUPPORTED_OPERATION` instead of
// `undefined is not a function`. See the header for the list.
function __cUnsupported(): any {
  throw new ERR_CRYPTO_UNSUPPORTED_OPERATION();
}

// ---------------------------------------------------------------------------
// WebCrypto
// ---------------------------------------------------------------------------
//
// `crypto.webcrypto` / `crypto.subtle` exist with `digest`, `getRandomValues`
// and `randomUUID` only: those three need nothing but the primitives above,
// while `encrypt`/`decrypt`/`sign`/`verify`/`importKey` need the `CryptoKey`
// algorithm-normalisation machinery and (for most algorithms) the asymmetric
// half this module does not have. The three that are here answer real values
// rather than rejecting, which is what makes `subtle.digest` usable.
const __cSubtle: any = {
  digest(algorithm: any, data: any): any {
    let name: any = algorithm;
    if (algorithm !== null && typeof algorithm === "object") name = algorithm.name;
    const resolved: string = __cWebCryptoDigest(name);
    const base64: string = __cToBase64(data, undefined, "data");
    const payload: string = __cPayload(__cNative.cryptoHashOne(resolved, base64, -1));
    const bytes: Buffer = Buffer.from(payload, "base64");
    return Promise.resolve(bytes);
  },
  encrypt(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  decrypt(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  sign(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  verify(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  importKey(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  exportKey(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  generateKey(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  deriveBits(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  deriveKey(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  wrapKey(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
  unwrapKey(): any {
    return Promise.reject(new ERR_CRYPTO_UNSUPPORTED_OPERATION());
  },
};

// WebCrypto spells its digests `SHA-1`, `SHA-256`, `SHA-384`, `SHA-512`; the
// natives want OpenSSL's names.
function __cWebCryptoDigest(name: any): string {
  const upper: string = String(name).toUpperCase();
  if (upper === "SHA-1") return "sha1";
  if (upper === "SHA-256") return "sha256";
  if (upper === "SHA-384") return "sha384";
  if (upper === "SHA-512") return "sha512";
  throw new NodeError("NotSupportedError", "Unrecognized algorithm name");
}

const __cWebcrypto: any = {
  subtle: __cSubtle,
  getRandomValues(view: any): any {
    return __cRandomFill(view, undefined, undefined);
  },
  randomUUID(): string {
    return __cRandomUUID(undefined);
  },
};

// ---------------------------------------------------------------------------
// The module object
// ---------------------------------------------------------------------------

const __node_crypto: any = {
  // Classes, so that `crypto.Hash`, `crypto.Hmac`, `crypto.Cipheriv` and
  // `crypto.Decipheriv` are the names `instanceof` is written against.
  Hash: Hash,
  Hmac: Hmac,
  Cipheriv: Cipheriv,
  Decipheriv: Decipheriv,
  KeyObject: KeyObject,

  createHash(algorithm: any, options?: any): any {
    return new Hash(algorithm, options);
  },
  createHmac(algorithm: any, key: any, options?: any): any {
    return new Hmac(algorithm, key, options);
  },

  // `crypto.hash(algorithm, data, outputEncoding | options)`, Node 21's
  // one-shot. The default output encoding is `'hex'`, not a Buffer — the one
  // place in this module where that is so — and the third argument may also
  // be an options object carrying `outputEncoding` and `outputLength` (which
  // is how an XOF's length is asked for without a `Hash` object).
  hash(algorithm: any, data: any, options?: any): any {
    __cValidateString(algorithm, "algorithm");
    const name: string = algorithm;

    let outputEncoding: any = "hex";
    let outputLength: number = -1;
    if (options !== undefined && options !== null && typeof options === "object") {
      if (options.outputEncoding !== undefined) outputEncoding = options.outputEncoding;
      outputLength = __cOutputLength(options);
    } else if (options !== undefined) {
      outputEncoding = options;
    }
    // Node validates the encoding before it hashes anything: a non-string is
    // `ERR_INVALID_ARG_TYPE` and an unknown name `ERR_INVALID_ARG_VALUE` — not
    // the `ERR_UNKNOWN_ENCODING` the Buffer layer would raise.
    if (typeof outputEncoding !== "string") {
      throw new ERR_INVALID_ARG_TYPE("outputEncoding", "string", outputEncoding);
    }
    if (
      String(outputEncoding) !== "buffer" &&
      __bufNormalizeEncoding(outputEncoding) === ""
    ) {
      throw new ERR_INVALID_ARG_VALUE("outputEncoding", outputEncoding, "is invalid");
    }

    if (outputLength < 0) __cWarnDefaultShakeLength(name);
    const base64: string = __cToBase64(data, undefined, "data");
    const result: any = __cNative.cryptoHashOne(name, base64, outputLength);
    if (String(result).charAt(0) !== "+") {
      const error: any = __cTakeError();
      if (String(error.code) === "ERR_CRYPTO_INVALID_DIGEST") {
        throw new Error("Digest method not supported");
      }
      // The one-shot reports a rejected `outputLength` in its own words rather
      // than with OpenSSL's `ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH`, which is
      // what `createHash` answers for the same mistake.
      if (String(error.code) === "ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH") {
        throw new Error(
          "Output length " + outputLength + " is invalid for " + name +
            ", which does not support XOF",
        );
      }
      throw error;
    }
    return __cFromBase64(String(result).slice(1), outputEncoding);
  },

  createCipheriv(cipher: any, key: any, iv: any, options?: any): any {
    return new Cipheriv(cipher, key, iv, options);
  },
  createDecipheriv(cipher: any, key: any, iv: any, options?: any): any {
    return new Decipheriv(cipher, key, iv, options);
  },

  createSecretKey(key: any, encoding?: any): any {
    return new KeyObject("secret", __cKeyToBase64(key, encoding, "key"));
  },

  generateKeySync(type: any, options: any): any {
    return __cGenerateKey(__cGenerateKeyBytes(type, options));
  },
  generateKey(type: any, options: any, callback: any): void {
    // The validation runs synchronously, as in Node: a bad `type`, `options`
    // or `length` *throws* rather than reaching the callback, and a missing
    // callback is itself an `ERR_INVALID_ARG_TYPE`.
    const bytes: number = __cGenerateKeyBytes(type, options);
    __cValidateFunction(callback, "callback");
    __cDeferred(callback, function (): any {
      return __cGenerateKey(bytes);
    });
  },

  getHashes(): string[] {
    return __cNames(__cPayload(__cNative.cryptoHashNames()));
  },
  getCiphers(): string[] {
    return __cNames(__cPayload(__cNative.cryptoCipherNames()));
  },
  getCurves(): string[] {
    return __cNames(__cPayload(__cNative.cryptoCurveNames()));
  },
  getCipherInfo(nameOrNid: any, options?: any): any {
    return __cCipherInfo(nameOrNid, options);
  },

  // This build is not FIPS-capable, which is the shape Node reports for a
  // non-FIPS OpenSSL: `getFips()` is 0 and setting it throws.
  getFips(): number {
    return 0;
  },
  setFips(value: any): void {
    if (value) throw new ERR_CRYPTO_FIPS_UNAVAILABLE();
  },
  get fips(): boolean {
    return false;
  },

  pbkdf2Sync(password: any, salt: any, iterations: any, keylen: any, digest: any): any {
    return Buffer.from(__cPbkdf2(password, salt, iterations, keylen, digest), "base64");
  },
  pbkdf2(
    password: any,
    salt: any,
    iterations: any,
    keylen: any,
    digest: any,
    callback: any,
  ): void {
    __cDeferred(callback, function (): any {
      return Buffer.from(__cPbkdf2(password, salt, iterations, keylen, digest), "base64");
    });
  },

  scryptSync(password: any, salt: any, keylen: any, options?: any): any {
    return Buffer.from(__cScrypt(password, salt, keylen, options), "base64");
  },
  scrypt(password: any, salt: any, keylen: any, options?: any, callback?: any): void {
    let opts: any = options;
    let cb: any = callback;
    if (__evIsFn(opts)) {
      cb = opts;
      opts = undefined;
    }
    __cDeferred(cb, function (): any {
      return Buffer.from(__cScrypt(password, salt, keylen, opts), "base64");
    });
  },

  // Node answers an `ArrayBuffer` from `hkdf`/`hkdfSync` rather than a
  // Buffer. A byte view here has no fields at all (`type BufferView(U8) has
  // no fields`, zun#38), so its backing `ArrayBuffer` is unreachable and this
  // answers the view itself — the same bytes, one wrapper short. Every
  // consumer in the corpus immediately writes `Buffer.from(result)`, which
  // accepts either.
  hkdfSync(digest: any, key: any, salt: any, info: any, keylen: any): any {
    return Buffer.from(__cHkdf(digest, key, salt, info, keylen), "base64");
  },
  hkdf(digest: any, key: any, salt: any, info: any, keylen: any, callback?: any): void {
    __cDeferred(callback, function (): any {
      return Buffer.from(__cHkdf(digest, key, salt, info, keylen), "base64");
    });
  },

  randomBytes(size: any, callback?: any): any {
    if (callback === undefined || callback === null) return __cRandomBytes(size);
    __cDeferred(callback, function (): any {
      return __cRandomBytes(size);
    });
    return undefined;
  },
  pseudoRandomBytes(size: any, callback?: any): any {
    return __node_crypto.randomBytes(size, callback);
  },
  prng(size: any, callback?: any): any {
    return __node_crypto.randomBytes(size, callback);
  },
  rng(size: any, callback?: any): any {
    return __node_crypto.randomBytes(size, callback);
  },
  randomFillSync(buffer: any, offset?: any, size?: any): any {
    return __cRandomFill(buffer, offset, size);
  },
  randomFill(buffer: any, offset?: any, size?: any, callback?: any): void {
    let start: any = offset;
    let count: any = size;
    let cb: any = callback;
    if (__evIsFn(start)) {
      cb = start;
      start = undefined;
      count = undefined;
    } else if (__evIsFn(count)) {
      cb = count;
      count = undefined;
    }
    __cDeferred(cb, function (): any {
      return __cRandomFill(buffer, start, count);
    });
  },
  randomInt(minOrMax: any, maxOrCb?: any, maybeCb?: any): any {
    return __cRandomInt(minOrMax, maxOrCb, maybeCb);
  },
  randomUUID(options?: any): string {
    return __cRandomUUID(options);
  },
  getRandomValues(view: any): any {
    return __cRandomFill(view, undefined, undefined);
  },

  timingSafeEqual(a: any, b: any): boolean {
    return __cTimingSafeEqual(a, b);
  },

  webcrypto: __cWebcrypto,
  subtle: __cSubtle,

  // `crypto.secureHeapUsed()`: the secure heap is an OpenSSL allocator
  // feature, and this build has none, which Node reports as a zero-sized one.
  secureHeapUsed(): any {
    return { total: 0, min: 0, used: 0, utilization: 0 };
  },

  // ---------------------------------------------------------------------
  // The asymmetric surface, present but unimplemented (see the header).
  // ---------------------------------------------------------------------
  createSign(): any {
    return __cUnsupported();
  },
  createVerify(): any {
    return __cUnsupported();
  },
  sign(): any {
    return __cUnsupported();
  },
  verify(): any {
    return __cUnsupported();
  },
  createPublicKey(): any {
    return __cUnsupported();
  },
  createPrivateKey(): any {
    return __cUnsupported();
  },
  generateKeyPair(): any {
    return __cUnsupported();
  },
  generateKeyPairSync(): any {
    return __cUnsupported();
  },
  publicEncrypt(): any {
    return __cUnsupported();
  },
  publicDecrypt(): any {
    return __cUnsupported();
  },
  privateEncrypt(): any {
    return __cUnsupported();
  },
  privateDecrypt(): any {
    return __cUnsupported();
  },
  createDiffieHellman(): any {
    return __cUnsupported();
  },
  createDiffieHellmanGroup(): any {
    return __cUnsupported();
  },
  getDiffieHellman(): any {
    return __cUnsupported();
  },
  diffieHellman(): any {
    return __cUnsupported();
  },
  createECDH(): any {
    return __cUnsupported();
  },
  checkPrime(): any {
    return __cUnsupported();
  },
  checkPrimeSync(): any {
    return __cUnsupported();
  },
  generatePrime(): any {
    return __cUnsupported();
  },
  generatePrimeSync(): any {
    return __cUnsupported();
  },
};

// `constants` is a read-only property in Node, as in `node:zlib`.
Object.defineProperty(__node_crypto, "constants", {
  configurable: false,
  enumerable: true,
  value: __cConstants,
});

// ---------------------------------------------------------------------------
// The second name the bundler rewrites `crypto` as a receiver to
// ---------------------------------------------------------------------------
//
// The engine's prelude has a `crypto` of its own (`crates/zun_prelude/builtin/
// crypto.zun`, the WinterCG `getRandomValues`/`randomUUID` pair), and the
// checker lowers `crypto.<member>` to it from *inside a function body* even
// when a user declaration shadows the name — exactly the shape
// `src/console/global.ts` and `src/perf_hooks/perf_hooks.ts` document for
// `console` and `performance`. So
//
//     const crypto = require('crypto');
//     function encrypt(v) { return crypto.createCipheriv(...); }
//
// reads `createCipheriv` off the prelude object. This is the second half of
// https://github.com/UrubuCode/zun/issues/85, filed for `console`, landing on
// a second prelude namespace; the standalone repro is in
// ../../test/crypto/README.md.
//
// `tools/bundle_node_test.sh` therefore rewrites `crypto` *as a receiver* to
// this second name, which the checker has no opinion about, leaving every
// other use of the word alone. It denotes the same object.
const __zunCrypto: any = __node_crypto;

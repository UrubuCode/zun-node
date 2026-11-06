# node:crypto — Node.js compatibility tests

The compatibility bar for `crypto` is **Node.js 25's own test suite**, not tests
we write. `crypto` is **not finished** until it passes 100% of Node's
`test-crypto*` tests.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module —
115 files under the single `test-crypto` prefix, which includes `test-crypto.js`
itself. Each file is fetched verbatim from `nodejs/node` at tag `v25.0.0`;
nothing is vendored here. `NODE_FIXTURES.txt` lists the two `test/fixtures/*`
files the reachable part of the corpus opens (`sample.png`, whose SHA-1
`test-crypto-hash.js` asserts, and `utf8_test_text.txt`, which
`test-crypto-oneshot-hash.js` hashes with every algorithm), which the tracker
downloads next to the test file so the harness's
`path.join(__dirname, "..", "fixtures")` finds them.

## How they run

`crypto` is a `zun-ts+ext` module, the kind `os` established: the Node-shaped
API is TypeScript and the primitives are Rust behind the ABI.

```sh
cargo build -p zun_cli                              # the `zun` binary
cargo build --manifest-path zun-node/Cargo.toml     # the extension cdylib
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --ext zun-node/target/debug/libzun_node.so \
    --module crypto
```

Each test is bundled by `tools/bundle_node_test.sh` (`util` → `events` →
`process` → `assert` → `path` → `querystring` → `punycode` → `url` → `timers` →
`console` → `buffer` → `string_decoder` → **`stream`** → **`crypto`** → the
harness) and then run as `zun run --ext <lib> <bundle.ts>`. `stream` is in that
list because `Hash`, `Hmac`, `Cipheriv` and `Decipheriv` are all `Transform`s.

Two harness files belong to this module:

* `tools/harness/crypto_common.ts` is `test/common/crypto.js`, the part the
  corpus reaches — twelve files destructure `hasOpenSSL3` from it to pick
  between the OpenSSL 1.1 and OpenSSL 3 error text and IV-length limits.
* `tools/harness/crypto_flag.ts` sets `common.hasCrypto = true`, and the
  bundler appends it *after* `tools/harness/common.ts` exactly when
  `src/crypto/crypto.ts` made it into the file list. The flag has to track what
  the bundle contains rather than what the library can do: a `path` bundle has
  no crypto in it. The throwing `__node_crypto` stub that used to live in
  `common.ts` is gone — the two `assert` tests that guarded on `hasCrypto` now
  run against the real module.

## What is implemented

**Hashing.** `createHash`, `Hash` as a real `Transform` with `update` (string
in any encoding, or any byte view), `digest` (Buffer, or a string in any
encoding) and `copy` with its `outputLength` override; `crypto.hash()`, Node
21's one-shot, with the third argument in both its forms (an encoding name or
an `{ outputEncoding, outputLength }` object). The algorithms are MD5, SHA-1,
the whole SHA-2 family including `sha512-224` and `sha512-256`, SHA-3 in four
sizes, the two XOFs (`shake128`, `shake256`, with `options.outputLength` from 0
to a megabyte), RIPEMD-160, BLAKE2b-512 and BLAKE2s-256 — plus OpenSSL's
aliases for each (`RSA-SHA1`, `md5WithRSAEncryption`, `rmd160`, …), resolved
case-insensitively as `EVP_get_digestbyname` resolves them.

**HMAC.** `createHmac` / `Hmac`, over any of those digests, with a string, a
byte view or a secret `KeyObject` as the key, and RFC 2104's key reduction.

**Symmetric ciphers.** `createCipheriv` / `createDecipheriv`, `Cipheriv` /
`Decipheriv` as `Transform`s, with `update`/`final` in every encoding
combination (including Node's single-`StringDecoder` rule, so a second,
different output encoding is the `Cannot change encoding` assertion),
`setAutoPadding` with PKCS#7 applied and stripped, `setAAD`, `getAuthTag`,
`setAuthTag` with the per-mode tag-length rules and the DEP0182 warning for an
undeclared short GCM tag. The modes are AES-128/192/256 in ECB, CBC, CTR and
GCM, ChaCha20 and ChaCha20-Poly1305, reachable under every name OpenSSL gives
them (`aes256` is `aes-256-cbc`, `aes-256-gcm` canonicalises to
`id-aes256-gcm`).

**Key derivation.** `pbkdf2` / `pbkdf2Sync`, `scrypt` / `scryptSync` (with both
spellings of each parameter and the `maxmem` check), `hkdf` / `hkdfSync` —
each in the sync and the callback form, the callback delivered on a later tick.

**Randomness.** `randomBytes` (sync and callback), `randomFillSync` /
`randomFill`, `randomInt` with Node's rejection sampling, `randomUUID`,
`getRandomValues`, and `generateKey` / `generateKeySync` for `hmac` and `aes`
secret keys. The source is the OS CSPRNG (`BCryptGenRandom` /
`getrandom(2)`).

**The rest.** `timingSafeEqual` (constant-time, with
`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`), `createSecretKey` and `KeyObject` for
secret keys (`type`, `symmetricKeySize`, `export`, `equals`), `getHashes`,
`getCiphers`, `getCurves`, `getCipherInfo` (the full OpenSSL 3 NID / block size
/ key length / IV length / mode table, with the CCM and OCB IV ranges),
`getFips` / `setFips`, `secureHeapUsed`, `constants`, and
`webcrypto` / `subtle` with a working `digest`.

The primitives are RustCrypto's: `md-5`, `sha1`, `sha2`, `sha3`, `ripemd`,
`blake2` behind one `Box<dyn DynDigest>` handle table, `aes` for the block
function with ECB/CBC/CTR/GCM written over it, `ghash` and `poly1305` for the
AEAD tags, `chacha20` for the stream cipher, `scrypt` for RFC 7914, `subtle`
for the constant-time compare and `getrandom` for the OS CSPRNG. All pure Rust,
so this extension still builds with nothing but a Rust toolchain; HMAC, PBKDF2
and HKDF are written out over `DynDigest` rather than taken from
`hmac`/`pbkdf2`/`hkdf`, because those are a generic instantiation per digest and
a handle table cannot hold one. 24 Rust tests pin the bytes against the
published vectors — see **Verified outside the corpus** below.

## What is not implemented

**Asymmetric cryptography, in all its forms.** `generateKeyPair`,
`createSign` / `createVerify` / `sign` / `verify`, `publicEncrypt` /
`privateDecrypt`, `createPublicKey` / `createPrivateKey`,
`createDiffieHellman` / `createECDH` / `diffieHellman`, `X509Certificate`,
`checkPrime` / `generatePrime`, the post-quantum families (ML-DSA, ML-KEM,
SLH-DSA) and the key-encapsulation API. Each of those entry points is
*present* and raises `ERR_CRYPTO_UNSUPPORTED_OPERATION`, so a program that
reaches for one gets a diagnosable error rather than
`undefined is not a function`. **72 of the 115 files** reach for it, and all but
`test-crypto-keygen-missing-oid.js` (which asserts an error) fail there: every
`test-crypto-keygen*` (32), `test-crypto-dh*` (14), `test-crypto-pqc-*` (7),
`test-crypto-ecdh-*` (2), the sign/verify, public-encrypt, prime,
encapsulation, SPKAC, key-wrap and X.509 files. It is a larger piece of work
than the symmetric half and was deliberately deferred.

**The symmetric gaps**: the CCM, OCB, XTS and key-wrap modes, and the legacy
block ciphers (DES/3DES, Camellia, ARIA, SM4, RC4, Blowfish). `getCiphers()`
and `getCipherInfo()` still *list* them, with OpenSSL's real NIDs and sizes,
because those two functions describe algorithms rather than capability — which
is also what lets `test-crypto-getcipherinfo.js` pass. `createCipheriv` of one
answers `ERR_CRYPTO_UNSUPPORTED_OPERATION`.

**The WebCrypto surface** beyond `subtle.digest`, `getRandomValues` and
`randomUUID`: `importKey`, `encrypt`, `decrypt`, `sign`, `verify`,
`deriveBits`, `wrapKey` and the `CryptoKey` algorithm-normalisation machinery
they stand on. **FIPS**: this build is not FIPS-capable, which is the shape
Node reports for a non-FIPS OpenSSL (`getFips()` is 0, `setFips(true)` throws).
**The secure heap** is an OpenSSL allocator feature with nothing behind it
here, so `secureHeapUsed()` reports a zero-sized one. **argon2**, which Node 25
added, is absent, and `test-crypto-argon2-unsupported.js` — the file that
asserts the absence — passes.

## Blockers

Two things cap this corpus, and neither is the cryptography.

**The asymmetric half is simply not written** (above), which accounts for about
two thirds of the files.

**zun#38 — a typed array is opaque through an `any` binding**: no `length`, no
indexing, no `toString`. Every `Buffer` this module hands back reaches a Node
test through an `any` binding (`const key = crypto.randomBytes(32)`,
`hash.digest()`, `key.export()`), so `key.length` reads `undefined` and
`.toString('hex')` throws. The bytes are right — the Rust vector tests prove
it, and so does every test here that asks for a *string* digest — but a test
that compares raw buffers cannot see them. This is what stops
`test-crypto-pbkdf2.js` (`actual.toString('latin1')`),
`test-crypto-hmac.js`, `test-crypto-padding.js` (whose `dec()` helper string-
concatenates a Buffer, and gets `[object Object]`),
`test-crypto-secret-keygen.js` (`keybuf.byteLength`) and
`test-crypto-gcm-explicit-short-tag.js` (`tag.byteLength` as an option value,
which reads `undefined` and so takes the *implicit* path and emits the warning
the test forbids).

### zun#85, part 2, hits a second prelude namespace: `crypto`

[zun#85](https://github.com/UrubuCode/zun/issues/85) is filed against
`console`, and its second half is stated generally — "a module-level `const` is
honoured at top level but not inside a function: the same call there resolves
against the prelude namespace". The engine's prelude also has a `crypto`
(`crates/zun_prelude/builtin/crypto.zun`, the WinterCG
`getRandomValues`/`randomUUID` pair), so the same defect lands on this module's
name. It reproduces with no library and no extension at all —
`zun run repro.ts`:

```ts
const crypto: any = { createHash: function (): string { return "mine"; } };
const ns: any = crypto;
function viaDecl(): string { return typeof crypto.createHash; }
const viaArrow: any = function (): string { return typeof crypto.createHash; };
function viaAlias(): string { return typeof ns.createHash; }
console.log("top   " + typeof crypto.createHash);
console.log("arrow " + viaArrow());
console.log("alias " + viaAlias());
console.log("decl  " + viaDecl());
```

```text
zun                        node (same file as .js)
top   function             top   function
arrow function             arrow function
alias function             alias function
decl  undefined            decl  function
```

and *calling* it rather than reading it reports
`createHash is not a function`. Only a `function` declaration's body is
affected: a function *expression* assigned to a `const` sees the user binding,
and so does a second alias (`ns`) inside a declaration, which is what pins the
cause to the name rather than to the scope. The resolution is in
`crates/zun_sema`, against the namespace `crates/zun_prelude/src/lib.rs`
registers.

`tools/bundle_node_test.sh` works around it the way it already does for
`console` and `performance`: `crypto` *as a receiver* is rewritten to
`__zunCrypto`, a second name `src/crypto/crypto.ts` binds to the same object
and the checker has no opinion about. Without that rewrite every test that
wraps a crypto call in a `function` declaration — which is most of the cipher
corpus — failed on its first call; `test-crypto-padding-aes256.js` is the one
that now passes because of it.

### Per-test blockers

| Test | Blocker |
|---|---|
| `test-crypto-argon2-unsupported.js` | ✅ passes |
| `test-crypto-default-shake-lengths-oneshot.js` | ✅ passes |
| `test-crypto-default-shake-lengths.js` | ✅ passes |
| `test-crypto-ecb.js` | ✅ passes |
| `test-crypto-encoding-validation-error.js` | ✅ passes |
| `test-crypto-from-binary.js` | ✅ passes |
| `test-crypto-gcm-implicit-short-tag.js` | ✅ passes |
| `test-crypto-getcipherinfo.js` | ✅ passes |
| `test-crypto-hash-stream-pipe.js` | ✅ passes |
| `test-crypto-keygen-missing-oid.js` | ✅ passes |
| `test-crypto-oneshot-hash-xof.js` | ✅ passes |
| `test-crypto-op-during-process-exit.js` | ✅ passes |
| `test-crypto-padding-aes256.js` | ✅ passes |
| `test-crypto-randomfillsync-regression.js` | ✅ passes |
| `test-crypto-webcrypto-aes-decrypt-tag-too-small.js` | ✅ passes |
| `test-crypto.js` | requires `node:tls` (`tls.createSecureContext`, `tls.getCiphers`) and `fixtures.readKey`; also iterates `getCiphers()` constructing every one, which reaches the unimplemented modes |
| `test-crypto-authenticated.js` | requires the AEAD vector table through a *computed* specifier (`require(fixtures.path('aead-vectors.js'))`), which the bundler's textual require rewriting cannot resolve |
| `test-crypto-authenticated-stream.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.alloc(n)` where `n` is a loop variable — a `number` cannot be a Buffer size |
| `test-crypto-cipheriv-decipheriv.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.alloc(n)` over the IV-length loop |
| `test-crypto-classes.js` | [zun#19](https://github.com/UrubuCode/zun/issues/19) `crypto[clazz]` is an `any`-held constructor on the right of `instanceof`; the cases also include `Sign`, `Verify`, `DiffieHellman` and `ECDH` |
| `test-crypto-domain.js` | requires `node:domain`, which the harness only stubs |
| `test-crypto-domains.js` | requires `node:domain`, which the harness only stubs |
| `test-crypto-fips.js` | requires `internal/test/binding`, `node:child_process` re-execution and `worker_threads`; this build is not FIPS-capable either |
| `test-crypto-gcm-explicit-short-tag.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) `authTagLength: tag.byteLength` reads `undefined` off an `any`-held Buffer, so the explicit path is never taken and the DEP0182 warning the test forbids is emitted |
| `test-crypto-hash.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) `a3 = createHash(...).digest()` is a Buffer compared with `deepStrictEqual`; the test also needs `crypto.Hash('sha256')` without `new` ([zun#25](https://github.com/UrubuCode/zun/issues/25)). Every *string* digest in it — hex, base64, latin1, ucs2, the SHAKE lengths, `copy()` — is correct, and the same assertions pass in the differential probe |
| `test-crypto-hkdf.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.from(secret)` where `secret` crossed an `any`; `hkdfSync` also answers a view rather than its `ArrayBuffer`, which has no reachable fields here |
| `test-crypto-hmac.js` | [zun#17](https://github.com/UrubuCode/zun/issues/17) the `keyWrappers` array holds `crypto.createSecretKey` as a *value* and spreads a conditional array into it; the HMAC values themselves agree with Node for every algorithm in the differential probe |
| `test-crypto-key-objects.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.alloc(len, fill)` with a computed fill byte; needs `createPublicKey`/`createPrivateKey` as well |
| `test-crypto-key-objects-messageport.js` | top-level `await` (the bundler wraps no module body, so `return` at top level is a parse error) and `worker_threads` |
| `test-crypto-key-objects-to-crypto-key.js` | needs the WebCrypto `CryptoKey` conversion, which is not implemented |
| `test-crypto-lazy-transform-writable.js` | the test-body `class OldStream extends Stream` assigns `this.readable` with no field declaration, which is a compile error here; also `hasher.read().toString('hex')` ([zun#38](https://github.com/UrubuCode/zun/issues/38)) |
| `test-crypto-no-algorithm.js` | requires `worker_threads` and `node:child_process` re-execution with `--openssl-config` |
| `test-crypto-oneshot-hash.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) `input.toString()` on the fixture Buffer; the `crypto.hash` half of the test (every algorithm × hex/base64/buffer/default) is correct and agrees with Node in the differential probe |
| `test-crypto-padding.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) its `dec()` helper string-concatenates the Buffer `update()` answers, which stringifies to `[object Object]`. The encryption half — both `openssl enc` vectors, with and without padding — is asserted and passes; the padding *errors* (`wrong final block length`, `bad decrypt`) carry OpenSSL’s exact code, message and reason |
| `test-crypto-pbkdf2.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) `actual.toString(encoding)` on the derived key. The values are pinned against RFC 6070 and RFC 7914 in `cargo test` |
| `test-crypto-random.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.from(buf)` where `buf` is already a byte view |
| `test-crypto-randomuuid.js` | [zun#58](https://github.com/UrubuCode/zun/issues/58) `Buffer.from(uuid.slice(14, 16), 'hex')[0]` — the slice of an `any`-held string does not reach `Buffer.from` |
| `test-crypto-scrypt.js` | `crypto.scrypt(...args)` — spread arguments are not lowered yet; the values are pinned against RFC 7914 in `cargo test` |
| `test-crypto-sec-level.js` | requires `internal/crypto/util`’s `getOpenSSLSecLevel()` |
| `test-crypto-secret-keygen.js` | [zun#38](https://github.com/UrubuCode/zun/issues/38) `keybuf.byteLength` on the exported key. Every error shape the test asserts — `ERR_INVALID_ARG_TYPE` for the type, options and `options.length`, `ERR_OUT_OF_RANGE` for an HMAC length below 8 or above 2³¹, `ERR_INVALID_ARG_VALUE` for an AES length that is not 128/192/256 and for an unknown type — is produced |
| `test-crypto-secure-heap.js` | top-level `await` plus `node:child_process` re-execution with `--secure-heap` |
| `test-crypto-stream.js` | the test-body `class Stream2buffer extends stream.Writable` assigns `this._buffers` with no field declaration; needs `createSign` too |
| `test-crypto-subtle-cross-realm.js` | needs `vm` realms and the full `subtle.encrypt`/`importKey` surface |
| `test-crypto-subtle-zero-length.js` | needs `subtle.importKey`/`encrypt`/`decrypt` for AES-GCM |
| `test-crypto-update-encoding.js` | needs `createSign`/`createVerify`; the cipher and HMAC quarter of the test passes |
| `test-crypto-verify-failure.js` | requires `node:tls` |
| `test-crypto-worker-thread.js` | requires `worker_threads` |
| `test-crypto-x509.js` | requires `internal/crypto/x509`; `X509Certificate` is not implemented |

| `test-crypto-keygen*.js` (32 files) | the asymmetric half is not implemented — `generateKeyPair` raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` |
| `test-crypto-dh*.js` (14 files) | the asymmetric half is not implemented — `createDiffieHellman / diffieHellman` raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` |
| `test-crypto-pqc-*.js` (7 files) | the post-quantum families (ML-DSA, ML-KEM, SLH-DSA) are not implemented |
| `test-crypto-ecdh-convert-key.js`, `test-crypto-ecdh-setpublickey-deprecation.js` | the asymmetric half is not implemented — `createECDH` raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` |
| `test-crypto-sign-verify.js`, `test-crypto-async-sign-verify.js`, `test-crypto-psychic-signatures.js`, `test-crypto-rsa-dsa.js` | the asymmetric half is not implemented — `createSign / createVerify` raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` |
| `test-crypto-oaep-zero-length.js`, `test-crypto-private-decrypt-gh32240.js`, `test-crypto-publicDecrypt-fails-first-time.js` | the asymmetric half is not implemented — `publicEncrypt / privateDecrypt` raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` |
| `test-crypto-prime.js` | the asymmetric half is not implemented — `checkPrime / generatePrime` raises `ERR_CRYPTO_UNSUPPORTED_OPERATION` |
| `test-crypto-encap-decap.js` | needs the key-encapsulation API (`encapsulate`/`decapsulate`) and top-level `await` |
| `test-crypto-certificate.js` | needs `Certificate` (SPKAC), which is not implemented |
| `test-crypto-aes-wrap.js`, `test-crypto-des3-wrap.js` | the AES and 3DES key-wrap modes are not implemented — `getCiphers()` lists them, `createCipheriv` answers `ERR_CRYPTO_UNSUPPORTED_OPERATION` |
| `test-crypto-argon2.js` | argon2, which Node 25 added, is not implemented |

## Verified outside the corpus

Because zun#38 hides the bytes from much of the corpus, the primitives are
pinned the way `os` and `zlib`'s are: **24 Rust tests** (`src/crypto/tests.rs`,
in `cargo test`) over the primitives directly, every expected value an
RFC/NIST/FIPS vector or OpenSSL's own output —

* the `abc` digests of all eleven fixed-output algorithms (FIPS 180-4, FIPS
  202, RFC 1321, the RIPEMD-160 and BLAKE2 reference pages), an incremental
  hash equal to the one-shot, an independent `copy()`, and SHAKE squeezed at
  0, 5, 15, 16, 32 and 1 048 576 bytes;
* the digest-name table: sorted, duplicate-free, and every listed name
  resolvable, which is `test-crypto.js`' `validateList` plus its
  "every listed hash can be created" loop;
* HMAC against RFC 4231 §4.2/4.3/4.7 (SHA-256 and SHA-512, including the
  131-byte key that must be hashed down) and RFC 2202 case 1 for MD5;
* PBKDF2 against RFC 6070's four SHA-1 vectors and RFC 7914's 64-byte
  SHA-256 one; HKDF against RFC 5869 A.1, A.3 and A.4 plus the
  `255 * HashLen` boundary; scrypt against RFC 7914 §12's first two vectors
  and its rejection of a non-power-of-two `N`;
* AES-CBC against the `openssl enc` output `test-crypto-padding.js` quotes,
  and the same plaintext re-encrypted at chunk sizes 1, 3, 7, 16, 17 and 64 to
  prove the partial-block hold-back; AES-ECB against FIPS 197 C.1; AES-CTR
  against NIST SP 800-38A F.5.1; AES-GCM against NIST test cases 3, 4 and 5 —
  the last being a 64-bit IV, which must be folded through GHASH rather than
  used directly — and a tag that must fail to verify; ChaCha20-Poly1305
  against RFC 8439 §2.8.2;
* the padding classifications (`wrong final block length`, `bad decrypt`), the
  key/IV/tag-length refusals, and the cipher catalogue's sortedness, NIDs,
  canonical names and CCM/OCB IV ranges.

and **a differential pass against the installed Node** from the JavaScript
side, over every path that answers a *string* (zun#38 hides the Buffer ones):
165 values — `digest('hex')`, `digest('base64')`, `digest('latin1')` and the
one-shot `crypto.hash` for all fifteen fixed-output algorithms, the three
OpenSSL aliases, SHAKE128/256 at five output lengths, a multi-`update` hash, a
UTF-8 and a latin1 input of the same string, `copy()`, HMAC in six algorithms
with a short, an over-long and an empty key, `update(…, 'hex') + final('hex')`
round trips through AES-128/192/256-CBC, AES-CTR, AES-GCM (with and without
AAD), ChaCha20-Poly1305 (with and without AAD), the `aes256` alias, ECB, a
padding-disabled block, a 64-bit GCM IV, bare ChaCha20 and a five-chunk
`update` sequence, the cipher catalogue and `getCipherInfo` for seven ciphers
including CCM and OCB, and 35 error shapes (name, `code` and message).

All 165 agree, with three differences that are not disagreements: `getHashes()`
is shorter here by the names of algorithms this module does not implement
(`sm3`, `md5-sha1`, the `id-rsassa-*` set); the `Cannot change encoding`
assertion carries Node’s internal `ERR_INTERNAL_ASSERTION` code, which the
corpus matches only by message; and `crypto.hash(alg, data, { outputLength })`
is Node 24+ API, which the installed Node 22 oracle rejects as a non-string
encoding — the Node 25 test for it
(`test-crypto-oneshot-hash-xof.js`) passes here. The probe is
`diff_probe2.js` in the scratch tree, run under both `node` and
`zun run --ext`.

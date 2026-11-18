# `tls` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-tls-*.js` — 209 files,
listed in [`NODE_TESTS.txt`](NODE_TESTS.txt) and downloaded by
[`../../tools/run_node_tests.sh`](../../tools/run_node_tests.sh) together with
the key fixtures in [`NODE_FIXTURES.txt`](NODE_FIXTURES.txt). The per-test run
is [`RESULTS.md`](RESULTS.md).

**64 / 209 passing (30.6%)**, measured on Windows with the release engine and
`zun_node.dll` (2026-11-18). Baseline before this module existed: 0 / 209
(every file failed on `unresolved require('tls')`).

## Shape

- [`../../src/tls/mod.rs`](../../src/tls/mod.rs): a rustls 0.23 session per
  handle, driven as a memory BIO (`tlsFeed`/`tlsWrite`/`tlsPoll`/
  `tlsCloseNotify`, one poll record per call). The crypto provider is
  `rustls-rustcrypto` (pure Rust, so the crate still builds with no C
  toolchain). Chain verification is *recorded*, not enforced, as the OpenSSL
  `X509_V_ERR_*` code Node reports (`DEPTH_ZERO_SELF_SIGNED_CERT`,
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`,
  `CERT_HAS_EXPIRED`, ...); a CA-list member used as a leaf and X.509 v1
  certificates (which webpki refuses) are accepted the way OpenSSL accepts
  them. [`x509.rs`](../../src/tls/x509.rs) describes a certificate for
  `getPeerCertificate()` (subject/issuer, OpenSSL-spelled dates, fingerprints,
  `subjectaltname` with Node's quoting, modulus/exponent/bits, EC curve).
- [`../../src/tls/tls.ts`](../../src/tls/tls.ts): `TLSSocket` (a `net.Socket`
  subclass without a handle of its own, over any `Duplex`), `connect`,
  `createServer`/`Server`, `SecureContext`/`createSecureContext` (key/cert/ca
  as strings, buffers, views or arrays, `{ pem, passphrase }`, encrypted
  PKCS#8, key/cert mismatch, `minVersion`/`maxVersion`/`secureProtocol`,
  `ciphers` with "no cipher match"), `rejectUnauthorized`,
  `checkServerIdentity` (Node's algorithm), ALPN, SNI (`servername`,
  `addContext`, asynchronous `SNICallback` through a lazy server accept),
  `requestCert` client certificates, `getCipher`/`getProtocol`/
  `getCertificate`, `tlsClientError`, `handshakeTimeout`.

## Documented deviations

| Area | Deviation |
|---|---|
| Protocols | TLS 1.2 and 1.3 only, AEAD suites only (ECDHE + AES-GCM / ChaCha20). No TLS 1.0/1.1, RSA key exchange, CBC, DHE, PSK, renegotiation, OCSP stapling. |
| Sessions | No resumption: `getSession()`/`getTLSTicket()` answer `undefined`, `isSessionReused()` is `false`, no `'session'`/`'keylog'` events, ticket keys are stored only. |
| PFX | `pfx` is accepted but not decoded (no PKCS#12 parser). |
| CA store | No bundled/system roots: `rootCertificates` and `getCACertificates()` are empty, so verification without `ca` fails. |
| `tls.Server` | A factory (as `http.Server`): `new tls.Server(...)` is rewritten by the bundler to the call form; `instanceof tls.Server` is unavailable. |

## What blocks the rest

From [`RESULTS.md`](RESULTS.md): about 20 files need `internal/*`,
`../common/tls`, `child_process.fork` or `--cli` flags; about 20 exercise the
deviations above (PSK, PFX, sessions/tickets, OCSP, keylog, TLS 1.0/1.1,
DHE/cipher strings); the remainder are assertion mismatches on OpenSSL-exact
error strings or internals (`_handle`, `ssl` wrap objects).

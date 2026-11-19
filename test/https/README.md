# `https` against Node.js v25's own tests

The oracle is `nodejs/node@v25.0.0`, `test/parallel/test-https-*.js` — 62
files, listed in [`NODE_TESTS.txt`](NODE_TESTS.txt), with the key fixtures in
[`NODE_FIXTURES.txt`](NODE_FIXTURES.txt). Per-test run: [`RESULTS.md`](RESULTS.md).

**27 / 62 passing (43.5%)** on Windows (2026-11-18). Baseline before this
module existed: 0 / 62.

`https` is [`../../src/https/https.ts`](../../src/https/https.ts): `node:http`
over `node:tls`, with no natives of its own. `Agent` is http's pool with
`defaultPort` 443, `protocol: 'https:'`, `tls.connect` as `createConnection`
(SNI from `servername`, the `Host` header or `host`) and Node's long pool key;
`request`/`get` are http's `ClientRequest` with `_defaultAgent` set to the
https global agent; `createServer`/`Server` is http's server whose
`'connection'` sockets are wrapped in server-side `TLSSocket`s, the HTTP
connection attached on `'secureConnection'` (default ALPN `http/1.1`).

Deviations are `tls`'s (see [`../tls/README.md`](../tls/README.md)): no session
resumption (the `*-session-*`, `*-resume*` files), no PFX, no TLS 1.0/1.1, no
bundled CA roots. Other failures: `socketPath`/Unix sockets (as in `http`),
`internal/*` requires, and the http-side gaps `../http/README.md` lists.

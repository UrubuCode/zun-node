// `test/common/crypto.js`, the part of it this library's corpus reaches.
//
// Twelve files in `test/parallel/test-crypto*.js` require this helper module,
// and all but `test-crypto.js` itself take exactly one thing from it:
// `hasOpenSSL3`, which they branch on to pick between the OpenSSL 1.1 and the
// OpenSSL 3 error text and IV-length limits. Node 25 ships OpenSSL 3.5, so the
// answer is `true`, and `hasOpenSSL(major, minor, patch)` is the predicate
// behind it.
//
// The rest of Node's file — `testEncryptDecrypt`, `testSignVerify`, the
// PEM regular expressions, `modp2buf`, `opensslCli` — is asymmetric-key
// machinery for the `keygen`/`dh`/`rsa` corpora, which `src/crypto/crypto.ts`
// does not implement at all (see its header). Those files fail on the first
// `generateKeyPair`, so stubbing the helpers would change nothing; they are
// left out rather than written to be unreachable.
//
// `process.versions.openssl` is not a real OpenSSL version here (there is no
// OpenSSL in this build — see ../../Cargo.toml), so the version this reports
// is the one the primitives were written against: the behaviours the corpus
// selects on, not a claim about a linked library.

const __HARNESS_OPENSSL_VERSION: number[] = [3, 5, 0];

function __harnessHasOpenSSL(major?: any, minor?: any, patch?: any): boolean {
  const wantedMajor: number = major === undefined ? 0 : Number(major);
  const wantedMinor: number = minor === undefined ? 0 : Number(minor);
  const wantedPatch: number = patch === undefined ? 0 : Number(patch);
  const have: number =
    __HARNESS_OPENSSL_VERSION[0] * 1000000 +
    __HARNESS_OPENSSL_VERSION[1] * 1000 +
    __HARNESS_OPENSSL_VERSION[2];
  const want: number = wantedMajor * 1000000 + wantedMinor * 1000 + wantedPatch;
  return have >= want;
}

const __node_harness_crypto: any = {
  hasOpenSSL: __harnessHasOpenSSL,
  hasOpenSSL3: true,
  opensslCli: false,
};

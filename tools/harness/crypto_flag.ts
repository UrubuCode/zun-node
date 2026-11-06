// `common.hasCrypto`, flipped on for a bundle that actually carries
// `node:crypto`.
//
// `test/common/index.js` reports whether the build has crypto, and roughly
// forty files across the corpus open with
// `if (!common.hasCrypto) common.skip('missing crypto')`. The flag therefore
// has to track what the *bundle* contains, not what the library can do: a
// `path` or `events` bundle has no `src/crypto/crypto.ts` in it, and reporting
// `true` there would make those tests run against a module that is not
// present.
//
// `tools/harness/common.ts` declares it `false` and this file overrides it, in
// that order, because the harness is inlined after every module and before
// the test body — so the only place a later decision can be applied is here,
// a file `tools/bundle_node_test.sh` appends *after* the harness exactly when
// `src/crypto/crypto.ts` made it into the file list.

common.hasCrypto = true;

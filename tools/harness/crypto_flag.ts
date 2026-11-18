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

// `process.versions.openssl`, which a build with crypto reports and several
// corpus files probe (`/^1\.1\.0/.test(process.versions.openssl)`). There is
// no OpenSSL here; the version is the one `crypto_common.ts`' `hasOpenSSL`
// answers for, so the two never disagree.
if (process.versions.openssl === undefined) {
  (process.versions as any).openssl = "3.5.0";
}

// `fixtures.readKey(name, encoding)` and `fixtures.readSync(name, encoding)`,
// which `test/common/fixtures.js` implements with `fs.readFileSync`. A crypto
// bundle always runs with the extension loaded, so the `node:fs` native that
// `src/fs/fs.ts` reads files through is reachable here even when the bundle
// does not inline `node:fs` itself; `common.ts` cannot do this, because it is
// inlined into bundles that must compile without `--ext`.
import * as __cfFsNative from "node:fs";

function __cfReadFixture(file: string, encoding: any): any {
  const result: string = String(__cfFsNative.fsReadFile(file));
  if (result.charAt(0) !== "+") {
    const error: any = new Error("ENOENT: no such file or directory, open '" + file + "'");
    error.code = "ENOENT";
    throw error;
  }
  const bytes: Buffer = Buffer.from(result.slice(1), "base64");
  if (encoding === undefined || encoding === null) return bytes;
  return bytes.toString(String(encoding));
}

fixtures.readKey = function (name: any, encoding?: any): any {
  return __cfReadFixture(path.join(__fixturesDir(), "keys", String(name)), encoding);
};

fixtures.readSync = function (name: any, encoding?: any): any {
  const segments: any[] = Array.isArray(name) ? name : [name];
  return __cfReadFixture(__fixturesJoin(segments), encoding);
};

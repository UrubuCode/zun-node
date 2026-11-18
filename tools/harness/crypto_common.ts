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

// The asymmetric helpers, as `test/common/crypto.js` writes them. They call
// through `__node_crypto` (the module object, which is always in a bundle that
// includes this file) rather than the `crypto` name, for the prelude-namespace
// reason `src/crypto/crypto.ts` documents at its end.

// RFC 2412 E.2's 1024-bit prime.
const __harnessModp2: number[] = [
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xc9, 0x0f,
  0xda, 0xa2, 0x21, 0x68, 0xc2, 0x34, 0xc4, 0xc6, 0x62, 0x8b,
  0x80, 0xdc, 0x1c, 0xd1, 0x29, 0x02, 0x4e, 0x08, 0x8a, 0x67,
  0xcc, 0x74, 0x02, 0x0b, 0xbe, 0xa6, 0x3b, 0x13, 0x9b, 0x22,
  0x51, 0x4a, 0x08, 0x79, 0x8e, 0x34, 0x04, 0xdd, 0xef, 0x95,
  0x19, 0xb3, 0xcd, 0x3a, 0x43, 0x1b, 0x30, 0x2b, 0x0a, 0x6d,
  0xf2, 0x5f, 0x14, 0x37, 0x4f, 0xe1, 0x35, 0x6d, 0x6d, 0x51,
  0xc2, 0x45, 0xe4, 0x85, 0xb5, 0x76, 0x62, 0x5e, 0x7e, 0xc6,
  0xf4, 0x4c, 0x42, 0xe9, 0xa6, 0x37, 0xed, 0x6b, 0x0b, 0xff,
  0x5c, 0xb6, 0xf4, 0x06, 0xb7, 0xed, 0xee, 0x38, 0x6b, 0xfb,
  0x5a, 0x89, 0x9f, 0xa5, 0xae, 0x9f, 0x24, 0x11, 0x7c, 0x4b,
  0x1f, 0xe6, 0x49, 0x28, 0x66, 0x51, 0xec, 0xe6, 0x53, 0x81,
  0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];

function __harnessAssertApproximateSize(key: any, expectedSize: number): void {
  const length: number = Number(key.length);
  const unit: string = typeof key === "string" ? "chars" : "bytes";
  const min: number = Math.floor(0.9 * expectedSize);
  const max: number = Math.ceil(1.1 * expectedSize);
  if (length < min) {
    throw new Error("Key (" + length + " " + unit + ") is shorter than expected (" + min + " " + unit + ")");
  }
  if (length > max) {
    throw new Error("Key (" + length + " " + unit + ") is longer than expected (" + max + " " + unit + ")");
  }
}

function __harnessTestEncryptDecrypt(publicKey: any, privateKey: any): void {
  const message: string = "Hello Node.js world!";
  const plaintext: Buffer = Buffer.from(message, "utf8");
  const keys: any[] = [publicKey, privateKey];
  for (const key of keys) {
    const ciphertext: any = __node_crypto.publicEncrypt(key, plaintext);
    const received: Buffer = __node_crypto.privateDecrypt(privateKey, ciphertext);
    if (received.toString("utf8") !== message) {
      throw new Error("testEncryptDecrypt: round trip mismatch");
    }
  }
}

function __harnessTestSignVerify(publicKey: any, privateKey: any): void {
  const message: Buffer = Buffer.from("Hello Node.js world!");
  const signatures: any[] = [
    __node_crypto.sign("SHA256", message, privateKey),
    __node_crypto.createSign("SHA256").update(message).sign(privateKey),
  ];
  const keys: any[] = [publicKey, privateKey];
  for (const signature of signatures) {
    for (const key of keys) {
      if (!__node_crypto.verify("SHA256", message, key, signature)) {
        throw new Error("testSignVerify: verify failed");
      }
      if (!__node_crypto.createVerify("SHA256").update(message).verify(key, signature)) {
        throw new Error("testSignVerify: Verify failed");
      }
    }
  }
}

function __harnessPemRegExp(label: string, cipher?: any): RegExp {
  const head: string = "\\-\\-\\-\\-\\-BEGIN " + label + "\\-\\-\\-\\-\\-";
  const rfc1421: string = cipher === undefined || cipher === null
    ? ""
    : "\nProc-Type: 4,ENCRYPTED\nDEK-Info: " + String(cipher) + ",[^\n]+\n";
  const body: string = "([a-zA-Z0-9\\+/=]{64}\n)*[a-zA-Z0-9\\+/=]{1,64}";
  const end: string = "\\-\\-\\-\\-\\-END " + label + "\\-\\-\\-\\-\\-";
  return new RegExp("^" + head + rfc1421 + "\n" + body + "\n" + end + "\n$");
}

const __node_harness_crypto: any = {
  hasOpenSSL: __harnessHasOpenSSL,
  hasOpenSSL3: true,
  opensslCli: false,
  modp2buf: Buffer.from(__harnessModp2),
  assertApproximateSize: __harnessAssertApproximateSize,
  testEncryptDecrypt: __harnessTestEncryptDecrypt,
  testSignVerify: __harnessTestSignVerify,
  pkcs1PubExp: __harnessPemRegExp("RSA PUBLIC KEY"),
  pkcs1PrivExp: __harnessPemRegExp("RSA PRIVATE KEY"),
  pkcs1EncExp(cipher: any): RegExp {
    return __harnessPemRegExp("RSA PRIVATE KEY", cipher);
  },
  spkiExp: __harnessPemRegExp("PUBLIC KEY"),
  pkcs8Exp: __harnessPemRegExp("PRIVATE KEY"),
  pkcs8EncExp: __harnessPemRegExp("ENCRYPTED PRIVATE KEY"),
  sec1Exp: __harnessPemRegExp("EC PRIVATE KEY"),
  sec1EncExp(cipher: any): RegExp {
    return __harnessPemRegExp("EC PRIVATE KEY", cipher);
  },
};

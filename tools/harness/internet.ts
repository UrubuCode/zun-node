// `test/common/internet` — the host and server names Node's network tests use.
//
// This is a *harness* file, not a library module: it is Node's own
// `test/common/internet.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) in Zun TypeScript, inlined by `tools/bundle_node_test.sh` for a
// test that requires `../common/internet`. The `dns` corpus reaches it for one
// thing only — `addresses.DNS4_SERVER`, which `test-dns-setservers-type-check.js`
// uses as the *valid* value its invalid variants are built from — but the whole
// table is here because it is one table and splitting it would invite drift.
//
// Each entry is overridable through `NODE_TEST_<KEY>`, exactly as in Node, so a
// machine behind a resolver that answers differently can retarget the suite
// without editing it.

const __harnessInternetAddresses: any = {
  // A generic host that has registered common DNS records, supports both IPv4
  // and IPv6, and provides basic HTTP/HTTPS services.
  INET_HOST: "nodejs.org",
  INET4_HOST: "nodejs.org",
  INET6_HOST: "nodejs.org",
  // An accessible IPv4 / IPv6 IP, defaulting to Google Public DNS.
  INET4_IP: "8.8.8.8",
  INET6_IP: "2001:4860:4860::8888",
  // An invalid host that cannot be resolved (RFC 2606 §2).
  INVALID_HOST: "something.invalid",
  MX_HOST: "nodejs.org",
  // On some systems `.invalid` answers "server failure" rather than "no such
  // record"; this name guarantees the latter.
  NOT_FOUND: "come.on.fhqwhgads.test",
  SRV_HOST: "_caldav._tcp.google.com",
  PTR_HOST: "8.8.8.8.in-addr.arpa",
  NAPTR_HOST: "sip2sip.info",
  SOA_HOST: "nodejs.org",
  CAA_HOST: "google.com",
  CNAME_HOST: "blog.nodejs.org",
  NS_HOST: "nodejs.org",
  TLSA_HOST: "_443._tcp.fedoraproject.org",
  TXT_HOST: "nodejs.org",
  DNS4_SERVER: "8.8.8.8",
  DNS6_SERVER: "2001:4860:4860::8888",
};

for (const key of Object.keys(__harnessInternetAddresses)) {
  const override: any = process.env["NODE_TEST_" + key];
  if (override !== undefined && override !== null && override !== "") {
    __harnessInternetAddresses[key] = override;
  }
}

const __node_harness_internet: any = { addresses: __harnessInternetAddresses };

// `internal/test/binding` and `internal/errors` — the two internal surfaces the
// `dns` corpus opens under `--expose-internals`.
//
// This is a *harness* file, not a library module. Nine of the twenty-seven
// `test-dns*.js` files begin by replacing a method on
// `internalBinding('cares_wrap')` — `getaddrinfo`, `getnameinfo` or
// `ChannelWrap.prototype.queryA` — *before* requiring `dns`, so that they can
// drive the error paths (`ENOMEM`, `ENOENT`, `EPERM`) and the result shapes
// without a DNS server. That is only possible because `src/dns/dns.ts` is
// written against a binding object of the same shape as Node's; this file hands
// that object to `require('internal/test/binding')` and nothing else.
//
//   * `internalBinding('cares_wrap')` is `__dnsCares` itself, so a test's
//     replacement is seen by the module.
//   * `internalBinding('uv')` is the `UV_*` constant table, built by inverting
//     `util.getSystemErrorMap()` — which is already libuv's own errno table,
//     already selected for this platform (see `__UV_ERRNO_TABLE` in
//     `src/util/util.ts`). Restating the numbers here would be a second copy
//     that could disagree with the one `DNSException` reads back through
//     `util.getSystemErrorName`.
//   * `internal/errors` exposes `DNSException`, which `test-dns-memory-error.js`
//     constructs directly.
//
// Node's own `internal/test/binding.js` warns the moment it is loaded, and two
// files in the corpus assert that warning with `common.expectWarning`. The
// warning is emitted here for the same reason and with the same text; it is
// delivered on the next tick (as in Node), so a test that registers its
// expectation after the require still sees it.

const __harnessUvConstants: any = {};

// libuv's errno table, keyed by name. `util.getSystemErrorMap()` answers
// `errno -> [name, message]`, which is the same data read the other way round.
for (const __harnessUvEntry of util.getSystemErrorMap()) {
  __harnessUvConstants["UV_" + String(__harnessUvEntry[1][0])] = __harnessUvEntry[0];
}

const __node_internal_test_binding: any = {
  internalBinding(name: any): any {
    if (name === "cares_wrap") return __dnsCares;
    if (name === "uv") return __harnessUvConstants;
    throw new Error("internalBinding: " + String(name) + " is not served by the harness");
  },
  primordials: {},
};

const __node_internal_errors: any = {
  DNSException: DNSException,
  codes: {
    ERR_INVALID_ARG_TYPE: ERR_INVALID_ARG_TYPE,
    ERR_INVALID_ARG_VALUE: ERR_INVALID_ARG_VALUE,
    ERR_MISSING_ARGS: ERR_MISSING_ARGS,
    ERR_OUT_OF_RANGE: ERR_OUT_OF_RANGE,
  },
};

process.emitWarning(
  "These APIs are for internal testing only. Do not use them.",
  "internal/test/binding",
);

// The DEP0040 warning `node:punycode` emits when it is required.
//
// Node emits it from the top of `lib/punycode.js`, so it fires on the *first
// require* of the module and once per process — not on any particular call. The
// engine has no module system (https://github.com/UrubuCode/zun/issues/4), so
// "the module was required" is a fact only the bundler knows: it inlines this
// file exactly when the test body requires `punycode`, which is why the warning
// lives here instead of in `punycode.ts` (whose algorithms every bundle needs,
// because `src/url/url.ts` stands on them). See the CONDITIONAL_FILES note in
// `tools/bundle_node_test.sh`.
//
// Node skips the warning when the require comes from inside `node_modules`
// (`isInsideNodeModules(100, true)`); there is no module path here, so the
// warning is unconditional, which is the first-party case and the one
// `test-punycode.js` asserts with
// `common.expectWarning('DeprecationWarning', …, 'DEP0040')`.
process.emitWarning(
  "The `punycode` module is deprecated. Please use a userland alternative instead.",
  "DeprecationWarning",
  "DEP0040",
);

// `test/common/wpt` — the WPT `testharness.js` subset Node's own tests use.
//
// This is a *harness* file, not a library module: it is the `harness` object
// of Node's `test/common/wpt.js` (MIT, Copyright Joyent, Inc. and other Node
// contributors) in Zun TypeScript, inlined by `tools/bundle_node_test.sh` for a
// test that requires `../common/wpt`. Only the synchronous `harness` is here;
// the `WPTRunner` that drives the vendored WPT suites is not, since no corpus
// test requires it.

function __wptAssertEquals(actual: any, expected: any, message?: any): void {
  __node_assert.strictEqual(actual, expected, message);
}

function __wptAssertTrue(value: any, message?: any): void {
  __node_assert.strictEqual(value, true, message);
}

function __wptAssertFalse(value: any, message?: any): void {
  __node_assert.strictEqual(value, false, message);
}

function __wptAssertArrayEquals(actual: any, expected: any, message?: any): void {
  __node_assert.deepStrictEqual(actual, expected, message);
}

function __wptAssertThrows(code: any, func: any, message?: any): void {
  __node_assert.throws(func, function (err: any): boolean {
    return typeof err === "object" && err !== null && "name" in err &&
      String(err.name).startsWith(String(code.name));
  }, message);
}

function __wptAssertUnreached(message?: any): void {
  __node_assert.fail("Reached unreachable code: " + String(message));
}

function __wptTest(fn: any, description?: any): void {
  try {
    fn();
  } catch (err) {
    console.error("In " + String(description) + ":");
    throw err;
  }
}

const __node_harness_wpt: any = {
  harness: {
    assert_equals: __wptAssertEquals,
    assert_true: __wptAssertTrue,
    assert_false: __wptAssertFalse,
    assert_array_equals: __wptAssertArrayEquals,
    assert_throws: __wptAssertThrows,
    assert_unreached: __wptAssertUnreached,
    test: __wptTest,
  },
};

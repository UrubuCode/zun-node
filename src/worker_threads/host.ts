// node:worker_threads -- the one file that ties `Worker` to `child_process`.
//
// A `Worker` is a child Zun process (see "The Worker process" in
// worker_threads.ts), so starting one needs `child_process.spawn`, which needs
// the native extension. worker_threads.ts itself is inlined into bundles that
// run without one (the `MessageChannel` globals reach it from any corpus), so
// it cannot name `spawn` directly: a bundle without src/child_process would
// not compile. tools/bundle_node_test.sh appends this file -- and
// child_process with it -- only when the bundle has worker_threads *and* runs
// with the extension, the split src/process/native.ts documents.
//
// An object-literal method rather than a function value, because a method
// survives every path through an `any` while a bare function value does not
// (https://github.com/UrubuCode/zun/issues/17).

__wtInstallHost({
  spawn(file: any, args: any, options: any): any {
    return spawn(file, args, options);
  },
});

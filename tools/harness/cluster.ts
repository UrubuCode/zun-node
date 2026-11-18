// `cluster` for the `dgram` corpus.
//
// Node's `cluster` forks worker processes that share server handles through
// the primary. This platform has no `fork`, so the shim is the smallest
// surface the tests touch: the process is always the primary, and the first
// attempt to `fork()` is what the tests that need a real worker would do next,
// which is `common.skip` for a platform without the capability (the same exit
// Node's own tests take on Windows, where dgram clustering is unsupported).
// `_getServer` is the hook those tests replace; it exists so the replacement
// has something to land on.

const __node_cluster: any = {
  isPrimary: true,
  isMaster: true,
  isWorker: false,
  workers: {},
  worker: undefined,
  _getServer(self: any, options: any, callback: any): void {},
  fork(env?: any): any {
    common.skip("cluster.fork() is not supported: this platform has no process fork");
    return undefined;
  },
  disconnect(callback?: any): void {},
  on(event: any, listener: any): any {
    return this;
  },
};

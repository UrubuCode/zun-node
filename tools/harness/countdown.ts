// `test/common/countdown.js` — the counter Node's tests use to wait for N
// events before they close a server.
//
// Node's version keeps its state behind private fields and runs the callback
// through `common.mustCall`; here the callback is wrapped by the harness the
// same way, and the state is plain fields. `dec()` past zero throws, as the
// original's `assert` does.
class Countdown {
  limit: any = 0;
  remaining: any = 0;
  callback: any = undefined;

  constructor(limit: any, cb: any) {
    this.limit = Number(limit);
    this.remaining = Number(limit);
    this.callback = cb === undefined ? undefined : common.mustCall(cb);
  }

  dec(): number {
    if (Number(this.remaining) <= 0) {
      throw new Error("Countdown expired");
    }
    this.remaining = Number(this.remaining) - 1;
    if (Number(this.remaining) === 0 && this.callback !== undefined) {
      this.callback();
    }
    return Number(this.remaining);
  }
}

const __node_harness_countdown: any = Countdown;

// `node:readline/promises`' public `Interface` — the promise-returning
// `question`.
//
// This is `lib/readline/promises.js`' `Interface` (MIT, Copyright Joyent, Inc.
// and other Node contributors) over the `__RlInterface` base in ./readline.ts.
// See the header of ./callback.ts for why the two public `Interface` classes
// are two files.
class Interface extends __RlInterface {
  // Displays `query` and resolves with the answer. `options.signal` rejects
  // with an `AbortError` carrying the signal's reason as its cause.
  question(query?: any, options?: any): any {
    const self: any = this;
    const opts: any = options === undefined || options === null ? {} : options;
    return new Promise(function (resolve: any, reject: any): void {
      let cb: any = resolve;

      if (opts.signal) {
        __rlValidateAbortSignal(opts.signal, "options.signal");
        if (opts.signal.aborted) {
          __evCall(reject, [new AbortError(undefined, { cause: opts.signal.reason })]);
          return;
        }

        const onAbort: any = function (): void {
          self._questionCancel();
          __evCall(reject, [new AbortError(undefined, { cause: opts.signal.reason })]);
        };
        const disposable: any = __eventsAddAbortListener(opts.signal, onAbort);

        cb = function (answer: any): void {
          const dispose: any = disposable.dispose;
          if (__rlIsFn(dispose)) __evCall(dispose, []);
          __evCall(resolve, [answer]);
        };
      }

      self._questionReject = __rlStoreFn(reject);
      self._question(query, cb);
    });
  }
}

function __rlPromisesCreateInterface(
  input?: any,
  output?: any,
  completer?: any,
  terminal?: any,
): any {
  return new Interface(input, output, completer, terminal);
}

__node_readline_promises.Interface = Interface;
__node_readline_promises.createInterface = __rlPromisesCreateInterface;

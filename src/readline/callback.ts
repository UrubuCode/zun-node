// `node:readline`'s public `Interface` — the callback-style `question`.
//
// This is `lib/readline.js`' `Interface` (MIT, Copyright Joyent, Inc. and other
// Node contributors) over the `__RlInterface` base in ./readline.ts.
//
// It is a file of its own because `node:readline/promises` binds the *same*
// name, `Interface`, to a different class (./promises.ts), and two top-level
// declarations of one name are a compile error in a single Zun program. The
// name has to stay a top-level class rather than a module-object member,
// because `new <object>.Ctor()` does not reach the constructor in this engine
// (https://github.com/UrubuCode/zun/issues/18) and Node's own tests spell the
// constructor `new readline.Interface(...)`. No test requires both modules, so
// `tools/bundle_node_test.sh` inlines whichever of the two files the test's
// `require` asks for.
//
// `lib/readline.js` also installs `_ttyWriteDumb` when `process.env.TERM` is
// `'dumb'`; that path is below as `_ttyWrite`'s dumb branch, chosen per call
// rather than by rebinding the method (there is no prototype model to rebind
// through — zun#25).
class Interface extends __RlInterface {
  // Displays `query` by writing it to the output and calls `cb` with the
  // answer. `options` may carry an `AbortSignal`.
  question(query?: any, options?: any, cb?: any): any {
    const self: any = this;
    let callback: any = __rlIsFn(options) ? options : cb;
    let opts: any = options;
    if (opts === null || typeof opts !== "object") opts = {};

    if (opts.signal) {
      __rlValidateAbortSignal(opts.signal, "options.signal");
      if (opts.signal.aborted) return undefined;

      const onAbort: any = function (): void {
        self._questionCancel();
      };
      const disposable: any = __eventsAddAbortListener(opts.signal, onAbort);
      const originalCb: any = callback;
      if (__rlIsFn(originalCb)) {
        callback = function (answer: any): any {
          const dispose: any = disposable.dispose;
          if (__rlIsFn(dispose)) __evCall(dispose, []);
          return __evCall(originalCb, [answer]);
        };
      } else {
        callback = disposable.dispose;
      }
    }

    if (__rlIsFn(callback)) this._question(query, callback);
    return undefined;
  }

  // `lib/readline.js`' `_ttyWriteDumb`, reached only under `TERM=dumb`. The
  // base class' `_ttyWrite` is the full line editor; this override picks
  // between the two per call, because Node picks between them by rebinding the
  // method in the constructor and there is no prototype to rebind through.
  _ttyWrite(s: any, key?: any): void {
    if (process.env.TERM !== "dumb") {
      super._ttyWrite(s, key);
      return;
    }
    const k: any = key ? key : {};
    if (k.name === "escape") return;

    if (this._sawReturnAt && k.name !== "enter") this._sawReturnAt = 0;

    if (k.ctrl) {
      if (k.name === "c") {
        if (Number(this.listenerCount("SIGINT")) > 0) {
          this.emit("SIGINT");
        } else {
          // This readline instance is finished.
          this.close();
        }
        return;
      } else if (k.name === "d") {
        this.close();
        return;
      }
    }

    if (k.name === "return") {
      // Carriage return, i.e. `\r`.
      this._sawReturnAt = Number(Date.now());
      this._line();
    } else if (k.name === "enter") {
      // Only a line when the key interval exceeded crlfDelay.
      if (
        this._sawReturnAt === 0 ||
        Number(Date.now()) - this._sawReturnAt > this.crlfDelay
      ) {
        this._line();
      }
      this._sawReturnAt = 0;
    } else if (typeof s === "string" && s) {
      this.line = String(this.line) + s;
      this.cursor = this.cursor + Number(s.length);
      this._writeToOutput(s);
    }
  }
}

function __rlCreateInterface(input?: any, output?: any, completer?: any, terminal?: any): any {
  return new Interface(input, output, completer, terminal);
}

__node_readline.Interface = Interface;
__node_readline.createInterface = __rlCreateInterface;

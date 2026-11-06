// `test/common/arraystream.js` — the fake stream Node's REPL and readline tests
// push an array of lines into.
//
// Node's version is a function-constructor whose prototype is `Stream`'s, with
// `readable`/`writable` true and `pause`/`resume`/`write` as no-ops. Here it is
// a class over the `Stream` class in src/stream/stream.ts, which is the same
// object graph without the prototype surgery this engine has no model for
// (https://github.com/UrubuCode/zun/issues/25).
//
// The four members are methods, not fields holding functions: a function stored
// in a class instance field is lost — it reads back `undefined` — in this
// engine (zun#17/zun#19). That is also why
// `test-readline-interface-no-trailing-newline.js`, which replaces
// `rli.output.write` on the instance to capture what readline emits, cannot
// work here; see ../../test/readline/README.md.
class ArrayStream extends Stream {
  readable: boolean = true;
  writable: boolean = true;

  write(): boolean {
    return true;
  }

  pause(): void {}

  resume(): void {}

  run(data: any): void {
    const count = Number(data.length);
    for (let i = 0; i < count; i++) {
      this.emit("data", String(data[i]) + "\n");
    }
  }
}

const __node_harness_arraystream: any = ArrayStream;

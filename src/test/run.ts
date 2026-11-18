// `node:test`'s `run()` -- after `lib/internal/test_runner/runner.js`.
//
// Inlined (by tools/bundle_node_test.sh) only into a bundle that names `run`
// next to `node:test`, because it stands on `child_process` and `fs`.
//
// Each test file runs in a child process, `process.execPath <file>` with
// `NODE_TEST_CONTEXT=child-v8`, exactly as Node's process isolation does. In
// the child, src/test/test.ts then reports through its child reporter: one
// JSON event per stdout line behind `__NT_CHILD_PREFIX`, standing in for
// Node's v8-serialized stream. The parent parses those lines back into
// `{ type, data }` events, passes the child's other output through as
// `test:stdout`/`test:stderr`, adds the file-level test Node reports when a
// file fails outside any test (or reports no test at all), and emits the
// aggregated summary.
//
// The returned `TestsStream` is an EventEmitter (`stream.on('test:pass')`),
// an async iterable of events, and has `compose(reporter)` and `pipe(dest)`.

class TestsStream extends EventEmitter {
  _buffer: any;
  _waiters: any;
  _ended: boolean;
  _piped: any;
  constructor() {
    super();
    this._buffer = [];
    this._waiters = [];
    this._ended = false;
    this._piped = [];
  }
  _push(type: string, data: any): void {
    const event: any = { type: type, data: data };
    this.emit(type, data);
    this.emit("data", event);
    if (Number(this._waiters.length) > 0) {
      const w: any = this._waiters.shift();
      w({ value: event, done: false });
    } else {
      this._buffer.push(event);
    }
  }
  _end(): void {
    if (this._ended) return;
    this._ended = true;
    while (Number(this._waiters.length) > 0) {
      const w: any = this._waiters.shift();
      w({ value: undefined, done: true });
    }
    this.emit("end");
    this.emit("close");
  }
  next(): any {
    if (Number(this._buffer.length) > 0) {
      return Promise.resolve({ value: this._buffer.shift(), done: false });
    }
    if (this._ended) return Promise.resolve({ value: undefined, done: true });
    const self: any = this;
    return new Promise((resolve: any) => {
      self._waiters.push(resolve);
    });
  }
  compose(reporter: any): any {
    return __ntComposeReporter(this, reporter);
  }
  pipe(destination: any): any {
    const out: any = __ntComposeReporter(this, __node_test_reporters.spec);
    return out.pipe(destination);
  }
}

(TestsStream.prototype as any)[Symbol.asyncIterator] = function (this: any): any {
  const self: any = this;
  return {
    next(): any {
      return self.next();
    },
    return(): any {
      return Promise.resolve({ value: undefined, done: true });
    },
  };
};

// `stream.compose(reporter)`: a readable of the reporter's output chunks,
// which can be piped, iterated, or listened to with 'data'.
function __ntComposeReporter(stream: any, reporter: any): any {
  const out: any = new EventEmitter();
  out._chunks = [];
  out._ended = false;
  out._dest = [];
  const deliver = (chunk: any): void => {
    out._chunks.push(chunk);
    out.emit("data", chunk);
    for (const d of out._dest) d.write(chunk);
  };
  const finish = (): void => {
    out._ended = true;
    out.emit("end");
    out.emit("close");
  };
  out.pipe = function (dest: any): any {
    for (const c of out._chunks) dest.write(c);
    out._dest.push(dest);
    return dest;
  };
  out.toArray = function (): any {
    return new Promise((resolve: any) => {
      if (out._ended) resolve(out._chunks.slice(0));
      else out.on("end", () => { resolve(out._chunks.slice(0)); });
    });
  };
  out[Symbol.asyncIterator] = async function* (): any {
    let i = 0;
    while (true) {
      while (i < Number(out._chunks.length)) {
        yield out._chunks[i];
        i++;
      }
      if (out._ended) return;
      await new Promise((resolve: any) => {
        const onAny = (): void => {
          out.removeListener("data", onAny);
          out.removeListener("end", onAny);
          resolve(undefined);
        };
        out.on("data", onAny);
        out.on("end", onAny);
      });
    }
  };
  (async (): Promise<any> => {
    try {
      let source: any = stream;
      if (typeof reporter === "string") {
        const named: any = __node_test_reporters[reporter];
        source = named(stream);
      } else if (__ntIsFn(reporter)) {
        source = __ntCall(reporter, undefined, [stream]);
      } else if (reporter !== null && reporter !== undefined && __ntIsFn(reporter._transform)) {
        // A Transform-shaped reporter: feed it events, collect what it pushes.
        for await (const event of stream) {
          await new Promise((resolve: any) => {
            reporter._transform(event, "utf8", (err: any, chunk: any) => {
              if (chunk !== undefined && chunk !== null) deliver(chunk);
              resolve(undefined);
            });
          });
        }
        if (__ntIsFn(reporter._flush)) {
          await new Promise((resolve: any) => {
            reporter._flush((err: any, chunk: any) => {
              if (chunk !== undefined && chunk !== null) deliver(chunk);
              resolve(undefined);
            });
          });
        }
        finish();
        return;
      }
      for await (const chunk of source) deliver(chunk);
    } catch (err) {
      out.emit("error", err);
    }
    finish();
  })();
  return out;
}

// ---------------------------------------------------------------------------
// File discovery (Node's default `--test` patterns)
// ---------------------------------------------------------------------------

function __ntIsDefaultTestFile(name: string, inTestDir: boolean): boolean {
  if (!/\.(c|m)?js$/.test(name)) return false;
  if (inTestDir) return true;
  return /^(.*[.\-_])?test\.(c|m)?js$/.test(name) || /^test-.*\.(c|m)?js$/.test(name);
}

function __ntDiscover(dir: string, inTestDir: boolean, out: string[]): void {
  let entries: any[] = [];
  try {
    entries = __node_fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  entries.sort();
  for (const entry of entries) {
    const name = String(entry);
    if (name === "node_modules" || name.charAt(0) === ".") continue;
    const full = __node_path.join(dir, name);
    let st: any;
    try {
      st = __node_fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (st.isDirectory()) {
      __ntDiscover(full, inTestDir || name === "test", out);
    } else if (__ntIsDefaultTestFile(name, inTestDir)) {
      out.push(full);
    }
  }
}

// ---------------------------------------------------------------------------
// run()
// ---------------------------------------------------------------------------

function __ntRunValidate(options: any): any {
  const opts: any = options === undefined || options === null ? {} : options;
  __ntValidateObject(opts, "options");
  const files: any = opts.files;
  if (files !== undefined) {
    if (!Array.isArray(files)) throw new ERR_INVALID_ARG_TYPE("options.files", "Array", files);
    for (let i = 0; i < Number(files.length); i++) {
      if (typeof files[i] !== "string") {
        throw new ERR_INVALID_ARG_TYPE("options.files[" + String(i) + "]", "string", files[i]);
      }
    }
  }
  const concurrency: any = opts.concurrency;
  if (concurrency !== undefined && concurrency !== null && typeof concurrency !== "boolean") {
    __ntValidateUint32(concurrency, "options.concurrency", true);
  }
  const timeout: any = opts.timeout;
  if (timeout !== undefined && timeout !== null && timeout !== Infinity) {
    __ntValidateNumber(timeout, "options.timeout", 0, __NT_TIMEOUT_MAX);
  }
  if (opts.only !== undefined && typeof opts.only !== "boolean") {
    throw new ERR_INVALID_ARG_TYPE("options.only", "boolean", opts.only);
  }
  if (opts.setup !== undefined && !__ntIsFn(opts.setup)) {
    throw new ERR_INVALID_ARG_TYPE("options.setup", "function", opts.setup);
  }
  if (opts.isolation !== undefined && opts.isolation !== "process" && opts.isolation !== "none") {
    throw new ERR_INVALID_ARG_VALUE("options.isolation", opts.isolation, "must be 'process' or 'none'");
  }
  const patterns: any = opts.testNamePatterns;
  if (patterns !== undefined && patterns !== null && typeof patterns !== "string" && !(patterns instanceof RegExp) && !Array.isArray(patterns)) {
    throw new ERR_INVALID_ARG_TYPE("options.testNamePatterns", ["string", "RegExp", "Array"], patterns);
  }
  return opts;
}

function __ntPatternArgs(name: string, value: any): string[] {
  const out: string[] = [];
  if (value === undefined || value === null) return out;
  const list: any[] = Array.isArray(value) ? value : [value];
  for (const p of list) {
    out.push(name + "=" + (p instanceof RegExp ? String(p) : String(p)));
  }
  return out;
}

function __ntRunFile(stream: any, file: string, opts: any, totals: any): any {
  return new Promise((resolve: any) => {
    const args: string[] = [];
    if (opts.only === true) args.push("--test-only");
    for (const a of __ntPatternArgs("--test-name-pattern", opts.testNamePatterns)) args.push(a);
    for (const a of __ntPatternArgs("--test-skip-pattern", opts.testSkipPatterns)) args.push(a);
    if (Array.isArray(opts.execArgv)) for (const a of opts.execArgv) args.push(String(a));
    args.push(file);
    if (Array.isArray(opts.argv)) for (const a of opts.argv) args.push(String(a));
    const env: any = Object.assign({}, opts.env === undefined ? process.env : opts.env, { NODE_TEST_CONTEXT: "child-v8" });
    let child: any;
    const state: any = { reported: 0, failedTop: false, out: "", err: "", done: false, timer: null };
    const fileTestName = file;
    const absolute = __node_path.resolve(file);
    const handleEvent = (event: any): void => {
      const type: string = String(event.type);
      const data: any = event.data;
      if (data !== null && data !== undefined && data.details !== undefined && data.details !== null && data.details.error !== undefined) {
        data.details.error = __ntDeserializeError(data.details.error);
      }
      const nesting = data !== null && data !== undefined ? Number(data.nesting) : 0;
      if (type === "test:summary" || type === "test:complete") {
        if (type === "test:complete") stream._push(type, data);
        return;
      }
      if (nesting === 0 && type === "test:diagnostic" && /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \S+$/.test(String(data.message))) {
        return;
      }
      if (nesting === 0 && type === "test:plan") return;
      if (type === "test:pass" || type === "test:fail") {
        state.reported = Number(state.reported) + 1;
        if (nesting === 0) {
          totals.topLevel = Number(totals.topLevel) + 1;
          data.testNumber = totals.topLevel;
          if (type === "test:fail") state.failedTop = true;
        }
        const dtype: any = data.details !== undefined && data.details !== null ? data.details.type : undefined;
        if (dtype === "suite") {
          totals.suites = Number(totals.suites) + 1;
        } else {
          const ftype: any = data.details !== undefined && data.details !== null && data.details.error !== undefined && data.details.error !== null
            ? data.details.error.failureType : undefined;
          if (data.skip !== undefined) totals.skipped = Number(totals.skipped) + 1;
          else if (data.todo !== undefined) totals.todo = Number(totals.todo) + 1;
          else if (ftype === __NT_kTestTimeoutFailure || ftype === __NT_kCancelledByParent) totals.cancelled = Number(totals.cancelled) + 1;
          else if (type === "test:fail") totals.failed = Number(totals.failed) + 1;
          else totals.passed = Number(totals.passed) + 1;
          totals.tests = Number(totals.tests) + 1;
        }
      }
      if (data !== null && data !== undefined && data.file === undefined) data.file = absolute;
      stream._push(type, data);
    };
    const flushOut = (all: boolean): void => {
      let text: string = state.out;
      let rest = "";
      if (!all) {
        const nl = text.lastIndexOf("\n");
        if (nl === -1) return;
        rest = text.slice(nl + 1);
        text = text.slice(0, nl + 1);
      }
      state.out = rest;
      if (text === "") return;
      let plain = "";
      for (const line of text.split("\n")) {
        const at = line.indexOf(__NT_CHILD_PREFIX);
        if (at !== -1) {
          if (at > 0) plain = plain + line.slice(0, at);
          let parsed: any = null;
          try {
            parsed = JSON.parse(line.slice(at + __NT_CHILD_PREFIX.length));
          } catch (e) {
            parsed = null;
          }
          if (plain !== "") {
            stream._push("test:stdout", { file: absolute, message: plain });
            plain = "";
          }
          if (parsed !== null) handleEvent(parsed);
        } else if (line !== "") {
          plain = plain + line + "\n";
        }
      }
      if (plain !== "") stream._push("test:stdout", { file: absolute, message: plain });
    };
    const finishFile = (code: any, signal: any, spawnError: any): void => {
      if (state.done) return;
      state.done = true;
      if (state.timer !== null) __timerRealClearTimeout(state.timer);
      flushOut(true);
      if (state.err !== "") {
        stream._push("test:stderr", { file: absolute, message: state.err });
        state.err = "";
      }
      const failedOutside = spawnError !== null || (code !== 0 && code !== null && !state.failedTop) || (signal !== null && signal !== undefined);
      if (Number(state.reported) === 0 || failedOutside) {
        let error: any = null;
        if (spawnError !== null) {
          error = new ERR_TEST_FAILURE(spawnError, __NT_kTestCodeFailure);
        } else if (state.timedOut) {
          error = new ERR_TEST_FAILURE("test timed out after " + String(opts.timeout) + "ms", __NT_kTestTimeoutFailure);
        } else if (failedOutside) {
          const e: any = new Error("test failed");
          e.exitCode = code;
          e.signal = signal === undefined ? null : signal;
          error = new ERR_TEST_FAILURE(e, __NT_kTestCodeFailure);
          error.exitCode = code;
          error.signal = signal === undefined ? null : signal;
        }
        totals.topLevel = Number(totals.topLevel) + 1;
        const details: any = { passed: error === null, duration_ms: 0, type: "test" };
        if (error !== null) details.error = error;
        const data: any = {
          name: fileTestName, nesting: 0, testNumber: totals.topLevel, details: details,
          file: absolute, line: 1, column: 1,
        };
        stream._push("test:start", { name: fileTestName, nesting: 0, file: absolute, line: 1, column: 1 });
        if (error === null) {
          totals.passed = Number(totals.passed) + 1;
        } else if (error.failureType === __NT_kTestTimeoutFailure) {
          totals.cancelled = Number(totals.cancelled) + 1;
        } else {
          totals.failed = Number(totals.failed) + 1;
        }
        totals.tests = Number(totals.tests) + 1;
        stream._push(error === null ? "test:pass" : "test:fail", data);
      }
      resolve(undefined);
    };
    try {
      child = __node_child_process.spawn(process.execPath, args, { env: env, cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finishFile(null, null, err);
      return;
    }
    if (child.stdout !== null && child.stdout !== undefined) {
      child.stdout.on("data", (chunk: any) => {
        state.out = state.out + String(chunk);
        flushOut(false);
      });
    }
    if (child.stderr !== null && child.stderr !== undefined) {
      child.stderr.on("data", (chunk: any) => {
        state.err = state.err + String(chunk);
      });
    }
    child.on("error", (err: any) => {
      finishFile(null, null, err);
    });
    child.on("close", (code: any, signal: any) => {
      finishFile(code, signal, null);
    });
    if (opts.timeout !== undefined && opts.timeout !== null && opts.timeout !== Infinity) {
      state.timer = __timerRealSetTimeout(() => {
        state.timedOut = true;
        try { child.kill(); } catch (e) {}
      }, opts.timeout);
    }
    if (opts.signal !== undefined && opts.signal !== null) {
      const signal: any = opts.signal;
      const onAbort = (): void => {
        try { child.kill(); } catch (e) {}
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
  });
}

function __ntDeserializeError(raw: any): any {
  if (raw === null || raw === undefined || typeof raw !== "object") return raw;
  if (raw.__primitive === true) return raw.value;
  const err: any = new Error(raw.message === undefined ? "" : String(raw.message));
  if (raw.name !== undefined) {
    try { err.name = raw.name; } catch (e) {}
  }
  if (raw.code !== undefined) err.code = raw.code;
  if (raw.failureType !== undefined) err.failureType = raw.failureType;
  if (raw.stack !== undefined) {
    try { err.stack = raw.stack; } catch (e) {}
  }
  if (raw.cause !== undefined) err.cause = __ntDeserializeError(raw.cause);
  if (raw.expected !== undefined) err.expected = raw.expected;
  if (raw.actual !== undefined) err.actual = raw.actual;
  if (raw.operator !== undefined) err.operator = raw.operator;
  return err;
}

function __ntRunMain(options?: any): any {
  const opts: any = __ntRunValidate(options);
  const stream: any = new TestsStream();
  let files: string[] = [];
  if (opts.files !== undefined) {
    for (const f of opts.files) files.push(String(f));
  } else {
    const cwd: string = opts.cwd === undefined ? String(process.cwd()) : String(opts.cwd);
    __ntDiscover(cwd, false, files);
  }
  const totals: any = __ntNewCounters();
  const start = __ntNow();
  (async (): Promise<any> => {
    await __ntTick();
    if (opts.setup !== undefined) {
      try {
        await __ntCall(opts.setup, undefined, [stream]);
      } catch (e) {}
    }
    const limit: number = opts.concurrency === true ? Infinity
      : typeof opts.concurrency === "number" ? Number(opts.concurrency) : 1;
    let index = 0;
    const runNext = async (): Promise<any> => {
      while (index < Number(files.length)) {
        const file = files[index];
        index++;
        if (opts.signal !== undefined && opts.signal !== null && opts.signal.aborted) continue;
        await __ntRunFile(stream, file, opts, totals);
      }
    };
    const workers: any[] = [];
    const n = limit === Infinity ? Number(files.length) : Math.max(1, Math.min(limit, Number(files.length)));
    for (let i = 0; i < n; i++) workers.push(runNext());
    await Promise.all(workers);
    const duration = __ntNow() - start;
    stream._push("test:plan", { nesting: 0, count: totals.topLevel });
    const lines: any[] = [
      ["tests", totals.tests], ["suites", totals.suites], ["pass", totals.passed],
      ["fail", totals.failed], ["cancelled", totals.cancelled], ["skipped", totals.skipped],
      ["todo", totals.todo], ["duration_ms", Math.round(duration * 1000) / 1000],
    ];
    for (const pair of lines) {
      stream._push("test:diagnostic", { nesting: 0, message: String(pair[0]) + " " + String(pair[1]), level: "info" });
    }
    const success = Number(totals.failed) === 0 && Number(totals.cancelled) === 0;
    stream._push("test:summary", {
      success: success,
      counts: {
        tests: totals.tests, suites: totals.suites, passed: totals.passed, failed: totals.failed,
        cancelled: totals.cancelled, skipped: totals.skipped, todo: totals.todo, topLevel: totals.topLevel,
      },
      duration_ms: duration,
      file: undefined,
    });
    stream._end();
  })();
  return stream;
}

__ntRunImpl.run = __ntRunMain;

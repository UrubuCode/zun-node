# node:stream — Node.js compatibility tests

The compatibility bar for `stream` is **Node.js 25's own test suite**, not tests
we write. `stream` is **not finished** until it passes 100% of Node's
`test-stream-*`, `test-stream2-*`, `test-stream3-*`, `test-streams-*` and
`test-readable-*` files.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module —
**204 files** in `test/parallel`, across five prefixes:

| prefix | files | what it covers |
|---|---|---|
| `test-stream-` | 169 | the whole modern surface: Readable, Writable, Duplex, Transform, PassThrough, `pipe`, `pipeline`, `finished`, `destroy`, the operators |
| `test-stream2-` | 25 | the "streams2" rewrite, still shipped under its old names |
| `test-stream3-` | 4 | `cork`/`uncork` and `pause`-then-`read` |
| `test-streams-` | 1 | the module object itself |
| `test-readable-` | 5 | `Readable.from` and the async iterator |

Five more files that match those prefixes live outside `test/parallel`
(`test/pummel`, `test/sequential`, `test/pseudo-tty`, `test/known_issues`) and
are therefore not part of this corpus, which is `test/parallel` for every
module here. Each file is fetched verbatim from `nodejs/node` at tag
`v25.0.0`; nothing is vendored.

## How they run

```sh
cargo build -p zun_cli                 # the `zun` binary
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --module stream
```

A **`zun-ts`** module: no `--ext`. Each test is bundled by
`tools/bundle_node_test.sh` and run as `zun run <bundle.ts>`.
`src/stream/stream.ts` is in the bundler's `CONDITIONAL_FILES` together with
`src/buffer/buffer.ts` (which it reads `ERR_UNKNOWN_ENCODING` and
`__bufNormalizeEncoding` out of) and `src/string_decoder/string_decoder.ts`
(for `setEncoding`) — exactly the `require` set `lib/internal/streams/readable.js`
has. It is conditional rather than always inlined for the same reason `buffer`
is: a `path` or `events` bundle has no business carrying 5 000 lines it never
mentions.

`stream` is the first module with **six canonical bindings** in the bundler
(`Stream`, `Readable`, `Writable`, `Duplex`, `Transform`, `PassThrough`) where
`events` has one and `buffer` has one, so the module table's third column is a
comma-separated list now. Three bundler rules came with it, all of them
engine workarounds and all of them generic over that column:

* **`stream.Readable` → `Readable`.** `new <object>.Ctor()` compiles but
  answers `undefined is not a function` at run time
  ([zun#18](https://github.com/UrubuCode/zun/issues/18)), and 54 of the 204
  files keep the module object in a local and construct through it. The two
  spellings denote the same class, so a member read of a canonical binding
  through the local alias is rewritten to the binding. The rule is skipped when
  the alias *is* the canonical name, which is what keeps `path.join` intact.
* **`const { Readable: R } = require('stream')` → `R` becomes `Readable`.** A
  class base must be the original class's own identifier
  ([zun#21](https://github.com/UrubuCode/zun/issues/21)), so `class T extends R`
  is rejected outright; four of the `test-stream2-*` files open that way.
* **`const EE = require('events').EventEmitter;` → `EE` becomes
  `EventEmitter`.** The same alias, in the member spelling.

The second and third rules are why `events` went from 6/35 to 12/35 with this
work: six of its files were blocked on nothing but the renamed alias.

## Which Node implementation this follows

`lib/internal/streams/*.js` at v25.0.0, instruction for instruction:
`readable.js`, `writable.js`, `duplex.js`, `transform.js`, `passthrough.js`,
`legacy.js`, `destroy.js`, `end-of-stream.js`, `pipeline.js`, `operators.js`,
`from.js`, `add-abort-signal.js`, `duplexpair.js`, `state.js`, `utils.js`, plus
`lib/stream.js` and `lib/stream/promises.js`. The reason is not deference: the
observable contract of a Node stream *is* that code. Which of `'end'`,
`'finish'`, `'close'`, `'error'`, `'drain'`, `'readable'` and `'prefinish'`
fires, and in which `process.nextTick` turn, is pinned by this corpus and is
not derivable from any general rule — so `needFinish`, `finishMaybe`,
`onwrite`'s four-way sync branch, `emitReadable`/`maybeReadMore`,
`endReadableNT`'s autoDestroy handshake and `eos`'s six-listener walk are all
transcribed rather than re-derived.

Node 25 packs both states into bit fields behind a `kState` symbol. The fields
are **plain properties** here, because the corpus reads
`_readableState.needReadable`, `_writableState.pendingcb`,
`_writableState.bufferedRequestCount`, `_readableState.awaitDrainWriters` and
twenty more directly off the state object — the bit packing is an
optimization, not part of the contract.

## Verification: two differential runs against Node

Because so much of the corpus is blocked before it reaches a single assertion
(below), the module is verified the way `os`, `string_decoder` and `url` are —
by running the same program under `node` and under `zun` and diffing the
transcript. Two drivers, both printing every event in the order it fires:

1. **`diff1`** — 64 lines over 20 scenarios: Readable event order for a
   synchronous source, paused-mode `read()`, Writable `write`/`end`/`finish`/
   `close` with `needDrain`, `cork`/`uncork` with `_writev`, Transform
   ordering with a `flush`, `pipe` with its `'pipe'`/`'unpipe'` pair,
   `ERR_STREAM_WRITE_AFTER_END` / `ERR_STREAM_PUSH_AFTER_EOF` /
   `ERR_STREAM_DESTROYED`, `destroy(err)`'s error-then-close order,
   `finished()`, every state getter and default high water mark,
   `setEncoding`, objectMode, `unshift`, PassThrough as a pipe target, a
   Duplex driving both sides, all eleven operators, async iteration, the
   `pipeline` callback form, `duplexPair`, `Duplex.from` and `addAbortSignal`:
   **zero divergences**.
2. **`diff2`** — 53 lines over 26 scenarios: pipe backpressure, an error out of
   `_write` / `_transform` / `_final` / `_read`, `_read`/`_write`/`_transform`
   not implemented, `emitClose: false`, `autoDestroy: false`,
   `allowHalfOpen: false`, `destroy()` with a write in flight, `end()` twice,
   `cork` without `_writev`, a Transform with `readableHighWaterMark: 0`,
   objectMode writes of `0`/`false`/an object, `write(null)` and `write(false)`
   in byte mode, `read(n)` slicing, `read(n)` with an encoding, `pause`/
   `resume`/`isPaused`, `unpipe`, `Readable.from` over a sync and an async
   generator, `compose`, `finished()` on an already-destroyed stream, and
   `pipeline` with a failing stage: **one divergence**, and it is an
   interleaving between two *independent* streams — a Writable's `'finish'`
   lands one `nextTick` turn earlier here than in Node. The order of events
   *within* each stream is identical in every scenario.

Three real bugs in this module came out of those two runs rather than out of the
corpus, which is why they are here: `'finish'` was a whole turn late because
`onwrite`'s `needTick` compared the callback against `null` where Node compares
it against its module-level `nop` (so an absent callback looked present); the
parked Transform write callback was being dropped, because it was living in a
class field; and `_write()`-not-implemented was being reported through
`'error'` where Node throws it out of `write()`.

## The two shapes the engine forces

Both are described at the top of `src/stream/stream.ts`; in short:

1. **The states are plain objects, not classes.** A function assigned to a
   class **field** stops being callable (a new engine bug, below), and
   `WritableState.onwrite`, the eight option hooks and the parked Transform
   callback are all functions that have to be stored. A plain object property
   keeps the callable *and* threads a receiver through `fn.call(stream, …)`,
   which is what makes `new Readable({ read() { this.push(…) } })` work.
2. **The eight hooks are accessor pairs, not methods.** Node resolves
   `_read`/`_write`/`_writev`/`_final`/`_destroy`/`_construct`/`_transform`/
   `_flush` through the prototype chain with three layers of precedence: an own
   property (`this._read = options.read`, and a test writing `r._read = fn`),
   then a subclass prototype method, then the base default. A class member can
   be a method *or* an accessor pair, not both, and 51 of the 204 files write a
   hook onto an instance while 26 subclass — so the hooks are `get`/`set`
   pairs over `state.fns`, a subclass method shadows them, and when neither
   exists the dynamic call lands on the accessor and the engine answers
   `TypeError: _read is not a function`. That is the "absent" signal
   `__sHookMissing` recognises, and the base defaults live in the `__sHook*`
   dispatchers keyed on the class hierarchy. There is no way to ask the
   question without making the call: a class method cannot be read as a value
   ([zun#19](https://github.com/UrubuCode/zun/issues/19)) and a class prototype
   carries no methods to reflect over
   ([zun#51](https://github.com/UrubuCode/zun/issues/51)).

## The one deliberate deviation: byte-mode strings stay strings

Node converts a pushed or written **string** to a `Buffer` in non-object mode.
That is not expressible here and would not help if it were:

* `Buffer.from(chunk)` does not compile when `chunk` is an `any`
  ([zun#58](https://github.com/UrubuCode/zun/issues/58)), which every chunk in
  this module is;
* a byte view read back through an `any` has no `length`, no index and no
  `toString` ([zun#38](https://github.com/UrubuCode/zun/issues/38)), so the
  Buffer would be unreachable to the test that received it;
* the GC does not trace a view's backing store
  ([zun#55](https://github.com/UrubuCode/zun/issues/55)), so it would not be
  safe either.

So a string chunk stays a string, and the **accounting still uses Node's
numbers**: `__sChunkLen` charges a string its UTF-8 byte length, which is what
`Buffer.byteLength` would have charged, so `highWaterMark`, `readableLength`,
`writableLength` and the `drain` threshold all agree with Node. A chunk that
arrives *as* a Buffer or `Uint8Array` is passed through untouched and measured
through the typed `Buffer` lane, which does work. The visible cost is
`Buffer.isBuffer(chunk)` answering `false` for a chunk the test pushed as a
string, and `read(n)` slicing by code unit rather than by byte for a
multi-byte string. The deviation lives in one function.

## What is absent, and why

* **`Readable.toWeb`/`fromWeb`, `Writable.toWeb`/`fromWeb`,
  `Duplex.toWeb`/`fromWeb`, `stream/web`, `stream/consumers.arrayBuffer`/
  `blob`.** The engine has no `ReadableStream`/`WritableStream`/
  `TransformStream` prelude global (checked against
  `crates/zun_prelude/builtin/`), so these throw rather than half-working —
  the same choice `tools/harness/common.ts` makes for `vm`. `stream/web`
  exists as a module object with every member absent, which is the honest
  report.
* **`instanceof Writable` for a Duplex.** Node installs a
  `Symbol.hasInstance` on `Writable`, and a class computed member key must be
  the literal `Symbol.<wellKnown>` spelling
  ([zun#31](https://github.com/UrubuCode/zun/issues/31)) — `hasInstance` is
  not honoured by `instanceof` here in any case. `Duplex extends Readable` and
  the writable surface is spelled a second time on `Duplex`, with every line of
  behaviour in the shared free functions, because there is no prototype surgery
  to copy `Writable.prototype`'s keys with.
* **`Readable.wrap` as a static.** A class may not carry a static and an
  instance method of one name ([zun#20](https://github.com/UrubuCode/zun/issues/20)),
  and the instance `wrap` is the one the corpus calls.
* **`Readable.ReadableState` / `Writable.WritableState`.** The states are not
  constructors here.

## Per-test blockers

The per-test breakdown, with the first line of each failing run, is in
[`RESULTS.md`](RESULTS.md), regenerated by the tracker. Grouped by root cause:

| # | Blocker | Where |
|---|---|---|
| 1 | **A derived class cannot introduce an instance field** — `class MyReadable extends Readable { constructor() { super(); this.n = 0; } }` is `no field or setter 'n' on this type`. Field inference from `this.x = …` in a constructor is gated on the class having **no base** (`crates/zun_syntax/src/oxc.rs`, `if base.is_none()`). **New engine bug.** | 10 files subclass a stream and assign to a new field in the constructor |
| 2 | **A constructor's declared parameters are all required** — `class MyWritable extends Writable { constructor(options) {…} }` + `new MyWritable()` is `expects 1 to 1 argument(s), found 0`, although [zun#61](https://github.com/UrubuCode/zun/issues/61) records that a *function* accepts too few. **New engine bug.** | 11 files give the subclass constructor a declared parameter and then construct with none |
| 3 | **`setTimeout`/`setImmediate` reject a dynamic callback** ([zun#29](https://github.com/UrubuCode/zun/issues/29)) | every test that defers with a closure |
| 4 | **A `number` cannot be a Buffer size or fill byte, and `Buffer.from` rejects an `any`** ([zun#58](https://github.com/UrubuCode/zun/issues/58)) | the tests that build their own payloads |
| 5 | **`this` inside a listener is `undefined`** ([zun#1](https://github.com/UrubuCode/zun/issues/1)) — `stream.on('readable', function() { this.read(); })` | the `this.read()` idiom |
| 6 | **No function-constructor model** ([zun#25](https://github.com/UrubuCode/zun/issues/25)) — `Readable.call(this)`, `util.inherits(Fn, Readable)`, `Object.setPrototypeOf(Fn.prototype, …)` | the `test-stream2-*` and legacy files |
| 7 | **A harness module that does not exist** — the largest single group, 21 files — `fs`, `http`, `http2`, `net`, `readline`, `async_hooks`, `child_process`, `timers/promises`, `internal/test/binding`, `internal/js_stream_socket`, `../common/tmpdir` | reported by the bundler as an unresolved `require` |
| 8 | **A top-level class name colliding with a canonical binding** — `class Readable extends stream.Readable` becomes `class Readable extends Readable` | `test-stream-events-prepend.js`, `test-stream-pipe-event.js` |
| 9 | **`Object.hasOwn` answers `false` for a property `getOwnPropertyNames` lists.** **New engine bug** (adjacent to [zun#5](https://github.com/UrubuCode/zun/issues/5) and [zun#51](https://github.com/UrubuCode/zun/issues/51)) | `test-stream-readable-ended.js`, `test-stream-writable-finished.js`, the other `Object.hasOwn(X.prototype, …)` openers |
| 10 | **A self-referential `const` in two sibling blocks collapses to the first block's type.** `{ const s = new A({ cb: () => s.m() }); }` followed by `{ const s = new B({ cb: () => s.n() }); }` checks the second `s` against `A`. **New engine bug.** | `test-stream-objectmode-undefined.js` |
| 11 | **A bare `return;` where the inferred return type is `Any`** ([zun#22](https://github.com/UrubuCode/zun/issues/22)) | `test-stream-backpressure.js` |
| 12 | **`Symbol.hasInstance` / cross-class `instanceof`** ([zun#31](https://github.com/UrubuCode/zun/issues/31)) | `test-stream-inheritance.js` |
| 13 | **A `functionBox` handed to `Promise.prototype.then` is silently never called** — `promise.then(common.mustCall())` registers the count and nothing ever satisfies it, so the harness reports a mismatch that has nothing to do with the stream. **New engine bug.** | every test that settles an `async` block with `.then(common.mustCall())` |
| 14 | **Smaller engine gaps**: `Array.prototype.fill()` with no arguments rejected; a byte view has no inspect form ([zun#62](https://github.com/UrubuCode/zun/issues/62)); `instanceof Object` always true ([zun#26](https://github.com/UrubuCode/zun/issues/26)); `EvalError: code generation from strings disallowed` for a test that builds a function from text | scattered |

**Every failure traced so far lands outside `stream.ts`** — the groups above
account for all 20 bundle failures, all 59 compile errors and all 26 of the
runs classified `parse` — and where a test reaches its assertions at all, the
two differential runs say the state machines agree with Node. The honest
caveat: of the 11 `assertion` and 19 `runtime` failures, the ones reduced here
all bottom out in rows 1-14 (most often row 5, `this` inside a listener, and
row 13, `then(common.mustCall())`), but they were not reduced one by one.

## What `fs` will need from this module

`src/fs/` is still only the Rust natives — there is no `fs.ts` to hang
`createReadStream`/`createWriteStream` on — so nothing was wired here (and
`src/fs/` is being written in parallel). When that surface lands it needs,
from this module and nothing else:

* `Readable` and `Writable` as **subclassable bases** with the `read`,
  `write`, `destroy` and `construct` options, which is how Node's
  `fs.ReadStream` / `fs.WriteStream` are built (`lib/internal/fs/streams.js`
  subclasses them and implements `_construct` to open the fd, `_read` to
  `read()` into a pooled Buffer, `_destroy` to close);
* `_construct` for the asynchronous `open`, which is implemented here (it runs
  synchronously from the constructor rather than on the next tick — see the
  header note);
* `finished`/`eos` for `'close'` bookkeeping;
* and `Readable.prototype.pipe`, which `fs`'s own tests exercise heavily.

The only thing it will want that is **not** here is a Buffer that survives the
`any` lane — `fs.ReadStream` pushes `Buffer` chunks, which is blocker 4/5
above.

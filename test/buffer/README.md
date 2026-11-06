# node:buffer — Node.js compatibility tests

The compatibility bar for `buffer` is **Node.js 25's own test suite**, not tests
we write. `buffer` is **not finished** until it passes 100% of Node's
`test-buffer*` tests.

## The oracle

`NODE_TESTS.txt` is the full inventory of Node 25's corpus for this module —
**64 files**, all under the single `test-buffer` prefix, from
`test-buffer-alloc.js` to `test-buffer-zero-fill.js`. Each is fetched verbatim
from `nodejs/node` at tag `v25.0.0`; nothing is vendored here.

## How they run

```sh
cargo build -p zun_cli                 # the `zun` binary
bash zun-node/tools/run_node_tests.sh \
    --zun target/debug/zun \
    --module buffer
```

`buffer` is a **`zun-ts`** module: no `--ext`. Each test is bundled by
`tools/bundle_node_test.sh` (`util` → `events` → `process` → `assert` →
`path` → **`buffer`** → the harness) and run as `zun run <bundle.ts>`.
`src/buffer/buffer.ts` is listed in the bundler's `CONDITIONAL_FILES`, so it is
inlined only into the bundles of the fourteen tests that actually
`require('buffer')`; the other fifty use the global `Buffer` alone and need no
library code at all.

## `Buffer` is the engine's, not ours

This is the first module in the library whose central object already exists
**in the engine**. Node's `Buffer` is a `Uint8Array` subclass, and Zun's is a
nominal alias for the `Uint8Array` byte-view floor: a realm global declared in
`crates/zun_prelude/builtin/realm.zun`, with its statics recognised by receiver
name in the checker (`crates/zun_sema/src/check/builtins/buffer.rs`,
`check_buffer_static`) and
its instance methods lowered to the `nodeBuffer` intrinsic group
(`crates/zun_natives/src/node_buffer.rs`, implemented on the interpreter floor
in `crates/zun_interp/src/node_buffer.rs`). NUCLEUS #21 is its specification.

Node's `buffer.Buffer` and `globalThis.Buffer` are the same object, so the rule
here is the rule `events` follows for `EventEmitter`: **this module never
introduces a second Buffer.** `Buffer` is the canonical binding of `buffer` in
the bundler's module table, so `const { Buffer } = require('buffer')` leaves the
name bound to the engine global, and `__node_buffer.Buffer` carries that same
value so a `buffer.Buffer` member read answers it too.

The consequence is sharp and worth stating plainly: **everything the engine's
`Buffer` is missing cannot be added from here.** A method the checker does not
know on a `BufferView(U8)` receiver is a *compile error* —
`type BufferView(U8) has no methods` — not a missing property. There is no
prototype to extend (no function/prototype model, [zun#25](https://github.com/UrubuCode/zun/issues/25)),
and no `any` lane to route around it, because a byte view read through `any` is
completely opaque in this engine (`buf.length` answers `undefined`). So
`buf.compare`, `buf.toJSON`, `buf.entries`/`keys`/`values`, `buf.buffer`,
`buf.byteOffset`, `buf.parent`, `Buffer.compare`, `Buffer.isEncoding`,
`Buffer.of`, `Buffer.allocUnsafeSlow` and `Buffer.poolSize` are **engine gaps**,
listed below with repros, not omissions in `src/buffer/buffer.ts`.

One escape hatch does exist and was considered: `check_buffer_static` is gated
on `!self.classes_by_name.contains_key("Buffer")`
(`crates/zun_sema/src/check/expr/method_call.rs:373`), so a program that
declares its own `class Buffer` takes the whole static surface over, and a class
*can* accept a `number`. It is not taken, for two reasons that are both fatal:
a class instance has no indexed access (`b[i]` on one answers `undefined`
through an `any` and does not compile otherwise) while Node's buffer tests index
constantly, and `class Buffer extends Uint8Array` is `unknown base class`
— so the replacement could not be a byte view. A static-only shadow returning
engine views would also mean rewriting every `Buffer` type annotation in `fs`,
`stream`, `zlib`, `crypto`, `readline` and `string_decoder`, and would still
leave every *instance* method rejecting a `number`. The gaps are the engine's
to close.

What an `any` *does* still carry is two predicates — `Buffer.isBuffer` and
`ArrayBuffer.isView` — and that is enough for this module to recognise a byte
view even though it cannot read one; passing the value into a `Buffer`-typed
parameter is what reads the bytes. The inspector and `isUtf8`/`isAscii` are both
built on that pair.

## What is implemented

`src/buffer/buffer.ts` is exactly the Node 25 `module.exports` of
`lib/buffer.js`, and all of it:

* `Buffer` — the engine global, carried as a value.
* `kMaxLength` (2⁵³−1), `kStringMaxLength` (536870888) and the `constants`
  object (`MAX_LENGTH`, `MAX_STRING_LENGTH`). Node makes `constants`
  non-configurable and its members non-writable through
  `ObjectDefineProperties`; here it is a plain object, because this engine has
  no `Object.defineProperty` with descriptors.
* `INSPECT_MAX_BYTES` (50) — **the accessor pair Node defines**, not a data
  property. The engine does support `get`/`set` members in an object literal
  (the note here that it does not was stale), so the setter runs Node's
  `validateNumber(val, 'INSPECT_MAX_BYTES', 0)`:
  `buffer.INSPECT_MAX_BYTES = 'x'` throws `ERR_INVALID_ARG_TYPE`, and `= -1` or
  `= NaN` throws `ERR_OUT_OF_RANGE`. The number it guards lives in
  `src/util/util.ts`, which is where the inspector that reads it is and which
  is inlined into every bundle while this module is conditional — the same
  split Node has between `lib/buffer.js`'s accessor and the module-scoped
  variable its custom inspector closes over. This is what makes
  `test-buffer-set-inspect-max-bytes.js` pass.
* **`Buffer.prototype[util.inspect.custom]`.** Node defines a buffer's
  inspected form in `lib/buffer.js` rather than in the inspector, so it belongs
  to this module even though the code sits in `src/util/util.ts` (for the same
  reason as `INSPECT_MAX_BYTES`). Both of Node's forms are produced:
  `<Buffer 61 62 ... 3 more bytes>` under the default `customInspect`, and the
  generic `Buffer(2) [Uint8Array] [ 97, 98 ]` — which is what `assert` renders
  its diff with — under `customInspect: false`, column-grouped for a long
  buffer exactly as Node groups it. The bytes are reached by passing the view
  *into* a `Buffer`-typed parameter, because reading one through `any` is
  opaque (zun#38). This is what makes `test-buffer-prototype-inspect.js` pass,
  and `console.log(Buffer.from('abc'))` now answers `<Buffer 61 62 63>` instead
  of `{ 0: 97, 1: 98, 2: 99 }`. One divergence comes with it and cannot be
  removed: the engine's `Buffer` is a nominal alias for the `Uint8Array` floor,
  so `Buffer.isBuffer` cannot separate the two and a real `Uint8Array` inspects
  as `<Buffer …>` where Node prints `Uint8Array(2) [ 1, 2 ]`.
* `atob` / `btoa` — written out rather than delegated to the engine globals,
  which are lenient where Node's are strict: `atob('a')` answers `''` there
  instead of throwing, and `btoa('\u0100')` answers `'AA=='` instead of
  throwing. Node's two `InvalidCharacterError` cases and its padding rule are
  reproduced exactly, including the split that makes `atob('a')` "not correctly
  encoded" while `atob('YQ=')` and `atob('aGVsbG8==')` are "Invalid character".
  Verified against `node` over 16 `atob` and 9 `btoa` inputs: zero
  divergences.
* `isUtf8` / `isAscii` — byte scans with Node's `ERR_INVALID_ARG_TYPE` contract.
  The input must be something `Buffer.isBuffer` recognises; Node also takes an
  `ArrayBuffer` (indistinguishable from `{}` through an `any` here) and every
  other typed array (indistinguishable from a `DataView`, which Node rejects
  and whose bytes cannot be read through the typed-array accessors without an
  **uncatchable** engine error). Both divergences are stated at the use site;
  neither is reachable from the corpus. The previous code called the scan for
  any `ArrayBuffer.isView`, which crashed the program on a `Uint16Array`.
* `transcode(source, fromEncoding, toEncoding)` — **ICU's behaviour, not a
  decode-then-encode over the engine's codec table.** ICU has four charsets
  (`ascii`, `latin1`, `utf8`, `ucs2` plus aliases — `hex`, `base64` and
  `base64url` are *not* charsets and raise `U_ILLEGAL_ARGUMENT_ERROR`), it
  substitutes U+FFFD on a malformed decode and `?` on an unmappable encode, it
  is strict in the two directions that go through `u_strFromUTF8` /
  `u_strToUTF8`, and `node_i18n.cc` routes six of the sixteen pairs through
  specialized converters. The whole matrix is written out in the header of
  `src/buffer/buffer.ts` and verified below. The error is Node's
  `genericNodeError` — a plain `Error` with `code` and `errno`, never
  `ERR_UNKNOWN_ENCODING`.
* `Blob` and `File` — the synchronous core (`size`, `type`, `slice`, `bytes()`,
  `arrayBuffer()`, `text()`, plus `name`/`lastModified` on `File`).
  `blob.stream()` is absent rather than faked: it would make this module depend
  on `node:stream`, which depends on it.
  A blob holds its bytes as a **latin1 string, not as a Buffer**, because a
  byte view stored in a class instance field has its backing `ArrayBuffer`
  collected out from under it (zun#55, group C) — and in a dynamically
  dispatched call that failure is *silent*, so `blob.size` would simply start
  answering `NaN` in a long-running program.
* `resolveObjectURL(id)` — always `undefined`, which is what Node answers for an
  id that was never registered; there is no `URL.createObjectURL` here.

**There is no `SlowBuffer`,** and that is not a gap: Node **removed** the
deprecated `SlowBuffer` (DEP0030) in v25. `lib/buffer.js`'s `module.exports` no
longer lists it, and `test/parallel/test-buffer-slow.js` at `v25.0.0` tests
`Buffer.allocUnsafeSlow` instead. Exporting one would be inventing API the
oracle does not have.

## Status and what blocks the rest

[`RESULTS.md`](RESULTS.md) is the live per-test table with the first line of
stderr for each failure; it and the README bar are regenerated by every tracker
run, so they — not this page — are the current number.

Below is the per-test blocker table, grouped by root cause. **Every failure is
blocked in the engine or in a missing harness module; none is blocked in
`src/buffer/buffer.ts`.** Each group leads with a standalone repro that runs
through `zun run` with no bundle.

Every row below was **re-probed against the release engine at `c4afcca4`** and
is current; the rows that had gone stale are called out where they sit. In
summary, what the engine gained since this page was first written:

| Was blocked | Now |
|---|---|
| `buf[i]` / `buf[i] = v` through a `number` variable | **works**, and the write wraps the byte (`300` → `44`) as in JS |
| `for (const b of buf)` | **works** (a buffer is iterable; its `entries`/`keys`/`values` still are not) |
| `Buffer.from('abc') instanceof Uint8Array` | compiles, and answers `false` — it was an uncatchable `call did not resolve to a method` |
| `Buffer.isBuffer(x)` / `ArrayBuffer.isView(x)` on an `any` | **work**, and `Buffer.isBuffer` separates a `U8` view from a `U16`/`F64` view and from a `DataView`. These two are the only class facts an `any` still carries, and they are what the inspector and `isUtf8` stand on |
| a getter/setter in an object literal or a class | **works** — which is how `INSPECT_MAX_BYTES` became an accessor |
| `x instanceof <a class declared in the program>` through an `any` | **works**, exactly (used for a nested `Blob` source) |
| `view.byteLength()` / `byteOffset()` / `buffer()` on a typed-array parameter | **work** for every typed-array kind, including a view handed in as an `any`; a `DataView` is still unreachable this way |

And what is unchanged: everything in groups A, B, C, F and G below.

### A. A `number` (or an `any`) cannot be a Buffer size, offset, index or fill byte

The dominant blocker, by a wide margin: **32 of the 64 tests** as of the
re-probe at `c4afcca4` — four more than before, because `test-buffer-alloc.js`,
`test-buffer-backing-arraybuffer.js`, `test-buffer-fill.js` and
`test-buffer-write-fast.js` used to fail earlier, in group D, and now bundle
and land here. The `nodeBuffer`
intrinsics are declared with machine integer parameters (`U64`, `U8`, `I64`) and
the checker demands an integer-typed expression at the call site. In a Node test
every value is a `number` (`Float(F64)`) or an `any`, so the *first* such call
fails to compile and the whole file is lost before a single assertion runs.

```js
function f(n)    { return Buffer.alloc(n); }     // SEM0001 Buffer size must be an integer
function g(b, o) { return b.readUInt8(o); }      // SEM0001 Buffer offset/index must be an integer
function h(b, v) { return b.fill(v); }           // SEM0001 Buffer fill byte must be an integer
function k(s)    { return Buffer.from(s, 'hex'); }
//                 SEM0001 `Buffer.from` expects a string, array or ArrayBuffer, found Any
function s(b, a, z) { return b.slice(a, z); }    // SEM0001 Buffer offset/index must be an integer
```

Node runs all five. `x as u64` / `x as u8` is the only coercion that lands, and
that is what `src/buffer/buffer.ts` and `src/string_decoder/string_decoder.ts`
spell everywhere — but a cast cannot be written into a test body. The arguments
are plain JavaScript numbers in Node's API, so the right fix is in the checker:
accept a `number` and apply Node's `validateOffset`/`validateNumber` coercion.

| Test | First diagnostic |
|---|---|
| `test-buffer-alloc.js` | `buffer index must be an integer` |
| `test-buffer-arraybuffer.js` | `ArrayBuffer length must be an integer` |
| `test-buffer-backing-arraybuffer.js` | `ArrayBuffer length must be an integer` |
| `test-buffer-bigint64.js` | `buffer index must be an integer` |
| `test-buffer-compare.js` | `Buffer fill byte must be an integer` |
| `test-buffer-copy.js` | `Buffer fill byte must be an integer` |
| `test-buffer-equals.js` | `` `equals` expects another Buffer `` (an `any`-typed argument) |
| `test-buffer-fill.js` | `Buffer fill byte must be an integer` |
| `test-buffer-includes.js` | `Buffer byteOffset must be an integer` |
| `test-buffer-indexof.js` | `Buffer byteOffset must be an integer` |
| `test-buffer-inspect.js` | `Buffer fill byte must be an integer` |
| `test-buffer-isutf8.js` | `` `Buffer.from` expects a string, array or ArrayBuffer, found Any `` |
| `test-buffer-no-negative-allocation.js` | `Buffer size must be an integer` |
| `test-buffer-over-max-length.js` | `Buffer size must be an integer` |
| `test-buffer-read.js` | `Buffer offset/index must be an integer` |
| `test-buffer-readdouble.js` | `buffer index must be an integer` |
| `test-buffer-readfloat.js` | `buffer index must be an integer` |
| `test-buffer-readint.js` | `buffer index must be an integer` |
| `test-buffer-readuint.js` | `buffer index must be an integer` |
| `test-buffer-slice.js` | `Buffer offset/index must be an integer` |
| `test-buffer-swap.js` | `` `Buffer.from` … found Any `` |
| `test-buffer-tojson.js` | `` `Buffer.from` … found Any `` |
| `test-buffer-tostring-4gb.js` | `Buffer size must be an integer` |
| `test-buffer-tostring-range.js` | `Buffer offset/index must be an integer` |
| `test-buffer-tostring-rangeerror.js` | `Buffer size must be an integer` |
| `test-buffer-tostring.js` | `Buffer encoding must be a string` (an `any`-typed encoding) |
| `test-buffer-write-fast.js` | `` `Buffer.from` expects 1 or 2 arguments `` |
| `test-buffer-write.js` | `Buffer offset/index must be an integer` |
| `test-buffer-writedouble.js` | `buffer index must be an integer` |
| `test-buffer-writefloat.js` | `buffer index must be an integer` |
| `test-buffer-writeint.js` | `argument type Float(F64) does not match Int(…)` |
| `test-buffer-writeuint.js` | `buffer index must be an integer` |

### B. Buffer surface the engine does not have

```js
Buffer.from('ab').compare(Buffer.from('ac'));   // SEM0001 type BufferView(U8) has no methods
Buffer.from('ab').toJSON();                     // SEM0001 type BufferView(U8) has no methods
for (const [k, v] of Buffer.from('ab').entries()) {}  // same
const a = Buffer.from('ab');
a.buffer; a.byteOffset; a.parent;               // SEM0001 type BufferView(U8) has no fields
Buffer.isEncoding('utf8');        // SEM0001 `Buffer.isEncoding` is not supported in this runtime
Buffer.of(1, 2);                  // SEM0001 `Buffer.of` is not supported in this runtime
Buffer.allocUnsafeSlow(2);        // SEM0001 `Buffer.allocUnsafeSlow` is not supported in this runtime
Buffer.poolSize;                  // undefined
```

`Buffer.compare` answers
`` `Buffer.compare` is not supported in this runtime ``. Every line above was
re-run at `c4afcca4` and every one still fails the same way.

`byteLength` / `byteOffset` / `buffer` *do* exist, but only as **methods**
(`a.byteLength()`), not as the properties Node exposes — so a test reading
`a.buffer.byteLength` cannot compile either. They do work on a view handed in
through an `any`, and for every typed-array kind, which is how
`src/buffer/buffer.ts` reaches an `ArrayBuffer`.

A buffer is now **iterable** — `for (const b of Buffer.from('abc'))` works — but
`entries()` / `keys()` / `values()` and `buf[Symbol.iterator]()` are still
missing, which is what `test-buffer-iterator.js` needs.

| Test | Needs |
|---|---|
| `test-buffer-compare-offset.js` | `buf.compare(target, tStart, tEnd, sStart, sEnd)` |
| `test-buffer-iterator.js` | `buf.entries()`, `buf.keys()`, `buf.values()` |
| `test-buffer-isencoding.js` | `Buffer.isEncoding` |
| `test-buffer-of-no-deprecation.js` | `Buffer.of` |
| `test-buffer-slow.js` | `Buffer.allocUnsafeSlow`, `buf.entries()`, `buf.buffer` as a property |
| `test-buffer-zero-fill-cli.js` | `Buffer.allocUnsafeSlow` |
| `test-buffer-parent-property.js` | `buf.parent`, `buf.buffer` as properties |
| `test-buffer-pool-untransferable.js` | `buf.buffer` as a property (it used to be group D, for `worker_threads`) |
| `test-buffer-resizable.js` | `buf.buffer` as a property, resizable `ArrayBuffer` |
| `test-buffer-sharedarraybuffer.js` | `view.buffer`/`byteOffset` as properties on a `U16` view, `SharedArrayBuffer` |

### C. The GC frees a live Buffer's backing `ArrayBuffer`

This is the most serious engine bug the track found, and it is not specific to
`buffer` — it makes **any** byte view unusable after the first young collection.

```ts
class Junk { s: string = "x"; n: number = 1; }
const input = Buffer.from("000000", "hex");
let acc = 0;
for (let i = 0; i < 256; i++) { const j = new Junk(); acc = acc + j.n; }
console.log("instances", acc);             // 256
console.log("len", Number(input.length));  // zun: runtime error: call did not
                                           //   resolve to a method
```

`input` is a live top-level `const`. 255 iterations pass; **256 fails**, which
is where the first young collection runs. The same program with the
`ArrayBuffer` held in its *own* binding survives, which pins the cause exactly:

```ts
const ab = new ArrayBuffer(3);
const input = new Uint8Array(ab, 0, 3);    // `ab` is independently rooted
for (let i = 0; i < 256; i++) { const j = new Junk(); }
console.log(Number(input.length()));       // 3 — fine
```

Code site: `Heap::alloc_typed_array` (`crates/zun_gc/src/typed_views.rs:255`)
allocates the view object as `self.alloc(0, 1)` and stores the buffer's address
in field 0 — so the view carries **type RID 0**.
`TypeSystem::reference_slots` (`crates/zun_types/src/lib.rs:279`) resolves a RID
with `type_rid.checked_sub(1)`, so RID 0 has no descriptor and the slot list is
empty. The mark phase (`crates/zun_gc/src/collection.rs:238` and `:372`) traces
only `ref_slots(obj.type_rid())` plus dynamic properties, arrays, maps and
generator frames — **never `typed_views`/`data_views`** — so the view is marked
and its `ArrayBuffer` is not. Sweep then drops the bytes
(`collection.rs:542`, `self.buffers.remove(...)`), and every later operation on
the still-live view fails `buffer_len` → `None` → `RunError::BadToken`, which
surfaces as `call did not resolve to a method` and is **not catchable** by a
`try`/`catch`.

This also caps the whole corpus from below: the harness, `assert` and
`util.inspect` allocate class instances freely, so a test only has to be big
enough to cross the threshold for its Buffers to die underneath it.

**Still live, and worse than the message above suggests.** Re-probed at
`c4afcca4` with 400 iterations: a view in a *class instance field* dies the same
way, and whether the failure is visible depends on how the read is reached.

```ts
class Holder { b: Buffer = Buffer.alloc(0); }
class Junk { s: string = "x"; n: number = 1; }
const h = new Holder();
h.b = Buffer.from("abc");
function readLen(): number { return Number(h.b.length); }
function caught(fn: any): string {
  try { return "ok:" + String(fn()); } catch (e: any) { return "caught:" + e.name; }
}
for (let i = 0; i < 400; i++) { const j = new Junk(); }
console.log(readLen());            // zun: runtime error: call did not resolve
                                   //   to a method  (exit 1)
console.log(caught(() => readLen()));  // "ok:NaN"  — swallowed, exit 0
```

Reached directly it is an uncatchable runtime error that stops the program;
reached through a dynamically dispatched call (an arrow held in an `any`, which
is how every callback in this library is invoked) **the error is swallowed and
the expression answers `undefined`/`NaN`**, with exit status 0. So the bug can
turn into silently wrong data rather than a crash, and a test that only checks
exit status can pass while its buffers are empty.

| Test | What happens |
|---|---|
| `test-buffer-constants.js` | passed at the time of writing; it is one of the six, but it sits right at the threshold |
| `test-buffer-zero-fill.js` | `unhandled exception` (also needs `new Buffer(n)`, group F) |

It is the reason `src/string_decoder/string_decoder.ts` keeps its four pending
bytes in four `number` fields instead of the `lastChar` Buffer Node keeps them
in (see `test/string_decoder/README.md`), and the reason `Blob` here holds its
bytes as a latin1 string rather than as the `Buffer` they obviously want to be.

### D. Missing harness modules (the bundle fails rather than guessing)

Mostly **resolved** since this page was written: `vm`, `crypto`,
`worker_threads`, `internal/errors` and `internal/test/binding` have all since
been added to the bundler's module table, so those tests now reach a real
blocker from group A or B instead of failing to bundle. The one that still does
not bundle is:

| Test | Requires |
|---|---|
| `test-buffer-constructor-node-modules.js` | `../common/child_process`, `../common/fixtures` — and it spawns `process.execPath` on two files from `test/fixtures/warning_node_modules/`, so a shim for the two harness modules would not make it pass |

### E. Behavioural divergences in the engine's codecs and accessors

Each row is a standalone repro; the Node answer is from `node` on the same
input.

| Repro | Zun | Node | Affects |
|---|---|---|---|
| `Buffer.from('e280','hex').toString('ascii')` | one `U+FFFD` (`fd` in latin1) | `62 00` — Node's `ascii` **decoder masks the high bit** (`byte & 0x7F`) | `test-buffer-ascii.js` (`'hérité' !== 'hC)ritC)'`) |
| `Buffer.from('é', 'ascii').toString('hex')` | `c3a9` (UTF-8) | `e9` — Node's `ascii` **encoder** writes `charCode & 0xFF` | `test-buffer-ascii.js` |
| `Buffer.alloc(4).write('xxabcd', 0, 'hex')` | `2`, buffer `abcd0000` | `0`, buffer unchanged — Node **stops at the first invalid pair**, Zun skips it. (`'abcdxx'` agrees at `2`/`abcd0000`; it is only a *leading* bad pair that diverges.) | `test-buffer-badhex.js` (`2 !== 0`) |
| `Buffer.from('abc') instanceof Uint8Array` | `false` | `true` | `test-buffer-inheritance.js` and any `instanceof` assertion |
| `Buffer.alloc(8, 'a')` | `SEM0001 Buffer fill byte must be an integer` | `<Buffer 61 …>` | `test-buffer-fill.js` |
| `Buffer.alloc(8, 'aGk', 'base64')` | `SEM0001 Buffer.alloc expects 1 or 2 arguments` | three-arg form | `test-buffer-fill.js` |
| `buf.write('abc', 0, 1, 'utf8')` | `SEM0001 write expects 1 to 3 arguments` | `1` — Node's `(string, offset, length, encoding)` | `test-buffer-write.js` |
| `Buffer.concat(list, totalLength)` | `SEM0001 'Buffer.concat' expects 1 argument (a list)` | the two-argument form | `test-buffer-concat.js` |
| `buffer.transcode(buf, 'utf8', 'latin1').toString('hex')` | `TypeError: toString is not a function` | `e9` | the **returned Buffer** is read back through `any`, which is opaque (zun#38). The transcode itself is now verified exact (544 cases, below); only reading the result from a test body does not work. |

Two rows that were here are **no longer divergences**:
`const v = 300; buf[0] = v` now answers `44` as in JS, and
`console.log(Buffer.from('abc'))` now answers `<Buffer 61 62 63>` — the first
because the engine gained indexed access through a `number`, the second because
this module now carries Node's custom inspector (see "What is implemented").
The old `transcode` row about inheriting the `ascii` gap is gone too: the
transcoder no longer goes through the engine's codecs.

### F. No function-constructor / prototype model ([zun#25](https://github.com/UrubuCode/zun/issues/25))

| Test | What it needs |
|---|---|
| `test-buffer-new.js` | `new Buffer(…)` throwing the v25 errors. `new Buffer(4)` compiles and answers `undefined` here; `Buffer(4)` through an `any` is `call did not resolve to a method` |
| `test-buffer-zero-fill.js` | `Buffer(100)` and `new Buffer(100)` |
| `test-buffer-constructor-deprecation-error.js` | **engine panic**, `crates/zun_interp/src/value.rs:226` |
| `test-buffer-fakes.js` | `function FakeBuffer() {}` + `Object.setPrototypeOf(FakeBuffer, Buffer)` → `SEM0001 unknown class 'FakeBuffer'` |
| `test-buffer-inheritance.js` | `function T(n) {…}` + `T.prototype.sum = …` → `SEM0001 unknown class 'T'` |
| `test-buffer-pending-deprecation.js` | the `Buffer()` deprecation warning (`common.expectWarning`); the `mustCall` count comes back 0 |
| `test-buffer-constructor-outside-node-modules.js`, `test-buffer-constructor-node-modules-paths.js` | both now bundle (they used to be group D) and fail at run time with `unhandled exception`: they ask `vm.runInNewContext('new Buffer(10)', …)` to emit DEP0005, which needs both a real `eval` and the `Buffer()` deprecation hook |

### G. Other engine gaps

| Test | Blocked by |
|---|---|
| `test-buffer-isascii.js` | `structuredClone(value, options)` — `SEM0001 structuredClone expects 0 to 1 argument(s), found 2` |
| `test-buffer-failed-alloc-typed-arrays.js` | `view.fill(v)` with fewer than three arguments — `SEM0001 fill expects 3 argument(s)` |
| `test-buffer-bytelength.js` | `SEM0001 spread arguments are not lowered yet` |
| `test-buffer-from.js` | `SEM0001 unknown base class 'String'` (`class MyString extends String`) |
| `test-buffer-resizable.js` | a resizable `ArrayBuffer` (`new ArrayBuffer(n, { maxByteLength })`) plus `buf.buffer` as a property |
| `test-buffer-sharedarraybuffer.js` | `SharedArrayBuffer`, and `.buffer`/`.byteOffset` as properties on a `U16` view |

One row that was here is **gone**: `test-buffer-safe-unsafe.js` and
`test-buffer-zero-fill-reset.js` used to die on
`malformed bytecode: comparison of mismatched numeric kinds: Float(0.0, F64) vs
Void` — an element read from a typed array held in an `any` had no numeric kind.
That repro now runs (`b.length` on an `any` is still `undefined`, so the loop
body never executes, which happens to give the answer these two tests want) and
both tests pass.

### H. A comment can change what the checker compiles (new engine bug)

Not a `buffer` blocker, but found while writing this module and worth recording
because it is a trap for every file in this library: **the whole word
`arguments` anywhere inside a function or constructor body — including inside a
`//` comment — gives that function an implicit `arguments` object, which means
a synthetic rest parameter and a different arity contract.**

```ts
class F {
  constructor(a: any, b: any, c?: any) {
    // arguments.length
  }
}
const f = new F([1], "n");
// zun: SEM0001 `F` constructor expects at least 3 fixed argument(s)
// node: fine — it is a comment
```

Deleting the comment makes it compile. Code site:
`find_arguments_word` (`crates/zun_syntax/src/oxc/function.rs:211`) searches the
**raw source text** of the function's span for the whole word, with no
knowledge of comments or string literals, and `inject_arguments_object`
(`:231`) then appends the synthetic rest parameter. It cost an hour here: a
three-line comment added to `File`'s constructor, documenting that Node keys the
error on `arguments.length`, silently broke `new File(bits, name)` everywhere in
the bundle. The comment is now worded without the word.

### I. Passing

`test-buffer-constants.js`, `test-buffer-nopendingdep-map.js`,
`test-buffer-prototype-inspect.js`, `test-buffer-safe-unsafe.js`,
`test-buffer-set-inspect-max-bytes.js` and `test-buffer-zero-fill-reset.js`
pass. Two of them are new with this work:
`test-buffer-set-inspect-max-bytes.js` was in group G above (the accessor claim
was stale) and `test-buffer-prototype-inspect.js` was in group E.

## Verification of the module's own surface

The failures above are all outside `src/buffer/buffer.ts`, so the module is
verified the way `os` is — by running the same program under `node` and under
`zun` and diffing. Four differential runs:

1. **The surface.** The constants, 16 `atob` inputs (empty, unpadded,
   over-padded, mid-string `=`, embedded whitespace, non-alphabet), 9 `btoa`
   inputs (including a code point above U+00FF), `isUtf8`/`isAscii` over 17 byte
   sequences (overlong, surrogate-encoded, `f5`-lead, truncated,
   `f4 8f bf bf` vs `f4 90 80 80`) plus every wrong-type argument, and
   `resolveObjectURL`. **Zero divergences** in the values and the error codes.
   The two divergences that remain are the ones named under "What is
   implemented": an `ArrayBuffer` and a non-`U8` view are rejected where Node
   accepts them, and `Received an instance of Object` stands where Node names
   the real class — both because an `any` does not carry its class (zun#38).
2. **`transcode`: the full ICU matrix.** 4 source encodings × 4 target
   encodings × 34 byte sequences — **544 cases, byte-for-byte identical**,
   including every substitution (`?` for unmappable, U+FFFD for malformed), both
   `U_INVALID_CHAR_FOUND` directions, the trailing-odd-byte rules of all three
   `ucs2` source paths, unpaired surrogates on both sides, surrogate pairs, and
   the one place where ICU joins a dangling byte into the preceding unpaired
   high surrogate (`<3d d8 61>` is one U+FFFD; `<4d dc 61>` is two). Driven
   through `__bufTranscodeView` directly, because a `Buffer` returned into an
   `any` cannot be read back (group E).
3. **`util.inspect` of a byte view.** 22 cases — the three the corpus asserts,
   nesting in an object and an array, `customInspect: false` at 0/2/3/105 bytes
   (including Node's column grouping), `maxArrayLength`, `INSPECT_MAX_BYTES`
   set and read back, the depth limit, and all four `validateNumber` rejections
   with their messages. **Zero divergences.**
4. **`Blob` / `File`.** 35 cases — every constructor source shape, `type`
   normalization, the `slice` offset rules, `name`/`lastModified` coercion, the
   error codes and messages, and the `text()`/`bytes()`/`arrayBuffer()` chain.
   **Zero divergences** except an `ArrayBuffer` part (stringified here, for the
   reason above) and reading `.length` off the `Uint8Array` that `bytes()`
   resolves with, which is group E again.

## Security: the four Buffer CVEs, checked

The brief for this module names four historical Buffer CVEs that must not be
reintroduced. Each was checked against the engine's `Buffer` directly, and
**every row below was re-probed at `c4afcca4`: all four findings still stand
unchanged**, including the UCS-2 partial-code-unit write and the `raw_vec`
panic.

* **Non-zeroed memory from `alloc`** — **clean.** `Buffer.alloc(16)` and
  `Buffer.allocUnsafe(16)` both answer sixteen zero bytes;
  `crates/zun_interp/src/node_buffer.rs` zero-fills `allocUnsafe` too (NUCLEUS
  #21 records that deliberately).
* **CVE-2017-15897, `alloc(size, fill, encoding)` leaving memory
  uninitialised when the fill does not decode** — **not reachable.** The
  three-argument form does not exist: `Buffer.alloc(8, 'aGk', 'base64')` is a
  compile error (`Buffer.alloc expects 1 or 2 arguments`), and even
  `Buffer.alloc(8, 'a')` is rejected because `fill` must be an integer. There is
  no path that can leave memory uninitialised, because there is no path at all.
  It is a **gap**, listed in group E, not a vulnerability.
* **CVE-2018-12115, a UCS-2 `write` near the end of the buffer writing past
  it** — **no out-of-bounds write, but a real correctness bug: the engine writes
  a partial code unit.**

  ```ts
  function wr(b: Buffer, s: string, o: number, e: string): number {
    return b.write(s, o as u64, e);
  }
  const b = Buffer.alloc(6, 0);
  console.log(wr(b, "abc", 1, "ucs2"), b.toString("hex"));
  // zun:  5  006100620063     <- five bytes: 'c' has only its low half
  // node: 4  006100620000     <- whole code units only
  const c = Buffer.alloc(4, 0);
  console.log(wr(c, "ab", 3, "ucs2"), c.toString("hex"));
  // zun:  1  00000061
  // node: 0  00000000
  ```

  Both writes stay inside the allocation, so this is not the memory-safety half
  of the CVE — but a UCS-2 write must round down to whole 16-bit units, and this
  one does not. Reported as an engine bug.
* **CVE-2018-7166, the encoding argument passed as a number** — **not
  reachable, because the length argument it interacts with does not exist.**
  `buf.write(str, offset, length, encoding)` is a compile error here
  (`write expects 1 to 3 arguments`), and the engine's three-argument form reads
  its third argument as the *encoding*, so `buf.write('abc', 0, 1)` answers `3`
  where Node answers `1`. A number in the encoding slot is silently ignored
  rather than mis-decoded. Again a gap (group E), not a vulnerability.

One further allocation hazard, found while checking the above and **not** one of
the four:

```ts
function f(n: number): Buffer { return Buffer.alloc(n as u64); }
f(-1);
// thread '<unnamed>' panicked at library/alloc/src/raw_vec/mod.rs:28:5:
// capacity overflow
```

The `as u64` cast is unchecked, so a negative size wraps to 2⁶⁴−1 and the
interpreter aborts on a `raw_vec` capacity overflow instead of raising
`ERR_OUT_OF_RANGE`. The engine should reject the size itself. On this side the
hazard is now structurally out of reach rather than guarded: the only
`Buffer.alloc` left in `src/buffer/buffer.ts` takes the literal `0`, and every
other allocation is a `Buffer.from(<string | array>)` that derives its own
length — so no caller-supplied number reaches an allocator at all. (The
`__bufValidateSize` guard that used to stand there went with the two
copy helpers that `Blob`'s latin1 storage made unnecessary; anything added here
later that allocates from a computed size needs it back.)

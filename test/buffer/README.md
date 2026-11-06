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
name in the checker (`crates/zun_sema/src/check.rs`, `check_buffer_static`) and
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

## What is implemented

`src/buffer/buffer.ts` is exactly the Node 25 `module.exports` of
`lib/buffer.js`, and all of it:

* `Buffer` — the engine global, carried as a value.
* `kMaxLength` (2⁵³−1), `kStringMaxLength` (536870888) and the `constants`
  object (`MAX_LENGTH`, `MAX_STRING_LENGTH`). Node makes `constants`
  non-configurable and its members non-writable through
  `ObjectDefineProperties`; here it is a plain object, for the same reason
  `INSPECT_MAX_BYTES` is a plain property.
* `INSPECT_MAX_BYTES` (50).
* `atob` / `btoa` — written out rather than delegated to the engine globals,
  which are lenient where Node's are strict: `atob('a')` answers `''` there
  instead of throwing, and `btoa('\u0100')` answers `'AA=='` instead of
  throwing. Node's two `InvalidCharacterError` cases and its padding rule are
  reproduced exactly, including the split that makes `atob('a')` "not correctly
  encoded" while `atob('YQ=')` and `atob('aGVsbG8==')` are "Invalid character".
  Verified against `node` over 16 `atob` and 9 `btoa` inputs: zero
  divergences.
* `isUtf8` / `isAscii` — byte scans with Node's `ERR_INVALID_ARG_TYPE` contract.
* `transcode(source, fromEncoding, toEncoding)`.
* `Blob` and `File` — the synchronous core (`size`, `type`, `slice`, `bytes()`,
  `arrayBuffer()`, `text()`, plus `name`/`lastModified` on `File`).
  `blob.stream()` is absent rather than faked: `node:stream` does not exist yet.
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

### A. A `number` (or an `any`) cannot be a Buffer size, offset, index or fill byte

The dominant blocker, by a wide margin: **28 of the 64 tests.** The `nodeBuffer`
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
| `test-buffer-arraybuffer.js` | `ArrayBuffer length must be an integer` |
| `test-buffer-bigint64.js` | `buffer index must be an integer` |
| `test-buffer-compare.js` | `Buffer fill byte must be an integer` |
| `test-buffer-copy.js` | `Buffer fill byte must be an integer` |
| `test-buffer-equals.js` | `` `equals` expects another Buffer `` (an `any`-typed argument) |
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
| `test-buffer-tostring-rangeerror.js` | `Buffer size must be an integer` |
| `test-buffer-tostring-range.js` | `Buffer offset/index must be an integer` |
| `test-buffer-tostring.js` | `Buffer encoding must be a string` (an `any`-typed encoding) |
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

`byteLength` / `byteOffset` / `buffer` *do* exist, but only as **methods**
(`a.byteLength()`), not as the properties Node exposes — so a test reading
`a.buffer.byteLength` cannot compile either.

| Test | Needs |
|---|---|
| `test-buffer-compare-offset.js` | `buf.compare(target, tStart, tEnd, sStart, sEnd)` |
| `test-buffer-iterator.js` | `buf.entries()`, `buf.keys()`, `buf.values()` |
| `test-buffer-isencoding.js` | `Buffer.isEncoding` |
| `test-buffer-of-no-deprecation.js` | `Buffer.of` |
| `test-buffer-slow.js` | `Buffer.allocUnsafeSlow`, `buf.entries()`, `buf.buffer` as a property |
| `test-buffer-zero-fill-cli.js` | `Buffer.allocUnsafeSlow` |
| `test-buffer-parent-property.js` | `buf.parent`, `buf.buffer` as properties |
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

| Test | What happens |
|---|---|
| `test-buffer-constants.js` | `call did not resolve to a method` after the module-level work |
| `test-buffer-zero-fill.js` | `call did not resolve to a method` (also needs `new Buffer(n)`, group F) |

It is also the reason `src/string_decoder/string_decoder.ts` keeps its four
pending bytes in four `number` fields instead of the `lastChar` Buffer Node
keeps them in — see `test/string_decoder/README.md`.

### D. Missing harness modules (the bundle fails rather than guessing)

| Test | Requires |
|---|---|
| `test-buffer-alloc.js` | `vm`, `crypto` |
| `test-buffer-bytelength.js` | `vm` |
| `test-buffer-constructor-outside-node-modules.js` | `vm` |
| `test-buffer-from.js` | `vm` |
| `test-buffer-concat.js` | `crypto` |
| `test-buffer-backing-arraybuffer.js` | `internal/test/binding` |
| `test-buffer-fill.js` | `internal/test/binding`, `internal/errors` |
| `test-buffer-write-fast.js` | `internal/test/binding` |
| `test-buffer-pool-untransferable.js` | `worker_threads` |
| `test-buffer-constructor-node-modules.js` | `../common/child_process`, `../common/fixtures` |
| `test-buffer-constructor-node-modules-paths.js` | `child_process` (it re-runs `new Buffer(10)` in `vm` inside a child) |

`internal/test/binding` is a Node-internal binding rather than a public module,
so those three can never be bundled as written.

### E. Behavioural divergences in the engine's codecs and accessors

Each row is a standalone repro; the Node answer is from `node` on the same
input.

| Repro | Zun | Node | Affects |
|---|---|---|---|
| `Buffer.from('e280','hex').toString('ascii')` | one `U+FFFD` | `62 00` — Node's `ascii` **decoder masks the high bit** (`byte & 0x7F`) | `test-buffer-ascii.js` (`'hérité' !== 'hC)ritC)'`) |
| `Buffer.from('é', 'ascii').toString('hex')` | `c3a9` (UTF-8) | `e9` — Node's `ascii` **encoder** writes `charCode & 0xFF` | `test-buffer-ascii.js` |
| `Buffer.alloc(4).write('xxabcd', 0, 'hex')` | `2`, buffer `abcd0000` | `0`, buffer unchanged — Node **stops at the first invalid pair**, Zun skips it | `test-buffer-badhex.js` (`2 !== 0`) |
| `console.log(Buffer.from('abc'))` | `{}` | `<Buffer 61 62 63>` — neither `console.log` nor `util.inspect` knows a byte view | `test-buffer-prototype-inspect.js` (`'{}' !== '<Buffer 66 68 …>'`), `test-buffer-inspect.js` |
| `Buffer.from('abc') instanceof Uint8Array` | `call did not resolve to a method` | `true` | `test-buffer-inheritance.js` and any `instanceof` assertion |
| `const v = 300; buf[0] = v;` | `call did not resolve to a method` | `44` — JS wraps the byte | — |
| `Buffer.alloc(8, 'a')` | `SEM0001 Buffer fill byte must be an integer` | `<Buffer 61 …>` | `test-buffer-fill.js` |
| `Buffer.alloc(8, 'aGk', 'base64')` | `SEM0001 Buffer.alloc expects 1 or 2 arguments` | three-arg form | `test-buffer-fill.js` |
| `buf.write('abc', 0, 1, 'utf8')` | `SEM0001 write expects 1 to 3 arguments` | `1` — Node's `(string, offset, length, encoding)` | `test-buffer-write.js` |
| `b.toString('ascii')` via `transcode` | masked above | — | `src/buffer/buffer.ts`'s `transcode` inherits the `ascii` gap |
| `buffer.transcode(buf, 'utf8', 'latin1').toString('hex')` | `TypeError: toString is not a function` | `e9` | the **returned Buffer** is read back through `any`, which is opaque. The transcode itself is right (`isUtf8`/`isAscii` on the result agree with Node); only reading it from a test does not work. Same cause as group A. |

### F. No function-constructor / prototype model ([zun#25](https://github.com/UrubuCode/zun/issues/25))

| Test | What it needs |
|---|---|
| `test-buffer-new.js` | `new Buffer(…)` throwing the v25 errors. `new Buffer(4)` compiles and answers `undefined` here; `Buffer(4)` through an `any` is `call did not resolve to a method` |
| `test-buffer-zero-fill.js` | `Buffer(100)` and `new Buffer(100)` |
| `test-buffer-constructor-deprecation-error.js` | **engine panic**, `crates/zun_interp/src/value.rs:226` |
| `test-buffer-fakes.js` | `function FakeBuffer() {}` + `Object.setPrototypeOf(FakeBuffer, Buffer)` → `SEM0001 unknown class 'FakeBuffer'` |
| `test-buffer-inheritance.js` | `function T(n) {…}` + `T.prototype.sum = …` → `SEM0001 unknown class 'T'` |
| `test-buffer-pending-deprecation.js` | the `Buffer()` deprecation warning (`common.expectWarning`); the `mustCall` count comes back 0 |

### G. Other engine gaps

| Test | Blocked by |
|---|---|
| `test-buffer-safe-unsafe.js`, `test-buffer-zero-fill-reset.js` | `malformed bytecode: comparison of mismatched numeric kinds: Float(0.0, F64) vs Void` — an element read from a typed array held in an `any` has no numeric kind: `function isZero(b) { for (let n = 0; n < b.length; n++) if (b[n] !== 0) return false; return true; } isZero(new Float64Array(2));` |
| `test-buffer-isascii.js` | `structuredClone(value, options)` — `SEM0001 structuredClone expects 0 to 1 argument(s), found 2` |
| `test-buffer-failed-alloc-typed-arrays.js` | `view.fill(v)` with fewer than three arguments — `SEM0001 fill expects 3 argument(s)` |
| `test-buffer-set-inspect-max-bytes.js` | `buffer.INSPECT_MAX_BYTES = 'foo'` must throw. Node defines it as an accessor pair on `module.exports` that runs `validateNumber`; there is no getter/setter on a dynamic object in this engine, so it is a plain data property and the assignment is accepted. The validation is not written in `src/buffer/buffer.ts` either, because there is nowhere to attach it — it would be unreachable code. |

### H. Passing

`test-buffer-nopendingdep-map.js` passes.

## Verification of the module's own surface

The 63 failures above are all outside `src/buffer/buffer.ts`, so the module is
verified the way `os` is — by running the same program under `node` and under
`zun` and diffing. The run covers the constants, 16 `atob` inputs (empty,
unpadded, over-padded, mid-string `=`, embedded whitespace, non-alphabet), 9
`btoa` inputs (including a code point above U+00FF), `isUtf8`/`isAscii` over 17
byte sequences (overlong, surrogate-encoded, `f5`-lead, truncated,
`f4 8f bf bf` vs `f4 90 80 80`) plus both wrong-type arguments, `transcode` in
both directions and on empty input, and `resolveObjectURL`. **Zero
divergences**, except for the three `transcode` rows, where what fails is
reading the returned Buffer back through `any` (group E) rather than the
transcode: `isUtf8`/`isAscii` on the result agree with Node.

## Security: the four Buffer CVEs, checked

The brief for this module names four historical Buffer CVEs that must not be
reintroduced. Each was checked against the engine's `Buffer` directly.

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
`ERR_OUT_OF_RANGE`. `src/buffer/buffer.ts` validates every size it passes
(`__bufValidateSize`) precisely because of this, but the engine should reject
the size itself.

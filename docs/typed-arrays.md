# Typed array bounds

Uneffect exposes `U8`, `U32`, `BoundedUint8Array<MaxLength>`,
`BoundedUint32Array<MaxLength>`, and `BoundedDataView<MaxBytes>` as gradual TypeScript
refinements. `verifyTypedArraySafety` checks implementation sites rather than
trusting JavaScript's coercion semantics:

```ts
import type { BoundedUint8Array, Nat, U8 } from "@mizchi/uneffect"

/* uneffect:requires size >= 0 && size <= 1024 */
function allocate(size: Nat): BoundedUint8Array<1024> {
  return new Uint8Array(size)
}

function write(bytes: BoundedUint8Array<1024>, index: Nat, value: U8) {
  bytes[index] = value
}
```

Allocation produces `0 <= size <= MaxLength`; element assignment produces
`0 <= value <= 255`. `Nat` and `U8` contribute their domain assumptions, while
an unrestricted `number` does not. This intentionally rejects reliance on
Uint8Array's modulo/truncation behavior.

`parseU8`, `parseBoundedUint8Array`, `parseBoundedDataView`,
`parseBoundedArrayBuffer`, and `parseFixedArrayBuffer` provide optional
runtime refinement at untyped boundaries. DataView instance validation uses
Valibot and its `byteLength` limit is checked synchronously without introducing
an opaque user-callback boundary. Code which already has trusted branded values
has no Uneffect runtime cost.

The current DataView static slice recognizes all standard `get*` and `set*`
accessors on `BoundedDataView<MaxBytes>` and follows reassignment-free local
`const` alias chains. It proves `offset + accessorWidth <= MaxBytes`.
`setInt8`, `setUint8`, `setInt16`, `setUint16`, `setInt32`, and `setUint32`
also produce signed or unsigned integer-domain obligations from helper types
and `requires` clauses. It intentionally rejects JavaScript's implicit numeric
coercion as a proof. Float and BigInt setters currently receive byte-bound
obligations but no value-domain obligation.

Simple literal `<`, `<=`, `>`, and `>=` bounds on `Int`, `Nat`, `U8`, and `U32`
parameters are intersected into integer intervals before proof. Both operand
orders and strict bounds are supported. Obligations outside this deliberately
small fragment fall back to Z3; callers can observe that cost through
`result.statistics.solverQueries`.

`BoundedArrayBuffer<MaxBytes>` means that `maxByteLength <= MaxBytes`; it is
appropriate for limiting resizable-buffer capacity but does not claim that the
bytes are currently available. `FixedArrayBuffer<Bytes>` means non-resizable
and exactly `Bytes` long. Only the latter proves a DataView constructor's
backing range. For `new DataView(buffer, offset, length)`, Uneffect separately
checks the requested region against the fixed buffer and `length` against the
returned `BoundedDataView` limit. Omitted lengths use `Bytes - offset`.
Unbounded or capacity-only buffers are reported instead of being silently
accepted.

The DNS header codec in `examples/dogfood/binary-codec.ts` is a practical
positive and negative control: its fixed buffer-to-view constructor and all
twelve 16-bit fields are verified, while a one-byte displacement of the final
field is rejected. Project verification also composes definite ownership order:
`examples/dogfood/worker-codec-transfer.ts` transfers the fixed buffer through
`Worker.postMessage`, and its later DataView construction downgrades the
backing obligation to a counterexample. This currently covers direct resources
and builtin DataView identity. The TypeChecker-backed path retains constructor
identity through reassignment-free aliases such as `const View = DataView`,
`const Buffer = ArrayBuffer`, and `const Bytes = Uint8Array`; mutable aliases
are not authenticated even if their static signature is unchanged. Mutable
resource aliases or interprocedural aliases, conditional
transfer, resize transitions, and SharedArrayBuffer concurrency are not yet
modeled.

TypedArray `.set(source, offset)` produces `bulk-copy-bounds`, requiring
`offset >= 0` and `offset + source.length <= target.length`. Bounded source and
target types supply their maximum lengths. An unbounded source remains unknown.
Copying between different element domains, such as Uint32 into Uint8, produces
`bulk-copy-values` instead of silently accepting per-element narrowing.

Bounded `subarray` and `slice` calls also emit window provenance. `subarray`
is recorded as sharing its source backing store, while `slice` is recorded as
allocating a copied backing store. Literal in-range windows retain exact start
and end offsets; dynamic offsets retain the backing relationship but report an
unknown range. The syntax-only checker labels this evidence `inferred` because
it cannot authenticate method identity. The TypeChecker-backed entry point authenticates the standard-library method,
labels supported windows `verified`, and emits declaration-derived source and
backing region IDs. A shared window reuses its source backing region; a copied
window receives a distinct backing region. Same-spelled user methods remain
`unknown`. Ownership analysis consumes the same builtin semantic identity:
transferring a source invalidates element reads and writes through nested
`subarray` windows and immutable aliases, but not through a copied `slice`.
This is not yet a proof of overlap-sensitive writes or escaping-view safety.

The Program-backed checker authenticates standard `ArrayBuffer.prototype.resize`
and updates later `new DataView(...)` backing obligations through immutable
buffer aliases. `BoundedArrayBuffer<Max>` describes a resizable buffer whose
current length is not known until a supported resize. On a normally returning,
literal resize within `Max`, shrinking below `offset + length` is a
counterexample and growing enough verifies the constructor. A dynamic resize
length produces `unknown`. Calling `resize` on `FixedArrayBuffer<N>` has no
verified normal completion because that contract denotes a non-resizable
buffer. The builtin catalog records receiver mutation plus possible `TypeError`
and `RangeError`. For locally constructed DataViews, later literal resizes are
also connected through the backing region: fixed-length views become invalid
when their complete span no longer fits, while length-tracking views use the
new remainder after their byte offset. Dynamic resizes produce `unknown`.
The same rule applies to locally constructed `Uint8Array` and `Uint32Array`
views. Fixed-length views require their complete byte span to survive a resize;
length-tracking views derive their new element bound from the remaining bytes,
including each element type's byte width. Immutable aliases retain the same
backing identity. The TypeChecker-backed path authenticates the standard typed
array constructor instead of matching its spelling.

For an authenticated local `new ArrayBuffer(initial, { maxByteLength })`, both
literal values become backing-state evidence. This proves views against the
initial byte length before any resize and rejects a normally returning path
whose resize exceeds the actual `maxByteLength`, even when the branded type has
a wider upper bound. A shadowed same-spelled constructor does not produce this
evidence.

Resize facts use a conservative control-flow boundary. A resize inside an
`if`, `switch`, loop, conditional expression, or `try`/`catch` region does not
become one unconditional post-state after the join. Accesses through a view
created before that control-dependent resize report `unknown`. A later
unconditional literal resize re-establishes an exact current length.

This slice does not yet read non-literal runtime `maxByteLength`, prove dynamic resize
success, cover every typed-array element domain, or track views that escape the
analyzed function.

For a bounded input, the checker also understands the conventional padding
allocation expression:

```ts
function allocatePadding(
  input: BoundedUint8Array<1048576>,
): BoundedUint8Array<1048640> {
  return new Uint8Array((input.length + 9 + 63) & ~63)
}
```

`input.length` contributes `0..1048576`. Because the intermediate value stays
inside non-negative signed-32 range, `& ~63` is interpreted as alignment to a
64-byte boundary and yields an upper bound of `1048640`.

## Machine-number helpers

Uneffect exports literal machine-domain constants for contracts and constant
folding:

```ts
U8_BITS  // 8
U8_MAX   // 255
U32_BITS // 32
U32_MAX  // 4294967295
I32_MIN  // -2147483648
I32_MAX  // 2147483647
F32_BITS // 32
```

Ordinary module-level TypeScript constants are also evaluated when they are
composed from numeric literals, other known constants, arithmetic, bitwise
operators, shifts, or `as const`. This supports both expressions and dependent
type queries:

```ts
const MAX_INPUT_BYTES = 1 << 20
const MAX_PADDED_BYTES = MAX_INPUT_BYTES + 64
const BLOCK_BYTES = 64

type Input = BoundedUint8Array<typeof MAX_INPUT_BYTES>
type Padding = BoundedUint8Array<typeof MAX_PADDED_BYTES>
```

Algorithm-specific constants remain ordinary user code. Uneffect does not make
SHA-256 parameters global builtins merely to satisfy a verifier.

Readonly machine-domain tables use `u8Table` or `u32Table`. These helpers keep
the tuple length in the TypeScript type, validate every value at runtime, and
give the static checker one explicit contract boundary:

```ts
const SHA256_K = u32Table([
  0x428a2f98,
  0x71374491,
  // ...
] as const)

/* uneffect:requires round < SHA256_K.length */
function constantForRound(round: Nat): U32 {
  return SHA256_K[round]!
}
```

The verifier emits separate `constant-table-values` and
`constant-table-index` obligations. A table whose declaration contains an
out-of-domain value is not trusted as a source of `U8` or `U32` values.
`verifyTypedArraySafetyInProgram` carries the verified table contract through
relative named imports, local aliases, star exports, and named barrel
re-exports. Namespace imports such as `Tables.SHA256_K[index]` are also
resolved. Its in-memory project resolver also follows package `exports`
conditions (`types`, `import`, `default`, then `require`) for packages supplied
in the project file map. It does not emulate every Node resolution fallback.

A table may be generated by spreading already verified tables of the same
domain. Its exact length is the sum of the input lengths plus literal elements:

```ts
const PREFIX = u32Table([1, 2] as const)
const SUFFIX = u32Table([3, 4] as const)
const ROUND = u32Table([...PREFIX, ...SUFFIX, 5] as const)
```

A bounded index generator is also evaluated exhaustively when its exact shape
is `Array.from({ length: constant }, (_, index) => integerExpression)`. The
Program-backed checker accepts an immutable callable alias of the standard
`Array.from` by declaration identity and rejects mutable or same-shaped local
callables. The
length is capped at 10,000 analysis steps, and the callback expression may use
only the existing constant-expression fragment. Other callbacks remain
unresolved. This static evidence is paired with the `u8Table`/`u32Table`
runtime validator; it is not permission to execute arbitrary generator code in
the analyzer.

Arbitrary table-producing code is not executed during analysis. Package export
maps and additional generated forms remain unresolved rather than guessed.

Lowercase helpers make an intentional ECMAScript coercion visible in source:

```ts
u8(257)          // 1: ToUint8-style modulo conversion
u32(-1)          // 4294967295: ToUint32
i32(0xffffffff)  // -1: ToInt32
f32(1 / 3)       // Math.fround(1 / 3)
```

They return the branded `U8`, `U32`, `I32`, and `F32` domains. They are not
validators: `parseU8(257)` and `parseU32(-1)` reject instead of wrapping.
`u8Table` and `u32Table` are validators rather than coercions: they reject an
invalid element instead of applying modulo conversion.
`Float` also remains the finite-number validation domain, while `F32` denotes
the result of `Math.fround` and can represent the IEEE-754 non-finite results
that operation produces. The typed-array checker recognizes `u8`, `u32`,
`toU32`, and `i32` as explicit range-changing operations.

## Semantic integer casts

Numeric ranges carry integer information separately from lower and upper
bounds. A fractional value is therefore rejected for a U8/U32 write even when
it lies inside the numeric bounds. The checker recognizes the standard
`Math.floor`, `Math.ceil`, `Math.round`, and `Math.trunc` operations and follows
their result through inferred `const` locals:

```ts
function write(output: BoundedUint8Array<1>, input: U8) {
  const integer = Math.floor(input)
  output[0] = integer
}
```

The TypeScript type of `integer` remains `number`; the integer range is an
Uneffect refinement layered on top of normal TypeScript inference. A parameter
that shadows `Math` is not treated as the builtin. Full alias-aware identity is
reserved for the TypeChecker frontend integration.

Build integrations that already own a `ts.Program` should call
`verifyTypedArraySafetyInTypeScriptProgram`. That path accepts these operations
only when the selected method symbol is declared by TypeScript's standard
library, so a structurally compatible local object named `Math` is not trusted.
The source-only API remains a lower-cost adoption path with conservative name
checks. The TypeChecker path follows direct and multi-hop `const` aliases,
imported aliases, `const { trunc } = Math` destructuring, and properties of
`as const` objects by symbol identity. A function parameter is specialized only
when every resolved call site supplies the same builtin operation. Mutable
bindings, writable object properties, unresolved calls, or mixed builtin
arguments remain unproved rather than inheriting stale integer-cast evidence.

## Explicit trust escape hatch

When a proof cannot be completed but an external review or validator establishes
the invariant, a function may carry a reason-bearing escape hatch:

```ts
/* uneffect:trust trust typed-array wire-format-v1 */
function decode(output: BoundedUint8Array<1>, value: number) {
  output[0] = value
}
```

An unresolved or contradicted typed-array obligation becomes `trusted`, not
`verified`, and retains the reason in the result. Its ordinary diagnostic is
suppressed, but the obligation remains visible for audits. Prefer the narrower
statement form where possible:

```ts
function decode(output: BoundedUint8Array<2>, tag: number, payload: number) {
  /* uneffect:trust trust typed-array:u8-write packet-tag-v1 */
  output[0] = tag
  output[1] = payload // still requires an independent proof
}
```

`typed-array:<kind>` selects only one obligation kind generated by the attached
statement. Without the suffix, every unproved typed-array obligation on that
statement is trusted. A comment on the function remains the explicit
function-wide fallback for gradual adoption. Verified obligations stay
`verified`, so an unnecessary trust marker cannot manufacture proof evidence.
Every used escape hatch is emitted into the project assumption ledger with its
exact statement span and review metadata. Trust is not a generic Lean-style
`sorry` and never authorizes proof-only optimizer rewrites.

## Standard method effects

All standard numeric and BigInt TypedArray owners share the builtin callback
and mutation catalog. `forEach`, `map`, `filter`, `find`, `some`, `every`, and
the reduce families invoke callbacks synchronously with element, index, and
receiver invocation shapes. An explicit `thisArg` is projected to its stable
region. Runtime element/index identities remain unknown unless another proof
connects them, while the collection argument maps back to the actual receiver.

`sort` mutates its receiver and composes its optional comparator; `toSorted`
returns a fresh array. `copyWithin`, `fill`, `reverse`, and `set` mutate the
receiver. `slice`, `toReversed`, and `with` return fresh typed arrays. These are
Effect/call-graph facts and complement, rather than replace, bounds, element
domain, backing-buffer, and transfer obligations.

## SHA-256-style bitwise arithmetic

The checker interprets bitwise operators with ECMAScript 32-bit semantics,
separately from the unbounded-integer Z3 lowering. For example:

```ts
function emit(output: BoundedUint8Array<32>, word: U32) {
  output[0] = word >>> 24              // 0..255
  output[1] = (word >>> 16) & 0xff     // 0..255
}

function rotate(words: BoundedUint32Array<64>, word: U32) {
  words[0] = ((word >>> 7) | (word << 25)) >>> 0 // U32
}
```

`>>>` produces an unsigned range, while `<<`, `>>`, `|`, and `^` may produce a
signed int32 result. SHA-256 rotations and modular additions therefore need an
explicit `>>> 0` or the exported `toU32` normalization before a checked U32
write. A bare rotate expression is diagnosed instead of relying silently on
Uint32Array coercion.

Bounded indexed writes additionally produce `index-bounds` obligations. A
dynamic shift produces an independent `shift-count` obligation requiring
`0 <= shift <= 31`; Uneffect does not silently accept JavaScript's modulo-32
masking. Both can be discharged by `Nat` plus a `requires` upper bound:

```ts
/* uneffect:requires index < 32 && shift <= 31 */
function write(bytes: BoundedUint8Array<32>, index: Nat, word: U32, shift: Nat) {
  bytes[index] = (word >>> shift) & 0xff
}
```

This is enough to verify representative SHA-256 word rotations, digest-byte
serialization, padding allocation/copy, and the canonical word schedule. It is
not yet one composed proof of a complete implementation: non-canonical control
flow and interprocedural propagation of array refinements remain.

The canonical ascending loop `for (let i = start; i < bound; i++)` contributes
`i >= start` and its continuation condition to every contained indexed access.
This proves the SHA-256 schedule accesses `i`, `i - 2`, `i - 7`, `i - 15`, and
`i - 16` for `start = 16` and `bound = 64`; an access at `i + 1` retains a
counterexample. `toU32(sum)` is recognized as an explicit modular-addition
boundary and yields the full unsigned 32-bit range.

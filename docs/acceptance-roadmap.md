# End-to-end acceptance roadmap

The executable product roadmap lives in
`test/acceptance-roadmap.test.ts`. All current product scenarios are enabled;
the narrower limitations below remain tracked in `TODO.md`.

The target is not a collection of unrelated linters. It is one gradual
contract layer for existing TypeScript:

1. Ordinary TypeScript remains valid and its JavaScript emit is unchanged.
2. `uneffect:` comments add capability effects, invariants, and temporal
   contracts incrementally.
3. Builtin and user-defined effects share a scoped finite-set lattice.
4. User validators can attach proof-backed specializations such as an
   at-most-once Datadog sink bound, including Generator/AsyncGenerator
   composition at the application entrypoint.
5. Synchronous throws, Promise rejection ownership, resource cleanup, Worker
   transfer, and event-loop scheduling contribute to one ordered neutral IR.
6. Z3 and Quint produce reviewable, dependency-bound evidence. Unsupported or
   unknown results never become proofs.
7. Runtime assertions are an optional fallback for the supported source
   expression language.
8. Compression and mangling consume valid proof artifacts but do not trust
   stale evidence.
9. TypeScript and Corsa frontends must produce equivalent neutral IR.
10. Native Promise, Uneffect, and Effect TS examples are compared against the
   same observable contract.
11. External dogfood reports false positives, unknown summaries, annotation
    density, and frontend/verifier cost.

## Working rule

New implementation work starts by adding or tightening a relevant acceptance
test, observing Red, implementing the smallest coherent vertical slice, then
making it Green and refactoring. Narrow unit tests may be added underneath that
acceptance test, but they do not replace its end-to-end completion condition.

The acceptance file uses runtime public-API lookup so a missing product entry
point fails with a direct diagnostic instead of a secondary TypeScript error.

Property generation covers scalar `Int`, `Nat`, `U8`, `U32`, and `I32`,
bounded `Uint8Array`/`Uint32Array`, and scalar or literal union parameters. It
emits and executes test-only Vitest source, filters the restricted `requires`
language, checks `ensures`, and shrinks both numeric values and array structure.
Scalar counterexamples retain the `v1` replay format; JSON-safe arrays and
literals use `v2`. Passing `counterexampleDirectory` also makes standalone
generated Vitest files persist their minimized `v2` artifact and try that
artifact before newly generated candidates on the next run. Array generation
is resource-bounded to 4096 elements by
default and can be raised with `arrayLengthCap`; therefore a larger declared
type maximum is not silently claimed as an exercised upper edge. Generator
narrowing recognizes conjunctive integer comparisons and seeds values at and
next to their boundaries before broad scalar edges. Disjunctions and
single-variable affine comparisons are normalized syntactically. Conjunctive
positive-modulo refinements with a canonical nonnegative residue snap those
boundary seeds to the matching congruence class; for example,
`shard >= 0 && shard < 1024 && shard % 16 === 0` yields `0`, `16`, and `1008`.
Ranges and congruences remain local to each disjunct through a DNF expansion
bounded at 32 branches. Multiple compatible positive congruences are combined
with generalized CRT, including non-coprime moduli; inconsistent systems and
LCMs beyond JavaScript's safe-integer range fall back without synthesized
aligned hints. A negative remainder is normalized only when the branch proves
the parameter is strictly negative, preserving JavaScript's dividend-signed
`%` behavior. Unknown-sign negative remainders, mixed-sign remainder systems,
negative moduli, and larger DNF expansions remain on runtime filtering or the
opt-in Z3 path. For affine
equalities between scalar parameters, such as
`y === x + 1 && z === y + 2`, the generator propagates boundary hints through
the relation graph and runs valid correlated tuples before Cartesian samples.
The opt-in asynchronous Z3 generator also enumerates a caller-bounded number of
models for nonlinear scalar refinements, bounded U8/U32 arrays, and closed
record type literals whose required fields use scalar machine domains. For arrays,
the supported fragment includes `.length`, literal-index element reads, and
dynamic scalar indices over the finite modeled capacity. Dynamic reads lower
to finite SMT selection and add in-bounds generation constraints; the emitted
test still rechecks the original JavaScript precondition. All modeled lengths
and elements receive their machine-domain bounds. Closed nested records are
flattened into solver leaves and reconstructed as ordinary objects. Scalar
optional fields use separate SMT presence bits, so absence is not conflated
with a zero value, and shrinking can omit them. `BoundedSet<T, N>` uses a
finite solver universe assembled from literal `has(...)` observations and
machine-domain edge values; `.size` and literal membership are constrained as
SMT membership bits, then materialized as a native `Set` in generated tests.
`BoundedMap<K, V, N>` uses the same finite key universe plus guarded scalar
value variables. Counterexamples persist as parallel JSON-safe `keys` and
`values` columns, while generated tests materialize native `Map` instances;
`get(k)` also asserts key presence. Optional object-valued fields share one
parent presence bit across every nested scalar leaf, preventing impossible
partially-present objects. Optional objects containing independently optional
children are still rejected rather than assigned ambiguous presence semantics.
The solver minimizes a shared structural-size objective over scalar magnitudes,
array lengths/elements, record leaves, and collection membership/value state.
Because nonlinear Z3 optimization can return a non-minimal local result, Uneffect
then repeats ordinary SAT checks under a strict smaller-size bound until `unsat`.
The generator injects satisfying tuples before Cartesian samples and reports an unsatisfiable
precondition rather than pretending that it generated coverage. When a correlated candidate fails, the
runner first compares known tuples by structural/numeric size and rechecks the
whole precondition, allowing dependent values to shrink together before the
ordinary coordinate shrink. It does not yet synthesize new solver-backed shrink
candidates during a failure; it reuses the size-ordered models enumerated before
execution as constraint-preserving joint candidates.
Model-checker counterexamples can be replayed through explicit TypeScript
refinement adapters; arbitrary application bindings are not inferred.

The adoption KPI is measured over a checked-in controlled corpus. The public
machine-readable report includes false-positive and unknown-summary rates,
annotation density, enforced boundaries, measured frontend and full project
verifier time, diagnostics, and builtin declaration drift. Its reported
false-positive rate is not an estimate for arbitrary external TypeScript
applications. As a phase-zero external compatibility check, the pinned
`effect@3.22.1` `Function.ts` import graph loads three implementation source
files and produces at least 40 inferred summaries with no unknown summaries,
diagnostics, or builtin declaration drift. The same report records its source
and function counts and external frontend time. This is deliberately not
reported as proof that Effect is pure or correct: inference-only mode has no
reviewed external annotation boundary. Reviewed application adapters below
provide the constraint-bearing verifier coverage.

A separate checked-in adapter imports `pipe` from the same external package
and declares `/* uneffect: effect Console */` on its application boundary. The
boundary verifies with the exact inferred Console authority. A negative control
replaces it with `FsRead<"$CWD/**">` and must report both the missing Console
and unused FsRead declarations. This is a meaningful capability constraint over
an application adapter; the following Z3 and Quint adapters add formal backend
coverage, while the consolidated report measures the full controlled project
verification pipeline.

The Effect adapter also contains `increment`, whose restricted Hoare contract
is lowered through `effect/Function.pipe` and discharged by Z3. The lowering is
intentionally narrow: `pipe` must be a named import (aliases are retained) from
the exact `effect/Function` module, and every stage must be an inline unary
expression callback. A local function merely named `pipe`, block callbacks,
and arbitrary external calls remain unsupported non-proofs. The positive
adapter verifies `result > value`; replacing `current + 1` with `current - 1`
produces a counterexample. This adds no production runtime code.

The temporal external adapter schedules a timer whose inline callback computes
through Effect `pipe` and dynamically queues a microtask. Uneffect extracts the
timer task and nested microtask, generates the Web event-loop Quint model, and
verifies `eventLoopSafe`. Named callbacks with `temporal_requires` and
`temporal_ensures` are now composed into the same queue transition. Project
verification also checks declared state safety properties in that product.
Inline callbacks and indirect callback aliases do not yet carry summaries.

Project verification exposes Z3 contract artifacts, typed-array results,
definite ownership diagnostics, and explicit `assert parameter: Schema`
Valibot instrumentation in one result. It invalidates a fixed-buffer DataView
constructor proof when a builtin Worker/clone transfer definitely detached the
same direct resource first. This is ordered cross-domain evidence, not general
path-sensitive alias analysis. The runtime assertions remain separate clauses:
an arbitrary Hoare `requires` or `ensures` expression is not automatically
converted into a runtime check.

The temporal project-verification slice extracts Web scheduling from Uneffect
TypeScript and applies named callback summaries atomically in the corresponding
timer, microtask, animation-frame, or scheduler transition. A due callback with
an unsatisfied precondition violates `eventLoopSafe`; it is not treated as safe
merely because its transition is disabled. `telemetry-once.ts` dogfoods this by
proving one queued send and finding a counterexample after the send is queued
twice. The current product remains bounded and callback-name based: it does not
prove callback bodies, alias identity, liveness properties, or environment I/O.

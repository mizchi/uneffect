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
literals use `v2`. Array generation is resource-bounded to 4096 elements by
default and can be raised with `arrayLengthCap`; therefore a larger declared
type maximum is not silently claimed as an exercised upper edge. Generator
narrowing recognizes conjunctive integer comparisons and seeds values at and
next to their boundaries before broad scalar edges. Disjunctions and
single-variable affine comparisons are normalized syntactically. For a single
affine equality between scalar parameters, such as `y === x + 1`, the generator
derives correlated tuples from the source parameter's boundary hints and runs
them before the Cartesian samples. Multiple dependent relations, nonlinear
arithmetic refinements, and solver-derived values remain unimplemented.
Model-checker counterexamples can be replayed through explicit TypeScript
refinement adapters; arbitrary application bindings are not inferred.

The adoption KPI is measured over a checked-in controlled corpus. Its reported
false-positive rate is not an estimate for arbitrary external TypeScript
applications. As a phase-zero external compatibility check, the pinned
`effect@3.22.1` `Function.ts` import graph loads three implementation source
files and produces at least 40 inferred summaries with no unknown summaries,
diagnostics, or builtin declaration drift. A same-machine exploratory run took
103.16 ms. This is deliberately not reported as proof that Effect is pure or
correct: inference-only mode has no reviewed external annotation boundary and
runs no verifier. External adapter boundaries with meaningful constraints and
verifier timing remain required.

A separate checked-in adapter imports `pipe` from the same external package
and declares `/* uneffect: effect Console */` on its application boundary. The
boundary verifies with the exact inferred Console authority. A negative control
replaces it with `FsRead<"$CWD/**">` and must report both the missing Console
and unused FsRead declarations. This is a meaningful capability constraint over
an application adapter, but it still does not exercise a Z3 or Quint obligation;
external verifier timing remains open.

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
verifies `eventLoopSafe`. The current guarantee is queue phase/FIFO safety only:
the callback's numeric `pipe` semantics and an application-specific temporal
invariant are not yet composed into that model.

The first project verification slice exposes Z3 contract artifacts and
explicit `assert parameter: Schema` Valibot instrumentation in one result.
These are separate clauses in the same source file: it does not yet claim that
an arbitrary Hoare `requires` or `ensures` expression has been converted into
a runtime check.

The first temporal project-verification slice extracts Web scheduling from
Uneffect TypeScript, generates a Quint `web-event-loop` model, and runs its
`eventLoopSafe` property. Applying callback `temporal_ensures` updates inside
those queue transitions requires a product model and remains an explicit TODO;
the event-loop proof alone is not evidence for callback state contracts.

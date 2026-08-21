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

Property generation currently covers scalar `Int`, `Nat`, `U8`, `U32`, and
`I32` parameters. It emits test-only Vitest source, filters the restricted
`requires` language, checks `ensures`, shrinks toward zero, and can persist a
versioned replay artifact. Bounded arrays, unions, and structure-aware
shrinking are not implemented.

The adoption KPI is measured over a checked-in controlled corpus. Its reported
false-positive rate is not an estimate for arbitrary external TypeScript
applications. External-project evaluation remains required.

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

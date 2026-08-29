# Changelog

All notable changes to Uneffect are documented in this file.

## 0.2.1 - 2026-08-30

### Added

- Added the stable `generateTemporalModel` facade for Web and Node temporal
  projection, including explicit projection metadata and exclusions.
- Co-verify a selected root's `using` and `await using` lifecycle through the
  temporal project pipeline.
- Added a bounded resource/host product that requires straight-line
  `await using` disposal to resume during a microtask checkpoint.

### Public API

- The recommended public temporal entry is `generateTemporalModel` from
  `@mizchi/uneffect` or `uneffect spec temporal` from the CLI.
- Backend-specific async, Promise, event-loop, and resource Quint generators
  are available from `@mizchi/uneffect/experimental`. They are not covered by
  compatibility guarantees.
- This placement finalizes the intended 0.2 public surface. Code importing a
  low-level generator from the 0.2.0 package root must migrate to the
  `experimental` subpath or, preferably, the stable facade.

### Safety boundary

Promise ownership is not yet part of the combined temporal projection.
Conditional or looped resource acquisition and arbitrary callback/resource
interleavings remain explicit exclusions. A verified bounded projection is not
a proof of the complete JavaScript event loop.

## 0.2.0 - 2026-08-29

### Changed

- Made `uneffect:<dialect>` the explicit annotation header, including
  `uneffect:capability`, `uneffect:contract`, `uneffect:temporal`, and
  `uneffect:react-component`.
- Reject untagged annotations and directives placed in the wrong dialect,
  reducing ambiguity between Hoare-style contracts and temporal models.
- Migrated documentation, examples, fixtures, benchmarks, and frontend parity
  coverage to the compact one-line annotation syntax.

### Safety boundary

Uneffect 0.2 remains experimental. A successful check only supports the
specific emitted claims and analyzed domains; it is not a whole-program
JavaScript verification result.

## 0.1.0 - 2026-08-29

First experimental minor release.

### Added

- Gradual TypeScript effect declarations with scoped filesystem, network, DOM,
  storage, mutation, throw, and user-defined capabilities.
- Hoare-style preconditions, postconditions, invariants, Z3 evidence, optional
  runtime assertions, and property-test generation with shrinking.
- Promise ownership, floating rejection, explicit resource management, timer,
  event-loop, and Promise combinator analyses.
- Neutral temporal IR with bounded Z3 and Quint projections, including Node
  lease, callback cardinality, and selected React lifecycle models.
- Typed-array bounds and integer-domain checks for selected binary and hashing
  code patterns.
- Corsa/tsgo frontend interchange, versioned semantic registries, declarative
  semantics modules, and evidence/assumption ledgers.
- Browser boundary checks for static external scripts, network authority,
  cookies, Web Storage, DOM operations, and the initial W3C TrustedScript sink
  fragment.

### Safety boundary

Uneffect 0.1 is an additional fail-closed review and CI layer for explicitly
selected, documented fragments. It is not a whole-program JavaScript verifier,
sandbox, authorization system, or replacement for runtime validation. Read
`docs/stability.md`, `docs/assurance-boundaries.md`, and
`docs/feature-matrix.md` before treating an emitted claim as assurance.

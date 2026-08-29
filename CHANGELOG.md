# Changelog

All notable changes to Uneffect are documented in this file.

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

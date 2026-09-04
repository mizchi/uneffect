# Changelog

All notable changes to Uneffect are documented in this file.

## 0.3.0 - 2026-09-04

### Added

- Added versioned package contract artifacts for effects, synchronous and
  Promise completions, callbacks, returned callables, module initialization,
  and resource lifecycles. Consumer checks bind them to exact exports,
  declarations, runtime artifacts, compiler identity, and trust provenance.
- Added a shared acquire/use/borrow/consume/release/transfer resource model for
  Web streams, fetch bodies, Node servers and file handles, WebSockets,
  iterators, `using`/`await using`, and package-defined resources.
- Added broader exception-aware Hoare composition for synchronous and async
  scalar producers, Promise forwarding, catch/finally routing, assertion
  arguments, and persisted package summaries.
- Added general iterable and async-iterable effect parameters, finite generator
  expansion, Promise combinator rejection evidence, and async-generator
  delegation.
- Added declarative builtin semantic catalogs covering common JavaScript, DOM,
  Web, and Node APIs, including filesystem authority inferred from open flags.
- Added dogfood checks for Uneffect's leaf utilities and filesystem boundaries.
- Added a versioned inferred-effect baseline for low-annotation adoption. CI can
  now reject new capabilities, effectful new functions, and newly unknown calls
  without requiring a source declaration to predict the regression.
- Added an explicit release-please and npm OIDC Trusted Publishing path with a
  tag/package-version guard.

### Changed

- Made Corsa plus Oxc on the pinned TypeScript 7 native compiler the default
  check frontend. The separately pinned TypeScript 6 package remains the
  compatibility path for proof domains that still require a JavaScript Program.
- Narrowed the package-root API to durable numeric helpers and high-level
  checking, temporal, property-generation, extension, and runtime facades.
  Low-level solver, CFG, IR, optimizer, and backend-specific generators now
  require `@mizchi/uneffect/experimental` and carry no compatibility promise.
- Unified public comment directives under the ordinary `uneffect:` surface;
  internal capability, contract, async, resource, and refinement proof engines
  are no longer selected as separate user-facing modes.
- Connected Promise ownership, cancellation, external completion, callbacks,
  event-loop scheduling, and explicit resource management to the shared
  temporal and resource transition IR.
- Standard JavaScript operations now resolve by authenticated TypeChecker
  declaration identity through reassignment-free aliases. Mutable aliases and
  same-shaped user implementations fail closed instead of inheriting builtin
  semantics.
- Expanded fresh-result, hidden getter/coercion, mutation, and callback effects
  for Array, Object, Reflect, JSON, collection constructors, and non-mutating
  copy operations.
- Isolated the in-memory verifier's package contract from consumer source paths,
  preventing files such as `src/numeric.ts` from shadowing Uneffect's own
  numeric domains. Contract-free sources also bypass solver fact construction,
  substantially reducing project-check latency.
- Corrected the adoption corpus contract for the transitive
  `JSON.parse` `Throw<SyntaxError>` effect and now fail closed on unproved
  external generator consumption.
- Kept per-test process isolation for the CI WASM solver while making the local
  native-Z3 release gate file-isolated and removing its duplicate dogfood run.

### Safety boundary

Uneffect 0.3 remains an experimental, gradual checker. Package contracts may
contain reviewed assumptions and do not prove third-party implementations.
Resource and temporal checks cover only the emitted finite projections;
resource ownership contracts do not imply that the contracted call is
effect-free; without a separate effect contract such calls remain unknown.
Dynamic dispatch, proxies and prototype mutation, arbitrary heap aliasing,
complete Promise/event-loop timing, native/Wasm internals, and general
floating-point correctness remain unsupported or unknown. A green check is not
a whole-program JavaScript verification result.

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

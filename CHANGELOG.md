# Changelog

All notable changes to Uneffect are documented in this file.

## Unreleased

## [0.6.0](https://github.com/mizchi/uneffect/compare/v0.5.1...v0.6.0) (2026-09-29)


### Features

* add conditional module initialization v2 ([bd44d53](https://github.com/mizchi/uneffect/commit/bd44d5386c09e02346de32eb5a090184f1250780))
* add Corsa/Oxc CFG lint and decouple spec authoring from compiler ([a612862](https://github.com/mizchi/uneffect/commit/a612862d4aba94396aeb9ee8778531b12a8af0a8))
* add inferred effect regression baselines ([35ac250](https://github.com/mizchi/uneffect/commit/35ac2507fb95a7261786511ceeddd71153fbb6af))
* add native awaited-type and build-output migration gates ([7e42e0c](https://github.com/mizchi/uneffect/commit/7e42e0c3ef8b61a5d724bc80f53f6abe993ab5bd))
* add native registry linting and fix dogfood regressions ([20eed6b](https://github.com/mizchi/uneffect/commit/20eed6bca586d65d24041729b8fc06427c8db508))
* bind native workspace summaries to authenticated calls ([97c50e4](https://github.com/mizchi/uneffect/commit/97c50e4c92f282dcc6cbbe53c90575008cb90c14))
* expose experimental module-order v2 in CLI ([eac0aff](https://github.com/mizchi/uneffect/commit/eac0aff4b9b2ec4caf84bd6c3ca95019383f3df2)), closes [#70](https://github.com/mizchi/uneffect/issues/70)
* extend native effect propagation and bounded contract proofs ([f20c2ab](https://github.com/mizchi/uneffect/commit/f20c2ab93a15c4f67b69c7ff4c6e6e8a5d431807))
* harden 0.3.0 API and dogfood gates ([82a063a](https://github.com/mizchi/uneffect/commit/82a063afab63578741c953bae626a742f6187514))
* harden syntax and control-flow artifacts ([a013d3b](https://github.com/mizchi/uneffect/commit/a013d3b7f5f41c43e6bbfed387e275561423458f))
* lower Promise try joins through CFG ([e2f79a9](https://github.com/mizchi/uneffect/commit/e2f79a9ea5b0ab8c9400138b6a42ad4ed5d5967e))
* migrate specification and module analysis to Corsa/Oxc ([657100a](https://github.com/mizchi/uneffect/commit/657100adac7ea2e6a8bbc359cf3a26c8742fd9ca))
* promote module initialization ordering to supported API ([09efc25](https://github.com/mizchi/uneffect/commit/09efc257cea1ef889239cc25353cccd3c15c5f03))
* promote workflow and impact analysis to supported APIs ([c9be5f8](https://github.com/mizchi/uneffect/commit/c9be5f8a6c3b537a89e7211339ed04aaa97ee43b))
* prototype CFG workflow barriers and dependency impact analysis ([4637620](https://github.com/mizchi/uneffect/commit/4637620b6c926e8a42d82f1606aa7470ed3d8086))
* prune static Promise switch entries ([6f22a62](https://github.com/mizchi/uneffect/commit/6f22a6202ab1b2fba29bb0ff6637db520cc581ed))
* refine contract reachability with native Corsa type facts ([7589ca0](https://github.com/mizchi/uneffect/commit/7589ca0375550d950071ea73333faafce198d8ee))
* refine native arithmetic range narrowing ([c8aec45](https://github.com/mizchi/uneffect/commit/c8aec450b0a06dd33261be512f69d62670d301c9))
* refine semantic control flow ([1976305](https://github.com/mizchi/uneffect/commit/19763051d0985a4271cb15fad9fc7dd08ea4859c))
* stabilize Corsa and temporal contracts ([1589447](https://github.com/mizchi/uneffect/commit/1589447b4b5e36723e1f6735fa4db089883e5cc2))
* validate fixed-point CFG topology ([e94bf31](https://github.com/mizchi/uneffect/commit/e94bf315c0a026326083c34fe13f004cd5fbee8c))
* verify bounded contract bodies with Corsa and shared solver ([b77d95d](https://github.com/mizchi/uneffect/commit/b77d95d08065eebf9cc0c3181c9626aca88d13cb))
* verify native workspace build outputs in reference order ([21ef476](https://github.com/mizchi/uneffect/commit/21ef4760c562da717f9f232913a35d24ba87b94c))


### Bug Fixes

* evaluate Promise switch case tests ([b03a8ef](https://github.com/mizchi/uneffect/commit/b03a8ef50bd64827591b41ebee9e0689a0f20e9c))
* keep fresh local object aliases private in release 0.5.1 ([bc82420](https://github.com/mizchi/uneffect/commit/bc82420a08206e169480a71562cef01bdbd79a16))
* keep local collection reads private and bound recursive mutations ([560b1b2](https://github.com/mizchi/uneffect/commit/560b1b269fb5521840e6303f1c93aa19ed3003e6))
* keep parser metadata load analyzable ([38baa18](https://github.com/mizchi/uneffect/commit/38baa182906fc71835ba1f456f12290f31db71cc))
* preserve Promise call evaluation order ([76353b3](https://github.com/mizchi/uneffect/commit/76353b31ed20b84321757f67d30c088f4d771729))
* preserve Promise call target order ([97b51f8](https://github.com/mizchi/uneffect/commit/97b51f8cb36e550f5ab5a0339d1ff93ed64fb9c7))
* preserve Promise constructor order ([2e49264](https://github.com/mizchi/uneffect/commit/2e492646f9114026418e790a9965f846ae081203))
* preserve Promise initializer order ([9043161](https://github.com/mizchi/uneffect/commit/9043161440611f1f2383392f9c65365d4a3f5190))
* preserve switch break ownership in CFG ([3c68eaa](https://github.com/mizchi/uneffect/commit/3c68eaae58e638d38622a937c7bbaa96f13e2574))
* preserve syntax facts v1 while proving literal split ([0a61f72](https://github.com/mizchi/uneffect/commit/0a61f72f108248fc13cdd4d2b926671a69aa7bb0))
* require actual resumption in conditional module proofs ([c8a2315](https://github.com/mizchi/uneffect/commit/c8a2315d48f9f9c229ff14971d88a5f280c050e0))
* require runtime evidence for switch exhaustiveness ([b4f57fa](https://github.com/mizchi/uneffect/commit/b4f57fafa5499145e584bad44632106285e21e3e))
* respect throw prefixes in Promise CFG ([39bf266](https://github.com/mizchi/uneffect/commit/39bf266381679de6a0f3b05ad186ee22a1503b47))
* respect throw prefixes in Promise statements ([55b1d6a](https://github.com/mizchi/uneffect/commit/55b1d6a7209bd80478fd241f88deb4151293a58c))
* retain Promise ownership on CFG back edges ([cd0ad02](https://github.com/mizchi/uneffect/commit/cd0ad020648e6a77d2ac1024e21ffa1bb0c3d3a2))
* route throwing if conditions through CFG ([d441129](https://github.com/mizchi/uneffect/commit/d441129c5643b4f77af71eca757366e2340e105a))
* surface async safety in project verification ([27dac82](https://github.com/mizchi/uneffect/commit/27dac82b011fc96d386a369bc2a1d9d35765dd67))

## [0.5.1](https://github.com/mizchi/uneffect/compare/v0.5.0...v0.5.1) (2026-09-29)

### Changed

- Bundle the legacy TypeScript 6 compiler into the published JavaScript so
  consumers no longer need to install it as a peer dependency.

### Added

- Support `%` in bounded signed remainder contract proofs.
- Keep writes to freshly constructed local arrays and objects private until
  their identity escapes, including local aliases of objects.
- Prove a primitive string's `split` result fresh when the separator is a
  string literal.

### Fixed

- Preserve the published syntax facts v1 shape while checking literal `split`.
- Keep recursive mutation-region propagation bounded and recognize non-escaping
  array reads and copies during local construction.

## 0.5.0

### Changed

- Treat methods and iteration reached only through structural `ReadonlyArray`,
  `ReadonlyMap`, or `ReadonlySet` types as unresolved user code. For arrays,
  literals and immutable bindings to those literals retain their known origin.
  This narrows inferred claims and may increase `unknown` results for readonly
  collection parameters and properties.

### Fixed

- Run the Z3 CI tier with checksum-pinned native Z3 4.16.0. The WASM tier
  exhausted its fixed memory during contract composition, and Ubuntu's older
  Z3 4.8.12 rejected one proof input.

## 0.4.0 - 2026-09-17

### Changed

- Add a native migration gate for real awaited expressions and isolated build
  output comparison. Awaited facts retain native thenable/union/generic semantics
  and require project diagnostics before use as evidence. The experimental
  `/experimental/build/corsa` entry detects missing, stale and modified JS/d.ts
  without updating consumer outputs or incremental state, records compiler/input
  digests including package metadata, and rejects unsupported emission settings
  and project references. This does not establish workspace or source-map proof.

- Add native contract reachability refinement through
  `analyzeCorsaContractControlFlow` in `/experimental/spec`. Corsa authenticates
  complete expression ranges, resolved `never` returns, and boolean literal
  payloads without JavaScript compiler or display-text inference. Check native
  project diagnostics and source identity before reporting structural/refined
  exits; reject unchecked projects, stale sources, and foreign semantic facts.

- Share contract completion rules between Oxc and the Program compatibility
  adapter through AST-independent syntax views and the CFG completion algebra.
  Add structural `analyzeOxcContractControlFlow` to `/experimental/spec` without
  JavaScript compiler imports. Preserve original checker node identity, loop
  transfer ownership, switch fallthrough, and finally precedence. Correct
  mandatory-exit inference for skipped optional calls and logical assignments.

- Removed JavaScript compiler imports from property-test generation and diagnostic
  rendering. Oxc handles generator domains and structured SMT expressions; Corsa
  authenticates directly imported predicates in a disposable source snapshot.
  Preserve generated tests, hints, solver tuples, shrinking/replay, and diagnostic
  formatting. Expose property generation/execution through `/experimental/spec`.
  Reject syntax recovery, expression escapes, optional chaining, and ambiguous
  predicate overloads.

- Added native refinement callable linking through `resolveCorsaRefinementDslLink`
  in `/experimental/spec`. Validate Runtime compatibility, boolean invariant
  results, helper/implementation origins, and diagnostics in one Corsa snapshot.
  Share Oxc callable locations and compatibility rules with the Program adapter.
  Added snapshot-owned assignability and native shorthand value-symbol queries;
  preserve v1 manifests while rejecting foreign re-exports and unchecked projects.

- Added `prepareCorsaContractDslLinks` to `/experimental/spec`, checking helper
  identities, implementation signatures, and project diagnostics in one native
  Corsa snapshot. Share Oxc attachment checks and domain comparison with the
  Program adapter; authenticate numeric brands against package-owned declarations.
  Reject body type errors, unchecked projects, stale source, and same-name
  declaration impostors. Contract body proofs retain the existing verifier.

- Added `/experimental/corsa/callables` for native overload resolution, generic
  parameter/return substitution, constructor calls, and inferred declaration
  results without the JavaScript compiler. A typed RPC bridge uses the native
  7.0.2 signature endpoints through Corsa; protocol-5 source indexes authenticate
  Oxc ranges and returned declarations. Reject stale source, malformed indexes,
  foreign files, and recovery signatures without declaration identity.

- Moved parameter runtime assertions and the default `instrument` CLI to Oxc,
  with a compiler-independent `/experimental/instrument` entry. Preserve the
  schema's string literals, avoid generated-name capture, and retain hashbangs
  and directive prologues. Reject expression escapes, optional/computed helper
  calls, prototype access, and recovered syntax. Ownership source traversal now
  uses Oxc; ownership analysis and proof options retain their Program adapter.

- Migrated capability/refinement DSL source parsing and link generation to Oxc,
  completing the four DSL source paths in `/experimental/spec`. Added Corsa
  helper identity support for both DSLs and isolated binding-manifest contracts.
  Retained the Program callable/type/origin validators and stable IR output.
  Reject optional helper calls, recovered syntax, duplicate bindings, invalid
  schema fields, and annotation escapes; preserve delimiters inside builtin atoms.

- Moved temporal and contract `.uneffect.ts` parsing/source linking to Oxc and
  exposed compiler-independent analysis through `/experimental/spec`. Preserved
  clause provenance, generated models, and the Program authentication adapters.
  Added Corsa helper identity checks against package-owned declaration paths.
  Reject DSL callback/default/import/property shapes absent from the neutral IR
  and text that can escape generated annotations.

- Migrated `module-order` v1/v2 CLI extraction to Corsa/Oxc, with `--project` and
  `--corsa-executable` options and an independent async
  `/experimental/module-order/corsa` API. Shared ordering/cycle analysis and
  conditional-await proofs with the compatible synchronous Program API.
  Native diagnostics and actual compiler provenance remain in the artifact.

- Migrated specification, temporal-expression, temporal-composition, and scalar
  contract expression parsing to Oxc. `spec ir/lint/z3/quint/compose` and the
  independent `/experimental/spec` API no longer load the JavaScript TypeScript
  compiler. Extracted neutral obligation contracts and SMT construction while
  retaining Program adapter compatibility, obligation IDs, and generated output.
- Reject parser recovery, escaped expression wrappers, and temporal optional
  chains, async/default/rest lambdas, and prototype setters absent from the IR.

- CFG lint now uses Oxc syntax and Corsa symbols with native compiler diagnostics.
  Independent `/experimental/lint` and `/experimental/lint/corsa` entries avoid
  loading the JavaScript TypeScript compiler; the Program adapter remains optional.
- Separated `/spec` authoring helpers from their compiler-dependent DSL parsers,
  preserving the existing exports and declaration contracts.

- Promoted module initialization ordering to the supported `/module-order`
  entrypoint with explicit v1/v2 analyzers and separate artifact contracts.
  Retained experimental aliases, both schema versions, and the CLI's v1 default.
  Added `just module-order-check` and installed-package API/CLI parity checks.

- Promoted the workflow and dependency-impact consumers to supported `/workflow`
  and `/impact` entrypoints. Added strict input parsers, discriminated diagnostics,
  consistent option validation, and a separate parallel transition limit. Moved
  reusable implementations into `src/graph-analysis` and evaluation tooling into
  `bench/graph-analysis`; `just graph-check` and `just graph-evaluate` replace the
  prototype tasks. Existing public API declarations remain compatible.

- Organized `src/` by responsibility and made public facades re-export their
  owning modules directly. Existing package entrypoints and declarations remain
  compatible. Added the independent `@mizchi/uneffect/cfg` entrypoint with
  explicit graph contracts, caller-defined edge labels, fixed-point scheduling,
  branch joins, and completion algebra.

- Removed the local Rust crate and Cargo build/release requirements. Corsa v8
  facts are validated and normalized in TypeScript; the external
  `@corsa-bind/napi` binding is unchanged. Frontend comparisons retain provenance
  and negative controls, with frozen former-normalizer outputs covering the
  migration. `corsaTimeoutMs` remains accepted as a deprecated no-op because
  normalization no longer starts a subprocess.

### Fixed

- Module ordering now reports configuration and global compiler errors as
  `unknown`. V2 validates options even without a conditional-await candidate,
  rejects malformed budgets, and freezes the shared default budget.

- Reject duplicate empty CFG block IDs before invoking lattice callbacks.

- Hardened the conditional module-order v2 domain against a consistent lowering
  fault that bypasses await resumption. Normal completion now requires the
  actual resume block to discharge its outstanding obligation, preserving all
  published schemas and the existing supported source fragment.

### Added

- Added a CFG prerequisite-lint prototype with configurable operation contracts,
  a bounded Corsa/Oxc extractor, and `cfg-lint` JSON diagnostics. It checks
  initialization-before-use through branches, early exits, aliases, and loops,
  reporting unsupported sources and exhausted analysis as unknown. Evaluation
  includes 256 independent concrete-state graph comparisons and a documented
  false positive for correlated conditions.

- Added `module-order --schema-version 2` to select supported conditional
  top-level-await evidence from the CLI. The default remains v1; `--require`
  retains unknown artifacts and fails for unsupported inputs in either version.

## 0.3.0 - 2026-09-06

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
- Promoted the bounded Corsa semantic-query integration contract with an
  immutable `uneffect-corsa-api-frontend/v1` capability descriptor and schema.
- Promoted the high-level temporal/Promise/resource facade contract with a
  strict `uneffect-temporal-model/v1` parser, published schema, and per-domain
  modeled/not-applicable/excluded coverage.
- Added strict versioned syntax-fact and TypeScript control-flow observation
  artifacts with published schemas, source identity, coverage, and explicit
  exclusions. Corsa checking now rejects syntax gaps, attributes class method
  effects to their method owner, retains anonymous callback boundaries, and
  fails closed on non-static calls, tagged templates, and dynamic imports.
- Added an explicit release-please and npm OIDC Trusted Publishing path with a
  tag/package-version guard.
- Added a lifecycle-built tarball qualification probe that type-checks and runs
  the public entrypoints from fresh Node 24 consumers, exercises missing Corsa
  optional dependencies, and retains exact contents/checksum evidence in CI.

### Changed

- Made Corsa plus Oxc on the pinned TypeScript 7 native compiler the default
  check frontend. The separately pinned TypeScript 6 package remains the
  compatibility path for proof domains that still require a JavaScript Program.
- Narrowed the package-root API to durable numeric helpers and high-level
  checking, temporal, property-generation, extension, and runtime facades.
  Low-level solver, CFG, IR, optimizer, and backend-specific generators now
  require `@mizchi/uneffect/experimental` and carry no compatibility promise.
- Narrowed `@mizchi/uneffect/corsa` to the high-level project-check/report
  facade. The 0.2 raw checker exporter and parity internals now require
  `@mizchi/uneffect/experimental/corsa`; the versioned semantic-query contract
  remains at `@mizchi/uneffect/corsa/api`.
- Locked the exact 0.3 runtime and declaration API inventory. The current
  `@mizchi/uneffect/spec` grammar is a permanent v1 compatibility subset, and
  strict v1 schema fields and enums may only expand under a new schema ID.
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
  preventing files such as `src/runtime/numeric.ts` from shadowing Uneffect's own
  numeric domains. Contract-free sources also bypass solver fact construction,
  substantially reducing project-check latency.
- Corrected the adoption corpus contract for the transitive
  `JSON.parse` `Throw<SyntaxError>` effect and now fail closed on unproved
  external generator consumption.
- Kept per-test process isolation for the CI WASM solver while running native-Z3
  dogfood as five cost-balanced, count-checked partitions. The complete corpus
  still runs every case once, enforces 20% headroom before its overall hard
  deadline, and records v2 phase/resource timing. Self-analysis cases reuse an
  immutable whole-source snapshot within their process, while mutant cases keep
  independent programs and assertions.
- Replaced the multi-scenario workspace CLI acceptance's observed 60-second
  native-Z3 cliff with a tested, named two-minute finite budget; all valid,
  artifact-drift, composition, and broken-graph assertions remain unchanged.
- Project temporal verification now aggregates Promise/resource safety
  diagnostics into its public result and assurance decision. Release dogfood
  keeps specifications unchanged while injecting a floating browser fetch and
  a stale asynchronously disposed upload-session alias; both defects block the
  result while adjacent host-synchronization exclusions remain explicit.
- Missing `@corsa-bind/napi` now produces an explicit `/corsa/api` installation
  diagnostic without masking unrelated binding initialization failures.

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

# Uneffect design documentation

Uneffect is a gradual effect specification and verification layer for existing TypeScript. It detects effects at builtin and user-defined source symbols; it does not introduce algebraic effect handlers or require a runtime computation wrapper.

## Documents

- [Feature overview](./overview.md): pattern-oriented tour of the public annotation, specification, and programmatic surfaces.
- [Quickstart](./quickstart.md): install, run the first check, add a scoped capability, instrument assertions, and generate a temporal model.
- [Stability and safe adoption](./stability.md): alpha API status, supported fragments, experimental surfaces, and unsafe interpretations.
- [Public API and compatibility](./public-api.md): stable entrypoints, experimental subpaths, temporal result contract, and pre-1.0 compatibility policy.
- [Adoption patterns](./adoption-patterns.md): incremental rollout, boundary selection, CI ratcheting, escape hatches, and monorepo guidance.
- [Application dogfood](./application-dogfood.md): compatibility findings and regression guards from unmodified external TypeScript applications.
- [Implementation status](./implementation-status.md): the tested feature surface and explicit non-claims.
- [Assurance boundaries](./assurance-boundaries.md): what exit 0 establishes, CI profiles, and explicit non-claims.
- [Feature matrix](./feature-matrix.md): a compact tested/partial/planned view with issue ownership for every incomplete area.
- [Roadmap and known gaps](./roadmap.md): prioritized GitHub Issues, missing capabilities, and completion policy.
- [Effect system](./effect-system.md): algebra, evidence, regions, temporal IR, and optimizer boundary.
- [Gradual annotations](./gradual-annotations.md): comment marker, grammar, attachment, contracts, and optional Valibot assertions.
- [Builtin semantic contracts](./builtin-contracts.md): scoped Fetch authority, DOM operations, Worker messaging, transfer ownership, and extensible overlays.
- [Generic builtin semantics](./generic-builtin-semantics.md): composable semantic primitives, shared interpreter stages, and legacy-operation deletion gates.
- [Module initialization order](./module-initialization-order.md): source-mapped ESM dependency, top-level-await, rejection, and throw ordering evidence.
- [Semantics modules](./semantics-modules.md): declarative, namespaced effect extensions and their trusted evidence boundary.
- [Trusted Types](./trusted-types.md): provenance checks for the experimental W3C `TrustedScript` sink fragment.
- [Deno-compatible permissions](./deno-permissions.md): filesystem, network, environment, subprocess, system, FFI, and import authority semantics.
- [Formal models](./formal-models.md): Z3 boundary, Quint invalidation model, ownership obligations, and verification ledger.
- [Real-time models](./real-time-models.md): logical clocks, guarded actions, deadlines, and hard-real-time boundaries.
- [Async pattern models](./async-pattern-models.md): timers, event-loop ordering, and Promise combinator semantics.
- [Promise state model](./promise-state-model.md): executors and `then`/`catch`/`finally` reaction chains.
- [Async safety](./async-safety.md): floating Promise diagnostics and `using`/`await using` disposal models.
- [Persisted contract summaries](./contract-summaries.md): producer integrity envelopes for verified exported Hoare contracts and their current consumer boundary.
- [React function component semantics](./react-semantics.md): replayable render, event/Effect phases, immutable inputs, and cleanup contracts.
- [Specification backends](./specification-backends.md): capability, invariant, and temporal categories; shared IR; Z3 and Quint generation.
- [Evidence and optimization](./evidence-and-optimization.md): evidence states, reproducible artifacts, and proof-gated rewrite schemas.
- [Typed array bounds](./typed-arrays.md): bounded allocation, u8 writes, and optional runtime refinements.
- [Benchmarks](./benchmarks.md): repeatable Vitest Bench baselines for performance-sensitive analysis paths.
- [Node Lease and proof-assistant gaps](./node-lease-and-proof-assistants.md): bounded clock-skew modeling and an honest Dafny/Rocq capability comparison.
- [End-to-end acceptance roadmap](./acceptance-roadmap.md): enabled executable product goals and their remaining semantic limits.
- [Custom validators](./custom-validators.md): proof-backed domain validators, call-cardinality specialization, and Generator composition.
- [Contract-derived property testing](./property-testing.md): deterministic generators, explicit user-predicate specialization, shrinking, and vacuity controls.
- [Model refinement replay](./model-replay.md): normalized counterexample traces and explicit TypeScript implementation adapters.
- [Native integration](./native-integration.md): Corsa interchange, program call graphs, published contracts, and CI tiers.
- [Corsa migration decision](./corsa-migration.md): feasibility evidence, benefits, blockers, staged rollout, and stop conditions.
- [Command line](./cli.md): the single `uneffect` binary, its subcommands, streams, and exit codes.
- [Diagnostics and fixtures](./diagnostics.md): diagnostic format, the `fixtures/` corpus, and the message-quality rubric.
- [Continuous integration](./ci.md): test-tier coverage, pinned tools, and solver/runtime isolation.
- [Releasing](./releasing.md): release gate, release-please, GitHub App, and npm OIDC publishing setup.
- [Effect TS comparison](./effect-ts-comparison.md): different goals and a repeatable comparison protocol.
- [Resource protocol IR](./resource-protocols.md): common consume, transfer, split, escape, and invalidation semantics.

## Current design decisions

1. `/* uneffect: ... */` is the only annotation marker.
2. An effect declaration is an upper bound; an unannotated or unresolved boundary is not pure.
3. Domain effects and optimizer-facing semantic footprints remain distinct.
4. Scoped-effect subtyping is set inclusion over operations and scope languages.
5. DOM authority uses identity regions; CSS selectors are query refinements.
6. Platform APIs receive contracts through TypeChecker symbol identity, not wrappers or source-text matching.
7. Transfer is a flow-sensitive ownership transition and invalidation event.
8. Only verified evidence may authorize optimization.

## Planning

The original near-term design sequence is complete. See the
[current roadmap](./roadmap.md) for remaining work; GitHub Issues are the source
of truth for unimplemented features.

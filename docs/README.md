# Uneffect design documentation

Uneffect is a gradual effect specification and verification layer for existing TypeScript. It detects effects at builtin and user-defined source symbols; it does not introduce algebraic effect handlers or require a runtime computation wrapper.

## Documents

- [Implementation status](./implementation-status.md): the tested feature surface and explicit non-claims.
- [Feature matrix](./feature-matrix.md): a compact tested/partial/planned view with issue ownership for every incomplete area.
- [Roadmap and known gaps](./roadmap.md): prioritized GitHub Issues, missing capabilities, and completion policy.
- [Effect system](./effect-system.md): algebra, evidence, regions, temporal IR, and optimizer boundary.
- [Gradual annotations](./gradual-annotations.md): comment marker, grammar, attachment, contracts, and optional Valibot assertions.
- [Builtin semantic contracts](./builtin-contracts.md): scoped Fetch authority, DOM operations, Worker messaging, transfer ownership, and extensible overlays.
- [Deno-compatible permissions](./deno-permissions.md): filesystem, network, environment, subprocess, system, FFI, and import authority semantics.
- [Formal models](./formal-models.md): Z3 boundary, Quint invalidation model, ownership obligations, and verification ledger.
- [Real-time models](./real-time-models.md): logical clocks, guarded actions, deadlines, and hard-real-time boundaries.
- [Async pattern models](./async-pattern-models.md): timers, event-loop ordering, and Promise combinator semantics.
- [Promise state model](./promise-state-model.md): executors and `then`/`catch`/`finally` reaction chains.
- [Async safety](./async-safety.md): floating Promise diagnostics and `using`/`await using` disposal models.
- [Specification backends](./specification-backends.md): capability, invariant, and temporal categories; shared IR; Z3 and Quint generation.
- [Evidence and optimization](./evidence-and-optimization.md): evidence states, reproducible artifacts, and proof-gated rewrite schemas.
- [Typed array bounds](./typed-arrays.md): bounded allocation, u8 writes, and optional runtime refinements.
- [Benchmarks](./benchmarks.md): repeatable Vitest Bench baselines for performance-sensitive analysis paths.
- [Node Lease and proof-assistant gaps](./node-lease-and-proof-assistants.md): bounded clock-skew modeling and an honest Dafny/Rocq capability comparison.
- [End-to-end acceptance roadmap](./acceptance-roadmap.md): enabled executable product goals and their remaining semantic limits.
- [Custom validators](./custom-validators.md): proof-backed domain validators, call-cardinality specialization, and Generator composition.
- [Model refinement replay](./model-replay.md): normalized counterexample traces and explicit TypeScript implementation adapters.
- [Native integration](./native-integration.md): Corsa interchange, program call graphs, published contracts, and CI tiers.
- [Diagnostics and fixtures](./diagnostics.md): diagnostic format, the `fixtures/` corpus, and the message-quality rubric.
- [Continuous integration](./ci.md): test-tier coverage, pinned tools, and solver/runtime isolation.
- [Effect TS comparison](./effect-ts-comparison.md): different goals and a repeatable comparison protocol.

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

# Uneffect design documentation

Uneffect is a gradual effect specification and verification layer for existing TypeScript. It detects effects at builtin and user-defined source symbols; it does not introduce algebraic effect handlers or require a runtime computation wrapper.

## Documents

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
- [Native integration](./native-integration.md): Corsa interchange, program call graphs, published contracts, and CI tiers.
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

## Near-term design sequence

1. Add a structured parser for parameterized effects and restricted glob sets.
2. Introduce a versioned builtin contract IR and symbol-key format.
3. Implement Fetch contracts as the first scoped-effect vertical slice.
4. Implement core DOM contracts by operation category.
5. Model transfer ownership in Quint with a broken use-after-transfer witness.
6. Add `Transfer` to the Rust neutral IR and instantiate Worker/structured-clone contracts.

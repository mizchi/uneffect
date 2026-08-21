# Native frontend integration

Uneffect's implementation layer is replaceable; its frontend and proof contracts are versioned.

## Corsa interchange

The Rust crate exposes `consume_corsa_json` and `CORSA_FRONTEND_SCHEMA_VERSION`. Schema v1 consumes:

- stable symbol IDs and declaration kinds (`function`, `method`, `arrow`, callback, overload),
- TypeScript type text and selected overload signatures,
- resolved caller/callee IDs and overload indices,
- callback invocation timing (`inline`, `deferred`, `unknown`),
- raw leading trivia with UTF-8 byte spans and file IDs.

Rust attaches `uneffect:` trivia to the resolved owner, parses its structured effect set, and rejects unsupported schema versions, duplicate/dangling symbols, invalid overload indices, and malformed effects. This is the boundary a Corsa Context Mapper supplies; Rust does not rediscover source spellings.

`compareUneffectFrontends` exercises that boundary end to end. The TypeScript
reference side emits schema-v1 mapper records, the Rust
`uneffect-corsa-normalize` binary consumes them, and both sides are compared as
the same `{ function, declaredEffects }` neutral projection. UTF-16 versus UTF-8 spans
and frontend-specific evidence provenance are intentionally outside this
semantic projection. The mapper records are currently produced by the
TypeScript reference adapter, not by a linked typescript-go/Corsa build; symbol,
call-edge, ordered-event, and real Context Mapper parity remain later slices.

## TypeScript reference frontend

`buildProgramCallGraph` is the executable reference adapter. It resolves multi-file aliases and re-exports through `ts.Symbol`, maps methods, variable arrows, function expressions, overload selections, and callbacks to stable source IDs, and records callback timing. `analyzeProgramEffects` propagates effects across these edges. The CLI uses this program-wide path.

Function-typed parameters are effect parameters. Direct invocation is inline; known array combinators are inline; timers/microtasks are deferred; unsupported consumers are `unknown`. Instantiation substitutes the callback's effects and reports whether suspension is introduced. Unknown timing keeps lint information but produces unknown evidence and cannot authorize optimization.

## Published surfaces

The npm package, CLIs, evidence schema, builtin registry, Corsa JSON schema, optimizer obligations, and Rust crate are versioned at `0.1.0`. `just package-check` executes npm and Cargo package dry-runs. Runtime implementations may be regenerated, but these contract layers require a version bump when changed incompatibly.

## CI tiers

The workflow separates unit/build/package checks, Z3 obligations, Quint safety simulations with negative controls, and exhaustive Apalache verification. The exhaustive tier installs Java explicitly; local environments without Java still run every other tier.

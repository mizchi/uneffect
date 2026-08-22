# Native frontend integration

Uneffect's implementation layer is replaceable; its frontend and proof contracts are versioned.

## Corsa interchange

The Rust crate exposes `consume_corsa_json` and `CORSA_FRONTEND_SCHEMA_VERSION`. Schema v5 consumes:

- stable symbol IDs and declaration kinds (`function`, `method`, `arrow`, callback, overload),
- TypeScript type text and selected overload signatures,
- resolved caller/callee IDs and overload indices,
- callback invocation timing (`inline`, `deferred`, `unknown`),
- raw leading trivia with UTF-8 byte spans and file IDs.
- Promise observations and rejection-ownership records,
- resource scopes and reverse-order synchronous/asynchronous disposal records,
- exact nested resource failure payloads corresponding to `SuppressedError` chains.
- conditional-execution flags plus ordered control-condition IDs and polarity
  on Promise observations and resource acquisitions,
- disposal protocol symbols as stable IDs with a `sync`/`async` role, and
  resource-to-protocol edges validated for existence and matching role.

Rust attaches `uneffect:` trivia to the resolved owner, parses its structured effect set, and rejects unsupported schema versions, duplicate/dangling symbols, invalid overload indices, and malformed effects. This is the semantic-fact boundary that a Corsa integration must supply; Rust does not rediscover source spellings.

`compareUneffectFrontends` exercises that boundary end to end. The TypeScript
reference side emits schema-v5 mapper records, the Rust
`uneffect-corsa-normalize` binary consumes them, and both sides are compared as
the same normalized functions, transitive inferred effect sets, resolved local
call edges, source-ordered call events, Promise ownership records, resource
scopes, disposal order, and nested resource failure payloads. UTF-16 offsets
are converted to UTF-8 byte spans before crossing the schema. Frontend-specific
evidence provenance remains outside this semantic projection. The mapper
records are currently produced by the TypeScript reference adapter, not by a
linked typescript-go/Corsa build. The reference adapter proves that aliases of
the standard symbols resolve through TypeChecker identity while same-spelled
user properties do not become protocols.

TypeScript Go's Content Mapper facility is deliberately not treated as this
frontend API. Content Mappers run an external process for otherwise unsupported
file extensions, return generated TypeScript plus source-span mappings, and do
not expose the checker graph for ordinary `.ts` input. The intended native path
is instead the `corsa-bind` type-aware Oxlint bridge: it collects compact node,
type-text, property-name, and symbol facts from a pinned Corsa checker and sends
them to Rust native rules. A schema-v5 exporter at that bridge remains the P6
production integration task. Content Mappers may later project an Uneffect
foreign file format, but are neither required nor sufficient for TypeScript
semantic parity.

## TypeScript reference frontend

`buildProgramCallGraph` is the executable reference adapter. It resolves multi-file aliases and re-exports through `ts.Symbol`, maps methods, variable arrows, function expressions, overload selections, and callbacks to stable source IDs, and records callback timing. `analyzeProgramEffects` propagates effects across these edges. The CLI uses this program-wide path.

Function-typed parameters are effect parameters. Direct invocation is inline; known array combinators are inline; timers/microtasks are deferred; unsupported consumers are `unknown`. Instantiation substitutes the callback's effects and reports whether suspension is introduced. Unknown timing keeps lint information but produces unknown evidence and cannot authorize optimization.

## Published surfaces

The npm package, CLIs, evidence schema, builtin registry, Corsa JSON schema, optimizer obligations, and Rust crate are versioned at `0.1.0`. `just package-check` executes npm and Cargo package dry-runs. Runtime implementations may be regenerated, but these contract layers require a version bump when changed incompatibly.

## CI tiers

The workflow separates unit/build/package checks, Z3 obligations, Quint safety simulations with negative controls, and exhaustive Apalache verification. The exhaustive tier installs Java explicitly; local environments without Java still run every other tier.

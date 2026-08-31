# Generic builtin semantics

## Goal

Builtin support should normally be data, not a new analyzer branch. A reviewed
catalog entry binds a TypeChecker-resolved symbol to a composition of generic
semantic primitives. JavaScript, Node.js, DOM, and third-party package contracts
must use the same interpreter and evidence format.

The catalog remains a trusted description of host behavior. Interpreting a
catalog entry correctly does not prove the runtime implementation.

## Semantic primitives

The target model is a list of orthogonal primitives rather than one
API-family-specific operation:

- `effect(capability, scope?)` emits authority, optionally projected from an
  argument, receiver, property region, URL, host, port, or filesystem path.
- `mutate(target)` invalidates a receiver, argument, property region, or a
  region derived from another target.
- `callback(target, timing, queue, cardinality)` records synchronous or deferred
  invocation, host queue, and `0..1`, `1`, or repeated cardinality.
- `invokeUserCode()` records an invocation boundary not represented by an
  explicit callback argument.
- `result(refinement)` records fresh, aliased, path-refined, or resource-bearing
  results.
- `clone(target)` and `transfer(target)` update ownership independently of the
  capability effect.
- `acquire(resource)` and `release(resource)` update resource protocols.
- `throw(error, condition?)` adds a synchronous exceptional completion.
- `property(read, write)` selects primitives by access direction.
- `protocol(name, transition)` connects stateful host models such as Promise,
  AbortSignal, timers, streams, and disposal.

Scope and target projectors are typed data. Unknown projectors or unsupported
dynamic inputs must produce attributed unknown evidence, not silently widen to
an unscoped successful claim.

## Migration stages

| Stage | Work | Completion condition |
| --- | --- | --- |
| 1. Contract | Add a versioned `SemanticPrimitive[]` schema, typed projectors, validation, duplicate checks, and stable serialization. | Invalid primitives and targets fail closed; existing v1 entries still compile without semantic changes. |
| 2. Interpreter | Add one primitive interpreter shared by effect inference, async analysis, ownership, mutation invalidation, and frontend parity. | A primitive has one implementation and emits source-attributed evidence in every participating domain. |
| 3. Mutation | Replace `operation: mutation`, `receiverMutation`, DOM mutation flags, and argument mutation flags with `mutate(target)`. | Array/Map/Set and DOM mutation tests pass; the old mutation fields and branches are removed. |
| 4. Capability scopes | Replace `effect`, `scoped-effect`, and filesystem-specific effect projection with `effect(capability, scope)`. | Filesystem, network, Run, Sys, Fetch, Console, Random, Cookie, Storage, and DOM capabilities use the same scope interpreter. |
| 5. Callbacks | Replace timer, deferred-callback, filesystem callback, inline-callback, and scheduler callback extraction with one callback primitive. | Timing, queue, optional callback, callable guard, and cardinality are represented without API-family branches. |
| 6. Results and ownership | Move fresh/path results, clone/transfer, buffer mutation, and handle families to result, ownership, acquire, and release primitives. | Fresh-result suppression, transfer invalidation, watcher/server close, and resource evidence use the shared interpreter. |
| 7. Directional properties | Lower DOM and effect properties to `property(read, write)` containing ordinary primitives. | Property reads and writes need no separate analyzer dispatch while retaining access-direction evidence. |
| 8. Stateful protocols | Connect Fetch, Promise combinators, AbortSignal, timers, streams, and disposal through named protocol transitions. | Special behavior is isolated in protocol machines; symbol catalogs only assign inputs and transitions. |
| 9. External schema | Expose the same validated primitives to registry configuration, package summaries, and plugins. | A third-party API can express supported semantics without adding source code to uneffect; unsupported primitives fail closed. |
| 10. Cleanup and dogfood | Migrate TypeScript, Valibot, Corsa, remaining ECMAScript definitions, and uneffect's own external boundaries. | Handwritten builtin definitions and superseded operation kinds are removed; CI, parity, benchmarks, and no-unknown dogfood pass. |

Each stage follows Red, Green, Refactoring: first add a positive catalog case,
a same-spelled shadow negative control, and an unsupported dynamic case; then
implement the smallest interpreter slice; finally migrate definitions and
delete the corresponding legacy branch.

## Boundaries that remain specialized

Generic primitives describe observable inputs and outputs, but stateful models
still need protocol implementations. Fetch combines URL/method authority,
AbortSignal, Promise rejection, and body ownership. Promise combinators encode
join or race behavior. Script insertion can transition from DOM mutation to
external code execution. Structured disposal follows lexical control flow.

These are not exceptions in the catalog. They are named protocol machines used
by generic `protocol` primitives. Adding a new symbol that uses an existing
protocol remains a data-only catalog change.

## Compatibility and deletion policy

The repository is still in the design stage, so the internal legacy operation
shape does not require long-term compatibility. Migration should nevertheless
be incremental to make semantic regressions visible. A legacy field is deleted
as soon as all definitions and consumers for its stage have moved; no permanent
dual interpreter is kept.


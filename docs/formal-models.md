# Formal models and the neutral IR

The unordered `effect` declaration answers what may happen. Async invalidation, ownership transfer, and optimization require an ordered model of when facts stop being valid. Uneffect therefore keeps two representations:

- `EffectSet`: an unordered may-effect upper bound.
- `EffectTrace`: phase-tagged `Read`, `Mutate`, `Invalidate`, `External`, and `Suspend` events.

`EffectTrace::may_effects()` erases order and projects to `EffectSet`. The reverse operation is impossible because the set has discarded temporal information.

## Cache validity

A fact derived from reading region `r` cannot be reused after:

1. a `Mutate` or `Invalidate` event overlapping `r`; or
2. a `Suspend` whose invalidation set overlaps `r`.

Region overlap is symmetric ancestor/descendant overlap. A suspension does not invalidate every local fact. Escape analysis supplies the set of regions that may be shared with concurrent work; uncertainty is handled conservatively.

The Rust prototype implements this rule as `EffectTrace::cache_reusable(region, from, to)`.

## Quint regression model

[`../specs/invalidate.qnt`](../specs/invalidate.qnt) models an epoch and cache validity. Its invariant is:

```text
cacheValid implies cachedAt == epoch
```

[`../specs/invalidate-broken.qnt`](../specs/invalidate-broken.qnt) deliberately preserves cache validity across suspension. The regression test requires the normal model to produce no violation and the broken model to produce a counterexample under a fixed seed.

```sh
just formal
```

The broken trace has the domain meaning:

```text
read at epoch 0
-> suspend and advance to epoch 1
-> stale epoch-0 fact remains marked valid
```

This negative control ensures the invariant is load-bearing. `just formal` uses
Quint simulation, so a successful run is not an exhaustive proof; the
`exhaustive` CI tier runs `just formal-exhaustive`, which checks the same model
with Apalache.

## The JVM boundary

Everything the published toolchain runs itself is JVM-free: models are generated
in TypeScript, simulation uses Quint's own evaluator, and temporal bounded verification
runs on the common native/WASM Z3 layer — `findTemporalCounterexampleWithZ3` unrolls
the neutral transition IR and reports `counterexample`, `safe-within-bound`, or
`unknown`, and the strengthening synthesis in `lintSpecWithZ3` turns an
invariant inductive without leaving that path. No `uneffect` command requires
Java, and `uneffect doctor` reports it as optional. Named Bool/Int observations
reconstruct scalar, Set, Map, and record traces identically on native and WASM.

Two places deliberately keep the JVM:

- `just formal-exhaustive` checks `specs/invalidate.qnt` with Apalache.
- `verifyOwnershipObligationWithQuint` checks an ownership obligation with TLC.

Neither is a fallback for a missing capability. Apalache is itself an SMT-based
bounded checker over Z3, so it overlaps the Z3 path; what these two add is a
second implementation of the same claim — an independent encoding for Apalache,
and explicit-state exhaustive search for TLC, which is complete over a finite
state space rather than up to a step bound. Ownership evidence therefore has two
independent backends, and the invalidation model is checked by a verifier that
shares no code with this repository. That redundancy is the reason to accept a
Java dependency in those two tiers, and only in those two.

## Ownership extension

Transferable objects require an additional state machine:

```text
Available(region)
  -> Transfer(region, target)
  -> Unavailable(region, transferKind)
```

Required invariants include:

```text
an unavailable region is never read, mutated, or transferred again
every definite transfer invalidates facts derived from the source region
a clone without transfer leaves source ownership available
```

This model is implemented by the TypeScript ownership trace and Rust neutral event IR. Quint confirms the positive clone/shared trace and finds the deliberately broken transfer-then-read trace.

## Function-summary composition

The first synchronous composition slice treats each annotated function as an abstract transition contract:

```ts
/* uneffect:temporal-summary requires phase === 0 */ /* uneffect:temporal-summary ensures phase' = 1 */ /* uneffect:temporal-summary modifies phase */
function open() {}
```

Predicate syntax is intentionally TypeScript-like: use `===`, `!==`, `&&`, `||`, and `!`. These expressions are not passed through to Quint. They are parsed into Uneffect's neutral temporal-expression AST, then printed as Quint operators such as `==`, `!=`, `and`, `or`, and `not(...)`. The same AST can emit a runtime assertion statement, preserving an optional executable interpretation for supported predicates.

For a root such as `function main() { open(); close() }`, Uneffect resolves local direct calls from the TypeScript AST and generates one guarded Quint action per call. A generated `pc` records the call position. Each action checks the callee requirements, updates exactly its declared modified state, stutters every other state variable, and advances `pc`.

```sh
just spec-compose examples/temporal-compose.ts main
```

This is contract composition, not body inlining. A callee may additionally declare `temporal_throws RangeError`. The generator then emits separate normal-return and synchronous-throw actions. An uncaught throw transitions to the distinguished escaping control state `pc = -1`; a call directly protected by `try/catch` discharges that exit and advances to the next control position. The thrown type remains in the IR but the first control model collapses all synchronous error types into the same exit.

The composition graph supports explicit return, non-empty catch/finally bodies, synchronous throws, awaited Promise rejection, suspension/resume, and cancellation exits. `pc = -1`, `-2`, and `-3` distinguish uncaught throw, unhandled rejection, and cancellation. A return cuts off unreachable following statements. Calls in catch and finally blocks receive explicit control-flow targets rather than being flattened onto the normal path. Branches, loops, recursion, callbacks, and concurrent environment steps remain outside this local composition subset. Regression tests remove requirement guards, expose uncaught errors, and enable cancellation; Quint must find the corresponding violations. Progress requirements use `temporal_eventually`, trigger-sensitive `temporal_response`, infinitely-often `temporal_repeatedly`, or eventually-permanent `temporal_stabilizes`, and a suspending summary may declare weak or strong action fairness; generated programs are Quint-typechecked even though fixed-step simulation remains a safety oracle rather than a liveness proof.

Builtin async observations are a bounded input projection to the same temporal
model. The projection turns a
direct recursive `setTimeout` into a cyclic timer transition, links definite
`clearTimeout` calls to local handles, orders microtasks before timers, and
turns literal Promise combinator inputs into nondeterministic branch and
aggregate states. User-authored temporal state and callback summaries are
composed with those host transitions by `generateTemporalModel`; Web and Node
share that public entry. `all`, `allSettled`, `race`, and `any` have distinct
settlement guards and empty-input semantics. The projection also retains
direct await/catch context and escaping aggregate rejection. Binding-level
Promise ownership for a selected root lowers through the common resource IR and
is checked as `promiseOwnershipSafe`; floating ownership is a counterexample.
A directly bound builtin `new Promise` and its supported immutable local aliases
receive one exact same-Promise link to the host settlement transition using
declaration identity. External producers, reaction-job ordering, and dynamic or
escaping aliases remain outside that bounded synchronization. For a selected root
containing `using` or `await using`, the facade also emits and verifies a
resource-lifecycle projection covering acquisition, reverse disposal, async
disposal suspension, and failure completion. This is co-verification, not yet a
state-product proof for every control shape. Straight-line `await using` roots
also receive a bounded resource/host product: async disposal must start a
microtask checkpoint and may resume only inside it. A load-bearing broken model
resumes outside the checkpoint and Quint finds the violation. Bounded non-loop
conditional acquisition uses explicit acquire-or-skip and release-or-skip
paths. Repeated loop acquisition still reports `resource-host-scheduling`; the supported
product reports `resource-host-callback-interleavings` because arbitrary host
callbacks are not yet in the product. #63 tracks that remaining composition. It does not make
the local function-summary composer itself concurrent.
`TemporalModelResult.scheduling` records `fairness: "none"` and marks those
resource/callback interleavings as `excluded`; a passing safety property must
not be read as a progress guarantee.

The common resource/host product also branches each reviewed disposal into
success or throw/reject completion. Multiple failures retain a finite
suppression flag; removing that update makes `disposalSuppressionSafe` fail.
The product does not yet preserve the complete nested `SuppressedError` payload
available in the detailed resource analysis.

The selected-root facade also includes the existing abortable-fetch product
when a builtin `AbortController` signal and immutable fetch Promise binding are
resolved by TypeChecker identity. That product races abort, external fulfillment,
and rejection with first-settlement-wins guards, and consumes the same Promise
ownership and Response-body obligations. An external or dynamically selected
signal produces `abortable-fetch-synchronization` instead of a guessed link.

Promise reaction chains use a separate settlement-state projection. Builtin
`new Promise` records synchronous executor invocation, rejection conversion,
first-settlement-wins path outcomes, and PromiseLike assimilation;
`then`, `catch`, and `finally` produce ordered derived-Promise states whose
reactions are separate microtask transitions. Negative controls forbid
reaction-before-settlement and enforce successful `finally` transparency.

## Transferable ownership

The neutral ownership trace uses `Available`, `Detached`, `Transferred`, `Locked`, and `Shared`. `Clone` preserves availability. `Transfer` consumes ordinary Transferables and rejects a second transfer; subsequent read or mutation is an error. `SharedArrayBuffer` remains shared and is never modeled as detached. TypeChecker-resolved overlays instantiate compound `Clone`, `Transfer`, or `SharedMemory` effects for `structuredClone`, `Worker.postMessage`, and `MessagePort.postMessage`.

The supported non-shared TypeScript ownership trace now executes through the
common resource-protocol evaluator. Clone emits no state change, read/mutate
emit `use`, detached ArrayBuffer transfer emits `invalidate`, and other
Transferable ownership emits `transfer`. Compatibility tests compare its
diagnostics with the legacy checker. Shared-memory transfer remains outside
this exact fragment and uses the legacy path; this is not an Atomics or memory
ordering model.

## Quicksort dogfood boundary

`examples/quicksort.ts` is the first recursive, destructive algorithm used as a
dogfood case. The effect checker proves the narrow capability claim: both the
partition step and the recursive sort require only
`Mutate<typeof values>`. Numeric element indexes no longer conservatively emit
`InvokeUserCode`; object-valued computed keys still do.

The `decreases hi - lo` directive is accepted as source-compatible contract
syntax, but is currently **unverified metadata**. The checker must not issue
termination evidence from it yet. Full functional verification also remains
open: it needs sequence/array sorts, `old(values)`, quantified `sorted`
predicates, multiset `permutation`, frame conditions such as
`unchangedOutside`, verified partition summaries, and recursive-summary
composition. Until those obligations exist, the executable regression tests
establish examples only; they are not a proof for arbitrary arrays.

`generateOwnershipQuint` emits the same ordered events as a safety model. The positive clone/shared trace preserves `ownershipSafe`; the deliberately broken transfer-then-read trace is a fixed-seed negative control that Quint confirms violates it. The Rust neutral event IR independently locks the same transition rule.

## Z3 boundary

Z3 checks sequential preconditions, postconditions, and loop invariants. It is not used to approximate temporal interleavings. The current prototype proves partial correctness over a restricted integer language and does not prove termination.

## React lifecycle projection

An opted-in React component's production, development Strict Mode, bounded
concurrent-interruption, dependency-change, single Suspense-retry, or repeated
Suspense-retry replay can be passed to
`generateReactLifecycleQuint`. The generated model retains every
layout/passive Effect and inline callback-ref instance with separate setup and
cleanup counters. It separately counts attempted, committed, discarded, and
suspended renders, records each suspension identity and resolution, and gives
every committed render a generation. A retry may itself suspend again only
after the preceding suspension resolves. Each lifecycle
transition requires its owning generation to have committed, but different
commit instances are intentionally unordered.
`reactLifecycleSafe` checks `cleanup <= setup <= cleanup + 1` and the selected
scenario's counter bounds. The formal test tier runs positive models plus
negative early-cleanup, setup-after-discard, wrong-generation setup, and
retry-before-resolution transitions for both commit and re-suspend outcomes,
which Quint must reject. This component-local projection does not model Suspense fallback-tree commits,
rejected thenables, unbounded retries, Offscreen,
hydration, or the browser scheduler.

`generateReactActionErrorBoundaryQuintFromAnalysis` consumes two explicitly
selected component summaries: one with a tracked Action-phase `Throw` effect
and one used as the nearest Error Boundary fallback. Its bounded safety model
orders active-Action failure, queued-tail cancellation, pending clear,
`useActionState` render rethrow, fallback render, and fallback commit. Negative
controls retain pending, start cancelled work, or commit fallback before the
rethrow. JSX Error Boundary ownership and eventual fallback progress are not
inferred or proved.

`generateReactSuspenseBoundaryQuint` accepts explicitly selected primary and
fallback summaries and generates a separate `suspenseBoundarySafe` model. It
keeps component instances disjoint, requires resolution before primary reveal,
and requires same-phase fallback cleanup barriers before primary setup. Fixed
seed negative controls inject early reveal and early primary setup actions.
The source analyzer extracts the documented direct named/aliased JSX fragment,
and `generateReactSuspenseBoundaryQuintFromAnalysis` fails closed if the chosen
edge or either unique component summary is unavailable. General tree and
thenable causality remain outside this bounded proof.
The Program variant stores and resolves canonical component keys after
TypeScript symbol aliasing, including barrels and default exports; it does not
fall back to matching imported display names.
React default/namespace tags and component namespace tags use their imported symbols as well; an
unrelated object property named `Suspense` or `Profile` is not accepted by
spelling alone.

The normalized Suspense tree flattens JSX/React Fragments and preserves
multiple direct component or nested-boundary children as ordered
`primaryNodes`. `generateReactSuspenseTreeQuintFromAnalysis` and its Program
variant model one selected component-leaf suspension. The selected leaf records
its nearest boundary owner, and `suspenseTreeSafe` rejects an ancestor or
sibling fallback commit. A fixed-seed fault injection demonstrates that this
ownership equality is load-bearing. Wrapper/expression subtrees and suspension
originating while rendering a boundary or fallback remain outside the proof.
With `requireKnownSuspension`, the source set is narrowed to component leaves
whose direct or composed React `use` argument is proven thenable by the
TypeScript Program. Source-only and mixed-union evidence remains unknown and
cannot authorize a causal trace. Pending/fulfillment/rejection state is not
derived from the static thenable type.

## Verification ledger

| Claim | Source of truth | Machine status | Regression lock |
|---|---|---|---|
| A caught synchronous throw does not escape | Uneffect effect semantics | Implemented | TypeScript tests |
| Cache facts do not survive overlapping invalidation | Temporal IR design | Implemented | Rust tests + Quint model |
| Broken invalidation is observable | Quint model | Confirmed counterexample | Fixed-seed negative model |
| Transferred values cannot be reused | HTML ownership semantics + Uneffect design | Implemented | TypeScript/Rust checks + Quint negative model |
| Scoped glob actuals are subsets of declarations | Scoped-effect design | Implemented for the documented path/URL/permission subset | TypeScript/Rust containment witnesses and negative tests |

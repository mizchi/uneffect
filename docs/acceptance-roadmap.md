# End-to-end acceptance roadmap

The executable product roadmap lives in
`test/acceptance-roadmap.test.ts`. All current product scenarios are enabled;
the exact supported boundary is tracked in `feature-matrix.md`, while unfinished
work is owned by GitHub Issues. `TODO.md` is retained only as a historical
implementation ledger.

The target is not a collection of unrelated linters. It is one gradual
contract layer for existing TypeScript:

1. Ordinary TypeScript remains valid and its JavaScript emit is unchanged.
2. `uneffect:` comments add capability effects, invariants, and temporal
   contracts incrementally.
3. Builtin and user-defined effects share a scoped finite-set lattice.
4. User validators can attach proof-backed specializations such as an
   at-most-once Datadog sink bound, including Generator/AsyncGenerator
   composition at the application entrypoint.
5. Synchronous throws, Promise rejection ownership, resource cleanup, Worker
   transfer, and event-loop scheduling contribute to one ordered neutral IR.
6. Z3 and Quint produce reviewable, dependency-bound evidence. Unsupported or
   unknown results never become proofs.
7. Runtime assertions are an optional fallback for the supported source
   expression language.
8. Compression and mangling consume valid proof artifacts but do not trust
   stale evidence.
9. TypeScript and Corsa frontends must produce equivalent neutral IR.
10. Native Promise, Uneffect, and Effect TS examples are compared against the
   same observable contract.
11. External dogfood reports false positives, unknown summaries, annotation
    density, and frontend/verifier cost.
12. Opted-in React function components separate replayable render from event,
    React Actions, pure optimistic reducers, Effect setup, external-store reads/subscriptions, imperative-handle
    factories/exposed methods, and cleanup capabilities without changing
    emitted code; a strictly null-guarded stable lazy-ref initialization is
    admitted while ordinary render ref access remains diagnostic; immutable
    local event handlers and callback refs compose through `const` aliases;
    Program analysis also resolves write-screened JSX callbacks through named,
    barrel, default, and namespace imports while retaining their declaration contracts;
    Effect and reviewed render-Hook callbacks use the same resolution for
    definition-module effects, cleanup identity, render purity, and replay;
    specialized Action, optimistic, imperative-handle, external-store, and
    memo-comparator callbacks use that same definition-module environment;
    annotated custom Hooks compose through resolved imports, and
    direct React memo/forwardRef wrappers preserve component identity for
    inline, source-local immutable, or write-screened module-local function
    declaration component bodies reached through aliases. An
    explicit bounded Quint projection checks one Action dispatcher's
    sequential queue, pending flag, and failure cancellation laws. Direct
    Action throws retain typed `Throw` evidence; a companion projection
    composes queue cancellation, `useActionState` rethrow, and an explicitly
    selected nearest Error Boundary fallback. JSX-event
    Transition Actions diagnose unwrapped state updates after `await`; a second
    bounded projection checks aggregate pending, interruption/retry, and final
    commit after all Actions settle. A third analysis-backed projection keeps
    an already revealed Suspense boundary's stale content visible while a
    Transition suspends or is interrupted, until resolution and retry commit.
    A separate explicit projection covers newly mounted Transition boundaries
    and urgent updates, where fallback may commit after suspension and must be
    replaced by content only after resolution and retry.

The checked-in routing-state dogfood deliberately names temporal
`subscribers` as concrete `routing.activeSubscriberIds: number[]` through a
`Set(routing.activeSubscriberIds)` relation. A versioned `abstraction`
directive is consumed by projection, action, and invariant validation, and is
retained in the generated refinement manifest. Wrong Set elements, redirected
observations, stale relation versions, and incompatible concrete element types
remain failures rather than inferred mappings.

The persisted-epoch dogfood applies the same contract to a temporal
`Map<int, int>` represented by `storage.epochEntries: Array<[number, number]>`
through `Map(storage.epochEntries)`. It checks create/observe conversion,
append-as-put, key-filter deletion, clearing, key membership, and size. Wrong
tuple types, changed keys or values, value-based filtering, non-zero length
assignment, and syntax-only builtin guesses remain diagnostics or unknowns.

## Working rule

New implementation work starts by adding or tightening a relevant acceptance
test, observing Red, implementing the smallest coherent vertical slice, then
making it Green and refactoring. Narrow unit tests may be added underneath that
acceptance test, but they do not replace its end-to-end completion condition.

The acceptance file uses runtime public-API lookup so a missing product entry
point fails with a direct diagnostic instead of a secondary TypeScript error.

Property generation covers scalar `Int`, `Nat`, `U8`, `U32`, and `I32`,
bounded `Uint8Array`/`Uint32Array`, and scalar or literal union parameters. It
emits and executes test-only Vitest source, filters the restricted `requires`
language, checks `ensures`, and shrinks both numeric values and array structure.
Scalar counterexamples retain the `v1` replay format; JSON-safe arrays and
literals use `v2`. Passing `counterexampleDirectory` also makes standalone
generated Vitest files persist their minimized `v2` artifact and try that
artifact before newly generated candidates on the next run. Array generation
is resource-bounded to 4096 elements by
default and can be raised with `arrayLengthCap`; therefore a larger declared
type maximum is not silently claimed as an exercised upper edge. Generator
narrowing recognizes conjunctive integer comparisons and seeds values at and
next to their boundaries before broad scalar edges. Disjunctions and
single-variable affine comparisons are normalized syntactically. Conjunctive
positive-modulo refinements with a canonical nonnegative residue snap those
boundary seeds to the matching congruence class; for example,
`shard >= 0 && shard < 1024 && shard % 16 === 0` yields `0`, `16`, and `1008`.
Ranges and congruences remain local to each disjunct through a DNF expansion
bounded at 32 branches. Multiple compatible positive congruences are combined
with generalized CRT, including non-coprime moduli; inconsistent systems and
LCMs beyond JavaScript's safe-integer range fall back without synthesized
aligned hints. A negative remainder is normalized only when the branch proves
the parameter is strictly negative, preserving JavaScript's dividend-signed
`%` behavior. Unknown-sign negative remainders, mixed-sign remainder systems,
negative moduli, and larger DNF expansions remain on runtime filtering or the
opt-in Z3 path. For affine
equalities between scalar parameters, such as
`y === x + 1 && z === y + 2`, the generator propagates boundary hints through
the relation graph and runs valid correlated tuples before Cartesian samples.
The opt-in asynchronous Z3 generator also enumerates a caller-bounded number of
models for nonlinear scalar refinements, bounded U8/U32 arrays, and closed
record type literals whose required fields use scalar machine domains.
Numeric literal unions are lowered to an integer with an exact finite-membership
constraint, so refinement solving selects only union members satisfying
`requires`. Boolean and string literal unions use finite SMT Bool and String
domains. Mixed literal unions remain on the ordinary finite generator path
rather than being coerced across incompatible sorts. For arrays,
Integer `/` and `%` use JavaScript's truncation-toward-zero quotient and
dividend-signed remainder rather than SMT-LIB Euclidean `div`/`mod` semantics.
The integer refinement fragment adds a nonzero-divisor obligation; JavaScript
`NaN`/`Infinity` behavior is outside these integer helper domains.
the supported fragment includes `.length`, literal-index element reads, and
dynamic scalar indices over the finite modeled capacity. Dynamic reads lower
to finite SMT selection and add in-bounds generation constraints; the emitted
test still rechecks the original JavaScript precondition. All modeled lengths
and elements receive their machine-domain bounds. Closed nested records are
flattened into solver leaves and reconstructed as ordinary objects. Scalar
optional fields use separate SMT presence bits, so absence is not conflated
with a zero value, and shrinking can omit them. `BoundedSet<T, N>` uses a
finite solver universe assembled from literal `has(...)` observations and
machine-domain edge values; `.size` and literal membership are constrained as
SMT membership bits, then materialized as a native `Set` in generated tests.
`BoundedMap<K, V, N>` uses the same finite key universe plus guarded scalar
value variables. Counterexamples persist as parallel JSON-safe `keys` and
`values` columns, while generated tests materialize native `Map` instances;
`get(k)` also asserts key presence. Required descendants of an optional object
share its parent presence bit. Independently optional descendants receive their
own bits plus child-implies-parent constraints. This distinguishes an absent
parent, a present parent with an absent optional child, and a present child
without permitting the impossible child-present/parent-absent state.
The solver minimizes a shared structural-size objective over scalar magnitudes,
array lengths/elements, record leaves, and collection membership/value state.
Because nonlinear Z3 optimization can return a non-minimal local result, Uneffect
then repeats ordinary SAT checks under a strict smaller-size bound until `unsat`.
The generator injects satisfying tuples before Cartesian samples and reports an unsatisfiable
precondition rather than pretending that it generated coverage. When a correlated candidate fails, the
runner first compares known tuples by structural/numeric size and rechecks the
whole precondition, allowing dependent values to shrink together before the
ordinary coordinate shrink. It does not yet synthesize new solver-backed shrink
candidates during a failure; it reuses the size-ordered models enumerated before
execution as constraint-preserving joint candidates.
Model-checker counterexamples can be replayed through explicit TypeScript
refinement adapters; arbitrary application bindings are not inferred.

The refinement acceptance corpus also expands `for (const value of [finite
literals] as const)` and the existing bounded ascending `for` form before
running the common return/throw/catch/finally completion analysis. Consequently,
an early return stops later iterations while the current iteration's `finally`
still contributes its state update. Dynamic iterables, spreads, destructuring,
shadowed loop bindings, `for await`, and more than 64 elements fail closed as
unsupported rather than being treated as a proof.

Action refinement also follows a whole-runtime receiver through lexical,
non-escaping `const` alias chains. Each block receives an alias snapshot, so a
nested declaration cannot leak into sibling or enclosing flow. `let`, unknown
call escapes, cycles, member/destructuring aliases, and dynamically selected
targets remain unsupported rather than being treated as the original runtime.
The finite telemetry batch dogfood uses this alias form before its loop.

Invariant refinement follows acyclic imported helpers through the Program
TypeChecker. A helper may materialize a builtin `Set` from the concrete array or
a builtin `Map` from the concrete entry array named by a computed abstraction;
the result is canonicalized back to that abstract collection before membership
or lookup comparison. The constructor symbol and exact abstraction argument are
load-bearing: a same-named user class or unrelated conversion remains
`unsupported-invariant-body`.

The same quantified invariant path accepts a local or imported function
declaration, arrow function, or function expression as the callback value of
builtin array `every`/`some`. The Program TypeChecker resolves direct references
and immutable `const` aliases, then the supported single-return predicate body
is normalized under a capture-safe element parameter. A changed predicate
remains an expression mismatch; a mutable callback binding or alias remains
unsupported. This is not general higher-order flow: other function-valued
properties, runtime selection, and polymorphic callbacks are still outside the
proof claim.

One function-valued property form is explicitly proof-grade: a direct property
of an object literal passed as the sole argument to builtin `Object.freeze`.
The property initializer may be a supported function value or immutable alias,
and the TypeChecker must resolve `freeze` to the standard library declaration.
An ordinary `const` object is still mutable through its properties, and a local
lookalike named `Object.freeze` carries no authority; both remain unsupported.

A separate labeled-delivery acceptance path models cancellation with
`attempt: { ... break attempt }`. The local break is consumed only after the
selected path runs its `finally`, and the audit statement following the label
runs on both the break and ordinary paths. Labeled `continue`, cross/nested
labels, and actual function returns inside this fragment remain fail-closed;
this is not a general labeled-control-flow fixed point.

Unconditional supported `return` and `throw` completions discard their
unreachable lexical suffix. Updates before a throw still enter the selected
catch, and a catch-local return suppresses both its remaining statements and
the post-try continuation. Unsupported/effectful completion expressions still
fail closed; this rule does not infer general reachability through arbitrary
loops or dynamic dispatch. The labeled-delivery dogfood retains a deliberately
unreachable write after its local break so this behavior is load-bearing.

Bare lexical blocks participate in the same completion sequence. State updates
escape normally, return/throw predicates control the outer continuation, and
the block receives a copy of the local-value and receiver-alias environment.
Consequently a `const state = runtime` alias works inside the block but its use
after `}` is an unsupported body rather than an inferred runtime reference.
The labeled-delivery dogfood nests this scoped alias block inside try/finally.

The same immutable whole-runtime alias may receive a method call when the
runtime class and identifier-named method declaration are local and statically
known. Uneffect specializes that body exactly as for a direct receiver call.
The telemetry-routing dogfood invokes `record` through such an alias; changing
the declaration to `let` is an explicit unsupported-body control. The
Program-backed validator also follows an imported runtime parameter type to
its TypeChecker-resolved class declaration and specializes an identifier-named
method from that declaration. The two-file imported-telemetry dogfood checks
action updates, its accounting invariant, and create/observe projection; a
method body that increments the wrong amount is rejected. Syntax-only imports,
same-shaped interfaces, computed or polymorphic methods, and reassigned or
escaping receivers are not proved. This body comparison also does not prove
closed-world dispatch. A locally or Program-visible subclass makes method
specialization fail closed, including the dogfood's wrong override oracle.
Exported runtime classes also require `trust dispatch-sealing <reason>`; the
dogfoods attach owner and expiration metadata, and project verification records
the dependency as a `trusted` assumption rather than proof. Removing the marker
makes the method action unsupported. Unscanned external subclasses, prototype
replacement, proxies, and runtime monkey-patching remain outside the refinement
claim.

The action mapper also accepts the exact execution-count cases `while (false)`
and `do { ... } while (false)`, reducing them to zero and one body execution
respectively. This is not a loop-invariant proof. State-dependent conditions,
`break`/`continue`, and general repeated execution remain fail-closed. The
generated-migration dogfood retains both exact shells and a dynamic-condition
negative control.

The same mapper finitely expands the adjacent canonical form
`let i = start; while (i < end) { ...; i++ }` when both non-negative bounds are
safe integer literals and the trip count is at most 64. Expansion reuses the
return/throw/finally completion flow, so an early return suppresses later
iterations. Dynamic bounds, non-unit increments, uses of the final mutable
counter, `continue`, and labeled transfers are rejected. This remains finite
specialization, not a general loop fixed point.

A distinct symbolic affine fragment summarizes `while (counter > L)`,
`while (counter >= L)`, `while (counter < U)`, and `while (counter <= U)` for
signed safe-integer constant bounds without finite expansion. It proves
termination only when the loop body changes that counter toward the bound by a
positive safe-integer constant magnitude, every other state write is a
safe-integer constant delta per iteration, and the body completes normally.
Non-unit steps use a ceiling quotient over the guarded
nonnegative distance; division is applied only after subtracting the remainder,
so the quotient is exact under JavaScript, Quint, and Z3 integer semantics. The
final counter preserves any step overshoot instead of assuming it reaches the
bound exactly.
The loop-entry state may itself be a supported symbolic update: the derived
trip count and closed-form results are substituted over that entry snapshot
before entering the ordinary lexical continuation. The telemetry-backlog
dogfood first accounts for the sample that triggered a batching pass, processes
two entries per iteration while retaining the final one or two, then checks a
step-sensitive final backlog, exact accounting, a
double-accounting mismatch, and a nonterminating increment control. A separate
acceptance case derives a triangular total when a unit countdown updates a
second field by an affine function of the post-decrement ranking counter; an
update-order change and a self-amplifying recurrence are negative controls. A
third case joins two affine deltas behind a loop-invariant scalar condition and
rejects a condition that the loop mutates. A fourth recursively composes two
such joins and separately fixes the eight-leaf acceptance/nine-leaf rejection
budget. Dynamic or unsafe bounds or steps, other loop guards,
counter-dependent or over-budget piecewise conditions, mutually coupled
recurrences, opaque entry updates, and general loop invariants remain
fail-closed. A fifth case consumes an unlabeled `continue` after a guaranteed
ranking update, including mandatory `finally` accounting, and rejects the same
continue before that update. A sixth zero-update early-break case lets a
loop-entry pause flag select untouched state instead of the recurrence. A
seventh case performs non-counter affine updates on that stopping path, as when
paused telemetry records both the untouched backlog and its estimated weight
exactly once. The update set is capped at eight fields, with an eight-update
acceptance and nine-update rejection control. Cross-state-coupled/non-affine
break updates, counter-dependent conditions, post-update break checks with a
different ranking delta, mixed break/continue flow, uncaught throw, and return
remain fail-closed.
An eighth exception-aware case throws the current ranking value, binds it in
`catch`, records the fatal attempt, consumes the catch-side break, and runs a
mandatory `finally` that advances the ranking counter and audit exactly once.
The counter delta must equal the ordinary iteration delta; a different step,
rethrow, mutated condition, or catch update coupled to another state is
rejected.

A ninth case extends the caught failure with an invariant retry/stop policy:
stop consumes the break after one failed attempt, while retry consumes
`continue` and accumulates the affine failure/retry totals for every remaining
attempt. Both paths execute one common ranking/audit `finally`. A continue path
that can skip the ranking step, a counter-dependent or mutated policy, rethrow,
or cross-state-coupled catch update remains unsupported. The break condition's
true conjunction is specialized into its constituent facts; its false case is
kept intact because `!(a && b)` does not establish either individual negation.
These are closed-form affine rules, not a general TypeScript CFG proof.

A tenth case accepts a disjunctive invariant stop policy without choosing one
true disjunct as proof. The stopping update retains its aligned conditional
tree, so a fatal stop can record one backlog weight while an open circuit
records two. On the repeating path, a false disjunction safely establishes
that every stop flag is false. Both the stopping update tree and its cumulative
leaf count are capped at eight. A ninth leaf, a stop flag mutated by the loop,
a different ranking-counter delta, cross-state coupling, or a nonlinear stop
update remains unsupported. The circuit-breaker telemetry dogfood preserves
these boundaries with a cross-state-coupled negative control.

An eleventh case nests a sampled urgent-stop conjunction under an independent
circuit-open disjunction. The checker evaluates the bounded Boolean completion
tree propositionally and specializes only facts entailed by the stop or repeat
path. It therefore keeps the sampled, urgent, and circuit accounting branches
correlated instead of selecting one satisfying atom. Dynamic policy writes,
different ranking steps, model-misaligned updates, more than 16 predicate atoms,
and a ninth affine update leaf remain non-proofs. The circuit-breaker telemetry
dogfood now exercises this nested policy.

The first explicit budgeted CFG case exposes a versioned analysis artifact for
a dynamic-count ranking loop whose direct `try` has normal and supported scalar
throw/catch predecessors. A successful artifact records worklist convergence
plus retained throw payload and normal snapshot. Setting the named worklist
budget below convergence or coupling the catch recurrence to the normal-path
accumulator produces `unknown` and an `unsupported-action-body` diagnostic.
The worklist currently establishes control reachability only; the existing
affine completion lowering remains the value proof, so arbitrary joins and
general loop fixed points remain open.

A twelfth case carries an initialized mutable scalar local through two
sequential normally completing `if` diamonds and then consumes the resulting
phi value in a state update. State and local bindings share one flow-join
contract, while branch-local declarations remain scoped. The adaptive billing
dogfood verifies priority and retry charges and retains an underbilling model
mismatch. Uninitialized locals, `var`, writes to `const`, opaque assignments,
and local joins through abrupt completion, `try`, `switch`, loops, or labels
remain unsupported.

A thirteenth case updates a mutable scalar local on an arm that returns, then
proves that only the normal predecessor executes the suffix with its own local
snapshot. The suppressed-batch path in adaptive billing now returns before
billing and audit state changes, while the normal path retains priority/retry
accounting. Mutable locals crossing typed throws, `try`/`catch`, switches,
loops, labels, or standalone nested blocks remained unsupported rather than
reusing an enclosing snapshot in that slice.

A fourteenth case carries an initialized mutable scalar snapshot on a supported
typed scalar throw into `catch`, while the normally completing predecessor
continues with its independently updated snapshot. The catch binds the tracked
throw amount, bills from the throwing snapshot, and returns; the normal path
bills from its own snapshot. A second positive control joins two throwing arms,
and an underbilled failure path is rejected. Opaque `Error` payloads,
catch-side local mutation, rethrow, mutable-local `finally`, switch, loop,
label, and standalone-block flow remained explicit non-proofs in that slice.

A fifteenth case joins three outer-visible mutable-local snapshots before one
mandatory `finally`: a normally completing `try`, a direct return, and a typed
scalar throw whose catch returns. The finally audit update observes four, two,
or three units respectively, while billing runs only on the normal and caught
failure paths. A separate no-catch case preserves normal versus direct-return
snapshots, an under-audit implementation is rejected, and finally-local
mutation remains unsupported. The adaptive billing dogfood adds suppressed,
cancelled, failed, and normal/retried paths with independent underbilling,
under-audit, and cancelled-billing controls. Mutable-local switches, loops,
labels, standalone blocks, catch/finally mutation, and rethrow remain non-proofs.

A sixteenth case gives each scalar-switch entry its own mutable-local snapshot
and joins selected normal, direct-return, and typed throw/catch-return edges.
It covers unlabeled break, an explicit default, and case-three fallthrough into
that default before mandatory finally observes the selected units. Changing the
fallthrough value produces a Z3 action mismatch; an opaque discriminant,
state-derived case label, or nested case block with a mutable write remains an
explicit non-proof. Adaptive billing now uses a numeric billing-mode switch for
base, priority, priority-retry fallthrough, and retry-default accounting while
retaining suppressed, cancelled, and failed abrupt paths. Mutable-local loops,
labels, standalone blocks, catch/finally mutation, and rethrow remain open.

A seventeenth case carries one initialized mutable scalar through four
statically expanded `for...of` iterations. It keeps normal, consumed-continue,
consumed-break, direct-return, and typed throw/catch-return snapshots distinct;
the mandatory per-iteration `finally` audits the value owned by each edge. A
wrong accumulation is rejected by Z3, while dynamic iteration, a 65-element
literal beyond the per-loop budget remain explicit non-proofs. A nested lexical
block and an owned loop label are accepted by the following flow-projection
slices. The
bounded batch billing dogfood applies the same control flow to four configured
telemetry sinks. Dynamic/general loops, cross-label capture,
catch/finally-side local mutation, alias escape, and rethrow were still open in
that slice.

An eighteenth case mutates an outer initialized scalar inside an ordinary
standalone lexical block, uses a block-local constant, and projects the normal
and direct-return snapshots back to the enclosing continuation. The normal path
bills five units while the returning path suppresses the suffix. A wrong suffix
is rejected by Z3; shadowing and a block-local value escaping into the outer
suffix remain explicit non-proofs. The bounded batch billing dogfood now scopes
its per-sink overhead constant in such a block inside each expanded iteration.
Catch/finally-side mutation, nested switch-case mutation, label ownership,
alias escape, and general CFG joins remained open in that slice.

A nineteenth case carries an initialized mutable scalar through a statically
owned labeled block. Normal completion contributes five units and `break
attempt` contributes three; the edge-local snapshots join before the outer
state update. A wrong suffix is rejected by Z3, while an unknown target, a
nested label capture, and a real function return remain explicit non-proofs.
The same owner contract now accepts bounded ascending `for` and finite literal
`for...of` labels with their own `break`/`continue` transfers. The labeled
telemetry dogfood runs the local exit through mandatory `finally`, then charges
the selected local value in its audit continuation. Dynamic loops,
cross/nested label ownership, catch/finally-side local mutation, alias escape,
and general CFG joins remain open.

A twentieth case starts a normally completing catch from the mutable-local
snapshot owned by a typed integer throw. The catch adds the payload to that
local, projects away its binding, and joins the recovered value with the normal
try predecessor before a common state update. The failed path contributes four
units and the normal path two; a wrong recovery is rejected by Z3. At this
slice mutation followed by rethrow remained a non-proof; the twenty-third case
below closes the direct normalized-scalar form. Adaptive billing now uses
the caught failure amount to update its local charge, passes the result through
mandatory `finally` audit, and performs common billing afterward. Opaque
payloads, abrupt catch-side mutation, finally-side mutation, alias escape, and
general exception-aware CFG joins remain open.

A twenty-first case mutates an outer scalar in a normally completing mandatory
`finally` after normal, direct-return, and typed throw/recovered-catch
predecessors. The checker evaluates the audit update over their joined local
environment, then replays the local increment on each predecessor snapshot.
The surviving normal paths bill six or five units; the return path audits three
without billing. A nested positive control proves the transformed return-edge
snapshot reaches an outer finally. A wrong increment is rejected by Z3, while
combining local mutation with a conditional finally return remains an explicit
non-proof. Adaptive billing now adds one common per-attempt overhead in finally
across cancellation, recovered failure, and every normal billing mode; removing
it produces a model mismatch. Abrupt catch mutation, mutable-local rethrow,
abrupt finally overrides, alias escape, and general CFG joins remain open.

A twenty-second case starts `catch` from a typed throw's mutable-local snapshot,
adds the caught scalar, and returns directly. The projected value remains owned
by that return edge, so an enclosing mandatory `finally` audits four units on
failure while the normal predecessor audits and bills two. A deliberately
wrong catch increment is rejected by Z3. Replacing the return with a direct
scalar rethrow is now analyzed and produces a model mismatch because billing
no longer occurs; the nested positive form appears in the next case. Adaptive batch accounting
now audits failed batches through this edge without billing them; an injected
failure-side billing write produces an action mismatch. Conditional catch
return, break/continue/label transfer, alias escape, and mutable-local rethrow
remain open.

A twenty-third case mutates a scalar in an inner catch, rethrows the normalized
result, and carries both the new local snapshot and payload through mandatory
`finally` into an outer catch. Failure audits four units and recovers eight;
normal completion audits and recovers two. A wrong normalization is rejected by
Z3, while an opaque `Error` rethrow remains unsupported. The rethrow batch
accounting dogfood applies the same shape to validation-charge normalization
and rejects both an off-by-one charge and opaque rethrow. Conditional
return/rethrow, catch-owned break/continue/labels, abrupt finally mutation,
alias escape, and general CFG joins remain open.

A twenty-fourth case mutates a scalar in catch, conditionally returns with the
four-unit snapshot, and otherwise continues to a six-unit recovered snapshot.
The normal try predecessor remains two units. Mandatory `finally` audits the
selected value, while billing excludes only the return path. A wrong recovered
increment is rejected by Z3. Replacing return with a conditional scalar rethrow
is now analyzed and produces a model mismatch; the nested positive form appears
in the next case.
Adaptive billing now uses the same shape to defer failed-batch billing while
auditing it immediately; recovered failures continue to billing, and an
injected deferred-failure billing write is rejected. Conditional rethrow,
catch-owned break/continue/labels, abrupt finally mutation, aliases, and the
general CFG fixed point remain open.

A twenty-fifth case mutates a scalar in an inner catch, conditionally rethrows
the four-unit value, and otherwise completes catch with six units. Mandatory
`finally` audits the selected snapshot. The outer catch consumes both the
four-unit local and payload to recover eight, while normal failed recovery adds
six and the normal try path adds two. A wrong continuation is rejected by Z3;
an opaque conditional `Error` rethrow remains unsupported. The rethrow batch
accounting dogfood now selects escalation versus local recovery with the same
shape and rejects wrong normalization, wrong recovered continuation, and an
opaque payload. Catch-owned break/continue/labels, abrupt finally mutation,
aliases, and the general CFG fixed point remain open.

A twenty-sixth case mutates a scalar in catch, conditionally breaks its owning
one-iteration bounded loop with a four-unit snapshot, and otherwise reaches a
six-unit normal catch snapshot. Mandatory `finally` audits the selected value
before the loop consumes break. Only the normal path executes the loop suffix,
so the post-loop billing snapshots are four and seven units respectively; the
non-failure path audits two and bills three. Z3 rejects a wrong normal catch
increment. Replacing break with an unknown labeled transfer remains an explicit
unsupported control. The circuit-breaker batch-accounting dogfood applies the
same shape to a statically configured telemetry intake and rejects an extra
charge on the stopped attempt. Catch-owned continue/labels, opaque payloads,
abrupt finally mutation, aliases, dynamic loops, and the general CFG fixed
point remain open.

A twenty-seventh case unrolls two bounded attempts. Each failure mutates the
outer scalar in catch and conditionally continues with a four-unit snapshot;
mandatory `finally` audits four then seven units before each continue advances
the next iteration, and neither retry path runs its current suffix. Normal
recovery instead runs both suffixes, billing thirteen and auditing eighteen;
the non-failure path bills five and audits six. Z3 rejects an off-by-one retry
snapshot. The statically resolved owning-loop label has the same checked result,
while an unknown label remains unsupported. The retry batch-accounting dogfood
uses the same bounded two-attempt policy and rejects an extra retry charge.
Cross/nested labels, opaque payloads, abrupt finally mutation, aliases, dynamic
loops, and the general CFG fixed point remain open.

A twenty-eighth case mutates an outer scalar in an inner mandatory `finally`
and conditionally returns. That return overrides either normal completion or a
pending supported scalar throw, but its three/four-unit snapshot still reaches
an outer mandatory `finally` for auditing. When the inner finally completes
normally, the pending throw survives and the normal predecessor alone reaches
billing. Z3 rejects a wrong finally increment. A conditional finally throw is
now modeled by the following case. The shutdown-accounting
dogfood documents that suppressing a pending failure is an explicit policy, not
a recommended use of return-from-finally, and rejects an over-audited shutdown.
Finally-owned break/continue/labels, opaque payloads, aliases, and the
general CFG fixed point remain open.

A twenty-ninth case mutates an outer scalar in mandatory `finally` and
conditionally throws that normalized scalar. The finally-owned throw overrides
either normal completion or the prior scalar throw, and an outer catch observes
the matching three/four-unit local snapshot and payload. If finally completes
normally, the transformed predecessor survives: normal completion adds three,
while the original failure payload combines with four units to add five. Z3
rejects a wrong finalization increment, and an opaque `Error` payload remains
unsupported. The finalization-escalation dogfood applies the same shape to
reviewed scalar failure data and rejects incorrect normalization. Finally-owned
break/continue/labels, aliases, and the general CFG fixed point remain open.

A thirtieth case mutates an outer scalar in mandatory `finally`, audits it, and
conditionally breaks its owning one-iteration bounded loop. The finally-owned
break overrides either normal completion or a pending scalar throw, is consumed
only by that loop, and carries three/four units into post-loop billing. If
finally completes normally, the normal predecessor runs the suffix while the
pending throw survives and suppresses billing. Z3 rejects a wrong finalization
increment. The finally circuit-break dogfood applies the same shape to one
statically configured delivery attempt and rejects an extra stopped-attempt
charge.

A thirty-first case mutates and audits an outer scalar in mandatory `finally`,
then conditionally continues its owning two-iteration bounded loop. The
finally-owned continue overrides normal or pending scalar-throw completion and
the next iteration starts from its five/seven-unit snapshot; only a normally
completed finalizer reaches that iteration's suffix. Z3 rejects a wrong billing
increment. The same-owner loop label is accepted, while an unknown target is
rejected. The finally retry-accounting dogfood applies this rule to a bounded
delivery policy and rejects an extra retry charge. Cross/nested labels, aliases,
dynamic loops, and the general CFG fixed point remain open.

The worker-pool dogfood exercises the increasing direction by provisioning in
pairs until at least five workers are active. The model preserves the exact
five-or-six-worker result, checks the matching start count and reconciliation
suffix, and rejects an undercounted start metric or a decreasing update. This
is a scale-up arithmetic model only; external process creation remains a
separate capability boundary.

An unlabeled `break` inside a supported finite loop is represented as its own
conditional completion, rather than rewritten as a function return. It passes
through supported branches and `try`/`finally`, stops later iterations, is
consumed at the loop boundary, and then permits the outer continuation exactly
once. The generated-migration fixture checks this with per-iteration auditing
in `finally` and a post-loop report.

Unlabeled `continue` uses a separate completion predicate as well. Each
supported finite `for` or literal `for...of` iteration consumes it after
mandatory `finally` work and proceeds to the next statically expanded
iteration; one-shot `do...while(false)` consumes it as loop exit. Canonical
local-counter `while` deliberately rejects `continue`, because jumping over its
terminal `i++` would invalidate the finite trip-count argument. An ascending
finite `for` may instead name itself and use `break label` or `continue label`:
the exact owner label is carried through branches and `finally` and consumed at
that loop boundary. The same target-aware completion maps now preserve an
outer-loop transfer through an inner finite loop and mandatory `finally`; a
capture-screened AST substitution replaces the old source-offset rewrite so
nested finite expansion remains valid. Unknown labels, dynamic loop bounds,
shadowed counters, and ambiguous switch/loop ownership remain fail-closed.

A collection-backed lease acceptance adapter now checks the complete refinement
boundary: Program-backed create/observe types must match `Set<int>` and
`Map<int, int>`, native `Set.add`/`Map.set` calls must match the declared
temporal action, and native `Set.has`/`Map.has` must match the corresponding
membership invariants. Map membership uses the backend-neutral canonical form
`map.keys().contains(key)`. A guarded native `Map.get` also proves the stored
epoch value; changing the expected value produces a mismatch, while an
unguarded temporal lookup is rejected as a partial operation. Changing either observed member produces an
`invariant-expression-mismatch`. Z3 mismatch discharge consumes the retained
normalized AST rather than reparsing the runtime-oriented diagnostic text, so
collection spellings such as JavaScript `.has` cannot crash the verifier.
The same adapter proves the authority subset
`Array.from(owners).every(owner => allowedOwners.has(owner))` against temporal
`owners.forall(owner => allowedOwners.contains(owner))`. Replacing the bound
member with a constant is a negative control and fails refinement.
Map iterator refinements are exercised in the same lease: native
`Array.from(epochs.values()).every(epoch => epoch >= 0)` maps to the temporal
value-view quantifier, while `Array.from(epochs.keys()).every(...)` maps to the
key-view quantifier. Tightening the implementation predicate to `epoch > 0`
fails against the declared nonnegative invariant.
The lease table itself is a record-valued
`Map<number, { epoch: number, valid: boolean }>`. A native `values()` iterator
with a single-return callback block proves
`!lease.valid || lease.epoch > 0`; weakening the field comparison fails, while
an immutable callback-local alias for `lease.epoch` preserves the proof.
Changing that alias declaration from `const` to `let` remains an explicit
unsupported non-proof.
The lease corpus also binds `Array.from(runtime.owners).some(...)` to a
temporal `Set.exists` invariant. A changed witness predicate is rejected as an
invariant-expression mismatch rather than accepted from the initial state
alone.

The adoption KPI is measured over a checked-in controlled corpus. The public
machine-readable report includes false-positive and unknown-summary rates,
annotation density, enforced boundaries, measured frontend and full project
verifier time, diagnostics, and builtin declaration drift. Its reported
false-positive rate is not an estimate for arbitrary external TypeScript
applications. As a phase-zero external compatibility check, the pinned
`effect@3.22.1` `Function.ts` import graph loads three implementation source
files and produces at least 40 inferred summaries with no unknown summaries,
diagnostics, or builtin declaration drift. The same report records its source
and function counts and external frontend time. This is deliberately not
reported as proof that Effect is pure or correct: inference-only mode has no
reviewed external annotation boundary. Reviewed application adapters below
provide the constraint-bearing verifier coverage.

A separate checked-in adapter imports `pipe` from the same external package
and declares `/* uneffect: effect Console */` on its application boundary. The
boundary verifies with the exact inferred Console authority. A negative control
replaces it with `FsRead<"$CWD/**">` and must report both the missing Console
and unused FsRead declarations. This is a meaningful capability constraint over
an application adapter; the following Z3 and Quint adapters add formal backend
coverage, while the consolidated report measures the full controlled project
verification pipeline.

The Effect adapter also contains `increment`, whose restricted Hoare contract
is lowered through `effect/Function.pipe` and discharged by Z3. The lowering is
intentionally narrow: `pipe` must be a named import (aliases are retained) from
the exact `effect/Function` module, and every stage must be an inline unary
expression callback. A local function merely named `pipe`, block callbacks,
and arbitrary external calls remain unsupported non-proofs. The positive
adapter verifies `result > value`; replacing `current + 1` with `current - 1`
produces a counterexample. This adds no production runtime code.

The temporal external adapter schedules a timer whose inline callback computes
through Effect `pipe` and dynamically queues a microtask. Uneffect extracts the
timer task and nested microtask, generates the Web event-loop Quint model, and
verifies `eventLoopSafe`. Named callbacks with `temporal_requires` and
`temporal_ensures` are now composed into the same queue transition. Project
verification also checks declared state safety properties in that product.
Inline callbacks and indirect callback aliases do not yet carry summaries.

Project verification exposes Z3 contract artifacts, typed-array results,
definite ownership diagnostics, and explicit `assert parameter: Schema`
Valibot instrumentation in one result. It invalidates a fixed-buffer DataView
constructor proof when a builtin Worker/clone transfer definitely detached the
same direct resource first. This is ordered cross-domain evidence, not general
path-sensitive alias analysis. The runtime assertions remain separate clauses:
an arbitrary Hoare `requires` or `ensures` expression is not automatically
converted into a runtime check.

The async resource acceptance path recognizes a loop-local alias of an
`await using` resource as released when a common `finally` clears it on every
continuing exit. The check covers normal completion and failure before lexical
async disposal. Replacing the mandatory assignment with a one-branch clear
retains `disposed-resource-use`; arbitrary loop-carried alias relations remain
outside this finite must-clear summary.

The shared completion-CFG acceptance path combines loop-scoped `await using`,
awaited delivery, mandatory `finally`, and a labeled two-attempt outer retry
loop. Promise/resource analysis resolves `continue attempts` to that exact
bounded owner. Unified Quint lowering makes the transfer override any pending
rejection, completes asynchronous disposal, advances the resource generation,
and then repeats or exits. Quint accepts the model and rejects a stale-disposal
fault injection. An adjacent unknown-label case still reports
`unsupported-control-transfer`; handler-local unlabeled continue remains
lowerable. Outer break, dynamic/non-canonical bounds, nested ownership, and
arbitrary loop bodies remain explicit non-proofs.

The matching early-exit acceptance path replaces the retry transfer with
`break attempts` and adds a post-loop awaited report. Unified lowering gives
ordinary completion the bounded repeat/exit cleanup path but gives the selected
break its own reverse-order cleanup edge. The break target is exactly the report
await state. Quint accepts terminal disposal and rejects a fault that jumps over
transfer cleanup. A dynamic bound and a label owned by a non-loop block remain
diagnosed rather than being guessed as the finite `for` owner.

The mixed-disposal rejection path acquires a synchronous audit resource before
an asynchronous delivery session at function scope. A rejected awaited send
enters the concrete catch, continues through mandatory finally, and disposes
the session before the audit resource. The generated `cleanupOrderSafe`
invariant is load-bearing: a swapped cleanup lowering and a cleanup-skip
lowering both produce Quint counterexamples. Removing `await` remains a
`floating-promise` diagnostic, so model support does not discharge rejection
ownership. Nested resource scopes and arbitrary handler joins remain open.

The nested rejection path extends that model with an outer synchronous audit,
an inner asynchronous session, and two independently rejecting awaits. A
finite Boolean catch join recovers or rethrows and both outcomes traverse
mandatory finally. Recovery disposes the inner session before the outer audit
flush; rethrow enters terminal inner-then-outer cleanup. Quint checks
containing-scope precedence and rejects both outer-before-inner terminal cleanup
and skipped normal scope cleanup. A conditionally floating second operation and
a transfer to an unresolved enclosing label remain diagnostics/non-proofs.
A second nested path declares the async session inside the protected try, so
its disposal rejection enters the enclosing conditional catch. Quint retains a
pending handler obligation until recovery or rethrow and rejects a handler
bypass before mandatory finally and remaining outer cleanup. Multiple failing
disposals in one protected scope now continue in reverse order before catch and
retain a finite single/suppressed failure kind. Protected body rejection and a
later acquisition failure enter that same cleanup chain. A sibling acceptance
case preserves one Boolean `if`/`else` choice between differently named async
resources through branch-local cleanup and a shared catch/finally join. Its
Quint invariants reject both resources being acquired, disposal of the
unselected resource, skipped cleanup, and premature handler entry. The checked
bounds are two resources in one common stack or exactly one resource per arm of
one Boolean branch; larger stacks, nested/general branch trees, multiple nested
cleanup scopes, concrete error payloads in Quint, and arbitrary CFG joins remain
open.

An exhaustive-switch sibling accepts a finite string-literal union identifier,
literal cases, an explicit default, no fallthrough, and one differently named
async resource per path. Analysis records the discriminant classification;
model generation checks finite path coverage and pairwise non-overlap before
Quint proves acquisition exclusion, branch implication, and disposal only after
acquisition. Missing default, fallthrough, an open `string` discriminant,
multiple acquisition, wrong-case cleanup, skipped cleanup, premature handler
entry, and floating rejection are negative controls. The bound is eight case
conditions and does not cover arbitrary expressions, nested decisions, or
general CFG joins.

A nested-Boolean sibling accepts one complete three-leaf resource tree formed
by an outer Boolean identifier and one nested Boolean identifier. Analysis
records predicate provenance; generation enumerates a bounded condition space
to reject incomplete or overlapping leaves before Quint checks pairwise
acquisition exclusion, branch implication, and disposal only after acquisition.
Expression predicates, missing leaves, multiple resources on one leaf, and a
ninth condition are explicit non-proofs. Multiple acquisition, wrong-leaf
cleanup, skipped cleanup, premature handler entry, and floating rejection are
negative controls.

A mixed-decision sibling accepts one finite string-literal `switch` whose
preferred case contains one Boolean-identifier `if`/`else` and whose explicit
default contains one backup resource. Generation preserves the conjunction of
the switch and Boolean paths, validates both provenance kinds, and enumerates
one combined condition space capped at eight conditions. Expression predicates,
open switch discriminants, incomplete or overlapping mixed leaves, multiple
resources on a leaf, and a ninth combined condition are explicit non-proofs.
Multiple acquisition, wrong-leaf cleanup, skipped cleanup, premature handler
entry, and floating rejection remain negative controls. Other mixed shapes,
arbitrary CFG joins, loops, and escaping aliases remain open.

A sequential-decision sibling accepts two independent finite resource
decisions in one protected `try`. The first decision's selected lexical resource
is awaited and disposed before control reconverges; a later decision then
selects another resource. Generation validates each stage's provenance,
complete/non-overlapping coverage, and one combined eight-condition budget,
while keeping their acquisition-exclusion groups separate. Quint additionally
requires every acquired first-stage resource to be disposed before any
second-stage acquisition. A dedicated delayed-cleanup fault passes when that
invariant is weakened, so the check is load-bearing. Incomplete/overlapping
stages, disposed aliases crossing the join, wrong-stage acquisition,
wrong-resource or skipped cleanup, premature handler entry, and floating
rejection are negative controls. Non-uniform return/throw joins, more than two
stages, loops, and arbitrary CFGs remain open.

The temporal project-verification slice extracts Web scheduling from Uneffect
TypeScript and applies named callback summaries atomically in the corresponding
timer, microtask, animation-frame, or scheduler transition. A due callback with
an unsatisfied precondition violates `eventLoopSafe`; it is not treated as safe
merely because its transition is disabled. `telemetry-once.ts` dogfoods this by
proving one queued send and finding a counterexample after the send is queued
twice. The current product remains bounded and callback-name based: it does not
prove callback bodies, alias identity, liveness properties, or environment I/O.

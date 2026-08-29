# Node Lease model and proof-assistant gaps

## Product constraint

Uneffect targets existing TypeScript and aims for nearly zero production
runtime overhead. Comments, helper types, neutral IR, solver programs, and
evidence artifacts are erased or remain build-time inputs. Valibot assertions
and runtime temporal checks are opt-in boundary instrumentation, not required
execution wrappers.

Generator-based effect programs remain useful as an optional trace-producing
style and as a source of semantics for `yield`/`yield*` composition. Uneffect
does not require existing applications to be rewritten as Generator programs
or routed through effect handlers.

## Bounded Node Lease model

The clock-skew single-writer failure from the
[Node Lease article](https://zenn.dev/mizchi/articles/quint-application-modeling)
can be encoded in the current comment DSL with finite `Set`, `Map`, and closed
record state; the older scalar A/B expansion remains as a comparison fixture.
The regression model contains a monotonic
real-time clock, A's shared lease expiry and local deadline, the owner epoch,
resident epochs, takeover/publish transitions, and a `singleWriter` invariant.

The negative model allows B, whose wall clock is one tick ahead, to take over at
real time 9 while A's local deadline is 10. Quint finds A/e1 and B/e2 both with
local write authority. The positive bounded model waits one additional
skew-grace tick and reports no violation within the configured search.

The lifecycle acceptance model separately covers delayed renewal completion,
renewal CAS failure that self-fences the worker, crash followed by resource GC,
and a write that remains in flight across lease takeover. The fenced variant
permits completion only when the captured write epoch still equals the current
owner epoch. Removing that guard lets Quint reach `badCommit = true`; this
negative control demonstrates that the constraint is load-bearing rather than
an invariant that passes because the relevant transition is absent.

The lifecycle model also dogfoods Z3 strengthening hints. Defensive actions
for malformed negative and zero epochs are unreachable in a valid lease run,
but make `ownerEpoch !== 0` non-inductive over arbitrary typed states. Uneffect
first proves `ownerEpochPositive` at init and across every transition, then
uses it to prove `observeZeroEpoch` unreachable without a depth bound. A hint
that fails either proof obligation is diagnosed and never trusted.
The opt-in sign-template synthesizer reaches the same result after removing
the declared property: it generates `<synth:ownerEpoch > 0>`, proves it, and
uses it as the strengthening invariant. This is evidence for the epoch/counter
use case only; relational lease invariants still need explicit declarations.

The same proof pipeline now synthesizes both directions of subset candidates
for same-element finite `Set` state pairs, including sets nested recursively in
record fields. Finite `Map.keys()` domains are projected as derived Set views,
and scalar `Map.values()` domains receive the same treatment. A dogfood
ownership table proves both
`authority.owners.keys() subset authority.allowedResources` and
`authority.owners.values() subset authority.allowedOwners`, then uses them to
rule out armed resource and owner escalation actions.
Removing the authority check and narrowing the allowed set produces a bounded
Z3 traces whose ownership keys are `{1, 2}` while allowed resources are `{1}`
and whose owner values include `20` while allowed owners are `{10}`. Candidates
are not assumptions: this broken model does not receive either strengthened
diagnostic, because a direction is discarded unless Z3 proves it at init and
across every action. Composite Map values remain outside this synthesized-view
fragment.

`examples/dogfood/node-lease-total-map-lookup.ts` adds a total missing-node
read. A lease table entry has `{ epoch, valid }`; lookup of literal node `3`
uses `getOrElse(3, { epoch: 0, valid: false })`, so absence fences the write.
The same neutral expression executes in Quint, runtime replay/assertions, and
bounded Z3. Changing the fallback to `valid: true` yields a one-step
counterexample in which the unknown node gains write authority.

`examples/dogfood/node-lease-dynamic-map-domain.ts` then selects node `1` or
`2` through state. Its immutable literal `nodes` registry and direct
`nodes.contains(selectedNode)` property are not assumptions: Z3 separately
checks satisfiable init, initiation, and preservation across every action.
Only then does counterexample extraction decode the dynamic lease lookup. The
fenced fallback is safe within depth two; changing it to `valid: true` produces
a one-step replayable missing-lease trace. Mutable/non-literal registries,
compound keys, incomplete per-key proof sets, failed induction, and unavailable
solvers remain `unknown`.

`examples/dogfood/node-lease-primary-backup-map-domains.ts` extends that bounded
fragment to primary and standby selectors. Each selector has its own named
membership property, and Z3 proves both relations separately before the shared
lease Map is decoded. A single missing or invalid selector proof keeps the whole
trace universe `unknown`; this is not general collection correlation.

`examples/dogfood/node-lease-failover-joint-map-domains.ts` covers one further
bounded relation: promotion copies the standby selector into the primary slot.
The primary property is not inductive alone, so Z3 proves the conjunction of
both already-initiated membership properties. The evidence names both joint
assumptions and does not present the result as independent per-key proof.
Arbitrary collection relations and a conjunction that fails preservation remain
`unknown`.

`examples/dogfood/node-lease-string-identities.ts` removes another artificial
flattening step: production-shaped `"node-a"`/`"node-b"` identities remain
strings in scalar state, finite Sets, Map keys, Quint, native/WASM Z3
counterexamples, TLC console traces, and TypeScript replay. Switching the
selected node explicitly invalidates the prior `writeAllowed` authority before
the new lease is checked; the first acceptance run found that missing
invalidation as a real counterexample. String equality is supported, while
ordering, arithmetic, control-character SMT literals, unbounded string
generation, and observation outside the complete literal/proved finite domain
remain non-proofs.

The GC slice also exercises liveness rather than safety alone. With an
unconstrained `idle` action, Z3 finds an infinite lasso in which the worker
never crashes and the resource remains held. Declaring weak fairness for both
`crash` and `gc` removes such lassos within the four-step dogfood bound:
crash cannot be postponed forever while continuously enabled, and after crash
the same holds for GC. This conclusion depends on those scheduler assumptions;
without them Uneffect intentionally reports starvation.

This is not a proof of a Node implementation. The lifecycle abstraction covers
renewal, delayed completion, GC, in-flight writes, CAS failure, and crashes as
model actions, but still omits concrete storage/network behavior and an
implementation-to-model refinement proof. “No violation found” remains bounded
evidence unless an explicit inductive diagnostic is produced.

## Comparison with Dafny

[Dafny](https://dafny.org/dafny/DafnyRef/DafnyRef) has a general heap model with `reads`/`modifies` frames, `old`, quantified
expressions, mathematical collections, ghost state and lemmas, modular method
verification, and termination checking through `decreases`. Its `assume`
statement is an explicit escape hatch. Uneffect currently has narrower region
effects, restricted arithmetic Hoare contracts, bounded temporal generation,
and unverified `decreases` metadata. Its distinct goal is gradual analysis of
ordinary TypeScript and platform/async effects without a new implementation
language.

## Comparison with Rocq

[Rocq](https://rocq-prover.org/doc/V9.2.0/refman/language/core/index.html) has a small proof-checking kernel, proof terms, dependent and
(co)inductive types, checked recursion, interactive tactics, reusable lemmas,
and program extraction. Uneffect delegates to Z3 and Quint and records
tool/version-bound evidence; it does not produce independently kernel-checked
proof terms. `trust typed-array` is one domain-specific assumption recorded as
`trusted`, never `verified`; it is not yet a generic counterpart to `Admitted`.

## Priority gaps for Uneffect

The highest-value gaps for the nearly-zero-runtime TypeScript goal are:

1. broader collection-valued temporal reasoning beyond the implemented finite
   `Set`, `Map`, records, literal-key total lookup, and finite domains;
2. quantified invariants and backend-applicability metadata;
3. an extensible temporal semantic-domain registry, with wall-clock versus
   monotonic-clock types and skew assumptions as one optional domain pack;
4. model-to-TypeScript refinement bindings and counterexample replay;
5. heap snapshots, `old(...)`, frame conditions, and ghost/spec-only bindings;
6. verified termination rather than accepted `decreases` metadata;
7. a cross-domain assumption ledger and policy-controlled `trusted` evidence;
8. independently checkable certificates where backends can provide them.

Until items 1–4 exist, Node Lease support is a hand-authored, bounded finite
projection, not automatic verification of production code. Collection state
is no longer manually scalarized for every fixture, but dynamic key domains,
general quantification, and implementation refinement remain incomplete.

Clock semantics are not a globally preferred Uneffect concern. Node Lease is a
stress case for registering domain-specific state types, assumptions,
transitions, and builtin contracts. Projects that do not opt into a clock
domain should pay no analysis-policy or runtime cost for it.

## Specification quality checks

`lintSpec` reports directly constant temporal properties and self-assignment
actions. Its Z3 extension also detects algebraic tautologies, inconsistent
initial states, globally impossible guards, duplicate/subsumed properties,
bounded reachability, deadlock, stuttering, and property vacuity. Implemented
unbounded promotions require one-step induction, optionally under explicitly
selected strengthening properties whose own induction obligations pass.
Automatic invariant discovery, finite-state completeness, bounded fair-lasso
detection for `eventually`, and selected sign, relational, affine-offset, and
collection templates are implemented. General polyhedral/quantified synthesis
and arbitrary nested temporal formulas remain open. Uneffect now supports the
specific eventuality, response, recurrence, and stabilization fragments without accepting raw
backend syntax.

Effect declarations remain equally important. The existing function/program
effect checker diagnoses missing effects and unused upper-bound effects for its
implemented call-graph and builtin-contract subset. The unified project API and
acceptance-level normalized drift report are still incomplete, so support must
not be described as universal across dynamic dispatch, unresolved packages, or
all Corsa paths.

Type-driven property-test generation now covers the documented scalar,
bounded-array, closed-record, finite Set/Map, and selected refinement fragments,
including constraint-preserving shrinking and persisted replay. Arbitrary
contract refinements and all TypeScript heap shapes remain incomplete. The
pipeline is build/test-only and adds no required production runtime.

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
can be encoded
in the current comment DSL after finitely expanding the node-indexed maps and
sets into states for nodes A and B. The regression model contains a monotonic
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

1. collection-valued temporal state (`Set`, `Map`, records, finite domains);
2. quantified invariants and backend-applicability metadata;
3. an extensible temporal semantic-domain registry, with wall-clock versus
   monotonic-clock types and skew assumptions as one optional domain pack;
4. model-to-TypeScript refinement bindings and counterexample replay;
5. heap snapshots, `old(...)`, frame conditions, and ghost/spec-only bindings;
6. verified termination rather than accepted `decreases` metadata;
7. a cross-domain assumption ledger and policy-controlled `trusted` evidence;
8. independently checkable certificates where backends can provide them.

Until items 1–4 exist, Node Lease support is a hand-authored, bounded, finitely
expanded Quint projection, not automatic verification of production code.

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
and nested temporal formulas remain open.

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

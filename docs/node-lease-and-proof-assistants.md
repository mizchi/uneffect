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

This is not a proof of a Node implementation. The model currently omits lease
renewal, delayed completion, held-lease sets, node GC, in-flight writes, CAS
failure, crashes, storage behavior, and an implementation-to-model refinement
mapping. “No violation found” is bounded evidence for this two-node abstraction,
not universal correctness.

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

`lintSpec` currently reports directly constant temporal properties such as
`true`, `x === x`, `x !== x`, and actions whose assignments are all
self-assignments. Parser/type errors remain hard failures. This is only a
syntactic first slice: algebraic tautologies, inconsistent initial states,
unreachable actions, vacuous preservation caused by deadlock, and redundant or
subsumed invariants are not detected yet.

Effect declarations remain equally important. The existing function/program
effect checker diagnoses missing effects and unused upper-bound effects for its
implemented call-graph and builtin-contract subset. The unified project API and
acceptance-level normalized drift report are still incomplete, so support must
not be described as universal across dynamic dispatch, unresolved packages, or
all Corsa paths.

Type-driven QuickCheck generation with shrinking is now an executable skipped
acceptance requirement, not an implemented feature. The intended build-only
pipeline derives generators from TypeScript/refinement boundaries, satisfies
preconditions, checks postconditions/invariants, shrinks failures within the
domain, and stores replayable counterexamples. It must not add a required
production runtime.

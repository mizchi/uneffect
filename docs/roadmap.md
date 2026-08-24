# Roadmap and known gaps

Completed implementation details live in `implementation-status.md` and the
historical `TODO.md` ledger. `feature-matrix.md` is the compact boundary view.
GitHub Issues are the source of truth for future work. The ordering below
reflects dependency and soundness risk, not a release date commitment.

## Phase 1 — Make proof boundaries dependable

1. [General TypeScript-to-model refinement](https://github.com/mizchi/uneffect/issues/3)
   must replace the remaining syntax-fragment walkers with an exception-aware
   control-flow fixed point.
2. [Unified Promise, exception, and resource flow](https://github.com/mizchi/uneffect/issues/9)
   must make rejection handling and disposal guarantees compositional.

[Reachability, vacuity, and deadlock](https://github.com/mizchi/uneffect/issues/1)
is complete for the documented bounded, finite-state-complete, inductive,
strengthened, and reachable-lasso proof modes. General infinite-state
reachability is intentionally reported as bounded/inconclusive unless a proof
rule applies; absence of a bounded witness is never promoted to a proof.

These are the highest-priority soundness gaps because they determine whether a
local result survives composition with real application control flow.

## Phase 2 — Increase specification and test expressiveness

1. [General invariant synthesis and temporal formulas](https://github.com/mizchi/uneffect/issues/2)
   adds bounded polyhedral, quantified, collection-correlated, and nested
   temporal reasoning.
2. [Collection-valued state and TLC interoperability](https://github.com/mizchi/uneffect/issues/5)
   makes Node Lease-style models direct and preserves external counterexamples.
3. [Constructive property generation and shrinking](https://github.com/mizchi/uneffect/issues/4)
   reduces filtering and covers recursive/user-defined refinements.
4. [Typed-array and SHA-256 verification](https://github.com/mizchi/uneffect/issues/6)
   completes alias, resize, control-flow, and shared-memory reasoning.

## Phase 3 — Production integration and trust

1. [Native Corsa semantic parity](https://github.com/mizchi/uneffect/issues/8)
   moves inferred facts and ordered events off the TypeScript reference adapter.
2. [Complete Node and Web event-loop ownership](https://github.com/mizchi/uneffect/issues/10)
   fills host phases, dynamic cancellation, and polymorphic callback gaps.
3. [DOM property getter/setter effects](https://github.com/mizchi/uneffect/issues/14)
   completes TypeChecker-identified `Text*` and `Property*` inference without
   conflating Web IDL properties with attributes or node topology.
4. [Independently checkable evidence](https://github.com/mizchi/uneffect/issues/7)
   evaluates certificates and narrows the trusted computing base.
5. [React function component lifecycle semantics](https://github.com/mizchi/uneffect/issues/16)
   extends the initial phase checker through symbol-resolved custom Hooks,
   resource identity, replay, and concurrent/server boundaries.

## Phase 4 — Consume proofs without widening their claims

1. [Proof-gated optimizer transformations](https://github.com/mizchi/uneffect/issues/13)
   turns the existing obligation schemas and narrow prototypes into explicit,
   fail-closed transformations. It depends on stable evidence and frontend
   parity; unknown or stale facts must leave source unchanged.

General compression, reordering, dead-code elimination, and property mangling
remain later steps within that issue, not capabilities implied by the current
effect or invariant reports.

## Cross-cutting missing capabilities

- **Whole-language coverage:** dynamic dispatch, proxies, reflection, mutation
  through unknown aliases, native addons, and host callbacks remain conservative
  boundaries.
- **Liveness and fairness:** safety is substantially stronger than liveness;
  scheduler fairness and real-time guarantees need explicit environmental
  assumptions.
- **Abstraction:** non-identity mappings between application objects and model
  state need composable, checkable abstraction relations.
- **Concurrency:** Worker transfer ownership is modeled, but shared-memory data
  races and the full Atomics memory model are not.
- **Proof trust:** Z3/Quint executions are reproducible evidence, not proof
  certificates. Backend bugs and translation bugs remain in the trusted base.
- **Runtime compatibility:** optional Valibot/runtime assertions intentionally
  trade zero-runtime operation for boundary checking; this choice must remain
  explicit per build.
- **Optimization:** effect and invariance results are not yet a general license
  for dead-code elimination, reordering, compression, or mangling.

## Working policy

- Start each issue by enabling or adding an end-to-end skipped acceptance test,
  observe Red, then implement the smallest sound fragment.
- Every successful result must name its proof mode and unsupported boundary.
- Add a benchmark whenever a change expands solver search, call-graph traversal,
  property generation, or native fact volume.
- Update `implementation-status.md` when an issue closes; do not move completed
  work back into an unbounded checklist.

# Roadmap and known gaps

Completed implementation details live in `implementation-status.md` and the
historical `TODO.md` ledger. `feature-matrix.md` is the compact boundary view.
GitHub Issues and their matching Phase milestones are the source of truth for
future work. The ordering below reflects dependency and soundness risk, not a
release date commitment.

## Phase 1 — Make proof boundaries dependable

1. [General TypeScript-to-model refinement](https://github.com/mizchi/uneffect/issues/3)
   must replace the remaining syntax-fragment walkers with an exception-aware
   control-flow fixed point. A first unbounded directional affine-loop rule now
   derives a closed form from a symbolic loop-entry state and signed constant
   bound without finite expansion, including positive constant step magnitudes,
   exact overshoot in both directions, triangular totals for unit-countdown
   state deltas affine in the ranking counter, and a loop-invariant scalar
   decision tree of at most eight affine leaves. Larger or dynamically changing
   joins, arbitrary mutually coupled loops, and exception-heavy recurrences
   remain. An unlabeled `continue` is consumed only after merged loop state
   proves that every path took the ranking step, including mandatory `finally`.
   A separate rule splits one loop-invariant early `break` from the repeating
   path and permits up to eight independent non-counter affine updates on the
   stopping path. A caught scalar failure can break after mandatory `finally`
   advances the ranking counter by the ordinary iteration delta;
   an invariant retry/stop policy can instead select continue while sharing the
   same ranking `finally`. A disjunctive invariant stop policy may retain an
   aligned path-wise affine update tree of at most eight leaves; it does not
   select an arbitrary true disjunct. Nested aligned Boolean policies are now
   handled by bounded propositional entailment over at most 16 invariant atoms,
   preserving choices that the selected completion path does not determine.
   Differently-counter-changing,
   cross-state-coupled, non-affine, over-budget, unaligned, and dynamically
   selected outcomes remain open.
   As the first reusable CFG seam, state updates and initialized mutable scalar
   locals now share one phi-join contract across normally completing sequential
   `if` diamonds, including a returning arm whose suffix runs only with the
   normal predecessor's local snapshot. Supported typed scalar throw edges now
   carry their own mutable-local snapshot into `catch`, while normal `try`
   completion retains its separate environment; two throwing arms share the
   same phi contract. Mandatory `finally` now projects and joins the
   outer-visible snapshots owned by normal, direct-return, and supported typed
   throw/catch-return predecessors. The next step is to extend edge-owned local
   flow through scalar switches before loops.
2. [Unified Promise, exception, and resource flow](https://github.com/mizchi/uneffect/issues/9)
   must make rejection handling and disposal guarantees compositional.
3. [TypeScript project and compiler parity](https://github.com/mizchi/uneffect/issues/20)
   now preserves separate referenced-project compiler domains in both the CLI
   and programmatic verifier and exposes version drift before a consumer relies
   on TypeChecker-derived evidence; cross-project summaries and declaration
   build-artifact validation are implemented; general cross-project refinement
   and non-identical declaration-transform validation remain.
4. [Module initialization semantics](https://github.com/mizchi/uneffect/issues/18)
   must extend the current conservative module summaries to exact ESM cycles,
   top-level await, external packages, and dynamic initialization boundaries.

[Reachability, vacuity, and deadlock](https://github.com/mizchi/uneffect/issues/1)
is complete for the documented bounded, finite-state-complete, inductive,
strengthened, and reachable-lasso proof modes. General infinite-state
reachability is intentionally reported as bounded/inconclusive unless a proof
rule applies; absence of a bounded witness is never promoted to a proof.

These are the highest-priority soundness gaps because they determine whether a
local result survives composition with real application control flow.

[Native/WASM Z3 backend reliability](https://github.com/mizchi/uneffect/issues/17)
is complete for all current solver clients. It preserves attempts and falls
back only after classified infrastructure failure. The matching
[external-verifier process boundary](https://github.com/mizchi/uneffect/issues/22)
is also complete: child Quint `ETIMEDOUT` failures receive bounded file-level
retry with retained evidence, while semantic failures are never retried.

[Reviewed synchronous compiler callback timing](https://github.com/mizchi/uneffect/issues/21)
is complete for the exact TypeScript 6.0.3 symbol-identified fragment documented
in `feature-matrix.md`; dynamic arrays and other compiler versions remain
explicit conservative boundaries rather than untracked support.

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
3. [Independently checkable evidence](https://github.com/mizchi/uneffect/issues/7)
   evaluates certificates and narrows the trusted computing base.
4. [React function component lifecycle semantics](https://github.com/mizchi/uneffect/issues/16)
   extends the tested symbol-resolved lifecycle fragment through dynamic
   component/Hook flow, server boundaries, and broader concurrent scheduling.
[DOM property getter/setter effects](https://github.com/mizchi/uneffect/issues/14)
is complete for the reviewed overlay. Unreviewed Web IDL members and dynamic
DOM keys remain explicit conservative boundaries in `feature-matrix.md`, not
an untracked continuation of the closed issue.

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
- Keep a red `main` CI regression as a numbered P0 issue with the failing run,
  exact acceptance gate, and a negative control; close it only after remote CI
  passes on the fixing commit.

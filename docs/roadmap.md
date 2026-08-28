# Roadmap and known gaps

Completed implementation details live in `implementation-status.md` and the
historical `TODO.md` ledger. `feature-matrix.md` is the compact boundary view.
GitHub Issues and their matching Phase milestones are the source of truth for
future work. The ordering below reflects dependency and soundness risk, not a
release date commitment. See `remaining-work-estimate.md` for issue-level effort
ranges, uncertainty, and recommended delivery checkpoints. The current additive
estimate is 51–102 engineer-weeks; this is implementation volume, not a calendar
commitment.

## Phase 1 — Make proof boundaries dependable

1. [General TypeScript-to-model refinement](https://github.com/mizchi/uneffect/issues/3)
   completed the shared exception-aware completion handoff used by refinement
   and Promise/resource analysis. Its tested bounded fragment includes scalar
   snapshot joins, owned transfers, selected affine loop summaries, and
   catch/finally completion routing. Remaining arbitrary CFG fixed points are
   owned by [#25](https://github.com/mizchi/uneffect/issues/25); alias,
   higher-order, dynamic-dispatch, and abstraction evidence is owned by
   [#24](https://github.com/mizchi/uneffect/issues/24). See
   `implementation-status.md` and `feature-matrix.md` for the detailed completed
   fragment and exclusions.
2. [Unified Promise, exception, and resource flow](https://github.com/mizchi/uneffect/issues/9)
   is complete for its documented bounded scope. Its outer `continue`/`break`, mixed-disposal rejection,
   restricted nested-scope conditional-join, and single caught inner-disposal
   rejection slices are implemented. A two-resource protected disposal stack
   now completes before catch and retains a finite single/suppressed failure
   kind. One Boolean branch-correlated resource cleanup/handler join is also
   implemented, as is one exhaustive finite string-literal `switch` with three
   branch-local resources. One three-leaf nested Boolean decision tree is also
   implemented. One finite switch with a nested Boolean preferred choice and a
   default backup is also implemented. Two independent finite resource
   decisions may now reconverge sequentially with an explicit
   dispose-before-next-acquire invariant. One bounded early-return-versus-normal
   decision now retains cleanup and mandatory `finally` while excluding later
   normal work. Its typed throw-versus-normal counterpart now cleans up before
   catch, distinguishes recovery from rethrow, and excludes later normal work
   without weakening floating-error checks. Branch-selected resource generations
   are preserved through one canonical two-iteration outer loop with cleanup
   before the iteration join. General scalar CFG
   fixed points and dynamic alias evidence are separately owned by #25 and #24.
3. [TypeScript project and compiler parity](https://github.com/mizchi/uneffect/issues/20)
   now preserves separate referenced-project compiler domains in both the CLI
   and programmatic verifier and exposes version drift before a consumer relies
   on TypeChecker-derived evidence; cross-project summaries and declaration
   build-artifact validation are implemented. A direct, locally verified scalar
   refinement action now composes across an exact declaration boundary with
   producer/consumer provenance and parent revalidation. A guarded child action
   composes only through a sole direct wrapper call and records its inherited
   guard. One edge may cross at most two TypeChecker-resolved, write-screened
   source-local sole-call helpers while retaining its call path, explicit depth
   budget, and child guard. An opt-in version-matched runtime annotation also
   preserves the TypeChecker-resolved same-realm `globalThis` identity without
   equating host aliases or other Realms. A versioned/labeled Node `global`
   identity additionally binds the matching `@types/node` major and rejects
   incompatible labels, versions, and local shadows. A third helper,
   helper-local control flow, collection edges, guarded wrappers with extra
   work, broader runtime identities, and non-identical declaration-transform
   validation remain outside this completed bounded handoff. It consumes the
   completed #3 summary contract and does not technically depend on completion
   of #9. A second read-only solution graph (`luna.mbt`) validates the
   multi-domain loader and honest `not-applicable` composition result. A
   subsequent Workhub-derived `StateStore.set` edge adds an attempted marker to
   the real async class-method shape and retains that unsupported shape as a
   source-attributed violation rather than widening it into the scalar fragment.
   A versioned declaration-transform mapping supports one digest/compiler-bound
   exact embedded-TypeScript span profile through the CLI and programmatic
   verifier. Surrounding host semantics and non-identity transforms remain
   non-proofs. Broader browser/Worker realm work remains in #10 and semantic
   frontend mappings remain in #8.
4. [Module initialization semantics](https://github.com/mizchi/uneffect/issues/18)
   now has one exact synchronous, side-effect-only simple-ring family with
   source/compiler-bound DFS ordering evidence and one exact direct
   cross-project straight-line top-level-await family with declaration-bound
   completion evidence. Runtime-binding and general-shape cycles, conditional
   async joins, external packages, and dynamic initialization remain explicit
   non-proofs. The available application graphs contained no real TLA candidate,
   so broader widening is queued behind #25 or new application evidence.

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

1. [General refinement CFG fixed points](https://github.com/mizchi/uneffect/issues/23)
   replaces the bounded path walker with explicit fixed points and proof budgets
   while preserving completion kinds and fail-closed non-convergence. The first
   affine ranking-loop seed now has independent Z3 base/step/ranking validation.
   Resource-free dynamic outer-loop `continue` ownership is also retained and
   lowered as nondeterministic repeat-or-exit. One application-backed direct
   `switch`/`catch`/mandatory-`finally` join now emits budgeted completion CFG
   evidence. Reusable source-keyed AST-to-basic-block lowering now covers one
   nested handler root, surrounding supported statements, exact caught-path
   correlation, abrupt finalizer override, and the canonical ranking-loop
   topology. Exactly two sibling top-level `if` roots now compose under a named
   root budget while excess or mixed roots fail closed. One handler-local
   `for...of` over one to four literal values now unrolls into
   iteration-qualified blocks; dynamic, resource-bearing, and transfer-heavy
   loops fail closed. One depth-two nested try/catch now routes inner recovery
   and rethrow through the outer handler under a named nesting budget. Nested
   regions now use source-keyed IDs and up to three sibling nested-try regions
   compose under the shape-specific root budget. [#28](https://github.com/mizchi/uneffect/issues/28)
   carries one changed integer through those regions and requires an independent
   Z3 equivalence proof; [#29](https://github.com/mizchi/uneffect/issues/29)
   completes the two-member product handoff. General value joins and recurrence
   widening continue in [#25](https://github.com/mizchi/uneffect/issues/25).
   [#30](https://github.com/mizchi/uneffect/issues/30) completes the bounded
   three-region linear product. [#31](https://github.com/mizchi/uneffect/issues/31)
   completes the first divergent product join.
   [#32](https://github.com/mizchi/uneffect/issues/32) moves one direct affine
   recurrence onto a source-bound CFG back edge. Its active next diamond child
   is [#33](https://github.com/mizchi/uneffect/issues/33).
   The first
   local mutable-alias slice [#26](https://github.com/mizchi/uneffect/issues/26)
   is complete.
2. [General invariant synthesis and temporal formulas](https://github.com/mizchi/uneffect/issues/2)
   adds bounded polyhedral, quantified, collection-correlated, and nested
   temporal reasoning.
3. [Collection-valued state and TLC interoperability](https://github.com/mizchi/uneffect/issues/5)
   makes Node Lease-style models direct and preserves external counterexamples.
4. [Constructive property generation and shrinking](https://github.com/mizchi/uneffect/issues/4)
   reduces filtering and covers recursive/user-defined refinements.
5. [Typed-array and SHA-256 verification](https://github.com/mizchi/uneffect/issues/6)
   completes alias, resize, control-flow, and shared-memory reasoning.

## Phase 3 — Production integration and trust

1. [Interprocedural alias and dynamic refinement evidence](https://github.com/mizchi/uneffect/issues/24)
   adds explicit region identity, higher-order summaries, closed-world dispatch,
   and checkable abstraction relations without treating assumptions as proofs.
   Its first executable child [#26](https://github.com/mizchi/uneffect/issues/26)
   is complete for one non-escaping mutable alias through one
   TypeChecker-resolved local helper.
2. [Native Corsa semantic parity](https://github.com/mizchi/uneffect/issues/8)
   moves inferred facts and ordered events off the TypeScript reference adapter.
   Its first checker-backed inferred-`Console` and ordered-local-call slice
   [#27](https://github.com/mizchi/uneffect/issues/27) is complete; broader
   builtin and neutral-IR coverage remains open.
3. [Complete Node and Web event-loop ownership](https://github.com/mizchi/uneffect/issues/10)
   fills host phases, dynamic cancellation, and polymorphic callback gaps.
4. [Independently checkable evidence](https://github.com/mizchi/uneffect/issues/7)
   evaluates certificates and narrows the trusted computing base.
5. [React function component lifecycle semantics](https://github.com/mizchi/uneffect/issues/16)
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

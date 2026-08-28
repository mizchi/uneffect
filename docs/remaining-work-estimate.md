# Remaining work estimate

Last reconciled with `main` and open GitHub Issues: 2026-08-28.

This document estimates remaining implementation volume. GitHub Issues own the
executable acceptance criteria; `TODO.md` remains the historical ledger. The
estimates are engineering effort, not delivery dates, and include TDD, negative
controls, benchmarks, dogfood, documentation, and CI stabilization.

## Estimation scale

| Label | Estimated effort | Intended meaning |
| --- | ---: | --- |
| `effort:S` | less than 1 engineer-week | One bounded slice or research decision |
| `effort:M` | 1–4 engineer-weeks | Several bounded slices in an existing subsystem |
| `effort:L` | 3–8 engineer-weeks | A new analysis dimension or substantial backend work |
| `effort:XL` | 6–12 engineer-weeks | Cross-cutting work; split before activation |

Ranges assume one engineer familiar with the repository. Solver behavior,
ECMAScript/host semantic research, and TypeChecker/Corsa integration are the
main uncertainty multipliers. An `XL` Issue is an epic-sized tracking boundary,
not a suitable single implementation branch.

## Phase estimates

| Phase | Issues | Remaining effort | Confidence |
| --- | --- | ---: | --- |
| 1 — Proof boundaries | #18 | 2–4 engineer-weeks | Medium |
| 2 — Specification expressiveness | #23, #2, #5, #4, #6 | 17–35 engineer-weeks | Low–medium |
| 3 — Production integration | #24, #8, #10, #7, #16 | 24–47 engineer-weeks | Low |
| 4 — Proof consumers | #13 | 6–12 engineer-weeks | Low |
| **Total additive effort** | 12 open Issues | **49–96 engineer-weeks** | Low |

The total is deliberately additive and must not be read as calendar duration or
as the cost of a useful first release. Some Phase 2/3 research can run
independently, but dependencies and the policy of keeping only one active
proof-boundary Issue limit useful parallelism.

There are three useful planning numbers:

- **Deferred Phase 1 breadth: 2–4 engineer-weeks.** #20 and both bounded #18
  seeds are complete. The available application graphs contained no real TLA
  candidate, so wider module semantics wait for #23 or new application evidence.
- **One focused product line: roughly 10–26 engineer-weeks after Phase 1.** For
  example, Node Lease prioritizes #23, #2, and #5; numeric/SHA-256 work
  prioritizes #23, the first #24 alias slice, and #6. These alternatives should
  not be added together unless both products are required.
- **All currently requested work: 49–96 engineer-weeks.** This includes
  production integration, broad React/event-loop semantics, native parity, and
  proof-consuming optimization. It is a multi-phase research backlog.

## Scope cuts and decision points

The estimates should be used as successive investment decisions, not as one
commitment to implement every row:

| Decision point | Include | Exclude for this cut | Estimate | Exit decision |
| --- | --- | --- | ---: | --- |
| A — proof-boundary MVP | #20 plus synchronous-ring and direct cross-project TLA seeds | General CFG, aliases, broad host/framework semantics | Completed; 2–4 weeks of broader #18 work remains deferred | Application survey found no real TLA candidate; retain the narrow boundary and move to the reusable CFG core. |
| B — reusable analyzer core | #23; first bounded child slices of #24 and #8 | General dynamic dispatch, complete Corsa parity, specialized products | 7–14 additional weeks | Confirm that new domains use shared CFG/alias/frontend facts rather than shape-specific walkers. |
| C1 — temporal/Node Lease product | #2 and #5, consuming the core where needed | Property generators and complete SHA-256 | 7–14 weeks for these two Issues; roughly 10–20 weeks after Phase 1 when #23 is included | A realistic lease model checks, decodes, and replays a counterexample across supported backends. |
| C2 — generated-test/numeric product | #4 and #6, consuming the core where needed | General temporal collections and broad React/event-loop work | 9–17 weeks for #4/#6; roughly 13–26 weeks after Phase 1 when #23 and one bounded #24 alias slice are included | Refinement-preserving shrinking works and a complete SHA-256 case is either verified or reports every proof gap. |
| D — production breadth | Selected #7/#10/#16 plus remaining #8/#24 | Optimizer transformations | 18–35 weeks before overlap and re-estimation | Choose only the host/framework surfaces justified by dogfood evidence. |
| E — proof consumer | #13 | Any rewrite not authorized by replayable evidence | 6–12 weeks | Ship or reject one fail-closed stable-read transformation before considering general compression/mangling. |

C1 and C2 are alternatives unless both product outcomes are required. D is not
a single release: #10 and #16 are separate host/framework product bets. The
49–96 week total remains additive and intentionally ignores speculative
parallel speed-up.

## Executable work packages

The epic totals above are useful for investment planning, but they are too wide
for day-to-day execution. The following packages are the only work currently
ready, or conditionally ready, to enter a Red/Green cycle:

| Package | Owning Issue | State | Estimate | Exit condition |
| --- | --- | --- | ---: | --- |
| P1.1 realistic project edge | #20 | Completed | under 1 week actual | The Workhub-derived async class-method edge retains a source-attributed unsupported-shape blocker; removing the marker is `not-applicable`, not proof. |
| P1.2a declaration-transform seed | #20 | Completed | completed in the current delivery | The strict manifest schema, CLI/programmatic APIs, exact-span/digest/compiler drift controls, report evidence, docs, and package checks are covered by local and CI gates. |
| P1.2b realm-identity seed | #20 | Completed | completed in the current delivery | Versioned/labeled Node ambient `global` composes while incompatible labels, typings majors, and local shadows fail closed with machine-readable evidence. |
| P1.3 synchronous cycle seed | #18 | Completed | under 1 week actual | A synchronous side-effect-only simple ring has executable DFS ordering evidence; runtime-binding, general-shape, and async cycles stay `unknown`. |
| P1.4 cross-project TLA seed | #18 | Completed | under 1 week actual | One exact direct child source/declaration with one straight-line TLA composes; conditional/looping await and await-then-throw stay `unknown`. |
| P2.1 CFG fixed-point seed | #23 | Completed | under 1 week actual | The direct ranking-loop throw/normal join converges under a named budget and its summary receives independent Z3 base/step/ranking validation; unaligned recurrence stays `unknown`. |
| P2.2 target-aware outer-loop transfer | #23 | Completed | under 1 week actual | Resource-free dynamic outer-loop `continue` is consumed by its lexical owner; unresolved labels and resource-bearing dynamic loops stay `unknown`. |
| P2.3 direct handler-join CFG seed | #23 | Completed | under 1 week actual | One application direct `switch`/`catch`/mandatory-`finally` join emits budgeted completion states; exhaustion and action mismatches stay `unknown`. |
| P2.4 reusable nested-handler lowering | #23 | Completed | under 1 week actual | Source-keyed blocks lower one nested `if`/throw/catch application family; attempted-family unsupported control remains an explicit non-proof. |
| P2.5 handler-sequence lowering | #23 | Completed | under 1 week actual | Supported prefix/suffix statements retain abrupt suffix exclusion; the wider scan exposes one path-value mismatch as `unknown`. |
| P3.1 local alias seed | #24 | Queued behind #23 where CFG-sensitive | 1–2 weeks | One non-escaping mutable object alias through a local helper is proven; escape and dynamic selection remain negative controls. |

P1.2a through P1.4 are complete. P2.1 is active next because general CFG joins
are now shared dependencies for refinements, typed arrays, aliases, and future
module widening. P2.1 and P3.1 are planning-sized first slices, not a
claim that their owning epics are otherwise complete.

P2.1 is complete for its direct affine seed: one normal/typed-throw catch join
emits a strict budgeted artifact, the reusable worklist carries payload,
snapshot, phi, and recurrence-certificate facts through its back-edge, and an
optional Z3 pass independently proves base, per-state inductive step, and
ranking obligations. P2.2 applied one lexical-owner rule to all seven prior
self-dogfood diagnostics. Generated Quint represents dynamic cardinality by
nondeterministic repeat or exit, which preserves routing but does not establish
termination or fairness.
P2.3 applies the same named worklist budget to the telemetry routing
`switch`/`catch`/mandatory-`finally` join. P2.4 replaces that completion
classifier with reusable source-keyed statement/basic-block construction and
also lowers the existing nested `if`/throw/catch rejection action. Unsupported
control reached inside this selected family is an explicit
`unsupported-control-flow` non-proof. P2.5 spans supported prefix and suffix
statements around one control root. The real `returnOrRejectTelemetry` action
verifies, while the newly surfaced `rejectTelemetry` mismatch remains honestly
`unknown` until CFG path predicates feed the value join. Nested try,
handler-local loops, and general joins remain open.

## Dependency-critical order

1. #20 is complete. The Workhub-derived `StateStore.set` edge on `main` retains its
   unsupported async class-method marker as a machine-readable violation. The
   completed declaration-transform slice admits one explicitly configured non-TypeScript declaration
   transform only when input/output/compiler/transform identity and spans are
   bound. The completed Node realm seed requires a matching `@types/node` major
   and explicit realm label. Broader non-identity transform semantics belong to
   #8; cross-realm, higher-order, and collection-valued cases remain non-proofs
   under their owning Issues.
2. #18's two bounded handoff seeds are complete; broader widening is queued
   until #23 or a real application boundary justifies a specific family.
3. #23 is active and precedes CFG-sensitive portions of #6, #24, and #13.
4. #24 and #8 provide alias/frontend evidence required before #13 can authorize
   transformations.
5. #2/#5 and #4/#6 are selected according to the next dogfood product, rather
   than being treated as one mandatory serial queue.

No Phase 3 or Phase 4 Issue should pre-empt #23 merely because it has an
attractive isolated demo. New work that exposes a soundness dependency should
be added to the owning Issue and reflected here before implementation begins.

## Issue-level remaining volume

| Order | Issue | Size | Estimate | Next independently testable result | Main uncertainty |
| ---: | --- | --- | ---: | --- | --- |
| 1 | #23 general refinement CFG | L | 1–2 weeks total remaining | Correlate handler CFG predicates with one application value join | Arbitrary joins, recurrence widening, loops, and irreducible control |
| 2 | #18 module initialization | M | 2–4 weeks | Select one wider family only after CFG or application evidence | Async evaluation joins, host packages, and dynamic imports |
| 3 | #2 temporal synthesis/formulas | L | 4–8 weeks | One bounded polyhedral or quantified invariant family | Candidate explosion and backend parity |
| 4 | #5 collection temporal state/TLC | L | 3–6 weeks | Direct finite node-indexed lease state | Collection semantics and external trace interoperability |
| 5 | #4 property generation/shrinking | L | 3–5 weeks | Constructive generator and refinement-preserving shrinker | User predicates and recursion budgets |
| 6 | #6 typed arrays/SHA-256 | XL | 6–12 weeks | Interprocedural non-escaping typed-array alias slice | Resize/shared memory plus #23/#24 dependencies |
| 7 | #24 aliases/dynamic refinement | XL | 6–12 weeks | One non-escaping mutable alias through a local helper | Region identity, higher-order flow, and closed-world dispatch |
| 8 | #8 native Corsa parity | L | 4–7 weeks | Type-aware inferred-effect parity for a small fixture corpus | Corsa API maturity and source/type identity mapping |
| 9 | #10 event-loop ownership | XL | 6–12 weeks | One cited poll/I/O callback family | Host/version differences, realms, and dynamic cancellation |
| 10 | #7 independently checkable evidence | M | 2–4 weeks | Design decision plus one certificate/replay experiment | Solver proof formats may force a measured rejection |
| 11 | #16 React lifecycle | XL | 6–12 weeks | One dynamic component/Hook flow slice | Concurrency, server boundaries, and dynamic ownership |
| 12 | #13 proof-gated optimization | XL | 6–12 weeks | Fail-closed stable-read reuse transformation | Depends on evidence, aliases, CFG, and frontend parity |

## Recommended delivery checkpoints

1. **Usable async module proof boundary:** completed for one direct exact
   cross-project straight-line TLA dependency. The real-application survey found
   no positive candidate, so do not generalize speculatively.
2. **General analysis foundation (7–14 additional weeks):** continue with #23,
   #24's first alias slices, and #8's fact parity before widening specialized
   models. This reduces repeated shape-specific lowering.
3. **Specification breadth (remaining Phase 2):** select #2/#5 for temporal and
   Node Lease use cases, or #4/#6 for generated tests and numeric code. These are
   product choices rather than a single mandatory chain.
4. **Proof consumers and broad framework semantics:** keep #13 and the unbounded
   portions of #16/#10 behind evidence and analysis foundations. Do not present
   their current bounded models as general language semantics.

## Near-term capacity view

This is the smallest useful scheduling view for one engineer. It deliberately
separates committed `main` from worktree progress.

| Horizon | Work | Expected volume | Decision at the end |
| --- | --- | ---: | --- |
| Completed slice | P1.2a declaration transforms | completed | Strict schema, CLI/programmatic API, negative controls, report evidence, docs, and package gates agree. |
| Completed slice | P1.2b one explicit Node realm identity | completed | Exact matching label/typings evidence and incompatible-realm controls close #20's bounded handoff. |
| Completed slice | P1.3 synchronous cycle seed | under 1 engineer-week actual | Strict cycle-component evidence admits only side-effect-only simple rings and fails closed on runtime-binding/general/async cycles. |
| Completed slice | P1.4 cross-project TLA seed | under 1 engineer-week actual | Exact declaration/source and resume/reject evidence compose; application survey found no eligible real boundary. |
| Completed sub-slice | P2.1a CFG reachability seed | under 1 engineer-week actual | A strict artifact records one direct ranking-loop throw/normal join, named budget, convergence, and fail-closed negative controls. |
| Completed sub-slice | P2.1b abstract completion-value seed | under 1 engineer-week actual | A reusable monotone basic-block solver carries source-bound payload/snapshot facts and fails closed on budget/conflict. |
| Completed sub-slice | P2.1c direct expression-value join | under 1 engineer-week actual | Throw-specialized predecessor environments produce a correlated phi snapshot in the reusable worklist. |
| Completed sub-slice | P2.1d1 recurrence-certificate convergence | under 1 engineer-week actual | The worklist carries and stabilizes the affine ranking counter, transformer, and closed-form summary; coupled/self-amplifying recurrences stay `unknown`. |
| Completed sub-slice | P2.1d2 independent recurrence validation | under 1 engineer-week actual | Z3 proves base, per-state inductive step, and ranking obligations; summary/ranking faults refute and solver failure is `unknown`. |
| Completed sub-slice | P2.2 target-aware owner consumption | under 1 engineer-week actual | One lexical rule removed all seven real resource-free outer-loop `continue` diagnostics while preserving unresolved-label and dynamic-resource negative controls. |
| Completed sub-slice | P2.3 direct handler-join CFG seed | under 1 engineer-week actual | The telemetry routing switch/catch/finally join converges in six worklist steps; focused analysis measured 2.6685 ms mean over 189 samples. |
| Completed sub-slice | P2.4 reusable nested-handler lowering | under 1 engineer-week actual | Nested-if/catch lowering measured 2.1111 ms mean over 237 samples; attempted-family unsupported control produces machine-readable `unknown`. |
| Completed sub-slice | P2.5 handler-sequence lowering | under 1 engineer-week actual | `returnOrRejectTelemetry` preserves abrupt suffix exclusion; focused analysis measured 2.0640 ms mean over 243 samples. |
| Current slice | P2.6 path-correlated handler values | 1 engineer-week | Use CFG predicates to prove or retain the application-backed redundant nested-ternary mismatch. |

P1.2a establishes exact embedded TypeScript span identity only. A semantic
mapping beyond that relation is new scope and must be estimated separately
rather than silently absorbed.

The #23 issue-level estimate is now 1–2 weeks after completing P2.5. The shared
builder covers one nested control root plus surrounding supported statements.
Path-correlated values, arbitrary joins, loop lowering, and general recurrence
widening remain the dominant uncertainty.

## Backlog interpretation

- **Next implementable result:** P2.6 in #23, estimated at 1 engineer-week.
- **Next foundation checkpoint:** finish and re-estimate #23, then activate a
  bounded #24 alias slice and a bounded #8 native-fact slice; the three-Issue
  foundation is 7–14 engineer-weeks in total, including #23.
- **Next product choice:** choose either #2/#5 for Node Lease and temporal state,
  or #4/#6 for generated tests and numeric verification. The two paths are not
  both required for an initial useful release.
- **Deferred breadth:** #18, #7, #10, #16, and #13 remain queued until application
  evidence or their dependencies justify a bounded slice.
- **Entire open backlog:** 49–96 engineer-weeks. This is an additive research
  inventory, not a release estimate and not a claim that all work should ship.

## Re-estimation policy

- Re-estimate an Issue when its first Red test exposes a new general CFG, alias,
  host-semantics, or solver limitation.
- Split any `XL` Issue into an executable child Issue before setting it active.
- Record actual benchmark and implementation effort when a slice closes; use it
  to narrow the next estimate.
- At every delivery decision point, compare estimated and actual elapsed
  engineering effort, record scope added or removed, and replace the remaining
  range rather than preserving a stale baseline.
- A proof result that depends on an unimplemented boundary remains `unknown`;
  schedule pressure does not reduce the acceptance criteria.

## Estimate status and non-claims

- #9 is excluded from the remaining estimate after commit `5dfdb0e` passed all
  local checks and remote CI run 33105172614. General CFG and escaping-alias
  work discovered during #9 remains counted in #23 and #24.
- Estimates for #6, #10, #13, #16, and #24 remain epic-level placeholders. Each must be
  split into a bounded child Issue before activation; their upper bounds are
  materially less certain than Phase 1.
- No estimate assumes that bounded Quint exploration proves unbounded JavaScript
  or host semantics. Unsupported CFG, alias, host, and solver cases stay
  explicit `unknown` results.

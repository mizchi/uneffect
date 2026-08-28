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
| 1 — Proof boundaries | #18 | 3–6 engineer-weeks | Medium |
| 2 — Specification expressiveness | #23, #2, #5, #4, #6 | 20–38 engineer-weeks | Low–medium |
| 3 — Production integration | #24, #8, #10, #7, #16 | 24–47 engineer-weeks | Low |
| 4 — Proof consumers | #13 | 6–12 engineer-weeks | Low |
| **Total additive effort** | 12 open Issues | **53–103 engineer-weeks** | Low |

The total is deliberately additive and must not be read as calendar duration or
as the cost of a useful first release. Some Phase 2/3 research can run
independently, but dependencies and the policy of keeping only one active
proof-boundary Issue limit useful parallelism.

There are three useful planning numbers:

- **Remaining Phase 1 critical path: 3–6 engineer-weeks.** #20 is complete;
  implement and widen the exact #18 module-ordering fragment.
- **One focused product line: roughly 11–27 engineer-weeks after Phase 1.** For
  example, Node Lease prioritizes #23, #2, and #5; numeric/SHA-256 work
  prioritizes #23, the first #24 alias slice, and #6. These alternatives should
  not be added together unless both products are required.
- **All currently requested work: 53–103 engineer-weeks.** This includes
  production integration, broad React/event-loop semantics, native parity, and
  proof-consuming optimization. It is a multi-phase research backlog.

## Scope cuts and decision points

The estimates should be used as successive investment decisions, not as one
commitment to implement every row:

| Decision point | Include | Exclude for this cut | Estimate | Exit decision |
| --- | --- | --- | ---: | --- |
| A — proof-boundary MVP | Implement one exact #18 ESM/TLA fragment after completed #20 | General CFG, aliases, broad host/framework semantics | 1–2 weeks for the next seed; 3–6 weeks for remaining #18 | Dogfood on a solution-style Node application and decide whether project/module evidence is useful enough to continue. |
| B — reusable analyzer core | #23; first bounded child slices of #24 and #8 | General dynamic dispatch, complete Corsa parity, specialized products | 10–19 additional weeks | Confirm that new domains use shared CFG/alias/frontend facts rather than shape-specific walkers. |
| C1 — temporal/Node Lease product | #2 and #5, consuming the core where needed | Property generators and complete SHA-256 | 7–14 weeks for these two Issues; roughly 11–21 weeks after Phase 1 when #23 is included | A realistic lease model checks, decodes, and replays a counterexample across supported backends. |
| C2 — generated-test/numeric product | #4 and #6, consuming the core where needed | General temporal collections and broad React/event-loop work | 9–17 weeks for #4/#6; roughly 14–27 weeks after Phase 1 when #23 and one bounded #24 alias slice are included | Refinement-preserving shrinking works and a complete SHA-256 case is either verified or reports every proof gap. |
| D — production breadth | Selected #7/#10/#16 plus remaining #8/#24 | Optimizer transformations | 18–35 weeks before overlap and re-estimation | Choose only the host/framework surfaces justified by dogfood evidence. |
| E — proof consumer | #13 | Any rewrite not authorized by replayable evidence | 6–12 weeks | Ship or reject one fail-closed stable-read transformation before considering general compression/mangling. |

C1 and C2 are alternatives unless both product outcomes are required. D is not
a single release: #10 and #16 are separate host/framework product bets. The
53–103 week total remains additive and intentionally ignores speculative
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
| P1.3 exact module-order seed | #18 | Active next slice | 1–2 weeks | One cyclic ESM or straight-line TLA family has executable ordering evidence and adjacent failure controls. |
| P2.1 CFG fixed-point seed | #23 | Queued | 1–2 weeks | The Issue's ranking-proven loop/throw join passes within an explicit proof budget and the unaligned recurrence stays `unknown`. |
| P3.1 local alias seed | #24 | Queued behind #23 where CFG-sensitive | 1–2 weeks | One non-escaping mutable object alias through a local helper is proven; escape and dynamic selection remain negative controls. |

P1.2a and P1.2b are complete. P1.3 is active next because #20 now supplies
dependable cross-project evidence. P2.1 and P3.1 are planning-sized first slices, not a
claim that their owning epics are otherwise complete.

## Dependency-critical order

1. #20 is complete. The Workhub-derived `StateStore.set` edge on `main` retains its
   unsupported async class-method marker as a machine-readable violation. The
   completed declaration-transform slice admits one explicitly configured non-TypeScript declaration
   transform only when input/output/compiler/transform identity and spans are
   bound. After it lands, the next independent slice is one explicit non-global
   realm identity. The Node seed now requires matching `@types/node` major and
   explicit realm label. Broader cross-realm, higher-order, and collection-valued
   cases remain non-proofs under their owning Issues.
2. #18 is active after the #20 project-boundary handoff.
3. #23 precedes CFG-sensitive portions of #6, #24, and #13.
4. #24 and #8 provide alias/frontend evidence required before #13 can authorize
   transformations.
5. #2/#5 and #4/#6 are selected according to the next dogfood product, rather
   than being treated as one mandatory serial queue.

No Phase 3 or Phase 4 Issue should pre-empt #18 merely because it has an
attractive isolated demo. New work that exposes a soundness dependency should
be added to the owning Issue and reflected here before implementation begins.

## Issue-level remaining volume

| Order | Issue | Size | Estimate | Next independently testable result | Main uncertainty |
| ---: | --- | --- | ---: | --- | --- |
| 1 | #18 module initialization | L | 3–6 weeks | One exact cyclic ESM/TLA ordering fragment after completed #20 | Evaluation cycles, host packages, and dynamic imports |
| 2 | #23 general refinement CFG | L | 4–7 weeks | Ranking-proven loop with a throw/normal join | Fixed points, widening, and explicit proof budgets |
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

1. **Usable local proof boundary (1–2 weeks for the next seed):** implement the
   supported exact module-initialization slice in #18 after completed #20. This is the shortest path
   to making assurance survive realistic project composition.
2. **General analysis foundation (10–19 additional weeks):** prioritize #23,
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
| Current slice | P1.3 exact module-order seed | 1–2 engineer-weeks | Establish one exact #18 family and decide whether the Phase 1 MVP is useful in application dogfood. |
| First useful checkpoint | Finish P1.3 plus stabilization | roughly 1–2 engineer-weeks | Re-estimate from actuals before entering CFG, aliases, temporal breadth, or React/event-loop breadth. |

P1.2a establishes exact embedded TypeScript span identity only. A semantic
mapping beyond that relation is new scope and must be estimated separately
rather than silently absorbed.

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

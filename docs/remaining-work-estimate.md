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
| 1 — Proof boundaries | #20, #18 | 4–8 engineer-weeks | Medium |
| 2 — Specification expressiveness | #23, #2, #5, #4, #6 | 18–35 engineer-weeks | Low–medium |
| 3 — Production integration | #24, #8, #10, #7, #16 | 23–45 engineer-weeks | Low |
| 4 — Proof consumers | #13 | 6–12 engineer-weeks | Low |
| **Total additive effort** | 13 open Issues | **51–100 engineer-weeks** | Low |

The total is deliberately additive and must not be read as calendar duration or
as the cost of a useful first release. Some Phase 2/3 research can run
independently, but dependencies and the policy of keeping only one active
proof-boundary Issue limit useful parallelism.

There are three useful planning numbers:

- **Phase 1 critical path: 4–8 engineer-weeks.** Complete #20, then
  implement the first exact #18 module-ordering fragment.
- **One focused product line: roughly 12–27 engineer-weeks after Phase 1.** For
  example, Node Lease prioritizes #23, #2, and #5; numeric/SHA-256 work
  prioritizes #23, the first #24 alias slice, and #6. These alternatives should
  not be added together unless both products are required.
- **All currently requested work: 51–100 engineer-weeks.** This includes
  production integration, broad React/event-loop semantics, native parity, and
  proof-consuming optimization. It is a multi-phase research backlog.

## Scope cuts and decision points

The estimates should be used as successive investment decisions, not as one
commitment to implement every row:

| Decision point | Include | Exclude for this cut | Estimate | Exit decision |
| --- | --- | --- | ---: | --- |
| A — proof-boundary MVP | Finish #20; implement one exact #18 ESM/TLA fragment | General CFG, aliases, broad host/framework semantics | 4–8 weeks total | Dogfood on a solution-style Node application and decide whether project/module evidence is useful enough to continue. |
| B — reusable analyzer core | #23; first bounded child slices of #24 and #8 | General dynamic dispatch, complete Corsa parity, specialized products | 10–19 additional weeks | Confirm that new domains use shared CFG/alias/frontend facts rather than shape-specific walkers. |
| C1 — temporal/Node Lease product | #2 and #5, consuming the core where needed | Property generators and complete SHA-256 | 7–14 weeks for these two Issues; roughly 12–27 weeks after Phase 1 when required core work is included | A realistic lease model checks, decodes, and replays a counterexample across supported backends. |
| C2 — generated-test/numeric product | #4 and #6, consuming the core where needed | General temporal collections and broad React/event-loop work | 7–14 weeks for #4/#6's lower bounds; roughly 12–27 weeks after Phase 1 when required core work is included | Refinement-preserving shrinking works and a complete SHA-256 case is either verified or reports every proof gap. |
| D — production breadth | Selected #7/#10/#16 plus remaining #8/#24 | Optimizer transformations | 17–33 weeks before overlap and re-estimation | Choose only the host/framework surfaces justified by dogfood evidence. |
| E — proof consumer | #13 | Any rewrite not authorized by replayable evidence | 6–12 weeks | Ship or reject one fail-closed stable-read transformation before considering general compression/mangling. |

C1 and C2 are alternatives unless both product outcomes are required. D is not
a single release: #10 and #16 are separate host/framework product bets. The
51–100 week total remains additive and intentionally ignores speculative
parallel speed-up.

## Dependency-critical order

1. #20 is active. Its next slice preserves a guarded scalar child action through
   the supported single local helper without weakening guard identity;
   higher-order, deeper-helper, collection-valued, realm, and
   transformed-declaration cases remain non-proofs.
2. #18 stays blocked until #20's project-boundary evidence is sufficient for
   module-order consumers.
3. #23 precedes CFG-sensitive portions of #6, #24, and #13.
4. #24 and #8 provide alias/frontend evidence required before #13 can authorize
   transformations.
5. #2/#5 and #4/#6 are selected according to the next dogfood product, rather
   than being treated as one mandatory serial queue.

No Phase 3 or Phase 4 Issue should pre-empt #20 merely because it has an
attractive isolated demo. New work that exposes a soundness dependency should
be added to the owning Issue and reflected here before implementation begins.

## Issue-level remaining volume

| Order | Issue | Size | Estimate | Next independently testable result | Main uncertainty |
| ---: | --- | --- | ---: | --- | --- |
| 1 | #20 TypeScript project parity | M | 1–2 weeks | Preserve a guarded scalar action through one write-screened local helper | Declaration transforms, realms, and compiler-domain compatibility |
| 2 | #18 module initialization | L | 3–6 weeks | One exact cyclic ESM/TLA ordering fragment after #20 | Evaluation cycles, host packages, and dynamic imports |
| 3 | #23 general refinement CFG | L | 4–7 weeks | Ranking-proven loop with a throw/normal join | Fixed points, widening, and explicit proof budgets |
| 4 | #2 temporal synthesis/formulas | L | 4–8 weeks | One bounded polyhedral or quantified invariant family | Candidate explosion and backend parity |
| 5 | #5 collection temporal state/TLC | L | 3–6 weeks | Direct finite node-indexed lease state | Collection semantics and external trace interoperability |
| 6 | #4 property generation/shrinking | L | 3–5 weeks | Constructive generator and refinement-preserving shrinker | User predicates and recursion budgets |
| 7 | #6 typed arrays/SHA-256 | XL | 4–9 weeks | Interprocedural non-escaping typed-array alias slice | Resize/shared memory plus #23/#24 dependencies |
| 8 | #24 aliases/dynamic refinement | XL | 6–12 weeks | One non-escaping mutable alias through a local helper | Region identity, higher-order flow, and closed-world dispatch |
| 9 | #8 native Corsa parity | L | 4–7 weeks | Type-aware inferred-effect parity for a small fixture corpus | Corsa API maturity and source/type identity mapping |
| 10 | #10 event-loop ownership | L–XL | 5–10 weeks | One cited poll/I/O callback family | Host/version differences, realms, and dynamic cancellation |
| 11 | #7 independently checkable evidence | M | 2–4 weeks | Design decision plus one certificate/replay experiment | Solver proof formats may force a measured rejection |
| 12 | #16 React lifecycle | XL | 6–12 weeks | One dynamic component/Hook flow slice | Concurrency, server boundaries, and dynamic ownership |
| 13 | #13 proof-gated optimization | XL | 6–12 weeks | Fail-closed stable-read reuse transformation | Depends on evidence, aliases, CFG, and frontend parity |

## Recommended delivery checkpoints

1. **Usable local proof boundary (4–8 weeks):** finish #20, then the
   supported exact module-initialization slice in #18. This is the shortest path
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
- Estimates for #13, #16, and #24 remain epic-level placeholders. Each must be
  split into a bounded child Issue before activation; their upper bounds are
  materially less certain than Phase 1.
- No estimate assumes that bounded Quint exploration proves unbounded JavaScript
  or host semantics. Unsupported CFG, alias, host, and solver cases stay
  explicit `unknown` results.

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
| 1 — Proof boundaries | #9, #20, #18 | 5–10 engineer-weeks | Medium |
| 2 — Specification expressiveness | #23, #2, #5, #4, #6 | 18–35 engineer-weeks | Low–medium |
| 3 — Production integration | #24, #8, #10, #7, #16 | 23–45 engineer-weeks | Low |
| 4 — Proof consumers | #13 | 6–12 engineer-weeks | Low |
| **Total additive effort** | 14 open Issues | **52–102 engineer-weeks** | Low |

The total is deliberately additive and must not be read as calendar duration.
Some Phase 2/3 research can run independently, but dependencies and the policy
of keeping only one active proof-boundary Issue limit useful parallelism.

## Issue-level remaining volume

| Order | Issue | Size | Estimate | Next independently testable result | Main uncertainty |
| ---: | --- | --- | ---: | --- | --- |
| 1 | #9 Promise/exception/resource flow | M | 1–2 weeks | Resource-generation identity through one supported outer loop | Reacquisition, disposal generations, and floating rejection ownership |
| 2 | #20 TypeScript project parity | M | 1–2 weeks | One provenance-preserving scalar refinement across a direct project reference | Declaration transforms and compiler-domain compatibility |
| 3 | #18 module initialization | L | 3–6 weeks | One exact cyclic ESM/TLA ordering fragment after #20 | Evaluation cycles, host packages, and dynamic imports |
| 4 | #23 general refinement CFG | L | 4–7 weeks | Ranking-proven loop with a throw/normal join | Fixed points, widening, and explicit proof budgets |
| 5 | #2 temporal synthesis/formulas | L | 4–8 weeks | One bounded polyhedral or quantified invariant family | Candidate explosion and backend parity |
| 6 | #5 collection temporal state/TLC | L | 3–6 weeks | Direct finite node-indexed lease state | Collection semantics and external trace interoperability |
| 7 | #4 property generation/shrinking | L | 3–5 weeks | Constructive generator and refinement-preserving shrinker | User predicates and recursion budgets |
| 8 | #6 typed arrays/SHA-256 | L–XL | 4–9 weeks | Interprocedural non-escaping typed-array alias slice | Resize/shared memory plus #23/#24 dependencies |
| 9 | #24 aliases/dynamic refinement | XL | 6–12 weeks | One non-escaping mutable alias through a local helper | Region identity, higher-order flow, and closed-world dispatch |
| 10 | #8 native Corsa parity | L | 4–7 weeks | Type-aware inferred-effect parity for a small fixture corpus | Corsa API maturity and source/type identity mapping |
| 11 | #10 event-loop ownership | L–XL | 5–10 weeks | One cited poll/I/O callback family | Host/version differences, realms, and dynamic cancellation |
| 12 | #7 independently checkable evidence | M | 2–4 weeks | Design decision plus one certificate/replay experiment | Solver proof formats may force a measured rejection |
| 13 | #16 React lifecycle | XL | 6–12 weeks | One dynamic component/Hook flow slice | Concurrency, server boundaries, and dynamic ownership |
| 14 | #13 proof-gated optimization | XL | 6–12 weeks | Fail-closed stable-read reuse transformation | Depends on evidence, aliases, CFG, and frontend parity |

## Recommended delivery checkpoints

1. **Usable local proof boundary (5–10 weeks):** finish #9 and #20, then the
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
- A proof result that depends on an unimplemented boundary remains `unknown`;
  schedule pressure does not reduce the acceptance criteria.

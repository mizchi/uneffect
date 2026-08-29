# Remaining work estimate

Last reconciled with `main` and open GitHub Issues: 2026-08-29.

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

The issue-specific ranges below refine the deliberately coarse effort labels.
Those refined ranges are now also recorded in each open Issue body; the phase
totals are calculated from them, not by mechanically adding label bounds.

## Phase estimates

| Phase | Issues | Remaining effort | Confidence |
| --- | --- | ---: | --- |
| 1 — Proof boundaries | #18 after completed child #57 | 1–3 engineer-weeks | Medium |
| 2 — Specification expressiveness | #25, #2, #5, #4, #6 | 16–34 engineer-weeks | Low–medium |
| 3 — Production integration | #24, #8, #10, #7, #16 | 23–48 engineer-weeks | Low |
| 4 — Proof consumers | #13 | 6–12 engineer-weeks | Low |
| **Total additive effort** | 12 open Issues / 11 non-overlapping epics | **46–97 engineer-weeks** | Low |

The total is deliberately additive and must not be read as calendar duration or
as the cost of a useful first release. Some Phase 2/3 research can run
independently, but dependencies and the policy of keeping only one active
bounded implementation Issue limit useful parallelism.

#37 was a bounded child of #25 and is complete. Its effort was included in the
#25 epic range and was never added again to the then-current additive total. The
same rule applies to future child Issues split from an existing epic.

#38 was a bounded child of #25 and is complete. Its effort was included in the
#25 epic range and was not added again to the total.

#39 was a bounded child of #25 and is complete. Its effort was included in the
#25 epic range and was not added again to the total.

#40 was a bounded child of #25 and is complete. Its effort was included in the
#25 epic range and was not added again to the total.

#41 was a bounded child of #25 and is complete. Its effort was included in the
#25 epic range and was not added again to the total.

#42 is a completed bounded child of #5. Its 1–2 engineer-week estimate was included
in the #5 epic range and is not added again to the total.

#43 is a completed bounded child of #5. Its 1–2 engineer-week estimate was
included inside the unchanged #5 epic range and is not added again to the total.

#44 is a completed bounded child of #5. Its 1–2 engineer-week estimate was
included inside the unchanged #5 epic range and is not added again to the total.

#45 is a completed bounded child of #5. Its 1–2 engineer-week slice is included
inside the unchanged #5 epic range rather than added to the total.

#58 is a completed bounded child of #5. Its production-shaped string identity
slice passed the full local/package/dogfood gates and remote CI run 33243601308.
The remaining #5 range narrows from 2–4 to 1–3 engineer-weeks; this removes one
week from both ends of the additive backlog rather than counting the child twice.

#59 is a completed bounded child of #5. Its exact finite literal-record Set
observation passed native/WASM Z3, Quint, TLC import, replay, the full local
gates, and remote CI run 33245382408. The remaining #5 upper bound narrows from
three to two engineer-weeks; the lower bound stays one because correlated
collection and upstream trace work still require at least one bounded slice.

#60 is a completed bounded child of #4. It adds one explicit finite
source-local unary-predicate specialization, real-predicate rechecking,
precondition-preserving shrink, and a vacuity failure. Its focused tests,
Datadog-shaped dogfood, package gates, full local suite, and remote CI run
33247276099 are green. The remaining #4 range narrows from 3–5 to 2–4
engineer-weeks; cross-file, recursive, higher-order, and inferred predicate
domains remain in the parent.

#46 is a completed operational slice. It was created from an observed remote-run
timeout and long integration wall time and closed after two independent green
remote runs retained all three timing artifacts.

#47 is a completed bounded child of #25. Its 1–2 engineer-week planning estimate
was contained in #25's epic range and was not added to the total. It closed
after certificate-binding negative controls, benchmark, documentation, the full
local suite, and remote CI passed.

#48 is a completed child of #25. It extends #47 through one exact catch/finally
handler topology and immutable Boolean activation. Its 1–2 engineer-week
estimate was contained in the parent range and was not added to the total.

#49 is a completed operational reliability slice created from remote run
33227180964. Its fixed 20-second checker test limit overrode the wider isolated
CI allowance; the unchanged failed-job rerun passed. The named 20-second
local/60-second CI policy then passed remote run 33228295670 on its first
attempt. It does not change the research-backlog estimate.

#50 is a completed bounded child of #8. It landed in less than one
engineer-week actual with TDD, negative controls, a benchmark, documentation,
local package/dogfood gates, and seven green remote CI jobs. Its completed
scope narrows #8's remaining epic range from 4–7 to 3–6 engineer-weeks.

#51 is a completed bounded child of #8. It landed in less than one
engineer-week actual and exports the direct/unconditional `await`
Promise-observation handoff surfaced by #50. Conditional control, callback
ownership, rejection handling, and combinators remain outside the result. This
narrows #8's remaining epic range from 3–6 to 2–5 engineer-weeks.

#52 is a completed bounded child of #8. It landed in less than one
engineer-week actual and covers the single-enclosing-`if` conditional-await
handoff required by Workhub XClient. This narrows #8's remaining epic range
from 2–5 to 1–4 engineer-weeks.

#53 is a completed bounded child of #8. It landed in less than one
engineer-week actual and covers direct Promise-call return observations required
by Workhub HTTP clients. This narrows #8's remaining range from 1–4 to 1–3
engineer-weeks.

#54 is a completed bounded child of #8. It landed in less than one engineer-week
actual and covers four exact Workhub-observed async filesystem operations. This
narrows #8's remaining range from 1–3 to 1–2 engineer-weeks.

#55 is a completed bounded child of #8. It landed in less than one engineer-week
actual and covers only direct awaited calls in one catch-protected try block.
This narrows #8's remaining range from 1–2 engineer-weeks to about 1 week.

#56 is a completed bounded child of #8. It landed in less than one engineer-week
actual and covers one exact Workhub function-local awaited dynamic fs import.
The closure audit found no remaining function-level Workhub corpus mismatch,
but it did not prove the broader rejection-binding, resource, callback-timing,
or dynamic-import domains in #8. The epic therefore returns to its `effort:L`
3–8 engineer-week range instead of being falsely reported as nearly complete.

There are three useful planning numbers:

- **Phase 1 remaining breadth: 1–3 engineer-weeks.** #20 and all three bounded
  #18 seeds, including #57's Workhub `main().catch(handler)` family, are complete.
  Another widening requires fresh application evidence or a reusable result
  from #25/#26.
- **One focused product line: 5–16 engineer-weeks after Phase 1.** Node Lease
  prioritizes #2 and #5 (5–10 weeks), consuming the completed #23 CFG. Numeric/SHA-256
  prioritizes #26 and #4/#6 (8–16 weeks). These alternatives
  should not be added together unless both products are required.
- **All currently requested work: 46–97 engineer-weeks.** This includes
  production integration, broad React/event-loop semantics, native parity, and
  proof-consuming optimization. It is a multi-phase research backlog.

## Scope cuts and decision points

The estimates should be used as successive investment decisions, not as one
commitment to implement every row:

| Decision point | Include | Exclude for this cut | Estimate | Exit decision |
| --- | --- | --- | ---: | --- |
| A — proof-boundary MVP | #20 plus synchronous-ring, direct cross-project TLA, and Workhub top-level Promise-launch seeds | General CFG, aliases, broad host/framework semantics | Completed; 1–3 weeks of broader #18 work remains deferred | Retain the three narrow boundaries and re-estimate before another module-order family. |
| B — reusable analyzer core | Completed #23; first 1–2 week bounded slices #26 and #8 | General dynamic dispatch, complete Corsa parity, specialized products | 2–4 additional weeks for the first slices; 10–19 weeks for parent #24 and #8 epics | Confirm that new domains use shared CFG/alias/frontend facts rather than shape-specific walkers. |
| C1 — temporal/Node Lease product | #2 and #5, consuming completed #23 where needed | Property generators and complete SHA-256 | 5–10 weeks | A realistic lease model checks, decodes, and replays a counterexample across supported backends, then one production binding exposes any remaining abstraction gap. |
| C2 — generated-test/numeric product | #4 and #6 plus #26, consuming completed #23 where needed | General temporal collections and broad React/event-loop work | 8–16 weeks | Refinement-preserving shrinking works and a complete SHA-256 case is either verified or reports every proof gap. |
| D — production breadth | Selected #7/#10/#16 plus remaining #8/#24 | Optimizer transformations | 18–35 weeks before overlap and re-estimation | Choose only the host/framework surfaces justified by dogfood evidence. |
| E — proof consumer | #13 | Any rewrite not authorized by replayable evidence | 6–12 weeks | Ship or reject one fail-closed stable-read transformation before considering general compression/mangling. |

C1 and C2 are alternatives unless both product outcomes are required. D is not
a single release: #10 and #16 are separate host/framework product bets. The
46–97 week total remains additive and intentionally ignores speculative
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
| P1.5 Workhub top-level Promise launch | #57 (child of #18) | Completed | under 1 engineer-week actual | One source-local async `main().catch(handler)` emits launch then synchronous handler attachment; nested awaits are not TLA, while async completion and host scheduling remain excluded. Remote CI run 33241857301 is green. |
| P2.1 CFG fixed-point seed | #23 | Completed | under 1 week actual | The direct ranking-loop throw/normal join converges under a named budget and its summary receives independent Z3 base/step/ranking validation; unaligned recurrence stays `unknown`. |
| P2.2 target-aware outer-loop transfer | #23 | Completed | under 1 week actual | Resource-free dynamic outer-loop `continue` is consumed by its lexical owner; unresolved labels and resource-bearing dynamic loops stay `unknown`. |
| P2.3 direct handler-join CFG seed | #23 | Completed | under 1 week actual | One application direct `switch`/`catch`/mandatory-`finally` join emits budgeted completion states; exhaustion and action mismatches stay `unknown`. |
| P2.4 reusable nested-handler lowering | #23 | Completed | under 1 week actual | Source-keyed blocks lower one nested `if`/throw/catch application family; attempted-family unsupported control remains an explicit non-proof. |
| P2.5 handler-sequence lowering | #23 | Completed | under 1 week actual | Supported prefix/suffix statements retain abrupt suffix exclusion; the wider scan exposes one path-value mismatch as `unknown`. |
| P2.6 caught-path value correlation | #23 | Completed | under 1 week actual | Exact same-predicate branch restriction verifies the surfaced mismatch; predicate drift retains a non-proof. |
| P2.7 abrupt-finally override | #23 | Completed | under 1 week actual | Catch-less application finalizer return/throw paths override incoming completion and emit strict metadata. |
| P2.8 ranking-handler CFG reuse | #23 | Completed | under 1 week actual | Canonical ranking-loop evidence traverses the shared handler topology and preserves recurrence/Z3 validation. |
| P2.9 bounded sibling-handler joins | #23 | Completed | under 1 week actual | Exactly two sibling `if` roots retain both throw paths under a named root budget; excess/mixed roots fail closed. |
| P2.10 finite handler-local loop | #23 | Completed | under 1 week actual | A one-to-four literal `for...of` is unrolled with iteration-keyed blocks; dynamic/resource/transfer cases fail closed. |
| P2.11 bounded nested handler | #23 | Completed | under 1 week actual | One depth-two nested try/catch routes inner recovery/rethrow under a named nesting budget; deeper/resource/looped cases fail closed. |
| P2.12 source-keyed nested regions | #23 | Completed | under 1 week actual | Two sibling nested handlers retain distinct source-keyed routing; this initial boundary was later widened by #30. |
| P3.1 local alias seed | #26 (child of #24) | Completed | under 1 week actual | One non-escaping mutable object alias through one TypeChecker-resolved local helper emits source/compiler/symbol/region evidence; escape and dynamic selection remain negative controls. |
| P3.2 checker-backed Corsa fact seed | #27 (child of #8) | Completed | under 1 week actual | One inferred `Console` effect and two ordered local calls reach parity through the real checker path with operation/compiler/declaration/symbol evidence; a same-spelled symbol-distinct object remains effect-free. |
| P2.13 scalar sibling-region value join | #28 (child of #25) | Completed | under 1 week actual | One integer environment joins across two source-keyed sibling handler regions; expression conflict, budget exhaustion, Z3 refutation, and solver unavailability remain non-proofs. |
| P2.14 two-member scalar product join | #29 (child of #25) | Completed | under 1 week actual | Two independently checked integer states share one product environment; one mismatching member prevents verification. |
| P2.15 three-region scalar product | #30 (child of #25) | Completed | under 1 week actual | Carry the two-member product across three source-keyed sibling regions without weakening conflict, budget, or solver controls. |
| P2.16 conditional scalar-product join | #31 (child of #25) | Completed | under 1 week actual | Join branch-selected handler environments before one common successor with explicit predicate and predecessor evidence. |
| P2.17 CFG-inferred affine recurrence | #32 (child of #25) | Completed | under 1 week actual | Infer one source-bound two-member transformer and summary from a reusable CFG back edge, then require Z3 base/step/ranking checks. |
| P2.18 piecewise affine CFG recurrence | #33 (child of #25) | Completed | under 1 week actual | Join one loop-invariant conditional transformer through a source-bound CFG diamond and back edge. |
| P2.19 shared handler/scalar recurrence | #34 (child of #25) | Completed | under 1 week actual | Replace the legacy handler recurrence artifact with one shared scalar recurrence carrying handler-completion evidence. |
| P2.20 two sequential invariant diamonds | #35 (child of #25) | Completed | completed in the current delivery | Compose two source-ordered predicate-correlated affine joins before one shared recurrence back edge. |
| P2.21 finite switch recurrence fan-out | #36 (child of #25) | Completed | under 1 week actual | Compose one integer-discriminated two-case-plus-default join before one shared recurrence back edge. |
| P2.22 common ordered recurrence join IR | #37 (child of #25) | Completed | under 1 engineer-week actual | Migrate diamond/switch evidence into one ordered union and compose one Boolean-then-switch sequence before one shared recurrence back edge. |
| P2.23 upper-triangular affine recurrence | #38 (child of #25) | Completed | under 1 engineer-week actual | Prove one source-ordered constant-delta driver and one affine dependent before one ranking back edge. |
| P2.24 conditional predecessor value | #39 (child of #25) | Completed | under 1 engineer-week actual | Lower one loop-local conditional value into source-bound predecessor evidence independently of statement-shaped joins. |
| P2.25 Boolean involution recurrence | #40 (child of #25) | Completed | completed in the current delivery | Prove one direct Boolean toggle by an exact parity summary while geometric growth remains unknown. |
| P2.26 entry-read triangular recurrence | #41 (child of #25) | Completed | completed in the current delivery | Prove the source-order-sensitive entry-read closed form without admitting cycles or general coupled solving. |
| P2.27 total finite Map lookup | #42 (child of #5) | Completed | completed in the current delivery | Make missing-key lease reads total across Quint, runtime replay, and bounded Z3 while keeping ordinary `Map.get` partial. |
| P2.28 proved dynamic Map key domain | #43 (child of #5) | Completed | completed in the current delivery | Decode a state-derived lookup key only after independently proving membership in an immutable literal finite Set. |
| P2.29 multiple proved Map key domains | #44 (child of #5) | Completed | completed in the current delivery | Prove every primary/backup selector independently and reject the whole observation universe when one key proof fails. |
| P2.30 jointly inductive Map key domains | #45 (child of #5) | Completed | completed in the current delivery | Prove one failover membership conjunction while retaining explicit joint assumptions and whole-universe failure. |
| P2.31 temporal string identities | #58 (child of #5) | Completed | under 1 engineer-week actual | Preserve exact production-shaped node IDs through finite Set/Map, Quint, native/WASM Z3, TLC trace import, and replay while rejecting string arithmetic and unbounded generation. |
| P2.32 record-valued lease grant Sets | #59 (child of #5) | Completed | under 1 engineer-week actual | Extract an exact finite literal record universe through native/WASM Z3 and cross-backend replay while dynamic composite elements remain unknown. Remote CI run 33245382408 is green. |
| P2.33 explicit user-predicate specialization | #60 (child of #4) | Completed | under 1 engineer-week actual | Recheck one finite exported source-local unary predicate in generated Vitest, preserve it during shrink, and reject vacuous or unsupported specializations. Remote CI run 33247276099 is green. |
| P3.3 solver-heavy CI stability | #46 | Completed | completed in the current delivery | Three checked shards, timing artifacts, calibrated timeout, and a real hard-deadline control without weakened obligations. |
| P3.4 checker dogfood timeout policy | #49 | Completed | under 1 engineer-week actual | Replace one observed fixed-timeout false negative with a named finite local/CI policy and a first-attempt green remote run. |
| P3.5 Workhub-shaped checker builtins | #50 (child of #8) | Completed | under 1 engineer-week actual | Exact checker-backed `FsRead`, `FsWrite`, and `Fetch` metadata passes with symbol-distinct controls, tamper rejection, benchmark/docs/full local gates, and CI run 33230163122. Full Promise-record parity remains explicitly false. |
| P3.6 direct-await checker records | #51 (child of #8) | Completed | under 1 engineer-week actual | Exact owner/source/span records for direct unconditional awaits pass while conditional/callback/tampered cases fail closed; CI run 33231761950 is green. |
| P3.7 single-if conditional-await records | #52 (child of #8) | Completed | under 1 engineer-week actual | One exact enclosing-if condition and polarity pass while nested/loop/callback/chain cases remain explicit gaps; CI run 33233277089 is green. |
| P3.8 direct Promise-return records | #53 (child of #8) | Completed | under 1 engineer-week actual | Plain and singly asserted unconditional Promise call returns pass while conditional/non-call/nested-wrapper cases remain explicit gaps; CI run 33234808219 is green. |
| P3.9 Workhub directory/append fs atoms | #54 (child of #8) | Completed | under 1 engineer-week actual | Exact `access`/`readdir` reads and `appendFile`/`mkdir` writes pass while other import/operation forms remain explicit gaps; CI run 33236206431 is green. |
| P3.10 direct caught-await ownership | #55 (child of #8) | Completed | under 1 engineer-week actual | Direct protected try/catch ownership passes while nested/catch/finally shapes and binding ownership remain explicit gaps; CI run 33237679216 is green. |
| P3.11 Workhub dynamic fs import | #56 (child of #8) | Completed | under 1 engineer-week actual | TypeScript and Corsa agree on one exact awaited immutable destructuring import while general dynamic module semantics remain explicit gaps; CI run 33240242470 is green. |

P1.2a through P1.4 and P2.1 through P2.12 are complete. The bounded #23
handoff is closed. #26 has completed the first executable child of #24 and #27
has completed the first checker-backed child of #8. #28 completed the first
scalar-value child of #25 and #29 completed its two-member product environment;
#30 completed three-region composition and #31 completed the first divergent
product join; #32 completes the direct CFG recurrence and #33 completes one
piecewise recurrence, and #34 completes handler/scalar recurrence unification.
#35 completed two sequential invariant diamonds, and #36 completed one bounded
finite `switch` recurrence fan-out. #37 completes their common ordered join IR
and one mixed sequence, while general value
lattices and recurrence widening remain in the parent.

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
handler-local loops, and general joins remain open. P2.6 supplies that exact
syntactic path restriction and records it in the artifact; it does not infer
logical implication between different predicates.
P2.7 adds catch-less abrupt-finally routing and explicit return/throw override
metadata. Its unsupported statements still fail closed.
P2.8 removes the ranking seed's separate handler graph. Its shared topology
converges in 42 evaluations under the explicit default budget of 64.
P2.9 admits two sibling top-level `if` roots and records the fixed limit and
observed count. Three roots and mixed sibling shapes remain explicit non-proofs.
P2.10 unrolls a one-to-four literal handler-local `for...of`; iteration-keyed
blocks preserve each throw path while dynamic and resource-bearing loops fail closed.
P2.11 composes one depth-two nested try/catch; handled inner throws reach its
join, inner-catch rethrows reach the outer catch, and depth three fails closed
under the named `handler-nesting-depth` budget.
P2.12 gives each inner completion/catch/join block a source-start region ID and
initially composed exactly two sibling inner handlers. #30 later widened this
same nested-try topology to three while retaining four as over-budget.

## Dependency-critical order

1. #20 is complete. The Workhub-derived `StateStore.set` edge on `main` retains its
   unsupported async class-method marker as a machine-readable violation. The
   completed declaration-transform slice admits one explicitly configured non-TypeScript declaration
   transform only when input/output/compiler/transform identity and spans are
   bound. The completed Node realm seed requires a matching `@types/node` major
   and explicit realm label. Broader non-identity transform semantics belong to
   #8; cross-realm, higher-order, and collection-valued cases remain non-proofs
   under their owning Issues.
2. #18's three bounded handoff seeds are complete. #57 adds the real Workhub
   top-level `main().catch(handler)` boundary without claiming later Promise
   execution or host-queue semantics. Remaining #18 breadth is 1–3 weeks and
   requires re-estimation before another family is activated.
3. #23 has completed its bounded source-keyed CFG handoff. #25 owns general
   value lattices and recurrence widening; #26 completed the bounded alias seed.
4. #24/#26 and #8/#27 provide alias/frontend evidence required before #13 can authorize
   transformations.
5. #2/#5 and #4/#6 are selected according to the next dogfood product, rather
   than being treated as one mandatory serial queue.

No broad Phase 3 or Phase 4 epic should be activated merely because it has an
attractive isolated demo. New work that exposes a soundness dependency should
be added to the owning Issue and reflected here before implementation begins.

## Issue-level remaining volume

| Order | Issue | Size | Estimate | Next independently testable result | Main uncertainty |
| ---: | --- | --- | ---: | --- | --- |
| 1 | #25 general CFG values | L | 3–8 weeks | Select the next application-backed bounded child after completed #48 | Value conflict, widening, recurrence, and irreducible control |
| 2 | #18 module initialization | M | 1–3 weeks | Re-estimate before selecting another application-backed family after completed #57 | Async evaluation joins, host packages, dynamic imports, and Promise execution after launch |
| 3 | #2 temporal synthesis/formulas | L | 4–8 weeks | One bounded polyhedral or quantified invariant family | Candidate explosion and backend parity |
| 4 | #5 collection temporal state/TLC | M | 1–2 weeks | Capture one unsupported Node Lease/TLC value or trace shape as a skipped acceptance test before selecting a child | Broader correlated collection observations, wider finite universes, and external trace interoperability |
| 5 | #4 property generation/shrinking | M | 2–4 weeks | Select one application-backed recursive or cross-file predicate child after completed #60 | Recursion budgets, higher-order predicates, and constructive inference |
| 6 | #6 typed arrays/SHA-256 | XL | 6–12 weeks | Interprocedural non-escaping typed-array alias slice | Resize/shared memory plus #25/#24 dependencies |
| 7 | #24 aliases/dynamic refinement | XL | 6–12 weeks | Continue beyond completed child #26 | Region identity, higher-order flow, and closed-world dispatch |
| 8 | #8 native Corsa parity | L | 3–8 weeks | Wait for new application evidence or select one explicitly justified neutral-IR domain | Corsa API maturity, rejection/resource ownership, callback timing, and source/type identity mapping |
| 9 | #10 event-loop ownership | XL | 6–12 weeks | One cited poll/I/O callback family | Host/version differences, realms, and dynamic cancellation |
| 10 | #7 independently checkable evidence | M | 2–4 weeks | Design decision plus one certificate/replay experiment | Solver proof formats may force a measured rejection |
| 11 | #16 React lifecycle | XL | 6–12 weeks | One dynamic component/Hook flow slice | Concurrency, server boundaries, and dynamic ownership |
| 12 | #13 proof-gated optimization | XL | 6–12 weeks | Fail-closed stable-read reuse transformation | Depends on evidence, aliases, CFG, and frontend parity |

## Recommended delivery checkpoints

1. **Usable async module proof boundary:** completed for one direct exact
   cross-project straight-line TLA dependency. The real-application survey found
   no positive candidate, so do not generalize speculatively.
2. **General analysis foundation:** #23 and the bounded #26/#27/#28/#29/#30/
   #31/#32/#33/#34/#35/#36/#37 slices are complete. Completing parent
   #25/#24/#8 is 12–28 weeks. Keep these
   figures separate when deciding whether the first reusable boundary is enough
   to begin product dogfood.
3. **Specification breadth (remaining Phase 2):** select #2/#5 (5–10 weeks) for temporal and
   Node Lease use cases, or #4/#6 for generated tests and numeric code. These are
   product choices rather than a single mandatory chain.
4. **Proof consumers and broad framework semantics:** keep #13 and the unbounded
   portions of #16/#10 behind evidence and analysis foundations. Do not present
   their current bounded models as general language semantics.

## Next bounded-slice decision

No implementation Issue is currently active. Bounded child #60 completed the
first generated-tests direction with full local gates and green remote CI. The
next investment should start with exactly one skipped acceptance test and an
adjacent negative control:

| Product direction | Parent | Proposed first child | Estimate | Explicitly excluded |
| --- | --- | --- | ---: | --- |
| Temporal/Node Lease | #5 | One realistic currently-unknown TLC/value/trace shape through generation, decoding, and replay | 1–2 weeks | Synthetic catalogue expansion and general quantified collections |
| Generated tests | #4 | One versioned explicit user-predicate specialization with constructive samples and precondition-preserving shrink | under 1 week | Recursive and higher-order predicate inference |
| Numeric/SHA-256 | #6 | One non-escaping interprocedural typed-array alias with bounds and element-range evidence | 1–2 weeks | Resizable/shared buffers and complete SHA-256 composition |

These are alternatives, not additive commitments. After the Red test identifies
the actual analyzer boundary, create a child Issue, give it an independent
estimate, and activate only that child. Until then the parent epics remain
`status:queued`.

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
| Completed sub-slice | P2.6 path-correlated handler values | under 1 engineer-week actual | Exact caught-path restriction verifies `rejectTelemetry`; focused analysis measured 2.1138 ms mean over 237 samples. |
| Completed sub-slice | P2.7 abrupt-finally override | under 1 engineer-week actual | `finalizeTelemetryRecovery` emits normal/return/throw plus ordered overrides; focused analysis measured 2.1823 ms over 230 samples. |
| Completed sub-slice | P2.8 ranking-handler CFG reuse | under 1 engineer-week actual | Shared handler blocks converge in 42 evaluations; structural analysis measured 0.3958 ms and Z3 56.8153 ms. |
| Completed sub-slice | P2.9 bounded sibling-handler joins | under 1 engineer-week actual | Two application sibling `if` roots verify; whole-fixture analysis measured 7.6596 ms and an observed third root remains unsupported. |
| Completed sub-slice | P2.10 finite handler-local loop | under 1 engineer-week actual | Two literal iterations verify with iteration-qualified blocks; whole-fixture analysis measured 2.9868 ms and five iterations remain unsupported. |
| Completed sub-slice | P2.11 bounded nested handler | under 1 engineer-week actual | Inner recovery and rethrow compose at depth two; whole-fixture analysis measured 10.3053 ms in a same-run 10–12 ms application baseline. |
| Completed sub-slice | P2.12 source-keyed nested regions | under 1 engineer-week actual | Two sibling regions verify with distinct IDs; whole-fixture analysis measured 12.8770 ms versus 10.3243 ms for one region in the same run. |
| Completed sub-slice | #26 local alias seed | under 1 engineer-week actual | One non-escaping alias verifies with separate refinement/Mutate evidence; escape, reassignment, computed, generic, dynamic, and unresolved controls fail closed. |
| Completed sub-slice | #27 checker-backed Corsa fact seed | under 1 engineer-week actual | One real checker inferred-`Console` fact and two ordered local calls normalize through Rust; the same-spelled local object stays effect-free and metadata drift fails parity. |
| Completed sub-slice | #28 scalar sibling-region value join | under 1 engineer-week actual | One integer environment converges through two source-keyed regions; only an independent Z3 equivalence check verifies it. |
| Completed sub-slice | #29 two-member scalar product join | under 1 engineer-week actual | Two independently checked integers traverse the same two regions; every member requires an independent Z3 check. |
| Completed sub-slice | #30 three-region scalar product | under 1 engineer-week actual | Carry the two-member product through three sibling regions with conflict, budget, source-correlation, and solver controls. |
| Completed sub-slice | #31 conditional scalar-product join | under 1 engineer-week actual | Join branch-selected product environments before a common successor without admitting arbitrary CFGs. |
| Completed sub-slice | #32 CFG-inferred affine recurrence | under 1 engineer-week actual | Infer a source-bound two-member transformer and summary from one reusable CFG back edge and prove it independently. |
| Completed sub-slice | #33 piecewise affine CFG recurrence | under 1 engineer-week actual | One loop-invariant conditional transformer joins through a source-bound CFG diamond with independent Z3 checks. |
| Completed sub-slice | #34 shared handler/scalar recurrence | under 1 engineer-week actual | Handler completion evidence now extends the common scalar recurrence artifact and duplicate v2 proof dispatch is gone. |
| Completed sub-slice | #35 two sequential invariant diamonds | under 1 engineer-week actual | Two source-ordered invariant diamonds compose into one recurrence; structural evidence remains a non-proof until independently verified by Z3. |
| Completed sub-slice | #36 finite switch recurrence fan-out | under 1 engineer-week actual | One unchanged integer selects two non-negative numeric-literal cases or an explicit default; structural evidence remains provisional until Z3 verifies the recurrence. |
| Completed sub-slice | #37 common ordered recurrence join IR | under 1 engineer-week actual | Migrated diamond/switch evidence and composed one Boolean-then-switch sequence before one recurrence back edge. |
| Completed sub-slice | #38 upper-triangular affine recurrence | under 1 engineer-week actual | Preserve one source-ordered driver/dependent edge and independently prove its closed form. |
| Completed sub-slice | #39 conditional predecessor value | under 1 engineer-week actual | Lower one Boolean conditional expression into generic source-bound predecessor evidence and independently prove the recurrence. |
| Completed sub-slice | #40 Boolean involution recurrence | completed in the current delivery | Carry one Boolean member through the shared recurrence and prove its parity summary. |
| Completed sub-slice | #41 entry-read triangular recurrence | completed in the current delivery | Preserve source order and prove the entry-value triangular summary independently. |
| Completed slice | #42 total finite Map lookup | completed in the current delivery | Total missing-key lookup agrees across Quint/runtime/Z3 for the bounded literal-key fragment; dynamic-key extraction remains an explicit non-proof. |
| Completed slice | #43 proved dynamic Map key domain | completed in the current delivery | Independently prove one immutable finite-Set membership invariant before decoding a state-derived lookup key. |
| Completed slice | #44 multiple proved Map key domains | completed in the current delivery | Prove every direct scalar selector separately before decoding one combined finite observation universe. |
| Completed slice | #47 bounded self-affine retry backoff | completed within #25 | One finite geometric summary is proved only under an exact checked `requires` bound; missing, oversized, or certificate-mismatched assumptions fail closed. |
| Completed slice | #48 caught retry backoff | completed within #25 | One immutable failure selector and catch/finally provenance compose with #47's finite proof rule. |

P1.2a establishes exact embedded TypeScript span identity only. A semantic
mapping beyond that relation is new scope and must be estimated separately
rather than silently absorbed.

The bounded #23 handoff is complete through P2.12. The shared builder covers
supported surrounding statements, two sibling roots, one finite handler-local
loop, and up to two depth-two nested handler regions with source-keyed IDs. #25
now owns independent general value joins, recurrence widening, and irreducible
control rather than allowing those research claims to remain hidden in a nearly
closed bounded epic.

## Backlog interpretation

- **Current implemented result:** #57 completed the exact Workhub top-level
  `main().catch(handler)` module-order family and nested-await TLA regression fix.
  #56 completed the function-local awaited dynamic fs import;
  no #8 child is active, and broader frontend parity remains unproved.
- **Next foundation checkpoint:** #26, #27, #28, #29, #30, #31, #32, #33,
  #34, #35, #36, #37, and #38 are complete; completing parent #25/#24/#8 remains
  12–28 engineer-weeks.
- **Next product choice:** choose either #2/#5 for Node Lease and temporal state,
  or #4/#6 for generated tests and numeric verification. The two paths are not
  both required for an initial useful release.
- **Deferred breadth:** #18's broader semantics and #7, #10, #16, and #13
  remain queued until application evidence
  or dependencies justify another bounded slice.
- **Entire open backlog:** 12 Issues / 11 non-overlapping epics and 46–97
  engineer-weeks. This is an additive research
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
  work discovered during #9 remains counted in #25 and #24.
- Estimates for #6, #10, #13, #16, and #24 remain epic-level placeholders. Each must be
  split into a bounded child Issue before activation; their upper bounds are
  materially less certain than Phase 1.
- No estimate assumes that bounded Quint exploration proves unbounded JavaScript
  or host semantics. Unsupported CFG, alias, host, and solver cases stay
  explicit `unknown` results.

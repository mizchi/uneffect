# Benchmarks

Performance-sensitive static-analysis changes use Vitest Bench:

```sh
just bench
```

The benchmark suite is separate from correctness tests and currently covers
scalar constant folding, a SHA-256-sized readonly U32 table, and repeated table
reads. Results are local-machine observations, not portable pass/fail budgets.
Compare results on the same machine and runtime before and after a change.

## React function component phase classification

`bench/react-semantics.bench.ts` constructs one TSX module containing 128
opted-in components. Every component calls one shared annotated custom Hook
whose passive Effect has a result/parameter identity contract and matching
acquire/release cleanup, a checked `[label]` dependency, and an immutable local
JSX event-handler reference. Each component also builds immutable props, state, and context region
facts through local `const` aliases and contains an identity-checked inline
callback ref with returned cleanup. The paired baseline
parses the same source with the TypeScript TSX parser but performs no Uneffect
classification.

After replacing the 128 inline event callbacks with immutable local callback
references on the same date, the source path measured 24.35 ms mean and the
parse-only baseline 2.40 ms (about 10.16x). The reused-Program path measured
35.41 ms. This is the first regression point that includes construction,
reassignment screening, and alias resolution for referenced JSX handlers; it
is not directly comparable to the earlier inline-handler workload.

After wrapping each referenced handler's Fetch in an inline
`startTransition` action, the source path measured 27.61 ms mean, the
parse-only baseline 2.43 ms (about 11.38x), and the reused-Program path 37.70
ms. Transition binding facts are cached by component AST identity; before that
cache the same workload measured 29.41 ms and 43.89 ms respectively. The
remaining delta includes the extra immediate-action traversal and the larger
synthetic source, so it is retained as a regression baseline rather than
attributed entirely to one operation.

On 2026-08-25 with Vitest 4.1.11, after adding immutable props/state/context
region construction and callback-ref lifecycle checking to the expanded
workload, with per-call lifecycle instance association, interrupted-render
replay, commit-generation ownership, and bounded repeated-Suspense-retry
metadata and direct Suspense-boundary extraction enabled, the analyzer measured
19.57 ms mean (1.05% RME, 26 samples), while the parse-only baseline measured
2.25 ms (0.81% RME, 223 samples). The combined parse-and-analysis path was
therefore about 8.70 times the parse-only cost for this synthetic cold call, or roughly 0.153
ms per annotated component. This
implementation reparses the supplied
source; it is not yet the intended Corsa/TypeScript Program-reuse path, so the
number is a regression baseline rather than a compiler-plugin latency claim.

The Program-backed path reusing the already parsed TypeScript Program measured
24.70 ms mean (0.71% RME, 21 samples). It performs two source walks to establish
the custom-Hook import fixed point. Reusing the converged second-pass results
removed an unnecessary third walk. Source-level React import facts and
boundary-level immutable-region facts are cached by AST identity; before those
caches, the expanded Program workload measured 19.07 ms and then 17.29 ms.
The current path also constructs canonical component keys for cross-file
Suspense edges, but skips the JSX symbol walk entirely in sources that do not
import React `Suspense`.
This synthetic one-file Program has no cross-file imports and therefore shows
fixed-point overhead rather than its intended multi-file benefit. Earlier
measurements used smaller workloads without state/context region construction
or callback-ref lifecycle checking and are not directly comparable.

Generating development Strict Mode Quint for all 128 already analyzed
component summaries measured 0.915 ms mean (0.45% RME, 547 samples), about
0.007 ms per component. Generating the bounded concurrent-interruption model
measured 0.590 ms mean (0.37% RME, 848 samples), about 0.005 ms per component.
Generating dependency-change models with two commit generations measured 0.987
ms mean (0.39% RME, 507 samples), about 0.008 ms per component. Generating the
single suspend-resolve-retry model measured 0.769 ms mean (0.53% RME, 651
samples), about 0.006 ms per component; the repeated-retry model measured 1.09
ms mean (0.39% RME, 461 samples), about 0.008 ms per component. Generating 64
explicit primary/fallback boundary pairs measured 0.579 ms mean (0.41% RME,
864 samples), also about 0.009 ms per component pair. These measure deterministic source generation
only; Quint parsing and simulation are covered by the formal test tier rather
than this microbenchmark.

The scaled-affine strengthening dogfood initially measured 3,412.12 ms for one
sample because every candidate obligation constructed a fresh Z3 Context.
Reusing one Context per reachability-lint invocation while retaining an
independent Solver for every obligation reduced the same-machine mean to
188.69 ms over three samples (5.43% relative margin of error), about an 18x
improvement. This measures `2 * accepted <= byteBudget` template generation,
induction checks, and reachability diagnostics together; it is not a general
polyhedral benchmark. After raising the explicit coefficient bound from two to
three and changing the dogfood invariant to
`3 * accepted === byteBudget`, then adding both sum and difference orientations,
the same local Node 24 benchmark measured 472.73 ms mean over five samples
(7.57% RME). The larger coefficient pool and doubled orientation set explain
the increase; this remains an observational benchmark rather than a CI budget.

The two-counter telemetry quota model exercises the new opposite-motion
template `sent + remaining === 100`. It measured 253.03 ms mean over eight
samples (3.24% RME) on the same run. The scaled coefficient-three model was
1.87x slower because it considers more reduced coefficient pairs; this is a
candidate-pool comparison, not a general solver-performance claim.

The three-counter telemetry accounting model measured 345.42 ms mean over two
samples (3.84% RME) after adding bounded coefficient-1 conservation templates.
This includes candidate generation plus independent Z3 initialization,
preservation, and reachability obligations; it is not a parser-only benchmark.

The opt-in four-counter telemetry routing model measured 1,411.37 ms for one
sample after generalizing conservation partitions. This includes pairwise and
three-variable candidates before the four-variable candidate, plus independent
Z3 obligations for each. The single sample is a development observation, not a
stable performance claim; it shows why arity remains explicit and candidate
generation is capped.

Parsing the same telemetry routing source and checking complete refinement-name
coverage measured 0.3583 ms mean over 1,396 samples (2.10% RME). This measures
annotation extraction and structural action/invariant set comparison only; it
does not measure or claim semantic implementation-to-model refinement.

After adding scalar action-body refinement, parsing plus structural coverage
and semantic comparison of all five telemetry actions measured 0.4847 ms mean
over 1,032 samples (1.66% RME). The extra work includes literal specialization
of three local `record` calls and all-state stuttering comparisons. It still
excludes create/observe, guards, and invariant-function equivalence.

Adding exact scalar invariant-body comparison to the same benchmark measured
0.4768 ms mean over 1,049 samples (0.94% RME). The value is slightly below the
preceding run and should be treated as measurement noise, not an optimization;
the benchmark now includes coverage, five action bodies, and one invariant body.

Adding create/observe identity-projection checks measured 0.5575 ms mean over
897 samples (0.42% RME). This complete scalar-refinement benchmark includes
parsing, binding coverage, five actions, one invariant, transparent local-class
construction, and destructured observation; it does not include a TypeChecker
or runtime validation of the adapter input objects.

After adding exact early-return guard comparison to the telemetry observation
action, the same complete scalar-refinement benchmark measured 0.6436 ms mean
over 777 samples (1.16% RME). This includes normalization and comparison of the
four-field accounting guard as well as the previously measured boundaries.

Composing and checking a 16-case scalar `switch` refinement with four-case
fallthrough groups measured 1.1717 ms mean over 427 samples (1.30% RME). The
benchmark includes annotation parsing, entry-path construction, sequential
fallthrough updates, break termination, conditional joins, and comparison with
the temporal action; dynamic-label rejection is covered by tests rather than
timed in this baseline.

After the telemetry dogfood `deliver` action was changed to place the attempted
counter update in a mandatory `finally`, the complete telemetry scalar
refinement benchmark measured 0.9079 ms mean over 551 samples (3.53% RME). This
run includes parsing and validating the normal `try` update followed by the
mandatory cleanup update. It is a new development-host observation, not a
claim that the difference from the older 0.6436 ms result is entirely caused
by `finally` handling.

After the same dogfood moved `armAudit` to an early-return form, the complete
telemetry refinement benchmark measured 0.8229 ms mean over 608 samples (0.66%
RME). This includes cloning the trailing statements only onto the continuing
abstract path and preserving the common pre-branch state. The lower mean than
the preceding run is measurement variation, not evidence that the extra CFG
join is free.

After adding the caught rejected-delivery path, the same benchmark measured
0.9242 ms mean over 541 samples (0.53% RME). The path performs a state update,
throws a primitive literal, applies catch accounting, and then applies a
mandatory `finally` update. Effectful throw expressions and unresolved
exception paths are negative controls and are not included in the timed path.

Changing that dogfood to conditionally reject an already audit-armed delivery
measured 0.9686 ms mean over 517 samples (0.48% RME). The checker now constructs
normal and exceptional abstract states, applies catch only to the latter,
joins both under the pre-throw condition, and applies `finally` to the joined
state. Inverting the implementation condition is a solver-checked negative
control outside the timed benchmark.

Adding an early-return delivery path that must still increment accounting in
`finally` but must skip post-processing measured 1.0559 ms mean over 474
samples (0.56% RME). This includes separate return and normal abstract states,
cleanup on both, post-try execution on only the normal state, and their final
conditional join.

Changing the telemetry drop path so a direct void return in `finally`
suppresses an otherwise reachable post-processing write measured 1.0851 ms
mean over 461 samples (0.52% RME). Removing the overriding return produces an
`action-update-mismatch` for the newly reachable write and is excluded from
the timed path.

After separating state from `normal | return | mixed(returnWhen)` completion
and adding a nested-return telemetry action, the complete refinement benchmark
measured 1.2336 ms mean over 406 samples (0.60% RME). The nested path composes
two branch predicates, applies continuation updates only to non-returned paths,
and rejects removal of the inner return through a model-update mismatch.

Generalizing the lattice to homogeneous throw completions and adding a nested
telemetry rejection handled by catch measured 1.4012 ms mean over 357 samples
(0.49% RME). Catch updates are conditional on the composed throw predicate;
removing the only explicit throw leaves an unproven catch path and is rejected
as `unsupported-action-body`.

Splitting mixed completion into independent return and throw predicates and
adding a terminal telemetry return-or-reject action measured 1.5360 ms mean
over 326 samples (0.54% RME). Catch discharges only the throw predicate while
the return predicate survives common finally processing. The current raw
symbolic state retains redundant conditionals from pre-catch joins; path-aware
simplification is not included in this timing or claimed as implemented.

Syntactic boundary generation for 16 shard contracts, each combining a range
with `% 16 === 0`, measured 1.0009 ms mean over 500 samples (0.34% RME).
Generated Vitest execution and Z3 enumeration are intentionally outside this
measurement; it isolates the zero-runtime syntactic hint path.

Branch-local DNF hint generation for 16 two-tenant shard contracts measured
1.6107 ms mean over 311 samples (0.50% RME). DNF construction stops before
materializing more than 32 branches, so this benchmark does not hide an
unbounded expansion path.

Generalized-CRT hint generation for 16 partition-routing contracts with
`% 4 === 1` and `% 6 === 3` measured 1.1774 ms mean over 425 samples (0.35% RME).
The path uses exact BigInt arithmetic internally and only publishes a hint when
the combined modulus and residue remain safe JavaScript integers.

Signed-remainder hint generation for 16 negative-range partition contracts
measured 1.1135 ms mean over 450 samples (1.64% RME). The benchmark includes
range-sign validation and BigInt normalization before emitting JavaScript `%`
compatible negative candidates.

Analyzing the retry-attempt dogfood and lowering its awaited handler loop plus
generation-safe `await using` cleanup to unified Quint measured 123.12 ms mean
over 20 samples (1.04% RME). This includes TypeScript program construction,
Promise/resource analysis, and model emission, but not Quint execution.

Analyzing the broken retry-attempt dogfood and detecting its post-disposal
alias use through two local edges measured 137.00 ms mean over 20 samples
(2.45% RME) on the stable repeat run. This was the baseline before changing
the dogfood escape to a static aggregate property; the aggregate result is
141.74 ms mean over 20 samples (5.90% RME). The small difference is within the
noise of rebuilding the TypeScript program and is not claimed as a property
tracking speedup or regression.
After extending the fixture to a nested property reached through an aggregate
root alias, two consecutive runs measured 362.65 ms (10.17% RME) and 322.33 ms
(9.05% RME), each over 20 samples. Both distributions are noisy and materially
above the earlier direct-property run, so a separated follow-up was run rather
than attributing the increase to the access-path walk. The stable follow-up
measured 132.06 ms for end-to-end analysis (2.93% RME), 95.82 ms for TypeScript
Program construction alone (2.93% RME), and 0.297 ms for analysis of a warm
Program (3.33% RME). The nested access-path walk is therefore not the observed
bottleneck; the two slow runs are retained as environment-noise evidence, while
Program construction remains the dominant cold-path cost.
After attaching symbolic generation evidence to each reported alias escape,
the same end-to-end broken retry analysis measured 130.99 ms mean over 20
samples (1.71% RME), consistent with the stable pre-metadata measurement.
End-to-end analysis plus unified Quint lowering for the repeated retry alias
measured 136.85 ms mean over 20 samples (2.93% RME). This includes TypeScript
Program construction, alias event placement, and model emission, but not Quint
execution.
After adding arbitrary finite repeat/exit and zero-iteration capture skipping,
the same benchmark measured 142.43 ms mean over 20 samples (4.69% RME). The
roughly 6 ms increase is within the wider cold-run distribution.
After normalizing two aliases of one repeated acquisition to a shared loop
decision, a dedicated end-to-end analysis and unified-Quint-lowering benchmark
measured 126.58 ms mean over 20 samples (2.27% RME). This benchmark retains two
independent generation captures and uses, but emits only one repeat/exit pair.
A nested two-acquisition variant measured 165.67 ms mean over 20 samples
(10.50% RME). The run includes distinct inner/outer generation and repeat-target
lowering; its high variance and 314.12 ms maximum make it a regression sentinel,
not evidence of a stable 31% cost increase over the shared-alias case.
A conditional two-alias variant, including relative-control classification and
explicit capture/skip lowering, measured 128.42 ms mean over 20 samples (2.60%
RME). Its cost is consistent with the non-nested shared-alias baseline.
After retaining relative control paths and correlating both aliases through one
branch identity, the same benchmark measured 124.56 ms mean over 20 samples
(1.66% RME). No regression is visible against the earlier independent-choice
lowering.
A restricted try/catch generation variant, including preceding-risk detection
and correlated completion/catch capture lowering, measured 124.77 ms mean over
20 samples (1.59% RME). Keeping this projection separate from the general
Promise handler CFG produced no measurable cold-path penalty.
A TypeChecker-resolved getter-risk variant measured 126.67 ms mean over 20
samples (2.66% RME). Symbol-based accessor inspection therefore remains within
the established cold Program-construction distribution.
After routing the same getter through an exact const computed key, the benchmark
measured 125.14 ms mean over 20 samples (1.72% RME), showing no regression from
finite key-domain resolution.
The corresponding immutable-Proxy receiver slice measured 122.14 ms mean over
20 samples (1.80% RME). This includes TypeChecker symbol validation, cycle-safe
`const` receiver resolution, alias-generation analysis, and unified Quint
lowering; imported and mutable Proxy provenance remain outside the benchmarked
proof fragment.
Resolving the same receiver through a two-function zero-argument factory chain
whose leaf has two Proxy-valued return paths, then forwarding it through a
generic identity parameter and a string-literal `switch` mixed-return selector,
measured 123.57 ms mean over 20 samples (1.98% RME). The additional TypeChecker
call-signature, cycle, definite-return, symbol-substitution, and branch-folding
checks remain inside the existing cold Program-construction distribution.
Replacing that selector with a boolean-only compound predicate
(`mode === "proxy" && enabled`) measured 122.20 ms mean over 20 samples (1.80%
RME). This single run does not establish an improvement, but shows no visible
regression from left-to-right short-circuit folding in the same workload.
Expressing the selector as a conditional expression and reusing the same
predicate evaluator measured 123.30 ms mean over 20 samples (1.87% RME), again
inside the preceding cold-analysis range.

After changing the same dogfood to address the nested slot through a local
computed `const` key, a system-pressure run measured 267.83 ms end to end
(4.18% RME), 208.38 ms for Program construction (8.19% RME), and 0.648 ms for
the warm analysis (7.34% RME). Even in this slower run the warm walk was about
0.24% of the cold total, so constant-key resolution does not move the dominant
cost away from TypeScript Program construction.

The Program-wide dogfood then moved that key into a second imported module.
The stable two-file run measured 131.51 ms end to end (3.35% RME), 92.59 ms
for Program construction (1.93% RME), and 0.290 ms for the warm analysis
(3.83% RME), over 20 cold samples and 1,722 warm samples. Following the import
symbol adds no measurable warm-path regression at this fixture size.

Adding a second dogfood function that returns an `await using` resource inside
an object measured 140.87 ms end to end (2.78% RME), 98.07 ms for Program
construction (2.64% RME), and 0.332 ms for the warm analysis (1.98% RME).
Return-escape recognition remains below one millisecond in the warm two-file
fixture; as before, cold TypeScript construction dominates.
This includes TypeScript program construction and the complete async analysis,
not only the alias scan. An immediately preceding run under system pressure
measured 340.85 ms with 13.95% RME, so it is recorded as noise rather than a
stable regression.

Initial baseline on 2026-08-21 with Node.js 24 and Vitest 3.2.7:

| Case | Mean |
| --- | ---: |
| Empty source | 0.0014 ms |
| 128 chained scalar constants | 0.4463 ms |
| SHA-256-sized U32 table | 0.0366 ms |
| 256 verified constant-table reads | 0.8454 ms |

After adding project-level resolution, a second same-machine run measured
1.0923 ms for 256 single-file reads and 1.4229 ms for the same reads through a
three-file direct-import/barrel graph. The observed project-resolution overhead
was about 30%; it remains below 1.5 ms for this fixture and does not justify a
cache yet.

After namespace-import and verified-spread composition support, a same-machine
run measured 1.3101 ms for the three-file named/barrel fixture, 1.4443 ms for a
two-file namespace-import fixture with 256 reads, and 0.0197 ms to compose a
64-element U32 table from eight verified spreads. Namespace member syntax was
about 10% slower than the named/barrel case in this run; both remain below 1.5
ms, so no project cache was added.

The first integer-cast benchmark verifies 256 `Math.floor` results propagated
through inferred `const` locals and then written to a bounded Uint8Array. It
measured 5.6596 ms (about 0.022 ms per local/write pair) on the same machine.
This includes parsing, local fixed-point inference, and 512 obligations (value
and index); it does not invoke Z3.

A later run measured 4.4686 ms for that source-only case and 5.2315 ms when
checking all 256 calls against lib.d.ts symbol identity through a prebuilt
TypeScript Program, an observed overhead of about 17%. Program construction is
excluded because build integrations share it with normal type checking.

With 256 calls split between a direct local alias and destructured alias, one
run measured 12.4283 ms for the TypeChecker path versus 8.5542 ms for the
source-only direct-call fixture in the same run (about 45% slower, with 7.15%
relative margin of error on the alias case). This is a noisy microbenchmark and
does not isolate alias lookup from the different source shape; it is recorded
as a warning signal, not a regression budget.

The Node Lease benchmark measures only parsing and linting the finitely expanded
comment DSL and generating Quint. Quint execution remains a separate integration test
because process startup and bounded search dominate the frontend cost.
The first run measured 0.3599 ms mean for parse plus generation (6.25% relative
margin of error). The two Quint integration checks took about 1.1 and 1.0
seconds respectively, dominated by external tool startup and bounded search.
A later parse-plus-lint-plus-generation run measured 0.1812 ms with a noisy
10.19% relative margin of error. This confirms only that frontend lint is
sub-millisecond for the fixture; it is not evidence about model-checker cost.

Property-test generation has a separate 16-function scalar-contract case. It
measures parsing, restricted expression validation, boundary extraction, and
standalone Vitest source generation. It excludes execution of the generated
properties and counterexample persistence; those costs depend on the tested
application.
The first same-machine run measured 0.2902 ms mean (0.30% relative margin of
error), or roughly 0.018 ms per generated function contract.

After bounded typed arrays, literal unions, and structure-aware shrinking were
added, a 16-function generation fixture measured 0.2297 ms mean (0.30%
relative margin of error), roughly 0.014 ms per contract. This measures source
generation only. A correctness integration test separately starts Vitest and
executes a generated typed-array/union property; process startup dominates that
path.

Deriving boundary-adjacent candidates from conjunctive numeric refinements for
16 scalar contracts measured 0.4370 ms mean (0.72% relative margin of error),
about 0.027 ms per contract. This includes parsing each `requires` expression
into the shared logic IR; it does not invoke a solver.

After adding disjunction traversal and single-variable affine normalization, a
16-contract fixture with two affine branches per contract measured 0.8627 ms
mean (1.43% relative margin of error), about 0.054 ms per contract. This remains
syntactic boundary extraction. Affine equality graphs between scalar parameters
are also handled syntactically by propagating correlated tuples; nonlinear
constraints still require a more general or solver-backed generator.

The corresponding 16-function, three-parameter fixture with two chained affine
equalities measured 1.2181 ms mean (0.35% relative margin of error), about
0.076 ms per contract. This includes parsing, boundary hints, relation-graph
propagation, and generated source; it does not execute the generated properties.

Enumerating up to eight integer models for the nonlinear refinement
`x*x + y*y === 625` measured 253.45 ms mean over two samples (2.41% relative
margin of error). This includes Z3 initialization, repeated blocking queries,
model decoding, and generated source. `solverCases` is both a resource bound
and a coverage limit; model enumeration does not claim exhaustive coverage of
an infinite domain.

On 2026-08-24, enumerating four models for correlated numeric, boolean, and
string literal-union deployment boundaries combined with negative truncating
division and signed remainder measured 193.23 ms mean over three samples
(16.09% relative margin of error).
This includes fresh Z3 initialization and therefore primarily records the cold
solver-backed path; the exact finite union constraint itself is small.

On the same date, enumerating eight rollout-configuration models with an
optional object and an independently optional nested field measured 186.45 ms
mean over three samples (41.64% relative margin of error). The small sample is
noisy and includes fresh Z3 initialization; it is a regression reference for
the two-level presence encoding, not a stable throughput claim.

Jointly shrinking across 64 already-derived correlated tuples measured
0.0049 ms mean (2.30% relative margin of error). This measures in-memory tuple
ordering, full-precondition rechecks, and a synchronous failing property; it
does not include solver calls or user application cost.

An application adapter importing `pipe` from the pinned external Effect
package and proving one affine `requires`/`ensures` contract with Z3 measured
52.7048 ms mean over ten samples (5.76% relative margin of error). This includes
source lowering, solver initialization, the proof query, and JavaScript emit;
it excludes loading the external TypeScript implementation because the
contract lowerer validates the exact import declaration and inline callback
syntax rather than constructing a TypeChecker Program.

Generating and checking the Web event-loop model for an external Effect timer
adapter with a dynamically queued microtask took 658.75 ms in a one-sample run.
This includes starting Quint and checking `eventLoopSafe`, so it is verifier
time rather than frontend-only time. One sample is not a stable distribution,
and the property covers queue phase/FIFO safety rather than the callback's
application-level value semantics.

Resolving 64 named timer callback bodies, each dynamically queuing one
microtask, measured 126.23 ms mean over five samples (4.08% relative margin of
error). This includes TypeScript Program construction and TypeChecker symbol
resolution; integrations should reuse an existing Program rather than paying
that setup cost per file.

Resolving a 64-link reassignment-free timer-handle alias chain measured
137.97 ms mean over five samples, with a noisy 18.15% relative margin of error.
As above, TypeScript Program construction dominates this standalone API path;
the alias walk itself is linear in the chain length.

The property-generator cases remain on the purely static path and do not invoke
Z3. Solver benchmarks are reported separately because initialization and
individual proof queries have a different cost profile.

The first temporal semantic-lint fixture issues Z3 queries for five properties,
one guarded action, and pairwise implication candidates. Its one-sample cold
run measured 806.14 ms. This is acceptable for an explicit build command but
not yet an editor latency target; context reuse and batched classification
remain possible optimizations.

A bounded-reachability fixture with three actions, one unreachable action, and
four transition steps measured 879.22 ms in a one-sample run after both
shortest-reachable-deadlock and all-enabled-actions-stutter queries were added.
The sample count is too small for a stable distribution. Runtime grows with the
number of actions, state variables, and unroll depth; the configured depth is
therefore part of both the diagnostic and the performance contract. Solver
context/query reuse remains an obvious optimization target.

A four-step bounded-vacuity fixture with one changing counter and one frozen
property state took 905.34 ms in a one-sample run. It performs both bounded
safety and referenced-state-change queries in addition to reachability lint.
The sample count is insufficient for a stable distribution and reinforces the
need to reuse solver contexts and prefix constraints.

The first cross-module validator fixture constructs a TypeScript Program for
four virtual files and composes one sink through a barrel alias and a class
method. It measured 135.48 ms mean over five samples (2.01% relative margin of
error). Program construction and lib.d.ts checking dominate; build integrations
should share the host Program instead of treating this as a per-function cost.

Creating, hashing, cloning, and replaying a 100-step normalized model trace,
including before/after observation comparison and one invariant per step,
measured 0.4962 ms mean (1.90% relative margin of error). This benchmark uses
an in-memory adapter and excludes model-checker startup and application I/O.

Parsing and normalizing a 100-step Quint MBT ITF violation measured 0.2078 ms
mean (0.75% relative margin of error). This includes JSON parsing, removal of
ITF/MBT metadata, safe-bigint conversion, trace validation, and cloning; it
excludes Quint startup and model exploration.

Searching depths zero through eleven and extracting the vulnerable Node Lease
trace with the in-process Z3 backend measured 129.16 ms mean in an initial
four-sample run (13.03% relative margin of error). This includes repeated
bounded solver checks, model extraction, hashing, and normalized trace
validation; the sample is noisy and is an observation rather than a regression
budget.

Parsing 101 scalar TLC states and recovering 100 action names against one
neutral-IR action measured 0.1698 ms mean (0.92% relative margin of error).
This excludes TLC execution and applies only to the documented scalar trace
fragment; candidate matching grows with both trace length and action count.

Extracting annotations and generating a direct-reference adapter module with
64 action bindings measured 0.1675 ms mean (1.15% relative margin of error).
This includes TypeScript parsing and manifest validation, but excludes normal
TypeScript checking of the generated module and implementation exports.

Checking 64 direct `BoundedDataView<256>.setUint32` writes measured 0.4533 ms
mean over 1,104 samples (0.23% relative margin of error). This exercises the
source-level range checker and proof-obligation construction; it does not
construct a TypeChecker Program or model backing-buffer aliasing.

The initial practical twelve-field DNS header DataView benchmark measured
23.5590 ms because it issued six separate Z3 queries for `Nat <= 65535` setter
domains. After deriving safe integer intervals from simple `requires` bounds,
the same verification issued zero solver queries and measured 0.4004 ms mean
over 1,249 samples (2.12% relative margin of error), about 59 times faster.
After adding its fixed-buffer DataView constructor obligations and constant
short-circuiting, the expanded fixture measured 0.1851 ms mean over 2,701
samples (0.57% relative margin of error); the difference is run-to-run noise
plus a newer fixture, not a claim that adding obligations intrinsically speeds
the parser.
Non-interval arithmetic still falls back to Z3 and is reported by the public
`statistics.solverQueries` counter.

Project verification of the Worker transfer/DataView negative control measured
128.94 ms mean over five samples (4.10% relative margin of error). This includes
an in-memory TypeScript Program with standard libraries, builtin symbol
resolution, ownership event collection, typed-array verification, and
cross-domain invalidation. Program construction dominates; a compiler or Corsa
integration should supply and reuse its existing semantic context rather than
rebuilding one per file.

Promise ownership analysis of the telemetry delivery dogfood fixture now
includes deferred `let` initialization, exhaustive literal-union `switch`
paths, an early-return `try`/`finally` cleanup path, a loop-condition ownership
handoff evaluated before the zero-iteration exit, and an always-entered
`while (true)` delivery path. It also routes a guaranteed `Throw<Error>` loop
condition into telemetry recovery. The benchmark now requires 20 iterations
per case after a five-sample run produced 66.06% RME. On 2026-08-25, the
20-sample Vitest 4.1.11 run measured 166.41 ms mean (8.14% RME) for the full
fixture and 149.48 ms (5.59%) for the otherwise identical direct-`const`
baseline. The full mean was about 11% higher, but the uncertainty intervals
overlap and both cases construct fresh TypeScript Programs, so this is recorded
as a cold-cost observation rather than a stable regression or incremental
compiler-plugin latency budget.

Symbol-linked Promise assimilation for the legacy adapter dogfood fixture,
including one direct hostile thenable, measured 130.61 ms mean over five cold
samples (4.31% relative margin of error). The analyzer constructs a TypeScript
Program, discovers local thenables, performs a two-pass executor and reaction
scan, and connects outer resolvers to the inner operation or thenable. As with
the ownership benchmark, Program construction dominates and the small sample is
an observation rather than a regression threshold.

The conservative dynamic-thenable corpus (one conditional getter, one direct
Proxy, and one external `PromiseLike`, each adopted by a local Promise) measured
118.43 ms mean over five cold samples with Vitest 4.1.11 (3.31% relative margin
of error). This includes symbol resolution, `InvokeUserCode` classification,
and linking all three adoption states; it adds no production runtime work.

The `promise-routing.ts` dogfood with a Proxy `then` callback passed through a
two-level function/immutable-arrow identity chain measured 122.29 ms mean over
20 cold samples (2.07% RME). This includes the conservative source-level
reassignment scan; the result is observational and does not establish
large-file scaling.
After adding a literal conditional callback selector around the same forwarded
trap value, the fixture measured 125.21 ms mean over 20 samples (1.55% RME).
The roughly 3 ms difference is within cold-run variability and is not treated
as a regression signal.
Adding the immutable compound `then`-property guard measured 122.57 ms mean
over 20 samples (2.03% RME), returning to the earlier observed range.
Replacing the inner callback selector with a static string `switch` and sharing
the primitive evaluator with resource analysis measured 123.52 ms mean over 20
samples (1.46% RME), still within the same cold-analysis range.
Using the equivalent early-return `if` selector through the restricted block
walker measured 120.83 ms mean over 20 samples (1.88% RME). The lower point is
within run-to-run variance and is not claimed as an optimization gain.
Replacing that branch with a proof-pure local `const` conditional selector
measured 123.45 ms mean over 20 samples (1.88% RME). This remains within the
same cold-analysis range; effectful local initializers are intentionally not
eligible for this proof.
Expressing the dogfood Proxy handler with a literal-computed `["get"]` name
measured 121.16 ms mean over 20 samples (1.36% RME). The small decrease is
within ordinary cold-run variance; the relevant result is that computed-name
resolution preserves the exact rejection proof without runtime instrumentation.
Routing the same handler name through an immutable `const` key measured
121.74 ms mean over 20 samples (1.56% RME). This is effectively unchanged from
the literal-computed measurement while exercising symbol-based key resolution.
Composing that keyed handler through an immutable object spread measured
122.75 ms mean over 20 samples (1.59% RME). Reverse-order override analysis did
not move the fixture outside its established cold-analysis range.
Replacing the trap's expression body with a pure local selector and nested
static branches measured 124.21 ms mean over 20 samples (1.92% RME). The
restricted return walker remains within the same observed cold-analysis band.
Routing the property alias through a source-ordered `switch` measured
122.69 ms mean over 20 samples (1.46% RME). The alias exposed and fixed a
one-step-versus-transitive initializer-resolution bug; the corrected walker
remains in the established range.
Adding a second realistic Proxy whose guarded `then` lookup throws measured
126.45 ms mean over 20 samples (1.84% RME). The fixture now proves both callback
rejection and getter rejection, so this increase also includes another Promise
chain and thenable node rather than only the completion-kind check.
Moving callback selection after an unlabeled switch `break` measured 127.81 ms
mean over 20 samples (2.44% RME). The noisier sample remains close to the
expanded two-Proxy fixture and does not establish a regression.
Wrapping the guarded getter rejection in a restricted `try/finally` measured
124.86 ms mean over 20 samples (1.88% RME). Normal-completion composition adds
no visible cold-path regression in this fixture.
Adding a reachable catch that rethrows the guarded lookup failure measured
122.15 ms mean over 20 samples (1.45% RME). Path-reachable catch composition
remains within the fixture's prior variance.

Classifying the mixed Promise combinator dogfood fixture measured 234.45 ms
mean over five cold samples (23.46% relative margin of error). The fixture has
one immediate cached value, one sparse `undefined` slot, and one thenable that
must pass through assimilation. The high variance and fresh TypeScript Program
construction make this a baseline observation, not an editor-latency budget.

Enumerating the maximum accepted 32 paths from five consecutive binary
generator choices measured 137.29 ms mean over five cold samples (3.91% RME).
This includes fresh TypeScript Program construction, symbol-based builtin
classification, and materializing every correlated iterable path. Quint
generation and verification are excluded. The 32-path limit is a soundness
boundary against state explosion, not a claim that larger programs are fast or
verified; larger products become an explicit unsupported dynamic iterable.

Analyzing the fetch dogfood fixture with a timeout/request composition feeding
a second application-shutdown `AbortSignal.any` measured 233.76 ms mean over
five cold samples (5.82% relative margin of error). The pass resolves the DOM
builtins by declaration identity, extracts the active-time deadline, and links
both the timer source and local composition edge. The benchmark excludes Quint
execution and remains a cold TypeScript Program observation, not an
editor-latency regression threshold.

Tracking 64 local timer handles passed to an opaque registration boundary
measured 232.63 ms mean over five cold samples (17.38% relative margin of
error). The pass assigns each escape to a concrete timer generation and keeps
the external-cancellation transition optional. The variance is too high for a
regression threshold; this is a scaling observation for the 64-handle fixture.

Tracking 64 timer handles nested in an object/array behind an immutable local
registration binding measured 271.08 ms mean over five cold samples (29.18%
relative margin of error). This includes recursive aggregate traversal,
TypeChecker binding resolution, and concrete-generation lookup, but excludes
Quint generation. The high variance makes this observational only.

Analyzing the two-task prioritized scheduler dogfood fixture, including a
timeout/external abort composition and one inherited-priority/cancellation
`scheduler.yield` continuation, measured 303.87 ms mean over five cold samples
(11.17% relative margin of error). This includes TypeChecker identity
resolution, static option extraction, signal-edge linking, and callback-body
discovery, but excludes Quint execution. The small cold sample is observational
and not yet a regression threshold.

Auditing the telemetry packet fixture across its statement-scoped typed-array
escape hatch, Console builtin, temporal summary, and owner/expiration policy
measured 110.80 ms mean over five cold samples (12.81% relative margin of error).
This
includes construction of a fresh TypeScript Program and all project verification
passes, not just ledger collection. The small, noisy sample is an integration
cost observation; compiler/Corsa integration should reuse the host Program.

Verifying the `telemetry-once.ts` Web/callback product measured 2,027.17 ms for
one cold sample. This includes project analysis, Quint startup, and separate
checks of `eventLoopSafe` and the application `sendsAtMostOnce` property. A
single sample is only a coarse integration-cost observation; batching multiple
properties into one verifier process remains an important performance task.

Parsing and lowering the node-indexed finite-Set/Map lease fixture to Quint
measured 0.0678 ms mean over 7,374 samples (0.31% relative margin of error).
This covers the neutral Set/Map/lambda AST and code generation but deliberately
excludes Quint startup and model exploration; it is a frontend/lowering
baseline only.

Detecting retry-resource use-after-dispose, returned-value escape, and returned
closure capture measured 125.35 ms mean over 20 cold samples (1.99% relative
margin of error). TypeScript Program construction alone measured 89.30 ms,
while the same analysis over a warm Program measured 0.389 ms over 1,287
samples. The cold number is therefore dominated by compiler setup; the warm
measurement is the relevant baseline for eventual compiler/Corsa integration.

After adding an annotated retaining registration boundary and one direct
wrapper to the same fixture, combined use/value/closure/retention detection
measured 131.29 ms mean over 20 cold samples (1.79% relative margin of error).
Program construction measured 93.33 ms, while warm analysis measured 0.504 ms
over 994 samples. Transitive parameter-symbol retention therefore remains
sub-millisecond in this fixture; this observation is not yet a large call-graph
scaling guarantee.

Forwarding the retained parameter through one reassignment-free local `const`
alias initially measured 0.664 ms on the warm Program (a preceding pressured
run measured 1.725 ms). Caching the inferred retention summary per resolved
signature restored the stable warm mean to 0.505 ms over 990 samples (0.66%
relative margin of error). The cache is scoped to one analysis invocation and
therefore cannot reuse facts across different TypeScript Programs.

Adding an annotated queue-entry constructor and a factory wrapper to the retry
fixture measured 162.84 ms cold, 99.41 ms for Program construction, and 0.698
ms for warm analysis (20 cold samples and 717 warm samples). Constructor and
factory summary propagation therefore remains below one millisecond on the
warm path in this fixture; the result is observational rather than a large
class-graph performance bound.

Adding enabled and statically disabled conditional-registration calls measured
137.09 ms cold, 95.75 ms for Program construction, and 0.858 ms for warm
analysis (20 cold samples and 583 warm samples). The warm increase includes
per-call parsing and finite propositional discharge because conditional
declarations cannot reuse an unconditional summary; it remains below one
millisecond in this fixture.

Routing both enabled and disabled registration through a direct adapter wrapper
measured 142.44 ms cold, 97.09 ms for Program construction, and 1.204 ms for
warm analysis (20 cold samples and 416 warm samples). This is the first retry
fixture result above one millisecond on the warm path. The current
context-sensitive implementation re-walks a wrapper when boolean facts differ;
a reusable symbolic guarded summary is the next optimization target rather
than hiding this cost behind the unconditional cache.

Resolving the adapter's boolean guard through one reassignment-free `const`
alias measured 1.134 ms on the warm Program over 442 samples (1.64% relative
margin of error). This is slightly below the preceding 1.204 ms observation
and does not indicate a regression, but the context-sensitive wrapper walk
still dominates the sub-millisecond direct-boundary results.

## Weighted conservation synthesis

On 2026-08-23, the three-counter telemetry accounting dogfood with the
inductive invariant `2 * accepted + rejected === attemptedCost` measured
721.71 ms mean over three cold Z3-backed samples (3.66% relative margin of
error). This includes generation and independent init/preservation checking of
the bounded relational candidate pool. It demonstrates a practical sub-second
fixture at the default coefficient bound of two; it is not evidence that the
exponential coefficient-vector search scales to large arity. The candidate
limit remains a required safety boundary.

The three-counter request-capacity dogfood, whose synthesized relation is the
fixed sum `active + queued + remaining === 100`, measured 792.94 ms mean over
three cold Z3-backed samples (4.72% relative margin of error). This slightly
larger fixture includes three state-changing actions. As above, this is a
bounded-template observation, not a general affine-synthesis scaling claim.

After prioritizing bounded disequality-derived seeds and lazily proving
synthesized candidates, the same fixtures measured 128.66 ms for weighted
accounting and 132.65 ms for fixed capacity, each over 16 samples. Compared
with the preceding 721.71 ms and 792.94 ms observations, this is approximately
5.61x and 5.98x faster respectively. The optimization stops after a proven
candidate discharges the current obligation; it does not weaken eager checking
of explicitly selected strengthening properties.

Extending prioritized seeds to strict comparison guards reduced the existing
three-counter accounting fixture from 671.14 ms to 569.23 ms (1.18x) and the
four-counter routing fixture from 2,301.65 ms to 1,056.75 ms (2.18x), each from
one cold sample on 2026-08-23. These whole-lint measurements include bounded
reachability and vacuity checks that are unaffected by candidate ordering, so
the smaller three-counter gain is expected. More samples are needed before
treating these one-shot ratios as stable performance claims.

## Grouped resource-release switches

On 2026-08-23, analyzing the `grouped-resource-release.ts` dogfood measured
125.63 ms mean over five cold TypeScript Program samples (2.52% relative margin
of error). The fixture accepts two empty grouped case labels that converge on a
mandatory alias clear and reports the broken control where one concrete exit
does not clear the disposed resource alias. This is a small cold-program
measurement; it does not establish scaling for large switch or alias graphs.
After removing the default clause and proving exhaustiveness from the three-way
string literal union, the fixture measured 146.97 ms mean over five cold
samples (3.10% relative margin of error). The roughly 21 ms difference includes
TypeChecker union/case inspection and cold-run noise; this sample count is too
small to claim a stable regression.
Adding a fourth exhaustive state whose switch path returns instead of clearing
measured 131.63 ms mean over five cold samples (7.33% relative margin of
error). The variance overlaps both preceding observations; the useful result
is that reachability-aware return handling did not create a clear cold-path
regression in this small fixture.
After adding a second realistic early-return/clear function and its negative
control, the same benchmark measured 137.89 ms mean over five cold samples
(17.34% relative margin of error). The sample variance is too high to attribute
the difference to the two-statement join; it establishes only that the expanded
dogfood remains in the same approximate cold-analysis range.
After adding loop-carried delivery-session cleanup and its missing-clear
negative control, the fixture measured 126.77 ms mean over five cold samples
(2.13% relative margin of error). This is below the preceding noisy sample and
does not indicate a regression from the restricted loop-state join.
With clear-before-continue and clear-before-break paths added to the batch,
the fixture measured 128.81 ms mean over five cold samples (6.73% relative
margin of error), remaining within the prior cold-run range.

## Collection refinement receiver identity

On 2026-08-23, the Node Lease authority dogfood (eight Set/Map actions) measured
0.1080 ms mean for the syntax-only refinement validator and 0.0800 ms for the
validator over an already warm TypeScript Program. The latter resolved builtin
receiver symbols through aliases and generic constraints while rejecting a Set
subclass in the corresponding correctness test. The apparent 1.35x advantage
does not mean TypeChecker setup is free: this benchmark deliberately excludes
Program construction and compares repeated validation after a compiler or
Corsa frontend has already produced semantic state. Cold project setup should
be measured separately before selecting the strict path for a standalone CLI.

After adding a ninth action implemented through an aliased import and a
two-level helper graph, the same warm benchmark measured 0.1164 ms for the
syntax path (which conservatively reports that imported action unsupported)
and 0.0965 ms for the Program path (which proves it), over 4,294 and 5,183
samples respectively. These timings compare the actual gradual behaviors, not
equivalent proof strength; only the Program path establishes the imported
transition.

## Heterogeneous action completion

On 2026-08-24, after the telemetry refinement dogfood began retaining a return
path across catch/finally and executing a post-try update only on the caught
path, `parse and validate complete telemetry scalar refinement` measured
1.6952 ms mean over 295 samples (1.39% relative margin of error). The preceding
terminal-try fixture measured 1.5360 ms over 326 samples (0.54% relative margin
of error). This is a roughly 10% change in a simultaneously expanded fixture,
so it is recorded as a regression signal rather than attributed solely to the
new completion join. A stable isolated completion benchmark is still needed
before setting a performance gate.

After adding two telemetry recovery actions for catch-local return and rethrow,
the expanded fixture measured 1.9109 ms mean over 262 samples (0.59% relative
margin of error). To separate fixture growth from the control-flow operation,
the dedicated `join catch return and rethrow completions` benchmark validates
only two minimal actions and measured 0.2252 ms mean over 2,221 samples (0.38%
relative margin of error). This establishes a repeatable local baseline; it is
not yet a CI performance threshold.

After adding conditional return/throw overrides in finally, the dedicated
`join conditional finally overrides` benchmark measured 0.2368 ms mean over
2,112 samples (0.38% relative margin of error). The telemetry fixture, expanded
with a corresponding recovery-finalization action and negative controls,
measured 2.2709 ms mean over 221 samples (0.60% relative margin of error).
These remain syntax-path timings; Z3 scalar-update equivalence is invoked only
for mismatches through the explicit `WithZ3` validator and needs a separate
solver-cost baseline if its use grows.

After composing direct switch-case return and throw entries through catch,
finally, and the normal-only continuation, the dedicated
`join switch return and throw completions` benchmark measured 0.3485 ms mean
over 1,435 samples (0.43% relative margin of error). This is a syntax-path
baseline for a three-entry switch and must not be extrapolated to arbitrary CFG
or case counts.

After extending the completion lattice to validate pure value-bearing returns,
`join value return and throw switch completions` measured 0.4669 ms mean over
1,071 samples (2.74% relative margin of error). The returned expression is
normalized and checked for supported purity, but its result is not compared
with the temporal action's state transition.

With the throw branch changed from a primitive literal to a state-backed pure
expression, the same benchmark measured 0.3619 ms mean over 1,382 samples
(0.67% relative margin of error). This local run shows no regression signal;
the difference from the previous run is not treated as an optimization claim.

The dedicated `bind a conditional scalar throw payload` benchmark measured
0.1903 ms mean over 2,628 samples (2.44% relative margin of error). It covers a
conditional integer throw, completion-payload propagation, immutable catch
binding, and a catch-local predicate update; it does not cover non-scalar thrown
values.

The dedicated `bind switch-selected scalar throw payloads` benchmark measured
0.2350 ms mean over 2,128 samples (1.49% relative margin of error). It covers two
tracked integer payloads selected by scalar switch cases, the normal no-match
path, completion-payload joining, and catch-local predicate use. The benchmark
does not establish behavior for string/object payloads or dynamic case labels;
those remain fail-closed.

The dedicated `bind literal throw payloads through switch fallthrough`
benchmark measured 0.1815 ms mean over 2,755 samples (0.58% relative margin of
error). It covers normalized integer literal payloads, an empty case falling
through to a throwing case, a throwing default path, all-path throw completion
simplification, and catch-local numeric comparison. String and null payloads
remain negative controls because the scalar temporal IR cannot represent them.

The dedicated `project a direct record throw payload` benchmark measured
0.1746 ms mean over 2,864 samples (0.62% relative margin of error). It covers a
direct object literal with integer and boolean fields, immutable catch binding,
static field projection, and a catch-local compound predicate. String-valued,
effectful, and duplicate fields are negative controls; conditional record joins
are not claimed by this benchmark.

After adding field projection through conditional record joins, the dedicated
`project conditional record throw payloads` benchmark measured 0.2068 ms mean
over 2,418 samples (0.43% relative margin of error). It covers two normalized
object-literal payloads, branch-selected integer and boolean fields, and
catch-local control flow. A field missing from either branch is a negative
control and remains unproved; this run does not support dynamically computed
keys or general structural object typing.

The warm TypeChecker benchmark for 64 categorized DOM contracts measured
29.7828 ms mean over 20 samples (1.50% relative margin of error). Each contract
combines reflected Web IDL property access, attribute collection and method
reads/writes, tree-topology property and method reads, CharacterData property
and range-method reads/writes, compound clone/normalize operations, live-view
origin projection, receiver-scoped `innerHTML`, parent-scoped `outerHTML`, and
layout metrics. Property fallback lookup is indexed by member name rather than
scanning the complete contract registry. A preceding local run of the smaller
pre-`outerHTML` workload measured 60.6119 ms, so the observed reduction cannot
be attributed to the index or treated as a stable speedup. The benchmark reuses
one TypeScript Program and therefore does not measure parsing or program
construction. It is an observation, not a regression budget. Parent-presence
refinement, reassigned/escaping live views, and unreviewed Web IDL members still
fall outside this claim.

The warm-program Promise ownership benchmark for 64 structured throw
completions routed through catches measured 8.0718 ms mean over 186 samples
(1.64% relative margin of error). It rotates through explicit throws, direct
calls resolved as both `never` and `Throw<E>`, return, void, comma-tail,
all-throw ternary, statically selected `&&`/`||`, and statically nullish
`null`/`void`/global-`undefined` coalescing forms. It includes
TypeChecker-backed Promise discovery and the structured ownership fixed point,
but reuses one parsed Program. It is recorded as an observation rather than a
regression budget and does not measure program construction, nullable-union
selection, shadowed identifiers, or general expression-level exception edges.

On 2026-08-25, cold analysis of 64 functions using a loop-local retry with a
primitive local prefix, nested `try`/`finally`, exhaustive finite-literal
`switch` fallthrough into a tracked await, post-await handler work, and
`catch { pending = task(); continue }` measured 155.05 ms mean over 50 samples
(1.02% relative margin of error). The
benchmark includes TypeScript Program construction on every sample and the
Promise ownership loop fixed point. It is an observation rather than a
regression budget. It does not cover a possibly throwing operation before the
tracked `await`, replacement of the tracked generation before a later throw,
irreducible loops, or dynamically dispatched exception edges; those shapes
retain the conservative catch entry.

On 2026-08-25, generation of the bounded two-level nested-Suspense ownership
projection measured 0.0024 ms mean over 211,823 samples (0.24% relative margin
of error). The same warm run measured 18.1290 ms for parsing and classifying
128 opted-in React components and 22.1804 ms for classifying one reused
TypeScript Program. The nested measurement covers model text generation from
an already analyzed direct chain only; it excludes parsing, symbol resolution,
Quint execution, siblings/fragments, and suspension originating in a boundary
or fallback. It is an observation rather than a regression budget.

After extending the normalized primary graph to transparent Fragments and
multiple direct children, generation of a two-boundary/three-leaf Suspense-tree
projection measured 0.0016 ms mean over 304,401 samples (0.27% relative margin
of error). In the same run, the older direct-chain projection measured 0.0024
ms and parsing/classifying 128 opted-in components measured 18.1963 ms. These
sub-microbenchmark differences are dominated by workload and runtime noise and
must not be read as a speedup. The tree measurement excludes parsing, Program
symbol resolution, and Quint execution and is not a regression budget.

After adding TypeChecker-backed React `use(thenable)` causality, analysis of one
reused tiny Suspense Program measured 0.0740 ms mean over 6,761 samples (0.55%
relative margin of error). Generation of its already-analyzed causal tree model
measured 0.0011 ms over 448,931 samples (1.92% relative margin of error). The
Program benchmark includes a warm TypeChecker lookup and custom-Hook fixed
point but excludes Program construction; the generator excludes Quint
execution. The workload has one proven thenable leaf and one excluded static
leaf. Both measurements are observations, not regression budgets.

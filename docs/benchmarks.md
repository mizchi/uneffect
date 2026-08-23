# Benchmarks

Performance-sensitive static-analysis changes use Vitest Bench:

```sh
just bench
```

The benchmark suite is separate from correctness tests and currently covers
scalar constant folding, a SHA-256-sized readonly U32 table, and repeated table
reads. Results are local-machine observations, not portable pass/fail budgets.
Compare results on the same machine and runtime before and after a change.

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
paths, and an early-return `try`/`finally` cleanup path. In a paired five-sample
run, the deferred fixture measured 257.43 ms mean (22.90% relative margin of
error) and the otherwise identical direct-`const` baseline measured 257.29 ms
(15.47%). The effectively equal result provides no evidence of measurable
assignment-tracking overhead. Both public convenience calls construct a fresh
TypeScript Program; their noisy absolute times are cold standalone costs, not
incremental compiler-plugin latency or a regression budget.

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

# Benchmarks

Performance-sensitive static-analysis changes use Vitest Bench:

```sh
just bench
```

The benchmark suite is separate from correctness tests and currently covers
scalar constant folding, a SHA-256-sized readonly U32 table, and repeated table
reads. Results are local-machine observations, not portable pass/fail budgets.
Compare results on the same machine and runtime before and after a change.

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

Promise ownership analysis of the telemetry delivery dogfood fixture measured
133.64 ms mean over five samples (5.80% relative margin of error). The fixture
contains exhaustive literal-union `switch` paths, fallthrough-aware ownership,
and an early-return `try`/`finally` cleanup path. This public convenience API
constructs a fresh TypeScript Program for every call, so the result is a cold
standalone-check cost rather than the expected incremental compiler-plugin cost.

Symbol-linked Promise assimilation for the legacy adapter dogfood fixture
measured 152.51 ms mean over five cold samples (8.70% relative margin of error).
The analyzer constructs a TypeScript Program, performs a two-pass executor and
reaction scan, and connects the outer resolver to the inner operation. As with
the ownership benchmark, Program construction dominates and the small sample is
an observation rather than a regression threshold.

Classifying the mixed Promise combinator dogfood fixture measured 152.90 ms
mean over five cold samples (11.17% relative margin of error). The fixture has
one immediate cached value, one sparse `undefined` slot, and one thenable that
must pass through assimilation. The high variance and fresh TypeScript Program
construction make this a baseline observation, not an editor-latency budget.

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

These cases remain on the purely static path and do not invoke Z3. Solver
benchmarks must be reported separately because initialization and individual
proof queries have a different cost profile.

The first temporal semantic-lint fixture issues Z3 queries for five properties,
one guarded action, and pairwise implication candidates. Its one-sample cold
run measured 806.14 ms. This is acceptable for an explicit build command but
not yet an editor latency target; context reuse and batched classification
remain possible optimizations.

A bounded-reachability fixture with three actions, one unreachable action, and
four transition steps measured 327.73 ms mean over two samples. Runtime grows
with the number of actions, state variables, and unroll depth; the configured
depth is therefore part of both the diagnostic and the performance contract.

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

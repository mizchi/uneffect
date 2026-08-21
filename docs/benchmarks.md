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

These cases remain on the purely static path and do not invoke Z3. Solver
benchmarks must be reported separately because initialization and individual
proof queries have a different cost profile.

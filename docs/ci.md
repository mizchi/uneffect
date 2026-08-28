# Continuous integration

The CI test split is a capability partition, not a coverage reduction. The
authoritative manifest is `ci/test-tiers.ts`; `test/ci-tiers.test.ts` fails when
a `test/*.test.ts` file is missing from the manifest or appears in more than one
tier. It also rejects a directly spawned Z3 or Quint process assigned to a tier
that does not provision that verifier.

Workflow concurrency is keyed by workflow, ref, and commit SHA. Duplicate
deliveries of one commit cancel each other, while a delayed push event for an
older SHA cannot cancel proof evidence already running for a newer commit.

| Tier | Runtime dependencies | Purpose |
| --- | --- | --- |
| `fast` | Node.js and Rust | Type checking, parser/analyzer unit tests, Rust parity, build, and package checks |
| `z3` | none beyond Node; native Z3 is optional and WASM is bundled | Hoare, ownership, property generation, and typed-array obligations |
| `quint` | Quint evaluator | Promise, resource, event-loop, temporal-composition, and ownership models |
| `integration` | native Z3, Quint, and Java/TLC | Three complete shards (`core`, `applications`, and `dogfood`) cover end-to-end acceptance, dogfood, evidence import, the `fixtures/` corpus, and mixed backend tests |
| `exhaustive` | Java/TLC through Quint | The bounded exhaustive invalidation model |

Files that exercise both verifier APIs belong to `integration`, even when one
backend dominates most test cases. The Node Lease suite is intentionally in
that tier because it runs Quint subprocesses and Z3 reachability in the same
application model.

Set `UNEFFECT_CI_TIER` to select a tier through Vitest. A generated property
test may launch a child Vitest process with an explicit `.test.ts` path. That
explicit selection takes precedence over an inherited tier, preventing the
parent CI filter from hiding generated tests.

`just dogfood` selects only `test/dogfood.test.ts` from the `integration` tier,
but still uses the same manifest validation, per-test process isolation,
deadlines, and bounded solver-crash recovery as CI. The runner rejects a file
that does not belong to the selected tier. A successful dogfood run therefore
means that every discovered dogfood case completed successfully; it does not
promote those finite examples into a whole-program proof.

The GitHub workflow installs `just` and the Quint evaluator from versioned
official release assets with SHA-256 verification. JavaScript actions are
pinned by full commit SHA. Superseded runs on the same ref are cancelled so a
stale solver-heavy run cannot block evidence for the current commit.

The manifest-checked verifier-free `fast` tier may use Vitest file parallelism.
Every solver-bearing file runs in its own Vitest child process in both local
full checks and individual CI jobs. Z3's process-local WASM heap can approach
2 GiB; merely scheduling files serially in one process still allowed an early
suite to corrupt the heap and make later Node Lease checks time out with
`memory access out of bounds`. Per-file process isolation releases the WASM
heap after every suite. A solver-dense file can opt into per-test process
isolation; `node-lease.test.ts` does so because several independent bounded Z3
queries were enough to exhaust one file process on GitHub. A manifest test
keeps those selectors synchronized with every declared test. GitHub still runs
independent capability-tier jobs in parallel, so this bounds memory without
collapsing CI-level parallelism.

The dedicated `z3` CI job forces the bundled WASM backend, continuously proving
that native Z3 remains optional. The solver-heavy integration job installs and
forces native Z3 so large telemetry proofs do not consume the WASM runtime's
2 GiB memory ceiling. `test/z3-backend.test.ts` always exercises an
absent-native fallback. The native/WASM common layer covers Hoare contracts,
ownership evidence, temporal semantic/reachability lint, named-observation
counterexample decoding, property model enumeration, and typed-array
obligations.

The upstream Z3 WASM worker can still fail nondeterministically in an otherwise
fresh process with `memory access out of bounds` from `z3-built.wasm`. The tier
runner captures each explicitly isolated test and permits at most three process
attempts only when a recognized crash signature is present. One Node Lease strengthening
query has also twice taken Z3 from its usual roughly one-second runtime to the
60-second Vitest limit in a fresh process. That exact file, test name, and
timeout signature receives the same one-process retry. Because synchronous Z3
WASM can block Vitest's JavaScript timer along with the query, every explicitly
isolated test also has a parent-process deadline 15 seconds beyond the Vitest
limit. Reaching that hard deadline kills the child and is retryable under the
same bounded policy. Other reported timeouts and all assertion failures are
never retried, and a repeated crash or timeout still fails the job. This is
process recovery for recognized verifier-runtime failures, not a flaky-test
allowance or weakened proof obligation.

On 2026-08-29 an existing `evidence-optimizer` case exceeded its 30-second
Vitest budget by 375 ms on a GitHub-hosted runner. The failed-job rerun passed
that case in 25.868 seconds, but the serial gate still took more than 15
minutes. [#46](https://github.com/mizchi/uneffect/issues/46) therefore splits
the exact integration manifest into three non-overlapping matrix shards. The
manifest test proves that every integration file occurs in exactly one shard;
local timing placed the short isolated Node Lease suite in `core`, producing
roughly balanced test bodies of 103, 138, and 163 seconds without paying for a
fourth runner setup.

The measured project-wide mutation-substitution case has a 45-second budget,
1.5 times the observed failing duration. This is a timeout calibration, not an
automatic retry: an ordinary Vitest timeout still fails immediately. Every
shard writes `uneffect.ci-timing/v1` JSONL start/completion events with file,
test selector, attempt, duration, exit status, signal, and a failure class.
Artifacts distinguish semantic/test failures, external-verifier timeouts,
hard process deadlines, and recognized verifier runtime failures. Events are
uploaded with `if: always()`, including a partially written start event when a
runner or child process is interrupted. A green rerun remains operational
evidence and does not erase an earlier timeout or justify weakening a proof
obligation.

Quint-bearing files use a separate file-granularity boundary. If a live Vitest
process reports that its child `pnpm exec quint` process failed with
`ETIMEDOUT`, the runner repeats that file at most twice in fresh processes.
Quint invariant violations, parse/type errors, ordinary nonzero verdicts, and
Vitest test timeouts do not match this classifier and are never retried. File
granularity avoids starting a separate Vitest process for every Quint-backed
case while still preventing one transient child-process timeout from erasing
the original incident.

Each isolated process attempt receives a private
`.uneffect/verifier-retry-evidence/.../attempt-N` directory. Before a backend is
entered, the common Z3 layer writes the complete SMT-LIB input under its SHA-256
digest and appends a `start` event containing the process RSS and heap snapshot.
Every returned backend attempt appends its version, verdict/failure kind,
stdout/stderr, exit code, duration, and another resource snapshot; a final event
records the selected result. A killed or corrupted process therefore still
leaves its input and start event. Repeated inputs share one digest file while
retaining distinct execution records.

A clean first attempt removes this opt-in telemetry. A failed or retried test
keeps every attempt plus a `uneffect.verifier-retry-evidence/v1` manifest
linking the directories to the exact command, CI tier, source test file,
selector, retry reason, signal, exit status, duration, output digests/files, and
parent-process memory. The Z3, Quint, and integration jobs upload that directory with
`if: always()` even when a later retry succeeds. SMT-LIB and solver output can
contain application literals, so evidence recording is disabled outside the
isolated runner unless `Z3ExecutionOptions.evidence` or
`UNEFFECT_SOLVER_EVIDENCE_DIR` explicitly enables it.

This preserves the incident needed to distinguish a deterministic limit from
process corruption. Repeated timeouts still fail after the bounded attempts,
and the retained bundle is diagnostic evidence rather than proof evidence.

The retry manifest now classifies only cross-process observations tied to one
recorded SMT-LIB digest. A failed digest that passes in a fresh process is
`transient-runtime-failure`; the same digest exhausting time or memory through
the full attempt budget is `deterministic-resource-limit`; repeated assertion,
heap-corruption, or memory-fault signatures are
`reproducible-runtime-failure`. Missing or changing digests remain
`inconclusive`. A Quint child timeout that passes on retry is separately
`transient-external-process-failure`; exhausting the attempt budget is
`reproducible-external-process-failure`. These classifications describe process
execution only. A passed retry is never serialized as an ordinary clean pass.

The WASM job separately runs the telemetry-routing conservation dogfood three
times in fresh processes. It requires identical digest sets and solver-call
counts, caps the combined positive/negative-control run at 64 executions, and
uploads per-run duration/RSS evidence. This is a bounded repeat regression for
one realistic model, not a general Z3 stress guarantee.

The first measured split reduced the local fast gate from roughly 35–42 seconds
for all TypeScript tests (and about six minutes on GitHub) to about nine seconds
including TypeScript checking and all Rust tests. Solver tiers still execute
every excluded test independently; the manifest coverage test makes that claim
machine-checkable as new files are added.

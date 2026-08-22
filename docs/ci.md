# Continuous integration

The CI test split is a capability partition, not a coverage reduction. The
authoritative manifest is `ci/test-tiers.ts`; `test/ci-tiers.test.ts` fails when
a `test/*.test.ts` file is missing from the manifest or appears in more than one
tier. It also rejects a directly spawned Z3 or Quint process assigned to a tier
that does not provision that verifier.

| Tier | Runtime dependencies | Purpose |
| --- | --- | --- |
| `fast` | Node.js and Rust | Type checking, parser/analyzer unit tests, Rust parity, build, and package checks |
| `z3` | Z3 | Hoare, ownership, property generation, and typed-array obligations |
| `quint` | Quint evaluator | Promise, resource, event-loop, temporal-composition, and ownership models |
| `integration` | Z3, Quint, and Java/TLC | End-to-end acceptance, dogfood, evidence import, and mixed backend tests |
| `exhaustive` | Java/TLC through Quint | The bounded exhaustive invalidation model |

Files that exercise both verifier APIs belong to `integration`, even when one
backend dominates most test cases. The Node Lease suite is intentionally in
that tier because it runs Quint subprocesses and Z3 reachability in the same
application model. Its two-pass strengthening case has an explicit 60-second
per-test ceiling; this bounds slow shared-runner execution without weakening
the solver obligations or skipping either pass.

Set `UNEFFECT_CI_TIER` to select a tier through Vitest. A generated property
test may launch a child Vitest process with an explicit `.test.ts` path. That
explicit selection takes precedence over an inherited tier, preventing the
parent CI filter from hiding generated tests.

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
heap after every suite. GitHub still runs independent capability-tier jobs in
parallel, so this bounds memory without collapsing CI-level parallelism.

The first measured split reduced the local fast gate from roughly 35–42 seconds
for all TypeScript tests (and about six minutes on GitHub) to about nine seconds
including TypeScript checking and all Rust tests. Solver tiers still execute
every excluded test independently; the manifest coverage test makes that claim
machine-checkable as new files are added.

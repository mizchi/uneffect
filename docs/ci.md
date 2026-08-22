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

Set `UNEFFECT_CI_TIER` to select a tier through Vitest. A generated property
test may launch a child Vitest process with an explicit `.test.ts` path. That
explicit selection takes precedence over an inherited tier, preventing the
parent CI filter from hiding generated tests.

The GitHub workflow installs `just` and the Quint evaluator from versioned
official release assets with SHA-256 verification. JavaScript actions are
pinned by full commit SHA. Superseded runs on the same ref are cancelled so a
stale solver-heavy run cannot block evidence for the current commit.

The first measured split reduced the local fast gate from roughly 35–42 seconds
for all TypeScript tests (and about six minutes on GitHub) to about nine seconds
including TypeScript checking and all Rust tests. Solver tiers still execute
every excluded test independently; the manifest coverage test makes that claim
machine-checkable as new files are added.

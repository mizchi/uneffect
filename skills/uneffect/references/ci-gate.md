# Gating CI with the Uneffect CLI

Read this before writing a verification script around Uneffect. The CLI already
computes the acceptance decision, so a consumer gate is usually one command per
boundary plus the few checks the CLI cannot make for you.

## Do not re-assert the decision in a wrapper script

Libraries often wrap the check in a script that spawns Uneffect, saves the
report, and asserts its fields one by one. Most of those assertions repeat what
the exit code of `check --assurance <profile>` already decided:

| Hand-written assertion | Already enforced by |
| --- | --- |
| exit code 0, `outcome === "passed"` | the exit code; `outcome` is `failed` whenever it is non-zero |
| `assurance.passed === true` | the exit code, once `--assurance` is given |
| every contract artifact is `verified` | every profile; a counterexample is a violation, anything else is unknown |
| `assurance.status === "verified"`, zero assumptions | `--assurance verified` only; any assumption or trusted summary is a blocker |
| `status` is `verified` or `assumed` | `--assurance declared` or `no-unknown`; a passing result has no other status |
| each selected file emitted evidence | every profile; an uncovered selected file is a blocker |
| saving the report on failure | `--json`, which writes the report to stdout when the check fails (not on a usage error or crash) |

Gate on the exit code, not on `assurance.passed` alone: an error diagnostic such
as `effect/missing` fails the exit code and `outcome` without appearing among
the assurance blockers.

Without `--assurance`, exit code 0 means only that no error diagnostic was
reported. It is not a proof claim.

Compiler parity is a real check only on the `--typescript-program` path with
`--project`. The default path reports `parity: "exact"` by construction,
because it compares its own compiler with itself, so asserting it there proves
nothing.

## Know which path runs

The default `check` uses Corsa and Oxc. These switch it to the TypeScript 6
Program path without `--typescript-program`: a `--project` whose tsconfig has
`references`, `--contract-summary`, `--resource-contract`,
`--declaration-transforms`, `--module-entry`, and the build-artifact flags.
`--project` with no files on that path emits a `uneffect-workspace-check/v1`
report, which has no top-level `.contracts` or `.assurance.coverage`. The `jq`
filters below read a `uneffect-check/v1` report, so pass the selected files
explicitly and check `.schema` if in doubt.

The two paths differ in what they can establish:

- **Default (Corsa) path.** Contract artifacts can be `verified`, but function
  effect summaries stay `inferred`: the native check does not mark a declared
  effect bound as declaration-checked. Only `--assurance no-unknown` can pass.
  `declared` and `verified` fail closed with `effect summary is inferred, not
  declaration-checked`.
- **`--typescript-program` path.** Declared effect summaries can be `verified`,
  so `declared` and `verified` can pass. Compiler parity is assessed against
  the analyzer's TypeScript 6 version, so a consumer on TypeScript 7 gets
  `consumer TypeScript ... differs from analyzer TypeScript ...` as a blocker.

If a profile cannot pass on your toolchain, select a weaker profile that can and
restore what it drops with an explicit check, as below. Do not loosen the
assertions to make a stricter profile look green.

## A contract boundary

On TypeScript 6, `verified` states the whole claim:

```sh
pnpm exec uneffect check --project tsconfig.json --typescript-program --assurance verified --json \
  src/ring-cursor.ts verification/ring-contracts.ts > reports/uneffect-contracts.json
```

On the default path, `no-unknown` is the strongest profile that can pass. It
accepts assumptions, so keep the two requirements `verified` would have added:

```sh
pnpm exec uneffect check --project tsconfig.json --assurance no-unknown --json \
  src/ring-cursor.ts verification/ring-contracts.ts > reports/uneffect-contracts.json
jq -e '.assurance.status == "verified" and (.assumptions.entries | length) == 0' \
  reports/uneffect-contracts.json
```

## Require the obligations you rely on

Coverage is per file. Deleting the contract comments from one function leaves
the file covered by its other functions, so the profile still passes with one
fewer obligation. Name every function the gate relies on:

```sh
jq -e '["lengthValue", "advanceIndex", "fullAfterRead", "fullAfterWrite", "readContract", "writeContract"]
  - [.contracts[] | select(.status == "verified") | .obligation.functionName]
  | if length == 0 then true else ("missing verified contracts: " + join(", ") + "\n" | halt_error) end' \
  reports/uneffect-contracts.json
```

It exits non-zero and names each function that no longer has a verified
contract artifact. Use `.effects[] | select(.evidence == "verified") | .functionName`
for the same check on declaration-checked effect summaries.

## A boundary that relies on builtin contracts

A boundary that calls reviewed builtins such as `Uint8Array` or `Number` members
records each call in the assumption ledger. `verified` rejects every entry, so
gate that boundary with `declared` (TypeScript 6) or `no-unknown`, and keep the
ledger in the stored report:

```sh
pnpm exec uneffect check --project tsconfig.json --typescript-program --assurance declared --json \
  src/ring-buffer.ts > reports/uneffect-effects.json
jq '.assumptions.entries | length' reports/uneffect-effects.json
```

A passing result reports `assumed` when it rests on such a contract. That is the
correct label; do not relabel it `verified`.

## Put it together

The check exits 1 on failure, so under `set -e` the following steps would not
run. Record the status, print what the report says, and exit with it at the end:

```sh
#!/bin/sh
set -u
mkdir -p reports
status=0
pnpm exec uneffect check --project tsconfig.json --assurance no-unknown --json \
  src/ring-cursor.ts verification/ring-contracts.ts > reports/uneffect-contracts.json || status=1
if [ -s reports/uneffect-contracts.json ]; then
  jq -r '"Uneffect \(.assurance.profile): \(.assurance.status) (\(.assurance.coverage.contractArtifacts) contract artifacts, \(.assurance.coverage.assumptions) assumptions)"' \
    reports/uneffect-contracts.json
  jq -e '.assurance.status == "verified" and (.assumptions.entries | length) == 0' \
    reports/uneffect-contracts.json > /dev/null || status=1
  jq -e '["lengthValue", "advanceIndex", "fullAfterRead", "fullAfterWrite", "readContract", "writeContract"]
    - [.contracts[] | select(.status == "verified") | .obligation.functionName]
    | if length == 0 then true else ("missing verified contracts: " + join(", ") + "\n" | halt_error) end' \
    reports/uneffect-contracts.json > /dev/null || status=1
else
  echo "uneffect wrote no report" >&2
  status=1
fi
exit "$status"
```

## Authoritative details

- [`docs/cli.md`](../../../docs/cli.md)
- [`docs/assurance-boundaries.md`](../../../docs/assurance-boundaries.md)

# Command line

The package publishes one binary, `uneffect`. Every capability is a subcommand
of it, so `uneffect --help` is the complete entry point and each subcommand
documents its own options with `uneffect <command> --help`.

## Install

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect check src/*.ts
```

TypeScript is a peer dependency: the analyzer reads your program through the
same compiler you build with, so the project chooses the version. Node.js 24 or
newer is required.

`@informalsystems/quint` is an optional peer dependency. The model commands
generate Quint source with nothing installed; add the package only to run what
they generate, and its own `quint` binary comes with it:

```sh
npm install --save-dev @informalsystems/quint
npx uneffect spec quint src/protocol.ts > protocol.qnt
npx quint run protocol.qnt
```

## Commands

| Command | Purpose |
| --- | --- |
| `check [<file.ts> ...]` | Effect, contract, and async-safety diagnostics. The default command, so `uneffect <file.ts>` runs it. `--project` preserves consumer compiler options and can select the project's root files. |
| `doctor` | Check the toolchain a run depends on: Node, the peer TypeScript, `@types/node`, the Z3 WASM build, the optional Quint peer, and the optional `java` command. |
| `spec <backend> <file.ts> [function]` | The specification IR, or the verifier program a backend consumes: `ir`, `lint`, `z3`, `quint`, `compose`, `async-quint`, `web-loop-quint`, `node-loop-quint`, `promise-quint`. |
| `instrument <file.ts>` | The source with runtime assertions inserted for contracts or ownership. |
| `evidence <file.ts>` | The machine-readable effect evidence artifact plus a separate proof-eligibility assessment, as JSON. |
| `module-order <entry.ts>` | The source-mapped ESM initialization partial-order artifact; `--require` rejects non-proof-grade extraction. |
| `resource-model <file.ts>` | The Quint resource-safety model. |
| `async-model <file.ts> <function>` | The unified Quint model of Promise, exception, and resource flow. |

`check` takes `--infer` (only check functions that already declare effects),
`--strict` (an unknown effect name is an error, not a warning),
`--project <tsconfig.json>` (use consumer compiler options and, when no files
are listed, its `include`/`files` roots; report exact TypeScript package/version
parity),
`--assurance no-unknown|declared` (fail when emitted evidence does not meet the
selected CI profile), and
`--evidence` (also print the proved obligations and the inferred effect of every
function), and `--json` (write one `uneffect-check/v1` decision report to stdout
and suppress the text report). JSON always contains normalized diagnostics,
effect summaries, contract artifacts, and the optional assurance assessment;
therefore it remains useful on exit 1 and does not require `--evidence`. Its
schema is published as `schemas/uneffect-check-v1.schema.json`. Both `check` and `evidence` accept
`--config <uneffect.registry.json>` for a versioned caller-owned semantic
registry. `instrument` takes `--ownership`, `--verify-ownership`, and
`--ownership-evidence <cache.json>`. `spec lint` takes the strengthening and
synthesis options listed by its own `--help`.

## Checking the prerequisites

The toolchain has real requirements — Node 24, a TypeScript peer, and a working
Z3 WASM build — and most of them fail late and confusingly if they are missing.
`uneffect doctor` checks all of them before you depend on a run:

```
$ uneffect doctor
ok       node                    v24.4.0 (engines: >=24)
ok       typescript              6.0.3 at node_modules/typescript (peer: >=6.0.0-dev.20260820)
ok       @types/node             24.13.3 at node_modules/@types/node
ok       z3-solver               4.16.0, probe query answered in 380 ms
warn     @informalsystems/quint  not installed
           needed by: running the models `spec quint`, `resource-model`, and `async-model` generate
           fix: npm install --save-dev @informalsystems/quint, an optional peer; it brings its own `quint` binary, and generating the models needs nothing
warn     java (command)          not found on PATH
           needed by: exhaustive Quint verification through Apalache/TLC
           fix: install a JDK 21 or newer only if you run `quint verify`; simulation and every uneffect command work without it
```

Nothing in the list is a native install: every solver the toolchain runs itself
is the `z3-solver` WASM build, so `check`, `instrument --verify-ownership`, and
the evidence artifacts need no Z3 binary on the machine. The two optional
entries are for running what the model commands generate, not for producing it.

Packages are resolved from the project being checked first, then from this
installation, because a peer dependency belongs to the project and only the
project's copy is the one a run uses.

Every check names the commands it blocks and how to satisfy it. Unmet
requirements exit 1; missing optional tools are warnings and exit 0. `--json`
emits the same result for CI, and `--skip-solver-probe` skips loading the Z3
WASM build, which is the slow check.

When any other command fails for a reason that is not about your source, it
points at `uneffect doctor` rather than printing a bare stack; set
`UNEFFECT_DEBUG=1` to see the stack anyway.

## Streams and exit codes

Generated output — instrumented source, Quint modules, SMT-LIB, JSON artifacts —
goes to stdout, so it can be piped into a file or a verifier. Diagnostics and
progress go to stderr.

`check --json` is the deliberate exception to the usual diagnostic stream: it
places the complete decision, including failed diagnostics and assurance
blockers, on stdout and leaves stderr empty. CI should inspect both the process
exit code and `outcome`; an omitted `--assurance` is represented as
`"assurance": null`, not as proof-grade assurance.
When `--project` is present, `project.compiler` records the analyzer and
consumer package paths, versions, and `exact | mismatch | unknown` parity.
Assurance requires `exact`; resolution failure and even patch-version drift are
unknown evidence because TypeChecker behavior can change between releases.
When a no-positional-file project is a solution root, the command emits
`uneffect-workspace-check/v1`: referenced configs are checked as separate
compiler domains and `projects` retains their individual
`uneffect-check/v1` decisions. The workspace also records `references`,
child-first `buildOrder`, per-config root files and provenance, graph/assurance
`blockers`, and one aggregate decision. Missing or invalid references, cycles,
empty leaves, and duplicate root ownership fail closed. The workspace result
also records `effectComposition`: uniquely resolved child function and module summaries
are applied only when their evidence is `verified`. Inferred/trusted/unknown or
ambiguous summaries, inaccessible/non-exported function-closure or module `Mutate`,
unbounded iterator Effect parameters, and opaque iterator arguments produce blockers.
Parameter-rooted mutation is instantiated from addressable call arguments. An exported
closure root is instantiated only through a named or namespace import resolving to the
same TypeChecker declaration; JSON records its stable project/source/export identity.
Fully bounded iterator parameters are instantiated at resolved call sites. Other proof domains and emitted build-artifact contents are
not composed or validated.

Add `--require-build-artifacts` when the checked boundary consumes composite
outputs and CI must reject missing or stale `.d.ts`/`.tsbuildinfo` state:

```sh
npx uneffect check --project tsconfig.json --infer \
  --assurance no-unknown --require-build-artifacts --json
```

`buildArtifacts` always records the TypeScript SolutionBuilder dry-run status
and source messages. Without the flag it is observational and appears as an
exclusion. With the flag, `stale` or `unknown` adds an assurance blocker. A
`fresh` result means TypeScript considers the configured build current; it is
not a cryptographic or semantic attestation of output bytes.

| Code | Meaning |
| --- | --- |
| 0 | Nothing to report. |
| 1 | The checked program failed: an error-severity diagnostic, or a lint that found something. |
| 2 | The command line was wrong: an unknown command, an unknown option, or a missing argument. |

Options are parsed strictly. A misspelled flag such as `--stict` is a usage
error rather than a silently ignored word, so a typo never turns a strict run
into a permissive one.

## Caller-owned semantic registry

Internal package and platform contracts can be supplied without changing
Uneffect's installed registry:

```json
{
  "$schema": "./node_modules/@mizchi/uneffect/schemas/uneffect-registry-v1.schema.json",
  "schema": "uneffect-registry/v1",
  "builtinRegistryVersion": 2,
  "moduleInitializations": [{
    "module": "@acme/telemetry",
    "runtime": { "kind": "package", "version": "4.2.1" },
    "effects": ["Net<\"intake.example.com:443\">"],
    "evidence": "trusted",
    "trustReason": "reviewed package initialization",
    "trustOwner": "observability-platform",
    "trustExpiresOn": "2027-01-01"
  }]
}
```

```sh
npx uneffect check --config uneffect.registry.json --assurance no-unknown src/main.ts
npx uneffect evidence --config uneffect.registry.json src/main.ts
```

The runtime parser is intentionally stricter than ordinary JSON loading. It
rejects unknown keys, unknown schema or builtin-registry revisions, duplicate
identities, invalid effects and dates, unsupported operation kinds, and a
package/Node runtime-kind mismatch. Caller entries replace default entries with
the same identity. Therefore a stale caller review cannot silently fall back to
an older default contract. Other default entries remain available.

All caller contracts are `trusted` assumptions and require a reason and owner;
they never become `verified` merely because they came from configuration.
Package initialization is bound to an exact resolved package version and Node
initialization to an exact runtime major. A mismatch becomes `unknown`.
Evidence artifacts include the digest of the effective merged registry.

Registry v1 supports module-initialization may-effects and symbol-resolved
`effect`/`scoped-effect` builtin overlays, plus declaration fingerprints and
path-result refinements. Specialized scheduler, DOM, Promise, filesystem, and
ownership operation records are deliberately not accepted from JSON yet; their
semantics remain curated code-owned contracts.

## Versions

`uneffect --version` reports the published npm version. The contract layers —
CLI surface, evidence schema, builtin registry, Corsa interchange, optimizer
obligations, and the Rust crate — carry their own version, which is what an
evidence artifact records as `uneffectVersion`; see
[native integration](./native-integration.md).

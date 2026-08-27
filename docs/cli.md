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
| `doctor` | Check the toolchain a run depends on: Node, the peer TypeScript, `@types/node`, the selected Z3 backend, the optional Quint peer, and the optional `java` command. |
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
`--assurance no-unknown|declared|verified` (fail when emitted evidence does not
meet the selected CI profile; `verified` also requires an empty collected
assumption ledger), and
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
Z3 backend — and most of them fail late and confusingly if they are missing.
`uneffect doctor` checks all of them before you depend on a run:

```
$ uneffect doctor
ok       node                    v24.4.0 (engines: >=24)
ok       typescript              6.0.3 at node_modules/typescript (peer: >=6.0.0-dev.20260820)
ok       @types/node             24.13.3 at node_modules/@types/node
ok       z3 backend              native Z3 version 4.16.0 - 64 bit, probe query answered in 14 ms
warn     @informalsystems/quint  not installed
           needed by: running the models `spec quint`, `resource-model`, and `async-model` generate
           fix: npm install --save-dev @informalsystems/quint, an optional peer; it brings its own `quint` binary, and generating the models needs nothing
warn     java (command)          not found on PATH
           needed by: exhaustive Quint verification through Apalache/TLC
           fix: install a JDK 21 or newer only if you run `quint verify`; simulation and every uneffect command work without it
```

The default `UNEFFECT_Z3_BACKEND=auto` policy uses a working native `z3` first
for Hoare contracts, ownership evidence, temporal semantic lint, bounded
reachability, and counterexample extraction, then uses the bundled `z3-solver`
WASM build if native startup fails. A native timeout does not fall back by
default, because retrying an expensive query on a second engine can conceal a
resource limit. `UNEFFECT_Z3_BACKEND=native` or `wasm` requires exactly that
runtime, and `UNEFFECT_Z3_PATH=/absolute/path/to/z3` pins the executable.
`sat`, `unsat`, and `unknown` are semantic verdicts and are never retried on a
different runtime. Invalid SMT-LIB is classified separately and is not a
fallback trigger; this also guards against the WASM parser treating an ignored
top-level command as an empty satisfiable query. Evidence retains every failed
infrastructure attempt.

Native Z3 is optional: systems without it still run through WASM. Temporal
counterexamples decode named Bool/Int observations back into scalar, Set, Map,
and record traces on either runtime. Generated property tests enumerate named
model observations on the same boundary, and typed-array obligations submit
the same reviewable SMT-LIB to either backend.

Packages are resolved from the project being checked first, then from this
installation, because a peer dependency belongs to the project and only the
project's copy is the one a run uses.

Every check names the commands it blocks and how to satisfy it. Unmet
requirements exit 1; missing optional tools are warnings and exit 0. `--json`
emits the same result for CI, and `--skip-solver-probe` skips probing the
selected native/WASM backend.

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
Every Effect entry whose `evidence` is `unknown` includes a non-empty
`unknownReasons` array. The schema requires it and forbids the field for
non-unknown evidence, preventing an unexplained unknown or stale reason list.
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
ambiguous summaries, inaccessible/non-exported `Mutate`, host-global aliases,
unbounded iterator Effect parameters, and opaque iterator arguments produce blockers.
An empty ledger has status `not-applicable`; `verified` requires at least one
accepted link, preventing an unexercised composition domain from looking proved.
Parameter-rooted mutation is instantiated from addressable call arguments. An exported
function-closure or module-initialization root is instantiated only through a
named or namespace import resolving to the same ultimate TypeChecker declaration,
including re-export chains; JSON records its stable project/source/export identity.
Same-realm `globalThis` is recorded separately as
`{ "kind": "ambient", "identity": "ecmascript:realm.globalThis" }`; this is
not a claim about Workers, iframes, `window`, Node `global`, or `process`.
Fully bounded iterator parameters are instantiated at resolved call sites. Each
Effect link includes `declarationIntegrity`; the child `.d.ts` must byte-match a
same-compiler in-memory declaration re-emission. `refinementComposition`
separately records direct scalar child actions that verify locally and remain
valid after substitution into the annotated parent action. A guarded action is
accepted only through a sole direct wrapper call; the JSON link includes the
inherited `guard`. Links retain producer/consumer compiler/config provenance
and the same declaration integrity evidence. One unguarded call may pass through
one TypeChecker-resolved, write-screened local function helper, with the bounded
path emitted as `callPath`. Guarded indirect calls, deeper/reassigned/cyclic
helpers, guarded wrappers with additional work, collection-valued updates, and
transformed declaration cases are not composed. Other proof domains are not
composed.

Add `--require-build-artifacts` when the checked boundary consumes composite
outputs and CI must reject missing or stale `.d.ts`/`.tsbuildinfo` state:

```sh
npx uneffect check --project tsconfig.json --infer \
  --assurance no-unknown --require-build-artifacts --json
```

`buildArtifacts` always records the TypeScript SolutionBuilder dry-run status
and source messages. Without the flag it is observational and appears as an
exclusion. With the flag, `stale` or `unknown` adds an assurance blocker. A
`fresh` result means TypeScript considers the configured build current. Effect
composition additionally compares SHA-256-bound expected/actual declaration
bytes and rejects post-build tampering; this still trusts the selected compiler.
`outputIntegrity.status` is `not-checked` unless exact artifact assurance was
requested, so JSON consumers cannot mistake an omitted check for a successful one.

Use `--require-exact-build-artifacts` when the deployed boundary is exactly the
JavaScript emitted by these TypeScript projects. It implies the freshness gate
and records `outputIntegrity` for emitted declarations and `.js`/`.mjs`/`.cjs`
files. Missing or changed bytes fail closed even if their timestamp makes the
SolutionBuilder result `fresh`. Projects using `noEmit`, `emitDeclarationOnly`,
bundlers, or later transforms are deliberately rejected: their deployed-code
mapping has not been verified by this mode.

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
  }],
  "contracts": [{
    "symbol": { "module": "@acme/telemetry", "export": "flush" },
    "runtime": { "kind": "package", "version": "4.2.1" },
    "evidence": "trusted",
    "trustReason": "reviewed flush authority",
    "trustOwner": "observability-platform",
    "operation": { "kind": "effect", "effect": "Console" }
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
a different package version. External package function contracts require an
exact package runtime; the assumption ledger records that version. A contract
without `operation` is a reviewed zero-authority call, not a wildcard purity
rule. Other default entries remain available.

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

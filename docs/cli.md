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
| `check [<file.ts> ...]` | Effect, contract, async-safety, async-iterator cleanup, typed-array, and Transferable ownership diagnostics. The default command, so `uneffect <file.ts>` runs it. `--project` preserves consumer compiler options and can select the project's root files; `--module-entry` opts a solution workspace into the supported cross-project module-order composition. |
| `doctor` | Check the toolchain a run depends on: Node, the peer TypeScript, `@types/node`, the selected Z3 backend, the optional Quint peer, and the optional `java` command. |
| `spec <backend> <file.ts> [function]` | The specification IR, or the verifier program a backend consumes. `temporal --runtime web|node` is the public host-aware model combining user temporal annotations with supported JavaScript async observations. `ir`, `lint`, `z3`, `quint`, and `compose` expose the other specification projections. |
| `instrument <file.ts>` | The source with runtime assertions inserted for contracts or ownership. |
| `evidence <file.ts>` | The machine-readable effect evidence artifact plus a separate proof-eligibility assessment, as JSON. |
| `module-order <entry.ts>` | The source-mapped ESM initialization partial-order artifact; `--require` rejects non-proof-grade extraction. |
| `resource-model <file.ts>` | The Quint resource-safety model. |
| `async-model <file.ts> <function>` | The unified Quint model of Promise, exception, and resource flow. |

`check` takes `--infer` (only check functions that already declare effects),
`--strict` (unknown effect, typed-array, or ownership evidence is an error, not a warning),
`--project <tsconfig.json>` (use consumer compiler options and, when no files
are listed, its `include`/`files` roots; report exact TypeScript package/version
parity),
`--corsa-parity` (run the admitted Corsa `Fetch`/`Console` sidecar against the
same project and make a frontend mismatch an assurance `unknown` blocker),
`--corsa-executable <tsgo>` (override Uneffect's fixed prebuilt compiler; valid
only with `--corsa-parity`),
`--module-entry <entry.ts>` (with project-only checking, emit the supported
`uneffect-workspace-module-order/v1` composition and fail closed when its exact
cross-project TLA shape cannot be established),
`--declaration-transforms <manifest.json>` (with project-only checking, bind
generated TypeScript files to exact UTF-16 spans in non-TypeScript sources),
`--assurance no-unknown|declared|verified` (fail when emitted evidence does not
meet the selected CI profile; `verified` also requires an empty collected
assumption ledger), and
`--evidence` (also print the proved obligations and the inferred effect of every
function), and `--json` (write one `uneffect-check/v1` decision report to stdout
and suppress the text report). JSON always contains normalized diagnostics,
effect summaries, contract artifacts, typed-array obligations/window
provenance, ownership diagnostics, async-iterator resource scenarios, the assumption ledger, and the optional assurance assessment;
therefore it remains useful on exit 1 and does not require `--evidence`. Its
schema is published as `schemas/uneffect-check-v1.schema.json`. Both `check` and `evidence` accept
`--config <uneffect.registry.json>` for a versioned caller-owned semantic
registry. `check` also accepts `--assumptions <assumptions.json>` for the
versioned caller-owned review records referenced by source trust IDs.
`--contract-summary <uneffect-contract.json>` binds a producer-verified scalar
package contract to the exact installed package version and
TypeChecker-resolved declaration; repeat it for multiple packages. Digest,
version, compiler, and signature drift fail closed.
`contract-summary` publishes that envelope directly from a package project:

```sh
npx uneffect contract-summary \
  --project tsconfig.build.json \
  --entry src/index.ts \
  --package-name @example/library \
  --package-version 1.2.3 \
  --module-specifier @example/library/node \
  --typescript-emit-root . \
  --out uneffect-contract.json
```

Build first. With `--typescript-emit-root`, the command re-emits the selected
Program in memory, requires every emitted `.js` and `.d.ts` under that package
root to match disk, and records all output digests. Use repeatable
`--runtime-artifact package/path=file` only for additional reviewed files that
are not plain TypeScript output. `--config` and repeatable `--semantics-module`
use the same trusted registry inputs as `check`.
Omit `--module-specifier` for the package root. When present it must be that
package's own static subpath and becomes part of the TypeChecker binding key.
`--entry` may be a barrel containing static relative re-exports. The command
verifies Hoare artifacts for every selected project source and records each
resolved implementation source digest; it does not follow re-exports into an
external package.
`--resource-contract <resource.json>` binds one reviewed resource lifecycle
artifact to the exact installed package/Node version and declaration bytes;
repeat it for multiple exports. Accepted contracts remain trusted assumptions,
are rebound by TypeChecker symbol identity, and appear in the JSON assumption
ledger. Invalid schema, digest, version, declaration, or expired-review evidence
fails the check.
`instrument` takes `--ownership`, `--verify-ownership`, and
`--ownership-evidence <cache.json>`. `spec lint` takes the strengthening and
synthesis options listed by its own `--help`.

The only host-aware async backend is `spec temporal --runtime web|node`.
The removed `async-quint`, `promise-quint`, `web-loop-quint`, and
`node-loop-quint` names are rejected. Corresponding low-level TypeScript
generators remain available only from `@mizchi/uneffect/experimental`; the
stable root exports `generateTemporalModel`.

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
The `asyncIterators` array (retained as the v1 field name) records each selected
synchronous or asynchronous iterator resource's `protocol`, coverage fragment,
alternative scenarios, aggregate `satisfied | unsatisfied |
unknown` status, and `exact | trusted | unknown` evidence. Unclosed iterators
are errors; incomplete control/alias coverage is a warning in gradual mode and
an error in strict mode. A used trusted callable boundary is also recorded as a
`resource-callable` assumption, so verified assurance cannot silently accept it.
The separate `resourceProtocols` array records general user-defined
`acquire`/`use`/`release` composition. Each entry names the owning function,
resource kind and final state, observed transition kinds, aggregate status, and
evidence level. An unclosed lifecycle or invalid transition is an error. Source
annotations are trusted contracts, so their use is also present in the
assumption ledger; the CLI does not present declaration trust as implementation
proof.
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
and the same declaration integrity evidence. One call may pass through at most
two TypeChecker-resolved, write-screened local function helpers whose bodies are
exactly the next call, with the bounded path emitted as `callPath`, the limit as
`helperDepthBudget: 2`, and any child guard retained. A third,
reassigned/cyclic helper, helper-local guard or extra work,
guarded wrappers with additional work, collection-valued updates, and
unconfigured or non-identity declaration transforms are not composed. A
configured `embedded-typescript/v1` mapping may compose only when the complete
source/output SHA-256 digests, exact TypeScript compiler version, and selected
UTF-16 source span all match. Its `declarationIntegrity.transform` evidence
records the transform name/version and exact files/span. Multiple transformed
inputs contributing to one declaration fail closed. This proves only that the
generated `.ts` text is an exact embedded source span; surrounding host-language
and runtime semantics are not checked. The strict manifest schema is published
as `schemas/uneffect-declaration-transforms-v1.schema.json`. Other proof domains
are not composed.

An opt-in `runtime adapter@version = globalThis` refinement annotation permits
the same TypeChecker-resolved builtin global object to cross the scalar link.
The JSON link records `runtimeIdentity` with
`ecmascript:realm.globalThis`. Node adapters may instead use
`runtime adapter@version = node:global@24#main`; the link records the Node
major and realm label and accepts only the ambient `global` from the matching
`@types/node` major. Host aliases, shadowed bindings, descendant properties,
unannotated adapters, mismatched realm labels, and mismatched majors remain
uncomposed. A realm label is a user contract, not discovered deployment proof.

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
npx uneffect check --assumptions uneffect.assumptions.json src/main.ts
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

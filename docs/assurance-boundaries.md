# Assurance boundaries

Uneffect is a gradual checker, not a proof of arbitrary TypeScript. A successful
default `check` means that the enabled analyses emitted no error diagnostic. It
does not mean that every operation, control-flow path, host behavior, or
unannotated semantic domain was modeled.

This page defines the line a project may rely on without turning missing
coverage into false confidence.

## Current adoption classification

| Use | Current recommendation | Required interpretation |
| --- | --- | --- |
| Local exploration and review | Recommended | Diagnostics, inferred inventories, generated models, and counterexamples are decision support. |
| CI on a selected boundary | Recommended with a ratchet | Pin the file set and configuration, choose an assurance profile, retain artifacts, and reject `unknown` for claims that matter. |
| Production runtime validation | Supplement only | Keep validation at untrusted boundaries; optional generated assertions do not make the static checker a runtime sandbox. |
| Security or authorization boundary | Not sufficient alone | Host behavior, native code, reflection, dynamic loading, and registry trust remain outside general proof coverage. |
| Proof-guided transformation | Prototype-only | Apply only a transformation with its own verified authorization artifact; general compression, mangling, reordering, and DCE are not authorized. |
| Whole-program correctness claim | Unsupported | No profile quantifies over all JavaScript behavior or all semantic domains. |

This classification is deliberately asymmetric: a concrete diagnostic or
counterexample can falsify a claim even when the analyzer is incomplete, while
a passing result supports only the explicitly emitted claim. Absence of a
diagnostic is never promoted into an unstated guarantee.

## Check profiles

```sh
uneffect check src/file.ts
uneffect check --assurance no-unknown src/file.ts
uneffect check --assurance declared src/file.ts
uneffect check --assurance verified src/file.ts
```

| Mode | Exit 0 establishes | It does not establish |
| --- | --- | --- |
| default gradual check | No enabled checker emitted an error. Warnings and unknown effect summaries may remain. | Completeness, purity, or whole-program safety. |
| `--assurance no-unknown` | The explicitly checked files have no opaque `unknown` effect summary, no capability argument contains an unresolved `Unknown<reason>` set, and every emitted contract artifact is verified. Inferred inventories, explicitly represented iterator-effect parameters, and reviewed `trusted` boundaries are accepted. A passing result is `assumed`, not `verified`, when any summary is trusted. | That inferred effects are declaration-checked, that trusted contracts prove their implementations, that an unbounded iterator-effect parameter has a closed concrete effect set, or that an analysis was enabled for every semantic domain. |
| `--assurance declared` | In addition, every emitted function effect summary is checked against explicit body-effect declarations and/or complete iterator-effect parameter bounds. | An assumption-free proof. Builtin contracts are trusted inputs, and absent annotations create no React, temporal, or Hoare claim. |
| `--assurance verified` | Applies the `declared` checks and requires the assumption ledger collected for the exact check boundary to be present and empty. A reviewed builtin or module-initialization contract therefore blocks this profile even when its effect declaration is correct. | Semantics that were not opted into or emitted, arbitrary dependency implementations, compiler correctness, or an unbounded proof from bounded solver evidence. |

All assurance profiles print their scope and every blocker. They are intended
for CI on a deliberately selected file boundary. They do not silently broaden
that boundary to dependencies, dynamically loaded code, native addons, or host
behavior not represented by the builtin contract registry.

An explicit pure function boundary is written as
`/* uneffect: effect none */`. It creates a checked empty upper bound; an
unannotated function with an empty inferred inventory does not. Use
`module_effect none` when module initialization must also be constrained to an
empty set. Neither declaration proves termination, allocation freedom, or the
absence of semantic domains that were not enabled.

Both profiles also require every selected source to be free of TypeScript
syntax, semantic, and compiler-option errors. A source with an error receives
`unknown` function and module evidence, even when the effect analyzer could
still walk its recovered AST. The default gradual check reports the same
TypeScript errors and exits non-zero; Uneffect never upgrades an ill-typed
source to proof-grade evidence.

The same fail-closed rule applies to Uneffect comment syntax. Unknown
directives, missing payloads, and malformed Effect sets are error diagnostics;
all function and module Effect summaries in that source become `unknown`.

Use `--project <tsconfig.json>` when checking consumer code. Otherwise the CLI
uses Uneffect's analysis defaults, which need not match the consumer's module,
library, strictness, JSX, or path-resolution semantics. The project file binds
compiler options and its selected root files. Uneffect resolves the consumer
TypeScript package and module from that project boundary, then compares its
exact version with the analyzer module. The machine report classifies parity as
`exact`, `mismatch`, or `unknown`; both assurance profiles reject the latter
two. Package metadata remains part of the trusted installation base, not a
cryptographic attestation of compiler bytes.

For a solution-style project, `check --project` follows project references and
checks every source-bearing config as a separate TypeScript Program with its
own compiler options, references, root files, and compiler provenance. It does
not flatten the solution into a guessed common configuration. Missing or
malformed references, cycles, empty leaf projects, duplicate root-file
ownership, child assurance failures, and non-exact compiler provenance are
workspace blockers. The resulting `uneffect-workspace-check/v1` decision lists
the graph, child-first build order, per-config roots, child decisions, and the
aggregate assurance result.

A passing CLI workspace result establishes only that every listed domain passed
the selected profile relative to the recorded assumptions and that root-source
ownership was unambiguous. It is not a cross-project whole-program proof:
only uniquely resolved `verified` function/module Effect summaries and the
documented direct scalar refinement fragment are composed by the CLI, while
cross-project invariants, contracts, ownership, and temporal evidence are not;
build-artifact freshness is not load-bearing unless explicitly required,
declaration contents are not independently attested, and runtime package resolution
outside the selected Programs remains excluded. A graph with a cycle has no
usable build-order claim even though its discovered nodes remain reportable.

The programmatic `verifyUneffectProject` boundary applies the same rule across
domains: contract and typed-array obligations become `unknown`, and temporal
properties become `error` without running their backend. The API can still
return diagnostics, models, and emitted JavaScript for gradual adoption; those
outputs are not proof evidence. `verifyUneffectProject({ files })` deliberately
uses Uneffect defaults and therefore does not establish consumer tsconfig or
compiler parity.

`verifyUneffectProject({ projectFile })` instead loads the solution graph and
runs the verifier bundle once per source-bearing config under that config's
compiler options, native references, root selection, and compiler provenance.
It returns `uneffect-project-workspace/v1`; graph blockers, compiler drift, and
every child assurance blocker feed one fail-closed workspace assessment. The
programmatic verifier composes a deliberately narrow cross-project interface:
a uniquely resolved function call or runtime import may consume a child summary only when that
summary is `verified`. The machine-readable `effectComposition` ledger records
each link. Its status is `not-applicable` when no link was accepted or blocked,
`verified` only when at least one link was accepted, and `unknown` when a
candidate was blocked. A function `Mutate` rooted at a declared parameter is substituted at
the call site when the corresponding argument is an identifier, `this`, a
property chain, or a string-literal element chain. Missing/spread arguments and
fresh or computed expressions remain unknown rather than inventing an alias.
Inferred, trusted, unknown, or ambiguous summaries, non-exported or parent-inaccessible
mutation regions, host/realm-specific ambient roots other than explicitly modeled
same-realm `globalThis` and versioned/labeled Node `global`, unbounded iterator parameters, and opaque iterator
arguments remain blockers. Exported
function-closure and module-initialization roots use a project/source/export
identity and are substituted only through a parent named or namespace import
whose TypeChecker declaration identity matches, including across re-export chains;
same-spelled symbols are a negative case.
`globalThis` uses `ecmascript:realm.globalThis`; it does not equate browser
`window`, Node `process`, Workers, iframes, or other realms. Node `global` is
admitted only through `node:global@<major>#<realm>`, a matching `@types/node`
major, and an exact realm label on both sides.
A verified child iterator consumer whose every parameter has an
`effect_parameter` bound is instantiated through resolved generator
factories, supported stored iterators, forwarded iterator parameters, and
standard pure iterators. Its bound is checked in the parent Program, including
the declared Promise-consumer `Throw`-to-rejection behavior.

The separate `refinementComposition` ledger admits one additional fragment: a
scalar child action whose local implementation and create/observe projection
verify against its model, called directly from an annotated parent action with
the same adapter version. An unguarded action may appear as a direct call. A
guarded action is admitted only when the parent wrapper body is exactly that
call; the verified child guard is inherited, checked against the parent model,
and serialized on the link. The parent action is revalidated after substituting
the child action summary. Every link retains producer and consumer
compiler/config provenance and exact declaration integrity. A stale or modified
declaration, ambiguous export, adapter/version or guard mismatch, invalid child
guard, extra wrapper work, or semantically incompatible parent model prevents
`verified` composition. One edge may pass through at most two
TypeChecker-resolved, write-screened source-local function helpers whose bodies
are exactly the next call; the link records its full `callPath`, explicit
`helperDepthBudget: 2`, and retained child guard. Helper-local guards, extra or
conditional helper work, higher-order values, reassigned/cyclic helpers, a
third helper level, collection updates, abstraction transforms, and
unconfigured or non-identity declaration transforms remain unsupported. The
sole non-TypeScript exception is the configured `embedded-typescript/v1`
profile: it checks that one generated `.ts` file exactly equals a UTF-16 source
span and binds source/output digests, transform name/version, and compiler
version. It does not prove surrounding host syntax, templates, runtime lowering,
or general transform equivalence.

An exact `runtime adapter@version = globalThis` annotation may bind both sides
of a refinement link to the ECMAScript global object in the current Realm. The
adapter/version must match and the argument must resolve to the builtin
`globalThis` symbol. The link records `ecmascript:realm.globalThis`. Missing or
duplicate annotations, locally shadowed names, properties below `globalThis`,
`window`, unannotated Node `global`, Worker/iframe values, and cross-realm flows remain
non-proofs.

Node adapters may instead declare, for example,
`runtime adapter@version = node:global@24#main`. The argument must resolve to
the ambient `global` declaration from `@types/node` major 24, and producer and
consumer identities must match byte-for-byte, including `#main`. A local
shadow, `#worker`, or another typings major fails closed. The realm label is an
explicit deployment contract; Uneffect does not observe processes or Workers
and therefore does not prove that the label describes actual topology.

Success still excludes cross-project invariants, contracts, ownership, and
temporal composition. Every `.d.ts` consumed by an Effect or refinement link
must exactly match a same-compiler in-memory declaration re-emission; missing or
different bytes block the link even when SolutionBuilder says `fresh`. SolutionBuilder
freshness is always reported and can be made load-bearing with
`--require-build-artifacts` or `buildArtifacts: "require-fresh"`; without that
opt-in it remains an exclusion. Even `fresh` establishes TypeScript's
timestamp/buildinfo/config/version judgment. The separate Effect-link integrity
ledger records expected and actual SHA-256 digests. It trusts the exact selected
TypeScript compiler and is not an independently checkable compiler proof.
When deployed code is the JavaScript emitted by the checked TypeScript projects,
`--require-exact-build-artifacts` or `buildArtifacts: "require-exact"` adds a
second ledger for all emitted runtime and declaration bytes. It also requires
SolutionBuilder freshness. A project using `noEmit`, `emitDeclarationOnly`, a
bundler, or a post-emit transform fails this stronger gate because Uneffect has
not established the mapping to deployed code.

`verifyUneffectProject(...).assurance` is the corresponding cross-domain gate.
It rejects unknown effect summaries, nested unknown capability scopes,
non-verified contract obligations,
unknown/counterexample typed-array obligations, ownership and instrumentation
diagnostics, assumption-policy violations, non-verified attributed temporal
properties, and empty/uncovered input. A verified leaf never overrides an
unknown sibling. Trusted typed-array obligations may pass, but are counted and
remain listed as an exclusion rather than being described as proved.

The project gate exposes a four-state result instead of collapsing every
outcome into a green or red boolean:

| `status` | Meaning | `passed` |
| --- | --- | --- |
| `verified` | All emitted obligations passed and the assumption ledger is empty. This remains scoped to `claims` and `exclusions`. | `true` |
| `assumed` | All emitted obligations and the configured assumption policy passed, but one or more trusted builtin contracts, module-initialization contracts, temporal summaries, dispatch seals, or escape hatches are recorded. | `true` |
| `unknown` | Coverage, resolution, instrumentation, lowering, or a solver result was insufficient to establish the claim. | `false` |
| `violated` | At least one concrete type/effect/policy/ownership violation or solver counterexample was found. This takes precedence if other evidence is also unknown. | `false` |

Every blocker carries `classification: "unknown" | "violation"`, and
`assurance.assumptions` gives the number of ledger entries. The legacy
`passed` field deliberately accepts policy-compliant assumptions; CI requiring
assumption-free evidence must check `status === "verified"`. A project should
normally begin by allowing owned `assumed` results, then ratchet the ledger
rather than relabeling assumptions as proofs.

The public assurance assessments also expose `claims`, `exclusions`, and
`coverage` as machine-readable fields. Coverage records the selected-file,
effect-summary, and contract-artifact counts plus every selected file that
emitted neither proof-relevant artifact. An assurance profile fails when the
whole result is empty or when any selected file is uncovered, so evidence from
one file cannot hide a type-only, misspelled, or otherwise unexamined sibling.
Claims are established only when `passed` is true; an `assumed` result
establishes those claims relative to its explicit assumption ledger. On
failure the machine-readable `claims` array is empty and the blockers explain
what prevented the claim. Exclusions are
reported even for a passing assessment and must not be removed or interpreted
as warnings that can be waived. This keeps CI integrations from reducing an
assurance result to a context-free green boolean.

## Evidence vocabulary

- `verified`: the exact emitted obligation passed its checker, or an explicit
  effect upper bound covered the effects found in the supported call graph.
- `inferred`: Uneffect computed a useful effect inventory, but no explicit
  upper-bound declaration was checked. A summary with
  `iteratorEffectParameters` is effect-polymorphic: the field is a represented
  call-site obligation, not evidence that the empty concrete inventory is pure.
- `trusted`: the result depends on a reviewed external or builtin semantic
  contract or an explicit user-owned boundary such as dispatch sealing. Trusted
  evidence is auditable input, not a derived proof.
- `unknown`: resolution, control flow, solver behavior, or language coverage
  was insufficient. Unknown evidence must not authorize optimization or a
  safety claim.

`verified` is always local to its artifact and assumptions. It is not a synonym
for “this function is correct.”

## Reliance matrix

| Area | Safe reliance line | Outside the current claim |
| --- | --- | --- |
| Capability effects | Explicit declarations checked with `--assurance declared`, over symbol-resolved calls and reviewed builtin contracts. | Reflection, arbitrary dynamic dispatch, unresolved callbacks, native addons, and unreviewed host APIs. |
| Generator effects | Direct iterator consumers expose `iteratorEffectParameters`; `effect_parameter iterator extends ...` bounds lazy effects. Symbol-resolved wrappers forward constraints and resolved call sites check generator-body effects, pure standard iterators, or `unknown`. | Forwarding through arbitrary dynamic dispatch, escaped iterators, dynamic properties, and an opaque iterator argument. Normal `effect` declarations bound the function body, not its iterator parameter. |
| Hoare contracts | Individual emitted obligations whose artifact status is `verified`. `uneffect-refinement-action-analysis/v1` binds source digest, TypeScript version, and loop/try spans, then verifies one direct ranking-loop normal/typed-throw catch join only when its named CFG worklist converges, retains the normalized payload, and creates the condition-correlated predecessor phi environment with no affine action diagnostic. | Termination in general, arbitrary heap aliasing, general recurrence fixed points, arbitrary AST-to-basic-block lowering, irreducible loops, Program/external-action support for the first CFG artifact, and unsupported expressions. |
| Async/resource safety | The diagnostics and models for the exact patterns listed in the feature matrix, with negative regression coverage. | A complete exception-aware JavaScript CFG or proof that every rejection/resource escape is detected. |
| React function components | Explicit `react component`/`react hook` boundaries and the documented phase/callback fragment. | Unannotated components, dynamic HOCs/Hooks/callbacks, full React scheduling, Server Components, and runtime reachability. |
| Temporal logic | A generated artifact plus the reported backend result and bounds/fairness assumptions. | An unbounded proof when only simulation or bounded checking ran. |
| Property testing | Bugs found in generated cases and minimized counterexamples. | Proof of correctness from a passing finite sample. |
| Optimization | Only `verified` evidence whose exact transformation-specific authorization schema and dependency snapshot match. | `trusted` assumptions, general compression, mangling, reordering, or DCE. |
| Native frontend parity | `semanticEquivalent: true` establishes semantic agreement for the emitted neutral-IR fields. An in-process exporter result plus `requireCorsaCheckerFacts` establishes that supported top-level function declarations, single immutable arrow/function-expression bindings, identifier-named methods of top-level classes, named-function overload candidates/selections, type/trivia, and direct intra-project call facts came from full Corsa parser services, including cross-file and duplicate-spelling symbol identity. Overload metadata is compared separately because the normalized effect projection intentionally omits it. | Computed or polymorphically dispatched methods, nested callbacks/timing, method/generic overload edge cases, Promise/resource facts, and other neutral-IR domains are not checker-exported. Explicitly annotated computed methods make the comparison fail coverage even when both semantic projections are empty. Calls inside unsupported nested functions are omitted rather than presented as immediate calls, which makes parity fail when the reference frontend emits such an edge. Cloned/persisted facts are unauthenticated, and there is no signed evidence format or whole-program Corsa parity. |
| ESM initialization order | A `uneffect-module-order/v1` artifact with `evidence: "verified"`, for its represented acyclic local graph or synchronous side-effect-import simple ring. A `uneffect-workspace-module-order/v1` artifact additionally composes one direct exact child declaration/source with one straight-line TLA into one synchronous importer. Every accepted edge retains source/declaration/compiler evidence and semantic rule. | Runtime-binding, self, branching, multi-edge, or asynchronous cycles; sibling initiation during suspension; conditional/looping TLA; await-then-throw; multiple/transitive project dependencies; transformed declarations; decorators/classes; dynamic/external bodies; deployment scheduling; or proof that normal completion occurs. |

The detailed tested fragments and open boundaries live in the
[feature matrix](./feature-matrix.md). If a construct is not listed there, do
not infer support from a nearby example.

## Recommended adoption line

1. Start with default `check` on an explicit file list and review diagnostics.
2. Add `--evidence`; inspect `inferred`, `trusted`, and `unknown` separately.
   Each unknown Effect summary has a non-empty `unknownReasons` array; use its
   stable codes to decide whether the missing boundary is callback timing,
   generator flow, external/module evidence, TypeScript validity, or an effect
   diagnostic.
3. Gate the selected boundary with `--assurance no-unknown`.
4. Add explicit effect upper bounds and move that boundary to
   `--assurance declared`.
5. Use `--assurance verified` only where the collected ledger is empty.
6. Treat every escape hatch and trusted builtin as an owned assumption.
7. Expand the checked boundary only after its unknown rate and false positives
   are understood.

Never replace an unknown with a broad declaration merely to make CI green. A
broad effect may describe authority, but it cannot repair unresolved control
flow or turn an unmodeled API into verified semantics.

Every checked TypeScript source now emits a source-attributed `<module>`
may-effect summary. It includes direct operations, TypeChecker-resolved
function/overload calls, known inline callback effects, immutable local and
imported function identifiers passed to known callback owners, and the
transitive static-local-import closure. Imported live bindings are accepted
only when the exporting function symbol has no detected assignment; mutable,
dynamically selected, and unresolved callbacks remain `unknown`. Cycles use a
monotone effect-set fixed point; unresolved calls and dynamic imports remain
`unknown`. Executable namespace bodies and class heritage, computed member
names, stable decorators, static initializers, and static blocks contribute
may-effects. Decorator factories whose returned callable cannot be identified
remain `unknown`. A string-literal relative dynamic import that TypeScript resolves to a
non-declaration source in the current Program contributes that module's closure
as a conditional may-effect, including when directly awaited. Computed,
external, declaration-only, and unresolved dynamic imports remain `unknown`.
Static runtime imports of external packages also fail closed unless the
versioned builtin registry contains a reviewed module-initialization contract
whose exact resolved package version or Node runtime major matches.
Such a contract contributes its declared may-effects but makes the importing
module and its local importers `trusted`, never `verified`; project verification
records the import in the assumption ledger. Type-only imports do not execute
module initialization and therefore do not require this assumption.
Programmatic callers may inject an extended builtin registry, but this does not
upgrade its contracts to proof: matching external initialization remains
`trusted`, is recorded in the same ledger, and produces `assumed` at best. An
exact contract with a mismatched package version or Node major shadows broader
wildcards and fails closed as `unknown`. `check --config` and
`evidence --config` use the same strict versioned registry loader. Caller-owned
contracts remain assumptions and their merged-registry digest is bound into
persisted effect evidence.
This establishes an
authority upper set, not exact ESM evaluation order or top-level-await temporal
ordering. Uneffect's dogfood includes all 64 `src/*.ts` files, including the
CLI entrypoint, while printing that temporal exclusion.

ESM order is a separate opt-in domain. `uneffect module-order --require
<entry>` and `verifyUneffectProject({ moduleInitializationEntry })` accept only
the documented acyclic partial-order fragment. Unknown cycles,
conditional top-level await/throw, class/decorator initialization,
external/dynamic bodies, and TypeScript errors block that domain without
changing what an ordinary capability-effect check claims. A normal `complete`
event is conditional on normal evaluation; it does not prove arbitrary
JavaScript expressions cannot throw.

A type-only or otherwise evidence-free file intentionally cannot pass an
assurance profile by itself. Keep it outside the asserted runtime boundary, or
add a proof-relevant annotated function/contract that states what the boundary
is meant to establish. Do not add a dummy annotation only to satisfy coverage.

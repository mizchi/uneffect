# Assurance boundaries

Uneffect is a gradual checker, not a proof of arbitrary TypeScript. A successful
default `check` means that the enabled analyses emitted no error diagnostic. It
does not mean that every operation, control-flow path, host behavior, or
unannotated semantic domain was modeled.

This page defines the line a project may rely on without turning missing
coverage into false confidence.

## Check profiles

```sh
uneffect check src/file.ts
uneffect check --assurance no-unknown src/file.ts
uneffect check --assurance declared src/file.ts
```

| Mode | Exit 0 establishes | It does not establish |
| --- | --- | --- |
| default gradual check | No enabled checker emitted an error. Warnings and unknown effect summaries may remain. | Completeness, purity, or whole-program safety. |
| `--assurance no-unknown` | The explicitly checked files have no opaque `unknown` effect summary and every emitted contract artifact is verified. Inferred inventories and explicitly represented iterator-effect parameters are accepted. | That inferred effects are declaration-checked, that an unbounded iterator-effect parameter has a closed concrete effect set, or that an analysis was enabled for every semantic domain. |
| `--assurance declared` | In addition, every emitted function effect summary is checked against explicit body-effect declarations and/or complete iterator-effect parameter bounds. | An assumption-free proof. Builtin contracts are trusted inputs, and absent annotations create no React, temporal, or Hoare claim. |

Both assurance profiles print their scope and every blocker. They are intended
for CI on a deliberately selected file boundary. They do not silently broaden
that boundary to dependencies, dynamically loaded code, native addons, or host
behavior not represented by the builtin contract registry.

Both profiles also require every selected source to be free of TypeScript
syntax, semantic, and compiler-option errors. A source with an error receives
`unknown` function and module evidence, even when the effect analyzer could
still walk its recovered AST. The default gradual check reports the same
TypeScript errors and exits non-zero; Uneffect never upgrades an ill-typed
source to proof-grade evidence.

The programmatic `verifyUneffectProject` boundary applies the same rule across
domains: contract and typed-array obligations become `unknown`, and temporal
properties become `error` without running their backend. The API can still
return diagnostics, models, and emitted JavaScript for gradual adoption; those
outputs are not proof evidence.

`verifyUneffectProject(...).assurance` is the corresponding cross-domain gate.
It rejects unknown effect summaries, non-verified contract obligations,
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
| `assumed` | All emitted obligations and the configured assumption policy passed, but one or more trusted builtin contracts, temporal summaries, dispatch seals, or escape hatches are recorded. | `true` |
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
failure the CLI labels them `claim (not established)`. Exclusions are
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
| Hoare contracts | Individual emitted obligations whose artifact status is `verified`. | Termination, arbitrary heap aliasing, general loops, and unsupported expressions. |
| Async/resource safety | The diagnostics and models for the exact patterns listed in the feature matrix, with negative regression coverage. | A complete exception-aware JavaScript CFG or proof that every rejection/resource escape is detected. |
| React function components | Explicit `react component`/`react hook` boundaries and the documented phase/callback fragment. | Unannotated components, dynamic HOCs/Hooks/callbacks, full React scheduling, Server Components, and runtime reachability. |
| Temporal logic | A generated artifact plus the reported backend result and bounds/fairness assumptions. | An unbounded proof when only simulation or bounded checking ran. |
| Property testing | Bugs found in generated cases and minimized counterexamples. | Proof of correctness from a passing finite sample. |
| Optimization | Only `verified` evidence whose exact transformation-specific authorization schema and dependency snapshot match. | `trusted` assumptions, general compression, mangling, reordering, or DCE. |
| Native frontend parity | `semanticEquivalent: true` establishes semantic agreement for the emitted neutral-IR fields. An in-process exporter result plus `requireCorsaCheckerFacts` establishes that supported top-level function declarations, single immutable arrow/function-expression bindings, identifier-named methods of top-level classes, named-function overload candidates/selections, type/trivia, and direct intra-project call facts came from full Corsa parser services, including cross-file and duplicate-spelling symbol identity. Overload metadata is compared separately because the normalized effect projection intentionally omits it. | Computed or polymorphically dispatched methods, nested callbacks/timing, method/generic overload edge cases, Promise/resource facts, and other neutral-IR domains are not checker-exported. Explicitly annotated computed methods make the comparison fail coverage even when both semantic projections are empty. Calls inside unsupported nested functions are omitted rather than presented as immediate calls, which makes parity fail when the reference frontend emits such an edge. Cloned/persisted facts are unauthenticated, and there is no signed evidence format or whole-program Corsa parity. |

The detailed tested fragments and open boundaries live in the
[feature matrix](./feature-matrix.md). If a construct is not listed there, do
not infer support from a nearby example.

## Recommended adoption line

1. Start with default `check` on an explicit file list and review diagnostics.
2. Add `--evidence`; inspect `inferred`, `trusted`, and `unknown` separately.
3. Gate the selected boundary with `--assurance no-unknown`.
4. Add explicit effect upper bounds and move that boundary to
   `--assurance declared`.
5. Treat every escape hatch and trusted builtin as an owned assumption.
6. Expand the checked boundary only after its unknown rate and false positives
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
remain `unknown`. This establishes an
authority upper set, not exact ESM evaluation order or top-level-await temporal
ordering. Uneffect's dogfood includes all 59 `src/*.ts` files, including the
CLI entrypoint, while printing that temporal exclusion.

A type-only or otherwise evidence-free file intentionally cannot pass an
assurance profile by itself. Keep it outside the asserted runtime boundary, or
add a proof-relevant annotated function/contract that states what the boundary
is meant to establish. Do not add a dummy annotation only to satisfy coverage.

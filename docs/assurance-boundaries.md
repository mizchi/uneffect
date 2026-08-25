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
| `--assurance no-unknown` | The explicitly checked files have no `unknown` effect summary and every emitted contract artifact is verified. Inferred effect inventories are accepted. | That inferred effects are declaration-checked, or that an analysis was enabled for every semantic domain. |
| `--assurance declared` | In addition, every emitted function effect summary is checked against an explicit effect declaration. | An assumption-free proof. Builtin contracts are trusted inputs, and absent annotations create no React, temporal, or Hoare claim. |

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

The public `AssuranceAssessment` also exposes `claims`, `exclusions`, and
`coverage` as machine-readable fields. Coverage records the selected-file,
effect-summary, and contract-artifact counts plus every selected file that
emitted neither proof-relevant artifact. An assurance profile fails when the
whole result is empty or when any selected file is uncovered, so evidence from
one file cannot hide a type-only, misspelled, or otherwise unexamined sibling.
Claims are established only when `passed` is true;
on failure the CLI labels them `claim (not established)`. Exclusions are
reported even for a passing assessment and must not be removed or interpreted
as warnings that can be waived. This keeps CI integrations from reducing an
assurance result to a context-free green boolean.

## Evidence vocabulary

- `verified`: the exact emitted obligation passed its checker, or an explicit
  effect upper bound covered the effects found in the supported call graph.
- `inferred`: Uneffect computed a useful effect inventory, but no explicit
  upper-bound declaration was checked.
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
| Hoare contracts | Individual emitted obligations whose artifact status is `verified`. | Termination, arbitrary heap aliasing, general loops, and unsupported expressions. |
| Async/resource safety | The diagnostics and models for the exact patterns listed in the feature matrix, with negative regression coverage. | A complete exception-aware JavaScript CFG or proof that every rejection/resource escape is detected. |
| React function components | Explicit `react component`/`react hook` boundaries and the documented phase/callback fragment. | Unannotated components, dynamic HOCs/Hooks/callbacks, full React scheduling, Server Components, and runtime reachability. |
| Temporal logic | A generated artifact plus the reported backend result and bounds/fairness assumptions. | An unbounded proof when only simulation or bounded checking ran. |
| Property testing | Bugs found in generated cases and minimized counterexamples. | Proof of correctness from a passing finite sample. |
| Optimization | Only a transformation whose exact proof-grade authorization schema matches. | General compression, mangling, reordering, or DCE. |
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
function/overload calls, known inline callback effects, and the transitive
static-local-import closure. Cycles use a monotone effect-set fixed point;
unresolved calls and dynamic imports remain `unknown`. This establishes an
authority upper set, not exact ESM evaluation order or top-level-await temporal
ordering. Uneffect's dogfood includes all 59 `src/*.ts` files, including the
CLI entrypoint, while printing that temporal exclusion.

A type-only or otherwise evidence-free file intentionally cannot pass an
assurance profile by itself. Keep it outside the asserted runtime boundary, or
add a proof-relevant annotated function/contract that states what the boundary
is meant to establish. Do not add a dummy annotation only to satisfy coverage.

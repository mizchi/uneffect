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

## Evidence vocabulary

- `verified`: the exact emitted obligation passed its checker, or an explicit
  effect upper bound covered the effects found in the supported call graph.
- `inferred`: Uneffect computed a useful effect inventory, but no explicit
  upper-bound declaration was checked.
- `trusted`: the result depends on a reviewed external or builtin semantic
  contract. Trusted evidence is auditable input, not a derived proof.
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
| Native frontend parity | `semanticEquivalent: true` establishes semantic agreement for the emitted neutral-IR fields. An in-process exporter result plus `requireCorsaCheckerFacts` establishes that supported top-level function declarations, single immutable arrow/function-expression bindings, identifier-named methods of top-level classes, type/trivia, and direct intra-project call facts came from full Corsa parser services, including cross-file and duplicate-spelling symbol identity. | Computed or polymorphically dispatched methods, nested callbacks/timing, overloads, Promise/resource facts, and other neutral-IR domains are not checker-exported. Explicitly annotated computed methods make the comparison fail coverage even when both semantic projections are empty. Calls inside unsupported nested functions are omitted rather than presented as immediate calls, which makes parity fail when the reference frontend emits such an edge. Cloned/persisted facts are unauthenticated, and there is no signed evidence format or whole-program Corsa parity. |

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

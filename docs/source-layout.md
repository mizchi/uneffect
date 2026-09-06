# Source organization and API boundaries

The source tree is organized by responsibility. Directory membership does not
make a module public: package exports and the explicit facades under `api/`
define the supported surface. Internal modules import their owning modules,
not the API umbrellas.

| Directory | Responsibility |
| --- | --- |
| `cfg/` | Compiler-independent graph contracts, fixed-point scheduling, branch joins, and completion algebra. |
| `api/` | Curated public and compatibility facades; `all.ts` supports the legacy experimental inventory. |
| `cli/` | Command routing, streams, argument handling, and command-specific presentation. |
| `frontends/` | Shared syntax/semantic-query contracts and frontend comparison. |
| `frontends/typescript/` | TypeScript Programs, identity/coordinate handling, syntax traversal, and compiler CFG evidence. |
| `frontends/corsa/` | Corsa binding, project queries, fact export/validation, and checking facade implementation. |
| `effects/` | Effect algebra, builtin contracts, call summaries, capabilities, and baselines. |
| `contracts/` | Contract lowering, verification, summaries, runtime checks, and generated property tests. |
| `refinement/` | Domain-specific refinement bindings, bounded handler lowering, and recurrence obligations. |
| `async/` | Promise/host transitions, async patterns, and ownership observations. |
| `resources/` | Resource protocols, disposal identity, lifecycle artifacts, and temporal products. |
| `modules/` | Module initialization ordering and declarative extension loading. |
| `project/` | Whole-project checking, workspace composition, and assurance aggregation. |
| `evidence/` | Evidence/assumption contracts, replay, and runtime identity. |
| `optimizer/` | Evidence-backed transformations, instrumentation, and evidence caching. |
| `analysis/` | Specialized ownership, React, numeric/typed-array, and Trusted Types analyses. |
| `spec/` | Specification authoring entrypoint, IR, temporal domains, and model composition. |
| `runtime/` | Numeric and bounded-container authoring/runtime helpers. |
| `backends/` | External proof solver execution. |
| `support/` | Shared annotation parsing, diagnostics, environment inspection, and repository tooling. |

The existing domain graph still has cross-domain dependencies. This change
extracts one independently consumable core, `cfg/`; it does not claim that
all other directories are separately deployable packages.

## Published API

- `@mizchi/uneffect` maps to `api/public.ts`. It explicitly re-exports the same
  public functions and types from their owning modules, without going through
  `api/all.ts`. Existing root, Corsa, Corsa API, and spec declaration snapshots
  are unchanged.
- `@mizchi/uneffect/cfg` maps to `cfg/index.ts`. It has an explicit export list
  and no dependencies on other directories, Node builtins, compiler packages,
  effect semantics, or solver packages. See [CFG API](./cfg.md).
- `/corsa`, `/corsa/api`, and `/spec` keep their previous package import paths.
- `/experimental` retains the previous research inventory for compatibility.
  Its existing CFG exports point to the same implementations as `/cfg`.
- Private `src`/`dist` paths are not package exports. Moving a private source
  file does not require another public wrapper for its old filename.

## Dependency rules

Keep compiler-specific extraction outside `cfg/`. Supply abstract values,
edge labels, joins, and transfer functions through the contracts. Keep
Uneffect domain postconditions in the consuming analyzer: convergence alone
cannot establish a domain proof.

Do not import a public/experimental facade from its implementation. Public
facades are the outer boundary, not shared utility modules. Adding an API
requires an explicit export, declaration review, and installed-package probe.

The CFG contract tests enforce its import boundary. Package checks lock the
public inventory, test a consumer-defined domain with compiler peers absent,
and reject any CFG import outside its installed directory. Self-dogfood
collects `src/**/*.ts`, so new responsibility directories are analyzed too.

The source-tree dogfood inventory also retains the pre-existing unknown module
effects of Corsa schema construction and their five importing modules. This
was reproduced on pre-refactor commit `2928529`; directory extraction does not
turn unknown dependency effects into pure imports.

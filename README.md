# uneffect

Uneffect is a feasibility prototype for adding gradual effect specifications,
Hoare-style contracts, and temporal models to existing TypeScript without
rewriting the program around an effect runtime.

Specifications live in ordinary block comments. They do not change TypeScript
syntax or emitted JavaScript.

```ts
/* uneffect: effect Console */
export function log(value: number): void {
  console.log(value)
}

/* uneffect: requires n >= 0 */
/* uneffect: ensures result === n */
export function count(n: number): number {
  let value = 0
  /* uneffect: invariant value >= 0 && value <= n */
  while (value < n) value = value + 1
  return value
}
```

An effect declaration such as
`/* uneffect: effect Console | Fetch */` is an upper bound. Missing transitive
effects are errors; declared but unused effects are warnings. A function may
use fewer effects than its declaration. No `yield`, wrapper function, or
runtime handler is required.

Executable file initialization uses a separate header bound such as
`/* uneffect: module_effect Console | FsRead */`. Its `<module>` evidence is a
may-effect set; exact ESM and top-level-await ordering are not yet proved.

A `Mutate` region names the member path a write touches, so `state.calls = 1`
infers `Mutate<typeof state.calls>`. Containment is prefix-based: declaring
`Mutate<typeof state>` covers every member below it, while declaring a sibling
property does not.

## Status

This package is an alpha-stage research prototype, not a verifier for all of
JavaScript. It has executable coverage for selected fragments of:

- capability effects, including Deno-shaped filesystem, network, environment,
  process, FFI, and system scopes;
- `Console`, `Fetch`, DOM operations, mutation regions, typed `Throw`, and
  user-defined effects;
- integer contracts, loop invariants, bounded machine-number and typed-array
  checks, and optional runtime assertions;
- Promise ownership, timers, event-loop ordering, explicit resource management,
  and selected Promise combinators;
- temporal specifications lowered to a neutral IR, Z3, and Quint;
- refinement bindings between temporal actions and restricted TypeScript
  implementation bodies.

Dynamic dispatch, unknown aliases, Proxy/Reflection, a general exception-aware
CFG, full host event loops, termination, and the SharedArrayBuffer memory model
are not proved. Unsupported constructs produce `unknown` or a diagnostic; they
are not silently accepted. Z3 and Quint results are reproducible evidence, not
independently checkable proof certificates.

See [Implementation status](./docs/implementation-status.md) and the
[feature matrix](./docs/feature-matrix.md) before relying on a specific proof.

### Safe usage line

Uneffect is currently appropriate as an additional, fail-closed review and CI
layer on an explicitly selected TypeScript boundary. It is safe to rely on a
reported diagnostic or counterexample as evidence of a problem, and on a
`verified` artifact only for the exact claim, source snapshot, configuration,
supported syntax fragment, and backend recorded by that artifact.

Do not currently use Uneffect as the sole security boundary, as a replacement
for TypeScript or runtime validation at untrusted inputs, as a whole-program
correctness claim, or as authorization for general code reordering and
optimization. A default exit 0 is lint success, not proof. An `assumed` result
is conditional on its visible trust ledger. An `unknown` result establishes
nothing and must stay blocking wherever assurance is required.

The normative interpretation of every result state and the per-domain reliance
line are documented in [Assurance boundaries](./docs/assurance-boundaries.md).

## Quickstart

Uneffect requires Node.js 24 or newer and uses the consuming project's
TypeScript installation.

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect doctor
npx uneffect check src/example.ts
```

`check` reports effect, contract, and async-safety diagnostics. Exit 0 means no
enabled checker found an error; it is not a whole-program proof and may retain
explicit unknown evidence. CI can opt into `--assurance no-unknown` or the
stronger effect-declaration gate `--assurance declared`. The command exits with
1 when the selected checks or assurance profile fail, and 2 for invalid CLI
usage. TypeScript syntax, semantic, and compiler-option errors are fatal, and
summaries from an ill-typed source remain `unknown`. Assurance also fails when no proof-relevant evidence is emitted for any
explicitly selected file; a green result cannot be borrowed from a covered
sibling file. See [Assurance boundaries](./docs/assurance-boundaries.md) before relying
on a successful check as evidence.

Use `check --json` when CI needs a stable `uneffect-check/v1` report rather
than human-readable diagnostics. The report is emitted on both success and
failure and keeps `outcome`, evidence, assurance blockers, claims, exclusions,
and coverage together; omitting `--assurance` produces `assurance: null`.
With `--project`, it also records analyzer/consumer TypeScript package
provenance, and assurance rejects unresolved or non-exact compiler versions.
For a solution-style root with no positional files, referenced configs are
checked as separate compiler domains and the command emits
`uneffect-workspace-check/v1`. Graph errors and ambiguous source ownership fail
closed. The CLI composes the same narrow, verified function and module Effect interface as
the project API and records it in `effectComposition`; it does not compose the
other proof domains or validate build artifact contents.

The programmatic overload `verifyUneffectProject({ projectFile })` applies the
same graph separation to the effect, contract, typed-array, ownership,
assumption, and optional temporal verifier bundle. It returns
`uneffect-project-workspace/v1` with every child result and one aggregate
assurance decision. Cross-project evidence composition and declaration-output
validation remain explicit exclusions except for verified function and module
Effect summaries. Those summaries are composed child-first at resolved call sites/imports and
reported in `effectComposition`. Ambiguous matches, inferred/trusted/unknown
child evidence, `Mutate` region substitution, module mutation regions, and iterator Effect parameters
fail closed as `effect-composition` blockers.
Use `--require-build-artifacts` in the CLI or
`buildArtifacts: "require-fresh"` in the project API when TypeScript composite
output freshness is part of the boundary. This is SolutionBuilder evidence,
not an independent output-content proof.

The project API reports `assurance.status` as `verified`, `assumed`, `unknown`,
or `violated`. `passed` remains a compatibility convenience and is true for
both `verified` and policy-accepted `assumed` results. Consumers that must reject
trusted builtins or escape hatches should gate on `status === "verified"`, not
only on `passed`.

For a copyable project setup, a passing example, intentional failure cases,
runtime instrumentation, and Quint generation, read the
[Quickstart guide](./docs/quickstart.md).

## Gradual adoption

Existing projects do not need to annotate everything at once. A typical rollout
is:

1. Run `uneffect check --infer` on selected files to establish a baseline.
2. Annotate leaf functions and external I/O boundaries with effect upper bounds.
3. Narrow broad filesystem and network effects to Deno-compatible scope sets.
4. Add `requires`, `ensures`, and invariants around high-value data boundaries.
5. Enable async ownership and resource checks at application entrypoints.
6. Add temporal models only where ordering, retries, leases, or cancellation
   make state transitions important.
7. Gate new diagnostics in CI while preserving explicit `unknown` and trusted
   evidence in reviewable artifacts.
8. Move selected boundaries to `--assurance no-unknown`, then `declared`, only
   after reviewing what each profile does and does not claim.

The [Adoption patterns guide](./docs/adoption-patterns.md) describes these
patterns, monorepo and library boundaries, CI ratcheting, escape hatches, and
common failure modes.

## Annotation model

Only block comments containing the exact `uneffect:` marker are interpreted.
Normal JSDoc is untouched, and the canonical annotation form is `/* ... */`
rather than `/** ... */`.

```ts
import type { Nat } from "@mizchi/uneffect"

/*
 * uneffect:
 * effect Console | Mutate<typeof state>
 * requires amount >= 0
 * ensures result >= amount
 * assert amount: Nat
 */
function deposit(state: Account, amount: Nat): Nat {
  state.balance += amount
  console.log(amount)
  return state.balance
}
```

Built-in effect families include `FsRead`, `FsWrite`, `Console`, `Fetch`,
`Dom`, `Mutate<typeof ref>`, and `Throw<ErrorType>`. Platform APIs receive their
semantics through TypeChecker symbol identity; user code does not need wrapper
functions.

Read [Gradual annotations](./docs/gradual-annotations.md),
[Effect system](./docs/effect-system.md), and
[Deno-compatible permissions](./docs/deno-permissions.md) for the grammar and
scope lattice.

Opt-in React function components can additionally separate replayable render
from event, callback-ref commit, layout/passive Effect, and cleanup phases,
locally match acquired resource identities, reject selected snapshot/ref render
violations, check inline Hook dependencies, and expose a Strict Mode replay
projection plus one bounded interrupted-render projection that can generate a
reviewable Quint lifecycle model. Dependency-change replay associates old
cleanup and new setup with their owning commit generations; a bounded Suspense
replay requires resolution before retry commit. See
[React function component semantics](./docs/react-semantics.md).

## CLI

The package publishes one binary, `uneffect`, with subcommands:

| Command | Purpose |
| --- | --- |
| `check <file.ts> [...]` | Check effects, contracts, async safety, and opted-in React TSX semantics. This is the default command. |
| `doctor` | Check Node, TypeScript, Z3 WASM, and optional model-runner prerequisites. |
| `spec <backend> <file.ts> [function]` | Emit neutral IR or a Z3/Quint/composed model. |
| `instrument <file.ts>` | Emit source with optional contract or ownership assertions. |
| `evidence <file.ts>` | Emit a machine-readable effect evidence artifact. |
| `resource-model <file.ts>` | Emit a Quint resource-safety model. |
| `async-model <file.ts> <function>` | Emit a unified Promise, exception, and resource model. |

Generated artifacts go to stdout; diagnostics go to stderr. Options are parsed
strictly, so a misspelled option is a usage error. See the full
[CLI reference](./docs/cli.md).

Quint is optional when generating models and required only when running them:

```sh
npm install --save-dev @informalsystems/quint
npx uneffect spec quint src/protocol.ts > protocol.qnt
npx quint run protocol.qnt
```

The Z3 checks use the `z3-solver` WASM package and do not require a system Z3
binary.

## Diagnostics and evidence

Diagnostics include source spans, the failed obligation, and a counterexample
when the supported solver fragment can produce one. Successful checks can emit
the obligations and inferred effects with `--evidence`.

The `fixtures/` directory keeps source inputs beside generated `.diag` files.
Run `just fixtures` to verify them or `just fixtures-update` to regenerate them.
See [Diagnostics and fixtures](./docs/diagnostics.md).

## Development

The repository uses pnpm, Node.js 24+, Cargo, and `just`.

```sh
just install
just check
just demo
```

Run a focused benchmark with Vitest Bench:

```sh
pnpm vitest bench bench/typed-array-safety.bench.ts --run
```

## Architecture and roadmap

The TypeScript frontend currently establishes semantics through the TypeScript
Compiler API. The analysis and proof layers are separated from frontend facts
so that a Corsa/tsgo adapter can replace the frontend without changing the
contracts or evidence schemas. The native bridge remains versioned and
fail-closed while upstream APIs are unstable.

- [Documentation index](./docs/README.md)
- [Native integration](./docs/native-integration.md)
- [Formal models](./docs/formal-models.md)
- [Roadmap and known gaps](./docs/roadmap.md)
- [Implementation TODO](./TODO.md)
- [GitHub Issues](https://github.com/mizchi/uneffect/issues)

GitHub Issues are the source of truth for unfinished roadmap work.

## License

MIT

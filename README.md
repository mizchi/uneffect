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

Use `/* uneffect: effect none */` for an explicit empty upper bound. This is
different from an unannotated function whose currently inferred inventory is
empty: `none` is checked and can produce `verified` Effect evidence, while the
unannotated inventory remains `inferred`. `none` is reserved and cannot be
combined with another Effect or used as a user-defined Effect name.

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
explicit unknown evidence. CI can opt into `--assurance no-unknown`, the
stronger effect-declaration gate `--assurance declared`, or `--assurance
verified`, which additionally requires the emitted assumption ledger to be
present and empty. The command exits with
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
`claims` contains only established claims: it is empty whenever the requested
assurance fails. Failure reasons remain in `blockers`; candidate claims are not
serialized as if they were results.
Every Effect summary with `evidence: "unknown"` also carries non-empty,
stable-coded `unknownReasons`, so CI and adoption tooling can distinguish an
unresolved callback, generator, external contract, TypeScript error, or module
boundary instead of treating all uncertainty alike.
With `--project`, it also records analyzer/consumer TypeScript package
provenance, and assurance rejects unresolved or non-exact compiler versions.
For a solution-style root with no positional files, referenced configs are
checked as separate compiler domains and the command emits
`uneffect-workspace-check/v1`. Graph errors and ambiguous source ownership fail
closed. The CLI composes the same narrow, verified function and module Effect interface as
the project API and records it in `effectComposition`; every consumed child
`.d.ts` must exactly match an in-memory same-compiler declaration re-emission.
It does not compose the other proof domains. A ledger with no accepted link and
no blocker reports `not-applicable`, never `verified`; an empty composition is
not evidence that a cross-project property was checked.

The programmatic overload `verifyUneffectProject({ projectFile })` applies the
same graph separation to the effect, contract, typed-array, ownership,
assumption, and optional temporal verifier bundle. It returns
`uneffect-project-workspace/v1` with every child result and one aggregate
assurance decision. Cross-project evidence composition remains limited to
verified function and module Effect summaries. Those summaries are composed
child-first at resolved call sites/imports only after the consumed declaration
file exactly matches an in-memory re-emission, and
reported in `effectComposition`. A verified function summary may substitute a
parameter-rooted `Mutate` region into an addressable identifier/member argument at
each call site. Missing, spread, call-result, and other unstable arguments
produce an explicit unknown diagnostic. Ambiguous matches, inferred/trusted/unknown
child evidence, non-exported/inaccessible mutation regions, and unbounded
iterator Effect parameters fail closed. An exported function-closure or
module-initialization mutation root is composed only when the parent imports
that exact declaration (named or namespace import), including through re-export
chains; a project/source/export identity is recorded and a same-named different
symbol does not match. `globalThis` has the separate
`ecmascript:realm.globalThis` identity and composes only within the assumed
runtime realm; host aliases and Worker/iframe realm crossings are not inferred.
Fully bounded iterator Effect parameters are
instantiated from resolved generator, stored iterator, forwarded parameter, or
standard pure-iterator arguments; Promise consumer contracts preserve their
`Throw`-to-rejection conversion.
Use `--require-build-artifacts` in the CLI or
`buildArtifacts: "require-fresh"` in the project API when TypeScript composite
output freshness is part of the boundary. Independently of that opt-in freshness
gate, every declaration consumed by Effect composition is SHA-256-bound to an
exact same-compiler in-memory re-emission. This trusts the selected TypeScript
compiler; it is not a proof certificate for TypeScript itself.
For a deployment boundary that executes TypeScript-emitted JavaScript, use
`--require-exact-build-artifacts` or `buildArtifacts: "require-exact"`. This
also requires SolutionBuilder freshness and byte-compares every emitted `.js`,
`.mjs`, `.cjs`, and declaration output with the same Program's in-memory emit.
`emitDeclarationOnly`, `noEmit`, bundler output, and post-TypeScript transforms
cannot satisfy this stronger gate without a separately validated mapping.

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
8. Move selected boundaries to `--assurance no-unknown`, then `declared`, and
   finally `verified` only where no recorded trusted semantic input is needed.

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

```ts
/* uneffect: effect none */
export function increment(value: number): number {
  return value + 1
}
```

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
| `doctor` | Check Node, TypeScript, the selected Z3 backend, and optional model-runner prerequisites. |
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

Hoare-contract and ownership-evidence checks prefer a native `z3` executable
when one is available and fall back to the bundled `z3-solver` WASM build when
it is not. Set `UNEFFECT_Z3_BACKEND=auto|native|wasm` to choose the policy and
`UNEFFECT_Z3_PATH` to pin the native executable. Native Z3 remains optional.
Temporal counterexample decoding, property generation, and typed-array checks
still use the WASM API directly; `doctor` and evidence report the concrete
runtime only for the checks that use the common SMT-LIB execution layer.

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

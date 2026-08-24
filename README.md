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

## Quickstart

Uneffect requires Node.js 24 or newer and uses the consuming project's
TypeScript installation.

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect doctor
npx uneffect check src/example.ts
```

`check` reports effect, contract, and async-safety diagnostics. It exits with
0 when no error is found, 1 when the checked program fails, and 2 for invalid
CLI usage.

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
from event, layout/passive Effect, and cleanup phases, locally match acquired
resource identities, and expose a Strict Mode replay projection. See
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

# uneffect

[![npm version](https://img.shields.io/npm/v/%40mizchi%2Funeffect.svg)](https://www.npmjs.com/package/@mizchi/uneffect)
[![CI](https://github.com/mizchi/uneffect/actions/workflows/ci.yml/badge.svg)](https://github.com/mizchi/uneffect/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40mizchi%2Funeffect.svg)](./LICENSE)

Uneffect adds gradual effect specifications, Hoare-style contracts, and
temporal models to existing TypeScript without requiring an effect runtime.
Specifications are ordinary block comments and do not change emitted
JavaScript.

## Install

Uneffect requires Node.js 24 or newer. Default `uneffect check` uses Corsa plus
Oxc and does not construct a JavaScript TypeScript 6 Program. Unclassified calls
are `unknown`, not empty inferred proofs. Pass `--typescript-program` for the
full TypeScript effect, contract, and annotation path.

```sh
npm install --save-dev @mizchi/uneffect typescript
npx uneffect doctor
```

With pnpm:

```sh
pnpm add --save-dev @mizchi/uneffect typescript
pnpm exec uneffect doctor
```

## Quickstart

Add an annotation to an existing TypeScript function:

```ts
/* uneffect:effect Console */
export function log(value: number): void {
  console.log(value)
}

/* uneffect:requires n >= 0 */
/* uneffect:ensures result === n */
export function count(n: number): number {
  let value = 0
  /* uneffect:loop_invariant value >= 0 && value <= n */
  while (value < n) value++
  return value
}
```

Check a file or the files selected by a TypeScript project:

```sh
npx uneffect check src/example.ts
npx uneffect check --project tsconfig.json --infer
npx uneffect check --typescript-program --infer --assurance no-unknown src/example.ts
```

For a low-annotation CI rollout, commit an inferred-effect baseline and reject
new effects or newly unknown calls on later changes:

```sh
npx uneffect check --project tsconfig.json \
  --write-effect-baseline .uneffect/effects.json
git add .uneffect/effects.json

# CI
npx uneffect check --project tsconfig.json \
  --effect-baseline .uneffect/effects.json
```

This catches capability expansion without requiring a matching annotation in
advance. It does not detect behavior changes that stay within the same inferred
effect set.

An effect declaration is an upper bound. Missing transitive effects are errors;
declared but unused effects are warnings. Use
`/* uneffect:effect none */` for an explicit checked empty bound. An
unannotated function is not declared pure.

See the [Quickstart guide](./docs/quickstart.md) for project setup, CI, runtime
instrumentation, and model generation. See [Gradual
annotations](./docs/gradual-annotations.md) for the complete comment grammar.

## Install the agent skill

The [Uneffect agent skill](./skills/uneffect/SKILL.md) teaches compatible coding
agents how to choose annotations and report assurance boundaries.

Install it with the Skills CLI:

```sh
npx skills add mizchi/uneffect --skill uneffect
```

Or with [APM](https://github.com/microsoft/apm):

```sh
apm install mizchi/uneffect/skills/uneffect
```

Add `--global` for the Skills CLI or `-g` for APM to install it for the current
user. For reproducible APM project installs, add
`mizchi/uneffect/skills/uneffect` to `dependencies.apm` in `apm.yml` and commit
the generated `apm.lock.yaml`.

## What Uneffect checks

- Capability effects such as filesystem, network, environment, `Console`,
  `Fetch`, DOM operations, mutation regions, typed `Throw`, and user-defined
  effects.
- Preconditions, postconditions, loop invariants, machine-number domains, and
  selected typed-array bounds.
- Promise rejection ownership, timers, supported Promise combinators, and
  explicit resource management. Async observations are inputs to the temporal
  model, not a separate formal-specification domain.
- User temporal specifications and supported JavaScript async observations
  lowered into one host-aware Quint model.
- Opt-in React functional-component and Trusted Types fragments.

Start with [`uneffect check --infer`](./docs/adoption-patterns.md) on a selected
boundary, annotate leaf I/O and high-value invariants, then ratchet CI assurance
only where the relevant fragment is supported.

## Assurance boundary

Uneffect 0.3 is an experimental release. It is useful as an additional,
fail-closed review and CI layer on explicitly selected TypeScript boundaries. A
`verified` artifact applies only to its exact claim, source snapshot,
configuration, supported syntax fragment, and recorded backend.

Within that pre-1.0 boundary, two bounded public integration contracts are supported:
the versioned Corsa semantic-query API and the high-level temporal model/result
facade covering its classified Promise/resource fragments. Low-level CFG,
lowering, solver, and direct generator APIs remain experimental.

Uneffect is not a verifier for all of JavaScript. Do not use it as the sole
security boundary, a replacement for runtime validation, a whole-program
correctness claim, or proof of arbitrary third-party/native behavior. Exit code
0 without an assurance profile means the enabled checks passed; it is not a
proof. `assumed` depends on its trust ledger, and `unknown` establishes nothing.

Before relying on a result, read:

- [Feature overview](./docs/overview.md)
- [Public API and compatibility](./docs/public-api.md)
- [Assurance boundaries](./docs/assurance-boundaries.md)
- [Stability and safe adoption](./docs/stability.md)
- [Feature matrix](./docs/feature-matrix.md)
- [Implementation status](./docs/implementation-status.md)

## Annotation surface

Only block comments with an explicit `uneffect:` marker are interpreted. The
token after the marker is the directive; users do not select an internal proof
domain. Normal JSDoc is untouched.

| Directive family | Purpose |
| --- | --- |
| `uneffect:effect`, `module_effect` | Effect and module-initialization upper bounds |
| `uneffect:requires`, `ensures`, `loop_invariant` | Hoare-style contracts |
| `uneffect:state`, `action`, `always` | State machines and temporal properties |
| ownership and resource directives | Promise and resource protocols in the temporal model |

Detailed references:

- [Effect system](./docs/effect-system.md)
- [Deno-compatible permissions](./docs/deno-permissions.md)
- [Async safety](./docs/async-safety.md)
- [Persisted contract summaries](./docs/contract-summaries.md)
- [Formal models](./docs/formal-models.md)
- [React semantics](./docs/react-semantics.md)
- [Trusted Types](./docs/trusted-types.md)
- [Typed arrays and numeric domains](./docs/typed-arrays.md)

## CLI

The package publishes the `uneffect` binary. Its main commands are `check`,
`doctor`, `spec`, `instrument`, and `evidence`. Use `spec temporal` for the
combined user/JavaScript async model:

```sh
npx uneffect check --project tsconfig.json --infer
npx uneffect check --project tsconfig.json \
  --assurance no-unknown --json > uneffect-check.json
npx uneffect spec temporal src/protocol.ts main --runtime web > protocol.qnt
```

See the [CLI reference](./docs/cli.md) for all commands, options, exit codes,
workspace-project behavior, and solver backend selection.

For in-process use, the package root exposes only numeric/runtime helpers and
high-level checking facades such as `checkFiles`, `verifyUneffectProject`, and
`generateTemporalModel`; stored temporal results can be validated with
`parseTemporalModelResult`. The versioned direct Corsa semantic-query contract
is available from `@mizchi/uneffect/corsa/api`. Solver adapters, lowering IRs, direct Quint
generators, and optimizer experiments live under
`@mizchi/uneffect/experimental` and have no compatibility guarantee. Raw
Corsa/Oxlint checker-fact and parity integrations live under
`@mizchi/uneffect/experimental/corsa`. See
[Public API and compatibility](./docs/public-api.md) for the exact boundary.

## Development

The repository uses pnpm, Node.js 24+, Cargo, and `just`.

```sh
just install
just check
```

## Documentation and roadmap

- [Documentation index](./docs/README.md)
- [Feature overview](./docs/overview.md)
- [Public API and compatibility](./docs/public-api.md)
- [Adoption patterns guide](./docs/adoption-patterns.md)
- [Native integration](./docs/native-integration.md)
- [Roadmap and known gaps](./docs/roadmap.md)
- [Implementation TODO](./TODO.md)
- [GitHub Issues](https://github.com/mizchi/uneffect/issues)

GitHub Issues are the source of truth for unfinished roadmap work.

## License

MIT

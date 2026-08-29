# Uneffect basics

## Install and inspect the environment

Uneffect requires Node.js 24 or newer and uses the consuming project's
TypeScript installation.

```sh
pnpm add -D @mizchi/uneffect typescript
pnpm exec uneffect doctor
```

Start with one selected file or a consumer `tsconfig.json`:

```sh
pnpm exec uneffect check --infer src/entry.ts
pnpm exec uneffect check --project tsconfig.json --infer
pnpm exec uneffect check --project tsconfig.json --evidence src/entry.ts
```

For stable machine-readable CI output:

```sh
pnpm exec uneffect check --project tsconfig.json --infer \
  --assurance no-unknown --json > uneffect-check.json
```

The available assurance profiles become progressively stricter:

- `no-unknown`: reject relevant unresolved evidence.
- `declared`: additionally require declaration-checked Effect summaries.
- `verified`: additionally require a present and empty assumption ledger.

Do not infer `verified` from exit code 0. Read the JSON `outcome`,
`assurance.status`, `blockers`, `claims`, `exclusions`, and coverage together.

## Canonical comment syntax

Normal JSDoc remains untouched. Use ordinary block comments with an explicit
dialect and no space around the colon:

```ts
/* uneffect:capability effect Console */
export function report(value: number): void {
  console.log(value)
}

/* uneffect:contract requires n >= 0 */
/* uneffect:contract ensures result === n */
export function count(n: number): number {
  let value = 0
  /* uneffect:contract invariant value >= 0 && value <= n */
  while (value < n) value++
  return value
}
```

The main dialects are:

- `capability`: unordered may-effect bounds and module initialization bounds.
- `contract`: preconditions, postconditions, loop invariants, and assertions.
- `temporal`: states, initialization, actions, invariants, and transitions.
- `async`: Promise rejection/resource ownership boundary contracts that feed
  temporal analysis; it is not an independent formal-specification domain.
- `react-component`: opt-in React functional-component analysis.
- `runtime`, `refinement`, and other specialized markers: bindings between
  static specifications, runtime identities, and implementation evidence.

Use `/* uneffect:capability module_effect ... */` for executable module
initialization, separately from function effects.

## Effect examples

```ts
/* uneffect:capability effect Console | Fetch */
async function load() {
  console.log("loading")
  return fetch("https://api.example.com/v1/items")
}

/* uneffect:capability effect Mutate<typeof state.calls> */
function recordCall() {
  state.calls++
}

/* uneffect:capability effect Throw<RangeError> */
function checkedIndex(index: number) {
  if (index < 0) throw new RangeError("negative index")
}

/* uneffect:capability effect none */
function add(a: number, b: number) {
  return a + b
}
```

`Mutate<typeof state>` covers descendant members such as `state.calls`.
Sibling regions do not cover one another. A synchronous surrounding `catch`
can discharge supported `Throw<E>` effects; async rejection ownership is a
separate analysis.

## Runtime refinements

Use exported branded types to communicate domains inside checked code, and
parsers at untrusted boundaries:

```ts
import type { Nat, U8, BoundedUint8Array } from "@mizchi/uneffect"
import { parseU8 } from "@mizchi/uneffect"

const byte: U8 = parseU8(input)

/* uneffect:contract requires size >= 0 && size <= 1024 */
function allocate(size: Nat): BoundedUint8Array<1024> {
  return new Uint8Array(size)
}
```

Lowercase helpers such as `u8`, `u32`, `i32`, and `f32` perform explicit
ECMAScript coercion; they are not validators.

## Authoritative details

- [`docs/quickstart.md`](../../../docs/quickstart.md)
- [`docs/gradual-annotations.md`](../../../docs/gradual-annotations.md)
- [`docs/cli.md`](../../../docs/cli.md)
- [`docs/effect-system.md`](../../../docs/effect-system.md)
- [`docs/diagnostics.md`](../../../docs/diagnostics.md)

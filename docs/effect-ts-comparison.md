# Comparison with Effect TS

The repository includes a real `effect` package example using `Effect.gen`, `Ref`, and `Console`. It is type-checked and executed by the test suite.

```ts
import { Console, Effect, Ref } from "effect"

const program = Effect.gen(function* () {
  const ref = yield* Ref.make(0)
  yield* Ref.update(ref, n => n + 1)
  const value = yield* Ref.get(ref)
  yield* Console.log(`count=${value}`)
  return value
})
```

Run it with:

```sh
just effect-demo
```

## Different goals

Effect TS represents computations as runtime values and tracks error and service requirements through TypeScript types. Uneffect preserves ordinary functions and execution while checking may-effects inferred from existing builtin operations.

```ts
/* uneffect: effect Console | Mutate<typeof state> */
function increment(state: { count: number }) {
  state.count++
  console.log(state.count)
}
```

| Concern | Effect TS | Uneffect |
|---|---|---|
| Adoption | Program and runtime model change | Gradual comments on existing TypeScript |
| Effect representation | Typed runtime computation | Erased static summary |
| Execution | Explicit runtime interpreter | Ordinary JavaScript calls |
| Errors/services | Type parameters | `Throw<E>` and scoped/domain contracts |
| Mutation | Prefer controlled references | Observe and constrain existing references |
| Cancellation/resources | Runtime semantics | Static models for cancellation and explicit resource disposal; no equivalent runtime scheduler |
| Verification | Composition through Effect APIs | Builtin symbol contracts, call graph, Z3, temporal models |

Uneffect is not intended to reproduce Effect TS runtime semantics. The Effect TS example is a baseline used to discover what a static summary loses: typed failure channels, resource scopes, interruption, fibers, scheduling, and service provisioning.

## Comparison protocol

For representative programs:

1. Write the Effect TS version.
2. Write an ordinary TypeScript version with Uneffect annotations and contracts.
3. Compare observable behavior and guarantees.
4. Classify every difference as statically recoverable, dynamically checkable, or fundamentally runtime-dependent.

This comparison should remain adversarial: it is evidence for the boundary of Uneffect, not an argument that either system subsumes the other.

The executable `fetch-and-recover` acceptance fixture currently establishes
the same final value and compares an explicit authority manifest. Its Effect TS
branch executes the normalized recovered value. It does **not** yet prove that
`Effect.tryPromise`/`Effect.catchAll` callback ownership or service authority is
equivalent; Uneffect deliberately reports that callback timing as unknown in
self-analysis today.

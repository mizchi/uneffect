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
/* uneffect:capability effect Console | Mutate<typeof state> */
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

The checked-in adoption probe also analyzes Effect's `src/Function.ts`. It
currently reports one unknown module summary, classified as `unresolved-call`;
it does not claim complete Effect package coverage. The report exposes
`unknownReasonCounts` so this boundary cannot be hidden behind an aggregate KPI.

## Comparison protocol

For representative programs:

1. Write the Effect TS version.
2. Write an ordinary TypeScript version with Uneffect annotations and contracts.
3. Compare observable behavior and guarantees.
4. Classify every difference as statically recoverable, dynamically checkable, or fundamentally runtime-dependent.

This comparison should remain adversarial: it is evidence for the boundary of Uneffect, not an argument that either system subsumes the other.

The executable `fetch-and-recover` acceptance fixture establishes the same
final value and compares an explicit authority manifest. Its Effect TS branch
now executes an actual `Effect.tryPromise(...).pipe(Effect.catchAll(...))`
recovery path. The comparison analyzer resolves `tryPromise`, `catchAll`, and
the functional `pipe` form through declarations in the installed `effect`
package, associates a later `catchAll` stage with the failure it owns, and
retains an unhandled negative control. This is callback failure ownership, not
full Effect scheduling or interruption semantics. Service authority is still
an explicit comparison manifest rather than an inference from Effect's
environment type.

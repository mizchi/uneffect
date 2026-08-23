# Promise state and reaction model

Promise chains use two terminal states and explicit resolution phases:

```text
Pending = 0
Fulfilled = 1
Rejected = 2
Assimilating = 3
AssimilatingWhilePreservingRejection = 4 // internal to finally
```

```ts
const promise = new Promise<number>((resolve) => resolve(1))
return promise.then(transform).catch(recover).finally(cleanup)
```

```sh
just spec-promise-quint examples/promise-chain.ts
```

The analyzer recognizes the builtin constructor and prototype methods through
TypeChecker declaration symbols. A source-defined class named `Promise` or a
source-defined method named `then` receives no builtin semantics.

## Executor boundary

`new Promise(executor)` records that the executor is invoked synchronously and
that a throw from the executor becomes rejection rather than a synchronous
`Throw` escaping from the constructor. For an inline arrow or function
executor, a deliberately small path analysis handles statement blocks,
`if`/`else`, direct resolver calls, direct rejecter calls, and `throw`.

Each path is open until its first settlement operation. Later resolver calls,
rejecter calls, and throws cannot change that path's result. This implements
the Promise constructor's first-settlement-wins rule in the projection. An
executor that reaches its end on an open path may remain pending. A callback
whose body is unavailable is conservatively modeled as possibly fulfilled,
rejected, assimilating, or pending.

Resolving with a statically PromiseLike value enters `Assimilating`, not
`Fulfilled`. Separate transitions then adopt fulfillment or rejection before
reactions become enabled.

When a direct resolver argument is a local Promise constructor binding that is
also analyzed, the executor records that target by TypeChecker symbol identity.
The generated transition is then guarded by the target chain's actual root
state: a known rejected operation cannot nondeterministically fulfill an outer
adapter. The same link is retained for a direct Promise binding returned by an
inline arrow or direct-return function handler. Forward declarations work
because executor discovery precedes reaction discovery.

The same resolution phase recognizes two direct local object forms. A `get
then()` body consisting of a throw rejects the adopting Promise. A callable
`then(resolve, reject)` body is analyzed with the executor's restricted path
semantics, so only its first resolver/rejecter call controls settlement. Calls
after settlement and later throws are ignored. Both patterns retain
`invokesUserCode: true` in neutral Promise IR. Resolving a Promise with itself
transitions from assimilation to rejection, representing the required
`TypeError`, rather than leaving an impossible adoption cycle pending.

## Reactions

- `then`: handles fulfillment; rejection propagates when no rejection handler
  is modeled. A handler may fulfill or reject its derived Promise.
- `catch`: fulfillment propagates; a rejection handler may recover or reject
  its derived Promise.
- `finally`: successful cleanup preserves the prior fulfillment/rejection;
  cleanup failure rejects the derived Promise.

The TypeChecker classifies each present handler return as a plain value,
PromiseLike, or unknown. A PromiseLike return puts the derived Promise into an
assimilation state and later adopts its fulfillment or rejection. An unknown
return conservatively permits both the immediate-value and assimilation paths.
For `finally`, a second internal assimilation state remembers that successful
cleanup must restore the original rejection rather than fulfill the derived
Promise.

Every link creates a distinct derived Promise state. A following link is not
enabled until the preceding state settles, representing Promise reactions as
separate microtask transitions rather than synchronous calls.

The negative controls enable a reaction while its input is still pending, make
a successful `finally` recover a rejection, allow a settled Promise to be
settled again, or skip returned-Promise assimilation. Quint finds all four
violations.

## Current boundary

The model currently abstracts values and rejection reasons. Unknown or
ambiguous adoption targets still admit either terminal state. Direct local
throwing getters and callable hostile thenables are modeled. Conditional local
getters, direct `Proxy` values with a `then` member, direct external/imported
`PromiseLike` symbol identities, typed imported call results, and unresolved
computed typed thenable selections use a conservative dynamic state that
permits fulfillment, rejection, or remaining pending. Each such pattern carries
an explicit `InvokeUserCode` capability effect, and effect inference assigns it
to the enclosing Promise executor. Direct conditional selections between
analyzed local thenable symbols retain every branch identity and emit distinct
adoption actions. A direct Proxy `get` trap that solely throws or returns a
concrete then callback is analyzed exactly. A selected callback may also pass
through a cycle-safe chain of local `const` bindings; mutable callback bindings
remain dynamic. The canonical
`if (property === "then") return callback; return forwardingValue` shape is
also narrowed by TypeScript symbol identity. Immutable `as const` tuples and
object literals can be selected exactly through reassignment-free literal
`const` indexes/keys. Cycle-safe immutable alias chains are followed for both
the container and key, and direct property access on the same immutable object
fragment is exact. Finite conditional literal keys retain every selected local
thenable identity as an alternative adoption action. Getters, out-of-range or
non-literal keys, and mutable arrays/records remain dynamic. More general
computed selections and complex Proxy trap
behavior, and recursive thenable cycles
resolution remain conservative gaps. Links currently require a direct local constructor binding
and at least one analyzed reaction chain for the adopted executor; aliases,
parameters, object properties, and named handler summaries remain conservative.
The model also does not cover handler capability effects or handled/unhandled
rejection timing. Loops,
`switch`, `try`/`finally`, aliases of resolver parameters, and resolver calls
through helper functions are outside the executor path-analysis subset and
remain conservative gaps rather than proved behavior.

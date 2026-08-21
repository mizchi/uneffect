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

The model currently abstracts values and rejection reasons. Assimilation
adopts either terminal state, but it does not yet model reading a thenable's
`then` property, invoking that user code, misbehaving thenables, or
self-resolution cycles. Handler returns are flattened at the state level, but
the adopted Promise is not yet linked to another analyzed chain. The model also
does not cover handler capability effects or handled/unhandled rejection
timing. Loops,
`switch`, `try`/`finally`, aliases of resolver parameters, and resolver calls
through helper functions are outside the executor path-analysis subset and
remain conservative gaps rather than proved behavior.

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

Promise observations compose into the host-aware temporal model:

```sh
pnpm exec uneffect spec temporal examples/promise-chain.ts main --runtime web
```

The former `promise-quint` CLI backend has been removed. Its direct generator
remains an experimental projection, not a separate proof domain.

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

`Promise.withResolvers<T>()` enters the same first-settlement-wins state
machine through a distinct external-resolver boundary. Canonical object
destructuring, renamed bindings, immutable resolver aliases, and an immutable
capability object with `.promise`/`.resolve`/`.reject` are resolved by
TypeChecker identity. Settlement transitions use the `external` host lane;
they are not described as synchronous executor calls, and an ordinary throw in
the surrounding function does not itself reject the created Promise.
Straight-line and `if`/`else` resolver calls retain exact first-settlement
paths. Resolver calls under unsupported loop/switch/try shapes are included as
conservative may-outcomes while pending remains possible. Escaped `resolve`,
`reject`, or capability objects retain the corresponding externally controlled
settlement outcomes instead of being treated as permanently pending. Dynamic
property keys, mutable capability roots, and interprocedural resolver-return
summaries are not yet exact.

`Promise.try(callback, ...args)` is a second synchronous callback boundary. It
invokes the callback immediately, but maps both a returned value and an abrupt
throw into the returned Promise's settlement. Inline and same-Program named
callbacks use a bounded `if`/return/throw analysis; a returned PromiseLike enters
`Assimilating`. Calls and property evaluation conservatively add a rejection
outcome. An unavailable callback body admits fulfillment, rejection,
assimilation, and pending rather than claiming an exact result. General loops,
dynamic switches, and escaped callback summaries are not yet path-exact. Direct nested
`try`/`catch`/`finally` uses the shared completion algebra: catch consumes only
synchronous throw paths, and an abrupt finally completion overrides the incoming
return or throw while normal cleanup preserves it.
Finite `switch` uses TypeChecker literal-union coverage, preserves source-order
fallthrough, and consumes an unlabeled break owned by that switch. Without a
default or proven literal-union coverage, a no-match fulfillment path remains.
Loops, continue, labeled transfer, and possible synchronous nontermination are
not mislabeled as an exact settlement: their callback result widens to all root
settlements with pending retained, while the independent
`mayDivergeSynchronously` axis records that the constructor/callback invocation
itself may never return. The Quint projection exposes this as
`synchronously_blocked` and `promiseSynchronouslyProgressed`; once blocked, no
settlement or reaction transition can run. A returned-but-unsettled Promise has
`mayRemainPending` without setting this flag.
The divergence scan follows direct and mutually recursive same-Program
callables by TypeChecker symbol identity. Immutable callable aliases and
unmodified properties of a `const` object literal retain the same result;
mutable bindings or written properties are not trusted as their initializer and
fall back to an opaque callback boundary. Arbitrary external-call termination,
dynamic dispatch, Proxy access, and semantic termination proofs remain outside
this bounded cycle check. A visible callback body that invokes an external or
otherwise unresolved callable therefore records `opaque-call` and admits
synchronous divergence; an unresolved callback value records
`opaque-callback`. The evidence distinguishes these from `iteration`,
`recursion`, and `unsupported-control`.

An external or otherwise opaque callable may carry
`/* uneffect:temporal_contract terminates true */`. The Promise analysis resolves
the invoked declaration with TypeScript symbol identity and then removes that
call's `opaque-call` divergence branch. This is a user-supplied trusted
termination contract, not an analysis of the callee implementation: it is
recorded in the assumption ledger and prevents assumption-free `verified`
assurance. Missing, `false`, duplicated, shadowed, or dynamically selected
contracts remain fail-closed.
Promise executor resolve/reject parameters are the only intrinsic call
exemption in this analysis.

Reaction-free executors are emitted as synthetic root chains rather than being
dropped from the model. The unified temporal facade publishes the Promise
projection and checks both properties. Its Web/Node event-loop projection uses
the same source-ordered executor choice. A divergence branch blocks every host
queue action; a returned-settled branch enqueues the first reaction, while a
returned-pending branch does not. Opaque executors retain all three choices.
The separate Promise projection remains reviewable, but synchronous divergence
no longer creates a `promise-host-synchronization` exclusion.

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
through a cycle-safe chain of local `const` bindings. The object-literal handler
itself may use the same immutable alias form. A `get` property assigned an
immutable local function, including a concise arrow, is also exact; mutable
handlers, traps, and callback bindings remain dynamic. The canonical
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

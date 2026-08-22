# Builtin asynchronous pattern models

Uneffect recognizes selected platform combinators by TypeChecker-resolved
builtin symbol. A shadowed function named `setTimeout` or object named
`Promise` is not assigned builtin semantics.

```ts
function poll() {
  setTimeout(poll, 5)
}

async function loadAll() {
  return Promise.all([readUsers(), readPosts()])
}
```

```sh
just spec-async-quint examples/async-patterns.ts
```

## `setTimeout` loops

A statically numeric timeout lowers to `scheduled`, `due`, `fires`, and
`early` state. The callback may fire only when `clock >= due`. This models the
delay as a lower bound, matching the API: it does not claim that the callback
runs exactly at the deadline. A direct self-reference such as
`setTimeout(poll, 5)` is a loop transition that schedules the next due time;
it is not recursively unrolled. A one-shot callback becomes unscheduled after
its first firing. Dynamic and negative delays are explicit unsupported cases
rather than silently treated as zero.

Timer handles assigned to local identifiers are linked to `clearTimeout` and
`clearInterval`. An unconditional cancellation in the same function makes the
timer initially cancelled in the event-loop projection; a cancelled timer
cannot fire. Cancellation under a branch, loop, or `try` is retained as
non-definite rather than unsoundly assumed to happen.

`queueMicrotask` is a distinct zero-delay queue. Pending microtasks must drain
before an eligible timer callback in the Web profile. The negative controls
allow post-cancellation firing and timer-before-microtask firing; Quint finds
both.

The initial Node 24 profile is available through
`just spec-node-event-loop <file>`, `node-loop-quint`,
`generateNodeEventLoopQuint`, and project verification with
`temporalRuntime: "node"`. TypeChecker-resolved `process.nextTick` callbacks
use a separate next-tick queue, `queueMicrotask` uses the V8 microtask queue,
and `setImmediate` uses a check queue. At an ordinary callback checkpoint the
next-tick queue must drain before V8 microtasks, and both drain before another
modeled timer/check callback. A broken option permits a microtask to overtake a
pending next-tick callback and is rejected by `nodeEventLoopSafe`.

This is intentionally not a complete libuv model. Node documents a special
ESM top-level case where module evaluation is already executing as a
microtask, so `queueMicrotask` can precede `nextTick`; that case is excluded
from this callback-checkpoint profile. Poll/I/O readiness, close callbacks,
pending callbacks, idle/prepare internals, recursive starvation, Promise
reactions in the Node profile, and version/platform-dependent timer/check
selection remain explicit gaps.

The model preserves reassignment-free local handle aliases and records direct
identifier, array/object aggregate, property, return, opaque-argument, and
returned-inline-closure escape, including through immutable local bindings. It
now resolves direct/literal-computed methods and single-return source callback
factories, but not dynamic property selection. Nested minimum-delay clamping,
integer overflow, browser background throttling, complete libuv phases, and
the distinction between monotonic and wall clocks also remain unmodeled. Source
control flow before initial scheduling is only classified for definite
cancellation, not fully symbolically executed.

Direct timer registrations also retain a `handleKind` of `number`, `object`, or
`unknown` from the resolved TypeScript return type. This distinguishes common
DOM and Node handle representations in neutral IR. Cross-host cancellation
compatibility is still not proven.

## Promise combinators

An array literal lowers to one nondeterministic state per input and a join
state. Branches may fulfill or reject in any order. The aggregate may fulfill
only after every branch fulfills, and may reject after any branch rejects.
Both aggregate outcomes are terminal. A deliberately spurious-rejection model
is retained as a negative control alongside the early-fulfillment model.
The model checks completion ordering; it does not claim parallel CPU
execution. JavaScript starts the input computations before `Promise.all`
observes them, and the model deliberately preserves only their outcomes and
join relationship.

The projection retains whether the call is directly awaited and whether that
await is protected by `try/catch`. Aggregate rejection therefore records an
explicit `rejection_escapes` state. An empty array starts pending and fulfills
through a separate join transition rather than synchronously in `init`.
Dynamic iterables and spreads whose operand is not itself a nested array
literal are rejected as unsupported instead of being assigned a guessed
cardinality. Nested array-literal spreads are recursively flattened while
preserving holes and element order. Two other local,
statically inspectable forms are accepted: an object whose standard
`[Symbol.iterator]()` method directly throws during acquisition, and a linear
generator containing only direct `yield`, `throw`, and `return` statements.
Acquisition or step failure rejects every Promise combinator, including
`allSettled`, before any yielded Promise reaction can settle the aggregate.
Sparse literal holes are retained as `undefined` value slots, matching array
iteration rather than being dropped.

The same neutral combinator IR covers four builtin methods:

| Combinator | Fulfill condition | Reject condition | Empty input |
|---|---|---|---|
| `Promise.all` | every branch fulfilled | any branch rejected | fulfills asynchronously |
| `Promise.allSettled` | every branch settled | never | fulfills asynchronously |
| `Promise.race` | first settled branch fulfilled | first settled branch rejected | remains pending |
| `Promise.any` | any branch fulfilled | every branch rejected | rejects asynchronously with an abstract AggregateError |

For `race`, branch settlement and aggregate settlement are one atomic model
transition. This preserves first-settler-wins instead of allowing the model to
wait until several branches settle and choose a winner afterward. Losing
branches are outside the projection after the aggregate settles; JavaScript
still executes them, so their side effects require a later branch-effect
composition model.

`allSettled` preserves branch indexes and settlement status in the IR state,
but values and rejection reasons are currently abstracted away. `any` retains
the input-index order used by `AggregateError.errors`, independently of branch
rejection order, and emits count/rank constants to Quint. Literal
`Promise.reject(value)` reasons and direct `Promise.reject(new ErrorType(message))`
reasons are retained as typed IR values and stable string constants in the
artifact. Other rejection reasons remain explicitly unknown.

Each literal element is classified as a plain value, a thenable, or unknown.
Plain values (including holes) can only fulfill. Thenables enter an explicit
assimilation state before fulfillment or rejection; `allSettled` does not count
that intermediate state as settled. Unknown unions retain both the immediate
value and thenable paths. Promise-chain analysis separately recognizes a
restricted set of direct throwing and hostile thenables, but that richer
thenable IR is not yet composed into each combinator branch. Conditional
generator control flow, imported or arbitrary custom iterables, dynamic spread
cardinality, concrete `AggregateError` reasons, cancellation,
combinator result values, and branch effect interleavings remain unsupported.
Rejection is possible but not forced immediately without a fairness assumption.

For direct local object iterables, a throwing `next` getter is an iterator
acquisition failure. Throwing `done` or `value` getters on a directly returned
iterator-result object are step failures. Both reject the combinator before any
modeled branch settles; arbitrary/dynamic iterator implementations remain an
unknown boundary rather than being assigned an invented finite cardinality.
The combinator IR distinguishes `array`, `local`, and `dynamic` iterator
provenance. Direct recursively finite array literals have no iterator effect;
local custom and dynamic/imported iterables carry `InvokeUserCode`. Effect
checking therefore requires that authority even when temporal generation is
refused because the iterable cardinality is not statically bounded.

## Verification ledger

| Claim | Machine result | Non-claim |
|---|---|---|
| timeout callback never fires before its static delay | Quint positive model passes; unguarded negative model fails | callback runs exactly on time |
| definitely cancelled timer does not fire | Quint positive model passes; post-cancel negative model fails | arbitrary handle aliases are resolved |
| pending microtasks run before timer callbacks | Quint positive model passes; reversed-queue negative model fails | complete browser/Node event-loop phase ordering |
| `Promise.all` never fulfills before every branch fulfills | Quint positive model passes; early-join negative model fails | branches run simultaneously |
| `Promise.all` never rejects without a rejected branch | Quint positive model passes; spurious-rejection negative model fails | rejection is scheduled immediately |
| `Promise.allSettled` waits for every outcome and never rejects | combined positive/negative combinator models | result values and reasons are preserved |
| `Promise.race` uses the first modeled settlement | atomic branch/aggregate transition | losing branches are cancelled |
| `Promise.any` fulfills on any success and rejects only after all failures | combined positive/negative combinator models | AggregateError payload is modeled |
| dynamic iterable cardinality is not guessed | model generation rejects it explicitly | arbitrary iterables are unsupported |
| builtin identity is not based on spelling | shadowing regression passes | arbitrary wrappers inherit builtin semantics |

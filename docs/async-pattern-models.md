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
modeled timer/check callback. Definitely queued Promise reactions share the
same source-ordered V8 FIFO with `queueMicrotask` jobs. A broken option permits
a V8 job to overtake a pending next-tick callback and is rejected by
`nodeEventLoopSafe`.

The generated state machine makes the modeled host phase explicit:
callback checkpoint (`0`), timers (`1`), abstract poll (`2`), check (`3`), and
close/iteration boundary (`4`). Every modeled timer or immediate callback
returns to phase `0`, drains next-tick and V8 jobs, and resumes its originating
phase. `process.nextTick` and `queueMicrotask` registrations found in a
statically resolved callback body are initially absent and become pending only
when that parent callback runs; the next-tick child then drains first. Time
advances only when the close boundary starts the next bounded
iteration. A phase-fault oracle is rejected by the same invariant. This phase
numbering is Uneffect IR, not a public numeric API from Node.

Reviewed one-shot callback overloads of TypeChecker-resolved `node:fs`
operations—including file access/stat/read/write/copy and path mutation—retain
their existing filesystem capability contract and also create an externally
completed poll job. Completion is nondeterministic; once ready, the callback
can run only in phase `2` and returns through the ordinary checkpoint. Promise,
synchronous, watcher, and stream variants do not receive this callback
projection. Independent poll completions are intentionally not constrained by
source registration order.

A statically resolved nested `setImmediate` is also registered dynamically.
An Immediate created inside any executing callback receives a next-iteration
due time and cannot run in the current iteration, matching Node's documented
queue rule.

A static `setTimeout`/`setInterval` call found in a resolved non-repeating
parent callback is likewise absent initially and registered with a normalized
due time when the parent runs. A one-shot `setTimeout` call-site under a
repeating parent has an unbounded integer instance count: every parent firing
registers another instance and every child firing consumes one. Pending
instances share the oldest known due time, a conservative ordering abstraction
which can schedule the remaining instances no later than their exact
per-instance due-time queue. Repeated creation of recurring intervals remains
outside this projection rather than being collapsed into one interval.

For Node `Timeout`/`Interval` handles, the projection normalizes a static delay
below `1`, above `2147483647`, or equal to the standard global `NaN` to `1`,
and truncates other fractional delays,
following the [Node timers contract](https://nodejs.org/docs/latest-v24.x/api/timers.html).
This host-specific normalization does not apply to Web timers or
`AbortSignal.timeout`.

This is intentionally not a complete libuv model. Node documents a special
ESM top-level case where module evaluation is already executing as a
microtask, so `queueMicrotask` can precede `nextTick`; that case is excluded
from this callback-checkpoint profile. Poll callbacks outside the reviewed
one-shot fs set, poll ordering/readiness details, close callbacks,
pending callbacks, idle/prepare internals, recursive starvation, dynamically
created/imported Promise reactions, and version/platform-dependent timer/check
selection remain explicit gaps.

The model preserves reassignment-free local handle aliases and records direct
identifier, array/object aggregate, property, return, opaque-argument, and
returned-inline-closure escape, including through immutable local bindings. It
now resolves direct/literal-computed methods and single-return source callback
factories. It also resolves both branches of a finite conditional callback when
every branch has a source body, deduplicating identical branches. A conditional
with any unresolved or external branch remains dynamic. Dynamic property
selection is resolved only for finite literal keys into immutable `as const`
object tables whose every selected property has a source callback body. Mutable
tables, getters, missing keys, and other dynamic selections remain unresolved.
Source callback factories use a definite-return block/`if` subset and retain
every resolved return candidate. Concise conditional arrows are included;
parameter symbols are specialized from concrete call arguments, so identity
factories and finite literal-key selection from immutable callback tables can
remain exact. An object-literal method factory may also select through
`this.table[key]` when the receiver and nested table are immutable. Mutable,
class-instance, and polymorphic receivers remain dynamic. A type assertion
around a dynamic value does not make it finite.
fallthrough, cycles, unsupported control flow, or any unresolved returned value
make the factory callback dynamic.
Nested minimum-delay clamping,
integer overflow, browser background throttling, complete libuv I/O phase behavior, and
the distinction between monotonic and wall clocks also remain unmodeled. Source
control flow before initial scheduling is only classified for definite
cancellation, not fully symbolically executed.

Direct timer registrations also retain a `handleKind` of `number`, `object`, or
`unknown` from the resolved TypeScript return type. This distinguishes common
DOM and Node handle representations in neutral IR. Cancellation is checked
separately by semantic family: `clearTimeout`/`clearInterval` can discharge a
timeout/interval regardless of whether its host-visible handle is numeric or a
Node object, `clearImmediate` only discharges an Immediate, and
`cancelAnimationFrame` only discharges an animation-frame request. An
incompatible clear call is retained with `compatible: false` and cannot make a
callback initially cancelled. Passing handles across actual realms or host
APIs remains outside this family-level proof.

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
preserving holes and element order. A spread of the finite imported
generator/custom-iterable subset is flattened as well, but retains
`InvokeUserCode` and any iterator acquisition or step failure rather than
becoming a pure array operation. Reassignment-free local `const` aliases of
these iterables are followed cycle-safely; `let` bindings remain dynamic even
when their initializer happens to be finite. Two other local, statically
inspectable forms are accepted: an object whose standard
`[Symbol.iterator]()` method directly throws during acquisition, and a linear
generator containing only direct `yield`, `throw`, and `return` statements.
That restricted generator may be imported from another TypeScript source file.
The same finite body is accepted for the standard iterator generator method of
an imported immutable object literal, or an object literal returned directly by
an imported factory whose body contains only that return. The analyzer resolves
aliases by TypeChecker symbol identity and substitutes a directly yielded
factory or generator parameter with its call-site argument. Substitution also
descends through parenthesized expressions and call/constructor arguments. This
preserves concrete `Promise.resolve(value)`, `Promise.reject(reason)`, and
`new Error(message)` evidence across local and imported generator/factory
boundaries without evaluating the expression. A substituted binary `+` is also
rebuilt, and string/number literal operands are folded only for rejection-reason
evidence. If either operand remains dynamic, the batch stays finite but its
reason remains unknown. Template-literal spans use the same substitution rule
and fold to a concrete string only when every embedded expression is literal.
Property and literal-index reads are projected recursively when the substituted
base is a direct immutable object literal containing only non-computed property
assignments. Spreads, getters, methods, computed/dynamic keys, `__proto__`, other
operators, and general expression substitution remain outside this finite
fragment and do not receive value specialization; their finite slot still
exists, but its rejection reason remains unknown.
Literal indices also project from direct array/readonly-tuple literals when the
index is a canonical non-negative integer and the array contains no spread or
hole. Dynamic, out-of-range, sparse, and spread-dependent indexing remains
unknown rather than borrowing a neighboring element.
Conditional expressions inside a yielded call/constructor argument are rebuilt
after substitution. A literal `true` or `false` condition selects exactly one
branch; a dynamic condition remains a conditional expression and contributes no
concrete rejection reason. This specialization is expression-local and does not
replace the correlated generator-path model used for statement-level `if`.
Direct boolean negation participates in the same substitution: `!true` and
`!false` fold, including after object/tuple projection, while `!dynamic` remains
symbolic and cannot select a conditional branch.
Boolean `&&` and `||` likewise follow JavaScript short-circuiting when the
substituted left operand is the literal `true` or `false`. Dynamic left-hand
truthiness remains symbolic, and an unreachable right operand is not inspected.
Strict equality and inequality fold when both substituted operands are boolean,
number, string, or `null` literals. Coercive equality and dynamic operands stay
symbolic.
A generator with direct `if`/`else` statements becomes a finite set of complete,
correlated execution paths. Unequal path lengths use choice-indexed presence
guards, and nested or consecutive conditionals are composed rather than mixing
values from incompatible paths. Partial `if` statements use an empty else path.
Repeated reads of the same TypeScript-resolved boolean condition, including a
negated call-site argument such as a second spread of `values(!flag)`, share a
path constraint. Contradictory products are removed before Quint generation.
This identity fragment does not prove equivalence between general boolean
expressions. Guards outside a boolean identifier, its direct negation, or a
boolean literal remain dynamic because evaluating a call, property, or general
expression may itself invoke user code or throw. Literal guards are folded, so
an unreachable branch does not enter the path product. A bare `yield;` is an
exact fulfilled `undefined` value slot, not an unknown thenable.
`yield*` is flattened when its operand is a recursively finite array/readonly
tuple, a directly constructed finite builtin `Set`, or a resolved local/imported
generator call that itself stays in this finite fragment. The same rule covers a
resolved single-return factory whose returned object has a finite generator
`[Symbol.iterator]` method. Delegation substitutes call-site arguments, composes
correlated paths, and turns a delegated acquisition/step failure into a step
failure of the parent generator. A symbol call stack rejects direct and indirect
recursive generator, factory, and immutable-object delegation instead of
assuming termination. Delegated return values are intentionally ignored,
matching the iteration values observed by Promise combinators. General dynamic
custom iterator delegation remains outside this slice.
Synchronous `for...of` is unrolled over the same direct finite array/readonly
tuple and builtin-Set subset. A directly yielded loop binding is specialized by
TypeChecker symbol identity, and boolean literal elements can fold restricted
guards in the loop body. `for await`, dynamic operands, destructuring bindings,
and general expression substitution remain unsupported generator control flow.
The dashboard dogfood applies this across a real two-file TypeScript Program:
an imported replica generator loops over a readonly tuple and another imported
generator delegates to a finite child generator. Call-site network thenables
remain exact thenable slots across both inter-file boundaries.
Reassignment-free generator-local `const` bindings with identifier or primitive
literal initializers are substituted by symbol identity. A computed initializer
is also accepted when call-site substitution and the restricted expression
folder reduce it to a primitive literal; otherwise the generator remains
unsupported. This covers boolean guard aliases and directly yielded
value/thenable aliases, including fully concrete template strings, without
evaluating user code. Mutable bindings,
destructuring, unresolved computed expressions, and call initializers stay
outside the finite fragment. Nested lexical blocks are analyzed with a scoped
binding environment; generated yields survive the block while local aliases do
not leak into following statements or loop iterations.
Finite correlated generator spreads compose by Cartesian product with other
spreads and deterministic array prefix/suffix. The analyzer refuses the model
as dynamic when that product exceeds 32 paths; it never truncates the product
and reports the remainder as proved. Loops and conditions whose bodies leave
the restricted direct-yield/throw/return fragment remain dynamic.
The neutral IR distinguishes this boundary as `finite-path-limit` from the
ordinary `dynamic-cardinality` boundary, and Quint generation reports the
specific reason when it refuses an unbounded model. A recognized generator
whose loop, guard, or delegation is outside the accepted finite fragment uses
`unsupported-generator-control-flow`, separating an implementation boundary
from genuinely unknown iterable cardinality.
Each path is separately capped at 256 Promise-combinator elements. Wider static
arrays, Sets, conditional paths, and finite generators are reported as
`finite-element-limit` before Quint generation. This is a model/build budget,
not a JavaScript runtime restriction.
`Promise.any` retains path-dependent aggregate cardinality and emits concrete
rejection-reason constants under the same path index; one path is never
presented as representative of another.
Iterator failure confined to one branch uses that choice as a failure guard;
the other path retains its normal branch and join actions. A `throw` or `return`
also terminates that generator path, so suffix yields are not fabricated after
abrupt completion.
Acquisition or step failure rejects every Promise combinator, including
`allSettled`, before any yielded Promise reaction can settle the aggregate.
Sparse literal holes are retained as `undefined` value slots, matching array
iteration rather than being dropped.
Local tuples frozen at the TypeScript level with `as const` are also flattened
through `const` alias chains. A plain `const` array remains dynamic because
`const` does not make its elements immutable. Casts through `any` can still
violate TypeScript readonly guarantees and remain an explicit gradual-safety
escape hatch.
Direct construction of the builtin `Set` from one of these finite arrays is
also bounded. The projection preserves insertion order and removes only
duplicates whose identity is statically provable: repeated primitive literals
and repeated references to the same TypeScript symbol. It deliberately keeps
separate object literals and call expressions separate, because proving their
runtime identity would require a stronger alias analysis. Shadowed or imported
`Set` constructors and Sets received from mutable state remain dynamic and
retain `InvokeUserCode`. The same direct finite construction can be flattened
inside an array spread such as `[...new Set([a, a, b])]`; assigning the Set to
a variable first keeps it dynamic because later `.add`/`.delete` calls may
change its cardinality before iteration.
Direct conditional expressions are also bounded when both alternatives are
finite arrays. The IR retains the source alternatives for each slot and joins
differing value/thenable classifications to `unknown`, so both immediate
fulfillment and assimilation remain possible. Different lengths add one
correlated iterable-choice state and per-slot presence guards; absent slots do
not settle or participate in `race`, and join predicates treat them according
to the selected combinator. For `Promise.any`, the modeled
`AggregateError.errors` count is also derived from that selected branch rather
than from the maximum bounded slot count.

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
artifact. Path-indexed constants keep the same retention after a finite
conditional imported generator or custom-iterable expansion. Other rejection
reasons remain explicitly unknown.

Each literal element is classified as a plain value, a thenable, or unknown.
Plain values (including holes) can only fulfill. Thenables enter an explicit
assimilation state before fulfillment or rejection; `allSettled` does not count
that intermediate state as settled. Unknown unions retain both the immediate
value and thenable paths. Promise-chain analysis separately recognizes a
restricted set of direct throwing and hostile thenables, but that richer
thenable IR is not yet composed into each combinator branch. Custom iterators
outside the immutable finite-generator subset, non-array dynamic spread
cardinality, general rejection expressions, cancellation,
combinator result values, and branch effect interleavings remain unsupported.
Rejection is possible but not forced immediately without a fairness assumption.

For direct local object iterables, a throwing `next` getter is an iterator
acquisition failure. Throwing `done` or `value` getters on a directly returned
iterator-result object are step failures. Both reject the combinator before any
modeled branch settles; arbitrary/dynamic iterator implementations remain an
unknown boundary rather than being assigned an invented finite cardinality.
The combinator IR distinguishes `array`, `set`, `local`, and `dynamic` iterator
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

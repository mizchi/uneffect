# Async error and explicit resource safety

Uneffect analyzes ordinary TypeScript syntax; these checks require no new
annotation grammar.

## Promise rejection ownership

A Promise-valued expression statement must transfer responsibility for its
possible rejection to one of the following constructs:

```ts
await task()
return task()
task().catch(recover)
task().then(onValue, onError)
void task() // explicit, unchecked abandonment
```

A bare expression is an error:

```ts
task() // floating-promise
```

`await` connects rejection to the nearest enclosing `try` block that has a
`catch`. A synchronous `try/catch` around a non-awaited Promise call does not
catch its rejection and therefore does not discharge the diagnostic.

```ts
try {
  await task().then(transform) // rejection enters catch
} catch (error) {
  recover(error)
}

try {
  task() // still floating
} catch {}
```

Promise-valued variable declarations create a rejection-ownership obligation.
The analyzer follows symbol aliases and records observation by `await`,
`return`, `.catch`, or a `.then` rejection handler. Passing the Promise as an
argument transfers responsibility only when the resolved callee signature opts
in with a contract. Storing it in an object/array records an explicit escape.
A binding that reaches the end of the current function without any of those
events is a `floating-promise` error.

Deferred initialization creates the same obligation at the assignment point,
including aliases created by later assignment:

```ts
let delivery: Promise<void>
let alias: Promise<void>
delivery = sendBatch()
alias = delivery
await alias
```

The assignment expression is not separately reported as a bare floating
expression; its binding remains pending until every reachable activated path
observes or transfers it. A branch on which no Promise was assigned creates no
obligation, while an assigned-but-unobserved branch is diagnosed.

```ts
/* uneffect:
 * consumes_rejection 0
 */
declare function enqueue(job: Promise<void>): void

const job = startJob()
enqueue(job) // rejection ownership moves to enqueue
```

The payload is a comma-separated list of zero-based parameter indices. Calls
without this contract borrow their Promise arguments and therefore do not hide
an unresolved rejection obligation in the caller. The contract is read from
the declaration selected by TypeScript's resolved signature, rather than by
callee spelling. Non-integer and out-of-range indices are declaration errors;
duplicates collapse into the same ownership obligation.

Direct forwarding wrappers inherit the contract when their parameter is passed
to a consuming parameter:

```ts
function enqueueLater(job: Promise<void>) {
  enqueue(job)
}
```

Calls to `enqueueLater` transfer parameter zero as well. This inference is
symbol-based and cycle-safe, but does not yet describe conditional consumption
or propagate callback contracts through higher-order wrappers.

Promise-returning callbacks have a separate ownership boundary:

```ts
/* uneffect: consumes_callback_rejection 0 */
declare function schedule(task: () => Promise<void>): void

schedule(async () => work())       // accepted
[1, 2].forEach(async () => work()) // floating-callback-promise
```

Standard `Promise.then`, `catch`, and `finally` callbacks are recognized from
their TypeScript standard-library declarations because their returned thenables
are assimilated. User-defined APIs must declare which callback parameters own
returned rejections. Direct unconditional wrappers inherit callback ownership;
this also works for named async callback arguments. Conditional wrappers do not
inherit it, because consuming on only one path cannot satisfy a must-consume
obligation.

Thenable assimilation also resolves direct local factory calls when every
explicit return is an analyzable object-literal thenable. Getter failure and
first-call-wins settlement facts are retained at the receiving Promise. Mixed,
implicit, imported-call, or dynamically selected returns remain conservative
external user code rather than being reported as proven local behavior.
When a local `then` callback itself resolves another thenable, the model keeps
fulfillment, rejection, and pending outcomes rather than turning assimilation
into a dead state. This is currently conservative: it does not yet link the
inner thenable's exact terminal states by symbol identity.
For a direct standard `Proxy`, an object-literal `get` trap consisting solely
of a throw is recognized as a definite rejection during `then` lookup. Other
Proxy handlers remain dynamic because property tests, `Reflect.get`, target
forwarding, and arbitrary trap code can invoke user code or return any value.

`Promise.any` aggregate-reason artifacts preserve direct literal and
`new ErrorType(message)` inputs in iterable order. Immutable local `const`
aliases are followed by symbol identity; mutable, imported, or computed reasons
remain explicit `unknown` slots.

Event-loop callback composition resolves named functions, direct methods, and
literal computed methods such as `worker["run"]` by TypeChecker symbol identity.
Microtasks scheduled in those method bodies are enqueued only after their
parent task runs. Polymorphic receivers and dynamically selected property keys
remain unresolved callback boundaries.
Direct source callback factories are also followed when exactly one explicit
return resolves to a function expression, arrow, or known callback symbol.
The same works through an imported source declaration included in the analyzed
TypeScript Program. Factories with multiple possible returns and declaration-
only or otherwise opaque imported factories remain dynamic.

A direct external `AbortSignal` on `scheduler.postTask` is represented by an
explicit initially-live abstract state and a nondeterministic abort transition.
The transition cancels the pending task and is inherited by modeled
`scheduler.yield` continuations. This records that cancellation may happen; it
does not claim knowledge of the external signal's concrete initial state or
abort reason.

Signal factories are followed through local and imported source declarations
when they have exactly one explicit return. A returned
`AbortSignal.timeout(n)` is linked to the same abstract timer source used at a
direct call site, so `scheduler.postTask` cancellation is no longer degraded to
an external signal. Multi-return and declaration-only factories remain
dynamic.

The same source-factory subset supports static `AbortSignal.any([...])`.
External inputs and nested timeout sources keep distinct composition slots,
and a consuming scheduler task references the resulting composition rather
than an unrelated external-signal approximation. The call expression is
memoized by AST identity so analyzing both the factory and caller does not
duplicate its timer or composition state.

Factory parameters are substituted with concrete call arguments using checker
symbol identity. This preserves a pre-aborted argument as the first source and
initially cancels the consuming scheduler task. Source factories invoked as
signal producers are instantiated at their call sites rather than also emitted
as an unrelated generic timer/composition, and separate calls receive separate
abstract instances. Recursive and multi-return factories still stop at the
dynamic boundary.

The initial TaskSignal reprioritization slice follows the
[Prioritized Task Scheduling specification](https://wicg.github.io/scheduling-apis/):
a direct `TaskController` with a literal initial priority owns tasks receiving
its `.signal`, and later literal `setPriority` calls in the same synchronous
function become ordered Quint transitions that must finish before queued tasks
run. Queue selection compares the resulting dynamic priority with fixed tasks,
and an inline `scheduler.yield` inherits the final controller priority. An
explicit `postTask({ priority })` remains immutable and ignores signal priority,
as required by the platform semantics. Controller aliases, changes from later
callbacks, dynamic priority values, dependent TaskSignals, and reentrant
`prioritychange`/`NotAllowedError` behavior remain unsupported rather than
being treated as proofs.

Conditional APIs can expose the guard explicitly:

```ts
/* uneffect: consumes_rejection_when 1: enabled */
declare function maybeEnqueue(enabled: boolean, job: Promise<void>): void

maybeEnqueue(true, job)  // must-consume: ownership transfers
maybeEnqueue(false, job) // may-consume only: obligation remains
maybeEnqueue(flag, job)  // unproven: obligation remains
```

`consumes_callback_rejection_when` provides the corresponding callback form.
The current prover recognizes literal `true`, TypeScript control-flow narrowing
to the `true` literal type, and enclosing `requires enabled` or
`requires enabled === true` preconditions. A precondition is evidence only at a
checked Uneffect boundary; callers remain responsible for satisfying it.
Other symbolic guards are preserved conservatively for future Z3/Quint
discharge.

Guard expressions may use the shared boolean specification subset, including
`!`, `&&`, `||`, `===`, and `!==`. The synchronous frontend parses them into
the same logic IR used by the Z3 backend and decides small propositional
implications by exhaustive finite valuation. This keeps ordinary linting
deterministic and synchronous. Unresolved obligations still need explicit
Z3/Quint evidence before they can become must-consume.

Every guarded call is retained in `AsyncSafetyResult.ownershipObligations`, not
just the failures. An entry records the callee, ownership kind, parameter index,
instantiated assumptions and goal, source span, status, and evidence class.
`generateOwnershipObligationSmt` emits a refutation query (`unsat` proves the
transfer), while `generateOwnershipObligationQuint` emits the equivalent pure
implication for temporal composition. Generated text is not itself trusted
evidence; importing reproducible backend results is a separate step.

`verifyOwnershipObligationWithZ3` and
`verifyOwnershipObligationWithQuint` produce `ownership-evidence/v1`
artifacts. They bind the obligation hash, generated verifier-program hash,
backend version, exit code, stdout, and stderr. `validateOwnershipEvidence`
accepts only a successful proof whose hashes still match; counterexamples,
unknown results, tool failures, and modified artifacts remain non-proof. Quint
verification requires the Java runtime used by TLC/Apalache; its absence is
recorded as unknown rather than silently falling back to randomized execution.

The optimizer consumes this evidence only through
`ownership-guard-elision/v1`. It may remove a generated
`uneffectAssertOwnership(...)` runtime assertion after a matching proof, but it
cannot rewrite user-authored Promise control flow. Stronger compression needs
separate semantic obligations for handler reachability, scheduling, and cleanup.

The initial runtime path supports direct call statements:

```ts
uneffectAssertOwnership(enabled && active, "run:120:2")
consumeWhenActive(enabled, active, pending)
```

The assertion remains in gradual/runtime-checked builds. A matching Z3/Quint
artifact lets a verified build remove the generated assertion and, once unused,
its helper. The `consumeWhenActive` call itself is never removed by this proof.

`buildVerifiedOwnership` composes analysis, instrumentation, Z3 execution, and
safe elision. `uneffect-instrument --verify-ownership file.ts` exposes the same
pipeline; `--ownership` stops before verification for runtime-checked builds.

`void` is an explicit escape hatch, not proof that rejection is operationally
handled. It is accepted by default for incremental adoption and can be rejected
independently:

```ts
analyzeAsyncSafety(fileName, source, { allowVoid: false })
```

The binding analysis uses a deliberately restricted path-sensitive pass. An
observation must occur on every `if`/`else` path. `switch` starts from every
reachable case, preserves fallthrough, stops at direct `break`, and recognizes
finite literal-union exhaustiveness. `try` and `catch` are alternative paths,
while `finally` runs for normal and abrupt completion, including early return.
`while` and `for` loops retain their zero-iteration path, while `do` loops
execute their body at least once. Loop bodies are iterated to a finite abstract
state closure. Unlabeled and labeled `break`/`continue` propagate through nested
blocks and loops, so statements skipped by an abrupt edge cannot falsely count
as Promise observations. Reassigning an unresolved Promise records the
previous ownership obligation as lost, even when the replacement value is later
awaited. Initial assignment to an uninitialized `let` is activation rather than
reassignment; assigning the same Promise to another local creates an alias and
does not lose ownership.

This is not yet a general TypeScript control-flow graph. Value-sensitive loop
feasibility, throws proven impossible before a catch, and arbitrary graph joins
outside the structured abstract interpreter still need a node-level CFG
analysis. The telemetry delivery dogfood
fixture exercises exhaustive delivery modes and shutdown cleanup; removing the
best-effort rejection handler is diagnosed. Higher-order and conditional
ownership contracts remain conservative outside the documented forms.

## Explicit resource management

`using` and `await using` are recognized from TypeScript AST flags:

```ts
async function work() {
  using file = openFile()
  await using session = await openSession()
  await use(session)
}
```

Resources are disposed at their lexical block boundary in reverse acquisition
order on normal completion, return, synchronous throw, and rejected
asynchronous exit. `using` requires a
`Symbol.dispose` protocol. `await using` accepts `Symbol.asyncDispose` or the
synchronous fallback.

Implicit disposal is also an effectful call edge. Effects declared or inferred
for the selected disposal method propagate to the function containing the
`using` declaration:

```ts
class Resource {
  /* uneffect: effect Console */
  [Symbol.dispose]() {
    console.log("disposed")
  }
}

/* uneffect: effect Console */
function work() {
  using resource = new Resource()
}
```

Removing `Console` from `work` is therefore a missing-effect error; declaring
it is not reported as unused.

The Quint projection represents asynchronous disposal as two transitions:

```text
dispose_start -> suspended disposal -> dispose_resume
```

Positive models complete every acquired resource in reverse order. Negative
controls skip disposal, dispose twice, violate reverse order, or advance
without awaiting asynchronous disposal. Quint reports every violation.

Every acquisition also has a failure transition. A failed initializer never
marks that resource acquired, enters cleanup, and disposes only resources whose
earlier initializers succeeded. Disposal failure changes the abstract
completion state as follows:

```text
Normal + disposal failure       -> DisposalError
PriorError + disposal failure   -> SuppressedError
SuppressedError + later failure -> SuppressedError (nested abstraction)
```

The analysis IR also retains the exact recursive payload when error types are
available from `Throw<E>` or `temporal_rejects E` disposal contracts:

```ts
type ResourceError =
  | { kind: "error"; errorType: string; source: string }
  | {
      kind: "suppressed"
      error: ResourceError
      suppressed: ResourceError
    }
```

If the body fails with `PrimaryError`, then `second` fails with `SecondError`,
then `first` fails with `FirstError`, the result is equivalent to:

```ts
new SuppressedError(
  new FirstError(),
  new SuppressedError(new SecondError(), new PrimaryError()),
)
```

Synchronous disposal failure is a throw; asynchronous disposal failure is a
rejection after `dispose_start`. A broken control that overwrites the prior
error instead of preserving it as suppressed is rejected by the invariant.

Disposal runs while leaving the resource's lexical scope. A failure inside a
protected `try` region therefore enters its `catch`, including an asynchronous
disposal rejection:

```ts
async function handled() {
  try {
    await using resource = await open()
  } catch (error) {
    // also receives failure from resource[Symbol.asyncDispose]()
  }
}
```

Without an enclosing catch, synchronous cleanup escapes as a throw from a
synchronous function, while cleanup in an async function rejects its returned
Promise. The IR records this as `catchesFailure` and `escapingFailure`.

## Unified async control edges

Awaited expressions are matched to analyzed Promise chains by owner and source
span. The async-safety IR then emits explicit edges across the previously
separate projections:

```text
promise:N:fulfilled -> await:resume
promise:N:rejected  -> catch | function:rejected
return/throw/reject -> dispose:resource
dispose:resource:rejected -> catch | function:rejected
```

For example, a returned awaited chain inside `try/catch`, followed by a
function-scoped `await using`, connects chain rejection to the catch while a
later async-disposal rejection settles the async function's returned Promise
as rejected. `promiseChains` and `controlEdges` are both retained in the public
analysis result so a backend can generate one transition system.

The initial unified Quint lowering selects one function and composes resource
acquisition, awaited Promise terminal outcomes, catch recovery, return-driven
cleanup, synchronous/asynchronous disposal, and the returned async function's
final fulfillment or rejection:

```sh
just spec-unified-async examples/composed-async.ts run
```

Promise reaction internals remain checked by the detailed Promise-chain model;
the unified module consumes its abstract fulfilled/rejected terminal boundary.
A negative lowering can finish without cleanup, and the shared resource safety
invariant rejects that execution.

`controlRegions` gives every `try` statement a stable source-derived identity
and retains its protected, catch, finally, and complete source spans.
`controlStatements` links each concrete catch and finally statement to that
identity while preserving source span and lexical order. The unified lowering
emits one transition per statement: rejection selects the innermost containing
try region instead of a function-wide catch, and both normal and recovered
paths traverse that region's finally sequence before resource cleanup. This
separates sequential and nested handlers without pretending that arbitrary
statement bodies have already been semantically interpreted.

Sequential awaited chains receive separate wait and resume states in source
order. A fulfilled chain advances only to the next await; only the final
fulfilled chain may enter finally/cleanup. Rejection still follows the
chain-local caught-or-escaping classification. This is a straight-line model:
awaits selected by branches or loops do not yet have CFG-derived join states.
When a nested lexical scope ends between two such awaits, its disposal gets an
explicit scope-exit transition before the following await. The final failure
cleanup remains idempotent, so an already disposed resource is skipped while a
rejection before that scope exit still disposes it. Resources in scopes with no
modeled await are also released before the first later await. Resource
acquisition interleaved after an await is ordered in the same linear sequence.
A disposal failure covered by the surrounding try region enters the retained
catch statement sequence. Without a finally region, catch completion resumes
the first later straight-line await. A top-level `return` or `throw` statement
in catch/finally records an abrupt completion and bypasses unreachable handler
statements and later awaits. A top-level handler statement containing one
analyzed awaited chain receives dedicated terminal and resume states; multiple
analyzed awaits in the same top-level statement are sequenced left-to-right. Catch
await rejection preserves an enclosing finally edge before escaping; normal
finally completion resumes the first following outer await. Abrupt completion
nested inside handler branches and general handler joins still require the
statement-level CFG. Awaited chains in a top-level handler `if` share the same
condition identity and use correlated then/else skip transitions. Top-level rethrows and a
single analyzed awaited handler failure do propagate to the nearest enclosing
catch, including through a normally completing inner finally region.

The straight-line lowering orders resource acquisition, awaited-chain
boundaries, and early lexical disposal in one source-position event sequence.
Consequently a resource declared between two awaits is neither acquired before
the first await nor delayed until after the second. An acquisition nested in a
conditional or zero-iteration loop, and an await in the same regions, receive
explicit optional transitions. Operations under the same `if` share a stable
control-condition identity; Quint chooses its boolean value once, and then/else
operations require opposite polarity. Nested `if` operations carry the ordered
conjunction of enclosing choices. Zero-iteration loops and other conditional
constructs still use independent conservative may choices, so general
path-sensitive joins remain outside this lowering.

```sh
just spec-resource-quint examples/resources.ts
```

## Current boundary

Protocol detection resolves computed properties back to the standard
`SymbolConstructor.dispose` and `SymbolConstructor.asyncDispose` declaration
symbols. Same-spelled or shadowed computed keys receive no disposal semantics;
typed aliases, inherited interfaces, intersections, and generic constraints
retain the standard identity. Encoding the same identity in the Corsa schema
is still pending. The
projection records lexical scope endpoints, partial initialization, disposal
failure, and an abstract `SuppressedError` completion. Implicit cleanup
capability effects propagate through the selected disposal method. Exact
recursive `SuppressedError` payloads are retained in the analysis IR, while the
Quint projection still uses an abstract completion state. The model records
all exit kinds conservatively. Unified control edges connect Promise chains,
await/catch, scope exits, and disposal failures. The initial single-function
Quint lowering, region-identified catch/finally statement ordering,
straight-line multiple-await sequencing, and innermost catch selection for
sequential/nested try regions are implemented. General control-flow joins and
branch-nested abrupt propagation across handlers remain outside this slice.

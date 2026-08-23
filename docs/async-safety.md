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
first-call-wins settlement facts are retained at the receiving Promise. Direct
conditional choices and an `as const` tuple selected by a reassignment-free
literal `const` index preserve their exact local thenable identities. Mutable
arrays, mixed or implicit returns, imported calls, and other computed selections
remain conservative external user code rather than being reported as proven
local behavior.
When a local `then` callback itself resolves another thenable, the model keeps
fulfillment, rejection, and pending outcomes rather than turning assimilation
into a dead state. Resolved local and external symbols, including forward local
references and direct inline thenable literals, link their terminal states by
identity. Cycles through unresolved selections and general computed forwarding
remain conservative.
Promise constructors used directly as a `then`, `catch`, or `finally` receiver
retain the same executor identity and assimilation transitions as an
intermediate `const` binding.

Exact self and mutual cycles in the linked local thenable graph remain in the
assimilating state with no fabricated fulfillment or rejection transition.
This covers the common broken-legacy-adapter shape where each `then` callback
resolves to the next adapter. Cycles through computed properties, mutable
containers, or opaque imported code remain dynamic rather than exact.
For a direct standard `Proxy`, an object-literal `get` trap consisting solely
of a throw is recognized as a definite rejection during `then` lookup. Other
Proxy handlers remain dynamic because property tests, `Reflect.get`, target
forwarding, and arbitrary trap code can invoke user code or return any value.
The exact forwarding forms `if (property === "then") return callback; return
fallback` and `return property === "then" ? callback : fallback` select the
concrete callback because Promise assimilation requests that literal property.
The selected callback may pass through cycle-safe direct function declarations
or immutable `const` identity wrappers whose single definite return forwards an
identifier parameter. Resolution uses parameter symbols rather than names.
Reassigned callees, defaults, rest/destructured parameters, non-definite return
flows, selectors for other properties, and compound selector conditions remain
dynamic.
Identity-wrapper returns may also use a conditional expression selected by a
substituted or immutable boolean literal (including unary `!`). A dynamic
callback selector is not merged as exact behavior and remains conservative.
Proxy property guards may combine the known `property === "then"` lookup with
immutable boolean aliases, unary `!`, and boolean-only `&&`/`||`; evaluation is
left-to-right and short-circuiting. Coercive equality, general truthiness, or a
reached dynamic operand leaves the trap dynamic.
Callback wrappers may select a return through a static primitive `switch`.
Case labels are evaluated in source order, default is used only after no match,
and empty clauses fall through. Dynamic labels/discriminants, `break`, nested
statements, and other abrupt control remain conservative. Resource Proxy
factories and Promise Proxy traps use the same finite primitive evaluator, so
their literal, strict-equality, negation, and boolean short-circuit semantics do
not drift independently.
The callback-wrapper return analysis also follows nested blocks and statically
selected `if`/`else`, including the common `if (enabled) return yes; return no`
shape. A dynamic condition, return without a value, or unsupported statement
invalidates the exact proof rather than being treated as ordinary fallthrough.
The same walker accepts declaration-ordered local `const` selectors whose
initializers contain only identifiers, literals, function values, conditional
expressions, negation, strict equality, and boolean short-circuit operators.
Calls, construction, property access, `await`, mutable bindings, and
destructuring are not assumed pure; encountering one keeps the Proxy behavior
dynamic.

`Promise.any` aggregate-reason artifacts preserve direct literal and
`new ErrorType(message)` inputs in iterable order. Immutable local `const`
aliases are followed by symbol identity; mutable, imported, or computed reasons
remain explicit `unknown` slots.

Event-loop callback composition resolves named functions, direct methods, and
literal computed methods such as `worker["run"]` by TypeChecker symbol identity.
Microtasks scheduled in those method bodies are enqueued only after their
parent task runs. Polymorphic receivers and dynamically selected property keys
remain unresolved callback boundaries.
Direct source callback factories are also followed when every path definitely
returns a function expression, arrow, or known callback symbol. Their parameter
symbols are specialized from call arguments for finite callback forwarding.
The same works through an imported source declaration included in the analyzed
TypeScript Program. Fallthrough, unresolved return candidates, cycles, and
declaration-only or otherwise opaque imported factories remain dynamic.

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
statement-level CFG. `completionPaths` retains path-conditioned `return` and
`throw` outcomes for handler `if` branches. Awaited chains in those branches
share the same condition identity, use correlated then/else skip transitions,
and apply abrupt completion only on the selected path. Top-level rethrows and a
single analyzed awaited handler failure do propagate to the nearest enclosing
catch, including through a normally completing inner finally region.
Handler `switch` cases use an ordered boolean decision chain: a selected case
requires earlier cases not to match, while default requires every case not to
match. Top-level fallthrough and unlabeled break contribute the corresponding
completion paths. An awaited operation reached both by direct case entry and
by fallthrough carries `controlPaths`, an OR of condition conjunctions. The
legacy-compatible `controlConditions` field is the first path. Unified Quint
lowering guards the operation by their disjunction and Corsa schema v6
validates every path plus the primary-path correspondence.
Zero-iteration `while`, `for`, `for..in`, and `for..of` handler bodies share a
stable loop-entry choice. The one-step abstraction retains a skipped path and
normalizes body `break`/`continue` to normal loop completion; `while (true)`
omits the skipped path and `do..while` executes once.
Awaited handler loops additionally receive explicit repeat and exit states, so
the control graph covers arbitrary finite repetition of their awaited chains.
Lexical `using` and `await using` declarations in those loops are handler
events: each abstract iteration acquires the resource and completes disposal
before repeat or exit. Each acquisition increments an abstract generation and
disposal records the generation it completed; terminal resource safety requires
the disposed generation to equal the latest acquired generation. This prevents
an earlier iteration's cleanup bit from authorizing a later resource instance.
The `reuseStaleDisposal` negative lowering deliberately retains the prior
iteration's disposal state and skips cleanup on a generation mismatch; Quint
rejects the resulting terminal execution.
It proves cleanup ordering when the resource cannot escape its lexical
iteration. This is not a data-state fixed point: loop-carried values and
escaping aliases that retain an older generation remain outside the unified
lowering. The separate `resourceAliases` evidence now preserves the matching
acquisition index, whether the acquisition site repeats, and a stable symbolic
snapshot such as `generation_0@412`. This identifies which abstract generation
must eventually be connected to alias-state lowering; it does not yet prove
relations between snapshots from different iterations. Unified Quint now emits
`alias_generation_N`, capture, and use events for every reported escape. A use
whose captured generation equals the resource's disposed generation marks the
model broken, and lexical disposal is placed before a known post-scope use.
Repeated alias acquisitions add nondeterministic repeat/exit states after
disposal; repeat returns to acquisition, increments the resource generation,
and overwrites the alias snapshot. A skipped acquisition also skips capture, so
zero iterations do not deadlock. Multiple interacting aliases, nested normal
loops, and relations among separately retained snapshots remain unsupported.

The TypeChecker frontend separately recognizes source-ordered assignments from
a `using`/`await using` binding through local symbol alias chains. If an alias is read
after the resource's lexical scope ends, it emits `disposed-resource-use` and
retains the resource/alias assignment and use spans in `resourceAliases`.
An unconditional direct reassignment before the later read kills this alias
fact. A single conditional reassignment is conservatively not a must-kill, but
an exhaustive `if`/`else` whose terminal statement on both sides assigns a
value proven to be only `null | undefined` is joined as a definite clear. This
restricted join also accepts nested exhaustive terminal branches; it does not
claim arbitrary control-flow equivalence. A `switch` joins under the analogous
restricted rule only when it has a `default`, every clause owns a terminal
nullish clear, and no earlier statement can complete abruptly. An empty grouped
case label inherits the following clause's mandatory clear, matching common
`case A: case B: clear()` release code. Non-empty fallthrough and default-free
switches over open types remain conservative. A default-free switch is accepted
when the TypeChecker proves its discriminant is a finite string, number, or
boolean literal union and the case literals cover the entire union. Enum and
computed case domains are not treated as exhaustiveness evidence. The same
join accepts a clause that terminates in `return`, because it cannot reach an
alias use after the switch. A terminal exhaustive `if`/`else` may mix returns
and mandatory clears, either as a switch clause or as a standalone statement;
this applies equally to direct aliases and static aggregate slots. `throw`,
`break`, `continue`, and earlier conditional
abrupt completion remain conservative in this alias-flow subset. The same
flow recognizes loop-local resource aliases that are terminally cleared on
every executed iteration. Zero-iteration `for` and `while` paths retain their
entry state, while `do...while` applies its mandatory first iteration. A
The restricted path summary accepts `break` and `continue` only after the
target is cleared, treats `return` as unable to reach the post-loop use, and
rejects `throw` conservatively. Reassigning the target after a clear resets the
proof. Nested loops, switches, try/finally, and general loop invariants remain
unsupported by this join. Escapes that are still
reported retain a symbolic acquisition-generation snapshot. Unified Quint
lowering increments that generation on every modeled acquisition, captures it
for each alias, and compares it with the generation recorded by lexical
disposal. Repeated acquisitions share one repeat/exit decision per acquisition,
even when several aliases capture the same resource generation; their capture
and post-scope use evidence remains independent. Source-ordered nested
acquisition loops retain distinct generations and repeat targets; the generated
model is checked deeply enough to reach both asynchronous scope exits and the
first post-loop alias use. Generated alias identities are ordered by their
assignment spans, so reordering post-scope uses does not churn Quint action or
state names. General CFG joins between interacting loops and alias
relations that retain older generations separately are still outside this
finite lowering.

Alias-generation evidence classifies each capture as `single`, `latest`, or
`conditional`. `latest` means an unconditional assignment relative to its
repeated acquisition. A branch introduced below the acquisition produces
`conditional`; unified Quint then offers both capture and skip transitions for
that alias. This prevents an optional assignment from becoming a mandatory
snapshot. Relative control paths retain their condition identity and polarity,
so aliases assigned by opposite arms of the same `if` share one Quint branch
choice and cannot both capture in one modeled iteration. Finite switch entries
reuse the ordered case-decision paths, including explicit fallthrough. A
restricted top-level `try` sequence marks assignments after a preceding call,
construction, `await`, or explicit throw as the successful continuation and
correlates them with the catch path through the opposite completion polarity.
Assignments before the first such risky statement remain unconditional. Nested
restricted tries compose their completion identities. Direct property access,
literal computed access, exact const key aliases, and finite string/number
literal-union keys are also risky when the TypeChecker resolves at least one
candidate property symbol to a concrete getter declaration. Interface-only
properties and open key domains remain unknown. Property access through a
direct standard `new Proxy(...)` receiver, including a cycle-safe chain of
immutable local `const` aliases, is conservatively treated as a preceding
throw risk because its `get` trap can invoke user code. The same proof follows
a cycle-safe chain of TypeChecker-resolved functions whose identifier
parameters can be substituted from supplied arguments or supported defaults,
including immutable arrow wrappers, imports, and re-exports. A restricted
definite-return walk accepts nested
blocks and `if`/`else` when every normal return expression recursively resolves
to a Proxy; terminal throws do not create a non-Proxy receiver. Fallthrough,
mixed return values, loops, `try`, mutable aliases,
methods and dynamic dispatch, coercions, finally-dependent joins, and cross-loop
alias-generation correlations still require broader effect/CFG evidence and
are not claimed as proved. For ordinary function and arrow calls, supplied
arguments are substituted by parameter symbol through nested factory chains,
including imports and re-exports. This handles identity/forwarding helpers
without trusting parameter names. Missing arguments without a supported
default, rest or destructured parameters, non-boolean default-dependent flows,
and mutation of parameter-derived values remain unknown.

Within this restricted factory CFG, a substituted boolean literal can select an
`if` branch before return provenance is joined. Immutable boolean aliases,
parentheses/assertions, unary `!`, and omitted parameters with boolean literal
defaults are folded. This permits a literal-enabled selector to return its
Proxy argument even when the unreachable branch returns an ordinary object.
Dynamic booleans still require both branches. Boolean-only `&&` and `||`
predicates are evaluated left to right with JavaScript short-circuit ordering,
so a decisive left operand does not require the right operand to be static.
Both reached operands must resolve to booleans: general JavaScript truthiness,
dynamic residual operands, explicit `undefined` defaulting, and mutable
condition sources are not specialized.

The same static predicate evaluator selects one branch of a conditional
expression before Proxy provenance is joined. If its condition remains
dynamic, both expression branches must independently resolve to Proxy values;
a mixed Proxy/plain ternary remains unknown.

Strict equality and inequality are folded when both operands resolve to finite
string, number, or boolean literals through the same immutable/substitution
rules. Operand order is irrelevant. Coercive `==`/`!=`, relational comparisons,
template interpolation, symbols, bigint, and object identity are deliberately
not evaluated. This supports mode/status selectors without importing general
JavaScript evaluation into the verifier.

A `switch` over the same finite primitive domain is supported when the
discriminant and every case label evaluated before selection are static. Case
labels are checked in source order; a matching case stops label evaluation,
while `default` is chosen only after no case matches. Return flow then proceeds
from the selected entry through ordinary fallthrough. A top-level unlabeled
`break` exits the switch without proving a return. Dynamic discriminants or
encountered dynamic labels, labeled breaks, and nested abrupt control remain
unknown.

The same
source-ordered flow covers nested property and literal array slots on a local
identifier root, such as `state.retry.current` or `slots[0]`, and can propagate
that slot back into a local alias. Reassignment-free local aliases of the
aggregate root share the same canonical slot identity; an unconditional root
alias reassignment detaches it, and overwriting a parent slot invalidates all
known descendant facts. Exhaustive terminal nullish clears join for these
static slots too, including a parent slot that clears known descendants.
Assignments in a `try` body or `catch` clause are not must-kills: execution may
leave the `try` before the assignment, or may never enter the `catch`. A clear
in `finally` remains unconditional because every completion that continues
past the statement executes it. Abrupt completion from `finally` is outside
this source-ordered alias subset.
Computed string and finite-number keys are resolved
through reassignment-free `const` alias chains, including `as const`,
parenthesized, `satisfies`, and non-null wrappers. The Program frontend follows
named import aliases, barrel re-exports, and namespace imports to an exported
`const` declaration; the single-text convenience frontend cannot resolve such
imports. Mutable and otherwise dynamic computed keys remain unknown. Mutation
through imported or interprocedural aggregate aliases, aliases passed through
calls, and path-correlated alias joins are not yet claimed as covered.

Returning a `using` or `await using` resource is a distinct boundary error:
explicit resource management disposes it while completing the function, before
the caller receives the return value. The frontend records direct, local-alias,
object-property/shorthand, spread, conditional, and array return escapes in
`resourceEscapes` and emits `disposed-resource-escape`. It also scans a directly
returned function or a reassignment-free local `const` callback initializer for
captured resource symbols, including callbacks wrapped in returned objects or
arrays, and records `via: "returned-closure"`. Returning unrelated data after
using the resource, or invoking a callback only within the resource scope,
remains valid. A callee can declare `retains_resource` with zero-based parameter
indices. Passing a resource or resolved local alias at that call records
`via: "retaining-call"`; direct wrappers inherit retention when they forward a
parameter, including through local `const` aliases, to another retaining
boundary. Annotated constructors record `via: "retaining-construction"`, and
factory wrappers inherit that parameter summary. Unknown unannotated calls and
constructors remain unchecked to preserve gradual adoption. Retention through
mutable local bindings inside the wrapper, mutable callback selection,
unannotated container construction, and externally implemented unannotated
callees are not yet claimed as escape proofs.

`retains_resource_when 0: enabled` provides guarded retention for feature-flag
and optional-registration APIs. Because a possible retained reference is
already unsafe across lexical disposal, `true` and unknown guards report an
escape; only a guard proved false by literal/type facts or an enclosing
`requires` precondition is discharged. Conditional declarations are evaluated
per call and deliberately excluded from the unconditional signature cache.
For direct wrappers, literal/type facts and caller preconditions are renamed to
the wrapper's boolean parameters and propagated into nested retention calls.
Reassignment-free local `const` aliases of those boolean parameters are
resolved by symbol identity. Calls without such facts retain the conservative
may-retain summary; mutable guard aliases remain unresolved.
Labeled `break` and `continue` retain their target while
crossing nested loops; only their owning labeled loop discharges them to the
one-step loop continuation.

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

# Resource protocol IR

Uneffect uses `uneffect-resource-protocol/v1` as a backend-neutral ownership
contract. It separates two concerns:

1. a TypeScript frontend lowers reviewed, symbol-identified operations into
   ordered resource transitions;
2. a domain-independent evaluator checks those transitions and required
   terminal states.

The IR is not tied to `Response` or Web Streams. A resource has a stable `id`,
a display-only `label`, a `kind`, an initial state, and optional acceptable
terminal states. The common transition vocabulary is:

```text
Acquire(resource)
Use(resource)
Consume(resource)
Release(resource)
Transfer(resource, target?)
Split(resource, targets)
Join(resources, target)
Escape(resource)
Invalidate(resource)
```

The evaluator accepts only valid state transitions. A conditional or
unknown-evidence transition is joined with the path that did not take it; when
the states differ, the result is `unknown`. An invalid transition also emits a
diagnostic and makes the affected obligation unknown. Missing required terminal
states are `unsatisfied`, not silently accepted.

## Control-flow evaluation

`uneffect-resource-protocol-cfg/v1` places transition lists in named basic
blocks with explicit successors, entry, exits, and a proof budget. It reuses the
shared monotone fixed-point engine. Each block transfers the complete resource
state map. At a control-flow join, equal states remain exact and unequal states
become `unknown`.

This supports a backend-neutral representation of:

- both arms consuming or releasing the same resource;
- partial consumption in only one arm, which becomes unknown;
- normal and exceptional predecessors entering one mandatory `finally` block;
- bounded fixed-point evaluation for future loop lowering.

The CFG API does not claim to be TypeScript's private compiler CFG. The
public-AST lowering handles blocks, sequential statements, `if`/`else`, direct
`return`/`throw`, loops, switch fallthrough and break, labeled break/continue,
opaque nested declarations, and try/catch/finally. Transition recognition
remains in the reviewed frontend.

Expression statements preserve short-circuit `&&`, `||`, and `??`, conditional
expressions, and optional calls as explicit CFG choices. A transition present
on only one executable expression path therefore joins to `unknown`; matching
transitions in both conditional arms remain provable. Parenthesized, asserted,
awaited, and `void`-wrapped forms retain this behavior. Conditional calls nested
inside other unsupported expression shapes fail closed instead of being
flattened into unconditional cleanup.

Loops are nondeterministic zero-or-more resource-state paths; this proves
neither termination nor fairness. Switch selection is conservatively branched
across clauses while preserving fallthrough. Nested declarations do not execute
with their enclosing owner and require separate analysis. Handler edges include
explicit `throw`; implicit exceptions and Promise rejection require separate
throw/rejection evidence and are not inferred from arbitrary calls.

An authenticated transition site may carry `exceptionalCompletion: "throw"`.
The lowering adds its exceptional successor to the active catch/finally
continuation independently of resource transitions. Supplied same-Program
callable summaries with `trusted` or `verified` evidence are resolved by
TypeChecker declaration identity: `Throw` creates a synchronous exceptional
edge and a directly awaited `Reject` creates an awaited exceptional edge. Each
site retains summary, declaration, and call-site provenance. Unknown calls,
same-named shadow functions, floating rejected Promises, and unauthenticated
persisted/external summaries do not manufacture this edge.

Transferable ownership sites now use this same CFG lowerer and fixed-point
evaluator. A use invalid on every path is a definite diagnostic, while a use
invalid on only some paths is reported with state `unknown`. Both arms
transferring the same resource therefore remain definite; a one-arm transfer
is not flattened into an unconditional transition. The older finite lexical
path evaluator remains only as a fail-closed fallback when CFG lowering is not
available.

Events inside `for`, `for...in`, `for...of`, and `while` bodies are treated as
zero-or-many. A post-loop use joins the zero-iteration and executed paths to
`unknown`. A `do...while` body is modeled as one-or-many, so its first transfer
definitely invalidates the resource. A transfer in any repeatable body also emits an explicit
possible repeated-transfer diagnostic. This prevents a loop from being
silently flattened to one unconditional iteration. Exact statically bounded
iteration counts are not yet used to upgrade this result.

`switch` is lowered as one finite multi-way choice rather than independent
booleans. Case selection, fallthrough, direct `break`, absence of `default`,
and lexically targeted conditional breaks participate in the path join. A
transfer in only some selections is therefore `unknown`; transfers covering
every selection make a later use definitely invalid. Dynamic case-value
feasibility is not proved, so all clauses remain possible selections.

Explicit `throw` routes ownership state to the matching `catch`, and mandatory
`finally` blocks run on normal, return, throw, break, and continue exits through
the shared lowerer. Authenticated callable `Throw` and directly awaited
`Reject` summaries add may-throw edges by declaration identity, so catch-side
ownership changes join with normal completion. The identity survives immutable
`const` callable aliases and own properties of an authenticated
`Object.freeze({...})` table. Reassigned aliases, mutable property tables,
arbitrary calls, and same-named calls do not manufacture exceptional edges.

## Callable resource boundaries

`uneffect-resource-callable-summary/v1` is the backend-neutral function-boundary
contract. It refers to resources by parameter index or return position and
supports `acquire`, `use`, `borrow`, `consume`, `release`, `transfer`, and
`escape`. Instantiation substitutes the caller's stable resource identities,
introduces resource declarations for acquired returns, and lowers the operations
to the shared lifecycle transitions. Verified summaries emit
exact evidence; reviewed external summaries retain trusted evidence.

Missing argument or return identities produce an explicit `unknown` result and
a list of unresolved references. The API does not infer the contract from a
function name or accept an executable plugin predicate as proof.

Direct exported functions may distribute these operations in
`uneffect-contract-summary/v1`. The producer records the lifecycle payload as
`trusted`, not verified: parsing an annotation does not prove its implementation.
The consumer authenticates the package name, exact installed version,
TypeScript version, declaration bytes, export symbol, and signature before
rebinding operations to the installed declaration identity. Unmatched,
ambiguous, stale, or tampered summaries do not contribute lifecycle evidence.

The first TypeScript frontend accepts declarations such as:

```ts
/* uneffect:temporal
  borrow input
  consume body
  transfer port -> return
  escape callback
*/
function boundary(input: Input, body: Body, port: MessagePort, callback: object) {
  return port
}
```

These comments are trusted declarations, not implementation proofs. Direct
same-Program calls are matched by TypeChecker declaration identity, so renaming
and immutable import aliases remain identity-based and a same-named shadow does
not inherit the contract. Arguments and a direct `const result = boundary(...)`
return are substituted into transition sites. Synchronous acquisition results
also receive source-stable temporary identities, so `open().close()`,
`release(open())`, and an unbound leaking `open()` preserve JavaScript nested
call evaluation order. For optional fluent calls such as `open()?.close()`, the
receiver acquisition runs before the optional branch and the conditional
release joins to `unknown`. A direct `return open()` adds an `escape` after
acquisition. `return await openAsync()` puts both acquisition and escape on the
fulfillment edge; rejection leaves the resource absent. The lattice records
this as `absent-or-escaped`, which is a valid terminal state only when `escaped`
is permitted. A returned immutable `const` alias chain is also normalized to
the acquired region for both synchronous and directly awaited acquisitions.
The alias-bound report describes the resource only after successful
acquisition, so its terminal state is `escaped`; Promise rejection still does
not create a live resource. A conditional return is accepted only when both
branches resolve to the same acquired region. Mutable aliases, destructured
aliases, and conditionals selecting different resources remain outside this
fragment. A shallow static property or tuple-index return from a local `const`
object/array is also accepted when the stored value resolves to one acquired
region and the container has no other use. Container mutation, reassignment,
passing the container elsewhere, dynamic keys, spreads, and nested slots remain
fail-closed. Flat `const` object/tuple destructuring from a direct literal also
preserves the stored resource identity, including renamed object bindings and
object shorthand. Mutable bindings, defaults, rest elements, computed names,
and non-literal destructuring sources are not admitted.
Equivalent optional terminal states exist for consume, release, and transfer.
Malformed parameter names,
missing return bindings, dynamic calls, and unsupported resource expressions
produce diagnostics or remain outside the fragment. Ambient function and method
signatures are accepted when their `.d.ts` overlay is an explicit TypeScript
Program root. A declaration file reached only transitively through an import is
not trusted automatically. Package summaries still require the explicit
authenticated artifact path described below.

Explicitly supplied package contracts can now use
`uneffect-resource-callable-artifact/v1`. Authentication requires the exact
module/export, package version or Node major, full declaration-file SHA-256,
artifact payload SHA-256, and non-empty trust owner/reason. Invalid or expired
review dates block the artifact. Accepted summaries are rebound to the actual
TypeChecker declaration identity, enabling the same call-site lowering used for
local declarations. External artifacts are always `trusted`; a payload that
self-asserts `verified` is rejected. `checkFiles` and `verifyUneffectProject`
accept `resourceCallableArtifacts` plus an optional deterministic
`resourceArtifactAsOf` date. They discover matching exports from module
specifiers in the checked TypeScript Program, verify the installed package or
Node version and declaration bytes, rebind accepted summaries, and append a
source-scoped assumption entry for every matching call. Invalid supplied
artifacts produce an `invalid-contract` diagnostic. CLI/config-file discovery
is not implemented yet.

`resourceCallableArtifactAssumption` remains available to integrations that
authenticate artifacts outside the standard project check. Every entry retains
dependency version, owner, reason, expiry, and source scope.

## Explicit Resource Management

The first `using`/`await using` projection lowers a successfully acquired
owner's disposal suffix into the common resource lifecycle: every binding is
acquired, then released in the reverse order supplied by the TypeScript async
safety analysis. The projection separately retains whether disposal runs inline
or in a microtask, whether failure throws or rejects, whether it is caught, and
which completion exits trigger cleanup.

Initializer failure is represented as prefix acquisition: failure at binding
`i` skips later acquisitions and starts reverse cleanup, releasing only the
already acquired prefix. This removes the former
`all-listed-resources-acquired` precondition. A bounded non-loop conditional acquisition preserves
`absent-or-available` and reaches `absent-or-released`: the generated host
product chooses acquire-or-skip, and skips disposal only on the unacquired path.
One contiguous acquisition group owned by one source loop is represented with
an explicit generation reset: the product chooses zero iterations or acquire,
releases the complete generation, then chooses repeat or exit. Multiple loop
IDs, nested/non-contiguous repeated groups, and a later acquisition that breaks
stack order remain `unknown`. The existing detailed Quint resource model
remains the stronger check for async initializer scheduling,
`SuppressedError` payloads, and reverse-order counterexamples.

## Promise rejection ownership

Promise bindings can be projected into the same terminal-state vocabulary.
A newly tracked rejection responsibility starts `available`; a binding observed
by supported `await`/handler forms becomes `consumed`, an explicit consumer or
escape becomes `transferred`, and a floating binding remains `available`, so it
fails the required `consumed | transferred` terminal set.

This projection mirrors the supported binding-level async analysis. A reviewed
immutable local alias shares the originating TypeChecker declaration identity
and is normalized to one Promise ownership resource. Each straight-line direct
reassignment receives a distinct generation suffix and therefore a separate
terminal obligation. Conditional/loop/try replacements retain the existing
path-sensitive aggregate rather than claiming exact SSA generation identity.
Dynamic or escaping aliases and arbitrary thenables remain outside this proof.

For the selected root, `generateTemporalModel` now emits this projection as a
`promise-ownership` model with the `promiseOwnershipSafe` property. Observed and
explicitly transferred bindings reach an accepted terminal state; a floating
binding produces a Quint counterexample. A directly bound builtin
`new Promise(...)` is linked to its host settlement transition by the shared
TypeChecker declaration identity and records that exact link in
`TemporalModelResult.synchronizations`. External producers, arbitrary thenables,
and unsupported aliases retain `promise-host-synchronization`; the link does not
claim a general reaction-job ordering proof.

## Iterator cleanup

The unified Program analyzer reports `protocol: "sync" | "async"`. For a
synchronous `for...of`, normal exhaustion consumes the iterator while explicit
break, function return, and uncaught explicit throw synchronously perform the
optional `IteratorClose` `return()` lookup/call. Property lookup may invoke user
code and close failure is a synchronous throw. Nested/labeled loop ownership is
preserved; an abrupt completion crossing a finally that can override it remains
unknown.

Manual synchronous `Iterator`/Generator bindings use the same TypeChecker-backed
identity, immutable alias, ownership escape, callable-contract, and immediate
`try/finally` dominance rules as manual async iterators. Their `.next()` and
`.return()` calls complete inline and can throw, so they do not require `await`.
Generator `.throw(value)` is conservatively a non-terminal protocol use because
the generator may catch it and continue; the async form must be awaited and can
reject, while the sync form completes or throws inline.
Direct synchronous generator `yield*` also separates normal exhaustion from
consumer-return propagation with inline optional-return semantics.

Iterator identity can pass through a TypeChecker-resolved builtin
`Object.freeze({ iterator })`, immutable aliases of that frozen object, static
dot/string-element property reads, and `const` object destructuring. Returning
the frozen aggregate is an exact ownership escape. A local object or array
literal is also exact while a whole-owner write/escape screen proves that its
static iterator slot is never replaced and the container does not escape;
immutable aliases and returned closures retain that slot identity. Slot writes,
dynamic keys, shadowed `freeze`, passing/storing the container externally, or
returning a mutable aggregate are retained as `unstable-iterator-property`
unknown evidence instead of silently disappearing. External calls and property
assignments create an escape transition even when there is no later slot read.
Static `const` object and array destructuring preserves exact slot identity.
Mutable destructuring, an unstable source container, rest patterns, and
computed property patterns retain all candidate resources as
`unstable-iterator-alias` rather than dropping the relationship.
This is shallow local-slot provenance, not a general heap or deep immutability
proof. Recognition of `Object.freeze` exists for code that already uses it; it
is not a recommendation to add a runtime freeze. The ordinary local-container
write/escape proof is the preferred zero-runtime path.

Local mutable identifier aliases use assignment-generation semantics rather
than spelling. A straight-line `let active = first; active = second` resolves
each use to the iterator installed at that source point, and a `const` snapshot
retains the generation captured at its declaration. Reassignment under an
`if`, loop, switch, catch, or other conditional region joins all possible
iterator identities and emits `unstable-iterator-alias` unknown evidence for
each candidate. Unsupported right-hand sides and alias cycles do not become
trusted identities. This is local scalar flow, not general heap SSA.

The reviewed `for await...of` fragment produces one resource scenario per
observed completion. Normal exhaustion consumes the iterator. Explicit break,
function return, and uncaught explicit throw release it through
AsyncIteratorClose. Nested loops and labeled outer breaks retain lexical target
ownership, and nested callable exits are excluded.

The close metadata is deliberately precise about its uncertainty: property
lookup for optional `return` is inline and may invoke user code; when present,
its result is awaited and can reject on a microtask continuation. Generic async
iterables therefore do not claim that `return` always exists. Abrupt completion
through a normally completing `finally` preserves IteratorClose. A direct,
unconditional `return`, `throw`, or loop-targeting `break` in the finalizer
replaces the incoming completion; a possibly loop-resuming `continue` remains
unknown. Calls, construction, tagged templates, and property/element reads in
the loop body contribute an uncaught implicit-throw close scenario, while a
locally caught operation does not. This is a reviewed syntactic may-throw
model, not a proof of complete ECMAScript evaluation order. The Program-backed analyzer also recognizes direct local manual
`AsyncIterator` bindings and immutable aliases by TypeChecker identity. Awaited
`.next()` is a resource use and an explicit `.return()` is a release whose
completion runs on the microtask lane. Missing close remains an unsatisfied
terminal obligation, unawaited operations are reported as unknown, and use
after close is retained for the shared resource evaluator to reject. Returning
the iterator, or an immutable inline/named closure or simple aggregate that
captures it, is an exact ownership escape. Passing it to an uncontracted call is
an unknown escape rather than an assumed transfer. A symbol-resolved local API
with an authenticated resource callable annotation instead contributes its
trusted `acquire`, `use`, `borrow`, `consume`, `release`, `transfer`, or
`escape` transition; the trust level
is retained and is not upgraded to verified evidence. This is a straight-line
protocol fragment. A direct `yield*` from an async generator to a
TypeChecker-resolved standard `AsyncIterable` additionally emits separate
normal-exhaustion and consumer-return propagation scenarios, retaining optional
`return` lookup and awaited rejection. It also retains a
`delegation-step-failure` scenario: failure of the delegate's `next`/`throw`
lookup, call, await, or result access is propagated by ECMAScript without a
general guarantee that `return` was invoked. That path is unknown rather than
being hidden behind successful exhaustion or consumer return. The special
consumer-throw case where the delegate has no `throw` method performs
IteratorClose before raising `TypeError`, but proving method presence and every
result shape remains future work. Proxies and general nested delegation
composition remain unsupported.

General user-defined lifecycle APIs use the unified annotation surface:

```ts
interface Handle { readonly fd: number }

/* uneffect:acquire return */
declare function open(): Handle

/* uneffect:use handle */
declare function inspect(handle: Handle): void

/* uneffect:release handle */
declare function close(handle: Handle): void

function readMetadata() {
  const handle = open()
  const alias = handle
  inspect(alias)
  close(alias)
}
```

`acquire return` introduces a fresh absent resource and moves it to available;
it must eventually be released, consumed, transferred, or explicitly escaped.
`use` and the compatibility spelling `borrow` require the resource to remain
available. `release` terminates it, so a later use or second release is an
invalid transition. Immutable local aliases are normalized to the declaration
identity of the acquiring call, not to their variable spelling. Acquisition is
currently restricted to a directly `const`-bound return value. Destructuring,
mutable aliases, returned-member factory contracts, and contracts imported only
through an unauthenticated transitive `.d.ts` remain unknown.

Method contracts may name their receiver with `this`, which covers the common
client/handle shape without wrapping the API:

```ts
interface Client {
  /* uneffect:use this */
  query(): void

  /* uneffect:release this */
  close(): void
}

/* uneffect:acquire return */
declare function connect(): Client

function run() {
  const client = connect()
  const alias = client
  alias.query()
  alias.close()
}
```

The method symbol selects the contract and the property-access base supplies
the receiver resource identity. Immutable aliases resolve to the same acquired
region. `this` on a free function is rejected as a malformed resource contract;
dynamic/computed receiver selection and mutable aliases remain unknown.

Every reference to a locally acquired resource is consumed by the same audit.
Known lifecycle call arguments/receivers, immutable alias declarations,
`using`, and a direct returned ownership escape are accepted. Passing the
resource to an uncontracted call, storing it, capturing it, reading an
unannotated member, or otherwise using it outside a known transition adds an
unknown escape transition. A later close therefore cannot manufacture a proof
that the opaque operation preserved ownership.

Reviewed lifecycle events from the versioned builtin semantic catalog enter
this same checker. For example, `new WebSocket()` acquires a `websocket`,
`send()` uses it, and `close()` releases it; stream-reader acquisition and
release follow the same route, and `ReadableStreamDefaultReader.read()` /
`ReadableStreamBYOBReader.read()` are resource uses. The resource id is the TypeScript declaration
region, while the local variable spelling is display-only, so renaming a binding
or calling through an immutable alias does not change the proof relation.
Catalog gaps and unstable projected identities are unknown rather than silently
treated as pure operations.
Lifecycle evidence reports `authority` as `callable-contract`,
`builtin-catalog`, or `mixed`. Trusted catalog transitions remain `builtin`
assumptions in the assurance ledger; they are not mislabeled as user callable
contracts or promoted to verified evidence.

CFG joins preserve optional lexical lifecycles. If a resource is acquired and
released only on one branch while the other branch never creates it, the joined
state is `absent-or-released` and satisfies a release obligation. This does not
generalize arbitrary unequal states: a branch that may leave a live resource,
consume it inconsistently, or reuse it after release remains unknown.

A directly awaited Promise-returning operation on a live resource contributes
a rejection edge to the same CFG. Consequently, releasing after `await
writer.write(...)` does not prove cleanup: rejection bypasses the release. A
`try/finally` release covers both fulfillment and rejection. An awaited acquire
is treated differently—the resource is introduced only on fulfillment, so its
rejection edge cannot manufacture a leaked handle.

Node server contracts use the same resource operations: `createServer()`
acquires a `server`, `listen()` uses it, and `close()` releases it. Receiver
aliases are resolved by TypeChecker identity. `listen(0, host)` requests an
OS-selected ephemeral port, so its network authority is conservatively widened
to the host rather than emitting the invalid scope `host:0`.

`node:fs` watchers are also catalog resources. `watch()` acquires a `watcher`,
`ref()` and `unref()` use it without changing ownership, and `close()` releases
it. Omitting `close()` remains an unsatisfied lifecycle even after `unref()`;
event-loop liveness and resource ownership are deliberately distinct facts.

`node:fs/promises.open()` acquires a `file-handle` only on Promise fulfillment.
Reviewed `FileHandle` read/write methods use the handle, and `close()` releases
the caller's ownership responsibility. Here `released` means that the required
release operation was invoked, not that the OS operation was proved successful;
close rejection remains an async/temporal outcome. A preceding awaited read or
write can bypass a later close, so reliable ownership discharge still requires
`try/finally` or `await using`.
An immutable Promise binding followed by exactly one direct acquisition,
`const pending = open(...); const handle = await pending`, is linked to the
handle declaration by TypeChecker symbol identity. Extra uses, multiple awaits,
mutation, storage, or escape of `pending` remain unknown rather than treating
the Promise object itself as a file handle.
The binding rule is shared by builtin catalog entries, local
`uneffect:acquire return` declarations, and authenticated package resource
summaries; it is not a FileHandle-specific name heuristic.

A resource received as a function parameter is borrowed unless the current
function contains an authenticated acquisition or ownership-transfer contract.
Builtin `use` therefore checks that the resource is still available but does
not require the borrower to close it. A builtin `release` can close a borrowed
resource, and a later use is still rejected. This avoids turning ordinary
helpers such as `send(socket)` into false leak reports while retaining
use-after-close diagnostics.

Resource callable contracts follow immutable callable aliases across local and
package boundaries. Direct `const shutdown = close` chains are accepted. A
callable stored in an object is accepted only when the object literal is owned
by an authenticated builtin `Object.freeze(...)` call and a `const` binding.
An ordinary mutable object remains unknown; the checker does not infer runtime
immutability merely because no mutation was observed in the selected file.
This is an analyzable escape hatch, not a recommendation to introduce
`Object.freeze` into performance-sensitive code; direct aliases require no
runtime operation.

An acquired return bound by TypeScript Explicit Resource Management is
connected to its implicit lexical release:

```ts
/* uneffect:acquire return */
declare function open(): Handle

function read() {
  using handle = open()
  inspect(handle)
} // implicit Symbol.dispose is the release transition
```

`await using handle = await openAsync()` is handled in the same resource CFG;
the awaited initializer still receives the declaration identity of `handle`.
Cleanup is inserted on normal, early-return, and throwing exits and at nested
block boundaries. Repeated acquisition in a loop currently converges to
unknown rather than claiming that one static resource identity represents all
iterations. The lifecycle checker proves only protocol state here. Disposal
failure, `SuppressedError`, Promise rejection, and microtask ordering continue
to be reported/modelled by the existing async/disposal analysis; an implicit
release does not assert that disposal cannot fail.

The manual fragment recognizes one common exception-safe form: the iterator is
acquired and the immediately following statement is a `try` whose unconditional
`finally` directly calls (and, for async iterators, awaits) `iterator.return()`.
That release dominates normal
completion, explicit return/throw, and rejection of an awaited `next()` inside
the protected try. A close in the try/catch body, a conditional close inside
finally, or any intervening statement between acquisition and the protected try
remains unknown; this prevents a pre-try rejection from being mistaken for a
guaranteed cleanup.

Natural manual exhaustion is recognized for canonical `while` conditions that
directly test the same TypeChecker-resolved iterator call as
`!iterator.next().done`, `iterator.next().done === false`, or the awaited async
equivalent. The loop projects repeated borrow/use followed by one `consume`
terminal transition. A body-level break, return, or escaping throw disables
that proof and leaves the close obligation unsatisfied; divergence is allowed
under the fragment's partial-correctness interpretation and is not a liveness
claim.

The equivalent bound-result form is also supported for `while (true)`,
`do...while (true)`, and `for (;;)`: a direct immutable `const step =
iterator.next()` (or awaited async call), immediately followed by `if
(step.done) break`, establishes `consume`. `const { done } = ...` and explicit
`done === true` are accepted by symbol identity. Any intervening guard,
reassignment, alternate loop-targeting break, function return, or escaping throw
prevents the exhaustion claim.

A canonical `for` generation is supported as the one reviewed mutable-result
exception: `for (let step = iterator.next(); !step.done; step =
iterator.next())`. The initializer and update calls must resolve to the same
iterator resource, the loop condition must read that exact result symbol, and
the body must have no alternate abrupt exit. Awaited async initializer/update
forms are equivalent. This does not generalize arbitrary `let` reassignment;
updating from another iterator leaves both resources unclosed.

A direct manual `if/else` whose two branches each perform the same awaited
`return()` is collapsed to one exact release at the join. Missing `else`, an
unawaited async branch, nested conditional cleanup, and different ownership
operations remain conditional/unknown; the rule does not pretend that a flat
transition list is a general CFG.

The reviewed join also recognizes guard exits: if an `if` branch, `switch`
clause, or `catch` path directly closes the iterator before returning or
throwing, and the continuing path reaches a later unconditional close, the two
source releases are projected as one path-independent terminal release. A
return/throw without the guard close downgrades that later close to conditional.
Nested bypasses, loop exits, and possible double-close sequences are rejected
as unknown. This closes a previous unsound gap where a lexically later
`return()` could be mistaken for a post-dominator of an earlier function exit.

Both the file checker and `verifyUneffectProject` use this same iterator
decision layer. Project verification excludes `.uneffect.ts` specification
modules, downgrades evidence from TypeScript-invalid implementation files to
unknown, and reports iterator violations/unknowns through project assurance.
Trusted resource-callable transitions are never promoted to exact evidence;
their used boundary is recorded in the project assumption ledger.

## Resource/temporal product

`uneffect-resource-temporal-product/v1` connects resource transitions to the
backend-neutral host transition IR by stable transition IDs. The first producer
links each acquired `using`/`await using` release to its matching
`dispose-resource` event. Sync disposal requires an inline relation; async
disposal requires awaited microtask completion. The evaluator rejects dangling
or duplicate links, lane mismatch, resource-identity mismatch, and any release
without a host completion link.

Straight-line and bounded conditional results are labeled `exact` for the
resource lifecycle paths admitted by the frontend. Initializer failure uses a
distinct fail-acquire transition that jumps to cleanup; source-conditional
absence continues to use acquire-or-skip. The same product now emits the bounded
acquire/release Quint model. The former dedicated using/host generator has been
removed. A direct `await` in an initializer produces start, microtask
fulfillment, and microtask rejection transitions, while synchronous evaluation
failure remains an inline edge. Positive execution and a deliberately invalid
resume outside the microtask checkpoint are both checked. The lifecycle model
does not infer asynchronous initializer timing through wrappers, thenables, or
other indirect forms.
Only the single contiguous repeated group above is supported; broader repeated
acquisition topologies remain unsupported.
Supported disposal throw/reject paths increment a finite failure count; a second
failure sets `suppressed_failure`. The model also assigns a stable finite origin
ID to a body, initializer, or disposer failure and records the previous active
origin as each disposer failure's suppression parent. Dropping suppression or
substituting an unrelated parent produces a Quint counterexample. This proves
the modeled origin chain, not equality or object identity of runtime Error
payload values. Transitions other than acquire and release,
fairness, cancellation, and arbitrary callback interleavings remain future work
and must not be inferred from a passing property.

## Current lowering

The abortable-fetch analysis currently lowers these reviewed fragments:

- direct `Response` body consumption;
- `getReader()` ownership transfer and reader cancel/drain/release;
- direct and transformed `pipeTo` pipelines;
- `Response.clone()` body splits;
- `ReadableStream.tee()` stream splits.
- direct Response body calls across structured `if`/`else` control flow.

Resource IDs come from TypeChecker symbol/declaration identity where available;
binding spelling is only retained as a diagnostic label. Clone and tee results
are checked by the same split-and-terminal-state evaluator rather than custom
"both branches" Boolean logic.
For example, different builtin body consumers in both arms of one `if`/`else`
can now join to `consumed`; a missing arm joins `available` and `consumed` to
`unknown`.

## Assurance boundary

The evaluators are general, but TypeScript lowering is still a reviewed fragment.
It does not yet provide a complete JavaScript CFG, heap/region fixed point, or
interprocedural resource summary. Unsupported aliases, non-directly-awaited
rejections, unauthenticated external summaries, dynamic dispatch, getters,
proxies, and cross-function escapes must remain unknown unless a frontend emits
authenticated evidence.

Plugins must eventually contribute versioned declarative protocol summaries
that are bound to exact symbol/declaration and package provenance. An executable
plugin returning `true` is not proof and must not be allowed to manufacture
verified transitions.

## Migration direction

New ownership-sensitive builtins should be implemented as lowering into this IR,
not as a new terminal-state checker. Existing Transferable ownership, `using`,
Promise ownership, typed-array invalidation, and user protocols should migrate
incrementally. The next shared layer is a conservative CFG transfer function
using the existing fixed-point engine, followed by callable summaries for
`Transfer` and `Escape` across function boundaries.

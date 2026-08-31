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

## Callable resource boundaries

`uneffect-resource-callable-summary/v1` is the backend-neutral function-boundary
contract. It refers to resources by parameter index or return position and
supports `borrow`, `consume`, `transfer`, and `escape`. Instantiation substitutes
the caller's stable resource identities and lowers the operations to the shared
`use`, `consume`, `transfer`, and `escape` transitions. Verified summaries emit
exact evidence; reviewed external summaries retain trusted evidence.

Missing argument or return identities produce an explicit `unknown` result and
a list of unresolved references. The API does not infer the contract from a
function name or accept an executable plugin predicate as proof.

The first TypeScript frontend accepts declarations such as:

```ts
/* uneffect:resource
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
return are substituted into transition sites. Malformed parameter names,
missing return bindings, dynamic calls, and unsupported resource expressions
produce diagnostics or remain outside the fragment. Package summaries require
the explicit authenticated artifact path described below.

Explicitly supplied package contracts can now use
`uneffect-resource-callable-artifact/v1`. Authentication requires the exact
module/export, package version or Node major, full declaration-file SHA-256,
artifact payload SHA-256, and non-empty trust owner/reason. Invalid or expired
review dates block the artifact. Accepted summaries are rebound to the actual
TypeChecker declaration identity, enabling the same call-site lowering used for
local declarations. External artifacts are always `trusted`; a payload that
self-asserts `verified` is rejected. Automatic package/config discovery is not
implemented yet. `resourceCallableArtifactAssumption` converts every accepted
artifact into the shared `resource-callable` assumption-ledger domain, retaining
dependency version, owner, reason, expiry, and source scope. Until registry
loading is implemented, callers must explicitly append that entry to their
ledger.

## Explicit Resource Management

The first `using`/`await using` projection lowers a successfully acquired
owner's disposal suffix into the common resource lifecycle: every binding is
acquired, then released in the reverse order supplied by the TypeScript async
safety analysis. The projection separately retains whether disposal runs inline
or in a microtask, whether failure throws or rejects, whether it is caught, and
which completion exits trigger cleanup.

Its evidence status is deliberately `exact-under-precondition`, with
`all-listed-resources-acquired` as that precondition. Conditional acquisition
returns `unknown`. The current single-state join cannot preserve the
`absent | available` disjunction needed to represent initializer failure while
skipping disposal of unacquired resources. The existing Quint resource model
remains the stronger check for acquisition failure, async suspension,
`SuppressedError`, and reverse-order counterexamples.

## Promise rejection ownership

Promise bindings can be projected into the same terminal-state vocabulary.
A newly tracked rejection responsibility starts `available`; a binding observed
by supported `await`/handler forms becomes `consumed`, an explicit consumer or
escape becomes `transferred`, and a floating binding remains `available`, so it
fails the required `consumed | transferred` terminal set.

This first projection intentionally mirrors the existing binding-level async
analysis. Immutable aliases are currently separate compatibility records, not
one proven underlying Promise identity. It therefore does not yet replace the
alias/control-flow analysis or prove that an arbitrary thenable is handled.

## Async iterator cleanup

The reviewed `for await...of` fragment produces one resource scenario per
observed completion. Normal exhaustion consumes the iterator. Explicit break,
function return, and uncaught explicit throw release it through
AsyncIteratorClose. Nested loops and labeled outer breaks retain lexical target
ownership, and nested callable exits are excluded.

The close metadata is deliberately precise about its uncertainty: property
lookup for optional `return` is inline and may invoke user code; when present,
its result is awaited and can reject on a microtask continuation. Generic async
iterables therefore do not claim that `return` always exists. Abrupt completion
crossing `finally` is rejected as unknown because the finalizer may override it.
Coverage is `reviewed-explicit-completions`, not a complete implicit-exception
model. Manual iterator calls, generator `yield*` close propagation, proxies,
and implicit call/getter throws remain unsupported.

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

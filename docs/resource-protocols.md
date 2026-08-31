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

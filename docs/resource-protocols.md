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

## Current lowering

The abortable-fetch analysis currently lowers these reviewed fragments:

- direct `Response` body consumption;
- `getReader()` ownership transfer and reader cancel/drain/release;
- direct and transformed `pipeTo` pipelines;
- `Response.clone()` body splits;
- `ReadableStream.tee()` stream splits.

Resource IDs come from TypeChecker symbol/declaration identity where available;
binding spelling is only retained as a diagnostic label. Clone and tee results
are checked by the same split-and-terminal-state evaluator rather than custom
"both branches" Boolean logic.

## Assurance boundary

The evaluator is general, but TypeScript lowering is still a reviewed fragment.
It does not yet provide a general JavaScript CFG, heap/region fixed point, or
interprocedural resource summary. Unsupported aliases, loops, exception paths,
dynamic dispatch, getters, proxies, and cross-function escapes must remain
unknown unless a frontend emits authenticated evidence.

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

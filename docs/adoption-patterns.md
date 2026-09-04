# Adoption patterns

Uneffect is designed for gradual adoption. The useful unit is a reviewed
boundary, not an all-or-nothing migration of a repository.

## Pattern 1: ratchet inferred effects before writing specifications

Generate a reviewable baseline for every selected function, including functions
without Uneffect annotations:

```sh
npx uneffect check --project tsconfig.json \
  --write-effect-baseline .uneffect/effects.json
git add .uneffect/effects.json
```

Then make capability expansion a CI failure:

```sh
npx uneffect check --project tsconfig.json \
  --effect-baseline .uneffect/effects.json
```

The baseline flags newly inferred effects, effectful new functions, and new
fail-closed reason codes. Both baseline flags imply `--infer`, so application
code does not need annotations before this ratchet becomes useful. Source-line
movement does not invalidate identities; duplicate same-named functions are
distinguished by source occurrence. A different Uneffect version requires an
explicit review and regeneration because inference semantics may have changed.

An accepted baseline records existing authority and unknown analysis; it does
not prove those entries safe or complete. Removing an effect is allowed, and a
behavioral bug that stays within an already allowed effect set is outside this
gate. Keep the baseline in review, and do not erase an unexpected expansion by
regenerating it without understanding the code change.

For an observation-only report without persistence, use `--infer`. It analyzes
unannotated functions without treating them as declared-pure proofs. Use the
result to identify external I/O, mutation, thrown errors, floating promises,
and unknown call boundaries. Do not convert `unknown` into pure merely to make
the first run green.

Good first targets are leaf utilities and application composition roots. They
have fewer dynamic callers and make transitive effect diagnostics easier to
review.

## Pattern 2: declare broad upper bounds, then narrow them

An effect declaration is an upper bound. A broad first annotation is valid:

```ts
/* uneffect:effect FsRead | Console */
export function loadAndReport(): void {
  // Existing implementation.
}
```

Once the call graph is classified, replace broad permissions with finite scope
sets:

```ts
/* uneffect:effect FsRead<"$WORKSPACE_ROOT/config/**"> | Console */
export function loadAndReport(): void {
  // Existing implementation.
}
```

Unused effects are warnings because an implementation may legitimately use less
authority than its public upper bound. Missing transitive effects are errors.

## Pattern 3: annotate capability boundaries, not wrappers

Uneffect attaches builtin semantics by TypeChecker symbol identity. Keep normal
calls to `node:fs`, `fetch`, DOM APIs, workers, timers, and Promise combinators;
do not introduce a wrapper solely for the analyzer.

Wrap an API only when the wrapper is a real domain boundary. In that case,
publish the wrapper's effect contract and let callers depend on the narrower
summary.

## Pattern 4: separate authority from semantic footprint

Capability effects answer what a function may access. Optimizer-facing
footprints answer what values can change or be observed. Keep these contracts
separate:

- `FsRead`, `Fetch`, and `Dom` describe authority;
- `Mutate<typeof value>` identifies a mutation region;
- invariant and refinement evidence describes facts preserved by a supported
  implementation fragment;
- only verified evidence may authorize a rewrite or compression step.

An effect-free declaration is not by itself proof that a call is referentially
transparent, deterministic, terminating, or safe to duplicate.

## Pattern 5: add contracts at data boundaries

Use `requires` and `ensures` where invalid values enter or where arithmetic
assumptions become security or correctness requirements:

```ts
import type { Nat } from "@mizchi/uneffect"

/* uneffect:requires denominator > 0 */
/* uneffect:ensures result <= numerator */
export function quotient(numerator: Nat, denominator: Nat): number {
  return Math.floor(numerator / denominator)
}
```

Prefer a small proved predicate over a large informal claim. Current contract
proofs are partial-correctness proofs over documented expression and control-flow
fragments; they do not prove termination.

Use opt-in instrumentation at trust boundaries when a runtime assertion is
valuable. Keep ordinary static checks runtime-free.

## Pattern 6: make async ownership explicit at entrypoints

Enable Promise and resource checks first at functions that start work, respond
to requests, or own shutdown:

- handle or return every rejecting Promise;
- model `try`/`catch` only where the rejection or synchronous throw is actually
  discharged;
- use `using` and `await using` for lexical resources when the platform supports
  them;
- keep escaped resources and callbacks explicit, because they widen the
  ownership proof.

Promise combinator and event-loop models cover documented subsets. Unknown
thenables, dynamic callbacks, and host-specific phases remain conservative.

## Pattern 7: introduce temporal models for stateful incidents

Temporal specifications are most useful after a concrete ordering question is
known. Examples include:

- a telemetry sink must be called at most once;
- a lease must never have two writers;
- every accepted request must eventually settle;
- cancellation must prevent later resource use;
- a retry must not reuse a disposed generation.

Model observable state and actions only. Use Z3 for state predicates and local
transition obligations; use Quint for schedules, fairness, and temporal
counterexamples. Preserve a broken variant or negative fixture so the property
is demonstrably load-bearing.

## Pattern 8: bind models to implementation incrementally

Refinement bindings connect named model actions and invariants to exported
TypeScript functions:

```ts
/* uneffect:refinement_from "./queue.uneffect.ts#default" */
export function enqueue(runtime: Runtime): void {
  runtime.pending += 1
}
```

The sibling typed definition maps `actions: { enqueue }`; inline refinement
role annotations are rejected.

Coverage checks catch stale or missing bindings. Body refinement is stronger
but supports only the fragments listed in
[Gradual annotations](./gradual-annotations.md). Unsupported control flow is a
non-proof, not evidence that the model and implementation agree.

## Pattern 9: ratchet CI by evidence class

A stable rollout separates three outcomes:

1. verified obligations that may gate CI;
2. diagnostics with an assigned owner and a planned fix;
3. explicit unknown or trusted boundaries that require review but are not
   misreported as proofs.

Use an explicit file list at first. Expand the list and tighten `--strict` only
after the current baseline is clean. Keep generated evidence and model inputs
versioned or reproducibly generated, and pin npm dependencies and external
model-checker versions.

For this repository, `just check` is the full local gate and GitHub Actions
separates fast, Z3, Quint, exhaustive, and integration tiers. Consumer projects
may use a smaller split, but should keep solver-heavy checks isolated from fast
lint feedback.

## Pattern 10: use escape hatches without erasing uncertainty

Typed-array obligations currently support an explicit
`trust typed-array <assumption-id>` directive. It records trusted evidence with
a source span and registry-authenticated review metadata; it does not become verified evidence. Other proof domains do
not generally expose a `sorry` directive. Exported runtime classes have the
narrower `trust dispatch-sealing <assumption-id>` assumption for declaration-body
method refinement. Keep its owner and expiration in the caller-owned registry, audit it in CI, and do not
interpret it as proof against externally loaded subclasses or prototype
mutation.

At unsupported boundaries, prefer:

- retaining an `unknown` diagnostic or evidence state;
- narrowing the checked function to a supported adapter;
- adding a runtime assertion at an external input boundary;
- filing the missing semantic fragment as roadmap work.

Do not suppress an unsupported proof by declaring the function pure or by
weakening an invariant unless the domain contract itself changed.

## Monorepos and libraries

For a monorepo, adopt per package and keep each package's TypeScript version and
entrypoint list explicit. Shared libraries should publish effect upper bounds
at exported functions; applications may then add narrower environment-specific
policies around those calls.

Generated model files and evidence should include the source/model hash and tool
versions. Do not reuse evidence across a changed package graph unless the
artifact schema explicitly proves that reuse safe.

## Choosing the next boundary

Prioritize code where one of these is true:

- an incident already demonstrated an ordering or cardinality bug;
- the function has broad filesystem, network, DOM, or process authority;
- a Promise or resource can escape its lexical owner;
- arithmetic bounds protect a buffer, protocol field, or billing value;
- an optimization would duplicate, reorder, or remove observable work.

For exact supported and unsupported fragments, use the
[feature matrix](./feature-matrix.md),
[implementation status](./implementation-status.md), and open
[GitHub Issues](https://github.com/mizchi/uneffect/issues).

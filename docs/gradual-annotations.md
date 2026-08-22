# Gradual annotations

Uneffect annotations are ordinary block comments. They do not change TypeScript parsing, emitted JavaScript, or JSDoc tag semantics.

Once a block contains the explicit `uneffect:` marker, its following non-empty lines are owned by the Uneffect grammar. Unknown directive names, missing payloads, and empty effect-union members are errors rather than ignored text. Ordinary JSDoc outside such a block is untouched. Parsed directives and capability members retain exact UTF-16 source spans in TypeScript. The Rust/Corsa boundary uses file IDs and UTF-8 byte spans; adapters must convert positions explicitly rather than mixing the two coordinate systems.

```ts
import type { Nat } from "@mizchi/uneffect"

/*
 * uneffect:
 * effect Console | Mutate<typeof state>
 * requires amount >= 0
 * ensures result >= amount
 * assert amount: Nat
 */
function deposit(state: Account, amount: Nat): Nat {
  state.balance += amount
  console.log(amount)
  return state.balance
}
```

## Marker

Only comments containing the exact `uneffect:` marker are interpreted. Earlier design spellings such as `@effect`, bare `effect`, and `with` are not accepted.

The canonical form uses `/* ... */`, not `/** ... */`. An accidental JSDoc block can be scanned because `uneffect:` is plain description text rather than a JSDoc tag, but tools should format new annotations as non-JSDoc comments.

```ebnf
annotation = "/*", annotation_body, "*/" ;
annotation_body = "uneffect:", { directive } ;

directive = effect_decl
          | requires_decl
          | ensures_decl
          | invariant_decl
          | returns_decl
          | assert_decl
          | refinement_decl ;

Function-summary temporal contracts add `temporal_requires`, `temporal_ensures`, `temporal_modifies`, `temporal_throws`, `temporal_rejects`, `temporal_suspends true`, and `temporal_cancellable true`. Once suspension introduced a concrete progress question, the grammar also gained `temporal_eventually name: predicate` and per-summary `temporal_fair weak|strong`. These lower to Quint `eventually` and weak/strong action fairness; they are still TypeScript-style source expressions rather than embedded Quint.

Standalone transition systems additionally support `action_when name:
predicate`, `clock name: positiveInteger`, and `action_fair name: weak|strong`.
A clock owns its implicit init and generated tick assignment; other actions
cannot write it.

Temporal expressions are a restricted TypeScript expression subset. For example, write `phase === 0 && !cancelled`, not Quint's `phase == 0 and not(cancelled)`. Uneffect retains a neutral expression AST that can be lowered to a verifier expression or compiled into an optional runtime assertion.

effect_decl    = "effect", effect_union ;
requires_decl  = "requires", expression ;
ensures_decl   = "ensures", expression ;
invariant_decl = "invariant", expression ;
returns_decl   = "returns", refinement_type ;
assert_decl    = "assert", identifier, ":", schema ;
refinement_decl = "refinement", identifier, "@", version,
                  ( "create" | "observe"
                  | "action", identifier
                  | "invariant", identifier ) ;

effect_union = effect_term, { "|", effect_term } ;
effect_term  = qualified_name
             | "Mutate", "<", "typeof", region, ">"
             | "Throw", "<", error_type, ">"
             | scoped_effect ;
```

A return refinement describes a value more precisely for Uneffect analysis without changing runtime behavior:

```ts
/* uneffect: returns Path<"$TEMP"> */
declare function tmpdir(): string
```

Platform builtins carry equivalent refinements in the builtin semantic overlay rather than by editing their upstream declaration files.

## Model refinement bindings

Exported implementation functions can be bound to an abstract temporal model
without wrapping their runtime calls:

```ts
/* uneffect: refinement lease@1 create */
export function createLease(initial: LeaseState): LeaseRuntime { /* ... */ }

/* uneffect: refinement lease@1 observe */
export function observeLease(runtime: LeaseRuntime): LeaseState { /* ... */ }

/* uneffect: refinement lease@1 action takeoverB */
export function takeover(runtime: LeaseRuntime): void { /* ... */ }

/* uneffect: refinement lease@1 invariant singleWriter */
export function singleWriter(runtime: LeaseRuntime): boolean { /* ... */ }
```

`create` and `observe` are required exactly once. Action and invariant names
must be unique. Targets must be exported function declarations; create,
observe, and invariant functions take one argument, while actions may also take
the normalized trace step. The extractor never evaluates annotation text.
Build tooling can either resolve the manifest against already-loaded exports or
emit a reviewable module containing direct namespace references. Normal
TypeScript checking remains responsible for the concrete state/runtime types.

`validateRefinementBindingCoverage` compares a named adapter manifest with a
parsed temporal model. It reports missing bindings and bindings that refer to
removed action or invariant names. Liveness properties are excluded because an
adapter invariant is a point-state predicate, not a temporal monitor. This is a
structural stale-binding check only: it does not prove that an action function's
assignments implement the corresponding model transition.

`validateRefinementActionBodies` adds a proof for a deliberately restricted
zero-runtime fragment. It normalizes direct runtime-field assignment,
`+=`/`-=`, increment/decrement, and omitted-field stuttering to the temporal
expression AST. It can inline one local class method call when every argument
is syntactically available; this supports wrappers such as
`runtime.record("delivered")` and specializes a computed `this[outcome]`
write to the literal field. Every model state is compared, so an extra runtime
write is rejected as well as a missing or different write. Branches, loops,
multiple sequential writes to one state field, imported calls, recursive calls,
collection operations, and dynamic computed members produce
`unsupported-action-body`; they are never silently treated as verified.
For a guarded model action, the implementation may begin with
`if (!(predicate)) return`; the positive predicate is normalized and must
exactly match `action_when`. Missing, different, and unexpected guards are
separate diagnostics. The false path therefore stutters and the true path is
checked by the same update proof. Other branching forms and logically
equivalent but differently shaped guards remain unsupported. This check covers
transition updates and this early-return guard fragment, not arbitrary control
flow or solver-proven predicate equivalence.

`validateRefinementInvariantBodies` checks the adjacent safety-property
functions. A supported implementation is exactly one `return` whose expression
uses runtime scalar fields, integer/boolean literals, arithmetic, strict
equality, comparisons, `&&`, `||`, `!`, and unary minus. Its normalized AST must
exactly equal the temporal property AST. Loose JavaScript equality is rejected
because coercion would make the correspondence unsound. Local declarations,
calls, mutation, collections, and merely logically equivalent but differently
shaped predicates remain unsupported. Missing and stale invariant bindings are
reported by this validator itself, so an empty diagnostic list means every
declared safety property passed this fragment. Liveness properties are still
outside point-state invariant binding.

`validateRefinementStateProjection` checks both adapter endpoints. It accepts
an identity return, an object literal with an identity spread or explicit
runtime-field projection, and an observe-side `const` object destructuring
followed by such a return. Create may use
`Object.assign(new LocalRuntime(), initial)` only when the local class has no
heritage clause, explicit constructor, or accessors, so inherited or setter
transformations cannot masquerade as identity. Every temporal state field must
map to its same-named source field independently at both endpoints; compensating
renames between create and observe are rejected. Same-named globals are never
treated as model state. Arbitrary factories, nested shapes, computed dynamic
keys, defaults, and non-identity abstraction functions remain unsupported.
The proof assumes the annotated TypeScript parameter contract at the gradual
boundary; it does not establish runtime object conformance against hostile
Proxy/getter inputs.

`|` is the only union separator. Commas separate parameters inside a parameterized effect and are never accepted as top-level effect unions.

## Attachment

Annotations attach to the next declaration symbol without crossing another declaration. The intended frontend supports function declarations, methods, variable-bound arrow functions, overload signatures, ambient declarations, and anonymous callback summaries. The current TypeScript prototype handles function declarations only.

For overloads, each signature has an upper bound. The implementation signature must satisfy the join of all effects reachable through the overload set.

## Numeric helper types

Uneffect provides branded helpers where TypeScript's number type is too broad:

```ts
import type { Float, Int, Nat } from "@mizchi/uneffect"
```

- `Int`: finite safe integer
- `Nat`: finite safe integer greater than or equal to zero
- `Float`: finite number

These are compile-time brands, not automatic runtime checks.

## Optional runtime assertions

An `assert` directive can instrument selected boundaries with Valibot:

```ts
/* uneffect: assert amount: Nat */
function deposit(amount: Nat) {}
```

The instrumenter emits a `valibot` import and `parse` call. A safe subset of explicit Valibot expressions is supported:

```ts
/* uneffect: assert name: v.pipe(v.string(), v.nonEmpty()) */
```

Arbitrary callbacks and executable expressions are rejected. Instrumentation changes runtime behavior and the thrown-error surface, so its build-profile setting must be included in proof artifacts.

## Logical contracts

```ts
/* uneffect: requires n >= 0 */
/* uneffect: ensures result == n */
function count(n: number) {
  let i = 0
  /* uneffect: invariant i >= 0 && i <= n */
  while (i < n) i = i + 1
  return i
}
```

The current Z3 prototype supports `Int`, `Nat`, a real-arithmetic abstraction of finite `Float`, comparisons, Boolean operators, simple assignments, branches, returns, and simple loops with invariants. It proves partial correctness, not termination. Unsupported statements, unmodeled calls, and solver `unknown` results are non-proofs. The direct verifier and emitted SMT-LIB share stable, source-mapped proof obligations.

`trust` is an explicit escape-hatch directive. `trust typed-array <reason>` may
be attached to a function or directly before a statement. The narrower
`trust typed-array:<obligation-kind> <reason>` form exempts only the selected
obligation on that statement. Used assumptions record `trusted` evidence and
remain visible in the cross-domain ledger; they never become `verified`.
Statement-level `trust_owner` and `trust_expires` metadata travel with the exact
source span. Other proof domains do not yet expose a general-purpose `sorry`.

## Adoption levels

```text
off
  -> infer and report
  -> check annotated boundaries
  -> strict package
  -> optimize verified regions
```

Missing annotations never imply purity. Runtime assertions remain optional at every level.

Async ownership contracts use `consumes_rejection 0, 2`, where each value is a
zero-based parameter index whose Promise rejection responsibility is accepted
by the callee. Unannotated calls borrow Promise arguments; they do not silently
discharge the caller's obligation. Resolution follows the TypeScript-selected
signature, so the contract is attached to declarations rather than call-site
spellings. Indices are validated against the selected declaration, and direct
wrappers infer the same transfer when they forward a parameter into a consuming
callee parameter.

`consumes_callback_rejection 0` is distinct: it states that the callee observes
the Promise returned by callback parameter zero. This makes async callback
ownership explicit and lets the analyzer reject patterns such as
`array.forEach(async () => ...)`. Standard Promise reactions are identified
through their library declarations and carry this behavior intrinsically.
Direct unconditional higher-order wrappers inherit the callback contract;
conditional forwarding remains non-consuming.

Conditional ownership uses `consumes_rejection_when 1: enabled` or
`consumes_callback_rejection_when 1: enabled`. The left side is the consumed
parameter index and the right side names a boolean parameter. A call transfers
ownership only when the guard is proven true; currently this means a literal
`true`, TypeScript narrowing to `true`, or a matching `requires` precondition.
False or otherwise symbolic guards remain may-consume obligations.

Compound boolean guards are parsed with the shared invariant logic IR. Small
propositional implications are discharged synchronously; unresolved cases are
kept as non-proofs rather than assuming transfer. Both verified and unresolved
obligations are retained in Async IR and can be emitted as SMT-LIB or a pure
Quint implication. Backend output must still be imported as reproducible
evidence before optimizer decisions can trust it.

Ownership verifier executions use the `ownership-evidence/v1` artifact. It
binds backend version and output to hashes of both the obligation and generated
program. Only Z3 `unsat` or a successful exhaustive Quint verification is
proof-grade; missing backend dependencies, unknown, and counterexamples remain
unknown evidence.

Lexically disposed resources have a separate retention contract:

```ts
/* uneffect: retains_resource 0 */
declare function register(resource: Resource): void
```

The zero-based indices identify arguments that may remain reachable after the
call returns. Passing a `using` or `await using` binding, or a statically
resolved local alias, to such a parameter is an escape error. Direct wrappers
infer the contract transitively by parameter symbol identity, including
reassignment-free local `const` forwarding chains. This describes
retention rather than ownership transfer: it neither suppresses disposal nor
changes emitted JavaScript.

The directive may annotate a class constructor as well. Direct construction is
reported as `retaining-construction`; a function returning `new Registry(x)`
inherits retention for `x`, so callers of an ordinary factory are checked too.

Conditional retention uses `retains_resource_when 0: enabled`. Unlike Promise
ownership transfer, retention is a may-property: a resource escape is reported
when the guard is true or unresolved, and discharged only when `!enabled` is
proved from literal/type facts or a `requires` precondition. The guard is parsed
by the same restricted TypeScript expression IR used by logical contracts, so
it remains available for optional runtime assertion generation.
Direct wrappers preserve boolean parameter facts while their bodies are
analyzed, including facts mapped from a caller's `requires` precondition and
reassignment-free local `const` aliases of the guard.

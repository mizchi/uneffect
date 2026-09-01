# Gradual annotations

Uneffect annotations are ordinary block comments. They do not change TypeScript parsing, emitted JavaScript, or JSDoc tag semantics.

Every block starts with the explicit `uneffect:` marker. A one-line annotation
places the directive immediately after the colon; a multiline block places one
directive on each following line. Directive names select the internal grammar,
so Uneffect does not infer a proof domain from an expression. Unknown
directives, missing payloads, and empty effect-union members are errors.
Ordinary JSDoc is untouched. Parsed directives and capability members retain
exact UTF-16 source spans in TypeScript. The Rust/Corsa boundary uses file IDs
and UTF-8 byte spans; adapters must convert positions explicitly rather than
mixing the two coordinate systems.

```ts
import type { Nat } from "@mizchi/uneffect"

/* uneffect:effect Console | Mutate<typeof state> */ /* uneffect:requires amount >= 0 */ /* uneffect:ensures result >= amount */ /* uneffect:assert amount: Nat */
function deposit(state: Account, amount: Nat): Nat {
  state.balance += amount
  console.log(amount)
  return state.balance
}
```

Executable module initialization has a separate file-header upper bound:

```ts
/* uneffect:module_effect Console | FsRead */
await start()
```

The `<module>` summary is an authority may-set across static local imports; it
does not itself claim ESM or top-level-await temporal order. The separate
`module-order` artifact can establish dependency-completion, straight-line TLA
settlement, and direct-throw constraints for its documented acyclic fragment.
Cycles, conditional awaits, external bodies, and dynamic imports remain
non-proof-grade.

## Marker

Only comments containing an explicit `uneffect:` marker are interpreted. The
canonical one-line spelling has no space after the colon, for example
`/* uneffect:effect Console */`. A multiline block uses `/* uneffect:` followed
by directive lines. Earlier design spellings such as `@effect`, bare `effect`,
and `with` are not accepted.

The canonical form uses `/* ... */`, not `/** ... */`. An accidental JSDoc block can be scanned because `uneffect:` is plain description text rather than a JSDoc tag, but tools should format new annotations as non-JSDoc comments.

```ebnf
annotation = "/*", "uneffect:", (directive | { newline, directive }), "*/" ;

directive = effect_decl
          | effect_parameter_decl
          | module_effect_decl
          | requires_decl
          | ensures_decl
          | loop_invariant_decl
          | temporal_always_decl
          | returns_decl
          | assert_decl
          | refinement_decl
          | abstraction_decl ;

The canonical surface uses `loop_invariant` for a Hoare-style loop invariant
and `always name: predicate` for a transition-system safety property. Temporal
properties, Promise rejection ownership, and callable resource directives all
lower through Uneffect's temporal facade. They are TypeScript-style source
expressions, not embedded Quint. Legacy dialect headers are being removed
incrementally; the removed `async` and `resource` dialects are already rejected
rather than treated as aliases.

The unified grammar does not overload `invariant`: `loop_invariant` and `always`
have distinct meanings and internal IR targets.

Standalone transition systems additionally support `action_when name:
predicate`, `clock name: positiveInteger`, and `action_fair name: weak|strong`.
A clock owns its implicit init and generated tick assignment; other actions
cannot write it.

Temporal expressions are a restricted TypeScript expression subset. For example, write `phase === 0 && !cancelled`, not Quint's `phase == 0 and not(cancelled)`. Uneffect retains a neutral expression AST that can be lowered to a verifier expression or compiled into an optional runtime assertion.

effect_decl    = "effect", effect_set ;
effect_parameter_decl = "effect_parameter", identifier, "extends", effect_set ;
module_effect_decl = "module_effect", effect_set ;
requires_decl  = "requires", expression ;
ensures_decl   = "ensures", expression ;
loop_invariant_decl = "loop_invariant", expression ;
temporal_always_decl = "always", identifier, ":", expression ;
returns_decl   = "returns", refinement_type ;
assert_decl    = "assert", identifier, ":", schema ;
refinement_decl = "refinement", identifier, "@", version,
                  ( "create" | "observe"
                  | "action", identifier
                  | "invariant", identifier ) ;
abstraction_decl = "abstraction", identifier, "@", version,
                   identifier, "=", abstraction_expression ;
abstraction_expression = qualified_name
                       | "Set", "(", qualified_name, ")" ;

effect_set   = "none" | effect_union ;
effect_union = effect_term, { "|", effect_term } ;
effect_term  = qualified_name
             | "Mutate", "<", "typeof", region, ">"
             | "Throw", "<", error_type, ">"
             | scoped_effect ;
region       = identifier, { ".", identifier | "[", string_literal, "]" } ;
```

`none` is the reserved empty Effect set. It must be the complete payload, so
`effect none | Console` is invalid. In particular, `none` cannot name a custom
Effect. Use `effect none` to distinguish an explicit checked empty upper bound
from an unannotated function whose currently inferred inventory is empty.

A region is a member path, so it can name a single property: `Mutate<typeof
state.calls>` is the authority to write that property, and a declaration of any
prefix (`Mutate<typeof state>`) permits everything below it. Inference produces
the path the code actually writes; see the
[effect system](./effect-system.md) for containment and for how computed keys
widen to their container.

A return refinement describes a value more precisely for Uneffect analysis without changing runtime behavior:

```ts
/* uneffect:runtime returns Path<"$TEMP"> */
declare function tmpdir(): string
```

Platform builtins carry equivalent refinements in the builtin semantic overlay rather than by editing their upstream declaration files.

## Model refinement bindings

Exported implementation functions can be bound to an abstract temporal model
without wrapping their runtime calls:

```ts
/* uneffect:refinement refinement lease@1 create */
export function createLease(initial: LeaseState): LeaseRuntime { /* ... */ }

/* uneffect:refinement refinement lease@1 observe */
export function observeLease(runtime: LeaseRuntime): LeaseState { /* ... */ }

/* uneffect:refinement refinement lease@1 action takeoverB */
export function takeover(runtime: LeaseRuntime): void { /* ... */ }

/* uneffect:refinement refinement lease@1 invariant singleWriter */
export function singleWriter(runtime: LeaseRuntime): boolean { /* ... */ }
```

`create` and `observe` are required exactly once. Action and invariant names
must be unique. Targets must be exported function declarations; create,
observe, and invariant functions take one argument, while actions may also take
the normalized trace step. The extractor never evaluates annotation text.
Build tooling can either resolve the manifest against already-loaded exports or
emit a reviewable module containing direct namespace references. Normal
TypeScript checking remains responsible for the concrete state/runtime types.

An adapter may opt into a proof-relevant ambient runtime identity:

```ts
/* uneffect:runtime runtime lease@1 = globalThis */
```

This states that the adapter's runtime parameter denotes the ECMAScript global
object in the current Realm. The adapter name and version must match its
refinement bindings. Cross-project composition then accepts the builtin
`globalThis` symbol and records
`{ kind: "ambient", root: "globalThis", identity:
"ecmascript:realm.globalThis" }`. A locally shadowed `globalThis`, a property
below it, `window`, Worker globals, iframe values, other host aliases, duplicate
declarations, and version mismatches are rejected. This is not a claim that
distinct Realms share a global object.

Node's ambient `global` requires both the `@types/node` major and an explicit
realm label:

```ts
/* uneffect:runtime runtime lease@1 = node:global@24#main */
```

Both sides must carry the exact same identity. The argument must resolve through
the TypeChecker to the ambient `global` from `@types/node` major 24; a local
shadow, `#worker`, another major, or an unversioned spelling fails closed. The
label is a user contract used to prevent accidental equality. Uneffect does not
discover deployment topology or prove that two processes or Workers share a
Realm.

An implementation may use a different top-level field name from the temporal
model by declaring an explicit, version-matched abstraction relation:

```ts
/* uneffect:state subscribers: Set<int> */ /* uneffect:refinement abstraction routingState@1 subscribers = Set(routing.activeSubscriberIds) */
```

The left side is a temporal state field. A bare right side is an identity
projection from its concrete runtime property path. `Set(path)` is the first
computed relation: a temporal `Set<T>` is represented by a mutable concrete
`T[]`; create must use builtin `Array.from(modelSet)`, observe must use builtin
`new Set(runtimeArray)`, `push(value)` refines Set union, an exact
`array = array.filter(item => item !== value)` refines Set difference,
`array.length = 0` refines Set clearing, and `includes(value)`/`length` refine
membership/size reads. Builtin `array.some(item => item === value)`, including a
block containing one direct return, is canonicalized to the same membership
predicate. Builtin `array.every`/`array.some` also refine temporal
`forall`/`exists`; expression callbacks and blocks containing immutable local
constants followed by one return are accepted. Array order and duplicate entries are deliberately outside
the abstract observation. These builtins are accepted only through the
Program-backed TypeChecker path. The relation is one-to-one, and concrete paths may
share parents but may not overlap as prefixes. The Program-backed checker verifies
the abstract create parameter and observe result, the concrete create result
and observe parameter, and then canonicalizes action updates and invariant
reads through the same relation. Unknown fields, duplicate mappings, stale
adapter versions, `any`/`unknown`, and incompatible scalar or builtin
collection types are rejected. The filter proof accepts only the builtin Array
method, the same concrete array on both sides, one expression-bodied parameter,
and strict inequality. A callback block containing one direct `return` and
declaration-ordered immutable action-local snapshots are also accepted; mutable
captures and general callback statements are not. Other computed conversions, array operations such as
indexed writes/splice/pop or non-zero length assignment, dynamic property paths, and many-to-one
relations remain explicit non-proofs.

`Map(path)` is the corresponding proof-directed representation for a temporal
`Map<K, V>` stored as a mutable builtin `Array<[K, V]>`. Create uses builtin
`Array.from(modelMap)`, observe uses builtin `new Map(runtimeEntries)`, and an
exact builtin `entries.push([key, value])` refines temporal `map.put(key,
value)`. Exact same-array `entries.filter(entry => entry[0] !== key)` refines
`map.remove(key)`, while builtin `entries.some(entry => entry[0] === key)`
refines `map.keys().contains(key)`. The Program-backed checker verifies the
tuple arity and key/value types. `entries.length = 0` refines Map clearing and
`entries.length` refines Map size; temporal `size()` is valid for both Set and
Map receivers. An exact builtin
`entries.find(entry => entry[0] === key)![1]` value read refines
`map.get(key)`. The temporal predicate must still guard that partial lookup
with `map.keys().contains(key)`; the TypeScript non-null assertion is erased
syntax, not proof evidence. Value filtering, entry replacement, duplicate-key
ordering, and general iterable conversions are not yet proofs.

Builtin `entries.every(entry => predicate(entry[1]))` and `some` are projected
to temporal Map value `forall`/`exists` when the callback does not otherwise
observe the tuple or its key. Lambda comparison is alpha-equivalent, so model
and implementation parameter names need not match; free variables remain
distinct.

The common entry-array upsert sequence—filtering one key and then pushing a
pair with the same key—is simplified to one temporal `put`. The simplification
requires exact normalized key equality; filtering a different key preserves
the preceding removal and therefore does not falsely refine a lone `put`.

`validateRefinementBindingCoverage` compares a named adapter manifest with a
parsed temporal model. It reports missing bindings and bindings that refer to
removed action or invariant names. Liveness properties are excluded because an
adapter invariant is a point-state predicate, not a temporal monitor. This is a
structural stale-binding check only: it does not prove that an action function's
assignments implement the corresponding model transition.

`validateRefinementActionBodies` adds a proof for a deliberately restricted
zero-runtime fragment. It normalizes direct runtime-field assignment,
`+=`/`-=`, increment/decrement, and omitted-field stuttering to the temporal
expression AST. A nested scalar member mutation such as
`runtime.lease.epoch++` is lowered to the immutable record update
`{ ...lease, epoch: lease.epoch + 1 }`; redirected member writes therefore
produce an action mismatch. Sequential writes to distinct members are merged
into one record update, while reads of an already-written member observe its
symbolic new value. Record field order is ignored during refinement comparison.
Whole-record assignment may use a TypeScript object literal with zero or one
leading spread, such as
`runtime.lease = { ...runtime.lease, epoch: runtime.lease.epoch + 1 }`.
Additional or non-leading spreads, methods, accessors, and unresolved spread
sources remain non-proofs rather than being approximated.
For collection-valued state, a type-matched native `Set.add(value)` is lowered
to `set.union(Set(value))`, and `Map.set(key, value)` is lowered to
`map.put(key, value)`. This works through record member paths and preserves
earlier symbolic writes. A zero-argument `Set.clear()` or `Map.clear()` is an
exact replacement with `Set()` or `Map([])`. Element/key deletion is supported
without inventing a finite universe: `Set.delete(value)` lowers to
`set.exclude(Set(value))`, while `Map.delete(key)` lowers to the typed temporal
`map.remove(key)` operation. Quint reconstructs the Map from its remaining key
domain, and the Z3 encoding removes the key from the domain while canonicalizing
its hidden value. Collection aliases and dynamically selected calls remain
unsupported. The lightweight `validateRefinementActionBodies` entry point
trusts the annotated TypeScript boundary. Projects that already construct a
TypeScript Program can use `validateRefinementActionBodiesInProgram` (or its
`WithZ3` variant); that path requires the receiver type symbol itself to be the
builtin declaration-file `Set` or `Map`, and conservatively rejects subclasses
and structurally compatible lookalikes. Transparent type aliases and generic
constraints such as `T extends Set<number>` resolve to the builtin declaration
and remain provable.
It can inline local class method calls when every argument
is syntactically available; this supports wrappers such as
`runtime.record("delivered")` and specializes a computed `this[outcome]`
write to the literal field. It also composes an acyclic graph of direct helper
calls. The syntax-only path limits these helpers to same-file declarations; the
Program-backed path resolves aliased imports and further direct calls inside
imported helpers by TypeChecker symbol identity. It also accepts a direct
namespace selection such as `Operations.revoke(runtime, id)` when that property
resolves to a function declaration; ordinary object methods do not qualify.
The first helper argument must
be the current runtime receiver; remaining scalar arguments are snapshotted
symbolically at the call site. The Program path also follows chains of
reassignment-free `const` aliases to a direct helper declaration, including a
namespace selection such as `const operation = Operations.revoke`. Mutable
aliases, recursion, methods, higher-order values, and dynamic dispatch remain
explicit non-proofs. Every model state is compared, so an extra runtime
write is rejected as well as a missing or different write. A terminal void
`return` and a terminal `return helper(runtime, ...)` are composed in root,
helper, and local-method bodies. Nonterminal or branch-local abrupt completion,
general loops, unsupported collection operations, and dynamic computed members produce
`unsupported-action-body`; they are never silently treated as verified.
Multiple writes are executed over a symbolic scalar state in TypeScript source
order before comparison. This both proves cases such as two increments and
rejects a naive two-assignment swap: temporal action assignments are
simultaneous, whereas the second TypeScript assignment observes the first.
Immutable scalar `const` declarations snapshot the symbolic value at their
declaration point, so the conventional three-step temporary-variable swap is
proved against simultaneous model assignments. `let`, `var`, destructuring,
calls, and unsupported initializer expressions remain non-proofs.
Scalar `if`/`else` statements are evaluated from a copy of the incoming
symbolic state and merged field-by-field as conditional expressions. An omitted
`else` is a stuttering branch. The same conditional IR parses TypeScript ternary
syntax in model expressions, emits JavaScript ternaries and Quint `if/else`, is
evaluated during trace replay, and lowers to SMT `ite`. Branch-local abrupt
completion and non-scalar branch state are still unsupported.
An ascending loop of the exact form
`for (let i = START; i < END; i++)` is symbolically unrolled when both bounds
are nonnegative integer literals and the iteration count is at most 64. Each
iteration receives its own substituted index and block-local snapshot scope,
while state writes flow to the next iteration. Dynamic bounds, other update or
comparison forms, `break`/`continue`, and larger loops remain explicit
non-proofs rather than being approximated.
For a guarded model action, the implementation may begin with
`if (!(predicate)) return`; the positive predicate is normalized and must
exactly match `action_when` in the synchronous fast path. Missing, different, and unexpected guards are
separate diagnostics. The false path therefore stutters and the true path is
checked by the same update proof. Other branching forms and logically
equivalent but differently shaped guards can use the opt-in asynchronous
`validateRefinementActionBodiesWithZ3` path. It asks Z3 whether the normalized
predicates differ for any typed state; only `unsat` discharges the mismatch.
`sat` remains a mismatch and solver `unknown` remains an explicit non-proof.
Updates themselves remain syntactic in this API. This check covers transition
updates and this early-return guard fragment, not arbitrary control flow.

`validateRefinementInvariantBodies` checks the adjacent safety-property
functions. A supported implementation consists of zero or more immutable local
`const` declarations followed by exactly one `return`. Initializers and the
returned expression may use runtime scalar fields, integer/boolean literals, arithmetic, strict
equality, comparisons, `&&`, `||`, `!`, and unary minus. Its normalized AST must
exactly equal the temporal property AST. Loose JavaScript equality is rejected
because coercion would make the correspondence unsound. An acyclic graph of
direct calls to function declarations is inlined only when every
helper has exactly one expression-bearing `return`, identifier parameters, and
matching arity. The syntax-only API is limited to same-file declarations. A
TypeScript Program may instead be passed to
`validateRefinementInvariantBodiesInProgram` (or its `WithZ3` variant); this
resolves imported helpers and reassignment-free `const` function aliases by
symbol identity. Direct namespace-import selections such as
`Predicates.valid(runtime.epoch)` are also accepted when the selected property
resolves to a function declaration. Native `Set.has(value)` and the `Set.size`
property normalize to temporal `set.contains(value)` and `set.size()`.
In the Program-backed path, a builtin `Map.has(key)` receiver is distinguished
by TypeChecker symbol identity and normalizes to the explicit temporal form
`map.keys().contains(key)`.
Builtin `Map.get(key)` normalizes to temporal `map.get(key)`. The temporal
property must conjunctively establish `map.keys().contains(key)` first; this
keeps JavaScript's possibly-`undefined` lookup outside the proved value domain.
The Program-backed path also recognizes the exact builtin patterns
`Array.from(set).every(value => predicate)` and
`Array.from(map.keys() | map.values()).every(value => predicate)`. The source
must be a builtin `Set` or a TypeChecker-identified builtin `Map` iterator.
They normalize to the corresponding temporal finite view followed by
`forall(value => predicate)`. The callback parameter is a
real bound temporal name, so a subset check such as
`allowed.has(value)` cannot be confused with a constant member check. The
element may be a closed record, and field predicates such as
`lease => !lease.valid || lease.epoch > 0` retain their field structure.
Expression callbacks and blocks containing exactly one expression-bearing
`return` are accepted. A callback block may precede that return with
reassignment-free `const` declarations; their initializers are normalized in
declaration order and may refer to the bound element or earlier constants.
`let`/`var`, mutation, non-declaration statements, and abrupt control flow
remain unsupported.
The same collection views accept existential predicates: builtin
`Array.from(setOrMapView).some(predicate)` normalizes to temporal `exists` and
is checked by the Quint, runtime-assertion, and Z3 backends. As with `every`,
method identity is resolved through the TypeChecker rather than trusted by
spelling.
The
syntax-only API and custom/shadowed `Array.from`, `keys`, `values`, or `every` methods remain
unsupported rather than being trusted by spelling.
Receiver identity is established by the separately required Program-backed
create/observe shape check; this predicate pass proves the expression mapping,
not every builtin symbol identity in isolation. Mutable aliases, ambiguous lexical call
names, recursion, ordinary object methods, dynamic dispatch,
statement-bearing helpers, mutable local
declarations, mutation, other collection operations, and merely logically equivalent but differently
shaped predicates fail the synchronous fast path. The asynchronous
Z3 variants discharge a normalized mismatch only
when Z3 proves the two normalized boolean expressions equivalent over all typed
states. They do not make statement-bearing helpers, mutable declarations,
mutation, or additional collection operations supported, and preserve `unknown` as a diagnostic.
Multi-layer scalar and runtime-object argument substitution is supported for
this single-return fragment. Missing and stale invariant bindings are
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
treated as model state. An acyclic graph of direct single-argument calls to
function declarations may wrap either endpoint when every call passes the
current create/observe receiver. The syntax-only API limits this graph to
same-file declarations. `validateRefinementStateProjectionInProgram` resolves
imported wrappers and reassignment-free `const` aliases by TypeChecker symbol
identity. A direct namespace-import selection is accepted when its property
resolves to a function declaration. Mutable aliases, recursion, ordinary
object methods, and dynamically dispatched wrappers remain non-proofs. A record-valued temporal
state may also be rebuilt recursively as an object literal. The validator uses
the declared temporal record shape and accepts the reconstruction as identity
only when every nested field is present exactly once and reads the corresponding
runtime path. Missing, extra, or redirected fields remain mismatches. Arbitrary factories, nested collections, computed dynamic
keys, defaults, and non-identity abstraction functions remain unsupported.

The Program-backed path also checks the first parameter and inferred or
declared return type of both endpoints against the complete temporal state
shape. Integer state requires a TypeScript number domain, Boolean state requires
boolean, and nested records require every same-named field recursively. `any`,
`unknown`, optional or missing fields, and scalar-kind mismatches produce an
explicit `create-type-mismatch` or `observe-type-mismatch`; expression identity
alone cannot discharge them. Temporal Set/Map state additionally requires the
exact builtin TypeScript collection declaration and recursively compatible
element, key, and value types. Transparent type aliases are accepted;
`ReadonlySet`/`ReadonlyMap`, subclasses, and structurally compatible lookalikes
are rejected. Non-identity abstraction between runtime collections and model
collections remains unsupported.
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
/* uneffect:assert amount: Nat */
function deposit(amount: Nat) {}
```

The instrumenter emits a `valibot` import and `parse` call. A safe subset of explicit Valibot expressions is supported:

```ts
/* uneffect:assert name: v.pipe(v.string(), v.nonEmpty()) */
```

Arbitrary callbacks and executable expressions are rejected. Instrumentation changes runtime behavior and the thrown-error surface, so its build-profile setting must be included in proof artifacts.

Linked `defineContract` specifications use the same opt-in profile. Uneffect
can lower arithmetic/comparison/Boolean `requires` and `ensures` expressions,
plus `Nat` and finite `Float` result validation. Multiple branch returns are
checked independently and nested function exits are not attributed to the outer
function. Async return expressions are checked through a Promise reaction;
original rejections propagate, including across a surrounding synchronous
try/catch, while a failed postcondition becomes a separate rejection. Adding
that reaction can change microtask timing, so exact schedule identity is not
claimed.
Uneffect does not import or execute the specification module. Function calls
and property access in predicates, bare returns, and fallthrough in the
supported structured CFG are rejected rather than silently omitted. The CFG
summary composes switch fallthrough, try/finally override, loops, labels, and
targeted break/continue. TypeChecker-resolved direct `never` calls and Boolean
literal condition types provide a bounded semantic reachability refinement;
same-named `void` calls are not trusted. Generator and AsyncGenerator contracts
check only their final return. Generated failures carry an `uneffect` metadata
object with the source file, exact local directive line/column/span, contract
kind, and expression. Cross-file provenance back to the originating linked
`.uneffect.ts` clause remains future work.

## Logical contracts

```ts
/* uneffect:requires n >= 0 */
/* uneffect:ensures result == n */
function count(n: number) {
  let i = 0
  /* uneffect:loop_invariant i >= 0 && i <= n */
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
source span. An exported runtime class whose method body participates in
refinement must use `trust dispatch-sealing <reason>`: this declares that the
application owns the relevant class graph. It is recorded as `trusted`, never
`verified`, and does not hide Program-visible subclasses. Other proof domains
do not yet expose a general-purpose `sorry`.

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

Ownership verifier executions use the `ownership-evidence/v2` artifact. It
binds backend version, concrete native/WASM runtime, preserved infrastructure
attempts, and output to hashes of both the obligation and generated program.
Only Z3 `unsat` or a successful exhaustive Quint verification is
proof-grade; missing backend dependencies, unknown, and counterexamples remain
unknown evidence.

Lexically disposed resources have a separate retention contract:

```ts
/* uneffect:retains_resource 0 */
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

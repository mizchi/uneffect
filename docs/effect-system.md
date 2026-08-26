# Uneffect effect system

Status labels used in this document:

- **Implemented**: covered by the current prototype and regression tests.
- **Decided**: part of the intended contract but not necessarily implemented.
- **Exploratory**: a direction that still needs a counterexample-driven design pass.

## Purpose

Uneffect adds gradual effect specifications to existing TypeScript without changing JavaScript evaluation or requiring an Effect runtime. Comments form a contract layer that can be adopted function by function.

```ts
/* uneffect: effect Console | Fetch */
async function main() {
  console.log("start")
  await fetch("https://example.com/")
}
```

The declaration is an upper bound. If `actual(f)` is the effect set inferred from the body and reachable callees, and `allowed(f)` is the declaration, the check is:

```text
actual(f) <= allowed(f)
```

Missing effects are errors. Declared but unobserved effects are warnings because a smaller effect set is a valid implementation of a wider contract. **Implemented.**

An unannotated boundary is unknown, not pure. Uneffect may report locally inferred candidates, but an unresolved call, `any`, dynamic dispatch, `eval`, or an unknown native boundary prevents a verified closed summary. **Decided.**

## Effect algebra

Effects are structured values, not arbitrary display strings. The initial algebra contains:

```text
Capability(name, arguments)
Mutate(region)
Throw(errorType)
Unknown(reason)
```

The TypeScript specification IR wraps each parsed effect in `{ value, span }`, where `span` contains exact UTF-16 source offsets into the original file. Parse failures include file, line, and column. The Rust core exposes `SourceSpan { file_id, start, end }` using UTF-8 byte offsets and a `LocatedEffectSet` that preserves source order separately from the deduplicated semantic `EffectSet`. `ParseEffectError` carries the offending member span. The versioned Corsa JSON consumer now accepts resolved symbol/type/overload/call/trivia records and preserves this byte-coordinate contract. **Implemented in both prototype layers.**

Composition is a join:

```text
effect(call f)     = summary(f)
effect(a; b)       = effect(a) join effect(b)
effect(if a b)     = effect(a) join effect(b)
effect(callback f) = summary(f), unless invocation timing is proven otherwise
```

`Mutate<typeof value>` refers to the identity region selected by a symbol, not the structural TypeScript type of `value`.

```text
Mutate<typeof state> permits Mutate<typeof state.user>
Mutate<typeof left> does not permit Mutate<typeof right>
```

Inference names the region a write actually touches, down to the property:
`state.calls = 1` infers `Mutate<typeof state.calls>`, and `state.items.push(x)`
infers `Mutate<typeof state.items>` — the receiver the builtin mutates. A
declaration of any prefix still permits it, so `Mutate<typeof state>` covers
both; a declaration of a sibling property does not, and the diagnostic says so
rather than only reporting an undeclared effect.

An element access is only as precise as its key. A literal key is a property, so
`table["ready"] = v` infers `Mutate<typeof table.ready>`. A computed key names no
member the checker can compare, so `values[index] = v` widens to
`Mutate<typeof values>` — which is why the quicksort dogfood still proves exactly
`Mutate<typeof values>`.

Parameter regions are substituted at call sites. **Implemented across TypeChecker-resolved program edges, including aliases, methods, arrows, overloads, and callbacks.** Across project-reference boundaries, verified child summaries retain declaration-order parameter names and instantiate parameter-rooted regions through resolved import aliases. The cross-project verified fragment accepts identifiers, `this`, property chains, and string-literal element chains as arguments. A function that mutates an exported closed-over binding can also cross the boundary: Uneffect records a project/source/export identity, verifies the corresponding declaration in the parent's `.d.ts` Program, and substitutes only a named or namespace import resolving to that exact symbol. A same-named import from another module, an inaccessible/non-exported root, missing/spread argument, call result, computed element, destructuring parameter, or module-initialization mutation remains `unknown`; Uneffect does not guess heap identity. The current escape filter proves freshly declared locals non-observable; deeper heap escape analysis remains conservative.

`Throw<E>` is covariant over known `Error` subtypes. `Throw<Error>` admits a concrete error such as `Throw<RangeError>`, but does not admit `Throw<unknown>`, which represents JavaScript throwing a value not proven assignable to the global `Error` interface. The frontend performs that subtype check with the TypeChecker, including constrained type parameters. A synchronous `catch` discharges all `Throw<E>` effects originating in its `try` block. Throws from the `catch` or `finally` block still propagate.
The program call graph carries this discharge fact on synchronous direct and
inline-callback edges, so imported callees behave like local calls. Deferred or
unknown-timing callbacks do not inherit the surrounding lexical `catch` because
they may execute after that handler has returned.
Implicit disposal calls introduced by `using` and `await using` carry the same
lexical catch fact. A disposer `Throw<E>` therefore propagates from an uncaught
scope and is discharged when completion of that scope is enclosed by a catch.
An `async function` is also a semantic boundary: a direct throw, or a
synchronous callee/disposer throw inside it, rejects the returned Promise rather
than throwing from the function call. Uneffect therefore stops `Throw<E>` at
that owner boundary and leaves rejection observation to async-safety analysis.
Generator bodies are delayed in the same spirit but retain synchronous step
effects: constructing an iterator does not propagate its body summary, while a
resolved direct `.next()`, `for..of`/`for await`, `yield*`, spread, destructuring,
`Array.from`, `Object.fromEntries`, standard collection/typed-array construction,
or a standard Promise combinator consumption does. Built-ins are recognized by
their TypeScript standard-library signature, so a shadowed API with the same text
does not acquire these semantics. Promise combinators turn a generator-body
`Throw<T>` during iteration into rejection; synchronous effects of evaluating the
factory argument itself remain ordinary effects.
The Program path follows imported generators and a directly stored local
iterator binding by symbol identity. Acyclic factories whose sole terminal
returns are resolved generator/factory calls are specialized at direct
consumption sites, including sequential early returns, exhaustive `if` branches,
and conditional expressions. Every normal return path must resolve; candidates
are unioned while the factory's own immediate body effects remain on the normal
call edge. Immutable local aliases such as `const forwarded = iterator` preserve
the iterator identity. One-level local object slots with identifier, string, or
numeric literal keys also preserve it through local root aliases. Dynamic keys,
nested or escaped objects, collection storage, and opaque consumer APIs are not
proof that their transitive effects were checked.
When a direct consumption call has an iterator-like `next` type but its factory
cannot be completely resolved, the Program summary becomes `evidence:
"unknown"`; this status propagates through callers. Non-iterator collection
factories are not degraded by this generator-specific check.
The same unknown evidence is retained when that iterator is first stored in an
immutable local binding or forwarded through immutable local aliases.
Calling `.next()` through an unresolved iterator parameter or property is also
unknown and propagates through callers. Iterators created by standard-library
factories such as `Array.prototype.values` are tracked as pure through immutable
local aliases, avoiding an unknown result merely because they are stored first.
Functions that directly consume iterator parameters expose an iterator-effect
parameter contract in the Program call graph. Calls with a resolved generator
factory or immutable binding are specialized to the generator body effects; a
standard pure iterator contributes no effect, and an opaque argument remains
unknown. Parameter-derived unknown evidence is tracked separately from intrinsic
unknown consumption, so specializing every iterator parameter never hides an
unrelated property escape or dynamic factory inside the consumer.
Direct, symbol-resolved wrapper calls forward these iterator-effect parameters
transitively, including whether a Promise iterable consumer converts a yielded
`Throw` into rejection. Recursive or dynamically dispatched forwarding that
cannot establish the contract remains outside this inference.
The same relation crosses a TypeScript project-reference boundary only when the
child summary is `verified` and every consumed iterator parameter has a checked
`effect_parameter` bound. The parent Program then specializes resolved generator
factories, supported stored iterators, forwarded parameters, and standard pure
iterators against that bound. Bound violations are parent diagnostics; opaque
arguments are `unknown`. A Promise-consuming child parameter retains
`convertsThrowToRejection`, so the generator's synchronous non-throw effects
propagate while its iteration throw is owned by rejection analysis. **Implemented.**
The effect summary exposes the same contract as `iteratorEffectParameters` and
uses `evidence: "inferred"` for an unannotated polymorphic consumer. This is not
a closed proof that the function is effect-free: its lazy effects are supplied
by each call site. Bound it separately from the function body's effects:

```ts
/* uneffect:
 * effect InvokeUserCode
 * effect_parameter iterator extends Console | Throw<Error>
 */
export function consume(iterator: IteratorObject<unknown>) {
  return Array.from(iterator)
}
```

`effect_parameter <name> extends <Effect union>` follows TypeScript constraint
terminology but remains comment trivia. The Program analyzer checks resolved
Generator factories and stored iterator identities at every call site. It also
follows symbol-resolved parameter forwarding: a wrapper bound must be contained
by every downstream bound, and a concrete Generator is checked against every
reachable constraint. Promise iterable consumers preserve rejection conversion,
so a synchronous Generator `Throw` does not need to appear in the bound after
it is converted to rejection. Malformed syntax, an unknown/non-iterator
parameter, duplicate bounds, unknown effects, incompatible forwarding, opaque
arguments, and out-of-bound instantiations fail closed. Fully bounded consumers
can be `verified`; partially or wholly unbounded consumers remain `inferred` or
`unknown` according to the remaining evidence.
Simple mutable local bindings are flow-sensitive. A straight-line assignment
kills the previous iterator state and replaces it with the classified RHS;
assignments under branches, loops, switch, or try/catch join generator targets,
standard pure alternatives, and opaque uncertainty. This is a source-order
may-analysis rather than a general CFG fixed point; complex labeled control flow
remains unsupported. The same kill/join rule applies to the supported local
object slots. This is deliberately not an object-shape or alias analysis:
computed dynamic properties, nested objects, parameter objects, and objects that
escape the function remain unknown boundaries.

## Domain effects and semantic footprints

Uneffect keeps two related layers:

1. Domain effects describe architectural authority: `Console`, `Fetch`, `Dom`, `FsRead`, or a user-defined effect.
2. Semantic footprints describe optimizer-relevant behavior: reads, writes, allocation, throws, suspension, divergence, nondeterminism, invocation of user code, ownership transfer, and invalidation.

A builtin contract expands one API operation into both layers.

```text
console.log       => Console + Write(ConsoleSink)
Math.random       => Random + Nondeterministic
fetch             => Fetch(...) + Read(Network) + Write(Network) + Nondeterministic
throw new E       => Throw<E> + Throws
await             => Suspend
worker.postMessage(message, transfer)
                   => Worker(Post, receiver) + Clone(message)
                    + Transfer(each transfer item) + Invalidate(each transfer item)
```

`computes` is not an additive effect. It is a proof-level guarantee requiring no mutable reads or writes, observable allocation, throws, suspension, divergence, nondeterminism, proxy/getter callbacks, or observable coercion. **Decided.**

## Scoped effects

Some authorities carry finite operation sets and scope languages.

```ts
/* uneffect: effect Fetch<GET | POST, "https://api.example.com/v1/**"> */
```

All parameterized capabilities share one representation:

```ts
type Capability = {
  name: EffectName
  arguments: CapabilitySet[]
}

type CapabilitySet =
  | { kind: "all" }
  | { kind: "finite"; atoms: CapabilityAtom[] }
  | { kind: "unknown"; reason: string }
```

The set algorithms are common. An effect schema assigns a domain and containment relation to each argument:

```text
Fetch:   [EnumSet<HttpMethod>, UrlSet]
FsRead:  [PathSet]
Net:     [HostSet]
Env:     [EnvNameSet]
Dom:     [EnumSet<DomOperation>, RegionSet]
```

This keeps parsing, union, subset, unknown propagation, diagnostics, and serialization uniform. Only atom normalization and `covers(allowedAtom, actualAtom)` are domain-specific. **Implemented in the TypeScript prototype and Rust core.** Both implementations use versioned schemas. The Rust `EffectSchemaRegistry` is passed to `EffectSet::parse_with_schemas`, allowing a Corsa adapter to register user effects such as a two-argument `app.Api<TokenSet, UrlSet>` without adding name checks to the parser or lattice.

Subtyping is component-wise:

```text
Scoped(AOps, AScopes) <= Scoped(BOps, BScopes)

iff AOps is a subset of BOps
and Language(AScopes) is a subset of Language(BScopes)
```

Glob syntax is deliberately restricted. `*` does not cross `/`; `**` does. Unsupported or unprovable pattern inclusion yields unknown and cannot satisfy a restricted authority. Redirect authority is not implied by request-URL authority. **Both lattices implement finite operation sets, exact URL paths, segment-aware `*`/`**`, default-port and dot-segment normalization, conservative inclusion, forbidden fragments/wildcard authorities, and exact-when-present versus unconstrained-when-absent queries.**

DOM uses identity regions as proof-grade authority scopes. CSS selectors may be recorded as query refinements, but selector matching is state-dependent and selector-language inclusion is unsuitable as the primary security boundary. See [builtin contracts](./builtin-contracts.md).

## Evidence

Every summary carries provenance:

```ts
type Evidence =
  | "verified"  // body and all relevant callees checked
  | "trusted"   // external declaration explicitly trusted
  | "inferred"  // useful candidate with an unknown boundary
  | "unknown"
```

Lint may consume trusted declarations. Optimizers may consume only verified summaries or declarations covered by an explicit trust policy. Artifacts must include the source hash, compiler/Corsa revision, tsconfig hash, builtin-contract version, and Uneffect version.

## Temporal IR

The ordinary effect set answers what may happen but erases order. Optimization and ownership checks use an ordered IR:

```text
Read(region)
Mutate(region)
Invalidate(region)
External(effect)
Suspend(invalidatedRegions)
Transfer(region, target)
```

Events carry a phase. Suspension starts a new phase and invalidates facts about regions that may escape to concurrent code. It does not invalidate proven local regions indiscriminately. The existing Rust `EffectTrace` implements the first five events except ownership transfer. See [formal models](./formal-models.md).

## Optimization boundary

Effect information is useful only when each transformation states its proof obligations.

| Transformation | Minimum obligations |
|---|---|
| Remove unused call | computes and terminates |
| Common subexpression elimination | stable reads and no overlapping write/invalidate |
| Reorder calls | non-interfering footprints; no throw, suspend, or user-code callback |
| Memoize | computes, deterministic, and defined argument equality |
| Property mangle | closed world; no reflection, proxy, dynamic key, metadata, or external consumer |
| Eliminate branch | condition proved and removed branch has no required observation |

Unknown or merely inferred summaries stop optimization. A domain label such as `Console` alone is not evidence that every unlisted observation is absent.

## Architecture

```text
Corsa symbols, types, overloads, and trivia
                  |
                  v
Rust frontend: call graph + builtin contract instantiation
                  |
                  v
Rust core: effect lattice + regions + temporal/ownership IR
          |                    |
          v                    v
 diagnostics             verified artifact
                               |
                               v
                     compressor / mangler
```

Z3 is invoked only for functions carrying logical contracts. Temporal interleavings and ownership state machines belong in Quint/TLA+-style models rather than being encoded as unconstrained SMT problems.

## Known hard boundaries

- Higher-order functions need effect polymorphism and invocation timing.
- Getters, proxies, coercions, decorators, and custom element reactions can invoke user code.
- Promise rejection is not the same as synchronous `Throw<E>`.
- Creating a Promise is not the same as suspending at `await`.
- DOM selector containment is not a practical authority lattice.
- Transferable objects require flow-sensitive state, not only a may-effect set.
- Redirects, URL canonicalization, and dynamic request construction complicate Fetch scopes.
- `any` and unresolved calls must never be interpreted as an empty effect.

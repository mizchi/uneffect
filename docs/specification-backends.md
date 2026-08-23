# Specification categories and verifier backends

Uneffect organizes specifications into three primary categories. They share source attachment and symbol resolution, but they do not share a single proof procedure.

## 1. Capability effects

Capability effects answer:

> Which operations may this computation perform, and over which authority scope?

Examples include `Console`, `Mutate<typeof state>`, `Throw<E>`, scoped Fetch access, DOM operations, and Worker messaging.

```ts
/* uneffect: effect Fetch<GET, "https://example.com/**"> | Console */
```

The core judgment is lattice inclusion:

```text
inferred capability <= declared capability
```

This category is normally checked by the Uneffect lattice and builtin contract registry. Z3 is unnecessary for finite operation sets and restricted glob-language inclusion. A solver may be used only when a user-defined capability domain introduces relational constraints.

## 2. Invariants and sequential contracts

This category answers:

> Is a predicate established and preserved for every represented sequential execution path?

It includes preconditions, postconditions, loop invariants, representation invariants, and optional refinements.

```ts
/*
 * uneffect:
 * requires x >= 0
 * ensures result > x
 */
function inc(x: number) {
  return x + 1
}
```

The backend lowers TypeScript expressions and a restricted SSA-like function model into SMT proof obligations. To prove `ensures`, it asks Z3 whether the negation is satisfiable:

```text
requires AND bodyRelation AND NOT ensures
```

`unsat` proves the obligation within the encoded model. `sat` is a counterexample candidate. `unknown` is never treated as a proof.

The direct Z3 verifier and SMT-LIB generator consume the same version-neutral `InvariantObligation` IR. The lowerer creates one stable, source-mapped obligation for each branch postcondition and for loop initialization and preservation. Loop exit assumptions feed the following postcondition.

`Int` maps to Z3 `Int`. `Nat` maps to `Int` plus a non-negativity assumption. `Float` maps to `Real`, which excludes JavaScript's `NaN` and infinities but intentionally abstracts away IEEE-754 rounding. Therefore a Float result is a proof of the real-arithmetic abstraction, not yet a bit-precise JavaScript floating-point proof.

Every solver result is recorded as a machine-readable artifact with an obligation ID, source span, and status. `sat` includes the raw model and parsed assignments. `unknown` and unsupported TypeScript constructs are explicit non-proofs. Calls without a verified function summary are unsupported rather than assumed pure.

## 3. Temporal logic and ownership protocols

This category answers:

> Which state transitions and event orders are possible, and which safety or liveness properties hold over them?

It covers async invalidation, lifecycle protocols, retries, cancellation, Worker transfer ownership, event ordering, and eventually/always properties.

```ts
/*
 * uneffect:
 * state epoch: int
 * state cacheValid: bool
 * init epoch = 0
 * init cacheValid = false
 * action suspend: epoch' = epoch + 1, cacheValid' = false
 * temporal cacheIsSound: !cacheValid || epoch === 0
 */
```

The prototype generates a Quint module containing variables, an `init` action, named actions with explicit or generated stuttering assignments, a nondeterministic `step`, and named safety predicates. Quint simulation supplies fast counterexamples. Exhaustive verification remains a separate Apalache/TLC CI tier.

The first collection-valued slice accepts `state nodes: Set<int>` (and
`Set<bool>`), with TypeScript-shaped expressions `Set(1, 2)`,
`left.union(right)`, `set.contains(value)`, `set.size()`, and
`set.forall(value => predicate)`. The same expression AST lowers to Quint and
to optional JavaScript assertions (`Set`, `has`, and `Array.from(...).every`).
Sets must be homogeneous and quantified predicates must be boolean. Z3 encodes
scalar-element Sets as total boolean arrays, with union, membership, and
`forall` lowered without weakening the predicate. Semantic lint and bounded
reachability use the full array semantics. Counterexample traces enumerate the
scalar literals present in the model as a finite observation universe; current
init/update expressions can only construct and union those literals, so that
observation is complete for this fragment, including signed integer literals.
If a Set constructor receives a state-derived value such as `Set(owner)`, the
array semantics remain available to semantic lint and bounded reachability,
but counterexample extraction reports `unknown`: it does not hide members that
fall outside the literal observation universe. Sets of non-scalar elements use
the full Z3 semantics for lint and reachability, but their counterexample
enumeration remains explicit `unknown`.

`Set.size()` remains available to Quint and runtime assertions, but is not
silently approximated by the Z3 array encoding: an integer-indexed Boolean
array can denote an infinite Set, so cardinality needs a separate finite-domain
contract. Z3 semantic lint and reachability return an explicit unsupported
diagnostic for such a model, and counterexample extraction returns `unknown`.

Scalar `Map<int | bool, int | bool>` state is also supported through ordinary
TypeScript construction (`Map([[key, value]])`), immutable `put`, and finite
`keys()`/`values()` views. Quint has no direct `values` builtin, so lowering uses
`map.keys().map(key => map.get(key))`; this keeps every generated `get` inside
the map's known domain. User-written `map.get(key)` is accepted only when the
same conjunction contains the structurally matching
`map.keys().contains(key)` guard. An unguarded lookup is a specification error,
not an `undefined` value silently coerced into the declared Map value type.
Action assignments may instead establish the same guard in `action_when`.
Replay throws if a supposedly guarded key is absent. Runtime lowering constructs a fresh JavaScript `Map`, so
assertion evaluation does not mutate application state.

Z3 represents each Map type as a datatype containing a Boolean domain
array and a separate total value array. This prevents the value at an absent
key from leaking into `keys()` or `values()`. `put` updates both arrays,
`keys()` projects the domain, and `values()` is the existential image of the
value array over present keys. A guarded `get` selects the value array; the
required domain guard prevents its canonical absent-key value from becoming
observable. Semantic lint and bounded reachability use that
full meaning, including recursively supported collection or record values.
Counterexample extraction observes literal keys, recursively evaluates values,
and emits stable JSON entry arrays such as `[[1, 0], [2, -1]]`. A state-derived
key in `Map(...)` or `put(...)` keeps solver reasoning available but makes trace
extraction return `unknown`, because the literal key universe is no longer
complete. Values need not be literals because they are evaluated directly at
each observed present key.

Closed TypeScript-style records are supported as state types and values, for
example `{ owner: int, valid: bool }` and `{ ...lease, owner: 2 }`. Field reads
remain ordinary `lease.owner` expressions. Quint lowering uses record literals,
field access, and `.with("owner", value)`; runtime assertions use JavaScript
object literals and spread. Record fields and Map values may themselves contain
supported collection or record types. Record shapes are exact, optional fields
and dynamic property access are rejected. Z3 assigns canonical datatypes to
closed records and recursively declares their supported field sorts; field
reads and immutable spread updates retain their ordinary structural meaning,
and counterexamples are emitted as nested JSON objects. Counterexample
extraction remains unavailable when a nested Set itself has non-scalar
elements.

For bounded safety exploration, the direct Z3 backend unrolls the same neutral
actions, adds a solver-visible action selector per transition, and searches
depths in ascending order. A satisfiable negated property therefore yields the
shortest trace at or below the configured bound, including concrete states and
action names suitable for TypeScript refinement replay. `safe-within-bound`
remains a bounded result; `unknown` is never promoted to safety.

Bounded action-unreachability remains depth-labelled. Uneffect additionally
emits `inductively-unreachable-action` only when the action guard is excluded
by init and `!guard && step => !guard'` is valid for every transition. This is
an unbounded invariant proof. If that one-step induction fails, callers may
select declared temporal properties as strengthening invariants through
`strengtheningProperties`, or the CLI's comma-separated
`--strengthening=name,...`. Uneffect first proves each selected property at
init and across every one-step transition. Only proven properties, or their
conjunction, may produce `strengthened-unreachable-action`; rejected and
unknown names remain diagnostics. Uneffect does not infer an unstated
strengthening invariant.
With `discoverStrengtheningProperties: true` or CLI
`--discover-strengthening`, every declared temporal property is considered as
a candidate. Candidates are still admitted only after the same initialization
and preservation proofs; rejected discovered candidates are silent, while an
invalid explicitly requested hint is diagnostic.
`synthesizeStrengtheningProperties: true`, exposed as CLI
`--synthesize-strengthening`, adds a deliberately small template pool:
integer sign boundaries around zero and boolean polarity. Every generated
candidate is subjected to the same init/preservation proof before use. This is
useful for counters and epochs; relational and collection templates remain
separate opt-ins.
Pairwise integer equality and ordering templates are available through the
separate `synthesizeRelationalStrengtheningProperties` option and
`--synthesize-relational-strengthening`. They are isolated because candidate
count grows quadratically with integer state count. When both states have
constant integer initializers, it also generates equality/order templates at
their initial affine boundary. The pool includes coefficient-1 offsets such as
`left === right + 2` and the reduced small-coefficient pairs `(2,1)` and
`(1,2)`, allowing relations such as `2 * used <= capacity`. Arbitrary
coefficients, conjunction discovery, and general polyhedra remain unsupported.
The same opt-in includes bounded conservation equalities such as
`accepted + dropped === attempted`, with an offset derived from constant
initializers. The default maximum arity is three, preserving the original
quadratic-sized use case. Set `relationalStrengtheningMaxArity` or CLI
`--relational-max-arity=N` to consider larger partitions, up to the hard safety
limit of six variables. Conservation generation stops after 256 candidates by
default; configure `relationalStrengtheningCandidateLimit` or
`--relational-candidate-limit=N` when a reviewed model needs a different bound.
These bounds apply to conservation candidates, while the existing pairwise
pool remains quadratic. Coefficients other than one and general polyhedra are
not inferred by this template.
Same-shaped Set, Map, and record pairs have a separate equality template pool
behind `synthesizeCollectionStrengtheningProperties` and
`--synthesize-collection-strengthening`. The same opt-in recursively discovers
Set fields and derives finite Set views from `Map.keys()` and scalar
`Map.values()`, then proposes both subset directions. Composite Map values,
arbitrary quantified predicates, and general field relations remain
unsupported. Every candidate in every pool still requires independent init
and transition-preservation proofs.

`examples/dogfood/telemetry-capacity.ts` exercises the scaled fragment with a
hand-authored batching model. The balanced action preserves
`2 * accepted === byteBudget`; changing budget growth from two units to one
removes the synthesized strengthening evidence and yields a one-step Z3
counterexample to `withinCapacity`. The adjacent TypeScript class mirrors the
model for review, but Uneffect does not yet prove an implementation-to-model
refinement binding for these fields and updates.

`examples/dogfood/telemetry-accounting.ts` applies the three-variable template
to accepted, dropped, and attempted telemetry counts. Omitting the dropped
counter update prevents the candidate from being admitted. As with the capacity
example, the adjacent TypeScript class is reviewable correspondence rather than
a proved implementation-to-model refinement.

`examples/dogfood/telemetry-routing-accounting.ts` opts into arity four and
checks that every attempted telemetry item is classified as delivered, dropped,
or buffered. Its negative test removes the buffered-counter update, after which
the conservation candidate is rejected. The neighboring TypeScript class and
adapter exercise the supported scalar refinement fragment rather than a general
implementation proof. They bind create, observe, every action, and the invariant
through refinement annotations;
the dogfood coverage check catches missing and stale model names. Its
straight-line action bodies are also checked against the model assignments:
literal calls to `record` are locally specialized, including the computed
outcome-field write. The conditional audit transition is routed through a
same-file action helper, exercising acyclic direct-call composition. The guarded observation action enforces its exact
`action_when` predicate with a negated early return before the stuttering body.
The adjacent single-return invariant function reaches its predicate through an
immutable alias to an imported helper. The Program-backed refinement validator
resolves that symbol, follows its private outcome-count helper while preserving
the runtime-object argument, and checks exact normalized scalar-AST equivalence;
the syntax-only API deliberately cannot prove this boundary. Create and observe are
additionally checked as independent identity field projections: the transparent
local-class `Object.assign` construction and destructured observation preserve
all five model state fields through same-file hydrate/snapshot wrappers. General abstraction relations, runtime validation
of hostile object inputs, and solver-proven equivalence of differently shaped
predicates remain unsupported.

`examples/dogfood/lease-projection.ts` exercises a Node Lease-shaped nested
record boundary. Both hydrate and snapshot wrappers reconstruct the complete
`owner`/`epoch`/`valid` record, while the negative case removes `valid` and is
reported as an observe projection mismatch. Its `renew` transition also proves
that a concrete TypeScript object-spread replacement refines the model's
immutable record update; replacing the epoch override with owner is reported as
an action mismatch. The
`takeover` transition updates owner and epoch in two TypeScript statements and
is normalized to one order-independent temporal record update. Omitting either
member write fails refinement. The hydrate and snapshot implementations live
in a neighboring module; the Program-backed projection validator resolves both
imported symbols before checking the nested identity mapping. It also checks
that both endpoint parameter and return types contain the complete nested
number/boolean temporal shape, rather than trusting an `any` identity adapter.

`examples/dogfood/lease-authority-refinement.ts` binds a Node Lease-shaped
authority record containing native Set and Map instances. Concrete `Set.add`
and `Map.set` calls refine immutable temporal `union` and `put` transitions;
`Set.clear` and `Map.clear` refine exact empty-collection replacements.
`Set.delete` refines Quint `exclude`, and `Map.delete` refines removal from the
map key domain. Admitting or deleting the wrong owner, or clearing the wrong
authority field, is detected as an authority action mismatch. The lightweight
syntax API still trusts receiver identity at the annotated boundary; the
Program-backed API resolves the receiver type symbol and rejects collection
subclasses and same-shaped user types. Its Node Lease dogfood also resolves an
aliased import through a two-level helper graph before proving an owner-removal
transition. The imported function is reached through an immutable local
function-value alias; changing that alias to `let` makes the body a deliberate
non-proof. A separate transition exercises direct namespace-import selection;
the dogfood now stores that selected function in an immutable alias, while the
equivalent mutable alias is a tested non-proof. The
syntax-only API deliberately leaves those imported calls
unsupported.
The same dogfood now runs create/observe projection through the Program path:
the nested owners and epochs fields must be exact builtin `Set<number>` and
`Map<number, number>` shapes as well as identity projections.

For finite state products, bounded exploration can itself become complete.
Uneffect computes exact cardinalities for boolean scalars and supported finite
record, `Set`, and boolean-keyed `Map` shapes. If the requested depth reaches
`stateCount - 1`, every reachable guard has a simple path within that bound,
so an absent guard is reported as `finite-state-unreachable-action`. Integer
domains, cardinality overflow, and shallower runs retain only bounded evidence.

Property vacuity follows the same split. `bounded-vacuous-property` means the
referenced state did not change on any reachable transition within the chosen
depth. `inductively-vacuous-property` is added only when init establishes the
property and no typed transition can change any referenced state at all. An
unreachable mutating transition prevents this promotion until a strengthening
invariant can justify excluding it.
When verified strengthening properties exclude every transition that could
change the referenced state, the checker emits
`strengthened-vacuous-property`. This is an unbounded frozen-state result under
the reported inductive properties, not a general proof of useful liveness.

Standalone TLC output is normalized for scalar values and the supported
single- or multiline finite Set, scalar-key Map/function, and closed-record
fragment. Each transition is matched against neutral action guards and updates;
ambiguous or unmatched transitions are hard errors. General TLA+ sequences,
variants, strings, and values outside declared Uneffect state types remain
pending.

Actions may have TypeScript-like guards with
`action_when actionName: predicate`. This is sufficient for discrete logical
clocks, deadlines, leases, periodic/sporadic releases, throttling, watchdogs,
and abstract scheduler policies. See [Real-time modeling
boundary](real-time-models.md) for the hard-real-time non-claims.

`clock name: granularity` introduces a protected monotonic logical clock,
implicit zero initialization, and a generated `tick_name` action. Standalone
actions accept `action_fair name: weak|strong`; the backend emits the
corresponding Quint fairness formula over the full state tuple.

## Shared parsed IR

`parseSpec` produces three projections:

```ts
interface ParsedSpec {
  capabilities: CapabilitySpec[] // effects are paired with exact UTF-16 source spans
  invariants: InvariantSpec[]
  temporal: TemporalSpec
}
```

Temporal predicates use a restricted TypeScript-style expression language rather than Quint syntax. Uneffect parses identifiers, integer and boolean literals, strict equality, boolean operators, comparisons, arithmetic, and unary `!`/`-` into a neutral AST. Calls, property access, loose equality, and other unsupported syntax are rejected. The same AST generates Quint expressions or optional runtime JavaScript assertions. Expressions are type-checked against declared `int`/`bool` states, the generated integer `pc`, and supported function parameters (`number`, `Int`, `Nat`, and `boolean`). Assignment targets and predicate result types are checked before backend generation.

The temporal composition IR declares `explicit-unchanged` stuttering: each generated action assigns every state, copying any state omitted by its summary. Function summaries and composed call sites retain UTF-16 source spans so counterexamples can later map back to TypeScript.

```text
TypeScript + Uneffect comments
             |
             v
     attachment + symbol resolution
             |
             v
         ParsedSpec
       /      |      \
      v       v       v
 capability  SMT     Quint
 lattice     Z3      transition model
```

## Prototype commands

Inspect the common IR:

```sh
just spec-ir examples/spec.ts
```

Generate an SMT-LIB obligation:

```sh
just spec-z3 examples/spec.ts inc > /tmp/inc.smt2
z3 /tmp/inc.smt2
```

Generate a Quint module:

```sh
just spec-quint examples/spec.ts > /tmp/spec.qnt
pnpm quint run /tmp/spec.qnt --invariant=cacheIsSound
```

Run source-level lint, including Z3-backed semantic checks:

```sh
just spec-lint examples/spec.ts
# Direct CLI form when selected temporal properties are proof hints:
pnpm uneffect-spec lint examples/spec.ts --strengthening=phaseRange,ownerValid
pnpm uneffect-spec lint examples/spec.ts --discover-strengthening
pnpm uneffect-spec lint examples/spec.ts --synthesize-strengthening
pnpm uneffect-spec lint examples/spec.ts --synthesize-relational-strengthening
pnpm uneffect-spec lint examples/spec.ts --synthesize-collection-strengthening
```

The command emits JSON and exits with status 1 when it finds a diagnostic. In
addition to the cheap syntax checks, it detects jointly inconsistent initial
constraints, properties that are valid or false for every typed state, guards
that are unsatisfiable for every typed state, and duplicate or subsumed safety
properties. It also unrolls complete action transitions for eight steps by
default, reports action unreachability with that explicit bound, proves initial
deadlock, finds the shortest later reachable deadlock within the bound, and
finds the shortest bounded reachable state where every enabled action stutters.
Because that state and its enabled transitions reproduce the same state, the
checker also reports `reachable-stutter-cycle` as an unbounded no-progress
execution witness. This is narrower than general fairness or eventuality
checking: cycles that change state before returning still require Quint/TLC or
a future liveness backend.
It also proves when enabled initial transitions cannot change state. Bounded
unreachability is not an unbounded proof. Bounded property-specific vacuity is
reported when the invariant holds but none of its referenced state can change
on a reachable transition. Unbounded vacuity and general liveness/fairness
failures remain open.

Z3 reachability also searches for bounded reachable lassos for each
`temporal_eventually` property. A diagnostic is emitted only when the property
is false across the prefix and loop, the loop returns to an identical complete
state, and every declared weak/strong action-fairness obligation is satisfied.
The returned `depth` and `loopStart` describe an infinite counterexample
witness. Failure to find a lasso within the requested depth is not a liveness
proof; nested or more general temporal formulas remain delegated to Quint/TLC.
Before that search, `initially-vacuous-liveness` is emitted when Z3 proves that
the eventuality predicate is true in every state satisfying `init`. Such a
property imposes no future progress obligation; expressing request-triggered
completion requires the leads-to/response fragment below rather than treating
a bare `eventually` as equivalent.

`temporal_response name: trigger => response` expresses that missing response
shape directly. It lowers to Quint's native `trigger leadsTo response`. The Z3
reachability lint reports `reachable-response-cycle` only for a complete
reachable lasso where the trigger occurs, the response stays false through the
loop, and all declared weak/strong action fairness constraints hold. It does
not mislabel a finite prefix with a pending response as an infinite violation.
Semantic lint separately reports `unsatisfiable-response-trigger` when no typed
state can start the obligation, and `statewise-vacuous-response` when Z3 proves
that the response already holds whenever the trigger holds. Cheap syntax lint
catches the corresponding literal-false and identical/true predicate cases
without starting a solver. These checks classify all typed states; they do not
claim transition-system reachability.
Reachability lint then distinguishes a globally satisfiable trigger that still
cannot occur from `init`. `bounded-unreachable-response-trigger` carries only
the configured search depth. `inductively-unreachable-response-trigger` is
added when exclusion is initialized and preserved by every transition, while
`finite-state-unreachable-response-trigger` is added only after the complete
finite state space has been covered.
The same explicitly selected, automatically discovered, or synthesized
inductive strengthening pool used for unreachable actions may produce
`strengthened-unreachable-response-trigger`. The strengthening candidates are
admitted only after their initialization and preservation obligations pass Z3.

`temporal_repeatedly name: predicate` expresses recurrence: the predicate must
hold infinitely often. It lowers to Quint's native composition
`always(eventually(predicate))`. The Z3 backend reports
`reachable-recurrence-cycle` only when it finds a complete reachable lasso on
which the predicate is false throughout the loop and all declared action
fairness constraints hold. A false finite prefix is insufficient. Semantic
lint reports `unsatisfiable-recurrence-target` when no typed state can satisfy
the predicate and `statewise-vacuous-recurrence` when every typed state already
satisfies it. As with the other lasso searches, absence of a bounded witness is
evidence rather than an unbounded proof.

The CLI intentionally emits verifier source instead of hiding it. Generated models are reviewable artifacts and can be checked independently of Uneffect.

## Epistemic status

| Area | Status |
|---|---|
| Comment parsing into three categories | Implemented prototype |
| Capability effect checking | Implemented for structured scoped and unscoped effects in TypeScript and Rust |
| Parameterized/scoped capability lattice | Implemented in both lattices with target-aware path/env and normalized URL/host domains |
| Shared SMT-LIB/direct-Z3 invariant obligations | Implemented prototype and executed with Z3 |
| Z3-backed temporal semantic lint | Implemented for global validity/contradiction, init consistency, globally impossible guards, and duplicate/subsumed safety properties |
| Bounded temporal reachability lint | Implemented with depth-labelled Z3 unrolling, definitive initial deadlock, shortest bounded later-deadlock, all-enabled-actions-stutter witnesses promoted to infinite stutter cycles, frozen-state property vacuity, and initial state-progress checks; general unbounded reachability remains open |
| Branch and loop lowering through shared IR | Implemented for restricted assignments, `if`, and `while` |
| Counterexample/evidence artifacts | Implemented with machine-readable APIs and `uneffect-evidence` JSON CLI |
| Quint safety-model generation | Implemented prototype and executed with Quint |
| Temporal liveness/fairness generation | Implemented and Quint-typechecked for eventuality, response, recurrence, and weak/strong action fairness |
| Transfer ownership state model | Implemented in TypeScript/Rust with positive and broken Quint controls |

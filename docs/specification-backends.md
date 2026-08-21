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

For bounded safety exploration, the direct Z3 backend unrolls the same neutral
actions, adds a solver-visible action selector per transition, and searches
depths in ascending order. A satisfiable negated property therefore yields the
shortest trace at or below the configured bound, including concrete states and
action names suitable for TypeScript refinement replay. `safe-within-bound`
remains a bounded result; `unknown` is never promoted to safety.

Standalone TLC output is normalized for the scalar temporal fragment by
parsing its state sequence and matching each transition against the neutral
action guards and updates. Ambiguous or unmatched transitions are hard errors.
This is intentionally narrower than general TLA+ value parsing; sets, maps,
records, and sequences remain pending together with collection-valued temporal
state.

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
```

The command emits JSON and exits with status 1 when it finds a diagnostic. In
addition to the cheap syntax checks, it detects jointly inconsistent initial
constraints, properties that are valid or false for every typed state, guards
that are unsatisfiable for every typed state, and duplicate or subsumed safety
properties. It also unrolls complete action transitions for eight steps by
default, reports action unreachability with that explicit bound, proves initial
deadlock, finds the shortest later reachable deadlock within the bound, and
finds the shortest bounded reachable state where every enabled action stutters.
It also proves when enabled initial transitions cannot change state. Bounded
unreachability is not an unbounded proof. Property-specific vacuity and general
liveness/fairness failures remain open.

The CLI intentionally emits verifier source instead of hiding it. Generated models are reviewable artifacts and can be checked independently of Uneffect.

## Epistemic status

| Area | Status |
|---|---|
| Comment parsing into three categories | Implemented prototype |
| Capability effect checking | Implemented for structured scoped and unscoped effects in TypeScript and Rust |
| Parameterized/scoped capability lattice | Implemented in both lattices with target-aware path/env and normalized URL/host domains |
| Shared SMT-LIB/direct-Z3 invariant obligations | Implemented prototype and executed with Z3 |
| Z3-backed temporal semantic lint | Implemented for global validity/contradiction, init consistency, globally impossible guards, and duplicate/subsumed safety properties |
| Bounded temporal reachability lint | Implemented with depth-labelled Z3 unrolling, definitive initial deadlock, shortest bounded later-deadlock and all-enabled-actions-stutter witnesses, and initial state-progress checks; unbounded reachability remains open |
| Branch and loop lowering through shared IR | Implemented for restricted assignments, `if`, and `while` |
| Counterexample/evidence artifacts | Implemented with machine-readable APIs and `uneffect-evidence` JSON CLI |
| Quint safety-model generation | Implemented prototype and executed with Quint |
| Temporal liveness/fairness generation | Implemented and Quint-typechecked for eventuality plus weak/strong action fairness |
| Transfer ownership state model | Implemented in TypeScript/Rust with positive and broken Quint controls |

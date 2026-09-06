# Reusable CFG primitives

For runnable consumers and measured applicability, see
[workflow and dependency-impact prototypes](./cfg-prototype-evaluation.md).

Import the compiler-independent core from `@mizchi/uneffect/cfg`:

```ts
import {
  solveBasicBlockFixedPoint,
  type BasicBlockFixedPointOptions,
} from "@mizchi/uneffect/cfg";

const options: BasicBlockFixedPointOptions<ReadonlySet<string>, "ready"> = {
  entry: "input",
  initial: new Set(["request"]),
  budget: { name: "availability", limit: 8 },
  lattice: {
    bottom: () => new Set(),
    equivalent: (a, b) => a.size === b.size && [...a].every(x => b.has(x)),
    join: (a, b) => ({ status: "joined", value: new Set([...a, ...b]) }),
  },
  blocks: [
    {
      id: "input",
      edges: [{ to: "output", completion: "ready" }],
      transfer: value => [{ to: "output", value }],
    },
    { id: "output", edges: [], transfer: () => [] },
  ],
};

const result = solveBasicBlockFixedPoint(options);
if (result.status === "converged") {
  console.log([...result.states.get("output")!]); // ["request"]
} else {
  console.log(result.reason, result.detail);
}
```

No TypeScript AST or Uneffect specification is needed. The implementation uses
standard ECMAScript collections and can be consumed by an ESM-capable runtime
or bundler. It currently ships in the Uneffect package; the `cfg/` runtime and
declaration dependency graph is self-contained for a later package extraction.
Installing the whole package can still install its other declared dependencies.

## Contracts and algorithms

| Export | Purpose |
| --- | --- |
| `BasicBlock`, `BasicBlockEdge`, `BasicBlockTransfer` | Caller-owned topology and edge-specific state propagation. |
| `FixedPointLattice`, `LatticeJoin` | Bottom, semantic equivalence, and a join that can explicitly report conflict. |
| `FixedPointBudget`, `BasicBlockFixedPointOptions`, `BasicBlockFixedPointResult` | Named work budget, analysis inputs, and discriminated result. |
| `solveBasicBlockFixedPoint` | Validate topology and schedule forward propagation until convergence or an explicit failure. |
| `FlowJoinOptions`, `joinFlowValues` | Join two branch environments over caller-selected visible bindings using a caller-provided phi operation. |
| Completion types and helpers | Represent normal/abrupt paths, consume matching loop targets, and apply sequencing, catch, and ECMAScript finally precedence. |

`BasicBlock`, `BasicBlockEdge`, and `BasicBlockFixedPointOptions` accept an
optional string-literal completion parameter. The default remains
`CompletionKind` for existing callers. The engine records these labels as
edge metadata; domain semantics belong to transfers and postconditions.
The completion helpers specifically implement the documented structured
completion rules; arbitrary custom labels do not change those rules.

`contracts.ts` owns types, `fixed-point.ts` owns scheduling and result state,
`join.ts` owns branch joins, and `completion.ts` owns completion algebra.
`index.ts` is the only package entrypoint.

## Correctness boundary

The caller must supply monotone transfers and a suitable lattice. Joins must
preserve abstract information; equivalence must reflect semantic equality.
Treat abstract values and graph topology as immutable throughout a solve.
The engine does not prove these callback properties and propagates callback
exceptions to its caller.

The budget counts processed blocks, including revisits, not elapsed time.
Invalid non-positive/non-integer budgets throw. Invalid topology, undeclared
transfers, lattice conflict, or exhaustion produce `status: "unknown"` with a
reason; their partial states must not be used as a converged result. Validation
checks topology before invoking lattice or transfer callbacks.

Convergence establishes a fixed point for the supplied abstraction, not source
program correctness, liveness, or fulfillment of an await. For example,
Uneffect's conditional-module consumer separately checks mandatory resumption
and terminal rejection after the generic solve.

The existing experimental exports remain aliases for compatibility. The
focused `/cfg` surface is covered by the public declaration snapshot and by
an installed consumer whose loader refuses every external dependency.

Run `just cfg-check` for the isolated ES-only type check and focused regression
tests. `tsconfig.cfg.json` supplies no Node or compiler ambient types; the fast
CI gate also runs this check.

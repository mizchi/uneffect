import type { CompletionKind } from "./completion-flow.js";

export interface FlowJoinOptions<Key, Value, Condition> {
  readonly keys: Iterable<Key>;
  readonly condition: Condition;
  readonly original: (key: Key) => Value;
  readonly whenTrue: (key: Key) => Value | undefined;
  readonly whenFalse: (key: Key) => Value | undefined;
  readonly equivalent: (left: Value, right: Value) => boolean;
  readonly phi: (condition: Condition, whenTrue: Value, whenFalse: Value) => Value;
}

/**
 * Join two normal control-flow predecessors over bindings visible at their
 * common dominator. Branch-local bindings are intentionally absent from keys.
 */
export function joinFlowValues<Key, Value, Condition>(
  options: FlowJoinOptions<Key, Value, Condition>,
): ReadonlyMap<Key, Value> {
  const joined = new Map<Key, Value>();
  for (const key of options.keys) {
    const original = options.original(key);
    const whenTrue = options.whenTrue(key) ?? original;
    const whenFalse = options.whenFalse(key) ?? original;
    joined.set(key, options.equivalent(whenTrue, whenFalse)
      ? whenTrue
      : options.phi(options.condition, whenTrue, whenFalse));
  }
  return joined;
}

export interface FixedPointBudget {
  readonly name: string;
  readonly limit: number;
}

export type LatticeJoin<Value> =
  | { readonly status: "joined"; readonly value: Value }
  | { readonly status: "conflict"; readonly reason: string };

export interface FixedPointLattice<Value> {
  /* uneffect:effect InvokeUserCode */
  readonly bottom: () => Value;
  /* uneffect:effect InvokeUserCode */
  readonly equivalent: (left: Value, right: Value) => boolean;
  /* uneffect:effect InvokeUserCode */
  readonly join: (left: Value, right: Value) => LatticeJoin<Value>;
}

export interface BasicBlockTransfer<Value> {
  readonly to: string;
  readonly value: Value;
}

export interface BasicBlockEdge {
  readonly to: string;
  readonly completion: CompletionKind;
  readonly role?: "forward" | "branch" | "back-edge";
  readonly sourceSpan?: { readonly start: number; readonly end: number };
}

export interface BasicBlock<Value> {
  readonly id: string;
  readonly edges: readonly BasicBlockEdge[];
  /* uneffect:effect InvokeUserCode */
  readonly transfer: (input: Value) => readonly BasicBlockTransfer<Value>[];
}

export interface BasicBlockFixedPointOptions<Value> {
  readonly entry: string;
  readonly initial: Value;
  readonly budget: FixedPointBudget;
  readonly lattice: FixedPointLattice<Value>;
  readonly blocks: readonly BasicBlock<Value>[];
}

export type BasicBlockFixedPointResult<Value> =
  | {
    readonly status: "converged";
    readonly iterations: number;
    readonly budget: FixedPointBudget;
    readonly states: ReadonlyMap<string, Value>;
  }
  | {
    readonly status: "unknown";
    readonly reason: "proof-budget-exhausted" | "lattice-conflict" | "invalid-cfg";
    readonly detail: string;
    readonly iterations: number;
    readonly budget: FixedPointBudget;
    readonly states: ReadonlyMap<string, Value>;
  };

/**
 * Computes a monotone forward fixed point over caller-defined abstract values.
 * The lattice owns semantic joins and conflicts; this engine owns block
 * scheduling, convergence, and the explicit proof budget.
 */
/* uneffect:effect InvokeUserCode | Throw<Error> */
export function solveBasicBlockFixedPoint<Value>(
  options: BasicBlockFixedPointOptions<Value>,
): BasicBlockFixedPointResult<Value> {
  const { budget, lattice } = options;
  if (!Number.isSafeInteger(budget.limit) || budget.limit <= 0) {
    throw new Error(`${budget.name} must be a positive safe integer; received ${String(budget.limit)}`);
  }
  const blocks = new Map<string, BasicBlock<Value>>();
  let duplicateBlock: string | undefined;
  for (const block of options.blocks) {
    if (blocks.has(block.id)) {
      duplicateBlock = block.id;
      break;
    }
    blocks.set(block.id, block);
  }
  const states = new Map<string, Value>();
  if (duplicateBlock) return {
    status: "unknown", reason: "invalid-cfg", detail: `duplicate CFG basic block ${duplicateBlock}`,
    iterations: 0, budget, states,
  };
  const entry = blocks.get(options.entry);
  if (!entry) return {
    status: "unknown", reason: "invalid-cfg", detail: `missing entry block ${options.entry}`,
    iterations: 0, budget, states,
  };
  const declaredSuccessors = new Map<string, ReadonlySet<string>>();
  for (const block of blocks.values()) {
    const edgeKeys = new Set<string>();
    const successors = new Set<string>();
    for (const edge of block.edges) {
      const edgeKey = JSON.stringify([
        edge.to,
        edge.completion,
        edge.role ?? null,
        edge.sourceSpan?.start ?? null,
        edge.sourceSpan?.end ?? null,
      ]);
      if (edgeKeys.has(edgeKey)) return {
        status: "unknown", reason: "invalid-cfg",
        detail: `basic block ${block.id} declares duplicate successor ${edge.to}`,
        iterations: 0, budget, states,
      };
      edgeKeys.add(edgeKey);
      if (!blocks.has(edge.to)) return {
        status: "unknown", reason: "invalid-cfg",
        detail: `basic block ${block.id} declares missing successor ${edge.to}`,
        iterations: 0, budget, states,
      };
      if (edge.sourceSpan && (!Number.isSafeInteger(edge.sourceSpan.start)
        || !Number.isSafeInteger(edge.sourceSpan.end)
        || edge.sourceSpan.start < 0
        || edge.sourceSpan.end < edge.sourceSpan.start)) return {
        status: "unknown", reason: "invalid-cfg",
        detail: `basic block ${block.id} declares invalid source span for successor ${edge.to}`,
        iterations: 0, budget, states,
      };
      successors.add(edge.to);
    }
    declaredSuccessors.set(block.id, successors);
  }
  for (const id of blocks.keys()) states.set(id, lattice.bottom());
  const initial = lattice.join(states.get(options.entry)!, options.initial);
  if (initial.status === "conflict") return {
    status: "unknown", reason: "lattice-conflict", detail: initial.reason,
    iterations: 0, budget, states,
  };
  states.set(options.entry, initial.value);
  const queue = [options.entry];
  const queued = new Set(queue);
  let iterations = 0;
  while (queue.length > 0) {
    if (iterations >= budget.limit) return {
      status: "unknown", reason: "proof-budget-exhausted",
      detail: `${budget.name} exhausted before the worklist converged`,
      iterations, budget, states,
    };
    const id = queue.shift()!;
    queued.delete(id);
    const block = blocks.get(id)!;
    iterations++;
    for (const transfer of block.transfer(states.get(id)!)) {
      if (!declaredSuccessors.get(id)!.has(transfer.to)) return {
        status: "unknown", reason: "invalid-cfg",
        detail: `basic block ${id} transfers through undeclared successor ${transfer.to}`,
        iterations, budget, states,
      };
      const current = states.get(transfer.to)!;
      const joined = lattice.join(current, transfer.value);
      if (joined.status === "conflict") return {
        status: "unknown", reason: "lattice-conflict", detail: joined.reason,
        iterations, budget, states,
      };
      if (lattice.equivalent(current, joined.value)) continue;
      states.set(transfer.to, joined.value);
      if (!queued.has(transfer.to)) {
        queue.push(transfer.to);
        queued.add(transfer.to);
      }
    }
  }
  return { status: "converged", iterations, budget, states };
}

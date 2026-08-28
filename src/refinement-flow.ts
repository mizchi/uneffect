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
  readonly bottom: () => Value;
  readonly equivalent: (left: Value, right: Value) => boolean;
  readonly join: (left: Value, right: Value) => LatticeJoin<Value>;
}

export interface BasicBlockTransfer<Value> {
  readonly to: string;
  readonly value: Value;
}

export interface BasicBlock<Value> {
  readonly id: string;
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
export function solveBasicBlockFixedPoint<Value>(
  options: BasicBlockFixedPointOptions<Value>,
): BasicBlockFixedPointResult<Value> {
  const { budget, lattice } = options;
  if (!Number.isSafeInteger(budget.limit) || budget.limit <= 0) {
    throw new Error(`${budget.name} must be a positive safe integer; received ${String(budget.limit)}`);
  }
  const blocks = new Map<string, BasicBlock<Value>>();
  for (const block of options.blocks) {
    if (blocks.has(block.id)) throw new Error(`duplicate CFG basic block ${block.id}`);
    blocks.set(block.id, block);
  }
  const states = new Map<string, Value>([...blocks.keys()].map((id) => [id, lattice.bottom()]));
  const entry = blocks.get(options.entry);
  if (!entry) return {
    status: "unknown", reason: "invalid-cfg", detail: `missing entry block ${options.entry}`,
    iterations: 0, budget, states,
  };
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
      if (!blocks.has(transfer.to)) return {
        status: "unknown", reason: "invalid-cfg",
        detail: `basic block ${id} transfers to missing block ${transfer.to}`,
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

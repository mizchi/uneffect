import { solveBasicBlockFixedPoint } from "../cfg/fixed-point.js";
import type { BasicBlock } from "../cfg/contracts.js";

export interface EffectPropagationNode {
  readonly id: string;
  readonly names: readonly string[];
  readonly callees: readonly string[];
}

/** Propagate known may-effects only. This does not establish a complete effect upper bound. */
export function propagateEffectNames(nodes: readonly EffectPropagationNode[]): ReadonlyMap<string, ReadonlySet<string>> {
  const callers = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const node of nodes) for (const callee of node.callees) {
    const targets = callers.get(callee);
    if (!targets) throw new Error(`unknown effect callee ${callee}`);
    targets.add(node.id);
  }
  const entry = "<effect-seeds>";
  const blocks: BasicBlock<ReadonlySet<string>>[] = [{
    id: entry,
    edges: nodes.map(node => ({ to: node.id, completion: "normal" })),
    transfer: () => nodes.map(node => ({ to: node.id, value: new Set(node.names) })),
  }, ...nodes.map((node): BasicBlock<ReadonlySet<string>> => ({
    id: node.id,
    edges: [...callers.get(node.id)!].map(to => ({ to, completion: "normal" })),
    transfer: value => [...callers.get(node.id)!].map(to => ({ to, value })),
  }))];
  const effectCount = new Set(nodes.flatMap(node => node.names)).size;
  const result = solveBasicBlockFixedPoint<ReadonlySet<string>>({
    entry, initial: new Set(), blocks,
    // Every scheduled update adds at least one of the finite input effect names.
    budget: { name: "native-effect-propagation", limit: 1 + nodes.length * (effectCount + 1) },
    lattice: {
      bottom: () => new Set(),
      equivalent: (left, right) => left.size === right.size && [...left].every(name => right.has(name)),
      join: (left, right) => ({ status: "joined", value: new Set([...left, ...right]) }),
    },
  });
  if (result.status !== "converged") throw new Error(`effect propagation failed: ${result.reason}: ${result.detail}`);
  return new Map(nodes.map(node => [node.id, result.states.get(node.id)!]));
}

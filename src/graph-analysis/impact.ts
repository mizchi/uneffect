import { solveBasicBlockFixedPoint, type BasicBlock } from "../cfg/index.js";
import type { AnalysisOptions, DependencyNode, ImpactResult } from "./contracts.js";
import { equalSets, incomplete, invalidInput } from "./shared.js";
import { parseDependencyGraph, stringList, validateOptions } from "./input.js";

/** May analysis: union the change origins that can reach each consumer. */
export function analyzeImpact(
  nodes: readonly DependencyNode[], changed: readonly string[], options: AnalysisOptions = {},
): ImpactResult {
  validateOptions(options, false);
  try { nodes = parseDependencyGraph(nodes); changed = stringList(changed, "changed"); }
  catch (error) { if (error instanceof TypeError) return invalidInput(error.message); throw error; }
  const consumers = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!node.id || consumers.has(node.id)) return invalidInput(`empty or duplicate node: ${node.id}`);
    consumers.set(node.id, new Set());
  }
  for (const node of nodes) for (const dependency of node.dependencies) {
    const targets = consumers.get(dependency);
    if (!targets) return invalidInput(`${node.id} references missing dependency: ${dependency}`);
    targets.add(node.id);
  }
  for (const id of changed) if (!consumers.has(id)) return invalidInput(`unknown changed node: ${id}`);

  // The engine has one entry. A synthetic source gives each change its own provenance.
  let entry = "$changes";
  while (consumers.has(entry)) entry += "$";
  const seeds = [...new Set(changed)];
  const blocks: BasicBlock<ReadonlySet<string>, "depends-on">[] = [{
    id: entry,
    edges: seeds.map(to => ({ to, completion: "depends-on" })),
    transfer: () => seeds.map(to => ({ to, value: new Set([to]) })),
  }];
  for (const [id, targets] of consumers) blocks.push({
    id, edges: [...targets].map(to => ({ to, completion: "depends-on" })),
    transfer: value => [...targets].map(to => ({ to, value })),
  });
  const result = solveBasicBlockFixedPoint({
    entry, initial: new Set<string>(), blocks,
    budget: { name: "dependency-impact", limit: options.budget ?? 100_000 },
    lattice: {
      bottom: () => new Set<string>(), equivalent: equalSets,
      join: (a, b) => ({ status: "joined", value: new Set([...a, ...b]) }),
    },
  });
  if (result.status === "unknown") return incomplete(result);
  const affected: { node: string; causes: string[] }[] = [];
  const unaffected: string[] = [];
  for (const node of [...consumers.keys()].sort()) {
    const causes = [...result.states.get(node)!].sort();
    if (causes.length) affected.push({ node, causes });
    else unaffected.push(node);
  }
  return { status: "analyzed", iterations: result.iterations, affected, unaffected };
}

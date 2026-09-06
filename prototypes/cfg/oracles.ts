/** Independent evaluation baselines. These do not import CFG or the analyzers. */
import type { DependencyNode, Workflow } from "./contracts.js";

/** One ordinary graph traversal per changed input; no joins or fixed-point API. */
export function referenceImpact(nodes: readonly DependencyNode[], changed: readonly string[]) {
  const causes = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const consumers = new Map(nodes.map(node => [node.id, [] as string[]]));
  for (const node of nodes) for (const dep of node.dependencies) consumers.get(dep)!.push(node.id);
  for (const seed of new Set(changed)) {
    const pending = [seed];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      causes.get(id)!.add(seed);
      pending.push(...consumers.get(id)!);
    }
  }
  return [...causes.keys()].sort().filter(id => causes.get(id)!.size)
    .map(node => ({ node, causes: [...causes.get(node)!].sort() }));
}

/** Enumerate concrete (step, facts) configurations, including loop revisits.
 * Finite Boolean facts make this exhaustive without choosing a path-length bound.
 * Use only for small evaluation models: the number of configurations is exponential.
 */
export function referenceWorkflow(workflow: Workflow) {
  if (workflow.steps.some(step => step.kind === "fork" || step.kind === "join")) {
    throw new Error("sequential reference cannot evaluate parallel workflows; use the schedule oracle");
  }
  const steps = new Map(workflow.steps.map(step => [step.id, step]));
  const reached = new Map<string, Set<string>[]>();
  const seen = new Set<string>();
  const pending = [{ id: workflow.entry, facts: new Set(workflow.initial) }];
  while (pending.length) {
    const { id, facts } = pending.pop()!;
    const key = JSON.stringify([id, [...facts].sort()]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (seen.size > 100_000) throw new Error("reference model too large for exhaustive evaluation");
    const incoming = reached.get(id) ?? [];
    incoming.push(facts);
    reached.set(id, incoming);
    const step = steps.get(id)!;
    const output = new Set(facts);
    for (const fact of step.revokes ?? []) output.delete(fact);
    for (const fact of step.provides ?? []) output.add(fact);
    for (const to of step.next) pending.push({ id: to, facts: output });
  }
  const diagnostics: { step: string; missing: string[] }[] = [];
  const guaranteed = new Map<string, readonly string[]>();
  const unreachable: string[] = [];
  for (const id of [...steps.keys()].sort()) {
    const inputs = reached.get(id);
    if (!inputs) { unreachable.push(id); continue; }
    guaranteed.set(id, [...inputs[0]].filter(fact => inputs.every(input => input.has(fact))).sort());
    const missing = [...new Set(steps.get(id)!.requires)]
      .filter(fact => inputs.some(input => !input.has(fact))).sort();
    if (missing.length) diagnostics.push({ step: id, missing });
  }
  return { status: diagnostics.length ? "invalid" : "valid", diagnostics, guaranteed, unreachable,
    configurations: seen.size };
}

export function randomForSeed(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

export function generatedDependencies(seed: number, size = 12): DependencyNode[] {
  const random = randomForSeed(seed);
  const ids = Array.from({ length: size }, (_, i) => `node-${i}`);
  return ids.map(id => ({ id, dependencies: ids.filter(() => random() % 7 === 0) }));
}

export function generatedWorkflow(seed: number): Workflow {
  const random = randomForSeed(seed);
  const ids = ["start", "a", "b", "c", "end"];
  const facts = ["approved", "artifact", "tested"];
  const selectFacts = () => facts.filter(() => random() % 3 === 0);
  return { entry: "start", initial: selectFacts(), steps: ids.map(id => ({
    id, requires: selectFacts(), provides: selectFacts(), revokes: selectFacts(),
    next: ids.filter(() => random() % 4 === 0),
  })) };
}

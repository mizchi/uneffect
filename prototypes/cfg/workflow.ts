import { solveBasicBlockFixedPoint, type BasicBlock, type FixedPointLattice } from "../../src/cfg/index.js";
import type { WorkflowAnalysisOptions, Workflow, WorkflowResult } from "./contracts.js";
import { equalSets, incomplete, invalidInput } from "./shared.js";
import { verifyParallelWorkflow } from "./parallel-workflow.js";

// null is unreachable, distinct from reachable with no guaranteed facts.
type Facts = ReadonlySet<string> | null;
const guaranteedFacts: FixedPointLattice<Facts> = {
  bottom: () => null,
  equivalent: (a, b) => a === null || b === null ? a === b : equalSets(a, b),
  join: (a, b) => ({ status: "joined", value:
    a === null ? b : b === null ? a : new Set([...a].filter(fact => b.has(fact))),
  }),
};

/** Sequential must analysis, or bounded interleaving analysis for explicit forks/joins. */
export function verifyWorkflow(workflow: Workflow, options: WorkflowAnalysisOptions = {}): WorkflowResult {
  if (workflow.steps.some(step => step.kind === "fork" || step.kind === "join")) return verifyParallelWorkflow(workflow, options);
  if (workflow.steps.some(step => !step.id)) return invalidInput("workflow step IDs must not be empty");
  const blocks: BasicBlock<Facts, "next">[] = workflow.steps.map(step => ({
    id: step.id,
    edges: step.next.map(to => ({ to, completion: "next" })),
    transfer: input => {
      if (input === null) return [];
      const value = new Set(input);
      for (const fact of step.revokes ?? []) value.delete(fact);
      for (const fact of step.provides ?? []) value.add(fact);
      return step.next.map(to => ({ to, value }));
    },
  }));
  const result = solveBasicBlockFixedPoint({
    entry: workflow.entry, initial: new Set(workflow.initial), blocks, lattice: guaranteedFacts,
    budget: { name: "workflow-preflight", limit: options.budget ?? 100_000 },
  });
  if (result.status === "unknown") return incomplete(result);

  // Inspect only the final fixed point: early visits can have stronger guarantees.
  const diagnostics: { step: string; missing: string[] }[] = [];
  const guaranteed = new Map<string, readonly string[]>();
  const unreachable: string[] = [];
  const steps = new Map(workflow.steps.map(step => [step.id, step]));
  for (const id of [...steps.keys()].sort()) {
    const facts = result.states.get(id)!;
    if (facts === null) { unreachable.push(id); continue; }
    guaranteed.set(id, [...facts].sort());
    const missing = [...new Set(steps.get(id)!.requires)].filter(fact => !facts.has(fact)).sort();
    if (missing.length) diagnostics.push({ step: id, missing });
  }
  return { status: diagnostics.length ? "invalid" : "valid", iterations: result.iterations,
    diagnostics, guaranteed, unreachable };
}

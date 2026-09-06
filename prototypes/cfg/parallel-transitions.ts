import type { AnalysisUnknown, Workflow, WorkflowStep } from "./contracts.js";
import { invalidInput } from "./shared.js";
import { canonicalConfiguration, type WorkflowConfiguration, type WorkflowExecution } from "./parallel-model.js";

export function validateParallelWorkflow(workflow: Workflow): AnalysisUnknown | undefined {
  const steps = new Map<string, WorkflowStep>();
  for (const step of workflow.steps) {
    if (!step.id || steps.has(step.id)) return invalidInput(`empty or duplicate step: ${step.id}`);
    steps.set(step.id, step);
  }
  if (!steps.has(workflow.entry)) return invalidInput(`missing workflow entry: ${workflow.entry}`);
  for (const step of steps.values()) {
    if (new Set(step.next).size !== step.next.length) return invalidInput(`duplicate successor at ${step.id}`);
    for (const id of step.next) if (!steps.has(id)) return invalidInput(`${step.id} references missing step: ${id}`);
    if (step.kind === "fork") {
      const join = steps.get(step.join);
      if (step.next.length < 2 || join?.kind !== "join" || join.fork !== step.id) {
        return invalidInput(`fork ${step.id} needs distinct branches and a paired join`);
      }
    }
    if (step.kind === "join") {
      const fork = steps.get(step.fork);
      if (fork?.kind !== "fork" || fork.join !== step.id) return invalidInput(`join ${step.id} has no matching fork`);
    }
  }
}

/** Pure atomic transitions. Facts are shared; every enabled task ordering is explored. */
export function advanceConfiguration(
  state: WorkflowConfiguration, steps: ReadonlyMap<string, WorkflowStep>,
): { readonly status: "expanded"; readonly executions: readonly WorkflowExecution[] } | AnalysisUnknown {
  const executions: WorkflowExecution[] = [];
  const scheduledJoins = new Set<string>();
  for (const [index, token] of state.tokens.entries()) {
    const step = steps.get(token.step)!;
    let remaining = state.tokens.filter((_, candidate) => candidate !== index);
    let activations = state.activations;
    let owner = token.owner;
    if (step.kind === "join") {
      const activation = state.activations.find(active => active.fork === step.fork);
      if (!activation || owner?.fork !== step.fork) return invalidInput(`unscoped arrival at join ${step.id}`);
      if (scheduledJoins.has(step.id)) continue;
      scheduledJoins.add(step.id);
      const fork = steps.get(step.fork)!;
      const arrived = new Set(state.tokens.filter(t => t.step === step.id && t.owner?.fork === step.fork).map(t => t.owner!.branch));
      if (!fork.next.every(branch => arrived.has(branch))) continue;
      remaining = state.tokens.filter(t => !(t.step === step.id && t.owner?.fork === step.fork));
      activations = state.activations.filter(active => active !== activation);
      owner = activation.parent;
    }
    const facts = new Set(state.facts);
    for (const fact of step.revokes ?? []) facts.delete(fact);
    for (const fact of step.provides ?? []) facts.add(fact);
    if (step.kind === "fork") {
      if (activations.some(active => active.fork === step.id)) {
        return invalidInput(`fork ${step.id} is reentered before its previous activation joined`);
      }
      executions.push({ step: step.id, after: canonicalConfiguration({ facts: [...facts],
        activations: [...activations, { fork: step.id, parent: owner }],
        tokens: [...remaining, ...step.next.map(to => ({ step: to, owner: { fork: step.id, branch: to } }))],
      }) });
    } else {
      // Ending a branch removes its runnable token but retains the activation:
      // it must not turn a missing arrival into successful workflow completion.
      for (const to of step.next.length ? step.next : [null]) executions.push({ step: step.id,
        after: canonicalConfiguration({ facts: [...facts], activations,
          tokens: to === null ? remaining : [...remaining, { step: to, owner }],
        }),
      });
    }
  }
  return { status: "expanded", executions };
}

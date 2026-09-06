import { solveBasicBlockFixedPoint, type BasicBlock } from "../cfg/index.js";
import type { AnalysisUnknown, Workflow, WorkflowAnalysisOptions, WorkflowDiagnostic, WorkflowResult } from "./contracts.js";
import { canonicalConfiguration, type WorkflowConfiguration } from "./parallel-model.js";
import { advanceConfiguration, validateParallelWorkflow } from "./parallel-transitions.js";
import { equalSets, incomplete } from "./shared.js";

interface ConfigurationNode {
  readonly state: WorkflowConfiguration;
  readonly successors: Set<number>;
  readonly executed: Set<string>;
}

/** Exact finite shared-fact/interleaving model, bounded before returning any verdict. */
export function verifyParallelWorkflow(workflow: Workflow, options: WorkflowAnalysisOptions): WorkflowResult {
  const budget = options.budget ?? 100_000;
  const maxConfigurations = options.maxConfigurations ?? 10_000;
  const maxTransitions = options.maxTransitions ?? 100_000;
  for (const [name, value] of [["budget", budget], ["maxConfigurations", maxConfigurations]] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  const invalid = validateParallelWorkflow(workflow);
  if (invalid) return invalid;
  const steps = new Map(workflow.steps.map(step => [step.id, step]));
  const initial = canonicalConfiguration({ facts: workflow.initial ?? [],
    tokens: [{ step: workflow.entry, owner: null }], activations: [] });
  const nodes: ConfigurationNode[] = [{ state: initial, successors: new Set(), executed: new Set() }];
  const indexes = new Map([[JSON.stringify(initial), 0]]);
  let explored = 0;
  let transitions = 0;
  const exhausted = (reason: AnalysisUnknown["reason"], detail: string): AnalysisUnknown =>
    ({ status: "unknown", reason, detail, iterations: explored });
  while (explored < nodes.length) {
    if (explored >= budget) return exhausted("proof-budget-exhausted", "workflow configuration exploration exhausted its work budget");
    const node = nodes[explored++];
    const expansion = advanceConfiguration(node.state, steps, maxTransitions - transitions);
    if (expansion.status === "unknown") return { ...expansion, iterations: explored };
    for (const execution of expansion.executions) {
      transitions++;
      node.executed.add(execution.step);
      const key = JSON.stringify(execution.after);
      let index = indexes.get(key);
      if (index === undefined) {
        if (nodes.length >= maxConfigurations) return exhausted("state-space-exhausted", `workflow exceeded ${maxConfigurations} configurations`);
        index = nodes.length;
        indexes.set(key, index);
        nodes.push({ state: execution.after, successors: new Set(), executed: new Set() });
      }
      node.successors.add(index);
    }
  }

  // Reverse dataflow: which fork's matching join can still execute from each
  // reachable configuration? This catches closed cycles as well as dead ends.
  // Check each activation's own join, not global termination or a later barrier.
  if (explored >= budget) return exhausted("proof-budget-exhausted", "no budget remains for barrier reachability");
  const predecessors = nodes.map(() => new Set<number>());
  for (const [index, node] of nodes.entries()) for (const to of node.successors) predecessors[to].add(index);
  const goals = nodes.flatMap((node, index) => {
    const forks = [...node.executed].flatMap(id => { const step = steps.get(id)!; return step.kind === "join" ? [step.fork] : []; });
    return forks.length ? [{ to: String(index), value: new Set(forks) }] : [];
  });
  const blocks: BasicBlock<ReadonlySet<string>, "can-join">[] = [{
    id: "$barriers", edges: goals.map(({ to }) => ({ to, completion: "can-join" })), transfer: () => goals,
  }, ...nodes.map((_, index): BasicBlock<ReadonlySet<string>, "can-join"> => ({
    id: String(index), edges: [...predecessors[index]].map(to => ({ to: String(to), completion: "can-join" })),
    transfer: value => [...predecessors[index]].map(to => ({ to: String(to), value })),
  }))];
  const solved = solveBasicBlockFixedPoint({ entry: "$barriers", initial: new Set<string>(), blocks,
    budget: { name: "parallel-barrier-reachability", limit: budget - explored },
    lattice: { bottom: () => new Set<string>(), equivalent: equalSets,
      join: (a, b) => ({ status: "joined", value: new Set([...a, ...b]) }) },
  });
  if (solved.status === "unknown") return incomplete({ ...solved, iterations: explored + solved.iterations });

  const incoming = new Map<string, Set<string>>();
  const blocked = new Map<string, Extract<WorkflowDiagnostic, { kind: "blocked-join" }>>();
  for (const [index, node] of nodes.entries()) {
    for (const id of node.executed) {
      const previous = incoming.get(id);
      incoming.set(id, previous ? new Set([...previous].filter(fact => node.state.facts.includes(fact))) : new Set(node.state.facts));
    }
    for (const activation of node.state.activations) {
      if (solved.states.get(String(index))!.has(activation.fork)) continue;
      const fork = steps.get(activation.fork)!;
      if (fork.kind !== "fork") throw new Error("invalid internal activation");
      const arrived = new Set(node.state.tokens.filter(token => token.step === fork.join && token.owner?.fork === fork.id).map(token => token.owner!.branch));
      const waitingFor = fork.next.filter(branch => !arrived.has(branch)).sort();
      const previous = blocked.get(fork.id);
      // One concrete blocked configuration per fork, preferring more arrivals.
      if (!previous || waitingFor.length < previous.waitingFor.length
        || (waitingFor.length === previous.waitingFor.length && JSON.stringify(waitingFor) < JSON.stringify(previous.waitingFor))) blocked.set(fork.id,
        { kind: "blocked-join", step: fork.join, fork: fork.id, waitingFor });
    }
  }
  const diagnostics: WorkflowDiagnostic[] = [];
  const guaranteed = new Map<string, readonly string[]>();
  const unreachable: string[] = [];
  for (const id of [...steps.keys()].sort()) {
    const facts = incoming.get(id);
    if (!facts) { unreachable.push(id); continue; }
    guaranteed.set(id, [...facts].sort());
    const missing = [...new Set(steps.get(id)!.requires)].filter(fact => !facts.has(fact)).sort();
    if (missing.length) diagnostics.push({ kind: "missing-prerequisite", step: id, missing });
  }
  diagnostics.push(...[...blocked.values()].sort((a, b) => a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
  return { status: diagnostics.length ? "invalid" : "valid", iterations: explored + solved.iterations,
    diagnostics, guaranteed, unreachable };
}

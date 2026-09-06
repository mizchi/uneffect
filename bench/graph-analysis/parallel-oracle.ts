/** Independent reference: enumerate lane-preserving permutations, without tokens,
 * activations, CFG construction, barrier reachability or production transitions.
 */
import type { Workflow, WorkflowActionStep, WorkflowStep } from "../../src/graph-analysis/contracts.js";
import { randomForSeed } from "./oracles.js";

export interface ParallelScheduleCase {
  readonly workflow: Workflow;
  readonly lanes: readonly (readonly WorkflowActionStep[])[];
}

export function generatedParallelSchedule(seed: number): ParallelScheduleCase {
  const random = randomForSeed(seed);
  const facts = ["approved", "artifact", "tested"];
  const select = () => facts.filter(() => random() % 3 === 0);
  const lanes: WorkflowActionStep[][] = Array.from({ length: 2 + random() % 2 }, (_, lane) => {
    const length = 1 + random() % 2;
    return Array.from({ length }, (_, index) => ({
      id: `lane-${lane}-${index}`, requires: select(), provides: select(), revokes: select(),
      next: [index + 1 < length ? `lane-${lane}-${index + 1}` : "join"],
    }));
  });
  return { lanes, workflow: { entry: "fork", initial: select(), steps: [
    { id: "fork", kind: "fork", join: "join", requires: select(), provides: select(), revokes: select(), next: lanes.map(lane => lane[0].id) },
    ...lanes.flat(),
    { id: "join", kind: "join", fork: "fork", requires: select(), provides: select(), revokes: select(), next: ["end"] },
    { id: "end", requires: select(), next: [] },
  ] } };
}

export function referenceParallelSchedules({ workflow, lanes }: ParallelScheduleCase) {
  const steps = new Map(workflow.steps.map(step => [step.id, step]));
  const observed = new Map<string, Set<string>[]>();
  function execute(step: WorkflowStep, input: ReadonlySet<string>): Set<string> {
    const values = observed.get(step.id) ?? [];
    values.push(new Set(input));
    observed.set(step.id, values);
    return new Set([...input].filter(fact => !step.revokes?.includes(fact)).concat(step.provides ?? []));
  }
  let schedules = 0;
  function enumerate(positions: readonly number[], facts: ReadonlySet<string>): void {
    if (positions.every((position, lane) => position === lanes[lane].length)) {
      schedules++;
      execute(steps.get("end")!, execute(steps.get("join")!, facts));
      return;
    }
    for (const [lane, position] of positions.entries()) {
      const step = lanes[lane][position];
      if (!step) continue;
      const advanced = positions.map((value, candidate) => value + (candidate === lane ? 1 : 0));
      enumerate(advanced, execute(step, facts));
    }
  }
  enumerate(lanes.map(() => 0), execute(steps.get("fork")!, new Set(workflow.initial)));
  const diagnostics: { kind: "missing-prerequisite"; step: string; missing: string[] }[] = [];
  const guaranteed = new Map<string, readonly string[]>();
  for (const id of [...steps.keys()].sort()) {
    const values = observed.get(id)!;
    guaranteed.set(id, [...values[0]].filter(fact => values.every(value => value.has(fact))).sort());
    const missing = [...new Set(steps.get(id)!.requires)].filter(fact => values.some(value => !value.has(fact))).sort();
    if (missing.length) diagnostics.push({ kind: "missing-prerequisite", step: id, missing });
  }
  return { status: diagnostics.length ? "invalid" : "valid", diagnostics, guaranteed, unreachable: [], schedules };
}

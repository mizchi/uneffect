import { describe, expect, it } from "vitest";
import { verifyWorkflow } from "../prototypes/cfg/workflow.js";
import type { Workflow } from "../prototypes/cfg/contracts.js";
import { generatedParallelSchedule, referenceParallelSchedules } from "../prototypes/cfg/parallel-oracle.js";
import { advanceConfiguration } from "../prototypes/cfg/parallel-transitions.js";
import type { WorkflowConfiguration } from "../prototypes/cfg/parallel-model.js";
import { parallelWorkflowScenarios } from "../prototypes/cfg/scenarios.js";

function release(): Workflow {
  return { entry: "start", steps: [
    { id: "start", kind: "fork", join: "ready", next: ["build", "review"] },
    { id: "build", provides: ["artifact"], next: ["ready"] },
    { id: "review", provides: ["approved"], next: ["ready"] },
    { id: "ready", kind: "join", fork: "start", requires: ["artifact", "approved"], next: ["publish"] },
    { id: "publish", requires: ["artifact", "approved"], next: [] },
  ] };
}

describe("parallel workflow barriers", () => {
  it.each(parallelWorkflowScenarios)("evaluates the runnable $name scenario", ({ workflow, expected }) => {
    expect(verifyWorkflow(workflow).status).toBe(expected);
  });
  it("combines independent outputs only after both branches arrive", () => {
    const result = verifyWorkflow(release());
    expect(result).toMatchObject({ status: "valid", diagnostics: [], unreachable: [] });
    if (result.status === "unknown") throw new Error(result.detail);
    expect(result.guaranteed.get("ready")).toEqual(["approved", "artifact"]);
    expect(result.guaranteed.get("build")).toEqual([]);
    expect(result.guaranteed.get("review")).toEqual([]);
  });
  it("does not treat an alternative within a branch as two completed branches", () => {
    const model = release();
    const result = verifyWorkflow({ ...model, steps: [
      ...model.steps.map(step => step.id === "review" ? { ...step, provides: [], next: ["approve", "skip"] } : step),
      { id: "approve", provides: ["approved"], next: ["ready"] },
      { id: "skip", next: ["ready"] },
    ] });
    expect(result).toMatchObject({ status: "invalid", diagnostics: [
      { step: "publish", missing: ["approved"] }, { step: "ready", missing: ["approved"] },
    ] });
  });
  it("reports a branch that terminates without arriving, without running the join", () => {
    const model = release();
    const result = verifyWorkflow({ ...model, steps: model.steps.map(step => step.id === "review" ? { ...step, next: [] } : step) });
    expect(result).toMatchObject({ status: "invalid", diagnostics: [
      { kind: "blocked-join", step: "ready", fork: "start", waitingFor: ["review"] },
    ], unreachable: ["publish", "ready"] });
  });
  it("reports a possible failed arrival even when another choice completes", () => {
    const model = release();
    const result = verifyWorkflow({ ...model, steps: [
      ...model.steps.map(step => step.id === "review" ? { ...step, next: ["ready", "failure"] } : step),
      { id: "failure", next: [] },
    ] });
    expect(result).toMatchObject({ status: "invalid", diagnostics: [
      { kind: "blocked-join", step: "ready", fork: "start", waitingFor: ["review"] },
    ] });
  });
  it("detects a branch trapped in a cycle with no path to its barrier", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, steps: model.steps.map(step => step.id === "review" ? { ...step, next: ["review"] } : step) }))
      .toMatchObject({ status: "invalid", diagnostics: [
        { kind: "blocked-join", step: "ready", fork: "start", waitingFor: ["review"] },
      ] });
  });
  it("observes racing revocation rather than unioning stale branch snapshots", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, initial: ["approved"], steps: model.steps.map(step =>
      step.id === "review" ? { ...step, provides: [], revokes: ["approved"] } : step) }))
      .toMatchObject({ status: "invalid", diagnostics: [
        { step: "publish", missing: ["approved"] }, { step: "ready", missing: ["approved"] },
      ] });
  });
  it("does not assume a sibling's output is available before the barrier", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, steps: model.steps.map(step =>
      step.id === "review" ? { ...step, requires: ["artifact"] } : step) }))
      .toMatchObject({ status: "invalid", diagnostics: [{ step: "review", missing: ["artifact"] }] });
  });
  it("supports nested forks and restores the parent branch at the inner join", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, steps: [
      ...model.steps.filter(step => step.id !== "build"),
      { id: "build", kind: "fork", join: "built", next: ["compile", "test"] },
      { id: "compile", provides: ["compiled"], next: ["built"] },
      { id: "test", provides: ["tested"], next: ["built"] },
      { id: "built", kind: "join", fork: "build", requires: ["compiled", "tested"], provides: ["artifact"], next: ["ready"] },
    ] })).toMatchObject({ status: "valid", diagnostics: [] });
  });
  it("supports repeated completed forks and does not reuse earlier arrival tokens", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, steps: model.steps.map(step => step.id === "publish" ? { ...step, next: ["start"] } : step) }))
      .toMatchObject({ status: "valid", diagnostics: [] });
  });
  it("consumes all arrival tokens before the next activation can wait again", () => {
    const model = release();
    const steps = new Map(model.steps.map(step => [step.id,
      step.id === "publish" ? { ...step, next: ["start"] } : step]));
    let state: WorkflowConfiguration = { facts: [], tokens: [{ step: "start", owner: null }], activations: [] };
    for (const id of ["start", "build", "review", "ready", "publish", "start", "build"]) {
      const result = advanceConfiguration(state, steps);
      if (result.status === "unknown") throw new Error(result.detail);
      const execution = result.executions.find(value => value.step === id);
      expect(execution, `trace step ${id}`).toBeDefined();
      state = execution!.after;
    }
    const result = advanceConfiguration(state, steps);
    if (result.status === "unknown") throw new Error(result.detail);
    expect(result.executions.map(value => value.step)).toEqual(["review"]);
  });
  it("does not confuse a retry with an unavoidable blocked join", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, steps: model.steps.map(step => step.id === "review" ? { ...step, next: ["review", "ready"] } : step) }))
      .toMatchObject({ status: "valid", diagnostics: [] });
  });
  it("does not blame a completed earlier barrier for a later blocked one", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, steps: [
      ...model.steps.map(step => step.id === "publish" ? { ...step, next: ["later"] } : step),
      { id: "later", kind: "fork", join: "later-ready", next: ["a", "b"] },
      { id: "a", next: ["later-ready"] }, { id: "b", next: [] },
      { id: "later-ready", kind: "join", fork: "later", next: [] },
    ] })).toMatchObject({ status: "invalid", diagnostics: [
      { kind: "blocked-join", step: "later-ready", fork: "later", waitingFor: ["b"] },
    ] });
  });
  it("rejects invalid pairing, missing nodes, duplicate branches and unscoped arrivals", () => {
    const model = release();
    for (const steps of [
      model.steps.map(step => step.kind === "fork" ? { ...step, join: "publish" } : step),
      model.steps.map(step => step.kind === "join" ? { ...step, fork: "build" } : step),
      model.steps.map(step => step.kind === "fork" ? { ...step, next: ["build", "build"] } : step),
      model.steps.map(step => step.kind === "fork" ? { ...step, next: ["build", "missing"] } : step),
    ]) expect(verifyWorkflow({ ...model, steps }).status).toBe("unknown");
    expect(verifyWorkflow({ ...model, entry: "ready" }).status).toBe("unknown");
  });
  it("bounds configuration discovery and propagation without returning partial verdicts", () => {
    for (const options of [{ maxConfigurations: 1 }, { budget: 1 }, { budget: 10 }]) {
      const result = verifyWorkflow(release(), options);
      expect(result.status).toBe("unknown");
      expect(result).not.toHaveProperty("diagnostics");
      expect(result).not.toHaveProperty("guaranteed");
    }
    expect(verifyWorkflow(release(), { maxConfigurations: 1 })).toMatchObject({ reason: "state-space-exhausted" });
    for (const value of [0, -1, 1.5, Infinity]) {
      expect(() => verifyWorkflow(release(), { maxConfigurations: value })).toThrow(/positive safe integer/);
      expect(() => verifyWorkflow(release(), { budget: value })).toThrow(/positive safe integer/);
    }
  });
  it("fails closed on cross-scope joins and overlapping activation of the same fork", () => {
    const model = release();
    expect(verifyWorkflow({ ...model, steps: model.steps.map(step => step.id === "review" ? { ...step, next: ["start"] } : step) }))
      .toMatchObject({ status: "unknown", reason: "invalid-input" });
    expect(verifyWorkflow({ ...model, steps: [
      ...model.steps.filter(step => step.id !== "build"),
      { id: "build", kind: "fork", join: "built", next: ["a", "b"] },
      { id: "a", next: ["ready"] }, { id: "b", next: ["built"] },
      { id: "built", kind: "join", fork: "build", next: ["ready"] },
    ] })).toMatchObject({ status: "unknown", reason: "invalid-input" });
  });
  it("matches independent interleaving enumeration on 128 generated parallel models", () => {
    for (let seed = 1; seed <= 128; seed++) {
      const scenario = generatedParallelSchedule(seed);
      const { schedules: _, ...expected } = referenceParallelSchedules(scenario);
      expect(verifyWorkflow(scenario.workflow), `seed ${seed}`).toMatchObject(expected);
      expect(verifyWorkflow({ ...scenario.workflow, steps: [...scenario.workflow.steps].reverse().map(step => ({
        ...step, next: [...step.next].reverse(),
      })) }), `reversed seed ${seed}`).toMatchObject(expected);
    }
  });
});

import { describe, expect, it } from "vitest";
import { parseWorkflow, verifyWorkflow, type Workflow } from "../src/graph-analysis/workflow-api.js";
import { analyzeImpact, parseDependencyGraph, type DependencyNode } from "../src/graph-analysis/impact-api.js";

describe("supported graph API boundaries", () => {
  it("parses JSON models into independent normalized inputs", () => {
    const input = { entry: "a", initial: ["ready", "ready"], steps: [{ id: "a", next: [], requires: ["ready"] }] };
    const parsed = parseWorkflow(input);
    input.initial.length = 0;
    input.steps[0].requires.push("changed");
    expect(parsed.initial).toEqual(["ready"]);
    expect(verifyWorkflow(parsed)).toMatchObject({ status: "valid", diagnostics: [] });
    const graph = [{ id: "a", dependencies: [] as string[] }];
    const parsedGraph = parseDependencyGraph(graph);
    graph[0].dependencies.push("missing");
    expect(analyzeImpact(parsedGraph, ["a"])).toMatchObject({ status: "analyzed", affected: [{ node: "a", causes: ["a"] }] });
  });
  it("rejects unknown kinds and misspelled safety-critical fields", () => {
    for (const input of [
      { entry: "a", steps: [{ id: "a", kind: "frok", next: [] }] },
      { entry: "a", steps: [{ id: "a", require: ["approved"], next: [] }] },
      { entry: "a", steps: [{ id: "a", requires: "approved", next: [] }] },
      { entry: "a", steps: [{ id: "a", requires: null, next: [] }] },
      { entry: "a", initial: null, steps: [{ id: "a", next: [] }] },
      { entry: "a", steps: [{ id: "a", next: [], join: "a" }] },
      { entry: "a", steps: [{ id: "a", kind: "fork", next: ["b", "c"] }] },
      { entry: "a", intial: ["approved"], steps: [{ id: "a", next: [] }] },
      null, [], {}, { entry: "a", steps: [null] },
      { entry: "a", steps: new Array(1) },
      { entry: "a", steps: [{ id: "a", next: [], requires: new Array(1) }] },
    ]) {
      expect(() => parseWorkflow(input)).toThrow(TypeError);
      expect(verifyWorkflow(input as Workflow)).toMatchObject({ status: "unknown", reason: "invalid-input" });
    }
  });
  it("rejects malformed dependency inputs without crashing or reporting no impact", () => {
    for (const input of [null, {}, new Array(1), [{ id: "a", dependsOn: [] }], [{ id: "a", dependencies: "b" }], [{ id: "a", dependencies: [null] }]]) {
      expect(() => parseDependencyGraph(input)).toThrow(TypeError);
      expect(analyzeImpact(input as DependencyNode[], []).status).toBe("unknown");
    }
    expect(analyzeImpact([{ id: "a", dependencies: [] }], "a" as unknown as string[]))
      .toMatchObject({ status: "unknown", reason: "invalid-input" });
  });
  it("provides discriminated prerequisite diagnostics", () => {
    const result = verifyWorkflow({ entry: "publish", steps: [{ id: "publish", requires: ["approved"], next: [] }] });
    expect(result).toMatchObject({ status: "invalid", diagnostics: [{ kind: "missing-prerequisite", step: "publish", missing: ["approved"] }] });
  });
  it("validates options consistently, including on sequential and invalid models", () => {
    const workflow = { entry: "a", steps: [{ id: "a", next: [] }] };
    for (const value of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => verifyWorkflow(workflow, { budget: value })).toThrow(RangeError);
      expect(() => verifyWorkflow(workflow, { maxConfigurations: value })).toThrow(RangeError);
      expect(() => verifyWorkflow(workflow, { maxTransitions: value })).toThrow(RangeError);
      expect(() => analyzeImpact([], [], { budget: value })).toThrow(RangeError);
    }
    expect(() => verifyWorkflow(workflow, { buget: 1 } as never)).toThrow(TypeError);
  });
  it("caps transition exploration separately from stored configurations", () => {
    const workflow: Workflow = { entry: "fork", steps: [
      { id: "fork", kind: "fork", join: "join", next: ["a", "b"] },
      { id: "a", next: ["a", "join"] }, { id: "b", next: ["b", "join"] },
      { id: "join", kind: "join", fork: "fork", next: [] },
    ] };
    const result = verifyWorkflow(workflow, { maxTransitions: 2 });
    expect(result).toMatchObject({ status: "unknown", reason: "state-space-exhausted" });
    expect(result).not.toHaveProperty("diagnostics");
  });
});

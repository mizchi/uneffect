import { describe, expect, it } from "vitest";
import { analyzeImpact } from "../prototypes/cfg/impact.js";
import { verifyWorkflow } from "../prototypes/cfg/workflow.js";
import type { DependencyNode, Workflow } from "../prototypes/cfg/contracts.js";
import { generatedDependencies, generatedWorkflow, referenceImpact, referenceWorkflow } from "../prototypes/cfg/oracles.js";
import { extractImportGraph } from "../prototypes/cfg/import-graph.js";
import { workflowScenarios } from "../prototypes/cfg/scenarios.js";

describe("CFG dependency impact prototype", () => {
  const nodes: DependencyNode[] = [
    { id: "schema", dependencies: [] },
    { id: "theme", dependencies: [] },
    { id: "client", dependencies: ["schema"] },
    { id: "app", dependencies: ["client", "theme"] },
    { id: "docs", dependencies: [] },
  ];
  it("propagates each change to consumers, with causes and unaffected nodes", () => {
    expect(analyzeImpact(nodes, ["schema", "theme"])).toMatchObject({
      status: "analyzed", affected: [
        { node: "app", causes: ["schema", "theme"] },
        { node: "client", causes: ["schema"] },
        { node: "schema", causes: ["schema"] },
        { node: "theme", causes: ["theme"] },
      ], unaffected: ["docs"],
    });
    expect(analyzeImpact(nodes, ["app"])).toMatchObject({
      status: "analyzed", affected: [{ node: "app", causes: ["app"] }],
      unaffected: ["client", "docs", "schema", "theme"],
    });
  });
  it("handles cycles, duplicate change seeds, disconnected nodes and no changes", () => {
    const cycle = [{ id: "a", dependencies: ["b"] }, { id: "b", dependencies: ["a"] }, { id: "c", dependencies: [] }];
    expect(analyzeImpact(cycle, ["a", "a"])).toMatchObject({ status: "analyzed", affected: [
      { node: "a", causes: ["a"] }, { node: "b", causes: ["a"] },
    ], unaffected: ["c"] });
    expect(analyzeImpact(cycle, [])).toMatchObject({ status: "analyzed", affected: [], unaffected: ["a", "b", "c"] });
    expect(analyzeImpact([], [])).toMatchObject({ status: "analyzed", affected: [], unaffected: [] });
  });
  it("does not turn incomplete analysis or malformed input into a rebuild plan", () => {
    for (const result of [
      analyzeImpact(nodes, ["missing"]),
      analyzeImpact([{ id: "a", dependencies: ["missing"] }], []),
      analyzeImpact([...nodes, nodes[0]], []),
      analyzeImpact([{ id: "", dependencies: [] }], []),
      analyzeImpact(nodes, ["schema"], { budget: 1 }),
    ]) {
      expect(result.status).toBe("unknown");
      expect(result).not.toHaveProperty("affected");
    }
  });
  it("does not collide with a user node named like the synthetic entry", () => {
    expect(analyzeImpact([{ id: "$changes", dependencies: [] }], ["$changes"]))
      .toMatchObject({ status: "analyzed", affected: [{ node: "$changes", causes: ["$changes"] }] });
  });
  it("matches independent graph traversals on 128 generated cyclic graphs", () => {
    for (let seed = 1; seed <= 128; seed++) {
      const graph = generatedDependencies(seed);
      const changed = seed % 8 === 0 ? [] : ["node-0", "node-3", "node-7"];
      const result = analyzeImpact(graph, changed);
      expect(result.status, `seed ${seed}`).toBe("analyzed");
      if (result.status !== "analyzed") throw new Error(result.detail);
      expect(result.affected, `seed ${seed}`).toEqual(referenceImpact(graph, changed));
      expect(analyzeImpact([...graph].reverse(), changed)).toMatchObject({ affected: result.affected });
    }
  });
});

describe("CFG workflow preflight prototype", () => {
  it.each(workflowScenarios)("evaluates the runnable $name scenario", ({ workflow, expected }) => {
    expect(verifyWorkflow(workflow).status).toBe(expected);
  });
  it("propagates reachable empty states through no-op steps", () => {
    const result = verifyWorkflow({ entry: "start", steps: [
      { id: "start", next: ["publish"] },
      { id: "publish", requires: ["approved"], next: [] },
      { id: "unused", requires: ["impossible"], next: [] },
    ] });
    expect(result).toMatchObject({ status: "invalid", diagnostics: [{ step: "publish", missing: ["approved"] }], unreachable: ["unused"] });
  });
  it("requires approval on every alternative branch, and accepts the repaired graph", () => {
    const workflow: Workflow = { entry: "start", steps: [
      { id: "start", next: ["review", "bypass"] },
      { id: "review", provides: ["approved"], next: ["publish"] },
      { id: "bypass", next: ["publish"] },
      { id: "publish", requires: ["approved"], next: [] },
    ] };
    expect(verifyWorkflow(workflow)).toMatchObject({ status: "invalid", diagnostics: [{ step: "publish", missing: ["approved"] }] });
    expect(verifyWorkflow({ ...workflow, steps: workflow.steps.map(s => s.id === "bypass" ? { ...s, provides: ["approved"] } : s) }))
      .toMatchObject({ status: "valid", diagnostics: [] });
  });
  it("checks requirements before outputs and carries revocation around loops", () => {
    expect(verifyWorkflow({ entry: "publish", steps: [
      { id: "publish", requires: ["approved"], provides: ["approved"], next: [] },
    ] })).toMatchObject({ status: "invalid", diagnostics: [{ step: "publish", missing: ["approved"] }] });
    expect(verifyWorkflow({ entry: "publish", initial: ["approved"], steps: [
      { id: "publish", requires: ["approved"], next: ["edit", "end"] },
      { id: "edit", revokes: ["approved"], next: ["publish"] },
      { id: "end", next: [] },
    ] })).toMatchObject({ status: "invalid", diagnostics: [{ step: "publish", missing: ["approved"] }] });
  });
  it("does not assume a loop body has executed on the zero-iteration path", () => {
    expect(verifyWorkflow({ entry: "loop", steps: [
      { id: "loop", next: ["review", "publish"] },
      { id: "review", provides: ["approved"], next: ["loop"] },
      { id: "publish", requires: ["approved"], next: [] },
    ] })).toMatchObject({ status: "invalid", diagnostics: [{ step: "publish", missing: ["approved"] }] });
  });
  it("does not merge alternative prerequisites as if both branches ran", () => {
    expect(verifyWorkflow({ entry: "start", steps: [
      { id: "start", next: ["build", "review"] },
      { id: "build", provides: ["artifact"], next: ["publish"] },
      { id: "review", provides: ["approved"], next: ["publish"] },
      { id: "publish", requires: ["artifact", "approved"], next: [] },
    ] })).toMatchObject({ status: "invalid", diagnostics: [{ step: "publish", missing: ["approved", "artifact"] }] });
  });
  it("reports invalid graphs and exhausted budgets as unknown, without diagnostics", () => {
    for (const workflow of [
      { entry: "missing", steps: [] },
      { entry: "a", steps: [{ id: "a", next: ["missing"] }] },
      { entry: "a", steps: [{ id: "a", next: [] }, { id: "a", next: [] }] },
      { entry: "", steps: [{ id: "", next: [] }] },
    ]) expect(verifyWorkflow(workflow).status).toBe("unknown");
    const result = verifyWorkflow({ entry: "a", steps: [{ id: "a", next: ["b"] }, { id: "b", next: [] }] }, { budget: 1 });
    expect(result).toMatchObject({ status: "unknown", reason: "proof-budget-exhausted" });
    expect(result).not.toHaveProperty("diagnostics");
  });
  it("matches exhaustive concrete execution on 128 finite models, regardless of scheduling order", () => {
    for (let seed = 1; seed <= 128; seed++) {
      const workflow = generatedWorkflow(seed);
      const { configurations: _, ...expected } = referenceWorkflow(workflow);
      expect(verifyWorkflow(workflow), `seed ${seed}`).toMatchObject(expected);
      expect(verifyWorkflow({ ...workflow, steps: [...workflow.steps].reverse().map(step => ({
        ...step, next: [...step.next].reverse(),
      })) }), `reversed seed ${seed}`).toMatchObject(expected);
    }
  });
});

describe("repository import graph adapter", () => {
  it("extracts literal imports, reexports, type imports and dynamic imports, excluding comments and strings", () => {
    const result = extractImportGraph(new Map([
      ["src/a.ts", `import type { B } from './b.js'; export * from './b.js';
        type D = import('./types.js').D; const lazy = import('./lazy.js');
        import fs from 'node:fs'; // import './fake.js';
        const text = "import './also-fake.js'";`],
      ["src/b.ts", "export interface B {}"], ["src/types.d.ts", "export interface D {}"],
      ["src/lazy.ts", "export {};"],
    ]));
    expect(result.nodes.find(node => node.id === "src/a.ts")?.dependencies)
      .toEqual(["src/b.ts", "src/lazy.ts", "src/types.d.ts"]);
    expect(result.externalSpecifiers).toEqual(["node:fs"]);
    expect(result.unresolved).toEqual([]);
  });
  it("makes unresolved and computed imports visible instead of claiming complete coverage", () => {
    const result = extractImportGraph(new Map([["src/a.ts", `import './missing.js'; import(target);`]]));
    expect(result.unresolved).toEqual([
      { file: "src/a.ts", specifier: "./missing.js" },
      { file: "src/a.ts", specifier: "<computed import>" },
    ]);
  });
});

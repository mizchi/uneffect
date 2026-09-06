import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { analyzeImpact } from "../../src/graph-analysis/impact-api.js";
import { verifyWorkflow } from "../../src/graph-analysis/workflow-api.js";
import { extractImportGraph } from "./import-graph.js";
import { generatedDependencies, generatedWorkflow, referenceImpact, referenceWorkflow } from "./oracles.js";
import { buildGraph, workflowScenarios, parallelWorkflowScenarios } from "./scenarios.js";
import { generatedParallelSchedule, referenceParallelSchedules } from "./parallel-oracle.js";
import type { DependencyNode } from "../../src/graph-analysis/contracts.js";

function measure<T>(run: () => T) {
  const start = performance.now();
  const value = run();
  return { value, milliseconds: Number((performance.now() - start).toFixed(3)) };
}

function impactComparison(nodes: readonly DependencyNode[], changed: readonly string[]) {
  const cfg = measure(() => analyzeImpact(nodes, changed));
  const traversal = measure(() => referenceImpact(nodes, changed));
  if (cfg.value.status !== "analyzed") throw new Error(cfg.value.detail);
  assert.deepEqual(cfg.value.affected, traversal.value);
  return { nodes: nodes.length, edges: nodes.reduce((count, node) => count + node.dependencies.length, 0),
    changed, affected: cfg.value.affected.length, unaffected: cfg.value.unaffected.length,
    iterations: cfg.value.iterations, cfgMs: cfg.milliseconds, traversalMs: traversal.milliseconds,
    matchesIndependentTraversal: true, causes: cfg.value.affected };
}

// This runner reports JSON for inspection or comparison; a mismatch exits nonzero.
const workflows = workflowScenarios.map(({ name, workflow, expected }) => {
  const actual = verifyWorkflow(workflow);
  const { configurations, ...reference } = referenceWorkflow(workflow);
  if (actual.status === "unknown") throw new Error(actual.detail);
  assert.equal(actual.status, expected);
  const { iterations, ...observed } = actual;
  assert.deepEqual(observed, reference);
  return { name, status: actual.status, diagnostics: actual.diagnostics, iterations, concreteConfigurations: configurations };
});

let concreteConfigurations = 0;
let parallelSchedules = 0;
for (let seed = 1; seed <= 128; seed++) {
  const nodes = generatedDependencies(seed);
  const changed = seed % 8 === 0 ? [] : ["node-0", "node-3", "node-7"];
  const impact = analyzeImpact(nodes, changed);
  if (impact.status !== "analyzed") throw new Error(impact.detail);
  assert.deepEqual(impact.affected, referenceImpact(nodes, changed));
  const workflow = generatedWorkflow(seed);
  const result = verifyWorkflow(workflow);
  if (result.status === "unknown") throw new Error(result.detail);
  const { configurations, ...reference } = referenceWorkflow(workflow);
  concreteConfigurations += configurations;
  const { iterations: _, ...observed } = result;
  assert.deepEqual(observed, reference);
  const parallel = generatedParallelSchedule(seed);
  const actualParallel = verifyWorkflow(parallel.workflow);
  if (actualParallel.status === "unknown") throw new Error(actualParallel.detail);
  const { schedules, ...parallelReference } = referenceParallelSchedules(parallel);
  parallelSchedules += schedules;
  const { iterations: parallelIterations, ...parallelObserved } = actualParallel;
  assert.deepEqual(parallelObserved, parallelReference);
}

const parallelWorkflows = parallelWorkflowScenarios.map(({ name, workflow, expected }) => {
  const { value, milliseconds } = measure(() => verifyWorkflow(workflow));
  if (value.status === "unknown") throw new Error(value.detail);
  assert.equal(value.status, expected);
  return { name, status: value.status, diagnostics: value.diagnostics, unreachable: value.unreachable,
    iterations: value.iterations, milliseconds };
});

const sources = new Map<string, string>();
function readSources(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) readSources(path);
    else if (path.endsWith(".ts")) sources.set(path, readFileSync(path, "utf8"));
  }
}
readSources("src");
const repository = extractImportGraph(sources);
const repositoryChanges = ["src/cfg/contracts.ts", "src/cfg/completion.ts", "src/runtime/numeric.ts"];
const repositoryResults = repositoryChanges.map(changed => impactComparison(repository.nodes, [changed]));
const scaleGraph: DependencyNode[] = Array.from({ length: 2_000 }, (_, index) => ({
  id: `task-${index}`,
  dependencies: [index - 1, index - 17].filter(dependency => dependency >= 0).map(dependency => `task-${dependency}`),
}));
const { causes: _, ...scale } = impactComparison(scaleGraph, ["task-0", "task-1000"]);

console.log(JSON.stringify({
  scope: "supported graph models; graph-relative impact, workflow preconditions and explicit parallel barriers",
  generatedModels: { impact: 128, workflow: 128, concreteConfigurations, parallelWorkflow: 128, parallelSchedules, mismatches: 0 },
  workflows,
  parallelWorkflows,
  build: impactComparison(buildGraph, ["api-schema", "theme"]),
  scale,
  repository: { scope: "src literal relative ESM imports, including type imports; not a complete build graph",
    externalSpecifiers: repository.externalSpecifiers, unresolved: repository.unresolved, results: repositoryResults },
}, null, 2));

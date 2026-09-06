import type { DependencyNode, Workflow } from "../../src/graph-analysis/contracts.js";

export const buildGraph: readonly DependencyNode[] = [
  { id: "api-schema", dependencies: [] },
  { id: "theme", dependencies: [] },
  { id: "generated-client", dependencies: ["api-schema"] },
  { id: "web-bundle", dependencies: ["generated-client", "theme"] },
  { id: "web-tests", dependencies: ["web-bundle"] },
  { id: "worker-bundle", dependencies: ["generated-client"] },
  { id: "worker-tests", dependencies: ["worker-bundle"] },
  { id: "docs", dependencies: [] },
];

const reviewedRelease: Workflow = { entry: "build", steps: [
  { id: "build", provides: ["artifact"], next: ["review"] },
  { id: "review", requires: ["artifact"], provides: ["approved"], next: ["publish", "edit"] },
  { id: "edit", revokes: ["approved"], next: ["review"] },
  { id: "publish", requires: ["artifact", "approved"], next: [] },
] };

export const workflowScenarios: readonly { name: string; workflow: Workflow; expected: "valid" | "invalid" }[] = [
  { name: "reviewed-release", workflow: reviewedRelease, expected: "valid" },
  { name: "approval-bypass", expected: "invalid", workflow: { ...reviewedRelease,
    steps: reviewedRelease.steps.map(step => step.id === "build" ? { ...step, next: ["review", "publish"] } : step),
  } },
  { name: "edit-without-reapproval", expected: "invalid", workflow: { ...reviewedRelease,
    steps: reviewedRelease.steps.map(step => step.id === "edit" ? { ...step, next: ["publish"] } : step),
  } },
  { name: "alternative-branches-are-not-a-barrier", expected: "invalid", workflow: { entry: "start", steps: [
    { id: "start", next: ["build", "review"] },
    { id: "build", provides: ["artifact"], next: ["publish"] },
    { id: "review", provides: ["approved"], next: ["publish"] },
    { id: "publish", requires: ["artifact", "approved"], next: [] },
  ] } },
];

const parallelRelease: Workflow = { entry: "prepare", steps: [
  { id: "prepare", kind: "fork", join: "ready", next: ["build", "review"] },
  { id: "build", provides: ["artifact"], next: ["ready"] },
  { id: "review", provides: ["approved"], next: ["ready"] },
  { id: "ready", kind: "join", fork: "prepare", requires: ["artifact", "approved"], next: ["publish"] },
  { id: "publish", requires: ["artifact", "approved"], next: [] },
] };

export const parallelWorkflowScenarios: readonly { name: string; workflow: Workflow; expected: "valid" | "invalid" }[] = [
  { name: "parallel-release", workflow: parallelRelease, expected: "valid" },
  { name: "branch-ends-without-arrival", expected: "invalid", workflow: { ...parallelRelease,
    steps: parallelRelease.steps.map(step => step.id === "review" ? { ...step, next: [] } : step),
  } },
  { name: "approval-revoked-concurrently", expected: "invalid", workflow: { ...parallelRelease,
    steps: parallelRelease.steps.map(step => step.id === "build" ? { ...step, revokes: ["approved"] } : step),
  } },
  { name: "parallel-retry-can-reach-barrier", expected: "valid", workflow: { ...parallelRelease,
    steps: parallelRelease.steps.map(step => step.id === "review" ? { ...step, next: ["review", "ready"] } : step),
  } },
];

import { createHash } from "node:crypto";
import { solveBasicBlockFixedPoint } from "../cfg/index.js";
import type { ModuleSource, ModuleSpan } from "./module-order-core.js";
import type {
  ModuleInitializationOrder, ModuleInitializationControlFlowEdgeRole, ModuleInitializationEventV2,
  ModuleInitializationControlFlowEdge, ModuleInitializationControlFlowProof, ModuleInitializationCompletionPath,
  ModuleInitializationControlFlow, ModuleInitializationModuleV2, ModuleInitializationUnknownV2,
  ModuleInitializationConstraintV2, ModuleInitializationOrderV2, ModuleInitializationSourceEvidence,
} from "./contracts.js";

export interface ConditionalAwaitFacts {
  readonly source: ModuleSource;
  readonly statement: ModuleSpan;
  readonly selector: ModuleSpan & { readonly text: string };
  readonly awaitExpression: ModuleSpan;
}

interface ModuleControlFlowValue {
  readonly active: boolean;
  readonly paths: ReadonlySet<ModuleInitializationCompletionPath>;
  /** True if any incoming normal path still owes an actual resume event. */
  readonly pendingResume: boolean;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathKey(value: ModuleControlFlowValue): string {
  return `${value.active}:${value.pendingResume}:${[...value.paths].sort().join("\0")}`;
}

function makeControlFlow(
  candidate: ConditionalAwaitFacts,
  limit: number,
): ModuleInitializationControlFlow {
  const { source, statement, selector, awaitExpression } = candidate;
  const fileName = source.fileName;
  const span = (node: ModuleSpan): { start: number; end: number } => ({
    start: node.start, end: node.end,
  });
  const sourceEvidence: ModuleInitializationSourceEvidence = {
    kind: "program-source", sourceDigest: digest(source.text),
  };
  const start = `${fileName}#start`, branch = `${fileName}#branch:0`;
  const suspend = `${fileName}#suspend:0`, resume = `${fileName}#resume:0`;
  const reject = `${fileName}#reject:0`, join = `${fileName}#join:0`, complete = `${fileName}#complete`;
  const blocks: ModuleInitializationEventV2[] = [
    { id: start, kind: "start", span: { start: 0, end: 0 } },
    { id: branch, kind: "branch", span: span(selector) },
    { id: suspend, kind: "suspend", span: span(awaitExpression) },
    { id: resume, kind: "resume", span: span(awaitExpression) },
    { id: reject, kind: "reject", span: span(awaitExpression) },
    { id: join, kind: "join", span: { start: statement.end, end: statement.end } },
    { id: complete, kind: "complete", span: { start: source.text.length, end: source.text.length } },
  ];
  const edge = (
    from: string,
    to: string,
    role: ModuleInitializationControlFlowEdgeRole,
    completion: "normal" | "throw" = "normal",
    sourceSpan = span(statement),
  ): ModuleInitializationControlFlowEdge => ({
    from, to, role, completion, sourceFile: fileName, sourceSpan, evidence: sourceEvidence,
  });
  const edges = [
    edge(start, branch, "sequence", "normal", span(selector)),
    edge(branch, suspend, "branch-true", "normal", span(statement)),
    edge(branch, join, "branch-false", "normal", span(statement)),
    edge(suspend, resume, "await-resume", "normal", span(awaitExpression)),
    edge(suspend, reject, "await-reject", "throw", span(awaitExpression)),
    edge(resume, join, "sequence", "normal", span(awaitExpression)),
    edge(join, complete, "sequence", "normal", { start: statement.end, end: source.text.length }),
  ] as const;
  const successors = new Map<string, ModuleInitializationControlFlowEdge[]>();
  for (const item of edges) successors.set(item.from, [...(successors.get(item.from) ?? []), item]);
  const value = (active: boolean, ...paths: ModuleInitializationCompletionPath[]): ModuleControlFlowValue => ({
    active, paths: new Set(paths), pendingResume: false,
  });
  const result = solveBasicBlockFixedPoint<ModuleControlFlowValue>({
    entry: start,
    initial: value(true),
    budget: { name: "module-control-flow-iterations", limit },
    lattice: {
      bottom: () => value(false),
      equivalent: (left, right) => pathKey(left) === pathKey(right),
      join: (left, right) => ({
        status: "joined",
        value: {
          active: left.active || right.active,
          paths: new Set([...left.paths, ...right.paths]),
          pendingResume: left.pendingResume || right.pendingResume,
        },
      }),
    },
    blocks: blocks.map((block) => ({
      id: block.id,
      edges: (successors.get(block.id) ?? []).map((item) => ({
        to: item.to, completion: item.completion, role: item.role === "sequence" ? "forward" : "branch",
        sourceSpan: item.sourceSpan,
      })),
      transfer: (input) => {
        if (block.id === branch) return [
          { to: suspend, value: { ...value(true, "await-resume"), pendingResume: true } },
          { to: join, value: value(true, "branch-false") },
        ];
        if (block.id === suspend) return [
          { to: resume, value: { ...value(true, "await-resume"), pendingResume: input.pendingResume } },
          { to: reject, value: value(true, "await-reject") },
        ];
        // A predicted path label cannot discharge this obligation. Only
        // traversing the resume block clears it on the normal branch.
        const output = block.id === resume ? { ...input, pendingResume: false } : input;
        return (successors.get(block.id) ?? []).map((item) => ({ to: item.to, value: output }));
      },
    })),
  });
  const order: Record<ModuleInitializationCompletionPath, number> = {
    "branch-false": 0, "await-resume": 1, "await-reject": 2,
  };
  const reachableBy = Object.fromEntries([...result.states].flatMap(([id, state]) => state.paths.size === 0
    ? []
    : [[id, [...state.paths].sort((left, right) => order[left] - order[right])]]));
  const expectedCompletion = pathKey(value(true, "branch-false", "await-resume"));
  const expectedRejection = pathKey(value(true, "await-reject"));
  const postcondition = result.status === "converged"
    && pathKey(result.states.get(complete)!) === expectedCompletion
    && pathKey(result.states.get(join)!) === expectedCompletion
    && pathKey(result.states.get(reject)!) === expectedRejection;
  const proof: ModuleInitializationControlFlowProof = result.status === "converged" && postcondition
    ? { status: "converged", iterations: result.iterations, budget: result.budget as ModuleInitializationControlFlowProof["budget"], reachableBy }
    : result.status === "converged"
      ? {
        status: "unknown", reason: "domain-postcondition-failed",
        detail: "conditional await CFG did not retain exactly false/resume completion, mandatory resumption, and terminal rejection",
        iterations: result.iterations,
        budget: result.budget as ModuleInitializationControlFlowProof["budget"], reachableBy,
      }
    : {
      status: "unknown", reason: result.reason, detail: result.detail, iterations: result.iterations,
      budget: result.budget as ModuleInitializationControlFlowProof["budget"], reachableBy,
    };
  return {
    entry: start, completion: complete,
    selector: { name: selector.text, span: span(selector) },
    blocks, edges, proof,
  };
}

/** Apply the same bounded false/resume/rejection proof to any authenticated syntax frontend. */
export function applyModuleOrderControlFlow(baseline: ModuleInitializationOrder, candidate: ConditionalAwaitFacts | undefined, limit: number): ModuleInitializationOrderV2 {
  const controlFlow = candidate ? makeControlFlow(candidate, limit) : undefined;
  const candidateSpan = candidate ? {
    start: candidate.awaitExpression.start, end: candidate.awaitExpression.end,
  } : undefined;
  const unknowns: ModuleInitializationUnknownV2[] = controlFlow
    ? baseline.unknowns.filter((unknown) => !(unknown.kind === "conditional-top-level-await"
      && unknown.fileName === candidate!.source.fileName && unknown.span?.start === candidateSpan!.start))
    : [...baseline.unknowns];
  if (candidate && controlFlow?.proof.status === "unknown") unknowns.push({
    fileName: candidate.source.fileName,
    kind: "module-control-flow-proof",
    span: candidateSpan,
    detail: controlFlow.proof.detail ?? "module control-flow proof did not converge",
  });
  const modules: ModuleInitializationModuleV2[] = baseline.modules.map((module) => module.fileName !== candidate?.source.fileName
    ? { ...module, events: [...module.events], choices: [...module.choices] }
    : { ...module, events: [...controlFlow!.blocks], choices: [...module.choices], controlFlow });
  const constraints: ModuleInitializationConstraintV2[] = candidate
    ? baseline.constraints.filter((constraint) => !(constraint.sourceFile === candidate.source.fileName
      && constraint.reason === "module-sequencing"))
    : [...baseline.constraints];
  if (candidate && controlFlow) {
    for (const edge of controlFlow.edges) constraints.push({
      before: edge.from, after: edge.to, reason: "module-control-flow",
      sourceFile: edge.sourceFile, sourceSpan: edge.sourceSpan,
      semanticRule: "conditional-source-order", evidence: edge.evidence,
    });
  }
  return {
    schema: "uneffect-module-order/v2", schemaVersion: 2,
    entryFile: baseline.entryFile, compiler: baseline.compiler,
    evidence: unknowns.length === 0 ? "verified" : "unknown",
    modules, constraints, cycleComponents: [...baseline.cycleComponents], unknowns,
    claims: [
      ...baseline.claims,
      "a conditional top-level await completes only through its false or await-resume path",
    ],
    exclusions: [
      ...baseline.exclusions,
      "conditional top-level await is limited to one runtime-present source-local const Boolean selector",
    ],
  };
}

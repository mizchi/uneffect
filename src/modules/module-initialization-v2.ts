import { createHash } from "node:crypto";
import ts from "@typescript/typescript6";
import { analyzeModuleInitializationOrder } from "./module-initialization.js";
import { solveBasicBlockFixedPoint } from "../cfg/index.js";
import { classifyLexicalExecution } from "../frontends/typescript/lexical-execution.js";
import type {
  ModuleInitializationV2Options,
  ModuleInitializationControlFlowEdgeRole,
  ModuleInitializationEventV2,
  ModuleInitializationControlFlowEdge,
  ModuleInitializationControlFlowProof,
  ModuleInitializationCompletionPath,
  ModuleInitializationControlFlow,
  ModuleInitializationModuleV2,
  ModuleInitializationUnknownV2,
  ModuleInitializationConstraintV2,
  ModuleInitializationOrderV2,
  ModuleInitializationModule,
  ModuleInitializationSourceEvidence,
  ModuleInitializationUnknown,
} from "./contracts.js";

import { moduleControlFlowLimit } from "./options.js";
export { DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET } from "./options.js";

export type {
  ModuleInitializationV2Options,
  ModuleInitializationEventKindV2,
  ModuleInitializationControlFlowEdgeRole,
  ModuleInitializationEventV2,
  ModuleInitializationControlFlowEdge,
  ModuleInitializationControlFlowProof,
  ModuleInitializationCompletionPath,
  ModuleInitializationControlFlow,
  ModuleInitializationModuleV2,
  ModuleInitializationUnknownV2,
  ModuleInitializationConstraintV2,
  ModuleInitializationOrderV2,
} from "./contracts.js";

interface ConditionalAwaitCandidate {
  readonly source: ts.SourceFile;
  readonly statement: ts.IfStatement;
  readonly selector: ts.Identifier;
  readonly awaitExpression: ts.AwaitExpression;
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

function directAwait(statement: ts.Statement): ts.AwaitExpression | undefined {
  const body = ts.isBlock(statement)
    ? statement.statements.length === 1 ? statement.statements[0] : undefined
    : statement;
  if (!body || ts.isIfStatement(body) || ts.isForStatement(body) || ts.isForInStatement(body)
    || ts.isForOfStatement(body) || ts.isWhileStatement(body) || ts.isDoStatement(body)
    || ts.isSwitchStatement(body) || ts.isTryStatement(body) || ts.isWithStatement(body)
    || ts.isLabeledStatement(body)) return undefined;
  const awaits: ts.AwaitExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) return;
    if (ts.isAwaitExpression(node)) awaits.push(node);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return awaits.length === 1 && classifyLexicalExecution(awaits[0]!, body) === "exactly-once"
    ? awaits[0]
    : undefined;
}

function runtimeConstBoolean(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  selector: ts.Identifier,
): boolean {
  const symbol = checker.getSymbolAtLocation(selector);
  const declaration = symbol?.valueDeclaration;
  if (!declaration || !ts.isVariableDeclaration(declaration) || declaration.getSourceFile() !== source
    || !ts.isIdentifier(declaration.name) || !declaration.initializer) return false;
  const declarations = declaration.parent;
  const statement = declarations.parent;
  if (!ts.isVariableDeclarationList(declarations) || !ts.isVariableStatement(statement)
    || statement.parent !== source || (declarations.flags & ts.NodeFlags.Const) === 0
    || statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return false;
  if ((checker.getTypeAtLocation(selector).flags & ts.TypeFlags.BooleanLike) === 0) return false;
  const targetContainsSelector = (target: ts.Node): boolean => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
        found = true;
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(target);
    return found;
  };
  let written = false;
  const findWrite = (node: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && targetContainsSelector(node.left)) {
      written = true;
      return;
    }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
      && targetContainsSelector(node.operand)) {
      written = true;
      return;
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && !ts.isVariableDeclarationList(node.initializer)
      && targetContainsSelector(node.initializer)) {
      written = true;
      return;
    }
    ts.forEachChild(node, findWrite);
  };
  findWrite(source);
  return !written;
}

function findConditionalAwaitCandidate(
  program: ts.Program,
  modules: readonly ModuleInitializationModule[],
  unknowns: readonly ModuleInitializationUnknown[],
): ConditionalAwaitCandidate | undefined {
  const conditionalUnknowns = unknowns.filter((unknown) => unknown.kind === "conditional-top-level-await");
  if (conditionalUnknowns.length !== 1) return undefined;
  const unknown = conditionalUnknowns[0]!;
  const source = program.getSourceFile(unknown.fileName);
  const module = modules.find((item) => item.fileName === source?.fileName);
  if (!source || !module || module.choices.length !== 1
    || module.events.filter((event) => event.kind === "suspend").length !== 1
    || !module.events.some((event) => event.kind === "complete")
    || module.events.some((event) => event.kind === "throw"
      || event.kind === "promise-launch" || event.kind === "rejection-handler-attach")) return undefined;
  const candidates = source.statements.filter(ts.isIfStatement).flatMap((statement) => {
    if (statement.elseStatement || !ts.isIdentifier(statement.expression)) return [];
    const awaitExpression = directAwait(statement.thenStatement);
    if (!awaitExpression || awaitExpression.getStart(source) !== unknown.span?.start) return [];
    return [{ source, statement, selector: statement.expression, awaitExpression }];
  });
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  return candidate && runtimeConstBoolean(program.getTypeChecker(), source, candidate.selector)
    ? candidate
    : undefined;
}

function pathKey(value: ModuleControlFlowValue): string {
  return `${value.active}:${value.pendingResume}:${[...value.paths].sort().join("\0")}`;
}

function makeControlFlow(
  candidate: ConditionalAwaitCandidate,
  limit: number,
): ModuleInitializationControlFlow {
  const { source, statement, selector, awaitExpression } = candidate;
  const fileName = source.fileName;
  const span = (node: ts.Node): { start: number; end: number } => ({
    start: node.getStart(source), end: node.getEnd(),
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
    { id: join, kind: "join", span: { start: statement.getEnd(), end: statement.getEnd() } },
    { id: complete, kind: "complete", span: { start: source.getEnd(), end: source.getEnd() } },
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
    edge(join, complete, "sequence", "normal", { start: statement.getEnd(), end: source.getEnd() }),
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

/**
 * Supported v2 module-order projection. The published v1 implementation is
 * called as an immutable baseline; this layer only discharges its single
 * conditional-await unknown after a bounded CFG proof succeeds.
 */
export function analyzeModuleInitializationOrderV2(
  program: ts.Program,
  entryFile: string,
  options: ModuleInitializationV2Options = {},
): ModuleInitializationOrderV2 {
  const limit = moduleControlFlowLimit(options);
  const baseline = analyzeModuleInitializationOrder(program, entryFile);
  const candidate = findConditionalAwaitCandidate(program, baseline.modules, baseline.unknowns);
  const controlFlow = candidate ? makeControlFlow(candidate, limit) : undefined;
  const candidateSpan = candidate ? {
    start: candidate.awaitExpression.getStart(candidate.source), end: candidate.awaitExpression.getEnd(),
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

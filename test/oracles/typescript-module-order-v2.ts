/** Test-only TS6 oracle for validating the native module-order backend. Never shipped. */
import { applyModuleOrderControlFlow } from "../../src/modules/module-order-control-flow.js";
import ts from "../../src/support/typescript-compiler.js";
import { analyzeModuleInitializationOrder } from "../../src/modules/module-initialization.js";
import { classifyLexicalExecution } from "../../src/frontends/typescript/lexical-execution.js";
import type { ModuleInitializationV2Options, ModuleInitializationOrderV2, ModuleInitializationModule, ModuleInitializationUnknown } from "../../src/modules/contracts.js";

import { moduleControlFlowLimit } from "../../src/modules/options.js";
export { DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET } from "../../src/modules/options.js";

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
} from "../../src/modules/contracts.js";

interface ConditionalAwaitCandidate {
  readonly source: ts.SourceFile;
  readonly statement: ts.IfStatement;
  readonly selector: ts.Identifier;
  readonly awaitExpression: ts.AwaitExpression;
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
  const span = (node: ts.Node) => ({ start: node.getStart(), end: node.getEnd() });
  return applyModuleOrderControlFlow(baseline, candidate && {
    source: { fileName: candidate.source.fileName, text: candidate.source.text },
    statement: span(candidate.statement), selector: { ...span(candidate.selector), text: candidate.selector.text },
    awaitExpression: span(candidate.awaitExpression),
  }, limit);
}

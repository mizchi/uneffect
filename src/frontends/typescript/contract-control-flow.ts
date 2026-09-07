import ts from "@typescript/typescript6";
import { createContractControlFlow } from "../../contracts/control-flow-core.js";
import type { ContractExit, ControlFlowSyntax } from "../../contracts/control-flow-contracts.js";

export type { ContractExit } from "../../contracts/control-flow-contracts.js";
export interface ContractControlFlowOptions {
  readonly isNeverCall?: (call: ts.CallExpression) => boolean;
  readonly constantBoolean?: (expression: ts.Expression) => boolean | undefined;
}

/** Read original Program nodes so checker callbacks retain object identity. */
const syntax: ControlFlowSyntax<ts.Statement, ts.Expression> = {
  expression(node) {
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: node.kind === ts.SyntaxKind.TrueKeyword };
    if (ts.isCallExpression(node)) return { kind: "call", callee: node.expression, arguments: node.arguments, conditional: ts.isOptionalChain(node) };
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return { kind: "wrapped", operand: node.expression };
    if (ts.isAwaitExpression(node) || ts.isVoidExpression(node) || ts.isTypeOfExpression(node) || ts.isDeleteExpression(node)) return { kind: "eager", operands: [node.expression] };
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) return ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken
      ? { kind: "not", operand: node.operand } : { kind: "eager", operands: [node.operand] };
    if (ts.isBinaryExpression(node)) return { kind: "binary", left: node.left, right: node.right, operator: ts.tokenToString(node.operatorToken.kind) ?? "" };
    if (ts.isPropertyAccessExpression(node)) return { kind: "eager", operands: [node.expression] };
    if (ts.isElementAccessExpression(node)) return { kind: "eager", operands: [node.expression, ...(!ts.isOptionalChain(node) && node.argumentExpression ? [node.argumentExpression] : [])] };
    if (ts.isNewExpression(node)) return { kind: "eager", operands: [node.expression, ...node.arguments ?? []] };
    if (ts.isTaggedTemplateExpression(node)) return { kind: "eager", operands: [node.tag, ...(ts.isTemplateExpression(node.template) ? node.template.templateSpans.map(span => span.expression) : [])] };
    return { kind: "unknown" };
  },
  statement(node) {
    if (ts.isReturnStatement(node)) return { kind: "return", expression: node.expression };
    if (ts.isThrowStatement(node)) return { kind: "throw" };
    if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) return { kind: ts.isBreakStatement(node) ? "break" : "continue", label: node.label?.text };
    if (ts.isBlock(node)) return { kind: "block", statements: node.statements };
    if (ts.isIfStatement(node)) return { kind: "if", condition: node.expression, consequent: node.thenStatement, alternate: node.elseStatement };
    if (ts.isSwitchStatement(node)) return { kind: "switch", condition: node.expression, clauses: node.caseBlock.clauses.map(clause => ({ isDefault: ts.isDefaultClause(clause), statements: clause.statements })) };
    if (ts.isTryStatement(node)) return { kind: "try", body: node.tryBlock, handler: node.catchClause?.block, finalizer: node.finallyBlock };
    if (ts.isLabeledStatement(node)) return { kind: "label", label: node.label.text, body: node.statement };
    if (ts.isIterationStatement(node, false)) {
      const condition = ts.isWhileStatement(node) || ts.isDoStatement(node) ? node.expression : ts.isForStatement(node) ? node.condition : undefined;
      return { kind: "loop", body: node.statement, condition, unconditional: ts.isForStatement(node) && condition === undefined, postTest: ts.isDoStatement(node) };
    }
    if (ts.isWithStatement(node)) return { kind: "expression", expressions: [node.expression], body: node.statement };
    if (ts.isVariableStatement(node)) return { kind: "expression", expressions: node.declarationList.declarations.flatMap(declaration => declaration.initializer ? [declaration.initializer] : []) };
    if (ts.isExpressionStatement(node)) return { kind: "expression", expressions: [node.expression] };
    return { kind: "normal" };
  },
};
function controlFlow(options: ContractControlFlowOptions) {
  return createContractControlFlow(syntax, {
    constantBoolean: options.constantBoolean,
    isNeverCall: call => ts.isCallExpression(call) && options.isNeverCall?.(call) === true,
  });
}
export function statementExit(statement: ts.Statement, options: ContractControlFlowOptions = {}): Set<ContractExit> {
  return controlFlow(options).statementExit(statement);
}
export function functionMayFallThrough(body: ts.Block, options: ContractControlFlowOptions = {}): boolean {
  return controlFlow(options).functionMayFallThrough(body);
}

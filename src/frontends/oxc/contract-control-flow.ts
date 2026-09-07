import type { Node, CallExpression, FunctionBody } from "oxc-parser";
import { createContractControlFlow } from "../../contracts/control-flow-core.js";
import type { ContractExit, ControlFlowSyntax, StructuralContractControlFlow } from "../../contracts/control-flow-contracts.js";
import { parseOxcSource, topLevelOxcFunctions } from "./source.js";

export interface OxcContractControlFlowOptions {
  readonly isNeverCall?: (call: CallExpression) => boolean;
  readonly constantBoolean?: (expression: Node) => boolean | undefined;
}

/** The whole unparenthesized chain can skip later calls and computed keys. */
function conditionalChain(node: Node): boolean {
  if (node.type === "MemberExpression") return node.optional || conditionalChain(node.object);
  if (node.type === "CallExpression") return node.optional || conditionalChain(node.callee);
  if (node.type === "TSNonNullExpression") return conditionalChain(node.expression);
  return false;
}
const syntax: ControlFlowSyntax<Node, Node> = {
  expression(node) {
    switch (node.type) {
      case "Literal": return typeof node.value === "boolean" ? { kind: "boolean", value: node.value } : { kind: "unknown" };
      case "CallExpression": return { kind: "call", callee: node.callee, arguments: node.arguments, conditional: conditionalChain(node) };
      case "ParenthesizedExpression": case "TSAsExpression": case "TSTypeAssertion":
      case "TSNonNullExpression": case "TSSatisfiesExpression": case "ChainExpression": return { kind: "wrapped", operand: node.expression };
      case "AwaitExpression": case "UpdateExpression": return { kind: "eager", operands: [node.argument] };
      case "UnaryExpression": return node.operator === "!" ? { kind: "not", operand: node.argument } : { kind: "eager", operands: [node.argument] };
      case "BinaryExpression": case "LogicalExpression": case "AssignmentExpression": return { kind: "binary", left: node.left, right: node.right, operator: node.operator };
      case "SequenceExpression": return { kind: "eager", operands: node.expressions };
      case "MemberExpression": return { kind: "eager", operands: [node.object, ...(node.computed && !conditionalChain(node) ? [node.property] : [])] };
      case "NewExpression": return { kind: "eager", operands: [node.callee, ...node.arguments] };
      case "TaggedTemplateExpression": return { kind: "eager", operands: [node.tag, ...node.quasi.expressions] };
      default: return { kind: "unknown" };
    }
  },
  statement(node) {
    switch (node.type) {
      case "ReturnStatement": return { kind: "return", expression: node.argument ?? undefined };
      case "ThrowStatement": return { kind: "throw" };
      case "BreakStatement": case "ContinueStatement": return { kind: node.type === "BreakStatement" ? "break" : "continue", label: node.label?.name };
      case "BlockStatement": return { kind: "block", statements: node.body };
      case "IfStatement": return { kind: "if", condition: node.test, consequent: node.consequent, alternate: node.alternate ?? undefined };
      case "SwitchStatement": return { kind: "switch", condition: node.discriminant, clauses: node.cases.map(clause => ({ isDefault: clause.test === null, statements: clause.consequent })) };
      case "TryStatement": return { kind: "try", body: node.block, handler: node.handler?.body, finalizer: node.finalizer ?? undefined };
      case "LabeledStatement": return { kind: "label", label: node.label.name, body: node.body };
      case "WhileStatement": case "DoWhileStatement": return { kind: "loop", condition: node.test, body: node.body, unconditional: false, postTest: node.type === "DoWhileStatement" };
      case "ForStatement": return { kind: "loop", condition: node.test ?? undefined, body: node.body, unconditional: node.test === null, postTest: false };
      case "ForInStatement": case "ForOfStatement": return { kind: "loop", body: node.body, unconditional: false, postTest: false };
      case "WithStatement": return { kind: "expression", expressions: [node.object], body: node.body };
      case "VariableDeclaration": return { kind: "expression", expressions: node.declarations.flatMap(declaration => declaration.init ? [declaration.init] : []) };
      case "ExpressionStatement": return { kind: "expression", expressions: [node.expression] };
      default: return { kind: "normal" };
    }
  },
};
function controlFlow(options: OxcContractControlFlowOptions) {
  return createContractControlFlow(syntax, {
    constantBoolean: options.constantBoolean,
    isNeverCall: call => call.type === "CallExpression" && options.isNeverCall?.(call) === true,
  });
}
export function oxcStatementExit(statement: Node, options: OxcContractControlFlowOptions = {}): Set<ContractExit> {
  return controlFlow(options).statementExit(statement);
}
export function oxcFunctionMayFallThrough(body: FunctionBody, options: OxcContractControlFlowOptions = {}): boolean {
  return controlFlow(options).functionMayFallThrough(body);
}

/** Structural reachability only; named top-level declarations, no inferred semantic facts. */
export function analyzeOxcContractControlFlow(fileName: string, text: string): StructuralContractControlFlow[] {
  const source = parseOxcSource(fileName, text);
  return topLevelOxcFunctions(source).map(({ node, start, end }) => {
    const exits = [...oxcStatementExit(node.body)];
    return { fileName, name: node.id.name, span: { start, end }, evidence: "structural", exits,
      mayFallThrough: exits.some(exit => exit === "normal" || exit.startsWith("break:") || exit.startsWith("continue:")) };
  });
}

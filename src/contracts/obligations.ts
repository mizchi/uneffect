import { createHash } from "node:crypto";
import type { InvariantSpec } from "../spec/spec-ir.js";
import type { LogicSort, NumericDomain, LogicExpression, InvariantObligation, ObligationVariable, ContractControlFlowEvidence } from "./logic-contracts.js";
import { parseLogicExpression } from "./logic.js";

function sort(value: NumericDomain): LogicSort { return value === "bool" ? "Bool" : value === "float" ? "Real" : "Int"; }
function variable(name: string): LogicExpression { return { kind: "variable", name }; }

function stableId(value: Omit<InvariantObligation, "id">): string {
  return `inv_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)}`;
}

export function controlFlowBlockId(fileName: string, functionName: string, span: { start: number; end: number }, completion: ContractControlFlowEvidence["completion"]): string {
  return `cfg_${createHash("sha256").update(JSON.stringify({ fileName, functionName, span, completion })).digest("hex").slice(0, 20)}`;
}

export function makeObligation(value: Omit<InvariantObligation, "id">): InvariantObligation { return { id: stableId(value), ...value }; }

const smtOperators: Record<string, string> = { add: "+", sub: "-", mul: "*", "int-mod": "mod", lt: "<", lte: "<=", gt: ">", gte: ">=", eq: "=", and: "and", or: "or" };
export function logicToSmt(expression: LogicExpression): string {
  if (expression.kind === "variable") return expression.name;
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "real") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") {
    if (expression.operator === "not") return `(not ${logicToSmt(expression.operand)})`;
    if (expression.operator === "floor") return `(to_int ${logicToSmt(expression.operand)})`;
    if (expression.operator === "ceil") return `(- (to_int (- ${logicToSmt(expression.operand)})))`;
    return `(- ${logicToSmt(expression.operand)})`;
  }
  if (expression.operator === "neq") return `(not (= ${logicToSmt(expression.left)} ${logicToSmt(expression.right)}))`;
  const operator = smtOperators[expression.operator];
  if (!operator) throw new Error(`unsupported SMT operator: ${expression.operator}`);
  return `(${operator} ${logicToSmt(expression.left)} ${logicToSmt(expression.right)})`;
}

export function generateObligationSmt(obligation: InvariantObligation, commands = true): string {
  const lines = ["(set-logic ALL)", ...obligation.variables.map((item) => `(declare-const ${item.name} ${item.sort})`),
    ...obligation.assumptions.map((item) => `(assert ${logicToSmt(item)})`), `(assert (not ${logicToSmt(obligation.goal)}))`];
  if (commands) lines.push("(check-sat)");
  return `${lines.join("\n")}\n`;
}

export function obligationFromSpec(spec: InvariantSpec): InvariantObligation {
  if (!spec.result || spec.ensures.length === 0) throw new Error(`${spec.functionName} has no supported postcondition`);
  const domains = spec.parameterDomains ?? Object.fromEntries(spec.parameters.map((name) => [name, "int"]));
  const variables: ObligationVariable[] = spec.parameters.map((name) => ({ name, domain: domains[name] ?? "int", sort: sort(domains[name] ?? "int") }));
  const resultDomain = spec.resultDomain ?? "int";
  variables.push({ name: "result", domain: resultDomain, sort: sort(resultDomain) });
  const assumptions = spec.requires.map(parseLogicExpression);
  for (const item of variables) if (item.domain === "nat") assumptions.push({ kind: "binary", operator: "gte", left: variable(item.name), right: { kind: "integer", value: "0" } });
  assumptions.push({ kind: "binary", operator: "eq", left: variable("result"), right: parseLogicExpression(spec.result) });
  const goals = spec.ensures.map(parseLogicExpression);
  const goal = goals.reduce((left, right): LogicExpression => ({ kind: "binary", operator: "and", left, right }));
  const fileName = spec.fileName ?? "<spec>";
  const span = spec.span ?? { start: 0, end: 0 };
  const value = { kind: "postcondition" as const, fileName, functionName: spec.functionName, span, variables, assumptions, goal, source: spec.ensures.join(" && "), bindings: [{ name: "result", expression: parseLogicExpression(spec.result) }], displayNames: {}, controlFlow: { schema: "uneffect-contract-control-flow/v1" as const, blockId: controlFlowBlockId(fileName, spec.functionName, span, "synthetic"), completion: "synthetic" as const, pathConditions: [...assumptions] } };
  return makeObligation(value);
}

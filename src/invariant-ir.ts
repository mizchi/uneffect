import { createHash } from "node:crypto";
import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { InvariantSpec } from "./spec-ir.js";

export type LogicSort = "Int" | "Real" | "Bool";
export type NumericDomain = "int" | "nat" | "float" | "bool";
export type LogicExpression =
  | { kind: "variable"; name: string }
  | { kind: "integer"; value: string }
  | { kind: "real"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "unary"; operator: "not" | "negate"; operand: LogicExpression }
  | { kind: "binary"; operator: string; left: LogicExpression; right: LogicExpression };

export interface ObligationVariable { name: string; sort: LogicSort; domain: NumericDomain }
/** How a source-level name (`result`, a local, a loop snapshot) is defined over the obligation variables. */
export interface ObligationBinding { name: string; expression: LogicExpression }
export interface InvariantObligation {
  id: string;
  kind: "postcondition" | "loop-init" | "loop-preserve";
  fileName: string;
  functionName: string;
  span: { start: number; end: number };
  variables: ObligationVariable[];
  assumptions: LogicExpression[];
  goal: LogicExpression;
  source: string;
  bindings: ObligationBinding[];
  /** Readable aliases for generated variables, e.g. `count_i_loop_84` displayed as `i@loop`. */
  displayNames: Record<string, string>;
}

/** A lowering rejection that stays locatable and actionable instead of collapsing to a bare message. */
export class InvariantLoweringError extends Error {
  readonly functionName: string | undefined;
  readonly span: { start: number; end: number } | undefined;
  readonly hint: string | undefined;
  constructor(message: string, detail: { functionName?: string; span?: { start: number; end: number }; hint?: string } = {}) {
    super(message);
    this.name = "InvariantLoweringError";
    this.functionName = detail.functionName;
    this.span = detail.span;
    this.hint = detail.hint;
  }
}

type Environment = Map<string, LogicExpression>;
interface PathState { env: Environment; assumptions: LogicExpression[] }

function parseTsExpression(text: string): ts.Expression {
  const source = ts.createSourceFile("logic.ts", `const value = (${text})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statement = source.statements[0];
  const expression = statement && ts.isVariableStatement(statement) ? statement.declarationList.declarations[0]?.initializer : undefined;
  if (!expression) throw new Error(`invalid invariant expression: ${text}`);
  return expression;
}

function logic(node: ts.Expression, pipeBindings: ReadonlySet<string> = new Set()): LogicExpression {
  if (ts.isParenthesizedExpression(node)) return logic(node.expression, pipeBindings);
  if (ts.isIdentifier(node)) return { kind: "variable", name: node.text };
  if (ts.isNumericLiteral(node)) return node.text.includes(".") ? { kind: "real", value: node.text } : { kind: "integer", value: node.text };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
  if (ts.isPrefixUnaryExpression(node)) {
    if (node.operator === ts.SyntaxKind.ExclamationToken) return { kind: "unary", operator: "not", operand: logic(node.operand, pipeBindings) };
    if (node.operator === ts.SyntaxKind.MinusToken) return { kind: "unary", operator: "negate", operand: logic(node.operand, pipeBindings) };
  }
  if (ts.isBinaryExpression(node)) {
    const operators = new Map<ts.SyntaxKind, string>([
      [ts.SyntaxKind.PlusToken, "add"], [ts.SyntaxKind.MinusToken, "sub"], [ts.SyntaxKind.AsteriskToken, "mul"],
      [ts.SyntaxKind.SlashToken, "div"], [ts.SyntaxKind.PercentToken, "mod"], [ts.SyntaxKind.LessThanToken, "lt"],
      [ts.SyntaxKind.LessThanEqualsToken, "lte"], [ts.SyntaxKind.GreaterThanToken, "gt"], [ts.SyntaxKind.GreaterThanEqualsToken, "gte"],
      [ts.SyntaxKind.EqualsEqualsToken, "eq"], [ts.SyntaxKind.EqualsEqualsEqualsToken, "eq"],
      [ts.SyntaxKind.ExclamationEqualsToken, "neq"], [ts.SyntaxKind.ExclamationEqualsEqualsToken, "neq"],
      [ts.SyntaxKind.AmpersandAmpersandToken, "and"], [ts.SyntaxKind.BarBarToken, "or"],
    ]);
    const operator = operators.get(node.operatorToken.kind);
    if (operator) return { kind: "binary", operator, left: logic(node.left, pipeBindings), right: logic(node.right, pipeBindings) };
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && pipeBindings.has(node.expression.text) && node.arguments.length >= 2) {
    let value = logic(node.arguments[0]!, pipeBindings);
    for (const stage of node.arguments.slice(1)) {
      if ((!ts.isArrowFunction(stage) && !ts.isFunctionExpression(stage)) || stage.parameters.length !== 1
        || !ts.isIdentifier(stage.parameters[0]!.name) || ts.isBlock(stage.body)) {
        throw new Error("verified effect/Function pipe requires inline unary expression callbacks");
      }
      value = substitute(logic(stage.body, pipeBindings), new Map([[stage.parameters[0]!.name.text, value]]));
    }
    return value;
  }
  throw new Error(`unsupported invariant expression: ${node.getText()}`);
}

export function parseLogicExpression(text: string): LogicExpression { return logic(parseTsExpression(text)); }

/** Decides small, purely-boolean implications over the same IR emitted to Z3. */
export function proveBooleanImplication(assumptionSources: string[], goalSource: string): boolean {
  try {
    const assumptions = assumptionSources.map(parseLogicExpression), goal = parseLogicExpression(goalSource);
    const names = new Set<string>();
    const collect = (expression: LogicExpression): void => {
      if (expression.kind === "variable") names.add(expression.name);
      else if (expression.kind === "unary") collect(expression.operand);
      else if (expression.kind === "binary") { collect(expression.left); collect(expression.right); }
    };
    [...assumptions, goal].forEach(collect);
    if (names.size > 12) return false;
    const variables = [...names];
    const evaluate = (expression: LogicExpression, values: Map<string, boolean>): boolean => {
      if (expression.kind === "boolean") return expression.value;
      if (expression.kind === "variable") return values.get(expression.name)!;
      if (expression.kind === "unary" && expression.operator === "not") return !evaluate(expression.operand, values);
      if (expression.kind === "binary" && expression.operator === "and") return evaluate(expression.left, values) && evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "or") return evaluate(expression.left, values) || evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "eq") return evaluate(expression.left, values) === evaluate(expression.right, values);
      if (expression.kind === "binary" && expression.operator === "neq") return evaluate(expression.left, values) !== evaluate(expression.right, values);
      throw new Error("non-boolean ownership guard");
    };
    for (let bits = 0; bits < 2 ** variables.length; bits++) {
      const values = new Map(variables.map((name, index) => [name, Boolean(bits & (1 << index))]));
      if (assumptions.every((item) => evaluate(item, values)) && !evaluate(goal, values)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function substitute(expression: LogicExpression, env: Environment): LogicExpression {
  if (expression.kind === "variable") return env.get(expression.name) ?? expression;
  if (expression.kind === "unary") return { ...expression, operand: substitute(expression.operand, env) };
  if (expression.kind === "binary") return { ...expression, left: substitute(expression.left, env), right: substitute(expression.right, env) };
  return expression;
}

function negate(expression: LogicExpression): LogicExpression { return { kind: "unary", operator: "not", operand: expression }; }
function variable(name: string): LogicExpression { return { kind: "variable", name }; }

function domain(type: ts.TypeNode | undefined): NumericDomain {
  const name = type?.getText() ?? "number";
  if (name === "boolean") return "bool";
  if (name === "Nat") return "nat";
  if (name === "Float") return "float";
  if (name === "number" || name === "Int") return "int";
  throw new Error(`unsupported contract parameter type: ${name}`);
}
function sort(value: NumericDomain): LogicSort { return value === "bool" ? "Bool" : value === "float" ? "Real" : "Int"; }

function stableId(value: Omit<InvariantObligation, "id">): string {
  return `inv_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20)}`;
}

function makeObligation(value: Omit<InvariantObligation, "id">): InvariantObligation { return { id: stableId(value), ...value }; }

/** Maps a lowering rejection to the concrete edit that brings the function back into the verified subset. */
function loweringHint(message: string): string | undefined {
  if (message.startsWith("call requires a verified function summary")) return "inline the callee, or move the call out of the contracted function; the prototype has no call summaries yet";
  if (message.startsWith("unsupported invariant statement")) return "the verified statement subset is: initialized let/const, plain assignment, if/else, while with /* uneffect: invariant ... */, and return";
  if (message.startsWith("while requires")) return "write /* uneffect: invariant ... */ directly above the while statement";
  if (message.startsWith("unsupported invariant expression") || message.startsWith("invalid invariant expression")) return "the expression language is integers, + - * / %, comparisons, && || !, and imported effect/Function pipe with inline unary callbacks";
  if (message.startsWith("unsupported contract parameter type")) return "annotate the parameter as number, Int, Nat, Float, or boolean";
  if (message.startsWith("destructured contract parameters")) return "give the parameter one identifier name and destructure inside the body";
  if (message.startsWith("only initialized identifier variables")) return "declare one identifier per binding and initialize it where it is declared";
  if (message.startsWith("verified effect/Function pipe")) return "write each pipe stage as an inline arrow with one parameter and an expression body";
  return undefined;
}

function locatedLowering(cause: unknown, functionName: string, span: { start: number; end: number }): InvariantLoweringError {
  if (cause instanceof InvariantLoweringError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  return new InvariantLoweringError(message, { functionName, span, hint: loweringHint(message) });
}

export function lowerInvariantProgram(fileName: string, text: string): InvariantObligation[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const pipeBindings = new Set(source.statements.flatMap((statement): string[] => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "effect/Function" || !statement.importClause?.namedBindings
      || !ts.isNamedImports(statement.importClause.namedBindings)) return [];
    return statement.importClause.namedBindings.elements
      .filter((element) => (element.propertyName ?? element.name).text === "pipe")
      .map((element) => element.name.text);
  }));
  const obligations: InvariantObligation[] = [];
  for (const node of source.statements) {
    if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) continue;
    const comments = source.text.slice(node.getFullStart(), node.getStart(source));
    const header = { start: node.getStart(source), end: node.getEnd() };
    let requires: LogicExpression[];
    let ensures: Array<{ source: string; expression: LogicExpression }>;
    try {
      requires = extractAnnotations(comments, "requires").map(parseLogicExpression);
      ensures = extractAnnotations(comments, "ensures").map((value) => ({ source: value, expression: parseLogicExpression(value) }));
    } catch (cause) {
      throw locatedLowering(cause, node.name.text, header);
    }
    if (!requires.length && !ensures.length) continue;
    const variables: ObligationVariable[] = [];
    const env: Environment = new Map();
    const baseAssumptions = [...requires];
    for (const parameter of node.parameters) {
      if (!ts.isIdentifier(parameter.name)) throw new InvariantLoweringError(`destructured contract parameters are unsupported: ${parameter.name.getText(source)}`, { functionName: node.name.text, span: { start: parameter.getStart(source), end: parameter.getEnd() }, hint: loweringHint("destructured contract parameters") });
      let parameterDomain: NumericDomain;
      try {
        parameterDomain = domain(parameter.type);
      } catch (cause) {
        throw locatedLowering(cause, node.name.text, header);
      }
      variables.push({ name: parameter.name.text, domain: parameterDomain, sort: sort(parameterDomain) });
      env.set(parameter.name.text, variable(parameter.name.text));
      if (parameterDomain === "nat") baseAssumptions.push({ kind: "binary", operator: "gte", left: variable(parameter.name.text), right: { kind: "integer", value: "0" } });
    }
    const fn = node.name.text;
    const displayNames: Record<string, string> = {};
    const visibleBindings = (bound: Environment): ObligationBinding[] => [...bound]
      .filter(([name, expression]) => !(expression.kind === "variable" && expression.name === name))
      .map(([name, expression]) => ({ name, expression }));
    const add = (kind: InvariantObligation["kind"], target: ts.Node, assumptions: LogicExpression[], goal: LogicExpression, clause: string, bound: Environment): void => {
      const value: Omit<InvariantObligation, "id"> = { kind, fileName, functionName: fn, span: { start: target.getStart(source), end: target.getEnd() }, variables: [...variables], assumptions, goal, source: clause, bindings: visibleBindings(bound), displayNames: { ...displayNames } };
      obligations.push(makeObligation(value));
    };
    const execute = (statements: readonly ts.Statement[], initial: PathState[]): PathState[] => {
      let paths = initial;
      for (const statement of statements) {
        try {
          paths = step(statement, paths);
        } catch (cause) {
          throw locatedLowering(cause, fn, { start: statement.getStart(source), end: statement.getEnd() });
        }
      }
      return paths;
    };
    /** One statement of the verified subset; anything else is rejected with its own location. */
    const step = (statement: ts.Statement, incoming: PathState[]): PathState[] => {
      let paths = incoming;
      if (ts.isVariableStatement(statement)) {
        for (const path of paths) for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || !declaration.initializer) throw new Error(`only initialized identifier variables are supported: ${declaration.getText(source)}`);
          path.env.set(declaration.name.text, substitute(logic(declaration.initializer, pipeBindings), path.env));
        }
      } else if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(statement.expression.left)) {
        for (const path of paths) path.env.set(statement.expression.left.text, substitute(logic(statement.expression.right, pipeBindings), path.env));
      } else if (ts.isIfStatement(statement)) {
        const forked: PathState[] = [];
        for (const path of paths) {
          const condition = substitute(logic(statement.expression, pipeBindings), path.env);
          const thenStatements = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
          forked.push(...execute(thenStatements, [{ env: new Map(path.env), assumptions: [...path.assumptions, condition] }]));
          const elseStatements = statement.elseStatement ? (ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement]) : [];
          forked.push(...execute(elseStatements, [{ env: new Map(path.env), assumptions: [...path.assumptions, negate(condition)] }]));
        }
        paths = forked;
      } else if (ts.isWhileStatement(statement)) {
        const invariantSource = extractAnnotations(source.text.slice(statement.getFullStart(), statement.getStart(source)), "invariant")[0];
        if (!invariantSource) throw new Error(`while requires /* uneffect: invariant ... */ but ${statement.expression.getText(source)} has none`);
        const invariant = parseLogicExpression(invariantSource);
        const exited: PathState[] = [];
        for (const path of paths) {
          add("loop-init", statement, path.assumptions, substitute(invariant, path.env), invariantSource, path.env);
          const loopEnv: Environment = new Map();
          for (const name of path.env.keys()) {
            const fresh = `${fn}_${name}_loop_${statement.getStart(source)}`;
            displayNames[fresh] = `${name}@loop`;
            if (!variables.some((item) => item.name === fresh)) variables.push({ name: fresh, domain: "int", sort: "Int" });
            loopEnv.set(name, variable(fresh));
          }
          const inv = substitute(invariant, loopEnv), condition = substitute(logic(statement.expression, pipeBindings), loopEnv);
          const bodyStatements = ts.isBlock(statement.statement) ? statement.statement.statements : [statement.statement];
          const bodyPaths = execute(bodyStatements, [{ env: new Map(loopEnv), assumptions: [inv, condition] }]);
          for (const bodyPath of bodyPaths) add("loop-preserve", statement, bodyPath.assumptions, substitute(invariant, bodyPath.env), invariantSource, bodyPath.env);
          exited.push({ env: loopEnv, assumptions: [inv, negate(condition)] });
        }
        paths = exited;
      } else if (ts.isReturnStatement(statement) && statement.expression) {
        for (const path of paths) {
          const resultEnv = new Map(path.env);
          resultEnv.set("result", substitute(logic(statement.expression, pipeBindings), path.env));
          for (const ensure of ensures) add("postcondition", statement, path.assumptions, substitute(ensure.expression, resultEnv), ensure.source, resultEnv);
        }
        paths = [];
      } else if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
        throw new Error(`call requires a verified function summary: ${statement.expression.expression.getText(source)}`);
      } else if (!ts.isEmptyStatement(statement)) {
        throw new Error(`unsupported invariant statement: ${statement.getText(source)}`);
      }
      return paths;
    };
    try {
      execute(node.body.statements, [{ env, assumptions: baseAssumptions }]);
    } catch (cause) {
      throw locatedLowering(cause, fn, { start: node.getStart(source), end: node.getEnd() });
    }
  }
  return obligations;
}

const smtOperators: Record<string, string> = { add: "+", sub: "-", mul: "*", div: "/", mod: "mod", lt: "<", lte: "<=", gt: ">", gte: ">=", eq: "=", and: "and", or: "or" };
export function logicToSmt(expression: LogicExpression): string {
  if (expression.kind === "variable") return expression.name;
  if (expression.kind === "integer") return expression.value;
  if (expression.kind === "real") return expression.value;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary") return expression.operator === "not" ? `(not ${logicToSmt(expression.operand)})` : `(- ${logicToSmt(expression.operand)})`;
  if (expression.operator === "neq") return `(not (= ${logicToSmt(expression.left)} ${logicToSmt(expression.right)}))`;
  return `(${smtOperators[expression.operator]} ${logicToSmt(expression.left)} ${logicToSmt(expression.right)})`;
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
  const value = { kind: "postcondition" as const, fileName: spec.fileName ?? "<spec>", functionName: spec.functionName, span: spec.span ?? { start: 0, end: 0 }, variables, assumptions, goal, source: spec.ensures.join(" && "), bindings: [{ name: "result", expression: parseLogicExpression(spec.result) }], displayNames: {} };
  return makeObligation(value);
}

import ts from "typescript";

export type ContractExit = "normal" | "return" | "throw" | `break:${string}` | `continue:${string}`;
export interface ContractControlFlowOptions {
  isNeverCall?: (call: ts.CallExpression) => boolean;
  constantBoolean?: (expression: ts.Expression) => boolean | undefined;
}

const NORMAL = new Set<ContractExit>(["normal"]);

function union(...sets: ReadonlySet<ContractExit>[]): Set<ContractExit> {
  return new Set(sets.flatMap((set) => [...set]));
}

function sequence(left: ReadonlySet<ContractExit>, right: () => ReadonlySet<ContractExit>): Set<ContractExit> {
  if (!left.has("normal")) return new Set(left);
  return union(new Set([...left].filter((item) => item !== "normal")), right());
}

function statementsExit(statements: readonly ts.Statement[], options: ContractControlFlowOptions): Set<ContractExit> {
  let exits: Set<ContractExit> = new Set(NORMAL);
  for (const statement of statements) exits = sequence(exits, () => statementExit(statement, options));
  return exits;
}

function switchExit(statement: ts.SwitchStatement, options: ContractControlFlowOptions): Set<ContractExit> {
  const clauses = statement.caseBlock.clauses;
  let exits = new Set<ContractExit>();
  for (let entry = 0; entry < clauses.length; entry += 1) {
    let path = new Set<ContractExit>(NORMAL);
    for (let index = entry; index < clauses.length; index += 1) {
      path = sequence(path, () => statementsExit(clauses[index]!.statements, options));
    }
    exits = union(exits, path);
  }
  if (!clauses.some(ts.isDefaultClause)) exits.add("normal");
  if (exits.delete("break:")) exits.add("normal");
  return exits;
}

function tryExit(statement: ts.TryStatement, options: ContractControlFlowOptions): Set<ContractExit> {
  let exits = statementExit(statement.tryBlock, options);
  if (statement.catchClause) {
    // Expressions and host operations may throw even when the structural IR has
    // no explicit ThrowStatement, so every catch remains a possible path.
    exits = union(new Set([...exits].filter((item) => item !== "throw")), statementExit(statement.catchClause.block, options));
  }
  if (!statement.finallyBlock) return exits;
  const finalExits = statementExit(statement.finallyBlock, options);
  const abruptFinal = new Set([...finalExits].filter((item) => item !== "normal"));
  return finalExits.has("normal") ? union(exits, abruptFinal) : abruptFinal;
}

function loopExit(statement: ts.IterationStatement, options: ContractControlFlowOptions, label = ""): Set<ContractExit> {
  const body = statementExit(statement.statement, options);
  const returned = new Set([...body].filter((item) => item === "return" || item === "throw" || (item.startsWith("break:") && item !== "break:" && item !== `break:${label}`) || (item.startsWith("continue:") && item !== "continue:" && item !== `continue:${label}`)));
  const always = (ts.isWhileStatement(statement) || ts.isDoStatement(statement))
    ? statement.expression.kind === ts.SyntaxKind.TrueKeyword || options.constantBoolean?.(statement.expression) === true
    : ts.isForStatement(statement) && statement.condition === undefined;
  if (!always || body.has("break:") || (label !== "" && body.has(`break:${label}`))) returned.add("normal");
  return returned;
}

function labeledExit(statement: ts.LabeledStatement, options: ContractControlFlowOptions): Set<ContractExit> {
  const label = statement.label.text;
  const exits = ts.isIterationStatement(statement.statement, false)
    ? loopExit(statement.statement, options, label)
    : statementExit(statement.statement, options);
  if (exits.delete(`break:${label}`)) exits.add("normal");
  return exits;
}

export function statementExit(statement: ts.Statement, options: ContractControlFlowOptions = {}): Set<ContractExit> {
  if (ts.isReturnStatement(statement)) return new Set(["return"]);
  if (ts.isThrowStatement(statement)) return new Set(["throw"]);
  if (ts.isBreakStatement(statement)) return new Set<ContractExit>([`break:${statement.label?.text ?? ""}`]);
  if (ts.isContinueStatement(statement)) return new Set<ContractExit>([`continue:${statement.label?.text ?? ""}`]);
  if (ts.isBlock(statement)) return statementsExit(statement.statements, options);
  if (ts.isIfStatement(statement)) {
    const condition = options.constantBoolean?.(statement.expression);
    if (condition === true) return statementExit(statement.thenStatement, options);
    if (condition === false) return statement.elseStatement ? statementExit(statement.elseStatement, options) : new Set(NORMAL);
    return union(statementExit(statement.thenStatement, options), statement.elseStatement ? statementExit(statement.elseStatement, options) : NORMAL);
  }
  if (ts.isSwitchStatement(statement)) return switchExit(statement, options);
  if (ts.isTryStatement(statement)) return tryExit(statement, options);
  if (ts.isLabeledStatement(statement)) return labeledExit(statement, options);
  if (ts.isIterationStatement(statement, false)) return loopExit(statement, options);
  if (ts.isWithStatement(statement)) return statementExit(statement.statement, options);
  if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && options.isNeverCall?.(statement.expression)) return new Set(["throw"]);
  return new Set(NORMAL);
}

export function functionMayFallThrough(body: ts.Block, options: ContractControlFlowOptions = {}): boolean {
  const exits = statementExit(body, options);
  return exits.has("normal") || [...exits].some((item) => item.startsWith("break:") || item.startsWith("continue:"));
}

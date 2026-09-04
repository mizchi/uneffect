import ts from "@typescript/typescript6";
import {
  breakTransferTarget,
  catchCompletions,
  completionSet,
  consumeLoopCompletions,
  continueTransferTarget,
  finallyCompletions,
  sequenceCompletions,
  type CompletionSet,
  type TargetedCompletion,
} from "./completion-flow.js";

export type ContractExit = "normal" | "return" | "throw" | `break:${string}` | `continue:${string}`;
export interface ContractControlFlowOptions {
  readonly isNeverCall?: (call: ts.CallExpression) => boolean;
  readonly constantBoolean?: (expression: ts.Expression) => boolean | undefined;
}

const NORMAL = completionSet({ completion: "normal" });

function union(...sets: readonly CompletionSet[]): CompletionSet {
  return completionSet(...sets.flat());
}

function statementsCompletion(statements: readonly ts.Statement[], options: ContractControlFlowOptions): CompletionSet {
  let completions = NORMAL;
  for (const statement of statements) {
    completions = sequenceCompletions(completions, () => statementCompletion(statement, options));
  }
  return completions;
}

function consumeSwitchBreaks(completions: CompletionSet): CompletionSet {
  const retained = completions.filter((value) => !(value.completion === "break" && value.target?.kind === "nearest-breakable"));
  return retained.length === completions.length ? completionSet(...retained) : union(retained, NORMAL);
}

function switchCompletion(statement: ts.SwitchStatement, options: ContractControlFlowOptions): CompletionSet {
  const clauses = statement.caseBlock.clauses;
  let completions: CompletionSet = completionSet();
  for (let entry = 0; entry < clauses.length; entry += 1) {
    let path = NORMAL;
    for (let index = entry; index < clauses.length; index += 1) {
      path = sequenceCompletions(path, () => statementsCompletion(clauses[index]!.statements, options));
    }
    completions = union(completions, path);
  }
  if (!clauses.some(ts.isDefaultClause)) completions = union(completions, NORMAL);
  return consumeSwitchBreaks(completions);
}

function tryCompletion(statement: ts.TryStatement, options: ContractControlFlowOptions): CompletionSet {
  let completions = statementCompletion(statement.tryBlock, options);
  if (statement.catchClause) {
    // Expressions and host operations may throw even when this structural IR
    // has no explicit throw node, so the catch path remains conservatively live.
    completions = catchCompletions(
      union(completions, completionSet({ completion: "throw" })),
      () => statementCompletion(statement.catchClause!.block, options),
    );
  }
  return statement.finallyBlock
    ? finallyCompletions(completions, statementCompletion(statement.finallyBlock, options))
    : completions;
}

function loopCompletion(statement: ts.IterationStatement, options: ContractControlFlowOptions, label?: string): CompletionSet {
  const body = statementCompletion(statement.statement, options);
  let completions = consumeLoopCompletions(body, label);
  const always = (ts.isWhileStatement(statement) || ts.isDoStatement(statement))
    ? statement.expression.kind === ts.SyntaxKind.TrueKeyword || options.constantBoolean?.(statement.expression) === true
    : ts.isForStatement(statement) && statement.condition === undefined;
  if (!always) completions = union(completions, NORMAL);
  return completions;
}

function labeledCompletion(statement: ts.LabeledStatement, options: ContractControlFlowOptions): CompletionSet {
  const label = statement.label.text;
  const completions = ts.isIterationStatement(statement.statement, false)
    ? loopCompletion(statement.statement, options, label)
    : statementCompletion(statement.statement, options);
  const retained = completions.filter((value) => !(value.completion === "break" && value.target?.kind === "label" && value.target.label === label));
  return retained.length === completions.length ? completionSet(...retained) : union(retained, NORMAL);
}

function statementCompletion(statement: ts.Statement, options: ContractControlFlowOptions = {}): CompletionSet {
  if (ts.isReturnStatement(statement)) return completionSet({ completion: "return" });
  if (ts.isThrowStatement(statement)) return completionSet({ completion: "throw" });
  if (ts.isBreakStatement(statement)) return completionSet({ completion: "break", target: breakTransferTarget(statement.label?.text) });
  if (ts.isContinueStatement(statement)) return completionSet({ completion: "continue", target: continueTransferTarget(statement.label?.text) });
  if (ts.isBlock(statement)) return statementsCompletion(statement.statements, options);
  if (ts.isIfStatement(statement)) {
    const condition = options.constantBoolean?.(statement.expression);
    if (condition === true) return statementCompletion(statement.thenStatement, options);
    if (condition === false) return statement.elseStatement ? statementCompletion(statement.elseStatement, options) : NORMAL;
    return union(statementCompletion(statement.thenStatement, options), statement.elseStatement ? statementCompletion(statement.elseStatement, options) : NORMAL);
  }
  if (ts.isSwitchStatement(statement)) return switchCompletion(statement, options);
  if (ts.isTryStatement(statement)) return tryCompletion(statement, options);
  if (ts.isLabeledStatement(statement)) return labeledCompletion(statement, options);
  if (ts.isIterationStatement(statement, false)) return loopCompletion(statement, options);
  if (ts.isWithStatement(statement)) return statementCompletion(statement.statement, options);
  if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && options.isNeverCall?.(statement.expression)) {
    return completionSet({ completion: "throw" });
  }
  return NORMAL;
}

function legacyExit(value: TargetedCompletion): ContractExit {
  if (value.completion !== "break" && value.completion !== "continue") return value.completion;
  return `${value.completion}:${value.target?.kind === "label" ? value.target.label : ""}`;
}

export function statementExit(statement: ts.Statement, options: ContractControlFlowOptions = {}): Set<ContractExit> {
  return new Set(statementCompletion(statement, options).map(legacyExit));
}

export function functionMayFallThrough(body: ts.Block, options: ContractControlFlowOptions = {}): boolean {
  const completions = statementCompletion(body, options);
  return completions.some((value) => value.completion === "normal" || value.completion === "break" || value.completion === "continue");
}

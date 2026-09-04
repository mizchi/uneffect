import ts from "@typescript/typescript6";
import {
  breakTransferTarget,
  catchCompletions,
  completionSet,
  consumeLoopCompletions,
  continueTransferTarget,
  finallyCompletions,
  isTransferOwnedByLoop,
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
const THROW = completionSet({ completion: "throw" });

function union(...sets: readonly CompletionSet[]): CompletionSet {
  return completionSet(...sets.flat());
}

function expressionNeverCompletes(expression: ts.Expression, options: ContractControlFlowOptions): boolean {
  if (ts.isCallExpression(expression)) {
    if (options.isNeverCall?.(expression)) return true;
    if (expressionNeverCompletes(expression.expression, options)) return true;
    return !ts.isOptionalChain(expression)
      && expression.arguments.some((argument) => expressionNeverCompletes(argument, options));
  }
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isAwaitExpression(expression)
    || ts.isVoidExpression(expression)
    || ts.isTypeOfExpression(expression)
    || ts.isDeleteExpression(expression)) {
    return expressionNeverCompletes(expression.expression, options);
  }
  if (ts.isPrefixUnaryExpression(expression) || ts.isPostfixUnaryExpression(expression)) {
    return expressionNeverCompletes(expression.operand, options);
  }
  if (ts.isBinaryExpression(expression)) {
    if (expressionNeverCompletes(expression.left, options)) return true;
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return conditionBoolean(expression.left, options) === true
        && expressionNeverCompletes(expression.right, options);
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      return conditionBoolean(expression.left, options) === false
        && expressionNeverCompletes(expression.right, options);
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return false;
    return expressionNeverCompletes(expression.right, options);
  }
  if (ts.isPropertyAccessExpression(expression)) return expressionNeverCompletes(expression.expression, options);
  if (ts.isElementAccessExpression(expression)) {
    return expressionNeverCompletes(expression.expression, options)
      || !ts.isOptionalChain(expression) && expression.argumentExpression !== undefined
        && expressionNeverCompletes(expression.argumentExpression, options);
  }
  if (ts.isNewExpression(expression)) {
    return expressionNeverCompletes(expression.expression, options)
      || expression.arguments?.some((argument) => expressionNeverCompletes(argument, options)) === true;
  }
  if (ts.isTaggedTemplateExpression(expression)) {
    return expressionNeverCompletes(expression.tag, options)
      || ts.isTemplateExpression(expression.template)
        && expression.template.templateSpans.some((span) => expressionNeverCompletes(span.expression, options));
  }
  return false;
}

function variableStatementNeverCompletes(statement: ts.VariableStatement, options: ContractControlFlowOptions): boolean {
  return statement.declarationList.declarations.some((declaration) => declaration.initializer !== undefined
    && expressionNeverCompletes(declaration.initializer, options));
}

function conditionBoolean(expression: ts.Expression, options: ContractControlFlowOptions): boolean | undefined {
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  const semantic = options.constantBoolean?.(expression);
  if (semantic !== undefined) return semantic;
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)) {
    return conditionBoolean(expression.expression, options);
  }
  if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
    const operand = conditionBoolean(expression.operand, options);
    return operand === undefined ? undefined : !operand;
  }
  if (!ts.isBinaryExpression(expression)) return undefined;
  const left = conditionBoolean(expression.left, options);
  if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return left === false ? false : left === true ? conditionBoolean(expression.right, options) : undefined;
  }
  if (expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    return left === true ? true : left === false ? conditionBoolean(expression.right, options) : undefined;
  }
  const right = conditionBoolean(expression.right, options);
  if (left === undefined || right === undefined) return undefined;
  if (expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
    || expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
  if (expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
    || expression.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
  return undefined;
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
  const condition = ts.isWhileStatement(statement) || ts.isDoStatement(statement)
    ? statement.expression
    : ts.isForStatement(statement) ? statement.condition : undefined;
  const always = ts.isForStatement(statement) && condition === undefined
    || condition !== undefined && conditionBoolean(condition, options) === true;
  const body = statementCompletion(statement.statement, options);
  const reachesCondition = body.some((completion) => completion.completion === "normal"
    || completion.completion === "continue" && isTransferOwnedByLoop(completion, label));
  const exits = always ? body.filter((completion) => completion.completion !== "normal") : body;
  let completions = consumeLoopCompletions(completionSet(...exits), label);
  if (!always && (!ts.isDoStatement(statement) || reachesCondition)) completions = union(completions, NORMAL);
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
  if (ts.isReturnStatement(statement)) return statement.expression && expressionNeverCompletes(statement.expression, options)
    ? THROW
    : completionSet({ completion: "return" });
  if (ts.isThrowStatement(statement)) return THROW;
  if (ts.isBreakStatement(statement)) return completionSet({ completion: "break", target: breakTransferTarget(statement.label?.text) });
  if (ts.isContinueStatement(statement)) return completionSet({ completion: "continue", target: continueTransferTarget(statement.label?.text) });
  if (ts.isBlock(statement)) return statementsCompletion(statement.statements, options);
  if (ts.isIfStatement(statement)) {
    if (expressionNeverCompletes(statement.expression, options)) return THROW;
    const condition = conditionBoolean(statement.expression, options);
    if (condition === true) return statementCompletion(statement.thenStatement, options);
    if (condition === false) return statement.elseStatement ? statementCompletion(statement.elseStatement, options) : NORMAL;
    return union(statementCompletion(statement.thenStatement, options), statement.elseStatement ? statementCompletion(statement.elseStatement, options) : NORMAL);
  }
  if (ts.isSwitchStatement(statement)) return expressionNeverCompletes(statement.expression, options)
    ? THROW
    : switchCompletion(statement, options);
  if (ts.isTryStatement(statement)) return tryCompletion(statement, options);
  if (ts.isLabeledStatement(statement)) return labeledCompletion(statement, options);
  if (ts.isIterationStatement(statement, false)) return loopCompletion(statement, options);
  if (ts.isWithStatement(statement)) return expressionNeverCompletes(statement.expression, options)
    ? THROW
    : statementCompletion(statement.statement, options);
  if (ts.isVariableStatement(statement) && variableStatementNeverCompletes(statement, options)) return THROW;
  if (ts.isExpressionStatement(statement) && expressionNeverCompletes(statement.expression, options)) return THROW;
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

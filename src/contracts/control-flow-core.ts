import {
  breakTransferTarget, catchCompletions, completionSet, consumeLoopCompletions,
  continueTransferTarget, finallyCompletions, isTransferOwnedByLoop, sequenceCompletions,
  type CompletionSet, type TargetedCompletion,
} from "../cfg/completion.js";
import type { ContractExit, ControlFlowSemantics, ControlFlowStatement, ControlFlowSyntax } from "./control-flow-contracts.js";

const NORMAL = completionSet({ completion: "normal" });
const THROW = completionSet({ completion: "throw" });
function union(...sets: readonly CompletionSet[]): CompletionSet { return completionSet(...sets.flat()); }

/** Shared completion rules; syntax and semantic facts remain frontend-owned. */
export function createContractControlFlow<S, E>(syntax: ControlFlowSyntax<S, E>, options: ControlFlowSemantics<E> = {}) {
  function conditionBoolean(node: E): boolean | undefined {
    const expression = syntax.expression(node);
    if (expression.kind === "boolean") return expression.value;
    const semantic = options.constantBoolean?.(node);
    if (semantic !== undefined) return semantic;
    if (expression.kind === "wrapped") return conditionBoolean(expression.operand);
    if (expression.kind === "not") {
      const operand = conditionBoolean(expression.operand);
      return operand === undefined ? undefined : !operand;
    }
    if (expression.kind !== "binary") return undefined;
    const left = conditionBoolean(expression.left);
    if (expression.operator === "&&") return left === false ? false : left === true ? conditionBoolean(expression.right) : undefined;
    if (expression.operator === "||") return left === true ? true : left === false ? conditionBoolean(expression.right) : undefined;
    const right = conditionBoolean(expression.right);
    if (left === undefined || right === undefined) return undefined;
    if (expression.operator === "==" || expression.operator === "===") return left === right;
    if (expression.operator === "!=" || expression.operator === "!==") return left !== right;
    return undefined;
  }
  function expressionNeverCompletes(node: E): boolean {
    const expression = syntax.expression(node);
    switch (expression.kind) {
      case "call": return expressionNeverCompletes(expression.callee)
        || !expression.conditional && (options.isNeverCall?.(node) === true || expression.arguments.some(expressionNeverCompletes));
      case "wrapped": case "not": return expressionNeverCompletes(expression.operand);
      case "eager": return expression.operands.some(expressionNeverCompletes);
      case "binary":
        if (expressionNeverCompletes(expression.left)) return true;
        if (expression.operator === "&&" || expression.operator === "&&=") return conditionBoolean(expression.left) === true && expressionNeverCompletes(expression.right);
        if (expression.operator === "||" || expression.operator === "||=") return conditionBoolean(expression.left) === false && expressionNeverCompletes(expression.right);
        if (expression.operator === "??" || expression.operator === "??=") return false;
        return expressionNeverCompletes(expression.right);
      default: return false;
    }
  }
  function statementsCompletion(statements: readonly S[]): CompletionSet {
    let completions = NORMAL;
    for (const statement of statements) completions = sequenceCompletions(completions, () => statementCompletion(statement));
    return completions;
  }
  function consumeBreaks(completions: CompletionSet, label?: string): CompletionSet {
    const retained = completions.filter(value => !(value.completion === "break" && (label === undefined
      ? value.target?.kind === "nearest-breakable" : value.target?.kind === "label" && value.target.label === label)));
    return retained.length === completions.length ? completionSet(...retained) : union(retained, NORMAL);
  }
  function loopCompletion(statement: Extract<ControlFlowStatement<S, E>, { kind: "loop" }>, label?: string): CompletionSet {
    const always = statement.unconditional || statement.condition !== undefined && conditionBoolean(statement.condition) === true;
    const body = statementCompletion(statement.body);
    const reachesCondition = body.some(value => value.completion === "normal"
      || value.completion === "continue" && isTransferOwnedByLoop(value, label));
    const exits = always ? body.filter(value => value.completion !== "normal") : body;
    let completions = consumeLoopCompletions(completionSet(...exits), label);
    if (!always && (!statement.postTest || reachesCondition)) completions = union(completions, NORMAL);
    return completions;
  }
  function statementCompletion(node: S): CompletionSet {
    const statement = syntax.statement(node);
    switch (statement.kind) {
      case "normal": return NORMAL;
      case "throw": return THROW;
      case "return": return statement.expression !== undefined && expressionNeverCompletes(statement.expression)
        ? THROW : completionSet({ completion: "return" });
      case "break": return completionSet({ completion: "break", target: breakTransferTarget(statement.label) });
      case "continue": return completionSet({ completion: "continue", target: continueTransferTarget(statement.label) });
      case "block": return statementsCompletion(statement.statements);
      case "if": {
        if (expressionNeverCompletes(statement.condition)) return THROW;
        const condition = conditionBoolean(statement.condition);
        if (condition === true) return statementCompletion(statement.consequent);
        if (condition === false) return statement.alternate === undefined ? NORMAL : statementCompletion(statement.alternate);
        return union(statementCompletion(statement.consequent), statement.alternate === undefined ? NORMAL : statementCompletion(statement.alternate));
      }
      case "switch": {
        if (expressionNeverCompletes(statement.condition)) return THROW;
        let completions: CompletionSet = completionSet();
        for (let entry = 0; entry < statement.clauses.length; entry++) {
          let path = NORMAL;
          for (let index = entry; index < statement.clauses.length; index++) {
            path = sequenceCompletions(path, () => statementsCompletion(statement.clauses[index]!.statements));
          }
          completions = union(completions, path);
        }
        if (!statement.clauses.some(clause => clause.isDefault)) completions = union(completions, NORMAL);
        return consumeBreaks(completions);
      }
      case "try": {
        let completions = statementCompletion(statement.body);
        // Host operations may throw even without an explicit throw statement.
        if (statement.handler !== undefined) completions = catchCompletions(union(completions, THROW), () => statementCompletion(statement.handler!));
        return statement.finalizer === undefined ? completions : finallyCompletions(completions, statementCompletion(statement.finalizer));
      }
      case "loop": return loopCompletion(statement);
      case "label": {
        const body = syntax.statement(statement.body);
        return consumeBreaks(body.kind === "loop" ? loopCompletion(body, statement.label) : statementCompletion(statement.body), statement.label);
      }
      case "expression": return statement.expressions.some(expressionNeverCompletes) ? THROW
        : statement.body === undefined ? NORMAL : statementCompletion(statement.body);
    }
  }
  return {
    statementExit: (node: S): Set<ContractExit> => new Set(statementCompletion(node).map(formatExit)),
    functionMayFallThrough: (node: S): boolean => statementCompletion(node).some(value =>
      value.completion === "normal" || value.completion === "break" || value.completion === "continue"),
  };
}
function formatExit(value: TargetedCompletion): ContractExit {
  if (value.completion !== "break" && value.completion !== "continue") return value.completion;
  return `${value.completion}:${value.target?.kind === "label" ? value.target.label : ""}`;
}

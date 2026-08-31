import ts from "typescript";
import type { ResourceProtocolModel } from "./resource-protocol.js";

export type AsyncIteratorExit = "exhausted" | "break" | "return" | "throw";

export interface AsyncIteratorCleanupScenario {
  readonly exit: AsyncIteratorExit;
  readonly model: ResourceProtocolModel;
  readonly close?: {
    readonly lookupLane: "inline";
    readonly resultLane: "microtask-if-present";
    readonly method: "return-if-present";
    readonly propertyAccessMayInvokeUserCode: true;
    readonly failure: "reject";
    readonly span: { readonly start: number; readonly end: number };
  };
}

export interface AsyncIteratorCleanup {
  readonly owner: string;
  readonly resource: string;
  readonly iterable: string;
  readonly loopSpan: { readonly start: number; readonly end: number };
  readonly coverage: "reviewed-explicit-completions";
  readonly unknownReasons: readonly "abrupt-through-finally"[];
  readonly scenarios: readonly AsyncIteratorCleanupScenario[];
}

function functionName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
  }
  return "<module>";
}

function breakTargetsLoop(node: ts.BreakStatement, loop: ts.ForOfStatement): boolean {
  if (node.label) {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isLabeledStatement(current) && current.label.text === node.label.text) {
        return current.statement.pos <= loop.pos && loop.end <= current.statement.end;
      }
    }
    return false;
  }
  for (let current: ts.Node | undefined = node.parent; current && current !== loop; current = current.parent) {
    if (ts.isIterationStatement(current, false) || ts.isSwitchStatement(current)) return false;
  }
  return true;
}

function throwEscapesLoop(node: ts.ThrowStatement, loop: ts.ForOfStatement): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== loop; current = current.parent) {
    if (ts.isTryStatement(current) && current.tryBlock.pos <= node.pos && node.end <= current.tryBlock.end && current.catchClause) return false;
  }
  return true;
}

function crossesFinally(node: ts.Node, loop: ts.ForOfStatement): boolean {
  for (let current: ts.Node | undefined = node.parent; current && current !== loop; current = current.parent) {
    if (ts.isTryStatement(current) && current.finallyBlock
      && !(current.finallyBlock.pos <= node.pos && node.end <= current.finallyBlock.end)) return true;
  }
  return false;
}

function scenario(resource: string, loop: ts.ForOfStatement, exit: AsyncIteratorExit, at: number): AsyncIteratorCleanupScenario {
  const abrupt = exit !== "exhausted";
  return {
    exit,
    model: {
      schema: "uneffect-resource-protocol/v1",
      resources: [{ id: resource, label: loop.expression.getText(), kind: "AsyncIterator", initialState: "available", requiredTerminalStates: ["consumed", "released"] }],
      transitions: [{ kind: abrupt ? "release" : "consume", resource, at, evidence: "exact" }],
    },
    ...(abrupt ? { close: { lookupLane: "inline" as const, resultLane: "microtask-if-present" as const,
      method: "return-if-present" as const, propertyAccessMayInvokeUserCode: true as const, failure: "reject" as const,
      span: { start: at, end: at + (exit === "break" ? 5 : exit === "return" ? 6 : 5) } } } : {}),
  };
}

/** Extracts the reviewed `for await...of` IteratorClose fragment. */
export function analyzeAsyncIteratorCleanup(source: ts.SourceFile): readonly AsyncIteratorCleanup[] {
  const cleanups: AsyncIteratorCleanup[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isForOfStatement(node) && node.awaitModifier) {
      const resource = `async-iterator:${source.fileName}:${node.getStart(source)}`;
      const exits = new Map<AsyncIteratorExit, number>([["exhausted", node.getEnd()]]);
      const unknownReasons = new Set<"abrupt-through-finally">();
      const scan = (child: ts.Node): void => {
        if (child !== node.statement && ts.isFunctionLike(child)) return;
        const exit = ts.isBreakStatement(child) && breakTargetsLoop(child, node) ? "break"
          : ts.isReturnStatement(child) ? "return"
          : ts.isThrowStatement(child) && throwEscapesLoop(child, node) ? "throw" : undefined;
        if (exit && crossesFinally(child, node)) unknownReasons.add("abrupt-through-finally");
        else if (exit) exits.set(exit, child.getStart(source));
        ts.forEachChild(child, scan);
      };
      scan(node.statement);
      cleanups.push({
        owner: functionName(node), resource, iterable: node.expression.getText(source),
        loopSpan: { start: node.getStart(source), end: node.getEnd() },
        coverage: "reviewed-explicit-completions",
        unknownReasons: [...unknownReasons],
        scenarios: [...exits].map(([exit, at]) => scenario(resource, node, exit, at)),
      });
      ts.forEachChild(node.statement, visit);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return cleanups;
}

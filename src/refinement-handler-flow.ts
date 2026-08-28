import ts from "typescript";
import { solveBasicBlockFixedPoint } from "./refinement-flow.js";

export type HandlerCompletionKind = "normal" | "return" | "throw" | "break" | "continue";

type ControlRoot = ts.IfStatement | ts.SwitchStatement;

interface LoweredEdge {
  readonly to: string;
  readonly completion?: HandlerCompletionKind;
}

interface LoweredBlock {
  readonly id: string;
  readonly edges: readonly LoweredEdge[];
}

export interface HandlerJoinCandidate {
  readonly tryStatement: ts.TryStatement;
  readonly controlStatement: ControlRoot;
  readonly controlShape: "if" | "switch";
  readonly mandatoryFinally: boolean;
  readonly lowering: "supported" | "unsupported";
  readonly blocks: readonly LoweredBlock[];
}

export interface HandlerJoinFixedPoint {
  readonly iterations: number;
  readonly converged: boolean;
  readonly blockCompletions: Readonly<Record<string, readonly HandlerCompletionKind[]>>;
  readonly incoming: readonly HandlerCompletionKind[];
  readonly outgoing: readonly HandlerCompletionKind[];
}

const orderedCompletions = (values: Iterable<HandlerCompletionKind>): HandlerCompletionKind[] => {
  const order: readonly HandlerCompletionKind[] = ["normal", "return", "throw", "break", "continue"];
  const selected = new Set(values);
  return order.filter((kind) => selected.has(kind));
};

const blockId = (kind: string, node: ts.Node): string => `${kind}:${node.getStart()}`;

class HandlerCfgBuilder {
  readonly blocks: LoweredBlock[] = [];

  add(id: string, edges: readonly LoweredEdge[]): string {
    if (this.blocks.some((block) => block.id === id)) throw new Error(`duplicate handler CFG block ${id}`);
    this.blocks.push({ id, edges });
    return id;
  }

  lowerStatements(
    statements: readonly ts.Statement[],
    next: string,
    completionTarget: string,
    breakTarget?: string,
  ): string | undefined {
    let entry = next;
    for (let index = statements.length - 1; index >= 0; index--) {
      const lowered = this.lowerStatement(statements[index]!, entry, completionTarget, breakTarget);
      if (!lowered) return undefined;
      entry = lowered;
    }
    return entry;
  }

  lowerStatement(
    statement: ts.Statement,
    next: string,
    completionTarget: string,
    breakTarget?: string,
  ): string | undefined {
    if (ts.isBlock(statement)) {
      return this.lowerStatements(statement.statements, next, completionTarget, breakTarget);
    }
    if (ts.isReturnStatement(statement)) {
      return this.add(blockId("return", statement), [{ to: completionTarget, completion: "return" }]);
    }
    if (ts.isThrowStatement(statement)) {
      return this.add(blockId("throw", statement), [{ to: completionTarget, completion: "throw" }]);
    }
    if (ts.isBreakStatement(statement)) {
      if (statement.label || !breakTarget) return undefined;
      return this.add(blockId("break", statement), [{ to: breakTarget, completion: "normal" }]);
    }
    if (ts.isContinueStatement(statement) || ts.isTryStatement(statement)
      || ts.isIterationStatement(statement, false) || ts.isLabeledStatement(statement)) return undefined;
    if (ts.isIfStatement(statement)) {
      const thenEntry = this.lowerStatement(statement.thenStatement, next, completionTarget, breakTarget);
      if (!thenEntry) return undefined;
      const elseEntry = statement.elseStatement
        ? this.lowerStatement(statement.elseStatement, next, completionTarget, breakTarget)
        : next;
      if (!elseEntry) return undefined;
      return this.add(blockId("if", statement), [{ to: thenEntry }, { to: elseEntry }]);
    }
    if (ts.isSwitchStatement(statement)) {
      const clauses = [...statement.caseBlock.clauses];
      if (clauses.length === 0 || clauses.filter(ts.isDefaultClause).length !== 1) return undefined;
      const switchExit = this.add(blockId("switch-normal", statement), [
        { to: completionTarget, completion: "normal" },
      ]);
      let fallthrough = switchExit;
      const entries: string[] = [];
      for (let index = clauses.length - 1; index >= 0; index--) {
        const clause = clauses[index]!;
        const entry = this.lowerStatements(clause.statements, fallthrough, completionTarget, switchExit);
        if (!entry) return undefined;
        const clauseEntry = this.add(blockId("case", clause), [{ to: entry }]);
        entries.unshift(clauseEntry);
        fallthrough = clauseEntry;
      }
      return this.add(blockId("switch", statement), entries.map((to) => ({ to })));
    }
    if (ts.isExpressionStatement(statement) || ts.isVariableStatement(statement)
      || ts.isEmptyStatement(statement) || ts.isDebuggerStatement(statement)) {
      return this.add(blockId("statement", statement), [{ to: next }]);
    }
    return undefined;
  }
}

function isNormalOnly(statement: ts.Statement): boolean {
  if (ts.isBlock(statement)) return statement.statements.every(isNormalOnly);
  if (ts.isIfStatement(statement)) {
    return isNormalOnly(statement.thenStatement)
      && (!statement.elseStatement || isNormalOnly(statement.elseStatement));
  }
  return ts.isExpressionStatement(statement) || ts.isVariableStatement(statement)
    || ts.isEmptyStatement(statement) || ts.isDebuggerStatement(statement);
}

/**
 * Lowers the currently supported handler family to reusable basic blocks.
 * Unsupported control is omitted rather than approximated as normal flow.
 */
export function findHandlerJoinCandidates(body: ts.Block): HandlerJoinCandidate[] {
  const candidates: HandlerJoinCandidate[] = [];
  for (const statement of body.statements) {
    if (!ts.isTryStatement(statement) || !statement.catchClause) continue;
    const controlStatement = statement.tryBlock.statements[0];
    if (statement.tryBlock.statements.length !== 1 || !controlStatement
      || (!ts.isIfStatement(controlStatement) && !ts.isSwitchStatement(controlStatement))) continue;
    const normalFinally = !statement.finallyBlock || statement.finallyBlock.statements.every(isNormalOnly);

    const builder = new HandlerCfgBuilder();
    builder.add("try-completion", []);
    builder.add("catch-completion", []);
    builder.add("handler-join", []);
    builder.add("exit", []);

    const tryEntry = builder.lowerStatements(
      statement.tryBlock.statements, "try-completion", "try-completion",
    );
    const catchBodyEntry = builder.lowerStatements(
      statement.catchClause.block.statements, "catch-completion", "catch-completion",
    );
    if (!tryEntry || !catchBodyEntry || !normalFinally) {
      candidates.push({
        tryStatement: statement,
        controlStatement,
        controlShape: ts.isSwitchStatement(controlStatement) ? "switch" : "if",
        mandatoryFinally: Boolean(statement.finallyBlock),
        lowering: "unsupported",
        blocks: [],
      });
      continue;
    }
    const catchEntry = builder.add("catch", [{ to: catchBodyEntry, completion: "normal" }]);

    let joinDestination = "exit";
    if (statement.finallyBlock) {
      const finallyEntry = builder.lowerStatements(statement.finallyBlock.statements, "exit", "exit");
      if (!finallyEntry) continue;
      builder.add("finally", [{ to: finallyEntry }]);
      joinDestination = "finally";
    }
    builder.add("entry", [{ to: tryEntry, completion: "normal" }]);

    const blocks = builder.blocks.map((block) => {
      if (block.id === "try-completion") return { ...block, edges: [
        { to: catchEntry, completion: "throw" as const },
        { to: "handler-join" },
      ] };
      if (block.id === "catch-completion") return { ...block, edges: [{ to: "handler-join" }] };
      if (block.id === "handler-join") return { ...block, edges: [{ to: joinDestination }] };
      return block;
    });
    candidates.push({
      tryStatement: statement,
      controlStatement,
      controlShape: ts.isSwitchStatement(controlStatement) ? "switch" : "if",
      mandatoryFinally: Boolean(statement.finallyBlock),
      lowering: "supported",
      blocks,
    });
  }
  return candidates;
}

export function runHandlerJoinFixedPoint(
  candidate: HandlerJoinCandidate,
  limit: number,
): HandlerJoinFixedPoint {
  type Value = ReadonlySet<HandlerCompletionKind>;
  const value = (...kinds: HandlerCompletionKind[]): Value => new Set(kinds);
  const key = (input: Value): string => orderedCompletions(input).join("|");
  if (candidate.lowering === "unsupported") {
    return { iterations: 0, converged: false, blockCompletions: {}, incoming: [], outgoing: [] };
  }
  const result = solveBasicBlockFixedPoint<Value>({
    entry: "entry",
    initial: value("normal"),
    budget: { name: "cfg-fixed-point-iterations", limit },
    lattice: {
      bottom: () => value(),
      equivalent: (left, right) => key(left) === key(right),
      join: (left, right) => ({ status: "joined", value: new Set([...left, ...right]) }),
    },
    blocks: candidate.blocks.map((block) => ({
      id: block.id,
      transfer: (input: Value) => {
        if (block.id === "try-completion") {
          const edges: Array<{ to: string; value: Value }> = [];
          if (input.has("throw")) edges.push({ to: "catch", value: value("throw") });
          const uncaught = orderedCompletions(input).filter((kind) => kind !== "throw");
          if (uncaught.length > 0) edges.push({ to: "handler-join", value: value(...uncaught) });
          return edges;
        }
        return block.edges.map((edge) => ({
          to: edge.to,
          value: edge.completion ? value(edge.completion) : input,
        }));
      },
    })),
  });
  const state = (id: string) => result.states.get(id) ?? value();
  return {
    iterations: result.iterations,
    converged: result.status === "converged",
    blockCompletions: Object.fromEntries([...result.states]
      .map(([id, blockState]) => [id, orderedCompletions(blockState)])),
    incoming: orderedCompletions(state("try-completion")),
    outgoing: orderedCompletions(state("exit")),
  };
}

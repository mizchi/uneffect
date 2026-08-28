import ts from "typescript";
import { solveBasicBlockFixedPoint } from "./refinement-flow.js";

export type HandlerCompletionKind = "normal" | "return" | "throw" | "break" | "continue";

export interface DirectHandlerJoinCandidate {
  readonly tryStatement: ts.TryStatement;
  readonly switchStatement: ts.SwitchStatement;
  readonly incoming: readonly HandlerCompletionKind[];
  readonly catchCompletions: readonly HandlerCompletionKind[];
}

export interface DirectHandlerJoinFixedPoint {
  readonly iterations: number;
  readonly converged: boolean;
  readonly blockCompletions: Readonly<Record<string, readonly HandlerCompletionKind[]>>;
  readonly outgoing: readonly HandlerCompletionKind[];
}

const orderedCompletions = (values: Iterable<HandlerCompletionKind>): HandlerCompletionKind[] => {
  const order: readonly HandlerCompletionKind[] = ["normal", "return", "throw", "break", "continue"];
  const selected = new Set(values);
  return order.filter((kind) => selected.has(kind));
};

function directBlockCompletions(block: ts.Block): HandlerCompletionKind[] | undefined {
  for (const statement of block.statements) {
    if (ts.isReturnStatement(statement)) return ["return"];
    if (ts.isThrowStatement(statement)) return ["throw"];
    if (ts.isBreakStatement(statement)) return statement.label ? undefined : ["break"];
    if (ts.isContinueStatement(statement)) return statement.label ? undefined : ["continue"];
    if (ts.isIfStatement(statement) || ts.isSwitchStatement(statement) || ts.isTryStatement(statement)
      || ts.isIterationStatement(statement, false) || ts.isLabeledStatement(statement)) return undefined;
  }
  return ["normal"];
}

function directSwitchCompletions(statement: ts.SwitchStatement): HandlerCompletionKind[] | undefined {
  const clauses = [...statement.caseBlock.clauses];
  if (clauses.length === 0 || clauses.filter(ts.isDefaultClause).length !== 1) return undefined;
  const completions = new Set<HandlerCompletionKind>();
  for (let entry = 0; entry < clauses.length; entry++) {
    let completed = false;
    for (let index = entry; index < clauses.length && !completed; index++) {
      for (const child of clauses[index]!.statements) {
        if (ts.isReturnStatement(child)) { completions.add("return"); completed = true; break; }
        if (ts.isThrowStatement(child)) { completions.add("throw"); completed = true; break; }
        if (ts.isBreakStatement(child)) {
          if (child.label) return undefined;
          completions.add("normal"); completed = true; break;
        }
        if (ts.isContinueStatement(child) || ts.isIfStatement(child) || ts.isSwitchStatement(child)
          || ts.isTryStatement(child) || ts.isIterationStatement(child, false)
          || ts.isLabeledStatement(child)) return undefined;
      }
    }
    if (!completed) completions.add("normal");
  }
  return orderedCompletions(completions);
}

export function findDirectHandlerJoinCandidates(body: ts.Block): DirectHandlerJoinCandidate[] {
  const candidates: DirectHandlerJoinCandidate[] = [];
  for (const statement of body.statements) {
    if (!ts.isTryStatement(statement) || !statement.catchClause || !statement.finallyBlock
      || statement.tryBlock.statements.length !== 1
      || !ts.isSwitchStatement(statement.tryBlock.statements[0]!)) continue;
    const switchStatement = statement.tryBlock.statements[0];
    const incoming = directSwitchCompletions(switchStatement);
    const catchCompletions = directBlockCompletions(statement.catchClause.block);
    const finallyCompletions = directBlockCompletions(statement.finallyBlock);
    if (!incoming || !catchCompletions || finallyCompletions?.length !== 1
      || finallyCompletions[0] !== "normal") continue;
    candidates.push({ tryStatement: statement, switchStatement, incoming, catchCompletions });
  }
  return candidates;
}

export function runDirectHandlerJoinFixedPoint(
  candidate: DirectHandlerJoinCandidate,
  limit: number,
): DirectHandlerJoinFixedPoint {
  type Value = ReadonlySet<HandlerCompletionKind>;
  const value = (...kinds: HandlerCompletionKind[]): Value => new Set(kinds);
  const key = (input: Value): string => orderedCompletions(input).join("|");
  const result = solveBasicBlockFixedPoint<Value>({
    entry: "entry",
    initial: value("normal"),
    budget: { name: "cfg-fixed-point-iterations", limit },
    lattice: {
      bottom: () => value(),
      equivalent: (left, right) => key(left) === key(right),
      join: (left, right) => ({ status: "joined", value: new Set([...left, ...right]) }),
    },
    blocks: [
      { id: "entry", transfer: () => [{ to: "try", value: value("normal") }] },
      { id: "try", transfer: () => [
        ...candidate.incoming.includes("throw") ? [{ to: "catch", value: value("throw") }] : [],
        ...candidate.incoming.some((kind) => kind !== "throw")
          ? [{ to: "handler-join", value: value(...candidate.incoming.filter((kind) => kind !== "throw")) }] : [],
      ] },
      { id: "catch", transfer: () => [{ to: "handler-join", value: value(...candidate.catchCompletions) }] },
      { id: "handler-join", transfer: (input) => [{ to: "finally", value: input }] },
      { id: "finally", transfer: (input) => [{ to: "exit", value: input }] },
      { id: "exit", transfer: () => [] },
    ],
  });
  return {
    iterations: result.iterations,
    converged: result.status === "converged",
    blockCompletions: Object.fromEntries([...result.states]
      .map(([id, state]) => [id, orderedCompletions(state)])),
    outgoing: orderedCompletions(result.states.get("exit") ?? value()),
  };
}

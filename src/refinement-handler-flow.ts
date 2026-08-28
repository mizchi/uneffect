import ts from "typescript";
import { solveBasicBlockFixedPoint } from "./refinement-flow.js";

export type HandlerCompletionKind = "normal" | "return" | "throw" | "break" | "continue";

type ControlRoot = ts.IfStatement | ts.SwitchStatement | ts.ForOfStatement;

const controlShape = (statement: ControlRoot): "if" | "switch" | "for-of" =>
  ts.isIfStatement(statement) ? "if" : ts.isSwitchStatement(statement) ? "switch" : "for-of";

const literalForOfIterations = (statement: ts.ForOfStatement): number | undefined => {
  if (statement.awaitModifier) return undefined;
  const declaration = ts.isVariableDeclarationList(statement.initializer)
    && (statement.initializer.flags & ts.NodeFlags.Const) !== 0
    && statement.initializer.declarations.length === 1
    ? statement.initializer.declarations[0] : undefined;
  if (!declaration || !ts.isIdentifier(declaration.name) || declaration.initializer) return undefined;
  const iterable = ts.isAsExpression(statement.expression) ? statement.expression.expression : statement.expression;
  if (!ts.isArrayLiteralExpression(iterable)
    || !iterable.elements.every((element) => !ts.isSpreadElement(element)
      && (ts.isNumericLiteral(element)
        || element.kind === ts.SyntaxKind.TrueKeyword
        || element.kind === ts.SyntaxKind.FalseKeyword))) return undefined;
  return iterable.elements.length;
};

const finiteForOfIterations = (statement: ts.ForOfStatement): number | undefined => {
  const iterations = literalForOfIterations(statement);
  return iterations !== undefined && iterations >= 1 && iterations <= 4 ? iterations : undefined;
};

export interface LoweredHandlerEdge {
  readonly to: string;
  readonly completion?: HandlerCompletionKind;
}

export interface LoweredHandlerBlock {
  readonly id: string;
  readonly edges: readonly LoweredHandlerEdge[];
}

export interface HandlerJoinCandidate {
  readonly tryStatement: ts.TryStatement;
  readonly controlStatement: ControlRoot;
  readonly controlStatements: readonly ControlRoot[];
  readonly controlShape: "if" | "switch" | "for-of";
  readonly controlRegion: "try" | "finally";
  readonly mandatoryFinally: boolean;
  readonly catchesThrow: boolean;
  readonly finallyOverrides: readonly Extract<HandlerCompletionKind, "return" | "throw">[];
  readonly lowering: "supported" | "unsupported";
  readonly blocks: readonly LoweredHandlerBlock[];
  readonly finiteLoop?: {
    readonly kind: "for-of";
    readonly iterations: number;
  };
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

const blockId = (kind: string, node: ts.Node, context?: string): string =>
  `${kind}:${node.getStart()}${context ? `@${context}` : ""}`;

class HandlerCfgBuilder {
  readonly blocks: LoweredHandlerBlock[] = [];

  add(id: string, edges: readonly LoweredHandlerEdge[]): string {
    if (this.blocks.some((block) => block.id === id)) throw new Error(`duplicate handler CFG block ${id}`);
    this.blocks.push({ id, edges });
    return id;
  }

  lowerStatements(
    statements: readonly ts.Statement[],
    next: string,
    completionTarget: string,
    breakTarget?: string,
    context?: string,
  ): string | undefined {
    let entry = next;
    for (let index = statements.length - 1; index >= 0; index--) {
      const lowered = this.lowerStatement(statements[index]!, entry, completionTarget, breakTarget, context);
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
    context?: string,
  ): string | undefined {
    if (ts.isBlock(statement)) {
      return this.lowerStatements(statement.statements, next, completionTarget, breakTarget, context);
    }
    if (ts.isReturnStatement(statement)) {
      return this.add(blockId("return", statement, context), [{ to: completionTarget, completion: "return" }]);
    }
    if (ts.isThrowStatement(statement)) {
      return this.add(blockId("throw", statement, context), [{ to: completionTarget, completion: "throw" }]);
    }
    if (ts.isBreakStatement(statement)) {
      if (statement.label || !breakTarget) return undefined;
      return this.add(blockId("break", statement, context), [{ to: breakTarget, completion: "normal" }]);
    }
    if (ts.isForOfStatement(statement)) {
      const iterations = finiteForOfIterations(statement);
      if (!iterations) return undefined;
      let entry = next;
      for (let index = iterations - 1; index >= 0; index--) {
        const iterationEntry = this.lowerStatement(
          statement.statement, entry, completionTarget, undefined,
          `${blockId("for-of", statement)}:${index}`,
        );
        if (!iterationEntry) return undefined;
        entry = iterationEntry;
      }
      return this.add(blockId("for-of", statement, context), [{ to: entry }]);
    }
    if (ts.isContinueStatement(statement) || ts.isTryStatement(statement)
      || ts.isIterationStatement(statement, false) || ts.isLabeledStatement(statement)) return undefined;
    if (ts.isIfStatement(statement)) {
      const thenEntry = this.lowerStatement(statement.thenStatement, next, completionTarget, breakTarget, context);
      if (!thenEntry) return undefined;
      const elseEntry = statement.elseStatement
        ? this.lowerStatement(statement.elseStatement, next, completionTarget, breakTarget, context)
        : next;
      if (!elseEntry) return undefined;
      return this.add(blockId("if", statement, context), [{ to: thenEntry }, { to: elseEntry }]);
    }
    if (ts.isSwitchStatement(statement)) {
      const clauses = [...statement.caseBlock.clauses];
      if (clauses.length === 0 || clauses.filter(ts.isDefaultClause).length !== 1) return undefined;
      const switchExit = this.add(blockId("switch-normal", statement, context), [
        { to: completionTarget, completion: "normal" },
      ]);
      let fallthrough = switchExit;
      const entries: string[] = [];
      for (let index = clauses.length - 1; index >= 0; index--) {
        const clause = clauses[index]!;
        const entry = this.lowerStatements(clause.statements, fallthrough, completionTarget, switchExit, context);
        if (!entry) return undefined;
        const clauseEntry = this.add(blockId("case", clause, context), [{ to: entry }]);
        entries.unshift(clauseEntry);
        fallthrough = clauseEntry;
      }
      return this.add(blockId("switch", statement, context), entries.map((to) => ({ to })));
    }
    if (ts.isVariableStatement(statement)
      && (statement.declarationList.flags & (ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !== 0) return undefined;
    if (ts.isExpressionStatement(statement) || ts.isVariableStatement(statement)
      || ts.isEmptyStatement(statement) || ts.isDebuggerStatement(statement)) {
      return this.add(blockId("statement", statement, context), [{ to: next }]);
    }
    return undefined;
  }
}

function abruptFinallyKinds(block: ts.Block | undefined): Array<"return" | "throw"> {
  const kinds = new Set<"return" | "throw">();
  const visit = (statement: ts.Statement): void => {
    if (ts.isReturnStatement(statement)) kinds.add("return");
    else if (ts.isThrowStatement(statement)) kinds.add("throw");
    else if (ts.isBlock(statement)) statement.statements.forEach(visit);
    else if (ts.isIfStatement(statement)) {
      visit(statement.thenStatement);
      if (statement.elseStatement) visit(statement.elseStatement);
    }
  };
  block?.statements.forEach(visit);
  return ["return", "throw"].filter((kind): kind is "return" | "throw" => kinds.has(kind as "return" | "throw"));
}

/**
 * Lowers the currently supported handler family to reusable basic blocks.
 * Unsupported control is omitted rather than approximated as normal flow.
 */
export function findHandlerJoinCandidates(body: ts.Block): HandlerJoinCandidate[] {
  const candidates: HandlerJoinCandidate[] = [];
  const containedIterations = (root: ts.Node): ts.IterationStatement[] => {
    const iterations: ts.IterationStatement[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isIterationStatement(node, false)) iterations.push(node);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
    return iterations;
  };
  for (const statement of body.statements) {
    if (!ts.isTryStatement(statement) || (!statement.catchClause && !statement.finallyBlock)) continue;
    const tryControlStatements = statement.tryBlock.statements.filter(
      (child): child is ControlRoot => ts.isIfStatement(child) || ts.isSwitchStatement(child) || ts.isForOfStatement(child),
    );
    const finallyControlStatements = statement.finallyBlock?.statements.filter(
      (child): child is ControlRoot => ts.isIfStatement(child) || ts.isSwitchStatement(child) || ts.isForOfStatement(child),
    ) ?? [];
    const controlRegion = tryControlStatements.length > 0 ? "try" as const : "finally" as const;
    const selectedControls = controlRegion === "try" ? tryControlStatements : finallyControlStatements;
    const controlStatement = selectedControls[0];
    if (!controlStatement) continue;
    const iterations = [
      ...containedIterations(statement.tryBlock),
      ...(statement.catchClause ? containedIterations(statement.catchClause.block) : []),
      ...(statement.finallyBlock ? containedIterations(statement.finallyBlock) : []),
    ];
    const selectedLoopSupported = iterations.length === 0
      || (controlRegion === "try" && ts.isForOfStatement(controlStatement)
        && iterations.length === 1 && iterations[0] === controlStatement);
    const selectedRootCountSupported = selectedLoopSupported && (selectedControls.length === 1
      || (selectedControls.length === 2 && selectedControls.every(ts.isIfStatement)));

    const builder = new HandlerCfgBuilder();
    builder.add("try-completion", []);
    builder.add("catch-completion", []);
    builder.add("handler-join", []);
    builder.add("exit", []);

    const tryEntry = builder.lowerStatements(
      statement.tryBlock.statements, "try-completion", "try-completion",
    );
    const catchBodyEntry = statement.catchClause ? builder.lowerStatements(
      statement.catchClause.block.statements, "catch-completion", "catch-completion",
    ) : undefined;
    const finallyOverrides = abruptFinallyKinds(statement.finallyBlock);
    if (!tryEntry || (statement.catchClause && !catchBodyEntry) || !selectedRootCountSupported) {
      candidates.push({
        tryStatement: statement,
        controlStatement,
        controlStatements: selectedControls,
        controlShape: controlShape(controlStatement),
        controlRegion,
        mandatoryFinally: Boolean(statement.finallyBlock),
        catchesThrow: Boolean(statement.catchClause),
        finallyOverrides,
        lowering: "unsupported",
        blocks: [],
        ...(ts.isForOfStatement(controlStatement) && literalForOfIterations(controlStatement) !== undefined
          ? { finiteLoop: { kind: "for-of" as const, iterations: literalForOfIterations(controlStatement)! } }
          : {}),
      });
      continue;
    }
    const catchEntry = catchBodyEntry
      ? builder.add("catch", [{ to: catchBodyEntry, completion: "normal" }])
      : undefined;

    let joinDestination = "exit";
    if (statement.finallyBlock) {
      const finallyEntry = builder.lowerStatements(statement.finallyBlock.statements, "exit", "exit");
      if (!finallyEntry) {
        candidates.push({
          tryStatement: statement,
          controlStatement,
          controlStatements: selectedControls,
          controlShape: controlShape(controlStatement),
          controlRegion,
          mandatoryFinally: true,
          catchesThrow: Boolean(statement.catchClause),
          finallyOverrides,
          lowering: "unsupported",
          blocks: [],
          ...(ts.isForOfStatement(controlStatement) && literalForOfIterations(controlStatement) !== undefined
            ? { finiteLoop: { kind: "for-of" as const, iterations: literalForOfIterations(controlStatement)! } }
            : {}),
        });
        continue;
      }
      builder.add("finally", [{ to: finallyEntry }]);
      joinDestination = "finally";
    }
    builder.add("entry", [{ to: tryEntry, completion: "normal" }]);

    const blocks = builder.blocks.map((block) => {
      if (block.id === "try-completion") return { ...block, edges: [
        ...(catchEntry ? [{ to: catchEntry, completion: "throw" as const }] : []),
        { to: "handler-join" },
      ] };
      if (block.id === "catch-completion") return { ...block, edges: [{ to: "handler-join" }] };
      if (block.id === "handler-join") return { ...block, edges: [{ to: joinDestination }] };
      return block;
    });
    candidates.push({
      tryStatement: statement,
      controlStatement,
      controlStatements: selectedControls,
      controlShape: controlShape(controlStatement),
      controlRegion,
      mandatoryFinally: Boolean(statement.finallyBlock),
      catchesThrow: Boolean(statement.catchClause),
      finallyOverrides,
      lowering: "supported",
      blocks,
      ...(ts.isForOfStatement(controlStatement) && literalForOfIterations(controlStatement) !== undefined
        ? { finiteLoop: { kind: "for-of" as const, iterations: literalForOfIterations(controlStatement)! } }
        : {}),
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
          if (candidate.catchesThrow && input.has("throw")) edges.push({ to: "catch", value: value("throw") });
          const uncaught = orderedCompletions(input)
            .filter((kind) => kind !== "throw" || !candidate.catchesThrow);
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

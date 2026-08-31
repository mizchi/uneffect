import ts from "typescript";
import { resourceProtocolCfgSchema, type ResourceProtocolBlock, type ResourceProtocolCfg, type ResourceProtocolModel, type ResourceProtocolTransition } from "./resource-protocol.js";

export interface ResourceTransitionSite {
  readonly node: ts.Node;
  readonly transitions: readonly ResourceProtocolTransition[];
  /** Authenticated synchronous throw, or an awaited rejection converted to throw. */
  readonly exceptionalCompletion?: "throw";
}

export type ResourceProtocolTypeScriptLowering =
  | { readonly status: "exact"; readonly cfg: ResourceProtocolCfg }
  | { readonly status: "unknown"; readonly reason: "outside-function" | "unplaced-transition" | "unsupported-control-flow"; readonly node?: string };

export interface ResourceProtocolTypeScriptLoweringOptions {
  readonly budget?: { readonly name: string; readonly limit: number };
}

function nearestStatement(node: ts.Node, boundary: ts.Node): ts.Statement | undefined {
  for (let current: ts.Node | undefined = node; current && current !== boundary; current = current.parent) {
    if (ts.isStatement(current)) return current;
  }
  return undefined;
}

/**
 * Lowers a deliberately small public-AST control-flow fragment. Operation
 * recognition stays in the caller; this function only places authenticated
 * resource transitions into structured basic blocks.
 */
export function lowerResourceProtocolCfgInFunction(
  source: ts.SourceFile,
  fn: ts.FunctionLikeDeclaration,
  model: ResourceProtocolModel,
  sites: readonly ResourceTransitionSite[],
  options: ResourceProtocolTypeScriptLoweringOptions = {},
): ResourceProtocolTypeScriptLowering {
  if (!fn.body || !ts.isBlock(fn.body)) return { status: "unknown", reason: "outside-function" };
  const body = fn.body;
  const siteStatements = new Map<ResourceTransitionSite, ts.Statement>();
  for (const site of sites) {
    if (site.node.getSourceFile() !== source || site.node.getStart(source) < body.getStart(source) || site.node.getEnd() > body.getEnd()) {
      return { status: "unknown", reason: "outside-function", node: site.node.getText(source) };
    }
    const statement = nearestStatement(site.node, body);
    if (!statement) return { status: "unknown", reason: "unplaced-transition", node: site.node.getText(source) };
    siteStatements.set(site, statement);
  }
  const blocks = new Map<string, ResourceProtocolBlock>();
  const used = new Set<ResourceTransitionSite>();
  let serial = 0;
  const id = (kind: string, node?: ts.Node): string => `${kind}_${node?.getStart(source) ?? "synthetic"}_${serial++}`;
  const sitesFor = (statement: ts.Statement): readonly ResourceTransitionSite[] => {
    const selected = sites.filter((site) => siteStatements.get(site) === statement)
      .sort((left, right) => left.node.getStart(source) - right.node.getStart(source));
    for (const site of selected) used.add(site);
    return selected;
  };
  const transitionsFor = (statement: ts.Statement): readonly ResourceProtocolTransition[] => sitesFor(statement).flatMap((site) => site.transitions);
  const successorsFor = (statement: ts.Statement, normal: readonly string[], context: Context): readonly string[] =>
    sitesFor(statement).some((site) => site.exceptionalCompletion === "throw") ? [...normal, context.throwTarget] : normal;
  const exit = id("exit");
  blocks.set(exit, { id: exit, transitions: [], successors: [] });
  let unsupported: ts.Statement | undefined;
  interface Context { returnTarget: string; throwTarget: string; breakTarget?: string; continueTarget?: string; labels: ReadonlyMap<string, { breakTarget: string; continueTarget?: string }> }
  const rootContext: Context = { returnTarget: exit, throwTarget: exit, labels: new Map() };

  const lowerSequence = (statements: readonly ts.Statement[], continuation: string, context: Context): string => {
    let next = continuation;
    for (let index = statements.length - 1; index >= 0; index--) next = lowerStatement(statements[index]!, next, context);
    return next;
  };
  const lowerLoop = (statement: ts.IterationStatement, continuation: string, context: Context, label?: string): string => {
    const header = id("loop", statement);
    const labels = new Map(context.labels);
    if (label) labels.set(label, { breakTarget: continuation, continueTarget: header });
    const loopContext: Context = { ...context, breakTarget: continuation, continueTarget: header, labels };
    const bodyEntry = lowerStatement(statement.statement, header, loopContext);
    const staticallyInfinite = ts.isWhileStatement(statement) && statement.expression.kind === ts.SyntaxKind.TrueKeyword
      || ts.isForStatement(statement) && !statement.condition;
    blocks.set(header, { id: header, transitions: transitionsFor(statement), successors: successorsFor(statement, [bodyEntry, ...(staticallyInfinite ? [] : [continuation])], context) });
    return ts.isDoStatement(statement) ? bodyEntry : header;
  };
  const lowerStatement = (statement: ts.Statement, continuation: string, context: Context): string => {
    if (ts.isBlock(statement)) return lowerSequence(statement.statements, continuation, context);
    if (ts.isIfStatement(statement)) {
      const whenTrue = lowerStatement(statement.thenStatement, continuation, context);
      const whenFalse = statement.elseStatement ? lowerStatement(statement.elseStatement, continuation, context) : continuation;
      const blockId = id("if", statement);
      blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: successorsFor(statement, [whenTrue, whenFalse], context) });
      return blockId;
    }
    if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) {
      const blockId = id(ts.isReturnStatement(statement) ? "return" : "throw", statement);
      const target = ts.isReturnStatement(statement) ? context.returnTarget : context.throwTarget;
      blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: ts.isReturnStatement(statement) ? successorsFor(statement, [target], context) : [target] });
      return blockId;
    }
    if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
      const labeled = statement.label ? context.labels.get(statement.label.text) : undefined;
      const target = ts.isBreakStatement(statement) ? labeled?.breakTarget ?? context.breakTarget : labeled?.continueTarget ?? context.continueTarget;
      if (!target) { unsupported ??= statement; return continuation; }
      const blockId = id(ts.isBreakStatement(statement) ? "break" : "continue", statement);
      blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: [target] });
      return blockId;
    }
    if (ts.isIterationStatement(statement, false)) return lowerLoop(statement, continuation, context);
    if (ts.isLabeledStatement(statement)) {
      if (ts.isIterationStatement(statement.statement, false)) return lowerLoop(statement.statement, continuation, context, statement.label.text);
      const labels = new Map(context.labels).set(statement.label.text, { breakTarget: continuation });
      return lowerStatement(statement.statement, continuation, { ...context, labels });
    }
    if (ts.isSwitchStatement(statement)) {
      const switchContext: Context = { ...context, breakTarget: continuation };
      let fallthrough = continuation;
      const entries: string[] = [];
      for (let index = statement.caseBlock.clauses.length - 1; index >= 0; index--) {
        const clause = statement.caseBlock.clauses[index]!;
        const entry = lowerSequence(clause.statements, fallthrough, switchContext);
        entries.unshift(entry);
        fallthrough = entry;
      }
      const hasDefault = statement.caseBlock.clauses.some(ts.isDefaultClause);
      const blockId = id("switch", statement);
      blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: successorsFor(statement, [...entries, ...(hasDefault ? [] : [continuation])], context) });
      return blockId;
    }
    if (ts.isTryStatement(statement)) {
      const finallyBlock = statement.finallyBlock;
      const throughFinally = (target: string): string => finallyBlock ? lowerStatement(finallyBlock, target, context) : target;
      const normalTarget = throughFinally(continuation);
      const returnTarget = throughFinally(context.returnTarget);
      const throwTarget = throughFinally(context.throwTarget);
      const breakTarget = context.breakTarget ? throughFinally(context.breakTarget) : undefined;
      const continueTarget = context.continueTarget ? throughFinally(context.continueTarget) : undefined;
      const labels = new Map([...context.labels].map(([name, targets]) => [name, {
        breakTarget: throughFinally(targets.breakTarget),
        ...(targets.continueTarget ? { continueTarget: throughFinally(targets.continueTarget) } : {}),
      }]));
      const catchContext: Context = { ...context, returnTarget, throwTarget, breakTarget, continueTarget, labels };
      const catchEntry = statement.catchClause ? lowerStatement(statement.catchClause.block, normalTarget, catchContext) : throwTarget;
      const tryContext: Context = { ...context, returnTarget, throwTarget: catchEntry, breakTarget, continueTarget, labels };
      return lowerStatement(statement.tryBlock, normalTarget, tryContext);
    }
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      const blockId = id("declaration", statement);
      blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: [continuation] });
      return blockId;
    }
    const blockId = id("statement", statement);
    blocks.set(blockId, { id: blockId, transitions: transitionsFor(statement), successors: successorsFor(statement, [continuation], context) });
    return blockId;
  };

  const entry = lowerSequence(body.statements, exit, rootContext);
  if (unsupported) return { status: "unknown", reason: "unsupported-control-flow", node: unsupported.getText(source) };
  const unplaced = sites.find((site) => !used.has(site));
  if (unplaced) return { status: "unknown", reason: "unplaced-transition", node: unplaced.node.getText(source) };
  return {
    status: "exact",
    cfg: {
      schema: resourceProtocolCfgSchema,
      model,
      entry,
      exits: [exit],
      blocks: [...blocks.values()],
      budget: options.budget ?? { name: "typescript-resource-cfg", limit: 256 },
    },
  };
}

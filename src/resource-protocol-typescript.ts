import ts from "typescript";
import type { CallableSummary } from "./callable-summary.js";
import { resourceProtocolCfgSchema, type ResourceProtocolBlock, type ResourceProtocolCfg, type ResourceProtocolModel, type ResourceProtocolResource, type ResourceProtocolTransition } from "./resource-protocol.js";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import { interpretBuiltinCallSemantics, type ProjectedValue } from "./builtin-semantic-interpreter.js";

export interface ResourceTransitionSite {
  readonly node: ts.Node;
  readonly transitions: readonly ResourceProtocolTransition[];
  /** Authenticated synchronous throw, or an awaited rejection converted to throw. */
  readonly exceptionalCompletion?: "throw";
  readonly exceptionEvidence?: CallableExceptionalTransitionEvidence;
}

export interface CallableExceptionalTransitionEvidence {
  readonly summaryId: string;
  readonly evidence: "trusted" | "verified";
  readonly completion: "synchronous-throw" | "awaited-reject";
  readonly errorTypes: readonly string[];
  readonly declaration: { readonly fileName: string; readonly start: number; readonly end: number };
  readonly call: { readonly fileName: string; readonly start: number; readonly end: number };
}

export type ResourceProtocolTypeScriptLowering =
  | { readonly status: "exact"; readonly cfg: ResourceProtocolCfg }
  | { readonly status: "unknown"; readonly reason: "outside-function" | "unplaced-transition" | "unsupported-control-flow"; readonly node?: string };

export interface ResourceProtocolTypeScriptLoweringOptions {
  readonly budget?: { readonly name: string; readonly limit: number };
}

export interface BuiltinResourceTransitionCollection {
  readonly resources: readonly ResourceProtocolResource[];
  readonly sites: readonly ResourceTransitionSite[];
  readonly unknown: readonly { readonly node: ts.CallExpression; readonly reason: string }[];
}

/** Projects generic builtin acquire/release events into the shared resource CFG. */
export function collectBuiltinResourceTransitionSites(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
): BuiltinResourceTransitionCollection {
  if (!fn.body) return { resources: [], sites: [], unknown: [] };
  const adapter = new TypeScriptFrontendAdapter(program);
  const checker = program.getTypeChecker();
  const resources = new Map<string, ResourceProtocolResource>();
  const sites: ResourceTransitionSite[] = [];
  const unknown: Array<{ node: ts.CallExpression; reason: string }> = [];
  const resultBinding = (call: ts.CallExpression): string | undefined => {
    const parent = call.parent;
    return ts.isVariableDeclaration(parent) && parent.initializer === call && ts.isIdentifier(parent.name)
      ? parent.name.text : undefined;
  };
  const stableRoot = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression => {
    if (!ts.isIdentifier(expression)) return expression;
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    if (!symbol || seen.has(symbol)) return expression;
    const declaration = symbol.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0
      || !ts.isIdentifier(declaration.initializer)) return expression;
    return stableRoot(declaration.initializer, new Set(seen).add(symbol));
  };
  const identity = (target: ProjectedValue, call: ts.CallExpression): string | undefined => {
    if (target.status === "result") return resultBinding(call);
    if (target.status !== "resolved") return undefined;
    const root = stableRoot(target.expression);
    return `${root.getText(root.getSourceFile())}${target.path.map((part) => `.${part}`).join("")}`;
  };
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const resolved = adapter.resolveCall(node);
      const events = resolved?.semantics
        ? interpretBuiltinCallSemantics(resolved.semantics, node, { symbol: resolved.symbol, span: resolved.span }) : [];
      const transitions: ResourceProtocolTransition[] = [];
      for (const event of events) {
        if ((event.kind !== "acquire" && event.kind !== "release") || !event.target) continue;
        const resource = identity(event.target, node);
        if (!resource) {
          unknown.push({ node, reason: `${event.kind}(${event.resource}) has no stable projected resource identity` });
          continue;
        }
        if (!resources.has(resource)) resources.set(resource, {
          id: resource, label: resource, kind: event.resource,
          initialState: event.kind === "acquire" ? "absent" : "available", requiredTerminalStates: ["released"],
        });
        transitions.push({ kind: event.kind, resource, at: node.getStart(node.getSourceFile()), evidence: "trusted" });
      }
      if (transitions.length) sites.push({ node, transitions });
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return { resources: [...resources.values()], sites, unknown };
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function directlyAwaited(call: ts.CallExpression): boolean {
  let current: ts.Expression = call;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent) || ts.isNonNullExpression(current.parent)) current = current.parent;
  return ts.isAwaitExpression(current.parent) && current.parent.expression === current;
}

/** Converts only trusted/verified callable summaries into exceptional CFG sites. */
export function collectCallableExceptionalTransitionSites(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  summaries: readonly CallableSummary[],
): readonly ResourceTransitionSite[] {
  if (!fn.body) return [];
  const checker = program.getTypeChecker();
  const byId = new Map(summaries.filter((summary) => summary.evidence === "trusted" || summary.evidence === "verified")
    .map((summary) => [summary.id, summary] as const));
  const sites: ResourceTransitionSite[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbol(checker, node.expression);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration) {
        const declarationSource = declaration.getSourceFile();
        const summary = byId.get(`${declarationSource.fileName}:${declaration.getStart(declarationSource)}`);
        const completion = summary?.throws.length ? "synchronous-throw"
          : summary?.rejects.length && directlyAwaited(node) ? "awaited-reject" : undefined;
        const errorTypes = completion === "synchronous-throw" ? summary?.throws : completion === "awaited-reject" ? summary?.rejects : undefined;
        if (summary && completion && errorTypes?.length) sites.push({
          node,
          transitions: [],
          exceptionalCompletion: "throw",
          exceptionEvidence: {
            summaryId: summary.id,
            evidence: summary.evidence as "trusted" | "verified",
            completion,
            errorTypes,
            declaration: { fileName: declarationSource.fileName, start: declaration.getStart(declarationSource), end: declaration.getEnd() },
            call: { fileName: node.getSourceFile().fileName, start: node.getStart(), end: node.getEnd() },
          },
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return sites;
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

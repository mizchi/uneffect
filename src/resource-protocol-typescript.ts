import ts from "typescript";
import type { CallableSummary } from "./callable-summary.js";
import { externalContractForCall, type ExternalFunctionEffectContract } from "./effects.js";
import { resourceProtocolCfgSchema, type ResourceProtocolBlock, type ResourceProtocolCfg, type ResourceProtocolModel, type ResourceProtocolResource, type ResourceProtocolTransition } from "./resource-protocol.js";
import { TypeScriptFrontendAdapter } from "./frontend-adapter.js";
import { interpretBuiltinCallSemantics, type ProjectedValue } from "./builtin-semantic-interpreter.js";

export interface ResourceTransitionSite {
  readonly node: ts.Node;
  readonly transitions: readonly ResourceProtocolTransition[];
  /** State changes that happen only after an awaited operation fulfills. */
  readonly fulfillmentTransitions?: readonly ResourceProtocolTransition[];
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
  /** Implicit releases introduced by `using` / `await using` lexical scope exit. */
  readonly lexicalDisposals?: readonly {
    readonly declaration: ts.VariableDeclaration;
    readonly transition: ResourceProtocolTransition;
  }[];
}

export interface BuiltinResourceTransitionCollection {
  readonly resources: readonly ResourceProtocolResource[];
  readonly sites: readonly ResourceTransitionSite[];
  readonly unknown: readonly { readonly node: ts.CallExpression | ts.NewExpression; readonly reason: string }[];
}

export interface AwaitedResourceBinding {
  readonly id: string;
  readonly label: string;
  /** Call for direct await, or the later AwaitExpression for a Promise alias. */
  readonly node: ts.Node;
}

/** Resolve direct await or one immutable, non-escaping Promise binding. */
export function resolveAwaitedResourceBinding(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  call: ts.CallExpression,
): AwaitedResourceBinding | undefined {
  if (!fn.body) return undefined;
  const checker = program.getTypeChecker();
  const bindingOf = (expression: ts.Expression, node: ts.Node): AwaitedResourceBinding | undefined => {
    let result = expression;
    while ((ts.isParenthesizedExpression(result.parent) || ts.isNonNullExpression(result.parent)
      || ts.isAsExpression(result.parent) || ts.isTypeAssertionExpression(result.parent)
      || ts.isAwaitExpression(result.parent)) && result.parent.expression === result) result = result.parent;
    const parent = result.parent;
    return ts.isVariableDeclaration(parent) && parent.initializer === result && ts.isIdentifier(parent.name)
      ? { id: `region:${parent.getSourceFile().fileName}:${parent.getStart()}`, label: parent.name.text, node }
      : undefined;
  };
  if (directlyAwaited(call)) return bindingOf(call, call);
  const declaration = call.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== call || !ts.isIdentifier(declaration.name)
    || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  const symbol = resolvedSymbol(checker, declaration.name);
  if (!symbol) return undefined;
  const references: ts.Identifier[] = [];
  const find = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && node !== declaration.name && resolvedSymbol(checker, node) === symbol) references.push(node);
    ts.forEachChild(node, find);
  };
  find(fn.body);
  if (references.length !== 1) return undefined;
  const reference = references[0]!;
  if (!ts.isAwaitExpression(reference.parent) || reference.parent.expression !== reference) return undefined;
  return bindingOf(reference.parent, reference.parent);
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
  const unknown: Array<{ node: ts.CallExpression | ts.NewExpression; reason: string }> = [];
  const resultBinding = (call: ts.CallExpression | ts.NewExpression): { id: string; label: string } | undefined => {
    let result: ts.Expression = call;
    while ((ts.isParenthesizedExpression(result.parent) || ts.isNonNullExpression(result.parent)
      || ts.isAsExpression(result.parent) || ts.isTypeAssertionExpression(result.parent)
      || ts.isAwaitExpression(result.parent)) && result.parent.expression === result) result = result.parent;
    const parent = result.parent;
    return ts.isVariableDeclaration(parent) && parent.initializer === result && ts.isIdentifier(parent.name)
      ? { id: `region:${parent.getSourceFile().fileName}:${parent.getStart()}`, label: parent.name.text } : undefined;
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
  const identity = (target: ProjectedValue, call: ts.CallExpression | ts.NewExpression): { id: string; label: string } | undefined => {
    if (target.status === "result") return resultBinding(call);
    if (target.status !== "resolved") return undefined;
    const root = stableRoot(target.expression);
    const symbol = ts.isIdentifier(root) ? resolvedSymbol(checker, root) : undefined;
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    const suffix = target.path.map((part) => `.${part}`).join("");
    return {
      id: `${declaration ? `region:${declaration.getSourceFile().fileName}:${declaration.getStart()}` : `region:${root.getSourceFile().fileName}:${root.getStart()}`}${suffix}`,
      label: `${root.getText(root.getSourceFile())}${suffix}`,
    };
  };
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const resolved = ts.isCallExpression(node) ? adapter.resolveCall(node) : adapter.resolveConstruct(node);
      const events = resolved?.semantics
        ? interpretBuiltinCallSemantics(resolved.semantics, node, { symbol: resolved.symbol, span: resolved.span }, undefined,
          { resolveStaticString: (expression) => adapter.resolveStaticString(expression) }) : [];
      const transitions: ResourceProtocolTransition[] = [];
      const fulfillmentTransitions: ResourceProtocolTransition[] = [];
      let transitionNode: ts.Node = node;
      let fulfillmentHasOwnRejectionEdge = false;
      for (const event of events) {
        if ((event.kind !== "acquire" && event.kind !== "use" && event.kind !== "release") || !event.target) continue;
        const fulfilledBinding = event.completion === "fulfillment" && event.target.status === "result" && ts.isCallExpression(node)
          ? resolveAwaitedResourceBinding(program, fn, node) : undefined;
        if (event.completion === "fulfillment" && event.target.status === "result" && !fulfilledBinding) {
          unknown.push({ node, reason: `${event.kind}(${event.resource}) occurs on fulfillment but the Promise-to-resource binding is not stable` });
          continue;
        }
        const identityValue = fulfilledBinding ?? identity(event.target, node);
        if (!identityValue) {
          unknown.push({ node, reason: `${event.kind}(${event.resource}) has no stable projected resource identity` });
          continue;
        }
        if (fulfilledBinding) {
          transitionNode = fulfilledBinding.node;
          fulfillmentHasOwnRejectionEdge = fulfilledBinding.node !== node;
        }
        const resource = identityValue.id;
        if (!resources.has(resource)) resources.set(resource, {
          id: resource, label: identityValue.label, kind: event.resource,
          initialState: event.kind === "acquire" ? "absent" : "available",
          ...(event.kind === "acquire" ? { requiredTerminalStates: ["released"] as const } : {}),
        });
        const transition = { kind: event.kind, resource, at: transitionNode.getStart(node.getSourceFile()), evidence: "trusted" } as ResourceProtocolTransition;
        (event.completion === "fulfillment" ? fulfillmentTransitions : transitions).push(transition);
      }
      if (transitions.length || fulfillmentTransitions.length) sites.push({
        node: transitionNode, transitions, ...(fulfillmentTransitions.length ? { fulfillmentTransitions } : {}),
        ...(fulfillmentHasOwnRejectionEdge ? { exceptionalCompletion: "throw" as const } : {}),
      });
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

/**
 * Adds the JavaScript rejection edge for directly awaited Promise-returning
 * calls. Acquisition calls are excluded because their resource exists only on
 * fulfillment; representing that requires a fulfillment-edge transition.
 */
export function collectAwaitedRejectionTransitionSites(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  resourceSites: readonly ResourceTransitionSite[] = [],
): readonly ResourceTransitionSite[] {
  if (!fn.body) return [];
  const checker = program.getTypeChecker();
  const callTimeAcquisitions = new Set(resourceSites.filter((site) => site.transitions
    .some((transition) => transition.kind === "acquire"))
    .map((site) => site.node));
  const sites: ResourceTransitionSite[] = [];
  const mayBePromiseLike = (type: ts.Type): boolean => type.isUnion()
    ? type.types.some(mayBePromiseLike)
    : checker.getPropertyOfType(type, "then") !== undefined;
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && directlyAwaited(node) && !callTimeAcquisitions.has(node)) {
      const type = checker.getTypeAtLocation(node);
      if (mayBePromiseLike(type)) sites.push({ node, transitions: [], exceptionalCompletion: "throw" });
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return sites;
}

/** Converts only trusted/verified callable summaries into exceptional CFG sites. */
export function collectCallableExceptionalTransitionSites(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  summaries: readonly CallableSummary[],
  externalContracts: ReadonlyMap<string, ExternalFunctionEffectContract> = new Map(),
): readonly ResourceTransitionSite[] {
  if (!fn.body) return [];
  const checker = program.getTypeChecker();
  const byId = new Map(summaries.filter((summary) => summary.evidence === "trusted" || summary.evidence === "verified")
    .map((summary) => [summary.id, summary] as const));
  const summaryForSymbol = (symbol: ts.Symbol): CallableSummary | undefined => {
    for (const declaration of symbol.declarations ?? []) {
      const source = declaration.getSourceFile();
      const summary = byId.get(`${source.fileName}:${declaration.getStart(source)}`);
      if (summary) return summary;
    }
    return undefined;
  };
  const isAuthenticatedObjectFreeze = (call: ts.CallExpression): boolean => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "freeze") return false;
    const symbol = resolvedSymbol(checker, call.expression.name);
    return symbol?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
      && /(?:^|[/\\])lib\.(?:es\d+|esnext|d)\b.*\.d\.ts$/u.test(declaration.getSourceFile().fileName)) === true;
  };
  const stableSummarySymbol = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Symbol | undefined => {
    while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    const location = ts.isPropertyAccessExpression(expression) ? expression.name
      : ts.isElementAccessExpression(expression) ? expression.argumentExpression : expression;
    const symbol = location ? resolvedSymbol(checker, location) : undefined;
    if (!symbol || seen.has(symbol)) return undefined;
    if (summaryForSymbol(symbol)) return symbol;
    const nextSeen = new Set(seen).add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer
        && ts.isVariableDeclarationList(declaration.parent)
        && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
        const target = stableSummarySymbol(declaration.initializer, nextSeen);
        if (target) return target;
      }
      if (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
        const literal = declaration.parent;
        const call = literal.parent;
        const variable = call.parent;
        if (!ts.isObjectLiteralExpression(literal) || !ts.isCallExpression(call)
          || call.arguments[0] !== literal || !isAuthenticatedObjectFreeze(call)
          || !ts.isVariableDeclaration(variable) || variable.initializer !== call
          || !ts.isVariableDeclarationList(variable.parent)
          || (variable.parent.flags & ts.NodeFlags.Const) === 0) continue;
        if (ts.isPropertyAssignment(declaration)) {
          const target = stableSummarySymbol(declaration.initializer, nextSeen);
          if (target) return target;
        } else {
          const value = checker.getShorthandAssignmentValueSymbol(declaration);
          if (value && !nextSeen.has(value)) {
            if (summaryForSymbol(value)) return value;
            const valueDeclaration = value.valueDeclaration ?? value.declarations?.[0];
            if (valueDeclaration && ts.isVariableDeclaration(valueDeclaration) && valueDeclaration.initializer) {
              const target = stableSummarySymbol(valueDeclaration.initializer, new Set(nextSeen).add(value));
              if (target) return target;
            }
          }
        }
      }
    }
    return undefined;
  };
  const sites: ResourceTransitionSite[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const candidate = externalContractForCall(checker, node, externalContracts);
      const symbol = stableSummarySymbol(node.expression) ?? (candidate ? resolvedSymbol(checker, node.expression) : undefined);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (symbol && declaration) {
        const declarationSource = declaration.getSourceFile();
        const key = `${declarationSource.fileName}:${declaration.getStart(declarationSource)}`;
        const summary = summaryForSymbol(symbol);
        const external = candidate?.evidence === "verified" ? candidate : undefined;
        const throws = summary?.throws ?? external?.effects.flatMap((effect) => effect.kind === "throw" ? [effect.errorType] : []);
        const rejects = summary?.rejects ?? external?.rejects;
        const evidence = summary ? summary.evidence as "trusted" | "verified"
          : external ? external.contractEvidence ?? (external.evidence === "verified" ? "verified" : "trusted")
            : undefined;
        const add = (completion: CallableExceptionalTransitionEvidence["completion"], errorTypes: readonly string[]): void => {
          sites.push({
            node,
            transitions: [],
            exceptionalCompletion: "throw",
            exceptionEvidence: {
              summaryId: summary?.id ?? key, evidence: evidence!, completion, errorTypes,
              declaration: { fileName: declarationSource.fileName, start: declaration.getStart(declarationSource), end: declaration.getEnd() },
              call: { fileName: node.getSourceFile().fileName, start: node.getStart(), end: node.getEnd() },
            },
          });
        };
        if ((summary || external) && throws?.length) add("synchronous-throw", throws);
        if ((summary || external) && rejects?.length && directlyAwaited(node)) add("awaited-reject", rejects);
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
  const successorsFor = (statement: ts.Statement, normal: readonly string[], context: Context): readonly string[] => {
    const selected = sitesFor(statement);
    const fulfillment = selected.flatMap((site) => site.fulfillmentTransitions ?? []);
    let normalSuccessors = normal;
    if (fulfillment.length > 0) {
      const completion = id("fulfillment", statement);
      blocks.set(completion, { id: completion, transitions: fulfillment, successors: normal });
      normalSuccessors = [completion];
    }
    return selected.some((site) => site.exceptionalCompletion === "throw")
      ? [...normalSuccessors, context.throwTarget] : normalSuccessors;
  };
  const exit = id("exit");
  blocks.set(exit, { id: exit, transitions: [], successors: [] });
  let unsupported: ts.Statement | undefined;
  interface Context { returnTarget: string; throwTarget: string; breakTarget?: string; continueTarget?: string; labels: ReadonlyMap<string, { breakTarget: string; continueTarget?: string }> }
  const rootContext: Context = { returnTarget: exit, throwTarget: exit, labels: new Map() };

  const cleanupCache = new Map<string, string>();
  const cleanupEntry = (target: string, transitions: readonly ResourceProtocolTransition[]): string => {
    if (transitions.length === 0) return target;
    const key = `${target}:${transitions.map((transition) => `${transition.kind}:${"resource" in transition ? transition.resource : "join"}:${transition.at}:${transition.evidence ?? ""}:${transition.conditional ?? false}`).join("|")}`;
    const cached = cleanupCache.get(key);
    if (cached) return cached;
    let entry = target;
    for (const transition of transitions) {
      const blockId = id("dispose");
      blocks.set(blockId, { id: blockId, transitions: [transition], successors: [entry] });
      entry = blockId;
    }
    cleanupCache.set(key, entry);
    return entry;
  };
  const throughCleanup = (context: Context, transitions: readonly ResourceProtocolTransition[]): Context => {
    if (transitions.length === 0) return context;
    const labels = new Map([...context.labels].map(([name, targets]) => [name, {
      breakTarget: cleanupEntry(targets.breakTarget, transitions),
      ...(targets.continueTarget ? { continueTarget: cleanupEntry(targets.continueTarget, transitions) } : {}),
    }]));
    return {
      returnTarget: cleanupEntry(context.returnTarget, transitions),
      throwTarget: cleanupEntry(context.throwTarget, transitions),
      ...(context.breakTarget ? { breakTarget: cleanupEntry(context.breakTarget, transitions) } : {}),
      ...(context.continueTarget ? { continueTarget: cleanupEntry(context.continueTarget, transitions) } : {}),
      labels,
    };
  };

  const lowerSequence = (statements: readonly ts.Statement[], continuation: string, context: Context): string => {
    const disposals = (options.lexicalDisposals ?? []).flatMap((disposal) => {
      const list = disposal.declaration.parent;
      const statement = ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) ? list.parent : undefined;
      const index = statement ? statements.indexOf(statement) : -1;
      return index >= 0 ? [{ ...disposal, index }] : [];
    }).sort((left, right) => left.index - right.index);
    let next = cleanupEntry(continuation, disposals.map(({ transition }) => transition));
    for (let index = statements.length - 1; index >= 0; index--) {
      const active = disposals.filter((disposal) => disposal.index < index).map(({ transition }) => transition);
      next = lowerStatement(statements[index]!, next, throughCleanup(context, active));
    }
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

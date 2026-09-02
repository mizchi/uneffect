import ts from "typescript";
import { extractLocatedAnnotations } from "./annotations.js";
import { resolveRegionIdentity } from "./region-alias.js";
import {
  evaluateResourceProtocolCfg,
  instantiateResourceCallableSummary,
  type ResourceCallableOperation,
  type ResourceCallableReference,
  type ResourceCallableSummary,
  type ResourceProtocolResource,
  type ResourceProtocolState,
  type ResourceProtocolTransition,
} from "./resource-protocol.js";
import { collectAwaitedRejectionTransitionSites, collectBuiltinResourceTransitionSites, lowerResourceProtocolCfgInFunction, resolveAwaitedResourceBinding, type ResourceTransitionSite } from "./resource-protocol-typescript.js";
import { resolveStableCallableSymbol, stableCallableDeclaration } from "./stable-callable.js";

type SupportedFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature
  | ts.CallSignatureDeclaration | ts.ArrowFunction | ts.FunctionExpression;

export interface ResourceCallableDiagnostic {
  readonly code: "invalid-resource-reference" | "invalid-resource-acquire" | "invalid-resource-receiver" | "invalid-resource-transfer" | "unresolved-resource-binding";
  readonly fileName: string;
  readonly message: string;
  readonly span: { readonly start: number; readonly end: number };
}

export interface ResourceCallableSummaryAnalysis {
  readonly summaries: readonly ResourceCallableSummary[];
  readonly diagnostics: readonly ResourceCallableDiagnostic[];
}

export interface ResourceCallableSiteAnalysis {
  readonly resources: readonly ResourceProtocolResource[];
  readonly sites: readonly ResourceTransitionSite[];
  readonly diagnostics: readonly ResourceCallableDiagnostic[];
}

export interface ResourceLifecycleEvidence {
  readonly fileName: string;
  readonly owner: string;
  readonly resource: string;
  readonly kind: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly status: "satisfied" | "unsatisfied" | "unknown";
  readonly evidence: "verified" | "trusted" | "unknown";
  readonly authority: "callable-contract" | "builtin-catalog" | "mixed";
  readonly state: ResourceProtocolState;
  readonly transitions: readonly ResourceProtocolTransition[];
}

export interface ResourceLifecycleDiagnostic {
  readonly kind: "invalid-contract" | "unclosed" | "invalid-transition" | "unknown-analysis";
  readonly fileName: string;
  readonly functionName: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly resource: string;
  readonly state: ResourceProtocolState;
  readonly message: string;
}

export interface ResourceLifecycleProgramAnalysis {
  readonly evidence: readonly ResourceLifecycleEvidence[];
  readonly diagnostics: readonly ResourceLifecycleDiagnostic[];
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function resourceValueSymbol(checker: ts.TypeChecker, node: ts.Identifier): ts.Symbol | undefined {
  if (ts.isBindingElement(node.parent) && node.parent.propertyName === node) return undefined;
  const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
    ? checker.getShorthandAssignmentValueSymbol(node.parent) : resolvedSymbol(checker, node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function annotationOwner(node: SupportedFunction): ts.Node {
  const parent = node.parent;
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || !parent || !ts.isVariableDeclaration(parent)) return node;
  const declarationList = parent.parent;
  const statement = declarationList?.parent;
  return declarationList && ts.isVariableDeclarationList(declarationList) && statement && ts.isVariableStatement(statement)
    ? statement : node;
}

function reference(text: string, declaration: SupportedFunction): ResourceCallableReference | undefined {
  if (text === "return") return { kind: "return" };
  if (text === "this") return { kind: "receiver" };
  const index = declaration.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === text);
  return index < 0 ? undefined : { kind: "parameter", index, name: text };
}

/** Extracts declared resource-boundary contracts. Declarations are trusted, not verified. */
export function analyzeResourceCallableSummaries(program: ts.Program): ResourceCallableSummaryAnalysis {
  const summaries: ResourceCallableSummary[] = [];
  const diagnostics: ResourceCallableDiagnostic[] = [];
  const roots = new Set(program.getRootFileNames().map((fileName) => program.getSourceFile(fileName)).filter((candidate): candidate is ts.SourceFile => !!candidate));
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile && !roots.has(source)) continue;
    if (!source.text.includes("uneffect:")) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)
        || ts.isCallSignatureDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const owner = annotationOwner(node);
        const leadingStart = owner.getFullStart();
        const leading = source.text.slice(leadingStart, owner.getStart(source));
        const operations: ResourceCallableOperation[] = [];
        for (const kind of ["acquire", "use", "borrow", "consume", "release", "transfer", "escape"] as const) {
          for (const annotation of extractLocatedAnnotations(leading, kind, leadingStart)) {
            const parts = kind === "transfer" ? /^([^\s]+)\s*->\s*([^\s]+)$/u.exec(annotation.value) : undefined;
            const subjectText = parts?.[1] ?? annotation.value.trim();
            const targetText = parts?.[2];
            const subject = reference(subjectText, node);
            const target = targetText ? reference(targetText, node) : undefined;
            if (!subject) {
              diagnostics.push({ code: "invalid-resource-reference", fileName: source.fileName,
                message: `unknown resource parameter ${subjectText}`, span: annotation.span });
              continue;
            }
            if ((subject.kind === "receiver" || target?.kind === "receiver")
              && !ts.isMethodDeclaration(node) && !ts.isMethodSignature(node)) {
              diagnostics.push({ code: "invalid-resource-receiver", fileName: source.fileName,
                message: "`this` resource references require a method declaration or signature", span: annotation.span });
              continue;
            }
            if (kind === "acquire" && subject.kind !== "return") {
              diagnostics.push({ code: "invalid-resource-acquire", fileName: source.fileName,
                message: "acquire must introduce the callable `return` resource", span: annotation.span });
              continue;
            }
            if (kind === "transfer" && (!parts || !target)) {
              diagnostics.push({ code: "invalid-resource-transfer", fileName: source.fileName,
                message: `transfer must be \`parameter -> parameter|return\``, span: annotation.span });
              continue;
            }
            operations.push({ kind, subject, ...(target ? { target } : {}) });
          }
        }
        if (operations.length > 0) summaries.push({
          schema: "uneffect-resource-callable-summary/v1",
          id: `${source.fileName}:${node.getStart(source)}`,
          evidence: "trusted",
          operations,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { summaries, diagnostics };
}

function resultDeclaration(call: ts.CallExpression): ts.VariableDeclaration | undefined {
  let current: ts.Expression = call;
  while ((ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)
    || ts.isAwaitExpression(current.parent)) && current.parent.expression === current) current = current.parent;
  const parent = current.parent;
  return ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name) ? parent : undefined;
}

function returnedResourceId(call: ts.CallExpression, allowTemporary = false): string | undefined {
  const declaration = resultDeclaration(call);
  return declaration ? `region:${declaration.getSourceFile().fileName}:${declaration.getStart()}`
    : allowTemporary ? `region:${call.getSourceFile().fileName}:${call.getStart()}` : undefined;
}

function directlyReturned(call: ts.CallExpression): boolean {
  let current: ts.Expression = call;
  while ((ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)
    || ts.isAwaitExpression(current.parent)) && current.parent.expression === current) current = current.parent;
  return ts.isReturnStatement(current.parent) && current.parent.expression === current;
}

function resourceArgumentId(checker: ts.TypeChecker, input: ts.Expression): string | undefined {
  const visit = (expression: ts.Expression, seen: ReadonlySet<ts.Symbol>): string | undefined => {
    while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    if (ts.isIdentifier(expression)) {
      const destructured = destructuredResourceValue(checker, expression);
      if (destructured) return visit(destructured, seen);
      const symbol = resourceValueSymbol(checker, expression);
      const declaration = symbol?.declarations?.find((candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name));
      if (symbol && declaration) {
        const flags = ts.isVariableDeclarationList(declaration.parent) ? ts.getCombinedNodeFlags(declaration.parent) : 0;
        const immutable = (flags & ts.NodeFlags.Const) !== 0 || (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using;
        if (seen.has(symbol) || !ts.isVariableDeclarationList(declaration.parent)
          || !immutable || !declaration.initializer) return undefined;
        let initializer = declaration.initializer;
        while (ts.isParenthesizedExpression(initializer) || ts.isNonNullExpression(initializer)
          || ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer)
          || ts.isAwaitExpression(initializer)) initializer = initializer.expression;
        if (ts.isCallExpression(initializer) || ts.isNewExpression(initializer)) {
          return `region:${declaration.getSourceFile().fileName}:${declaration.getStart()}`;
        }
        return visit(initializer, new Set([...seen, symbol]));
      }
    }
    const identity = resolveRegionIdentity(checker, expression);
    return identity.status === "resolved" ? identity.regionId : undefined;
  };
  return visit(input, new Set());
}

interface StableAggregateResourceSlot {
  readonly resource: string;
  readonly storedExpression: ts.Expression;
}

function unwrapResourceExpression(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function aggregateLiteralValue(initializer: ts.Expression, key: string): ts.Expression | undefined {
  initializer = unwrapResourceExpression(initializer);
  if (ts.isObjectLiteralExpression(initializer)) {
    for (const property of initializer.properties) {
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return property.name;
      if (ts.isPropertyAssignment(property)) {
        const name = property.name;
        const propertyKey = ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
        if (propertyKey === key) return property.initializer;
      }
    }
  } else if (ts.isArrayLiteralExpression(initializer) && /^\d+$/u.test(key)) {
    const element = initializer.elements[Number(key)];
    if (element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)) return element;
  }
  return undefined;
}

function aggregateLiteralPathValue(initializer: ts.Expression, keys: readonly string[]): ts.Expression | undefined {
  let value: ts.Expression | undefined = initializer;
  for (const key of keys) {
    value = value && aggregateLiteralValue(value, key);
    if (!value) return undefined;
  }
  return value;
}

function staticAggregateAccessPath(expression: ts.Expression): { root: ts.Identifier; keys: readonly string[] } | undefined {
  let current = unwrapResourceExpression(expression);
  const keys: string[] = [];
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) keys.unshift(current.name.text);
    else if (current.argumentExpression
      && (ts.isStringLiteralLike(current.argumentExpression) || ts.isNumericLiteral(current.argumentExpression))) {
      keys.unshift(current.argumentExpression.text);
    } else return undefined;
    current = unwrapResourceExpression(current.expression);
  }
  return ts.isIdentifier(current) && keys.length > 0 ? { root: current, keys } : undefined;
}

interface DestructuredResourcePath {
  readonly source: ts.Expression;
  readonly keys: readonly string[];
}

function destructuredResourcePath(checker: ts.TypeChecker, identifier: ts.Identifier): DestructuredResourcePath | undefined {
  const first = resourceValueSymbol(checker, identifier)?.valueDeclaration;
  if (!first || !ts.isBindingElement(first) || !ts.isIdentifier(first.name)) return undefined;
  let element: ts.BindingElement = first;
  const keys: string[] = [];
  let variable: ts.VariableDeclaration | undefined;
  while (ts.isBindingElement(element)) {
    if (element.dotDotDotToken || element.initializer) return undefined;
    const pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern = element.parent;
    if (ts.isObjectBindingPattern(pattern)) {
      const name = element.propertyName ?? element.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name) && !ts.isNumericLiteral(name)) return undefined;
      keys.unshift(name.text);
    } else if (ts.isArrayBindingPattern(pattern)) {
      const index = pattern.elements.indexOf(element);
      if (index < 0) return undefined;
      keys.unshift(String(index));
    } else return undefined;
    const owner: ts.Node = pattern.parent;
    if (ts.isVariableDeclaration(owner)) variable = owner;
    else if (ts.isBindingElement(owner)) element = owner;
    else return undefined;
    if (variable) break;
  }
  if (!variable || variable.name !== element.parent || !variable.initializer
    || !ts.isVariableDeclarationList(variable.parent)
    || (ts.getCombinedNodeFlags(variable.parent) & ts.NodeFlags.Const) === 0) return undefined;
  return { source: variable.initializer, keys };
}

function destructuredResourceValue(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Expression | undefined {
  const path = destructuredResourcePath(checker, identifier);
  return path && aggregateLiteralPathValue(path.source, path.keys);
}

function stableAggregatePathSlot(
  checker: ts.TypeChecker,
  fn: ts.FunctionLikeDeclaration,
  rootExpression: ts.Expression,
  keys: readonly string[],
  resourceIdentity: (value: ts.Expression) => string | undefined,
): StableAggregateResourceSlot | undefined {
  const root = unwrapResourceExpression(rootExpression);
  if (!ts.isIdentifier(root)) return undefined;
  const rootSymbol = resolvedSymbol(checker, root);
  const declaration = rootSymbol?.valueDeclaration;
  if (!rootSymbol || !declaration || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
    || !ts.isVariableDeclarationList(declaration.parent)
    || (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0
    || !declaration.initializer) return undefined;
  const storedExpression = aggregateLiteralPathValue(declaration.initializer, keys);
  if (!storedExpression) return undefined;
  let stable = true;
  const visit = (node: ts.Node): void => {
    if (!stable || node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isIdentifier(node) && resolvedSymbol(checker, node) === rootSymbol
      && node !== declaration.name && node !== root) stable = false;
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  const resource = stable ? resourceIdentity(storedExpression) : undefined;
  return resource ? { resource, storedExpression } : undefined;
}

/** Resolve a local aggregate path only when its container has no other observable use. */
function stableAggregateResourceSlot(
  checker: ts.TypeChecker,
  fn: ts.FunctionLikeDeclaration,
  expression: ts.Expression,
  resourceIdentity: (value: ts.Expression) => string | undefined,
): StableAggregateResourceSlot | undefined {
  const path = staticAggregateAccessPath(expression);
  if (!path) return undefined;
  return stableAggregatePathSlot(checker, fn, path.root, path.keys, resourceIdentity);
}

/** Instantiates authenticated callable contracts at calls within one function owner. */
export function collectResourceCallableTransitionSites(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  summaries: readonly ResourceCallableSummary[],
): ResourceCallableSiteAnalysis {
  if (!fn.body) return { resources: [], sites: [], diagnostics: [] };
  const checker = program.getTypeChecker();
  const byId = new Map(summaries.map((summary) => [summary.id, summary] as const));
  const sites: ResourceTransitionSite[] = [];
  const resources = new Map<string, ResourceProtocolResource>();
  const diagnostics: ResourceCallableDiagnostic[] = [];
  const fulfilledAliases = new Map<ts.Symbol, string>();
  const acquisitionCalls = new Set<ts.CallExpression>();
  const resourceIdentity = (expression: ts.Expression): string | undefined => {
    let target = expression;
    while (ts.isParenthesizedExpression(target) || ts.isNonNullExpression(target)
      || ts.isAsExpression(target) || ts.isTypeAssertionExpression(target)) target = target.expression;
    if (ts.isCallExpression(target) && acquisitionCalls.has(target)) {
      return `region:${target.getSourceFile().fileName}:${target.getStart()}`;
    }
    if (ts.isIdentifier(target)) {
      const destructuredPath = destructuredResourcePath(checker, target);
      if (destructuredPath && !aggregateLiteralPathValue(destructuredPath.source, destructuredPath.keys)) {
        const slot = stableAggregatePathSlot(checker, fn, destructuredPath.source, destructuredPath.keys, resourceIdentity);
        if (slot) return slot.resource;
      }
    }
    const symbol = ts.isIdentifier(target) ? resourceValueSymbol(checker, target) : undefined;
    return symbol ? fulfilledAliases.get(symbol) ?? resourceArgumentId(checker, expression) : resourceArgumentId(checker, expression);
  };
  const summaryForDeclarationSymbol = (symbol: ts.Symbol | undefined): ResourceCallableSummary | undefined => {
    const declarations = symbol?.declarations ?? (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
    for (const declaration of declarations) {
      const declarationSource = declaration.getSourceFile();
      const summary = byId.get(`${declarationSource.fileName}:${declaration.getStart(declarationSource)}`);
      if (summary) return summary;
    }
    return undefined;
  };
  const summaryForExpression = (expression: ts.Expression): ResourceCallableSummary | undefined => {
    const symbol = resolveStableCallableSymbol(checker, expression);
    const direct = summaryForDeclarationSymbol(symbol);
    if (direct) return direct;
    const declaration = symbol && stableCallableDeclaration(symbol);
    if (!declaration) return undefined;
    const source = declaration.getSourceFile();
    return byId.get(`${source.fileName}:${declaration.getStart(source)}`);
  };
  const factorySummaryForReceiver = (input: ts.Expression, seen = new Set<ts.Symbol>()): ResourceCallableSummary | undefined => {
    let expression = input;
    while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    if (ts.isCallExpression(expression)) return summaryForDeclarationSymbol(resolvedSymbol(checker, expression.expression));
    if (!ts.isIdentifier(expression)) return undefined;
    const symbol = resolvedSymbol(checker, expression);
    if (!symbol || seen.has(symbol)) return undefined;
    const declaration = symbol.declarations?.find((candidate): candidate is ts.VariableDeclaration =>
      ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name));
    if (!declaration || !declaration.initializer || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    return factorySummaryForReceiver(declaration.initializer, new Set(seen).add(symbol));
  };
  const summaryForCall = (node: ts.CallExpression): ResourceCallableSummary | undefined => {
    let summary = summaryForExpression(node.expression);
    if (!summary && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
      const key = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text
        : node.expression.argumentExpression && (ts.isStringLiteralLike(node.expression.argumentExpression)
          || ts.isNumericLiteral(node.expression.argumentExpression)) ? node.expression.argumentExpression.text : undefined;
      const factory = key ? factorySummaryForReceiver(node.expression.expression) : undefined;
      const member = factory?.returnMembers?.find((candidate) => candidate.key === key);
      if (factory && member) summary = {
        schema: "uneffect-resource-callable-summary/v1", id: `${factory.id}#${member.key}`,
        evidence: factory.evidence, operations: member.operations,
      };
    }
    return summary;
  };
  const collectAcquisitions = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) && summaryForCall(node)?.operations.some((operation) =>
      operation.kind === "acquire" && operation.subject.kind === "return")) acquisitionCalls.add(node);
    ts.forEachChild(node, collectAcquisitions);
  };
  collectAcquisitions(fn.body);
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const summary = summaryForCall(node);
      if (summary) {
          const parameters = new Map<number, string>();
          node.arguments.forEach((argument, index) => {
            const identity = resourceIdentity(argument);
            if (identity) parameters.set(index, identity);
          });
          const returnType = checker.getTypeAtLocation(node);
          const promiseLike = checker.getPropertyOfType(returnType, "then") !== undefined;
          const awaitedBinding = promiseLike ? resolveAwaitedResourceBinding(program, fn, node) : undefined;
          const instantiated = instantiateResourceCallableSummary(summary, {
            parameters,
            receiverResource: ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
              ? resourceIdentity(node.expression.expression) : undefined,
            returnResource: awaitedBinding?.id ?? returnedResourceId(node, acquisitionCalls.has(node)),
            at: node.getStart(),
          });
          const hasAcquire = instantiated.transitions.some((transition) => transition.kind === "acquire");
          const returned = hasAcquire && directlyReturned(node);
          const acquiredResource = instantiated.transitions.find((transition) => transition.kind === "acquire");
          const returnEscape = returned && acquiredResource && "resource" in acquiredResource
            ? { kind: "escape" as const, resource: acquiredResource.resource, at: node.parent.getEnd(), evidence: acquiredResource.evidence }
            : undefined;
          const effectiveTransitions = returnEscape ? [...instantiated.transitions, returnEscape] : instantiated.transitions;
          const unsupportedAsyncAcquire = hasAcquire && promiseLike && !awaitedBinding;
          if (hasAcquire && awaitedBinding && ts.isAwaitExpression(awaitedBinding.node)) {
            const declaration = awaitedBinding.node.parent;
            const symbol = ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
              ? resolvedSymbol(checker, declaration.name) : undefined;
            if (symbol) fulfilledAliases.set(symbol, awaitedBinding.id);
          }
          if (!unsupportedAsyncAcquire) for (const resource of instantiated.resources) resources.set(resource.id, resource);
          else diagnostics.push({
            code: "unresolved-resource-binding", fileName: node.getSourceFile().fileName,
            message: `async acquisition from ${summary.id} is not directly awaited; Promise-to-resource aliasing is unknown`,
            span: { start: node.getStart(), end: node.getEnd() },
          });
          if (effectiveTransitions.length > 0) {
            if (unsupportedAsyncAcquire) {
              const remaining = effectiveTransitions.filter((transition) => transition.kind !== "acquire");
              if (remaining.length > 0) sites.push({ node, transitions: remaining });
              ts.forEachChild(node, visit);
              return;
            }
            const fulfilled = awaitedBinding
              ? effectiveTransitions.filter((transition) => transition.kind === "acquire" || transition === returnEscape) : [];
            const immediate = fulfilled.length > 0
              ? effectiveTransitions.filter((transition) => transition.kind !== "acquire" && transition !== returnEscape) : effectiveTransitions;
            const siteNode = fulfilled.length > 0 ? awaitedBinding!.node : node;
            sites.push({ node: siteNode, transitions: immediate,
              ...(fulfilled.length > 0 ? { fulfillmentTransitions: fulfilled.map((transition) => ({ ...transition, at: siteNode.getStart() })) } : {}),
              ...(fulfilled.length > 0 && siteNode !== node ? { exceptionalCompletion: "throw" as const } : {}),
            });
          }
          for (const missing of instantiated.missing) diagnostics.push({
            code: "unresolved-resource-binding",
            fileName: node.getSourceFile().fileName,
            message: `cannot bind ${missing.reference.kind === "return" ? "return resource" : missing.reference.kind === "receiver" ? "receiver resource" : `parameter ${missing.reference.index}`} for ${summary.id}`,
            span: { start: node.getStart(), end: node.getEnd() },
          });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  const acquired = new Map<string, ResourceProtocolTransition["evidence"]>();
  for (const site of sites) for (const transition of [...site.transitions, ...(site.fulfillmentTransitions ?? [])]) {
    if (transition.kind === "acquire") acquired.set(transition.resource, transition.evidence);
  }
  const returnedAliasIdentity = (expression: ts.Expression): string | undefined => {
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = resourceIdentity(expression.whenTrue);
      const whenFalse = resourceIdentity(expression.whenFalse);
      return whenTrue && whenTrue === whenFalse ? whenTrue : undefined;
    }
    if (!ts.isIdentifier(expression)) return stableAggregateResourceSlot(checker, fn, expression, resourceIdentity)?.resource;
    const declaration = resolvedSymbol(checker, expression)?.valueDeclaration;
    if (declaration && ts.isBindingElement(declaration)) return resourceIdentity(expression);
    return declaration && ts.isVariableDeclaration(declaration)
      && declaration.initializer && ts.isIdentifier(declaration.initializer)
      ? resourceIdentity(expression) : undefined;
  };
  const collectReturnedResources = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const resource = returnedAliasIdentity(node.expression);
      const alreadyEscaped = resource && sites.some((site) => [...site.transitions, ...(site.fulfillmentTransitions ?? [])]
        .some((transition) => transition.kind === "escape" && transition.resource === resource
          && transition.at >= node.getStart() && transition.at <= node.getEnd()));
      if (resource && acquired.has(resource) && !alreadyEscaped) sites.push({
        node,
        transitions: [{ kind: "escape", resource, at: node.expression.getEnd(), evidence: acquired.get(resource) }],
      });
    }
    ts.forEachChild(node, collectReturnedResources);
  };
  collectReturnedResources(fn.body);
  return { resources: [...resources.values()], sites, diagnostics };
}

function auditAcquiredResourceReferences(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  inputSites: readonly ResourceTransitionSite[],
): ResourceTransitionSite[] {
  if (!fn.body) return [...inputSites];
  const checker = program.getTypeChecker();
  const allTransitions = (site: ResourceTransitionSite): readonly ResourceProtocolTransition[] =>
    [...site.transitions, ...(site.fulfillmentTransitions ?? [])];
  const acquiredBindings = new Map<ts.Symbol, string>();
  for (const site of inputSites) {
    const acquired = allTransitions(site).find((transition) => transition.kind === "acquire");
    if (!acquired || !("resource" in acquired) || !ts.isExpression(site.node)) continue;
    let current: ts.Expression = site.node;
    while ((ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)
      || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)
      || ts.isAwaitExpression(current.parent)) && current.parent.expression === current) current = current.parent;
    const declaration = current.parent;
    const symbol = ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)
      ? resolvedSymbol(checker, declaration.name) : undefined;
    if (symbol) acquiredBindings.set(symbol, acquired.resource);
  }
  if (acquiredBindings.size === 0) return [...inputSites];

  const sites = [...inputSites];
  const allowed = new Set<ts.Node>();
  const aliases = new Map(acquiredBindings);
  let changed = true;
  while (changed) {
    changed = false;
    const discover = (node: ts.Node): void => {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name))
        && ts.isVariableDeclarationList(node.parent)
        && (ts.getCombinedNodeFlags(node.parent) & ts.NodeFlags.Const) !== 0) {
        const visitBinding = (binding: ts.BindingName): void => {
          if (ts.isIdentifier(binding)) {
            const path = destructuredResourcePath(checker, binding);
            const direct = path && aggregateLiteralPathValue(path.source, path.keys);
            const indirect = path && !direct ? stableAggregatePathSlot(checker, fn, path.source, path.keys, (value) => {
              const target = unwrapResourceExpression(value);
              const symbol = ts.isIdentifier(target) ? resourceValueSymbol(checker, target) : undefined;
              return symbol ? aliases.get(symbol) : undefined;
            }) : undefined;
            const stored = direct ?? indirect?.storedExpression;
            const storedTarget = stored && unwrapResourceExpression(stored);
            const sourceSymbol = storedTarget && ts.isIdentifier(storedTarget) ? resourceValueSymbol(checker, storedTarget) : undefined;
            const targetSymbol = resourceValueSymbol(checker, binding);
            const resource = sourceSymbol ? aliases.get(sourceSymbol) : undefined;
            if (stored && resource && targetSymbol && !aliases.has(targetSymbol)) {
              aliases.set(targetSymbol, resource); allowed.add(binding); allowed.add(storedTarget!); changed = true;
            }
            return;
          }
          for (const element of binding.elements) if (ts.isBindingElement(element)) visitBinding(element.name);
        };
        visitBinding(node.name);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isVariableDeclarationList(node.parent)) {
        const flags = ts.getCombinedNodeFlags(node.parent);
        const immutable = (flags & ts.NodeFlags.Const) !== 0 || (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using;
        let initializer = node.initializer;
        while (ts.isParenthesizedExpression(initializer) || ts.isNonNullExpression(initializer)
          || ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer)) initializer = initializer.expression;
        const sourceSymbol = immutable && ts.isIdentifier(initializer) ? resolvedSymbol(checker, initializer) : undefined;
        const targetSymbol = resolvedSymbol(checker, node.name);
        const resource = sourceSymbol ? aliases.get(sourceSymbol) : undefined;
        if (resource && targetSymbol && !aliases.has(targetSymbol)) {
          aliases.set(targetSymbol, resource); allowed.add(node.name); allowed.add(initializer); changed = true;
        }
      }
      ts.forEachChild(node, discover);
    };
    discover(fn.body);
  }
  for (const symbol of acquiredBindings.keys()) for (const declaration of symbol.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration)) allowed.add(declaration.name);
  }
  const allowReturnedAggregateStorage = (node: ts.Node): void => {
    if (node !== fn.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      const slot = stableAggregateResourceSlot(checker, fn, node.expression, (value) => {
        const target = unwrapResourceExpression(value);
        const symbol = ts.isIdentifier(target) ? resourceValueSymbol(checker, target) : undefined;
        return symbol ? aliases.get(symbol) : undefined;
      });
      const hasEscape = slot && inputSites.some((site) => allTransitions(site).some((transition) =>
        transition.kind === "escape" && transition.resource === slot.resource
        && transition.at >= node.getStart() && transition.at <= node.getEnd()));
      if (slot && hasEscape) {
        const mark = (stored: ts.Node): void => {
          if (ts.isIdentifier(stored)) {
            const symbol = resourceValueSymbol(checker, stored);
            if (symbol && aliases.get(symbol) === slot.resource) allowed.add(stored);
          }
          ts.forEachChild(stored, mark);
        };
        mark(slot.storedExpression);
      }
    }
    ts.forEachChild(node, allowReturnedAggregateStorage);
  };
  allowReturnedAggregateStorage(fn.body);
  for (const site of inputSites) if (ts.isCallExpression(site.node) || ts.isNewExpression(site.node)) {
    const resourcesAtSite = new Set(allTransitions(site).flatMap((transition) => "resource" in transition ? [transition.resource] : []));
    const candidates: ts.Expression[] = [...(site.node.arguments ?? [])];
    if (ts.isCallExpression(site.node)
      && (ts.isPropertyAccessExpression(site.node.expression) || ts.isElementAccessExpression(site.node.expression))) {
      candidates.push(site.node.expression.expression);
    }
    for (const candidate of candidates) {
      let base = candidate;
      while (ts.isParenthesizedExpression(base) || ts.isNonNullExpression(base)
        || ts.isAsExpression(base) || ts.isTypeAssertionExpression(base)) base = base.expression;
      const candidateSymbol = ts.isIdentifier(base) ? resolvedSymbol(checker, base) : undefined;
      const resource = candidateSymbol ? aliases.get(candidateSymbol) ?? resourceArgumentId(checker, candidate) : resourceArgumentId(checker, candidate);
      if (!resource || !resourcesAtSite.has(resource)) continue;
      const mark = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const symbol = resourceValueSymbol(checker, node);
          if (symbol && aliases.has(symbol)) allowed.add(node);
        }
        ts.forEachChild(node, mark);
      };
      mark(candidate);
    }
  }
  const audit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const symbol = resourceValueSymbol(checker, node);
      const resource = symbol ? aliases.get(symbol) : undefined;
      if (resource && !allowed.has(node)) {
        let expression: ts.Expression = node;
        while ((ts.isParenthesizedExpression(expression.parent) || ts.isNonNullExpression(expression.parent)
          || ts.isAsExpression(expression.parent) || ts.isTypeAssertionExpression(expression.parent))
          && expression.parent.expression === expression) expression = expression.parent;
        const returned = ts.isReturnStatement(expression.parent) && expression.parent.expression === expression
          ? expression.parent : undefined;
        const alreadyEscaped = returned && inputSites.some((site) => allTransitions(site).some((transition) =>
          transition.kind === "escape" && transition.resource === resource
          && transition.at >= returned.getStart() && transition.at <= returned.getEnd()));
        if (!alreadyEscaped) sites.push(returned
          ? { node: returned, transitions: [{ kind: "escape", resource, at: returned.getStart(), evidence: "exact" }] }
          : { node, transitions: [{ kind: "escape", resource, at: node.getStart(), evidence: "unknown", conditional: true }] });
        allowed.add(node);
      }
    }
    ts.forEachChild(node, audit);
  };
  audit(fn.body);
  return sites;
}

function lifecycleOwner(fn: ts.FunctionLikeDeclaration): string {
  if ("name" in fn && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : "<anonymous>";
}

function isFunctionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !!node.body;
}

function acceptedTerminal(resource: ResourceProtocolResource, state: ResourceProtocolState): boolean {
  return !resource.requiredTerminalStates?.length
    || state === "absent-or-released" && resource.requiredTerminalStates.includes("released")
    || resource.requiredTerminalStates.includes(state as never);
}

function lexicalScopeEnd(node: ts.Node): number {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseBlock(current)) return current.getEnd();
  }
  return node.getEnd();
}

/** Checks same-function user-declared lifecycle composition through the shared CFG. */
export function analyzeResourceLifecyclesInSource(
  program: ts.Program,
  source: ts.SourceFile,
  analysis: ResourceCallableSummaryAnalysis = analyzeResourceCallableSummaries(program),
  sourceValid = true,
): ResourceLifecycleProgramAnalysis {
  const evidence: ResourceLifecycleEvidence[] = [];
  const diagnostics: ResourceLifecycleDiagnostic[] = analysis.diagnostics
    .filter((diagnostic) => diagnostic.fileName === source.fileName)
    .map((diagnostic) => ({
      kind: "invalid-contract", fileName: diagnostic.fileName, functionName: "<annotation>", span: diagnostic.span,
      resource: "<contract>", state: "unknown", message: diagnostic.message,
    }));
  const visit = (node: ts.Node): void => {
    if (isFunctionWithBody(node)) {
      const declared = collectResourceCallableTransitionSites(program, node, analysis.summaries);
      const builtin = collectBuiltinResourceTransitionSites(program, node);
      const resourceSites = [...declared.sites, ...builtin.sites];
      const sites = auditAcquiredResourceReferences(program, node, [
        ...resourceSites,
        ...collectAwaitedRejectionTransitionSites(program, node, resourceSites),
      ]);
      const collected = {
        resources: [...new Map([...declared.resources, ...builtin.resources].map((resource) => [resource.id, resource] as const)).values()],
        sites,
        diagnostics: declared.diagnostics,
      };
      const declaredIds = new Set(declared.resources.map((resource) => resource.id));
      const builtinIds = new Set(builtin.resources.map((resource) => resource.id));
      const authorityFor = (id: string): ResourceLifecycleEvidence["authority"] => declaredIds.has(id) && builtinIds.has(id)
        ? "mixed" : builtinIds.has(id) ? "builtin-catalog" : "callable-contract";
      for (const diagnostic of collected.diagnostics) diagnostics.push({
        kind: "unknown-analysis", fileName: diagnostic.fileName, functionName: lifecycleOwner(node), span: diagnostic.span,
        resource: "<binding>", state: "unknown", message: diagnostic.message,
      });
      for (const unknown of builtin.unknown) diagnostics.push({
        kind: "unknown-analysis", fileName: source.fileName, functionName: lifecycleOwner(node),
        span: { start: unknown.node.getStart(source), end: unknown.node.getEnd() },
        resource: "<builtin>", state: "unknown", message: unknown.reason,
      });
      if (collected.resources.length > 0) {
        const allSiteTransitions = (site: ResourceTransitionSite): readonly ResourceProtocolTransition[] =>
          [...site.transitions, ...(site.fulfillmentTransitions ?? [])];
        if (!sourceValid) diagnostics.push({
          kind: "unknown-analysis", fileName: source.fileName, functionName: lifecycleOwner(node),
          span: { start: node.getStart(source), end: node.getEnd() }, resource: "<typescript>", state: "unknown",
          message: "TypeScript diagnostics invalidate source-level resource lifecycle evidence",
        });
        const lexicalDisposals = collected.sites.flatMap((site) => {
          if (!ts.isCallExpression(site.node)) return [];
          const declaration = resultDeclaration(site.node);
          if (!declaration || !ts.isVariableDeclarationList(declaration.parent)) return [];
          const flags = ts.getCombinedNodeFlags(declaration.parent);
          if ((flags & ts.NodeFlags.Using) !== ts.NodeFlags.Using) return [];
          return allSiteTransitions(site).flatMap((transition) => transition.kind === "acquire" ? [{
            declaration,
            transition: { kind: "release" as const, resource: transition.resource,
              at: lexicalScopeEnd(declaration), evidence: transition.evidence },
          }] : []);
        });
        const lowered = lowerResourceProtocolCfgInFunction(source, node, {
          schema: "uneffect-resource-protocol/v1", resources: collected.resources, transitions: [],
        }, collected.sites, { lexicalDisposals });
        if (lowered.status === "unknown") {
          const span = { start: node.getStart(source), end: node.getEnd() };
          diagnostics.push({ kind: "unknown-analysis", fileName: source.fileName, functionName: lifecycleOwner(node), span,
            resource: "<cfg>", state: "unknown", message: `resource CFG is unknown: ${lowered.reason}` });
          for (const resource of collected.resources) evidence.push({
            fileName: source.fileName, owner: lifecycleOwner(node), resource: resource.label, kind: resource.kind,
            span, status: "unknown", evidence: "unknown", authority: authorityFor(resource.id), state: "unknown", transitions: collected.sites.flatMap(allSiteTransitions),
          });
        } else {
          const evaluated = evaluateResourceProtocolCfg(lowered.cfg);
          const transitions = [...collected.sites.flatMap(allSiteTransitions), ...lexicalDisposals.map(({ transition }) => transition)];
          const trust = !sourceValid || transitions.some((transition) => transition.evidence === "unknown") ? "unknown" as const
            : transitions.some((transition) => transition.evidence === "trusted") ? "trusted" as const : "verified" as const;
          for (const resource of collected.resources) {
            const state = evaluated.states.get(resource.id) ?? "unknown";
            const status = !sourceValid || evaluated.status === "unknown" ? "unknown" as const
              : acceptedTerminal(resource, state) ? "satisfied" as const : "unsatisfied" as const;
            evidence.push({ fileName: source.fileName, owner: lifecycleOwner(node), resource: resource.label,
              kind: resource.kind, span: { start: node.getStart(source), end: node.getEnd() }, status, evidence: trust,
              authority: authorityFor(resource.id), state, transitions });
            if (status === "unsatisfied") {
              const acquisition = transitions.find((transition) => "resource" in transition && transition.resource === resource.id && transition.kind === "acquire");
              const start = acquisition?.at ?? node.getStart(source);
              diagnostics.push({ kind: "unclosed", fileName: source.fileName, functionName: lifecycleOwner(node),
                span: { start, end: start }, resource: resource.label, state,
                message: `${resource.label} does not reach an accepted terminal state (found ${state})` });
            }
          }
          for (const diagnostic of evaluated.diagnostics) diagnostics.push({
            kind: diagnostic.code === "invalid-transition" ? "invalid-transition" : "unknown-analysis",
            fileName: source.fileName, functionName: lifecycleOwner(node),
            span: { start: diagnostic.at ?? node.getStart(source), end: diagnostic.at ?? node.getStart(source) },
            resource: diagnostic.resource, state: diagnostic.state, message: diagnostic.message,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { evidence, diagnostics };
}

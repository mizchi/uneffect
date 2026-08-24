import ts from "typescript";
import { extractAnnotations } from "./annotations.js";
import type { DiagnosticNote } from "./diagnostics.js";
import { effectPermits, formatEffect, isKnownEffect, parseEffectExpression, splitTopLevel, type Effect } from "./capabilities.js";
import { TypeScriptFrontendAdapter, type FrontendSymbolAdapter } from "./frontend-adapter.js";
import type { FsBuiltinOperation } from "./builtin-contracts.js";
import { buildProgramCallGraph, type CallGraphEdge } from "./call-graph.js";
import { resolveDisposalProtocol } from "./disposal-symbols.js";
import { analyzePromiseChainsInProgram, type PromiseChainModel } from "./promise-chains.js";

export interface EffectDiagnostic {
  fileName: string;
  functionName: string;
  effect: string;
  kind: "missing" | "unused" | "unknown";
  severity: "error" | "warning";
  line: number;
  message: string;
  notes?: DiagnosticNote[];
}
export type EvidenceStatus = "verified" | "trusted" | "inferred" | "unknown";
export interface EffectSummary {
  functionName: string;
  effects: Effect[];
  evidence: EvidenceStatus;
  /** Present on summaries produced from a Program; omitted by low-level manual summary helpers. */
  id?: string;
  fileName?: string;
  span?: { start: number; end: number };
}
export interface EffectAnalysisResult { diagnostics: EffectDiagnostic[]; summaries: EffectSummary[] }

/** Where an effect is produced directly, so a report can quote the operation instead of only naming it. */
interface EffectWitness { fileName: string; line: number; text: string }
/** How an effect reached a caller: which call edge carried it, and under which name in the callee. */
interface EffectPropagation { callee: string; calleeEffect: string; fileName: string; line: number }

interface CallEdge { target: string; arguments: string[]; dischargesThrow: boolean }
interface FunctionInfo {
  name: string;
  node: ts.FunctionDeclaration;
  parameters: string[];
  declared: Effect[];
  direct: Effect[];
  calls: CallEdge[];
  locals: Set<string>;
}


function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/** Same effect constructor, different arguments: an authority mismatch rather than an undeclared effect. */
function sameConstructor(left: Effect, right: Effect): boolean {
  if (left.kind !== right.kind || formatEffect(left) === formatEffect(right)) return false;
  if (left.kind === "capability" && right.kind === "capability") return left.name === right.name;
  return left.kind === "throw";
}

function snippet(node: ts.Node, source: ts.SourceFile): string {
  const text = node.getText(source).split(/\r?\n/u)[0]!.trim();
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function leadingText(source: ts.SourceFile, node: ts.Node): string {
  return source.text.slice(node.getFullStart(), node.getStart(source));
}

function declaration(source: ts.SourceFile, node: ts.Node): Effect[] {
  const owner = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isVariableDeclarationList(node.parent.parent) && ts.isVariableStatement(node.parent.parent.parent)
    ? node.parent.parent.parent : node;
  const text = leadingText(source, owner);
  return extractAnnotations(text, "effect").flatMap((value) => splitTopLevel(value, "|")).map(parseEffectExpression);
}

function mutationRegion(expression: ts.Expression): string {
  if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return expression.expression.getText();
  return expression.getText();
}
function mutateEffect(expression: ts.Expression): Effect {
  return { kind: "mutate", region: mutationRegion(expression) };
}

function localBindings(scope: ts.FunctionLikeDeclaration): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== scope && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  if (scope.body) visit(scope.body);
  return names;
}
function observableMutation(effect: Effect, locals: ReadonlySet<string>): boolean {
  if (effect.kind !== "mutate") return true;
  const root = /^[A-Za-z_$][\w$]*/.exec(effect.region)?.[0];
  return root !== undefined && !locals.has(root);
}

function capability(name: string): Effect { return parseEffectExpression(name); }

function addEffect(target: Effect[], effect: Effect): void {
  if (!target.some((item) => formatEffect(item) === formatEffect(effect))) target.push(effect);
}

function effectsForBuiltinOperation(operation: FsBuiltinOperation, call: ts.CallExpression): Effect[] {
  const pathEffect = (name: "FsRead" | "FsWrite", index: number | undefined): Effect => {
    const path = index === undefined ? undefined : call.arguments[index];
    const literal = path && ts.isStringLiteralLike(path) ? JSON.stringify(path.text) : undefined;
    return capability(literal ? `${name}<${literal}>` : name);
  };
  const effects: Effect[] = [];
  if (operation.read) effects.push(pathEffect("FsRead", operation.readPathArgument));
  if (operation.write) effects.push(pathEffect("FsWrite", operation.writePathArgument));
  if (operation.mutateArgument !== undefined && call.arguments[operation.mutateArgument]) effects.push(mutateEffect(call.arguments[operation.mutateArgument]!));
  return effects;
}

function primitiveEffects(call: ts.CallExpression, adapter: FrontendSymbolAdapter): Effect[] {
  const resolved = adapter?.resolveCall(call);
  if (resolved?.operation?.kind === "fs") return effectsForBuiltinOperation(resolved.operation, call);
  if (resolved?.operation?.kind === "fetch") return effectsForFetch(call);
  if (resolved?.operation?.kind === "timer") return [capability("Timer")];
  if (resolved?.operation?.kind === "timer-clear") return resolved.operation.effect ? [capability(resolved.operation.effect)] : [];
  if (resolved?.operation?.kind === "abort-timeout") return [capability("Timer")];
  if (resolved?.operation?.kind === "abort-static" || resolved?.operation?.kind === "abort-any") return [];
  if (resolved?.operation?.kind === "deferred-callback") {
    if (!resolved.operation.effect) return [];
    const scope = resolved.operation.effectScopeArgument === undefined ? undefined : call.arguments[resolved.operation.effectScopeArgument];
    let literalScope = scope && ts.isStringLiteralLike(scope) ? scope.text : undefined;
    if (resolved.operation.effectScopeKind === "net-connect" && scope) {
      if (ts.isObjectLiteralExpression(scope)) {
        const value = (name: string): ts.Expression | undefined => {
          const property = scope.properties.find((candidate) => ts.isPropertyAssignment(candidate)
            && !ts.isComputedPropertyName(candidate.name) && candidate.name.getText().replace(/^['"]|['"]$/g, "") === name);
          return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
        };
        const host = value("host"), port = value("port");
        if (host && ts.isStringLiteralLike(host) && port && ts.isNumericLiteral(port)) literalScope = `${host.text}:${port.text}`;
      } else if (ts.isNumericLiteral(scope)) {
        const host = call.arguments[resolved.operation.effectScopeArgument! + 1];
        if (host && ts.isStringLiteralLike(host)) literalScope = `${host.text}:${scope.text}`;
      }
    }
    if (resolved.operation.effectScopeKind === "http-request" && scope) {
      if (ts.isStringLiteralLike(scope)) {
        try {
          const url = new URL(scope.text);
          const port = url.port || String(resolved.operation.effectDefaultPort ?? (url.protocol === "https:" ? 443 : 80));
          literalScope = `${url.hostname}:${port}`;
        } catch { literalScope = undefined; }
      } else if (ts.isObjectLiteralExpression(scope)) {
        const value = (name: string): ts.Expression | undefined => {
          const property = scope.properties.find((candidate) => ts.isPropertyAssignment(candidate)
            && !ts.isComputedPropertyName(candidate.name) && candidate.name.getText().replace(/^['"]|['"]$/g, "") === name);
          return property && ts.isPropertyAssignment(property) ? property.initializer : undefined;
        };
        const host = value("hostname") ?? value("host"), port = value("port");
        const hostText = host && ts.isStringLiteralLike(host) ? host.text : undefined;
        const portText = port && (ts.isStringLiteralLike(port) || ts.isNumericLiteral(port))
          ? port.text : resolved.operation.effectDefaultPort === undefined ? undefined : String(resolved.operation.effectDefaultPort);
        if (hostText && portText) literalScope = `${hostText}:${portText}`;
      }
    }
    return [capability(literalScope ? `${resolved.operation.effect}<${JSON.stringify(literalScope)}>` : resolved.operation.effect)];
  }
  if (resolved?.operation?.kind === "scoped-effect") {
    const scope = resolved.operation.effectScopeArgument === undefined ? undefined : call.arguments[resolved.operation.effectScopeArgument];
    const literal = scope && ts.isStringLiteralLike(scope) ? scope.text : undefined;
    return [capability(literal ? `${resolved.operation.effect}<${JSON.stringify(literal)}>` : resolved.operation.effect)];
  }
  if (resolved?.operation?.kind === "scheduler-post-task" || resolved?.operation?.kind === "scheduler-yield") return [capability("Timer")];
  if (resolved?.operation?.kind === "promise-combinator") {
    const staticallySafeArray = (expression: ts.Expression): boolean => {
      while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
      return ts.isArrayLiteralExpression(expression) && expression.elements.every((element) => !ts.isSpreadElement(element) || staticallySafeArray(element.expression));
    };
    const iterable = call.arguments[resolved.operation.iterableArgument];
    return iterable && staticallySafeArray(iterable) ? [] : [capability("InvokeUserCode")];
  }
  if (resolved?.operation?.kind === "effect") return [capability(resolved.operation.effect)];
  if (resolved?.operation?.kind === "mutation" && ts.isPropertyAccessExpression(call.expression)) return [mutateEffect(call.expression.expression)];
  if (resolved?.operation?.kind === "clone") {
    const value = call.arguments[resolved.operation.valueArgument];
    const effects: Effect[] = value ? [capability(`Clone<typeof ${value.getText()}>`)] : [];
    if (value && adapter.ownershipKind(value) === "shared") effects.push(capability(`SharedMemory<typeof ${value.getText()}>`));
    const transfer = call.arguments[resolved.operation.transferArgument];
    const list = transfer && ts.isArrayLiteralExpression(transfer) ? transfer
      : transfer && ts.isObjectLiteralExpression(transfer) ? transfer.properties.flatMap((property) => ts.isPropertyAssignment(property)
        && property.name.getText().replaceAll(/["']/g, "") === "transfer" && ts.isArrayLiteralExpression(property.initializer) ? [property.initializer] : [])[0]
      : undefined;
    for (const item of list?.elements ?? []) {
      if (!ts.isExpression(item)) continue;
      const kind = adapter.ownershipKind(item);
      effects.push(capability(`${kind === "shared" ? "SharedMemory" : "Transfer"}<typeof ${item.getText()}>`));
    }
    return effects;
  }
  if (resolved?.operation?.kind === "dom" && ts.isPropertyAccessExpression(call.expression)) {
    const receiver = call.expression.expression;
    const effects: Effect[] = [capability(`Dom<${resolved.operation.operation}, typeof ${receiver.getText()}>`)];
    if (resolved.operation.mutatesReceiver) effects.push(mutateEffect(receiver));
    for (const index of resolved.operation.mutatesArguments ?? []) if (call.arguments[index]) effects.push(mutateEffect(call.arguments[index]!));
    if (resolved.operation.invokesUserCode) effects.push(capability("InvokeUserCode"));
    return effects;
  }
  return [];
}

function fetchMethod(call: ts.CallExpression): string | undefined {
  const init = call.arguments[1];
  if (!init) return "GET";
  if (!ts.isObjectLiteralExpression(init)) return undefined;
  const property = init.properties.find((item) =>
    (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item))
      && ((ts.isIdentifier(item.name) && item.name.text === "method") || (ts.isStringLiteral(item.name) && item.name.text === "method"))
  );
  if (!property) return init.properties.some(ts.isSpreadAssignment) ? undefined : "GET";
  return ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
    ? property.initializer.text.toUpperCase()
    : undefined;
}

function fetchUrl(call: ts.CallExpression): string | undefined {
  const input = call.arguments[0];
  if (input && ts.isStringLiteralLike(input)) return input.text;
  if (input && ts.isNoSubstitutionTemplateLiteral(input)) return input.text;
  if (input && ts.isTemplateExpression(input)) {
    let value = input.head.text;
    for (const span of input.templateSpans) {
      if (ts.isNumericLiteral(span.expression)) value += span.expression.text;
      else if (ts.isAsExpression(span.expression) && span.expression.type.kind === ts.SyntaxKind.NumberKeyword) value += "*";
      else return undefined;
      value += span.literal.text;
    }
    try {
      const parsed = new URL(value);
      if (parsed.hostname.includes("*")) return undefined;
      return value;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function netAuthority(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return `${parsed.hostname.toLowerCase()}:${port}`;
  } catch {
    return undefined;
  }
}

function effectsForFetch(call: ts.CallExpression): Effect[] {
  const method = fetchMethod(call), url = fetchUrl(call);
  const authority = url ? netAuthority(url) : undefined;
  const fetch = `Fetch<${method ?? "Unknown<dynamic-method>"}, ${url && authority ? JSON.stringify(url) : "Unknown<dynamic-url>"}>`;
  return [capability(fetch), capability(`Net<${authority ? JSON.stringify(authority) : "Unknown<dynamic-origin>"}>`)];
}

function substitute(effect: Effect, callee: FunctionInfo, edge: CallEdge): Effect {
  if (effect.kind !== "mutate") return effect;
  const region = effect.region;
  for (let index = 0; index < callee.parameters.length; index++) {
    const parameter = callee.parameters[index]!;
    if (region === parameter || region.startsWith(`${parameter}.`) || region.startsWith(`${parameter}[`)) {
      const argument = edge.arguments[index];
      return argument ? { kind: "mutate", region: `${argument}${region.slice(parameter.length)}` } : effect;
    }
  }
  return effect;
}

function permits(declared: Effect[], actual: Effect): boolean {
  return declared.some((allowed) => effectPermits(allowed, actual));
}

export interface EffectAnalysisOptions { mode?: "gradual" | "strict"; requireAnnotations?: boolean }

function mayAssimilateUserCode(model: PromiseChainModel | undefined, node: ts.FunctionLikeDeclaration): boolean {
  if (!model || !node.body) return false;
  const start = node.body.getStart(node.getSourceFile()), end = node.body.getEnd();
  return model.executors.some((executor) => executor.adoptedThenable !== undefined && executor.span.start >= start && executor.span.end <= end);
}

function isAsyncFunction(node: ts.FunctionLikeDeclaration): boolean {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0;
}

function analyzeSource(source: ts.SourceFile, options: EffectAnalysisOptions, adapter: FrontendSymbolAdapter, checker?: ts.TypeChecker, promiseModel?: PromiseChainModel): EffectAnalysisResult {
  const fileName = source.fileName;
  const functions = new Map<string, FunctionInfo>();
  const processEnvBase = (node: ts.Expression): boolean => {
    if (!checker || !ts.isPropertyAccessExpression(node) || node.name.text !== "env") return false;
    const property = checker.getSymbolAtLocation(node.name);
    return property?.declarations?.some((item) => ts.isPropertySignature(item)
      && ts.isInterfaceDeclaration(item.parent) && item.parent.name.text === "Process"
      && item.getSourceFile().isDeclarationFile) ?? false;
  };
  const processEnvAccess = (node: ts.Expression): Effect[] | undefined => {
    if (!checker || (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))
      || !processEnvBase(node.expression)) return undefined;
    if (ts.isPropertyAccessExpression(node)) return [capability(`Env<${JSON.stringify(node.name.text)}>` )];
    const key = node.argumentExpression;
    if (!key) return [capability("Env")];
    if (ts.isStringLiteralLike(key)) return [capability(`Env<${JSON.stringify(key.text)}>` )];
    const type = checker.getTypeAtLocation(key), members = type.isUnion() ? type.types : [type];
    const names = members.flatMap((member) => (member.flags & ts.TypeFlags.StringLiteral) !== 0
      ? [(member as ts.StringLiteralType).value] : []);
    return names.length === members.length
      ? [...new Set(names)].map((name) => capability(`Env<${JSON.stringify(name)}>`))
      : [capability("Env")];
  };
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, {
      name: node.name.text,
      node,
      parameters: node.parameters.map((p) => ts.isIdentifier(p.name) ? p.name.text : p.name.getText()),
      declared: declaration(source, node),
      direct: [],
      calls: [],
      locals: localBindings(node),
    });
  });
  for (const info of functions.values()) {
    const asyncOwner = isAsyncFunction(info.node);
    const generatorBindings = new Map<string, string[]>();
    const generatorTarget = (call: ts.CallExpression): string | undefined =>
      ts.isIdentifier(call.expression) && functions.get(call.expression.text)?.node.asteriskToken
        ? call.expression.text : undefined;
    type ReturnFlow = { expressions: ts.Expression[]; definite: boolean };
    const returnedGeneratorTargets = (name: string, seen = new Set<string>()): string[] | undefined => {
      if (seen.has(name)) return undefined;
      const target = functions.get(name);
      if (!target || isAsyncFunction(target.node)) return undefined;
      if (target.node.asteriskToken) return [name];
      const statementFlow = (statement: ts.Statement): ReturnFlow | undefined => {
        if (ts.isReturnStatement(statement)) return { expressions: statement.expression ? [statement.expression] : [], definite: true };
        if (ts.isThrowStatement(statement)) return { expressions: [], definite: true };
        if (ts.isBlock(statement)) return blockFlow(statement);
        if (ts.isIfStatement(statement)) {
          const left = statementFlow(statement.thenStatement);
          const right = statement.elseStatement ? statementFlow(statement.elseStatement) : { expressions: [], definite: false };
          return left && right ? { expressions: [...left.expressions, ...right.expressions], definite: left.definite && right.definite } : undefined;
        }
        return ts.isExpressionStatement(statement) || ts.isVariableStatement(statement) || ts.isEmptyStatement(statement)
          ? { expressions: [], definite: false } : undefined;
      };
      const blockFlow = (block: ts.Block): ReturnFlow | undefined => {
        const expressions: ts.Expression[] = [];
        for (const statement of block.statements) {
          const flow = statementFlow(statement);
          if (!flow) return undefined;
          expressions.push(...flow.expressions);
          if (flow.definite) return { expressions, definite: true };
        }
        return { expressions, definite: false };
      };
      const flow = target.node.body && blockFlow(target.node.body);
      if (!flow?.definite || flow.expressions.length === 0) return undefined;
      const nextSeen = new Set(seen).add(name), candidates: string[] = [];
      for (const expression of flow.expressions) {
        const resolveExpression = (value: ts.Expression): string[] | undefined => {
          if (ts.isParenthesizedExpression(value) || ts.isAsExpression(value)
            || ts.isTypeAssertionExpression(value) || ts.isNonNullExpression(value)) return resolveExpression(value.expression);
          if (ts.isConditionalExpression(value)) {
            const left = resolveExpression(value.whenTrue), right = resolveExpression(value.whenFalse);
            return left && right ? [...left, ...right] : undefined;
          }
          return ts.isCallExpression(value) && ts.isIdentifier(value.expression)
            ? returnedGeneratorTargets(value.expression.text, nextSeen) : undefined;
        };
        const resolved = resolveExpression(expression);
        if (!resolved) return undefined;
        candidates.push(...resolved);
      }
      return [...new Set(candidates)];
    };
    const addGeneratorConsumption = (target: string, dischargesThrow: boolean): void => {
      info.calls.push({ target, arguments: [], dischargesThrow });
    };
    if (mayAssimilateUserCode(promiseModel, info.node)) addEffect(info.direct, capability("InvokeUserCode"));
    const visit = (node: ts.Node, dischargesThrow: boolean, deferredBoundary = false): void => {
      if (node !== info.node && ts.isFunctionLike(node)) return;
      if (ts.isTryStatement(node)) {
        visit(node.tryBlock, dischargesThrow || node.catchClause !== undefined, deferredBoundary);
        if (node.catchClause) visit(node.catchClause.block, dischargesThrow, deferredBoundary);
        if (node.finallyBlock) visit(node.finallyBlock, dischargesThrow, deferredBoundary);
        return;
      }
      if (ts.isThrowStatement(node) && !dischargesThrow && !asyncOwner && !deferredBoundary) addEffect(info.direct, { kind: "throw", errorType: adapter.thrownErrorType(node.expression) });
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const direct = generatorTarget(node.initializer);
        const targets = direct ? [direct]
          : ts.isIdentifier(node.initializer.expression) ? returnedGeneratorTargets(node.initializer.expression.text) : undefined;
        if (targets) generatorBindings.set(node.name.text, targets);
      }
      if (ts.isForOfStatement(node) && ts.isIdentifier(node.expression)) {
        for (const target of generatorBindings.get(node.expression.text) ?? []) addGeneratorConsumption(target, dischargesThrow);
      }
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression && ts.isIdentifier(node.expression)) {
        for (const target of generatorBindings.get(node.expression.text) ?? []) addGeneratorConsumption(target, dischargesThrow);
      }
      if (checker && ts.isVariableStatement(node)) {
        const flags = ts.getCombinedNodeFlags(node.declarationList);
        if ((flags & ts.NodeFlags.Using) === ts.NodeFlags.Using) for (const resource of node.declarationList.declarations) {
          if (!resource.initializer) continue;
          const asynchronous = (flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing;
          const { asyncSymbol: asyncDispose, syncSymbol: syncDispose } = resolveDisposalProtocol(checker, resource.initializer);
          for (const disposal of (asynchronous ? asyncDispose ?? syncDispose : syncDispose)?.declarations ?? []) for (const effect of declaration(disposal.getSourceFile(), disposal)) {
            if (effect.kind !== "throw" || (!dischargesThrow && !asyncOwner)) addEffect(info.direct, effect);
          }
        }
      }
      if (adapter.mayInvokeUserCode(node)) addEffect(info.direct, capability("InvokeUserCode"));
      if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))) {
        for (const effect of processEnvAccess(node) ?? []) addEffect(info.direct, effect);
        if (processEnvBase(node)
          && !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node)) {
          addEffect(info.direct, capability("Env"));
        }
      }
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        && processEnvAccess(node.left) === undefined) { const effect = mutateEffect(node.left); if (observableMutation(effect, info.locals)) addEffect(info.direct, effect); }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) && (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))) { const effect = mutateEffect(node.operand); if (observableMutation(effect, info.locals)) addEffect(info.direct, effect); }
      if (ts.isCallExpression(node)) {
        const builtinOperation = adapter.resolveCall(node)?.operation;
        for (const effect of primitiveEffects(node, adapter)) if (observableMutation(effect, info.locals)) addEffect(info.direct, effect);
        const callbackIndex = builtinOperation?.kind === "timer" ? builtinOperation.callbackArgument
          : builtinOperation?.kind === "scheduler-post-task" ? builtinOperation.callbackArgument
          : builtinOperation?.kind === "fs" && builtinOperation.callbackArgumentFromEnd
            ? node.arguments.length - builtinOperation.callbackArgumentFromEnd
            : builtinOperation?.kind === "deferred-callback"
              ? node.arguments.length - builtinOperation.callbackArgumentFromEnd : undefined;
        const callback = callbackIndex === undefined ? undefined : node.arguments[callbackIndex];
        if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
          visit(callback.body, false, true);
        } else if (callback && ts.isIdentifier(callback) && functions.has(callback.text)) {
          info.calls.push({ target: callback.text, arguments: [], dischargesThrow: true });
        }
        const directGenerator = generatorTarget(node);
        const parent = node.parent;
        const consumed = (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "next"
              && ts.isCallExpression(parent.parent) && parent.parent.expression === parent)
            || (ts.isForOfStatement(parent) && parent.expression === node)
            || (ts.isYieldExpression(parent) && parent.asteriskToken !== undefined && parent.expression === node);
        if (directGenerator) {
          if (consumed) addGeneratorConsumption(directGenerator, dischargesThrow);
        } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "next"
          && ts.isIdentifier(node.expression.expression)) {
          for (const target of generatorBindings.get(node.expression.expression.text) ?? []) addGeneratorConsumption(target, dischargesThrow);
        } else if (ts.isIdentifier(node.expression) && functions.has(node.expression.text)) {
          info.calls.push({ target: node.expression.text, arguments: node.arguments.map((arg) => arg.getText()), dischargesThrow });
          const returnedGenerators = consumed ? returnedGeneratorTargets(node.expression.text) : undefined;
          for (const target of returnedGenerators ?? []) addGeneratorConsumption(target, dischargesThrow);
        }
      }
      ts.forEachChild(node, (child) => visit(child, dischargesThrow, deferredBoundary));
    };
    visit(info.node.body!, false);
  }
  const inferred = new Map([...functions].map(([name, info]) => [name, [...info.direct]]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const info of functions.values()) for (const edge of info.calls) {
      const callee = functions.get(edge.target)!;
      for (const rawEffect of inferred.get(edge.target) ?? []) {
        if (rawEffect.kind === "throw" && isAsyncFunction(info.node)) continue;
        if (edge.dischargesThrow && rawEffect.kind === "throw") continue;
        const effect = substitute(rawEffect, callee, edge), own = inferred.get(info.name)!;
        if (!own.some((item) => formatEffect(item) === formatEffect(effect))) { own.push(effect); changed = true; }
      }
    }
  }
  const diagnostics: EffectDiagnostic[] = [];
  for (const info of functions.values()) {
    const line = source.getLineAndCharacterOfPosition(info.node.getStart(source)).line + 1;
    const actual = inferred.get(info.name)!;
    for (const effect of info.declared) if (!isKnownEffect(effect)) diagnostics.push({
      fileName, functionName: info.name, effect: formatEffect(effect), kind: "unknown",
      severity: options.mode === "strict" ? "error" : "warning", line,
      message: `${info.name} declares unknown effect ${formatEffect(effect)}`,
    });
    for (const effect of actual) if (!permits(info.declared, effect) && (info.declared.length > 0 || options.requireAnnotations !== false)) diagnostics.push({
      fileName, functionName: info.name, effect: formatEffect(effect), kind: "missing", severity: "error", line,
      message: `${info.name} requires /* uneffect: effect ${formatEffect(effect)} */`,
    });
    for (const effect of info.declared) if (![...actual].some((item) => permits([effect], item))) diagnostics.push({
      fileName, functionName: info.name, effect: formatEffect(effect), kind: "unused", severity: "warning", line,
      message: `${info.name} declares unused effect ${formatEffect(effect)}`,
    });
  }
  const summaries = [...functions.values()].map((info): EffectSummary => {
    const effects = inferred.get(info.name)!;
    const own = diagnostics.filter((diagnostic) => diagnostic.functionName === info.name);
    const evidence: EvidenceStatus = info.declared.length === 0 ? "inferred" : own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified";
    return { functionName: info.name, effects, evidence };
  });
  return { diagnostics, summaries };
}

export function analyzeEffects(fileName: string, text: string, options: EffectAnalysisOptions = {}): EffectDiagnostic[] {
  const compilerOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true };
  const host = ts.createCompilerHost(compilerOptions);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fileName
    ? ts.createSourceFile(fileName, text, languageVersion, true, ts.ScriptKind.TS)
    : original(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([fileName], compilerOptions, host);
  const source = program.getSourceFile(fileName)!;
  return analyzeSource(source, options, new TypeScriptFrontendAdapter(program), program.getTypeChecker(), analyzePromiseChainsInProgram(program, source)).diagnostics;
}

export function analyzeEffectsInProgram(program: ts.Program, source: ts.SourceFile, options: EffectAnalysisOptions = {}): EffectDiagnostic[] {
  return analyzeSource(source, options, new TypeScriptFrontendAdapter(program), program.getTypeChecker(), analyzePromiseChainsInProgram(program, source)).diagnostics;
}

export function analyzeEffectSummariesInProgram(program: ts.Program, source: ts.SourceFile, options: EffectAnalysisOptions = {}): EffectAnalysisResult {
  return analyzeSource(source, options, new TypeScriptFrontendAdapter(program), program.getTypeChecker(), analyzePromiseChainsInProgram(program, source));
}

function callableNodes(program: ts.Program): Map<string, ts.FunctionLikeDeclaration> {
  const values = new Map<string, ts.FunctionLikeDeclaration>();
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) values.set(`${source.fileName}:${node.getStart(source)}`, node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return values;
}

/** Program-wide path used by the CLI/native frontend: all edges come from TypeChecker identities. */
export function analyzeProgramEffects(program: ts.Program, options: EffectAnalysisOptions = {}): EffectAnalysisResult {
  const graph = buildProgramCallGraph(program), nodes = callableNodes(program), adapter = new TypeScriptFrontendAdapter(program), checker = program.getTypeChecker();
  const promiseModels = new Map<ts.SourceFile, PromiseChainModel>();
  const implicitDisposalEdges: CallGraphEdge[] = [];
  const direct = new Map<string, Effect[]>(), declared = new Map<string, Effect[]>(), parameters = new Map<string, string[]>(), localsById = new Map<string, Set<string>>(), asyncOwners = new Set<string>();
  const witnesses = new Map<string, Map<string, EffectWitness>>(), propagation = new Map<string, Map<string, EffectPropagation>>();
  for (const graphNode of graph.nodes) {
    const node = nodes.get(graphNode.id)! as ts.FunctionLikeDeclaration & { body: ts.ConciseBody };
    if (isAsyncFunction(node)) asyncOwners.add(graphNode.id);
    const locals = localBindings(node);
    localsById.set(graphNode.id, locals);
    const source = node.getSourceFile(), effects: Effect[] = [];
    const witness = new Map<string, EffectWitness>();
    witnesses.set(graphNode.id, witness);
    /** Remember where an effect first entered this function so a diagnostic can point at the operation. */
    const observe = (effect: Effect, at: ts.Node): void => {
      const key = formatEffect(effect);
      if (!witness.has(key)) witness.set(key, { fileName: source.fileName, line: source.getLineAndCharacterOfPosition(at.getStart(source)).line + 1, text: snippet(at, source) });
      addEffect(effects, effect);
    };
    let promiseModel = promiseModels.get(source);
    if (!promiseModel) { promiseModel = analyzePromiseChainsInProgram(program, source); promiseModels.set(source, promiseModel); }
    if (mayAssimilateUserCode(promiseModel, node)) observe(capability("InvokeUserCode"), node);
    direct.set(graphNode.id, effects);
    const nameNode = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name ? node.name
      : (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined;
    const symbol = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined;
    const declarationEffects = symbol?.declarations?.flatMap((item) => declaration(item.getSourceFile(), item)) ?? declaration(source, node);
    declared.set(graphNode.id, declarationEffects.filter((effect, index, all) => all.findIndex((item) => formatEffect(item) === formatEffect(effect)) === index));
    parameters.set(graphNode.id, node.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(source)));
    const visit = (child: ts.Node, catches: boolean): void => {
      if (child !== node.body && ts.isFunctionLike(child)) return;
      if (ts.isTryStatement(child)) {
        visit(child.tryBlock, catches || child.catchClause !== undefined);
        if (child.catchClause) visit(child.catchClause.block, catches);
        if (child.finallyBlock) visit(child.finallyBlock, catches);
        return;
      }
      if (ts.isThrowStatement(child) && !catches && !asyncOwners.has(graphNode.id)) observe({ kind: "throw", errorType: adapter.thrownErrorType(child.expression) }, child);
      if (ts.isVariableStatement(child)) {
        const flags = ts.getCombinedNodeFlags(child.declarationList);
        if ((flags & ts.NodeFlags.Using) === ts.NodeFlags.Using) for (const declaration of child.declarationList.declarations) {
          if (!declaration.initializer) continue;
          const asynchronous = (flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing;
          const { asyncSymbol: asyncDispose, syncSymbol: syncDispose } = resolveDisposalProtocol(checker, declaration.initializer);
          const disposal = asynchronous ? asyncDispose ?? syncDispose : syncDispose;
          for (const target of disposal?.declarations ?? []) {
            if (!ts.isMethodDeclaration(target) || !target.body) continue;
            const callee = `${target.getSourceFile().fileName}:${target.getStart(target.getSourceFile())}`;
            if (!nodes.has(callee)) continue;
            implicitDisposalEdges.push({ caller: graphNode.id, callee, kind: "direct", timing: asynchronous ? "deferred" : "inline", span: { start: declaration.getStart(source), end: declaration.getEnd() }, arguments: [], dischargesThrow: catches });
          }
        }
      }
      if (adapter.mayInvokeUserCode(child)) observe(capability("InvokeUserCode"), child);
      if (ts.isBinaryExpression(child) && isAssignmentOperator(child.operatorToken.kind) && (ts.isPropertyAccessExpression(child.left) || ts.isElementAccessExpression(child.left))) { const effect = mutateEffect(child.left); if (observableMutation(effect, locals)) observe(effect, child); }
      if ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) && (child.operator === ts.SyntaxKind.PlusPlusToken || child.operator === ts.SyntaxKind.MinusMinusToken) && (ts.isPropertyAccessExpression(child.operand) || ts.isElementAccessExpression(child.operand))) { const effect = mutateEffect(child.operand); if (observableMutation(effect, locals)) observe(effect, child); }
      if (ts.isCallExpression(child)) for (const effect of primitiveEffects(child, adapter)) if (observableMutation(effect, locals)) observe(effect, child);
      ts.forEachChild(child, (next) => visit(next, catches));
    };
    visit(node.body, false);
  }
  const inferred = new Map([...direct].map(([id, effects]) => [id, [...effects]]));
  const unknownTiming = new Set<string>(), unknownGeneratorEvidence = new Set<string>(), unknownGeneratorParameterEvidence = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of [...graph.edges, ...implicitDisposalEdges]) {
      const intrinsicUnknown = (edge.unknownGeneratorConsumption && edge.unknownGeneratorParameterIndex === undefined)
        || (edge.executesBody !== false && edge.callee && unknownGeneratorEvidence.has(edge.callee));
      if (intrinsicUnknown && !unknownGeneratorEvidence.has(edge.caller)) {
        unknownGeneratorEvidence.add(edge.caller);
        changed = true;
      }
      const parameterUnknown = (edge.unknownGeneratorConsumption && edge.unknownGeneratorParameterIndex !== undefined)
        || (edge.executesBody !== false && edge.callee && unknownGeneratorParameterEvidence.has(edge.callee)
          && !edge.dischargesUnknownGeneratorParameters);
      if (parameterUnknown && !unknownGeneratorParameterEvidence.has(edge.caller)) {
        unknownGeneratorParameterEvidence.add(edge.caller);
        changed = true;
      }
      if (!edge.callee || !inferred.has(edge.callee)) continue;
      if (edge.executesBody === false) continue;
      if (edge.kind === "callback-argument" && edge.timing === "unknown") unknownTiming.add(edge.caller);
      const calleeParams = parameters.get(edge.callee) ?? [];
      for (const raw of inferred.get(edge.callee)!) {
        if (raw.kind === "throw" && asyncOwners.has(edge.caller)) continue;
        if (edge.dischargesThrow && raw.kind === "throw") continue;
        const effect = raw.kind === "mutate" ? (() => {
          for (let index = 0; index < calleeParams.length; index++) {
            const parameter = calleeParams[index]!;
            if (raw.region === parameter || raw.region.startsWith(`${parameter}.`) || raw.region.startsWith(`${parameter}[`)) return edge.arguments[index] ? { kind: "mutate" as const, region: `${edge.arguments[index]}${raw.region.slice(parameter.length)}` } : raw;
          }
          return raw;
        })() : raw;
        if (!observableMutation(effect, localsById.get(edge.caller) ?? new Set())) continue;
        const own = inferred.get(edge.caller)!, key = formatEffect(effect);
        if (!own.some((item) => formatEffect(item) === key)) {
          own.push(effect);
          changed = true;
          const inherited = propagation.get(edge.caller) ?? new Map<string, EffectPropagation>();
          propagation.set(edge.caller, inherited);
          const callerSource = nodes.get(edge.caller)!.getSourceFile();
          if (!inherited.has(key)) inherited.set(key, { callee: edge.callee, calleeEffect: formatEffect(raw), fileName: callerSource.fileName, line: callerSource.getLineAndCharacterOfPosition(edge.span.start).line + 1 });
        }
      }
    }
  }
  const names = new Map(graph.nodes.map((graphNode) => [graphNode.id, graphNode.name]));
  const basename = (fileName: string): string => fileName.slice(fileName.lastIndexOf("/") + 1);
  /** Walk one effect back to the operation that produces it, through the call edges that carried it. */
  const origin = (id: string, effect: string, from: string): string | undefined => {
    const steps: string[] = [], visited = new Set<string>();
    let cursor = { id, effect };
    for (;;) {
      const mark = `${cursor.id}#${cursor.effect}`;
      if (visited.has(mark)) break;
      visited.add(mark);
      const at = (place: { fileName: string; line: number }): string => place.fileName === from ? `line ${place.line}` : `${basename(place.fileName)}:${place.line}`;
      const produced = witnesses.get(cursor.id)?.get(cursor.effect);
      if (produced) { steps.push(`${names.get(cursor.id) ?? cursor.id} performs ${produced.text} at ${at(produced)}`); break; }
      const inherited = propagation.get(cursor.id)?.get(cursor.effect);
      if (!inherited) break;
      steps.push(`${names.get(cursor.id) ?? cursor.id} calls ${names.get(inherited.callee) ?? inherited.callee} at ${at(inherited)}`);
      cursor = { id: inherited.callee, effect: inherited.calleeEffect };
    }
    return steps.length > 0 ? steps.join("; ") : undefined;
  };
  const diagnostics: EffectDiagnostic[] = [], summaries: EffectSummary[] = [];
  for (const graphNode of graph.nodes) {
    const actual = inferred.get(graphNode.id)!, allowed = declared.get(graphNode.id)!, source = nodes.get(graphNode.id)!.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(graphNode.span.start).line + 1;
    const declaredNote: DiagnosticNote = { label: "declared", detail: allowed.length > 0 ? allowed.map(formatEffect).join(" | ") : "(no /* uneffect: effect ... */ comment)" };
    for (const effect of allowed) if (!isKnownEffect(effect)) diagnostics.push({ fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(effect), kind: "unknown", severity: options.mode === "strict" ? "error" : "warning", line, message: `${graphNode.name} declares unknown effect ${formatEffect(effect)}`, notes: [declaredNote, { label: "because", detail: `${formatEffect(effect)} is not one of the effect constructors this checker understands, so it constrains nothing` }] });
    for (const effect of actual) if (!permits(allowed, effect) && (allowed.length > 0 || options.requireAnnotations !== false)) {
      const key = formatEffect(effect);
      const because = origin(graphNode.id, key, source.fileName);
      const narrower = allowed.filter((item) => sameConstructor(item, effect)).map(formatEffect);
      diagnostics.push({
        fileName: source.fileName, functionName: graphNode.name, effect: key, kind: "missing", severity: "error", line,
        message: `${graphNode.name} requires /* uneffect: effect ${key} */`,
        notes: [
          declaredNote,
          ...(because ? [{ label: "because", detail: because }] : []),
          ...(narrower.length > 0 ? [{ label: "out of authority", detail: `the declared ${narrower.join(" | ")} shares this effect constructor, but its arguments do not cover ${key}` }] : []),
        ],
      });
    }
    for (const effect of allowed) if (!actual.some((item) => permits([effect], item))) diagnostics.push({ fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(effect), kind: "unused", severity: "warning", line, message: `${graphNode.name} declares unused effect ${formatEffect(effect)}`, notes: [declaredNote, { label: "inferred", detail: actual.length > 0 ? actual.map(formatEffect).join(" | ") : "no effect" }, { label: "because", detail: `nothing in ${graphNode.name} or its callees produces ${formatEffect(effect)}` }] });
    const own = diagnostics.filter((diagnostic) => diagnostic.fileName === source.fileName && diagnostic.functionName === graphNode.name);
    const evidence: EvidenceStatus = unknownTiming.has(graphNode.id) || unknownGeneratorEvidence.has(graphNode.id) || unknownGeneratorParameterEvidence.has(graphNode.id) ? "unknown" : allowed.length === 0 ? "inferred" : own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified";
    summaries.push({ functionName: graphNode.name, effects: actual, evidence, id: graphNode.id, fileName: graphNode.fileName, span: graphNode.span });
  }
  return { diagnostics, summaries };
}

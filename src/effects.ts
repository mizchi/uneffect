import ts from "typescript";
import { extractAnnotations, extractLocatedAnnotations } from "./annotations.js";
import type { DiagnosticNote } from "./diagnostics.js";
import { effectPermits, formatEffect, isKnownEffect, parseEffectExpression, splitTopLevel, type Effect } from "./capabilities.js";
import { TypeScriptFrontendAdapter, type FrontendSymbolAdapter } from "./frontend-adapter.js";
import { builtinContractRegistry, resolveModuleInitializationContract, type BuiltinContractRegistry, type FsBuiltinOperation } from "./builtin-contracts.js";
import { buildProgramCallGraph, type CallGraphEdge, type IteratorEffectParameter } from "./call-graph.js";
import { resolveDisposalProtocol } from "./disposal-symbols.js";
import { analyzePromiseChainsInProgram, type PromiseChainModel } from "./promise-chains.js";
import { isRuntimeModuleDependency } from "./module-initialization.js";

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
  /** Iterator parameters whose lazy body effects are supplied and instantiated by each call site. */
  iteratorEffectParameters?: IteratorEffectParameter[];
  /** Explicit upper bounds for polymorphic iterator effects, indexed by the TypeScript parameter. */
  iteratorEffectBounds?: Array<{ index: number; name: string; effects: Effect[] }>;
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
  if (left.kind === "mutate" && right.kind === "mutate") return regionRoot(left.region) === regionRoot(right.region);
  return left.kind === "throw";
}

/** The declaration a diagnostic is judged against, shown so a reader need not open the source. */
function declaredNote(declared: readonly Effect[]): DiagnosticNote {
  return { label: "declared", detail: declared.length > 0 ? declared.map(formatEffect).join(" | ") : "(no /* uneffect: effect ... */ comment)" };
}

function inferredNote(actual: readonly Effect[]): DiagnosticNote {
  return { label: "inferred", detail: actual.length > 0 ? actual.map(formatEffect).join(" | ") : "no effect" };
}

/** Notes shared by both analyzers; the program-wide path adds the origin of the effect. */
function missingEffectNotes(declared: readonly Effect[], effect: Effect, origin?: string): DiagnosticNote[] {
  const related = declared.filter((item) => sameConstructor(item, effect));
  return [
    declaredNote(declared),
    ...(origin ? [{ label: "because", detail: origin }] : []),
    ...(related.length > 0 ? [{ label: "out of authority", detail: authorityMismatch(related, effect) }] : []),
  ];
}

function unusedEffectNotes(name: string, declared: readonly Effect[], actual: readonly Effect[], effect: Effect): DiagnosticNote[] {
  return [declaredNote(declared), inferredNote(actual), { label: "because", detail: `nothing in ${name} or its callees produces ${formatEffect(effect)}` }];
}

function unknownEffectNotes(declared: readonly Effect[], effect: Effect): DiagnosticNote[] {
  return [declaredNote(declared), { label: "because", detail: `${formatEffect(effect)} is not one of the effect constructors this checker understands, so it constrains nothing` }];
}

/** Why a declaration that looks related still does not permit the required effect. */
function authorityMismatch(declared: readonly Effect[], required: Effect): string {
  const names = declared.map(formatEffect).join(" | ");
  if (required.kind === "mutate") {
    return `the declared ${names} names a different region of ${regionRoot(required.region)}; a region only permits itself and the members below it`;
  }
  return `the declared ${names} shares this effect constructor, but its arguments do not cover ${formatEffect(required)}`;
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

interface EffectParameterAnnotation {
  name?: string;
  effects: Effect[];
  payload: string;
  start: number;
}

function effectParameterAnnotations(source: ts.SourceFile, node: ts.Node): EffectParameterAnnotation[] {
  const owner = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isVariableDeclarationList(node.parent.parent) && ts.isVariableStatement(node.parent.parent.parent)
    ? node.parent.parent.parent : node;
  const leading = leadingText(source, owner), baseOffset = owner.getFullStart();
  return extractLocatedAnnotations(leading, "effect_parameter", baseOffset).map(({ value: payload, span }) => {
    const match = /^([A-Za-z_$][\w$]*)\s+extends\s+(.+)$/u.exec(payload);
    return match ? {
      name: match[1], payload, start: span.start,
      effects: splitTopLevel(match[2]!, "|").map(parseEffectExpression),
    } : { payload, effects: [], start: span.start };
  });
}

/** Property names that can be written as a member path; anything else stays bracketed. */
const plainMember = /^[A-Za-z_$][\w$]*$/u;

/**
 * The region a write names: the member path of the location itself, so `state.calls = 1` is
 * `Mutate<typeof state.calls>` rather than the whole of `state`. A declaration of the container
 * still permits it, because region containment is prefix-based.
 *
 * An element access is only as precise as its key: a literal key is a property, while a computed
 * one names no member the checker can compare, so the region conservatively widens to the container.
 */
function mutationRegion(expression: ts.Expression): string {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) return mutationRegion(expression.expression);
  if (ts.isPropertyAccessExpression(expression)) return `${mutationRegion(expression.expression)}.${expression.name.text}`;
  if (ts.isElementAccessExpression(expression)) {
    const container = mutationRegion(expression.expression), key = expression.argumentExpression;
    if (ts.isStringLiteralLike(key)) return plainMember.test(key.text) ? `${container}.${key.text}` : `${container}["${key.text}"]`;
    return container;
  }
  return expression.getText();
}
function mutateEffect(expression: ts.Expression): Effect {
  return { kind: "mutate", region: mutationRegion(expression) };
}
function mutateRegionEffect(region: string): Effect { return { kind: "mutate", region }; }

/** The binding a region is rooted at, used to tell a different property from a different object. */
function regionRoot(region: string): string {
  return /^[A-Za-z_$][\w$]*/u.exec(region)?.[0] ?? region;
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
    const region = adapter.resolveDomReceiverRegion(receiver) ?? receiver;
    const effects: Effect[] = resolved.operation.operations
      .map((operation) => capability(`Dom<${operation}, typeof ${region.getText()}>`));
    if (resolved.operation.mutatesReceiver) effects.push(mutateEffect(region));
    for (const index of resolved.operation.mutatesArguments ?? []) if (call.arguments[index]) effects.push(mutateEffect(call.arguments[index]!));
    if (resolved.operation.invokesUserCode) effects.push(capability("InvokeUserCode"));
    return effects;
  }
  return [];
}

function domPropertyAccessMode(access: ts.PropertyAccessExpression | ts.ElementAccessExpression): { read: boolean; write: boolean } {
  const parent = access.parent;
  if (ts.isBinaryExpression(parent) && parent.left === access && isAssignmentOperator(parent.operatorToken.kind)) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? { read: false, write: true }
      : { read: true, write: true };
  }
  if ((ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    && parent.operand === access
    && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
    return { read: true, write: true };
  }
  return { read: true, write: false };
}

function effectsForDomProperty(access: ts.PropertyAccessExpression | ts.ElementAccessExpression, adapter: FrontendSymbolAdapter): Effect[] | undefined {
  const resolved = adapter.resolveProperty(access);
  if (!resolved) return undefined;
  const mode = domPropertyAccessMode(access);
  const receiverRegion = access.expression.getText();
  const writeRegion = resolved.operation.writeRegion === "parentNode"
    ? `${receiverRegion}.parentNode`
    : receiverRegion;
  const effects = [
    ...(mode.read ? resolved.operation.readOperations.map((operation) => capability(`Dom<${operation}, typeof ${receiverRegion}>`)) : []),
    ...(mode.write ? resolved.operation.writeOperations.map((operation) => capability(`Dom<${operation}, typeof ${writeRegion}>`)) : []),
  ];
  if (mode.write && resolved.operation.mutatesReceiverOnWrite) effects.push(mutateEffect(access.expression));
  if (mode.write && resolved.operation.mutatesWriteRegionOnWrite) effects.push(mutateRegionEffect(writeRegion));
  if (mode.write && resolved.operation.invokesUserCodeOnWrite) effects.push(capability("InvokeUserCode"));
  return effects;
}

function effectsForDynamicDomProperty(access: ts.ElementAccessExpression, adapter: FrontendSymbolAdapter): Effect[] {
  if (adapter.resolveProperty(access)) return [];
  if (!adapter.isDomReceiver(access.expression)) return [];
  const mode = domPropertyAccessMode(access);
  const effects: Effect[] = [capability(`Dom<All, typeof ${access.expression.getText()}>`)];
  if (mode.write) effects.push(mutateEffect(access.expression));
  return effects;
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

export interface EffectAnalysisOptions {
  mode?: "gradual" | "strict";
  requireAnnotations?: boolean;
  /** Versioned builtin and external-module contracts owned by the caller. */
  builtinRegistry?: BuiltinContractRegistry;
}

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
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) for (const effect of effectsForDomProperty(node, adapter) ?? []) {
        if (observableMutation(effect, info.locals)) addEffect(info.direct, effect);
      }
      if (ts.isElementAccessExpression(node)) for (const effect of effectsForDynamicDomProperty(node, adapter)) {
        if (observableMutation(effect, info.locals)) addEffect(info.direct, effect);
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
      notes: unknownEffectNotes(info.declared, effect),
    });
    for (const effect of actual) if (!permits(info.declared, effect) && (info.declared.length > 0 || options.requireAnnotations !== false)) diagnostics.push({
      fileName, functionName: info.name, effect: formatEffect(effect), kind: "missing", severity: "error", line,
      message: `${info.name} requires /* uneffect: effect ${formatEffect(effect)} */`,
      notes: missingEffectNotes(info.declared, effect),
    });
    for (const effect of info.declared) if (![...actual].some((item) => permits([effect], item))) diagnostics.push({
      fileName, functionName: info.name, effect: formatEffect(effect), kind: "unused", severity: "warning", line,
      message: `${info.name} declares unused effect ${formatEffect(effect)}`,
      notes: unusedEffectNotes(info.name, info.declared, actual, effect),
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
  return analyzeSource(source, options, new TypeScriptFrontendAdapter(program, options.builtinRegistry), program.getTypeChecker(), analyzePromiseChainsInProgram(program, source)).diagnostics;
}

export function analyzeEffectsInProgram(program: ts.Program, source: ts.SourceFile, options: EffectAnalysisOptions = {}): EffectDiagnostic[] {
  return analyzeSource(source, options, new TypeScriptFrontendAdapter(program, options.builtinRegistry), program.getTypeChecker(), analyzePromiseChainsInProgram(program, source)).diagnostics;
}

export function analyzeEffectSummariesInProgram(program: ts.Program, source: ts.SourceFile, options: EffectAnalysisOptions = {}): EffectAnalysisResult {
  const result = analyzeProgramEffects(program, options);
  return {
    diagnostics: result.diagnostics.filter((diagnostic) => diagnostic.fileName === source.fileName),
    summaries: result.summaries.filter((summary) => summary.fileName === source.fileName),
  };
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
  const registry = options.builtinRegistry ?? builtinContractRegistry;
  const graph = buildProgramCallGraph(program), nodes = callableNodes(program), adapter = new TypeScriptFrontendAdapter(program, registry), checker = program.getTypeChecker();
  const invalidSources = new Set(
    [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file !== undefined)
      .map((diagnostic) => diagnostic.file!.fileName),
  );
  const promiseModels = new Map<ts.SourceFile, PromiseChainModel>();
  const implicitDisposalEdges: CallGraphEdge[] = [];
  const direct = new Map<string, Effect[]>(), declared = new Map<string, Effect[]>(), parameters = new Map<string, string[]>(), localsById = new Map<string, Set<string>>(), asyncOwners = new Set<string>();
  const iteratorEffectBounds = new Map<string, Map<number, { name: string; effects: Effect[] }>>();
  const effectParameterProblems: Array<{ id: string; payload: string; start: number; message: string }> = [];
  const invalidEffectParameterOwners = new Set<string>();
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
    const parameterNames = node.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(source));
    parameters.set(graphNode.id, parameterNames);
    const iteratorIndices = new Set(graphNode.iteratorEffectParameters.map((parameter) => parameter.index));
    const bounds = new Map<number, { name: string; effects: Effect[] }>();
    for (const annotation of effectParameterAnnotations(source, node)) {
      const index = annotation.name === undefined ? -1 : parameterNames.indexOf(annotation.name);
      if (annotation.name === undefined) effectParameterProblems.push({ id: graphNode.id, payload: annotation.payload, start: annotation.start, message: `invalid effect_parameter syntax; expected <parameter> extends <Effect union>` });
      else if (index < 0) effectParameterProblems.push({ id: graphNode.id, payload: annotation.payload, start: annotation.start, message: `effect_parameter names unknown parameter ${annotation.name}` });
      else if (!iteratorIndices.has(index)) effectParameterProblems.push({ id: graphNode.id, payload: annotation.payload, start: annotation.start, message: `effect_parameter ${annotation.name} is not a consumed iterator parameter` });
      else if (bounds.has(index)) effectParameterProblems.push({ id: graphNode.id, payload: annotation.payload, start: annotation.start, message: `duplicate effect_parameter bound for ${annotation.name}` });
      else {
        bounds.set(index, { name: annotation.name, effects: annotation.effects });
        for (const effect of annotation.effects) if (!isKnownEffect(effect)) effectParameterProblems.push({
          id: graphNode.id, payload: annotation.payload, start: annotation.start,
          message: `effect_parameter ${annotation.name} declares unknown effect ${formatEffect(effect)}`,
        });
      }
    }
    iteratorEffectBounds.set(graphNode.id, bounds);
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
      if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) for (const effect of effectsForDomProperty(child, adapter) ?? []) {
        if (observableMutation(effect, locals)) observe(effect, child);
      }
      if (ts.isElementAccessExpression(child)) for (const effect of effectsForDynamicDomProperty(child, adapter)) {
        if (observableMutation(effect, locals)) observe(effect, child);
      }
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
  const graphNodesById = new Map(graph.nodes.map((graphNode) => [graphNode.id, graphNode]));
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
  const diagnostics: EffectDiagnostic[] = effectParameterProblems.map((problem) => {
    invalidEffectParameterOwners.add(problem.id);
    const graphNode = graphNodesById.get(problem.id)!;
    const source = nodes.get(problem.id)!.getSourceFile();
    return { fileName: source.fileName, functionName: graphNode.name, effect: problem.payload, kind: "unknown", severity: "error", line: source.getLineAndCharacterOfPosition(problem.start).line + 1, message: problem.message };
  }), summaries: EffectSummary[] = [];
  const invalidIteratorInstantiationCallers = new Set<string>();
  type IteratorParameterRef = { consumer: string; parameterIndex: number };
  const parameterKey = (reference: IteratorParameterRef): string => `${reference.consumer}#${reference.parameterIndex}`;
  const forwardedConstraints = new Map<string, IteratorParameterRef[]>();
  for (const edge of graph.edges) {
    if (!edge.iteratorEffectInstantiation || edge.unknownGeneratorParameterIndex === undefined) continue;
    const source = parameterKey({ consumer: edge.caller, parameterIndex: edge.unknownGeneratorParameterIndex });
    const targets = forwardedConstraints.get(source) ?? [];
    targets.push(edge.iteratorEffectInstantiation);
    forwardedConstraints.set(source, targets);
  }
  const reachableBounds = (start: IteratorParameterRef): Array<{ owner: string; index: number; name: string; effects: Effect[] }> => {
    const result: Array<{ owner: string; index: number; name: string; effects: Effect[] }> = [], queue = [start], seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift()!, key = parameterKey(current);
      if (seen.has(key)) continue;
      seen.add(key);
      const bound = iteratorEffectBounds.get(current.consumer)?.get(current.parameterIndex);
      if (bound) result.push({ owner: current.consumer, index: current.parameterIndex, ...bound });
      queue.push(...(forwardedConstraints.get(key) ?? []));
    }
    return result;
  };
  // A wrapper declaration may not promise a wider input effect row than a
  // downstream consumer accepts, even if no concrete call currently reaches it.
  for (const [sourceKey, targets] of forwardedConstraints) {
    const separator = sourceKey.lastIndexOf("#"), owner = sourceKey.slice(0, separator), index = Number(sourceKey.slice(separator + 1));
    const sourceBound = iteratorEffectBounds.get(owner)?.get(index);
    if (!sourceBound) continue;
    for (const target of targets) for (const targetBound of reachableBounds(target)) for (const effect of sourceBound.effects) {
      if (permits(targetBound.effects, effect)) continue;
      const graphNode = graphNodesById.get(owner)!, targetNode = graphNodesById.get(targetBound.owner)!;
      const source = nodes.get(owner)!.getSourceFile();
      invalidEffectParameterOwners.add(owner);
      invalidIteratorInstantiationCallers.add(owner);
      diagnostics.push({
        fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(effect), kind: "missing", severity: "error",
        line: source.getLineAndCharacterOfPosition(graphNode.span.start).line + 1,
        message: `${graphNode.name} effect_parameter ${sourceBound.name} allows ${formatEffect(effect)}, which is not compatible with forwarded constraint ${targetBound.name} of ${targetNode.name}`,
      });
    }
  }
  for (const edge of graph.edges) {
    const instantiation = edge.iteratorEffectInstantiation;
    if (!instantiation || !edge.callee) continue;
    for (const bound of reachableBounds(instantiation)) for (const effect of inferred.get(edge.callee) ?? []) {
      if (effect.kind === "throw" && edge.dischargesThrow) continue;
      if (permits(bound.effects, effect)) continue;
      const caller = graphNodesById.get(edge.caller)!;
      const consumer = graphNodesById.get(bound.owner)!;
      const source = nodes.get(edge.caller)!.getSourceFile();
      diagnostics.push({
        fileName: source.fileName, functionName: caller.name, effect: formatEffect(effect), kind: "missing", severity: "error",
        line: source.getLineAndCharacterOfPosition(edge.span.start).line + 1,
        message: `${caller.name} instantiates iterator effect parameter ${bound.name} of ${consumer.name} with ${formatEffect(effect)} outside its declared bound`,
      });
      invalidIteratorInstantiationCallers.add(edge.caller);
    }
  }
  let invalidInstantiationChanged = true;
  while (invalidInstantiationChanged) {
    invalidInstantiationChanged = false;
    for (const edge of graph.edges) if (edge.callee && invalidIteratorInstantiationCallers.has(edge.callee)
      && !invalidIteratorInstantiationCallers.has(edge.caller)) {
      invalidIteratorInstantiationCallers.add(edge.caller);
      invalidInstantiationChanged = true;
    }
  }
  for (const graphNode of graph.nodes) {
    const actual = inferred.get(graphNode.id)!, allowed = declared.get(graphNode.id)!, source = nodes.get(graphNode.id)!.getSourceFile();
    const line = source.getLineAndCharacterOfPosition(graphNode.span.start).line + 1;
    for (const effect of allowed) if (!isKnownEffect(effect)) diagnostics.push({ fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(effect), kind: "unknown", severity: options.mode === "strict" ? "error" : "warning", line, message: `${graphNode.name} declares unknown effect ${formatEffect(effect)}`, notes: unknownEffectNotes(allowed, effect) });
    for (const effect of actual) if (!permits(allowed, effect) && (allowed.length > 0 || options.requireAnnotations !== false)) {
      const key = formatEffect(effect);
      diagnostics.push({
        fileName: source.fileName, functionName: graphNode.name, effect: key, kind: "missing", severity: "error", line,
        message: `${graphNode.name} requires /* uneffect: effect ${key} */`,
        notes: missingEffectNotes(allowed, effect, origin(graphNode.id, key, source.fileName)),
      });
    }
    for (const effect of allowed) if (!actual.some((item) => permits([effect], item))) diagnostics.push({ fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(effect), kind: "unused", severity: "warning", line, message: `${graphNode.name} declares unused effect ${formatEffect(effect)}`, notes: unusedEffectNotes(graphNode.name, allowed, actual, effect) });
    const own = diagnostics.filter((diagnostic) => diagnostic.fileName === source.fileName && diagnostic.functionName === graphNode.name);
    const polymorphicIterator = graphNode.iteratorEffectParameters.length > 0;
    const bounds = iteratorEffectBounds.get(graphNode.id) ?? new Map();
    const fullyBoundIterator = polymorphicIterator && graphNode.iteratorEffectParameters.every((parameter) => bounds.has(parameter.index));
    const evidence: EvidenceStatus = invalidSources.has(source.fileName)
      || unknownTiming.has(graphNode.id) || unknownGeneratorEvidence.has(graphNode.id)
      || (unknownGeneratorParameterEvidence.has(graphNode.id) && !polymorphicIterator)
      || invalidEffectParameterOwners.has(graphNode.id)
      || invalidIteratorInstantiationCallers.has(graphNode.id)
      || (polymorphicIterator && allowed.length > 0 && !fullyBoundIterator)
      ? "unknown" : fullyBoundIterator ? (own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified")
        : allowed.length === 0 ? "inferred" : own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified";
    summaries.push({
      functionName: graphNode.name, effects: actual, evidence, id: graphNode.id, fileName: graphNode.fileName, span: graphNode.span,
      ...(polymorphicIterator ? { iteratorEffectParameters: graphNode.iteratorEffectParameters } : {}),
      ...(bounds.size > 0 ? { iteratorEffectBounds: [...bounds].map(([index, bound]) => ({ index, ...bound })) } : {}),
    });
  }

  // Module evaluation is a separate owner from every function body. Keeping a
  // source-attributed pseudo-summary prevents function evidence in a sibling
  // file from making executable top-level code disappear from assurance.
  const moduleRecords = new Map<string, {
    source: ts.SourceFile; id: string; effects: Effect[]; allowed: Effect[]; unknown: boolean; trusted: boolean; dependencies: string[];
  }>();
  const moduleResolutionHost: ts.ModuleResolutionHost = {
    fileExists: (fileName) => program.getSourceFile(fileName) !== undefined || ts.sys.fileExists(fileName),
    readFile: (fileName) => program.getSourceFile(fileName)?.text ?? ts.sys.readFile(fileName),
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    realpath: ts.sys.realpath,
  };
  const symbolWriteCache = new Map<ts.Symbol, boolean>();
  const hasSymbolWrite = (target: ts.Symbol): boolean => {
    const cached = symbolWriteCache.get(target);
    if (cached !== undefined) return cached;
    let written = false;
    const symbolAt = (node: ts.Node): ts.Symbol | undefined => {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
      return symbol;
    };
    const containsTarget = (node: ts.Node): boolean => {
      if (ts.isIdentifier(node) && symbolAt(node) === target) return true;
      let found = false;
      ts.forEachChild(node, (child) => { if (!found && containsTarget(child)) found = true; });
      return found;
    };
    const scan = (node: ts.Node): void => {
      if (written) return;
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && containsTarget(node.left)) {
        written = true;
        return;
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        && containsTarget(node.operand)) {
        written = true;
        return;
      }
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && containsTarget(node.initializer)) {
        written = true;
        return;
      }
      ts.forEachChild(node, scan);
    };
    const declarationSource = target.declarations?.[0]?.getSourceFile();
    if (!declarationSource) return true;
    scan(declarationSource);
    symbolWriteCache.set(target, written);
    return written;
  };
  const resolveStableFunctionDeclaration = (expression: ts.Expression): ts.FunctionLikeDeclaration | undefined => {
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
    if (!ts.isIdentifier(expression)) return undefined;
    let symbol = checker.getSymbolAtLocation(expression);
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
    const resolved = symbol?.declarations?.find((candidate) => {
      if (ts.isVariableDeclaration(candidate)) {
        return (candidate.parent.flags & ts.NodeFlags.Const) !== 0
          && candidate.initializer !== undefined
          && (ts.isArrowFunction(candidate.initializer) || ts.isFunctionExpression(candidate.initializer));
      }
      return ts.isFunctionDeclaration(candidate) && symbol !== undefined && !hasSymbolWrite(symbol);
    });
    return resolved && ts.isVariableDeclaration(resolved)
      ? resolved.initializer as ts.ArrowFunction | ts.FunctionExpression
      : resolved && ts.isFunctionDeclaration(resolved) ? resolved : undefined;
  };
  const resolveStableFunctionEffects = (expression: ts.Expression): Effect[] | undefined => {
    const declaration = resolveStableFunctionDeclaration(expression);
    if (!declaration) return undefined;
    const declarationSource = declaration.getSourceFile();
    return inferred.get(`${declarationSource.fileName}:${declaration.getStart(declarationSource)}`);
  };
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const executable = source.statements.filter((statement) => {
      if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
        || ts.isFunctionDeclaration(statement)) return false;
      if (ts.isClassDeclaration(statement)) return true;
      if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some((item) => {
        const value = item.initializer;
        return value !== undefined && !ts.isArrowFunction(value) && !ts.isFunctionExpression(value);
      });
      if (ts.isModuleDeclaration(statement)) {
        return !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
          && statement.body !== undefined;
      }
      return !ts.isEmptyStatement(statement);
    });
    const id = `${source.fileName}:<module>`, effects: Effect[] = [];
    const moduleLocals = new Set<string>();
    for (const statement of source.statements) if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name)) moduleLocals.add(item.name.text);
    }
    const dependencies: string[] = [];
    const addResolvedDependency = (specifier: ts.Expression, requireRelative = false): string | undefined => {
      if (!ts.isStringLiteralLike(specifier) || (requireRelative && !specifier.text.startsWith("."))) return undefined;
      const symbol = checker.getSymbolAtLocation(specifier);
      const symbolSource = symbol?.declarations?.find(ts.isSourceFile)?.getSourceFile();
      const resolvedFileName = symbolSource?.fileName ?? ts.resolveModuleName(
        specifier.text, source.fileName, program.getCompilerOptions(), moduleResolutionHost,
      ).resolvedModule?.resolvedFileName;
      const dependencySource = resolvedFileName ? program.getSourceFile(resolvedFileName) : undefined;
      if (!dependencySource || dependencySource.isDeclarationFile) return undefined;
      if (dependencySource.fileName === source.fileName) return source.fileName;
      if (!dependencies.includes(dependencySource.fileName)) dependencies.push(dependencySource.fileName);
      return dependencySource.fileName;
    };
    let unknown = false, trusted = false;
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      if (!isRuntimeModuleDependency(statement)) continue;
      if (addResolvedDependency(statement.moduleSpecifier)) continue;
      const moduleName = ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
      const contract = resolveModuleInitializationContract(program, source.fileName, moduleName, registry);
      if (!contract) { unknown = true; continue; }
      trusted = true;
      for (const expression of contract.effects) addEffect(effects, parseEffectExpression(expression));
    }
    const visit = (node: ts.Node, catches: boolean): void => {
      if (node.kind === ts.SyntaxKind.ImportKeyword) return; // handled by the parent dynamic-import call
      if (ts.isFunctionLike(node)) return;
      if (ts.isModuleDeclaration(node)) {
        if (node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) || !node.body) return;
        visit(node.body, catches);
        return;
      }
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const visitDecorators = (decorated: ts.Node): void => {
          if (!ts.canHaveDecorators(decorated)) return;
          for (const decorator of ts.getDecorators(decorated) ?? []) {
            visit(decorator.expression, catches);
            const decoratorEffects = resolveStableFunctionEffects(decorator.expression);
            if (!decoratorEffects) unknown = true;
            else for (const effect of decoratorEffects) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
          }
        };
        visitDecorators(node);
        for (const clause of node.heritageClauses ?? []) for (const type of clause.types) visit(type.expression, catches);
        for (const member of node.members) {
          visitDecorators(member);
          if (member.name && ts.isComputedPropertyName(member.name)) visit(member.name.expression, catches);
          if (ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)
            || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
            for (const parameter of member.parameters) visitDecorators(parameter);
          }
          if (ts.isClassStaticBlockDeclaration(member)) visit(member.body, catches);
          else if (ts.isPropertyDeclaration(member)
            && member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
            && member.initializer) visit(member.initializer, catches);
        }
        return;
      }
      if (ts.isTryStatement(node)) {
        visit(node.tryBlock, catches || node.catchClause !== undefined);
        if (node.catchClause) visit(node.catchClause.block, catches);
        if (node.finallyBlock) visit(node.finallyBlock, catches);
        return;
      }
      const resolvedDynamicDependency = ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments.length === 1
        ? addResolvedDependency(node.arguments[0]!, true) : undefined;
      const resolvedAwaitedDynamicDependency = ts.isAwaitExpression(node)
        && ts.isCallExpression(node.expression)
        && node.expression.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.expression.arguments.length === 1
        ? addResolvedDependency(node.expression.arguments[0]!, true) : undefined;
      if (ts.isThrowStatement(node) && !catches) addEffect(effects, { kind: "throw", errorType: adapter.thrownErrorType(node.expression) });
      if (adapter.mayInvokeUserCode(node) && !resolvedDynamicDependency && !resolvedAwaitedDynamicDependency) unknown = true;
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) for (const effect of effectsForDomProperty(node, adapter) ?? []) {
        if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
      }
      if (ts.isElementAccessExpression(node)) for (const effect of effectsForDynamicDomProperty(node, adapter)) {
        if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
      }
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
        const effect = mutateEffect(node.left);
        if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
        && (ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))) {
        const effect = mutateEffect(node.operand);
        if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && !resolvedDynamicDependency) unknown = true;
        const resolvedBuiltin = adapter.resolveCall(node), primitive = primitiveEffects(node, adapter);
        for (const effect of primitive) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
        const target = checker.getResolvedSignature(node)?.declaration;
        let targetId: string | undefined;
        if (target && ts.isFunctionLike(target)) {
          targetId = `${target.getSourceFile().fileName}:${target.getStart(target.getSourceFile())}`;
          if (!inferred.has(targetId)) {
            let symbol = checker.getSymbolAtLocation(node.expression);
            if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
            targetId = symbol?.declarations?.filter(ts.isFunctionLike)
              .map((declaration) => `${declaration.getSourceFile().fileName}:${declaration.getStart(declaration.getSourceFile())}`)
              .find((candidate) => inferred.has(candidate)) ?? targetId;
          }
          for (const effect of inferred.get(targetId) ?? []) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
          if (!inferred.has(targetId) && adapter.mayInvokeUserCode(node) && primitive.length === 0) unknown = true;
        } else if (!resolvedDynamicDependency && adapter.mayInvokeUserCode(node) && primitive.length === 0) unknown = true;
        const callbackIndices = new Set(graphNodesById.get(targetId ?? "")?.effectParameters.map((parameter) => parameter.index) ?? []);
        const operation = resolvedBuiltin?.operation;
        const builtinCallback = operation?.kind === "timer" || operation?.kind === "scheduler-post-task"
          ? operation.callbackArgument
          : operation?.kind === "fs" && operation.callbackArgumentFromEnd
            ? node.arguments.length - operation.callbackArgumentFromEnd
            : operation?.kind === "deferred-callback"
              ? node.arguments.length - operation.callbackArgumentFromEnd : undefined;
        if (builtinCallback !== undefined) callbackIndices.add(builtinCallback);
        for (const index of callbackIndices) {
          const callback = node.arguments[index];
          if (!callback) { unknown = true; continue; }
          const callbackEffects = resolveStableFunctionEffects(callback);
          if (!callbackEffects) { unknown = true; continue; }
          for (const effect of callbackEffects) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
        }
      }
      ts.forEachChild(node, (child) => visit(child, catches));
    };
    for (const statement of executable) visit(statement, false);

    const moduleHeader = source.text.slice(0, source.statements[0]?.getStart(source) ?? source.end);
    const allowed = extractAnnotations(moduleHeader, "module_effect")
      .flatMap((value) => splitTopLevel(value, "|")).map(parseEffectExpression);
    moduleRecords.set(source.fileName, { source, id, effects, allowed, unknown, trusted, dependencies });
  }

  // Static module evaluation precedes the importing module. A monotone union
  // reaches a fixed point for cycles without inventing an evaluation order;
  // an unknown member makes every importing module unknown.
  let changedModules = true;
  while (changedModules) {
    changedModules = false;
    for (const record of moduleRecords.values()) for (const dependencyName of record.dependencies) {
      const dependency = moduleRecords.get(dependencyName);
      if (!dependency) continue;
      if (dependency.unknown && !record.unknown) { record.unknown = true; changedModules = true; }
      if (dependency.trusted && !record.trusted) { record.trusted = true; changedModules = true; }
      for (const effect of dependency.effects) if (!record.effects.some((item) => formatEffect(item) === formatEffect(effect))) {
        record.effects.push(effect);
        changedModules = true;
      }
    }
  }

  for (const { source, id, effects, allowed, unknown, trusted } of moduleRecords.values()) {
    const line = 1;
    for (const effect of allowed) if (!isKnownEffect(effect)) diagnostics.push({
      fileName: source.fileName, functionName: "<module>", effect: formatEffect(effect), kind: "unknown",
      severity: options.mode === "strict" ? "error" : "warning", line,
      message: `<module> declares unknown effect ${formatEffect(effect)}`,
      notes: unknownEffectNotes(allowed, effect),
    });
    for (const effect of effects) if (!permits(allowed, effect) && (allowed.length > 0 || options.requireAnnotations !== false)) diagnostics.push({
      fileName: source.fileName, functionName: "<module>", effect: formatEffect(effect), kind: "missing", severity: "error", line,
      message: `<module> requires /* uneffect: module_effect ${formatEffect(effect)} */`,
      notes: missingEffectNotes(allowed, effect),
    });
    for (const effect of allowed) if (!effects.some((item) => permits([effect], item))) diagnostics.push({
      fileName: source.fileName, functionName: "<module>", effect: formatEffect(effect), kind: "unused", severity: "warning", line,
      message: `<module> declares unused effect ${formatEffect(effect)}`,
      notes: unusedEffectNotes("<module>", allowed, effects, effect),
    });
    const own = diagnostics.filter((diagnostic) => diagnostic.fileName === source.fileName && diagnostic.functionName === "<module>");
    const evidence: EvidenceStatus = invalidSources.has(source.fileName) || unknown ? "unknown" : trusted ? "trusted" : allowed.length === 0 ? (effects.length === 0 ? "verified" : "inferred")
      : own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified";
    summaries.push({ functionName: "<module>", effects, evidence, id, fileName: source.fileName, span: { start: 0, end: source.end } });
  }
  return { diagnostics, summaries };
}

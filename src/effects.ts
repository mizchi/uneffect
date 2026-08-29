import ts from "typescript";
import { extractLocatedAnnotations, validateUneffectAnnotations, type AnnotationDiagnostic } from "./annotations.js";
import type { DiagnosticNote } from "./diagnostics.js";
import { effectPermits, formatEffect, isKnownEffect, parseEffectExpression, parseEffectSet, type Effect } from "./capabilities.js";
import { TypeScriptFrontendAdapter, type FrontendSymbolAdapter } from "./frontend-adapter.js";
import { builtinContractRegistry, resolveModuleInitializationContract, type BuiltinContractRegistry, type FsBuiltinOperation } from "./builtin-contracts.js";
import { buildProgramCallGraph, type CallGraphEdge, type ExternalIteratorEffectContract, type IteratorEffectParameter } from "./call-graph.js";
import { resolveDisposalProtocol } from "./disposal-symbols.js";
import { analyzePromiseChainsInProgram, type PromiseChainModel } from "./promise-chains.js";
import { isRuntimeModuleDependency } from "./module-initialization.js";
import type { SameRealmGlobalThisIdentity } from "./runtime-identities.js";

export interface EffectDiagnostic {
  fileName: string;
  functionName: string;
  effect: string;
  kind: "missing" | "unused" | "unknown" | "invalid";
  severity: "error" | "warning";
  line: number;
  message: string;
  notes?: DiagnosticNote[];
}
export type EvidenceStatus = "verified" | "trusted" | "inferred" | "unknown";
export type EffectUnknownReasonCode =
  | "typescript-errors"
  | "unknown-callback-timing"
  | "unknown-generator-consumption"
  | "unknown-generator-parameter"
  | "invalid-effect-parameter"
  | "invalid-iterator-instantiation"
  | "unknown-external-evidence"
  | "unbounded-iterator-effect-parameter"
  | "effect-diagnostic"
  | "invalid-annotation"
  | "unknown-external-module"
  | "unresolved-effect-instantiation"
  | "unresolved-mutation-alias"
  | "unreviewed-external-module"
  | "unresolved-decorator"
  | "possible-user-code"
  | "unresolved-dynamic-import"
  | "unresolved-call"
  | "unresolved-callback"
  | "unknown-dependency";
export interface EffectUnknownReason {
  code: EffectUnknownReasonCode;
  message: string;
}
export interface ExternalExportedMutationRoot {
  kind: "export";
  /** Region root as written in the child-project summary. */
  root: string;
  /** Exported declaration name used to recover a parent-visible alias. */
  exportName: string;
  /** Output-layout-independent project/source/export identity used in evidence reports. */
  identity: string;
  /** TypeChecker declaration identity in the declaration file consumed by the parent. */
  declarationKey: string;
}
export type ExternalAmbientMutationRoot = SameRealmGlobalThisIdentity;
export type ExternalMutationRoot = ExternalExportedMutationRoot | ExternalAmbientMutationRoot;
export interface ExternalFunctionEffectContract {
  effects: readonly Effect[];
  evidence: EvidenceStatus;
  /** Declaration-order parameter names used to instantiate parameter-rooted Mutate regions. */
  parameters?: readonly string[];
  functionName?: string;
  iteratorEffectParameters?: readonly IteratorEffectParameter[];
  iteratorEffectBounds?: ReadonlyArray<{ index: number; name: string; effects: readonly Effect[] }>;
  mutationRoots?: readonly ExternalMutationRoot[];
  reason?: string;
}
export type ExternalModuleEffectContract = ExternalFunctionEffectContract;
export type NetworkTransport = "fetch" | "script" | "beacon" | "websocket";
export interface NetworkBoundaryEvidence {
  via: NetworkTransport;
  authority: string;
  target: string;
  evidence: "exact" | "unknown";
  fileName: string;
  line: number;
}
export interface EffectSummary {
  functionName: string;
  effects: Effect[];
  evidence: EvidenceStatus;
  /** Non-empty whenever `evidence` is `unknown`; stable codes explain the unsupported boundary. */
  unknownReasons?: EffectUnknownReason[];
  /** Present on summaries produced from a Program; omitted by low-level manual summary helpers. */
  id?: string;
  fileName?: string;
  span?: { start: number; end: number };
  /** Declaration-order parameter names. Present on Program-produced function summaries. */
  parameters?: string[];
  /** Iterator parameters whose lazy body effects are supplied and instantiated by each call site. */
  iteratorEffectParameters?: IteratorEffectParameter[];
  /** Explicit upper bounds for polymorphic iterator effects, indexed by the TypeScript parameter. */
  iteratorEffectBounds?: Array<{ index: number; name: string; effects: Effect[] }>;
  /** Transport provenance kept separately from the shared Net authority set. */
  networkBoundaries?: NetworkBoundaryEvidence[];
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
  declaredPresent: boolean;
  declarationProblems: EffectDeclarationProblem[];
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

interface EffectDeclarationProblem { payload: string; start: number; message: string }
interface ParsedEffectDeclaration { effects: Effect[]; present: boolean; problems: EffectDeclarationProblem[] }

function parseEffectDeclarations(text: string, directive: "effect" | "module_effect", baseOffset: number): ParsedEffectDeclaration {
  const annotations = extractLocatedAnnotations(text, directive, baseOffset);
  const problems: EffectDeclarationProblem[] = [];
  if (annotations.some((annotation) => annotation.value === "none")
    && annotations.some((annotation) => annotation.value !== "none")) {
    const annotation = annotations.find((item) => item.value === "none")!;
    return {
      effects: [], present: true,
      problems: [{ payload: annotation.value, start: annotation.span.start, message: "`none` cannot be combined with another effect declaration" }],
    };
  }
  const effects = annotations.flatMap((annotation) => {
    try { return parseEffectSet(annotation.value); }
    catch (cause) {
      problems.push({
        payload: annotation.value, start: annotation.span.start,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      return [];
    }
  });
  return { effects: problems.length > 0 ? [] : effects, present: annotations.length > 0, problems };
}

function annotationProblemDiagnostic(source: ts.SourceFile, problem: AnnotationDiagnostic): EffectDiagnostic {
  return {
    fileName: source.fileName, functionName: "<annotation>", effect: problem.directive,
    kind: "invalid", severity: "error",
    line: source.getLineAndCharacterOfPosition(problem.span.start).line + 1,
    message: problem.message,
  };
}

function effectDeclaration(source: ts.SourceFile, node: ts.Node): ParsedEffectDeclaration {
  const owner = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isVariableDeclarationList(node.parent.parent) && ts.isVariableStatement(node.parent.parent.parent)
    ? node.parent.parent.parent : node;
  return parseEffectDeclarations(leadingText(source, owner), "effect", owner.getFullStart());
}

function declaration(source: ts.SourceFile, node: ts.Node): Effect[] {
  return effectDeclaration(source, node).effects;
}

interface EffectParameterAnnotation {
  name?: string;
  effects: Effect[];
  payload: string;
  start: number;
  problem?: string;
}

function effectParameterAnnotations(source: ts.SourceFile, node: ts.Node): EffectParameterAnnotation[] {
  const owner = (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isVariableDeclarationList(node.parent.parent) && ts.isVariableStatement(node.parent.parent.parent)
    ? node.parent.parent.parent : node;
  const leading = leadingText(source, owner), baseOffset = owner.getFullStart();
  return extractLocatedAnnotations(leading, "effect_parameter", baseOffset).map(({ value: payload, span }) => {
    const match = /^([A-Za-z_$][\w$]*)\s+extends\s+(.+)$/u.exec(payload);
    if (!match) return { payload, effects: [], start: span.start };
    try {
      return { name: match[1], payload, start: span.start, effects: parseEffectSet(match[2]!) };
    } catch (cause) {
      return {
        name: match[1], payload, start: span.start, effects: [],
        problem: cause instanceof Error ? cause.message : String(cause),
      };
    }
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
  const scriptEffects = effectsForStaticScriptInsertion(call, adapter);
  if (scriptEffects.length > 0) return [...(resolved?.operation?.kind === "dom" ? effectsForResolvedDomCall(resolved.operation, call, adapter) : []), ...scriptEffects];
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
    return effectsForResolvedDomCall(resolved.operation, call, adapter);
  }
  return [];
}

function effectsForResolvedDomCall(
  operation: Extract<NonNullable<ReturnType<FrontendSymbolAdapter["resolveCall"]>>["operation"], { kind: "dom" }>,
  call: ts.CallExpression,
  adapter: FrontendSymbolAdapter,
): Effect[] {
  if (!ts.isPropertyAccessExpression(call.expression)) return [];
  const receiver = call.expression.expression;
  const region = adapter.resolveDomReceiverRegion(receiver) ?? receiver;
  const effects: Effect[] = operation.operations.map((item) => capability(`Dom<${item}, typeof ${region.getText()}>`));
  if (operation.mutatesReceiver) effects.push(mutateEffect(region));
  for (const index of operation.mutatesArguments ?? []) if (call.arguments[index]) effects.push(mutateEffect(call.arguments[index]!));
  if (operation.invokesUserCode) effects.push(capability("InvokeUserCode"));
  return effects;
}

function effectsForStaticScriptInsertion(call: ts.CallExpression, adapter: FrontendSymbolAdapter): Effect[] {
  const resolved = adapter.resolveCall(call);
  if (resolved?.symbol.module !== "lib.dom" || resolved.symbol.export !== "Node#appendChild") return [];
  const script = call.arguments[0];
  if (!script || !ts.isIdentifier(script)) return [];
  const initializer = adapter.resolveConstInitializer(script);
  if (!initializer || !ts.isCallExpression(initializer)
    || adapter.resolveCall(initializer)?.symbol.export !== "Document#createElement"
    || !initializer.arguments[0] || !ts.isStringLiteralLike(initializer.arguments[0])
    || initializer.arguments[0].text.toLowerCase() !== "script") return [];

  let url: string | undefined, integrity: string | undefined, crossOrigin: string | undefined;
  let scriptType: "Classic" | "Module" = "Classic";
  const declaration = initializer.parent;
  const declarationStatement = ts.isVariableDeclaration(declaration)
    && ts.isVariableDeclarationList(declaration.parent)
    && ts.isVariableStatement(declaration.parent.parent) ? declaration.parent.parent : undefined;
  let insertionStatement: ts.Node = call;
  while (insertionStatement.parent && !ts.isBlock(insertionStatement.parent) && !ts.isSourceFile(insertionStatement.parent)) {
    insertionStatement = insertionStatement.parent;
  }
  const block = declarationStatement?.parent;
  const statements = block && (ts.isBlock(block) || ts.isSourceFile(block)) ? block.statements : undefined;
  const declarationIndex = statements && declarationStatement ? statements.indexOf(declarationStatement) : -1;
  const insertionIndex = statements ? statements.indexOf(insertionStatement as ts.Statement) : -1;
  let unsupportedConfiguration = declarationIndex < 0 || insertionIndex <= declarationIndex;
  const containsReference = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node) && adapter.isSameReference(node, script)) return true;
    let found = false;
    ts.forEachChild(node, (child) => { if (!found && containsReference(child)) found = true; });
    return found;
  };
  for (const statement of statements?.slice(declarationIndex + 1, insertionIndex) ?? []) {
    const expression = ts.isExpressionStatement(statement) ? statement.expression : undefined;
    if (expression && ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(expression.left) && adapter.isSameReference(expression.left.expression, script)) {
      const value = ts.isStringLiteralLike(expression.right) ? expression.right.text : undefined;
      if (expression.left.name.text === "src") url = value;
      else if (expression.left.name.text === "integrity") integrity = value;
      else if (expression.left.name.text === "crossOrigin") crossOrigin = value;
      else if (expression.left.name.text === "type") scriptType = value === "module" ? "Module" : "Classic";
      else unsupportedConfiguration = true;
    } else if (containsReference(statement)) unsupportedConfiguration = true;
  }
  if (unsupportedConfiguration) url = integrity = crossOrigin = undefined;
  const validIntegrity = integrity !== undefined
    && /^(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}(?:\s+(?:sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2})*$/.test(integrity);
  const integrityArgument = !integrity ? "Unknown<missing-script-integrity>"
    : !validIntegrity ? "Unknown<invalid-script-integrity>"
    : crossOrigin !== "anonymous" && crossOrigin !== "use-credentials" ? "Unknown<missing-script-crossorigin>"
    : JSON.stringify(integrity);
  const effects = [
    capability(`ScriptLoad<${scriptType}, ${url ? JSON.stringify(url) : "Unknown<dynamic-script-url>"}>`),
    capability(`ExecuteExternalCode<${url ? JSON.stringify(url) : "Unknown<dynamic-script-url>"}, ${integrityArgument}>`),
  ];
  const authority = url ? netAuthority(url) : undefined;
  effects.push(capability(`Net<${authority ? JSON.stringify(authority) : "Unknown<dynamic-script-origin>"}>`));
  return effects;
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

function effectsForEffectProperty(access: ts.PropertyAccessExpression | ts.ElementAccessExpression, adapter: FrontendSymbolAdapter): Effect[] | undefined {
  const resolved = adapter.resolveEffectProperty(access);
  if (!resolved) return undefined;
  const mode = domPropertyAccessMode(access);
  return [
    ...(mode.read && resolved.operation.readEffect ? [capability(resolved.operation.readEffect)] : []),
    ...(mode.write && resolved.operation.writeEffect ? [capability(resolved.operation.writeEffect)] : []),
  ];
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

function networkBoundaryFromEffects(
  call: ts.CallExpression,
  resolved: ReturnType<FrontendSymbolAdapter["resolveCall"]>,
  effects: readonly Effect[],
): NetworkBoundaryEvidence | undefined {
  const script = effects.find((effect) => effect.kind === "capability" && effect.name === "ScriptLoad");
  const fetch = resolved?.operation?.kind === "fetch"
    ? effects.find((effect) => effect.kind === "capability" && effect.name === "Fetch") : undefined;
  if (!script && !fetch) return undefined;
  const scoped = script && script.kind === "capability" ? script : fetch && fetch.kind === "capability" ? fetch : undefined;
  const targetSet = scoped?.arguments[1];
  const targetAtom = targetSet?.kind === "finite" ? targetSet.atoms.find((atom) => atom.kind === "url") : undefined;
  const net = effects.find((effect) => effect.kind === "capability" && effect.name === "Net");
  const authoritySet = net?.kind === "capability" ? net.arguments[0] : undefined;
  const authorityAtom = authoritySet?.kind === "finite" ? authoritySet.atoms.find((atom) => atom.kind === "host") : undefined;
  const source = call.getSourceFile();
  return {
    via: script ? "script" : "fetch",
    authority: authorityAtom?.value ?? "unknown",
    target: targetAtom?.value ?? "unknown",
    evidence: targetAtom && authorityAtom ? "exact" : "unknown",
    fileName: source.fileName,
    line: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
  };
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
  /** Effects proved in another TypeScript Program, keyed by the target declaration id. */
  externalFunctionEffects?: ReadonlyMap<string, ExternalFunctionEffectContract>;
  /** Module-evaluation effects proved in another Program, keyed by resolved declaration file. */
  externalModuleEffects?: ReadonlyMap<string, ExternalModuleEffectContract>;
}

function externalContractForCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  contracts: ReadonlyMap<string, ExternalFunctionEffectContract> | undefined,
): ExternalFunctionEffectContract | undefined {
  if (!contracts) return undefined;
  const location = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = checker.getSymbolAtLocation(location);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  for (const declaration of symbol?.declarations ?? []) {
    const source = declaration.getSourceFile();
    const contract = contracts.get(`${source.fileName}:${declaration.getStart(source)}`);
    if (contract) return contract;
  }
  return undefined;
}

function hasConfiguredExternalContractCandidate(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  registry: BuiltinContractRegistry,
): boolean {
  const members: string[] = [];
  let root: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(root)) {
    members.unshift(root.name.text);
    root = root.expression;
  }
  if (!ts.isIdentifier(root)) return false;
  const symbol = checker.getSymbolAtLocation(root);
  const declaration = symbol?.declarations?.find((item) => ts.isImportSpecifier(item) || ts.isNamespaceImport(item) || ts.isImportClause(item));
  if (!declaration) return false;
  let importDeclaration: ts.Node | undefined = declaration;
  while (importDeclaration && !ts.isImportDeclaration(importDeclaration)) importDeclaration = importDeclaration.parent;
  if (!importDeclaration || !ts.isStringLiteral(importDeclaration.moduleSpecifier)) return false;
  const moduleName = importDeclaration.moduleSpecifier.text;
  if (ts.isImportSpecifier(declaration)) members.unshift((declaration.propertyName ?? declaration.name).text);
  else if (ts.isImportClause(declaration)) members.unshift("default");
  const exportName = members.length > 1 ? `${members[0]}#${members.slice(1).join("#")}` : members[0];
  return registry.contracts.some((contract) => contract.symbol.module === moduleName
    && contract.symbol.export === exportName);
}

function addressableMutationArgumentRegion(expression: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return addressableMutationArgumentRegion(expression.expression);
  }
  if (ts.isIdentifier(expression) || expression.kind === ts.SyntaxKind.ThisKeyword) return expression.getText();
  if (ts.isPropertyAccessExpression(expression)) {
    const base = addressableMutationArgumentRegion(expression.expression);
    return base === undefined ? undefined : `${base}.${expression.name.text}`;
  }
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
    const base = addressableMutationArgumentRegion(expression.expression);
    if (base === undefined) return undefined;
    return plainMember.test(expression.argumentExpression.text)
      ? `${base}.${expression.argumentExpression.text}`
      : `${base}[${JSON.stringify(expression.argumentExpression.text)}]`;
  }
  return undefined;
}

function instantiateExternalEffect(
  effect: Effect,
  contract: ExternalFunctionEffectContract,
  call: ts.CallExpression,
  checker: ts.TypeChecker,
): Effect | undefined {
  if (effect.kind !== "mutate") return effect;
  for (const [index, parameter] of (contract.parameters ?? []).entries()) {
    if (effect.region !== parameter && !effect.region.startsWith(`${parameter}.`) && !effect.region.startsWith(`${parameter}[`)) continue;
    const argument = call.arguments[index];
    if (!argument || ts.isSpreadElement(argument)) return undefined;
    const region = addressableMutationArgumentRegion(argument);
    return region === undefined ? undefined : { kind: "mutate", region: `${region}${effect.region.slice(parameter.length)}` };
  }
  const root = regionRoot(effect.region);
  const stable = contract.mutationRoots?.find((item) => item.root === root);
  if (stable) {
    if (stable.kind === "ambient") return effect;
    const visibleRoot = visibleImportedMutationRoot(call.getSourceFile(), checker, stable);
    return visibleRoot === undefined ? undefined : { kind: "mutate", region: `${visibleRoot}${effect.region.slice(root.length)}` };
  }
  return undefined;
}

function symbolHasDeclarationKey(symbol: ts.Symbol | undefined, checker: ts.TypeChecker, declarationKey: string): boolean {
  const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  return target?.declarations?.some((declaration) => {
    const source = declaration.getSourceFile();
    return `${source.fileName}:${declaration.getStart(source)}` === declarationKey;
  }) ?? false;
}

function visibleImportedMutationRoot(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  stable: ExternalExportedMutationRoot,
): string | undefined {
  let visibleRoot: string | undefined;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || !statement.moduleSpecifier) continue;
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if (symbolHasDeclarationKey(checker.getSymbolAtLocation(binding.name), checker, stable.declarationKey)) visibleRoot = binding.name.text;
    }
    if (bindings && ts.isNamespaceImport(bindings)) {
      const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
      const exported = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((item) => item.name === stable.exportName);
      if (symbolHasDeclarationKey(exported, checker, stable.declarationKey)) visibleRoot = `${bindings.name.text}.${stable.exportName}`;
    }
  }
  return visibleRoot;
}

function instantiateExternalModuleEffect(
  effect: Effect,
  contract: ExternalModuleEffectContract,
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): Effect | undefined {
  if (effect.kind !== "mutate") return effect;
  const root = regionRoot(effect.region);
  const stable = contract.mutationRoots?.find((item) => item.root === root);
  if (!stable) return undefined;
  if (stable.kind === "ambient") return effect;
  const visibleRoot = visibleImportedMutationRoot(source, checker, stable);
  return visibleRoot === undefined ? undefined : { kind: "mutate", region: `${visibleRoot}${effect.region.slice(root.length)}` };
}

function unboundedExternalIteratorParameter(contract: ExternalFunctionEffectContract): IteratorEffectParameter | undefined {
  const bounded = new Set(contract.iteratorEffectBounds?.map((bound) => bound.index) ?? []);
  return contract.iteratorEffectParameters?.find((parameter) => !bounded.has(parameter.index));
}

function mayAssimilateUserCode(model: PromiseChainModel | undefined, node: ts.FunctionLikeDeclaration): boolean {
  if (!model || !node.body) return false;
  const start = node.body.getStart(node.getSourceFile()), end = node.body.getEnd();
  return model.executors.some((executor) => executor.adoptedThenable !== undefined && executor.span.start >= start && executor.span.end <= end);
}

function isAsyncFunction(node: ts.FunctionLikeDeclaration): boolean {
  return (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Async) !== 0;
}

function isProcessEnvBase(checker: ts.TypeChecker | undefined, node: ts.Expression): boolean {
  if (!checker || !ts.isPropertyAccessExpression(node) || node.name.text !== "env") return false;
  const property = checker.getSymbolAtLocation(node.name);
  return property?.declarations?.some((item) => ts.isPropertySignature(item)
    && ts.isInterfaceDeclaration(item.parent) && item.parent.name.text === "Process"
    && item.getSourceFile().isDeclarationFile) ?? false;
}

function processEnvEffects(checker: ts.TypeChecker | undefined, node: ts.Expression): Effect[] | undefined {
  if (!checker || (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node))
    || !isProcessEnvBase(checker, node.expression)) return undefined;
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
}

function analyzeSource(source: ts.SourceFile, options: EffectAnalysisOptions, adapter: FrontendSymbolAdapter, checker?: ts.TypeChecker, promiseModel?: PromiseChainModel): EffectAnalysisResult {
  const fileName = source.fileName;
  const annotationProblems = validateUneffectAnnotations(source.text);
  const functions = new Map<string, FunctionInfo>();
  source.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const declared = effectDeclaration(source, node);
      functions.set(node.name.text, {
      name: node.name.text,
      node,
      parameters: node.parameters.map((p) => ts.isIdentifier(p.name) ? p.name.text : p.name.getText()),
      declared: declared.effects,
      declaredPresent: declared.present,
      declarationProblems: declared.problems,
      direct: [],
      calls: [],
      locals: localBindings(node),
      });
    }
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
        for (const effect of processEnvEffects(checker, node) ?? []) addEffect(info.direct, effect);
        if (isProcessEnvBase(checker, node)
          && !((ts.isPropertyAccessExpression(node.parent) || ts.isElementAccessExpression(node.parent)) && node.parent.expression === node)) {
          addEffect(info.direct, capability("Env"));
        }
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) for (const effect of effectsForDomProperty(node, adapter) ?? []) {
        if (observableMutation(effect, info.locals)) addEffect(info.direct, effect);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) for (const effect of effectsForEffectProperty(node, adapter) ?? []) addEffect(info.direct, effect);
      if (ts.isElementAccessExpression(node)) for (const effect of effectsForDynamicDomProperty(node, adapter)) {
        if (observableMutation(effect, info.locals)) addEffect(info.direct, effect);
      }
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind) && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        && processEnvEffects(checker, node.left) === undefined
        && effectsForEffectProperty(node.left, adapter) === undefined) { const effect = mutateEffect(node.left); if (observableMutation(effect, info.locals)) addEffect(info.direct, effect); }
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
  const diagnostics: EffectDiagnostic[] = annotationProblems.map((problem) => annotationProblemDiagnostic(source, problem));
  diagnostics.push(...[...functions.values()].flatMap((info) => info.declarationProblems.map((problem) => ({
    fileName, functionName: info.name, effect: problem.payload, kind: "invalid" as const, severity: "error" as const,
    line: source.getLineAndCharacterOfPosition(problem.start).line + 1,
    message: `invalid effect declaration for ${info.name}: ${problem.message}`,
  }))));
  for (const info of functions.values()) {
    const line = source.getLineAndCharacterOfPosition(info.node.getStart(source)).line + 1;
    const actual = inferred.get(info.name)!;
    for (const effect of info.declared) if (!isKnownEffect(effect)) diagnostics.push({
      fileName, functionName: info.name, effect: formatEffect(effect), kind: "unknown",
      severity: options.mode === "strict" ? "error" : "warning", line,
      message: `${info.name} declares unknown effect ${formatEffect(effect)}`,
      notes: unknownEffectNotes(info.declared, effect),
    });
    for (const effect of actual) if (!permits(info.declared, effect) && (info.declaredPresent || options.requireAnnotations !== false)) diagnostics.push({
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
    const evidence: EvidenceStatus = annotationProblems.length > 0 ? "unknown" : !info.declaredPresent ? "inferred" : own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified";
    return {
      functionName: info.name, effects, evidence,
      ...(evidence === "unknown" ? { unknownReasons: [annotationProblems.length > 0
        ? { code: "invalid-annotation" as const, message: "an invalid Uneffect directive prevents proof-grade effect evidence" }
        : { code: "effect-diagnostic" as const, message: "an effect declaration or inferred authority diagnostic prevents proof-grade evidence" }] } : {}),
    };
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
  const externalIteratorEffects = new Map<string, ExternalIteratorEffectContract>();
  for (const [key, contract] of options.externalFunctionEffects ?? []) {
    if (contract.evidence === "verified" && (contract.iteratorEffectParameters?.length ?? 0) > 0
      && unboundedExternalIteratorParameter(contract) === undefined) {
      externalIteratorEffects.set(key, { key, parameters: contract.iteratorEffectParameters! });
    }
  }
  const graph = buildProgramCallGraph(program, { externalIteratorEffects }), nodes = callableNodes(program), adapter = new TypeScriptFrontendAdapter(program, registry), checker = program.getTypeChecker();
  const annotationProblems = new Map<string, AnnotationDiagnostic[]>();
  for (const source of program.getSourceFiles()) if (!source.isDeclarationFile) {
    const problems = validateUneffectAnnotations(source.text);
    if (problems.length > 0) annotationProblems.set(source.fileName, problems);
  }
  const invalidAnnotationSources = new Set(annotationProblems.keys());
  const invalidSources = new Set(
    [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error && diagnostic.file !== undefined)
      .map((diagnostic) => diagnostic.file!.fileName),
  );
  const promiseModels = new Map<ts.SourceFile, PromiseChainModel>();
  const implicitDisposalEdges: CallGraphEdge[] = [];
  const direct = new Map<string, Effect[]>(), declared = new Map<string, Effect[]>(), declaredPresent = new Set<string>(), parameters = new Map<string, string[]>(), localsById = new Map<string, Set<string>>(), asyncOwners = new Set<string>();
  const iteratorEffectBounds = new Map<string, Map<number, { name: string; effects: Effect[] }>>();
  const effectDeclarationProblems: Array<EffectDeclarationProblem & { id: string; fileName: string }> = [];
  const effectParameterProblems: Array<{ id: string; payload: string; start: number; message: string }> = [];
  const invalidEffectParameterOwners = new Set<string>();
  const unknownExternalEvidence = new Set<string>();
  const directNetworkBoundaries = new Map<string, NetworkBoundaryEvidence[]>();
  const externalInstantiationProblems: Array<{ id: string; effect: Effect; call: ts.CallExpression }> = [];
  const externalIteratorContractProblems: Array<{ id: string; parameter: IteratorEffectParameter; call: ts.CallExpression }> = [];
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
    directNetworkBoundaries.set(graphNode.id, []);
    const nameNode = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name ? node.name
      : (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined;
    const symbol = nameNode ? checker.getSymbolAtLocation(nameNode) : undefined;
    const declarationOwners = symbol?.declarations ?? [node];
    const declarations = declarationOwners.map((item) => effectDeclaration(item.getSourceFile(), item));
    for (const [index, item] of declarations.entries()) for (const problem of item.problems) effectDeclarationProblems.push({
      ...problem, id: graphNode.id, fileName: declarationOwners[index]!.getSourceFile().fileName,
    });
    const declarationEffects = declarations.some((item) => item.problems.length > 0) ? [] : declarations.flatMap((item) => item.effects);
    if (declarations.some((item) => item.present)) declaredPresent.add(graphNode.id);
    declared.set(graphNode.id, declarationEffects.filter((effect, index, all) => all.findIndex((item) => formatEffect(item) === formatEffect(effect)) === index));
    const parameterNames = node.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(source));
    parameters.set(graphNode.id, parameterNames);
    const iteratorIndices = new Set(graphNode.iteratorEffectParameters.map((parameter) => parameter.index));
    const bounds = new Map<number, { name: string; effects: Effect[] }>();
    for (const annotation of effectParameterAnnotations(source, node)) {
      const index = annotation.name === undefined ? -1 : parameterNames.indexOf(annotation.name);
      if (annotation.problem) effectParameterProblems.push({ id: graphNode.id, payload: annotation.payload, start: annotation.start, message: `invalid effect_parameter for ${annotation.name}: ${annotation.problem}` });
      else if (annotation.name === undefined) effectParameterProblems.push({ id: graphNode.id, payload: annotation.payload, start: annotation.start, message: `invalid effect_parameter syntax; expected <parameter> extends <Effect union>` });
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
      if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) {
        for (const effect of processEnvEffects(checker, child) ?? []) observe(effect, child);
        if (isProcessEnvBase(checker, child)
          && !((ts.isPropertyAccessExpression(child.parent) || ts.isElementAccessExpression(child.parent)) && child.parent.expression === child)) {
          observe(capability("Env"), child);
        }
      }
      if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) for (const effect of effectsForDomProperty(child, adapter) ?? []) {
        if (observableMutation(effect, locals)) observe(effect, child);
      }
      if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) for (const effect of effectsForEffectProperty(child, adapter) ?? []) observe(effect, child);
      if (ts.isElementAccessExpression(child)) for (const effect of effectsForDynamicDomProperty(child, adapter)) {
        if (observableMutation(effect, locals)) observe(effect, child);
      }
      if (ts.isBinaryExpression(child) && isAssignmentOperator(child.operatorToken.kind)
        && (ts.isPropertyAccessExpression(child.left) || ts.isElementAccessExpression(child.left))
        && processEnvEffects(checker, child.left) === undefined
        && effectsForEffectProperty(child.left, adapter) === undefined) { const effect = mutateEffect(child.left); if (observableMutation(effect, locals)) observe(effect, child); }
      if ((ts.isPrefixUnaryExpression(child) || ts.isPostfixUnaryExpression(child)) && (child.operator === ts.SyntaxKind.PlusPlusToken || child.operator === ts.SyntaxKind.MinusMinusToken) && (ts.isPropertyAccessExpression(child.operand) || ts.isElementAccessExpression(child.operand))) { const effect = mutateEffect(child.operand); if (observableMutation(effect, locals)) observe(effect, child); }
      if (ts.isCallExpression(child)) {
        const resolvedBuiltin = adapter.resolveCall(child);
        const primitive = primitiveEffects(child, adapter);
        for (const effect of primitive) if (observableMutation(effect, locals)) observe(effect, child);
        const networkBoundary = networkBoundaryFromEffects(child, resolvedBuiltin, primitive);
        if (networkBoundary) directNetworkBoundaries.get(graphNode.id)!.push(networkBoundary);
        const external = externalContractForCall(checker, child, options.externalFunctionEffects);
        if (external) {
          if (external.evidence !== "verified") unknownExternalEvidence.add(graphNode.id);
          const unboundedIterator = unboundedExternalIteratorParameter(external);
          if (unboundedIterator) {
            unknownExternalEvidence.add(graphNode.id);
            externalIteratorContractProblems.push({ id: graphNode.id, parameter: unboundedIterator, call: child });
          }
          for (const rawEffect of external.effects) {
            const effect = instantiateExternalEffect(rawEffect, external, child, checker);
            if (effect === undefined) {
              unknownExternalEvidence.add(graphNode.id);
              externalInstantiationProblems.push({ id: graphNode.id, effect: rawEffect, call: child });
              continue;
            }
            if (effect.kind === "throw" && (catches || asyncOwners.has(graphNode.id))) continue;
            if (observableMutation(effect, locals)) observe(effect, child);
          }
        }
        if (!resolvedBuiltin && !external && hasConfiguredExternalContractCandidate(checker, child, registry)) {
          unknownExternalEvidence.add(graphNode.id);
        }
      }
      ts.forEachChild(child, (next) => visit(next, catches));
    };
    visit(node.body, false);
  }
  const externalIteratorNames = new Map<string, string>();
  for (const [key, contract] of options.externalFunctionEffects ?? []) {
    externalIteratorNames.set(key, contract.functionName ?? key);
    if (contract.evidence !== "verified" || !contract.iteratorEffectBounds) continue;
    iteratorEffectBounds.set(key, new Map(contract.iteratorEffectBounds.map((bound) => [bound.index, {
      name: bound.name, effects: [...bound.effects],
    }])));
  }
  const inferred = new Map([...direct].map(([id, effects]) => [id, [...effects]]));
  const inferredNetworkBoundaries = new Map([...directNetworkBoundaries].map(([id, boundaries]) => [id, [...boundaries]]));
  const unknownTiming = new Set<string>(), unknownGeneratorEvidence = new Set<string>(), unknownGeneratorParameterEvidence = new Set<string>();
  const unknownMutationAliasEvidence = new Set<string>();
  const unknownMutationAliasSpans = new Map<string, { start: number; end: number }>();
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
      if (edge.unresolvedMutationAlias && inferred.get(edge.callee)!.some((effect) => effect.kind === "mutate"
        && calleeParams.some((parameter) => effect.region === parameter
          || effect.region.startsWith(`${parameter}.`) || effect.region.startsWith(`${parameter}[`)))) {
        unknownMutationAliasEvidence.add(edge.caller);
        if (!unknownMutationAliasSpans.has(edge.caller)) unknownMutationAliasSpans.set(edge.caller, edge.span);
      }
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
  let mutationAliasUnknownChanged = true;
  while (mutationAliasUnknownChanged) {
    mutationAliasUnknownChanged = false;
    for (const edge of graph.edges) {
      if (!edge.callee || !unknownMutationAliasEvidence.has(edge.callee)
        || unknownMutationAliasEvidence.has(edge.caller)) continue;
      unknownMutationAliasEvidence.add(edge.caller);
      unknownMutationAliasSpans.set(edge.caller, edge.span);
      mutationAliasUnknownChanged = true;
    }
  }
  let networkChanged = true;
  while (networkChanged) {
    networkChanged = false;
    for (const edge of [...graph.edges, ...implicitDisposalEdges]) {
      if (!edge.callee || edge.executesBody === false) continue;
      const caller = inferredNetworkBoundaries.get(edge.caller), callee = inferredNetworkBoundaries.get(edge.callee);
      if (!caller || !callee) continue;
      for (const boundary of callee) {
        const key = `${boundary.via}:${boundary.authority}:${boundary.target}:${boundary.fileName}:${boundary.line}`;
        if (caller.some((item) => `${item.via}:${item.authority}:${item.target}:${item.fileName}:${item.line}` === key)) continue;
        caller.push(boundary);
        networkChanged = true;
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
  const diagnostics: EffectDiagnostic[] = [...annotationProblems].flatMap(([fileName, problems]) => {
    const source = program.getSourceFile(fileName)!;
    return problems.map((problem) => annotationProblemDiagnostic(source, problem));
  });
  diagnostics.push(...effectDeclarationProblems.map((problem): EffectDiagnostic => {
    const graphNode = graphNodesById.get(problem.id)!;
    const source = program.getSourceFile(problem.fileName) ?? nodes.get(problem.id)!.getSourceFile();
    return {
      fileName: problem.fileName, functionName: graphNode.name, effect: problem.payload, kind: "invalid", severity: "error",
      line: source.getLineAndCharacterOfPosition(problem.start).line + 1,
      message: `invalid effect declaration for ${graphNode.name}: ${problem.message}`,
    };
  }));
  diagnostics.push(...effectParameterProblems.map((problem) => {
    invalidEffectParameterOwners.add(problem.id);
    const graphNode = graphNodesById.get(problem.id)!;
    const source = nodes.get(problem.id)!.getSourceFile();
    return { fileName: source.fileName, functionName: graphNode.name, effect: problem.payload, kind: "unknown" as const, severity: "error" as const, line: source.getLineAndCharacterOfPosition(problem.start).line + 1, message: problem.message };
  }));
  const summaries: EffectSummary[] = [];
  for (const problem of externalInstantiationProblems) {
    const graphNode = graphNodesById.get(problem.id)!, source = problem.call.getSourceFile();
    diagnostics.push({
      fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(problem.effect), kind: "unknown", severity: "error",
      line: source.getLineAndCharacterOfPosition(problem.call.getStart(source)).line + 1,
      message: `${graphNode.name} cannot instantiate ${formatEffect(problem.effect)} at ${snippet(problem.call, source)}; its region is not usable: the corresponding argument is missing, spread, or non-addressable, or the exact exported mutation root is not parent-visible`,
      notes: [{ label: "because", detail: "cross-project Mutate substitution accepts parameter-rooted addressable arguments and exported closure roots reached through a TypeChecker-identical named or namespace import; missing, spread, computed, inaccessible, and same-named-different regions fail closed" }],
    });
  }
  for (const problem of externalIteratorContractProblems) {
    const graphNode = graphNodesById.get(problem.id)!, source = problem.call.getSourceFile();
    diagnostics.push({
      fileName: source.fileName, functionName: graphNode.name, effect: problem.parameter.name, kind: "unknown", severity: "error",
      line: source.getLineAndCharacterOfPosition(problem.call.getStart(source)).line + 1,
      message: `${graphNode.name} cannot instantiate iterator effect parameter ${problem.parameter.name}; the external contract is missing a verified bound`,
      notes: [{ label: "because", detail: "a verified external iterator contract must provide one checked iteratorEffectBounds entry for every iteratorEffectParameters index" }],
    });
  }
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
      const graphNode = graphNodesById.get(owner)!;
      const targetName = graphNodesById.get(targetBound.owner)?.name ?? externalIteratorNames.get(targetBound.owner) ?? targetBound.owner;
      const source = nodes.get(owner)!.getSourceFile();
      invalidEffectParameterOwners.add(owner);
      invalidIteratorInstantiationCallers.add(owner);
      diagnostics.push({
        fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(effect), kind: "missing", severity: "error",
        line: source.getLineAndCharacterOfPosition(graphNode.span.start).line + 1,
        message: `${graphNode.name} effect_parameter ${sourceBound.name} allows ${formatEffect(effect)}, which is not compatible with forwarded constraint ${targetBound.name} of ${targetName}`,
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
      const consumerName = graphNodesById.get(bound.owner)?.name ?? externalIteratorNames.get(bound.owner) ?? bound.owner;
      const source = nodes.get(edge.caller)!.getSourceFile();
      diagnostics.push({
        fileName: source.fileName, functionName: caller.name, effect: formatEffect(effect), kind: "missing", severity: "error",
        line: source.getLineAndCharacterOfPosition(edge.span.start).line + 1,
        message: `${caller.name} instantiates iterator effect parameter ${bound.name} of ${consumerName} with ${formatEffect(effect)} outside its declared bound`,
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
    if (unknownMutationAliasEvidence.has(graphNode.id)) {
      const span = unknownMutationAliasSpans.get(graphNode.id) ?? graphNode.span;
      diagnostics.push({
        fileName: source.fileName,
        functionName: graphNode.name,
        effect: "Mutate<unknown-alias>",
        kind: "unknown",
        severity: "error",
        line: source.getLineAndCharacterOfPosition(span.start).line + 1,
        message: `${graphNode.name} passes or calls through a mutable object alias that is reassigned, escaping, computed, or otherwise not reducible to one addressable root`,
        notes: [{ label: "because", detail: "only one const, non-escaping, direct identifier/property alias can instantiate a parameter-rooted Mutate effect" }],
      });
    }
    for (const effect of allowed) if (!isKnownEffect(effect)) diagnostics.push({ fileName: source.fileName, functionName: graphNode.name, effect: formatEffect(effect), kind: "unknown", severity: options.mode === "strict" ? "error" : "warning", line, message: `${graphNode.name} declares unknown effect ${formatEffect(effect)}`, notes: unknownEffectNotes(allowed, effect) });
    for (const effect of actual) if (!permits(allowed, effect) && (declaredPresent.has(graphNode.id) || options.requireAnnotations !== false)) {
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
    const unknownReasons: EffectUnknownReason[] = [];
    const addUnknownReason = (code: EffectUnknownReasonCode, message: string): void => {
      if (!unknownReasons.some((reason) => reason.code === code)) unknownReasons.push({ code, message });
    };
    if (invalidSources.has(source.fileName)) addUnknownReason("typescript-errors", "TypeScript errors prevent proof-grade effect evidence");
    if (invalidAnnotationSources.has(source.fileName)) addUnknownReason("invalid-annotation", "an invalid Uneffect directive prevents proof-grade effect evidence");
    if (unknownTiming.has(graphNode.id)) addUnknownReason("unknown-callback-timing", "a callback may run at an unresolved time");
    if (unknownGeneratorEvidence.has(graphNode.id)) addUnknownReason("unknown-generator-consumption", "generator body execution or consumption count is unresolved");
    if (unknownGeneratorParameterEvidence.has(graphNode.id) && !polymorphicIterator) addUnknownReason("unknown-generator-parameter", "a caller-supplied iterator effect cannot be represented by this summary");
    if (invalidEffectParameterOwners.has(graphNode.id)) addUnknownReason("invalid-effect-parameter", "an effect_parameter annotation is invalid");
    if (invalidIteratorInstantiationCallers.has(graphNode.id)) addUnknownReason("invalid-iterator-instantiation", "an iterator effect argument exceeds or cannot satisfy its declared bound");
    if (unknownExternalEvidence.has(graphNode.id)) addUnknownReason("unknown-external-evidence", "a resolved external effect contract is unknown or cannot be instantiated at this call site");
    if (unknownMutationAliasEvidence.has(graphNode.id)) addUnknownReason("unresolved-mutation-alias", "a mutable object alias cannot be reduced to one non-escaping addressable root");
    if (polymorphicIterator && allowed.length > 0 && !fullyBoundIterator) addUnknownReason("unbounded-iterator-effect-parameter", "a declared function consumes caller-supplied iterator effects without an effect_parameter upper bound");
    const evidence: EvidenceStatus = invalidSources.has(source.fileName) || invalidAnnotationSources.has(source.fileName)
      || unknownTiming.has(graphNode.id) || unknownGeneratorEvidence.has(graphNode.id)
      || (unknownGeneratorParameterEvidence.has(graphNode.id) && !polymorphicIterator)
      || invalidEffectParameterOwners.has(graphNode.id)
      || invalidIteratorInstantiationCallers.has(graphNode.id)
      || unknownExternalEvidence.has(graphNode.id)
      || unknownMutationAliasEvidence.has(graphNode.id)
      || (polymorphicIterator && allowed.length > 0 && !fullyBoundIterator)
      ? "unknown" : fullyBoundIterator ? (own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified")
        : !declaredPresent.has(graphNode.id) ? "inferred" : own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified";
    if (evidence === "unknown" && unknownReasons.length === 0) addUnknownReason("effect-diagnostic", "an effect declaration or inferred authority diagnostic prevents proof-grade evidence");
    summaries.push({
      functionName: graphNode.name, effects: actual, evidence, id: graphNode.id, fileName: graphNode.fileName, span: graphNode.span,
      ...(unknownReasons.length > 0 ? { unknownReasons } : {}),
      parameters: parameters.get(graphNode.id) ?? [],
      ...(polymorphicIterator ? { iteratorEffectParameters: graphNode.iteratorEffectParameters } : {}),
      ...(bounds.size > 0 ? { iteratorEffectBounds: [...bounds].map(([index, bound]) => ({ index, ...bound })) } : {}),
      ...((inferredNetworkBoundaries.get(graphNode.id)?.length ?? 0) > 0
        ? { networkBoundaries: inferredNetworkBoundaries.get(graphNode.id) } : {}),
    });
  }

  // Module evaluation is a separate owner from every function body. Keeping a
  // source-attributed pseudo-summary prevents function evidence in a sibling
  // file from making executable top-level code disappear from assurance.
  const moduleRecords = new Map<string, {
    source: ts.SourceFile; id: string; effects: Effect[]; allowed: Effect[]; declaredPresent: boolean; declarationProblems: EffectDeclarationProblem[]; unknown: boolean; unknownReasons: EffectUnknownReason[]; trusted: boolean; dependencies: string[];
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
  const directlyReturnedFunction = (declaration: ts.FunctionLikeDeclaration): ts.FunctionLikeDeclaration | undefined => {
    if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)
      && (ts.isArrowFunction(declaration.body) || ts.isFunctionExpression(declaration.body))) return declaration.body;
    if (!declaration.body || !ts.isBlock(declaration.body) || declaration.body.statements.length !== 1) return undefined;
    const statement = declaration.body.statements[0];
    return statement && ts.isReturnStatement(statement) && statement.expression
      && (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))
      ? statement.expression : undefined;
  };
  const resolveStableFunctionChainEffects = (expression: ts.Expression, returnDepth: number): Effect[] | undefined => {
    let declaration = resolveStableFunctionDeclaration(expression);
    if (!declaration) return undefined;
    const effects: Effect[] = [];
    for (let depth = 0; depth <= returnDepth; depth += 1) {
      const declarationSource = declaration.getSourceFile();
      const current = inferred.get(`${declarationSource.fileName}:${declaration.getStart(declarationSource)}`);
      if (!current) return undefined;
      for (const effect of current) addEffect(effects, effect);
      if (depth < returnDepth) {
        const returned = directlyReturnedFunction(declaration);
        if (!returned) return undefined;
        declaration = returned;
      }
    }
    return effects;
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
    let unknown = false, trusted = false;
    const unknownReasons: EffectUnknownReason[] = [];
    const markUnknown = (code: EffectUnknownReasonCode, message: string): void => {
      unknown = true;
      if (!unknownReasons.some((reason) => reason.code === code)) unknownReasons.push({ code, message });
    };
    const addResolvedDependency = (specifier: ts.Expression, requireRelative = false): string | undefined => {
      if (!ts.isStringLiteralLike(specifier) || (requireRelative && !specifier.text.startsWith("."))) return undefined;
      const symbol = checker.getSymbolAtLocation(specifier);
      const symbolSource = symbol?.declarations?.find(ts.isSourceFile)?.getSourceFile();
      const resolvedFileName = symbolSource?.fileName ?? ts.resolveModuleName(
        specifier.text, source.fileName, program.getCompilerOptions(), moduleResolutionHost,
      ).resolvedModule?.resolvedFileName;
      const dependencySource = resolvedFileName ? program.getSourceFile(resolvedFileName) : undefined;
      if (!dependencySource || dependencySource.isDeclarationFile) {
        const external = resolvedFileName ? options.externalModuleEffects?.get(resolvedFileName) : undefined;
        if (!external) return undefined;
        if (external.evidence === "trusted") trusted = true;
        else if (external.evidence !== "verified") markUnknown("unknown-external-module", `external module effect evidence for ${resolvedFileName} is ${external.evidence}`);
        for (const rawEffect of external.effects) {
          const effect = instantiateExternalModuleEffect(rawEffect, external, source, checker);
          if (effect === undefined) markUnknown("unresolved-effect-instantiation", `an external module effect from ${resolvedFileName} cannot be instantiated in this module`);
          else addEffect(effects, effect);
        }
        return resolvedFileName;
      }
      if (dependencySource.fileName === source.fileName) return source.fileName;
      if (!dependencies.includes(dependencySource.fileName)) dependencies.push(dependencySource.fileName);
      return dependencySource.fileName;
    };
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
      if (!isRuntimeModuleDependency(statement)) continue;
      if (addResolvedDependency(statement.moduleSpecifier)) continue;
      const moduleName = ts.isStringLiteralLike(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
      const contract = resolveModuleInitializationContract(program, source.fileName, moduleName, registry);
      if (!contract) { markUnknown("unreviewed-external-module", `runtime initialization of ${moduleName || "an unresolved module"} has no reviewed contract`); continue; }
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
            if (!decoratorEffects) markUnknown("unresolved-decorator", "a decorator expression does not resolve to a stable analyzed function");
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
      if (adapter.mayInvokeUserCode(node) && !resolvedDynamicDependency && !resolvedAwaitedDynamicDependency) markUnknown("possible-user-code", "a top-level operation may invoke user code outside the resolved call graph");
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) for (const effect of effectsForDomProperty(node, adapter) ?? []) {
        if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) for (const effect of effectsForEffectProperty(node, adapter) ?? []) addEffect(effects, effect);
      if (ts.isElementAccessExpression(node)) for (const effect of effectsForDynamicDomProperty(node, adapter)) {
        if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
      }
      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        && effectsForEffectProperty(node.left, adapter) === undefined) {
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
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword && !resolvedDynamicDependency) markUnknown("unresolved-dynamic-import", "a dynamic import specifier does not resolve to a selected relative source module");
        const resolvedBuiltin = adapter.resolveCall(node), primitive = primitiveEffects(node, adapter);
        for (const effect of primitive) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
        const external = externalContractForCall(checker, node, options.externalFunctionEffects);
        if (external) {
          if (external.evidence !== "verified") markUnknown("unknown-external-evidence", `external function effect evidence is ${external.evidence}`);
          for (const rawEffect of external.effects) {
            const effect = instantiateExternalEffect(rawEffect, external, node, checker);
            if (effect === undefined) markUnknown("unresolved-effect-instantiation", "an external function effect cannot be instantiated at this top-level call site");
            else if (!(effect.kind === "throw" && catches) && observableMutation(effect, moduleLocals)) addEffect(effects, effect);
          }
        }
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
          if (!inferred.has(targetId) && primitive.length === 0 && !resolvedBuiltin && !external) markUnknown("unresolved-call", "a top-level call target has no analyzed effect summary or reviewed contract");
        } else if (!resolvedDynamicDependency && primitive.length === 0 && !resolvedBuiltin && !external) markUnknown("unresolved-call", "a top-level call target cannot be resolved by TypeChecker identity or a reviewed contract");
        const callbackIndices = new Set(graphNodesById.get(targetId ?? "")?.effectParameters.map((parameter) => parameter.index) ?? []);
        const operation = resolvedBuiltin?.operation;
        const builtinCallbacks = operation?.kind === "inline-callback"
          ? operation.callbackArguments
          : operation?.kind === "timer" || operation?.kind === "scheduler-post-task"
          ? [operation.callbackArgument]
          : operation?.kind === "fs" && operation.callbackArgumentFromEnd
            ? [node.arguments.length - operation.callbackArgumentFromEnd]
            : operation?.kind === "deferred-callback"
              ? [node.arguments.length - operation.callbackArgumentFromEnd] : [];
        for (const builtinCallback of builtinCallbacks) callbackIndices.add(builtinCallback);
        for (const index of callbackIndices) {
          const callback = node.arguments[index];
          if (!callback) {
            if (operation?.kind !== "inline-callback" || !operation.optionalCallbackArguments?.includes(index)) {
              markUnknown("unresolved-callback", "a callback-owning call omits its expected callback argument");
            }
            continue;
          }
          const callbackEffects = resolveStableFunctionEffects(callback);
          if (!callbackEffects) { markUnknown("unresolved-callback", "a callback argument is mutable, dynamic, or lacks an analyzed function body"); continue; }
          for (const effect of callbackEffects) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
        }
        if (operation?.kind === "inline-callback") for (const index of operation.callbackArrayArguments ?? []) {
          const argument = node.arguments[index];
          if (!argument || !ts.isArrayLiteralExpression(argument)) {
            markUnknown("unresolved-callback", "a reviewed callback-array argument is not an array literal");
            continue;
          }
          for (const element of argument.elements) {
            if (!ts.isExpression(element)) {
              markUnknown("unresolved-callback", "a reviewed callback array contains a spread or omitted element");
              continue;
            }
            const callbackEffects = resolveStableFunctionChainEffects(element, operation.callbackArrayReturnDepth ?? 0);
            if (!callbackEffects) {
              markUnknown("unresolved-callback", "a callback-array element or its invoked return is mutable, dynamic, or lacks an analyzed function body");
              continue;
            }
            for (const effect of callbackEffects) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
          }
        }
        for (const callback of resolvedBuiltin?.capturedCallbacks ?? []) {
          const callbackEffects = resolveStableFunctionEffects(callback);
          if (!callbackEffects) { markUnknown("unresolved-callback", "a captured callback is mutable, dynamic, or lacks an analyzed function body"); continue; }
          for (const effect of callbackEffects) if (observableMutation(effect, moduleLocals)) addEffect(effects, effect);
        }
      }
      ts.forEachChild(node, (child) => visit(child, catches));
    };
    for (const statement of executable) visit(statement, false);

    const moduleHeader = source.text.slice(0, source.statements[0]?.getStart(source) ?? source.end);
    const moduleDeclaration = parseEffectDeclarations(moduleHeader, "module_effect", 0);
    const allowed = moduleDeclaration.effects;
    if (moduleDeclaration.problems.length > 0) markUnknown("effect-diagnostic", "the module effect declaration is invalid");
    if (invalidSources.has(source.fileName)) markUnknown("typescript-errors", "TypeScript errors prevent proof-grade module effect evidence");
    if (invalidAnnotationSources.has(source.fileName)) markUnknown("invalid-annotation", "an invalid Uneffect directive prevents proof-grade module effect evidence");
    moduleRecords.set(source.fileName, { source, id, effects, allowed, declaredPresent: moduleDeclaration.present, declarationProblems: moduleDeclaration.problems, unknown, unknownReasons, trusted, dependencies });
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
      if (dependency.unknown && !record.unknown) {
        record.unknown = true;
        record.unknownReasons.push({ code: "unknown-dependency", message: `runtime dependency ${dependency.source.fileName} has unknown module effects` });
        changedModules = true;
      }
      if (dependency.trusted && !record.trusted) { record.trusted = true; changedModules = true; }
      for (const effect of dependency.effects) if (!record.effects.some((item) => formatEffect(item) === formatEffect(effect))) {
        record.effects.push(effect);
        changedModules = true;
      }
    }
  }

  for (const { source, id, effects, allowed, declaredPresent: moduleDeclared, declarationProblems: moduleProblems, unknown, unknownReasons, trusted } of moduleRecords.values()) {
    const line = 1;
    for (const problem of moduleProblems) diagnostics.push({
      fileName: source.fileName, functionName: "<module>", effect: problem.payload, kind: "invalid", severity: "error",
      line: source.getLineAndCharacterOfPosition(problem.start).line + 1,
      message: `invalid module effect declaration: ${problem.message}`,
    });
    for (const effect of allowed) if (!isKnownEffect(effect)) diagnostics.push({
      fileName: source.fileName, functionName: "<module>", effect: formatEffect(effect), kind: "unknown",
      severity: options.mode === "strict" ? "error" : "warning", line,
      message: `<module> declares unknown effect ${formatEffect(effect)}`,
      notes: unknownEffectNotes(allowed, effect),
    });
    for (const effect of effects) if (!permits(allowed, effect) && (moduleDeclared || options.requireAnnotations !== false)) diagnostics.push({
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
    const evidence: EvidenceStatus = invalidSources.has(source.fileName) || unknown ? "unknown" : trusted ? "trusted" : !moduleDeclared ? (effects.length === 0 ? "verified" : "inferred")
      : own.some((diagnostic) => diagnostic.severity === "error") ? "unknown" : "verified";
    if (evidence === "unknown" && unknownReasons.length === 0) unknownReasons.push({ code: "effect-diagnostic", message: "a module effect declaration or inferred authority diagnostic prevents proof-grade evidence" });
    summaries.push({
      functionName: "<module>", effects, evidence, id, fileName: source.fileName, span: { start: 0, end: source.end },
      ...(unknownReasons.length > 0 ? { unknownReasons } : {}),
    });
  }
  return { diagnostics, summaries };
}

import ts from "@typescript/typescript6";
import { bindingIdentity, type BindingIdentity } from "./binding-identity.js";
import { extractAnnotations, extractLocatedAnnotations } from "./annotations.js";
import type { DiagnosticNote } from "./diagnostics.js";
import { resolveDisposalProtocol } from "./disposal-symbols.js";
import { logicToSmt, parseLogicExpression, proveBooleanImplication, type LogicExpression } from "./invariant-ir.js";
import { analyzePromiseChainsInProgram, type PromiseChainModel } from "./promise-chains.js";
import { solveBasicBlockFixedPoint } from "./refinement-flow.js";
import { evaluateStaticPrimitive } from "./static-evaluation.js";
import {
  breakTransferTarget,
  continueTransferTarget,
  formatTargetedCompletion,
  isLoopTransfer,
  isTransferOwnedByLoop,
  type CompletionKind,
  type CompletionPath,
  type CompletionTarget,
  type LoopTransferKind,
} from "./completion-flow.js";

export type PromiseObservationKind = "await" | "return" | "catch" | "then-rejection" | "ignored" | "floating";
const PROMISE_OWNERSHIP_CFG_ITERATIONS = 128;
export interface AsyncControlCondition {
  id: string;
  expected: boolean;
  role?: "branch" | "fallthrough";
}
export interface PromiseObservation {
  owner: string;
  source: string;
  observation: PromiseObservationKind;
  catchesRejection: boolean;
  conditional: boolean;
  controlConditions: AsyncControlCondition[];
  controlPaths: AsyncControlCondition[][];
  promiseChain?: number;
  span: { start: number; end: number };
}
export interface PromiseBinding {
  owner: string;
  binding: string;
  /** SSA-like ownership generation for one mutable binding. Immutable aliases share it. */
  generation: number;
  status: "floating" | "transferred" | "observed";
  observations: string[];
  /** Stable within this source snapshot; spelling is diagnostic-only. */
  identity?: BindingIdentity;
  span: { start: number; end: number };
}
export interface ResourceBinding {
  owner: string;
  ownerAsync: boolean;
  binding: string;
  asynchronous: boolean;
  conditional: boolean;
  controlConditions: AsyncControlCondition[];
  controlPaths: AsyncControlCondition[][];
  acquisitionIndex: number;
  scopeId: string;
  scopeDepth: number;
  scopeEnd: number;
  catchesFailure: boolean;
  initializerMayFail: true;
  /** True only for a source-authenticated direct `await` in the initializer. */
  initializerAwaited: boolean;
  disposalFailureType: string;
  disposalProtocol?: {
    kind: "sync" | "async";
    fileName: string;
    start: number;
    end: number;
  };
  span: { start: number; end: number };
}
export type ResourceExit = "normal" | "return" | "throw" | "reject";
export interface ResourceDisposal {
  owner: string;
  binding: string;
  order: number;
  asynchronous: boolean;
  scopeId: string;
  scopeDepth: number;
  disposalPoint: number;
  mayFail: true;
  failureKind: "throw" | "reject";
  failureType: string;
  catchesFailure: boolean;
  escapingFailure: "none" | "throw" | "reject";
  exits: ResourceExit[];
}
export interface ResourceAliasEscape {
  owner: string;
  resource: string;
  alias: string;
  generation: {
    acquisitionIndex: number;
    repeated: boolean;
    relation: "single" | "latest" | "conditional";
    controlPaths: AsyncControlCondition[][];
    snapshot: string;
  };
  assignmentSpan: { start: number; end: number };
  useSpan: { start: number; end: number };
}
export interface ResourceEscape {
  owner: string;
  resource: string;
  via: "return" | "returned-closure" | "retaining-call" | "retaining-construction";
  span: { start: number; end: number };
}
export interface AsyncSafetyDiagnostic {
  fileName: string;
  functionName: string;
  line: number;
  kind: "floating-promise" | "floating-callback-promise" | "invalid-disposable" | "invalid-ownership-contract" | "invalid-resource-contract" | "disposed-resource-use" | "disposed-resource-escape" | "unsupported-control-transfer";
  severity: "error";
  message: string;
  notes?: DiagnosticNote[];
}
export interface AsyncSafetyResult {
  fileName: string;
  promises: PromiseObservation[];
  promiseBindings: PromiseBinding[];
  resources: ResourceBinding[];
  resourceAliases: ResourceAliasEscape[];
  resourceEscapes: ResourceEscape[];
  disposals: ResourceDisposal[];
  promiseChains: PromiseChainModel;
  controlEdges: AsyncControlEdge[];
  controlRegions: AsyncControlRegion[];
  controlStatements: AsyncControlStatement[];
  controlTransferOwners: AsyncControlTransferOwner[];
  returnCompletions: AsyncReturnCompletion[];
  throwCompletions: AsyncThrowCompletion[];
  resourceSwitches: ResourceSwitchDecision[];
  resourceIfs: ResourceIfDecision[];
  ownershipObligations: OwnershipGuardObligation[];
  diagnostics: AsyncSafetyDiagnostic[];
}
export interface AsyncReturnCompletion {
  owner: string;
  controlPaths: AsyncControlCondition[][];
  span: { start: number; end: number };
}
export interface AsyncThrowCompletion {
  owner: string;
  errorType: string;
  errorLike: boolean;
  controlPaths: AsyncControlCondition[][];
  span: { start: number; end: number };
}
export interface ResourceSwitchDecision {
  id: string;
  owner: string;
  discriminant: "finite-string-identifier" | "unsupported";
  hasDefault: boolean;
  caseCount: number;
  span: { start: number; end: number };
}
export interface ResourceIfDecision {
  id: string;
  owner: string;
  predicate: "boolean-identifier" | "unsupported";
  span: { start: number; end: number };
}
export interface AsyncControlRegion {
  id: string;
  owner: string;
  trySpan: { start: number; end: number };
  fullSpan: { start: number; end: number };
  catchSpan?: { start: number; end: number };
  finallySpan?: { start: number; end: number };
}
export interface AsyncControlStatement {
  regionId: string;
  owner: string;
  region: "catch" | "finally";
  order: number;
  completion: CompletionKind;
  completionPaths: AsyncControlCompletionPath[];
  loop?: AsyncControlLoop;
  source: string;
  span: { start: number; end: number };
}
export interface AsyncControlLoop {
  id: string;
  kind: "while" | "for" | "for-in" | "for-of" | "do-while";
  atLeastOnce: boolean;
}
export interface AsyncControlCompletionPath extends CompletionPath<AsyncControlCondition> {
  controlConditions: AsyncControlCondition[];
  target?: CompletionTarget;
  ownerId?: string;
}
export interface AsyncControlTransferOwner {
  id: string;
  owner: string;
  regionId: string;
  label?: string;
  kind: AsyncControlLoop["kind"];
  transfers: LoopTransferKind[];
  iterationEvidence: "exact" | "dynamic";
  iterations?: number;
  span: { start: number; end: number };
  bodySpan: { start: number; end: number };
}
export interface OwnershipGuardObligation {
  owner: string;
  callee: string;
  ownership: "promise" | "callback";
  parameter: number;
  assumptions: string[];
  goal: string;
  status: "verified" | "unresolved";
  evidence: "finite-propositional" | "unknown";
  span: { start: number; end: number };
}
export interface AsyncSafetyOptions { allowVoid?: boolean }
export interface AsyncControlEdge {
  owner: string;
  from: string;
  to: string;
  kind: "promise-fulfill" | "promise-reject-caught" | "promise-reject-escapes" | "scope-exit" | "disposal-throw-caught" | "disposal-throw-escapes" | "disposal-reject-caught" | "disposal-reject-escapes";
}
export type ResourceError =
  | { kind: "error"; errorType: string; source: string }
  | { kind: "suppressed"; error: ResourceError; suppressed: ResourceError };

function functionName(node: ts.SignatureDeclaration): string {
  if ("name" in node && node.name) return node.name.getText();
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  return "<anonymous>";
}
function enclosingFunctionName(node: ts.Node): string {
  for (let current = node.parent; current; current = current.parent) if (ts.isFunctionLike(current)) return functionName(current);
  return "<module>";
}
function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}
function switchControlConditions(owner: string, source: ts.SourceFile, clause: ts.CaseOrDefaultClause): AsyncControlCondition[] {
  const switchStatement = clause.parent.parent;
  if (!ts.isSwitchStatement(switchStatement)) return [];
  const cases = switchStatement.caseBlock.clauses.filter(ts.isCaseClause);
  const id = (index: number): string => `${owner}@switch:${switchStatement.getStart(source)}:case:${index}`;
  if (ts.isDefaultClause(clause)) return cases.map((_, index) => ({ id: id(index), expected: false }));
  const selected = cases.indexOf(clause);
  return cases.slice(0, selected).map((_, index) => ({ id: id(index), expected: false })).concat({ id: id(selected), expected: true });
}
function switchControlPaths(owner: string, source: ts.SourceFile, clause: ts.CaseOrDefaultClause): AsyncControlCondition[][] {
  const clauses = clause.parent.clauses;
  const target = clauses.indexOf(clause);
  const stopsFallthrough = (statement: ts.Statement): boolean => {
    if ((ts.isBreakStatement(statement) && !statement.label) || ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return true;
    if (ts.isBlock(statement)) return statement.statements.some(stopsFallthrough);
    if (ts.isIfStatement(statement) && statement.elseStatement) {
      return stopsFallthrough(statement.thenStatement) && stopsFallthrough(statement.elseStatement);
    }
    return false;
  };
  const fallsThrough = (candidate: ts.CaseOrDefaultClause): boolean => !candidate.statements.some(stopsFallthrough);
  const entries: ts.CaseOrDefaultClause[] = [];
  for (let index = 0; index <= target; index++) {
    let reaches = true;
    for (let cursor = index; cursor < target; cursor++) if (!fallsThrough(clauses[cursor]!)) { reaches = false; break; }
    if (reaches) entries.push(clauses[index]!);
  }
  return entries.map((entry) => switchControlConditions(owner, source, entry));
}
function isPromiseLike(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  const type = checker.getTypeAtLocation(expression);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return false;
  return Boolean(checker.getPropertyOfType(type, "then"));
}
function catchesAwaitRejection(node: ts.AwaitExpression): boolean {
  let child: ts.Node = node;
  for (let parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (ts.isTryStatement(parent) && parent.catchClause && child === parent.tryBlock) return true;
  }
  return false;
}
function handledChain(expression: ts.Expression): "catch" | "then-rejection" | undefined {
  if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
  const name = expression.expression.name.text;
  if (name === "catch" && expression.arguments[0] && expression.arguments[0].kind !== ts.SyntaxKind.NullKeyword) return "catch";
  if (name === "then" && expression.arguments[1] && expression.arguments[1].kind !== ts.SyntaxKind.NullKeyword) return "then-rejection";
  if (name === "finally") return handledChain(expression.expression.expression);
  return undefined;
}
function disposableProperties(checker: ts.TypeChecker, expression: ts.Expression): { sync: boolean; async: boolean; syncSymbol?: ts.Symbol; asyncSymbol?: ts.Symbol } {
  const { syncSymbol, asyncSymbol } = resolveDisposalProtocol(checker, expression);
  return {
    sync: Boolean(syncSymbol), async: Boolean(asyncSymbol), syncSymbol, asyncSymbol,
  };
}

function disposalFailureType(symbol: ts.Symbol | undefined): string {
  for (const declaration of symbol?.declarations ?? []) {
    const source = declaration.getSourceFile();
    const comments = source.text.slice(declaration.getFullStart(), declaration.getStart(source));
    for (const effect of extractAnnotations(comments, "effect")) {
      const match = /(?:^|\|)\s*Throw<\s*([^>]+?)\s*>/.exec(effect);
      if (match) return match[1]!.trim();
    }
    const rejected = extractAnnotations(comments, "temporal_rejects")[0];
    if (rejected) return rejected;
  }
  return "unknown";
}

function declaresSynchronousThrow(declaration: ts.Declaration | undefined): boolean {
  if (!declaration) return false;
  const source = declaration.getSourceFile();
  const comments = source.text.slice(declaration.getFullStart(), declaration.getStart(source));
  return extractAnnotations(comments, "effect").some((effect) => /(?:^|\|)\s*Throw<\s*[^>]+?\s*>/.test(effect));
}

interface IndexedOwnershipContract {
  indices: Set<number>;
  errors: { position: number; message: string }[];
}

function directUnconditionalExpressions(signature: ts.SignatureDeclaration): ts.Expression[] {
  if (!("body" in signature) || !signature.body) return [];
  const expressions: ts.Expression[] = ts.isBlock(signature.body)
    ? signature.body.statements.flatMap((statement) =>
      ts.isExpressionStatement(statement) ? [statement.expression]
        : ts.isReturnStatement(statement) && statement.expression ? [statement.expression] : [])
    : [signature.body];
  return expressions.map((original) => {
    let expression = original;
    while (ts.isParenthesizedExpression(expression) || ts.isAwaitExpression(expression)) expression = expression.expression;
    return expression;
  });
}

type IndexedOwnershipDirective = "consumes_rejection" | "consumes_callback_rejection" | "retains_resource";
function parseIndexedOwnershipContract(declaration: ts.SignatureDeclaration, directive: IndexedOwnershipDirective): IndexedOwnershipContract {
  const source = declaration.getSourceFile();
  const start = declaration.getFullStart();
  const comments = source.text.slice(start, declaration.getStart(source));
  const indices = new Set<number>();
  const errors: IndexedOwnershipContract["errors"] = [];
  for (const annotation of extractLocatedAnnotations(comments, directive, start)) {
    for (const raw of annotation.value.split(",")) {
      const item = raw.trim();
      if (!/^(0|[1-9]\d*)$/.test(item)) {
        errors.push({ position: annotation.span.start, message: `${directive} expects zero-based parameter indices; received ${JSON.stringify(item)}` });
        continue;
      }
      const index = Number(item);
      if (index >= declaration.parameters.length) {
        errors.push({ position: annotation.span.start, message: `${directive} index ${index} is out of range for ${declaration.parameters.length} parameter(s)` });
        continue;
      }
      indices.add(index);
    }
  }
  return { indices, errors };
}

function resourceRetentionParameters(
  checker: ts.TypeChecker,
  call: ts.CallExpression | ts.NewExpression,
  cache: Map<ts.SignatureDeclaration, ReadonlySet<number>>,
  seen = new Set<ts.SignatureDeclaration>(),
  contextFacts: readonly string[] = [],
): Set<number> {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || declaration.kind === ts.SyntaxKind.JSDocSignature) return new Set();
  const signature = declaration as ts.SignatureDeclaration;
  const invocationFacts: string[] = [];
  let caller: ts.Node | undefined = call.parent;
  while (caller && !ts.isFunctionLike(caller)) caller = caller.parent;
  const callerFacts = caller && ts.isFunctionLike(caller)
    ? extractAnnotations(caller.getSourceFile().text.slice(caller.getFullStart(), caller.getStart(caller.getSourceFile())), "requires")
    : [];
  const booleanOrigin = (expression: ts.Expression, aliasSeen = new Set<ts.Symbol>()): ts.Expression => {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
      || ts.isNonNullExpression(expression)) expression = expression.expression;
    if (!ts.isIdentifier(expression)) return expression;
    const symbol = checker.getSymbolAtLocation(expression), value = symbol?.valueDeclaration;
    if (!symbol || aliasSeen.has(symbol) || !value || !ts.isVariableDeclaration(value) || !value.initializer
      || !ts.isVariableDeclarationList(value.parent)
      || (ts.getCombinedNodeFlags(value.parent) & ts.NodeFlags.Const) === 0) return expression;
    return booleanOrigin(value.initializer, new Set(aliasSeen).add(symbol));
  };
  const availableCallerFacts = [...contextFacts, ...callerFacts];
  signature.parameters.forEach((parameter, index) => {
    const argument = call.arguments?.[index];
    if (!argument || !ts.isIdentifier(parameter.name)) return;
    const type = checker.typeToString(checker.getTypeAtLocation(argument));
    if (argument.kind === ts.SyntaxKind.TrueKeyword || type === "true") invocationFacts.push(parameter.name.text);
    if (argument.kind === ts.SyntaxKind.FalseKeyword || type === "false") invocationFacts.push(`!(${parameter.name.text})`);
    if (availableCallerFacts.length > 0) {
      const origin = booleanOrigin(argument).getText();
      if (proveBooleanImplication(availableCallerFacts, origin)) invocationFacts.push(parameter.name.text, argument.getText());
      if (proveBooleanImplication(availableCallerFacts, `!(${origin})`)) invocationFacts.push(`!(${parameter.name.text})`, `!(${argument.getText()})`);
    }
  });
  const effectiveFacts = [...contextFacts, ...invocationFacts];
  const signatureSource = signature.getSourceFile(), signatureStart = signature.getFullStart();
  const hasConditionalRetention = extractLocatedAnnotations(
    signatureSource.text.slice(signatureStart, signature.getStart(signatureSource)), "retains_resource_when", signatureStart,
  ).length > 0;
  const contextDependent = hasConditionalRetention || effectiveFacts.length > 0;
  const cached = contextDependent ? undefined : cache.get(signature);
  if (cached) return new Set(cached);
  const retained = parseIndexedOwnershipContract(signature, "retains_resource").indices;
  for (const index of conditionalOwnershipParameters(checker, signature, call, "retains_resource_when", effectiveFacts).indices) retained.add(index);
  if (!("body" in signature) || !signature.body) {
    if (!contextDependent) cache.set(signature, retained);
    return retained;
  }
  if (seen.has(signature)) return retained;
  const nextSeen = new Set(seen).add(signature);
  const parameterSymbols = signature.parameters.map((parameter) => checker.getSymbolAtLocation(parameter.name));
  const parameterOrigin = (expression: ts.Expression, aliasSeen = new Set<ts.Symbol>()): number => {
    while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
      || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
      || ts.isNonNullExpression(expression)) expression = expression.expression;
    if (!ts.isIdentifier(expression)) return -1;
    const symbol = checker.getSymbolAtLocation(expression);
    const parameterIndex = parameterSymbols.indexOf(symbol);
    if (parameterIndex >= 0) return parameterIndex;
    const declaration = symbol?.valueDeclaration;
    if (!symbol || aliasSeen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent)
      || (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0) return -1;
    return parameterOrigin(declaration.initializer, new Set(aliasSeen).add(symbol));
  };
  const visit = (node: ts.Node): void => {
    if (node !== signature.body && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) for (const nestedIndex of resourceRetentionParameters(checker, node, cache, nextSeen, effectiveFacts)) {
      const argument = node.arguments?.[nestedIndex];
      if (!argument) continue;
      const parameterIndex = parameterOrigin(argument);
      if (parameterIndex >= 0) retained.add(parameterIndex);
    }
    ts.forEachChild(node, visit);
  };
  visit(signature.body);
  if (!contextDependent) cache.set(signature, retained);
  return retained;
}

type ConditionalOwnershipDirective = "consumes_rejection_when" | "consumes_callback_rejection_when" | "retains_resource_when";
function ownershipGuardEvidence(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression, declaration: ts.SignatureDeclaration, guardSource: string, additionalFacts: readonly string[] = []): { assumptions: string[]; goal: string; verified: boolean } {
  let instantiated = guardSource;
  declaration.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name) || !call.arguments?.[index]) return;
    instantiated = instantiated.replace(new RegExp(`\\b${parameter.name.text}\\b`, "g"), `(${call.arguments[index]!.getText()})`);
  });
  const facts: string[] = [...additionalFacts];
  call.arguments?.forEach((argument) => {
    const text = argument.getText();
    const type = checker.typeToString(checker.getTypeAtLocation(argument));
    if (argument.kind === ts.SyntaxKind.TrueKeyword || type === "true") facts.push(text);
    if (argument.kind === ts.SyntaxKind.FalseKeyword || type === "false") facts.push(`!(${text})`);
  });
  let owner: ts.Node | undefined = call.parent;
  while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
  if (owner && ts.isFunctionLike(owner)) {
    const source = owner.getSourceFile();
    facts.push(...extractAnnotations(source.text.slice(owner.getFullStart(), owner.getStart(source)), "requires"));
  }
  return { assumptions: facts, goal: instantiated, verified: proveBooleanImplication(facts, instantiated) };
}
function guardProvenTrue(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression, declaration: ts.SignatureDeclaration, guardSource: string, additionalFacts: readonly string[] = []): boolean {
  return ownershipGuardEvidence(checker, call, declaration, guardSource, additionalFacts).verified;
}
function guardProvenFalse(checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression, declaration: ts.SignatureDeclaration, guardSource: string, additionalFacts: readonly string[] = []): boolean {
  return ownershipGuardEvidence(checker, call, declaration, `!(${guardSource})`, additionalFacts).verified;
}

function conditionalOwnershipParameters(
  checker: ts.TypeChecker | undefined,
  declaration: ts.SignatureDeclaration,
  call: ts.CallExpression | ts.NewExpression | undefined,
  directive: ConditionalOwnershipDirective,
  additionalFacts: readonly string[] = [],
): IndexedOwnershipContract {
  const source = declaration.getSourceFile();
  const start = declaration.getFullStart();
  const comments = source.text.slice(start, declaration.getStart(source));
  const indices = new Set<number>();
  const errors: IndexedOwnershipContract["errors"] = [];
  for (const annotation of extractLocatedAnnotations(comments, directive, start)) {
    const match = /^(0|[1-9]\d*)\s*:\s*(.+)$/.exec(annotation.value);
    if (!match) {
      errors.push({ position: annotation.span.start, message: `${directive} expects <parameter-index>: <boolean-parameter-name>` });
      continue;
    }
    const target = Number(match[1]);
    if (target >= declaration.parameters.length) errors.push({ position: annotation.span.start, message: `${directive} index ${target} is out of range for ${declaration.parameters.length} parameter(s)` });
    else {
      try {
        const expression = parseLogicExpression(match[2]!);
        const names = new Set<string>();
        const collect = (value: typeof expression): void => {
          if (value.kind === "variable") names.add(value.name);
          else if (value.kind === "unary") collect(value.operand);
          else if (value.kind === "binary") { collect(value.left); collect(value.right); }
        };
        collect(expression);
        const parameters = new Set(declaration.parameters.flatMap((parameter) => ts.isIdentifier(parameter.name) ? [parameter.name.text] : []));
        const missing = [...names].find((name) => !parameters.has(name));
        if (missing) errors.push({ position: annotation.span.start, message: `${directive} guard ${missing} is not a parameter` });
        else if (call && checker && (directive === "retains_resource_when"
          ? !guardProvenFalse(checker, call, declaration, match[2]!, additionalFacts)
          : guardProvenTrue(checker, call, declaration, match[2]!, additionalFacts))) indices.add(target);
      } catch {
        errors.push({ position: annotation.span.start, message: `${directive} has an invalid boolean guard` });
      }
    }
  }
  return { indices, errors };
}

function rejectionConsumerParameters(checker: ts.TypeChecker, call: ts.CallExpression, seen = new Set<ts.SignatureDeclaration>()): Set<number> {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || declaration.kind === ts.SyntaxKind.JSDocSignature) return new Set();
  const signature = declaration as ts.SignatureDeclaration;
  const consumed = parseIndexedOwnershipContract(signature, "consumes_rejection").indices;
  for (const index of conditionalOwnershipParameters(checker, signature, call, "consumes_rejection_when").indices) consumed.add(index);
  if (seen.has(signature) || !("body" in signature) || !signature.body) return consumed;
  const nextSeen = new Set(seen).add(signature);
  const parameterSymbols = signature.parameters.map((parameter) => checker.getSymbolAtLocation(parameter.name));
  for (const expression of directUnconditionalExpressions(signature)) {
    if (ts.isCallExpression(expression)) for (const nestedIndex of rejectionConsumerParameters(checker, expression, nextSeen)) {
      const argument = expression.arguments[nestedIndex];
      if (!argument || !ts.isIdentifier(argument)) continue;
      const symbol = checker.getSymbolAtLocation(argument);
      const parameterIndex = parameterSymbols.indexOf(symbol);
      if (parameterIndex >= 0) consumed.add(parameterIndex);
    }
  }
  return consumed;
}

function callbackRejectionConsumerParameters(checker: ts.TypeChecker, call: ts.CallExpression, seen = new Set<ts.SignatureDeclaration>()): Set<number> {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || declaration.kind === ts.SyntaxKind.JSDocSignature) return new Set();
  const signature = declaration as ts.SignatureDeclaration;
  const consumed = parseIndexedOwnershipContract(signature, "consumes_callback_rejection").indices;
  for (const index of conditionalOwnershipParameters(checker, signature, call, "consumes_callback_rejection_when").indices) consumed.add(index);
  if (ts.isMethodSignature(signature) && ts.isInterfaceDeclaration(signature.parent)) {
    const owner = signature.parent.name.text;
    const name = signature.name.getText();
    const standardLibrary = /(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/.test(signature.getSourceFile().fileName);
    if (standardLibrary && (owner === "Promise" || owner === "PromiseLike")) {
      if (name === "then") { consumed.add(0); consumed.add(1); }
      if (name === "catch" || name === "finally") consumed.add(0);
    }
  }
  if (seen.has(signature) || !("body" in signature) || !signature.body) return consumed;
  const nextSeen = new Set(seen).add(signature);
  const parameterSymbols = signature.parameters.map((parameter) => checker.getSymbolAtLocation(parameter.name));
  for (const expression of directUnconditionalExpressions(signature)) {
    if (ts.isCallExpression(expression)) for (const nestedIndex of callbackRejectionConsumerParameters(checker, expression, nextSeen)) {
      const argument = expression.arguments[nestedIndex];
      if (!argument || !ts.isIdentifier(argument)) continue;
      const parameterIndex = parameterSymbols.indexOf(checker.getSymbolAtLocation(argument));
      if (parameterIndex >= 0) consumed.add(parameterIndex);
    }
  }
  return consumed;
}

function isPromiseReturningCallback(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  return checker.getTypeAtLocation(expression).getCallSignatures().some((signature) =>
    Boolean(checker.getPropertyOfType(signature.getReturnType(), "then")));
}

const standardArrayOwners = new Set(["Array", "ReadonlyArray"]);
const standardMapMethods = new Set(["map"]);
const standardPromiseConstructorOwners = new Set(["PromiseConstructor"]);
const standardPromiseAggregateMethods = new Set(["all", "allSettled", "race", "any"]);

function isStandardLibraryMethodCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  owners: ReadonlySet<string>,
  methods: ReadonlySet<string>,
): boolean {
  const declaration = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || declaration.kind === ts.SyntaxKind.JSDocSignature
    || !/(?:^|[/\\])lib\.[^/\\]+\.d\.ts$/.test(declaration.getSourceFile().fileName)) return false;
  const named = declaration as ts.SignatureDeclaration & { name?: ts.PropertyName };
  if (!named.name || !methods.has(named.name.getText(declaration.getSourceFile()))) return false;
  return ts.isInterfaceDeclaration(declaration.parent) && owners.has(declaration.parent.name.text);
}

function callbackRejectionTransferredToPromiseAggregate(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  callbackIndex: number,
): boolean {
  if (callbackIndex !== 0 || !isStandardLibraryMethodCall(
    checker, call, standardArrayOwners, standardMapMethods,
  )) return false;
  let result: ts.Expression = call;
  while (ts.isParenthesizedExpression(result.parent) || ts.isAsExpression(result.parent)
    || ts.isTypeAssertionExpression(result.parent) || ts.isSatisfiesExpression(result.parent)
    || ts.isNonNullExpression(result.parent)) result = result.parent;
  const aggregate = result.parent;
  return ts.isCallExpression(aggregate) && aggregate.arguments[0] === result
    && isStandardLibraryMethodCall(
      checker, aggregate, standardPromiseConstructorOwners, standardPromiseAggregateMethods,
    );
}

function resourceScope(ownerNode: ts.FunctionLikeDeclaration, declaration: ts.VariableDeclaration, source: ts.SourceFile): { scopeId: string; scopeDepth: number; scopeEnd: number; catchesFailure: boolean } {
  let scope: ts.Node = declaration;
  while (scope.parent !== ownerNode && !ts.isBlock(scope)) scope = scope.parent;
  if (!ts.isBlock(scope)) scope = ownerNode.body!;
  let depth = 0;
  for (let current = scope.parent; current && current !== ownerNode; current = current.parent) if (ts.isBlock(current)) depth++;
  let child = scope, catchesFailure = false;
  for (let parent = scope.parent; parent && parent !== ownerNode; child = parent, parent = parent.parent) {
    if (ts.isTryStatement(parent) && parent.catchClause && child === parent.tryBlock) { catchesFailure = true; break; }
  }
  return { scopeId: `${functionName(ownerNode)}@${scope.getStart(source)}`, scopeDepth: depth, scopeEnd: scope.getEnd(), catchesFailure };
}

export function analyzeAsyncSafetyInProgram(program: ts.Program, source: ts.SourceFile, options: AsyncSafetyOptions = {}): AsyncSafetyResult {
  const checker = program.getTypeChecker();
  const resourceRetentionCache = new Map<ts.SignatureDeclaration, ReadonlySet<number>>();
  const promises: PromiseObservation[] = [], promiseBindings: PromiseBinding[] = [], resources: ResourceBinding[] = [], resourceAliases: ResourceAliasEscape[] = [], resourceEscapes: ResourceEscape[] = [], resourceSwitches: ResourceSwitchDecision[] = [], resourceIfs: ResourceIfDecision[] = [], ownershipObligations: OwnershipGuardObligation[] = [], controlRegions: AsyncControlRegion[] = [], controlStatements: AsyncControlStatement[] = [], controlTransferOwners: AsyncControlTransferOwner[] = [], returnCompletions: AsyncReturnCompletion[] = [], throwCompletions: AsyncThrowCompletion[] = [], diagnostics: AsyncSafetyDiagnostic[] = [];
  const validateOwnershipContracts = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) for (const directive of ["consumes_rejection", "consumes_callback_rejection"] as const) for (const error of parseIndexedOwnershipContract(node, directive).errors) {
      diagnostics.push({ fileName: source.fileName, functionName: functionName(node), line: lineAt(source, error.position), kind: "invalid-ownership-contract", severity: "error", message: error.message, notes: [{ label: "because", detail: "an ownership directive that does not resolve against this declaration transfers nothing, so callers keep the rejection responsibility" }] });
    }
    if (ts.isFunctionLike(node)) for (const error of parseIndexedOwnershipContract(node, "retains_resource").errors) {
      diagnostics.push({ fileName: source.fileName, functionName: functionName(node), line: lineAt(source, error.position), kind: "invalid-resource-contract", severity: "error", message: error.message, notes: [{ label: "because", detail: "a resource directive that does not resolve against this declaration is ignored, so retention stays unmodeled" }] });
    }
    if (ts.isFunctionLike(node)) for (const error of conditionalOwnershipParameters(undefined, node, undefined, "retains_resource_when").errors) {
      diagnostics.push({ fileName: source.fileName, functionName: functionName(node), line: lineAt(source, error.position), kind: "invalid-resource-contract", severity: "error", message: error.message, notes: [{ label: "because", detail: "a resource directive that does not resolve against this declaration is ignored, so retention stays unmodeled" }] });
    }
    if (ts.isFunctionLike(node)) for (const directive of ["consumes_rejection_when", "consumes_callback_rejection_when"] as const) for (const error of conditionalOwnershipParameters(undefined, node, undefined, directive).errors) {
      diagnostics.push({ fileName: source.fileName, functionName: functionName(node), line: lineAt(source, error.position), kind: "invalid-ownership-contract", severity: "error", message: error.message, notes: [{ label: "because", detail: "an ownership directive that does not resolve against this declaration transfers nothing, so callers keep the rejection responsibility" }] });
    }
    if (ts.isCallExpression(node)) {
      const consumed = callbackRejectionConsumerParameters(checker, node);
      node.arguments.forEach((argument, index) => {
        if (!consumed.has(index) && !callbackRejectionTransferredToPromiseAggregate(checker, node, index)
          && isPromiseReturningCallback(checker, argument)) diagnostics.push({
          fileName: source.fileName, functionName: enclosingFunctionName(node), line: lineAt(source, argument.getStart(source)), kind: "floating-callback-promise", severity: "error",
          message: `${node.expression.getText(source)} does not declare ownership of the Promise returned by callback argument ${index}`,
          notes: [{ label: "because", detail: `${node.expression.getText(source)} carries no /* uneffect: consumes_callback_rejection ... */ for argument ${index}, so a rejection from that callback reaches no observer` }],
        });
      });
      const declaration = checker.getResolvedSignature(node)?.declaration;
      if (declaration && declaration.kind !== ts.SyntaxKind.JSDocSignature) {
        const signature = declaration as ts.SignatureDeclaration;
        const declarationSource = signature.getSourceFile(), start = signature.getFullStart();
        const comments = declarationSource.text.slice(start, signature.getStart(declarationSource));
        for (const [directive, ownership] of [["consumes_rejection_when", "promise"], ["consumes_callback_rejection_when", "callback"]] as const) {
          for (const annotation of extractLocatedAnnotations(comments, directive, start)) {
            const match = /^(0|[1-9]\d*)\s*:\s*(.+)$/.exec(annotation.value);
            if (!match || Number(match[1]) >= signature.parameters.length) continue;
            const proof = ownershipGuardEvidence(checker, node, signature, match[2]!);
            ownershipObligations.push({ owner: enclosingFunctionName(node), callee: node.expression.getText(source), ownership, parameter: Number(match[1]), assumptions: proof.assumptions, goal: proof.goal, status: proof.verified ? "verified" : "unresolved", evidence: proof.verified ? "finite-propositional" : "unknown", span: { start: node.getStart(source), end: node.getEnd() } });
          }
        }
      }
    }
    ts.forEachChild(node, validateOwnershipContracts);
  };
  validateOwnershipContracts(source);
  const visitFunction = (ownerNode: ts.FunctionLikeDeclaration): void => {
    if (!ownerNode.body) return;
    const owner = functionName(ownerNode), ownedResources: ResourceBinding[] = [], resourceSymbols = new Map<ts.Symbol, ResourceBinding>();
    const repeatedResourceSymbols = new Set<ts.Symbol>();
    const targetSymbol = (node: ts.Node): ts.Symbol | undefined => {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    };
    const immutableInitializer = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ts.Expression | undefined => {
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
        return immutableInitializer(expression.expression, seen);
      }
      if (!ts.isIdentifier(expression)) return expression;
      const symbol = targetSymbol(expression), declaration = symbol?.valueDeclaration;
      if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
        || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
      return immutableInitializer(declaration.initializer, new Set([...seen, symbol]));
    };
    type ProxyFactoryDeclaration = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
    const isProxyFactoryDeclaration = (declaration: ts.Node): declaration is ProxyFactoryDeclaration =>
      ts.isFunctionDeclaration(declaration) || ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration);
    const staticPrimitive = (
      expression: ts.Expression,
      substitutions: ReadonlyMap<ts.Symbol, ts.Expression>,
    ): { value: string | number | boolean } | undefined => {
      const value = evaluateStaticPrimitive(expression, { resolveIdentifier(identifier) {
        const symbol = targetSymbol(identifier);
        if (!symbol) return undefined;
        return { key: symbol, expression: substitutions.get(symbol) ?? immutableInitializer(identifier) };
      } });
      return value === undefined ? undefined : { value };
    };
    type ReturnFlow = { expressions: ts.Expression[]; definite: boolean };
    const returnedExpressions = (declaration: ProxyFactoryDeclaration, substitutions: ReadonlyMap<ts.Symbol, ts.Expression>): ts.Expression[] | undefined => {
      if (!declaration.body) return undefined;
      if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)) return [declaration.body];
      if (!ts.isBlock(declaration.body)) return undefined;
      const staticBoolean = (expression: ts.Expression): boolean | undefined => {
        const primitive = staticPrimitive(expression, substitutions);
        return typeof primitive?.value === "boolean" ? primitive.value : undefined;
      };
      const statementFlow = (statement: ts.Statement): ReturnFlow | undefined => {
        if (ts.isReturnStatement(statement)) return { expressions: statement.expression ? [statement.expression] : [], definite: true };
        if (ts.isThrowStatement(statement)) return { expressions: [], definite: true };
        if (ts.isBlock(statement)) return blockFlow(statement);
        if (ts.isIfStatement(statement)) {
          const selected = staticBoolean(statement.expression);
          if (selected === true) return statementFlow(statement.thenStatement);
          if (selected === false) return statement.elseStatement
            ? statementFlow(statement.elseStatement) : { expressions: [], definite: false };
          const whenTrue = statementFlow(statement.thenStatement);
          const whenFalse = statement.elseStatement ? statementFlow(statement.elseStatement) : { expressions: [], definite: false };
          return whenTrue && whenFalse ? {
            expressions: [...whenTrue.expressions, ...whenFalse.expressions],
            definite: whenTrue.definite && whenFalse.definite,
          } : undefined;
        }
        if (ts.isSwitchStatement(statement)) return switchFlow(statement);
        return ts.isExpressionStatement(statement) || ts.isVariableStatement(statement) || ts.isEmptyStatement(statement)
          ? { expressions: [], definite: false } : undefined;
      };
      const statementsFlow = (statements: readonly ts.Statement[]): ReturnFlow | undefined => {
        const expressions: ts.Expression[] = [];
        for (const statement of statements) {
          const flow = statementFlow(statement);
          if (!flow) return undefined;
          expressions.push(...flow.expressions);
          if (flow.definite) return { expressions, definite: true };
        }
        return { expressions, definite: false };
      };
      const blockFlow = (block: ts.Block): ReturnFlow | undefined => statementsFlow(block.statements);
      const switchFlow = (statement: ts.SwitchStatement): ReturnFlow | undefined => {
        const discriminant = staticPrimitive(statement.expression, substitutions);
        if (!discriminant) return undefined;
        let entry: number | undefined, defaultEntry: number | undefined;
        for (const [index, clause] of statement.caseBlock.clauses.entries()) {
          if (ts.isDefaultClause(clause)) {
            defaultEntry = index;
            continue;
          }
          const candidate = staticPrimitive(clause.expression, substitutions);
          if (!candidate) return undefined;
          if (candidate.value === discriminant.value) {
            entry = index;
            break;
          }
        }
        entry ??= defaultEntry;
        if (entry === undefined) return { expressions: [], definite: false };
        const expressions: ts.Expression[] = [];
        for (const clause of statement.caseBlock.clauses.slice(entry)) {
          for (const clauseStatement of clause.statements) {
            if (ts.isBreakStatement(clauseStatement) && !clauseStatement.label) return { expressions, definite: false };
            const flow = statementFlow(clauseStatement);
            if (!flow) return undefined;
            expressions.push(...flow.expressions);
            if (flow.definite) return { expressions, definite: true };
          }
        }
        return { expressions, definite: false };
      };
      const flow = blockFlow(declaration.body);
      return flow?.definite && flow.expressions.length > 0 ? flow.expressions : undefined;
    };
    const isBuiltinProxyReceiver = (
      expression: ts.Expression,
      seen = new Set<ProxyFactoryDeclaration>(),
      substitutions = new Map<ts.Symbol, ts.Expression>(),
      substituted = new Set<ts.Symbol>(),
    ): boolean => {
      if (ts.isIdentifier(expression)) {
        const symbol = targetSymbol(expression), replacement = symbol && substitutions.get(symbol);
        if (symbol && replacement) {
          if (substituted.has(symbol)) return false;
          return isBuiltinProxyReceiver(replacement, new Set(seen), substitutions, new Set([...substituted, symbol]));
        }
      }
      const initializer = immutableInitializer(expression);
      if (!initializer) return false;
      if (ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression) && initializer.expression.text === "Proxy") {
        return targetSymbol(initializer.expression)?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile) ?? false;
      }
      if (ts.isConditionalExpression(initializer)) {
        const selected = staticPrimitive(initializer.condition, substitutions);
        if (typeof selected?.value === "boolean") {
          return isBuiltinProxyReceiver(
            selected.value ? initializer.whenTrue : initializer.whenFalse,
            new Set(seen), substitutions, new Set(substituted),
          );
        }
        return isBuiltinProxyReceiver(initializer.whenTrue, new Set(seen), substitutions, new Set(substituted))
          && isBuiltinProxyReceiver(initializer.whenFalse, new Set(seen), substitutions, new Set(substituted));
      }
      if (!ts.isCallExpression(initializer)) return false;
      const declaration = checker.getResolvedSignature(initializer)?.declaration;
      if (!declaration || !isProxyFactoryDeclaration(declaration) || seen.has(declaration)) return false;
      const nextSeen = new Set([...seen, declaration]);
      const nextSubstitutions = new Map(substitutions);
      for (const [index, parameter] of declaration.parameters.entries()) {
        const argument = initializer.arguments[index] ?? parameter.initializer;
        if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || !argument) return false;
        const symbol = targetSymbol(parameter.name);
        if (!symbol) return false;
        nextSubstitutions.set(symbol, argument);
      }
      const returned = returnedExpressions(declaration, nextSubstitutions);
      return returned !== undefined && returned.every((candidate) =>
        isBuiltinProxyReceiver(candidate, new Set(nextSeen), nextSubstitutions, new Set(substituted)));
    };
    const isInsideIteration = (node: ts.Node): boolean => {
      for (let parent = node.parent; parent && parent !== ownerNode; parent = parent.parent) {
        if (ts.isWhileStatement(parent) || ts.isDoStatement(parent) || ts.isForStatement(parent)
          || ts.isForInStatement(parent) || ts.isForOfStatement(parent)) return true;
      }
      return false;
    };
    const mayThrowOrReject = (node: ts.Node): boolean => {
      let risky = false;
      const scan = (current: ts.Node): void => {
        if (risky || (current !== node && ts.isFunctionLike(current))) return;
        if (ts.isCallExpression(current) || ts.isNewExpression(current) || ts.isAwaitExpression(current) || ts.isThrowStatement(current)) {
          risky = true;
          return;
        }
        if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
          if (isBuiltinProxyReceiver(current.expression)) {
            risky = true;
            return;
          }
          const symbol = ts.isPropertyAccessExpression(current)
            ? checker.getSymbolAtLocation(current.name)
            : (() => {
              const direct = checker.getSymbolAtLocation(current);
              if (direct) return direct;
              const key = current.argumentExpression;
              if (!key) return undefined;
              const keyType = checker.getTypeAtLocation(key);
              const members = keyType.isUnion() ? keyType.types : [keyType];
              const names = members.flatMap((member) => {
                if (member.isStringLiteral() || member.isNumberLiteral()) return [String(member.value)];
                return [];
              });
              if (names.length !== members.length || names.length === 0) return undefined;
              const receiver = checker.getTypeAtLocation(current.expression);
              return names.map((name) => checker.getPropertyOfType(receiver, name)).find((candidate) => candidate?.declarations?.some(ts.isGetAccessorDeclaration));
            })();
          if (symbol?.declarations?.some(ts.isGetAccessorDeclaration)) {
            risky = true;
            return;
          }
        }
        ts.forEachChild(current, scan);
      };
      scan(node);
      return risky;
    };
    const canCompleteNormally = (statement: ts.Statement): boolean => {
      if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) return false;
      if (ts.isBlock(statement)) {
        for (const child of statement.statements) if (!canCompleteNormally(child)) return false;
        return true;
      }
      if (ts.isIfStatement(statement)) {
        const whenTrue = canCompleteNormally(statement.thenStatement);
        const whenFalse = statement.elseStatement ? canCompleteNormally(statement.elseStatement) : true;
        return whenTrue || whenFalse;
      }
      return true;
    };
    const precedingFallthroughConditions = (node: ts.Node): AsyncControlCondition[] => {
      const conditions: AsyncControlCondition[] = [];
      let child = node;
      for (let parent = node.parent; parent && parent !== ownerNode; child = parent, parent = parent.parent) {
        if (!ts.isBlock(parent) || !ts.isStatement(child)) continue;
        const statementIndex = parent.statements.indexOf(child);
        if (statementIndex <= 0) continue;
        for (const statement of parent.statements.slice(0, statementIndex)) {
          if (!ts.isIfStatement(statement)) continue;
          const whenTrue = canCompleteNormally(statement.thenStatement);
          const whenFalse = statement.elseStatement ? canCompleteNormally(statement.elseStatement) : true;
          if (whenTrue === whenFalse) continue;
          conditions.push({ id: `${owner}@if:${statement.getStart(source)}`, expected: whenTrue, role: "fallthrough" });
        }
      }
      return conditions;
    };
    const controlPaths = (node: ts.Node): AsyncControlCondition[][] => {
      let paths: AsyncControlCondition[][] = [[]];
      let child = node;
      for (let parent = node.parent; parent && parent !== ownerNode; child = parent, parent = parent.parent) {
        if (!ts.isIfStatement(parent) || child === parent.expression) continue;
        const condition = { id: `${owner}@if:${parent.getStart(source)}`, expected: child === parent.thenStatement };
        paths = paths.map((path) => [condition, ...path]);
      }
      for (let child: ts.Node = node, parent = node.parent; parent && parent !== ownerNode; child = parent, parent = parent.parent) {
        const zeroIterationLoop = (ts.isWhileStatement(parent) || ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && child === parent.statement;
        if (zeroIterationLoop) {
          const condition = { id: `${owner}@loop:${parent.getStart(source)}`, expected: true };
          paths = paths.map((path) => [condition, ...path]);
        }
      }
      for (let parent = node.parent; parent && parent !== ownerNode; parent = parent.parent) if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) {
        paths = switchControlPaths(owner, source, parent).flatMap((prefix) => paths.map((path) => [...prefix, ...path]));
      }
      const fallthrough = precedingFallthroughConditions(node);
      if (fallthrough.length > 0) paths = paths.map((path) => [...fallthrough, ...path]);
      return paths;
    };
    const resourceAliasControlPaths = (node: ts.Node): AsyncControlCondition[][] => {
      let paths = controlPaths(node);
      for (let child: ts.Node = node, parent = node.parent; parent && parent !== ownerNode; child = parent, parent = parent.parent) {
        if (!ts.isTryStatement(parent) || !parent.catchClause || child === parent.finallyBlock) continue;
        const id = `${owner}@try:${parent.getStart(source)}:completed`;
        if (child === parent.catchClause) {
          paths = paths.map((path) => [{ id, expected: false }, ...path]);
          continue;
        }
        if (child !== parent.tryBlock) continue;
        const statementIndex = parent.tryBlock.statements.findIndex((statement) => node.getStart(source) >= statement.getStart(source) && node.getEnd() <= statement.getEnd());
        if (statementIndex > 0 && parent.tryBlock.statements.slice(0, statementIndex).some(mayThrowOrReject)) {
          paths = paths.map((path) => [{ id, expected: true }, ...path]);
        }
      }
      return paths;
    };
    const controlConditions = (node: ts.Node): AsyncControlCondition[] => controlPaths(node)[0] ?? [];
    const isConditionalExecution = (node: ts.Node): boolean => {
      if (controlConditions(node).length > 0) return true;
      let child = node;
      for (let parent = node.parent; parent && parent !== ownerNode; child = parent, parent = parent.parent) {
        if (ts.isIfStatement(parent) && child !== parent.expression) return true;
        if ((ts.isWhileStatement(parent) || ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && child === parent.statement) return true;
        if (ts.isConditionalExpression(parent) && child !== parent.condition) return true;
        if (ts.isBinaryExpression(parent) && child === parent.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)) return true;
        if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return true;
      }
      return false;
    };
    const isStraightLineReassignment = (node: ts.Node): boolean => {
      for (let current: ts.Node | undefined = node.parent; current && current !== ownerNode.body; current = current.parent) {
        if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isSwitchStatement(current)
          || ts.isIterationStatement(current, false) || ts.isTryStatement(current) || ts.isCatchClause(current)
          || ts.isCaseClause(current) || ts.isDefaultClause(current)) return false;
        if (ts.isBinaryExpression(current) && current.right === node
          && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(current.operatorToken.kind)) return false;
      }
      return true;
    };
    const bindingGroups = new Map<ts.Symbol, PromiseBinding[]>();
    const allBindingGroups = new Set<PromiseBinding[]>();
    const generationManagedGroups = new Set<PromiseBinding[]>();
    const conditionallyCreatedGroups = new Set<PromiseBinding[]>();
    const symbolGenerations = new Map<ts.Symbol, number>();
    const localBindings: PromiseBinding[] = [];
    const registerBinding = (symbol: ts.Symbol, name: string, spanNode: ts.Node, existing?: PromiseBinding[]): void => {
      if (bindingGroups.has(symbol)) return;
      if (existing) {
        const binding: PromiseBinding = { owner, binding: name, generation: existing[0]!.generation, status: existing[0]!.status, observations: existing[0]!.observations, identity: existing[0]!.identity, span: { start: spanNode.getStart(source), end: spanNode.getEnd() } };
        existing.push(binding); bindingGroups.set(symbol, existing); localBindings.push(binding); promiseBindings.push(binding);
      } else {
        const generation = symbolGenerations.get(symbol) ?? 0;
        symbolGenerations.set(symbol, generation);
        const binding: PromiseBinding = { owner, binding: name, generation, status: "floating", observations: [], identity: bindingIdentity(symbol), span: { start: spanNode.getStart(source), end: spanNode.getEnd() } };
        const group = [binding];
        bindingGroups.set(symbol, group); allBindingGroups.add(group); localBindings.push(binding); promiseBindings.push(binding);
      }
    };
    const rebindPromise = (symbol: ts.Symbol, name: string, spanNode: ts.Node, existing?: PromiseBinding[]): void => {
      const previous = bindingGroups.get(symbol);
      if (previous) generationManagedGroups.add(previous);
      const generation = (symbolGenerations.get(symbol) ?? previous?.[0]?.generation ?? 0) + 1;
      symbolGenerations.set(symbol, generation);
      if (existing) {
        const binding: PromiseBinding = { owner, binding: name, generation: existing[0]!.generation, status: existing[0]!.status, observations: existing[0]!.observations, identity: existing[0]!.identity, span: { start: spanNode.getStart(source), end: spanNode.getEnd() } };
        existing.push(binding); bindingGroups.set(symbol, existing); generationManagedGroups.add(existing); localBindings.push(binding); promiseBindings.push(binding);
        if (isConditionalExecution(spanNode)) conditionallyCreatedGroups.add(existing);
      } else {
        const binding: PromiseBinding = { owner, binding: name, generation, status: "floating", observations: [], identity: bindingIdentity(symbol), span: { start: spanNode.getStart(source), end: spanNode.getEnd() } };
        const group = [binding];
        bindingGroups.set(symbol, group); allBindingGroups.add(group); generationManagedGroups.add(group); localBindings.push(binding); promiseBindings.push(binding);
        if (isConditionalExecution(spanNode)) conditionallyCreatedGroups.add(group);
      }
    };
    const markSymbol = (symbol: ts.Symbol | undefined, status: "transferred" | "observed", observation: string): void => {
      const group = symbol && bindingGroups.get(symbol);
      if (!group) return;
      for (const binding of group) {
        if (status === "observed" || binding.status === "floating") binding.status = status;
        if (!binding.observations.includes(observation)) binding.observations.push(observation);
      }
    };
    const markBinding = (expression: ts.Expression, status: "transferred" | "observed", observation: string): void => {
      if (ts.isIdentifier(expression)) markSymbol(checker.getSymbolAtLocation(expression), status, observation);
    };
    const handledReceiver = (expression: ts.Expression): ts.Expression | undefined => {
      if (!ts.isCallExpression(expression) || !ts.isPropertyAccessExpression(expression.expression)) return undefined;
      const name = expression.expression.name.text;
      if (name === "finally") return handledReceiver(expression.expression.expression);
      if (name === "catch" && expression.arguments[0]) return expression.expression.expression;
      if (name === "then" && expression.arguments[1]) return expression.expression.expression;
      return undefined;
    };
    const observe = (expression: ts.Expression, observation: PromiseObservationKind, catchesRejection: boolean): void => {
      const paths = controlPaths(expression);
      promises.push({ owner, source: expression.getText(source), observation, catchesRejection, conditional: isConditionalExecution(expression), controlConditions: paths[0] ?? [], controlPaths: paths, span: { start: expression.getStart(source), end: expression.getEnd() } });
      if (observation === "floating") diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, expression.getStart(source)), kind: "floating-promise", severity: "error", message: `${owner} has a floating Promise whose rejection is not observed; await, return, catch, or explicitly void it`, notes: [{ label: "because", detail: `${expression.getText(source)} evaluates to a Promise that no await, return, catch, then-rejection handler, or void expression observes` }] });
    };
    const visit = (node: ts.Node): void => {
      if (node !== ownerNode.body && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const symbol = checker.getSymbolAtLocation(node.name);
        if (symbol) {
          const aliasedSymbol = ts.isIdentifier(node.initializer) ? checker.getSymbolAtLocation(node.initializer) : undefined;
          const existing = aliasedSymbol && bindingGroups.get(aliasedSymbol);
          if (existing) registerBinding(symbol, node.name.text, node, existing);
          else if (isPromiseLike(checker, node.initializer)) registerBinding(symbol, node.name.text, node);
        }
      }
      if (ts.isVariableDeclaration(node)
        && (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) && node.initializer) {
        const registerPromiseElements = (name: ts.BindingName): void => {
          if (ts.isIdentifier(name)) {
            const symbol = checker.getSymbolAtLocation(name);
            if (symbol && isPromiseLike(checker, name)) registerBinding(symbol, name.text, name);
            return;
          }
          for (const element of name.elements) if (!ts.isOmittedExpression(element)) registerPromiseElements(element.name);
        };
        registerPromiseElements(node.name);
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol) {
          const aliasedSymbol = ts.isIdentifier(node.right) ? checker.getSymbolAtLocation(node.right) : undefined;
          const existing = aliasedSymbol && bindingGroups.get(aliasedSymbol);
          if (bindingGroups.has(symbol)) {
            if (!isStraightLineReassignment(node)) {
              // The existing CFG evaluator retains branch/loop/try generation joins.
            } else if (existing) rebindPromise(symbol, node.left.text, node, existing);
            else if (isPromiseLike(checker, node.right)) rebindPromise(symbol, node.left.text, node);
            else {
              generationManagedGroups.add(bindingGroups.get(symbol)!);
              bindingGroups.delete(symbol);
            }
          } else if (existing) registerBinding(symbol, node.left.text, node, existing);
          else if (isPromiseLike(checker, node.right)) registerBinding(symbol, node.left.text, node);
        }
      }
      if (ts.isVariableStatement(node)) {
        const flags = ts.getCombinedNodeFlags(node.declarationList);
        const using = (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using;
        if (using) for (const declaration of node.declarationList.declarations) {
          if (!declaration.initializer || !ts.isIdentifier(declaration.name)) continue;
          const asynchronous = (flags & ts.NodeFlags.AwaitUsing) === ts.NodeFlags.AwaitUsing;
          const protocol = disposableProperties(checker, declaration.initializer);
          const selectedProtocol = asynchronous ? protocol.asyncSymbol ?? protocol.syncSymbol : protocol.syncSymbol;
          const protocolDeclaration = selectedProtocol?.declarations?.[0];
          const paths = controlPaths(declaration);
          let initializer = declaration.initializer;
          while (ts.isParenthesizedExpression(initializer) || ts.isAsExpression(initializer)
            || ts.isTypeAssertionExpression(initializer) || ts.isNonNullExpression(initializer)) initializer = initializer.expression;
          const resource: ResourceBinding = { owner, ownerAsync: Boolean(ownerNode.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)), binding: declaration.name.text, asynchronous, conditional: isConditionalExecution(declaration), controlConditions: paths[0] ?? [], controlPaths: paths, acquisitionIndex: ownedResources.length, ...resourceScope(ownerNode, declaration, source), initializerMayFail: true, initializerAwaited: ts.isAwaitExpression(initializer), disposalFailureType: disposalFailureType(selectedProtocol),
            disposalProtocol: protocolDeclaration ? { kind: protocol.asyncSymbol === selectedProtocol ? "async" : "sync", fileName: protocolDeclaration.getSourceFile().fileName, start: protocolDeclaration.getStart(), end: protocolDeclaration.getEnd() } : undefined,
            span: { start: declaration.getStart(source), end: declaration.getEnd() } };
          resources.push(resource); ownedResources.push(resource);
          const resourceSymbol = checker.getSymbolAtLocation(declaration.name);
          if (resourceSymbol) {
            resourceSymbols.set(resourceSymbol, resource);
            if (isInsideIteration(declaration)) repeatedResourceSymbols.add(resourceSymbol);
          }
          if ((!asynchronous && !protocol.sync) || (asynchronous && !protocol.async && !protocol.sync)) diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, declaration.getStart(source)), kind: "invalid-disposable", severity: "error", message: `${owner} binds ${declaration.name.text} with ${asynchronous ? "await using" : "using"}, which requires the ${asynchronous ? "Symbol.asyncDispose or Symbol.dispose" : "Symbol.dispose"} protocol that ${declaration.name.text} does not provide`, notes: [{ label: "binding", detail: declaration.getText(source) }, { label: "because", detail: `the type of ${declaration.name.text} declares no ${asynchronous ? "[Symbol.asyncDispose] or [Symbol.dispose]" : "[Symbol.dispose]"} method, so leaving the scope releases nothing` }] });
        }
      }
      if (ts.isAwaitExpression(node) && isPromiseLike(checker, node.expression)) { observe(node.expression, "await", catchesAwaitRejection(node)); markBinding(node.expression, "observed", "await"); }
      if (ts.isReturnStatement(node)) {
        returnCompletions.push({ owner, controlPaths: controlPaths(node), span: { start: node.getStart(source), end: node.getEnd() } });
        if (node.expression && isPromiseLike(checker, node.expression)) { observe(node.expression, "return", false); markBinding(node.expression, "observed", "return"); }
      }
      if (ts.isThrowStatement(node)) {
        const thrownType = checker.getTypeAtLocation(node.expression);
        throwCompletions.push({
          owner,
          errorType: checker.typeToString(thrownType),
          errorLike: Boolean(checker.getPropertyOfType(thrownType, "name") && checker.getPropertyOfType(thrownType, "message")),
          controlPaths: controlPaths(node),
          span: { start: node.getStart(source), end: node.getEnd() },
        });
      }
      if (ts.isExpressionStatement(node)) {
        let expression = node.expression;
        if (ts.isVoidExpression(expression) && isPromiseLike(checker, expression.expression)) {
          observe(expression.expression, options.allowVoid === false ? "floating" : "ignored", false);
          if (options.allowVoid !== false) markBinding(expression.expression, "observed", "void");
        }
        else if (isPromiseLike(checker, expression)
          && !(ts.isBinaryExpression(expression)
            && expression.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && expression.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && ts.isIdentifier(expression.left))) {
          const handled = handledChain(expression);
          observe(expression, handled ?? "floating", Boolean(handled));
          const receiver = handled && handledReceiver(expression);
          if (receiver) markBinding(receiver, "observed", handled);
        }
      }
      if (ts.isCallExpression(node)) for (const index of rejectionConsumerParameters(checker, node)) {
        const argument = node.arguments[index];
        if (argument) markBinding(argument, "transferred", `argument:${node.expression.getText(source)}:${index}`);
      }
      if (ts.isShorthandPropertyAssignment(node)) markSymbol(checker.getShorthandAssignmentValueSymbol(node), "transferred", "aggregate:object");
      if (ts.isPropertyAssignment(node)) markBinding(node.initializer, "transferred", "aggregate:object");
      if (ts.isArrayLiteralExpression(node)) for (const element of node.elements) if (ts.isExpression(element)) markBinding(element, "transferred", "aggregate:array");
      ts.forEachChild(node, visit);
    };
    visit(ownerNode.body);
    type ResourceAliasFact = {
      resource: ResourceBinding;
      alias: string;
      generation: ResourceAliasEscape["generation"];
      assignmentSpan: { start: number; end: number };
    };
    const escapedAliases = new Map<ts.Symbol, ResourceAliasFact>();
    const escapedAggregateAliases = new Map<ts.Symbol, Map<string, ResourceAliasFact>>();
    const aggregateRootAliases = new Map<ts.Symbol, ts.Symbol>();
    const reportedAliasUses = new Set<ts.Symbol | string>();
    type StaticSlot = { root: ts.Symbol; key: string; alias: string };
    const resolveAggregateRoot = (symbol: ts.Symbol): ts.Symbol => {
      const seen = new Set<ts.Symbol>();
      let current = symbol;
      while (!seen.has(current)) {
        seen.add(current);
        const next = aggregateRootAliases.get(current);
        if (!next) break;
        current = next;
      }
      return current;
    };
    const constantInitializer = (input: ts.Symbol | undefined, seen: Set<ts.Symbol>): { initializer: ts.Expression; seen: Set<ts.Symbol> } | undefined => {
      let symbol = input;
      if (!symbol || seen.has(symbol)) return undefined;
      const nextSeen = new Set(seen).add(symbol);
      while ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        const target = checker.getAliasedSymbol(symbol);
        if (target === symbol || nextSeen.has(target)) return undefined;
        symbol = target;
        nextSeen.add(symbol);
      }
      const declaration = symbol.valueDeclaration;
      if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
        || !ts.isVariableDeclarationList(declaration.parent)
        || (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0) return undefined;
      return { initializer: declaration.initializer, seen: nextSeen };
    };
    const constantPropertyKey = (expression: ts.Expression, seen = new Set<ts.Symbol>()): string | undefined => {
      if (ts.isStringLiteralLike(expression)) return expression.text;
      if (ts.isNumericLiteral(expression)) {
        const value = Number(expression.text);
        return Number.isFinite(value) ? String(value) : undefined;
      }
      if (ts.isPrefixUnaryExpression(expression)
        && (expression.operator === ts.SyntaxKind.PlusToken || expression.operator === ts.SyntaxKind.MinusToken)
        && ts.isNumericLiteral(expression.operand)) {
        const value = Number(expression.operand.text) * (expression.operator === ts.SyntaxKind.MinusToken ? -1 : 1);
        return Number.isFinite(value) ? String(value) : undefined;
      }
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
        || ts.isNonNullExpression(expression)) return constantPropertyKey(expression.expression, seen);
      const symbol = ts.isIdentifier(expression) ? checker.getSymbolAtLocation(expression)
        : ts.isPropertyAccessExpression(expression) ? checker.getSymbolAtLocation(expression.name)
          : undefined;
      const constant = constantInitializer(symbol, seen);
      return constant ? constantPropertyKey(constant.initializer, constant.seen) : undefined;
    };
    const staticAccessPath = (expression: ts.Expression): { root: ts.Symbol; segments: string[] } | undefined => {
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        return symbol ? { root: resolveAggregateRoot(symbol), segments: [] } : undefined;
      }
      if (ts.isPropertyAccessExpression(expression)) {
        const parent = staticAccessPath(expression.expression);
        return parent ? { root: parent.root, segments: [...parent.segments, JSON.stringify(expression.name.text)] } : undefined;
      }
      if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
        const key = constantPropertyKey(expression.argumentExpression);
        if (key === undefined) return undefined;
        const parent = staticAccessPath(expression.expression);
        return parent ? { root: parent.root, segments: [...parent.segments, JSON.stringify(key)] } : undefined;
      }
      return undefined;
    };
    const staticSlot = (expression: ts.Expression): StaticSlot | undefined => {
      if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
      const path = staticAccessPath(expression);
      return path && path.segments.length > 0
        ? { root: path.root, key: path.segments.join("/"), alias: expression.getText(source) }
        : undefined;
    };
    const symbolAliasFact = (symbol: ts.Symbol | undefined, alias: string, node: ts.Node): ResourceAliasFact | undefined => {
      const resource = symbol && resourceSymbols.get(symbol);
      const repeated = Boolean(symbol && repeatedResourceSymbols.has(symbol));
      return resource ? {
        resource,
        alias,
        generation: {
          acquisitionIndex: resource.acquisitionIndex,
          repeated,
          relation: repeated ? "latest" : "single",
          controlPaths: [[]],
          snapshot: repeated ? `generation_${resource.acquisitionIndex}@${node.getStart(source)}` : `single_${resource.acquisitionIndex}`,
        },
        assignmentSpan: { start: node.getStart(source), end: node.getEnd() },
      }
        : symbol ? escapedAliases.get(symbol) : undefined;
    };
    const aliasFact = (expression: ts.Expression | undefined): ResourceAliasFact | undefined => {
      if (!expression) return undefined;
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        return symbolAliasFact(symbol, expression.text, expression);
      }
      const slot = staticSlot(expression);
      return slot ? escapedAggregateAliases.get(slot.root)?.get(slot.key) : undefined;
    };
    const reportAliasUse = (node: ts.Expression, escaped: ResourceAliasFact, identity: ts.Symbol | string): void => {
      if (reportedAliasUses.has(identity) || node.getStart(source) < escaped.resource.scopeEnd) return;
      const alias: ResourceAliasEscape = { owner, resource: escaped.resource.binding, alias: escaped.alias, generation: escaped.generation, assignmentSpan: escaped.assignmentSpan, useSpan: { start: node.getStart(source), end: node.getEnd() } };
      resourceAliases.push(alias); reportedAliasUses.add(identity);
      diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, node.getStart(source)), kind: "disposed-resource-use", severity: "error", message: `${owner} uses ${escaped.alias}, an alias of using resource ${escaped.resource.binding}, after its lexical disposal scope`, notes: [{ label: "binding", detail: source.text.slice(escaped.resource.span.start, escaped.resource.span.end) }, { label: "because", detail: `${escaped.resource.binding} is disposed when its using scope ends, so this use observes a released resource` }] });
    };
    const capturedResourceFact = (node: ts.Node): ResourceAliasFact | undefined => {
      if (ts.isShorthandPropertyAssignment(node)) {
        const fact = symbolAliasFact(checker.getShorthandAssignmentValueSymbol(node), node.name.text, node);
        if (fact) return fact;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const fact = aliasFact(node);
        if (fact) return fact;
      }
      if (ts.isIdentifier(node)) {
        const fact = aliasFact(node);
        if (fact) return fact;
      }
      let found: ResourceAliasFact | undefined;
      ts.forEachChild(node, (child) => { if (!found) found = capturedResourceFact(child); });
      return found;
    };
    type ReturnedResource = { fact: ResourceAliasFact; via: ResourceEscape["via"] };
    const returnedResourceFact = (expression: ts.Expression, seen = new Set<ts.Symbol>()): ReturnedResource | undefined => {
      const direct = aliasFact(expression);
      if (direct) return { fact: direct, via: "return" };
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
        || ts.isNonNullExpression(expression)) return returnedResourceFact(expression.expression, seen);
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
        const fact = capturedResourceFact(expression.body);
        return fact ? { fact, via: "returned-closure" } : undefined;
      }
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        const declaration = symbol?.valueDeclaration;
        if (symbol && !seen.has(symbol) && declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
          && ts.isVariableDeclarationList(declaration.parent)
          && (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0) {
          return returnedResourceFact(declaration.initializer, new Set(seen).add(symbol));
        }
      }
      if (ts.isConditionalExpression(expression)) return returnedResourceFact(expression.whenTrue, seen) ?? returnedResourceFact(expression.whenFalse, seen);
      if (ts.isObjectLiteralExpression(expression)) for (const property of expression.properties) {
        const returned = ts.isShorthandPropertyAssignment(property) ? (() => {
          const symbol = checker.getShorthandAssignmentValueSymbol(property);
          const fact = symbolAliasFact(symbol, property.name.text, property);
          if (fact) return { fact, via: "return" as const };
          const declaration = symbol?.valueDeclaration;
          if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
            || !ts.isVariableDeclarationList(declaration.parent)
            || (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) === 0) return undefined;
          return returnedResourceFact(declaration.initializer, new Set(seen).add(symbol));
        })()
          : ts.isPropertyAssignment(property) ? returnedResourceFact(property.initializer, seen)
            : ts.isSpreadAssignment(property) ? returnedResourceFact(property.expression, seen)
              : undefined;
        if (returned) return returned;
      }
      if (ts.isArrayLiteralExpression(expression)) for (const element of expression.elements) {
        if (ts.isExpression(element)) {
          const returned = returnedResourceFact(element, seen);
          if (returned) return returned;
        }
      }
      return undefined;
    };
    const isDefinitelyNullish = (expression: ts.Expression): boolean => {
      const type = checker.getTypeAtLocation(expression);
      const members = type.isUnion() ? type.types : [type];
      return members.length > 0 && members.every((member) =>
        (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0);
    };
    const terminalStatement = (statement: ts.Statement): ts.Statement | undefined => {
      if (!ts.isBlock(statement)) return statement;
      for (let index = statement.statements.length - 1; index >= 0; index -= 1) {
        const candidate = statement.statements[index];
        if (!ts.isEmptyStatement(candidate)) return candidate;
      }
      return undefined;
    };
    const containsAbruptCompletion = (node: ts.Node): boolean => {
      if (ts.isBreakStatement(node) || ts.isContinueStatement(node) || ts.isReturnStatement(node) || ts.isThrowStatement(node)) return true;
      if (node !== ownerNode.body && ts.isFunctionLike(node)) return false;
      let found = false;
      ts.forEachChild(node, (child) => { if (!found) found = containsAbruptCompletion(child); });
      return found;
    };
    type AliasClearTarget = { kind: "symbol"; symbol: ts.Symbol } | { kind: "slot"; root: ts.Symbol; key: string };
    const matchesClearTarget = (left: ts.Expression, target: AliasClearTarget): boolean => {
      if (target.kind === "symbol") return ts.isIdentifier(left) && checker.getSymbolAtLocation(left) === target.symbol;
      const slot = staticSlot(left);
      return Boolean(slot && slot.root === target.root && (target.key === slot.key || target.key.startsWith(`${slot.key}/`)));
    };
    const terminallyClears = (statement: ts.Statement, target: AliasClearTarget): boolean => {
      const terminal = terminalStatement(statement);
      if (!terminal) return false;
      if (ts.isExpressionStatement(terminal) && ts.isBinaryExpression(terminal.expression)
        && terminal.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && matchesClearTarget(terminal.expression.left, target)
        && isDefinitelyNullish(terminal.expression.right)) return true;
      return ts.isIfStatement(terminal) && Boolean(terminal.elseStatement)
        && terminallyClears(terminal.thenStatement, target)
        && terminallyClears(terminal.elseStatement!, target);
    };
    const terminallyClearsOrReturns = (statement: ts.Statement, target: AliasClearTarget): boolean => {
      const terminal = terminalStatement(statement);
      if (!terminal) return false;
      if (ts.isReturnStatement(terminal)) return true;
      if (ts.isIfStatement(terminal) && terminal.elseStatement) {
        return terminallyClearsOrReturns(terminal.thenStatement, target)
          && terminallyClearsOrReturns(terminal.elseStatement, target);
      }
      return terminallyClears(terminal, target);
    };
    type LoopClearFlow = { normal: Set<boolean>; safe: boolean };
    const loopClearFlow = (statement: ts.Statement, input: Set<boolean>, target: AliasClearTarget): LoopClearFlow => {
      if (ts.isBlock(statement)) {
        let normal = new Set(input), safe = true;
        for (const child of statement.statements) {
          if (normal.size === 0) break;
          const next = loopClearFlow(child, normal, target);
          normal = next.normal;
          safe = safe && next.safe;
        }
        return { normal, safe };
      }
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
        && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && matchesClearTarget(statement.expression.left, target)) {
        return { normal: new Set([isDefinitelyNullish(statement.expression.right)]), safe: true };
      }
      if (ts.isIfStatement(statement)) {
        const thenFlow = loopClearFlow(statement.thenStatement, new Set(input), target);
        const elseFlow = statement.elseStatement
          ? loopClearFlow(statement.elseStatement, new Set(input), target)
          : { normal: new Set(input), safe: true };
        return { normal: new Set([...thenFlow.normal, ...elseFlow.normal]), safe: thenFlow.safe && elseFlow.safe };
      }
      if (ts.isTryStatement(statement) && statement.finallyBlock) {
        // Finally receives both the uncleared and cleared states because the
        // protected region may complete normally or abruptly at any point.
        // Only a finally that clears every continuing state (or terminates it
        // after clearing) can discharge the post-loop alias fact.
        const finallyFlow = loopClearFlow(statement.finallyBlock, new Set([false, true]), target);
        if (!finallyFlow.safe) return { normal: new Set(input), safe: false };
        for (const cleared of finallyFlow.normal) {
          if (!cleared) return { normal: new Set(input), safe: false };
        }
        return finallyFlow;
      }
      if (ts.isReturnStatement(statement)) return { normal: new Set(), safe: true };
      if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) {
        let safe = true;
        for (const cleared of input) if (!cleared) safe = false;
        return { normal: new Set(), safe };
      }
      if (ts.isThrowStatement(statement) || containsAbruptCompletion(statement)) return { normal: new Set(input), safe: false };
      return { normal: new Set(input), safe: true };
    };
    const loopBodyMustClear = (statement: ts.Statement, target: AliasClearTarget): boolean => {
      const flow = loopClearFlow(statement, new Set([false]), target);
      if (!flow.safe) return false;
      for (const cleared of flow.normal) if (!cleared) return false;
      return true;
    };
    const clauseTerminallyClears = (clause: ts.CaseOrDefaultClause, target: AliasClearTarget): boolean => {
      let index = clause.statements.length - 1;
      while (index >= 0 && (ts.isEmptyStatement(clause.statements[index]!) || ts.isBreakStatement(clause.statements[index]!))) index -= 1;
      return index >= 0
        && !clause.statements.slice(0, index).some(containsAbruptCompletion)
        && terminallyClearsOrReturns(clause.statements[index]!, target);
    };
    const switchEntryTerminallyClears = (
      clauses: ts.NodeArray<ts.CaseOrDefaultClause>,
      entryIndex: number,
      target: AliasClearTarget,
    ): boolean => {
      for (let index = entryIndex; index < clauses.length; index++) {
        const clause = clauses[index]!;
        if (clauseTerminallyClears(clause, target)) return true;
        // A label-only group has no behavior of its own and necessarily enters
        // the following clause. Non-empty fallthrough remains conservative.
        if (clause.statements.some((statement) => !ts.isEmptyStatement(statement))) return false;
      }
      return false;
    };
    const finiteLiteralKey = (type: ts.Type): string | undefined => {
      if ((type.flags & ts.TypeFlags.EnumLiteral) !== 0) return undefined;
      if (type.isStringLiteral()) return `string:${type.value}`;
      if (type.isNumberLiteral()) return `number:${type.value}`;
      if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
        const intrinsic = type as ts.Type & { intrinsicName?: string };
        return intrinsic.intrinsicName === "true" || intrinsic.intrinsicName === "false" ? `boolean:${intrinsic.intrinsicName}` : undefined;
      }
      return undefined;
    };
    const switchIsExhaustive = (statement: ts.SwitchStatement): boolean => {
      const clauses = statement.caseBlock.clauses;
      if (clauses.some(ts.isDefaultClause)) return true;
      const discriminant = checker.getTypeAtLocation(statement.expression);
      const members = discriminant.isUnion() ? discriminant.types : [discriminant];
      const expected = members.map(finiteLiteralKey);
      if (expected.length === 0 || expected.some((key) => key === undefined)) return false;
      const covered = new Set(clauses.flatMap((clause) => {
        if (!ts.isCaseClause(clause)) return [];
        const key = finiteLiteralKey(checker.getTypeAtLocation(clause.expression));
        return key === undefined ? [] : [key];
      }));
      return expected.every((key) => covered.has(key!));
    };
    const isConditionalResourceExecution = (node: ts.Node): boolean => {
      if (isConditionalExecution(node)) return true;
      let child = node;
      for (let parent = node.parent; parent && parent !== ownerNode; child = parent, parent = parent.parent) {
        if (ts.isCatchClause(parent)) return true;
        if (ts.isTryStatement(parent) && (child === parent.tryBlock || child === parent.catchClause)) return true;
      }
      return false;
    };
    const generationAtAssignment = (fact: ResourceAliasFact, node: ts.Node): ResourceAliasEscape["generation"] => {
      const resourceConditions = new Set(fact.resource.controlPaths.flat().map((condition) => `${condition.id}:${condition.expected}`));
      const relativePaths = resourceAliasControlPaths(node).map((path) => path.filter((condition) => !resourceConditions.has(`${condition.id}:${condition.expected}`)));
      const hasRelativeControl = relativePaths.some((path) => path.length > 0);
      if (!hasRelativeControl) return fact.generation;
      const combined = fact.generation.controlPaths.flatMap((existing) => relativePaths.flatMap((relative) => {
        const conditions = new Map(existing.map((condition) => [condition.id, condition]));
        for (const condition of relative) {
          const previous = conditions.get(condition.id);
          if (previous && previous.expected !== condition.expected) return [];
          conditions.set(condition.id, condition);
        }
        return [[...conditions.values()]];
      }));
      return { ...fact.generation, relation: "conditional", controlPaths: combined };
    };
    const collectDisposedAliasFlow = (node: ts.Node): void => {
      if (node !== ownerNode.body && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) for (const index of resourceRetentionParameters(checker, node, resourceRetentionCache)) {
        const argument = node.arguments?.[index];
        if (!argument) continue;
        const retained = aliasFact(argument);
        if (!retained) continue;
        const via = ts.isNewExpression(node) ? "retaining-construction" : "retaining-call";
        resourceEscapes.push({ owner, resource: retained.resource.binding, via, span: { start: node.getStart(source), end: node.getEnd() } });
        diagnostics.push({
          fileName: source.fileName, functionName: owner, line: lineAt(source, argument.getStart(source)), kind: "disposed-resource-escape", severity: "error",
          message: `${owner} lets ${retained.resource.binding} escape through retaining ${ts.isNewExpression(node) ? "construction" : "call"} ${node.expression.getText(source)} argument ${index}, so it may be used after lexical disposal`,
          notes: [{ label: "because", detail: `${node.expression.getText(source)} retains argument ${index} beyond this call, while ${retained.resource.binding} is disposed at the end of its using scope` }],
        });
      }
      if (ts.isReturnStatement(node) && node.expression) {
        const returned = returnedResourceFact(node.expression);
        if (returned) {
          resourceEscapes.push({ owner, resource: returned.fact.resource.binding, via: returned.via, span: { start: node.getStart(source), end: node.getEnd() } });
          diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, node.getStart(source)), kind: "disposed-resource-escape", severity: "error", message: `${owner} lets ${returned.fact.resource.binding} escape through ${returned.via === "returned-closure" ? "a returned closure" : "return"} but disposes it before the caller can use it`, notes: [{ label: "binding", detail: source.text.slice(returned.fact.resource.span.start, returned.fact.resource.span.end) }, { label: "because", detail: `the using scope disposes ${returned.fact.resource.binding} before this function returns, so the caller receives a released resource` }] });
        }
      }
      if (ts.isIfStatement(node)) {
        collectDisposedAliasFlow(node.expression);
        collectDisposedAliasFlow(node.thenStatement);
        if (node.elseStatement) collectDisposedAliasFlow(node.elseStatement);
        if (node.elseStatement) {
          for (const symbol of [...escapedAliases.keys()]) {
            const target: AliasClearTarget = { kind: "symbol", symbol };
            if (terminallyClearsOrReturns(node.thenStatement, target)
              && terminallyClearsOrReturns(node.elseStatement, target)) escapedAliases.delete(symbol);
          }
          for (const [root, slots] of escapedAggregateAliases) for (const key of [...slots.keys()]) {
            const target: AliasClearTarget = { kind: "slot", root, key };
            if (terminallyClearsOrReturns(node.thenStatement, target)
              && terminallyClearsOrReturns(node.elseStatement, target)) slots.delete(key);
          }
        }
        return;
      }
      if (ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)
        || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
        const aliasesBefore = new Map(escapedAliases);
        const slotsBefore = new Map([...escapedAggregateAliases].map(([root, slots]) => [root, new Map(slots)]));
        if (ts.isForStatement(node)) {
          if (node.initializer) collectDisposedAliasFlow(node.initializer);
          if (node.condition) collectDisposedAliasFlow(node.condition);
        } else if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
          collectDisposedAliasFlow(node.initializer);
          collectDisposedAliasFlow(node.expression);
        } else if (ts.isWhileStatement(node)) collectDisposedAliasFlow(node.expression);
        collectDisposedAliasFlow(node.statement);
        if (ts.isForStatement(node) && node.incrementor) collectDisposedAliasFlow(node.incrementor);
        if (ts.isDoStatement(node)) collectDisposedAliasFlow(node.expression);

        const maySkip = !ts.isDoStatement(node);
        for (const [symbol, fact] of [...escapedAliases]) {
          const before = aliasesBefore.get(symbol);
          if (fact === before) continue;
          const target: AliasClearTarget = { kind: "symbol", symbol };
          if (!loopBodyMustClear(node.statement, target)) continue;
          if (maySkip && before) escapedAliases.set(symbol, before);
          else escapedAliases.delete(symbol);
        }
        for (const [root, slots] of escapedAggregateAliases) for (const [key, fact] of [...slots]) {
          const before = slotsBefore.get(root)?.get(key);
          if (fact === before) continue;
          const target: AliasClearTarget = { kind: "slot", root, key };
          if (!loopBodyMustClear(node.statement, target)) continue;
          if (maySkip && before) slots.set(key, before);
          else slots.delete(key);
        }
        return;
      }
      if (ts.isSwitchStatement(node)) {
        collectDisposedAliasFlow(node.expression);
        for (const clause of node.caseBlock.clauses) for (const statement of clause.statements) collectDisposedAliasFlow(statement);
        const clauses = node.caseBlock.clauses;
        if (switchIsExhaustive(node)) {
          for (const symbol of [...escapedAliases.keys()]) {
            const target: AliasClearTarget = { kind: "symbol", symbol };
            let everyEntrySafe = true;
            for (let index = 0; index < clauses.length; index++) {
              if (!switchEntryTerminallyClears(clauses, index, target)) { everyEntrySafe = false; break; }
            }
            if (everyEntrySafe) escapedAliases.delete(symbol);
          }
          for (const [root, slots] of escapedAggregateAliases) for (const key of [...slots.keys()]) {
            const target: AliasClearTarget = { kind: "slot", root, key };
            let everyEntrySafe = true;
            for (let index = 0; index < clauses.length; index++) {
              if (!switchEntryTerminallyClears(clauses, index, target)) { everyEntrySafe = false; break; }
            }
            if (everyEntrySafe) slots.delete(key);
          }
        }
        return;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const fact = aliasFact(node.right);
        if (ts.isIdentifier(node.left)) {
          const symbol = checker.getSymbolAtLocation(node.left);
          if (symbol && fact) escapedAliases.set(symbol, { resource: fact.resource, alias: node.left.text, generation: generationAtAssignment(fact, node), assignmentSpan: { start: node.getStart(source), end: node.getEnd() } });
          else if (symbol && !isConditionalResourceExecution(node)) escapedAliases.delete(symbol);
          const rightSymbol = ts.isIdentifier(node.right) ? checker.getSymbolAtLocation(node.right) : undefined;
          if (symbol && rightSymbol && !fact) aggregateRootAliases.set(symbol, resolveAggregateRoot(rightSymbol));
          else if (symbol && !isConditionalResourceExecution(node)) aggregateRootAliases.delete(symbol);
        } else {
          const slot = staticSlot(node.left);
          if (slot && fact) {
            const slots = escapedAggregateAliases.get(slot.root) ?? new Map<string, ResourceAliasFact>();
            for (const key of slots.keys()) if (key === slot.key || key.startsWith(`${slot.key}/`)) slots.delete(key);
            slots.set(slot.key, { resource: fact.resource, alias: slot.alias, generation: generationAtAssignment(fact, node), assignmentSpan: { start: node.getStart(source), end: node.getEnd() } });
            escapedAggregateAliases.set(slot.root, slots);
          } else if (slot && !isConditionalResourceExecution(node)) {
            const slots = escapedAggregateAliases.get(slot.root);
            if (slots) for (const key of slots.keys()) if (key === slot.key || key.startsWith(`${slot.key}/`)) slots.delete(key);
          }
        }
        if (!ts.isIdentifier(node.right)) collectDisposedAliasFlow(node.right);
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const symbol = checker.getSymbolAtLocation(node.name), fact = aliasFact(node.initializer);
        if (symbol && fact) escapedAliases.set(symbol, { resource: fact.resource, alias: node.name.text, generation: generationAtAssignment(fact, node), assignmentSpan: { start: node.getStart(source), end: node.getEnd() } });
        const initializerSymbol = node.initializer && ts.isIdentifier(node.initializer) ? checker.getSymbolAtLocation(node.initializer) : undefined;
        if (symbol && initializerSymbol && !fact) aggregateRootAliases.set(symbol, resolveAggregateRoot(initializerSymbol));
        if (node.initializer && !ts.isIdentifier(node.initializer)) collectDisposedAliasFlow(node.initializer);
        return;
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const slot = staticSlot(node), escaped = slot && escapedAggregateAliases.get(slot.root)?.get(slot.key);
        if (slot && escaped) {
          const declarationStart = slot.root.declarations?.[0]?.getStart() ?? -1;
          reportAliasUse(node, escaped, `${declarationStart}:${slot.key}`);
          return;
        }
        ts.forEachChild(node, collectDisposedAliasFlow);
        return;
      }
      if (ts.isIdentifier(node)) {
        const symbol = checker.getSymbolAtLocation(node), escaped = symbol && escapedAliases.get(symbol);
        const declarationName = ts.isVariableDeclaration(node.parent) && node.parent.name === node;
        if (symbol && escaped && !declarationName) reportAliasUse(node, escaped, symbol);
      }
      ts.forEachChild(node, collectDisposedAliasFlow);
    };
    collectDisposedAliasFlow(ownerNode.body);
    const uniqueGroups = [...allBindingGroups];
    for (const group of uniqueGroups) {
      if (generationManagedGroups.has(group)) continue;
      const symbols = new Set([...bindingGroups].filter(([, value]) => value === group).map(([symbol]) => symbol));
      type PathState = {
        active: boolean;
        pending: boolean;
        lost: boolean;
        terminated: boolean;
        completion?: "return" | "throw";
        abrupt?: "break" | "continue";
        label?: string;
      };
      const referencesGroup = (expression: ts.Expression): boolean => ts.isIdentifier(expression) && symbols.has(checker.getSymbolAtLocation(expression)!);
      const consumes = (node: ts.Node): boolean => {
        let consumed = false;
        const scan = (child: ts.Node): void => {
          if (consumed || (child !== node && ts.isFunctionLike(child))) return;
          if (ts.isAwaitExpression(child) && referencesGroup(child.expression)) { consumed = true; return; }
          if (ts.isReturnStatement(child) && child.expression && referencesGroup(child.expression)) { consumed = true; return; }
          if (ts.isVoidExpression(child) && options.allowVoid !== false && referencesGroup(child.expression)) { consumed = true; return; }
          if (ts.isCallExpression(child)) {
            const receiver = handledReceiver(child);
            if (receiver && referencesGroup(receiver)) { consumed = true; return; }
            if ([...rejectionConsumerParameters(checker, child)].some((index) => {
              const argument = child.arguments[index];
              return Boolean(argument && referencesGroup(argument));
            })) { consumed = true; return; }
          }
          if (ts.isShorthandPropertyAssignment(child) && symbols.has(checker.getShorthandAssignmentValueSymbol(child)!)) { consumed = true; return; }
          if (ts.isPropertyAssignment(child) && referencesGroup(child.initializer)) { consumed = true; return; }
          if (ts.isArrayLiteralExpression(child) && child.elements.some((element) => ts.isExpression(element) && referencesGroup(element))) { consumed = true; return; }
          ts.forEachChild(child, scan);
        };
        scan(node);
        return consumed;
      };
      const activates = (statement: ts.Node): boolean => {
        let active = false;
        const declaresGroup = (name: ts.BindingName): boolean => {
          if (ts.isIdentifier(name)) return symbols.has(checker.getSymbolAtLocation(name)!);
          return name.elements.some((element) => !ts.isOmittedExpression(element) && declaresGroup(element.name));
        };
        const scan = (node: ts.Node): void => {
          if (active || (node !== statement && ts.isFunctionLike(node))) return;
          if (ts.isVariableDeclaration(node) && node.initializer && declaresGroup(node.name)) active = true;
          else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && referencesGroup(node.left) && isPromiseLike(checker, node.right)) active = true;
          else ts.forEachChild(node, scan);
        };
        scan(statement);
        return active;
      };
      const reassigns = (statement: ts.Node): boolean => {
        let reassigned = false;
        const scan = (node: ts.Node): void => {
          if (reassigned || (node !== statement && ts.isFunctionLike(node))) return;
          if (ts.isBinaryExpression(node)
            && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
            && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            && referencesGroup(node.left) && isPromiseLike(checker, node.right) && !referencesGroup(node.right)) { reassigned = true; return; }
          ts.forEachChild(node, scan);
        };
        scan(statement);
        return reassigned;
      };
      const staticNullish = (original: ts.Expression): boolean | undefined => {
        let expression = original;
        while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
          || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
          || ts.isNonNullExpression(expression)) expression = expression.expression;
        if (expression.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(expression)) return true;
        if (expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
          || ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)) return false;
        if (ts.isIdentifier(expression)) {
          const initializer = immutableInitializer(expression);
          if (initializer && initializer !== expression) return staticNullish(initializer);
          const type = checker.getTypeAtLocation(expression);
          if ((type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) !== 0) return true;
        }
        return undefined;
      };
      const isGuaranteedThrowExpression = (original: ts.Expression): boolean => {
        let expression = original;
        while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
          || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
          || ts.isNonNullExpression(expression) || ts.isAwaitExpression(expression)
          || ts.isVoidExpression(expression)) expression = expression.expression;
        if (ts.isCallExpression(expression)) {
          const signature = checker.getResolvedSignature(expression);
          return signature !== undefined
            && (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Never) !== 0
            && declaresSynchronousThrow(signature.declaration);
        }
        if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          return isGuaranteedThrowExpression(expression.left) || isGuaranteedThrowExpression(expression.right);
        }
        if (ts.isBinaryExpression(expression)
          && (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
          if (isGuaranteedThrowExpression(expression.left)) return true;
          const left = staticPrimitive(expression.left, new Map())?.value;
          if (left === undefined) return false;
          const evaluatesRight = expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            ? Boolean(left)
            : !Boolean(left);
          return evaluatesRight && isGuaranteedThrowExpression(expression.right);
        }
        if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
          if (isGuaranteedThrowExpression(expression.left)) return true;
          return staticNullish(expression.left) === true && isGuaranteedThrowExpression(expression.right);
        }
        if (ts.isConditionalExpression(expression)) {
          if (isGuaranteedThrowExpression(expression.condition)) return true;
          const condition = staticPrimitive(expression.condition, new Map())?.value;
          if (condition !== undefined) return isGuaranteedThrowExpression(Boolean(condition) ? expression.whenTrue : expression.whenFalse);
          return isGuaranteedThrowExpression(expression.whenTrue)
            && isGuaranteedThrowExpression(expression.whenFalse);
        }
        return false;
      };
      const isGuaranteedThrowStatement = (statement: ts.Statement): boolean => {
        if (ts.isExpressionStatement(statement)) return isGuaranteedThrowExpression(statement.expression);
        if (ts.isReturnStatement(statement) && statement.expression) return isGuaranteedThrowExpression(statement.expression);
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
          const initializer = statement.declarationList.declarations[0]!.initializer;
          return initializer !== undefined && isGuaranteedThrowExpression(initializer);
        }
        return false;
      };
      const switchIsExhaustive = (statement: ts.SwitchStatement): boolean => {
        if (statement.caseBlock.clauses.some(ts.isDefaultClause)) return true;
        const type = checker.getTypeAtLocation(statement.expression);
        if (!type.isUnion()) return false;
        const possible = new Set(type.types.map((item) => checker.typeToString(item)));
        const covered = new Set(statement.caseBlock.clauses.flatMap((clause) =>
          ts.isCaseClause(clause) ? [checker.typeToString(checker.getTypeAtLocation(clause.expression))] : []));
        return possible.size > 0 && [...possible].every((item) => covered.has(item));
      };
      const executeSwitchPath = (clauses: readonly ts.CaseOrDefaultClause[], start: number, state: PathState): PathState[] => {
        type SwitchState = { state: PathState; broken: boolean };
        let states: SwitchState[] = [{ state: { ...state }, broken: false }];
        for (const clause of clauses.slice(start)) for (const statement of clause.statements) {
          states = states.flatMap((current): SwitchState[] => {
            if (current.broken || current.state.terminated) return [current];
            if (ts.isBreakStatement(statement) && !statement.label) return [{ state: current.state, broken: true }];
            return executeStatement(statement, current.state).map((next) => ({ state: next, broken: false }));
          });
        }
        return states.map(({ state: next }) => next);
      };
      const executeFinally = (block: ts.Block, state: PathState): PathState[] => {
        const wasTerminated = state.terminated;
        const previousCompletion = state.completion;
        const previousAbrupt = state.abrupt, previousLabel = state.label;
        return executeStatements(block.statements, [{ ...state, terminated: false, completion: undefined, abrupt: undefined, label: undefined }]).map((next) => next.terminated || next.abrupt ? next : ({
          ...next, terminated: wasTerminated, completion: previousCompletion, abrupt: previousAbrupt, label: previousLabel,
        }));
      };
      const directGroupAwait = (statement: ts.Statement): boolean => {
        let expression: ts.Expression | undefined;
        if (ts.isExpressionStatement(statement)) expression = statement.expression;
        else if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
          expression = statement.declarationList.declarations[0]!.initializer;
        }
        if (!expression) return false;
        while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
        return ts.isAwaitExpression(expression) && referencesGroup(expression.expression);
      };
      const nonThrowingPrimitiveStatement = (statement: ts.Statement): boolean => {
        if (ts.isEmptyStatement(statement)) return true;
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.every((declaration) =>
          ts.isIdentifier(declaration.name)
          && (declaration.initializer === undefined || staticPrimitive(declaration.initializer, new Map()) !== undefined));
        if (!ts.isExpressionStatement(statement)) return false;
        const expression = statement.expression;
        if (ts.isVoidExpression(expression)) return staticPrimitive(expression.expression, new Map()) !== undefined;
        return staticPrimitive(expression, new Map()) !== undefined;
      };
      const nonThrowingPrimitiveExpression = (original: ts.Expression): boolean => {
        let expression = original;
        while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
          || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) expression = expression.expression;
        if (staticPrimitive(expression, new Map()) !== undefined) return true;
        if (ts.isPrefixUnaryExpression(expression) && expression.operator === ts.SyntaxKind.ExclamationToken) {
          return nonThrowingPrimitiveExpression(expression.operand);
        }
        if (!ts.isIdentifier(expression)) return false;
        const type = checker.getTypeAtLocation(expression);
        const members = type.isUnion() ? type.types : [type];
        const primitive = ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike
          | ts.TypeFlags.BigIntLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined;
        return members.length > 0 && members.every((member) =>
          (member.flags & primitive) !== 0
          && (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) === 0);
      };
      const statementGuaranteesObservationBeforeCatch = (statement: ts.Statement): boolean => {
        if (ts.isBlock(statement)) return statementsGuaranteeObservationBeforeCatch(statement.statements);
        if (directGroupAwait(statement)) return true;
        if (ts.isTryStatement(statement)) {
          if (!statementsGuaranteeObservationBeforeCatch(statement.tryBlock.statements)) return false;
          if (statement.catchClause && reassigns(statement.catchClause.block)) return false;
          if (statement.finallyBlock && reassigns(statement.finallyBlock)) return false;
          return true;
        }
        if (ts.isSwitchStatement(statement)) {
          if (!nonThrowingPrimitiveExpression(statement.expression) || !switchIsExhaustive(statement)
            || statement.caseBlock.clauses.some((clause) =>
              ts.isCaseClause(clause) && !nonThrowingPrimitiveExpression(clause.expression))) return false;
          const entryStatements = (entry: number): ts.Statement[] => {
            const path: ts.Statement[] = [];
            for (const clause of statement.caseBlock.clauses.slice(entry)) for (const child of clause.statements) {
              if (ts.isBreakStatement(child) && !child.label) return path;
              path.push(child);
              if (ts.isReturnStatement(child) || ts.isThrowStatement(child)) return path;
            }
            return path;
          };
          return statement.caseBlock.clauses.every((_, index) =>
            statementsGuaranteeObservationBeforeCatch(entryStatements(index)));
        }
        if (!ts.isIfStatement(statement) || !statement.elseStatement
          || !nonThrowingPrimitiveExpression(statement.expression)) return false;
        return statementGuaranteesObservationBeforeCatch(statement.thenStatement)
          && statementGuaranteesObservationBeforeCatch(statement.elseStatement);
      };
      const statementsGuaranteeObservationBeforeCatch = (statements: readonly ts.Statement[]): boolean => {
        for (let index = 0; index < statements.length; index++) {
          const statement = statements[index]!;
          if (nonThrowingPrimitiveStatement(statement)) continue;
          if (!statementGuaranteesObservationBeforeCatch(statement)) return false;
          return !statements.slice(index + 1).some(reassigns);
        }
        return false;
      };
      const preciseAwaitCatchEntries = (block: ts.Block, state: PathState): PathState[] | undefined => {
        if (!statementsGuaranteeObservationBeforeCatch(block.statements)) return undefined;
        // This restricted shape has no operation before the await that can
        // enter catch. Every rejection edge at or after the await therefore
        // owns the Promise exactly like the fulfillment edge. A later
        // reassignment remains unsupported because it could install a new
        // Promise before a subsequent statement throws.
        const observed = executeNodeEffects(block, state);
        return [{ ...observed, terminated: false, completion: undefined, abrupt: undefined, label: undefined }];
      };
      const stateKey = (state: PathState): string => `${Number(state.active)}${Number(state.pending)}${Number(state.lost)}${Number(state.terminated)}:${state.completion ?? ""}:${state.abrupt ?? ""}:${state.label ?? ""}`;
      const uniqueStates = (states: PathState[]): PathState[] => [...new Map(states.map((state) => [stateKey(state), state])).values()];
      const executeNodeEffects = (node: ts.Node, state: PathState): PathState => {
        const next = { ...state };
        const wasActive = next.active;
        if (activates(node) && !next.active) { next.active = true; next.pending = true; }
        if (reassigns(node) && wasActive) { if (next.pending) next.lost = true; next.pending = true; }
        if (consumes(node) && next.active) next.pending = false;
        return next;
      };
      const headerNodeGuaranteedThrow = (node: ts.Node): boolean => {
        if (ts.isExpression(node)) return isGuaranteedThrowExpression(node);
        if (ts.isVariableDeclarationList(node)) return node.declarations.some((declaration) =>
          declaration.initializer !== undefined && isGuaranteedThrowExpression(declaration.initializer));
        return false;
      };
      const executeHeaderNode = (node: ts.Node, state: PathState): PathState => {
        const next = executeNodeEffects(node, state);
        return headerNodeGuaranteedThrow(node)
          ? { ...next, terminated: true, completion: "throw" }
          : next;
      };
      const executeLoopTest = (statement: ts.IterationStatement, state: PathState): { state: PathState; outcome?: boolean | "throw" } => {
        const expression = ts.isWhileStatement(statement) || ts.isDoStatement(statement)
          ? statement.expression
          : ts.isForStatement(statement)
            ? statement.condition
            : undefined;
        if (!expression) return { state, outcome: ts.isForStatement(statement) ? true : undefined };
        const next = executeNodeEffects(expression, state);
        if (isGuaranteedThrowExpression(expression)) return {
          state: { ...next, terminated: true, completion: "throw" },
          outcome: "throw",
        };
        const value = staticPrimitive(expression, new Map())?.value;
        return {
          state: next,
          outcome: value === undefined ? undefined : Boolean(value),
        };
      };
      const executeLoop = (statement: ts.IterationStatement, state: PathState, atLeastOnce: boolean, loopLabel?: string): PathState[] => {
        type LoopValue = readonly PathState[];
        const span = { start: statement.getStart(source), end: statement.getEnd() };
        const prefix = `${owner}@loop:${span.start}`;
        const entryId = `${prefix}:entry`, bodyId = `${prefix}:body`;
        const backEdgeId = `${prefix}:back-edge`, exitId = `${prefix}:exit`;
        const valueKey = (value: LoopValue): string => [...value].map(stateKey).sort().join("|");
        const routeTest = (input: PathState, body: PathState[], exits: PathState[]): void => {
          const tested = executeLoopTest(statement, input);
          if (tested.outcome !== true) exits.push(tested.state);
          if (tested.outcome !== false && tested.outcome !== "throw") body.push(tested.state);
        };
        const executeIteration = (input: LoopValue): { back: PathState[]; exits: PathState[] } => {
          const back: PathState[] = [], exits: PathState[] = [];
          for (const entry of input) for (const next of executeStatement(statement.statement, entry)) {
            const matching = next.label === undefined || next.label === loopLabel;
            if (next.abrupt === "break" && matching) {
              exits.push({ ...next, abrupt: undefined, label: undefined });
              continue;
            }
            if ((next.abrupt && !(next.abrupt === "continue" && matching)) || next.terminated) {
              exits.push(next);
              continue;
            }
            const resumed = next.abrupt === "continue"
              ? { ...next, abrupt: undefined, label: undefined }
              : next;
            const advanced = ts.isForStatement(statement) && statement.incrementor
              ? executeHeaderNode(statement.incrementor, resumed)
              : resumed;
            if (advanced.terminated) {
              exits.push(advanced);
              continue;
            }
            routeTest(advanced, back, exits);
          }
          return { back: uniqueStates(back), exits: uniqueStates(exits) };
        };
        const result = solveBasicBlockFixedPoint<LoopValue>({
          entry: entryId,
          initial: [state],
          budget: { name: "promise-ownership-cfg-iterations", limit: PROMISE_OWNERSHIP_CFG_ITERATIONS },
          lattice: {
            bottom: () => [],
            equivalent: (left, right) => valueKey(left) === valueKey(right),
            join: (left, right) => ({ status: "joined", value: uniqueStates([...left, ...right]) }),
          },
          blocks: [
            {
              id: entryId,
              edges: [
                { to: bodyId, completion: "normal", role: "branch", sourceSpan: span },
                { to: exitId, completion: "normal", role: "branch", sourceSpan: span },
                { to: exitId, completion: "throw", role: "branch", sourceSpan: span },
              ],
              transfer: (input) => {
                if (atLeastOnce) return [{ to: bodyId, value: input }];
                const body: PathState[] = [], exits: PathState[] = [];
                for (const initial of input) routeTest(initial, body, exits);
                return [
                  ...(body.length > 0 ? [{ to: bodyId, value: uniqueStates(body) }] : []),
                  ...(exits.length > 0 ? [{ to: exitId, value: uniqueStates(exits) }] : []),
                ];
              },
            },
            {
              id: bodyId,
              edges: [
                { to: backEdgeId, completion: "normal", role: "forward", sourceSpan: span },
                { to: exitId, completion: "normal", role: "branch", sourceSpan: span },
                { to: exitId, completion: "return", role: "branch", sourceSpan: span },
                { to: exitId, completion: "throw", role: "branch", sourceSpan: span },
                { to: exitId, completion: "break", role: "branch", sourceSpan: span },
                { to: exitId, completion: "continue", role: "branch", sourceSpan: span },
              ],
              transfer: (input) => {
                const iteration = executeIteration(input);
                return [
                  ...(iteration.back.length > 0 ? [{ to: backEdgeId, value: iteration.back }] : []),
                  ...(iteration.exits.length > 0 ? [{ to: exitId, value: iteration.exits }] : []),
                ];
              },
            },
            {
              id: backEdgeId,
              edges: [{ to: bodyId, completion: "normal", role: "back-edge", sourceSpan: span }],
              transfer: (input) => [{ to: bodyId, value: input }],
            },
            { id: exitId, edges: [], transfer: () => [] },
          ],
        });
        if (result.status === "unknown") {
          const relevant = state.active || activates(statement) || reassigns(statement) || consumes(statement);
          return relevant
            ? [{ ...state, active: true, pending: true, lost: true, terminated: true }]
            : [{ ...state }];
        }
        const exits = [...(result.states.get(exitId) ?? [])];
        if (exits.length === 0) {
          const recurrent = result.states.get(backEdgeId) ?? [];
          exits.push(...recurrent
            .filter((candidate) => candidate.active && (candidate.pending || candidate.lost))
            .map((candidate) => ({ ...candidate, terminated: true })));
        }
        return uniqueStates(exits);
      };
      const executeStatement = (statement: ts.Statement, state: PathState, loopLabel?: string): PathState[] => {
        if (state.terminated || state.abrupt) return [state];
        if (ts.isLabeledStatement(statement)) {
          const label = statement.label.text;
          const results = executeStatement(statement.statement, state, ts.isIterationStatement(statement.statement, false) ? label : undefined);
          return results.map((next) => next.abrupt === "break" && next.label === label ? ({ ...next, abrupt: undefined, label: undefined }) : next);
        }
        if (ts.isBlock(statement)) return executeStatements(statement.statements, [state]);
        if (ts.isIfStatement(statement)) {
          const before = { ...state };
          if (consumes(statement.expression) && before.active) before.pending = false;
          const thenStates = executeStatement(statement.thenStatement, { ...before });
          const elseStates = statement.elseStatement ? executeStatement(statement.elseStatement, { ...before }) : [{ ...before }];
          return [...thenStates, ...elseStates];
        }
        if (ts.isSwitchStatement(statement)) {
          const before = { ...state };
          if (consumes(statement.expression) && before.active) before.pending = false;
          const clauses = statement.caseBlock.clauses;
          const entries = clauses.flatMap((_, index) => executeSwitchPath(clauses, index, before));
          if (!switchIsExhaustive(statement)) entries.push({ ...before });
          return entries;
        }
        if (ts.isTryStatement(statement)) {
          const tryStates = executeStatement(statement.tryBlock, { ...state });
          const thrown = tryStates.filter((completion) => completion.completion === "throw");
          const normal = statement.catchClause
            ? tryStates.filter((completion) => completion.completion !== "throw")
            : tryStates;
          // The initial state remains a conservative catch entry for calls and
          // property access whose synchronous throw behavior is not yet explicit
          // in this finite walker. Explicit throw completions retain their
          // ownership facts and are routed exclusively through the catch.
          const preciseAwaitEntries = statement.catchClause
            ? preciseAwaitCatchEntries(statement.tryBlock, state)
            : undefined;
          const catchInputs = statement.catchClause
            ? uniqueStates([
              ...(preciseAwaitEntries ?? [{ ...state }]),
              ...thrown.map((completion) => ({ ...completion, terminated: false, completion: undefined })),
            ])
            : [];
          const catchStates = statement.catchClause
            ? catchInputs.flatMap((entry) => executeStatement(statement.catchClause!.block, entry))
            : [];
          const completions = [...normal, ...catchStates];
          return statement.finallyBlock
            ? completions.flatMap((completion) => executeFinally(statement.finallyBlock!, completion))
            : completions;
        }
        if (ts.isForStatement(statement)) {
          const initialized = statement.initializer ? executeHeaderNode(statement.initializer, state) : state;
          if (initialized.terminated) return [initialized];
          return executeLoop(statement, initialized, false, loopLabel);
        }
        if (ts.isForInStatement(statement) || ts.isForOfStatement(statement)) {
          const initialized = executeHeaderNode(statement.expression, state);
          if (initialized.terminated) return [initialized];
          return executeLoop(statement, initialized, false, loopLabel);
        }
        if (ts.isWhileStatement(statement)) return executeLoop(statement, state, false, loopLabel);
        if (ts.isDoStatement(statement)) return executeLoop(statement, state, true, loopLabel);
        if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return [{ ...state, abrupt: ts.isBreakStatement(statement) ? "break" : "continue", label: statement.label?.text }];
        const next = executeNodeEffects(statement, state);
        const guaranteedThrow = isGuaranteedThrowStatement(statement);
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement) || guaranteedThrow) {
          next.terminated = true;
          next.completion = ts.isReturnStatement(statement) && !guaranteedThrow ? "return" : "throw";
        }
        return [next];
      };
      const executeStatements = (statements: readonly ts.Statement[], initial: PathState[]): PathState[] =>
        statements.reduce((states, statement) => states.flatMap((state) => executeStatement(statement, state)), initial);
      const states = ts.isBlock(ownerNode.body) ? executeStatements(ownerNode.body.statements, [{ active: false, pending: false, lost: false, terminated: false }]) : [];
      if (states.some((state) => state.active && (state.pending || state.lost))) for (const binding of group) binding.status = "floating";
    }
    for (const group of allBindingGroups) {
      if (conditionallyCreatedGroups.has(group)) for (const binding of group) binding.status = "floating";
      const binding = group[0]!;
      if (binding.status !== "floating") continue;
      diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, binding.span.start), kind: "floating-promise", severity: "error", message: `${owner} leaves Promise binding ${binding.binding} generation ${binding.generation} without await, return, rejection handler, explicit void, or responsibility transfer`, notes: [{ label: "because", detail: `every supported path through ${owner} leaves ${binding.binding} generation ${binding.generation} unobserved, so its rejection escapes as an unhandled rejection` }] });
    }
  };
  const boundedForIterations = (loop: ts.ForStatement): number | undefined => {
    if (!loop.initializer || !ts.isVariableDeclarationList(loop.initializer)
      || loop.initializer.declarations.length !== 1 || !loop.condition || !loop.incrementor) return undefined;
    const declaration = loop.initializer.declarations[0]!;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isNumericLiteral(declaration.initializer)) return undefined;
    const binding = declaration.name.text;
    if (!ts.isBinaryExpression(loop.condition) || !ts.isIdentifier(loop.condition.left)
      || loop.condition.left.text !== binding || !ts.isNumericLiteral(loop.condition.right)
      || loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return undefined;
    const increments = (ts.isPostfixUnaryExpression(loop.incrementor) || ts.isPrefixUnaryExpression(loop.incrementor))
      && loop.incrementor.operator === ts.SyntaxKind.PlusPlusToken
      && ts.isIdentifier(loop.incrementor.operand) && loop.incrementor.operand.text === binding;
    if (!increments) return undefined;
    const iterations = Number(loop.condition.right.text) - Number(declaration.initializer.text);
    return Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 8 ? iterations : undefined;
  };
  const isUsingStatement = (statement: ts.Statement): statement is ts.VariableStatement => ts.isVariableStatement(statement)
    && (statement.declarationList.flags & ts.NodeFlags.Using) === ts.NodeFlags.Using;
  const isDirectAwaitStatement = (statement: ts.Statement): boolean => ts.isExpressionStatement(statement)
    && ts.isAwaitExpression(statement.expression);
  const isBoundedConditionalResourceScope = (statement: ts.Statement): boolean => {
    if (!ts.isIfStatement(statement) || !statement.elseStatement || !ts.isIdentifier(statement.expression)) return false;
    const predicateType = checker.getTypeAtLocation(statement.expression);
    if (!(predicateType.flags & ts.TypeFlags.BooleanLike)) return false;
    const branchIsBounded = (branch: ts.Statement): boolean => {
      if (!ts.isBlock(branch) || branch.statements.length < 2) return false;
      const [resource, ...work] = branch.statements;
      return Boolean(resource && isUsingStatement(resource)
        && resource.declarationList.declarations.length === 1
        && work.every(isDirectAwaitStatement));
    };
    return branchIsBounded(statement.thenStatement) && branchIsBounded(statement.elseStatement);
  };
  const resolveTransferOwner = (
    statement: ts.Statement,
    completion: LoopTransferKind,
    target: CompletionTarget | undefined,
    owner: string,
    regionId: string,
    tryNode: ts.TryStatement,
  ): AsyncControlTransferOwner | undefined => {
    if (!target) return undefined;
    const containsUsing = (node: ts.Node): boolean => {
      let found = false;
      const scan = (current: ts.Node): void => {
        if (found || (current !== node && ts.isFunctionLike(current))) return;
        if (ts.isVariableStatement(current) && isUsingStatement(current)) {
          found = true;
          return;
        }
        ts.forEachChild(current, scan);
      };
      scan(node);
      return found;
    };
    for (let current: ts.Node | undefined = statement.parent; current && !ts.isFunctionLike(current); current = current.parent) {
      if (!(ts.isForStatement(current) || ts.isWhileStatement(current) || ts.isDoStatement(current)
        || ts.isForInStatement(current) || ts.isForOfStatement(current))) continue;
      const loop = current;
      const labeled = ts.isLabeledStatement(loop.parent) && loop.parent.statement === loop ? loop.parent : undefined;
      const owns = target.kind !== "label" || labeled?.label.text === target.label;
      if (!owns) continue;
      if (!ts.isBlock(loop.statement)) return undefined;
      const tryIndex = loop.statement.statements.indexOf(tryNode);
      if (tryIndex < 0) return undefined;
      const prefix = loop.statement.statements.slice(0, tryIndex);
      const conditionalScopes = prefix.filter(isBoundedConditionalResourceScope);
      const iterations = ts.isForStatement(loop) ? boundedForIterations(loop) : undefined;
      if (iterations) {
        if (tryIndex !== loop.statement.statements.length - 1
          || conditionalScopes.length > 1
          || !prefix.every((statement) => isUsingStatement(statement) || isBoundedConditionalResourceScope(statement))) return undefined;
      } else if (containsUsing(loop.statement)) return undefined;
      const kind: AsyncControlLoop["kind"] = ts.isWhileStatement(loop) ? "while"
        : ts.isForStatement(loop) ? "for"
          : ts.isForInStatement(loop) ? "for-in"
            : ts.isForOfStatement(loop) ? "for-of" : "do-while";
      const spanNode = labeled ?? loop;
      return {
        id: `${owner}@loop:${loop.getStart(source)}`,
        owner,
        regionId,
        ...(labeled ? { label: labeled.label.text } : {}),
        kind,
        transfers: [completion],
        iterationEvidence: iterations ? "exact" : "dynamic",
        ...(iterations ? { iterations } : {}),
        span: { start: spanNode.getStart(source), end: spanNode.getEnd() },
        bodySpan: { start: loop.statement.getStart(source), end: loop.statement.getEnd() },
      };
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node)) {
      const owner = enclosingFunctionName(node);
      const regionId = `${owner}@try:${node.getStart(source)}`;
      controlRegions.push({
        id: regionId,
        owner,
        trySpan: { start: node.tryBlock.getStart(source), end: node.tryBlock.getEnd() },
        fullSpan: { start: node.getStart(source), end: node.getEnd() },
        catchSpan: node.catchClause ? { start: node.catchClause.block.getStart(source), end: node.catchClause.block.getEnd() } : undefined,
        finallySpan: node.finallyBlock ? { start: node.finallyBlock.getStart(source), end: node.finallyBlock.getEnd() } : undefined,
      });
      const completion = (statement: ts.Statement): AsyncControlStatement["completion"] => ts.isReturnStatement(statement) ? "return" : ts.isThrowStatement(statement) ? "throw" : "normal";
      const completionPaths = (statement: ts.Statement): AsyncControlCompletionPath[] => {
        type InternalCompletionPath = AsyncControlCompletionPath;
        const executeStatements = (statements: readonly ts.Statement[], initial: AsyncControlCondition[]): InternalCompletionPath[] => {
          let active: AsyncControlCondition[][] = [initial];
          const abrupt: InternalCompletionPath[] = [];
          for (const child of statements) {
            const next: AsyncControlCondition[][] = [];
            for (const conditions of active) for (const path of execute(child, conditions)) {
              if (path.completion === "normal") next.push(path.controlConditions);
              else abrupt.push(path);
            }
            active = next;
          }
          return [...abrupt, ...active.map((controlConditions) => ({ controlConditions, completion: "normal" as const }))];
        };
        const execute = (current: ts.Statement, conditions: AsyncControlCondition[], attachedLabel?: string): InternalCompletionPath[] => {
          if (ts.isReturnStatement(current)) return [{ controlConditions: conditions, completion: "return" }];
          if (ts.isThrowStatement(current)) return [{ controlConditions: conditions, completion: "throw" }];
          if (ts.isBreakStatement(current)) return [{ controlConditions: conditions, completion: "break", target: breakTransferTarget(current.label?.text) }];
          if (ts.isContinueStatement(current)) return [{ controlConditions: conditions, completion: "continue", target: continueTransferTarget(current.label?.text) }];
          if (ts.isLabeledStatement(current)) {
            const paths = execute(current.statement, conditions, current.label.text);
            return paths.map((path) => path.completion === "break" && isTransferOwnedByLoop(path, current.label.text)
              ? { controlConditions: path.controlConditions, completion: "normal" }
              : path);
          }
          if (ts.isBlock(current)) return executeStatements(current.statements, conditions);
          if (ts.isIfStatement(current)) {
            const id = `${owner}@if:${current.getStart(source)}`;
            return [
              ...execute(current.thenStatement, [...conditions, { id, expected: true }]),
              ...(current.elseStatement ? execute(current.elseStatement, [...conditions, { id, expected: false }]) : [{ controlConditions: [...conditions, { id, expected: false }], completion: "normal" as const }]),
            ];
          }
          if (ts.isWhileStatement(current) || ts.isForStatement(current) || ts.isForInStatement(current) || ts.isForOfStatement(current)) {
            const condition = { id: `${owner}@loop:${current.getStart(source)}`, expected: true };
            const body = execute(current.statement, [...conditions, condition]).map((path): InternalCompletionPath => {
              const consumed = isTransferOwnedByLoop(path, attachedLabel);
              return consumed ? { controlConditions: path.controlConditions, completion: "normal" } : path;
            });
            const definitelyEnters = ts.isWhileStatement(current) && current.expression.kind === ts.SyntaxKind.TrueKeyword;
            return definitelyEnters ? body : [...body, { controlConditions: [...conditions, { ...condition, expected: false }], completion: "normal" }];
          }
          if (ts.isDoStatement(current)) return execute(current.statement, conditions).map((path) => {
            const consumed = isTransferOwnedByLoop(path, attachedLabel);
            return consumed ? { controlConditions: path.controlConditions, completion: "normal" } : path;
          });
          if (ts.isSwitchStatement(current)) {
            const clauses = current.caseBlock.clauses;
            const selectedPaths = clauses.flatMap((clause, clauseIndex) => {
              const statements: ts.Statement[] = [];
              let stopped = false;
              for (let index = clauseIndex; index < clauses.length && !stopped; index++) for (const child of clauses[index]!.statements) {
                if (ts.isBreakStatement(child) && !child.label) { stopped = true; break; }
                statements.push(child);
              }
              return executeStatements(statements, [...conditions, ...switchControlConditions(owner, source, clause)]);
            });
            if (!clauses.some(ts.isDefaultClause)) {
              const cases = clauses.filter(ts.isCaseClause);
              selectedPaths.push({
                controlConditions: [...conditions, ...cases.map((_, index) => ({ id: `${owner}@switch:${current.getStart(source)}:case:${index}`, expected: false }))],
                completion: "normal",
              });
            }
            return selectedPaths.map((path) => path.completion === "break" && isTransferOwnedByLoop(path, attachedLabel)
              ? { controlConditions: path.controlConditions, completion: "normal" }
              : path);
          }
          return [{ controlConditions: conditions, completion: "normal" }];
        };
        const paths = execute(statement, []).map((path): AsyncControlCompletionPath => {
          if (!isLoopTransfer(path.completion)) return path;
          const transferOwner = resolveTransferOwner(statement, path.completion, path.target, owner, regionId, node);
          if (!transferOwner) return path;
          const existing = controlTransferOwners.find((candidate) => candidate.id === transferOwner.id);
          if (existing) {
            if (!existing.transfers.includes(path.completion)) existing.transfers.push(path.completion);
          } else controlTransferOwners.push(transferOwner);
          return { ...path, ownerId: transferOwner.id };
        });
        for (const path of paths) {
          if (!isLoopTransfer(path.completion)) continue;
          if (path.ownerId) continue;
          const formatted = formatTargetedCompletion(path);
          diagnostics.push({
            fileName: source.fileName,
            functionName: owner,
            line: lineAt(source, statement.getStart(source)),
            kind: "unsupported-control-transfer",
            severity: "error",
            message: `${formatted} leaves the modeled handler CFG`,
            notes: [{
              label: "because",
              detail: "Promise rejection and resource cleanup cannot treat an unresolved loop transfer as normal completion",
            }],
          });
        }
        return paths;
      };
      const loopOf = (statement: ts.Statement): AsyncControlLoop | undefined => {
        let current = statement;
        while (ts.isLabeledStatement(current)) current = current.statement;
        const kind: AsyncControlLoop["kind"] | undefined = ts.isWhileStatement(current) ? "while"
          : ts.isForStatement(current) ? "for"
            : ts.isForInStatement(current) ? "for-in"
              : ts.isForOfStatement(current) ? "for-of"
                : ts.isDoStatement(current) ? "do-while" : undefined;
        return kind ? { id: `${owner}@loop:${current.getStart(source)}`, kind, atLeastOnce: ts.isDoStatement(current) } : undefined;
      };
      node.catchClause?.block.statements.forEach((statement, order) => controlStatements.push({ regionId, owner, region: "catch", order, completion: completion(statement), completionPaths: completionPaths(statement), loop: loopOf(statement), source: statement.getText(source), span: { start: statement.getStart(source), end: statement.getEnd() } }));
      node.finallyBlock?.statements.forEach((statement, order) => controlStatements.push({ regionId, owner, region: "finally", order, completion: completion(statement), completionPaths: completionPaths(statement), loop: loopOf(statement), source: statement.getText(source), span: { start: statement.getStart(source), end: statement.getEnd() } }));
    }
    if (ts.isFunctionLike(node) && "body" in node && node.body) visitFunction(node as ts.FunctionLikeDeclaration);
    ts.forEachChild(node, visit);
  };
  visit(source);
  const collectResourceDecisions = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node)) {
      const discriminantType = checker.getTypeAtLocation(node.expression);
      const constituents = discriminantType.isUnion() ? discriminantType.types : [discriminantType];
      const cases = node.caseBlock.clauses.filter(ts.isCaseClause);
      const finiteStringIdentifier = ts.isIdentifier(node.expression)
        && constituents.length > 0
        && constituents.every((type) => Boolean(type.flags & ts.TypeFlags.StringLiteral))
        && cases.every((clause) => ts.isStringLiteral(clause.expression));
      resourceSwitches.push({
        id: `${enclosingFunctionName(node)}@switch:${node.getStart(source)}`,
        owner: enclosingFunctionName(node),
        discriminant: finiteStringIdentifier ? "finite-string-identifier" : "unsupported",
        hasDefault: node.caseBlock.clauses.some(ts.isDefaultClause),
        caseCount: cases.length,
        span: { start: node.getStart(source), end: node.getEnd() },
      });
    }
    if (ts.isIfStatement(node)) {
      const predicateType = checker.getTypeAtLocation(node.expression);
      resourceIfs.push({
        id: `${enclosingFunctionName(node)}@if:${node.getStart(source)}`,
        owner: enclosingFunctionName(node),
        predicate: ts.isIdentifier(node.expression) && Boolean(predicateType.flags & ts.TypeFlags.BooleanLike)
          ? "boolean-identifier"
          : "unsupported",
        span: { start: node.getStart(source), end: node.getEnd() },
      });
    }
    ts.forEachChild(node, collectResourceDecisions);
  };
  collectResourceDecisions(source);
  const disposals: ResourceDisposal[] = [];
  const byScope = new Map<string, ResourceBinding[]>();
  for (const resource of resources) byScope.set(resource.scopeId, [...(byScope.get(resource.scopeId) ?? []), resource]);
  const scopes = [...byScope.values()].sort((left, right) => left[0]!.scopeEnd - right[0]!.scopeEnd || right[0]!.scopeDepth - left[0]!.scopeDepth);
  for (const values of scopes) values.slice().reverse().forEach((resource, order) => disposals.push({ owner: resource.owner, binding: resource.binding, order, asynchronous: resource.asynchronous, scopeId: resource.scopeId, scopeDepth: resource.scopeDepth, disposalPoint: resource.scopeEnd, mayFail: true, failureKind: resource.asynchronous ? "reject" : "throw", failureType: resource.disposalFailureType, catchesFailure: resource.catchesFailure, escapingFailure: resource.catchesFailure ? "none" : resource.ownerAsync ? "reject" : "throw", exits: ["normal", "return", "throw", "reject"] }));
  const promiseChains = analyzePromiseChainsInProgram(program, source);
  for (const promise of promises) {
    const chain = promiseChains.chains.findIndex((item) => item.owner === promise.owner && item.span.start === promise.span.start && item.span.end === promise.span.end);
    if (chain >= 0) promise.promiseChain = chain;
  }
  const controlEdges: AsyncControlEdge[] = [];
  for (const promise of promises) if (promise.promiseChain !== undefined && promise.observation === "await") {
    controlEdges.push({ owner: promise.owner, from: `promise:${promise.promiseChain}:fulfilled`, to: "await:resume", kind: "promise-fulfill" });
    controlEdges.push({ owner: promise.owner, from: `promise:${promise.promiseChain}:rejected`, to: promise.catchesRejection ? "catch" : "function:rejected", kind: promise.catchesRejection ? "promise-reject-caught" : "promise-reject-escapes" });
  }
  for (const disposal of disposals) {
    for (const exit of disposal.exits) controlEdges.push({ owner: disposal.owner, from: exit, to: `dispose:${disposal.binding}`, kind: "scope-exit" });
    const failure = disposal.failureKind === "reject" ? "rejected" : "threw";
    const kind = disposal.failureKind === "reject"
      ? disposal.catchesFailure ? "disposal-reject-caught" : "disposal-reject-escapes"
      : disposal.catchesFailure ? "disposal-throw-caught" : "disposal-throw-escapes";
    controlEdges.push({ owner: disposal.owner, from: `dispose:${disposal.binding}:${failure}`, to: disposal.catchesFailure ? "catch" : disposal.escapingFailure === "reject" ? "function:rejected" : "function:threw", kind });
  }
  return { fileName: source.fileName, promises, promiseBindings, resources, resourceAliases, resourceEscapes, disposals, promiseChains, controlEdges, controlRegions, controlStatements, controlTransferOwners, returnCompletions, throwCompletions, resourceSwitches, resourceIfs, ownershipObligations, diagnostics };
}

function logicVariables(expression: LogicExpression, names: Set<string>): void {
  if (expression.kind === "variable") names.add(expression.name);
  else if (expression.kind === "unary") logicVariables(expression.operand, names);
  else if (expression.kind === "binary") { logicVariables(expression.left, names); logicVariables(expression.right, names); }
}
function logicToQuint(expression: LogicExpression, rename: ReadonlyMap<string, string> = new Map()): string {
  if (expression.kind === "variable") return rename.get(expression.name) ?? expression.name;
  if (expression.kind === "boolean") return String(expression.value);
  if (expression.kind === "unary" && expression.operator === "not") return `not(${logicToQuint(expression.operand, rename)})`;
  if (expression.kind === "binary") {
    const operator = { and: "and", or: "or", eq: "==", neq: "!=" }[expression.operator];
    if (operator) return `(${logicToQuint(expression.left, rename)} ${operator} ${logicToQuint(expression.right, rename)})`;
  }
  throw new Error("ownership guards must be boolean");
}
export function generateOwnershipObligationSmt(obligation: OwnershipGuardObligation): string {
  const assumptions = obligation.assumptions.map(parseLogicExpression), goal = parseLogicExpression(obligation.goal), names = new Set<string>();
  [...assumptions, goal].forEach((expression) => logicVariables(expression, names));
  return [`(set-logic QF_UF)`, ...[...names].map((name) => `(declare-const ${name} Bool)`), ...assumptions.map((item) => `(assert ${logicToSmt(item)})`), `(assert (not ${logicToSmt(goal)}))`, "(check-sat)", ""].join("\n");
}
export function generateOwnershipObligationQuint(moduleName: string, obligation: OwnershipGuardObligation): string {
  const assumptions = obligation.assumptions.map(parseLogicExpression), goal = parseLogicExpression(obligation.goal), names = new Set<string>();
  [...assumptions, goal].forEach((expression) => logicVariables(expression, names));
  const variables = [...names], stateNames = new Map(variables.map((name) => [name, `guard_${safe(name)}`])), argumentNames = new Map(variables.map((name) => [name, `guard_${safe(name)}_arg`]));
  const assignments: string[] = [];
  for (let bits = 0; bits < 2 ** variables.length; bits++) assignments.push(`    all { ${variables.map((name, index) => `${stateNames.get(name)}' = ${Boolean(bits & (1 << index))}`).join(", ")} }`);
  const premiseExpression = assumptions.length ? assumptions.map((item) => logicToQuint(item, argumentNames)).join(" and ") : "true";
  return [`module ${safe(moduleName)} {`, ...variables.map((name) => `  var ${stateNames.get(name)}: bool`), "", "  action init = any {", assignments.join(",\n"), "  }", "", "  action step = all {", `    ${variables.map((name) => `${stateNames.get(name)}' = ${stateNames.get(name)}`).join(",\n    ")}`, "  }", "", `  pure def ownershipImplication(${variables.map((name) => `${argumentNames.get(name)}: bool`).join(", ")}): bool = not(${premiseExpression}) or ${logicToQuint(goal, argumentNames)}`, `  val ownershipSafe = ownershipImplication(${variables.map((name) => stateNames.get(name)).join(", ")})`, "}", ""].join("\n");
}

export function composeResourceFailures(result: AsyncSafetyResult, owner: string, primaryType: string | undefined, failingBindings: string[]): ResourceError | undefined {
  let completion: ResourceError | undefined = primaryType ? { kind: "error", errorType: primaryType, source: "body" } : undefined;
  for (const binding of failingBindings) {
    const disposal = result.disposals.find((item) => item.owner === owner && item.binding === binding);
    if (!disposal) throw new Error(`unknown disposal binding ${owner}.${binding}`);
    const error: ResourceError = { kind: "error", errorType: disposal.failureType, source: `dispose:${binding}` };
    completion = completion ? { kind: "suppressed", error, suppressed: completion } : error;
  }
  return completion;
}

export function analyzeAsyncSafety(fileName: string, text: string, analysisOptions: AsyncSafetyOptions = {}): AsyncSafetyResult {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.esnext.d.ts", "lib.dom.d.ts", "lib.esnext.disposable.d.ts"], types: ["node"], noEmit: true };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, version, onError, fresh) => name === fileName ? ts.createSourceFile(fileName, text, version, true, ts.ScriptKind.TS) : original(name, version, onError, fresh);
  const program = ts.createProgram([fileName], options, host);
  return analyzeAsyncSafetyInProgram(program, program.getSourceFile(fileName)!, analysisOptions);
}

function safe(name: string): string { return name.replace(/[^A-Za-z0-9_]/g, "_"); }
export function generateResourceSafetyQuint(moduleName: string, result: AsyncSafetyResult, options: { skipDisposal?: boolean; skipAwaitDisposal?: boolean; breakSuppressedError?: boolean; duplicateDisposal?: boolean; reorderDisposal?: boolean } = {}): string {
  const resources = result.resources;
  const lines = [`module ${safe(moduleName)} {`, "  var pc: int", "  var completion: int", "  var broken: bool"];
  resources.forEach((_, index) => lines.push(`  var acquired_${index}: bool`, `  var disposed_${index}: bool`, `  var disposing_${index}: bool`));
  lines.push("", "  action init = all {", "    pc' = 0,", "    completion' = 0,", "    broken' = false,");
  resources.forEach((_, index) => lines.push(`    acquired_${index}' = false,`, `    disposed_${index}' = false,`, `    disposing_${index}' = false,`));
  lines.push("  }");
  const actions: string[] = [];
  const emit = (name: string, guard: string[], updates: Map<string, string>): void => {
    actions.push(name); lines.push("", `  action ${name} = all {`, ...guard.map((item) => `    ${item},`), `    pc' = ${updates.get("pc") ?? "pc"},`, `    completion' = ${updates.get("completion") ?? "completion"},`, `    broken' = ${updates.get("broken") ?? "broken"},`);
    resources.forEach((_, index) => lines.push(`    acquired_${index}' = ${updates.get(`acquired_${index}`) ?? `acquired_${index}`},`, `    disposed_${index}' = ${updates.get(`disposed_${index}`) ?? `disposed_${index}`},`, `    disposing_${index}' = ${updates.get(`disposing_${index}`) ?? `disposing_${index}`},`));
    lines.push("  }");
  };
  resources.forEach((_, index) => {
    emit(`acquire_${index}`, [`pc == ${index}`], new Map([["pc", String(index + 1)], [`acquired_${index}`, "true"]]));
    emit(`acquire_fail_${index}`, [`pc == ${index}`], new Map([["pc", String(resources.length)], ["completion", "1"]]));
  });
  const disposalOrder = result.disposals.map((disposal) => resources.findIndex((resource) => resource.owner === disposal.owner && resource.binding === disposal.binding));
  disposalOrder.forEach((resourceIndex, order) => {
    const resource = resources[resourceIndex]!;
    const disposal = result.disposals[order]!;
    const current = resources.length + order, next = current + 1;
    emit(`skip_unacquired_${resourceIndex}`, [`pc == ${current}`, `not(acquired_${resourceIndex})`], new Map([["pc", String(next)]]));
    if (resource.asynchronous) {
      emit(`dispose_start_${resourceIndex}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`, `not(disposing_${resourceIndex})`], new Map([[`disposing_${resourceIndex}`, "true"]]));
      emit(`dispose_resume_${resourceIndex}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(next)], [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"]]));
      emit(`dispose_reject_${disposal.catchesFailure ? "caught" : "escapes"}_${resourceIndex}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(next)], ["completion", disposal.catchesFailure ? "0" : "if (completion == 0) 2 else 3"], [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"]]));
      if (options.skipAwaitDisposal) emit(`dispose_without_await_${resourceIndex}`, [`pc == ${current}`, `not(disposing_${resourceIndex})`], new Map([["pc", String(next)], ["broken", "true"]]));
    } else {
      emit(`dispose_${resourceIndex}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(next)], [`disposed_${resourceIndex}`, "true"]]));
      emit(`dispose_fail_${disposal.catchesFailure ? "caught" : "escapes"}_${resourceIndex}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(next)], ["completion", disposal.catchesFailure ? "0" : "if (completion == 0) 2 else 3"], [`disposed_${resourceIndex}`, "true"]]));
    }
    if (options.breakSuppressedError) emit(`dispose_suppression_broken_${resourceIndex}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `completion != 0`], new Map([["pc", String(next)], ["completion", "2"], ["broken", "true"], [`disposed_${resourceIndex}`, "true"]]));
  });
  if (options.reorderDisposal && disposalOrder.length > 1) {
    const wrong = disposalOrder[1]!;
    emit("dispose_reordered", [`pc == ${resources.length}`, `acquired_${wrong}`], new Map([["broken", "true"], [`disposed_${wrong}`, "true"]]));
  }
  if (options.skipDisposal && resources.length) emit("skip_disposal", [`pc == ${resources.length}`], new Map([["pc", String(resources.length + disposalOrder.length)], ["broken", "true"]]));
  const complete = resources.length + disposalOrder.length;
  if (options.duplicateDisposal && disposalOrder.length) {
    const duplicate = disposalOrder[0]!;
    emit("dispose_duplicated", [`pc == ${complete}`, `disposed_${duplicate}`], new Map([["broken", "true"]]));
  }
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const disposed = resources.map((_, index) => `(not(acquired_${index}) or disposed_${index})`).join(" and ") || "true";
  lines.push("", `  val resourceSafe = not(broken) and (pc != ${complete} or (${disposed}))`, "}", "");
  return lines.join("\n");
}

interface UnifiedAsyncQuintOptions {
  skipCleanup?: boolean;
  skipScopeCleanup?: boolean;
  skipDisposalHandler?: boolean;
  prematureDisposalHandler?: boolean;
  dropDisposalSuppression?: boolean;
  reuseStaleDisposal?: boolean;
  skipTransferCleanup?: boolean;
  reorderCleanup?: boolean;
  acquireBothBranches?: boolean;
  wrongBranchCleanup?: boolean;
  bypassIntermediateCleanup?: boolean;
  fallthroughAfterReturn?: boolean;
  returnBeforeCleanup?: boolean;
  fallthroughAfterThrow?: boolean;
  throwBeforeCleanup?: boolean;
  bypassThrowHandler?: boolean;
  skipNormalContinuation?: boolean;
  reacquireBeforeLoopCleanup?: boolean;
  bypassCaughtRejection?: boolean;
}

export function generateUnifiedAsyncQuint(
  moduleName: string,
  result: AsyncSafetyResult,
  owner: string,
  options: UnifiedAsyncQuintOptions = {},
): string {
  const unresolvedTransfer = result.controlStatements
    .filter((statement) => statement.owner === owner)
    .flatMap((statement) => statement.completionPaths)
    .find((path) => isLoopTransfer(path.completion) && !path.ownerId);
  if (unresolvedTransfer) {
    throw new Error(`${formatTargetedCompletion(unresolvedTransfer)} leaves the modeled handler CFG; unified async lowering refuses to treat it as normal completion`);
  }
  const resources = result.resources.filter((item) => item.owner === owner);
  const disposals = result.disposals.filter((item) => item.owner === owner);
  const aliases = result.resourceAliases
    .filter((item) => item.owner === owner)
    .sort((left, right) => left.assignmentSpan.start - right.assignmentSpan.start || left.useSpan.start - right.useSpan.start);
  const awaited = result.promises
    .filter((item) => item.owner === owner && item.observation === "await" && item.promiseChain !== undefined)
    .sort((left, right) => left.span.start - right.span.start);
  const controlRegions = result.controlRegions.filter((item) => item.owner === owner).sort((left, right) => left.fullSpan.start - right.fullSpan.start);
  const catchStatements = result.controlStatements.filter((item) => item.owner === owner && item.region === "catch").sort((left, right) => left.span.start - right.span.start);
  const finallyStatements = result.controlStatements.filter((item) => item.owner === owner && item.region === "finally").sort((left, right) => left.span.start - right.span.start);
  const transferOwners = result.controlTransferOwners.filter((item) => item.owner === owner);
  const returnCompletions = result.returnCompletions.filter((item) => item.owner === owner);
  const throwCompletions = result.throwCompletions.filter((item) => item.owner === owner);
  if (awaited.length === 0) throw new Error(`${owner} has no awaited analyzed Promise chain`);
  type NormalEvent =
    | { kind: "acquire"; index: number; position: number }
    | { kind: "await"; index: number; position: number }
    | { kind: "dispose"; index: number; position: number }
    | { kind: "alias-capture"; index: number; position: number }
    | { kind: "alias-use"; index: number; position: number }
    | { kind: "alias-loop-decision"; index: number; position: number };
  const awaitsInStatement = (statement: AsyncControlStatement): number[] => awaited
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => observation.span.start >= statement.span.start && observation.span.end <= statement.span.end)
    .map(({ index }) => index);
  const resourcesInStatement = (statement: AsyncControlStatement): number[] => resources
    .map((resource, index) => ({ resource, index }))
    .filter(({ resource }) => resource.span.start >= statement.span.start && resource.span.end <= statement.span.end)
    .map(({ index }) => index);
  const handlerStatements = [...catchStatements, ...finallyStatements];
  const handlerAwaitIndexes = new Set([...catchStatements, ...finallyStatements].flatMap((statement) => {
    return awaitsInStatement(statement);
  }));
  const handlerResourceIndexes = new Set(handlerStatements.flatMap(resourcesInStatement));
  const handlerDisposalIndexes = new Set(disposals.flatMap((disposal, index) => {
    const resourceIndex = resources.findIndex((resource) => resource.binding === disposal.binding && resource.scopeId === disposal.scopeId);
    return handlerResourceIndexes.has(resourceIndex) ? [index] : [];
  }));
  const repeatedLoopAliasIndexes = [...aliases.reduce((byAcquisition, alias, index) => {
    if (alias.generation.repeated && !byAcquisition.has(alias.generation.acquisitionIndex)) {
      byAcquisition.set(alias.generation.acquisitionIndex, index);
    }
    return byAcquisition;
  }, new Map<number, number>()).values()];
  const eventsInStatement = (statement: AsyncControlStatement): NormalEvent[] => [
    ...resourcesInStatement(statement).map((index): NormalEvent => ({ kind: "acquire", index, position: resources[index]!.span.start })),
    ...awaitsInStatement(statement).map((index): NormalEvent => ({ kind: "await", index, position: awaited[index]!.span.start })),
    ...[...handlerDisposalIndexes].flatMap((index): NormalEvent[] => {
      const disposal = disposals[index]!;
      return disposal.disposalPoint >= statement.span.start && disposal.disposalPoint <= statement.span.end
        ? [{ kind: "dispose", index, position: disposal.disposalPoint }]
        : [];
    }),
  ].sort((left, right) => left.position - right.position || ({ acquire: 0, "alias-capture": 1, await: 2, dispose: 3, "alias-loop-decision": 4, "alias-use": 5 }[left.kind] - { acquire: 0, "alias-capture": 1, await: 2, dispose: 3, "alias-loop-decision": 4, "alias-use": 5 }[right.kind]));
  const normalEvents: NormalEvent[] = [
    ...resources.flatMap((resource, index): NormalEvent[] => handlerResourceIndexes.has(index) ? [] : [{ kind: "acquire", index, position: resource.span.start }]),
    ...awaited.flatMap((observation, index): NormalEvent[] => handlerAwaitIndexes.has(index) ? [] : [{ kind: "await", index, position: observation.span.start }]),
    ...aliases.flatMap((alias, index): NormalEvent[] => [
      { kind: "alias-capture", index, position: alias.assignmentSpan.end },
      { kind: "alias-use", index, position: alias.useSpan.start },
    ]),
    ...repeatedLoopAliasIndexes.flatMap((index): NormalEvent[] => {
      const alias = aliases[index]!;
      const resource = resources.find((item) => item.acquisitionIndex === alias.generation.acquisitionIndex);
      const disposal = resource && disposals.find((item) => item.binding === resource.binding && item.scopeId === resource.scopeId);
      return disposal ? [{ kind: "alias-loop-decision", index, position: disposal.disposalPoint }] : [];
    }),
    ...disposals.flatMap((disposal, index): NormalEvent[] =>
      !handlerDisposalIndexes.has(index) && (awaited.some((observation) => observation.span.start > disposal.disposalPoint)
        || aliases.some((alias) => alias.useSpan.start > disposal.disposalPoint))
        ? [{ kind: "dispose", index, position: disposal.disposalPoint }]
        : []),
  ].sort((left, right) => left.position - right.position || ({ acquire: 0, "alias-capture": 1, await: 2, dispose: 3, "alias-loop-decision": 4, "alias-use": 5 }[left.kind] - { acquire: 0, "alias-capture": 1, await: 2, dispose: 3, "alias-loop-decision": 4, "alias-use": 5 }[right.kind]));
  let nextPc = 0;
  const normalLayout = normalEvents.map((event) => {
    const pc = nextPc;
    nextPc += event.kind === "await" ? 2 : 1;
    return { event, pc };
  });
  const regionLayouts = controlRegions.map((region) => {
    const regionCatch = catchStatements.filter((statement) => statement.regionId === region.id);
    const regionFinally = finallyStatements.filter((statement) => statement.regionId === region.id);
    const catchPc = nextPc;
    const catchLayout = regionCatch.map((statement) => {
      const pc = nextPc;
      const awaitIndexes = awaitsInStatement(statement);
      const events = eventsInStatement(statement).map((event) => { const eventPc = nextPc; nextPc += event.kind === "await" ? 2 : 1; return { event, pc: eventPc }; });
      if (events.length === 0) nextPc++;
      const loopDecisionPc = statement.loop && events.length > 0 ? nextPc++ : undefined;
      return { statement, pc, awaitIndexes, events, loopDecisionPc };
    });
    const afterCatchPc = nextPc++;
    const finallyPc = nextPc;
    const finallyLayout = regionFinally.map((statement) => {
      const pc = nextPc;
      const awaitIndexes = awaitsInStatement(statement);
      const events = eventsInStatement(statement).map((event) => { const eventPc = nextPc; nextPc += event.kind === "await" ? 2 : 1; return { event, pc: eventPc }; });
      if (events.length === 0) nextPc++;
      const loopDecisionPc = statement.loop && events.length > 0 ? nextPc++ : undefined;
      return { statement, pc, awaitIndexes, events, loopDecisionPc };
    });
    return { region, catchPc, catchLayout, afterCatchPc, finallyPc, finallyLayout };
  });
  const transferLayouts = transferOwners.map((transferOwner) => {
    const disposalIndexes = disposals.flatMap((disposal, index) => {
      const resource = resources.find((candidate) => candidate.binding === disposal.binding && candidate.scopeId === disposal.scopeId);
      return resource && resource.span.start >= transferOwner.bodySpan.start && resource.span.end <= transferOwner.bodySpan.end
        ? [index] : [];
    });
    const entryPc = normalLayout.find(({ event }) => event.position >= transferOwner.bodySpan.start && event.position <= transferOwner.bodySpan.end)?.pc;
    if (entryPc === undefined) throw new Error(`${transferOwner.id} has no modeled loop entry event`);
    const cleanupPc = nextPc;
    nextPc += disposalIndexes.length;
    const decisionPc = nextPc++;
    const breakCleanupPc = transferOwner.transfers.includes("break") ? nextPc : undefined;
    if (breakCleanupPc !== undefined) nextPc += disposalIndexes.length;
    const breakDecisionPc = breakCleanupPc === undefined ? undefined : nextPc++;
    return { transferOwner, disposalIndexes, entryPc, cleanupPc, decisionPc, breakCleanupPc, breakDecisionPc };
  });
  const cleanupPc = nextPc, completePc = cleanupPc + disposals.length;
  const containingTry = (position: number) => controlRegions
    .filter((region) => position >= region.trySpan.start && position <= region.trySpan.end)
    .sort((left, right) => (left.trySpan.end - left.trySpan.start) - (right.trySpan.end - right.trySpan.start))[0];
  const layoutFor = (regionId: string | undefined) => regionLayouts.find((layout) => layout.region.id === regionId);
  const enclosingRegion = (region: AsyncControlRegion) => controlRegions
    .filter((candidate) => candidate.id !== region.id && candidate.trySpan.start <= region.fullSpan.start && candidate.trySpan.end >= region.fullSpan.end)
    .sort((left, right) => (left.trySpan.end - left.trySpan.start) - (right.trySpan.end - right.trySpan.start))[0];
  const exceptionalTarget = (region: AsyncControlRegion): number => {
    const outer = layoutFor(enclosingRegion(region)?.id);
    if (!outer) return cleanupPc;
    if (outer.catchLayout.length) return outer.catchPc;
    if (outer.finallyLayout.length) return outer.finallyPc;
    return exceptionalTarget(outer.region);
  };
  const continuationPc = (end: number) => normalLayout.find(({ event }) => event.position > end)?.pc ?? cleanupPc;
  const transferLayoutForRegion = (regionId: string) => transferLayouts.find((layout) => layout.transferOwner.regionId === regionId);
  const transferTargetForPath = (path: AsyncControlCompletionPath): number | undefined => {
    const layout = transferLayouts.find((candidate) => candidate.transferOwner.id === path.ownerId);
    if (!layout) return undefined;
    return path.completion === "break" ? layout.breakCleanupPc : layout.cleanupPc;
  };
  const labels = resources.map((resource, index) => resources.filter((item) => item.binding === resource.binding).length === 1 ? safe(resource.binding) : `${safe(resource.binding)}_${index}`);
  const branchIds = [...new Set([
    ...resources.flatMap((item) => item.controlPaths.flat()),
    ...awaited.flatMap((item) => item.controlPaths.flat()),
    ...result.controlStatements.filter((item) => item.owner === owner).flatMap((item) => item.completionPaths.flatMap((path) => path.controlConditions)),
    ...returnCompletions.flatMap((item) => item.controlPaths.flat()),
    ...throwCompletions.flatMap((item) => item.controlPaths.flat()),
    ...aliases.flatMap((item) => item.generation.controlPaths.flat()),
  ].map((condition) => condition.id))];
  const branchIndex = new Map(branchIds.map((id, index) => [id, index]));
  const conditionGuards = (conditions: readonly AsyncControlCondition[]): string[] => conditions.map((condition) => `branch_${branchIndex.get(condition.id)!} == ${condition.expected ? 1 : 0}`);
  const conditionPathGuards = (paths: readonly (readonly AsyncControlCondition[])[]): string[] => {
    if (paths.length <= 1) return conditionGuards(paths[0] ?? []);
    const alternatives = paths.map((path) => path.length ? path.map((condition) => `branch_${branchIndex.get(condition.id)!} == ${condition.expected ? 1 : 0}`).join(" and ") : "true");
    return [`(${alternatives.join(") or (")})`];
  };
  const conditionPathMismatch = (paths: readonly (readonly AsyncControlCondition[])[]): string | undefined => {
    if (paths.length <= 1) {
      const conditions = paths[0] ?? [];
      return conditions.length ? conditions.map((condition) => `branch_${branchIndex.get(condition.id)!} == ${condition.expected ? 0 : 1}`).join(" or ") : undefined;
    }
    const guards = conditionPathGuards(paths);
    if (guards.length === 0) return undefined;
    return `not(${guards.join(" and ")})`;
  };
  const conditionPathsOverlap = (
    leftPaths: readonly (readonly AsyncControlCondition[])[],
    rightPaths: readonly (readonly AsyncControlCondition[])[],
  ): boolean => leftPaths.some((left) => rightPaths.some((right) => !left.some((leftCondition) =>
    right.some((rightCondition) => rightCondition.id === leftCondition.id && rightCondition.expected !== leftCondition.expected),
  )));
  const switchGroupId = (condition: AsyncControlCondition): string | undefined => {
    const match = /^(.*@switch:\d+):case:\d+$/.exec(condition.id);
    return match?.[1];
  };
  const ifGroupIdFromId = (id: string): string | undefined => /@if:\d+$/.test(id) ? id : undefined;
  const ifGroupId = (condition: AsyncControlCondition): string | undefined => ifGroupIdFromId(condition.id);
  const isDecisionCondition = (condition: AsyncControlCondition): boolean => condition.role !== "fallthrough"
    && (switchGroupId(condition) !== undefined || ifGroupId(condition) !== undefined);
  const allResourceDecisionGroups = [...resources.reduce((groups, resource, resourceIndex) => {
    const groupIds = new Set(resource.controlPaths.flatMap((path) => {
      const root = path.find(isDecisionCondition);
      return root ? [switchGroupId(root) ?? ifGroupId(root)!] : [];
    }));
    for (const groupId of groupIds) {
      const indexes = groups.get(groupId) ?? [];
      indexes.push(resourceIndex);
      groups.set(groupId, indexes);
    }
    return groups;
  }, new Map<string, number[]>()).entries()];
  const resourceDecisionGroups = allResourceDecisionGroups.filter(([, resourceIndexes]) => resourceIndexes.length >= 2);
  const decisionGroupConditions = (resourceIndexes: readonly number[]): AsyncControlCondition[] =>
    resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.flat())
      .filter(isDecisionCondition);
  const sequentialResourceGroups = allResourceDecisionGroups.length === 2
    ? allResourceDecisionGroups.slice().sort((left, right) => {
      const first = Math.min(...left[1].map((resourceIndex) => resources[resourceIndex]!.span.start));
      const second = Math.min(...right[1].map((resourceIndex) => resources[resourceIndex]!.span.start));
      return first - second;
    })
    : [];
  const sequentialResourcePairs: Array<readonly [number, number]> = [];
  if (sequentialResourceGroups.length === 2) {
    const earlierIndexes = sequentialResourceGroups[0]![1];
    const laterIndexes = sequentialResourceGroups[1]![1];
    const earlierConditions = new Set(decisionGroupConditions(earlierIndexes).map(({ id }) => id));
    const laterConditions = new Set(decisionGroupConditions(laterIndexes).map(({ id }) => id));
    const independent = [...earlierConditions].every((id) => !laterConditions.has(id));
    const cleanupPrecedesLaterAcquisition = earlierIndexes.every((earlierIndex) => laterIndexes.every((laterIndex) =>
      resources[earlierIndex]!.scopeEnd <= resources[laterIndex]!.span.start,
    ));
    if (independent && cleanupPrecedesLaterAcquisition) {
      const combinedConditionCount = new Set([...earlierConditions, ...laterConditions]).size;
      if (combinedConditionCount > 8) {
        throw new Error(`${owner} sequential resource decisions exceed the eight-condition proof budget`);
      }
      for (const [groupId, resourceIndexes] of sequentialResourceGroups) {
        const conditions = decisionGroupConditions(resourceIndexes);
        const conditionIds = [...new Set(conditions.map(({ id }) => id))];
        if (groupId.includes("@switch:")) {
          const decision = result.resourceSwitches.find((candidate) => candidate.owner === owner && candidate.id === groupId);
          if (!decision || decision.discriminant !== "finite-string-identifier") {
            throw new Error(`${owner} sequential resource decision ${groupId} requires a finite string-literal union identifier discriminant`);
          }
          if (!decision.hasDefault) {
            throw new Error(`${owner} sequential resource decision ${groupId} has incomplete leaf coverage; add an explicit default resource path`);
          }
        }
        const unsupportedPredicate = conditionIds.find((conditionId) => ifGroupIdFromId(conditionId) !== undefined
          && !result.resourceIfs.some((decision) => decision.owner === owner
            && decision.id === conditionId
            && decision.predicate === "boolean-identifier"));
        if (unsupportedPredicate) {
          throw new Error(`${owner} sequential resource decision ${unsupportedPredicate} requires a Boolean identifier predicate`);
        }
        for (let left = 0; left < resourceIndexes.length; left++) for (let right = left + 1; right < resourceIndexes.length; right++) {
          if (conditionPathsOverlap(
            resources[resourceIndexes[left]!]!.controlPaths,
            resources[resourceIndexes[right]!]!.controlPaths,
          )) {
            throw new Error(`${owner} sequential resource decision ${groupId} has overlapping acquisition paths`);
          }
        }
        const groupPaths = resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.map((path) =>
          path.filter((condition) => conditionIds.includes(condition.id)),
        ));
        const coversSelection = (selection: number): boolean => groupPaths.some((path) => path.every((condition) => {
          const index = conditionIds.indexOf(condition.id);
          return index >= 0 && Boolean(selection & (1 << index)) === condition.expected;
        }));
        if (!Array.from({ length: 1 << conditionIds.length }, (_, selection) => selection).every(coversSelection)) {
          throw new Error(`${owner} sequential resource decision ${groupId} has incomplete leaf coverage`);
        }
      }
      for (const earlierIndex of earlierIndexes) for (const laterIndex of laterIndexes) {
        sequentialResourcePairs.push([earlierIndex, laterIndex]);
      }
    }
  }
  const mixedResourceGroups = resourceDecisionGroups.filter(([, resourceIndexes]) => {
    const conditions = resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.flat()).filter(isDecisionCondition);
    return conditions.some((condition) => switchGroupId(condition) !== undefined)
      && conditions.some((condition) => ifGroupId(condition) !== undefined);
  });
  for (const [groupId, resourceIndexes] of mixedResourceGroups) {
    const conditionIds = [...new Set(resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.flat()
      .filter(isDecisionCondition)
      .map((condition) => condition.id)))];
    const unsupportedPredicate = conditionIds.find((conditionId) => ifGroupIdFromId(conditionId) !== undefined
      && !result.resourceIfs.some((decision) => decision.owner === owner
        && decision.id === conditionId
        && decision.predicate === "boolean-identifier"));
    if (unsupportedPredicate) {
      throw new Error(`${owner} mixed resource decision ${unsupportedPredicate} requires a Boolean identifier predicate`);
    }
    if (conditionIds.length > 8) {
      throw new Error(`${owner} mixed resource decision ${groupId} exceeds the eight-condition proof budget`);
    }
    for (let left = 0; left < resourceIndexes.length; left++) for (let right = left + 1; right < resourceIndexes.length; right++) {
      const leftResource = resources[resourceIndexes[left]!]!;
      const rightResource = resources[resourceIndexes[right]!]!;
      if (conditionPathsOverlap(leftResource.controlPaths, rightResource.controlPaths)) {
        throw new Error(`${owner} mixed resource decision ${groupId} has overlapping acquisition paths`);
      }
    }
    const groupPaths = resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.map((path) =>
      path.filter(isDecisionCondition),
    ));
    const coversSelection = (selection: number): boolean => groupPaths.some((path) => path.every((condition) => {
      const index = conditionIds.indexOf(condition.id);
      return index >= 0 && Boolean(selection & (1 << index)) === condition.expected;
    }));
    if (!Array.from({ length: 1 << conditionIds.length }, (_, selection) => selection).every(coversSelection)) {
      throw new Error(`${owner} mixed resource decision ${groupId} has incomplete leaf coverage`);
    }
  }
  const switchResourceGroups = resourceDecisionGroups.filter(([groupId]) => groupId.includes("@switch:"));
  for (const [groupId, resourceIndexes] of switchResourceGroups) {
    const decision = result.resourceSwitches.find((candidate) => candidate.owner === owner && candidate.id === groupId);
    if (!decision || decision.discriminant !== "finite-string-identifier") {
      throw new Error(`${owner} switch resource join ${groupId} requires a finite string-literal union identifier discriminant`);
    }
    if (!decision.hasDefault) {
      throw new Error(`${owner} switch resource join ${groupId} is not exhaustive; add an explicit default resource path`);
    }
    const conditionIds = [...new Set(resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.flat()
      .filter((condition) => switchGroupId(condition) === groupId)
      .map((condition) => condition.id)))];
    if (conditionIds.length > 8) throw new Error(`${owner} switch resource join ${groupId} exceeds the eight-condition proof budget`);
    for (let left = 0; left < resourceIndexes.length; left++) for (let right = left + 1; right < resourceIndexes.length; right++) {
      const leftResource = resources[resourceIndexes[left]!]!;
      const rightResource = resources[resourceIndexes[right]!]!;
      if (conditionPathsOverlap(leftResource.controlPaths, rightResource.controlPaths)) {
        throw new Error(`${owner} switch resource join ${groupId} has overlapping or fallthrough acquisition paths`);
      }
    }
    const groupPaths = resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.map((path) =>
      path.filter((condition) => switchGroupId(condition) === groupId),
    ));
    const coversSelection = (selection: number): boolean => groupPaths.some((path) => path.every((condition) => {
      const index = conditionIds.indexOf(condition.id);
      return index >= 0 && Boolean(selection & (1 << index)) === condition.expected;
    }));
    if (!Array.from({ length: 1 << conditionIds.length }, (_, selection) => selection).every(coversSelection)) {
      throw new Error(`${owner} switch resource join ${groupId} is not exhaustive; add an explicit default resource path`);
    }
  }
  const ifResourceGroups = resourceDecisionGroups.filter(([groupId]) => groupId.includes("@if:"));
  for (const [groupId, resourceIndexes] of ifResourceGroups) {
    const conditionIds = [...new Set(resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.flat()
      .filter((condition) => ifGroupId(condition) !== undefined)
      .map((condition) => condition.id)))];
    const unsupportedPredicate = conditionIds.find((conditionId) => !result.resourceIfs.some((decision) =>
      decision.owner === owner && decision.id === conditionId && decision.predicate === "boolean-identifier",
    ));
    if (unsupportedPredicate) {
      throw new Error(`${owner} Boolean resource decision ${unsupportedPredicate} requires a Boolean identifier predicate`);
    }
    if (conditionIds.length > 8) throw new Error(`${owner} Boolean resource decision ${groupId} exceeds the eight-condition proof budget`);
    for (let left = 0; left < resourceIndexes.length; left++) for (let right = left + 1; right < resourceIndexes.length; right++) {
      const leftResource = resources[resourceIndexes[left]!]!;
      const rightResource = resources[resourceIndexes[right]!]!;
      if (conditionPathsOverlap(leftResource.controlPaths, rightResource.controlPaths)) {
        throw new Error(`${owner} Boolean resource decision ${groupId} has overlapping acquisition paths`);
      }
    }
    const groupPaths = resourceIndexes.flatMap((resourceIndex) => resources[resourceIndex]!.controlPaths.map((path) =>
      path.filter((condition) => ifGroupId(condition) !== undefined),
    ));
    const coversSelection = (selection: number): boolean => groupPaths.some((path) => path.every((condition) => {
      const index = conditionIds.indexOf(condition.id);
      return index >= 0 && Boolean(selection & (1 << index)) === condition.expected;
    }));
    if (!Array.from({ length: 1 << conditionIds.length }, (_, selection) => selection).every(coversSelection)) {
      throw new Error(`${owner} Boolean resource decision ${groupId} has incomplete leaf coverage`);
    }
  }
  const nonUniformReturnFacts = returnCompletions.flatMap((completion) => {
    const returnCondition = completion.controlPaths.flat().find((condition) =>
      condition.role !== "fallthrough" && ifGroupId(condition) !== undefined);
    if (!returnCondition) return [];
    const group = resourceDecisionGroups.find(([groupId]) => groupId === ifGroupId(returnCondition));
    if (!group) return [];
    const returnResourceIndexes = group[1].filter((resourceIndex) => resources[resourceIndex]!.controlPaths.some((path) =>
      path.some((condition) => condition.id === returnCondition.id && condition.expected === returnCondition.expected)));
    const normalResourceIndexes = group[1].filter((resourceIndex) => resources[resourceIndex]!.controlPaths.some((path) =>
      path.some((condition) => condition.id === returnCondition.id && condition.expected !== returnCondition.expected)));
    const laterResourceIndexes = resources.flatMap((resource, resourceIndex) => resource.controlPaths.some((path) =>
      path.some((condition) => condition.role === "fallthrough"
        && condition.id === returnCondition.id
        && condition.expected !== returnCondition.expected)) ? [resourceIndex] : []);
    return returnResourceIndexes.length > 0 && normalResourceIndexes.length > 0 && laterResourceIndexes.length > 0
      ? [{ completion, returnCondition, returnResourceIndexes, normalResourceIndexes, laterResourceIndexes }]
      : [];
  });
  const nonUniformThrowFacts = throwCompletions.flatMap((completion) => {
    const throwCondition = completion.controlPaths.flat().find((condition) =>
      condition.role !== "fallthrough" && ifGroupId(condition) !== undefined);
    if (!throwCondition) return [];
    const group = resourceDecisionGroups.find(([groupId]) => groupId === ifGroupId(throwCondition));
    if (!group) return [];
    const throwResourceIndexes = group[1].filter((resourceIndex) => resources[resourceIndex]!.controlPaths.some((path) =>
      path.some((condition) => condition.id === throwCondition.id && condition.expected === throwCondition.expected)));
    const normalResourceIndexes = group[1].filter((resourceIndex) => resources[resourceIndex]!.controlPaths.some((path) =>
      path.some((condition) => condition.id === throwCondition.id && condition.expected !== throwCondition.expected)));
    const laterResourceIndexes = resources.flatMap((resource, resourceIndex) => resource.controlPaths.some((path) =>
      path.some((condition) => condition.role === "fallthrough"
        && condition.id === throwCondition.id
        && condition.expected !== throwCondition.expected)) ? [resourceIndex] : []);
    return throwResourceIndexes.length > 0 && normalResourceIndexes.length > 0 && laterResourceIndexes.length > 0
      ? [{ completion, throwCondition, throwResourceIndexes, normalResourceIndexes, laterResourceIndexes }]
      : [];
  });
  const unsupportedNonUniformThrow = nonUniformThrowFacts.find(({ completion }) => !completion.errorLike);
  if (unsupportedNonUniformThrow) {
    throw new Error(`${owner} non-uniform throw requires a TypeChecker-proven Error-like value; ${unsupportedNonUniformThrow.completion.errorType} is unsupported`);
  }
  const lines = [`module ${safe(moduleName)} {`, "  var pc: int", "  var completion: int", "  var broken: bool", "  var disposal_failure_pending: bool", "  var disposal_failure_count: int", "  var disposal_failure_events: int", "  var handled_disposal_failure_kind: int", "  var handled_cleanup_failure: bool"];
  transferLayouts.forEach(({ transferOwner }) => lines.push(`  var loop_iteration_${safe(transferOwner.id)}: int`));
  branchIds.forEach((_, index) => lines.push(`  var branch_${index}: int`));
  resources.forEach((_, index) => lines.push(`  var acquired_${index}: bool`, `  var disposed_${index}: bool`, `  var disposing_${index}: bool`, `  var generation_${index}: int`, `  var disposed_generation_${index}: int`));
  aliases.forEach((_, index) => lines.push(`  var alias_generation_${index}: int`));
  lines.push("", "  action init = all {", "    pc' = 0,", "    completion' = 0,", "    broken' = false,");
  lines.push("    disposal_failure_pending' = false,");
  lines.push("    disposal_failure_count' = 0,", "    disposal_failure_events' = 0,", "    handled_disposal_failure_kind' = 0,", "    handled_cleanup_failure' = false,");
  transferLayouts.forEach(({ transferOwner }) => lines.push(`    loop_iteration_${safe(transferOwner.id)}' = 0,`));
  branchIds.forEach((_, index) => lines.push(`    branch_${index}' = -1,`));
  resources.forEach((_, index) => lines.push(`    acquired_${index}' = false,`, `    disposed_${index}' = false,`, `    disposing_${index}' = false,`, `    generation_${index}' = 0,`, `    disposed_generation_${index}' = -1,`));
  aliases.forEach((_, index) => lines.push(`    alias_generation_${index}' = -1,`));
  lines.push("  }");
  const actions: string[] = [];
  const emit = (name: string, guards: string[], updates = new Map<string, string>()): void => {
    actions.push(name);
    lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`), `    pc' = ${updates.get("pc") ?? "pc"},`, `    completion' = ${updates.get("completion") ?? "completion"},`, `    broken' = ${updates.get("broken") ?? "broken"},`, `    disposal_failure_pending' = ${updates.get("disposal_failure_pending") ?? "disposal_failure_pending"},`, `    disposal_failure_count' = ${updates.get("disposal_failure_count") ?? "disposal_failure_count"},`, `    disposal_failure_events' = ${updates.get("disposal_failure_events") ?? "disposal_failure_events"},`, `    handled_disposal_failure_kind' = ${updates.get("handled_disposal_failure_kind") ?? "handled_disposal_failure_kind"},`, `    handled_cleanup_failure' = ${updates.get("handled_cleanup_failure") ?? "handled_cleanup_failure"},`);
    transferLayouts.forEach(({ transferOwner }) => {
      const variable = `loop_iteration_${safe(transferOwner.id)}`;
      lines.push(`    ${variable}' = ${updates.get(variable) ?? variable},`);
    });
    branchIds.forEach((_, index) => lines.push(`    branch_${index}' = ${updates.get(`branch_${index}`) ?? `branch_${index}`},`));
    resources.forEach((_, index) => lines.push(`    acquired_${index}' = ${updates.get(`acquired_${index}`) ?? `acquired_${index}`},`, `    disposed_${index}' = ${updates.get(`disposed_${index}`) ?? `disposed_${index}`},`, `    disposing_${index}' = ${updates.get(`disposing_${index}`) ?? `disposing_${index}`},`, `    generation_${index}' = ${updates.get(`generation_${index}`) ?? `generation_${index}`},`, `    disposed_generation_${index}' = ${updates.get(`disposed_generation_${index}`) ?? `disposed_generation_${index}`},`));
    aliases.forEach((_, index) => lines.push(`    alias_generation_${index}' = ${updates.get(`alias_generation_${index}`) ?? `alias_generation_${index}`},`));
    lines.push("  }");
  };
  const resourceIndexForDisposal = (disposalIndex: number): number => {
    const disposal = disposals[disposalIndex]!;
    const resourceIndex = resources.findIndex((resource) => resource.binding === disposal.binding && resource.scopeId === disposal.scopeId);
    if (resourceIndex < 0) throw new Error(`${owner} disposal ${disposal.binding} has no matching resource`);
    return resourceIndex;
  };
  const resetCaughtDisposalState = (resource: ResourceBinding): readonly (readonly [string, string])[] => resource.catchesFailure ? [
    ["disposal_failure_pending", "false"],
    ["disposal_failure_count", "0"],
    ["disposal_failure_events", "0"],
    ["handled_disposal_failure_kind", "0"],
    ["handled_cleanup_failure", "false"],
  ] : [];
  const emitDisposal = (disposalIndex: number, current: number, next: number | string, suffix = "", routing: {
    failureNext?: number | string;
    failureEntersCatch?: boolean;
    handlerBypassNext?: number;
    prematureHandlerNext?: number;
    successNext?: number | string;
    successCompletion?: string;
  } = {}): void => {
    const disposal = disposals[disposalIndex]!;
    const resourceIndex = resourceIndexForDisposal(disposalIndex);
    const label = `${labels[resourceIndex]!}${suffix}`;
    const failureNext = routing.failureNext ?? next;
    const successNext = routing.successNext ?? next;
    const successUpdates = routing.successCompletion ? [["completion", routing.successCompletion]] as const : [];
    const failureUpdates = routing.failureEntersCatch ? [
      ["disposal_failure_pending", "true"],
      ["disposal_failure_count", "if (disposal_failure_count == 0) 1 else 2"],
      ["disposal_failure_events", "if (disposal_failure_events == 0) 1 else 2"],
    ] as const : [];
    emit(`skip_unacquired_${label}`, [`pc == ${current}`, `not(acquired_${resourceIndex})`], new Map([["pc", String(next)]]));
    emit(`skip_disposed_${label}`, [`pc == ${current}`, `disposed_${resourceIndex}`, `disposed_generation_${resourceIndex} == generation_${resourceIndex}`], new Map([["pc", String(next)]]));
    if (options.reuseStaleDisposal) emit(`skip_stale_disposed_${label}`, [`pc == ${current}`, `disposed_${resourceIndex}`, `disposed_generation_${resourceIndex} != generation_${resourceIndex}`], new Map([["pc", String(next)]]));
    if (disposal.asynchronous) {
      emit(`dispose_start_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`, `not(disposing_${resourceIndex})`], new Map([[`disposing_${resourceIndex}`, "true"]]));
      emit(`dispose_resume_${label}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(successNext)], ...successUpdates, [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      emit(`dispose_reject_${label}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(failureNext)], ["completion", disposal.catchesFailure ? "0" : "if (completion == 0 or completion == 4) 2 else 3"], ...failureUpdates, [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      if (options.skipDisposalHandler && routing.failureEntersCatch && routing.handlerBypassNext !== undefined) emit(`dispose_reject_without_handler_${label}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(routing.handlerBypassNext)], ["completion", "0"], ...failureUpdates, [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      if (options.prematureDisposalHandler && routing.failureEntersCatch && routing.prematureHandlerNext !== undefined) emit(`dispose_reject_premature_handler_${label}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(routing.prematureHandlerNext)], ["completion", "0"], ...failureUpdates, [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      if (options.dropDisposalSuppression && routing.failureEntersCatch) emit(`dispose_reject_lost_suppression_${label}`, [`pc == ${current}`, `disposing_${resourceIndex}`, "disposal_failure_events != 0"], new Map([["pc", String(failureNext)], ["completion", "0"], ["disposal_failure_pending", "true"], ["disposal_failure_events", "2"], [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
    } else {
      emit(`dispose_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(successNext)], ...successUpdates, [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      emit(`dispose_throw_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(failureNext)], ["completion", disposal.catchesFailure ? "0" : "if (completion == 0 or completion == 4) 2 else 3"], ...failureUpdates, [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      if (options.skipDisposalHandler && routing.failureEntersCatch && routing.handlerBypassNext !== undefined) emit(`dispose_throw_without_handler_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(routing.handlerBypassNext)], ["completion", "0"], ...failureUpdates, [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      if (options.prematureDisposalHandler && routing.failureEntersCatch && routing.prematureHandlerNext !== undefined) emit(`dispose_throw_premature_handler_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(routing.prematureHandlerNext)], ["completion", "0"], ...failureUpdates, [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
      if (options.dropDisposalSuppression && routing.failureEntersCatch) emit(`dispose_throw_lost_suppression_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`, "disposal_failure_events != 0"], new Map([["pc", String(failureNext)], ["completion", "0"], ["disposal_failure_pending", "true"], ["disposal_failure_events", "2"], [`disposed_${resourceIndex}`, "true"], [`disposed_generation_${resourceIndex}`, `generation_${resourceIndex}`]]));
    }
  };
  transferLayouts.forEach(({ transferOwner, disposalIndexes, entryPc, cleanupPc: transferCleanupPc, decisionPc, breakCleanupPc, breakDecisionPc }) => {
    const transferName = safe(transferOwner.label ?? transferOwner.id);
    disposalIndexes.forEach((disposalIndex, order) => {
      const current = transferCleanupPc + order;
      const next = order + 1 < disposalIndexes.length ? current + 1 : decisionPc;
      emitDisposal(disposalIndex, current, next, `_continue_${transferName}`, { failureNext: cleanupPc });
    });
    const iteration = `loop_iteration_${safe(transferOwner.id)}`;
    const repeats = transferOwner.iterations === undefined
      ? [] : [`${iteration} < ${transferOwner.iterations - 1}`];
    const exits = transferOwner.iterations === undefined
      ? [] : [`${iteration} >= ${transferOwner.iterations - 1}`];
    emit(`continue_${transferName}_repeat`, [
      `pc == ${decisionPc}`,
      ...repeats,
      "completion == 0",
    ], new Map([
      ["pc", String(entryPc)],
      ...(transferOwner.iterations === undefined ? [] : [[iteration, `${iteration} + 1`] as const]),
    ]));
    if (options.reacquireBeforeLoopCleanup && transferOwner.iterations !== undefined) for (const disposalIndex of disposalIndexes) {
      const resourceIndex = resourceIndexForDisposal(disposalIndex);
      emit(`continue_${transferName}_reacquire_before_cleanup_${labels[resourceIndex]}`, [
        `pc == ${decisionPc}`,
        ...repeats,
        `acquired_${resourceIndex}`,
      ], new Map([
        ["pc", String(entryPc)],
        [iteration, `${iteration} + 1`],
        [`disposed_${resourceIndex}`, "false"],
        [`disposed_generation_${resourceIndex}`, "-1"],
      ]));
    }
    emit(`continue_${transferName}_exit`, [
      `pc == ${decisionPc}`,
      ...exits,
      "completion == 0",
    ], new Map([["pc", String(continuationPc(transferOwner.span.end))]]));
    if (breakCleanupPc !== undefined && breakDecisionPc !== undefined) {
      disposalIndexes.forEach((disposalIndex, order) => {
        const current = breakCleanupPc + order;
        const next = order + 1 < disposalIndexes.length ? current + 1 : breakDecisionPc;
        emitDisposal(disposalIndex, current, next, `_break_${transferName}`, { failureNext: cleanupPc });
      });
      emit(`break_${transferName}_exit`, [
        `pc == ${breakDecisionPc}`,
        "completion == 0",
      ], new Map([["pc", String(continuationPc(transferOwner.span.end))]]));
      if (options.skipTransferCleanup) emit(`break_${transferName}_without_cleanup`, [
        `pc == ${breakCleanupPc}`,
      ], new Map([["pc", String(breakDecisionPc)], ["broken", "true"]]));
    }
  });
  branchIds.forEach((_, index) => {
    emit(`choose_branch_${index}_true`, [`branch_${index} == -1`], new Map([[`branch_${index}`, "1"]]));
    emit(`choose_branch_${index}_false`, [`branch_${index} == -1`], new Map([[`branch_${index}`, "0"]]));
  });
  if (options.skipNormalContinuation) {
    [
      ...nonUniformReturnFacts.map((fact) => fact.returnCondition),
      ...nonUniformThrowFacts.map((fact) => fact.throwCondition),
    ].forEach((condition, index) => {
      const branch = branchIndex.get(condition.id)!;
      emit(`skip_normal_continuation_fault_${index}`, ["pc == 0"], new Map([
        ["pc", "-2"],
        ["completion", "0"],
        [`branch_${branch}`, condition.expected ? "0" : "1"],
      ]));
    });
  }
  normalLayout.forEach(({ event, pc }, eventIndex) => {
    const nextEvent = normalLayout[eventIndex + 1];
    const eventRegion = containingTry(event.position);
    const eventRegionLayout = layoutFor(eventRegion?.id);
    const exitsRegion = eventRegion !== undefined && (nextEvent?.event.position ?? Number.POSITIVE_INFINITY) > eventRegion.fullSpan.end;
    const next = exitsRegion && eventRegionLayout?.finallyLayout.length
      ? eventRegionLayout.finallyPc
      : nextEvent?.pc ?? cleanupPc;
    if (event.kind === "alias-loop-decision") {
      const alias = aliases[event.index]!;
      const resourceIndex = resources.findIndex((resource) => resource.acquisitionIndex === alias.generation.acquisitionIndex);
      const acquirePc = normalLayout.find(({ event: candidate }) => candidate.kind === "acquire" && candidate.index === resourceIndex)?.pc;
      if (resourceIndex < 0 || acquirePc === undefined) throw new Error(`${owner} repeated alias ${alias.alias} has no acquisition event`);
      emit(`alias_loop_${event.index}_repeat`, [`pc == ${pc}`], new Map([["pc", String(acquirePc)]]));
      emit(`alias_loop_${event.index}_exit`, [`pc == ${pc}`], new Map([["pc", String(next)]]));
      return;
    }
    if (event.kind === "alias-capture") {
      const alias = aliases[event.index]!;
      const resourceIndex = resources.findIndex((resource) => resource.acquisitionIndex === alias.generation.acquisitionIndex);
      if (resourceIndex < 0) throw new Error(`${owner} alias ${alias.alias} references missing acquisition ${alias.generation.acquisitionIndex}`);
      emit(`capture_alias_${event.index}`, [`pc == ${pc}`, `acquired_${resourceIndex}`, ...conditionPathGuards(alias.generation.controlPaths)], new Map([
        ["pc", String(next)],
        [`alias_generation_${event.index}`, `generation_${resourceIndex}`],
      ]));
      if (alias.generation.relation === "conditional") {
        const mismatch = conditionPathMismatch(alias.generation.controlPaths);
        emit(`skip_conditional_capture_alias_${event.index}`, [`pc == ${pc}`, `acquired_${resourceIndex}`, ...(mismatch ? [mismatch] : [])], new Map([["pc", String(next)]]));
      }
      emit(`skip_capture_alias_${event.index}`, [`pc == ${pc}`, `not(acquired_${resourceIndex})`], new Map([["pc", String(next)]]));
      return;
    }
    if (event.kind === "alias-use") {
      const alias = aliases[event.index]!;
      const resourceIndex = resources.findIndex((resource) => resource.acquisitionIndex === alias.generation.acquisitionIndex);
      if (resourceIndex < 0) throw new Error(`${owner} alias ${alias.alias} references missing acquisition ${alias.generation.acquisitionIndex}`);
      emit(`use_disposed_alias_${event.index}`, [
        `pc == ${pc}`,
        `alias_generation_${event.index} >= 0`,
        `disposed_generation_${resourceIndex} == alias_generation_${event.index}`,
      ], new Map([["pc", String(next)], ["broken", "true"]]));
      emit(`use_live_or_absent_alias_${event.index}`, [
        `pc == ${pc}`,
        `(alias_generation_${event.index} < 0 or disposed_generation_${resourceIndex} != alias_generation_${event.index})`,
      ], new Map([["pc", String(next)]]));
      return;
    }
    if (event.kind === "acquire") {
      const resource = resources[event.index]!;
      const guards = [`pc == ${pc}`, ...conditionPathGuards(resource.controlPaths)];
      emit(`acquire_${labels[event.index]}`, guards, new Map([["pc", String(next)], ...resetCaughtDisposalState(resource), [`acquired_${event.index}`, "true"], [`disposed_${event.index}`, options.reuseStaleDisposal ? `disposed_${event.index}` : "false"], [`generation_${event.index}`, `generation_${event.index} + 1`]]));
      if (options.bypassIntermediateCleanup) for (const [earlierIndex, laterIndex] of sequentialResourcePairs) {
        if (laterIndex !== event.index) continue;
        emit(`acquire_${labels[laterIndex]}_before_${labels[earlierIndex]}_cleanup`, [
          ...guards,
          `acquired_${earlierIndex}`,
          `disposed_${earlierIndex}`,
          `disposed_generation_${earlierIndex} == generation_${earlierIndex}`,
        ], new Map([
          ["pc", "-3"],
          [`acquired_${laterIndex}`, "true"],
          [`disposed_${laterIndex}`, "false"],
          [`generation_${laterIndex}`, `generation_${laterIndex} + 1`],
          [`disposed_${earlierIndex}`, "false"],
        ]));
      }
      const protectedCleanup = resource.catchesFailure && eventRegion && eventRegionLayout?.catchLayout.length
        ? normalLayout.slice(eventIndex + 1).find(({ event: candidate }) => candidate.kind === "dispose"
          && disposals[candidate.index]!.catchesFailure
          && candidate.position <= eventRegion.trySpan.end)
        : undefined;
      const acquisitionFailureTarget = protectedCleanup?.pc
        ?? (resource.catchesFailure && eventRegionLayout?.catchLayout.length ? eventRegionLayout.catchPc : cleanupPc);
      const acquisitionFailureUpdates = new Map<string, string>([["pc", String(acquisitionFailureTarget)], ["completion", resource.catchesFailure ? "0" : "1"]]);
      if (protectedCleanup) {
        acquisitionFailureUpdates.set("disposal_failure_pending", "true");
        acquisitionFailureUpdates.set("disposal_failure_count", "1");
        acquisitionFailureUpdates.set("disposal_failure_events", "1");
      }
      emit(`acquire_fail_${labels[event.index]}`, guards, acquisitionFailureUpdates);
      const mismatch = conditionPathMismatch(resource.controlPaths);
      if (resource.conditional) {
        const mismatchGuards = mismatch ? [`pc == ${pc}`, mismatch] : [`pc == ${pc}`];
        emit(`skip_acquire_${labels[event.index]}`, mismatchGuards, new Map([["pc", String(next)]]));
        if (options.acquireBothBranches) emit(`acquire_unselected_${labels[event.index]}`, mismatchGuards, new Map([
          ["pc", String(next)],
          [`acquired_${event.index}`, "true"],
          [`disposed_${event.index}`, "false"],
          [`generation_${event.index}`, `generation_${event.index} + 1`],
        ]));
      }
      return;
    }
    if (event.kind === "dispose") {
      const resourceIndex = resourceIndexForDisposal(event.index);
      const resource = resources[resourceIndex]!;
      const returnCompletion = returnCompletions.find((candidate) => {
        const scopeStart = Number(resource.scopeId.slice(resource.scopeId.lastIndexOf("@") + 1));
        return candidate.span.start >= scopeStart && candidate.span.end <= resource.scopeEnd
          && conditionPathsOverlap(candidate.controlPaths, resource.controlPaths);
      });
      const throwCompletion = throwCompletions.find((candidate) => {
        const scopeStart = Number(resource.scopeId.slice(resource.scopeId.lastIndexOf("@") + 1));
        return candidate.span.start >= scopeStart && candidate.span.end <= resource.scopeEnd
          && conditionPathsOverlap(candidate.controlPaths, resource.controlPaths);
      });
      const failureEntersCatch = Boolean(disposals[event.index]!.catchesFailure && eventRegionLayout?.catchLayout.length);
      const nextIsSameScopeDisposal = nextEvent?.event.kind === "dispose"
        && disposals[nextEvent.event.index]!.scopeId === disposals[event.index]!.scopeId;
      const failureTarget = failureEntersCatch
        ? nextIsSameScopeDisposal ? nextEvent!.pc : eventRegionLayout!.catchPc
        : cleanupPc;
      const normalTarget = failureEntersCatch && !nextIsSameScopeDisposal
        ? `if (disposal_failure_pending) ${eventRegionLayout!.catchPc} else ${next}`
        : next;
      const handlerBypassTarget = failureEntersCatch
        ? eventRegionLayout!.finallyLayout.length ? eventRegionLayout!.finallyPc : continuationPc(eventRegion!.fullSpan.end)
        : undefined;
      const returnTarget = returnCompletion
        ? eventRegionLayout?.finallyLayout.length ? eventRegionLayout.finallyPc : cleanupPc
        : undefined;
      const returnSuccessTarget = returnTarget !== undefined && failureEntersCatch
        ? `if (disposal_failure_pending) ${eventRegionLayout!.catchPc} else ${returnTarget}`
        : returnTarget;
      const throwTarget = throwCompletion && eventRegionLayout?.catchLayout.length
        ? eventRegionLayout.catchPc
        : throwCompletion ? cleanupPc : undefined;
      const throwSuccessTarget = throwTarget !== undefined && failureEntersCatch
        ? `if (disposal_failure_pending) ${eventRegionLayout!.catchPc} else ${options.bypassThrowHandler ? eventRegionLayout?.finallyLayout.length ? eventRegionLayout.finallyPc : cleanupPc : throwTarget}`
        : throwTarget;
      const skipsNormalContinuation = options.skipNormalContinuation
        && [...nonUniformReturnFacts, ...nonUniformThrowFacts].some((fact) => fact.normalResourceIndexes.includes(resourceIndex));
      const skippedNormalTarget = skipsNormalContinuation
        ? failureEntersCatch
          ? `if (disposal_failure_pending) ${eventRegionLayout!.catchPc} else ${eventRegionLayout?.finallyLayout.length ? eventRegionLayout.finallyPc : cleanupPc}`
          : eventRegionLayout?.finallyLayout.length ? eventRegionLayout.finallyPc : cleanupPc
        : undefined;
      emitDisposal(event.index, pc, normalTarget, "_scope_exit", {
        failureNext: failureTarget,
        failureEntersCatch,
        handlerBypassNext: handlerBypassTarget,
        prematureHandlerNext: failureEntersCatch && nextIsSameScopeDisposal ? eventRegionLayout!.catchPc : undefined,
        successNext: skippedNormalTarget
          ?? (returnSuccessTarget !== undefined && !options.fallthroughAfterReturn ? returnSuccessTarget : undefined)
          ?? (throwSuccessTarget !== undefined && !options.fallthroughAfterThrow ? throwSuccessTarget : undefined),
        successCompletion: throwTarget !== undefined
          ? failureEntersCatch ? "if (disposal_failure_pending) 0 else 5" : "5"
          : returnTarget !== undefined
          ? failureEntersCatch ? "if (disposal_failure_pending) 0 else 4" : "4"
          : undefined,
      });
      if (returnTarget !== undefined && options.returnBeforeCleanup) emit(`return_before_cleanup_${labels[resourceIndex]}`, [
        `pc == ${pc}`,
        `acquired_${resourceIndex}`,
        `not(disposed_${resourceIndex})`,
      ], new Map([["pc", String(returnTarget)], ["completion", "4"]]));
      if (throwTarget !== undefined && options.throwBeforeCleanup) emit(`throw_before_cleanup_${labels[resourceIndex]}`, [
        `pc == ${pc}`,
        `acquired_${resourceIndex}`,
        `not(disposed_${resourceIndex})`,
      ], new Map([["pc", String(options.bypassThrowHandler ? eventRegionLayout?.finallyLayout.length ? eventRegionLayout.finallyPc : cleanupPc : throwTarget)], ["completion", "5"]]));
      if (options.wrongBranchCleanup) {
        const resourceIndex = resourceIndexForDisposal(event.index);
        const resource = resources[resourceIndex]!;
        const wrongResourceIndex = resources.findIndex((candidate, candidateIndex) => candidateIndex !== resourceIndex
          && candidate.conditional
          && !conditionPathsOverlap(resource.controlPaths, candidate.controlPaths));
        if (wrongResourceIndex >= 0) emit(`dispose_wrong_branch_${labels[wrongResourceIndex]!}_for_${labels[resourceIndex]!}`, [
          `pc == ${pc}`,
          `acquired_${resourceIndex}`,
          `not(disposed_${resourceIndex})`,
        ], new Map([
          [`disposed_${wrongResourceIndex}`, "true"],
          [`disposed_generation_${wrongResourceIndex}`, `generation_${wrongResourceIndex}`],
        ]));
      }
      if (options.reorderCleanup && nextIsSameScopeDisposal) {
        const wrongDisposalIndex = nextEvent!.event.kind === "dispose" ? nextEvent!.event.index : -1;
        const wrongResourceIndex = resourceIndexForDisposal(wrongDisposalIndex);
        emit(`dispose_reordered_${labels[wrongResourceIndex]!}_scope_exit`, [
          `pc == ${pc}`,
          `acquired_${wrongResourceIndex}`,
          `not(disposed_${wrongResourceIndex})`,
        ], new Map([
          [`disposed_${wrongResourceIndex}`, "true"],
          [`disposed_generation_${wrongResourceIndex}`, `generation_${wrongResourceIndex}`],
        ]));
      }
      if (options.skipScopeCleanup) emit(`skip_scope_cleanup_${labels[resourceIndexForDisposal(event.index)]!}`, [
        `pc == ${pc}`,
      ], new Map([["pc", String(next)], ["broken", "true"]]));
      return;
    }
    const observation = awaited[event.index]!;
    const chain = observation.promiseChain!;
    const guards = [`pc == ${pc}`, ...conditionPathGuards(observation.controlPaths)];
    emit(`promise_${chain}_fulfill`, guards, new Map([["pc", String(pc + 1)]]));
    const protectedCleanup = observation.catchesRejection && eventRegion
      ? normalLayout.slice(eventIndex + 1).find(({ event: candidate }) => candidate.kind === "dispose"
        && disposals[candidate.index]!.catchesFailure
        && candidate.position <= eventRegion.trySpan.end)
      : undefined;
    const rejectionTarget = protectedCleanup?.pc
      ?? (observation.catchesRejection && eventRegionLayout?.catchLayout.length ? eventRegionLayout.catchPc : cleanupPc);
    const rejectionUpdates = new Map<string, string>([["pc", String(rejectionTarget)]]);
    if (protectedCleanup) {
      rejectionUpdates.set("disposal_failure_pending", "true");
      rejectionUpdates.set("disposal_failure_count", "1");
      rejectionUpdates.set("disposal_failure_events", "1");
    }
    if (!observation.catchesRejection) rejectionUpdates.set("completion", "1");
    if (!observation.catchesRejection) rejectionUpdates.set("disposal_failure_pending", "false");
    emit(`promise_${chain}_${observation.catchesRejection ? "reject_caught" : "reject_escapes"}`, guards, rejectionUpdates);
    if (options.bypassCaughtRejection && observation.catchesRejection && eventRegionLayout?.catchLayout.length) {
      emit(`promise_${chain}_reject_without_handler`, guards, new Map([
        ["pc", String(eventRegionLayout.finallyLayout.length ? eventRegionLayout.finallyPc : continuationPc(eventRegion!.fullSpan.end))],
        ["broken", "true"],
      ]));
    }
    if (options.prematureDisposalHandler && protectedCleanup && eventRegionLayout?.catchLayout.length) emit(
      `promise_${chain}_reject_premature_handler`,
      guards,
      new Map([
        ["pc", String(eventRegionLayout.catchPc)],
        ["completion", "0"],
        ["disposal_failure_pending", "true"],
        ["disposal_failure_count", "1"],
        ["disposal_failure_events", "1"],
      ]),
    );
    const mismatch = conditionPathMismatch(observation.controlPaths);
    if (observation.conditional) emit(`skip_await_${chain}`, mismatch ? [`pc == ${pc}`, mismatch] : [`pc == ${pc}`], new Map([["pc", String(next)]]));
    const isLast = eventIndex === normalLayout.length - 1;
    const resumeName = awaited.length === 1
      ? eventRegionLayout?.finallyLayout.length ? "await_resume_finally" : "await_resume_return"
      : isLast ? `await_${chain}_resume_${eventRegionLayout?.finallyLayout.length ? "finally" : "return"}` : `await_${chain}_resume_next`;
    emit(resumeName, [`pc == ${pc + 1}`], new Map([["pc", String(next)]]));
  });
  const emitHandlerAwait = (region: "catch" | "finally", observation: PromiseObservation, pc: number, next: number | string, completion: AsyncControlStatement["completion"], failureTarget: number, resumeGuards: string[] = []): void => {
    const chain = observation.promiseChain!;
    const guards = [`pc == ${pc}`, ...conditionPathGuards(observation.controlPaths)];
    emit(`promise_${chain}_fulfill`, guards, new Map([["pc", String(pc + 1)]]));
    emit(`promise_${chain}_reject_escapes`, guards, new Map([["pc", String(failureTarget)], ["completion", "1"], ["handled_cleanup_failure", "disposal_failure_pending"], ["disposal_failure_pending", "false"], ["handled_disposal_failure_kind", "disposal_failure_count"]]));
    const resumeTarget = completion === "normal" ? next : failureTarget;
    const updates = new Map<string, string>([["pc", String(resumeTarget)]]);
    if (completion === "return" && region === "finally") updates.set("completion", "0");
    if (completion === "throw") updates.set("completion", "1");
    emit(`${region}_await_${chain}_resume`, [`pc == ${pc + 1}`, ...resumeGuards], updates);
    const mismatch = conditionPathMismatch(observation.controlPaths);
    if (observation.conditional) emit(`skip_handler_await_${chain}`, mismatch ? [`pc == ${pc}`, mismatch] : [`pc == ${pc}`], new Map([["pc", String(next)]]));
  };
  const sameConditions = (left: readonly AsyncControlCondition[], right: readonly AsyncControlCondition[]): boolean => left.length === right.length && left.every((condition, index) => condition.id === right[index]?.id && condition.expected === right[index]?.expected);
  const completionForAwait = (statement: AsyncControlStatement, awaitIndex: number, awaitIndexes: readonly number[]): AsyncControlStatement["completion"] => {
    const observation = awaited[awaitIndex]!;
    const path = statement.completionPaths.find((candidate) => observation.controlPaths.some((controlPath) => sameConditions(candidate.controlConditions, controlPath)));
    if (!path || path.completion === "normal") return "normal";
    const position = awaitIndexes.indexOf(awaitIndex);
    const hasLaterOnPath = awaitIndexes.slice(position + 1).some((laterIndex) => awaited[laterIndex]!.controlPaths.some((controlPath) => sameConditions(controlPath, path.controlConditions)));
    return hasLaterOnPath ? "normal" : path.completion;
  };
  regionLayouts.forEach((layout, regionIndex) => {
    const regionSuffix = regionLayouts.length === 1 ? "" : `_${regionIndex}`;
    const finalEntry = layout.finallyLayout.length ? layout.finallyPc : exceptionalTarget(layout.region);
    const afterRegion = transferLayoutForRegion(layout.region.id)?.cleanupPc ?? continuationPc(layout.region.fullSpan.end);
    layout.catchLayout.forEach(({ statement, pc, awaitIndexes, events, loopDecisionPc }, index) => {
      const next = layout.catchLayout[index + 1]?.pc ?? layout.afterCatchPc;
      if (events.length > 0) {
        events.forEach(({ event, pc: eventPc }, eventOrder) => {
          const eventNext = events[eventOrder + 1]?.pc ?? loopDecisionPc ?? next;
          if (event.kind === "acquire") {
            const resource = resources[event.index]!;
            const guards = [`pc == ${eventPc}`, ...conditionPathGuards(resource.controlPaths)];
            emit(`acquire_${labels[event.index]}`, guards, new Map([["pc", String(eventNext)], ...resetCaughtDisposalState(resource), [`acquired_${event.index}`, "true"], [`disposed_${event.index}`, options.reuseStaleDisposal ? `disposed_${event.index}` : "false"], [`generation_${event.index}`, `generation_${event.index} + 1`]]));
            emit(`acquire_fail_${labels[event.index]}`, guards, new Map([["pc", String(finalEntry)], ["completion", "1"]]));
            return;
          }
          if (event.kind === "dispose") {
            emitDisposal(event.index, eventPc, eventNext, "_handler_loop", { failureNext: finalEntry });
            return;
          }
          const awaitIndex = event.index;
          const completion = completionForAwait(statement, awaitIndex, awaitIndexes);
          emitHandlerAwait("catch", awaited[awaitIndex]!, eventPc, eventNext, completion, finalEntry);
        });
        if (loopDecisionPc !== undefined) {
          const repeatGuards = [`pc == ${loopDecisionPc}`];
          const branch = statement.loop && branchIndex.get(statement.loop.id);
          if (branch !== undefined) repeatGuards.push(`branch_${branch} == 1`);
          emit(`catch_loop_${index}_repeat`, repeatGuards, new Map([["pc", String(pc)]]));
          emit(`catch_loop_${index}_exit`, [`pc == ${loopDecisionPc}`], new Map([["pc", String(next)]]));
        }
        return;
      }
      const pathSuffix = statement.completionPaths.length === 1 && statement.completionPaths[0]!.controlConditions.length === 0 ? undefined : statement.completionPaths;
      for (const [pathIndex, path] of (pathSuffix ?? [statement.completionPaths[0]!]).entries()) {
        const updates = new Map<string, string>([["pc", String(path.completion === "normal" ? next : finalEntry)]]);
        if (path.completion === "normal") updates.set("completion", "if (completion == 5) 0 else completion");
        if (path.completion === "throw") updates.set("completion", "1");
        if (path.completion !== "normal") {
          updates.set("handled_cleanup_failure", "disposal_failure_pending");
          updates.set("disposal_failure_pending", "false");
          updates.set("handled_disposal_failure_kind", "disposal_failure_count");
        }
        emit(`catch_statement_${index}${regionSuffix}${pathSuffix ? `_path_${pathIndex}` : ""}`, [`pc == ${pc}`, ...conditionGuards(path.controlConditions)], updates);
      }
    });
    const catchTerminates = layout.catchLayout.some(({ statement }) => statement.completion !== "normal");
    emit(`catch_return${regionSuffix}`, [`pc == ${layout.afterCatchPc}`], new Map([["pc", String(catchTerminates ? finalEntry : layout.finallyLayout.length ? layout.finallyPc : afterRegion)], ["handled_cleanup_failure", "disposal_failure_pending"], ["disposal_failure_pending", "false"], ["handled_disposal_failure_kind", "disposal_failure_count"]]));
    layout.finallyLayout.forEach(({ statement, pc, awaitIndexes, events, loopDecisionPc }, index) => {
      const following = layout.finallyLayout[index + 1]?.pc;
      const next = following ?? `if (completion == 0) ${afterRegion} else if (completion == 4) ${cleanupPc} else ${exceptionalTarget(layout.region)}`;
      if (events.length > 0) {
        events.forEach(({ event, pc: eventPc }, eventOrder) => {
          const eventNext = events[eventOrder + 1]?.pc ?? loopDecisionPc ?? following ?? afterRegion;
          if (event.kind === "acquire") {
            const resource = resources[event.index]!;
            const guards = [`pc == ${eventPc}`, ...conditionPathGuards(resource.controlPaths)];
            emit(`acquire_${labels[event.index]}`, guards, new Map([["pc", String(eventNext)], ...resetCaughtDisposalState(resource), [`acquired_${event.index}`, "true"], [`disposed_${event.index}`, options.reuseStaleDisposal ? `disposed_${event.index}` : "false"], [`generation_${event.index}`, `generation_${event.index} + 1`]]));
            emit(`acquire_fail_${labels[event.index]}`, guards, new Map([["pc", String(exceptionalTarget(layout.region))], ["completion", "1"]]));
            return;
          }
          if (event.kind === "dispose") {
            emitDisposal(event.index, eventPc, eventNext, "_handler_loop", { failureNext: exceptionalTarget(layout.region) });
            return;
          }
          const awaitIndex = event.index;
          const isLastAwait = !events.slice(eventOrder + 1).some(({ event: later }) => later.kind === "await");
          const completion = completionForAwait(statement, awaitIndex, awaitIndexes);
          const chain = awaited[awaitIndex]!.promiseChain!;
          const pendingCompletion = isLastAwait && eventOrder === events.length - 1 && loopDecisionPc === undefined && following === undefined && completion === "normal";
          emitHandlerAwait("finally", awaited[awaitIndex]!, eventPc, eventNext, completion, exceptionalTarget(layout.region), pendingCompletion ? ["completion == 0"] : []);
          if (pendingCompletion) emit(`finally_await_${chain}_resume_abrupt`, [`pc == ${eventPc + 1}`, "completion != 0"], new Map([["pc", String(exceptionalTarget(layout.region))]]));
        });
        if (loopDecisionPc !== undefined) {
          const repeatGuards = [`pc == ${loopDecisionPc}`];
          const branch = statement.loop && branchIndex.get(statement.loop.id);
          if (branch !== undefined) repeatGuards.push(`branch_${branch} == 1`);
          emit(`finally_loop_${index}_repeat`, repeatGuards, new Map([["pc", String(pc)]]));
          emit(`finally_loop_${index}_exit`, [`pc == ${loopDecisionPc}`, "completion == 0"], new Map([["pc", String(following ?? afterRegion)]]));
          emit(`finally_loop_${index}_exit_abrupt`, [`pc == ${loopDecisionPc}`, "completion != 0"], new Map([["pc", String(exceptionalTarget(layout.region))]]));
        }
        return;
      }
      const pathSuffix = statement.completionPaths.length === 1 && statement.completionPaths[0]!.controlConditions.length === 0 ? undefined : statement.completionPaths;
      for (const [pathIndex, path] of (pathSuffix ?? [statement.completionPaths[0]!]).entries()) {
        const transferTarget = transferTargetForPath(path);
        const target = transferTarget ?? (path.completion === "normal" ? next : path.completion === "return" ? cleanupPc : exceptionalTarget(layout.region));
        const updates = new Map<string, string>([["pc", String(target)]]);
        if (path.completion === "return") updates.set("completion", "0");
        if (isLoopTransfer(path.completion) && transferTarget !== undefined) updates.set("completion", "0");
        if (path.completion === "throw") updates.set("completion", "1");
        emit(`finally_statement_${index}${regionSuffix}${pathSuffix ? `_path_${pathIndex}` : ""}`, [`pc == ${pc}`, ...conditionGuards(path.controlConditions)], updates);
      }
    });
  });
  const cleanupDisposalIndexes = disposals.map((_, index) => index);
  if (options.reorderCleanup && cleanupDisposalIndexes.length > 1) {
    [cleanupDisposalIndexes[0], cleanupDisposalIndexes[1]] = [cleanupDisposalIndexes[1]!, cleanupDisposalIndexes[0]!];
  }
  cleanupDisposalIndexes.forEach((disposalIndex, order) => emitDisposal(disposalIndex, cleanupPc + order, cleanupPc + order + 1));
  emit("finish_fulfilled", [`pc == ${completePc}`, "completion == 0 or completion == 4"], new Map([["pc", "-2"]]));
  emit("finish_rejected", [`pc == ${completePc}`, "completion != 0", "completion != 4"], new Map([["pc", "-1"]]));
  if (options.skipCleanup) emit("finish_without_cleanup", [`pc == ${cleanupPc}`], new Map([["pc", "-2"], ["broken", "true"]]));
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const disposed = resources.map((_, index) => `(not(acquired_${index}) or (disposed_${index} and disposed_generation_${index} == generation_${index}))`).join(" and ") || "true";
  const scopeStart = (resource: ResourceBinding): number => Number(resource.scopeId.slice(resource.scopeId.lastIndexOf("@") + 1));
  const cleanupOrder = resources.flatMap((earlier, earlierIndex) => resources.flatMap((later, laterIndex) =>
    (earlier.scopeId === later.scopeId && earlier.acquisitionIndex < later.acquisitionIndex)
      || (later.scopeDepth > earlier.scopeDepth
        && scopeStart(later) >= scopeStart(earlier)
        && later.scopeEnd <= earlier.scopeEnd)
      ? [`(not(disposed_${earlierIndex}) or not(acquired_${laterIndex}) or (disposed_${laterIndex} and disposed_generation_${laterIndex} == generation_${laterIndex}))`]
      : [],
  )).join(" and ") || "true";
  const caughtDisposalsFinished = disposals.flatMap((disposal, disposalIndex) => disposal.catchesFailure ? [resourceIndexForDisposal(disposalIndex)] : [])
    .filter((resourceIndex, index, all) => all.indexOf(resourceIndex) === index)
    .map((resourceIndex) => `(not(acquired_${resourceIndex}) or (disposed_${resourceIndex} and disposed_generation_${resourceIndex} == generation_${resourceIndex}))`)
    .join(" and ") || "true";
  const branchResourceSafety = resources.map((resource, resourceIndex) => {
    const guards = conditionPathGuards(resource.controlPaths);
    return guards.length === 0 ? "true" : `(not(acquired_${resourceIndex}) or (${guards.join(" and ")}))`;
  }).join(" and ") || "true";
  const disposalAcquisitionSafety = resources.map((_, resourceIndex) => `(not(disposed_${resourceIndex}) or acquired_${resourceIndex})`).join(" and ") || "true";
  const branchResourceExclusivity = resourceDecisionGroups.flatMap(([, resourceIndexes]) => resourceIndexes.flatMap((left, leftIndex) =>
    resourceIndexes.slice(leftIndex + 1).map((right) => `not(acquired_${left} and acquired_${right})`),
  )).join(" and ") || "true";
  const sequentialResourceJoinSafety = sequentialResourcePairs.map(([earlierIndex, laterIndex]) =>
    `(not(acquired_${laterIndex}) or not(acquired_${earlierIndex}) or (disposed_${earlierIndex} and disposed_generation_${earlierIndex} == generation_${earlierIndex}))`,
  ).join(" and ") || "true";
  const loopGenerationSafety = transferLayouts.flatMap(({ transferOwner, disposalIndexes }) => {
    if (transferOwner.iterations === undefined) return [];
    const iteration = `loop_iteration_${safe(transferOwner.id)}`;
    return disposalIndexes.map((disposalIndex) => {
      const resourceIndex = resourceIndexForDisposal(disposalIndex);
      return `(not(acquired_${resourceIndex}) or ${iteration} == 0 or generation_${resourceIndex} == ${iteration} + 1 or (disposed_${resourceIndex} and disposed_generation_${resourceIndex} == generation_${resourceIndex}))`;
    });
  }).join(" and ") || "true";
  const returnCompletionSafety = returnCompletions.map((completion) => {
    const containingResources = resources.map((resource, index) => ({ resource, index })).filter(({ resource }) => {
      const start = Number(resource.scopeId.slice(resource.scopeId.lastIndexOf("@") + 1));
      return completion.span.start >= start && completion.span.end <= resource.scopeEnd;
    });
    const depth = Math.max(...containingResources.map(({ resource }) => resource.scopeDepth));
    const local = containingResources.filter(({ resource }) => resource.scopeDepth === depth);
    const forbiddenPcs = normalLayout.filter(({ event }) => event.position > completion.span.end).map(({ pc }) => pc);
    const cleanup = local.map(({ index }) => `(disposed_${index} and disposed_generation_${index} == generation_${index})`);
    const routing = forbiddenPcs.map((pc) => `pc != ${pc}`);
    return `(completion != 4 or (${[...cleanup, ...routing].join(" and ") || "true"}))`;
  }).join(" and ") || "true";
  const throwCompletionSafety = nonUniformThrowFacts.map(({ completion }) => {
    const containingResources = resources.map((resource, index) => ({ resource, index })).filter(({ resource }) => {
      const start = Number(resource.scopeId.slice(resource.scopeId.lastIndexOf("@") + 1));
      return completion.span.start >= start && completion.span.end <= resource.scopeEnd;
    });
    const depth = Math.max(...containingResources.map(({ resource }) => resource.scopeDepth));
    const local = containingResources.filter(({ resource }) => resource.scopeDepth === depth);
    const forbiddenPcs = normalLayout.filter(({ event }) => event.position > completion.span.end).map(({ pc }) => pc);
    const cleanup = local.map(({ index }) => `(disposed_${index} and disposed_generation_${index} == generation_${index})`);
    const routing = [...forbiddenPcs.map((pc) => `pc != ${pc}`), "pc != -1", "pc != -2"];
    return `(completion != 5 or (${[...cleanup, ...routing].join(" and ") || "true"}))`;
  }).join(" and ") || "true";
  const nonUniformCompletionFacts = [
    ...nonUniformReturnFacts.map((fact) => ({ condition: fact.returnCondition, normalResourceIndexes: fact.normalResourceIndexes, laterResourceIndexes: fact.laterResourceIndexes })),
    ...nonUniformThrowFacts.map((fact) => ({ condition: fact.throwCondition, normalResourceIndexes: fact.normalResourceIndexes, laterResourceIndexes: fact.laterResourceIndexes })),
  ];
  const normalContinuationSafety = nonUniformCompletionFacts.map((fact) => {
    const branch = branchIndex.get(fact.condition.id)!;
    const normalValue = fact.condition.expected ? 0 : 1;
    const laterAcquired = fact.laterResourceIndexes.map((index) => `acquired_${index}`).join(" or ") || "false";
    return `(pc != -2 or completion != 0 or branch_${branch} != ${normalValue} or handled_cleanup_failure or (${laterAcquired}))`;
  }).join(" and ") || "true";
  lines.push("", `  val branchResourceSafe = ${branchResourceSafety}`, `  val branchResourceExclusiveSafe = ${branchResourceExclusivity}`, `  val sequentialResourceJoinSafe = ${sequentialResourceJoinSafety}`, `  val loopGenerationSafe = ${loopGenerationSafety}`, `  val returnCompletionSafe = ${returnCompletionSafety}`, `  val throwCompletionSafe = ${throwCompletionSafety}`, `  val normalContinuationSafe = ${normalContinuationSafety}`, `  val disposalAcquisitionSafe = ${disposalAcquisitionSafety}`, `  val cleanupOrderSafe = ${cleanupOrder}`, "  val disposalSuppressionSafe = disposal_failure_count == disposal_failure_events", `  val handlerAfterCleanupSafe = not(handled_cleanup_failure) or (${caughtDisposalsFinished})`, "  val disposalHandlerSafe = (pc != -1 and pc != -2) or not(disposal_failure_pending)", `  val resourceSafe = not(broken) and branchResourceSafe and branchResourceExclusiveSafe and sequentialResourceJoinSafe and loopGenerationSafe and returnCompletionSafe and throwCompletionSafe and normalContinuationSafe and disposalAcquisitionSafe and cleanupOrderSafe and disposalSuppressionSafe and handlerAfterCleanupSafe and disposalHandlerSafe and ((pc != -1 and pc != -2) or (${disposed}))`, "}", "");
  return lines.join("\n");
}

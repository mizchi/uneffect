import ts from "typescript";
import { extractAnnotations, extractLocatedAnnotations } from "./annotations.js";
import { resolveDisposalProtocol } from "./disposal-symbols.js";
import { logicToSmt, parseLogicExpression, proveBooleanImplication, type LogicExpression } from "./invariant-ir.js";
import { analyzePromiseChainsInProgram, type PromiseChainModel } from "./promise-chains.js";

export type PromiseObservationKind = "await" | "return" | "catch" | "then-rejection" | "ignored" | "floating";
export interface PromiseObservation {
  owner: string;
  source: string;
  observation: PromiseObservationKind;
  catchesRejection: boolean;
  promiseChain?: number;
  span: { start: number; end: number };
}
export interface PromiseBinding {
  owner: string;
  binding: string;
  status: "floating" | "transferred" | "observed";
  observations: string[];
  span: { start: number; end: number };
}
export interface ResourceBinding {
  owner: string;
  ownerAsync: boolean;
  binding: string;
  asynchronous: boolean;
  acquisitionIndex: number;
  scopeId: string;
  scopeDepth: number;
  scopeEnd: number;
  catchesFailure: boolean;
  initializerMayFail: true;
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
export interface AsyncSafetyDiagnostic {
  fileName: string;
  functionName: string;
  line: number;
  kind: "floating-promise" | "floating-callback-promise" | "invalid-disposable" | "invalid-ownership-contract";
  severity: "error";
  message: string;
}
export interface AsyncSafetyResult {
  fileName: string;
  promises: PromiseObservation[];
  promiseBindings: PromiseBinding[];
  resources: ResourceBinding[];
  disposals: ResourceDisposal[];
  promiseChains: PromiseChainModel;
  controlEdges: AsyncControlEdge[];
  controlStatements: AsyncControlStatement[];
  ownershipObligations: OwnershipGuardObligation[];
  diagnostics: AsyncSafetyDiagnostic[];
}
export interface AsyncControlStatement {
  owner: string;
  region: "catch" | "finally";
  order: number;
  source: string;
  span: { start: number; end: number };
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

function parseIndexedOwnershipContract(declaration: ts.SignatureDeclaration, directive: "consumes_rejection" | "consumes_callback_rejection"): IndexedOwnershipContract {
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

type ConditionalOwnershipDirective = "consumes_rejection_when" | "consumes_callback_rejection_when";
function ownershipGuardEvidence(checker: ts.TypeChecker, call: ts.CallExpression, declaration: ts.SignatureDeclaration, guardSource: string): { assumptions: string[]; goal: string; verified: boolean } {
  let instantiated = guardSource;
  declaration.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name) || !call.arguments[index]) return;
    instantiated = instantiated.replace(new RegExp(`\\b${parameter.name.text}\\b`, "g"), `(${call.arguments[index]!.getText()})`);
  });
  const facts: string[] = [];
  call.arguments.forEach((argument) => {
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
function guardProvenTrue(checker: ts.TypeChecker, call: ts.CallExpression, declaration: ts.SignatureDeclaration, guardSource: string): boolean {
  return ownershipGuardEvidence(checker, call, declaration, guardSource).verified;
}

function conditionalOwnershipParameters(
  checker: ts.TypeChecker | undefined,
  declaration: ts.SignatureDeclaration,
  call: ts.CallExpression | undefined,
  directive: ConditionalOwnershipDirective,
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
        else if (call && checker && guardProvenTrue(checker, call, declaration, match[2]!)) indices.add(target);
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
  const promises: PromiseObservation[] = [], promiseBindings: PromiseBinding[] = [], resources: ResourceBinding[] = [], ownershipObligations: OwnershipGuardObligation[] = [], controlStatements: AsyncControlStatement[] = [], diagnostics: AsyncSafetyDiagnostic[] = [];
  const validateOwnershipContracts = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) for (const directive of ["consumes_rejection", "consumes_callback_rejection"] as const) for (const error of parseIndexedOwnershipContract(node, directive).errors) {
      diagnostics.push({ fileName: source.fileName, functionName: functionName(node), line: lineAt(source, error.position), kind: "invalid-ownership-contract", severity: "error", message: error.message });
    }
    if (ts.isFunctionLike(node)) for (const directive of ["consumes_rejection_when", "consumes_callback_rejection_when"] as const) for (const error of conditionalOwnershipParameters(undefined, node, undefined, directive).errors) {
      diagnostics.push({ fileName: source.fileName, functionName: functionName(node), line: lineAt(source, error.position), kind: "invalid-ownership-contract", severity: "error", message: error.message });
    }
    if (ts.isCallExpression(node)) {
      const consumed = callbackRejectionConsumerParameters(checker, node);
      node.arguments.forEach((argument, index) => {
        if (!consumed.has(index) && isPromiseReturningCallback(checker, argument)) diagnostics.push({
          fileName: source.fileName, functionName: enclosingFunctionName(node), line: lineAt(source, argument.getStart(source)), kind: "floating-callback-promise", severity: "error",
          message: `${node.expression.getText(source)} does not declare ownership of the Promise returned by callback argument ${index}`,
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
    const owner = functionName(ownerNode), ownedResources: ResourceBinding[] = [];
    const bindingGroups = new Map<ts.Symbol, PromiseBinding[]>();
    const localBindings: PromiseBinding[] = [];
    const registerBinding = (symbol: ts.Symbol, name: string, spanNode: ts.Node, existing?: PromiseBinding[]): void => {
      if (bindingGroups.has(symbol)) return;
      if (existing) {
        const binding: PromiseBinding = { owner, binding: name, status: existing[0]!.status, observations: existing[0]!.observations, span: { start: spanNode.getStart(source), end: spanNode.getEnd() } };
        existing.push(binding); bindingGroups.set(symbol, existing); localBindings.push(binding); promiseBindings.push(binding);
      } else {
        const binding: PromiseBinding = { owner, binding: name, status: "floating", observations: [], span: { start: spanNode.getStart(source), end: spanNode.getEnd() } };
        bindingGroups.set(symbol, [binding]); localBindings.push(binding); promiseBindings.push(binding);
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
      promises.push({ owner, source: expression.getText(source), observation, catchesRejection, span: { start: expression.getStart(source), end: expression.getEnd() } });
      if (observation === "floating") diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, expression.getStart(source)), kind: "floating-promise", severity: "error", message: `${owner} has a floating Promise whose rejection is not observed; await, return, catch, or explicitly void it` });
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
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const symbol = checker.getSymbolAtLocation(node.left);
        if (symbol && !bindingGroups.has(symbol)) {
          const aliasedSymbol = ts.isIdentifier(node.right) ? checker.getSymbolAtLocation(node.right) : undefined;
          const existing = aliasedSymbol && bindingGroups.get(aliasedSymbol);
          if (existing) registerBinding(symbol, node.left.text, node, existing);
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
          const resource: ResourceBinding = { owner, ownerAsync: Boolean(ownerNode.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)), binding: declaration.name.text, asynchronous, acquisitionIndex: ownedResources.length, ...resourceScope(ownerNode, declaration, source), initializerMayFail: true, disposalFailureType: disposalFailureType(selectedProtocol),
            disposalProtocol: protocolDeclaration ? { kind: protocol.asyncSymbol === selectedProtocol ? "async" : "sync", fileName: protocolDeclaration.getSourceFile().fileName, start: protocolDeclaration.getStart(), end: protocolDeclaration.getEnd() } : undefined,
            span: { start: declaration.getStart(source), end: declaration.getEnd() } };
          resources.push(resource); ownedResources.push(resource);
          if ((!asynchronous && !protocol.sync) || (asynchronous && !protocol.async && !protocol.sync)) diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, declaration.getStart(source)), kind: "invalid-disposable", severity: "error", message: `${declaration.name.text} does not provide the ${asynchronous ? "Symbol.asyncDispose or Symbol.dispose" : "Symbol.dispose"} protocol required by ${asynchronous ? "await using" : "using"}` });
        }
      }
      if (ts.isAwaitExpression(node) && isPromiseLike(checker, node.expression)) { observe(node.expression, "await", catchesAwaitRejection(node)); markBinding(node.expression, "observed", "await"); }
      if (ts.isReturnStatement(node) && node.expression && isPromiseLike(checker, node.expression)) { observe(node.expression, "return", false); markBinding(node.expression, "observed", "return"); }
      if (ts.isExpressionStatement(node)) {
        let expression = node.expression;
        if (ts.isVoidExpression(expression) && isPromiseLike(checker, expression.expression)) {
          observe(expression.expression, options.allowVoid === false ? "floating" : "ignored", false);
          if (options.allowVoid !== false) markBinding(expression.expression, "observed", "void");
        }
        else if (isPromiseLike(checker, expression)
          && !(ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expression.left))) {
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
    const uniqueGroups = [...new Set(bindingGroups.values())];
    for (const group of uniqueGroups) {
      const symbols = new Set([...bindingGroups].filter(([, value]) => value === group).map(([symbol]) => symbol));
      type PathState = { active: boolean; pending: boolean; lost: boolean; terminated: boolean; abrupt?: "break" | "continue"; label?: string };
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
      const activates = (statement: ts.Statement): boolean => {
        let active = false;
        const scan = (node: ts.Node): void => {
          if (active || (node !== statement && ts.isFunctionLike(node))) return;
          if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)
            && symbols.has(checker.getSymbolAtLocation(node.name)!)) active = true;
          else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && referencesGroup(node.left) && isPromiseLike(checker, node.right)) active = true;
          else ts.forEachChild(node, scan);
        };
        scan(statement);
        return active;
      };
      const reassigns = (statement: ts.Statement): boolean => {
        let reassigned = false;
        const scan = (node: ts.Node): void => {
          if (reassigned || (node !== statement && ts.isFunctionLike(node))) return;
          if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && referencesGroup(node.left) && isPromiseLike(checker, node.right) && !referencesGroup(node.right)) { reassigned = true; return; }
          ts.forEachChild(node, scan);
        };
        scan(statement);
        return reassigned;
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
        const previousAbrupt = state.abrupt, previousLabel = state.label;
        return executeStatements(block.statements, [{ ...state, terminated: false, abrupt: undefined, label: undefined }]).map((next) => next.terminated || next.abrupt ? next : ({
          ...next, terminated: wasTerminated, abrupt: previousAbrupt, label: previousLabel,
        }));
      };
      const stateKey = (state: PathState): string => `${Number(state.active)}${Number(state.pending)}${Number(state.lost)}${Number(state.terminated)}:${state.abrupt ?? ""}:${state.label ?? ""}`;
      const uniqueStates = (states: PathState[]): PathState[] => [...new Map(states.map((state) => [stateKey(state), state])).values()];
      const executeLoop = (statement: ts.IterationStatement, state: PathState, atLeastOnce: boolean, loopLabel?: string): PathState[] => {
        const exits: PathState[] = atLeastOnce ? [] : [{ ...state }];
        let frontier: PathState[] = [{ ...state }], visited = new Set<string>();
        while (frontier.length) {
          const nextFrontier: PathState[] = [];
          for (const entry of frontier) {
            const key = stateKey(entry); if (visited.has(key)) continue; visited.add(key);
            for (const next of executeStatement(statement.statement, entry)) {
              const matching = next.label === undefined || next.label === loopLabel;
              if (next.abrupt === "break" && matching) { exits.push({ ...next, abrupt: undefined, label: undefined }); continue; }
              if (next.abrupt === "continue" && matching) {
                const continued = { ...next, abrupt: undefined, label: undefined };
                exits.push(continued); nextFrontier.push(continued); continue;
              }
              if (next.abrupt || next.terminated) { exits.push(next); continue; }
              exits.push(next); nextFrontier.push(next);
            }
          }
          frontier = uniqueStates(nextFrontier);
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
          const catchStates = statement.catchClause
            ? executeStatement(statement.catchClause.block, { ...state })
            : [];
          const completions = [...tryStates, ...catchStates];
          return statement.finallyBlock
            ? completions.flatMap((completion) => executeFinally(statement.finallyBlock!, completion))
            : completions;
        }
        if (ts.isWhileStatement(statement) || ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement)) return executeLoop(statement, state, false, loopLabel);
        if (ts.isDoStatement(statement)) return executeLoop(statement, state, true, loopLabel);
        if (ts.isBreakStatement(statement) || ts.isContinueStatement(statement)) return [{ ...state, abrupt: ts.isBreakStatement(statement) ? "break" : "continue", label: statement.label?.text }];
        const next = { ...state };
        const wasActive = next.active;
        if (activates(statement) && !next.active) { next.active = true; next.pending = true; }
        if (reassigns(statement) && wasActive) { if (next.pending) next.lost = true; next.pending = true; }
        if (consumes(statement) && next.active) next.pending = false;
        if (ts.isReturnStatement(statement) || ts.isThrowStatement(statement)) next.terminated = true;
        return [next];
      };
      const executeStatements = (statements: readonly ts.Statement[], initial: PathState[]): PathState[] =>
        statements.reduce((states, statement) => states.flatMap((state) => executeStatement(statement, state)), initial);
      const states = ts.isBlock(ownerNode.body) ? executeStatements(ownerNode.body.statements, [{ active: false, pending: false, lost: false, terminated: false }]) : [];
      if (states.some((state) => state.active && (state.pending || state.lost))) for (const binding of group) binding.status = "floating";
    }
    const reported = new Set<PromiseBinding[]>();
    for (const binding of localBindings) {
      const symbol = [...bindingGroups].find(([, group]) => group.includes(binding))?.[0];
      const group = symbol && bindingGroups.get(symbol);
      if (!group || reported.has(group) || group[0]!.status !== "floating") continue;
      reported.add(group);
      diagnostics.push({ fileName: source.fileName, functionName: owner, line: lineAt(source, binding.span.start), kind: "floating-promise", severity: "error", message: `${owner} leaves Promise binding ${binding.binding} without await, return, rejection handler, explicit void, or responsibility transfer` });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node)) {
      const owner = enclosingFunctionName(node);
      node.catchClause?.block.statements.forEach((statement, order) => controlStatements.push({ owner, region: "catch", order, source: statement.getText(source), span: { start: statement.getStart(source), end: statement.getEnd() } }));
      node.finallyBlock?.statements.forEach((statement, order) => controlStatements.push({ owner, region: "finally", order, source: statement.getText(source), span: { start: statement.getStart(source), end: statement.getEnd() } }));
    }
    if (ts.isFunctionLike(node) && "body" in node && node.body) visitFunction(node as ts.FunctionLikeDeclaration);
    ts.forEachChild(node, visit);
  };
  visit(source);
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
  return { fileName: source.fileName, promises, promiseBindings, resources, disposals, promiseChains, controlEdges, controlStatements, ownershipObligations, diagnostics };
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

export function generateUnifiedAsyncQuint(moduleName: string, result: AsyncSafetyResult, owner: string, options: { skipCleanup?: boolean } = {}): string {
  const resources = result.resources.filter((item) => item.owner === owner);
  const disposals = result.disposals.filter((item) => item.owner === owner);
  const awaited = result.promises
    .filter((item) => item.owner === owner && item.observation === "await" && item.promiseChain !== undefined)
    .sort((left, right) => left.span.start - right.span.start);
  const catchStatements = result.controlStatements.filter((item) => item.owner === owner && item.region === "catch").sort((left, right) => left.span.start - right.span.start);
  const finallyStatements = result.controlStatements.filter((item) => item.owner === owner && item.region === "finally").sort((left, right) => left.span.start - right.span.start);
  if (awaited.length === 0) throw new Error(`${owner} has no awaited analyzed Promise chain`);
  const scheduledDisposals = new Set<number>();
  const disposalAfterAwait = awaited.map((_, awaitIndex) => {
    if (awaitIndex === awaited.length - 1) return [] as number[];
    const nextAwaitStart = awaited[awaitIndex + 1]!.span.start;
    return disposals.flatMap((disposal, disposalIndex) => {
      if (scheduledDisposals.has(disposalIndex) || disposal.disposalPoint >= nextAwaitStart) return [];
      scheduledDisposals.add(disposalIndex);
      return [disposalIndex];
    });
  });
  let nextPc = resources.length;
  const awaitLayout = awaited.map((_, index) => ({
    wait: nextPc++,
    resume: nextPc++,
    disposalPcs: disposalAfterAwait[index]!.map((disposalIndex) => ({ disposalIndex, pc: nextPc++ })),
  }));
  const catchPc = nextPc;
  const afterCatchPc = catchPc + catchStatements.length, finallyPc = afterCatchPc + 1;
  const cleanupPc = finallyPc + finallyStatements.length, completePc = cleanupPc + disposals.length;
  const labels = resources.map((resource, index) => resources.filter((item) => item.binding === resource.binding).length === 1 ? safe(resource.binding) : `${safe(resource.binding)}_${index}`);
  const lines = [`module ${safe(moduleName)} {`, "  var pc: int", "  var completion: int", "  var broken: bool"];
  resources.forEach((_, index) => lines.push(`  var acquired_${index}: bool`, `  var disposed_${index}: bool`, `  var disposing_${index}: bool`));
  lines.push("", "  action init = all {", "    pc' = 0,", "    completion' = 0,", "    broken' = false,");
  resources.forEach((_, index) => lines.push(`    acquired_${index}' = false,`, `    disposed_${index}' = false,`, `    disposing_${index}' = false,`));
  lines.push("  }");
  const actions: string[] = [];
  const emit = (name: string, guards: string[], updates = new Map<string, string>()): void => {
    actions.push(name);
    lines.push("", `  action ${name} = all {`, ...guards.map((guard) => `    ${guard},`), `    pc' = ${updates.get("pc") ?? "pc"},`, `    completion' = ${updates.get("completion") ?? "completion"},`, `    broken' = ${updates.get("broken") ?? "broken"},`);
    resources.forEach((_, index) => lines.push(`    acquired_${index}' = ${updates.get(`acquired_${index}`) ?? `acquired_${index}`},`, `    disposed_${index}' = ${updates.get(`disposed_${index}`) ?? `disposed_${index}`},`, `    disposing_${index}' = ${updates.get(`disposing_${index}`) ?? `disposing_${index}`},`));
    lines.push("  }");
  };
  const emitDisposal = (disposalIndex: number, current: number, next: number, suffix = "", failureNext = next): void => {
    const disposal = disposals[disposalIndex]!;
    const resourceIndex = resources.findIndex((resource) => resource.binding === disposal.binding && resource.scopeId === disposal.scopeId);
    if (resourceIndex < 0) return;
    const label = `${labels[resourceIndex]!}${suffix}`;
    emit(`skip_unacquired_${label}`, [`pc == ${current}`, `not(acquired_${resourceIndex})`], new Map([["pc", String(next)]]));
    emit(`skip_disposed_${label}`, [`pc == ${current}`, `disposed_${resourceIndex}`], new Map([["pc", String(next)]]));
    if (disposal.asynchronous) {
      emit(`dispose_start_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`, `not(disposing_${resourceIndex})`], new Map([[`disposing_${resourceIndex}`, "true"]]));
      emit(`dispose_resume_${label}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(next)], [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"]]));
      emit(`dispose_reject_${label}`, [`pc == ${current}`, `disposing_${resourceIndex}`], new Map([["pc", String(failureNext)], ["completion", disposal.catchesFailure ? "0" : "if (completion == 0) 2 else 3"], [`disposing_${resourceIndex}`, "false"], [`disposed_${resourceIndex}`, "true"]]));
    } else {
      emit(`dispose_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(next)], [`disposed_${resourceIndex}`, "true"]]));
      emit(`dispose_throw_${label}`, [`pc == ${current}`, `acquired_${resourceIndex}`, `not(disposed_${resourceIndex})`], new Map([["pc", String(failureNext)], ["completion", disposal.catchesFailure ? "0" : "if (completion == 0) 2 else 3"], [`disposed_${resourceIndex}`, "true"]]));
    }
  };
  resources.forEach((_, index) => {
    emit(`acquire_${labels[index]}`, [`pc == ${index}`], new Map([["pc", String(index + 1)], [`acquired_${index}`, "true"]]));
    emit(`acquire_fail_${labels[index]}`, [`pc == ${index}`], new Map([["pc", String(cleanupPc)], ["completion", "1"]]));
  });
  awaited.forEach((observation, awaitIndex) => {
    const chain = observation.promiseChain!;
    const { wait: waitPc, resume: resumePc, disposalPcs } = awaitLayout[awaitIndex]!;
    emit(`promise_${chain}_fulfill`, [`pc == ${waitPc}`], new Map([["pc", String(resumePc)]]));
    const rejectionUpdates = new Map<string, string>([["pc", String(observation.catchesRejection ? catchPc : cleanupPc)]]);
    if (!observation.catchesRejection) rejectionUpdates.set("completion", "1");
    emit(`promise_${chain}_${observation.catchesRejection ? "reject_caught" : "reject_escapes"}`, [`pc == ${waitPc}`], rejectionUpdates);
    const isLast = awaitIndex === awaited.length - 1;
    const resumeName = awaited.length === 1
      ? finallyStatements.length ? "await_resume_finally" : "await_resume_return"
      : isLast ? `await_${chain}_resume_${finallyStatements.length ? "finally" : "return"}` : `await_${chain}_resume_next`;
    const nextAfterAwait = isLast ? finallyPc : awaitLayout[awaitIndex + 1]!.wait;
    emit(resumeName, [`pc == ${resumePc}`], new Map([["pc", String(disposalPcs[0]?.pc ?? nextAfterAwait)]]));
    disposalPcs.forEach(({ disposalIndex, pc }, index) => {
      const next = disposalPcs[index + 1]?.pc ?? nextAfterAwait;
      emitDisposal(disposalIndex, pc, next, "_scope_exit", cleanupPc);
    });
  });
  catchStatements.forEach((_, index) => emit(`catch_statement_${index}`, [`pc == ${catchPc + index}`], new Map([["pc", String(catchPc + index + 1)]])));
  emit("catch_return", [`pc == ${afterCatchPc}`], new Map([["pc", String(finallyPc)]]));
  finallyStatements.forEach((_, index) => emit(`finally_statement_${index}`, [`pc == ${finallyPc + index}`], new Map([["pc", String(finallyPc + index + 1)]])));
  disposals.forEach((_, order) => emitDisposal(order, cleanupPc + order, cleanupPc + order + 1));
  emit("finish_fulfilled", [`pc == ${completePc}`, "completion == 0"], new Map([["pc", "-2"]]));
  emit("finish_rejected", [`pc == ${completePc}`, "completion != 0"], new Map([["pc", "-1"]]));
  if (options.skipCleanup) emit("finish_without_cleanup", [`pc == ${cleanupPc}`], new Map([["pc", "-2"], ["broken", "true"]]));
  lines.push("", "  action step = any {", ...actions.map((name) => `    ${name},`), "  }");
  const disposed = resources.map((_, index) => `(not(acquired_${index}) or disposed_${index})`).join(" and ") || "true";
  lines.push("", `  val resourceSafe = not(broken) and ((pc != -1 and pc != -2) or (${disposed}))`, "}", "");
  return lines.join("\n");
}

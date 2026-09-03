import ts from "typescript";
import type { Effect } from "./capabilities.js";
import type { EvidenceStatus } from "./effects.js";
import { extractAnnotations } from "./annotations.js";
import { isAuthenticatedProxyExpression, standardLibraryOperation, TypeScriptFrontendAdapter, type FrontendSymbolAdapter } from "./frontend-adapter.js";
import { resolveStableRegion } from "./region-alias.js";
import { interpretBuiltinCallSemantics, projectBuiltinCallbacks } from "./builtin-semantic-interpreter.js";
import type { BuiltinContractRegistry } from "./builtin-contracts.js";

export type CallableKind = "function" | "method" | "getter" | "setter" | "constructor" | "arrow" | "function-expression";
export type InvocationTiming = "inline" | "deferred" | "unknown";
export interface EffectParameter { index: number; name: string; timing: InvocationTiming }
export interface IteratorEffectParameter { index: number; name: string; convertsThrowToRejection: boolean }
export interface IteratorEffectInstantiation { consumer: string; parameterIndex: number }
export interface ExternalIteratorEffectContract { key: string; parameters: readonly IteratorEffectParameter[] }
export interface ExternalCallableEffectParameter extends EffectParameter {
  path?: readonly (string | number)[];
  effectBound?: readonly Effect[];
  /** Verified callee effects contain no mutation rooted at this argument. */
  preservesContainer?: boolean;
  completion?: "propagate-throw" | "convert-throw-to-rejection" | "host-report-throw" | "unknown";
}
export interface ExternalCallableEffectContract { key: string; parameters: readonly ExternalCallableEffectParameter[] }
export interface CallbackEffectInstantiation {
  consumer: string;
  parameterIndex: number;
  parameterName: string;
  effectBound: readonly Effect[];
}
export interface CallGraphNode {
  id: string;
  name: string;
  kind: CallableKind;
  fileName: string;
  span: { start: number; end: number };
  overloads: string[];
  effectParameters: EffectParameter[];
  iteratorEffectParameters: IteratorEffectParameter[];
}
export interface CallGraphEdge {
  caller: string;
  callee?: string;
  unresolvedName?: string;
  kind: "direct" | "callback-argument" | "callback-parameter";
  timing: InvocationTiming;
  overloadIndex?: number;
  span: { start: number; end: number };
  arguments: string[];
  /** Addressable receiver used to instantiate a callee `this` mutation region. */
  receiver?: string;
  dischargesThrow?: boolean;
  executesBody?: boolean;
  unknownGeneratorConsumption?: boolean;
  unknownGeneratorParameterIndex?: number;
  dischargesUnknownGeneratorParameters?: boolean;
  /** A local object alias reached this call but could not be reduced to one non-escaping addressable root. */
  unresolvedMutationAlias?: boolean;
  /** Identifies the polymorphic iterator contract instantiated by this execution edge. */
  iteratorEffectInstantiation?: IteratorEffectInstantiation;
  /** Identifies a checked callback upper bound supplied by an external callable contract. */
  callbackEffectInstantiation?: CallbackEffectInstantiation;
  /** Callback parameter positions supplied by the runtime rather than a source expression. */
  unresolvedMutationArgumentIndices?: number[];
}
export interface ProgramCallGraph { nodes: CallGraphNode[]; edges: CallGraphEdge[] }
export interface InstantiatedCallbackEffects { effects: Effect[]; evidence: EvidenceStatus; suspends: boolean }

function unwrapLiteralContainerExpression(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
    || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isSatisfiesExpression(expression)
    ? unwrapLiteralContainerExpression(expression.expression) : expression;
}

/** Resolve one finite callback path without evaluating spreads, getters, or computed keys. */
export function expressionAtLiteralArgumentPath(
  expression: ts.Expression,
  path: readonly (string | number)[],
): ts.Expression | undefined {
  let current = unwrapLiteralContainerExpression(expression);
  for (const part of path) {
    if (typeof part === "number") {
      if (!ts.isArrayLiteralExpression(current) || part < 0 || part >= current.elements.length) return undefined;
      const element = current.elements[part];
      if (!element || ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return undefined;
      current = unwrapLiteralContainerExpression(element);
      continue;
    }
    if (!ts.isObjectLiteralExpression(current)) return undefined;
    const property = current.properties.find((candidate) => {
      if (!ts.isPropertyAssignment(candidate) && !ts.isShorthandPropertyAssignment(candidate)) return false;
      const name = candidate.name;
      return (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) && name.text === part;
    });
    if (!property) return undefined;
    if (ts.isShorthandPropertyAssignment(property)) current = unwrapLiteralContainerExpression(property.name);
    else if (ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name)) current = unwrapLiteralContainerExpression(property.initializer);
    else return undefined;
  }
  return current;
}

/**
 * Extend literal-path resolution through a const container only when its
 * TypeChecker symbol is used exactly by its declaration and this path. This
 * excludes mutation, aliases, repeated calls, capture, and escape by design.
 */
export function expressionAtExclusiveConstArgumentPath(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  path: readonly (string | number)[],
  repeatedUse?: {
    call: ts.CallExpression;
    argumentIndex: number;
    preservesContainer: boolean;
  },
): ts.Expression | undefined {
  const seen = new Set<ts.Symbol>();
  const frozenLiteral = (initializer: ts.Expression): ts.Expression | undefined => {
    const current = unwrapLiteralContainerExpression(initializer);
    if (!ts.isCallExpression(current) || current.arguments.length !== 1
      || !ts.isPropertyAccessExpression(current.expression) || current.expression.name.text !== "freeze") return undefined;
    const freeze = resolvedSymbol(checker, current.expression.name);
    const standard = freeze?.declarations?.some((declaration) => declaration.getSourceFile().isDeclarationFile
      && ts.isInterfaceDeclaration(declaration.parent) && declaration.parent.name.text === "ObjectConstructor");
    if (!standard) return undefined;
    const value = unwrapLiteralContainerExpression(current.arguments[0]!);
    return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) ? value : undefined;
  };
  const exclusiveInitializer = (identifier: ts.Identifier): ts.Expression | undefined => {
    const symbol = resolvedSymbol(checker, identifier);
    if (!symbol || seen.has(symbol)) return undefined;
    const declaration = symbol.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || !ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    const frozen = frozenLiteral(declaration.initializer);
    if (frozen) { seen.add(symbol); return frozen; }
    let references = 0;
    const scan = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && resolvedSymbol(checker, node) === symbol) references++;
      ts.forEachChild(node, scan);
    };
    scan(declaration.getSourceFile());
    if (references !== 2) {
      if (!repeatedUse?.preservesContainer) return undefined;
      const lookup = ts.isPropertyAccessExpression(repeatedUse.call.expression)
        ? repeatedUse.call.expression.name : repeatedUse.call.expression;
      const expectedCallee = resolvedSymbol(checker, lookup);
      if (!expectedCallee) return undefined;
      let safeReferences = 0, unsafeReference = false;
      const screen = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && resolvedSymbol(checker, node) === symbol) {
          if (node === declaration.name) { safeReferences++; return; }
          let argument: ts.Expression = node;
          while (ts.isParenthesizedExpression(argument.parent) || ts.isAsExpression(argument.parent)
            || ts.isTypeAssertionExpression(argument.parent) || ts.isNonNullExpression(argument.parent)
            || ts.isSatisfiesExpression(argument.parent)) argument = argument.parent;
          const call = argument.parent;
          if (!ts.isCallExpression(call) || call.arguments[repeatedUse.argumentIndex] !== argument) {
            unsafeReference = true; return;
          }
          const candidate = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
          if (resolvedSymbol(checker, candidate) !== expectedCallee) { unsafeReference = true; return; }
          safeReferences++;
          return;
        }
        ts.forEachChild(node, screen);
      };
      screen(declaration.getSourceFile());
      if (unsafeReference || safeReferences !== references) return undefined;
    }
    seen.add(symbol);
    return declaration.initializer;
  };
  let current = unwrapLiteralContainerExpression(expression);
  for (const part of path) {
    if (ts.isIdentifier(current)) {
      const initializer = exclusiveInitializer(current);
      if (!initializer) return undefined;
      current = unwrapLiteralContainerExpression(initializer);
    }
    const selected = expressionAtLiteralArgumentPath(current, [part]);
    if (!selected) return undefined;
    current = selected;
  }
  return current;
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
}
function callableName(node: ts.FunctionLikeDeclaration): ts.Node | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name;
  if (ts.isConstructorDeclaration(node) && (ts.isClassDeclaration(node.parent) || ts.isClassExpression(node.parent))) return node.parent.name;
  return ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined;
}
function kindOf(node: ts.FunctionLikeDeclaration): CallableKind {
  return ts.isMethodDeclaration(node) ? "method"
    : ts.isGetAccessorDeclaration(node) ? "getter"
    : ts.isSetAccessorDeclaration(node) ? "setter"
    : ts.isConstructorDeclaration(node) ? "constructor"
    : ts.isArrowFunction(node) ? "arrow" : ts.isFunctionExpression(node) ? "function-expression" : "function";
}
function stableId(node: ts.FunctionLikeDeclaration): string { return `${node.getSourceFile().fileName}:${node.getStart()}`; }
function isFunctionParameter(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): boolean { return checker.getTypeAtLocation(parameter).getCallSignatures().length > 0; }
function runtimeParametersOf(declaration: ts.FunctionLikeDeclaration): readonly ts.ParameterDeclaration[] {
  return declaration.parameters.filter((parameter) =>
    !(ts.isIdentifier(parameter.name) && parameter.name.text === "this"));
}

function builtinTiming(call: ts.CallExpression, checker: ts.TypeChecker, adapter: FrontendSymbolAdapter, argumentIndex?: number): InvocationTiming {
  const resolved = adapter.resolveCall(call);
  const semanticCallbacks = projectBuiltinCallbacks(resolved, call, checker);
  if (argumentIndex !== undefined) {
    const argument = call.arguments[argumentIndex];
    const callback = semanticCallbacks.find((event) => event.target.status === "resolved" && event.target.expression === argument);
    if (callback) return callback.timing === "sync" ? "inline" : "deferred";
  }
  if (resolved?.semantics) {
    const events = interpretBuiltinCallSemantics(resolved.semantics, call, { symbol: resolved.symbol, span: resolved.span }, undefined,
      { resolveStaticString: (expression) => adapter.resolveStaticString(expression) });
    if (events.some((event) => event.kind === "protocol" && event.name === "scheduler")) return "deferred";
  }
  return "unknown";
}

function externalIteratorContractForCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  contracts: ReadonlyMap<string, ExternalIteratorEffectContract> | undefined,
): ExternalIteratorEffectContract | undefined {
  if (!contracts) return undefined;
  const lookup = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  const symbol = resolvedSymbol(checker, lookup);
  for (const declaration of symbol?.declarations ?? []) {
    const source = declaration.getSourceFile();
    const contract = contracts.get(`${source.fileName}:${declaration.getStart(source)}`);
    if (contract) return contract;
  }
  return undefined;
}

function externalCallableContractForCall(
  checker: ts.TypeChecker,
  call: ts.CallExpression,
  contracts: ReadonlyMap<string, ExternalCallableEffectContract> | undefined,
): ExternalCallableEffectContract | undefined {
  if (!contracts) return undefined;
  const lookup = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  const symbol = resolvedSymbol(checker, lookup);
  for (const declaration of symbol?.declarations ?? []) {
    const source = declaration.getSourceFile();
    const contract = contracts.get(`${source.fileName}:${declaration.getStart(source)}`);
    if (contract) return contract;
  }
  return undefined;
}

export function buildProgramCallGraph(
  program: ts.Program,
  options: {
    externalIteratorEffects?: ReadonlyMap<string, ExternalIteratorEffectContract>;
    externalCallableEffects?: ReadonlyMap<string, ExternalCallableEffectContract>;
    builtinRegistry?: BuiltinContractRegistry;
  } = {},
): ProgramCallGraph {
  const checker = program.getTypeChecker(), adapter = new TypeScriptFrontendAdapter(program, options.builtinRegistry), declarations: ts.FunctionLikeDeclaration[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)
        || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node)
        || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) declarations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const symbolNodes = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  for (const declaration of declarations) {
    const name = callableName(declaration), symbol = name ? resolvedSymbol(checker, name) : undefined;
    if (symbol) symbolNodes.set(symbol, declaration);
  }
  const callbackDeclarationFor = (expression: ts.Expression): ts.FunctionLikeDeclaration | undefined => {
    const current = unwrapLiteralContainerExpression(expression);
    return ts.isArrowFunction(current) || ts.isFunctionExpression(current) ? current
      : ts.isIdentifier(current) ? symbolNodes.get(resolvedSymbol(checker, current)!) : undefined;
  };
  const nodes = declarations.map((declaration): CallGraphNode => {
    const nameNode = callableName(declaration), symbol = nameNode ? resolvedSymbol(checker, nameNode) : undefined;
    const overloads = symbol?.declarations?.filter((item): item is ts.FunctionDeclaration | ts.MethodDeclaration => (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item)) && !item.body).map((item) => checker.signatureToString(checker.getSignatureFromDeclaration(item)!)) ?? [];
    return { id: stableId(declaration), name: ts.isConstructorDeclaration(declaration)
      ? `${nameNode?.getText() ?? "<anonymous-class>"}.constructor` : nameNode?.getText() ?? "<anonymous>", kind: kindOf(declaration), fileName: declaration.getSourceFile().fileName, span: { start: declaration.getStart(), end: declaration.getEnd() }, overloads, effectParameters: [], iteratorEffectParameters: [] };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const isGlobalSymbolMemberName = (name: ts.PropertyName, member: string): boolean => {
    if (!ts.isComputedPropertyName(name) || !ts.isPropertyAccessExpression(name.expression)
      || name.expression.name.text !== member) return false;
    const symbol = resolvedSymbol(checker, name.expression.expression);
    return Boolean(symbol?.declarations?.some((declaration) => {
      const source = declaration.getSourceFile();
      return source.isDeclarationFile && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName);
    }));
  };
  const implicitIteratorDeclaration = (expression: ts.Expression, member: "iterator" | "asyncIterator" = "iterator"): ts.MethodDeclaration | undefined => {
    for (const property of checker.getTypeAtLocation(expression).getProperties()) {
      for (const declaration of property.declarations ?? []) {
        if (ts.isMethodDeclaration(declaration) && declaration.body && isGlobalSymbolMemberName(declaration.name, member)) return declaration;
      }
    }
    return undefined;
  };
  const hasIteratorProtocol = (expression: ts.Expression, member: "iterator" | "asyncIterator" = "iterator"): boolean =>
    checker.getTypeAtLocation(expression).getProperties().some((property) =>
      (property.declarations ?? []).some((declaration) => {
        const name = (declaration as ts.NamedDeclaration).name;
        return Boolean(name && ts.isPropertyName(name) && isGlobalSymbolMemberName(name, member));
      }));
  const reviewedBuiltinIterable = (expression: ts.Expression): boolean => {
    const reviewed = new Set([
      "Array", "ReadonlyArray", "Map", "ReadonlyMap", "Set", "ReadonlySet",
      "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
      "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
    ]);
    const accepts = (type: ts.Type): boolean => {
      if ((type.flags & ts.TypeFlags.StringLike) !== 0 || checker.isArrayType(type) || checker.isTupleType(type)) return true;
      if (type.isUnion()) return type.types.every(accepts);
      return reviewed.has(type.getSymbol()?.getName() ?? "");
    };
    return accepts(checker.getTypeAtLocation(expression));
  };
  const definitelyPrimitive = (expression: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(expression);
    const members = type.isUnion() ? type.types : [type];
    return members.every((member) => (member.flags & (
      ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike
      | ts.TypeFlags.BooleanLike | ts.TypeFlags.ESSymbolLike
      | ts.TypeFlags.Null | ts.TypeFlags.Undefined
    )) !== 0);
  };
  const implicitGlobalSymbolMethods = (expression: ts.Expression, member: string): ts.MethodDeclaration[] =>
    checker.getTypeAtLocation(expression).getProperties().flatMap((property) => property.declarations ?? [])
      .filter((declaration): declaration is ts.MethodDeclaration => ts.isMethodDeclaration(declaration)
        && Boolean(declaration.body) && isGlobalSymbolMemberName(declaration.name, member));
  const implicitCoercionDeclarations = (expression: ts.Expression, stringHint: boolean): ts.MethodDeclaration[] => {
    const type = checker.getTypeAtLocation(expression);
    const localMethods = (name: string): ts.MethodDeclaration[] => checker.getPropertyOfType(type, name)?.declarations
      ?.filter((declaration): declaration is ts.MethodDeclaration => ts.isMethodDeclaration(declaration) && Boolean(declaration.body)) ?? [];
    const exotic = implicitGlobalSymbolMethods(expression, "toPrimitive");
    if (exotic.length > 0) return exotic;
    return stringHint ? [...localMethods("toString"), ...localMethods("valueOf")]
      : [...localMethods("valueOf"), ...localMethods("toString")];
  };
  const directlyReturnedCallable = (declaration: ts.FunctionLikeDeclaration): ts.FunctionLikeDeclaration | undefined => {
    if (ts.isArrowFunction(declaration) && !ts.isBlock(declaration.body)
      && (ts.isArrowFunction(declaration.body) || ts.isFunctionExpression(declaration.body))) return declaration.body;
    if (!declaration.body || !ts.isBlock(declaration.body) || declaration.body.statements.length !== 1) return undefined;
    const statement = declaration.body.statements[0];
    return statement && ts.isReturnStatement(statement) && statement.expression
      && (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))
      ? statement.expression : undefined;
  };
  type ReturnFlow = { expressions: ts.Expression[]; definite: boolean };
  const returnedGeneratorDeclarations = (
    declaration: ts.FunctionLikeDeclaration | undefined,
    seen = new Set<ts.FunctionLikeDeclaration>(),
  ): ts.FunctionLikeDeclaration[] | undefined => {
    if (!declaration || seen.has(declaration)
      || (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) !== 0) return undefined;
    if (declaration.asteriskToken) return [declaration];
    if (!declaration.body) return undefined;
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
    const flow = ts.isBlock(declaration.body) ? blockFlow(declaration.body)
      : { expressions: [declaration.body], definite: true };
    if (!flow?.definite || flow.expressions.length === 0) return undefined;
    const nextSeen = new Set(seen).add(declaration), candidates: ts.FunctionLikeDeclaration[] = [];
    const resolveExpression = (expression: ts.Expression): ts.FunctionLikeDeclaration[] | undefined => {
      if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
        || ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression)) return resolveExpression(expression.expression);
      if (ts.isConditionalExpression(expression)) {
        const left = resolveExpression(expression.whenTrue), right = resolveExpression(expression.whenFalse);
        return left && right ? [...left, ...right] : undefined;
      }
      if (!ts.isCallExpression(expression)) return undefined;
      const lookup = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name : expression.expression;
      return returnedGeneratorDeclarations(symbolNodes.get(resolvedSymbol(checker, lookup)!), nextSeen);
    };
    for (const expression of flow.expressions) {
      const resolved = resolveExpression(expression);
      if (!resolved) return undefined;
      candidates.push(...resolved);
    }
    return [...new Set(candidates)];
  };
  const isOpaqueIteratorCall = (call: ts.CallExpression): boolean => {
    if (!checker.getPropertyOfType(checker.getTypeAtLocation(call), "next")) return false;
    const source = checker.getResolvedSignature(call)?.declaration?.getSourceFile();
    return !(source?.isDeclarationFile
      && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName));
  };
  const isStandardLibraryCall = (call: ts.CallExpression | ts.NewExpression): boolean => {
    const source = checker.getResolvedSignature(call)?.declaration?.getSourceFile();
    return Boolean(source?.isDeclarationFile
      && /(?:^|[/\\])typescript[/\\]lib[/\\]lib\.[^/\\]+\.d\.ts$/.test(source.fileName));
  };
  const iterableConsumerArgument = (parent: ts.Node, expression: ts.Expression): boolean => {
    if (ts.isCallExpression(parent) && parent.arguments[0] === expression) {
      return [
        "ArrayConstructor#from", "ArrayConstructor#fromAsync", "ObjectConstructor#fromEntries",
        "PromiseConstructor#all", "PromiseConstructor#allSettled", "PromiseConstructor#any", "PromiseConstructor#race",
        "ObjectConstructor#groupBy", "MapConstructor#groupBy",
      ].includes(standardLibraryOperation(checker, parent) ?? "");
    }
    if (ts.isNewExpression(parent) && parent.arguments?.[0] === expression) {
      return ["SetConstructor", "MapConstructor", "WeakSetConstructor", "WeakMapConstructor", "Int8ArrayConstructor", "Uint8ArrayConstructor", "Uint8ClampedArrayConstructor", "Int16ArrayConstructor",
        "Uint16ArrayConstructor", "Int32ArrayConstructor", "Uint32ArrayConstructor", "Float32ArrayConstructor", "Float64ArrayConstructor", "BigInt64ArrayConstructor", "BigUint64ArrayConstructor"]
        .includes(standardLibraryOperation(checker, parent) ?? "");
    }
    return false;
  };
  const promiseIterableConsumerArgument = (parent: ts.Node, expression: ts.Expression): boolean =>
    ts.isCallExpression(parent) && parent.arguments[0] === expression
    && ["ArrayConstructor#fromAsync", "PromiseConstructor#all", "PromiseConstructor#allSettled", "PromiseConstructor#any", "PromiseConstructor#race"]
      .includes(standardLibraryOperation(checker, parent) ?? "");
  const iteratorParameterCache = new Map<ts.FunctionLikeDeclaration, IteratorEffectParameter[]>();
  const iteratorParameterVisiting = new Set<ts.FunctionLikeDeclaration>();
  const iteratorParametersOf = (declaration: ts.FunctionLikeDeclaration): IteratorEffectParameter[] => {
    const cached = iteratorParameterCache.get(declaration);
    if (cached) return cached;
    // Recursive forwarding without a fixed-point proof stays opaque. Returning
    // no contract here lets the ordinary unknown-consumption edge fail closed.
    if (iteratorParameterVisiting.has(declaration)) return [];
    iteratorParameterVisiting.add(declaration);
    const parameterIndices = new Map<ts.Symbol, number>();
    const runtimeParameters = runtimeParametersOf(declaration);
    runtimeParameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        const symbol = resolvedSymbol(checker, parameter.name);
        if (symbol) parameterIndices.set(symbol, index);
      }
    });
    const consumed = new Map<number, boolean>();
    const record = (expression: ts.Expression, convertsThrowToRejection = false): void => {
      if (!ts.isIdentifier(expression)) return;
      const index = parameterIndices.get(resolvedSymbol(checker, expression)!);
      if (index === undefined || (!checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")
        && ((!hasIteratorProtocol(expression) && !hasIteratorProtocol(expression, "asyncIterator"))
          || reviewedBuiltinIterable(expression)))) return;
      const previous = consumed.get(index);
      consumed.set(index, previous === false ? false : convertsThrowToRejection);
    };
    const visit = (node: ts.Node): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isForOfStatement(node)) record(node.expression, node.awaitModifier !== undefined);
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) record(
        node.expression, (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) !== 0,
      );
      if (ts.isSpreadElement(node)) record(node.expression);
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer) record(node.initializer);
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.[0]
        && iterableConsumerArgument(node, node.arguments[0])) record(
          node.arguments[0], promiseIterableConsumerArgument(node, node.arguments[0]),
        );
      if (ts.isCallExpression(node)) {
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const target = symbolNodes.get(resolvedSymbol(checker, lookup)!);
        if (target !== declaration) {
          const contracts = target ? iteratorParametersOf(target)
            : externalIteratorContractForCall(checker, node, options.externalIteratorEffects)?.parameters ?? [];
          for (const contract of contracts) {
            const argument = node.arguments[contract.index];
            if (argument) record(argument, contract.convertsThrowToRejection);
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === "next") record(node.expression.expression);
      ts.forEachChild(node, visit);
    };
    visit(declaration.body!);
    const result = [...consumed].map(([index, convertsThrowToRejection]) => ({
      index, name: runtimeParameters[index]!.name.getText(), convertsThrowToRejection,
    }));
    iteratorParameterVisiting.delete(declaration);
    iteratorParameterCache.set(declaration, result);
    return result;
  };
  for (const declaration of declarations) byId.get(stableId(declaration))!.iteratorEffectParameters = iteratorParametersOf(declaration);
  const edges: CallGraphEdge[] = [];
  for (const declaration of declarations) {
    const caller = stableId(declaration), parameters = new Map<string, number>();
    const declarationSource = declaration.getSourceFile();
    const leading = declarationSource.text.slice(
      declaration.getFullStart(), declaration.getStart(declarationSource),
    );
    const refinementActionOwner = extractAnnotations(leading, "refinement").some((value) => /\saction\s/.test(` ${value} `));
    const iteratorParameterIndices = new Map<ts.Symbol, number>();
    type IteratorBindingState = { generators: ts.FunctionLikeDeclaration[]; unknown: boolean; pure: boolean };
    const generatorBindings = new Map<ts.Symbol, ts.FunctionLikeDeclaration[]>(), unknownGeneratorBindings = new Set<ts.Symbol>(), pureIteratorBindings = new Set<ts.Symbol>();
    const iteratorSlots = new Map<ts.Symbol, Map<string, IteratorBindingState>>();
    const objectAliases = new Map<ts.Symbol, ts.Symbol>();
    const runtimeParameters = runtimeParametersOf(declaration);
    runtimeParameters.forEach((parameter, index) => { if (ts.isIdentifier(parameter.name) && isFunctionParameter(checker, parameter)) parameters.set(parameter.name.text, index); });
    runtimeParameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const symbol = resolvedSymbol(checker, parameter.name);
      if (symbol) iteratorParameterIndices.set(symbol, index);
    });
    const timings = new Map<number, InvocationTiming>();
    const expandingImplicitClasses = new Set<ts.ClassDeclaration | ts.ClassExpression>();
    const emptyIteratorState = (): IteratorBindingState => ({ generators: [], unknown: false, pure: false });
    const mergeIteratorStates = (left: IteratorBindingState, right: IteratorBindingState): IteratorBindingState => ({
      generators: [...new Set([...left.generators, ...right.generators])],
      unknown: left.unknown || right.unknown,
      pure: left.pure || right.pure,
    });
    const objectRoot = (symbol: ts.Symbol): ts.Symbol => {
      const seen = new Set<ts.Symbol>();
      let current = symbol;
      while (objectAliases.has(current) && !seen.has(current)) {
        seen.add(current);
        current = objectAliases.get(current)!;
      }
      return current;
    };
    const propertyKey = (expression: ts.Expression): string | undefined => {
      if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
      if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return undefined;
      const argument = expression.argumentExpression;
      return ts.isStringLiteral(argument) || ts.isNumericLiteral(argument) ? argument.text : undefined;
    };
    const propertySlot = (expression: ts.Expression): { root: ts.Symbol; key: string } | undefined => {
      const key = propertyKey(expression);
      const receiver = ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
        ? expression.expression : undefined;
      if (key === undefined || !receiver || !ts.isIdentifier(receiver)) return undefined;
      const symbol = resolvedSymbol(checker, receiver);
      if (!symbol) return undefined;
      const root = objectRoot(symbol);
      return iteratorSlots.has(root) ? { root, key } : undefined;
    };
    const iteratorStateOf = (raw: ts.Expression): IteratorBindingState => {
      const expression = ts.isParenthesizedExpression(raw) || ts.isAsExpression(raw)
        || ts.isTypeAssertionExpression(raw) || ts.isNonNullExpression(raw) ? raw.expression : raw;
      if (ts.isConditionalExpression(expression)) {
        const left = iteratorStateOf(expression.whenTrue), right = iteratorStateOf(expression.whenFalse);
        return mergeIteratorStates(left, right);
      }
      if (ts.isIdentifier(expression)) {
        const symbol = resolvedSymbol(checker, expression)!;
        return { generators: generatorBindings.get(symbol) ?? [], unknown: unknownGeneratorBindings.has(symbol), pure: pureIteratorBindings.has(symbol) };
      }
      const slot = propertySlot(expression);
      if (slot) return iteratorSlots.get(slot.root)?.get(slot.key) ?? emptyIteratorState();
      if (ts.isCallExpression(expression)) {
        const lookup = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name : expression.expression;
        const generators = returnedGeneratorDeclarations(symbolNodes.get(resolvedSymbol(checker, lookup)!));
        if (generators) return { generators, unknown: false, pure: false };
        if (checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")) {
          return { generators: [], unknown: !isStandardLibraryCall(expression), pure: isStandardLibraryCall(expression) };
        }
        return emptyIteratorState();
      }
      return checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")
        ? { generators: [], unknown: true, pure: false } : emptyIteratorState();
    };
    const updateIteratorBinding = (binding: ts.Symbol, state: IteratorBindingState, join: boolean): void => {
      if (!join) {
        generatorBindings.delete(binding);
        unknownGeneratorBindings.delete(binding);
        pureIteratorBindings.delete(binding);
      }
      if (state.generators.length) {
        generatorBindings.set(binding, [...new Set([...(generatorBindings.get(binding) ?? []), ...state.generators])]);
      }
      if (state.unknown) unknownGeneratorBindings.add(binding);
      if (state.pure) pureIteratorBindings.add(binding);
    };
    const updateIteratorSlot = (root: ts.Symbol, key: string, state: IteratorBindingState, join: boolean): void => {
      const slots = iteratorSlots.get(root) ?? new Map<string, IteratorBindingState>();
      const next = join ? mergeIteratorStates(slots.get(key) ?? emptyIteratorState(), state) : state;
      slots.set(key, next);
      iteratorSlots.set(root, slots);
    };
    const invalidateObjectSlots = (expression: ts.Expression): void => {
      if (!ts.isIdentifier(expression)) return;
      const symbol = resolvedSymbol(checker, expression);
      if (!symbol) return;
      const root = objectRoot(symbol), slots = iteratorSlots.get(root);
      if (!slots) return;
      for (const [key, state] of slots) slots.set(key, mergeIteratorStates(state, { generators: [], unknown: true, pure: false }));
    };
    const conditionallyExecuted = (node: ts.Node): boolean => {
      for (let current = node.parent; current && current !== declaration.body; current = current.parent) {
        if (ts.isIfStatement(current) || ts.isConditionalExpression(current) || ts.isSwitchStatement(current)
          || ts.isTryStatement(current) || ts.isCatchClause(current) || ts.isIterationStatement(current, false)) return true;
      }
      return false;
    };
    const canonicalAddressableArgument = (argument: ts.Expression): { text: string; unresolvedAlias: boolean } => {
      if (!ts.isIdentifier(argument)) return { text: argument.getText(), unresolvedAlias: false };
      if ((checker.getTypeAtLocation(argument).flags & ts.TypeFlags.Object) === 0 || !declaration.body) {
        return { text: argument.getText(), unresolvedAlias: false };
      }
      const region = resolveStableRegion(checker, argument, { scope: declaration.body, permittedUse: argument });
      return region.status === "resolved" && !region.runtimeDescriptorUnchecked
        ? { text: region.region, unresolvedAlias: false }
        : { text: argument.getText(), unresolvedAlias: true };
    };
    const canonicalAddressableReceiver = (receiver: ts.Expression): { text: string; unresolvedAlias: boolean } => {
      if (!declaration.body || !(ts.isIdentifier(receiver) || receiver.kind === ts.SyntaxKind.ThisKeyword
        || ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver))) {
        return { text: receiver.getText(), unresolvedAlias: true };
      }
      const region = resolveStableRegion(checker, receiver, { scope: declaration.body, permittedUse: receiver });
      return region.status === "resolved" && !region.runtimeDescriptorUnchecked
        ? { text: region.region, unresolvedAlias: false }
        : { text: receiver.getText(), unresolvedAlias: true };
    };
    const addObjectBindingGetterEdges = (
      pattern: ts.ObjectBindingPattern,
      sourceType: ts.Type,
      receiver: { text: string; unresolvedAlias: boolean },
      catchesThrow: boolean,
    ): void => {
      for (const element of pattern.elements) {
        if (element.dotDotDotToken) continue;
        const propertyName = element.propertyName
          ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
            || ts.isNumericLiteral(element.propertyName) ? element.propertyName.text : undefined
          : ts.isIdentifier(element.name) ? element.name.text : undefined;
        if (propertyName === undefined) continue;
        const property = checker.getPropertyOfType(sourceType, propertyName);
        for (const getter of property?.declarations?.filter(ts.isGetAccessorDeclaration) ?? []) {
          if (!getter.body || !byId.has(stableId(getter))) continue;
          edges.push({
            caller, callee: stableId(getter), kind: "direct", timing: "inline",
            span: { start: element.getStart(), end: element.getEnd() }, arguments: [],
            ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
            dischargesThrow: catchesThrow, executesBody: true,
          });
        }
        if (property && ts.isObjectBindingPattern(element.name)) {
          addObjectBindingGetterEdges(
            element.name,
            checker.getTypeOfSymbolAtLocation(property, element),
            { text: `${receiver.text}.${propertyName}`, unresolvedAlias: true },
            catchesThrow,
          );
        }
      }
    };
    const visit = (node: ts.Node, catchesThrow: boolean): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isTryStatement(node)) {
        visit(node.tryBlock, catchesThrow || node.catchClause !== undefined);
        if (node.catchClause) visit(node.catchClause.block, catchesThrow);
        if (node.finallyBlock) visit(node.finallyBlock, catchesThrow);
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const binding = resolvedSymbol(checker, node.name);
        if (binding && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
          const slots = new Map<string, IteratorBindingState>();
          iteratorSlots.set(binding, slots);
          for (const property of node.initializer.properties) {
            if (ts.isPropertyAssignment(property)) {
              const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name))
                ? property.name.text : undefined;
              if (key !== undefined) slots.set(key, iteratorStateOf(property.initializer));
            } else if (ts.isShorthandPropertyAssignment(property)) {
              slots.set(property.name.text, iteratorStateOf(property.name));
            }
          }
        } else if (binding && node.initializer && ts.isIdentifier(node.initializer)) {
          const source = resolvedSymbol(checker, node.initializer);
          if (source && iteratorSlots.has(objectRoot(source))) objectAliases.set(binding, objectRoot(source));
          updateIteratorBinding(binding, iteratorStateOf(node.initializer), false);
        } else if (binding && node.initializer) updateIteratorBinding(binding, iteratorStateOf(node.initializer), false);
        else if (binding && checker.getPropertyOfType(checker.getTypeAtLocation(node.name), "next")) {
          updateIteratorBinding(binding, { generators: [], unknown: true, pure: false }, false);
        }
      }
      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)
        && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) {
        const binding = resolvedSymbol(checker, node.left);
        if (binding) updateIteratorBinding(binding, iteratorStateOf(node.right), node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || conditionallyExecuted(node));
      }
      if (ts.isBinaryExpression(node) && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        && [ts.SyntaxKind.EqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken].includes(node.operatorToken.kind)) {
        const slot = propertySlot(node.left);
        if (slot) updateIteratorSlot(slot.root, slot.key, iteratorStateOf(node.right), node.operatorToken.kind !== ts.SyntaxKind.EqualsToken || conditionallyExecuted(node));
        else invalidateObjectSlots(node.left.expression);
      }
      const addStoredGeneratorConsumption = (expression: ts.Expression, convertsThrowToRejection = false, iteratorEffectInstantiation?: IteratorEffectInstantiation): boolean => {
        const binding = ts.isIdentifier(expression) ? resolvedSymbol(checker, expression) : undefined;
        const slot = propertySlot(expression);
        if (!binding && !slot) return false;
        const state = slot ? iteratorSlots.get(slot.root)?.get(slot.key) : binding ? {
          generators: generatorBindings.get(binding) ?? [],
          unknown: unknownGeneratorBindings.has(binding),
          pure: pureIteratorBindings.has(binding),
        } : undefined;
        if (!state) return false;
        const targets = state.generators;
        for (const target of targets ?? []) edges.push({ caller, callee: stableId(target), kind: "direct", timing: "inline", span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [], dischargesThrow: catchesThrow || convertsThrowToRejection, executesBody: true, iteratorEffectInstantiation });
        if (state.unknown) edges.push({ caller, kind: "direct", timing: "inline", span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [], dischargesThrow: catchesThrow || convertsThrowToRejection, executesBody: true, unknownGeneratorConsumption: true, iteratorEffectInstantiation });
        return Boolean(targets.length || state.unknown || state.pure);
      };
      const addUnknownGeneratorConsumption = (expression: ts.Expression, convertsThrowToRejection = false, iteratorEffectInstantiation?: IteratorEffectInstantiation): void => {
        const parameterIndex = ts.isIdentifier(expression)
          ? iteratorParameterIndices.get(resolvedSymbol(checker, expression)!) : undefined;
        edges.push({ caller, kind: "direct", timing: "inline", span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [], dischargesThrow: catchesThrow || convertsThrowToRejection, executesBody: true, unknownGeneratorConsumption: true, unknownGeneratorParameterIndex: parameterIndex, iteratorEffectInstantiation });
      };
      const specializeIteratorArgument = (expression: ts.Expression, convertsThrowToRejection: boolean, iteratorEffectInstantiation: IteratorEffectInstantiation): boolean => {
        if (addStoredGeneratorConsumption(expression, convertsThrowToRejection, iteratorEffectInstantiation)) return true;
        if (ts.isCallExpression(expression)) {
          const lookup = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name : expression.expression;
          const target = symbolNodes.get(resolvedSymbol(checker, lookup)!);
          const generators = returnedGeneratorDeclarations(target);
          if (generators) {
            for (const generator of generators) edges.push({ caller, callee: stableId(generator), kind: "direct", timing: "inline", span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [], dischargesThrow: catchesThrow || convertsThrowToRejection, executesBody: true, iteratorEffectInstantiation });
            return true;
          }
          if (checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")) {
            if (!isStandardLibraryCall(expression)) addUnknownGeneratorConsumption(expression, convertsThrowToRejection, iteratorEffectInstantiation);
            return true;
          }
        }
        if (checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")) {
          addUnknownGeneratorConsumption(expression, convertsThrowToRejection, iteratorEffectInstantiation);
          return true;
        }
        return false;
      };
      const consumeStoredOrUnknown = (expression: ts.Expression, convertsThrowToRejection = false): void => {
        if (addStoredGeneratorConsumption(expression, convertsThrowToRejection) || ts.isCallExpression(expression)) return;
        if (checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")) {
          addUnknownGeneratorConsumption(expression, convertsThrowToRejection);
        }
      };
      const consumeIterableExpression = (
        expression: ts.Expression, convertsThrowToRejection = false, prefersAsync = false,
      ): void => {
        const implicitIterator = prefersAsync
          ? implicitIteratorDeclaration(expression, "asyncIterator") ?? implicitIteratorDeclaration(expression)
          : implicitIteratorDeclaration(expression);
        if (!implicitIterator) {
          if (ts.isCallExpression(expression)) {
            const lookup = ts.isPropertyAccessExpression(expression.expression) ? expression.expression.name : expression.expression;
            const target = symbolNodes.get(resolvedSymbol(checker, lookup)!);
            if (target?.asteriskToken || returnedGeneratorDeclarations(target)) return;
          }
          if (!addStoredGeneratorConsumption(expression, convertsThrowToRejection)
            && !reviewedBuiltinIterable(expression)
            && (hasIteratorProtocol(expression) || (prefersAsync && hasIteratorProtocol(expression, "asyncIterator")))) {
            addUnknownGeneratorConsumption(expression, convertsThrowToRejection);
          } else if (checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")) {
            consumeStoredOrUnknown(expression, convertsThrowToRejection);
          }
          return;
        }
        const receiver = canonicalAddressableReceiver(expression);
        edges.push({
          caller, callee: stableId(implicitIterator), kind: "direct", timing: "inline",
          span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [],
          ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
          dischargesThrow: catchesThrow || convertsThrowToRejection, executesBody: true,
          ...(!implicitIterator.asteriskToken ? { unknownGeneratorConsumption: true } : {}),
        });
      };
      const addEnumerableGetterEdges = (expression: ts.Expression, omitted = new Set<string>()): void => {
        if (isAuthenticatedProxyExpression(checker, expression)) return;
        const receiver = canonicalAddressableReceiver(expression);
        for (const property of checker.getTypeAtLocation(expression).getProperties()) {
          if (omitted.has(property.name)) continue;
          for (const getter of property.declarations?.filter(ts.isGetAccessorDeclaration) ?? []) {
            if (!getter.body || !ts.isObjectLiteralExpression(getter.parent) || !byId.has(stableId(getter))) continue;
            edges.push({
              caller, callee: stableId(getter), kind: "direct", timing: "inline",
              span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [],
              ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
              dischargesThrow: catchesThrow, executesBody: true,
            });
          }
        }
      };
      const addStructuredCloneGetterEdges = (raw: ts.Expression, seen = new Set<ts.Node>()): void => {
        let expression = raw;
        while (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)
          || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)
          || ts.isNonNullExpression(expression)) expression = expression.expression;
        if (seen.has(expression) || isAuthenticatedProxyExpression(checker, expression)) return;
        seen.add(expression);
        addEnumerableGetterEdges(expression);
        if (ts.isObjectLiteralExpression(expression)) {
          for (const property of expression.properties) {
            if (ts.isPropertyAssignment(property)) addStructuredCloneGetterEdges(property.initializer, seen);
            else if (ts.isShorthandPropertyAssignment(property)) addStructuredCloneGetterEdges(property.name, seen);
            else if (ts.isSpreadAssignment(property)) addStructuredCloneGetterEdges(property.expression, seen);
          }
        } else if (ts.isArrayLiteralExpression(expression)) {
          for (const element of expression.elements) {
            if (!ts.isOmittedExpression(element)) addStructuredCloneGetterEdges(ts.isSpreadElement(element) ? element.expression : element, seen);
          }
        }
      };
      const addEnumerableSetterEdges = (target: ts.Expression, sources: readonly ts.Expression[]): void => {
        if (isAuthenticatedProxyExpression(checker, target)) return;
        const receiver = canonicalAddressableReceiver(target);
        const targetType = checker.getTypeAtLocation(target);
        for (const source of sources) {
          for (const sourceProperty of checker.getTypeAtLocation(source).getProperties()) {
            const declarations = sourceProperty.declarations ?? [];
            const potentiallyOwnEnumerable = declarations.length === 0 || declarations.some((item) =>
              !((ts.isClassDeclaration(item.parent) || ts.isClassExpression(item.parent))
                && (ts.isMethodDeclaration(item) || ts.isGetAccessorDeclaration(item) || ts.isSetAccessorDeclaration(item))));
            if (!potentiallyOwnEnumerable) continue;
            const property = checker.getPropertyOfType(targetType, sourceProperty.name);
            for (const setter of property?.declarations?.filter(ts.isSetAccessorDeclaration) ?? []) {
              if (!setter.body || !byId.has(stableId(setter))) continue;
              const propertyAccess = `${source.getText()}[${JSON.stringify(sourceProperty.name)}]`;
              edges.push({
                caller, callee: stableId(setter), kind: "direct", timing: "inline",
                span: { start: target.getStart(), end: target.getEnd() }, arguments: [propertyAccess],
                ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
                dischargesThrow: catchesThrow, executesBody: true,
              });
            }
          }
        }
      };
      const addNamedGetterEdges = (expression: ts.Expression, names: readonly string[]): void => {
        if (isAuthenticatedProxyExpression(checker, expression)) return;
        const receiver = canonicalAddressableReceiver(expression);
        const type = checker.getTypeAtLocation(expression);
        for (const name of names) {
          const property = checker.getPropertyOfType(type, name);
          for (const getter of property?.declarations?.filter(ts.isGetAccessorDeclaration) ?? []) {
            if (!getter.body || !byId.has(stableId(getter))) continue;
            edges.push({
              caller, callee: stableId(getter), kind: "direct", timing: "inline",
              span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [],
              ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
              dischargesThrow: catchesThrow, executesBody: true,
            });
          }
        }
      };
      const addDescriptorMapEdges = (descriptors: ts.Expression): void => {
        addEnumerableGetterEdges(descriptors);
        if (!ts.isObjectLiteralExpression(descriptors)) return;
        for (const property of descriptors.properties) {
          const descriptor = ts.isPropertyAssignment(property) ? property.initializer
            : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
          if (descriptor) addNamedGetterEdges(descriptor, ["enumerable", "configurable", "value", "writable", "get", "set"]);
        }
      };
      const staticPropertyNames = (expression: ts.Expression): string[] | undefined => {
        const type = checker.getTypeAtLocation(expression), members = type.isUnion() ? type.types : [type];
        const names = members.flatMap((member) => {
          if ((member.flags & ts.TypeFlags.StringLiteral) !== 0) return [(member as ts.StringLiteralType).value];
          if ((member.flags & ts.TypeFlags.NumberLiteral) !== 0) return [String((member as ts.NumberLiteralType).value)];
          return [];
        });
        return names.length === members.length ? [...new Set(names)] : undefined;
      };
      const addReflectAccessorEdges = (call: ts.CallExpression, mode: "get" | "set"): void => {
        const target = call.arguments[0], key = call.arguments[1];
        if (!target || !key || isAuthenticatedProxyExpression(checker, target)) return;
        const names = staticPropertyNames(key);
        if (!names) return;
        const receiverExpression = mode === "get" ? call.arguments[2] ?? target : call.arguments[3] ?? target;
        if (isAuthenticatedProxyExpression(checker, receiverExpression)) return;
        const receiver = canonicalAddressableReceiver(receiverExpression);
        for (const name of names) {
          const property = checker.getPropertyOfType(checker.getTypeAtLocation(target), name);
          const accessors = mode === "get"
            ? property?.declarations?.filter(ts.isGetAccessorDeclaration) ?? []
            : property?.declarations?.filter(ts.isSetAccessorDeclaration) ?? [];
          for (const accessor of accessors) {
            if (!accessor.body || !byId.has(stableId(accessor))) continue;
            edges.push({
              caller, callee: stableId(accessor), kind: "direct", timing: "inline",
              span: { start: call.getStart(), end: call.getEnd() },
              arguments: mode === "set" && call.arguments[2] ? [call.arguments[2].getText()] : [],
              ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
              dischargesThrow: catchesThrow, executesBody: true,
            });
          }
        }
      };
      const localCallableDeclaration = (raw: ts.Expression, seen = new Set<ts.Symbol>()): ts.FunctionLikeDeclaration | undefined => {
        const expression = ts.isParenthesizedExpression(raw) || ts.isAsExpression(raw)
          || ts.isTypeAssertionExpression(raw) || ts.isNonNullExpression(raw) ? raw.expression : raw;
        if (isAuthenticatedProxyExpression(checker, expression)) return undefined;
        const lookup = ts.isPropertyAccessExpression(expression) ? expression.name
          : ts.isElementAccessExpression(expression) ? expression.argumentExpression : expression;
        const symbol = lookup ? resolvedSymbol(checker, lookup) : undefined;
        if (symbol && !seen.has(symbol)) {
          seen.add(symbol);
          const direct = symbolNodes.get(symbol);
          if (direct) return direct;
          const variable = symbol.valueDeclaration;
          if (variable && ts.isVariableDeclaration(variable) && variable.initializer
            && ts.isVariableDeclarationList(variable.parent) && (variable.parent.flags & ts.NodeFlags.Const) !== 0) {
            const aliased = localCallableDeclaration(variable.initializer, seen);
            if (aliased) return aliased;
          }
        }
        return checker.getTypeAtLocation(expression).getCallSignatures().map((signature) => signature.declaration)
          .find((candidate): candidate is ts.FunctionLikeDeclaration => Boolean(candidate && ts.isFunctionLike(candidate)
            && (candidate as ts.FunctionLikeDeclaration).body && byId.has(stableId(candidate as ts.FunctionLikeDeclaration))));
      };
      const staticApplyArguments = (raw: ts.Expression): readonly ts.Expression[] | undefined => {
        const expression = ts.isParenthesizedExpression(raw) || ts.isAsExpression(raw)
          || ts.isTypeAssertionExpression(raw) || ts.isNonNullExpression(raw) ? raw.expression : raw;
        if (ts.isArrayLiteralExpression(expression) && expression.elements.every((item) => !ts.isSpreadElement(item))) {
          return expression.elements as ts.NodeArray<ts.Expression>;
        }
        if (ts.isIdentifier(expression)) {
          const symbol = resolvedSymbol(checker, expression);
          const variable = symbol?.valueDeclaration;
          if (variable && ts.isVariableDeclaration(variable) && variable.initializer
            && ts.isVariableDeclarationList(variable.parent) && (variable.parent.flags & ts.NodeFlags.Const) !== 0) {
            let unstable = false;
            const screen = (candidate: ts.Node): void => {
              if (unstable) return;
              if (ts.isIdentifier(candidate) && resolvedSymbol(checker, candidate) === symbol
                && candidate !== variable.name && candidate !== expression) unstable = true;
              ts.forEachChild(candidate, screen);
            };
            if (declaration.body) screen(declaration.body);
            if (unstable) return undefined;
            return staticApplyArguments(variable.initializer);
          }
        }
        return undefined;
      };
      interface BoundCallableResolution {
        target: ts.FunctionLikeDeclaration;
        receiver: ts.Expression;
        prefixArguments: readonly ts.Expression[];
      }
      const boundCallableResolution = (raw: ts.Expression, seen = new Set<ts.Symbol>()): BoundCallableResolution | undefined => {
        const expression = ts.isParenthesizedExpression(raw) || ts.isAsExpression(raw)
          || ts.isTypeAssertionExpression(raw) || ts.isNonNullExpression(raw) ? raw.expression : raw;
        let initializer: ts.Expression = expression;
        if (ts.isIdentifier(expression)) {
          const symbol = resolvedSymbol(checker, expression);
          const variable = symbol?.valueDeclaration;
          if (!symbol || seen.has(symbol) || !variable || !ts.isVariableDeclaration(variable) || !variable.initializer
            || !ts.isVariableDeclarationList(variable.parent) || (variable.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
          seen.add(symbol);
          const possibleAlias = ts.isIdentifier(variable.initializer);
          const possibleBind = ts.isCallExpression(variable.initializer)
            && ts.isPropertyAccessExpression(variable.initializer.expression)
            && variable.initializer.expression.name.text === "bind";
          if (!possibleAlias && !possibleBind) return undefined;
          let unstable = false;
          const screen = (candidate: ts.Node): void => {
            if (unstable) return;
            if (ts.isIdentifier(candidate) && resolvedSymbol(checker, candidate) === symbol
              && candidate !== variable.name && candidate !== expression) {
              const directCall = ts.isCallExpression(candidate.parent) && candidate.parent.expression === candidate;
              const wrapperCall = ts.isPropertyAccessExpression(candidate.parent) && candidate.parent.expression === candidate
                && (candidate.parent.name.text === "call" || candidate.parent.name.text === "apply")
                && ts.isCallExpression(candidate.parent.parent) && candidate.parent.parent.expression === candidate.parent;
              const immutableAlias = ts.isVariableDeclaration(candidate.parent) && candidate.parent.initializer === candidate
                && ts.isVariableDeclarationList(candidate.parent.parent)
                && (candidate.parent.parent.flags & ts.NodeFlags.Const) !== 0;
              if (!directCall && !wrapperCall && !immutableAlias) unstable = true;
            }
            ts.forEachChild(candidate, screen);
          };
          if (declaration.body) screen(declaration.body);
          if (unstable) return undefined;
          initializer = variable.initializer;
          if (ts.isIdentifier(initializer)) return boundCallableResolution(initializer, seen);
        }
        if (!ts.isCallExpression(initializer) || !ts.isPropertyAccessExpression(initializer.expression)
          || initializer.expression.name.text !== "bind" || !isStandardLibraryCall(initializer)
          || !initializer.arguments[0]) return undefined;
        const target = localCallableDeclaration(initializer.expression.expression);
        return target ? { target, receiver: initializer.arguments[0], prefixArguments: initializer.arguments.slice(1) } : undefined;
      };
      const addIndirectCallableEdge = (
        call: ts.CallExpression, targetExpression: ts.Expression, thisExpression: ts.Expression | undefined,
        arguments_: readonly ts.Expression[] | undefined,
      ): void => {
        const bound = boundCallableResolution(targetExpression);
        const target = bound?.target ?? localCallableDeclaration(targetExpression);
        if (!target) return;
        const effectiveReceiver = bound?.receiver ?? thisExpression;
        const receiver = effectiveReceiver ? canonicalAddressableReceiver(effectiveReceiver) : undefined;
        const effectiveArguments = arguments_ ? [...(bound?.prefixArguments ?? []), ...arguments_] : undefined;
        const projected = effectiveArguments?.map(canonicalAddressableArgument) ?? [];
        edges.push({
          caller, callee: stableId(target), kind: "direct", timing: "inline",
          span: { start: call.getStart(), end: call.getEnd() }, arguments: projected.map((item) => item.text),
          ...(receiver && !receiver.unresolvedAlias ? { receiver: receiver.text } : {}),
          dischargesThrow: catchesThrow, executesBody: true,
          ...(!effectiveArguments || receiver?.unresolvedAlias || projected.some((item) => item.unresolvedAlias)
            ? { unresolvedMutationAlias: true } : {}),
        });
      };
      const localClassDeclaration = (expression: ts.Expression): ts.ClassDeclaration | ts.ClassExpression | undefined => {
        if (isAuthenticatedProxyExpression(checker, expression)) return undefined;
        const symbol = resolvedSymbol(checker, expression);
        return symbol?.declarations?.find((candidate): candidate is ts.ClassDeclaration | ts.ClassExpression =>
          (ts.isClassDeclaration(candidate) || ts.isClassExpression(candidate)) && !candidate.getSourceFile().isDeclarationFile);
      };
      const addReflectConstructEdge = (call: ts.CallExpression): void => {
        const targetExpression = call.arguments[0], argumentList = call.arguments[1];
        if (!targetExpression || !argumentList || isAuthenticatedProxyExpression(checker, targetExpression)) return;
        const classDeclaration = localClassDeclaration(targetExpression);
        const explicit = classDeclaration?.members.find((member): member is ts.ConstructorDeclaration =>
          ts.isConstructorDeclaration(member) && Boolean(member.body));
        const target = explicit ?? checker.getTypeAtLocation(targetExpression).getConstructSignatures()
          .map((signature) => signature.declaration)
          .find((candidate): candidate is ts.ConstructorDeclaration => Boolean(candidate && ts.isConstructorDeclaration(candidate)
            && candidate.body && byId.has(stableId(candidate))));
        const arguments_ = staticApplyArguments(argumentList);
        const boundName = ts.isVariableDeclaration(call.parent) && call.parent.initializer === call
          && ts.isIdentifier(call.parent.name) ? call.parent.name.text : undefined;
        if (target) {
          const projected = arguments_?.map(canonicalAddressableArgument) ?? [];
          edges.push({
            caller, callee: stableId(target), kind: "direct", timing: "inline",
            span: { start: call.getStart(), end: call.getEnd() }, arguments: projected.map((item) => item.text),
            ...(boundName ? { receiver: boundName } : {}), dischargesThrow: catchesThrow, executesBody: true,
            ...(!arguments_ || projected.some((item) => item.unresolvedAlias) ? { unresolvedMutationAlias: true } : {}),
          });
        }
        if (classDeclaration && !explicit && !expandingImplicitClasses.has(classDeclaration)) {
          expandingImplicitClasses.add(classDeclaration);
          for (const member of classDeclaration.members) {
            if (ts.isPropertyDeclaration(member) && member.initializer
              && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) visit(member.initializer, catchesThrow);
          }
          expandingImplicitClasses.delete(classDeclaration);
        }
      };
      if (ts.isSpreadAssignment(node)) addEnumerableGetterEdges(node.expression);
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
        const receiver = canonicalAddressableReceiver(node.initializer);
        const sourceType = checker.getTypeAtLocation(node.initializer);
        const selected = new Set(node.name.elements.flatMap((element) => {
          if (element.dotDotDotToken) return [];
          const propertyName = element.propertyName
            ? ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)
              || ts.isNumericLiteral(element.propertyName) ? element.propertyName.text : undefined
            : ts.isIdentifier(element.name) ? element.name.text : undefined;
          return propertyName === undefined ? [] : [propertyName];
        }));
        if (node.name.elements.some((element) => element.dotDotDotToken)) addEnumerableGetterEdges(node.initializer, selected);
        addObjectBindingGetterEdges(node.name, sourceType, receiver, catchesThrow);
      }
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const lookup = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
        const symbol = lookup ? resolvedSymbol(checker, lookup) : undefined;
        const binaryWrite = ts.isBinaryExpression(node.parent) && node.parent.left === node
          && node.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
          && node.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        const updateWrite = (ts.isPrefixUnaryExpression(node.parent) || ts.isPostfixUnaryExpression(node.parent))
          && node.parent.operand === node
          && (node.parent.operator === ts.SyntaxKind.PlusPlusToken || node.parent.operator === ts.SyntaxKind.MinusMinusToken);
        const simpleWrite = binaryWrite && ts.isBinaryExpression(node.parent)
          && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
        const reads = !simpleWrite;
        const writes = binaryWrite || updateWrite;
        const receiver = canonicalAddressableReceiver(node.expression);
        for (const accessor of symbol?.declarations ?? []) {
          if ((!reads || !ts.isGetAccessorDeclaration(accessor)) && (!writes || !ts.isSetAccessorDeclaration(accessor))) continue;
          if (!accessor.body || !byId.has(stableId(accessor))) continue;
          const argument = ts.isSetAccessorDeclaration(accessor) && binaryWrite && ts.isBinaryExpression(node.parent)
            ? [node.parent.right.getText()] : [];
          edges.push({
            caller, callee: stableId(accessor), kind: "direct", timing: "inline",
            span: { start: node.getStart(), end: node.getEnd() }, arguments: argument,
            ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
            dischargesThrow: catchesThrow, executesBody: true,
          });
        }
      }
      const coercionOperands: { expression: ts.Expression; stringHint: boolean }[] = [];
      if (ts.isTemplateSpan(node) && !definitelyPrimitive(node.expression)) {
        coercionOperands.push({ expression: node.expression, stringHint: true });
      } else if (ts.isPrefixUnaryExpression(node)
        && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(node.operator)
        && !definitelyPrimitive(node.operand)) {
        coercionOperands.push({ expression: node.operand, stringHint: false });
      } else if (ts.isBinaryExpression(node) && [
        ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
        ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
        ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
        ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
        ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.BarToken, ts.SyntaxKind.CaretToken,
        ts.SyntaxKind.LessThanLessThanToken, ts.SyntaxKind.GreaterThanGreaterThanToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
        ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
        ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken,
        ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
        ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
        ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
      ].includes(node.operatorToken.kind)) {
        if (!definitelyPrimitive(node.left)) coercionOperands.push({ expression: node.left, stringHint: false });
        if (!definitelyPrimitive(node.right)) coercionOperands.push({ expression: node.right, stringHint: false });
      }
      for (const { expression, stringHint } of coercionOperands) {
        const receiver = canonicalAddressableReceiver(expression);
        for (const coercion of implicitCoercionDeclarations(expression, stringHint)) {
          if (!byId.has(stableId(coercion))) continue;
          const exotic = isGlobalSymbolMemberName(coercion.name, "toPrimitive");
          edges.push({
            caller, callee: stableId(coercion), kind: "direct", timing: "inline",
            span: { start: expression.getStart(), end: expression.getEnd() },
            arguments: exotic ? [stringHint ? '"string"' : '"number"'] : [],
            ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
            dischargesThrow: catchesThrow, executesBody: true,
          });
        }
      }
      if (ts.isComputedPropertyName(node) && !definitelyPrimitive(node.expression)) {
        const receiver = canonicalAddressableReceiver(node.expression);
        for (const coercion of implicitCoercionDeclarations(node.expression, true)) {
          if (!byId.has(stableId(coercion))) continue;
          const exotic = isGlobalSymbolMemberName(coercion.name, "toPrimitive");
          edges.push({
            caller, callee: stableId(coercion), kind: "direct", timing: "inline",
            span: { start: node.getStart(), end: node.getEnd() },
            arguments: exotic ? ['"string"'] : [],
            ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
            dischargesThrow: catchesThrow, executesBody: true,
          });
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) {
        const receiver = canonicalAddressableReceiver(node.right);
        for (const hook of implicitGlobalSymbolMethods(node.right, "hasInstance")) {
          if (!byId.has(stableId(hook))) continue;
          edges.push({
            caller, callee: stableId(hook), kind: "direct", timing: "inline",
            span: { start: node.getStart(), end: node.getEnd() }, arguments: [node.left.getText()],
            ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
            dischargesThrow: catchesThrow, executesBody: true,
          });
        }
      }
      if (ts.isForOfStatement(node)) consumeIterableExpression(
        node.expression, node.awaitModifier !== undefined, node.awaitModifier !== undefined,
      );
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) {
        const asynchronous = (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Async) !== 0;
        consumeIterableExpression(node.expression, asynchronous, asynchronous);
      }
      if (ts.isSpreadElement(node)) consumeIterableExpression(node.expression);
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer) consumeIterableExpression(node.initializer);
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.[0]
        && iterableConsumerArgument(node, node.arguments[0])) consumeIterableExpression(
          node.arguments[0], promiseIterableConsumerArgument(node, node.arguments[0]),
          ts.isCallExpression(node) && standardLibraryOperation(checker, node) === "ArrayConstructor#fromAsync",
        );
      if (ts.isNewExpression(node)) {
        const symbol = resolvedSymbol(checker, node.expression);
        const classDeclaration = symbol?.declarations?.find((declaration): declaration is ts.ClassDeclaration | ts.ClassExpression =>
          ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration));
        const hasExplicitConstructor = classDeclaration?.members.some((member) => ts.isConstructorDeclaration(member) && Boolean(member.body));
        const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
        const signatureTarget = signatureDeclaration && ts.isConstructorDeclaration(signatureDeclaration)
          && byId.has(stableId(signatureDeclaration)) ? signatureDeclaration : undefined;
        const target = symbol ? symbolNodes.get(symbol) ?? signatureTarget : signatureTarget;
        if (target && ts.isConstructorDeclaration(target)) {
          const arguments_ = (node.arguments ?? []).map(canonicalAddressableArgument);
          const boundName = ts.isVariableDeclaration(node.parent) && node.parent.initializer === node
            && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
          edges.push({
            caller, callee: stableId(target), kind: "direct", timing: "inline",
            span: { start: node.getStart(), end: node.getEnd() },
            arguments: arguments_.map(({ text }) => text),
            ...(boundName ? { receiver: boundName } : {}),
            dischargesThrow: catchesThrow, executesBody: true,
            ...(arguments_.some(({ unresolvedAlias }) => unresolvedAlias) ? { unresolvedMutationAlias: true } : {}),
          });
        }
        if (classDeclaration && !hasExplicitConstructor && !expandingImplicitClasses.has(classDeclaration)) {
          expandingImplicitClasses.add(classDeclaration);
          for (const member of classDeclaration.members) {
            if (ts.isPropertyDeclaration(member) && member.initializer
              && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
              visit(member.initializer, catchesThrow);
            }
          }
          expandingImplicitClasses.delete(classDeclaration);
        }
      }
      if (ts.isCallExpression(node)) {
        const resolvedBuiltin = adapter.resolveCall(node);
        const projectedCallbacks = projectBuiltinCallbacks(resolvedBuiltin, node, checker);
        const callbackInstantiation = (argument: ts.Expression, callbackDeclaration?: ts.FunctionLikeDeclaration): {
          arguments: string[];
          receiver?: string;
          unresolvedMutationAlias?: true;
          unresolvedMutationArgumentIndices?: number[];
        } => {
          const event = projectedCallbacks.find((candidate) =>
            candidate.target.status === "resolved" && candidate.target.expression === argument);
          if (!event) return { arguments: [] };
          const unresolvedMutationArgumentIndices: number[] = [];
          const runtimeParameterCount = runtimeParametersOf(callbackDeclaration ?? declaration).length;
          const projectedArguments = event.invocationArguments;
          const paddedProjectedArguments = projectedArguments
            ? [...projectedArguments, ...Array.from({ length: Math.max(0, runtimeParameterCount - projectedArguments.length) }, (_unused, index) => ({
                status: "unknown" as const,
                reason: `callback parameter ${projectedArguments.length + index} has no invocation projector`,
              }))]
            : runtimeParametersOf(callbackDeclaration ?? declaration).map((_parameter, index) => ({
            status: "unknown" as const, reason: `builtin callback argument ${index} has no invocation projector`,
          }));
          const arguments_ = paddedProjectedArguments.map((projected, index) => {
            if (projected.status !== "resolved" || projected.path.length > 0) {
              unresolvedMutationArgumentIndices.push(index);
              return "";
            }
            const resolved = canonicalAddressableReceiver(projected.expression);
            if (resolved.unresolvedAlias) unresolvedMutationArgumentIndices.push(index);
            return resolved.text;
          });
          let receiver: string | undefined, unresolvedMutationAlias: true | undefined;
          if (event.thisArgument && event.thisArgument.status !== "absent") {
            if (event.thisArgument.status !== "resolved" || event.thisArgument.path.length > 0) unresolvedMutationAlias = true;
            else {
              const resolved = canonicalAddressableReceiver(event.thisArgument.expression);
              if (resolved.unresolvedAlias) unresolvedMutationAlias = true;
              else receiver = resolved.text;
            }
          }
          return {
            arguments: arguments_, ...(receiver ? { receiver } : {}),
            ...(unresolvedMutationAlias ? { unresolvedMutationAlias } : {}),
            ...(unresolvedMutationArgumentIndices.length > 0 ? { unresolvedMutationArgumentIndices } : {}),
          };
        };
        const libraryOperation = standardLibraryOperation(checker, node);
        const reflectConstruct = libraryOperation === "Reflect#construct";
        if (reflectConstruct) addReflectConstructEdge(node);
        const directBound = boundCallableResolution(node.expression);
        if (directBound) addIndirectCallableEdge(node, node.expression, undefined, node.arguments);
        if (node.arguments.length >= 2 && libraryOperation === "ObjectConstructor#assign") {
          for (const source of node.arguments.slice(1)) addEnumerableGetterEdges(source);
          addEnumerableSetterEdges(node.arguments[0]!, node.arguments.slice(1));
        }
        if (libraryOperation === "Array#concat" || libraryOperation === "ReadonlyArray#concat") {
          if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
            addEnumerableGetterEdges(node.expression.expression);
          }
          for (const argument of node.arguments) addEnumerableGetterEdges(argument);
        }
        if (node.arguments[2] && (libraryOperation === "ObjectConstructor#defineProperty"
          || libraryOperation === "Reflect#defineProperty")) {
          addNamedGetterEdges(node.arguments[2], ["enumerable", "configurable", "value", "writable", "get", "set"]);
        }
        if (node.arguments[1] && libraryOperation === "ObjectConstructor#defineProperties") {
          addDescriptorMapEdges(node.arguments[1]);
        }
        if (node.arguments[1] && libraryOperation === "ObjectConstructor#create") {
          addDescriptorMapEdges(node.arguments[1]);
        }
        if (node.arguments[0] && (libraryOperation === "ObjectConstructor#values"
          || libraryOperation === "ObjectConstructor#entries")) addEnumerableGetterEdges(node.arguments[0]);
        if (libraryOperation === "Reflect#get" || libraryOperation === "Reflect#set") {
          addReflectAccessorEdges(node, libraryOperation === "Reflect#get" ? "get" : "set");
        }
        if (ts.isPropertyAccessExpression(node.expression) && isStandardLibraryCall(node)
          && (node.expression.name.text === "call" || node.expression.name.text === "apply")) {
          const mode = node.expression.name.text;
          addIndirectCallableEdge(node, node.expression.expression, node.arguments[0],
            mode === "call" ? node.arguments.slice(1)
              : node.arguments[1] ? staticApplyArguments(node.arguments[1]) : undefined);
        }
        if (libraryOperation === "Reflect#apply" && node.arguments[0]) {
          addIndirectCallableEdge(node, node.arguments[0], node.arguments[1],
            node.arguments[2] ? staticApplyArguments(node.arguments[2]) : undefined);
        }
        if (node.arguments[0] && libraryOperation === "JSON#stringify") {
          const value = node.arguments[0];
          const toJSON = checker.getPropertyOfType(checker.getTypeAtLocation(value), "toJSON");
          const receiver = canonicalAddressableReceiver(value);
          for (const method of toJSON?.declarations?.filter(ts.isMethodDeclaration) ?? []) {
            if (!method.body || !byId.has(stableId(method))) continue;
            edges.push({
              caller, callee: stableId(method), kind: "direct", timing: "inline",
              span: { start: value.getStart(), end: value.getEnd() }, arguments: ['""'],
              ...(!receiver.unresolvedAlias ? { receiver: receiver.text } : { unresolvedMutationAlias: true }),
              dischargesThrow: catchesThrow, executesBody: true,
            });
          }
          if (!toJSON) addEnumerableGetterEdges(value);
        }
        if (node.arguments[0] && libraryOperation === "structuredClone") {
          addStructuredCloneGetterEdges(node.arguments[0]);
        }
        for (const argument of node.arguments) invalidateObjectSlots(argument);
        if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
          invalidateObjectSlots(node.expression.expression);
        }
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const symbol = resolvedSymbol(checker, lookup);
        const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
        let signatureTarget: ts.FunctionLikeDeclaration | undefined;
        if (signatureDeclaration && ts.isFunctionLike(signatureDeclaration)) {
          const candidate = signatureDeclaration as ts.FunctionLikeDeclaration;
          if (byId.has(stableId(candidate))) signatureTarget = candidate;
        }
        const targetDeclaration = symbol ? symbolNodes.get(symbol) ?? signatureTarget : signatureTarget;
        const overloadIndex = symbol && signatureDeclaration ? symbol.declarations?.filter((item) => (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item)) && !item.body).indexOf(signatureDeclaration) : -1;
        const parameterIndex = ts.isIdentifier(node.expression) ? parameters.get(node.expression.text) : undefined;
        const consumptionSyntax = (
          (ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node && node.parent.name.text === "next"
            && ts.isCallExpression(node.parent.parent) && node.parent.parent.expression === node.parent)
          || (ts.isForOfStatement(node.parent) && node.parent.expression === node)
          || (ts.isYieldExpression(node.parent) && node.parent.asteriskToken !== undefined && node.parent.expression === node)
          || (ts.isSpreadElement(node.parent) && node.parent.expression === node)
          || (ts.isVariableDeclaration(node.parent) && ts.isArrayBindingPattern(node.parent.name) && node.parent.initializer === node)
          || iterableConsumerArgument(node.parent, node)
        );
        const generatorConsumption = Boolean(targetDeclaration?.asteriskToken) && consumptionSyntax;
        const returnedGenerators = consumptionSyntax ? returnedGeneratorDeclarations(targetDeclaration) : undefined;
        const convertsThrowToRejection = promiseIterableConsumerArgument(node.parent, node);
        const unknownGeneratorConsumption = consumptionSyntax && !targetDeclaration?.asteriskToken && !returnedGenerators
          && isOpaqueIteratorCall(node);
        const externalIterator = targetDeclaration ? undefined
          : externalIteratorContractForCall(checker, node, options.externalIteratorEffects);
        const externalCallable = targetDeclaration ? undefined
          : externalCallableContractForCall(checker, node, options.externalCallableEffects);
        const iteratorContracts = targetDeclaration ? iteratorParametersOf(targetDeclaration) : externalIterator?.parameters ?? [];
        const iteratorConsumer = targetDeclaration ? stableId(targetDeclaration) : externalIterator?.key;
        const dischargesUnknownGeneratorParameters = iteratorContracts.length > 0
          && iteratorContracts.every((contract) => {
            const argument = node.arguments[contract.index];
            return Boolean(argument && iteratorConsumer && specializeIteratorArgument(argument, contract.convertsThrowToRejection, {
              consumer: iteratorConsumer, parameterIndex: contract.index,
            }));
          });
        const instantiatedArguments = node.arguments.map(canonicalAddressableArgument);
        const receiverExpression = targetDeclaration && ts.isMethodDeclaration(targetDeclaration)
          && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
          ? node.expression.expression : undefined;
        const instantiatedReceiver = receiverExpression ? canonicalAddressableReceiver(receiverExpression) : undefined;
        edges.push({ caller, callee: targetDeclaration ? stableId(targetDeclaration) : undefined, unresolvedName: targetDeclaration || parameterIndex !== undefined ? undefined : node.expression.getText(), kind: parameterIndex !== undefined ? "callback-parameter" : "direct", timing: "inline", overloadIndex: overloadIndex !== undefined && overloadIndex >= 0 ? overloadIndex : undefined, span: { start: node.getStart(), end: node.getEnd() }, arguments: instantiatedArguments.map(({ text }) => text), ...(instantiatedReceiver && !instantiatedReceiver.unresolvedAlias ? { receiver: instantiatedReceiver.text } : {}), dischargesThrow: catchesThrow || (convertsThrowToRejection && Boolean(targetDeclaration?.asteriskToken)), executesBody: targetDeclaration?.asteriskToken ? generatorConsumption : true, unknownGeneratorConsumption, dischargesUnknownGeneratorParameters, ...((refinementActionOwner && instantiatedArguments.some(({ unresolvedAlias }) => unresolvedAlias)) || instantiatedReceiver?.unresolvedAlias || (targetDeclaration && ts.isMethodDeclaration(targetDeclaration) && !instantiatedReceiver) ? { unresolvedMutationAlias: true } : {}) });
        for (const returnedGenerator of returnedGenerators ?? []) if (returnedGenerator !== targetDeclaration) edges.push({ caller, callee: stableId(returnedGenerator), kind: "direct", timing: "inline", span: { start: node.getStart(), end: node.getEnd() }, arguments: [], dischargesThrow: catchesThrow || convertsThrowToRejection, executesBody: true });
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "next") {
          const receiver = node.expression.expression;
          const resolved = ts.isCallExpression(receiver) || addStoredGeneratorConsumption(receiver);
          if (!resolved && checker.getPropertyOfType(checker.getTypeAtLocation(receiver), "next")) {
            addUnknownGeneratorConsumption(receiver);
          }
        }
        if (parameterIndex !== undefined) timings.set(parameterIndex, "inline");
        node.arguments.forEach((argument, index) => {
          if (reflectConstruct && index === 0) return;
          const parameterIndex = ts.isIdentifier(argument) ? parameters.get(argument.text) : undefined;
          if (parameterIndex !== undefined) {
            const previous = timings.get(parameterIndex);
            const timing = targetDeclaration === declaration
              ? previous ?? "unknown"
              : targetDeclaration
                ? byId.get(stableId(targetDeclaration))?.effectParameters.find((item) => item.index === index)?.timing ?? "unknown"
                : externalCallable?.parameters.find((item) => item.index === index)?.timing
                  ?? builtinTiming(node, checker, adapter, index);
            const joined: InvocationTiming = previous === "unknown" || timing === "unknown" ? "unknown" : previous === "deferred" || timing === "deferred" ? "deferred" : "inline";
            timings.set(parameterIndex, joined);
            edges.push({ caller, kind: "callback-argument", unresolvedName: argument.getText(), timing, span: { start: argument.getStart(), end: argument.getEnd() }, arguments: [] });
          }
          const callbackDeclaration = callbackDeclarationFor(argument);
          if (callbackDeclaration) {
            const calleeNode = targetDeclaration ? byId.get(stableId(targetDeclaration)) : undefined;
            const externalParameter = externalCallable?.parameters.find((item) => item.index === index);
            const timing = calleeNode?.effectParameters.find((item) => item.index === index)?.timing
              ?? externalParameter?.timing
              ?? builtinTiming(node, checker, adapter, index);
            const projectedCallback = projectedCallbacks.find((event) =>
              event.target.status === "resolved" && event.target.expression === argument);
            edges.push({ caller, callee: stableId(callbackDeclaration), kind: "callback-argument", timing,
              span: { start: argument.getStart(), end: argument.getEnd() },
              ...callbackInstantiation(argument, callbackDeclaration),
              ...(externalParameter?.effectBound ? { callbackEffectInstantiation: {
                consumer: externalCallable!.key,
                parameterIndex: index,
                parameterName: externalParameter.name,
                effectBound: externalParameter.effectBound,
              } } : {}),
              dischargesThrow: catchesThrow && timing === "inline"
                || projectedCallback?.completion === "convert-throw-to-rejection"
                || externalParameter?.completion === "convert-throw-to-rejection"
                || externalParameter?.completion === "host-report-throw" });
          }
          for (const externalParameter of externalCallable?.parameters.filter((item) =>
            item.index === index && (item.path?.length ?? 0) > 0) ?? []) {
            const callbackExpression = expressionAtExclusiveConstArgumentPath(checker, argument, externalParameter.path!, {
              call: node, argumentIndex: index,
              preservesContainer: externalParameter.preservesContainer === true,
            });
            const nestedDeclaration = callbackExpression ? callbackDeclarationFor(callbackExpression) : undefined;
            if (!callbackExpression || !nestedDeclaration) {
              edges.push({ caller, kind: "callback-argument", unresolvedName: `${argument.getText()}${externalParameter.path!.map((part) => `[${JSON.stringify(part)}]`).join("")}`,
                timing: "unknown", span: { start: argument.getStart(), end: argument.getEnd() }, arguments: [] });
              continue;
            }
            edges.push({
              caller, callee: stableId(nestedDeclaration), kind: "callback-argument", timing: externalParameter.timing,
              span: { start: callbackExpression.getStart(), end: callbackExpression.getEnd() },
              ...callbackInstantiation(callbackExpression, nestedDeclaration),
              ...(externalParameter.effectBound ? { callbackEffectInstantiation: {
                consumer: externalCallable!.key,
                parameterIndex: index,
                parameterName: externalParameter.name,
                effectBound: externalParameter.effectBound,
              } } : {}),
              dischargesThrow: catchesThrow && externalParameter.timing === "inline"
                || externalParameter.completion === "convert-throw-to-rejection"
                || externalParameter.completion === "host-report-throw",
            });
          }
        });
        const semanticEvents = resolvedBuiltin?.semantics
          ? interpretBuiltinCallSemantics(resolvedBuiltin.semantics, node, { symbol: resolvedBuiltin.symbol, span: resolvedBuiltin.span }, undefined,
            { resolveStaticString: (expression) => adapter.resolveStaticString(expression) }) : [];
        for (const event of semanticEvents) {
          if (event.kind === "unknown" && event.primitive.kind === "callback" && event.primitive.target.kind === "array-elements") {
            edges.push({ caller, kind: "callback-argument", unresolvedName: node.arguments[event.primitive.target.target.kind === "argument" ? event.primitive.target.target.index : 0]?.getText() ?? "<callback collection>", timing: "unknown", span: { start: node.getStart(), end: node.getEnd() }, arguments: [] });
            continue;
          }
          if (event.kind !== "callback" || event.returnDepth === undefined || event.target.status !== "resolved") continue;
          const element = event.target.expression;
          const callbackDeclaration = (ts.isArrowFunction(element) || ts.isFunctionExpression(element)) ? element
            : ts.isIdentifier(element) ? symbolNodes.get(resolvedSymbol(checker, element)!) : undefined;
          if (!callbackDeclaration) {
            edges.push({ caller, kind: "callback-argument", unresolvedName: element.getText(), timing: "unknown", span: { start: element.getStart(), end: element.getEnd() }, arguments: [] });
            continue;
          }
          let invoked: ts.FunctionLikeDeclaration | undefined = callbackDeclaration;
          for (let depth = 0; invoked && depth <= event.returnDepth; depth += 1) {
            edges.push({ caller, callee: stableId(invoked), kind: "callback-argument", timing: event.timing === "sync" ? "inline" : "deferred", span: { start: element.getStart(), end: element.getEnd() }, ...callbackInstantiation(element, invoked), dischargesThrow: catchesThrow && event.timing === "sync" || event.completion === "convert-throw-to-rejection" });
            invoked = directlyReturnedCallable(invoked);
          }
        }
        for (const callback of resolvedBuiltin?.capturedCallbacks ?? []) {
          const callbackDeclaration = (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) ? callback
            : ts.isIdentifier(callback) ? symbolNodes.get(resolvedSymbol(checker, callback)!) : undefined;
          if (callbackDeclaration) {
            edges.push({
              caller,
              callee: stableId(callbackDeclaration),
              kind: "callback-argument",
              timing: "inline",
              span: { start: callback.getStart(), end: callback.getEnd() },
              arguments: [],
              dischargesThrow: catchesThrow,
            });
          } else {
            edges.push({
              caller,
              kind: "callback-argument",
              unresolvedName: callback.getText(),
              timing: "unknown",
              span: { start: callback.getStart(), end: callback.getEnd() },
              arguments: [],
            });
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, catchesThrow));
    };
    for (const parameter of declaration.parameters) {
      if (ts.isObjectBindingPattern(parameter.name)) {
        addObjectBindingGetterEdges(
          parameter.name,
          checker.getTypeAtLocation(parameter.name),
          { text: parameter.name.getText(), unresolvedAlias: true },
          false,
        );
      }
      visit(parameter.name, false);
      if (parameter.initializer) visit(parameter.initializer, false);
    }
    if (ts.isConstructorDeclaration(declaration)) {
      for (const member of declaration.parent.members) {
        if (ts.isPropertyDeclaration(member) && member.initializer
          && !member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)) {
          visit(member.initializer, false);
        }
      }
    }
    visit(declaration.body!, false);
    byId.get(caller)!.effectParameters = [...parameters].map(([name, index]) => ({ index, name, timing: timings.get(index) ?? "unknown" }));
  }
  return { nodes, edges };
}

export function instantiateCallbackEffects(node: CallGraphNode, argumentsByIndex: ReadonlyMap<number, readonly Effect[]>): InstantiatedCallbackEffects {
  const effects: Effect[] = [], statuses: InvocationTiming[] = [];
  for (const parameter of node.effectParameters) {
    effects.push(...(argumentsByIndex.get(parameter.index) ?? []));
    statuses.push(parameter.timing);
  }
  return { effects, suspends: statuses.includes("deferred"), evidence: statuses.includes("unknown") ? "unknown" : "inferred" };
}

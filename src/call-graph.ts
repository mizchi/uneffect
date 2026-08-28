import ts from "typescript";
import type { Effect } from "./capabilities.js";
import type { EvidenceStatus } from "./effects.js";
import { TypeScriptFrontendAdapter, type FrontendSymbolAdapter } from "./frontend-adapter.js";

export type CallableKind = "function" | "method" | "arrow" | "function-expression";
export type InvocationTiming = "inline" | "deferred" | "unknown";
export interface EffectParameter { index: number; name: string; timing: InvocationTiming }
export interface IteratorEffectParameter { index: number; name: string; convertsThrowToRejection: boolean }
export interface IteratorEffectInstantiation { consumer: string; parameterIndex: number }
export interface ExternalIteratorEffectContract { key: string; parameters: readonly IteratorEffectParameter[] }
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
  dischargesThrow?: boolean;
  executesBody?: boolean;
  unknownGeneratorConsumption?: boolean;
  unknownGeneratorParameterIndex?: number;
  dischargesUnknownGeneratorParameters?: boolean;
  /** A local object alias reached this call but could not be reduced to one non-escaping addressable root. */
  unresolvedMutationAlias?: boolean;
  /** Identifies the polymorphic iterator contract instantiated by this execution edge. */
  iteratorEffectInstantiation?: IteratorEffectInstantiation;
}
export interface ProgramCallGraph { nodes: CallGraphNode[]; edges: CallGraphEdge[] }
export interface InstantiatedCallbackEffects { effects: Effect[]; evidence: EvidenceStatus; suspends: boolean }

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
}
function callableName(node: ts.FunctionLikeDeclaration): ts.Node | undefined {
  if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name;
  return ts.isVariableDeclaration(node.parent) ? node.parent.name : undefined;
}
function kindOf(node: ts.FunctionLikeDeclaration): CallableKind {
  return ts.isMethodDeclaration(node) ? "method" : ts.isArrowFunction(node) ? "arrow" : ts.isFunctionExpression(node) ? "function-expression" : "function";
}
function stableId(node: ts.FunctionLikeDeclaration): string { return `${node.getSourceFile().fileName}:${node.getStart()}`; }
function isFunctionParameter(checker: ts.TypeChecker, parameter: ts.ParameterDeclaration): boolean { return checker.getTypeAtLocation(parameter).getCallSignatures().length > 0; }

function builtinTiming(call: ts.CallExpression, checker: ts.TypeChecker, adapter: FrontendSymbolAdapter, argumentIndex?: number): InvocationTiming {
  const operation = adapter.resolveCall(call)?.operation;
  if (operation?.kind === "timer" || operation?.kind === "scheduler-post-task" || operation?.kind === "scheduler-yield") return "deferred";
  if (operation?.kind === "fs" && operation.callbackQueue === "poll") return "deferred";
  if (operation?.kind === "deferred-callback") return "deferred";
  if (operation?.kind === "inline-callback") return argumentIndex !== undefined && operation.callbackArguments.includes(argumentIndex) ? "inline" : "unknown";
  const lookup = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  const symbol = resolvedSymbol(checker, lookup);
  if (symbol?.name === "catchAll" && symbol.declarations?.some((declaration) => declaration.getSourceFile().fileName.includes("/node_modules/effect/"))) return "deferred";
  const text = call.expression.getText();
  if (["setTimeout", "setInterval", "queueMicrotask"].includes(text)) return "deferred";
  if (text === "Array.from" || text === "JSON.stringify") return "inline";
  if (ts.isPropertyAccessExpression(call.expression) && ["map", "flatMap", "filter", "forEach", "reduce", "reduceRight", "some", "every", "find", "findIndex", "sort"].includes(call.expression.name.text)) return "inline";
  if (ts.isPropertyAccessExpression(call.expression) && ["then", "catch", "finally"].includes(call.expression.name.text)) return "deferred";
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

export function buildProgramCallGraph(
  program: ts.Program,
  options: { externalIteratorEffects?: ReadonlyMap<string, ExternalIteratorEffectContract> } = {},
): ProgramCallGraph {
  const checker = program.getTypeChecker(), adapter = new TypeScriptFrontendAdapter(program), declarations: ts.FunctionLikeDeclaration[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) declarations.push(node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const symbolNodes = new Map<ts.Symbol, ts.FunctionLikeDeclaration>();
  for (const declaration of declarations) {
    const name = callableName(declaration), symbol = name ? resolvedSymbol(checker, name) : undefined;
    if (symbol) symbolNodes.set(symbol, declaration);
  }
  const nodes = declarations.map((declaration): CallGraphNode => {
    const nameNode = callableName(declaration), symbol = nameNode ? resolvedSymbol(checker, nameNode) : undefined;
    const overloads = symbol?.declarations?.filter((item): item is ts.FunctionDeclaration | ts.MethodDeclaration => (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item)) && !item.body).map((item) => checker.signatureToString(checker.getSignatureFromDeclaration(item)!)) ?? [];
    return { id: stableId(declaration), name: nameNode?.getText() ?? "<anonymous>", kind: kindOf(declaration), fileName: declaration.getSourceFile().fileName, span: { start: declaration.getStart(), end: declaration.getEnd() }, overloads, effectParameters: [], iteratorEffectParameters: [] };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
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
    if (ts.isCallExpression(parent) && parent.arguments[0] === expression && isStandardLibraryCall(parent)) {
      return ["Array.from", "Object.fromEntries", "Promise.all", "Promise.allSettled", "Promise.any", "Promise.race"]
        .includes(parent.expression.getText());
    }
    if (ts.isNewExpression(parent) && parent.arguments?.[0] === expression && isStandardLibraryCall(parent)) {
      return ["Set", "Map", "WeakSet", "WeakMap", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
        "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"]
        .includes(parent.expression.getText());
    }
    return false;
  };
  const promiseIterableConsumerArgument = (parent: ts.Node, expression: ts.Expression): boolean =>
    ts.isCallExpression(parent) && parent.arguments[0] === expression && isStandardLibraryCall(parent)
    && ["Promise.all", "Promise.allSettled", "Promise.any", "Promise.race"].includes(parent.expression.getText());
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
    declaration.parameters.forEach((parameter, index) => {
      if (ts.isIdentifier(parameter.name)) {
        const symbol = resolvedSymbol(checker, parameter.name);
        if (symbol) parameterIndices.set(symbol, index);
      }
    });
    const consumed = new Map<number, boolean>();
    const record = (expression: ts.Expression, convertsThrowToRejection = false): void => {
      if (!ts.isIdentifier(expression)) return;
      const index = parameterIndices.get(resolvedSymbol(checker, expression)!);
      if (index === undefined || !checker.getPropertyOfType(checker.getTypeAtLocation(expression), "next")) return;
      const previous = consumed.get(index);
      consumed.set(index, previous === false ? false : convertsThrowToRejection);
    };
    const visit = (node: ts.Node): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isForOfStatement(node)) record(node.expression);
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) record(node.expression);
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
      index, name: declaration.parameters[index]!.name.getText(), convertsThrowToRejection,
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
    const refinementActionOwner = /\buneffect\s*:\s*refinement\s+[^\s]+\s+action\s+[^\s*]+/i.test(leading);
    const iteratorParameterIndices = new Map<ts.Symbol, number>();
    type IteratorBindingState = { generators: ts.FunctionLikeDeclaration[]; unknown: boolean; pure: boolean };
    const generatorBindings = new Map<ts.Symbol, ts.FunctionLikeDeclaration[]>(), unknownGeneratorBindings = new Set<ts.Symbol>(), pureIteratorBindings = new Set<ts.Symbol>();
    const iteratorSlots = new Map<ts.Symbol, Map<string, IteratorBindingState>>();
    const objectAliases = new Map<ts.Symbol, ts.Symbol>();
    declaration.parameters.forEach((parameter, index) => { if (ts.isIdentifier(parameter.name) && isFunctionParameter(checker, parameter)) parameters.set(parameter.name.text, index); });
    declaration.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const symbol = resolvedSymbol(checker, parameter.name);
      if (symbol) iteratorParameterIndices.set(symbol, index);
    });
    const timings = new Map<number, InvocationTiming>();
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
      const symbol = resolvedSymbol(checker, argument);
      const binding = symbol?.declarations?.find((candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name));
      if (!symbol || !binding?.initializer || !ts.isVariableDeclarationList(binding.parent)
        || (binding.parent.flags & ts.NodeFlags.Const) === 0
        || (checker.getTypeAtLocation(argument).flags & ts.TypeFlags.Object) === 0) {
        return { text: argument.getText(), unresolvedAlias: false };
      }
      const initializer = binding.initializer;
      const addressable = ts.isIdentifier(initializer) || ts.isPropertyAccessExpression(initializer);
      if (!addressable) return { text: argument.getText(), unresolvedAlias: true };
      let owner: ts.Node | undefined = binding;
      while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (!owner) return { text: argument.getText(), unresolvedAlias: true };
      let escaped = false;
      const inspect = (node: ts.Node): void => {
        if (escaped || node !== owner && ts.isFunctionLike(node)) return;
        if (ts.isIdentifier(node) && resolvedSymbol(checker, node) === symbol
          && node !== binding.name && node !== argument) { escaped = true; return; }
        ts.forEachChild(node, inspect);
      };
      inspect(owner);
      return escaped
        ? { text: argument.getText(), unresolvedAlias: true }
        : { text: initializer.getText(), unresolvedAlias: false };
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
      if (ts.isForOfStatement(node)) consumeStoredOrUnknown(node.expression);
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) consumeStoredOrUnknown(node.expression);
      if (ts.isSpreadElement(node)) consumeStoredOrUnknown(node.expression);
      if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer) consumeStoredOrUnknown(node.initializer);
      if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments?.[0]
        && iterableConsumerArgument(node, node.arguments[0])) consumeStoredOrUnknown(
          node.arguments[0], promiseIterableConsumerArgument(node, node.arguments[0]),
        );
      if (ts.isCallExpression(node)) {
        const resolvedBuiltin = adapter.resolveCall(node);
        for (const argument of node.arguments) invalidateObjectSlots(argument);
        if (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)) {
          invalidateObjectSlots(node.expression.expression);
        }
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const symbol = resolvedSymbol(checker, lookup), targetDeclaration = symbol ? symbolNodes.get(symbol) : undefined;
        const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
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
        const unknownGeneratorConsumption = consumptionSyntax && !returnedGenerators
          && isOpaqueIteratorCall(node);
        const externalIterator = targetDeclaration ? undefined
          : externalIteratorContractForCall(checker, node, options.externalIteratorEffects);
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
        edges.push({ caller, callee: targetDeclaration ? stableId(targetDeclaration) : undefined, unresolvedName: targetDeclaration || parameterIndex !== undefined ? undefined : node.expression.getText(), kind: parameterIndex !== undefined ? "callback-parameter" : "direct", timing: "inline", overloadIndex: overloadIndex !== undefined && overloadIndex >= 0 ? overloadIndex : undefined, span: { start: node.getStart(), end: node.getEnd() }, arguments: instantiatedArguments.map(({ text }) => text), dischargesThrow: catchesThrow || (convertsThrowToRejection && Boolean(targetDeclaration?.asteriskToken)), executesBody: targetDeclaration?.asteriskToken ? generatorConsumption : true, unknownGeneratorConsumption, dischargesUnknownGeneratorParameters, ...(refinementActionOwner && instantiatedArguments.some(({ unresolvedAlias }) => unresolvedAlias) ? { unresolvedMutationAlias: true } : {}) });
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
          const parameterIndex = ts.isIdentifier(argument) ? parameters.get(argument.text) : undefined;
          if (parameterIndex !== undefined) {
            const previous = timings.get(parameterIndex);
            const timing = targetDeclaration === declaration
              ? previous ?? "unknown"
              : targetDeclaration
                ? byId.get(stableId(targetDeclaration))?.effectParameters.find((item) => item.index === index)?.timing ?? "unknown"
                : builtinTiming(node, checker, adapter, index);
            const joined: InvocationTiming = previous === "unknown" || timing === "unknown" ? "unknown" : previous === "deferred" || timing === "deferred" ? "deferred" : "inline";
            timings.set(parameterIndex, joined);
            edges.push({ caller, kind: "callback-argument", unresolvedName: argument.getText(), timing, span: { start: argument.getStart(), end: argument.getEnd() }, arguments: [] });
          }
          const callbackDeclaration = (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) ? argument
            : ts.isIdentifier(argument) ? symbolNodes.get(resolvedSymbol(checker, argument)!) : undefined;
          if (callbackDeclaration) {
            const calleeNode = targetDeclaration ? byId.get(stableId(targetDeclaration)) : undefined;
            const timing = calleeNode?.effectParameters.find((item) => item.index === index)?.timing ?? builtinTiming(node, checker, adapter, index);
            edges.push({ caller, callee: stableId(callbackDeclaration), kind: "callback-argument", timing, span: { start: argument.getStart(), end: argument.getEnd() }, arguments: [], dischargesThrow: catchesThrow && timing === "inline" });
          }
        });
        if (resolvedBuiltin?.operation?.kind === "inline-callback") {
          for (const index of resolvedBuiltin.operation.callbackArrayArguments ?? []) {
            const argument = node.arguments[index];
            const elements = argument && ts.isArrayLiteralExpression(argument)
              ? argument.elements.filter(ts.isExpression) : undefined;
            if (!elements) {
              edges.push({ caller, kind: "callback-argument", unresolvedName: argument?.getText() ?? `<argument ${index}>`, timing: "unknown", span: { start: argument?.getStart() ?? node.getStart(), end: argument?.getEnd() ?? node.getEnd() }, arguments: [] });
              continue;
            }
            for (const element of elements) {
              const callbackDeclaration = (ts.isArrowFunction(element) || ts.isFunctionExpression(element)) ? element
                : ts.isIdentifier(element) ? symbolNodes.get(resolvedSymbol(checker, element)!) : undefined;
              if (!callbackDeclaration) {
                edges.push({ caller, kind: "callback-argument", unresolvedName: element.getText(), timing: "unknown", span: { start: element.getStart(), end: element.getEnd() }, arguments: [] });
                continue;
              }
              let invoked: ts.FunctionLikeDeclaration | undefined = callbackDeclaration;
              for (let depth = 0; invoked && depth <= (resolvedBuiltin.operation.callbackArrayReturnDepth ?? 0); depth += 1) {
                edges.push({ caller, callee: stableId(invoked), kind: "callback-argument", timing: "inline", span: { start: element.getStart(), end: element.getEnd() }, arguments: [], dischargesThrow: catchesThrow });
                invoked = directlyReturnedCallable(invoked);
              }
            }
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

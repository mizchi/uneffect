import ts from "typescript";
import type { Effect } from "./capabilities.js";
import type { EvidenceStatus } from "./effects.js";
import { TypeScriptFrontendAdapter, type FrontendSymbolAdapter } from "./frontend-adapter.js";

export type CallableKind = "function" | "method" | "arrow" | "function-expression";
export type InvocationTiming = "inline" | "deferred" | "unknown";
export interface EffectParameter { index: number; name: string; timing: InvocationTiming }
export interface CallGraphNode {
  id: string;
  name: string;
  kind: CallableKind;
  fileName: string;
  span: { start: number; end: number };
  overloads: string[];
  effectParameters: EffectParameter[];
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

function builtinTiming(call: ts.CallExpression, checker: ts.TypeChecker, adapter: FrontendSymbolAdapter): InvocationTiming {
  const operation = adapter.resolveCall(call)?.operation;
  if (operation?.kind === "timer" || operation?.kind === "scheduler-post-task" || operation?.kind === "scheduler-yield") return "deferred";
  if (operation?.kind === "fs" && operation.callbackQueue === "poll") return "deferred";
  const lookup = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  const symbol = resolvedSymbol(checker, lookup);
  if (symbol?.name === "catchAll" && symbol.declarations?.some((declaration) => declaration.getSourceFile().fileName.includes("/node_modules/effect/"))) return "deferred";
  const text = call.expression.getText();
  if (["setTimeout", "setInterval", "queueMicrotask"].includes(text)) return "deferred";
  if (text === "Array.from" || text === "JSON.stringify") return "inline";
  if (ts.isPropertyAccessExpression(call.expression) && ["map", "flatMap", "filter", "forEach", "reduce", "reduceRight", "some", "every", "find", "findIndex", "sort", "forEachChild"].includes(call.expression.name.text)) return "inline";
  if (ts.isPropertyAccessExpression(call.expression) && ["then", "catch", "finally"].includes(call.expression.name.text)) return "deferred";
  return "unknown";
}

export function buildProgramCallGraph(program: ts.Program): ProgramCallGraph {
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
    return { id: stableId(declaration), name: nameNode?.getText() ?? "<anonymous>", kind: kindOf(declaration), fileName: declaration.getSourceFile().fileName, span: { start: declaration.getStart(), end: declaration.getEnd() }, overloads, effectParameters: [] };
  });
  const byId = new Map(nodes.map((node) => [node.id, node]));
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
  const edges: CallGraphEdge[] = [];
  for (const declaration of declarations) {
    const caller = stableId(declaration), parameters = new Map<string, number>();
    const generatorBindings = new Map<ts.Symbol, ts.FunctionLikeDeclaration[]>(), unknownGeneratorBindings = new Set<ts.Symbol>();
    declaration.parameters.forEach((parameter, index) => { if (ts.isIdentifier(parameter.name) && isFunctionParameter(checker, parameter)) parameters.set(parameter.name.text, index); });
    const timings = new Map<number, InvocationTiming>();
    const visit = (node: ts.Node, catchesThrow: boolean): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isTryStatement(node)) {
        visit(node.tryBlock, catchesThrow || node.catchClause !== undefined);
        if (node.catchClause) visit(node.catchClause.block, catchesThrow);
        if (node.finallyBlock) visit(node.finallyBlock, catchesThrow);
        return;
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const lookup = ts.isPropertyAccessExpression(node.initializer.expression) ? node.initializer.expression.name : node.initializer.expression;
        const target = symbolNodes.get(resolvedSymbol(checker, lookup)!);
        const binding = resolvedSymbol(checker, node.name);
        const generators = returnedGeneratorDeclarations(target);
        if (binding && generators) generatorBindings.set(binding, generators);
        else if (binding && isOpaqueIteratorCall(node.initializer)) unknownGeneratorBindings.add(binding);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)
        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
        const source = generatorBindings.get(resolvedSymbol(checker, node.initializer)!);
        const unknownSource = unknownGeneratorBindings.has(resolvedSymbol(checker, node.initializer)!);
        const binding = resolvedSymbol(checker, node.name);
        if (binding && source) generatorBindings.set(binding, source);
        if (binding && unknownSource) unknownGeneratorBindings.add(binding);
      }
      const addStoredGeneratorConsumption = (expression: ts.Expression): void => {
        if (!ts.isIdentifier(expression)) return;
        const binding = resolvedSymbol(checker, expression)!;
        const targets = generatorBindings.get(binding);
        for (const target of targets ?? []) edges.push({ caller, callee: stableId(target), kind: "direct", timing: "inline", span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [], dischargesThrow: catchesThrow, executesBody: true });
        if (unknownGeneratorBindings.has(binding)) edges.push({ caller, kind: "direct", timing: "inline", span: { start: expression.getStart(), end: expression.getEnd() }, arguments: [], dischargesThrow: catchesThrow, executesBody: true, unknownGeneratorConsumption: true });
      };
      if (ts.isForOfStatement(node)) addStoredGeneratorConsumption(node.expression);
      if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) addStoredGeneratorConsumption(node.expression);
      if (ts.isSpreadElement(node)) addStoredGeneratorConsumption(node.expression);
      if (ts.isCallExpression(node)) {
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
          || (ts.isCallExpression(node.parent) && node.parent.expression.getText() === "Array.from" && node.parent.arguments[0] === node)
        );
        const generatorConsumption = Boolean(targetDeclaration?.asteriskToken) && consumptionSyntax;
        const returnedGenerators = consumptionSyntax ? returnedGeneratorDeclarations(targetDeclaration) : undefined;
        const unknownGeneratorConsumption = consumptionSyntax && !returnedGenerators
          && isOpaqueIteratorCall(node);
        edges.push({ caller, callee: targetDeclaration ? stableId(targetDeclaration) : undefined, unresolvedName: targetDeclaration || parameterIndex !== undefined ? undefined : node.expression.getText(), kind: parameterIndex !== undefined ? "callback-parameter" : "direct", timing: "inline", overloadIndex: overloadIndex !== undefined && overloadIndex >= 0 ? overloadIndex : undefined, span: { start: node.getStart(), end: node.getEnd() }, arguments: node.arguments.map((argument) => argument.getText()), dischargesThrow: catchesThrow, executesBody: targetDeclaration?.asteriskToken ? generatorConsumption : true, unknownGeneratorConsumption });
        for (const returnedGenerator of returnedGenerators ?? []) if (returnedGenerator !== targetDeclaration) edges.push({ caller, callee: stableId(returnedGenerator), kind: "direct", timing: "inline", span: { start: node.getStart(), end: node.getEnd() }, arguments: [], dischargesThrow: catchesThrow, executesBody: true });
        if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "next") addStoredGeneratorConsumption(node.expression.expression);
        if (node.expression.getText() === "Array.from" && node.arguments[0]) addStoredGeneratorConsumption(node.arguments[0]);
        if (parameterIndex !== undefined) timings.set(parameterIndex, "inline");
        node.arguments.forEach((argument, index) => {
          const parameterIndex = ts.isIdentifier(argument) ? parameters.get(argument.text) : undefined;
          if (parameterIndex !== undefined) {
            const previous = timings.get(parameterIndex);
            const timing = targetDeclaration === declaration
              ? previous ?? "unknown"
              : targetDeclaration
                ? byId.get(stableId(targetDeclaration))?.effectParameters.find((item) => item.index === index)?.timing ?? "unknown"
                : builtinTiming(node, checker, adapter);
            const joined: InvocationTiming = previous === "unknown" || timing === "unknown" ? "unknown" : previous === "deferred" || timing === "deferred" ? "deferred" : "inline";
            timings.set(parameterIndex, joined);
            edges.push({ caller, kind: "callback-argument", unresolvedName: argument.getText(), timing, span: { start: argument.getStart(), end: argument.getEnd() }, arguments: [] });
          }
          const callbackDeclaration = (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) ? argument
            : ts.isIdentifier(argument) ? symbolNodes.get(resolvedSymbol(checker, argument)!) : undefined;
          if (callbackDeclaration) {
            const calleeNode = targetDeclaration ? byId.get(stableId(targetDeclaration)) : undefined;
            const timing = calleeNode?.effectParameters.find((item) => item.index === index)?.timing ?? builtinTiming(node, checker, adapter);
            edges.push({ caller, callee: stableId(callbackDeclaration), kind: "callback-argument", timing, span: { start: argument.getStart(), end: argument.getEnd() }, arguments: [], dischargesThrow: catchesThrow && timing === "inline" });
          }
        });
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

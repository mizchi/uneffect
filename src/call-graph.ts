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
  const edges: CallGraphEdge[] = [];
  for (const declaration of declarations) {
    const caller = stableId(declaration), parameters = new Map<string, number>();
    declaration.parameters.forEach((parameter, index) => { if (ts.isIdentifier(parameter.name) && isFunctionParameter(checker, parameter)) parameters.set(parameter.name.text, index); });
    const timings = new Map<number, InvocationTiming>();
    const visit = (node: ts.Node): void => {
      if (node !== declaration && ts.isFunctionLike(node)) return;
      if (ts.isCallExpression(node)) {
        const lookup = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
        const symbol = resolvedSymbol(checker, lookup), targetDeclaration = symbol ? symbolNodes.get(symbol) : undefined;
        const signatureDeclaration = checker.getResolvedSignature(node)?.declaration;
        const overloadIndex = symbol && signatureDeclaration ? symbol.declarations?.filter((item) => (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item)) && !item.body).indexOf(signatureDeclaration) : -1;
        const parameterIndex = ts.isIdentifier(node.expression) ? parameters.get(node.expression.text) : undefined;
        edges.push({ caller, callee: targetDeclaration ? stableId(targetDeclaration) : undefined, unresolvedName: targetDeclaration || parameterIndex !== undefined ? undefined : node.expression.getText(), kind: parameterIndex !== undefined ? "callback-parameter" : "direct", timing: "inline", overloadIndex: overloadIndex !== undefined && overloadIndex >= 0 ? overloadIndex : undefined, span: { start: node.getStart(), end: node.getEnd() }, arguments: node.arguments.map((argument) => argument.getText()) });
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
            edges.push({ caller, callee: stableId(callbackDeclaration), kind: "callback-argument", timing, span: { start: argument.getStart(), end: argument.getEnd() }, arguments: [] });
          }
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration.body!);
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

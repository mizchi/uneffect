import ts from "@typescript/typescript6";
import { createHash } from "node:crypto";
import { functionMayFallThrough, type ContractControlFlowOptions } from "./contract-control-flow.js";
import { resolveStableCallableSymbol, stableCallableDeclaration } from "./stable-callable.js";
import {
  typescriptControlFlowSchema,
  typescriptControlFlowExclusionReasons,
  typescriptControlFlowSourceDigest,
  type TypeScriptControlFlowAnalysis,
  type TypeScriptControlFlowExclusion,
  type TypeScriptControlFlowSource,
  type TypeScriptFunctionControlFlow,
  type TypeScriptFunctionEndpoint,
} from "./typescript-control-flow-contract.js";

export {
  parseTypeScriptControlFlowAnalysis,
  typescriptControlFlowSchema,
} from "./typescript-control-flow-contract.js";
export type {
  TypeScriptControlFlowAnalysis,
  TypeScriptControlFlowCoverage,
  TypeScriptControlFlowDiagnosticCode,
  TypeScriptControlFlowExclusion,
  TypeScriptControlFlowExclusionReason,
  TypeScriptControlFlowSource,
  TypeScriptFunctionControlFlow,
  TypeScriptFunctionEndpoint,
} from "./typescript-control-flow-contract.js";

export interface TypeScriptControlFlowBridge {
  analysis: TypeScriptControlFlowAnalysis;
  options: ContractControlFlowOptions;
  endpointOf(node: ts.FunctionLikeDeclaration): TypeScriptFunctionEndpoint;
  resolveStableCallable(expression: ts.Expression): SupportedFunction | undefined;
}

const fallthroughDiagnosticCodes = new Set([2366, 7030]);

function createProgram(fileName: string, source: ts.SourceFile): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noImplicitReturns: true,
    allowUnreachableCode: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options), defaultGetSourceFile = host.getSourceFile.bind(host);
  const resolvedFileName = ts.sys.resolvePath(fileName);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) =>
    ts.sys.resolvePath(requested) === resolvedFileName ? source : defaultGetSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile);
  return ts.createProgram({ rootNames: [fileName], options, host });
}

type SupportedFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function ownValueReturns(node: SupportedFunction): number {
  let count = 0;
  const visit = (current: ts.Node): void => {
    if (current !== node && ts.isFunctionLike(current)) return;
    if (ts.isReturnStatement(current) && current.expression) count += 1;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return count;
}

function internalFlowObservation(node: SupportedFunction): { status: "observed" | "unavailable"; count: number } {
  let count = 0;
  const canHaveFlowNode = (ts as unknown as { canHaveFlowNode?: (node: ts.Node) => boolean }).canHaveFlowNode;
  if (!canHaveFlowNode) return { status: "unavailable", count };
  const visit = (current: ts.Node): void => {
    if (canHaveFlowNode(current) && (current as ts.Node & { flowNode?: unknown }).flowNode !== undefined) count += 1;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return { status: "observed", count };
}

function resolveStableCallableWithChecker(checker: ts.TypeChecker, expression: ts.Expression): SupportedFunction | undefined {
  const symbol = resolveStableCallableSymbol(checker, expression);
  const declaration = symbol && stableCallableDeclaration(symbol);
  return declaration && (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)
    || ts.isArrowFunction(declaration) || ts.isFunctionExpression(declaration)) && declaration.body
    ? declaration : undefined;
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  const expression = name.expression;
  return ts.isStringLiteral(expression) || ts.isNumericLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression) ? expression.text : undefined;
}

function supportedFunctions(source: ts.SourceFile): Array<{ node: SupportedFunction; name: string; kind: TypeScriptFunctionControlFlow["kind"]; immutable: boolean; stableName: boolean }> {
  const result: Array<{ node: SupportedFunction; name: string; kind: TypeScriptFunctionControlFlow["kind"]; immutable: boolean; stableName: boolean }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.body) result.push({ node, name: node.name?.text ?? "<anonymous>", kind: "function", immutable: true, stableName: true });
    else if (ts.isMethodDeclaration(node) && node.body) {
      const owner = ts.isClassLike(node.parent) && node.parent.name ? `${node.parent.name.text}.` : "";
      const name = staticPropertyName(node.name);
      result.push({ node, name: `${owner}${name ?? "<computed>"}`, kind: "method", immutable: true, stableName: name !== undefined });
    } else if ((ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) {
      const owner = ts.isClassLike(node.parent) && node.parent.name ? `${node.parent.name.text}.` : "";
      const name = staticPropertyName(node.name);
      result.push({ node, name: `${owner}${name ?? "<computed>"}`, kind: ts.isGetAccessorDeclaration(node) ? "getter" : "setter", immutable: true, stableName: name !== undefined });
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
      const declarationList = node.parent.parent;
      const immutable = ts.isVariableDeclarationList(declarationList) && (declarationList.flags & ts.NodeFlags.Const) !== 0;
      result.push({ node, name: node.parent.name.text, kind: ts.isArrowFunction(node) ? "arrow" : "function-expression", immutable, stableName: true });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const direct = new Map(result.filter((item) => item.kind === "arrow" || item.kind === "function-expression").map((item) => [item.name, item]));
  const aliases = new Map<string, { target: string; immutable: boolean }>();
  for (const statement of source.statements) if (ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1) {
    const declaration = statement.declarationList.declarations[0]!;
    if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer)) aliases.set(declaration.name.text, {
      target: declaration.initializer.text,
      immutable: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
    });
  }
  const resolve = (name: string, seen = new Set<string>()): typeof result[number] | undefined => {
    if (seen.has(name)) return undefined;
    const target = direct.get(name);
    if (target) return target;
    const alias = aliases.get(name);
    if (!alias?.immutable) return undefined;
    return resolve(alias.target, new Set([...seen, name]));
  };
  for (const name of aliases.keys()) {
    const target = resolve(name);
    if (target) (target as typeof target & { aliases?: string[] }).aliases = [...((target as typeof target & { aliases?: string[] }).aliases ?? []), name];
  }
  return result;
}

function analyzeWithProgram(program: ts.Program, sources: readonly ts.SourceFile[], programReused: boolean): { analysis: TypeScriptControlFlowAnalysis; byNode: Map<ts.FunctionLikeDeclaration, TypeScriptFunctionControlFlow> } {
  const byNode = new Map<ts.FunctionLikeDeclaration, TypeScriptFunctionControlFlow>();
  const checker = program.getTypeChecker();
  const programOptions = program.getCompilerOptions();
  const configurationCompatible = programOptions.noImplicitReturns === true;
  for (const source of sources) {
    const diagnostics = program.getSemanticDiagnostics(source);
    for (const candidate of supportedFunctions(source)) {
      const { node } = candidate;
      const contained = diagnostics.filter((diagnostic) => diagnostic.start !== undefined && diagnostic.start >= node.getFullStart() && diagnostic.start < node.end);
      const diagnosticCodes: TypeScriptFunctionControlFlow["diagnosticCodes"] = [...new Set(contained.map((diagnostic) => diagnostic.code))].sort((left, right) => Number(left) - Number(right));
      if (!candidate.immutable) diagnosticCodes.push("uneffect-mutable-binding");
      if (!candidate.stableName) diagnosticCodes.push("uneffect-dynamic-computed-name");
      if (!configurationCompatible) diagnosticCodes.push("uneffect-incompatible-compiler-options");
      const endpoint: TypeScriptFunctionEndpoint = !configurationCompatible || !candidate.immutable || !candidate.stableName ? "unknown" : diagnosticCodes.some((code) => typeof code === "number" && fallthroughDiagnosticCodes.has(code))
        ? "reachable"
        : contained.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
          ? "unknown"
          : ts.isArrowFunction(node) && !ts.isBlock(node.body) || ownValueReturns(node) > 0 ? "unreachable" : "unknown";
      const neutralEndpoint = ts.isArrowFunction(node) && !ts.isBlock(node.body) ? "unreachable" : functionMayFallThrough(node.body as ts.Block) ? "reachable" : "unreachable";
      const internalFlow = internalFlowObservation(node);
      byNode.set(node, {
        fileName: source.fileName,
        name: candidate.name,
        kind: candidate.kind,
        span: { start: node.getStart(source), end: node.end },
        endpoint,
        neutralEndpoint,
        parity: endpoint === "unknown" ? "unknown" : endpoint === neutralEndpoint ? "agree" : "typescript-refines",
        evidence: "public-diagnostics",
        diagnosticCodes,
        internalFlowApi: internalFlow.status,
        internalFlowNodeCount: internalFlow.count,
        aliases: [...((candidate as typeof candidate & { aliases?: string[] }).aliases ?? [])],
      });
    }
  }
  for (const source of sources) {
    const visitAlias = (current: ts.Node): void => {
      if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name) && current.initializer
        && (ts.isIdentifier(current.initializer) || ts.isPropertyAccessExpression(current.initializer) || ts.isElementAccessExpression(current.initializer))) {
        const target = resolveStableCallableWithChecker(checker, current.initializer), summary = target && byNode.get(target);
        if (summary && !summary.aliases.includes(current.name.text)) summary.aliases.push(current.name.text);
      }
      ts.forEachChild(current, visitAlias);
    };
    visitAlias(source);
  }
  const sourceEvidence: TypeScriptControlFlowSource[] = sources.map((source) => ({
    fileName: source.fileName,
    length: source.text.length,
    digest: createHash("sha256").update(source.text).digest("hex"),
  })).sort((left, right) => left.fileName.localeCompare(right.fileName));
  const functions = [...byNode.values()].sort((left, right) => left.fileName.localeCompare(right.fileName)
    || left.span.start - right.span.start || left.span.end - right.span.end || left.kind.localeCompare(right.kind));
  const unknown = functions.filter((summary) => summary.endpoint === "unknown");
  const exclusions: TypeScriptControlFlowExclusion[] = unknown.map((summary) => ({
    fileName: summary.fileName,
    functionName: summary.name,
    span: summary.span,
    reasons: typescriptControlFlowExclusionReasons(summary),
  }));
  return { analysis: {
      schema: typescriptControlFlowSchema,
      typescriptVersion: ts.version,
      sourceDigest: typescriptControlFlowSourceDigest(sourceEvidence),
      sources: sourceEvidence,
      compilerOptions: {
        strict: programOptions.strict === true,
        noImplicitReturns: programOptions.noImplicitReturns === true,
        allowUnreachableCode: programOptions.allowUnreachableCode === true,
      },
      configurationCompatible,
      programReused,
      coverage: {
        domain: "function-endpoints",
        status: functions.length === 0 ? "not-applicable" : unknown.length === 0 ? "complete" : "partial",
        observed: functions.length,
        supported: functions.length - unknown.length,
        unknown: unknown.length,
      },
      exclusions,
      functions,
    }, byNode };
}

export function analyzeTypeScriptProgramControlFlow(program: ts.Program, sources: readonly ts.SourceFile[] = program.getSourceFiles().filter((source) => !source.isDeclarationFile)): TypeScriptControlFlowAnalysis {
  return analyzeWithProgram(program, sources, true).analysis;
}

export function createTypeScriptControlFlowBridge(fileName: string, source: ts.SourceFile, existingProgram?: ts.Program): TypeScriptControlFlowBridge {
  const program = existingProgram ?? createProgram(fileName, source), checker = program.getTypeChecker();
  const programSource = existingProgram?.getSourceFile(source.fileName) ?? source;
  const { analysis, byNode } = analyzeWithProgram(program, [programSource], existingProgram !== undefined);
  const resolveStableCallable = (expression: ts.Expression): SupportedFunction | undefined => resolveStableCallableWithChecker(checker, expression);
  return {
    analysis,
    options: {
      isNeverCall: (call) => {
        const signature = checker.getResolvedSignature(call);
        return signature !== undefined && (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Never) !== 0;
      },
      constantBoolean: (expression) => {
        const type = checker.getTypeAtLocation(expression);
        if ((type.flags & ts.TypeFlags.BooleanLiteral) === 0) return undefined;
        return checker.typeToString(type) === "true";
      },
    },
    endpointOf: (node) => byNode.get(node)?.endpoint ?? "unknown",
    resolveStableCallable,
  };
}

export function analyzeTypeScriptControlFlow(fileName: string, text: string): TypeScriptControlFlowAnalysis {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return createTypeScriptControlFlowBridge(fileName, source).analysis;
}

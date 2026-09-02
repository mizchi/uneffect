import ts from "typescript";
import { extractLocatedAnnotations } from "./annotations.js";
import { resolveRegionIdentity } from "./region-alias.js";
import {
  evaluateResourceProtocolCfg,
  instantiateResourceCallableSummary,
  type ResourceCallableOperation,
  type ResourceCallableReference,
  type ResourceCallableSummary,
  type ResourceProtocolResource,
  type ResourceProtocolState,
  type ResourceProtocolTransition,
} from "./resource-protocol.js";
import { lowerResourceProtocolCfgInFunction, type ResourceTransitionSite } from "./resource-protocol-typescript.js";

type SupportedFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.MethodSignature
  | ts.CallSignatureDeclaration | ts.ArrowFunction | ts.FunctionExpression;

export interface ResourceCallableDiagnostic {
  readonly code: "invalid-resource-reference" | "invalid-resource-acquire" | "invalid-resource-receiver" | "invalid-resource-transfer" | "unresolved-resource-binding";
  readonly fileName: string;
  readonly message: string;
  readonly span: { readonly start: number; readonly end: number };
}

export interface ResourceCallableSummaryAnalysis {
  readonly summaries: readonly ResourceCallableSummary[];
  readonly diagnostics: readonly ResourceCallableDiagnostic[];
}

export interface ResourceCallableSiteAnalysis {
  readonly resources: readonly ResourceProtocolResource[];
  readonly sites: readonly ResourceTransitionSite[];
  readonly diagnostics: readonly ResourceCallableDiagnostic[];
}

export interface ResourceLifecycleEvidence {
  readonly fileName: string;
  readonly owner: string;
  readonly resource: string;
  readonly kind: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly status: "satisfied" | "unsatisfied" | "unknown";
  readonly evidence: "verified" | "trusted" | "unknown";
  readonly state: ResourceProtocolState;
  readonly transitions: readonly ResourceProtocolTransition[];
}

export interface ResourceLifecycleDiagnostic {
  readonly kind: "invalid-contract" | "unclosed" | "invalid-transition" | "unknown-analysis";
  readonly fileName: string;
  readonly functionName: string;
  readonly span: { readonly start: number; readonly end: number };
  readonly resource: string;
  readonly state: ResourceProtocolState;
  readonly message: string;
}

export interface ResourceLifecycleProgramAnalysis {
  readonly evidence: readonly ResourceLifecycleEvidence[];
  readonly diagnostics: readonly ResourceLifecycleDiagnostic[];
}

function resolvedSymbol(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function annotationOwner(node: SupportedFunction): ts.Node {
  const parent = node.parent;
  if (!(ts.isArrowFunction(node) || ts.isFunctionExpression(node)) || !parent || !ts.isVariableDeclaration(parent)) return node;
  const declarationList = parent.parent;
  const statement = declarationList?.parent;
  return declarationList && ts.isVariableDeclarationList(declarationList) && statement && ts.isVariableStatement(statement)
    ? statement : node;
}

function reference(text: string, declaration: SupportedFunction): ResourceCallableReference | undefined {
  if (text === "return") return { kind: "return" };
  if (text === "this") return { kind: "receiver" };
  const index = declaration.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === text);
  return index < 0 ? undefined : { kind: "parameter", index, name: text };
}

/** Extracts declared resource-boundary contracts. Declarations are trusted, not verified. */
export function analyzeResourceCallableSummaries(program: ts.Program): ResourceCallableSummaryAnalysis {
  const summaries: ResourceCallableSummary[] = [];
  const diagnostics: ResourceCallableDiagnostic[] = [];
  const roots = new Set(program.getRootFileNames().map((fileName) => program.getSourceFile(fileName)).filter((candidate): candidate is ts.SourceFile => !!candidate));
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile && !roots.has(source)) continue;
    if (!source.text.includes("uneffect:")) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isMethodSignature(node)
        || ts.isCallSignatureDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
        const owner = annotationOwner(node);
        const leadingStart = owner.getFullStart();
        const leading = source.text.slice(leadingStart, owner.getStart(source));
        const operations: ResourceCallableOperation[] = [];
        for (const kind of ["acquire", "use", "borrow", "consume", "release", "transfer", "escape"] as const) {
          for (const annotation of extractLocatedAnnotations(leading, kind, leadingStart)) {
            const parts = kind === "transfer" ? /^([^\s]+)\s*->\s*([^\s]+)$/u.exec(annotation.value) : undefined;
            const subjectText = parts?.[1] ?? annotation.value.trim();
            const targetText = parts?.[2];
            const subject = reference(subjectText, node);
            const target = targetText ? reference(targetText, node) : undefined;
            if (!subject) {
              diagnostics.push({ code: "invalid-resource-reference", fileName: source.fileName,
                message: `unknown resource parameter ${subjectText}`, span: annotation.span });
              continue;
            }
            if ((subject.kind === "receiver" || target?.kind === "receiver")
              && !ts.isMethodDeclaration(node) && !ts.isMethodSignature(node)) {
              diagnostics.push({ code: "invalid-resource-receiver", fileName: source.fileName,
                message: "`this` resource references require a method declaration or signature", span: annotation.span });
              continue;
            }
            if (kind === "acquire" && subject.kind !== "return") {
              diagnostics.push({ code: "invalid-resource-acquire", fileName: source.fileName,
                message: "acquire must introduce the callable `return` resource", span: annotation.span });
              continue;
            }
            if (kind === "transfer" && (!parts || !target)) {
              diagnostics.push({ code: "invalid-resource-transfer", fileName: source.fileName,
                message: `transfer must be \`parameter -> parameter|return\``, span: annotation.span });
              continue;
            }
            operations.push({ kind, subject, ...(target ? { target } : {}) });
          }
        }
        if (operations.length > 0) summaries.push({
          schema: "uneffect-resource-callable-summary/v1",
          id: `${source.fileName}:${node.getStart(source)}`,
          evidence: "trusted",
          operations,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { summaries, diagnostics };
}

function resultDeclaration(call: ts.CallExpression): ts.VariableDeclaration | undefined {
  let current: ts.Expression = call;
  while ((ts.isParenthesizedExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)
    || ts.isAwaitExpression(current.parent)) && current.parent.expression === current) current = current.parent;
  const parent = current.parent;
  return ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name) ? parent : undefined;
}

function returnedResourceId(call: ts.CallExpression): string | undefined {
  const declaration = resultDeclaration(call);
  return declaration ? `region:${declaration.getSourceFile().fileName}:${declaration.getStart()}` : undefined;
}

function resourceArgumentId(checker: ts.TypeChecker, input: ts.Expression): string | undefined {
  const visit = (expression: ts.Expression, seen: ReadonlySet<ts.Symbol>): string | undefined => {
    while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
    if (ts.isIdentifier(expression)) {
      const symbol = resolvedSymbol(checker, expression);
      const declaration = symbol?.declarations?.find((candidate): candidate is ts.VariableDeclaration =>
        ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name));
      if (symbol && declaration) {
        const flags = ts.isVariableDeclarationList(declaration.parent) ? ts.getCombinedNodeFlags(declaration.parent) : 0;
        const immutable = (flags & ts.NodeFlags.Const) !== 0 || (flags & ts.NodeFlags.Using) === ts.NodeFlags.Using;
        if (seen.has(symbol) || !ts.isVariableDeclarationList(declaration.parent)
          || !immutable || !declaration.initializer) return undefined;
        let initializer = declaration.initializer;
        while (ts.isParenthesizedExpression(initializer) || ts.isNonNullExpression(initializer)
          || ts.isAsExpression(initializer) || ts.isTypeAssertionExpression(initializer)
          || ts.isAwaitExpression(initializer)) initializer = initializer.expression;
        if (ts.isCallExpression(initializer)) {
          return `region:${declaration.getSourceFile().fileName}:${declaration.getStart()}`;
        }
        return visit(initializer, new Set([...seen, symbol]));
      }
    }
    const identity = resolveRegionIdentity(checker, expression);
    return identity.status === "resolved" ? identity.regionId : undefined;
  };
  return visit(input, new Set());
}

/** Instantiates authenticated callable contracts at calls within one function owner. */
export function collectResourceCallableTransitionSites(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  summaries: readonly ResourceCallableSummary[],
): ResourceCallableSiteAnalysis {
  if (!fn.body) return { resources: [], sites: [], diagnostics: [] };
  const checker = program.getTypeChecker();
  const byId = new Map(summaries.map((summary) => [summary.id, summary] as const));
  const sites: ResourceTransitionSite[] = [];
  const resources = new Map<string, ResourceProtocolResource>();
  const diagnostics: ResourceCallableDiagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbol(checker, node.expression);
      const declarations = symbol?.declarations ?? (symbol?.valueDeclaration ? [symbol.valueDeclaration] : []);
      const declaration = declarations.find((candidate) => {
        const declarationSource = candidate.getSourceFile();
        return byId.has(`${declarationSource.fileName}:${candidate.getStart(declarationSource)}`);
      });
      if (declaration) {
        const declarationSource = declaration.getSourceFile();
        const summary = byId.get(`${declarationSource.fileName}:${declaration.getStart(declarationSource)}`);
        if (summary) {
          const parameters = new Map<number, string>();
          node.arguments.forEach((argument, index) => {
            const identity = resourceArgumentId(checker, argument);
            if (identity) parameters.set(index, identity);
          });
          const instantiated = instantiateResourceCallableSummary(summary, {
            parameters,
            receiverResource: ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)
              ? resourceArgumentId(checker, node.expression.expression) : undefined,
            returnResource: returnedResourceId(node),
            at: node.getStart(),
          });
          for (const resource of instantiated.resources) resources.set(resource.id, resource);
          if (instantiated.transitions.length > 0) sites.push({ node, transitions: instantiated.transitions });
          for (const missing of instantiated.missing) diagnostics.push({
            code: "unresolved-resource-binding",
            fileName: node.getSourceFile().fileName,
            message: `cannot bind ${missing.reference.kind === "return" ? "return resource" : missing.reference.kind === "receiver" ? "receiver resource" : `parameter ${missing.reference.index}`} for ${summary.id}`,
            span: { start: node.getStart(), end: node.getEnd() },
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return { resources: [...resources.values()], sites, diagnostics };
}

function lifecycleOwner(fn: ts.FunctionLikeDeclaration): string {
  if ("name" in fn && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : "<anonymous>";
}

function isFunctionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !!node.body;
}

function acceptedTerminal(resource: ResourceProtocolResource, state: ResourceProtocolState): boolean {
  return !resource.requiredTerminalStates?.length || resource.requiredTerminalStates.includes(state as never);
}

function lexicalScopeEnd(node: ts.Node): number {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseBlock(current)) return current.getEnd();
  }
  return node.getEnd();
}

/** Checks same-function user-declared lifecycle composition through the shared CFG. */
export function analyzeResourceLifecyclesInSource(
  program: ts.Program,
  source: ts.SourceFile,
  analysis: ResourceCallableSummaryAnalysis = analyzeResourceCallableSummaries(program),
  sourceValid = true,
): ResourceLifecycleProgramAnalysis {
  const evidence: ResourceLifecycleEvidence[] = [];
  const diagnostics: ResourceLifecycleDiagnostic[] = analysis.diagnostics
    .filter((diagnostic) => diagnostic.fileName === source.fileName)
    .map((diagnostic) => ({
      kind: "invalid-contract", fileName: diagnostic.fileName, functionName: "<annotation>", span: diagnostic.span,
      resource: "<contract>", state: "unknown", message: diagnostic.message,
    }));
  const visit = (node: ts.Node): void => {
    if (isFunctionWithBody(node)) {
      const collected = collectResourceCallableTransitionSites(program, node, analysis.summaries);
      for (const diagnostic of collected.diagnostics) diagnostics.push({
        kind: "unknown-analysis", fileName: diagnostic.fileName, functionName: lifecycleOwner(node), span: diagnostic.span,
        resource: "<binding>", state: "unknown", message: diagnostic.message,
      });
      if (collected.resources.length > 0) {
        if (!sourceValid) diagnostics.push({
          kind: "unknown-analysis", fileName: source.fileName, functionName: lifecycleOwner(node),
          span: { start: node.getStart(source), end: node.getEnd() }, resource: "<typescript>", state: "unknown",
          message: "TypeScript diagnostics invalidate source-level resource lifecycle evidence",
        });
        const lexicalDisposals = collected.sites.flatMap((site) => {
          if (!ts.isCallExpression(site.node)) return [];
          const declaration = resultDeclaration(site.node);
          if (!declaration || !ts.isVariableDeclarationList(declaration.parent)) return [];
          const flags = ts.getCombinedNodeFlags(declaration.parent);
          if ((flags & ts.NodeFlags.Using) !== ts.NodeFlags.Using) return [];
          return site.transitions.flatMap((transition) => transition.kind === "acquire" ? [{
            declaration,
            transition: { kind: "release" as const, resource: transition.resource,
              at: lexicalScopeEnd(declaration), evidence: transition.evidence },
          }] : []);
        });
        const lowered = lowerResourceProtocolCfgInFunction(source, node, {
          schema: "uneffect-resource-protocol/v1", resources: collected.resources, transitions: [],
        }, collected.sites, { lexicalDisposals });
        if (lowered.status === "unknown") {
          const span = { start: node.getStart(source), end: node.getEnd() };
          diagnostics.push({ kind: "unknown-analysis", fileName: source.fileName, functionName: lifecycleOwner(node), span,
            resource: "<cfg>", state: "unknown", message: `resource CFG is unknown: ${lowered.reason}` });
          for (const resource of collected.resources) evidence.push({
            fileName: source.fileName, owner: lifecycleOwner(node), resource: resource.label, kind: resource.kind,
            span, status: "unknown", evidence: "unknown", state: "unknown", transitions: collected.sites.flatMap((site) => site.transitions),
          });
        } else {
          const evaluated = evaluateResourceProtocolCfg(lowered.cfg);
          const transitions = [...collected.sites.flatMap((site) => site.transitions), ...lexicalDisposals.map(({ transition }) => transition)];
          const trust = !sourceValid || transitions.some((transition) => transition.evidence === "unknown") ? "unknown" as const
            : transitions.some((transition) => transition.evidence === "trusted") ? "trusted" as const : "verified" as const;
          for (const resource of collected.resources) {
            const state = evaluated.states.get(resource.id) ?? "unknown";
            const status = !sourceValid || evaluated.status === "unknown" ? "unknown" as const
              : acceptedTerminal(resource, state) ? "satisfied" as const : "unsatisfied" as const;
            evidence.push({ fileName: source.fileName, owner: lifecycleOwner(node), resource: resource.label,
              kind: resource.kind, span: { start: node.getStart(source), end: node.getEnd() }, status, evidence: trust, state, transitions });
            if (status === "unsatisfied") {
              const acquisition = transitions.find((transition) => "resource" in transition && transition.resource === resource.id && transition.kind === "acquire");
              const start = acquisition?.at ?? node.getStart(source);
              diagnostics.push({ kind: "unclosed", fileName: source.fileName, functionName: lifecycleOwner(node),
                span: { start, end: start }, resource: resource.label, state,
                message: `${resource.label} does not reach an accepted terminal state (found ${state})` });
            }
          }
          for (const diagnostic of evaluated.diagnostics) diagnostics.push({
            kind: diagnostic.code === "invalid-transition" ? "invalid-transition" : "unknown-analysis",
            fileName: source.fileName, functionName: lifecycleOwner(node),
            span: { start: diagnostic.at ?? node.getStart(source), end: diagnostic.at ?? node.getStart(source) },
            resource: diagnostic.resource, state: diagnostic.state, message: diagnostic.message,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { evidence, diagnostics };
}

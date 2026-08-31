import ts from "typescript";
import { extractLocatedAnnotations } from "./annotations.js";
import { resolveRegionIdentity } from "./region-alias.js";
import {
  instantiateResourceCallableSummary,
  type ResourceCallableOperation,
  type ResourceCallableReference,
  type ResourceCallableSummary,
} from "./resource-protocol.js";
import type { ResourceTransitionSite } from "./resource-protocol-typescript.js";

type SupportedFunction = ts.FunctionDeclaration | ts.MethodDeclaration | ts.ArrowFunction | ts.FunctionExpression;

export interface ResourceCallableDiagnostic {
  readonly code: "invalid-resource-reference" | "invalid-resource-transfer" | "unresolved-resource-binding";
  readonly fileName: string;
  readonly message: string;
  readonly span: { readonly start: number; readonly end: number };
}

export interface ResourceCallableSummaryAnalysis {
  readonly summaries: readonly ResourceCallableSummary[];
  readonly diagnostics: readonly ResourceCallableDiagnostic[];
}

export interface ResourceCallableSiteAnalysis {
  readonly sites: readonly ResourceTransitionSite[];
  readonly diagnostics: readonly ResourceCallableDiagnostic[];
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
  const index = declaration.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === text);
  return index < 0 ? undefined : { kind: "parameter", index, name: text };
}

/** Extracts declared resource-boundary contracts. Declarations are trusted, not verified. */
export function analyzeResourceCallableSummaries(program: ts.Program): ResourceCallableSummaryAnalysis {
  const summaries: ResourceCallableSummary[] = [];
  const diagnostics: ResourceCallableDiagnostic[] = [];
  for (const source of program.getSourceFiles()) {
    if (source.isDeclarationFile) continue;
    const visit = (node: ts.Node): void => {
      if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.body) {
        const owner = annotationOwner(node);
        const leadingStart = owner.getFullStart();
        const leading = source.text.slice(leadingStart, owner.getStart(source));
        const operations: ResourceCallableOperation[] = [];
        for (const kind of ["borrow", "consume", "transfer", "escape"] as const) {
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

function returnedResourceId(call: ts.CallExpression): string | undefined {
  const parent = call.parent;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== call || !ts.isIdentifier(parent.name)) return undefined;
  return `region:${parent.getSourceFile().fileName}:${parent.getStart()}`;
}

/** Instantiates authenticated callable contracts at calls within one function owner. */
export function collectResourceCallableTransitionSites(
  program: ts.Program,
  fn: ts.FunctionLikeDeclaration,
  summaries: readonly ResourceCallableSummary[],
): ResourceCallableSiteAnalysis {
  if (!fn.body) return { sites: [], diagnostics: [] };
  const checker = program.getTypeChecker();
  const byId = new Map(summaries.map((summary) => [summary.id, summary] as const));
  const sites: ResourceTransitionSite[] = [];
  const diagnostics: ResourceCallableDiagnostic[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isCallExpression(node)) {
      const symbol = resolvedSymbol(checker, node.expression);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration) {
        const declarationSource = declaration.getSourceFile();
        const summary = byId.get(`${declarationSource.fileName}:${declaration.getStart(declarationSource)}`);
        if (summary) {
          const parameters = new Map<number, string>();
          node.arguments.forEach((argument, index) => {
            const identity = resolveRegionIdentity(checker, argument);
            if (identity.status === "resolved") parameters.set(index, identity.regionId);
          });
          const instantiated = instantiateResourceCallableSummary(summary, {
            parameters,
            returnResource: returnedResourceId(node),
            at: node.getStart(),
          });
          if (instantiated.transitions.length > 0) sites.push({ node, transitions: instantiated.transitions });
          for (const missing of instantiated.missing) diagnostics.push({
            code: "unresolved-resource-binding",
            fileName: node.getSourceFile().fileName,
            message: `cannot bind ${missing.reference.kind === "return" ? "return resource" : `parameter ${missing.reference.index}`} for ${summary.id}`,
            span: { start: node.getStart(), end: node.getEnd() },
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return { sites, diagnostics };
}

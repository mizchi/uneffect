import { isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import type { EffectSummary, ExternalFunctionEffectContract } from "./effects.js";
import type { TypeScriptProject } from "./typescript-project.js";

export interface WorkspaceEffectLink {
  fromProject: string;
  toProject: string;
  callerFile: string;
  callee: string;
  declarationFile: string;
  evidence: ExternalFunctionEffectContract["evidence"];
  effects: ExternalFunctionEffectContract["effects"];
}

export interface WorkspaceEffectCompositionBlocker {
  kind: "effect-composition";
  classification: "unknown";
  projectFile: string;
  subject: string;
  message: string;
}

export interface CompletedEffectProject {
  project: TypeScriptProject;
  summaries: readonly EffectSummary[];
}

export interface WorkspaceEffectComposition {
  contracts: Map<string, ExternalFunctionEffectContract>;
  links: WorkspaceEffectLink[];
  blockers: WorkspaceEffectCompositionBlocker[];
}

function contains(directory: string, fileName: string): boolean {
  const path = relative(resolve(directory), resolve(fileName));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function owningProject(fileName: string, completed: readonly CompletedEffectProject[]): CompletedEffectProject | undefined {
  return completed.find(({ project }) => project.fileNames.includes(fileName)
    || (project.compilerOptions.declarationDir !== undefined && contains(String(project.compilerOptions.declarationDir), fileName))
    || (project.compilerOptions.outDir !== undefined && contains(String(project.compilerOptions.outDir), fileName)));
}

function callSymbol(checker: ts.TypeChecker, call: ts.CallExpression): ts.Symbol | undefined {
  const location = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = checker.getSymbolAtLocation(location);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol;
}

/** Bind child-first verified summaries to the declarations resolved by a parent Program. */
export function composeWorkspaceEffects(
  program: ts.Program,
  current: TypeScriptProject,
  completed: readonly CompletedEffectProject[],
): WorkspaceEffectComposition {
  const checker = program.getTypeChecker();
  const contracts = new Map<string, ExternalFunctionEffectContract>();
  const links: WorkspaceEffectLink[] = [], blockers: WorkspaceEffectCompositionBlocker[] = [];
  const seen = new Set<string>();
  for (const fileName of current.fileNames) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) for (const declaration of callSymbol(checker, node)?.declarations ?? []) {
        const declarationSource = declaration.getSourceFile();
        const owner = owningProject(declarationSource.fileName, completed);
        if (!owner) continue;
        const key = `${declarationSource.fileName}:${declaration.getStart(declarationSource)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const name = callSymbol(checker, node)?.getName() ?? declaration.getText(declarationSource);
        const exact = owner.summaries.filter((summary) => summary.id === key);
        const candidates = exact.length > 0 ? exact : owner.summaries.filter((summary) => summary.functionName === name && summary.functionName !== "<module>");
        const summary = candidates.length === 1 ? candidates[0] : undefined;
        const unsupportedMutation = summary?.effects.some((effect) => effect.kind === "mutate") ?? false;
        const unsupportedIterator = (summary?.iteratorEffectParameters?.length ?? 0) > 0;
        const verified = summary?.evidence === "verified" && !unsupportedMutation && !unsupportedIterator;
        const reason = summary === undefined
          ? `cannot uniquely match ${name} to a child-project effect summary`
          : unsupportedMutation ? `cross-project Mutate region substitution is not implemented for ${name}`
          : unsupportedIterator ? `cross-project iterator effect instantiation is not implemented for ${name}`
          : summary.evidence !== "verified" ? `${name} has ${summary.evidence} child-project evidence`
          : undefined;
        const contract: ExternalFunctionEffectContract = {
          effects: summary?.effects ?? [], evidence: verified ? "verified" : "unknown", ...(reason ? { reason } : {}),
        };
        contracts.set(key, contract);
        links.push({
          fromProject: current.projectFile, toProject: owner.project.projectFile, callerFile: source.fileName,
          callee: name, declarationFile: declarationSource.fileName, evidence: contract.evidence, effects: contract.effects,
        });
        if (!verified) blockers.push({
          kind: "effect-composition", classification: "unknown", projectFile: current.projectFile,
          subject: name, message: reason ?? `effect composition for ${name} is unknown`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { contracts, links, blockers };
}

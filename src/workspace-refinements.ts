import { resolve } from "node:path";
import ts from "typescript";
import {
  buildRefinementBindingManifest,
  extractRefinementBindings,
  validateRefinementActionBodiesInProgram,
  validateRefinementStateProjectionInProgram,
  formatRefinementExpression,
  type ExternalRefinementActionContract,
} from "./refinement-bindings.js";
import { parseSpec } from "./spec-ir.js";
import type { TemporalExpression } from "./temporal-expressions.js";
import type { TypeScriptProject, TypeScriptProjectProvenance } from "./typescript-project.js";
import type { DeclarationOutputIntegrity } from "./workspace-effects.js";

export interface ProjectRefinementActionSummary extends ExternalRefinementActionContract {
  sourceFile: string;
}

export interface CompletedRefinementProject {
  project: TypeScriptProject;
  summaries: readonly ProjectRefinementActionSummary[];
  declarationOutputs: ReadonlyMap<string, DeclarationOutputIntegrity>;
}

export interface WorkspaceRefinementLink {
  fromProject: string;
  toProject: string;
  callerFile: string;
  callee: string;
  adapterName: string;
  version: string;
  modelName: string;
  guard?: string;
  evidence: "verified" | "unknown";
  declarationFile: string;
  declarationIntegrity: DeclarationOutputIntegrity;
  producer: TypeScriptProjectProvenance;
  consumer: TypeScriptProjectProvenance;
}

export interface WorkspaceRefinementCompositionBlocker {
  kind: "refinement-composition";
  classification: "unknown" | "violation";
  projectFile: string;
  subject: string;
  message: string;
}

export interface WorkspaceRefinementComposition {
  contracts: Map<string, ExternalRefinementActionContract>;
  links: WorkspaceRefinementLink[];
  blockers: WorkspaceRefinementCompositionBlocker[];
}

function declarationKey(declaration: ts.Declaration): string {
  const source = declaration.getSourceFile();
  return `${source.fileName}:${declaration.getStart(source)}`;
}

function callDeclaration(checker: ts.TypeChecker, call: ts.CallExpression): ts.Declaration | undefined {
  const location = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
  let symbol = checker.getSymbolAtLocation(location);
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.declarations?.[0];
}

function ownsDeclaration(project: CompletedRefinementProject, fileName: string): boolean {
  const normalized = resolve(fileName);
  return project.declarationOutputs.has(normalized)
    || project.project.fileNames.some((source) => resolve(source) === normalized);
}

/** Bind locally verified child action summaries only to direct calls inside annotated parent actions. */
export function composeWorkspaceRefinements(
  program: ts.Program,
  current: TypeScriptProject,
  completed: readonly CompletedRefinementProject[],
): WorkspaceRefinementComposition {
  const checker = program.getTypeChecker();
  const contracts = new Map<string, ExternalRefinementActionContract>();
  const links: WorkspaceRefinementLink[] = [];
  const blockers: WorkspaceRefinementCompositionBlocker[] = [];
  const seen = new Set<string>();
  for (const fileName of current.fileNames) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    let actionExports: Set<string>;
    try {
      actionExports = new Set(extractRefinementBindings(source.fileName, source.text)
        .filter((binding) => binding.role === "action").map((binding) => binding.exportName));
    } catch (error) {
      blockers.push({
        kind: "refinement-composition", classification: "violation", projectFile: current.projectFile,
        subject: source.fileName, message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const statement of source.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body
        || !actionExports.has(statement.name.text)) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionLike(node) && node !== statement) return;
        if (ts.isCallExpression(node)) {
          const declaration = callDeclaration(checker, node);
          if (declaration) {
            const declarationSource = declaration.getSourceFile();
            const owner = completed.find((candidate) => ownsDeclaration(candidate, declarationSource.fileName));
            if (owner) {
              const key = declarationKey(declaration);
              if (!seen.has(key)) {
                seen.add(key);
                const declarationName = (declaration as ts.NamedDeclaration).name;
                const callee = declarationName && ts.isIdentifier(declarationName)
                  ? declarationName.text : node.expression.getText(source);
                const candidates = owner.summaries.filter((summary) => summary.exportName === callee);
                if (candidates.length > 0) {
                  const summary = candidates.length === 1 ? candidates[0] : undefined;
                  const declarationIntegrity = owner.declarationOutputs.get(resolve(declarationSource.fileName))
                    ?? { status: "missing" as const, fileName: declarationSource.fileName, message: "declaration output was not reproduced by the child Program" };
                  const verified = summary?.evidence === "verified" && declarationIntegrity.status === "verified"
                    && owner.project.provenance.compiler.parity === "exact"
                    && current.provenance.compiler.parity === "exact";
                  let reason: string | undefined;
                  if (!summary) reason = `cannot uniquely match ${callee} to a child-project refinement summary`;
                  else if (owner.project.provenance.compiler.parity !== "exact") {
                    reason = `producer compiler parity is ${owner.project.provenance.compiler.parity}`;
                  } else if (current.provenance.compiler.parity !== "exact") {
                    reason = `consumer compiler parity is ${current.provenance.compiler.parity}`;
                  } else if (declarationIntegrity.status !== "verified") {
                    reason = `${declarationIntegrity.message ?? "declaration output integrity is unknown"} for ${declarationSource.fileName}`;
                  } else if (summary.evidence !== "verified") {
                    reason = summary.reason ?? `${callee} refinement evidence is unknown`;
                  }
                  const contract: ExternalRefinementActionContract = summary ? {
                    adapterName: summary.adapterName, version: summary.version, modelName: summary.modelName,
                    exportName: summary.exportName, guard: summary.guard, assignments: summary.assignments,
                    evidence: verified ? "verified" : "unknown", ...(reason ? { reason } : {}),
                  } : {
                    adapterName: "<ambiguous>", version: "<unknown>", modelName: callee,
                    exportName: callee, assignments: [], evidence: "unknown", reason,
                  };
                  contracts.set(key, contract);
                  links.push({
                    fromProject: current.projectFile, toProject: owner.project.projectFile,
                    callerFile: source.fileName, callee, adapterName: contract.adapterName,
                    version: contract.version, modelName: contract.modelName,
                    ...(contract.guard ? { guard: formatRefinementExpression(contract.guard) } : {}),
                    evidence: contract.evidence,
                    declarationFile: declarationSource.fileName, declarationIntegrity,
                    producer: owner.project.provenance, consumer: current.provenance,
                  });
                  if (!verified) blockers.push({
                    kind: "refinement-composition", classification: "unknown", projectFile: current.projectFile,
                    subject: callee, message: reason ?? `refinement composition for ${callee} is unknown`,
                  });
                }
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(statement.body);
    }
  }
  return { contracts, links, blockers };
}

export interface ProjectRefinementAnalysis {
  summaries: ProjectRefinementActionSummary[];
  blockers: WorkspaceRefinementCompositionBlocker[];
}

/** Validate each adapter in its owning compiler domain before exporting scalar action facts. */
export function analyzeProjectRefinements(
  program: ts.Program,
  project: TypeScriptProject,
  externalActions: ReadonlyMap<string, ExternalRefinementActionContract>,
): ProjectRefinementAnalysis {
  const summaries: ProjectRefinementActionSummary[] = [];
  const blockers: WorkspaceRefinementCompositionBlocker[] = [];
  if (project.provenance.compiler.parity !== "exact") return {
    summaries,
    blockers: [{
      kind: "refinement-composition", classification: "unknown", projectFile: project.projectFile,
      subject: project.projectFile, message: project.provenance.compiler.reason
        ?? `project compiler parity is ${project.provenance.compiler.parity}`,
    }],
  };
  const typeScriptDiagnostics = [
    ...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(),
  ];
  if (typeScriptDiagnostics.length > 0) return {
    summaries,
    blockers: [{
      kind: "refinement-composition", classification: "unknown", projectFile: project.projectFile,
      subject: project.projectFile, message: "TypeScript diagnostics prevent proof-grade refinement summaries",
    }],
  };
  for (const fileName of project.fileNames) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    let adapters: string[];
    try {
      adapters = [...new Set(extractRefinementBindings(source.fileName, source.text).map((binding) => binding.adapterName))];
    } catch (error) {
      blockers.push({ kind: "refinement-composition", classification: "violation", projectFile: project.projectFile,
        subject: source.fileName, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (adapters.length === 0) continue;
    let temporal: ReturnType<typeof parseSpec>["temporal"];
    try {
      temporal = parseSpec(source.fileName, source.text).temporal;
    } catch (error) {
      blockers.push({ kind: "refinement-composition", classification: "violation", projectFile: project.projectFile,
        subject: source.fileName, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const adapterName of adapters) {
      try {
        const manifest = buildRefinementBindingManifest(source.fileName, source.text, adapterName);
        const projection = validateRefinementStateProjectionInProgram(program, source.fileName, adapterName, temporal);
        const actions = validateRefinementActionBodiesInProgram(program, source.fileName, adapterName, temporal, { externalActions });
        for (const diagnostic of [...projection, ...actions]) blockers.push({
          kind: "refinement-composition", classification: "violation", projectFile: project.projectFile,
          subject: `${adapterName}:${"modelName" in diagnostic ? diagnostic.modelName : diagnostic.role}`,
          message: diagnostic.message,
        });
        if (projection.length > 0 || actions.length > 0) continue;
        for (const action of temporal.actions) {
          const exportName = manifest.actions[action.name];
          if (!exportName) continue;
          summaries.push({
            adapterName, version: manifest.version, modelName: action.name, exportName,
            ...(action.guard ? { guard: action.guard.expressionAst as TemporalExpression } : {}),
            assignments: action.assignments.map(({ target, expressionAst }) => ({ target, expressionAst: expressionAst as TemporalExpression })),
            evidence: "verified", sourceFile: source.fileName,
          });
        }
      } catch (error) {
        blockers.push({ kind: "refinement-composition", classification: "violation", projectFile: project.projectFile,
          subject: `${source.fileName}:${adapterName}`, message: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { summaries, blockers };
}

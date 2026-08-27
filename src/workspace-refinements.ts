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
  /** Annotated parent action, bounded local helpers, then the child export. */
  callPath: string[];
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

function symbolOccursIn(checker: ts.TypeChecker, root: ts.Node, symbol: ts.Symbol): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** Function declarations are followed only while their binding has no source-level writes. */
function isWriteScreenedLocalHelper(
  checker: ts.TypeChecker,
  source: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
): boolean {
  if (!declaration.name || declaration.getSourceFile() !== source) return false;
  const symbol = checker.getSymbolAtLocation(declaration.name);
  if (!symbol) return false;
  let written = false;
  const visit = (node: ts.Node): void => {
    if (written) return;
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
      && symbolOccursIn(checker, node.left, symbol)) { written = true; return; }
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
      && symbolOccursIn(checker, node.operand, symbol)) { written = true; return; }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return !written;
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
      const visit = (
        node: ts.Node,
        callPath: readonly string[],
        activeHelpers: ReadonlySet<string>,
      ): ExternalRefinementActionContract | undefined => {
        if (ts.isFunctionLike(node) && node !== statement) return undefined;
        if (ts.isCallExpression(node)) {
          const declaration = callDeclaration(checker, node);
          if (declaration) {
            const declarationSource = declaration.getSourceFile();
            const owner = completed.find((candidate) => ownsDeclaration(candidate, declarationSource.fileName));
            if (owner) {
              const key = declarationKey(declaration);
              let contract = contracts.get(key);
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
                  contract = summary ? {
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
                    callPath: [...callPath, callee],
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
              return contract;
            }
            if (ts.isFunctionDeclaration(declaration) && declaration.body
              && declarationSource === source && declaration.name) {
              const helperName = declaration.name.text;
              const helperKey = declarationKey(declaration);
              if (!isWriteScreenedLocalHelper(checker, source, declaration)) {
                blockers.push({
                  kind: "refinement-composition", classification: "unknown", projectFile: current.projectFile,
                  subject: helperName, message: `local refinement helper ${helperName} is reassigned or cannot be write-screened`,
                });
                return undefined;
              }
              if (activeHelpers.has(helperKey)) {
                blockers.push({
                  kind: "refinement-composition", classification: "unknown", projectFile: current.projectFile,
                  subject: helperName, message: `local refinement helper cycle reaches ${helperName}`,
                });
                return undefined;
              }
              if (activeHelpers.size >= 2) {
                blockers.push({
                  kind: "refinement-composition", classification: "unknown", projectFile: current.projectFile,
                  subject: helperName, message: `local refinement helper depth exceeds the supported single-helper fragment at ${helperName}`,
                });
                return undefined;
              }
              const contract = visit(
                declaration.body,
                [...callPath, helperName],
                new Set([...activeHelpers, helperKey]),
              );
              if (contract && declaration.body.statements.length === 1
                && (ts.isExpressionStatement(declaration.body.statements[0]!)
                  || ts.isReturnStatement(declaration.body.statements[0]!))) {
                contracts.set(helperKey, contract);
              }
              return contract;
            }
            if (declarationSource === source && ts.isVariableDeclaration(declaration)) {
              const helperName = ts.isIdentifier(declaration.name)
                ? declaration.name.text : node.expression.getText(source);
              blockers.push({
                kind: "refinement-composition", classification: "unknown", projectFile: current.projectFile,
                subject: helperName,
                message: `local refinement helper ${helperName} is reassigned or cannot be write-screened as a function declaration`,
              });
              return undefined;
            }
          }
        }
        let resolved: ExternalRefinementActionContract | undefined;
        let ambiguous = false;
        ts.forEachChild(node, (child) => {
          const childContract = visit(child, callPath, activeHelpers);
          if (!childContract) return;
          if (resolved && resolved !== childContract) ambiguous = true;
          else resolved = childContract;
        });
        return ambiguous ? undefined : resolved;
      };
      visit(statement.body, [statement.name.text], new Set([declarationKey(statement)]));
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

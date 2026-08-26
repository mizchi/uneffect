import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import type { EffectSummary, ExternalFunctionEffectContract, ExternalModuleEffectContract, ExternalMutationRoot } from "./effects.js";
import type { IteratorEffectParameter } from "./call-graph.js";
import { isRuntimeModuleDependency } from "./module-initialization.js";
import type { TypeScriptProject } from "./typescript-project.js";

export interface WorkspaceEffectLink {
  kind: "function" | "module";
  fromProject: string;
  toProject: string;
  callerFile: string;
  callee: string;
  declarationFile: string;
  evidence: ExternalFunctionEffectContract["evidence"];
  effects: ExternalFunctionEffectContract["effects"];
  parameters?: readonly string[];
  iteratorEffectParameters?: readonly IteratorEffectParameter[];
  iteratorEffectBounds?: ExternalFunctionEffectContract["iteratorEffectBounds"];
  mutationRoots?: readonly ExternalMutationRoot[];
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
  moduleContracts: Map<string, ExternalModuleEffectContract>;
  links: WorkspaceEffectLink[];
  blockers: WorkspaceEffectCompositionBlocker[];
}

function configuredPath(project: TypeScriptProject, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isAbsolute(value) ? value : resolve(dirname(project.projectFile), value);
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

function withoutSourceExtension(fileName: string): string {
  return fileName.replace(/(?:\.d)?\.(?:[cm]?tsx?|[cm]?jsx?)$/, "");
}

function childModuleSummary(owner: CompletedEffectProject, declarationFile: string): EffectSummary | undefined {
  const modules = owner.summaries.filter((summary) => summary.functionName === "<module>" && summary.fileName !== undefined);
  const exact = modules.filter((summary) => summary.fileName === declarationFile);
  if (exact.length === 1) return exact[0];
  const outputRoot = configuredPath(owner.project,
    owner.project.compilerOptions.declarationDir === undefined
      ? owner.project.compilerOptions.outDir as string | undefined
      : owner.project.compilerOptions.declarationDir as string);
  const sourceRoot = configuredPath(owner.project, owner.project.compilerOptions.rootDir as string | undefined)
    ?? (owner.project.compilerOptions.composite ? dirname(owner.project.projectFile) : undefined);
  if (outputRoot && sourceRoot && contains(outputRoot, declarationFile)) {
    const expected = withoutSourceExtension(relative(outputRoot, declarationFile));
    const mapped = modules.filter((summary) => withoutSourceExtension(relative(sourceRoot, summary.fileName!)) === expected);
    if (mapped.length === 1) return mapped[0];
  }
  const stem = withoutSourceExtension(basename(declarationFile));
  const sameStem = modules.filter((summary) => withoutSourceExtension(basename(summary.fileName!)) === stem);
  if (sameStem.length === 1) return sameStem[0];
  return modules.length === 1 ? modules[0] : undefined;
}

function stableMutationRoots(
  checker: ts.TypeChecker,
  declarationSource: ts.SourceFile,
  summary: EffectSummary | undefined,
  owner: CompletedEffectProject,
): { roots: ExternalMutationRoot[]; unsupported?: string } {
  if (!summary) return { roots: [] };
  const parameters = new Set(summary.parameters ?? []);
  const roots = new Set(summary.effects.flatMap((effect) => {
    if (effect.kind !== "mutate") return [];
    const root = /^[A-Za-z_$][\w$]*/u.exec(effect.region)?.[0] ?? "";
    return parameters.has(root) ? [] : [root];
  }));
  const moduleSymbol = checker.getSymbolAtLocation(declarationSource);
  const exports = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  const stable: ExternalMutationRoot[] = [];
  for (const root of roots) {
    if (root === "globalThis") {
      stable.push({ kind: "ambient", root, identity: "ecmascript:realm.globalThis" });
      continue;
    }
    const exported = exports.find((item) => {
      const target = (item.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(item) : item;
      return target.name === root;
    });
    const target = exported && (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported;
    const declaration = target?.declarations?.[0];
    if (!declaration) return { roots: stable, unsupported: root };
    stable.push({
      kind: "export", root, exportName: exported!.name,
      identity: `${owner.project.projectFile}::${relative(
        configuredPath(owner.project, owner.project.compilerOptions.rootDir as string | undefined)
          ?? dirname(owner.project.projectFile),
        summary.fileName ?? declarationSource.fileName,
      ).replaceAll("\\", "/")}#${exported!.name}`,
      declarationKey: `${declaration.getSourceFile().fileName}:${declaration.getStart(declaration.getSourceFile())}`,
    });
  }
  return { roots: stable };
}

/** Bind child-first verified summaries to the declarations resolved by a parent Program. */
export function composeWorkspaceEffects(
  program: ts.Program,
  current: TypeScriptProject,
  completed: readonly CompletedEffectProject[],
): WorkspaceEffectComposition {
  const checker = program.getTypeChecker();
  const contracts = new Map<string, ExternalFunctionEffectContract>();
  const moduleContracts = new Map<string, ExternalModuleEffectContract>();
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
        const mutation = stableMutationRoots(checker, declarationSource, summary, owner);
        const unsupportedMutation = mutation.unsupported;
        const iteratorBounds = new Set(summary?.iteratorEffectBounds?.map((bound) => bound.index) ?? []);
        const unsupportedIterator = summary?.iteratorEffectParameters?.some((parameter) => !iteratorBounds.has(parameter.index)) ?? false;
        const verified = summary?.evidence === "verified" && !unsupportedMutation && !unsupportedIterator;
        const reason = summary === undefined
          ? `cannot uniquely match ${name} to a child-project effect summary`
          : unsupportedMutation ? `cross-project Mutate region root ${unsupportedMutation} is not a stable export of ${name}`
          : unsupportedIterator ? `cross-project iterator effect parameter ${name} has no verified bound`
          : summary.evidence !== "verified" ? `${name} has ${summary.evidence} child-project evidence`
          : undefined;
        const contract: ExternalFunctionEffectContract = {
          effects: summary?.effects ?? [], evidence: verified ? "verified" : "unknown",
          functionName: name,
          ...(summary?.parameters ? { parameters: summary.parameters } : {}),
          ...(summary?.iteratorEffectParameters ? { iteratorEffectParameters: summary.iteratorEffectParameters } : {}),
          ...(summary?.iteratorEffectBounds ? { iteratorEffectBounds: summary.iteratorEffectBounds } : {}),
          ...(mutation.roots.length > 0 ? { mutationRoots: mutation.roots } : {}),
          ...(reason ? { reason } : {}),
        };
        contracts.set(key, contract);
        links.push({ kind: "function",
          fromProject: current.projectFile, toProject: owner.project.projectFile, callerFile: source.fileName,
          callee: name, declarationFile: declarationSource.fileName, evidence: contract.evidence, effects: contract.effects,
          ...(contract.parameters ? { parameters: contract.parameters } : {}),
          ...(contract.iteratorEffectParameters ? { iteratorEffectParameters: contract.iteratorEffectParameters } : {}),
          ...(contract.iteratorEffectBounds ? { iteratorEffectBounds: contract.iteratorEffectBounds } : {}),
          ...(contract.mutationRoots ? { mutationRoots: contract.mutationRoots } : {}),
        });
        if (!verified) blockers.push({
          kind: "effect-composition", classification: "unknown", projectFile: current.projectFile,
          subject: name, message: reason ?? `effect composition for ${name} is unknown`,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const statement of source.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || !isRuntimeModuleDependency(statement)
        || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const symbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
      const declarationFile = symbol?.declarations?.find(ts.isSourceFile)?.getSourceFile().fileName
        ?? ts.resolveModuleName(statement.moduleSpecifier.text, source.fileName, program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName;
      if (!declarationFile || moduleContracts.has(declarationFile)) continue;
      const owner = owningProject(declarationFile, completed);
      if (!owner) continue;
      const summary = childModuleSummary(owner, declarationFile);
      const mutation = stableMutationRoots(checker, program.getSourceFile(declarationFile) ?? source, summary, owner);
      const unsupportedMutation = mutation.unsupported;
      const verified = summary?.evidence === "verified" && !unsupportedMutation;
      const reason = summary === undefined
        ? `cannot uniquely match ${declarationFile} to a child-project module summary`
        : unsupportedMutation ? `cross-project module Mutate region root ${unsupportedMutation} is not a stable export of ${summary.fileName}`
        : summary.evidence !== "verified" ? `${summary.fileName} module has ${summary.evidence} child-project evidence`
        : undefined;
      const contract: ExternalModuleEffectContract = {
        effects: summary?.effects ?? [], evidence: verified ? "verified" : "unknown",
        ...(mutation.roots.length > 0 ? { mutationRoots: mutation.roots } : {}),
        ...(reason ? { reason } : {}),
      };
      moduleContracts.set(declarationFile, contract);
      links.push({
        kind: "module", fromProject: current.projectFile, toProject: owner.project.projectFile,
        callerFile: source.fileName, callee: "<module>", declarationFile, evidence: contract.evidence, effects: contract.effects,
        ...(contract.mutationRoots ? { mutationRoots: contract.mutationRoots } : {}),
      });
      if (!verified) blockers.push({
        kind: "effect-composition", classification: "unknown", projectFile: current.projectFile,
        subject: declarationFile, message: reason ?? `module effect composition for ${declarationFile} is unknown`,
      });
    }
  }
  return { contracts, moduleContracts, links, blockers };
}

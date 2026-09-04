import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import {
  analyzeModuleInitializationOrder,
  isRuntimeModuleDependency,
  type ModuleInitializationOrder,
  type ModuleInitializationSourceEvidence,
  type ModuleInitializationUnknown,
} from "./module-initialization.js";
import type { TypeScriptProject } from "./typescript-project.js";
import type { DeclarationOutputIntegrity } from "./workspace-effects.js";

export interface CompletedModuleInitializationProject {
  project: TypeScriptProject;
  program: ts.Program;
  declarationOutputs: ReadonlyMap<string, DeclarationOutputIntegrity>;
}

export interface WorkspaceModuleInitializationDomain {
  projectFile: string;
  order: ModuleInitializationOrder;
  /** Unknowns discharged only by the exact cross-project links retained below. */
  dischargedUnknowns: ModuleInitializationUnknown[];
}

export interface WorkspaceModuleInitializationLink {
  fromProject: string;
  toProject: string;
  importerFile: string;
  dependencyEntryFile: string;
  declarationFile: string;
  importSpan: { start: number; end: number };
  semanticRule: "ecma262-async-module-dependency-completion";
  sourceEvidence: ModuleInitializationSourceEvidence;
  declarationIntegrity: DeclarationOutputIntegrity;
}

export interface WorkspaceModuleInitializationConstraint {
  before: string;
  after: string;
  reason: "cross-project-static-dependency-completes";
  semanticRule: "ecma262-async-module-dependency-completion";
  link: number;
}

export interface WorkspaceModuleInitializationUnknown {
  projectFile: string;
  fileName: string;
  kind: string;
  detail: string;
  span?: { start: number; end: number };
}

export interface WorkspaceModuleInitializationComposition {
  schema: "uneffect-workspace-module-order/v1";
  schemaVersion: 1;
  entryFile: string;
  evidence: "verified" | "unknown";
  domains: WorkspaceModuleInitializationDomain[];
  links: WorkspaceModuleInitializationLink[];
  constraints: WorkspaceModuleInitializationConstraint[];
  unknowns: WorkspaceModuleInitializationUnknown[];
  claims: readonly string[];
  exclusions: readonly string[];
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function configuredPath(project: TypeScriptProject, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isAbsolute(value) ? value : resolve(dirname(project.projectFile), value);
}

function contains(directory: string, fileName: string): boolean {
  const path = relative(resolve(directory), resolve(fileName));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function declarationOwner(
  fileName: string,
  completed: readonly CompletedModuleInitializationProject[],
): CompletedModuleInitializationProject | undefined {
  return completed.find(({ project }) => {
    if (project.fileNames.includes(fileName)) return true;
    const output = configuredPath(project, project.compilerOptions.declarationDir as string | undefined)
      ?? configuredPath(project, project.compilerOptions.outDir as string | undefined);
    return output !== undefined && contains(output, fileName);
  });
}

function declarationForSource(sourceFile: string, owner: CompletedModuleInitializationProject): string | undefined {
  const output = configuredPath(owner.project, owner.project.compilerOptions.declarationDir as string | undefined)
    ?? configuredPath(owner.project, owner.project.compilerOptions.outDir as string | undefined);
  const sourceRoot = configuredPath(owner.project, owner.project.compilerOptions.rootDir as string | undefined)
    ?? (owner.project.compilerOptions.composite ? dirname(owner.project.projectFile) : undefined);
  if (!output || !sourceRoot || !contains(sourceRoot, sourceFile)) return undefined;
  const relativeSource = relative(sourceRoot, sourceFile);
  const declaration = relativeSource.endsWith(".mts")
    ? relativeSource.replace(/\.mts$/u, ".d.mts")
    : relativeSource.endsWith(".cts")
      ? relativeSource.replace(/\.cts$/u, ".d.cts")
      : relativeSource.replace(/\.(?:tsx?|jsx?)$/u, ".d.ts");
  return resolve(output, declaration);
}

function sourceForDeclaration(
  declarationFile: string,
  owner: CompletedModuleInitializationProject,
): ts.SourceFile | undefined {
  const output = configuredPath(owner.project, owner.project.compilerOptions.declarationDir as string | undefined)
    ?? configuredPath(owner.project, owner.project.compilerOptions.outDir as string | undefined);
  const sourceRoot = configuredPath(owner.project, owner.project.compilerOptions.rootDir as string | undefined)
    ?? (owner.project.compilerOptions.composite ? dirname(owner.project.projectFile) : undefined);
  if (!output || !sourceRoot || !contains(output, declarationFile)) return undefined;
  const stem = relative(output, declarationFile).replace(/\.d\.(?:mts|cts|ts)$/u, "");
  const matches = owner.project.fileNames.filter((fileName) => {
    const sourceStem = relative(sourceRoot, fileName).replace(/\.(?:mts|cts|tsx?|jsx?)$/u, "");
    return sourceStem === stem;
  });
  return matches.length === 1 ? owner.program.getSourceFile(matches[0]!) : undefined;
}

function resolutionHost(program: ts.Program): ts.ModuleResolutionHost {
  return {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    realpath: ts.sys.realpath,
  };
}

/**
 * Compose the first deliberately narrow async ESM workspace fragment.
 *
 * Accepted shape: one parent entry directly imports one exact child declaration;
 * the child source is one acyclic module with one straight-line top-level await.
 * Everything else remains an explicit unknown instead of being flattened.
 */
export function composeWorkspaceModuleInitialization(
  program: ts.Program,
  current: TypeScriptProject,
  completed: readonly CompletedModuleInitializationProject[],
  entryFile: string,
): WorkspaceModuleInitializationComposition {
  const parentOrder = analyzeModuleInitializationOrder(program, entryFile);
  const domains: WorkspaceModuleInitializationDomain[] = [{
    projectFile: current.projectFile, order: parentOrder, dischargedUnknowns: [],
  }];
  const links: WorkspaceModuleInitializationLink[] = [];
  const constraints: WorkspaceModuleInitializationConstraint[] = [];
  const unknowns: WorkspaceModuleInitializationUnknown[] = [];
  const entry = program.getSourceFile(entryFile);
  const candidates: Array<{
    owner: CompletedModuleInitializationProject;
    declarationFile: string;
    dependencySource: ts.SourceFile;
    span: { start: number; end: number };
  }> = [];

  if (!entry || entry.isDeclarationFile) {
    unknowns.push({ projectFile: current.projectFile, fileName: entryFile, kind: "entry-not-found", detail: "workspace entry source is absent from its owning Program" });
  } else {
    for (const statement of entry.statements) {
      if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || !ts.isStringLiteralLike(statement.moduleSpecifier)
        || !isRuntimeModuleDependency(statement)) continue;
      const resolved = ts.resolveModuleName(
        statement.moduleSpecifier.text, entry.fileName, program.getCompilerOptions(), resolutionHost(program),
      ).resolvedModule?.resolvedFileName;
      if (!resolved) continue;
      const resolvedFile = resolve(resolved);
      const owner = declarationOwner(resolvedFile, completed);
      if (!owner) continue;
      const resolvedIsSource = owner.project.fileNames.includes(resolvedFile);
      const declarationFile = resolvedIsSource ? declarationForSource(resolvedFile, owner) : resolvedFile;
      const dependencySource = resolvedIsSource
        ? owner.program.getSourceFile(resolvedFile)
        : sourceForDeclaration(resolvedFile, owner);
      if (!dependencySource || !declarationFile) {
        unknowns.push({
          projectFile: current.projectFile, fileName: entry.fileName, kind: "declaration-source-mapping",
          span: { start: statement.moduleSpecifier.getStart(entry), end: statement.moduleSpecifier.getEnd() },
          detail: `cannot uniquely map ${resolvedFile} between one child-project source and declaration`,
        });
        continue;
      }
      candidates.push({
        owner, declarationFile, dependencySource,
        span: { start: statement.moduleSpecifier.getStart(entry), end: statement.moduleSpecifier.getEnd() },
      });
    }
  }

  if (candidates.length !== 1) unknowns.push({
    projectFile: current.projectFile, fileName: entryFile, kind: "unsupported-cross-project-shape",
    detail: `the straight-line TLA seed requires exactly one direct child-project runtime dependency; found ${candidates.length}`,
  });
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  if (candidate) {
    const integrity = candidate.owner.declarationOutputs.get(candidate.declarationFile)
      ?? { status: "missing" as const, fileName: candidate.declarationFile, message: "child declaration output has no exact re-emission evidence" };
    const childOrder = analyzeModuleInitializationOrder(candidate.owner.program, candidate.dependencySource.fileName);
    domains.unshift({ projectFile: candidate.owner.project.projectFile, order: childOrder, dischargedUnknowns: [] });
    const childModules = childOrder.modules;
    const childAwaits = childModules.flatMap((module) => module.choices);
    const childComplete = childModules.length === 1
      ? childModules[0]!.events.find((event) => event.kind === "complete")
      : undefined;
    const straightLineChild = childOrder.evidence === "verified" && childModules.length === 1
      && childAwaits.length === 1 && childComplete !== undefined && childOrder.cycleComponents.length === 0;
    const parentSimple = parentOrder.modules.length === 1
      && parentOrder.modules[0]!.choices.length === 0
      && parentOrder.modules[0]!.events.some((event) => event.kind === "complete")
      && parentOrder.cycleComponents.length === 0;
    const matchingParentUnknowns = parentOrder.unknowns.filter((item) => item.kind === "external-static-import"
      && item.fileName === entryFile && item.span?.start === candidate.span.start && item.span.end === candidate.span.end);
    const otherParentUnknowns = parentOrder.unknowns.filter((item) => !matchingParentUnknowns.includes(item));
    if (matchingParentUnknowns.length === 1) domains[1]!.dischargedUnknowns.push(matchingParentUnknowns[0]!);
    else unknowns.push({
      projectFile: current.projectFile, fileName: entryFile, kind: "external-import-discharge",
      span: candidate.span, detail: "the parent external-import unknown does not uniquely match the child declaration link",
    });
    for (const item of otherParentUnknowns) unknowns.push({ projectFile: current.projectFile, ...item });
    if (!straightLineChild) unknowns.push({
      projectFile: candidate.owner.project.projectFile, fileName: candidate.dependencySource.fileName,
      kind: "unsupported-child-tla-shape",
      detail: "the child dependency must be one acyclic module with exactly one straight-line top-level await",
    });
    if (!parentSimple) unknowns.push({
      projectFile: current.projectFile, fileName: entryFile, kind: "unsupported-parent-module-shape",
      detail: "the importer seed must be one synchronous acyclic module with a normal completion event",
    });
    if (integrity.status !== "verified" || integrity.transform !== undefined) unknowns.push({
      projectFile: candidate.owner.project.projectFile, fileName: candidate.declarationFile,
      kind: "declaration-integrity", detail: integrity.transform !== undefined
        ? "the initial cross-project TLA fragment does not discharge transformed declaration mappings"
        : integrity.message ?? `declaration integrity is ${integrity.status}`,
    });
    if (matchingParentUnknowns.length === 1 && otherParentUnknowns.length === 0 && straightLineChild && parentSimple
      && integrity.status === "verified" && integrity.transform === undefined) {
      links.push({
        fromProject: current.projectFile, toProject: candidate.owner.project.projectFile,
        importerFile: entryFile, dependencyEntryFile: candidate.dependencySource.fileName,
        declarationFile: candidate.declarationFile, importSpan: candidate.span,
        semanticRule: "ecma262-async-module-dependency-completion",
        sourceEvidence: { kind: "program-source", sourceDigest: digest(program.getSourceFile(entryFile)!.text) },
        declarationIntegrity: integrity,
      });
      constraints.push({
        before: childComplete!.id, after: `${entryFile}#start`,
        reason: "cross-project-static-dependency-completes",
        semanticRule: "ecma262-async-module-dependency-completion", link: 0,
      });
    }
  }
  const evidence = unknowns.length === 0 && links.length === 1 ? "verified" : "unknown";
  return {
    schema: "uneffect-workspace-module-order/v1", schemaVersion: 1, entryFile, evidence,
    domains, links, constraints, unknowns,
    claims: evidence === "verified" ? [
      "the exact child declaration maps to one analyzed source module",
      "child top-level await settles before normal completion permits importer execution",
      "child rejection prevents the represented importer start edge",
    ] : [],
    exclusions: [
      "only one direct child-project dependency with one straight-line top-level await is composed",
      "conditional or looping awaits, multiple child dependencies, and transitive project chains are not composed",
      "host scheduling time and independent compiler correctness are not proved",
    ],
  };
}

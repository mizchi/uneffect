import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

export interface TypeScriptCompilerProvenance {
  analyzerVersion: string;
  analyzerPackageFile: string;
  consumerVersion: string | null;
  consumerPackageFile: string | null;
  consumerModuleFile: string | null;
  parity: "exact" | "mismatch" | "unknown";
  reason?: string;
}

export interface TypeScriptProjectProvenance {
  projectFile: string;
  compiler: TypeScriptCompilerProvenance;
}

export interface TypeScriptProject {
  projectFile: string;
  fileNames: string[];
  compilerOptions: ts.CompilerOptions;
  provenance: TypeScriptProjectProvenance;
  projectReferences: readonly ts.ProjectReference[];
}

export interface TypeScriptProjectReference {
  from: string;
  to: string;
}

export interface TypeScriptWorkspaceBlocker {
  kind: "missing-reference" | "invalid-reference" | "reference-cycle" | "empty-project" | "duplicate-root-file";
  classification: "unknown";
  projectFile: string;
  message: string;
  reference?: string;
}

export interface TypeScriptWorkspace {
  rootProjectFile: string;
  /** Child-first order; every config retains its own compiler options. */
  projects: TypeScriptProject[];
  references: TypeScriptProjectReference[];
  blockers: TypeScriptWorkspaceBlocker[];
  /** Child-first topological order; meaningful only when no cycle blocker exists. */
  buildOrder: string[];
  buildArtifacts: TypeScriptBuildArtifactEvidence;
}

export interface TypeScriptBuildArtifactObservation {
  code: number;
  message: string;
}

export interface TypeScriptBuildArtifactEvidence {
  /** TypeScript SolutionBuilder freshness, not an independent output-content proof. */
  status: "fresh" | "stale" | "unknown";
  observations: TypeScriptBuildArtifactObservation[];
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
}

class TypeScriptProjectConfigError extends Error {
  constructor(message: string, readonly kind: "missing" | "invalid") {
    super(message);
    this.name = "TypeScriptProjectConfigError";
  }
}

const analyzerRequire = createRequire(import.meta.url);

function compilerProvenance(projectFile: string): TypeScriptCompilerProvenance {
  const analyzerPackageFile = analyzerRequire.resolve("typescript/package.json");
  const resolver = createRequire(projectFile);
  try {
    const consumerPackageFile = resolver.resolve("typescript/package.json");
    const consumerModuleFile = resolver.resolve("typescript");
    const manifestText = ts.sys.readFile(consumerPackageFile);
    if (manifestText === undefined) throw new Error("the resolved package manifest is unreadable");
    const manifest = JSON.parse(manifestText) as { version?: unknown };
    if (typeof manifest.version !== "string" || manifest.version.length === 0) throw new Error("the resolved package manifest has no string version");
    return {
      analyzerVersion: ts.version, analyzerPackageFile,
      consumerVersion: manifest.version, consumerPackageFile, consumerModuleFile,
      parity: manifest.version === ts.version ? "exact" : "mismatch",
      ...(manifest.version === ts.version ? {} : { reason: `consumer TypeScript ${manifest.version} differs from analyzer TypeScript ${ts.version}` }),
    };
  } catch (cause) {
    return {
      analyzerVersion: ts.version, analyzerPackageFile,
      consumerVersion: null, consumerPackageFile: null, consumerModuleFile: null, parity: "unknown",
      reason: `cannot resolve the consumer TypeScript package from ${dirname(projectFile)}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
}

function parseTypeScriptProject(absolute: string, allowEmpty: boolean): { project: TypeScriptProject; references: readonly ts.ProjectReference[] } {
  const loaded = ts.readConfigFile(absolute, ts.sys.readFile);
  if (loaded.error) throw new TypeScriptProjectConfigError(
    `cannot read TypeScript project ${absolute}: ${diagnosticMessage(loaded.error)}`,
    loaded.error.code === 5083 ? "missing" : "invalid",
  );
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(absolute), undefined, absolute);
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (errors.length > 0) {
    throw new TypeScriptProjectConfigError(`cannot read TypeScript project ${absolute}: ${errors.map(diagnosticMessage).join("; ")}`, "invalid");
  }
  if (!allowEmpty && parsed.fileNames.length === 0) throw new Error(`TypeScript project ${absolute} does not select any source files`);
  const references = parsed.projectReferences ?? [];
  return { project: {
    projectFile: absolute, fileNames: parsed.fileNames, compilerOptions: parsed.options,
    provenance: { projectFile: absolute, compiler: compilerProvenance(absolute) },
    projectReferences: references,
  }, references };
}

/** Load one compiler domain. Project references are intentionally not flattened here. */
export function loadTypeScriptProject(projectFile: string): TypeScriptProject {
  return parseTypeScriptProject(resolve(projectFile), false).project;
}

/** Resolve a solution graph while preserving one compiler-option domain per tsconfig. */
/* uneffect: effect Throw<Error> */
export function loadTypeScriptWorkspace(projectFile: string): TypeScriptWorkspace {
  const rootProjectFile = resolve(projectFile);
  const projects: TypeScriptProject[] = [], references: TypeScriptProjectReference[] = [], blockers: TypeScriptWorkspaceBlocker[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const roots = new Map<string, string>();

  const visit = (fileName: string, owner?: string): void => {
    const current = state.get(fileName);
    if (current === "visited") return;
    if (current === "visiting") {
      blockers.push({ kind: "reference-cycle", classification: "unknown", projectFile: owner ?? fileName, reference: fileName,
        message: `TypeScript project reference cycle reaches ${fileName}` });
      return;
    }
    state.set(fileName, "visiting");
    let parsed: ReturnType<typeof parseTypeScriptProject>;
    try { parsed = parseTypeScriptProject(fileName, true); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (fileName === rootProjectFile) throw new Error(message, { cause });
      blockers.push({
        kind: cause instanceof TypeScriptProjectConfigError && cause.kind === "missing" ? "missing-reference" : "invalid-reference",
        classification: "unknown", projectFile: owner ?? rootProjectFile, reference: fileName, message,
      });
      state.set(fileName, "visited");
      return;
    }
    for (const reference of parsed.references) {
      const target = ts.resolveProjectReferencePath(reference);
      references.push({ from: fileName, to: target });
      visit(target, fileName);
    }
    if (parsed.project.fileNames.length === 0 && parsed.references.length === 0) blockers.push({
      kind: "empty-project", classification: "unknown", projectFile: fileName,
      message: `TypeScript project ${fileName} does not select source files or reference another project`,
    });
    for (const source of parsed.project.fileNames) {
      const previous = roots.get(source);
      if (previous && previous !== fileName) blockers.push({
        kind: "duplicate-root-file", classification: "unknown", projectFile: fileName, reference: previous,
        message: `${source} is selected by both ${previous} and ${fileName}`,
      });
      else roots.set(source, fileName);
    }
    state.set(fileName, "visited");
    projects.push(parsed.project);
  };

  visit(rootProjectFile);
  const buildArtifactObservations: TypeScriptBuildArtifactObservation[] = [];
  const hasBuildArtifacts = references.length > 0 || projects.some((project) => project.compilerOptions.composite || project.compilerOptions.incremental);
  if (hasBuildArtifacts) {
    const diagnostics: ts.Diagnostic[] = [];
    const host = ts.createSolutionBuilderHost(ts.sys);
    host.reportDiagnostic = (diagnostic) => { diagnostics.push(diagnostic); };
    host.reportSolutionBuilderStatus = (diagnostic) => {
      if (diagnostic.code !== 6355 && diagnostic.code !== 6357 && diagnostic.code !== 6374) {
        buildArtifactObservations.push({ code: diagnostic.code, message: diagnosticMessage(diagnostic) });
      }
    };
    host.writeFile = () => undefined;
    ts.createSolutionBuilder(host, [rootProjectFile], { dry: true, verbose: true }).build();
    for (const diagnostic of diagnostics) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error || diagnostic.code === 5083 || diagnostic.code === 6202) continue;
      blockers.push({
        kind: "invalid-reference", classification: "unknown", projectFile: diagnostic.file?.fileName ?? rootProjectFile,
        message: `TypeScript solution graph TS${diagnostic.code}: ${diagnosticMessage(diagnostic)}`,
      });
    }
  }
  const root = projects.find((project) => project.projectFile === rootProjectFile);
  if (root && root.fileNames.length === 0 && references.length === 0) {
    throw new Error(`TypeScript project ${rootProjectFile} does not select any source files`);
  }
  const staleBuildCodes = new Set([6350, 6352, 6353, 6362, 6363, 6381, 6382, 6383, 6399, 6400, 6401, 6406, 6412, 6419, 6420]);
  const freshBuildCodes = new Set([6351, 6354, 6361]);
  const buildArtifactStatus = buildArtifactObservations.some((item) => staleBuildCodes.has(item.code)) ? "stale"
    : buildArtifactObservations.some((item) => freshBuildCodes.has(item.code)) ? "fresh" : "unknown";
  return {
    rootProjectFile, projects, references, blockers, buildOrder: projects.map((project) => project.projectFile),
    buildArtifacts: { status: buildArtifactStatus, observations: buildArtifactObservations },
  };
}

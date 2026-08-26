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
}

function diagnosticMessage(diagnostic: ts.Diagnostic): string {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
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

/** Load the consumer's TypeScript file set and compiler semantics without mutating them. */
export function loadTypeScriptProject(projectFile: string): TypeScriptProject {
  const absolute = resolve(projectFile);
  const loaded = ts.readConfigFile(absolute, ts.sys.readFile);
  if (loaded.error) throw new Error(`cannot read TypeScript project ${absolute}: ${diagnosticMessage(loaded.error)}`);
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, dirname(absolute), undefined, absolute);
  const errors = parsed.errors.filter((diagnostic) => diagnostic.code !== 18003);
  if (errors.length > 0) {
    throw new Error(`cannot read TypeScript project ${absolute}: ${errors.map(diagnosticMessage).join("; ")}`);
  }
  if (parsed.fileNames.length === 0) throw new Error(`TypeScript project ${absolute} does not select any source files`);
  return {
    projectFile: absolute, fileNames: parsed.fileNames, compilerOptions: parsed.options,
    provenance: { projectFile: absolute, compiler: compilerProvenance(absolute) },
  };
}

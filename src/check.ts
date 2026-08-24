import { readFile } from "node:fs/promises";
import ts from "typescript";
import { analyzeAsyncSafetyInProgram } from "./async-safety.js";
import { verifyContractObligations, type VerificationArtifact } from "./contracts.js";
import type { CheckerDiagnostic } from "./diagnostics.js";
import { analyzeProgramEffects, type EffectSummary } from "./effects.js";

export interface CheckOptions {
  /** `gradual` (default) reports unknown effects as warnings; `strict` fails on them. */
  mode?: "gradual" | "strict";
  /** `false` only reports functions that already carry an effect declaration. */
  requireAnnotations?: boolean;
  /** Reusable host; `createCheckHost()` shares parsed library files across many one-file programs. */
  host?: ts.CompilerHost;
}

export interface CheckResult {
  diagnostics: CheckerDiagnostic[];
  /** Source text per absolute file name, so a report can quote the offending line. */
  sources: Map<string, string>;
  /** Evidence for what was checked, including the obligations that were proved. */
  artifacts: VerificationArtifact[];
  summaries: EffectSummary[];
  errors: number;
  warnings: number;
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
};

/** A compiler host that keeps library declarations parsed once across repeated single-file programs. */
export function createCheckHost(): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions), cache = new Map<string, ts.SourceFile | undefined>();
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!fileName.endsWith(".d.ts")) return read(fileName, languageVersion, onError, shouldCreate);
    if (!cache.has(fileName)) cache.set(fileName, read(fileName, languageVersion, onError, shouldCreate));
    return cache.get(fileName);
  };
  return host;
}

/** Run every checker the CLI runs — effects, contracts, async safety — over one set of files. */
export async function checkFiles(fileNames: readonly string[], options: CheckOptions = {}): Promise<CheckResult> {
  const program = ts.createProgram([...fileNames], compilerOptions, options.host);
  const effects = analyzeProgramEffects(program, { mode: options.mode ?? "gradual", requireAnnotations: options.requireAnnotations ?? true });
  const diagnostics: CheckerDiagnostic[] = [...effects.diagnostics];
  const sources = new Map<string, string>(), artifacts: VerificationArtifact[] = [];
  for (const fileName of fileNames) {
    const text = await readFile(fileName, "utf8");
    sources.set(fileName, text);
    const contracts = await verifyContractObligations(fileName, text);
    diagnostics.push(...contracts.diagnostics);
    artifacts.push(...contracts.artifacts);
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile) diagnostics.push(...analyzeAsyncSafetyInProgram(program, sourceFile).diagnostics);
  }
  const errors = diagnostics.filter((diagnostic) => !("severity" in diagnostic) || diagnostic.severity === "error").length;
  return { diagnostics, sources, artifacts, summaries: effects.summaries, errors, warnings: diagnostics.length - errors };
}

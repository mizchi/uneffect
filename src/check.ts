import { readFile } from "node:fs/promises";
import ts from "typescript";
import { analyzeAsyncSafetyInProgram } from "./async-safety.js";
import { verifyContractObligations, type VerificationArtifact } from "./contracts.js";
import { fromTypeScriptDiagnostic, type CheckerDiagnostic, type TypeScriptCheckerDiagnostic } from "./diagnostics.js";
import { analyzeProgramEffects, type EffectSummary, type ExternalFunctionEffectContract, type ExternalModuleEffectContract } from "./effects.js";
import { analyzeReactProgram } from "./react-semantics.js";
import type { BuiltinContractRegistry } from "./builtin-contracts.js";
import type { TypeScriptProjectProvenance } from "./typescript-project.js";
import { collectAssumptionLedger, type AssumptionLedger } from "./assumptions.js";

export interface CheckOptions {
  /** `gradual` (default) reports unknown effects as warnings; `strict` fails on them. */
  mode?: "gradual" | "strict";
  /** `false` only reports functions that already carry an effect declaration. */
  requireAnnotations?: boolean;
  /** Reusable host; `createCheckHost()` shares parsed library files across many one-file programs. */
  host?: ts.CompilerHost;
  /** Caller-owned, versioned semantic contracts. Defaults to Uneffect's registry. */
  builtinRegistry?: BuiltinContractRegistry;
  /** Consumer compiler semantics, normally loaded from its tsconfig.json. */
  compilerOptions?: ts.CompilerOptions;
  /** Exact project/compiler identity used to qualify TypeChecker-derived assurance. */
  project?: TypeScriptProjectProvenance;
  /** Native TypeScript project-reference edges for this compiler domain. */
  projectReferences?: readonly ts.ProjectReference[];
  /** Reuse the exact Program used to resolve cross-project declaration identities. */
  program?: ts.Program;
  /** Verified child-program function contracts keyed by resolved declaration id. */
  externalFunctionEffects?: ReadonlyMap<string, ExternalFunctionEffectContract>;
  /** Verified child-program module-evaluation contracts keyed by declaration file. */
  externalModuleEffects?: ReadonlyMap<string, ExternalModuleEffectContract>;
}

export interface CheckResult {
  diagnostics: CheckerDiagnostic[];
  /** Source text per absolute file name, so a report can quote the offending line. */
  sources: Map<string, string>;
  /** Evidence for what was checked, including the obligations that were proved. */
  artifacts: VerificationArtifact[];
  summaries: EffectSummary[];
  /** Every trusted semantic input used by this exact check boundary. */
  assumptions: AssumptionLedger;
  errors: number;
  warnings: number;
  project?: TypeScriptProjectProvenance;
}

const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
};

/** A compiler host that keeps library declarations parsed once across repeated single-file programs. */
export function createCheckHost(options: ts.CompilerOptions = compilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options), cache = new Map<string, ts.SourceFile | undefined>();
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (!fileName.endsWith(".d.ts")) return read(fileName, languageVersion, onError, shouldCreate);
    if (!cache.has(fileName)) cache.set(fileName, read(fileName, languageVersion, onError, shouldCreate));
    return cache.get(fileName);
  };
  return host;
}

export function createCheckProgram(fileNames: readonly string[], options: CheckOptions = {}): ts.Program {
  const effectiveCompilerOptions = options.compilerOptions ?? compilerOptions;
  return ts.createProgram({
    rootNames: [...fileNames], options: effectiveCompilerOptions, host: options.host,
    projectReferences: options.projectReferences,
  });
}

/** Run every checker the CLI runs — effects, contracts, async safety — over one set of files. */
export async function checkFiles(fileNames: readonly string[], options: CheckOptions = {}): Promise<CheckResult> {
  const program = options.program ?? createCheckProgram(fileNames, options);
  const effects = analyzeProgramEffects(program, {
    mode: options.mode ?? "gradual", requireAnnotations: options.requireAnnotations ?? true,
    builtinRegistry: options.builtinRegistry,
    externalFunctionEffects: options.externalFunctionEffects,
    externalModuleEffects: options.externalModuleEffects,
  });
  const react = analyzeReactProgram(program);
  const diagnostics: CheckerDiagnostic[] = [];
  for (const fileName of fileNames) {
    const source = program.getSourceFile(fileName);
    if (!source) continue;
    diagnostics.push(
      ...program.getSyntacticDiagnostics(source).map((diagnostic) => fromTypeScriptDiagnostic(diagnostic, "syntax")),
      ...program.getSemanticDiagnostics(source).map((diagnostic) => fromTypeScriptDiagnostic(diagnostic, "semantic")),
    );
  }
  diagnostics.push(...program.getOptionsDiagnostics().map((diagnostic) => fromTypeScriptDiagnostic(diagnostic, "options")));
  const invalidSources = new Set(diagnostics.filter((diagnostic): diagnostic is TypeScriptCheckerDiagnostic =>
    "domain" in diagnostic && diagnostic.domain === "typescript" && diagnostic.severity === "error" && diagnostic.fileName !== "<typescript-options>")
    .map((diagnostic) => diagnostic.fileName));
  for (const summary of effects.summaries) if (summary.fileName && invalidSources.has(summary.fileName)) summary.evidence = "unknown";
  diagnostics.push(...effects.diagnostics);
  const sources = new Map<string, string>(), artifacts: VerificationArtifact[] = [];
  for (const fileName of fileNames) {
    const text = await readFile(fileName, "utf8");
    sources.set(fileName, text);
    const contracts = await verifyContractObligations(fileName, text);
    diagnostics.push(...contracts.diagnostics);
    artifacts.push(...contracts.artifacts);
    const sourceFile = program.getSourceFile(fileName);
    if (sourceFile) {
      diagnostics.push(...(react.get(sourceFile.fileName)?.diagnostics ?? []));
      diagnostics.push(...analyzeAsyncSafetyInProgram(program, sourceFile).diagnostics);
    }
  }
  const errors = diagnostics.filter((diagnostic) => !("severity" in diagnostic) || diagnostic.severity === "error").length;
  const assumptions = collectAssumptionLedger(program, Object.fromEntries(sources), undefined, {}, options.builtinRegistry).ledger;
  return {
    diagnostics, sources, artifacts, summaries: effects.summaries, assumptions, errors, warnings: diagnostics.length - errors,
    ...(options.project === undefined ? {} : { project: options.project }),
  };
}

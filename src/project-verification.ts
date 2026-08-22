import ts from "typescript";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAsyncPatterns, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "./async-patterns.js";
import { verifyContractObligations, type ContractDiagnostic, type VerificationArtifact } from "./contracts.js";
import { instrumentRuntimeAssertions, type InstrumentDiagnostic } from "./instrument.js";
import { analyzePromiseChains } from "./promise-chains.js";
import { analyzeOwnership, type OwnershipDiagnostic } from "./ownership.js";
import { verifyTypedArraySafetyInProgram, type TypedArrayDiagnostic, type TypedArrayProgramSafetyResult } from "./typed-array-safety.js";
import { collectAssumptionLedger, type AssumptionLedger, type AssumptionPolicy, type AssumptionPolicyDiagnostic } from "./assumptions.js";
import { extractAnnotations } from "./annotations.js";
import { parseTemporalComposition } from "./temporal-compose.js";
import { analyzeProgramEffects, type EffectAnalysisResult, type EffectDiagnostic } from "./effects.js";

export interface VerifyUneffectProjectOptions {
  files: Record<string, string>;
  runtimeAssertions?: "off" | "fallback";
  temporalRuntime?: "web" | "node";
  temporalRoot?: string;
  assumptionPolicy?: AssumptionPolicy;
}

export interface ProjectVerificationObligation extends VerificationArtifact {
  backend: "z3";
  result: VerificationArtifact["status"];
}

export interface VerifyUneffectProjectResult {
  obligations: ProjectVerificationObligation[];
  diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic | TypedArrayDiagnostic | ProjectOwnershipDiagnostic | AssumptionPolicyDiagnostic | EffectDiagnostic>;
  emittedFiles: Record<string, string>;
  typedArrays: TypedArrayProgramSafetyResult;
  ownership: { diagnostics: ProjectOwnershipDiagnostic[] };
  assumptions: AssumptionLedger;
  effects: EffectAnalysisResult;
  temporal?: ProjectTemporalVerification;
}

export interface ProjectOwnershipDiagnostic extends OwnershipDiagnostic {
  fileName: string;
  kind: "ownership";
}

export interface ProjectTemporalProperty {
  name: string;
  result: "verified" | "counterexample" | "error";
  output: string;
}

export interface ProjectTemporalModel {
  fileName: string;
  kind: "web-event-loop" | "node-event-loop";
  quint: string;
}

export interface ProjectTemporalVerification {
  sourceLanguage: "uneffect-ts";
  backend: "quint";
  models: ProjectTemporalModel[];
  properties: ProjectTemporalProperty[];
}

function javascriptPath(fileName: string): string {
  return fileName.replace(/\.(?:mts|cts|tsx|ts)$/, ".js");
}

function inMemoryProgram(files: Readonly<Record<string, string>>): ts.Program {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    types: ["node"],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => Object.hasOwn(files, fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => files[fileName] ?? ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, fresh) => Object.hasOwn(files, fileName)
    ? ts.createSourceFile(fileName, files[fileName]!, languageVersion, true, ts.ScriptKind.TS)
    : originalGetSourceFile(fileName, languageVersion, onError, fresh);
  return ts.createProgram(Object.keys(files), compilerOptions, host);
}

function verifyQuintInvariant(program: string, invariant: string): ProjectTemporalProperty {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-project-quint-"));
  const path = join(directory, "model.qnt");
  try {
    writeFileSync(path, program);
    const verification = spawnSync("pnpm", ["exec", "quint", "run", path, `--invariant=${invariant}`, "--max-steps=12", "--max-samples=500", "--seed=0x756e656666656374", "--verbosity=1"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const output = `${verification.stdout ?? ""}${verification.stderr ?? ""}`;
    const result = verification.error ? "error" : verification.status === 0 ? "verified" : /violation|counterexample/i.test(output) ? "counterexample" : "error";
    return { name: invariant, result, output };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function verifyUneffectProject(options: VerifyUneffectProjectOptions): Promise<VerifyUneffectProjectResult> {
  const obligations: ProjectVerificationObligation[] = [];
  const diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic | TypedArrayDiagnostic | ProjectOwnershipDiagnostic | AssumptionPolicyDiagnostic | EffectDiagnostic> = [];
  const emittedFiles: Record<string, string> = {};
  const temporalModels: ProjectTemporalModel[] = [];
  const temporalProperties: ProjectTemporalProperty[] = [];
  const typedArrays = await verifyTypedArraySafetyInProgram(options.files);
  const program = inMemoryProgram(options.files);
  const effects = analyzeProgramEffects(program, { requireAnnotations: false });
  diagnostics.push(...effects.diagnostics);
  const ownershipDiagnostics: ProjectOwnershipDiagnostic[] = [];
  for (const fileName of Object.keys(options.files)) {
    const sourceFile = program.getSourceFile(fileName);
    if (!sourceFile) continue;
    ownershipDiagnostics.push(...analyzeOwnership(program, sourceFile).map((diagnostic) => ({ ...diagnostic, fileName, kind: "ownership" as const })));
  }
  for (const ownership of ownershipDiagnostics) {
    if (ownership.operation !== "read" || !["detached", "transferred", "locked"].includes(ownership.state)) continue;
    const result = typedArrays.files[ownership.fileName];
    const source = options.files[ownership.fileName];
    if (!result || source === undefined) continue;
    for (const obligation of result.obligations) {
      if (obligation.kind !== "dataview-backing-bounds" || obligation.span.end < ownership.span.end) continue;
      if (!source.slice(obligation.span.start, obligation.span.end).includes(ownership.resource)) continue;
      obligation.result = "counterexample";
      if (!result.diagnostics.some((item) => item.kind === obligation.kind && item.span.start === obligation.span.start)) result.diagnostics.push({
        fileName: ownership.fileName,
        functionName: obligation.functionName,
        kind: obligation.kind,
        span: obligation.span,
        message: `fixed-buffer evidence for ${ownership.resource} was invalidated after it became ${ownership.state}`,
      });
    }
  }
  typedArrays.obligations = Object.values(typedArrays.files).flatMap((result) => result.obligations);
  typedArrays.diagnostics = Object.values(typedArrays.files).flatMap((result) => result.diagnostics);
  diagnostics.push(...typedArrays.diagnostics, ...ownershipDiagnostics);
  const assumptions = collectAssumptionLedger(program, options.files, typedArrays, options.assumptionPolicy);
  diagnostics.push(...assumptions.diagnostics);
  for (const [fileName, source] of Object.entries(options.files)) {
    const verification = await verifyContractObligations(fileName, source);
    obligations.push(...verification.artifacts.map((artifact) => ({ ...artifact, backend: "z3" as const, result: artifact.status })));
    diagnostics.push(...verification.diagnostics);
    const instrumented = options.runtimeAssertions === "fallback" ? instrumentRuntimeAssertions(fileName, source) : { code: source, diagnostics: [] };
    diagnostics.push(...instrumented.diagnostics);
    emittedFiles[javascriptPath(fileName)] = ts.transpileModule(instrumented.code, {
      fileName,
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText;
    if (options.temporalRuntime === "web") {
      const temporalComposition = extractAnnotations(source, "state").length > 0
        ? parseTemporalComposition(fileName, source, options.temporalRoot ?? "main")
        : undefined;
      const quint = generateWebEventLoopQuint(
        fileName.replace(/[^A-Za-z0-9_]/g, "_"),
        analyzeAsyncPatterns(fileName, source),
        {},
        analyzePromiseChains(fileName, source),
        temporalComposition,
      );
      temporalModels.push({ fileName, kind: "web-event-loop", quint });
      temporalProperties.push(verifyQuintInvariant(quint, "eventLoopSafe"));
      for (const property of temporalComposition?.properties ?? []) temporalProperties.push(verifyQuintInvariant(quint, property.name));
    } else if (options.temporalRuntime === "node") {
      const quint = generateNodeEventLoopQuint(fileName.replace(/[^A-Za-z0-9_]/g, "_"), analyzeAsyncPatterns(fileName, source), {}, analyzePromiseChains(fileName, source));
      temporalModels.push({ fileName, kind: "node-event-loop", quint });
      temporalProperties.push(verifyQuintInvariant(quint, "nodeEventLoopSafe"));
    }
  }
  const temporal = options.temporalRuntime === "web" || options.temporalRuntime === "node"
    ? { sourceLanguage: "uneffect-ts" as const, backend: "quint" as const, models: temporalModels, properties: temporalProperties }
    : undefined;
  return { obligations, diagnostics, emittedFiles, typedArrays, ownership: { diagnostics: ownershipDiagnostics }, assumptions: assumptions.ledger, effects, ...(temporal ? { temporal } : {}) };
}

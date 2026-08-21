import ts from "typescript";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAsyncPatterns, generateWebEventLoopQuint } from "./async-patterns.js";
import { verifyContractObligations, type ContractDiagnostic, type VerificationArtifact } from "./contracts.js";
import { instrumentRuntimeAssertions, type InstrumentDiagnostic } from "./instrument.js";
import { analyzePromiseChains } from "./promise-chains.js";

export interface VerifyUneffectProjectOptions {
  files: Record<string, string>;
  runtimeAssertions?: "off" | "fallback";
  temporalRuntime?: "web";
}

export interface ProjectVerificationObligation extends VerificationArtifact {
  backend: "z3";
  result: VerificationArtifact["status"];
}

export interface VerifyUneffectProjectResult {
  obligations: ProjectVerificationObligation[];
  diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic>;
  emittedFiles: Record<string, string>;
  temporal?: ProjectTemporalVerification;
}

export interface ProjectTemporalProperty {
  name: string;
  result: "verified" | "counterexample" | "error";
  output: string;
}

export interface ProjectTemporalModel {
  fileName: string;
  kind: "web-event-loop";
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
  const diagnostics: Array<ContractDiagnostic | InstrumentDiagnostic> = [];
  const emittedFiles: Record<string, string> = {};
  const temporalModels: ProjectTemporalModel[] = [];
  const temporalProperties: ProjectTemporalProperty[] = [];
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
      const quint = generateWebEventLoopQuint(
        fileName.replace(/[^A-Za-z0-9_]/g, "_"),
        analyzeAsyncPatterns(fileName, source),
        {},
        analyzePromiseChains(fileName, source),
      );
      temporalModels.push({ fileName, kind: "web-event-loop", quint });
      temporalProperties.push(verifyQuintInvariant(quint, "eventLoopSafe"));
    }
  }
  const temporal = options.temporalRuntime === "web"
    ? { sourceLanguage: "uneffect-ts" as const, backend: "quint" as const, models: temporalModels, properties: temporalProperties }
    : undefined;
  return { obligations, diagnostics, emittedFiles, ...(temporal ? { temporal } : {}) };
}

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import ts from "typescript";
import { generateOwnershipObligationQuint, generateOwnershipObligationSmt, type OwnershipGuardObligation } from "./async-safety.js";
import { builtinContractRegistry } from "./builtin-contracts.js";
import { formatEffect } from "./capabilities.js";
import type { EffectSummary, EvidenceStatus } from "./effects.js";
import { createZ3Context, z3Version } from "./z3.js";

export interface EvidenceArtifactSummary {
  functionName: string;
  effects: string[];
  evidence: EvidenceStatus;
  iteratorEffectParameters?: Array<{ index: number; name: string; convertsThrowToRejection: boolean }>;
  iteratorEffectBounds?: Array<{ index: number; name: string; effects: string[] }>;
}
export interface EvidenceArtifact {
  schemaVersion: 2;
  uneffectVersion: string;
  compilerRevision: string;
  tsconfigHash: string;
  sourceHash: string;
  builtinContractDigest: string;
  summaries: EvidenceArtifactSummary[];
}

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
export function builtinContractDigest(): string { return digest(JSON.stringify(builtinContractRegistry)); }
export function createEvidenceArtifact(program: ts.Program, source: ts.SourceFile, summaries: readonly EffectSummary[]): EvidenceArtifact {
  return {
    schemaVersion: 2,
    uneffectVersion: "0.1.0",
    compilerRevision: ts.version,
    tsconfigHash: digest(JSON.stringify(program.getCompilerOptions(), Object.keys(program.getCompilerOptions()).sort())),
    sourceHash: digest(source.text),
    builtinContractDigest: builtinContractDigest(),
    summaries: summaries.map((summary) => ({
      functionName: summary.functionName,
      effects: summary.effects.map(formatEffect).sort(),
      evidence: summary.evidence,
      ...(summary.iteratorEffectParameters ? { iteratorEffectParameters: summary.iteratorEffectParameters } : {}),
      ...(summary.iteratorEffectBounds ? { iteratorEffectBounds: summary.iteratorEffectBounds.map((bound) => ({
        index: bound.index, name: bound.name, effects: bound.effects.map(formatEffect).sort(),
      })) } : {}),
    })),
  };
}

export function trustedSummary(functionName: string, effects: EffectSummary["effects"]): EffectSummary {
  return { functionName, effects, evidence: "trusted" };
}

export interface OwnershipEvidenceArtifact {
  schema: "ownership-evidence/v1";
  backend: "z3" | "quint";
  backendVersion: string;
  obligationHash: string;
  verifierProgramHash: string;
  result: "verified" | "counterexample" | "unknown" | "error";
  evidence: "verified" | "unknown";
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** The optional Quint peer, run through its own entry point instead of whatever `quint` PATH holds. */
function resolveQuint(): { bin: string; version: string } | undefined {
  for (const resolver of [createRequire(join(process.cwd(), "package.json")), createRequire(import.meta.url)]) {
    try {
      const manifestPath = resolver.resolve("@informalsystems/quint/package.json");
      const manifest = resolver(manifestPath) as { version?: string; bin?: Record<string, string> | string };
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.quint;
      if (entry) return { bin: join(dirname(manifestPath), entry), version: manifest.version ?? "unknown" };
    } catch {
      continue;
    }
  }
  return undefined;
}

function ownershipObligationHash(obligation: OwnershipGuardObligation): string {
  return digest(JSON.stringify(obligation));
}

/**
 * Runs the generated refutation query and binds the result to all reproducibility inputs.
 * The solver is the `z3-solver` WASM build, so no native Z3 installation is involved.
 */
export async function verifyOwnershipObligationWithZ3(obligation: OwnershipGuardObligation): Promise<OwnershipEvidenceArtifact> {
  const program = generateOwnershipObligationSmt(obligation);
  const base = {
    schema: "ownership-evidence/v1" as const, backend: "z3" as const, backendVersion: await z3Version(),
    obligationHash: ownershipObligationHash(obligation), verifierProgramHash: digest(program),
  };
  try {
    const context = await createZ3Context("ownership");
    const solver = new context.Solver();
    solver.fromString(program);
    const answer = String(await solver.check());
    const result = answer === "unsat" ? "verified" : answer === "sat" ? "counterexample" : "unknown";
    return { ...base, result, evidence: result === "verified" ? "verified" : "unknown", exitCode: 0, stdout: `${answer}\n`, stderr: "" };
  } catch (cause) {
    return { ...base, result: "error", evidence: "unknown", exitCode: 1, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function verifyOwnershipObligationWithQuint(obligation: OwnershipGuardObligation): OwnershipEvidenceArtifact {
  const program = generateOwnershipObligationQuint("ownership_evidence", obligation);
  const quint = resolveQuint();
  const directory = mkdtempSync(join(tmpdir(), "uneffect-ownership-")), fileName = join(directory, "model.qnt");
  writeFileSync(fileName, program);
  const missing = { error: new Error("@informalsystems/quint is not installed; add the optional peer dependency to verify ownership with Quint"), status: null, stdout: "", stderr: "" };
  const execution: { error?: Error; status: number | null; stdout: string; stderr: string } = quint
    ? spawnSync(process.execPath, [quint.bin, "verify", fileName, "--backend=tlc", "--invariant=ownershipSafe", "--max-steps=1", "--verbosity=5"], { encoding: "utf8", timeout: 30_000 })
    : missing;
  rmSync(directory, { recursive: true });
  const output = `${execution.stdout}${execution.stderr}`;
  const result = execution.error ? "error" : execution.status === 0 ? "verified" : /violation|counterexample/i.test(output) ? "counterexample" : "unknown";
  return {
    schema: "ownership-evidence/v1", backend: "quint", backendVersion: quint?.version ?? "unknown",
    obligationHash: ownershipObligationHash(obligation), verifierProgramHash: digest(program), result,
    evidence: result === "verified" ? "verified" : "unknown", exitCode: execution.status,
    stdout: execution.stdout, stderr: execution.error ? `${execution.stderr}${execution.error.message}` : execution.stderr,
  };
}

/** Rejects stale, tampered, non-proof, or differently generated evidence. */
export function validateOwnershipEvidence(artifact: OwnershipEvidenceArtifact, obligation: OwnershipGuardObligation): boolean {
  const program = artifact.backend === "z3" ? generateOwnershipObligationSmt(obligation) : generateOwnershipObligationQuint("ownership_evidence", obligation);
  return artifact.schema === "ownership-evidence/v1"
    && artifact.result === "verified"
    && artifact.evidence === "verified"
    && artifact.exitCode === 0
    && artifact.obligationHash === ownershipObligationHash(obligation)
    && artifact.verifierProgramHash === digest(program);
}

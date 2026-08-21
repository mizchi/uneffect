import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { generateOwnershipObligationQuint, generateOwnershipObligationSmt, type OwnershipGuardObligation } from "./async-safety.js";
import { builtinContractRegistry } from "./builtin-contracts.js";
import { formatEffect } from "./capabilities.js";
import type { EffectSummary, EvidenceStatus } from "./effects.js";

export interface EvidenceArtifactSummary {
  functionName: string;
  effects: string[];
  evidence: EvidenceStatus;
}
export interface EvidenceArtifact {
  schemaVersion: 1;
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
    schemaVersion: 1,
    uneffectVersion: "0.1.0",
    compilerRevision: ts.version,
    tsconfigHash: digest(JSON.stringify(program.getCompilerOptions(), Object.keys(program.getCompilerOptions()).sort())),
    sourceHash: digest(source.text),
    builtinContractDigest: builtinContractDigest(),
    summaries: summaries.map((summary) => ({ functionName: summary.functionName, effects: summary.effects.map(formatEffect).sort(), evidence: summary.evidence })),
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

function ownershipObligationHash(obligation: OwnershipGuardObligation): string {
  return digest(JSON.stringify(obligation));
}

/** Runs the generated refutation query and binds the result to all reproducibility inputs. */
export function verifyOwnershipObligationWithZ3(obligation: OwnershipGuardObligation): OwnershipEvidenceArtifact {
  const program = generateOwnershipObligationSmt(obligation);
  const version = spawnSync("z3", ["-version"], { encoding: "utf8" });
  const execution = spawnSync("z3", ["-in"], { input: program, encoding: "utf8" });
  const answer = execution.stdout.trim().split(/\s+/)[0];
  const result = execution.error || execution.status !== 0 ? "error" : answer === "unsat" ? "verified" : answer === "sat" ? "counterexample" : "unknown";
  return {
    schema: "ownership-evidence/v1", backend: "z3", backendVersion: version.stdout.trim() || version.stderr.trim() || "unknown",
    obligationHash: ownershipObligationHash(obligation), verifierProgramHash: digest(program), result,
    evidence: result === "verified" ? "verified" : "unknown", exitCode: execution.status,
    stdout: execution.stdout, stderr: execution.error ? `${execution.stderr}${execution.error.message}` : execution.stderr,
  };
}

export function verifyOwnershipObligationWithQuint(obligation: OwnershipGuardObligation): OwnershipEvidenceArtifact {
  const program = generateOwnershipObligationQuint("ownership_evidence", obligation);
  const version = spawnSync("quint", ["--version"], { encoding: "utf8" });
  const directory = mkdtempSync(join(tmpdir(), "uneffect-ownership-")), fileName = join(directory, "model.qnt");
  writeFileSync(fileName, program);
  const execution = spawnSync("quint", ["verify", fileName, "--backend=tlc", "--invariant=ownershipSafe", "--max-steps=1", "--verbosity=5"], { encoding: "utf8", timeout: 30_000 });
  rmSync(directory, { recursive: true });
  const output = `${execution.stdout}${execution.stderr}`;
  const result = execution.error ? "error" : execution.status === 0 ? "verified" : /violation|counterexample/i.test(output) ? "counterexample" : "unknown";
  return {
    schema: "ownership-evidence/v1", backend: "quint", backendVersion: version.stdout.trim() || version.stderr.trim() || "unknown",
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

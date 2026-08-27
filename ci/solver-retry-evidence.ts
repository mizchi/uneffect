import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SolverProcessAttempt {
  attempt: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  hardTimeout: boolean;
  retryReason?: "recognized-wasm-failure" | "hard-timeout" | "external-process-timeout";
  failureKind?: SolverFailureKind;
  /** The SMT-LIB execution that was incomplete or returned an infrastructure error. */
  programDigest?: string;
  /** Every SMT-LIB input entered by this fresh process attempt. */
  programDigests?: readonly string[];
  durationMs?: number;
  /** Captured output is written beside the manifest rather than embedded in it. */
  stdout?: string;
  stderr?: string;
}

export type SolverFailureKind =
  | "hard-timeout"
  | "wasm-oom"
  | "wasm-memory-fault"
  | "wasm-heap-corruption"
  | "z3-internal-assertion"
  | "known-timeout"
  | "external-process-timeout";

export type SolverRetryClassification =
  | "clean-first-attempt"
  | "transient-runtime-failure"
  | "deterministic-resource-limit"
  | "reproducible-runtime-failure"
  | "transient-external-process-failure"
  | "reproducible-external-process-failure"
  | "inconclusive";

export interface RecordedSolverProcessAttempt extends Omit<SolverProcessAttempt, "stdout" | "stderr"> {
  timestamp: string;
  process: ReturnType<typeof processTelemetry>;
  stdoutPath?: string;
  stdoutDigest?: string;
  stderrPath?: string;
  stderrDigest?: string;
}

export interface SolverRetryAssessment {
  classification: SolverRetryClassification;
  finalOutcome: "passed" | "passed-after-retry" | "failed";
  programDigest?: string;
  reason: string;
}

function processTelemetry() {
  const memory = process.memoryUsage();
  return { pid: process.pid, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external };
}

export function classifySolverRetryAttempts(
  attempts: readonly RecordedSolverProcessAttempt[],
  maxAttempts: number,
): SolverRetryAssessment {
  const finalAttempt = attempts.at(-1);
  if (!finalAttempt) return { classification: "inconclusive", finalOutcome: "failed", reason: "no process attempts were recorded" };
  if (attempts.length === 1 && finalAttempt.status === 0) {
    return { classification: "clean-first-attempt", finalOutcome: "passed", reason: "the first process attempt passed" };
  }
  const failures = attempts.filter(({ status }) => status !== 0);
  if (failures.length > 0 && failures.every(({ failureKind }) => failureKind === "external-process-timeout")) {
    if (finalAttempt.status === 0) {
      return {
        classification: "transient-external-process-failure",
        finalOutcome: "passed-after-retry",
        reason: "the same verifier-bearing test file or selector passed in a fresh process after a process-level timeout",
      };
    }
    if (attempts.length >= maxAttempts) {
      return {
        classification: "reproducible-external-process-failure",
        finalOutcome: "failed",
        reason: "the external verifier process timed out in every fresh isolated attempt",
      };
    }
    return { classification: "inconclusive", finalOutcome: "failed", reason: "the external verifier retry budget was not exhausted" };
  }
  if (failures.some(({ programDigest }) => !programDigest)) {
    return { classification: "inconclusive", finalOutcome: finalAttempt.status === 0 ? "passed-after-retry" : "failed", reason: "a failed attempt has no recorded SMT-LIB digest" };
  }
  const failureDigests = [...new Set(failures.map(({ programDigest }) => programDigest!))];
  if (failureDigests.length !== 1) {
    return { classification: "inconclusive", finalOutcome: finalAttempt.status === 0 ? "passed-after-retry" : "failed", reason: "attempts did not fail on one recorded SMT-LIB digest" };
  }
  const programDigest = failureDigests[0]!;
  if (finalAttempt.status === 0) {
    const completedDigests = new Set(finalAttempt.programDigests ?? (finalAttempt.programDigest ? [finalAttempt.programDigest] : []));
    if (!completedDigests.has(programDigest)) {
      return { classification: "inconclusive", finalOutcome: "passed-after-retry", programDigest, reason: "the successful retry did not execute the failed SMT-LIB digest" };
    }
    return { classification: "transient-runtime-failure", finalOutcome: "passed-after-retry", programDigest, reason: "the same SMT-LIB digest passed in a fresh process after an infrastructure failure" };
  }
  if (attempts.length < maxAttempts) {
    return { classification: "inconclusive", finalOutcome: "failed", programDigest, reason: "the retry budget was not exhausted" };
  }
  const kinds = failures.map(({ failureKind }) => failureKind);
  if (kinds.every((kind) => kind === "hard-timeout" || kind === "known-timeout" || kind === "wasm-oom")) {
    return { classification: "deterministic-resource-limit", finalOutcome: "failed", programDigest, reason: "the same SMT-LIB digest exhausted time or memory in every fresh process attempt" };
  }
  if (kinds.every((kind) => kind === "wasm-memory-fault" || kind === "wasm-heap-corruption" || kind === "z3-internal-assertion")) {
    return { classification: "reproducible-runtime-failure", finalOutcome: "failed", programDigest, reason: "the same SMT-LIB digest reproduced a solver runtime failure in every fresh process attempt" };
  }
  return { classification: "inconclusive", finalOutcome: "failed", programDigest, reason: "attempt failure kinds were missing or heterogeneous" };
}

function readAttemptPrograms(directory: string): Pick<SolverProcessAttempt, "programDigest" | "programDigests"> {
  const executions = readdirSync(directory).filter((file) => file.endsWith(".jsonl")).sort().flatMap((file) => {
    try {
      const records = readFileSync(join(directory, file), "utf8").trim().split("\n")
        .filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line) as { event?: string; programDigest?: string; status?: string; timestamp?: string }]; }
          catch { return []; }
        });
      const start = records.find(({ event }) => event === "start");
      const complete = records.findLast(({ event }) => event === "complete");
      return start?.programDigest ? [{ digest: start.programDigest, timestamp: start.timestamp ?? "", failed: !complete || complete.status === "error" }] : [];
    } catch {
      return [];
    }
  });
  const programDigests = [...new Set(executions.map(({ digest }) => digest))];
  const failed = executions.filter(({ failed }) => failed).sort((left, right) => left.timestamp.localeCompare(right.timestamp)).at(-1);
  return { programDigest: failed?.digest, programDigests };
}

/**
 * Owns evidence directories for one isolated Vitest selector. A clean first
 * attempt is discarded; once a retry occurs all process and solver evidence is
 * retained so a later green attempt cannot erase the original failure.
 */
export function createSolverRetryEvidenceSession(
  root: string,
  tier: string,
  source: string,
  testName: string,
  maxAttempts = 3,
  command?: readonly string[],
) {
  const identity = createHash("sha256").update(`${tier}\0${source}\0${testName}`).digest("hex").slice(0, 16);
  const directory = join(root, tier, `${identity}-${process.pid}-${Date.now()}`);
  const startedAt = new Date().toISOString();
  const attempts: RecordedSolverProcessAttempt[] = [];
  const attemptDirectories = new Map<number, string>();
  return {
    directory,
    environmentForAttempt(attempt: number): NodeJS.ProcessEnv {
      const attemptDirectory = join(directory, `attempt-${attempt}`);
      mkdirSync(attemptDirectory, { recursive: true });
      attemptDirectories.set(attempt, attemptDirectory);
      return { UNEFFECT_SOLVER_EVIDENCE_DIR: attemptDirectory };
    },
    recordAttempt(attempt: SolverProcessAttempt) {
      const attemptDirectory = attemptDirectories.get(attempt.attempt);
      const programs = attemptDirectory ? readAttemptPrograms(attemptDirectory) : {};
      const { stdout, stderr, ...metadata } = attempt;
      const captured: Pick<RecordedSolverProcessAttempt, "stdoutPath" | "stdoutDigest" | "stderrPath" | "stderrDigest"> = {};
      for (const [stream, output] of [["stdout", stdout], ["stderr", stderr]] as const) {
        if (!output || !attemptDirectory) continue;
        const path = join(attemptDirectory, `${stream}.log`);
        writeFileSync(path, output, "utf8");
        captured[`${stream}Path`] = `attempt-${attempt.attempt}/${stream}.log`;
        captured[`${stream}Digest`] = `sha256:${createHash("sha256").update(output).digest("hex")}`;
      }
      attempts.push({ ...programs, ...metadata, ...captured, timestamp: new Date().toISOString(), process: processTelemetry() });
    },
    finish(): string | undefined {
      if (attempts.length === 1 && attempts[0]?.status === 0 && !attempts[0].hardTimeout) {
        rmSync(directory, { recursive: true, force: true });
        return undefined;
      }
      mkdirSync(directory, { recursive: true });
      const manifest = join(directory, "manifest.json");
      const assessment = classifySolverRetryAttempts(attempts, maxAttempts);
      writeFileSync(manifest, `${JSON.stringify({
        schema: "uneffect.verifier-retry-evidence/v1",
        tier,
        source,
        testName,
        command,
        startedAt,
        finishedAt: new Date().toISOString(),
        attempts,
        assessment,
      }, null, 2)}\n`, "utf8");
      return manifest;
    },
  };
}

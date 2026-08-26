import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SolverProcessAttempt {
  attempt: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  hardTimeout: boolean;
  retryReason?: "recognized-wasm-failure" | "hard-timeout";
  durationMs?: number;
}

function processTelemetry() {
  const memory = process.memoryUsage();
  return { pid: process.pid, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external };
}

/**
 * Owns evidence directories for one isolated Vitest selector. A clean first
 * attempt is discarded; once a retry occurs all process and solver evidence is
 * retained so a later green attempt cannot erase the original failure.
 */
export function createSolverRetryEvidenceSession(root: string, tier: string, source: string, testName: string) {
  const identity = createHash("sha256").update(`${tier}\0${source}\0${testName}`).digest("hex").slice(0, 16);
  const directory = join(root, tier, `${identity}-${process.pid}-${Date.now()}`);
  const startedAt = new Date().toISOString();
  const attempts: Array<SolverProcessAttempt & { timestamp: string; process: ReturnType<typeof processTelemetry> }> = [];
  return {
    directory,
    environmentForAttempt(attempt: number): NodeJS.ProcessEnv {
      const attemptDirectory = join(directory, `attempt-${attempt}`);
      mkdirSync(attemptDirectory, { recursive: true });
      return { UNEFFECT_SOLVER_EVIDENCE_DIR: attemptDirectory };
    },
    recordAttempt(attempt: SolverProcessAttempt) {
      attempts.push({ ...attempt, timestamp: new Date().toISOString(), process: processTelemetry() });
    },
    finish(): string | undefined {
      if (attempts.length === 1 && attempts[0]?.status === 0 && !attempts[0].hardTimeout) {
        rmSync(directory, { recursive: true, force: true });
        return undefined;
      }
      mkdirSync(directory, { recursive: true });
      const manifest = join(directory, "manifest.json");
      writeFileSync(manifest, `${JSON.stringify({
        schema: "uneffect.solver-retry-evidence/v1",
        tier,
        source,
        testName,
        startedAt,
        finishedAt: new Date().toISOString(),
        attempts,
      }, null, 2)}\n`, "utf8");
      return manifest;
    },
  };
}

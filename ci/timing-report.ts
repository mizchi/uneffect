import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const ciTimingSchema = "uneffect.ci-timing/v2" as const;

export type CiTimingPhase =
  | "project-compiler-construction"
  | "semantic-query"
  | "analysis-pass"
  | "model-generation"
  | "external-verifier";

export interface CiProcessSnapshot {
  pid: number;
  rssBytes: number;
  heapUsedBytes: number;
  externalBytes: number;
  maxRssBytes: number;
  userCpuMicros: number;
  systemCpuMicros: number;
}

type CiTimingIdentity = {
  tier: string;
  shard: string | null;
  file: string;
  testName: string | null;
  attempt: number;
  timestamp: string;
};

type CiTimingAttemptEvent = ({
  schema: typeof ciTimingSchema;
  event: "start";
} & CiTimingIdentity) | ({
  schema: typeof ciTimingSchema;
  event: "complete";
  durationMs: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  failureKind?: string;
} & CiTimingIdentity);

type CiTimingPhaseIdentity = CiTimingIdentity & { phase: CiTimingPhase };

type CiTimingPhaseEvent = ({
  schema: typeof ciTimingSchema;
  event: "phase-start";
} & CiTimingPhaseIdentity) | ({
  schema: typeof ciTimingSchema;
  event: "phase-complete";
  durationMs: number;
  status: 0 | 1;
  failureKind?: "phase-error";
} & CiTimingPhaseIdentity);

export type CiTimingEvent = (CiTimingAttemptEvent | CiTimingPhaseEvent) & {
  process: CiProcessSnapshot;
};

export type CiTimingEventInput = ({ event: "start" } & CiTimingIdentity) | ({
  event: "complete";
  durationMs: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  failureKind?: string;
} & CiTimingIdentity) | ({ event: "phase-start" } & CiTimingPhaseIdentity) | ({
  event: "phase-complete";
  durationMs: number;
  status: 0 | 1;
  failureKind?: "phase-error";
} & CiTimingPhaseIdentity);

export type CiTimingRetryReason = "hard-timeout" | "external-process-timeout" | "recognized-wasm-failure";

export function captureCiProcessSnapshot(): CiProcessSnapshot {
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  return {
    pid: process.pid,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    maxRssBytes: usage.maxRSS * 1024,
    userCpuMicros: usage.userCPUTime,
    systemCpuMicros: usage.systemCPUTime,
  };
}

export function classifyCiTimingFailure(
  status: number | null,
  errorCode: string | undefined,
  retryReason: CiTimingRetryReason | undefined,
): string | undefined {
  if (status === 0) return undefined;
  if (retryReason === "hard-timeout" || errorCode === "ETIMEDOUT") return "runtime-hard-timeout";
  if (retryReason === "external-process-timeout") return "verifier-process-timeout";
  if (retryReason === "recognized-wasm-failure") return "verifier-runtime-failure";
  return "semantic-or-test-failure";
}

export function appendCiTimingEvent(path: string, event: CiTimingEventInput): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ schema: ciTimingSchema, ...event, process: captureCiProcessSnapshot() })}\n`, "utf8");
}

export function measureCiTimingPhase<T>(
  path: string | undefined,
  identity: Omit<CiTimingPhaseIdentity, "timestamp">,
  operation: () => T,
): T {
  if (!path) return operation();
  const startedAt = Date.now();
  appendCiTimingEvent(path, { ...identity, event: "phase-start", timestamp: new Date(startedAt).toISOString() });
  try {
    const value = operation();
    appendCiTimingEvent(path, { ...identity, event: "phase-complete", timestamp: new Date().toISOString(), durationMs: Date.now() - startedAt, status: 0 });
    return value;
  } catch (error) {
    appendCiTimingEvent(path, { ...identity, event: "phase-complete", timestamp: new Date().toISOString(), durationMs: Date.now() - startedAt, status: 1, failureKind: "phase-error" });
    throw error;
  }
}

export async function measureCiTimingPhaseAsync<T>(
  path: string | undefined,
  identity: Omit<CiTimingPhaseIdentity, "timestamp">,
  operation: () => Promise<T>,
): Promise<T> {
  if (!path) return operation();
  const startedAt = Date.now();
  appendCiTimingEvent(path, { ...identity, event: "phase-start", timestamp: new Date(startedAt).toISOString() });
  try {
    const value = await operation();
    appendCiTimingEvent(path, { ...identity, event: "phase-complete", timestamp: new Date().toISOString(), durationMs: Date.now() - startedAt, status: 0 });
    return value;
  } catch (error) {
    appendCiTimingEvent(path, { ...identity, event: "phase-complete", timestamp: new Date().toISOString(), durationMs: Date.now() - startedAt, status: 1, failureKind: "phase-error" });
    throw error;
  }
}

export function readCiTimingEvents(path: string): readonly CiTimingEvent[] {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => {
    const parsed = JSON.parse(line) as CiTimingEvent;
    if (parsed.schema !== ciTimingSchema || !["start", "complete", "phase-start", "phase-complete"].includes(parsed.event)) {
      throw new Error(`invalid CI timing event: ${line}`);
    }
    return parsed;
  });
}

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export const ciTimingSchema = "uneffect.ci-timing/v1" as const;

type CiTimingIdentity = {
  tier: string;
  shard: string | null;
  file: string;
  testName: string | null;
  attempt: number;
  timestamp: string;
};

export type CiTimingEvent = ({
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

export type CiTimingEventInput = ({ event: "start" } & CiTimingIdentity) | ({
  event: "complete";
  durationMs: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  failureKind?: string;
} & CiTimingIdentity);

export type CiTimingRetryReason = "hard-timeout" | "external-process-timeout" | "recognized-wasm-failure";

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
  appendFileSync(path, `${JSON.stringify({ schema: ciTimingSchema, ...event })}\n`, "utf8");
}

export function readCiTimingEvents(path: string): readonly CiTimingEvent[] {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => {
    const parsed = JSON.parse(line) as CiTimingEvent;
    if (parsed.schema !== ciTimingSchema || (parsed.event !== "start" && parsed.event !== "complete")) {
      throw new Error(`invalid CI timing event: ${line}`);
    }
    return parsed;
  });
}

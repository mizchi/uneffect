import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";

type DeadlineOptions = Omit<SpawnSyncOptionsWithStringEncoding, "encoding" | "timeout" | "killSignal">;

export function spawnSyncWithDeadline(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  options: DeadlineOptions = {},
): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
}

import { execFile } from "node:child_process";

/* uneffect:effect Run<"git"> | Timer */
export function readGitStatus(deliver: (error: Error | null, output: string) => void): void {
  execFile("git", ["status", "--short"], (error, stdout) => {
    queueMicrotask(() => deliver(error, stdout));
  });
}

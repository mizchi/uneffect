import { randomBytes } from "node:crypto";

/* uneffect:effect Random | Timer */
export function issueToken(deliver: (error: Error | null, token?: string) => void): void {
  randomBytes(32, (error, bytes) => {
    queueMicrotask(() => deliver(error, error ? undefined : bytes.toString("hex")));
  });
}

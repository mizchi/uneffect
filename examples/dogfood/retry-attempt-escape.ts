import { attemptSlot } from "./retry-slots.js";

interface Attempt {
  flush(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openAttempt(): Attempt;
/* uneffect: retains_resource 0 */
declare function registerAttempt(attempt: Attempt): void;
function registerRetryAttempt(attempt: Attempt): void {
  const queuedAttempt = attempt;
  registerAttempt(queuedAttempt);
}

export async function brokenRetry(enabled: boolean): Promise<void> {
  let lastAttempt: Attempt | undefined;
  const retryState: { active: { forwardedAttempt?: Attempt } } = { active: {} };
  const forwardedState = retryState;
  while (enabled) {
    await using attempt = openAttempt();
    lastAttempt = attempt;
    forwardedState.active[attemptSlot] = lastAttempt;
    await Promise.resolve("flush");
  }
  retryState.active.forwardedAttempt?.flush();
}

export async function brokenAttemptFactory(): Promise<{ attempt: Attempt }> {
  await using attempt = openAttempt();
  return { attempt };
}

export async function brokenDeferredAttempt(): Promise<{ flush(): void }> {
  await using attempt = openAttempt();
  const flush = () => attempt.flush();
  return { flush };
}

export async function brokenRegisteredAttempt(): Promise<void> {
  await using attempt = openAttempt();
  registerRetryAttempt(attempt);
}

interface Attempt {
  flush(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openAttempt(): Attempt;

export async function brokenRetry(enabled: boolean): Promise<void> {
  let lastAttempt: Attempt | undefined;
  const retryState: { active: { forwardedAttempt?: Attempt } } = { active: {} };
  const forwardedState = retryState;
  const attemptSlot = "forwardedAttempt" as const;
  while (enabled) {
    await using attempt = openAttempt();
    lastAttempt = attempt;
    forwardedState.active[attemptSlot] = lastAttempt;
    await Promise.resolve("flush");
  }
  retryState.active.forwardedAttempt?.flush();
}

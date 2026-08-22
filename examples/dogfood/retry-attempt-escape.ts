interface Attempt {
  flush(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openAttempt(): Attempt;

export async function brokenRetry(enabled: boolean): Promise<void> {
  let lastAttempt: Attempt | undefined;
  const retryState: { forwardedAttempt?: Attempt } = {};
  while (enabled) {
    await using attempt = openAttempt();
    lastAttempt = attempt;
    retryState.forwardedAttempt = lastAttempt;
    await Promise.resolve("flush");
  }
  retryState.forwardedAttempt?.flush();
}

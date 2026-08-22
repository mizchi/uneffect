interface Attempt {
  flush(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openAttempt(): Attempt;

export async function brokenRetry(enabled: boolean): Promise<void> {
  let lastAttempt: Attempt | undefined;
  let forwardedAttempt: Attempt | undefined;
  while (enabled) {
    await using attempt = openAttempt();
    lastAttempt = attempt;
    forwardedAttempt = lastAttempt;
    await Promise.resolve("flush");
  }
  forwardedAttempt?.flush();
}

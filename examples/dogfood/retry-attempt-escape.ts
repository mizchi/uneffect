interface Attempt {
  flush(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openAttempt(): Attempt;

export async function brokenRetry(enabled: boolean): Promise<void> {
  let lastAttempt: Attempt | undefined;
  while (enabled) {
    await using attempt = openAttempt();
    lastAttempt = attempt;
    await Promise.resolve("flush");
  }
  lastAttempt?.flush();
}

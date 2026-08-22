interface Attempt {
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openAttempt(): Attempt;

export async function flushWithRetry(retry: boolean): Promise<void> {
  try {
    await Promise.reject(new Error("enter retry handler"));
  } catch {
    while (retry) {
      await using attempt = openAttempt();
      await Promise.resolve("flush").then(() => undefined);
    }
  }
}

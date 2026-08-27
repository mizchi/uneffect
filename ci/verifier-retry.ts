export interface VerifierAttemptObservation<Result, RetryReason> {
  attempt: number;
  result: Result;
  retryReason: RetryReason | undefined;
  willRetry: boolean;
}

export interface BoundedVerifierAttemptResult<Result> {
  result: Result;
  attemptCount: number;
  exhausted: boolean;
}

/**
 * Executes a synchronous verifier-bearing process with an explicit retry
 * classifier. Returning no reason is terminal: successful and semantic-failure
 * results therefore share no implicit status convention.
 */
export function runBoundedVerifierAttempts<Result, RetryReason>(
  maxAttempts: number,
  run: (attempt: number) => Result,
  classifyRetry: (result: Result, attempt: number) => RetryReason | undefined,
  observe: (attempt: VerifierAttemptObservation<Result, RetryReason>) => void = () => {},
): BoundedVerifierAttemptResult<Result> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("max verifier attempts must be a positive safe integer");
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = run(attempt);
    const retryReason = classifyRetry(result, attempt);
    const willRetry = retryReason !== undefined && attempt < maxAttempts;
    observe({ attempt, result, retryReason, willRetry });
    if (!willRetry) return {
      result,
      attemptCount: attempt,
      exhausted: retryReason !== undefined && attempt === maxAttempts,
    };
  }
  throw new Error("unreachable verifier retry state");
}

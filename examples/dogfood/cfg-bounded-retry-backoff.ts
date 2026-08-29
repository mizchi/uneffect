/* uneffect:temporal state retries: int */ /* uneffect:temporal state delay: int */ /* uneffect:temporal init retries = 0 */ /* uneffect:temporal init delay = 1 */ /* uneffect:temporal action backoff: retries' = retries > 0 ? 0 : retries, delay' = retries > 0 ? delay * (retries === 1 ? 2 : retries === 2 ? 4 : retries === 3 ? 8 : retries === 4 ? 16 : retries === 5 ? 32 : retries === 6 ? 64 : retries === 7 ? 128 : retries === 8 ? 256 : 1) : delay */

export interface RetryBackoffState {
  retries: number;
  delay: number;
}

/* uneffect:refinement refinement boundedRetryBackoff@1 create */
export function create(initial: RetryBackoffState): RetryBackoffState {
  return initial;
}

/* uneffect:refinement refinement boundedRetryBackoff@1 observe */
export function observe(runtime: RetryBackoffState): RetryBackoffState {
  return runtime;
}

/* uneffect:contract requires runtime.retries >= 0 && runtime.retries <= 8 */ /* uneffect:refinement refinement boundedRetryBackoff@1 action backoff */
export function backoff(runtime: RetryBackoffState): void {
  while (runtime.retries > 0) {
    runtime.delay *= 2;
    runtime.retries--;
  }
}

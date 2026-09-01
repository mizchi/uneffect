/* uneffect:state attempts: int */ /* uneffect:state delay: int */ /* uneffect:state reject: bool */ /* uneffect:init attempts = 0 */ /* uneffect:init delay = 1 */ /* uneffect:init reject = false */ /* uneffect:action retry: attempts' = attempts > 0 ? 0 : attempts, delay' = attempts > 0 ? delay * (reject ? (attempts === 1 ? 2 : attempts === 2 ? 4 : attempts === 3 ? 8 : attempts === 4 ? 16 : 1) : 1) : delay */

export interface RetryRuntime {
  attempts: number;
  delay: number;
  reject: boolean;
}

/* uneffect:refinement refinement caughtRetryBackoff@1 create */
export function createRetryRuntime(initial: RetryRuntime): RetryRuntime {
  return initial;
}

/* uneffect:refinement refinement caughtRetryBackoff@1 observe */
export function observeRetryRuntime(runtime: RetryRuntime): RetryRuntime {
  return runtime;
}

/* uneffect:requires runtime.attempts >= 0 && runtime.attempts <= 4 */ /* uneffect:refinement refinement caughtRetryBackoff@1 action retry */
export function retryWithCaughtBackoff(runtime: RetryRuntime): void {
  while (runtime.attempts > 0) {
    try {
      if (runtime.reject) throw runtime.attempts;
    } catch {
      runtime.delay *= 2;
    } finally {
      runtime.attempts--;
    }
  }
}

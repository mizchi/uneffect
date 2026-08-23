import { attemptSlot } from "./retry-slots.js";

interface Attempt {
  flush(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

declare function openAttempt(): Attempt;
/* uneffect: retains_resource 0 */
declare function registerAttempt(attempt: Attempt): void;
/* uneffect: retains_resource_when 0: enabled */
declare function maybeRegisterAttempt(attempt: Attempt, enabled: boolean): void;
function maybeRegisterRetryAttempt(attempt: Attempt, enabled: boolean): void {
  const shouldRegister = enabled;
  maybeRegisterAttempt(attempt, shouldRegister);
}
function registerRetryAttempt(attempt: Attempt): void {
  const queuedAttempt = attempt;
  registerAttempt(queuedAttempt);
}
class AttemptQueueEntry {
  /* uneffect: retains_resource 0 */
  constructor(readonly attempt: Attempt) {}
}
function createAttemptQueueEntry(attempt: Attempt): AttemptQueueEntry {
  return new AttemptQueueEntry(attempt);
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

export async function brokenQueuedAttempt(): Promise<void> {
  await using attempt = openAttempt();
  createAttemptQueueEntry(attempt);
}

export async function brokenConditionalAttempt(): Promise<void> {
  await using attempt = openAttempt();
  maybeRegisterRetryAttempt(attempt, true);
}

export async function safeDisabledAttempt(): Promise<void> {
  await using attempt = openAttempt();
  maybeRegisterRetryAttempt(attempt, false);
}

export async function safeClearedAttempt(status: "flushed" | "cancelled"): Promise<void> {
  const state: { active?: Attempt } = {};
  {
    await using attempt = openAttempt();
    state.active = attempt;
    await Promise.resolve("flush");
  }
  switch (status) {
    case "flushed": state.active = undefined; break;
    case "cancelled": state["active"] = undefined; break;
    default: state.active = undefined;
  }
  state.active?.flush();
}

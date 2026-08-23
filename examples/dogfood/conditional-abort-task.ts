/** Schedule work under one of two complete, path-correlated cancellation policies. */
/* uneffect: effect Timer */
export function scheduleConditionalRefresh(disabled: boolean, shutdown: AbortSignal): void {
  const signal = AbortSignal.any(disabled
    ? [AbortSignal.abort("refresh-disabled")]
    : [shutdown, AbortSignal.timeout(2_000)]);
  void scheduler.postTask(() => "refresh", { priority: "background", signal });
}

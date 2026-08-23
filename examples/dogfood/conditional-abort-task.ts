/** Schedule work under one of two complete, path-correlated cancellation policies. */
/* uneffect: effect Timer */
export function scheduleConditionalRefresh(disabled: boolean, shutdown: AbortSignal): void {
  const sources = disabled
    ? [AbortSignal.abort("refresh-disabled")]
    : [shutdown, AbortSignal.timeout(2_000)];
  const signal = AbortSignal.any(sources);
  void scheduler.postTask(() => "refresh", { priority: "background", signal });
}

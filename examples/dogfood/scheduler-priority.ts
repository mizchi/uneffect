/* uneffect: effect Timer */
export async function scheduleDashboardWork(signal: AbortSignal): Promise<string[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
  const render = scheduler.postTask(async () => {
    await scheduler.yield();
    return "render";
  }, { priority: "user-visible", signal: deadline });
  const prefetch = scheduler.postTask(() => "prefetch", { priority: "background", signal: deadline });
  return Promise.all([render, prefetch]);
}

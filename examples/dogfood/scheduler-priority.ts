/* uneffect: effect Timer */
export async function scheduleDashboardWork(signal: AbortSignal): Promise<string[]> {
  const render = scheduler.postTask(async () => {
    await scheduler.yield();
    return "render";
  }, { priority: "user-visible", signal });
  const prefetch = scheduler.postTask(() => "prefetch", { priority: "background", signal });
  return Promise.all([render, prefetch]);
}

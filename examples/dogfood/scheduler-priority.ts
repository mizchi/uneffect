/* uneffect:effect Timer */
export async function scheduleDashboardWork(signal: AbortSignal): Promise<string[]> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
  const sharedOptions = { signal: deadline } as const;
  const priorityKey = "priority";
  const renderOptions = { ...sharedOptions, [priorityKey]: "user-visible" } as const;
  const render = scheduler.postTask(async () => {
    await scheduler.yield();
    return "render";
  }, renderOptions);
  const prefetchOptions = { ...sharedOptions, priority: "background" } as const;
  const prefetch = scheduler.postTask(() => "prefetch", prefetchOptions);
  return Promise.all([render, prefetch]);
}

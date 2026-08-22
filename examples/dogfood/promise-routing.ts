export function routeLegacyResult(kind: "cache" | "remote"): Promise<number> {
  const cached: PromiseLike<number> = {
    then(resolve): PromiseLike<number> { resolve(200); return this; },
  };
  const remote: PromiseLike<number> = {
    then(_resolve, reject): PromiseLike<number> { reject?.(new Error("remote unavailable")); return this; },
  };
  const baseRoutes = { cache: cached, remote } as const;
  const routes = baseRoutes;
  const baseSelection = "remote" as const;
  const selected = baseSelection;
  return new Promise<number>((resolve) => resolve(routes[selected])).catch(() => kind === "cache" ? 200 : 503);
}

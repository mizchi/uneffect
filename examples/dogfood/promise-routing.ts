export function routeLegacyResult(kind: "cache" | "remote"): Promise<number> {
  const cached: PromiseLike<number> = {
    then(resolve): PromiseLike<number> { resolve(200); return this; },
  };
  const remote: PromiseLike<number> = {
    then(_resolve, reject): PromiseLike<number> { reject?.(new Error("remote unavailable")); return this; },
  };
  const baseRoutes = { cache: cached, remote } as const;
  const routes = baseRoutes;
  const baseSelection = kind === "cache" ? "cache" : "remote";
  const selected = baseSelection;
  return new Promise<number>((resolve) => resolve(routes[selected])).catch(() => kind === "cache" ? 200 : 503);
}

export function routeFixedRemote(): Promise<number> {
  const cached: PromiseLike<number> = { then(resolve) { resolve(200); return this; } };
  const remote: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("offline")); return this; } };
  const routes = { cached, remote } as const;
  return new Promise<number>((resolve) => resolve(routes.remote)).catch(() => 503);
}

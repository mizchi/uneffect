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

export function adaptRejectedProxy(): Promise<number> {
  const rejectThen = (_resolve: (value: number) => void, reject: (reason: Error) => void) => {
    reject(new Error("upstream unavailable"));
  };
  function forward<T>(value: T): T { return value; }
  const forwardAgain = <T>(value: T): T => forward(value);
  const resolveThen = (resolve: (value: number) => void) => resolve(200);
  function selectCallback<T>(rejectEnabled: boolean, reject: T, resolve: T): T {
    const selected = rejectEnabled ? reject : resolve;
    return selected;
  }
  const rejectEnabled = true as const;
  const getTrap: ProxyHandler<PromiseLike<number>>["get"] = (_target, property) => {
    const isThen = property === "then";
    if (isThen) {
      if (rejectEnabled) return selectCallback(true, forwardAgain(rejectThen), resolveThen);
      return resolveThen;
    }
    return undefined;
  };
  const trapName = "get" as const;
  const baseHandler: ProxyHandler<PromiseLike<number>> = { [trapName]: getTrap };
  const handler: ProxyHandler<PromiseLike<number>> = { ...baseHandler };
  const upstream = new Proxy({ then() {} } as unknown as PromiseLike<number>, handler);
  return new Promise<number>((resolve) => resolve(upstream)).catch(() => 503);
}

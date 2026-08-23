export function dashboardValues(remote: PromiseLike<string>): Iterable<string | PromiseLike<string>> {
  return {
    *[Symbol.iterator](): Generator<string | PromiseLike<string>> {
      yield "cached-profile";
      yield remote;
    },
  };
}

export const dashboardSnapshotValues = {
  *[Symbol.iterator](): Generator<string | PromiseLike<string>> {
    yield "cached-snapshot";
    yield Promise.resolve("network-snapshot");
  },
};

export function dashboardFailures(details: {
  useCache: boolean;
  useNetwork: boolean;
  cache: { reason: string };
  network: { services: readonly [string] };
}): Iterable<Promise<never>> {
  return {
    *[Symbol.iterator](): Generator<Promise<never>> {
      const useCache = details.useCache === true;
      const useNetwork = details.useNetwork !== false;
      yield Promise.reject(useCache ? `${details.cache.reason}` : "cache-disabled");
      yield Promise.reject(new TypeError(useNetwork ? `${details.network.services[0]}-down` : "network-disabled"));
    },
  };
}

export function* conditionalDashboardValues(
  preferNetwork: boolean,
  network: PromiseLike<string>,
): Generator<string | PromiseLike<string>> {
  yield "dashboard-head";
  if (preferNetwork) {
    yield network;
    throw new TypeError("network-iterator-failed");
  } else {
    yield "cached-primary";
    yield "cached-secondary";
  }
  yield "dashboard-tail";
}

export function* dashboardReplicaValues(
  network: PromiseLike<string>,
): Generator<string | PromiseLike<string>> {
  const forwarded = network;
  for (const cached of ["replica-a", "replica-b"] as const) {
    yield cached;
  }
  yield forwarded;
}

export function* dashboardRegionValues(
  preferNetwork: boolean,
  network: PromiseLike<string>,
): Generator<string | PromiseLike<string>> {
  if (preferNetwork) yield network;
  else yield "regional-cache";
}

export function* delegatedDashboardValues(
  preferNetwork: boolean,
  network: PromiseLike<string>,
): Generator<string | PromiseLike<string>> {
  yield "delegated-head";
  yield* dashboardRegionValues(preferNetwork, network);
  yield "delegated-tail";
}

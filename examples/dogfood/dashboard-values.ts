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

export function dashboardFailures(): Iterable<Promise<never>> {
  return {
    *[Symbol.iterator](): Generator<Promise<never>> {
      yield Promise.reject("cache-miss");
      yield Promise.reject(new TypeError("network-down"));
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

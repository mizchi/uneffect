export function* dashboardValues(remote: PromiseLike<string>): Generator<string | PromiseLike<string>> {
  yield "cached-profile";
  yield remote;
}

export const dashboardSnapshotValues = {
  *[Symbol.iterator](): Generator<string | PromiseLike<string>> {
    yield "cached-snapshot";
    yield Promise.resolve("network-snapshot");
  },
};

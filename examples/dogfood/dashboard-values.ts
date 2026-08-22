export function* dashboardValues(remote: PromiseLike<string>): Generator<string | PromiseLike<string>> {
  yield "cached-profile";
  yield remote;
}

// These declarations specify trusted synchronous operation semantics for the linter.
// The fixture is analyzed, not executed.
declare function initialize(client: object): void;
declare function use(client: object): void;
declare function reset(client: object): void;

export function ready(client: object, flag: boolean) {
  if (flag) initialize(client);
  else initialize(client);
  use(client);
}
export function branchMissing(client: object, flag: boolean) {
  if (flag) initialize(client);
  use(client);
}
export function earlyReturn(client: object, flag: boolean) {
  if (flag) initialize(client);
  else return;
  use(client);
}
export function zeroIterations(client: object, flag: boolean) {
  while (flag) initialize(client);
  use(client);
}
export function atLeastOnce(client: object, flag: boolean) {
  do { initialize(client); } while (flag);
  use(client);
}
export function loopReset(client: object, flag: boolean) {
  initialize(client);
  while (flag) { use(client); reset(client); }
}
export function alias(client: object) {
  const handle = client;
  initialize(handle);
  use(client);
}
export function shadow(client: object) {
  { const client = {}; initialize(client); }
  use(client);
}
export function unsupportedCallback(client: object) {
  [client].forEach(initialize);
  use(client);
}
export function correlatedBranches(client: object, flag: boolean) {
  if (flag) initialize(client);
  if (flag) use(client);
}

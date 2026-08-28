/* uneffect:
  state sent: int
  init sent = 0
  action send: sent' = sent + 1
*/

export interface LocalAliasRuntime {
  sent: number;
}

/* uneffect: effect Mutate<typeof target.sent> */
function incrementSent(target: LocalAliasRuntime): void {
  target.sent += 1;
}

/* uneffect: refinement localAlias@1 create */
export function createLocalAlias(initial: LocalAliasRuntime): LocalAliasRuntime {
  return initial;
}

/* uneffect: refinement localAlias@1 observe */
export function observeLocalAlias(runtime: LocalAliasRuntime): LocalAliasRuntime {
  return runtime;
}

/* uneffect: refinement localAlias@1 action send */
/* uneffect: effect Mutate<typeof runtime.sent> */
export function sendThroughLocalAlias(runtime: LocalAliasRuntime): void {
  const target = runtime;
  incrementSent(target);
}

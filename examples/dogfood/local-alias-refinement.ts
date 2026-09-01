/* uneffect:refinement_from "./local-alias-refinement.uneffect.ts#default" */
/* uneffect:state sent: int */ /* uneffect:init sent = 0 */ /* uneffect:action send: sent' = sent + 1 */

export interface LocalAliasRuntime {
  sent: number;
}

/* uneffect:effect Mutate<typeof target.sent> */
function incrementSent(target: LocalAliasRuntime): void {
  target.sent += 1;
}

export function createLocalAlias(initial: LocalAliasRuntime): LocalAliasRuntime {
  return initial;
}

export function observeLocalAlias(runtime: LocalAliasRuntime): LocalAliasRuntime {
  return runtime;
}

/* uneffect:effect Mutate<typeof runtime.sent> */
export function sendThroughLocalAlias(runtime: LocalAliasRuntime): void {
  const target = runtime;
  incrementSent(target);
}

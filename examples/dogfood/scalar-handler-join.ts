/* uneffect:temporal state total: int */ /* uneffect:temporal state first: bool */ /* uneffect:temporal state second: bool */ /* uneffect:temporal init total = 0 */ /* uneffect:temporal init first = false */ /* uneffect:temporal init second = false */ /* uneffect:temporal action compose: total' = total + (first ? 2 : 1) + (second ? 8 : 4) */

export interface ScalarHandlerState {
  total: number;
  first: boolean;
  second: boolean;
}

/* uneffect:refinement refinement scalarHandlerJoin@1 create */
export function createScalarHandlerState(initial: ScalarHandlerState): ScalarHandlerState {
  return { ...initial };
}

/* uneffect:refinement refinement scalarHandlerJoin@1 observe */
export function observeScalarHandlerState(runtime: ScalarHandlerState): ScalarHandlerState {
  return { ...runtime };
}

/* uneffect:refinement refinement scalarHandlerJoin@1 action compose */
export function composeScalarHandlers(runtime: ScalarHandlerState): void {
  try {
    try {
      if (runtime.first) throw 1;
      runtime.total += 1;
    } catch {
      runtime.total += 2;
    }
    try {
      if (runtime.second) throw 2;
      runtime.total += 4;
    } catch {
      runtime.total += 8;
    }
  } catch {
    // The two inner handlers consume every throw in this bounded fragment.
  }
}

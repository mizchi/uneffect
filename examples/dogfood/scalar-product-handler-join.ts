/* uneffect:temporal state total: int */ /* uneffect:temporal state audited: int */ /* uneffect:temporal state first: bool */ /* uneffect:temporal state second: bool */ /* uneffect:temporal init total = 0 */ /* uneffect:temporal init audited = 0 */ /* uneffect:temporal init first = false */ /* uneffect:temporal init second = false */ /* uneffect:temporal action compose: total' = total + (first ? 2 : 1) + (second ? 8 : 4), audited' = audited + (first ? 20 : 10) + (second ? 80 : 40) */

export interface ScalarProductHandlerState {
  total: number;
  audited: number;
  first: boolean;
  second: boolean;
}

/* uneffect:refinement refinement scalarProductJoin@1 create */
export function createScalarProductHandlerState(
  initial: ScalarProductHandlerState,
): ScalarProductHandlerState {
  return { ...initial };
}

/* uneffect:refinement refinement scalarProductJoin@1 observe */
export function observeScalarProductHandlerState(
  runtime: ScalarProductHandlerState,
): ScalarProductHandlerState {
  return { ...runtime };
}

/* uneffect:refinement refinement scalarProductJoin@1 action compose */
export function composeScalarProductHandlers(runtime: ScalarProductHandlerState): void {
  try {
    try {
      if (runtime.first) throw 1;
      runtime.total += 1;
      runtime.audited += 10;
    } catch {
      runtime.total += 2;
      runtime.audited += 20;
    }
    try {
      if (runtime.second) throw 2;
      runtime.total += 4;
      runtime.audited += 40;
    } catch {
      runtime.total += 8;
      runtime.audited += 80;
    }
  } catch {
    // The two inner handlers consume every throw in this bounded fragment.
  }
}

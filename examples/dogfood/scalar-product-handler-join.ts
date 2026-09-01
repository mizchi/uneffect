/* uneffect:refinement_from "./scalar-product-handler-join.uneffect.ts#default" */
/* uneffect:state total: int */ /* uneffect:state audited: int */ /* uneffect:state first: bool */ /* uneffect:state second: bool */ /* uneffect:init total = 0 */ /* uneffect:init audited = 0 */ /* uneffect:init first = false */ /* uneffect:init second = false */ /* uneffect:action compose: total' = total + (first ? 2 : 1) + (second ? 8 : 4), audited' = audited + (first ? 20 : 10) + (second ? 80 : 40) */

export interface ScalarProductHandlerState {
  total: number;
  audited: number;
  first: boolean;
  second: boolean;
}

export function createScalarProductHandlerState(
  initial: ScalarProductHandlerState,
): ScalarProductHandlerState {
  return { ...initial };
}

export function observeScalarProductHandlerState(
  runtime: ScalarProductHandlerState,
): ScalarProductHandlerState {
  return { ...runtime };
}

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

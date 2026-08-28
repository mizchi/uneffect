/* uneffect:
  state total: int
  state audited: int
  state first: bool
  state second: bool
  state third: bool
  init total = 0
  init audited = 0
  init first = false
  init second = false
  init third = false
  action compose: total' = total + (first ? 2 : 1) + (second ? 8 : 4) + (third ? 32 : 16), audited' = audited + (first ? 20 : 10) + (second ? 80 : 40) + (third ? 320 : 160)
*/

export interface ThreeRegionAccountingState {
  total: number;
  audited: number;
  first: boolean;
  second: boolean;
  third: boolean;
}

/* uneffect: refinement scalarProductThreeRegion@1 create */
export function createThreeRegionAccountingState(
  initial: ThreeRegionAccountingState,
): ThreeRegionAccountingState {
  return { ...initial };
}

/* uneffect: refinement scalarProductThreeRegion@1 observe */
export function observeThreeRegionAccountingState(
  runtime: ThreeRegionAccountingState,
): ThreeRegionAccountingState {
  return { ...runtime };
}

/* uneffect: refinement scalarProductThreeRegion@1 action compose */
export function composeThreeRegionAccounting(runtime: ThreeRegionAccountingState): void {
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
    try {
      if (runtime.third) throw 3;
      runtime.total += 16;
      runtime.audited += 160;
    } catch {
      runtime.total += 32;
      runtime.audited += 320;
    }
  } catch {
    // Every throw is consumed by its source-keyed inner region.
  }
}

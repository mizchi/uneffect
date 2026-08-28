/* uneffect:
  state total: int
  state audited: int
  state route: bool
  state first: bool
  state second: bool
  state common: bool
  init total = 0
  init audited = 0
  init route = false
  init first = false
  init second = false
  init common = false
  action compose: total' = total + (route ? (first ? 2 : 1) : (second ? 8 : 4)) + (common ? 32 : 16), audited' = audited + (route ? (first ? 20 : 10) : (second ? 80 : 40)) + (common ? 320 : 160)
*/

export interface RoutedAccountingState {
  total: number;
  audited: number;
  route: boolean;
  first: boolean;
  second: boolean;
  common: boolean;
}

/* uneffect: refinement conditionalScalarProduct@1 create */
export function createRoutedAccountingState(initial: RoutedAccountingState): RoutedAccountingState {
  return { ...initial };
}

/* uneffect: refinement conditionalScalarProduct@1 observe */
export function observeRoutedAccountingState(runtime: RoutedAccountingState): RoutedAccountingState {
  return { ...runtime };
}

/* uneffect: refinement conditionalScalarProduct@1 action compose */
export function composeRoutedAccounting(runtime: RoutedAccountingState): void {
  try {
    if (runtime.route) {
      try {
        if (runtime.first) throw 1;
        runtime.total += 1;
        runtime.audited += 10;
      } catch {
        runtime.total += 2;
        runtime.audited += 20;
      }
    } else {
      try {
        if (runtime.second) throw 2;
        runtime.total += 4;
        runtime.audited += 40;
      } catch {
        runtime.total += 8;
        runtime.audited += 80;
      }
    }
    try {
      if (runtime.common) throw 3;
      runtime.total += 16;
      runtime.audited += 160;
    } catch {
      runtime.total += 32;
      runtime.audited += 320;
    }
  } catch {
    // Each inner handler consumes its own source-keyed throw.
  }
}

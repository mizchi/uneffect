import type { Nat } from "uneffect";

type Counter = { value: number };

/* uneffect: effect Console | Mutate<typeof state> */
/* uneffect: requires amount >= 0 */
/* uneffect: ensures result >= amount */
/* uneffect: assert amount: Nat */
export function increment(state: Counter, amount: Nat): number {
  state.value += amount;
  console.log(`count=${state.value}`);
  return state.value;
}

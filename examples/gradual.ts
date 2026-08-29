import type { Nat } from "@mizchi/uneffect";

type Counter = { value: number };

/* uneffect:capability effect Console | Mutate<typeof state> */
/* uneffect:contract requires amount >= 0 */
/* uneffect:contract ensures result >= amount */
/* uneffect:contract assert amount: Nat */
export function increment(state: Counter, amount: Nat): number {
  state.value += amount;
  console.log(`count=${state.value}`);
  return state.value;
}

// A write names the property it touches, so declaring a sibling property does not cover it.
const state = { calls: 0, total: 0 };

/* uneffect:capability effect Mutate<typeof state.calls> */
export function record(weight: number) {
  state.calls += 1;
  state.total += weight;
}

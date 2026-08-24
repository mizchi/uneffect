// The postcondition is false for one input; the report replays that input through the body.
/* uneffect: requires x >= 0 */
/* uneffect: ensures result > x */
export function decrement(x: number) {
  return x - 1;
}

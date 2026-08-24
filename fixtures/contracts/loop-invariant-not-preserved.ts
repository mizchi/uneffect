// The invariant holds on entry but one iteration of the body breaks it.
/* uneffect: requires n >= 0 */
/* uneffect: ensures result >= n */
export function countByTwo(n: number) {
  let i = 0;
  /* uneffect: invariant i >= 0 && i <= n */
  while (i < n) {
    i = i + 2;
  }
  return i;
}

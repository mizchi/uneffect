// The invariant holds on entry but one iteration of the body breaks it.
/* uneffect:contract requires n >= 0 */
/* uneffect:contract ensures result >= n */
export function countByTwo(n: number) {
  let i = 0;
  /* uneffect:contract invariant i >= 0 && i <= n */
  while (i < n) {
    i = i + 2;
  }
  return i;
}

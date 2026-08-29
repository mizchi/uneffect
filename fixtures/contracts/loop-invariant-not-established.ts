// The invariant is already false the first time the loop is reached.
/* uneffect:contract requires n >= 0 */
/* uneffect:contract ensures result == n */
export function count(n: number) {
  let i = 1;
  /* uneffect:contract invariant i >= 0 && i <= n */
  while (i < n) {
    i = i + 1;
  }
  return i;
}

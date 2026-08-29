// A Hoare triple Z3 proves: for every x >= 0 the returned value is greater than x.
/* uneffect:contract requires x >= 0 */
/* uneffect:contract ensures result > x */
export function increment(x: number) {
  return x + 1;
}

// A call inside a contracted body leaves the verified subset: no obligation is generated at all.
/* uneffect:effect Console */
function report(value: number) {
  console.log(value);
}

/* uneffect:requires n >= 0 */
/* uneffect:ensures result == n */
/* uneffect:effect Console */
export function announce(n: number) {
  report(n);
  return n;
}

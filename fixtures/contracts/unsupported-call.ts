// A call inside a contracted body leaves the verified subset: no obligation is generated at all.
/* uneffect:capability effect Console */
function report(value: number) {
  console.log(value);
}

/* uneffect:contract requires n >= 0 */
/* uneffect:contract ensures result == n */
/* uneffect:capability effect Console */
export function announce(n: number) {
  report(n);
  return n;
}

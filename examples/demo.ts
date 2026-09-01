/* uneffect:effect Console */
function report(value: number) {
  console.log(value);
}

/* uneffect:requires n >= 0 */
/* uneffect:ensures result == n */
/* uneffect:effect Console */
function count(n: number) {
  let i = 0;
  /* uneffect:loop_invariant i >= 0 && i <= n */
  while (i < n) {
    i = i + 1;
  }
  report(i);
  return i;
}

count(3);

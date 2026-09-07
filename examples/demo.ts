/* uneffect:module_effect Console */
/* uneffect:effect Console */
function report(value: number) {
  console.log(value);
}

/* uneffect:requires n >= 0 */
/* uneffect:ensures result == n */
/* uneffect:effect none */
function count(n: number) {
  let i = 0;
  /* uneffect:loop_invariant i >= 0 && i <= n */
  while (i < n) {
    i = i + 1;
  }
  return i;
}

report(count(3));

/* uneffect:capability effect Console */
function report(value: number) {
  console.log(value);
}

/* uneffect:contract requires n >= 0 */
/* uneffect:contract ensures result == n */
/* uneffect:capability effect Console */
function count(n: number) {
  let i = 0;
  /* uneffect:contract invariant i >= 0 && i <= n */
  while (i < n) {
    i = i + 1;
  }
  report(i);
  return i;
}

count(3);

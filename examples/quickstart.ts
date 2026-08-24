/* uneffect: effect Console */
export function report(value: number): void {
  console.log(value);
}

/* uneffect: requires n >= 0 */
/* uneffect: ensures result === n */
export function count(n: number): number {
  let value = 0;
  /* uneffect: invariant value >= 0 && value <= n */
  while (value < n) value = value + 1;
  return value;
}

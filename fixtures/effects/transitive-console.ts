// Effects propagate through calls: `summarize` inherits Console from `report` and must declare it.
/* uneffect:effect Console */
function report(value: number) {
  console.log(value);
}

export function summarize(left: number, right: number) {
  report(left + right);
}

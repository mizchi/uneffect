// An effectful call with no declaration: the report names the operation that produced the effect.
export function report(value: number) {
  console.log(value);
}

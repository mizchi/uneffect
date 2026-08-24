// A misspelled effect constrains nothing, so the real Console effect is still missing.
/* uneffect: effect Consoel */
export function report(value: number) {
  console.log(value);
}

// A declaration is an upper bound: declaring more than the body needs is a warning, not an error.
/* uneffect:effect Console | Fetch */
export function report(value: number) {
  console.log(value);
}

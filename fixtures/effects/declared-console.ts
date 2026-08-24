// A declared effect that matches what the function really does: the checker stays silent.
/* uneffect: effect Console */
export function report(value: number) {
  console.log(value);
}

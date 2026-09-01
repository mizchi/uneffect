import { pipe } from "effect/Function";

function format(value: string): string {
  return pipe(value, (text) => `value=${text}`);
}

/* uneffect:requires value >= 0 */
/* uneffect:ensures result > value */
export function increment(value: number): number {
  return pipe(value, (current) => current + 1);
}

/* uneffect:effect Console */
export function main(value: string): void {
  console.log(format(value));
}

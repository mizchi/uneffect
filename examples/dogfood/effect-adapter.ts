import { pipe } from "effect/Function";

function format(value: string): string {
  return pipe(value, (text) => `value=${text}`);
}

/* uneffect: effect Console */
export function main(value: string): void {
  console.log(format(value));
}

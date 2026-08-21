import { pipe } from "effect/Function";

export function schedule(value: number): void {
  setTimeout(() => {
    const incremented = pipe(value, (current) => current + 1);
    queueMicrotask(() => void incremented);
  }, 0);
}

export function emit(message: string): void {
  console.log(message);
}

export function main(): void {
  emit("first");
  emit("second");
}

export function sameSpelledLookalike(message: string): void {
  const console = { log(_value: string): void {} };
  console.log(message);
}

// A Promise whose rejection nobody observes: an unhandled rejection waiting to happen.
export async function save(value: string) {
  await Promise.resolve(value);
}

export function run() {
  save("value");
}

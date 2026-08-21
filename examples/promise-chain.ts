function cleanup(): void {}

export function makePromise(): Promise<number> {
  const promise = new Promise<number>((resolve) => {
    resolve(1)
  })
  return promise
    .then((value) => value + 1)
    .catch(() => 0)
    .finally(cleanup)
}

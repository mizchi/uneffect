/* uneffect:effect Mutate<typeof values> */
export function partition(values: number[], lo: number, hi: number): number {
  const pivot = values[hi]!
  let boundary = lo

  for (let index = lo; index < hi; index++) {
    if (values[index]! <= pivot) {
      swap(values, index, boundary)
      boundary++
    }
  }
  swap(values, boundary, hi)
  return boundary
}

/* uneffect:effect Mutate<typeof values> */ /* uneffect:decreases hi - lo */
export function quicksort(
  values: number[],
  lo = 0,
  hi = values.length - 1,
): void {
  if (lo >= hi) return
  const pivot = partition(values, lo, hi)
  quicksort(values, lo, pivot - 1)
  quicksort(values, pivot + 1, hi)
}

/* uneffect:effect Mutate<typeof values> */
function swap(values: number[], left: number, right: number): void {
  const value = values[left]!
  values[left] = values[right]!
  values[right] = value
}

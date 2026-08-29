/* uneffect:temporal state epoch: int */ /* uneffect:temporal state cachedAt: int */ /* uneffect:temporal state cacheValid: bool */ /* uneffect:temporal init epoch = 0 */ /* uneffect:temporal init cachedAt = 0 */ /* uneffect:temporal init cacheValid = false */ /* uneffect:temporal action read: cachedAt' = epoch, cacheValid' = true */ /* uneffect:temporal action suspend: epoch' = epoch + 1, cacheValid' = false */ /* uneffect:temporal invariant cacheIsSound: !cacheValid || cachedAt === epoch */

/* uneffect:capability effect Console */ /* uneffect:contract requires x >= 0 */ /* uneffect:contract ensures result > x */
export function inc(x: number) {
  console.log(x)
  return x + 1
}

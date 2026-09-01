/* uneffect: state epoch: int */ /* uneffect: state cachedAt: int */ /* uneffect: state cacheValid: bool */ /* uneffect: init epoch = 0 */ /* uneffect: init cachedAt = 0 */ /* uneffect: init cacheValid = false */ /* uneffect: action read: cachedAt' = epoch, cacheValid' = true */ /* uneffect: action suspend: epoch' = epoch + 1, cacheValid' = false */ /* uneffect:always cacheIsSound: !cacheValid || cachedAt === epoch */

/* uneffect:effect Console */ /* uneffect:requires x >= 0 */ /* uneffect:ensures result > x */
export function inc(x: number) {
  console.log(x)
  return x + 1
}

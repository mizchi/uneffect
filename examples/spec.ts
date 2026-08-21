/*
 * uneffect:
 * state epoch: int
 * state cachedAt: int
 * state cacheValid: bool
 * init epoch = 0
 * init cachedAt = 0
 * init cacheValid = false
 * action read: cachedAt' = epoch, cacheValid' = true
 * action suspend: epoch' = epoch + 1, cacheValid' = false
 * temporal cacheIsSound: !cacheValid || cachedAt === epoch
 */

/*
 * uneffect:
 * effect Console
 * requires x >= 0
 * ensures result > x
 */
export function inc(x: number) {
  console.log(x)
  return x + 1
}

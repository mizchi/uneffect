/* uneffect:temporal state phase: int */ /* uneffect:temporal init phase = 0 */ /* uneffect:temporal invariant completedInOrder: pc !== 2 || phase === 2 */

/* uneffect:temporal-summary requires phase === 0 */ /* uneffect:temporal-summary ensures phase' = 1 */ /* uneffect:temporal-summary modifies phase */
function open() {}

/* uneffect:temporal-summary requires phase === 1 */ /* uneffect:temporal-summary ensures phase' = 2 */ /* uneffect:temporal-summary modifies phase */
function close() {}

function main() {
  open()
  close()
}

/* uneffect: state phase: int */ /* uneffect: init phase = 0 */ /* uneffect:always completedInOrder: pc !== 2 || phase === 2 */

/* uneffect:temporal_contract requires phase === 0 */ /* uneffect:temporal_contract ensures phase' = 1 */ /* uneffect:temporal_contract modifies phase */
function open() {}

/* uneffect:temporal_contract requires phase === 1 */ /* uneffect:temporal_contract ensures phase' = 2 */ /* uneffect:temporal_contract modifies phase */
function close() {}

function main() {
  open()
  close()
}

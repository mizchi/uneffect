/*
 * uneffect:
 * state phase: int
 * init phase = 0
 * temporal completedInOrder: pc !== 2 || phase === 2
 */

/*
 * uneffect:
 * temporal_requires phase === 0
 * temporal_ensures phase' = 1
 * temporal_modifies phase
 */
function open() {}

/*
 * uneffect:
 * temporal_requires phase === 1
 * temporal_ensures phase' = 2
 * temporal_modifies phase
 */
function close() {}

function main() {
  open()
  close()
}

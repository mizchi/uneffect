/* uneffect: state pending: int */ /* uneffect: init pending = 0 */ /* uneffect: action enqueue: pending' = pending + 1 */ /* uneffect: action complete: pending' = pending > 0 ? pending - 1 : pending */ /* uneffect:always nonnegative: pending >= 0 */
export type QueueModel = never;

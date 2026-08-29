/* uneffect:temporal state pending: int */ /* uneffect:temporal init pending = 0 */ /* uneffect:temporal action enqueue: pending' = pending + 1 */ /* uneffect:temporal action complete: pending' = pending > 0 ? pending - 1 : pending */ /* uneffect:temporal invariant nonnegative: pending >= 0 */
export type QueueModel = never;

/* uneffect:
  state pending: int
  init pending = 0
  action enqueue: pending' = pending + 1
  action complete: pending' = pending > 0 ? pending - 1 : pending
  temporal nonnegative: pending >= 0
*/
export type QueueModel = never;

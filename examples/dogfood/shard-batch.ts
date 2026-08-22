import type { Nat } from "@mizchi/uneffect";

/* uneffect: requires shard >= 0 && shard < 1024 && shard % 16 === 0 */
/* uneffect: ensures result >= 0 && result < 64 */
export function shardBatch(shard: Nat): Nat {
  return shard / 16;
}

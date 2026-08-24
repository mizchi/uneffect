import type { Int, Nat } from "@mizchi/uneffect";

/* uneffect: requires shard >= 0 && shard < 1024 && shard % 16 === 0 */
/* uneffect: ensures result >= 0 && result < 64 */
export function shardBatch(shard: Nat): Nat {
  return shard / 16;
}

/* uneffect: requires (shard >= 0 && shard < 32 && shard % 16 === 0) || (shard >= 100 && shard < 132 && shard % 16 === 4) */
/* uneffect: ensures result >= 0 */
export function tenantShard(shard: Nat): Nat {
  return shard;
}

/* uneffect: requires partition >= 0 && partition < 256 && partition % 4 === 1 && partition % 6 === 3 */
/* uneffect: ensures result >= 0 */
export function partitionRoute(partition: Nat): Nat {
  return partition;
}

/* uneffect: requires partition >= -50 && partition < 0 && partition % 6 === -3 */
/* uneffect: ensures result < 0 */
export function signedPartitionRoute(partition: Int): Int {
  return partition;
}

/* uneffect: requires replicas >= 4 && (allowLarge || replicas <= 4) && (region === "local" || allowLarge) */
/* uneffect: ensures result >= 4 */
export function supportedReplicaCount(replicas: 1 | 4 | 9, allowLarge: false | true, region: "local" | "edge"): number {
  return replicas;
}

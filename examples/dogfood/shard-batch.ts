import type { Int, Nat, U8 } from "@mizchi/uneffect";

/* uneffect:contract requires shard >= 0 && shard < 1024 && shard % 16 === 0 */
/* uneffect:contract ensures result >= 0 && result < 64 */
export function shardBatch(shard: Nat): Nat {
  return shard / 16;
}

/* uneffect:contract requires (shard >= 0 && shard < 32 && shard % 16 === 0) || (shard >= 100 && shard < 132 && shard % 16 === 4) */
/* uneffect:contract ensures result >= 0 */
export function tenantShard(shard: Nat): Nat {
  return shard;
}

/* uneffect:contract requires partition >= 0 && partition < 256 && partition % 4 === 1 && partition % 6 === 3 */
/* uneffect:contract ensures result >= 0 */
export function partitionRoute(partition: Nat): Nat {
  return partition;
}

/* uneffect:contract requires partition >= -50 && partition < 0 && partition % 6 === -3 */
/* uneffect:contract ensures result < 0 */
export function signedPartitionRoute(partition: Int): Int {
  return partition;
}

/* uneffect:contract requires replicas >= 4 && (allowLarge || replicas <= 4) && (region === "local" || allowLarge) */
/* uneffect:contract ensures result >= 4 */
export function supportedReplicaCount(replicas: 1 | 4 | 9, allowLarge: false | true, region: "local" | "edge"): number {
  return replicas;
}

/* uneffect:contract requires config.rollout === undefined || (config.rollout.maxReplicas === 9 && (config.rollout.minReplicas === undefined || config.rollout.minReplicas >= 4)) */
/* uneffect:contract ensures result >= 0 */
export function rolloutFloor(config: { rollout?: { minReplicas?: U8; maxReplicas: U8 } }): number {
  return config.rollout?.minReplicas ?? 0;
}

/* uneffect:temporal state nodes: Set<int> */ /* uneffect:temporal state primaryNode: int */ /* uneffect:temporal state backupNode: int */ /* uneffect:temporal state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:temporal init nodes = Set(1, 2) */ /* uneffect:temporal init primaryNode = 1 */ /* uneffect:temporal init backupNode = 1 */ /* uneffect:temporal init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:temporal action selectStandby: backupNode' = 2 */ /* uneffect:temporal action promoteStandby: primaryNode' = backupNode, backupNode' = 2 */ /* uneffect:temporal invariant primaryNodeIsKnown: nodes.contains(primaryNode) */ /* uneffect:temporal invariant backupNodeIsKnown: nodes.contains(backupNode) */ /* uneffect:temporal invariant selectedLeasesAreFenced: (!leases.getOrElse(primaryNode, { epoch: 0, valid: false }).valid || leases.keys().contains(primaryNode)) && (!leases.getOrElse(backupNode, { epoch: -1, valid: false }).valid || leases.keys().contains(backupNode)) */

// Promotion copies the standby selector into the primary slot. Proving the
// primary membership preservation therefore requires the standby membership
// invariant; neither relation is silently assumed from the other.
export interface FailoverLeaseRecord {
  epoch: number;
  valid: boolean;
}

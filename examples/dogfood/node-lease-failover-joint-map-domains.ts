/* uneffect:state nodes: Set<int> */ /* uneffect:state primaryNode: int */ /* uneffect:state backupNode: int */ /* uneffect:state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:init nodes = Set(1, 2) */ /* uneffect:init primaryNode = 1 */ /* uneffect:init backupNode = 1 */ /* uneffect:init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:action selectStandby: backupNode' = 2 */ /* uneffect:action promoteStandby: primaryNode' = backupNode, backupNode' = 2 */ /* uneffect:always primaryNodeIsKnown: nodes.contains(primaryNode) */ /* uneffect:always backupNodeIsKnown: nodes.contains(backupNode) */ /* uneffect:always selectedLeasesAreFenced: (!leases.getOrElse(primaryNode, { epoch: 0, valid: false }).valid || leases.keys().contains(primaryNode)) && (!leases.getOrElse(backupNode, { epoch: -1, valid: false }).valid || leases.keys().contains(backupNode)) */

// Promotion copies the standby selector into the primary slot. Proving the
// primary membership preservation therefore requires the standby membership
// invariant; neither relation is silently assumed from the other.
export interface FailoverLeaseRecord {
  epoch: number;
  valid: boolean;
}

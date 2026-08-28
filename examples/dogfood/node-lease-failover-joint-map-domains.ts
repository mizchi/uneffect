/* uneffect:
  state nodes: Set<int>
  state primaryNode: int
  state backupNode: int
  state leases: Map<int, { epoch: int, valid: bool }>
  init nodes = Set(1, 2)
  init primaryNode = 1
  init backupNode = 1
  init leases = Map([[1, { epoch: 1, valid: true }]])
  action selectStandby: backupNode' = 2
  action promoteStandby: primaryNode' = backupNode, backupNode' = 2
  temporal primaryNodeIsKnown: nodes.contains(primaryNode)
  temporal backupNodeIsKnown: nodes.contains(backupNode)
  temporal selectedLeasesAreFenced: (!leases.getOrElse(primaryNode, { epoch: 0, valid: false }).valid || leases.keys().contains(primaryNode)) && (!leases.getOrElse(backupNode, { epoch: -1, valid: false }).valid || leases.keys().contains(backupNode))
*/

// Promotion copies the standby selector into the primary slot. Proving the
// primary membership preservation therefore requires the standby membership
// invariant; neither relation is silently assumed from the other.
export interface FailoverLeaseRecord {
  epoch: number;
  valid: boolean;
}

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
  action retainSelections: primaryNode' = primaryNode, backupNode' = backupNode
  temporal primaryNodeIsKnown: nodes.contains(primaryNode)
  temporal backupNodeIsKnown: nodes.contains(backupNode)
  temporal selectedLeasesAreFenced: (!leases.getOrElse(primaryNode, { epoch: 0, valid: false }).valid || leases.keys().contains(primaryNode)) && (!leases.getOrElse(backupNode, { epoch: 0, valid: false }).valid || leases.keys().contains(backupNode))
*/

// Real lease readers commonly retain a primary and a standby selection. The
// bounded model keeps both selectors in the same immutable node registry, but
// Uneffect must prove each membership invariant independently before decoding
// the shared lease Map with both dynamic keys.
export interface PrimaryBackupLeaseRecord {
  epoch: number;
  valid: boolean;
}

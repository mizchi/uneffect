/* uneffect:state nodes: Set<int> */ /* uneffect:state primaryNode: int */ /* uneffect:state backupNode: int */ /* uneffect:state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:init nodes = Set(1, 2) */ /* uneffect:init primaryNode = 1 */ /* uneffect:init backupNode = 1 */ /* uneffect:init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:action selectStandby: backupNode' = 2 */ /* uneffect:action retainSelections: primaryNode' = primaryNode, backupNode' = backupNode */ /* uneffect:always primaryNodeIsKnown: nodes.contains(primaryNode) */ /* uneffect:always backupNodeIsKnown: nodes.contains(backupNode) */ /* uneffect:always selectedLeasesAreFenced: (!leases.getOrElse(primaryNode, { epoch: 0, valid: false }).valid || leases.keys().contains(primaryNode)) && (!leases.getOrElse(backupNode, { epoch: 0, valid: false }).valid || leases.keys().contains(backupNode)) */

// Real lease readers commonly retain a primary and a standby selection. The
// bounded model keeps both selectors in the same immutable node registry, but
// Uneffect must prove each membership invariant independently before decoding
// the shared lease Map with both dynamic keys.
export interface PrimaryBackupLeaseRecord {
  epoch: number;
  valid: boolean;
}

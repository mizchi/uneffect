/* uneffect:temporal state nodes: Set<int> */ /* uneffect:temporal state primaryNode: int */ /* uneffect:temporal state backupNode: int */ /* uneffect:temporal state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:temporal init nodes = Set(1, 2) */ /* uneffect:temporal init primaryNode = 1 */ /* uneffect:temporal init backupNode = 1 */ /* uneffect:temporal init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:temporal action selectStandby: backupNode' = 2 */ /* uneffect:temporal action retainSelections: primaryNode' = primaryNode, backupNode' = backupNode */ /* uneffect:temporal invariant primaryNodeIsKnown: nodes.contains(primaryNode) */ /* uneffect:temporal invariant backupNodeIsKnown: nodes.contains(backupNode) */ /* uneffect:temporal invariant selectedLeasesAreFenced: (!leases.getOrElse(primaryNode, { epoch: 0, valid: false }).valid || leases.keys().contains(primaryNode)) && (!leases.getOrElse(backupNode, { epoch: 0, valid: false }).valid || leases.keys().contains(backupNode)) */

// Real lease readers commonly retain a primary and a standby selection. The
// bounded model keeps both selectors in the same immutable node registry, but
// Uneffect must prove each membership invariant independently before decoding
// the shared lease Map with both dynamic keys.
export interface PrimaryBackupLeaseRecord {
  epoch: number;
  valid: boolean;
}

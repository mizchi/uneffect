/* uneffect:temporal state nodes: Set<int> */ /* uneffect:temporal state selectedNode: int */ /* uneffect:temporal state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:temporal init nodes = Set(1, 2) */ /* uneffect:temporal init selectedNode = 1 */ /* uneffect:temporal init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:temporal action selectStandby: selectedNode' = 2 */ /* uneffect:temporal action retainSelection: selectedNode' = selectedNode */ /* uneffect:temporal invariant selectedNodeIsKnown: nodes.contains(selectedNode) */ /* uneffect:temporal invariant absentSelectedLeaseIsFenced: !leases.getOrElse(selectedNode, { epoch: 0, valid: false }).valid || leases.keys().contains(selectedNode) */

// The finite node registry is immutable in this bounded model. Uneffect must
// prove that every selectedNode remains in it before using the registry values
// as a complete observation universe for the dynamic lease-table lookup.
export interface DynamicLeaseRecord {
  epoch: number;
  valid: boolean;
}

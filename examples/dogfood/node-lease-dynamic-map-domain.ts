/* uneffect:state nodes: Set<int> */ /* uneffect:state selectedNode: int */ /* uneffect:state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:init nodes = Set(1, 2) */ /* uneffect:init selectedNode = 1 */ /* uneffect:init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:action selectStandby: selectedNode' = 2 */ /* uneffect:action retainSelection: selectedNode' = selectedNode */ /* uneffect:always selectedNodeIsKnown: nodes.contains(selectedNode) */ /* uneffect:always absentSelectedLeaseIsFenced: !leases.getOrElse(selectedNode, { epoch: 0, valid: false }).valid || leases.keys().contains(selectedNode) */

// The finite node registry is immutable in this bounded model. Uneffect must
// prove that every selectedNode remains in it before using the registry values
// as a complete observation universe for the dynamic lease-table lookup.
export interface DynamicLeaseRecord {
  epoch: number;
  valid: boolean;
}

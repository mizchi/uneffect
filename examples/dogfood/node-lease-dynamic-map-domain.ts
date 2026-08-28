/* uneffect:
  state nodes: Set<int>
  state selectedNode: int
  state leases: Map<int, { epoch: int, valid: bool }>
  init nodes = Set(1, 2)
  init selectedNode = 1
  init leases = Map([[1, { epoch: 1, valid: true }]])
  action selectStandby: selectedNode' = 2
  action retainSelection: selectedNode' = selectedNode
  temporal selectedNodeIsKnown: nodes.contains(selectedNode)
  temporal absentSelectedLeaseIsFenced: !leases.getOrElse(selectedNode, { epoch: 0, valid: false }).valid || leases.keys().contains(selectedNode)
*/

// The finite node registry is immutable in this bounded model. Uneffect must
// prove that every selectedNode remains in it before using the registry values
// as a complete observation universe for the dynamic lease-table lookup.
export interface DynamicLeaseRecord {
  epoch: number;
  valid: boolean;
}

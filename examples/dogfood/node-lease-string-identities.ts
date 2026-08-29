/* uneffect:
  state nodes: Set<string>
  state selectedNode: string
  state leases: Map<string, { epoch: int, valid: bool }>
  state writeAllowed: bool
  init nodes = Set("node-a", "node-b")
  init selectedNode = "node-a"
  init leases = Map([["node-a", { epoch: 1, valid: true }]])
  init writeAllowed = false
  action selectStandby: selectedNode' = "node-b", writeAllowed' = false
  action checkLease: writeAllowed' = leases.getOrElse(selectedNode, { epoch: 0, valid: false }).valid
  temporal selectedNodeIsKnown: nodes.contains(selectedNode)
  temporal missingLeaseIsFenced: !writeAllowed || leases.keys().contains(selectedNode)
*/

// Production lease identities are strings. This fixture prevents the model
// from gaining accidental safety by replacing application IDs with integers.
export interface StringIdentityLease {
  epoch: number;
  valid: boolean;
}

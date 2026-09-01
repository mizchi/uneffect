/* uneffect:state nodes: Set<string> */ /* uneffect:state selectedNode: string */ /* uneffect:state leases: Map<string, { epoch: int, valid: bool }> */ /* uneffect:state writeAllowed: bool */ /* uneffect:init nodes = Set("node-a", "node-b") */ /* uneffect:init selectedNode = "node-a" */ /* uneffect:init leases = Map([["node-a", { epoch: 1, valid: true }]]) */ /* uneffect:init writeAllowed = false */ /* uneffect:action selectStandby: selectedNode' = "node-b", writeAllowed' = false */ /* uneffect:action checkLease: writeAllowed' = leases.getOrElse(selectedNode, { epoch: 0, valid: false }).valid */ /* uneffect:always selectedNodeIsKnown: nodes.contains(selectedNode) */ /* uneffect:always missingLeaseIsFenced: !writeAllowed || leases.keys().contains(selectedNode) */

// Production lease identities are strings. This fixture prevents the model
// from gaining accidental safety by replacing application IDs with integers.
export interface StringIdentityLease {
  epoch: number;
  valid: boolean;
}

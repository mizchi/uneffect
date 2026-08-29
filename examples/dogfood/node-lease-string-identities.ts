/* uneffect:temporal state nodes: Set<string> */ /* uneffect:temporal state selectedNode: string */ /* uneffect:temporal state leases: Map<string, { epoch: int, valid: bool }> */ /* uneffect:temporal state writeAllowed: bool */ /* uneffect:temporal init nodes = Set("node-a", "node-b") */ /* uneffect:temporal init selectedNode = "node-a" */ /* uneffect:temporal init leases = Map([["node-a", { epoch: 1, valid: true }]]) */ /* uneffect:temporal init writeAllowed = false */ /* uneffect:temporal action selectStandby: selectedNode' = "node-b", writeAllowed' = false */ /* uneffect:temporal action checkLease: writeAllowed' = leases.getOrElse(selectedNode, { epoch: 0, valid: false }).valid */ /* uneffect:temporal invariant selectedNodeIsKnown: nodes.contains(selectedNode) */ /* uneffect:temporal invariant missingLeaseIsFenced: !writeAllowed || leases.keys().contains(selectedNode) */

// Production lease identities are strings. This fixture prevents the model
// from gaining accidental safety by replacing application IDs with integers.
export interface StringIdentityLease {
  epoch: number;
  valid: boolean;
}

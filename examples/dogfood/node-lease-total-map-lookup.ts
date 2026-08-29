/* uneffect:temporal state nodes: Set<int> */ /* uneffect:temporal state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:temporal state writeAllowed: bool */ /* uneffect:temporal init nodes = Set(1, 2) */ /* uneffect:temporal init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:temporal init writeAllowed = false */ /* uneffect:temporal action checkLease: writeAllowed' = leases.getOrElse(3, { epoch: 0, valid: false }).valid */ /* uneffect:temporal invariant unknownNodeCannotWrite: !writeAllowed || nodes.contains(3) */

// The temporal model is intentionally build-time-only. A missing lease-table
// entry defaults to a fenced record instead of relying on partial Map.get.
export interface LeaseRecord {
  epoch: number;
  valid: boolean;
}

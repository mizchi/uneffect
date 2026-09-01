/* uneffect:state nodes: Set<int> */ /* uneffect:state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:state writeAllowed: bool */ /* uneffect:init nodes = Set(1, 2) */ /* uneffect:init leases = Map([[1, { epoch: 1, valid: true }]]) */ /* uneffect:init writeAllowed = false */ /* uneffect:action checkLease: writeAllowed' = leases.getOrElse(3, { epoch: 0, valid: false }).valid */ /* uneffect:always unknownNodeCannotWrite: !writeAllowed || nodes.contains(3) */

// The temporal model is intentionally build-time-only. A missing lease-table
// entry defaults to a fenced record instead of relying on partial Map.get.
export interface LeaseRecord {
  epoch: number;
  valid: boolean;
}

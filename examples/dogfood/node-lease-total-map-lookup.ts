/* uneffect:
  state nodes: Set<int>
  state leases: Map<int, { epoch: int, valid: bool }>
  state writeAllowed: bool
  init nodes = Set(1, 2)
  init leases = Map([[1, { epoch: 1, valid: true }]])
  init writeAllowed = false
  action checkLease: writeAllowed' = leases.getOrElse(3, { epoch: 0, valid: false }).valid
  temporal unknownNodeCannotWrite: !writeAllowed || nodes.contains(3)
*/

// The temporal model is intentionally build-time-only. A missing lease-table
// entry defaults to a fenced record instead of relying on partial Map.get.
export interface LeaseRecord {
  epoch: number;
  valid: boolean;
}

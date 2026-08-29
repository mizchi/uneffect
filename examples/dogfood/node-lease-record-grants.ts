/* uneffect:
  state grants: Set<{ owner: string, epoch: int, valid: bool }>
  init grants = Set({ owner: "node-a", epoch: 1, valid: true })
  action admitStandby: grants' = grants.union(Set({ owner: "node-b", epoch: 2, valid: true }))
  temporal validGrantHasEpoch: grants.forall(grant => !grant.valid || grant.epoch > 0)
*/

// Lease grants are domain values, not parallel scalar collections. Keeping the
// record intact makes a counterexample identify the exact invalid grant.
export interface LeaseGrant {
  owner: string;
  epoch: number;
  valid: boolean;
}

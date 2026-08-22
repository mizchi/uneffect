import { rebuildLease, snapshotLease } from "./lease-projection-helpers.js";

/* uneffect:
  state lease: { owner: int, epoch: int, valid: bool }
  init lease = { owner: 0, epoch: 0, valid: false }
  action renew: lease' = { ...lease, epoch: lease.epoch + 1 }
  action takeover: lease' = { ...lease, epoch: lease.epoch + 1, owner: lease.owner + 1 }
*/

export interface LeaseState {
  lease: {
    owner: number;
    epoch: number;
    valid: boolean;
  };
}

/* uneffect: refinement leaseProjection@1 create */
export function createLeaseRuntime(initial: LeaseState): LeaseState {
  return rebuildLease(initial);
}

/* uneffect: refinement leaseProjection@1 observe */
export function observeLeaseRuntime(runtime: LeaseState): LeaseState {
  return snapshotLease(runtime);
}

/* uneffect: refinement leaseProjection@1 action renew */
export function renewLeaseEpoch(runtime: LeaseState): void {
  runtime.lease = {
    ...runtime.lease,
    epoch: runtime.lease.epoch + 1,
  };
}

/* uneffect: refinement leaseProjection@1 action takeover */
export function takeoverLease(runtime: LeaseState): void {
  runtime.lease.owner++;
  runtime.lease.epoch++;
}

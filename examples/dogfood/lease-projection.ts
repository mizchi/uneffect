/* uneffect:refinement_from "./lease-projection.uneffect.ts#default" */
import { rebuildLease, snapshotLease } from "./lease-projection-helpers.js";

/* uneffect:state lease: { owner: int, epoch: int, valid: bool } */ /* uneffect:init lease = { owner: 0, epoch: 0, valid: false } */ /* uneffect:action renew: lease' = { ...lease, epoch: lease.epoch + 1 } */ /* uneffect:action takeover: lease' = { ...lease, epoch: lease.epoch + 1, owner: lease.owner + 1 } */

export interface LeaseState {
  lease: {
    owner: number;
    epoch: number;
    valid: boolean;
  };
}

export function createLeaseRuntime(initial: LeaseState): LeaseState {
  return rebuildLease(initial);
}

export function observeLeaseRuntime(runtime: LeaseState): LeaseState {
  return snapshotLease(runtime);
}

export function renewLeaseEpoch(runtime: LeaseState): void {
  runtime.lease = {
    ...runtime.lease,
    epoch: runtime.lease.epoch + 1,
  };
}

export function takeoverLease(runtime: LeaseState): void {
  runtime.lease.owner++;
  runtime.lease.epoch++;
}

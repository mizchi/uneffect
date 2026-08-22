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

function rebuildLease(state: LeaseState): LeaseState {
  return {
    lease: {
      owner: state.lease.owner,
      epoch: state.lease.epoch,
      valid: state.lease.valid,
    },
  };
}

/* uneffect: refinement leaseProjection@1 create */
export function createLeaseRuntime(initial: LeaseState): LeaseState {
  return rebuildLease(initial);
}

function snapshotLease(runtime: LeaseState): LeaseState {
  const { lease } = runtime;
  return {
    lease: {
      owner: lease.owner,
      epoch: lease.epoch,
      valid: lease.valid,
    },
  };
}

/* uneffect: refinement leaseProjection@1 observe */
export function observeLeaseRuntime(runtime: LeaseState): LeaseState {
  return snapshotLease(runtime);
}

/* uneffect: refinement leaseProjection@1 action renew */
export function renewLeaseEpoch(runtime: LeaseState): void {
  runtime.lease.epoch++;
}

/* uneffect: refinement leaseProjection@1 action takeover */
export function takeoverLease(runtime: LeaseState): void {
  runtime.lease.owner++;
  runtime.lease.epoch++;
}

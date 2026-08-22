/* uneffect:
  state lease: { owner: int, epoch: int, valid: bool }
  init lease = { owner: 0, epoch: 0, valid: false }
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

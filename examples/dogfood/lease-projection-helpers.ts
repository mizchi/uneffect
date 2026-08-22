export interface LeaseProjectionState {
  lease: {
    owner: number;
    epoch: number;
    valid: boolean;
  };
}

export function rebuildLease(state: LeaseProjectionState): LeaseProjectionState {
  return {
    lease: {
      owner: state.lease.owner,
      epoch: state.lease.epoch,
      valid: state.lease.valid,
    },
  };
}

export function snapshotLease(runtime: LeaseProjectionState): LeaseProjectionState {
  const { lease } = runtime;
  return {
    lease: {
      owner: lease.owner,
      epoch: lease.epoch,
      valid: lease.valid,
    },
  };
}

/* uneffect:
  state authority: { owners: Set<int>, epochs: Map<int, int> }
  init authority = { owners: Set(1), epochs: Map([[1, 0]]) }
  action admitOwner: authority' = { ...authority, owners: authority.owners.union(Set(2)) }
  action publishEpoch: authority' = { ...authority, epochs: authority.epochs.put(2, 1) }
*/

export interface LeaseAuthorityRuntime {
  authority: {
    owners: Set<number>;
    epochs: Map<number, number>;
  };
}

/* uneffect: refinement leaseAuthority@1 create */
export function createLeaseAuthority(initial: LeaseAuthorityRuntime): LeaseAuthorityRuntime {
  return initial;
}

/* uneffect: refinement leaseAuthority@1 observe */
export function observeLeaseAuthority(runtime: LeaseAuthorityRuntime): LeaseAuthorityRuntime {
  return runtime;
}

/* uneffect: refinement leaseAuthority@1 action admitOwner */
export function admitLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.owners.add(2);
}

/* uneffect: refinement leaseAuthority@1 action publishEpoch */
export function publishLeaseEpoch(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.epochs.set(2, 1);
}

import { revokeOwner } from "./lease-authority-operations.js";
import * as LeaseAuthorityOperations from "./lease-authority-operations.js";

const revokeOwnerOperation = revokeOwner;
const revokeNamespacedOwnerOperation = LeaseAuthorityOperations.revokeOwner;

/* uneffect:
  state authority: { owners: Set<int>, epochs: Map<int, int> }
  init authority = { owners: Set(1), epochs: Map([[1, 0]]) }
  action admitOwner: authority' = { ...authority, owners: authority.owners.union(Set(2)) }
  action publishEpoch: authority' = { ...authority, epochs: authority.epochs.put(2, 1) }
  action revokeOwners: authority' = { ...authority, owners: Set() }
  action clearEpochs: authority' = { ...authority, epochs: Map([]) }
  action revokeOwner: authority' = { ...authority, owners: authority.owners.exclude(Set(1)) }
  action retireEpoch: authority' = { ...authority, epochs: authority.epochs.remove(1) }
  action revokeImportedOwner: authority' = { ...authority, owners: authority.owners.exclude(Set(1)) }
  action revokeNamespacedOwner: authority' = { ...authority, owners: authority.owners.exclude(Set(1)) }
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

/* uneffect: refinement leaseAuthority@1 action revokeOwners */
export function revokeLeaseOwners(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.owners.clear();
}

/* uneffect: refinement leaseAuthority@1 action clearEpochs */
export function clearLeaseEpochs(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.epochs.clear();
}

/* uneffect: refinement leaseAuthority@1 action revokeOwner */
export function revokeLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.owners.delete(1);
}

/* uneffect: refinement leaseAuthority@1 action retireEpoch */
export function retireLeaseEpoch(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.epochs.delete(1);
}

/* uneffect: refinement leaseAuthority@1 action revokeImportedOwner */
export function revokeImportedLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  revokeOwnerOperation(runtime, 1);
}

/* uneffect: refinement leaseAuthority@1 action revokeNamespacedOwner */
export function revokeNamespacedLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  revokeNamespacedOwnerOperation(runtime, 1);
}

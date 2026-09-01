/* uneffect:refinement_from "./lease-authority-refinement.uneffect.ts#default" */
import { revokeOwner } from "./lease-authority-operations.js";
import * as LeaseAuthorityOperations from "./lease-authority-operations.js";

const revokeOwnerOperation = revokeOwner;
const revokeNamespacedOwnerOperation = LeaseAuthorityOperations.revokeOwner;

/* uneffect:state authority: { owners: Set<int>, epochs: Map<int, int> } */ /* uneffect:init authority = { owners: Set(1), epochs: Map([[1, 0]]) } */ /* uneffect:action admitOwner: authority' = { ...authority, owners: authority.owners.union(Set(2)) } */ /* uneffect:action publishEpoch: authority' = { ...authority, epochs: authority.epochs.put(2, 1) } */ /* uneffect:action revokeOwners: authority' = { ...authority, owners: Set() } */ /* uneffect:action clearEpochs: authority' = { ...authority, epochs: Map([]) } */ /* uneffect:action revokeOwner: authority' = { ...authority, owners: authority.owners.exclude(Set(1)) } */ /* uneffect:action retireEpoch: authority' = { ...authority, epochs: authority.epochs.remove(1) } */ /* uneffect:action revokeImportedOwner: authority' = { ...authority, owners: authority.owners.exclude(Set(1)) } */ /* uneffect:action revokeNamespacedOwner: authority' = { ...authority, owners: authority.owners.exclude(Set(1)) } */

export interface LeaseAuthorityRuntime {
  authority: {
    owners: Set<number>;
    epochs: Map<number, number>;
  };
}

export function createLeaseAuthority(initial: LeaseAuthorityRuntime): LeaseAuthorityRuntime {
  return initial;
}

export function observeLeaseAuthority(runtime: LeaseAuthorityRuntime): LeaseAuthorityRuntime {
  return runtime;
}

export function admitLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.owners.add(2);
}

export function publishLeaseEpoch(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.epochs.set(2, 1);
}

export function revokeLeaseOwners(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.owners.clear();
}

export function clearLeaseEpochs(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.epochs.clear();
}

export function revokeLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.owners.delete(1);
}

export function retireLeaseEpoch(runtime: LeaseAuthorityRuntime): void {
  runtime.authority.epochs.delete(1);
}

export function revokeImportedLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  revokeOwnerOperation(runtime, 1);
}

export function revokeNamespacedLeaseOwner(runtime: LeaseAuthorityRuntime): void {
  revokeNamespacedOwnerOperation(runtime, 1);
}

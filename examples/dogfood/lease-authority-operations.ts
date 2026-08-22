export interface OwnerAuthority {
  authority: {
    owners: Set<number>;
  };
}

function deleteOwner(runtime: OwnerAuthority, owner: number): void {
  runtime.authority.owners.delete(owner);
}

export function revokeOwner(runtime: OwnerAuthority, owner: number): void {
  deleteOwner(runtime, owner);
}

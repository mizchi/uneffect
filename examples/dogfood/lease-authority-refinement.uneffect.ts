import { defineRefinement } from "@mizchi/uneffect/spec";
import { admitLeaseOwner, clearLeaseEpochs, createLeaseAuthority, observeLeaseAuthority, publishLeaseEpoch, retireLeaseEpoch, revokeImportedLeaseOwner, revokeLeaseOwner, revokeLeaseOwners, revokeNamespacedLeaseOwner } from "./lease-authority-refinement.js";

export default defineRefinement({
  name: "leaseAuthority",
  version: "1",
  create: createLeaseAuthority,
  observe: observeLeaseAuthority,
  abstractions: {},
  actions: {
    "admitOwner": admitLeaseOwner,
    "publishEpoch": publishLeaseEpoch,
    "revokeOwners": revokeLeaseOwners,
    "clearEpochs": clearLeaseEpochs,
    "revokeOwner": revokeLeaseOwner,
    "retireEpoch": retireLeaseEpoch,
    "revokeImportedOwner": revokeImportedLeaseOwner,
    "revokeNamespacedOwner": revokeNamespacedLeaseOwner,
  },
  invariants: {},
});

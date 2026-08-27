/** Proof-relevant identity for the ECMAScript global object in the current Realm. */
export interface SameRealmGlobalThisIdentity {
  kind: "ambient";
  root: "globalThis";
  identity: "ecmascript:realm.globalThis";
}

export const SAME_REALM_GLOBAL_THIS_IDENTITY: SameRealmGlobalThisIdentity = {
  kind: "ambient",
  root: "globalThis",
  identity: "ecmascript:realm.globalThis",
};

export type RefinementRuntimeIdentity = SameRealmGlobalThisIdentity;

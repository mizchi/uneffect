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

/** Opt-in identity for Node's ambient `global` in the current runtime Realm. */
export interface NodeCurrentRealmGlobalIdentity {
  kind: "host";
  host: "node";
  root: "global";
  version: string;
  realm: string;
  identity: string;
}

export function nodeCurrentRealmGlobalIdentity(version: string, realm: string): NodeCurrentRealmGlobalIdentity {
  return {
    kind: "host",
    host: "node",
    root: "global",
    version,
    realm,
    identity: `node:${version}:realm:${realm}.global`,
  };
}

export function parseRefinementRuntimeIdentity(value: string): RefinementRuntimeIdentity | undefined {
  if (value === "globalThis") return SAME_REALM_GLOBAL_THIS_IDENTITY;
  const nodeGlobal = /^node:global@([1-9][0-9]*)#([A-Za-z_$][\w$.-]*)$/.exec(value);
  return nodeGlobal ? nodeCurrentRealmGlobalIdentity(nodeGlobal[1]!, nodeGlobal[2]!) : undefined;
}

export type RefinementRuntimeIdentity = SameRealmGlobalThisIdentity | NodeCurrentRealmGlobalIdentity;

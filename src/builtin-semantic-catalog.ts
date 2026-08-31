import type { BuiltinContract } from "./builtin-contracts.js";

export type BuiltinSemanticPlatform = "javascript" | "node" | "dom";
export interface ReviewedBuiltinSemantic extends Omit<BuiltinContract, "evidence"> {
  platform: BuiltinSemanticPlatform;
  stability: "reviewed";
}
export interface BuiltinSemanticCatalog {
  schema: "uneffect-builtin-semantics/v1";
  definitions: readonly ReviewedBuiltinSemantic[];
}

const reviewed = (platform: BuiltinSemanticPlatform, definition: Omit<ReviewedBuiltinSemantic, "platform" | "stability">): ReviewedBuiltinSemantic =>
  ({ ...definition, platform, stability: "reviewed" });

export const builtinSemanticCatalog: BuiltinSemanticCatalog = {
  schema: "uneffect-builtin-semantics/v1",
  definitions: [
    ...(["Array", "ReadonlyArray"] as const).map((owner) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `${owner}#toSorted` },
      operation: { kind: "inline-callback", callbackArguments: [0] }, result: { kind: "fresh" },
      trustReason: `ECMAScript ${owner}.toSorted returns a fresh Array and invokes its optional comparator synchronously`, trustOwner: "@mizchi/uneffect",
    })),
    ...(["keys", "entries"] as const).map((name) => reviewed("javascript", {
      symbol: { module: "lib.es", export: `ObjectConstructor#${name}` }, result: { kind: "fresh" },
      trustReason: `ECMAScript Object.${name} returns a newly allocated Array`, trustOwner: "@mizchi/uneffect",
    })),
    reviewed("node", { symbol: { module: "node:module", export: "createRequire" }, trustReason: "Node createRequire constructs a resolver without loading a target", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", { symbol: { module: "node:path", export: "join" }, trustReason: "Node path.join is a deterministic lexical path operation", trustOwner: "@mizchi/uneffect" }),
    reviewed("node", { symbol: { module: "lib.node", export: "Process#cwd" }, trustReason: "Node process.cwd reads launch configuration without a Deno-style permission", trustOwner: "@mizchi/uneffect" }),
    ...["getItem", "key"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Storage#${name}` }, operation: { kind: "effect", effect: "LocalStorageRead" } })),
    ...["setItem", "removeItem", "clear"].map((name) => reviewed("dom", { symbol: { module: "lib.dom", export: `Storage#${name}` }, operation: { kind: "effect", effect: "LocalStorageWrite" } })),
  ],
};

export function compileBuiltinSemanticCatalog(catalog: BuiltinSemanticCatalog): BuiltinContract[] {
  if (catalog.schema !== "uneffect-builtin-semantics/v1") throw new Error(`unsupported builtin semantic catalog schema: ${catalog.schema}`);
  const seen = new Set<string>();
  for (const definition of catalog.definitions) {
    const id = `${definition.symbol.module}#${definition.symbol.export}`;
    if (seen.has(id)) throw new Error(`duplicate builtin semantic definition: ${id}`);
    seen.add(id);
  }
  return materializeBuiltinSemanticDefinitions(catalog.definitions);
}

/** Materialize the repository-owned catalog after its duplicate validation test. */
export function materializeBuiltinSemanticDefinitions(definitions: readonly ReviewedBuiltinSemantic[]): BuiltinContract[] {
  return definitions.map(({ platform: _platform, stability: _stability, ...definition }) => ({ ...definition, evidence: "trusted" }));
}

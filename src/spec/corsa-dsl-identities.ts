import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CorsaApiFrontend } from "../frontends/corsa/corsa-api-frontend.js";
import { parseNativeNodeHandle } from "../frontends/corsa/native-source-index.js";
import { parseOxcSource } from "../frontends/oxc/source.js";
import { dslImports } from "../frontends/oxc/dsl.js";

export type CorsaDslKind = "temporal" | "contract" | "capability" | "refinement";
const helpers = {
  temporal: ["defineTemporal", "int", "bool", "text"],
  contract: ["defineContract", "int", "nat", "float", "bool"],
  capability: ["defineCapability", "defineEffectSchema", "Custom", "Console", "Fetch", "FsRead", "FsWrite", "Throw", "Builtin"],
  refinement: ["defineRefinement", "globalRuntime", "nodeGlobalRuntime", "identityProjection", "setFromArrayProjection", "mapFromEntriesProjection"],
} as const;

function canonicalPath(file: string): string {
  const path = file.replaceAll("\\", "/");
  return process.platform === "win32" || process.platform === "darwin" ? path.toLowerCase() : path;
}
function declarationFiles(helper: string, kind: CorsaDslKind): string[] {
  const owner = kind === "capability" ? "../effects/capability-authoring"
    : kind === "refinement" ? "../refinement/refinement-authoring"
    : ["defineContract", "nat", "float"].includes(helper) ? "../contracts/contract-authoring" : "./temporal-authoring";
  return [".ts", ".d.ts"].map(extension => fileURLToPath(new URL(owner + extension, import.meta.url)))
    .filter(existsSync).flatMap(file => [...new Set([file, realpathSync(file)])]).map(canonicalPath);
}

/**
 * Authenticate value-import helpers against this package's declarations through
 * Corsa aliases. The supplied source must match the caller-owned snapshot.
 * This checks helper identities only, not compiler diagnostics or implementation signatures.
 */
export function validateCorsaDslHelperIdentities(frontend: Pick<CorsaApiFrontend, "getSymbolAtPosition" | "getAliasedSymbol">, fileName: string, text: string, kind: CorsaDslKind): void {
  if (!Object.hasOwn(helpers, kind)) throw new TypeError("DSL kind must be temporal, contract, capability, or refinement");
  const source = parseOxcSource(fileName, text);
  const imported = dslImports(source, helpers[kind]);
  for (const statement of source.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "@mizchi/uneffect/spec") continue;
    for (const element of statement.specifiers) {
      if (element.type !== "ImportSpecifier") continue;
      const exported = imported.get(element.local.name);
      if (!exported) continue;
      const symbol = frontend.getSymbolAtPosition(fileName, element.local.start);
      const target = symbol && (frontend.getAliasedSymbol(symbol) ?? symbol);
      const expected = declarationFiles(exported, kind);
      const valid = symbol?.name === element.local.name && target?.name === exported
        && target.declarations?.some(declaration => expected.includes(canonicalPath(parseNativeNodeHandle(declaration).path)));
      if (!valid) throw new Error(`${fileName}: ${element.local.name} does not resolve to @mizchi/uneffect/spec#${exported} by Corsa symbol identity`);
    }
  }
}

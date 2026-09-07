import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

function canonical(file: string): string {
  const path = file.replaceAll("\\", "/");
  return process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path;
}

/** A numeric contract brand must come from this package's actual declaration. */
export function numericContractDomain(name: string | undefined, declarations: readonly string[]): "nat" | "float" | undefined {
  if (name !== "Nat" && name !== "Float") return undefined;
  const owners = ["../runtime/numeric.ts", "../runtime/numeric.d.ts", "../project/verifier-package-contract.d.ts"]
    .map(path => fileURLToPath(new URL(path, import.meta.url)))
    .filter(existsSync).flatMap(file => [file, realpathSync(file)]).map(canonical);
  return declarations.some(file => owners.includes(canonical(file))) ? name === "Nat" ? "nat" : "float" : undefined;
}

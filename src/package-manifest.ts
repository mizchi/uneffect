/* uneffect:module_effect none */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface PackageManifest {
  name?: string;
  version?: string;
  engines?: { node?: string };
  peerDependencies?: Record<string, string>;
}

/** Read this package's own manifest, from either the source tree or the published `dist/src`. */
/* uneffect:effect FsRead */
export async function readPackageManifest(): Promise<PackageManifest> {
  for (const candidate of ["../package.json", "../../package.json"]) {
    try {
      const manifest = JSON.parse(await readFile(join(import.meta.dirname, candidate), "utf8")) as PackageManifest;
      if (manifest.name === "@mizchi/uneffect") return manifest;
    } catch {
      continue;
    }
  }
  return {};
}

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Inspect a tsconfig without loading the JavaScript TypeScript package.
 * File membership itself comes from Corsa `rootFiles` after open.
 */
export function inspectProjectConfig(projectFile: string): {
  absolute: string;
  hasReferences: boolean;
  parseError?: string;
} {
  const absolute = resolve(projectFile);
  const text = readFileSync(absolute, "utf8");
  try {
    const config = JSON.parse(text) as { references?: unknown };
    return {
      absolute,
      hasReferences: Array.isArray(config.references) && config.references.length > 0,
    };
  } catch (cause) {
    return {
      absolute,
      hasReferences: /"references"\s*:/.test(text),
      parseError: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Write a temporary tsconfig so Corsa can open file-specified checks without
 * a consumer project or the JavaScript TypeScript package.
 */
export function writeEphemeralCorsaProject(fileNames: readonly string[]): { configFile: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-"));
  const configFile = join(directory, "tsconfig.json");
  writeFileSync(configFile, `${JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2022", "DOM"],
    },
    files: fileNames.map((file) => resolve(file)),
  }, null, 2)}\n`);
  return { configFile, directory };
}

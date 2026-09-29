import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

// TypeScript already publishes its Compiler API as one self-contained JS file.
// Keep its standard library and API declarations next to that file so the
// packaged compiler can create Programs without resolving a consumer peer.
const require = createRequire(import.meta.url);
const wrapperManifestFile = require.resolve("@typescript/typescript6/package.json");
const compilerRequire = createRequire(wrapperManifestFile);
const compilerManifestFile = compilerRequire.resolve("@typescript/old/package.json");
const compilerRoot = dirname(compilerManifestFile);
const compilerManifest = JSON.parse(readFileSync(compilerManifestFile, "utf8"));
const compilerLib = join(compilerRoot, "lib");
const output = resolve("dist/src/support/typescript-compiler");
const outputLib = join(output, "lib");
mkdirSync(outputLib, { recursive: true });

for (const name of readdirSync(compilerLib)) {
  if (name === "typescript.js" || name === "typescript.d.ts" || /^lib\..*\.d\.ts$/.test(name)) {
    copyFileSync(join(compilerLib, name), join(outputLib, name));
  }
}
copyFileSync(join(compilerRoot, "LICENSE.txt"), join(output, "LICENSE.txt"));
writeFileSync(join(output, "package.json"), `${JSON.stringify({
  name: "@mizchi/uneffect-internal-typescript6",
  version: compilerManifest.version,
  type: "commonjs",
  private: true,
}, null, 2)}\n`);

const boundary = resolve("dist/src/support/typescript-compiler.js");
const declarations = resolve("dist/src/support/typescript-compiler.d.ts");
function replaceOnce(file, oldText, newText) {
  const source = readFileSync(file, "utf8");
  if (source.split(oldText).length !== 2) throw new Error(`Unexpected compiler boundary in ${file}: ${oldText}`);
  writeFileSync(file, source.replace(oldText, newText));
}
replaceOnce(boundary, 'import ts from "@typescript/typescript6";', 'import ts from "./typescript-compiler/lib/typescript.js";');
replaceOnce(boundary, 'require.resolve("@typescript/typescript6/package.json")',
  'require.resolve("./typescript-compiler/package.json")');
replaceOnce(declarations, 'import ts from "@typescript/typescript6";',
  'import ts from "./typescript-compiler/lib/typescript.js";');

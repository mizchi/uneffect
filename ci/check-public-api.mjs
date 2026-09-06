import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "@typescript/typescript6";

const snapshotSchema = "uneffect-public-api-snapshot/v1";
const snapshotFile = resolve("api/public-api-v0.3.json");
const update = process.argv.includes("--update");
const entrypoints = [
  { name: "./module-order", runtime: "dist/src/modules/module-order-api.js", declarations: "dist/src/modules/module-order-api.d.ts" },
  { name: "./workflow", runtime: "dist/src/graph-analysis/workflow-api.js", declarations: "dist/src/graph-analysis/workflow-api.d.ts" },
  { name: "./impact", runtime: "dist/src/graph-analysis/impact-api.js", declarations: "dist/src/graph-analysis/impact-api.d.ts" },
  { name: "./cfg", runtime: "dist/src/cfg/index.js", declarations: "dist/src/cfg/index.d.ts" },
  { name: ".", runtime: "dist/src/api/public.js", declarations: "dist/src/api/public.d.ts" },
  { name: "./corsa", runtime: "dist/src/api/corsa-public.js", declarations: "dist/src/api/corsa-public.d.ts" },
  { name: "./corsa/api", runtime: "dist/src/frontends/corsa/corsa-api-frontend.js", declarations: "dist/src/frontends/corsa/corsa-api-frontend.d.ts" },
  { name: "./spec", runtime: "dist/src/spec/index.js", declarations: "dist/src/spec/index.d.ts" },
];

const declarationFiles = entrypoints.map(({ declarations }) => resolve(declarations));
for (const file of declarationFiles) {
  if (!existsSync(file)) throw new Error(`public API declaration is missing: ${file}; run pnpm build first`);
}

const program = ts.createProgram(declarationFiles, {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2024,
  types: [],
});
const checker = program.getTypeChecker();

function normalizeDeclaration(node) {
  return node.getText(node.getSourceFile()).replaceAll("\r\n", "\n").trim();
}

function declarationInventory(file) {
  const source = program.getSourceFile(resolve(file));
  if (!source) throw new Error(`public API declaration was not loaded: ${file}`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`public API declaration has no module symbol: ${file}`);
  return checker.getExportsOfModule(moduleSymbol).map((exported) => {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const declarations = (symbol.getDeclarations() ?? []).map(normalizeDeclaration).sort();
    if (declarations.length === 0) throw new Error(`public API export has no declaration: ${exported.name}`);
    return { name: exported.name, declarations };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

const collected = {};
for (const entrypoint of entrypoints) {
  const module = await import(`${pathToFileURL(resolve(entrypoint.runtime)).href}?api-snapshot`);
  collected[entrypoint.name] = {
    runtime: Object.keys(module).sort(),
    declarations: declarationInventory(entrypoint.declarations),
  };
}

const current = `${JSON.stringify({ schema: snapshotSchema, entrypoints: collected }, null, 2)}\n`;
if (update) {
  mkdirSync(resolve("api"), { recursive: true });
  writeFileSync(snapshotFile, current);
  process.stdout.write(`updated ${snapshotFile}\n`);
} else {
  if (!existsSync(snapshotFile)) throw new Error(`public API snapshot is missing: ${snapshotFile}`);
  const expected = readFileSync(snapshotFile, "utf8");
  if (current !== expected) {
    throw new Error("public API snapshot drift; review the compatibility impact and run node ci/check-public-api.mjs --update only for an intentional additive contract change");
  }
  process.stdout.write(`public API snapshot matches ${snapshotFile}\n`);
}

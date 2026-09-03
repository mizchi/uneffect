import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "uneffect-package-smoke-"));

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");

  const consumer = join(temporary, "consumer");
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", consumer, join(temporary, filename)], { stdio: "inherit" });
  const smoke = join(consumer, "smoke.mjs");
  writeFileSync(smoke, `
    import * as root from "@mizchi/uneffect";
    import * as experimental from "@mizchi/uneffect/experimental";
    import * as spec from "@mizchi/uneffect/spec";
    import ts from "typescript";

    const requiredRoot = ["analyzeEffects", "analyzeProgramEffects", "verifyUneffectProject", "generateTemporalModel"];
    for (const name of requiredRoot) if (typeof root[name] !== "function") throw new Error(\`missing public root API: \${name}\`);
    const parsedEffects = root.parseEffectSet("Console");
    const effectDiagnostics = root.analyzeEffects("smoke.ts", "/* uneffect:effect Console */\\nexport function run() { console.log(1) }");
    if (parsedEffects.length !== 1 || effectDiagnostics.some((diagnostic) => diagnostic.severity === "error"))
      throw new Error("public Effect tracking smoke failed");
    for (const name of ["executeZ3", "logicToSmt", "solveBasicBlockFixedPoint"])
      if (name in root) throw new Error(\`experimental API leaked from package root: \${name}\`);
    for (const name of ["executeZ3", "logicToSmt", "solveBasicBlockFixedPoint"])
      if (typeof experimental[name] !== "function") throw new Error(\`missing experimental API: \${name}\`);
    if (typeof spec.defineTemporal !== "function") throw new Error("missing specification API");
    if (!ts.version.startsWith("6.")) throw new Error(\`package smoke resolved unsupported TypeScript \${ts.version}\`);
    console.log(JSON.stringify({ typescript: ts.version, rootExports: Object.keys(root).length }));
  `);
  execFileSync(process.execPath, [smoke], { cwd: consumer, stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

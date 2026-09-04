import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "uneffect-package-smoke-"));

try {
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
  const filename = packed[0]?.filename;
  if (typeof filename !== "string") throw new Error("npm pack did not report a tarball filename");

  const consumer = join(temporary, "consumer");
  const typescript6Package = dirname(createRequire(import.meta.url).resolve("@typescript/typescript6/package.json"));
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", consumer, join(temporary, filename), typescript6Package], { stdio: "inherit" });
  const smoke = join(consumer, "smoke.mjs");
  writeFileSync(smoke, `
    import * as root from "@mizchi/uneffect";
    import * as experimental from "@mizchi/uneffect/experimental";
    import * as spec from "@mizchi/uneffect/spec";
    import ts from "@typescript/typescript6";

    const requiredRoot = ["analyzeEffects", "analyzeProgramEffects", "verifyUneffectProject", "generateTemporalModel", "parseTemporalModelResult"];
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
    const temporal = root.generateTemporalModel({ fileName: "smoke.ts", source: "export function main() {}", runtime: "web" });
    if (root.parseTemporalModelResult(JSON.parse(JSON.stringify(temporal))).coverage.length !== 9)
      throw new Error("temporal model contract smoke failed");
    if (!ts.version.startsWith("6.")) throw new Error(\`package smoke resolved unsupported TypeScript \${ts.version}\`);
    console.log(JSON.stringify({ typescript: ts.version, rootExports: Object.keys(root).length }));
  `);
  execFileSync(process.execPath, [smoke], { cwd: consumer, stdio: "inherit" });

  const corsaConsumer = join(temporary, "corsa-consumer");
  execFileSync("npm", ["install", "--ignore-scripts", "--prefix", corsaConsumer, join(temporary, filename)], { stdio: "inherit" });
  writeFileSync(join(corsaConsumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: { strict: true, target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
    files: ["index.ts"],
  }));
  writeFileSync(join(corsaConsumer, "index.ts"), "export const answer = 42 as const;\n");
  const corsaSmoke = join(corsaConsumer, "corsa-smoke.mjs");
  writeFileSync(corsaSmoke, `
    import { openCorsaApiFrontend, parseCorsaApiFrontendDescriptor } from "@mizchi/uneffect/corsa/api";
    const file = new URL("./index.ts", import.meta.url).pathname;
    const frontend = await openCorsaApiFrontend({ configFile: new URL("./tsconfig.json", import.meta.url).pathname });
    try {
      const fact = frontend.queryPosition(file, 13);
      if (fact.symbol?.name !== "answer" || fact.type?.texts[0] !== "42") throw new Error("Corsa-only package smoke failed");
      const descriptor = parseCorsaApiFrontendDescriptor(JSON.parse(JSON.stringify(frontend.descriptor)));
      if (descriptor.schema !== "uneffect-corsa-api-frontend/v1") throw new Error("Corsa descriptor contract smoke failed");
      console.log(JSON.stringify({ corsa: frontend.compilerRevision, compiler: frontend.compilerExecutable }));
    } finally {
      frontend.close();
    }
  `);
  execFileSync(process.execPath, [corsaSmoke], { cwd: corsaConsumer, stdio: "inherit" });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

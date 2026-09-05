import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const temporary = mkdtempSync(join(tmpdir(), "uneffect-package-smoke-"));
const evidenceDirectory = resolve(".uneffect/package-evidence");
const sourceManifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

function parseNpmPackOutput(output) {
  const jsonStart = output.lastIndexOf("\n[");
  const candidate = output.slice(jsonStart < 0 ? 0 : jsonStart + 1).trim();
  const parsed = JSON.parse(candidate);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("npm pack did not return exactly one package record");
  }
  return parsed;
}

try {
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error(`package consumer requires Node 24 or newer; received ${process.versions.node}`);
  }
  const packed = parseNpmPackOutput(execFileSync("npm", ["pack", "--json", "--silent", "--pack-destination", temporary], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }));
  const packageRecord = packed[0];
  const filename = packageRecord?.filename;
  if (typeof filename !== "string" || !Array.isArray(packageRecord.files)) {
    throw new Error("npm pack did not report a tarball filename and contents");
  }
  const archive = join(temporary, filename);
  const archiveBytes = readFileSync(archive);
  const packageEvidence = {
    schema: "uneffect.package-evidence/v1",
    package: packageRecord.name,
    version: packageRecord.version,
    node: process.versions.node,
    filename,
    size: packageRecord.size,
    unpackedSize: packageRecord.unpackedSize,
    shasum: packageRecord.shasum,
    integrity: packageRecord.integrity,
    sha256: createHash("sha256").update(archiveBytes).digest("hex"),
    files: packageRecord.files.map(({ path, size, mode }) => ({ path, size, mode })),
    verification: { typecheck: "pending", runtime: "pending", optionalAbsence: "pending" },
  };
  mkdirSync(evidenceDirectory, { recursive: true });
  const writeEvidence = () => writeFileSync(
    join(evidenceDirectory, "npm-pack.json"), `${JSON.stringify(packageEvidence, null, 2)}\n`, "utf8",
  );
  writeEvidence();

  const packedPaths = new Set(packageEvidence.files.map(({ path }) => path));
  for (const path of [
    "package.json",
    "dist/src/public.js",
    "dist/src/public.d.ts",
    "dist/src/corsa-public.js",
    "dist/src/corsa-api-frontend.js",
    "dist/src/spec.js",
    "schemas/uneffect-temporal-model-v1.schema.json",
    "schemas/uneffect-corsa-api-frontend-v1.schema.json",
  ]) if (!packedPaths.has(path)) throw new Error(`packed artifact is missing ${path}`);

  const consumer = join(temporary, "consumer");
  const typescript6Package = dirname(createRequire(import.meta.url).resolve("@typescript/typescript6/package.json"));
  execFileSync("npm", [
    "install", "--ignore-scripts", "--no-package-lock", "--prefix", consumer,
    archive, typescript6Package,
    ...["corsa-oxlint", "@oxlint/plugins", "oxlint"].map((name) => `${name}@${sourceManifest.devDependencies[name]}`),
  ], { stdio: "inherit" });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const typecheckConfig = join(consumer, "tsconfig.json");
  writeFileSync(typecheckConfig, JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: "ES2024",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      resolveJsonModule: true,
    },
    files: ["index.ts", "query.ts"],
  }));
  writeFileSync(join(consumer, "index.ts"), `
    import * as root from "@mizchi/uneffect";
    import { checkCorsaProject } from "@mizchi/uneffect/corsa";
    import { corsaApiCapabilities, corsaApiLimitations, parseCorsaApiFrontendDescriptor } from "@mizchi/uneffect/corsa/api";
    import { defineTemporal } from "@mizchi/uneffect/spec";
    import temporalSchema from "@mizchi/uneffect/schemas/uneffect-temporal-model-v1.schema.json" with { type: "json" };
    import corsaSchema from "@mizchi/uneffect/schemas/uneffect-corsa-api-frontend-v1.schema.json" with { type: "json" };

    const model = root.generateTemporalModel({ fileName: "typed.ts", source: "export function main() {}", runtime: "web" });
    root.parseTemporalModelResult(model);
    void checkCorsaProject;
    void parseCorsaApiFrontendDescriptor;
    void corsaApiCapabilities;
    void corsaApiLimitations;
    void defineTemporal;
    void temporalSchema;
    void corsaSchema;
  `);
  writeFileSync(join(consumer, "query.ts"), "export const answer = 42 as const;\n");
  const typescriptCompiler = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "tsc6.cmd" : "tsc6");
  execFileSync(typescriptCompiler, ["-p", typecheckConfig], { cwd: consumer, stdio: "inherit" });
  packageEvidence.verification.typecheck = "passed";
  writeEvidence();

  const smoke = join(consumer, "smoke.mjs");
  writeFileSync(smoke, `
    import * as root from "@mizchi/uneffect";
    import * as experimental from "@mizchi/uneffect/experimental";
    import { checkCorsaProject } from "@mizchi/uneffect/corsa";
    import {
      corsaApiCapabilities, corsaApiLimitations, openCorsaApiFrontend,
      parseCorsaApiFrontendDescriptor,
    } from "@mizchi/uneffect/corsa/api";
    import * as spec from "@mizchi/uneffect/spec";
    import temporalSchema from "@mizchi/uneffect/schemas/uneffect-temporal-model-v1.schema.json" with { type: "json" };
    import corsaSchema from "@mizchi/uneffect/schemas/uneffect-corsa-api-frontend-v1.schema.json" with { type: "json" };
    import ts from "@typescript/typescript6";

    const requiredRoot = ["analyzeEffects", "analyzeProgramEffects", "verifyUneffectProject", "generateTemporalModel", "parseTemporalModelResult"];
    for (const name of requiredRoot) if (typeof root[name] !== "function") throw new Error(\`missing public root API: \${name}\`);
    const lowLevel = [
      "collectSyntaxFacts", "analyzeTypeScriptControlFlow", "analyzeAsyncPatterns",
      "analyzePromiseChains", "generatePromiseChainsQuint", "generateResourceSafetyQuint",
      "executeZ3", "logicToSmt", "solveBasicBlockFixedPoint",
    ];
    for (const name of lowLevel) if (name in root) throw new Error(\`experimental API leaked from package root: \${name}\`);
    for (const name of lowLevel) if (typeof experimental[name] !== "function") throw new Error(\`missing experimental API: \${name}\`);
    if (typeof checkCorsaProject !== "function") throw new Error("missing Corsa check facade");
    if (typeof spec.defineTemporal !== "function") throw new Error("missing specification API");
    if (temporalSchema.properties.schema.const !== "uneffect-temporal-model/v1") throw new Error("temporal schema import failed");
    if (corsaSchema.properties.schema.const !== "uneffect-corsa-api-frontend/v1") throw new Error("Corsa schema import failed");

    const parsedEffects = root.parseEffectSet("Console");
    const effectDiagnostics = root.analyzeEffects("smoke.ts", "/* uneffect:effect Console */\\nexport function run() { console.log(1) }");
    if (parsedEffects.length !== 1 || effectDiagnostics.some((diagnostic) => diagnostic.severity === "error"))
      throw new Error("public Effect tracking smoke failed");
    const temporal = root.generateTemporalModel({ fileName: "smoke.ts", source: "export function main() {}", runtime: "web" });
    if (root.parseTemporalModelResult(JSON.parse(JSON.stringify(temporal))).coverage.length !== 9)
      throw new Error("temporal model contract smoke failed");
    for (const malformed of [{ ...temporal, unknownField: true }, { ...temporal, schema: "uneffect-temporal-model/v2" }]) {
      let rejected = false;
      try { root.parseTemporalModelResult(malformed); } catch { rejected = true; }
      if (!rejected) throw new Error("temporal model parser accepted a malformed installed-package value");
    }
    if (!ts.version.startsWith("6.")) throw new Error(\`package smoke resolved unsupported TypeScript \${ts.version}\`);

    const queryFile = new URL("./query.ts", import.meta.url).pathname;
    const frontend = await openCorsaApiFrontend({ configFile: new URL("./tsconfig.json", import.meta.url).pathname });
    try {
      const fact = frontend.queryPosition(queryFile, 13);
      if (fact.symbol?.name !== "answer" || fact.type?.texts[0] !== "42") throw new Error("Corsa package query failed");
      const descriptor = parseCorsaApiFrontendDescriptor(JSON.parse(JSON.stringify(frontend.descriptor)));
      if (JSON.stringify(descriptor.capabilities) !== JSON.stringify(corsaApiCapabilities)) throw new Error("Corsa capabilities drifted");
      if (JSON.stringify(descriptor.limitations) !== JSON.stringify(corsaApiLimitations)) throw new Error("Corsa limitations drifted");
      for (const malformed of [{ ...descriptor, unknownField: true }, { ...descriptor, schema: "uneffect-corsa-api-frontend/v2" }]) {
        let rejected = false;
        try { parseCorsaApiFrontendDescriptor(malformed); } catch { rejected = true; }
        if (!rejected) throw new Error("Corsa descriptor parser accepted a malformed installed-package value");
      }
    } finally {
      frontend.close();
    }
    console.log(JSON.stringify({ node: process.versions.node, typescript: ts.version, rootExports: Object.keys(root).length }));
  `);
  execFileSync(process.execPath, [smoke], { cwd: consumer, stdio: "inherit" });
  packageEvidence.verification.runtime = "passed";
  writeEvidence();

  const absentConsumer = join(temporary, "absent-optional-consumer");
  execFileSync("npm", [
    "install", "--ignore-scripts", "--omit=optional", "--legacy-peer-deps", "--no-package-lock",
    "--prefix", absentConsumer, archive,
  ], { stdio: "inherit" });
  const absentSmoke = join(absentConsumer, "absence-smoke.mjs");
  writeFileSync(absentSmoke, `
    import { openCorsaApiFrontend, resolveCorsaExecutable } from "@mizchi/uneffect/corsa/api";

    let compilerDiagnostic = false;
    try { resolveCorsaExecutable({ cwd: process.cwd() }); }
    catch (error) { compilerDiagnostic = String(error).includes("No Corsa compiler was supplied"); }
    if (!compilerDiagnostic) throw new Error("missing optional compiler did not produce the documented diagnostic");

    let bindingDiagnostic = false;
    try { await openCorsaApiFrontend({ configFile: "missing-tsconfig.json", corsaExecutable: process.execPath }); }
    catch (error) { bindingDiagnostic = String(error).includes("Corsa API binding @corsa-bind/napi is unavailable"); }
    if (!bindingDiagnostic) throw new Error("missing optional Corsa binding did not produce the documented diagnostic");
  `);
  execFileSync(process.execPath, [absentSmoke], { cwd: absentConsumer, stdio: "inherit" });
  packageEvidence.verification.optionalAbsence = "passed";
  writeEvidence();

  process.stdout.write(`${JSON.stringify({
    package: packageEvidence.package,
    version: packageEvidence.version,
    sha256: packageEvidence.sha256,
    files: packageEvidence.files.length,
    evidence: join(evidenceDirectory, "npm-pack.json"),
  })}\n`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

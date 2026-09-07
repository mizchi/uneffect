import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
    "dist/src/api/public.js",
    "dist/src/cfg/index.js",
    "dist/src/cfg/index.d.ts",
    "dist/src/graph-analysis/workflow-api.js",
    "dist/src/graph-analysis/workflow-api.d.ts",
    "dist/src/graph-analysis/impact-api.js",
    "dist/src/graph-analysis/impact-api.d.ts",
    "dist/src/modules/corsa-module-order.js",
    "dist/src/modules/corsa-module-order.d.ts",
    "dist/src/modules/module-order-api.js",
    "dist/src/modules/module-order-api.d.ts",
    "dist/src/modules/contracts.d.ts",
    "dist/src/api/public.d.ts",
    "dist/src/api/corsa-public.js",
    "dist/src/frontends/corsa/corsa-api-frontend.js",
    "dist/src/api/corsa-experimental.js",
    "dist/src/spec/index.js",
    "schemas/uneffect-temporal-model-v1.schema.json",
    "schemas/uneffect-corsa-api-frontend-v1.schema.json",
    "schemas/uneffect-module-order-v2.schema.json",
  ]) if (!packedPaths.has(path)) throw new Error(`packed artifact is missing ${path}`);

  const consumer = join(temporary, "consumer");
  const typescript6Package = dirname(createRequire(import.meta.url).resolve("@typescript/typescript6/package.json"));
  execFileSync("npm", [
    "install", "--ignore-scripts", "--no-package-lock", "--prefix", consumer,
    archive, typescript6Package,
    `@types/node@${sourceManifest.devDependencies["@types/node"]}`,
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
    import { solveBasicBlockFixedPoint, type BasicBlockFixedPointOptions } from "@mizchi/uneffect/cfg";
    import { verifyWorkflow, parseWorkflow, type Workflow } from "@mizchi/uneffect/workflow";
    import { analyzeImpact, parseDependencyGraph } from "@mizchi/uneffect/impact";
    import {
      analyzeModuleInitializationOrder, analyzeModuleInitializationOrderV2,
      type ModuleInitializationOrder, type ModuleInitializationOrderV2,
      type ModuleInitializationV2Options,
    } from "@mizchi/uneffect/module-order";
    import { analyzeCorsaModuleInitializationOrderV2, type CorsaModuleOrderV2Options } from "@mizchi/uneffect/experimental/module-order/corsa";
    import ts from "@typescript/typescript6";
    import { lintPrerequisites, initializationRule, type RuleCfg } from "@mizchi/uneffect/experimental/lint";
    import { lowerCorsaRuleCfg, type CorsaRuleOptions } from "@mizchi/uneffect/experimental/lint/corsa";
    import { parseSpec as parseNativeSpec, generateQuint as emitNativeQuint, type ParsedSpec, prepareCorsaContractDslLinks, type PrepareCorsaContractDslOptions, type PreparedContractDslLinks } from "@mizchi/uneffect/experimental/spec";
    const contractLinker: (options: PrepareCorsaContractDslOptions) => Promise<PreparedContractDslLinks> = prepareCorsaContractDslLinks;
    void contractLinker;
    import { resolveCorsaRefinementDslLink, type ResolveCorsaRefinementDslOptions, type RefinementBindingManifest } from "@mizchi/uneffect/experimental/spec";
    const refinementLinker: (options: ResolveCorsaRefinementDslOptions) => Promise<RefinementBindingManifest> = resolveCorsaRefinementDslLink;
    void refinementLinker;
    import { generateUneffectPropertyTests, type GenerateUneffectPropertyTestsOptions, type GenerateUneffectPropertyTestsResult } from "@mizchi/uneffect/experimental/spec";
    const propertyGenerator: (options: GenerateUneffectPropertyTestsOptions) => GenerateUneffectPropertyTestsResult = generateUneffectPropertyTests;
    void propertyGenerator;
    import { instrumentRuntimeAssertions, type InstrumentResult } from "@mizchi/uneffect/experimental/instrument";
    import { openCorsaCallableFrontend, type CorsaCallableFrontend, type CorsaCallableSignature } from "@mizchi/uneffect/experimental/corsa/callables";
    const callableFactory: (options: { configFile: string }) => Promise<CorsaCallableFrontend> = openCorsaCallableFrontend;
    const callableSignature: CorsaCallableSignature | null = null;
    void callableFactory; void callableSignature;
    const instrumented: InstrumentResult = instrumentRuntimeAssertions("input.ts", "export function empty() {}");
    void instrumented;
    import { lowerTypeScriptRuleCfg } from "@mizchi/uneffect/experimental";
    import * as root from "@mizchi/uneffect";
    import { checkCorsaProject } from "@mizchi/uneffect/corsa";
    import { corsaApiCapabilities, corsaApiLimitations, parseCorsaApiFrontendDescriptor } from "@mizchi/uneffect/corsa/api";
    import { corsaCheckerExporterPlugin } from "@mizchi/uneffect/experimental/corsa";
    import { defineTemporal } from "@mizchi/uneffect/spec";
    import temporalSchema from "@mizchi/uneffect/schemas/uneffect-temporal-model-v1.schema.json" with { type: "json" };
    import corsaSchema from "@mizchi/uneffect/schemas/uneffect-corsa-api-frontend-v1.schema.json" with { type: "json" };
    import moduleOrderV2Schema from "@mizchi/uneffect/schemas/uneffect-module-order-v2.schema.json" with { type: "json" };

    const nativeOptions: CorsaModuleOrderV2Options = { entryFile: "entry.mts", proofBudget: { moduleControlFlowIterations: 32 } };
    const nativeAnalyzer: (options: CorsaModuleOrderV2Options) => Promise<ModuleInitializationOrderV2> = analyzeCorsaModuleInitializationOrderV2;
    void nativeOptions; void nativeAnalyzer;
    const cfg: BasicBlockFixedPointOptions<number, "ready"> = {
      entry: "entry", initial: 1, budget: { name: "consumer", limit: 2 },
      lattice: { bottom: () => 0, equivalent: (a, b) => a === b, join: (a, b) => ({ status: "joined", value: Math.max(a, b) }) },
      blocks: [{ id: "entry", edges: [], transfer: () => [] }],
    };
    solveBasicBlockFixedPoint(cfg);
    const workflow: Workflow = { entry: "step", steps: [{ id: "step", next: [] }] };
    const workflowResult = verifyWorkflow(parseWorkflow(workflow));
    if (workflowResult.status !== "unknown") for (const diagnostic of workflowResult.diagnostics) {
      if (diagnostic.kind === "missing-prerequisite") void diagnostic.missing;
      else void diagnostic.waitingFor;
    }
    analyzeImpact(parseDependencyGraph([{ id: "input", dependencies: [] }]), ["input"]);
    const moduleProgram = ts.createProgram(["query.ts"], { noEmit: true });
    const moduleOptions: ModuleInitializationV2Options = { proofBudget: { moduleControlFlowIterations: 32 } };
    const moduleV1: ModuleInitializationOrder = analyzeModuleInitializationOrder(moduleProgram, "query.ts");
    const moduleV2: ModuleInitializationOrderV2 = analyzeModuleInitializationOrderV2(moduleProgram, "query.ts", moduleOptions);
    void moduleV1; void moduleV2;
    const ruleCfg: RuleCfg = { entry: "entry", blocks: [{ id: "entry", events: [], successors: [] }] };
    lintPrerequisites(ruleCfg, initializationRule);
    lowerTypeScriptRuleCfg(moduleProgram, { fileName: "query.ts", functionName: "run", bindings: [] });
    // @ts-expect-error the public proof budget is numeric
    analyzeModuleInitializationOrderV2(moduleProgram, "query.ts", { proofBudget: { moduleControlFlowIterations: "32" } });
    // @ts-expect-error unknown task kinds must not enter the typed contract
    const invalidStep: Workflow["steps"][number] = { id: "bad", kind: "frok", next: [] };
    void invalidStep;
    const model = root.generateTemporalModel({ fileName: "typed.ts", source: "export function main() {}", runtime: "web" });
    root.parseTemporalModelResult(model);
    void checkCorsaProject;
    void parseCorsaApiFrontendDescriptor;
    void corsaApiCapabilities;
    void corsaApiLimitations;
    void corsaCheckerExporterPlugin;
    void defineTemporal;
    void temporalSchema;
    void corsaSchema;
    void moduleOrderV2Schema;
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
    import { corsaCheckerExporterPlugin } from "@mizchi/uneffect/experimental/corsa";
    import {
      corsaApiCapabilities, corsaApiLimitations, openCorsaApiFrontend,
      parseCorsaApiFrontendDescriptor,
    } from "@mizchi/uneffect/corsa/api";
    import * as spec from "@mizchi/uneffect/spec";
    import temporalSchema from "@mizchi/uneffect/schemas/uneffect-temporal-model-v1.schema.json" with { type: "json" };
    import corsaSchema from "@mizchi/uneffect/schemas/uneffect-corsa-api-frontend-v1.schema.json" with { type: "json" };
    import moduleOrderV2Schema from "@mizchi/uneffect/schemas/uneffect-module-order-v2.schema.json" with { type: "json" };
    import ts from "@typescript/typescript6";

    const requiredRoot = ["analyzeEffects", "analyzeProgramEffects", "verifyUneffectProject", "generateTemporalModel", "parseTemporalModelResult"];
    for (const name of requiredRoot) if (typeof root[name] !== "function") throw new Error(\`missing public root API: \${name}\`);
    if (!Array.isArray(root.uneffectDialects) || !root.uneffectDialects.includes("unified"))
      throw new Error("missing public annotation dialect inventory");
    const lowLevel = [
      "collectSyntaxFacts", "analyzeTypeScriptControlFlow", "analyzeAsyncPatterns",
      "analyzePromiseChains", "generatePromiseChainsQuint", "generateResourceSafetyQuint",
      "executeZ3", "logicToSmt", "solveBasicBlockFixedPoint",
      "analyzeModuleInitializationOrderV2",
      "lintPrerequisites", "lowerTypeScriptRuleCfg",
    ];
    for (const name of lowLevel) if (name in root) throw new Error(\`experimental API leaked from package root: \${name}\`);
    for (const name of lowLevel) if (typeof experimental[name] !== "function") throw new Error(\`missing experimental API: \${name}\`);
    if (typeof checkCorsaProject !== "function") throw new Error("missing Corsa check facade");
    if (typeof corsaCheckerExporterPlugin !== "object") throw new Error("missing experimental Corsa exporter plugin");
    if (typeof spec.defineTemporal !== "function") throw new Error("missing specification API");
    if (spec.uneffectSpecVersion !== "uneffect-spec/v1") throw new Error("specification v1 identity drifted");
    if (temporalSchema.properties.schema.const !== "uneffect-temporal-model/v1") throw new Error("temporal schema import failed");
    if (corsaSchema.properties.schema.const !== "uneffect-corsa-api-frontend/v1") throw new Error("Corsa schema import failed");
    if (moduleOrderV2Schema.properties.schema.const !== "uneffect-module-order/v2") throw new Error("module-order v2 schema import failed");

    const previousPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const parity = await root.compareUneffectFrontends({
        files: { "portable.ts": "/* uneffect:effect Console */ export function emit() { console.log(1) } export function main() { emit() }" },
        corsaTimeoutMs: 1,
      });
      if (!parity.equivalent || !parity.corsaIr.functions.some((f) => f.name === "main" && f.effects.includes("Console")))
        throw new Error("installed frontend comparison failed without Cargo: " + JSON.stringify(parity.schemaDrift));
      const drift = await root.compareUneffectFrontends({ files: { "portable.ts": "export function main() {}" }, corsaSchemaVersion: 9 });
      if (drift.equivalent || drift.corsaIr !== null) throw new Error("installed comparison accepted an unsupported fact schema");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

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

  // Exercise the published CLI entry, including lazy loading of supported v2.
  const moduleEntry = join(consumer, "module-conditional-tla.mts");
  const moduleSource = readFileSync(resolve("examples/dogfood/module-conditional-tla.ts"), "utf8");
  writeFileSync(moduleEntry, moduleSource);
  const cliEntry = join(consumer, "node_modules", "@mizchi", "uneffect", sourceManifest.bin.uneffect);
  const moduleConfig = join(consumer, "module-tsconfig.json");
  writeFileSync(moduleConfig, JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", types: ["node"], noEmit: true }, files: [moduleEntry] }));
  const inspectModuleOrder = (args, expectedStatus, schema, evidence) => {
    const result = spawnSync(process.execPath, [cliEntry, "module-order", moduleEntry, "--project", moduleConfig, ...args], {
      cwd: consumer, encoding: "utf8", timeout: 60_000,
    });
    if (result.error || result.status !== expectedStatus) {
      throw new Error(`packed module-order CLI failed: ${result.error ?? result.stderr}`);
    }
    const artifact = JSON.parse(result.stdout);
    if (artifact.schema !== schema || artifact.evidence !== evidence) {
      throw new Error("packed module-order CLI schema or evidence drifted");
    }
    if (evidence === "unknown" && (!artifact.unknowns.some((item) => item.kind === "conditional-top-level-await")
      || !result.stderr.includes("conditional-top-level-await"))) {
      throw new Error("packed module-order CLI lost its conditional-await diagnostic");
    }
    return artifact;
  };
  inspectModuleOrder(["--require"], 1, "uneffect-module-order/v1", "unknown");
  const conditionalOrder = inspectModuleOrder(["--schema-version", "2", "--require"], 0, "uneffect-module-order/v2", "verified");
  const conditionalFlow = conditionalOrder.modules.find((item) => item.fileName === moduleEntry)?.controlFlow;
  if (conditionalFlow?.proof.status !== "converged"
    || JSON.stringify(conditionalFlow.proof.reachableBy[`${moduleEntry}#complete`]) !== '["branch-false","await-resume"]'
    || JSON.stringify(conditionalFlow.proof.reachableBy[`${moduleEntry}#reject:0`]) !== '["await-reject"]') {
    throw new Error("packed module-order CLI lost conditional completion or terminal rejection evidence");
  }
  const moduleApiProbe = join(consumer, "module-api.mjs");
  writeFileSync(moduleApiProbe, `
    import assert from "node:assert/strict";
    import ts from "@typescript/typescript6";
    import {
      analyzeModuleInitializationOrder, analyzeModuleInitializationOrderV2,
      DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET,
    } from "@mizchi/uneffect/module-order";
    import * as experimental from "@mizchi/uneffect/experimental";
    const entry = process.argv[2];
    const program = ts.createProgram([entry], {
      target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"], noEmit: true,
    });
    assert.equal(experimental.analyzeModuleInitializationOrder, analyzeModuleInitializationOrder);
    assert.equal(experimental.analyzeModuleInitializationOrderV2, analyzeModuleInitializationOrderV2);
    assert.equal(analyzeModuleInitializationOrder(program, entry).evidence, "unknown");
    const { compiler: legacyCompiler, ...legacyOrder } = analyzeModuleInitializationOrderV2(program, entry);
    const { compiler: nativeCompiler, ...nativeOrder } = ${JSON.stringify(conditionalOrder)};
    assert.deepEqual(legacyOrder, nativeOrder);
    assert.equal(legacyCompiler.typescriptVersion, ts.version);
    assert.match(nativeCompiler.typescriptVersion, /^7[.]/);
    const limited = analyzeModuleInitializationOrderV2(program, entry, { proofBudget: { moduleControlFlowIterations: 1 } });
    assert.equal(limited.evidence, "unknown");
    assert(limited.unknowns.some((item) => item.kind === "module-control-flow-proof"));
    // Missing entries must not skip validation just because there is no CFG candidate.
    assert.throws(() => analyzeModuleInitializationOrderV2(program, "missing.mts", {
      proofBudget: { moduleControlFlowIterations: 0 },
    }), RangeError);
    assert.throws(() => analyzeModuleInitializationOrderV2(program, entry, { proofBudget: null }), TypeError);
    assert.equal(Reflect.set(DEFAULT_MODULE_CONTROL_FLOW_PROOF_BUDGET, "moduleControlFlowIterations", 1), false);
  `);
  execFileSync(process.execPath, [moduleApiProbe, moduleEntry], { cwd: consumer, stdio: "inherit" });
  const mutableModuleSource = moduleSource.replace("const warmCache", "let warmCache");
  if (mutableModuleSource === moduleSource) throw new Error("packed module-order negative control did not mutate the selector");
  writeFileSync(moduleEntry, mutableModuleSource);
  inspectModuleOrder(["--schema-version", "2", "--require"], 1, "uneffect-module-order/v2", "unknown");

  const lintEntry = join(consumer, "cfg-lint.mts");
  writeFileSync(lintEntry, readFileSync(resolve("examples/dogfood/cfg-lint-initialization.ts"), "utf8"));
  const noTsHook = join(consumer, "no-typescript.mjs");
  writeFileSync(noTsHook, `
    import { registerHooks } from "node:module";
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === "typescript" || specifier.startsWith("typescript/") || specifier === "@typescript/typescript6" || specifier.startsWith("@typescript/typescript6/"))
        throw new Error("Unexpected JavaScript TypeScript compiler import: " + specifier);
      return next(specifier, context);
    } });
    const { lowerCorsaRuleCfg } = await import("@mizchi/uneffect/experimental/lint/corsa");
    if (typeof lowerCorsaRuleCfg !== "function") throw new Error("Missing Corsa linter entry");
    const { lintPrerequisites } = await import("@mizchi/uneffect/experimental/lint");
    if (typeof lintPrerequisites !== "function") throw new Error("Missing compiler-independent linter entry");
    const moduleOrder = await import("@mizchi/uneffect/experimental/module-order/corsa");
    if (typeof moduleOrder.analyzeCorsaModuleInitializationOrderV2 !== "function") throw new Error("Missing native module-order entry");
    const spec = await import("@mizchi/uneffect/experimental/spec");
    if (typeof spec.parseSpec !== "function" || typeof spec.lintSpecWithZ3 !== "function") throw new Error("Missing native specification entry");
    const instrument = await import("@mizchi/uneffect/experimental/instrument");
    const checked = instrument.instrumentRuntimeAssertions("input.ts", '/* uneffect:assert value: Nat */ export function check(value: number) { return value }');
    if (checked.diagnostics.length || !checked.code.includes("__uneffect_v.parse")) throw new Error("Missing compiler-independent runtime instrumentation");
  `);
  const instrumentEntry = join(consumer, "instrument.ts");
  writeFileSync(instrumentEntry, '/* uneffect:assert value: Nat */ export function check(value: number) { return value }');
  const instrumentResult = spawnSync(process.execPath, ["--import", noTsHook, cliEntry, "instrument", instrumentEntry], {
    cwd: consumer, encoding: "utf8", timeout: 30_000,
  });
  if (instrumentResult.status !== 0 || !instrumentResult.stdout.includes("__uneffect_v.parse")) {
    throw new Error(`compiler-independent instrument CLI failed: ${instrumentResult.stderr || instrumentResult.error || instrumentResult.status}`);
  }
  const callableEntry = join(consumer, "callable.ts"), callableConfig = join(consumer, "tsconfig.callable.json");
  const callableSource = 'export function choose(value: string): string; export function choose(value: number): number; export function choose(value: string | number) { return value; } export const selected = choose(42);';
  writeFileSync(callableEntry, callableSource);
  writeFileSync(callableConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] }, files: [callableEntry] }));
  const callableProbe = join(consumer, "callable-probe.mjs");
  writeFileSync(callableProbe, `
    import assert from "node:assert/strict";
    import { openCorsaCallableFrontend } from "@mizchi/uneffect/experimental/corsa/callables";
    const frontend = await openCorsaCallableFrontend({ configFile: ${JSON.stringify(callableConfig)} });
    try {
      const source = ${JSON.stringify(callableSource)}, file = ${JSON.stringify(callableEntry)};
      const start = source.indexOf("choose(42)");
      const signature = frontend.getResolvedSignature(file, { start, end: start + 10 }, source);
      assert.deepEqual(signature.returnType.texts, ["number"]);
      assert.deepEqual(signature.parameters[0].type.texts, ["number"]);
      assert.deepEqual(frontend.getSignaturesOfTypeAtPosition(file, start).map(item => item.returnType.texts[0]), ["string", "number"]);
    } finally { frontend.close(); }
  `);
  execFileSync(process.execPath, ["--import", noTsHook, callableProbe], { cwd: consumer, stdio: "inherit", timeout: 30_000 });
  for (const [functionName, status, verdict] of [
    ["ready", 0, "clean"], ["branchMissing", 1, "findings"], ["unsupportedCallback", 2, "unknown"],
  ]) {
    const result = spawnSync(process.execPath, ["--import", noTsHook, cliEntry, "cfg-lint", lintEntry, functionName], {
      cwd: consumer, encoding: "utf8", timeout: 60_000,
    });
    if (result.error || result.status !== status) throw new Error(`packed cfg-lint failed: ${result.error ?? result.stderr}`);
    const report = JSON.parse(result.stdout);
    if (report.status !== verdict || report.ruleId !== "initialization-before-use" || report.assumedOperations.length !== 2) {
      throw new Error("packed cfg-lint lost its verdict or operation assumptions");
    }
    if (verdict === "findings" && report.diagnostics[0]?.location.fileName !== lintEntry) throw new Error("packed cfg-lint lost source location");
    if (verdict === "unknown" && "diagnostics" in report) throw new Error("packed cfg-lint leaked partial diagnostics");
  }

  writeFileSync(moduleEntry, moduleSource);
  for (const [version, status, evidence] of [["1", 1, "unknown"], ["2", 0, "verified"]]) {
    const result = spawnSync(process.execPath, ["--import", noTsHook, cliEntry, "module-order", moduleEntry, "--project", moduleConfig, "--schema-version", version, "--require"], {
      cwd: consumer, encoding: "utf8", timeout: 60_000,
    });
    if (result.error || result.status !== status || JSON.parse(result.stdout).evidence !== evidence) {
      throw new Error(`packed native module-order failed: ${result.error ?? result.stderr}`);
    }
  }

  const specEntry = join(consumer, "spec-native.ts");
  const specFixture = JSON.parse(readFileSync(resolve("test/fixtures/oxc-spec-parity.json"), "utf8"));
  writeFileSync(specEntry, specFixture.composition.source + "\n/* uneffect:action advance: phase' = phase + 1 */\n/* uneffect:ensures result >= x */\nfunction identity(x: number) { return x; }\n");
  for (const backend of ["ir", "quint", "compose", "z3"]) {
    const result = spawnSync(process.execPath, ["--import", noTsHook, cliEntry, "spec", backend, specEntry, ...(backend === "compose" ? ["main"] : [])], { cwd: consumer, encoding: "utf8", timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(`packed native spec ${backend} failed: ${result.error ?? result.stderr}`);
    if (backend === "ir" && JSON.parse(result.stdout).temporal.states[0]?.name !== "phase") throw new Error("packed native spec lost state declarations");
    if (backend === "z3" && !result.stdout.includes("(check-sat)")) throw new Error("packed native spec lost SMT output");
    if (["quint", "compose"].includes(backend) && !result.stdout.includes("module spec_native")) throw new Error("packed native spec lost Quint output");
  }

  const dslFixture = JSON.parse(readFileSync(resolve("test/fixtures/oxc-dsl-parity.json"), "utf8"));
  const temporalDslFile = join(consumer, "model.uneffect.ts"), contractDslFile = join(consumer, "contract.uneffect.ts");
  writeFileSync(temporalDslFile, dslFixture.temporal[0].source);
  writeFileSync(contractDslFile, dslFixture.contract[0].source);
  const moreDslFixture = JSON.parse(readFileSync(resolve("test/fixtures/oxc-capability-refinement-parity.json"), "utf8"));
  const capabilityDslFile = join(consumer, "policy.uneffect.ts"), refinementDslFile = join(consumer, "counter.uneffect.ts");
  writeFileSync(capabilityDslFile, moreDslFixture.capability[0].source);
  writeFileSync(refinementDslFile, moreDslFixture.refinement[0].source);
  writeFileSync(join(consumer, "counter.ts"), 'type Runtime = {value: number; members: number[]}; export const create = (value: Runtime) => value, observe = create; export const increment = (value: Runtime) => { value.value++; }; export const nonnegative = (value: Runtime) => value.value >= 0;');
  const dslConfig = join(consumer, "dsl-tsconfig.json");
  writeFileSync(dslConfig, JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", types: [] }, files: [temporalDslFile, contractDslFile, capabilityDslFile, refinementDslFile] }));
  const dslProbe = join(consumer, "dsl-native.mjs");
  writeFileSync(dslProbe, `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    import { openCorsaApiFrontend } from "@mizchi/uneffect/corsa/api";
    import { parseTemporalDsl, parseContractDsl, prepareContractDslSources, resolveTemporalDslSourceLink, parseCapabilityDslWithSchemas, prepareCapabilityDslSources, parseRefinementDsl, resolveRefinementDslSourceLink, validateCorsaDslHelperIdentities } from "@mizchi/uneffect/experimental/spec";
    const temporal = readFileSync(${JSON.stringify(temporalDslFile)}, "utf8"), contract = readFileSync(${JSON.stringify(contractDslFile)}, "utf8");
    assert.deepEqual(JSON.parse(JSON.stringify(parseTemporalDsl("model.uneffect.ts", temporal))), ${JSON.stringify(dslFixture.temporal[0].parsed)});
    assert.deepEqual(parseContractDsl("contract.uneffect.ts", contract, "Increment"), ${JSON.stringify(dslFixture.contract[0].parsed)});
    assert.equal(prepareContractDslSources({ "src/contract.ts": '/* uneffect:contract_from "./contract.uneffect.ts#Increment" */', "src/contract.uneffect.ts": contract }).provenance["src/contract.ts"].length, 4);
    assert.equal(resolveTemporalDslSourceLink("src/model.ts", '/* uneffect:temporal_from "./model.uneffect.ts#default" */', { "src/model.uneffect.ts": temporal }).spec.states.length, 2);
    const capability = readFileSync(${JSON.stringify(capabilityDslFile)}, "utf8"), refinement = readFileSync(${JSON.stringify(refinementDslFile)}, "utf8");
    const plain = value => JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Map ? [...item] : item));
    assert.deepEqual(plain(parseCapabilityDslWithSchemas("policy.uneffect.ts", capability, "Load")), ${JSON.stringify(moreDslFixture.capability[0].parsed)});
    assert.equal(prepareCapabilityDslSources({ "src/run.ts": '/* uneffect:capability_from "./policy.uneffect.ts#Load" */', "src/policy.uneffect.ts": capability }).schemas.size, 1);
    assert.deepEqual(parseRefinementDsl("counter.uneffect.ts", refinement), ${JSON.stringify(moreDslFixture.refinement[0].parsed)});
    assert.deepEqual(resolveRefinementDslSourceLink("src/counter.ts", '/* uneffect:refinement_from "./counter.uneffect.ts#default" */', { "src/counter.uneffect.ts": refinement }), ${JSON.stringify(moreDslFixture.refinement[0].link)});
    const frontend = await openCorsaApiFrontend({ configFile: ${JSON.stringify(dslConfig)} });
    try {
      validateCorsaDslHelperIdentities(frontend, ${JSON.stringify(temporalDslFile)}, temporal, "temporal");
      validateCorsaDslHelperIdentities(frontend, ${JSON.stringify(contractDslFile)}, contract, "contract");
      validateCorsaDslHelperIdentities(frontend, ${JSON.stringify(capabilityDslFile)}, capability, "capability");
      validateCorsaDslHelperIdentities(frontend, ${JSON.stringify(refinementDslFile)}, refinement, "refinement");
    } finally { frontend.close(); }
  `);
  execFileSync(process.execPath, ["--import", noTsHook, dslProbe], { cwd: consumer, stdio: "inherit", timeout: 30_000 });

  const linkedContractFiles = {
    [join(consumer, "linked-contract.ts")]: '/* uneffect:contract_from "./contract.uneffect.ts#Increment" */\nexport function increment(value: number) { return value + 1; }',
    [contractDslFile]: readFileSync(contractDslFile, "utf8"),
    [join(consumer, "linked-nat.ts")]: 'import type { Nat } from "@mizchi/uneffect";\n/* uneffect:contract_from "./nat.uneffect.ts#Identity" */\nexport function identity(value: Nat): Nat { return value; }',
    [join(consumer, "nat.uneffect.ts")]: 'import { defineContract, nat } from "@mizchi/uneffect/spec"; export const Identity = defineContract({ parameters: { value: nat() }, returns: nat(), ensures: ({value, result}) => result === value });',
  };
  for (const [file, source] of Object.entries(linkedContractFiles)) writeFileSync(file, source);
  const linkedContractConfig = join(consumer, "contract-tsconfig.json");
  writeFileSync(linkedContractConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: ["node"], skipLibCheck: true }, files: Object.keys(linkedContractFiles) }));
  const linkedContractProbe = join(consumer, "contract-native.mjs");
  writeFileSync(linkedContractProbe, `
    import assert from "node:assert/strict";
    import { prepareCorsaContractDslLinks } from "@mizchi/uneffect/experimental/spec";
    const prepared = await prepareCorsaContractDslLinks(${JSON.stringify({ configFile: linkedContractConfig, files: linkedContractFiles })});
    assert.equal(prepared.provenance[${JSON.stringify(join(consumer, "linked-contract.ts"))}].length, 4);
    assert.equal(prepared.provenance[${JSON.stringify(join(consumer, "linked-nat.ts"))}].length, 1);
    assert.match(prepared.files[${JSON.stringify(join(consumer, "linked-nat.ts"))}], /assert value: Nat/);
  `);
  execFileSync(process.execPath, ["--import", noTsHook, linkedContractProbe], { cwd: consumer, stdio: "inherit", timeout: 30_000 });

  const flowFile = join(consumer, "native-flow.ts"), flowConfig = join(consumer, "flow-tsconfig.json");
  const flowSource = 'declare function stop(): never; declare const enabled: true; export function checked() { if (enabled) stop(); } export function optional(stop?: () => never) { stop?.(); }';
  writeFileSync(flowFile, flowSource);
  writeFileSync(flowConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] }, files: [flowFile] }));
  const flowProbe = join(consumer, "native-flow.mjs");
  writeFileSync(flowProbe, `
    import assert from "node:assert/strict";
    import { analyzeCorsaContractControlFlow } from "@mizchi/uneffect/experimental/spec";
    const flows = await analyzeCorsaContractControlFlow(${JSON.stringify({ configFile: flowConfig, files: { [flowFile]: flowSource } })});
    assert.deepEqual(flows.map(flow => [flow.name, flow.structural.mayFallThrough, flow.mayFallThrough, flow.evidence]), [
      ["checked", true, false, "structural-with-corsa-types"], ["optional", true, true, "structural-with-corsa-types"],
    ]);
  `);
  execFileSync(process.execPath, ["--import", noTsHook, flowProbe], { cwd: consumer, stdio: "inherit", timeout: 30_000 });

  const linkedRefinementEntry = join(consumer, "counter.ts");
  const linkedRefinementFiles = {
    [linkedRefinementEntry]: '/* uneffect:refinement_from "./counter.uneffect.ts#default" */\n' + readFileSync(linkedRefinementEntry, "utf8"),
    [refinementDslFile]: readFileSync(refinementDslFile, "utf8"),
  };
  writeFileSync(linkedRefinementEntry, linkedRefinementFiles[linkedRefinementEntry]);
  const linkedRefinementConfig = join(consumer, "refinement-tsconfig.json");
  writeFileSync(linkedRefinementConfig, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: ["node"], skipLibCheck: true }, files: Object.keys(linkedRefinementFiles) }));
  const linkedRefinementProbe = join(consumer, "refinement-native.mjs");
  writeFileSync(linkedRefinementProbe, `
    import assert from "node:assert/strict";
    import { resolveCorsaRefinementDslLink } from "@mizchi/uneffect/experimental/spec";
    const manifest = await resolveCorsaRefinementDslLink(${JSON.stringify({ configFile: linkedRefinementConfig, implementationFile: linkedRefinementEntry, files: linkedRefinementFiles })});
    assert.deepEqual(manifest, ${JSON.stringify({ ...moreDslFixture.refinement[0].link, fileName: linkedRefinementEntry })});
  `);
  execFileSync(process.execPath, ["--import", noTsHook, linkedRefinementProbe], { cwd: consumer, stdio: "inherit", timeout: 30_000 });

  const propertyFixtures = JSON.parse(readFileSync(resolve("test/fixtures/oxc-property-parity.json"), "utf8"));
  const propertyProbe = join(consumer, "property-native.mjs");
  writeFileSync(propertyProbe, `
    import assert from "node:assert/strict";
    import { generateUneffectPropertyTests, checkUneffectProperty, analyzeOxcContractControlFlow } from "@mizchi/uneffect/experimental/spec";
    for (const fixture of ${JSON.stringify(propertyFixtures)}) assert.deepEqual(generateUneffectPropertyTests(fixture.options), fixture.expected);
    const result = await checkUneffectProperty({ functionName: "identity", domains: ["Nat"], property: value => value === value });
    assert.equal(result.status, "passed");
    const flows = analyzeOxcContractControlFlow("flow.ts", "export function f() { try { return 1; } finally {} } function g() { stop(); }");
    assert.deepEqual(flows.map(flow => [flow.name, flow.exits, flow.mayFallThrough, flow.evidence]), [
      ["f", ["return"], false, "structural"], ["g", ["normal"], true, "structural"],
    ]);
  `);
  execFileSync(process.execPath, ["--import", noTsHook, propertyProbe], { cwd: consumer, stdio: "inherit", timeout: 30_000 });

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
  // Prove the CFG entry can load and execute with compiler peers absent and
  // every dependency outside its installed directory rejected by the loader.
  const cfgSmoke = join(absentConsumer, "cfg-smoke.mjs");
  writeFileSync(cfgSmoke, `
    import { registerHooks } from "node:module";
    const entry = import.meta.resolve("@mizchi/uneffect/cfg");
    const directory = new URL("./", entry).href;
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!result.url.startsWith(directory)) throw new Error("CFG imported an external dependency: " + result.url);
      return result;
    } });
    const { solveBasicBlockFixedPoint } = await import(entry);
    const options = {
      entry: "start", initial: 1, budget: { name: "installed-cfg", limit: 8 },
      lattice: { bottom: () => 0, equivalent: (a, b) => a === b, join: (a, b) => ({ status: "joined", value: Math.max(a, b) }) },
      blocks: [
        { id: "start", edges: [{ to: "end", completion: "ready" }], transfer: (value) => [{ to: "end", value }] },
        { id: "end", edges: [], transfer: () => [] },
      ],
    };
    const result = solveBasicBlockFixedPoint(options);
    if (result.status !== "converged" || result.states.get("end") !== 1) throw new Error("installed CFG did not converge");
    const exhausted = solveBasicBlockFixedPoint({ ...options, budget: { name: "short", limit: 1 } });
    if (exhausted.status !== "unknown" || exhausted.reason !== "proof-budget-exhausted") throw new Error("CFG lost budget failure");
  `);
  execFileSync(process.execPath, [cfgSmoke], { cwd: absentConsumer, stdio: "inherit" });

  const lintSmoke = join(absentConsumer, "lint-smoke.mjs");
  writeFileSync(lintSmoke, `
    import { defineTemporal, bool, defineContract, nat, defineCapability, Console, globalRuntime } from "@mizchi/uneffect/spec";
    const definition = { state: { ready: bool() }, init: { ready: false }, actions: {} };
    if (defineTemporal(definition) !== definition || nat().kind !== "nat" || globalRuntime().identity !== "globalThis") throw new Error("spec authoring requires a compiler");
    if (typeof defineContract !== "function" || defineCapability({ effects: [Console()] }).effects.length !== 1) throw new Error("spec authoring missing exports");
    import { lintPrerequisites, initializationRule } from "@mizchi/uneffect/experimental/lint";
    import { lowerCorsaRuleCfg } from "@mizchi/uneffect/experimental/lint/corsa";
    const result = lintPrerequisites({ entry: "entry", blocks: [{ id: "entry", successors: [], events: [
      { operation: "use", subject: "x", location: { fileName: "input.ts", start: 0, end: 1 } },
    ] }] }, initializationRule);
    if (result.status !== "findings") throw new Error("compiler-independent lint failed");
    const missing = await lowerCorsaRuleCfg({ fileName: "input.mts", functionName: "run", bindings: [] });
    if (missing.status !== "unknown" || missing.reason !== "frontend-error") throw new Error("missing compiler did not fail closed");
  `);
  writeFileSync(join(absentConsumer, "input.mts"), "export function run() {};");
  execFileSync(process.execPath, [lintSmoke], { cwd: absentConsumer, stdio: "inherit" });

  const graphSmoke = join(absentConsumer, "graph-smoke.mjs");
  writeFileSync(graphSmoke, `
    import { registerHooks } from "node:module";
    const workflowEntry = import.meta.resolve("@mizchi/uneffect/workflow");
    const impactEntry = import.meta.resolve("@mizchi/uneffect/impact");
    const allowed = [new URL("./", workflowEntry).href, new URL("../cfg/", workflowEntry).href];
    registerHooks({ resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (!allowed.some(directory => result.url.startsWith(directory))) throw new Error("graph API imported external code: " + result.url);
      return result;
    } });
    const { verifyWorkflow, parseWorkflow } = await import(workflowEntry);
    const { analyzeImpact, parseDependencyGraph } = await import(impactEntry);
    const model = parseWorkflow({ entry: "fork", steps: [
      { id: "fork", kind: "fork", join: "join", next: ["build", "review"] },
      { id: "build", provides: ["artifact"], next: ["join"] },
      { id: "review", provides: ["approved"], next: ["join"] },
      { id: "join", kind: "join", fork: "fork", requires: ["artifact", "approved"], next: [] },
    ] });
    if (verifyWorkflow(model).status !== "valid") throw new Error("installed parallel workflow failed");
    const broken = { ...model, steps: model.steps.map(step => step.id === "review" ? { ...step, next: [] } : step) };
    const blocked = verifyWorkflow(broken);
    if (blocked.status !== "invalid" || !blocked.diagnostics.some(d => d.kind === "blocked-join" && d.waitingFor.includes("review")))
      throw new Error("installed workflow lost missing arrival");
    const typo = verifyWorkflow({ entry: "a", steps: [{ id: "a", require: ["approved"], next: [] }] });
    if (typo.status !== "unknown" || "diagnostics" in typo) throw new Error("unknown workflow fields were accepted");
    for (const options of [{ maxConfigurations: 1 }, { maxTransitions: 1 }, { budget: 1 }]) {
      const result = verifyWorkflow(model, options);
      if (result.status !== "unknown" || "guaranteed" in result) throw new Error("partial workflow verdict leaked");
    }
    const graph = parseDependencyGraph([{ id: "input", dependencies: [] }, { id: "output", dependencies: ["input"] }]);
    const impact = analyzeImpact(graph, ["input"]);
    if (impact.status !== "analyzed" || impact.affected.length !== 2 || impact.affected[1].causes[0] !== "input")
      throw new Error("installed impact analysis failed");
  `);
  execFileSync(process.execPath, [graphSmoke], { cwd: absentConsumer, stdio: "inherit" });

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

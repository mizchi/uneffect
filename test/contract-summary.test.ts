import { describe, expect, it } from "vitest";
import ts from "typescript";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindContractSummaryBundleToProgram, boundContractSummaryEffectContracts, boundContractSummaryResourceContracts, createContractSummaryBundle, loadContractSummaryBundle, validateContractSummaryBundle } from "../src/contract-summary.js";
import { verifyContractObligations } from "../src/contracts.js";
import { analyzeHostNeutralTransitions } from "../src/host-neutral-transitions.js";
import { builtinContractRegistry, extendBuiltinContractRegistry } from "../src/builtin-contracts.js";
import { analyzeResourceLifecyclesInSource } from "../src/resource-callable-typescript.js";

function programFor(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreate) => requested === fileName
    ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
    : original(requested, languageVersion, onError, shouldCreate);
  host.readFile = (requested) => requested === fileName ? source : ts.sys.readFile(requested);
  host.fileExists = (requested) => requested === fileName || ts.sys.fileExists(requested);
  return ts.createProgram([fileName], options, host);
}

describe("persisted contract summary bundles", () => {
  it("publishes a strict JSON schema for distributed summaries", () => {
    const schema = JSON.parse(readFileSync("schemas/uneffect-contract-summary-v1.schema.json", "utf8")) as {
      $id: string; properties: {
        schema: { const: string }; modules: { items: { $ref: string } };
        runtimeArtifacts: { items: { required: string[] } };
        typescriptEmit: { properties: { outputs: { items: { required: string[] } } } };
        exports: { items: { required: string[] } };
      };
    };
    expect(schema.$id).toBe("https://github.com/mizchi/uneffect/schemas/uneffect-contract-summary-v1.schema.json");
    expect(schema.properties.schema.const).toBe("uneffect-contract-summary/v1");
    expect(schema.properties.modules.items.$ref).toBe("#/$defs/semanticModule");
    expect(schema.properties.runtimeArtifacts.items.required).toEqual(["packagePath", "digest"]);
    expect(schema.properties.typescriptEmit.properties.outputs.items.required).toEqual(["kind", "packagePath", "digest"]);
    expect(schema.properties.exports.items.required).toEqual(expect.arrayContaining(["symbol", "signatureDigest", "artifactIds"]));
  });

  it("binds verified exported contracts to package, compiler, source, signature, and artifacts", async () => {
    const fileName = "/src/index.ts";
    const source = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      export async function addOne(value: number): Promise<number> { return value + 1 }
    `;
    const program = programFor(fileName, source);
    const verification = await verifyContractObligations(fileName, source, undefined, program);
    const bundle = createContractSummaryBundle({
      packageName: "@example/math", packageVersion: "1.2.3", fileName, source, program, artifacts: verification.artifacts,
    });

    expect(bundle).toMatchObject({
      schema: "uneffect-contract-summary/v1",
      package: { name: "@example/math", version: "1.2.3" },
      compiler: { typescriptVersion: ts.version, compilerOptionsDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      producer: { fileName, sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
      exports: [{
        symbol: { module: "@example/math", export: "addOne" }, evidence: "verified",
        requires: ["value >= 0"], ensures: ["result === value + 1"],
        signature: "(value: number): Promise<number>", signatureDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        artifactIds: verification.artifacts.map(({ obligationId }) => obligationId),
      }],
      contentDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/math", packageVersion: "1.2.3", fileName, source, program,
    })).toEqual({ valid: true, errors: [] });

    const tampered = { ...bundle, package: { ...bundle.package, version: "1.2.4" } };
    expect(validateContractSummaryBundle(tampered, {
      packageName: "@example/math", packageVersion: "1.2.4", fileName, source, program,
    })).toMatchObject({ valid: false, errors: expect.arrayContaining([expect.stringContaining("content digest")]) });
  });

  it("binds the exact semantics-module ledger into producer summaries", () => {
    const fileName = "/src/module-backed.ts";
    const source = `/* uneffect:effect none */ export function value(): number { return 1 }`;
    const program = programFor(fileName, source);
    const module = {
      name: "@acme/reviewed-semantics", version: "1.0.0", namespace: "Acme.Reviewed",
      evidence: "trusted" as const, trustOwner: "security-platform", trustReason: "reviewed package semantics",
      digest: "a".repeat(64),
    };
    const registry = { ...builtinContractRegistry, modules: [module] };
    const bundle = createContractSummaryBundle({
      packageName: "@example/module-backed", packageVersion: "1.0.0", fileName, source, program,
      artifacts: [], builtinRegistry: registry,
    });
    expect(bundle.modules).toEqual([module]);
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/module-backed", packageVersion: "1.0.0", fileName, source, program,
      builtinRegistry: registry,
    })).toEqual({ valid: true, errors: [] });
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/module-backed", packageVersion: "1.0.0", fileName, source, program,
      builtinRegistry: builtinContractRegistry,
    })).toMatchObject({ valid: false, errors: [expect.stringContaining("semantics-module ledger")] });
    expect(bindContractSummaryBundleToProgram(bundle, program, builtinContractRegistry)).toMatchObject({
      status: "unknown", blockers: [expect.stringContaining("semantics-module ledger")],
    });
  });

  it("persists callback and rejection semantics derived from a module registry", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-module-producer-"));
    const packageDirectory = join(directory, "node_modules", "reviewed-async");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "reviewed-async", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"),
      "export declare function later(callback: () => void): Promise<void>\n");
    const fileName = join(directory, "index.ts");
    const source = `
      import { later } from "reviewed-async"
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends none */
      export function wrap(callback: () => void): Promise<void> { return later(callback) }
    `;
    writeFileSync(fileName, source);
    const compilerOptions: ts.CompilerOptions = {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const program = ts.createProgram([fileName], compilerOptions);
    const module = {
      name: "@acme/async-semantics", version: "1.0.0", namespace: "Acme.Async",
      evidence: "trusted" as const, trustOwner: "security-platform", trustReason: "reviewed async API",
      digest: "b".repeat(64),
    };
    const registry = {
      ...extendBuiltinContractRegistry(builtinContractRegistry, { contracts: [{
        symbol: { module: "reviewed-async", export: "later" },
        runtime: { kind: "package" as const, version: "1.0.0" }, evidence: "trusted" as const,
        trustOwner: "security-platform", trustReason: "reviewed later",
        semantics: { schema: "uneffect-semantic-primitives/v1" as const, primitives: [
          { kind: "callback" as const, target: { kind: "argument" as const, index: 0 }, timing: "deferred" as const, queue: "microtask" as const, cardinality: "0..1" as const, completion: "convert-throw-to-rejection" as const },
          { kind: "reject" as const, error: "RangeError" },
        ] },
      }] }),
      modules: [module],
    };
    const bundle = createContractSummaryBundle({
      packageName: "@example/wrapper", packageVersion: "1.0.0", fileName, source, program,
      artifacts: [], builtinRegistry: registry,
    });
    expect(bundle.exports).toContainEqual(expect.objectContaining({
      symbol: { module: "@example/wrapper", export: "wrap" },
      effect: expect.objectContaining({
        rejects: ["RangeError"],
        callbacks: [expect.objectContaining({
          name: "callback", cardinality: "0..1", timing: "promise-reaction",
          completion: "convert-throw-to-rejection", effectBound: [],
        })],
      }),
    }));
    expect(bundle.modules).toEqual([module]);
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/wrapper", packageVersion: "1.0.0", fileName, source, program,
      builtinRegistry: registry,
    })).toEqual({ valid: true, errors: [] });

    const wrapperDirectory = join(directory, "node_modules", "@example", "wrapper");
    mkdirSync(wrapperDirectory, { recursive: true });
    writeFileSync(join(wrapperDirectory, "package.json"), JSON.stringify({
      name: "@example/wrapper", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(wrapperDirectory, "index.d.ts"),
      "export declare function wrap(callback: () => void): Promise<void>\n");
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { wrap } from "@example/wrapper"
      function callback(): void {}
      export function run(): Promise<void> { return wrap(callback) }
    `);
    const consumerProgram = ts.createProgram([consumerFile], compilerOptions);
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram, registry);
    expect(binding).toMatchObject({
      status: "verified",
      exports: [expect.objectContaining({
        summary: expect.objectContaining({
          effect: expect.objectContaining({
            rejects: ["RangeError"],
            callbacks: [expect.objectContaining({
              timing: "promise-reaction", completion: "convert-throw-to-rejection",
            })],
          }),
        }),
      })],
    });
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram)).toMatchObject({
      status: "unknown",
      blockers: [expect.stringContaining("semantics-module ledger")],
    });
  });

  it("refuses to publish a counterexample as a verified package summary", async () => {
    const fileName = "/src/index.ts";
    const source = `
      /* uneffect:ensures result === value + 1 */
      export async function addOne(value: number): Promise<number> { return value - 1 }
    `;
    const program = programFor(fileName, source);
    const verification = await verifyContractObligations(fileName, source, undefined, program);

    expect(() => createContractSummaryBundle({
      packageName: "@example/math", packageVersion: "1.2.3", fileName, source, program, artifacts: verification.artifacts,
    })).toThrow(/not fully verified/);
  });

  it("refuses to publish a retained callback as zero invocations", () => {
    const fileName = "/src/retained.ts";
    const source = `
      declare function retain(callback: () => void): void
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends none */
      export function register(callback: () => void): void { retain(callback) }
    `;
    const program = programFor(fileName, source);
    expect(() => createContractSummaryBundle({
      packageName: "@example/retained", packageVersion: "1.0.0", fileName, source, program, artifacts: [],
    })).toThrow(/Effect summary is not verified/);
  });

  it("publishes a verified Effect-only export in the shared package envelope", () => {
    const fileName = "/src/report.ts";
    const source = `
      /* uneffect:effect Console */
      export function report(message: string): void { console.log(message) }
      /* uneffect:effect Console */
      export const reportArrow = (message: string): void => { console.log(message) }
      /* uneffect:effect Console */
      export const reportFunction = function (message: string): void { console.log(message) }
      /* uneffect:effect Console */
      export let mutableReport = (message: string): void => { console.log(message) }
      /* uneffect:effect Mutate<typeof target.value> | Throw<RangeError> */
      export function update(target: { value: number }): void {
        target.value += 1
        if (target.value < 0) throw new RangeError("invalid")
      }
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Console */
      export function once(callback: () => void): void { callback() }
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Console */
      export function wrappedOnce(callback: () => void): void { once(callback) }
      /* uneffect:effect none */
      /* uneffect:effect_parameter onDone extends Console */
      export function configure({ onDone }: { onDone: () => void }): void { onDone() }
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Console */
      export function later(callback: () => void): Promise<void> {
        return Promise.resolve().then(callback)
      }
      /* uneffect:effect none */
      export async function rejectLater(): Promise<never> {
        return Promise.reject(new TypeError("nope"))
      }
    `;
    const program = programFor(fileName, source);
    const bundle = createContractSummaryBundle({
      packageName: "@example/report", packageVersion: "1.0.0", fileName, source, program, artifacts: [],
    });

    expect(bundle.exports).toEqual(expect.arrayContaining([expect.objectContaining({
      symbol: { module: "@example/report", export: "report" },
      functionName: "report",
      effect: { effects: ["Console"], parameters: ["message"] },
      requires: [],
      ensures: [],
      artifactIds: [],
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "reportArrow" },
      functionName: "reportArrow",
      effect: { effects: ["Console"], parameters: ["message"] },
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "reportFunction" },
      functionName: "reportFunction",
      effect: { effects: ["Console"], parameters: ["message"] },
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "update" },
      effect: {
        effects: expect.arrayContaining(["Mutate<typeof target.value>", "Throw<RangeError>"]),
        parameters: ["target"],
      },
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "once" },
      effect: {
        effects: [],
        parameters: ["callback"],
        callbacks: [expect.objectContaining({
          index: 0,
          name: "callback",
          cardinality: "exactly-1",
          timing: "inline",
          completion: "propagate-throw",
          effectBound: ["Console"],
        })],
      },
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "configure" },
      parameters: ["$arg0"],
      effect: {
        effects: [], parameters: ["$arg0"],
        callbacks: [expect.objectContaining({
          index: 0, name: "onDone", path: ["onDone"], containerAccess: "borrow-readonly",
          cardinality: "exactly-1",
          timing: "inline", completion: "propagate-throw", effectBound: ["Console"],
        })],
      },
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "wrappedOnce" },
      effect: {
        effects: [], parameters: ["callback"],
        callbacks: [expect.objectContaining({
          cardinality: "exactly-1", timing: "inline", completion: "propagate-throw",
        })],
      },
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "later" },
      effect: expect.objectContaining({
        callbacks: [expect.objectContaining({
          index: 0, name: "callback", cardinality: "0..1",
          timing: "promise-reaction", completion: "convert-throw-to-rejection",
          effectBound: ["Console"],
        })],
      }),
    }), expect.objectContaining({
      symbol: { module: "@example/report", export: "rejectLater" },
      effect: expect.objectContaining({ rejects: ["TypeError"] }),
    })]));
    expect(bundle.exports.some(({ symbol }) => symbol.export === "mutableReport")).toBe(false);
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/report", packageVersion: "1.0.0", fileName, source, program,
    })).toEqual({ valid: true, errors: [] });
  });

  it("rejects malformed persisted callback metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-malformed-"));
    const fileName = join(directory, "contract.json");
    writeFileSync(fileName, JSON.stringify({
      schema: "uneffect-contract-summary/v1",
      package: { name: "@example/callback", version: "1.0.0" },
      compiler: { typescriptVersion: ts.version, compilerOptionsDigest: "0".repeat(64) },
      producer: { fileName: "/src/index.ts", sourceDigest: "0".repeat(64) },
      exports: [{
        symbol: { module: "@example/callback", export: "once" }, functionName: "once", evidence: "verified",
        declarationSpan: { start: 0, end: 1 }, declarationDigest: "0".repeat(64),
        signature: "(callback: () => void): void", signatureDigest: "0".repeat(64),
        parameters: ["callback"], requires: [], ensures: [], artifactIds: [],
        effect: { effects: [], parameters: ["callback"], callbacks: [{
          index: -1, name: "callback", cardinality: "many", timing: "later", completion: "ignored",
        }] },
      }],
      contentDigest: "0".repeat(64),
    }));

    await expect(loadContractSummaryBundle(fileName)).rejects.toThrow(/malformed contract summary export 0/);
  });

  it("rejects malformed persisted semantics-module ledgers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-module-ledger-"));
    const fileName = join(directory, "contract.json");
    writeFileSync(fileName, JSON.stringify({
      schema: "uneffect-contract-summary/v1",
      package: { name: "@example/module", version: "1.0.0" },
      compiler: { typescriptVersion: ts.version, compilerOptionsDigest: "0".repeat(64) },
      producer: { fileName: "/src/index.ts", sourceDigest: "0".repeat(64) },
      modules: [{
        name: "broken", version: "1.0.0", namespace: "Broken", evidence: "trusted",
        trustOwner: "owner", trustReason: "reason", digest: "not-a-digest",
      }],
      exports: [], contentDigest: "0".repeat(64),
    }));
    await expect(loadContractSummaryBundle(fileName)).rejects.toThrow(/semantics-module ledger/);
  });

  it("binds a producer summary to an installed package export by TypeChecker identity", async () => {
    const producerFile = "/src/index.ts";
    const producerSource = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      export async function addOne(value: number): Promise<number> { return value + 1 }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const verification = await verifyContractObligations(producerFile, producerSource, undefined, producerProgram);
    const bundle = createContractSummaryBundle({
      packageName: "@example/math", packageVersion: "1.2.3", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: verification.artifacts,
    });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-consumer-"));
    const packageDirectory = join(directory, "node_modules", "@example", "math");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/math", version: "1.2.3", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), "export declare function addOne(value: number): Promise<number>;\n");
    const barrelFile = join(directory, "barrel.ts");
    writeFileSync(barrelFile, 'export { addOne as plusOne } from "@example/math";\n');
    const consumerFile = join(directory, "consumer.ts");
    const consumerSource = `
      import { plusOne as addOne } from "./barrel.js"
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      export async function run(value: number): Promise<number> {
        return await addOne(value)
      }
    `;
    writeFileSync(consumerFile, consumerSource);
    const options: ts.CompilerOptions = {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const consumerProgram = ts.createProgram([consumerFile, barrelFile], options);

    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);

    expect(binding).toMatchObject({
      status: "verified",
      package: { name: "@example/math", version: "1.2.3" },
      exports: [{ exportName: "addOne", evidence: "trusted" }],
      blockers: [],
    });
    expect(binding.exports[0]?.declarationFileName.replaceAll("\\", "/")).toMatch(/\/node_modules\/@example\/math\/index\.d\.ts$/);
    expect(binding.exports[0]?.declarationDigest).toMatch(/^[0-9a-f]{64}$/);

    const namespaceFile = join(directory, "namespace-consumer.ts");
    writeFileSync(namespaceFile, 'import * as math from "@example/math";\nvoid math.addOne(1);\n');
    const namespaceProgram = ts.createProgram([namespaceFile], options);
    expect(bindContractSummaryBundleToProgram(bundle, namespaceProgram)).toMatchObject({
      status: "verified",
      exports: [{ exportName: "addOne", evidence: "trusted" }],
      blockers: [],
    });

    const tamperedBundle = {
      ...bundle,
      exports: bundle.exports.map((item) => ({ ...item, ensures: ["result === value + 2"] })),
    };
    expect(bindContractSummaryBundleToProgram(tamperedBundle, consumerProgram)).toMatchObject({
      status: "unknown",
      exports: [],
      blockers: expect.arrayContaining([expect.stringContaining("content digest")]),
    });

    const consumerVerification = await verifyContractObligations(
      consumerFile, consumerSource, undefined, consumerProgram,
      { externalContractBindings: binding.exports },
    );
    expect(consumerVerification.diagnostics).toEqual([]);
    expect(consumerVerification.artifacts).not.toHaveLength(0);
    expect(consumerVerification.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(consumerVerification.artifacts.some((artifact) => artifact.controlFlow?.relationalCalls?.some((call) =>
      call.functionName === "addOne" && call.evidence === "trusted"))).toBe(true);

    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/math", version: "1.2.4", types: "index.d.ts",
    }));
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram)).toMatchObject({
      status: "unknown",
      exports: [],
      blockers: [expect.stringContaining("version 1.2.4 does not match summary 1.2.3")],
    });

    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/math", version: "1.2.3", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), "export declare function addOne(value: string): Promise<number>;\n");
    const driftedProgram = ts.createProgram([consumerFile, barrelFile], options);
    expect(bindContractSummaryBundleToProgram(bundle, driftedProgram)).toMatchObject({
      status: "unknown",
      exports: [],
      blockers: [expect.stringContaining("signature for addOne does not match")],
    });

    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/math", version: "1.2.3", types: "index.d.ts",
      exports: {
        ".": { types: "./index.d.ts" },
        "./unsafe": { types: "./unsafe.d.ts" },
      },
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), "export declare function addOne(value: number): Promise<number>;\n");
    writeFileSync(join(packageDirectory, "unsafe.d.ts"), "export declare function addOne(value: number): Promise<number>;\n");
    const unsafeFile = join(directory, "unsafe-consumer.ts");
    writeFileSync(unsafeFile, 'import { addOne } from "@example/math/unsafe";\nvoid addOne(1);\n');
    const unsafeProgram = ts.createProgram([unsafeFile], options);
    expect(bindContractSummaryBundleToProgram(bundle, unsafeProgram)).toMatchObject({
      status: "not-applicable",
      exports: [],
      blockers: [],
    });
  });

  it("connects a persisted Promise-reaction callback to host-neutral rejection", () => {
    const producerFile = "/src/index.ts";
    const producerSource = `
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Throw<Error> */
      export function later(callback: () => void): Promise<void> {
        return Promise.resolve().then(callback)
      }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/later", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-reaction-"));
    const packageDirectory = join(directory, "node_modules", "@example", "later");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/later", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), "export declare function later(callback: () => void): Promise<void>;\n");
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { later } from "@example/later"
      function fail(): void { throw new RangeError("failed") }
      export function run(): Promise<void> {
        const task = later(fail)
        return task
      }
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding.status).toBe("verified");
    const externalFunctionEffects = boundContractSummaryEffectContracts([binding]);
    const analysis = analyzeHostNeutralTransitions(
      consumerProgram, consumerProgram.getSourceFile(consumerFile)!, { externalFunctionEffects },
    );

    expect(analysis.transitions).toContainEqual(expect.objectContaining({
      kind: "invoke-callback", api: "later", callback: "fail",
      lane: "microtask", completion: "reject", cardinality: "0..1", promise: "task",
      promiseIdentity: expect.objectContaining({ fileName: consumerFile }),
    }));
    expect(analysis.transitions).toContainEqual(expect.objectContaining({
      kind: "settle-promise", promise: "task", lane: "microtask",
      outcomes: ["fulfilled", "rejected"], firstSettlementWins: true,
      promiseIdentity: expect.objectContaining({ fileName: consumerFile }),
      ownership: expect.objectContaining({ status: "observed", observations: ["return"] }),
    }));
  });

  it("connects persisted resource contracts to consumer lifecycle analysis", () => {
    const producerFile = "/src/resource.ts";
    const producerSource = `
      export interface Handle { readonly id: number }
      /* uneffect:acquire return */
      export function open(): Handle { return { id: 1 } }
      /* uneffect:release handle */
      export function close(handle: Handle): void { void handle }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/resource", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-resource-"));
    const packageDirectory = join(directory, "node_modules", "@example", "resource");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/resource", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export interface Handle { readonly id: number }
      export declare function open(): Handle
      export declare function close(handle: Handle): void
    `);
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { close, open } from "@example/resource"
      export function run(): void {
        const handle = open()
        close(handle)
      }
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding.status).toBe("verified");
    const resourceContracts = boundContractSummaryResourceContracts([binding]);
    const analysis = analyzeResourceLifecyclesInSource(
      consumerProgram, consumerProgram.getSourceFile(consumerFile)!,
      { summaries: resourceContracts, diagnostics: [] },
    );
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.evidence).toContainEqual(expect.objectContaining({
      owner: "run", status: "satisfied", state: "released", authority: "callable-contract",
    }));
  });

  it("binds package summaries to exact installed runtime artifacts", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-runtime-"));
    const producerFile = join(directory, "producer.ts");
    const producerSource = `/* uneffect:effect none */ export function value(): number { return 1 }`;
    writeFileSync(producerFile, producerSource);
    const runtimeFile = join(directory, "index.js");
    writeFileSync(runtimeFile, "export function value() { return 1 }\n");
    const producerProgram = ts.createProgram([producerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    });
    const bundle = createContractSummaryBundle({
      packageName: "@example/runtime", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
      runtimeArtifacts: [{ packagePath: "index.js", fileName: runtimeFile }],
    });
    expect(bundle.runtimeArtifacts).toEqual([{
      packagePath: "index.js", digest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }]);
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/runtime", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram,
      runtimeArtifacts: [{ packagePath: "index.js", fileName: runtimeFile }],
    })).toEqual({ valid: true, errors: [] });
    writeFileSync(runtimeFile, "export function value() { return 2 }\n");
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/runtime", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram,
      runtimeArtifacts: [{ packagePath: "index.js", fileName: runtimeFile }],
    })).toMatchObject({ valid: false, errors: [expect.stringContaining("runtime artifact ledger")] });
    writeFileSync(runtimeFile, "export function value() { return 1 }\n");
    expect(() => createContractSummaryBundle({
      packageName: "@example/runtime", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
      runtimeArtifacts: [{ packagePath: "../index.js", fileName: runtimeFile }],
    })).toThrow(/invalid package-relative runtime artifact path/u);

    const packageDirectory = join(directory, "node_modules", "@example", "runtime");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/runtime", version: "1.0.0", types: "index.d.ts", module: "index.js",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), "export declare function value(): number\n");
    writeFileSync(join(packageDirectory, "index.js"), "export function value() { return 1 }\n");
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `import { value } from "@example/runtime"; value()`);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram).status).toBe("verified");

    writeFileSync(join(packageDirectory, "index.js"), "export function value() { return 2 }\n");
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram)).toMatchObject({
      status: "unknown", exports: [],
      blockers: [expect.stringContaining("runtime artifact index.js")],
    });
  });

  it("binds exact TypeScript emit outputs to producer source and installed bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-ts-emit-"));
    const producerPackage = join(directory, "producer-package");
    const sourceDirectory = join(producerPackage, "src");
    const outputDirectory = join(producerPackage, "dist");
    mkdirSync(sourceDirectory, { recursive: true });
    const producerFile = join(sourceDirectory, "index.ts");
    const producerSource = `/* uneffect:effect none */ export function value(): number { return 1 }`;
    writeFileSync(producerFile, producerSource);
    const compilerOptions: ts.CompilerOptions = {
      strict: true, declaration: true, rootDir: sourceDirectory, outDir: outputDirectory,
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    };
    const producerProgram = ts.createProgram([producerFile], compilerOptions);
    expect(producerProgram.emit().emitSkipped).toBe(false);
    const bundle = createContractSummaryBundle({
      packageName: "@example/ts-emit", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
      typescriptEmit: { packageRoot: producerPackage },
    });
    expect(bundle.typescriptEmit?.outputs).toEqual(expect.arrayContaining([
      { kind: "runtime", packagePath: "dist/index.js", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      { kind: "declaration", packagePath: "dist/index.d.ts", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    ]));
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/ts-emit", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram,
      typescriptEmit: { packageRoot: producerPackage },
    })).toEqual({ valid: true, errors: [] });
    const emittedRuntime = readFileSync(join(outputDirectory, "index.js"));
    writeFileSync(join(outputDirectory, "index.js"), "export function value() { return 2 }\n");
    expect(validateContractSummaryBundle(bundle, {
      packageName: "@example/ts-emit", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram,
      typescriptEmit: { packageRoot: producerPackage },
    })).toMatchObject({ valid: false, errors: [expect.stringContaining("TypeScript emit is not exact")] });
    writeFileSync(join(outputDirectory, "index.js"), emittedRuntime);

    const installedPackage = join(directory, "node_modules", "@example", "ts-emit");
    mkdirSync(join(installedPackage, "dist"), { recursive: true });
    writeFileSync(join(installedPackage, "package.json"), JSON.stringify({
      name: "@example/ts-emit", version: "1.0.0", types: "dist/index.d.ts", module: "dist/index.js",
    }));
    writeFileSync(join(installedPackage, "dist", "index.d.ts"), readFileSync(join(outputDirectory, "index.d.ts")));
    writeFileSync(join(installedPackage, "dist", "index.js"), emittedRuntime);
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `import { value } from "@example/ts-emit"; value()`);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram).status).toBe("verified");
    writeFileSync(join(installedPackage, "dist", "index.js"), "export function value() { return 2 }\n");
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram)).toMatchObject({
      status: "unknown", exports: [], blockers: [expect.stringContaining("TypeScript runtime output dist/index.js")],
    });
  });
});

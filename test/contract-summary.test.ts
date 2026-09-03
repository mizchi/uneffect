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
import { analyzeProgramEffects } from "../src/effects.js";
import { formatEffect } from "../src/capabilities.js";

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
        exports: { items: { required: string[]; properties: {
          genericArity: { minimum: number };
          symbol: { properties: { path: { minItems: number } } };
          implementation: { required: string[] }; overloads: { items: { required: string[]; properties: {
            genericArity: { minimum: number };
          } } };
        } } };
      };
    };
    expect(schema.$id).toBe("https://github.com/mizchi/uneffect/schemas/uneffect-contract-summary-v1.schema.json");
    expect(schema.properties.schema.const).toBe("uneffect-contract-summary/v1");
    expect(schema.properties.modules.items.$ref).toBe("#/$defs/semanticModule");
    expect(schema.properties.runtimeArtifacts.items.required).toEqual(["packagePath", "digest"]);
    expect(schema.properties.typescriptEmit.properties.outputs.items.required).toEqual(["kind", "packagePath", "digest"]);
    expect(schema.properties.exports.items.required).toEqual(expect.arrayContaining(["symbol", "signatureDigest", "artifactIds"]));
    expect(schema.properties.exports.items.properties.implementation.required).toEqual(["fileName", "sourceDigest"]);
    expect(schema.properties.exports.items.properties.overloads.items.required).toEqual(["signature", "digest"]);
    expect(schema.properties.exports.items.properties.genericArity.minimum).toBe(1);
    expect(schema.properties.exports.items.properties.symbol.properties.path.minItems).toBe(1);
    expect(schema.properties.exports.items.properties.overloads.items.properties.genericArity.minimum).toBe(1);
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

  it("publishes and binds a default-exported callable by export identity", async () => {
    const producerFile = "/src/default.ts";
    const producerSource = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      /* uneffect:effect none */
      export default function increment(value: number): number { return value + 1 }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const verification = await verifyContractObligations(producerFile, producerSource, undefined, producerProgram);
    const bundle = createContractSummaryBundle({
      packageName: "@example/default", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: verification.artifacts,
    });
    expect(bundle.exports).toContainEqual(expect.objectContaining({
      symbol: { module: "@example/default", export: "default" }, functionName: "increment",
      effect: expect.objectContaining({ effects: [] }),
      ensures: ["result === value + 1"],
    }));

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-default-"));
    const packageDirectory = join(directory, "node_modules", "@example", "default");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/default", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"),
      "export default function increment(value: number): number\n");
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import clean from "@example/default"
      export const value = clean(1)
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, esModuleInterop: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram)).toMatchObject({
      status: "verified", blockers: [],
      exports: [expect.objectContaining({ exportName: "default" })],
    });

    const expressionFile = "/src/default-expression.ts";
    const expressionSource = `
      /* uneffect:effect none */
      /* uneffect:acquire return */
      export default ((value: number): number => value + 1)
    `;
    const expressionProgram = programFor(expressionFile, expressionSource);
    const expressionBundle = createContractSummaryBundle({
      packageName: "@example/default-expression", packageVersion: "1.0.0",
      fileName: expressionFile, source: expressionSource, program: expressionProgram, artifacts: [],
    });
    expect(expressionBundle.exports).toContainEqual(expect.objectContaining({
      symbol: { module: "@example/default-expression", export: "default" }, functionName: "default",
      resource: expect.objectContaining({ operations: [expect.objectContaining({ kind: "acquire" })] }),
    }));

    const indirectFile = "/src/indirect-default.ts";
    const indirectSource = `
      const normalize = (value: string): string => value.trim()
      /* uneffect:effect none */
      export default normalize
    `;
    expect(() => createContractSummaryBundle({
      packageName: "@example/indirect", packageVersion: "1.0.0", fileName: indirectFile,
      source: indirectSource, program: programFor(indirectFile, indirectSource), artifacts: [],
    })).toThrow(/no fully verified exported function contracts/u);
  });

  it("binds a package subpath export without colliding with the root export", () => {
    const producerFile = "/src/client.ts";
    const producerSource = `/* uneffect:effect none */ export function connect(): string { return "client" }`;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/sdk", packageVersion: "1.0.0", moduleSpecifier: "@example/sdk/client",
      fileName: producerFile, source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports[0]?.symbol).toEqual({ module: "@example/sdk/client", export: "connect" });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-subpath-"));
    const packageDirectory = join(directory, "node_modules", "@example", "sdk");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/sdk", version: "1.0.0", exports: {
        ".": { types: "./index.d.ts" }, "./client": { types: "./client.d.ts" },
      },
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), "export declare function connect(): number\n");
    writeFileSync(join(packageDirectory, "client.d.ts"), "export declare function connect(): string\n");
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { connect as rootConnect } from "@example/sdk"
      import { connect as clientConnect } from "@example/sdk/client"
      rootConnect()
      clientConnect()
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding).toMatchObject({ status: "verified", blockers: [] });
    expect(binding.exports[0]?.callSites).toHaveLength(1);
    expect(binding.exports[0]?.signature).toBe("(): string");

    expect(() => createContractSummaryBundle({
      packageName: "@example/sdk", packageVersion: "1.0.0", moduleSpecifier: "@other/client",
      fileName: producerFile, source: producerSource, program: producerProgram, artifacts: [],
    })).toThrow(/module specifier must be the package root or a subpath/u);
  });

  it("publishes local export-list aliases by TypeChecker symbol identity", () => {
    const producerFile = "/src/export-list.ts";
    const producerSource = `
      /* uneffect:effect none */
      function internal(value: number): number { return value + 1 }
      /* uneffect:effect none */
      const localArrow = (value: number): number => value * 2
      export { internal as normalize, internal as default, localArrow as double }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/export-list", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports.map(({ symbol, functionName }) => ({ symbol, functionName }))).toEqual([
      { symbol: { module: "@example/export-list", export: "default" }, functionName: "internal" },
      { symbol: { module: "@example/export-list", export: "double" }, functionName: "localArrow" },
      { symbol: { module: "@example/export-list", export: "normalize" }, functionName: "internal" },
    ]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-export-list-"));
    const packageDirectory = join(directory, "node_modules", "@example", "export-list");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/export-list", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export default function normalize(value: number): number
      export declare function double(value: number): number
      export declare function normalize(value: number): number
    `);
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import byDefault, { double, normalize } from "@example/export-list"
      byDefault(1)
      double(2)
      normalize(2)
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, esModuleInterop: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram)).toMatchObject({
      status: "verified", blockers: [], exports: [
        expect.objectContaining({ exportName: "default", callSites: [expect.anything()] }),
        expect.objectContaining({ exportName: "double", callSites: [expect.anything()] }),
        expect.objectContaining({ exportName: "normalize", callSites: [expect.anything()] }),
      ],
    });

    const mutableFile = "/src/mutable-export-list.ts";
    const mutableSource = `
      /* uneffect:effect none */
      let internal = (value: number): number => value + 1
      export { internal as normalize }
    `;
    expect(() => createContractSummaryBundle({
      packageName: "@example/mutable", packageVersion: "1.0.0", fileName: mutableFile,
      source: mutableSource, program: programFor(mutableFile, mutableSource), artifacts: [],
    })).toThrow(/no fully verified exported function contracts/u);

    const reexportDirectory = mkdtempSync(join(tmpdir(), "uneffect-contract-reexport-"));
    const implementationFile = join(reexportDirectory, "implementation.ts");
    const barrelFile = join(reexportDirectory, "index.ts");
    writeFileSync(implementationFile,
      `/* uneffect:effect none */ export function internal(value: number): number { return value + 1 }`);
    const barrelSource = `export { internal as normalize } from "./implementation.js"`;
    writeFileSync(barrelFile, barrelSource);
    const reexportProgram = ts.createProgram([barrelFile, implementationFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const reexportBundle = createContractSummaryBundle({
      packageName: "@example/reexport", packageVersion: "1.0.0", fileName: barrelFile,
      source: barrelSource, program: reexportProgram, artifacts: [],
    });
    expect(reexportBundle.exports).toContainEqual(expect.objectContaining({
      symbol: { module: "@example/reexport", export: "normalize" }, functionName: "internal",
      implementation: {
        fileName: implementationFile, sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    }));
    expect(validateContractSummaryBundle(reexportBundle, {
      packageName: "@example/reexport", packageVersion: "1.0.0", fileName: barrelFile,
      source: barrelSource, program: reexportProgram,
    })).toEqual({ valid: true, errors: [] });
    writeFileSync(implementationFile,
      `/* uneffect:effect none */ export function internal(value: number): number { return value + 2 }`);
    const driftedProgram = ts.createProgram([barrelFile, implementationFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(validateContractSummaryBundle(reexportBundle, {
      packageName: "@example/reexport", packageVersion: "1.0.0", fileName: barrelFile,
      source: barrelSource, program: driftedProgram,
    })).toMatchObject({
      valid: false, errors: expect.arrayContaining([expect.stringContaining("implementation source digest")]),
    });

    const externalFile = join(reexportDirectory, "external.ts");
    const externalSource = `export { readFile as load } from "node:fs/promises"`;
    writeFileSync(externalFile, externalSource);
    const externalProgram = ts.createProgram([externalFile], {
      strict: true, noEmit: true, types: ["node"], target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(() => createContractSummaryBundle({
      packageName: "@example/external", packageVersion: "1.0.0", fileName: externalFile,
      source: externalSource, program: externalProgram, artifacts: [],
    })).toThrow(/no fully verified exported function contracts/u);
  });

  it("publishes callable export-star members selected by the entry module", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-export-star-"));
    const implementationFile = join(directory, "implementation.ts");
    const middleFile = join(directory, "middle.ts");
    const entryFile = join(directory, "index.ts");
    writeFileSync(implementationFile, `
      /* uneffect:effect none */
      export function normalize(value: number): number { return value + 1 }
      /* uneffect:effect none */
      export const double = (value: number): number => value * 2
      export const version = "1.0.0"
      /* uneffect:effect none */
      export default function hidden(): void {}
    `);
    writeFileSync(middleFile, `export * from "./implementation.js"`);
    const entrySource = `export * from "./middle.js"`;
    writeFileSync(entryFile, entrySource);
    const options: ts.CompilerOptions = {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const program = ts.createProgram([entryFile, middleFile, implementationFile], options);
    const bundle = createContractSummaryBundle({
      packageName: "@example/star", packageVersion: "1.0.0", fileName: entryFile,
      source: entrySource, program, artifacts: [],
    });
    expect(bundle.exports.map(({ symbol, functionName }) => ({ export: symbol.export, functionName }))).toEqual([
      { export: "double", functionName: "double" },
      { export: "normalize", functionName: "normalize" },
    ]);

    const overrideSource = `
      export * from "./implementation.js"
      /* uneffect:effect none */
      export function normalize(): boolean { return true }
    `;
    writeFileSync(entryFile, overrideSource);
    const overrideProgram = ts.createProgram([entryFile, implementationFile], options);
    const overrideBundle = createContractSummaryBundle({
      packageName: "@example/star", packageVersion: "1.0.0", fileName: entryFile,
      source: overrideSource, program: overrideProgram, artifacts: [],
    });
    expect(overrideBundle.exports.map(({ symbol, signature }) => ({ export: symbol.export, signature }))).toEqual([
      { export: "double", signature: "(value: number): number" },
      { export: "normalize", signature: "(): boolean" },
    ]);

    const leftFile = join(directory, "left.ts");
    const rightFile = join(directory, "right.ts");
    writeFileSync(leftFile, `/* uneffect:effect none */ export function collide(): number { return 1 }`);
    writeFileSync(rightFile, `/* uneffect:effect none */ export function collide(): number { return 2 }`);
    const ambiguousSource = `export * from "./left.js"; export * from "./right.js"`;
    writeFileSync(entryFile, ambiguousSource);
    const ambiguousProgram = ts.createProgram([entryFile, leftFile, rightFile], options);
    expect(() => createContractSummaryBundle({
      packageName: "@example/star", packageVersion: "1.0.0", fileName: entryFile,
      source: ambiguousSource, program: ambiguousProgram, artifacts: [],
    })).toThrow(/TypeScript errors/u);
  });

  it("binds every consumer call to a producer-declared overload signature", () => {
    const producerFile = "/src/overload.ts";
    const producerSource = `
      export function parse(value: string): string
      export function parse(value: number): number
      /* uneffect:effect none */
      export function parse(value: string | number): string | number { return value }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/overload", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports[0]).toMatchObject({
      signature: "(value: string): string",
      overloads: [
        { signature: "(value: string): string", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
        { signature: "(value: number): number", digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
      ],
    });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-overload-"));
    const packageDirectory = join(directory, "node_modules", "@example", "overload");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/overload", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare function parse(value: string): string
      export declare function parse(value: number): number
    `);
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { parse } from "@example/overload"
      parse("value")
      parse(1)
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding).toMatchObject({ status: "verified", blockers: [] });
    expect(binding.exports[0]?.callSites).toHaveLength(2);

    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare function parse(value: string): string
      export declare function parse(value: number): number
      export declare function parse(value: boolean): boolean
    `);
    const driftedProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    expect(bindContractSummaryBundleToProgram(bundle, driftedProgram)).toMatchObject({
      status: "unknown", exports: [], blockers: [expect.stringContaining("signature")],
    });
  });

  it("binds TypeChecker-resolved instantiations of an exact generic declaration", () => {
    const producerFile = "/src/generic.ts";
    const producerSource = `
      /* uneffect:effect none */
      export function identity<T extends string | number>(value: T): T { return value }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/generic", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports[0]).toMatchObject({
      signature: "<T extends string | number>(value: T): T", genericArity: 1,
    });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-generic-"));
    const packageDirectory = join(directory, "node_modules", "@example", "generic");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/generic", version: "1.0.0", types: "index.d.ts",
    }));
    const declarationFile = join(packageDirectory, "index.d.ts");
    writeFileSync(declarationFile,
      "export declare function identity<T extends string | number>(value: T): T\n");
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { identity } from "@example/generic"
      identity("value")
      identity(1)
    `);
    const options: ts.CompilerOptions = {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    };
    const consumerProgram = ts.createProgram([consumerFile], options);
    expect(bindContractSummaryBundleToProgram(bundle, consumerProgram)).toMatchObject({
      status: "verified", blockers: [], exports: [expect.objectContaining({
        exportName: "identity", callSites: [expect.anything(), expect.anything()],
      })],
    });

    writeFileSync(consumerFile, `
      import { identity } from "@example/generic"
      identity(true)
    `);
    const invalidProgram = ts.createProgram([consumerFile], options);
    expect(invalidProgram.getSemanticDiagnostics()).not.toHaveLength(0);
    expect(bindContractSummaryBundleToProgram(bundle, invalidProgram)).toMatchObject({
      status: "unknown", exports: [], blockers: [expect.stringContaining("TypeScript-invalid")],
    });

    writeFileSync(consumerFile, `
      import { identity } from "@example/generic"
      identity("value")
    `);
    writeFileSync(declarationFile,
      "export declare function identity<T extends string>(value: T): T\n");
    const driftedProgram = ts.createProgram([consumerFile], options);
    expect(bindContractSummaryBundleToProgram(bundle, driftedProgram)).toMatchObject({
      status: "unknown", exports: [], blockers: [expect.stringContaining("signature")],
    });
  });

  it("binds a callable member of an exported frozen object by symbol path", () => {
    const producerFile = "/src/telemetry.ts";
    const producerSource = `
      export const telemetry = Object.freeze({
        /* uneffect:effect Console */
        track(value: string): void { console.log(value) }
      })
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/telemetry", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports).toEqual([expect.objectContaining({
      symbol: { module: "@example/telemetry", export: "telemetry", path: ["track"] },
      functionName: "telemetry.track",
      signature: "(value: string): void",
      effect: expect.objectContaining({ effects: ["Console"] }),
    })]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-member-"));
    const packageDirectory = join(directory, "node_modules", "@example", "telemetry");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/telemetry", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare const telemetry: Readonly<{ track(value: string): void }>
    `);
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { telemetry } from "@example/telemetry"
      export function run(): void { telemetry.track("event") }
      const track = telemetry.track
      export function runAlias(): void { track("aliased") }
      const { track: destructuredTrack } = telemetry
      export function runDestructured(): void { destructuredTrack("destructured") }
      declare const fake: typeof telemetry
      export function runFake(): void { fake.track("not-the-export") }
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding).toMatchObject({
      status: "verified", blockers: [], exports: [expect.objectContaining({
        exportName: "telemetry", callSites: [expect.anything(), expect.anything(), expect.anything()],
      })],
    });
    const analysis = analyzeProgramEffects(consumerProgram, {
      externalFunctionEffects: boundContractSummaryEffectContracts([binding]),
    });
    expect(analysis.summaries.find(({ functionName }) => functionName === "run")?.effects.map(formatEffect)).toEqual(["Console"]);
    expect(analysis.summaries.find(({ functionName }) => functionName === "runAlias")?.effects.map(formatEffect)).toEqual(["Console"]);
    expect(analysis.summaries.find(({ functionName }) => functionName === "runDestructured")?.effects.map(formatEffect)).toEqual(["Console"]);
    expect(analysis.summaries.find(({ functionName }) => functionName === "runFake")).toMatchObject({
      evidence: "unknown", effects: [], unknownReasons: [expect.objectContaining({ code: "unknown-external-evidence" })],
    });

    const mutableSource = `
      export const telemetry = {
        /* uneffect:effect Console */
        track(value: string): void { console.log(value) }
      }
    `;
    expect(() => createContractSummaryBundle({
      packageName: "@example/telemetry", packageVersion: "1.0.0", fileName: producerFile,
      source: mutableSource, program: programFor(producerFile, mutableSource), artifacts: [],
    })).toThrow(/no fully verified exported function contracts/u);

    const shadowedSource = `
      const Object = { freeze<T>(value: T): T { return value } }
      export const telemetry = Object.freeze({
        /* uneffect:effect Console */
        track(value: string): void { console.log(value) }
      })
    `;
    expect(() => createContractSummaryBundle({
      packageName: "@example/telemetry", packageVersion: "1.0.0", fileName: producerFile,
      source: shadowedSource, program: programFor(producerFile, shadowedSource), artifacts: [],
    })).toThrow(/no fully verified exported function contracts/u);
  });

  it("binds a callable nested beneath independently frozen namespace objects", () => {
    const producerFile = "/src/api.ts";
    const producerSource = `
      export const api = Object.freeze({
        users: Object.freeze({
          /* uneffect:effect Console */
          get(id: string): void { console.log(id) }
        })
      })
    `;
    const bundle = createContractSummaryBundle({
      packageName: "@example/api", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: programFor(producerFile, producerSource), artifacts: [],
    });
    expect(bundle.exports).toEqual([expect.objectContaining({
      symbol: { module: "@example/api", export: "api", path: ["users", "get"] },
      functionName: "api.users.get",
    })]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-nested-member-"));
    const packageDirectory = join(directory, "node_modules", "@example", "api");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/api", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare const api: Readonly<{ users: Readonly<{ get(id: string): void }> }>
    `);
    const consumerFile = join(directory, "consumer.ts");
    writeFileSync(consumerFile, `
      import { api } from "@example/api"
      export function load(): void { api.users.get("id") }
    `);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding).toMatchObject({ status: "verified", blockers: [], exports: [{
      exportName: "api", callSites: [expect.anything()],
    }] });
    expect(analyzeProgramEffects(consumerProgram, {
      externalFunctionEffects: boundContractSummaryEffectContracts([binding]),
    }).summaries.find(({ functionName }) => functionName === "load")?.effects.map(formatEffect)).toEqual(["Console"]);

    const shallowSource = `
      export const api = Object.freeze({
        users: {
          /* uneffect:effect Console */
          get(id: string): void { console.log(id) }
        }
      })
    `;
    expect(() => createContractSummaryBundle({
      packageName: "@example/api", packageVersion: "1.0.0", fileName: producerFile,
      source: shallowSource, program: programFor(producerFile, shallowSource), artifacts: [],
    })).toThrow(/no fully verified exported function contracts/u);
  });

  it("composes an async frozen member Hoare contract at an awaited consumer call", async () => {
    const producerFile = "/src/math-api.ts";
    const producerSource = `
      export const math = Object.freeze({
        /* uneffect:requires value >= 0 */
        /* uneffect:ensures result === value + 1 */
        async addOne(value: number): Promise<number> { return value + 1 }
      })
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const producerVerification = await verifyContractObligations(producerFile, producerSource, undefined, producerProgram);
    const bundle = createContractSummaryBundle({
      packageName: "@example/math-api", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: producerVerification.artifacts,
    });
    expect(bundle.exports).toEqual([expect.objectContaining({
      symbol: { module: "@example/math-api", export: "math", path: ["addOne"] },
      requires: ["value >= 0"], ensures: ["result === value + 1"],
    })]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-member-hoare-"));
    const packageDirectory = join(directory, "node_modules", "@example", "math-api");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/math-api", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare const math: Readonly<{ addOne(value: number): Promise<number> }>
    `);
    const consumerFile = join(directory, "consumer.ts");
    const consumerSource = `
      import { math } from "@example/math-api"
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      export async function run(value: number): Promise<number> {
        return await math.addOne(value)
      }
    `;
    writeFileSync(consumerFile, consumerSource);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding).toMatchObject({ status: "verified", blockers: [] });
    const consumerVerification = await verifyContractObligations(consumerFile, consumerSource, undefined, consumerProgram, {
      externalContractBindings: binding.exports,
    });
    expect(consumerVerification.diagnostics).toEqual([]);
    expect(consumerVerification.artifacts.find((artifact) => artifact.obligation?.functionName === "run"))
      .toMatchObject({ status: "verified" });
  });

  it("composes a persisted frozen member rejection through await catch", async () => {
    const producerFile = "/src/async-risk-api.ts";
    const producerSource = `
      export const api = Object.freeze({
        /* uneffect:effect none */
        async load(): Promise<never> {
          throw new RangeError("negative")
        }
      })
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const producerVerification = await verifyContractObligations(producerFile, producerSource, undefined, producerProgram);
    const bundle = createContractSummaryBundle({
      packageName: "@example/async-risk-api", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: producerVerification.artifacts,
    });
    expect(bundle.exports[0]).toMatchObject({
      symbol: { module: "@example/async-risk-api", export: "api", path: ["load"] },
      effect: { rejects: ["RangeError"] },
    });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-member-reject-"));
    const packageDirectory = join(directory, "node_modules", "@example", "async-risk-api");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/async-risk-api", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare const api: Readonly<{ load(): Promise<never> }>
    `);
    const consumerFile = join(directory, "consumer.ts");
    const consumerSource = `
      import { api } from "@example/async-risk-api"
      /* uneffect:ensures result === 1 */
      export async function run(): Promise<number> {
        try {
          await api.load()
        } catch {}
        return 1
      }
    `;
    writeFileSync(consumerFile, consumerSource);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    const verification = await verifyContractObligations(consumerFile, consumerSource, undefined, consumerProgram, {
      externalContractBindings: binding.exports,
    });
    expect(verification.diagnostics).toEqual([]);
    expect(verification.artifacts.find((artifact) => artifact.controlFlow?.exceptionFlow?.discharged.some((edge) =>
      edge.effect === "Reject<RangeError>"))).toMatchObject({ status: "verified" });

    const lookalikeFile = join(directory, "lookalike.ts");
    const lookalikeSource = `
      import { api } from "@example/async-risk-api"
      async function authorize(): Promise<void> { try { await api.load() } catch {} }
      const fake = { load(): Promise<never> { return Promise.reject(new RangeError("fake")) } } as typeof api
      /* uneffect:ensures result === 1 */
      export async function lookalike(): Promise<number> {
        try { await fake.load() } catch {}
        return 1
      }
    `;
    writeFileSync(lookalikeFile, lookalikeSource);
    const lookalikeProgram = ts.createProgram([lookalikeFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const lookalikeBinding = bindContractSummaryBundleToProgram(bundle, lookalikeProgram);
    const lookalikeVerification = await verifyContractObligations(lookalikeFile, lookalikeSource, undefined, lookalikeProgram, {
      externalContractBindings: lookalikeBinding.exports,
    });
    expect(lookalikeVerification.artifacts).toEqual([
      expect.objectContaining({ status: "unsupported", message: expect.stringContaining("fake.load()") }),
    ]);
  });

  it("does not borrow Hoare evidence from a same-named frozen member", async () => {
    const fileName = "/src/math-apis.ts";
    const source = `
      export const good = Object.freeze({
        /* uneffect:ensures result === value + 1 */
        addOne(value: number): number { return value + 1 }
      })
      export const bad = Object.freeze({
        /* uneffect:ensures result === value + 1 */
        addOne(value: number): number { return value + 2 }
      })
    `;
    const program = programFor(fileName, source);
    const verification = await verifyContractObligations(fileName, source, undefined, program);
    expect(verification.artifacts.filter(({ obligation }) => obligation?.functionName === "addOne"))
      .toEqual([expect.objectContaining({ status: "verified" }), expect.objectContaining({ status: "counterexample" })]);
    expect(() => createContractSummaryBundle({
      packageName: "@example/math-apis", packageVersion: "1.0.0", fileName,
      source, program, artifacts: verification.artifacts,
    })).toThrow(/bad is not fully verified/u);
  });

  it("composes a synchronous frozen member Hoare contract at a consumer return", async () => {
    const producerFile = "/src/sync-math-api.ts";
    const producerSource = `
      export const math = Object.freeze({
        /* uneffect:requires value >= 0 */
        /* uneffect:ensures result === value + 1 */
        addOne(value: number): number { return value + 1 }
      })
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const producerVerification = await verifyContractObligations(producerFile, producerSource, undefined, producerProgram);
    const bundle = createContractSummaryBundle({
      packageName: "@example/sync-math-api", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: producerVerification.artifacts,
    });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-sync-member-hoare-"));
    const packageDirectory = join(directory, "node_modules", "@example", "sync-math-api");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/sync-math-api", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare const math: Readonly<{ addOne(value: number): number }>
    `);
    const consumerFile = join(directory, "consumer.ts");
    const consumerSource = `
      import { math } from "@example/sync-math-api"
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      export function run(value: number): number {
        return math.addOne(value)
      }
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 2 */
      export function staged(value: number): number {
        const next = math.addOne(value)
        return next + 1
      }
    `;
    writeFileSync(consumerFile, consumerSource);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding).toMatchObject({ status: "verified", blockers: [] });
    const consumerVerification = await verifyContractObligations(consumerFile, consumerSource, undefined, consumerProgram, {
      externalContractBindings: binding.exports,
    });
    expect(consumerVerification.diagnostics).toEqual([]);
    expect(consumerVerification.artifacts.find((artifact) => artifact.obligation?.functionName === "run"))
      .toMatchObject({ status: "verified" });
    expect(consumerVerification.artifacts.find((artifact) => artifact.obligation?.functionName === "staged"))
      .toMatchObject({ status: "verified" });

    const invalidFile = join(directory, "invalid.ts");
    const invalidSource = `
      import { math } from "@example/sync-math-api"
      /* uneffect:ensures result >= 0 */
      export function invalid(): number {
        return math.addOne(-1)
      }
    `;
    writeFileSync(invalidFile, invalidSource);
    const invalidProgram = ts.createProgram([invalidFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const invalidBinding = bindContractSummaryBundleToProgram(bundle, invalidProgram);
    const invalidVerification = await verifyContractObligations(invalidFile, invalidSource, undefined, invalidProgram, {
      externalContractBindings: invalidBinding.exports,
    });
    expect(invalidVerification.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "counterexample", obligation: expect.objectContaining({ clause: "requires" }) }),
    ]));

    const lookalikeFile = join(directory, "lookalike.ts");
    const lookalikeSource = `
      import { math } from "@example/sync-math-api"
      function authorized(value: number): number { return math.addOne(value) }
      const fake = { addOne(value: number): number { return value + 2 } } as typeof math
      /* uneffect:ensures result === value + 1 */
      export function lookalike(value: number): number {
        return fake.addOne(value)
      }
    `;
    writeFileSync(lookalikeFile, lookalikeSource);
    const lookalikeProgram = ts.createProgram([lookalikeFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const lookalikeBinding = bindContractSummaryBundleToProgram(bundle, lookalikeProgram);
    expect(lookalikeBinding).toMatchObject({ status: "verified", exports: [{ callSites: [expect.anything()] }] });
    const lookalikeVerification = await verifyContractObligations(lookalikeFile, lookalikeSource, undefined, lookalikeProgram, {
      externalContractBindings: lookalikeBinding.exports,
    });
    expect(lookalikeVerification.artifacts).toEqual([
      expect.objectContaining({ status: "unsupported", message: expect.stringContaining("fake.addOne(value)") }),
    ]);
  });

  it("discharges an authenticated frozen member Throw effect through consumer catch", async () => {
    const producerFile = "/src/danger-api.ts";
    const producerSource = `
      export const api = Object.freeze({
        /* uneffect:effect Throw<RangeError> */
        danger(value: number): void { if (value < 0) throw new RangeError("negative") },
        /* uneffect:effect Throw<RangeError> */
        /* uneffect:ensures result === value + 1 */
        dangerousAdd(value: number): number {
          if (value < 0) throw new RangeError("negative")
          return value + 1
        },
        /* uneffect:effect Throw<RangeError> */
        /* uneffect:ensures result === true */
        ensureNonnegative(value: number): boolean {
          if (value < 0) throw new RangeError("negative")
          return true
        },
        /* uneffect:effect Throw<RangeError> */
        /* uneffect:ensures result === enabled */
        checkedFlag(value: number, enabled: boolean): boolean {
          if (value < 0) throw new RangeError("negative")
          return enabled
        }
      })
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const producerVerification = await verifyContractObligations(producerFile, producerSource, undefined, producerProgram);
    const bundle = createContractSummaryBundle({
      packageName: "@example/danger-api", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: producerVerification.artifacts,
    });
    const directory = mkdtempSync(join(tmpdir(), "uneffect-contract-member-throw-"));
    const packageDirectory = join(directory, "node_modules", "@example", "danger-api");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
      name: "@example/danger-api", version: "1.0.0", types: "index.d.ts",
    }));
    writeFileSync(join(packageDirectory, "index.d.ts"), `
      export declare const api: Readonly<{
        danger(value: number): void
        dangerousAdd(value: number): number
        ensureNonnegative(value: number): boolean
        checkedFlag(value: number, enabled: boolean): boolean
      }>
    `);
    const consumerFile = join(directory, "consumer.ts");
    const consumerSource = `
      import { api } from "@example/danger-api"
      /* uneffect:ensures result === 1 */
      export function run(value: number): number {
        try {
          api.danger(value)
          return 1
        } catch {
          return 1
        }
      }
      /* uneffect:ensures result === 1 */
      export function unhandled(value: number): number {
        api.danger(value)
        return 1
      }
      /* uneffect:ensures result === 1 */
      export function finalized(value: number): number {
        try {
          api.danger(value)
        } finally {
          value += 0
        }
        return 1
      }
    `;
    writeFileSync(consumerFile, consumerSource);
    const consumerProgram = ts.createProgram([consumerFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const binding = bindContractSummaryBundleToProgram(bundle, consumerProgram);
    expect(binding).toMatchObject({ status: "verified", blockers: [] });
    const verification = await verifyContractObligations(consumerFile, consumerSource, undefined, consumerProgram, {
      externalContractBindings: binding.exports,
    });
    expect(verification.diagnostics).toEqual([]);
    expect(verification.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "verified",
        controlFlow: expect.objectContaining({
          exceptionFlow: expect.objectContaining({
            discharged: [expect.objectContaining({ effect: "Throw<RangeError>", evidence: "trusted" })],
          }),
        }),
      }),
    ]));
    for (const functionName of ["unhandled", "finalized"]) {
      expect(verification.artifacts.find((artifact) => artifact.obligation?.functionName === functionName))
        .toMatchObject({
          status: "verified",
          controlFlow: { exceptionFlow: { escapes: [expect.objectContaining({ effect: "Throw<RangeError>", evidence: "trusted" })] } },
        });
    }

    const lookalikeFile = join(directory, "lookalike.ts");
    const lookalikeSource = `
      import { api } from "@example/danger-api"
      function authorized(value: number): void { api.danger(value) }
      const fake = { danger(_value: number): void {} } as typeof api
      /* uneffect:ensures result === 1 */
      export function lookalike(value: number): number {
        try { fake.danger(value) } catch {}
        return 1
      }
    `;
    writeFileSync(lookalikeFile, lookalikeSource);
    const lookalikeProgram = ts.createProgram([lookalikeFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const lookalikeBinding = bindContractSummaryBundleToProgram(bundle, lookalikeProgram);
    const lookalikeVerification = await verifyContractObligations(lookalikeFile, lookalikeSource, undefined, lookalikeProgram, {
      externalContractBindings: lookalikeBinding.exports,
    });
    expect(lookalikeVerification.artifacts).toEqual([
      expect.objectContaining({ status: "unsupported", message: expect.stringContaining("fake.danger") }),
    ]);

    const scalarFile = join(directory, "scalar.ts");
    const scalarSource = `
      import { api } from "@example/danger-api"
      function authorize(value: number): void { api.danger(value) }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === value + 1 */
      export function scalar(value: number): number {
        return api.dangerousAdd(value)
      }
      /* uneffect:ensures result === value + 1 */
      export function bound(value: number): number {
        try {
          const result = api.dangerousAdd(value)
          return result
        } catch {
          return value + 1
        }
      }
      /* uneffect:ensures result === value + 1 */
      export function assigned(value: number): number {
        let result = 0
        try {
          result = api.dangerousAdd(value)
        } catch {
          result = value + 1
        }
        return result
      }
    `;
    writeFileSync(scalarFile, scalarSource);
    const scalarProgram = ts.createProgram([scalarFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    });
    const scalarBinding = bindContractSummaryBundleToProgram(bundle, scalarProgram);
    const scalarVerification = await verifyContractObligations(scalarFile, scalarSource, undefined, scalarProgram, {
      externalContractBindings: scalarBinding.exports,
    });
    expect(scalarVerification.diagnostics).toEqual([]);
    expect(scalarVerification.artifacts.find((artifact) => artifact.obligation?.functionName === "scalar"))
      .toMatchObject({
        status: "verified",
        controlFlow: { exceptionFlow: { escapes: [expect.objectContaining({ effect: "Throw<RangeError>" })] } },
      });
    expect(scalarVerification.artifacts.find((artifact) => artifact.obligation?.functionName === "bound"
      && artifact.controlFlow?.exceptionFlow?.discharged.length)).toMatchObject({ status: "verified" });
    expect(scalarVerification.artifacts.find((artifact) => artifact.obligation?.functionName === "assigned"
      && artifact.controlFlow?.exceptionFlow?.discharged.length)).toMatchObject({ status: "verified" });
    const nestedFile = join(directory, "nested.ts");
    const nestedSource = `
      import { api } from "@example/danger-api"
      import { fail, ok, strictEqual } from "node:assert/strict"
      /* uneffect:ensures result === value */
      /* uneffect:temporal_contract rejects TypeError */
      /* uneffect:temporal_contract throws URIError */
      declare function remote(value: number): Promise<number>
      function authorize(value: number): void { api.danger(value) }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === value + 2 */
      export function nested(value: number): number {
        let result = 0
        result = api.dangerousAdd(value) + 1
        return result
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === value + 1 */
      export function conditional(value: number, enabled: boolean): number {
        return enabled ? api.dangerousAdd(value) : value + 1
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === true */
      export function compared(value: number): boolean {
        return api.dangerousAdd(value) > value
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === (value + 1) + (value + 1) */
      export function twice(value: number): number {
        return api.dangerousAdd(value) + api.dangerousAdd(value)
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === -(value + 1) */
      export function negated(value: number): number {
        return -api.dangerousAdd(value)
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === enabled */
      export function shortCircuitLeft(value: number, enabled: boolean): boolean {
        return api.ensureNonnegative(value) && enabled
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === enabled */
      export function shortCircuitRight(value: number, enabled: boolean): boolean {
        return enabled && api.ensureNonnegative(value)
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === 1 */
      export function conditionCall(value: number): number {
        return api.ensureNonnegative(value) ? 1 : 0
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result >= 0 */
      export function absolute(value: number): number {
        return Math.abs(api.dangerousAdd(value))
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === 1 */
      export function ifCall(value: number): number {
        if (api.ensureNonnegative(value)) return 1
        return 0
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === 1 */
      export function switchCall(value: number): number {
        switch (api.ensureNonnegative(value)) {
          case true: return 1
          case false: return 0
        }
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === 1 */
      export function whileCall(value: number): number {
        /* uneffect:loop_invariant true */
        while (api.ensureNonnegative(value)) {
          break
        }
        return 1
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === 1 */
      export function forCall(value: number, enabled: boolean): number {
        /* uneffect:loop_invariant true */
        for (let i = 0; api.checkedFlag(value, enabled); i++) {
          break
        }
        return 1
      }
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === 1 */
      export function doCall(value: number): number {
        let repeat = true
        /* uneffect:loop_invariant true */
        do {
          repeat = false
        } while (api.checkedFlag(value, repeat))
        return 1
      }
      /* uneffect:ensures result === 5 */
      export function compound(value: number): number {
        let result = 5
        try {
          result += api.dangerousAdd(value)
        } catch {
          return result
        }
        return 5
      }
      /* uneffect:ensures result === false */
      export function logical(value: number): boolean {
        let result = false
        try {
          result ||= api.ensureNonnegative(value)
        } catch {
          return result
        }
        return false
      }
      /* uneffect:ensures result === true */
      export function nullish(result: number | null, value: number): boolean {
        if (result !== null) return true
        try {
          result ??= api.dangerousAdd(value)
        } catch {
          return result === null
        }
        return true
      }
      /* uneffect:ensures result === 5 */
      export function asserted(value: number): number {
        let result = 5
        try {
          strictEqual(api.dangerousAdd(value), value + 1)
          result = 6
        } catch {
          return result
        }
        return 5
      }
      /* uneffect:ensures result === 5 */
      export function assertedTruthy(value: number): number {
        let result = 5
        try {
          ok(api.ensureNonnegative(value))
          result = 6
        } catch {
          return result
        }
        return 5
      }
      /* uneffect:ensures result === 5 */
      export function assertedFail(value: number): number {
        let result = 5
        try {
          fail(api.ensureNonnegative(value) as any)
        } catch {
          return result
        }
      }
      /* uneffect:ensures result === 1 */
      export function nestedStatement(value: number): number {
        try {
          api.danger(api.dangerousAdd(value))
        } catch {
          return 1
        }
        return 1
      }
      /* uneffect:ensures result === 1 */
      export function nestedThrow(value: number): number {
        try {
          throw api.dangerousAdd(value)
        } catch {
          return 1
        }
      }
      /* uneffect:ensures result === 1 */
      export async function nestedAwait(value: number): Promise<number> {
        try {
          await remote(api.dangerousAdd(value))
        } catch {
          return 1
        }
        return 1
      }
      /* uneffect:ensures result === 1 */
      export async function nestedStoredAwait(value: number): Promise<number> {
        try {
          const pending = remote(api.dangerousAdd(value))
          await pending
        } catch {
          return 1
        }
        return 1
      }
      /* uneffect:ensures result === value + 2 || result === 1 */
      export async function awaitedExpression(value: number): Promise<number> {
        try {
          return (await remote(api.dangerousAdd(value))) + 1
        } catch {
          return 1
        }
      }
      /* uneffect:ensures result === value + 1 || result === 1 */
      export async function plainAwaitedExpression(value: number): Promise<number> {
        try {
          return (await remote(value)) + 1
        } catch {
          return 1
        }
      }
      /* uneffect:ensures result === value || result === 1 */
      export async function forwardedPromise(value: number): Promise<number> {
        try {
          return remote(value)
        } catch {
          return 1
        }
      }
      /* uneffect:ensures result === value || result === 1 */
      export async function forwardedStoredPromise(value: number): Promise<number> {
        try {
          const pending = remote(value)
          return pending
        } catch {
          return 1
        }
      }
      /* uneffect:ensures result === value || result === 1 */
      export async function conditionalForward(value: number, enabled: boolean): Promise<number> {
        try {
          return enabled ? remote(value) : Promise.resolve(value)
        } catch {
          return 1
        }
      }
      /* uneffect:ensures result === value || result === 1 */
      export async function mixedConditionalForward(value: number, enabled: boolean): Promise<number> {
        try {
          return enabled ? remote(value) : value
        } catch {
          return 1
        }
      }
    `;
    writeFileSync(nestedFile, nestedSource);
    const nestedProgram = ts.createProgram([nestedFile], {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: ["node"],
    });
    const nestedBinding = bindContractSummaryBundleToProgram(bundle, nestedProgram);
    const nestedVerification = await verifyContractObligations(nestedFile, nestedSource, undefined, nestedProgram, {
      externalContractBindings: nestedBinding.exports,
    });
    expect(nestedVerification.diagnostics).toEqual([]);
    for (const functionName of ["nested", "conditional", "compared", "negated", "shortCircuitLeft", "shortCircuitRight", "conditionCall", "absolute", "ifCall", "switchCall", "whileCall", "forCall", "doCall"]) {
      expect(nestedVerification.artifacts.find((artifact) => artifact.obligation?.functionName === functionName))
        .toMatchObject({
          status: "verified",
          controlFlow: { exceptionFlow: { escapes: [expect.objectContaining({ effect: "Throw<RangeError>" })] } },
        });
    }
    const twice = nestedVerification.artifacts.find((artifact) => artifact.obligation?.functionName === "twice");
    expect(twice).toMatchObject({ status: "verified" });
    expect(twice?.controlFlow?.exceptionFlow?.escapes).toHaveLength(2);
    expect(new Set(twice?.controlFlow?.exceptionFlow?.escapes.map(({ originSpan }) => `${originSpan.start}:${originSpan.end}`)).size).toBe(2);
    for (const functionName of ["compound", "logical", "nullish", "asserted", "assertedTruthy", "assertedFail", "nestedStatement", "nestedThrow"]) {
      expect(nestedVerification.artifacts.find((artifact) => artifact.obligation?.functionName === functionName
        && artifact.controlFlow?.exceptionFlow?.discharged.length)).toMatchObject({ status: "verified" });
    }
    expect(nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "asserted")
      .flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? [])).toEqual(expect.arrayContaining([
        expect.objectContaining({ effect: "Throw<RangeError>" }),
        expect.objectContaining({ effect: "Throw<AssertionError>" }),
      ]));
    expect(nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "assertedTruthy")
      .flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? [])).toEqual(expect.arrayContaining([
        expect.objectContaining({ effect: "Throw<RangeError>" }),
        expect.objectContaining({ effect: "Throw<AssertionError>" }),
      ]));
    expect(nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "assertedFail")
      .flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? [])).toEqual(expect.arrayContaining([
        expect.objectContaining({ effect: "Throw<RangeError>" }),
        expect.objectContaining({ effect: "Throw<AssertionError>" }),
      ]));
    const nestedStatementThrows = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "nestedStatement")
      .flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? [])
      .filter(({ effect }) => effect === "Throw<RangeError>");
    expect(new Set(nestedStatementThrows.map(({ originSpan }) => `${originSpan.start}:${originSpan.end}`)).size).toBe(2);
    const nestedThrowEffects = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "nestedThrow")
      .flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []);
    expect(nestedThrowEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: "Throw<RangeError>" }),
      expect.objectContaining({ effect: "Throw<unknown>" }),
    ]));
    const nestedAwaitEffects = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "nestedAwait")
      .flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []);
    expect(nestedAwaitEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: "Throw<RangeError>", kind: "synchronous-throw" }),
      expect.objectContaining({ effect: "Throw<URIError>", kind: "synchronous-throw" }),
      expect.objectContaining({ effect: "Reject<TypeError>", kind: "promise-rejection" }),
    ]));
    const nestedStoredAwaitEffects = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "nestedStoredAwait")
      .flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []);
    expect(nestedStoredAwaitEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ effect: "Throw<RangeError>", kind: "synchronous-throw" }),
      expect.objectContaining({ effect: "Throw<URIError>", kind: "synchronous-throw" }),
      expect.objectContaining({ effect: "Reject<TypeError>", kind: "promise-rejection" }),
    ]));
    const awaitedExpressionArtifacts = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "awaitedExpression");
    expect(awaitedExpressionArtifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(awaitedExpressionArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ effect: "Throw<RangeError>" }),
        expect.objectContaining({ effect: "Throw<URIError>" }),
        expect.objectContaining({ effect: "Reject<TypeError>" }),
      ]));
    const plainAwaitedExpressionArtifacts = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "plainAwaitedExpression");
    expect(plainAwaitedExpressionArtifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(plainAwaitedExpressionArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ effect: "Throw<URIError>" }),
        expect.objectContaining({ effect: "Reject<TypeError>" }),
      ]));
    const forwardedPromiseArtifacts = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "forwardedPromise");
    expect(forwardedPromiseArtifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(forwardedPromiseArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Throw<URIError>" })]));
    expect(forwardedPromiseArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Reject<TypeError>" })]));
    expect(forwardedPromiseArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.escapes ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Reject<TypeError>" })]));
    const forwardedStoredPromiseArtifacts = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "forwardedStoredPromise");
    expect(forwardedStoredPromiseArtifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(forwardedStoredPromiseArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Throw<URIError>" })]));
    expect(forwardedStoredPromiseArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.escapes ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Reject<TypeError>" })]));
    const conditionalForwardArtifacts = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "conditionalForward");
    expect(conditionalForwardArtifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(conditionalForwardArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Throw<URIError>" })]));
    expect(conditionalForwardArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.escapes ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Reject<TypeError>" })]));
    const mixedConditionalForwardArtifacts = nestedVerification.artifacts
      .filter((artifact) => artifact.obligation?.functionName === "mixedConditionalForward");
    expect(mixedConditionalForwardArtifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(mixedConditionalForwardArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.discharged ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Throw<URIError>" })]));
    expect(mixedConditionalForwardArtifacts.flatMap((artifact) => artifact.controlFlow?.exceptionFlow?.escapes ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Reject<TypeError>" })]));
  });
});

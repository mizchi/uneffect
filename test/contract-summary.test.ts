import { describe, expect, it } from "vitest";
import ts from "typescript";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindContractSummaryBundleToProgram, createContractSummaryBundle, validateContractSummaryBundle } from "../src/contract-summary.js";
import { verifyContractObligations } from "../src/contracts.js";

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
      $id: string;
      properties: { schema: { const: string }; exports: { items: { required: string[] } } };
    };
    expect(schema.$id).toBe("https://github.com/mizchi/uneffect/schemas/uneffect-contract-summary-v1.schema.json");
    expect(schema.properties.schema.const).toBe("uneffect-contract-summary/v1");
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

  it("publishes a verified Effect-only export in the shared package envelope", () => {
    const fileName = "/src/report.ts";
    const source = `
      /* uneffect:effect Console */
      export function report(message: string): void { console.log(message) }
      /* uneffect:effect Mutate<typeof target.value> | Throw<RangeError> */
      export function update(target: { value: number }): void {
        target.value += 1
        if (target.value < 0) throw new RangeError("invalid")
      }
      /* uneffect:effect none */
      /* uneffect:effect_parameter callback extends Console */
      export function once(callback: () => void): void { callback() }
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
    })]));
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
});

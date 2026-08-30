import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createContractSummaryBundle, validateContractSummaryBundle } from "../src/contract-summary.js";
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
  it("binds verified exported contracts to package, compiler, source, signature, and artifacts", async () => {
    const fileName = "/src/index.ts";
    const source = `
      /* uneffect:contract requires value >= 0 */
      /* uneffect:contract ensures result === value + 1 */
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
      /* uneffect:contract ensures result === value + 1 */
      export async function addOne(value: number): Promise<number> { return value - 1 }
    `;
    const program = programFor(fileName, source);
    const verification = await verifyContractObligations(fileName, source, undefined, program);

    expect(() => createContractSummaryBundle({
      packageName: "@example/math", packageVersion: "1.2.3", fileName, source, program, artifacts: verification.artifacts,
    })).toThrow(/not fully verified/);
  });
});

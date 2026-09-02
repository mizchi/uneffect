import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { createContractSummaryBundle } from "../src/contract-summary.js";
import ts from "typescript";

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

describe("general resource lifecycle check", () => {
  it("surfaces valid, leaked, and post-release user-defined lifecycles through checkFiles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-check-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle { readonly fd: number }
        /* uneffect:acquire return */
        declare function acquireHandle(): Handle
        /* uneffect:use handle */
        declare function inspectHandle(handle: Handle): void
        /* uneffect:release handle */
        declare function releaseHandle(handle: Handle): void
        export function valid() {
          const handle = acquireHandle()
          inspectHandle(handle)
          releaseHandle(handle)
        }
        export function leaked() { const handle = acquireHandle(); inspectHandle(handle) }
        export function invalid() { const handle = acquireHandle(); releaseHandle(handle); inspectHandle(handle) }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toMatchObject([
        { owner: "valid", status: "satisfied", evidence: "trusted" },
        { owner: "leaked", status: "unsatisfied", evidence: "trusted" },
        { owner: "invalid", status: "unknown", evidence: "trusted" },
      ]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource", kind: "unclosed", functionName: "leaked", severity: "error" }),
        expect.objectContaining({ domain: "resource", kind: "invalid-transition", functionName: "invalid", severity: "error" }),
      ]));
      expect(result.assumptions.entries.filter((entry) => entry.domain === "resource-callable")).toHaveLength(3);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps the lifecycle visible in project verification and assurance", async () => {
    const fileName = "/entry.ts";
    const result = await verifyUneffectProject({ files: { [fileName]: `
      interface Handle {}
      /* uneffect:acquire return */ declare function acquireHandle(): Handle
      /* uneffect:release handle */ declare function releaseHandle(handle: Handle): void
      export function main() { const handle = acquireHandle(); releaseHandle(handle) }
    ` } });
    expect(result.resourceProtocols).toMatchObject([{ owner: "main", status: "satisfied", evidence: "trusted" }]);
    expect(result.assurance).toMatchObject({ status: "assumed", blockers: [] });
    expect(result.assumptions.entries).toMatchObject([{ domain: "resource-callable", owner: "source declaration" }]);
  });

  it("downgrades lifecycle evidence when TypeScript has errors", async () => {
    const fileName = "/invalid.ts";
    const result = await verifyUneffectProject({ files: { [fileName]: `
      interface Handle {}
      /* uneffect:acquire return */ declare function acquireHandle(): Handle
      /* uneffect:release handle */ declare function releaseHandle(handle: Handle): void
      export function main() { const handle = acquireHandle(); releaseHandle(handle); const broken: string = 1 }
    ` } });
    expect(result.resourceProtocols).toMatchObject([{ owner: "main", status: "unknown", evidence: "unknown" }]);
    expect(result.assumptions.entries.filter((entry) => entry.domain === "resource-callable")).toEqual([]);
  });

  it("composes lifecycle contracts distributed in a package summary", async () => {
    const producerFile = "/src/index.ts";
    const producerSource = `
      export interface Handle { readonly fd: number }
      /* uneffect:acquire return */ export function open(): Handle { return { fd: 1 } }
      /* uneffect:use handle */ export function inspect(handle: Handle): void { void handle.fd }
      /* uneffect:release handle */ export function close(handle: Handle): void { void handle.fd }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/handles", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports.map((item) => [item.symbol.export, item.resource?.operations[0]?.kind])).toEqual([
      ["close", "release"], ["inspect", "use"], ["open", "acquire"],
    ]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-package-"));
    try {
      const packageDirectory = join(directory, "node_modules", "@example", "handles");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "@example/handles", version: "1.0.0", types: "index.d.ts" }));
      writeFileSync(join(packageDirectory, "index.d.ts"), `
        export interface Handle { readonly fd: number }
        export declare function open(): Handle
        export declare function inspect(handle: Handle): void
        export declare function close(handle: Handle): void
      `);
      const consumer = join(directory, "consumer.ts");
      writeFileSync(consumer, `
        import { open, inspect, close } from "@example/handles"
        export function main() { const handle = open(); inspect(handle); close(handle) }
      `);
      const result = await checkFiles([consumer], { contractSummaryBundles: [bundle] });
      expect(result.resourceProtocols).toMatchObject([{ owner: "main", status: "satisfied", evidence: "trusted" }]);
      const tampered = {
        ...bundle,
        exports: bundle.exports.map((item) => item.symbol.export === "open"
          ? { ...item, resource: { evidence: "trusted" as const, operations: [{ kind: "release" as const, subject: { kind: "return" as const } }] } }
          : item),
      };
      const rejected = await checkFiles([consumer], { contractSummaryBundles: [tampered] });
      expect(rejected.resourceProtocols).toEqual([]);
      expect(rejected.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "<package-contract>", message: expect.stringContaining("content digest") }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

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

  it("composes using and await using disposal with annotated acquisition", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-using-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle { value: number; [Symbol.dispose](): void }
        interface AsyncHandle { value: number; [Symbol.asyncDispose](): Promise<void> }
        /* uneffect:acquire return */ declare function open(): Handle
        /* uneffect:acquire return */ declare function openAsync(): Promise<AsyncHandle>
        /* uneffect:use handle */ declare function inspect(handle: Handle | AsyncHandle): void
        /* uneffect:release handle */ declare function close(handle: Handle): void
        export function normal() { using handle = open(); inspect(handle) }
        export function early(flag: boolean) { using handle = open(); if (flag) return; inspect(handle) }
        export function nested() { { using handle = open(); inspect(handle) } }
        export async function asynchronous() { await using handle = await openAsync(); inspect(handle) }
        export function caught(flag: boolean) { try { using handle = open(); inspect(handle); if (flag) throw new Error() } catch {} }
        export function throwing() { using handle = open(); throw new Error() }
        export function repeated(values: number[]) { for (const value of values) { using handle = open(); inspect(handle); void value } }
        export function duplicate() { using handle = open(); close(handle) }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "normal", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "early", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "nested", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "asynchronous", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "caught", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "throwing", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "repeated", status: "unknown" }),
        expect.objectContaining({ owner: "duplicate", status: "unknown" }),
      ]));
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource", kind: "invalid-transition", functionName: "duplicate" }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("composes package factory returned-member resource contracts", async () => {
    const producerFile = "/src/client.ts";
    const producerSource = `
      export interface Client { query(): void; close(): void }
      /* uneffect:acquire return */
      export function createClient(): Client {
        return {
          /* uneffect:use this */ query() {},
          /* uneffect:release this */ close() {},
        }
      }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/client", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports[0]?.resource).toMatchObject({
      operations: [{ kind: "acquire" }],
      returnMembers: [{ key: "query", operations: [{ kind: "use", subject: { kind: "receiver" } }] },
        { key: "close", operations: [{ kind: "release", subject: { kind: "receiver" } }] }],
    });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-client-package-"));
    try {
      const packageDirectory = join(directory, "node_modules", "@example", "client");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "@example/client", version: "1.0.0", types: "index.d.ts" }));
      writeFileSync(join(packageDirectory, "index.d.ts"), `
        export interface Client { query(): void; close(): void }
        export declare function createClient(): Client
      `);
      const consumer = join(directory, "consumer.ts");
      writeFileSync(consumer, `
        import { createClient } from "@example/client"
        export function main() { const client = createClient(); const alias = client; alias.query(); alias.close() }
        export function invalid() { const client = createClient(); client.close(); client.query() }
      `);
      const result = await checkFiles([consumer], { contractSummaryBundles: [bundle] });
      expect(result.resourceProtocols).toMatchObject([
        { owner: "main", status: "satisfied" }, { owner: "invalid", status: "unknown" },
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails closed on unaccounted resource references and recognizes direct return escape", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-escape-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle {}
        /* uneffect:acquire return */ declare function open(): Handle
        /* uneffect:release handle */ declare function close(handle: Handle): void
        declare function opaque(handle: Handle): void
        export function unknown() { const handle = open(); opaque(handle); close(handle) }
        export function escaped() { const handle = open(); return handle }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "unknown", status: "unknown", evidence: "unknown" }),
        expect.objectContaining({ owner: "escaped", status: "satisfied", state: "escaped" }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("surfaces catalog-driven WebSocket lifecycles through checkFiles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-builtin-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        declare function opaque(socket: WebSocket): void
        export function valid() { const socket = new WebSocket("wss://example.test"); socket.send("ping"); socket.close() }
        export function leaked() { const socket = new WebSocket("wss://example.test"); socket.send("ping") }
        export function invalid() { const socket = new WebSocket("wss://example.test"); socket.close(); socket.send("late") }
        export function unknown() { const renamed = new WebSocket("wss://example.test"); opaque(renamed); renamed.close() }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "valid", kind: "websocket", status: "satisfied", state: "released", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "leaked", kind: "websocket", status: "unsatisfied" }),
        expect.objectContaining({ owner: "invalid", kind: "websocket", status: "unknown" }),
        expect.objectContaining({ owner: "unknown", kind: "websocket", status: "unknown", evidence: "unknown" }),
      ]));
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource", kind: "unclosed", functionName: "leaked" }),
        expect.objectContaining({ domain: "resource", kind: "invalid-transition", functionName: "invalid" }),
      ]));
      expect(result.assumptions.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "builtin", reason: "reviewed builtin resource lifecycle overlay" }),
      ]));
      expect(result.assumptions.entries.filter((entry) => entry.domain === "resource-callable")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("accepts a using resource acquired only on one conditional branch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-optional-using-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle { [Symbol.dispose](): void }
        /* uneffect:acquire return */ declare function open(): Handle
        export function main(enabled: boolean) {
          if (enabled) { using handle = open() }
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toMatchObject([
        { owner: "main", status: "satisfied", state: "absent-or-released" },
      ]);
      expect(result.diagnostics.filter((diagnostic) => "domain" in diagnostic && diagnostic.domain === "resource")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

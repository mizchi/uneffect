import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkFiles } from "../src/check.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { createContractSummaryBundle } from "../src/contract-summary.js";
import { createResourceCallableContractArtifact } from "../src/resource-callable-artifact.js";
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
  it("discovers and authenticates supplied package resource artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-artifact-check-"));
    try {
      const packageDirectory = join(directory, "node_modules", "reviewed-resource");
      mkdirSync(packageDirectory, { recursive: true });
      const declarationText = `
        export interface Handle { readonly id: number }
        export declare function open(): Handle
        export declare function close(handle: Handle): void
      `;
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "reviewed-resource", version: "1.2.3", types: "index.d.ts",
      }));
      writeFileSync(join(packageDirectory, "index.d.ts"), declarationText);
      const artifact = (name: "open" | "close") => createResourceCallableContractArtifact({
        symbol: { module: "reviewed-resource", export: name },
        runtime: { kind: "package", version: "1.2.3" }, declarationText,
        summary: {
          schema: "uneffect-resource-callable-summary/v1", id: `reviewed-resource#${name}`, evidence: "trusted",
          operations: name === "open" ? [{ kind: "acquire", subject: { kind: "return" } }]
            : [{ kind: "release", subject: { kind: "parameter", index: 0 } }],
        },
        trust: { owner: "security@example.test", reason: "reviewed SDK lifecycle", expiresOn: "2030-01-01" },
      });
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        import { open, close } from "reviewed-resource"
        export function main() { const handle = open(); close(handle) }
      `);
      const result = await checkFiles([entry], {
        resourceCallableArtifacts: [artifact("open"), artifact("close")], resourceArtifactAsOf: "2026-09-03",
      });
      expect(result.resourceProtocols).toMatchObject([{ owner: "main", status: "satisfied", evidence: "trusted" }]);
      expect(result.assumptions.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource-callable", owner: "security@example.test" }),
      ]));
      const project = await verifyUneffectProject({
        files: { [entry]: `
          import { open, close } from "reviewed-resource"
          export function main() { const handle = open(); close(handle) }
        ` },
        resourceCallableArtifacts: [artifact("open"), artifact("close")], resourceArtifactAsOf: "2026-09-03",
      });
      expect(project.resourceProtocols).toMatchObject([{ owner: "main", status: "satisfied", evidence: "trusted" }]);
      expect(project.assumptions.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource-callable", owner: "security@example.test" }),
      ]));
      const wrongVersion = createResourceCallableContractArtifact({
        symbol: { module: "reviewed-resource", export: "open" },
        runtime: { kind: "package", version: "9.9.9" }, declarationText,
        summary: {
          schema: "uneffect-resource-callable-summary/v1", id: "reviewed-resource#open", evidence: "trusted",
          operations: [{ kind: "acquire", subject: { kind: "return" } }],
        },
        trust: { owner: "security@example.test", reason: "wrong package review" },
      });
      const rejected = await checkFiles([entry], {
        resourceCallableArtifacts: [wrongVersion], resourceArtifactAsOf: "2026-09-03",
      });
      expect(rejected.diagnostics).toContainEqual(expect.objectContaining({
        domain: "resource", kind: "invalid-contract", message: expect.stringContaining("runtime version mismatch"),
      }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not treat a short-circuited builtin release as unconditional cleanup", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-conditional-release-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function conditional(stream: ReadableStream<Uint8Array>, enabled: boolean) {
          const reader = stream.getReader()
          enabled && reader.releaseLock()
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toMatchObject([{
        owner: "conditional", status: "unknown", evidence: "trusted",
      }]);
      expect(result.diagnostics).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
        const inspectAlias = inspectHandle
        const releaseAlias = releaseHandle
        const api = Object.freeze({ inspect: inspectHandle, release: releaseHandle })
        const { inspect, release } = api
        const mutableApi = { release: releaseHandle }
        export function valid() {
          const handle = acquireHandle()
          inspectAlias(handle)
          releaseAlias(handle)
        }
        export function validObject() { const handle = acquireHandle(); api.inspect(handle); api.release(handle) }
        export function validDestructured() { const handle = acquireHandle(); inspect(handle); release(handle) }
        export function unknownObject() { const handle = acquireHandle(); mutableApi.release(handle) }
        export function leaked() { const handle = acquireHandle(); inspectHandle(handle) }
        export function invalid() { const handle = acquireHandle(); releaseHandle(handle); inspectHandle(handle) }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toMatchObject([
        { owner: "valid", status: "satisfied", evidence: "trusted" },
        { owner: "validObject", status: "satisfied", evidence: "trusted" },
        { owner: "validDestructured", status: "satisfied", evidence: "trusted" },
        { owner: "unknownObject", status: "unknown", evidence: "unknown" },
        { owner: "leaked", status: "unsatisfied", evidence: "trusted" },
        { owner: "invalid", status: "unknown", evidence: "trusted" },
      ]);
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource", kind: "unclosed", functionName: "leaked", severity: "error" }),
        expect.objectContaining({ domain: "resource", kind: "invalid-transition", functionName: "invalid", severity: "error" }),
      ]));
      expect(result.assumptions.entries.filter((entry) => entry.domain === "resource-callable")).toHaveLength(5);
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
      /* uneffect:acquire return */ export async function openAsync(): Promise<Handle> { return { fd: 2 } }
      /* uneffect:use handle */ export function inspect(handle: Handle): void { void handle.fd }
      /* uneffect:release handle */ export function close(handle: Handle): void { void handle.fd }
    `;
    const producerProgram = programFor(producerFile, producerSource);
    const bundle = createContractSummaryBundle({
      packageName: "@example/handles", packageVersion: "1.0.0", fileName: producerFile,
      source: producerSource, program: producerProgram, artifacts: [],
    });
    expect(bundle.exports.map((item) => [item.symbol.export, item.resource?.operations[0]?.kind])).toEqual([
      ["close", "release"], ["inspect", "use"], ["open", "acquire"], ["openAsync", "acquire"],
    ]);

    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-package-"));
    try {
      const packageDirectory = join(directory, "node_modules", "@example", "handles");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({ name: "@example/handles", version: "1.0.0", types: "index.d.ts" }));
      writeFileSync(join(packageDirectory, "index.d.ts"), `
        export interface Handle { readonly fd: number }
        export declare function open(): Handle
        export declare function openAsync(): Promise<Handle>
        export declare function inspect(handle: Handle): void
        export declare function close(handle: Handle): void
      `);
      const consumer = join(directory, "consumer.ts");
      writeFileSync(consumer, `
        import { open, openAsync, inspect, close } from "@example/handles"
        const observe = inspect
        const shutdown = close
        export function main() { const handle = open(); observe(handle); shutdown(handle) }
        export async function asyncMain() { const pending = openAsync(); const handle = await pending; inspect(handle); close(handle) }
      `);
      const result = await checkFiles([consumer], { contractSummaryBundles: [bundle] });
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "main", status: "satisfied", evidence: "trusted" }),
        expect.objectContaining({ owner: "asyncMain", status: "satisfied", evidence: "trusted", state: "absent-or-released" }),
      ]));
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
        expect.objectContaining({ owner: "asynchronous", status: "satisfied", state: "absent-or-released" }),
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

  it("recognizes ownership escape through a stable local aggregate slot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-aggregate-return-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle { /* uneffect:release this */ close(): void }
        /* uneffect:acquire return */ declare function open(): Handle
        export function objectSlot() { const handle = open(); const holder = { handle }; return holder.handle }
        export function tupleSlot() { const handle = open(); const holder = [handle] as const; return holder[0] }
        export function nestedSlot() { const handle = open(); const holder = { nested: [{ handle }] } as const; return holder.nested[0].handle }
        export function objectDestructured() { const handle = open(); const { handle: alias } = { handle }; return alias }
        export function tupleDestructured() { const handle = open(); const [alias] = [handle] as const; return alias }
        export function nestedDestructured() { const handle = open(); const { nested: [{ handle: alias }] } = { nested: [{ handle }] } as const; return alias }
        export function stableSourceDestructured() { const handle = open(); const holder = { nested: [{ handle }] } as const; const { nested: [{ handle: alias }] } = holder; return alias }
        export function branchAcquired(flag: boolean) { const handle = flag ? open() : open(); return handle }
        export function guardedAcquired(flag: boolean) { const handle = flag && open(); return handle }
        /* uneffect:release handle */ declare function release(handle: Handle): void
        export function aggregateArgument() { const handle = open(); const holder = { nested: [handle] } as const; release(holder.nested[0]) }
        export function aggregateReceiver() { const handle = open(); const holder = { nested: [handle] } as const; holder.nested[0].close() }
        export function mutatedSlot() { const handle = open(); const holder = { handle }; holder.handle = open(); return holder.handle }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "objectSlot", status: "satisfied", state: "escaped" }),
        expect.objectContaining({ owner: "tupleSlot", status: "satisfied", state: "escaped" }),
        expect.objectContaining({ owner: "nestedSlot", status: "satisfied", state: "escaped" }),
        expect.objectContaining({ owner: "objectDestructured", status: "satisfied", state: "escaped" }),
        expect.objectContaining({ owner: "tupleDestructured", status: "satisfied", state: "escaped" }),
        expect.objectContaining({ owner: "nestedDestructured", status: "satisfied", state: "escaped" }),
        expect.objectContaining({ owner: "stableSourceDestructured", status: "satisfied", state: "escaped" }),
        expect.objectContaining({ owner: "branchAcquired", status: "satisfied", state: "absent-or-escaped" }),
        expect.objectContaining({ owner: "guardedAcquired", status: "satisfied", state: "absent-or-escaped" }),
        expect.objectContaining({ owner: "aggregateArgument", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "aggregateReceiver", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "mutatedSlot", status: "unknown", state: "unknown" }),
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

  it("treats resource parameters as borrowed unless this function acquires them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-borrowed-builtin-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export function borrow(socket: WebSocket) { socket.send("ping") }
        export function closeBorrowed(socket: WebSocket) { socket.close() }
        export function invalid(socket: WebSocket) { socket.close(); socket.send("late") }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "borrow", kind: "websocket", status: "satisfied", state: "available" }),
        expect.objectContaining({ owner: "closeBorrowed", kind: "websocket", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "invalid", kind: "websocket", status: "unknown" }),
      ]));
      expect(result.diagnostics).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource", kind: "unclosed", functionName: "borrow" }),
      ]));
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

  it("tracks stream reader use and release through the builtin catalog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-stream-reader-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function readOne(stream: ReadableStream<Uint8Array>) {
          const renamed = stream.getReader()
          try { await renamed.read() } finally { renamed.releaseLock() }
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toMatchObject([
        { owner: "readOne", kind: "stream-reader", status: "satisfied", state: "released", authority: "builtin-catalog" },
      ]);
      expect(result.diagnostics.filter((diagnostic) => "domain" in diagnostic && diagnostic.domain === "resource")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("tracks stream writer and inherited reader operations through catalog primitives", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-stream-operations-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function unsafeWrite(stream: WritableStream<Uint8Array>, chunk: Uint8Array) {
          const writer = stream.getWriter()
          await writer.write(chunk)
          writer.releaseLock()
        }
        export async function safeWrite(stream: WritableStream<Uint8Array>, chunk: Uint8Array) {
          const writer = stream.getWriter()
          try { await writer.write(chunk) } finally { writer.releaseLock() }
        }
        export async function safeCancel(stream: ReadableStream<Uint8Array>) {
          const reader = stream.getReader()
          try { await reader.cancel("done") } finally { reader.releaseLock() }
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "unsafeWrite", kind: "stream-writer", status: "unknown", state: "unknown" }),
        expect.objectContaining({ owner: "safeWrite", kind: "stream-writer", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "safeCancel", kind: "stream-reader", status: "satisfied", state: "released" }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not create an awaited acquired resource on the rejection edge", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-async-acquire-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        interface Handle {}
        /* uneffect:acquire return */ declare function open(): Promise<Handle>
        /* uneffect:release handle */ declare function close(handle: Handle): void
        export async function main() {
          const handle = await open()
          close(handle)
        }
        export async function aliased() {
          const pending = open()
          const renamed = await pending
          close(renamed)
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "main", status: "satisfied", state: "absent-or-released" }),
        expect.objectContaining({ owner: "aliased", status: "satisfied", state: "absent-or-released" }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("tracks Node server lifecycle through catalog receiver operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-node-server-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        import { createServer } from "node:net"
        export function main() {
          const renamed = createServer()
          renamed.listen(0, "127.0.0.1")
          renamed.close()
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toMatchObject([
        { owner: "main", kind: "server", status: "satisfied", state: "released", authority: "builtin-catalog" },
      ]);
      expect(result.diagnostics.filter((diagnostic) => "domain" in diagnostic && diagnostic.domain === "resource")).toEqual([]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("tracks Node FSWatcher use and close through catalog receiver operations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-node-watcher-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        import { watch } from "node:fs"
        export function valid(path: string) {
          const renamed = watch(path, () => undefined)
          renamed.unref()
          renamed.close()
        }
        export function leaked(path: string) {
          const watcher = watch(path, () => undefined)
          watcher.ref()
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "valid", kind: "watcher", status: "satisfied", state: "released" }),
        expect.objectContaining({ owner: "leaked", kind: "watcher", status: "unsatisfied", state: "available" }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("tracks fulfilled FileHandle acquisition and finally-based close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-file-handle-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        import { open } from "node:fs/promises"
        export async function unsafe(path: string) {
          const handle = await open(path, "r")
          await handle.readFile()
          await handle.close()
        }
        export async function safe(path: string) {
          const renamed = await open(path, "r")
          try { await renamed.readFile() } finally { await renamed.close() }
        }
        export function floating(path: string) {
          const pending = open(path, "r")
          void pending
        }
        export async function aliased(path: string) {
          const pending = open(path, "r")
          const handle = await pending
          try { await handle.readFile() } finally { await handle.close() }
        }
      `);
      const result = await checkFiles([fileName]);
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "unsafe", kind: "file-handle", status: "unknown", state: "unknown" }),
        expect.objectContaining({ owner: "safe", kind: "file-handle", status: "satisfied", state: "absent-or-released" }),
        expect.objectContaining({ owner: "aliased", kind: "file-handle", status: "satisfied", state: "absent-or-released" }),
      ]));
      expect(result.summaries.find((summary) => summary.functionName === "safe")?.effects).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "capability", name: "FsRead" }),
      ]));
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "resource", kind: "unknown-analysis", functionName: "floating",
          message: expect.stringContaining("Promise-to-resource binding is not stable") }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

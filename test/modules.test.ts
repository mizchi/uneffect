import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtinContractRegistry, findBuiltinContract } from "../src/builtin-contracts.js";
import { effectSchema, parseEffectExpression } from "../src/capabilities.js";
import { installUneffectModules, parseUneffectModuleManifest } from "../src/modules.js";
import { createEvidenceArtifact, validateEvidenceArtifact } from "../src/evidence.js";
import { checkFiles, createCheckProgram } from "../src/check.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { analyzeHostNeutralTransitions } from "../src/host-neutral-transitions.js";
import { analyzeCallableSummaries } from "../src/callable-summary.js";
import ts from "typescript";

const auditModule = {
  $schema: "./node_modules/@mizchi/uneffect/schemas/uneffect-module-v1.schema.json",
  schema: "uneffect-module/v1",
  name: "@acme/audit-semantics",
  version: "1.2.0",
  namespace: "Acme.Audit",
  evidence: "trusted",
  trustOwner: "security-platform",
  trustReason: "reviewed against @acme/audit 4.1.0",
  effectSchemas: [{ name: "Acme.Audit.Emit", version: 1, arguments: ["literal"] }],
  registry: {
    schema: "uneffect-registry/v1",
    builtinRegistryVersion: 2,
    contracts: [{
      symbol: { module: "@acme/audit", export: "emit" },
      runtime: { kind: "package", version: "4.1.0" },
      evidence: "trusted",
      trustOwner: "security-platform",
      trustReason: "reviewed emit boundary",
      semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "effect", capability: "Acme.Audit.Emit", scope: { kind: "value", target: { kind: "argument", index: 0 } } }] },
    }],
  },
} as const;

describe("declarative Uneffect modules", () => {
  it("publishes a versioned manifest schema", () => {
    const schema = JSON.parse(readFileSync("schemas/uneffect-module-v1.schema.json", "utf8")) as any;
    expect(schema.properties.schema.const).toBe("uneffect-module/v1");
    expect(schema.properties.evidence.const).toBe("trusted");
  });

  it("publishes every lifecycle primitive accepted by module manifests", () => {
    const schema = JSON.parse(readFileSync("schemas/uneffect-registry-v1.schema.json", "utf8")) as any;
    const lifecycle = schema.$defs.semanticPrimitive.oneOf.find((item: any) =>
      item.properties?.kind?.enum?.includes("acquire"));
    expect(lifecycle.properties.kind.enum).toEqual(["acquire", "use", "release"]);
    expect(lifecycle.properties.completion.enum).toEqual(["call", "fulfillment"]);
  });

  it("installs namespaced schemas and reviewed contracts with a digest ledger", () => {
    const installed = installUneffectModules([auditModule], builtinContractRegistry);
    expect(effectSchema("Acme.Audit.Emit")).toEqual({ name: "Acme.Audit.Emit", version: 1, arguments: ["literal"] });
    expect(parseEffectExpression('Acme.Audit.Emit<"login">')).toMatchObject({ name: "Acme.Audit.Emit" });
    expect(findBuiltinContract(installed.registry, { module: "@acme/audit", export: "emit" })?.semantics?.primitives)
      .toMatchObject([{ kind: "effect", capability: "Acme.Audit.Emit" }]);
    expect(installed.ledger).toEqual([expect.objectContaining({
      name: "@acme/audit-semantics", version: "1.2.0", namespace: "Acme.Audit", evidence: "trusted",
      digest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })]);
    const fileName = "/virtual/module-ledger.ts", source = ts.createSourceFile(fileName, "export const x = 1", ts.ScriptTarget.Latest, true);
    const host = ts.createCompilerHost({});
    host.getSourceFile = (name) => name === fileName ? source : undefined;
    host.fileExists = (name) => name === fileName;
    host.readFile = (name) => name === fileName ? source.text : undefined;
    const program = ts.createProgram([fileName], {}, host);
    const artifact = createEvidenceArtifact(program, source, [], installed.registry);
    expect(artifact.modules).toEqual(installed.ledger);
    expect(validateEvidenceArtifact(program, source, [], { ...artifact, modules: [] }, installed.registry).reasons)
      .toContain("module-ledger-mismatch");
  });

  it.each([
    [{ ...auditModule, evidence: "verified" }, "evidence must be trusted"],
    [{ ...auditModule, effectSchemas: [{ name: "Other.Emit", version: 1, arguments: [] }] }, "must start with namespace"],
    [{ ...auditModule, ignored: true }, "unknown key"],
  ])("fails closed for unsafe module manifests %#", (input, message) => {
    expect(() => parseUneffectModuleManifest(input)).toThrow(message);
  });

  it("rejects two modules that claim the same semantic identity", () => {
    expect(() => installUneffectModules([auditModule, auditModule], builtinContractRegistry)).toThrow(/duplicate module/);
  });

  it("rolls back effect schemas when a contract fails validation", () => {
    const broken = {
      ...auditModule,
      name: "@acme/broken-semantics",
      namespace: "Acme.Broken",
      effectSchemas: [{ name: "Acme.Broken.Emit", version: 1, arguments: [] }],
      registry: { ...auditModule.registry, ignored: true },
    };
    expect(() => installUneffectModules([broken], builtinContractRegistry)).toThrow(/unknown key/);
    expect(effectSchema("Acme.Broken.Emit")).toBeUndefined();
  });

  it("connects module acquire/use/release primitives to lifecycle checking", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-resource-"));
    try {
      const packageDirectory = join(directory, "node_modules", "reviewed-handle");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), JSON.stringify({
        name: "reviewed-handle", version: "1.0.0", types: "index.d.ts",
      }));
      writeFileSync(join(packageDirectory, "index.d.ts"), `
        export interface Handle { readonly id: number; inspect(): void; close(): void }
        export interface Scheduler { schedule(callback: () => void): void }
        export declare function open(): Handle
        export declare function openAsync(): Promise<Handle>
        export declare function inspect(handle: Handle): void
        export declare function close(handle: Handle): void
        export declare function closeAsync(handle: Handle): Promise<void>
        export declare function schedule(callback: () => void): void
        export declare function risky(): void
        export declare function riskyWhen(flag: boolean): void
        export declare function riskyAsync(): Promise<void>
        export declare function createScheduler(): Scheduler
        export declare function send(transfer: ArrayBuffer[]): void
      `);
      const module = {
        ...auditModule,
        name: "@acme/handle-semantics",
        namespace: "Acme.Handle",
        effectSchemas: [],
        trustReason: "reviewed handle lifecycle",
        registry: {
          schema: "uneffect-registry/v1",
          builtinRegistryVersion: 2,
          contracts: [
            { symbol: { module: "reviewed-handle", export: "open" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed acquisition", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "acquire", resource: "Acme.Handle", target: { kind: "result" } }] } },
            { symbol: { module: "reviewed-handle", export: "inspect" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed use", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "use", resource: "Acme.Handle", target: { kind: "argument", index: 0 } }] } },
            { symbol: { module: "reviewed-handle", export: "close" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed release", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "release", resource: "Acme.Handle", target: { kind: "argument", index: 0 } }] } },
            { symbol: { module: "reviewed-handle", export: "openAsync" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed async acquisition", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "acquire", resource: "Acme.Handle", target: { kind: "result" }, completion: "fulfillment" }] } },
            { symbol: { module: "reviewed-handle", export: "closeAsync" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed async release", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "release", resource: "Acme.Handle", target: { kind: "argument", index: 0 }, completion: "fulfillment" }] } },
            { symbol: { module: "reviewed-handle", export: "schedule" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed callback scheduling", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue: "external", cardinality: "0..1", completion: "host-report-throw" }] } },
            { symbol: { module: "reviewed-handle", export: "risky" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed synchronous failure", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "Error" }] } },
            { symbol: { module: "reviewed-handle", export: "riskyWhen" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed conditional failure", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "throw", error: "Error", condition: "flag" }] } },
            { symbol: { module: "reviewed-handle", export: "riskyAsync" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed Promise rejection", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "reject", error: "RangeError" }] } },
            { symbol: { module: "reviewed-handle", export: "Handle#inspect" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed receiver use", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "use", resource: "Acme.Handle", target: { kind: "receiver" } }] } },
            { symbol: { module: "reviewed-handle", export: "Handle#close" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed receiver release", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "release", resource: "Acme.Handle", target: { kind: "receiver" } }] } },
            { symbol: { module: "reviewed-handle", export: "Scheduler#schedule" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed member callback", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "callback", target: { kind: "argument", index: 0 }, timing: "deferred", queue: "external", cardinality: "0..1", completion: "host-report-throw" }] } },
            { symbol: { module: "reviewed-handle", export: "send" }, runtime: { kind: "package", version: "1.0.0" }, evidence: "trusted", trustOwner: "security-platform", trustReason: "reviewed ownership transfer", semantics: { schema: "uneffect-semantic-primitives/v1", primitives: [{ kind: "transfer", target: { kind: "argument", index: 0 } }] } },
          ],
        },
      } as const;
      const installed = installUneffectModules([module], builtinContractRegistry);
      const facade = join(directory, "facade.ts");
      writeFileSync(facade, `export { schedule as later } from "reviewed-handle"`);
      const entry = join(directory, "entry.ts");
      writeFileSync(entry, `
        import { open, openAsync, inspect, close, closeAsync, schedule, risky, riskyWhen, riskyAsync, createScheduler, send } from "reviewed-handle"
        const scheduleAlias = schedule
        const aliasedCallback = () => {}
        export function valid() { const handle = open(); inspect(handle); close(handle) }
        export function leaked() { const handle = open(); inspect(handle) }
        export async function asyncValid() { const handle = await openAsync(); inspect(handle); await closeAsync(handle) }
        export function scheduled() { schedule(() => {}) }
        export function aliasScheduled() { scheduleAlias(aliasedCallback) }
        export function memberValid() { const handle = open(); const alias = handle; alias.inspect(); alias.close() }
        export function extractedReceiver() { const handle = open(); const shutdown = handle.close; shutdown() }
        export function memberScheduled() { const scheduler = createScheduler(); scheduler.schedule(aliasedCallback) }
        export function transferred() { const buffer = new ArrayBuffer(8); send([buffer]); return new DataView(buffer) }
        export function exceptional() {
          const handle = open()
          try { risky(); close(handle) }
          catch { close(handle); close(handle) }
        }
        export function conservativeCondition() {
          const handle = open()
          try { riskyWhen(false); close(handle) }
          catch { close(handle); close(handle) }
        }
        export async function rejectionCleanup() {
          const handle = open()
          try { await riskyAsync(); close(handle) }
          catch { close(handle); close(handle) }
        }
        export function returnsRisky() { return riskyAsync() }
        export async function awaitsRisky() { await riskyAsync() }
        export async function catchesRisky() { try { await riskyAsync() } catch {} }
        export async function rethrowsRisky() { try { await riskyAsync() } catch (error) { throw error } }
        export function floatsRisky() { void riskyAsync() }
      `);
      const result = await checkFiles([entry], { builtinRegistry: installed.registry });
      expect(result.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "valid", status: "satisfied", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "leaked", status: "unsatisfied", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "asyncValid", status: "satisfied", authority: "builtin-catalog", state: "absent-or-released" }),
        expect.objectContaining({ owner: "exceptional", status: "unknown", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "conservativeCondition", status: "unknown", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "rejectionCleanup", status: "unknown", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "memberValid", status: "satisfied", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "extractedReceiver", status: "unknown", authority: "builtin-catalog" }),
      ]));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        domain: "resource", kind: "invalid-transition", functionName: "exceptional",
      }));
      expect(result.ownership).toContainEqual(expect.objectContaining({
        operation: "read", resource: "buffer", state: "detached",
      }));
      expect(result.assumptions.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ domain: "builtin", owner: "security-platform", reason: "reviewed acquisition" }),
      ]));
      expect(result.assumptions.entries).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: expect.stringContaining("builtin-resource:"), owner: "@mizchi/uneffect" }),
      ]));
      const project = await verifyUneffectProject({
        files: { [entry]: readFileSync(entry, "utf8") }, builtinRegistry: installed.registry,
      });
      expect(project.resourceProtocols).toEqual(expect.arrayContaining([
        expect.objectContaining({ owner: "valid", status: "satisfied", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "leaked", status: "unsatisfied", authority: "builtin-catalog" }),
        expect.objectContaining({ owner: "asyncValid", status: "satisfied", authority: "builtin-catalog", state: "absent-or-released" }),
      ]));
      expect(project.ownership.diagnostics).toContainEqual(expect.objectContaining({
        operation: "read", resource: "buffer", state: "detached",
      }));
      const program = createCheckProgram([entry]);
      const source = program.getSourceFile(entry)!;
      const temporal = analyzeHostNeutralTransitions(program, source, { builtinRegistry: installed.registry });
      const callable = analyzeCallableSummaries(program, undefined, installed.registry);
      expect(callable.summaries.find((summary) => summary.name === "returnsRisky")?.rejects).toEqual(["RangeError"]);
      expect(callable.summaries.find((summary) => summary.name === "awaitsRisky")?.rejects).toEqual(["RangeError"]);
      expect(callable.summaries.find((summary) => summary.name === "catchesRisky")?.rejects).toEqual([]);
      expect(callable.summaries.find((summary) => summary.name === "rethrowsRisky")?.rejects).toEqual(["RangeError"]);
      expect(callable.summaries.find((summary) => summary.name === "floatsRisky")?.rejects).toEqual([]);
      expect(temporal.transitions).toContainEqual(expect.objectContaining({
        kind: "invoke-callback", callback: "() => {}", api: "schedule",
        cardinality: "0..1", lane: "external", completion: "host-report-throw",
      }));
      expect(temporal.transitions).toContainEqual(expect.objectContaining({
        kind: "invoke-callback", callback: "aliasedCallback", api: "Scheduler#schedule",
        cardinality: "0..1", lane: "external", completion: "host-report-throw",
      }));
      expect(temporal.transitions).toContainEqual(expect.objectContaining({
        kind: "invoke-callback", callback: "aliasedCallback", api: "schedule",
        cardinality: "0..1", lane: "external", completion: "host-report-throw",
      }));
      const barrelEntry = join(directory, "barrel-entry.ts");
      writeFileSync(barrelEntry, `
        import { later } from "./facade.js"
        export function barrelScheduled() { later(() => {}) }
      `);
      const barrelProgram = createCheckProgram([barrelEntry]);
      const barrelSource = barrelProgram.getSourceFile(barrelEntry)!;
      const barrelTemporal = analyzeHostNeutralTransitions(barrelProgram, barrelSource, { builtinRegistry: installed.registry });
      expect(barrelTemporal.transitions).toContainEqual(expect.objectContaining({
        kind: "invoke-callback", callback: "() => {}", api: "schedule",
        cardinality: "0..1", lane: "external", completion: "host-report-throw",
      }));
      const mutableEntry = join(directory, "mutable-entry.ts");
      writeFileSync(mutableEntry, `
        import { later } from "./facade.js"
        let selected = later
        selected = callback => callback()
        export function mutableAlias() { selected(() => {}) }
        export function sameSpelled() {
          const schedule = (callback: () => void) => callback()
          schedule(() => {})
        }
      `);
      const mutableProgram = createCheckProgram([mutableEntry]);
      const mutableSource = mutableProgram.getSourceFile(mutableEntry)!;
      const mutableTemporal = analyzeHostNeutralTransitions(mutableProgram, mutableSource, { builtinRegistry: installed.registry });
      expect(mutableTemporal.transitions.filter((transition) => transition.kind === "invoke-callback"
        && transition.lane === "external")).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

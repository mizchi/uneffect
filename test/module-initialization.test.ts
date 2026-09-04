import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { analyzeModuleInitializationOrder } from "../src/module-initialization.js";

function program(files: Readonly<Record<string, string>>): ts.Program {
  for (const [fileName, source] of Object.entries(files)) writeFileSync(fileName, source);
  return ts.createProgram(Object.keys(files), {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
    types: ["node"],
    noEmit: true,
  });
}

describe("ESM module initialization order IR", () => {
  it("orders side-effect dependencies before an acyclic importer body", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-order-"));
    try {
      const leaf = join(directory, "leaf.mts"), middle = join(directory, "middle.mts"), entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({
        [leaf]: 'console.log("leaf")',
        [middle]: 'import "./leaf.mjs"; console.log("middle")',
        [entry]: 'import "./middle.mjs"; console.log("entry")',
      }), entry);

      expect(result).toMatchObject({
        schema: "uneffect-module-order/v1",
        schemaVersion: 1,
        entryFile: entry,
        evidence: "verified",
        unknowns: [],
      });
      expect(result.modules.map((item) => item.fileName)).toEqual([leaf, middle, entry]);
      expect(result.constraints).toEqual(expect.arrayContaining([
        expect.objectContaining({ before: `${leaf}#complete`, after: `${middle}#start`, reason: "static-dependency-completes" }),
        expect.objectContaining({ before: `${middle}#complete`, after: `${entry}#start`, reason: "static-dependency-completes" }),
      ]));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("models straight-line top-level await as resume-or-reject before importer execution", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-tla-"));
    try {
      const dependency = join(directory, "dependency.mts"), entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({
        [dependency]: 'export const value = await Promise.resolve(1); console.log(value)',
        [entry]: 'import { value } from "./dependency.mjs"; console.log(value)',
      }), entry);
      const module = result.modules.find((item) => item.fileName === dependency)!;

      expect(result.evidence).toBe("verified");
      expect(module.events.map((event) => event.kind)).toEqual(["start", "suspend", "resume", "reject", "complete"]);
      expect(module.choices).toEqual([{
        after: `${dependency}#suspend:0`,
        alternatives: [`${dependency}#resume:0`, `${dependency}#reject:0`],
        reason: "await-settlement",
      }]);
      expect(result.constraints).toContainEqual(expect.objectContaining({
        before: `${dependency}#complete`, after: `${entry}#start`, reason: "static-dependency-completes",
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("models a Workhub-shaped top-level Promise launch and synchronous catch attachment", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-main-catch-"));
    try {
      const entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({
        [entry]: `
          async function main(): Promise<void> { await Promise.resolve() }
          main().catch((error) => { console.error(error) })
        `,
      }), entry);
      const module = result.modules[0]!;

      expect(result.evidence).toBe("verified");
      expect(result.unknowns).toEqual([]);
      expect(module.events.map((event) => event.kind)).toEqual([
        "start", "promise-launch", "rejection-handler-attach", "complete",
      ]);
      expect(module.events.some((event) => event.kind === "suspend")).toBe(false);
      expect(result.constraints).toEqual(expect.arrayContaining([
        expect.objectContaining({
          before: `${entry}#start`, after: `${entry}#promise-launch:0`,
          reason: "module-sequencing", semanticRule: "source-order",
        }),
        expect.objectContaining({
          before: `${entry}#promise-launch:0`, after: `${entry}#rejection-handler-attach:0`,
          reason: "module-sequencing", semanticRule: "source-order",
        }),
        expect.objectContaining({
          before: `${entry}#rejection-handler-attach:0`, after: `${entry}#complete`,
          reason: "module-sequencing", semanticRule: "source-order",
        }),
      ]));
      expect(result.claims).toContain("a supported top-level Promise rejection handler is attached synchronously before module completion");
      expect(JSON.parse(readFileSync("schemas/uneffect-module-order-v1.schema.json", "utf8"))).toMatchObject({
        $defs: { event: { properties: { kind: { enum: expect.arrayContaining(["promise-launch", "rejection-handler-attach"]) } } } },
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps an unhandled or unsupported top-level Promise launch non-proof-grade", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-main-unhandled-"));
    try {
      const unhandledFile = join(directory, "unhandled.mts");
      const unhandled = analyzeModuleInitializationOrder(program({
        [unhandledFile]: `async function main(): Promise<void> {}
          main()`,
      }), unhandledFile);
      expect(unhandled.evidence).toBe("unknown");
      expect(unhandled.unknowns).toContainEqual(expect.objectContaining({
        kind: "unhandled-top-level-promise-launch",
      }));

      const unsupportedFile = join(directory, "unsupported.mts");
      const unsupported = analyzeModuleInitializationOrder(program({
        [unsupportedFile]: `
          const runner = { async main(): Promise<void> {} }
          runner.main().catch(() => {})
        `,
      }), unsupportedFile);
      expect(unsupported.evidence).toBe("unknown");
      expect(unsupported.unknowns).toContainEqual(expect.objectContaining({
        kind: "unsupported-top-level-promise-handler",
      }));

      const mixedFile = join(directory, "mixed.mts");
      const mixed = analyzeModuleInitializationOrder(program({
        [mixedFile]: `async function main(): Promise<void> {}
          await Promise.resolve()
          main().catch(() => {})`,
      }), mixedFile);
      expect(mixed.evidence).toBe("unknown");
      expect(mixed.unknowns).toContainEqual(expect.objectContaining({
        kind: "unsupported-mixed-top-level-async-shape",
      }));

      const shadowedFile = join(directory, "shadowed.mts");
      const shadowed = analyzeModuleInitializationOrder(program({
        [shadowedFile]: `
          async function main(): Promise<void> {}
          const launched = main() as Promise<void> & { catch(handler: () => void): void }
          launched.catch(() => {})
        `,
      }), shadowedFile);
      expect(shadowed.evidence).toBe("unknown");
      expect(shadowed.unknowns).toContainEqual(expect.objectContaining({
        kind: "unsupported-top-level-promise-handler",
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("models an unconditional synchronous throw as terminal and blocks completion", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-throw-"));
    try {
      const dependency = join(directory, "dependency.mts"), entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({
        [dependency]: 'console.log("before"); throw new Error("stop")',
        [entry]: 'import "./dependency.mjs"; console.log("unreachable")',
      }), entry);
      const module = result.modules.find((item) => item.fileName === dependency)!;

      expect(result.evidence).toBe("verified");
      expect(module.events.map((event) => event.kind)).toEqual(["start", "throw"]);
      expect(module.events.some((event) => event.kind === "complete")).toBe(false);
      expect(result.constraints.some((edge) => edge.after === `${entry}#start`)).toBe(false);
      expect(result.modules.find((item) => item.fileName === entry)?.blockedBy).toEqual([dependency]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("orders a synchronous side-effect-only ESM ring by specification DFS execution", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-sync-cycle-"));
    try {
      const left = join(directory, "left.mts"), right = join(directory, "right.mts");
      const result = analyzeModuleInitializationOrder(program({
        [left]: 'import "./right.mjs"; console.log("left")',
        [right]: 'import "./left.mjs"; console.log("right")',
      }), left);

      expect(result.evidence).toBe("verified");
      expect(result.unknowns).toEqual([]);
      expect(result.compiler).toMatchObject({
        typescriptVersion: ts.version,
        compilerOptionsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(result.cycleComponents).toEqual([{
        id: `cycle:${left}`,
        kind: "synchronous-side-effect-import-ring",
        root: left,
        modules: [left, right],
        executionOrder: [right, left],
        requests: [
          expect.objectContaining({ from: left, to: right, semanticRule: "ecma262-inner-module-evaluation-request" }),
          expect.objectContaining({ from: right, to: left, semanticRule: "ecma262-inner-module-evaluation-revisit" }),
        ],
      }]);
      expect(result.constraints).toContainEqual(expect.objectContaining({
        before: `${right}#complete`, after: `${left}#start`,
        reason: "synchronous-cycle-dfs-execution",
        sourceFile: left,
        semanticRule: "ecma262-inner-module-evaluation-execute",
      }));
      expect(result.constraints.every((constraint) =>
        constraint.evidence.kind === "program-source"
        && /^[0-9a-f]{64}$/.test(constraint.evidence.sourceDigest))).toBe(true);
      expect(JSON.parse(readFileSync("schemas/uneffect-module-order-v1.schema.json", "utf8"))).toMatchObject({
        properties: {
          schema: { const: "uneffect-module-order/v1" },
          cycleComponents: { items: { $ref: "#/$defs/cycleComponent" } },
        },
        $defs: {
          constraint: { required: expect.arrayContaining(["sourceFile", "sourceSpan", "semanticRule", "evidence"]) },
          sourceEvidence: { properties: { sourceDigest: { $ref: "#/$defs/sha256" } } },
        },
      });
      expect(result.exclusions).toContain("only synchronous side-effect-import simple rings have proof-grade cyclic order");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps binding and asynchronous ESM cycles non-proof-grade", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-unsafe-cycle-"));
    try {
      const namedLeft = join(directory, "named-left.mts"), namedRight = join(directory, "named-right.mts");
      const named = analyzeModuleInitializationOrder(program({
        [namedLeft]: 'import { right } from "./named-right.mjs"; export const left = right + 1',
        [namedRight]: 'import { left } from "./named-left.mjs"; export const right = left + 1',
      }), namedLeft);
      expect(named.evidence).toBe("unknown");
      expect(named.cycleComponents).toEqual([]);
      expect(named.unknowns).toContainEqual(expect.objectContaining({
        kind: "cycle", detail: expect.stringContaining("runtime bindings"),
      }));

      const asyncLeft = join(directory, "async-left.mts"), asyncRight = join(directory, "async-right.mts");
      const asynchronous = analyzeModuleInitializationOrder(program({
        [asyncLeft]: 'import "./async-right.mjs"; await Promise.resolve(); console.log("left")',
        [asyncRight]: 'import "./async-left.mjs"; console.log("right")',
      }), asyncLeft);
      expect(asynchronous.evidence).toBe("unknown");
      expect(asynchronous.cycleComponents).toEqual([]);
      expect(asynchronous.unknowns).toContainEqual(expect.objectContaining({
        kind: "cycle", detail: expect.stringContaining("top-level await"),
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps cycles, conditional TLA, dynamic imports, and external initialization non-proof-grade", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-unknown-order-"));
    try {
      const left = join(directory, "left.mts"), right = join(directory, "right.mts"), entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({
        [left]: 'import { right } from "./right.mjs"; export const left: number = right + 1',
        [right]: 'import { left } from "./left.mjs"; export const right: number = left + 1',
        [entry]: `
          import "./left.mjs"
          import "node:path"
          declare const enabled: boolean
          if (enabled) await Promise.resolve()
          if (enabled) throw new Error("conditional")
          @sealed class Service { static value = console.log("init") }
          void import(enabled ? "./left.mjs" : "./right.mjs")
        `,
      }), entry);

      expect(result.evidence).toBe("unknown");
      expect(result.unknowns.map((item) => item.kind)).toEqual(expect.arrayContaining([
        "cycle", "external-static-import", "conditional-top-level-await", "conditional-top-level-throw",
        "class-initialization-order", "dynamic-import",
      ]));
      expect(result.modules.length).toBe(3);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("distinguishes always-evaluated control conditions from conditional branches", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-condition-await-"));
    try {
      const entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({
        [entry]: `
          export {}
          if (await Promise.resolve(true)) console.log("ready")
          for (let value = await Promise.resolve(0); value < 0; value++) {}
        `,
      }), entry);
      expect(result.unknowns).not.toContainEqual(expect.objectContaining({ kind: "conditional-top-level-await" }));
      expect(result.modules[0]?.events.filter((event) => event.kind === "suspend")).toHaveLength(2);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("never verifies an order extracted from ill-typed source", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-invalid-order-"));
    try {
      const entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({ [entry]: 'export const value: number = "wrong"' }), entry);
      expect(result.evidence).toBe("unknown");
      expect(result.unknowns).toContainEqual(expect.objectContaining({ fileName: entry, kind: "typescript-error" }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
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
        { before: `${leaf}#complete`, after: `${middle}#start`, reason: "static-dependency-completes" },
        { before: `${middle}#complete`, after: `${entry}#start`, reason: "static-dependency-completes" },
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
      expect(result.constraints).toContainEqual({
        before: `${dependency}#complete`, after: `${entry}#start`, reason: "static-dependency-completes",
      });
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

  it("keeps cycles, conditional TLA, dynamic imports, and external initialization non-proof-grade", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-module-unknown-order-"));
    try {
      const left = join(directory, "left.mts"), right = join(directory, "right.mts"), entry = join(directory, "entry.mts");
      const result = analyzeModuleInitializationOrder(program({
        [left]: 'import "./right.mjs"; export const left = 1',
        [right]: 'import "./left.mjs"; export const right = 1',
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

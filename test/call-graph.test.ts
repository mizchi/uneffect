import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { buildProgramCallGraph, instantiateCallbackEffects } from "../src/call-graph.js";
import { analyzeProgramEffects } from "../src/effects.js";
import { parseEffectExpression } from "../src/capabilities.js";

describe("multi-file call graph and effect polymorphism", () => {
  it("resolves aliases, re-exports, methods, arrows, overloads, and callbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-graph-"));
    const a = join(directory, "a.ts"), barrel = join(directory, "barrel.ts"), b = join(directory, "b.ts");
    writeFileSync(a, `
      export function overloaded(x: string): string
      export function overloaded(x: number): number
      export function overloaded(x: string | number) { return x }
      export class Service { run() {} }
      export const arrow = () => overloaded(1)
      export function inline(cb: () => void) { cb() }
      export function deferred(cb: () => void) { setTimeout(cb, 0) }
    `);
    writeFileSync(barrel, `export { overloaded, Service, arrow, inline, deferred } from "./a.js"`);
    writeFileSync(b, `import { overloaded as pick, Service, arrow, inline, deferred } from "./barrel.js"; function main() { pick("x"); new Service().run(); arrow(); inline(() => {}); deferred(() => {}) }`);
    const program = ts.createProgram([a, barrel, b], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext });
    const graph = buildProgramCallGraph(program);
    expect(graph.nodes.map((node) => node.kind)).toEqual(expect.arrayContaining(["function", "method", "arrow"]));
    expect(graph.edges.filter((edge) => edge.callee).length).toBeGreaterThanOrEqual(5);
    expect(graph.edges).toContainEqual(expect.objectContaining({ overloadIndex: 0 }));
    expect(graph.nodes.find((node) => node.name === "inline")?.effectParameters).toContainEqual(expect.objectContaining({ timing: "inline" }));
    expect(graph.nodes.find((node) => node.name === "deferred")?.effectParameters).toContainEqual(expect.objectContaining({ timing: "deferred" }));
  });

  it("instantiates callback effects and preserves invocation timing", () => {
    const node = { id: "f", name: "later", kind: "function" as const, fileName: "f.ts", span: { start: 0, end: 1 }, overloads: [], effectParameters: [{ index: 0, name: "cb", timing: "deferred" as const }] };
    const result = instantiateCallbackEffects(node, new Map([[0, [parseEffectExpression("Console")]]]));
    expect(result).toMatchObject({ evidence: "inferred", suspends: true });
    expect(result.effects).toHaveLength(1);
  });

  it("propagates effects across files, re-exports, methods, overloads, arrows, and callback arguments", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-program-effects-"));
    const library = join(directory, "library.ts"), barrel = join(directory, "index.ts"), main = join(directory, "main.ts");
    writeFileSync(library, `
      /* uneffect: effect Console */
      export function pick(x: string): string
      export function pick(x: number): number
      export function pick(x: string | number) { console.log(x); return x }
      export class Service { /* uneffect: effect Console */ run() { console.log("run") } }
      /* uneffect: effect Console */ export const arrow = () => console.log("arrow")
      export function invoke(cb: () => void) { cb() }
    `);
    writeFileSync(barrel, `export { pick, Service, arrow, invoke } from "./library.js"`);
    writeFileSync(main, `
      import { pick as choose, Service, arrow, invoke } from "./index.js"
      /* uneffect: effect Console */
      function main() { choose("x"); new Service().run(); arrow(); invoke(() => console.log("callback")) }
    `);
    const program = ts.createProgram([library, barrel, main], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const result = analyzeProgramEffects(program);
    expect(result.diagnostics.filter((item) => item.functionName === "main")).toEqual([]);
    expect(result.summaries.find((item) => item.functionName === "main")?.effects.map((effect) => effect.kind === "capability" ? effect.name : effect.kind)).toContain("Console");
  });

  it("classifies Array.from mapping as synchronous inline invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-array-from-"));
    const source = join(directory, "array.ts");
    writeFileSync(source, `export function make(length: number) { return Array.from({ length }, (_, index) => index) }`);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });
});

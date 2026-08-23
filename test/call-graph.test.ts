import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("discharges program-wide throws only across caught synchronous edges", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-program-throw-discharge-"));
    try {
      const library = join(directory, "library.ts"), main = join(directory, "main.ts");
      writeFileSync(library, `
        /* uneffect: effect Throw<RangeError> */
        export function dangerous() { throw new RangeError("bad") }
        /* uneffect: effect Throw<SyntaxError> */
        export async function rejects() { throw new SyntaxError("async") }
        export function invoke(callback: () => void) { callback() }
      `);
      writeFileSync(main, `
        import { dangerous, rejects, invoke } from "./library.js"
        export function caughtDirect() { try { dangerous() } catch {} }
        export function uncaughtDirect() { dangerous() }
        export function startsAsync() { rejects() }
        export function caughtInline() { try { invoke(() => { throw new TypeError("inline") }) } catch {} }
        export function deferredIsNotCaught() {
          try { setTimeout(() => { throw new URIError("later") }, 0) } catch {}
        }
      `);
      const program = ts.createProgram([library, main], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], types: ["node"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "caughtDirect", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "uncaughtDirect", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "rejects", effect: "Throw<SyntaxError>", kind: "unused",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "startsAsync", effect: "Throw<SyntaxError>", kind: "missing",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "caughtInline", effect: "Throw<TypeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "deferredIsNotCaught", effect: "Throw<URIError>", kind: "missing",
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("discharges imported implicit disposer throws inside a caught using scope", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-program-disposer-discharge-"));
    try {
      const library = join(directory, "library.ts"), main = join(directory, "main.ts");
      writeFileSync(library, `
        export class Resource {
          /* uneffect: effect Throw<RangeError> */
          [Symbol.dispose]() { throw new RangeError("dispose") }
        }
      `);
      writeFileSync(main, `
        import { Resource } from "./library.js"
        export function caught() { try { using resource = new Resource() } catch {} }
        export function uncaught() { using resource = new Resource() }
      `);
      const program = ts.createProgram([library, main], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.es2024.d.ts", "lib.esnext.disposable.d.ts"], noEmit: true,
      });
      const result = analyzeProgramEffects(program, { requireAnnotations: true });
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "caught", effect: "Throw<RangeError>", kind: "missing",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "uncaught", effect: "Throw<RangeError>", kind: "missing",
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("classifies Array.from mapping as synchronous inline invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-array-from-"));
    const source = join(directory, "array.ts");
    writeFileSync(source, `export function make(length: number) { return Array.from({ length }, (_, index) => index) }`);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });

  it("classifies aliased node:fs completion callbacks as deferred by builtin identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-fs-callback-"));
    const source = join(directory, "fs.ts");
    writeFileSync(source, `
      import { readFile as loadFile } from "node:fs"
      /* uneffect: effect FsRead | Console */
      export function load() { loadFile("settings.json", () => console.log("loaded")) }
    `);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true });
    const graph = buildProgramCallGraph(program);
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "callback-argument", timing: "deferred" }));
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.diagnostics.filter((item) => item.functionName === "load")).toEqual([]);
    expect(result.summaries.find((item) => item.functionName === "load")).toMatchObject({ evidence: "verified" });
    rmSync(directory, { recursive: true, force: true });
  });

  it("classifies Effect.catchAll handlers as deferred by package symbol identity", () => {
    const directory = mkdtempSync(join(process.cwd(), ".tmp-uneffect-effect-callback-"));
    const source = join(directory, "effect.ts");
    writeFileSync(source, `
      import { Effect } from "effect"
      export function recovered() { return Effect.catchAll(() => Effect.succeed("ok")) }
      const LocalEffect = { catchAll: (callback: () => unknown) => callback }
      export function unknown() { return LocalEffect.catchAll(() => "ok") }
    `);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const graph = buildProgramCallGraph(program);
    rmSync(directory, { recursive: true, force: true });
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "callback-argument", timing: "deferred" }));
    expect(graph.edges).toContainEqual(expect.objectContaining({ kind: "callback-argument", timing: "unknown" }));
  });

  it("does not degrade an inline callback when recursive calls forward it", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-recursive-callback-"));
    const source = join(directory, "recursive.ts");
    writeFileSync(source, `
      export function visit(value: number, map: (value: number) => number): number {
        return value > 0 ? map(value) : visit(1, map)
      }
      export function run() { return visit(0, (value) => value + 1) }
    `);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });

  it("classifies JSON.stringify replacers as synchronous inline callbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-json-replacer-"));
    const source = join(directory, "json.ts");
    writeFileSync(source, `export function encode(value: unknown) { return JSON.stringify(value, (_key, item) => item) }`);
    const program = ts.createProgram([source], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  });
});

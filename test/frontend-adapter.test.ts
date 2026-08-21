import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { auditBuiltinDeclarationDrift, collectBuiltinCallRefinements } from "../src/frontend-adapter.js";
import { builtinContractRegistry } from "../src/builtin-contracts.js";
import { analyzeEffectsInProgram } from "../src/effects.js";

describe("TypeChecker symbol adapter", () => {
  it("applies tmpdir refinement through aliased and namespace symbol identity only", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-symbols-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import { tmpdir as targetTemp } from "node:os";
      import * as os from "node:os";
      const a = targetTemp();
      const b = os.tmpdir();
      function tmpdir() { return "shadowed" }
      const c = tmpdir();
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    const calls = collectBuiltinCallRefinements(program, source);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.symbol)).toEqual([
      { module: "node:os", export: "tmpdir" },
      { module: "node:os", export: "tmpdir" },
    ]);
    expect(calls.every((call) => call.result?.kind === "path" && call.result.pattern === "$TEMP")).toBe(true);
  });

  it("infers fs effects from resolved symbols and ignores a shadowing receiver", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-effects-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import * as fs from "node:fs";
      /* uneffect: effect FsRead<"a"> */
      function actual() { return fs.readFileSync("a") }
      function shadowed(fs: { readFileSync(path: string): string }) { return fs.readFileSync("a") }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
  });

  it("resolves global fetch and console while ignoring a shadowed fetch parameter", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-globals-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect: effect Console | Fetch | Net */
      async function actual() { console.log("start"); await fetch("https://example.com/") }
      function shadowed(fetch: (url: string) => void) { fetch("https://example.com/") }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
  });

  it("maps DOM member symbols to receiver-scoped compound effects", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect: effect Dom<Read, typeof document> */
      function query() { return document.querySelector(".item") }
      /* uneffect: effect Dom<TreeWrite, typeof root> | Mutate<typeof root> | Mutate<typeof child> | InvokeUserCode */
      function attach(root: Element, child: Node) { root.appendChild(child) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(collectBuiltinCallRefinements(program, source)).toContainEqual(
      expect.objectContaining({ queryRefinement: { kind: "css-selector", selector: ".item" } }),
    );
    expect(auditBuiltinDeclarationDrift(program)).toEqual([]);
    expect(auditBuiltinDeclarationDrift(program, {
      ...builtinContractRegistry,
      declarations: [{ ...builtinContractRegistry.declarations[0]!, sha256: "stale" }],
    })).toContainEqual(expect.objectContaining({ library: "lib.dom.d.ts", actual: expect.any(String) }));
  });

  it("marks accessors, proxies, computed-key coercion, and value coercion as user-code invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-user-code-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      class Box { get value() { return 1 } }
      /* uneffect: effect InvokeUserCode */ function getter(box: Box) { return box.value }
      /* uneffect: effect InvokeUserCode */ function proxy() { const value = new Proxy({}, {}); return value.x }
      /* uneffect: effect InvokeUserCode */ function key(value: object, key: object) { return (value as any)[key as any] }
      /* uneffect: effect InvokeUserCode */ function coerce(value: object) { return value + "" }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    expect(analyzeEffectsInProgram(program, program.getSourceFile(fileName)!)).toEqual([]);
  });

  it("instantiates clone and transfer effects while keeping SharedArrayBuffer shared", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-transfer-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect: effect Clone<typeof value> | Transfer<typeof buffer> */
      function move(value: object, buffer: ArrayBuffer) { structuredClone(value, { transfer: [buffer] }) }
      /* uneffect: effect Clone<typeof shared> | SharedMemory<typeof shared> */
      function share(shared: SharedArrayBuffer) { structuredClone(shared) }
      /* uneffect: effect Clone<typeof value> | Transfer<typeof buffer> */
      function post(worker: Worker, value: object, buffer: ArrayBuffer) { worker.postMessage(value, [buffer]) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    expect(analyzeEffectsInProgram(program, program.getSourceFile(fileName)!)).toEqual([]);
  });
});

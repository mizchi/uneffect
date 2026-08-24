import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { auditBuiltinDeclarationDrift, collectBuiltinCallRefinements } from "../src/frontend-adapter.js";
import { builtinContractRegistry } from "../src/builtin-contracts.js";
import { analyzeEffectsInProgram, analyzeProgramEffects } from "../src/effects.js";
import { verifyTypedArraySafetyInTypeScriptProgram } from "../src/typed-array-safety.js";
import { analyzeUneffectProject } from "../src/custom-validators.js";

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

  it("resolves imported Node class members without matching a user-defined method name", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-node-member-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import { createServer } from "node:net";
      createServer().close(() => undefined);
      class Server { close(callback: () => void) { callback() } }
      new Server().close(() => undefined);
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(collectBuiltinCallRefinements(program, source).filter((call) => call.symbol.export === "Server#close")).toEqual([
      expect.objectContaining({ symbol: { module: "node:net", export: "Server#close" } }),
    ]);
  });

  it("resolves an inherited net.Server member through a node:http receiver", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-http-member-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import { createServer } from "node:http";
      const server = createServer();
      server.listen(8080, "127.0.0.1", () => undefined);
      class Server { listen(_port: number, callback: () => void) { callback() } }
      new Server().listen(8080, () => undefined);
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(collectBuiltinCallRefinements(program, source).filter((call) => call.symbol.export === "Server#listen"))
      .toEqual([expect.objectContaining({ symbol: { module: "node:net", export: "Server#listen" } })]);
  });

  it("resolves node:net Socket.connect without matching a lookalike", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-node-socket-member-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      import type { Socket } from "node:net";
      declare const socket: Socket;
      socket.connect({ host: "example.com", port: 443 }, () => undefined);
      class LocalSocket { connect(_options: object, callback: () => void) { callback() } }
      new LocalSocket().connect({}, () => undefined);
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
    const source = program.getSourceFile(fileName)!;
    expect(collectBuiltinCallRefinements(program, source).filter((call) => call.operation?.kind === "deferred-callback"))
      .toEqual([expect.objectContaining({ symbol: { module: "node:net", export: "Socket#connect" } })]);
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
      /* uneffect: effect Dom<NodeRead, typeof document> */
      function query() { return document.querySelector(".item") }
      /* uneffect: effect Dom<NodeWrite, typeof root> | Mutate<typeof root> | Mutate<typeof child> | InvokeUserCode */
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

  it("classifies reviewed attribute, topology, and character-data methods", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-categories-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect: effect Dom<AttributeRead, typeof element> */
      function inspectAttributes(element: Element) { return [element.hasAttribute("role"), element.getAttributeNames()] }
      /* uneffect: effect Dom<AttributeWrite, typeof element> | Mutate<typeof element> | InvokeUserCode */
      function updateAttributes(element: Element) { element.removeAttribute("hidden"); element.toggleAttribute("open") }
      /* uneffect: effect Dom<NodeRead, typeof node> */
      function inspectTopology(node: Node, other: Node) { return node.contains(other) && node.compareDocumentPosition(other) !== 0 }
      /* uneffect: effect Dom<NodeWrite, typeof root> | Mutate<typeof root> | Mutate<typeof child> | Mutate<typeof before> | InvokeUserCode */
      function insert(root: Node, child: Node, before: Node) { return root.insertBefore(child, before) }
      /* uneffect: effect Dom<TextRead, typeof data> */
      function readRange(data: CharacterData) { return data.substringData(0, 1) }
      /* uneffect: effect Dom<TextWrite, typeof data> | Mutate<typeof data> */
      function replaceRange(data: CharacterData) { data.replaceData(0, 1, "x") }
      interface LocalElement { hasAttribute(name: string): boolean; toggleAttribute(name: string): boolean }
      function localMethods(element: LocalElement) { return element.hasAttribute("x") || element.toggleAttribute("x") }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("emits compound DOM effects for clone, normalize, and adjacent content", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-compound-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect: effect Dom<NodeRead, typeof node> | Dom<Create, typeof node> */
      function clone(node: Node) { return node.cloneNode(true) }
      /* uneffect: effect Dom<NodeWrite, typeof node> | Dom<TextWrite, typeof node> | Mutate<typeof node> */
      function normalize(node: Node) { node.normalize() }
      /* uneffect: effect Dom<Parse, typeof element> | Dom<NodeWrite, typeof element> | Mutate<typeof element> | InvokeUserCode */
      function insertMarkup(element: Element) { element.insertAdjacentHTML("beforeend", "<span>ready</span>") }
      /* uneffect: effect Dom<TextWrite, typeof element> | Dom<NodeWrite, typeof element> | Mutate<typeof element> */
      function insertText(element: Element) { element.insertAdjacentText("beforeend", "ready") }
      interface LocalNode { cloneNode(deep?: boolean): LocalNode; normalize(): void }
      function local(node: LocalNode) { node.normalize(); return node.cloneNode(true) }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("distinguishes DOM text and Web IDL property reads from writes", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-dom-property-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      /* uneffect: effect Dom<TextRead, typeof node> */
      function readText(node: Node) { return node.textContent }
      /* uneffect: effect Dom<TextWrite, typeof node> | Dom<NodeWrite, typeof node> | Mutate<typeof node> | InvokeUserCode */
      function replaceText(node: Node) { node.textContent = "updated" }
      /* uneffect: effect Dom<TextWrite, typeof node> | Mutate<typeof node> */
      function writeNodeValue(node: Node) { node.nodeValue = "updated" }
      /* uneffect: effect Dom<TextRead, typeof data> */
      function readCharacterData(data: CharacterData) { return data.data }
      /* uneffect: effect Dom<TextWrite, typeof data> | Mutate<typeof data> */
      function writeCharacterData(data: CharacterData) { data.data = "updated" }
      /* uneffect: effect Dom<NodeRead, typeof node> */
      function readParent(node: Node) { return node.parentNode }
      /* uneffect: effect Dom<NodeRead, typeof element> */
      function readChildren(element: Element) { return element.children }
      /* uneffect: effect Dom<AttributeRead, typeof element> */
      function readAttributes(element: Element) { return element.attributes }
      /* uneffect: effect Dom<PropertyRead, typeof input> */
      function readValue(input: HTMLInputElement) { return input.value }
      /* uneffect: effect Dom<PropertyRead, typeof input> */
      function readLiteralValue(input: HTMLInputElement) { return input["value"] }
      /* uneffect: effect Dom<PropertyWrite, typeof input> | Mutate<typeof input> */
      function writeValue(input: HTMLInputElement) { input.value = "updated" }
      /* uneffect: effect Dom<PropertyWrite, typeof input> | Mutate<typeof input> */
      function writeLiteralValue(input: HTMLInputElement) { input["value"] = "updated" }
      /* uneffect: effect Dom<PropertyRead, typeof input> | Dom<PropertyWrite, typeof input> | Mutate<typeof input> */
      function appendValue(input: HTMLInputElement) { input.value += "!" }
      /* uneffect: effect Dom<All, typeof input> */
      function dynamicRead(input: HTMLInputElement, key: "value" | "checked") { return input[key] }
      /* uneffect: effect Dom<All, typeof input> | Mutate<typeof input> */
      function dynamicWrite(input: HTMLInputElement, key: "value" | "checked") { input[key] = undefined as never }
      /* uneffect: effect Dom<PropertyWrite, typeof proxy> | InvokeUserCode */
      function proxyWrite(input: HTMLInputElement) { const proxy = new Proxy(input, {}); proxy.value = "proxied" }
      interface LocalInput { value: string }
      /* uneffect: effect Mutate<typeof input> */
      function localWrite(input: LocalInput) { input.value = "local" }
      interface LocalNode { parentNode: object; attributes: object }
      function localTopology(node: LocalNode) { return [node.parentNode, node.attributes] }
      interface LocalCharacterData { data: string }
      /* uneffect: effect Mutate<typeof data> */
      function localDataWrite(data: LocalCharacterData) { data.data = "local" }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"] });
    const source = program.getSourceFile(fileName)!;
    expect(analyzeEffectsInProgram(program, source)).toEqual([]);
    expect(analyzeProgramEffects(program).diagnostics).toEqual([]);
  });

  it("preserves DOM property symbols in virtual project analysis", () => {
    const result = analyzeUneffectProject({ mode: "strict", files: { "src/app.ts": `
      /* uneffect: effect Dom<TextWrite, typeof target> | Dom<NodeWrite, typeof target> | Mutate<typeof target> | InvokeUserCode */
      export function render(target: HTMLElement) { target.textContent = "ready" }
    ` } });
    expect(result.diagnostics).toEqual([]);
  });

  it("marks accessors, proxies, computed-key coercion, and value coercion as user-code invocation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-user-code-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      class Box { get value() { return 1 } }
      /* uneffect: effect InvokeUserCode */ function getter(box: Box) { return box.value }
      /* uneffect: effect InvokeUserCode */ function proxy() { const value = new Proxy({}, {}); return value.x }
      /* uneffect: effect InvokeUserCode */ function assimilate(flag: boolean) {
        const foreign = { get then() { if (flag) throw new Error("getter"); return (resolve: (value: number) => void) => resolve(1) } }
        return new Promise<number>((resolve) => resolve(foreign))
      }
      /* uneffect: effect InvokeUserCode */ async function collect(values: Iterable<Promise<number>>) { await Promise.all(values) }
      /* uneffect: effect InvokeUserCode */ function key(value: object, key: object) { return (value as any)[key as any] }
      function safeKey(value: Record<"success" | "failure", number>, key: "success" | "failure") { return value[key] }
      class RoutedBox { get success() { return 1 } get failure() { return 0 } }
      /* uneffect: effect InvokeUserCode */ function routedGetter(value: RoutedBox, key: "success" | "failure") { return value[key] }
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

  it("recognizes integer casts by lib.d.ts symbol identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-math-symbols-"));
    const fileName = join(directory, "input.ts");
    writeFileSync(fileName, `
      type U8 = number
      type BoundedUint8Array<N extends number> = Uint8Array
      function builtin(output: BoundedUint8Array<1>, value: U8) { output[0] = Math.floor(value) }
      const floorAlias = Math.floor
      const { trunc: truncate } = Math
      function aliases(output: BoundedUint8Array<2>, value: U8) {
        output[0] = floorAlias(value)
        output[1] = truncate(value)
      }
      function shadowed(output: BoundedUint8Array<1>, value: U8) {
        const Math = { floor: (_value: number) => 1.5 }
        output[0] = Math.floor(value)
      }
    `);
    const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = await verifyTypedArraySafetyInTypeScriptProgram(program, program.getSourceFile(fileName)!);
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "builtin", kind: "u8-write", result: "verified" }));
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write").every((item) => item.result === "verified")).toBe(true);
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write")).toHaveLength(2);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "shadowed", kind: "u8-write" }));
  });

  it("propagates integer cast identity through immutable aliases, properties, imports, and parameters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-math-propagation-"));
    const helpers = join(directory, "helpers.ts");
    const fileName = join(directory, "input.ts");
    writeFileSync(helpers, `
      export const importedFloor = Math.floor
    `);
    writeFileSync(fileName, `
      import { importedFloor } from "./helpers.js"
      type U8 = number
      type BoundedUint8Array<N extends number> = Uint8Array
      const first = Math.floor
      const second = first
      const casts = { truncate: Math.trunc } as const
      function applyCast(output: BoundedUint8Array<1>, cast: (value: number) => number, value: U8) { output[0] = cast(value) }
      function aliases(output: BoundedUint8Array<3>, value: U8) {
        output[0] = second(value)
        output[1] = casts.truncate(value)
        output[2] = importedFloor(value)
      }
      applyCast(new Uint8Array(1), Math.ceil, 1)
      let mutable = Math.floor
      mutable = (value) => value + 0.5
      function mutableAlias(output: BoundedUint8Array<1>, value: U8) { output[0] = mutable(value) }
      const mutableObject = { cast: Math.floor }
      mutableObject.cast = (value) => value + 0.5
      function mutableProperty(output: BoundedUint8Array<1>, value: U8) { output[0] = mutableObject.cast(value) }
    `);
    const program = ts.createProgram([fileName, helpers], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"] });
    const result = await verifyTypedArraySafetyInTypeScriptProgram(program, program.getSourceFile(fileName)!);
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write")).toHaveLength(3);
    expect(result.obligations.filter((item) => item.functionName === "aliases" && item.kind === "u8-write").every((item) => item.result === "verified")).toBe(true);
    expect(result.obligations).toContainEqual(expect.objectContaining({ functionName: "applyCast", kind: "u8-write", result: "verified" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "mutableAlias", kind: "u8-write" }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ functionName: "mutableProperty", kind: "u8-write" }));
  });
});

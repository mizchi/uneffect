import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { openCorsaCallableFrontend } from "../src/frontends/corsa/corsa-callable-frontend.js";
import { resolveCorsaExecutable } from "../src/frontends/corsa/corsa-api-frontend.js";
import { decodeNativeSourceIndex, nativeCallableKinds } from "../src/frontends/corsa/native-source-index.js";

const source = `// 😀 UTF-16 and leading trivia\r\n
export function pick(value: string): string;
export function pick(value: number): number;
export function pick(value: string | number) { return value; }
export function identity<T>(value: T): T { return value; }
export async function load() { return 42; }
export const arrow = (value: boolean) => !value;
export class Box<T> { constructor(public value: T) {} }
export const a = pick("text"), b = pick(42), c = identity({ tag: "ok" });
export const d = new Box(42), e = load(), f = arrow(true);
export function local(pick: (value: boolean) => boolean) { return pick(true); }
declare const unknownCall: any;
unknownCall();
`;

async function project(run: (frontend: Awaited<ReturnType<typeof openCorsaCallableFrontend>>, file: string, configFile: string) => void | Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-corsa-signatures-"));
  const file = join(directory, "input.ts"), configFile = join(directory, "tsconfig.json");
  writeFileSync(file, source);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [] }, files: [file] }));
  const frontend = await openCorsaCallableFrontend({ configFile });
  try { await run(frontend, file, configFile); }
  finally { frontend.close(); rmSync(directory, { recursive: true, force: true }); }
}
const range = (text: string) => ({ start: source.indexOf(text), end: source.indexOf(text) + text.length });

describe("Corsa callable signatures", () => {
  it("matches TypeScript overload selection, generic substitution, async, constructor, and shadowed calls", async () => {
    await project((frontend, file) => {
      const program = ts.createProgram([file], { strict: true, target: ts.ScriptTarget.ES2024, types: [] });
      const checker = program.getTypeChecker(), ast = program.getSourceFile(file)!;
      for (const expression of ['pick("text")', 'pick(42)', 'identity({ tag: "ok" })', 'new Box(42)', 'load()', 'arrow(true)', 'pick(true)']) {
        const span = range(expression);
        // load() first occurs in its declaration; select the call after `e =`.
        if (expression === "load()") { span.start = source.indexOf("load()", source.indexOf("e =")); span.end = span.start + expression.length; }
        let call: ts.CallExpression | ts.NewExpression | undefined;
        const visit = (node: ts.Node): void => {
          if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.getStart(ast) === span.start && node.end === span.end) call = node;
          ts.forEachChild(node, visit);
        };
        visit(ast);
        expect(call, expression).toBeDefined();
        const legacy = checker.getResolvedSignature(call!)!;
        const actual = frontend.getResolvedSignature(file, span, source);
        expect(actual, expression).not.toBeNull();
        expect(actual!.returnType.texts).toContain(checker.typeToString(checker.getReturnTypeOfSignature(legacy)));
        expect(actual!.parameters.map(parameter => parameter.name)).toEqual(legacy.parameters.map(parameter => parameter.name));
        expect(actual!.parameters.map(parameter => parameter.type.texts[0])).toEqual(legacy.parameters.map(parameter => checker.typeToString(checker.getTypeOfSymbolAtLocation(parameter, call!))));
        const declaration = legacy.declaration!;
        expect(actual!.declaration.span).toEqual({ start: declaration.getStart(ast), end: declaration.end });
        expect(actual!.declaration.fileName.toLowerCase()).toBe(file.toLowerCase());
      }
    });
  });
  it("gets inferred declaration results and lists all overloads without selecting the first", async () => {
    await project((frontend, file) => {
      const declaration = "export async function load() { return 42; }";
      const result = frontend.getSignatureFromDeclaration(file, range(declaration), source);
      expect(result?.returnType.texts).toContain("Promise<number>");
      const overloads = frontend.getSignaturesOfTypeAtPosition(file, source.indexOf('pick("text")'));
      expect(overloads.map(signature => signature.returnType.texts[0])).toEqual(["string", "number"]);
      expect(frontend.getPrimitiveTypeKind(overloads[0]!.returnType)).toBeNull();
      expect(frontend.getPrimitiveTypeKind(overloads[1]!.returnType)).toBe("number");
      expect(frontend.isTypeAssignableTo(overloads[0]!.returnType, overloads[1]!.returnType)).toBe(false);
      expect(frontend.isTypeAssignableTo(overloads[1]!.returnType, overloads[1]!.parameters[0]!.type)).toBe(true);
      expect(() => frontend.isTypeAssignableTo({ ...overloads[1]!.returnType }, overloads[1]!.returnType)).toThrow(/owning snapshot/);
      expect(() => frontend.getPrimitiveTypeKind({ ...overloads[1]!.returnType })).toThrow(/owning snapshot/);
      expect(frontend.getProjectDiagnostics()).toEqual([]);
      expect(() => frontend.assertSource(file, source + "\n")).toThrow(/snapshot/);
      expect(frontend.getSignaturesOfTypeAtPosition(file, source.indexOf("42"))).toEqual([]);
      const arrow = "(value: boolean) => !value";
      const arrowSignature = frontend.getSignatureFromDeclaration(file, range(arrow), source)!;
      expect(arrowSignature.returnType.texts).toEqual(["boolean"]);
      expect(frontend.getPrimitiveTypeKind(arrowSignature.returnType)).toBe("boolean");
    });
  });
  it("rejects stale source, invalid ranges, non-calls, and unauthenticated recovery signatures", async () => {
    await project((frontend, file) => {
      expect(() => frontend.getResolvedSignature(file, range("pick(42)"), source + "\n")).toThrow(/snapshot|source/);
      expect(() => frontend.getResolvedSignature(file, { start: -1, end: 4 }, source)).toThrow(/range/);
      expect(frontend.getResolvedSignature(file, range("42"), source)).toBeNull();
      expect(frontend.getResolvedSignature(file, range("unknownCall()"), source)).toBeNull();
      const outside = file.replace("input.ts", "outside.ts");
      writeFileSync(outside, "export const value = 42;");
      expect(() => frontend.getResolvedSignature(outside, { start: 0, end: 6 }, "export const value = 42;")).toThrow(/snapshot/);
      frontend.close();
      expect(() => frontend.getResolvedSignature(file, range("pick(42)"), source)).toThrow(/closed/);
    });
  });
  it("rejects assignability facts owned by another snapshot or a closed frontend", async () => {
    await project(async (frontend, file, configFile) => {
      const other = await openCorsaCallableFrontend({ configFile });
      try {
        const own = frontend.getResolvedSignature(file, range("pick(42)"), source)!.returnType;
        const foreign = other.getResolvedSignature(file, range("pick(42)"), source)!.returnType;
        expect(() => frontend.isTypeAssignableTo(own, foreign)).toThrow(/owning snapshot/);
        frontend.close();
        expect(() => frontend.isTypeAssignableTo(own, own)).toThrow(/closed/);
      } finally { other.close(); }
    });
  });
  it("validates binary version, section bounds, node identity, UTF-16 positions, and buffer offsets", async () => {
    await project(async (_frontend, file, configFile) => {
      const { CorsaApiClient } = await import("@corsa-bind/napi");
      const client = await CorsaApiClient.spawnAsync({ executable: resolveCorsaExecutable(), mode: "jsonrpc" });
      try {
        await client.initializeAsync();
        const snapshot = await client.updateSnapshotAsync({ openProject: configFile });
        const bytes = client.getSourceFile(snapshot.snapshot, snapshot.projects[0]!.id, file)!;
        const padded = new Uint8Array(bytes.length + 8);
        padded.set(bytes, 4);
        const index = decodeNativeSourceIndex(padded.subarray(4, 4 + bytes.length));
        expect(index.text).toBe(source);
        const node = index.find(nativeCallableKinds.CallExpression, range("pick(42)"))!;
        expect(node.span).toEqual(range("pick(42)"));
        expect(index.node(node.handle)).toEqual(node);
        expect(() => index.node(node.handle.replace(".214.", ".215."))).toThrow(/kind mismatch/);
        expect(() => index.node(node.handle + ".other")).toThrow(/another source file/);
        expect(() => index.node("999999.214." + index.path)).toThrow(/bounds/);
        expect(() => decodeNativeSourceIndex(bytes.subarray(0, 40))).toThrow(/header/);
        const version = new Uint8Array(bytes); version[3] = 255;
        expect(() => decodeNativeSourceIndex(version)).toThrow(/unsupported binary protocol/);
        const sections = new Uint8Array(bytes); new DataView(sections.buffer).setUint32(40, 0, true);
        expect(() => decodeNativeSourceIndex(sections)).toThrow(/section bounds/);
        const strings = new Uint8Array(bytes), view = new DataView(strings.buffer);
        const rootData = view.getUint32(view.getUint32(40, true) + 28 + 20, true);
        view.setUint32(view.getUint32(32, true) + (rootData & 0x00ff_ffff), 0xffff_ffff, true);
        expect(() => decodeNativeSourceIndex(strings)).toThrow(/string index bounds/);
      } finally { client.close(); }
    });
  });
  it("authenticates imported declaration locations, including paths containing dots", async () => {
    await project((frontend, file, configFile) => {
      const imported = file.replace("input.ts", "helper.test.ts");
      writeFileSync(imported, 'export function convert(value: number) { return String(value); }');
      const text = 'import { convert as alias } from "./helper.test.js"; export const result = alias(42);';
      writeFileSync(file, text);
      frontend.close();
      return openCorsaCallableFrontend({ configFile }).then(next => {
        try {
          const start = text.indexOf("alias(42)");
          const call = next.getResolvedSignature(file, { start, end: start + 9 }, text);
          expect(call?.returnType.texts).toContain("string");
          expect(call?.declaration.fileName.toLowerCase()).toBe(imported.toLowerCase());
          const symbol = next.getSymbolAtPosition(file, start)!;
          const target = next.getAliasedSymbol(symbol)!;
          const declarations = next.getDeclarationSpans(target);
          expect(declarations).toEqual([call!.declaration]);
          target.declarations!.length = 0;
          declarations[0]!.span.start = 999;
          expect(next.getDeclarationSpans(target)).toEqual([call!.declaration]);
          expect(() => next.getDeclarationSpans({ ...target })).toThrow(/owning snapshot/);
          next.close();
          expect(() => next.getDeclarationSpans(target)).toThrow(/closed/);
        } finally { next.close(); }
      });
    });
  });
  it("loads and resolves a call with JavaScript compiler imports blocked", async () => {
    await project((_frontend, file, configFile) => {
      const script = `
        import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) {
          if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('JavaScript compiler forbidden: ' + specifier);
          return next(specifier, context);
        } });
        const { openCorsaCallableFrontend } = await import('./src/frontends/corsa/corsa-callable-frontend.ts');
        const f = await openCorsaCallableFrontend({ configFile: ${JSON.stringify(configFile)} });
        try { assert.deepEqual(f.getResolvedSignature(${JSON.stringify(file)}, ${JSON.stringify(range("pick(42)"))}, ${JSON.stringify(source)}).returnType.texts, ['number']); }
        finally { f.close(); }
      `;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
    });
  });
});

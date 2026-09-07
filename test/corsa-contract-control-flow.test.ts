import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { openCorsaCallableFrontend } from "../src/frontends/corsa/corsa-callable-frontend.js";
import { analyzeCorsaContractControlFlow } from "../src/contracts/corsa-control-flow.js";
import { functionMayFallThrough, statementExit } from "../src/contracts/contract-control-flow.js";

const source = `// 😀\r\ndeclare function stop(): never;
declare function pick(value: true): never;
declare function pick(value: false): void;
declare function generic<T>(value: T): T;
declare const enabled: true, disabled: false, widened: boolean, anything: any, unknownValue: unknown;
declare const record: { readonly enabled: true; readonly disabled: false };
export function direct() { stop(); }
export function wrapped() { void (stop() as never); }
export function overloaded() { pick(true); }
export function returnsNormally() { pick(false); }
export function genericReturn(value: never) { generic(value); }
export function shadowed(stop: () => void) { stop(); }
export function optional(stop?: () => never) { stop?.(); }
export function shortCircuit() { disabled && stop(); }
export function eager() { enabled && stop(); }
export function literal() { if (enabled) return 1; }
export function member() { if (record.enabled) return 1; }
export function memberFalse() { if (record.disabled) return 1; }
export function compound() { if (enabled && widened) return 1; }
export function unary() { if (!disabled) return 1; }
export function broad(value: boolean) { if (value) return 1; }
export function anyValue() { if (anything) return 1; }
export function unknownType() { if (unknownValue) return 1; }
export function textValue(value: "true") { if (value) return 1; }
export function caught() { try { stop(); } catch {} }
export function finalizer() { try { stop(); } finally { return 1; } }
export function loop() { while (enabled) {} }
export function asserted() { if ((widened as true) satisfies boolean) return 1; }
export function comparison() { if (disabled === false) return 1; }
export function indexed() { if (record["enabled"]) return 1; }
export function boolCall(predicate: () => true) { if (predicate()) return 1; }
export function ternary() { if (widened ? enabled : disabled) return 1; }
export function coalesce(value?: true) { if (value ?? true) return 1; }
export function optionalMember(value?: { enabled: true }) { if (value?.enabled) return 1; }
export function negated() { if (!(widened as boolean)) return 1; }
export function sequence() { if ((anything(), enabled)) return 1; }
export function assigned(value: boolean) { if (value = enabled) return 1; }

`;
async function project(run: (file: string, configFile: string) => Promise<void>, text = source, compilerOptions: Record<string, unknown> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-native-contract-flow-"));
  const file = join(directory, "input.ts"), configFile = join(directory, "tsconfig.json");
  writeFileSync(file, text);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "ES2024", module: "NodeNext", types: [], ...compilerOptions }, files: [file] }));
  try { await run(file, configFile); } finally { rmSync(directory, { recursive: true, force: true }); }
}
function range(text: string, fragment: string) { const start = text.indexOf(fragment); return { start, end: start + fragment.length }; }
describe("Corsa contract control flow", () => {
  it("matches checker-assisted completion rules for native calls and boolean facts", async () => {
    await project(async (file, configFile) => {
      const results = await analyzeCorsaContractControlFlow({ configFile, files: { [file]: source } });
      const program = ts.createProgram([file], { strict: true, target: ts.ScriptTarget.ES2024, types: [] });
      const checker = program.getTypeChecker(), ast = program.getSourceFile(file)!;
      const options = {
        isNeverCall: (call: ts.CallExpression) => { const signature = checker.getResolvedSignature(call); return !!signature && (checker.getReturnTypeOfSignature(signature).flags & ts.TypeFlags.Never) !== 0; },
        constantBoolean: (expression: ts.Expression) => { const type = checker.getTypeAtLocation(expression); return type.flags & ts.TypeFlags.BooleanLiteral ? checker.typeToString(type) === "true" : undefined; },
      };
      const declarations = ast.statements.filter(ts.isFunctionDeclaration).filter(node => node.body);
      expect(results).toHaveLength(declarations.length);
      for (const [index, declaration] of declarations.entries()) {
        const result = results[index]!;
        expect(result.name).toBe(declaration.name!.text);
        expect(result.mayFallThrough, result.name).toBe(functionMayFallThrough(declaration.body!, options));
        expect([...result.exits].sort(), result.name).toEqual([...statementExit(declaration.body!, options)].sort());
        expect(result.structural.mayFallThrough).toBe(functionMayFallThrough(declaration.body!));
        expect(result.evidence).toBe("structural-with-corsa-types");
        expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
      }
      const fallsThrough = Object.fromEntries(results.map(result => [result.name, result.mayFallThrough]));
      expect(fallsThrough).toMatchObject({ direct: false, overloaded: false, genericReturn: false, shadowed: true,
        optional: true, shortCircuit: true, eager: false, literal: false, member: false, memberFalse: true,
        compound: true, broad: true, anyValue: true, unknownType: true, textValue: true, caught: true, finalizer: false, loop: false, asserted: false, comparison: false, indexed: false, boolCall: false, ternary: true, coalesce: false, optionalMember: true, negated: true, sequence: false, assigned: false });
    });
  });
  it("authenticates complete expression ranges and keeps primitive facts snapshot-owned", async () => {
    await project(async (file, configFile) => {
      const frontend = await openCorsaCallableFrontend({ configFile });
      const other = await openCorsaCallableFrontend({ configFile });
      try {
        const literal = frontend.getExpressionType(file, range(source, "record.enabled"), source)!;
        expect(frontend.getBooleanLiteralValue(literal)).toBe(true);
        literal.texts[0] = "false";
        expect(frontend.getBooleanLiteralValue(literal)).toBe(true);
        const compound = frontend.getExpressionType(file, range(source, "enabled && widened"), source)!;
        expect(frontend.getBooleanLiteralValue(compound)).toBeUndefined();
        expect(frontend.getBooleanLiteralValue(frontend.getExpressionType(file, range(source, "record.disabled"), source)!)).toBe(false);
        const declaration = "export function direct() { stop(); }";
        const never = frontend.getSignatureFromDeclaration(file, range(source, declaration), source)!.returnType;
        // Inferred function-declaration returns may be void; resolved call returns are authoritative.
        const start = source.indexOf("stop();", source.indexOf(declaration));
        const called = frontend.getResolvedSignature(file, { start, end: start + 6 }, source)!.returnType;
        expect(frontend.isNeverType(called)).toBe(true);
        called.texts[0] = "void";
        expect(frontend.isNeverType(called)).toBe(true);
        expect(frontend.isNeverType(never)).toBe(false);
        expect(() => frontend.getExpressionType(file, range(source, "record.enabled"), source + "\n")).toThrow(/snapshot/);
        expect(() => frontend.getExpressionType(file, { start: -1, end: 3 }, source)).toThrow(/range/);
        expect(frontend.getExpressionType(file, range(source, declaration), source)).toBeNull();
        expect(frontend.getExpressionType(file, range(source, "record.enabl"), source)).toBeNull();
        expect(() => frontend.isNeverType({ ...called })).toThrow(/owning snapshot/);
        expect(() => other.getBooleanLiteralValue(literal)).toThrow(/owning snapshot/);
        frontend.close();
        expect(() => frontend.isNeverType(called)).toThrow(/closed/);
      } finally { frontend.close(); other.close(); }
    });
  });
  it("rejects native type errors before reporting endpoints", async () => {
    const text = 'declare function stop(value: number): never; export function bad() { stop("wrong"); }';
    await project(async (file, configFile) => {
      await expect(analyzeCorsaContractControlFlow({ configFile, files: { [file]: text } })).rejects.toThrow(/TS2345/);
    }, text);
  });
  it("authenticates imported never declarations and boolean aliases", async () => {
    const text = 'import { abort as finish, enabled as ready } from "./helper.js"; export function checked() { if (ready) finish(); }';
    await project(async (file, configFile) => {
      writeFileSync(join(file, "..", "helper.ts"), 'export function abort(): never { throw new Error("stop"); } export const enabled = true as const;');
      const results = await analyzeCorsaContractControlFlow({ configFile, files: { [file]: text } });
      expect(results[0]!.mayFallThrough).toBe(false);
      expect(results[0]!.structural.mayFallThrough).toBe(true);
    }, text);
  });
  it("checks diagnostics in unselected imported files too", async () => {
    const text = 'import "./helper.js"; export function checked() { return 1; }';
    await project(async (file, configFile) => {
      writeFileSync(join(file, "..", "helper.ts"), 'export const bad: number = "wrong";');
      await expect(analyzeCorsaContractControlFlow({ configFile, files: { [file]: text } })).rejects.toThrow(/TS2322/);
    }, text);
  });
  it("rejects noCheck projects", async () => {
    await project(async (file, configFile) => {
      await expect(analyzeCorsaContractControlFlow({ configFile, files: { [file]: source } })).rejects.toThrow(/noCheck/);
    }, source, { noCheck: true });
  });
  it("rejects stale and recovered sources", async () => {
    await project(async (file, configFile) => {
      await expect(analyzeCorsaContractControlFlow({ configFile, files: { [file]: source + "\n" } })).rejects.toThrow(/snapshot/);
      await expect(analyzeCorsaContractControlFlow({ configFile, files: { [file]: "function bad() { return +; }" } })).rejects.toThrow(/invalid TypeScript syntax/);
    });
  });
  it("runs native semantic refinement through the public facade with JS compilers forbidden", async () => {
    await project(async (file, configFile) => {
      const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) {
          if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden: ' + specifier);
          return next(specifier, context);
        } });
        const { analyzeCorsaContractControlFlow } = await import('./src/spec/analysis-api.ts');
        const results = await analyzeCorsaContractControlFlow({ configFile: ${JSON.stringify(configFile)}, files: { [${JSON.stringify(file)}]: ${JSON.stringify(source)} } });
        assert.equal(results.find(result => result.name === 'direct').mayFallThrough, false);
        assert.equal(results.find(result => result.name === 'compound').mayFallThrough, true);`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
    });
  });
});

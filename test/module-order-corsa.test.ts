import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeModuleInitializationOrder } from "../src/modules/module-initialization.js";
import { analyzeModuleInitializationOrderV2 } from "../src/modules/module-initialization-v2.js";
import { analyzeCorsaModuleInitializationOrder, analyzeCorsaModuleInitializationOrderV2 } from "../src/modules/corsa-module-order.js";

const cases: Array<[string, Record<string, string>]> = [
  ["sync dependencies", { "entry.mts": 'import "./dep.mjs"; export const ready = true;', "dep.mts": 'export const value = 1;' }],
  ["commented side effect import", { "entry.mts": 'import /* startup */ "./dep.mjs";', "dep.mts": 'export const value = 1;' }],
  ["empty import clause", { "entry.mts": 'import {} from "./dep.mjs";', "dep.mts": 'await Promise.resolve();' }],
  ["for initializer await", { "entry.mts": 'for (let value = await Promise.resolve(0); value < 1; value++) {} export {};' }],
  ["for test await", { "entry.mts": 'for (; await Promise.resolve(false);) {} export {};' }],
  ["awaited if test", { "entry.mts": 'if (await Promise.resolve(false)) {} export {};' }],
  ["default binding await", { "entry.mts": 'const { value = await Promise.resolve() } = {} as { value?: void }; export {};' }],
  ["conditional default await", { "entry.mts": 'const flag = Math.random() > .5; if (flag) { const { value = await Promise.resolve() } = {} as { value?: void }; } export {};' }],
  ["await inside try", { "entry.mts": 'try { await Promise.resolve(); } catch {} export {};' }],
  ["conditional await with else", { "entry.mts": 'const flag = Math.random() > .5; if (flag) await Promise.resolve(); else console.log("skip"); export {};' }],
  ["shadowed async name", { "entry.mts": 'async function main() {} { const main = () => 1; main(); } export {};' }],
  ["type-only imports", { "entry.mts": 'import type { Value } from "./dep.mjs"; export const ready = true;', "dep.mts": 'export type Value = number; await Promise.resolve();' }],
  ["type-only reexports", { "entry.mts": 'export { type Value } from "./dep.mjs";', "dep.mts": 'export type Value = number; await Promise.resolve();' }],
  ["runtime reexports", { "entry.mts": 'export { value } from "./dep.mjs";', "dep.mts": 'export const value = await Promise.resolve(1);' }],
  ["Unicode TLA", { "entry.mts": '// 日本語 🙂\nawait Promise.resolve(); export const 完了 = true;' }],
  ["throw blocks importer", { "entry.mts": 'import "./dep.mjs";', "dep.mts": 'throw new Error("stop");' }],
  ["synchronous ring", { "entry.mts": 'import "./dep.mjs";', "dep.mts": 'import "./entry.mjs";' }],
  ["binding cycle", { "entry.mts": 'import { dep } from "./dep.mjs"; export const entry = 1;', "dep.mts": 'import { entry } from "./entry.mjs"; export const dep = 2;' }],
  ["async ring", { "entry.mts": 'import "./dep.mjs";', "dep.mts": 'import "./entry.mjs"; await Promise.resolve();' }],
  ["conditional TLA", { "entry.mts": 'import "./dep.mjs";', "dep.mts": 'export const flag = Math.random() > .5; if (flag) { await Promise.resolve(); }' }],
  ["mutable selector", { "entry.mts": 'export let flag = Math.random() > .5; if (flag) await Promise.resolve();' }],
  ["declared selector", { "entry.mts": 'declare const flag: boolean; if (flag) await Promise.resolve(); export {};' }],
  ["repeated await", { "entry.mts": 'const flag = Math.random() > .5; while (flag) await Promise.resolve(); export {};' }],
  ["conditional expression", { "entry.mts": 'const flag = Math.random() > .5; flag && await Promise.resolve(); export {};' }],
  ["conditional throw", { "entry.mts": 'if (Math.random()) throw new Error("stop"); export {};' }],
  ["class initialization", { "entry.mts": 'export class Value { static ready = true; }' }],
  ["handled launch", { "entry.mts": 'async function main() {} main().catch(() => {}); export {};' }],
  ["unhandled launch", { "entry.mts": 'async function main() {} main(); export {};' }],
  ["mixed async shape", { "entry.mts": 'async function main() {} main().catch(() => {}); await Promise.resolve(); export {};' }],
  ["unsupported catch", { "entry.mts": 'const task = { catch(handler: () => void) {} }; task.catch(() => {}); export {};' }],
  ["dynamic import", { "entry.mts": 'void import("./dep.mjs"); export {};', "dep.mts": 'export const value = 1;' }],
];

describe("Corsa/Oxc module order", () => {
  let root: string;
  beforeAll(() => { root = mkdtempSync(join(tmpdir(), "uneffect-native-order-")); });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  function setup(files: Record<string, string>, compilerOptions: Record<string, unknown> = {}) {
    const directory = mkdtempSync(join(root, "case-")), entryFile = join(directory, "entry.mts"), configFile = join(directory, "tsconfig.json");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(directory, name), text);
    writeFileSync(configFile, JSON.stringify({ compilerOptions: { target: "ES2024", module: "NodeNext", types: [], noEmit: true, ...compilerOptions }, files: [entryFile] }));
    return { entryFile, configFile };
  }
  it.each(cases)("preserves v1/v2 ordering artifacts: %s", async (_name, files) => {
    const options = setup(files);
    const program = ts.createProgram([options.entryFile], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [], noEmit: true });
    for (const [legacy, native] of [[analyzeModuleInitializationOrder, analyzeCorsaModuleInitializationOrder], [analyzeModuleInitializationOrderV2, analyzeCorsaModuleInitializationOrderV2]] as const) {
      const { compiler: oldCompiler, ...expected } = legacy(program, options.entryFile);
      const { compiler, ...actual } = await native(options);
      expect(actual).toEqual(expected);
      expect(compiler.typescriptVersion).toMatch(/^7\./);
      expect(compiler.compilerOptionsDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(compiler.typescriptVersion).not.toBe(oldCompiler.typescriptVersion);
    }
  });
  it("retains native compiler errors without a positive artifact", async () => {
    const options = setup({ "entry.mts": 'export const value: number = "bad";' });
    expect(await analyzeCorsaModuleInitializationOrderV2(options)).toMatchObject({ evidence: "unknown", unknowns: expect.arrayContaining([expect.objectContaining({ kind: "typescript-error" })]) });
  });
  it("checks diagnostics even when the project disables checking", async () => {
    const options = setup({ "entry.mts": 'export const value: number = "bad";' }, { noCheck: true, listFilesOnly: true });
    expect(await analyzeCorsaModuleInitializationOrder(options)).toMatchObject({ evidence: "unknown", unknowns: expect.arrayContaining([expect.objectContaining({ kind: "typescript-error" })]) });
  });
  it("retains a failed conditional CFG proof", async () => {
    const options = setup({ "entry.mts": 'const flag = Math.random() > .5; if (flag) await Promise.resolve(); export {};' });
    expect(await analyzeCorsaModuleInitializationOrderV2({ ...options, proofBudget: { moduleControlFlowIterations: 1 } }))
      .toMatchObject({ evidence: "unknown", unknowns: expect.arrayContaining([expect.objectContaining({ kind: "module-control-flow-proof" })]) });
  });
  it("resolves tsconfig path mappings through Corsa", async () => {
    const options = setup({ "entry.mts": 'import "mapped";', "dep.mts": 'export const value = 1;' }, { paths: { mapped: ["./dep.mts"] } });
    const result = await analyzeCorsaModuleInitializationOrder(options);
    expect(result.evidence).toBe("verified");
    expect(result.modules.map(module => module.fileName)).toEqual([join(options.entryFile, "..", "dep.mts"), options.entryFile]);
  });
  it("validates options before accessing a missing native compiler", async () => {
    await expect(analyzeCorsaModuleInitializationOrderV2({ entryFile: "missing.mts", proofBudget: { moduleControlFlowIterations: 0 } })).rejects.toThrow(RangeError);
  });
  it("does not fall back when the native compiler is missing", async () => {
    const options = setup({ "entry.mts": 'export {};' });
    await expect(analyzeCorsaModuleInitializationOrder({ ...options, corsaExecutable: join(root, "missing") })).rejects.toThrow();
  });
  it("runs both CLI schemas with JavaScript TypeScript imports blocked", () => {
    const options = setup({ "entry.mts": 'const flag = Math.random() > .5; if (flag) await Promise.resolve(); export {};' });
    const script = `
      import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('JavaScript compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const { runCli } = await import('./src/cli/cli-runner.ts');
      for (const [version, code, evidence] of [['1', 1, 'unknown'], ['2', 0, 'verified']]) {
        let output = '';
        const actual = await runCli(['module-order', ${JSON.stringify(options.entryFile)}, '--project', ${JSON.stringify(options.configFile)}, '--schema-version', version, '--require'], { out(value) { output += value; }, err() {} });
        assert.equal(actual, code); assert.equal(JSON.parse(output).evidence, evidence);
      }
    `;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000, stdio: "pipe" });
  });
});

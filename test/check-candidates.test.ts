import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceNeedsOwnershipAnalysis } from "../src/check.js";

function candidate(sourceText: string): boolean {
  const fileName = "/fixture.ts";
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2024,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, fresh) => name === fileName
    ? ts.createSourceFile(name, sourceText, languageVersion, true, ts.ScriptKind.TS)
    : original(name, languageVersion, onError, fresh);
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => name === fileName ? sourceText : ts.sys.readFile(name);
  const program = ts.createProgram([fileName], options, host);
  return sourceNeedsOwnershipAnalysis(program, program.getSourceFile(fileName)!);
}

describe("check domain candidates", () => {
  it("does not start ownership analysis for unrelated slice spellings", () => {
    expect(candidate(`export const trim = (value: string) => value.slice(1)`)).toBe(false);
    expect(candidate(`const helper = { slice() {} }; helper.slice()`)).toBe(false);
  });

  it("starts ownership analysis for authenticated transfer and buffer operations", () => {
    expect(candidate(`export const clone = (value: object) => structuredClone(value)`)).toBe(true);
    expect(candidate(`export const view = (buffer: ArrayBuffer) => new DataView(buffer)`)).toBe(true);
    expect(candidate(`export const part = (value: Uint8Array) => value.subarray(1)`)).toBe(true);
  });
});

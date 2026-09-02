import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { resolveStableCallableSymbol } from "../src/stable-callable.js";

describe("stable callable identity", () => {
  it("resolves const aliases and authenticated frozen properties to the source symbol", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-stable-callable-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export {}
        function source() {}
        const alias = source
        const table = Object.freeze({ source, renamed: alias })
        let mutable = source
        alias()
        table.source()
        table["renamed"]()
        mutable()
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const checker = program.getTypeChecker();
      const source = program.getSourceFile(fileName)!;
      const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "source")!;
      const expected = checker.getSymbolAtLocation(declaration.name!)!;
      const calls = source.statements.filter(ts.isExpressionStatement)
        .map((statement) => statement.expression).filter(ts.isCallExpression);
      expect(calls.slice(0, 3).map((call) => resolveStableCallableSymbol(checker, call.expression))).toEqual([
        expected, expected, expected,
      ]);
      expect(resolveStableCallableSymbol(checker, calls[3]!.expression)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a same-spelled user freeze function", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-stable-callable-shadow-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export {}
        function source() {}
        const Object = { freeze<T>(value: T): T { return value } }
        const table = Object.freeze({ source })
        table.source()
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const checker = program.getTypeChecker();
      const source = program.getSourceFile(fileName)!;
      const call = (source.statements.at(-1) as ts.ExpressionStatement).expression as ts.CallExpression;
      expect(resolveStableCallableSymbol(checker, call.expression)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { resolvedSymbol, symbolIdentityKey } from "../src/binding-identity.js";

describe("binding identity", () => {
  it("separates shadowed bindings without depending on their spelling", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-binding-identity-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        const value = 1
        { const value = 2; void value }
        void value
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const source = program.getSourceFile(fileName)!;
      const checker = program.getTypeChecker();
      const uses: ts.Identifier[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isVoidExpression(node) && ts.isIdentifier(node.expression)) uses.push(node.expression);
        ts.forEachChild(node, visit);
      };
      visit(source);
      const keys = uses.map((node) => symbolIdentityKey(resolvedSymbol(checker, node)));
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys.every(Boolean)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

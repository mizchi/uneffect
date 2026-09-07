import { execFileSync } from "node:child_process";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { fromTypeScriptDiagnostic } from "../src/support/diagnostics.js";

describe("compiler-independent diagnostic formatting", () => {
  it.each([0, 1, 2, 3])("preserves category %i, nested messages and UTF-16 lines", category => {
    const text = "// 😀\r\nconst value = 1;\u2028value;", start = text.lastIndexOf("value");
    const file = ts.createSourceFile("input.ts", text, ts.ScriptTarget.Latest);
    const message: ts.DiagnosticMessageChain = { messageText: "outer", category, code: 2322, next: [
      { messageText: "inner", category, code: 1, next: [{ messageText: "leaf", category, code: 2 }] },
      { messageText: "sibling", category, code: 3 },
    ] };
    const result = fromTypeScriptDiagnostic({ file, start, category, code: 2322, messageText: message }, "semantic");
    expect(result.line).toBe(file.getLineAndCharacterOfPosition(start).line + 1);
    expect(result.severity).toBe(category === ts.DiagnosticCategory.Warning ? "warning" : "error");
    expect(result.notes?.[0]?.detail).toBe(ts.flattenDiagnosticMessageText(message, "\n"));
  });
  it("formats diagnostic data without loading the JavaScript compiler", () => {
    const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
      registerHooks({ resolve(specifier, context, next) {
        if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden: ' + specifier);
        return next(specifier, context);
      } });
      const { fromTypeScriptDiagnostic, formatDiagnostics } = await import('./src/support/diagnostics.ts');
      const value = fromTypeScriptDiagnostic({category: 1, code: 2322, messageText: 'wrong type', file: {fileName: 'input.ts', text: '// comment\\nvalue'}, start: 11}, 'semantic');
      assert.equal(value.line, 2); assert.match(formatDiagnostics([value]), /typescript\\/semantic input.ts:2/);`;
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 30_000, stdio: "pipe" });
  });
  it("preserves line attribution at every offset, including inside CRLF", () => {
    const text = "😀\r\nline\rnext\nlast\u2028end\u2029", file = ts.createSourceFile("input.ts", text, ts.ScriptTarget.Latest);
    for (let start = 0; start <= text.length; start++) {
      expect(fromTypeScriptDiagnostic({ file, start, category: 1, code: 1, messageText: "error" }, "syntax").line, String(start))
        .toBe(file.getLineAndCharacterOfPosition(start).line + 1);
    }
  });
});

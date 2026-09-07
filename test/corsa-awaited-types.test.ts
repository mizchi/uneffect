import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";
import { openCorsaCallableFrontend } from "../src/frontends/corsa/corsa-callable-frontend.js";

const cases = [
  ["plain", "number"], ["promise", "Promise<number>"], ["nested", "Promise<PromiseLike<number>>"],
  ["thenable", "{ then(done: (value: string) => unknown): void }"],
  ["union", "Promise<number> | string | null | undefined"], ["any", "any"], ["unknown", "unknown"],
  ["never", "never"], ["nonCallableThen", "{ then: number; value: string }"],
  ["resource", "Promise<{ [Symbol.dispose](): void }>"],
] as const;
const text = cases.map(([name, type]) => `export async function ${name}(input: ${type}) { return await input; }`).join("\n")
  + '\nexport async function generic<T>(input: T) { return await input; }\n'
  + 'export async function constrained<T extends PromiseLike<number>>(input: T) { return await input; }\n';
async function project(source: string, run: (file: string, configFile: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-awaited-")), file = join(directory, "input.ts"), configFile = join(directory, "tsconfig.json");
  writeFileSync(file, source);
  writeFileSync(configFile, JSON.stringify({ compilerOptions: { strict: true, target: "ESNext", module: "NodeNext", types: [] }, files: [file] }));
  try { await run(file, configFile); } finally { rmSync(directory, { recursive: true, force: true }); }
}
describe("native awaited expression gate", () => {
  it("preserves checker awaited types across promises, thenables, unions, generics and resources", async () => {
    await project(text, async (file, configFile) => {
      const frontend = await openCorsaCallableFrontend({ configFile });
      try {
        expect(frontend.getProjectDiagnostics()).toEqual([]);
        const program = ts.createProgram([file], { strict: true, target: ts.ScriptTarget.ESNext, types: [] });
        const checker = program.getTypeChecker(), source = program.getSourceFile(file)!;
        let seen = 0;
        const visit = (node: ts.Node): void => {
          if (ts.isAwaitExpression(node)) {
            const original = checker.getAwaitedType(checker.getTypeAtLocation(node.expression));
            const actual = frontend.getAwaitedExpressionType(file, { start: node.getStart(source), end: node.end }, text);
            expect(actual?.texts[0], node.parent.parent.getText(source)).toBe(checker.typeToString(original!));
            if (seen === 0) expect(frontend.getPrimitiveTypeKind(actual!)).toBe("number");
            seen++;
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        expect(seen).toBe(cases.length + 2);
      } finally { frontend.close(); }
    });
  });
  it.each([
    "export async function f(x: { then?: (done: (value: number) => unknown) => void }) { return await x; }",
    "interface Bad { then(done: (value: Bad) => unknown): void } export async function f(x: Bad) { return await x; }",
    "export async function f(x: { then(done: number): void }) { return await x; }",
  ])("keeps invalid and recursive thenables behind native diagnostics", async source => {
    await project(source, async (file, configFile) => {
      const frontend = await openCorsaCallableFrontend({ configFile });
      try { expect(frontend.getProjectDiagnostics().some(item => item.category === "error" && [1062, 1320].includes(item.code))).toBe(true); }
      finally { frontend.close(); }
    });
  });
  it("rejects ordinary expressions and mismatched sources rather than pretending to unwrap arbitrary types", async () => {
    await project(text, async (file, configFile) => {
      const frontend = await openCorsaCallableFrontend({ configFile });
      try {
        const start = text.indexOf("await input");
        expect(frontend.getAwaitedExpressionType(file, { start: start + 6, end: start + 11 }, text)).toBeNull();
        expect(() => frontend.getAwaitedExpressionType(file, { start, end: start + 11 }, text + "\n")).toThrow(/snapshot/);
      } finally { frontend.close(); }
    });
  });
  it("queries awaited types without loading the JS compiler", async () => {
    await project(text, async (file, configFile) => {
      const script = `import { registerHooks } from 'node:module'; import assert from 'node:assert/strict';
        registerHooks({ resolve(specifier, context, next) { if (/^(?:typescript(?:\\/|$)|@typescript\\/typescript6(?:\\/|$))/.test(specifier)) throw new Error('compiler forbidden'); return next(specifier, context); } });
        const { openCorsaCallableFrontend } = await import('./src/frontends/corsa/corsa-callable-frontend.ts');
        const f = await openCorsaCallableFrontend({ configFile: ${JSON.stringify(configFile)} });
        try { assert.equal(f.getProjectDiagnostics().length, 0); assert.equal(f.getAwaitedExpressionType(${JSON.stringify(file)}, ${JSON.stringify({ start: text.indexOf("await input"), end: text.indexOf("await input") + 11 })}, ${JSON.stringify(text)}).texts[0], 'number'); } finally { f.close(); }`;
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: "pipe", timeout: 30_000 });
    });
  });
});

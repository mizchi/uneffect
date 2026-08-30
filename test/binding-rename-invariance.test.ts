import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeAbortableFetchesInProgram } from "../src/abortable-fetch-product.js";
import { analyzeOwnership } from "../src/ownership.js";
import { analyzeReactSemanticsInProgram } from "../src/react-semantics.js";
import { verifyTypedArraySafetyInTypeScriptProgram } from "../src/typed-array-safety.js";

function programFor(directory: string, name: string, text: string, jsx = false): { program: ts.Program; source: ts.SourceFile } {
  const fileName = join(directory, `${name}.${jsx ? "tsx" : "ts"}`);
  writeFileSync(fileName, text);
  const program = ts.createProgram([fileName], {
    target: ts.ScriptTarget.ES2024, jsx: jsx ? ts.JsxEmit.Preserve : undefined,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
  });
  return { program, source: program.getSourceFile(fileName)! };
}

describe("binding rename invariance", () => {
  it("preserves Program-backed semantics across local renames", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-rename-invariance-"));
    try {
      const variants = ["alpha", "bravo"] as const;
      const abort = variants.map((binding, index) => {
        const { program, source } = programFor(directory, `abort-${index}`, `
          function main(cancel: boolean) {
            const ${binding} = new AbortController()
            const signal = ${binding}.signal
            const request = fetch("https://example.com", { signal })
            if (cancel) ${binding}.abort("stop")
            return request
          }
        `);
        const result = analyzeAbortableFetchesInProgram(program, source);
        return result.fetches.map(({ binding: promise, signalKind, abortConditional, evidence }) => ({ promise, signalKind, abortConditional, evidence }));
      });
      expect(abort[0]).toEqual(abort[1]);

      const numeric = await Promise.all(variants.map((binding, index) => {
        const { program, source } = programFor(directory, `numeric-${index}`, `
          type BoundedUint8Array<N extends number> = Uint8Array
          function write(${binding}: BoundedUint8Array<4>) { ${binding}[3] = 255 }
        `);
        return verifyTypedArraySafetyInTypeScriptProgram(program, source).then(({ obligations }) =>
          obligations.map(({ kind, result, goal }) => ({ kind, result, goal: goal.replaceAll(binding, "<binding>") })));
      }));
      expect(numeric[0]).toEqual(numeric[1]);

      const ownership = variants.map((binding, index) => {
        const { program, source } = programFor(directory, `ownership-${index}`, `
          function move(${binding}: ArrayBuffer) {
            structuredClone({}, { transfer: [${binding}] })
            return ${binding}.byteLength
          }
        `);
        return analyzeOwnership(program, source).map(({ operation, state }) => ({ operation, state }));
      });
      expect(ownership[0]).toEqual(ownership[1]);

      const react = variants.map((binding, index) => {
        const { program, source } = programFor(directory, `react-${index}`, `
          declare namespace JSX { interface IntrinsicElements { button: { onClick?: () => void } } }
          /* uneffect:react-component */
          function Panel() {
            const ${binding} = () => fetch("/event")
            return <button onClick={${binding}} />
          }
        `, true);
        const result = analyzeReactSemanticsInProgram(program, source);
        return { phases: result.components[0]?.phases, diagnostics: result.diagnostics.map(({ kind, phase }) => ({ kind, phase })) };
      });
      expect(react[0]).toEqual(react[1]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

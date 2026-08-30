import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeAbortableFetchesInProgram, generateAbortableFetchProductQuint } from "../src/abortable-fetch-product.js";

describe("abortable fetch product", () => {
  it("connects fetch completion, rejection, and a conditional controller abort", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-abortable-fetch-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        export async function main(cancel: boolean) {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/data", { signal: controller.signal })
          if (cancel) controller.abort("stop")
          return await request
        }
        const local = { fetch(_url: string, _options: object) { return Promise.resolve("local") } }
        local.fetch("local", {})
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeAbortableFetchesInProgram(program, program.getSourceFile(fileName)!);
      expect(analysis.fetches).toEqual([
        expect.objectContaining({ owner: "main", binding: "request", url: '"https://api.example.com/data"', controller: "controller", evidence: "exact" }),
      ]);
      expect(analysis.unknown).toEqual([]);
      const quint = generateAbortableFetchProductQuint("abortable_fetch", analysis);
      expect(quint).toContain("action abort_0");
      expect(quint).toContain("action fulfill_fetch_0");
      expect(quint).toContain("action reject_fetch_0");
      expect(quint).toContain("fetch_0_state' = 3");
      const quintFile = join(directory, "model.qnt");
      writeFileSync(quintFile, quint);
      expect(spawnSync("quint", ["typecheck", quintFile], { encoding: "utf8" })).toMatchObject({ status: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

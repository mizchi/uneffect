import { globSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeProgramEffects } from "../src/effects.js";

describe("Uneffect dogfood", () => {
  it("analyzes its own implementation without diagnostics or unknown summaries in inference mode", () => {
    const program = ts.createProgram(globSync("src/*.ts"), {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      lib: ["lib.es2024.d.ts", "lib.dom.d.ts"],
      types: ["node"],
      noEmit: true,
    });
    const result = analyzeProgramEffects(program, { requireAnnotations: false });
    expect(result.summaries.length).toBeGreaterThan(200);
    expect(result.diagnostics).toEqual([]);
    expect(result.summaries.filter((summary) => summary.evidence === "unknown")).toEqual([]);
  }, 20_000);
});

import ts from "@typescript/typescript6";
import { bench, describe } from "vitest";
import { analyzeModuleInitializationOrderV2 } from "../src/modules/module-initialization-v2.js";

const fileName = "examples/dogfood/module-conditional-tla.ts";
const program = ts.createProgram([fileName], {
  target: ts.ScriptTarget.ES2024,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  types: ["node"],
  noEmit: true,
});
// Prime the compiler so the measurement isolates warm analysis and its domain.
analyzeModuleInitializationOrderV2(program, fileName);

describe("module initialization v2", () => {
  bench("warm conditional await with a mandatory-resumption obligation", () => {
    const result = analyzeModuleInitializationOrderV2(program, fileName);
    const proof = result.modules[0]?.controlFlow?.proof;
    if (result.evidence !== "verified" || proof?.status !== "converged" || proof.iterations > proof.budget.limit) {
      throw new Error("conditional module domain benchmark did not verify within its budget");
    }
  }, { time: 500, iterations: 20 });
});

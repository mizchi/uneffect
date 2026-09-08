import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BasicBlockFixedPointOptions } from "../src/cfg/index.js";
import { analyzeModuleInitializationOrderV2 } from "./oracles/typescript-module-order-v2.js";

const fault = vi.hoisted(() => ({ mode: "none", solverStatus: "" }));
vi.mock("../src/cfg/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/cfg/index.js")>();
  return {
    ...original,
    solveBasicBlockFixedPoint<Value>(options: BasicBlockFixedPointOptions<Value>) {
      // Mutate topology and transfers together, then run the real fixed-point
      // engine. No solver result or domain postcondition is fabricated.
      const blocks = options.blocks.map((block) => {
        if (fault.mode === "bypass-resume" && block.id.endsWith("#suspend:0")) {
          const redirect = (to: string) => to.replace(/#resume:0$/, "#join:0");
          return { ...block,
            edges: block.edges.map((edge) => ({ ...edge, to: redirect(edge.to) })),
            transfer: (input: Value) => block.transfer(input).map((item) => ({ ...item, to: redirect(item.to) })),
          };
        }
        if (fault.mode === "missing-false" && block.id.endsWith("#branch:0")) {
          return { ...block,
            edges: block.edges.filter((edge) => !edge.to.endsWith("#join:0")),
            transfer: (input: Value) => block.transfer(input).filter((item) => !item.to.endsWith("#join:0")),
          };
        }
        if (fault.mode === "rejection-join" && block.id.endsWith("#reject:0")) {
          const to = block.id.replace(/#reject:0$/, "#join:0");
          return { ...block, edges: [{ to, completion: "normal" as const }], transfer: (input: Value) => [{ to, value: input }] };
        }
        return block;
      });
      const result = original.solveBasicBlockFixedPoint({ ...options, blocks });
      fault.solverStatus = result.status;
      return result;
    },
  };
});

let directory: string, entry: string, dependency: string, program: ts.Program;
beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "uneffect-module-domain-"));
  entry = join(directory, "entry.mts"); dependency = join(directory, "dependency.mts");
  writeFileSync(dependency, readFileSync("examples/dogfood/module-conditional-tla.ts", "utf8"));
  writeFileSync(entry, 'import { cacheState } from "./dependency.mjs"; console.log(cacheState)');
  program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"], noEmit: true,
  });
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));
beforeEach(() => { fault.mode = "none"; fault.solverStatus = ""; });

describe("conditional module domain obligations", () => {
  it("retains the admitted dogfood result with the real solver", () => {
    expect(analyzeModuleInitializationOrderV2(program, entry).evidence).toBe("verified");
    expect(fault.solverStatus).toBe("converged");
  });
  it.each(["bypass-resume", "missing-false", "rejection-join"])("rejects converged %s lowering without changing the application", (mode) => {
    const baseline = analyzeModuleInitializationOrderV2(program, entry);
    fault.mode = mode;
    const result = analyzeModuleInitializationOrderV2(program, entry);
    expect(fault.solverStatus).toBe("converged");
    expect(result.compiler).toEqual(baseline.compiler);
    expect(result.evidence).toBe("unknown");
    expect(result.unknowns).toContainEqual(expect.objectContaining({ kind: "module-control-flow-proof" }));
    expect(result.modules.find((module) => module.fileName === dependency)?.controlFlow?.proof)
      .toMatchObject({ status: "unknown", reason: "domain-postcondition-failed" });
  });
});

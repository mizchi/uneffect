import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { solveBasicBlockFixedPoint, finallyCompletions, completionSet, type BasicBlockFixedPointOptions } from "../src/cfg/index.js";

// A consumer-owned availability analysis. No TypeScript AST, effect labels,
// source files, solver backend, or Uneffect contract is involved.
function availability(): BasicBlockFixedPointOptions<ReadonlySet<string>> {
  return {
    entry: "entry", initial: new Set(["input"]), budget: { name: "availability", limit: 16 },
    lattice: {
      bottom: () => new Set(),
      equivalent: (a, b) => a.size === b.size && [...a].every((key) => b.has(key)),
      join: (a, b) => ({ status: "joined", value: new Set([...a, ...b]) }),
    },
    blocks: [
      { id: "entry", edges: [{ to: "loop", completion: "normal" }], transfer: (value) => [{ to: "loop", value }] },
      { id: "loop", edges: [{ to: "loop", completion: "normal", role: "back-edge" }, { to: "exit", completion: "normal" }],
        transfer: (input) => {
          const value = new Set([...input, "visited"]);
          return [{ to: "loop", value }, { to: "exit", value }];
        } },
      { id: "exit", edges: [], transfer: () => [] },
    ],
  };
}

describe("standalone CFG API", () => {
  it("rejects duplicate empty block IDs before invoking domain callbacks", () => {
    const result = solveBasicBlockFixedPoint({
      entry: "", initial: 0, budget: { name: "duplicate-empty-id", limit: 4 },
      lattice: {
        bottom: () => { throw new Error("invalid topology must not invoke callbacks"); },
        equivalent: (a: number, b: number) => a === b,
        join: (a: number, b: number) => ({ status: "joined" as const, value: Math.max(a, b) }),
      },
      blocks: [{ id: "", edges: [], transfer: () => [] }, { id: "", edges: [], transfer: () => [] }],
    });
    expect(result).toMatchObject({ status: "unknown", reason: "invalid-cfg", iterations: 0 });
  });
  it("solves a consumer-defined domain with a cycle", () => {
    const result = solveBasicBlockFixedPoint(availability());
    expect(result.status).toBe("converged");
    expect([...result.states.get("exit")!].sort()).toEqual(["input", "visited"]);
  });
  it("accepts consumer-defined edge labels without a language completion enum", () => {
    const options: BasicBlockFixedPointOptions<number, "available"> = {
      entry: "source", initial: 1, budget: { name: "consumer-labels", limit: 4 },
      lattice: { bottom: () => 0, equivalent: (a, b) => a === b, join: (a, b) => ({ status: "joined", value: Math.max(a, b) }) },
      blocks: [
        { id: "source", edges: [{ to: "sink", completion: "available" }], transfer: (value) => [{ to: "sink", value }] },
        { id: "sink", edges: [], transfer: () => [] },
      ],
    };
    const result = solveBasicBlockFixedPoint(options);
    expect(result.status).toBe("converged");
    expect(result.states.get("sink")).toBe(1);
  });
  it("does not promote a budget-exhausted analysis to convergence", () => {
    const input = availability();
    expect(solveBasicBlockFixedPoint({ ...input, budget: { name: "bounded", limit: 1 } }))
      .toMatchObject({ status: "unknown", reason: "proof-budget-exhausted" });
  });
  it("keeps finally precedence available without a frontend", () => {
    expect(finallyCompletions(completionSet({ completion: "return" }), completionSet({ completion: "throw" })))
      .toEqual([{ completion: "throw" }]);
  });
  it("has a package subpath and no imports outside its own directory", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    expect(manifest.exports["./cfg"]).toEqual({ types: "./dist/src/cfg/index.d.ts", import: "./dist/src/cfg/index.js" });
    for (const file of readdirSync("src/cfg").filter((file) => file.endsWith(".ts"))) {
      const source = readFileSync(join("src/cfg", file), "utf8");
      for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g)) {
        expect(specifier, `${file} must not depend on a compiler, host, or Uneffect domain`).toMatch(/^\.\/[^/]+\.js$/);
      }
    }
  });
});

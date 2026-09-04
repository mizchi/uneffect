import { describe, expect, it } from "vitest";
import {
  analyzeTypeScriptControlFlow,
  parseTypeScriptControlFlowAnalysis,
  typescriptControlFlowSchema,
} from "../src/typescript-control-flow.js";

describe("TypeScript control-flow artifact contract", () => {
  const source = `
    type Kind = "left" | "right";
    function exhaustive(kind: Kind): number {
      switch (kind) { case "left": return 1; case "right": return 2; }
    }
    function open(flag: boolean): number { if (flag) return 1; return 2 }
    let mutable = (value: number): number => value;
    const unknown = (): void => {};
  `;

  it("publishes endpoint coverage without exposing internal graph representation", () => {
    const result = analyzeTypeScriptControlFlow("coverage.ts", source);
    expect(result.schema).toBe(typescriptControlFlowSchema);
    expect(result.coverage).toEqual({
      domain: "function-endpoints", status: "partial", observed: 4, supported: 2, unknown: 2,
    });
    expect(result.sources).toEqual([
      { fileName: "coverage.ts", length: source.length, digest: expect.stringMatching(/^[0-9a-f]{64}$/u) },
    ]);
    expect(result.functions.every(({ fileName }) => fileName === "coverage.ts")).toBe(true);
    expect(result.exclusions).toEqual(expect.arrayContaining([
      expect.objectContaining({ functionName: "mutable", reasons: ["mutable-binding"] }),
      expect.objectContaining({ functionName: "unknown", reasons: ["endpoint-not-established"] }),
    ]));
    expect(result).not.toHaveProperty("blocks");
    expect(result).not.toHaveProperty("edges");
    expect(parseTypeScriptControlFlowAnalysis(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });

  it("rejects forged counts, exclusions, parity, and unknown fields", () => {
    const result = analyzeTypeScriptControlFlow("coverage.ts", source);
    expect(() => parseTypeScriptControlFlowAnalysis({ ...result, invented: true })).toThrow(/unknown key/u);
    expect(() => parseTypeScriptControlFlowAnalysis({
      ...result, coverage: { ...result.coverage, supported: result.coverage.supported + 1 },
    })).toThrow(/coverage/u);
    expect(() => parseTypeScriptControlFlowAnalysis({ ...result, exclusions: [] })).toThrow(/exclusions/u);
    expect(() => parseTypeScriptControlFlowAnalysis({ ...result, sourceDigest: "0".repeat(64) })).toThrow(/sourceDigest/u);
    expect(() => parseTypeScriptControlFlowAnalysis({
      ...result,
      compilerOptions: { ...result.compilerOptions, noImplicitReturns: false },
      configurationCompatible: false,
    })).toThrow(/configuration evidence/u);
    expect(() => parseTypeScriptControlFlowAnalysis({
      ...result,
      functions: result.functions.map((fn) => fn.name === "exhaustive"
        ? {
            ...fn,
            endpoint: "reachable" as const,
            parity: fn.neutralEndpoint === "reachable" ? "agree" as const : "typescript-refines" as const,
          }
        : fn),
    })).toThrow(/endpoint evidence/u);
    expect(() => parseTypeScriptControlFlowAnalysis({
      ...result,
      functions: result.functions.map((fn) => fn.name === "exhaustive" ? { ...fn, parity: "unknown" } : fn),
    })).toThrow(/parity/u);
  });
});

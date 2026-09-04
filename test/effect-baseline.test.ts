import { describe, expect, it } from "vitest";
import {
  compareEffectBaseline,
  createEffectBaseline,
  parseEffectBaseline,
  type EffectBaselineSummary,
} from "../src/effect-baseline.js";

const summary = (overrides: Partial<EffectBaselineSummary> = {}): EffectBaselineSummary => ({
  fileName: "/repo/src/main.ts",
  span: { start: 20, end: 40 },
  functionName: "main",
  effects: [],
  evidence: "inferred",
  ...overrides,
});

describe("effect regression baseline", () => {
  it("detects newly inferred effects without requiring a source annotation", () => {
    const baseline = createEffectBaseline([summary()], { cwd: "/repo" });
    const assessment = compareEffectBaseline(baseline, [summary({
      effects: ["Console", "Fetch<https://api.example.com>"],
    })], { cwd: "/repo" });

    expect(assessment.status).toBe("failed");
    expect(assessment.regressions).toEqual([
      expect.objectContaining({
        kind: "effect-expansion",
        fileName: "src/main.ts",
        functionName: "main",
        added: ["Console", "Fetch<https://api.example.com>"],
      }),
    ]);
  });

  it("uses a function occurrence instead of source offsets as the stable identity", () => {
    const baseline = createEffectBaseline([
      summary({ span: { start: 20, end: 40 }, effects: ["Console"] }),
      summary({ span: { start: 60, end: 80 }, effects: ["Fetch"] }),
    ], { cwd: "/repo" });
    const assessment = compareEffectBaseline(baseline, [
      summary({ span: { start: 120, end: 140 }, effects: ["Console"] }),
      summary({ span: { start: 160, end: 180 }, effects: ["Fetch"] }),
    ], { cwd: "/repo" });

    expect(assessment).toMatchObject({ status: "passed", regressions: [] });
  });

  it("detects new fail-closed reasons and effectful new functions", () => {
    const baseline = createEffectBaseline([summary()], { cwd: "/repo" });
    const assessment = compareEffectBaseline(baseline, [
      summary({ evidence: "unknown", unknownReasons: [{ code: "unresolved-call", message: "opaque" }] }),
      summary({ functionName: "audit", span: { start: 100, end: 120 }, effects: ["Console"] }),
    ], { cwd: "/repo" });

    expect(assessment.regressions).toEqual([
      expect.objectContaining({ kind: "new-unknown", functionName: "main", added: ["unresolved-call"] }),
      expect.objectContaining({ kind: "new-effectful-function", functionName: "audit", added: ["Console"] }),
    ]);
  });

  it("rejects malformed or duplicate baseline entries", () => {
    expect(() => parseEffectBaseline({ schema: "uneffect-effect-baseline/v0", entries: [] }))
      .toThrow("unsupported effect baseline schema");
    expect(() => parseEffectBaseline({
      schema: "uneffect-effect-baseline/v1",
      uneffectVersion: "0.3.0",
      entries: [
        { fileName: "src/main.ts", functionName: "main", occurrence: 0, effects: [], unknownReasons: [] },
        { fileName: "src/main.ts", functionName: "main", occurrence: 0, effects: [], unknownReasons: [] },
      ],
    })).toThrow("duplicate effect baseline entry");
  });

  it("requires review after the analyzer version changes", () => {
    const baseline = createEffectBaseline([summary()], { cwd: "/repo" });
    baseline.uneffectVersion = "0.2.1";
    expect(compareEffectBaseline(baseline, [summary()], { cwd: "/repo" }).regressions)
      .toContainEqual(expect.objectContaining({ kind: "tool-version-mismatch", added: ["0.3.0"] }));
  });
});

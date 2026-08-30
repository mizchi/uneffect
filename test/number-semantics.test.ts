import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeNumberSemanticsInProgram } from "../src/number-semantics.js";

describe("bounded IEEE-754 facts", () => {
  it("distinguishes exact NaN, infinities, negative zero, and fround results", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-number-semantics-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        const nan = NaN
        const numberNan = Number.NaN
        const positive = Infinity
        const negative = Number.NEGATIVE_INFINITY
        const negativeZero = -0
        const rounded = Math.fround(1 / 3)
        const roundedNegativeZero = Math.fround(-0)
        function shadowed(NaN: number, Math: { fround(value: number): number }) {
          const unknownNan = NaN
          const unknownRound = Math.fround(1)
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const facts = analyzeNumberSemanticsInProgram(program, program.getSourceFile(fileName)!);
      expect(Object.fromEntries(facts.facts.filter(({ binding }) => binding).map((fact) => [fact.binding, fact.valueClass]))).toMatchObject({
        nan: "nan", numberNan: "nan", positive: "positive-infinity", negative: "negative-infinity",
        negativeZero: "negative-zero", rounded: "finite", roundedNegativeZero: "negative-zero",
        unknownNan: "unknown", unknownRound: "unknown",
      });
      expect(facts.facts.find(({ binding }) => binding === "rounded")).toMatchObject({
        operation: "Math.fround", exactValue: Math.fround(1 / 3), evidence: "exact",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

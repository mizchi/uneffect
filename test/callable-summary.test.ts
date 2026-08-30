import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parseEffectSet } from "../src/capabilities.js";
import { analyzeCallableSummaries, instantiateCallableSummary } from "../src/callable-summary.js";

describe("backend-neutral callable summaries", () => {
  it("summarizes callback cardinality, effect bounds, and completion conversion", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-callable-summary-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        /* uneffect:capability effect_parameter callback extends Console | Fetch */
        function once(callback: () => void) {
          const stable = callback
          stable()
        }
        function maybe(callback: () => void, enabled: boolean) {
          if (enabled) callback()
        }
        function many(callback: () => void, values: number[]) {
          for (const value of values) callback()
        }
        function builtins(values: number[], callback: (value: number) => void, promise: Promise<number>) {
          values.map(callback)
          promise.then(callback)
          setTimeout(callback, 0)
        }
      `);
      const program = ts.createProgram([fileName], {
        target: ts.ScriptTarget.ES2024, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const analysis = analyzeCallableSummaries(program);

      expect(analysis.diagnostics).toEqual([]);
      const once = analysis.summaries.find(({ name }) => name === "once");
      expect(once).toMatchObject({
        evidence: "inferred",
        callbackParameters: [{
          name: "callback", cardinality: "exactly-1", timing: "inline",
          completion: "propagate-throw", effectBound: ["Console", "Fetch"],
        }],
      });
      expect(instantiateCallableSummary(once!, new Map([[0, parseEffectSet("Console")]]))).toMatchObject({
        evidence: "inferred", violations: [], effects: [{ kind: "capability", name: "Console" }],
      });
      expect(instantiateCallableSummary(once!, new Map([[0, parseEffectSet("Clock")]]))).toMatchObject({
        evidence: "unknown", violations: [{ parameter: "callback", effect: "Clock" }],
      });
      expect(analysis.summaries.find(({ name }) => name === "maybe")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..1", timing: "inline" }));
      expect(analysis.summaries.find(({ name }) => name === "many")?.callbackParameters)
        .toContainEqual(expect.objectContaining({ name: "callback", cardinality: "0..n", timing: "inline" }));
      expect(analysis.summaries.find(({ name }) => name === "builtins")?.callbackInvocations).toEqual(expect.arrayContaining([
        expect.objectContaining({ api: "Array.prototype.map", cardinality: "0..n", timing: "inline", completion: "propagate-throw" }),
        expect.objectContaining({ api: "Promise.prototype.then", cardinality: "0..1", timing: "promise-reaction", completion: "convert-throw-to-rejection" }),
        expect.objectContaining({ api: "setTimeout", cardinality: "0..1", timing: "deferred", completion: "host-report-throw" }),
      ]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed for mutable callable aliases and dynamic callback dispatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-callable-unknown-"));
    try {
      const fileName = join(directory, "entry.ts");
      writeFileSync(fileName, `
        function unsafe(callback: () => void, alternate: () => void, enabled: boolean) {
          let selected = callback
          selected = alternate
          selected()
          ;(enabled ? callback : alternate)()
        }
      `);
      const program = ts.createProgram([fileName], { target: ts.ScriptTarget.ES2024, noEmit: true });
      const summary = analyzeCallableSummaries(program).summaries.find(({ name }) => name === "unsafe");
      expect(summary).toMatchObject({ evidence: "unknown" });
      expect(summary?.unknownReasons).toEqual(expect.arrayContaining(["mutable-callable-alias", "dynamic-callback-dispatch"]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

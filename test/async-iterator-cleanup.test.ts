import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeAsyncIteratorCleanup } from "../src/async-iterator-cleanup.js";
import { evaluateResourceProtocol } from "../src/resource-protocol.js";

function analyze(text: string) {
  return analyzeAsyncIteratorCleanup(ts.createSourceFile("entry.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
}

describe("async iterator cleanup", () => {
  it("separates exhaustion from abrupt AsyncIteratorClose scenarios", () => {
    const [cleanup] = analyze(`
      async function main(mode: string, values: AsyncIterable<number>) {
        for await (const value of values) {
          if (mode === "break") break
          if (mode === "return") return value
          if (mode === "throw") throw new Error("stop")
        }
      }
    `);
    expect(cleanup).toMatchObject({ owner: "main", iterable: "values", coverage: "reviewed-explicit-completions", unknownReasons: [] });
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted", "break", "return", "throw"]);
    expect(cleanup!.scenarios[0]).not.toHaveProperty("close");
    for (const item of cleanup!.scenarios.slice(1)) expect(item).toMatchObject({
      close: {
        lookupLane: "inline", resultLane: "microtask-if-present", method: "return-if-present",
        propertyAccessMayInvokeUserCode: true, failure: "reject",
      },
    });
    expect(cleanup!.scenarios.map(({ model }) => evaluateResourceProtocol(model).status)).toEqual([
      "satisfied", "satisfied", "satisfied", "satisfied",
    ]);
  });

  it("does not invent close edges for nested breaks or locally caught throws", () => {
    const [cleanup] = analyze(`
      async function main(values: AsyncIterable<number>) {
        for await (const value of values) {
          while (value > 0) { break }
          try { throw new Error("handled") } catch {}
        }
      }
    `);
    expect(cleanup!.scenarios.map(({ exit }) => exit)).toEqual(["exhausted"]);
  });

  it("ignores synchronous for-of and nested callable exits", () => {
    expect(analyze(`
      async function main(values: AsyncIterable<number>, sync: number[]) {
        for (const value of sync) break
        for await (const value of values) {
          const later = () => { throw new Error("later") }
          void later
        }
      }
    `)).toMatchObject([{ scenarios: [{ exit: "exhausted" }] }]);
  });

  it("tracks labeled outer break and nested async iterators independently", () => {
    const cleanups = analyze(`
      async function main(outerValues: AsyncIterable<number>, innerValues: AsyncIterable<number>) {
        outer: for await (const outerValue of outerValues) {
          for await (const innerValue of innerValues) {
            if (innerValue > outerValue) break outer
          }
        }
      }
    `);
    expect(cleanups.map(({ iterable, scenarios }) => [iterable, scenarios.map(({ exit }) => exit)])).toEqual([
      ["outerValues", ["exhausted", "break"]],
      ["innerValues", ["exhausted", "break"]],
    ]);
  });

  it("fails closed when finally can override an observed abrupt completion", () => {
    const [cleanup] = analyze(`
      async function main(values: AsyncIterable<number>) {
        for await (const value of values) {
          try { break } finally { if (value > 0) continue }
        }
      }
    `);
    expect(cleanup).toMatchObject({
      unknownReasons: ["abrupt-through-finally"],
      scenarios: [{ exit: "exhausted" }],
    });
  });
});

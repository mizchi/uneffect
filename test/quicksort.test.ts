import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { quicksort } from "../examples/quicksort.js";
import { analyzeEffects } from "../src/effects.js";

describe("quicksort dogfood", () => {
  it.each([
    { input: [] }, { input: [1] }, { input: [2, 1] },
    { input: [3, 1, 2] }, { input: [2, 1, 2, -1, 0] },
  ])("sorts in place while preserving duplicates: $input", ({ input }) => {
    const values = [...input];
    quicksort(values);
    expect(values).toEqual([...input].sort((left, right) => left - right));
  });

  it("needs only mutation authority for the input reference", () => {
    const fileName = fileURLToPath(new URL("../examples/quicksort.ts", import.meta.url));
    expect(analyzeEffects(fileName, readFileSync(fileName, "utf8"))).toEqual([]);
  });
});

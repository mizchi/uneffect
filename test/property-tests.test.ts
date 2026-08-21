import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkUneffectProperty, generateUneffectPropertyTests } from "../src/property-tests.js";

describe("property-test generation", () => {
  it("rejects unsupported parameter boundaries without pretending to generate coverage", () => {
    const result = generateUneffectPropertyTests({ files: { "value.ts": `/* uneffect: ensures result === value */ function identity(value: string) { return value }` } });
    expect(result.generatedFiles).toEqual({});
    expect(result.diagnostics[0]?.message).toContain("currently supports");
  });

  it("shrinks, persists, and prioritizes a replayable counterexample", async () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-property-"));
    const path = join(directory, "failure.json");
    try {
      const options = { functionName: "broken", domains: ["Int"] as const, cases: 20, counterexamplePath: path, property: async (value: number) => value <= 0 };
      const first = await checkUneffectProperty(options);
      expect(first).toMatchObject({ status: "counterexample", replayed: false, counterexample: { arguments: [1] } });
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: "uneffect-counterexample/v1", arguments: [1] });
      const replay = await checkUneffectProperty(options);
      expect(replay).toMatchObject({ status: "counterexample", replayed: true, tested: 1 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyContracts } from "../src/contracts.js";
import { analyzeEffects } from "../src/effects.js";
import { parseSpec } from "../src/spec-ir.js";
import { generateQuint } from "../src/spec-backends.js";

const documentationEntrypoints = [
  "README.md",
  "docs/README.md",
  "docs/quickstart.md",
  "docs/adoption-patterns.md",
] as const;

describe("documentation entrypoints", () => {
  it("keeps the public README in English", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).not.toMatch(/[\u3040-\u30ff\u3400-\u9fff]/u);
    expect(readme).toContain("[Quickstart guide](./docs/quickstart.md)");
    expect(readme).toContain("[Adoption patterns guide](./docs/adoption-patterns.md)");
  });

  it.each(documentationEntrypoints)("resolves local Markdown links in %s", (fileName) => {
    const markdown = readFileSync(fileName, "utf8");
    const targets = [...markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
      .map((match) => match[1]!)
      .filter((target) => !target.startsWith("http") && !target.startsWith("#"))
      .map((target) => target.split("#", 1)[0]!);
    for (const target of targets) {
      expect(existsSync(resolve(dirname(fileName), target)), `${fileName} links to missing ${target}`).toBe(true);
    }
  });

  it("keeps the checked quickstart example inside the verified fragments", async () => {
    const fileName = "examples/quickstart.ts";
    const source = readFileSync(fileName, "utf8");
    expect(analyzeEffects(fileName, source)).toEqual([]);
    await expect(verifyContracts(fileName, source)).resolves.toEqual([]);
  });

  it("keeps the quickstart temporal example lowerable to Quint", () => {
    const fileName = "examples/quickstart-model.ts";
    const source = readFileSync(fileName, "utf8");
    const spec = parseSpec(fileName, source).temporal;
    expect(generateQuint("quickstart", spec)).toContain("module quickstart");
  });
});

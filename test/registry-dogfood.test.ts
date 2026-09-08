import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const corpus = JSON.parse(readFileSync("dogfood/registry-cases.json", "utf8")) as {
  cases: Array<{ fileName: string; functionName: string; registry: string; flow?: "expression" | "statement"; expected: "clean" | "findings" | "unknown"; expectedDetail?: string }>;
};

describe("registry policy on additional actual source", () => {
  it.each(corpus.cases)("$fileName / $functionName / $registry", item => {
    const result = spawnSync(process.execPath, ["--import", resolve("test/hooks/install-reject-js-typescript.mjs"),
      "--import", "tsx", "src/cli/index.ts", "cfg-lint", item.fileName, item.functionName,
      "--registry", item.registry, "--flow", item.flow ?? "expression", "--project", "tsconfig.json"], { encoding: "utf8", timeout: 60_000 });
    expect(result.error).toBeUndefined();
    const report = JSON.parse(result.stdout);
    expect(report.status, result.stdout + result.stderr).toBe(item.expected);
    expect(result.status).toBe(item.expected === "clean" ? 0 : item.expected === "findings" ? 1 : 2);
    if (item.expected === "findings") {
      expect(report.diagnostics).toHaveLength(1);
      expect(report.diagnostics[0].location.fileName).toBe(resolve(item.fileName));
    }
    if (item.expected === "unknown") {
      expect(report.reason).toBe("unsupported-source");
      expect(report).not.toHaveProperty("diagnostics");
      if (item.expectedDetail) expect(report.detail).toBe(item.expectedDetail);
    }
  });
});

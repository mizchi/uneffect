import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/cli-runner.js";

async function run(args: string[]) {
  let stdout = "", stderr = "";
  const code = await runCli(["cfg-lint", ...args], { out: value => { stdout += value; }, err: value => { stderr += value; } });
  return { code, stdout, stderr };
}
describe("cfg-lint CLI prototype", () => {
  const fixture = "examples/dogfood/cfg-lint-initialization.ts";
  it.each([
    ["ready", 0, "clean"], ["branchMissing", 1, "findings"], ["unsupportedCallback", 2, "unknown"],
  ] as const)("reports %s with exit %s", async (functionName, expected, status) => {
    const result = await run([fixture, functionName]);
    expect(result.code, result.stderr).toBe(expected);
    expect(JSON.parse(result.stdout)).toMatchObject({ functionName, ruleId: "initialization-before-use", status,
      assumedOperations: expect.arrayContaining([expect.objectContaining({ functionName: "initialize" })]),
    });
  });
  it("fails visibly when the work budget is exhausted", async () => {
    const result = await run([fixture, "ready", "--budget", "1"]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "unknown", reason: "proof-budget-exhausted" });
  });
  it.each([
    ["unsafe", 1, "findings"], ["guarded", 0, "clean"], ["statementGuard", 2, "unknown"],
  ] as const)("checks own-entry reads in %s", async (functionName, code, status) => {
    const result = await run(["examples/dogfood/cfg-lint-registry.ts", functionName, "--registry", "table"]);
    expect(result.code, result.stderr).toBe(code);
    expect(JSON.parse(result.stdout)).toMatchObject({ status, ruleId: "own-property-before-read", registry: "table",
      analysisScope: "expression-local-registry-reads", assumptions: expect.arrayContaining([expect.stringContaining("data properties")]),
    });
  });
  it.each([
    ["--registry", "table[key]"], ["--registry", ""], ["--registry", "table", "--use", "use"],
  ].map(options => [options]))("rejects invalid registry options before reading source: %j", async options => {
    const result = await run(["missing.ts", "run", ...options]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("ENOENT");
  });
  it("checks early returns with explicit statement flow", async () => {
    const result = await run(["examples/dogfood/cfg-lint-registry.ts", "statementGuard", "--registry", "table", "--flow", "statement"]);
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "clean", analysisScope: "statement-registry-reads" });
  });
  it.each([["--flow", "statement"], ["--registry", "table", "--flow", "invalid"]].map(args => [args]))("validates flow options: %j", async args => {
    const result = await run(["missing.ts", "run", ...args]);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("ENOENT");
  });
  it.each([[], ["missing.ts"], ["missing.ts", "run", "--budget", "0"], ["missing.ts", "run", "--budget", "2.5"]].map(args => [args]))(
    "rejects malformed arguments before reading source: %j", async args => {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain("ENOENT");
    },
  );
});

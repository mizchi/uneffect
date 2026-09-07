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
  it.each([[], ["missing.ts"], ["missing.ts", "run", "--budget", "0"], ["missing.ts", "run", "--budget", "2.5"]].map(args => [args]))(
    "rejects malformed arguments before reading source: %j", async args => {
      const result = await run(args);
      expect(result.code).toBe(2);
      expect(result.stderr).not.toContain("ENOENT");
    },
  );
});

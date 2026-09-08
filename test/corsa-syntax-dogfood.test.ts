import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { CorsaCheckJsonReport } from "../src/frontends/corsa/corsa-check-report.js";

const baseline = JSON.parse(readFileSync("dogfood/native-syntax-baseline.json", "utf8")) as {
  files: Record<string, { syntaxErrors: number }>;
  minimumSummaries: number;
  maximumUnknownSummaries: number;
};

function check(files: string[]): CorsaCheckJsonReport {
  const child = spawnSync(process.execPath, [
    "--import", resolve("test/hooks/install-reject-js-typescript.mjs"), "--import", "tsx",
    resolve("src/cli/index.ts"), "check", "--infer", "--assurance", "no-unknown", "--json", ...files,
  ], { encoding: "utf8", cwd: process.cwd(), timeout: 60_000 });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  const report = JSON.parse(child.stdout) as CorsaCheckJsonReport;
  // The migration baseline has known blockers; the real command must still fail.
  expect(child.status).toBe(1);
  expect(report.outcome).toBe("failed");
  return report;
}

describe("native syntax self dogfood", () => {
  it("carries an injected effect through the actual environment-check callers", () => {
    const file = resolve("src/support/environment.ts");
    const source = readFileSync(file, "utf8");
    const anchor = "function minimumMajor(range: string | undefined): number | undefined {";
    expect(source).toContain(anchor);
    const changed = source.replace(anchor, `${anchor}\n  console["log"]("native propagation dogfood");`)
      .replaceAll('"../backends/z3.js"', JSON.stringify(resolve("src/backends/z3.ts")))
      .replaceAll('"./package-manifest.js"', JSON.stringify(resolve("src/support/package-manifest.ts")));
    const directory = mkdtempSync(join(tmpdir(), "uneffect-native-propagation-"));
    try {
      const mutationFile = join(directory, "environment.ts");
      writeFileSync(mutationFile, changed);
      const original = check([file]), mutation = check([mutationFile]);
      for (const name of ["minimumMajor", "nodeCheck", "runEnvironmentChecks"]) {
        expect(original.effects.find(item => item.functionName === name)?.effects).not.toContain("Console");
        expect(mutation.effects.find(item => item.functionName === name)?.effects).toContain("Console");
      }
      expect(mutation.effects.find(item => item.functionName === "runEnvironmentChecks")?.evidence).toBe("unknown");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("ratchets coverage on actual diagnostic, environment, and replay implementations", () => {
    const report = check(Object.keys(baseline.files));
    expect(report.effects.length).toBeGreaterThanOrEqual(baseline.minimumSummaries);
    expect(report.effects.filter(item => item.evidence === "unknown").length).toBeLessThanOrEqual(baseline.maximumUnknownSummaries);
    expect(report.diagnostics.every(item => item.domain === "syntax"
      && item.message.includes("unsupported property-sites syntax (computed-property)"))).toBe(true);
    for (const [file, budget] of Object.entries(baseline.files)) {
      expect(report.diagnostics.filter(item => item.fileName === resolve(file)).length, file).toBeLessThanOrEqual(budget.syntaxErrors);
    }
    for (const name of ["location", "subject", "cause", "evidence", "action", "plain-language"]) {
      expect(report.effects).toContainEqual(expect.objectContaining({ functionName: name, fileName: resolve("src/support/diagnostic-quality.ts") }));
    }
  });

  it("detects an injected console effect inside the actual diagnostic criterion", () => {
    const file = resolve("src/support/diagnostic-quality.ts");
    const source = readFileSync(file, "utf8");
    const anchor = "location: (diagnostic, source) => (source.split";
    expect(source).toContain(anchor);
    const changed = source.replace(anchor, 'location: (diagnostic, source) => (console["log"]("native dogfood"), source.split')
      .replace('"./diagnostics.js"', JSON.stringify(resolve("src/support/diagnostics.ts")));
    const directory = mkdtempSync(join(tmpdir(), "uneffect-native-dogfood-"));
    try {
      const mutationFile = join(directory, "diagnostic-quality.ts");
      writeFileSync(mutationFile, changed);
      const original = check([file]);
      const mutation = check([mutationFile]);
      expect(original.effects.find(item => item.functionName === "location")?.effects).toEqual([]);
      expect(mutation.effects.find(item => item.functionName === "location")?.effects).toContain("Console");
      expect(mutation.effects.find(item => item.functionName === "scoreDiagnostic")?.effects).not.toContain("Console");
      expect(mutation.effects.find(item => item.functionName === "scoreDiagnostic")?.evidence).toBe("unknown");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

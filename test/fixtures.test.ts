import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateQuality, formatQualityReport, qualityThreshold } from "../src/diagnostic-quality.js";
import { qualityReportPath, readFixtureReport, runFixtures, type FixtureRun } from "../src/fixtures.js";

const root = process.cwd();
let runs: FixtureRun[] = [];

describe("fixture corpus", () => {
  beforeAll(async () => {
    runs = await runFixtures(root);
  }, 300_000);

  it("keeps every checked-in .diag report equal to a fresh run", async () => {
    const stale: string[] = [];
    for (const run of runs) if (await readFixtureReport(run, root) !== run.report) stale.push(run.reportPath);
    expect(stale, "run `just fixtures-update`").toEqual([]);
  });

  it("covers every checker with both a verified and a failing case", () => {
    const codes = new Set(runs.flatMap((run) => run.report.split("\n").filter((line) => /^(error|warning) /u.test(line)).map((line) => line.split(" ")[1]!)));
    expect([...codes].sort()).toContain("effect/missing");
    expect([...codes].sort()).toContain("contract/ensures");
    expect([...codes].sort()).toContain("contract/invariant");
    expect([...codes].sort()).toContain("contract/unsupported");
    expect([...codes].sort()).toContain("async/floating-promise");
    expect(runs.filter((run) => run.report.includes("no diagnostics")).map((run) => run.path))
      .toEqual(["fixtures/contracts/verified-increment.ts", "fixtures/effects/declared-console.ts"]);
  });

  it("documents what each fixture demonstrates", () => {
    expect(runs.filter((run) => run.summary.length === 0).map((run) => run.path)).toEqual([]);
  });

  it("holds the diagnostic quality rubric and keeps the checked-in report current", async () => {
    const report = evaluateQuality(await Promise.all(runs.map(async (run) => ({
      fileName: run.path,
      diagnostics: run.diagnostics,
      source: await readFile(join(root, run.path), "utf8"),
    }))));
    expect(report.regressions).toEqual([]);
    expect(report.score).toBeGreaterThanOrEqual(qualityThreshold);
    expect(await readFile(join(root, qualityReportPath), "utf8")).toEqual(formatQualityReport(report));
  });
});

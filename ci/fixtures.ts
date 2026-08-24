import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { evaluateQuality, formatQualityReport, qualityThreshold } from "../src/diagnostic-quality.js";
import { qualityReportPath, readFixtureReport, runFixtures, writeFixtureReport } from "../src/fixtures.js";

const mode = process.argv[2] ?? "check";
if (mode !== "check" && mode !== "update") {
  console.error("usage: tsx ci/fixtures.ts [check|update]");
  process.exit(2);
}

const root = process.cwd();
const runs = await runFixtures(root);
const report = evaluateQuality(await Promise.all(runs.map(async (run) => ({
  fileName: run.path,
  diagnostics: run.diagnostics,
  source: await readFile(join(root, run.path), "utf8"),
}))));
const quality = formatQualityReport(report);

if (mode === "update") {
  for (const run of runs) await writeFixtureReport(run, root);
  await writeFile(join(root, qualityReportPath), quality);
  console.log(`updated ${runs.length} fixture report(s) and ${qualityReportPath}`);
} else {
  const stale: string[] = [];
  for (const run of runs) if (await readFixtureReport(run, root) !== run.report) stale.push(run.reportPath);
  if (await readFile(join(root, qualityReportPath), "utf8").catch(() => undefined) !== quality) stale.push(qualityReportPath);
  for (const path of stale) console.error(`out of date: ${path}`);
  if (stale.length > 0) console.error("run `just fixtures-update` to refresh the checked-in reports");
  console.log(`fixtures: ${runs.length} case(s), diagnostic quality ${report.score.toFixed(3)} (threshold ${qualityThreshold})`);
  for (const regression of report.regressions) console.error(`missing required ${regression.criterion}: ${regression.fileName}:${regression.line} ${regression.code}`);
  if (stale.length > 0 || report.regressions.length > 0 || report.score < qualityThreshold) process.exit(1);
}

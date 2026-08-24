import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkFiles, createCheckHost, type CheckOptions } from "./check.js";
import { formatCheckEvidence, formatDiagnostics, type CheckerDiagnostic } from "./diagnostics.js";

export const fixturesRoot = "fixtures";
export const reportExtension = ".diag";
export const qualityReportPath = "fixtures/quality.md";

export interface Fixture {
  /** Repository-relative source path, e.g. `fixtures/effects/missing-console.ts`. */
  path: string;
  /** Repository-relative report path with the `.diag` extension. */
  reportPath: string;
  /** The fixture's own first-line `//` comment: what this file is meant to demonstrate. */
  summary: string;
}

export interface FixtureRun extends Fixture {
  report: string;
  diagnostics: CheckerDiagnostic[];
}

async function sourceFiles(directory: string, root: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...await sourceFiles(path, root));
    else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function summaryOf(text: string): string {
  const first = text.split(/\r?\n/u)[0] ?? "";
  return first.startsWith("//") ? first.slice(2).trim() : "";
}

/** Every fixture source in `fixtures/`, sorted so reports and tests keep a stable order. */
export async function listFixtures(root = process.cwd()): Promise<Fixture[]> {
  const paths = await sourceFiles(fixturesRoot, root);
  return Promise.all(paths.map(async (path) => ({
    path,
    reportPath: `${path.slice(0, -".ts".length)}${reportExtension}`,
    summary: summaryOf(await readFile(join(root, path), "utf8")),
  })));
}

/**
 * Run the CLI checkers over one fixture and render its report. The report is exactly what
 * `uneffect check --evidence <file>` prints, with repository-relative paths, so a `.diag` file always
 * matches what a reader would see.
 */
export async function runFixture(fixture: Fixture, options: CheckOptions & { root?: string } = {}): Promise<FixtureRun> {
  const root = options.root ?? process.cwd();
  const result = await checkFiles([join(root, fixture.path)], options);
  const body = formatDiagnostics(result.diagnostics, { cwd: root, sources: result.sources });
  return { ...fixture, diagnostics: result.diagnostics, report: `$ uneffect check --evidence ${fixture.path}\n# ${fixture.summary}\n\n${body}${formatCheckEvidence(result)}` };
}

export async function runFixtures(root = process.cwd()): Promise<FixtureRun[]> {
  const host = createCheckHost(), runs: FixtureRun[] = [];
  for (const fixture of await listFixtures(root)) runs.push(await runFixture(fixture, { host, root }));
  return runs;
}

export async function readFixtureReport(fixture: Fixture, root = process.cwd()): Promise<string | undefined> {
  try {
    return await readFile(join(root, fixture.reportPath), "utf8");
  } catch {
    return undefined;
  }
}

export async function writeFixtureReport(run: FixtureRun, root = process.cwd()): Promise<void> {
  await writeFile(join(root, run.reportPath), run.report);
}

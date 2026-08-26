import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { didVitestRunExactlyOneTest } from "./test-tiers.js";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const source = "test/dogfood.test.ts";
const testName = "proves telemetry routing conservation and rejects an unbalanced action";

export function boundedRepetitions(value: string | undefined): number {
  if (value === undefined || value === "") return 3;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > 10) {
    throw new Error(`UNEFFECT_SOLVER_STRESS_REPETITIONS must be a safe integer from 2 through 10; received ${JSON.stringify(value)}`);
  }
  return parsed;
}

interface Z3Record {
  event?: string;
  programDigest?: string;
  process?: { rssBytes?: number };
}

function attemptSummary(directory: string) {
  const records = readdirSync(directory).filter((file) => file.endsWith(".jsonl")).flatMap((file) =>
    readFileSync(join(directory, file), "utf8").trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line) as Z3Record));
  const programDigests = [...new Set(records.flatMap((record) => record.event === "start" && record.programDigest ? [record.programDigest] : []))].sort();
  const rss = records.flatMap(({ process }) => typeof process?.rssBytes === "number" ? [process.rssBytes] : []);
  if (programDigests.length === 0) throw new Error(`stress attempt ${directory} recorded no SMT-LIB inputs`);
  return { programDigests, solverExecutions: records.filter(({ event }) => event === "start").length, maxRssBytes: rss.length ? Math.max(...rss) : undefined };
}

export function runSolverStress(): string {
  const repetitions = boundedRepetitions(process.env.UNEFFECT_SOLVER_STRESS_REPETITIONS);
  const root = resolve(process.env.UNEFFECT_SOLVER_STRESS_EVIDENCE_ROOT ?? ".uneffect/solver-stress-evidence/telemetry-routing");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const attempts: Array<ReturnType<typeof attemptSummary> & { attempt: number; durationMs: number; status: number | null }> = [];
  let failure: string | undefined;
  for (let attempt = 1; attempt <= repetitions; attempt++) {
    const directory = join(root, `attempt-${attempt}`);
    mkdirSync(directory, { recursive: true });
    const startedAt = Date.now();
    const result = spawnSync(pnpm, ["vitest", "run", source, "-t", testName, "--testTimeout", "60000"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        UNEFFECT_CI_TIER: "z3",
        UNEFFECT_Z3_BACKEND: "wasm",
        UNEFFECT_SOLVER_EVIDENCE_DIR: directory,
      },
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 75_000,
      killSignal: "SIGKILL",
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    try {
      attempts.push({ attempt, durationMs: Date.now() - startedAt, status: result.status, ...attemptSummary(directory) });
    } catch (cause) {
      failure ??= cause instanceof Error ? cause.message : String(cause);
    }
    if (result.error) failure ??= result.error.message;
    if (result.status !== 0) failure ??= `stress attempt ${attempt} exited with status ${result.status ?? "unknown"}`;
    else if (!didVitestRunExactlyOneTest(result.stdout ?? "")) failure ??= `stress attempt ${attempt} did not execute exactly one test`;
    if (failure) break;
  }
  const baseline = attempts[0]?.programDigests;
  if (!failure && attempts.some(({ programDigests }) => JSON.stringify(programDigests) !== JSON.stringify(baseline))) {
    failure = "fresh process attempts executed different SMT-LIB digest sets";
  }
  const baselineExecutions = attempts[0]?.solverExecutions;
  if (!failure && attempts.some(({ solverExecutions }) => solverExecutions !== baselineExecutions)) {
    failure = "fresh process attempts executed different numbers of solver obligations";
  }
  if (!failure && attempts.some(({ solverExecutions }) => solverExecutions > 64)) {
    failure = "telemetry routing exceeded the 64-execution solver budget";
  }
  const manifest = join(root, "manifest.json");
  writeFileSync(manifest, `${JSON.stringify({
    schema: "uneffect.solver-stress-evidence/v1",
    source,
    testName,
    backend: "wasm",
    repetitions,
    status: failure ? "failed" : "passed",
    failure,
    attempts,
  }, null, 2)}\n`, "utf8");
  if (failure) throw new Error(`${failure}; evidence: ${manifest}`);
  process.stdout.write(`solver stress passed ${repetitions} fresh WASM processes; evidence: ${manifest}\n`);
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { runSolverStress(); }
  catch (cause) { process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`); process.exitCode = 1; }
}

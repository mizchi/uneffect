import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** Kept release-tested with package.json without loading the TypeScript 6 evidence path. */
export const effectBaselineToolVersion = "0.3.0"; // x-release-please-version

export interface EffectBaselineSummary {
  fileName?: string;
  span?: { start: number; end: number };
  functionName: string;
  effects: readonly string[];
  evidence: "verified" | "trusted" | "inferred" | "unknown";
  unknownReasons?: ReadonlyArray<{ code: string; message: string }>;
}

export interface EffectBaselineEntry {
  fileName: string;
  functionName: string;
  occurrence: number;
  effects: string[];
  unknownReasons: string[];
}

export interface EffectBaseline {
  schema: "uneffect-effect-baseline/v1";
  uneffectVersion: string;
  entries: EffectBaselineEntry[];
}

export interface EffectBaselineRegression {
  kind: "effect-expansion" | "new-unknown" | "new-effectful-function" | "tool-version-mismatch";
  fileName: string;
  functionName: string;
  occurrence: number;
  added: string[];
  message: string;
}

export interface EffectBaselineAssessment {
  schema: "uneffect-effect-baseline-assessment/v1";
  status: "passed" | "failed";
  baselineFile?: string;
  regressions: EffectBaselineRegression[];
}

interface BaselineOptions { cwd?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown key ${unknown[0]}`);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  if (value.some((item) => item.length === 0)) throw new Error(`${label} must contain non-empty strings`);
  if (new Set(value).size !== value.length) throw new Error(`${label} must not contain duplicates`);
  return [...value].sort();
}

function portablePath(fileName: string, cwd: string): string {
  const absolute = isAbsolute(fileName) ? fileName : resolve(cwd, fileName);
  return relative(cwd, absolute).split(sep).join("/") || ".";
}

function canonicalEntries(summaries: readonly EffectBaselineSummary[], options: BaselineOptions = {}): EffectBaselineEntry[] {
  const cwd = resolve(options.cwd ?? process.cwd());
  const ordered = summaries.map((summary, inputIndex) => {
    if (!summary.fileName) throw new Error(`effect summary ${summary.functionName} has no source file identity`);
    return { summary, inputIndex, fileName: portablePath(summary.fileName, cwd) };
  }).sort((left, right) => left.fileName.localeCompare(right.fileName)
    || (left.summary.span?.start ?? Number.MAX_SAFE_INTEGER) - (right.summary.span?.start ?? Number.MAX_SAFE_INTEGER)
    || left.inputIndex - right.inputIndex);
  const occurrences = new Map<string, number>();
  return ordered.map(({ summary, fileName }) => {
    const group = `${fileName}\0${summary.functionName}`;
    const occurrence = occurrences.get(group) ?? 0;
    occurrences.set(group, occurrence + 1);
    return {
      fileName,
      functionName: summary.functionName,
      occurrence,
      effects: [...new Set(summary.effects)].sort(),
      unknownReasons: [...new Set(summary.unknownReasons?.map(({ code }) => code) ?? [])].sort(),
    };
  });
}

export function createEffectBaseline(
  summaries: readonly EffectBaselineSummary[],
  options: BaselineOptions = {},
): EffectBaseline {
  return { schema: "uneffect-effect-baseline/v1", uneffectVersion: effectBaselineToolVersion, entries: canonicalEntries(summaries, options) };
}

export function parseEffectBaseline(input: unknown): EffectBaseline {
  if (!isRecord(input)) throw new Error("effect baseline must be an object");
  if (input.schema !== "uneffect-effect-baseline/v1") throw new Error("unsupported effect baseline schema");
  exactKeys(input, ["schema", "uneffectVersion", "entries"], "effect baseline");
  if (typeof input.uneffectVersion !== "string") throw new Error("effect baseline uneffectVersion must be a string");
  if (!Array.isArray(input.entries)) throw new Error("effect baseline entries must be an array");
  const seen = new Set<string>();
  const entries = input.entries.map((raw, index): EffectBaselineEntry => {
    if (!isRecord(raw)) throw new Error(`effect baseline entry ${index} must be an object`);
    exactKeys(raw, ["fileName", "functionName", "occurrence", "effects", "unknownReasons"], `effect baseline entry ${index}`);
    if (typeof raw.fileName !== "string" || raw.fileName.length === 0
      || typeof raw.functionName !== "string" || raw.functionName.length === 0) {
      throw new Error(`effect baseline entry ${index} needs non-empty fileName and functionName`);
    }
    if (!Number.isInteger(raw.occurrence) || Number(raw.occurrence) < 0) {
      throw new Error(`effect baseline entry ${index} occurrence must be a non-negative integer`);
    }
    const entry = {
      fileName: raw.fileName,
      functionName: raw.functionName,
      occurrence: Number(raw.occurrence),
      effects: strings(raw.effects, `effect baseline entry ${index} effects`),
      unknownReasons: strings(raw.unknownReasons, `effect baseline entry ${index} unknownReasons`),
    };
    const key = entryKey(entry);
    if (seen.has(key)) throw new Error(`duplicate effect baseline entry ${entry.fileName}#${entry.functionName}[${entry.occurrence}]`);
    seen.add(key);
    return entry;
  });
  return { schema: "uneffect-effect-baseline/v1", uneffectVersion: input.uneffectVersion, entries };
}

function entryKey(entry: Pick<EffectBaselineEntry, "fileName" | "functionName" | "occurrence">): string {
  return `${entry.fileName}\0${entry.functionName}\0${entry.occurrence}`;
}

function difference(actual: readonly string[], expected: readonly string[]): string[] {
  const allowed = new Set(expected);
  return actual.filter((item) => !allowed.has(item));
}

export function compareEffectBaseline(
  baseline: EffectBaseline,
  summaries: readonly EffectBaselineSummary[],
  options: BaselineOptions & { baselineFile?: string } = {},
): EffectBaselineAssessment {
  const parsed = parseEffectBaseline(baseline);
  const expected = new Map(parsed.entries.map((entry) => [entryKey(entry), entry]));
  const regressions: EffectBaselineRegression[] = [];
  if (parsed.uneffectVersion !== effectBaselineToolVersion) regressions.push({
    kind: "tool-version-mismatch", fileName: "<baseline>", functionName: "<baseline>", occurrence: 0,
    added: [effectBaselineToolVersion],
    message: `baseline was generated by Uneffect ${parsed.uneffectVersion}; review and regenerate it with ${effectBaselineToolVersion}`,
  });
  for (const actual of canonicalEntries(summaries, options)) {
    const previous = expected.get(entryKey(actual));
    if (!previous) {
      if (actual.effects.length > 0) regressions.push({
        kind: "new-effectful-function", fileName: actual.fileName, functionName: actual.functionName,
        occurrence: actual.occurrence, added: actual.effects,
        message: `${actual.functionName} is new and inferred ${actual.effects.join(" | ")}`,
      });
      if (actual.unknownReasons.length > 0) regressions.push({
        kind: "new-unknown", fileName: actual.fileName, functionName: actual.functionName,
        occurrence: actual.occurrence, added: actual.unknownReasons,
        message: `${actual.functionName} is new and has unknown analysis: ${actual.unknownReasons.join(", ")}`,
      });
      continue;
    }
    const addedEffects = difference(actual.effects, previous.effects);
    if (addedEffects.length > 0) regressions.push({
      kind: "effect-expansion", fileName: actual.fileName, functionName: actual.functionName,
      occurrence: actual.occurrence, added: addedEffects,
      message: `${actual.functionName} added ${addedEffects.join(" | ")}`,
    });
    const addedUnknowns = difference(actual.unknownReasons, previous.unknownReasons);
    if (addedUnknowns.length > 0) regressions.push({
      kind: "new-unknown", fileName: actual.fileName, functionName: actual.functionName,
      occurrence: actual.occurrence, added: addedUnknowns,
      message: `${actual.functionName} added unknown analysis: ${addedUnknowns.join(", ")}`,
    });
  }
  return {
    schema: "uneffect-effect-baseline-assessment/v1",
    status: regressions.length === 0 ? "passed" : "failed",
    ...(options.baselineFile === undefined ? {} : { baselineFile: options.baselineFile }),
    regressions,
  };
}

export function formatEffectBaselineAssessment(assessment: EffectBaselineAssessment): string {
  const header = `effect baseline: ${assessment.status}; ${assessment.regressions.length} regression(s)\n`;
  return header + assessment.regressions.map((regression) =>
    `error effect-baseline/${regression.kind} ${regression.fileName}\n  function: ${regression.functionName}\n  message: ${regression.message}\n`,
  ).join("");
}

export async function loadEffectBaseline(fileName: string): Promise<EffectBaseline> {
  return parseEffectBaseline(JSON.parse(await readFile(fileName, "utf8")));
}

export async function writeEffectBaseline(fileName: string, baseline: EffectBaseline): Promise<void> {
  await mkdir(dirname(fileName), { recursive: true });
  await writeFile(fileName, `${JSON.stringify(baseline, null, 2)}\n`);
}

export interface ProcessEffectBaselineOptions extends BaselineOptions {
  summaries: readonly EffectBaselineSummary[];
  checkPassed: boolean;
  baselineFile?: string;
  writeBaselineFile?: string;
}

export interface ProcessEffectBaselineResult {
  assessment?: EffectBaselineAssessment;
  written?: { fileName: string; entries: number };
  writeSkipped: boolean;
}

/** Filesystem boundary shared by the Corsa, TypeScript, and workspace CLI paths. */
export async function processEffectBaseline(options: ProcessEffectBaselineOptions): Promise<ProcessEffectBaselineResult> {
  const assessment = options.baselineFile === undefined ? undefined : compareEffectBaseline(
    await loadEffectBaseline(options.baselineFile), options.summaries,
    { cwd: options.cwd, baselineFile: options.baselineFile },
  );
  if (options.writeBaselineFile !== undefined && options.checkPassed) {
    await writeEffectBaseline(
      options.writeBaselineFile,
      createEffectBaseline(options.summaries, { cwd: options.cwd }),
    );
    return {
      ...(assessment === undefined ? {} : { assessment }),
      written: { fileName: options.writeBaselineFile, entries: options.summaries.length },
      writeSkipped: false,
    };
  }
  return {
    ...(assessment === undefined ? {} : { assessment }),
    writeSkipped: options.writeBaselineFile !== undefined,
  };
}

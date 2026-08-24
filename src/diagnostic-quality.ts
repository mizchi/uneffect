import { reportDiagnostic, type CheckerDiagnostic, type ReportedDiagnostic } from "./diagnostics.js";

/**
 * A message is only useful if a reader can locate the problem, understand why the checker
 * believes it, and act on it. These criteria make that reviewable instead of subjective,
 * so the fixture corpus doubles as an evaluation loop for message quality.
 */
export interface QualityCriterion {
  id: string;
  question: string;
  /** Required criteria may never regress; the rest move the score and steer the next improvement. */
  required: boolean;
  satisfied: (diagnostic: ReportedDiagnostic, source: string) => boolean;
}

const causeLabels = new Set(["because", "rule", "fails"]);
const valueLabels = new Set(["counterexample", "state", "fails", "declared", "inferred", "binding", "construct"]);
const jargon = /\b(unsat|sat)\b|define-fun|smt-lib|\(assert|Z3 returned/iu;

/** True when a note quotes program text, so the reader sees the construct instead of a paraphrase. */
function quotesSource(detail: string, source: string): boolean {
  return detail.split(/[\s,;]+/u).some((token) =>
    token.length >= 6 && /[.(=]/u.test(token) && !token.includes("uneffect:") && !token.startsWith("/*") && source.includes(token));
}

export const qualityCriteria: readonly QualityCriterion[] = [
  {
    id: "location", question: "does the reported line point at a real, non-empty source line?", required: true,
    satisfied: (diagnostic, source) => (source.split(/\r?\n/u)[diagnostic.line - 1] ?? "").trim().length > 0,
  },
  {
    id: "subject", question: "does the message name the function or quote the clause under check?", required: false,
    satisfied: (diagnostic) => diagnostic.message.includes(diagnostic.functionName) || diagnostic.message.includes("`"),
  },
  {
    id: "cause", question: "is there a note explaining why the checker believes this?", required: true,
    satisfied: (diagnostic) => diagnostic.notes.some((note) => causeLabels.has(note.label) && note.detail.length > 0),
  },
  {
    id: "evidence", question: "does a note carry concrete evidence: counterexample values, the analyzed declaration, or quoted code?", required: false,
    satisfied: (diagnostic, source) => diagnostic.notes.some((note) => valueLabels.has(note.label) || quotesSource(note.detail, source)),
  },
  {
    id: "action", question: "does a hint say what to change next?", required: true,
    satisfied: (diagnostic) => diagnostic.notes.some((note) => note.label === "hint" && note.detail.length > 0),
  },
  {
    id: "plain-language", question: "is the message free of raw solver verdicts and SMT jargon?", required: true,
    satisfied: (diagnostic) => !jargon.test(diagnostic.message),
  },
];

export interface DiagnosticScore {
  fileName: string;
  code: string;
  line: number;
  message: string;
  satisfied: string[];
  missing: string[];
}

export interface QualityReport {
  scores: DiagnosticScore[];
  /** Satisfied criteria over all criteria, across every scored diagnostic. */
  score: number;
  satisfied: number;
  total: number;
  /** Required criteria that some diagnostic fails; these are hard regressions. */
  regressions: Array<{ fileName: string; code: string; line: number; criterion: string }>;
}

/**
 * Minimum score the fixture corpus must keep. It is a ratchet, not a target: every diagnostic
 * in `fixtures/` currently satisfies every criterion, so a new fixture with a weaker message,
 * or a new criterion nobody has implemented yet, fails until the message catches up.
 */
export const qualityThreshold = 1;

export function scoreDiagnostic(diagnostic: CheckerDiagnostic, source: string): DiagnosticScore {
  const reported = reportDiagnostic(diagnostic);
  const satisfied: string[] = [], missing: string[] = [];
  for (const criterion of qualityCriteria) (criterion.satisfied(reported, source) ? satisfied : missing).push(criterion.id);
  return { fileName: reported.fileName, code: reported.code, line: reported.line, message: reported.message, satisfied, missing };
}

export function evaluateQuality(entries: ReadonlyArray<{ fileName: string; diagnostics: readonly CheckerDiagnostic[]; source: string }>): QualityReport {
  const scores: DiagnosticScore[] = [];
  for (const entry of entries) for (const diagnostic of entry.diagnostics) scores.push({ ...scoreDiagnostic(diagnostic, entry.source), fileName: entry.fileName });
  const satisfied = scores.reduce((count, item) => count + item.satisfied.length, 0);
  const total = scores.length * qualityCriteria.length;
  const required = new Set(qualityCriteria.filter((criterion) => criterion.required).map((criterion) => criterion.id));
  const regressions = scores.flatMap((item) => item.missing.filter((criterion) => required.has(criterion))
    .map((criterion) => ({ fileName: item.fileName, code: item.code, line: item.line, criterion })));
  return { scores, satisfied, total, score: total === 0 ? 1 : satisfied / total, regressions };
}

function round(value: number): string { return (Math.round(value * 1000) / 1000).toFixed(3); }

/** Render the report that is committed next to the fixtures, so message quality moves visibly in review. */
export function formatQualityReport(report: QualityReport): string {
  const lines = [
    "# Diagnostic quality report",
    "",
    "Generated by `just fixtures-update`. Every diagnostic the `fixtures/` corpus produces is",
    "scored against the rubric in `src/diagnostic-quality.ts`. Required criteria may never",
    "regress; the remaining ones move the score and point at the next message to improve.",
    "",
    "| criterion | required | question |",
    "| --- | --- | --- |",
    ...qualityCriteria.map((criterion) => `| ${criterion.id} | ${criterion.required ? "yes" : "no"} | ${criterion.question} |`),
    "",
    `Score: **${round(report.score)}** (${report.satisfied}/${report.total} criteria over ${report.scores.length} diagnostics, threshold ${round(qualityThreshold)})`,
    "",
    "| fixture | diagnostic | line | missing |",
    "| --- | --- | --- | --- |",
    ...report.scores.map((item) => `| ${item.fileName} | ${item.code} | ${item.line} | ${item.missing.length > 0 ? item.missing.join(", ") : "—"} |`),
    "",
  ];
  return `${lines.join("\n")}`;
}

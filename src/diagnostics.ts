import type { AsyncSafetyDiagnostic } from "./async-safety.js";
import { formatEffect } from "./capabilities.js";
import type { CheckResult } from "./check.js";
import type { ContractDiagnostic } from "./contracts.js";
import type { EffectDiagnostic } from "./effects.js";
import type { ReactSemanticDiagnostic } from "./react-semantics.js";

export type DiagnosticSeverity = "error" | "warning";
/** One explanation line under a diagnostic: `because`, `counterexample`, `evaluation`, `hint`, ... */
export interface DiagnosticNote { label: string; detail: string }
export type CheckerDiagnostic = EffectDiagnostic | ContractDiagnostic | AsyncSafetyDiagnostic | ReactSemanticDiagnostic;

export interface ReportedDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  fileName: string;
  line: number;
  functionName: string;
  message: string;
  notes: DiagnosticNote[];
}

/** Next action for every diagnostic code, so a reader never has to guess what to change. */
const hints: Readonly<Record<string, string>> = {
  "effect/missing": "declare the effect in the function's /* uneffect: effect ... */ comment, or move the operation into a callee that already declares it",
  "effect/unused": "delete the declared effect, or keep it deliberately as a wider upper bound; unused declarations never fail the CLI",
  "effect/unknown": "fix the effect name; the known constructors are FsRead, FsWrite, Console, Fetch, Dom, Env, Random, Timer, Mutate<region>, and Throw<ErrorType>",
  "contract/ensures": "weaken the postcondition, strengthen the precondition, or change the returned expression so the counterexample above cannot occur",
  "contract/invariant": "establish the invariant before the loop and restore it in the body, or weaken it until both hold",
  "contract/unsupported": "rewrite the function into the verified subset (integer locals, assignments, if, while with an invariant, return), or drop the contract comment to opt out",
  "async/floating-promise": "await the Promise, return it, attach a rejection handler, or mark the intent with an explicit void",
  "async/floating-callback-promise": "declare ownership of the callback Promise, or make the callback synchronous",
  "async/invalid-disposable": "give the resource a Symbol.dispose or Symbol.asyncDispose method, or bind it with const instead of using",
  "async/invalid-ownership-contract": "fix the ownership directive so its parameter indices and boolean guards match the declaration",
  "async/invalid-resource-contract": "fix the resource directive so its parameter indices and boolean guards match the declaration",
  "async/disposed-resource-use": "keep the use inside the disposal scope, or extend the scope to cover the alias",
  "async/disposed-resource-escape": "stop the resource from escaping its disposal scope, or hand the caller an owned resource instead",
  "react/render-effect": "move the operation into an event handler or an Effect setup, leaving render replay-safe",
  "react/non-idempotent-render": "derive the value from props/state/context, or read it outside render in an event or Effect",
  "react/immutable-input-mutation": "create a new value instead of mutating the component's props snapshot",
  "react/conditional-hook": "call Hooks unconditionally at the component top level and move the condition inside the Hook",
  "react/missing-effect-cleanup": "return cleanup that calls a matching /* uneffect: react release Capability */ boundary",
  "react/invalid-react-annotation": "use exactly `react component`, `react acquire Capability`, or `react release Capability`",
};

export function diagnosticHint(code: string): string | undefined { return hints[code]; }

function severityOf(diagnostic: CheckerDiagnostic): DiagnosticSeverity {
  return "severity" in diagnostic ? diagnostic.severity : "error";
}

function codeOf(diagnostic: CheckerDiagnostic): string {
  if ("component" in diagnostic) return `react/${diagnostic.kind}`;
  if ("effect" in diagnostic) return `effect/${diagnostic.kind}`;
  if ("clause" in diagnostic) return diagnostic.clause === "unsupported" ? "contract/unsupported" : `contract/${diagnostic.clause}`;
  return `async/${diagnostic.kind}`;
}

/** Normalize every checker diagnostic into one reportable shape with its notes and hint. */
export function reportDiagnostic(diagnostic: CheckerDiagnostic): ReportedDiagnostic {
  const code = codeOf(diagnostic);
  const notes = [...(diagnostic.notes ?? [])];
  const hint = diagnosticHint(code);
  if (hint && !notes.some((note) => note.label === "hint")) notes.push({ label: "hint", detail: hint });
  return { code, severity: severityOf(diagnostic), fileName: diagnostic.fileName, line: diagnostic.line, functionName: diagnostic.functionName, message: diagnostic.message, notes };
}

export interface DiagnosticFormatOptions {
  /** Directory that reported paths are made relative to, so reports are machine independent. */
  cwd?: string;
  /** Source text per absolute file name; enables the one-line source frame. */
  sources?: ReadonlyMap<string, string>;
}

function relative(fileName: string, cwd: string | undefined): string {
  if (!cwd) return fileName;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return fileName.startsWith(prefix) ? fileName.slice(prefix.length) : fileName;
}

function frame(source: string | undefined, line: number): string[] {
  const text = source?.split(/\r?\n/u)[line - 1];
  if (text === undefined) return [];
  const gutter = String(line);
  return [`  ${gutter} | ${text.trimEnd()}`, `  ${" ".repeat(gutter.length)} | ${" ".repeat(text.length - text.trimStart().length)}^`];
}

/** Render one diagnostic as a stable text block: header, source frame, then explanation notes. */
export function formatDiagnostic(diagnostic: CheckerDiagnostic, options: DiagnosticFormatOptions = {}): string {
  const reported = reportDiagnostic(diagnostic);
  const source = options.sources?.get(diagnostic.fileName);
  const header = `${reported.severity} ${reported.code} ${relative(reported.fileName, options.cwd)}:${reported.line} in ${reported.functionName}`;
  return [header, `  message: ${reported.message}`, ...frame(source, reported.line), ...reported.notes.map((note) => `  ${note.label}: ${note.detail}`)].join("\n");
}

/** Render a whole run: every diagnostic block plus a counted summary line. */
export function formatDiagnostics(diagnostics: readonly CheckerDiagnostic[], options: DiagnosticFormatOptions = {}): string {
  const reported = diagnostics.map(reportDiagnostic);
  const errors = reported.filter((item) => item.severity === "error").length;
  const warnings = reported.length - errors;
  const summary = `${errors} error(s), ${warnings} warning(s)`;
  if (diagnostics.length === 0) return `no diagnostics\n${summary}\n`;
  return `${diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, options)).join("\n\n")}\n\n${summary}\n`;
}

/** What a run established: the obligations that were proved and the inferred effect of every function. */
export function formatCheckEvidence(result: Pick<CheckResult, "artifacts" | "summaries">): string {
  const lines = [
    ...result.artifacts.filter((artifact) => artifact.status === "verified" && artifact.obligation)
      .map((artifact) => `  proved ${artifact.obligation!.functionName}: ${artifact.obligation!.clause} ${artifact.obligation!.source}`),
    ...result.summaries.map((summary) => `  effects ${summary.functionName}: ${summary.effects.length > 0 ? summary.effects.map(formatEffect).join(" | ") : "no effect"} (${summary.evidence})`),
  ];
  return lines.length > 0 ? `\nevidence:\n${lines.join("\n")}\n` : "";
}

import ts from "typescript";
import type { AsyncSafetyDiagnostic } from "./async-safety.js";
import { formatEffect } from "./capabilities.js";
import type { CheckResult } from "./check.js";
import type { ContractDiagnostic } from "./contracts.js";
import type { EffectDiagnostic } from "./effects.js";
import type { ReactSemanticDiagnostic } from "./react-semantics.js";
import type { TrustedTypesDiagnostic } from "./trusted-types.js";

export type DiagnosticSeverity = "error" | "warning";
/** One explanation line under a diagnostic: `because`, `counterexample`, `evaluation`, `hint`, ... */
export interface DiagnosticNote { label: string; detail: string }
export interface TypeScriptCheckerDiagnostic {
  domain: "typescript";
  kind: "syntax" | "semantic" | "options";
  severity: DiagnosticSeverity;
  fileName: string;
  line: number;
  functionName: "<typescript>";
  message: string;
  typescriptCode: number;
  notes?: DiagnosticNote[];
}

/** Convert compiler failures into the same source-attributed diagnostic contract used by every frontend. */
export function fromTypeScriptDiagnostic(
  diagnostic: ts.Diagnostic,
  kind: TypeScriptCheckerDiagnostic["kind"],
): TypeScriptCheckerDiagnostic {
  const fileName = diagnostic.file?.fileName ?? "<typescript-options>";
  const line = diagnostic.file && diagnostic.start !== undefined
    ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1 : 1;
  const severity = diagnostic.category === ts.DiagnosticCategory.Warning ? "warning" : "error";
  const label = kind === "syntax" ? "syntax errors" : kind === "semantic" ? "semantic errors" : "option errors";
  const detail = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  return {
    domain: "typescript", kind, severity, fileName, line, functionName: "<typescript>",
    message: `TypeScript source has ${label} (\`TS${diagnostic.code}\`): ${detail}`,
    typescriptCode: diagnostic.code,
    notes: [
      { label: "because", detail },
      { label: "construct", detail: `TypeScript reported TS${diagnostic.code} at line ${line}` },
    ],
  };
}
export type CheckerDiagnostic = EffectDiagnostic | ContractDiagnostic | AsyncSafetyDiagnostic | ReactSemanticDiagnostic | TrustedTypesDiagnostic | TypeScriptCheckerDiagnostic;

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
  "effect/missing": "declare the effect in the function's /* uneffect:capability effect ... */ comment, or move the operation into a callee that already declares it",
  "effect/unused": "delete the declared effect, or keep it deliberately as a wider upper bound; unused declarations never fail the CLI",
  "effect/unknown": "fix the effect name; the known constructors are FsRead, FsWrite, Console, Fetch, Dom, Env, Random, Timer, Mutate<region>, and Throw<ErrorType>",
  "effect/invalid": "fix the effect-set syntax; use `none` by itself for an explicit empty set, or a `|`-separated union of Effect terms",
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
  "async/unsupported-control-transfer": "keep break/continue inside the modeled handler loop, or wait for a target-aware outer-loop CFG model",
  "react/render-effect": "move the operation into an event handler or an Effect setup, leaving render replay-safe",
  "react/non-idempotent-render": "derive the value from props/state/context, or read it outside render in an event or Effect",
  "react/immutable-input-mutation": "create a new value instead of mutating a props, state, or context render snapshot",
  "react/render-ref-access": "move the ref read or write into an event, Effect, or callback-ref commit phase",
  "react/unknown-ref-callback": "inline the callback ref so setup and returned cleanup can be checked, or pass a locally resolved object ref",
  "react/unknown-imperative-handle-callback": "inline the handle factory or bind it to an immutable local/module callback so its captures and exposed methods can be checked",
  "react/memo-comparator-effect": "make the memo comparator a pure comparison of previous and next props",
  "react/unknown-memo-comparator": "inline the memo comparator or bind it to an immutable local/module callback so its purity can be checked",
  "react/unsupported-react-component-wrapper": "annotate a direct function or a direct React memo/forwardRef chain around an inline function",
  "react/optimistic-reducer-effect": "make the optimistic reducer a pure calculation of its current state and action argument",
  "react/unknown-action-callback": "inline the useActionState reducerAction or bind it to an immutable local/module callback so its effects can be tracked",
  "react/unknown-optimistic-reducer": "inline the optimistic reducer or bind it to an immutable local/module callback so its purity can be checked",
  "react/unknown-action-handler": "use an inline or immutable local Action callback, or the dispatcher returned directly by useActionState",
  "react/action-dispatch-outside-action": "dispatch inside startTransition, a useTransition Action, or an action/formAction prop",
  "react/transition-update-after-await": "wrap the state update after await in a new startTransition call",
  "react/conditional-hook": "call Hooks unconditionally at the component top level and move the condition inside the Hook",
  "react/missing-effect-cleanup": "return cleanup that calls a matching /* uneffect:react-resource release Capability */ boundary",
  "react/invalid-react-annotation": "use `react component`, `react hook`, `react acquire Capability [result]`, or `react release Capability [parameter N]`",
  "react/unknown-hook-summary": "annotate the resolved custom Hook with `/* uneffect:react-hook */`, or keep the component outside the checked boundary",
  "react/recursive-hook": "remove recursive Hook calls; React Hook order requires a finite, stable call sequence",
  "react/resource-identity-mismatch": "pass the resource returned by this Effect setup, or an immutable local alias of it, to the matching cleanup boundary",
  "react/duplicate-effect-cleanup": "release each acquired resource identity exactly once in the returned cleanup",
  "react/conditional-resource-lifecycle": "make acquisition and cleanup unconditional within the Effect lifecycle, or refactor to a separately modeled optional resource",
  "react/missing-hook-dependency": "add every reported capture, or a covering object path, to the inline dependency array",
  "react/unknown-hook-closure": "inline the Hook callback so its captures can be checked, or keep this function outside the checked React boundary",
  "react/unknown-hook-dependencies": "use a finite inline dependency array; computed arrays are not accepted as stale-closure evidence",
  "react/unstable-hook-dependency": "bind the value outside the dependency array and stabilize its identity, or depend on the primitive/member values it reads",
  "typescript/syntax": "fix the TypeScript syntax error before relying on Uneffect evidence",
  "typescript/semantic": "fix the TypeScript type error or correct the project inputs before relying on TypeChecker-derived evidence",
  "typescript/options": "fix the TypeScript compiler configuration before running Uneffect assurance",
  "trusted-types/untrusted-script-sink": "create the value with a reviewed trustedTypes policy and pass the resulting TrustedScript without casting it to or from string",
};

export function diagnosticHint(code: string): string | undefined { return hints[code]; }

function severityOf(diagnostic: CheckerDiagnostic): DiagnosticSeverity {
  return "severity" in diagnostic ? diagnostic.severity : "error";
}

function codeOf(diagnostic: CheckerDiagnostic): string {
  if ("domain" in diagnostic && diagnostic.domain === "typescript") return `typescript/${diagnostic.kind}`;
  if ("domain" in diagnostic && diagnostic.domain === "trusted-types") return `trusted-types/${diagnostic.kind}`;
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

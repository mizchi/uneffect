import type { AnalysisUnknown } from "./contracts.js";

export function equalSets(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(value => b.has(value));
}

export function invalidInput(detail: string): AnalysisUnknown {
  return { status: "unknown", reason: "invalid-input", detail, iterations: 0 };
}

/** Deliberately omit the solver's partial states from the domain result. */
export function incomplete(result: AnalysisUnknown): AnalysisUnknown {
  return { status: "unknown", reason: result.reason, detail: result.detail, iterations: result.iterations };
}

import { describe, expect, it } from "vitest";
import {
  describeObligation, evaluateLogic, explainCounterexample, failingConjunct, formatEvaluated, formatLogic,
  formatValue, obligationRule, parseModel, parseModelValue,
} from "../src/contract-explanations.js";
import { evaluateQuality, qualityCriteria, scoreDiagnostic } from "../src/diagnostic-quality.js";
import { diagnosticHint, formatDiagnostics, reportDiagnostic, type CheckerDiagnostic } from "../src/diagnostics.js";
import { lowerInvariantProgram, parseLogicExpression, InvariantLoweringError } from "../src/invariant-ir.js";

const offByOne = `/* uneffect: requires x >= 0 */
/* uneffect: ensures result > x */
function decrement(x: number) {
  return x - 1;
}
`;

describe("contract counterexample explanations", () => {
  it("reads integer, negative, rational, and boolean model terms", () => {
    expect(parseModelValue("3")).toEqual({ kind: "number", numerator: 3n, denominator: 1n });
    expect(parseModelValue("(- 3)")).toEqual({ kind: "number", numerator: -3n, denominator: 1n });
    expect(formatValue(parseModelValue("(/ 2 4)")!)).toBe("1/2");
    expect(parseModelValue("true")).toEqual({ kind: "boolean", value: true });
    expect(parseModelValue("(seq.unit 1)")).toBeUndefined();
  });

  it("evaluates the IR exactly instead of through floating point", () => {
    const model = parseModel({ x: "(/ 1 3)" });
    expect(formatValue(evaluateLogic(parseLogicExpression("x * 3"), model)!)).toBe("1");
    expect(evaluateLogic(parseLogicExpression("x > 0"), model)).toEqual({ kind: "boolean", value: true });
    expect(evaluateLogic(parseLogicExpression("y + 1"), model)).toBeUndefined();
  });

  it("renders the IR as source and as evaluated arithmetic", () => {
    const expression = parseLogicExpression("(x + 1) * 2 > x");
    expect(formatLogic(expression)).toBe("(x + 1) * 2 > x");
    expect(formatEvaluated(expression, parseModel({ x: "1" }))).toBe("4 > 1");
    expect(formatLogic(parseLogicExpression("a"), { a: "i@loop" })).toBe("i@loop");
  });

  it("names the conjunct a compound clause breaks on", () => {
    const clause = parseLogicExpression("i >= 0 && i <= n");
    const failing = failingConjunct(clause, parseModel({ i: "1", n: "0" }));
    expect(failing && formatLogic(failing)).toBe("i <= n");
    expect(failingConjunct(clause, parseModel({ i: "0", n: "1" }))).toBeUndefined();
  });

  it("explains a postcondition counterexample with values, state, and the failing check", () => {
    const [obligation] = lowerInvariantProgram("off-by-one.ts", offByOne);
    expect(describeObligation(obligation!)).toBe("`ensures result > x` can fail on this return");
    expect(obligationRule(obligation!)).toContain("every input allowed by requires");
    const notes = explainCounterexample(obligation!, { x: "0" });
    expect(notes.map((note) => note.label)).toEqual(["counterexample", "state", "still holds", "fails"]);
    expect(notes).toContainEqual({ label: "counterexample", detail: "x = 0" });
    expect(notes).toContainEqual({ label: "state", detail: "result = x - 1 = -1" });
    expect(notes).toContainEqual({ label: "fails", detail: "ensures result > x evaluates to -1 > 0, which is false" });
  });
});

describe("lowering rejections", () => {
  it("locates the construct that left the verified subset", () => {
    const source = `/* uneffect: ensures result == n */
function announce(n: number) {
  report(n);
  return n;
}
`;
    expect(() => lowerInvariantProgram("call.ts", source)).toThrow(InvariantLoweringError);
    try {
      lowerInvariantProgram("call.ts", source);
    } catch (cause) {
      const error = cause as InvariantLoweringError;
      expect(error.functionName).toBe("announce");
      expect(source.slice(error.span!.start, error.span!.end)).toBe("report(n);");
      expect(error.hint).toContain("inline the callee");
    }
  });
});

describe("diagnostic rendering", () => {
  const diagnostic: CheckerDiagnostic = {
    fileName: "/repo/src/a.ts", functionName: "report", effect: "Console", kind: "missing", severity: "error", line: 2,
    message: "report requires /* uneffect: effect Console */",
    notes: [{ label: "because", detail: "report performs console.log(value) at line 3" }],
  };

  it("adds the code and the per-code hint", () => {
    const reported = reportDiagnostic(diagnostic);
    expect(reported.code).toBe("effect/missing");
    expect(reported.notes.at(-1)).toEqual({ label: "hint", detail: diagnosticHint("effect/missing") });
  });

  it("renders a relative header, a source frame, and the notes", () => {
    const text = formatDiagnostics([diagnostic], { cwd: "/repo", sources: new Map([["/repo/src/a.ts", "// head\nfunction report(value: number) {\n"]]) });
    expect(text).toContain("error effect/missing src/a.ts:2 in report");
    expect(text).toContain("  2 | function report(value: number) {");
    expect(text).toContain("  because: report performs console.log(value) at line 3");
    expect(text.trimEnd().endsWith("1 error(s), 0 warning(s)")).toBe(true);
  });

  it("reports an empty run without inventing diagnostics", () => {
    expect(formatDiagnostics([])).toBe("no diagnostics\n0 error(s), 0 warning(s)\n");
  });
});

describe("diagnostic quality rubric", () => {
  const source = "// head\nfunction report(value: number) {\n  console.log(value);\n}\n";
  const good: CheckerDiagnostic = {
    fileName: "a.ts", functionName: "report", effect: "Console", kind: "missing", severity: "error", line: 2,
    message: "report requires /* uneffect: effect Console */",
    notes: [{ label: "because", detail: "report performs console.log(value) at line 3" }],
  };

  it("passes a message that locates, explains, evidences, and acts", () => {
    expect(scoreDiagnostic(good, source).missing).toEqual([]);
  });

  it("flags a solver verdict with no explanation as a required regression", () => {
    const bare: CheckerDiagnostic = { fileName: "a.ts", functionName: "report", clause: "requires", line: 99, message: "report: sat" };
    const score = scoreDiagnostic(bare, source);
    expect(score.missing).toEqual(["location", "cause", "evidence", "action", "plain-language"]);
    const report = evaluateQuality([{ fileName: "a.ts", diagnostics: [bare], source }]);
    expect(report.regressions.map((item) => item.criterion)).toEqual(["location", "cause", "action", "plain-language"]);
    expect(report.score).toBeCloseTo(1 / qualityCriteria.length, 5);
  });
});

import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = `/* uneffect: state pending: int */ /* uneffect: state primary: bool */ /* uneffect: init pending = 0 */ /* uneffect: init primary = true */ /* uneffect: action drain: pending' = pending > 0 ? 0 : pending, primary' = pending > 0 ? (pending % 2 === 0 ? primary : !primary) : primary */
interface Runtime { pending: number; primary: boolean }
/* uneffect:refinement refinement cfgBooleanInvolution@1 create */ export function create(initial: Runtime) { return initial }
/* uneffect:refinement refinement cfgBooleanInvolution@1 observe */ export function observe(runtime: Runtime) { return runtime }
/* uneffect:refinement refinement cfgBooleanInvolution@1 action drain */
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    runtime.primary = !runtime.primary
    runtime.pending--
  }
}
`;

describe("Boolean involution CFG recurrence", () => {
  it("derives and independently proves an exact parity summary", async () => {
    const spec = parseSpec("cfg-boolean-involution.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      "cfg-boolean-involution.ts", fixture, "cfgBooleanInvolution", spec,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      memberBudget: { name: "cfg-recurrence-members", limit: 2, observed: 2 },
      booleanInvolutions: {
        rule: "source-bound-boolean-involution",
        budget: { name: "cfg-recurrence-boolean-involutions", limit: 1, observed: 1 },
        updates: [{ state: "primary", span: { start: expect.any(Number), end: expect.any(Number) } }],
      },
      fixedPoint: expect.objectContaining({
        members: [
          { state: "pending", role: "ranking" },
          { state: "primary", role: "scalar" },
        ],
        recurrence: expect.objectContaining({
          iteration: { pending: "pending - 1", primary: "!primary" },
          summary: {
            pending: "pending > 0 ? 0 : pending",
            primary: "pending > 0 ? pending % 2 === 0 ? primary : !primary : primary",
          },
        }),
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "cfg-boolean-involution.ts", fixture, "cfgBooleanInvolution", spec,
    );
    expect(checked.diagnostics).toEqual([]);
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      recurrenceProof: expect.objectContaining({
        status: "verified",
        checks: expect.arrayContaining([
          { kind: "step", state: "primary", status: "verified" },
          { kind: "ranking", state: "pending", status: "verified" },
        ]),
      }),
    }));

    const recurrence = structural.obligations.find((item) =>
      item.kind === "scalar-recurrence-fixed-point")?.fixedPoint.recurrence;
    expect(recurrence).toBeDefined();
    await expect(verifyRefinementRecurrenceCertificateWithZ3(spec, {
      ...recurrence!, summary: { ...recurrence!.summary, primary: "primary" },
    })).resolves.toMatchObject({ status: "refuted" });
  });

  it("fails closed outside one direct unit-step Boolean involution", async () => {
    const originalSummary = "pending > 0 ? (pending % 2 === 0 ? primary : !primary) : primary";
    const cases = [
      ["constant", fixture
        .replace(originalSummary, "pending > 0 ? false : primary")
        .replace("runtime.primary = !runtime.primary", "runtime.primary = false")],
      ["compound", fixture.replace(
        "runtime.primary = !runtime.primary",
        "runtime.primary = !(runtime.primary && runtime.pending > 1)",
      )],
      ["path-dependent", fixture.replace(
        "runtime.primary = !runtime.primary",
        "if (runtime.pending > 1) runtime.primary = !runtime.primary",
      )],
      ["updated-twice", fixture
        .replace(originalSummary, "primary")
        .replace(
          "runtime.primary = !runtime.primary",
          "runtime.primary = !runtime.primary\n    runtime.primary = !runtime.primary",
        )],
      ["non-unit-ranking", fixture
        .replace("pending > 0 ? 0 : pending", "pending > 0 ? pending % 2 : pending")
        .replace("runtime.pending--", "runtime.pending -= 2")],
      ["integer-self-amplification", fixture.replace(
        "runtime.primary = !runtime.primary",
        "runtime.pending += runtime.pending\n    runtime.primary = !runtime.primary",
      )],
    ] as const;
    for (const [name, source] of cases) {
      const spec = parseSpec(`${name}.ts`, source).temporal;
      const analysis = analyzeRefinementActionBodies(`${name}.ts`, source, "cfgBooleanInvolution", spec);
      expect(analysis.obligations).toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "unknown",
        reason: expect.not.stringMatching(/^independent-proof-required$/),
      }));
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
        modelName: "drain",
        code: expect.stringMatching(/^(unsupported-action-body|action-update-mismatch)$/),
      }));
    }

    const two = fixture
      .replace("state primary: bool", "state primary: bool\n  state secondary: bool")
      .replace("init primary = true", "init primary = true\n  init secondary = false")
      .replace(
        "primary' = pending > 0 ? (pending % 2 === 0 ? primary : !primary) : primary",
        "primary' = pending > 0 ? (pending % 2 === 0 ? primary : !primary) : primary, secondary' = pending > 0 ? (pending % 2 === 0 ? secondary : !secondary) : secondary",
      )
      .replace("primary: boolean }", "primary: boolean; secondary: boolean }")
      .replace(
        "runtime.primary = !runtime.primary",
        "runtime.primary = !runtime.primary\n    runtime.secondary = !runtime.secondary",
      );
    const twoAnalysis = analyzeRefinementActionBodies(
      "two.ts", two, "cfgBooleanInvolution", parseSpec("two.ts", two).temporal,
    );
    expect(twoAnalysis.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "unsupported-recurrence",
    }));

    const baseSpec = parseSpec("cfg-boolean-involution.ts", fixture).temporal;
    const exhausted = analyzeRefinementActionBodies(
      "budget.ts", fixture, "cfgBooleanInvolution", baseSpec,
      { proofBudget: { cfgFixedPointIterations: 1 } },
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point", reason: "proof-budget-exhausted",
    }));
    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "solver.ts", fixture, "cfgBooleanInvolution", baseSpec,
      { z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" } },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point", reason: "recurrence-proof-unknown",
    }));
  });
});

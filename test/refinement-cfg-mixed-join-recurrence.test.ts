import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = `/* uneffect:
  state pending: int
  state processed: int
  state sampled: bool
  state mode: int
  init pending = 0
  init processed = 0
  init sampled = false
  init mode = 0
  action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (mode === 0 ? (sampled ? 2 * pending : pending) : (mode === 1 ? (sampled ? 3 * pending : 2 * pending) : (sampled ? 4 * pending : 3 * pending))) : 0)
*/
interface Runtime { pending: number; processed: number; sampled: boolean; mode: number }
/* uneffect: refinement mixedDrain@1 create */ export function create(initial: Runtime) { return initial }
/* uneffect: refinement mixedDrain@1 observe */ export function observe(runtime: Runtime) { return runtime }
/* uneffect: refinement mixedDrain@1 action drain */
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
    if (runtime.sampled) runtime.processed++
    switch (runtime.mode) {
      case 0:
        runtime.processed += 1
        break
      case 1:
        runtime.processed += 2
        break
      default:
        runtime.processed += 3
        break
    }
    runtime.pending--
  }
}
`;

describe("ordered mixed recurrence joins", () => {
  it("composes one Boolean diamond followed by one finite switch", async () => {
    const spec = parseSpec("mixed-drain.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      "mixed-drain.ts", fixture, "mixedDrain", spec,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      controlJoins: [
        expect.objectContaining({
          kind: "loop-invariant-cfg-diamond",
          order: 0,
          selector: { kind: "boolean-state", state: "sampled" },
          rule: "predicate-correlated-affine-phi",
        }),
        expect.objectContaining({
          kind: "loop-invariant-cfg-switch",
          order: 1,
          selector: { kind: "integer-state", state: "mode" },
          rule: "finite-literal-affine-phi",
        }),
      ],
    }));
    expect(structural.obligations).not.toContainEqual(expect.objectContaining({
      conditionalJoins: expect.anything(),
    }));
    expect(structural.obligations).not.toContainEqual(expect.objectContaining({
      finiteJoin: expect.anything(),
    }));
    for (const fileName of [
      "src/refinement-bindings.ts",
      "schemas/uneffect-refinement-action-analysis-v2.schema.json",
    ]) {
      const contract = readFileSync(fileName, "utf8");
      expect(contract).not.toContain("conditionalJoins");
      expect(contract).not.toContain("finiteJoin");
    }

    const verified = await analyzeRefinementActionBodiesWithZ3(
      "mixed-drain.ts", fixture, "mixedDrain", spec,
    );
    expect(verified.diagnostics).toEqual([]);
    expect(verified.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      controlJoins: [
        expect.objectContaining({ order: 0, kind: "loop-invariant-cfg-diamond" }),
        expect.objectContaining({ order: 1, kind: "loop-invariant-cfg-switch" }),
      ],
      recurrenceProof: expect.objectContaining({ status: "verified" }),
    }));
  });

  it("keeps reordered, nested, mutable, colliding, and over-budget joins as non-proofs", () => {
    const spec = parseSpec("mixed-drain.ts", fixture).temporal;
    const ifLine = "    if (runtime.sampled) runtime.processed++\n";
    const switchStart = fixture.indexOf("    switch (runtime.mode)");
    const switchEnd = fixture.indexOf("    runtime.pending--", switchStart);
    const switchBlock = fixture.slice(switchStart, switchEnd);
    const reversed = fixture
      .replace(ifLine, "")
      .replace(switchBlock, `${switchBlock}${ifLine}`);
    const controls = [
      ["reversed", reversed],
      ["nested", fixture.replace("switch (runtime.mode) {", "if (runtime.sampled) switch (runtime.mode) {")],
      ["mutated-predicate", fixture.replace("runtime.pending--", "runtime.sampled = false\n    runtime.pending--")],
      ["mutated-discriminant", fixture.replace("runtime.pending--", "runtime.mode = 0\n    runtime.pending--")],
      ["selector-collision", fixture.replace("switch (runtime.mode)", "switch (runtime.sampled)")],
      ["ranking-selector", fixture.replace("switch (runtime.mode)", "switch (runtime.pending)")],
      ["unmodeled-identity-root", fixture.replace(
        "if (runtime.sampled) runtime.processed++",
        "if (runtime.pending > 0) runtime.processed += 0",
      )],
      ["excess-join", fixture.replace("runtime.pending--", "if (runtime.sampled) runtime.processed += 0\n    runtime.pending--")],
      ["excess-case", fixture.replace("default:", "case 2:\n        runtime.processed += 4\n        break\n      default:")],
    ] as const;
    for (const [name, source] of controls) {
      const analysis = analyzeRefinementActionBodies(`${name}.ts`, source, "mixedDrain", spec);
      expect(analysis.obligations).not.toContainEqual(expect.objectContaining({
        controlJoins: [
          expect.objectContaining({ kind: "loop-invariant-cfg-diamond" }),
          expect.objectContaining({ kind: "loop-invariant-cfg-switch" }),
        ],
      }));
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body",
        modelName: "drain",
      }));
    }

    const exhausted = analyzeRefinementActionBodies(
      "budget.ts", fixture, "mixedDrain", spec,
      { proofBudget: { cfgFixedPointIterations: 1 } },
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "proof-budget-exhausted",
    }));
  });

  it("keeps a refuted certificate and unavailable solver as non-proofs", async () => {
    const spec = parseSpec("mixed-drain.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      "mixed-drain.ts", fixture, "mixedDrain", spec,
    );
    const certificate = structural.obligations.find((obligation) =>
      obligation.kind === "scalar-recurrence-fixed-point")?.fixedPoint.recurrence;
    expect(certificate).toBeDefined();
    await expect(verifyRefinementRecurrenceCertificateWithZ3(spec, {
      ...certificate!,
      summary: { ...certificate!.summary, processed: "processed" },
    })).resolves.toMatchObject({
      status: "refuted",
      checks: expect.arrayContaining([
        { kind: "step", state: "processed", status: "refuted" },
      ]),
    });

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "mixed-drain.ts", fixture, "mixedDrain", spec,
      { z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" } },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "recurrence-proof-unknown",
      controlJoins: [
        expect.objectContaining({ kind: "loop-invariant-cfg-diamond" }),
        expect.objectContaining({ kind: "loop-invariant-cfg-switch" }),
      ],
    }));
  });
});

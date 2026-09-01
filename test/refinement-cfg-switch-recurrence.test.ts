import { describe, expect, it } from "vitest";
import {
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";
import { analyzeSingleActionRefinementBodies as analyzeRefinementActionBodies, analyzeSingleActionRefinementBodiesWithZ3 as analyzeRefinementActionBodiesWithZ3 } from "./refinement-analysis.js";

const fixture = `/* uneffect: state pending: int */ /* uneffect: state processed: int */ /* uneffect: state mode: int */ /* uneffect: init pending = 0 */ /* uneffect: init processed = 0 */ /* uneffect: init mode = 0 */ /* uneffect: action drain: pending' = pending > 0 ? 0 : pending, processed' = processed + (pending > 0 ? (mode === 0 ? pending : (mode === 1 ? 2 * pending : 3 * pending)) : 0) */
interface Runtime { pending: number; processed: number; mode: number }
export function create(initial: Runtime) { return initial }
export function observe(runtime: Runtime) { return runtime }
export function drain(runtime: Runtime) {
  while (runtime.pending > 0) {
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

describe("finite switch fan-out in a scalar recurrence", () => {
  it("carries two literal cases plus default into one source-bound join", async () => {
    const spec = parseSpec("switch-drain.ts", fixture).temporal;
    const analysis = analyzeRefinementActionBodies(
      "switch-drain.ts", fixture, "switchDrain", spec,
    );

    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      controlJoins: [expect.objectContaining({
        kind: "loop-invariant-cfg-switch",
        order: 0,
        selector: { kind: "integer-state", state: "mode" },
        rule: "finite-literal-affine-phi",
        budget: { name: "cfg-recurrence-switch-cases", limit: 2, observed: 2 },
        predecessors: [
          expect.objectContaining({ case: "0", block: expect.stringMatching(/^case:/) }),
          expect.objectContaining({ case: "1", block: expect.stringMatching(/^case:/) }),
          expect.objectContaining({ case: "default", block: expect.stringMatching(/^default:/) }),
        ],
        join: expect.stringMatching(/^switch-join:/),
      })],
    }));

    const verified = await analyzeRefinementActionBodiesWithZ3(
      "switch-drain.ts", fixture, "switchDrain", spec,
    );
    expect(verified.diagnostics).toEqual([]);
    expect(verified.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      controlJoins: [expect.objectContaining({ rule: "finite-literal-affine-phi" })],
      recurrenceProof: expect.objectContaining({ status: "verified" }),
    }));

  });

  it("keeps unsafe or over-budget switch families as explicit non-proofs", () => {
    const spec = parseSpec("switch-drain.ts", fixture).temporal;
    const controls = [
      ["fallthrough", fixture.replace("runtime.processed += 1\n        break", "runtime.processed += 1")],
      ["mutated-discriminant", fixture.replace("runtime.processed += 1", "runtime.processed += 1\n        runtime.mode = 1")],
      ["ranking-discriminant", fixture.replace("switch (runtime.mode)", "switch (runtime.pending)")],
      ["duplicate-case", fixture.replace("case 1:", "case 0:")],
      ["signed-case", fixture.replace("case 0:", "case -1:")],
      ["nonliteral-case", fixture.replace("case 1:", "case runtime.mode:")],
      ["nested", fixture.replace("switch (runtime.mode) {", "if (runtime.pending > 0) switch (runtime.mode) {")],
      ["third-case", fixture.replace("default:", "case 2:\n        runtime.processed += 4\n        break\n      default:")],
    ] as const;
    for (const [name, source] of controls) {
      const analysis = analyzeRefinementActionBodies(`${name}.ts`, source, "switchDrain", spec);
      expect(analysis.obligations).not.toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        controlJoins: expect.arrayContaining([
          expect.objectContaining({ kind: "loop-invariant-cfg-switch" }),
        ]),
      }));
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
        code: "unsupported-action-body",
        modelName: "drain",
      }));
    }
  });

  it("keeps solver unavailability as a non-proof", async () => {
    const spec = parseSpec("switch-drain.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      "switch-drain.ts", fixture, "switchDrain", spec,
    );
    const certificate = structural.obligations.find((obligation) =>
      obligation.kind === "scalar-recurrence-fixed-point")?.fixedPoint.recurrence;
    expect(certificate).toBeDefined();
    const refuted = await verifyRefinementRecurrenceCertificateWithZ3(spec, {
      ...certificate!,
      summary: { ...certificate!.summary, processed: "processed" },
    });
    expect(refuted).toMatchObject({
      status: "refuted",
      checks: expect.arrayContaining([
        { kind: "step", state: "processed", status: "refuted" },
      ]),
    });

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "switch-drain.ts", fixture, "switchDrain", spec,
      { z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" } },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "recurrence-proof-unknown",
      controlJoins: [expect.objectContaining({ rule: "finite-literal-affine-phi" })],
    }));
  });
});

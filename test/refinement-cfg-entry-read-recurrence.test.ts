import { describe, expect, it } from "vitest";
import {
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";
import { analyzeSingleActionRefinementBodies as analyzeRefinementActionBodies, analyzeSingleActionRefinementBodiesWithZ3 as analyzeRefinementActionBodiesWithZ3 } from "./refinement-analysis.js";

const fixture = `/* uneffect: state pending: int */ /* uneffect: state batch: int */ /* uneffect: state sent: int */ /* uneffect: init pending = 0 */ /* uneffect: init batch = 0 */ /* uneffect: init sent = 0 */ /* uneffect: action flush: pending' = pending > 0 ? 0 : pending, batch' = batch + (pending > 0 ? pending : 0), sent' = sent + (pending > 0 ? pending * batch + pending * (pending - 1) / 2 : 0) */
interface Runtime { pending: number; batch: number; sent: number }
export function create(initial: Runtime) { return initial }
export function observe(runtime: Runtime) { return runtime }
export function flush(runtime: Runtime) {
  while (runtime.pending > 0) {
    runtime.sent += runtime.batch
    runtime.batch++
    runtime.pending--
  }
}
`;

describe("entry-read triangular affine CFG recurrence", () => {
  it("uses the driver entry value and verifies the order-sensitive closed form", async () => {
    const spec = parseSpec("cfg-entry-read-flush.ts", fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      "cfg-entry-read-flush.ts", fixture, "cfgEntryReadFlush", spec,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      affineDependencies: expect.objectContaining({
        rule: "source-ordered-upper-triangular-affine",
        order: ["sent", "batch"],
        edges: [{ from: "batch", to: "sent", read: "entry" }],
      }),
      fixedPoint: expect.objectContaining({
        recurrence: expect.objectContaining({
          iteration: {
            pending: "pending - 1",
            batch: "batch + 1",
            sent: "sent + batch",
          },
          summary: {
            pending: "pending > 0 ? 0 : pending",
            batch: "batch + (pending > 0 ? pending : 0)",
            sent: "sent + (pending > 0 ? pending * batch + pending * (pending - 1) / 2 : 0)",
          },
        }),
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "cfg-entry-read-flush.ts", fixture, "cfgEntryReadFlush", spec,
    );
    expect(checked.diagnostics).toEqual([]);
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      recurrenceProof: expect.objectContaining({ status: "verified" }),
    }));

    const recurrence = structural.obligations.find((item) =>
      item.kind === "scalar-recurrence-fixed-point")?.fixedPoint.recurrence;
    expect(recurrence).toBeDefined();
    await expect(verifyRefinementRecurrenceCertificateWithZ3(spec, {
      ...recurrence!,
      summary: {
        ...recurrence!.summary,
        sent: "sent + (pending > 0 ? pending * batch + pending * (pending + 1) / 2 : 0)",
      },
    })).resolves.toMatchObject({ status: "refuted" });
  });

  it("fails closed when entry-read provenance or proof evidence is lost", async () => {
    const spec = parseSpec("cfg-entry-read-flush.ts", fixture).temporal;
    for (const [name, source] of [
      ["updated-read-with-entry-summary", fixture.replace(
        "runtime.sent += runtime.batch\n    runtime.batch++",
        "runtime.batch++\n    runtime.sent += runtime.batch",
      )],
      ["driver-self-amplification", fixture.replace("runtime.batch++", "runtime.batch += runtime.batch")],
      ["dependency-cycle", fixture.replace("runtime.batch++", "runtime.batch += runtime.sent")],
      ["non-affine", fixture.replace("runtime.sent += runtime.batch", "runtime.sent *= runtime.batch")],
      ["path-dependent-driver", fixture.replace("runtime.batch++", "if (runtime.sent > 0) runtime.batch++")],
      ["driver-updated-twice", fixture.replace("runtime.batch++", "runtime.batch++\n    runtime.batch++")],
      ["dependent-updated-twice", fixture.replace(
        "runtime.sent += runtime.batch",
        "runtime.sent += runtime.batch\n    runtime.sent++",
      )],
    ] as const) {
      const analysis = analyzeRefinementActionBodies(`${name}.ts`, source, "cfgEntryReadFlush", spec);
      expect(analysis.obligations, name).toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "unknown",
        reason: expect.not.stringMatching(/^independent-proof-required$/),
      }));
      expect(analysis.diagnostics, name).toContainEqual(expect.objectContaining({
        modelName: "flush",
        code: expect.stringMatching(/^(unsupported-action-body|action-update-mismatch)$/),
      }));
    }

    const exhausted = analyzeRefinementActionBodies(
      "budget.ts", fixture, "cfgEntryReadFlush", spec,
      { proofBudget: { cfgFixedPointIterations: 1 } },
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "proof-budget-exhausted",
    }));

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "solver.ts", fixture, "cfgEntryReadFlush", spec,
      { z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" } },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "recurrence-proof-unknown",
    }));
  });
});

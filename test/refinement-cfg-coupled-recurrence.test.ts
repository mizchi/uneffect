import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";
import { refinementManifest } from "./refinement-manifest.js";

const fixture = `/* uneffect: state pending: int */ /* uneffect: state batch: int */ /* uneffect: state sent: int */ /* uneffect: init pending = 0 */ /* uneffect: init batch = 0 */ /* uneffect: init sent = 0 */ /* uneffect: action flush: pending' = pending > 0 ? 0 : pending, batch' = batch + (pending > 0 ? pending : 0), sent' = sent + (pending > 0 ? pending * batch + pending * (pending + 1) / 2 : 0) */
interface Runtime { pending: number; batch: number; sent: number }
export function create(initial: Runtime) { return initial }
export function observe(runtime: Runtime) { return runtime }
export function flush(runtime: Runtime) {
  while (runtime.pending > 0) {
    runtime.batch++
    runtime.sent += runtime.batch
    runtime.pending--
  }
}
`;

describe("upper-triangular affine CFG recurrence", () => {
  it("retains an ordered scalar dependency and verifies its closed form independently", async () => {
    const fileName = "cfg-coupled-flush.ts";
    const spec = parseSpec(fileName, fixture).temporal;
    const manifest = refinementManifest(fileName, "cfgCoupledFlush", { flush: "flush" });
    const structural = analyzeRefinementActionBodies(
      fileName, fixture, "cfgCoupledFlush", spec, {}, manifest,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      memberBudget: { name: "cfg-recurrence-members", limit: 3, observed: 3 },
      affineDependencies: {
        rule: "source-ordered-upper-triangular-affine",
        order: ["batch", "sent"],
        updates: [
          { state: "batch", span: { start: expect.any(Number), end: expect.any(Number) } },
          { state: "sent", span: { start: expect.any(Number), end: expect.any(Number) } },
        ],
        edges: [{ from: "batch", to: "sent", read: "updated" }],
      },
      fixedPoint: expect.objectContaining({
        recurrence: expect.objectContaining({
          counter: "pending",
          iteration: {
            pending: "pending - 1",
            batch: "batch + 1",
            sent: "sent + (batch + 1)",
          },
          summary: {
            pending: "pending > 0 ? 0 : pending",
            batch: "batch + (pending > 0 ? pending : 0)",
            sent: "sent + (pending > 0 ? pending * batch + pending * (pending + 1) / 2 : 0)",
          },
          stable: true,
        }),
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      fileName, fixture, "cfgCoupledFlush", spec, { manifest },
    );
    expect(checked.diagnostics).toEqual([]);
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      recurrenceProof: expect.objectContaining({
        status: "verified",
        checks: expect.arrayContaining([
          { kind: "step", state: "batch", status: "verified" },
          { kind: "step", state: "sent", status: "verified" },
          { kind: "ranking", state: "pending", status: "verified" },
        ]),
      }),
    }));

    const obligation = structural.obligations.find((item) =>
      item.kind === "scalar-recurrence-fixed-point");
    const recurrence = obligation?.fixedPoint.recurrence;
    expect(recurrence).toBeDefined();
    await expect(verifyRefinementRecurrenceCertificateWithZ3(spec, {
      ...recurrence!,
      summary: { ...recurrence!.summary, sent: "sent + pending" },
    })).resolves.toMatchObject({ status: "refuted" });
  });

  it("fails closed when source order, acyclicity, affine form, budget, or solver evidence is lost", async () => {
    const spec = parseSpec("cfg-coupled-flush.ts", fixture).temporal;
    for (const [name, source] of [
      ["reversed-order", fixture.replace(
        "runtime.batch++\n    runtime.sent += runtime.batch",
        "runtime.sent += runtime.batch\n    runtime.batch++",
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
      const fileName = `${name}.ts`;
      const analysis = analyzeRefinementActionBodies(fileName, source, "cfgCoupledFlush", spec, {},
        refinementManifest(fileName, "cfgCoupledFlush", { flush: "flush" }));
      expect(analysis.obligations).toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "unknown",
        reason: expect.not.stringMatching(/^independent-proof-required$/),
      }));
      expect(analysis.diagnostics).toContainEqual(expect.objectContaining({
        modelName: "flush",
        code: expect.stringMatching(/^(unsupported-action-body|action-update-mismatch)$/),
      }));
    }

    const exhausted = analyzeRefinementActionBodies(
      "budget.ts", fixture, "cfgCoupledFlush", spec,
      { proofBudget: { cfgFixedPointIterations: 1 } },
      refinementManifest("budget.ts", "cfgCoupledFlush", { flush: "flush" }),
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "proof-budget-exhausted",
    }));

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "solver.ts", fixture, "cfgCoupledFlush", spec,
      {
        z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
        manifest: refinementManifest("solver.ts", "cfgCoupledFlush", { flush: "flush" }),
      },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "recurrence-proof-unknown",
    }));
  });
});

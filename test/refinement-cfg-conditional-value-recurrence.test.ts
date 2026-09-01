import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";
import { refinementManifest } from "./refinement-manifest.js";

const fixture = `/* uneffect: state pending: int */ /* uneffect: state urgent: bool */ /* uneffect: state sent: int */ /* uneffect: init pending = 0 */ /* uneffect: init urgent = false */ /* uneffect: init sent = 0 */ /* uneffect: action flush: pending' = pending > 0 ? 0 : pending, urgent' = urgent, sent' = sent + (pending > 0 ? urgent ? 2 * pending : pending : 0) */
interface Runtime { pending: number; urgent: boolean; sent: number }
export function create(initial: Runtime) { return initial }
export function observe(runtime: Runtime) { return runtime }
export function flush(runtime: Runtime) {
  while (runtime.pending > 0) {
    const weight = runtime.urgent ? 2 : 1
    runtime.sent += weight
    runtime.pending--
  }
}
`;

describe("conditional-value CFG recurrence", () => {
  it("lowers a loop-local conditional value into generic predecessor evidence", async () => {
    const fileName = "cfg-conditional-value-flush.ts";
    const spec = parseSpec(fileName, fixture).temporal;
    const manifest = refinementManifest(fileName, "cfgConditionalValueFlush", { flush: "flush" });
    const structural = analyzeRefinementActionBodies(
      fileName, fixture, "cfgConditionalValueFlush", spec, {}, manifest,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      controlJoins: [{
        kind: "loop-invariant-cfg-value-join",
        order: 0,
        selector: { kind: "boolean-state", state: "urgent" },
        rule: "source-bound-predecessor-value-phi",
        budget: { name: "cfg-recurrence-value-joins", limit: 1, observed: 1 },
        span: { start: expect.any(Number), end: expect.any(Number) },
        predecessors: [
          { branch: "then", block: expect.stringMatching(/^expression:/), value: "2" },
          { branch: "else", block: expect.stringMatching(/^expression:/), value: "1" },
        ],
        join: expect.stringMatching(/^value-join:/),
      }],
      fixedPoint: expect.objectContaining({
        recurrence: expect.objectContaining({
          iteration: { pending: "pending - 1", urgent: "urgent", sent: "sent + (urgent ? 2 : 1)" },
          summary: {
            pending: "pending > 0 ? 0 : pending",
            urgent: "urgent",
            sent: "sent + (pending > 0 ? urgent ? 2 * pending : pending : 0)",
          },
        }),
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      fileName, fixture, "cfgConditionalValueFlush", spec, { manifest },
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
      ...recurrence!, summary: { ...recurrence!.summary, sent: "sent + pending" },
    })).resolves.toMatchObject({ status: "refuted" });
  });

  it("fails closed outside the single loop-invariant affine value join", async () => {
    const spec = parseSpec("cfg-conditional-value-flush.ts", fixture).temporal;
    const cases = [
      ["multiple", fixture.replace(
        "const weight = runtime.urgent ? 2 : 1",
        "const weight = runtime.urgent ? 2 : 1\n    const duplicate = runtime.urgent ? 1 : 0\n    void duplicate",
      )],
      ["nested", fixture.replace(
        "runtime.urgent ? 2 : 1",
        "runtime.urgent ? (runtime.urgent ? 2 : 3) : 1",
      )],
      ["mutable-selector", fixture.replace(
        "const weight = runtime.urgent ? 2 : 1",
        "runtime.urgent = !runtime.urgent\n    const weight = runtime.urgent ? 2 : 1",
      )],
      ["local-selector", fixture.replace(
        "const weight = runtime.urgent ? 2 : 1",
        "const localUrgent = runtime.urgent\n    const weight = localUrgent ? 2 : 1",
      )],
      ["non-affine", fixture.replace(
        "runtime.urgent ? 2 : 1",
        "runtime.urgent ? runtime.sent * runtime.sent : 1",
      )],
      ["unused", fixture.replace(
        "runtime.sent += weight",
        "void weight\n    runtime.sent++",
      ).replace(
        "sent + (pending > 0 ? urgent ? 2 * pending : pending : 0)",
        "sent + (pending > 0 ? pending : 0)",
      )],
      ["post-join-local-mutation", fixture.replace(
        "const weight = runtime.urgent ? 2 : 1\n    runtime.sent += weight",
        "let weight = runtime.urgent ? 2 : 1\n    weight += 1\n    runtime.sent += weight",
      ).replace(
        "urgent ? 2 * pending : pending",
        "urgent ? 3 * pending : 2 * pending",
      )],
    ] as const;
    for (const [name, source] of cases) {
      const fileName = `${name}.ts`;
      const analysis = analyzeRefinementActionBodies(fileName, source, "cfgConditionalValueFlush", spec, {},
        refinementManifest(fileName, "cfgConditionalValueFlush", { flush: "flush" }));
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
      "budget.ts", fixture, "cfgConditionalValueFlush", spec,
      { proofBudget: { cfgFixedPointIterations: 1 } },
      refinementManifest("budget.ts", "cfgConditionalValueFlush", { flush: "flush" }),
    );
    expect(exhausted.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "proof-budget-exhausted",
    }));

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "solver.ts", fixture, "cfgConditionalValueFlush", spec,
      {
        z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
        manifest: refinementManifest("solver.ts", "cfgConditionalValueFlush", { flush: "flush" }),
      },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "recurrence-proof-unknown",
    }));
  });
});

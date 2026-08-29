import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";

const fixture = readFileSync(join(process.cwd(), "examples/dogfood/cfg-bounded-retry-backoff.ts"), "utf8");
const spec = parseSpec("cfg-bounded-retry-backoff.ts", fixture).temporal;

describe("precondition-bounded self-affine recurrence", () => {
  it("publishes the conditional proof fields in the strict v2 artifact schema", () => {
    const schema = JSON.parse(readFileSync(
      "schemas/uneffect-refinement-action-analysis-v2.schema.json", "utf8",
    ));
    expect(schema.$defs.rankingRecurrence.properties).toMatchObject({
      assumptions: { $ref: "#/$defs/proofAssumptions" },
      boundedSelfAffine: { $ref: "#/$defs/boundedSelfAffine" },
    });
    expect(schema.$defs.recurrenceProof.properties).toMatchObject({
      assumptions: { $ref: "#/$defs/proofAssumptions" },
    });
    expect(schema.$defs.proofAssumptions).toMatchObject({
      type: "array", minItems: 1, maxItems: 1,
    });
    expect(schema.$defs.scalarRecurrence.properties.boundedSelfAffine).toEqual({
      $ref: "#/$defs/boundedSelfAffine",
    });
    expect(schema.$defs.boundedSelfAffine).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining([
        "rule", "state", "counter", "multiplier", "precondition", "budget", "update",
      ]),
    });
  });

  it("proves exact exponential backoff only under the checked finite retry bound", async () => {
    const structural = analyzeRefinementActionBodies(
      "cfg-bounded-retry-backoff.ts", fixture, "boundedRetryBackoff", spec,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      boundedSelfAffine: {
        rule: "precondition-bounded-self-affine",
        state: "delay",
        counter: "retries",
        multiplier: 2,
        precondition: {
          expression: "retries >= 0 && retries <= 8",
          span: { start: expect.any(Number), end: expect.any(Number) },
        },
        budget: { name: "cfg-recurrence-geometric-iterations", limit: 8, observed: 8 },
        update: { state: "delay", span: { start: expect.any(Number), end: expect.any(Number) },
        },
      },
      fixedPoint: expect.objectContaining({
        recurrence: expect.objectContaining({
          assumptions: ["retries >= 0 && retries <= 8"],
          iteration: { retries: "retries - 1", delay: "delay * 2" },
          summary: {
            retries: "retries > 0 ? 0 : retries",
            delay: "retries > 0 ? delay * (retries === 1 ? 2 : retries === 2 ? 4 : retries === 3 ? 8 : retries === 4 ? 16 : retries === 5 ? 32 : retries === 6 ? 64 : retries === 7 ? 128 : retries === 8 ? 256 : 1) : delay",
          },
        }),
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      "cfg-bounded-retry-backoff.ts", fixture, "boundedRetryBackoff", spec,
    );
    expect(checked.diagnostics).toEqual([]);
    expect(checked.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "verified",
      recurrenceProof: expect.objectContaining({
        status: "verified",
        assumptions: ["retries >= 0 && retries <= 8"],
        checks: expect.arrayContaining([
          { kind: "step", state: "delay", status: "verified" },
          { kind: "ranking", state: "retries", status: "verified" },
        ]),
      }),
    }));

    const recurrence = structural.obligations.find((item) =>
      item.kind === "scalar-recurrence-fixed-point")?.fixedPoint.recurrence;
    expect(recurrence).toBeDefined();
    await expect(verifyRefinementRecurrenceCertificateWithZ3(spec, {
      ...recurrence!, summary: { ...recurrence!.summary, delay: recurrence!.summary.delay!.replace("256", "255") },
    })).resolves.toMatchObject({ status: "refuted" });

    for (const candidate of [
      { ...recurrence!, assumptions: ["retries >= 0 && retries <= 7"] },
      {
        ...recurrence!,
        boundedSelfAffine: { ...recurrence!.boundedSelfAffine!, multiplier: 3 },
      },
      { ...recurrence!, assumptions: undefined },
      { ...recurrence!, boundedSelfAffine: undefined },
    ]) {
      await expect(verifyRefinementRecurrenceCertificateWithZ3(spec, candidate))
        .resolves.toMatchObject({
          status: "refuted",
          checks: expect.arrayContaining([expect.objectContaining({
            status: "refuted",
            reason: "bounded-self-affine-metadata-mismatch",
          })]),
        });
    }
  });

  it("fails closed without the exact bound or outside the bounded family", async () => {
    for (const [name, source] of [
      ["missing-precondition", fixture.replace("  requires runtime.retries >= 0 && runtime.retries <= 8\n", "")],
      ["oversized-bound", fixture.replaceAll("<= 8", "<= 9")],
      ["wrong-counter", fixture.replace("requires runtime.retries", "requires runtime.delay")],
      ["additive-mixture", fixture.replace("runtime.delay *= 2", "runtime.delay = runtime.delay * 2 + 1")],
      ["repeated-write", fixture.replace("runtime.delay *= 2", "runtime.delay *= 2\n    runtime.delay *= 2")],
      ["second-self-affine", fixture.replace("runtime.retries--;", "runtime.retries *= 2;")],
      ["wrong-runtime-factor", fixture.replace("runtime.delay *= 2", "runtime.delay *= 3")],
    ] as const) {
      const candidateSpec = parseSpec(`${name}.ts`, source).temporal;
      const result = await analyzeRefinementActionBodiesWithZ3(
        `${name}.ts`, source, "boundedRetryBackoff", candidateSpec,
      );
      expect(result.obligations).toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "unknown",
        reason: expect.not.stringMatching(/^independent-proof-required$/),
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: expect.stringMatching(/^(unsupported-action-body|action-update-mismatch)$/),
      }));
    }

    const unavailable = await analyzeRefinementActionBodiesWithZ3(
      "solver.ts", fixture, "boundedRetryBackoff", spec,
      { z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" } },
    );
    expect(unavailable.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      reason: "recurrence-proof-unknown",
    }));
  });
});

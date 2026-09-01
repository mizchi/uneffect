import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  analyzeRefinementActionBodies,
  analyzeRefinementActionBodiesWithZ3,
  verifyRefinementRecurrenceCertificateWithZ3,
} from "../src/refinement-bindings.js";
import { parseSpec } from "../src/spec-ir.js";
import { resolveRefinementDslFileLink } from "../src/refinement-dsl.js";

const fileName = "examples/dogfood/cfg-caught-retry-backoff.ts";
const fixture = readFileSync(fileName, "utf8");
const manifest = resolveRefinementDslFileLink(fileName);

describe("caught-path bounded self-affine recurrence", () => {
  it("publishes guarded activation in the strict v2 artifact schema", () => {
    const schema = JSON.parse(readFileSync(
      "schemas/uneffect-refinement-action-analysis-v2.schema.json", "utf8",
    ));
    expect(schema.$defs.boundedSelfAffine.properties).toMatchObject({
      rule: { enum: expect.arrayContaining([
        "precondition-bounded-self-affine",
        "precondition-bounded-guarded-self-affine",
      ]) },
      activation: expect.objectContaining({
        additionalProperties: false,
        required: ["selector", "when", "predecessor"],
      }),
    });
  });

  it("composes one immutable failure selector with catch/finally recurrence evidence", async () => {
    const spec = parseSpec(fileName, fixture).temporal;
    const structural = analyzeRefinementActionBodies(
      fileName, fixture, "caughtRetryBackoff", spec, {}, manifest,
    );
    expect(structural.diagnostics).toEqual([]);
    expect(structural.obligations).toContainEqual(expect.objectContaining({
      kind: "scalar-recurrence-fixed-point",
      status: "unknown",
      reason: "independent-proof-required",
      boundedSelfAffine: expect.objectContaining({
        rule: "precondition-bounded-guarded-self-affine",
        state: "delay",
        counter: "attempts",
        multiplier: 2,
        activation: {
          selector: "reject",
          when: true,
          predecessor: "catch",
        },
        budget: { name: "cfg-recurrence-geometric-iterations", limit: 8, observed: 4 },
      }),
      handlerCompletion: expect.objectContaining({
        predecessors: ["normal", "throw"],
        mandatoryFinally: true,
      }),
      fixedPoint: expect.objectContaining({
        recurrence: expect.objectContaining({
          assumptions: ["attempts >= 0 && attempts <= 4"],
          iteration: {
            attempts: "attempts - 1",
            delay: "reject ? delay * 2 : delay",
            reject: "reject",
          },
        }),
      }),
    }));

    const checked = await analyzeRefinementActionBodiesWithZ3(
      fileName, fixture, "caughtRetryBackoff", spec, { manifest },
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
    for (const candidate of [
      {
        ...recurrence!,
        boundedSelfAffine: {
          ...recurrence!.boundedSelfAffine!,
          activation: { selector: "reject", when: false, predecessor: "catch" as const },
        },
      },
      {
        ...recurrence!,
        boundedSelfAffine: { ...recurrence!.boundedSelfAffine!, activation: undefined },
      },
      {
        ...recurrence!,
        boundedSelfAffine: {
          ...recurrence!.boundedSelfAffine!,
          activation: { selector: "attempts", when: true, predecessor: "catch" as const },
        },
      },
    ]) {
      await expect(verifyRefinementRecurrenceCertificateWithZ3(spec, candidate))
        .resolves.toMatchObject({
          status: "refuted",
          checks: [expect.objectContaining({ reason: "bounded-self-affine-metadata-mismatch" })],
        });
    }
  });

  it("fails closed for mutable selectors and unsupported caught updates", async () => {
    for (const [name, source] of [
      ["missing-bound", fixture.replace(
        "/* uneffect:requires runtime.attempts >= 0 && runtime.attempts <= 4 */", "",
      )],
      ["oversized-bound", fixture.replaceAll("<= 4", "<= 9")],
      ["inverted-selector", fixture.replace(
        "if (runtime.reject) throw runtime.attempts;",
        "if (!runtime.reject) throw runtime.attempts;",
      )],
      ["mutable-selector", fixture.replace(
        "runtime.delay *= 2;",
        "runtime.delay *= 2;\n      runtime.reject = false;",
      )],
      ["wrong-factor", fixture.replace("runtime.delay *= 2", "runtime.delay *= 3")],
      ["normal-and-catch", fixture.replace(
        "if (runtime.reject) throw runtime.attempts;",
        "if (runtime.reject) throw runtime.attempts;\n      runtime.delay *= 2;",
      )],
      ["additive-update", fixture.replace("runtime.delay *= 2", "runtime.delay = runtime.delay * 2 + 1")],
    ] as const) {
      const candidateSpec = parseSpec(`${name}.ts`, source).temporal;
      const result = await analyzeRefinementActionBodiesWithZ3(
        `${name}.ts`, source, "caughtRetryBackoff", candidateSpec,
        { manifest: { ...manifest, fileName: `${name}.ts` } },
      );
      expect(result.obligations).toContainEqual(expect.objectContaining({
        kind: "scalar-recurrence-fixed-point",
        status: "unknown",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: expect.stringMatching(/^(unsupported-action-body|action-update-mismatch)$/),
      }));
    }
  });
});

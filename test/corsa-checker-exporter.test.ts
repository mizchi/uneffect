import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { exportCorsaCheckerFacts } from "../src/corsa-checker-exporter.js";
import { compareUneffectFrontends } from "../src/frontend-parity.js";

describe("corsa-bind checker fact exporter", () => {
  it("exports checker-backed functions, trivia, and resolved call edges", async () => {
    const files = { "fixture.ts": `
      /* uneffect: effect Console */
      export function emit(message: string): void { console.log(message) }
      export function main() { emit("x") }
    ` };
    const facts = await exportCorsaCheckerFacts({
      files,
      corsaExecutable: resolve("node_modules/.bin/tsgo"),
    });

    expect(facts).toMatchObject({
      schemaVersion: 7,
      provenance: { producer: "corsa-checker", checkerBacked: true },
      symbols: expect.arrayContaining([
        expect.objectContaining({ name: "emit", typeRepr: "(message: string) => void" }),
        expect.objectContaining({ name: "main", typeRepr: expect.any(String) }),
      ]),
      calls: [expect.objectContaining({ callbackTiming: "none" })],
      trivia: [expect.objectContaining({ text: expect.stringContaining("uneffect: effect Console") })],
    });

    const compared = await compareUneffectFrontends({
      files,
      corsaFacts: facts,
      requireCorsaCheckerFacts: true,
    });
    expect(compared.equivalent, compared.schemaDrift.map((item) => item.message).join("\n")).toBe(true);
    expect(compared.provenance).toMatchObject({
      producer: "corsa-checker",
      checkerBacked: true,
      satisfiesRequirement: true,
    });

    const forged = structuredClone(facts);
    const forgedComparison = await compareUneffectFrontends({
      files,
      corsaFacts: forged,
      requireCorsaCheckerFacts: true,
    });
    expect(forgedComparison).toMatchObject({
      equivalent: false,
      semanticEquivalent: true,
      provenance: { producer: "corsa-checker", checkerBacked: true, satisfiesRequirement: false },
    });
    expect(forgedComparison.schemaDrift).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("not authenticated"),
    }));
  });

  it("fails closed instead of labeling unsupported or unavailable input as checker-backed", async () => {
    await expect(exportCorsaCheckerFacts({
      files: { "a.ts": "export function a() {}", "b.ts": "export function b() {}" },
      corsaExecutable: resolve("node_modules/.bin/tsgo"),
    })).rejects.toThrow("exactly one source file");

    await expect(exportCorsaCheckerFacts({
      files: { "a.ts": "export function a() {}" },
      corsaExecutable: resolve("node_modules/.bin/does-not-exist"),
    })).rejects.toThrow("corsa-oxlint fact export failed");
  });
});

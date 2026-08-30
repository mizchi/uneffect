import { describe, expect, it } from "vitest";
import { parseContractDsl } from "../src/contract-dsl.js";
import { verifyUneffectProject } from "../src/project-verification.js";

const specification = `
  import { defineContract, int } from "@mizchi/uneffect/spec";
  export const Increment = defineContract({
    parameters: { value: int() },
    returns: int(),
    requires: [({ value }) => value >= 0, ({ value }) => value < 100],
    ensures: [({ value, result }) => result === value + 1, ({ result }) => result > 0],
  });
`;

describe("TypeScript contract DSL", () => {
  it("lowers a typed contract to Hoare-style expressions", () => {
    expect(parseContractDsl("counter.uneffect.ts", specification, "Increment")).toEqual({
      parameters: [{ name: "value", domain: "int" }],
      resultDomain: "int",
      requires: ["value >= 0", "value < 100"],
      ensures: ["result === value + 1", "result > 0"],
    });
  });

  it("connects the contract to the existing Z3 verifier", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value + 1 }`,
      "src/counter.uneffect.ts": specification,
    } });
    expect(result.obligations).toContainEqual(expect.objectContaining({ obligation: expect.objectContaining({ functionName: "increment" }), result: "verified" }));
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps a broken implementation as a counterexample", async () => {
    const result = await verifyUneffectProject({ files: {
      "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value }`,
      "src/counter.uneffect.ts": specification,
    } });
    expect(result.obligations).toContainEqual(expect.objectContaining({ obligation: expect.objectContaining({ functionName: "increment" }), result: "counterexample" }));
  });

  it("fails closed on block bodies and missing exports", () => {
    expect(() => parseContractDsl("bad.uneffect.ts", specification.replace("({ value }) => value >= 0", "({ value }) => { return value >= 0 }"), "Increment"))
      .toThrow(/single-expression predicate/);
    expect(() => parseContractDsl("bad.uneffect.ts", specification, "Missing")).toThrow(/does not export contract Missing/);
  });

  it("rejects an implementation signature that does not match the contract", async () => {
    await expect(verifyUneffectProject({ files: {
      "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: boolean): number { return 1 }`,
      "src/counter.uneffect.ts": specification,
    } })).rejects.toThrow(/parameter value expects int, implementation is bool/);
  });

  it("lowers Nat refinements to both Z3 domains and optional Valibot assertions", async () => {
    const refined = `
      import { defineContract, nat } from "@mizchi/uneffect/spec";
      export const Double = defineContract({
        parameters: { value: nat() }, returns: nat(),
        ensures: ({ value, result }) => result === value,
      });
    `;
    const result = await verifyUneffectProject({
      files: {
        "src/double.ts": `import type { Nat } from "@mizchi/uneffect";\n/* uneffect:contract from "./double.uneffect.ts#Double" */\nexport function double(value: Nat): Nat { return value }`,
        "src/double.uneffect.ts": refined,
      },
      runtimeAssertions: "fallback",
    });
    expect(result.obligations).toContainEqual(expect.objectContaining({ result: "verified" }));
    expect(result.emittedFiles["src/double.js"]).toContain("safeInteger()");
    expect(result.emittedFiles["src/double.js"]).toContain("minValue(0)");
  });
});

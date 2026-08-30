import { describe, expect, it } from "vitest";
import { parseContractDsl } from "../src/contract-dsl.js";
import { instrumentContractPredicates } from "../src/contract-runtime.js";
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

  it("lowers the safe predicate fragment to optional runtime assertions", async () => {
    const result = await verifyUneffectProject({
      files: {
        "src/counter.ts": `/* uneffect:contract from "./counter.uneffect.ts#Increment" */\nexport function increment(value: number): number { return value + 1 }`,
        "src/counter.uneffect.ts": specification,
      },
      runtimeAssertions: "fallback",
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.emittedFiles["src/counter.js"]).toContain("Uneffect precondition failed: value >= 0");
    expect(result.emittedFiles["src/counter.js"]).toContain("Uneffect postcondition failed: result === value + 1");
  });

  it("does not execute unsupported calls embedded in contract comments", () => {
    const result = instrumentContractPredicates("unsafe.ts", `
      /* uneffect:contract
       * requires validate(value)
       */
      function unsafe(value: number): number { return value }
    `);
    expect(result.code).not.toContain("if (!(validate(value)))");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "unsupported-function", parameter: "<contract>" }));
  });

  it("instruments every value return in a synchronous branching function", () => {
    const result = instrumentContractPredicates("branch.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function absolute(value: number): number {
        if (value < 0) return -value;
        return value;
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(2);
    expect(result.code).toContain("const __uneffect_contract_result_0 = (-value)");
    expect(result.code).toContain("const __uneffect_contract_result_1 = (value)");
  });

  it("does not treat returns in nested functions as outer contract exits", () => {
    const result = instrumentContractPredicates("nested.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function outer(value: number): number {
        const inner = () => { return -1 };
        return value;
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code.match(/Uneffect postcondition failed/g)).toHaveLength(1);
    expect(result.code).toContain("return -1");
  });

  it("chooses generated result names that do not shadow user bindings", () => {
    const result = instrumentContractPredicates("collision.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function collision(value: number): number {
        const __uneffect_contract_result_0 = value;
        return __uneffect_contract_result_0;
      }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.code).toContain("const __uneffect_contract_result_1 = (__uneffect_contract_result_0)");
  });

  it("fails closed when a postcondition function may fall through", () => {
    const result = instrumentContractPredicates("fallthrough.ts", `
      /* uneffect:contract
       * ensures result >= 0
       */
      function incomplete(value: number): number {
        if (value >= 0) return value;
      }
    `);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: "unsupported-function",
      parameter: "result",
      message: expect.stringContaining("fall through"),
    }));
    expect(result.code).not.toContain("Uneffect postcondition failed");
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
    expect(result.emittedFiles["src/double.js"]).toContain("Uneffect postcondition failed: result === value");
  });
});

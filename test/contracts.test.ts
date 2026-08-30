import { describe, expect, it } from "vitest";
import ts from "typescript";
import { verifyContractObligations, verifyContracts } from "../src/contracts.js";

function programFor(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022 };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreate) => requested === fileName
    ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TS)
    : original(requested, languageVersion, onError, shouldCreate);
  host.readFile = (requested) => requested === fileName ? source : ts.sys.readFile(requested);
  host.fileExists = (requested) => requested === fileName || ts.sys.fileExists(requested);
  return ts.createProgram([fileName], options, host);
}

describe("Hoare contract checker", () => {
  it("proves a valid postcondition", async () => {
    const source = `
      /* uneffect:contract requires x >= 0 */
      /* uneffect:contract ensures result > x */
      function inc(x: number) { return x + 1 }
    `;
    expect(await verifyContracts("ok.ts", source)).toEqual([]);
  });

  it("finds a counterexample", async () => {
    const source = `
      /* uneffect:contract requires x >= 0 */
      /* uneffect:contract ensures result > x */
      function same(x: number) { return x }
    `;
    const [failure] = await verifyContracts("bad.ts", source);
    expect(failure).toMatchObject({ functionName: "same", clause: "ensures" });
    expect(failure?.model).toContain("x");
    expect(failure?.obligationId).toMatch(/^inv_/);
    expect(failure?.artifact).toMatchObject({
      status: "counterexample",
      evidence: "unknown",
      obligationId: failure?.obligationId,
      source: { fileName: "bad.ts" },
    });
  });

  it("checks loop invariant initialization and preservation", async () => {
    const source = `
      /* uneffect:contract requires n >= 0 */
      /* uneffect:contract ensures result == n */
      function count(n: number) {
        let i = 0
        /* uneffect:contract invariant i >= 0 && i <= n */
        while (i < n) { i = i + 1 }
        return i
      }
    `;
    expect(await verifyContracts("loop.ts", source)).toEqual([]);
  });

  it("treats unsupported syntax as a non-proof", async () => {
    const [failure] = await verifyContracts("unsupported.ts", `
      /* uneffect:contract ensures result > 0 */
      function value() { for (;;) break; return 1 }
    `);
    expect(failure).toMatchObject({ functionName: "value", clause: "unsupported" });
    expect(failure?.artifact?.status).toBe("unsupported");
  });

  it("returns machine-readable evidence for successful obligations", async () => {
    const result = await verifyContractObligations("proof.ts", `
      /* uneffect:contract ensures result === x */
      function identity(x: Int): Int { return x }
    `);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toEqual([
      expect.objectContaining({
        obligationId: expect.stringMatching(/^inv_/), status: "verified", evidence: "verified", source: { fileName: "proof.ts", span: expect.any(Object) },
        controlFlow: expect.objectContaining({ schema: "uneffect-contract-control-flow/v1", completion: "return", blockId: expect.stringMatching(/^cfg_/), pathConditions: [] }),
      }),
    ]);
  });

  it("reports only the failing early-return path", async () => {
    const result = await verifyContractObligations("broken-absolute.ts", `
      /* uneffect:contract ensures result >= 0 */
      function brokenAbsolute(value: Int): Int {
        if (value < 0) return value
        return value
      }
    `);

    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.map(({ status }) => status).sort()).toEqual(["counterexample", "verified"]);
    expect(result.artifacts.find(({ status }) => status === "counterexample")?.controlFlow).toMatchObject({
      schema: "uneffect-contract-control-flow/v1",
      completion: "return",
      pathConditions: [expect.objectContaining({ kind: "binary", operator: "lt" })],
    });
  });

  it("imports finite numeric union facts from the TypeChecker", async () => {
    const fileName = "/digit.ts";
    const source = `
      type Int = number
      type Digit = 0 | 1 | 2
      /* uneffect:contract ensures result >= 0 && result <= 2 */
      function preserveDigit(value: Digit): Int { return value }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts[0]?.controlFlow?.narrowing).toMatchObject({
      source: "typescript-typechecker",
      typescriptVersion: ts.version,
      programDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      facts: ["value ∈ {0, 1, 2}"],
    });
  });

  it("does not invent a finite range for a same-shaped number alias", async () => {
    const fileName = "/wide.ts";
    const source = `
      type Int = number
      type Digit = number
      /* uneffect:contract ensures result >= 0 && result <= 2 */
      function preserveDigit(value: Digit): Int { return value }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "counterexample" });
    expect(result.artifacts[0]?.controlFlow?.narrowing).toBeUndefined();
  });

  it("does not consume TypeChecker narrowing from a Program with errors", async () => {
    const fileName = "/invalid-digit.ts";
    const source = `
      type Int = number
      type Digit = 0 | 1
      const invalid: Digit = 2
      /* uneffect:contract ensures result >= 0 && result <= 1 */
      function preserveDigit(value: Digit): Int { return value }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    expect(result.artifacts[0]?.controlFlow?.narrowing).toBeUndefined();
  });

  it("lowers TypeChecker-valid undefined and typeof guards", async () => {
    const cases = [
      {
        fileName: "/optional.ts",
        fact: "value: number | undefined via nullish guard",
        source: `
          type Int = number
          /* uneffect:contract ensures result >= 0 */
          function magnitude(value: Int | undefined): Int {
            if (value === undefined) return 0
            if (value < 0) return -value
            return value
          }
        `,
      },
      {
        fileName: "/typeof.ts",
        fact: "value: number | string via typeof number guard",
        source: `
          type Int = number
          /* uneffect:contract ensures result >= 0 */
          function magnitude(value: Int | string): Int {
            if (typeof value !== "number") return 0
            if (value < 0) return -value
            return value
          }
        `,
      },
      {
        fileName: "/nullish.ts",
        fact: "value: number | null | undefined via nullish guard",
        source: `
          type Int = number
          /* uneffect:contract ensures result >= 0 */
          function magnitude(value: Int | null | undefined): Int {
            if (value == null) return 0
            if (value < 0) return -value
            return value
          }
        `,
      },
    ];

    for (const { fileName, source, fact } of cases) {
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.diagnostics, fileName).toEqual([]);
      expect(result.artifacts.every(({ status }) => status === "verified"), fileName).toBe(true);
      expect(result.artifacts[0]?.controlFlow?.narrowing?.facts).toContain(fact);
    }
  });

  it("rejects a typeof branch that TypeScript does not narrow to number", async () => {
    const fileName = "/invalid-typeof.ts";
    const source = `
      type Int = number
      /* uneffect:contract ensures result >= 0 */
      function invalid(value: Int | string): Int {
        if (typeof value === "string") return value + 1
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("does not silently assume that an unmodeled call is pure", async () => {
    const [failure] = await verifyContracts("call.ts", `
      /* uneffect:contract ensures result === x */
      function wrapped(x: Int): Int { touch(); return x }
    `);
    expect(failure).toMatchObject({ clause: "unsupported", message: expect.stringContaining("verified function summary") });
  });

  it("lowers only imported Effect pipe with inline unary expression callbacks", async () => {
    expect(await verifyContracts("effect-pipe.ts", `
      import { pipe as flow } from "effect/Function"
      /* uneffect:contract requires x >= 0 */
      /* uneffect:contract ensures result === x + 2 */
      function addTwo(x: number) { return flow(x, value => value + 1, value => value + 1) }
    `)).toEqual([]);

    const [spoofed] = await verifyContracts("spoofed-pipe.ts", `
      function pipe(value: number, stage: (value: number) => number) { return stage(value) }
      /* uneffect:contract ensures result === x + 1 */
      function addOne(x: number) { return pipe(x, value => value + 1) }
    `);
    expect(spoofed).toMatchObject({ clause: "unsupported", message: expect.stringContaining("unsupported invariant expression") });
  });
});

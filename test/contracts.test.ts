import { describe, expect, it } from "vitest";
import ts from "typescript";
import { attachContractEffectBoundaries, reconcileContractArtifacts, verifyContractObligations, verifyContracts } from "../src/contracts.js";
import { verifyUneffectProject } from "../src/project-verification.js";
import { collectAssumptionLedger } from "../src/assumptions.js";
import { lowerInvariantProgram } from "../src/invariant-ir.js";

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

function programForFiles(files: Readonly<Record<string, string>>, overrides: ts.CompilerOptions = {}): ts.Program {
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: ["node"], ...overrides };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreate) => files[requested] !== undefined
    ? ts.createSourceFile(requested, files[requested]!, languageVersion, true, ts.ScriptKind.TS)
    : original(requested, languageVersion, onError, shouldCreate);
  host.readFile = (requested) => files[requested] ?? ts.sys.readFile(requested);
  host.fileExists = (requested) => files[requested] !== undefined || ts.sys.fileExists(requested);
  return ts.createProgram(Object.keys(files), options, host);
}

describe("Hoare contract checker", () => {
  it("proves a valid postcondition", async () => {
    const source = `
      /* uneffect:requires x >= 0 */
      /* uneffect:ensures result > x */
      function inc(x: number) { return x + 1 }
    `;
    expect(await verifyContracts("ok.ts", source)).toEqual([]);
  });

  it("finds a counterexample", async () => {
    const source = `
      /* uneffect:requires x >= 0 */
      /* uneffect:ensures result > x */
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
      /* uneffect:requires n >= 0 */
      /* uneffect:ensures result == n */
      function count(n: number) {
        let i = 0
        /* uneffect:loop_invariant i >= 0 && i <= n */
        while (i < n) { i = i + 1 }
        return i
      }
    `;
    expect(await verifyContracts("loop.ts", source)).toEqual([]);
  });

  it("treats unsupported syntax as a non-proof", async () => {
    const [failure] = await verifyContracts("unsupported.ts", `
      /* uneffect:ensures result > 0 */
      function value() { for (;;) break; return 1 }
    `);
    expect(failure).toMatchObject({ functionName: "value", clause: "unsupported" });
    expect(failure?.artifact?.status).toBe("unsupported");
  });

  it("returns machine-readable evidence for successful obligations", async () => {
    const result = await verifyContractObligations("proof.ts", `
      /* uneffect:ensures result === x */
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
      /* uneffect:ensures result >= 0 */
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
      /* uneffect:ensures result >= 0 && result <= 2 */
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
      /* uneffect:ensures result >= 0 && result <= 2 */
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
      /* uneffect:ensures result >= 0 && result <= 1 */
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
          /* uneffect:ensures result >= 0 */
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
          /* uneffect:ensures result >= 0 */
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
          /* uneffect:ensures result >= 0 */
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

  it("lowers TypeChecker-valid Boolean typeof guards", async () => {
    const fileName = "/typeof-boolean.ts";
    const source = `
      /* uneffect:ensures result === true || result === false */
      function normalize(value: boolean | string): boolean {
        if (typeof value !== "boolean") return false
        return value
      }
      /* uneffect:ensures result === true */
      function classify(value: boolean | string): boolean {
        if (typeof value === "boolean") return value || true
        return true
      }
      /* uneffect:ensures result === true || result === false */
      function stringFirst(value: boolean | string): boolean {
        if (typeof value === "string") return false
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.flatMap(({ controlFlow }) => controlFlow?.narrowing?.facts ?? []))
      .toContain("value: boolean | string via typeof boolean guard");
  });

  it("fails closed for incompatible scalar typeof unions", async () => {
    const fileName = "/unsupported-typeof-mixed-scalars.ts";
    const source = `
      /* uneffect:ensures result === true || result === false */
      function mixed(value: boolean | number): boolean {
        if (typeof value === "boolean") return value
        return false
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("splits TypeChecker-valid numeric nullish coalescing through parameters and immutable aliases", async () => {
    const fileName = "/nullish-coalescing.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === 0 || result === value */
      function returned(value: Int | null | undefined): Int {
        return value ?? 0
      }
      /* uneffect:ensures result === 1 || result === value */
      function initialized(value: Int | null): Int {
        const current = value
        const selected = current ?? 1
        return selected
      }
      /* uneffect:ensures result === 2 || result === value */
      function assigned(value: Int | undefined): Int {
        let selected = 0
        selected = value ?? 2
        return selected
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(6);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.flatMap(({ controlFlow }) => controlFlow?.narrowing?.facts ?? []))
      .toContain("value: number | null | undefined via nullish guard");
  });

  it("fails closed for unsupported nullish coalescing shapes", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result === 0 || result === value */
        function mutableAlias(value: Int | null): Int {
          let current = value
          return current ?? 0
        }
      `,
      `
        type Int = number
        declare function fallback(): Int
        /* uneffect:ensures result === 0 || result === value */
        function calledFallback(value: Int | undefined): Int {
          return value ?? fallback()
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result === 0 || result === value */
        function plainNumber(value: Int): Int {
          return value ?? 0
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result === result */
        function mixed(value: boolean | Int | undefined): boolean {
          return value ?? false
        }
      `,
    ];

    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-nullish-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("updates nullable presence after identifier nullish assignment", async () => {
    const fileName = "/nullish-assignment.ts";
    const source = `
      type Int = number
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= 0 */
      function initialized(value: Int | null, choose: boolean): Int {
        value ??= choose ? 1 : 2
        return value ?? -1
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.length).toBeGreaterThanOrEqual(3);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not claim that a nullable RHS makes nullish assignment present", async () => {
    const fileName = "/nullable-nullish-assignment-source.ts";
    const source = `
      /* uneffect:ensures result === true */
      function invalidContract(target: boolean | null, source: boolean | null): boolean {
        target ??= source
        return target != null
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts.some(({ status }) => status === "counterexample")).toBe(true);
    expect(result.diagnostics.some(({ message }) => message.includes("can fail"))).toBe(true);
  });

  it("tracks TypeChecker-backed nullable Boolean guards, coalescing, and assignment", async () => {
    const fileName = "/nullable-boolean.ts";
    const source = `
      /* uneffect:ensures result === true || result === false */
      function selected(value: boolean | null | undefined): boolean {
        return value ?? false
      }
      /* uneffect:ensures result === true */
      function initialized(value: boolean | undefined): boolean {
        value ??= true
        if (value === undefined) return false
        return value || true
      }
      /* uneffect:ensures result === true || result === false */
      function guarded(value: boolean | null): boolean {
        if (value === null) return false
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.flatMap(({ controlFlow }) => controlFlow?.narrowing?.facts ?? []))
      .toContain("value: boolean | null | undefined via nullish guard");
  });

  it("correlates nullable Boolean truthiness with presence", async () => {
    const fileName = "/nullable-boolean-truthiness.ts";
    const source = `
      /* uneffect:ensures result === true */
      function presentWhenTruthy(value: boolean | null | undefined): boolean {
        if (value) return value != null
        return true
      }
      /* uneffect:ensures result === true */
      function undefinedPresentWhenTruthy(value: boolean | undefined): boolean {
        if (value) return typeof value !== "undefined"
        return true
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("keeps nullable Boolean literal equality distinct from absence", async () => {
    const fileName = "/nullable-boolean-literal-equality.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === 0 */
      function absentIsNotFalse(value: boolean | null | undefined): Int {
        if (value == null) {
          if ((value as boolean | null | undefined) === false) return -1
        }
        return 0
      }
      /* uneffect:ensures result === 0 */
      function absentIsDifferentFromFalse(value: boolean | null | undefined): Int {
        if (value == null) {
          if ((value as boolean | null | undefined) !== false) return 0
          return -1
        }
        return 0
      }
      /* uneffect:ensures result === 0 */
      function looseAbsentIsNotFalse(value: boolean | null): Int {
        if (value == null) {
          if ((value as boolean | null) == false) return -1
        }
        return 0
      }
      /* uneffect:ensures result === 0 */
      function looseAbsentIsDifferentFromFalse(value: boolean | null): Int {
        if (value == null) {
          if ((value as boolean | null) != false) return 0
          return -1
        }
        return 0
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not erase nullable presence through a mutable scalar alias", async () => {
    const fileName = "/unsupported-nullable-boolean-mutable-alias.ts";
    const source = `
      /* uneffect:ensures result === false */
      function invalidProof(value: boolean | null): boolean {
        let current = value
        if (value == null) return current !== false
        return false
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("allows scalar copies after TypeChecker excludes nullish values", async () => {
    const fileName = "/narrowed-nullable-scalar-copy.ts";
    const source = `
      /* uneffect:ensures result === true || result === false */
      function initialized(value: boolean | null): boolean {
        if (value == null) return false
        let current = value
        return current
      }
      /* uneffect:ensures result === true || result === false */
      function assigned(value: boolean | undefined): boolean {
        let current = false
        if (value === undefined) return current
        current = value
        return current
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("updates nullable presence after a plain scalar assignment", async () => {
    const fileName = "/nullable-plain-assignment.ts";
    const source = `
      /* uneffect:ensures result === false */
      function noStalePresence(value: boolean | null): boolean {
        if (value == null) {
          value = true
          return value !== true
        }
        return false
      }
      /* uneffect:ensures result === 1 */
      function numeric(value: number | undefined): number {
        value = 1
        return value ?? -1
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("fails closed when plain assignment cannot establish nullable presence", async () => {
    const cases = [
      `
        /* uneffect:ensures result === false */
        function nullableCopy(value: boolean | null, other: boolean | undefined): boolean {
          value = other
          return false
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result === 0 */
        function property(value: Int | undefined, box: { current?: Int }): Int {
          box.current = value
          return 0
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-nullable-plain-assignment-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("updates nullable absence after direct null or undefined assignment", async () => {
    const fileName = "/nullable-nullish-assignment.ts";
    const source = `
      /* uneffect:ensures result === true */
      function clearedBoolean(value: boolean | null): boolean {
        value = null
        return value === null
      }
      /* uneffect:ensures result === 2 */
      function clearedNumber(value: number | undefined): number {
        value = undefined
        return value ?? 2
      }
      /* uneffect:ensures result === 3 */
      function clearedCombined(value: number | null | undefined): number {
        value = null
        return value ?? 3
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("composes conditional nullable assignment values", async () => {
    const fileName = "/conditional-nullable-assignment.ts";
    const source = `
      /* uneffect:ensures result === 1 || result === 2 */
      function scalarOrNull(value: number | null, choose: boolean): number {
        value = choose ? 1 : null
        return value ?? 2
      }
      /* uneffect:ensures result === 3 */
      function nullOrUndefined(value: number | null | undefined, choose: boolean): number {
        value = choose ? null : undefined
        return value ?? 3
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("copies compatible nullable identifier state without losing presence", async () => {
    const fileName = "/nullable-state-copy.ts";
    const source = `
      /* uneffect:ensures result === true */
      function copy(target: boolean | undefined, source: boolean | undefined): boolean {
        target = source
        if (typeof source === "undefined") return typeof target === "undefined"
        if (typeof target === "undefined") return false
        return target === source
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not mutate an immutable alias through shared nullable state", async () => {
    const cases = [
      `
        /* uneffect:ensures result === true */
        function plain(value: boolean | null): boolean {
          const old = value
          value = true
          return old != null
        }
      `,
      `
        /* uneffect:ensures result === true */
        function nullish(value: boolean | undefined): boolean {
          const old = value
          value ??= true
          return typeof old !== "undefined"
        }
      `,
      `
        /* uneffect:ensures result === true */
        function cleared(value: boolean | null): boolean {
          const old = value
          value = null
          return old == null
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-shared-nullable-alias-mutation-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("fails closed for unestablished nullish assignment values", async () => {
    const cases = [
      `
        /* uneffect:ensures result === 0 */
        function wrongKind(value: number | null): number {
          value = undefined
          return 0
        }
      `,
      `
        declare function absent(): undefined
        /* uneffect:ensures result === 0 */
        function called(value: number | undefined): number {
          value = absent()
          return 0
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-nullish-value-assignment-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("does not apply nullable Boolean truthiness semantics to numbers", async () => {
    const fileName = "/unsupported-nullable-number-truthiness.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === 0 || result === 1 */
      function classify(value: Int | undefined): Int {
        if (value) return 1
        return 0
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("lowers typeof undefined for exact nullable scalar unions", async () => {
    const fileName = "/typeof-undefined.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      function magnitude(value: Int | undefined): Int {
        if (typeof value === "undefined") return 0
        return value < 0 ? -value : value
      }
      /* uneffect:ensures result === true */
      function enabled(value: boolean | undefined): boolean {
        if (typeof value !== "undefined") return value || true
        return true
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not collapse null and undefined for typeof narrowing", async () => {
    const fileName = "/unsupported-typeof-undefined-nullish.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      function classify(value: Int | null | undefined): Int {
        if (typeof value === "undefined") return 0
        if (value === null) return 1
        return value < 0 ? -value : value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("fails closed for unsupported nullish-assignment shapes", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function mutableAlias(value: Int | null): Int {
          let current = value
          current ??= 1
          return current
        }
      `,
      `
        type Int = number
        declare function fallback(): Int
        /* uneffect:ensures result >= 0 */
        function effectful(value: Int | undefined): Int {
          value ??= fallback()
          return value
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function property(value: { current?: Int }): Int {
          value.current ??= 1
          return value.current
        }
      `,
      `
        /* uneffect:ensures result === false */
        function incompatible(target: boolean | null, source: boolean | undefined): boolean {
          target ??= source
          return false
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-nullish-assignment-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("preserves Boolean short-circuit paths in scalar returns, initializers, and assignments", async () => {
    const fileName = "/boolean-short-circuit.ts";
    const source = `
      /* uneffect:ensures result === (left && right) */
      function returned(left: boolean, right: boolean): boolean {
        return left && right
      }
      /* uneffect:ensures result === (left || right) */
      function initialized(left: boolean, right: boolean): boolean {
        const selected = left || right
        return selected
      }
      /* uneffect:ensures result === (left && (middle || right)) */
      function assigned(left: boolean, middle: boolean, right: boolean): boolean {
        let selected = false
        selected = left && (middle || right)
        return selected
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(7);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.map(({ controlFlow }) => controlFlow?.pathConditions.length))
      .toEqual([1, 1, 1, 1, 1, 2, 2]);
  });

  it("does not treat JavaScript truthiness or effectful logical operands as Boolean CFG paths", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result === right */
        function truthy(left: Int, right: Int): Int { return left && right }
      `,
      `
        declare function choose(): boolean
        /* uneffect:ensures result === enabled */
        function effectful(enabled: boolean): boolean { return enabled || choose() }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-short-circuit-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("preserves Boolean short-circuit paths for logical assignment", async () => {
    const fileName = "/boolean-logical-assignment.ts";
    const source = `
      /* uneffect:ensures result === (left && right) */
      function assignAnd(left: boolean, right: boolean): boolean {
        let selected = left
        selected &&= right
        return selected
      }
      /* uneffect:ensures result === (left || right) */
      function assignOr(left: boolean, right: boolean): boolean {
        let selected = left
        selected ||= right
        return selected
      }
      /* uneffect:ensures result === (left && (middle || right)) */
      function nested(left: boolean, middle: boolean, right: boolean): boolean {
        let selected = left
        selected &&= middle || right
        return selected
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(7);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("fails closed for non-Boolean or effectful logical assignment", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result === right */
        function truthy(left: Int, right: Int): Int {
          let selected = left
          selected &&= right
          return selected
        }
      `,
      `
        declare function choose(): boolean
        /* uneffect:ensures result === enabled */
        function effectful(enabled: boolean): boolean {
          let selected = enabled
          selected ||= choose()
          return selected
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-logical-assignment-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("executes bare lexical blocks while preserving outer writes and dropping local bindings", async () => {
    const fileName = "/lexical-block.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value + 2 */
      function outerWrite(value: Int): Int {
        let result = value
        {
          const increment = 2
          result = result + increment
        }
        return result
      }
      /* uneffect:ensures result === value + 1 || result === value - 1 */
      function nestedReturn(value: Int, positive: boolean): Int {
        {
          const adjusted = positive ? value + 1 : value - 1
          return adjusted
        }
      }
      /* uneffect:ensures result === value + 3 */
      function functionScopedVar(value: Int): Int {
        {
          var increment = 3
        }
        return value + increment
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(4);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("restores a path-stable tracked scalar after lexical shadowing", async () => {
    const fileName = "/lexical-shadow.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value */
      function shadowed(value: Int): Int {
        {
          const value = 1
          const observed = value + 1
        }
        return value
      }
      /* uneffect:ensures result === 1 */
      function returnsInner(value: Int): Int {
        { const value = 1; return value }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("restores path-dependent scalar states after lexical shadowing", async () => {
    const fileName = "/path-dependent-lexical-shadow.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value || result === value + 1 */
      function shadowed(value: Int, enabled: boolean): Int {
        let result = value
        if (enabled) result += 1
        { const result = 0 }
        return result
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("applies lexical scope to branch blocks while retaining writes to outer bindings", async () => {
    const fileName = "/branch-lexical-scope.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value + 1 || result === value - 1 */
      function adjusted(value: Int, positive: boolean): Int {
        let result = value
        if (positive) {
          const amount = 1
          result += amount
        } else {
          const amount = 1
          result -= amount
        }
        return result
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("restores path-stable branch and catch binding shadows", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:requires enabled */
        /* uneffect:ensures result === value */
        function branchShadow(value: Int, enabled: boolean): Int {
          if (enabled) { const value = 1 }
          return value
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result === value */
        function catchShadow(value: Int): Int {
          try { throw 1 } catch (value) { }
          return value
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-scope-shadow-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "verified", evidence: "verified" });
    }
  });

  it("uses a shadowing catch payload inside the handler and restores the outer scalar", async () => {
    const fileName = "/catch-payload-shadow.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === 1 */
      function caught(value: Int): Int {
        try { throw 1 } catch (value) { return value }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("restores divergent predecessor values after a shadowing catch binding", async () => {
    const fileName = "/path-dependent-catch-shadow.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value || result === value + 1 */
      function caught(value: Int, enabled: boolean): Int {
        let result = value
        if (enabled) result += 1
        try { if (enabled) throw 1; throw 2 } catch (result) {}
        return result
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("keeps switch-wide lexical shadows inside the case block", async () => {
    const fileName = "/switch-lexical-shadow.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value */
      function switched(value: Int, enabled: boolean): Int {
        switch (enabled) {
          case true: const value = 1; break
          default: break
        }
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("lowers TypeChecker-resolved Math.abs, Math.min, and Math.max into scalar paths", async () => {
    const fileName = "/math-scalar.ts";
    const source = `
      type Int = number
      /* uneffect:ensures (result === value || result === -value) && result >= 0 */
      function absolute(value: Int): Int { return Math.abs(value) }
      /* uneffect:ensures (result === left || result === right) && result <= left && result <= right */
      function minimum(left: Int, right: Int): Int { return Math.min(left, right) }
      /* uneffect:ensures (result === left || result === middle || result === right) && result >= left && result >= middle && result >= right */
      function maximum(left: Int, middle: Int, right: Int): Int { return Math.max(left, middle, right) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(8);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not trust shadowed Math or effectful Math arguments", async () => {
    const cases = [
      `
        type Int = number
        const Math = { abs(value: Int) { return value } }
        /* uneffect:ensures result >= 0 */
        function shadowed(value: Int): Int { return Math.abs(value) }
      `,
      `
        type Int = number
        declare function read(): Int
        /* uneffect:ensures result >= 0 */
        function effectful(): Int { return Math.abs(read()) }
      `,
      `
        type Int = number
        /* uneffect:ensures result === value */
        function unsupportedArity(value: Int): Int { return Math.max() }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-math-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("resolves immutable callable aliases of reviewed Math operations", async () => {
    const fileName = "/math-alias.ts";
    const source = `
      type Int = number
      const absoluteValue = Math.abs
      const renamedAbsolute = absoluteValue
      const { min: minimum, max: maximum } = Math
      /* uneffect:ensures (result === value || result === -value) && result >= 0 */
      function absolute(value: Int): Int { return renamedAbsolute(value) }
      /* uneffect:ensures (result === left || result === right) && result <= left && result <= right */
      function least(left: Int, right: Int): Int { return minimum(left, right) }
      /* uneffect:ensures (result === left || result === middle || result === right) && result >= left && result >= middle && result >= right */
      function greatest(left: Int, middle: Int, right: Int): Int { return maximum(left, middle, right) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(8);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not resolve mutable, shadowed, or computed Math aliases", async () => {
    const cases = [
      `
        type Int = number
        let absoluteValue = Math.abs
        /* uneffect:ensures result >= 0 */
        function mutable(value: Int): Int { return absoluteValue(value) }
      `,
      `
        type Int = number
        const Math = { abs(value: Int) { return value } }
        const absoluteValue = Math.abs
        /* uneffect:ensures result >= 0 */
        function shadowed(value: Int): Int { return absoluteValue(value) }
      `,
      `
        type Int = number
        const operation = "abs" as const
        const absoluteValue = Math[operation]
        /* uneffect:ensures result >= 0 */
        function computed(value: Int): Int { return absoluteValue(value) }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-math-alias-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("lowers reviewed Math integer casts over the finite Real abstraction", async () => {
    const fileName = "/math-integer-casts.ts";
    const source = `
      type Int = number
      type Float = number
      const { trunc: truncate } = Math
      /* uneffect:ensures result <= value && value < result + 1 */
      function floored(value: Float): Int { return Math.floor(value) }
      /* uneffect:ensures result >= value && value > result - 1 */
      function ceiled(value: Float): Int { return Math.ceil(value) }
      /* uneffect:ensures (value >= 0 && result <= value && value < result + 1) || (value < 0 && result >= value && value > result - 1) */
      function truncated(value: Float): Int { return truncate(value) }
      /* uneffect:ensures result <= value + 0.5 && value + 0.5 < result + 1 */
      function rounded(value: Float): Int { return Math.round(value) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(5);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("keeps unsupported Math integer-cast boundaries fail-closed", async () => {
    const cases = [
      `
        type Int = number
        type Float = number
        const Math = { floor(value: Float) { return 0 } }
        /* uneffect:ensures result <= value */
        function shadowed(value: Float): Int { return Math.floor(value) }
      `,
      `
        type Int = number
        type Float = number
        declare function read(): Float
        /* uneffect:ensures result <= 0 */
        function effectful(): Int { return Math.floor(read()) }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-math-cast-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("lowers reviewed Math.sign into negative, zero, and positive paths", async () => {
    const fileName = "/math-sign.ts";
    const source = `
      type Int = number
      type Float = number
      const direction = Math.sign
      /* uneffect:ensures (value < 0 && result === -1) || (value === 0 && result === 0) || (value > 0 && result === 1) */
      function sign(value: Float): Int { return direction(value) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not trust a shadowed Math.sign", async () => {
    const fileName = "/unsupported-math-sign.ts";
    const source = `
      type Int = number
      const Math = { sign(_value: Int) { return 0 } }
      /* uneffect:ensures result === 0 */
      function sign(value: Int): Int { return Math.sign(value) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("lowers bounded exponentiation and reviewed Math.pow to repeated multiplication", async () => {
    const fileName = "/bounded-power.ts";
    const source = `
      type Int = number
      const power = Math.pow
      /* uneffect:ensures result === value * value */
      function squared(value: Int): Int { return value ** 2 }
      /* uneffect:ensures result === value * value * value */
      function cubed(value: Int): Int { return power(value, 3) }
      /* uneffect:ensures result === 1 */
      function identity(value: Int): Int { return Math.pow(value, 0) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("rejects dynamic, negative, over-budget, and shadowed powers", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result === value */
        function dynamic(value: Int, exponent: Int): Int { return value ** exponent }
      `,
      `
        type Int = number
        /* uneffect:ensures result === value */
        function negative(value: Int): Int { return Math.pow(value, -1) }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function large(value: Int): Int { return value ** 9 }
      `,
      `
        type Int = number
        const Math = { pow(value: Int, _exponent: Int) { return value } }
        /* uneffect:ensures result === value */
        function shadowed(value: Int): Int { return Math.pow(value, 2) }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-power-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("models JavaScript signed integer remainder for a nonzero literal divisor", async () => {
    const fileName = "/signed-remainder.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result > -3 && result < 3 && ((value >= 0 && result >= 0) || (value < 0 && result <= 0)) */
      function remainder(value: Int): Int { return value % 3 }
      /* uneffect:ensures result > -5 && result < 5 */
      function negativeDivisor(value: Int): Int { return value % -5 }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(4);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("updates an integer with JavaScript signed remainder for a nonzero literal divisor", async () => {
    const fileName = "/signed-remainder-assignment.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result > -3 && result < 3 && ((value >= 0 && result >= 0) || (value < 0 && result <= 0)) */
      function remainder(value: Int): Int { value %= 3; return value }
      /* uneffect:ensures result > -5 && result < 5 */
      function negativeDivisor(value: Int): Int { value %= -5; return value }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(4);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not equate unsupported JavaScript division or remainder with raw SMT arithmetic", async () => {
    const cases = [
      `
        type Float = number
        /* uneffect:ensures result === result */
        function divide(value: Float): Float { return 1 / value }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function dynamic(value: Int, divisor: Int): Int { return value % divisor }
      `,
      `
        type Int = number
        /* uneffect:ensures result === value */
        function zero(value: Int): Int { return value % 0 }
      `,
      `
        type Float = number
        /* uneffect:ensures result >= 0 */
        function real(value: Float): Float { return value % 3 }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/unsupported-js-division-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("rejects a typeof branch that TypeScript does not narrow to number", async () => {
    const fileName = "/invalid-typeof.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      function invalid(value: Int | string): Int {
        if (typeof value === "string") return value + 1
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("imports readonly discriminated-union guards from the TypeChecker", async () => {
    const fileName = "/discriminated.ts";
    const source = `
      type Int = number
      type Command =
        | { readonly kind: "decrement" }
        | { readonly kind: "idle" }
        | { readonly kind: "increment" }
      /* uneffect:ensures result >= -1 && result <= 1 */
      function delta(command: Command): Int {
        if (command.kind === "decrement") return -1
        if (command.kind === "increment") return 1
        if (command.kind === "idle") return 0
        return 100
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts[0]?.controlFlow?.narrowing?.facts).toContain(
      'command.kind ∈ {"decrement", "idle", "increment"}',
    );
  });

  it("does not transfer a discriminant fact to a same-spelled object or open string property", async () => {
    const cases = [
      `
        type Int = number
        type Command = { readonly kind: "idle" } | { readonly kind: "run" }
        /* uneffect:ensures result >= 0 */
        function shadowed(command: Command): Int {
          const other = { kind: "idle" }
          if (other.kind === "idle") return -1
          return 0
        }
      `,
      `
        type Int = number
        type Command = { readonly kind: string }
        /* uneffect:ensures result >= 0 */
        function open(command: Command): Int {
          if (command.kind === "idle") return -1
          return 0
        }
      `,
      `
        type Int = number
        type Command = { kind: "idle" } | { kind: "run" }
        /* uneffect:ensures result >= 0 */
        function mutable(command: Command): Int {
          if (command.kind === "idle") return -1
          return 0
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/discriminated-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
      expect(result.artifacts[0]?.controlFlow?.narrowing?.facts ?? []).not.toContainEqual(expect.stringContaining(".kind ∈"));
    }
  });

  it("imports TypeChecker-narrowed readonly discriminant payload literals", async () => {
    const fileName = "/discriminated-payload.ts";
    const source = `
      type Int = number
      type Packet =
        | { readonly kind: "zero"; readonly value: 0 }
        | { readonly kind: "one"; readonly value: 1 }
        | { readonly kind: "two"; readonly value: 2 }
      /* uneffect:ensures result >= 0 && result <= 2 */
      function decode(packet: Packet): Int {
        if (packet.kind === "zero") return packet.value
        if (packet.kind === "one") return packet.value
        if (packet.kind === "two") return packet.value
        return 100
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("packet.value = 2")))).toBe(true);
  });

  it("rejects discriminant payload reads before narrowing or through mutable storage", async () => {
    const cases = [
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function beforeNarrow(packet: Packet): Int { return packet.value }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; value: 0 } | { readonly kind: "one"; value: 1 }
        /* uneffect:ensures result >= 0 */
        function mutablePayload(packet: Packet): Int {
          if (packet.kind === "zero") return packet.value
          return packet.value
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function otherObject(packet: Packet): Int {
          const other = { value: -1 }
          if (packet.kind === "zero") return other.value
          return 0
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/discriminated-payload-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("models a narrowed readonly Nat payload as a member-scoped solver value", async () => {
    const fileName = "/discriminated-nat-payload.ts";
    const source = `
      type Int = number
      type Nat = number
      type Packet =
        | { readonly kind: "value"; readonly value: Nat }
        | { readonly kind: "empty"; readonly value: 0 }
      /* uneffect:ensures result >= 0 */
      function decode(packet: Packet): Int {
        if (packet.kind === "value") return packet.value
        return packet.value
      }
    `;
    const program = programFor(fileName, source);
    const result = await verifyContractObligations(fileName, source, undefined, program);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(lowerInvariantProgram(fileName, source, program)).toEqual(expect.arrayContaining([
      expect.objectContaining({ variables: expect.arrayContaining([
        expect.objectContaining({ name: expect.stringContaining("packet_uneffect_kind_value_value"), domain: "nat" }),
      ]) }),
    ]));
  });

  it("does not invent a range for a narrowed readonly number payload", async () => {
    const fileName = "/discriminated-wide-payload.ts";
    const source = `
      type Int = number
      type Packet =
        | { readonly kind: "value"; readonly value: number }
        | { readonly kind: "empty"; readonly value: 0 }
      /* uneffect:ensures result >= 0 */
      function decode(packet: Packet): Int {
        if (packet.kind === "value") return packet.value
        return packet.value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.artifacts).toContainEqual(expect.objectContaining({ status: "counterexample" }));
  });

  it("models a narrowed readonly nested scalar payload", async () => {
    const fileName = "/discriminated-nested-payload.ts";
    const source = `
      type Int = number
      type Nat = number
      type Packet =
        | { readonly kind: "value"; readonly payload: { readonly count: Nat } }
        | { readonly kind: "empty"; readonly payload: { readonly count: 0 } }
      /* uneffect:ensures result >= 0 */
      function decode(packet: Packet): Int {
        if (packet.kind === "value") return packet.payload.count
        return packet.payload.count
      }
    `;
    const program = programFor(fileName, source);
    const result = await verifyContractObligations(fileName, source, undefined, program);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("packet.payload.count: nat")))).toBe(true);
  });

  it("rejects a nested payload path with mutable or computed storage", async () => {
    const cases = [
      `
        type Int = number
        type Packet =
          | { readonly kind: "zero"; payload: { readonly count: 0 } }
          | { readonly kind: "one"; payload: { readonly count: 1 } }
        /* uneffect:ensures result >= 0 */
        function mutable(packet: Packet): Int {
          if (packet.kind === "zero") return packet.payload.count
          return packet.payload.count
        }
      `,
      `
        type Int = number
        type Packet =
          | { readonly kind: "zero"; readonly payload: { readonly count: 0 } }
          | { readonly kind: "one"; readonly payload: { readonly count: 1 } }
        /* uneffect:ensures result >= 0 */
        function computed(packet: Packet): Int {
          if (packet.kind === "zero") return packet.payload["count"]
          return packet.payload["count"]
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/discriminated-nested-payload-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("models a readonly scalar payload destructured after discriminant narrowing", async () => {
    const fileName = "/discriminated-destructured-payload.ts";
    const source = `
      type Int = number
      type Nat = number
      type Packet =
        | { readonly kind: "value"; readonly value: Nat; readonly payload: { readonly count: Nat } }
        | { readonly kind: "empty"; readonly value: 0; readonly payload: { readonly count: 0 } }
      /* uneffect:ensures result >= 0 */
      function decode(packet: Packet): Int {
        if (packet.kind === "value") {
          const { value: count } = packet
          return count
        }
        const { value } = packet
        return value
      }
      /* uneffect:ensures result >= 0 */
      function nested(packet: Packet): Int {
        if (packet.kind === "value") {
          const { count } = packet.payload
          return count
        }
        const { count: emptyCount } = packet.payload
        return emptyCount
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("count: nat")))).toBe(true);
  });

  it("rejects pre-narrow, mutable, defaulted, or rest payload destructuring", async () => {
    const cases = [
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function preNarrow(packet: Packet): Int { const { value } = packet; return value }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; value: 0 } | { readonly kind: "one"; value: 1 }
        /* uneffect:ensures result >= 0 */
        function mutable(packet: Packet): Int {
          if (packet.kind === "zero") { const { value } = packet; return value }
          const { value } = packet; return value
        }
      `,
      `
        type Int = number
        type Packet =
          | { readonly kind: "zero"; payload: { readonly count: 0 } }
          | { readonly kind: "one"; payload: { readonly count: 1 } }
        /* uneffect:ensures result >= 0 */
        function mutablePath(packet: Packet): Int {
          if (packet.kind === "zero") { const { count } = packet.payload; return count }
          return 0
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value?: 0 } | { readonly kind: "one"; readonly value?: 1 }
        /* uneffect:ensures result >= 0 */
        function defaulted(packet: Packet): Int {
          if (packet.kind === "zero") { const { value = -1 } = packet; return value }
          return 0
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function rest(packet: Packet): Int {
          if (packet.kind === "zero") { const { kind, ...remaining } = packet; return remaining.value }
          return 0
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/discriminated-destructured-payload-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("models fixed-index reads from a narrowed readonly tuple payload", async () => {
    const fileName = "/discriminated-tuple-payload.ts";
    const source = `
      type Int = number
      type Nat = number
      type Packet =
        | { readonly kind: "pair"; readonly values: readonly [Nat, Nat] }
        | { readonly kind: "empty"; readonly values: readonly [0, 0] }
      /* uneffect:ensures result >= 0 */
      function sum(packet: Packet): Int {
        if (packet.kind === "pair") return packet.values[0] + packet.values[1]
        return packet.values[0]
      }
      /* uneffect:ensures result >= 0 */
      function destructured(packet: Packet): Int {
        if (packet.kind === "pair") {
          const [left, right] = packet.values
          return left + right
        }
        const [zero] = packet.values
        return zero
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("packet.values[0]: nat")))).toBe(true);
  });

  it("rejects mutable, dynamic, or ordinary-array tuple-like payload reads", async () => {
    const cases = [
      `
        type Int = number
        type Packet = { readonly kind: "a"; readonly values: [0] } | { readonly kind: "b"; readonly values: [1] }
        /* uneffect:ensures result >= 0 */
        function mutableTuple(packet: Packet): Int {
          if (packet.kind === "a") return packet.values[0]
          return packet.values[0]
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "a"; readonly values: readonly [0] } | { readonly kind: "b"; readonly values: readonly [1] }
        /* uneffect:ensures result >= 0 */
        function defaulted(packet: Packet): Int {
          if (packet.kind === "a") { const [value = -1] = packet.values; return value }
          return 0
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "a"; readonly values: readonly [0] } | { readonly kind: "b"; readonly values: readonly [1] }
        /* uneffect:ensures result >= 0 */
        function dynamic(packet: Packet, index: Int): Int {
          if (packet.kind === "a") return packet.values[index]
          return 0
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "a"; readonly values: readonly number[] } | { readonly kind: "b"; readonly values: readonly number[] }
        /* uneffect:ensures result >= 0 */
        function array(packet: Packet): Int {
          if (packet.kind === "a") return packet.values[0]
          return 0
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/discriminated-tuple-payload-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("preserves discriminant and payload facts through immutable object aliases", async () => {
    const fileName = "/discriminated-alias.ts";
    const source = `
      type Int = number
      type Nat = number
      type Packet =
        | { readonly kind: "value"; readonly value: Nat }
        | { readonly kind: "empty"; readonly value: 0 }
      /* uneffect:ensures result >= 0 */
      function decode(packet: Packet): Int {
        const current = packet
        const selected = current
        if (selected.kind === "value") return selected.value
        return selected.value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("selected.value: nat")))).toBe(true);
  });

  it("does not treat mutable or destructured object bindings as discriminant aliases", async () => {
    const cases = [
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function mutable(packet: Packet): Int {
          let current = packet
          if (current.kind === "zero") return current.value
          return current.value
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function destructured(packet: Packet): Int {
          const { kind, value } = packet
          if (kind === "zero") return value
          return value
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/discriminated-alias-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("preserves discriminant facts through a readonly direct property root", async () => {
    const fileName = "/discriminated-property-root.ts";
    const source = `
      type Int = number
      type Nat = number
      type Packet =
        | { readonly kind: "value"; readonly value: Nat }
        | { readonly kind: "empty"; readonly value: 0 }
      type Envelope = { readonly packet: Packet }
      /* uneffect:ensures result >= 0 */
      function decode(envelope: Envelope): Int {
        const packet = envelope.packet
        const selected = packet
        if (selected.kind === "value") return selected.value
        return selected.value
      }
    `;
    const program = programFor(fileName, source);
    const result = await verifyContractObligations(fileName, source, undefined, program);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts[0]?.controlFlow?.narrowing?.facts).toContain(
      'envelope.packet.kind ∈ {"empty", "value"}',
    );
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("selected.value: nat")))).toBe(true);
  });

  it("preserves discriminant facts through a readonly nested property root", async () => {
    const fileName = "/discriminated-nested-property-root.ts";
    const source = `
      type Int = number
      type Packet =
        | { readonly kind: "zero"; readonly value: 0 }
        | { readonly kind: "one"; readonly value: 1 }
      type Envelope = { readonly inner: { readonly packet: Packet } }
      /* uneffect:ensures result >= 0 */
      function decode(envelope: Envelope): Int {
        const packet = envelope.inner.packet
        if (packet.kind === "zero") return packet.value
        return packet.value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts[0]?.controlFlow?.narrowing?.facts).toContain(
      'envelope.inner.packet.kind ∈ {"one", "zero"}',
    );
  });

  it("rejects mutable, computed, or ambiguous discriminated property roots", async () => {
    const cases = [
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        type Envelope = { packet: Packet }
        /* uneffect:ensures result >= 0 */
        function mutable(envelope: Envelope): Int {
          const packet = envelope.packet
          if (packet.kind === "zero") return packet.value
          return packet.value
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        type Envelope = { readonly packet: Packet }
        /* uneffect:ensures result >= 0 */
        function computed(envelope: Envelope): Int {
          const packet = envelope["packet"]
          if (packet.kind === "zero") return packet.value
          return packet.value
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        type Envelope = { inner: { readonly packet: Packet } }
        /* uneffect:ensures result >= 0 */
        function mutableIntermediate(envelope: Envelope): Int {
          const packet = envelope.inner.packet
          if (packet.kind === "zero") return packet.value
          return packet.value
        }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "zero"; readonly value: 0 } | { readonly kind: "one"; readonly value: 1 }
        type Envelope = { readonly primary: Packet; readonly fallback: Packet }
        /* uneffect:ensures result >= 0 */
        function ambiguous(envelope: Envelope): Int {
          const packet = envelope.primary
          if (packet.kind === "zero") return packet.value
          return packet.value
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/discriminated-property-root-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
      expect(result.artifacts[0]?.controlFlow?.narrowing?.facts ?? []).not.toContainEqual(expect.stringContaining(".packet.kind ∈"));
    }
  });

  it("uses TypeChecker-resolved node:assert guards and routes AssertionError through catch", async () => {
    const fileName = `${process.cwd()}/node-assert.ts`;
    const source = `
      import { ok } from "node:assert/strict"
      import * as strictAssert from "node:assert/strict"
      import assertDefault from "node:assert/strict"
      type Int = number
      /* uneffect:ensures result >= 0 */
      function magnitude(value: Int | string): Int {
        ok(typeof value === "number")
        if (value < 0) return -value
        return value
      }
      /* uneffect:ensures result >= 0 */
      function recover(value: Int): Int {
        try {
          ok(value >= 0)
          return value
        } catch {
          return 0
        }
      }
      /* uneffect:ensures result >= 0 */
      function namespaceCheck(value: Int): Int {
        strictAssert.ok(value >= 0)
        return value
      }
      /* uneffect:ensures result >= 0 */
      function defaultCheck(value: Int): Int {
        assertDefault(value >= 0)
        return value
      }
    `;
    const program = programForFiles({ [fileName]: source });
    const result = await verifyContractObligations(fileName, source, undefined, program);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .includes("value: number | string via typeof number guard"))).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.exceptionFlow?.discharged
      .some((edge) => edge.kind === "synchronous-throw" && edge.effect === "Throw<AssertionError>"))).toBe(true);
    expect(collectAssumptionLedger(program, { [fileName]: source }, undefined).ledger.entries
      .filter(({ domain }) => domain === "builtin")).toHaveLength(4);
  });

  it("uses TypeChecker-resolved node:assert strictEqual as an equality guard", async () => {
    const fileName = `${process.cwd()}/node-assert-strict-equal.ts`;
    const source = `
      import { strictEqual } from "node:assert/strict"
      import * as assert from "node:assert/strict"
      type Int = number
      /* uneffect:ensures result === 3 */
      function named(value: Int): Int {
        strictEqual(value, 3)
        return value
      }
      /* uneffect:ensures result === 4 */
      function namespace(value: Int): Int {
        assert.strictEqual(value, 4)
        return value
      }
    `;
    const program = programForFiles({ [fileName]: source });
    const result = await verifyContractObligations(fileName, source, undefined, program);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(collectAssumptionLedger(program, { [fileName]: source }, undefined).ledger.entries
      .filter(({ domain }) => domain === "builtin")).toHaveLength(2);
  });

  it("uses TypeChecker-resolved node:assert notStrictEqual as an inequality guard", async () => {
    const fileName = `${process.cwd()}/node-assert-not-strict-equal.ts`;
    const source = `
      import { notStrictEqual } from "node:assert/strict"
      import * as assert from "node:assert"
      type Int = number
      /* uneffect:ensures result !== 0 */
      function named(value: Int): Int {
        notStrictEqual(value, 0)
        return value
      }
      /* uneffect:ensures result !== 1 */
      function namespace(value: Int): Int {
        assert.notStrictEqual(value, 1)
        return value
      }
    `;
    const program = programForFiles({ [fileName]: source });
    const result = await verifyContractObligations(fileName, source, undefined, program);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(collectAssumptionLedger(program, { [fileName]: source }, undefined).ledger.entries
      .filter(({ domain }) => domain === "builtin")).toHaveLength(2);
  });

  it("does not trust a same-shaped user strictEqual assertion", async () => {
    const cases = [
      `
        type Int = number
        function strictEqual<T>(actual: unknown, _expected: T): asserts actual is T {}
        /* uneffect:ensures result === 3 */
        function unsafe(value: Int): Int { strictEqual(value, 3); return value }
      `,
      `
        type Int = number
        function notStrictEqual(_actual: unknown, _expected: unknown): void {}
        /* uneffect:ensures result !== 0 */
        function unsafe(value: Int): Int { notStrictEqual(value, 0); return value }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/assert-strict-equality-lookalike-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("keeps nullable and mismatched strictEqual operands outside scalar proof", async () => {
    const cases = [
      `
        import { strictEqual } from "node:assert/strict"
        type Int = number
        /* uneffect:ensures result === 0 */
        function nullable(value: Int | null): Int {
          strictEqual(value, 0)
          return value
        }
      `,
      `
        import { notStrictEqual } from "node:assert/strict"
        type Int = number
        /* uneffect:ensures result !== 0 */
        function nullableNot(value: Int | null): Int {
          notStrictEqual(value, 0)
          return value ?? 1
        }
      `,
      `
        import { strictEqual } from "node:assert/strict"
        type Int = number
        /* uneffect:ensures result === 0 */
        function mismatched(value: Int): Int {
          strictEqual(value, true)
          return value
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `${process.cwd()}/node-assert-strict-equal-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programForFiles({ [fileName]: source }));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("routes TypeChecker-resolved node:assert fail directly into catch", async () => {
    const fileName = `${process.cwd()}/node-assert-fail.ts`;
    const source = `
      import { fail } from "node:assert/strict"
      import * as assert from "node:assert"
      type Int = number
      /* uneffect:ensures result === 0 */
      function named(): Int {
        try {
          fail("stop")
          return -1
        } catch {
          return 0
        }
      }
      /* uneffect:ensures result === 1 */
      function namespace(): Int {
        try {
          assert.fail()
          return -1
        } catch {
          return 1
        }
      }
    `;
    const program = programForFiles({ [fileName]: source });
    const result = await verifyContractObligations(fileName, source, undefined, program);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.every((artifact) => artifact.controlFlow?.exceptionFlow?.discharged
      .some((edge) => edge.effect === "Throw<AssertionError>"))).toBe(true);
  });

  it("does not treat a user function named fail as node:assert", async () => {
    const fileName = "/assert-fail-lookalike.ts";
    const source = `
      type Int = number
      function fail(): never { throw new Error("stop") }
      /* uneffect:ensures result === 0 */
      function unsafe(): Int {
        try { fail(); return -1 } catch { return 0 }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts[0]).toMatchObject({ status: "verified", evidence: "verified" });
    expect(result.artifacts[0]?.controlFlow?.exceptionFlow?.discharged).toContainEqual(expect.objectContaining({
      effect: "Throw<Error>",
      evidence: "verified",
    }));
    expect(result.artifacts[0]?.controlFlow?.exceptionFlow?.discharged)
      .not.toContainEqual(expect.objectContaining({ effect: "Throw<AssertionError>" }));
  });

  it("uses TypeChecker-resolved node:assert ifError as a nullish guard", async () => {
    const fileName = `${process.cwd()}/node-assert-if-error.ts`;
    const source = `
      import { ifError } from "node:assert/strict"
      import * as assert from "node:assert"
      /* uneffect:ensures result === true */
      function named(value: boolean | null | undefined): boolean {
        ifError(value)
        return value == null
      }
      /* uneffect:ensures result === true */
      function namespace(value: boolean | null): boolean {
        try {
          assert.ifError(value)
          return value === null
        } catch {
          return true
        }
      }
      /* uneffect:ensures result === true */
      function alias(value: boolean | undefined): boolean {
        const error = value
        ifError(error)
        return value === undefined
      }
    `;
    const program = programForFiles({ [fileName]: source });
    const result = await verifyContractObligations(fileName, source, undefined, program);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.exceptionFlow?.discharged
      .some((edge) => edge.effect === "Throw<AssertionError>"))).toBe(true);
  });

  it("tracks presence-only object unions through ifError and immutable aliases", async () => {
    const fileName = `${process.cwd()}/node-assert-if-error-object.ts`;
    const source = `
      import { ifError } from "node:assert/strict"
      /* uneffect:ensures result === true */
      function errorOrNull(value: Error | null): boolean {
        ifError(value)
        return value === null
      }
      /* uneffect:ensures result === true */
      function errorOrNullish(value: Error | null | undefined): boolean {
        const error = value
        ifError(error)
        return value == null
      }
    `;
    const program = programForFiles({ [fileName]: source });
    const result = await verifyContractObligations(fileName, source, undefined, program);

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.every((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("presence-only object")))).toBe(true);
  });

  it("updates presence-only object state on null, present, and compatible copy assignment", async () => {
    const fileName = "/presence-only-object-assignment.ts";
    const source = `
      /* uneffect:ensures result === true */
      function clear(value: Error | null): boolean {
        value = null
        return value === null
      }
      /* uneffect:ensures result === true */
      function set(value: Error | null, replacement: Error): boolean {
        value = replacement
        return value !== null
      }
      /* uneffect:ensures result === true */
      function copy(target: Error | null | undefined, source: Error | null): boolean {
        target = source
        return (target == null) === (source == null)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("does not mutate an immutable presence-only object alias with its source", async () => {
    const fileName = "/presence-only-object-alias-mutation.ts";
    const source = `
      /* uneffect:ensures result === true */
      function unsafe(value: Error | null): boolean {
        const old = value
        value = null
        return old === null
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("sets object presence from reviewed fresh allocations and conditional branches", async () => {
    const fileName = "/presence-only-object-fresh.ts";
    const source = `
      /* uneffect:ensures result === true */
      function error(value: Error | null): boolean {
        value = new Error("stop")
        return value !== null
      }
      /* uneffect:ensures result === true */
      function emptyObject(value: object | null): boolean {
        value = {}
        return value !== null
      }
      /* uneffect:ensures result === true */
      function emptyArray(value: object | null): boolean {
        value = []
        return value !== null
      }
      /* uneffect:ensures result === choose */
      function conditional(value: Error | null, choose: boolean): boolean {
        value = choose ? new TypeError() : null
        return value !== null
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("rejects shadowed or effectful object producers in presence assignment", async () => {
    const cases = [
      `
        class Error {}
        /* uneffect:ensures result === true */
        function shadowed(value: Error | null): boolean {
          value = new Error()
          return value !== null
        }
      `,
      `
        declare function message(): string
        /* uneffect:ensures result === true */
        function effectful(value: Error | null): boolean {
          value = new Error(message())
          return value !== null
        }
      `,
      `
        declare function getValue(): number
        /* uneffect:ensures result === true */
        function literal(value: object | null): boolean {
          value = { count: getValue() }
          return value !== null
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/presence-only-object-producer-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("updates presence-only object state through nullish assignment", async () => {
    const fileName = "/presence-only-object-nullish-assignment.ts";
    const source = `
      /* uneffect:ensures result === true */
      function fresh(value: Error | null): boolean {
        value ??= new Error("missing")
        return value !== null
      }
      /* uneffect:ensures result === true */
      function copy(value: Error | null | undefined, fallback: Error): boolean {
        value ??= fallback
        return value != null
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("keeps aliased or effectful presence-only nullish assignment fail-closed", async () => {
    const cases = [
      `
        /* uneffect:ensures result === true */
        function aliased(value: Error | null): boolean {
          const old = value
          value ??= new Error()
          return old === null
        }
      `,
      `
        declare function createError(): Error
        /* uneffect:ensures result === true */
        function effectful(value: Error | null): boolean {
          value ??= createError()
          return value !== null
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/presence-only-object-nullish-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("keeps untracked and user-defined ifError guards outside proof", async () => {
    const cases = [
      `
        function ifError(value: unknown): asserts value is null | undefined {}
        /* uneffect:ensures result === true */
        function lookalike(value: boolean | null): boolean {
          ifError(value)
          return value === null
        }
      `,
      `
        import { ifError } from "node:assert/strict"
        /* uneffect:ensures result === true */
        function mixedValue(value: Error | string | null): boolean {
          ifError(value)
          return value === null
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `${process.cwd()}/node-assert-if-error-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programForFiles({ [fileName]: source }));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("supports the TypeChecker-resolved CommonJS export-equals assertion binding", async () => {
    const fileName = `${process.cwd()}/node-assert-contract.cts`;
    const source = `
      import assert = require("node:assert/strict")
      type Int = number
      /* uneffect:ensures result >= 0 */
      function checked(value: Int): Int {
        assert(value >= 0)
        return value
      }
    `;
    const program = programForFiles(
      { [fileName]: source },
      { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
    );
    const result = await verifyContractObligations(fileName, source, undefined, program);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(collectAssumptionLedger(program, { [fileName]: source }, undefined).ledger.entries)
      .toContainEqual(expect.objectContaining({ domain: "builtin", reason: expect.stringContaining("strict assert callable") }));
  });

  it("supports reviewed node:assert ok and default-callable assertion bindings", async () => {
    const fileName = `${process.cwd()}/node-assert-nonstrict.ts`;
    const source = `
      import assert, { ok } from "node:assert"
      type Int = number
      /* uneffect:ensures result >= 0 */
      function named(value: Int): Int {
        ok(value >= 0)
        return value
      }
      /* uneffect:ensures result >= 0 */
      function callable(value: Int): Int {
        assert(value >= 0)
        return value
      }
    `;
    const program = programForFiles({ [fileName]: source });
    const result = await verifyContractObligations(fileName, source, undefined, program);
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(collectAssumptionLedger(program, { [fileName]: source }, undefined).ledger.entries
      .filter(({ domain }) => domain === "builtin")).toHaveLength(2);
  });

  it("does not trust a same-shaped user assertion function", async () => {
    const fileName = "/assert-lookalike.ts";
    const source = `
      type Int = number
      function ok(condition: unknown): asserts condition {}
      /* uneffect:ensures result >= 0 */
      function unsafe(value: Int): Int {
        ok(value >= 0)
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("records the reviewed Node assertion boundary in the project assumption ledger", async () => {
    const fileName = "src/node-assert-contract.ts";
    const source = `
      import { ok } from "node:assert/strict"
      type Int = number
      /* uneffect:effect Throw<AssertionError> */
      /* uneffect:ensures result >= 0 */
      export function checked(value: Int): Int {
        ok(value >= 0)
        return value
      }
    `;
    const result = await verifyUneffectProject({ files: { [fileName]: source } });
    expect(result.assumptions.entries).toContainEqual(expect.objectContaining({
      domain: "builtin",
      reason: expect.stringContaining("strict assert.ok"),
      scope: expect.objectContaining({ fileName }),
    }));
    expect(result.assurance.status).toBe("assumed");
  });

  it("routes synchronous throw through catch before checking the postcondition", async () => {
    const fileName = "/caught-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      function magnitude(value: Int): Int {
        try {
          if (value < 0) throw new RangeError("negative")
          return value
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        exceptionFlow: expect.objectContaining({
          schema: "uneffect-contract-exception-flow/v1",
          discharged: [expect.objectContaining({ effect: "Throw<RangeError>", handlerSpan: expect.any(Object) })],
          escapes: [],
        }),
      }),
    }));
  });

  it("lowers numeric switch entry, fallthrough, default, and unlabeled break", async () => {
    const fileName = "/contract-switch.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 && result <= 3 */
      function classify(value: Int): Int {
        let result = 0
        switch (value) {
          case -1: result = 1; break
          case 0:
          case 1: result = 2; break
          default: result = 3
        }
        return result
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toHaveLength(4);
  });

  it("composes switch throws with catch and contract discharge", async () => {
    const fileName = "/contract-switch-catch.ts";
    const source = `
      type Int = number
      /* uneffect:requires value >= -1 */
      /* uneffect:ensures result >= 0 */
      function decode(value: Int): Int {
        try {
          switch (value) {
            case -1: throw new RangeError("negative")
            case 0: return 0
            default: return value
          }
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.exceptionFlow?.discharged
      .some((edge) => edge.effect === "Throw<RangeError>"))).toBe(true);
  });

  it("connects string switch cases to TypeChecker discriminant guards and payloads", async () => {
    const fileName = "/contract-discriminant-switch.ts";
    const source = `
      type Int = number
      type Nat = number
      type Packet =
        | { readonly kind: "value"; readonly value: Nat }
        | { readonly kind: "empty"; readonly value: 0 }
      /* uneffect:ensures result >= 0 */
      function decode(packet: Packet): Int {
        switch (packet.kind) {
          case "value": return packet.value
          case "empty": return packet.value
        }
        return -1
      }
      /* uneffect:ensures result >= 0 */
      function aliased(packet: Packet): Int {
        const current = packet
        switch (current.kind) {
          case "value": return current.value
          default: return current.value
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts[0]?.controlFlow?.narrowing?.facts).toContain(
      'packet.kind ∈ {"empty", "value"}',
    );
  });

  it("rejects open/mutable discriminants and unknown string switch cases", async () => {
    const cases = [
      `
        type Int = number
        type Packet = { readonly kind: string; readonly value: Int }
        /* uneffect:ensures result >= 0 */
        function open(packet: Packet): Int { switch (packet.kind) { case "ok": return 0; default: return 1 } }
      `,
      `
        type Int = number
        type Packet = { kind: "a"; readonly value: 0 } | { kind: "b"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function mutable(packet: Packet): Int { switch (packet.kind) { case "a": return 0; default: return 1 } }
      `,
      `
        type Int = number
        type Packet = { readonly kind: "a"; readonly value: 0 } | { readonly kind: "b"; readonly value: 1 }
        /* uneffect:ensures result >= 0 */
        function unknownCase(packet: Packet): Int { switch (packet.kind) { case "missing": return 0; default: return 1 } }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/contract-discriminant-switch-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("rejects dynamic/duplicate switch cases and labeled break", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function dynamic(value: Int, other: Int): Int {
          switch (value) { case other: return 0; default: return 1 }
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function duplicate(value: Int): Int {
          switch (value) { case 0: return 0; case 0: return 1; default: return 2 }
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function labeled(value: Int): Int {
          outer: switch (value) { case 0: break outer; default: return 0 }
          return 0
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function mixed(value: Int): Int {
          switch (value) { case 0: return 0; case true: return 1; default: return 2 }
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/contract-switch-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("routes while-owned break and continue through invariant paths", async () => {
    const fileName = "/contract-while-control.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function sum(limit: Int): Int {
        let index = 0
        let total = 0
        /* uneffect:loop_invariant index >= 0 && total >= 0 */
        while (index < limit) {
          index = index + 1
          if (index === 2) continue
          if (index === 4) break
          total = total + index
        }
        return total
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.length).toBeGreaterThanOrEqual(4);
  });

  it("preserves loop-invariant scalar bindings without repeating them in each invariant", async () => {
    const fileName = "/contract-loop-frame.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function whileFrame(limit: Int): Int {
        let index = 0
        /* uneffect:loop_invariant index >= 0 */
        while (index < limit) index++
        return limit
      }
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function forFrame(limit: Int): Int {
        /* uneffect:loop_invariant index >= 0 */
        for (let index = 0; index < limit; index++) {}
        return limit
      }
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function doFrame(limit: Int): Int {
        let index = 0
        /* uneffect:loop_invariant index >= 0 */
        do { index++ } while (index < limit)
        return limit
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    for (const functionName of ["whileFrame", "forFrame", "doFrame"]) {
      const evidence = JSON.stringify(result.artifacts.filter(({ obligation }) => obligation?.functionName === functionName));
      expect(evidence).not.toContain(`${functionName}_limit_loop_`);
      expect(evidence).toContain(`${functionName}_index_loop_`);
    }
  });

  it("keeps switch break local while continue targets the enclosing while through finally", async () => {
    const fileName = "/contract-loop-switch-finally.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function run(limit: Int): Int {
        let index = 0
        let total = 0
        /* uneffect:loop_invariant index >= 0 && total >= 0 */
        while (index < limit) {
          try {
            switch (index) {
              case 0: break
              default: total = total + index
            }
            index = index + 1
            continue
          } finally {
            total = total + 1
          }
        }
        return total
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("rejects labeled or ownerless loop control", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function labeled(limit: Int): Int {
          let index = 0
          outer: while (index < limit) { continue outer }
          return 0
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function ownerless(value: Int): Int { if (value < 0) break; return 0 }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/contract-loop-control-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("lowers canonical for updates with loop-owned break and continue", async () => {
    const fileName = "/contract-for-control.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function sum(limit: Int): Int {
        let total = 0
        /* uneffect:loop_invariant index >= 0 && total >= 0 */
        for (let index = 0; index < limit; index++) {
          if (index === 1) continue
          if (index === 4) break
          total = total + index
        }
        return total
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("restores an outer scalar shadowed by a for initializer", async () => {
    const fileName = "/contract-for-shadow.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result === 5 */
      function run(limit: Int): Int {
        let index = 5
        /* uneffect:loop_invariant index >= 0 */
        for (let index = 0; index < limit; index++) {}
        return index
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("lowers outer assignment and function-scoped var for initializers", async () => {
    const fileName = "/contract-for-initializer-forms.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function assigned(limit: Int): Int {
        let index = 5
        /* uneffect:loop_invariant index >= 0 */
        for (index = 0; index < limit; index++) {}
        return index
      }
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function functionScoped(limit: Int): Int {
        /* uneffect:loop_invariant index >= 0 */
        for (var index = 0; index < limit; index++) {}
        return index
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("lowers a for loop with an omitted initializer over an existing scalar", async () => {
    const fileName = "/contract-for-omitted-initializer.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function run(limit: Int): Int {
        let index = 0
        /* uneffect:loop_invariant index >= 0 */
        for (; index < limit; index++) {}
        return index
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("lowers an invariant-backed conditionless for loop through explicit break", async () => {
    const fileName = "/contract-conditionless-for.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function run(limit: Int): Int {
        let index = 0
        /* uneffect:loop_invariant index >= 0 */
        for (;;) {
          if (index >= limit) break
          index++
        }
        return index
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("executes comma-separated scalar for updates from left to right", async () => {
    const fileName = "/contract-for-comma-updates.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function run(limit: Int): Int {
        let left = 5
        let right = 5
        /* uneffect:loop_invariant left >= 0 && right >= 0 */
        for (left = 0, right = 0; left < limit; left++, right++) {}
        return left + right
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("initializes multiple scalar for bindings from left to right and restores lexical shadows", async () => {
    const fileName = "/contract-for-multiple-initializers.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result === 12 */
      function lexical(limit: Int): Int {
        let left = 5
        let right = 7
        /* uneffect:loop_invariant left >= 0 && right >= left */
        for (let left = 0, right = left + 1; left < limit; left++, right++) {}
        return left + right
      }
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 1 */
      function functionScoped(limit: Int): Int {
        /* uneffect:loop_invariant left >= 0 && right >= left + 1 */
        for (var left = 0, right = left + 1; left < limit; left++, right++) {}
        return right
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("lowers do-while exits only after one invariant-preserving body", async () => {
    const fileName = "/contract-do-while.ts";
    const source = `
      type Int = number
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 1 */
      function advance(limit: Int): Int {
        let value = 0
        /* uneffect:loop_invariant value >= 0 */
        do {
          value = value + 1
          if (value === 2) break
        } while (value < limit)
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("rejects unsupported for headers and missing do-while invariants", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function destructured(limit: Int): Int {
          /* uneffect:loop_invariant left >= 0 */
          for (let [left] = [0]; left < limit; left++) {}
          return 0
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function uninitialized(limit: Int): Int {
          /* uneffect:loop_invariant left >= 0 */
          for (let left; left < limit; left++) {}
          return 0
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function noInvariant(limit: Int): Int {
          let value = 0
          do { value = value + 1 } while (value < limit)
          return value
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/contract-loop-header-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("symbolically executes identifier increment and arithmetic compound assignments", async () => {
    const fileName = "/contract-scalar-updates.ts";
    const source = `
      type Int = number
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= 0 */
      function update(value: Int): Int {
        let total = value
        total++
        total += 2
        total -= 1
        total *= 2
        return total
      }
      /* uneffect:requires limit >= 0 */
      /* uneffect:ensures result >= 0 */
      function loop(limit: Int): Int {
        /* uneffect:loop_invariant index >= 0 */
        for (let index = 0; index < limit; index += 1) {}
        return 0
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("uses JavaScript signed integer remainder semantics in a for update", async () => {
    const fileName = "/contract-for-remainder-update.ts";
    const source = `
      type Int = number
      /* uneffect:requires seed >= 0 */
      /* uneffect:ensures result >= 0 && result < 8 */
      function reduce(seed: Int): Int {
        /* uneffect:loop_invariant value >= 0 */
        for (var value = seed; value >= 8; value %= 8) {}
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("evaluates branch-aware scalar expressions on arithmetic compound-assignment RHS", async () => {
    const fileName = "/contract-branching-compound-updates.ts";
    const source = `
      type Int = number
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result > value */
      function conditional(value: Int, choose: boolean): Int {
        let total = value
        total += choose ? 1 : 2
        return total
      }
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= value */
      function reviewedMath(value: Int, delta: Int): Int {
        let total = value
        total += Math.abs(delta)
        return total
      }
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= value - 2 && result <= value + 2 */
      function signedRemainder(value: Int, delta: Int): Int {
        let total = value
        total += delta % 3
        return total
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(6);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("rejects property, logical, and sequence mutation in scalar contracts", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function property(value: { count: Int }): Int { value.count++; return value.count }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function logical(value: Int): Int { value ||= 1; return value }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function sequence(value: Int): Int { (value += 1, value += 2); return value }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function division(value: Int): Int { value /= 2; return value }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function dynamicRemainder(value: Int, divisor: Int): Int { value %= divisor; return value }
      `,
      `
        type Int = number
        /* uneffect:ensures result === value */
        function zeroRemainder(value: Int): Int { value %= 0; return value }
      `,
      `
        type Float = number
        /* uneffect:ensures result >= 0 */
        function realRemainder(value: Float): Float { value %= 3; return value }
      `,
      `
        /* uneffect:ensures result === result */
        function boolean(value: boolean): boolean { value += true; return value }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/contract-scalar-update-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("splits recursive scalar ternaries in returns, initializers, and assignments", async () => {
    const fileName = "/contract-conditional-expression.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      function returned(value: Int): Int {
        return value > 0 ? value : value === 0 ? 0 : -value
      }
      /* uneffect:ensures result >= 0 */
      function initialized(value: Int): Int {
        const magnitude = value >= 0 ? value : -value
        return magnitude
      }
      /* uneffect:ensures result >= 0 */
      function assigned(value: Int): Int {
        let magnitude = 0
        magnitude = value >= 0 ? value : -value
        return magnitude
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toHaveLength(7);
  });

  it("rejects non-scalar or call-conditioned ternaries", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function object(value: Int): Int { const selected = value >= 0 ? { value } : { value: 0 }; return selected.value }
      `,
      `
        type Int = number
        declare function choose(): boolean
        /* uneffect:ensures result >= 0 */
        function called(value: Int): Int { return choose() ? value : -value }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/contract-conditional-expression-negative-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("retains an uncaught synchronous throw as an escaping Effect boundary", async () => {
    const fileName = "/uncaught-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      function magnitude(value: Int): Int {
        if (value < 0) throw new RangeError("negative")
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.controlFlow?.exceptionFlow).toMatchObject({
      schema: "uneffect-contract-exception-flow/v1",
      discharged: [],
      escapes: [expect.objectContaining({ effect: "Throw<RangeError>", originSpan: expect.any(Object) })],
    });
    const [joined] = attachContractEffectBoundaries(result.artifacts, [{
      functionName: "magnitude", fileName, span: { start: 0, end: source.length }, effects: [], evidence: "verified",
    }]);
    expect(joined?.controlFlow?.effectBoundary).toMatchObject({
      evidence: "unknown",
      escaping: ["Throw<RangeError>"],
      blockers: ["escaping Throw<RangeError> is absent from the inferred Effect summary"],
    });
    expect(joined).toMatchObject({ status: "unknown", evidence: "unknown", message: expect.stringContaining("escaping Throw<RangeError>") });
  });

  it("routes a TypeChecker-resolved never + Throw declaration through catch", async () => {
    const fileName = "/declared-throw-contract.ts";
    const source = `
      type Int = number
      /* uneffect:effect Throw<RangeError> */
      function fail(): never { throw new RangeError("negative") }
      /* uneffect:ensures result >= 0 */
      function magnitude(value: Int): Int {
        if (value < 0) {
          try { fail() } catch { return 0 }
        }
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ effect: "Throw<RangeError>" })],
      }) }),
    }));
  });

  it("does not treat Promise rejection as a synchronous Throw edge", async () => {
    const fileName = "/rejection-is-not-throw.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      async function invalid(value: Int): Promise<Int> {
        try { await Promise.reject(new RangeError("negative")) }
        catch { return 0 }
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" })],
      }) }),
    }));
  });

  it("runs finally on return and lets an abrupt finalizer override it", async () => {
    const fileName = "/finally-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value */
      /* uneffect:effect Throw<RangeError> */
      function guardedIdentity(value: Int): Int {
        try { return value }
        finally { if (value < 0) throw new RangeError("negative") }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ status: "verified" });
    expect(result.artifacts[0]?.controlFlow?.pathConditions).toContainEqual(expect.objectContaining({ kind: "unary", operator: "not" }));
    expect(result.artifacts[0]?.controlFlow?.exceptionFlow?.escapes).toContainEqual(expect.objectContaining({ effect: "Throw<RangeError>" }));
  });

  it("binds a scalar thrown payload in catch", async () => {
    const fileName = "/catch-binding-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      function magnitude(value: Int): Int {
        try {
          if (value < 0) throw -value
          return value
        } catch (error) {
          return error as number
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ effect: "Throw<unknown>", payload: expect.objectContaining({ kind: "unary", operator: "negate" }) })],
      }) }),
    }));
  });

  it("routes an awaited builtin Promise rejection through catch without creating Throw<E>", async () => {
    const fileName = "/await-rejection-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      async function normalize(value: Int): Promise<Int> {
        try {
          if (value < 0) await Promise.reject(new RangeError("negative"))
          return value
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" })],
      }) }),
    }));
  });

  it("binds a scalar builtin Promise rejection reason in catch", async () => {
    const fileName = "/await-rejection-binding-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      async function magnitude(value: Int): Promise<Int> {
        try {
          if (value < 0) await Promise.reject(-value)
          return value
        } catch (reason) {
          return reason as number
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "promise-rejection", effect: "Reject<number>", payload: expect.objectContaining({ kind: "unary", operator: "negate" }) })],
      }) }),
    }));
  });

  it("keeps an uncaught Promise rejection out of the synchronous Effect boundary", async () => {
    const fileName = "/uncaught-rejection-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      async function normalize(value: Int): Promise<Int> {
        if (value < 0) await Promise.reject(new RangeError("negative"))
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    const [joined] = attachContractEffectBoundaries(result.artifacts, [{
      functionName: "normalize", fileName, span: { start: 0, end: source.length }, effects: [], evidence: "verified",
    }]);

    expect(joined).toMatchObject({ status: "verified", evidence: "verified" });
    expect(joined?.controlFlow?.exceptionFlow?.escapes).toContainEqual(expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" }));
    expect(joined?.controlFlow?.effectBoundary).toMatchObject({ escaping: ["Reject<RangeError>"], blockers: [] });
  });

  it("converts uncaught async-body throws to returned Promise rejection at the function boundary", async () => {
    const fileName = "/async-throw-boundary-contract.ts";
    const source = `
      type Int = number
      /* uneffect:effect Throw<URIError> */
      declare function fail(): never
      /* uneffect:ensures result >= 0 */
      async function direct(value: Int): Promise<Int> {
        if (value < 0) throw new RangeError("negative")
        if (value === 0) fail()
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    const escapes = result.artifacts[0]?.controlFlow?.exceptionFlow?.escapes ?? [];

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(escapes).toContainEqual(expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" }));
    expect(escapes).toContainEqual(expect.objectContaining({ kind: "promise-rejection", effect: "Reject<URIError>" }));
    expect(escapes).not.toContainEqual(expect.objectContaining({ kind: "synchronous-throw" }));
  });

  it("retains synchronous throw classification when an async-body catch handles it locally", async () => {
    const fileName = "/async-local-catch-contract.ts";
    const source = `
      type Int = number
      /* uneffect:effect Throw<RangeError> */
      declare function fail(): never
      /* uneffect:ensures result === value */
      async function caught(value: Int): Promise<Int> {
        try {
          if (value < 0) fail()
        } catch {
          return value
        }
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "synchronous-throw", effect: "Throw<RangeError>" })],
      }) }),
    }));
  });

  it("rejects a same-spelled local Promise.reject instead of granting builtin semantics", async () => {
    const fileName = "/spoofed-promise-rejection-contract.ts";
    const source = `
      export {}
      const Promise = { reject(input: unknown) { return globalThis.Promise.reject(input) } }
      /* uneffect:ensures result === value */
      async function normalize(value: number): Promise<number> {
        try { await Promise.reject(new RangeError("negative")) }
        catch { return value }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown", message: expect.stringContaining("rejection or fulfillment summary") });
  });

  it("infers scalar fulfillment for the standard Promise.resolve", async () => {
    const fileName = "/promise-resolve-fulfillment-contract.ts";
    const source = `
      type Int = number
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      async function increment(value: Int): Promise<Int> {
        const loaded = await Promise.resolve(value + 1)
        return loaded
      }
      /* uneffect:ensures result === true */
      async function fill(value: boolean | null): Promise<boolean> {
        value = await Promise.resolve(true)
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        relationalCalls: [expect.objectContaining({ evidence: "verified", functionName: "Promise.resolve", clauses: ["result === value"] })],
      }),
    }));
  });

  it("tracks standard Promise producers through callable aliases", async () => {
    const fileName = "/promise-producer-callable-alias.ts";
    const source = `
      type Int = number
      const settle = Promise.resolve
      const reject = Promise.reject
      /* uneffect:ensures result === value */
      async function aliased(value: Int): Promise<Int> {
        try {
          const loaded = await settle(value)
          if (value < 0) await reject(new RangeError("negative"))
          return loaded
        } catch {
          return value
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        relationalCalls: [expect.objectContaining({ evidence: "verified", functionName: "Promise.resolve" })],
      }),
    }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" })],
      }) }),
    }));
  });

  it("infers fulfillment from a local async pure scalar producer", async () => {
    const fileName = "/local-async-scalar-producer.ts";
    const source = `
      type Int = number
      async function increment(value: Int): Promise<Int> {
        return value + 1
      }
      const load = increment
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      async function caller(value: Int): Promise<Int> {
        return await load(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        relationalCalls: [expect.objectContaining({
          evidence: "verified",
          functionName: "increment",
          clauses: ["result === value + 1"],
        })],
      }),
    }));
  });

  it("infers fulfillment from const async arrow and function-expression producers", async () => {
    const fileName = "/local-async-expression-producers.ts";
    const source = `
      type Int = number
      const SCALE: Int = 2
      const increment = async (value: Int): Promise<Int> => value + 1
      const double = async function(value: Int): Promise<Int> {
        return value * SCALE
      }
      const load = increment
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value * 2 + 1 */
      async function caller(value: Int): Promise<Int> {
        const first = await double(value)
        return await load(first)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        relationalCalls: [
          expect.objectContaining({ evidence: "verified", functionName: "double", clauses: ["result === value * SCALE"] }),
          expect.objectContaining({ evidence: "verified", functionName: "increment", clauses: ["result === value + 1"] }),
        ],
      }),
    }));
  });

  it("keeps mutable or captured async arrow producers fail-closed", async () => {
    const cases = [
      `
        type Int = number
        let increment = async (value: Int): Promise<Int> => value + 1
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await increment(value) }
      `,
      `
        type Int = number
        let offset: Int = 1
        const increment = async (value: Int): Promise<Int> => value + offset
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await increment(value) }
      `,
      `
        type Int = number
        const offset: Int = Number("1")
        const increment = async (value: Int): Promise<Int> => value + offset
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await increment(value) }
      `,
      `
        type Int = number
        const config = { offset: 1 }
        const increment = async (value: Int): Promise<Int> => value + config.offset
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await increment(value) }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/local-async-expression-producer-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("infers path-conditioned fulfillment from local async return branches", async () => {
    const fileName = "/local-async-branch-producers.ts";
    const source = `
      type Int = number
      async function clamp(value: Int): Promise<Int> {
        if (value < 0) return 0
        return value
      }
      const absolute = async (value: Int): Promise<Int> => {
        if (value >= 0) {
          return value
        } else {
          return -value
        }
      }
      /* uneffect:ensures result >= 0 */
      async function clamped(value: Int): Promise<Int> {
        return await clamp(value)
      }
      /* uneffect:ensures result >= 0 */
      async function abs(value: Int): Promise<Int> {
        return await absolute(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ relationalCalls: [expect.objectContaining({
        evidence: "verified",
        functionName: "clamp",
        clauses: ["!(value < 0) || result === 0", "value < 0 || result === value"],
      })] }),
    }));
  });

  it("normalizes a local async scalar ternary into branch fulfillment", async () => {
    const fileName = "/local-async-ternary-producer.ts";
    const source = `
      type Int = number
      const absolute = async (value: Int): Promise<Int> => value >= 0 ? value : -value
      /* uneffect:ensures result >= 0 */
      async function caller(value: Int): Promise<Int> {
        return await absolute(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ relationalCalls: [expect.objectContaining({
        evidence: "verified",
        functionName: "absolute",
        clauses: ["!(value >= 0) || result === value", "value >= 0 || result === -value"],
      })] }),
    }));

    const truthy = source.replace("value >= 0 ? value : -value", "value ? value : -value");
    const invalid = await verifyContractObligations(fileName, truthy, undefined, programFor(fileName, truthy));
    expect(invalid.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("composes a pure const prelude into a local async fulfillment summary", async () => {
    const fileName = "/local-async-const-prelude.ts";
    const source = `
      type Int = number
      async function transform(value: Int): Promise<Int> {
        const incremented = value + 1
        const doubled = incremented * 2
        return doubled
      }
      /* uneffect:ensures result === (value + 1) * 2 */
      async function caller(value: Int): Promise<Int> {
        return await transform(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ relationalCalls: [expect.objectContaining({
        evidence: "verified",
        functionName: "transform",
        clauses: ["result === doubled"],
      })] }),
    }));
  });

  it("keeps mutable, destructured, or call-valued async preludes fail-closed", async () => {
    const cases = [
      `
        type Int = number
        async function transform(value: Int): Promise<Int> {
          let next = value + 1
          return next
        }
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await transform(value) }
      `,
      `
        type Int = number
        async function transform(value: Int): Promise<Int> {
          const [next] = [value + 1]
          return next
        }
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await transform(value) }
      `,
      `
        type Int = number
        declare function increment(value: Int): Int
        async function transform(value: Int): Promise<Int> {
          const next = increment(value)
          return next
        }
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await transform(value) }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/local-async-prelude-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("connects a guarded local async throw to Promise rejection and normal fulfillment", async () => {
    const fileName = "/local-async-guarded-rejection.ts";
    const source = `
      type Int = number
      async function nonNegative(value: Int): Promise<Int> {
        if (value < 0) throw new RangeError("negative")
        return value
      }
      const load = nonNegative
      /* uneffect:ensures result >= 0 */
      async function caller(value: Int): Promise<Int> {
        try {
          return await load(value)
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ relationalCalls: [expect.objectContaining({
        evidence: "verified",
        functionName: "nonNegative",
        clauses: ["!(value < 0)", "result === value"],
      })] }),
    }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({
          evidence: "verified",
          kind: "promise-rejection",
          effect: "Reject<RangeError>",
        })],
      }) }),
    }));
  });

  it("connects return-if-valid followed by throw to the same async product", async () => {
    const fileName = "/local-async-return-guarded-rejection.ts";
    const source = `
      type Int = number
      const checked = async (value: Int): Promise<Int> => {
        if (value >= 0) return value
        throw new RangeError("negative")
      }
      /* uneffect:ensures result >= 0 */
      async function caller(value: Int): Promise<Int> {
        try {
          return await checked(value)
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ relationalCalls: [expect.objectContaining({
        evidence: "verified",
        functionName: "checked",
        clauses: ["value >= 0", "result === value"],
      })] }),
    }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ effect: "Reject<RangeError>" })],
      }) }),
    }));
  });

  it("normalizes exhaustive async return/throw branches into the same product", async () => {
    const fileName = "/local-async-exhaustive-rejection.ts";
    const source = `
      type Int = number
      async function checked(value: Int): Promise<Int> {
        if (value < 0) {
          throw new RangeError("negative")
        } else {
          return value
        }
      }
      /* uneffect:ensures result >= 0 */
      async function caller(value: Int): Promise<Int> {
        try { return await checked(value) }
        catch { return 0 }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ relationalCalls: [expect.objectContaining({
        evidence: "verified",
        functionName: "checked",
        clauses: ["!(value < 0)", "result === value"],
      })] }),
    }));
  });

  it("infers a definitely rejecting local async producer", async () => {
    const fileName = "/local-async-definite-rejection.ts";
    const source = `
      async function fail(): Promise<never> {
        throw new RangeError("failed")
      }
      const reject = fail
      /* uneffect:ensures result === 0 */
      async function caller(): Promise<number> {
        try {
          const pending = reject()
          await pending
          return 1
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ status: "verified" });
    expect(result.artifacts[0]?.controlFlow?.exceptionFlow?.discharged).toContainEqual(expect.objectContaining({
      evidence: "verified",
      kind: "promise-rejection",
      effect: "Reject<RangeError>",
    }));
  });

  it("does not infer definite rejection from a call-produced Error", async () => {
    const fileName = "/local-async-definite-rejection-unsupported.ts";
    const source = `
      declare function makeError(): RangeError
      async function fail(): Promise<never> {
        throw makeError()
      }
      /* uneffect:ensures result === 0 */
      async function caller(): Promise<number> {
        try { await fail(); return 1 }
        catch { return 0 }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("keeps impure or structurally complex local async producers fail-closed", async () => {
    const cases = [
      `
        type Int = number
        let offset: Int = 1
        async function captured(value: Int): Promise<Int> { return value + offset }
        /* uneffect:ensures result >= value */
        async function caller(value: Int): Promise<Int> { return await captured(value) }
      `,
      `
        type Int = number
        async function defaulted(value: Int = 0): Promise<Int> { return value }
        /* uneffect:ensures result === value */
        async function caller(value: Int): Promise<Int> { return await defaulted(value) }
      `,
      `
        type Int = number
        async function assimilated(value: Int): Promise<Int> { return Promise.resolve(value) }
        /* uneffect:ensures result === value */
        async function caller(value: Int): Promise<Int> { return await assimilated(value) }
      `,
      `
        type Int = number
        declare function makeError(): RangeError
        async function guarded(value: Int): Promise<Int> {
          if (value < 0) throw makeError()
          return value
        }
        /* uneffect:ensures result >= 0 */
        async function caller(value: Int): Promise<Int> {
          try { return await guarded(value) } catch { return 0 }
        }
      `,
      `
        type Int = number
        async function producer(value: Int): Promise<Int> { return value }
        let load = producer
        /* uneffect:ensures result === value */
        async function caller(value: Int): Promise<Int> { return await load(value) }
      `,
      `
        type Int = number
        async function producer(value: Int): Promise<Int> { return value }
        producer = async (value: Int): Promise<Int> => value + 1
        /* uneffect:ensures result === value + 1 */
        async function caller(value: Int): Promise<Int> { return await producer(value) }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/local-async-scalar-producer-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("does not infer Promise.resolve fulfillment for shadowed or thenable inputs", async () => {
    const cases = [
      `
        export {}
        const Promise = { resolve(value: number) { return globalThis.Promise.resolve(value) } }
        /* uneffect:ensures result === value */
        async function shadowed(value: number): Promise<number> {
          return await Promise.resolve(value)
        }
      `,
      `
        /* uneffect:ensures result === 1 */
        async function assimilated(): Promise<number> {
          return await Promise.resolve({ then(resolve: (value: number) => void) { resolve(1) } })
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/promise-resolve-fulfillment-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("routes a TypeChecker-resolved temporal rejection summary through catch", async () => {
    const fileName = "/declared-rejection-contract.ts";
    const source = `
      type Int = number
      /* uneffect:temporal_contract rejects RangeError */
      /* uneffect:temporal_contract throws URIError */
      declare function readRemote(value: Int): Promise<Int>
      /* uneffect:ensures result === value || result === 0 */
      async function normalize(value: Int): Promise<Int> {
        try {
          if (value >= 0) await readRemote(value)
          return value
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(4);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" })],
      }) }),
    }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "synchronous-throw", effect: "Throw<URIError>" })],
      }) }),
    }));
  });

  it("rejects JavaScript truthiness in conditional Promise forwarding", async () => {
    const fileName = "/conditional-promise-forward-truthiness.ts";
    const source = `
      /* uneffect:ensures result === value */
      declare function remote(value: number): Promise<number>
      /* uneffect:ensures result === value */
      async function forward(flag: number, value: number): Promise<number> {
        return flag ? remote(value) : Promise.resolve(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0])
      .toMatchObject({ status: "unsupported", message: expect.stringContaining("Boolean condition") });
  });

  it("does not apply a temporal rejection summary to a non-Promise return", async () => {
    const fileName = "/invalid-declared-rejection-contract.ts";
    const source = `
      /* uneffect:temporal_contract rejects RangeError */
      declare function readImmediate(): number
      /* uneffect:ensures result === 0 */
      async function normalize(): Promise<number> {
        try { await readImmediate() } catch {}
        return 0
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown", message: expect.stringContaining("rejection or fulfillment summary") });
  });

  it("composes a trusted scalar fulfillment postcondition with rejection flow", async () => {
    const fileName = "/awaited-fulfillment-contract.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= value */
      /* uneffect:temporal_contract rejects RangeError */
      declare function readRemote(value: Int): Promise<Int>
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= 0 */
      async function normalize(value: Int): Promise<Int> {
        try {
          const loaded = await readRemote(value)
          return loaded
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        relationalCalls: [expect.objectContaining({ evidence: "trusted", functionName: "readRemote", clauses: ["result >= value"] })],
      }),
    }));

    const broken = source.replace("result >= value", "result <= value - 1");
    const invalid = await verifyContractObligations(fileName, broken, undefined, programFor(fileName, broken));
    expect(invalid.artifacts).toContainEqual(expect.objectContaining({ status: "counterexample" }));
  });

  it("composes scalar fulfillment and rejection through await assignment", async () => {
    const fileName = "/awaited-fulfillment-assignment.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= value */
      /* uneffect:temporal_contract rejects RangeError */
      declare function readRemote(value: Int): Promise<Int>
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= 0 */
      async function normalize(value: Int): Promise<Int> {
        try {
          value = await readRemote(value)
          return value
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.relationalCalls
      ?.some((call) => call.functionName === "readRemote"))).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.exceptionFlow?.discharged
      .some((edge) => edge.kind === "promise-rejection" && edge.effect === "Reject<RangeError>"))).toBe(true);
  });

  it("snapshots a Promise-producing call and settles it through an immutable binding alias", async () => {
    const fileName = "/awaited-promise-binding.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result === value */
      /* uneffect:temporal_contract rejects RangeError */
      declare function readRemote(value: Int): Promise<Int>
      /* uneffect:ensures result === true */
      async function caller(value: Int): Promise<boolean> {
        const original = value
        try {
          const pending = readRemote(value)
          const same = pending
          value = 0
          const loaded = await same
          return loaded === original
        } catch {
          return true
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ relationalCalls: [expect.objectContaining({
        functionName: "readRemote",
        clauses: ["result === value"],
      })] }),
    }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({
        discharged: [expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" })],
      }) }),
    }));
  });

  it("keeps an unobserved Promise binding fail-closed in contract CFG", async () => {
    const fileName = "/floating-contract-promise-binding.ts";
    const source = `
      /* uneffect:ensures result === value */
      declare function readRemote(value: number): Promise<number>
      /* uneffect:ensures result === value */
      async function caller(value: number): Promise<number> {
        const pending = readRemote(value)
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown", message: expect.stringContaining("unobserved Promise") });
  });

  it("separates stored Promise call-time throw from await-time rejection", async () => {
    const fileName = "/stored-promise-completion-timing.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= 0 */
      /* uneffect:temporal_contract rejects RangeError */
      /* uneffect:temporal_contract throws URIError */
      declare function readRemote(value: Int): Promise<Int>
      /* uneffect:ensures result >= 0 */
      async function caller(value: Int): Promise<Int> {
        try {
          const pending = readRemote(value)
          return await pending
        } catch {
          return 0
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    const callStart = source.indexOf("readRemote(value)", source.indexOf("async function caller"));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({ discharged: [expect.objectContaining({
        kind: "synchronous-throw",
        effect: "Throw<URIError>",
        originSpan: expect.objectContaining({ start: callStart }),
      })] }) }),
    }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({ exceptionFlow: expect.objectContaining({ discharged: [expect.objectContaining({
        kind: "promise-rejection",
        effect: "Reject<RangeError>",
        originSpan: expect.objectContaining({ start: callStart }),
      })] }) }),
    }));
  });

  it("proves a stored Promise callee precondition at call time", async () => {
    const fileName = "/stored-promise-call-precondition.ts";
    const source = `
      type Int = number
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= value */
      declare function readRemote(value: Int): Promise<Int>
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= 0 */
      async function caller(value: Int): Promise<Int> {
        const pending = readRemote(value)
        return await pending
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      status: "verified",
      obligation: expect.objectContaining({ clause: "requires", source: "value >= 0" }),
    }));

    const unsafe = source.replace("/* uneffect:requires value >= 0 */\n      /* uneffect:ensures result >= 0 */\n      async function caller", "/* uneffect:ensures result >= 0 */\n      async function caller");
    const invalid = await verifyContractObligations(fileName, unsafe, undefined, programFor(fileName, unsafe));
    expect(invalid.artifacts).toContainEqual(expect.objectContaining({
      status: "counterexample",
      obligation: expect.objectContaining({ clause: "requires" }),
    }));
  });

  it("allows repeated observation of the same settled Promise summary", async () => {
    const fileName = "/stored-promise-repeated-observation.ts";
    const source = `
      /* uneffect:ensures result === value */
      declare function readRemote(value: number): Promise<number>
      /* uneffect:ensures result === true */
      async function caller(value: number): Promise<boolean> {
        const pending = readRemote(value)
        const first = await pending
        const second = await pending
        return first === second
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
  });

  it("keeps an unobserved lexical Promise escape fail-closed", async () => {
    const fileName = "/stored-promise-lexical-escape.ts";
    const source = `
      /* uneffect:ensures result === value */
      declare function readRemote(value: number): Promise<number>
      /* uneffect:ensures result === value */
      async function caller(value: number): Promise<number> {
        { const pending = readRemote(value) }
        return value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown", message: expect.stringContaining("unobserved Promise") });
  });

  it("composes scalar fulfillment into nullable state without mutating rejected paths", async () => {
    const fileName = "/awaited-nullable-fulfillment-assignment.ts";
    const source = `
      /* uneffect:ensures result === true */
      /* uneffect:temporal_contract rejects RangeError */
      declare function readRemote(): Promise<boolean>
      /* uneffect:ensures result === true */
      async function nullable(value: boolean | null): Promise<boolean> {
        try {
          value = await readRemote()
          return value
        } catch {
          return true
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        relationalCalls: [expect.objectContaining({ functionName: "readRemote", clauses: ["result === true"] })],
      }),
    }));
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      controlFlow: expect.objectContaining({
        exceptionFlow: expect.objectContaining({
          discharged: [expect.objectContaining({ kind: "promise-rejection", effect: "Reject<RangeError>" })],
        }),
      }),
    }));
  });

  it("keeps nullable await assignment with a shared immutable alias fail-closed", async () => {
    const fileName = "/awaited-nullable-fulfillment-alias.ts";
    const source = `
      /* uneffect:ensures result === true */
      declare function readRemote(): Promise<boolean>
      /* uneffect:ensures result === true */
      async function nullable(value: boolean | null): Promise<boolean> {
        const snapshot = value
        value = await readRemote()
        return snapshot === null || value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("keeps property await assignment targets fail-closed", async () => {
    const fileName = "/awaited-fulfillment-property-assignment.ts";
    const source = `
      /* uneffect:ensures result === value */
      declare function readRemote(value: number): Promise<number>
      /* uneffect:ensures result >= 0 */
      async function property(state: { value: number }): Promise<number> {
        state.value = await readRemote(0)
        return state.value
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("supports explicitly typed scalar let bindings assigned before use", async () => {
    const fileName = "/definitely-assigned-local.ts";
    const source = `
      type Int = number
      /* uneffect:ensures result >= value */
      /* uneffect:temporal_contract rejects RangeError */
      declare function readRemote(value: Int): Promise<Int>
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= 0 */
      async function loaded(value: Int): Promise<Int> {
        let result: Int
        try {
          result = await readRemote(value)
        } catch {
          result = 0
        }
        return result
      }
      /* uneffect:ensures result >= 0 */
      function magnitude(value: Int): Int {
        let result: Int
        if (value >= 0) result = value
        else result = -value
        return result
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.some((artifact) => artifact.controlFlow?.narrowing?.facts
      .some((fact) => fact.includes("definite assignment checked by TypeScript")))).toBe(true);
  });

  it("rejects uninitialized, inferred, nullable, and var delayed bindings", async () => {
    const cases = [
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function missing(value: Int, choose: boolean): Int {
          let result: Int
          if (choose) result = value
          return result
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function inferred(value: Int): Int {
          let result
          result = value
          return result
        }
      `,
      `
        /* uneffect:ensures result === true */
        function nullable(value: boolean | null): boolean {
          let result: boolean | null
          result = value
          return result === null
        }
      `,
      `
        type Int = number
        /* uneffect:ensures result >= 0 */
        function functionScoped(value: Int): Int {
          var result: Int
          result = value
          return result
        }
      `,
    ];
    for (const [index, source] of cases.entries()) {
      const fileName = `/delayed-binding-unsupported-${index}.ts`;
      const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
      expect(result.artifacts[0], fileName).toMatchObject({ status: "unsupported", evidence: "unknown" });
    }
  });

  it("composes a scalar fulfillment postcondition through return await", async () => {
    const fileName = "/return-await-contract.ts";
    const source = `
      /* uneffect:ensures result === value + 1 */
      declare function addOne(value: number): Promise<number>
      /* uneffect:ensures result > value */
      async function increment(value: number): Promise<number> {
        return await addOne(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      status: "verified",
      controlFlow: { relationalCalls: [expect.objectContaining({ functionName: "addOne", evidence: "trusted" })] },
    });
  });

  it("proves an awaited callee precondition at the call path", async () => {
    const fileName = "/await-requires-contract.ts";
    const source = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= value */
      declare function readRemote(value: number): Promise<number>
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= value */
      async function normalize(value: number): Promise<number> {
        return await readRemote(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      status: "verified", obligation: expect.objectContaining({ clause: "requires", source: "value >= 0" }),
      controlFlow: expect.objectContaining({ completion: "call" }),
    }));

    const unsafe = source.replace("/* uneffect:requires value >= 0 */\n      /* uneffect:ensures result >= value */\n      async function normalize", "/* uneffect:ensures result >= value */\n      async function normalize");
    const invalid = await verifyContractObligations(fileName, unsafe, undefined, programFor(fileName, unsafe));
    expect(invalid.artifacts).toContainEqual(expect.objectContaining({
      status: "counterexample", obligation: expect.objectContaining({ clause: "requires", source: "value >= 0" }),
    }));
  });

  it("uses a narrowed call path to prove an awaited callee precondition", async () => {
    const fileName = "/await-path-requires-contract.ts";
    const source = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result >= value */
      declare function readRemote(value: number): Promise<number>
      /* uneffect:ensures result >= 0 */
      async function normalize(value: number): Promise<number> {
        if (value >= 0) return await readRemote(value)
        return 0
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts).toContainEqual(expect.objectContaining({
      status: "verified",
      obligation: expect.objectContaining({ clause: "requires", source: "value >= 0" }),
      controlFlow: expect.objectContaining({
        completion: "call",
        pathConditions: [expect.objectContaining({ kind: "binary", operator: "gte" })],
      }),
    }));

    const broken = source.replace("if (value >= 0)", "if (value < 0)");
    const invalid = await verifyContractObligations(fileName, broken, undefined, programFor(fileName, broken));
    expect(invalid.artifacts).toContainEqual(expect.objectContaining({
      status: "counterexample", obligation: expect.objectContaining({ clause: "requires" }),
    }));
  });

  it("promotes a local relational summary only after the callee contract verifies", async () => {
    const fileName = "/verified-relational-call.ts";
    const source = `
      /* uneffect:ensures result === value + 1 */
      async function addOne(value: number): Promise<number> {
        return value + 1
      }
      /* uneffect:ensures result > value */
      async function increment(value: number): Promise<number> {
        return await addOne(value)
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.find(({ obligation }) => obligation?.functionName === "increment")).toMatchObject({
      status: "verified",
      controlFlow: { relationalCalls: [expect.objectContaining({ functionName: "addOne", evidence: "verified" })] },
    });

    const broken = source.replace("return value + 1", "return value - 1");
    const invalid = await verifyContractObligations(fileName, broken, undefined, programFor(fileName, broken));
    expect(invalid.artifacts.find(({ obligation }) => obligation?.functionName === "addOne")).toMatchObject({ status: "counterexample" });
    expect(invalid.artifacts.find(({ obligation }) => obligation?.functionName === "increment")).toMatchObject({
      status: "unknown", evidence: "unknown", message: expect.stringContaining("addOne contract is not verified"),
    });
  });

  it("promotes local synchronous scalar and throw contracts through callers", async () => {
    const fileName = "/verified-sync-relational-call.ts";
    const source = `
      /* uneffect:effect Throw<RangeError> */
      /* uneffect:ensures result === value + 1 */
      function addOne(value: number): number {
        if (value < 0) throw new RangeError("negative")
        return value + 1
      }
      /* uneffect:ensures result === value + 2 */
      function caller(value: number): number {
        try {
          return addOne(value) + 1
        } catch {
          return value + 2
        }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    const callerArtifacts = result.artifacts.filter(({ obligation }) => obligation?.functionName === "caller");
    expect(callerArtifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(callerArtifacts.flatMap(({ controlFlow }) => controlFlow?.relationalCalls ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ functionName: "addOne", evidence: "verified" })]));
    expect(callerArtifacts.flatMap(({ controlFlow }) => controlFlow?.exceptionFlow?.discharged ?? []))
      .toEqual(expect.arrayContaining([expect.objectContaining({ effect: "Throw<RangeError>" })]));

    const broken = source.replace("return value + 1", "return value - 1");
    const invalid = await verifyContractObligations(fileName, broken, undefined, programFor(fileName, broken));
    expect(invalid.artifacts.find(({ obligation }) => obligation?.functionName === "addOne"))
      .toMatchObject({ status: "counterexample" });
    const invalidCallerArtifacts = invalid.artifacts.filter(({ obligation, controlFlow }) =>
      obligation?.functionName === "caller" && (controlFlow?.relationalCalls?.length ?? 0) > 0);
    expect(invalidCallerArtifacts.length).toBeGreaterThan(0);
    expect(invalidCallerArtifacts.every(({ status }) => status === "unknown")).toBe(true);
    expect(invalidCallerArtifacts[0])
      .toMatchObject({ message: expect.stringContaining("addOne contract is not verified") });

    const project = await verifyUneffectProject({ files: {
      "/sync-producer.ts": `
        /* uneffect:ensures result === value + 1 */
        export function addOne(value: number): number { return value + 1 }
      `,
      "/sync-consumer.ts": `
        import { addOne } from "./sync-producer"
        /* uneffect:ensures result === value + 2 */
        export function caller(value: number): number { return addOne(value) + 1 }
      `,
    } });
    expect(project.obligations.find(({ obligation }) => obligation?.functionName === "caller")).toMatchObject({
      status: "verified",
      controlFlow: { relationalCalls: [expect.objectContaining({ functionName: "addOne", evidence: "verified" })] },
    });

    const mutableSource = `
      /* uneffect:ensures result === value + 1 */
      function addOne(value: number): number { return value + 1 }
      let selected = addOne
      selected = value => value - 1
      /* uneffect:ensures result === value + 1 */
      function mutableCaller(value: number): number { return selected(value) }
    `;
    const mutable = await verifyContractObligations("/mutable-sync-call.ts", mutableSource, undefined,
      programFor("/mutable-sync-call.ts", mutableSource));
    expect(mutable.artifacts.find(({ status }) => status === "unsupported"))
      .toMatchObject({ message: expect.stringContaining("selected(value)") });
  });

  it("composes a synchronous contract through const callable and result aliases", async () => {
    const fileName = "/verified-sync-alias-chain.ts";
    const source = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      function addOne(value: number): number { return value + 1 }
      const forwarded = addOne
      const selected = forwarded
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 2 */
      function caller(value: number): number {
        const intermediate = selected(value)
        return intermediate + 1
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    const callerArtifacts = result.artifacts.filter(({ obligation }) => obligation?.functionName === "caller");
    expect(callerArtifacts.find(({ obligation }) => obligation?.clause === "ensures")?.controlFlow?.relationalCalls)
      .toEqual([expect.objectContaining({ functionName: "addOne", evidence: "verified" })]);
    expect(callerArtifacts.find(({ obligation }) => obligation?.clause === "requires")?.controlFlow?.relationalCalls)
      .toEqual([expect.objectContaining({ functionName: "addOne", evidence: "verified" })]);
  });

  it("composes a synchronous contract through a builtin-frozen static property", async () => {
    const fileName = "/verified-sync-frozen-property.ts";
    const source = `
      /* uneffect:ensures result === value + 1 */
      function addOne(value: number): number { return value + 1 }
      const helpers = Object.freeze({ addOne })
      /* uneffect:ensures result === value + 2 */
      function caller(value: number): number { return helpers.addOne(value) + 1 }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));
    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.find(({ obligation }) => obligation?.functionName === "caller")?.controlFlow?.relationalCalls)
      .toEqual([expect.objectContaining({ functionName: "addOne", evidence: "verified" })]);

    const unfrozenSource = source.replace("Object.freeze({ addOne })", "({ addOne })");
    const unfrozen = await verifyContractObligations("/unsupported-sync-property.ts", unfrozenSource, undefined,
      programFor("/unsupported-sync-property.ts", unfrozenSource));
    expect(unfrozen.artifacts.find(({ status }) => status === "unsupported"))
      .toMatchObject({ message: expect.stringContaining("helpers.addOne(value)") });
  });

  it("composes synchronous contracts authored on const function expressions", async () => {
    const fileName = "/verified-sync-function-expressions.ts";
    const source = `
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === value + 1 */
      const addOne = (value: number): number => value + 1
      /* uneffect:ensures result === value * 2 */
      const double = function(value: number): number { return value * 2 }
      /* uneffect:requires value >= 0 */
      /* uneffect:ensures result === (value + 1) * 2 */
      function caller(value: number): number {
        return double(addOne(value))
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    const caller = result.artifacts.filter(({ obligation }) => obligation?.functionName === "caller");
    expect(caller.flatMap(({ controlFlow }) => controlFlow?.relationalCalls ?? []))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "addOne", evidence: "verified" }),
        expect.objectContaining({ functionName: "double", evidence: "verified" }),
      ]));

    const mutableSource = source.replace("const addOne =", "let addOne =");
    const mutable = await verifyContractObligations("/unsupported-sync-function-expression.ts", mutableSource, undefined,
      programFor("/unsupported-sync-function-expression.ts", mutableSource));
    expect(mutable.artifacts.find(({ status }) => status === "unsupported"))
      .toMatchObject({ message: expect.stringContaining("addOne(value)") });
  });

  it("imports TypeChecker parameter facts for const function expressions", async () => {
    const fileName = "/verified-const-function-parameter-facts.ts";
    const source = `
      type Small = 0 | 1
      /* uneffect:ensures result >= 0 */
      /* uneffect:ensures result <= 1 */
      const identity = (value: Small): number => value
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.every(({ controlFlow }) =>
      controlFlow?.narrowing?.facts.includes("value ∈ {0, 1}"))).toBe(true);
  });

  it("infers a local pure synchronous scalar helper without an annotation", async () => {
    const fileName = "/inferred-local-sync-helper.ts";
    const source = `
      function addOne(value: number): number { return value + 1 }
      const forwarded = addOne
      /* uneffect:ensures result === value + 2 */
      function caller(value: number): number { return forwarded(value) + 1 }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({
      status: "verified",
      controlFlow: { relationalCalls: [expect.objectContaining({
        functionName: "addOne",
        clauses: ["result === value + 1"],
        evidence: "verified",
      })] },
    });

    const capturedSource = `
      let offset = 1
      function add(value: number): number { return value + offset }
      /* uneffect:ensures result === value + 1 */
      function caller(value: number): number { return add(value) }
    `;
    const captured = await verifyContractObligations("/unsupported-captured-sync-helper.ts", capturedSource, undefined,
      programFor("/unsupported-captured-sync-helper.ts", capturedSource));
    expect(captured.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("infers a guarded local synchronous throw and discharges it in catch", async () => {
    const fileName = "/inferred-local-sync-throw.ts";
    const source = `
      function nonNegative(value: number): number {
        if (value < 0) throw new RangeError("negative")
        return value
      }
      /* uneffect:ensures result >= 0 */
      function caller(value: number): number {
        try { return nonNegative(value) }
        catch { return 0 }
      }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.flatMap(({ controlFlow }) => controlFlow?.exceptionFlow?.discharged ?? []))
      .toContainEqual(expect.objectContaining({ effect: "Throw<RangeError>", evidence: "verified" }));
  });

  it("infers an unannotated synchronous helper through a project re-export", async () => {
    const project = await verifyUneffectProject({ files: {
      "/producer.ts": `
        export function addOne(value: number): number { return value + 1 }
      `,
      "/barrel.ts": `export { addOne as increment } from "./producer"`,
      "/consumer.ts": `
        import { increment } from "./barrel"
        /* uneffect:ensures result === value + 2 */
        export function caller(value: number): number { return increment(value) + 1 }
      `,
    } });

    expect(project.diagnostics).toEqual([]);
    expect(project.obligations).toHaveLength(1);
    expect(project.obligations[0]).toMatchObject({
      status: "verified",
      controlFlow: { relationalCalls: [expect.objectContaining({
        functionName: "addOne",
        declarationFileName: "/producer.ts",
        evidence: "verified",
      })] },
    });

    const reassigned = await verifyUneffectProject({ files: {
      "/producer.ts": `
        export function addOne(value: number): number { return value + 1 }
        addOne = (value: number): number => value - 1
      `,
      "/consumer.ts": `
        import { addOne } from "./producer"
        /* uneffect:ensures result === value + 1 */
        export function caller(value: number): number { return addOne(value) }
      `,
    } });
    expect(reassigned.obligations.find(({ status }) => status === "unsupported"))
      .toMatchObject({ message: expect.stringContaining("addOne(value)") });
  });

  it("infers an unannotated async helper from its imported source file", async () => {
    const project = await verifyUneffectProject({ files: {
      "/producer.ts": `
        export async function addOne(value: number): Promise<number> { return value + 1 }
      `,
      "/consumer.ts": `
        import { addOne } from "./producer"
        /* uneffect:ensures result === value + 1 */
        export async function caller(value: number): Promise<number> { return await addOne(value) }
      `,
    } });

    expect(project.diagnostics).toEqual([]);
    expect(project.obligations).toHaveLength(1);
    expect(project.obligations[0]).toMatchObject({
      status: "verified",
      controlFlow: { relationalCalls: [expect.objectContaining({
        functionName: "addOne",
        declarationFileName: "/producer.ts",
        evidence: "verified",
      })] },
    });
  });

  it("infers reviewed Math casts inside an unannotated scalar helper", async () => {
    const fileName = "/inferred-sync-math-helper.ts";
    const source = `
      type Int = number
      type Float = number
      function floorValue(value: Float): Int { return Math.floor(value) }
      /* uneffect:ensures result <= value && value < result + 1 */
      function caller(value: Float): Int { return floorValue(value) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.flatMap(({ controlFlow }) => controlFlow?.relationalCalls ?? []))
      .toContainEqual(expect.objectContaining({ functionName: "floorValue", evidence: "verified" }));

    const shadowedSource = source.replace(
      "function floorValue(value: Float): Int { return Math.floor(value) }",
      "const Math = { floor(value: number): number { return value + 1 } }; function floorValue(value: Float): Int { return Math.floor(value) }",
    );
    const shadowed = await verifyContractObligations("/unsupported-inferred-sync-math.ts", shadowedSource, undefined,
      programFor("/unsupported-inferred-sync-math.ts", shadowedSource));
    expect(shadowed.artifacts[0]).toMatchObject({ status: "unsupported", evidence: "unknown" });
  });

  it("infers piecewise reviewed Math helpers as guarded relations", async () => {
    const fileName = "/inferred-piecewise-math-helpers.ts";
    const source = `
      type Int = number
      type Float = number
      const magnitude = (value: Int): Int => Math.abs(value) + 1
      function smaller(left: Int, right: Int): Int { return Math.min(left, right) }
      function larger(left: Int, right: Int): Int { return Math.max(left, right) }
      function truncate(value: Float): Int { return Math.trunc(value) }
      function direction(value: Int): Int { return Math.sign(value) }
      /* uneffect:ensures result >= 1 */
      function magnitudeCaller(value: Int): Int { return magnitude(value) }
      /* uneffect:ensures result <= left && result <= right */
      function smallerCaller(left: Int, right: Int): Int { return smaller(left, right) }
      /* uneffect:ensures result >= left && result >= right */
      function largerCaller(left: Int, right: Int): Int { return larger(left, right) }
      /* uneffect:ensures (value >= 0 && result <= value && value < result + 1) || (value < 0 && result >= value && value > result - 1) */
      function truncateCaller(value: Float): Int { return truncate(value) }
      /* uneffect:ensures result >= -1 && result <= 1 */
      function directionCaller(value: Int): Int { return direction(value) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(5);
    expect(result.artifacts.every(({ status }) => status === "verified")).toBe(true);
    expect(result.artifacts.flatMap(({ controlFlow }) => controlFlow?.relationalCalls ?? []))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ functionName: "magnitude", evidence: "verified" }),
        expect.objectContaining({ functionName: "smaller", evidence: "verified" }),
        expect.objectContaining({ functionName: "larger", evidence: "verified" }),
        expect.objectContaining({ functionName: "truncate", evidence: "verified" }),
        expect.objectContaining({ functionName: "direction", evidence: "verified" }),
      ]));
  });

  it("reaches a fixed point across a local relational summary chain", async () => {
    const fileName = "/verified-relational-chain.ts";
    const source = `
      /* uneffect:ensures result === value + 1 */
      async function addOne(value: number): Promise<number> { return value + 1 }
      /* uneffect:ensures result === value + 2 */
      async function addTwo(value: number): Promise<number> { return await addOne(value + 1) }
      /* uneffect:ensures result > value */
      async function increment(value: number): Promise<number> { return await addTwo(value) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(3);
    for (const functionName of ["addTwo", "increment"]) {
      expect(result.artifacts.find(({ obligation }) => obligation?.functionName === functionName)?.controlFlow?.relationalCalls)
        .toEqual([expect.objectContaining({ evidence: "verified" })]);
    }

    const broken = source.replace("return value + 1", "return value - 1");
    const invalid = await verifyContractObligations(fileName, broken, undefined, programFor(fileName, broken));
    expect(invalid.artifacts.find(({ obligation }) => obligation?.functionName === "addTwo")).toMatchObject({ status: "unknown" });
    expect(invalid.artifacts.find(({ obligation }) => obligation?.functionName === "increment")).toMatchObject({ status: "unknown" });
  });

  it("does not promote a circular relational proof", async () => {
    const fileName = "/circular-relational-contract.ts";
    const source = `
      /* uneffect:ensures result === value */
      async function left(value: number): Promise<number> { return await right(value) }
      /* uneffect:ensures result === value */
      async function right(value: number): Promise<number> { return await left(value) }
    `;
    const result = await verifyContractObligations(fileName, source, undefined, programFor(fileName, source));

    expect(result.diagnostics).toEqual([]);
    expect(result.artifacts).toHaveLength(2);
    expect(result.artifacts.every((artifact) => artifact.controlFlow?.relationalCalls?.[0]?.evidence === "trusted")).toBe(true);
  });

  it("reconciles a TypeChecker-resolved relational summary across source files", async () => {
    const files = {
      "/producer.ts": `
        /* uneffect:ensures result === value + 1 */
        export async function addOne(value: number): Promise<number> { return value + 1 }
      `,
      "/consumer.ts": `
        import { addOne } from "./producer"
        /* uneffect:ensures result > value */
        export async function increment(value: number): Promise<number> { return await addOne(value) }
      `,
    };
    const program = programForFiles(files);
    const producer = await verifyContractObligations("/producer.ts", files["/producer.ts"], undefined, program);
    const consumer = await verifyContractObligations("/consumer.ts", files["/consumer.ts"], undefined, program);
    expect(consumer.artifacts[0]?.controlFlow?.relationalCalls).toEqual([
      expect.objectContaining({ evidence: "trusted", declarationFileName: "/producer.ts", functionName: "addOne" }),
    ]);

    const reconciled = reconcileContractArtifacts(new Map(Object.entries(files)), [...producer.artifacts, ...consumer.artifacts]);
    expect(reconciled.diagnostics).toEqual([]);
    expect(reconciled.artifacts.find(({ obligation }) => obligation?.functionName === "increment")?.controlFlow?.relationalCalls)
      .toEqual([expect.objectContaining({ evidence: "verified", declarationFileName: "/producer.ts" })]);

    const staleConsumer = consumer.artifacts.map((artifact) => ({
      ...artifact,
      controlFlow: artifact.controlFlow ? {
        ...artifact.controlFlow,
        relationalCalls: artifact.controlFlow.relationalCalls?.map((call) => ({ ...call, declarationDigest: "0".repeat(64) })),
      } : undefined,
    }));
    const stale = reconcileContractArtifacts(new Map(Object.entries(files)), [...producer.artifacts, ...staleConsumer]);
    expect(stale.artifacts.find(({ obligation }) => obligation?.functionName === "increment")).toMatchObject({
      status: "unknown", message: expect.stringContaining("declaration digest does not match"),
    });

    const brokenFiles = { ...files, "/producer.ts": files["/producer.ts"].replace("return value + 1", "return value - 1") };
    const brokenProgram = programForFiles(brokenFiles);
    const brokenProducer = await verifyContractObligations("/producer.ts", brokenFiles["/producer.ts"], undefined, brokenProgram);
    const brokenConsumer = await verifyContractObligations("/consumer.ts", brokenFiles["/consumer.ts"], undefined, brokenProgram);
    const invalid = reconcileContractArtifacts(new Map(Object.entries(brokenFiles)), [...brokenProducer.artifacts, ...brokenConsumer.artifacts]);
    expect(invalid.artifacts.find(({ obligation }) => obligation?.functionName === "increment")).toMatchObject({ status: "unknown" });
  });

  it("applies cross-file relational reconciliation in project verification", async () => {
    const result = await verifyUneffectProject({ files: {
      "/producer.ts": `
        /* uneffect:ensures result === value + 1 */
        export async function addOne(value: number): Promise<number> { return value + 1 }
      `,
      "/consumer.ts": `
        import { addOne } from "./producer"
        /* uneffect:ensures result > value */
        export async function increment(value: number): Promise<number> { return await addOne(value) }
      `,
    } });

    expect(result.obligations.find(({ obligation }) => obligation?.functionName === "increment")?.controlFlow?.relationalCalls)
      .toEqual([expect.objectContaining({ evidence: "verified", declarationFileName: "/producer.ts" })]);
  });

  it("does not silently assume that an unmodeled call is pure", async () => {
    const [failure] = await verifyContracts("call.ts", `
      /* uneffect:ensures result === x */
      function wrapped(x: Int): Int { touch(); return x }
    `);
    expect(failure).toMatchObject({ clause: "unsupported", message: expect.stringContaining("verified function summary") });
  });

  it("lowers only imported Effect pipe with inline unary expression callbacks", async () => {
    expect(await verifyContracts("effect-pipe.ts", `
      import { pipe as flow } from "effect/Function"
      /* uneffect:requires x >= 0 */
      /* uneffect:ensures result === x + 2 */
      function addTwo(x: number) { return flow(x, value => value + 1, value => value + 1) }
    `)).toEqual([]);

    const [spoofed] = await verifyContracts("spoofed-pipe.ts", `
      function pipe(value: number, stage: (value: number) => number) { return stage(value) }
      /* uneffect:ensures result === x + 1 */
      function addOne(x: number) { return pipe(x, value => value + 1) }
    `);
    expect(spoofed).toMatchObject({ clause: "unsupported", message: expect.stringContaining("unsupported invariant expression") });
  });
});

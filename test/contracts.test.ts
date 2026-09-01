import { describe, expect, it } from "vitest";
import ts from "typescript";
import { attachContractEffectBoundaries, reconcileContractArtifacts, verifyContractObligations, verifyContracts } from "../src/contracts.js";
import { verifyUneffectProject } from "../src/project-verification.js";

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

function programForFiles(files: Readonly<Record<string, string>>): ts.Program {
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler };
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

  it("routes a TypeChecker-resolved temporal rejection summary through catch", async () => {
    const fileName = "/declared-rejection-contract.ts";
    const source = `
      type Int = number
      /* uneffect:temporal-summary rejects RangeError */
      /* uneffect:temporal-summary throws URIError */
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

  it("does not apply a temporal rejection summary to a non-Promise return", async () => {
    const fileName = "/invalid-declared-rejection-contract.ts";
    const source = `
      /* uneffect:temporal-summary rejects RangeError */
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
      /* uneffect:temporal-summary rejects RangeError */
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

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executeZ3,
  executeZ3WithBackends,
  parseZ3BackendPreference,
  type Z3BackendDriver,
  type Z3ExecutionResult,
} from "../src/z3.js";
import { parseTemporalExpression } from "../src/temporal-expressions.js";
import { checkTemporalExpressionEquivalenceWithZ3, findTemporalCounterexampleWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import type { TemporalSpec } from "../src/spec-ir.js";
import { generateUneffectPropertyTestsWithZ3 } from "../src/property-tests.js";

const result = (
  backend: "native" | "wasm",
  status: Z3ExecutionResult["status"],
  failureKind?: Z3ExecutionResult["failureKind"],
): Z3ExecutionResult => ({
  backend,
  version: backend === "native" ? "Z3 4.16.0" : "Z3 4.16.0.0",
  status,
  model: status === "sat" ? "(model)" : undefined,
  stdout: `${status}\n`,
  stderr: "",
  exitCode: status === "error" ? 1 : 0,
  failureKind,
});

function driver(backend: "native" | "wasm", available: boolean, answer: Z3ExecutionResult): Z3BackendDriver {
  return { backend, probe: vi.fn(async () => available), execute: vi.fn(async () => answer) };
}

describe("Z3 backend selection", () => {
  it("accepts only the three documented backend preferences", () => {
    expect(parseZ3BackendPreference(undefined)).toBe("auto");
    expect(parseZ3BackendPreference("auto")).toBe("auto");
    expect(parseZ3BackendPreference("native")).toBe("native");
    expect(parseZ3BackendPreference("wasm")).toBe("wasm");
    expect(() => parseZ3BackendPreference("fast")).toThrow(/auto, native, or wasm/);
  });

  it("prefers native in auto mode and does not reinterpret a semantic verdict", async () => {
    const native = driver("native", true, result("native", "unknown"));
    const wasm = driver("wasm", true, result("wasm", "unsat"));
    const execution = await executeZ3WithBackends("(check-sat)\n", { preference: "auto" }, { native, wasm });
    expect(execution).toMatchObject({ backend: "native", status: "unknown", attempts: [{ backend: "native", status: "unknown" }] });
    expect(wasm.execute).not.toHaveBeenCalled();
  });

  it("falls back only after native infrastructure failure and preserves the failed attempt", async () => {
    const native = driver("native", true, result("native", "error", "oom"));
    const wasm = driver("wasm", true, result("wasm", "unsat"));
    const execution = await executeZ3WithBackends("(check-sat)\n", { preference: "auto" }, { native, wasm });
    expect(execution).toMatchObject({
      backend: "wasm",
      status: "unsat",
      attempts: [
        { backend: "native", status: "error", failureKind: "oom" },
        { backend: "wasm", status: "unsat" },
      ],
    });
  });

  it("persists source-linked SMT-LIB, failed attempts, and process telemetry across fallback", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "uneffect-z3-evidence-"));
    try {
      const native = driver("native", true, result("native", "error", "oom"));
      const wasm = driver("wasm", true, result("wasm", "unsat"));
      const program = "(set-logic QF_UF)\n(assert false)\n(check-sat)\n";
      const execution = await executeZ3WithBackends(program, {
        preference: "auto",
        evidence: {
          directory: evidenceDirectory,
          source: "test/z3-backend.test.ts",
          obligation: "fallback telemetry",
        },
      }, { native, wasm });

      expect(execution.status).toBe("unsat");
      const files = readdirSync(evidenceDirectory);
      const programFile = files.find((file) => file.endsWith(".smt2"));
      const recordFile = files.find((file) => file.endsWith(".jsonl"));
      expect(programFile).toBeDefined();
      expect(readFileSync(join(evidenceDirectory, programFile!), "utf8")).toBe(program);
      const records = readFileSync(join(evidenceDirectory, recordFile!), "utf8")
        .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map(({ event }) => event)).toEqual(["start", "attempt", "attempt", "complete"]);
      expect(records[0]).toMatchObject({
        source: "test/z3-backend.test.ts",
        obligation: "fallback telemetry",
        programFile,
        programBytes: Buffer.byteLength(program),
        process: { pid: process.pid, rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number) },
      });
      expect(records[1]).toMatchObject({ event: "attempt", backend: "native", status: "error", failureKind: "oom", durationMs: expect.any(Number) });
      expect(records[2]).toMatchObject({ event: "attempt", backend: "wasm", status: "unsat", durationMs: expect.any(Number) });
      expect(records[3]).toMatchObject({ event: "complete", status: "unsat", process: { rssBytes: expect.any(Number) }, durationMs: expect.any(Number) });
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  });

  it("deduplicates repeated SMT-LIB inputs while retaining each execution record", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "uneffect-z3-repeat-"));
    try {
      const native = driver("native", true, result("native", "unsat"));
      const wasm = driver("wasm", true, result("wasm", "unsat"));
      const options = { preference: "native" as const, evidence: { directory: evidenceDirectory } };
      await executeZ3WithBackends("(check-sat)\n", options, { native, wasm });
      await executeZ3WithBackends("(check-sat)\n", options, { native, wasm });
      expect(readdirSync(evidenceDirectory).filter((file) => file.endsWith(".smt2"))).toHaveLength(1);
      expect(readdirSync(evidenceDirectory).filter((file) => file.endsWith(".jsonl"))).toHaveLength(2);
    } finally {
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  });

  it("honors the isolated-runner evidence directory environment", async () => {
    const evidenceDirectory = mkdtempSync(join(tmpdir(), "uneffect-z3-env-"));
    const previous = process.env.UNEFFECT_SOLVER_EVIDENCE_DIR;
    process.env.UNEFFECT_SOLVER_EVIDENCE_DIR = evidenceDirectory;
    try {
      await executeZ3("(set-logic QF_UF)\n(assert false)\n", { preference: "wasm" });
      expect(readdirSync(evidenceDirectory)).toEqual(expect.arrayContaining([
        expect.stringMatching(/\.smt2$/u),
        expect.stringMatching(/\.jsonl$/u),
      ]));
    } finally {
      if (previous === undefined) delete process.env.UNEFFECT_SOLVER_EVIDENCE_DIR;
      else process.env.UNEFFECT_SOLVER_EVIDENCE_DIR = previous;
      rmSync(evidenceDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when an explicitly selected backend is unavailable", async () => {
    const native = driver("native", false, result("native", "error", "unavailable"));
    const wasm = driver("wasm", true, result("wasm", "unsat"));
    const execution = await executeZ3WithBackends("(check-sat)\n", { preference: "native" }, { native, wasm });
    expect(execution).toMatchObject({ backend: "native", status: "error", failureKind: "unavailable" });
    expect(wasm.execute).not.toHaveBeenCalled();
  });

  it("does not fall back after a native timeout unless explicitly enabled", async () => {
    const native = driver("native", true, result("native", "error", "timeout"));
    const wasm = driver("wasm", true, result("wasm", "unsat"));
    const stopped = await executeZ3WithBackends("(check-sat)\n", { preference: "auto" }, { native, wasm });
    expect(stopped).toMatchObject({ backend: "native", status: "error", failureKind: "timeout" });
    const retried = await executeZ3WithBackends("(check-sat)\n", { preference: "auto", fallbackOnTimeout: true }, { native, wasm });
    expect(retried).toMatchObject({ backend: "wasm", status: "unsat" });
  });

  it("does not classify malformed SMT-LIB as a retryable backend failure", async () => {
    const native = driver("native", true, result("native", "error", "invalid-input"));
    const wasm = driver("wasm", true, result("wasm", "unsat"));
    const execution = await executeZ3WithBackends("(invalid)\n", { preference: "auto" }, { native, wasm });
    expect(execution).toMatchObject({ backend: "native", status: "error", failureKind: "invalid-input" });
    expect(wasm.execute).not.toHaveBeenCalled();
  });

  it("propagates an explicitly unavailable native backend through temporal equivalence", async () => {
    const spec: TemporalSpec = {
      stutteringPolicy: "explicit-unchanged", clocks: [], states: [{ name: "value", type: "int" }], init: [], actions: [], properties: [], liveness: [], recurrences: [], stabilizations: [], responses: [],
    };
    await expect(checkTemporalExpressionEquivalenceWithZ3(
      spec, parseTemporalExpression("value + 0"), parseTemporalExpression("value"),
      { preference: "native", nativeExecutable: "uneffect-missing-temporal-z3" },
    )).resolves.toMatchObject({ status: "unknown", backend: "z3", reason: expect.stringContaining("unavailable") });
  });

  it("reports a temporal lint backend failure instead of returning an empty diagnostic set", async () => {
    const expression = "value === value";
    const spec: TemporalSpec = {
      stutteringPolicy: "explicit-unchanged", clocks: [], states: [{ name: "value", type: "int" }], init: [], actions: [],
      properties: [{ name: "reflexive", expression, expressionAst: parseTemporalExpression(expression) }],
      liveness: [], recurrences: [], stabilizations: [], responses: [],
    };
    await expect(lintTemporalSpecWithZ3(spec, {
      preference: "native", nativeExecutable: "uneffect-missing-lint-z3",
    })).resolves.toContainEqual(expect.objectContaining({ code: "solver-backend-error", backend: "z3", name: "<backend>" }));
  });

  it("reports an unavailable backend from bounded temporal reachability", async () => {
    const spec: TemporalSpec = {
      stutteringPolicy: "explicit-unchanged", clocks: [], states: [{ name: "value", type: "int" }],
      init: [{ target: "value", expression: "0", expressionAst: parseTemporalExpression("0") }],
      actions: [], properties: [], liveness: [], recurrences: [], stabilizations: [], responses: [],
    };
    await expect(lintTemporalReachabilityWithZ3(spec, { z3: {
      preference: "native", nativeExecutable: "uneffect-missing-reachability-z3",
    } })).resolves.toContainEqual(expect.objectContaining({ code: "solver-backend-error", name: "<backend>" }));
  });

  it("does not bypass an explicitly unavailable backend during counterexample extraction", async () => {
    const expression = "value > 0";
    const spec: TemporalSpec = {
      stutteringPolicy: "explicit-unchanged", clocks: [], states: [{ name: "value", type: "int" }],
      init: [{ target: "value", expression: "0", expressionAst: parseTemporalExpression("0") }], actions: [],
      properties: [{ name: "positive", expression, expressionAst: parseTemporalExpression(expression) }],
      liveness: [], recurrences: [], stabilizations: [], responses: [],
    };
    await expect(findTemporalCounterexampleWithZ3(spec, "positive", {
      maxSteps: 0, z3: { preference: "native", nativeExecutable: "uneffect-missing-counterexample-z3" },
    })).resolves.toEqual({ status: "unknown", depth: 0 });
  });

  it("does not bypass an explicitly unavailable backend during property model generation", async () => {
    const generated = await generateUneffectPropertyTestsWithZ3({ files: { "factor.ts": `
      type Int = number
      /* uneffect:requires x >= 0 && y >= 0 && x * y === 4 */
      /* uneffect:ensures result === 4 */
      export function factor(x: Int, y: Int): Int { return x * y }
    ` }, solverCases: 2, z3: { preference: "native", nativeExecutable: "uneffect-missing-property-z3" } });
    expect(generated.solverDiagnostics).toContainEqual(expect.objectContaining({ functionName: "factor", status: "unknown", message: expect.stringContaining("unavailable") }));
  });

  it("falls back to the bundled WASM solver when the native executable is absent", async () => {
    const execution = await executeZ3("(set-logic QF_UF)\n(assert false)\n", {
      preference: "auto", nativeExecutable: "uneffect-definitely-missing-z3",
    });
    expect(execution).toMatchObject({
      backend: "wasm", status: "unsat",
      attempts: [{ backend: "native", failureKind: "unavailable" }, { backend: "wasm", status: "unsat" }],
    });
  });

  it("extracts named scalar values from the WASM model", async () => {
    const execution = await executeZ3("(set-logic ALL)\n(declare-const x Int)\n(declare-const b Bool)\n(declare-const s String)\n(assert (= x (- 1)))\n(assert b)\n(assert (= s \"node-a\"))\n", {
      preference: "wasm",
      values: [{ name: "x", expression: "x", sort: "Int" }, { name: "b", expression: "b", sort: "Bool" }, { name: "s", expression: "s", sort: "String" }],
    });
    expect(execution).toMatchObject({ backend: "wasm", status: "sat", values: { x: "(- 1)", b: "true", s: '"node-a"' } });
  });

  it("fails closed before the WASM parser can ignore malformed SMT-LIB", async () => {
    for (const program of ["(invalid)\n", "(assert false\n", ")\n", "(assert)\n"]) {
      const execution = await executeZ3(program, { preference: "wasm" });
      expect(execution).toMatchObject({ backend: "wasm", status: "error", failureKind: "invalid-input" });
    }
  });

  it.runIf(spawnSync("z3", ["-version"], { encoding: "utf8" }).status === 0)("executes a real native SMT-LIB query when Z3 is installed", async () => {
    const execution = await executeZ3("(set-logic QF_UF)\n(assert false)\n", { preference: "native" });
    expect(execution).toMatchObject({ backend: "native", status: "unsat", attempts: [{ backend: "native", status: "unsat" }] });
    expect(execution.version).toMatch(/^Z3 version \d+\./u);
  });

  it.runIf(spawnSync("z3", ["-version"], { encoding: "utf8" }).status === 0)("extracts the same named scalar values from native Z3", async () => {
    const execution = await executeZ3("(set-logic QF_LIA)\n(declare-const x Int)\n(declare-const b Bool)\n(assert (= x (- 1)))\n(assert b)\n", {
      preference: "native",
      values: [{ name: "x", expression: "x", sort: "Int" }, { name: "b", expression: "b", sort: "Bool" }],
    });
    expect(execution).toMatchObject({ backend: "native", status: "sat", values: { x: "(- 1)", b: "true" } });
  });

  it.runIf(spawnSync("z3", ["-version"], { encoding: "utf8" }).status === 0)("agrees with WASM on representative satisfiable and refutation queries", async () => {
    for (const program of [
      "(set-logic QF_LIA)\n(declare-const x Int)\n(assert (> x 3))\n",
      "(set-logic QF_LIA)\n(declare-const x Int)\n(assert (> x 3))\n(assert (< x 0))\n",
    ]) {
      const native = await executeZ3(program, { preference: "native" });
      const wasm = await executeZ3(program, { preference: "wasm" });
      expect(native.status).toBe(wasm.status);
    }
  });
});

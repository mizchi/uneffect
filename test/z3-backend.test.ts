import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  executeZ3,
  executeZ3WithBackends,
  parseZ3BackendPreference,
  type Z3BackendDriver,
  type Z3ExecutionResult,
} from "../src/z3.js";

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

  it("falls back to the bundled WASM solver when the native executable is absent", async () => {
    const execution = await executeZ3("(set-logic QF_UF)\n(assert false)\n", {
      preference: "auto", nativeExecutable: "uneffect-definitely-missing-z3",
    });
    expect(execution).toMatchObject({
      backend: "wasm", status: "unsat",
      attempts: [{ backend: "native", failureKind: "unavailable" }, { backend: "wasm", status: "unsat" }],
    });
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

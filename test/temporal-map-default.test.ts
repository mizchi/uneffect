import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTlcCounterexample } from "../src/model-replay.js";
import { generateQuint } from "../src/spec-backends.js";
import { findTemporalCounterexampleWithZ3 } from "../src/spec-lint.js";
import { parseSpec } from "../src/spec-ir.js";
import { generateRuntimeAssertionExpression } from "../src/temporal-expressions.js";

const fixture = `/* uneffect:temporal state epochs: Map<int, int> */ /* uneffect:temporal state observed: int */ /* uneffect:temporal init epochs = Map([[1, 7]]) */ /* uneffect:temporal init observed = -1 */ /* uneffect:temporal action observeMissing: observed' = epochs.getOrElse(2, 0) */ /* uneffect:temporal invariant missingUsesDefault: epochs.getOrElse(2, 0) === 0 */ /* uneffect:temporal invariant presentUsesValue: epochs.getOrElse(1, 0) === 7 */`;

describe("total temporal Map lookup", () => {
  it("lowers getOrElse consistently to Quint, runtime, Z3, and TLC action replay", async () => {
    const temporal = parseSpec("map-default.ts", fixture).temporal;
    const quint = generateQuint("map_default", temporal);
    expect(quint).toContain(
      "observed' = (if (epochs.keys().contains(2)) epochs.get(2) else 0)",
    );
    expect(quint).toContain(
      "(if (epochs.keys().contains(1)) epochs.get(1) else 0) == 7",
    );
    expect(generateRuntimeAssertionExpression(temporal.properties[0]!.expressionAst)).toBe(
      "(epochs.has(2) ? epochs.get(2) : 0) === 0",
    );

    const directory = mkdtempSync(join(tmpdir(), "uneffect-map-default-"));
    const path = join(directory, "map-default.qnt");
    writeFileSync(path, quint);
    for (const invariant of ["missingUsesDefault", "presentUsesValue"]) {
      const result = spawnSync(
        "pnpm",
        ["exec", "quint", "run", path, `--invariant=${invariant}`, "--max-steps=2", "--max-samples=20"],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
    }
    rmSync(directory, { recursive: true, force: true });

    await expect(findTemporalCounterexampleWithZ3(temporal, "missingUsesDefault", { maxSteps: 1 }))
      .resolves.toEqual({ status: "safe-within-bound", depth: 1 });
    await expect(findTemporalCounterexampleWithZ3(temporal, "presentUsesValue", { maxSteps: 1 }))
      .resolves.toEqual({ status: "safe-within-bound", depth: 1 });
    const broken = parseSpec("map-default-broken.ts", fixture.replace(
      "invariant missingUsesDefault: epochs.getOrElse(2, 0) === 0",
      "invariant missingUsesDefault: epochs.getOrElse(2, 0) === 1",
    )).temporal;
    await expect(findTemporalCounterexampleWithZ3(broken, "missingUsesDefault", { maxSteps: 1 }))
      .resolves.toMatchObject({
        status: "counterexample",
        depth: 0,
        trace: { initialState: { epochs: [[1, 7]], observed: -1 } },
      });
    await expect(findTemporalCounterexampleWithZ3(broken, "missingUsesDefault", {
      maxSteps: 1,
      z3: { preference: "native", nativeExecutable: "/definitely/missing/uneffect-z3" },
    })).resolves.toEqual({ status: "unknown", depth: 0 });

    const trace = parseTlcCounterexample(`
Invariant missingUsesDefault is violated.
State 1: <Initial predicate>
/\\ epochs = [1 |-> 7]
/\\ observed = -1
State 2: <observeMissing line 1, col 1 to line 1, col 1 of module map_default>
/\\ epochs = [1 |-> 7]
/\\ observed = 0
`, temporal, "map-default-hash");
    expect(trace.steps).toEqual([expect.objectContaining({
      action: "observeMissing",
      after: { epochs: [[1, 7]], observed: 0 },
    })]);
  });

  it("keeps plain get partial and rejects invalid getOrElse contracts", () => {
    expect(() => parseSpec("unguarded.ts", fixture.replace(
      "epochs.getOrElse(2, 0) === 0",
      "epochs.get(2) === 0",
    ))).toThrow(/Map\.get requires a conjunctive .*keys\(\)\.contains\(key\) guard/);

    for (const [name, expression, message] of [
      ["arity", "epochs.getOrElse(2)", /getOrElse requires a key and fallback/],
      ["key", "epochs.getOrElse(true, 0)", /getOrElse key type must match/],
      ["fallback", "epochs.getOrElse(2, true)", /getOrElse fallback type must match/],
    ] as const) {
      expect(() => parseSpec(`${name}.ts`, fixture.replace(
        "epochs.getOrElse(2, 0) === 0",
        `${expression} === 0`,
      )), name).toThrow(message);
    }

    const records = parseSpec("record-default.ts", `/* uneffect:temporal state leases: Map<int, { epoch: int, valid: bool }> */ /* uneffect:temporal init leases = Map([]) */ /* uneffect:temporal action publish: leases' = leases.put(1, { epoch: 1, valid: true }) */ /* uneffect:temporal invariant absentIsInvalid: !leases.getOrElse(2, { epoch: 0, valid: false }).valid */`).temporal;
    expect(generateQuint("record_default", records)).toContain(
      '(if (leases.keys().contains(2)) leases.get(2) else { epoch: 0, valid: false }).valid',
    );
  });
});

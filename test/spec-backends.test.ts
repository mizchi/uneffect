import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuint, generateSmtLib } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";

const source = `
  /*
   * uneffect:
   * state epoch: int
   * state cachedAt: int
   * state cacheValid: bool
   * init epoch = 0
   * init cachedAt = 0
   * init cacheValid = false
   * action read: cachedAt' = epoch, cacheValid' = true
   * action suspend: epoch' = epoch + 1, cacheValid' = false
   * temporal cacheIsSound: !cacheValid || cachedAt === epoch
   */

  /*
   * uneffect:
   * effect Console | Fetch<GET, "https://example.com/**">
   * requires x >= 0
   * ensures result > x
   */
  function inc(x: number) { console.log(x); return x + 1 }
`;

describe("spec IR and generated verifier programs", () => {
  it("classifies capability, invariant, and temporal specifications", () => {
    const spec = parseSpec("input.ts", source);
    expect(spec.capabilities[0]).toMatchObject({
      functionName: "inc",
      effects: [
        expect.objectContaining({ value: expect.objectContaining({ kind: "capability", name: "Console" }), span: expect.any(Object) }),
        expect.objectContaining({ value: expect.objectContaining({ kind: "capability", name: "Fetch" }), span: expect.any(Object) }),
      ],
    });
    expect(spec.invariants[0]).toMatchObject({
      functionName: "inc",
      parameters: ["x"],
      requires: ["x >= 0"],
      ensures: ["result > x"],
      result: "x + 1",
    });
    expect(spec.temporal).toMatchObject({
      states: [
        { name: "epoch", type: "int" },
        { name: "cachedAt", type: "int" },
        { name: "cacheValid", type: "bool" },
      ],
      properties: [{ name: "cacheIsSound", expression: "!cacheValid || cachedAt === epoch" }],
    });
  });

  it("reports malformed effects with their source location", () => {
    expect(() => parseSpec("broken.ts", `\n/* uneffect: effect Fetch<GET */\nfunction f() {}`))
      .toThrow(/broken\.ts:2:\d+: invalid effect/);
  });

  it("rejects an unsupported Uneffect directive instead of ignoring it", () => {
    expect(() => parseSpec("broken.ts", `/* uneffect: effects Console */\nfunction f() {}`))
      .toThrow(/broken\.ts:1:\d+: unknown Uneffect directive `effects`/);
  });

  it("rejects an empty member in an effect union", () => {
    expect(() => parseSpec("broken.ts", `/* uneffect: effect Console | */\nfunction f() {}`))
      .toThrow(/broken\.ts:1:\d+: empty member/);
  });

  it("generates an SMT-LIB proof obligation accepted as unsat by Z3", () => {
    const fn = parseSpec("input.ts", source).invariants[0]!;
    const smt = generateSmtLib(fn);
    expect(smt).toContain("(assert (= result (+ x 1)))");
    const result = spawnSync("z3", ["-in"], { input: smt, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unsat");
  });

  it("generates a Quint transition system that preserves its invariant", () => {
    const temporal = parseSpec("input.ts", source).temporal;
    const quint = generateQuint("generated", temporal);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-quint-"));
    const path = join(directory, "generated.qnt");
    writeFileSync(path, quint);
    const result = spawnSync("pnpm", [
      "exec", "quint", "run", path,
      "--invariant=cacheIsSound", "--max-steps=10", "--max-samples=100",
      "--seed=0x123456789abcdef", "--verbosity=1",
    ], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain("No violation found");
  });

  it("generates guarded real-time actions and finds a load-bearing broken tick", () => {
    const model = (guarded: boolean) => parseSpec("realtime.ts", `
      /*
       * uneffect:
       * clock clock: 1
       * state pending: bool
       * state deadline: int
       * init pending = false
       * init deadline = 0
       * action release: pending' = true, deadline' = clock + 3
       * action_when release: !pending
       * action complete: pending' = false
       * action_when complete: pending && clock <= deadline
       ${guarded ? "* action_when tick_clock: !pending || clock < deadline" : ""}
       * action_fair tick_clock: weak
       * temporal deadlineSafe: !pending || clock <= deadline
       */
    `).temporal;
    expect(model(true).actions).toContainEqual(expect.objectContaining({
      name: "tick_clock", guard: expect.objectContaining({ expression: "!pending || clock < deadline" }),
    }));
    expect(model(true).clocks).toEqual([{ name: "clock", granularity: 1 }]);
    expect(model(true).actions.find((action) => action.name === "tick_clock")?.fairness).toBe("weak");
    expect(generateQuint("realtime", model(true))).toContain("tick_clock.weakFair(fairnessVars)");

    const run = (guarded: boolean) => {
      const directory = mkdtempSync(join(tmpdir(), "uneffect-realtime-"));
      const path = join(directory, "realtime.qnt");
      writeFileSync(path, generateQuint("realtime", model(guarded)));
      return spawnSync("pnpm", ["exec", "quint", "run", path,
        "--invariant=deadlineSafe", "--max-steps=8", "--max-samples=200",
        "--seed=0x123456789abcdef", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
    };
    const positive = run(true);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    expect(positive.stdout + positive.stderr).toContain("No violation found");
    const broken = run(false);
    expect(broken.status).not.toBe(0);
    expect(broken.stdout + broken.stderr).toMatch(/violation|counterexample/i);
  });

  it("protects structured clocks from arbitrary writes", () => {
    expect(() => parseSpec("clock.ts", `/*
      * uneffect:
      * clock now: 0
      */`)).toThrow(/granularity must be a positive integer/);
    expect(() => parseSpec("clock.ts", `/*
      * uneffect:
      * clock now: 1
      * action rewind: now' = now - 1
      */`)).toThrow(/only generated action `tick_now` may update clock `now`/);
    expect(() => parseSpec("clock.ts", `/*
      * uneffect:
      * clock now: 1
      * init now = 10
      */`)).toThrow(/clock `now` has an implicit zero init/);
  });
});

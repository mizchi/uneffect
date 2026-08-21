import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuint, generateSmtLib } from "../src/spec-backends.js";
import { parseSpec } from "../src/spec-ir.js";
import { findTemporalCounterexampleWithZ3, lintSpec, lintSpecWithZ3, lintTemporalReachabilityWithZ3, lintTemporalSpecWithZ3 } from "../src/spec-lint.js";
import { replayModelCounterexample } from "../src/model-replay.js";

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
  it("extracts the shortest bounded Z3 trace and replays its actions", async () => {
    const temporal = parseSpec("counter.ts", `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
      temporal belowTwo: value < 2
    */`).temporal;
    const result = await findTemporalCounterexampleWithZ3(temporal, "belowTwo", { maxSteps: 4 });
    expect(result.status).toBe("counterexample");
    if (result.status !== "counterexample") return;
    expect(result.trace).toMatchObject({
      backend: "z3", initialState: { value: 0 },
      steps: [
        { action: "increment", before: { value: 0 }, after: { value: 1 } },
        { action: "increment", before: { value: 1 }, after: { value: 2 } },
      ],
    });
    const replay = await replayModelCounterexample(result.trace, {
      schema: "uneffect-refinement-adapter/v1", name: "counter", version: "1",
      create: (state) => ({ value: Number(state.value) }), observe: (runtime) => ({ value: runtime.value }),
      actions: { increment: (runtime) => { runtime.value++; } },
      invariants: { belowTwo: (runtime) => runtime.value < 2 },
    });
    expect(replay).toMatchObject({ status: "replayed", matchedSteps: 2, violations: [{ invariant: "belowTwo", step: 2 }] });
  });

  it("checks initial temporal violations and reports bounded safety honestly", async () => {
    const initiallyBroken = parseSpec("initial.ts", `/* uneffect:
      state ready: bool
      init ready = false
      temporal readyNow: ready
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(initiallyBroken, "readyNow", { maxSteps: 3 })).resolves.toMatchObject({
      status: "counterexample", depth: 0, trace: { initialState: { ready: false }, steps: [] },
    });

    const boundedSafe = parseSpec("safe.ts", `/* uneffect:
      state value: int
      init value = 0
      action increment: value' = value + 1
      temporal belowThree: value < 3
    */`).temporal;
    await expect(findTemporalCounterexampleWithZ3(boundedSafe, "belowThree", { maxSteps: 2 })).resolves.toEqual({
      status: "safe-within-bound", depth: 2,
    });
  });

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

  it("reports syntactically valid but meaningless temporal declarations", () => {
    const result = lintSpec("meaningless.ts", `/* uneffect:
      state epoch: int
      init epoch = 0
      action idle: epoch' = epoch
      temporal tautology: epoch === epoch
      temporal contradiction: epoch !== epoch
    */`);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "tautological-invariant", name: "tautology" }),
      expect.objectContaining({ code: "contradictory-invariant", name: "contradiction" }),
      expect.objectContaining({ code: "no-op-action", name: "idle" }),
    ]));
  });

  it("uses Z3 to reject semantic tautologies, contradictions, inconsistent init, unreachable guards, and subsumed properties", async () => {
    const temporal = parseSpec("semantic-lint.ts", `/* uneffect:
      state epoch: int
      state ready: bool
      init epoch = 0
      init epoch = 1
      init ready = false
      action impossible: ready' = true
      action_when impossible: epoch > 0 && epoch <= 0
      temporal totalOrder: epoch > 0 || epoch <= 0
      temporal impossibleState: epoch > 0 && epoch <= 0
      temporal positive: epoch > 0
      temporal nonnegative: epoch >= 0
      temporal positiveAgain: epoch > 0
    */`).temporal;
    const diagnostics = await lintTemporalSpecWithZ3(temporal);
    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "inconsistent-init" }),
      expect.objectContaining({ code: "solver-tautology", name: "totalOrder" }),
      expect.objectContaining({ code: "solver-contradiction", name: "impossibleState" }),
      expect.objectContaining({ code: "unreachable-action", name: "impossible" }),
      expect.objectContaining({ code: "duplicate-property", name: "positiveAgain" }),
      expect.objectContaining({ code: "subsumed-property", name: "nonnegative", relatedName: "positive" }),
    ]));
  });

  it("combines syntax and solver diagnostics from source text", async () => {
    const result = await lintSpecWithZ3("combined-lint.ts", `/* uneffect:
      state epoch: int
      init epoch = 0
      action idle: epoch' = epoch
      temporal totalOrder: epoch > 0 || epoch <= 0
    */`);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "no-op-action", name: "idle" }),
      expect.objectContaining({ code: "solver-tautology", name: "totalOrder", backend: "z3" }),
    ]));
  });

  it("distinguishes bounded transition reachability from globally satisfiable guards", async () => {
    const temporal = parseSpec("reachability.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = 1
      action_when advance: phase === 0
      action finish: phase' = 2
      action_when finish: phase === 1
      action never: phase' = 3
      action_when never: phase === 99
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 3 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "bounded-unreachable-action", name: "never", depth: 3 }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "advance" }));
    expect(diagnostics).not.toContainEqual(expect.objectContaining({ name: "finish" }));
  });

  it("proves an initial deadlock without claiming unbounded reachability", async () => {
    const temporal = parseSpec("deadlock.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action advance: phase' = 1
      action_when advance: phase > 0
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 2 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "deadlocked-initial-state", name: "<init>" }));
  });

  it("detects models whose enabled initial transitions cannot change state", async () => {
    const temporal = parseSpec("stuttering.ts", `/* uneffect:
      state phase: int
      init phase = 0
      action idle: phase' = phase
      temporal fixed: phase === 0
    */`).temporal;
    const diagnostics = await lintTemporalReachabilityWithZ3(temporal, { maxSteps: 1 });
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "no-state-progress-from-init", name: "<init>" }));
  });

  it("does not treat a source file without a temporal model as a deadlocked model", async () => {
    const result = await lintSpecWithZ3("plain.ts", `export function add(a: number, b: number) { return a + b }`);
    expect(result.diagnostics).toEqual([]);
  });
});

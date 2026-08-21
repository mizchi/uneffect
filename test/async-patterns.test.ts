import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAsyncPatterns, generateAsyncPatternsQuint } from "../src/async-patterns.js";

const source = `
  function poll() { setTimeout(poll, 5) }
  async function load() { return Promise.all([readUsers(), readPosts()]) }
  async function readUsers() { return [] }
  async function readPosts() { return [] }
`;

function run(program: string, invariant: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-async-patterns-"));
  const path = join(directory, "model.qnt");
  writeFileSync(path, program);
  return spawnSync("pnpm", ["exec", "quint", "run", path,
    `--invariant=${invariant}`, "--max-steps=12", "--max-samples=500",
    "--seed=0x123456789abcdef", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
}

describe("builtin async temporal patterns", () => {
  it("extracts a recursive timeout and Promise.all fork/join by builtin symbol", () => {
    expect(analyzeAsyncPatterns("patterns.ts", source)).toMatchObject({
      timers: [{ owner: "poll", callback: "poll", delay: 5, recursive: true }],
      combinators: [{ owner: "load", combinator: "all", branches: ["readUsers()", "readPosts()"] }],
    });
    expect(analyzeAsyncPatterns("shadowed.ts", `
      function setTimeout() {}
      const Promise = { all() {} }
      function f() { setTimeout(f, 1); Promise.all([f()]) }
    `)).toEqual({ timers: [], combinators: [], cancellations: [] });
    expect(() => generateAsyncPatternsQuint("dynamic", analyzeAsyncPatterns("dynamic.ts", `
      function schedule(delay: number) { setTimeout(() => {}, delay) }
    `))).toThrow(/static non-negative delay/);
  });

  it("prevents early timer firing and premature Promise.all fulfillment", () => {
    const model = analyzeAsyncPatterns("patterns.ts", source);
    const positive = run(generateAsyncPatternsQuint("async_patterns", model), "asyncSafe");
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    expect(positive.stdout + positive.stderr).toContain("No violation found");

    const earlyTimer = run(generateAsyncPatternsQuint("early_timer", model, { allowEarlyTimer: true }), "asyncSafe");
    expect(earlyTimer.status).not.toBe(0);
    expect(earlyTimer.stdout + earlyTimer.stderr).toMatch(/violation|counterexample/i);

    const earlyJoin = run(generateAsyncPatternsQuint("early_join", model, { allowEarlyJoin: true }), "asyncSafe");
    expect(earlyJoin.status).not.toBe(0);
    expect(earlyJoin.stdout + earlyJoin.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);

  it("models timer cancellation and drains microtasks before timers", () => {
    const model = analyzeAsyncPatterns("event-loop.ts", `
      function job() {}
      function schedule() {
        const handle = setTimeout(job, 0)
        queueMicrotask(job)
        clearTimeout(handle)
        setTimeout(job, 0)
      }
    `);
    expect(model).toMatchObject({
      timers: [
        { owner: "schedule", callback: "job", handle: "handle", queue: "timer" },
        { owner: "schedule", callback: "job", queue: "microtask" },
        { owner: "schedule", callback: "job", queue: "timer" },
      ],
      cancellations: [{ owner: "schedule", handle: "handle", timer: 0, definite: true }],
    });
    const positive = run(generateAsyncPatternsQuint("event_loop", model), "asyncSafe");
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    const cancelledFire = run(generateAsyncPatternsQuint("cancel_broken", model, { allowFireAfterCancel: true }), "asyncSafe");
    expect(cancelledFire.status).not.toBe(0);
    expect(cancelledFire.stdout + cancelledFire.stderr).toMatch(/violation|counterexample/i);

    const macroFirst = run(generateAsyncPatternsQuint("queue_broken", model, { allowMacroBeforeMicrotask: true }), "asyncSafe");
    expect(macroFirst.status).not.toBe(0);
    expect(macroFirst.stdout + macroFirst.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);

  it("retains await/catch context and rejects unsound dynamic Promise.all inputs", () => {
    const model = analyzeAsyncPatterns("awaited.ts", `
      declare function a(): Promise<number>
      declare function b(): Promise<number>
      async function load() {
        try { await Promise.all([a(), b()]) } catch {}
      }
      async function empty() { await Promise.all([]) }
    `);
    expect(model.combinators).toMatchObject([
      { owner: "load", combinator: "all", branches: ["a()", "b()"], staticIterable: true, awaited: true, catchesRejection: true },
      { owner: "empty", combinator: "all", branches: [], staticIterable: true, awaited: true, catchesRejection: false },
    ]);
    expect(generateAsyncPatternsQuint("empty", { timers: [], cancellations: [], combinators: [model.combinators[1]!] }))
      .toContain("action fulfill_join_0");
    expect(generateAsyncPatternsQuint("caught", { timers: [], cancellations: [], combinators: [model.combinators[0]!] }))
      .toContain("join_0_rejection_escapes' = false");
    expect(() => generateAsyncPatternsQuint("dynamic", analyzeAsyncPatterns("dynamic-all.ts", `
      async function load(items: Promise<number>[]) { return Promise.all(items) }
    `))).toThrow(/Promise\.all model requires an array literal/);

    const spurious = run(generateAsyncPatternsQuint("spurious_reject", { ...model, combinators: [model.combinators[0]!] }, { allowSpuriousReject: true }), "asyncSafe");
    expect(spurious.status).not.toBe(0);
    expect(spurious.stdout + spurious.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);

  it("models allSettled, race, and any including their empty-input behavior", () => {
    const model = analyzeAsyncPatterns("combinators.ts", `
      declare const a: Promise<number>
      declare const b: Promise<number>
      async function combinations() {
        await Promise.allSettled([a, b])
        await Promise.race([a, b])
        await Promise.any([a, b])
        await Promise.allSettled([])
        await Promise.race([])
        await Promise.any([])
      }
    `);
    expect(model.combinators.map((item) => [item.combinator, item.branches.length])).toEqual([
      ["allSettled", 2], ["race", 2], ["any", 2],
      ["allSettled", 0], ["race", 0], ["any", 0],
    ]);
    const program = generateAsyncPatternsQuint("combinators", model);
    expect(program).toContain("action fulfill_join_3");
    expect(program).toContain("false,\n    clock' = clock"); // race([]) has no settlement transition enabled
    expect(program).toContain("action reject_join_5");
    expect(program).toMatch(/action fulfill_1_0[\s\S]*join_1_result' = 1/);
    const positive = run(program, "asyncSafe");
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    const invalid = run(generateAsyncPatternsQuint("invalid_combinators", model, { allowEarlyJoin: true, allowSpuriousReject: true }), "asyncSafe");
    expect(invalid.status).not.toBe(0);
    expect(invalid.stdout + invalid.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);
});

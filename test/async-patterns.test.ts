import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeAsyncPatterns, analyzeAsyncPatternsInProgram, generateAsyncPatternsQuint, generateWebEventLoopQuint } from "../src/async-patterns.js";
import { analyzePromiseChains } from "../src/promise-chains.js";

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

  it("models the web task, microtask checkpoint, animation frame, and paint phases", () => {
    const model = analyzeAsyncPatterns("web-loop.ts", `
      function job() {}
      function schedule() {
        setTimeout(job, 0)
        setInterval(job, 10)
        queueMicrotask(job)
        const frame = requestAnimationFrame(job)
        cancelAnimationFrame(frame)
      }
    `);
    expect(model.timers.map(({ queue, repeats }) => ({ queue, repeats }))).toEqual([
      { queue: "timer", repeats: false },
      { queue: "timer", repeats: true },
      { queue: "microtask", repeats: false },
      { queue: "animation-frame", repeats: false },
    ]);
    expect(model.cancellations).toContainEqual(expect.objectContaining({ handle: "frame", timer: 3, definite: true }));
    const quint = generateWebEventLoopQuint("web_loop", model);
    expect(quint).toContain("action drain_microtask_2");
    expect(quint).toContain("action run_animation_frame_3");
    expect(quint).toContain("action paint");
    expect(quint).toContain("callback_3_pending' = false");
    expect(run(quint, "eventLoopSafe").status).toBe(0);
    expect(run(generateWebEventLoopQuint("web_loop_broken", model, { allowWrongPhase: true }), "eventLoopSafe").status).not.toBe(0);
  }, 20_000);

  it("drains Promise reaction jobs in the same checkpoint as queueMicrotask", () => {
    const source = `
      function job() {}
      function schedule() {
        const pending = new Promise<number>((resolve) => resolve(1))
        pending.then(value => value + 1).finally(job)
        queueMicrotask(job)
        setTimeout(job, 0)
      }
    `;
    const patterns = analyzeAsyncPatterns("promise-microtasks.ts", source), chains = analyzePromiseChains("promise-microtasks.ts", source);
    const quint = generateWebEventLoopQuint("promise_microtasks", patterns, {}, chains);
    expect(quint).toContain("action drain_promise_reaction_0_0");
    expect(quint).toContain("action drain_promise_reaction_0_1");
    expect(quint).toMatch(/action finish_microtask_checkpoint[\s\S]*not\(promise_reaction_0_0_pending\)[\s\S]*not\(promise_reaction_0_1_pending\)/);
    expect(quint).toContain("promise_reaction_0_1_ticket' = next_microtask_ticket");
    expect(run(quint, "eventLoopSafe").status).toBe(0);
    const outOfOrder = generateWebEventLoopQuint("promise_microtasks_broken", patterns, { allowOutOfOrderMicrotasks: true }, chains);
    expect(run(outOfOrder, "eventLoopSafe").status).not.toBe(0);
  }, 10_000);

  it("dynamically enqueues queueMicrotask calls found in inline callbacks", () => {
    const model = analyzeAsyncPatterns("nested-microtasks.ts", `
      function job() {}
      function schedule() {
        queueMicrotask(() => { queueMicrotask(job) })
        setTimeout(job, 0)
        requestAnimationFrame(() => { queueMicrotask(job) })
      }
    `);
    expect(model.timers).toMatchObject([
      { queue: "microtask" },
      { queue: "microtask", enqueuedBy: 0 },
      { queue: "timer" },
      { queue: "animation-frame" },
      { queue: "microtask", enqueuedBy: 3 },
    ]);
    const quint = generateWebEventLoopQuint("nested_microtasks", model);
    expect(quint).toContain("callback_1_pending' = false");
    expect(quint).toMatch(/action drain_microtask_0[\s\S]*callback_1_pending' = true[\s\S]*callback_1_ticket' = next_microtask_ticket/);
    expect(quint).toMatch(/action run_animation_frame_3[\s\S]*phase' = 1[\s\S]*callback_4_pending' = true/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
  }, 10_000);

  it("resolves named timer callback bodies and dynamically enqueues their microtasks", () => {
    const model = analyzeAsyncPatterns("named-callback.ts", `
      function job() {}
      function onTimer() { queueMicrotask(job) }
      export function schedule() { setTimeout(onTimer, 0) }
    `);
    expect(model.timers).toEqual([
      expect.objectContaining({ callback: "onTimer", queue: "timer" }),
      expect.objectContaining({ callback: "job", queue: "microtask", enqueuedBy: 0 }),
    ]);
    const quint = generateWebEventLoopQuint("named_callback", model);
    expect(quint).toMatch(/action run_timer_task_0[\s\S]*callback_1_pending' = true[\s\S]*callback_1_ticket' = next_microtask_ticket/);
  });

  it("resolves an imported scheduled callback through TypeChecker identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-named-callback-"));
    try {
      const handlers = join(directory, "handlers.ts"), main = join(directory, "main.ts");
      writeFileSync(handlers, `export function onTimer() { queueMicrotask(() => {}) }`);
      writeFileSync(main, `import { onTimer as handler } from "./handlers.js"; export function schedule() { setTimeout(handler, 0) }`);
      const program = ts.createProgram([main, handlers], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts", "lib.dom.d.ts"], noEmit: true,
      });
      const model = analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!);
      expect(model.timers).toEqual([
        expect.objectContaining({ callback: "handler", queue: "timer" }),
        expect.objectContaining({ queue: "microtask", enqueuedBy: 0 }),
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

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

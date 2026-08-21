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
      combinators: [{ owner: "load", combinator: "all", branches: ["readUsers()", "readPosts()"], branchKinds: ["thenable", "thenable"] }],
    });
    expect(analyzeAsyncPatterns("shadowed.ts", `
      function setTimeout() {}
      const Promise = { all() {} }
      function f() { setTimeout(f, 1); Promise.all([f()]) }
    `)).toEqual({ timers: [], combinators: [], cancellations: [], abortCompositions: [], timerEscapes: [] });
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

  it("resolves reassignment-free timer handle aliases for cancellation", () => {
    const model = analyzeAsyncPatterns("timer-alias.ts", `
      function job() {}
      function schedule() {
        const handle = setTimeout(job, 10)
        const alias = handle
        const forwarded = alias
        clearTimeout(forwarded)
      }
    `);
    expect(model.cancellations).toContainEqual(expect.objectContaining({ handle: "handle", timer: 0, definite: true }));
    expect(generateWebEventLoopQuint("timer_alias", model)).toContain("callback_0_pending' = false");
  });

  it("keeps timer identity through aliases when the source binding is reassigned", () => {
    const model = analyzeAsyncPatterns("timer-reassignment.ts", `
      function job() {}
      function schedule() {
        let handle = setTimeout(job, 10)
        const first = handle
        handle = setTimeout(job, 20)
        clearTimeout(first)
        clearTimeout(handle)
      }
    `);
    expect(model.timers.map((timer) => timer.handle)).toEqual(["handle", "handle"]);
    expect(model.cancellations).toEqual([
      expect.objectContaining({ handle: "handle", timer: 0, definite: true }),
      expect.objectContaining({ handle: "handle", timer: 1, definite: true }),
    ]);
  });

  it("models timer handles escaping by argument, property storage, and return", () => {
    const model = analyzeAsyncPatterns("timer-escape.ts", `
      declare function register(value: unknown): void
      const registry: { timer?: ReturnType<typeof setTimeout> } = {}
      function schedule() {
        const handle = setTimeout(() => {}, 10)
        const alias = handle
        register(alias)
        registry.timer = handle
        return handle
      }
    `);
    expect(model.timerEscapes).toEqual([
      expect.objectContaining({ kind: "argument", handle: "handle", timer: 0 }),
      expect.objectContaining({ kind: "property", handle: "handle", timer: 0 }),
      expect.objectContaining({ kind: "return", handle: "handle", timer: 0 }),
    ]);
    const quint = generateWebEventLoopQuint("timer_escape", model);
    expect(quint).toContain("action external_cancel_timer_0");
    expect(quint).toMatch(/action external_cancel_timer_0[\s\S]*callback_0_pending' = false/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
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

  it("models AbortSignal.timeout as a one-shot timer-source abort task", () => {
    const model = analyzeAsyncPatterns("abort-timeout.ts", `
      async function request() {
        const signal = AbortSignal.timeout(50)
        return fetch("/slow", { signal })
      }
    `);
    expect(model.timers).toEqual([
      expect.objectContaining({ owner: "request", callback: "<abort>", delay: 50, repeats: false, queue: "timer", kind: "abort-timeout", abortReason: "TimeoutError", handle: "signal" }),
    ]);
    const quint = generateWebEventLoopQuint("abort_timeout", model);
    expect(quint).toContain("action run_abort_timeout_task_0");
    expect(quint).toMatch(/action run_abort_timeout_task_0[\s\S]*clock >= callback_0_due/);
    expect(quint).toContain("callback_0_fires <= 1");
    const positive = run(quint, "eventLoopSafe");
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    expect(analyzeAsyncPatterns("shadow-abort.ts", `
      class AbortSignal { static timeout(_ms: number) { return {} } }
      function request() { return AbortSignal.timeout(50) }
    `).timers).toEqual([]);
    expect(() => generateWebEventLoopQuint("invalid_abort_timeout", analyzeAsyncPatterns("invalid-abort.ts", `
      function request() { return AbortSignal.timeout(9007199254740992) }
    `))).toThrow(/exceeds Number\.MAX_SAFE_INTEGER/);
  }, 20_000);

  it("composes AbortSignal.any with first-abort reason semantics", () => {
    const model = analyzeAsyncPatterns("abort-any.ts", `
      function request(controller: AbortController) {
        const already = AbortSignal.abort(new Error("pre-aborted"))
        const early = AbortSignal.any([already, AbortSignal.timeout(100)])
        const timeout = AbortSignal.timeout(50)
        const combined = AbortSignal.any([controller.signal, timeout])
        return { early, combined }
      }
    `);
    expect(model.abortCompositions).toEqual([
      expect.objectContaining({ handle: "early", sources: ["already", "AbortSignal.timeout(100)"], initiallyAbortedSource: 0 }),
      expect.objectContaining({ handle: "combined", sources: ["controller.signal", "timeout"], sourceTimers: [undefined, 1] }),
    ]);
    const quint = generateWebEventLoopQuint("abort_any", model);
    expect(quint).toContain("abort_0_aborted' = true");
    expect(quint).toContain("abort_0_reason_source' = 1");
    expect(quint).toContain("action abort_1_from_timer_1");
    expect(quint).toContain("action abort_1_from_external_0");
    expect(run(quint, "eventLoopSafe").status).toBe(0);
    expect(run(generateWebEventLoopQuint("abort_any_broken", model, { allowAbortReasonOverwrite: true }), "eventLoopSafe").status).not.toBe(0);

    expect(analyzeAsyncPatterns("shadow-abort-any.ts", `
      class AbortSignal { static any(_signals: unknown[]) { return {} } }
      function request() { return AbortSignal.any([]) }
    `).abortCompositions).toEqual([]);
  }, 20_000);

  it("orders eligible scheduler.postTask callbacks by static priority and FIFO", () => {
    const model = analyzeAsyncPatterns("scheduler-tasks.ts", `
      function background() {}
      function visibleA() {}
      function visibleB() {}
      function blocking() {}
      function schedule() {
        const cancelled = AbortSignal.abort("cancelled")
        scheduler.postTask(background, { priority: "background" })
        scheduler.postTask(visibleA)
        scheduler.postTask(visibleB, { priority: "user-visible" })
        scheduler.postTask(blocking, { priority: "user-blocking", delay: 5 })
        scheduler.postTask(() => {}, { signal: cancelled })
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "scheduler-post-task", callback: "background", queue: "scheduler-task", priority: "background", delay: 0 },
      { kind: "scheduler-post-task", callback: "visibleA", queue: "scheduler-task", priority: "user-visible", delay: 0 },
      { kind: "scheduler-post-task", callback: "visibleB", queue: "scheduler-task", priority: "user-visible", delay: 0 },
      { kind: "scheduler-post-task", callback: "blocking", queue: "scheduler-task", priority: "user-blocking", delay: 5 },
      { kind: "scheduler-post-task", queue: "scheduler-task", priority: "user-visible", delay: 0, initiallyCancelled: true },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_tasks", model);
    expect(quint).toContain("action run_scheduler_task_1");
    expect(quint).toMatch(/action run_scheduler_task_2[\s\S]*not\(\(callback_1_pending and callback_1_due <= clock\)/);
    expect(quint).toMatch(/action run_scheduler_task_0[\s\S]*callback_1_pending and callback_1_due <= clock/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
    expect(run(generateWebEventLoopQuint("scheduler_tasks_broken", model, { allowWrongSchedulerPriority: true }), "eventLoopSafe").status).not.toBe(0);
    expect(() => generateWebEventLoopQuint("dynamic_scheduler", analyzeAsyncPatterns("dynamic-scheduler.ts", `
      function schedule(signal: TaskSignal) { scheduler.postTask(() => {}, { signal }) }
    `))).toThrow(/requires a static priority/);
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
    expect(generateAsyncPatternsQuint("empty", { timers: [], cancellations: [], abortCompositions: [], timerEscapes: [], combinators: [model.combinators[1]!] }))
      .toContain("action fulfill_join_0");
    expect(generateAsyncPatternsQuint("caught", { timers: [], cancellations: [], abortCompositions: [], timerEscapes: [], combinators: [model.combinators[0]!] }))
      .toContain("join_0_rejection_escapes' = false");
    expect(() => generateAsyncPatternsQuint("dynamic", analyzeAsyncPatterns("dynamic-all.ts", `
      async function load(items: Promise<number>[]) { return Promise.all(items) }
    `))).toThrow(/Promise\.all model requires a statically bounded iterable/);

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
    expect(model.combinators[2]).toMatchObject({ aggregateErrorOrder: [0, 1] });
    expect(model.combinators[5]).toMatchObject({ aggregateErrorOrder: [] });
    const program = generateAsyncPatternsQuint("combinators", model);
    expect(program).toContain("val join_2_aggregate_error_count = 2");
    expect(program).toContain("val join_2_aggregate_error_slot_0 = 0");
    expect(program).toContain("val join_2_aggregate_error_slot_1 = 1");
    expect(program).toContain("val join_5_aggregate_error_count = 0");
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

  it("treats sparse holes as fulfilled undefined values and assimilates thenables", () => {
    const model = analyzeAsyncPatterns("iterable-elements.ts", `
      declare const remote: PromiseLike<number>
      declare const dynamic: PromiseLike<number>[]
      async function load() {
        await Promise.all([1, , remote])
        await Promise.all([...([remote])])
        await Promise.all([...dynamic])
      }
    `);
    expect(model.combinators).toMatchObject([
      {
        branches: ["1", "<hole>", "remote"],
        branchKinds: ["value", "value", "thenable"],
        staticIterable: true,
      },
      { branches: ["remote"], branchKinds: ["thenable"], staticIterable: true },
      { staticIterable: false },
    ]);
    const quint = generateAsyncPatternsQuint("iterable_elements", {
      timers: [], cancellations: [], abortCompositions: [], timerEscapes: [], combinators: [model.combinators[0]!],
    });
    expect(quint).toContain("action fulfill_0_0");
    expect(quint).not.toContain("action reject_0_0");
    expect(quint).toContain("action fulfill_0_1");
    expect(quint).not.toContain("action reject_0_1");
    expect(quint).toContain("action assimilate_0_2");
    expect(quint).toMatch(/action fulfill_0_2[\s\S]*join_0_branch_2 == 3/);
    expect(quint).toContain("action reject_0_2");
    const positive = run(quint, "asyncSafe");
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    const spread = generateAsyncPatternsQuint("spread", {
      timers: [], cancellations: [], abortCompositions: [], timerEscapes: [], combinators: [model.combinators[1]!],
    });
    expect(spread).toContain("action assimilate_0_0");
    expect(() => generateAsyncPatternsQuint("dynamic_spread", {
      timers: [], cancellations: [], abortCompositions: [], timerEscapes: [], combinators: [model.combinators[2]!],
    })).toThrow(/requires a statically bounded iterable/);
  }, 20_000);

  it("models local iterator acquisition and generator step failures", () => {
    const model = analyzeAsyncPatterns("iterator-failures.ts", `
      const broken = {
        [Symbol.iterator]() { throw new Error("acquire") }
      }
      function* values() {
        yield Promise.resolve(1)
        throw new Error("step")
      }
      async function load() {
        try { await Promise.allSettled(broken) } catch {}
        try { await Promise.any(values()) } catch {}
      }
    `);
    expect(model.combinators).toMatchObject([
      { combinator: "allSettled", staticIterable: true, iteratorFailure: "acquire", branches: [] },
      { combinator: "any", staticIterable: true, iteratorFailure: "step", branches: ["Promise.resolve(1)"] },
    ]);
    const quint = generateAsyncPatternsQuint("iterator_failures", model);
    expect(quint).toContain("action fail_iterator_0");
    expect(quint).toContain("action fail_iterator_1");
    expect(quint).toMatch(/action fail_iterator_0[\s\S]*join_0_result' = 2/);
    expect(quint).toMatch(/action fail_iterator_1[\s\S]*join_1_result' = 2/);
    const step = quint.slice(quint.indexOf("action step"), quint.indexOf("val asyncSafe"));
    expect(step).not.toContain("fulfill_join_0");
    expect(step).not.toContain("fulfill_join_1");
    expect(step).not.toContain("fulfill_1_0");
    expect(run(quint, "asyncSafe").status).toBe(0);
  }, 20_000);
});

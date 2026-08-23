import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzeAsyncPatterns, analyzeAsyncPatternsInProgram, generateAsyncPatternsQuint, generateNodeEventLoopQuint, generateWebEventLoopQuint } from "../src/async-patterns.js";
import { analyzeEffects } from "../src/effects.js";
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

  it("does not discharge cancellation with an incompatible timer API family", () => {
    const model = analyzeAsyncPatterns("timer-family.ts", `
      function schedule() {
        const timeout = setTimeout(() => {}, 10)
        const immediate = setImmediate(() => {})
        clearImmediate(timeout)
        clearTimeout(immediate)
      }
    `);
    expect(model.timers).toMatchObject([
      { handle: "timeout", handleFamily: "timeout" },
      { handle: "immediate", handleFamily: "immediate" },
    ]);
    expect(model.cancellations).toMatchObject([
      { handle: "timeout", clearFamily: "immediate", compatible: false, timer: undefined },
      { handle: "immediate", clearFamily: "timeout", compatible: false, timer: undefined },
    ]);
    const quint = generateNodeEventLoopQuint("timer_family", model);
    expect(quint).toMatch(/callback_0_pending' = true/);
    expect(quint).toMatch(/callback_1_pending' = true/);
  });

  it("links clearImmediate only to an Immediate handle", () => {
    const model = analyzeAsyncPatterns("clear-immediate.ts", `
      function schedule() {
        const immediate = setImmediate(() => {})
        clearImmediate(immediate)
      }
    `);
    expect(model.cancellations).toContainEqual(expect.objectContaining({
      handle: "immediate", timer: 0, clearFamily: "immediate", compatible: true, definite: true,
    }));
    expect(generateNodeEventLoopQuint("clear_immediate", model)).toMatch(/callback_0_pending' = false/);
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

  it("tracks timer handles escaping through aggregates and returned closures", () => {
    const model = analyzeAsyncPatterns("aggregate-timer-escape.ts", `
      declare function register(value: unknown): void
      const registry: { value?: unknown } = {}
      function schedule() {
        const argumentHandle = setTimeout(() => {}, 10)
        const propertyHandle = setTimeout(() => {}, 20)
        const returnHandle = setTimeout(() => {}, 30)
        const closureHandle = setTimeout(() => {}, 40)
        register({ nested: [argumentHandle] })
        registry.value = { propertyHandle }
        if (Date.now() > 0) return { returnHandle }
        return () => clearTimeout(closureHandle)
      }
    `);
    expect(model.timerEscapes).toEqual([
      expect.objectContaining({ kind: "argument", handle: "argumentHandle", timer: 0 }),
      expect.objectContaining({ kind: "property", handle: "propertyHandle", timer: 1 }),
      expect.objectContaining({ kind: "return", handle: "returnHandle", timer: 2 }),
      expect.objectContaining({ kind: "closure", handle: "closureHandle", timer: 3 }),
    ]);
    const quint = generateWebEventLoopQuint("aggregate_timer_escape", model);
    for (const timer of [0, 1, 2, 3]) expect(quint).toContain(`action external_cancel_timer_${timer}`);
  });

  it("resolves local aggregate and closure bindings when timer handles escape", () => {
    const model = analyzeAsyncPatterns("bound-timer-escape.ts", `
      declare function register(value: unknown): void
      function schedule() {
        const aggregateHandle = setTimeout(() => {}, 10)
        const closureHandle = setTimeout(() => {}, 20)
        const bundle = { nested: [aggregateHandle] }
        const cancel = () => clearTimeout(closureHandle)
        register(bundle)
        return cancel
      }
    `);
    expect(model.timerEscapes).toEqual([
      expect.objectContaining({ kind: "argument", handle: "aggregateHandle", timer: 0 }),
      expect.objectContaining({ kind: "closure", handle: "closureHandle", timer: 1 }),
    ]);
  });

  it("retains the TypeScript-visible Node and browser timer handle domains", () => {
    const model = analyzeAsyncPatterns("timer-handle-domains.ts", `
      function schedule() {
        const timeout = setTimeout(() => {}, 10)
        const frame = requestAnimationFrame(() => {})
        return { timeout, frame }
      }
    `);
    expect(model.timers).toMatchObject([
      { handle: "timeout", handleKind: "object" },
      { handle: "frame", handleKind: "number" },
    ]);
  });

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

  it("links an inline AbortSignal.timeout source into AbortSignal.any", () => {
    const model = analyzeAsyncPatterns("inline-abort-timeout.ts", `
      function request(controller: AbortController) {
        return AbortSignal.any([controller.signal, AbortSignal.timeout(25)])
      }
    `);
    expect(model.timers).toEqual([
      expect.objectContaining({ kind: "abort-timeout", delay: 25, callback: "<abort>" }),
    ]);
    expect(model.abortCompositions).toEqual([
      expect.objectContaining({
        sources: ["controller.signal", "AbortSignal.timeout(25)"],
        sourceTimers: [undefined, 0],
        sourceReasons: [undefined, "TimeoutError"],
      }),
    ]);
    const quint = generateWebEventLoopQuint("inline_abort_timeout", model);
    expect(quint).toContain("action abort_0_from_timer_0");
    expect(run(quint, "eventLoopSafe").status).toBe(0);
  }, 20_000);

  it("preserves inline pre-aborted source order in AbortSignal.any", () => {
    const model = analyzeAsyncPatterns("inline-pre-aborted.ts", `
      function request() {
        return AbortSignal.any([
          AbortSignal.abort("first"),
          AbortSignal.abort("second"),
          AbortSignal.timeout(25),
        ])
      }
    `);
    expect(model.abortCompositions).toEqual([
      expect.objectContaining({
        initiallyAbortedSource: 0,
        sourceReasons: ['"first"', '"second"', "TimeoutError"],
        sourceTimers: [undefined, undefined, 0],
      }),
    ]);
    const quint = generateWebEventLoopQuint("inline_pre_aborted", model);
    expect(quint).toMatch(/abort_0_aborted' = true[\s\S]*abort_0_reason_source' = 1/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
  }, 20_000);

  it("propagates abort from one local AbortSignal.any composition into another", () => {
    const model = analyzeAsyncPatterns("nested-abort-any.ts", `
      function request(controller: AbortController) {
        const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(25)])
        const combined = AbortSignal.any([deadline, AbortSignal.timeout(50)])
        return combined
      }
    `);
    expect(model.abortCompositions).toMatchObject([
      { handle: "deadline", sourceCompositions: [undefined, undefined], sourceTimers: [undefined, 0] },
      { handle: "combined", sourceCompositions: [0, undefined], sourceTimers: [undefined, 1] },
    ]);
    const quint = generateWebEventLoopQuint("nested_abort_any", model);
    expect(quint).toMatch(/action abort_1_from_composition_0[\s\S]*abort_0_aborted/);
    expect(quint).toMatch(/action abort_1_from_composition_0[\s\S]*abort_1_reason_source' = 1/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
    expect(run(generateWebEventLoopQuint("nested_abort_any_broken", model, {
      allowEarlyAbortComposition: true,
    }), "eventLoopSafe").status).not.toBe(0);
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
    expect(quint).toMatch(/action run_scheduler_task_2[\s\S]*callback_1_pending and callback_1_due <= clock and \(1 > 1 or \(1 == 1 and 1 < 2\)\)/);
    expect(quint).toMatch(/action run_scheduler_task_0[\s\S]*callback_1_pending and callback_1_due <= clock and \(1 > 0/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
    expect(run(generateWebEventLoopQuint("scheduler_tasks_broken", model, { allowWrongSchedulerPriority: true }), "eventLoopSafe").status).not.toBe(0);
    expect(() => generateWebEventLoopQuint("dynamic_scheduler", analyzeAsyncPatterns("dynamic-scheduler.ts", `
      function schedule(signal: TaskSignal) { scheduler.postTask(() => {}, { signal }) }
    `))).toThrow(/requires a static priority/);
  }, 20_000);

  it("applies ordered TaskController reprioritization before a queued task runs", () => {
    const model = analyzeAsyncPatterns("scheduler-reprioritize.ts", `
      function schedule() {
        const controller = new TaskController({ priority: "user-blocking" })
        scheduler.postTask(async () => { await scheduler.yield() }, { signal: controller.signal })
        scheduler.postTask(() => {}, { priority: "user-visible" })
        controller.setPriority("background")
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "scheduler-post-task", priority: "user-blocking", priorityMutable: true, priorityChanges: ["background"] },
      { kind: "scheduler-yield", priority: "background", priorityMutable: true, enqueuedBy: 0 },
      { kind: "scheduler-post-task", priority: "user-visible" },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_reprioritize", model);
    expect(quint).toContain("var callback_0_priority: int");
    expect(quint).toContain("action reprioritize_scheduler_task_0_0");
    expect(quint).toMatch(/action reprioritize_scheduler_task_0_0[\s\S]*callback_0_priority' = 0/);
    expect(quint).toMatch(/action run_scheduler_task_0[\s\S]*callback_0_priority_step == 1/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
  }, 20_000);

  it("keeps an explicit postTask priority immutable when a TaskSignal is also present", () => {
    const model = analyzeAsyncPatterns("scheduler-fixed-priority.ts", `
      function schedule() {
        const controller = new TaskController({ priority: "user-blocking" })
        scheduler.postTask(() => {}, { signal: controller.signal, priority: "user-visible" })
        controller.setPriority("background")
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "scheduler-post-task", priority: "user-visible", priorityMutable: undefined, priorityChanges: undefined },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_fixed_priority", model);
    expect(quint).not.toContain("reprioritize_scheduler_task_0");
    expect(quint).not.toContain("callback_0_priority:");
  });

  it("models scheduler.yield as a continuation inheriting its postTask priority", () => {
    const model = analyzeAsyncPatterns("scheduler-yield.ts", `
      async function topLevel() { await scheduler.yield() }
      function schedule() {
        return scheduler.postTask(async () => {
          await scheduler.yield()
        }, { priority: "background" })
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "scheduler-yield", queue: "scheduler-task", priority: "user-visible", callback: "<continuation>" },
      { kind: "scheduler-post-task", queue: "scheduler-task", priority: "background" },
      { kind: "scheduler-yield", queue: "scheduler-task", priority: "background", enqueuedBy: 1, callback: "<continuation>" },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_yield", model);
    expect(quint).toMatch(/action init[\s\S]*callback_2_pending' = false/);
    expect(quint).toMatch(/action run_scheduler_task_1[\s\S]*callback_2_pending' = true/);
    expect(quint).toContain("action run_scheduler_yield_2");
    expect(run(quint, "eventLoopSafe").status).toBe(0);
  }, 20_000);

  it("cancels scheduler tasks and inherited yield continuations from their signal", () => {
    const model = analyzeAsyncPatterns("scheduler-signal.ts", `
      function schedule(external: AbortSignal) {
        const signal = AbortSignal.any([external, AbortSignal.timeout(0)])
        return scheduler.postTask(async () => {
          await scheduler.yield()
        }, { signal, priority: "background" })
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "abort-timeout", delay: 0 },
      { kind: "scheduler-post-task", abortComposition: 0, priority: "background" },
      { kind: "scheduler-yield", abortComposition: 0, priority: "background", enqueuedBy: 1 },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_signal", model);
    expect(quint).toContain("action cancel_scheduler_task_1_from_composition_0");
    expect(quint).toContain("action cancel_scheduler_task_2_from_composition_0");
    expect(quint).toMatch(/action run_scheduler_task_1[\s\S]*not\(abort_0_aborted\)/);
    expect(quint).toMatch(/action run_scheduler_yield_2[\s\S]*not\(abort_0_aborted\)/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
    expect(run(generateWebEventLoopQuint("scheduler_signal_broken", model, {
      allowRunAbortedSchedulerTask: true,
    }), "eventLoopSafe").status).not.toBe(0);
  }, 20_000);

  it("cancels a scheduler task directly from a named timeout signal", () => {
    const model = analyzeAsyncPatterns("scheduler-timeout.ts", `
      function schedule() {
        const timeout = AbortSignal.timeout(5)
        return scheduler.postTask(() => {}, { signal: timeout })
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "abort-timeout", delay: 5 },
      { kind: "scheduler-post-task", abortTimer: 0 },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_timeout", model);
    expect(quint).toContain("action cancel_scheduler_task_1_from_timer_0");
    expect(quint).toMatch(/action run_scheduler_task_1[\s\S]*not\(callback_0_fires > 0\)/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
  }, 20_000);

  it("keeps a direct external AbortSignal as a nondeterministic cancellation source", () => {
    const model = analyzeAsyncPatterns("scheduler-external-signal.ts", `
      function schedule(signal: AbortSignal) {
        return scheduler.postTask(async () => { await scheduler.yield() }, { signal, priority: "background" })
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "scheduler-post-task", externalAbortSignal: true, priority: "background" },
      { kind: "scheduler-yield", externalAbortSignal: true, priority: "background", enqueuedBy: 0 },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_external_signal", model);
    expect(quint).toContain("var callback_0_external_aborted: bool");
    expect(quint).toContain("var callback_1_external_aborted: bool");
    expect(quint).toContain("action cancel_scheduler_task_0_from_external_signal");
    expect(quint).toContain("action cancel_scheduler_task_1_from_external_signal");
    expect(quint).toMatch(/action cancel_scheduler_task_0_from_external_signal[\s\S]*callback_0_pending' = false[\s\S]*callback_0_external_aborted' = true/);
    expect(run(quint, "eventLoopSafe").status).toBe(0);
  }, 20_000);

  it("resolves a timeout signal returned by a direct source factory", () => {
    const model = analyzeAsyncPatterns("scheduler-signal-factory.ts", `
      function makeDeadline() { return AbortSignal.timeout(7) }
      function schedule() {
        const signal = makeDeadline()
        return scheduler.postTask(() => {}, { signal, priority: "background" })
      }
    `);
    expect(model.timers).toMatchObject([
      { kind: "abort-timeout", delay: 7 },
      { kind: "scheduler-post-task", abortTimer: 0, externalAbortSignal: false },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_signal_factory", model);
    expect(quint).toContain("action cancel_scheduler_task_1_from_timer_0");
    expect(quint).not.toContain("cancel_scheduler_task_1_from_external_signal");
  });

  it("resolves a timeout signal returned by an imported source factory", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-signal-factory-"));
    try {
      const factory = join(directory, "factory.ts"), main = join(directory, "main.ts");
      writeFileSync(factory, `export function makeDeadline() { return AbortSignal.timeout(9) }`);
      writeFileSync(main, `import { makeDeadline } from "./factory.js"; export function schedule() { const signal = makeDeadline(); return scheduler.postTask(() => {}, { signal, priority: "background" }) }`);
      const program = ts.createProgram([factory, main], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const model = analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!);
      expect(model.timers).toMatchObject([
        { kind: "abort-timeout", delay: 9 },
        { kind: "scheduler-post-task", abortTimer: 0, externalAbortSignal: false },
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("resolves an AbortSignal.any composition returned by a source factory", () => {
    const model = analyzeAsyncPatterns("scheduler-composition-factory.ts", `
      function makeSignal(external: AbortSignal) {
        return AbortSignal.any([external, AbortSignal.timeout(4)])
      }
      function schedule(external: AbortSignal) {
        const signal = makeSignal(external)
        return scheduler.postTask(() => {}, { signal, priority: "background" })
      }
    `);
    expect(model.abortCompositions).toHaveLength(1);
    expect(model.abortCompositions[0]).toMatchObject({ sourceTimers: [undefined, 0] });
    expect(model.timers).toMatchObject([
      { kind: "abort-timeout", delay: 4 },
      { kind: "scheduler-post-task", abortComposition: 0, externalAbortSignal: false },
    ]);
    const quint = generateWebEventLoopQuint("scheduler_composition_factory", model);
    expect(quint).toContain("action abort_0_from_external_0");
    expect(quint).toContain("action abort_0_from_timer_0");
    expect(quint).toContain("action cancel_scheduler_task_1_from_composition_0");
  });

  it("resolves an AbortSignal.any composition returned by an imported source factory", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-composition-factory-"));
    try {
      const factory = join(directory, "factory.ts"), main = join(directory, "main.ts");
      writeFileSync(factory, `export function makeSignal(external: AbortSignal) { return AbortSignal.any([external, AbortSignal.timeout(6)]) }`);
      writeFileSync(main, `import { makeSignal } from "./factory.js"; export function schedule(external: AbortSignal) { const signal = makeSignal(external); return scheduler.postTask(() => {}, { signal, priority: "background" }) }`);
      const program = ts.createProgram([factory, main], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const model = analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!);
      expect(model.abortCompositions).toMatchObject([{ sourceTimers: [undefined, 0] }]);
      expect(model.timers).toMatchObject([
        { kind: "abort-timeout", delay: 6 },
        { kind: "scheduler-post-task", abortComposition: 0, externalAbortSignal: false },
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("substitutes abort-factory parameters with concrete call arguments", () => {
    const model = analyzeAsyncPatterns("composition-factory-arguments.ts", `
      function makeSignal(source: AbortSignal) {
        return AbortSignal.any([source, AbortSignal.timeout(10)])
      }
      function schedule() {
        const signal = makeSignal(AbortSignal.abort("pre-aborted"))
        return scheduler.postTask(() => {}, { signal, priority: "background" })
      }
    `);
    expect(model.abortCompositions).toMatchObject([{ initiallyAbortedSource: 0, sourceReasons: ['"pre-aborted"', "TimeoutError"] }]);
    expect(model.timers).toMatchObject([
      { kind: "abort-timeout", delay: 10 },
      { kind: "scheduler-post-task", abortComposition: 0, initiallyCancelled: true, externalAbortSignal: false },
    ]);
  });

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

  it("preserves concrete Promise.any rejection reasons in input order", () => {
    const model = analyzeAsyncPatterns("aggregate-reasons.ts", `
      async function load() {
        try { await Promise.any([Promise.reject("first"), Promise.reject(new TypeError("second")), Promise.resolve(1)]) } catch {}
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      aggregateErrorOrder: [0, 1, 2],
      aggregateErrorReasons: [
        { kind: "literal", value: "first" },
        { kind: "error", errorType: "TypeError", message: "second" },
        null,
      ],
    });
    const quint = generateAsyncPatternsQuint("aggregate_reasons", model);
    expect(quint).toContain('val join_0_aggregate_error_reason_0 = "literal:string:first"');
    expect(quint).toContain('val join_0_aggregate_error_reason_1 = "error:TypeError:second"');
    expect(quint).toContain('val join_0_aggregate_error_reason_2 = "unknown"');
  });

  it("resolves immutable local Promise.any rejection reasons", () => {
    const model = analyzeAsyncPatterns("aggregate-reason-aliases.ts", `
      async function load() {
        const code = "capacity"
        const failure = new RangeError("too large")
        const failures = [Promise.reject(code), Promise.reject(failure)] as const
        try { await Promise.any([Promise.reject(code), Promise.reject(failure)]) } catch {}
        try { await Promise.any(failures) } catch {}
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      aggregateErrorReasons: [
        { kind: "literal", value: "capacity" },
        { kind: "error", errorType: "RangeError", message: "too large" },
      ],
    });
    expect(model.combinators[1]).toMatchObject({
      aggregateErrorOrder: [0, 1],
      aggregateErrorReasons: [
        { kind: "literal", value: "capacity" },
        { kind: "error", errorType: "RangeError", message: "too large" },
      ],
    });
  });

  it("treats sparse holes as fulfilled undefined values and assimilates thenables", () => {
    const model = analyzeAsyncPatterns("iterable-elements.ts", `
      declare const remote: PromiseLike<number>
      declare const dynamic: PromiseLike<number>[]
      const local = [remote, 2] as const
      const alias = local
      const mutable = [remote]
      async function load() {
        await Promise.all([1, , remote])
        await Promise.all([...([remote])])
        await Promise.all([...dynamic])
        await Promise.all([0, ...alias, 3])
        await Promise.all([...mutable])
        await Promise.all(new Set([remote, remote, Promise.resolve(2)]))
      }
    `);
    expect(model.combinators).toMatchObject([
      {
        branches: ["1", "<hole>", "remote"],
        branchKinds: ["value", "value", "thenable"],
        staticIterable: true,
      },
      { branches: ["remote"], branchKinds: ["thenable"], staticIterable: true },
      { staticIterable: false, iteratorKind: "dynamic", iteratorEffects: ["InvokeUserCode"] },
      { branches: ["0", "remote", "2", "3"], branchKinds: ["value", "thenable", "value", "value"], staticIterable: true },
      { staticIterable: false, iteratorKind: "dynamic", iteratorEffects: ["InvokeUserCode"] },
      { branches: ["remote", "Promise.resolve(2)"], branchKinds: ["thenable", "thenable"], staticIterable: true, iteratorKind: "set", iteratorEffects: [] },
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

  it("bounds equal-length conditional array iterables slot by slot", () => {
    const model = analyzeAsyncPatterns("conditional-iterable.ts", `
      async function load(flag: boolean) {
        await Promise.all(flag ? [Promise.resolve(1), 2] : [3, Promise.reject(new Error("x"))])
        await Promise.all(flag ? [1] : [2, 3])
        await Promise.allSettled(flag ? [1] : [2, 3])
        await Promise.race(flag ? [Promise.resolve(1)] : [Promise.resolve(2), Promise.reject(new Error("race"))])
        try { await Promise.any(flag ? [Promise.reject("a")] : [Promise.reject("b"), Promise.resolve(3)]) } catch {}
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      iteratorKind: "array",
      branchKinds: ["unknown", "unknown"],
      branchAlternatives: [["Promise.resolve(1)", "3"], ["2", "Promise.reject(new Error(\"x\"))"]],
    });
    expect(model.combinators[1]).toMatchObject({
      staticIterable: true,
      iteratorKind: "array",
      branchAlternatives: [["1", "2"], ["<absent>", "3"]],
      branchPresence: ["always", "when-false"],
    });
    const quint = generateAsyncPatternsQuint("conditional_iterable", {
      timers: [], cancellations: [], abortCompositions: [], timerEscapes: [], combinators: [model.combinators[0]!],
    });
    expect(quint).toContain("action assimilate_0_0");
    expect(quint).toContain("action assimilate_0_1");
    const varying = generateAsyncPatternsQuint("varying_conditional_iterable", {
      timers: [], cancellations: [], abortCompositions: [], timerEscapes: [], combinators: [model.combinators[1]!],
    });
    expect(varying).toContain("var join_0_iterable_choice: int");
    expect(varying).toContain("action choose_iterable_0_path_0");
    expect(varying).toContain("action choose_iterable_0_path_1");
    expect(varying).toMatch(/action fulfill_0_1[\s\S]*join_0_iterable_choice == 1/);
    expect(run(varying, "asyncSafe").status).toBe(0);
    const combined = generateAsyncPatternsQuint("varying_conditional_combinators", model);
    expect(combined).toContain("def join_4_aggregate_error_count = if (join_4_iterable_choice == -1) 0 else if (join_4_iterable_choice == 0) 1 else if (join_4_iterable_choice == 1) 2 else 0");
    expect(run(combined, "asyncSafe").status).toBe(0);
  });

  it("keeps finite generator if/else paths under one correlated iterable choice", () => {
    const model = analyzeAsyncPatterns("conditional-generator.ts", `
      function* values(flag: boolean, remote: PromiseLike<string>) {
        yield "head"
        if (flag) {
          yield Promise.resolve("fresh")
        } else {
          yield "cached"
          yield remote
        }
        yield "tail"
      }
      async function load(flag: boolean, remote: PromiseLike<string>) {
        return Promise.all(values(flag, remote))
      }
      async function loadSpread(flag: boolean, remote: PromiseLike<string>) {
        return Promise.all(["prefix", ...values(flag, remote)])
      }
      async function loadAny(flag: boolean, remote: PromiseLike<string>) {
        return Promise.any(values(flag, remote))
      }
      async function loadDoubleSpread(flag: boolean, remote: PromiseLike<string>) {
        return Promise.all([...values(flag, remote), ...values(!flag, remote)])
      }
      function* twoChoices(first: boolean, second: boolean) {
        if (first) yield "a"; else yield "b"
        yield "middle"
        if (second) yield Promise.resolve("c"); else { yield "d"; yield "e" }
      }
      async function loadTwoChoices(first: boolean, second: boolean) {
        return Promise.all(twoChoices(first, second))
      }
      function* repeatedChoice(flag: boolean) {
        if (flag) yield "first-true"; else yield "first-false"
        if (flag) yield "second-true"; else yield "second-false"
      }
      async function loadRepeatedChoice(flag: boolean) {
        return Promise.all(repeatedChoice(flag))
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      iteratorKind: "local",
      branchAlternatives: [
        ['"head"', '"head"'],
        ['Promise.resolve("fresh")', '"cached"'],
        ['"tail"', "remote"],
        ["<absent>", '"tail"'],
      ],
      branchPresence: ["always", "always", "always", "when-false"],
      branchKinds: ["value", "unknown", "unknown", "value"],
    });
    const quint = generateAsyncPatternsQuint("conditional_generator", { ...model, combinators: [model.combinators[0]!] });
    expect(quint.match(/var join_0_iterable_choice/g)).toHaveLength(1);
    expect(quint).toContain("action choose_iterable_0_path_0");
    expect(quint).toContain("action choose_iterable_0_path_1");
    expect(quint).toMatch(/action fulfill_0_3[\s\S]*join_0_iterable_choice == 1/);
    expect(model.combinators[1]).toMatchObject({
      owner: "loadSpread",
      staticIterable: true,
      iteratorKind: "array",
      branchAlternatives: [
        ['"prefix"', '"prefix"'],
        ['"head"', '"head"'],
        ['Promise.resolve("fresh")', '"cached"'],
        ['"tail"', "remote"],
        ["<absent>", '"tail"'],
      ],
      branchPresence: ["always", "always", "always", "always", "when-false"],
      iteratorEffects: ["InvokeUserCode"],
    });
    expect(model.combinators[2]).toMatchObject({
      owner: "loadAny",
      aggregateErrorOrder: [0, 1, 2, 3],
      aggregateErrorReasons: undefined,
      branchPresence: ["always", "always", "always", "when-false"],
    });
    expect(model.combinators[3]).toMatchObject({
      owner: "loadDoubleSpread",
      staticIterable: true,
      iteratorKind: "array",
      branchAlternatives: [
        ['"head"', '"head"'],
        ['Promise.resolve("fresh")', '"cached"'],
        ['"tail"', "remote"],
        ['"head"', '"tail"'],
        ['"cached"', '"head"'],
        ["remote", 'Promise.resolve("fresh")'],
        ['"tail"', '"tail"'],
      ],
    });
    const product = generateAsyncPatternsQuint("conditional_generator_product", { ...model, combinators: [model.combinators[3]!] });
    expect(product).toContain("action choose_iterable_0_path_0");
    expect(product).toContain("action choose_iterable_0_path_1");
    expect(run(product, "asyncSafe").status).toBe(0);
    expect(model.combinators[4]).toMatchObject({
      owner: "loadTwoChoices",
      staticIterable: true,
      iterablePaths: [
        { branches: ['"a"', '"middle"', 'Promise.resolve("c")'] },
        { branches: ['"a"', '"middle"', '"d"', '"e"'] },
        { branches: ['"b"', '"middle"', 'Promise.resolve("c")'] },
        { branches: ['"b"', '"middle"', '"d"', '"e"'] },
      ],
    });
    expect(model.combinators[5]).toMatchObject({
      owner: "loadRepeatedChoice",
      branchAlternatives: [
        ['"first-true"', '"first-false"'],
        ['"second-true"', '"second-false"'],
      ],
    });
  });

  it("guards a conditional generator step failure with the same iterable choice", () => {
    const model = analyzeAsyncPatterns("conditional-generator-failure.ts", `
      function* values(fail: boolean) {
        if (fail) {
          throw new Error("iterator-failed")
        } else {
          yield Promise.resolve("ok")
        }
        yield "tail"
      }
      async function load(fail: boolean) { return Promise.all(values(fail)) }
      function* staged(first: boolean, second: boolean) {
        if (first) throw new Error("first")
        else yield Promise.resolve("ok")
        if (second) throw new Error("second")
        else yield "tail"
      }
      async function loadStaged(first: boolean, second: boolean) { return Promise.all(staged(first, second)) }
      async function loadStagedSpread(first: boolean, second: boolean) {
        return Promise.all(["before", ...staged(first, second), "after"])
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      iteratorFailure: "step",
      iteratorFailurePresence: "when-true",
      branchAlternatives: [
        ["<absent>", 'Promise.resolve("ok")'],
        ["<absent>", '"tail"'],
      ],
      branchPresence: ["when-false", "when-false"],
    });
    const quint = generateAsyncPatternsQuint("conditional_generator_failure", model);
    expect(quint).toMatch(/action fail_iterator_0[\s\S]*join_0_iterable_choice == 0/);
    expect(quint).toMatch(/action assimilate_0_0[\s\S]*join_0_iterable_choice == 1/);
    expect(quint).toMatch(/action step = any \{[\s\S]*fail_iterator_0,[\s\S]*assimilate_0_0,/);
    expect(model.combinators[1]).toMatchObject({
      iterablePaths: [
        { branches: [], iteratorFailure: "step" },
        { branches: ['Promise.resolve("ok")'], iteratorFailure: "step" },
        { branches: ['Promise.resolve("ok")', '"tail"'] },
      ],
    });
    const staged = generateAsyncPatternsQuint("staged_generator_failure", { ...model, combinators: [model.combinators[1]!] });
    expect(staged).toMatch(/action fail_iterator_0[\s\S]*join_0_iterable_choice == 0 or join_0_iterable_choice == 1/);
    expect(staged).toMatch(/action fulfill_0_1[\s\S]*join_0_iterable_choice == 2/);
    expect(run(staged, "asyncSafe").status).toBe(0);
    expect(model.combinators[2]).toMatchObject({
      iterablePaths: [
        { branches: ['"before"'], iteratorFailure: "step" },
        { branches: ['"before"', 'Promise.resolve("ok")'], iteratorFailure: "step" },
        { branches: ['"before"', 'Promise.resolve("ok")', '"tail"', '"after"'] },
      ],
    });
  });

  it("falls back to an unsupported dynamic iterable instead of truncating an exploding path product", () => {
    const model = analyzeAsyncPatterns("generator-path-cap.ts", `
      function* choices(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean) {
        if (a) yield "a1"; else yield "a0"
        if (b) yield "b1"; else yield "b0"
        if (c) yield "c1"; else yield "c0"
        if (d) yield "d1"; else yield "d0"
        if (e) yield "e1"; else yield "e0"
        if (f) yield "f1"; else yield "f0"
      }
      async function load(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean, f: boolean) {
        return Promise.all(choices(a, b, c, d, e, f))
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: false,
      iteratorKind: "dynamic",
      iteratorEffects: ["InvokeUserCode"],
      unsupportedReason: "finite-path-limit",
    });
    expect(() => generateAsyncPatternsQuint("generator_path_cap", model)).toThrow(/finite-path-limit/);
  });

  it("keeps Promise.any rejection reasons correlated with the selected iterable path", () => {
    const model = analyzeAsyncPatterns("conditional-any-reasons.ts", `
      function* failures(flag: boolean) {
        if (flag) yield Promise.reject("primary")
        else {
          yield Promise.reject(new TypeError("cache"))
          yield Promise.reject("secondary")
        }
      }
      async function load(flag: boolean) {
        try { return await Promise.any([...failures(flag)]) } catch { return "fallback" }
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      aggregateErrorReasons: undefined,
      aggregateErrorReasonPaths: [
        [{ kind: "literal", value: "primary" }],
        [
          { kind: "error", errorType: "TypeError", message: "cache" },
          { kind: "literal", value: "secondary" },
        ],
      ],
    });
    const quint = generateAsyncPatternsQuint("conditional_any_reasons", model);
    expect(quint).toContain('val join_0_path_0_aggregate_error_reason_0 = "literal:string:primary"');
    expect(quint).toContain('val join_0_path_1_aggregate_error_reason_0 = "error:TypeError:cache"');
    expect(quint).toContain('val join_0_path_1_aggregate_error_reason_1 = "literal:string:secondary"');
    expect(quint).toContain("if (join_0_iterable_choice == 0) 1 else if (join_0_iterable_choice == 1) 2 else 0");
    expect(run(quint, "asyncSafe").status).toBe(0);
  });

  it("folds boolean generator guards and refuses effectful computed guards", () => {
    const model = analyzeAsyncPatterns("generator-guards.ts", `
      declare function danger(): boolean
      function* folded() {
        if (true) yield "reachable"; else yield Promise.reject("dead")
      }
      function* computed() {
        if (danger()) yield "yes"; else yield "no"
      }
      async function loadFolded() { return Promise.all(folded()) }
      async function loadComputed() { return Promise.all(computed()) }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      branches: ['"reachable"'],
      branchKinds: ["value"],
    });
    expect(model.combinators[0]).not.toHaveProperty("iterablePaths");
    expect(model.combinators[1]).toMatchObject({
      staticIterable: false,
      unsupportedReason: "unsupported-generator-control-flow",
    });
  });

  it("models a bare generator yield as a fulfilled undefined value", () => {
    const model = analyzeAsyncPatterns("bare-yield.ts", `
      function* values() { yield; yield Promise.resolve(1) }
      async function load() { return Promise.all(values()) }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      branches: ["undefined", "Promise.resolve(1)"],
      branchKinds: ["value", "thenable"],
    });
    const quint = generateAsyncPatternsQuint("bare_yield", model);
    expect(quint).toContain("action fulfill_0_0");
    expect(quint).not.toContain("action reject_0_0");
  });

  it("flattens yield delegation to a directly finite builtin iterable", () => {
    const model = analyzeAsyncPatterns("finite-yield-star.ts", `
      function* values() {
        yield "head"
        yield* [1, Promise.resolve(2)]
        yield* new Set(["cached", "cached", "fresh"])
        yield "tail"
      }
      async function load() { return Promise.all(values()) }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      branches: ['"head"', "1", "Promise.resolve(2)", '"cached"', '"fresh"', '"tail"'],
      branchKinds: ["value", "value", "thenable", "value", "value", "value"],
    });
  });

  it("unrolls a generator for-of over a directly finite builtin iterable", () => {
    const model = analyzeAsyncPatterns("finite-generator-loop.ts", `
      function* values() {
        for (const item of ["cached", Promise.resolve("fresh")] as const) {
          yield item
        }
        for (const item of new Set([1, 1, 2])) yield item
        for (const enabled of [true, false] as const) {
          if (enabled) yield "enabled"; else yield "disabled"
        }
        yield "tail"
      }
      async function load() { return Promise.all(values()) }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      branches: ['"cached"', 'Promise.resolve("fresh")', "1", "2", '"enabled"', '"disabled"', '"tail"'],
      branchKinds: ["value", "thenable", "value", "value", "value", "value", "value"],
    });
  });

  it("specializes immutable literal and identifier aliases inside a finite generator", () => {
    const model = analyzeAsyncPatterns("generator-local-alias.ts", `
      function* values(flag: boolean, remote: PromiseLike<string>) {
        const selected = flag
        const cached = "cached"
        const forwarded = remote
        if (selected) yield forwarded
        else yield cached
      }
      async function load(flag: boolean, network: PromiseLike<string>) {
        return Promise.all(values(flag, network))
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      branchAlternatives: [["network", '"cached"']],
      branchKinds: ["unknown"],
      iterablePaths: [
        { branches: ["network"], branchKinds: ["thenable"] },
        { branches: ['"cached"'], branchKinds: ["value"] },
      ],
    });
  });

  it("restores immutable alias bindings after a nested generator block", () => {
    const model = analyzeAsyncPatterns("generator-block-scope.ts", `
      function* values(remote: PromiseLike<string>) {
        { const value = "nested"; yield value }
        { const value = remote; yield value }
        yield "tail"
      }
      async function load(network: PromiseLike<string>) { return Promise.all(values(network)) }
    `);
    expect(model.combinators[0]).toMatchObject({
      staticIterable: true,
      branches: ['"nested"', "network", '"tail"'],
      branchKinds: ["value", "thenable", "value"],
    });
  });

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

  it("bounds an imported finite generator by TypeChecker symbol identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-iterable-"));
    try {
      const values = join(directory, "values.ts"), main = join(directory, "main.ts");
      writeFileSync(values, `
        export function* dashboardValues(remote: PromiseLike<string>) {
          yield "cached-profile"
          yield remote
        }
      `);
      writeFileSync(main, `
        import { dashboardValues as values } from "./values.js"
        export async function load(network: PromiseLike<string>) {
          return Promise.all(values(network))
        }
      `);
      const program = ts.createProgram([main, values], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[0]).toMatchObject({
        owner: "load",
        combinator: "all",
        branches: ['"cached-profile"', "network"],
        branchKinds: ["value", "thenable"],
        staticIterable: true,
        iteratorKind: "local",
        iteratorEffects: ["InvokeUserCode"],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("preserves Promise.any rejection reasons from an imported finite generator", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-any-reasons-"));
    try {
      const values = join(directory, "values.ts"), main = join(directory, "main.ts");
      writeFileSync(values, `
        export function* failures() {
          yield Promise.reject("cache-miss")
          yield Promise.reject(new TypeError("network-down"))
        }
      `);
      writeFileSync(main, `
        import { failures } from "./values.js"
        export async function load() { return Promise.any(failures()) }
      `);
      const program = ts.createProgram([main, values], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[0]).toMatchObject({
        branches: ['Promise.reject("cache-miss")', 'Promise.reject(new TypeError("network-down"))'],
        aggregateErrorOrder: [0, 1],
        aggregateErrorReasons: [
          { kind: "literal", value: "cache-miss" },
          { kind: "error", errorType: "TypeError", message: "network-down" },
        ],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("bounds an imported object with a finite generator iterator method", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-custom-iterable-"));
    try {
      const values = join(directory, "values.ts"), main = join(directory, "main.ts");
      writeFileSync(values, `
        declare const remote: PromiseLike<string>
        export const dashboardValues = {
          *[Symbol.iterator]() {
            yield "cached-profile"
            yield remote
          }
        }
      `);
      writeFileSync(main, `
        import { dashboardValues as values } from "./values.js"
        export async function load() { return Promise.all(values) }
      `);
      const program = ts.createProgram([main, values], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[0]).toMatchObject({
        owner: "load",
        combinator: "all",
        branches: ['"cached-profile"', "remote"],
        branchKinds: ["value", "thenable"],
        staticIterable: true,
        iteratorKind: "local",
        iteratorEffects: ["InvokeUserCode"],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("specializes an imported factory returning a finite custom iterable", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-iterable-factory-"));
    try {
      const values = join(directory, "values.ts"), main = join(directory, "main.ts");
      writeFileSync(values, `
        export function dashboardValues(remote: PromiseLike<string>) {
          return {
            *[Symbol.iterator]() {
              yield "cached-profile"
              yield remote
            }
          }
        }
      `);
      writeFileSync(main, `
        import { dashboardValues as values } from "./values.js"
        export async function load(network: PromiseLike<string>) {
          return Promise.all(values(network))
        }
      `);
      const program = ts.createProgram([main, values], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[0]).toMatchObject({
        branches: ['"cached-profile"', "network"],
        branchKinds: ["value", "thenable"],
        staticIterable: true,
        iteratorKind: "local",
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("flattens an imported finite iterable used inside an array spread", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-iterable-spread-"));
    try {
      const values = join(directory, "values.ts"), main = join(directory, "main.ts");
      writeFileSync(values, `
        export function* dashboardValues(remote: PromiseLike<string>) {
          yield "cached-profile"
          yield remote
          throw new Error("stale-dashboard")
        }
      `);
      writeFileSync(main, `
        import { dashboardValues as values } from "./values.js"
        export async function load(network: PromiseLike<string>) {
          return Promise.all(["head", ...values(network), "tail"])
        }
      `);
      const program = ts.createProgram([main, values], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[0]).toMatchObject({
        branches: ['"head"', '"cached-profile"', "network"],
        branchKinds: ["value", "value", "thenable"],
        staticIterable: true,
        iteratorKind: "array",
        iteratorEffects: ["InvokeUserCode"],
        iteratorFailure: "step",
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("follows immutable local aliases of imported finite iterables", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-iterable-alias-"));
    try {
      const values = join(directory, "values.ts"), main = join(directory, "main.ts");
      writeFileSync(values, `
        export function* dashboardValues(remote: PromiseLike<string>) {
          yield "cached-profile"
          yield remote
        }
      `);
      writeFileSync(main, `
        import { dashboardValues as values } from "./values.js"
        export async function load(network: PromiseLike<string>) {
          const batch = values(network)
          const forwarded = batch
          return Promise.all([...forwarded])
        }
        export async function loadMutable(network: PromiseLike<string>) {
          let batch: Iterable<string | PromiseLike<string>> = values(network)
          batch = []
          return Promise.all([...batch])
        }
      `);
      const program = ts.createProgram([main, values], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[0]).toMatchObject({
        branches: ['"cached-profile"', "network"],
        branchKinds: ["value", "thenable"],
        staticIterable: true,
        iteratorEffects: ["InvokeUserCode"],
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[1]).toMatchObject({
        owner: "loadMutable",
        staticIterable: false,
        iteratorKind: "dynamic",
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("bounds direct builtin Set iterables without collapsing distinct object identities", () => {
    const model = analyzeAsyncPatterns("set-iterable.ts", `
      declare const remote: PromiseLike<number>
      function load() {
        Promise.all(new Set([remote, remote, 1, 1, {}, {}]))
        Promise.race(new Set())
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      branches: ["remote", "1", "{}", "{}"],
      branchKinds: ["thenable", "value", "value", "value"],
      staticIterable: true,
      iteratorKind: "set",
      iteratorEffects: [],
    });
    expect(model.combinators[1]).toMatchObject({ branches: [], staticIterable: true, iteratorKind: "set", iteratorEffects: [] });

    const shadowed = analyzeAsyncPatterns("shadowed-set-iterable.ts", `
      class Set<T> {
        constructor(private values: T[]) {}
        *[Symbol.iterator]() { yield* this.values }
      }
      declare const remote: PromiseLike<number>
      function load() { Promise.all(new Set([remote])) }
    `);
    expect(shadowed.combinators[0]).toMatchObject({
      staticIterable: false,
      iteratorKind: "dynamic",
      iteratorEffects: ["InvokeUserCode"],
    });

    const directory = mkdtempSync(join(tmpdir(), "uneffect-custom-set-"));
    try {
      const declaration = join(directory, "custom-set.d.ts"), main = join(directory, "main.ts");
      writeFileSync(declaration, `export class Set<T> implements Iterable<T> { constructor(values: T[]); [Symbol.iterator](): Iterator<T> }`);
      writeFileSync(main, `import { Set } from "./custom-set.js"; declare const remote: PromiseLike<number>; function load() { Promise.all(new Set([remote])) }`);
      const program = ts.createProgram([main, declaration], {
        target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2024.d.ts"], noEmit: true,
      });
      expect(analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!).combinators[0]).toMatchObject({
        staticIterable: false,
        iteratorKind: "dynamic",
        iteratorEffects: ["InvokeUserCode"],
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("flattens a direct finite Set spread but keeps a stored mutable Set dynamic", () => {
    const model = analyzeAsyncPatterns("set-spread.ts", `
      declare const remote: PromiseLike<number>
      const mutable = new Set([remote, 1])
      function load() {
        Promise.all([...new Set([remote, remote, 1])])
        Promise.all([...mutable])
      }
    `);
    expect(model.combinators[0]).toMatchObject({
      branches: ["remote", "1"],
      branchKinds: ["thenable", "value"],
      staticIterable: true,
      iteratorKind: "array",
      iteratorEffects: [],
    });
    expect(model.combinators[1]).toMatchObject({
      staticIterable: false,
      iteratorKind: "dynamic",
      iteratorEffects: ["InvokeUserCode"],
    });
  });

  it("models iterator next and result getter failures", () => {
    const model = analyzeAsyncPatterns("iterator-getters.ts", `
      const nextGetter = {
        [Symbol.iterator]() { return { get next(): never { throw new Error("next getter") } } }
      }
      const resultGetter = {
        [Symbol.iterator]() { return { next() { return { get done(): never { throw new Error("done getter") }, value: 1 } } } }
      }
      async function load() {
        try { await Promise.all(nextGetter) } catch {}
        try { await Promise.race(resultGetter) } catch {}
      }
    `);
    expect(model.combinators).toMatchObject([
      { combinator: "all", staticIterable: true, iteratorFailure: "acquire", branches: [] },
      { combinator: "race", staticIterable: true, iteratorFailure: "step", branches: [] },
    ]);
    const quint = generateAsyncPatternsQuint("iterator_getters", model);
    expect(quint).toContain("action fail_iterator_0");
    expect(quint).toContain("action fail_iterator_1");
  });

  it("resolves a direct method callback and its dynamically enqueued microtasks", () => {
    const model = analyzeAsyncPatterns("method-callback.ts", `
      const worker = {
        run() { queueMicrotask(() => console.log("microtask")) }
      }
      function start() { setTimeout(worker.run, 0) }
    `);
    expect(model.timers).toMatchObject([
      { callback: "worker.run", queue: "timer" },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
  });

  it("resolves a literal computed method callback", () => {
    const model = analyzeAsyncPatterns("computed-method-callback.ts", `
      const worker = {
        run() { queueMicrotask(() => undefined) }
      }
      function start() { setTimeout(worker["run"], 0) }
    `);
    expect(model.timers).toMatchObject([
      { callback: 'worker["run"]', queue: "timer" },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
  });

  it("resolves a callback returned by a direct local factory", () => {
    const model = analyzeAsyncPatterns("callback-factory.ts", `
      function makeCallback() {
        return () => queueMicrotask(() => undefined)
      }
      function start() { setTimeout(makeCallback(), 0) }
    `);
    expect(model.timers).toMatchObject([
      { callback: "makeCallback()", queue: "timer" },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
  });

  it("resolves every definitely returned callback from a branching factory", () => {
    const model = analyzeAsyncPatterns("branching-callback-factory.ts", `
      function afterSuccess() { queueMicrotask(() => undefined) }
      function afterFailure() { process.nextTick(() => undefined) }
      function makeCallback(flag: boolean) {
        if (flag) return afterSuccess
        return afterFailure
      }
      function start(flag: boolean) { setTimeout(makeCallback(flag), 0) }
    `);
    const parent = model.timers.findIndex((timer) => timer.callback === "makeCallback(flag)");
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(model.timers.filter((timer) => timer.enqueuedBy === parent).map((timer) => timer.queue).sort())
      .toEqual(["microtask", "next-tick"]);

    const concise = analyzeAsyncPatterns("conditional-expression-callback-factory.ts", `
      function afterSuccess() { queueMicrotask(() => undefined) }
      function afterFailure() { process.nextTick(() => undefined) }
      const makeCallback = (flag: boolean) => flag ? afterSuccess : afterFailure
      function start(flag: boolean) { setTimeout(makeCallback(flag), 0) }
    `);
    const conciseParent = concise.timers.findIndex((timer) => timer.callback === "makeCallback(flag)");
    expect(concise.timers.filter((timer) => timer.enqueuedBy === conciseParent).map((timer) => timer.queue).sort())
      .toEqual(["microtask", "next-tick"]);

    const partial = analyzeAsyncPatterns("partial-callback-factory.ts", `
      function local() { queueMicrotask(() => undefined) }
      function makeCallback(flag: boolean) { if (flag) return local }
      function start(flag: boolean) { setTimeout(makeCallback(flag), 0) }
    `);
    const partialParent = partial.timers.findIndex((timer) => timer.callback === "makeCallback(flag)");
    expect(partialParent).toBeGreaterThanOrEqual(0);
    expect(partial.timers.some((timer) => timer.enqueuedBy === partialParent)).toBe(false);
  });

  it("resolves a callback returned by an imported source factory", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-callback-factory-"));
    try {
      const factory = join(directory, "factory.ts"), main = join(directory, "main.ts");
      writeFileSync(factory, `export function makeCallback(flag: boolean) {
        if (flag) return () => queueMicrotask(() => undefined)
        return () => setTimeout(() => undefined, 0)
      }`);
      writeFileSync(main, `import { makeCallback } from "./factory.js"; export function start(flag: boolean) { setTimeout(makeCallback(flag), 0) }`);
      const program = ts.createProgram([factory, main], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const model = analyzeAsyncPatternsInProgram(program, program.getSourceFile(main)!);
      expect(model.timers).toMatchObject([
        { callback: "makeCallback(flag)", queue: "timer" },
        { queue: "microtask", enqueuedBy: 0 },
        { queue: "timer", enqueuedBy: 0 },
      ]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("specializes callback-factory parameters from finite call arguments", () => {
    const model = analyzeAsyncPatterns("parameterized-callback-factory.ts", `
      function afterSuccess() { queueMicrotask(() => undefined) }
      function afterFailure() { process.nextTick(() => undefined) }
      const handlers = { success: afterSuccess, failure: afterFailure } as const
      function select(key: "success" | "failure") { return handlers[key] }
      function identity(callback: () => void) { return callback }
      function start(flag: boolean, dynamicKey: string) {
        setTimeout(select(flag ? "success" : "failure"), 0)
        setTimeout(identity(afterSuccess), 0)
        setTimeout(select(dynamicKey as "success" | "failure"), 0)
      }
    `);
    const selected = model.timers.findIndex((timer) => timer.callback === 'select(flag ? "success" : "failure")');
    expect(model.timers.filter((timer) => timer.enqueuedBy === selected).map((timer) => timer.queue).sort())
      .toEqual(["microtask", "next-tick"]);
    const identity = model.timers.findIndex((timer) => timer.callback === "identity(afterSuccess)");
    expect(model.timers.filter((timer) => timer.enqueuedBy === identity).map((timer) => timer.queue))
      .toEqual(["microtask"]);
    const dynamic = model.timers.findIndex((timer) => timer.callback === 'select(dynamicKey as "success" | "failure")');
    expect(dynamic).toBeGreaterThanOrEqual(0);
    expect(model.timers.some((timer) => timer.enqueuedBy === dynamic)).toBe(false);
  });

  it("resolves a callback selected by an immutable method factory", () => {
    const model = analyzeAsyncPatterns("method-callback-factory.ts", `
      function afterSuccess() { queueMicrotask(() => undefined) }
      function afterFailure() { process.nextTick(() => undefined) }
      const worker = {
        handlers: { success: afterSuccess, failure: afterFailure } as const,
        select(key: "success" | "failure") { return this.handlers[key] },
      } as const
      function start(flag: boolean) { setTimeout(worker.select(flag ? "success" : "failure"), 0) }
    `);
    const parent = model.timers.findIndex((timer) => timer.callback === 'worker.select(flag ? "success" : "failure")');
    expect(model.timers.filter((timer) => timer.enqueuedBy === parent).map((timer) => timer.queue).sort())
      .toEqual(["microtask", "next-tick"]);
  });

  it("resolves every branch of a finite conditional timer callback", () => {
    const model = analyzeAsyncPatterns("conditional-callback.ts", `
      function afterSuccess() { queueMicrotask(() => undefined) }
      function afterFailure() { process.nextTick(() => undefined) }
      function start(flag: boolean) {
        setTimeout(flag ? afterSuccess : afterFailure, 0)
      }
    `);
    expect(model.timers).toMatchObject([
      { callback: "flag ? afterSuccess : afterFailure", queue: "timer" },
      { queue: "microtask", enqueuedBy: 0 },
      { queue: "next-tick", enqueuedBy: 0 },
    ]);

    const duplicate = analyzeAsyncPatterns("duplicate-conditional-callback.ts", `
      function callback() { queueMicrotask(() => undefined) }
      function start(flag: boolean) { setTimeout(flag ? callback : callback, 0) }
    `);
    expect(duplicate.timers.filter((timer) => timer.enqueuedBy === 0)).toHaveLength(1);

    const partial = analyzeAsyncPatterns("partial-conditional-callback.ts", `
      declare const external: () => void
      function local() { queueMicrotask(() => undefined) }
      function start(flag: boolean) { setTimeout(flag ? local : external, 0) }
    `);
    expect(partial.timers).toContainEqual(expect.objectContaining({
      callback: "flag ? local : external", queue: "timer",
    }));
    expect(partial.timers.some((timer) => timer.enqueuedBy === 0)).toBe(false);
  });

  it("resolves a finite computed callback selection from an immutable table", () => {
    const exact = analyzeAsyncPatterns("computed-callback-table.ts", `
      function afterSuccess() { queueMicrotask(() => undefined) }
      function afterFailure() { process.nextTick(() => undefined) }
      function start(flag: boolean) {
        const baseHandlers = { success: afterSuccess, failure: afterFailure } as const
        const handlers = baseHandlers
        const baseKey = flag ? "success" : "failure"
        const key = baseKey
        setTimeout(handlers[key], 0)
      }
    `);
    expect(exact.timers).toMatchObject([
      { callback: "handlers[key]", queue: "timer" },
      { queue: "microtask", enqueuedBy: 0 },
      { queue: "next-tick", enqueuedBy: 0 },
    ]);

    const mutable = analyzeAsyncPatterns("mutable-callback-table.ts", `
      function callback() { queueMicrotask(() => undefined) }
      function start() {
        const handlers: Record<string, () => void> = { success: callback }
        setTimeout(handlers["success"]!, 0)
      }
    `);
    const parent = mutable.timers.findIndex((timer) => timer.callback === 'handlers["success"]!');
    expect(parent).toBeGreaterThanOrEqual(0);
    expect(mutable.timers.some((timer) => timer.enqueuedBy === parent)).toBe(false);

    const getter = analyzeAsyncPatterns("getter-callback-table.ts", `
      function callback() { queueMicrotask(() => undefined) }
      function start() {
        const handlers = { get success() { return callback } } as const
        setTimeout(handlers["success"], 0)
      }
    `);
    const getterParent = getter.timers.findIndex((timer) => timer.callback === 'handlers["success"]');
    expect(getterParent).toBeGreaterThanOrEqual(0);
    expect(getter.timers.some((timer) => timer.enqueuedBy === getterParent)).toBe(false);
  });

  it("models the Node callback checkpoint with nextTick before V8 microtasks", () => {
    const model = analyzeAsyncPatterns("node-loop.ts", `
      import { nextTick } from "node:process"
      function schedule() {
        setTimeout(() => {}, 0)
        setImmediate(() => {})
        queueMicrotask(() => {})
        nextTick(() => {})
      }
    `);
    expect(model.timers).toMatchObject([
      { queue: "timer" },
      { queue: "check" },
      { queue: "microtask" },
      { queue: "next-tick" },
    ]);
    const quint = generateNodeEventLoopQuint("node_loop", model);
    expect(quint).toContain("var node_phase: int");
    expect(quint).toContain("action advance_timers_to_poll");
    expect(quint).toContain("action advance_poll_to_check");
    expect(quint).toContain("action advance_check_to_close");
    expect(quint).toMatch(/action run_check_1[\s\S]*node_phase == 3/);
    expect(quint).toContain("action drain_next_tick_3");
    expect(quint).toMatch(/action drain_microtask_2[\s\S]*not\(callback_3_pending\)/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
    expect(run(generateNodeEventLoopQuint("node_loop_broken", model, { allowMicrotaskBeforeNextTick: true }), "nodeEventLoopSafe").status).not.toBe(0);
    expect(run(generateNodeEventLoopQuint("node_phase_broken", model, { allowWrongPhase: true }), "nodeEventLoopSafe").status).not.toBe(0);
  }, 20_000);

  it("shares the Node V8 microtask FIFO between queueMicrotask and Promise reactions", () => {
    const source = `
      import { nextTick } from "node:process"
      function schedule() {
        const root = new Promise<number>((resolve) => resolve(1))
        queueMicrotask(() => {})
        root.then(() => 2)
        nextTick(() => {})
      }
    `;
    const patterns = analyzeAsyncPatterns("node-promise-loop.ts", source);
    const promises = analyzePromiseChains("node-promise-loop.ts", source);
    const quint = generateNodeEventLoopQuint("node_promise_loop", patterns, {}, promises);
    expect(quint).toContain("action drain_microtask_0");
    expect(quint).toContain("action drain_promise_reaction_0_0");
    expect(quint).toMatch(/action drain_promise_reaction_0_0[\s\S]*not\(callback_0_pending\)/);
    expect(quint).toMatch(/action drain_microtask_0[\s\S]*not\(callback_1_pending\)/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);

  it("enqueues a nested Node microtask only after its parent callback runs", () => {
    const model = analyzeAsyncPatterns("node-nested.ts", `
      function schedule() {
        setTimeout(() => queueMicrotask(() => undefined), 0)
      }
    `);
    expect(model.timers).toMatchObject([
      { queue: "timer" },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_nested", model);
    expect(quint).toMatch(/action init[\s\S]*callback_1_pending' = false/);
    expect(quint).toMatch(/action run_timer_0[\s\S]*callback_1_pending' = true/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);

  it("enqueues nested nextTick work ahead of a sibling V8 microtask", () => {
    const model = analyzeAsyncPatterns("node-nested-next-tick.ts", `
      import { nextTick } from "node:process"
      function schedule() {
        setTimeout(() => {
          nextTick(() => undefined)
          queueMicrotask(() => undefined)
        }, 0)
      }
    `);
    expect(model.timers).toMatchObject([
      { queue: "timer" },
      { queue: "next-tick", enqueuedBy: 0 },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_nested_next_tick", model);
    expect(quint).toMatch(/action run_timer_0[\s\S]*callback_1_pending' = true[\s\S]*callback_2_pending' = true/);
    expect(quint).toMatch(/action drain_microtask_2[\s\S]*not\(callback_1_pending\)/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);

  it("defers an Immediate created by an Immediate callback to the next iteration", () => {
    const model = analyzeAsyncPatterns("node-nested-immediate.ts", `
      function schedule() {
        setImmediate(() => setImmediate(() => undefined))
      }
    `);
    expect(model.timers).toMatchObject([
      { queue: "check" },
      { queue: "check", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_nested_immediate", model);
    expect(quint).toMatch(/action init[\s\S]*callback_1_pending' = false/);
    expect(quint).toMatch(/action run_check_0[\s\S]*callback_1_pending' = true[\s\S]*callback_1_due' = clock \+ 1/);
    expect(quint).toMatch(/action advance_check_to_close[\s\S]*not\(callback_1_pending\) or callback_1_due > clock/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);

    const fromTimer = analyzeAsyncPatterns("node-timer-immediate.ts", `
      function schedule() {
        setTimeout(() => setImmediate(() => undefined), 0)
      }
    `);
    const timerQuint = generateNodeEventLoopQuint("node_timer_immediate", fromTimer);
    expect(timerQuint).toMatch(/action run_timer_0[\s\S]*callback_1_pending' = true[\s\S]*callback_1_due' = clock \+ 1/);
    expect(run(timerQuint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);

  it("normalizes static Node timeout delays to the documented integer range", () => {
    const model = analyzeAsyncPatterns("node-delay.ts", `
      function schedule() {
        setTimeout(() => undefined, 0)
        setTimeout(() => undefined, 1.9)
        setTimeout(() => undefined, 2147483648)
        setTimeout(() => undefined, -5)
        setTimeout(() => undefined, NaN)
      }
    `);
    const quint = generateNodeEventLoopQuint("node_delay", model);
    expect(quint).toMatch(/callback_0_due' = 1,/);
    expect(quint).toMatch(/callback_1_due' = 1,/);
    expect(quint).toMatch(/callback_2_due' = 1,/);
    expect(quint).toMatch(/callback_3_due' = 1,/);
    expect(quint).toMatch(/callback_4_due' = 1,/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);

  it("keeps node:fs authority while scheduling callback APIs in the poll phase", () => {
    const source = `
      import { readFile } from "node:fs"
      /* uneffect: effect FsRead<"settings.json"> */
      function load() {
        readFile("settings.json", "utf8", () => queueMicrotask(() => undefined))
      }
    `;
    const model = analyzeAsyncPatterns("node-fs-poll.ts", source);
    expect(analyzeEffects("node-fs-poll.ts", source)).toEqual([]);
    expect(model.timers).toMatchObject([
      { queue: "poll", externallyReady: true },
      { queue: "microtask", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_fs_poll", model);
    expect(quint).toContain("action complete_poll_0");
    expect(quint).toMatch(/action run_poll_0[\s\S]*node_phase == 2[\s\S]*callback_1_pending' = true/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);

  it("does not invent source-order FIFO for independent poll completions", () => {
    const model = analyzeAsyncPatterns("node-fs-order.ts", `
      import { readFile } from "node:fs"
      function load() {
        readFile("a", () => undefined)
        readFile("b", () => undefined)
      }
    `);
    const quint = generateNodeEventLoopQuint("node_fs_order", model);
    const second = quint.slice(quint.indexOf("action run_poll_1"), quint.indexOf("action advance_poll_to_check"));
    expect(second).not.toContain("not(callback_0_pending)");
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);

  it("registers a nested one-shot Node timeout only when its parent runs", () => {
    const model = analyzeAsyncPatterns("node-nested-timeout.ts", `
      function schedule() {
        setImmediate(() => setTimeout(() => undefined, 0))
      }
    `);
    expect(model.timers).toMatchObject([
      { queue: "check" },
      { queue: "timer", enqueuedBy: 0 },
    ]);
    const quint = generateNodeEventLoopQuint("node_nested_timeout", model);
    expect(quint).toMatch(/action init[\s\S]*callback_1_pending' = false/);
    expect(quint).toMatch(/action run_check_0[\s\S]*callback_1_pending' = true[\s\S]*callback_1_due' = clock \+ 1/);
    expect(run(quint, "nodeEventLoopSafe").status).toBe(0);
  }, 20_000);
});

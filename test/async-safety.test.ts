import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, composeResourceFailures, generateOwnershipObligationQuint, generateOwnershipObligationSmt, generateResourceSafetyQuint, generateUnifiedAsyncQuint } from "../src/async-safety.js";

function run(program: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-"));
  const path = join(directory, "model.qnt");
  writeFileSync(path, program);
  return spawnSync("pnpm", ["exec", "quint", "run", path,
    "--invariant=resourceSafe", "--max-steps=12", "--max-samples=400",
    "--seed=0x123456789abcdef", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
}

describe("async error and explicit resource safety", () => {
  it("reports floating rejecting Promise expressions and accepts explicit handling", () => {
    const result = analyzeAsyncSafety("floating.ts", `
      declare function task(): Promise<number>
      async function bad() { task() }
      async function awaited() { await task() }
      async function returned() { return task() }
      async function caught() { task().catch(() => 0) }
      async function rejectedHandler() { task().then(value => value, () => 0) }
      async function explicitlyIgnored() { void task() }
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ functionName: "bad", kind: "floating-promise", severity: "error" }),
    ]);
  });

  it("tracks Promise rejection ownership through bindings and aliases", () => {
    const result = analyzeAsyncSafety("binding-promises.ts", `
      declare function task(): Promise<number>
      declare const flag: boolean
      /* uneffect:
       * consumes_rejection 0
       */
      declare function consume(value: Promise<number>): void
      declare function inspect(value: Promise<number>): void
      function forward(value: Promise<number>) { consume(value) }
      function maybeForward(value: Promise<number>) { if (flag) consume(value) }
      async function bad() { const pending = task() }
      async function awaited() { const pending = task(); await pending }
      async function aliased() { const pending = task(); const alias = pending; alias.catch(() => 0) }
      async function returned() { const pending = task(); return pending }
      async function transferred() { const pending = task(); consume(pending) }
      async function borrowed() { const pending = task(); inspect(pending) }
      async function wrapped() { const pending = task(); forward(pending) }
      async function conditionallyWrapped() { const pending = task(); maybeForward(pending) }
      async function stored() { const pending = task(); const holder = { pending }; void holder }
    `);
    expect(result.promiseBindings.map(({ owner, binding, status }) => ({ owner, binding, status }))).toEqual([
      { owner: "bad", binding: "pending", status: "floating" },
      { owner: "awaited", binding: "pending", status: "observed" },
      { owner: "aliased", binding: "pending", status: "observed" },
      { owner: "aliased", binding: "alias", status: "observed" },
      { owner: "returned", binding: "pending", status: "observed" },
      { owner: "transferred", binding: "pending", status: "transferred" },
      { owner: "borrowed", binding: "pending", status: "floating" },
      { owner: "wrapped", binding: "pending", status: "transferred" },
      { owner: "conditionallyWrapped", binding: "pending", status: "floating" },
      { owner: "stored", binding: "pending", status: "transferred" },
    ]);
    expect(result.diagnostics.filter((item) => item.kind === "floating-promise")).toEqual([
      expect.objectContaining({ functionName: "bad", message: expect.stringContaining("pending") }),
      expect.objectContaining({ functionName: "borrowed", message: expect.stringContaining("pending") }),
      expect.objectContaining({ functionName: "conditionallyWrapped", message: expect.stringContaining("pending") }),
    ]);
    const strictVoid = analyzeAsyncSafety("strict-void.ts", `
      declare function task(): Promise<void>
      function ignored() { const pending = task(); void pending }
    `, { allowVoid: false });
    expect(strictVoid.diagnostics).toContainEqual(expect.objectContaining({ functionName: "ignored", kind: "floating-promise" }));
  });

  it("rejects malformed and out-of-range rejection ownership contracts", () => {
    const result = analyzeAsyncSafety("invalid-ownership-contract.ts", `
      /* uneffect: consumes_rejection first */
      declare function malformed(value: Promise<void>): void
      /* uneffect: consumes_rejection 1 */
      declare function outOfRange(value: Promise<void>): void
      /* uneffect: consumes_rejection 0, 0 */
      declare function valid(value: Promise<void>): void
      /* uneffect: consumes_rejection_when nope */
      declare function malformedConditional(value: Promise<void>): void
      /* uneffect: consumes_callback_rejection_when 0: missing */
      declare function missingGuard(callback: () => Promise<void>): void
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ functionName: "malformed", kind: "invalid-ownership-contract", line: 2 }),
      expect.objectContaining({ functionName: "outOfRange", kind: "invalid-ownership-contract", line: 4 }),
      expect.objectContaining({ functionName: "malformedConditional", kind: "invalid-ownership-contract", line: 8 }),
      expect.objectContaining({ functionName: "missingGuard", kind: "invalid-ownership-contract", line: 10 }),
    ]);
  });

  it("requires higher-order callees to own Promise-returning callback rejections", () => {
    const result = analyzeAsyncSafety("callback-ownership.ts", `
      declare function unsafeSchedule(callback: () => Promise<void>): void
      /* uneffect: consumes_callback_rejection 0 */
      declare function safeSchedule(callback: () => Promise<void>): void
      function forwardSchedule(callback: () => Promise<void>) { safeSchedule(callback) }
      function maybeSchedule(callback: () => Promise<void>) { if (Math.random()) safeSchedule(callback) }
      async function namedTask() {}
      unsafeSchedule(async () => {})
      safeSchedule(async () => {})
      forwardSchedule(namedTask)
      maybeSchedule(namedTask)
      Promise.resolve().then(async () => {})
      ;[1, 2].forEach(async () => {})
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "floating-callback-promise", line: 8, message: expect.stringContaining("unsafeSchedule") }),
      expect.objectContaining({ kind: "floating-callback-promise", line: 11, message: expect.stringContaining("maybeSchedule") }),
      expect.objectContaining({ kind: "floating-callback-promise", line: 13, message: expect.stringContaining("forEach") }),
    ]);
  });

  it("discharges conditional ownership only when the call proves its guard", () => {
    const result = analyzeAsyncSafety("conditional-ownership.ts", `
      declare const flag: boolean
      declare function task(): Promise<void>
      /* uneffect: consumes_rejection_when 1: enabled */
      declare function maybeConsume(enabled: boolean, value: Promise<void>): void
      /* uneffect: consumes_callback_rejection_when 1: enabled */
      declare function maybeSchedule(enabled: boolean, callback: () => Promise<void>): void
      /* uneffect: consumes_rejection_when 2: enabled && active */
      declare function consumeWhenActive(enabled: boolean, active: boolean, value: Promise<void>): void
      async function proven() { const pending = task(); maybeConsume(true, pending) }
      async function disproven() { const pending = task(); maybeConsume(false, pending) }
      async function unknown() { const pending = task(); maybeConsume(flag, pending) }
      async function narrowed(enabled: boolean) {
        if (!enabled) return
        const pending = task()
        maybeConsume(enabled, pending)
      }
      /* uneffect: requires enabled === true */
      async function required(enabled: boolean) {
        const pending = task()
        maybeConsume(enabled, pending)
      }
      /* uneffect: requires enabled && active */
      async function compositeProven(enabled: boolean, active: boolean) {
        const pending = task()
        consumeWhenActive(enabled, active, pending)
      }
      /* uneffect: requires enabled */
      async function compositeUnknown(enabled: boolean, active: boolean) {
        const pending = task()
        consumeWhenActive(enabled, active, pending)
      }
      maybeSchedule(true, async () => {})
      maybeSchedule(false, async () => {})
      maybeSchedule(flag, async () => {})
      function narrowedCallback(enabled: boolean) {
        if (!enabled) return
        maybeSchedule(enabled, async () => {})
      }
      /* uneffect: requires enabled */
      function requiredCallback(enabled: boolean) {
        maybeSchedule(enabled, async () => {})
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "proven", status: "transferred" },
      { owner: "disproven", status: "floating" },
      { owner: "unknown", status: "floating" },
      { owner: "narrowed", status: "transferred" },
      { owner: "required", status: "transferred" },
      { owner: "compositeProven", status: "transferred" },
      { owner: "compositeUnknown", status: "floating" },
    ]);
    expect(result.diagnostics.filter((item) => item.kind === "floating-callback-promise")).toEqual([
      expect.objectContaining({ line: 34, message: expect.stringContaining("maybeSchedule") }),
      expect.objectContaining({ line: 35, message: expect.stringContaining("maybeSchedule") }),
    ]);
    const proven = result.ownershipObligations.find((item) => item.owner === "compositeProven")!;
    const unresolved = result.ownershipObligations.find((item) => item.owner === "compositeUnknown")!;
    expect(proven).toMatchObject({ ownership: "promise", parameter: 2, status: "verified", evidence: "finite-propositional" });
    expect(unresolved).toMatchObject({ ownership: "promise", parameter: 2, status: "unresolved", evidence: "unknown" });
    expect(spawnSync("z3", ["-in"], { input: generateOwnershipObligationSmt(proven), encoding: "utf8" }).stdout.trim()).toBe("unsat");
    expect(spawnSync("z3", ["-in"], { input: generateOwnershipObligationSmt(unresolved), encoding: "utf8" }).stdout.trim()).toBe("sat");
    expect(generateOwnershipObligationQuint("ownership_guard", proven)).toContain("val ownershipSafe");
  });

  it("requires Promise bindings to be observed on every reachable branch", () => {
    const result = analyzeAsyncSafety("branch-promises.ts", `
      declare const flag: boolean
      declare function task(): Promise<number>
      async function oneBranch() {
        const pending = task()
        if (flag) await pending
      }
      async function bothBranches() {
        const pending = task()
        if (flag) await pending
        else pending.catch(() => 0)
      }
      async function afterJoin() {
        const pending = task()
        if (flag) console.log("branch")
        await pending
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "oneBranch", status: "floating" },
      { owner: "bothBranches", status: "observed" },
      { owner: "afterJoin", status: "observed" },
    ]);
    expect(result.diagnostics.filter((item) => item.kind === "floating-promise")).toEqual([
      expect.objectContaining({ functionName: "oneBranch" }),
    ]);
  });

  it("detects unresolved reassignment and zero-iteration loop paths", () => {
    const result = analyzeAsyncSafety("flow-promises.ts", `
      declare const flag: boolean
      declare function task(): Promise<number>
      async function overwritten() {
        let pending = task()
        pending = task()
        await pending
      }
      async function loopOnly() {
        const pending = task()
        while (flag) { await pending; break }
      }
      async function afterLoop() {
        const pending = task()
        while (flag) console.log("tick")
        await pending
      }
      async function doLoop() {
        const pending = task()
        do { await pending } while (flag)
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "overwritten", status: "floating" },
      { owner: "loopOnly", status: "floating" },
      { owner: "afterLoop", status: "observed" },
      { owner: "doLoop", status: "observed" },
    ]);
  });

  it("propagates break and continue through loop fixed points", () => {
    const result = analyzeAsyncSafety("loop-control-promises.ts", `
      declare const flag: boolean
      declare function task(): Promise<number>
      async function broken() {
        const pending = task()
        do { if (flag) break; await pending } while (flag)
      }
      async function continued() {
        const pending = task()
        do { if (flag) continue; await pending } while (false)
      }
      async function labeled() {
        const pending = task()
        outer: do { do { break outer } while (flag); await pending } while (flag)
      }
      async function labeledThroughSwitch() {
        const pending = task()
        outer: do { switch (1) { case 1: break outer }; await pending } while (flag)
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "broken", status: "floating" },
      { owner: "continued", status: "floating" },
      { owner: "labeled", status: "floating" },
      { owner: "labeledThroughSwitch", status: "floating" },
    ]);
  });

  it("tracks rejection ownership from deferred Promise assignments and aliases", () => {
    const result = analyzeAsyncSafety("deferred-promises.ts", `
      declare const enabled: boolean
      declare function task(): Promise<number>
      async function floating() {
        let pending: Promise<number>
        pending = task()
      }
      async function observed() {
        let pending: Promise<number>
        pending = task()
        await pending
      }
      async function aliased() {
        let pending: Promise<number>
        let alias: Promise<number>
        pending = task()
        alias = pending
        return alias
      }
      async function branchOwned() {
        let pending: Promise<number>
        if (enabled) {
          pending = task()
          pending.catch(() => 0)
        }
      }
      async function branchFloating() {
        let pending: Promise<number>
        if (enabled) pending = task()
      }
    `);
    expect(result.promiseBindings.map(({ owner, binding, status }) => ({ owner, binding, status }))).toEqual([
      { owner: "floating", binding: "pending", status: "floating" },
      { owner: "observed", binding: "pending", status: "observed" },
      { owner: "aliased", binding: "pending", status: "observed" },
      { owner: "aliased", binding: "alias", status: "observed" },
      { owner: "branchOwned", binding: "pending", status: "observed" },
      { owner: "branchFloating", binding: "pending", status: "floating" },
    ]);
    expect(result.diagnostics.filter(({ kind }) => kind === "floating-promise")).toEqual([
      expect.objectContaining({ functionName: "floating", line: 6 }),
      expect.objectContaining({ functionName: "branchFloating", line: 29 }),
    ]);
  });

  it("requires Promise bindings to be observed across switch entry and fallthrough paths", () => {
    const result = analyzeAsyncSafety("switch-promises.ts", `
      declare function task(): Promise<number>
      async function covered(kind: "await" | "catch") {
        const pending = task()
        switch (kind) {
          case "await": await pending; break
          case "catch": pending.catch(() => 0); break
        }
      }
      async function missing(kind: "await" | "skip") {
        const pending = task()
        switch (kind) {
          case "await": await pending; break
          case "skip": break
        }
      }
      async function fallthrough(kind: "observe" | "shared") {
        const pending = task()
        switch (kind) {
          case "observe": console.log("before")
          case "shared": await pending; break
        }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "covered", status: "observed" },
      { owner: "missing", status: "floating" },
      { owner: "fallthrough", status: "observed" },
    ]);
  });

  it("runs finally on normal, caught, and early-return Promise ownership paths", () => {
    const result = analyzeAsyncSafety("finally-promises.ts", `
      declare function task(): Promise<number>
      declare function mayThrow(): void
      async function finallyOwns(flag: boolean) {
        const pending = task()
        try { if (flag) return } finally { await pending }
      }
      async function catchGap() {
        const pending = task()
        try { mayThrow(); await pending } catch { console.log("ignored") }
      }
      async function bothOwn() {
        const pending = task()
        try { mayThrow(); await pending } catch { pending.catch(() => 0) }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "finallyOwns", status: "observed" },
      { owner: "catchGap", status: "floating" },
      { owner: "bothOwn", status: "observed" },
    ]);
  });

  it("connects awaited rejection to the nearest catch and leaves bare Promise calls uncaught", () => {
    const result = analyzeAsyncSafety("catch.ts", `
      declare function task(): Promise<number>
      async function handled() { try { await task().then(value => Promise.resolve(value + 1)) } catch {} }
      async function escapes() { await task() }
      async function notCaught() { try { task() } catch {} }
    `);
    expect(result.promises).toEqual([
      expect.objectContaining({ owner: "handled", source: expect.stringContaining(".then("), observation: "await", catchesRejection: true }),
      expect.objectContaining({ owner: "escapes", observation: "await", catchesRejection: false }),
      expect.objectContaining({ owner: "notCaught", observation: "floating", catchesRejection: false }),
    ]);
  });

  it("models using and await using as reverse-order cleanup on every exit", () => {
    const result = analyzeAsyncSafety("using.ts", `
      interface SyncResource { [Symbol.dispose](): void }
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function openSync(): SyncResource
      declare function openAsync(): Promise<AsyncResource>
      async function work() {
        using first = openSync()
        await using second = await openAsync()
        if (Math.random()) throw new Error("exit")
      }
    `);
    expect(result.resources).toMatchObject([
      { owner: "work", binding: "first", asynchronous: false, acquisitionIndex: 0 },
      { owner: "work", binding: "second", asynchronous: true, acquisitionIndex: 1 },
    ]);
    expect(result.disposals.map(({ binding, order, asynchronous, exits }) => ({ binding, order, asynchronous, exits }))).toEqual([
      { binding: "second", order: 0, asynchronous: true, exits: ["normal", "return", "throw", "reject"] },
      { binding: "first", order: 1, asynchronous: false, exits: ["normal", "return", "throw", "reject"] },
    ]);
    expect(result.diagnostics).toEqual([]);

    const positive = run(generateResourceSafetyQuint("resources", result));
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    expect(generateResourceSafetyQuint("resources", result)).toContain("dispose_start_1");
    expect(generateResourceSafetyQuint("resources", result)).toContain("dispose_resume_1");
    const broken = run(generateResourceSafetyQuint("resources_broken", result, { skipDisposal: true }));
    expect(broken.status).not.toBe(0);
    expect(broken.stdout + broken.stderr).toMatch(/violation|counterexample/i);
    const nonAwaited = run(generateResourceSafetyQuint("resources_nonawaited", result, { skipAwaitDisposal: true }));
    expect(nonAwaited.status).not.toBe(0);
    expect(nonAwaited.stdout + nonAwaited.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);

  it("rejects resources without the required disposal protocol", () => {
    const result = analyzeAsyncSafety("invalid-using.ts", `
      declare function open(): { close(): void }
      function work() { using resource = open() }
    `);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ kind: "invalid-disposable", severity: "error" }));
  });

  it("recognizes disposal protocols by standard symbol identity, not spelling", () => {
    const result = analyzeAsyncSafety("symbol-identity.ts", `
      const FakeSymbol = { dispose: "dispose" as const }
      class Fake { [FakeSymbol.dispose](): void {} }
      interface Base { [Symbol.dispose](): void }
      interface Derived extends Base {}
      const disposeAlias: typeof Symbol.dispose = Symbol.dispose
      class Aliased { [disposeAlias](): void {} }
      declare function inherited(): Derived
      declare function intersection(): Base & { tag: string }
      function generic<T extends Base>(input: T) {
        using constrained = input
      }
      function work() {
        using fake = new Fake()
        using valid = inherited()
        using aliased = new Aliased()
        using intersected = intersection()
      }
    `);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: "invalid-disposable", message: expect.stringContaining("fake") }),
    ]);
    expect(result.resources.map(({ binding, disposalFailureType }) => ({ binding, disposalFailureType }))).toEqual([
      { binding: "constrained", disposalFailureType: "unknown" },
      { binding: "fake", disposalFailureType: "unknown" },
      { binding: "valid", disposalFailureType: "unknown" },
      { binding: "aliased", disposalFailureType: "unknown" },
      { binding: "intersected", disposalFailureType: "unknown" },
    ]);
  });

  it("places lexical-scope disposals and cleans only successfully acquired resources", () => {
    const result = analyzeAsyncSafety("scopes.ts", `
      interface Resource { [Symbol.dispose](): void }
      declare function open(name: string): Resource
      function work() {
        using outer = open("outer")
        {
          using innerA = open("a")
          using innerB = open("b")
        }
      }
    `);
    expect(result.resources.map(({ binding, scopeDepth }) => ({ binding, scopeDepth }))).toEqual([
      { binding: "outer", scopeDepth: 0 },
      { binding: "innerA", scopeDepth: 1 },
      { binding: "innerB", scopeDepth: 1 },
    ]);
    expect(result.disposals.map(({ binding, order, scopeDepth }) => ({ binding, order, scopeDepth }))).toEqual([
      { binding: "innerB", order: 0, scopeDepth: 1 },
      { binding: "innerA", order: 1, scopeDepth: 1 },
      { binding: "outer", order: 0, scopeDepth: 0 },
    ]);
    const quint = generateResourceSafetyQuint("partial", result);
    expect(quint).toContain("acquire_fail_1");
    expect(quint).toContain("skip_unacquired_2");
    const positive = run(quint);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    expect(quint).toContain("dispose_fail_escapes_2");
    expect(quint).toContain("if (completion == 0) 2 else 3");
    const brokenSuppression = run(generateResourceSafetyQuint("broken_suppression", result, { breakSuppressedError: true }));
    expect(brokenSuppression.status).not.toBe(0);
    expect(brokenSuppression.stdout + brokenSuppression.stderr).toMatch(/violation|counterexample/i);

    const duplicated = run(generateResourceSafetyQuint("duplicate_disposal", result, { duplicateDisposal: true }));
    expect(duplicated.status).not.toBe(0);
    expect(duplicated.stdout + duplicated.stderr).toMatch(/violation|counterexample/i);
    const reordered = run(generateResourceSafetyQuint("reordered_disposal", result, { reorderDisposal: true }));
    expect(reordered.status).not.toBe(0);
    expect(reordered.stdout + reordered.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);

  it("routes disposal failure through an enclosing catch or out as rejection", () => {
    const result = analyzeAsyncSafety("dispose-catch.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<AsyncResource>
      async function handled() {
        try { await using resource = await open() } catch {}
      }
      async function escapes() {
        await using resource = await open()
      }
    `);
    expect(result.disposals.map(({ owner, catchesFailure, escapingFailure }) => ({ owner, catchesFailure, escapingFailure }))).toEqual([
      { owner: "handled", catchesFailure: true, escapingFailure: "none" },
      { owner: "escapes", catchesFailure: false, escapingFailure: "reject" },
    ]);
    const quint = generateResourceSafetyQuint("dispose_catch", result);
    expect(quint).toContain("dispose_reject_caught_0");
    expect(quint).toContain("dispose_reject_escapes_1");
  });

  it("preserves exact nested SuppressedError payload order and types", () => {
    const result = analyzeAsyncSafety("suppressed.ts", `
      class FirstError extends Error {}
      class SecondError extends Error {}
      class PrimaryError extends Error {}
      class First {
        /* uneffect: effect Throw<FirstError> */
        [Symbol.dispose](): void { throw new FirstError() }
      }
      class Second {
        /* uneffect: effect Throw<SecondError> */
        [Symbol.dispose](): void { throw new SecondError() }
      }
      function work() {
        using first = new First()
        using second = new Second()
        throw new PrimaryError()
      }
    `);
    expect(result.disposals.map(({ binding, failureType }) => ({ binding, failureType }))).toEqual([
      { binding: "second", failureType: "SecondError" },
      { binding: "first", failureType: "FirstError" },
    ]);
    expect(composeResourceFailures(result, "work", "PrimaryError", ["second", "first"])).toEqual({
      kind: "suppressed",
      error: { kind: "error", errorType: "FirstError", source: "dispose:first" },
      suppressed: {
        kind: "suppressed",
        error: { kind: "error", errorType: "SecondError", source: "dispose:second" },
        suppressed: { kind: "error", errorType: "PrimaryError", source: "body" },
      },
    });
  });

  it("composes Promise chains, await catch routing, return, and async disposal", () => {
    const result = analyzeAsyncSafety("composed-async.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<Resource>
      declare function recover(error: unknown): string
      async function run() {
        await using resource = await open()
        try {
          return await new Promise<string>((resolve) => resolve("ok"))
            .then(value => Promise.resolve(value))
        } catch (error) {
          return recover(error)
        }
      }
    `);
    const awaitedChain = result.promises.find((item) => item.source.includes("new Promise"));
    expect(awaitedChain).toMatchObject({ owner: "run", observation: "await", catchesRejection: true, promiseChain: 0 });
    expect(result.controlEdges).toEqual(expect.arrayContaining([
      { owner: "run", from: "promise:0:fulfilled", to: "await:resume", kind: "promise-fulfill" },
      { owner: "run", from: "promise:0:rejected", to: "catch", kind: "promise-reject-caught" },
      { owner: "run", from: "return", to: "dispose:resource", kind: "scope-exit" },
      { owner: "run", from: "dispose:resource:rejected", to: "function:rejected", kind: "disposal-reject-escapes" },
    ]));
    const quint = generateUnifiedAsyncQuint("composed_async", result, "run");
    expect(quint).toContain("action promise_0_reject_caught");
    expect(quint).toContain("action catch_return");
    expect(quint).toContain("action dispose_start_resource");
    expect(quint).toContain("action dispose_reject_resource");
    expect(quint).toContain("action finish_rejected");
    const positive = run(quint);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    const broken = run(generateUnifiedAsyncQuint("composed_async_broken", result, "run", { skipCleanup: true }));
    expect(broken.status).not.toBe(0);
    expect(broken.stdout + broken.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);

  it("preserves concrete catch and finally statement order in the unified graph", () => {
    const result = analyzeAsyncSafety("sequenced-finally.ts", `
      declare function note(value: string): void
      async function run() {
        try { await new Promise<string>((resolve) => resolve("ok")).then(value => value) }
        catch (error) { note("caught"); note("recovered") }
        finally { note("closing"); note("closed") }
      }
    `);
    expect(result.controlStatements.map(({ region, source }) => ({ region, source }))).toEqual([
      { region: "catch", source: 'note("caught");' },
      { region: "catch", source: 'note("recovered")' },
      { region: "finally", source: 'note("closing");' },
      { region: "finally", source: 'note("closed")' },
    ]);
    const quint = generateUnifiedAsyncQuint("sequenced_finally", result, "run");
    expect(quint.indexOf("action catch_statement_0")).toBeLessThan(quint.indexOf("action catch_statement_1"));
    expect(quint.indexOf("action finally_statement_0")).toBeLessThan(quint.indexOf("action finally_statement_1"));
    expect(quint).toContain("action await_resume_finally");
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("sequences multiple awaited Promise chains before async disposal", () => {
    const result = analyzeAsyncSafety("multiple-awaits.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<Resource>
      async function run() {
        await using resource = await open()
        await Promise.resolve("first").then(value => value)
        await Promise.resolve("second").then(value => value)
      }
    `);
    const awaited = result.promises.filter((item) => item.owner === "run" && item.observation === "await" && item.promiseChain !== undefined);
    expect(awaited).toHaveLength(2);
    const quint = generateUnifiedAsyncQuint("multiple_awaits", result, "run");
    const first = awaited[0]!.promiseChain!;
    const second = awaited[1]!.promiseChain!;
    expect(quint).toContain(`action promise_${first}_fulfill`);
    expect(quint).toContain(`action await_${first}_resume_next`);
    expect(quint).toContain(`action promise_${second}_fulfill`);
    expect(quint.indexOf(`action promise_${first}_fulfill`)).toBeLessThan(quint.indexOf(`action promise_${second}_fulfill`));
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("disposes a nested async resource before the next outer await", () => {
    const result = analyzeAsyncSafety("nested-await-scope.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function run() {
        {
          await using inner = open()
          await Promise.resolve("inside").then(value => value)
        }
        await Promise.resolve("outside").then(value => value)
      }
    `);
    const awaited = result.promises.filter((item) => item.owner === "run" && item.observation === "await" && item.promiseChain !== undefined);
    const quint = generateUnifiedAsyncQuint("nested_await_scope", result, "run");
    expect(quint).toContain("action dispose_start_inner_scope_exit");
    expect(quint).toContain("action dispose_resume_inner_scope_exit");
    expect(quint.indexOf("action dispose_resume_inner_scope_exit")).toBeLessThan(quint.indexOf(`action promise_${awaited[1]!.promiseChain}_fulfill`));
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("disposes a synchronous inner scope before the first awaited chain", () => {
    const result = analyzeAsyncSafety("scope-before-await.ts", `
      interface Resource { [Symbol.dispose](): void }
      declare function open(): Resource
      async function run() {
        { using inner = open() }
        await Promise.resolve("outside").then(value => value)
      }
    `);
    const awaited = result.promises.find((item) => item.owner === "run" && item.observation === "await" && item.promiseChain !== undefined)!;
    const quint = generateUnifiedAsyncQuint("scope_before_await", result, "run");
    expect(quint).toContain("action dispose_inner_scope_exit");
    expect(quint.indexOf("action dispose_inner_scope_exit")).toBeLessThan(quint.indexOf(`action promise_${awaited.promiseChain}_fulfill`));
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("routes nested scope disposal rejection through its catch before an outer await", () => {
    const result = analyzeAsyncSafety("caught-scope-disposal.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare function note(value: string): void
      async function run() {
        try {
          await using inner = open()
          await Promise.resolve("inside").then(value => value)
        } catch (error) {
          note("caught")
        }
        await Promise.resolve("outside").then(value => value)
      }
    `);
    const quint = generateUnifiedAsyncQuint("caught_scope_disposal", result, "run");
    const rejectionTarget = /action dispose_reject_inner_scope_exit = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    const catchEntry = /action catch_statement_0 = all \{\s*pc == (-?\d+),/.exec(quint)?.[1];
    const catchContinuation = /action catch_return = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    const outerAwaitEntry = new RegExp(`action promise_${result.promises.filter((item) => item.owner === "run" && item.observation === "await")[1]!.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(rejectionTarget).toBeDefined();
    expect(rejectionTarget).toBe(catchEntry);
    expect(catchContinuation).toBe(outerAwaitEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("acquires a resource between the awaited chains surrounding its declaration", () => {
    const result = analyzeAsyncSafety("acquire-between-awaits.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function run() {
        await Promise.resolve("before").then(value => value)
        await using resource = open()
        await Promise.resolve("after").then(value => value)
      }
    `);
    const awaited = result.promises.filter((item) => item.owner === "run" && item.observation === "await" && item.promiseChain !== undefined);
    const quint = generateUnifiedAsyncQuint("acquire_between_awaits", result, "run");
    const before = quint.indexOf(`action promise_${awaited[0]!.promiseChain}_fulfill`);
    const acquire = quint.indexOf("action acquire_resource");
    const after = quint.indexOf(`action promise_${awaited[1]!.promiseChain}_fulfill`);
    expect(before).toBeLessThan(acquire);
    expect(acquire).toBeLessThan(after);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("keeps conditional resource acquisition optional on the straight-line abstraction", () => {
    const result = analyzeAsyncSafety("conditional-resource.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function run(enabled: boolean) {
        if (enabled) {
          await using resource = open()
          await Promise.resolve("inside").then(value => value)
        }
        await Promise.resolve("outside").then(value => value)
      }
    `);
    expect(result.resources[0]).toMatchObject({ binding: "resource", conditional: true, controlConditions: [{ expected: true }] });
    const inside = result.promises.find((item) => item.source.includes('"inside"'))!;
    expect(inside).toMatchObject({ conditional: true, controlConditions: result.resources[0]!.controlConditions });
    const quint = generateUnifiedAsyncQuint("conditional_resource", result, "run");
    expect(quint).toContain("var branch_0: int");
    expect(quint).toMatch(/action acquire_resource = all \{\s*pc == \d+,\s*branch_0 == 1,/);
    expect(quint).toContain("action skip_acquire_resource");
    expect(quint).toMatch(new RegExp(`action skip_await_${inside.promiseChain} = all \\{\\s*pc == \\d+,\\s*branch_0 == 0,`));
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("uses opposite polarity of one branch choice for then and else awaits", () => {
    const result = analyzeAsyncSafety("if-else-await.ts", `
      async function run(enabled: boolean) {
        if (enabled) {
          await Promise.resolve("then").then(value => value)
        } else {
          await Promise.resolve("else").then(value => value)
        }
      }
    `);
    const thenAwait = result.promises.find((item) => item.source.includes('"then"'))!;
    const elseAwait = result.promises.find((item) => item.source.includes('"else"'))!;
    expect(thenAwait.controlConditions).toEqual([{ id: expect.any(String), expected: true }]);
    expect(elseAwait.controlConditions).toEqual([{ id: thenAwait.controlConditions[0]!.id, expected: false }]);
    const quint = generateUnifiedAsyncQuint("if_else_await", result, "run");
    expect(quint).toMatch(new RegExp(`action promise_${thenAwait.promiseChain}_fulfill = all \\{\\s*pc == \\d+,\\s*branch_0 == 1,`));
    expect(quint).toMatch(new RegExp(`action promise_${elseAwait.promiseChain}_fulfill = all \\{\\s*pc == \\d+,\\s*branch_0 == 0,`));
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("does not resume an outer await after a return from catch", () => {
    const result = analyzeAsyncSafety("catch-return.ts", `
      async function run() {
        try {
          await Promise.reject(new Error("fail"))
        } catch (error) {
          return "recovered"
        }
        await Promise.resolve("unreachable").then(value => value)
      }
    `);
    expect(result.controlStatements).toContainEqual(expect.objectContaining({ region: "catch", completion: "return" }));
    const outerObservation = result.promises.find((item) => item.owner === "run" && item.source.includes('"unreachable"') && item.promiseChain !== undefined)!;
    const quint = generateUnifiedAsyncQuint("catch_return_exit", result, "run");
    const catchTarget = /action catch_statement_0 = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    const outerAwait = new RegExp(`action promise_${outerObservation.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(catchTarget).toBeDefined();
    expect(catchTarget).not.toBe(outerAwait);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("executes an awaited catch statement only after caught rejection", () => {
    const result = analyzeAsyncSafety("catch-await.ts", `
      declare function note(value: string): void
      async function run() {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("fail") })
        } catch (error) {
          await Promise.resolve("recover").then(value => value)
          note("caught")
        }
        await Promise.resolve("outer").then(value => value)
      }
    `);
    const tried = result.promises.find((item) => item.source.includes('"try"') && item.promiseChain !== undefined)!;
    const recovered = result.promises.find((item) => item.source.includes('"recover"') && item.promiseChain !== undefined)!;
    const quint = generateUnifiedAsyncQuint("catch_await", result, "run");
    const caughtTarget = new RegExp(`action promise_${tried.promiseChain}_reject_caught = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const recoverEntry = new RegExp(`action promise_${recovered.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(caughtTarget).toBe(recoverEntry);
    expect(quint).not.toContain(`action skip_await_${recovered.promiseChain}`);
    expect(quint.indexOf(`action promise_${tried.promiseChain}_reject_caught`)).toBeLessThan(quint.indexOf(`action promise_${recovered.promiseChain}_fulfill`));
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("runs an awaited finally statement before the following outer await", () => {
    const result = analyzeAsyncSafety("finally-await.ts", `
      async function run() {
        try {
          await Promise.resolve("try").then(value => value)
        } finally {
          await Promise.resolve("finally").then(value => value)
        }
        await Promise.resolve("outer").then(value => value)
      }
    `);
    const tried = result.promises.find((item) => item.source.includes('"try"'))!;
    const finalized = result.promises.find((item) => item.source.includes('"finally"'))!;
    const outer = result.promises.find((item) => item.source.includes('"outer"'))!;
    const quint = generateUnifiedAsyncQuint("finally_await", result, "run");
    const tryResumeTarget = new RegExp(`action await_${tried.promiseChain}_resume_next = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const finallyEntry = new RegExp(`action promise_${finalized.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    const finallyResumeTarget = new RegExp(`action finally_await_${finalized.promiseChain}_resume = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const outerEntry = new RegExp(`action promise_${outer.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(tryResumeTarget).toBe(finallyEntry);
    expect(finallyResumeTarget).toBe(outerEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("routes return-await fulfillment and rejection through awaited finally", () => {
    const result = analyzeAsyncSafety("return-await-finally.ts", `
      async function run() {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("fail") })
        } catch (error) {
          return await Promise.resolve("recover").then(value => value)
        } finally {
          await Promise.resolve("close").then(value => value)
        }
      }
    `);
    const recovered = result.promises.find((item) => item.source.includes('"recover"'))!;
    const closed = result.promises.find((item) => item.source.includes('"close"'))!;
    const quint = generateUnifiedAsyncQuint("return_await_finally", result, "run");
    const recoverResume = new RegExp(`action catch_await_${recovered.promiseChain}_resume = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const recoverReject = new RegExp(`action promise_${recovered.promiseChain}_reject_escapes = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const finallyEntry = new RegExp(`action promise_${closed.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(recoverResume).toBe(finallyEntry);
    expect(recoverReject).toBe(finallyEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("routes two sequential try rejections to distinct catch regions", () => {
    const result = analyzeAsyncSafety("two-catches.ts", `
      declare function note(value: string): void
      async function run() {
        try {
          await new Promise<string>((resolve) => resolve("first")).then(() => { throw new Error("first") })
        } catch (error) {
          note("caught-first")
        }
        try {
          await new Promise<string>((resolve) => resolve("second")).then(() => { throw new Error("second") })
        } catch (error) {
          note("caught-second")
        }
      }
    `);
    expect(result.controlRegions).toHaveLength(2);
    expect(result.controlStatements.map((item) => item.regionId)).toEqual([
      result.controlRegions[0]!.id,
      result.controlRegions[1]!.id,
    ]);
    const first = result.promises.find((item) => item.source.includes('"first"'))!;
    const second = result.promises.find((item) => item.source.includes('"second"'))!;
    const quint = generateUnifiedAsyncQuint("two_catches", result, "run");
    const firstTarget = new RegExp(`action promise_${first.promiseChain}_reject_caught = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const secondTarget = new RegExp(`action promise_${second.promiseChain}_reject_caught = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    expect(firstTarget).toBeDefined();
    expect(secondTarget).toBeDefined();
    expect(firstTarget).not.toBe(secondTarget);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("routes a nested try rejection to the innermost catch region", () => {
    const result = analyzeAsyncSafety("nested-catches.ts", `
      declare function note(value: string): void
      async function run() {
        try {
          try {
            await new Promise<string>((resolve) => resolve("inner")).then(() => { throw new Error("inner") })
          } catch (error) {
            note("caught-inner")
          }
        } catch (error) {
          note("caught-outer")
        }
      }
    `);
    const observation = result.promises.find((item) => item.source.includes('"inner"'))!;
    const inner = result.controlRegions
      .slice()
      .sort((left, right) => (left.trySpan.end - left.trySpan.start) - (right.trySpan.end - right.trySpan.start))[0]!;
    const innerStatement = result.controlStatements.find((item) => item.regionId === inner.id)!;
    const quint = generateUnifiedAsyncQuint("nested_catches", result, "run");
    const rejectionTarget = new RegExp(`action promise_${observation.promiseChain}_reject_caught = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const statementIndex = result.controlStatements.filter((item) => item.regionId === inner.id && item.region === "catch").indexOf(innerStatement);
    const regionIndex = result.controlRegions.filter((item) => item.owner === "run").findIndex((item) => item.id === inner.id);
    const catchEntry = new RegExp(`action catch_statement_${statementIndex}_${regionIndex} = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(rejectionTarget).toBe(catchEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("propagates an inner catch throw to the enclosing catch region", () => {
    const result = analyzeAsyncSafety("nested-rethrow.ts", `
      declare function note(value: string): void
      async function run() {
        try {
          try {
            await new Promise<string>((resolve) => resolve("inner")).then(() => { throw new Error("inner") })
          } catch (error) {
            throw error
          }
        } catch (error) {
          note("caught-outer")
        }
      }
    `);
    const quint = generateUnifiedAsyncQuint("nested_rethrow", result, "run");
    const innerThrowTarget = /action catch_statement_0_1 = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    const outerCatchEntry = /action catch_statement_0_0 = all \{\s*pc == (-?\d+),/.exec(quint)?.[1];
    expect(innerThrowTarget).toBe(outerCatchEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("propagates an awaited inner handler rejection to the enclosing catch", () => {
    const result = analyzeAsyncSafety("nested-handler-rejection.ts", `
      declare function note(value: string): void
      async function run() {
        try {
          try {
            await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
          } catch (error) {
            await new Promise<string>((resolve) => resolve("handler")).then(() => { throw new Error("handler") })
          }
        } catch (error) {
          note("caught-outer")
        }
      }
    `);
    const handler = result.promises.find((item) => item.source.includes('"handler"'))!;
    const quint = generateUnifiedAsyncQuint("nested_handler_rejection", result, "run");
    const handlerRejectTarget = new RegExp(`action promise_${handler.promiseChain}_reject_escapes = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const outerCatchEntry = /action catch_statement_0_0 = all \{\s*pc == (-?\d+),/.exec(quint)?.[1];
    expect(handlerRejectTarget).toBe(outerCatchEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("propagates an awaited inner finally rejection to the enclosing catch", () => {
    const result = analyzeAsyncSafety("nested-finally-rejection.ts", `
      declare function note(value: string): void
      async function run() {
        try {
          try {
            await Promise.resolve("try").then(value => value)
          } finally {
            await new Promise<string>((resolve) => resolve("finally")).then(() => { throw new Error("finally") })
          }
        } catch (error) {
          note("caught-outer")
        }
      }
    `);
    const finalized = result.promises.find((item) => item.source.includes('"finally"'))!;
    const quint = generateUnifiedAsyncQuint("nested_finally_rejection", result, "run");
    const rejectTarget = new RegExp(`action promise_${finalized.promiseChain}_reject_escapes = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const outerCatchEntry = /action catch_statement_0_0 = all \{\s*pc == (-?\d+),/.exec(quint)?.[1];
    expect(rejectTarget).toBe(outerCatchEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("preserves an inner throw through a normally completing finally", () => {
    const result = analyzeAsyncSafety("nested-rethrow-finally.ts", `
      declare function note(value: string): void
      async function run() {
        try {
          try {
            await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
          } catch (error) {
            throw error
          } finally {
            note("finalized")
          }
        } catch (error) {
          note("caught-outer")
        }
      }
    `);
    const quint = generateUnifiedAsyncQuint("nested_rethrow_finally", result, "run");
    const outerCatchEntry = /action catch_statement_0_0 = all \{\s*pc == (-?\d+),/.exec(quint)?.[1];
    expect(quint).toContain(`else ${outerCatchEntry}`);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("sequences multiple awaited chains in one catch statement", () => {
    const result = analyzeAsyncSafety("multi-await-handler.ts", `
      async function run() {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          return [
            await Promise.resolve("first").then(value => value),
            await Promise.resolve("second").then(value => value),
          ]
        }
      }
    `);
    const first = result.promises.find((item) => item.source.includes('"first"'))!;
    const second = result.promises.find((item) => item.source.includes('"second"'))!;
    const quint = generateUnifiedAsyncQuint("multi_await_handler", result, "run");
    const firstResumeTarget = new RegExp(`action catch_await_${first.promiseChain}_resume = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const secondEntry = new RegExp(`action promise_${second.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(firstResumeTarget).toBe(secondEntry);
    expect(quint).not.toContain(`action skip_await_${second.promiseChain}`);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("sequences multiple awaited chains in one finally statement", () => {
    const result = analyzeAsyncSafety("multi-await-finally.ts", `
      declare function note(...values: unknown[]): void
      async function run() {
        try {
          await Promise.resolve("try").then(value => value)
        } finally {
          note(
            await Promise.resolve("first").then(value => value),
            await Promise.resolve("second").then(value => value),
          )
        }
      }
    `);
    const first = result.promises.find((item) => item.source.includes('"first"'))!;
    const second = result.promises.find((item) => item.source.includes('"second"'))!;
    const quint = generateUnifiedAsyncQuint("multi_await_finally", result, "run");
    const firstResumeTarget = new RegExp(`action finally_await_${first.promiseChain}_resume = all \\{[\\s\\S]*?pc' = (-?\\d+),`).exec(quint)?.[1];
    const secondEntry = new RegExp(`action promise_${second.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    expect(firstResumeTarget).toBe(secondEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("correlates conditional awaited handler branches", () => {
    const result = analyzeAsyncSafety("conditional-handler.ts", `
      declare const recoverFirst: boolean
      async function run() {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          if (recoverFirst) {
            await Promise.resolve("first").then(value => value)
          } else {
            await Promise.resolve("second").then(value => value)
          }
        }
      }
    `);
    const first = result.promises.find((item) => item.source.includes('"first"'))!;
    const second = result.promises.find((item) => item.source.includes('"second"'))!;
    expect(first.controlConditions[0]?.id).toBe(second.controlConditions[0]?.id);
    expect(first.controlConditions[0]?.expected).toBe(true);
    expect(second.controlConditions[0]?.expected).toBe(false);
    const quint = generateUnifiedAsyncQuint("conditional_handler", result, "run");
    expect(quint).toContain(`action skip_handler_await_${first.promiseChain}`);
    expect(quint).toContain(`action skip_handler_await_${second.promiseChain}`);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("retains branch-specific return and throw completion in a handler", () => {
    const result = analyzeAsyncSafety("conditional-handler-completion.ts", `
      declare const recover: boolean
      async function run() {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          if (recover) return
          else throw error
        }
      }
    `);
    const statement = result.controlStatements[0]!;
    expect(statement.completionPaths.map((path) => ({ expected: path.controlConditions[0]?.expected, completion: path.completion }))).toEqual([
      { expected: true, completion: "return" },
      { expected: false, completion: "throw" },
    ]);
    const quint = generateUnifiedAsyncQuint("conditional_handler_completion", result, "run");
    expect(quint).toContain("action catch_statement_0_path_0");
    expect(quint).toContain("action catch_statement_0_path_1");
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("applies abrupt completion only to the selected awaited handler branch", () => {
    const result = analyzeAsyncSafety("conditional-awaited-completion.ts", `
      declare const recover: boolean
      async function run() {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          if (recover) {
            await Promise.resolve("recover").then(value => value)
            return
          } else {
            await Promise.resolve("fail").then(value => value)
            throw error
          }
        }
      }
    `);
    const recovered = result.promises.find((item) => item.source.includes('"recover"'))!;
    const failed = result.promises.find((item) => item.source.includes('"fail"'))!;
    const quint = generateUnifiedAsyncQuint("conditional_awaited_completion", result, "run");
    const failedResume = new RegExp(`action catch_await_${failed.promiseChain}_resume = all \\{[\\s\\S]*?completion' = ([^,]+),`).exec(quint)?.[1]?.trim();
    const recoveredSkip = new RegExp(`action skip_handler_await_${recovered.promiseChain} = all \\{[\\s\\S]*?completion' = ([^,]+),`).exec(quint)?.[1]?.trim();
    expect(failedResume).toBe("1");
    expect(recoveredSkip).toBe("completion");
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("correlates switch handler cases and their abrupt completion", () => {
    const result = analyzeAsyncSafety("switch-handler.ts", `
      async function run(mode: "retry" | "fail" | "ignore") {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          switch (mode) {
            case "retry":
              await Promise.resolve("retry").then(value => value)
              return
            case "fail":
              await Promise.resolve("fail").then(value => value)
              throw error
            default:
              return
          }
        }
      }
    `);
    const statement = result.controlStatements[0]!;
    const retry = result.promises.find((item) => item.source.includes('"retry"'))!;
    const fail = result.promises.find((item) => item.source.includes('"fail"'))!;
    expect(retry.controlConditions).toHaveLength(1);
    expect(fail.controlConditions).toHaveLength(2);
    expect(fail.controlConditions[0]).toEqual({ id: retry.controlConditions[0]!.id, expected: false });
    expect(statement.completionPaths.map((path) => path.completion)).toEqual(["return", "throw", "return"]);
    const quint = generateUnifiedAsyncQuint("switch_handler", result, "run");
    const failResume = new RegExp(`action catch_await_${fail.promiseChain}_resume = all \\{[\\s\\S]*?completion' = ([^,]+),`).exec(quint)?.[1]?.trim();
    expect(failResume).toBe("1");
    expect(quint).toContain(`action skip_handler_await_${retry.promiseChain}`);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("retains top-level switch fallthrough and break completion", () => {
    const result = analyzeAsyncSafety("switch-fallthrough-handler.ts", `
      declare function note(value: string): void
      async function run(mode: "prepare" | "fail" | "ignore") {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          switch (mode) {
            case "prepare":
              note("prepared")
            case "fail":
              throw error
            default:
              break
          }
          note("continued")
        }
      }
    `);
    const paths = result.controlStatements[0]!.completionPaths;
    expect(paths.map((path) => path.completion)).toEqual(["throw", "throw", "normal"]);
    expect(paths[0]!.controlConditions).toHaveLength(1);
    expect(paths[1]!.controlConditions).toHaveLength(2);
    const quint = generateUnifiedAsyncQuint("switch_fallthrough_handler", result, "run");
    expect(quint).toContain("action catch_statement_0_path_0");
    expect(quint).toContain("action catch_statement_0_path_2");
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("models an awaited switch operation reached by direct entry or fallthrough", () => {
    const result = analyzeAsyncSafety("switch-awaited-fallthrough.ts", `
      declare function note(value: string): void
      async function run(mode: "prepare" | "fail" | "ignore") {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          switch (mode) {
            case "prepare":
              note("prepared")
            case "fail":
              await Promise.resolve("shared-failure").then(value => value)
              throw error
            default:
              return
          }
        }
      }
    `);
    const shared = result.promises.find((item) => item.source.includes('"shared-failure"'))!;
    expect(shared.controlPaths).toHaveLength(2);
    expect(shared.controlPaths[0]).toEqual([{ id: expect.any(String), expected: true }]);
    expect(shared.controlPaths[1]).toHaveLength(2);
    const quint = generateUnifiedAsyncQuint("switch_awaited_fallthrough", result, "run");
    expect(quint).toContain(`action promise_${shared.promiseChain}_fulfill`);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("correlates zero-iteration handler loops with body completion", () => {
    const result = analyzeAsyncSafety("loop-handler.ts", `
      async function run(enabled: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          while (enabled) {
            await Promise.resolve("body").then(value => value)
            throw error
          }
        }
      }
    `);
    const statement = result.controlStatements[0]!;
    const body = result.promises.find((item) => item.source.includes('"body"'))!;
    expect(body.controlPaths).toEqual([[{ id: expect.any(String), expected: true }]]);
    expect(statement.completionPaths.map((path) => path.completion).sort()).toEqual(["normal", "throw"]);
    const quint = generateUnifiedAsyncQuint("loop_handler", result, "run");
    const resumeCompletion = new RegExp(`action catch_await_${body.promiseChain}_resume = all \\{[\\s\\S]*?completion' = ([^,]+),`).exec(quint)?.[1]?.trim();
    expect(resumeCompletion).toBe("1");
    expect(quint).toContain(`action skip_handler_await_${body.promiseChain}`);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("preserves a conditional break as normal loop completion", () => {
    const result = analyzeAsyncSafety("loop-break-handler.ts", `
      declare const stop: boolean
      async function run(enabled: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          while (enabled) {
            if (stop) break
            throw error
          }
        }
      }
    `);
    const paths = result.controlStatements[0]!.completionPaths;
    expect(paths.some((path) => path.completion === "normal" && path.controlConditions.some((condition) => condition.id.includes("@if:") && condition.expected))).toBe(true);
    expect(paths.some((path) => path.completion === "throw")).toBe(true);
    expect(run(generateUnifiedAsyncQuint("loop_break_handler", result, "run")).status).toBe(0);
  }, 10_000);

  it("propagates a labeled break through an inner loop to its owner", () => {
    const result = analyzeAsyncSafety("labeled-loop-handler.ts", `
      declare const stop: boolean
      async function run(outerEnabled: boolean, innerEnabled: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          outer: while (outerEnabled) {
            while (innerEnabled) {
              if (stop) break outer
              throw error
            }
            throw error
          }
        }
      }
    `);
    const paths = result.controlStatements[0]!.completionPaths;
    const labeledBreakPath = paths.find((path) => path.controlConditions.some((condition) => condition.id.includes("@if:") && condition.expected));
    expect(labeledBreakPath?.completion).toBe("normal");
    expect(run(generateUnifiedAsyncQuint("labeled_loop_handler", result, "run")).status).toBe(0);
  }, 10_000);

  it("propagates a labeled continue through an inner loop to its owner", () => {
    const result = analyzeAsyncSafety("labeled-continue-handler.ts", `
      declare const skip: boolean
      async function run(outerEnabled: boolean, innerEnabled: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          outer: while (outerEnabled) {
            while (innerEnabled) {
              if (skip) continue outer
              throw error
            }
            throw error
          }
        }
      }
    `);
    const paths = result.controlStatements[0]!.completionPaths;
    const labeledContinuePath = paths.find((path) => path.controlConditions.some((condition) => condition.id.includes("@if:") && condition.expected));
    expect(labeledContinuePath?.completion).toBe("normal");
    expect(run(generateUnifiedAsyncQuint("labeled_continue_handler", result, "run")).status).toBe(0);
  }, 10_000);

  it("adds repeat and exit transitions for an awaited handler loop", () => {
    const result = analyzeAsyncSafety("repeating-handler-loop.ts", `
      async function run(enabled: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          while (enabled) {
            await Promise.resolve("tick").then(value => value)
          }
          await Promise.resolve("after").then(value => value)
        }
      }
    `);
    expect(result.controlStatements[0]!.loop).toMatchObject({ kind: "while", atLeastOnce: false });
    const tick = result.promises.find((item) => item.source.includes('"tick"'))!;
    const quint = generateUnifiedAsyncQuint("repeating_handler_loop", result, "run");
    const tickEntry = new RegExp(`action promise_${tick.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    const repeatTarget = /action catch_loop_0_repeat = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    expect(repeatTarget).toBe(tickEntry);
    expect(quint).toContain("action catch_loop_0_exit");
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("repeats awaited finally loops before their outer continuation", () => {
    const result = analyzeAsyncSafety("repeating-finally-loop.ts", `
      async function run(enabled: boolean) {
        try {
          await Promise.resolve("try").then(value => value)
        } finally {
          while (enabled) {
            await Promise.resolve("tick").then(value => value)
          }
        }
        await Promise.resolve("after").then(value => value)
      }
    `);
    const tick = result.promises.find((item) => item.source.includes('"tick"'))!;
    const after = result.promises.find((item) => item.source.includes('"after"'))!;
    const quint = generateUnifiedAsyncQuint("repeating_finally_loop", result, "run");
    const tickEntry = new RegExp(`action promise_${tick.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    const repeatTarget = /action finally_loop_0_repeat = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    const afterEntry = new RegExp(`action promise_${after.promiseChain}_fulfill = all \\{\\s*pc == (-?\\d+),`).exec(quint)?.[1];
    const exitTarget = /action finally_loop_0_exit = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    expect(repeatTarget).toBe(tickEntry);
    expect(exitTarget).toBe(afterEntry);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("models an awaited do-while handler as at least one repeatable iteration", () => {
    const result = analyzeAsyncSafety("do-handler-loop.ts", `
      async function run(enabled: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("try")).then(() => { throw new Error("try") })
        } catch (error) {
          do {
            await Promise.resolve("tick").then(value => value)
          } while (enabled)
        }
      }
    `);
    const statement = result.controlStatements[0]!;
    const tick = result.promises.find((item) => item.source.includes('"tick"'))!;
    expect(statement.loop).toMatchObject({ kind: "do-while", atLeastOnce: true });
    expect(tick.conditional).toBe(false);
    const quint = generateUnifiedAsyncQuint("do_handler_loop", result, "run");
    expect(quint).toContain("action catch_loop_0_repeat");
    expect(quint).not.toContain(`action skip_handler_await_${tick.promiseChain}`);
    expect(run(quint).status).toBe(0);
  }, 10_000);

  it("acquires and disposes an await-using resource inside each handler loop iteration", () => {
    const result = analyzeAsyncSafety("handler-loop-resource.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function run(enabled: boolean) {
        try {
          await new Promise<string>((resolve) => resolve("enter catch")).then(() => { throw new Error("enter catch") })
        } catch (error) {
          while (enabled) {
            await using resource = open()
            await Promise.resolve("tick").then(value => value)
          }
        }
      }
    `);
    const quint = generateUnifiedAsyncQuint("handler_loop_resource", result, "run");
    const acquirePc = /action acquire_resource = all \{\s*pc == (-?\d+),/.exec(quint)?.[1];
    const rejectTarget = /action promise_\d+_reject_caught = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    const repeatTarget = /action catch_loop_0_repeat = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    expect(acquirePc).toBe(rejectTarget);
    expect(repeatTarget).toBe(acquirePc);
    expect(quint).toContain("action dispose_start_resource_handler_loop");
    expect(quint).toContain("action dispose_resume_resource_handler_loop");
    expect(quint).toContain("var generation_0: int");
    expect(quint).toMatch(/action acquire_resource = all \{[\s\S]*?generation_0' = generation_0 \+ 1,/);
    expect(quint).toMatch(/action dispose_resume_resource_handler_loop = all \{[\s\S]*?disposed_generation_0' = generation_0,/);
    expect(quint).toContain("disposed_generation_0 == generation_0");
    expect(run(quint).status).toBe(0);
    const stale = generateUnifiedAsyncQuint("handler_loop_stale_resource", result, "run", { reuseStaleDisposal: true });
    expect(stale).toContain("action skip_stale_disposed_resource_handler_loop");
    expect(run(stale).status).not.toBe(0);
  }, 10_000);

  it("rejects direct aliases of a using resource used after its lexical scope", () => {
    const result = analyzeAsyncSafety("escaping-resource-alias.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function broken(enabled: boolean) {
        let escaped: Resource | undefined
        while (enabled) {
          await using resource = open()
          escaped = resource
          await Promise.resolve().then(() => "attempt")
        }
        escaped?.send()
      }
      async function safe() {
        await using resource = open()
        resource.send()
        await Promise.resolve()
      }
      async function cleared() {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
          await Promise.resolve()
        }
        alias = undefined
        alias?.send()
      }
    `);
    expect(result.resourceAliases).toContainEqual(expect.objectContaining({
      owner: "broken", resource: "resource", alias: "escaped",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "broken", kind: "disposed-resource-use", severity: "error",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safe", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "cleared", kind: "disposed-resource-use",
    }));
    const aliasQuint = generateUnifiedAsyncQuint("escaping_resource_alias", result, "broken");
    expect(aliasQuint).toContain("var alias_generation_0: int");
    expect(aliasQuint).toContain("action capture_alias_0");
    expect(aliasQuint).toContain("action use_disposed_alias_0");
    expect(run(aliasQuint).status).not.toBe(0);
  });

  it("propagates disposed resource identity through local alias chains", () => {
    const result = analyzeAsyncSafety("transitive-resource-alias.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare function mayThrow(): void
      async function broken() {
        let first: Resource | undefined
        let second: Resource | undefined
        {
          await using resource = open()
          first = resource
          second = first
          await Promise.resolve()
        }
        second?.send()
      }
      async function killed() {
        let first: Resource | undefined
        let second: Resource | undefined
        {
          await using resource = open()
          first = resource
          second = first
          await Promise.resolve()
        }
        second = undefined
        second?.send()
      }
      async function killedUpstream() {
        let first: Resource | undefined
        let second: Resource | undefined
        {
          await using resource = open()
          first = resource
          await Promise.resolve()
        }
        first = undefined
        second = first
        second?.send()
      }
      async function usedThenKilled() {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
          await Promise.resolve()
        }
        alias?.send()
        alias = undefined
      }
      async function conditionallyKilled(clear: boolean) {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
          await Promise.resolve()
        }
        if (clear) alias = undefined
        alias?.send()
      }
      async function clearedInBothBranches(clear: boolean) {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
          await Promise.resolve()
        }
        if (clear) alias = undefined
        else alias = undefined
        alias?.send()
      }
      async function returnedOrCleared(clear: boolean) {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
          await Promise.resolve()
        }
        if (clear) alias = undefined
        else return
        alias?.send()
      }
      async function clearedEveryIteration(items: readonly number[]) {
        let alias: Resource | undefined
        for (const item of items) {
          {
            await using resource = open()
            alias = resource
            void item
          }
          alias = undefined
        }
        alias?.send()
      }
      async function unclearedIteration(items: readonly number[]) {
        let alias: Resource | undefined
        for (const item of items) {
          {
            await using resource = open()
            alias = resource
            void item
          }
        }
        alias?.send()
      }
      async function zeroIterationPreservesEscape(items: readonly number[]) {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        for (const item of items) {
          void item
          alias = undefined
        }
        alias?.send()
      }
      async function doWhileClearsEscape() {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        do alias = undefined
        while (false)
        alias?.send()
      }
      async function breakBeforeClear(items: readonly number[], stop: boolean) {
        let alias: Resource | undefined
        for (const item of items) {
          {
            await using resource = open()
            alias = resource
            void item
          }
          if (stop) break
          alias = undefined
        }
        alias?.send()
      }
      async function continueAfterClear(items: readonly number[]) {
        let alias: Resource | undefined
        for (const item of items) {
          {
            await using resource = open()
            alias = resource
            void item
          }
          alias = undefined
          continue
        }
        alias?.send()
      }
      async function conditionalBreakAfterClear(items: readonly number[], stop: boolean) {
        let alias: Resource | undefined
        for (const item of items) {
          {
            await using resource = open()
            alias = resource
            void item
          }
          if (stop) {
            alias = undefined
            break
          }
          alias = undefined
        }
        alias?.send()
      }
      async function reassignedBeforeBreak(items: readonly number[]) {
        let alias: Resource | undefined
        for (const item of items) {
          {
            await using resource = open()
            alias = resource
            void item
          }
          alias = undefined
          alias = open()
          break
        }
        alias?.send()
      }
      async function clearedInEverySwitchCase(mode: "done" | "cancelled") {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done": alias = undefined; break
          case "cancelled": alias = undefined; break
          default: alias = undefined
        }
        alias?.send()
      }
      async function unclearedSwitchCase(mode: "done" | "cancelled") {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done": alias = undefined; break
          case "cancelled": break
          default: alias = undefined
        }
        alias?.send()
      }
      async function groupedSwitchCases(mode: "done" | "cancelled" | "expired") {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done":
          case "cancelled": alias = undefined; break
          case "expired": alias = undefined; break
          default: alias = undefined
        }
        alias?.send()
      }
      async function exhaustiveSwitchWithoutDefault(mode: "done" | "cancelled") {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done": alias = undefined; break
          case "cancelled": alias = undefined; break
        }
        alias?.send()
      }
      async function incompleteSwitchWithoutDefault(mode: "done" | "cancelled" | "pending") {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done": alias = undefined; break
          case "cancelled": alias = undefined; break
        }
        alias?.send()
      }
      async function returningSwitchCase(mode: "done" | "cancelled") {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done": return
          case "cancelled": alias = undefined; break
        }
        alias?.send()
      }
      async function branchingReturnOrClear(mode: "done" | "cancelled", stop: boolean) {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done": if (stop) return; else alias = undefined; break
          case "cancelled": alias = undefined; break
        }
        alias?.send()
      }
      async function nonEmptyFallthroughRemainsConservative(mode: "done" | "cancelled") {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        switch (mode) {
          case "done": mayThrow()
          case "cancelled": alias = undefined; break
          default: alias = undefined
        }
        alias?.send()
      }
      async function clearedInFinally() {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        try { mayThrow() }
        finally { alias = undefined }
        alias?.send()
      }
      async function clearedOnlyAfterRiskyTry() {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        try { mayThrow(); alias = undefined }
        catch {}
        alias?.send()
      }
      async function clearedOnlyInCatch() {
        let alias: Resource | undefined
        {
          await using resource = open()
          alias = resource
        }
        try { mayThrow() }
        catch { alias = undefined }
        alias?.send()
      }
    `);
    expect(result.resourceAliases).toContainEqual(expect.objectContaining({
      owner: "broken", resource: "resource", alias: "second",
      generation: expect.objectContaining({ acquisitionIndex: 0, repeated: false }),
    }));
    expect(result.resourceAliases.find((alias) => alias.owner === "broken")?.generation.snapshot).toBe("single_0");
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "broken", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "killed", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "killedUpstream", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "usedThenKilled", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "conditionallyKilled", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedInBothBranches", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "returnedOrCleared", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedEveryIteration", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "unclearedIteration", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "zeroIterationPreservesEscape", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "doWhileClearsEscape", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "breakBeforeClear", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "continueAfterClear", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "conditionalBreakAfterClear", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "reassignedBeforeBreak", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedInEverySwitchCase", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "unclearedSwitchCase", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "groupedSwitchCases", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "exhaustiveSwitchWithoutDefault", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "incompleteSwitchWithoutDefault", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "returningSwitchCase", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "branchingReturnOrClear", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "nonEmptyFallthroughRemainsConservative", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedInFinally", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "clearedOnlyAfterRiskyTry", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "clearedOnlyInCatch", kind: "disposed-resource-use",
    }));
  });

  it("tracks disposed resources through static local property and array slots", () => {
    const result = analyzeAsyncSafety("aggregate-resource-alias.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function propertyEscape() {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        holder.current?.send()
      }
      async function aggregateReturnedOrCleared(clear: boolean) {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        if (clear) holder.current = undefined
        else return
        holder.current?.send()
      }
      async function clearedInEverySwitchCase(mode: "done" | "cancelled") {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        switch (mode) {
          case "done": holder.current = undefined; break
          case "cancelled": holder["current"] = undefined; break
          default: holder.current = undefined
        }
        holder.current?.send()
      }
      async function groupedSwitchSlots(mode: "done" | "cancelled" | "expired") {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        switch (mode) {
          case "done":
          case "cancelled": holder.current = undefined; break
          case "expired": holder.current = undefined; break
          default: holder.current = undefined
        }
        holder.current?.send()
      }
      async function exhaustiveSlotsWithoutDefault(mode: 1 | 2) {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        switch (mode) {
          case 1: holder.current = undefined; break
          case 2: holder.current = undefined; break
        }
        holder.current?.send()
      }
      async function propagated() {
        const holder: { current?: Resource } = {}
        let alias: Resource | undefined
        {
          await using resource = open()
          holder.current = resource
          alias = holder.current
        }
        alias?.send()
      }
      async function conditionallyCleared(clear: boolean) {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        if (clear) holder.current = undefined
        holder.current?.send()
      }
      async function arrayEscape() {
        const holder: Array<Resource | undefined> = []
        {
          await using resource = open()
          holder[0] = resource
        }
        holder[0]?.send()
      }
      async function cleared() {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        holder["current"] = undefined
        holder.current?.send()
      }
      async function clearedInBothBranches(clear: boolean) {
        const holder: { current?: Resource } = {}
        {
          await using resource = open()
          holder.current = resource
        }
        if (clear) holder.current = undefined
        else holder["current"] = undefined
        holder.current?.send()
      }
      async function aggregateClearedEveryIteration(items: readonly number[]) {
        const holder: { current?: Resource } = {}
        for (const item of items) {
          {
            await using resource = open()
            holder.current = resource
            void item
          }
          holder.current = undefined
        }
        holder.current?.send()
      }
    `);
    expect(result.resourceAliases).toContainEqual(expect.objectContaining({
      owner: "propertyEscape", resource: "resource", alias: "holder.current",
    }));
    expect(result.resourceAliases).toContainEqual(expect.objectContaining({
      owner: "arrayEscape", resource: "resource", alias: "holder[0]",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "propertyEscape", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "arrayEscape", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "cleared", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "propagated", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "conditionallyCleared", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedInBothBranches", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "aggregateReturnedOrCleared", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "aggregateClearedEveryIteration", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedInEverySwitchCase", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "groupedSwitchSlots", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "exhaustiveSlotsWithoutDefault", kind: "disposed-resource-use",
    }));
  });

  it("tracks nested resource slots through local aggregate-root aliases", () => {
    const result = analyzeAsyncSafety("nested-aggregate-resource-alias.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function nestedEscape() {
        const state: { retry: { current?: Resource } } = { retry: {} }
        {
          await using resource = open()
          state.retry.current = resource
        }
        state.retry.current?.send()
      }
      async function rootAliasEscape() {
        const state: { retry: { current?: Resource } } = { retry: {} }
        const forwarded = state
        const finalState = forwarded
        {
          await using resource = open()
          finalState.retry["current"] = resource
        }
        state.retry.current?.send()
      }
      async function clearedThroughRootAlias() {
        const state: { retry: { current?: Resource } } = { retry: {} }
        const forwarded = state
        {
          await using resource = open()
          state.retry.current = resource
        }
        forwarded.retry.current = undefined
        state.retry.current?.send()
      }
      async function clearedParent() {
        const state: { retry: { current?: Resource } } = { retry: {} }
        {
          await using resource = open()
          state.retry.current = resource
        }
        state.retry = {}
        state.retry.current?.send()
      }
      async function reassignedRootAlias() {
        const state: { current?: Resource } = {}
        let forwarded = state
        forwarded = {}
        {
          await using resource = open()
          forwarded.current = resource
        }
        state.current?.send()
      }
      async function conditionallyReassignedRootAlias(clear: boolean) {
        const state: { current?: Resource } = {}
        let forwarded = state
        {
          await using resource = open()
          forwarded.current = resource
        }
        if (clear) forwarded = {}
        state.current?.send()
      }
    `);
    expect(result.resourceAliases).toContainEqual(expect.objectContaining({
      owner: "nestedEscape", resource: "resource", alias: "state.retry.current",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "rootAliasEscape", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedThroughRootAlias", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "clearedParent", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "reassignedRootAlias", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "conditionallyReassignedRootAlias", kind: "disposed-resource-use",
    }));
  });

  it("resolves const computed keys without treating mutable keys as static", () => {
    const result = analyzeAsyncSafety("computed-resource-slot.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function stringKeyEscape() {
        const state: { current?: Resource } = {}
        const slot = "current" as const
        const forwardedSlot = slot
        {
          await using resource = open()
          state[forwardedSlot] = resource
        }
        state.current?.send()
      }
      async function numberKeyEscape() {
        const slots: Array<Resource | undefined> = []
        const index = 0 as const
        {
          await using resource = open()
          slots[index] = resource
        }
        slots[0]?.send()
      }
      async function mutableKeyIsUnknown(selectRight: boolean) {
        const state: { left?: Resource; right?: Resource } = {}
        let slot: "left" | "right" = "left"
        if (selectRight) slot = "right"
        {
          await using resource = open()
          state[slot] = resource
        }
        state.left?.send()
      }
    `);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "stringKeyEscape", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "numberKeyEscape", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "mutableKeyIsUnknown", kind: "disposed-resource-use",
    }));
  });

  it("resolves imported const computed keys through aliases and barrels", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-key-"));
    try {
      const keys = join(directory, "keys.ts"), barrel = join(directory, "index.ts"), main = join(directory, "main.ts");
      writeFileSync(keys, `
        export const ATTEMPT_SLOT = "current" as const
        export let MUTABLE_SLOT: "left" | "right" = "left"
      `);
      writeFileSync(barrel, `export { ATTEMPT_SLOT as SLOT, MUTABLE_SLOT } from "./keys.js"`);
      writeFileSync(main, `
        import { SLOT as importedSlot, MUTABLE_SLOT } from "./index.js"
        import * as keys from "./keys.js"
        interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
        declare function open(): Resource
        async function importedKeyEscape() {
          const state: { current?: Resource } = {}
          { await using resource = open(); state[importedSlot] = resource }
          state.current?.send()
        }
        async function mutableImportedKeyIsUnknown() {
          const state: { left?: Resource; right?: Resource } = {}
          { await using resource = open(); state[MUTABLE_SLOT] = resource }
          state.left?.send()
        }
        async function namespaceKeyEscape() {
          const state: { current?: Resource } = {}
          { await using resource = open(); state[keys.ATTEMPT_SLOT] = resource }
          state.current?.send()
        }
      `);
      const program = ts.createProgram([keys, barrel, main], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.esnext.d.ts", "lib.esnext.disposable.d.ts"], noEmit: true,
      });
      const result = analyzeAsyncSafetyInProgram(program, program.getSourceFile(main)!);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "importedKeyEscape", kind: "disposed-resource-use",
      }));
      expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
        functionName: "mutableImportedKeyIsUnknown", kind: "disposed-resource-use",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName: "namespaceKeyEscape", kind: "disposed-resource-use",
      }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("rejects returning lexical resources that are disposed before the caller receives them", () => {
    const result = analyzeAsyncSafety("returned-resource.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function direct() {
        await using resource = open()
        return resource
      }
      async function aliased() {
        await using resource = open()
        const forwarded = resource
        return forwarded
      }
      async function objectAggregate() {
        await using resource = open()
        return { resource }
      }
      async function arrayAggregate() {
        await using resource = open()
        return [resource]
      }
      async function safe() {
        await using resource = open()
        resource.send()
        return { ok: true }
      }
    `);
    for (const functionName of ["direct", "aliased", "objectAggregate", "arrayAggregate"]) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName, kind: "disposed-resource-escape", severity: "error",
      }));
      expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
        owner: functionName, resource: "resource", via: "return",
      }));
    }
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safe", kind: "disposed-resource-escape",
    }));
  });

  it("rejects returned closures that capture lexical resources", () => {
    const result = analyzeAsyncSafety("returned-resource-closure.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function directClosure() {
        await using resource = open()
        return () => resource.send()
      }
      async function aliasedClosure() {
        await using resource = open()
        const forwarded = resource
        const callback = function () { forwarded.send() }
        return callback
      }
      async function aggregateClosure() {
        await using resource = open()
        return { run: () => resource.send() }
      }
      async function safeImmediateClosure() {
        await using resource = open()
        const callback = () => resource.send()
        callback()
        return { ok: true }
      }
    `);
    for (const functionName of ["directClosure", "aliasedClosure", "aggregateClosure"]) {
      expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
        owner: functionName, resource: "resource", via: "returned-closure",
      }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        functionName, kind: "disposed-resource-escape",
      }));
    }
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safeImmediateClosure", kind: "disposed-resource-escape",
    }));
  });

  it("rejects lexical resources passed to declared retaining boundaries", () => {
    const result = analyzeAsyncSafety("retained-resource.ts", `
      interface Resource { send(): void; [Symbol.dispose](): void }
      declare function open(): Resource
      /* uneffect: retains_resource 0 */
      declare function register(resource: Resource): void
      declare function inspect(resource: Resource): void
      function retainWrapper(value: Resource) { register(value) }
      function retainAliasWrapper(value: Resource) {
        const forwarded = value
        register(forwarded)
      }
      class Registry {
        resource: Resource
        /* uneffect: retains_resource 0 */
        constructor(resource: Resource) { this.resource = resource }
      }
      function makeRegistry(value: Resource) { return new Registry(value) }
      class Snapshot { constructor(resource: Resource) { resource.send() } }
      function broken() {
        using resource = open()
        const alias = resource
        register(alias)
      }
      function brokenWrapper() {
        using resource = open()
        retainWrapper(resource)
      }
      function brokenAliasWrapper() {
        using resource = open()
        retainAliasWrapper(resource)
      }
      function brokenConstructor() {
        using resource = open()
        new Registry(resource)
      }
      function brokenFactory() {
        using resource = open()
        makeRegistry(resource)
      }
      function safe() {
        using resource = open()
        inspect(resource)
        new Snapshot(resource)
      }
      /* uneffect: retains_resource nope */
      declare function malformed(resource: Resource): void
      /* uneffect: retains_resource 1 */
      declare function outOfRange(resource: Resource): void
    `);
    expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "broken", resource: "resource", via: "retaining-call",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "broken", kind: "disposed-resource-escape", severity: "error",
    }));
    expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenWrapper", resource: "resource", via: "retaining-call",
    }));
    expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenAliasWrapper", resource: "resource", via: "retaining-call",
    }));
    expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenConstructor", resource: "resource", via: "retaining-construction",
    }));
    expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "brokenFactory", resource: "resource", via: "retaining-call",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "safe", kind: "disposed-resource-escape",
    }));
    expect(result.diagnostics.filter((diagnostic) => diagnostic.kind === "invalid-resource-contract")).toHaveLength(2);
  });

  it("discharges conditional retention only when its guard is proven false", () => {
    const result = analyzeAsyncSafety("conditional-retention.ts", `
      interface Resource { [Symbol.dispose](): void }
      declare function open(): Resource
      /* uneffect: retains_resource_when 0: enabled */
      declare function maybeRegister(resource: Resource, enabled: boolean): void
      function maybeRegisterWrapper(resource: Resource, enabled: boolean) {
        maybeRegister(resource, enabled)
      }
      function maybeRegisterAliasWrapper(resource: Resource, enabled: boolean) {
        const shouldRegister = enabled
        maybeRegister(resource, shouldRegister)
      }
      class MaybeRegistry {
        /* uneffect: retains_resource_when 0: enabled */
        constructor(resource: Resource, enabled: boolean) {}
      }
      function disabled() {
        using resource = open()
        maybeRegister(resource, false)
      }
      function enabled() {
        using resource = open()
        maybeRegister(resource, true)
      }
      function unknown(enabled: boolean) {
        using resource = open()
        maybeRegister(resource, enabled)
      }
      function wrappedDisabled() {
        using resource = open()
        maybeRegisterWrapper(resource, false)
      }
      function wrappedEnabled() {
        using resource = open()
        maybeRegisterWrapper(resource, true)
      }
      function wrappedUnknown(enabled: boolean) {
        using resource = open()
        maybeRegisterWrapper(resource, enabled)
      }
      function wrappedAliasDisabled() {
        using resource = open()
        maybeRegisterAliasWrapper(resource, false)
      }
      function wrappedAliasEnabled() {
        using resource = open()
        maybeRegisterAliasWrapper(resource, true)
      }
      /* uneffect: requires !enabled */
      function wrappedPreconditionDisabled(enabled: boolean) {
        using resource = open()
        maybeRegisterWrapper(resource, enabled)
      }
      /* uneffect: requires !enabled */
      function preconditionDisabled(enabled: boolean) {
        using resource = open()
        maybeRegister(resource, enabled)
      }
      function disabledConstruction() {
        using resource = open()
        new MaybeRegistry(resource, false)
      }
      function unknownConstruction(enabled: boolean) {
        using resource = open()
        new MaybeRegistry(resource, enabled)
      }
      /* uneffect: retains_resource_when nope */
      declare function malformed(resource: Resource): void
      /* uneffect: retains_resource_when 0: missing */
      declare function missingGuard(resource: Resource): void
    `);
    expect(result.resourceEscapes).not.toContainEqual(expect.objectContaining({ owner: "disabled" }));
    expect(result.resourceEscapes).not.toContainEqual(expect.objectContaining({ owner: "wrappedDisabled" }));
    expect(result.resourceEscapes).not.toContainEqual(expect.objectContaining({ owner: "wrappedAliasDisabled" }));
    expect(result.resourceEscapes).not.toContainEqual(expect.objectContaining({ owner: "wrappedPreconditionDisabled" }));
    expect(result.resourceEscapes).not.toContainEqual(expect.objectContaining({ owner: "preconditionDisabled" }));
    expect(result.resourceEscapes).not.toContainEqual(expect.objectContaining({ owner: "disabledConstruction" }));
    for (const owner of ["enabled", "unknown"]) expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner, resource: "resource", via: "retaining-call",
    }));
    for (const owner of ["wrappedEnabled", "wrappedUnknown"]) expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner, resource: "resource", via: "retaining-call",
    }));
    expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "wrappedAliasEnabled", resource: "resource", via: "retaining-call",
    }));
    expect(result.resourceEscapes).toContainEqual(expect.objectContaining({
      owner: "unknownConstruction", resource: "resource", via: "retaining-construction",
    }));
    expect(result.diagnostics.filter((diagnostic) => diagnostic.kind === "invalid-resource-contract")).toHaveLength(2);
  });
});

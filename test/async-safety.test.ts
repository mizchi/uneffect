import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createZ3Context } from "../src/z3.js";

/** The generated SMT is checked with the same WASM solver the toolchain ships; no native Z3 is required. */
async function solve(program: string): Promise<string> {
  const context = await createZ3Context("async_safety_test");
  const solver = new context.Solver();
  solver.fromString(program);
  return String(await solver.check());
}
import { analyzeAsyncSafety, analyzeAsyncSafetyInProgram, composeResourceFailures, generateOwnershipObligationQuint, generateOwnershipObligationSmt, generateResourceSafetyQuint, generateUnifiedAsyncQuint } from "../src/async-safety.js";

function run(program: string, maxSteps = 12) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-"));
  const path = join(directory, "model.qnt");
  writeFileSync(path, program);
  return spawnSync("pnpm", ["exec", "quint", "run", path,
    "--invariant=resourceSafe", `--max-steps=${maxSteps}`, "--max-samples=400",
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

  it("transfers mapped callback rejections to a directly enclosing Promise aggregate", () => {
    const result = analyzeAsyncSafety("aggregate-map-ownership.ts", `
      async function read(value: number) { return value }
      async function all(values: number[]) {
        return Promise.all(values.map(async (value) => read(value)))
      }
      async function settled(values: number[]) {
        await Promise.allSettled(values.map(async (value) => read(value)))
      }
      async function raced(values: number[]) {
        return Promise.race(values.map(async (value) => read(value)))
      }
      async function any(values: number[]) {
        return Promise.any(values.map(async (value) => read(value)))
      }
      function detached(values: number[]) {
        values.map(async (value) => read(value))
      }
      function userDefined(values: number[], collect: (items: Promise<number>[]) => Promise<number[]>) {
        return collect(values.map(async (value) => read(value)))
      }
    `);
    expect(result.diagnostics.filter(({ kind }) => kind === "floating-callback-promise")).toEqual([
      expect.objectContaining({ functionName: "detached", message: expect.stringContaining("values.map") }),
      expect.objectContaining({ functionName: "userDefined", message: expect.stringContaining("values.map") }),
    ]);
  });

  it("discharges conditional ownership only when the call proves its guard", async () => {
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
    expect(await solve(generateOwnershipObligationSmt(proven))).toBe("unsat");
    expect(await solve(generateOwnershipObligationSmt(unresolved))).toBe("sat");
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

  it("joins an observed Promise generation through a loop-local catch and continue", () => {
    const result = analyzeAsyncSafety("loop-try-catch-promises.ts", `
      declare const retry: boolean
      declare const usePrimary: boolean
      declare function task(): Promise<number>
      declare function recordAttempt(value: number): void
      async function observedAfterRetry() {
        let pending = task()
        while (retry) {
          try {
            const attempt = 1
            void attempt
            if (usePrimary) { const value = await pending; recordAttempt(value) }
            else { await pending }
            break
          }
          catch { pending = task(); continue }
        }
        await pending
      }
      async function lostAfterRetry() {
        let pending = task()
        while (retry) {
          try { await pending; break }
          catch { pending = task(); break }
        }
      }
      declare function mayThrowBeforeAwait(): void
      async function riskBeforeObservation() {
        let pending = task()
        while (retry) {
          try { mayThrowBeforeAwait(); await pending; break }
          catch { pending = task(); continue }
        }
        await pending
      }
      async function riskAfterReplacement() {
        let pending = task()
        while (retry) {
          try { await pending; pending = task(); recordAttempt(1); break }
          catch { pending = task(); continue }
        }
        await pending
      }
      async function oneBranchUnobserved() {
        let pending = task()
        while (retry) {
          try {
            if (usePrimary) await pending
            else recordAttempt(0)
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      declare function chooseBranch(): boolean
      async function riskyBranchCondition() {
        let pending = task()
        while (retry) {
          try {
            if (chooseBranch()) await pending
            else await pending
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      declare const mode: "primary" | "backup"
      async function observedSwitchRetry() {
        let pending = task()
        while (retry) {
          try {
            switch (mode) {
              case "primary": { const value = await pending; recordAttempt(value); break }
              case "backup": await pending; break
            }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      async function unobservedSwitchCase() {
        let pending = task()
        while (retry) {
          try {
            switch (mode) {
              case "primary": await pending; break
              case "backup": mayThrowBeforeAwait(); break
            }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      async function observedFallthroughSwitch() {
        let pending = task()
        while (retry) {
          try {
            switch (mode) {
              case "primary":
              case "backup": await pending; break
            }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      declare function selectMode(): "primary" | "backup"
      async function riskySwitchDiscriminant() {
        let pending = task()
        while (retry) {
          try {
            switch (selectMode()) {
              case "primary": await pending; break
              case "backup": await pending; break
            }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      async function observedNestedTryFinally() {
        let pending = task()
        while (retry) {
          try {
            try { await pending }
            finally { recordAttempt(1) }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      async function observedNestedCatch() {
        let pending = task()
        while (retry) {
          try {
            try { await pending }
            catch { recordAttempt(0) }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      async function replacementInFinally() {
        let pending = task()
        while (retry) {
          try {
            try { await pending }
            finally { pending = task(); recordAttempt(1) }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
      async function logicalReplacementInFinally() {
        let pending = task()
        while (retry) {
          try {
            try { await pending }
            finally { pending &&= task(); recordAttempt(1) }
            break
          } catch { pending = task(); continue }
        }
        await pending
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "observedAfterRetry", status: "observed" },
      { owner: "lostAfterRetry", status: "floating" },
      { owner: "riskBeforeObservation", status: "floating" },
      { owner: "riskAfterReplacement", status: "floating" },
      { owner: "oneBranchUnobserved", status: "floating" },
      { owner: "riskyBranchCondition", status: "floating" },
      { owner: "observedSwitchRetry", status: "observed" },
      { owner: "unobservedSwitchCase", status: "floating" },
      { owner: "observedFallthroughSwitch", status: "observed" },
      { owner: "riskySwitchDiscriminant", status: "floating" },
      { owner: "observedNestedTryFinally", status: "observed" },
      { owner: "observedNestedCatch", status: "observed" },
      { owner: "replacementInFinally", status: "floating" },
      { owner: "logicalReplacementInFinally", status: "floating" },
    ]);
    expect(result.diagnostics.filter(({ kind }) => kind === "floating-promise")).toEqual([
      expect.objectContaining({ functionName: "lostAfterRetry" }),
      expect.objectContaining({ functionName: "riskBeforeObservation" }),
      expect.objectContaining({ functionName: "riskAfterReplacement" }),
      expect.objectContaining({ functionName: "oneBranchUnobserved" }),
      expect.objectContaining({ functionName: "riskyBranchCondition" }),
      expect.objectContaining({ functionName: "unobservedSwitchCase" }),
      expect.objectContaining({ functionName: "riskySwitchDiscriminant" }),
      expect.objectContaining({ functionName: "replacementInFinally" }),
      expect.objectContaining({ functionName: "logicalReplacementInFinally" }),
    ]);
  });

  it("executes for initializers and incrementors in Promise ownership fixed points", () => {
    const result = analyzeAsyncSafety("for-flow-promises.ts", `
      declare const flag: boolean
      declare function task(): Promise<number>
      async function initializerCanSkip() {
        for (let pending = task(); flag;) await pending
      }
      async function initializerObservedAfterLoop() {
        let pending: Promise<number>
        for (pending = task(); flag;) console.log("tick")
        await pending
      }
      async function incrementorCanLose() {
        let pending = task()
        for (; flag; pending = task()) await pending
      }
      async function incrementorObservedAfterLoop() {
        let pending = task()
        for (; flag; pending = task()) await pending
        await pending
      }
      async function continueRunsIncrementor() {
        let pending = task()
        for (; flag; pending = task()) {
          await pending
          continue
        }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "initializerCanSkip", status: "floating" },
      { owner: "initializerObservedAfterLoop", status: "observed" },
      { owner: "incrementorCanLose", status: "floating" },
      { owner: "incrementorObservedAfterLoop", status: "observed" },
      { owner: "continueRunsIncrementor", status: "floating" },
    ]);
  });

  it("executes loop conditions and iterable expressions before loop exits", () => {
    const result = analyzeAsyncSafety("loop-header-promises.ts", `
      declare function task(): Promise<number>
      /* uneffect: consumes_rejection 0 */
      declare function consumeAndTest(value: Promise<number>): boolean
      /* uneffect: consumes_rejection 0 */
      declare function consumeAndValues(value: Promise<number>): readonly number[]
      async function whileCondition() {
        const pending = task()
        while (consumeAndTest(pending)) break
      }
      async function forCondition() {
        const pending = task()
        for (; consumeAndTest(pending);) break
      }
      async function iterableExpression() {
        const pending = task()
        for (const value of consumeAndValues(pending)) console.log(value)
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "whileCondition", status: "transferred" },
      { owner: "forCondition", status: "transferred" },
      { owner: "iterableExpression", status: "transferred" },
    ]);
  });

  it("uses finite loop-condition feasibility in Promise ownership fixed points", () => {
    const result = analyzeAsyncSafety("static-loop-promises.ts", `
      declare function task(): Promise<number>
      /* uneffect: consumes_rejection 0 */
      declare function consume(value: Promise<number>): void
      async function whileTrueBreak() {
        const pending = task()
        while (true) { await pending; break }
      }
      async function forEverBreak() {
        const pending = task()
        for (;;) { await pending; break }
      }
      async function immutableTrueBreak() {
        const always = true
        const pending = task()
        while (always) { await pending; break }
      }
      async function numericTrueBreak() {
        const pending = task()
        while (1) { await pending; break }
      }
      async function whileFalseSkipsConsumer() {
        const pending = task()
        while (false) consume(pending)
      }
      async function doFalseRunsConsumer() {
        const pending = task()
        do consume(pending); while (false)
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "whileTrueBreak", status: "observed" },
      { owner: "forEverBreak", status: "observed" },
      { owner: "immutableTrueBreak", status: "observed" },
      { owner: "numericTrueBreak", status: "observed" },
      { owner: "whileFalseSkipsConsumer", status: "floating" },
      { owner: "doFalseRunsConsumer", status: "transferred" },
    ]);
  });

  it("routes guaranteed loop-test throws into the enclosing catch", () => {
    const result = analyzeAsyncSafety("throwing-loop-tests.ts", `
      declare function task(): Promise<number>
      /* uneffect: effect Throw<Error> */
      declare function failCondition(): never
      declare function terminateOrDiverge(): never
      async function throwingWhile() {
        const pending = task()
        try { while (failCondition()) {} }
        catch { await pending }
      }
      async function throwingFor() {
        const pending = task()
        try { for (; failCondition();) {} }
        catch { await pending }
      }
      async function throwingDoTest() {
        const pending = task()
        try { do console.log("once"); while (failCondition()) }
        catch { await pending }
      }
      async function throwingInitializer() {
        const pending = task()
        try { for (let value = failCondition(); false;) console.log(value) }
        catch { await pending }
      }
      async function throwingIterable() {
        const pending = task()
        try { for (const value of failCondition()) console.log(value) }
        catch { await pending }
      }
      async function unannotatedNever() {
        const pending = task()
        try { while (terminateOrDiverge()) {} }
        catch { await pending }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "throwingWhile", status: "observed" },
      { owner: "throwingFor", status: "observed" },
      { owner: "throwingDoTest", status: "observed" },
      { owner: "throwingInitializer", status: "observed" },
      { owner: "throwingIterable", status: "observed" },
      { owner: "unannotatedNever", status: "floating" },
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

  it("routes explicit throw completions into catch before deciding Promise ownership", () => {
    const result = analyzeAsyncSafety("explicit-throw-promises.ts", `
      declare function task(): Promise<number>
      async function caught() {
        const pending = task()
        try { throw new Error("route") }
        catch { await pending }
      }
      async function rethrown() {
        const pending = task()
        try { throw new Error("route") }
        catch (error) { throw error }
      }
      async function conditional(flag: boolean) {
        const pending = task()
        try { if (flag) throw new Error("route") }
        catch { await pending }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "caught", status: "observed" },
      { owner: "rethrown", status: "floating" },
      { owner: "conditional", status: "floating" },
    ]);
    expect(result.diagnostics.filter(({ kind }) => kind === "floating-promise")).toEqual([
      expect.objectContaining({ functionName: "rethrown" }),
      expect.objectContaining({ functionName: "conditional" }),
    ]);
  });

  it("routes TypeChecker-proven never calls into catch with the current ownership state", () => {
    const result = analyzeAsyncSafety("never-call-promises.ts", `
      declare function task(): Promise<number>
      /* uneffect: effect Throw<Error> */
      declare function fail(): never
      declare function terminate(): never
      declare function maybeFail(): void
      async function caughtNever() {
        let pending: Promise<number>
        try { pending = task(); fail() }
        catch { await pending }
      }
      async function maybeReturns() {
        let pending: Promise<number>
        try { pending = task(); maybeFail() }
        catch { await pending }
      }
      async function nonThrowingNever() {
        let pending: Promise<number>
        try { pending = task(); terminate() }
        catch { await pending }
      }
      async function conditionalNever(flag: boolean) {
        let pending: Promise<number>
        try { pending = task(); if (flag) fail() }
        catch { await pending }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "caughtNever", status: "observed" },
      { owner: "maybeReturns", status: "floating" },
      { owner: "nonThrowingNever", status: "floating" },
      { owner: "conditionalNever", status: "floating" },
    ]);
  });

  it("preserves guaranteed throw completion through return, wrappers, comma, and ternary expressions", () => {
    const result = analyzeAsyncSafety("throw-expression-promises.ts", `
      declare function task(): Promise<number>
      /* uneffect: effect Throw<Error> */ declare function fail(): never
      declare function maybeFail(): void
      async function returned() {
        const pending = task()
        try { return fail() } catch { await pending }
      }
      async function wrapped() {
        const pending = task()
        try { (fail()) } catch { await pending }
      }
      async function voided() {
        const pending = task()
        try { void fail() } catch { await pending }
      }
      async function awaited() {
        const pending = task()
        try { await fail() } catch { await pending }
      }
      async function initialized() {
        const pending = task()
        try { const impossible = fail(); void impossible } catch { await pending }
      }
      async function comma() {
        let pending: Promise<number>
        try { (pending = task(), fail()) } catch { await pending }
      }
      async function bothBranches(flag: boolean) {
        const pending = task()
        try { flag ? fail() : fail() } catch { await pending }
      }
      async function oneBranch(flag: boolean) {
        const pending = task()
        try { flag ? fail() : maybeFail() } catch { await pending }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "returned", status: "observed" },
      { owner: "wrapped", status: "observed" },
      { owner: "voided", status: "observed" },
      { owner: "awaited", status: "observed" },
      { owner: "initialized", status: "observed" },
      { owner: "comma", status: "observed" },
      { owner: "bothBranches", status: "observed" },
      { owner: "oneBranch", status: "floating" },
    ]);
  });

  it("respects logical short-circuit evaluation for guaranteed throw completion", () => {
    const result = analyzeAsyncSafety("logical-throw-promises.ts", `
      declare function task(): Promise<number>
      /* uneffect: effect Throw<Error> */ declare function fail(): never
      declare function maybeFail(): void
      async function throwingLeft() {
        const pending = task()
        try { fail() && maybeFail() } catch { await pending }
      }
      async function requiredAnd() {
        const pending = task()
        try { true && fail() } catch { await pending }
      }
      async function requiredOr() {
        const pending = task()
        try { false || fail() } catch { await pending }
      }
      async function staticTernary() {
        const pending = task()
        try { true ? fail() : maybeFail() } catch { await pending }
      }
      async function constAlias() {
        const pending = task()
        const required = true as const
        try { required && fail() } catch { await pending }
      }
      async function skippedAnd() {
        const pending = task()
        try { false && fail() } catch { await pending }
      }
      async function skippedOr() {
        const pending = task()
        try { true || fail() } catch { await pending }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "throwingLeft", status: "observed" },
      { owner: "requiredAnd", status: "observed" },
      { owner: "requiredOr", status: "observed" },
      { owner: "staticTernary", status: "observed" },
      { owner: "constAlias", status: "observed" },
      { owner: "skippedAnd", status: "floating" },
      { owner: "skippedOr", status: "floating" },
    ]);
  });

  it("respects nullish coalescing evaluation for guaranteed throw completion", () => {
    const result = analyzeAsyncSafety("nullish-throw-promises.ts", `
      declare function task(): Promise<number>
      /* uneffect: effect Throw<Error> */ declare function fail(): never
      declare function maybeFail(): void
      async function throwingLeft() {
        const pending = task()
        try { fail() ?? maybeFail() } catch { await pending }
      }
      async function nullLeft() {
        const pending = task()
        try { null ?? fail() } catch { await pending }
      }
      async function voidLeft() {
        const pending = task()
        try { void 0 ?? fail() } catch { await pending }
      }
      async function globalUndefined() {
        const pending = task()
        try { undefined ?? fail() } catch { await pending }
      }
      async function constAlias() {
        const pending = task()
        const missing = null as null
        try { missing ?? fail() } catch { await pending }
      }
      async function presentLeft() {
        const pending = task()
        try { "ready" ?? fail() } catch { await pending }
      }
      async function unknownLeft(value: string | null) {
        const pending = task()
        try { value ?? fail() } catch { await pending }
      }
      async function shadowedUndefined(undefined: string) {
        const pending = task()
        try { undefined ?? fail() } catch { await pending }
      }
    `);
    expect(result.promiseBindings.map(({ owner, status }) => ({ owner, status }))).toEqual([
      { owner: "throwingLeft", status: "observed" },
      { owner: "nullLeft", status: "observed" },
      { owner: "voidLeft", status: "observed" },
      { owner: "globalUndefined", status: "observed" },
      { owner: "constAlias", status: "observed" },
      { owner: "presentLeft", status: "floating" },
      { owner: "unknownLeft", status: "floating" },
      { owner: "shadowedUndefined", status: "floating" },
    ]);
  });

  it("dogfoods audit delivery before a typed fatal throw", () => {
    const fileName = "examples/dogfood/audit-before-fatal.ts";
    const result = analyzeAsyncSafety(fileName, readFileSync(fileName, "utf8"));
    expect(result.promiseBindings).toContainEqual(expect.objectContaining({
      owner: "auditInvalidRequest", binding: "delivery", status: "observed",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "auditInvalidRequest", kind: "floating-promise",
    }));
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

  it("proves reverse mixed disposal after a caught awaited rejection", () => {
    const fileName = "examples/dogfood/rejected-await-multiple-disposal.ts";
    const source = readFileSync(fileName, "utf8");
    const result = analyzeAsyncSafety(fileName, source);
    expect(result.disposals.map(({ binding, asynchronous }) => ({ binding, asynchronous }))).toEqual([
      { binding: "session", asynchronous: true },
      { binding: "audit", asynchronous: false },
    ]);

    const positive = run(generateUnifiedAsyncQuint("rejected_await_multiple_disposal", result, "deliverWithRecovery"), 16);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    const reordered = run(generateUnifiedAsyncQuint(
      "rejected_await_multiple_disposal_reordered",
      result,
      "deliverWithRecovery",
      { reorderCleanup: true },
    ), 16);
    expect(reordered.status).not.toBe(0);
    expect(reordered.stdout + reordered.stderr).toMatch(/violation|counterexample/i);

    const skipped = run(generateUnifiedAsyncQuint(
      "rejected_await_multiple_disposal_skipped",
      result,
      "deliverWithRecovery",
      { skipCleanup: true },
    ), 16);
    expect(skipped.status).not.toBe(0);
    expect(skipped.stdout + skipped.stderr).toMatch(/violation|counterexample/i);

    const floating = analyzeAsyncSafety("floating-rejected-delivery.ts", source.replace(
      "await session.send().then(() => undefined);",
      "session.send().then(() => undefined);",
    ));
    expect(floating.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliverWithRecovery",
      kind: "floating-promise",
    }));
  }, 30_000);

  it("proves nested cleanup before continuation across two caught awaits", () => {
    const fileName = "examples/dogfood/nested-rejection-cleanup.ts";
    const source = readFileSync(fileName, "utf8");
    const result = analyzeAsyncSafety(fileName, source);
    expect(result.disposals.map(({ binding, scopeDepth }) => ({ binding, scopeDepth }))).toEqual([
      { binding: "session", scopeDepth: 1 },
      { binding: "audit", scopeDepth: 0 },
    ]);

    const positive = run(generateUnifiedAsyncQuint("nested_rejection_cleanup", result, "deliverNested"), 24);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    const reordered = run(generateUnifiedAsyncQuint(
      "nested_rejection_cleanup_reordered",
      result,
      "deliverNested",
      { reorderCleanup: true },
    ), 24);
    expect(reordered.status).not.toBe(0);
    expect(reordered.stdout + reordered.stderr).toMatch(/violation|counterexample/i);

    const skipped = run(generateUnifiedAsyncQuint(
      "nested_rejection_cleanup_skipped",
      result,
      "deliverNested",
      { skipScopeCleanup: true },
    ), 24);
    expect(skipped.status).not.toBe(0);
    expect(skipped.stdout + skipped.stderr).toMatch(/violation|counterexample/i);

    const floating = analyzeAsyncSafety("nested-rejection-floating.ts", source.replace(
      "await session.send().then(() => undefined);",
      "if (recover) await session.send().then(() => undefined);\n      else session.send().then(() => undefined);",
    ));
    expect(floating.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliverNested",
      kind: "floating-promise",
    }));

    const dynamicJoin = analyzeAsyncSafety("nested-rejection-dynamic-join.ts", `
      async function run(recover: boolean) {
        selected: try { await Promise.reject(new Error("no")) }
        catch (error) { if (recover) break selected; throw error }
      }
    `);
    expect(dynamicJoin.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "run",
      kind: "unsupported-control-transfer",
    }));
    expect(() => generateUnifiedAsyncQuint("nested_rejection_dynamic_join", dynamicJoin, "run"))
      .toThrow(/break selected leaves the modeled handler CFG/);
  }, 30_000);

  it("proves that rejecting inner disposal traverses its enclosing handler", () => {
    const fileName = "examples/dogfood/caught-disposal-rejection.ts";
    const source = readFileSync(fileName, "utf8");
    const result = analyzeAsyncSafety(fileName, source);
    expect(result.disposals.map(({ binding, catchesFailure }) => ({ binding, catchesFailure }))).toEqual([
      { binding: "session", catchesFailure: true },
      { binding: "audit", catchesFailure: false },
    ]);

    const positive = run(generateUnifiedAsyncQuint(
      "caught_disposal_rejection",
      result,
      "deliverAfterDisposal",
    ), 24);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    const bypassedHandler = run(generateUnifiedAsyncQuint(
      "caught_disposal_rejection_bypassed_handler",
      result,
      "deliverAfterDisposal",
      { skipDisposalHandler: true },
    ), 24);
    expect(bypassedHandler.status).not.toBe(0);
    expect(bypassedHandler.stdout + bypassedHandler.stderr).toMatch(/violation|counterexample/i);

    const skippedCleanup = run(generateUnifiedAsyncQuint(
      "caught_disposal_rejection_skipped_cleanup",
      result,
      "deliverAfterDisposal",
      { skipScopeCleanup: true },
    ), 24);
    expect(skippedCleanup.status).not.toBe(0);
    expect(skippedCleanup.stdout + skippedCleanup.stderr).toMatch(/violation|counterexample/i);

    const floating = analyzeAsyncSafety("caught-disposal-floating.ts", source.replace(
      "await session.send().then(() => undefined);",
      "session.send().then(() => undefined);",
    ));
    expect(floating.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliverAfterDisposal",
      kind: "floating-promise",
    }));
  }, 30_000);

  it("finishes a failing inner disposal stack before handling SuppressedError", () => {
    const fileName = "examples/dogfood/suppressed-disposal-rejections.ts";
    const source = readFileSync(fileName, "utf8");
    const result = analyzeAsyncSafety(fileName, source);
    expect(result.disposals.map(({ binding, catchesFailure }) => ({ binding, catchesFailure }))).toEqual([
      { binding: "secondary", catchesFailure: true },
      { binding: "primary", catchesFailure: true },
      { binding: "audit", catchesFailure: false },
    ]);
    expect(composeResourceFailures(result, "deliverWithSuppression", undefined, ["secondary", "primary"])).toEqual({
      kind: "suppressed",
      error: { kind: "error", errorType: "unknown", source: "dispose:primary" },
      suppressed: { kind: "error", errorType: "unknown", source: "dispose:secondary" },
    });

    const quint = generateUnifiedAsyncQuint(
      "suppressed_disposal_rejections",
      result,
      "deliverWithSuppression",
    );
    const scopeCleanupPc = quint.match(/action dispose_start_secondary_scope_exit = all \{\s+pc == (\d+)/)?.[1];
    expect(scopeCleanupPc).toBeDefined();
    expect(quint.match(/action promise_0_reject_caught = all \{[\s\S]*?pc' = (\d+)/)?.[1]).toBe(scopeCleanupPc);
    expect(quint.match(/action acquire_fail_secondary = all \{[\s\S]*?pc' = (\d+)/)?.[1]).toBe(scopeCleanupPc);
    const positive = run(quint, 30);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    for (const [name, options] of [
      ["premature_handler", { prematureDisposalHandler: true }],
      ["lost_suppression", { dropDisposalSuppression: true }],
      ["skipped_scope_cleanup", { skipScopeCleanup: true }],
      ["reordered_cleanup", { reorderCleanup: true }],
    ] as const) {
      const broken = run(generateUnifiedAsyncQuint(
        `suppressed_disposal_rejections_${name}`,
        result,
        "deliverWithSuppression",
        options,
      ), 30);
      expect(broken.status, `${name}\n${broken.stdout}${broken.stderr}`).not.toBe(0);
      expect(broken.stdout + broken.stderr).toMatch(/violation|counterexample/i);
    }

    const floating = analyzeAsyncSafety("suppressed-disposal-floating.ts", source.replace(
      "await secondary.send().then(() => undefined);",
      "secondary.send().then(() => undefined);",
    ));
    expect(floating.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliverWithSuppression",
      kind: "floating-promise",
    }));
  }, 45_000);

  it("keeps mutually exclusive branch resources correlated through cleanup and catch", () => {
    const fileName = "examples/dogfood/branch-correlated-cleanup.ts";
    const source = readFileSync(fileName, "utf8");
    const result = analyzeAsyncSafety(fileName, source);
    const positive = run(generateUnifiedAsyncQuint(
      "branch_correlated_cleanup",
      result,
      "deliverSelected",
    ), 30);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);

    for (const [name, options] of [
      ["both_branches_acquired", { acquireBothBranches: true }],
      ["wrong_branch_cleanup", { wrongBranchCleanup: true }],
      ["skipped_scope_cleanup", { skipScopeCleanup: true }],
      ["premature_handler", { prematureDisposalHandler: true }],
    ] as const) {
      const broken = run(generateUnifiedAsyncQuint(
        `branch_correlated_cleanup_${name}`,
        result,
        "deliverSelected",
        options,
      ), 30);
      expect(broken.status, `${name}\n${broken.stdout}${broken.stderr}`).not.toBe(0);
      expect(broken.stdout + broken.stderr).toMatch(/violation|counterexample/i);
    }

    const floating = analyzeAsyncSafety("branch-correlated-floating.ts", source.replace(
      "await primary.send().then(() => undefined);",
      "primary.send().then(() => undefined);",
    ));
    expect(floating.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "deliverSelected",
      kind: "floating-promise",
    }));
  }, 60_000);

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

  it("disposes a loop-scoped resource before a bounded outer continue repeats", () => {
    const fileName = "examples/dogfood/target-aware-retry-cleanup.ts";
    const result = analyzeAsyncSafety(fileName, readFileSync(fileName, "utf8"));
    expect(result.controlTransferOwners).toEqual([
      expect.objectContaining({ owner: "deliverWithRetry", label: "attempts", kind: "for", iterations: 2 }),
    ]);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      kind: "unsupported-control-transfer",
    }));
    const quint = generateUnifiedAsyncQuint("target_aware_retry_cleanup", result, "deliverWithRetry");
    expect(quint).toContain("action dispose_start_session_continue_attempts");
    expect(quint).toContain("action continue_attempts_repeat");
    expect(run(quint, 32).status).toBe(0);

    const stale = generateUnifiedAsyncQuint("target_aware_retry_cleanup_stale", result, "deliverWithRetry", {
      reuseStaleDisposal: true,
    });
    expect(stale).toContain("action skip_stale_disposed_session_continue_attempts");
    expect(run(stale, 32).status).not.toBe(0);
  }, 20_000);

  it("disposes before a bounded outer break reaches its post-loop await", () => {
    const fileName = "examples/dogfood/target-aware-break-cleanup.ts";
    const result = analyzeAsyncSafety(fileName, readFileSync(fileName, "utf8"));
    expect(result.controlTransferOwners).toEqual([
      expect.objectContaining({
        owner: "deliverUntilStop",
        label: "attempts",
        kind: "for",
        iterations: 2,
        transfers: ["break"],
      }),
    ]);
    const quint = generateUnifiedAsyncQuint("target_aware_break_cleanup", result, "deliverUntilStop");
    const breakTarget = /action break_attempts_exit = all \{[\s\S]*?pc' = (-?\d+),/.exec(quint)?.[1];
    const reportPc = /action promise_1_fulfill = all \{\s*pc == (-?\d+),/.exec(quint)?.[1];
    expect(breakTarget).toBe(reportPc);
    expect(run(quint, 32).status).toBe(0);

    const broken = generateUnifiedAsyncQuint("target_aware_break_cleanup_broken", result, "deliverUntilStop", {
      skipTransferCleanup: true,
    });
    expect(broken).toContain("action break_attempts_without_cleanup");
    expect(run(broken, 32).status).not.toBe(0);
  }, 20_000);

  it("rejects non-canonical and non-loop outer break owners", () => {
    const dynamic = analyzeAsyncSafety("dynamic-outer-break.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function run(limit: number, stop: boolean) {
        attempts: for (let attempt = 0; attempt < limit; attempt++) {
          await using resource = open()
          try { await Promise.resolve("attempt").then(value => value) }
          finally { if (stop) break attempts }
        }
      }
    `);
    expect(dynamic.controlTransferOwners).toEqual([]);
    expect(dynamic.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "run",
      kind: "unsupported-control-transfer",
    }));
    expect(() => generateUnifiedAsyncQuint("dynamic_outer_break", dynamic, "run"))
      .toThrow(/break attempts leaves the modeled handler CFG/);

    const block = analyzeAsyncSafety("block-outer-break.ts", `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function run(stop: boolean) {
        policy: {
          for (let attempt = 0; attempt < 2; attempt++) {
            await using resource = open()
            try { await Promise.resolve("attempt").then(value => value) }
            finally { if (stop) break policy }
          }
        }
      }
    `);
    expect(block.controlTransferOwners).toEqual([]);
    expect(block.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "run",
      kind: "unsupported-control-transfer",
    }));
  });

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
      generation: expect.objectContaining({ relation: "latest" }),
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
    expect(aliasQuint).toContain("action skip_capture_alias_0");
    expect(aliasQuint).not.toContain("action skip_conditional_capture_alias_0");
    expect(aliasQuint).toContain("action alias_loop_0_repeat");
    expect(aliasQuint).toContain("action alias_loop_0_exit");
    expect(aliasQuint).toContain("action use_disposed_alias_0");
    expect(run(aliasQuint).status).not.toBe(0);
  });

  it("joins mandatory finally clears into loop-local resource alias flow", () => {
    const result = analyzeAsyncSafety("finally-cleared-resource-alias.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Promise<Resource>
      declare function work(resource: Resource): Promise<void>
      async function cleared(enabled: boolean) {
        let alias: Resource | undefined
        while (enabled) {
          await using resource = await open()
          alias = resource
          try { await work(resource) }
          finally { alias = undefined }
        }
        alias?.send()
      }
      async function conditional(enabled: boolean, release: boolean) {
        let alias: Resource | undefined
        while (enabled) {
          await using resource = await open()
          alias = resource
          try { await work(resource) }
          finally { if (release) alias = undefined }
        }
        alias?.send()
      }
      async function aggregate(enabled: boolean) {
        const state: { current?: Resource } = {}
        while (enabled) {
          await using resource = await open()
          state.current = resource
          try { await work(resource) }
          finally { state.current = undefined }
        }
        state.current?.send()
      }
    `);
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "cleared", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      functionName: "conditional", kind: "disposed-resource-use",
    }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({
      functionName: "aggregate", kind: "disposed-resource-use",
    }));
    expect(result.resourceAliases.filter(({ owner }) => owner === "conditional")).toHaveLength(1);
    expect(result.resourceAliases.filter(({ owner }) => owner === "cleared" || owner === "aggregate")).toEqual([]);
  });

  it("shares one loop decision across aliases of the same repeated resource generation", () => {
    const result = analyzeAsyncSafety("repeated-resource-multiple-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function broken(enabled: boolean) {
        let first: Resource | undefined
        let second: Resource | undefined
        while (enabled) {
          await using resource = open()
          first = resource
          second = resource
          await Promise.resolve("tick").then((value) => value)
        }
        first?.send()
        second?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "broken");
    expect(aliases).toHaveLength(2);
    expect(aliases.every((alias) => alias.generation.repeated)).toBe(true);
    expect(new Set(aliases.map((alias) => alias.generation.acquisitionIndex))).toEqual(new Set([0]));

    const quint = generateUnifiedAsyncQuint("repeated_resource_multiple_aliases", result, "broken");
    expect([...quint.matchAll(/action alias_loop_\d+_repeat/g)]).toHaveLength(1);
    expect([...quint.matchAll(/action alias_loop_\d+_exit/g)]).toHaveLength(1);
    expect(quint).toContain("action capture_alias_0");
    expect(quint).toContain("action capture_alias_1");
    expect(quint).toContain("action use_disposed_alias_0");
    expect(quint).toContain("action use_disposed_alias_1");
    expect(run(quint).status).not.toBe(0);
  });

  it("keeps nested repeated resource generations and loop targets distinct", () => {
    const result = analyzeAsyncSafety("nested-repeated-resource-aliases.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function broken(outerEnabled: boolean, innerEnabled: boolean) {
        let outerAlias: Resource | undefined
        let innerAlias: Resource | undefined
        while (outerEnabled) {
          await using outerResource = open()
          outerAlias = outerResource
          while (innerEnabled) {
            await using innerResource = open()
            innerAlias = innerResource
            await Promise.resolve("tick").then((value) => value)
          }
        }
        innerAlias?.send()
        outerAlias?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "broken");
    expect(aliases.map((alias) => ({ alias: alias.alias, acquisition: alias.generation.acquisitionIndex, repeated: alias.generation.repeated }))).toEqual(expect.arrayContaining([
      { alias: "outerAlias", acquisition: 0, repeated: true },
      { alias: "innerAlias", acquisition: 1, repeated: true },
    ]));

    const quint = generateUnifiedAsyncQuint("nested_repeated_resource_aliases", result, "broken");
    const outerAcquirePc = /action acquire_outerResource = all \{\s*pc == (\d+),/.exec(quint)?.[1];
    const innerAcquirePc = /action acquire_innerResource = all \{\s*pc == (\d+),/.exec(quint)?.[1];
    const outerRepeatPc = /action alias_loop_0_repeat = all \{[\s\S]*?pc' = (\d+),/.exec(quint)?.[1];
    const innerRepeatPc = /action alias_loop_1_repeat = all \{[\s\S]*?pc' = (\d+),/.exec(quint)?.[1];
    expect(outerRepeatPc).toBe(outerAcquirePc);
    expect(innerRepeatPc).toBe(innerAcquirePc);
    expect(outerRepeatPc).not.toBe(innerRepeatPc);
    expect(run(quint, 32).status).not.toBe(0);
  });

  it("does not invent mandatory snapshots for conditional repeated-resource aliases", () => {
    const result = analyzeAsyncSafety("conditional-resource-generations.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function broken(enabled: boolean, keepFirst: boolean) {
        let first: Resource | undefined
        let latest: Resource | undefined
        while (enabled) {
          await using resource = open()
          if (keepFirst) first = resource
          else latest = resource
          await Promise.resolve("tick").then((value) => value)
        }
        first?.send()
        latest?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "broken");
    expect(aliases).toHaveLength(2);
    expect(aliases.every((alias) => alias.generation.relation === "conditional")).toBe(true);
    expect(aliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(aliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({ id: aliases[0]?.generation.controlPaths[0]?.[0]?.id, expected: false });

    const quint = generateUnifiedAsyncQuint("conditional_resource_generations", result, "broken");
    expect(quint).toContain("action skip_conditional_capture_alias_0");
    expect(quint).toContain("action skip_conditional_capture_alias_1");
    const firstCapture = /branch_(\d+) == ([01]),/.exec(/action capture_alias_0 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "");
    const latestCapture = /branch_(\d+) == ([01]),/.exec(/action capture_alias_1 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "");
    expect(firstCapture?.slice(1)).toEqual([expect.any(String), "1"]);
    expect(latestCapture?.slice(1)).toEqual([firstCapture?.[1], "0"]);
    const firstSkip = /action skip_conditional_capture_alias_0 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "";
    const latestSkip = /action skip_conditional_capture_alias_1 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "";
    expect(firstSkip).toContain(`branch_${firstCapture?.[1]} == 0,`);
    expect(latestSkip).toContain(`branch_${firstCapture?.[1]} == 1,`);
    expect([...quint.matchAll(/action alias_loop_\d+_repeat/g)]).toHaveLength(1);
    expect(run(quint, 24).status).not.toBe(0);
  });

  it("correlates switch entry and fallthrough resource-generation captures", () => {
    const result = analyzeAsyncSafety("switch-resource-generations.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      async function broken(enabled: boolean, mode: "first" | "latest" | "none") {
        let first: Resource | undefined
        let latest: Resource | undefined
        while (enabled) {
          await using resource = open()
          switch (mode) {
            case "first": first = resource
            case "latest": latest = resource; break
            case "none": break
          }
          await Promise.resolve("tick").then((value) => value)
        }
        first?.send()
        latest?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "broken");
    expect(aliases).toHaveLength(2);
    expect(aliases[0]?.generation.controlPaths).toHaveLength(1);
    expect(aliases[1]?.generation.controlPaths).toHaveLength(2);

    const quint = generateUnifiedAsyncQuint("switch_resource_generations", result, "broken");
    const firstCapture = /action capture_alias_0 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "";
    const latestCapture = /action capture_alias_1 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "";
    const firstCase = /branch_(\d+) == 1,/.exec(firstCapture)?.[1];
    expect(firstCase).toBeDefined();
    expect(latestCapture).toContain(`(branch_${firstCase} == 1) or (`);
    expect(quint).toContain("action skip_conditional_capture_alias_0");
    expect(quint).toContain("action skip_conditional_capture_alias_1");
    expect(run(quint, 28).status).not.toBe(0);
  });

  it("correlates post-risk try continuation and catch resource-generation captures", () => {
    const result = analyzeAsyncSafety("try-catch-resource-generations.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare function mayThrow(): void
      async function broken(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            mayThrow()
            success = resource
          } catch {
            failure = resource
          }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
      async function assignedBeforeRisk(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            success = resource
            mayThrow()
          } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "broken");
    expect(aliases).toHaveLength(2);
    expect(aliases.map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional"]);
    expect(aliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(aliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: aliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    expect(result.resourceAliases.find((alias) => alias.owner === "assignedBeforeRisk")?.generation.relation).toBe("latest");

    const quint = generateUnifiedAsyncQuint("try_catch_resource_generations", result, "broken");
    const successCapture = /action capture_alias_0 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "";
    const failureCapture = /action capture_alias_1 = all \{([^}]*)\}/.exec(quint)?.[1] ?? "";
    const completionBranch = /branch_(\d+) == 1,/.exec(successCapture)?.[1];
    expect(completionBranch).toBeDefined();
    expect(failureCapture).toContain(`branch_${completionBranch} == 0,`);
    expect(run(quint, 28).status).not.toBe(0);
  });

  it("treats a resolved getter as a try risk before alias generation capture", () => {
    const result = analyzeAsyncSafety("getter-try-resource-generations.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare const fail: boolean
      class Source {
        readonly plain = 1
        get value(): number {
          if (fail) throw new Error("getter")
          return 1
        }
      }
      declare const source: Source
      const getterKey = "value" as const
      declare const record: Record<string, number>
      async function broken(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            source.value
            success = resource
          } catch {
            failure = resource
          }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
      async function computedGetter(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            source["value"]
            success = resource
          } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function constKeyGetter(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            source[getterKey]
            success = resource
          } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function openRecordKey(enabled: boolean, key: string) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            record[key]
            success = resource
          } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function finiteKeyGetter(enabled: boolean, key: "value" | "plain") {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            source[key]
            success = resource
          } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "broken");
    expect(aliases.map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional"]);
    expect(aliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(aliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: aliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    const quint = generateUnifiedAsyncQuint("getter_try_resource_generations", result, "broken");
    expect(run(quint, 28).status).not.toBe(0);
    expect(result.resourceAliases.find((alias) => alias.owner === "computedGetter")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.find((alias) => alias.owner === "constKeyGetter")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.find((alias) => alias.owner === "openRecordKey")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.find((alias) => alias.owner === "finiteKeyGetter")?.generation.relation).toBe("conditional");
  });

  it("treats property access through an immutable Proxy receiver as a try risk", () => {
    const result = analyzeAsyncSafety("proxy-try-resource-generations.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare const fail: boolean
      const direct = new Proxy({ value: 1 }, {
        get(target, key, receiver) {
          if (fail) throw new Error("proxy get")
          return Reflect.get(target, key, receiver)
        }
      })
      const forwarded = direct
      let mutable = direct
      async function immutableProxy(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            forwarded.value
            success = resource
          } catch {
            failure = resource
          }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
      async function mutableProxy(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            mutable.value
            success = resource
          } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "immutableProxy");
    expect(aliases.map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional"]);
    expect(aliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(aliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: aliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    expect(result.resourceAliases.find((alias) => alias.owner === "mutableProxy")?.generation.relation).toBe("latest");
    const quint = generateUnifiedAsyncQuint("proxy_try_resource_generations", result, "immutableProxy");
    expect(run(quint, 28).status).not.toBe(0);
  });

  it("tracks a Proxy receiver returned by resolved factory chains", () => {
    const result = analyzeAsyncSafety("proxy-factory-try-resource-generations.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      function createGate() {
        return new Proxy({ ready: true }, { get: Reflect.get })
      }
      const wrapGate = () => createGate()
      function chooseGate(enabled: boolean) {
        if (enabled) return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function chooseNegatedGate(disabled: boolean) {
        if (!disabled) return { ready: true }
        return new Proxy({ ready: true }, { get: Reflect.get })
      }
      declare const selectPrimary: boolean
      function chooseProxyGate() {
        if (selectPrimary) return new Proxy({ ready: true }, { get: Reflect.get })
        return new Proxy({ ready: false }, { get: Reflect.get })
      }
      function maybeProxyGate() {
        if (selectPrimary) return new Proxy({ ready: true }, { get: Reflect.get })
      }
      function identityGate<T>(value: T): T { return value }
      function forwardGate<T>(value: T): T { return identityGate(value) }
      function optionalGate(value?: { ready: boolean }) { return value }
      function defaultGate(enabled = true) {
        if (enabled) return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function destructuredGate({ value }: { value: { ready: boolean } }) { return value }
      function modeGate(mode: "proxy" | "plain") {
        if (mode === "proxy") return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function nonPlainGate(mode: "proxy" | "plain") {
        if (mode !== "plain") return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function statusGate(status: number) {
        if (status === 200) return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function coerciveStatusGate(status: number | string) {
        if (status == 200) return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function compoundAndGate(mode: "proxy" | "plain", enabled: boolean) {
        if (mode === "proxy" && enabled) return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function compoundOrGate(mode: "proxy" | "plain", forced: boolean) {
        if (mode === "proxy" || forced) return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      declare function opaqueBoolean(): boolean
      function shortCircuitGate(enabled: boolean) {
        if (enabled || opaqueBoolean()) return new Proxy({ ready: true }, { get: Reflect.get })
        return { ready: true }
      }
      function conditionalExpressionGate<T>(enabled: boolean, value: T): T | { ready: boolean } {
        return enabled ? value : { ready: true }
      }
      function switchGate(mode: "alias" | "proxy" | "plain") {
        switch (mode) {
          case "alias":
          case "proxy": return new Proxy({ ready: true }, { get: Reflect.get })
          default: return { ready: true }
        }
      }
      function numericSwitchGate(status: 200 | 404) {
        switch (status) {
          case 200: return new Proxy({ ready: true }, { get: Reflect.get })
          default: return { ready: true }
        }
      }
      function defaultSwitchGate(mode: "plain" | "fallback") {
        switch (mode) {
          case "plain": return { ready: true }
          default: return new Proxy({ ready: true }, { get: Reflect.get })
        }
      }
      const gate = wrapGate()
      const literalBranchGate = chooseGate(true)
      const negatedBranchGate = chooseNegatedGate(true)
      declare const dynamicChoice: boolean
      const dynamicGate = chooseGate(dynamicChoice)
      const conditionalProxyGate = chooseProxyGate()
      const fallthroughGate = maybeProxyGate()
      const substitutedProxyGate = forwardGate(new Proxy({ ready: true }, { get: Reflect.get }))
      const substitutedPlainGate = forwardGate({ ready: true })
      const missingGate = optionalGate()
      const defaultedProxyGate = defaultGate()
      const destructuredProxyGate = destructuredGate({ value: new Proxy({ ready: true }, { get: Reflect.get }) })
      const stringEqualityGate = modeGate("proxy")
      const stringInequalityGate = nonPlainGate("proxy")
      const numberEqualityGate = statusGate(200)
      const coerciveEqualityGate = coerciveStatusGate(200)
      const compoundAndProxyGate = compoundAndGate("proxy", true)
      const compoundOrProxyGate = compoundOrGate("plain", true)
      const shortCircuitedProxyGate = shortCircuitGate(true)
      const dynamicCompoundGate = compoundAndGate("proxy", dynamicChoice)
      const conditionalExpressionProxyGate = conditionalExpressionGate(true, new Proxy({ ready: true }, { get: Reflect.get }))
      const dynamicConditionalExpressionGate = conditionalExpressionGate(dynamicChoice, new Proxy({ ready: true }, { get: Reflect.get }))
      const stringSwitchGate = switchGate("alias")
      const numberSwitchGate = numericSwitchGate(200)
      const fallbackSwitchGate = defaultSwitchGate("fallback")
      const dynamicSwitchGate = switchGate(dynamicMode)
      declare const dynamicMode: "proxy" | "plain"
      const dynamicModeGate = modeGate(dynamicMode)
      async function factoryProxy(enabled: boolean) {
        let success: Resource | undefined
        let failure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            gate.ready
            success = resource
          } catch {
            failure = resource
          }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        failure?.send()
      }
      async function literalBranchFactoryProxy(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            literalBranchGate.ready
            success = resource
          } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function negatedBranchFactoryProxy(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { negatedBranchGate.ready; success = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function dynamicBranchIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { dynamicGate.ready; success = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function allReturnPathsAreProxies(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { conditionalProxyGate.ready; success = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function fallthroughFactoryIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { fallthroughGate?.ready; success = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function substitutedFactoryProxy(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { substitutedProxyGate.ready; success = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function substitutedPlainIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { substitutedPlainGate.ready; success = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function unsupportedSubstitutionIsUnknown(enabled: boolean) {
        let missing: Resource | undefined
        let destructured: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { missingGate?.ready; missing = resource }
          catch {}
          try { destructuredProxyGate.ready; destructured = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        missing?.send()
        destructured?.send()
      }
      async function defaultParameterProxy(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { defaultedProxyGate.ready; success = resource }
          catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function literalEqualityFactoryProxy(enabled: boolean) {
        let stringEqual: Resource | undefined
        let stringUnequal: Resource | undefined
        let numberEqual: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { stringEqualityGate.ready; stringEqual = resource } catch {}
          try { stringInequalityGate.ready; stringUnequal = resource } catch {}
          try { numberEqualityGate.ready; numberEqual = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        stringEqual?.send()
        stringUnequal?.send()
        numberEqual?.send()
      }
      async function dynamicEqualityIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { dynamicModeGate.ready; success = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function coerciveEqualityIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { coerciveEqualityGate.ready; success = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function literalSwitchFactoryProxy(enabled: boolean) {
        let stringCase: Resource | undefined
        let numberCase: Resource | undefined
        let defaultCase: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { stringSwitchGate.ready; stringCase = resource } catch {}
          try { numberSwitchGate.ready; numberCase = resource } catch {}
          try { fallbackSwitchGate.ready; defaultCase = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        stringCase?.send()
        numberCase?.send()
        defaultCase?.send()
      }
      async function dynamicSwitchIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { dynamicSwitchGate.ready; success = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function literalCompoundFactoryProxy(enabled: boolean) {
        let andCase: Resource | undefined
        let orCase: Resource | undefined
        let shortCircuitCase: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { compoundAndProxyGate.ready; andCase = resource } catch {}
          try { compoundOrProxyGate.ready; orCase = resource } catch {}
          try { shortCircuitedProxyGate.ready; shortCircuitCase = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        andCase?.send()
        orCase?.send()
        shortCircuitCase?.send()
      }
      async function dynamicCompoundIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { dynamicCompoundGate.ready; success = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function literalConditionalExpressionFactoryProxy(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { conditionalExpressionProxyGate.ready; success = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
      async function dynamicConditionalExpressionIsUnknown(enabled: boolean) {
        let success: Resource | undefined
        while (enabled) {
          await using resource = open()
          try { dynamicConditionalExpressionGate.ready; success = resource } catch {}
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "factoryProxy");
    expect(aliases.map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional"]);
    expect(aliases[0]?.generation.controlPaths[0]?.[0]).toMatchObject({ expected: true });
    expect(aliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
      id: aliases[0]?.generation.controlPaths[0]?.[0]?.id,
      expected: false,
    });
    expect(result.resourceAliases.find((alias) => alias.owner === "literalBranchFactoryProxy")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.find((alias) => alias.owner === "negatedBranchFactoryProxy")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.find((alias) => alias.owner === "dynamicBranchIsUnknown")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.find((alias) => alias.owner === "allReturnPathsAreProxies")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.find((alias) => alias.owner === "fallthroughFactoryIsUnknown")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.find((alias) => alias.owner === "substitutedFactoryProxy")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.find((alias) => alias.owner === "substitutedPlainIsUnknown")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.filter((alias) => alias.owner === "unsupportedSubstitutionIsUnknown").map((alias) => alias.generation.relation)).toEqual(["latest", "latest"]);
    expect(result.resourceAliases.find((alias) => alias.owner === "defaultParameterProxy")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.filter((alias) => alias.owner === "literalEqualityFactoryProxy").map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional", "conditional"]);
    expect(result.resourceAliases.find((alias) => alias.owner === "dynamicEqualityIsUnknown")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.find((alias) => alias.owner === "coerciveEqualityIsUnknown")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.filter((alias) => alias.owner === "literalSwitchFactoryProxy").map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional", "conditional"]);
    expect(result.resourceAliases.find((alias) => alias.owner === "dynamicSwitchIsUnknown")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.filter((alias) => alias.owner === "literalCompoundFactoryProxy").map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional", "conditional"]);
    expect(result.resourceAliases.find((alias) => alias.owner === "dynamicCompoundIsUnknown")?.generation.relation).toBe("latest");
    expect(result.resourceAliases.find((alias) => alias.owner === "literalConditionalExpressionFactoryProxy")?.generation.relation).toBe("conditional");
    expect(result.resourceAliases.find((alias) => alias.owner === "dynamicConditionalExpressionIsUnknown")?.generation.relation).toBe("latest");
  });

  it("tracks an imported Proxy factory through a re-export", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-proxy-factory-"));
    try {
      const factory = join(directory, "factory.ts"), barrel = join(directory, "index.ts"), main = join(directory, "main.ts");
      writeFileSync(factory, `
        declare const selectPrimary: boolean
        export function createGate() {
          if (selectPrimary) return new Proxy({ ready: true }, { get: Reflect.get })
          return new Proxy({ ready: false }, { get: Reflect.get })
        }
        export function forwardGate<T>(value: T): T { return value }
        export function selectGate(mode: "proxy" | "plain") {
          return selectCompoundGate(mode, true)
        }
        function selectCompoundGate(mode: "proxy" | "plain", enabled: boolean) {
          return mode === "proxy" && enabled
            ? new Proxy({ ready: true }, { get: Reflect.get })
            : { ready: true }
        }
      `);
      writeFileSync(barrel, `export { createGate as makeGate, forwardGate as forward, selectGate as select } from "./factory.js"`);
      writeFileSync(main, `
        import { makeGate, forward, select } from "./index.js"
        interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
        declare function open(): Resource
        const gate = makeGate()
        const forwarded = forward(new Proxy({ ready: true }, { get: Reflect.get }))
        const selected = select("proxy")
        async function importedFactoryProxy(enabled: boolean) {
          let success: Resource | undefined
          let failure: Resource | undefined
          while (enabled) {
            await using resource = open()
            try { gate.ready; success = resource }
            catch { failure = resource }
            await Promise.resolve("tick").then((value) => value)
          }
          success?.send()
          failure?.send()
        }
        async function importedArgumentProxy(enabled: boolean) {
          let success: Resource | undefined
          while (enabled) {
            await using resource = open()
            try { forwarded.ready; success = resource }
            catch {}
            await Promise.resolve("tick").then((value) => value)
          }
          success?.send()
        }
        async function importedLiteralBranchProxy(enabled: boolean) {
          let success: Resource | undefined
          while (enabled) {
            await using resource = open()
            try { selected.ready; success = resource }
            catch {}
            await Promise.resolve("tick").then((value) => value)
          }
          success?.send()
        }
      `);
      const program = ts.createProgram([factory, barrel, main], {
        target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.esnext.d.ts", "lib.esnext.disposable.d.ts"], noEmit: true,
      });
      const result = analyzeAsyncSafetyInProgram(program, program.getSourceFile(main)!);
      const aliases = result.resourceAliases.filter((alias) => alias.owner === "importedFactoryProxy");
      expect(aliases.map((alias) => alias.generation.relation)).toEqual(["conditional", "conditional"]);
      expect(aliases[1]?.generation.controlPaths[0]?.[0]).toMatchObject({
        id: aliases[0]?.generation.controlPaths[0]?.[0]?.id,
        expected: false,
      });
      expect(result.resourceAliases.find((alias) => alias.owner === "importedArgumentProxy")?.generation.relation).toBe("conditional");
      expect(result.resourceAliases.find((alias) => alias.owner === "importedLiteralBranchProxy")?.generation.relation).toBe("conditional");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("composes nested try completion identities for alias generations", () => {
    const result = analyzeAsyncSafety("nested-try-resource-generations.ts", `
      interface Resource { send(): void; [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      declare function mayThrowOuter(): void
      declare function mayThrowInner(): void
      async function broken(enabled: boolean) {
        let success: Resource | undefined
        let innerFailure: Resource | undefined
        let outerFailure: Resource | undefined
        while (enabled) {
          await using resource = open()
          try {
            mayThrowOuter()
            try {
              mayThrowInner()
              success = resource
            } catch {
              innerFailure = resource
            }
          } catch {
            outerFailure = resource
          }
          await Promise.resolve("tick").then((value) => value)
        }
        success?.send()
        innerFailure?.send()
        outerFailure?.send()
      }
    `);
    const aliases = result.resourceAliases.filter((alias) => alias.owner === "broken");
    expect(aliases).toHaveLength(3);
    expect(aliases[0]?.generation.controlPaths[0]).toHaveLength(2);
    expect(aliases[1]?.generation.controlPaths[0]).toHaveLength(2);
    expect(aliases[2]?.generation.controlPaths[0]).toHaveLength(1);
    const outerId = aliases[2]?.generation.controlPaths[0]?.[0]?.id;
    expect(aliases[0]?.generation.controlPaths[0]).toContainEqual({ id: outerId, expected: true });
    expect(aliases[1]?.generation.controlPaths[0]).toContainEqual({ id: outerId, expected: true });
    const quint = generateUnifiedAsyncQuint("nested_try_resource_generations", result, "broken");
    expect(run(quint, 36).status).not.toBe(0);
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

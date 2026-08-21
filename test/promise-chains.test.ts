import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { analyzePromiseChains, analyzePromiseChainsInProgram, generatePromiseChainsQuint } from "../src/promise-chains.js";

const source = `
  function cleanup() {}
  function make() {
    const promise = new Promise<number>((resolve) => { resolve(1) })
    return promise.then((value) => value + 1, () => -1).catch(() => 0).finally(cleanup)
  }
`;

function run(program: string) {
  const directory = mkdtempSync(join(tmpdir(), "uneffect-promise-chain-"));
  const path = join(directory, "model.qnt");
  writeFileSync(path, program);
  return spawnSync("pnpm", ["exec", "quint", "run", path,
    "--invariant=promiseSafe", "--max-steps=10", "--max-samples=300",
    "--seed=0x123456789abcdef", "--verbosity=1"], { encoding: "utf8", timeout: 30_000 });
}

describe("Promise state and reaction chains", () => {
  it("derives first-settlement-wins outcomes from inline executor control flow", () => {
    const model = analyzePromiseChains("executor.ts", `
      declare const flag: boolean
      function fulfilledFirst() {
        const promise = new Promise<number>((resolve, reject) => {
          resolve(1)
          reject(new Error("ignored"))
        })
        return promise.then(value => value)
      }
      function branched() {
        const promise = new Promise<number>((resolve, reject) => {
          if (flag) resolve(1)
          else reject(new Error("no"))
        })
        return promise.then(value => value)
      }
      function thrownFirst() {
        const promise = new Promise<number>((resolve) => {
          throw new Error("boom")
          resolve(1)
        })
        return promise.catch(() => 0)
      }
    `);
    expect(model.executors.map(({ possibleSettlements, mayRemainPending }) => ({ possibleSettlements, mayRemainPending }))).toEqual([
      { possibleSettlements: ["fulfilled"], mayRemainPending: false },
      { possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: false },
      { possibleSettlements: ["rejected"], mayRemainPending: false },
    ]);
  });

  it("models resolving with a PromiseLike as assimilation", () => {
    const model = analyzePromiseChains("assimilation.ts", `
      declare const other: PromiseLike<number>
      function assimilate() {
        const promise = new Promise<number>((resolve) => resolve(other))
        return promise.then(value => value)
      }
    `);
    expect(model.executors[0]).toMatchObject({ possibleSettlements: ["assimilating"], mayRemainPending: false });
    const quint = generatePromiseChainsQuint("assimilation", model);
    expect(quint).toContain("settle_0_assimilating");
    expect(quint).toContain("assimilate_0_thenable_0_fulfilled");
    expect(quint).toContain("assimilate_0_thenable_0_rejected");
  });

  it("links executor assimilation to an analyzed Promise instead of inventing either outcome", () => {
    const model = analyzePromiseChains("linked-assimilation.ts", `
      function linked() {
        const source = new Promise<number>((_resolve, reject) => reject(new Error("no")))
        source.then(value => value)
        const adopted = new Promise<number>((resolve) => resolve(source))
        return adopted.then(value => value)
      }
    `);
    expect(model.executors[1]).toMatchObject({ adoptedExecutor: 0 });
    const quint = generatePromiseChainsQuint("linked_executor", model);
    expect(quint).toContain("assimilate_1_from_0_rejected");
    expect(quint).not.toContain("assimilate_1_fulfilled");
    expect(quint).not.toContain("assimilate_1_rejected");
  });

  it("models self-resolution, throwing then getters, and hostile first-call-wins thenables", () => {
    const model = analyzePromiseChains("thenables.ts", `
      function selfResolving() {
        const promise = new Promise<number>((resolve) => resolve(promise))
        return promise.catch(() => 0)
      }
      function throwingGetter() {
        const foreign = { get then(): never { throw new Error("getter") } }
        const promise = new Promise<never>((resolve) => resolve(foreign))
        return promise.catch(() => undefined)
      }
      function hostile() {
        const foreign = {
          then(resolve: (value: number) => void, reject: (error: Error) => void) {
            resolve(1)
            reject(new Error("ignored"))
          }
        }
        const promise = new Promise<number>((resolve) => resolve(foreign))
        return promise.then(value => value)
      }
    `);
    expect(model.executors).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: "promise", selfResolution: true, possibleSettlements: ["assimilating"] }),
      expect.objectContaining({ owner: "throwingGetter", adoptedThenable: 0 }),
      expect.objectContaining({ owner: "hostile", adoptedThenable: 1 }),
    ]));
    expect(model.thenables).toEqual([
      expect.objectContaining({ binding: "foreign", thenAccess: "throws", invokesUserCode: true, possibleSettlements: ["rejected"], firstCallWins: true }),
      expect.objectContaining({ binding: "foreign", thenAccess: "callable", invokesUserCode: true, possibleSettlements: ["fulfilled"], firstCallWins: true }),
    ]);
    const quint = generatePromiseChainsQuint("hostile_thenables", model);
    expect(quint).toContain("assimilate_0_self_resolution_rejected");
    expect(quint).toContain("assimilate_1_thenable_0_getter_rejected");
    expect(quint).toContain("assimilate_2_thenable_1_fulfilled");
    expect(quint).not.toContain("assimilate_2_thenable_1_rejected");
    expect(run(quint).status).toBe(0);
  }, 20_000);

  it("models conditional getters, proxies, and external PromiseLike values as user-code assimilation", () => {
    const model = analyzePromiseChains("dynamic-thenables.ts", `
      declare const flag: boolean
      declare const external: PromiseLike<number>
      function dynamic() {
        const conditional = { get then() { if (flag) throw new Error("getter"); return (resolve: (value: number) => void) => resolve(1) } }
        const proxied = new Proxy({ then(resolve: (value: number) => void) { resolve(1) } }, {})
        const first = new Promise<number>((resolve) => resolve(conditional))
        const second = new Promise<number>((resolve) => resolve(proxied))
        const third = new Promise<number>((resolve) => resolve(external))
        first.catch(() => 0)
        second.catch(() => 0)
        return third.catch(() => 0)
      }
    `);
    expect(model.thenables).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: "conditional", thenAccess: "dynamic", capabilityEffects: ["InvokeUserCode"], possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true }),
      expect.objectContaining({ binding: "proxied", thenAccess: "dynamic", capabilityEffects: ["InvokeUserCode"] }),
      expect.objectContaining({ binding: "external", thenAccess: "dynamic", provenance: "external", capabilityEffects: ["InvokeUserCode"] }),
    ]));
    expect(model.executors.filter((item) => item.owner === "dynamic").map((item) => item.adoptedThenable)).toEqual([0, 1, 2]);
    const quint = generatePromiseChainsQuint("dynamic_thenables", model);
    expect(quint).toContain("thenable_0_fulfilled");
    expect(quint).toContain("thenable_0_rejected");
    expect(quint).toContain("thenable_1_fulfilled");
    expect(quint).toContain("thenable_1_rejected");
    expect(quint).toContain("thenable_2_fulfilled");
    expect(quint).toContain("thenable_2_rejected");
  });

  it("retains imported PromiseLike symbol identity as external user code", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-thenable-"));
    try {
      const external = join(directory, "external.ts"), main = join(directory, "main.ts");
      writeFileSync(external, `export declare const operation: PromiseLike<number>`);
      writeFileSync(main, `import { operation } from "./external.js"; export function run() { const result = new Promise<number>(resolve => resolve(operation)); return result.catch(() => 0) }`);
      const program = ts.createProgram([external, main], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const model = analyzePromiseChainsInProgram(program, program.getSourceFile(main)!);
      expect(model.thenables).toContainEqual(expect.objectContaining({ binding: "operation", provenance: "external", thenAccess: "dynamic" }));
      expect(model.executors[0]).toMatchObject({ adoptedThenable: 0 });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("links a Promise returned by an inline reaction handler to its analyzed source", () => {
    const model = analyzePromiseChains("linked-handler.ts", `
      function linked() {
        const root = new Promise<number>((resolve) => resolve(1))
        const result = root.then(() => source).catch(() => 0)
        const source = new Promise<number>((_resolve, reject) => reject(new Error("no")))
        source.then(value => value)
        return result
      }
    `);
    expect(model.chains[0].links[0]).toMatchObject({ handlerExecutors: [1] });
    const quint = generatePromiseChainsQuint("linked_handler", model);
    expect(quint).toContain("assimilate_0_0_from_1_rejected");
    expect(quint).not.toContain("assimilate_0_0_fulfilled");
    expect(quint).not.toContain("assimilate_0_0_rejected");
  });

  it("flattens PromiseLike values returned by reaction handlers", () => {
    const model = analyzePromiseChains("flatten.ts", `
      declare const source: Promise<number>
      declare function next(value: number): PromiseLike<string>
      function flatten() {
        return source.then(next).catch(async () => "recovered").finally(async () => {})
      }
    `);
    expect(model.chains[0].links.map((link) => link.handlerReturns)).toEqual([
      ["promise-like"],
      ["promise-like"],
      ["promise-like"],
    ]);
    const quint = generatePromiseChainsQuint("flatten", model);
    expect(quint).toContain("react_0_0_handle_assimilate");
    expect(quint).toContain("react_0_1_recover_assimilate");
    expect(quint).toContain("react_0_2_finally_assimilate_after_reject");
    expect(quint).toContain("assimilate_0_2_preserve_reject");
    const positive = run(quint);
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    const skipped = run(generatePromiseChainsQuint("flatten_skipped", model, { skipHandlerAssimilation: true }));
    expect(skipped.status).not.toBe(0);
    expect(skipped.stdout + skipped.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);

  it("extracts builtin executors and then/catch/finally without spelling fallback", () => {
    expect(analyzePromiseChains("chain.ts", source)).toMatchObject({
      executors: [{ owner: "make", binding: "promise", synchronous: true, throwBecomesRejection: true }],
      chains: [{ owner: "make", source: "promise", executor: 0, links: [
        { kind: "then", handlers: [expect.any(String), expect.any(String)] }, { kind: "catch" }, { kind: "finally" },
      ] }],
    });
    expect(analyzePromiseChains("shadow.ts", `
      class Promise<T> { constructor(_f: unknown) {} then() { return this } }
      function f() { return new Promise(() => {}).then() }
    `)).toEqual({ executors: [], thenables: [], chains: [] });
  });

  it("distinguishes omitted handlers from handlers that may reject", () => {
    const model = analyzePromiseChains("omitted.ts", `
      declare const promise: Promise<number>
      function chain() { return promise.then(undefined, () => 1).catch(undefined).finally(undefined) }
    `);
    const quint = generatePromiseChainsQuint("omitted", model);
    expect(quint).toContain("handle_reject_ok");
    expect(quint).toContain("propagate_reject");
    expect(quint).not.toContain("throw_after_fulfill");
  });

  it("separates synchronous executor settlement from microtask reactions", () => {
    const model = analyzePromiseChains("chain.ts", source);
    const positive = run(generatePromiseChainsQuint("promise_chain", model));
    expect(positive.status, positive.stdout + positive.stderr).toBe(0);
    expect(positive.stdout + positive.stderr).toContain("No violation found");

    const early = run(generatePromiseChainsQuint("early_reaction", model, { allowEarlyReaction: true }));
    expect(early.status).not.toBe(0);
    expect(early.stdout + early.stderr).toMatch(/violation|counterexample/i);

    const brokenFinally = run(generatePromiseChainsQuint("broken_finally", model, { breakFinallyTransparency: true }));
    expect(brokenFinally.status).not.toBe(0);
    expect(brokenFinally.stdout + brokenFinally.stderr).toMatch(/violation|counterexample/i);

    const doubleSettlement = run(generatePromiseChainsQuint("double_settlement", model, { allowDoubleSettlement: true }));
    expect(doubleSettlement.status).not.toBe(0);
    expect(doubleSettlement.stdout + doubleSettlement.stderr).toMatch(/violation|counterexample/i);
  }, 20_000);
});

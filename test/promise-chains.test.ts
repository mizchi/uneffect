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

  it("retains an imported PromiseLike call result as external assimilation", () => {
    const directory = mkdtempSync(join(tmpdir(), "uneffect-imported-thenable-call-"));
    try {
      const external = join(directory, "external.ts"), main = join(directory, "main.ts");
      writeFileSync(external, `export declare function operation(): PromiseLike<number>`);
      writeFileSync(main, `import { operation } from "./external.js"; export function run() { const result = new Promise<number>(resolve => resolve(operation())); return result.catch(() => 0) }`);
      const program = ts.createProgram([external, main], { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true });
      const model = analyzePromiseChainsInProgram(program, program.getSourceFile(main)!);
      expect(model.thenables).toContainEqual(expect.objectContaining({ binding: "operation()", provenance: "external", thenAccess: "dynamic" }));
      expect(model.executors[0]).toMatchObject({ adoptedThenable: 0 });
      const quint = generatePromiseChainsQuint("imported_call_thenable", model);
      expect(quint).toContain("assimilate_0_thenable_0_fulfilled");
      expect(quint).toContain("assimilate_0_thenable_0_rejected");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps a dynamically selected thenable as conservative assimilation", () => {
    const model = analyzePromiseChains("selected-thenable.ts", `
      function run(flag: boolean) {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const second: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("second")); return this } }
        const result = new Promise<number>(resolve => resolve(flag ? first : second))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables).toHaveLength(2);
    expect(model.executors[0]).toMatchObject({ adoptedThenables: [0, 1] });
    const quint = generatePromiseChainsQuint("selected_thenable", model);
    expect(quint).toContain("assimilate_0_thenable_option_0_thenable_0_fulfilled");
    expect(quint).toContain("assimilate_0_thenable_option_1_thenable_1_rejected");
  });

  it("resolves an immutable tuple thenable selected by a const literal index", () => {
    const model = analyzePromiseChains("tuple-selected-thenable.ts", `
      function run() {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const second: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("second")); return this } }
        const choices = [first, second] as const
        const selected = 1 as const
        const result = new Promise<number>(resolve => resolve(choices[selected]))
        return result.catch(() => 0)
      }
    `);
    expect(model.executors[0]).toMatchObject({ adoptedThenables: [1], adoptedThenable: 1 });
    const quint = generatePromiseChainsQuint("tuple_selected_thenable", model);
    expect(quint).toContain("assimilate_0_thenable_1_rejected");
    expect(quint).not.toContain("assimilate_0_thenable_0_fulfilled");

    const mutable = analyzePromiseChains("mutable-selected-thenable.ts", `
      function run() {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const second: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("second")); return this } }
        const choices: PromiseLike<number>[] = [first, second]
        const result = new Promise<number>(resolve => resolve(choices[1]!))
        return result.catch(() => 0)
      }
    `);
    expect(mutable.thenables).toHaveLength(3);
    expect(mutable.executors[0]).toMatchObject({ adoptedThenables: [2], adoptedThenable: 2 });
    expect(mutable.thenables[2]).toMatchObject({ thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"] });
  });

  it("resolves an immutable object thenable selected by a const literal key", () => {
    const model = analyzePromiseChains("object-selected-thenable.ts", `
      function run() {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const second: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("second")); return this } }
        const choices = { ok: first, fail: second } as const
        const selected = "fail" as const
        const result = new Promise<number>(resolve => resolve(choices[selected]))
        return result.catch(() => 0)
      }
    `);
    expect(model.executors[0]).toMatchObject({ adoptedThenables: [1], adoptedThenable: 1 });

    const mutable = analyzePromiseChains("mutable-object-selected-thenable.ts", `
      function run() {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const choices: Record<string, PromiseLike<number>> = { ok: first }
        const result = new Promise<number>(resolve => resolve(choices["ok"]!))
        return result.catch(() => 0)
      }
    `);
    expect(mutable.thenables.at(-1)).toMatchObject({ binding: 'choices["ok"]!', thenAccess: "dynamic" });
  });

  it("resolves immutable thenable table and key alias chains", () => {
    const model = analyzePromiseChains("aliased-object-selected-thenable.ts", `
      function run() {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const second: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("second")); return this } }
        const base = { ok: first, fail: second } as const
        const choices = base
        const baseKey = "fail" as const
        const selected = baseKey
        const result = new Promise<number>(resolve => resolve(choices[selected]))
        return result.catch(() => 0)
      }
    `);
    expect(model.executors[0]).toMatchObject({ adoptedThenables: [1], adoptedThenable: 1 });
  });

  it("resolves an immutable object thenable selected by property access", () => {
    const model = analyzePromiseChains("property-selected-thenable.ts", `
      function run() {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const second: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("second")); return this } }
        const base = { ok: first, fail: second } as const
        const choices = base
        const result = new Promise<number>(resolve => resolve(choices.fail))
        return result.catch(() => 0)
      }
    `);
    expect(model.executors[0]).toMatchObject({ adoptedThenables: [1], adoptedThenable: 1 });
  });

  it("links a directly chained Promise constructor to its executor", () => {
    const model = analyzePromiseChains("direct-constructor-chain.ts", `
      function run(remote: PromiseLike<number>) {
        return new Promise<number>(resolve => resolve(remote)).catch(() => 0)
      }
    `);
    expect(model.chains[0]).toMatchObject({ executor: 0, links: [{ kind: "catch" }] });
    const quint = generatePromiseChainsQuint("direct_constructor_chain", model);
    expect(quint).toContain("settle_0_assimilating");
    expect(quint).toContain("assimilate_0_thenable_0_fulfilled");
    expect(quint).toContain("assimilate_0_thenable_0_rejected");
  });

  it("resolves a thenable returned by a local factory before assimilation", () => {
    const model = analyzePromiseChains("returned-thenable.ts", `
      function hostile() {
        return { then(_resolve: (value: number) => void, reject: (reason: Error) => void) {
          reject(new Error("factory rejection"))
        } }
      }
      function run() {
        const operation = hostile()
        const result = new Promise<number>((resolve) => resolve(operation))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables).toContainEqual(expect.objectContaining({
      binding: "operation",
      provenance: "local",
      thenAccess: "callable",
      possibleSettlements: ["rejected"],
      mayRemainPending: false,
    }));
    expect(model.executors.find((executor) => executor.binding === "result")).toMatchObject({ adoptedThenable: 0 });
    const quint = generatePromiseChainsQuint("returned_thenable", model);
    expect(quint).toContain("thenable_0_rejected");
    expect(quint).not.toContain("thenable_0_fulfilled");
  });

  it("keeps nested thenable assimilation live instead of dropping its outcomes", () => {
    const model = analyzePromiseChains("nested-thenable.ts", `
      function run() {
        const inner = { then(_resolve: (value: number) => void, reject: (reason: Error) => void) { reject(new Error("inner")) } }
        const outer = { then(resolve: (value: PromiseLike<number>) => void) { resolve(inner) } }
        const result = new Promise<number>((resolve) => resolve(outer))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables.find((thenable) => thenable.binding === "inner")).toMatchObject({ possibleSettlements: ["rejected"] });
    expect(model.thenables.find((thenable) => thenable.binding === "outer")).toMatchObject({ adoptedThenable: 0 });
    const quint = generatePromiseChainsQuint("nested_thenable", model);
    expect(quint).toContain("assimilate_0_thenable_1_nested_thenable_0_rejected");
    expect(quint).not.toContain("assimilate_0_thenable_1_nested_thenable_0_fulfilled");
  });

  it("links a nested external PromiseLike symbol conservatively", () => {
    const model = analyzePromiseChains("nested-external-thenable.ts", `
      declare const inner: PromiseLike<number>
      function run() {
        const outer = { then(resolve: (value: PromiseLike<number>) => void) { resolve(inner) } }
        const result = new Promise<number>((resolve) => resolve(outer))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables.find((thenable) => thenable.binding === "inner")).toMatchObject({ provenance: "external", thenAccess: "dynamic" });
    expect(model.thenables.find((thenable) => thenable.binding === "outer")).toMatchObject({ adoptedThenable: 0 });
    const quint = generatePromiseChainsQuint("nested_external_thenable", model);
    expect(quint).toContain("assimilate_0_thenable_1_nested_thenable_0_fulfilled");
    expect(quint).toContain("assimilate_0_thenable_1_nested_thenable_0_rejected");
  });

  it("refines a forward local nested thenable without changing its identity", () => {
    const model = analyzePromiseChains("nested-forward-thenable.ts", `
      function run() {
        const outer = { then(resolve: (value: PromiseLike<number>) => void) { resolve(inner) } }
        const inner = { then(_resolve: (value: number) => void, reject: (reason: Error) => void) { reject(new Error("inner")) } }
        const result = new Promise<number>((resolve) => resolve(outer))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables[0]).toMatchObject({ binding: "inner", provenance: "local", possibleSettlements: ["rejected"] });
    expect(model.thenables.find((thenable) => thenable.binding === "outer")).toMatchObject({ adoptedThenable: 0 });
    const quint = generatePromiseChainsQuint("nested_forward_thenable", model);
    expect(quint).toContain("nested_thenable_0_rejected");
    expect(quint).not.toContain("nested_thenable_0_fulfilled");
  });

  it("links an inline nested thenable expression exactly", () => {
    const model = analyzePromiseChains("nested-inline-thenable.ts", `
      function run() {
        const outer = { then(resolve: (value: PromiseLike<number>) => void) {
          resolve({ then(_resolve: (value: number) => void, reject: (reason: Error) => void) { reject(new Error("inline")) } })
        } }
        const result = new Promise<number>((resolve) => resolve(outer))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables[0]).toMatchObject({ binding: expect.stringContaining("then(_resolve"), provenance: "local", possibleSettlements: ["rejected"] });
    expect(model.thenables.find((thenable) => thenable.binding === "outer")).toMatchObject({ adoptedThenable: 0 });
    const quint = generatePromiseChainsQuint("nested_inline_thenable", model);
    expect(quint).toContain("nested_thenable_0_rejected");
    expect(quint).not.toContain("nested_thenable_0_fulfilled");
  });

  it("keeps a mutually recursive thenable assimilation cycle pending", () => {
    const model = analyzePromiseChains("recursive-thenables.ts", `
      function run() {
        const first: PromiseLike<number> = { then(resolve) { resolve(second); return this } }
        const second: PromiseLike<number> = { then(resolve) { resolve(first); return this } }
        const result = new Promise<number>(resolve => resolve(first))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables).toHaveLength(2);
    expect(model.thenables.every((thenable) => thenable.mayRemainPending)).toBe(true);
    const quint = generatePromiseChainsQuint("recursive_thenables", model);
    expect(quint).toContain("settle_0_assimilating");
    expect(quint).not.toMatch(/assimilate_0.*_(fulfilled|rejected)/);

    const selfCycle = analyzePromiseChains("self-recursive-thenable.ts", `
      function run() {
        const loop: PromiseLike<number> = { then(resolve) { resolve(loop); return this } }
        const result = new Promise<number>(resolve => resolve(loop))
        return result.catch(() => 0)
      }
    `);
    const selfCycleQuint = generatePromiseChainsQuint("self_recursive_thenable", selfCycle);
    expect(selfCycle.thenables[0]).toMatchObject({ adoptedThenable: 0, mayRemainPending: true });
    expect(selfCycleQuint).not.toMatch(/assimilate_0.*_(fulfilled|rejected)/);
  });

  it("recognizes a direct Proxy get trap that always throws during then lookup", () => {
    const model = analyzePromiseChains("proxy-trap.ts", `
      function run() {
        const hostile = new Proxy({ then() {} }, {
          get(_target, _key) { throw new TypeError("blocked") }
        })
        const result = new Promise<void>((resolve) => resolve(hostile))
        return result.catch(() => undefined)
      }
    `);
    expect(model.thenables).toContainEqual(expect.objectContaining({
      binding: "hostile",
      provenance: "proxy",
      thenAccess: "throws",
      possibleSettlements: ["rejected"],
      mayRemainPending: false,
    }));
    const quint = generatePromiseChainsQuint("proxy_trap", model);
    expect(quint).toContain("thenable_0_getter_rejected");
    expect(quint).not.toContain("thenable_0_fulfilled");
  });

  it("analyzes a Proxy get trap returning a concrete then callback", () => {
    const model = analyzePromiseChains("proxy-returned-then.ts", `
      function run() {
        const hostile = new Proxy({ then() {} }, {
          get() { return (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy")) }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });
    const quint = generatePromiseChainsQuint("proxy_returned_then", model);
    expect(quint).toContain("thenable_0_rejected");
    expect(quint).not.toContain("thenable_0_fulfilled");
  });

  it("selects the concrete then branch of a forwarding Proxy trap", () => {
    const model = analyzePromiseChains("proxy-forwarded-then.ts", `
      function run() {
        const hostile = new Proxy({ then() {} }, {
          get(target, property, receiver) {
            if (property === "then") return (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
            return Reflect.get(target, property, receiver)
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(model.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const conditional = analyzePromiseChains("proxy-conditional-forwarded-then.ts", `
      function run() {
        const hostile = new Proxy({ then() {} }, {
          get(target, property, receiver) {
            return property === "then"
              ? (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
              : Reflect.get(target, property, receiver)
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(conditional.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const wrongSelector = analyzePromiseChains("proxy-wrong-selector.ts", `
      function run() {
        const hostile = new Proxy({ then() {} }, {
          get(target, property, receiver) {
            return property === "valueOf"
              ? (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
              : Reflect.get(target, property, receiver)
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(wrongSelector.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
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

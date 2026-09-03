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

  it("retains exact thenable identities for finite conditional keys", () => {
    const model = analyzePromiseChains("conditional-key-thenable.ts", `
      function run(flag: boolean) {
        const first: PromiseLike<number> = { then(resolve) { resolve(1); return this } }
        const second: PromiseLike<number> = { then(_resolve, reject) { reject?.(new Error("second")); return this } }
        const choices = { ok: first, fail: second } as const
        const selected = flag ? "ok" : "fail"
        const tuple = [first, second] as const
        const index = flag ? 0 : 1
        const objectResult = new Promise<number>(resolve => resolve(choices[selected])).catch(() => 0)
        const tupleResult = new Promise<number>(resolve => resolve(tuple[index])).catch(() => 0)
        return Promise.all([objectResult, tupleResult])
      }
    `);
    expect(model.executors[0]).toMatchObject({ adoptedThenables: [0, 1] });
    expect(model.executors[0].adoptedThenable).toBeUndefined();
    expect(model.executors[1]).toMatchObject({ adoptedThenables: [0, 1] });
    const quint = generatePromiseChainsQuint("conditional_key_thenable", model);
    expect(quint).toContain("assimilate_0_thenable_option_0_thenable_0_fulfilled");
    expect(quint).toContain("assimilate_0_thenable_option_1_thenable_1_rejected");
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

  it("recognizes a statically guarded Proxy throw without skipping an opaque prefix", () => {
    const guarded = analyzePromiseChains("proxy-guarded-throw.ts", `
      function run() {
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            if (property === "then") {
              throw new TypeError("blocked")
            }
            return undefined
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(guarded.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "throws", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const opaquePrefix = analyzePromiseChains("proxy-opaque-prefix-throw.ts", `
      declare function audit(): void
      function run() {
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            audit()
            if (property === "then") throw new TypeError("blocked")
            return undefined
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(opaquePrefix.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
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

  it("follows an immutable local alias returned as a Proxy then callback", () => {
    const exact = analyzePromiseChains("proxy-aliased-then.ts", `
      function run() {
        const thenCallback = (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, {
          get() { return thenCallback }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const mutable = analyzePromiseChains("proxy-mutable-aliased-then.ts", `
      function run(flag: boolean) {
        let thenCallback = (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
        if (flag) thenCallback = (resolve) => resolve(1)
        const hostile = new Proxy({ then() {} }, {
          get() { return thenCallback }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(mutable.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("follows an immutable local Proxy handler alias", () => {
    const exact = analyzePromiseChains("proxy-handler-alias.ts", `
      function run() {
        const thenCallback = (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const handler = { get() { return thenCallback } }
        const hostile = new Proxy({ then() {} }, handler)
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const mutable = analyzePromiseChains("proxy-mutable-handler-alias.ts", `
      function run(flag: boolean) {
        let handler = { get() { return (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy")) } }
        if (flag) handler = { get() { return (resolve: (value: number) => void) => resolve(1) } }
        const hostile = new Proxy({ then() {} }, handler)
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(mutable.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("follows an immutable Proxy get trap property alias", () => {
    const exact = analyzePromiseChains("proxy-get-trap-alias.ts", `
      function run() {
        const thenCallback = (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const getTrap = () => thenCallback
        const handler = { get: getTrap }
        const hostile = new Proxy({ then() {} }, handler)
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const mutable = analyzePromiseChains("proxy-mutable-get-trap-alias.ts", `
      function run(flag: boolean) {
        let getTrap = () => (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        if (flag) getTrap = () => (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get: getTrap })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(mutable.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("resolves a literal-computed Proxy get handler", () => {
    const exact = analyzePromiseChains("proxy-computed-get.ts", `
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, {
          ["get"](_target, property) {
            return property === "then" ? rejectThen : undefined
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const immutableKey = analyzePromiseChains("proxy-immutable-computed-get.ts", `
      const trapName = "get" as const
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, {
          [trapName]: (_target: unknown, property: PropertyKey) => property === "then" ? rejectThen : undefined
        } as ProxyHandler<{ then(): void }>)
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(immutableKey.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const dynamic = analyzePromiseChains("proxy-dynamic-computed-get.ts", `
      declare const trapName: string
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, {
          [trapName](_target: unknown, property: PropertyKey) {
            return property === "then" ? rejectThen : undefined
          }
        } as ProxyHandler<{ then(): void }>)
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(dynamic.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("resolves immutable Proxy handler object spreads with last-write-wins semantics", () => {
    const exact = analyzePromiseChains("proxy-spread-get.ts", `
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const base: ProxyHandler<PromiseLike<number>> = { get: (_target, property) => property === "then" ? rejectThen : undefined }
        const handler: ProxyHandler<PromiseLike<number>> = { ...base }
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, handler)
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const exactOverride = analyzePromiseChains("proxy-spread-get-override.ts", `
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const base: ProxyHandler<PromiseLike<number>> = { get: () => rejectThen }
        const handler: ProxyHandler<PromiseLike<number>> = { ...base, get: () => resolveThen }
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, handler)
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(exactOverride.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["fulfilled"], mayRemainPending: false,
    });

    const opaqueOverride = analyzePromiseChains("proxy-opaque-spread-get.ts", `
      declare const opaque: ProxyHandler<PromiseLike<number>>
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const handler: ProxyHandler<PromiseLike<number>> = { get: () => rejectThen, ...opaque }
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, handler)
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(opaqueOverride.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
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

    const ifElse = analyzePromiseChains("proxy-if-else-forwarded-then.ts", `
      function run() {
        const hostile = new Proxy({ then() {} }, {
          get(_target, property) {
            if (property === "then") {
              return (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
            } else {
              return undefined
            }
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(ifElse.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const negatedGuard = analyzePromiseChains("proxy-negated-guard-forwarded-then.ts", `
      function run() {
        const hostile = new Proxy({ then() {} }, {
          get(target, property, receiver) {
            if (property !== "then") return Reflect.get(target, property, receiver)
            return (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(negatedGuard.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
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

  it("walks nested static Proxy trap control flow without skipping effects", () => {
    const exact = analyzePromiseChains("proxy-nested-static-trap.ts", `
      function run() {
        const enabled = true as const
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            const isThen = property === "then"
            if (isThen) {
              if (enabled) return rejectThen
              return resolveThen
            }
            return undefined
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const effectful = analyzePromiseChains("proxy-effectful-static-trap.ts", `
      declare function audit(): void
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            const observed = audit()
            if (property === "then") return rejectThen
            return observed
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(effectful.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("walks source-ordered static switch routing in a Proxy trap", () => {
    const exact = analyzePromiseChains("proxy-static-switch-trap.ts", `
      declare function unreachableLabel(): string
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            const requested = property
            switch (requested) {
              case "then":
                return rejectThen
              case unreachableLabel():
                return undefined
              default:
                return undefined
            }
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const effectfulLeadingLabel = analyzePromiseChains("proxy-effectful-switch-trap.ts", `
      declare function dynamicLabel(): string
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            switch (property) {
              case dynamicLabel():
                return undefined
              case "then":
                return rejectThen
              default:
                return undefined
            }
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(effectfulLeadingLabel.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("continues after an unlabeled break from a static Proxy trap switch", () => {
    const exact = analyzePromiseChains("proxy-switch-break-trap.ts", `
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            switch (property) {
              case "then":
                break
              default:
                return undefined
            }
            return rejectThen
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const labeled = analyzePromiseChains("proxy-labeled-switch-break-trap.ts", `
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            route: switch (property) {
              case "then":
                break route
              default:
                return undefined
            }
            return rejectThen
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(labeled.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("composes restricted try/finally completion in a Proxy trap", () => {
    const preserved = analyzePromiseChains("proxy-try-finally-trap.ts", `
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            try {
              if (property === "then") return rejectThen
              return undefined
            } finally {}
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(preserved.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const overridden = analyzePromiseChains("proxy-finally-throw-trap.ts", `
      function run() {
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            try {
              if (property === "then") return resolveThen
              return undefined
            } finally {
              throw new TypeError("blocked")
            }
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(overridden.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "throws", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const effectfulFinally = analyzePromiseChains("proxy-effectful-finally-trap.ts", `
      declare function audit(): void
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            try {
              if (property === "then") return rejectThen
              return undefined
            } finally {
              audit()
            }
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(effectfulFinally.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("executes a Proxy trap catch only for a selected throw completion", () => {
    const caught = analyzePromiseChains("proxy-caught-throw-trap.ts", `
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            try {
              if (property === "then") throw new TypeError("route")
              return undefined
            } catch {
              return rejectThen
            } finally {}
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(caught.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const unreachableCatch = analyzePromiseChains("proxy-unreachable-catch-trap.ts", `
      declare function audit(): void
      function run() {
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            try {
              if (property === "then") return resolveThen
              return undefined
            } catch {
              audit()
              return undefined
            }
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(unreachableCatch.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["fulfilled"], mayRemainPending: false,
    });

    const unknownTry = analyzePromiseChains("proxy-unknown-try-catch-trap.ts", `
      declare function audit(): void
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} } as unknown as PromiseLike<number>, {
          get(_target, property) {
            try {
              audit()
              if (property === "then") throw new TypeError("route")
              return undefined
            } catch {
              return rejectThen
            }
          }
        })
        return new Promise<number>((resolve) => resolve(hostile)).catch(() => 0)
      }
    `);
    expect(unknownTry.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("resolves an immutable identity wrapper around a Proxy then callback", () => {
    const exact = analyzePromiseChains("proxy-identity-forwarded-then.ts", `
      function forward<T>(value: T): T { return value }
      const forwardAgain = <T>(value: T): T => forward(value)
      function run() {
        const thenCallback = (_resolve: (value: number) => void, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, {
          get(_target, property) {
            if (property === "then") return forwardAgain(thenCallback)
            return undefined
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const mutable = analyzePromiseChains("proxy-mutable-identity-forwarded-then.ts", `
      function run(flag: boolean) {
        const thenCallback = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        let forward = <T>(value: T): T => value
        if (flag) forward = <T>(_value: T): T => (() => undefined) as T
        const hostile = new Proxy({ then() {} }, { get() { return forward(thenCallback) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(mutable.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("specializes a literal callback selector inside a Proxy get trap", () => {
    const exact = analyzePromiseChains("proxy-selected-forwarded-then.ts", `
      function select<T>(enabled: boolean, yes: T, no: T): T { return enabled ? yes : no }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get() { return select(true, rejectThen, resolveThen) } })
        const friendly = new Proxy({ then() {} }, { get() { return select(false, rejectThen, resolveThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        new Promise<number>((resolve) => resolve(friendly)).catch(() => 0)
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });
    expect(exact.thenables.find((thenable) => thenable.binding === "friendly")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["fulfilled"], mayRemainPending: false,
    });

    const dynamic = analyzePromiseChains("proxy-dynamic-selected-forwarded-then.ts", `
      declare const enabled: boolean
      function select<T>(enabled: boolean, yes: T, no: T): T { return enabled ? yes : no }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get() { return select(enabled, rejectThen, resolveThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(dynamic.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("specializes a compound Proxy then-property guard", () => {
    const exact = analyzePromiseChains("proxy-compound-then-guard.ts", `
      function run() {
        const enabled = true as const
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, {
          get(_target, property) {
            if (property === "then" && enabled) return rejectThen
            return undefined
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const dynamic = analyzePromiseChains("proxy-dynamic-compound-then-guard.ts", `
      declare const enabled: boolean
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, {
          get(_target, property) {
            if (property === "then" && enabled) return rejectThen
            return undefined
          }
        })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(dynamic.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("specializes a finite switch callback selector inside a Proxy trap", () => {
    const exact = analyzePromiseChains("proxy-switch-selected-then.ts", `
      function select<T>(mode: "reject" | "resolve", rejectThen: T, resolveThen: T): T {
        switch (mode) {
          case "reject": return rejectThen
          default: return resolveThen
        }
      }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get() { return select("reject", rejectThen, resolveThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const dynamic = analyzePromiseChains("proxy-dynamic-switch-selected-then.ts", `
      declare const mode: "reject" | "resolve"
      function select<T>(mode: "reject" | "resolve", rejectThen: T, resolveThen: T): T {
        switch (mode) {
          case "reject": return rejectThen
          default: return resolveThen
        }
      }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get() { return select(mode, rejectThen, resolveThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(dynamic.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("specializes a literal early-return callback selector", () => {
    const exact = analyzePromiseChains("proxy-early-return-selected-then.ts", `
      function select<T>(enabled: boolean, rejectThen: T, resolveThen: T): T {
        if (enabled) return rejectThen
        return resolveThen
      }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get() { return select(true, rejectThen, resolveThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const dynamic = analyzePromiseChains("proxy-dynamic-early-return-selected-then.ts", `
      declare const enabled: boolean
      function select<T>(enabled: boolean, rejectThen: T, resolveThen: T): T {
        if (enabled) return rejectThen
        return resolveThen
      }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get() { return select(enabled, rejectThen, resolveThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(dynamic.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });
  });

  it("resolves a pure immutable local callback selector", () => {
    const exact = analyzePromiseChains("proxy-local-selected-then.ts", `
      function select<T>(enabled: boolean, rejectThen: T, resolveThen: T): T {
        const selected = enabled ? rejectThen : resolveThen
        return selected
      }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const resolveThen = (resolve: (value: number) => void) => resolve(1)
        const hostile = new Proxy({ then() {} }, { get() { return select(true, rejectThen, resolveThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(exact.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "callable", possibleSettlements: ["rejected"], mayRemainPending: false,
    });

    const effectful = analyzePromiseChains("proxy-effectful-local-selected-then.ts", `
      declare function choose<T>(value: T): T
      function select<T>(rejectThen: T): T {
        const selected = choose(rejectThen)
        return selected
      }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, { get() { return select(rejectThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(effectful.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
      provenance: "proxy", thenAccess: "dynamic", possibleSettlements: ["fulfilled", "rejected"], mayRemainPending: true,
    });

    const beforeDeclaration = analyzePromiseChains("proxy-before-local-selected-then.ts", `
      function select<T>(rejectThen: T): T {
        return selected
        const selected = rejectThen
      }
      function run() {
        const rejectThen = (_resolve: unknown, reject: (reason: Error) => void) => reject(new Error("proxy"))
        const hostile = new Proxy({ then() {} }, { get() { return select(rejectThen) } })
        const result = new Promise<number>((resolve) => resolve(hostile))
        return result.catch(() => 0)
      }
    `);
    expect(beforeDeclaration.thenables.find((thenable) => thenable.binding === "hostile")).toMatchObject({
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

  it("records builtin settled roots at module scope through immutable aliases", () => {
    const model = analyzePromiseChains("settled-roots.ts", `
      const fulfilled = Promise.resolve(1)
      const rejected = Promise.reject(new Error("no"))
      fulfilled.then(value => value + 1)
      rejected.catch(() => 0)
    `);
    expect(model.chains).toMatchObject([
      { owner: "<module>", source: "fulfilled", initialSettlement: "fulfilled" },
      { owner: "<module>", source: "rejected", initialSettlement: "rejected" },
    ]);
    const quint = generatePromiseChainsQuint("settled_roots", model);
    expect(quint).toContain("action settle_0_fulfilled");
    expect(quint).not.toContain("action settle_0_rejected");
    expect(quint).toContain("action settle_1_rejected");
    expect(quint).not.toContain("action settle_1_fulfilled");
  });

  it("tracks Promise construction and settlement through stable aliases only", () => {
    const model = analyzePromiseChains("promise-aliases.ts", `
      const P = Promise
      const resolveNow = P.resolve
      const { reject: rejectNow } = Promise
      const made = new P<number>((resolve) => resolve(1))
      const fulfilled = resolveNow(1)
      const rejected = rejectNow(new Error("no"))
      made.then(value => value)
      fulfilled.then(value => value)
      rejected.catch(() => 0)

      let MutablePromise = Promise
      let mutableResolve = Promise.resolve
      const mutableMade = new MutablePromise<number>((resolve) => resolve(1))
      const uncertain = mutableResolve(1)
      mutableMade.then(value => value)
      uncertain.then(value => value)
    `);
    expect(model.executors).toEqual([
      expect.objectContaining({ binding: "made", synchronous: true, throwBecomesRejection: true }),
    ]);
    expect(model.chains.find((chain) => chain.source === "fulfilled")?.initialSettlement).toBe("fulfilled");
    expect(model.chains.find((chain) => chain.source === "rejected")?.initialSettlement).toBe("rejected");
    expect(model.chains.find((chain) => chain.source === "uncertain")?.initialSettlement).toBeUndefined();
    expect(model.chains.find((chain) => chain.source === "mutableMade")?.executor).toBeUndefined();
  });

  it("recognizes stable aliases of Promise capability factories", () => {
    const model = analyzePromiseChains("promise-factory-aliases.ts", `
      const attempt = Promise.try
      const makeCapability = Promise.withResolvers
      function tried() { return attempt(() => 1).then(value => value) }
      function externallySettled() {
        const { promise, resolve } = makeCapability<number>()
        resolve(1)
        return promise.then(value => value)
      }
      let mutableAttempt = Promise.try
      let mutableCapability = Promise.withResolvers
      function uncertainTry() { return mutableAttempt(() => 1).then(value => value) }
      function uncertainCapability() {
        const { promise } = mutableCapability<number>()
        return promise.then(value => value)
      }
    `);
    expect(model.executors).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "tried", settlementSource: "promise-try" }),
      expect.objectContaining({ owner: "externallySettled", settlementSource: "external-resolvers" }),
    ]));
    expect(model.executors.filter(({ owner }) => owner === "uncertainTry" || owner === "uncertainCapability")).toEqual([]);
  });

  it("models Promise.withResolvers as externally settled first-wins capability", () => {
    const model = analyzePromiseChains("with-resolvers.ts", `
      const { promise: moduleTask, resolve: resolveModule } = Promise.withResolvers<number>()
      resolveModule(1)
      moduleTask.then(value => value)
      function choose(ok: boolean) {
        const { promise: task, resolve: complete, reject: fail } = Promise.withResolvers<number>()
        const done = complete
        if (ok) done(1)
        else fail(new Error("no"))
        return task.catch(() => 0)
      }
      function pending() {
        const { promise, resolve, reject } = Promise.withResolvers<number>()
        void resolve; void reject
        return promise
      }
      function resolveOnly(ok: boolean) {
        const { promise, resolve } = Promise.withResolvers<number>()
        if (ok) resolve(1)
        return promise
      }
      function retained(ok: boolean) {
        const capability = Promise.withResolvers<number>()
        const done = capability.resolve
        if (ok) done(1)
        else capability.reject(new Error("no"))
        return capability.promise.catch(() => 0)
      }
      function loop(values: number[]) {
        const { promise, resolve } = Promise.withResolvers<number>()
        for (const value of values) resolve(value)
        return promise
      }
      declare function schedule(callback: (value: number | PromiseLike<number>) => void): void
      function escapedResolver() {
        const { promise, resolve } = Promise.withResolvers<number>()
        schedule(resolve)
        return promise
      }
      function escapedCapability() {
        const capability = Promise.withResolvers<number>()
        return capability
      }
      function shadowed() {
        const Promise = { withResolvers() { return { promise: 1, resolve() {}, reject() {} } } }
        const { promise, resolve, reject } = Promise.withResolvers()
        resolve(); reject(); return promise
      }
    `);
    expect(model.executors).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "<module>", binding: "moduleTask", possibleSettlements: ["fulfilled"], mayRemainPending: false }),
      expect.objectContaining({
        owner: "choose", binding: "task", callback: "<external-resolvers>", synchronous: false,
        throwBecomesRejection: false, settlementSource: "external-resolvers",
        possibleSettlements: expect.arrayContaining(["fulfilled", "rejected"]), mayRemainPending: false,
      }),
      expect.objectContaining({ owner: "pending", binding: "promise", possibleSettlements: [], mayRemainPending: true }),
      expect.objectContaining({ owner: "resolveOnly", binding: "promise", possibleSettlements: ["fulfilled"], mayRemainPending: true }),
      expect.objectContaining({ owner: "retained", binding: "capability.promise",
        possibleSettlements: expect.arrayContaining(["fulfilled", "rejected"]), mayRemainPending: false }),
      expect.objectContaining({ owner: "loop", binding: "promise", possibleSettlements: ["fulfilled"], mayRemainPending: true }),
      expect.objectContaining({ owner: "escapedResolver", binding: "promise",
        possibleSettlements: expect.arrayContaining(["fulfilled", "assimilating"]), mayRemainPending: true }),
      expect.objectContaining({ owner: "escapedCapability", binding: "capability.promise",
        possibleSettlements: expect.arrayContaining(["fulfilled", "rejected", "assimilating"]), mayRemainPending: true }),
    ]));
    expect(model.executors.filter(({ owner }) => owner === "shadowed")).toEqual([]);
    expect(model.chains).toContainEqual(expect.objectContaining({ owner: "<module>", source: "moduleTask", executor: 0 }));
    expect(model.chains).toContainEqual(expect.objectContaining({ owner: "choose", source: "task", executor: 1 }));
    expect(model.chains).toContainEqual(expect.objectContaining({ owner: "retained", source: "capability.promise", executor: 4 }));
    const quint = generatePromiseChainsQuint("with_resolvers", model);
    expect(quint).toContain("settle_0_fulfilled");
    expect(quint).not.toContain("settle_0_rejected");
    expect(quint).toContain("settle_1_fulfilled");
    expect(quint).toContain("settle_1_rejected");
  });

  it("models Promise.try synchronous callback completion as Promise settlement", () => {
    const model = analyzePromiseChains("promise-try.ts", `
      function compute(value: number) {
        if (value < 0) throw new RangeError("negative")
        return value
      }
      function run(value: number) {
        const task = Promise.try(compute, value)
        return task.catch(() => 0)
      }
      function inline(flag: boolean) {
        return Promise.try(() => { if (flag) throw new Error("no"); return 1 }).then(value => value)
      }
      function unknown(callback: () => number) { return Promise.try(callback) }
      declare function risky(): number
      function callsUnknown() { return Promise.try(() => risky()) }
      function shadowed() {
        const Promise = { try(callback: () => number) { return callback() } }
        return Promise.try(() => 1)
      }
    `);
    expect(model.executors).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: "run", binding: "task", callback: "compute", synchronous: true,
        throwBecomesRejection: true, settlementSource: "promise-try",
        possibleSettlements: expect.arrayContaining(["fulfilled", "rejected"]), mayRemainPending: false }),
      expect.objectContaining({ owner: "inline", binding: expect.stringContaining("Promise.try"),
        possibleSettlements: expect.arrayContaining(["fulfilled", "rejected"]), mayRemainPending: false }),
      expect.objectContaining({ owner: "unknown", possibleSettlements: expect.arrayContaining(["fulfilled", "rejected", "assimilating"]), mayRemainPending: true }),
      expect.objectContaining({ owner: "callsUnknown", possibleSettlements: expect.arrayContaining(["fulfilled", "rejected"]), mayRemainPending: false }),
    ]));
    expect(model.chains).toContainEqual(expect.objectContaining({ owner: "run", source: "task", executor: 0 }));
    expect(model.chains).toContainEqual(expect.objectContaining({ owner: "inline", executor: 1 }));
    expect(model.executors.filter(({ owner }) => owner === "shadowed")).toEqual([]);
    expect(model.executors.find(({ owner }) => owner === "callsUnknown")).toEqual(expect.objectContaining({
      mayDivergeSynchronously: true,
      synchronousDivergenceReasons: ["opaque-call"],
    }));
    const quint = generatePromiseChainsQuint("promise_try", model);
    expect(quint).toContain("settle_0_fulfilled");
    expect(quint).toContain("settle_0_rejected");
  });

  it("routes Promise.try callback throws through catch and finally completion", () => {
    const model = analyzePromiseChains("promise-try-handlers.ts", `
      function caught() {
        return Promise.try(() => {
          try { throw new Error("no") }
          catch { return 1 }
        })
      }
      function finallyThrows() {
        return Promise.try(() => {
          try { return 1 }
          finally { throw new TypeError("override") }
        })
      }
      function finallyReturns() {
        return Promise.try(() => {
          try { throw new Error("hidden") }
          finally { return 1 }
        })
      }
      function maybeRethrows(flag: boolean) {
        return Promise.try(() => {
          try { throw new Error("no") }
          catch (error) { if (flag) throw error; return 1 }
        })
      }
    `);
    const settlements = (owner: string) => model.executors.find((entry) => entry.owner === owner)?.possibleSettlements;
    expect(settlements("caught")).toEqual(["fulfilled"]);
    expect(settlements("finallyThrows")).toEqual(["rejected"]);
    expect(settlements("finallyReturns")).toEqual(["fulfilled"]);
    expect(settlements("maybeRethrows")).toEqual(expect.arrayContaining(["fulfilled", "rejected"]));
    expect(model.executors.filter((entry) => ["caught", "finallyThrows", "finallyReturns", "maybeRethrows"].includes(entry.owner))
      .every((entry) => entry.mayRemainPending === false)).toBe(true);
  });

  it("models Promise.try switch fallthrough and consumes switch-owned break", () => {
    const model = analyzePromiseChains("promise-try-switch.ts", `
      function rejects(kind: "first" | "second") {
        return Promise.try(() => {
          switch (kind) {
            case "first": throw new TypeError("first")
            case "second": throw new RangeError("second")
          }
        })
      }
      function breaks(kind: "skip" | "value") {
        return Promise.try(() => {
          switch (kind) {
            case "skip": break
            case "value": return 1
          }
          return 2
        })
      }
      function fallsThrough(kind: "head" | "tail") {
        return Promise.try(() => {
          switch (kind) {
            case "head": console.log("head")
            case "tail": return 1
          }
        })
      }
      function nonExhaustive(kind: string) {
        return Promise.try(() => {
          switch (kind) { case "error": throw new Error("no") }
        })
      }
      function unsupportedLoop(values: number[]) {
        return Promise.try(() => {
          for (const value of values) if (value > 0) return value
          return 0
        })
      }
    `);
    const settlements = (owner: string) => model.executors.find((entry) => entry.owner === owner)?.possibleSettlements;
    expect(settlements("rejects")).toEqual(["rejected"]);
    expect(settlements("breaks")).toEqual(["fulfilled"]);
    expect(settlements("fallsThrough")).toEqual(expect.arrayContaining(["fulfilled", "rejected"]));
    expect(settlements("nonExhaustive")).toEqual(expect.arrayContaining(["fulfilled", "rejected"]));
    expect(model.executors.find((entry) => entry.owner === "unsupportedLoop")).toEqual(expect.objectContaining({
      possibleSettlements: expect.arrayContaining(["fulfilled", "rejected", "assimilating"]),
      mayRemainPending: true,
      mayDivergeSynchronously: true,
    }));
    const quint = generatePromiseChainsQuint("promise_try_switch", model);
    expect(quint).toContain("var synchronously_blocked: bool");
    expect(quint).toContain("action diverge_4_synchronously");
    expect(quint).toContain("not(synchronously_blocked)");
    expect(quint).toContain("val promiseSynchronouslyProgressed = not(synchronously_blocked)");
  });

  it("distinguishes a returned pending Promise from synchronous executor divergence", () => {
    const model = analyzePromiseChains("executor-divergence.ts", `
      declare const flag: boolean
      function pending() {
        const task = new Promise<number>(() => {})
        return task.then(value => value)
      }
      function diverging() {
        const task = new Promise<number>((resolve) => {
          while (flag) {}
          resolve(1)
        })
        return task.then(value => value)
      }
      function opaque(executor: (resolve: (value: number) => void) => void) {
        const task = new Promise<number>(executor)
        return task.then(value => value)
      }
    `);
    expect(model.executors.find((entry) => entry.owner === "pending")).toEqual(expect.objectContaining({
      mayRemainPending: true, mayDivergeSynchronously: false,
    }));
    expect(model.executors.find((entry) => entry.owner === "diverging")).toEqual(expect.objectContaining({
      mayDivergeSynchronously: true,
    }));
    expect(model.executors.find((entry) => entry.owner === "opaque")).toEqual(expect.objectContaining({
      mayRemainPending: true, mayDivergeSynchronously: true,
    }));
  });

  it("detects TypeChecker-resolved recursive synchronous Promise callbacks", () => {
    const model = analyzePromiseChains("recursive-callbacks.ts", `
      function direct(): number { return direct() }
      function left(): number { return right() }
      function right(): number { return left() }
      function finite(value: number): number { return value + 1 }
      function promiseTryDirect() { return Promise.try(direct).then(value => value) }
      function promiseTryMutual() { return Promise.try(left).then(value => value) }
      function promiseTryFinite() { return Promise.try(finite, 1).then(value => value) }
      function constructorRecursive() {
        return new Promise<number>(() => { direct() }).then(value => value)
      }
      function constructorFinite() {
        return new Promise<number>((resolve) => { resolve(finite(1)) }).then(value => value)
      }
      const finiteAlias = finite
      const directAlias = direct
      const callbacks = { finite, direct }
      function aliasedFinite() { return Promise.try(finiteAlias, 1).then(value => value) }
      function aliasedRecursive() { return Promise.try(directAlias).then(value => value) }
      function propertyFinite() { return Promise.try(callbacks.finite, 1).then(value => value) }
      function propertyRecursive() { return Promise.try(callbacks.direct).then(value => value) }
      let mutable = finite
      mutable = direct
      const mutableCallbacks = { finite }
      mutableCallbacks.finite = direct
      function mutableAlias() { return Promise.try(mutable, 1).then(value => value) }
      function mutableProperty() { return Promise.try(mutableCallbacks.finite, 1).then(value => value) }
    `);
    const divergence = (owner: string) => model.executors.find((entry) => entry.owner === owner)?.mayDivergeSynchronously;
    expect(divergence("promiseTryDirect")).toBe(true);
    expect(divergence("promiseTryMutual")).toBe(true);
    expect(divergence("constructorRecursive")).toBe(true);
    expect(divergence("promiseTryFinite")).toBe(false);
    expect(divergence("constructorFinite")).toBe(false);
    expect(divergence("aliasedFinite")).toBe(false);
    expect(divergence("aliasedRecursive")).toBe(true);
    expect(divergence("propertyFinite")).toBe(false);
    expect(divergence("propertyRecursive")).toBe(true);
    expect(divergence("mutableAlias")).toBe(true);
    expect(divergence("mutableProperty")).toBe(true);
    expect(model.executors.find((entry) => entry.owner === "promiseTryDirect")?.synchronousDivergenceReasons).toContain("recursion");
    expect(model.executors.find((entry) => entry.owner === "constructorFinite")?.synchronousDivergenceReasons).toEqual([]);
    expect(model.executors.find((entry) => entry.owner === "mutableAlias")?.synchronousDivergenceReasons).toContain("opaque-callback");
  });

  it("discharges opaque-call divergence only with a symbol-attached termination contract", () => {
    const model = analyzePromiseChains("termination-contract.ts", `
      /* uneffect:temporal_contract terminates true */
      declare function bounded(value: number): number
      declare function opaque(value: number): number
      /* uneffect:temporal_contract terminates false */
      declare function explicitlyUntrusted(value: number): number
      function trusted() { return Promise.try(() => bounded(1)).then(value => value) }
      function untrusted() { return Promise.try(() => opaque(1)).then(value => value) }
      function falseContract() { return Promise.try(() => explicitlyUntrusted(1)).then(value => value) }
      function shadowed() {
        const bounded = (value: number) => opaque(value)
        return Promise.try(() => bounded(1)).then(value => value)
      }
    `);
    expect(model.executors.find((entry) => entry.owner === "trusted")).toEqual(expect.objectContaining({
      mayDivergeSynchronously: false,
      synchronousDivergenceReasons: [],
    }));
    for (const owner of ["untrusted", "falseContract", "shadowed"]) {
      expect(model.executors.find((entry) => entry.owner === owner)?.synchronousDivergenceReasons)
        .toContain("opaque-call");
    }
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

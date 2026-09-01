import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAsyncSafety, generateTemporalModel, verifyUneffectProject } from "../src/index.js";
import { createResourceDisposalTemporalProduct, lowerResourceDisposalsToProtocol } from "../src/index.js";
import * as stable from "../src/index.js";
import * as experimental from "../src/experimental.js";

const source = `
/* uneffect:temporal state sends: int */
/* uneffect:temporal init sends = 0 */
/* uneffect:temporal invariant atMostOnce: sends <= 1 */

/* uneffect:temporal-summary requires sends === 0 */
/* uneffect:temporal-summary ensures sends' = sends + 1 */
/* uneffect:temporal-summary modifies sends */
function send(): void {}

export function main(): void {
  queueMicrotask(send)
}
`;

describe("unified async temporal model", () => {
  it("keeps standalone async projections out of the stable root API", () => {
    expect(stable).not.toHaveProperty("generateUnifiedAsyncQuint");
    expect(stable).not.toHaveProperty("generateAsyncPatternsQuint");
    expect(stable).not.toHaveProperty("generatePromiseChainsQuint");
    expect(experimental.generateUnifiedAsyncQuint).toBeTypeOf("function");
    expect(experimental.generateAsyncPatternsQuint).toBeTypeOf("function");
    expect(experimental.generatePromiseChainsQuint).toBeTypeOf("function");
  });

  it.each(["web", "node"] as const)("projects %s async observations and user temporal state through one public entry", (runtime) => {
    const result = generateTemporalModel({
      fileName: `unified-${runtime}.ts`,
      source,
      runtime,
      root: "main",
    });

    expect(result).toMatchObject({
      schema: "uneffect-temporal-model/v1",
      sourceLanguage: "uneffect-ts",
      backend: "quint",
      runtime,
      includedDomains: ["user-temporal", "async-patterns", "promise-chains"],
      exclusions: ["async-ownership", "resource-lifecycle"],
    });
    expect(result.quint).toContain("var sends: int");
    expect(result.quint).toContain("val atMostOnce = sends <= 1");
    expect(result.quint).toMatch(/action drain_microtask_0/);
    expect(result.quint.slice(result.quint.indexOf("action drain_microtask_0")))
      .toContain("sends' = sends + 1");
  });

  it("checks a Node user property in the same project temporal result", async () => {
    const result = await verifyUneffectProject({
      files: { "src/unified-node.ts": source },
      temporalRuntime: "node",
      temporalRoot: "main",
    });

    expect(result.temporal?.properties).toContainEqual(expect.objectContaining({
      name: "atMostOnce",
      result: "verified",
    }));
  }, 30_000);

  it("keeps the Node host clock distinct from a user state named clock", () => {
    const clockSource = `
      /* uneffect:temporal state clock: int */
      /* uneffect:temporal init clock = 7 */
      /* uneffect:temporal invariant userClock: clock === 7 */
      function parent() { setImmediate(() => undefined) }
      export function main() { queueMicrotask(parent) }
    `;
    const result = generateTemporalModel({ fileName: "node-clock.ts", source: clockSource, runtime: "node" });
    expect(result.quint).toContain("var node_clock: int");
    expect(result.quint).toContain("var clock: int");
    expect(result.quint).toContain("callback_1_due' = node_clock + 1");
    expect(result.quint).not.toContain("callback_1_due' = clock + 1");
  });

  it("lowers root Promise rejection ownership through the unified temporal facade", () => {
    const promiseSource = `
      declare function task(): Promise<number>
      export async function main(): Promise<void> {
        const pending = task()
        await pending
      }
    `;
    const result = generateTemporalModel({
      fileName: "promise-owner.ts",
      source: promiseSource,
      runtime: "web",
      root: "main",
    });

    expect(result.includedDomains).toContain("async-ownership");
    expect(result.exclusions).not.toContain("async-ownership");
    expect(result.models).toContainEqual(expect.objectContaining({
      kind: "promise-ownership",
      owner: "main",
      properties: ["promiseOwnershipSafe"],
    }));
    expect(result.quint).toContain("val promiseOwnershipSafe");
  });

  it("retains a floating root Promise as an ownership counterexample", () => {
    const promiseSource = `
      declare function task(): Promise<number>
      export async function main(): Promise<void> {
        const pending = task()
      }
    `;
    const result = generateTemporalModel({
      fileName: "floating-owner.ts",
      source: promiseSource,
      runtime: "node",
      root: "main",
    });

    const ownership = result.models.find((model) => model.kind === "promise-ownership");
    expect(ownership?.quint).toContain("resource_0' = 1");
    expect(ownership?.quint).toContain("val promiseOwnershipSafe");
  });

  it("checks Promise ownership with the project temporal verifier", async () => {
    const result = await verifyUneffectProject({
      files: {
        "src/promise-owner.ts": `
          declare function task(): Promise<number>
          export async function main(): Promise<void> {
            const pending = task()
            await pending
          }
        `,
      },
      temporalRuntime: "web",
      temporalRoot: "main",
    });
    expect(result.temporal?.properties).toContainEqual(expect.objectContaining({
      name: "main.promiseOwnershipSafe",
      result: "verified",
    }));
  }, 30_000);

  it("links a directly constructed Promise ownership resource to its exact host settlement identity", () => {
    const result = generateTemporalModel({
      fileName: "direct-promise.ts",
      source: `
        export async function main(): Promise<void> {
          const renamed = new Promise<number>((resolve) => resolve(1))
          await renamed
        }
      `,
      runtime: "web",
      root: "main",
    });

    expect(result.exclusions).not.toContain("promise-host-synchronization");
    expect(result.synchronizations).toContainEqual(expect.objectContaining({
      kind: "promise-ownership-host",
      relation: "same-promise",
      evidence: "exact",
    }));
    expect(result.synchronizations[0]?.hostTransitionId).toContain(":main:settle:");
  });

  it("normalizes a supported immutable Promise alias to one ownership and host identity", () => {
    const result = generateTemporalModel({
      fileName: "aliased-direct-promise.ts",
      source: `
        export async function main(): Promise<void> {
          const original = new Promise<number>((resolve) => resolve(1))
          const renamed = original
          await renamed
        }
      `,
      runtime: "node",
      root: "main",
    });
    const ownership = result.models.find((model) => model.kind === "promise-ownership");
    expect(ownership?.quint).toContain("var resource_0: int");
    expect(ownership?.quint).not.toContain("var resource_1: int");
    expect(result.synchronizations).toHaveLength(1);
    expect(result.exclusions).not.toContain("promise-host-synchronization");
  });

  it("reports external Promise settlement as an unsupported synchronization", () => {
    const result = generateTemporalModel({
      fileName: "external-promise.ts",
      source: `
        declare function task(): Promise<number>
        export async function main(): Promise<void> {
          const renamed = task()
          await renamed
        }
      `,
      runtime: "node",
      root: "main",
    });
    expect(result.includedDomains).toContain("async-ownership");
    expect(result.exclusions).toContain("promise-host-synchronization");
    expect(result.synchronizations).toEqual([]);
  });

  it("reports a floating Promise as a project temporal counterexample", async () => {
    const result = await verifyUneffectProject({
      files: {
        "src/floating-owner.ts": `
          declare function task(): Promise<number>
          export async function main(): Promise<void> {
            const pending = task()
          }
        `,
      },
      temporalRuntime: "node",
      temporalRoot: "main",
    });
    expect(result.temporal?.properties).toContainEqual(expect.objectContaining({
      name: "main.promiseOwnershipSafe",
      result: "counterexample",
    }));
  }, 30_000);

  it("co-verifies using disposal through the temporal facade and keeps host scheduling as an explicit gap", () => {
    const usingSource = `
      class Resource {
        [Symbol.dispose](): void {}
      }
      export function main(): void {
        using outer = new Resource()
        using inner = new Resource()
      }
    `;
    const result = generateTemporalModel({ fileName: "using.ts", source: usingSource, runtime: "node", root: "main" });

    expect(result.includedDomains).toContain("resource-lifecycle");
    expect(result.exclusions).not.toContain("resource-lifecycle");
    expect(result.exclusions).not.toContain("resource-host-scheduling");
    expect(result.models).toContainEqual(expect.objectContaining({
      kind: "resource-lifecycle",
      owner: "main",
      properties: ["resourceSafe"],
    }));
    expect(result.quint).toContain("module using_resource_main");
    expect(result.quint.indexOf("action dispose_1")).toBeLessThan(result.quint.indexOf("action dispose_0"));
  });

  it("checks using resourceSafe as part of project temporal verification", async () => {
    const usingSource = `
      class Resource {
        async [Symbol.asyncDispose](): Promise<void> {}
      }
      export async function main(): Promise<void> {
        await using resource = new Resource()
      }
    `;
    const result = await verifyUneffectProject({
      files: { "src/using.ts": usingSource },
      temporalRuntime: "web",
      temporalRoot: "main",
    });

    expect(result.temporal?.models).toContainEqual(expect.objectContaining({ kind: "resource-lifecycle" }));
    expect(result.temporal?.models).toContainEqual(expect.objectContaining({ kind: "resource-host-lifecycle" }));
    const temporalFacade = generateTemporalModel({ fileName: "src/using.ts", source: usingSource, runtime: "web", root: "main" });
    expect(temporalFacade.exclusions).not.toContain("resource-host-scheduling");
    expect(temporalFacade.exclusions).toContain("resource-host-callback-interleavings");
    expect(temporalFacade.scheduling).toEqual({
      fairness: "none",
      resourceCallbackInterleavings: "excluded",
    });
    expect(result.temporal?.properties).toContainEqual(expect.objectContaining({
      name: "main.resourceSafe",
      result: "verified",
    }));
    expect(result.temporal?.properties).toContainEqual(expect.objectContaining({
      name: "main.resourceHostSafe",
      result: "verified",
    }));
  }, 30_000);

  it("finds a counterexample when await disposal resumes outside the microtask checkpoint", () => {
    const usingSource = `
      class Resource { async [Symbol.asyncDispose](): Promise<void> {} }
      export async function main(): Promise<void> {
        await using resource = new Resource()
      }
    `;
    const analysis = analyzeAsyncSafety("broken-using.ts", usingSource);
    const directory = mkdtempSync(join(tmpdir(), "uneffect-resource-host-"));
    const path = join(directory, "model.qnt");
    try {
      const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
      const product = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
      if (product.status !== "ready") throw new Error(product.reasons.join("; "));
      const commonPositiveQuint = experimental.generateResourceTemporalProductQuint("common_resource_host", product.product);
      writeFileSync(path, commonPositiveQuint);
      const commonPositive = spawnSync("pnpm", ["exec", "quint", "run", path, "--main=common_resource_host", "--invariant=resourceTemporalSafe", "--max-steps=8", "--max-samples=100", "--seed=0x756e6566"], { encoding: "utf8" });
      expect(commonPositive.status, `${commonPositive.stdout}${commonPositive.stderr}`).toBe(0);
      const commonQuint = experimental.generateResourceTemporalProductQuint("broken_common_resource_host", product.product, {
        resumeOutsideMicrotask: true,
      });
      writeFileSync(path, commonQuint);
      const common = spawnSync("pnpm", ["exec", "quint", "run", path, "--main=broken_common_resource_host", "--invariant=resourceTemporalSafe", "--max-steps=8", "--max-samples=100", "--seed=0x756e6566"], { encoding: "utf8" });
      expect(common.status).not.toBe(0);
      expect(`${common.stdout}${common.stderr}`).toMatch(/violation|counterexample/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("includes bounded conditional await-using acquisition in the resource/host product", () => {
    const conditionalSource = `
      interface Resource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): Resource
      export async function main(enabled: boolean): Promise<void> {
        if (enabled) { await using resource = open() }
      }
    `;
    const result = generateTemporalModel({
      fileName: "conditional-using.ts", source: conditionalSource, runtime: "web", root: "main",
    });
    expect(result.models).toContainEqual(expect.objectContaining({ kind: "resource-host-lifecycle", owner: "main" }));
    expect(result.exclusions).not.toContain("resource-host-scheduling");
    expect(result.quint).toContain("skip_acquire_0");
  });

  it("keeps repeated loop acquisition as explicit resource-host scheduling exclusion", () => {
    const result = generateTemporalModel({
      fileName: "loop-using.ts",
      source: `
        interface Resource { [Symbol.asyncDispose](): Promise<void> }
        declare function open(): Resource
        export async function main(values: boolean[]): Promise<void> {
          for (const value of values) { await using resource = open(); void value }
        }
      `,
      runtime: "node",
      root: "main",
    });
    expect(result.models).not.toContainEqual(expect.objectContaining({ kind: "resource-host-lifecycle" }));
    expect(result.exclusions).toContain("resource-host-scheduling");
  });

  it("includes supported AbortController fetch cancellation in the unified temporal result", () => {
    const result = generateTemporalModel({
      fileName: "abortable-fetch.ts",
      source: `
        export async function main(cancel: boolean): Promise<void> {
          const controller = new AbortController()
          const request = fetch("https://api.example.com/data", { signal: controller.signal })
          if (cancel) controller.abort("stop")
          await request
        }
      `,
      runtime: "web",
      root: "main",
    });
    expect(result.includedDomains).toContain("abortable-fetch");
    expect(result.exclusions).not.toContain("abortable-fetch-synchronization");
    expect(result.models).toContainEqual(expect.objectContaining({
      kind: "abortable-fetch", owner: "main",
      properties: ["abortableFetchSafe", "abortableFetchObserved", "abortableFetchBodiesConsumed"],
    }));
    expect(result.quint).toContain("action abort_0");
  });

  it("reports an unresolved fetch cancellation boundary instead of guessing a link", () => {
    const result = generateTemporalModel({
      fileName: "unknown-fetch.ts",
      source: `
        declare const externalSignal: AbortSignal
        export async function main(): Promise<void> {
          const request = fetch("https://api.example.com/data", { signal: externalSignal })
          await request
        }
      `,
      runtime: "node",
      root: "main",
    });
    expect(result.exclusions).toContain("abortable-fetch-synchronization");
    expect(result.models).not.toContainEqual(expect.objectContaining({ kind: "abortable-fetch" }));
  });
});

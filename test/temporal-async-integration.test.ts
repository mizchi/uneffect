import { describe, expect, it } from "vitest";
import { generateTemporalModel, verifyUneffectProject } from "../src/index.js";
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
    expect(result.exclusions).toContain("resource-host-scheduling");
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
    expect(result.temporal?.properties).toContainEqual(expect.objectContaining({
      name: "main.resourceSafe",
      result: "verified",
    }));
  }, 30_000);
});

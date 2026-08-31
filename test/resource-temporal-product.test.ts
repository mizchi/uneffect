import { describe, expect, it } from "vitest";
import { analyzeAsyncSafety } from "../src/async-safety.js";
import { lowerResourceDisposalsToProtocol } from "../src/resource-disposal-protocol.js";
import { createResourceDisposalTemporalProduct, evaluateResourceTemporalProduct } from "../src/resource-temporal-product.js";

describe("resource temporal product IR", () => {
  it("links sync and awaited disposal to their neutral completion lanes", () => {
    const analysis = analyzeAsyncSafety("using-product.ts", `
      interface SyncResource { [Symbol.dispose](): void }
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function openSync(): SyncResource
      declare function openAsync(): AsyncResource
      async function main() {
        using sync = openSync()
        await using asyncResource = openAsync()
      }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    expect(created.product.links.map(({ relation }) => relation)).toEqual(["await-completion", "inline"]);
    expect(evaluateResourceTemporalProduct(created.product)).toMatchObject({
      status: "satisfied", evidence: "exact-under-precondition",
      preconditions: ["all-listed-resources-acquired"], reasons: [],
    });
  });

  it("fails closed for lane mismatch, dangling, duplicate, and unlinked releases", () => {
    const analysis = analyzeAsyncSafety("using-product-invalid.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main() { await using resource = open() }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    if (created.status !== "ready") throw new Error(created.reasons.join("; "));
    const link = created.product.links[0]!;
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [{ ...link, relation: "inline" }] }).reasons)
      .toContainEqual(expect.stringContaining("targets microtask"));
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [{ ...link, hostTransitionId: "missing" }] }).reasons)
      .toContainEqual(expect.stringContaining("dangling host"));
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [link, link] }).reasons)
      .toContainEqual(expect.stringContaining("duplicate"));
    expect(evaluateResourceTemporalProduct({ ...created.product, links: [] }).reasons)
      .toContainEqual(expect.stringContaining("no host completion link"));
    expect(evaluateResourceTemporalProduct({
      ...created.product,
      host: created.product.host.map((transition) => transition.kind === "dispose-resource" ? { ...transition, resource: "other" } : transition),
    }).reasons).toContainEqual(expect.stringContaining("resource identity mismatch"));
  });
});

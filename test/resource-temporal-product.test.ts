import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAsyncSafety } from "../src/async-safety.js";
import { lowerResourceDisposalsToProtocol } from "../src/resource-disposal-protocol.js";
import { createResourceDisposalTemporalProduct, evaluateResourceTemporalProduct } from "../src/resource-temporal-product.js";
import { generateResourceTemporalProductQuint } from "../src/resource-temporal-product.js";

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
    const quint = generateResourceTemporalProductQuint("resource_product", created.product);
    expect(quint).toContain("action release_start_2");
    expect(quint).toContain("action release_resume_2");
    expect(quint).toContain("action release_inline_3");
    expect(quint).toContain("val resourceTemporalSafe");
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

  it("models bounded conditional acquisition as acquire-or-skip before host-linked disposal", () => {
    const analysis = analyzeAsyncSafety("conditional-using-product.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main(enabled: boolean) {
        if (enabled) { await using resource = open() }
      }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    expect(created.status).toBe("ready");
    if (created.status !== "ready") return;
    expect(created.product.optionalResources).toHaveLength(1);
    expect(evaluateResourceTemporalProduct(created.product)).toMatchObject({
      status: "satisfied", evidence: "exact", preconditions: [], reasons: [],
    });
    const quint = generateResourceTemporalProductQuint("conditional_resource_product", created.product);
    expect(quint).toContain("action skip_acquire_0");
    expect(quint).toContain("action skip_release_1");
  });

  it("keeps repeated loop acquisition outside the bounded optional-resource product", () => {
    const analysis = analyzeAsyncSafety("loop-using-product.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main(values: boolean[]) {
        for (const value of values) { await using resource = open(); void value }
      }
    `);
    expect(lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main"))
      .toEqual({ status: "unknown", owner: "main", reasons: ["repeated-acquisition"] });
  });

  it("keeps disposal rejection and suppression in the common host product", () => {
    const analysis = analyzeAsyncSafety("failing-disposal-product.ts", `
      interface AsyncResource { [Symbol.asyncDispose](): Promise<void> }
      declare function open(): AsyncResource
      async function main() {
        await using first = open()
        await using second = open()
      }
    `);
    const lifecycle = lowerResourceDisposalsToProtocol(analysis.resources, analysis.disposals, "main");
    const created = createResourceDisposalTemporalProduct(analysis.fileName, lifecycle, analysis.disposals);
    if (created.status !== "ready") throw new Error(created.reasons.join("; "));
    const quint = generateResourceTemporalProductQuint("failing_disposal_product", created.product);
    expect(quint).toContain("action release_reject_2");
    expect(quint).toContain("action release_reject_3");
    expect(quint).toContain("suppressed_failure");
    expect(quint).toContain("val disposalSuppressionSafe");

    const directory = mkdtempSync(join(tmpdir(), "uneffect-disposal-suppression-"));
    try {
      const path = join(directory, "broken.qnt");
      writeFileSync(path, generateResourceTemporalProductQuint("broken_disposal_product", created.product, { dropSuppression: true }));
      const broken = spawnSync("pnpm", ["exec", "quint", "run", path, "--main=broken_disposal_product", "--invariant=resourceTemporalSafe", "--max-steps=12", "--max-samples=500", "--seed=0x756e6566"], { encoding: "utf8" });
      expect(broken.status).not.toBe(0);
      expect(`${broken.stdout}${broken.stderr}`).toMatch(/violation|counterexample/iu);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
